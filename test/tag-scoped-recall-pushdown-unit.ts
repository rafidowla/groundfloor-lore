#!/usr/bin/env tsx
/**
 * test/tag-scoped-recall-pushdown-unit.ts — 3.38.2 regression: tag-scoped
 * recall dropped matching nodes once untagged matches outnumbered the seed
 * window (Nokshi report on 3.38.1).
 *
 * Root cause: `tags` was applied AFTER the seed-widening loop in
 * recall/retrieve.ts, so a narrow tag never triggered widening and the
 * vector/BM25/keyword legs never saw the tag — a node outside the first
 * `candLimit × SEED_HIDDEN_HEADROOM` window was silently lost.
 *
 * PART 1 — filter-entry rendering (pure): `tagsAll` → one exact,
 *   comma-delimited membership entry per tag; sqlite/pg render instr/strpos,
 *   never LIKE; JS row filter agrees with SQL.
 * PART 2 — graph.search(…, tags) on SqliteGraph: ALL-of, exact
 *   (`client:c-0` never matches `client:c-008`), malformed tags never throw.
 * PART 3 — public surface (createLore + bulkIngest + lore.recall): 1 tagged
 *   node (oldest, last by id) + 1000 untagged matches; tag-scoped recall at
 *   max 10/30/100 must return it in keyword, semantic and hybrid mode, on
 *   sqlite/sqlite and (when LORE_PG_URL is set) postgres/postgres.
 *   Pre-fix: 0 hits in every mode.
 *
 * Run: LORE_MODEL_SERVER=0 [LORE_PG_URL=...] npx tsx test/tag-scoped-recall-pushdown-unit.ts
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import pg from 'pg';

import { createLore } from '../packages/lore/src/index.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { buildSqlFilterEntries, renderSqlFilterEntry, TAGS_ALL_FILTER_KEY } from '../packages/lore/src/engines/verbatimHistory.js';
import { toRowFilter, matchesRowFilter } from '../packages/lore/src/engines/sqliteVerbatimVector.js';
import { tagsAllValues } from '../packages/lore/src/engines/tagsAllFilter.js';
import { searchWhere } from '../packages/lore/src/engines/postgres/postgresGraphReads.js';
import { matchesArcadeRowFilter } from '../packages/lore/src/engines/arcade/arcadeRowFilter.js';
import { PgParams } from '../packages/lore/src/engines/postgres/postgresGraphRow.js';
import { stampGateManifest } from './helpers/testPostgres.js';

process.env['LORE_MODEL_SERVER'] = '0';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
    catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ── PART 1 — filter entries ── */

async function part1(): Promise<void> {
    console.log('part 1 — tagsAll filter entries');
    await test('tagsAllValues: strings only, non-empty, no commas, deduped', () => {
        assert.deepEqual(tagsAllValues(['a', 'a', '', 'b,c', 3, 'd']), ['a', 'd']);
        assert.deepEqual(tagsAllValues('a'), []);
        assert.deepEqual(tagsAllValues(undefined), []);
    });
    await test('buildSqlFilterEntries: one delimited entry per tag, param wrapped in commas', () => {
        const es = buildSqlFilterEntries({ [TAGS_ALL_FILTER_KEY]: ['client:c-0', 'kind:x'] } as never);
        assert.equal(es.length, 2);
        assert.deepEqual(es.map((e) => [e.column, e.match, e.params]), [['tags', 'delimited', [',client:c-0,']], ['tags', 'delimited', [',kind:x,']]]);
    });
    await test('renderSqlFilterEntry: instr (sqlite) / strpos (pg), never LIKE', () => {
        const [e] = buildSqlFilterEntries({ [TAGS_ALL_FILTER_KEY]: ['t'] } as never);
        assert.ok(e);
        const s = renderSqlFilterEntry(e, 'v.tags', 'sqlite');
        const p = renderSqlFilterEntry(e, 'tags', 'pg', ['$7']);
        assert.equal(s, "instr(',' || v.tags || ',', ?) > 0");
        assert.equal(p, "strpos(',' || tags || ',', $7) > 0");
        assert.doesNotMatch(s + p, /LIKE/i);
    });
    await test('JS row filter: exact membership, ALL-of', () => {
        const rf = toRowFilter(buildSqlFilterEntries({ [TAGS_ALL_FILTER_KEY]: ['client:c-0', 'kind:x'] } as never));
        assert.equal(matchesRowFilter({ tags: 'kind:x,client:c-0' } as never, rf), true);
        assert.equal(matchesRowFilter({ tags: 'kind:x,client:c-008' } as never, rf), false, 'prefix is not membership');
        assert.equal(matchesRowFilter({ tags: 'client:c-0' } as never, rf), false, 'ALL-of');
        assert.equal(matchesRowFilter({ tags: '' } as never, rf), false);
    });
    await test('arcade client-side filter: tagsAll is membership, not equality (pre-fix it dropped every row)', () => {
        const row = { tags: 'kind:x,client:c-0', project: 'p' };
        assert.equal(matchesArcadeRowFilter(row, { tagsAll: ['client:c-0'] }), true);
        assert.equal(matchesArcadeRowFilter(row, { tagsAll: ['client:c-0', 'kind:x'], project: 'p' }), true);
        assert.equal(matchesArcadeRowFilter(row, { tagsAll: ['client:c-00'] }), false, 'exact');
        assert.equal(matchesArcadeRowFilter(row, { tagsAll: ['client:c-0'], project: 'q' }), false, 'other keys still equality');
        assert.equal(matchesArcadeRowFilter(row, { security_scopes: 'x', contentHash: 'y' }), true, 'non-axis keys skipped');
    });
    await test('postgres searchWhere: one exact tagEquals per tag, ANDed (ALL-of, never ANY)', () => {
        const params = new PgParams(); params.add('ws');
        const where = searchWhere(params, 'q', { tags: ['client:c-0', 'kind:x'] });
        // The keyword match clause has its own OR'd tag-containment term; count only the ANDed scope predicates.
        const hits = where.match(/ AND EXISTS \(SELECT 1 FROM jsonb_array_elements_text\(nodes\.tags::jsonb\) je WHERE je = \$\d+\)/g) ?? [];
        assert.equal(hits.length, 2, where);
        assert.doesNotMatch(where, /je = ANY/);
        assert.ok(params.values.includes('client:c-0') && params.values.includes('kind:x'));
        const none = new PgParams(); none.add('ws');
        assert.doesNotMatch(searchWhere(none, 'q', {}), / AND EXISTS \(SELECT 1 FROM jsonb_array_elements_text/, 'no tags -> no tag predicate');
    });
}

/* ── PART 2 — SqliteGraph.search tags pushdown ── */

async function part2(): Promise<void> {
    console.log('part 2 — SqliteGraph.search(…, tags)');
    const dir = tmp('tagpush-graph-');
    const g = new SqliteGraph(dir, { workspaceId: 'tagpush', cacheDisabled: true });
    await g.initialize();
    try {
        const TOK = 'zztagpushgraph';
        const rows: Array<[string, string[]]> = [
            ['n-c0', ['client:c-0', 'kind:x']],
            ['n-c008', ['client:c-008', 'kind:x']],
            ['n-c0-only', ['client:c-0']],
            ['n-none', []],
        ];
        for (const [id, tags] of rows) {
            await g.upsertNode({ id, type: 'knowledge', label: id, content: `${id} ${TOK}`, tags, project: '*', ecosystem: '*', metadata: '{}' } as never);
        }
        const ids = async (tags?: string[]): Promise<string[]> =>
            (await g.search(TOK, 100, '*', '*', false, undefined, undefined, undefined, undefined, tags)).map((n) => n.id).sort();
        await test('no tags: every row', async () => assert.deepEqual(await ids(), ['n-c0', 'n-c0-only', 'n-c008', 'n-none']));
        await test('exact membership: client:c-0 never matches client:c-008', async () => assert.deepEqual(await ids(['client:c-0']), ['n-c0', 'n-c0-only']));
        await test('ALL-of: two tags', async () => assert.deepEqual(await ids(['client:c-0', 'kind:x']), ['n-c0']));
        await test('unknown tag: nothing', async () => assert.deepEqual(await ids(['nope']), []));
    } finally {
        await g.close?.();
    }
}

/* ── PART 3 — public surface ── */

const DIM = 4;
// Constant vector: every row ties on similarity, so vector order alone can
// never rescue the tagged node — only the tag pushdown can.
const fixedEmbedder = {
    dimension: DIM, modelId: 'tagpush/fixed-4', dtype: 'fp32', maxBatchSize: 64,
    async initialize() { /* no-op */ },
    async embed() { return [1, 0, 0, 0]; }, async embedQuery() { return [1, 0, 0, 0]; },
    async embedDocument() { return [1, 0, 0, 0]; }, async embedDocumentBatch(ts: string[]) { return ts.map(() => [1, 0, 0, 0]); },
};

const UNTAGGED = 1000;

async function part3(label: string, setup: () => Promise<{ dataDir: string; ws: string; cleanup: () => Promise<void> }>): Promise<void> {
    console.log(`part 3 — [${label}] tagged node among ${UNTAGGED} untagged matches`);
    const { dataDir, ws, cleanup } = await setup();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: fixedEmbedder as never, modelServer: false } as never) as any;
    try {
        const T = 'zztagpushtok';
        const node = (id: string, tags: string[]) => ({
            id, workspace: ws, ecosystem: '*',
            nodeData: { id, type: 'knowledge', label: `${id} ${T}`, content: `${id} content mentions ${T}`, tags, project: ws, ecosystem: '*' },
        });
        // Target first (oldest updatedAt) and last by id: the keyword leg's
        // `updatedAt DESC, id ASC` order and the tied vector order both put it last.
        await lore.bulkIngest([node('zz-target', ['client:c-0', 'kind:x'])], { autolink: false, embed: 'sync' });
        await new Promise((r) => setTimeout(r, 20));
        const filler = Array.from({ length: UNTAGGED }, (_, i) => node(`n-${String(i).padStart(4, '0')}`, i % 2 ? ['client:c-008'] : []));
        for (let i = 0; i < filler.length; i += 250) await lore.bulkIngest(filler.slice(i, i + 250), { autolink: false, embed: 'sync' });
        await lore.awaitEmbeds?.();

        const recall = async (args: Record<string, unknown>): Promise<string[]> => {
            const res = await lore.recall(T, { workspace: ws, ecosystem: '*', mode: 'summary', depth: 0, ...args });
            return (res.hits as Array<{ id: string }>).map((h) => h.id);
        };
        for (const searchMode of ['keyword', 'semantic', 'hybrid'] as const) {
            for (const max of [10, 30, 100]) {
                await test(`[${label}] [${searchMode}] max ${max}: tags [client:c-0] returns the tagged node`, async () => {
                    assert.deepEqual(await recall({ searchMode, max, tags: ['client:c-0'] }), ['zz-target']);
                });
            }
            await test(`[${label}] [${searchMode}] ALL-of tags + case-insensitive input`, async () => {
                assert.deepEqual(await recall({ searchMode, max: 10, tags: ['Client:C-0', 'kind:x'] }), ['zz-target']);
                assert.deepEqual(await recall({ searchMode, max: 10, tags: ['client:c-0', 'kind:y'] }), []);
            });
            await test(`[${label}] [${searchMode}] exact: client:c-008 never returns the client:c-0 node`, async () => {
                const hits = await recall({ searchMode, max: 50, tags: ['client:c-008'] });
                assert.ok(hits.length > 0 && !hits.includes('zz-target'), JSON.stringify(hits.slice(0, 5)));
            });
        }
    } finally {
        await lore.dispose();
        await cleanup();
    }
}

async function main(): Promise<void> {
    console.log('tag-scoped-recall-pushdown-unit\n');
    await part1();
    await part2();
    await part3('sqlite/sqlite', async () => {
        const dataDir = tmp('tagpush-sqlite-');
        return { dataDir, ws: 'default', cleanup: async () => fs.rmSync(dataDir, { recursive: true, force: true }) };
    });

    const raw = process.env['LORE_PG_URL'];
    if (!raw || raw.trim() === '') {
        console.log('  SKIP [postgres/postgres]: LORE_PG_URL is not set — postgres cases skipped cleanly');
    } else {
        const DB = 'lore_gate_tagpush';
        const adminUrl = new URL(raw); adminUrl.pathname = '/postgres';
        const dbUrl = new URL(raw); dbUrl.pathname = `/${DB}`;
        const admin = async (sql: string): Promise<void> => {
            const c = new pg.Client({ connectionString: adminUrl.toString() });
            await c.connect();
            try { await c.query(sql); } finally { await c.end(); }
        };
        const priorUrl = process.env['LORE_PG_URL'];
        const priorHome = process.env['LORE_HOME'];
        await part3('postgres/postgres', async () => {
            await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
            await admin(`CREATE DATABASE ${DB}`);
            process.env['LORE_PG_URL'] = dbUrl.toString();
            delete process.env['LORE_HOME'];
            const ws = 'tagpush-pg';
            const dataDir = tmp('tagpush-pg-');
            const wsPath = path.join(dataDir, 'workspaces', ws);
            fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
            fs.writeFileSync(path.join(dataDir, 'workspaces.json'), JSON.stringify({
                version: 1, active: ws,
                workspaces: [{ name: ws, path: wsPath, graphEngine: 'postgres', vectorEngine: 'postgres', createdAt: new Date().toISOString() }],
            }));
            stampGateManifest(wsPath, fixedEmbedder.modelId, DIM);
            return {
                dataDir, ws,
                cleanup: async () => {
                    fs.rmSync(dataDir, { recursive: true, force: true });
                    process.env['LORE_PG_URL'] = priorUrl;
                    if (priorHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = priorHome;
                    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
                },
            };
        });
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

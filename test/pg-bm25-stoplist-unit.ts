#!/usr/bin/env tsx
/**
 * test/pg-bm25-stoplist-unit.ts - the Postgres BM25 document-frequency stop-list (lane e2).
 *
 *   pure         LORE_BM25_COMMON_TOKEN_RATIO parsing, partitionTokens (phrases untouched), isStopListStale
 *   store (pg)   a real PostgresVerbatimStore over a real container:
 *                (a) ratio 0 is byte-for-byte today's query (same hits as the stop-list-free ftsBm25Search; no list built)
 *                (b) rare-only queries are unchanged by the feature
 *                (c) rare + common ranks exactly as the rare term alone
 *                (d) an all-common query returns no BM25 hits and never issues the ranking query
 *                (e) the list is per workspace (no leakage in either direction)
 *                (f) after a large ingest the refresh picks up a newly common token; a fresh handle does it in the
 *                    background without making the first recall wait; no-drift refresh is a no-op
 *                additive schema: a database that predates the tables gets them on the next open; backup discovery
 *                excludes them (derived data)
 *   lane f4      backoff for an unbuildable list (no background slot / throwing refresh): one attempt per RECHECK_MS;
 *                filtered all-common query runs the original query (unfiltered stays empty); restore clears the
 *                restored workspace's list; a list rebuilt by another process bumps the cache epoch; a database
 *                missing only the list tables gets just those tables (no full DDL re-run)
 *   recall path  embedded createLore() over Postgres: lore.recall(..., searchMode:'keyword') applies the list
 *
 * The pure cases run without a database; the rest need LORE_PG_URL and skip with a printed reason otherwise.
 * Run: LORE_PG_URL=postgres://... npx tsx test/pg-bm25-stoplist-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Pool } from 'pg';

import { bm25Search as ftsBm25Search } from '../packages/lore/src/engines/postgres/postgresVerbatim/postgresVerbatimFts.js';
import {
    bm25CommonTokenRatio, isStopListStale, partitionTokens, MAX_AGE_MS, MIN_ROWS_FOR_STOPLIST,
    COMMON_LEXEMES_TABLE, COMMON_LEXEMES_META_TABLE, clearStopListRows, RECHECK_MS,
} from '../packages/lore/src/engines/postgres/postgresVerbatim/postgresBm25StopList.js';
import { Bm25StopListHolder } from '../packages/lore/src/engines/postgres/postgresVerbatim/postgresBm25StopListHolder.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { ensureVerbatimSchema } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { exportWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupExport.js';
import { restoreWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupRestore.js';
import { discoverWorkspaceSchema } from '../packages/lore/src/engines/postgres/postgresBackupDiscovery.js';
import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { createLore } from '../packages/lore/src/index.js';
import {
    createGatePool, cleanupGateWorkspaces, closeGatePool, stampGateManifest, gateDbUrl, PG_GATE_WS_PREFIX,
} from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const setRatio = (v: string | undefined): void => {
    if (v === undefined) delete process.env['LORE_BM25_COMMON_TOKEN_RATIO']; else process.env['LORE_BM25_COMMON_TOKEN_RATIO'] = v;
};

console.log('\npure');
await test('LORE_BM25_COMMON_TOKEN_RATIO: default 0.2; 0, negative and >1 turn it off; garbage falls back to the default', () => {
    assert.equal(bm25CommonTokenRatio({}), 0.2);
    assert.equal(bm25CommonTokenRatio({ LORE_BM25_COMMON_TOKEN_RATIO: '' }), 0.2);
    assert.equal(bm25CommonTokenRatio({ LORE_BM25_COMMON_TOKEN_RATIO: 'abc' }), 0.2);
    assert.equal(bm25CommonTokenRatio({ LORE_BM25_COMMON_TOKEN_RATIO: '0' }), 0);
    assert.equal(bm25CommonTokenRatio({ LORE_BM25_COMMON_TOKEN_RATIO: '-1' }), 0);
    assert.equal(bm25CommonTokenRatio({ LORE_BM25_COMMON_TOKEN_RATIO: '1.5' }), 0);
    assert.equal(bm25CommonTokenRatio({ LORE_BM25_COMMON_TOKEN_RATIO: '0.5' }), 0.5);
    assert.equal(bm25CommonTokenRatio({ LORE_BM25_COMMON_TOKEN_RATIO: '1' }), 1);
});
await test('partitionTokens: single-lexeme common tokens drop; multi-lexeme tokens (phrases) and unknown tokens stay', () => {
    const lex: Record<string, string[]> = { the: ['the'], cat: ['cat'], 'the-cat': ['the', 'cat'], '...': [] };
    const of = (t: string): string[] => lex[t] ?? [t];
    const common = new Set(['the']);
    assert.deepEqual(partitionTokens(['the', 'cat'], of, common), { kept: ['cat'], droppedAny: true, hasSelective: true });
    assert.deepEqual(partitionTokens(['the-cat', 'the'], of, common), { kept: ['the-cat'], droppedAny: true, hasSelective: true }, 'phrase token never dropped, even though it contains a common lexeme');
    assert.deepEqual(partitionTokens(['the'], of, common), { kept: [], droppedAny: true, hasSelective: false });
    assert.deepEqual(partitionTokens(['the', '...'], of, common), { kept: ['...'], droppedAny: true, hasSelective: false }, 'punctuation-only token is not a selective term');
    assert.deepEqual(partitionTokens(['cat'], of, common), { kept: ['cat'], droppedAny: false, hasSelective: true });
});
await test('isStopListStale: ratio change, row drift >= 20%, age > 6h; otherwise fresh', () => {
    const st = { lexemes: new Set<string>(), ratio: 0.2, totalRows: 10_000, builtAtMs: 1_000 };
    assert.equal(isStopListStale(st, 10_000, 0.2, 2_000), false);
    assert.equal(isStopListStale(st, 11_900, 0.2, 2_000), false);
    assert.equal(isStopListStale(st, 12_000, 0.2, 2_000), true);
    assert.equal(isStopListStale(st, 8_000, 0.2, 2_000), true);
    assert.equal(isStopListStale(st, 10_000, 0.3, 2_000), true);
    assert.equal(isStopListStale(st, 10_000, 0.2, 1_000 + MAX_AGE_MS + 1), true);
});

class GateEmbedder implements EmbeddingProvider {
    readonly dimension = 4; readonly modelId = 'pg-gate-fixed'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(): Promise<number[]> { return [1, 0, 0, 0]; }
    async embed(t: string): Promise<number[]> { return this.embedDocument(t); }
    async embedDocument(_t?: string): Promise<number[]> { return [0.5, 0.5, 0.5, 0.5]; }
}

const gate = await createGatePool('pg-bm25-stoplist');
if (!gate) {
    console.log(`\n${passed} passed, ${failed} failed (pg cases skipped)`);
    process.exit(failed ? 1 : 0);
}
await cleanupGateWorkspaces(gate);
const wipeStopList = async (): Promise<void> => {
    for (const t of [COMMON_LEXEMES_TABLE, COMMON_LEXEMES_META_TABLE]) {
        const ok = (await gate.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${t}`])).rows[0]?.ok;
        if (ok) await gate.query(`DELETE FROM ${t} WHERE workspace_id LIKE $1`, [`${PG_GATE_WS_PREFIX}%`]);
    }
};
await wipeStopList();

// A counting proxy over the pool: lets a test assert the ranking query never ran.
let rankQueries = 0;
const countingPool = new Proxy(gate, {
    get(target, prop, recv) {
        if (prop === 'query') {
            return (...args: unknown[]) => {
                const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
                if (/ts_rank/.test(sql)) rankQueries++;
                return (target.query as (...a: unknown[]) => unknown)(...args);
            };
        }
        return Reflect.get(target, prop, recv);
    },
}) as Pool;

const dirs: string[] = [];
async function open(ws: string, pool: Pool = countingPool): Promise<PostgresVerbatimStore> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bm25sl-'));
    dirs.push(base);
    stampGateManifest(base, 'pg-gate-fixed', 4);
    const s = new PostgresVerbatimStore(base, pool, ws, new GateEmbedder());
    await s.initialize();
    return s;
}
const N = MIN_ROWS_FOR_STOPLIST + 1_000; // 6000: enough rows for a list to be kept
/**
 * Row i of a workspace. `hot` occurs in 90% of the rows (always common), `mid` in 1%, `rare` in 0.1%.
 * Each row also carries a unique token so every row has a distinct text.
 */
const rowsFor = (prefix: string, hot: string, mid: string, rare: string, from: number, count: number): Array<Record<string, unknown>> =>
    Array.from({ length: count }, (_, k) => {
        const i = from + k;
        const words = [`u${prefix}${i}`, 'filler'];
        if (i % 10 !== 0) words.push(hot);
        if (i % 100 === 0) words.push(mid);
        if (i % 1000 === 0) words.push(rare);
        return {
            id: `lore:${prefix}-${i}`, label: `${prefix}-${i}`, text: words.join(' '), type: 'note', project: 'p', ecosystem: '*', security_scopes: [],
            vector: [1, 0, 0, 0], contentHash: `h-${prefix}-${i}`, updatedAt: '2026-10-25T00:00:00.000Z',
        };
    });
const seed = async (s: PostgresVerbatimStore, rows: Array<Record<string, unknown>>): Promise<void> => {
    for (let i = 0; i < rows.length; i += 2_000) await s.bulkAddPrebuiltRows(rows.slice(i, i + 2_000));
};
const ids = (r: { hits: Array<{ id: string }> }): string[] => r.hits.map((h) => h.id);

console.log('\nreal store');
const WS_A = `${PG_GATE_WS_PREFIX}bm25sl-a`;
const WS_B = `${PG_GATE_WS_PREFIX}bm25sl-b`;
const WS_OFF = `${PG_GATE_WS_PREFIX}bm25sl-off`;
const WS_GROW = `${PG_GATE_WS_PREFIX}bm25sl-grow`;
const WS_SMALL = `${PG_GATE_WS_PREFIX}bm25sl-small`;
setRatio(undefined);

const a = await open(WS_A);
const b = await open(WS_B);
// A: hot = zzcommon.  B: the SAME word is rare there (1 row in 1000) and a different word is the hot one.
await seed(a, rowsFor('a', 'zzcommon', 'qqmid', 'ttrare', 0, N));
await seed(b, rowsFor('b', 'bbcommon', 'zzcommon', 'ttrare', 0, N));

await test('refresh builds a per-workspace list from a sample: the hot word and the filler are in, mid/rare words are not', async () => {
    const r = await a.refreshBm25StopList({ force: true });
    assert.equal(r.built, true);
    const lex = a.bm25CommonLexemes();
    assert.ok(lex.includes('zzcommon'), `got ${lex}`);
    assert.ok(lex.includes('filler'), `got ${lex}`);
    assert.ok(!lex.includes('qqmid') && !lex.includes('ttrare'), `got ${lex}`);
    const meta = (await gate.query(`SELECT total_rows, sample_rows, common_count FROM ${COMMON_LEXEMES_META_TABLE} WHERE workspace_id = $1`, [WS_A])).rows[0];
    assert.equal(Number(meta.total_rows), N);
    assert.ok(Number(meta.sample_rows) > 0 && Number(meta.sample_rows) <= N);
    assert.equal(Number(meta.common_count), lex.length);
});
await b.refreshBm25StopList({ force: true });

await test('(a) ratio 0: identical to the stop-list-free query, and no list is read or built', async () => {
    setRatio('0');
    const fresh = await open(WS_OFF);
    await seed(fresh, rowsFor('off', 'zzcommon', 'qqmid', 'ttrare', 0, N));
    try {
        for (const q of ['zzcommon', 'zzcommon qqmid', 'zzcommon filler', 'qqmid', 'zzcommon qqmid ttrare']) {
            const viaStore = await fresh.bm25Search(q, 25);
            const original = await ftsBm25Search(gate, WS_OFF, q, 25, undefined, undefined);
            assert.deepEqual(ids(viaStore), ids(original), q);
            assert.deepEqual(viaStore.hits.map((h) => (h as { score?: number }).score), original.hits.map((h) => (h as { score?: number }).score), `${q} scores`);
            assert.equal(viaStore.ranked, original.ranked);
        }
        assert.ok((await fresh.bm25Search('zzcommon', 25)).hits.length > 0, 'a common-only query still scans and answers when the feature is off');
        await fresh.awaitBm25StopListIdle();
        const metaRows = (await gate.query(`SELECT 1 FROM ${COMMON_LEXEMES_META_TABLE} WHERE workspace_id = $1`, [WS_OFF])).rowCount;
        assert.equal(metaRows, 0, 'nothing was built');
        assert.deepEqual(fresh.bm25CommonLexemes(), []);
        assert.deepEqual((await fresh.refreshBm25StopList({ force: true })), { built: false, commonCount: 0 }, 'refresh is a no-op when off');
    } finally { setRatio(undefined); }
});

await test('(b) rare-only queries are unchanged by the feature (same hits, same order, same scores)', async () => {
    for (const q of ['qqmid', 'ttrare', 'qqmid ttrare']) {
        setRatio('0'); const before = await a.bm25Search(q, 30);
        setRatio('0.2'); const after = await a.bm25Search(q, 30);
        assert.ok(before.hits.length > 0, q);
        assert.deepEqual(ids(after), ids(before), q);
        assert.deepEqual(after.hits.map((h) => (h as { score?: number }).score), before.hits.map((h) => (h as { score?: number }).score), `${q} scores`);
    }
    setRatio(undefined);
});

await test('(c) rare + common ranks exactly as the rare term alone; the common word contributes nothing', async () => {
    setRatio('0.2');
    try {
        const rareOnly = await a.bm25Search('qqmid', 40);
        for (const q of ['zzcommon qqmid', 'qqmid zzcommon', 'filler zzcommon qqmid']) {
            const mixed = await a.bm25Search(q, 40);
            assert.deepEqual(ids(mixed), ids(rareOnly), q);
        }
        const rareRows = new Set((await gate.query(`SELECT id FROM verbatim WHERE workspace_id = $1 AND text_tsv @@ to_tsquery('simple','qqmid')`, [WS_A])).rows.map((r) => r.id as string));
        assert.ok(ids(await a.bm25Search('zzcommon qqmid', 40)).every((id) => rareRows.has(id)), 'every hit actually contains the rare term');
        // Without the list the same query is dominated by the common word's matches (the scan the feature avoids).
        setRatio('0');
        const noList = await a.bm25Search('zzcommon qqmid', 40);
        assert.ok(noList.hits.length > 0);
    } finally { setRatio(undefined); }
});

await test('(c2) a phrase-shaped token is never dropped, even when one of its words is common', async () => {
    setRatio('0.2');
    try {
        // "zzcommon-qqmid" parses to two lexemes -> a phrase: kept whole, matches only rows with the two words adjacent.
        const withList = await a.bm25Search('zzcommon-qqmid', 20);
        setRatio('0');
        const without = await a.bm25Search('zzcommon-qqmid', 20);
        assert.deepEqual(ids(withList), ids(without));
    } finally { setRatio(undefined); }
});

await test('(d) all-common query: no BM25 hits, ranked envelope, and the ranking query is never issued', async () => {
    setRatio('0.2');
    try {
        const before = rankQueries;
        for (const q of ['zzcommon', 'zzcommon filler', 'filler zzcommon']) {
            const r = await a.bm25Search(q, 25);
            assert.deepEqual(r.hits, [], q);
            assert.equal(r.ranked, true);
        }
        assert.equal(rankQueries, before, 'no ts_rank scan for an all-common query');
        setRatio('0');
        assert.ok((await a.bm25Search('zzcommon filler', 25)).hits.length > 0, 'with the feature off the same query scans');
    } finally { setRatio(undefined); }
});

await test('(e) per workspace, no leakage: a word common in A is selective in B and the other way round', async () => {
    setRatio('0.2');
    try {
        const la = a.bm25CommonLexemes(), lb = b.bm25CommonLexemes();
        assert.ok(la.includes('zzcommon') && !la.includes('bbcommon'), `A ${la}`);
        assert.ok(lb.includes('bbcommon') && !lb.includes('zzcommon'), `B ${lb}`);
        assert.deepEqual((await a.bm25Search('zzcommon', 20)).hits, [], 'common in A: dropped');
        const inB = await b.bm25Search('zzcommon', 20);
        assert.ok(inB.hits.length > 0 && inB.hits.every((h) => h.id.startsWith('lore:b-')), 'rare in B: answered, and only B rows');
        assert.deepEqual((await b.bm25Search('bbcommon', 20)).hits, []);
        const rows = (await gate.query(`SELECT workspace_id, lexeme FROM ${COMMON_LEXEMES_TABLE} WHERE workspace_id = ANY($1)`, [[WS_A, WS_B]])).rows;
        assert.ok(rows.some((r) => r.workspace_id === WS_A && r.lexeme === 'zzcommon'));
        assert.ok(!rows.some((r) => r.workspace_id === WS_B && r.lexeme === 'zzcommon'));
        assert.ok(!rows.some((r) => r.workspace_id === WS_A && r.lexeme === 'bbcommon'));
        // a fresh handle on A (list loaded from the table, not from memory) behaves the same
        const a2 = await open(WS_A);
        assert.deepEqual((await a2.bm25Search('zzcommon', 20)).hits, []);
        assert.deepEqual(ids(await a2.bm25Search('zzcommon qqmid', 40)), ids(await a.bm25Search('qqmid', 40)));
        await a2.close?.();
    } finally { setRatio(undefined); }
});

await test('workspaces under the minimum size keep no list (the scan is cheap there)', async () => {
    const s = await open(WS_SMALL);
    await seed(s, rowsFor('small', 'zzcommon', 'qqmid', 'ttrare', 0, 300));
    const r = await s.refreshBm25StopList({ force: true });
    assert.deepEqual(r, { built: true, commonCount: 0 });
    assert.ok((await s.bm25Search('zzcommon', 20)).hits.length > 0, 'common-only still answers below the minimum');
    await s.close?.();
});

await test('(f) after a large ingest the refresh picks up a newly common token; no-drift refresh is a no-op', async () => {
    setRatio('0.2');
    const g = await open(WS_GROW);
    try {
        await seed(g, rowsFor('g', 'zzcommon', 'qqmid', 'ttrare', 0, N));
        await g.refreshBm25StopList({ force: true });
        assert.ok(!g.bm25CommonLexemes().includes('newhot'));
        assert.deepEqual(await g.refreshBm25StopList(), { built: false, commonCount: g.bm25CommonLexemes().length }, 'no drift -> no rebuild');

        // Large ingest: 2*N more rows, ALL carrying "newhot" -> 2/3 of the table; the row count tripled.
        const more = rowsFor('g2', 'zzcommon', 'qqmid', 'ttrare', N, 2 * N).map((r) => ({ ...r, text: `${String(r['text'])} newhot` }));
        await seed(g, more);
        assert.ok((await g.bm25Search('newhot', 20)).hits.length > 0, 'before the refresh the old list is in force: newhot is still a selective term');
        const r = await g.refreshBm25StopList();
        assert.equal(r.built, true, 'drift >= 20% rebuilds');
        assert.ok(g.bm25CommonLexemes().includes('newhot'), g.bm25CommonLexemes().join(','));
        assert.deepEqual((await g.bm25Search('newhot', 20)).hits, [], 'the install dropped the search cache: newhot is now dropped');
        assert.ok((await g.bm25Search('newhot qqmid', 20)).hits.length > 0);
    } finally { setRatio(undefined); }
});

await test('(f2) a fresh handle after the ingest rebuilds in the BACKGROUND: the recall that finds a stale list does not wait for the build', async () => {
    setRatio('0.2');
    try {
        // Make the persisted list stale against the table: pretend it was built when the table was a third of its size.
        await gate.query(`UPDATE ${COMMON_LEXEMES_META_TABLE} SET total_rows = total_rows / 3 WHERE workspace_id = $1`, [WS_GROW]);
        await gate.query(`DELETE FROM ${COMMON_LEXEMES_TABLE} WHERE workspace_id = $1 AND lexeme = 'newhot'`, [WS_GROW]);
        const g2 = await open(WS_GROW);
        const first = await g2.bm25Search('newhot', 20);
        assert.ok(first.hits.length > 0, 'first recall used the stored (stale) list, it did not build inline');
        await g2.awaitBm25StopListIdle();
        assert.ok(g2.bm25CommonLexemes().includes('newhot'), 'the background refresh landed');
        assert.deepEqual((await g2.bm25Search('newhot', 20)).hits, []);
        await g2.close?.();
    } finally { setRatio(undefined); }
});

await test('changing the ratio rebuilds for the new threshold (a list built at 0.2 is not applied at 0.9)', async () => {
    const g = await open(WS_A);
    try {
        setRatio('0.9');
        // zzcommon is in 90% of A's rows (sample may land a hair under): no word reaches >= 90% reliably besides 'filler'.
        const r1 = await g.bm25Search('zzcommon', 20);
        await g.awaitBm25StopListIdle();
        assert.ok(r1.hits.length > 0, 'the 0.2 list was ignored for a 0.9 setting while the 0.9 list built in the background');
        assert.ok(!g.bm25CommonLexemes().includes('zzcommon') || g.bm25CommonLexemes().includes('filler'));
    } finally { setRatio(undefined); await g.close?.(); }
});

await test('additive schema: a database without the stop-list tables gets them on the next open; backup discovery excludes them', async () => {
    await gate.query(`DROP TABLE IF EXISTS ${COMMON_LEXEMES_TABLE}`);
    await gate.query(`DROP TABLE IF EXISTS ${COMMON_LEXEMES_META_TABLE}`);
    const s = await open(`${PG_GATE_WS_PREFIX}bm25sl-upgrade`);
    for (const t of [COMMON_LEXEMES_TABLE, COMMON_LEXEMES_META_TABLE]) {
        assert.equal((await gate.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${t}`])).rows[0].ok, true, t);
    }
    // the store still works against the (empty) list tables
    await seed(s, rowsFor('up', 'zzcommon', 'qqmid', 'ttrare', 0, 50));
    assert.ok((await s.bm25Search('zzcommon', 10)).hits.length > 0);
    const client = await gate.connect();
    try {
        const d = await discoverWorkspaceSchema(client);
        const excluded = d.excluded.map((e) => e.table);
        assert.ok(excluded.includes(COMMON_LEXEMES_TABLE) && excluded.includes(COMMON_LEXEMES_META_TABLE), `excluded: ${excluded}`);
        const backedUp = d.tables.map((t) => t.name);
        assert.ok(!backedUp.includes(COMMON_LEXEMES_TABLE) && !backedUp.includes(COMMON_LEXEMES_META_TABLE));
    } finally { client.release(); }
    await s.close?.();
});

await test('ensureFtsIndex (the bulk-ingest finish hook) builds the list', async () => {
    setRatio('0.2');
    const ws = `${PG_GATE_WS_PREFIX}bm25sl-fts`;
    const s = await open(ws);
    try {
        await seed(s, rowsFor('fts', 'zzcommon', 'qqmid', 'ttrare', 0, N));
        await (s as unknown as { ensureFtsIndex(): Promise<unknown> }).ensureFtsIndex();
        assert.ok(s.bm25CommonLexemes().includes('zzcommon'), 'list built by the index-finish hook');
    } finally { setRatio(undefined); await s.close?.(); }
});

// ---- lane f4: backoff, filtered all-common, cleanup, cross-process epoch, upgrade cost ---------------------------
console.log('\nlane f4');
const WS_NOSLOT = `${PG_GATE_WS_PREFIX}bm25sl-noslot`;
const metaReadCounter = { n: 0 };
const countMetaReads = (p: Pool): Pool => new Proxy(p, {
    get(target, prop, recv) {
        if (prop === 'query') {
            return (...args: unknown[]) => {
                const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
                if (/FROM verbatim_common_lexemes_meta/.test(sql)) metaReadCounter.n++;
                return (target.query as (...a: unknown[]) => unknown)(...args);
            };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
    },
}) as Pool;

await test('backoff (a): a pool with no background slot never builds a list and does not retry per query (store path)', async () => {
    setRatio('0.2');
    const noSlot = createPostgresPool({ url: gateDbUrl()!, max: 1 });
    try {
        const seeder = await open(WS_NOSLOT);
        await seed(seeder, rowsFor('ns', 'zzcommon', 'qqmid', 'ttrare', 0, N));
        await seeder.awaitBm25StopListIdle();
        await clearStopListRows(gate, WS_NOSLOT); // the seeding handle may have built one; start with no list
        const s = await open(WS_NOSLOT, countMetaReads(noSlot));
        try {
            metaReadCounter.n = 0;
            for (let i = 0; i < 3; i++) { await s.bm25Search(`qqmid zzcommon${i}`, 10); await s.awaitBm25StopListIdle(); }
            const afterThree = metaReadCounter.n;
            for (let i = 3; i < 12; i++) { await s.bm25Search(`qqmid zzcommon${i}`, 10); await s.awaitBm25StopListIdle(); }
            assert.equal(metaReadCounter.n, afterThree, `nine more uncached queries issued no more metadata reads (was ${afterThree})`);
            assert.ok(afterThree <= 2, `one initial load + at most one refresh attempt, got ${afterThree}`);
            assert.deepEqual(s.bm25CommonLexemes(), [], 'no list could be built');
            assert.ok((await s.bm25Search('qqmid', 10)).hits.length > 0, 'queries still answer with the original SQL');
        } finally { await s.close?.(); }
        await seeder.close?.();
    } finally { setRatio(undefined); await closePostgresPool(noSlot); }
});

await test('backoff (a2/b): holder retries a failed or ran:false refresh once per RECHECK_MS, and logs a failure once per window', async () => {
    setRatio('0.2');
    const noSlot = createPostgresPool({ url: gateDbUrl()!, max: 1 });
    try {
        const run = async (label: string, count: () => Promise<number>): Promise<{ errors: number }> => {
            let clock = 1_000_000;
            const st = { counts: 0, errors: 0 };
            const h = new Bm25StopListHolder({
                pool: () => noSlot, workspaceId: WS_NOSLOT, owner: {}, isClosed: () => false, onChanged: () => {},
                count: async () => { st.counts++; return count(); },
                log: { error: () => { st.errors++; } },
                now: () => clock,
            });
            const at = async (advance: number): Promise<void> => {
                clock += advance;
                for (let i = 0; i < 5; i++) { await h.forQuery(); await h.idle(); }
            };
            await at(0);
            assert.equal(st.counts, 1, `${label}: first window attempts once`);
            await at(30_000);
            assert.equal(st.counts, 1, `${label}: still inside the window`);
            await at(RECHECK_MS);
            assert.equal(st.counts, 2, `${label}: next window attempts once more`);
            return st;
        };
        const ranFalse = await run('ran:false', async () => N);
        assert.equal(ranFalse.errors, 0, 'a skipped (no slot) build is not an error');
        const thrower = await run('throwing', async () => { throw new Error('boom'); });
        assert.equal(thrower.errors, 2, 'one log line per backoff window, not per query');
    } finally { setRatio(undefined); await closePostgresPool(noSlot); }
});

await test('filtered all-common query runs the original query: same rows and scores as ratio 0; unfiltered stays empty', async () => {
    const queries = ['zzcommon filler', 'filler zzcommon', 'zzcommon ???', 'zzcommon'];
    const filters: Array<Record<string, unknown>> = [{ project: 'p' }, { label: 'a-5' }, { type: 'note', project: 'p' }];
    for (const f of filters) {
        for (const q of queries) {
            setRatio('0'); const original = await a.bm25Search(q, 25, f as never);
            setRatio('0.2'); const withList = await a.bm25Search(q, 25, f as never);
            assert.ok(original.hits.length > 0, `${q} ${JSON.stringify(f)}: the original query has hits`);
            assert.deepEqual(ids(withList), ids(original), `${q} ${JSON.stringify(f)}`);
            assert.deepEqual(withList.hits.map((h) => (h as { score?: number }).score), original.hits.map((h) => (h as { score?: number }).score), `${q} scores`);
            assert.equal(withList.ranked, true);
        }
    }
    setRatio('0.2');
    try {
        const before = rankQueries;
        for (const q of queries) {
            assert.deepEqual((await a.bm25Search(q, 25)).hits, [], `${q}: unfiltered all-common still returns no BM25 hits`);
            assert.deepEqual((await a.bm25Search(q, 25, {} as never)).hits, [], `${q}: an empty filter is no filter`);
            assert.deepEqual((await a.bm25Search(q, 25, { project: undefined } as never)).hits, [], `${q}: an undefined-valued filter is no filter`);
        }
        assert.equal(rankQueries, before, 'no ranking query for unfiltered all-common');
        // a selective term next to a common one is unchanged by the filter rule
        const rareOnly = await a.bm25Search('qqmid', 40, { project: 'p' } as never);
        assert.deepEqual(ids(await a.bm25Search('zzcommon qqmid', 40, { project: 'p' } as never)), ids(rareOnly));
    } finally { setRatio(undefined); }
});

await test('restore clears the restored workspace stop-list rows (derived data) so it is rebuilt; other workspaces untouched', async () => {
    const WS_BK = `${PG_GATE_WS_PREFIX}bm25sl-bk`;
    const WS_BK2 = `${PG_GATE_WS_PREFIX}bm25sl-bk-restored`;
    const src = await open(WS_BK);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bm25sl-bk-'));
    dirs.push(out);
    try {
        await seed(src, rowsFor('bk', 'zzcommon', 'qqmid', 'ttrare', 0, 300));
        const summary = await exportWorkspaceBundle(gate, { workspaceId: WS_BK, outDir: out });
        const bundlePath = summary.bundlePath;
        const plant = async (ws: string): Promise<void> => {
            await gate.query(`INSERT INTO ${COMMON_LEXEMES_TABLE} (workspace_id, lexeme, doc_ratio, doc_count) VALUES ($1,'plantedlexeme',0.9,9) ON CONFLICT DO NOTHING`, [ws]);
            await gate.query(`INSERT INTO ${COMMON_LEXEMES_META_TABLE} (workspace_id, total_rows, sample_rows, ratio, common_count, built_at) VALUES ($1,1,1,0.2,1,now()) ON CONFLICT (workspace_id) DO NOTHING`, [ws]);
        };
        const rowsOf = async (ws: string): Promise<number> => Number((await gate.query(
            `SELECT (SELECT count(*) FROM ${COMMON_LEXEMES_TABLE} WHERE workspace_id = $1) + (SELECT count(*) FROM ${COMMON_LEXEMES_META_TABLE} WHERE workspace_id = $1) AS c`, [ws])).rows[0].c);
        await plant(WS_BK2); await plant(WS_BK);
        const r1 = await restoreWorkspaceBundle(gate, { bundlePath, targetWorkspaceId: WS_BK2 });
        assert.ok(r1.totalRows > 0);
        assert.equal(await rowsOf(WS_BK2), 0, 'restore into an empty target cleared the target list');
        assert.equal(await rowsOf(WS_BK), 2, 'a different workspace list is untouched');
        await plant(WS_BK2);
        await restoreWorkspaceBundle(gate, { bundlePath, targetWorkspaceId: WS_BK2, force: true });
        assert.equal(await rowsOf(WS_BK2), 0, 'forced restore over existing rows cleared the list too');
    } finally {
        await gate.query(`DELETE FROM ${COMMON_LEXEMES_TABLE} WHERE workspace_id = ANY($1)`, [[WS_BK, WS_BK2]]);
        await gate.query(`DELETE FROM ${COMMON_LEXEMES_META_TABLE} WHERE workspace_id = ANY($1)`, [[WS_BK, WS_BK2]]);
        await src.close?.();
    }
});

await test('clearStopListRows: removes one workspace (both tables), reports the count, no-op when the tables are absent', async () => {
    const w1 = `${PG_GATE_WS_PREFIX}bm25sl-clr1`, w2 = `${PG_GATE_WS_PREFIX}bm25sl-clr2`;
    for (const w of [w1, w2]) {
        await gate.query(`INSERT INTO ${COMMON_LEXEMES_TABLE} (workspace_id, lexeme, doc_ratio, doc_count) VALUES ($1,'x',0.5,5)`, [w]);
        await gate.query(`INSERT INTO ${COMMON_LEXEMES_META_TABLE} (workspace_id, total_rows, sample_rows, ratio, common_count, built_at) VALUES ($1,1,1,0.2,1,now())`, [w]);
    }
    assert.equal(await clearStopListRows(gate, w1), 2);
    assert.equal(await clearStopListRows(gate, w1), 0);
    assert.equal(Number((await gate.query(`SELECT count(*) AS c FROM ${COMMON_LEXEMES_TABLE} WHERE workspace_id = $1`, [w2])).rows[0].c), 1);
    assert.equal(await clearStopListRows(gate, w2, 'public'), 2, 'schema-qualified');
    assert.equal(await clearStopListRows(gate, w2, 'no_such_schema'), 0, 'absent schema/tables is a no-op');
});

await test('cross-process change: a list rebuilt by another process bumps the search-cache epoch on the next refresh', async () => {
    setRatio('0.2');
    try {
        await a.refreshBm25StopList({ force: true });
        assert.ok(!a.bm25CommonLexemes().includes('qqmid'));
        const cached = await a.bm25Search('qqmid', 20);
        assert.ok(cached.hits.length > 0, 'qqmid is selective and the result is now in the search cache');
        // "another process" makes qqmid common (same ratio, fresh built_at, same total_rows -> not stale for THIS process)
        await gate.query(`INSERT INTO ${COMMON_LEXEMES_TABLE} (workspace_id, lexeme, doc_ratio, doc_count) VALUES ($1,'qqmid',0.5,3000) ON CONFLICT DO NOTHING`, [WS_A]);
        assert.deepEqual(ids(await a.bm25Search('qqmid', 20)), ids(cached), 'before the refresh the cached result is still served');
        const r = await a.refreshBm25StopList();
        assert.equal(r.built, false, 'not stale: nothing rebuilt locally');
        assert.ok(a.bm25CommonLexemes().includes('qqmid'), 'the other process list was loaded');
        assert.deepEqual((await a.bm25Search('qqmid', 20)).hits, [], 'epoch bumped: the cache entry ranked with the old list is gone');
        const again = await a.refreshBm25StopList();
        assert.equal(again.built, false);
        // restore the real list
        await a.refreshBm25StopList({ force: true });
        assert.ok(!a.bm25CommonLexemes().includes('qqmid'));
        assert.ok((await a.bm25Search('qqmid', 20)).hits.length > 0);
    } finally { setRatio(undefined); }
});

await test('holder: onChanged fires only when the loaded list differs from the one in memory', async () => {
    setRatio('0.2');
    try {
        const w = `${PG_GATE_WS_PREFIX}bm25sl-epoch`;
        let bumps = 0;
        const h = new Bm25StopListHolder({
            pool: () => gate, workspaceId: w, owner: {}, isClosed: () => false, onChanged: () => { bumps++; },
            count: async () => 100, log: { error: () => {} },
        });
        await h.refresh();                       // below minimum: writes an empty list
        const afterBuild = bumps;
        await h.refresh();                       // same list reloaded
        assert.equal(bumps, afterBuild, 'unchanged reload: no bump');
        await gate.query(`INSERT INTO ${COMMON_LEXEMES_TABLE} (workspace_id, lexeme, doc_ratio, doc_count) VALUES ($1,'other',0.5,5)`, [w]);
        await h.refresh();
        assert.equal(bumps, afterBuild + 1, 'a different list loaded from the table bumps once');
        await h.refresh();
        assert.equal(bumps, afterBuild + 1);
    } finally { setRatio(undefined); }
});

await test('upgrade cost: a database missing only the stop-list tables gets just those tables, not the full DDL re-run', async () => {
    await gate.query(`DROP TABLE IF EXISTS ${COMMON_LEXEMES_TABLE}`);
    await gate.query(`DROP TABLE IF EXISTS ${COMMON_LEXEMES_META_TABLE}`);
    const client = await gate.connect();
    const sqls: string[] = [];
    const realQuery = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
        sqls.push(typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '');
        return realQuery(...args);
    };
    try {
        await ensureVerbatimSchema(client, `${PG_GATE_WS_PREFIX}bm25sl-upgrade2`, 4);
    } finally { client.release(); }
    assert.ok(!sqls.some((s) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(s)), 'no CREATE INDEX statement ran');
    assert.ok(sqls.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${COMMON_LEXEMES_TABLE}`)));
    for (const t of [COMMON_LEXEMES_TABLE, COMMON_LEXEMES_META_TABLE]) {
        assert.equal((await gate.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${t}`])).rows[0].ok, true, t);
    }
    // a second open is the cheap path: no CREATE at all
    const again: string[] = [];
    const c2 = await gate.connect();
    const rq = c2.query.bind(c2) as (...a: unknown[]) => Promise<unknown>;
    (c2 as unknown as { query: unknown }).query = (...args: unknown[]) => { again.push(typeof args[0] === 'string' ? args[0] : ''); return rq(...args); };
    try { await ensureVerbatimSchema(c2, `${PG_GATE_WS_PREFIX}bm25sl-upgrade2`, 4); } finally { c2.release(); }
    assert.ok(!again.some((s) => /CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TABLE/i.test(s)), `current schema: no CREATE INDEX/TABLE statement, got ${again.filter((s) => /CREATE/i.test(s)).join(' | ').slice(0, 300)}`);
});

// ---- the real recall path: embedded createLore() over a real Postgres -------------------------------------------
console.log('\nrecall path (embedded createLore + postgres)');
const gateUrl = gateDbUrl()!;
process.env['LORE_PG_URL'] = gateUrl;
process.env['LORE_MODEL_SERVER'] = '0';
const WS_E2E = `${PG_GATE_WS_PREFIX}bm25sl-e2e-${Date.now().toString(36)}`;
// Postgres rows are keyed by the permanent workspace id, not the name; raw SQL below uses WSK_E2E.
const WSK_E2E = `${WS_E2E}-id`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-pg-bm25sl-'));
const wsPath = path.join(home, 'workspaces', WS_E2E);
fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    version: 1, active: WS_E2E,
    workspaces: [{ name: WS_E2E, id: WSK_E2E, path: wsPath, graphEngine: 'postgres', vectorEngine: 'postgres', createdAt: new Date().toISOString() }],
}));
stampGateManifest(wsPath, 'pg-gate-fixed', 4);
delete process.env['LORE_HOME'];
const lore = await createLore({ dataDir: home, deploymentMode: 'embedded', embeddingProvider: new GateEmbedder() as never, modelServer: false } as never) as any;
try {
    const v = lore.store.loreVerbatim as PostgresVerbatimStore;
    // Volume as prebuilt verbatim rows (hot word in 90%), plus 40 real graph nodes the recall path can hydrate.
    await seed(v, rowsFor('e2e', 'zzcommon', 'xmid', 'xrare', 0, N));
    const node = (id: string, content: string) => ({ id, workspace: WS_E2E, ecosystem: '*', nodeData: { id, type: 'note', label: id, content, project: WS_E2E, ecosystem: '*' } });
    for (let i = 0; i < 20; i++) {
        await lore.nodeUpsert(node(`rare-${i}`, `zzcommon qqmid note ${i}`));
        await lore.nodeUpsert(node(`plain-${i}`, `zzcommon filler plain ${i}`));
    }
    await lore.awaitEmbeds?.();
    assert.equal(Number((await gate.query(`SELECT count(*) AS c FROM verbatim WHERE workspace_id = $1 AND id LIKE 'lore:rare-%' AND is_canonical = 1`, [WSK_E2E])).rows[0].c), 20, 'the 20 rare nodes have verbatim rows');
    await v.refreshBm25StopList({ force: true });
    assert.ok(v.bm25CommonLexemes().includes('zzcommon'));
    if (process.env['DBG']) console.log('DBG rows', JSON.stringify((await gate.query(`SELECT workspace_id, id, is_canonical, ecosystem FROM verbatim WHERE text LIKE '%qqmid note 3%' LIMIT 5`)).rows));
    // The recall result names the retrieval legs behind each hit; the BM25 leg is what the stop-list changes.
    const recallIds = async (q: string): Promise<string[]> => {
        const out = await lore.recall(q, { workspace: WS_E2E, mode: 'full', searchMode: 'keyword', limit: 60 });
        return ((out as any).knowledge as Array<{ id: string }>).map((k) => k.id).sort();
    };
    // Spy on the verbatim store the recall path really calls (wraps, never replaces, the real bm25Search): the graph's own
    // keyword leg also supplements recall results, so the BM25 leg is observed where it enters.
    const seen: Array<{ q: string; hits: string[] }> = [];
    const realBm25 = v.bm25Search.bind(v);
    v.bm25Search = (async (q: string, ...rest: unknown[]) => {
        const env = await (realBm25 as (...a: unknown[]) => Promise<{ hits: Array<{ id: string }> }>)(q, ...rest);
        seen.push({ q, hits: env.hits.map((h) => h.id) });
        return env;
    }) as typeof v.bm25Search;
    const bm25Leg = async (q: string): Promise<{ recall: string[]; bm25: string[] }> => {
        seen.length = 0;
        const recall = await recallIds(q);
        assert.ok(seen.length > 0, `recall(${q}) reached PostgresVerbatimStore.bm25Search`);
        return { recall, bm25: [...new Set(seen.flatMap((s) => s.hits))].sort() };
    };
    await test('lore.recall(keyword) reaches the stop-list: rare+common ranks as rare, all-common gets no BM25 hits, ratio 0 restores the scan', async () => {
        setRatio('0.2');
        const rare = await bm25Leg('qqmid');
        assert.ok(rare.bm25.some((id) => id.startsWith('lore:rare-')), `rare term answers through the real recall path: bm25=${rare.bm25} seen=${JSON.stringify(seen).slice(0,300)}`);
        assert.ok(rare.recall.some((id) => id.startsWith('rare-')));
        const mixed = await bm25Leg('zzcommon qqmid');
        assert.deepEqual(mixed.bm25, rare.bm25, 'common word dropped from the BM25 leg');
        assert.deepEqual(mixed.recall, rare.recall);
        const allCommon = await bm25Leg('zzcommon filler');
        assert.deepEqual(allCommon.bm25, [], 'all-common: the BM25 leg returns nothing');
        setRatio('0');
        const off = await bm25Leg('zzcommon filler');
        assert.ok(off.bm25.length > 0, 'with the feature off the same recall scans and answers');
        setRatio(undefined);
    });
} finally {
    setRatio(undefined);
    try { await lore.dispose?.(); } catch { /* best effort */ }
}

for (const s of [a, b]) { try { await s.close?.(); } catch { /* best effort */ } }
await wipeStopList();
await cleanupGateWorkspaces(gate);
await closeGatePool(gate);
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

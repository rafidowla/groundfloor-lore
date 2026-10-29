#!/usr/bin/env tsx
/**
 * test/pg-keyword-score-raw-unit.ts - Phase 0 lane L5: merge-safe keyword scores.
 *
 * bm25Search returns the RAW ts_rank per row and normalizes ONCE, after the scope filter, in
 * postgresKeywordScore.normalizeKeywordHits (via finalizeKeywordHits). Pins:
 *   - pure: the shared helper equals the pre-L5 inline expression (`raw / max(...raw, 1e-9)`) on arbitrary inputs;
 *   - pure: finalizeKeywordHits filters BEFORE normalizing - a top hit the actor cannot see never pins the visible
 *     hits' scores below 1.0 (and the legacy "normalize then filter" order would, which is asserted too);
 *   - PG (public store API, real Postgres): scores for an actor with no scopes (undefined) are byte-identical to the
 *     pre-L5 normalization of the same SQL's raw ts_rank; a scoped actor's best visible hit is exactly 1.0 even when a
 *     hidden row outranks everything; the ALS-bound actor (what the MCP/HTTP path uses) sees the same numbers;
 *     the numbers are comparable (raw ratios preserved) so a Phase 3 merge of raw hits would order correctly.
 *
 * Needs a throwaway Postgres with pgvector >= 0.8 (`LORE_PG_URL`); creates and drops its own database
 * (`lore_l5_<pid>`). The pure cases always run; the PG cases skip cleanly when LORE_PG_URL is unset.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { ensureGraphSchema } from '../packages/lore/src/engines/postgres/postgresGraphSchema.js';
import { ensureVerbatimSchema } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { finalizeKeywordHits } from '../packages/lore/src/engines/postgres/postgresVerbatim/postgresVerbatimFts.js';
import { normalizeKeywordHits, normalizeKeywordScores } from '../packages/lore/src/engines/postgres/postgresVerbatim/postgresKeywordScore.js';
import { applyActorScopeFilter } from '../packages/lore/src/security/scopeFilter.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { stampGateManifest } from './helpers/testPostgres.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}

/** Verbatim copy of the pre-L5 inline expression (postgresVerbatimFts.ts on main): the reference for byte-identity. */
function legacyNormalize(raw: number[]): number[] {
    const maxMag = Math.max(...raw, 1e-9);
    return raw.map((r) => r / maxMag);
}

console.log('\npostgres keyword scores - raw ts_rank, normalized once after the scope filter');

// ---- pure ---------------------------------------------------------------------------------------------------------
await test('normalizeKeywordScores equals the pre-L5 expression on arbitrary inputs (incl. empty, zeros, ties)', () => {
    const cases: number[][] = [[], [0], [0, 0, 0], [0.0607927, 0.0303964, 0.0151982], [1e-12, 5e-13], [0.4, 0.4, 0.4], [3.2, 0.1, 0]];
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 200; i++) cases.push(Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => rnd() * 2));
    for (const c of cases) assert.deepEqual(normalizeKeywordScores(c), c.length === 0 ? [] : legacyNormalize(c), JSON.stringify(c));
});

const hit = (id: string, score: number, scopes: string[]) => ({ id, score, text: id, metadata: { security_scopes: scopes } });

await test('finalizeKeywordHits filters BEFORE normalizing: a hidden top hit does not pin visible scores below 1.0', () => {
    const raw = [hit('hidden', 0.8, ['secret']), hit('v1', 0.4, []), hit('v2', 0.2, ['team-a'])];
    const out = finalizeKeywordHits(raw, ['team-a']);
    assert.deepEqual(out.map((h) => h.id), ['v1', 'v2']);
    assert.deepEqual(out.map((h) => h.score), [1, 0.5]);
    // The legacy order (normalize the whole set, then filter) is exactly the bug: it pins the visible top at 0.5.
    const legacy = applyActorScopeFilter(raw.map((h, i) => ({ ...h, score: legacyNormalize(raw.map((r) => r.score))[i]! })), ['team-a']);
    assert.deepEqual(legacy.map((h) => h.score), [0.5, 0.25]);
});

await test('finalizeKeywordHits with no actor (undefined) is exactly the legacy normalization of the whole list', () => {
    const raw = [hit('a', 0.8, ['secret']), hit('b', 0.4, []), hit('c', 0.2, ['x'])];
    assert.deepEqual(finalizeKeywordHits(raw, undefined).map((h) => h.score), legacyNormalize(raw.map((r) => r.score)));
});

await test('merge-safety: raw scores from two slices merged then normalized once == one-slice normalization', () => {
    const all = [hit('a', 0.9, []), hit('b', 0.6, []), hit('c', 0.3, []), hit('d', 0.1, [])];
    const sliceA = all.filter((_, i) => i % 2 === 0); const sliceB = all.filter((_, i) => i % 2 === 1);
    const merged = [...sliceA, ...sliceB].sort((x, y) => (y.score - x.score) || x.id.localeCompare(y.id));
    assert.deepEqual(normalizeKeywordHits(merged).map((h) => h.score), normalizeKeywordHits(all).map((h) => h.score));
    // Normalizing each slice separately first would not be comparable (both slices would claim a 1.0):
    assert.notDeepEqual([...normalizeKeywordHits(sliceA), ...normalizeKeywordHits(sliceB)].map((h) => h.score).sort(), normalizeKeywordHits(all).map((h) => h.score).sort());
});

// ---- Postgres -----------------------------------------------------------------------------------------------------
const url = process.env.LORE_PG_URL;
if (!url || url.trim() === '') {
    console.log('SKIP postgres cases: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector 0.8+)');
    console.log(`\n${passed} passed, ${failed} failed (PG cases skipped)`);
    process.exit(failed > 0 ? 1 : 0);
}

const DIM = 4;
const dbName = `lore_l5_${process.pid}`;
const withDb = (db: string): string => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
class NoEmbed implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'pg-keyword-score-none'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { throw new Error('must not embed'); }
    async embedQuery(): Promise<number[]> { throw new Error('must not embed'); }
    async embedDocument(): Promise<number[]> { return [-1, 0, 0, 0]; }
}
const row = (id: string, scopes: string[], text: string) => ({
    id, label: id, text, type: 'note', project: 'p', ecosystem: '*', security_scopes: scopes,
    vector: [1, 0, 0, 0], contentHash: `h-${id}`, updatedAt: '2026-10-29T00:00:00.000Z',
});
const dirs: string[] = [];
async function open(pool: Pool, ws: string): Promise<PostgresVerbatimStore> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-kwscore-'));
    dirs.push(base);
    stampGateManifest(base, 'pg-keyword-score-none', DIM);
    const s = new PostgresVerbatimStore(base, pool, ws, new NoEmbed());
    await s.initialize();
    return s;
}

const admin = new Client({ connectionString: withDb('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${dbName}`);
const pool = createPostgresPool({ url: withDb(dbName) });
pool.on('error', () => undefined);

try {
    const boot = await pool.connect();
    try { await ensureGraphSchema(boot, 'setup'); await ensureVerbatimSchema(boot, 'setup', DIM); } finally { boot.release(); }

    const WS = 'l5-scores';
    const s = await open(pool, WS);
    // Term density drives ts_rank: the hidden row repeats the term most, so it is the global top hit.
    const filler = 'lorem ipsum dolor sit amet consectetur';
    await s.bulkAddPrebuiltRows([
        row('hidden-top', ['secret'], `quokka quokka quokka quokka quokka quokka quokka quokka ${filler}`),
        row('pub-best', [], `quokka quokka quokka quokka ${filler}`),
        row('pub-mid', [], `quokka quokka ${filler} ${filler}`),
        row('team-a-low', ['team-a'], `quokka ${filler} ${filler} ${filler}`),
        row('hidden-other', ['team-b'], `quokka quokka quokka ${filler}`),
    ]);

    /** Raw ts_rank by id straight from SQL - the ground truth the engine must normalize. */
    const rawById = async (): Promise<Map<string, number>> => {
        const r = await pool.query<{ id: string; r: number }>(
            `SELECT id, ts_rank(text_tsv, phraseto_tsquery('simple', 'quokka')) AS r FROM verbatim
              WHERE workspace_id = $1 AND is_canonical = 1 AND is_tombstone = 0 AND text_tsv @@ phraseto_tsquery('simple', 'quokka')`, [WS]);
        return new Map(r.rows.map((x) => [x.id, Number(x.r)]));
    };

    await test('no actor scopes (undefined): scores are byte-identical to the pre-L5 normalization of the raw ts_rank', async () => {
        const raw = await rawById();
        const env = await s.bm25Search('quokka', 10);
        assert.equal(env.ranked, true);
        assert.equal(env.hits.length, 5);
        const rawList = env.hits.map((h) => raw.get(h.id)!);
        assert.deepEqual(env.hits.map((h) => h.score), legacyNormalize(rawList));
        assert.equal(env.hits[0]!.id, 'hidden-top');
        assert.equal(env.hits[0]!.score, 1);
        // best-first, id asc tie-break preserved
        for (let i = 1; i < env.hits.length; i++) assert.ok(env.hits[i - 1]!.score >= env.hits[i]!.score);
    });

    await test('scoped actor: the hidden global top hit does not pin the visible hits below 1.0', async () => {
        const raw = await rawById();
        assert.ok(raw.get('hidden-top')! > raw.get('pub-best')!, 'precondition: hidden row outranks the visible ones');
        const env = await s.bm25Search('quokka', 10, undefined, ['team-a']);
        assert.deepEqual(env.hits.map((h) => h.id).sort(), ['pub-best', 'pub-mid', 'team-a-low']);
        assert.equal(env.hits[0]!.id, 'pub-best');
        assert.equal(env.hits[0]!.score, 1, 'best VISIBLE hit is exactly 1.0');
        const rawVisible = env.hits.map((h) => raw.get(h.id)!);
        assert.deepEqual(env.hits.map((h) => h.score), legacyNormalize(rawVisible), 'normalized over the visible set only');
        // old behaviour would have produced raw/hiddenTop for pub-best
        assert.ok(raw.get('pub-best')! / raw.get('hidden-top')! < 1);
    });

    await test('[] actor (public only) and the ALS-bound actor (MCP/HTTP path) get the same scoped numbers', async () => {
        const pub = await s.bm25Search('quokka', 10, undefined, []);
        assert.deepEqual(pub.hits.map((h) => h.id), ['pub-best', 'pub-mid']);
        assert.equal(pub.hits[0]!.score, 1);
        const viaAls = await runWithActor({ portalUserId: 'u-l5', scopes: ['team-a'] }, () => s.bm25Search('quokka', 10));
        const explicit = await s.bm25Search('quokka', 10, undefined, ['team-a']);
        assert.deepEqual(viaAls.hits.map((h) => [h.id, h.score]), explicit.hits.map((h) => [h.id, h.score]));
        assert.equal(viaAls.hits[0]!.score, 1);
    });

    await test('score ratios are preserved (raw ts_rank is comparable): visible scores = raw / best visible raw', async () => {
        const raw = await rawById();
        const env = await s.bm25Search('quokka', 10, undefined, ['team-b']);
        const best = Math.max(...env.hits.map((h) => raw.get(h.id)!));
        for (const h of env.hits) assert.equal(h.score, raw.get(h.id)! / best, h.id);
        assert.equal(Math.max(...env.hits.map((h) => h.score)), 1);
    });

    await test('limit smaller than the visible set: the cut set is normalized by its own best (== best visible hit)', async () => {
        const env = await s.bm25Search('quokka', 2, undefined, ['team-a']);
        assert.deepEqual(env.hits.map((h) => h.id), ['pub-best', 'pub-mid']);
        assert.equal(env.hits[0]!.score, 1);
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

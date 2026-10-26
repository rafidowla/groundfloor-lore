#!/usr/bin/env tsx
/**
 * test/postgres-verbatim-vector-search-unit.ts - what the link-on-arrival Linker needs from the Postgres verbatim
 * store beyond the shared engine contract (test/link-batch-engine-contract-unit.ts):
 *
 *   getById      returns ecosystem and security_scopes of the canonical row (the Linker reads both to confine hits)
 *   getVectors   returns the stored embedding, bit-exact, for canonical rows only
 *   searchByVectors
 *                - scope filtering: rows labelled for a scope the actor lacks never come back, per key
 *                - isolation: another workspace's rows (same table, different partition) never come back
 *                - history and tombstoned rows are not returned
 *                - a large batch (300 queries) is one correct call, every key answered, order preserved
 *                - identical to N single searchByVector calls
 *
 * Skips cleanly (printed reason, exit 0) when LORE_PG_URL is unset.
 * Run: LORE_PG_URL=postgres://... npx tsx test/postgres-verbatim-vector-search-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { createGatePool, cleanupGateWorkspaces, closeGatePool, stampGateManifest } from './helpers/testPostgres.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const pool = await createGatePool('postgres-vector-search');
if (!pool) {
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
}
await cleanupGateWorkspaces(pool);

const DIM = 4;
/** Never embeds queries; tombstone() re-embeds its marker text, which gets a fixed vector (tombstones are excluded from search anyway). */
class NoEmbed implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'pg-vector-search-none'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { throw new Error('must not embed'); }
    async embedQuery(): Promise<number[]> { throw new Error('must not embed'); }
    async embedDocument(): Promise<number[]> { return [-1, 0, 0, 0]; }
}
const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180), 0, 0];
const row = (id: string, deg: number, o: { ecosystem?: string; scopes?: string[] } = {}) => ({
    id, label: id, text: `text ${id}`, type: 'note', project: 'p', ecosystem: o.ecosystem ?? '*', security_scopes: o.scopes ?? [],
    vector: at(deg), contentHash: `h-${id}`, updatedAt: '2026-10-23T00:00:00.000Z',
});
const dirs: string[] = [];
async function open(ws: string): Promise<PostgresVerbatimStore> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-vs-'));
    dirs.push(base);
    stampGateManifest(base, 'pg-vector-search-none', DIM);
    const s = new PostgresVerbatimStore(base, pool!, ws, new NoEmbed());
    await s.initialize();
    return s;
}
const ids = (hits: Array<{ id: string }>): string[] => hits.map((h) => h.id);

console.log('\npostgres verbatim - stored-vector search + Linker reads');

await test('getById returns ecosystem and security_scopes; getVectors returns the stored embedding', async () => {
    const s = await open('pg-gate-vs-reads');
    await s.bulkAddPrebuiltRows([row('lore:a', 0, { ecosystem: 'eco-x', scopes: ['team-a', 'team-b'] }), row('lore:b', 30)]);
    const a = await s.getById('lore:a');
    assert.equal(a?.ecosystem, 'eco-x');
    assert.deepEqual(a?.security_scopes, ['team-a', 'team-b']);
    const b = await s.getById('lore:b');
    assert.equal(b?.ecosystem, '*');
    assert.deepEqual(b?.security_scopes, []);
    assert.equal(await s.getById('lore:missing'), null);
    const v = await s.getVectors(['lore:a', 'lore:b', 'lore:missing']);
    assert.deepEqual([...v.keys()].sort(), ['lore:a', 'lore:b']);
    for (const [k, deg] of [['lore:a', 0], ['lore:b', 30]] as const) {
        const got = v.get(k)!;
        const want = Array.from(Float32Array.from(at(deg)));
        assert.deepEqual(got, want, `${k}: stored embedding must round-trip exactly as float32`);
    }
});

await test('searchByVectors: scope-labelled rows are hidden per key from an actor without the scope, shown to one with it', async () => {
    const s = await open('pg-gate-vs-scopes');
    await s.bulkAddPrebuiltRows([row('lore:pub', 0), row('lore:sec', 1, { scopes: ['team-a'] }), row('lore:other', 60)]);
    const qs = [{ key: 'k', vector: at(0) }];
    const none = await s.searchByVectors(qs, { topK: 5, actorScopes: [] });
    assert.deepEqual(ids(none.get('k')!), ['lore:pub', 'lore:other']);
    const withScope = await s.searchByVectors(qs, { topK: 5, actorScopes: ['team-a'] });
    assert.deepEqual(ids(withScope.get('k')!), ['lore:pub', 'lore:sec', 'lore:other']);
    assert.deepEqual(ids(withScope.get('k')!), ids(await s.searchByVector(at(0), { topK: 5, actorScopes: ['team-a'] })));
});

await test('searchByVectors: another workspace in the same table never leaks in; history snapshots and tombstones are excluded', async () => {
    const a = await open('pg-gate-vs-iso-a');
    const b = await open('pg-gate-vs-iso-b');
    await a.bulkAddPrebuiltRows([row('lore:a1', 0), row('lore:a2', 20)]);
    await b.bulkAddPrebuiltRows([row('lore:b1', 0), row('lore:b2', 1)]);
    // history: tombstoning snapshots the pre-tombstone row (non-canonical, SAME vector) and marks the canonical one.
    await a.tombstone('lore:a2', 'test');
    const out = await a.searchByVectors([{ key: 'q', vector: at(20) }], { topK: 10 });
    const got = ids(out.get('q')!);
    assert.deepEqual(got, ['lore:a1'], `only the live canonical row may come back (no foreign rows, no snapshot, no tombstone), got ${got}`);
});

await test('searchByVectors: 300 queries in one call - every key answered, results equal the single-query path', async () => {
    const s = await open('pg-gate-vs-large');
    await s.bulkAddPrebuiltRows(Array.from({ length: 120 }, (_, i) => row(`lore:n${i}`, i * 3)));
    const qs = Array.from({ length: 300 }, (_, i) => ({ key: `q${i}`, vector: at((i * 7) % 360) }));
    const batch = await s.searchByVectors(qs, { topK: 4 });
    assert.equal(batch.size, 300);
    for (const k of [0, 1, 150, 299]) {
        const single = await s.searchByVector(qs[k]!.vector, { topK: 4 });
        assert.deepEqual(ids(batch.get(`q${k}`)!), ids(single), `q${k}`);
        assert.equal(batch.get(`q${k}`)!.length, 4);
    }
    // descending score within each key
    for (const hits of batch.values()) for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1]!.score >= hits[i]!.score - 1e-9);
});

await test("searchByVectors columns:'link': same ids, order, scores, ecosystem and scopes as full rows, without the text", async () => {
    const s = await open('pg-gate-vs-link-columns');
    await s.bulkAddPrebuiltRows([
        row('lore:a', 0, { ecosystem: 'eco-x', scopes: ['team-a'] }), row('lore:b', 10, { ecosystem: 'eco-x' }), row('lore:c', 20), row('lore:d', 40, { ecosystem: 'eco-y' }),
    ]);
    const qs = [{ key: 'k1', vector: at(0) }, { key: 'k2', vector: at(35) }];
    for (const filter of [undefined, { ecosystem: 'eco-x' }] as const) {
        for (const actorScopes of [undefined, [] as string[], ['team-a']]) {
            const full = await s.searchByVectors(qs, { topK: 4, ...(filter ? { filter } : {}), ...(actorScopes ? { actorScopes } : {}) });
            const link = await s.searchByVectors(qs, { topK: 4, columns: 'link', ...(filter ? { filter } : {}), ...(actorScopes ? { actorScopes } : {}) });
            assert.deepEqual([...link.keys()], [...full.keys()]);
            for (const [k, hits] of full) {
                const narrow = link.get(k)!;
                assert.deepEqual(narrow.map((h) => [h.id, h.score, h.metadata.ecosystem, h.metadata.security_scopes]), hits.map((h) => [h.id, h.score, h.metadata.ecosystem, h.metadata.security_scopes]), `${k} ${JSON.stringify({ filter, actorScopes })}`);
                for (const h of narrow) assert.equal(h.text, '', 'the narrow form must not fetch the row text');
            }
        }
    }
});

await cleanupGateWorkspaces(pool);
await closeGatePool(pool);
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

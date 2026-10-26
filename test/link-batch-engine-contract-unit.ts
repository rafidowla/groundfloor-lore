#!/usr/bin/env tsx
/**
 * test/link-batch-engine-contract-unit.ts - link-on-arrival: the two optional engine capabilities the
 * Linker uses, as a contract any engine (SQLite today, Postgres next) must meet.
 *
 *   addInferredEdgesBatch(edges)   graph side: ONE transaction, upsert that only refreshes rows that are
 *                                  themselves `inferred`; caller edges are never touched; edges whose endpoint
 *                                  is gone are skipped and counted; replay is idempotent; counts add up.
 *   searchByVectors(queries, opts) verbatim side: many stored-vector queries in one call, results keyed by the
 *                                  caller's key, each identical to the single-query searchByVector; filter and
 *                                  topK honoured.
 *   capability absence             DataplaneGraph (cloud) has no batch method, so the Linker must be able to
 *                                  detect that and fall back (asserted in test/link-linker-unit.ts).
 *
 * To run the same cases against another engine, add an entry to `graphEngines` / `verbatimEngines`.
 *
 * Run: npx tsx test/link-batch-engine-contract-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { createGatePool, cleanupGateWorkspaces, closeGatePool, stampGateManifest } from './helpers/testPostgres.js';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import type { BatchEdgeResult, InferredEdge, InferredEdgeBatchCapable, BatchKnnCapable } from '../packages/lore/src/link/linkTypes.js';
import type { EmbeddingProvider, VerbatimSearchResult } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const REL = 'semantic_neighbor';
const edge = (a: string, b: string, score = 0.8): InferredEdge => ({ sourceId: a, targetId: b, relation: REL, confidenceScore: score });

// ───────────────────────── graph: addInferredEdgesBatch ─────────────────────────
type GraphUnderTest = InferredEdgeBatchCapable & {
    upsertNode(n: unknown): Promise<unknown>;
    deleteNode(id: string): Promise<boolean>;
    addEdge(e: { sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }): Promise<void>;
    getEdge(s: string, t: string, r: string, o?: { includeProvenance?: boolean; includeInvalidated?: boolean }): Promise<{ confidence?: string; confidenceScore?: number; provenance?: { origin?: string; policyVersion?: string; modelFingerprint?: string; validTo?: string | null } } | null>;
    queryEdges(q: { limit: number; offset: number; relation?: string; includeInvalidated?: boolean }): Promise<unknown[]>;
    invalidateEdges(keys: Array<{ sourceId: string; targetId: string; relation: string }>, at: string): Promise<number>;
};
const graphEngines: Array<{ name: string; open: () => Promise<GraphUnderTest> }> = [
    { name: 'sqlite', open: async () => { const g = new SqliteGraph(mkTmp('lb-g-'), { workspaceId: 'lb' }); await g.initialize(); return g as unknown as GraphUnderTest; } },
];
// Postgres joins the same contract when LORE_PG_URL names a throwaway server; otherwise it is skipped with a reason.
const gatePool = await createGatePool('link-batch-engine-contract');
if (gatePool) {
    await cleanupGateWorkspaces(gatePool);
    let wsSeq = 0;
    graphEngines.push({ name: 'postgres', open: async () => { const g = new PostgresGraph(`pg-gate-lb-${process.pid}-${wsSeq++}`, gatePool); await g.initialize(); return g as unknown as GraphUnderTest; } });
}
const nodeInput = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' });

for (const eng of graphEngines) {
    console.log(`\ngraph - ${eng.name}`);
    const seedNodes = async (g: GraphUnderTest, ids: string[]): Promise<void> => { for (const id of ids) await g.upsertNode(nodeInput(id)); };

    await test('writes every edge in one call and reports written; stored as inferred with the score', async () => {
        const g = await eng.open();
        await seedNodes(g, ['a', 'b', 'c']);
        const r: BatchEdgeResult = await g.addInferredEdgesBatch([edge('a', 'b', 0.9), edge('a', 'c', 0.7)]);
        assert.deepEqual(r, { written: 2, skippedMissingEndpoint: 0, keptExisting: 0 });
        const e = await g.getEdge('a', 'b', REL);
        assert.equal(e?.confidence, 'inferred');
        assert.equal(e?.confidenceScore, 0.9);
    });

    await test('a caller-supplied edge on the same triple is NEVER overwritten (confidence and score kept)', async () => {
        const g = await eng.open();
        await seedNodes(g, ['a', 'b', 'c']);
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL, confidence: 'extracted', confidenceScore: 1 });
        const r = await g.addInferredEdgesBatch([edge('a', 'b', 0.66), edge('a', 'c', 0.7)]);
        assert.deepEqual(r, { written: 1, skippedMissingEndpoint: 0, keptExisting: 1 });
        const kept = await g.getEdge('a', 'b', REL);
        assert.equal(kept?.confidence, 'extracted');
        assert.equal(kept?.confidenceScore, 1);
    });

    await test('an existing INFERRED edge is refreshed (score updated), not duplicated', async () => {
        const g = await eng.open();
        await seedNodes(g, ['a', 'b']);
        await g.addInferredEdgesBatch([edge('a', 'b', 0.7)]);
        const r = await g.addInferredEdgesBatch([edge('a', 'b', 0.85)]);
        assert.equal(r.written, 1);
        assert.equal((await g.getEdge('a', 'b', REL))?.confidenceScore, 0.85);
        assert.equal((await g.queryEdges({ limit: 100, offset: 0, relation: REL })).length, 1);
    });

    await test('replay is idempotent: the same batch twice leaves the same edges', async () => {
        const g = await eng.open();
        await seedNodes(g, ['a', 'b', 'c', 'd']);
        const batch = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
        await g.addInferredEdgesBatch(batch);
        const before = await g.queryEdges({ limit: 100, offset: 0, relation: REL });
        const r = await g.addInferredEdgesBatch(batch);
        assert.equal(r.skippedMissingEndpoint, 0);
        assert.equal(r.keptExisting, 0);
        assert.deepEqual(await g.queryEdges({ limit: 100, offset: 0, relation: REL }), before);
    });

    await test('an edge whose endpoint was deleted is skipped and counted; the rest still land', async () => {
        const g = await eng.open();
        await seedNodes(g, ['a', 'b', 'c']);
        await g.deleteNode('c');
        const r = await g.addInferredEdgesBatch([edge('a', 'b'), edge('a', 'c'), edge('x', 'a')]);
        assert.deepEqual(r, { written: 1, skippedMissingEndpoint: 2, keptExisting: 0 });
        assert.equal(await g.getEdge('a', 'c', REL), null);
    });

    await test('empty batch is a no-op; counts always add up to the input length', async () => {
        const g = await eng.open();
        assert.deepEqual(await g.addInferredEdgesBatch([]), { written: 0, skippedMissingEndpoint: 0, keptExisting: 0 });
        await seedNodes(g, ['a', 'b']);
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL, confidence: 'extracted' });
        const batch = [edge('a', 'b'), edge('a', 'zz'), edge('b', 'a')];
        const r = await g.addInferredEdgesBatch(batch);
        assert.equal(r.written + r.keptExisting + r.skippedMissingEndpoint, batch.length);
    });

    await test('a batch larger than the endpoint-lookup chunk (>400 distinct ids) is still one correct write', async () => {
        const g = await eng.open();
        const ids = Array.from({ length: 450 }, (_, i) => `n${i}`);
        await seedNodes(g, ids);
        const edges = ids.slice(1).map((id, i) => edge(ids[i]!, id, 0.75));
        const r = await g.addInferredEdgesBatch(edges);
        assert.deepEqual(r, { written: 449, skippedMissingEndpoint: 0, keptExisting: 0 });
    });

    await test('a triple repeated inside one batch collapses to its last occurrence; counts still add up', async () => {
        const g = await eng.open();
        await seedNodes(g, ['a', 'b']);
        const r = await g.addInferredEdgesBatch([edge('a', 'b', 0.5), edge('a', 'b', 0.9)]);
        assert.equal(r.written + r.keptExisting + r.skippedMissingEndpoint, 2);
        assert.equal((await g.getEdge('a', 'b', REL))?.confidenceScore, 0.9);
    });

    await test('invalidateEdges is soft: the edge leaves default reads, stays readable with includeInvalidated, is never deleted', async () => {
        const g = await eng.open();
        await seedNodes(g, ['a', 'b', 'c']);
        await g.addInferredEdgesBatch([edge('a', 'b'), edge('a', 'c')]);
        const at = '2026-10-23T12:00:00.000Z';
        assert.equal(await g.invalidateEdges([{ sourceId: 'a', targetId: 'b', relation: REL }, { sourceId: 'x', targetId: 'y', relation: REL }], at), 1);
        assert.equal(await g.getEdge('a', 'b', REL), null);
        assert.equal((await g.queryEdges({ limit: 100, offset: 0, relation: REL })).length, 1);
        const kept = await g.getEdge('a', 'b', REL, { includeInvalidated: true, includeProvenance: true });
        assert.equal(new Date(kept!.provenance!.validTo!).toISOString(), at);
        assert.equal((await g.queryEdges({ limit: 100, offset: 0, relation: REL, includeInvalidated: true })).length, 2);
        assert.equal(await g.invalidateEdges([{ sourceId: 'a', targetId: 'b', relation: REL }], '2026-10-24T00:00:00.000Z'), 0, 'already invalid: not counted, original valid_to kept');
        assert.equal(await g.invalidateEdges([], at), 0);
    });

    await test('re-asserting an invalidated inferred edge (batch upsert) makes it live again', async () => {
        const g = await eng.open();
        await seedNodes(g, ['a', 'b']);
        await g.addInferredEdgesBatch([edge('a', 'b', 0.7)]);
        await g.invalidateEdges([{ sourceId: 'a', targetId: 'b', relation: REL }], '2026-10-23T12:00:00.000Z');
        assert.equal(await g.getEdge('a', 'b', REL), null);
        const r = await g.addInferredEdgesBatch([edge('a', 'b', 0.8)]);
        assert.equal(r.written, 1);
        const e = await g.getEdge('a', 'b', REL, { includeProvenance: true });
        assert.equal(e?.confidenceScore, 0.8);
        assert.equal(e?.provenance?.validTo, null);
        assert.equal(e?.provenance?.origin, 'link_on_arrival');
    });
}

await test('cloud engine (Dataplane) exposes no batch method: capability must be detected, not assumed', () => {
    assert.equal(typeof (DataplaneGraph.prototype as unknown as Partial<InferredEdgeBatchCapable>).addInferredEdgesBatch, 'undefined');
});

// ───────────────────────── verbatim: searchByVectors ─────────────────────────
const DIM = 4;
class NoEmbed implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'link-contract-none'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { throw new Error('the Linker path must never embed'); }
    async embedQuery(): Promise<number[]> { throw new Error('the Linker path must never embed'); }
    async embedDocument(): Promise<number[]> { throw new Error('the Linker path must never embed'); }
}
/** Unit vector at `deg` degrees in a plane: cosine between two = cos(delta). */
const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180), 0, 0];
const row = (id: string, deg: number, ecosystem = '*') => ({
    id, label: id, text: `text ${id}`, type: 'note', project: 'p', ecosystem, security_scopes: [] as string[],
    vector: at(deg), contentHash: `h-${id}`, updatedAt: '2026-10-23T00:00:00.000Z',
});

type VerbatimUnderTest = BatchKnnCapable & {
    bulkAddPrebuiltRows(rows: unknown[]): Promise<unknown>;
    searchByVector(v: number[], o?: { topK?: number; filter?: Record<string, unknown> }): Promise<VerbatimSearchResult[]>;
    getById(id: string): Promise<{ ecosystem?: string; security_scopes?: string[] } | null>;
    getByIds?(ids: string[], opts?: { columns?: 'full' | 'link' }): Promise<Map<string, { ecosystem?: string; security_scopes?: string[] }>>;
};
const verbatimEngines: Array<{ name: string; open: () => Promise<VerbatimUnderTest> }> = [
    { name: 'sqlite', open: async () => { const s = new SqliteVerbatimStore(mkTmp('lb-v-'), new NoEmbed()); await s.initialize(); return s as unknown as VerbatimUnderTest; } },
];
// Postgres: real PostgresVerbatimStore against LORE_PG_URL (the dedicated lore_gate database; each case gets its own
// pg-gate-link-* workspace). Skips with a printed reason when LORE_PG_URL is unset, like the other engine contracts.
const pgPool = await createGatePool('link-batch/postgres');
if (pgPool) {
    await cleanupGateWorkspaces(pgPool);
    let n = 0;
    verbatimEngines.push({
        name: 'postgres',
        open: async () => {
            const base = mkTmp('lb-pgv-');
            stampGateManifest(base, 'link-contract-none', DIM);
            const s = new PostgresVerbatimStore(base, pgPool, `pg-gate-link-${process.pid}-${n++}`, new NoEmbed());
            await s.initialize();
            return s as unknown as VerbatimUnderTest;
        },
    });
}

for (const eng of verbatimEngines) {
    console.log(`\nverbatim - ${eng.name}`);
    const seeded = async (): Promise<VerbatimUnderTest> => {
        const s = await eng.open();
        await s.bulkAddPrebuiltRows([row('lore:a', 0), row('lore:b', 10), row('lore:c', 40), row('lore:d', 90, 'eco-x'), row('lore:e', 5, 'eco-x')]);
        return s;
    };
    const ids = (hits: VerbatimSearchResult[]): string[] => hits.map((h) => h.id);

    await test('results are keyed by the caller key and equal the single-query results, best first', async () => {
        const s = await seeded();
        const qs = [{ key: 'k1', vector: at(0) }, { key: 'k2', vector: at(90) }];
        const batch = await s.searchByVectors(qs, { topK: 3 });
        assert.deepEqual([...batch.keys()].sort(), ['k1', 'k2']);
        for (const q of qs) {
            const single = await s.searchByVector(q.vector, { topK: 3 });
            assert.deepEqual(ids(batch.get(q.key)!), ids(single));
            assert.deepEqual(batch.get(q.key)!.map((h) => Math.round(h.score * 1e4)), single.map((h) => Math.round(h.score * 1e4)));
        }
        assert.equal(batch.get('k1')![0]!.id, 'lore:a');
        assert.ok(batch.get('k1')![0]!.score >= batch.get('k1')![1]!.score);
    });

    await test('topK bounds every query independently', async () => {
        const s = await seeded();
        const out = await s.searchByVectors([{ key: 'x', vector: at(0) }, { key: 'y', vector: at(45) }], { topK: 2 });
        assert.equal(out.get('x')!.length, 2);
        assert.equal(out.get('y')!.length, 2);
    });

    await test('the metadata filter applies to the whole batch (ecosystem confinement)', async () => {
        const s = await seeded();
        const out = await s.searchByVectors([{ key: 'x', vector: at(0) }], { topK: 5, filter: { ecosystem: 'eco-x' } });
        assert.ok(ids(out.get('x')!).length > 0);
        assert.ok(ids(out.get('x')!).every((id) => id === 'lore:d' || id === 'lore:e'), `got ${ids(out.get('x')!)}`);
    });

    await test("getByIds: id -> row for every canonical row, absent for a missing id, same ecosystem/scopes as getById, in both column modes", async () => {
        const s = await seeded();
        if (!s.getByIds) { console.log('  (no getByIds on this engine: the linker falls back to per-node getById)'); return; }
        const getByIds = s.getByIds.bind(s);
        const want = ['lore:a', 'lore:d', 'lore:e', 'lore:missing', 'lore:a'];
        for (const columns of ['link', 'full'] as const) {
            const got = await getByIds(want, { columns });
            assert.deepEqual([...got.keys()].sort(), ['lore:a', 'lore:d', 'lore:e']);
            for (const id of got.keys()) {
                const one = await s.getById(id);
                assert.equal(got.get(id)!.ecosystem, one!.ecosystem, `${id} ecosystem`);
                assert.deepEqual(got.get(id)!.security_scopes, one!.security_scopes, `${id} scopes`);
            }
        }
        assert.equal((await getByIds([], { columns: 'link' })).size, 0);
    });

    await test('empty query list returns an empty map; the store never calls the embedder', async () => {
        const s = await seeded(); // NoEmbed throws if anything embeds
        assert.equal((await s.searchByVectors([], { topK: 3 })).size, 0);
        assert.ok((await s.searchByVectors([{ key: 'q', vector: at(1) }], { topK: 1 })).get('q')!.length === 1);
    });
}

if (pgPool) { await cleanupGateWorkspaces(pgPool); await closeGatePool(pgPool); }
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
if (gatePool) { await cleanupGateWorkspaces(gatePool); await closeGatePool(gatePool); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

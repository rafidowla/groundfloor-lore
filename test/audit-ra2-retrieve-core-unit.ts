#!/usr/bin/env tsx
/**
 * audit-ra2-retrieve-core-unit.ts — Retrieval Unification P1.
 *
 * Pins the shared retrieve() core's contract: hybrid semantic+BM25 fusion with
 * correct `matchedBy` provenance + `score`, mode variants, keyword fallback,
 * graph traversal, tags filter, token-budget truncation, the raw-query rule
 * (D3 — no preprocessing), and the verbatim freshness signal. Fully mocked
 * context (no DB) so it's fast + deterministic.
 */

import assert from 'node:assert/strict';
import { retrieve, type RetrieveContext, type RetrieveOutcome, type RetrievalResult } from '../packages/lore/src/recall/retrieve.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type Node = { id: string; type: string; label: string; content: string; tags: string[]; project: string; ecosystem: string; updatedAt: string; status?: string };
const node = (id: string, over: Partial<Node> = {}): Node => ({
    id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'w', ecosystem: '*', updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

interface MockCfg {
    verbatimCount?: number;
    semantic?: Array<{ id: string; score?: number }>;
    bm25?: Array<{ id: string; score?: number }>;
    nodes?: Record<string, Node>;          // graph store keyed by stripped id
    searchHits?: Node[];                    // graph.search() result
    traverse?: Record<string, Array<{ node: Node; depth: number }>>;
}

function mockCtx(cfg: MockCfg): {
    ctx: RetrieveContext;
    calls: { search: string[]; semantic: string[]; bm25: string[]; semanticFilters: unknown[]; bm25Filters: unknown[] };
} {
    const calls = { search: [] as string[], semantic: [] as string[], bm25: [] as string[], semanticFilters: [] as unknown[], bm25Filters: [] as unknown[] };
    const graph = {
        async search(q: string) { calls.search.push(q); return (cfg.searchHits ?? []) as never; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = cfg.nodes?.[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse(id: string) { return (cfg.traverse?.[id] ?? []) as never; },
        // intentionally NO stampAccessTimes → ensureAccessTracker no-ops.
    };
    const ctx = {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return cfg.verbatimCount ?? 0; },
                async verbatimSearch(q: string, _n: number, filter?: unknown) { calls.semantic.push(q); calls.semanticFilters.push(filter); return (cfg.semantic ?? []) as never; },
                async verbatimBm25Search(q: string, _n: number, filter?: unknown) { calls.bm25.push(q); calls.bm25Filters.push(filter); return { hits: cfg.bm25 ?? [], ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
    return { ctx, calls };
}

const byId = (out: RetrieveOutcome, id: string): RetrievalResult | undefined =>
    out.results.find((r) => r.node.id === id);

console.log('RA2 — shared retrieve() core');

await test('hybrid: semantic + BM25 fused; matchedBy reflects which list(s) found each', async () => {
    const { ctx } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:a', score: 0.9 }, { id: 'lore:b', score: 0.8 }],
        bm25: [{ id: 'lore:b', score: 5 }, { id: 'lore:c', score: 4 }],
        nodes: { a: node('a'), b: node('b'), c: node('c') },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    assert.deepEqual(out.results.map((r) => r.node.id).sort(), ['a', 'b', 'c']);
    assert.deepEqual(byId(out, 'a')!.matchedBy.sort(), ['semantic']);
    assert.deepEqual(byId(out, 'b')!.matchedBy.sort(), ['bm25', 'semantic'], 'b was in BOTH lists');
    assert.deepEqual(byId(out, 'c')!.matchedBy.sort(), ['bm25']);
    assert.ok(out.results.every((r) => typeof r.score === 'number'), 'every result has a score');
    assert.equal(out.meta.sourcesConsulted, 2);
    assert.equal(out.meta.verbatimConsulted, true);
    assert.equal(out.meta.topScore, 0.9);
});

await test('semantic mode: only the vector search runs; matchedBy=semantic', async () => {
    const { ctx, calls } = mockCtx({ verbatimCount: 1, semantic: [{ id: 'lore:a', score: 0.7 }], nodes: { a: node('a') } });
    const out = await retrieve(ctx, 'q', { workspace: 'w', mode: 'semantic', depth: 0 });
    assert.deepEqual(byId(out, 'a')!.matchedBy, ['semantic']);
    assert.equal(calls.bm25.length, 0, 'BM25 not called in semantic mode');
});

await test('keyword fallback: no vector index → graph.search, matchedBy=keyword', async () => {
    const { ctx, calls } = mockCtx({ verbatimCount: 0, searchHits: [node('k1'), node('k2')] });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    assert.deepEqual(out.results.map((r) => r.node.id).sort(), ['k1', 'k2']);
    assert.deepEqual(byId(out, 'k1')!.matchedBy, ['keyword']);
    assert.equal(out.meta.verbatimConsulted, false, 'freshness signal: vector index not consulted');
    assert.equal(out.meta.sourcesConsulted, 1);
    assert.equal(calls.semantic.length, 0, 'no vector search when count is 0');
});

await test('traversal (depth=1): neighbours surface as matchedBy=traversal at depth 1', async () => {
    const { ctx } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:s', score: 0.9 }],
        bm25: [{ id: 'lore:s', score: 1 }],
        nodes: { s: node('s') },
        traverse: { s: [{ node: node('n1'), depth: 1 }] },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 1 });
    const seed = byId(out, 's')!; const neigh = byId(out, 'n1')!;
    assert.equal(seed.depth, 0); assert.equal(neigh.depth, 1);
    assert.deepEqual(neigh.matchedBy, ['traversal']);
    assert.equal(neigh.source, 'via:s');
    assert.ok(seed.score > neigh.score, 'seed outranks its traversal neighbour');
    assert.equal(out.meta.directMatches, 1);
});

await test('depth=0 does NOT traverse (the `search` preset)', async () => {
    const { ctx } = mockCtx({ verbatimCount: 1, semantic: [{ id: 'lore:s', score: 0.9 }], bm25: [{ id: 'lore:s', score: 1 }], nodes: { s: node('s') }, traverse: { s: [{ node: node('n1'), depth: 1 }] } });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    assert.equal(out.results.length, 1, 'only the seed, no neighbours');
    assert.equal(byId(out, 'n1'), undefined);
});

await test('tags filter keeps only nodes carrying ALL tags', async () => {
    const { ctx } = mockCtx({
        verbatimCount: 0,
        searchHits: [node('m1', { tags: ['x', 'y'] }), node('m2', { tags: ['x'] })],
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, tags: ['x', 'y'] });
    assert.deepEqual(out.results.map((r) => r.node.id), ['m1'], 'm2 lacks tag y');
});

await test('token budget truncates + reports dropped count', async () => {
    const big = 'z'.repeat(4000); // ~1000 tokens each
    const { ctx } = mockCtx({ verbatimCount: 0, searchHits: [node('b1', { content: big }), node('b2', { content: big }), node('b3', { content: big })] });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, maxTokens: 1500 });
    assert.ok(out.meta.truncated, 'truncated');
    assert.ok(out.meta.droppedCount > 0, 'dropped some');
    assert.equal(out.meta.totalMatched, 3, 'totalMatched is pre-truncation');
});

await test('D3: the query is passed RAW to every search (no normalization)', async () => {
    const { ctx, calls } = mockCtx({ verbatimCount: 1, semantic: [], bm25: [], searchHits: [node('a')] });
    const raw = '  WeiRD CaSe  ?!  ';
    await retrieve(ctx, raw, { workspace: 'w', depth: 0 });
    assert.equal(calls.semantic[0], raw, 'verbatimSearch got the raw query');
    assert.equal(calls.bm25[0], raw, 'bm25 got the raw query');
    assert.equal(calls.search[0], raw, 'graph.search got the raw query (no trim/lowercase in core)');
});

await test('empty result set returns clean meta', async () => {
    const { ctx } = mockCtx({ verbatimCount: 0, searchHits: [] });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 1 });
    assert.equal(out.results.length, 0);
    assert.equal(out.meta.totalMatched, 0);
    assert.equal(out.meta.directMatches, 0);
});

await test('ecosystem scoping: the vector seed pass must not leak cross-ecosystem hits (regression)', async () => {
    // Reproduces a confirmed leak: retrieve()'s semantic/BM25 seed pass took
    // no ecosystem argument, so once a workspace had real vector data
    // (verbatimConsulted=true, the normal case) EVERY hit from ANY ecosystem
    // survived to the result set — only the keyword fallback (which never
    // runs once vector data exists) applied the ecosystem filter. Two
    // tenants sharing one workspace via `ecosystem` scoping got each other's
    // data back from recall().
    const { ctx } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:mine', score: 0.9 }, { id: 'lore:theirs', score: 0.8 }],
        bm25: [{ id: 'lore:mine', score: 5 }, { id: 'lore:theirs', score: 4 }],
        nodes: {
            mine: node('mine', { ecosystem: 'tenant-a' }),
            theirs: node('theirs', { ecosystem: 'tenant-b' }),
        },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'tenant-a' });
    assert.deepEqual(out.results.map((r) => r.node.id), ['mine'], 'only tenant-a\'s own node — tenant-b must not leak in');
    assert.equal(byId(out, 'theirs'), undefined, 'the other tenant\'s node must be filtered out, not just deprioritized');
});

await test('ecosystem scoping: the seed QUERY itself is scoped, not just filtered after (crowding-out fix)', async () => {
    // The post-hydration filter above stops WRONG-ecosystem nodes from being
    // returned, but on its own it can't stop them from taking up space in the
    // seed store's fixed-size top-K window as a shared workspace fills with
    // other ecosystems' data — confirmed via the LongMemEval benchmark: raw
    // candidate count for one ecosystem fell from 150 to single digits, and
    // seed latency grew ~15x, purely from OTHER ecosystems' data accumulating
    // in the same workspace. The real fix pushes the ecosystem down into the
    // store query itself; this test proves that filter is actually reaching
    // the store call, not just decorating the post-filter step.
    //
    // The FIRST call is the assertion that matters. A trailing `undefined` is
    // the deliberate bounded top-up (retrieve.ts `seedWithEcosystemTopUp`):
    // this fixture returns 1 hit for a 40-row window, so the scoped query
    // under-delivers and the unfiltered re-query runs once. That exists
    // because the pushdown matches the VERBATIM row's ecosystem metadata while
    // the authoritative value is on the GRAPH node — when the two disagree
    // (two bulk write paths used to stamp a literal '*') a pushdown-only
    // design silently deletes real results. Correctness is unchanged: the
    // post-hydration graph filter still decides, which the leak regression
    // test above and the '*'-node test below both pin.
    const { ctx, calls } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:mine', score: 0.9 }],
        bm25: [{ id: 'lore:mine', score: 5 }],
        nodes: { mine: node('mine', { ecosystem: 'tenant-a' }) },
    });
    await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'tenant-a' });
    assert.deepEqual(calls.semanticFilters[0], { ecosystem: 'tenant-a' }, 'semantic seed query must be scoped to the requested ecosystem');
    assert.deepEqual(calls.bm25Filters[0], { ecosystem: 'tenant-a' }, 'bm25 seed query must be scoped to the requested ecosystem');
    assert.ok(calls.semanticFilters.length <= 2, `at most one unfiltered top-up; saw ${calls.semanticFilters.length} semantic queries`);
    assert.ok(calls.bm25Filters.length <= 2, `at most one unfiltered top-up; saw ${calls.bm25Filters.length} bm25 queries`);
});

await test('ecosystem scoping: crossProject/no-ecosystem does NOT restrict the seed query (search-everything stays unscoped)', async () => {
    const { ctx, calls } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:a', score: 0.9 }],
        bm25: [{ id: 'lore:a', score: 5 }],
        nodes: { a: node('a') },
    });
    await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
    assert.deepEqual(calls.semanticFilters, [undefined], 'no ecosystem requested → seed query stays unscoped');
    assert.deepEqual(calls.bm25Filters, [undefined]);
});

await test("ecosystem scoping: a node tagged ecosystem:'*' IS visible to a specific-ecosystem query", async () => {
    // SETTLED (see core/ecosystemMatch.ts, and test/r3-ecosystem-settlement-unit.ts).
    //
    // This assertion used to be the reverse, on a strict-equality reading
    // justified as "parity with the keyword path's `n.ecosystem = $ecosystem`".
    // That reading was incompatible with `engines/reconnect.ts`
    // `ecosystemConfinement` and `supersessionCandidates.ts`, which both read
    // '*' as a WILDCARD — and it lost, because '*' is what the WRITE side
    // produces: `postNode.ts` hardcodes it when `ecosystem` is omitted,
    // `normaliseBulkNodeScope` normalises unset to it, and it is the
    // `LoreNode.ecosystem` column DEFAULT. Under the strict reading, on any
    // install where `register_project` set a concrete ecosystem, EVERY node
    // written without an explicit ecosystem was invisible to its own owner's
    // recall — silently, with no escape hatch on the search surfaces.
    //
    // The keyword-path predicates were widened to match (localGraphReads,
    // surrealGraphReads, arcadeGraphReads and the two *Directed siblings), so
    // "parity with the keyword path" still holds — at the settled meaning.
    // Two CONCRETE, different ecosystems are still kept apart; the test below
    // and r3-ecosystem-settlement-unit.ts pin that.
    const { ctx } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:global', score: 0.9 }],
        bm25: [{ id: 'lore:global', score: 5 }],
        nodes: { global: node('global', { ecosystem: '*' }) },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'tenant-a' });
    assert.deepEqual(out.results.map((r) => r.node.id), ['global'], "a '*'/unset node is UNSCOPED, not a distinct ecosystem that matches nothing");
});

await test('ecosystem scoping: two CONCRETE ecosystems are still isolated', async () => {
    // The other half of the settlement — the wildcard reading must not be a
    // switch-off of the boundary.
    const { ctx } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:theirs', score: 0.9 }],
        bm25: [{ id: 'lore:theirs', score: 5 }],
        nodes: { theirs: node('theirs', { ecosystem: 'tenant-b' }) },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'tenant-a' });
    assert.equal(out.results.length, 0, "a node naming a DIFFERENT concrete ecosystem must never appear");
});

await test('crossProject/ecosystem="*" is unaffected (search-everything still works)', async () => {
    const { ctx } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:a', score: 0.9 }, { id: 'lore:b', score: 0.8 }],
        bm25: [{ id: 'lore:a', score: 5 }, { id: 'lore:b', score: 4 }],
        nodes: { a: node('a', { ecosystem: 'tenant-a' }), b: node('b', { ecosystem: 'tenant-b' }) },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, crossProject: true });
    assert.deepEqual(out.results.map((r) => r.node.id).sort(), ['a', 'b'], 'crossProject still returns both ecosystems');
});

await test('cross-workspace ("*") fails loud in the core (P1 scope)', async () => {
    const { ctx } = mockCtx({});
    await assert.rejects(() => retrieve(ctx, 'q', { workspace: '*' }), /cross-workspace|not yet/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

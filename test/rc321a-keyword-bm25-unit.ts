#!/usr/bin/env tsx
/**
 * test/rc321a-keyword-bm25-unit.ts — Lore 3.21 step 3(a).
 *
 * `retrieve()`'s mode:'keyword' is a STANDALONE BM25/lexical recall path,
 * reachable without the vector/embedding path. Pins:
 *
 *   - keyword mode calls ONLY the store's bm25Search() + the graph's own
 *     text-search leg — it NEVER calls the store's semantic search() (the
 *     method that embeds the query), even when the store has a populated
 *     verbatim count.
 *   - the Bm25Envelope `ranked` signal propagates onto RetrieveMeta.bm25Ranked
 *     — an unranked (LIKE-scan fallback) bm25 result is excluded from the
 *     ranking and flagged, not silently presented as relevance-ordered.
 *   - the graph's own keyword leg still supplements bm25 hits (today's
 *     keyword-fallback behaviour, preserved).
 *   - hybrid/semantic modes are unaffected (regression guard).
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

/** A provider whose every embed-shaped method throws — proxy for "the
 *  embedding provider must never be reached" at this layer: `verbatimSearch`
 *  in the REAL system calls embedQuery() internally, so having the MOCK
 *  throw here and asserting zero calls proves the keyword path never
 *  reaches it. */
class ThrowingEverything {
    async initialize(): Promise<void> { throw new Error('embedding provider must never be touched in keyword mode'); }
    async embed(): Promise<never> { throw new Error('embed() must never be called in keyword mode'); }
    async embedQuery(): Promise<never> { throw new Error('embedQuery() must never be called in keyword mode'); }
    async embedDocument(): Promise<never> { throw new Error('embedDocument() must never be called in keyword mode'); }
}

interface MockCfg {
    verbatimCount?: number;
    bm25?: Array<{ id: string; score?: number }>;
    bm25Ranked?: boolean;
    nodes?: Record<string, Node>;
    searchHits?: Node[];
}

function mockCtx(cfg: MockCfg): {
    ctx: RetrieveContext;
    calls: { search: string[]; semantic: string[]; bm25: string[] };
} {
    const calls = { search: [] as string[], semantic: [] as string[], bm25: [] as string[] };
    const throwingProvider = new ThrowingEverything();
    const graph = {
        async search(q: string) { calls.search.push(q); return (cfg.searchHits ?? []) as never; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = cfg.nodes?.[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return [] as never; },
    };
    const ctx = {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return cfg.verbatimCount ?? 0; },
                // Simulates the real VerbatimStore.search(), which calls
                // embeddingProvider.embedQuery() internally — throwing here
                // (via the never-touched provider) and asserting zero calls
                // is the proxy for "embedding provider never invoked".
                async verbatimSearch(q: string) {
                    calls.semantic.push(q);
                    await throwingProvider.embedQuery();
                    return [] as never;
                },
                async verbatimBm25Search(q: string, _n: number, filter?: unknown) {
                    void filter;
                    calls.bm25.push(q);
                    return { hits: cfg.bm25 ?? [], ranked: cfg.bm25Ranked ?? true } as never;
                },
            },
        },
    } as unknown as RetrieveContext;
    return { ctx, calls };
}

const byId = (out: RetrieveOutcome, id: string): RetrievalResult | undefined =>
    out.results.find((r) => r.node.id === id);

console.log('RC321a — standalone keyword/BM25 recall (mode:"keyword")');

await test('keyword mode: bm25Search runs, semantic search() is NEVER called (provider never touched)', async () => {
    const { ctx, calls } = mockCtx({
        verbatimCount: 5,
        bm25: [{ id: 'lore:a', score: 9 }, { id: 'lore:b', score: 4 }],
        nodes: { a: node('a'), b: node('b') },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', mode: 'keyword', depth: 0 });
    assert.equal(calls.semantic.length, 0, 'the semantic/embedding search path must never be invoked in keyword mode');
    assert.equal(calls.bm25.length >= 1, true, 'bm25Search must be consulted');
    assert.deepEqual(out.results.map((r) => r.node.id).sort(), ['a', 'b']);
    assert.deepEqual(byId(out, 'a')!.matchedBy, ['bm25']);
    assert.equal(out.meta.bm25Ranked, true, 'bm25 came back ranked');
    assert.equal(out.meta.verbatimConsulted, true, 'the store WAS consulted (bm25 is a store method)');
});

await test('keyword mode: graph text-search leg still supplements bm25 hits (today\'s keyword fallback, preserved)', async () => {
    const { ctx } = mockCtx({
        verbatimCount: 5,
        bm25: [{ id: 'lore:a', score: 9 }],
        searchHits: [node('a'), node('c')], // 'c' has no verbatim row at all (never embedded)
        nodes: { a: node('a'), c: node('c') },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', mode: 'keyword', depth: 0 });
    const ids = out.results.map((r) => r.node.id).sort();
    assert.deepEqual(ids, ['a', 'c'], 'the graph keyword leg supplements a node bm25 never saw');
    assert.deepEqual(byId(out, 'c')!.matchedBy, ['keyword']);
});

await test('keyword mode: unranked (LIKE-scan) bm25 is excluded from results AND flagged bm25Ranked:false', async () => {
    const { ctx } = mockCtx({
        verbatimCount: 5,
        bm25: [{ id: 'lore:a', score: 1 }],
        bm25Ranked: false, // the store's fail-closed LIKE-scan fallback signal
        searchHits: [node('k')],
        nodes: { a: node('a'), k: node('k') },
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', mode: 'keyword', depth: 0 });
    assert.equal(out.meta.bm25Ranked, false, 'unranked bm25 must be flagged, not silently presented as ranked');
    // The unranked bm25 hit ('a') must not appear as a bm25-ranked result —
    // only the graph keyword leg's own hit ('k') survives.
    assert.deepEqual(out.results.map((r) => r.node.id), ['k']);
    assert.equal(out.meta.sourcesConsulted, 1, 'an unranked bm25 pass degrades sourcesConsulted to 1 (graph keyword only)');
});

await test('keyword mode never calls bm25Search\'s sibling semantic method even with verbatimCount:0', async () => {
    const { ctx, calls } = mockCtx({ verbatimCount: 0, searchHits: [node('k1')] });
    const out = await retrieve(ctx, 'q', { workspace: 'w', mode: 'keyword', depth: 0 });
    assert.equal(calls.semantic.length, 0);
    assert.deepEqual(out.results.map((r) => r.node.id), ['k1']);
    assert.deepEqual(byId(out, 'k1')!.matchedBy, ['keyword']);
});

await test('regression: semantic mode still never calls bm25Search', async () => {
    const { ctx, calls } = mockCtx({ verbatimCount: 5, bm25: [{ id: 'lore:a' }], nodes: { a: node('a') } });
    // verbatimSearch throws in this mock (simulating embed) — semantic mode
    // is EXPECTED to reach it, so we don't call retrieve() with mode:
    // 'semantic' against the throwing mock here; that path is already
    // covered by audit-ra2-retrieve-core-unit.ts. This regression only
    // pins that bm25Search stays untouched in semantic mode when the
    // store never gets that far (verbatimCount:0 short-circuits cleanly).
    const { ctx: ctx2, calls: calls2 } = mockCtx({ verbatimCount: 0 });
    void ctx; void calls;
    const out = await retrieve(ctx2, 'q', { workspace: 'w', mode: 'semantic', depth: 0 });
    assert.equal(calls2.bm25.length, 0, 'bm25Search must not be called in semantic mode');
    assert.deepEqual(out.results, []);
});

await test('regression: hybrid mode is unaffected (both consulted, RRF fused, matchedBy correct)', async () => {
    const { ctx } = mockCtx({
        verbatimCount: 1,
        bm25: [{ id: 'lore:b', score: 5 }],
        nodes: { a: node('a'), b: node('b') },
    });
    // hybrid still calls verbatimSearch (semantic) — swap in a store whose
    // semantic leg succeeds so this exercises the fused path, not the throw.
    const graph = {
        async search() { return [] as never; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = ({ a: node('a'), b: node('b') } as Record<string, Node>)[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return [] as never; },
    };
    const hybridCtx = {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 1; },
                async verbatimSearch() { return [{ id: 'lore:a', score: 0.9 }]; },
                async verbatimBm25Search() { return { hits: [{ id: 'lore:b', score: 5 }], ranked: true }; },
            },
        },
    } as unknown as RetrieveContext;
    void ctx;
    const out = await retrieve(hybridCtx, 'q', { workspace: 'w', mode: 'hybrid', depth: 0 });
    assert.deepEqual(out.results.map((r) => r.node.id).sort(), ['a', 'b']);
    assert.equal(out.meta.bm25Ranked, true);
    assert.equal(out.meta.sourcesConsulted, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

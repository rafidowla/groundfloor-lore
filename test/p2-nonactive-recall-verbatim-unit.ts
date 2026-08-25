#!/usr/bin/env tsx
/**
 * p2-nonactive-recall-verbatim-unit.ts — P2 (scalability).
 *
 * Before P2, retrieve() gated the semantic + BM25 seed pass on
 * `graph === bootGraph`, so a recall against ANY non-active workspace had
 * verbatimConsulted=false and fell back to a keyword-only CONTAINS scan — no
 * semantic path. This test drives retrieve() directly against a NON-active
 * workspace and asserts that, when a WorkspaceVerbatimResolver is wired,
 *   1. the TARGET workspace's OWN verbatim store is consulted (its search /
 *      bm25Search / count run, not the boot store's), and
 *   2. meta.verbatimConsulted flips to true and semantic seeds surface, and
 *   3. the BOOT store is NEVER touched for a non-active recall, and
 *   4. with NO resolver, a non-active recall still degrades to keyword
 *      (verbatimConsulted=false) — the pre-P2 confinement-safe behavior.
 *
 * Run: npx tsx test/p2-nonactive-recall-verbatim-unit.ts
 */

import assert from 'node:assert/strict';
import { retrieve, type RetrieveContext } from '../packages/lore/src/recall/retrieve.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type FNode = { id: string; type: string; label: string; content: string; tags: string[]; project: string; status?: string; supersededAt?: string | null };
const mk = (id: string, over: Partial<FNode> = {}): FNode => ({ id, type: 'note', label: id, content: `body ${id}`, tags: ['t'], project: 'wsB', ...over });

// wsB graph knows two nodes; wsB's OWN verbatim store ranks them semantically.
const B_NODES: Record<string, FNode> = { 'b1': mk('b1'), 'b2': mk('b2') };

function makeGraph(nodes: Record<string, FNode>, onKeyword: () => void) {
    return {
        async search(_q: string, _n: number, _ws?: string, _eco?: string, _hidden?: boolean, signals?: { scanCapHit: boolean }) {
            onKeyword();
            if (signals) signals.scanCapHit = false;
            return Object.values(nodes).map((x) => ({ ...x }));
        },
        async getNodesByIds(ids: string[]) { const m = new Map<string, FNode>(); for (const id of ids) { const x = nodes[id]; if (x) m.set(id, { ...x }); } return m; },
        async traverse(_id: string) { return [] as Array<{ node: FNode; depth: number }>; },
        async getNode(id: string) { const x = nodes[id]; return x ? { ...x } : null; },
    };
}

console.log('P2 — non-active workspace recall seeds its OWN verbatim store\n');

await test('non-active recall WITH resolver consults the target workspace verbatim store', async () => {
    const bootGraph = makeGraph({}, () => { /* boot keyword unused here */ });
    let bootKeyword = 0;
    const activeGraph = makeGraph({}, () => { bootKeyword++; });
    void activeGraph;

    let bootVerbatimTouched = 0;
    let wsBSearch = 0, wsBBm25 = 0, wsBCount = 0;
    let wsBKeyword = 0;
    const wsBGraph = makeGraph(B_NODES, () => { wsBKeyword++; });

    const bootStorageClient = {
        async verbatimCount() { bootVerbatimTouched++; return 99; },
        async verbatimSearch() { bootVerbatimTouched++; return [{ id: 'lore:boot-only', score: 0.9 }]; },
        async verbatimBm25Search() { bootVerbatimTouched++; return [{ id: 'lore:boot-only', score: 0.9 }]; },
    };

    const wsBVerbatim = {
        async count() { wsBCount++; return 2; },
        async search(_q: string, _n: number) { wsBSearch++; return [{ id: 'lore:b1', score: 0.8 }, { id: 'lore:b2', score: 0.6 }]; },
        // Bm25Envelope, not a bare array: retrieve() reads `.ranked` to decide
        // whether the bm25 pass counts as a second source. A bare array reads as
        // UNRANKED (fail-closed), which is why this returns the envelope shape.
        async bm25Search(_q: string, _n: number) { wsBBm25++; return { hits: [{ id: 'lore:b2', score: 3 }], ranked: true }; },
    };

    const ctx: RetrieveContext = {
        store: {
            loreGraph: bootGraph as never,
            storageClient: bootStorageClient as never,
            sessionCache: { pushNode() { /* noop */ } } as never,
        } as never,
        graphRegistry: { getOrOpen: async (_ws: string) => wsBGraph, getGraphHandle: async (_ws: string) => wsBGraph } as never,
        workspaceVerbatimResolver: { getOrOpen: async (_ws: string) => wsBVerbatim as never },
    };

    const out = await retrieve(ctx, 'topic', { workspace: 'wsB', mode: 'hybrid', depth: 0, limit: 10 });

    assert.equal(out.meta.verbatimConsulted, true, 'verbatimConsulted must be true for a non-active recall backed by its own store');
    assert.equal(out.meta.sourcesConsulted, 2, 'sources_consulted must report 2 (vector + keyword)');
    assert.ok(wsBCount > 0 && wsBSearch > 0 && wsBBm25 > 0, 'the TARGET (wsB) verbatim store must be counted + semantic + bm25 searched');
    assert.equal(bootVerbatimTouched, 0, 'the BOOT verbatim store must NEVER be touched for a non-active recall');
    // Finding 5.1 changed the contract this assertion used to pin: the keyword
    // scan is no longer dead code gated on an empty semantic window — it runs
    // ONCE per vector-seeded recall as a supplementary seed source (unioned by
    // id, so semantic seeds are never displaced). The P2 property this test
    // exists for is untouched: the scan runs against wsB's OWN graph, never the
    // boot graph/store.
    assert.equal(wsBKeyword, 1, 'keyword supplement runs exactly once, against the TARGET graph');
    assert.equal(bootKeyword, 0, 'the BOOT graph keyword scan must never run for a non-active recall');
    const ids = out.results.map((r) => r.node.id);
    assert.ok(ids.includes('b1') && ids.includes('b2'), `semantic seeds from wsB must surface; got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes('boot-only'), 'a boot-only seed must never leak into a wsB recall');
});

await test('non-active recall WITHOUT resolver degrades to keyword (boot store untouched)', async () => {
    let bootVerbatimTouched = 0;
    let wsBKeyword = 0;
    const wsBGraph = makeGraph(B_NODES, () => { wsBKeyword++; });
    const bootStorageClient = {
        async verbatimCount() { bootVerbatimTouched++; return 99; },
        async verbatimSearch() { bootVerbatimTouched++; return [{ id: 'lore:boot-only', score: 0.9 }]; },
        async verbatimBm25Search() { bootVerbatimTouched++; return [{ id: 'lore:boot-only', score: 0.9 }]; },
    };
    const ctx: RetrieveContext = {
        store: {
            loreGraph: makeGraph({}, () => { /* boot graph unused */ }) as never,
            storageClient: bootStorageClient as never,
            sessionCache: { pushNode() { /* noop */ } } as never,
        } as never,
        graphRegistry: { getOrOpen: async (_ws: string) => wsBGraph, getGraphHandle: async (_ws: string) => wsBGraph } as never,
        // No workspaceVerbatimResolver.
    };
    const out = await retrieve(ctx, 'topic', { workspace: 'wsB', mode: 'hybrid', depth: 0, limit: 10 });
    assert.equal(out.meta.verbatimConsulted, false, 'no resolver → non-active recall must NOT report semantic consultation');
    assert.equal(bootVerbatimTouched, 0, 'the boot store must never be scanned for a non-active recall (confinement)');
    assert.ok(wsBKeyword > 0, 'wsB keyword fallback must run');
    const ids = out.results.map((r) => r.node.id);
    assert.ok(ids.includes('b1') && ids.includes('b2'), `wsB keyword hits must surface; got ${JSON.stringify(ids)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env tsx
/**
 * test/ecosystem-confinement-unit.ts — the ecosystem boundary must hold on the
 * two graph paths that were ignoring it: autolink edge CREATION and recall
 * TRAVERSAL.
 *
 * Ecosystem is an isolation boundary (see CLAUDE.md's local-mode confinement
 * invariant — an app's workspace is its database, and within a workspace
 * `ecosystem` separates otherwise-unrelated node sets). Two paths leaked
 * across it:
 *
 *   B1 — `engines/reconnect.ts` `reconnectOneNode`: the similarity search that
 *        picks autolink candidates ran against the WHOLE workspace vector
 *        index with no filter, so ingest-time autolink drew
 *        `semantic_neighbor` edges BETWEEN ecosystems. The edges are durable,
 *        so this contaminates the graph permanently, not just one query.
 *
 *   B2 — `recall/retrieve.ts`: seeds were ecosystem-filtered (twice — pushed
 *        into the vector query AND re-checked after hydration) but the depth-1
 *        traversal that expands from those seeds filtered only by PERMISSION.
 *        A correctly-scoped seed could therefore pull a different ecosystem's
 *        node into the result set across an edge — including exactly the
 *        cross-ecosystem edges B1 was creating.
 *
 * Both fixes follow retrieve.ts's existing convention: push the scope into the
 * query, then re-check on the way out, with `'*'` meaning search-everything.
 * These tests pin both halves of that on both paths — the query-level filter
 * (so scoping isn't accidentally reduced to a post-filter that still lets
 * other ecosystems crowd out the top-K window) AND the post-filter backstop
 * (so a store whose filter silently degrades can't leak).
 *
 * ─── Round 2 (adversarial review of the fixes above) ─────────────────────
 *
 *   B3 — the B1 fix landed on `reconnectOneNode` ONLY. Its sibling
 *        `reconnectGraph` — the bulk sweep behind first-install background
 *        reconnect, the `reconnect`/`reconsume` tools and
 *        migrateEmbeddingModel — kept searching with NO filter and had no
 *        per-hit check either, so it stayed the LARGER producer of exactly the
 *        cross-ecosystem edges B1 was fixed to stop.
 *
 *   B4 — pushing the filter into the vector query moved scoping from the
 *        GRAPH node's ecosystem (authoritative) to the verbatim ROW's metadata
 *        copy of it. Two bulk write paths stamped a literal '*' into that copy
 *        while the graph node kept the caller's real ecosystem, so the fix
 *        made previously-recallable nodes silently unfindable. Fixed at the
 *        root in the write paths AND made non-fatal in the read path (a
 *        bounded unfiltered top-up when the scoped query under-delivers, with
 *        the post-hydration graph check still deciding).
 *
 * ─── Round 3 (adversarial review of the B4 fix) ──────────────────────────
 *
 *   B5 — the B4 top-up fired only when the scoped query returned FEWER rows
 *        than the requested window. That trigger is backwards: an ecosystem
 *        with a normal amount of correctly-tagged data FILLS the window, so
 *        the top-up never ran and the mismatched rows in that ecosystem stayed
 *        permanently invisible. Only sparse ecosystems — the case that was
 *        never broken — got the backstop. A correctness net cannot be gated on
 *        how full the primary result looked, so the unscoped query is now
 *        unconditional and its union with the scoped one is the CANDIDATE set,
 *        with the post-hydration graph check still the only thing that decides.
 *        The tests below pin the FULL-window case specifically, because that is
 *        the one the conditional version passed by never running.
 *
 * ─── Launch readiness (2026-08-19) ─────────────────────────────────────────
 *
 *   B6'*' — the last B6 test below pinned the PRE-Cluster-5a control flow
 *        ("a '*' recall never gains a keyword scan"). Cluster 5a (c9b2bf1,
 *        Finding 5.1) then made the supplementary keyword scan UNCONDITIONAL
 *        on every vector-seeded recall — deliberately, "and the unscoped
 *        default too" — leaving that expectation stale. It now pins the 5.1
 *        behaviour instead: under '*' the scan widens the result set and
 *        confines nothing.
 *
 *   B9 — every confinement test above runs retrieve()'s DEFAULT (hybrid)
 *        mode. The leak this file documents was originally confirmed against
 *        the default mode only, yet the fix's load-bearing pieces differ per
 *        mode: 'keyword' never consults the verbatim store at all (the
 *        graph.search scan is PRIMARY there), and 'hybrid' fuses the
 *        semantic+BM25 unions via RRF before the same post-hydration filter
 *        runs. B9 pins the combined assertion across ALL THREE modes at
 *        once: one workspace, two same-topic ecosystems, the foreign rows
 *        ranked FIRST by every unscoped seed query, a deliberately degraded
 *        keyword scan, and a cross-ecosystem traversal edge — zero foreign
 *        nodes, both directions, seeds and hops. Verified live against the
 *        real embedded + HTTP-daemon stacks on 2026-08-19 (see
 *        benchmarks/longmemeval/README.md "Confirmed retrieval-scoping bug").
 */

import assert from 'node:assert/strict';
import { reconnectOneNode, reconnectGraph } from '../packages/lore/src/engines/reconnect.js';
import { retrieve, type RetrieveContext } from '../packages/lore/src/recall/retrieve.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

/* ─── B1 fakes: autolink over a shared, multi-ecosystem vector index ──── */

interface Hit { id: string; score: number; metadata: { ecosystem: string } }

/**
 * Vector store holding nodes from TWO ecosystems. `honourFilter: false`
 * simulates a store whose ecosystem filter silently does nothing — that is
 * what the post-filter backstop is for.
 */
function makeVerbatim(hits: Hit[], opts: { honourFilter?: boolean } = {}) {
    const honour = opts.honourFilter ?? true;
    const seen: { filters: unknown[] } = { filters: [] };
    const store = {
        async initialize() { /* no-op */ },
        async store() { /* no-op */ },
        async search(_q: string, _limit: number, filter?: { ecosystem?: string }) {
            seen.filters.push(filter);
            if (honour && filter?.ecosystem) {
                return hits.filter((h) => h.metadata.ecosystem === filter.ecosystem);
            }
            return hits;
        },
    };
    return { store, seen };
}

function makeEdgeRecordingGraph() {
    const edges: Array<{ sourceId: string; targetId: string }> = [];
    const graph = {
        async addEdge(e: { sourceId: string; targetId: string }) { edges.push(e); },
    };
    return { graph, edges };
}

const ALPHA_NODE = {
    id: 'alpha-1', label: 'baking', content: 'the user baked a baguette', tags: [],
    type: 'fact', project: 'shared-ws', ecosystem: 'question-alpha',
};

/** Two same-workspace neighbours: one in the node's own ecosystem, one not. */
const MIXED_HITS: Hit[] = [
    { id: 'lore:alpha-2', score: 0.95, metadata: { ecosystem: 'question-alpha' } },
    { id: 'lore:beta-9', score: 0.99, metadata: { ecosystem: 'question-beta' } },
];

console.log('\nEcosystem confinement — autolink edge creation + recall traversal\n');

await test('B1: autolink pushes the ecosystem filter INTO the candidate search', async () => {
    const { store, seen } = makeVerbatim(MIXED_HITS);
    const { graph } = makeEdgeRecordingGraph();
    await reconnectOneNode(graph as never, store as never, ALPHA_NODE);
    assert.deepEqual(
        seen.filters[0], { ecosystem: 'question-alpha' },
        'candidate search must be scoped at the query, not just post-filtered — otherwise other ecosystems crowd the top-K window',
    );
});

await test('B1: autolink does NOT draw an edge into another ecosystem', async () => {
    const { store } = makeVerbatim(MIXED_HITS);
    const { graph, edges } = makeEdgeRecordingGraph();
    await reconnectOneNode(graph as never, store as never, ALPHA_NODE);
    const endpoints = edges.flatMap((e) => [e.sourceId, e.targetId]);
    assert.ok(!endpoints.includes('beta-9'), `cross-ecosystem edge created: ${JSON.stringify(edges)}`);
});

await test('B1: autolink STILL links within its own ecosystem (not just off)', async () => {
    // Guard against "fixing" the leak by disabling autolink altogether.
    const { store } = makeVerbatim(MIXED_HITS);
    const { graph, edges } = makeEdgeRecordingGraph();
    const res = await reconnectOneNode(graph as never, store as never, ALPHA_NODE);
    const endpoints = edges.flatMap((e) => [e.sourceId, e.targetId]);
    assert.ok(endpoints.includes('alpha-2'), 'same-ecosystem neighbour must still be linked');
    assert.equal(res.added, 1, 'exactly the one same-ecosystem edge');
});

await test('B1: backstop — a store that ignores the filter still cannot leak', async () => {
    const { store } = makeVerbatim(MIXED_HITS, { honourFilter: false });
    const { graph, edges } = makeEdgeRecordingGraph();
    await reconnectOneNode(graph as never, store as never, ALPHA_NODE);
    const endpoints = edges.flatMap((e) => [e.sourceId, e.targetId]);
    assert.ok(!endpoints.includes('beta-9'), 'post-filter must reject the foreign hit the store returned anyway');
    assert.ok(endpoints.includes('alpha-2'), 'same-ecosystem neighbour still linked');
});

await test("B1: ecosystem '*' (unscoped) is left alone — no filter pushed", async () => {
    const { store, seen } = makeVerbatim(MIXED_HITS, { honourFilter: false });
    const { graph, edges } = makeEdgeRecordingGraph();
    await reconnectOneNode(graph as never, store as never, { ...ALPHA_NODE, ecosystem: '*' });
    assert.equal(seen.filters[0], undefined, "'*' must not push an ecosystem filter");
    assert.equal(edges.length, 2, "'*' means search-everything — both neighbours link");
});

/* ─── B2 fakes: recall traversal across a cross-ecosystem edge ────────── */

type Node = { id: string; type: string; label: string; content: string; tags: string[]; project: string; ecosystem: string; updatedAt: string };
const node = (id: string, ecosystem: string): Node => ({
    id, type: 'note', label: id, content: `content ${id}`, tags: [],
    project: 'shared-ws', ecosystem, updatedAt: '2026-08-01T00:00:00.000Z',
});

function mockCtx(cfg: {
    nodes: Record<string, Node>;
    semantic: Array<{ id: string; score?: number }>;
    traverse: Record<string, Array<{ node: Node; depth: number }>>;
}): RetrieveContext {
    const graph = {
        async search() { return [] as never; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = cfg.nodes[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse(id: string) { return (cfg.traverse[id] ?? []) as never; },
    };
    return {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 1; },
                async verbatimSearch() { return cfg.semantic as never; },
                async verbatimBm25Search() { return { hits: [], ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
}

/** Seed in ecosystem alpha, with a depth-1 neighbour in each ecosystem —
 *  precisely the graph shape B1's old cross-ecosystem edges produced. */
const traversalCfg = {
    nodes: { 'seed-a': node('seed-a', 'question-alpha') },
    semantic: [{ id: 'lore:seed-a', score: 0.9 }],
    traverse: {
        'seed-a': [
            { node: node('hop-alpha', 'question-alpha'), depth: 1 },
            { node: node('hop-beta', 'question-beta'), depth: 1 },
        ],
    },
};

await test('B2: traversal does NOT walk into another ecosystem', async () => {
    const out = await retrieve(mockCtx(traversalCfg), 'q', {
        workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 1,
    });
    const ids = out.results.map((r) => r.node.id);
    assert.ok(!ids.includes('hop-beta'), `foreign-ecosystem node leaked via traversal: ${ids.join(', ')}`);
});

await test('B2: traversal STILL returns same-ecosystem neighbours', async () => {
    // Guard against "fixing" the leak by disabling traversal.
    const out = await retrieve(mockCtx(traversalCfg), 'q', {
        workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 1,
    });
    const ids = out.results.map((r) => r.node.id);
    assert.ok(ids.includes('seed-a'), 'seed must survive');
    assert.ok(ids.includes('hop-alpha'), 'same-ecosystem neighbour must still be traversed');
});

await test('B2: crossProject search-everything still traverses both ecosystems', async () => {
    // ecosystemScope resolves to '*' under crossProject; confinement must be
    // a no-op there, exactly like the existing seed filter.
    const out = await retrieve(mockCtx(traversalCfg), 'q', {
        workspace: 'shared-ws', ecosystem: 'question-alpha', crossProject: true, depth: 1,
    });
    const ids = out.results.map((r) => r.node.id);
    assert.ok(ids.includes('hop-beta'), 'crossProject must not be confined');
    assert.ok(ids.includes('hop-alpha'), 'crossProject keeps same-ecosystem hops too');
});

/* ─── B3 fakes: the BULK sweep (reconnectGraph) over the same index ───── */

/**
 * Vector store for the bulk sweep. Same `honourFilter` seam as makeVerbatim,
 * plus the extra surface reconnectGraph touches (getContentHashesByIds /
 * storeBatch). `force: true` in the calls below bypasses the content-hash skip
 * so every node is embedded AND searched on every run.
 */
function makeBulkVerbatim(hits: Hit[], opts: { honourFilter?: boolean } = {}) {
    const honour = opts.honourFilter ?? true;
    const seen: { filters: unknown[] } = { filters: [] };
    const store = {
        async initialize() { /* no-op */ },
        async getContentHashesByIds() { return new Map<string, string>(); },
        async storeBatch() { /* no-op */ },
        async search(_q: string, _limit: number, filter?: { ecosystem?: string }) {
            seen.filters.push(filter);
            if (honour && filter?.ecosystem) {
                return hits.filter((h) => h.metadata.ecosystem === filter.ecosystem);
            }
            return hits;
        },
    };
    return { store, seen };
}

/** One-page bulkList over a mixed-ecosystem corpus. */
function makeBulkGraph(nodes: Array<Record<string, unknown>>) {
    const edges: Array<{ sourceId: string; targetId: string }> = [];
    let served = false;
    const graph = {
        async bulkList() {
            if (served) return { nodes: [], hasMore: false, nextCursor: null };
            served = true;
            return { nodes, hasMore: false, nextCursor: null };
        },
        async addEdge(e: { sourceId: string; targetId: string }) { edges.push(e); },
        async pruneInferredLoreEdges() { return 0; },
    };
    return { graph, edges };
}

/** The sweep's own source node, in ecosystem question-alpha. */
const BULK_NODES = [{
    id: 'alpha-1', type: 'fact', label: 'baking', content: 'the user baked a baguette',
    tags: [], project: 'shared-ws', ecosystem: 'question-alpha',
    updatedAt: '2026-08-01T00:00:00.000Z', security_scopes: [],
}];

await test('B3: the BULK sweep pushes the ecosystem filter INTO its search too', async () => {
    // reconnectGraph is the larger producer of cross-ecosystem edges (whole
    // corpus, first install + every reconnect/reconsume call). Round 1 fixed
    // only reconnectOneNode; this pins the sibling.
    const { store, seen } = makeBulkVerbatim(MIXED_HITS);
    const { graph } = makeBulkGraph(BULK_NODES);
    await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    assert.deepEqual(
        seen.filters[0], { ecosystem: 'question-alpha' },
        'bulk sweep candidate search must be scoped at the query, per SOURCE node',
    );
});

await test('B3: the BULK sweep proposes NO cross-ecosystem edge', async () => {
    const { store } = makeBulkVerbatim(MIXED_HITS);
    const { graph } = makeBulkGraph(BULK_NODES);
    const res = await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    const endpoints = res.proposedEdges.flatMap((e) => [e.from, e.to]);
    assert.ok(
        !endpoints.includes('lore:beta-9'),
        `cross-ecosystem edge proposed by the bulk sweep: ${JSON.stringify(res.proposedEdges)}`,
    );
});

await test('B3: the BULK sweep STILL links within its own ecosystem', async () => {
    // Guard against "fixing" the sweep by making it propose nothing.
    const { store } = makeBulkVerbatim(MIXED_HITS);
    const { graph } = makeBulkGraph(BULK_NODES);
    const res = await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    const endpoints = res.proposedEdges.flatMap((e) => [e.from, e.to]);
    assert.ok(endpoints.includes('lore:alpha-2'), 'same-ecosystem neighbour must still be proposed');
    assert.equal(res.proposedEdges.length, 1, 'exactly the one same-ecosystem edge');
});

await test('B3: BULK backstop — a store that ignores the filter still cannot leak', async () => {
    const { store } = makeBulkVerbatim(MIXED_HITS, { honourFilter: false });
    const { graph } = makeBulkGraph(BULK_NODES);
    const res = await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    const endpoints = res.proposedEdges.flatMap((e) => [e.from, e.to]);
    assert.ok(!endpoints.includes('lore:beta-9'), 'per-hit check must reject the foreign hit the store returned anyway');
    assert.ok(endpoints.includes('lore:alpha-2'), 'same-ecosystem neighbour still proposed');
});

await test('B3: BULK sweep — the applied edge set is confined too, not just the proposal', async () => {
    const { store } = makeBulkVerbatim(MIXED_HITS, { honourFilter: false });
    const { graph, edges } = makeBulkGraph(BULK_NODES);
    await reconnectGraph(graph as never, store as never, { dryRun: false, force: true, pruneInferred: false });
    const endpoints = edges.flatMap((e) => [e.sourceId, e.targetId]);
    assert.ok(!endpoints.includes('beta-9'), `cross-ecosystem edge WRITTEN: ${JSON.stringify(edges)}`);
    assert.ok(endpoints.includes('alpha-2'), 'same-ecosystem edge must still be written');
});

await test("B3: per-SOURCE scoping — a mixed page scopes each node to its own ecosystem", async () => {
    // A page holds nodes from every ecosystem in the workspace, so the filter
    // cannot be hoisted out of the loop. Two sources, two different filters.
    const { store, seen } = makeBulkVerbatim(MIXED_HITS);
    const { graph } = makeBulkGraph([
        BULK_NODES[0]!,
        { ...BULK_NODES[0]!, id: 'beta-1', content: 'a different beta thing', ecosystem: 'question-beta' },
    ]);
    await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    assert.deepEqual(
        // Each source issues its OWN scoped query, each unioned with an
        // unscoped one (B8 — the legacy-corpus backstop). The alternating
        // shape is the point: the filter is per-source, never hoisted.
        seen.filters,
        [{ ecosystem: 'question-alpha' }, undefined, { ecosystem: 'question-beta' }, undefined],
        'each source node must carry its OWN ecosystem into its own search',
    );
});

await test("B3: an unscoped ('*') source in the bulk sweep is left unfiltered (documented decision)", async () => {
    // Deliberate, and documented on `ecosystemConfinement` in reconnect.ts:
    // LoreNode.ecosystem's schema DEFAULT is literally '*', so "unset" and
    // "all" are the same stored value — confining '*' would invent a semantic
    // the rest of the system doesn't have AND would switch autolink off for
    // every install that never sets an ecosystem. Recall stays safe because
    // retrieve.ts filters seeds AND hops with strict equality, so a scoped
    // recall never walks through a '*' node.
    const { store, seen } = makeBulkVerbatim(MIXED_HITS);
    const { graph } = makeBulkGraph([{ ...BULK_NODES[0]!, ecosystem: '*' }]);
    const res = await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    assert.equal(seen.filters[0], undefined, "'*' must not push an ecosystem filter");
    assert.equal(res.proposedEdges.length, 2, "'*' means search-everything — both neighbours propose");
});

/* ─── B4 fakes: verbatim metadata disagreeing with the graph node ─────── */

/**
 * Recall context whose vector store HONOURS the ecosystem filter but whose
 * rows carry a DIFFERENT ecosystem than the graph node does — the exact state
 * `bulkWrite.ts` produced by stamping a literal '*' into verbatim metadata
 * while the graph node kept the caller's real ecosystem.
 *
 * `metadataEcosystem` is what the vector rows claim; the graph nodes are built
 * with their real ecosystem. The filter is applied against the CLAIM, so a
 * scoped query returns nothing and only the unfiltered top-up finds the row.
 */
function mismatchCtx(cfg: {
    nodes: Record<string, Node>;
    hits: Array<{ id: string; score?: number }>;
    metadataEcosystem: string;
    calls: Array<{ ecosystem?: string } | undefined>;
    /** Optional recorder for the BM25 half of the seed pass. */
    bm25Calls?: Array<{ ecosystem?: string } | undefined>;
}): RetrieveContext {
    const graph = {
        async search() { return [] as never; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = cfg.nodes[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return [] as never; },
    };
    const applyFilter = (filter?: { ecosystem?: string }) => {
        cfg.calls.push(filter);
        if (filter?.ecosystem && filter.ecosystem !== cfg.metadataEcosystem) return [];
        return cfg.hits;
    };
    return {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 1; },
                async verbatimSearch(_q: string, _n: number, filter?: { ecosystem?: string }) {
                    return applyFilter(filter) as never;
                },
                async verbatimBm25Search(_q: string, _n: number, filter?: { ecosystem?: string }) {
                    cfg.bm25Calls?.push(filter);
                    return { hits: [], ranked: true } as never;
                },
            },
        },
    } as unknown as RetrieveContext;
}

await test('B4: a node whose verbatim metadata disagrees with its graph node is STILL findable', async () => {
    // THE regression the pushdown introduced. Graph node: question-alpha.
    // Verbatim row metadata: '*' (what bulkWrite.ts's inline batch path wrote).
    // Pre-fix, the scoped pushdown returned nothing and the node vanished from
    // semantic recall with no error and no signal.
    const calls: Array<{ ecosystem?: string } | undefined> = [];
    const out = await retrieve(mismatchCtx({
        nodes: { 'seed-a': node('seed-a', 'question-alpha') },
        hits: [{ id: 'lore:seed-a', score: 0.9 }],
        metadataEcosystem: '*',
        calls,
    }), 'q', { workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 0 });
    const ids = out.results.map((r) => r.node.id);
    assert.ok(
        ids.includes('seed-a'),
        'node with mismatched verbatim ecosystem metadata was silently dropped from recall',
    );
    assert.deepEqual(
        calls, [{ ecosystem: 'question-alpha' }, undefined],
        'the scoped query must run FIRST (the optimisation) and only then top up unfiltered',
    );
});

await test('B4: the unfiltered top-up must NOT leak a foreign-ecosystem node', async () => {
    // The top-up widens the CANDIDATE set, never the result set: the
    // post-hydration filter reads the graph node, which is authoritative.
    const calls: Array<{ ecosystem?: string } | undefined> = [];
    const out = await retrieve(mismatchCtx({
        nodes: {
            'seed-a': node('seed-a', 'question-alpha'),
            'seed-b': node('seed-b', 'question-beta'),
        },
        hits: [{ id: 'lore:seed-b', score: 0.99 }, { id: 'lore:seed-a', score: 0.9 }],
        metadataEcosystem: '*',
        calls,
    }), 'q', { workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 0 });
    const ids = out.results.map((r) => r.node.id);
    assert.ok(ids.includes('seed-a'), 'own-ecosystem node must be recovered');
    assert.ok(!ids.includes('seed-b'), `foreign-ecosystem node leaked through the top-up: ${ids.join(', ')}`);
});

/* ─── B5: the backstop must not be gated on the primary result count ──── */

/**
 * Vector store where the scoped query returns a FULL window of correctly-
 * tagged rows AND a mismatched row exists that only the unscoped query can
 * see. This is the shape the round-2 conditional top-up could not handle: it
 * fired only when the scoped query under-delivered, so a healthy ecosystem
 * never triggered it and its mismatched rows stayed invisible forever.
 *
 * `mismatched` rows are returned ONLY by an unfiltered query; `scoped` rows
 * are returned by both. Every row hydrates to a graph node in `ecosystem`.
 */
const LIMIT = 4;
/** retrieve()'s SEED_HIDDEN_HEADROOM — the scoped query must return at least
 *  this many rows for the window to count as FULL. */
const FULL_WINDOW = LIMIT * 4;

function fullWindowCtx(cfg: {
    ecosystem: string;
    /** How many correctly-tagged rows the SCOPED query returns. */
    scopedCount: number;
    /** Ids only an UNSCOPED query can see (stale/wrong verbatim metadata).
     *  Scored above the scoped rows so the assertions don't depend on where
     *  re-ranking puts them. */
    mismatched: string[];
    /** Graph-node ecosystem override, for the leak test. */
    foreign?: Record<string, string>;
    calls: Array<{ ecosystem?: string } | undefined>;
    /** Records the window size retrieve() asked for, so a test can PROVE the
     *  scoped query filled it rather than assuming SEED_HIDDEN_HEADROOM's
     *  current value. Without this the full-window premise could silently stop
     *  holding and these tests would pass for the wrong reason. */
    requestedWindow?: number[];
}): RetrieveContext {
    const scoped = Array.from({ length: cfg.scopedCount }, (_, i) => `s${i}`);
    const all = [...cfg.mismatched, ...scoped];
    const nodes: Record<string, Node> = {};
    all.forEach((id) => { nodes[id] = node(id, cfg.foreign?.[id] ?? cfg.ecosystem); });
    const hit = (id: string) => ({ id: `lore:${id}`, score: 0.9 - all.indexOf(id) * 0.01 });
    const graph = {
        async search() { return [] as never; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = nodes[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return [] as never; },
    };
    return {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 1; },
                async verbatimSearch(_q: string, n: number, filter?: { ecosystem?: string }) {
                    cfg.calls.push(filter);
                    cfg.requestedWindow?.push(n);
                    return (filter?.ecosystem ? scoped : all).map(hit) as never;
                },
                async verbatimBm25Search() { return { hits: [], ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
}

await test('B5: a mismatched row is found even when the scoped query FILLS the window', async () => {
    // THE round-2 regression, and the COMMON case: the scoped query returns a
    // FULL window (16 rows for limit 4 × SEED_HIDDEN_HEADROOM), so the old
    // "top up only when the scoped query under-delivers" condition never
    // fired — and `mismatch-1` (graph ecosystem question-alpha, verbatim
    // metadata stale/wrong) was permanently unreachable by semantic recall.
    const calls: Array<{ ecosystem?: string } | undefined> = [];
    const requestedWindow: number[] = [];
    const out = await retrieve(fullWindowCtx({
        ecosystem: 'question-alpha',
        scopedCount: FULL_WINDOW,
        mismatched: ['mismatch-1'],
        calls, requestedWindow,
    }), 'q', { workspace: 'shared-ws', ecosystem: 'question-alpha', limit: LIMIT, depth: 0 });
    assert.ok(
        requestedWindow[0] !== undefined && FULL_WINDOW >= requestedWindow[0],
        `premise broken: scoped query returned ${FULL_WINDOW} rows for a window of ${requestedWindow[0]} — this no longer tests the FULL-window case (SEED_HIDDEN_HEADROOM changed?)`,
    );
    const ids = out.results.map((r) => r.node.id);
    assert.ok(
        ids.includes('mismatch-1'),
        `mismatched-metadata node invisible behind a full scoped window: ${ids.join(', ')}`,
    );
    assert.deepEqual(
        calls, [{ ecosystem: 'question-alpha' }, undefined],
        'the unscoped correctness query must run REGARDLESS of how full the scoped result was',
    );
});

await test('B5: the unconditional union still cannot leak a foreign-ecosystem node', async () => {
    // Widening the candidate set must never widen the RESULT set — the
    // post-hydration graph check is still the only thing that decides. Same
    // full window, so this also fails on the conditional (round-2) version.
    const calls: Array<{ ecosystem?: string } | undefined> = [];
    const out = await retrieve(fullWindowCtx({
        ecosystem: 'question-alpha',
        scopedCount: FULL_WINDOW,
        mismatched: ['mismatch-1', 'foreign-1'],
        foreign: { 'foreign-1': 'question-beta' },
        calls,
    }), 'q', { workspace: 'shared-ws', ecosystem: 'question-alpha', limit: LIMIT, depth: 0 });
    const ids = out.results.map((r) => r.node.id);
    assert.ok(ids.includes('mismatch-1'), 'own-ecosystem node must be recovered');
    assert.ok(!ids.includes('foreign-1'), `foreign-ecosystem node leaked through the union: ${ids.join(', ')}`);
});

await test('B5: cost is exactly two queries per seed method — never more', async () => {
    // The union is unconditional, not unbounded: one scoped + one unscoped per
    // method, issued concurrently. A regression that re-queried per-hit or
    // looped would show up here.
    const calls: Array<{ ecosystem?: string } | undefined> = [];
    const bm25Calls: Array<{ ecosystem?: string } | undefined> = [];
    await retrieve(mismatchCtx({
        nodes: { 'seed-a': node('seed-a', 'question-alpha') },
        hits: [{ id: 'lore:seed-a', score: 0.9 }],
        metadataEcosystem: '*',
        calls, bm25Calls,
    }), 'q', { workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 0 });
    assert.deepEqual(calls, [{ ecosystem: 'question-alpha' }, undefined], 'semantic: scoped then unscoped, exactly twice');
    assert.deepEqual(bm25Calls, [{ ecosystem: 'question-alpha' }, undefined], 'bm25: scoped then unscoped, exactly twice');
});

await test('B5: topScore describes a node that is actually returned, not a filtered-out one', async () => {
    // The unscoped half of the union routinely puts a foreign-ecosystem row at
    // the top of the raw hit list. topScore drives recallPreset's confidence
    // AND its auto-escalation threshold, so reporting that row's score would
    // decide both from a node the caller never sees. `foreign-top` is scored
    // highest here and dropped by the ecosystem filter.
    const calls: Array<{ ecosystem?: string } | undefined> = [];
    const out = await retrieve(fullWindowCtx({
        ecosystem: 'question-alpha',
        scopedCount: 0,
        mismatched: ['foreign-top', 'mine'],
        foreign: { 'foreign-top': 'question-beta' },
        calls,
    }), 'q', { workspace: 'shared-ws', ecosystem: 'question-alpha', limit: LIMIT, depth: 0 });
    assert.deepEqual(out.results.map((r) => r.node.id), ['mine'], 'only the own-ecosystem node survives');
    assert.equal(out.meta.topScore, 0.89, "topScore must be 'mine' (0.89), not the dropped foreign-top (0.9)");
});

await test("B4: crossProject ('*') runs exactly one unfiltered query, as before", async () => {
    const calls: Array<{ ecosystem?: string } | undefined> = [];
    await retrieve(mismatchCtx({
        nodes: { 'seed-a': node('seed-a', 'question-alpha') },
        hits: [{ id: 'lore:seed-a', score: 0.9 }],
        metadataEcosystem: '*',
        calls,
    }), 'q', { workspace: 'shared-ws', ecosystem: 'question-alpha', crossProject: true, depth: 0 });
    assert.deepEqual(calls, [undefined], "'*' scope must not push a filter and must not double-query");
});

/* ─── B6: the SIBLING branch of the same bug the union fixed ──────────── */

/**
 * The union made the unscoped vector query UNCONDITIONAL, which means
 * `seedNodeIds` is now filled with FOREIGN-ecosystem ids whenever any other
 * ecosystem in the workspace has vectors — even when the requested ecosystem
 * has none of its own. The keyword branch was entered on
 * `seedNodeIds.length === 0`, so it stopped running; the post-hydration filter
 * then dropped every one of those foreign seeds; and the recall returned
 * EMPTY — although `graph.search(query, limit, '*', ecosystemScope, ...)`, the
 * ecosystem-scoped-IN-THE-DATABASE keyword scan, would have found the
 * ecosystem's own nodes.
 *
 * That is the same defect the union fixed — a correctness path gated on how
 * full the primary result looked — on the other branch of the same function,
 * and the trigger is another ecosystem's data arriving in the shared
 * workspace: precisely the multi-tenant crowding the pushdown exists for.
 *
 * `betaHasVectors` is the ONLY thing these two runs differ by. The alpha data
 * and the query are identical, so a difference in the result is the bug.
 */
function crowdedCtx(cfg: {
    /** Does the UNRELATED beta ecosystem have embedded rows? */
    betaHasVectors: boolean;
    /** What the ecosystem-scoped keyword scan finds (graph-level, authoritative). */
    keywordHits: Node[];
    /** Records (project, ecosystem) of every graph.search call. */
    searchScopes: Array<{ project: string; ecosystem: string }>;
    /** Ecosystem the ctx's own nodes hydrate as. */
    hydrated?: Record<string, Node>;
}): RetrieveContext {
    const betaHits = [{ id: 'lore:beta-1', score: 0.99 }];
    const nodes: Record<string, Node> = { 'beta-1': node('beta-1', 'question-beta'), ...(cfg.hydrated ?? {}) };
    const graph = {
        async search(_q: string, _n: number, project: string, ecosystem: string) {
            cfg.searchScopes.push({ project, ecosystem });
            return cfg.keywordHits as never;
        },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = nodes[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return [] as never; },
    };
    return {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                // The workspace HAS vectors as soon as any ecosystem in it does.
                async verbatimCount() { return cfg.betaHasVectors ? 1 : 0; },
                async verbatimSearch(_q: string, _n: number, filter?: { ecosystem?: string }) {
                    if (!cfg.betaHasVectors) return [] as never;
                    // Beta's rows are correctly tagged, so an alpha-scoped query
                    // finds nothing and only the UNSCOPED half of the union
                    // returns them — which is exactly how they end up seeding an
                    // alpha recall.
                    return (filter?.ecosystem ? [] : betaHits) as never;
                },
                async verbatimBm25Search() { return { hits: [], ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
}

const KW_ALPHA = node('kw-alpha', 'question-alpha');

await test('B6: an unrelated ecosystem gaining vectors must NOT blind this one (control: it has none)', async () => {
    const searchScopes: Array<{ project: string; ecosystem: string }> = [];
    const out = await retrieve(crowdedCtx({ betaHasVectors: false, keywordHits: [KW_ALPHA], searchScopes }), 'q', {
        workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 0,
    });
    assert.deepEqual(out.results.map((r) => r.node.id), ['kw-alpha'], 'baseline: the ecosystem-scoped keyword scan finds its own node');
});

await test('B6: ...and the SAME query on the SAME alpha data once beta gets embedded', async () => {
    // Pre-fix this returned [] — the recall went blind because an UNRELATED
    // ecosystem's rows got embedded into the same workspace.
    const searchScopes: Array<{ project: string; ecosystem: string }> = [];
    const out = await retrieve(crowdedCtx({ betaHasVectors: true, keywordHits: [KW_ALPHA], searchScopes }), 'q', {
        workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 0,
    });
    assert.deepEqual(
        out.results.map((r) => r.node.id), ['kw-alpha'],
        'recall went blind: foreign seeds filled seedNodeIds, the ecosystem-scoped keyword branch never ran, and every seed was then filtered away',
    );
});

await test('B6: the fall-through scan is ecosystem-scoped IN THE DATABASE, and runs exactly once', async () => {
    const searchScopes: Array<{ project: string; ecosystem: string }> = [];
    await retrieve(crowdedCtx({ betaHasVectors: true, keywordHits: [KW_ALPHA], searchScopes }), 'q', {
        workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 0,
    });
    assert.deepEqual(
        searchScopes, [{ project: '*', ecosystem: 'question-alpha' }],
        'exactly one keyword scan, pushed down with the requested ecosystem (never a second, never unscoped)',
    );
});

await test('B6: the fall-through widens the CANDIDATE set, never the result set', async () => {
    // A keyword scan whose scoping silently degraded still cannot leak: the
    // same post-hydration graph check applies to the fall-through seeds.
    const searchScopes: Array<{ project: string; ecosystem: string }> = [];
    const out = await retrieve(crowdedCtx({
        betaHasVectors: true,
        keywordHits: [KW_ALPHA, node('kw-beta', 'question-beta')],
        searchScopes,
    }), 'q', { workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 0 });
    const ids = out.results.map((r) => r.node.id);
    assert.ok(ids.includes('kw-alpha'), 'own-ecosystem node must be returned');
    assert.ok(!ids.includes('kw-beta'), `foreign-ecosystem node leaked through the fall-through: ${ids.join(', ')}`);
});

await test("B6: '*' (search-everything) gains the supplementary scan too — it widens, never confines (Cluster 5a)", async () => {
    // This test pinned the PRE-Cluster-5a control flow ("no keyword scan under
    // '*'") until Finding 5.1 made the bounded keyword scan UNCONDITIONAL on
    // every vector-seeded recall — the commit message says "every" and names
    // the unscoped default as a rescued case: an embed:false node has no
    // vector row under '*' either. Under '*' the post-hydration ecosystem
    // filter is a no-op, so the scan can only ADD nodes, never confine: the
    // vector seed (foreign to the caller's stated scope, which '*' discards)
    // AND the keyword hit both belong in the result.
    const searchScopes: Array<{ project: string; ecosystem: string }> = [];
    const out = await retrieve(crowdedCtx({ betaHasVectors: true, keywordHits: [KW_ALPHA], searchScopes }), 'q', {
        workspace: 'shared-ws', ecosystem: 'question-alpha', crossProject: true, depth: 0,
    });
    assert.deepEqual(
        out.results.map((r) => r.node.id).sort(), ['beta-1', 'kw-alpha'],
        "'*' returns the vector seed AND the keyword-supplemented node, unconfined",
    );
    assert.deepEqual(
        searchScopes, [{ project: '*', ecosystem: '*' }],
        "exactly one supplementary scan, DB-scoped to '*' — never a second, never narrower",
    );
});

/* ─── B8: autolink must not switch itself OFF on a legacy corpus ──────── */

/**
 * The strict per-hit metadata check + the query pushdown together mean that on
 * a corpus written BEFORE the write-side ecosystem fix, every candidate for a
 * node with a real ecosystem fails BOTH — the pushdown never returns the row
 * (its metadata says `'*'`, not `'acme'`) and the per-hit check would reject it
 * anyway. So `reconnectGraph` / `reconnectOneNode` propose ZERO edges and
 * report success.
 *
 * Those rows are still on disk: the `'*'` (bulk paths) and `''` (outbox) writes
 * were fixed at the WRITE side only, which is why retrieve.ts carries an
 * unconditional union for the very same data state. `reconnectGraph` is the
 * tool an operator runs to REPAIR edges, so silently rebuilding nothing is the
 * worst possible failure for it.
 *
 * `graphEcosystem` is what the (authoritative) graph node says; the verbatim
 * rows all claim the legacy placeholder.
 */
function makeLegacyVerbatim(rows: Array<{ id: string; score: number; legacyMetadata: string }>) {
    const seen: { filters: unknown[] } = { filters: [] };
    const hits = rows.map((r) => ({ id: r.id, score: r.score, metadata: { ecosystem: r.legacyMetadata } }));
    const store = {
        async initialize() { /* no-op */ },
        async store() { /* no-op */ },
        async getContentHashesByIds() { return new Map<string, string>(); },
        async storeBatch() { /* no-op */ },
        async search(_q: string, _limit: number, filter?: { ecosystem?: string }) {
            seen.filters.push(filter);
            // A real store honours the pushdown against the ROW's metadata —
            // which is exactly why a legacy row is invisible to a scoped query.
            if (filter?.ecosystem) return hits.filter((h) => h.metadata.ecosystem === filter.ecosystem);
            return hits;
        },
    };
    return { store, seen };
}

/** Graph that can answer `getNode` — the authoritative ecosystem source the
 *  ambiguous-hit resolver consults. */
function makeLegacyGraph(nodes: Array<Record<string, unknown>>, graphEcosystem: Record<string, string>) {
    const edges: Array<{ sourceId: string; targetId: string }> = [];
    const reads: string[] = [];
    let served = false;
    const graph = {
        async bulkList() {
            if (served) return { nodes: [], hasMore: false, nextCursor: null };
            served = true;
            return { nodes, hasMore: false, nextCursor: null };
        },
        async getNode(id: string) {
            reads.push(id);
            const eco = graphEcosystem[id];
            return eco === undefined ? null : { id, ecosystem: eco };
        },
        async addEdge(e: { sourceId: string; targetId: string }) { edges.push(e); },
        async pruneInferredLoreEdges() { return 0; },
    };
    return { graph, edges, reads };
}

/** Legacy rows: metadata '*' (bulk paths) and '' (outbox), graph says alpha. */
const LEGACY_ROWS = [
    { id: 'lore:alpha-2', score: 0.95, legacyMetadata: '*' },
    { id: 'lore:alpha-3', score: 0.93, legacyMetadata: '' },
];

await test('B8: the BULK sweep still rebuilds edges on a pre-fix (legacy-metadata) corpus', async () => {
    // Pre-fix: zero proposals, `applied: true`, no error, no log — on the very
    // tool an operator runs to repair a graph.
    const { store } = makeLegacyVerbatim(LEGACY_ROWS);
    const { graph } = makeLegacyGraph(BULK_NODES, { 'alpha-2': 'question-alpha', 'alpha-3': 'question-alpha' });
    const res = await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    const endpoints = res.proposedEdges.flatMap((e) => [e.from, e.to]);
    assert.ok(
        endpoints.includes('lore:alpha-2') && endpoints.includes('lore:alpha-3'),
        `autolink silently switched OFF on a legacy corpus: ${JSON.stringify(res.proposedEdges)}`,
    );
});

await test('B8: the recovered legacy hits are still decided by the GRAPH, not waved through', async () => {
    // alpha-3's graph node is in a DIFFERENT concrete ecosystem, so recovering
    // it as a candidate must not make it an edge. This is what separates the
    // fix from "stop filtering".
    const { store } = makeLegacyVerbatim(LEGACY_ROWS);
    const { graph, reads } = makeLegacyGraph(BULK_NODES, { 'alpha-2': 'question-alpha', 'alpha-3': 'question-beta' });
    const res = await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    const endpoints = res.proposedEdges.flatMap((e) => [e.from, e.to]);
    assert.ok(endpoints.includes('lore:alpha-2'), 'same-ecosystem legacy row must be linked');
    assert.ok(!endpoints.includes('lore:alpha-3'), `foreign node recovered AND linked: ${JSON.stringify(res.proposedEdges)}`);
    assert.deepEqual(reads.sort(), ['alpha-2', 'alpha-3'], 'ambiguous hits are resolved against the graph node');
});

await test('B8: the per-node hook recovers legacy rows the same way', async () => {
    const { store } = makeLegacyVerbatim(LEGACY_ROWS);
    const { graph, edges } = makeLegacyGraph([], { 'alpha-2': 'question-alpha', 'alpha-3': 'question-beta' });
    const res = await reconnectOneNode(graph as never, store as never, ALPHA_NODE, { k: 5 });
    const endpoints = edges.flatMap((e) => [e.sourceId, e.targetId]);
    assert.ok(endpoints.includes('alpha-2'), 'legacy same-ecosystem row must be linked by the ingest hook too');
    assert.ok(!endpoints.includes('alpha-3'), 'the graph still decides — a foreign node is not linked');
    assert.equal(res.added, 1);
});

await test('B8: a post-fix corpus costs ZERO graph reads (the resolver is the slow path)', async () => {
    // Correctly-stamped metadata is decided from the row alone.
    const { store } = makeBulkVerbatim(MIXED_HITS);
    const { graph, reads } = makeLegacyGraph(BULK_NODES, { 'alpha-2': 'question-alpha' });
    const res = await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    assert.deepEqual(reads, [], 'no ambiguous hits ⇒ no getNode lookups');
    assert.equal(res.proposedEdges.length, 1, 'and the confined result is unchanged');
});

await test('B8: a graph with no getNode keeps the documented wildcard default', async () => {
    // `'*'`/unset IS the wildcard by this module's own decision, so an
    // unresolvable ambiguous hit is accepted rather than silently dropped —
    // which is the pre-pushdown behaviour, not a new leak.
    const { store } = makeLegacyVerbatim(LEGACY_ROWS);
    const { graph } = makeBulkGraph(BULK_NODES); // no getNode
    const res = await reconnectGraph(graph as never, store as never, { dryRun: true, force: true });
    assert.equal(res.proposedEdges.length, 2, 'both wildcard-metadata rows stay candidates');
});

/* ─── B7: topScore must survive EVERY reducing step, not just the filters ─ */

/**
 * `tags` is a first-class parameter on the MCP `search`/`recall` tools and on
 * REST, and it runs AFTER the topScore reduction did. So did the re-rank slice
 * and the token-budget truncation. The round-3 fix moved the reduction below
 * the ecosystem/hidden filters and stopped there, which left `meta.topScore`
 * still able to describe a node the caller never receives — the exact harm the
 * fix's own comment describes, one stage later.
 */
function tagsCtx(cfg: { calls: Array<{ ecosystem?: string } | undefined> }): RetrieveContext {
    const hi = { ...node('hi', 'question-alpha'), tags: [] as string[] };
    const lo = { ...node('lo', 'question-alpha'), tags: ['keepme'] };
    const nodes: Record<string, Node> = { hi, lo };
    const graph = {
        async search() { return [] as never; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = nodes[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return [] as never; },
    };
    return {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 1; },
                async verbatimSearch(_q: string, _n: number, filter?: { ecosystem?: string }) {
                    cfg.calls.push(filter);
                    return [{ id: 'lore:hi', score: 0.99 }, { id: 'lore:lo', score: 0.1 }] as never;
                },
                async verbatimBm25Search() { return { hits: [], ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
}

await test('B7: topScore must not describe a node the `tags` filter removed', async () => {
    const calls: Array<{ ecosystem?: string } | undefined> = [];
    const out = await retrieve(tagsCtx({ calls }), 'q', {
        workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 0, tags: ['keepme'],
    });
    assert.deepEqual(out.results.map((r) => r.node.id), ['lo'], 'only the tagged node is returned');
    assert.equal(
        out.meta.topScore, 0.1,
        "topScore must be 'lo' (0.1) — the node actually returned — not the tag-filtered 'hi' (0.99), which drives recallPreset confidence + auto-escalation",
    );
});

await test('B7: topScore is null when the tags filter removes EVERY semantic seed', async () => {
    const calls: Array<{ ecosystem?: string } | undefined> = [];
    const out = await retrieve(tagsCtx({ calls }), 'q', {
        workspace: 'shared-ws', ecosystem: 'question-alpha', depth: 0, tags: ['nothing-has-this'],
    });
    assert.deepEqual(out.results, [], 'nothing survives the tag filter');
    assert.equal(out.meta.topScore, null, 'no returned node ⇒ no semantic confidence to report');
});

/* ─── B9: the mode matrix — one workspace, two ecosystems, ALL modes ──── */

/**
 * Adversarial fixture for the combined launch-readiness assertion. ONE
 * workspace ('shared-ws') holds TWO same-topic ecosystems
 * (question-alpha / question-beta), and every seed source is stacked
 * AGAINST the boundary:
 *
 *   - the UNSCOPED half of each vector/BM25 union ranks the FOREIGN row
 *     first (b-vec at 0.99 above a-vec at 0.9) — if hybrid's RRF or the
 *     semantic seed pass ever surfaced raw candidates unfiltered, the
 *     foreign node would come out on top;
 *   - the keyword scan is DELIBERATELY DEGRADED — it ignores its ecosystem
 *     argument and returns both ecosystems' keyword-only rows — so in
 *     'keyword' mode (which never consults the verbatim store) the
 *     post-hydration graph check is the ONLY thing standing between a
 *     foreign row and the result set;
 *   - the graph carries a CROSS-ECOSYSTEM edge (a-vec <-> b-vec), so the
 *     depth-1 traversal hop is exercised in every mode too.
 *
 * `a-kw` / `b-kw` are the embed:false rows (no verbatim entry): they are
 * reachable ONLY via the ecosystem-scoped keyword scan — primary in
 * 'keyword' mode, supplementary (Finding 5.1) in 'semantic'/'hybrid'.
 */
function modeMatrixCtx(): RetrieveContext {
    const nodes: Record<string, Node> = {
        'a-vec': node('a-vec', 'question-alpha'),
        'a-kw': node('a-kw', 'question-alpha'),
        'a-hop': node('a-hop', 'question-alpha'),
        'b-vec': node('b-vec', 'question-beta'),
        'b-kw': node('b-kw', 'question-beta'),
        'b-hop': node('b-hop', 'question-beta'),
    };
    const scopedVec = (filter?: { ecosystem?: string }) => {
        const all = [
            { id: 'lore:b-vec', score: 0.99 },
            { id: 'lore:a-vec', score: 0.9 },
        ];
        if (!filter?.ecosystem) return all;
        return all.filter((h) => h.id === `lore:${filter.ecosystem === 'question-alpha' ? 'a-vec' : 'b-vec'}`);
    };
    const graph = {
        // Degraded on purpose: the ecosystem argument is IGNORED. Both
        // keyword-only rows come back for either scope.
        async search() { return [nodes['a-kw']!, nodes['b-kw']!] as never; },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = nodes[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse(id: string) {
            if (id === 'a-vec') return [{ node: nodes['b-hop']!, depth: 1 }, { node: nodes['a-hop']!, depth: 1 }] as never;
            if (id === 'b-vec') return [{ node: nodes['a-hop']!, depth: 1 }, { node: nodes['b-hop']!, depth: 1 }] as never;
            return [] as never;
        },
    };
    return {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 2; },
                async verbatimSearch(_q: string, _n: number, filter?: { ecosystem?: string }) { return scopedVec(filter) as never; },
                async verbatimBm25Search(_q: string, _n: number, filter?: { ecosystem?: string }) {
                    return { hits: scopedVec(filter), ranked: true } as never;
                },
            },
        },
    } as unknown as RetrieveContext;
}

await test('B9: one workspace, two ecosystems — zero cross-contamination across ALL THREE search modes, seeds and hops', async () => {
    for (const mode of ['semantic', 'keyword', 'hybrid'] as const) {
        for (const [scope, ownPrefix, foreignPrefix] of [
            ['question-alpha', 'a-', 'b-'],
            ['question-beta', 'b-', 'a-'],
        ] as const) {
            const out = await retrieve(modeMatrixCtx(), 'q', {
                workspace: 'shared-ws', ecosystem: scope, mode, depth: 1, limit: 10,
            });
            const ids = out.results.map((r) => r.node.id);
            const leaked = ids.filter((id) => id.startsWith(foreignPrefix));
            assert.equal(
                leaked.length, 0,
                `[${mode}] recall(${scope}) leaked foreign-ecosystem node(s): ${leaked.join(', ')} (all: ${ids.join(', ')})`,
            );
            assert.ok(
                ids.some((id) => id.startsWith(ownPrefix)),
                `[${mode}] recall(${scope}) returned nothing of its own ecosystem — vacuous pass`,
            );
            // The embed:false row must be rescued in EVERY mode — primary
            // keyword scan in 'keyword', Finding 5.1's supplementary scan in
            // 'semantic'/'hybrid'.
            assert.ok(
                ids.includes(`${ownPrefix}kw`),
                `[${mode}] recall(${scope}) lost the embed:false node: ${ids.join(', ')}`,
            );
            // Mode-path honesty: a vacuous green is impossible if the mode
            // never took its intended seed path.
            assert.equal(
                out.meta.verbatimConsulted, mode !== 'keyword',
                `[${mode}] verbatimConsulted=${out.meta.verbatimConsulted} — the mode did not exercise its defining seed path`,
            );
            // The vector-seeded modes must also surface the same-ecosystem
            // traversal hop while dropping the foreign one (the leaked check
            // above covers the drop; this pins the hop actually RAN).
            if (mode !== 'keyword') {
                assert.ok(
                    ids.includes(`${ownPrefix}hop`),
                    `[${mode}] recall(${scope}) never traversed — the cross-ecosystem edge premise is untested: ${ids.join(', ')}`,
                );
            }
        }
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

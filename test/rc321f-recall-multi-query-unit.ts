#!/usr/bin/env tsx
/**
 * test/rc321f-recall-multi-query-unit.ts — Lore 3.21 step 3(f).
 *
 * `retrieve()` accepts an optional `queries[]` (≤5 EXTRA phrasings alongside
 * the primary `query`) and `entities`/`topics`/`project` filters over the
 * metadata fields 3.21 step 3(e) introduced. Pins:
 *
 *   - fusion across phrasings: every phrasing's ranked list (per leg) is
 *     fused with the ONE shared rrfFuse (recall/rrf.ts, k=60) — a node found
 *     by several phrasings outranks one found by only one, exactly the way
 *     an RRF-fused multi-leg result already does within a single phrasing.
 *   - filters: entities/topics (metadata, 3.21 step 3(e)) and project are
 *     enforced — a node missing a required value is excluded even though it
 *     matched the query itself.
 *   - no-queries parity: omitting `queries` reproduces today's single-
 *     phrasing behaviour exactly (byte-identical order/score) — the whole
 *     point of routing a single phrasing through the same rrfFuse call.
 */

import assert from 'node:assert/strict';
import { retrieve, type RetrieveContext, type RetrieveOutcome, type RetrievalResult } from '../packages/lore/src/recall/retrieve.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type Node = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; updatedAt: string; status?: string; metadata?: string;
};
const node = (id: string, over: Partial<Node> = {}): Node => ({
    id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'w', ecosystem: '*',
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

const byId = (out: RetrieveOutcome, id: string): RetrievalResult | undefined =>
    out.results.find((r) => r.node.id === id);

interface MockCfg {
    /** bm25Search results, keyed by the exact query phrasing text. */
    bm25ByQuery: Record<string, Array<{ id: string; score?: number }>>;
    nodes: Record<string, Node>;
}

function mockCtx(cfg: MockCfg): { ctx: RetrieveContext; bm25Calls: string[] } {
    const bm25Calls: string[] = [];
    const graph = {
        async search() { return [] as never; }, // graph keyword leg: none in these fixtures
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = cfg.nodes[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return [] as never; },
    };
    const ctx = {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 5; },
                async verbatimSearch() { return [] as never; }, // keyword mode never reaches this
                async verbatimBm25Search(q: string) {
                    bm25Calls.push(q);
                    const hits = cfg.bm25ByQuery[q] ?? [];
                    return { hits: hits.map((h) => ({ id: `lore:${h.id}`, score: h.score })), ranked: true } as never;
                },
            },
        },
    } as unknown as RetrieveContext;
    return { ctx, bm25Calls };
}

console.log('RC321f — recall multi-query fusion + entities/topics/project filters');

await test('fusion across phrasings: a node found by BOTH phrasings outranks one found by only one', async () => {
    const { ctx, bm25Calls } = mockCtx({
        bm25ByQuery: {
            'q1': [{ id: 'a', score: 9 }, { id: 'b', score: 1 }],
            'q2': [{ id: 'c', score: 9 }, { id: 'b', score: 1 }],
        },
        nodes: { a: node('a'), b: node('b'), c: node('c') },
    });
    const out = await retrieve(ctx, 'q1', { workspace: 'w', mode: 'keyword', depth: 0, queries: ['q2'] });
    assert.deepEqual(bm25Calls.sort(), ['q1', 'q2'], 'both phrasings must run their own bm25Search');
    assert.deepEqual(out.results.map((r) => r.node.id).sort(), ['a', 'b', 'c']);
    // b appears at rank 1 (0-indexed) in BOTH phrasings' lists → its RRF
    // score is the sum of two contributions and must beat a/c, each of
    // which only contributed once, at rank 0, from a single phrasing.
    assert.equal(out.results[0]!.node.id, 'b', 'the node found by every phrasing must rank first after fusion');
    const bScore = byId(out, 'b')!.score;
    const aScore = byId(out, 'a')!.score;
    const cScore = byId(out, 'c')!.score;
    assert.ok(bScore > aScore, 'fused (2-list) score must exceed a single-list score');
    assert.ok(bScore > cScore, 'fused (2-list) score must exceed a single-list score');
    // a and c are RRF ties (same rank, single list each) — deterministic
    // tie-break is id-ascending (recall/rrf.ts).
    assert.equal(aScore, cScore);
    assert.deepEqual(out.results.slice(1).map((r) => r.node.id), ['a', 'c']);
});

await test('queries[] beyond the 5-extra cap are silently truncated, not rejected', async () => {
    const many = ['q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']; // 7 extras, cap is 5
    const byQuery: Record<string, Array<{ id: string; score?: number }>> = { q1: [{ id: 'seed', score: 1 }] };
    for (const q of many) byQuery[q] = [{ id: `hit-${q}`, score: 1 }];
    const nodes: Record<string, Node> = { seed: node('seed') };
    for (const q of many) nodes[`hit-${q}`] = node(`hit-${q}`);
    const { ctx, bm25Calls } = mockCtx({ bm25ByQuery: byQuery, nodes });
    const out = await retrieve(ctx, 'q1', { workspace: 'w', mode: 'keyword', depth: 0, queries: many });
    // primary + at most 5 extras = at most 6 distinct phrasings consulted.
    assert.ok(new Set(bm25Calls).size <= 6, `expected at most 6 phrasings consulted, got ${new Set(bm25Calls).size}`);
    assert.ok(out.results.length <= 6, 'result set bounded by the same cap');
});

await test('entities filter: keeps only nodes whose metadata.entities contains ALL requested values', async () => {
    const { ctx } = mockCtx({
        bm25ByQuery: { q1: [{ id: 'match', score: 5 }, { id: 'partial', score: 4 }, { id: 'none', score: 3 }] },
        nodes: {
            match: node('match', { metadata: JSON.stringify({ entities: ['acme', 'widget'] }) }),
            partial: node('partial', { metadata: JSON.stringify({ entities: ['acme'] }) }),
            none: node('none', { metadata: JSON.stringify({ entities: [] }) }),
        },
    });
    const out = await retrieve(ctx, 'q1', { workspace: 'w', mode: 'keyword', depth: 0, entities: ['acme', 'widget'] });
    assert.deepEqual(out.results.map((r) => r.node.id), ['match'], 'only the node with ALL requested entities survives');
});

await test('topics filter: same ALL-of semantics as entities, independent field', async () => {
    const { ctx } = mockCtx({
        bm25ByQuery: { q1: [{ id: 'match', score: 5 }, { id: 'other', score: 4 }] },
        nodes: {
            match: node('match', { metadata: JSON.stringify({ topics: ['billing', 'refunds'] }) }),
            other: node('other', { metadata: JSON.stringify({ topics: ['billing'] }) }),
        },
    });
    const out = await retrieve(ctx, 'q1', { workspace: 'w', mode: 'keyword', depth: 0, topics: ['billing', 'refunds'] });
    assert.deepEqual(out.results.map((r) => r.node.id), ['match']);
});

await test('project filter: exact-match on the node\'s project field', async () => {
    const { ctx } = mockCtx({
        bm25ByQuery: { q1: [{ id: 'p1', score: 5 }, { id: 'p2', score: 4 }] },
        nodes: {
            p1: node('p1', { project: 'atlas' }),
            p2: node('p2', { project: 'loom' }),
        },
    });
    const out = await retrieve(ctx, 'q1', { workspace: 'w', mode: 'keyword', depth: 0, project: 'atlas' });
    assert.deepEqual(out.results.map((r) => r.node.id), ['p1']);
});

await test('a node missing metadata entirely fails an entities/topics filter, not throws', async () => {
    const { ctx } = mockCtx({
        bm25ByQuery: { q1: [{ id: 'nometa', score: 5 }] },
        nodes: { nometa: node('nometa') }, // no `metadata` field at all
    });
    const out = await retrieve(ctx, 'q1', { workspace: 'w', mode: 'keyword', depth: 0, entities: ['acme'] });
    assert.deepEqual(out.results, [], 'malformed/missing metadata reads as no entities, not a crash');
});

await test('no-queries parity: omitting `queries` reproduces exactly today\'s single-phrasing order/score', async () => {
    const { ctx: ctxWithoutOpt } = mockCtx({
        bm25ByQuery: { q1: [{ id: 'a', score: 9 }, { id: 'b', score: 1 }] },
        nodes: { a: node('a'), b: node('b') },
    });
    const { ctx: ctxExplicitEmpty } = mockCtx({
        bm25ByQuery: { q1: [{ id: 'a', score: 9 }, { id: 'b', score: 1 }] },
        nodes: { a: node('a'), b: node('b') },
    });
    const outOmitted = await retrieve(ctxWithoutOpt, 'q1', { workspace: 'w', mode: 'keyword', depth: 0 });
    const outEmptyArray = await retrieve(ctxExplicitEmpty, 'q1', { workspace: 'w', mode: 'keyword', depth: 0, queries: [] });
    assert.deepEqual(outOmitted.results.map((r) => ({ id: r.node.id, score: r.score })),
        outEmptyArray.results.map((r) => ({ id: r.node.id, score: r.score })),
        'omitted vs explicit empty queries[] must be identical');
    assert.deepEqual(outOmitted.results.map((r) => r.node.id), ['a', 'b']);
});

await test('no-filters parity: omitting entities/topics/project applies no filtering (regression)', async () => {
    const { ctx } = mockCtx({
        bm25ByQuery: { q1: [{ id: 'a', score: 9 }, { id: 'b', score: 1 }] },
        nodes: { a: node('a'), b: node('b', { project: 'unrelated' }) },
    });
    const out = await retrieve(ctx, 'q1', { workspace: 'w', mode: 'keyword', depth: 0 });
    assert.deepEqual(out.results.map((r) => r.node.id).sort(), ['a', 'b'], 'no filter opts ⇒ both nodes survive, unaffected by 3(f)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

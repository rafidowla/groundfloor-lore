#!/usr/bin/env tsx
/**
 * d3-identifier-lane-unit.ts — D3 follow-up: exact-identifier lane
 * (packages/lore/src/recall/identifierLane.ts; design doc
 * docs/design/D3-prefix-stable-ranking.md §3.9).
 *
 * Pins:
 *   - the pure pinning order (tokens matched desc, rarest token first, D3
 *     rank, lane rank) and the MAX_PINNED cap;
 *   - retrieve() with candidateFloor > 0 pins a whole-token exact match that
 *     is OUTSIDE the semantic and whole-query BM25 windows (fetched by the
 *     token-only lane) at rank 1, and the ranking stays prefix-stable;
 *   - the lane fetch size is fixed (never `limit`);
 *   - legacy (candidateFloor 0) and mode:'semantic' never run the lane;
 *   - lane rows go through the same seed filters (ecosystem, archived, tags);
 *   - whole-token only: "#30" does not match "#3".
 *
 * Fully mocked context (no DB), same pattern as d3-prefix-stable-ranking-unit.ts.
 */

import assert from 'node:assert/strict';
import { retrieve, type RetrieveContext, type RetrieveOutcome } from '../packages/lore/src/recall/retrieve.js';
import { identifierLaneTokens, pinIdentifierMatches, IDENTIFIER_LANE_FETCH, MAX_PINNED } from '../packages/lore/src/recall/identifierLane.js';
import { containsWholeToken } from '../packages/lore/src/recall/abstention.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type Node = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; updatedAt: string; status?: string;
    metadata?: string; security_scopes?: string[];
    supersededBy?: string | null; supersededAt?: string | null;
};
const NOW = '2026-09-23T00:00:00.000Z';
const node = (id: string, over: Partial<Node> = {}): Node => ({
    id, type: 'code_symbol', label: id, content: `generic fixture symbol body ${id}`, tags: [], project: 'w', ecosystem: '*', updatedAt: NOW, ...over,
});
const asLore = (n: Node): LoreNode => n as unknown as LoreNode;

interface MockCfg {
    semantic: Array<{ id: string; score: number }>;
    /** bm25 hits keyed by the exact query string the store receives. */
    bm25ByQuery: Record<string, Array<{ id: string; score: number }>>;
    nodes: Record<string, Node>;
    searchByQuery?: Record<string, Node[]>;
}

function mockCtx(cfg: MockCfg): { ctx: RetrieveContext; calls: { bm25: Array<[string, number]>; search: Array<[string, number]> } } {
    const calls = { bm25: [] as Array<[string, number]>, search: [] as Array<[string, number]> };
    const graph = {
        async search(q: string, n: number) { calls.search.push([q, n]); return (cfg.searchByQuery?.[q] ?? []).slice(0, n) as never; },
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
                async verbatimCount() { return Object.keys(cfg.nodes).length; },
                async verbatimSearch(_q: string, n: number) { return cfg.semantic.slice(0, n) as never; },
                async verbatimBm25Search(q: string, n: number) { calls.bm25.push([q, n]); return { hits: (cfg.bm25ByQuery[q] ?? []).slice(0, n), ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
    return { ctx, calls };
}

const ids = (out: RetrieveOutcome): string[] => out.results.map((r) => r.node.id);

// Fixture: 300 semantic code rows at 0.870 → 0.840; none mention "#3" as a
// whole token except `target` (NOT in the semantic list and NOT in the
// whole-query bm25 list — only the token-only bm25 query returns it).
// `decoy` contains "#30" (whole-token must reject it).
const QUERY = 'fixture symbol #3';
function fixture(extra: Partial<MockCfg> = {}): MockCfg {
    const nodes: Record<string, Node> = {};
    const semantic: Array<{ id: string; score: number }> = [];
    for (let i = 0; i < 300; i++) {
        const id = `c${String(i).padStart(3, '0')}`;
        nodes[id] = node(id);
        semantic.push({ id, score: 0.87 - i * 0.0001 });
    }
    nodes.target = node('target', { content: 'export function x() {} // auto-generated fixture symbol #3' });
    nodes.decoy = node('decoy', { content: 'auto-generated fixture symbol #30' });
    const wholeQueryBm25 = semantic.slice(0, 250).map((h, i) => ({ id: h.id, score: 1 / (i + 1) }));
    return {
        nodes, semantic,
        bm25ByQuery: { [QUERY]: wholeQueryBm25, '#3': [{ id: 'decoy', score: 2 }, { id: 'target', score: 1 }] },
        ...extra,
    };
}

console.log('D3 — exact-identifier lane');

await test('identifierLaneTokens uses the D1 detector (dedup, prose excluded)', () => {
    assert.deepEqual(identifierLaneTokens('fixture symbol #3'), ['#3']);
    assert.deepEqual(identifierLaneTokens('where is ERR_LEASE_EXPIRED raised, ERR_LEASE_EXPIRED?'), ['ERR_LEASE_EXPIRED']);
    assert.deepEqual(identifierLaneTokens('how does the on-call rotation work and/or escalate'), []);
});

await test('pinIdentifierMatches: tokens-matched desc, then rarest token, then pool order; unmatched extras dropped', () => {
    const r = [
        asLore(node('a', { content: 'uses common.ts' })),
        asLore(node('b', { content: 'plain' })),
        asLore(node('c', { content: 'uses common.ts and RARE_ID' })),
        asLore(node('d', { content: 'uses common.ts' })),
    ];
    const extras = [asLore(node('e', { content: 'RARE_ID here' })), asLore(node('f', { content: 'nothing' }))];
    const { ordered, pinned } = pinIdentifierMatches(r, extras, ['common.ts', 'RARE_ID']);
    // c matches both; e matches RARE_ID (freq 2) — rarer than common.ts (freq 3) — so e before a, d.
    assert.deepEqual(pinned.map((n) => n.id), ['c', 'e', 'a', 'd']);
    assert.deepEqual(ordered.map((n) => n.id), ['c', 'e', 'a', 'd', 'b']);
});

await test('pinIdentifierMatches: capped at MAX_PINNED, no tokens is identity', () => {
    const r = Array.from({ length: 30 }, (_, i) => asLore(node(`n${i}`, { content: 'see common.ts' })));
    const { pinned, ordered } = pinIdentifierMatches(r, [], ['common.ts']);
    assert.equal(pinned.length, MAX_PINNED);
    assert.deepEqual(ordered.map((n) => n.id), r.map((n) => n.id), 'all match → D3 order kept');
    assert.deepEqual(pinIdentifierMatches(r, [], []).ordered.map((n) => n.id), r.map((n) => n.id));
});

await test('candidateFloor 50: exact match outside every window is pinned at rank 1; decoy "#30" is not', async () => {
    const { ctx } = mockCtx(fixture());
    const out = await retrieve(ctx, QUERY, { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50 });
    assert.equal(ids(out)[0], 'target');
    assert.ok(!ids(out).includes('decoy'), 'whole-token match only');
    assert.deepEqual(out.results[0]!.matchedBy, ['bm25']);
});

await test('candidateFloor 50: prefix-stable with the lane (k ∈ {1,3,5,10,20,50})', async () => {
    const top50 = ids(await retrieve(mockCtx(fixture()).ctx, QUERY, { workspace: 'w', depth: 0, limit: 50, candidateFloor: 50 }));
    assert.equal(top50[0], 'target');
    for (const k of [1, 3, 5, 10, 20, 50]) {
        const got = ids(await retrieve(mockCtx(fixture()).ctx, QUERY, { workspace: 'w', depth: 0, limit: k, candidateFloor: 50 }));
        assert.deepEqual(got, top50.slice(0, k), `k=${k}`);
    }
});

await test('lane fetch size is fixed (IDENTIFIER_LANE_FETCH) at every limit', async () => {
    for (const limit of [5, 50]) {
        const { ctx, calls } = mockCtx(fixture());
        await retrieve(ctx, QUERY, { workspace: 'w', depth: 0, limit, candidateFloor: 50 });
        assert.deepEqual(calls.bm25.filter(([q]) => q === '#3').map(([, n]) => n), [IDENTIFIER_LANE_FETCH], `limit=${limit}`);
        assert.deepEqual(calls.search.filter(([q]) => q === '#3').map(([, n]) => n), [IDENTIFIER_LANE_FETCH], `limit=${limit}`);
    }
});

await test('legacy (candidateFloor 0): lane never runs, output unchanged', async () => {
    const { ctx, calls } = mockCtx(fixture());
    const out = await retrieve(ctx, QUERY, { workspace: 'w', depth: 0, limit: 10, candidateFloor: 0 });
    assert.ok(!calls.bm25.some(([q]) => q === '#3'));
    assert.ok(!calls.search.some(([q]) => q === '#3'));
    assert.ok(!ids(out).includes('target'));
});

await test("mode:'semantic': lane never runs", async () => {
    const { ctx, calls } = mockCtx(fixture());
    const out = await retrieve(ctx, QUERY, { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50, mode: 'semantic' });
    assert.ok(!calls.bm25.some(([q]) => q === '#3'));
    assert.ok(!ids(out).includes('target'));
});

await test('lane rows pass the seed filters: archived / other ecosystem / missing tag / wrong type / wrong project / entity-topic mismatch are never pinned', async () => {
    for (const [over, opts] of [
        [{ status: 'archived' }, {}],
        [{ ecosystem: 'other' }, { ecosystem: 'mine' }],
        [{}, { tags: ['keep'] }],
        [{ type: 'note' }, { types: ['code_symbol'] }],
        [{ project: 'other-project' }, { project: 'w' }],
        [{ metadata: JSON.stringify({ entities: ['unrelated'] }) }, { entities: ['needed'] }],
        [{ metadata: JSON.stringify({ topics: ['unrelated'] }) }, { topics: ['needed'] }],
    ] as Array<[Partial<Node>, Record<string, unknown>]>) {
        const cfg = fixture();
        cfg.nodes.target = { ...cfg.nodes.target!, ...over };
        const out = await retrieve(mockCtx(cfg).ctx, QUERY, { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50, ...opts });
        assert.ok(!ids(out).includes('target'), JSON.stringify(over) + JSON.stringify(opts));
    }
});

await test('lane rows pass actor-scope filtering: a row scoped outside the caller\'s scopes is never pinned', async () => {
    const cfg = fixture();
    cfg.nodes.target = { ...cfg.nodes.target!, security_scopes: ['secret'] };
    const out = await runWithActor({ portalUserId: 'u1', scopes: ['public'] }, () =>
        retrieve(mockCtx(cfg).ctx, QUERY, { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50 }));
    assert.ok(!ids(out).includes('target'));
});

await test('lane rows pass in-scope actor filtering: a row scoped within the caller\'s scopes IS pinned', async () => {
    const cfg = fixture();
    cfg.nodes.target = { ...cfg.nodes.target!, security_scopes: ['secret'] };
    const out = await runWithActor({ portalUserId: 'u1', scopes: ['secret'] }, () =>
        retrieve(mockCtx(cfg).ctx, QUERY, { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50 }));
    assert.ok(ids(out).includes('target'));
});

await test('a pinned lane row that is superseded is replaced by its live successor (D5, same as any seed)', async () => {
    const cfg = fixture();
    cfg.nodes.target = { ...cfg.nodes.target!, supersededBy: 'succ', supersededAt: NOW };
    cfg.nodes.succ = node('succ', { content: 'the live successor, no #3 mention' });
    const out = await retrieve(mockCtx(cfg).ctx, QUERY, { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50 });
    assert.ok(!ids(out).includes('target'), 'superseded row itself is gone');
    assert.ok(ids(out).includes('succ'), 'successor takes its slot');
});

await test('with includeSuperseded, the superseded pinned row stays (not replaced)', async () => {
    const cfg = fixture();
    cfg.nodes.target = { ...cfg.nodes.target!, supersededBy: 'succ', supersededAt: NOW };
    cfg.nodes.succ = node('succ', { content: 'the live successor, no #3 mention' });
    const out = await retrieve(mockCtx(cfg).ctx, QUERY, { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50, includeSuperseded: true });
    assert.ok(ids(out).includes('target'));
});

await test('graph keyword leg alone (no verbatim row) still feeds the lane', async () => {
    const cfg = fixture();
    cfg.bm25ByQuery['#3'] = [];
    cfg.searchByQuery = { '#3': [cfg.nodes.target!] };
    const out = await retrieve(mockCtx(cfg).ctx, QUERY, { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50 });
    assert.equal(ids(out)[0], 'target');
    assert.deepEqual(out.results[0]!.matchedBy, ['keyword']);
});

await test('no identifier token: lane is a no-op (no token fetch)', async () => {
    const { ctx, calls } = mockCtx(fixture());
    await retrieve(ctx, 'fixture symbol body', { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50 });
    assert.equal(calls.bm25.length, 1, 'only the whole-query bm25 leg');
});

await test('containsWholeToken: a token starting with a non-word char carries its own left delimiter — "#3" matches inside "PR#3" but not "#30"', () => {
    // Intended, documented behaviour: `#3`'s leading `#` is a non-word char,
    // so it already delimits the left side regardless of what precedes it
    // (`R` in `PR#3` is fine). The trailing `3` IS a word char, so the right
    // side still needs a non-word/end boundary — `#30`'s trailing `0` fails it.
    assert.equal(containsWholeToken('see PR#3 fixed', '#3'), true);
    assert.equal(containsWholeToken('see #30 instead', '#3'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

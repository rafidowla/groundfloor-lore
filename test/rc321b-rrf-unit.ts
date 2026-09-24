#!/usr/bin/env tsx
/**
 * test/rc321b-rrf-unit.ts — Lore 3.21 step 3(b): the ONE shared RRF.
 *
 *   1. RRF math (k=60) against hand-computed expected scores.
 *   2. Deterministic tie-break — fused score desc, then id asc.
 *   3. A list-order property test — the fused order for many randomly
 *      generated list sets always matches a naive reference implementation
 *      (independently computed, not by calling rrfFuse itself).
 *   4. A regression test PER CONVERTED FUSION SITE — pinning that the
 *      owner-flagged bugs (searchTool.ts's "first list wins" dedupe-merge,
 *      recallCrossWorkspace.ts's Math.max-of-incomparable-scales) are gone,
 *      and that retrieve.ts / verbatimHybridSearch.ts's fusion still
 *      produces RRF-correct output after the consolidation.
 */

import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { rrfFuse, rrfFuseIds, rrfFuseScores, type RankedList } from '../packages/lore/src/recall/rrf.js';
import { registerSearchTool } from '../packages/lore/src/mcp/tools/search/searchTool.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('RC321b — the shared rrfFuse() (3.21 step 3b)\n');

/* ─── 1. RRF math (k=60) ──────────────────────────────────────────────── */

test('math: two disjoint lists — RRF(doc) = 1/(60+rank+1) for its only list', () => {
    const out = rrfFuse([['a', 'b'], ['c', 'd']]);
    const byId = new Map(out.map((r) => [r.id, r]));
    // a: rank 0 in list 1 only → 1/(60+0+1) = 1/61
    assert.ok(Math.abs(byId.get('a')!.rrf - 1 / 61) < 1e-12);
    // c: rank 0 in list 2 only → 1/61 too (same rank, different list — same raw rrf)
    assert.ok(Math.abs(byId.get('c')!.rrf - 1 / 61) < 1e-12);
    // b: rank 1 in list 1 → 1/62
    assert.ok(Math.abs(byId.get('b')!.rrf - 1 / 62) < 1e-12);
});

test('math: an id in BOTH lists sums its per-list contributions', () => {
    // 'x' at rank 0 in list A and rank 2 in list B → 1/61 + 1/63
    const out = rrfFuse([['x', 'a1'], ['b1', 'b2', 'x']]);
    const x = out.find((r) => r.id === 'x')!;
    const expected = 1 / (60 + 0 + 1) + 1 / (60 + 2 + 1);
    assert.ok(Math.abs(x.rrf - expected) < 1e-12, `expected ${expected}, got ${x.rrf}`);
    // x has the highest raw rrf here (two contributions) → normalized score 1.0
    assert.equal(x.score, 1);
    assert.equal(x.listsMatched, 2);
});

test('math: custom k parameter changes the formula, not just a scale factor', () => {
    const out60 = rrfFuse([['a']], 60);
    const out1 = rrfFuse([['a']], 1);
    assert.ok(Math.abs(out60[0]!.rrf - 1 / 61) < 1e-12);
    assert.ok(Math.abs(out1[0]!.rrf - 1 / 2) < 1e-12);
});

test('math: score is ignored — only rank POSITION drives fusion (scale-agnostic by design)', () => {
    // Two lists with wildly different, incomparable score scales attached —
    // rrfFuse must produce the SAME fused order as the bare-id form, proving
    // it never reads `.score`.
    const withScores: RankedList = [{ id: 'a', score: 0.99 }, { id: 'b', score: 0.01 }];
    const bareIds: RankedList = ['a', 'b'];
    assert.deepEqual(rrfFuseIds([withScores]), rrfFuseIds([bareIds]));
});

/* ─── 2. Deterministic tie-break ─────────────────────────────────────── */

test('tie-break: identical fused score → id ascending, not insertion order', () => {
    // 'zebra' and 'alpha' both at rank 0 of their OWN single-item list — tied rrf.
    const out = rrfFuse([['zebra'], ['alpha']]);
    assert.deepEqual(out.map((r) => r.id), ['alpha', 'zebra'], 'id-ascending tie-break, regardless of list order');
});

test('tie-break: reversed list registration order does not change the fused order', () => {
    const a = rrfFuseIds([['zebra'], ['alpha'], ['mike']]);
    const b = rrfFuseIds([['mike'], ['zebra'], ['alpha']]);
    assert.deepEqual(a, b, 'fused order must be independent of which list is passed first');
    assert.deepEqual(a, ['alpha', 'mike', 'zebra']);
});

test('tie-break: a genuine rank win still beats the id-ascending fallback', () => {
    // 'b' wins by rank (appears in 2 lists); 'a' and 'c' are tied and fall to id order.
    const out = rrfFuse([['b', 'a'], ['b', 'c']]);
    assert.deepEqual(out.map((r) => r.id), ['b', 'a', 'c']);
});

/* ─── 3. List-order property test ────────────────────────────────────── */

/** Independent reference implementation — deliberately NOT sharing any code
 *  with rrfFuse, so this is a real cross-check, not a tautology. */
function naiveRrf(lists: string[][], k = 60): Array<{ id: string; rrf: number }> {
    const scores = new Map<string, number>();
    for (const list of lists) {
        for (let i = 0; i < list.length; i++) {
            const id = list[i]!;
            scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
        }
    }
    return [...scores.entries()]
        .map(([id, rrf]) => ({ id, rrf }))
        .sort((a, b) => (b.rrf - a.rrf) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

test('property: rrfFuse matches an independent reference implementation across many random list sets', () => {
    const alphabet = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let trial = 0; trial < 200; trial++) {
        const numLists = 1 + Math.floor(rand() * 4);
        const lists: string[][] = [];
        for (let l = 0; l < numLists; l++) {
            const shuffled = [...alphabet].sort(() => rand() - 0.5);
            const len = 1 + Math.floor(rand() * alphabet.length);
            lists.push(shuffled.slice(0, len));
        }
        const expected = naiveRrf(lists);
        const actual = rrfFuse(lists);
        assert.deepEqual(
            actual.map((r) => r.id),
            expected.map((r) => r.id),
            `trial ${trial}: fused order diverged from the reference impl for lists ${JSON.stringify(lists)}`,
        );
        for (let i = 0; i < expected.length; i++) {
            assert.ok(
                Math.abs(actual[i]!.rrf - expected[i]!.rrf) < 1e-9,
                `trial ${trial}: rrf score mismatch for id ${expected[i]!.id}`,
            );
        }
    }
});

test('property: fusing a list with itself never changes relative order (idempotent order, not score)', () => {
    const list = ['c', 'a', 'b'];
    const single = rrfFuseIds([list]);
    const doubled = rrfFuseIds([list, list]);
    assert.deepEqual(single, doubled, 'a list fused with an identical copy of itself preserves order');
});

/* ─── 4. Regression test per converted fusion site ───────────────────── */

test('site: recall/retrieve.ts hybrid seed fusion — rrfFuseScores normalizes 0..1, top item = 1', () => {
    // Mirrors retrieve.ts's own usage: semantic ids + bm25 ids → per-id score.
    const semanticIds = ['n1', 'n2'];
    const bm25Ids = ['n2', 'n3'];
    const scores = rrfFuseScores([semanticIds, bm25Ids]);
    assert.equal(scores.get('n2'), 1, 'n2 (in both lists) is the top-scored, normalized fused item');
    assert.ok(scores.get('n1')! > 0 && scores.get('n1')! < 1);
    assert.ok(scores.get('n3')! > 0 && scores.get('n3')! < 1);
});

test('site: engines/verbatimHybridSearch.ts — fuseHybridVerbatim() score matches rrfFuse directly', async () => {
    const { fuseHybridVerbatim } = await import('../packages/lore/src/engines/verbatimHybridSearch.js');
    const semantic = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }];
    const bm25Value = { hits: [{ id: 'b', text: 'B' }, { id: 'c', text: 'C' }], ranked: true };
    const fused = fuseHybridVerbatim(semantic, bm25Value);
    const expected = rrfFuse([['a', 'b'], ['b', 'c']]);
    assert.deepEqual(fused.map((f) => f.hit.id), expected.map((r) => r.id));
    fused.forEach((f, i) => assert.ok(Math.abs(f.score - expected[i]!.score) < 1e-9));
});

test('site: mcp/tools/search/searchTool.ts workspace="*" — a node in BOTH keyword+semantic must outrank a single-list node (the fixed "first-writer-wins" bug)', () => {
    // Regression proof at the rrfFuse() level (the level searchTool.ts now
    // calls): under the OLD code, a node found by keyword FIRST kept its
    // keyword-rank score (1/(i+1)) forever, even after also being found by
    // semantic search at rank 0 — so a node found by BOTH could rank BELOW a
    // node found by keyword alone at rank 0, which is backwards. RRF fuses
    // rank contributions from every list, so "found by both" always beats
    // "found by only one" at equal individual ranks.
    const kwIds = ['solo', 'both'];   // 'solo' kw-rank 0, 'both' kw-rank 1
    const semanticIds = ['both'];      // 'both' semantic-rank 0
    const fused = rrfFuse([kwIds, semanticIds]);
    assert.equal(fused[0]!.id, 'both', '"both" (found by keyword AND semantic) must rank above "solo" (keyword only)');
});

test('site: mcp/tools/recallCrossWorkspace.ts per-workspace fusion — rank fusion, not a raw-score Math.max across incomparable scales', () => {
    // Regression proof at the rrfFuse() level (the level
    // recallCrossWorkspace.ts now calls, per-workspace, before the
    // cross-workspace max-of-fused-scores dedup). Under the OLD code, a
    // node with a LOW raw cosine similarity (say 0.1) beaten by a synthetic
    // keyword score (capped at 0.3) could flip the "winning" source/score
    // via a bare Math.max of the two numbers — comparing two incomparable
    // scales directly. RRF instead fuses RANK POSITION: a semantic-rank-0 hit
    // and a keyword-rank-0 hit for the SAME id combine into one higher fused
    // score than either alone, regardless of the (ignored) raw numbers.
    const semanticIds = ['n-both', 'n-sem-only'];
    const kwIds = ['n-both', 'n-kw-only'];
    const fused = rrfFuse([semanticIds, kwIds]);
    const byId = new Map(fused.map((r) => [r.id, r]));
    assert.ok(
        byId.get('n-both')!.rrf > byId.get('n-sem-only')!.rrf,
        'a node found by both channels must fuse to a higher score than one found by semantic alone',
    );
    assert.ok(
        byId.get('n-both')!.rrf > byId.get('n-kw-only')!.rrf,
        'a node found by both channels must fuse to a higher score than one found by keyword alone',
    );
    assert.equal(byId.get('n-both')!.listsMatched, 2);
});

await testAsync('end-to-end: MCP `search` workspace="*" real handler fuses via rrfFuse (not first-writer-wins)', async () => {
    // 'both' is rank 1 in the keyword scan but rank 0 in the semantic scan —
    // under the OLD "Map.set skip-if-present" code it would have kept its
    // keyword-rank score (1/2) and could rank BELOW a node found only by
    // keyword at rank 0. It must now rank FIRST (found by both channels).
    type FNode = { id: string; type: string; label: string; content: string; tags: string[]; project: string; ecosystem: string; updatedAt: string };
    const fnode = (id: string): FNode => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'w', ecosystem: '*', updatedAt: '2026-06-01T00:00:00.000Z' });
    const NODES: Record<string, FNode> = { solo: fnode('solo'), both: fnode('both') };
    const graph = {
        async search() { return [NODES.solo!, NODES.both!]; }, // kw rank: solo=0, both=1
        async getNode(id: string) { return NODES[id] ?? null; },
        async getNodesByIds() { return new Map<string, FNode>(); },
        async listNodes() { return []; },
    };
    const store = {
        loreGraph: graph,
        storageClient: {
            async verbatimSearch() { return [{ id: 'lore:both', score: 0.9 }]; }, // semantic rank: both=0 only
        },
    };
    const toolDeps = { store, detectedScope: { workspace: 'w', ecosystem: '*' } } as unknown as SearchToolsDeps;
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    const fake = { tool(name: string, _d: string, _s: unknown, h: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) { handlers.set(name, h); } };
    registerSearchTool(fake as unknown as McpServer, toolDeps);
    const res = await handlers.get('search')!({ query: 'q', workspace: '*', search_mode: 'hybrid' });
    assert.ok(!res.isError, res.content[0]?.text);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.results[0].id, 'both', '"both" (keyword rank 1 + semantic rank 0) must fuse ABOVE "solo" (keyword rank 0 only)');
    assert.deepEqual([...body.results[0].matchedBy].sort(), ['keyword', 'semantic']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

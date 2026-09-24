#!/usr/bin/env tsx
/**
 * d3-prefix-stable-ranking-unit.ts — D3 (docs/design/D3-prefix-stable-ranking.md).
 *
 * Pins:
 *   - candidateWindow.ts's pure resolution/anchoring functions (env-var edge
 *     cases, clamping, legacy fallbacks).
 *   - retrieve()'s candidate-generation window is independent of the
 *     caller's `limit` (prefix property: top-k@k is the first k of
 *     top-candLimit@candLimit, for every k <= candidateFloor).
 *   - `candidateFloor: 0` restores pre-D3 (legacy) window sizing exactly.
 *   - a lexical-only (keyword/BM25-only) seed can never outrank a stronger
 *     semantic match via the raw RRF/rank-position artefact, under the
 *     default `anchored` lexical-base mode.
 *   - `graph.search` receives `candLimit`, not `limit`.
 *   - the deterministic tie-break (final score desc, then candidate-order
 *     index asc, then id asc) in ranking.ts's reRankLoreNodes.
 *   - `possibleStarvation` stays keyed to `limit`, not `candLimit`.
 *
 * Fully mocked context (no DB) — same fake-ctx pattern as
 * test/audit-ra2-retrieve-core-unit.ts, extended to (a) actually TRUNCATE
 * the mock verbatim/keyword lists to the `limit` argument each call
 * receives (real stores do this; audit-ra2's mock does not need to, since
 * it never varies window size) and (b) record every `limit` a call site
 * was invoked with, so the candLimit-vs-limit distinction is observable.
 */

import assert from 'node:assert/strict';
import { retrieve, type RetrieveContext, type RetrieveOutcome } from '../packages/lore/src/recall/retrieve.js';
import {
    resolveCandidateFloor,
    candidateLimit,
    resolveLexicalBase,
    lexicalOnlyBase,
    stableProv,
    lexicalSelectivity,
    DEFAULT_CANDIDATE_FLOOR,
    MAX_CANDIDATE_FLOOR,
} from '../packages/lore/src/recall/candidateWindow.js';
import { reRankLoreNodes } from '../packages/lore/src/recall/ranking.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type Node = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; updatedAt: string; status?: string; metadata?: string;
};
const NOW = '2026-09-23T00:00:00.000Z';
const node = (id: string, over: Partial<Node> = {}): Node => ({
    id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'w', ecosystem: '*', updatedAt: NOW, ...over,
});
const curatedNode = (id: string, over: Partial<Node> = {}): Node =>
    node(id, { metadata: JSON.stringify({ curated: true }), ...over });

interface MockCfg {
    verbatimCount?: number;
    semantic?: Array<{ id: string; score: number }>;   // pre-sorted DESC, as a real store returns
    bm25?: Array<{ id: string; score: number }>;
    nodes?: Record<string, Node>;
    searchHits?: Node[];
}

function mockCtx(cfg: MockCfg): {
    ctx: RetrieveContext;
    calls: { search: number[]; semantic: number[]; bm25: number[] };
} {
    const calls = { search: [] as number[], semantic: [] as number[], bm25: [] as number[] };
    const graph = {
        async search(_q: string, n: number) { calls.search.push(n); return (cfg.searchHits ?? []).slice(0, n) as never; },
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
                async verbatimSearch(_q: string, n: number) { calls.semantic.push(n); return (cfg.semantic ?? []).slice(0, n) as never; },
                async verbatimBm25Search(_q: string, n: number) { calls.bm25.push(n); return { hits: (cfg.bm25 ?? []).slice(0, n), ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
    return { ctx, calls };
}

const ids = (out: RetrieveOutcome): string[] => out.results.map((r) => r.node.id);

console.log('D3 — prefix-stable ranking');

// ── candidateWindow.ts pure-function edge cases ────────────────────────────

await test('resolveCandidateFloor: no opt, no env -> legacy (0) — review round 2 gating rule flipped the default back', () => {
    delete process.env.LORE_RECALL_CANDIDATE_FLOOR;
    assert.equal(resolveCandidateFloor(undefined), 0);
});

await test('resolveCandidateFloor: explicit 0 is legacy, stays 0 (not defaulted)', () => {
    assert.equal(resolveCandidateFloor(0), 0);
});

await test('resolveCandidateFloor: explicit negative falls back to legacy (0), not DEFAULT_CANDIDATE_FLOOR', () => {
    assert.equal(resolveCandidateFloor(-5), 0);
});

await test('resolveCandidateFloor: explicit DEFAULT_CANDIDATE_FLOOR (50) remains a valid opt-in value', () => {
    assert.equal(resolveCandidateFloor(DEFAULT_CANDIDATE_FLOOR), 50);
});

await test('resolveCandidateFloor: explicit value above MAX clamps to MAX', () => {
    assert.equal(resolveCandidateFloor(9999), MAX_CANDIDATE_FLOOR);
});

await test('resolveCandidateFloor: non-integer opt floors down', () => {
    assert.equal(resolveCandidateFloor(12.9), 12);
});

await test('resolveCandidateFloor: env var honored when opt omitted', () => {
    process.env.LORE_RECALL_CANDIDATE_FLOOR = '30';
    try { assert.equal(resolveCandidateFloor(undefined), 30); }
    finally { delete process.env.LORE_RECALL_CANDIDATE_FLOOR; }
});

await test('resolveCandidateFloor: garbage env value falls back to legacy (0)', () => {
    process.env.LORE_RECALL_CANDIDATE_FLOOR = 'not-a-number';
    try { assert.equal(resolveCandidateFloor(undefined), 0); }
    finally { delete process.env.LORE_RECALL_CANDIDATE_FLOOR; }
});

await test('resolveCandidateFloor: env "0" is honored as legacy', () => {
    process.env.LORE_RECALL_CANDIDATE_FLOOR = '0';
    try { assert.equal(resolveCandidateFloor(undefined), 0); }
    finally { delete process.env.LORE_RECALL_CANDIDATE_FLOOR; }
});

await test('candidateLimit: floor 0 -> candLimit === limit exactly (legacy)', () => {
    assert.equal(candidateLimit(1, 0), 1);
    assert.equal(candidateLimit(50, 0), 50);
});

await test('candidateLimit: floor > 0 -> max(limit, floor)', () => {
    assert.equal(candidateLimit(1, 50), 50);
    assert.equal(candidateLimit(80, 50), 80);
});

await test('resolveLexicalBase: default is rrf (legacy) — review round 2 gating rule flipped the default back; anchored only on exact opt/env match', () => {
    delete process.env.LORE_RECALL_LEXICAL_BASE;
    assert.equal(resolveLexicalBase(undefined), 'rrf');
    assert.equal(resolveLexicalBase('anchored'), 'anchored');
    process.env.LORE_RECALL_LEXICAL_BASE = 'ANCHORED';
    try { assert.equal(resolveLexicalBase(undefined), 'anchored', 'env is case-insensitive'); }
    finally { delete process.env.LORE_RECALL_LEXICAL_BASE; }
    process.env.LORE_RECALL_LEXICAL_BASE = 'bogus';
    try { assert.equal(resolveLexicalBase(undefined), 'rrf', 'unrecognised env falls back to rrf (legacy)'); }
    finally { delete process.env.LORE_RECALL_LEXICAL_BASE; }
});

await test('lexicalOnlyBase: rrf mode or no semantic floor -> raw provenance unchanged', () => {
    // mode==='rrf' and semFloor===undefined both bypass regardless of
    // semTop/selectivity — signature is (prov, semFloor, semTop, mode, selectivity).
    assert.equal(lexicalOnlyBase(0.95, 0.5, 0.9, 'rrf', 1), 0.95);
    assert.equal(lexicalOnlyBase(0.95, undefined, undefined, 'anchored', 1), 0.95);
});

await test('lexicalOnlyBase: anchored mode, selectivity=0 reduces EXACTLY to the pre-review semFloor * prov formula', () => {
    // Review round 2: a broad/common (non-selective) lexical-only match keeps
    // the ORIGINAL ceiling (semFloor) byte-for-byte — this is what preserves
    // the negatives-suppression property validated in round 1.
    assert.equal(lexicalOnlyBase(1.0, 0.5, 0.9, 'anchored', 0), 0.5);
    assert.equal(lexicalOnlyBase(0.2, 0.5, 0.9, 'anchored', 0), 0.1);
});

await test('lexicalOnlyBase: anchored mode, selectivity=1 lets the ceiling reach semTop (strength-aware)', () => {
    // Review round 2 fix: a selective/rare match (e.g. a unique identifier)
    // can now rise all the way to semTop instead of being capped at semFloor.
    assert.equal(lexicalOnlyBase(1.0, 0.5, 0.9, 'anchored', 1), 0.9);
    // Partial selectivity interpolates linearly between semFloor and semTop.
    assert.equal(lexicalOnlyBase(1.0, 0.5, 0.9, 'anchored', 0.5), 0.7, '0.5 + 0.5*(0.9-0.5) = 0.7');
    // prov still scales everything below the ceiling -- a low-rank row in a
    // selective leg does not automatically jump to the ceiling.
    assert.equal(lexicalOnlyBase(0.5, 0.5, 0.9, 'anchored', 1), 0.45, '0.5 * 0.9 = 0.45');
});

await test('lexicalSelectivity: 0 candidates -> 0 (never boosted, safe fallback); full window -> ~0; single hit in a wide window -> ~1', () => {
    assert.equal(lexicalSelectivity(0, 50), 0, 'no bm25 leg ran at all');
    assert.ok(lexicalSelectivity(50, 50) <= 0.03, 'leg filled the whole window -> common/broad match, near 0');
    assert.equal(lexicalSelectivity(1, 50), 1, 'leg matched exactly one row out of a 50-wide window -> maximally selective');
    assert.ok(lexicalSelectivity(25, 50) > 0.4 && lexicalSelectivity(25, 50) < 0.6, 'half-full window is mid-selectivity');
});

await test('stableProv: floor<=0 or no rrf value -> raw prov unchanged (legacy path untouched)', () => {
    assert.equal(stableProv(0.5, undefined, 50), 0.5, 'no rrf value (e.g. plain keyword-rank prov) passes through unchanged');
    assert.equal(stableProv(0.5, 0.9, 0), 0.5, 'candidateFloor:0 (full legacy) never applies the fixed-normalization fix');
});

await test('stableProv: review round 2 fix — normalizes by a FIXED constant, not the window-dependent max (undoes rrfFuse dilution)', () => {
    // A rank-0-in-one-list raw rrf value is 1/(k+1); the fixed normalization
    // (rrf * (k+1)) should map that back to exactly 1.0 regardless of what
    // else populated the fused list that produced this raw rrf value.
    const rawRrfForRank0 = 1 / 61; // DEFAULT_K=60
    assert.equal(stableProv(0.3 /* stale window-dependent prov, ignored */, rawRrfForRank0, 50), 1, 'rank-0-in-one-list normalizes to 1.0 no matter what the window-dependent `prov` used to say');
    // Widening the window (more candidates admitted) must NOT shrink this --
    // that is precisely the dilution bug being fixed. Same raw rrf in, same
    // stableProv out, independent of candLimit itself (the function doesn't
    // even take candLimit -- it only needs floor>0 to know D3 is active).
    assert.equal(stableProv(0.3, rawRrfForRank0, 200), 1, 'stable regardless of how wide the window got');
});

// ── ranking.ts deterministic tie-break ──────────────────────────────────────

await test('reRankLoreNodes: exact score ties break by candidate-order index, then id', () => {
    type N = { id: string; type: string; updatedAt: string };
    const a: N = { id: 'z', type: 'note', updatedAt: NOW };
    const b: N = { id: 'a', type: 'note', updatedAt: NOW };
    // Same base score for both -> finalScore ties. Candidate order is [a, b]
    // (z first, "a" second) so index order must win over id order.
    const scores = new Map([['z', 0.5], ['a', 0.5]]);
    const out = reRankLoreNodes([a, b], Date.parse(NOW), scores, undefined);
    assert.deepEqual(out.map((n) => n.id), ['z', 'a'], 'index order preserved on an exact tie');
});

await test('reRankLoreNodes: id-less candidates (no baseScore lookup) still tie-break deterministically', () => {
    type N = { type: string; updatedAt: string };
    const nodes: N[] = [{ type: 'note', updatedAt: NOW }, { type: 'note', updatedAt: NOW }, { type: 'note', updatedAt: NOW }];
    const out1 = reRankLoreNodes(nodes, Date.parse(NOW));
    const out2 = reRankLoreNodes(nodes, Date.parse(NOW));
    assert.deepEqual(out1, out2, 'repeated calls over the same input produce the same order');
});

// ── retrieve() candidate-window behaviour ───────────────────────────────────

function buildPrefixFixture() {
    // 4 "decoy" top-raw-score non-curated hits (ranks 1-4), then a curated
    // hit at raw rank 5 whose post-boost finalScore beats every decoy, then
    // 55 more filler hits filling out a 60-candidate corpus (covers k=50).
    //
    // Every node here uses type:'task' — NOT one of DEFAULT_SCHEMA_V2's six
    // operatorCurated:true node types (decision/convention/note/bug_pattern/
    // architecture/troubleshooting; see schemas/types.ts). node()'s default
    // type is 'note', which IS in that list, so an earlier version of this
    // fixture had every node (decoys included) getting the SAME 1.5x
    // typeBias + 1.2x type-driven curationBoost (curationBoost() awards 1.2x
    // for either metadata.curated===true OR curated-type-with-a-label — see
    // ranking.ts) — cur1's metadata boost was real but added no RELATIVE
    // advantage since decoys got an identical multiplier via the type path,
    // so ranking silently degenerated to plain base-score order and the
    // "curated hit wins" assertions below failed. Using a non-curated type
    // isolates the metadata-only boost this fixture is actually meant to
    // exercise.
    const decoyType = { type: 'task' };
    const semantic: Array<{ id: string; score: number }> = [];
    const nodes: Record<string, Node> = {};
    const push = (id: string, score: number, n: Node) => { semantic.push({ id: `lore:${id}`, score }); nodes[id] = n; };
    push('d1', 0.50, node('d1', decoyType));
    push('d2', 0.49, node('d2', decoyType));
    push('d3', 0.48, node('d3', decoyType));
    push('d4', 0.47, node('d4', decoyType));
    push('cur1', 0.44, curatedNode('cur1', decoyType)); // 0.44 * 1.2 curationBoost = 0.528 > every decoy
    for (let i = 6; i <= 60; i++) {
        const score = 0.43 - (i - 6) * 0.005;
        push(`f${i}`, Math.max(score, 0.01), node(`f${i}`, decoyType));
    }
    return { semantic, nodes };
}

await test('D3 prefix property: top-k@k is the first k of top-50@50, for k in {1,5,10,20,50} (candidateFloor:50, opt-in)', async () => {
    const { semantic, nodes } = buildPrefixFixture();
    const { ctx } = mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] });
    const out50 = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, limit: 50, candidateFloor: 50 });
    assert.equal(ids(out50)[0], 'cur1', 'sanity: the curated hit should win once it is in the candidate pool at all');
    for (const k of [1, 5, 10, 20, 50]) {
        const { ctx: ctxK } = mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] });
        const outK = await retrieve(ctxK, 'q', { workspace: 'w', depth: 0, limit: k, candidateFloor: 50 });
        assert.deepEqual(ids(outK), ids(out50).slice(0, k), `top-${k}@${k} must equal the first ${k} of top-50@50`);
    }
});

await test('D3 meta: candidateWindow/prefixStableUpTo reflect candLimit, not limit (candidateFloor:50, opt-in)', async () => {
    const { semantic, nodes } = buildPrefixFixture();
    const { ctx } = mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, limit: 3, candidateFloor: 50 });
    assert.equal(out.meta.prefixStableUpTo, 50, 'explicit candidateFloor=50 dominates a small limit');
    assert.ok(out.meta.candidateWindow >= 50, `candidateWindow (${out.meta.candidateWindow}) should be sized off candLimit, not limit=3`);
});

await test('D3 legacy escape hatch: candidateFloor:0 makes candLimit === limit exactly, and IS now the shipped default', async () => {
    const { semantic, nodes } = buildPrefixFixture();
    const { ctx } = mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, limit: 3, candidateFloor: 0 });
    assert.equal(out.meta.prefixStableUpTo, 3, 'legacy: candLimit === limit');
    const { ctx: ctxDefault } = mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] });
    const outDefault = await retrieve(ctxDefault, 'q', { workspace: 'w', depth: 0, limit: 3 });
    assert.equal(outDefault.meta.prefixStableUpTo, 3, 'review round 2 gating rule: no explicit option -> same as candidateFloor:0');
});

await test('D3 opt-in candidateFloor:50 changes the actual winner vs. the shipped legacy default (inequality proof)', async () => {
    const { semantic, nodes } = buildPrefixFixture();
    const { ctx: ctxLegacy } = mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] });
    const legacyDefault = await retrieve(ctxLegacy, 'q', { workspace: 'w', depth: 0, limit: 1 });
    const { ctx: ctxNew } = mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] });
    const withFloor = await retrieve(ctxNew, 'q', { workspace: 'w', depth: 0, limit: 1, candidateFloor: 50 });
    assert.equal(ids(legacyDefault)[0], 'd1', 'shipped default (no option = candidateFloor:0): window (seedFetch=limit*4=4) never reaches the curated hit at raw rank 5');
    assert.equal(ids(withFloor)[0], 'cur1', 'explicit opt-in floor=50: the curated hit is in the window and wins after boost');
    assert.notEqual(ids(legacyDefault)[0], ids(withFloor)[0], 'the two modes must disagree on this fixture — that IS the D3 bug the opt-in floor fixes');
});

await test('D3: graph.search (keyword seed leg) receives candLimit, not limit (candidateFloor:50, opt-in)', async () => {
    const { semantic, nodes } = buildPrefixFixture();
    const { ctx, calls } = mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] });
    await retrieve(ctx, 'q', { workspace: 'w', depth: 0, limit: 3, candidateFloor: 50 });
    assert.ok(calls.search.length > 0, 'runKeywordSeeds always runs (Finding 5.1)');
    assert.equal(calls.search[0], 50, 'graph.search must be called with candLimit (50), not limit (3)');
});

await test('D3 §3.5: a BROAD/common lexical-only seed can never outrank a stronger semantic match (anchored, opt-in — review round 2 flipped the shipped default back to legacy rrf)', async () => {
    const nodes: Record<string, Node> = {
        sem1: node('sem1'),
        sem2: node('sem2'),
        kw1: node('kw1'),
    };
    // sem2 (0.5) establishes a low semantic floor; sem1 (0.9) is the strong
    // semantic match. kw1 is keyword-only (graph.search rank 0 -> raw
    // provenance 1/(0+1) = 1.0), which on its own raw scale beats sem1. The
    // keyword leg here fills the whole 50-wide candidate window (kw1 plus 49
    // filler hits) -- review round 2's `lexicalSelectivity` reads that as a
    // BROAD/common match (selectivity ~0.02), so the strength-aware ceiling
    // stays pinned near semFloor, same as the pre-review formula.
    const filler = Array.from({ length: 49 }, (_, i) => node(`kwfiller${i}`));
    const { ctx } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:sem1', score: 0.9 }, { id: 'lore:sem2', score: 0.5 }],
        bm25: [],
        nodes,
        searchHits: [node('kw1'), ...filler],
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, limit: 3, candidateFloor: 50, lexicalBase: 'anchored' });
    assert.equal(ids(out)[0], 'sem1', 'anchored mode: kw1 (a broad/common match, ceiling ~semFloor) must rank below sem1 (0.9)');
});

await test('D3 review round 2: a SELECTIVE (rare/exact) lexical-only match reaches the top-3, unlike a broad one (anchored, opt-in)', async () => {
    const nodes: Record<string, Node> = {
        sem1: node('sem1'), sem2: node('sem2'), sem3: node('sem3'), sem4: node('sem4'), sem5: node('sem5'),
        kwRare: node('kwRare'),
        kwBroad: node('kwBroad'),
    };
    // 5 decoy semantic hits (semFloor=0.82, semTop=0.86). kwRare is the ONLY
    // hit its keyword leg finds (bm25CandidateCount=1 out of a 50-wide
    // window -> selectivity ~1 -> ceiling ~semTop) -- must land in the top-3
    // despite having no semantic score at all. kwBroad's own leg fills the
    // window (50 hits) -> selectivity ~0 -> ceiling ~semFloor -- must stay
    // OUT of the top-3, below every semantic decoy.
    //
    // graph.search is a single shared call in this harness, so kwRare and
    // kwBroad can't both be exercised through it in one retrieve() call with
    // independent selectivity; this test isolates kwRare's high-selectivity
    // path (a single-hit leg) and the companion "broad" behaviour is already
    // covered by the test above.
    const { ctx } = mockCtx({
        verbatimCount: 1,
        semantic: [
            { id: 'lore:sem1', score: 0.86 }, { id: 'lore:sem2', score: 0.85 },
            { id: 'lore:sem3', score: 0.84 }, { id: 'lore:sem4', score: 0.83 },
            { id: 'lore:sem5', score: 0.82 },
        ],
        bm25: [],
        nodes,
        searchHits: [node('kwRare')],
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, limit: 3, candidateFloor: 50, lexicalBase: 'anchored' });
    assert.ok(ids(out).slice(0, 3).includes('kwRare'), `a selective exact-match keyword hit must reach the top-3; got ${JSON.stringify(ids(out))}`);
});

await test('D3 §3.5: legacy rrf mode restores the pre-D3 behaviour (lexical-only CAN outrank via raw score)', async () => {
    const nodes: Record<string, Node> = {
        sem1: node('sem1'),
        sem2: node('sem2'),
        kw1: node('kw1'),
    };
    const { ctx } = mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:sem1', score: 0.9 }, { id: 'lore:sem2', score: 0.5 }],
        bm25: [],
        nodes,
        searchHits: [node('kw1')],
    });
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, limit: 3, lexicalBase: 'rrf' });
    assert.equal(ids(out)[0], 'kw1', 'rrf mode: kw1 keeps its raw provenance score (1.0), which beats sem1 (0.9)');
});

await test('D3 review round 3: candidateFloor > 0 forces anchored (floor-only + rrf is not a reachable combination)', async () => {
    // floor=50 + rrf let `stableProv`'s fixed RRF normalization (no ceiling in
    // rrf mode) lift a glue-word keyword match to ~1.0 above the true semantic
    // top hit -- real-10k hit@1 (chatty) 87.5% -> 4.2%. The floor now forces
    // anchored mode regardless of option/env.
    assert.equal(resolveLexicalBase('rrf', 50), 'anchored');
    assert.equal(resolveLexicalBase(undefined, 1), 'anchored');
    assert.equal(resolveLexicalBase('rrf', 0), 'rrf', 'floor 0 still honours rrf (legacy)');
    process.env.LORE_RECALL_LEXICAL_BASE = 'rrf';
    try { assert.equal(resolveLexicalBase(undefined, 50), 'anchored', 'env rrf is overridden by an active floor'); }
    finally { delete process.env.LORE_RECALL_LEXICAL_BASE; }
    const nodes: Record<string, Node> = { sem1: node('sem1'), sem2: node('sem2'), kw1: node('kw1') };
    const filler = Array.from({ length: 49 }, (_, i) => node(`kwfiller${i}`));
    for (const f of filler) nodes[f.id] = f;
    const mk = () => mockCtx({
        verbatimCount: 1,
        semantic: [{ id: 'lore:sem1', score: 0.9 }, { id: 'lore:sem2', score: 0.5 }],
        bm25: [],
        nodes,
        searchHits: [node('kw1'), ...filler],
    }).ctx;
    const floorOnly = await retrieve(mk(), 'q', { workspace: 'w', depth: 0, limit: 3, candidateFloor: 50, lexicalBase: 'rrf' });
    const paired = await retrieve(mk(), 'q', { workspace: 'w', depth: 0, limit: 3, candidateFloor: 50, lexicalBase: 'anchored' });
    assert.equal(ids(floorOnly)[0], 'sem1', `floor-only must not let a broad keyword match outrank the semantic top hit; got ${JSON.stringify(ids(floorOnly))}`);
    assert.deepEqual(floorOnly.results.map((r) => [r.node.id, r.score]), paired.results.map((r) => [r.node.id, r.score]));
});

await test('D3: possibleStarvation stays keyed to `limit`, not `candLimit` (constant across both)', async () => {
    // A "corpus" that always fills whatever window it is asked for (so the
    // starvation retry loop maxes out), but only 2 rows ever survive
    // hydration (nodes not present -> dropped). candLimit is 50 for BOTH
    // calls below (explicit candidateFloor:50 opt-in dominates limit=2 and
    // limit=5 alike) — so if possibleStarvation tracked candLimit instead of
    // limit, both calls would report the same value. They must not.
    const infiniteSemantic = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `lore:ghost${i}`, score: 0.9 - i * 0.0001 }));
    const nodes: Record<string, Node> = { ghost0: node('ghost0'), ghost1: node('ghost1') };
    const mkCfg = (): MockCfg => ({
        verbatimCount: 1,
        get semantic() { return undefined; }, // unused; using custom store below
        nodes,
    });
    void mkCfg;
    const ctxFor = (n: number) => {
        const calls = { search: [] as number[], semantic: [] as number[], bm25: [] as number[] };
        const graph = {
            async search() { return [] as never; },
            async getNodesByIds(ids2: string[]) {
                const m = new Map<string, Node>();
                for (const id of ids2) { const nd = nodes[id]; if (nd) m.set(id, nd); }
                return m as never;
            },
            async traverse() { return [] as never; },
        };
        const ctx = {
            store: {
                loreGraph: graph,
                sessionCache: { pushNode() {} },
                storageClient: {
                    async verbatimCount() { return 1; },
                    async verbatimSearch(_q: string, win: number) { calls.semantic.push(win); return infiniteSemantic(win) as never; },
                    async verbatimBm25Search() { return { hits: [], ranked: true } as never; },
                },
            },
        } as unknown as RetrieveContext;
        return ctx;
    };
    const outSmallLimit = await retrieve(ctxFor(0), 'q', { workspace: 'w', depth: 0, limit: 5, candidateFloor: 50 });
    const outAtSurvivorCount = await retrieve(ctxFor(0), 'q', { workspace: 'w', depth: 0, limit: 2, candidateFloor: 50 });
    assert.equal(outSmallLimit.results.length, 2, 'only 2 rows ever hydrate');
    assert.equal(outAtSurvivorCount.results.length, 2, 'only 2 rows ever hydrate');
    assert.equal(outSmallLimit.meta.possibleStarvation, true, 'limit=5 > 2 survivors, window stayed saturated -> starved');
    assert.equal(outAtSurvivorCount.meta.possibleStarvation, false, 'limit=2 === survivor count -> NOT starved, even though candLimit(50) is identical to the other call');
});

await test('D3 review: starvation-retry growth is keyed to candLimit, so hidden-row starvation cannot break the prefix property', async () => {
    // First window (candLimit 50 * headroom 4 = 200): 185 archived rows + 15
    // live rows. limit=10 has >=10 live seeds and would stop; limit=50 does
    // not, so a `seeds.length < limit` retry condition grows the window ONLY
    // for limit=50 — pulling in `late`, a curated row at raw rank 250 whose
    // boosted score beats every first-window live row. Then top-10@10 !=
    // first 10 of top-50@50. Keying the retry to candLimit makes both calls
    // see the same (grown) window.
    const semantic: Array<{ id: string; score: number }> = [];
    const nodes: Record<string, Node> = {};
    const t = { type: 'task' };
    for (let i = 0; i < 400; i++) {
        const id = i === 250 ? 'late' : `r${i}`;
        const score = 0.99 - i * 0.0005;
        semantic.push({ id: `lore:${id}`, score });
        const hidden = i < 200 && i % 13 !== 0; // 15 of the first 200 are live
        nodes[id] = id === 'late'
            ? curatedNode(id, t)
            // Integration with D5: superseded rows are no longer dropped at the
            // seed stage (D5 replaces them with successors after ranking), so
            // they no longer starve the window. Archived rows still are
            // seed-filtered, so they exercise the same starvation-retry path.
            : node(id, { ...t, ...(hidden ? { status: 'archived' } : {}) });
    }
    const out50 = await retrieve(mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] }).ctx, 'q', { workspace: 'w', depth: 0, limit: 50, candidateFloor: 50 });
    const out10 = await retrieve(mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] }).ctx, 'q', { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50 });
    assert.equal(ids(out50)[0], 'late', 'sanity: the boosted late row wins once the window grows');
    assert.deepEqual(ids(out10), ids(out50).slice(0, 10), 'top-10@10 must equal first 10 of top-50@50 even when the retry path fires');
    // Legacy (floor 0) must still retry off `limit` exactly as pre-D3.
    const { ctx: legacyCtx, calls } = mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] });
    await retrieve(legacyCtx, 'q', { workspace: 'w', depth: 0, limit: 10, candidateFloor: 0 });
    assert.deepEqual(calls.semantic.slice(0, 1), [40], 'legacy first window is limit*4');
});

// ── Integration (integ/d-all): D3 x D2 / D3 x D5 ──────────────────────────

await test('D3 x D2: the widened candLimit window still carries the D2 `types` prefilter on every leg', async () => {
    const seen: Array<{ leg: string; n: number; type?: unknown }> = [];
    const nodes: Record<string, Node> = { a: node('a', { type: 'decision' }) };
    const graph = {
        async search(_q: string, n: number, _w: unknown, _e: unknown, _x: unknown, _s: unknown, types?: string[]) { seen.push({ leg: 'keyword', n, type: types }); return [] as never; },
        async getNodesByIds(ids2: string[]) { const m = new Map<string, Node>(); for (const id of ids2) if (nodes[id]) m.set(id, nodes[id]); return m as never; },
        async traverse() { return [] as never; },
    };
    const ctx = {
        store: {
            loreGraph: graph, sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 1; },
                async verbatimSearch(_q: string, n: number, f?: { type?: unknown }) { seen.push({ leg: 'semantic', n, type: f?.type }); return [{ id: 'lore:a', score: 0.9 }] as never; },
                async verbatimBm25Search(_q: string, n: number, f?: { type?: unknown }) { seen.push({ leg: 'bm25', n, type: f?.type }); return { hits: [], ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, limit: 5, candidateFloor: 50, types: ['decision'] });
    assert.deepEqual(ids(out), ['a']);
    for (const leg of ['semantic', 'bm25', 'keyword']) {
        const calls = seen.filter((c) => c.leg === leg);
        assert.ok(calls.length > 0, `${leg} leg consulted`);
        for (const c of calls) assert.deepEqual(c.type, ['decision'], `${leg} leg carries the types filter`);
    }
    assert.ok(seen.filter((c) => c.leg === 'semantic').every((c) => c.n >= 50 * 4), 'semantic window is keyed to candLimit (50*headroom), not limit');
    assert.ok(seen.filter((c) => c.leg === 'keyword').every((c) => c.n === 50), 'keyword leg gets candLimit');
});

await test('D3 x D5: superseded direct matches are refilled from the widened ranked spillover, prefix property intact', async () => {
    // 20 semantic rows; the top 3 are superseded (no successor edge), so D5
    // drops them and refills from the ranked spillover. With candidateFloor
    // 50 the spillover is the SAME ranked candidate list for every limit,
    // so top-k@k is still the first k of the larger call.
    const semantic: Array<{ id: string; score: number }> = [];
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < 20; i++) {
        semantic.push({ id: `lore:s${i}`, score: 0.95 - i * 0.01 });
        nodes[`s${i}`] = node(`s${i}`, i < 3 ? ({ supersededAt: NOW, supersededBy: 'gone' } as Partial<Node>) : {});
    }
    const mk = () => mockCtx({ verbatimCount: 1, semantic, bm25: [], nodes, searchHits: [] }).ctx;
    const out5 = await retrieve(mk(), 'q', { workspace: 'w', depth: 0, limit: 5, candidateFloor: 50 });
    const out10 = await retrieve(mk(), 'q', { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50 });
    assert.ok(!ids(out10).some((id) => ['s0', 's1', 's2'].includes(id)), 'superseded rows never surface');
    assert.equal(out5.results.length, 5, 'refilled back to limit');
    assert.deepEqual(ids(out5), ids(out10).slice(0, 5), 'prefix-stable after D5 replacement/refill');
});

// ── multi-query (`queries[]`) fusion under anchored lexical base ─────────────
//
// Integration finding (recall-eval, sqlite real-10k, floor=50): the queries[]
// variant (terse + queries:[chatty]) dropped hit@3 100% -> 83.3%, with the
// answer falling out of the top-10 entirely on 2/24 questions. Cause: a
// semantic row's base score is its BEST cosine across phrasings (max), but a
// lexical-only row's `stableProv` summed its RRF contribution across every
// phrasing's bm25 list before the fixed (single-list) normalization, so any
// row in the top ~60 of two bm25 lists clamped to 1.0 and sat AT the anchored
// ceiling (~semTop) — a flood of keyword-only rows tied with the answer.

await test('stableProv: multi-list lexical rows are normalized per matched list (no saturation from summing phrasings)', () => {
    const rank5 = 1 / (60 + 5 + 1);
    const single = stableProv(0.3, rank5, 50, 1);
    assert.ok(single < 1, 'sanity: rank-5 in one list is below 1');
    assert.equal(stableProv(0.3, 2 * rank5, 50, 2), single, 'rank-5 in BOTH phrasings\' lists == rank-5 in one (was clamped to 1.0)');
    assert.equal(stableProv(0.3, rank5, 50), single, 'listsMatched defaults to 1 (single-query path unchanged)');
    assert.equal(stableProv(0.3, 2 * rank5, 0, 2), 0.3, 'floor 0 (legacy) still passes prov through untouched');
});

function multiQueryFixture() {
    // Answer: top semantic hit (0.90) and top bm25 hit. s1 is a real semantic
    // neighbour (0.80), s2 sets semFloor (0.5). b1..b5 are keyword-only rows at bm25 ranks 1..5 with no
    // semantic support; the 6-row bm25 leg is selective (ceiling ~0.86), so
    // single-query anchored bases are b1..b4 ~0.85..0.81 > s1 > b5 ~0.79.
    // Every phrasing returns the SAME lists (the mock ignores
    // the query text), so a phrasing-stable ranker must give queries[] output
    // identical to the single-query output.
    const nodes: Record<string, Node> = { ans: node('ans'), s1: node('s1'), s2: node('s2') };
    const bm25: Array<{ id: string; score: number }> = [{ id: 'lore:ans', score: 9 }];
    for (let i = 1; i <= 5; i++) { nodes[`b${i}`] = node(`b${i}`); bm25.push({ id: `lore:b${i}`, score: 9 - i }); }
    const semantic = [{ id: 'lore:ans', score: 0.9 }, { id: 'lore:s1', score: 0.8 }, { id: 'lore:s2', score: 0.5 }];
    return () => mockCtx({ verbatimCount: 1, semantic, bm25, nodes, searchHits: [] }).ctx;
}

await test('D3 multi-query: identical phrasings give the SAME ranking as a single query (candidateFloor:50 -> anchored)', async () => {
    const mk = multiQueryFixture();
    const opts = { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50 } as const;
    const single = ids(await retrieve(mk(), 'q', opts));
    const multi = ids(await retrieve(mk(), 'q', { ...opts, queries: ['q phrased differently'] }));
    const triple = ids(await retrieve(mk(), 'q', { ...opts, queries: ['q2', 'q3'] }));
    assert.equal(single[0], 'ans', `sanity: single-query top-1 is the answer; got ${JSON.stringify(single)}`);
    assert.deepEqual(multi, single, 'queries[] (2 phrasings) must not re-rank keyword-only rows above semantic ones');
    assert.deepEqual(triple, single, 'queries[] (3 phrasings) likewise');
});

await test('D3 multi-query: a deep keyword-only row cannot overtake a real semantic neighbour just by recurring across phrasings', async () => {
    const mk = multiQueryFixture();
    const out = ids(await retrieve(mk(), 'q', { workspace: 'w', depth: 0, limit: 10, candidateFloor: 50, queries: ['q2'] }));
    assert.equal(out[0], 'ans');
    assert.ok(out.indexOf('s1') < out.indexOf('b5'), `s1 (0.80 cosine) must stay above bm25-rank-5 keyword-only b5 (was saturated to the ceiling); got ${JSON.stringify(out)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

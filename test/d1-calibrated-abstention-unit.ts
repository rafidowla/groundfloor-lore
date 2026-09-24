#!/usr/bin/env tsx
/**
 * test/d1-calibrated-abstention-unit.ts — D1 (calibrated relevance +
 * abstention).
 *
 * Uses a fake, deterministic embedding provider (a mocked
 * `storageClient.verbatimSearch`/`verbatimBm25Search`, exactly like
 * rc321f-recall-multi-query-unit.ts's `mockCtx` pattern) — no real embedding
 * model is downloaded or invoked. A query text NOT in a test's explicit
 * `overrides` map hashes to a low "noise" score against a fixed off-topic
 * node, standing in for both the 128 fixed calibration probes
 * (calibrationProbes.ts) AND a gibberish test query — both are "text this
 * workspace has nothing to do with", which is exactly the fake embedder's
 * only signal. A query IN `overrides` gets an explicit high score, standing
 * in for "text this workspace's content is actually about".
 *
 * Pins:
 *   - `_meta` calibration fields (topSimilarity/topRelevance/relevanceFloor/
 *     belowFloor/abstained/calibration{...}) are present on every
 *     `retrieve()` outcome, abstain on or off (design: calibration/`_meta`
 *     always on; only the short-circuit is gated by `abstain`).
 *   - raw `score` on a RetrievalResult is byte-identical whether or not
 *     `abstain` is passed — D1 is additive-only.
 *   - abstain:true + a gibberish query => zero results, `abstained:true`.
 *   - abstain:true + a small workspace (calibration `insufficient_rows`)
 *     => NOT abstained (flagged, not gated) even though the query is
 *     off-topic.
 *   - abstain:true + mode:'keyword' (no semantic leg consulted) => NOT
 *     abstained (topSimilarity/topRelevance stay null; nothing to gate on).
 *   - exact-identifier rescue: decideAbstention() directly — a belowFloor
 *     decision is overridden when the query's identifier-shaped token
 *     appears verbatim in a seed's content.
 *   - cross-workspace fallback (`notApplicableRelevanceMeta`): never
 *     abstains, reports `calibration.status: 'not_applicable'`.
 *   - retrievalProjection.ts / abstention.ts carry `similarity`/`relevance`
 *     and the snake_case `_meta` fields through unchanged.
 */

import assert from 'node:assert/strict';
import { retrieve, type RetrieveContext, type RetrieveOutcome, type RetrievalResult } from '../packages/lore/src/recall/retrieve.js';
import { _resetCalibrationCacheForTests, getCalibration, drainBackgroundCalibrations } from '../packages/lore/src/recall/calibration.js';
import { parseAbstainParam } from '../packages/lore/src/mcp/http/routes/searchRouteParams.js';
import { decideAbstention, buildRelevanceMeta, notApplicableRelevanceMeta, hasExactIdentifierRescue } from '../packages/lore/src/recall/abstention.js';
import { projectResults, projectScored } from '../packages/lore/src/recall/retrievalProjection.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type Node = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; updatedAt: string; status?: string; metadata?: string;
};
const node = (id: string, over: Partial<Node> = {}): Node => ({
    id, type: 'note', label: id, content: `content for ${id}`, tags: [], project: 'w', ecosystem: '*',
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});

const byId = (out: RetrieveOutcome, id: string): RetrievalResult | undefined =>
    out.results.find((r) => r.node.id === id);

/** Deterministic string -> [0,1) hash (FNV-1a), so calibration probes and any
 *  unmapped ("gibberish") query text get a stable but VARIED noise score —
 *  varied is required for calibration's median/IQR fit to be non-degenerate. */
function hashFrac(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return ((h >>> 0) % 10000) / 10000;
}

const NOISE_NODE_ID = 'workspace-noise-anchor';

interface MockCfg {
    nodes: Record<string, Node>;
    /** exact-query-text -> explicit high-relevance hits (the "this workspace
     *  really is about X" case). Anything NOT here falls back to the
     *  deterministic low-score noise anchor (calibration probes + gibberish
     *  queries alike). */
    overrides?: Record<string, Array<{ id: string; score: number }>>;
    bm25ByQuery?: Record<string, Array<{ id: string; score?: number }>>;
    /** verbatim row count the fake store reports (default: well above
     *  calibration's MIN_ROWS_FOR_CALIBRATION=20). */
    verbatimRows?: number;
}

function mockCtx(cfg: MockCfg): { ctx: RetrieveContext; searchCalls: string[] } {
    const searchCalls: string[] = [];
    const allNodes: Record<string, Node> = { [NOISE_NODE_ID]: node(NOISE_NODE_ID, { content: 'unrelated filler content' }), ...cfg.nodes };
    const graph = {
        async search() { return [] as never; }, // graph keyword leg: none in these fixtures
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = allNodes[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return [] as never; },
    };
    const ctx = {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return cfg.verbatimRows ?? 200; },
                async verbatimSearch(q: string, limit: number) {
                    searchCalls.push(q);
                    const override = cfg.overrides?.[q];
                    if (override) return override.slice(0, limit).map((h) => ({ id: `lore:${h.id}`, score: h.score }));
                    // Noise floor: 0.05..0.15, varied per query text.
                    return [{ id: `lore:${NOISE_NODE_ID}`, score: 0.05 + 0.10 * hashFrac(q) }];
                },
                async verbatimBm25Search(q: string, limit: number) {
                    const hits = (cfg.bm25ByQuery?.[q] ?? []).slice(0, limit);
                    return { hits: hits.map((h) => ({ id: `lore:${h.id}`, score: h.score })), ranked: true } as never;
                },
            },
        },
    } as unknown as RetrieveContext;
    return { ctx, searchCalls };
}

console.log('D1 — calibrated scores + abstention');

await test('_meta calibration fields are present (hybrid, calibration ok, abstain default-off)', async () => {
    _resetCalibrationCacheForTests();
    const { ctx } = mockCtx({
        nodes: { relevant: node('relevant', { content: 'OAuth2 authentication flow implementation' }) },
        overrides: { q1: [{ id: 'relevant', score: 0.92 }] },
    });
    // D1 follow-up: abstain defaults to off, so the very first call on a fresh
    // workspace launches the fit in the background and comes back 'pending'
    // (see the dedicated non-blocking-calibration tests below). Warm the cache
    // first so this test can still assert the landed ('ok') field shape.
    await retrieve(ctx, 'q1', { workspace: 'ws-meta-1', mode: 'hybrid', depth: 0 });
    await drainBackgroundCalibrations(5000);
    const out = await retrieve(ctx, 'q1', { workspace: 'ws-meta-1', mode: 'hybrid', depth: 0 });
    assert.equal(out.meta.calibration.status, 'ok');
    assert.equal(typeof out.meta.topSimilarity, 'number');
    assert.equal(typeof out.meta.topRelevance, 'number');
    assert.equal(out.meta.relevanceFloor, 2.0);
    assert.equal(out.meta.belowFloor, false);
    assert.equal(out.meta.abstained, false);
    assert.equal(out.meta.calibration.scope, 'ws-meta-1');
});

await test('raw score is byte-identical whether abstain is passed or not (additive-only)', async () => {
    _resetCalibrationCacheForTests();
    const { ctx: ctxA } = mockCtx({
        nodes: { relevant: node('relevant', { content: 'OAuth2 authentication flow implementation' }) },
        overrides: { q1: [{ id: 'relevant', score: 0.92 }] },
    });
    // Warm the cache first: abstain:false no longer blocks on a fresh
    // workspace's first call (D1 follow-up), so the raw-similarity/relevance
    // number types this test checks need a landed fit to compare against.
    await retrieve(ctxA, 'q1', { workspace: 'ws-score-1', mode: 'hybrid', depth: 0, abstain: false });
    await drainBackgroundCalibrations(5000);
    const outA = await retrieve(ctxA, 'q1', { workspace: 'ws-score-1', mode: 'hybrid', depth: 0, abstain: false });
    _resetCalibrationCacheForTests();
    const { ctx: ctxB } = mockCtx({
        nodes: { relevant: node('relevant', { content: 'OAuth2 authentication flow implementation' }) },
        overrides: { q1: [{ id: 'relevant', score: 0.92 }] },
    });
    const outB = await retrieve(ctxB, 'q1', { workspace: 'ws-score-1', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor: 0.001 });
    const a = byId(outA, 'relevant'), b = byId(outB, 'relevant');
    assert.ok(a && b, 'both calls must return the relevant node');
    assert.equal(a!.score, b!.score, 'score must be unaffected by abstain/relevanceFloor');
    // similarity/relevance are additive fields only — never substitute for score.
    assert.equal(typeof a!.similarity, 'number');
    assert.equal(typeof a!.relevance, 'number');
});

await test('abstain default-off: an off-topic query still returns results even though belowFloor', async () => {
    _resetCalibrationCacheForTests();
    const { ctx } = mockCtx({ nodes: {} }); // no override => 'gibberish qzx qzx' hits the noise anchor
    const out = await retrieve(ctx, 'gibberish qzx qzx', { workspace: 'ws-default-off', mode: 'hybrid', depth: 0 });
    assert.equal(out.meta.abstained, false, 'abstain defaults to off — never gates results');
    assert.equal(out.results.length > 0, true, 'the noise-anchor node itself is still a valid keyword/semantic hit');
});

await test('abstain:true + gibberish query => zero results, abstained:true', async () => {
    _resetCalibrationCacheForTests();
    const { ctx } = mockCtx({ nodes: {} });
    const out = await retrieve(ctx, 'gibberish qzx qzx totally unrelated', { workspace: 'ws-gibberish', mode: 'hybrid', depth: 0, abstain: true });
    assert.equal(out.results.length, 0);
    assert.equal(out.meta.abstained, true);
    assert.equal(out.meta.calibration.status, 'ok');
    assert.equal(out.meta.belowFloor, true);
});

await test('abstain:true + small workspace (insufficient_rows) => NOT abstained', async () => {
    _resetCalibrationCacheForTests();
    const { ctx } = mockCtx({ nodes: {}, verbatimRows: 5 }); // < MIN_ROWS_FOR_CALIBRATION (20)
    const out = await retrieve(ctx, 'gibberish qzx qzx totally unrelated', { workspace: 'ws-small', mode: 'hybrid', depth: 0, abstain: true });
    assert.equal(out.meta.calibration.status, 'insufficient_rows');
    assert.equal(out.meta.abstained, false, 'a fit that is not trustworthy must never gate results');
    assert.equal(out.meta.belowFloor, false);
});

await test("abstain:true + mode:'keyword' (no semantic leg) => NOT abstained", async () => {
    _resetCalibrationCacheForTests();
    const { ctx, searchCalls } = mockCtx({
        nodes: { a: node('a') },
        bm25ByQuery: { 'anything': [{ id: 'a', score: 3 }] },
    });
    const out = await retrieve(ctx, 'anything', { workspace: 'ws-keyword', mode: 'keyword', depth: 0, abstain: true });
    // Review fix: keyword mode must never call the embedder — not even for calibration probes.
    assert.equal(searchCalls.length, 0, `keyword mode ran ${searchCalls.length} vector searches (calibration probes)`);
    assert.equal(out.meta.calibration.status, 'not_applicable');
    assert.equal(out.meta.topSimilarity, null, 'keyword mode never consults the semantic leg');
    assert.equal(out.meta.topRelevance, null);
    assert.equal(out.meta.abstained, false);
    assert.ok(out.results.length > 0, 'bm25 hit must still come through unaffected');
});

await test('exact-identifier rescue overrides an otherwise-abstained decision', () => {
    const belowFloorCalibration = { status: 'ok' as const, version: 'v1', probes: 128, rows: 200, nullMedian: 0.1, nullScale: 0.02 };
    const decision = decideAbstention({
        topSimilarity: 0.11, // z ≈ (0.11-0.1)/0.02 = 0.5, well below the 2.0 floor
        calibration: belowFloorCalibration,
        abstain: true,
        relevanceFloor: 2.0,
        query: 'what does foo.bar_baz do',
        seedContents: ['this node documents foo.bar_baz in detail'],
    });
    assert.equal(decision.belowFloor, true);
    assert.equal(decision.abstained, false, 'exact-identifier rescue must override the gate');
    assert.equal(decision.abstainOverridden, 'exact_identifier');

    // Sanity: WITHOUT the identifier appearing in seed content, it abstains.
    const decisionNoRescue = decideAbstention({
        topSimilarity: 0.11, calibration: belowFloorCalibration, abstain: true, relevanceFloor: 2.0,
        query: 'what does foo.bar_baz do', seedContents: ['unrelated content entirely'],
    });
    assert.equal(decisionNoRescue.abstained, true);
    assert.equal(decisionNoRescue.abstainOverridden, undefined);
});

await test('cross-workspace fallback meta: never abstains, calibration not_applicable', () => {
    const meta = notApplicableRelevanceMeta('cross_workspace');
    assert.equal(meta.abstained, false);
    assert.equal(meta.top_similarity, null);
    assert.equal(meta.top_relevance, null);
    assert.equal(meta.calibration.status, 'not_applicable');
    assert.equal(meta.calibration.scope, 'cross_workspace');
});

await test('buildRelevanceMeta projects retrieve()\'s meta into the shared snake_case _meta shape', async () => {
    _resetCalibrationCacheForTests();
    const { ctx } = mockCtx({
        nodes: { relevant: node('relevant') },
        overrides: { q1: [{ id: 'relevant', score: 0.9 }] },
    });
    const out = await retrieve(ctx, 'q1', { workspace: 'ws-buildmeta', mode: 'hybrid', depth: 0 });
    const meta = buildRelevanceMeta(out.meta);
    assert.equal(meta.top_similarity, out.meta.topSimilarity);
    assert.equal(meta.top_relevance, out.meta.topRelevance);
    assert.equal(meta.floor, out.meta.relevanceFloor);
    assert.equal(meta.below_floor, out.meta.belowFloor);
    assert.equal(meta.abstained, out.meta.abstained);
    assert.equal(meta.calibration.null_median, out.meta.calibration.nullMedian);
    assert.equal(meta.calibration.null_scale, out.meta.calibration.nullScale);
});

await test('retrievalProjection carries similarity/relevance through projectResults + projectScored', async () => {
    _resetCalibrationCacheForTests();
    const { ctx } = mockCtx({
        nodes: { relevant: node('relevant') },
        overrides: { q1: [{ id: 'relevant', score: 0.9 }] },
    });
    // Warm the cache: abstain defaults to off, so the first call on a fresh
    // workspace is 'pending' (D1 follow-up) and relevance would be null.
    await retrieve(ctx, 'q1', { workspace: 'ws-projection', mode: 'hybrid', depth: 0 });
    await drainBackgroundCalibrations(5000);
    const out = await retrieve(ctx, 'q1', { workspace: 'ws-projection', mode: 'hybrid', depth: 0 });
    const r = byId(out, 'relevant')!;
    assert.equal(typeof r.similarity, 'number');
    assert.equal(typeof r.relevance, 'number');

    const projected = projectResults(out.results);
    const p = projected.find((x) => x.id === 'relevant')!;
    assert.equal(p.similarity, r.similarity);
    assert.equal(p.relevance, r.relevance);

    // projectScored: same field carry-through, and legacy callers that never
    // pass similarity/relevance stay unaffected (absent, not null/0).
    const scored = projectScored([{ node: r.node as unknown as Parameters<typeof projectScored>[0][0]['node'], matchedBy: r.matchedBy, score: r.score, similarity: r.similarity, relevance: r.relevance }]);
    assert.equal(scored[0]!.similarity, r.similarity);
    const legacyScored = projectScored([{ node: r.node as unknown as Parameters<typeof projectScored>[0][0]['node'], matchedBy: ['keyword'], score: 0.5 }]);
    assert.equal('similarity' in legacyScored[0]!, false);
});

// ── Independent-review regression tests ──────────────────────────────────
function fakeSeedStore(opts: { identity?: object; fail?: () => boolean; base?: number }) {
    let calls = 0;
    const store = {
        calibrationIdentity: opts.identity,
        async count() { return 200; },
        async search(q: string) {
            calls++;
            if (opts.fail?.()) throw new Error('aborted');
            return [{ id: 'x', score: (opts.base ?? 0.1) + 0.1 * hashFrac(q) }];
        },
        async bm25Search() { return { hits: [], ranked: true }; },
    };
    return { store: store as unknown as Parameters<typeof getCalibration>[0], calls: () => calls };
}

await test("a transient 'unavailable' fit is retried after the window, not pinned until row drift", async () => {
    let failing = true;
    const s = fakeSeedStore({ identity: {}, fail: () => failing });
    const first = await getCalibration(s.store, 'ws-retry');
    assert.equal(first.status, 'unavailable');
    failing = false;
    const within = await getCalibration(s.store, 'ws-retry');
    assert.equal(within.status, 'unavailable', 'inside the retry window the cached failure is reused');
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
        const after = await getCalibration(s.store, 'ws-retry');
        assert.equal(after.status, 'ok', 'a stable-row-count store must re-fit after a transient failure');
    } finally { Date.now = realNow; }
});

await test('calibration cache is scoped per underlying store (reopen / second instance gets its own fit)', async () => {
    const a = fakeSeedStore({ identity: {}, base: 0.1 });
    const b = fakeSeedStore({ identity: {}, base: 0.6 });
    const fa = await getCalibration(a.store, 'ws-shared-name');
    const fb = await getCalibration(b.store, 'ws-shared-name');
    assert.equal(fa.status, 'ok'); assert.equal(fb.status, 'ok');
    assert.ok(b.calls() > 0, 'second store with the same workspace name must run its own probes');
    assert.notEqual(fa.nullMedian, fb.nullMedian);
});

await test('REST abstain param: absent => undefined (env default applies), true/false explicit', () => {
    assert.equal(parseAbstainParam(new URLSearchParams('q=x')), undefined);
    assert.equal(parseAbstainParam(new URLSearchParams('abstain=true')), true);
    assert.equal(parseAbstainParam(new URLSearchParams('abstain=false')), false);
    assert.equal(parseAbstainParam(new URLSearchParams('abstain=yes')), undefined);
});

// ── D1 follow-up: non-blocking calibration (independent review, item 2) ──
function gatedSeedStore(opts: { identity?: object } = {}) {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const store = {
        calibrationIdentity: opts.identity ?? {},
        async count() { return 200; },
        async search(q: string) {
            calls++;
            await gate; // every probe blocks here until the test releases the gate
            return [{ id: 'x', score: 0.1 + 0.1 * hashFrac(q) }];
        },
        async bm25Search() { return { hits: [], ranked: true }; },
    };
    return { store: store as unknown as Parameters<typeof getCalibration>[0], release: () => release!(), calls: () => calls };
}

await test('non-blocking calibration: abstain-off first call returns immediately with status pending', async () => {
    const s = gatedSeedStore();
    const start = Date.now();
    const first = await getCalibration(s.store, 'ws-nonblocking-1', '*', { blocking: false });
    const elapsed = Date.now() - start;
    assert.equal(first.status, 'pending');
    assert.ok(elapsed < 200, `blocking:false call took ${elapsed}ms — should return before any probe search resolves`);
    // release so the background fit (already launched) can finish, then drain it
    s.release();
    await drainBackgroundCalibrations(2000);
});

await test('non-blocking calibration: a later call sees the landed (non-pending) status', async () => {
    const s = gatedSeedStore();
    const first = await getCalibration(s.store, 'ws-nonblocking-2', '*', { blocking: false });
    assert.equal(first.status, 'pending');
    s.release(); // unblock every probe's search() await, including ones already in flight
    await drainBackgroundCalibrations(2000); // wait for the background fit to actually land
    const second = await getCalibration(s.store, 'ws-nonblocking-2', '*', { blocking: false });
    assert.equal(second.status, 'ok', 'once the background fit has landed, a subsequent call must see it, not another pending');
    assert.ok(s.calls() >= 100, 'the background fit must have actually run the probe set, not been skipped');
});

await test('non-blocking calibration: abstain-on still blocks until the fit resolves', async () => {
    const s = gatedSeedStore();
    let resolved = false;
    const p = getCalibration(s.store, 'ws-blocking-still', '*', { blocking: true }).then((r) => { resolved = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolved, false, 'blocking:true must not resolve while probes are still gated');
    s.release();
    const result = await p;
    assert.equal(resolved, true);
    assert.equal(result.status, 'ok');
});

await test('dispose with nothing in flight: drainBackgroundCalibrations resolves immediately', async () => {
    const start = Date.now();
    await drainBackgroundCalibrations(5000);
    assert.ok(Date.now() - start < 100, 'an empty backgroundFits set must not wait out the timeout');
});

await test('dispose during a pending fit: drain waits for a fit that lands within the bound, then exits cleanly', async () => {
    // A real, naturally-resolving delay (not an eternally-abandoned gate) —
    // this proves drainBackgroundCalibrations actually waits for an in-flight
    // fit up to its bound, without leaving an unsettled promise dangling at
    // process exit (Node's own top-level-await leak detector flags exactly
    // that shape, which is the same hazard Task 2's "abort-safe... must not
    // keep the process alive" requirement is about — the code path itself
    // uses an unref()'d race timer, verified separately by code review of
    // calibration.ts's drainBackgroundCalibrations).
    let release: (() => void) | undefined;
    const naturalDelay = new Promise<void>((r) => { release = r; setTimeout(() => r(), 30); });
    let calls = 0;
    const store = {
        calibrationIdentity: {},
        async count() { return 200; },
        async search(q: string) { calls++; await naturalDelay; return [{ id: 'x', score: 0.1 + 0.1 * hashFrac(q) }]; },
        async bm25Search() { return { hits: [], ranked: true }; },
    } as unknown as Parameters<typeof getCalibration>[0];
    const pending = await getCalibration(store, 'ws-natural-delay', '*', { blocking: false });
    assert.equal(pending.status, 'pending');
    const start = Date.now();
    await drainBackgroundCalibrations(5000); // bound is generous; the fit lands well inside it
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 4000, `drain should have waited for the real ~30ms fit, not the 5s bound (took ${elapsed}ms)`);
    assert.ok(calls >= 100, 'the background fit must have actually run to completion');
    void release; // keep the closure reference explicit; setTimeout already fired it
});

// ── D1 follow-up: exact-identifier rescue regex fix (independent review, item 3) ──
// D1 follow-up 2 (identifiers.json eval: found@10 95% -> 40% with abstain on):
// a '#'-sigil numbered reference ("#3", "#4821") IS an exact identifier and
// must rescue when it appears as a whole token in a seed; bare digits still
// never rescue, and matching is whole-token so "#3" can't ride on "#3333".
const FIXTURE_ROW_3 = 'export function renewLease(ctx: Context): Promise<Result> {\n  // lease-manager renew path, auto-generated fixture symbol #3\n  return ctx.lease_manager.renew();\n}';
await test('identifier rescue: "#N" numbered reference rescues when "#N" is a whole token in a seed', () => {
    assert.equal(hasExactIdentifierRescue('fixture symbol #3', [FIXTURE_ROW_3]), true);
    assert.equal(hasExactIdentifierRescue('fixture symbol #4821', ['see fixture symbol #4821 for details']), true);
});

await test('identifier rescue: "#N" must NOT rescue on a longer number or when absent', () => {
    const rows = ['auto-generated fixture symbol #3333', 'fixture symbol #30.', 'ticket #1234'];
    assert.equal(hasExactIdentifierRescue('fixture symbol #3', rows), false, '#3 is not #3333 / #30');
    assert.equal(hasExactIdentifierRescue('fixture symbol #999999', [FIXTURE_ROW_3, ...rows]), false);
    assert.equal(hasExactIdentifierRescue('fixture symbol #123', rows), false, '#123 is not #1234');
});

await test('identifier rescue: bare digits (no # sigil) never rescue', () => {
    assert.equal(hasExactIdentifierRescue('port 4821 refused', ['listening on port 4821']), false);
    assert.equal(hasExactIdentifierRescue('fixture symbol 3', [FIXTURE_ROW_3]), false);
});

await test('identifier rescue: identifiers match whole tokens only, not substrings of longer identifiers', () => {
    assert.equal(hasExactIdentifierRescue('dispatchBatch failed', ['function redispatchBatchNow() {}']), false);
    assert.equal(hasExactIdentifierRescue('fx-code-000123', ['row fx-code-0001234']), false);
    assert.equal(hasExactIdentifierRescue('see renewLease.ts.', ['renewLease (src/lease-manager/renewLease.ts)']), true, 'sentence-final punctuation is not part of the token');
});

await test('decideAbstention: below-floor "fixture symbol #3" is rescued by the stored row, "#999999" still abstains', () => {
    const cal = { status: 'ok' as const, version: 'v1', probes: 128, rows: 200, nullMedian: 0.1, nullScale: 0.02 };
    const base = { topSimilarity: 0.128, calibration: cal, abstain: true, relevanceFloor: 2.0 }; // z = 1.4, the eval's measured z
    const present = decideAbstention({ ...base, query: 'fixture symbol #3', seedContents: [FIXTURE_ROW_3] });
    assert.equal(present.belowFloor, true);
    assert.equal(present.abstained, false);
    assert.equal(present.abstainOverridden, 'exact_identifier');
    const absent = decideAbstention({ ...base, query: 'fixture symbol #999999', seedContents: [FIXTURE_ROW_3] });
    assert.equal(absent.abstained, true);
    assert.equal(absent.abstainOverridden, undefined);
});

await test('identifier rescue: all-lowercase concatenation with no separator/case-change/digit must NOT rescue', () => {
    const content = ['call dispatchbatch to process the queue'];
    assert.equal(hasExactIdentifierRescue('dispatchbatch', content), false);
});

await test('identifier rescue: camelCase, dotted/slashed paths, and long alnum mixes still rescue when present verbatim', () => {
    assert.equal(hasExactIdentifierRescue('dispatchBatch failed', ['function dispatchBatch() { ... }']), true);
    assert.equal(hasExactIdentifierRescue('see src/scheduler/dispatchBatch.ts', ['file: src/scheduler/dispatchBatch.ts']), true);
    assert.equal(hasExactIdentifierRescue('ctx.dead_letter_queue.purge broke', ['ctx.dead_letter_queue.purge() throws']), true);
    assert.equal(hasExactIdentifierRescue('code fx-code-000123 failed', ['ticket fx-code-000123 closed']), true);
});

await test('identifier rescue: token-shaped but absent from content must NOT rescue', () => {
    assert.equal(hasExactIdentifierRescue('dispatchBatch failed', ['nothing relevant here']), false);
});

// D1 follow-up 3: everyday hyphen/slash compounds are prose, not identifiers —
// they appear verbatim in stored notes and used to cancel abstention.
await test('identifier rescue: everyday hyphen/slash words and dotted abbreviations never rescue', () => {
    const prose = ['the on-call rota and follow-up notes, and/or the read-only replica; e.g. up-to-date and end-to-end checks'];
    for (const q of ['who is on-call', 'any follow-up', 'this and/or that', 'read-only mode', 'e.g. something', 'is it up-to-date', 'end-to-end test', 'Follow-up item']) {
        assert.equal(hasExactIdentifierRescue(q, prose), false, `"${q}" must not rescue`);
    }
});

await test('identifier rescue: kebab names and paths of 3+ plain segments still rescue; digits/dots/underscores unaffected', () => {
    assert.equal(hasExactIdentifierRescue('digital-employee-framework setup', ['repo digital-employee-framework']), true);
    assert.equal(hasExactIdentifierRescue('see packages/lore/src', ['under packages/lore/src there']), true);
    assert.equal(hasExactIdentifierRescue('fix/d5-supersedes-corrects', ['branch fix/d5-supersedes-corrects']), true);
    assert.equal(hasExactIdentifierRescue('lease-manager.ts', ['file lease-manager.ts']), true);
});

await test('identifier rescue: pinned trade-offs — slash paths and particle kebab names rescue; 2-part plain kebab/header names do not', () => {
    assert.equal(hasExactIdentifierRescue('packages/lore', ['in packages/lore']), true, 'any non-English slash pair is a path');
    assert.equal(hasExactIdentifierRescue('feature/login', ['branch feature/login']), true);
    assert.equal(hasExactIdentifierRescue('sign-in-service', ['the sign-in-service pod']), true, 'particles like "in" are not function words');
    assert.equal(hasExactIdentifierRescue('opt-out-handler', ['opt-out-handler.ts owner']), true);
    assert.equal(hasExactIdentifierRescue('groundfloor-lore', ['repo groundfloor-lore']), false, 'known trade-off: 2-part plain kebab');
    assert.equal(hasExactIdentifierRescue('Content-Type', ['header Content-Type']), false, 'known trade-off: 2-part header name');
    assert.equal(hasExactIdentifierRescue('state-of-the-art', ['a state-of-the-art index']), false);
    assert.equal(hasExactIdentifierRescue('fx-code-000123', ['ticket fx-code-000123']), true);
    assert.equal(hasExactIdentifierRescue('ERR_LEASE_EXPIRED', ['throws ERR_LEASE_EXPIRED']), true);
    assert.equal(hasExactIdentifierRescue('fixture symbol #3', ['fixture symbol #3 here']), true);
});

await test('decideAbstention: below-floor gibberish containing "on-call" still abstains even when prose has "on-call"', () => {
    const cal = { status: 'ok' as const, version: 'v1', probes: 128, rows: 200, nullMedian: 0.1, nullScale: 0.02 };
    const d = decideAbstention({ topSimilarity: 0.11, calibration: cal, abstain: true, relevanceFloor: 2.0, query: 'purple on-call elephants', seedContents: ['the on-call rota for March'] });
    assert.equal(d.abstained, true);
    assert.equal(d.abstainOverridden, undefined);
});

// ── Integration (integ/d-all): D1 x D3 (candidateFloor opt-in) ────────────

await test('D1 x D3: abstain:true still abstains a gibberish query with candidateFloor:50 (anchored lexical base)', async () => {
    _resetCalibrationCacheForTests();
    const { ctx } = mockCtx({ nodes: {} });
    const out = await retrieve(ctx, 'gibberish qzx qzx totally unrelated', { workspace: 'ws-d3-gib', mode: 'hybrid', depth: 0, abstain: true, candidateFloor: 50 });
    assert.equal(out.results.length, 0);
    assert.equal(out.meta.abstained, true);
    assert.equal(out.meta.calibration.status, 'ok');
});

await test('D1 x D3: per-hit similarity is the hit\'s own semantic score under candidateFloor:50, not the anchored base', async () => {
    _resetCalibrationCacheForTests();
    const { ctx } = mockCtx({
        nodes: { relevant: node('relevant', { content: 'OAuth2 authentication flow implementation' }) },
        overrides: { q1: [{ id: 'relevant', score: 0.92 }] },
    });
    const out = await retrieve(ctx, 'q1', { workspace: 'ws-d3-sim', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor: 0.001, candidateFloor: 50 });
    const r = byId(out, 'relevant');
    assert.ok(r, 'relevant node returned');
    assert.equal(out.meta.abstained, false);
    assert.equal(r!.similarity, 0.92, 'similarity = own raw cosine');
    assert.equal(typeof r!.relevance, 'number');
    assert.equal(out.meta.prefixStableUpTo, 50);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

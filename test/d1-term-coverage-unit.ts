#!/usr/bin/env tsx
/**
 * test/d1-term-coverage-unit.ts — D1 §3.10 key-term-coverage abstention signal.
 *
 * Pure-function pins on termCoverage.ts + decideAbstention()/buildRelevanceMeta(),
 * plus retrieve() end-to-end over a mocked verbatim store (fake deterministic
 * embedder, same pattern as d1-calibrated-abstention-unit.ts — no model is
 * downloaded or invoked).
 *
 * Pins:
 *   - extractQueryTerms: stopwords/question scaffolding dropped, identifiers
 *     kept whole with weight 2, dedup by stem.
 *   - lightStem: bare and inflected forms share a stem.
 *   - computeTermCoverage: weighted fraction, prefix match, identifiers-absent
 *     forces 0, no-terms => null.
 *   - decideAbstention: term_coverage only fires with abstain on, z in
 *     [floor, floor+margin), coverage < min; the exact-identifier rescue wins;
 *     no termCoverage input => byte-identical to the pre-change decision.
 *   - buildRelevanceMeta: abstain_reason / term_coverage snake_case.
 *   - retrieve(): option off by default; on => abstains with reason
 *     'term_coverage' when the top hits miss the query's terms, and not when
 *     they contain them; env var honoured, option wins over env.
 *   Review round 2 (one pin per finding):
 *   - #1 paraphrase: synonyms, acronym <-> expansion, number words, compounds.
 *   - #2 coverage is read from the FINAL fused order (a BM25-only hit counts).
 *   - #3 only strongly code-shaped identifiers force 0 (OAuth2/gRPC/… don't).
 *   - #4 the decision runs after the D3 lane: a lane-only identifier rescues.
 *   - #5 CJK / unsegmented scripts fail open.
 *   - #6 LORE_RECALL_TERM_COVERAGE_MIN clamped to [0,1]; with the flag off
 *     `_meta` has no abstainReason (identical to main).
 */

import assert from 'node:assert/strict';
import {
    extractQueryTerms, lightStem, computeTermCoverage, isStrongIdentifier,
    resolveTermCoverage, resolveTermCoverageMin, DEFAULT_TERM_COVERAGE_MIN,
} from '../packages/lore/src/recall/termCoverage.js';
import { decideAbstention, buildRelevanceMeta } from '../packages/lore/src/recall/abstention.js';
import { retrieve, type RetrieveContext } from '../packages/lore/src/recall/retrieve.js';
import { _resetCalibrationCacheForTests, drainBackgroundCalibrations } from '../packages/lore/src/recall/calibration.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const CAL = { status: 'ok' as const, version: 'v1', probes: 128, rows: 200, nullMedian: 0.1, nullScale: 0.02 };
// z = (sim - 0.1) / 0.02 → sim 0.16 = z 3.0 (inside [2, 4.5)), sim 0.25 = z 7.5.
const base = { calibration: CAL, relevanceFloor: 2.0, seedContents: ['unrelated seed text'] };
const tc = (coverage: number | null) => ({ coverage, min: 0.35, zMargin: 2.5 });

console.log('D1 §3.10 — term-coverage abstention');

await test('lightStem: bare and inflected forms share a stem', () => {
    for (const [a, b] of [['lease', 'leases'], ['queue', 'queues'], ['expire', 'expired'], ['expire', 'expires'], ['job', 'jobs'], ['retry', 'retries'], ['cache', 'caches']]) {
        assert.equal(lightStem(a), lightStem(b), `${a} vs ${b}`);
    }
    assert.equal(lightStem('class'), 'class');
    assert.equal(lightStem('bus'), 'bus');
});

await test('extractQueryTerms: drops stopwords/meta words, keeps identifiers whole (weight 2), dedups by stem', () => {
    const terms = extractQueryTerms('Why did we decide on the rule for job leases and lease renewal in fx-sched-004?');
    const words = terms.filter((t) => t.kind === 'word').map((t) => t.text);
    const ids = terms.filter((t) => t.kind === 'identifier');
    assert.deepEqual(ids.map((t) => t.text), ['fx-sched-004']);
    assert.equal(ids[0].weight, 2);
    for (const w of ['why', 'did', 'decide', 'rule', 'the']) assert.ok(!words.includes(w), `${w} dropped`);
    assert.ok(words.includes('job'));
    assert.equal(words.filter((w) => lightStem(w) === 'leas').length, 1, 'leases/lease deduped');
    assert.ok(words.includes('renewal'));
    assert.deepEqual(extractQueryTerms('what is it?'), [], 'pure scaffolding => no terms');
    assert.ok(extractQueryTerms('retained for 45 days').some((t) => t.text === '45'), '≥2-digit numbers kept');
});

await test('computeTermCoverage: weighted fraction, stem/prefix match, camelCase split', () => {
    const r = computeTermCoverage('worker lease expired duration', ['Workers renew their leases; expiration handled by the throttleLedger']);
    // worker ✓ lease ✓ expired~expiration (stem "expir" prefixes "expiration") ✓ duration ✗
    assert.equal(r.terms, 4);
    assert.deepEqual(r.missing, ['duration']);
    assert.equal(r.coverage, 0.75);
    assert.equal(computeTermCoverage('ledger throttle', ['throttleLedger class']).coverage, 1);
    assert.equal(computeTermCoverage('what is it', ['anything']).coverage, null);
});

await test('computeTermCoverage: identifiers weigh 2; all identifiers absent from EVERY seed => 0', () => {
    const r = computeTermCoverage('chargeInvoice retries', ['retries are capped'], ['retries are capped', 'other']);
    assert.equal(r.identifiersAbsent, true);
    assert.equal(r.coverage, 0, 'absent identifier forces 0 even though "retries" is covered');
    // Identifier present in the wider seed set but not the top-k: not forced to 0, weight 2 of 3 missing.
    const r2 = computeTermCoverage('chargeInvoice retries', ['retries are capped'], ['retries are capped', 'calls chargeInvoice']);
    assert.equal(r2.identifiersAbsent, false);
    assert.equal(Math.round(r2.coverage! * 100), 33);
});

await test('#1 paraphrase: synonyms, acronym <-> expansion, number words, compound words', () => {
    assert.equal(computeTermCoverage('outgoing callback signature', ['Outbound webhook payloads are signed with HMAC']).coverage, 1, 'synonyms');
    assert.equal(computeTermCoverage('command line daemon', ['The CLI ships with the daemon']).coverage, 1, 'command line -> CLI');
    assert.equal(computeTermCoverage('DLQ replay', ['Replaying from the dead letter queue is manual']).coverage, 1, 'DLQ -> phrase initials');
    assert.equal(computeTermCoverage('SLO per tier', ['service level objective targets per tier']).coverage, 1, 'acronym -> expansion');
    assert.equal(computeTermCoverage('thirty second lifetime', ['the request timeout is 30 seconds']).coverage, 1, 'number word + duration group');
    assert.equal(computeTermCoverage('postmortem outage', ['Writeup of the checkpoint stall incident']).coverage, 1, 'writeup/postmortem, stall/outage');
    assert.equal(computeTermCoverage('rate limiter', ['ratelimiter config']).coverage, 1, 'compound');
    // Still discriminating: an unrelated topic stays uncovered.
    assert.equal(computeTermCoverage('TLS certificate pinning', ['Workers renew job leases every 15s']).coverage, 0);
});

await test('#3 isStrongIdentifier: code-shaped only; weak names do not force 0', () => {
    for (const t of ['chargeInvoice', 'ERR_LEASE_EXPIRED', 'src/billing/x.ts', '#2500', 'fx-code-000123', 'ctx.router.send', 'transmuteWidget.ts', 'AbstractLeaseManagerFactory'])
        assert.ok(isStrongIdentifier(t), `strong: ${t}`);
    for (const t of ['OAuth2', 'gRPC', 'iPhone', 'Node.js', 'Worker-Lease-Timeout', 'PostgreSQL', 'v2'])
        assert.ok(!isStrongIdentifier(t), `weak: ${t}`);
    for (const q of ['OAuth2 token refresh', 'gRPC token refresh', 'iPhone token refresh', 'Node.js token refresh', 'Worker-Lease-Timeout token refresh']) {
        const r = computeTermCoverage(q, ['token refresh runs hourly']);
        assert.equal(r.identifiersAbsent, false, q);
        assert.ok((r.coverage ?? 0) > 0, `${q} not forced to 0`);
    }
    assert.equal(computeTermCoverage('chargeInvoice token refresh', ['token refresh runs hourly']).coverage, 0, 'strong absent => 0');
});

await test('#5 unsegmented scripts (CJK, Thai) fail open: coverage null, never gates', () => {
    for (const q of ['租户隔离是怎么做的', 'ワーカーのリース期限', 'การต่ออายุใบรับรอง', 'lease 续约 policy']) {
        const r = computeTermCoverage(q, ['completely unrelated english text']);
        assert.equal(r.coverage, null, q);
    }
    assert.equal(decideAbstention({ ...base, topSimilarity: 0.16, abstain: true, query: '租户隔离', termCoverage: tc(null) }).abstained, false);
});

await test('decideAbstention: no termCoverage input => unchanged decision, no reason/coverage fields', () => {
    const d = decideAbstention({ ...base, topSimilarity: 0.16, abstain: true, query: 'q' });
    assert.deepEqual(d, { topRelevance: 3, belowFloor: false, abstained: false });
    const below = decideAbstention({ ...base, topSimilarity: 0.11, abstain: true, query: 'q' });
    assert.equal(below.abstained, true);
    assert.equal(below.abstainReason, undefined, '#6: no reason without the term-coverage flag');
    assert.deepEqual(Object.keys(below).sort(), ['abstained', 'belowFloor', 'topRelevance']);
    assert.equal(decideAbstention({ ...base, topSimilarity: 0.11, abstain: true, query: 'q', reportReason: true }).abstainReason, 'below_floor');
});

await test('decideAbstention: term_coverage fires only when abstain on, z < floor+margin, coverage < min', () => {
    const hit = decideAbstention({ ...base, topSimilarity: 0.16, abstain: true, query: 'q', termCoverage: tc(0.2) });
    assert.equal(hit.abstained, true);
    assert.equal(hit.abstainReason, 'term_coverage');
    assert.equal(hit.termCoverage, 0.2);
    assert.equal(decideAbstention({ ...base, topSimilarity: 0.16, abstain: false, query: 'q', termCoverage: tc(0.2) }).abstained, false, 'abstain off');
    assert.equal(decideAbstention({ ...base, topSimilarity: 0.25, abstain: true, query: 'q', termCoverage: tc(0.0) }).abstained, false, 'z comfortably above floor');
    assert.equal(decideAbstention({ ...base, topSimilarity: 0.16, abstain: true, query: 'q', termCoverage: tc(0.5) }).abstained, false, 'coverage ok');
    assert.equal(decideAbstention({ ...base, topSimilarity: 0.16, abstain: true, query: 'q', termCoverage: tc(null) }).abstained, false, 'no terms never gates');
    // Below the floor, below_floor wins as the reason.
    assert.equal(decideAbstention({ ...base, topSimilarity: 0.11, abstain: true, query: 'q', termCoverage: tc(0) }).abstainReason, 'below_floor');
});

await test('decideAbstention: exact-identifier rescue overrides term_coverage', () => {
    const d = decideAbstention({
        ...base, topSimilarity: 0.16, abstain: true, query: 'what does foo.bar_baz do',
        seedContents: ['this node documents foo.bar_baz'], termCoverage: tc(0.1),
    });
    assert.equal(d.abstained, false);
    assert.equal(d.abstainOverridden, 'exact_identifier');
});

await test('buildRelevanceMeta: abstain_reason / term_coverage surface as snake_case', () => {
    const m = buildRelevanceMeta({
        topSimilarity: 0.16, topRelevance: 3, relevanceFloor: 2, belowFloor: false, abstained: true,
        abstainReason: 'term_coverage', termCoverage: 0.2,
        calibration: { ...CAL, scope: 'w' },
    } as never);
    assert.equal(m.abstain_reason, 'term_coverage');
    assert.equal(m.term_coverage, 0.2);
    const plain = buildRelevanceMeta({ topSimilarity: 0.16, topRelevance: 3, relevanceFloor: 2, belowFloor: false, abstained: false, calibration: { ...CAL, scope: 'w' } } as never);
    assert.ok(!('abstain_reason' in plain) && !('term_coverage' in plain));
});

await test('resolveTermCoverage / resolveTermCoverageMin: option wins, env fallback, default off / 0.1, clamped', () => {
    const saved = { a: process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE, m: process.env.LORE_RECALL_TERM_COVERAGE_MIN };
    try {
        delete process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE;
        delete process.env.LORE_RECALL_TERM_COVERAGE_MIN;
        assert.equal(resolveTermCoverage(undefined), false);
        assert.equal(resolveTermCoverageMin(), DEFAULT_TERM_COVERAGE_MIN);
        process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE = '1';
        process.env.LORE_RECALL_TERM_COVERAGE_MIN = '0.5';
        assert.equal(resolveTermCoverage(undefined), true);
        assert.equal(resolveTermCoverage(false), false, 'option wins over env');
        assert.equal(resolveTermCoverageMin(), 0.5);
        process.env.LORE_RECALL_TERM_COVERAGE_MIN = '5';
        assert.equal(resolveTermCoverageMin(), 1, '#6 clamp high');
        process.env.LORE_RECALL_TERM_COVERAGE_MIN = '-0.3';
        assert.equal(resolveTermCoverageMin(), 0, '#6 clamp low');
        process.env.LORE_RECALL_TERM_COVERAGE_MIN = 'junk';
        assert.equal(resolveTermCoverageMin(), DEFAULT_TERM_COVERAGE_MIN);
    } finally {
        if (saved.a === undefined) delete process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE; else process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE = saved.a;
        if (saved.m === undefined) delete process.env.LORE_RECALL_TERM_COVERAGE_MIN; else process.env.LORE_RECALL_TERM_COVERAGE_MIN = saved.m;
    }
});

// ── retrieve() end-to-end over a mocked store ──────────────────────────────
type Node = { id: string; type: string; label: string; content: string; tags: string[]; project: string; ecosystem: string; updatedAt: string };
const node = (id: string, content: string): Node => ({ id, type: 'note', label: id, content, tags: [], project: 'w', ecosystem: '*', updatedAt: '2026-06-01T00:00:00.000Z' });
function hashFrac(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return ((h >>> 0) % 10000) / 10000;
}
function mockCtx(
    nodes: Record<string, Node>, overrides: Record<string, Array<{ id: string; score: number }>>,
    bm25: Record<string, Array<{ id: string; score: number }>> = {}, keyword: Record<string, string[]> = {},
): RetrieveContext {
    const all: Record<string, Node> = { noise: node('noise', 'unrelated filler content'), ...nodes };
    return {
        store: {
            loreGraph: {
                async search(q: string) { return (keyword[q] ?? []).map((id) => all[id]) as never; },
                async getNodesByIds(ids: string[]) { const m = new Map<string, Node>(); for (const id of ids) if (all[id]) m.set(id, all[id]); return m as never; },
                async traverse() { return [] as never; },
            },
            sessionCache: { pushNode() {} },
            storageClient: {
                async verbatimCount() { return 200; },
                async verbatimSearch(q: string, limit: number) {
                    const o = overrides[q];
                    if (o) return o.slice(0, limit).map((h) => ({ id: `lore:${h.id}`, score: h.score }));
                    return [{ id: 'lore:noise', score: 0.05 + 0.10 * hashFrac(q) }];
                },
                async verbatimBm25Search(q: string, n: number) { return { hits: (bm25[q] ?? []).slice(0, n).map((h) => ({ id: `lore:${h.id}`, score: h.score })), ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
}

const Q_MISS = 'How does TLS certificate pinning work for the edge proxy?';
const Q_HIT = 'How are worker lease renewals timed?';
const ctx = mockCtx(
    { a: node('a', 'Workers renew their job lease every 15 seconds; the lease expires after 45.'), b: node('b', 'Scheduler shards are rebalanced nightly.') },
    { [Q_MISS]: [{ id: 'a', score: 0.5 }, { id: 'b', score: 0.45 }], [Q_HIT]: [{ id: 'a', score: 0.5 }, { id: 'b', score: 0.45 }] },
);

await test('retrieve(): off by default; on => abstains with reason term_coverage only when top hits miss the terms', async () => {
    _resetCalibrationCacheForTests();
    await retrieve(ctx, Q_MISS, { workspace: 'ws-tc', mode: 'hybrid', depth: 0 });
    await drainBackgroundCalibrations(5000);
    const probe = await retrieve(ctx, Q_MISS, { workspace: 'ws-tc', mode: 'hybrid', depth: 0 });
    assert.equal(probe.meta.calibration.status, 'ok');
    const z = probe.meta.topRelevance!;
    // Put z inside [floor, floor + 2.5) so only the term-coverage signal can decide.
    const relevanceFloor = z - 1;
    const off = await retrieve(ctx, Q_MISS, { workspace: 'ws-tc', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor });
    assert.equal(off.meta.abstained, false, 'term coverage off by default');
    assert.equal(off.meta.termCoverage, undefined);
    const on = await retrieve(ctx, Q_MISS, { workspace: 'ws-tc', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor, abstainTermCoverage: true });
    assert.equal(on.meta.abstained, true);
    assert.equal(on.meta.abstainReason, 'term_coverage');
    assert.equal(on.results.length, 0);
    assert.ok((on.meta.termCoverage ?? 1) < 0.1);
    const hit = await retrieve(ctx, Q_HIT, { workspace: 'ws-tc', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor, abstainTermCoverage: true });
    assert.equal(hit.meta.abstained, false, 'query terms present in top hits');
    assert.ok((hit.meta.termCoverage ?? 0) >= 0.1);
    const noAbstain = await retrieve(ctx, Q_MISS, { workspace: 'ws-tc', mode: 'hybrid', depth: 0, abstain: false, relevanceFloor, abstainTermCoverage: true });
    assert.equal(noAbstain.meta.abstained, false, 'abstain off => signal inert');
    assert.equal(noAbstain.meta.termCoverage, undefined);
});

await test('retrieve(): LORE_RECALL_ABSTAIN_TERM_COVERAGE=1 turns it on; explicit false wins', async () => {
    const saved = process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE;
    try {
        process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE = '1';
        const probe = await retrieve(ctx, Q_MISS, { workspace: 'ws-tc', mode: 'hybrid', depth: 0 });
        const relevanceFloor = probe.meta.topRelevance! - 1;
        const env = await retrieve(ctx, Q_MISS, { workspace: 'ws-tc', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor });
        assert.equal(env.meta.abstainReason, 'term_coverage');
        const opt = await retrieve(ctx, Q_MISS, { workspace: 'ws-tc', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor, abstainTermCoverage: false });
        assert.equal(opt.meta.abstained, false);
    } finally {
        if (saved === undefined) delete process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE; else process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE = saved;
    }
});

/** Calibrate `ws` on `c`, then return a floor that puts `q`'s z inside
 *  [floor, floor + margin) so only the term-coverage signal can decide. */
async function grayFloor(c: RetrieveContext, q: string, ws: string): Promise<number> {
    await retrieve(c, q, { workspace: ws, mode: 'hybrid', depth: 0 });
    await drainBackgroundCalibrations(5000);
    const probe = await retrieve(c, q, { workspace: ws, mode: 'hybrid', depth: 0 });
    assert.equal(probe.meta.calibration.status, 'ok');
    return probe.meta.topRelevance! - 1;
}

await test('#6 flag off: an abstention carries no abstainReason in meta (identical to main); on: below_floor', async () => {
    const floor = (await grayFloor(ctx, Q_HIT, 'ws-tc6')) + 10; // far above z => below_floor
    const off = await retrieve(ctx, Q_HIT, { workspace: 'ws-tc6', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor: floor });
    assert.equal(off.meta.abstained, true);
    assert.ok(!('abstainReason' in off.meta), 'no abstainReason with the flag off');
    assert.ok(!('termCoverage' in off.meta));
    const on = await retrieve(ctx, Q_HIT, { workspace: 'ws-tc6', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor: floor, abstainTermCoverage: true });
    assert.equal(on.meta.abstainReason, 'below_floor');
});

const Q_FUSED = 'How is TLS certificate pinning configured?';
await test('#2 coverage is judged on the FINAL fused results: a BM25-only hit covers the terms', async () => {
    const c = mockCtx(
        { pin: node('pin', 'TLS certificate pinning is configured per edge route.'), b: node('b', 'Scheduler shards are rebalanced nightly.') },
        { [Q_FUSED]: [{ id: 'b', score: 0.5 }] },
        { [Q_FUSED]: [{ id: 'pin', score: 9 }] },
    );
    const floor = await grayFloor(c, Q_FUSED, 'ws-tc2');
    const r = await retrieve(c, Q_FUSED, { workspace: 'ws-tc2', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor: floor, abstainTermCoverage: true });
    assert.equal(r.meta.abstained, false, 'the fused BM25 hit answers it');
    assert.ok((r.meta.termCoverage ?? 0) >= 0.5, `coverage ${r.meta.termCoverage}`);
    assert.ok(r.results.some((x) => x.node.id === 'pin'), JSON.stringify({ ids: r.results.map((x) => x.node.id), meta: r.meta }));
});

const Q_LANE = 'what calls frobnicate_shard_v2 during rebalance';
await test('#4 decision runs after the D3 lane: an identifier only the lane finds does not abstain', async () => {
    const c = mockCtx(
        { lane: node('lane', 'frobnicate_shard_v2 is invoked by the nightly job.'), b: node('b', 'Scheduler shards are moved nightly.') },
        { [Q_LANE]: [{ id: 'b', score: 0.5 }] },
        {},
        { frobnicate_shard_v2: ['lane'] },
    );
    const floor = await grayFloor(c, Q_LANE, 'ws-tc4');
    const r = await retrieve(c, Q_LANE, { workspace: 'ws-tc4', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor: floor, abstainTermCoverage: true, candidateFloor: 50 });
    assert.equal(r.meta.abstained, false, 'lane-found identifier must not abstain');
    assert.equal(r.results[0]?.node.id, 'lane', JSON.stringify({ ids: r.results.map((x) => x.node.id), meta: r.meta }));
    // Without the lane (legacy floor 0) the identifier is absent from every seed => abstains.
    const legacy = await retrieve(c, Q_LANE, { workspace: 'ws-tc4', mode: 'hybrid', depth: 0, abstain: true, relevanceFloor: floor, abstainTermCoverage: true, candidateFloor: 0 });
    assert.equal(legacy.meta.abstained, true);
    assert.equal(legacy.meta.abstainReason, 'term_coverage');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

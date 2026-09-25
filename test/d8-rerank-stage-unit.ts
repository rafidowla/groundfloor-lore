#!/usr/bin/env tsx
/**
 * test/d8-rerank-stage-unit.ts — D8 (Lore 3.23), design §4 T4.
 *
 * Pure/structural coverage of `recall/rerankStage.ts`: piece construction
 * (windows + stride + caps), max-over-pieces reduction, the margin gate,
 * K-limiting (untouched tail), the `rerankScore`-only mutation contract
 * (never `score`/`similarity`), the `results.length < 2` skip, and
 * fail-open on a throwing or slow scorer. Every scorer here is injected
 * (`applyRerankStage`'s own `scorer` param, or the `setRerankScorerForTest`
 * seam) — no model, no transformers, no network, no filesystem.
 *
 * Run: npx tsx test/d8-rerank-stage-unit.ts
 */

import assert from 'node:assert/strict';
import {
    applyRerankStage,
    applyRerankStageIfEnabled,
    setRerankScorerForTest,
    type RerankScorer,
} from '../packages/lore/src/recall/rerankStage.js';
import type { RerankConfig } from '../packages/lore/src/recall/rerankConfig.js';
import type { RetrievalResult } from '../packages/lore/src/recall/retrieveTypes.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
    finally { setRerankScorerForTest(null); }
}

function node(id: string, over: Partial<LoreNode> = {}): LoreNode {
    return {
        id, type: 'note', label: `Label-${id}`, content: `content for ${id}`,
        tags: [], project: 'ws', ecosystem: '*', metadata: '{}',
        createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
        syncedAt: null, ...over,
    };
}

function result(id: string, over: Partial<RetrievalResult> = {}, nodeOver: Partial<LoreNode> = {}): RetrievalResult {
    return {
        node: node(id, nodeOver), score: 1, matchedBy: ['bm25'], depth: 0, source: 'seed',
        similarity: null, ...over,
    };
}

function baseCfg(over: Partial<RerankConfig> = {}): RerankConfig {
    return { enabled: true, model: 'test-model', dtype: 'q8', k: 10, margin: 1.0, timeoutMs: 3000, ...over };
}

/** A scorer that returns a fixed score per piece, keyed by the piece's
 *  exact text — any piece not in the map scores -Infinity (so a test only
 *  has to name the pieces it cares about). */
function scorerFromMap(map: Record<string, number>): RerankScorer {
    return async (_q, passages) => passages.map((p) => (p in map ? map[p]! : -100));
}

/* ─── Piece construction ────────────────────────────────────────────── */

await test('short content (< 1000 chars) yields exactly one piece: label + "\\n" + full body', async () => {
    const body = 'short body';
    const r = result('a', {}, { content: body, label: 'Label-a' });
    let seenPassages: string[] = [];
    const scorer: RerankScorer = async (_q, passages) => { seenPassages = passages; return passages.map(() => 0); };
    await applyRerankStage([r, result('b')], 'q', baseCfg(), scorer);
    assert.deepEqual(seenPassages, [`Label-a\n${body}`, 'Label-b\ncontent for b']);
});

await test('empty content yields exactly one piece: the label alone (no trailing newline)', async () => {
    const r = result('a', {}, { content: '', label: 'Label-a' });
    let seenPassages: string[] = [];
    const scorer: RerankScorer = async (_q, passages) => { seenPassages = passages; return passages.map(() => 0); };
    await applyRerankStage([r, result('b')], 'q', baseCfg(), scorer);
    assert.equal(seenPassages[0], 'Label-a');
});

await test('long content is split into overlapping 1000-char windows at stride 800', async () => {
    const body = 'x'.repeat(2200); // windows at 0, 800, 1600 (1600+1000 >= 2200, so that's the last)
    const r = result('a', {}, { content: body, label: 'L' });
    let seenPassages: string[] = [];
    const scorer: RerankScorer = async (_q, passages) => { seenPassages = passages; return passages.map(() => 0); };
    await applyRerankStage([r, result('b')], 'q', baseCfg(), scorer);
    const aPieces = seenPassages.filter((p) => p.startsWith('L\n'));
    assert.equal(aPieces.length, 3, `expected 3 windows for a 2200-char body, got ${aPieces.length}`);
    assert.equal(aPieces[0], `L\n${body.slice(0, 1000)}`);
    assert.equal(aPieces[1], `L\n${body.slice(800, 1800)}`);
    assert.equal(aPieces[2], `L\n${body.slice(1600, 2600)}`); // slice clamps to body.length
});

await test('a node with pathologically long content is capped at 16 pieces', async () => {
    const body = 'y'.repeat(20000); // far more than 16 * 800 windows worth
    const r = result('a', {}, { content: body, label: 'L' });
    // A second, trivial candidate — applyRerankStage requires >= 2 results
    // to actually score anything (see the "fewer than 2 results" test below).
    const other = result('b', {}, { content: 'short', label: 'B' });
    let seenPassages: string[] = [];
    const scorer: RerankScorer = async (_q, passages) => { seenPassages = passages; return passages.map(() => 0); };
    await applyRerankStage([r, other], 'q', baseCfg(), scorer);
    const aPieces = seenPassages.filter((p) => p.startsWith('L\n'));
    assert.equal(aPieces.length, 16, `expected the per-node cap of 16 pieces, got ${aPieces.length}`);
});

/* ─── Max-over-pieces reduction ─────────────────────────────────────── */

await test('a candidate is scored by the MAX over its own pieces, not the first or last', async () => {
    const body = 'z'.repeat(2200); // 3 windows for this candidate
    const cands = [result('incumbent', {}, { content: 'short', label: 'Incumbent' }), result('a', {}, { content: body, label: 'A' })];
    const scorer: RerankScorer = async (_q, passages) => passages.map((p) => {
        if (p.startsWith('Incumbent')) return 0;
        if (p === `A\n${body.slice(800, 1800)}`) return 9.5; // the middle window scores highest
        return 1;
    });
    const { results, meta } = await applyRerankStage(cands, 'q', baseCfg({ margin: 1.0 }), scorer);
    assert.equal(meta.applied, true);
    assert.equal(results[0]!.node.id, 'a', 'the candidate whose BEST piece (9.5) beat the incumbent by >= margin should rank first');
    assert.equal(results[0]!.rerankScore, 9.5);
});

/* ─── Margin gate ────────────────────────────────────────────────────── */

await test('margin gate: replaces #1 when the new top beats the incumbent by >= margin', async () => {
    const cands = [result('incumbent'), result('challenger')];
    const scorer = scorerFromMap({ 'Label-incumbent\ncontent for incumbent': 0, 'Label-challenger\ncontent for challenger': 1.0 });
    const { results, meta } = await applyRerankStage(cands, 'q', baseCfg({ margin: 1.0 }), scorer);
    assert.equal(results[0]!.node.id, 'challenger');
    assert.equal(meta.gateHeld, false);
    assert.equal(meta.replacedTop, true);
});

await test('margin gate: keeps #1 when the new top beats the incumbent by LESS than margin (gateHeld, not replaced)', async () => {
    const cands = [result('incumbent'), result('challenger')];
    const scorer = scorerFromMap({ 'Label-incumbent\ncontent for incumbent': 0, 'Label-challenger\ncontent for challenger': 0.5 });
    const { results, meta } = await applyRerankStage(cands, 'q', baseCfg({ margin: 1.0 }), scorer);
    assert.equal(results[0]!.node.id, 'incumbent', 'a sub-margin challenger must not displace the incumbent');
    assert.equal(meta.gateHeld, true);
    assert.equal(meta.replacedTop, false);
});

await test('margin gate: no gate friction when the incumbent is already the new top', async () => {
    const cands = [result('incumbent'), result('challenger')];
    const scorer = scorerFromMap({ 'Label-incumbent\ncontent for incumbent': 5, 'Label-challenger\ncontent for challenger': 0 });
    const { results, meta } = await applyRerankStage(cands, 'q', baseCfg({ margin: 1.0 }), scorer);
    assert.equal(results[0]!.node.id, 'incumbent');
    assert.equal(meta.gateHeld, false);
    assert.equal(meta.replacedTop, false);
});

await test('margin gate: behind rank #1, the rest of the order is still best-first even when the gate holds', async () => {
    const cands = [result('incumbent'), result('mid'), result('challenger')];
    const scorer = scorerFromMap({
        'Label-incumbent\ncontent for incumbent': 0,
        'Label-mid\ncontent for mid': 0.9, // the overall top scorer, but under margin vs incumbent
        'Label-challenger\ncontent for challenger': 0.5,
    });
    const { results } = await applyRerankStage(cands, 'q', baseCfg({ margin: 1.0 }), scorer);
    assert.deepEqual(results.map((r) => r.node.id), ['incumbent', 'mid', 'challenger']);
});

/* ─── K-limiting and the score/similarity-immutability contract ───────── */

await test('only the top K candidates are rescored; the tail beyond K passes through untouched (same reference, no rerankScore)', async () => {
    const cands = [result('a'), result('b'), result('c'), result('d')];
    const scorer = scorerFromMap({ 'Label-a\ncontent for a': 1, 'Label-b\ncontent for b': 5 });
    const { results } = await applyRerankStage(cands, 'q', baseCfg({ k: 2, margin: 1.0 }), scorer);
    assert.equal(results.length, 4);
    assert.equal(results[2], cands[2], 'candidate beyond K must be the SAME object reference, untouched');
    assert.equal(results[3], cands[3], 'candidate beyond K must be the SAME object reference, untouched');
    assert.equal('rerankScore' in results[2]!, false);
});

await test('rerankScore is added to reranked hits WITHOUT touching score or similarity', async () => {
    const cands = [result('a', { score: 0.42, similarity: 0.77 }), result('b', { score: 0.10, similarity: null })];
    const scorer = scorerFromMap({ 'Label-a\ncontent for a': 0, 'Label-b\ncontent for b': 3 });
    const { results } = await applyRerankStage(cands, 'q', baseCfg({ margin: 1.0 }), scorer);
    for (const r of results) {
        const original = cands.find((c) => c.node.id === r.node.id)!;
        assert.equal(r.score, original.score, `score must be untouched for ${r.node.id}`);
        assert.equal(r.similarity, original.similarity, `similarity must be untouched for ${r.node.id}`);
    }
    assert.equal(typeof results.find((r) => r.node.id === 'b')!.rerankScore, 'number');
});

/* ─── Skip / fail-open paths ─────────────────────────────────────────── */

await test('fewer than 2 results: skipped, reason "too_few_results", order unchanged, no scorer call', async () => {
    let called = false;
    const scorer: RerankScorer = async (_q, passages) => { called = true; return passages.map(() => 0); };
    const one = [result('solo')];
    const { results, meta } = await applyRerankStage(one, 'q', baseCfg(), scorer);
    assert.equal(results, one, 'a single-result array should pass through as the same reference');
    assert.equal(meta.applied, false);
    assert.equal(meta.reason, 'too_few_results');
    assert.equal(called, false);

    const zero: RetrievalResult[] = [];
    const { results: r0, meta: m0 } = await applyRerankStage(zero, 'q', baseCfg()); // no scorer at all — must not throw
    assert.equal(r0, zero);
    assert.equal(m0.reason, 'too_few_results');
});

await test('applyRerankStage throws a programming error if scorer is omitted with >= 2 results (not a silent fail-open)', async () => {
    await assert.rejects(() => applyRerankStage([result('a'), result('b')], 'q', baseCfg()));
});

await test('a scorer that exceeds cfg.timeoutMs fails open: original order kept, reason "timeout"', async () => {
    const cands = [result('a'), result('b')];
    const slow: RerankScorer = (_q, passages) => new Promise((resolve) => setTimeout(() => resolve(passages.map(() => 5)), 200));
    const { results, meta } = await applyRerankStage(cands, 'q', baseCfg({ timeoutMs: 20, margin: 1.0 }), slow);
    assert.deepEqual(results.map((r) => r.node.id), ['a', 'b'], 'timed-out scoring must leave the original order intact');
    assert.equal(meta.applied, false);
    assert.equal(meta.reason, 'timeout');
});

await test('a throwing scorer fails open: original order kept, reason "error"', async () => {
    const cands = [result('a'), result('b')];
    const throwing: RerankScorer = async () => { throw new TypeError('boom'); };
    const savedErr = console.error;
    let logged = false;
    console.error = (...args: unknown[]) => { logged = true; savedErr(...args as []); };
    try {
        const { results, meta } = await applyRerankStage(cands, 'q', baseCfg(), throwing);
        assert.deepEqual(results.map((r) => r.node.id), ['a', 'b']);
        assert.equal(meta.applied, false);
        assert.equal(meta.reason, 'error');
        assert.equal(logged, true, 'a thrown scoring error must be logged (narrow, not swallowed) before failing open');
    } finally {
        console.error = savedErr;
    }
});

/* ─── applyRerankStageIfEnabled — config gating + the test-scorer seam ── */

await test('applyRerankStageIfEnabled: disabled config returns the SAME results reference with no rerankMeta at all', async () => {
    setRerankScorerForTest(async (_q, p) => p.map(() => 99)); // must never be consulted
    const results = [result('a'), result('b')];
    const out = await applyRerankStageIfEnabled(results, 'q', false, 'ws');
    assert.equal(out.results, results);
    assert.equal('rerankMeta' in out, false, 'meta must be entirely absent (not just applied:false) when rerank was never enabled');
});

await test('applyRerankStageIfEnabled: uses the injected test scorer when set, and per-call true overrides workspace/env off', async () => {
    setRerankScorerForTest(scorerFromMap({ 'Label-incumbent\ncontent for incumbent': 0, 'Label-challenger\ncontent for challenger': 5 }));
    const results = [result('incumbent'), result('challenger')];
    const out = await applyRerankStageIfEnabled(results, 'q', true, 'nonexistent-workspace-xyz');
    assert.equal(out.rerankMeta?.applied, true);
    assert.equal(out.results[0]!.node.id, 'challenger');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

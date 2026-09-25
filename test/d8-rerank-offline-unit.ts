#!/usr/bin/env tsx
/**
 * test/d8-rerank-offline-unit.ts — D8 (Lore 3.23), design §4 T5.
 *
 * Offline / no-download coverage for the real (non-test-scorer) wiring
 * path in `recall/rerankStage.ts`'s `applyRerankStageIfEnabled` +
 * `providers/localRerankProvider.ts`'s `rerankModelCached`. Pins:
 *
 *   - When the cross-encoder model is NOT already cached on disk (the
 *     common case for a fresh install/CI box), rerank (default ON as of
 *     D8d) must fail open with `reason:'model_absent'` WITHOUT ever
 *     calling `fetch` — `rerankModelCached()` is a pure filesystem check
 *     that runs BEFORE `@huggingface/transformers` is even imported (see
 *     localRerankProvider.ts's header comment), so there is no network
 *     path to stub around; stubbing `globalThis.fetch` to throw and
 *     counting 0 calls is the proof that no download was attempted.
 *   - D8d: explicit OFF (per-query `false`) must still be byte-identical —
 *     same array reference, no `rerankMeta` at all — since default-on only
 *     changes the NO-OPINION case, not an explicit opt-out.
 *   - `@huggingface/transformers`'s global `env.cacheDir` /
 *     `env.allowRemoteModels` / `env.localModelPath` are never mutated by
 *     this call — D8 passes `cache_dir`/`local_files_only` PER-CALL to
 *     `from_pretrained()` (design §3.3) and must never touch the
 *     process-global env object `providers/llmDispatch.ts` already owns
 *     for its own (unrelated) embedded-LLM path.
 *   - Runs under the test suite's per-process isolated `LORE_HOME`
 *     (loreHome.ts's `isTestProcess()` guard — see that file's header):
 *     this test never points at a real `~/.groundfloor`, so the
 *     "not cached" branch is exercised deterministically regardless of
 *     what any given machine happens to have fetched previously.
 *   - Optional real-model smoke test: SKIPs (does not fail) when
 *     `rerankModelCached()` reports the default model isn't on disk under
 *     the resolved `LORE_HOME` — it never fetches one to make itself
 *     pass. Only exercises the real `LocalRerankProvider.score()` path
 *     when a prior `lore models fetch-rerank` (D8b, out of this slice)
 *     already populated the cache.
 *
 * Run: npx tsx test/d8-rerank-offline-unit.ts
 */

import assert from 'node:assert/strict';
import { applyRerankStageIfEnabled, setRerankScorerForTest } from '../packages/lore/src/recall/rerankStage.js';
import { rerankModelCached, LocalRerankProvider, resolveRerankIdleUnloadMs, DEFAULT_RERANK_IDLE_UNLOAD_MS } from '../packages/lore/src/providers/localRerankProvider.js';
import { DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE } from '../packages/lore/src/recall/rerankConfig.js';
import { loreHomePath } from '../packages/lore/src/config/loreHome.js';
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

function result(id: string, over: Partial<RetrievalResult> = {}): RetrievalResult {
    return {
        node: node(id), score: 1, matchedBy: ['bm25'], depth: 0, source: 'seed',
        similarity: null, ...over,
    };
}

/** Install a `globalThis.fetch` stub that throws on any call, tracking how
 *  many times it was invoked. Always restored by the caller. */
function stubFetchThrows(): { calls: number; restore: () => void } {
    const original = globalThis.fetch;
    const tracker = { calls: 0 };
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        tracker.calls++;
        throw new Error(`unexpected network fetch in offline test: ${String(args[0])}`);
    }) as typeof fetch;
    return {
        get calls() { return tracker.calls; },
        restore: () => { globalThis.fetch = original; },
    } as unknown as { calls: number; restore: () => void };
}

console.log('D8 — rerank stage offline / no-download guarantees\n');

await test('model not cached: fails open with reason "model_unavailable", zero fetch calls, transformers env untouched', async () => {
    // Confirm the premise first: under this test process's isolated
    // LORE_HOME (loreHome.ts), the default rerank model is genuinely not
    // on disk. If this ever trips, the test below would pass for the
    // wrong reason (real scoring, not the offline guard) — fail loudly
    // instead of silently exercising a different code path.
    const cacheDir = loreHomePath('models');
    assert.equal(
        rerankModelCached(DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE, cacheDir), false,
        'test premise: the default rerank model must not be cached under this test-isolated LORE_HOME',
    );

    const stub = stubFetchThrows();
    // Snapshot transformers' global env BEFORE the call. Importing the
    // package here (for inspection only) is independent of whether
    // applyRerankStageIfEnabled's own code path reaches it — the
    // assertion is that OUR CODE never mutates these fields, not that the
    // module is never loaded by anything in the process.
    const { env } = await import('@huggingface/transformers');
    const before = { cacheDir: env.cacheDir, allowRemoteModels: env.allowRemoteModels, localModelPath: env.localModelPath };

    try {
        const results = [result('a'), result('b'), result('c')];
        // perCallRerank:true forces enabled regardless of workspace/env,
        // and setRerankScorerForTest(null) (see the `test()` wrapper's
        // finally) guarantees the REAL (non-test-scorer) code path runs.
        const { results: out, rerankMeta } = await applyRerankStageIfEnabled(results, 'some query', true, undefined);

        assert.equal(stub.calls, 0, 'no fetch call may occur on the model_unavailable path');
        assert.ok(rerankMeta, 'rerankMeta must be present when rerank was enabled for the call');
        assert.equal(rerankMeta!.applied, false, 'fail-open: nothing was applied');
        assert.equal(rerankMeta!.reason, 'model_absent');
        assert.deepEqual(out.map((r) => r.node.id), ['a', 'b', 'c'], 'original order is kept unchanged on fail-open');
        assert.ok(!('rerankScore' in out[0]!), 'no rerankScore is added on a fail-open path');

        const after = { cacheDir: env.cacheDir, allowRemoteModels: env.allowRemoteModels, localModelPath: env.localModelPath };
        assert.deepEqual(after, before, 'transformers global env (cacheDir/allowRemoteModels/localModelPath) must be byte-identical before and after');
    } finally {
        stub.restore();
    }
});

await test('too few results: skipped before even the model-cache check runs (fewer than 2 results never touches fetch)', async () => {
    const stub = stubFetchThrows();
    try {
        const { results: out, rerankMeta } = await applyRerankStageIfEnabled([result('solo')], 'q', true, undefined);
        assert.equal(stub.calls, 0);
        assert.equal(rerankMeta!.reason, 'too_few_results');
        assert.deepEqual(out.map((r) => r.node.id), ['solo']);
    } finally {
        stub.restore();
    }
});

await test('D8d default-on (no per-call/workspace/env opinion): rerank is ATTEMPTED, model absent -> fail-open meta, zero fetch', async () => {
    const stub = stubFetchThrows();
    try {
        const results = [result('a'), result('b')];
        const { results: out, rerankMeta } = await applyRerankStageIfEnabled(results, 'q', undefined, undefined);
        assert.equal(stub.calls, 0, 'default-on with model absent must still never fetch');
        assert.ok(rerankMeta, 'D8d: default ON means an opinion-less call now reports rerank meta');
        assert.equal(rerankMeta!.applied, false);
        assert.equal(rerankMeta!.reason, 'model_absent');
        assert.deepEqual(out.map((r) => r.node.id), ['a', 'b'], 'fail-open keeps original order');
    } finally {
        stub.restore();
    }
});

await test('D8d explicit per-query false: byte-identical to pre-D8 output (no fetch, no rerankMeta, same reference)', async () => {
    const stub = stubFetchThrows();
    try {
        const results = [result('a'), result('b')];
        const { results: out, rerankMeta } = await applyRerankStageIfEnabled(results, 'q', false, undefined);
        assert.equal(stub.calls, 0);
        assert.equal(rerankMeta, undefined, 'explicit per-query false must not report any rerank meta');
        assert.equal(out, results, 'explicit per-query false returns the exact same array reference');
    } finally {
        stub.restore();
    }
});

await test('D8d explicit env LORE_RECALL_RERANK=0: byte-identical to pre-D8 output (no fetch, no rerankMeta, same reference)', async () => {
    const stub = stubFetchThrows();
    const prior = process.env['LORE_RECALL_RERANK'];
    process.env['LORE_RECALL_RERANK'] = '0';
    try {
        const results = [result('a'), result('b')];
        const { results: out, rerankMeta } = await applyRerankStageIfEnabled(results, 'q', undefined, undefined);
        assert.equal(stub.calls, 0);
        assert.equal(rerankMeta, undefined, 'env-disabled must not report any rerank meta');
        assert.equal(out, results, 'env-disabled returns the exact same array reference');
    } finally {
        if (prior === undefined) delete process.env['LORE_RECALL_RERANK']; else process.env['LORE_RECALL_RERANK'] = prior;
        stub.restore();
    }
});

await test('optional real-model smoke: only scores for real when the default model is already cached on disk (never fetches one)', async () => {
    const cacheDir = loreHomePath('models');
    if (!rerankModelCached(DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE, cacheDir)) {
        console.log('  [SKIP] default rerank model not cached under this LORE_HOME — not fetching one to make this test pass');
        return;
    }
    // Only reached when a prior `lore models fetch-rerank` (or an
    // operator's own pre-populated cache) already put the model on disk —
    // local_files_only:true still applies, so even here nothing is
    // downloaded; this only proves REAL scoring works once cached.
    const provider = new LocalRerankProvider({ modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir });
    const scores = await provider.score('capital of France', ['Paris is the capital of France.', 'Bananas are a fruit.']);
    assert.equal(scores.length, 2);
    assert.ok(scores[0]! > scores[1]!, 'the on-topic passage must score higher than the unrelated one');
});

await test('D8d re-check after model appears: rerankModelCached is a plain per-call fs check, not memoized', async () => {
    // Non-default model id -> only the .complete marker + required files
    // matter (no manifest sha256 verification at this layer for a
    // non-default id — see rerankManifest.ts's header). Proves the "model
    // that appears later is picked up on the very next query with no cache
    // to invalidate" contract from this file's own header without needing
    // to fabricate real sha256-matching bytes for the default model.
    const fs2 = await import('node:fs');
    const os2 = await import('node:os');
    const path2 = await import('node:path');
    const cacheDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'd8-recheck-'));
    const modelId = 'test-org/test-rerank-model';
    const dtype = DEFAULT_RERANK_DTYPE;
    try {
        assert.equal(rerankModelCached(modelId, dtype, cacheDir), false, 'not present yet');
        const modelDir = path2.join(cacheDir, modelId);
        fs2.mkdirSync(path2.join(modelDir, 'onnx'), { recursive: true });
        fs2.writeFileSync(path2.join(modelDir, 'config.json'), '{}');
        fs2.writeFileSync(path2.join(modelDir, 'tokenizer.json'), '{}');
        fs2.writeFileSync(path2.join(modelDir, 'tokenizer_config.json'), '{}');
        fs2.writeFileSync(path2.join(modelDir, 'onnx', 'model_quantized.onnx'), 'stub');
        // No .complete marker yet -> still not cached.
        assert.equal(rerankModelCached(modelId, dtype, cacheDir), false, 'files present but no .complete marker yet');
        fs2.writeFileSync(path2.join(modelDir, '.complete'), JSON.stringify({ modelId, dtype, fetchedAt: new Date().toISOString() }));
        assert.equal(rerankModelCached(modelId, dtype, cacheDir), true, 're-check after the model appears must pick it up immediately, no restart/memoization needed');
    } finally {
        fs2.rmSync(cacheDir, { recursive: true, force: true });
    }
});

await test('F7 idle unload: default 5 min; <=0 / garbage fall back to the default (no "never unload" value)', async () => {
    assert.equal(DEFAULT_RERANK_IDLE_UNLOAD_MS, 300_000);
    assert.equal(resolveRerankIdleUnloadMs(undefined), 300_000, 'unset -> default');
    assert.equal(resolveRerankIdleUnloadMs(''), 300_000, 'empty -> default');
    assert.equal(resolveRerankIdleUnloadMs('0'), 300_000, '0 -> default, not never');
    assert.equal(resolveRerankIdleUnloadMs('-1'), 300_000, 'negative -> default, not never');
    assert.equal(resolveRerankIdleUnloadMs('abc'), 300_000, 'garbage -> default');
    assert.equal(resolveRerankIdleUnloadMs('120000'), 120_000, 'positive value honoured');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

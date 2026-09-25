/**
 * D8d F1 regression — no network egress at query time, even when another
 * subsystem has flipped the transformers.js global to permissive.
 *
 * SECURITY-D8 F1: `AutoTokenizer.from_pretrained(<hub id>, {local_files_only:true})`
 * still reaches the fetch layer via `get_tokenizer_files()` ->
 * `get_file_metadata()`, which drops the per-call options and falls back to
 * the process-global `env.allowRemoteModels`. `llmDispatch.ts` sets that
 * global to `true`, so a warm-cache rerank could HEAD huggingface.co with the
 * ambient `HF_TOKEN`. The fix loads from an absolute, realpath-checked local
 * directory so no loader path can reach fetch.
 *
 * This test runs the REAL provider against a warm, verified cache with the
 * global forced permissive, `HF_TOKEN` set, and both `env.fetch` and
 * `globalThis.fetch` stubbed to count and throw. It asserts zero fetch calls
 * AND a successful, sensible score.
 *
 * Needs the default model already fetched (`lore models fetch-rerank`) under
 * `LORE_HOME`; it never downloads one. When absent it prints SKIP and exits 0,
 * unless `LORE_TEST_REQUIRE_RERANK_MODEL=1`, in which case absence is a failure.
 */
import assert from 'node:assert/strict';
import { env } from '@huggingface/transformers';
import { rerankModelCached, LocalRerankProvider, _resetLocalRerankProviderForTests } from '../packages/lore/src/providers/localRerankProvider.js';
import { DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE } from '../packages/lore/src/recall/rerankConfig.js';
import { loreHomePath } from '../packages/lore/src/config/loreHome.js';

const cacheDir = loreHomePath('models');
if (!rerankModelCached(DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE, cacheDir)) {
    if (process.env.LORE_TEST_REQUIRE_RERANK_MODEL === '1') {
        console.error(`FAIL: default rerank model not cached under ${cacheDir} and LORE_TEST_REQUIRE_RERANK_MODEL=1`);
        process.exit(1);
    }
    console.log('[SKIP] default rerank model not cached under this LORE_HOME — run `lore models fetch-rerank` first; not fetching one');
    process.exit(0);
}

const calls: string[] = [];
const deny = async (input: unknown): Promise<never> => {
    calls.push(String((input as { url?: string })?.url ?? input));
    throw new Error('network forbidden in d8-rerank-no-egress-unit');
};
const origEnvFetch = env.fetch;
const origGlobalFetch = globalThis.fetch;
const origAllowRemote = env.allowRemoteModels;
const origToken = process.env.HF_TOKEN;

let failed = 0;
try {
    env.allowRemoteModels = true;          // what llmDispatch.ts does in a real host
    process.env.HF_TOKEN = 'hf_d8_no_egress_test_token';
    env.fetch = deny as typeof env.fetch;
    globalThis.fetch = deny as typeof globalThis.fetch;
    _resetLocalRerankProviderForTests();

    const provider = new LocalRerankProvider({ modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir });
    const scores = await provider.score('capital of France', ['Paris is the capital of France.', 'Bananas are a fruit.']);

    assert.deepEqual(calls, [], `rerank load+score must make zero fetch calls; saw ${calls.length}: ${calls.join(', ')}`);
    assert.equal(scores.length, 2);
    assert.ok(scores[0]! > scores[1]!, 'the on-topic passage must score higher than the unrelated one');
    console.log('  ✓ warm cache + allowRemoteModels=true + HF_TOKEN set: zero fetch calls, real score succeeded');
} catch (err) {
    failed++;
    console.error(`  ✗ ${(err as Error).message}`);
} finally {
    env.fetch = origEnvFetch;
    globalThis.fetch = origGlobalFetch;
    env.allowRemoteModels = origAllowRemote;
    if (origToken === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = origToken;
    _resetLocalRerankProviderForTests();
}

console.log(`\n${failed === 0 ? 1 : 0} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

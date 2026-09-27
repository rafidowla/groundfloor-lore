#!/usr/bin/env tsx
/**
 * embed-model-cache-parity-unit.ts — D9 Part A parity gate (Lore 3.24).
 *
 * `providers/modelCache.ts`'s `resolveEmbedModelDir()` changed how
 * `localEmbeddingProvider.ts` obtains its Transformers.js `pipeline()`
 * extractor: instead of `pipeline('feature-extraction', modelId, {})` (the
 * pre-3.24 call — letting the package resolve its OWN default cache dir,
 * an absolute local path), the new code always resolves modelId+dtype to
 * an absolute, verified directory FIRST, then calls
 * `pipeline('feature-extraction', <absolute dir>, { cache_dir, local_files_only: true, dtype })`.
 *
 * That is the ONE variable this test isolates: does swapping "pass the
 * repo-id string" for "pass a resolved absolute directory (byte-identical
 * files, reached via a legacy-cache copy this file also exercises for
 * real)" change the extractor's numerical output at all. Everything
 * downstream of extractor construction — E5 "query:"/"passage:" prefixing,
 * chunking for >448-token documents, mean-pool + L2-renormalize
 * (`localEmbeddingProvider.ts`'s `poolMeanNormalized`/`splitIntoWindows`) —
 * is code this slice never touched and is exercised by
 * `embedding-provider-unit.ts` and friends; re-implementing it by hand here
 * would risk testing this file's own logic instead of the resolver's.
 *
 * This is this slice's own parity GATE, not an ordinary fixture test: per
 * build-rules-324.md, a test that can't find its model must print
 * `SKIP: <reason>` and exit 0 — EXCEPT this one, which must FAIL LOUDLY
 * (non-zero exit) if the legacy e5-small cache isn't present, since a
 * silent skip here would hide exactly the regression this test exists to
 * catch. Uses ONLY the legacy cache already on disk under
 * node_modules/@huggingface/transformers/.cache — no network.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const legacyModelDir = path.join(
    repoRoot, 'node_modules', '@huggingface', 'transformers', '.cache', 'Xenova', 'multilingual-e5-small',
);
const legacyOnnx = path.join(legacyModelDir, 'onnx', 'model_quantized.onnx');

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

function assertBitIdentical(a: Float32Array, b: Float32Array, label: string): void {
    assert.equal(a.length, b.length, `${label}: vector length differs (${a.length} vs ${b.length})`);
    for (let i = 0; i < a.length; i++) {
        assert.ok(
            Object.is(a[i], b[i]),
            `${label}: element ${i} differs — new=${a[i]} legacy=${b[i]} (Float32, must be bit-identical)`,
        );
    }
}

function toFloat32(output: unknown): Float32Array {
    const o = output as { data?: ArrayLike<number> };
    if (!o?.data) throw new Error('extractor output missing .data — unexpected transformers.js output shape');
    return Float32Array.from(o.data);
}

async function main(): Promise<void> {
    console.log('embed-model-cache-parity: shared-cache extractor vs legacy-cache extractor (D9 Part A)');

    if (!fs.existsSync(legacyOnnx)) {
        console.error(`FAIL: legacy e5-small cache not found at ${legacyModelDir}`);
        console.error('This is a parity GATE, not a skippable fixture test — it must fail loudly');
        console.error('rather than silently pass when the model it needs to compare against is missing.');
        process.exit(1);
    }

    const { pipeline } = await import('@huggingface/transformers');
    const { resolveEmbedModelDir } = await import('../packages/lore/src/providers/modelCache.js');
    const { DEFAULT_EMBED_MODEL_ID, DEFAULT_EMBED_MANIFEST_DTYPE } = await import('../packages/lore/src/providers/embedManifest.js');

    // realpathSync: on macOS os.tmpdir() is under /var, a symlink to
    // /private/var — resolveEmbedModelDir() realpath-verifies containment
    // and returns the REAL, resolved path, so resolving here too keeps the
    // `dir === path.join(cacheDir, ...)` comparison below exact.
    const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'embed-parity-')));
    const cacheDir = path.join(tmpHome, 'models');

    let extractorNew: { (text: string | string[], opts: Record<string, unknown>): Promise<unknown>; dispose?: () => void } | undefined;
    let extractorLegacy: typeof extractorNew;

    try {
        await test('resolveEmbedModelDir copies+verifies the real legacy cache into a fresh shared cache (no network)', async () => {
            const dir = await resolveEmbedModelDir(DEFAULT_EMBED_MODEL_ID, DEFAULT_EMBED_MANIFEST_DTYPE, { cacheDir });
            assert.equal(dir, path.join(cacheDir, DEFAULT_EMBED_MODEL_ID));
            assert.ok(fs.existsSync(path.join(dir, '.complete')), 'marker written after install');
            assert.ok(fs.existsSync(path.join(dir, 'onnx', 'model_quantized.onnx')), 'onnx weights present in the shared cache');
        });

        const modelDir = path.join(cacheDir, DEFAULT_EMBED_MODEL_ID);

        await test('build the NEW-path extractor (resolved absolute directory, cache_dir + local_files_only:true)', async () => {
            extractorNew = (await pipeline('feature-extraction', modelDir, {
                cache_dir: cacheDir,
                local_files_only: true,
                dtype: DEFAULT_EMBED_MANIFEST_DTYPE,
            })) as typeof extractorNew;
        });

        await test('build the LEGACY-path extractor (raw modelId, package default cache dir — the pre-3.24 call shape)', async () => {
            extractorLegacy = (await pipeline('feature-extraction', DEFAULT_EMBED_MODEL_ID, {
                local_files_only: true,
                dtype: DEFAULT_EMBED_MANIFEST_DTYPE,
            })) as typeof extractorLegacy;
        });

        await test('embedQuery parity: "query: " prefixed short text, mean-pooled + normalized, bit-identical', async () => {
            const text = 'query: how does Lore resolve a shared embedding cache?';
            const a = toFloat32(await extractorNew!(text, { pooling: 'mean', normalize: true }));
            const b = toFloat32(await extractorLegacy!(text, { pooling: 'mean', normalize: true }));
            assertBitIdentical(a, b, 'embedQuery');
        });

        await test('embedDocument parity: a genuinely long (>448-token) "passage: " text, bit-identical', async () => {
            const paragraph =
                'Lore resolves the shared embedding model cache before ever touching the network, checking a completion marker, then a legacy transformers.js cache, then falling back to a verified download. ';
            const longText = 'passage: ' + paragraph.repeat(40); // well past 448 tokens
            const a = toFloat32(await extractorNew!(longText, { pooling: 'mean', normalize: true }));
            const b = toFloat32(await extractorLegacy!(longText, { pooling: 'mean', normalize: true }));
            assertBitIdentical(a, b, 'embedDocument (long)');
        });

        await test('embedDocumentBatch parity: a batch of "passage: " texts, every row bit-identical', async () => {
            const texts = [
                'passage: the shared cache is keyed by model id and dtype',
                'passage: a stale lock is taken over after roughly sixty seconds',
                'passage: only the default model and dtype carry a pinned sha256 manifest',
            ];
            const outA = (await extractorNew!(texts, { pooling: 'mean', normalize: true })) as { tolist?: () => number[][] };
            const outB = (await extractorLegacy!(texts, { pooling: 'mean', normalize: true })) as { tolist?: () => number[][] };
            assert.ok(outA.tolist && outB.tolist, 'batched output exposes .tolist() for per-row comparison');
            const rowsA = outA.tolist!();
            const rowsB = outB.tolist!();
            assert.equal(rowsA.length, texts.length);
            assert.equal(rowsB.length, texts.length);
            for (let i = 0; i < texts.length; i++) {
                assertBitIdentical(Float32Array.from(rowsA[i]!), Float32Array.from(rowsB[i]!), `embedDocumentBatch row ${i}`);
            }
        });

        await test('integration sanity: the real LocalEmbeddingProvider, wired through the new resolver end-to-end, returns a unit-norm vector', async () => {
            process.env['LORE_HOME'] = tmpHome; // loreHomePath() inside getOrCreateEntry reads this
            const { LocalEmbeddingProvider } = await import('../packages/lore/src/providers/localEmbeddingProvider.js');
            const provider = new LocalEmbeddingProvider();
            const vec = await provider.embedDocument('passage: '.repeat(1) + 'a genuinely long document. '.repeat(80));
            assert.equal(vec.length, 384, 'e5-small dimension');
            let normSq = 0;
            for (const v of vec) normSq += v * v;
            assert.ok(Math.abs(Math.sqrt(normSq) - 1) < 1e-4, `output should be L2-normalized (got norm ${Math.sqrt(normSq)})`);
        });
    } finally {
        try { extractorNew?.dispose?.(); } catch { /* best-effort */ }
        try { extractorLegacy?.dispose?.(); } catch { /* best-effort */ }
        delete process.env['LORE_HOME'];
        fs.rmSync(tmpHome, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

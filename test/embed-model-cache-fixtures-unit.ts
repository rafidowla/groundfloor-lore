#!/usr/bin/env tsx
/**
 * embed-model-cache-fixtures-unit.ts — D9 Part A (Lore 3.24) fixture-based
 * coverage of `providers/modelCache.ts`'s `resolveEmbedModelDir()`: marker
 * hit, legacy-cache copy+verify, legacy hash mismatch falling through to
 * download, a failed download's integrity check being a hard error with no
 * marker written, stale-lock takeover, and two concurrent resolvers
 * collapsing into a single download. No network — every scenario either
 * plants fixture files directly or injects a fake `downloadModel`.
 *
 * The "legacy copy+verify" and "legacy hash mismatch" cases use the
 * DEFAULT model+dtype (`Xenova/multilingual-e5-small` @ `q8`) so the pinned
 * sha256 manifest in `embedManifest.ts` is actually exercised; the real
 * legacy transformers.js cache this repo ships in `node_modules` (see
 * build-rules-324.md — read-only, may be READ but never modified) supplies
 * correct-hash bytes for the success case and a deliberately-corrupted copy
 * supplies wrong-hash bytes for the mismatch case. Every other scenario
 * uses a throwaway non-default `Fixture/test-model` id so it never touches
 * the manifest at all.
 *
 * See test/embed-model-cache-parity-unit.ts for the real-model,
 * bit-identical-vectors parity GATE (a different, stricter test — must fail
 * loudly rather than skip if its model is missing); this file may skip its
 * two manifest-dependent cases if the legacy cache genuinely isn't present,
 * since it is not itself a parity gate.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    resolveEmbedModelDir,
    embedModelCached,
    lockPathFor,
    EmbedIntegrityError,
    type DownloadEmbedModelParams,
} from '../packages/lore/src/providers/modelCache.js';
import {
    DEFAULT_EMBED_MODEL_ID,
    DEFAULT_EMBED_MANIFEST_DTYPE,
    EMBED_COMMON_FILES,
    EMBED_DTYPE_ONNX_FILE,
} from '../packages/lore/src/providers/embedManifest.js';
import { DEFAULT_LOCAL_MODEL_ID } from '../packages/lore/src/providers/localEmbeddingProvider.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const realLegacyModelDir = path.join(
    repoRoot, 'node_modules', '@huggingface', 'transformers', '.cache', 'Xenova', 'multilingual-e5-small',
);
const REAL_LEGACY_AVAILABLE = fs.existsSync(path.join(realLegacyModelDir, 'onnx', 'model_quantized.onnx'));

let passed = 0, failed = 0, skipped = 0;
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
function skip(name: string, reason: string): void {
    skipped++;
    console.log(`  \x1b[33m⊘ SKIP\x1b[0m ${name} — ${reason}`);
}

function mkTmp(prefix: string): string {
    // realpathSync: on macOS os.tmpdir() is under /var, a symlink to
    // /private/var — resolveEmbedModelDir() realpath-verifies containment
    // (see rerankModelId.ts's resolveModelDirSafe(), reused here) and
    // returns the REAL, resolved path. Resolving here too keeps every
    // string comparison against a returned directory exact.
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeDummyModelFiles(dir: string, onnxFile: string, seed = 'dummy'): void {
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
    for (const rel of EMBED_COMMON_FILES) fs.writeFileSync(path.join(dir, rel), `${seed}:${rel}`);
    fs.writeFileSync(path.join(dir, 'onnx', onnxFile), `${seed}:onnx/${onnxFile}`);
}

function writeCompleteMarker(dir: string, fields: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, '.complete'), JSON.stringify({ ...fields, fetchedAt: new Date().toISOString() }, null, 2));
}

function copyRealLegacyFiles(destDir: string, onnxFile: string): void {
    fs.mkdirSync(path.join(destDir, 'onnx'), { recursive: true });
    for (const rel of EMBED_COMMON_FILES) fs.copyFileSync(path.join(realLegacyModelDir, rel), path.join(destDir, rel));
    fs.copyFileSync(path.join(realLegacyModelDir, 'onnx', onnxFile), path.join(destDir, 'onnx', onnxFile));
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
    console.log('embed-model-cache-fixtures: resolveEmbedModelDir() — marker/legacy/download/lock scenarios');

    await test('embedManifest.ts DEFAULT_EMBED_MODEL_ID matches localEmbeddingProvider.ts DEFAULT_LOCAL_MODEL_ID', async () => {
        assert.equal(DEFAULT_EMBED_MODEL_ID, DEFAULT_LOCAL_MODEL_ID);
    });

    // ── marker hit ───────────────────────────────────────────────────────
    await test('marker hit: returns immediately, never touches legacy or download', async () => {
        const cacheDir = mkTmp('embed-cache-marker-');
        const modelId = 'Fixture/marker-hit-model';
        const dtype = 'q8' as const;
        const onnxFile = EMBED_DTYPE_ONNX_FILE[dtype];
        const modelDir = path.join(cacheDir, modelId);
        fs.mkdirSync(modelDir, { recursive: true });
        writeDummyModelFiles(modelDir, onnxFile);
        writeCompleteMarker(modelDir, { modelId, dtype, source: 'legacy-cache' });

        const nonexistentLegacy = path.join(cacheDir, 'no-such-legacy-root');
        let downloadCalled = false;
        const dir = await resolveEmbedModelDir(modelId, dtype, {
            cacheDir,
            legacyCacheDir: nonexistentLegacy,
            downloadModel: async () => { downloadCalled = true; throw new Error('must not be called on a marker hit'); },
        });
        assert.equal(dir, modelDir);
        assert.equal(downloadCalled, false);
        assert.ok(embedModelCached(modelId, dtype, cacheDir), 'embedModelCached() pure-fs check agrees');
    });

    // ── legacy copy + verify (default model+dtype — manifest exercised) ──
    if (REAL_LEGACY_AVAILABLE) {
        await test('legacy cache hit: copies through staging, verifies against the pinned manifest, installs, no network', async () => {
            const cacheDir = mkTmp('embed-cache-legacy-');
            const legacyRoot = mkTmp('embed-legacy-root-');
            copyRealLegacyFiles(path.join(legacyRoot, DEFAULT_EMBED_MODEL_ID), EMBED_DTYPE_ONNX_FILE[DEFAULT_EMBED_MANIFEST_DTYPE]);

            const dir = await resolveEmbedModelDir(DEFAULT_EMBED_MODEL_ID, DEFAULT_EMBED_MANIFEST_DTYPE, {
                cacheDir,
                legacyCacheDir: legacyRoot,
                downloadModel: async () => { throw new Error('must not be called — legacy copy should succeed'); },
            });
            assert.equal(dir, path.join(cacheDir, DEFAULT_EMBED_MODEL_ID));
            const marker = JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8'));
            assert.equal(marker.source, 'legacy-cache');
            assert.equal(marker.verifiedManifest, true);
            assert.ok(fs.existsSync(path.join(dir, 'onnx', 'model_quantized.onnx')));
        });

        await test('legacy hash mismatch: discards the legacy copy and falls through to a verified download', async () => {
            const cacheDir = mkTmp('embed-cache-mismatch-');
            const legacyRoot = mkTmp('embed-legacy-bad-');
            const badLegacyDir = path.join(legacyRoot, DEFAULT_EMBED_MODEL_ID);
            copyRealLegacyFiles(badLegacyDir, EMBED_DTYPE_ONNX_FILE[DEFAULT_EMBED_MANIFEST_DTYPE]);
            // Corrupt exactly one manifested file so verifyAgainstManifest fails.
            fs.writeFileSync(path.join(badLegacyDir, 'config.json'), '{"corrupted": true}');

            let downloadCalls = 0;
            const download = async (params: DownloadEmbedModelParams): Promise<void> => {
                downloadCalls++;
                const modelDir = path.join(params.stagingDir, params.modelId);
                copyRealLegacyFiles(modelDir, EMBED_DTYPE_ONNX_FILE[params.dtype]);
            };

            const dir = await resolveEmbedModelDir(DEFAULT_EMBED_MODEL_ID, DEFAULT_EMBED_MANIFEST_DTYPE, {
                cacheDir,
                legacyCacheDir: legacyRoot,
                downloadModel: download,
            });
            assert.equal(downloadCalls, 1, 'download was engaged exactly once after the legacy mismatch');
            const marker = JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8'));
            assert.equal(marker.source, 'download');
            assert.equal(marker.verifiedManifest, true);
            // Verified, correct content actually landed (proves the corrupted
            // legacy copy was discarded, not silently trusted).
            assert.equal(
                fs.readFileSync(path.join(dir, 'config.json'), 'utf8'),
                fs.readFileSync(path.join(realLegacyModelDir, 'config.json'), 'utf8'),
            );
            const leftoverStaging = fs.readdirSync(cacheDir).filter((n) => n.startsWith('.staging-'));
            assert.deepEqual(leftoverStaging, [], 'staging dirs are cleaned up');
        });
    } else {
        skip('legacy cache hit: copies through staging, verifies, installs', 'real legacy e5-small cache not present under node_modules');
        skip('legacy hash mismatch: falls through to a verified download', 'real legacy e5-small cache not present under node_modules');
    }

    // ── download verify failure → hard error + no marker ───────────────
    await test('download integrity failure: hard error, nothing installed, staging cleaned up', async () => {
        const cacheDir = mkTmp('embed-cache-badverify-');
        const nonexistentLegacy = path.join(cacheDir, 'no-such-legacy-root');
        const download = async (params: DownloadEmbedModelParams): Promise<void> => {
            const modelDir = path.join(params.stagingDir, params.modelId);
            writeDummyModelFiles(modelDir, EMBED_DTYPE_ONNX_FILE[params.dtype], 'WRONG-CONTENT-should-not-match-manifest');
        };

        await assert.rejects(
            () => resolveEmbedModelDir(DEFAULT_EMBED_MODEL_ID, DEFAULT_EMBED_MANIFEST_DTYPE, {
                cacheDir,
                legacyCacheDir: nonexistentLegacy,
                downloadModel: download,
            }),
            (err: unknown) => err instanceof EmbedIntegrityError,
        );
        assert.equal(fs.existsSync(path.join(cacheDir, DEFAULT_EMBED_MODEL_ID)), false, 'nothing installed');
        const leftoverStaging = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((n) => n.startsWith('.staging-')) : [];
        assert.deepEqual(leftoverStaging, [], 'staging dirs are cleaned up even on failure');
    });

    // ── stale lock takeover ─────────────────────────────────────────────
    await test('stale lock: an old, abandoned lock file is taken over rather than waited on forever', async () => {
        const cacheDir = mkTmp('embed-cache-stalelock-');
        fs.mkdirSync(cacheDir, { recursive: true });
        const modelId = 'Fixture/stale-lock-model';
        const dtype = 'q8' as const;
        const lockPath = lockPathFor(cacheDir, modelId);
        fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date(0).toISOString() }));
        const oldTime = new Date(Date.now() - 10 * 60_000);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const nonexistentLegacy = path.join(cacheDir, 'no-such-legacy-root');
        let downloadCalls = 0;
        const dir = await resolveEmbedModelDir(modelId, dtype, {
            cacheDir,
            legacyCacheDir: nonexistentLegacy,
            lockStaleMs: 50,
            lockPollMs: 20,
            lockWaitTimeoutMs: 5_000,
            downloadModel: async (params) => {
                downloadCalls++;
                const modelDir = path.join(params.stagingDir, params.modelId);
                writeDummyModelFiles(modelDir, EMBED_DTYPE_ONNX_FILE[params.dtype]);
            },
        });
        assert.equal(downloadCalls, 1);
        assert.equal(dir, path.join(cacheDir, modelId));
        assert.equal(fs.existsSync(lockPath), false, 'lock released after the winner finishes');
    });

    // ── 2 concurrent resolvers → 1 copy ─────────────────────────────────
    await test('two concurrent resolvers for the same model collapse into a single download', async () => {
        const cacheDir = mkTmp('embed-cache-concurrent-');
        fs.mkdirSync(cacheDir, { recursive: true });
        const modelId = 'Fixture/concurrent-model';
        const dtype = 'q8' as const;
        const nonexistentLegacy = path.join(cacheDir, 'no-such-legacy-root');

        let downloadCalls = 0;
        const opts = {
            cacheDir,
            legacyCacheDir: nonexistentLegacy,
            lockPollMs: 20,
            downloadModel: async (params: DownloadEmbedModelParams) => {
                downloadCalls++;
                await sleep(200); // give the second caller a real chance to race in
                const modelDir = path.join(params.stagingDir, params.modelId);
                writeDummyModelFiles(modelDir, EMBED_DTYPE_ONNX_FILE[params.dtype]);
            },
        };

        const [dirA, dirB] = await Promise.all([
            resolveEmbedModelDir(modelId, dtype, opts),
            resolveEmbedModelDir(modelId, dtype, opts),
        ]);
        assert.equal(downloadCalls, 1, 'exactly one download for two concurrent callers');
        assert.equal(dirA, dirB);
        assert.equal(dirA, path.join(cacheDir, modelId));
    });

    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

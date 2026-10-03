#!/usr/bin/env tsx
/**
 * model-warmup-nonfatal-unit.ts — a failed embedding-model warm-up must not
 * fail store open, and the opt-in LORE_MODELS_OFFLINE switch must never
 * touch the network.
 *
 * Covers: modelCache.ts (offline switch, EmbedModelUnavailableError text),
 * LocalEmbeddingProvider.initialize() retry-after-failure, the shared
 * warmEmbeddingProvider helper, and the three store open paths
 * (VerbatimStore/LanceDB, SqliteVerbatimStore, DataplaneVectorStore).
 *
 * No real network, no real model: the downloader and the transformers
 * `pipeline` loader are injected (`downloadModel` seam on
 * resolveEmbedModelDir + `_loadSeamsForTests`); model files are fabricated.
 * Run with LORE_MODEL_SERVER=0 and a throwaway LORE_HOME.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    resolveEmbedModelDir,
    EmbedModelUnavailableError,
    EMBED_DOWNLOAD_RETRY_PAUSE_MS,
    _embedDownloadRetryForTests,
    _resetEmbedDownloadRetryForTests,
    type DownloadEmbedModelParams,
} from '../packages/lore/src/providers/modelCache.js';
import { EMBED_COMMON_FILES, EMBED_DTYPE_ONNX_FILE } from '../packages/lore/src/providers/embedManifest.js';
import { LocalEmbeddingProvider, _loadSeamsForTests, _resetLocalEmbeddingPipelineForTests } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { warmEmbeddingProvider } from '../packages/lore/src/providers/embeddingWarmup.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';
import { registryAcceptingAny } from './helpers/workspace-registry.js';
import { log } from '../packages/lore/src/logger.js';

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

const mkTmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const DTYPE = 'q8' as const;
const ONNX = EMBED_DTYPE_ONNX_FILE[DTYPE];

function writeModelFiles(dir: string): void {
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
    for (const rel of EMBED_COMMON_FILES) fs.writeFileSync(path.join(dir, rel), `fake:${rel}`);
    fs.writeFileSync(path.join(dir, 'onnx', ONNX), 'fake:onnx');
}

/** undici-shaped failure: `TypeError: fetch failed` with a `cause.code`. */
function etimedout(): Error {
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = Object.assign(new Error('connect ETIMEDOUT 18.0.0.1:443'), { code: 'ETIMEDOUT' });
    return e;
}

/** Scriptable downloader: counts calls, fails while `failing`, else writes fake files. */
function stubDownloader(): { fn: (p: DownloadEmbedModelParams) => Promise<void>; calls: () => number; failing: boolean; set: (f: boolean) => void } {
    let calls = 0;
    const s = {
        failing: true,
        calls: () => calls,
        set(f: boolean) { s.failing = f; },
        fn: async (p: DownloadEmbedModelParams): Promise<void> => {
            calls++;
            if (s.failing) throw etimedout();
            writeModelFiles(path.join(p.stagingDir, p.modelId));
        },
    };
    return s;
}

/** Fake transformers pipeline: 4-d vectors, batch-aware. */
const fakePipeline = async (): Promise<unknown> => async (input: string | string[]) => {
    const n = Array.isArray(input) ? input.length : 1;
    return { data: new Float32Array(n * 4).fill(0.25), dims: [n, 4] };
};

let caseNo = 0;
/** Fresh LORE_HOME (cache lives at <home>/models), fresh pipeline cache, stub seams. */
function freshEnv(dl: ReturnType<typeof stubDownloader>): { home: string; cacheDir: string; modelId: string } {
    const home = mkTmp('warmup-home-');
    process.env['LORE_HOME'] = home;
    delete process.env['LORE_MODELS_OFFLINE'];
    _resetLocalEmbeddingPipelineForTests();
    // Retry pause off by default: most cases assert an immediate re-attempt.
    _resetEmbedDownloadRetryForTests();
    _embedDownloadRetryForTests.pauseMs = 0;
    _loadSeamsForTests.downloadModel = dl.fn;
    _loadSeamsForTests.pipeline = fakePipeline;
    return { home, cacheDir: path.join(home, 'models'), modelId: `Fixture/warm-${++caseNo}` };
}

const provider = (modelId: string): LocalEmbeddingProvider => new LocalEmbeddingProvider({ modelId, dimension: 4, dtype: DTYPE });

/** Capture log.warn calls for the duration of `fn`. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const orig = log.warn;
    const warnings: string[] = [];
    log.warn = (m: unknown): void => { warnings.push(String(m)); };
    try { return { result: await fn(), warnings }; } finally { log.warn = orig; }
}

async function main(): Promise<void> {
    console.log('model-warmup-nonfatal: non-fatal warm-up + LORE_MODELS_OFFLINE');
    const noLegacy = (cacheDir: string): string => path.join(cacheDir, 'no-such-legacy-root');

    // ── modelCache: download failure → clear error ───────────────────────
    await test('download ETIMEDOUT → EmbedModelUnavailableError naming model, dtype, dir, missing file, cause code, fix; staging cleaned', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        await assert.rejects(
            () => resolveEmbedModelDir(modelId, DTYPE, { cacheDir, legacyCacheDir: noLegacy(cacheDir), downloadModel: dl.fn }),
            (e: unknown) => {
                assert.ok(e instanceof EmbedModelUnavailableError);
                assert.equal(e.reason, 'download-failed');
                for (const needle of [modelId, DTYPE, cacheDir, '.complete', 'ETIMEDOUT', 'lore models fetch-embedding', 'LORE_HOME']) {
                    assert.ok(e.message.includes(needle), `message must include ${needle}: ${e.message}`);
                }
                return true;
            },
        );
        assert.equal(dl.calls(), 1);
        assert.deepEqual(fs.readdirSync(cacheDir).filter((n) => n.startsWith('.staging-')), []);
    });

    // ── modelCache: pause between download attempts ──────────────────────
    await test('retry pause: a failed download is replayed (no new download) until the pause elapses, then re-attempted', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        let clock = 1_000_000;
        delete _embedDownloadRetryForTests.pauseMs; // production default
        _embedDownloadRetryForTests.now = () => clock;
        const opts = { cacheDir, legacyCacheDir: noLegacy(cacheDir), downloadModel: dl.fn };
        assert.equal(EMBED_DOWNLOAD_RETRY_PAUSE_MS, 30_000);

        await assert.rejects(() => resolveEmbedModelDir(modelId, DTYPE, opts), (e: unknown) => {
            assert.ok(e instanceof EmbedModelUnavailableError);
            assert.equal(e.retryInMs, undefined, 'the attempt that really downloaded carries no retryInMs');
            return true;
        });
        assert.equal(dl.calls(), 1);

        clock += 10_000;
        await assert.rejects(() => resolveEmbedModelDir(modelId, DTYPE, opts), (e: unknown) => {
            assert.ok(e instanceof EmbedModelUnavailableError);
            assert.equal(e.reason, 'download-failed');
            assert.equal(e.retryInMs, 20_000);
            for (const needle of ['ETIMEDOUT', 'another 20s', 'lore models fetch-embedding']) {
                assert.ok(e.message.includes(needle), `message must include ${needle}: ${e.message}`);
            }
            return true;
        });
        assert.equal(dl.calls(), 1, 'no download inside the pause');
        assert.deepEqual(fs.readdirSync(cacheDir).filter((n) => n.startsWith('.staging-')), [], 'no staging dir inside the pause');

        clock += 19_999;
        await assert.rejects(() => resolveEmbedModelDir(modelId, DTYPE, opts), EmbedModelUnavailableError);
        assert.equal(dl.calls(), 1, 'still paused 1 ms before the boundary');

        clock += 1;
        await assert.rejects(() => resolveEmbedModelDir(modelId, DTYPE, opts), EmbedModelUnavailableError);
        assert.equal(dl.calls(), 2, 'pause elapsed: a real download is attempted again');

        // The second failure restarts the pause.
        clock += 29_999;
        await assert.rejects(() => resolveEmbedModelDir(modelId, DTYPE, opts), EmbedModelUnavailableError);
        assert.equal(dl.calls(), 2);

        clock += 1;
        dl.set(false);
        const dir = await resolveEmbedModelDir(modelId, DTYPE, opts);
        assert.equal(dl.calls(), 3);
        assert.ok(fs.existsSync(path.join(dir, 'onnx', ONNX)));
    });

    await test('retry pause: a model that lands in the cache during the pause resolves at once; other models are not paused', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        delete _embedDownloadRetryForTests.pauseMs;
        _embedDownloadRetryForTests.now = () => 5_000_000;
        const opts = { cacheDir, legacyCacheDir: noLegacy(cacheDir), downloadModel: dl.fn };
        await assert.rejects(() => resolveEmbedModelDir(modelId, DTYPE, opts), EmbedModelUnavailableError);
        assert.equal(dl.calls(), 1);

        // A different model in the same cache dir is not held back by the pause.
        await assert.rejects(() => resolveEmbedModelDir(`${modelId}-other`, DTYPE, opts), (e: unknown) => {
            assert.ok(e instanceof EmbedModelUnavailableError);
            assert.equal(e.retryInMs, undefined);
            return true;
        });
        assert.equal(dl.calls(), 2);

        // Same instant, still paused — but an out-of-band fetch (the CLI in
        // another process) has installed the model: served from the cache.
        const otherCache = mkTmp('warmup-fetch-');
        const fetched = await resolveEmbedModelDir(modelId, DTYPE, {
            cacheDir: otherCache, legacyCacheDir: noLegacy(otherCache),
            downloadModel: async (p) => { writeModelFiles(path.join(p.stagingDir, p.modelId)); },
        });
        fs.cpSync(otherCache, cacheDir, { recursive: true });
        assert.ok(fs.existsSync(fetched));
        const dir = await resolveEmbedModelDir(modelId, DTYPE, opts);
        assert.ok(dir.startsWith(cacheDir));
        assert.equal(dl.calls(), 2, 'cache hit: no download, no pause error');
    });

    await test('retry pause: downloadRetryPauseMs: 0 retries on every call; LocalEmbeddingProvider.initialize() honours the default pause', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        delete _embedDownloadRetryForTests.pauseMs;
        let clock = 9_000_000;
        _embedDownloadRetryForTests.now = () => clock;
        const opts = { cacheDir, legacyCacheDir: noLegacy(cacheDir), downloadModel: dl.fn, downloadRetryPauseMs: 0 };
        await assert.rejects(() => resolveEmbedModelDir(modelId, DTYPE, opts), EmbedModelUnavailableError);
        await assert.rejects(() => resolveEmbedModelDir(modelId, DTYPE, opts), EmbedModelUnavailableError);
        assert.equal(dl.calls(), 2);

        const env = freshEnv(dl);
        delete _embedDownloadRetryForTests.pauseMs;
        _embedDownloadRetryForTests.now = () => clock;
        const p = provider(env.modelId);
        const before = dl.calls();
        await assert.rejects(() => p.initialize(), EmbedModelUnavailableError);
        await assert.rejects(() => p.initialize(), (e: unknown) => {
            assert.ok(e instanceof EmbedModelUnavailableError);
            assert.ok((e.retryInMs ?? 0) > 0);
            return true;
        });
        assert.equal(dl.calls(), before + 1, 'second initialize() inside the pause does not download');
        clock += EMBED_DOWNLOAD_RETRY_PAUSE_MS;
        dl.set(false);
        await p.initialize();
        assert.equal(dl.calls(), before + 2);
    });

    // ── modelCache: offline switch ───────────────────────────────────────
    await test('offline + miss: downloader never called; error names dir, dtype, missing marker; no staging dir created', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        await assert.rejects(
            () => resolveEmbedModelDir(modelId, DTYPE, { cacheDir, legacyCacheDir: noLegacy(cacheDir), downloadModel: dl.fn, offline: true }),
            (e: unknown) => {
                assert.ok(e instanceof EmbedModelUnavailableError);
                assert.equal(e.reason, 'offline');
                for (const needle of [modelId, DTYPE, cacheDir, '.complete', 'offline mode is on', 'lore models fetch-embedding']) {
                    assert.ok(e.message.includes(needle), `message must include ${needle}: ${e.message}`);
                }
                return true;
            },
        );
        assert.equal(dl.calls(), 0);
        assert.deepEqual(fs.readdirSync(cacheDir).filter((n) => n.startsWith('.staging-')), []);
    });

    await test('offline via LORE_MODELS_OFFLINE env (1 and true): same behaviour, downloader never called', async () => {
        for (const v of ['1', 'true', 'TRUE']) {
            const dl = stubDownloader();
            const { cacheDir, modelId } = freshEnv(dl);
            process.env['LORE_MODELS_OFFLINE'] = v;
            try {
                await assert.rejects(
                    () => resolveEmbedModelDir(modelId, DTYPE, { cacheDir, legacyCacheDir: noLegacy(cacheDir), downloadModel: dl.fn }),
                    (e: unknown) => e instanceof EmbedModelUnavailableError && e.reason === 'offline',
                );
                assert.equal(dl.calls(), 0);
            } finally { delete process.env['LORE_MODELS_OFFLINE']; }
        }
    });

    await test('offline + partially populated cache: error names the specific missing file (the onnx weights)', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        const modelDir = path.join(cacheDir, modelId);
        writeModelFiles(modelDir);
        fs.writeFileSync(path.join(modelDir, '.complete'), '{}');
        fs.rmSync(path.join(modelDir, 'onnx', ONNX));
        await assert.rejects(
            () => resolveEmbedModelDir(modelId, DTYPE, { cacheDir, legacyCacheDir: noLegacy(cacheDir), downloadModel: dl.fn, offline: true }),
            (e: unknown) => e instanceof EmbedModelUnavailableError && e.message.includes(`onnx/${ONNX}`),
        );
        assert.equal(dl.calls(), 0);
    });

    await test('offline + complete cache: resolves, downloader never called', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        const modelDir = path.join(cacheDir, modelId);
        writeModelFiles(modelDir);
        fs.writeFileSync(path.join(modelDir, '.complete'), '{}');
        const dir = await resolveEmbedModelDir(modelId, DTYPE, { cacheDir, legacyCacheDir: noLegacy(cacheDir), downloadModel: dl.fn, offline: true });
        assert.equal(dir, modelDir);
        assert.equal(dl.calls(), 0);
    });

    await test('offline + legacy transformers cache copy: still installs (local copy, no network), downloader never called', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        const legacyRoot = mkTmp('warmup-legacy-');
        writeModelFiles(path.join(legacyRoot, modelId));
        const dir = await resolveEmbedModelDir(modelId, DTYPE, { cacheDir, legacyCacheDir: legacyRoot, downloadModel: dl.fn, offline: true });
        assert.equal(dir, path.join(cacheDir, modelId));
        assert.equal(dl.calls(), 0);
    });

    await test('offline off (default / explicit false / env "0"): cache miss downloads exactly as before', async () => {
        for (const mode of ['default', 'explicit-false', 'env-0'] as const) {
            const dl = stubDownloader();
            dl.set(false);
            const { cacheDir, modelId } = freshEnv(dl);
            if (mode === 'env-0') process.env['LORE_MODELS_OFFLINE'] = '0';
            try {
                const dir = await resolveEmbedModelDir(modelId, DTYPE, {
                    cacheDir, legacyCacheDir: noLegacy(cacheDir), downloadModel: dl.fn,
                    ...(mode === 'explicit-false' ? { offline: false } : {}),
                });
                assert.equal(dir, path.join(cacheDir, modelId), mode);
                assert.equal(dl.calls(), 1, mode);
            } finally { delete process.env['LORE_MODELS_OFFLINE']; }
        }
    });

    // ── LocalEmbeddingProvider: retry after failure ──────────────────────
    await test('initialize() is retryable: a failed attempt leaves no cached rejection; the next call re-attempts and succeeds', async () => {
        const dl = stubDownloader();
        const { modelId } = freshEnv(dl);
        const p = provider(modelId);
        await assert.rejects(() => p.initialize(), (e: unknown) => e instanceof EmbedModelUnavailableError);
        assert.equal(dl.calls(), 1);
        await assert.rejects(() => p.initialize(), (e: unknown) => e instanceof EmbedModelUnavailableError);
        assert.equal(dl.calls(), 2, 'second initialize() must re-run the download, not replay a cached rejection');
        dl.set(false);
        await p.initialize();
        assert.equal(dl.calls(), 3);
        await p.initialize();
        assert.equal(dl.calls(), 3, 'warm provider does not re-download');
    });

    // ── helper ───────────────────────────────────────────────────────────
    await test('warmEmbeddingProvider: failure → one warning (model, dtype, dir, fix), returns false, never throws; later embed retries and works', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        const p = provider(modelId);
        const { result, warnings } = await captureWarnings(() => warmEmbeddingProvider(p, '[Test]'));
        assert.equal(result, false);
        assert.equal(warnings.length, 1);
        for (const needle of ['[Test]', modelId, DTYPE, cacheDir, 'ETIMEDOUT', 'lore models fetch-embedding']) {
            assert.ok(warnings[0]!.includes(needle), `warning must include ${needle}: ${warnings[0]}`);
        }
        assert.equal(dl.calls(), 1);
        dl.set(false);
        const v = await p.embedQuery('hello');
        assert.equal(v.length, 4);
        assert.equal(dl.calls(), 2, 'embed after a failed warm-up re-attempts initialization');
    });

    await test('warmEmbeddingProvider: embed that still fails after a failed warm-up throws the clear error', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        const p = provider(modelId);
        await captureWarnings(() => warmEmbeddingProvider(p, '[Test]'));
        await assert.rejects(
            () => p.embedDocument('hello'),
            (e: unknown) => e instanceof EmbedModelUnavailableError
                && [modelId, DTYPE, cacheDir, 'lore models fetch-embedding'].every((n) => e.message.includes(n)),
        );
        assert.equal(dl.calls(), 2);
    });

    await test('warmEmbeddingProvider: non-cache failure (pipeline load error) still adds model/dtype/dir context; success path is silent', async () => {
        const dl = stubDownloader();
        dl.set(false);
        const { cacheDir, modelId } = freshEnv(dl);
        _loadSeamsForTests.pipeline = async () => { throw new Error('onnx session create failed'); };
        const p = provider(modelId);
        const bad = await captureWarnings(() => warmEmbeddingProvider(p, '[Test]'));
        assert.equal(bad.result, false);
        assert.equal(bad.warnings.length, 1);
        for (const needle of [modelId, DTYPE, cacheDir, 'onnx session create failed']) assert.ok(bad.warnings[0]!.includes(needle), needle);
        _loadSeamsForTests.pipeline = fakePipeline;
        const ok = await captureWarnings(() => warmEmbeddingProvider(p, '[Test]'));
        assert.equal(ok.result, true);
        assert.deepEqual(ok.warnings, []);
    });

    await test('warmEmbeddingProvider: offline mode warms nothing, warns once, never downloads', async () => {
        const dl = stubDownloader();
        const { modelId } = freshEnv(dl);
        process.env['LORE_MODELS_OFFLINE'] = '1';
        try {
            const { result, warnings } = await captureWarnings(() => warmEmbeddingProvider(provider(modelId), '[Test]'));
            assert.equal(result, false);
            assert.equal(warnings.length, 1);
            assert.ok(warnings[0]!.includes('offline mode is on'));
            assert.equal(dl.calls(), 0);
        } finally { delete process.env['LORE_MODELS_OFFLINE']; }
    });

    // ── the three store open paths ───────────────────────────────────────
    await test('SqliteVerbatimStore: open succeeds on warm-up failure (one warning); store() then retries the model and works', async () => {
        const dl = stubDownloader();
        const { modelId } = freshEnv(dl);
        const base = mkTmp('warmup-sqlite-');
        const store = new SqliteVerbatimStore(base, provider(modelId));
        const { warnings } = await captureWarnings(() => store.initialize());
        assert.equal(warnings.filter((w) => w.includes('warm-up failed')).length, 1);
        assert.equal(dl.calls(), 1);
        dl.set(false);
        await store.store({ id: 'doc-1', text: 'hello world', metadata: {} });
        assert.equal(dl.calls(), 2, 'first embed retried initialization');
        await store.close();
    });

    await test('VerbatimStore (LanceDB): open succeeds on warm-up failure (one warning); store() then retries the model and works', async () => {
        const dl = stubDownloader();
        const { modelId } = freshEnv(dl);
        const base = mkTmp('warmup-lance-');
        const store = new VerbatimStore(base, provider(modelId));
        const { warnings } = await captureWarnings(() => store.initialize());
        assert.equal(warnings.filter((w) => w.includes('warm-up failed')).length, 1);
        assert.equal(dl.calls(), 1);
        dl.set(false);
        await store.store({ id: 'doc-1', text: 'hello world', metadata: {} });
        assert.equal(dl.calls(), 2, 'first embed retried initialization');
        await store.close();
    });

    await test('VerbatimStore (LanceDB): a still-failing embed after open throws the clear error (not a silent empty vector)', async () => {
        const dl = stubDownloader();
        const { cacheDir, modelId } = freshEnv(dl);
        const store = new VerbatimStore(mkTmp('warmup-lance2-'), provider(modelId));
        await captureWarnings(() => store.initialize());
        await assert.rejects(
            () => store.store({ id: 'doc-1', text: 'hello world', metadata: {} }),
            (e: unknown) => [modelId, DTYPE, cacheDir, 'lore models fetch-embedding'].every((n) => String((e as Error).message).includes(n)),
        );
        await store.close();
    });

    await test('DataplaneVectorStore: initialize() succeeds on warm-up failure (one warning); provider still retries on first embed', async () => {
        const dl = stubDownloader();
        const { modelId } = freshEnv(dl);
        const p = provider(modelId);
        const store = new DataplaneVectorStore({
            client: {} as never,
            dataplaneWorkspaceId: 'dp-ws',
            workspaceRegistry: registryAcceptingAny(),
            loreWorkspaceProvider: () => 'ws-alpha',
            orgId: 'org-main',
            embeddingProvider: p,
        });
        const { warnings } = await captureWarnings(() => store.initialize());
        assert.equal(warnings.filter((w) => w.includes('warm-up failed')).length, 1);
        assert.equal(dl.calls(), 1);
        dl.set(false);
        assert.equal((await p.embedQuery('hello')).length, 4);
        assert.equal(dl.calls(), 2);
    });

    _loadSeamsForTests.downloadModel = undefined;
    _loadSeamsForTests.pipeline = undefined;
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

/**
 * modelCache.ts — Lore 3.24 D9 Part A: shared embedding-model cache (O1).
 * See docs/design/D9-shared-model-server.md §3.
 *
 * `resolveEmbedModelDir(modelId, dtype, opts)` is the single entry point
 * `localEmbeddingProvider.ts` calls before ever touching
 * `@huggingface/transformers`'s `pipeline()`. It resolves, in order:
 *
 *   1. Shared cache hit — `<cacheDir>/<modelId>/.complete` present and every
 *      required file for `dtype` exists. No I/O beyond a handful of
 *      `lstat`s.
 *   2. Legacy transformers.js cache — if the SAME files already sit under
 *      the package's own `.cache/<modelId>/` (pre-3.24 installs, or a dev
 *      workstation with a prior `npm install` warm cache), copy them
 *      through a staging dir, verify (default model only), and install —
 *      no network at all.
 *   3. Download — stage into `<cacheDir>/.staging-<rand>`, verify (default
 *      model only), install. This is the only step that touches the
 *      network, and only when neither 1 nor 2 already satisfied the call.
 *   4. Nothing found — `EmbedModelUnavailableError`: either the download
 *      failed (cause included) or `LORE_MODELS_OFFLINE` is on and step 3 was
 *      skipped entirely. Staging is cleaned up either way.
 *
 * Concurrency: an O_EXCL lock file (`<cacheDir>/.lock-<hash(modelId)>`)
 * serializes steps 2/3 across processes AND across concurrent in-process
 * callers (the lock is real filesystem state, not an in-memory mutex, so it
 * works identically either way). The loser polls (async `setTimeout`, never
 * `Atomics.wait`) for the `.complete` marker rather than for lock release —
 * a lock can be abandoned by a crashed process, so a lock older than
 * `lockStaleMs` (default 60s) is treated as stale and taken over.
 *
 * `cache_dir` is always passed explicitly per-call — this module (like
 * providers/localRerankProvider.ts before it) never reads or writes the
 * process-global `env.cacheDir` / `env.allowRemoteModels`; those belong to
 * `providers/llmDispatch.ts` for its own, unrelated, embedded-LLM pipeline.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { resolveModelDirSafe, validateRerankModelId } from './rerankModelId.js';
import {
    DEFAULT_EMBED_MANIFEST,
    DEFAULT_EMBED_MANIFEST_DTYPE,
    DEFAULT_EMBED_MODEL_ID,
    DEFAULT_EMBED_REVISION,
    EMBED_COMMON_FILES,
    EMBED_DTYPE_ONNX_FILE,
} from './embedManifest.js';
import type { ModelDtype } from './localEmbeddingProvider.js';

/**
 * Reused, not duplicated (per this slice's build brief): the id-shape
 * validator and realpath-containment resolver are generic HF `org/name`
 * checks with nothing rerank-specific in their logic — see
 * rerankModelId.ts's own doc comment. Importing them here (rather than
 * forking a byte-identical `embedModelId.ts`) is the deliberate choice;
 * the "rerank" name in the source file is a historical artifact of which
 * feature needed it first, not a scope restriction.
 */
export { validateRerankModelId as validateEmbedModelId };

/** Thrown when a DOWNLOADED (never a legacy-cache-copied — see
 *  `resolveEmbedModelDirLocked`) file for the DEFAULT model+dtype doesn't
 *  match `embedManifest.ts`'s pinned sha256. Always a hard failure — unlike
 *  rerank's fail-open design, there is no "silently proceed without this
 *  embedding model" fallback the caller can safely take, so this is thrown
 *  all the way up to `localEmbeddingProvider.ts`'s caller. */
export class EmbedIntegrityError extends Error {
    constructor(modelId: string, relPath: string) {
        super(`embedding model "${modelId}": integrity check failed for "${relPath}" (sha256 mismatch against pinned manifest)`);
        this.name = 'EmbedIntegrityError';
    }
}

/** Opt-in "never download" switch (off by default). `LORE_MODELS_OFFLINE=1`
 *  (or `true`) makes a cache miss fail immediately instead of reaching the
 *  network. Read per call, like the other LORE_* knobs. */
export function modelsOfflineFromEnv(): boolean {
    const v = (process.env['LORE_MODELS_OFFLINE'] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/** First thing a ready model dir lacks (marker, then each required file), or
 *  'nothing' if `embedModelCached` would hit. Names only; never contents. */
export function firstMissingEmbedFile(modelId: string, dtype: ModelDtype, dir: string): string {
    const modelDir = resolveModelDirSafe(dir, modelId);
    if (!modelDir) {
        // resolveModelDirSafe needs the dir to exist; absent means never installed.
        return fs.existsSync(path.join(dir, modelId)) ? 'model directory (unresolvable path)' : '.complete (model not installed)';
    }
    const required = ['.complete', ...EMBED_COMMON_FILES, `onnx/${EMBED_DTYPE_ONNX_FILE[dtype]}`];
    for (const rel of required) {
        try {
            if (!fs.lstatSync(path.join(modelDir, rel)).isFile()) return rel;
        } catch {
            return rel;
        }
    }
    return 'nothing';
}

/** Short, secret-free description of why a download failed: error code (own
 *  or on the undici `cause`) plus a length-capped message. */
function describeDownloadCause(err: unknown): string {
    if (!(err instanceof Error)) return String(err).slice(0, 200);
    const code = (err as { code?: unknown }).code ?? ((err as { cause?: { code?: unknown } }).cause?.code);
    const msg = err.message.length > 200 ? `${err.message.slice(0, 200)}...` : err.message;
    return typeof code === 'string' ? `${code}: ${msg}` : msg;
}

/** Thrown when the embedding model is not in the cache and cannot be had:
 *  either offline mode is on (no download attempted) or the download failed.
 *  Names the model id, dtype, cache dir, the missing file and the fix. */
export class EmbedModelUnavailableError extends Error {
    readonly reason: 'offline' | 'download-failed';
    /** Set when this error replays a recent download failure during the
     *  retry pause: ms until the next download attempt is allowed. */
    readonly retryInMs?: number;
    constructor(p: { modelId: string; dtype: ModelDtype; cacheDir: string; missing: string; reason: 'offline' | 'download-failed'; cause?: unknown; retryInMs?: number }) {
        const where = `embedding model ${p.modelId} (dtype ${p.dtype}) is not in the model cache at ${p.cacheDir} (missing: ${p.missing})`;
        const fix = `Fix: run "lore models fetch-embedding --model ${p.modelId} --dtype ${p.dtype}" with network access (the cache follows LORE_HOME).`;
        const paused = p.retryInMs !== undefined
            ? ` No new download is attempted for another ${Math.ceil(p.retryInMs / 1000)}s.`
            : '';
        super(p.reason === 'offline'
            ? `${where}; offline mode is on (LORE_MODELS_OFFLINE) so no download was attempted. ${fix}`
            : `${where} and the download failed: ${describeDownloadCause(p.cause)}.${paused} ${fix}`);
        this.name = 'EmbedModelUnavailableError';
        this.reason = p.reason;
        if (p.retryInMs !== undefined) this.retryInMs = p.retryInMs;
        if (p.cause !== undefined) this.cause = p.cause;
    }
}

// ---------------------------------------------------------------------------
// Download retry pause. After a failed download, further resolve calls for
// the same model replay that failure for EMBED_DOWNLOAD_RETRY_PAUSE_MS
// instead of starting another download: without it every embed on a host
// with no route to the hub pays a full connect timeout. In-process state
// only. A model that appears in the cache meanwhile (`lore models
// fetch-embedding`, another process, the legacy cache) is picked up at once,
// because those checks run before this one.
// ---------------------------------------------------------------------------

export const EMBED_DOWNLOAD_RETRY_PAUSE_MS = 30_000;

const lastDownloadFailure = new Map<string, { at: number; cause: unknown }>();

/** Test seams: `pauseMs` overrides the default pause, `now` the clock. */
export const _embedDownloadRetryForTests: { pauseMs?: number; now?: () => number } = {};

export function _resetEmbedDownloadRetryForTests(): void {
    lastDownloadFailure.clear();
    delete _embedDownloadRetryForTests.pauseMs;
    delete _embedDownloadRetryForTests.now;
}

// ---------------------------------------------------------------------------
// Small fs helpers — extracted so both this resolver and the
// `lore models fetch-embedding` CLI command (cli/commands/modelsFetchEmbedding.ts)
// share one implementation instead of duplicating modelsFetch.ts's rerank-side
// copies.
// ---------------------------------------------------------------------------

export function sha256File(p: string): string {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(p));
    return hash.digest('hex');
}

/** Verify every manifested file under `modelDir` matches its pinned sha256.
 *  Returns the first mismatching/missing relPath, or `null` if everything
 *  in the manifest matched (extra, non-manifested files are ignored). */
export function verifyAgainstManifest(modelDir: string, manifest: Readonly<Record<string, string>>): string | null {
    for (const [relPath, expected] of Object.entries(manifest)) {
        const p = path.join(modelDir, relPath);
        let st: fs.Stats;
        try { st = fs.lstatSync(p); } catch { return relPath; }
        if (!st.isFile()) return relPath; // missing or a symlink — reject either way
        if (sha256File(p) !== expected) return relPath;
    }
    return null;
}

export function rmQuiet(p: string): void {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort cleanup only */ }
}

export function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function listFilesWithSizes(dir: string): Array<{ relPath: string; sizeBytes: number }> {
    const out: Array<{ relPath: string; sizeBytes: number }> = [];
    const walk = (p: string, rel: string): void => {
        let st: fs.Stats;
        try { st = fs.lstatSync(p); } catch { return; }
        if (st.isSymbolicLink()) return; // never follow
        if (st.isFile()) { out.push({ relPath: rel, sizeBytes: st.size }); return; }
        if (st.isDirectory()) {
            for (const name of fs.readdirSync(p)) walk(path.join(p, name), rel ? `${rel}/${name}` : name);
        }
    };
    walk(dir, '');
    return out;
}

/** When `from_pretrained`/`pipeline()` is called with a `revision`,
 *  `@huggingface/transformers` writes files to
 *  `<cache_dir>/<modelId>/<revision>/...` instead of the flat
 *  `<cache_dir>/<modelId>/...` layout it uses unpinned — the same flat
 *  layout the runtime load path (and the shared-cache marker check) always
 *  reads from. Flattens the nested dir into `stagedModelDir` in place
 *  before verify/install. Identical fix to modelsFetch.ts's rerank-side
 *  `flattenRevisionDir` (see its comment for the discovery story). */
export function flattenRevisionDir(stagedModelDir: string, revision: string | undefined): void {
    if (!revision) return;
    const nested = path.join(stagedModelDir, revision);
    let st: fs.Stats;
    try { st = fs.lstatSync(nested); } catch { return; }
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    for (const name of fs.readdirSync(nested)) {
        fs.renameSync(path.join(nested, name), path.join(stagedModelDir, name));
    }
    rmQuiet(nested);
}

// ---------------------------------------------------------------------------
// Legacy transformers.js cache resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `@huggingface/transformers`'s own legacy cache directory
 * (`<package-root>/.cache/`) via Node module resolution against the
 * installed package's `package.json` — never a hardcoded `node_modules/...`
 * path, so this keeps working under npm/pnpm/yarn workspace linking or a
 * relocated `node_modules`. Mirrors the package's own `env.js` computation
 * (`DEFAULT_CACHE_DIR = path.join(<package-root>, '/.cache/')`).
 * Returns `undefined` if the package can't be resolved (should not happen
 * in a working install, but this path must never throw — a missing legacy
 * cache is simply "step 2 finds nothing", not an error).
 */
export function resolveLegacyTransformersCacheDir(): string | undefined {
    try {
        const require = createRequire(import.meta.url);
        const pkgJsonPath = require.resolve('@huggingface/transformers/package.json');
        return path.join(path.dirname(pkgJsonPath), '.cache');
    } catch {
        return undefined;
    }
}

function legacyHasRequiredFiles(legacyModelDir: string, onnxFile: string): boolean {
    const required = [...EMBED_COMMON_FILES, `onnx/${onnxFile}`];
    for (const rel of required) {
        try {
            const st = fs.lstatSync(path.join(legacyModelDir, rel));
            if (!st.isFile()) return false;
        } catch {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Shared-cache marker check
// ---------------------------------------------------------------------------

/**
 * Pure filesystem check for whether `modelId`+`dtype` is already cached and
 * *verified-complete* under `dir`. Returns the resolved, realpath-contained
 * model directory when it is, `undefined` otherwise. No transformers
 * import, no network — mirrors `localRerankProvider.ts`'s
 * `rerankModelCached` (see its doc comment for the full F3/F5 rationale:
 * id validation + realpath containment, `.complete` marker required, exact
 * dtype-specific ONNX file + common files present as real (non-symlink)
 * files).
 */
export function embedModelCached(modelId: string, dtype: ModelDtype, dir: string): string | undefined {
    const modelDir = resolveModelDirSafe(dir, modelId);
    if (!modelDir) return undefined;
    try {
        const st = fs.lstatSync(path.join(modelDir, '.complete'));
        if (!st.isFile()) return undefined;
    } catch {
        return undefined;
    }
    const required = [...EMBED_COMMON_FILES, `onnx/${EMBED_DTYPE_ONNX_FILE[dtype]}`];
    for (const rel of required) {
        try {
            const st = fs.lstatSync(path.join(modelDir, rel));
            if (!st.isFile()) return undefined;
        } catch {
            return undefined;
        }
    }
    return modelDir;
}

// ---------------------------------------------------------------------------
// O_EXCL lock — async-polled, never Atomics.wait
// ---------------------------------------------------------------------------

const DEFAULT_LOCK_STALE_MS = 60_000;
const DEFAULT_LOCK_POLL_MS = 150;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 10 * 60_000;

/** Exported for tests only (test/embed-model-cache-fixtures-unit.ts needs to
 *  plant a stale/pre-existing lock file at the exact path this resolver
 *  will look for) — not part of the module's real public API surface. */
export function lockPathFor(cacheDir: string, modelId: string): string {
    const hash = crypto.createHash('sha1').update(modelId).digest('hex').slice(0, 16);
    return path.join(cacheDir, `.lock-${hash}`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LockOptions {
    now?: () => number;
    lockStaleMs?: number;
    lockPollMs?: number;
    lockWaitTimeoutMs?: number;
}

/**
 * Run `doWork()` while holding an exclusive, cross-process lock on
 * `modelId` under `cacheDir`. A caller that loses the race to acquire the
 * lock never runs `doWork()` itself — it polls `onAlreadyReady()` (async
 * `setTimeout`, never `Atomics.wait` / a busy loop) until either that
 * returns a defined value (the winner finished) or the lock is found to be
 * older than `lockStaleMs` (the winner is presumed dead — crashed, killed
 * — and this caller takes the lock over itself).
 *
 * The lock file is removed in a `finally` after `doWork()` settles either
 * way, so a thrown error never leaves a live lock behind.
 */
async function withModelLock<T>(
    modelId: string,
    cacheDir: string,
    opts: LockOptions,
    onAlreadyReady: () => T | undefined,
    doWork: () => Promise<T>,
): Promise<T> {
    const now = opts.now ?? Date.now;
    const staleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    const pollMs = opts.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
    const waitTimeoutMs = opts.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
    const lockPath = lockPathFor(cacheDir, modelId);
    const deadline = now() + waitTimeoutMs;

    for (;;) {
        let fd: number | undefined;
        try {
            fd = fs.openSync(lockPath, 'wx', 0o600);
        } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        }
        if (fd !== undefined) {
            try {
                fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() }));
            } catch { /* diagnostics only */ }
            try { fs.closeSync(fd); } catch { /* best-effort */ }
            // 3.24 review nit: refresh the lock's mtime while this holder is
            // alive, so a slow-but-alive doWork() (a big download on a slow
            // link) isn't mistaken by another process's staleness check for
            // a crashed holder — previously staleness was measured only from
            // the lock's creation time. `.unref()`'d; cleared in `finally`.
            const heartbeat = setInterval(() => {
                try { fs.utimesSync(lockPath, new Date(), new Date()); } catch { /* lock is gone; unlink/takeover will settle it */ }
            }, Math.max(1000, Math.floor(staleMs / 3)));
            heartbeat.unref?.();
            try {
                return await doWork();
            } finally {
                clearInterval(heartbeat);
                try { fs.unlinkSync(lockPath); } catch { /* best-effort — ENOENT is fine */ }
            }
        }

        // Someone else holds (or held) the lock. Check readiness before
        // deciding whether to wait or take over.
        const ready = onAlreadyReady();
        if (ready !== undefined) return ready;

        try {
            const st = fs.statSync(lockPath);
            if (now() - st.mtimeMs > staleMs) {
                try { fs.unlinkSync(lockPath); } catch { /* another caller may have already removed/renewed it */ }
                continue; // retry immediately — try to become the winner
            }
        } catch {
            continue; // lock vanished between EEXIST and stat — retry immediately
        }

        if (now() >= deadline) {
            throw new Error(`embedding model cache: timed out waiting for the lock on "${modelId}"`);
        }
        await sleep(pollMs);
    }
}

// ---------------------------------------------------------------------------
// Staging + install
// ---------------------------------------------------------------------------

/** Copy the required files for `dtype` out of the legacy transformers.js
 *  cache into a fresh staging directory under `cacheDir`. Returns both the
 *  staging root (to `rmQuiet` afterward) and the staged leaf directory that
 *  `installStagedModel` renames into place. Never touches the network. */
function stageFromLegacy(legacyModelDir: string, cacheDir: string, onnxFile: string): { stagingRoot: string; stagedModelDir: string } {
    const stagingRoot = path.join(cacheDir, `.staging-${crypto.randomBytes(6).toString('hex')}`);
    const stagedModelDir = path.join(stagingRoot, 'model');
    fs.mkdirSync(stagedModelDir, { recursive: true, mode: 0o700 });
    const required = [...EMBED_COMMON_FILES, `onnx/${onnxFile}`];
    for (const rel of required) {
        const dst = path.join(stagedModelDir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        // COPYFILE_FICLONE: copy-on-write clone where the filesystem supports
        // it (APFS, btrfs, XFS reflink), plain copy otherwise. Matters because
        // every test process gets its own temp LORE_HOME and would otherwise
        // write a full ~120 MB model copy per process.
        fs.copyFileSync(path.join(legacyModelDir, rel), dst, fs.constants.COPYFILE_FICLONE);
    }
    return { stagingRoot, stagedModelDir };
}

/** Atomically (rename-based, F5-style) install a verified staged directory
 *  as `<cacheDir>/<modelId>`, then write the `.complete` marker — only
 *  after the rename, so a reader can never observe `.complete` next to a
 *  half-renamed tree. Identical placement discipline to modelsFetch.ts's
 *  rerank-side install step. */
function installStagedModel(
    stagedModelDir: string,
    cacheDir: string,
    modelId: string,
    markerFields: Record<string, unknown>,
): string {
    const finalModelDir = path.join(cacheDir, modelId);
    const orgDir = path.dirname(finalModelDir);
    fs.mkdirSync(orgDir, { recursive: true, mode: 0o700 });
    const priorBackup = fs.existsSync(finalModelDir) ? `${finalModelDir}.prev-${crypto.randomBytes(4).toString('hex')}` : undefined;
    if (priorBackup) fs.renameSync(finalModelDir, priorBackup);
    try {
        fs.renameSync(stagedModelDir, finalModelDir);
    } catch (err) {
        if (priorBackup) { try { fs.renameSync(priorBackup, finalModelDir); } catch { /* best-effort rollback */ } }
        throw err;
    }
    if (priorBackup) rmQuiet(priorBackup);
    try { fs.chmodSync(finalModelDir, 0o700); } catch { /* best-effort */ }
    const marker = { ...markerFields, fetchedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(finalModelDir, '.complete'), JSON.stringify(marker, null, 2) + '\n', { mode: 0o600 });
    return finalModelDir;
}

// ---------------------------------------------------------------------------
// Download (network step — the only one)
// ---------------------------------------------------------------------------

export interface DownloadEmbedModelParams {
    modelId: string;
    dtype: ModelDtype;
    stagingDir: string;
    revision?: string;
}

/** Default downloader: the same `pipeline('feature-extraction', ...)` call
 *  `localEmbeddingProvider.ts` makes for real use, but pointed at a staging
 *  dir with `local_files_only:false` so it may reach the network. Dynamic
 *  import — this module must not pull in `@huggingface/transformers` for
 *  callers on the marker-hit or legacy-cache-hit paths, which never need
 *  it. Tests inject their own `downloadModel` instead of calling this.
 *  Exported as `downloadEmbedModel` so `lore models fetch-embedding`
 *  (cli/commands/modelsFetchEmbedding.ts) reuses this exact call rather
 *  than forking its own copy — the CLI command's only reason to exist
 *  separately from this resolver is its interactive `--model`/`--dtype`/
 *  `--revision` argument handling and console output. */
export async function defaultDownloadModel(params: DownloadEmbedModelParams): Promise<void> {
    const transformers = await import('@huggingface/transformers');
    const { pipeline } = transformers as unknown as {
        pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<{ dispose?: () => void }>;
    };
    const opts: Record<string, unknown> = { cache_dir: params.stagingDir, local_files_only: false, dtype: params.dtype, device: 'cpu' };
    if (params.revision) opts['revision'] = params.revision;
    const pipe = await pipeline('feature-extraction', params.modelId, opts);
    try { pipe.dispose?.(); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

export interface ResolveEmbedModelDirOptions extends LockOptions {
    /** Shared cache root — callers pass `loreHomePath('models')`. */
    cacheDir: string;
    /** Override for tests. `undefined` (the default) resolves the real
     *  legacy transformers.js cache; pass an explicit path (including one
     *  that doesn't exist) to control step 2 in a fixture test. */
    legacyCacheDir?: string;
    /** Override for tests — never let a unit test touch the network. */
    downloadModel?: (params: DownloadEmbedModelParams) => Promise<void>;
    /** Never download: a cache miss throws `EmbedModelUnavailableError`
     *  without touching the network. `undefined` follows `LORE_MODELS_OFFLINE`. */
    offline?: boolean;
    /** Pause after a failed download before the next attempt. `undefined`
     *  uses `EMBED_DOWNLOAD_RETRY_PAUSE_MS`; `0` retries on every call. */
    downloadRetryPauseMs?: number;
}

/** Winner-only resolution body: re-checks the marker (another process may
 *  have finished between this caller losing the lock race and re-checking
 *  readiness), then tries the legacy cache, then falls back to download. */
async function resolveEmbedModelDirLocked(
    modelId: string,
    dtype: ModelDtype,
    cacheDir: string,
    opts: ResolveEmbedModelDirOptions,
): Promise<string> {
    const already = embedModelCached(modelId, dtype, cacheDir);
    if (already) return already;

    const isDefault = modelId === DEFAULT_EMBED_MODEL_ID && dtype === DEFAULT_EMBED_MANIFEST_DTYPE;
    const manifest = isDefault ? DEFAULT_EMBED_MANIFEST : undefined;
    const onnxFile = EMBED_DTYPE_ONNX_FILE[dtype];

    // Step 2 — legacy transformers.js cache, no network.
    const legacyRoot = opts.legacyCacheDir !== undefined ? opts.legacyCacheDir : resolveLegacyTransformersCacheDir();
    if (legacyRoot) {
        const legacyModelDir = path.join(legacyRoot, modelId);
        if (legacyHasRequiredFiles(legacyModelDir, onnxFile)) {
            const { stagingRoot, stagedModelDir } = stageFromLegacy(legacyModelDir, cacheDir, onnxFile);
            const mismatch = manifest ? verifyAgainstManifest(stagedModelDir, manifest) : null;
            if (!manifest || !mismatch) {
                const installed = installStagedModel(stagedModelDir, cacheDir, modelId, {
                    modelId, dtype, revision: null, verifiedManifest: Boolean(manifest), source: 'legacy-cache',
                });
                rmQuiet(stagingRoot);
                return installed;
            }
            // Hash mismatch against the pinned manifest — don't trust the
            // legacy copy; fall through to a verified download instead.
            rmQuiet(stagingRoot);
        }
    }

    // Step 3 — download (the only network-touching step). Offline mode
    // stops here, before any staging dir exists or the downloader is called.
    if (opts.offline ?? modelsOfflineFromEnv()) {
        throw new EmbedModelUnavailableError({ modelId, dtype, cacheDir, missing: firstMissingEmbedFile(modelId, dtype, cacheDir), reason: 'offline' });
    }
    // A download that failed moments ago is not re-run: replay its failure
    // until the retry pause has elapsed.
    const retryKey = `${cacheDir}\0${modelId}\0${dtype}`;
    const now = (_embedDownloadRetryForTests.now ?? Date.now)();
    const pauseMs = opts.downloadRetryPauseMs ?? _embedDownloadRetryForTests.pauseMs ?? EMBED_DOWNLOAD_RETRY_PAUSE_MS;
    const prior = lastDownloadFailure.get(retryKey);
    if (prior && now - prior.at < pauseMs) {
        throw new EmbedModelUnavailableError({
            modelId, dtype, cacheDir, missing: firstMissingEmbedFile(modelId, dtype, cacheDir),
            reason: 'download-failed', cause: prior.cause, retryInMs: pauseMs - (now - prior.at),
        });
    }
    const stagingRoot = path.join(cacheDir, `.staging-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const revision = isDefault ? DEFAULT_EMBED_REVISION : undefined;
    const download = opts.downloadModel ?? defaultDownloadModel;
    try {
        await download({ modelId, dtype, stagingDir: stagingRoot, revision });
    } catch (err) {
        // Step 4 — nothing found and the download failed: staging cleaned up
        // so nothing partial lingers, error re-thrown naming the fix.
        rmQuiet(stagingRoot);
        lastDownloadFailure.set(retryKey, { at: (_embedDownloadRetryForTests.now ?? Date.now)(), cause: err });
        throw new EmbedModelUnavailableError({ modelId, dtype, cacheDir, missing: firstMissingEmbedFile(modelId, dtype, cacheDir), reason: 'download-failed', cause: err });
    }
    lastDownloadFailure.delete(retryKey);
    const stagedModelDir = path.join(stagingRoot, modelId);
    flattenRevisionDir(stagedModelDir, revision);
    if (manifest) {
        const mismatch = verifyAgainstManifest(stagedModelDir, manifest);
        if (mismatch) {
            rmQuiet(stagingRoot);
            throw new EmbedIntegrityError(modelId, mismatch);
        }
    }
    const installed = installStagedModel(stagedModelDir, cacheDir, modelId, {
        modelId, dtype, revision: revision ?? null, verifiedManifest: Boolean(manifest), source: 'download',
    });
    rmQuiet(stagingRoot);
    return installed;
}

/**
 * Resolve `modelId`+`dtype` to an absolute, ready-to-load directory under
 * `opts.cacheDir`, running the marker → legacy-cache → download sequence
 * described in this file's header. Safe to call concurrently — either
 * in-process or across separate processes sharing the same `cacheDir` —
 * via the O_EXCL lock; every caller but one either short-circuits on a
 * marker hit or waits for the winner's marker to appear.
 */
export async function resolveEmbedModelDir(
    modelId: string,
    dtype: ModelDtype,
    opts: ResolveEmbedModelDirOptions,
): Promise<string> {
    if (!validateRerankModelId(modelId)) {
        throw new Error(`embedding: invalid model id "${modelId}"`);
    }
    const cacheDir = opts.cacheDir;
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(cacheDir, 0o700); } catch { /* best-effort on pre-existing dirs */ }

    const immediate = embedModelCached(modelId, dtype, cacheDir);
    if (immediate) return immediate;

    return withModelLock(
        modelId,
        cacheDir,
        opts,
        () => embedModelCached(modelId, dtype, cacheDir),
        () => resolveEmbedModelDirLocked(modelId, dtype, cacheDir, opts),
    );
}

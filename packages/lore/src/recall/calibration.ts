/**
 * calibration.ts — D1 (calibrated relevance + abstention).
 *
 * Fits a per-workspace "nothing relevant" null distribution for vector-leg
 * cosine similarity, by running the fixed CALIBRATION_PROBES (see
 * calibrationProbes.ts) through the SAME seed-store `search()` a real query
 * uses, and computes a robust (median/IQR) location+scale. A real query's own
 * top similarity is then converted to a z-score by abstention.ts's
 * `zScore()`, and that z-score is what abstention actually gates on — a raw
 * cosine similarity threshold is not comparable across workspaces/embedding
 * models, but a z-score against the workspace's OWN null distribution is.
 *
 * Deviation from docs/design/D1-calibrated-abstention.md (stated per the
 * IMPLEMENTER instructions): the design's cache key is
 * `workspace | embeddingFingerprint | probeSetVersion | typesKey`. No public
 * accessor for the active embedding-provider fingerprint exists anywhere in
 * the seed-store chain retrieve.ts actually consumes (VerbatimSeedStore only
 * exposes count()/search()/bm25Search(); the underlying VerbatimStore keeps
 * its embeddingProvider private with no getter) — plumbing one through would
 * touch far more files than this defect's scope. v1 therefore keys ONLY on
 * `workspace | probeSetVersion | typesKey`, omitting the embedding
 * fingerprint from the string key. Mitigation (independent review): the
 * cache is additionally scoped per UNDERLYING store object (WeakMap on
 * `VerbatimSeedStore.calibrationIdentity`), so any reopen — the only way an
 * embedder swap or migrate-embedding takes effect — gets a fresh fit, and two
 * Lore instances in one process with the same workspace name never share one.
 * Residual gap: an in-place re-embed on the SAME open store object, with
 * <25% row drift, keeps the old fit until process restart.
 *
 * License: original work for groundfloor-lore.
 */

import { CALIBRATION_PROBES, PROBE_SET_VERSION } from './calibrationProbes.js';
import type { VerbatimSeedStore } from './retrieveSeedStore.js';

export type CalibrationStatus = 'ok' | 'insufficient_rows' | 'degenerate' | 'unavailable' | 'not_applicable' | 'pending';

export interface CalibrationResult {
    status: CalibrationStatus;
    version: string;
    probes: number;
    rows: number;
    nullMedian: number | null;
    nullScale: number | null;
}

/** Below this many rows in the workspace's verbatim store, a calibration fit
 *  is too noisy to trust — a handful of stored nodes doesn't give the probes
 *  a meaningful "nothing relevant" baseline to measure against. Matches
 *  docs/design/D1-calibrated-abstention.md §2 ("insufficient_rows: store
 *  count < 50") — a prior implementation value of 20 had no stated reason
 *  for the deviation, so this was aligned to the doc (D1 follow-up). */
const MIN_ROWS_FOR_CALIBRATION = 50;
/** At least this fraction of probes must return a usable top-1 similarity
 *  for the fit to be considered representative rather than a fluke. */
const MIN_PROBE_COVERAGE = 0.5;
/** Refresh a cached fit once the workspace's row count has drifted by more
 *  than this fraction since the fit was computed (design §2). */
const DRIFT_REFRESH_FRACTION = 0.25;

interface CacheEntry {
    result: CalibrationResult;
    /** Epoch ms when the fit was stored (for the 'unavailable' retry window). */
    storedAt?: number;
    /** Row count observed at fit time, for the drift-refresh check. */
    fitRows: number;
    /** In-flight promise, for single-flight de-duplication. */
    inflight?: Promise<CalibrationResult>;
}

/** A transient 'unavailable' fit (probes aborted / gate-denied / embed
 *  errors) is retried after this long rather than cached until row drift. */
const UNAVAILABLE_RETRY_MS = 60_000;

/**
 * 3.22.1 security fix — the cache key includes the caller-supplied D2 `types`
 * set, reachable from REST `?types=` and the MCP `types` arg, so a caller can
 * mint distinct keys without limit. Cap entries per store identity (LRU) and
 * cap concurrent background fits process-wide; a non-blocking call that finds
 * the fit pool full returns 'pending' without launching or caching anything,
 * so a later call retries. 64 keys covers realistic type-set variety per
 * workspace; 4 fits bounds the 128-probe search load a flood can generate.
 */
export const MAX_CALIBRATION_KEYS_PER_STORE = 64;
export const MAX_BACKGROUND_FITS = 4;

/**
 * Review fix (fingerprint gap): the cache is scoped to the UNDERLYING store
 * object (`VerbatimSeedStore.calibrationIdentity`) via a WeakMap, so a
 * reopened store — which is what an embedder switch / re-embed / second
 * Lore instance with the same workspace name produces — starts with an empty
 * cache instead of silently reusing another store's null fit. A seed store
 * without an identity (test doubles) falls back to one shared Map.
 */
const cacheByStore = new WeakMap<object, Map<string, CacheEntry>>();
let fallbackCache = new Map<string, CacheEntry>();

function cacheFor(seedStore: VerbatimSeedStore): Map<string, CacheEntry> {
    const id = seedStore.calibrationIdentity;
    if (!id) return fallbackCache;
    let m = cacheByStore.get(id);
    if (!m) { m = new Map(); cacheByStore.set(id, m); }
    return m;
}

/** LRU read: a hit moves the key to the most-recently-used end. */
function cacheGet(cache: Map<string, CacheEntry>, key: string): CacheEntry | undefined {
    const entry = cache.get(key);
    if (entry) { cache.delete(key); cache.set(key, entry); }
    return entry;
}

/** LRU write, then evict least-recently-used entries above the cap. In-flight
 *  entries are skipped (their fit will re-insert on landing anyway). */
function cacheSet(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size <= MAX_CALIBRATION_KEYS_PER_STORE) return;
    for (const [k, e] of cache) {
        if (cache.size <= MAX_CALIBRATION_KEYS_PER_STORE) break;
        if (k === key || e.inflight) continue;
        cache.delete(k);
    }
}

function cacheKey(workspace: string, typesKey: string): string {
    return `${workspace}|${PROBE_SET_VERSION}|${typesKey}`;
}

function median(sorted: number[]): number {
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Linear-interpolation percentile over an already-sorted array (0..1). */
function percentile(sorted: number[], p: number): number {
    const n = sorted.length;
    if (n === 1) return sorted[0]!;
    const idx = p * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo]!;
    const frac = idx - lo;
    return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * Run every calibration probe through the seed store's real `search()` path
 * (top-1 only — the fit only needs the top similarity per probe, matching
 * what abstention gates on for a real query) and fit a robust median/IQR
 * null distribution. Never touches the graph, access tracker, session cache,
 * or `results`/`seeds` — probe hits are local to this function and are
 * discarded after the fit, by construction (see retrieve.ts's own note on
 * why this is sufficient to keep probes out of every warmed cache).
 */
async function computeCalibration(seedStore: VerbatimSeedStore, typesKey: string): Promise<CalibrationResult> {
    const rows = await seedStore.count();
    if (rows < MIN_ROWS_FOR_CALIBRATION) {
        return { status: 'insufficient_rows', version: PROBE_SET_VERSION, probes: CALIBRATION_PROBES.length, rows, nullMedian: null, nullScale: null };
    }

    const scores: number[] = [];
    for (const probe of CALIBRATION_PROBES) {
        try {
            const hits = await seedStore.search(probe, 1);
            const top = hits[0]?.score;
            if (typeof top === 'number' && Number.isFinite(top)) scores.push(top);
        } catch {
            // A single probe failing (transient/gate-denied) doesn't invalidate
            // the whole fit — MIN_PROBE_COVERAGE below decides if too many did.
        }
    }
    void typesKey; // Cache-key only: the D2 types prefilter is already applied inside seedStore.search().

    if (scores.length < CALIBRATION_PROBES.length * MIN_PROBE_COVERAGE) {
        return { status: 'unavailable', version: PROBE_SET_VERSION, probes: CALIBRATION_PROBES.length, rows, nullMedian: null, nullScale: null };
    }

    scores.sort((a, b) => a - b);
    const nullMedian = median(scores);
    const iqr = percentile(scores, 0.75) - percentile(scores, 0.25);
    const nullScale = iqr / 1.349;

    if (!(nullScale >= 0.005)) {
        // Degenerate: every probe landed on (almost) the same similarity —
        // no spread to compute a meaningful z-score against. Report the
        // median for visibility but mark the fit unusable for gating.
        // Threshold matches docs/design/D1-calibrated-abstention.md §2
        // ("degenerate: nullScale < 0.005") — a prior implementation value of
        // 1e-6 had no stated reason for the deviation, so this was aligned to
        // the doc (D1 follow-up).
        return { status: 'degenerate', version: PROBE_SET_VERSION, probes: CALIBRATION_PROBES.length, rows, nullMedian, nullScale: null };
    }

    return { status: 'ok', version: PROBE_SET_VERSION, probes: CALIBRATION_PROBES.length, rows, nullMedian, nullScale };
}

/**
 * getCalibration — the cached, single-flight entry point retrieve.ts calls.
 *
 * `seedStore` null (vector leg not consulted at all — e.g. mode:'keyword',
 * or an unembedded workspace) short-circuits to `not_applicable` with no
 * probe traffic. `typesKey` is currently always '*' (D2's type prefilter
 * hasn't landed) — threaded through now so the cache key is future-proof
 * without another migration.
 *
 * `opts.blocking` (D1 follow-up, default `true`): a host that never turns
 * abstention on has no correctness reason to pay the ~1-2s first-query
 * calibration cost synchronously — the relevance/floor fields are additive
 * `_meta`, not required for a normal answer. Passing `blocking: false` (what
 * `retrieve.ts` does whenever `abstain` is false) makes a fit-needed call
 * return a `'pending'` result immediately while the real fit runs in the
 * background via `launchFit`; a later call sees the cached result once it
 * lands. A host with `abstain: true` still blocks (unchanged), since
 * abstention gating needs the floor to mean something on the very first
 * query. A background fit already in flight is shared with blocking callers
 * too (they await the same promise) — only the launch decision differs.
 */
export async function getCalibration(
    seedStore: VerbatimSeedStore | null,
    workspace: string,
    typesKey: string = '*',
    opts?: { blocking?: boolean },
): Promise<CalibrationResult> {
    if (!seedStore) {
        return { status: 'not_applicable', version: PROBE_SET_VERSION, probes: 0, rows: 0, nullMedian: null, nullScale: null };
    }
    const blocking = opts?.blocking ?? true;

    const cache = cacheFor(seedStore);
    const key = cacheKey(workspace, typesKey);
    const entry = cacheGet(cache, key);
    if (entry) {
        if (entry.inflight) {
            if (blocking) return entry.inflight;
            return pendingResult(entry.fitRows);
        }
        // A transient failure must not pin 'unavailable' for the process
        // lifetime (the >25% drift check alone would never fire on a stable store).
        if (entry.result.status === 'unavailable' && Date.now() - (entry.storedAt ?? 0) < UNAVAILABLE_RETRY_MS) return entry.result;
        // Drift check: refresh if the live row count has moved >25% since fit.
        let liveRows = entry.fitRows;
        try { liveRows = await seedStore.count(); } catch { /* keep cached fit on a transient count() failure */ }
        const drift = entry.fitRows > 0 ? Math.abs(liveRows - entry.fitRows) / entry.fitRows : (liveRows > 0 ? 1 : 0);
        if (entry.result.status !== 'unavailable' && drift <= DRIFT_REFRESH_FRACTION) return entry.result;
    }

    if (!blocking) {
        // Cross-surface parity fix (independent review, retrieval-parity
        // gate): the 128-probe search loop is what's worth deferring, not a
        // single count() read. Without this, two callers hitting the SAME
        // underlying store a few ms apart could observe different states —
        // one 'pending', the other already past a fast, probe-free
        // 'insufficient_rows' decision — purely from scheduling luck, which
        // broke embedded/MCP/REST _meta byte-identity. Doing the cheap rows
        // check inline keeps that decision deterministic and synchronous
        // regardless of `blocking`, while the expensive part (only reached
        // when rows are sufficient) still backgrounds exactly as before.
        let rows = entry?.fitRows ?? 0;
        try { rows = await seedStore.count(); } catch { /* fall through to background fit; count() itself will fail there too */ }
        if (rows < MIN_ROWS_FOR_CALIBRATION) {
            const result: CalibrationResult = { status: 'insufficient_rows', version: PROBE_SET_VERSION, probes: CALIBRATION_PROBES.length, rows, nullMedian: null, nullScale: null };
            cacheSet(cache, key, { result, fitRows: rows, storedAt: Date.now() });
            return result;
        }
        // Fit pool full: don't launch or cache anything — a later call retries.
        if (backgroundFits.size >= MAX_BACKGROUND_FITS) return pendingResult(rows);
        const inflight = launchFit(seedStore, typesKey, cache, key, rows);
        cacheSet(cache, key, { result: entry?.result ?? pendingResult(rows), fitRows: rows, inflight });
        return pendingResult(rows);
    }

    const inflight = computeCalibration(seedStore, typesKey);
    cacheSet(cache, key, { result: entry?.result ?? { status: 'unavailable', version: PROBE_SET_VERSION, probes: 0, rows: 0, nullMedian: null, nullScale: null }, fitRows: entry?.fitRows ?? 0, inflight });
    try {
        const result = await inflight;
        cacheSet(cache, key, { result, fitRows: result.rows, storedAt: Date.now() });
        return result;
    } catch {
        // Never let a calibration failure fail the caller's real query —
        // degrade to 'unavailable' and let the next call retry (no entry left
        // in-flight, and no stale success cached over a failed attempt).
        cache.delete(key);
        return { status: 'unavailable', version: PROBE_SET_VERSION, probes: CALIBRATION_PROBES.length, rows: entry?.fitRows ?? 0, nullMedian: null, nullScale: null };
    }
}

/** Test-only: clear the in-memory cache between unit tests. */
export function _resetCalibrationCacheForTests(): void {
    fallbackCache = new Map();
}

/** Test-only: number of cached fits held for this seed store's identity. */
export function _calibrationCacheSizeForTests(seedStore: VerbatimSeedStore): number {
    return cacheFor(seedStore).size;
}

/** Test-only: number of background fits currently in flight. */
export function _backgroundFitCountForTests(): number {
    return backgroundFits.size;
}

function pendingResult(fitRows: number): CalibrationResult {
    return { status: 'pending', version: PROBE_SET_VERSION, probes: CALIBRATION_PROBES.length, rows: fitRows, nullMedian: null, nullScale: null };
}

/**
 * In-flight background fits (launched by a non-blocking `getCalibration`
 * call), tracked so shutdown/dispose can wait for them briefly instead of
 * abandoning them mid-search — see `drainBackgroundCalibrations()`. Each
 * promise here NEVER rejects (errors are swallowed to 'unavailable' inside
 * `launchFit`), so nothing here can produce an unhandled rejection even when
 * fired-and-forgotten by a caller that doesn't await it.
 */
const backgroundFits = new Set<Promise<CalibrationResult>>();

/**
 * Starts `computeCalibration` in the background and returns a promise that
 * resolves once it lands in `cache` (result cached, or degraded to
 * 'unavailable' on error) — mirrors the blocking path's own error handling
 * in `getCalibration`, but never throws, since nothing awaits this on the
 * request path.
 */
function launchFit(
    seedStore: VerbatimSeedStore,
    typesKey: string,
    cache: Map<string, CacheEntry>,
    key: string,
    fitRowsAtLaunch: number,
): Promise<CalibrationResult> {
    const p = (async (): Promise<CalibrationResult> => {
        try {
            const result = await computeCalibration(seedStore, typesKey);
            cacheSet(cache, key, { result, fitRows: result.rows, storedAt: Date.now() });
            return result;
        } catch {
            cache.delete(key);
            return { status: 'unavailable', version: PROBE_SET_VERSION, probes: CALIBRATION_PROBES.length, rows: fitRowsAtLaunch, nullMedian: null, nullScale: null };
        }
    })();
    backgroundFits.add(p);
    void p.finally(() => { backgroundFits.delete(p); });
    return p;
}

/**
 * Shutdown/dispose hook (D1 follow-up): waits briefly for any background
 * calibration fits still running so they don't get cut off mid-`search()`
 * against a store that's about to close, then gives up and returns — it
 * never blocks shutdown indefinitely. The race's own timer is `unref()`'d so
 * an abandoned fit (one that genuinely hangs) cannot keep the process alive
 * past this call. Call this BEFORE closing the graph/verbatim store handles.
 */
export async function drainBackgroundCalibrations(timeoutMs = 5000): Promise<void> {
    if (backgroundFits.size === 0) return;
    const pending = Array.from(backgroundFits);
    await Promise.race([
        Promise.allSettled(pending).then(() => undefined),
        new Promise<void>((resolve) => {
            const t = setTimeout(resolve, timeoutMs);
            if (typeof t.unref === 'function') t.unref();
        }),
    ]);
}

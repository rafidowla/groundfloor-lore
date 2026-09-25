/**
 * rerankStage.ts — D8 (Lore 3.23): the optional local cross-encoder
 * re-rank stage. See DESIGN-3.23.md §3.4 for the binding algorithm.
 *
 * `applyRerankStage` is pure apart from the injected `scorer` call: given
 * the final ranked/filtered/D5-applied `results`, it reorders the top
 * `cfg.k` by cross-encoder score (max over per-node pieces), gated by a
 * margin so a weak new top-1 candidate cannot bump a strong incumbent.
 *
 * `applyRerankStageIfEnabled` is the thin wiring layer `retrieve.ts` calls
 * on every query: it resolves config, decides whether rerank applies at
 * all, and supplies the real scorer (a `LocalRerankProvider`) — or the
 * test-injected one via `setRerankScorerForTest` — before delegating to
 * `applyRerankStage`.
 *
 * Fail-open contract (§3.3): the model not being cached on disk, any
 * load/scoring error, and a timeout are ALL non-fatal — the original
 * `results` order is returned unchanged, with `meta.applied:false` and a
 * `reason`. `results[].score`/`similarity` are never modified by this
 * stage; only a NEW `rerankScore` field is added to the reordered hits
 * (design §3.4 point 7) — so D1 meta, `topScore` and `topSimilarity`
 * upstream in retrieve.ts stay pre-rerank, by construction.
 */

import type { RetrievalResult } from './retrieveTypes.js';
import { resolveRerankConfig, type RerankConfig } from './rerankConfig.js';
import {
    LocalRerankProvider,
    rerankModelCached,
    RerankBusyError,
    RerankIntegrityError,
    type RerankDtype,
} from '../providers/localRerankProvider.js';
import { loreHomePath } from '../config/loreHome.js';

/** A piece is `label + '\n' + body.slice(at, at+1000)`, at 0, 800, 1600, …
 *  (design §3.4 point 2). */
const PIECE_WINDOW_CHARS = 1000;
const PIECE_STRIDE_CHARS = 800;
/** Per-node and per-query piece caps (design §3.4 point 2). */
const MAX_PIECES_PER_NODE = 16;
const MAX_PIECES_PER_QUERY = 128;

export type RerankScorer = (query: string, passages: string[], signal?: AbortSignal) => Promise<number[]>;

export interface RerankMeta {
    model: string;
    dtype: RerankDtype;
    k: number;
    margin: number;
    applied: boolean;
    reason?: 'model_absent' | 'error' | 'timeout' | 'too_few_results' | 'busy' | 'invalid_model' | 'integrity_failed' | 'workspace_disabled';
    gateHeld: boolean;
    replacedTop: boolean;
    latencyMs: number;
    piecesScored: number;
    piecesCapped?: boolean;
}

function baseMetaFor(cfg: RerankConfig): Pick<RerankMeta, 'model' | 'dtype' | 'k' | 'margin'> {
    return { model: cfg.model, dtype: cfg.dtype, k: cfg.k, margin: cfg.margin };
}

/** Build a fail-open `RerankMeta` (order unchanged, nothing applied). */
function failOpenMeta(cfg: RerankConfig, reason: NonNullable<RerankMeta['reason']>, latencyMs: number, piecesScored = 0): RerankMeta {
    return { ...baseMetaFor(cfg), applied: false, reason, gateHeld: false, replacedTop: false, latencyMs, piecesScored };
}

/**
 * Split each candidate's `node.content` into overlapping windows (design
 * §3.4 point 2). Returns the flat piece list, `ownerOf[k]` = the
 * candidate index that owns `pieces[k]`, and whether either cap was hit.
 */
function buildPieces(candidates: RetrievalResult[]): { pieces: string[]; ownerOf: number[]; capped: boolean } {
    const pieces: string[] = [];
    const ownerOf: number[] = [];
    let capped = false;
    outer:
    for (let i = 0; i < candidates.length; i++) {
        const node = candidates[i].node;
        const label = node.label ?? '';
        const body = node.content ?? '';
        if (body.length === 0) {
            if (pieces.length >= MAX_PIECES_PER_QUERY) { capped = true; break; }
            pieces.push(label);
            ownerOf.push(i);
            continue;
        }
        let nodePieceCount = 0;
        for (let at = 0; at < body.length; at += PIECE_STRIDE_CHARS) {
            if (nodePieceCount >= MAX_PIECES_PER_NODE) { capped = true; break; }
            if (pieces.length >= MAX_PIECES_PER_QUERY) { capped = true; break outer; }
            pieces.push(`${label}\n${body.slice(at, at + PIECE_WINDOW_CHARS)}`);
            ownerOf.push(i);
            nodePieceCount++;
            if (at + PIECE_WINDOW_CHARS >= body.length) break;
        }
    }
    return { pieces, ownerOf, capped };
}

/** Score every piece and reduce to one `best[i]` per candidate — the max
 *  over that candidate's pieces (design §3.4 points 3-4). */
async function scoreCandidates(
    query: string,
    candidates: RetrievalResult[],
    scorer: RerankScorer,
    signal?: AbortSignal,
): Promise<{ best: number[]; piecesScored: number; piecesCapped: boolean }> {
    const { pieces, ownerOf, capped } = buildPieces(candidates);
    const best = new Array<number>(candidates.length).fill(-Infinity);
    if (pieces.length === 0) return { best, piecesScored: 0, piecesCapped: capped };
    const scores = await scorer(query, pieces, signal);
    for (let k = 0; k < scores.length; k++) {
        const owner = ownerOf[k];
        if (owner !== undefined && scores[k] > best[owner]) best[owner] = scores[k];
    }
    return { best, piecesScored: pieces.length, piecesCapped: capped };
}

/**
 * The margin gate (design §3.4 point 6). `order` sorts candidate indices
 * by `best` descending, ties broken by original index (stable). If the new
 * top isn't the incumbent (`order[0] !== 0`) and doesn't beat it by at
 * least `margin`, the incumbent is kept at #1 and the rest of `order`
 * (still best-first) fills in behind it — `gateHeld:true`. Otherwise the
 * new order stands as-is.
 */
function applyMarginGate(best: number[], margin: number): { order: number[]; gateHeld: boolean; replacedTop: boolean } {
    const order = best.map((_, i) => i).sort((a, b) => (best[b] !== best[a] ? best[b] - best[a] : a - b));
    if (order[0] !== 0 && best[order[0]] - best[0] < margin) {
        return { order: [0, ...order.filter((i) => i !== 0)], gateHeld: true, replacedTop: false };
    }
    return { order, gateHeld: false, replacedTop: order[0] !== 0 };
}

class RerankTimeoutError extends Error {
    constructor() {
        super('rerank stage timed out');
        this.name = 'RerankTimeoutError';
    }
}

/**
 * D8d (F2) hardening: previously `Promise.race`d `promise` against a timer
 * and returned on whichever settled first — but the LOSING promise (the
 * real scoring work, on a timeout) kept running to completion in the
 * background; nothing was ever actually cancelled, so a slow/hung scorer
 * kept burning CPU on a query the caller had already given up on. Now an
 * `AbortController` is armed alongside the timer and passed to `run` — the
 * scorer (`LocalRerankProvider.score`) checks `signal.aborted` BETWEEN
 * forward-pass batches and throws `signal.reason` (this exact
 * `RerankTimeoutError` instance) as soon as it notices, instead of only
 * racing a `Promise` that never stops the underlying work. An in-flight ONNX
 * forward pass itself still can't be interrupted mid-call (no native
 * cancellation in onnxruntime) — cancellation is checked at batch
 * boundaries, matching design §3.4's batching granularity.
 */
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race, not just abort-and-await: `run`'s own promise settling is what
    // we return on, but the fail-open TIMEOUT GUARANTEE cannot depend on
    // the scorer cooperating with `signal` — a scorer that doesn't check it
    // (any non-`LocalRerankProvider` implementation, including test
    // doubles) would otherwise keep this Promise pending past `ms` and the
    // caller would never fail open. The signal is still passed and aborted
    // so a cooperative scorer (the real provider) stops its own CPU work
    // early; the race is what makes the timeout unconditional.
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort(new RerankTimeoutError());
            reject(new RerankTimeoutError());
        }, ms);
    });
    try {
        return await Promise.race([run(controller.signal), timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * applyRerankStage — pure apart from the `scorer` call. Reorders the top
 * `cfg.k` of `results` by cross-encoder score with the margin gate; the
 * rest of `results` (beyond K) passes through untouched. `scorer` is
 * optional only for the trivial `results.length < 2` skip path (no
 * scoring is possible or needed there) — any caller reaching the actual
 * scoring path with no scorer gets a thrown programming-error, not a
 * silent fail-open, since that is a caller bug (missing wiring), not a
 * runtime condition the design's fail-open contract covers.
 */
export async function applyRerankStage(
    results: RetrievalResult[],
    query: string,
    cfg: RerankConfig,
    scorer?: RerankScorer,
): Promise<{ results: RetrievalResult[]; meta: RerankMeta }> {
    const t0 = Date.now();
    if (results.length < 2) {
        return { results, meta: failOpenMeta(cfg, 'too_few_results', Date.now() - t0) };
    }
    if (!scorer) {
        throw new Error('applyRerankStage: scorer is required when results.length >= 2');
    }

    const K = Math.min(cfg.k, results.length);
    const candidates = results.slice(0, K);
    const rest = results.slice(K);

    let scored: { best: number[]; piecesScored: number; piecesCapped: boolean };
    try {
        scored = await withTimeout((signal) => scoreCandidates(query, candidates, scorer, signal), cfg.timeoutMs);
    } catch (err) {
        // F9: truncate/normalize before logging — an untrusted or malformed
        // error message (e.g. from a misbehaving scorer) must not blow out
        // log volume or embed control characters into structured logs.
        const rawMsg = err instanceof Error ? err.message : String(err);
        const msg = rawMsg.length > 300 ? `${rawMsg.slice(0, 300)}…` : rawMsg;
        if (err instanceof RerankTimeoutError) {
            console.error(`[rerankStage] timed out after ${cfg.timeoutMs}ms scoring ${K} candidates with ${cfg.model} — failing open (original order kept)`);
            return { results, meta: failOpenMeta(cfg, 'timeout', Date.now() - t0) };
        }
        if (err instanceof RerankBusyError) {
            console.error(`[rerankStage] busy — concurrent score-run budget exhausted, scoring ${K} candidates with ${cfg.model} — failing open (original order kept)`);
            return { results, meta: failOpenMeta(cfg, 'busy', Date.now() - t0) };
        }
        if (err instanceof RerankIntegrityError) {
            console.error(`[rerankStage] integrity check failed for ${cfg.model} — failing open (original order kept): ${msg}`);
            return { results, meta: failOpenMeta(cfg, 'integrity_failed', Date.now() - t0) };
        }
        const cls = err instanceof Error ? err.constructor.name : typeof err;
        console.error(`[rerankStage] ${cls} scoring ${K} candidates with ${cfg.model} — failing open (original order kept): ${msg}`);
        return { results, meta: failOpenMeta(cfg, 'error', Date.now() - t0) };
    }

    const { best, piecesScored, piecesCapped } = scored;
    const { order, gateHeld, replacedTop } = applyMarginGate(best, cfg.margin);
    const reordered = order.map((i) => ({ ...candidates[i], rerankScore: best[i] }));

    return {
        results: [...reordered, ...rest],
        meta: {
            ...baseMetaFor(cfg),
            applied: true,
            gateHeld,
            replacedTop,
            latencyMs: Date.now() - t0,
            piecesScored,
            ...(piecesCapped ? { piecesCapped: true } : {}),
        },
    };
}

// Test-only scorer seam. Null in production — mirrors retrieve.ts's
// setRetrieveOptionsSpy pattern. `applyRerankStageIfEnabled` (the only
// caller wired into retrieve.ts) checks this BEFORE touching the real
// LocalRerankProvider / filesystem model-cache check, so a test that sets
// this never imports @huggingface/transformers or touches LORE_HOME/models.
let testScorer: RerankScorer | null = null;
export function setRerankScorerForTest(fn: RerankScorer | null): void {
    testScorer = fn;
}

/**
 * applyRerankStageIfEnabled — the wiring helper `retrieve.ts` calls.
 * Resolves config (see rerankConfig.ts's header for the full D8d
 * precedence). When `cfg.enabled` is false:
 *   - a plain "off" (per-query false, workspace absent + env/default off,
 *     etc. — `cfg.disabledReason` unset): returns `results` unchanged with
 *     NO meta at all (design §3.4: "present only when rerank was enabled
 *     for the call"; also D8d's byte-identical-off contract).
 *   - a SPECIFIC reason (`cfg.disabledReason` set — currently
 *     'workspace_disabled' or 'invalid_model'): returns `results` unchanged
 *     but WITH `rerankMeta` so the caller can see *why* — this is the one
 *     case where a per-query `rerank:true` was overridden (workspace-off)
 *     or a misconfigured model silently no-opped, and both are worth
 *     surfacing even though nothing was applied.
 *
 * When enabled:
 *   - fewer than 2 results: fail-open, reason 'too_few_results', without
 *     even checking the model cache.
 *   - a test scorer is installed: use it (never touches the filesystem
 *     cache check or transformers).
 *   - otherwise: `rerankModelCached()` gates a real `LocalRerankProvider`
 *     — model not cached (the common case under default-on with nothing
 *     ever fetched) => fail-open, reason 'model_absent', with NO import of
 *     @huggingface/transformers (see localRerankProvider.ts). This check is
 *     a plain per-call filesystem stat, not memoized across calls, so a
 *     model that appears later (via `lore models fetch-rerank`) is picked
 *     up on the very next query with no cache to invalidate.
 */
export async function applyRerankStageIfEnabled(
    results: RetrievalResult[],
    query: string,
    perCallRerank: boolean | undefined,
    workspace: string | undefined,
): Promise<{ results: RetrievalResult[]; rerankMeta?: RerankMeta }> {
    const cfg = resolveRerankConfig(perCallRerank, workspace);
    if (!cfg.enabled) {
        if (cfg.disabledReason) {
            return { results, rerankMeta: failOpenMeta(cfg, cfg.disabledReason, 0) };
        }
        return { results };
    }

    if (results.length < 2) {
        return { results, rerankMeta: failOpenMeta(cfg, 'too_few_results', 0) };
    }

    if (testScorer) {
        const { results: newResults, meta } = await applyRerankStage(results, query, cfg, testScorer);
        return { results: newResults, rerankMeta: meta };
    }

    const cacheDir = loreHomePath('models');
    if (!rerankModelCached(cfg.model, cfg.dtype, cacheDir)) {
        // Deliberately no transformers import on this path (see
        // localRerankProvider.ts's rerankModelCached doc comment). Operator
        // remedy: `lore models fetch-rerank`.
        return { results, rerankMeta: failOpenMeta(cfg, 'model_absent', 0) };
    }

    const provider = new LocalRerankProvider({ modelId: cfg.model, dtype: cfg.dtype, cacheDir });
    const scorer: RerankScorer = (q, passages, signal) => provider.score(q, passages, signal);
    const { results: newResults, meta } = await applyRerankStage(results, query, cfg, scorer);
    return { results: newResults, rerankMeta: meta };
}

/**
 * D8b — the API-facing `_meta.rerank` shape (design DESIGN-3.23.md §3.1's
 * exact field list: `{model, applied, gate_held, replaced_top, reason?, k,
 * margin, latency_ms, pieces_scored, pieces_capped?}`). Deliberately drops
 * `dtype` — not in that list — and converts the rest to snake_case, since
 * every other recall response field (`relevance_floor`, `top_score`, …)
 * uses that convention at the wire boundary while internal TS types stay
 * camelCase.
 */
export interface SnakeRerankMeta {
    model: string;
    applied: boolean;
    gate_held: boolean;
    replaced_top: boolean;
    reason?: RerankMeta['reason'];
    k: number;
    margin: number;
    latency_ms: number;
    pieces_scored: number;
    pieces_capped?: boolean;
}

export function toSnakeRerankMeta(m: RerankMeta): SnakeRerankMeta {
    return {
        model: m.model,
        applied: m.applied,
        gate_held: m.gateHeld,
        replaced_top: m.replacedTop,
        ...(m.reason ? { reason: m.reason } : {}),
        k: m.k,
        margin: m.margin,
        latency_ms: m.latencyMs,
        pieces_scored: m.piecesScored,
        ...(m.piecesCapped ? { pieces_capped: true as const } : {}),
    };
}

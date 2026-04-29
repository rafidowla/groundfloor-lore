/**
 * similarity.ts — Phase 2: code similarity engine.
 *
 * Per `plan-developer-plugin-trustworthiness-2026-04-27` Phase 2 +
 * the dual-contract architecture decided 2026-04-27 (engine in dev
 * plug-in, NOT core, per the boundary review).
 *
 * Two contracts (same backend):
 *   1. DATA contract — `findSimilarSymbols(content)` returns top-K
 *      existing symbols with cosine similarity. Used by the
 *      `code_similar` MCP tool. Read-only; agent decides what to do.
 *   2. POLICY contract — `evaluatePreWrite(content)` returns a
 *      decision (allow/warn) with a recommended action. Used by the
 *      PreToolUse hook adapters (Claude Code, Cursor). Soft signal —
 *      no hard deny in v1.
 *
 * Both contracts go through the same Lore VerbatimStore (LanceDB +
 * Xenova local embedder). Symbol embeddings live alongside knowledge
 * embeddings, distinguished by ID prefix `symbol:<repo>/<symbolUid>`.
 */

import type { PluginContext, PluginGraphContext } from '@lore-core/plugins/types.js';
import type { VerbatimStore } from '@lore-core/engines/verbatimStore.js';
import { buildVerbatimText } from '@lore-core/engines/verbatimStore.js';
import * as ops from './operations.js';
import type { CodeSymbol } from './types.js';

/* ─── ID prefix convention ────────────────────────────────────── */

/**
 * Code-symbol embeddings live in LanceDB under `symbol:<uid>`.
 * The uid itself encodes repo + path + name + kind, e.g.
 * `groundfloor-lore::src/mcp/server.ts::handleRecall::Function`.
 * Lore knowledge nodes use `lore:<id>` (defined in core's reconnect.ts).
 *
 * Convention is established by `reconnect.ts:contributeDeveloperReconnectNodes`
 * — keep them aligned so the same vector space is used for ingest and search.
 */
export const SYMBOL_PREFIX = 'symbol:';

export function symbolEmbeddingId(uid: string): string {
    return `${SYMBOL_PREFIX}${uid}`;
}

/* ─── Types ────────────────────────────────────────────────────── */

export interface SimilarSymbolHit {
    /** Symbol UID (without prefix). */
    uid: string;
    /** Repository name. */
    repo: string;
    /** Symbol name. */
    name: string;
    /** Symbol kind: function, class, method, etc. */
    kind: string;
    /** Path inside the repo. */
    filePath: string;
    /** First line in the source file. */
    startLine?: number;
    /** Cosine similarity score in [0, 1]. Higher = more similar. */
    score: number;
    /** Lore node id for the symbol — for fetching full context via get_full. */
    loreNodeId: string;
}

export interface FindSimilarOptions {
    /** Max hits to return (default 5). */
    k?: number;
    /** Minimum cosine similarity threshold (default 0.65). */
    minSim?: number;
    /** Restrict search to a specific repo. */
    repo?: string;
    /** Optional language hint — for richer description text in the embedding. */
    language?: string;
}

export interface PreWriteDecision {
    /** allow = no concern; warn = something similar exists; (deny reserved for v2). */
    decision: 'allow' | 'warn';
    /** Top match if any. Null when allow + nothing close. */
    topMatch: SimilarSymbolHit | null;
    /** All matches above threshold (for the "loud response" pattern). */
    matches: SimilarSymbolHit[];
    /** Plain-English recommendation for the agent. */
    recommendation: string;
    /** True when topMatch.score >= STRONG_MATCH_THRESHOLD. */
    strongMatch: boolean;
}

/* ─── Tunable thresholds ──────────────────────────────────────── */

/**
 * Tier B calibration (2026-04-27, after Tier A's reconnect rejected).
 * Xenova all-MiniLM produces a noise floor around 0.85 on this corpus,
 * so absolute thresholds don't separate signal from noise. We use
 * RELATIVE RANKING instead: top match must stand out from the next K.
 */

/** Floor: don't bother evaluating anything below this. Filter only. */
const HARD_FLOOR = 0.70;

/** Top match must be at least this many z-scores above the K-near mean. */
const Z_SCORE_WARN = 1.5;
const Z_SCORE_STRONG = 2.5;

/** Backstop: even if z-score is low, an absolute >0.95 is always strong. */
const ABSOLUTE_STRONG = 0.95;

/** Number of "next neighbors" used to compute the relative baseline. */
const REL_BASELINE_K = 5;

/**
 * Std floor — when neighbors are bunched (all ~equally distant), a tiny
 * std inflates z-score artificially. A 0.4-pt difference looks like 4σ
 * if std is 0.001, but it's not actually a meaningful standout. The floor
 * guarantees z-scores reflect a real per-position spread.
 */
const STD_FLOOR = 0.01;

/**
 * Minimum baseline mean for z-score to mean anything. If the next-K mean
 * is below this, we're searching in pure noise (no real candidates) and
 * a "standout" is meaningless. Empirically: Xenova all-MiniLM's baseline
 * for unrelated code lives ~0.85; below 0.86 = no real cohort exists.
 */
const MIN_MEANINGFUL_BASELINE = 0.86;

/**
 * Minimum absolute score the top match must hit before any warn fires.
 * Avoids "Fibonacci among unrelated noise" false positives — the cohort
 * needs to be at least somewhat related to the proposed code before a
 * z-score is even computed.
 */
const MIN_TOP_FOR_WARN = 0.87;

/* ─── DATA contract — findSimilarSymbols ──────────────────────── */

/**
 * findSimilarSymbols — search the embedding store for code symbols
 * close to the given content. Read-only; returns ranked hits.
 *
 * Used by:
 *   - The `code_similar` MCP tool (agents call this directly).
 *   - The POLICY contract below (evaluatePreWrite wraps this).
 */
export async function findSimilarSymbols(
    ctx: PluginContext,
    content: string,
    opts: FindSimilarOptions = {},
): Promise<SimilarSymbolHit[]> {
    if (!content || !content.trim()) return [];
    const k = opts.k ?? 5;
    const minSim = opts.minSim ?? 0.65;

    const verbatim = ctx.verbatimStore as VerbatimStore;
    if (!verbatim) return [];
    await verbatim.initialize();

    // Build the search text the same way ingest does — keeps the
    // embedding space consistent with what's already stored.
    const searchText = buildVerbatimText(
        '', // no label for an ad-hoc query
        content,
        opts.language ?? '',
    );

    // Pull more than k so we have room after prefix + repo filtering.
    const overscan = Math.max(k * 4, 20);
    const rawHits = await verbatim.search(searchText, overscan);

    // Symbol metadata lookup goes through the plugin graph context.
    const graph = ctx.graph as { createPluginGraphContext: () => PluginGraphContext };
    const graphCtx = graph.createPluginGraphContext();

    const symbolHits: SimilarSymbolHit[] = [];
    for (const hit of rawHits) {
        if (!hit.id.startsWith(SYMBOL_PREFIX)) continue;
        const score = hit.score ?? 0;
        if (score < minSim) continue;

        const uid = hit.id.slice(SYMBOL_PREFIX.length);

        // Enrich with CodeSymbol metadata. Skip if the symbol no
        // longer exists in the graph (stale embedding).
        const symbol = await ops.getCodeSymbolByUid(graphCtx, uid);
        if (!symbol) continue;
        if (opts.repo && symbol.repo !== opts.repo) continue;

        symbolHits.push({
            uid: symbol.uid,
            repo: symbol.repo,
            name: symbol.name,
            kind: symbol.kind,
            filePath: symbol.filePath,
            startLine: symbol.startLine,
            score,
            loreNodeId: hit.id,
        });

        if (symbolHits.length >= k) break;
    }

    return symbolHits;
}

/* ─── AST pre-filter + name extraction ────────────────────────── */

/**
 * detectProposedKind — quick text-shape detection of what the agent is
 * about to write. Pre-filters candidate symbols to the same kind so
 * a proposed function isn't compared against a class that happens to
 * share vocabulary. Returns null if shape is ambiguous (no filter).
 */
export function detectProposedKind(content: string): string | null {
    const trimmed = content.trim();
    if (/^\s*(export\s+)?(async\s+)?function\s+/m.test(trimmed)) return 'Function';
    if (/^\s*(export\s+)?class\s+/m.test(trimmed)) return 'Class';
    if (/^\s*(export\s+)?interface\s+/m.test(trimmed)) return 'Interface';
    if (/^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/m.test(trimmed)) return 'Function';
    if (/^\s+(public\s+|private\s+|protected\s+|static\s+)?(async\s+)?[a-zA-Z_]\w*\s*\([^)]*\)\s*[:{]/m.test(trimmed)) return 'Method';
    return null;
}

/**
 * extractProposedName — pull the identifier the agent is about to
 * declare, so we can search by NAME (which Xenova all-MiniLM
 * discriminates on, ~3-4pt gap) instead of by code body alone
 * (which it doesn't discriminate on — all bodies cluster at ~88%).
 *
 * Returns null when the shape is anonymous (e.g. `(x) => x + 1` with
 * no surrounding `const = `) or unparseable. Caller falls back to
 * body-only search in that case.
 */
export function extractProposedName(content: string): string | null {
    const trimmed = content.trim();
    let m: RegExpExecArray | null;
    m = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/m.exec(trimmed);
    if (m) return m[1];
    m = /^\s*(?:export\s+)?class\s+(\w+)/m.exec(trimmed);
    if (m) return m[1];
    m = /^\s*(?:export\s+)?interface\s+(\w+)/m.exec(trimmed);
    if (m) return m[1];
    m = /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/m.exec(trimmed);
    if (m) return m[1];
    // Method shape inside a class body — first non-keyword identifier on its line
    m = /^\s+(?:public\s+|private\s+|protected\s+|static\s+)?(?:async\s+)?(\w+)\s*\(/m.exec(trimmed);
    if (m && !['if', 'for', 'while', 'switch', 'return', 'function'].includes(m[1])) return m[1];
    return null;
}

/* ─── POLICY contract — evaluatePreWrite ──────────────────────── */

/**
 * evaluatePreWrite — wrap findSimilarSymbols with a decision +
 * recommendation suitable for the PreToolUse hook adapters.
 *
 * Tier B calibration (2026-04-27): uses AST pre-filter (same-kind
 * only) + relative-ranking decision (z-score above K-near baseline)
 * because Xenova all-MiniLM's narrow score band on code makes
 * absolute thresholds unreliable. See bug-phase2-tier-a-rejected-*.
 *
 * Returns a "loud response" per advisor Rec #2: even on Antigravity
 * or other no-hook IDEs, the response shape itself nudges the agent
 * toward the right action.
 */
export async function evaluatePreWrite(
    ctx: PluginContext,
    content: string,
    opts: FindSimilarOptions & { warnThreshold?: number } = {},
): Promise<PreWriteDecision> {
    const proposedKind = detectProposedKind(content);
    const proposedName = extractProposedName(content);

    // Pivot 2026-04-27: name-based search, not body-based. The embedder
    // discriminates names (3-4pt gap) but not bodies (all cluster at
    // ~88%). When we extract a name, we use the indexed shape
    // `buildVerbatimText(name, body, kind)` so the embedding space
    // matches what was indexed. If name can't be extracted, we fall
    // back to body-only search (works less well but better than nothing).
    const searchContent = proposedName
        ? `${proposedName}\n\n${content}`
        : content;

    // Pull a wide candidate set so the relative baseline is meaningful.
    const allMatches = await findSimilarSymbols(ctx, searchContent, {
        ...opts,
        k: 20,
        minSim: opts.minSim ?? HARD_FLOOR,
        language: opts.language ?? proposedKind ?? '',
    });

    // AST pre-filter: only compare like-kind. Functions to functions,
    // classes to classes, etc. Drops cross-kind noise that the embedder
    // can't disambiguate.
    const matches = proposedKind
        ? allMatches.filter((m) => m.kind === proposedKind)
        : allMatches;

    // Hard win: exact name collision means the agent is about to
    // re-declare an identifier that already exists. This is the
    // single most useful "stop me reinventing" signal — surface it
    // even when the embedding similarity is in the noise band.
    if (proposedName) {
        const exactNameMatch = matches.find((m) => m.name === proposedName);
        if (exactNameMatch) {
            const where = `${exactNameMatch.filePath}${exactNameMatch.startLine ? ':' + exactNameMatch.startLine : ''}`;
            return {
                decision: 'warn',
                topMatch: exactNameMatch,
                matches,
                recommendation: `NAME COLLISION: '${proposedName}' (${exactNameMatch.kind}) already exists at ${where} (${(exactNameMatch.score * 100).toFixed(0)}% similar). Extend it or pick a different name.`,
                strongMatch: true,
            };
        }
    }

    const topMatch = matches[0] ?? null;
    if (!topMatch) {
        return {
            decision: 'allow',
            topMatch: null,
            matches: [],
            recommendation: proposedKind
                ? `No existing ${proposedKind.toLowerCase()}s look similar.`
                : 'No similar existing code found.',
            strongMatch: false,
        };
    }

    // Relative ranking: how far above the next-K mean is the top match?
    // High z-score = standout = real signal. Low z-score = top is just
    // the front of a noisy band = no real duplicate.
    const baseline = matches.slice(1, 1 + REL_BASELINE_K);
    const baselineMean =
        baseline.length > 0
            ? baseline.reduce((s, m) => s + m.score, 0) / baseline.length
            : topMatch.score;
    // Std floor prevents inflated z-scores when neighbors are bunched
    // — a 0.4-pt difference with std=0.001 looks like 400σ but is noise.
    const rawStd = baseline.length > 1
        ? Math.sqrt(
            baseline.reduce((s, m) => s + (m.score - baselineMean) ** 2, 0) / baseline.length,
        )
        : 0;
    const baselineStd = Math.max(rawStd, STD_FLOOR);
    const zScore = (topMatch.score - baselineMean) / baselineStd;
    const gapToNext = baseline.length > 0 ? topMatch.score - baseline[0].score : 0;

    // Two guard rails BEFORE the z-score logic fires:
    //   1. Top must clear MIN_TOP_FOR_WARN (otherwise we're just picking
    //      the best of an unrelated cohort — Fibonacci-among-grep-results
    //      false positive).
    //   2. Baseline mean must be high enough to mean a real cohort exists
    //      (otherwise z-score against a noise floor is meaningless).
    const cohortIsReal = baselineMean >= MIN_MEANINGFUL_BASELINE;
    const topIsCredible = topMatch.score >= MIN_TOP_FOR_WARN;

    const strongMatch =
        topMatch.score >= ABSOLUTE_STRONG ||
        (cohortIsReal && topIsCredible && zScore >= Z_SCORE_STRONG);

    const isWarn =
        topMatch.score >= ABSOLUTE_STRONG ||
        (cohortIsReal && topIsCredible && (zScore >= Z_SCORE_WARN || gapToNext >= 0.10));

    if (!isWarn) {
        const reason = !cohortIsReal
            ? `cohort mean ${(baselineMean * 100).toFixed(0)}% — searching in noise`
            : !topIsCredible
                ? `top score ${(topMatch.score * 100).toFixed(0)}% < ${(MIN_TOP_FOR_WARN * 100).toFixed(0)}% threshold`
                : `z-score ${zScore.toFixed(2)}σ — not a standout`;
        return {
            decision: 'allow',
            topMatch: null,
            matches: [],
            recommendation: proposedKind
                ? `Closest ${proposedKind.toLowerCase()} '${topMatch.name}' (${(topMatch.score * 100).toFixed(0)}%) — not a meaningful match (${reason}).`
                : `Closest match '${topMatch.name}' (${(topMatch.score * 100).toFixed(0)}%) — not a meaningful match (${reason}).`,
            strongMatch: false,
        };
    }

    const where = `${topMatch.filePath}${topMatch.startLine ? ':' + topMatch.startLine : ''}`;
    const standoutTag = `[+${(zScore).toFixed(1)}σ above next-${REL_BASELINE_K} mean]`;
    const recommendation = strongMatch
        ? `STRONG MATCH (${(topMatch.score * 100).toFixed(0)}% ${standoutTag}): consider extending '${topMatch.name}' in ${where} instead of creating a new ${topMatch.kind}.`
        : `Possible match (${(topMatch.score * 100).toFixed(0)}% ${standoutTag}): '${topMatch.name}' in ${where} looks related — review before duplicating.`;

    return {
        decision: 'warn',
        topMatch,
        matches,
        recommendation,
        strongMatch,
    };
}

/* ─── INGEST — embed a code symbol ────────────────────────────── */

/**
 * embedSymbol — store a code symbol's embedding in LanceDB so future
 * similarity searches can find it. Called from the importFromGitNexus
 * path on each newly-imported symbol; also exposed for back-fill.
 *
 * The embedding text combines the symbol name, kind, and a snippet of
 * its source body — same shape used by buildVerbatimText elsewhere.
 */
export async function embedSymbol(
    ctx: PluginContext,
    symbol: Pick<CodeSymbol, 'uid' | 'name' | 'kind' | 'filePath' | 'content' | 'repo'>,
): Promise<void> {
    const verbatim = ctx.verbatimStore as VerbatimStore;
    if (!verbatim) return;
    await verbatim.initialize();

    const text = buildVerbatimText(
        `${symbol.kind} ${symbol.name}`,
        symbol.content ?? '',
        `${symbol.kind},${symbol.filePath}`,
    );
    if (!text.trim()) return;

    const id = symbolEmbeddingId(symbol.uid);
    // Append-only: store() handles snapshot-then-overwrite.
    await verbatim.store({
        id,
        text,
        metadata: {
            type: 'code_symbol',
            label: symbol.name,
            tags: `${symbol.kind},${symbol.repo},${symbol.filePath}`,
            project: symbol.repo,
            ecosystem: '',
            updatedAt: new Date().toISOString(),
            security_scopes: [],
        },
    });
}

/**
 * packages/lore/src/recall/ranking.ts — Sprint R ranking layer.
 *
 * Pure, provider-agnostic re-ranking applied on top of vector-store
 * output. Lives outside both `verbatimStore.ts` (local) and the future
 * cloud Zilliz adapter so the same logic runs unchanged on either
 * substrate. Consumed by `packages/lore/src/mcp/http/routes/search.ts`
 * — the single recall HTTP path that serves the `recall` MCP tool, the
 * `lore recall` CLI, and the UserPromptSubmit hook.
 *
 * Formula:
 *   finalScore = baseScore × typeBias × recencyFactor × curationBoost × outcomeWeight
 *
 *   - typeBias: 1.5 for types where NodeTypeSpec.operatorCurated === true
 *     in the workspace schema, 1.0 for all other types. The curated set is
 *     passed in at request-time via RankInputs.curatedTypes — the ranker
 *     itself carries no hardcoded domain type names.
 *   - recencyFactor: `RECENCY_FLOOR + (1 - RECENCY_FLOOR) × exp(-ageDays /
 *     halfLifeDays)`, half-life configurable via
 *     `LORE_RECALL_RECENCY_HALF_LIFE_DAYS` (default 30). Nodes without
 *     `updatedAt` get decay = 1.0 (no penalty). The RAW decay is bounded by
 *     RECENCY_FLOOR (Finding 5.4): the old pure product let recency span
 *     six orders of magnitude over a year while similarity spans < 2×, so
 *     any node older than ~110 days lost to ANY fresh node regardless of
 *     how much better it matched. Recency is now a bounded nudge — it
 *     breaks ties and reorders candidates within ~(1/RECENCY_FLOOR − 1)
 *     relative score of each other, but can never erase a larger
 *     relevance gap.
 *   - curationBoost: × 1.2 when `metadata.curated === true` OR when the
 *     node's type is in the caller-supplied curatedTypes AND has a non-empty
 *     label. Else 1.0.
 *
 * Escape hatch: `LORE_RECALL_RANKING=off` disables all three signals
 * and returns `baseScore` unchanged. Useful for A/B comparisons and
 * as a single-flag rollback if a production tenant ever needs it.
 *
 * Backward compatibility: the HTTP response shape is unchanged; this
 * helper only re-orders results. Clients that don't know about ranking
 * simply see better-ordered hits.
 */

const DEFAULT_HALF_LIFE_DAYS = 30;
const DEFAULT_TYPE_BIAS = 1.5;
const DEFAULT_CURATION_BOOST = 1.2;
const DAY_MS = 86_400_000;

/**
 * RECENCY_FLOOR — the minimum multiplier recency can apply to a node's
 * relevance score (Finding 5.4). recencyDecay itself spans e⁰…e⁻¹² over a
 * year (~6 orders of magnitude) while similarity scores span well under 2×,
 * so multiplying by the raw decay let ANY fresh node outrank ANY old node
 * no matter how much stronger the old node's match was (verified live: a
 * 0.928-similarity exact answer aged 15 half-lives was dropped from the
 * window in favour of 0.75-similarity same-day trivia). Bounding the decay
 * at RECENCY_FLOOR caps recency's total influence at a 1/0.85 ≈ 1.18×
 * swing: enough to break ties and prefer fresher nodes among similarly
 * relevant candidates, never enough to override a materially stronger
 * semantic match.
 */
const RECENCY_FLOOR = 0.85;

/**
 * Outcome-weight constants.
 *
 * Failure-bias rationale: nodes that have been tried and failed should
 * surface MORE prominently during recall, not less — so the agent sees
 * "this approach failed before" before repeating the mistake.
 *
 * FAILURE_BOOST (0.5): pure-failure node with ≥5 outcomes → +50% to score.
 * SUCCESS_BOOST (0.2): pure-success node with ≥5 outcomes → +20% to score.
 * OUTCOME_SATURATION (5): boost ramps linearly to full at 5 outcomes, capped
 *   there so one heavily-exercised node can't dominate the entire result set.
 */
const DEFAULT_FAILURE_BOOST = 0.5;
const DEFAULT_SUCCESS_BOOST = 0.2;
const OUTCOME_SATURATION = 5;

/**
 * OPERATOR_CURATED_TYPES — legacy constant, kept for compatibility only.
 *
 * @deprecated Pass `curatedTypes` via RankInputs instead. This constant
 * contains hardcoded domain-specific type names that belong in workspace
 * schemas (NodeTypeSpec.operatorCurated = true), not in the engine.
 * The default ranking posture is an EMPTY set — schema-agnostic, no
 * built-in type boost. Callers that load a schema should derive
 * curatedTypes from schema.nodeTypes.filter(t => t.operatorCurated).
 *
 * This export is preserved so existing code that imports it can migrate
 * gradually. It is NOT used in the hot ranking path.
 */
export const OPERATOR_CURATED_TYPES: ReadonlySet<string> = new Set([
    'decision',
    'convention',
    'bug_pattern',
    'architecture',
    'architecture-doc',
    'troubleshooting',
    'note',
]);

/** Empty set — the schema-agnostic default. No type gets a type-bias boost. */
const EMPTY_CURATED: ReadonlySet<string> = new Set();

/**
 * Build a curated-type set from a live workspace schema's nodeTypes array.
 * Returns an empty set when nodeTypes is null/undefined (schema-agnostic fallback).
 */
export function curatedTypesFromSchema(
    nodeTypes: ReadonlyArray<{ name: string; operatorCurated?: boolean }> | null | undefined,
): ReadonlySet<string> {
    if (!nodeTypes || nodeTypes.length === 0) return EMPTY_CURATED;
    const curated = nodeTypes.filter((t) => t.operatorCurated === true).map((t) => t.name);
    return curated.length > 0 ? new Set(curated) : EMPTY_CURATED;
}

export interface RankInputs {
    node: {
        type: string;
        updatedAt?: string | null;
        metadata?: string | null;
        label?: string | null;
        /** Outcome counts from Feature 2 — used by outcomeWeight(). All optional
         *  so existing callers that don't pass them default to neutral (1.0). */
        success_count?: number | null;
        failure_count?: number | null;
        partial_count?: number | null;
    };
    /** Base similarity score from the vector store, expected in [0, 1]. */
    baseScore: number;
    /** Override "now" for deterministic tests. */
    nowMs?: number;
    /** Override half-life for tests; otherwise read from env. */
    halfLifeDays?: number;
    /**
     * Set of node type names that get the 1.5× type-bias multiplier.
     * Derived from the workspace schema's NodeTypeSpec.operatorCurated fields
     * at request-time. When omitted or empty, ALL types receive bias 1.0 —
     * the schema-agnostic default posture.
     *
     * Build via: curatedTypesFromSchema(schema.nodeTypes)
     */
    curatedTypes?: ReadonlySet<string>;
}

function isRankingDisabled(): boolean {
    const v = (process.env.LORE_RECALL_RANKING ?? '').toLowerCase();
    return v === 'off' || v === 'false' || v === '0';
}

function readHalfLife(override?: number): number {
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
    const env = Number(process.env.LORE_RECALL_RECENCY_HALF_LIFE_DAYS);
    if (Number.isFinite(env) && env > 0) return env;
    return DEFAULT_HALF_LIFE_DAYS;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * Compute the type-bias multiplier for a node.
 * Returns DEFAULT_TYPE_BIAS (1.5) when the type is in the curated set,
 * 1.0 for everything else. When curatedTypes is omitted or empty, all
 * types receive 1.0 — the schema-agnostic default.
 */
export function typeBias(type: string, curatedTypes?: ReadonlySet<string>): number {
    const set = curatedTypes ?? EMPTY_CURATED;
    return set.size > 0 && set.has(type) ? DEFAULT_TYPE_BIAS : 1.0;
}

/**
 * Compute the recency decay for a node given its `updatedAt` string,
 * the current epoch ms, and a half-life in days. Returns 1.0 when
 * the timestamp is missing/invalid (no penalty for unknown age).
 */
export function recencyDecay(updatedAt: string | null | undefined, nowMs: number, halfLifeDays: number): number {
    if (!updatedAt) return 1.0;
    const ts = Date.parse(updatedAt);
    if (!Number.isFinite(ts)) return 1.0;
    const ageMs = Math.max(0, nowMs - ts);
    const ageDays = ageMs / DAY_MS;
    // exp(-ageDays / halfLifeDays); at age == halfLife → 1/e ≈ 0.368.
    return Math.exp(-ageDays / halfLifeDays);
}

/**
 * Compute the curation boost. Returns DEFAULT_CURATION_BOOST when:
 *   - the node's metadata JSON parses to `{curated: true}`, OR
 *   - the node's type is in curatedTypes AND it has a non-empty label.
 * Else 1.0.
 *
 * When curatedTypes is omitted or empty, only the explicit metadata path
 * (`metadata.curated === true`) triggers the boost.
 */
export function curationBoost(node: RankInputs['node'], curatedTypes?: ReadonlySet<string>): number {
    const meta = parseMetadata(node.metadata);
    if (meta && meta.curated === true) return DEFAULT_CURATION_BOOST;
    const set = curatedTypes ?? EMPTY_CURATED;
    if (set.size > 0 && set.has(node.type)) {
        const label = (node.label ?? '').trim();
        if (label.length > 0) return DEFAULT_CURATION_BOOST;
    }
    return 1.0;
}

/**
 * Compute the outcome-weight multiplier for a node.
 *
 * Failure-bias: nodes with more recorded failures rank HIGHER so agents
 * are reminded of past mistakes before repeating them. Success nodes get
 * a smaller boost (useful context, less urgent than a failure warning).
 * Nodes with no outcome data return 1.0 (neutral — no change to score).
 *
 *   saturation   = min(total / OUTCOME_SATURATION, 1.0)
 *   failureSignal = failure_count / total
 *   confirmSignal = success_count / (success + failure + partial×0.5)
 *   outcomeWeight = 1.0
 *     + FAILURE_BOOST × failureSignal × saturation   (up to +50%)
 *     + SUCCESS_BOOST × confirmSignal × saturation   (up to +20%)
 *
 * Guards: counts are clamped to ≥0 and NaN/null treated as 0.
 */
export function outcomeWeight(node: RankInputs['node']): number {
    const s = Math.max(0, Number.isFinite(node.success_count ?? 0) ? Math.round(node.success_count ?? 0) : 0);
    const f = Math.max(0, Number.isFinite(node.failure_count ?? 0) ? Math.round(node.failure_count ?? 0) : 0);
    const p = Math.max(0, Number.isFinite(node.partial_count ?? 0) ? Math.round(node.partial_count ?? 0) : 0);
    const total = s + f + p;
    if (total === 0) return 1.0;

    const saturation = Math.min(total / OUTCOME_SATURATION, 1.0);
    const failureSignal = f / total;
    const weightedTotal = s + f + p * 0.5;
    const confirmSignal = weightedTotal > 0 ? s / weightedTotal : 0;

    return 1.0
        + DEFAULT_FAILURE_BOOST * failureSignal * saturation
        + DEFAULT_SUCCESS_BOOST * confirmSignal * saturation;
}

/**
 * Re-rank a single (node, baseScore) pair to a final score.
 * Pure function — no I/O, no state. Cloud-portable.
 *
 * When `LORE_RECALL_RANKING=off`, returns `baseScore` unchanged.
 *
 * Formula (Enhancement 2 outcome weighting + Finding 5.4 bounded recency):
 *   finalScore = baseScore × typeBias × recencyFactor × curationBoost × outcomeWeight
 * where recencyFactor = RECENCY_FLOOR + (1 − RECENCY_FLOOR) × recencyDecay,
 * i.e. recency can discount a node to at most RECENCY_FLOOR of its base
 * score instead of multiplying it toward zero.
 */
export function rankScore(inp: RankInputs): number {
    if (isRankingDisabled()) return inp.baseScore;
    const nowMs = inp.nowMs ?? Date.now();
    const halfLife = readHalfLife(inp.halfLifeDays);
    const curated = inp.curatedTypes;
    const tb = typeBias(inp.node.type, curated);
    const rd = recencyDecay(inp.node.updatedAt, nowMs, halfLife);
    const cb = curationBoost(inp.node, curated);
    const ow = outcomeWeight(inp.node);
    return inp.baseScore * tb * (RECENCY_FLOOR + (1 - RECENCY_FLOOR) * rd) * cb * ow;
}

export interface RankCandidate<T extends RankInputs['node']> {
    node: T;
    baseScore: number;
}

export interface SortedCandidate<T extends RankInputs['node']> {
    node: T;
    baseScore: number;
    finalScore: number;
}

/**
 * Sort an array of candidates by `rankScore` descending. Stable on
 * ties via insertion order (V8 sort is stable for Array.prototype.sort
 * since 2018 / Node.js 12). Does not mutate the input.
 */
export function sortByRank<T extends RankInputs['node']>(
    candidates: ReadonlyArray<RankCandidate<T>>,
    opts: { nowMs?: number; halfLifeDays?: number } = {},
): SortedCandidate<T>[] {
    return candidates
        .map((c) => ({
            node: c.node,
            baseScore: c.baseScore,
            finalScore: rankScore({ node: c.node, baseScore: c.baseScore, nowMs: opts.nowMs, halfLifeDays: opts.halfLifeDays }),
        }))
        .sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Convenience helper used by the shared retrieve() core to re-rank a
 * `LoreNode[]` derived from an RRF / vector seed order.
 *
 * Base score per node: `baseScores.get(node.id)` when the caller supplies
 * the map (Finding 5.4 — retrieve() passes each seed's REAL relevance
 * score: the raw vector similarity for semantic hits, the normalised RRF
 * score for BM25-only hits, the keyword rank score otherwise). Without a
 * map entry the fallback is `1 / (1 + idx)` — a pure rank-position proxy
 * that preserves the input order across the ranking transform. The proxy
 * must NOT be used when a real score exists: rank position spans at most
 * ~limit× while similarity carries the actual match strength, and the
 * re-rank's recency/curation/outcome multipliers are tuned against real
 * scores.
 */
export function reRankLoreNodes<T extends RankInputs['node']>(
    nodes: ReadonlyArray<T>,
    nowMs?: number,
    baseScores?: ReadonlyMap<string, number>,
): T[] {
    const at = nowMs ?? Date.now();
    return nodes
        .map((n, idx) => {
            // RankInputs['node'] has no id field; read it via narrowing so
            // callers passing id-less nodes (tests, one-off re-ranks) still
            // get the rank-position fallback instead of a blind cast.
            const real = ('id' in n && typeof n.id === 'string') ? baseScores?.get(n.id) : undefined;
            return { n, fs: rankScore({ node: n, baseScore: real ?? 1 / (1 + idx), nowMs: at }) };
        })
        .sort((a, b) => b.fs - a.fs)
        .map((x) => x.n);
}

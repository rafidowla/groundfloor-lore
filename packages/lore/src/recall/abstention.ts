/**
 * abstention.ts — D1 (calibrated relevance + abstention).
 *
 * The gating decision (z-score vs floor, exact-identifier rescue) and the
 * ONE shared snake_case `_meta` projection every surface (recallPreset.ts,
 * searchTool.ts, recallTool.ts, http/routes/search.ts) spreads into its own
 * `_meta`/`meta` object, so the field names and semantics can't drift
 * surface-by-surface.
 *
 * License: original work for groundfloor-lore.
 */

import type { CalibrationResult } from './calibration.js';
import type { RetrieveCalibrationMeta } from './retrieveTypes.js';

export const DEFAULT_RELEVANCE_FLOOR = 2.0;

/**
 * Exact-identifier rescue (design §3): a query containing a token that looks
 * like a genuine identifier — a dotted/underscored/slashed/hyphenated path
 * (`foo.bar_baz`), a camelCase/PascalCase symbol (`fooBarBaz`), a length-≥6
 * mix of letters and digits (`fx000123`), or a `#`-sigil numbered reference
 * (`#4821` — issue/ticket/fixture numbers) — should never be abstained purely
 * because its embedding sits close to the "nothing relevant" null
 * distribution (short, unusual tokens embed poorly; on the recall-eval 10k
 * fixture "fixture symbol #3" and the absent "fixture symbol #999999" both
 * score z≈1.3). The rescue only fires when the exact token also appears as a
 * WHOLE token in at least one seed's text — it is not a rescue for "the
 * query merely LOOKS like an identifier", it is a rescue for "an exact match
 * on this identifier genuinely exists".
 *
 * History: the first follow-up excluded pure-digit tokens because the old
 * candidate regex dropped the `#` and matched "4821" as a bare substring
 * (so it could ride on "48213", a port number, a timestamp…). That traded a
 * false-positive for a false-negative: every "#N" reference lost its rescue
 * (identifiers.json found@10 95% → 40% with abstain on). The root fix is
 * (a) keep the `#` sigil as part of the token, so only "#N" — never bare
 * digits — qualifies, and (b) match on token boundaries, so "#3" never
 * matches "#3333" and "dispatchBatch" never matches "redispatchBatchNow".
 */
const CANDIDATE_TOKEN_RE = /#?[A-Za-z0-9_][\w.\-/:#]*/g;

/** Trailing sentence punctuation that the candidate regex's path characters
 *  can swallow ("see foo.ts." / "path src/x/:"). */
const TRAILING_PUNCT_RE = /[.:/\-#]+$/;

/** A lowercase letter immediately followed by an uppercase letter — the
 *  signature of camelCase (`fooBar`) and, because it also appears mid-word
 *  in PascalCase (`FooBar`'s `o`→`B`), PascalCase-ish symbols too. */
const INTERNAL_CASE_CHANGE_RE = /[a-z][A-Z]/;

/** `#` followed only by digits: a numbered reference (#3, #4821). */
const NUMBERED_REFERENCE_RE = /^#\d+$/;

/** Plain words (lowercase or Capitalised) joined only by `-`:
 *  "on-call", "Follow-up", "end-to-end", "digital-employee-framework". */
const PLAIN_WORD_HYPHEN_RE = /^[A-Za-z][a-z]*(?:-[A-Za-z][a-z]*)+$/;

/** Single letters joined by dots: "e.g", "i.e", "U.S" (trailing dot already stripped). */
const DOTTED_ABBREVIATION_RE = /^(?:[A-Za-z]\.)+[A-Za-z]$/;

/** Short function words that mark a 3+-segment hyphen compound as prose
 *  ("up-to-date", "state-of-the-art", "end-to-end"). Deliberately excludes
 *  particles common in component names (`in`, `on`, `out`, `up`, `off`,
 *  `for`): `sign-in-service`, `opt-out-handler`, `add-on-manager`. */
const COMPOUND_FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or', 'by', 'at', 'with', 'per', 'via', 'vs']);

/** Slash pairs that are English, not paths. Any other slash token stays an
 *  identifier (`packages/lore`, `feature/login`, `src/recall`). */
const PROSE_SLASH_PAIRS = new Set([
    'and/or', 'either/or', 'he/she', 'his/her', 's/he', 'yes/no', 'on/off', 'read/write', 'i/o', 'w/o', 'true/false', 'input/output',
]);

/**
 * D1 follow-up 3: ordinary English compounds must not count as identifiers.
 * Before this, any `-`/`/` made a token identifier-shaped, so "on-call",
 * "follow-up" or "and/or" in a query — words that also appear verbatim in
 * plenty of stored prose — fired the rescue and silently cancelled
 * abstention. Now:
 *   - a plain-word `-` compound counts only with ≥3 segments and none of
 *     them a function word (so "on-call" and "end-to-end" are prose, while
 *     "digital-employee-framework" and "sign-in-service" are identifiers);
 *     the trade-off is that two-part plain kebab or header names
 *     ("groundfloor-lore", "Content-Type") no longer rescue on their own;
 *   - a `/` token is prose only if it is a known English pair ("and/or");
 *   - single-letter dotted abbreviations ("e.g.") are prose.
 * Anything with a digit, `.`, `_` or an internal case change is unaffected.
 */
function isProseCompound(token: string): boolean {
    if (DOTTED_ABBREVIATION_RE.test(token)) return true;
    if (PROSE_SLASH_PAIRS.has(token.toLowerCase())) return true;
    if (!PLAIN_WORD_HYPHEN_RE.test(token)) return false;
    const segments = token.toLowerCase().split('-');
    if (segments.length < 3) return true;
    return segments.some((seg) => COMPOUND_FUNCTION_WORDS.has(seg));
}

function looksLikeIdentifier(token: string): boolean {
    if (NUMBERED_REFERENCE_RE.test(token)) return true; // explicit #N reference
    if (!/[A-Za-z]/.test(token)) return false; // otherwise must contain a letter — excludes bare digits
    if (isProseCompound(token)) return false; // "on-call", "and/or", "end-to-end", "e.g."
    if (/[_.\-/]/.test(token)) return true; // dotted/underscored/slashed/hyphenated path or symbol
    if (INTERNAL_CASE_CHANGE_RE.test(token)) return true; // camelCase / PascalCase-ish internal case change
    if (token.length >= 6 && /[0-9]/.test(token)) return true; // length ≥6 alphanumeric mix (letters + digits)
    return false;
}

/** Identifier-shaped tokens in `query` (D1 detector). Shared with the D3
 *  exact-identifier lane (identifierLane.ts) so both agree on what counts. */
export function extractIdentifierTokens(query: string): string[] {
    const candidates = query.match(CANDIDATE_TOKEN_RE) ?? [];
    return candidates.map((c) => c.replace(TRAILING_PUNCT_RE, '')).filter((t) => t.length > 0 && looksLikeIdentifier(t));
}

const WORD_CHAR_RE = /\w/;

/** True when `token` occurs in `text` delimited by non-word characters (or
 *  the string ends) on both sides — case-sensitive, identifiers are. */
export function containsWholeToken(text: string, token: string): boolean {
    let from = 0;
    for (;;) {
        const i = text.indexOf(token, from);
        if (i === -1) return false;
        const before = i === 0 ? '' : text[i - 1];
        const after = text[i + token.length] ?? '';
        // A token that itself starts/ends with a non-word char (`#3`, `a/b/`)
        // already carries its own left/right delimiter on that side.
        const leftOk = !WORD_CHAR_RE.test(token[0]) || !WORD_CHAR_RE.test(before);
        const rightOk = !WORD_CHAR_RE.test(token[token.length - 1]) || !WORD_CHAR_RE.test(after);
        if (leftOk && rightOk) return true;
        from = i + 1;
    }
}

/** True when `query` contains an identifier-shaped token that appears as a
 *  whole token in at least one of `seedTexts` (case-sensitive). */
export function hasExactIdentifierRescue(query: string, seedTexts: readonly string[]): boolean {
    const tokens = extractIdentifierTokens(query);
    if (tokens.length === 0) return false;
    return tokens.some((tok) => seedTexts.some((text) => containsWholeToken(text, tok)));
}

/** z = (x - median) / scale. Null propagates (no similarity, or the fit
 *  isn't usable). */
export function zScore(similarity: number | null, calibration: CalibrationResult): number | null {
    if (similarity === null) return null;
    if (calibration.status !== 'ok' || calibration.nullMedian === null || calibration.nullScale === null) return null;
    return (similarity - calibration.nullMedian) / calibration.nullScale;
}

export interface AbstentionInput {
    topSimilarity: number | null;
    calibration: CalibrationResult;
    /** Whether the caller opted into abstention gating at all. */
    abstain: boolean;
    relevanceFloor: number;
    query: string;
    /** Text (label + content) of the pre-rerank seed set, for the
     *  exact-identifier rescue check. */
    seedContents: readonly string[];
    /** D1 term-coverage signal (termCoverage.ts). Absent/undefined = the
     *  signal is off (the default); `coverage: null` = computed but the
     *  query had no content terms, which never gates. */
    termCoverage?: { coverage: number | null; min: number; zMargin: number };
    /** Report `abstainReason` on an abstention. Defaults to "termCoverage was
     *  supplied": with the term-coverage flag off the decision (and `_meta`)
     *  is byte-identical to the pre-term-coverage shape. */
    reportReason?: boolean;
}

export type AbstainReason = 'below_floor' | 'term_coverage';

export interface AbstentionDecision {
    topRelevance: number | null;
    belowFloor: boolean;
    abstained: boolean;
    abstainOverridden?: 'exact_identifier';
    /** Why the query abstained (set iff `abstained` AND the term-coverage
     *  flag is on — see AbstentionInput.reportReason). */
    abstainReason?: AbstainReason;
    /** Weighted key-term coverage of the top-k hits, 0..1 (2dp), when the
     *  term-coverage signal was computed. */
    termCoverage?: number | null;
}

/** decideAbstention — the ONE place the z-score/floor/rescue/term-coverage
 *  logic runs. Order: below the floor → abstain ('below_floor'); else, with
 *  term coverage on, z < floor + margin AND coverage < min → abstain
 *  ('term_coverage'). Either way an exact-identifier match in the seed set
 *  rescues (rescue always wins). */
export function decideAbstention(input: AbstentionInput): AbstentionDecision {
    const topRelevance = zScore(input.topSimilarity, input.calibration);
    const belowFloor = topRelevance !== null && topRelevance < input.relevanceFloor;
    const tc = input.termCoverage;
    const cov = tc ? { termCoverage: tc.coverage === null ? null : Math.round(tc.coverage * 100) / 100 } : {};
    let reason: AbstainReason | null = null;
    if (input.abstain && belowFloor) reason = 'below_floor';
    else if (input.abstain && tc && tc.coverage !== null && topRelevance !== null
        && topRelevance < input.relevanceFloor + tc.zMargin && tc.coverage < tc.min) reason = 'term_coverage';
    if (reason === null) return { topRelevance, belowFloor, abstained: false, ...cov };
    if (hasExactIdentifierRescue(input.query, input.seedContents)) {
        return { topRelevance, belowFloor, abstained: false, abstainOverridden: 'exact_identifier', ...cov };
    }
    const withReason = input.reportReason ?? tc !== undefined;
    return { topRelevance, belowFloor, abstained: true, ...(withReason ? { abstainReason: reason } : {}), ...cov };
}

/** The snake_case `_meta` fields every presentation surface spreads in — a
 *  concrete (not Record<string,unknown>) shape so every surface's own
 *  `_meta`/`meta` interface can declare these fields with real types instead
 *  of `unknown`. */
export interface RelevanceMetaFields {
    top_similarity: number | null;
    top_relevance: number | null;
    /** null when abstention gating doesn't apply at all (calibration
     *  'not_applicable' — keyword mode, cross-workspace fan-out): there is no
     *  floor to report because no z-score was ever computed against one.
     *  Matches docs/design/D1-calibrated-abstention.md §2/§3 ("floor: z
     *  applied, or null when not applicable"). */
    floor: number | null;
    below_floor: boolean;
    abstained: boolean;
    abstain_overridden?: 'exact_identifier';
    /** Set iff `abstained` with the term-coverage flag on: 'below_floor'
     *  (z-score) or 'term_coverage'. Absent when the flag is off. */
    abstain_reason?: AbstainReason;
    /** Key-term coverage of the top-k hits (0..1), present only when the
     *  opt-in term-coverage signal ran (abstain + abstainTermCoverage on). */
    term_coverage?: number | null;
    calibration: {
        status: string; version: string; probes: number; rows: number;
        null_median: number | null; null_scale: number | null; scope: string;
    };
}

/** Built from the core's RetrieveCalibrationMeta. `scope` labels which
 *  surface/branch is emitting it (used only for the 'not_applicable'
 *  static variant below, kept for symmetry/debuggability). */
export function buildRelevanceMeta(meta: RetrieveCalibrationMeta): RelevanceMetaFields {
    return {
        top_similarity: meta.topSimilarity,
        top_relevance: meta.topRelevance,
        floor: meta.relevanceFloor,
        below_floor: meta.belowFloor,
        abstained: meta.abstained,
        ...(meta.abstainOverridden ? { abstain_overridden: meta.abstainOverridden } : {}),
        ...(meta.abstainReason ? { abstain_reason: meta.abstainReason } : {}),
        ...(meta.termCoverage !== undefined ? { term_coverage: meta.termCoverage } : {}),
        calibration: {
            status: meta.calibration.status,
            version: meta.calibration.version,
            probes: meta.calibration.probes,
            rows: meta.calibration.rows,
            null_median: meta.calibration.nullMedian,
            null_scale: meta.calibration.nullScale,
            scope: meta.calibration.scope,
        },
    };
}

/** Static `_meta` block for surfaces/branches that never run the shared
 *  retrieve() core (the legacy workspace:"*" search fan-out, cross-workspace
 *  recall) — calibration/abstention simply doesn't apply there. */
export function notApplicableRelevanceMeta(scope: string): RelevanceMetaFields {
    return {
        top_similarity: null,
        top_relevance: null,
        floor: null,
        below_floor: false,
        abstained: false,
        calibration: { status: 'not_applicable', version: '', probes: 0, rows: 0, null_median: null, null_scale: null, scope },
    };
}

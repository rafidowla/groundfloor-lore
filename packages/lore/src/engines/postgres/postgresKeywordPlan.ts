/**
 * postgresKeywordPlan.ts - plan choice for the graph keyword leg (postgresGraphReads.search).
 *
 * THE PROBLEM. The candidate query is
 *   SELECT * FROM nodes WHERE workspace_id = $1 AND <match> [AND <scope>]
 *   ORDER BY "updatedAt" DESC, id ASC LIMIT <SEARCH_SCAN_CAP>
 * For a term that matches more rows than the cap but far fewer than the table, the planner
 * walks idx_nodes_updatedat in recency order and filters each row, instead of answering <match>
 * from the trigram/tag GIN indexes. The walk reads about cap * N / M rows (N = rows in the
 * workspace, M = matches): 100k buffers and 320 ms for a 29k-match term at 1M rows, 10x slower
 * than at 100k (docs/bench/PG-1M-REMEASURE-2026-10.md, "Recommendations" 1).
 *
 * THE FIX. Collect the matches first in a MATERIALIZED CTE (an optimisation fence: the planner
 * cannot push ORDER BY/LIMIT into it, so it uses the bitmap scan over the GIN indexes), order
 * and cap that narrow (id, updatedAt) set, then join back to nodes for the full rows. Same
 * rows, same order: the sort key is unchanged ("updatedAt" DESC, id ASC, with id the tie-break
 * the old query already had; (workspace_id, id) is the primary key so the join cannot duplicate).
 *
 * THE OPPOSITE FAILURE. The CTE costs about M heap fetches, the walk about cap * N / M. For a very
 * common term (M near N) the walk stops after cap rows and the CTE would read the whole table:
 * measured 3.7 ms -> 176 ms at 100k for a term in 99.9% of rows. And when the planner already
 * answers from the GIN indexes (smaller M) the CTE only adds the join back (+3 ms measured). So the
 * CTE is used only when ALL of these hold, otherwise the original statement runs unchanged:
 *   1. the planner would WALK idx_nodes_updatedat for the original statement (EXPLAIN of the real
 *      statement, no execution) - if it does not, there is nothing to fix;
 *   2. M_est > cap / 2 (below that the walk is not the problem);
 *   3. M_est <= CTE_MAX_MATCHES (bound the materialised set);
 *   4. M_est^2 <= K * cap * N_est (K = CTE_BREAK_EVEN = 0.5): the CTE is cheaper than the walk (measured, see CTE_BREAK_EVEN);
 *   5. the CANDIDATE VOLUME is affordable (see below): C_est <= CTE_MAX_MATCHES and C_est^2 <= K * cap * N_est;
 *   6. the CTE's own EXPLAIN builds `CTE m` from the keyword GIN indexes, not a Seq Scan (see below).
 * M_est and N_est are the root "Plan Rows" of EXPLAIN (FORMAT JSON) probes (planning only; the
 * result is memoised by the caller's read cache like the search itself). Probes run in order of
 * cheapness and stop early: a term the planner already handles costs one extra round trip
 * (about 0.3-0.4 ms); only walking, mid-frequency terms pay for three, then one per probed term (at most MAX_CANDIDATE_PROBES) and one more when the estimates favour the CTE. Anything the probe cannot
 * read yields "keep the original".
 *
 * CANDIDATE VOLUME. `lower(content) LIKE '%linest%'` is served by the trigram GIN as "rows containing lin AND ine AND nes
 * AND est" and every candidate is rechecked against the heap row by row, so the CTE's cost is linear in CANDIDATES, not in
 * matches. When the term's trigrams are common, candidates >> matches and the planner's M_est does not see it (1M bench: `linest`
 * est 30k / actual 41k went 216 -> 559 ms through the CTE; it rechecked ~120-150k rows). Probe 4 (after the M / N checks pass)
 * therefore asks the planner, per trigram-served term, for the row estimate of the AND of that term's distinct 3-grams as
 * separate LIKE patterns, over (label OR content) exactly as the real clause ORs them, in one EXPLAIN (planning only). The OR
 * estimate is the sum of the two columns' candidate estimates minus their overlap, and is capped at N by construction.
 * C_est = max(M_est, min over probed terms of C_term): the bitmap ANDs the terms, so the cheapest term bounds the work, and a
 * candidate set can never be smaller than the matches. Terms shorter than a trigram (and tag-only arms, which are exact
 * containment with no recheck inflation) are not probed; when NO term is probeable the M / N rule stands alone. A probe the
 * planner cannot answer, or that throws, keeps the original statement. At most MAX_CANDIDATE_PROBES terms are probed (longest
 * first: more trigrams, more selective), and probing stops at the first term that clears the bar.
 *
 * STATISTICS. Both estimates (M_est, C_term) come from LIKE selectivity on the lower(content) / lower(label) expression
 * statistics, which are histogram-based on ~100 samples by default and swing about 2x between ANALYZEs. ensureKeywordIndexes
 * raises the statistics target of the two trigram indexes' expression column to 1000 (postgresKeywordIndex.ts).
 *
 * THE CTE'S OWN PLAN (lane f1). The estimates above say the CTE should beat the walk, but they do not say HOW the
 * planner will build the CTE. When it puts a Seq Scan on nodes inside `CTE m` the CTE evaluates the LIKE / jsonb
 * predicate on every row of the table (measured: 60k rows, cap 200, term in 5%: walk 6.5 ms, CTE 87 ms). So a 4th
 * probe, reached only when 1-4 already say "cte", EXPLAINs the CTE statement and accepts it only when the subtree
 * under `CTE m` has no Seq Scan and reaches the keyword GIN indexes through a Bitmap Index Scan. This is a plan-SHAPE
 * check, not a cost comparison: Total Cost of the two statements is not comparable (the walk's cost assumes the
 * match is uniformly spread, the CTE's assumes the GIN selectivity estimate is right; both are what misled the
 * planner in the first place), whereas "no full scan of nodes inside the CTE" is the property that makes it cheap.
 * Unreadable or unrecognised plan -> keep the original.
 *
 * FAIL-SAFE. Every probe runs inside one try/catch: an EXPLAIN error, a connection error or a statement_timeout
 * falls back to the original statement (the one search() ran before #251) and never fails the search.
 *
 * OFF SWITCH. LORE_PG_KEYWORD_CTE=0 (also false / off) skips the probes and runs the original statement: exactly the
 * pre-#251 behaviour, no extra round trips. Default on.
 */
import type { Pool } from 'pg';
import { escapeLike, isTrigramTerm } from './postgresKeywordMatch.js';

/** Never materialise more candidates than this, whatever the estimates say. */
export const CTE_MAX_MATCHES = 200_000;
/**
 * CTE is chosen while M^2 <= K * cap * N (and C^2 <= K * cap * N for the candidate volume), i.e. when it is cheaper than the
 * recency walk. K = 0.5 puts the switch at ~31.6k matches at 1M rows (cap 2000), where the 1M MacBook re-check (2026-10-29) measured
 * the crossover: the CTE won 1.5-8x for clean terms up to ~31k true matches and the walk won from ~41k. Before the candidate probe
 * and statistics target 1000, K = 0.5 misrouted `linest` (trigram-inflated candidates) and `because` (under-estimated M); with
 * both in place, a 17-term x 3-ANALYZE simulation at K = 0.5 was never slower than the walk (worst 1.03x), total 6.9 s vs 10.2 s at
 * K = 0.125 and 10.4 s for the walk alone. M_est still moves ~1.7x between ANALYZE runs, so terms near the threshold can flip plan.
 */
export const CTE_BREAK_EVEN = 0.5;
/** Most terms whose candidate volume is probed for one query (each costs one planning-only round trip). */
export const MAX_CANDIDATE_PROBES = 3;

export type KeywordPlan = 'cte' | 'ordered-walk';

export interface KeywordPlanDecision {
    plan: KeywordPlan;
    /** Planner would walk idx_nodes_updatedat for the original statement (null = could not tell). */
    walks: boolean | null;
    estMatches: number | null;
    estRows: number | null;
    /**
     * Estimated candidates the CTE would touch: max(M_est, min over probed terms of C_term). undefined = not probed (the rule
     * stopped earlier, or no term was probeable); null = a probe was unreadable.
     */
    estCandidates?: number | null;
    /** The CTE statement's own plan avoids a full scan of nodes (null = not probed or unreadable). */
    ctePlanOk?: boolean | null;
    /** The probe threw (class/code only, never query text); the original statement was kept. */
    probeError?: string;
    /** LORE_PG_KEYWORD_CTE=0: no probe was issued. */
    disabled?: boolean;
}

/** Keyword GIN indexes (postgresKeywordIndex.ts): the only indexes through which the CTE may reach its matches. */
const KEYWORD_GIN_INDEXES: ReadonlySet<string> = new Set(['idx_nodes_label_trgm', 'idx_nodes_content_trgm', 'idx_nodes_tags_gin']);

/** LORE_PG_KEYWORD_CTE -> false when the operator turned the CTE route off (0 / false / off / no); true otherwise. */
export function keywordCteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.LORE_PG_KEYWORD_CTE?.trim().toLowerCase();
    return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** The recency index the original statement walks (created unquoted, so Postgres folds it to lower case). */
const RECENCY_INDEX = 'idx_nodes_updatedat';

/**
 * Pure decision rule (exported for tests). Unknown estimates keep the original statement.
 * `estCandidates` is C_est, the candidates the CTE would touch (see CANDIDATE VOLUME): undefined = no term could be probed,
 * so only the M / N rule applies; null or invalid = a probe was unreadable, keep the original.
 */
export function decideKeywordPlan(
    estMatches: number | null,
    estRows: number | null,
    cap: number,
    estCandidates?: number | null,
): KeywordPlan {
    if (estMatches === null || estRows === null || !(estMatches > 0) || !(estRows > 0)) return 'ordered-walk';
    if (estMatches <= cap / 2) return 'ordered-walk';
    if (estMatches > CTE_MAX_MATCHES) return 'ordered-walk';
    if (estMatches * estMatches > CTE_BREAK_EVEN * cap * estRows) return 'ordered-walk';
    if (estCandidates === undefined) return 'cte';
    if (estCandidates === null || !Number.isFinite(estCandidates) || !(estCandidates > 0)) return 'ordered-walk';
    const c = Math.max(estCandidates, estMatches); // a candidate set is never smaller than the matches
    if (c > CTE_MAX_MATCHES) return 'ordered-walk';
    return c * c <= CTE_BREAK_EVEN * cap * estRows ? 'cte' : 'ordered-walk';
}

/** Distinct 3-grams of `term` (by code point, in order of first appearance). Empty when the term has no trigram. */
export function termTrigrams(term: string): string[] {
    const cps = [...term];
    const out = new Set<string>();
    for (let i = 0; i + 3 <= cps.length; i++) out.add(cps.slice(i, i + 3).join(''));
    return [...out];
}

/**
 * Planning-only statement whose root Plan Rows is the candidate estimate of one trigram-served term: rows the trigram GIN
 * indexes return for "all of the term's 3-grams" on label OR content (the arms the real clause ORs; an OR estimate is the
 * sum minus the overlap, so it is capped at N). Every pattern is a bound parameter, LIKE metacharacters escaped as
 * postgresKeywordMatch.escapeLike does. `values[0]` is the workspace id. Null for a term with no trigram.
 */
export function candidateProbeSql(workspaceId: string, term: string): { sql: string; values: string[] } | null {
    if (!isTrigramTerm(term)) return null;
    const grams = termTrigrams(term);
    if (grams.length === 0) return null;
    const values: string[] = [workspaceId, ...grams.map((g) => `%${escapeLike(g)}%`)];
    const arm = (expr: string): string => grams.map((_, i) => `${expr} LIKE $${i + 2}`).join(' AND ');
    return {
        sql: `EXPLAIN (FORMAT JSON) SELECT 1 FROM nodes WHERE workspace_id = $1 AND ((${arm('lower(label)')}) OR (${arm('lower(content)')}))`,
        values,
    };
}

/** The terms to probe, in order: trigram-served only, longest first, deduplicated, at most MAX_CANDIDATE_PROBES. */
export function probeableTerms(terms: readonly string[]): string[] {
    return [...new Set(terms.filter(isTrigramTerm))].sort((a, b) => [...b].length - [...a].length).slice(0, MAX_CANDIDATE_PROBES);
}

/** Root "Plan Rows" of an `EXPLAIN (FORMAT JSON)` result, or null when the shape is not recognised. */
export function planRowsOf(explainRows: ReadonlyArray<Record<string, unknown>>): number | null {
    const raw = explainRows[0]?.['QUERY PLAN'];
    const doc: unknown = typeof raw === 'string' ? safeParse(raw) : raw;
    const root = Array.isArray(doc) ? (doc[0] as { Plan?: { 'Plan Rows'?: unknown } } | undefined) : undefined;
    const rows = root?.Plan?.['Plan Rows'];
    return typeof rows === 'number' && Number.isFinite(rows) ? rows : null;
}

/** True when any node of an `EXPLAIN (FORMAT JSON)` plan scans idx_nodes_updatedat; null when the shape is not recognised. */
export function walksRecencyIndex(explainRows: ReadonlyArray<Record<string, unknown>>): boolean | null {
    const raw = explainRows[0]?.['QUERY PLAN'];
    const doc: unknown = typeof raw === 'string' ? safeParse(raw) : raw;
    const root = Array.isArray(doc) ? (doc[0] as { Plan?: PlanNode } | undefined)?.Plan : undefined;
    if (!root || typeof root !== 'object') return null;
    const visit = (n: PlanNode): boolean =>
        String(n['Index Name'] ?? '').toLowerCase() === RECENCY_INDEX || (n.Plans ?? []).some(visit);
    return visit(root);
}
interface PlanNode {
    'Node Type'?: unknown; 'Index Name'?: unknown; 'Subplan Name'?: unknown; 'Relation Name'?: unknown; Plans?: PlanNode[];
}

/**
 * True when the subtree under `CTE m` of an `EXPLAIN (FORMAT JSON)` of candidateCteSql builds the match set from the keyword
 * GIN indexes: no (Parallel) Seq Scan, no walk of the recency index, and at least one Bitmap Index Scan on a keyword GIN
 * index. False when the CTE would scan nodes in full or reach it by another path. Null when the CTE node is not found or the
 * shape is not recognised (callers keep the original statement).
 */
export function cteUsesKeywordIndexes(explainRows: ReadonlyArray<Record<string, unknown>>): boolean | null {
    const raw = explainRows[0]?.['QUERY PLAN'];
    const doc: unknown = typeof raw === 'string' ? safeParse(raw) : raw;
    const root = Array.isArray(doc) ? (doc[0] as { Plan?: PlanNode } | undefined)?.Plan : undefined;
    if (!root || typeof root !== 'object') return null;
    const find = (n: PlanNode): PlanNode | null => {
        if (n['Subplan Name'] === 'CTE m') return n;
        for (const c of n.Plans ?? []) { const r = find(c); if (r) return r; }
        return null;
    };
    const cte = find(root);
    if (!cte) return null;
    let seq = false, gin = false;
    const visit = (n: PlanNode): void => {
        const type = String(n['Node Type'] ?? '');
        const idx = String(n['Index Name'] ?? '').toLowerCase();
        if (/Seq Scan/.test(type)) seq = true;
        if (idx === RECENCY_INDEX) seq = true; // walking the recency index inside the CTE is no better than the original
        if (type === 'Bitmap Index Scan' && KEYWORD_GIN_INDEXES.has(idx)) gin = true;
        for (const c of n.Plans ?? []) visit(c);
    };
    visit(cte);
    return !seq && gin;
}

function safeParse(text: string): unknown {
    try { return JSON.parse(text); } catch { return null; }
}

/**
 * probeKeywordPlan - decide between the original statement and the CTE form from planner estimates only.
 * `where` is the WHERE body after `workspace_id = $1`; `values` are its parameters ($1 = workspace id), WITHOUT the limit.
 * `terms` are the query's keyword terms (keywordSearchTerms), used only for the candidate-volume probe; none = no such probe.
 */
export async function probeKeywordPlan(
    pool: Pick<Pool, 'query'>,
    workspaceId: string,
    where: string,
    values: readonly unknown[],
    cap: number,
    terms: readonly string[] = [],
): Promise<KeywordPlanDecision> {
    try {
        return await probeUnguarded(pool, workspaceId, where, values, cap, terms);
    } catch (err) {
        // A failed probe must never fail the search: run the original statement. Class / SQLSTATE only, never query text.
        const sig = errorSignature(err);
        if (!warnedProbeErrors.has(sig)) {
            warnedProbeErrors.add(sig);
            console.warn(`[PostgresGraph:search] keyword plan probe failed (${sig}); using the original statement`);
        }
        return { plan: 'ordered-walk', walks: null, estMatches: null, estRows: null, probeError: sig };
    }
}

const warnedProbeErrors = new Set<string>();
function errorSignature(err: unknown): string {
    const code = (err as { code?: unknown } | null)?.code;
    const name = err instanceof Error ? err.constructor.name : typeof err;
    return typeof code === 'string' ? `${name} ${code}` : name;
}

async function probeUnguarded(
    pool: Pick<Pool, 'query'>,
    workspaceId: string,
    where: string,
    values: readonly unknown[],
    cap: number,
    terms: readonly string[],
): Promise<KeywordPlanDecision> {
    // 1. Would the planner walk the recency index for the statement we are about to run?
    const walk = await pool.query(`EXPLAIN (FORMAT JSON) ${orderedWalkSql(where, `$${values.length + 1}`)}`, [...values, cap]);
    const walks = walksRecencyIndex(walk.rows);
    if (walks !== true) return { plan: 'ordered-walk', walks, estMatches: null, estRows: null };
    // 2. M: rows the match clause selects.
    const m = await pool.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM nodes WHERE workspace_id = $1 AND ${where}`, [...values]);
    const estMatches = planRowsOf(m.rows);
    // 3. N is only needed when M is in the window where the CTE can win.
    if (estMatches === null || estMatches <= cap / 2 || estMatches > CTE_MAX_MATCHES) {
        return { plan: 'ordered-walk', walks, estMatches, estRows: null };
    }
    const n = await pool.query('EXPLAIN (FORMAT JSON) SELECT 1 FROM nodes WHERE workspace_id = $1', [workspaceId]);
    const estRows = planRowsOf(n.rows);
    if (decideKeywordPlan(estMatches, estRows, cap) !== 'cte') return { plan: 'ordered-walk', walks, estMatches, estRows };
    // 4. Candidate volume: the CTE rechecks every row the trigram indexes return, not just the matches.
    let estCandidates: number | null | undefined;
    for (const term of probeableTerms(terms)) {
        const probe = candidateProbeSql(workspaceId, term);
        if (!probe) continue;
        const cr = await pool.query(probe.sql, probe.values);
        const cTerm = planRowsOf(cr.rows);
        if (cTerm === null) { estCandidates = null; break; } // unreadable: keep the original
        const c = Math.max(cTerm, estMatches);
        estCandidates = estCandidates === undefined || estCandidates === null ? c : Math.min(estCandidates, c);
        if (decideKeywordPlan(estMatches, estRows, cap, estCandidates) === 'cte') break; // the cheapest term already clears the bar
    }
    if (estCandidates !== undefined && decideKeywordPlan(estMatches, estRows, cap, estCandidates) !== 'cte') {
        return { plan: 'ordered-walk', walks, estMatches, estRows, estCandidates };
    }
    // 5. The estimates favour the CTE; confirm the planner will build it from the GIN indexes, not a full scan of nodes.
    const c = await pool.query(`EXPLAIN (FORMAT JSON) ${candidateCteSql(where, `$${values.length + 1}`)}`, [...values, cap]);
    const ctePlanOk = cteUsesKeywordIndexes(c.rows);
    return { plan: ctePlanOk === true ? 'cte' : 'ordered-walk', walks, estMatches, estRows, ...(estCandidates !== undefined ? { estCandidates } : {}), ctePlanOk };
}

/**
 * chooseKeywordPlan - the engine's entry point: honours LORE_PG_KEYWORD_CTE=0 (no probes, original statement), otherwise
 * probes and applies the test seams.
 */
export async function chooseKeywordPlan(
    pool: Pick<Pool, 'query'>,
    workspaceId: string,
    where: string,
    values: readonly unknown[],
    cap: number,
    env: NodeJS.ProcessEnv = process.env,
    terms: readonly string[] = [],
): Promise<KeywordPlanDecision> {
    if (!keywordCteEnabled(env)) return { plan: 'ordered-walk', walks: null, estMatches: null, estRows: null, disabled: true };
    return resolveKeywordPlan(await probeKeywordPlan(pool, workspaceId, where, values, cap, terms));
}

/** The original statement: recency-ordered scan with the match as a filter. */
export function orderedWalkSql(where: string, limitPlaceholder: string): string {
    return `SELECT * FROM nodes WHERE workspace_id = $1 AND ${where}`
        + ` ORDER BY "updatedAt" DESC, id ASC LIMIT ${limitPlaceholder}::int`;
}

/** The CTE form: match first (narrow columns), order + cap that set, join back for the full rows. */
export function candidateCteSql(where: string, limitPlaceholder: string): string {
    return `WITH m AS MATERIALIZED (SELECT id, "updatedAt" FROM nodes WHERE workspace_id = $1 AND ${where})`
        + ` SELECT n.* FROM nodes n`
        + ` JOIN (SELECT id, "updatedAt" FROM m ORDER BY "updatedAt" DESC, id ASC LIMIT ${limitPlaceholder}::int) t`
        + ` ON n.workspace_id = $1 AND n.id = t.id`
        + ` ORDER BY t."updatedAt" DESC, t.id ASC`;
}

/** Test seam: sees every plan decision the engine acts on. No-op unless a test installs one. */
let planObserver: ((d: KeywordPlanDecision) => void) | null = null;
export function setKeywordPlanObserver(fn: ((d: KeywordPlanDecision) => void) | null): void { planObserver = fn; }
let planForce: KeywordPlan | null = null;
/** Test seam: pin the plan regardless of the planner's estimates (planner estimates are noisy on small test corpora). */
export function setKeywordPlanForce(p: KeywordPlan | null): void { planForce = p; }
/** Apply the test seam (if any), tell the observer (if any), and return the decision the engine must act on. */
export function resolveKeywordPlan(d: KeywordPlanDecision): KeywordPlanDecision {
    const effective = planForce ? { ...d, plan: planForce } : d;
    planObserver?.(effective);
    return effective;
}

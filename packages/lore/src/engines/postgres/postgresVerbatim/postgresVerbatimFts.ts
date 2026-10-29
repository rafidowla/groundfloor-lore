/**
 * postgresVerbatimFts.ts — keyword (BM25) search for PostgresVerbatimStore.
 *
 * Postgres engine  Port of
 * `engines/sqliteVerbatimFts.ts`'s NATIVE path against the frozen schema's
 * `text_tsv tsvector` column (GIN-indexed, maintained by the
 * `to_tsvector('simple', text)` trigger — see the TOKENIZER NOTE in
 * postgresVerbatimSchema.ts for the porter/unicode61-vs-'simple'
 * normalization trade-off; ranked full-text ORDER may differ from FTS5's
 * bm25(), the result SET is what parity keeps).
 *
 * QUERY SHAPE — built the way sqliteVerbatimFts.escapeFts5Query builds the
 * FTS5 MATCH string: split the query on whitespace, one literal per token,
 * tokens combined with OR (FTS5's implicit-AND was explicitly rejected there
 * as a recall gap vs Lance's MatchQuery). The pg transcription:
 *   - each token becomes `phraseto_tsquery('simple', $n)` — a BOUND
 *     parameter, so user text is NEVER parsed as tsquery syntax. This is
 *     strictly safer than FTS5's quote-every-token trick: `AND`/`OR`/`NOT`,
 *     a trailing `*`, `col:term`, an unbalanced `"` are all just literal
 *     phrase text here; no operator in the input can change parse semantics.
 *   - tokens are joined with the tsquery `||` (OR) operator, matching the
 *     FTS5 port's ` OR ` join and Lance's OR-shaped default.
 *   - phraseto (not plainto/to) keeps a multi-word token as a phrase — the
 *     exact analogue of an FTS5 quoted string literal.
 *
 * NOT ported, deliberately:
 *   - the trigram short-token fallback (sqliteVerbatimFts's
 *     SHORT_TOKEN_MIN_LEN path). FTS5's trigram tokenizer cannot express a
 *     <3-char query, which is why that fallback exists; the 'simple'
 *     parser emits each CJK character as its own token and phraseto
 *     re-joins them with `<->`, so a 1-2 char CJK query matches natively —
 *     no equivalent blind spot, hence no fallback.
 *   - the LIKE-scan catch-all for FTS5 parse errors: phraseto_tsquery
 *     cannot reject any input, so the only residual failure class is the
 *     connection itself, which must SURFACE (an unranked LIKE result set
 *     would mask a dead pool; the sqlite catch existed for the FTS5 parser,
 *     not for connectivity).
 *
 * RANKING: ts_rank(text_tsv, query), normalized like the FTS5 port —
 * divided by the best raw score in the FINAL hit list (guard 1e-9) so every
 * engine speaks "higher = more relevant" on a comparable [0,1] scale. The
 * query returns the RAW rank; postgresKeywordScore.normalizeKeywordHits runs
 * once, after the scope filter (Phase 0 L5), so rows the actor cannot see
 * never set the scale.
 * Tie-break score desc, then id asc — same as every other ranked result set
 * in this codebase.
 */

import type { Pool } from 'pg';

import { makeBm25Envelope, type Bm25Envelope } from '../../verbatimBm25Result.js';
import type { VerbatimSearchResult, VerbatimQueryFilter } from '../../../providers/types.js';
import { buildSqlFilterEntries } from '../../verbatimHistory.js';
import { lexemesForTokens, partitionTokens } from './postgresBm25StopList.js';
import { log } from '../../../logger.js';
import { normalizeKeywordHits } from './postgresKeywordScore.js';
import { scopeFilterSql } from '../postgresVerbatimScopeArr.js';
import { applyActorScopeFilter } from '../../../security/scopeFilter.js';
import { getCurrentActorScopes } from '../../../security/actorContext.js';

/**
 * The metadata-filter allowlist is shared (VERBATIM_FILTERABLE_COLUMNS via
 * buildSqlFilterEntries); the COLUMN NAMES are not — SQLite emits the raw
 * filter key as the column (so a `contentHash` filter errors there and
 * trips that engine's LIKE fallback), while Postgres identifiers are exact.
 * The mapping below is the frozen schema's physical names: camel-case
 * `"updatedAt"` is quoted, `contentHash` maps to `content_hash`. Same
 * allowlist, same `= ?` / `IN (...)` entry shapes, mapped columns.
 */
export const PG_FILTER_COLUMNS: Record<string, string> = {
    id: 'id',
    type: 'type',
    label: 'label',
    tags: 'tags',
    project: 'project',
    ecosystem: 'ecosystem',
    updatedAt: '"updatedAt"',
    contentHash: 'content_hash',
};

/**
 * Render buildSqlFilterEntries' entries as a pg WHERE fragment: the `?`
 * placeholders the shared helper emits (SQLite convention) are renumbered to
 * `$n` starting at `startParam`, column names are mapped to their physical
 * pg names, and the flattened params returned IN ORDER so callers splice
 * them into their own parameter list. One implementation for both pushdown
 * sites (bm25Search + searchByVector) so the two read paths can never drift.
 */
export function pgFilterSql(
    filter: Record<string, unknown> | undefined | null,
    startParam: number,
): { sql: string; params: string[] } {
    const entries = buildSqlFilterEntries(filter);
    const params: string[] = [];
    let next = startParam;
    const fragments = entries.map((e) => {
        let i = 0;
        const placeholders = e.params.map(() => `$${next++}`);
        params.push(...e.params);
        return `AND ${PG_FILTER_COLUMNS[e.column] ?? e.column} ${e.op.replace(/\?/g, () => placeholders[i++])}`;
    });
    return { sql: fragments.join(' '), params };
}

function rowToResult(r: Record<string, unknown>): VerbatimSearchResult & { score: number } {
    let scopes: string[] = [];
    if (typeof r.security_scopes === 'string' && r.security_scopes) {
        try { scopes = JSON.parse(r.security_scopes); } catch { scopes = []; }
    }
    return {
        id: String(r.id),
        score: Number(r.score ?? 0),
        text: String(r.text ?? ''),
        metadata: {
            type: (r.type as string) ?? undefined,
            label: (r.label as string) ?? undefined,
            tags: (r.tags as string) ?? undefined,
            project: (r.project as string) ?? undefined,
            ecosystem: (r.ecosystem as string) ?? undefined,
            updatedAt: (r.updatedAt as string) ?? undefined,
            security_scopes: scopes,
        },
    } as VerbatimSearchResult & { score: number };
}

/**
 * Common-token stop-list handed to bm25Search by the store (see
 * postgresBm25StopList.ts). `common` is the workspace's lexemes that occur in at
 * least LORE_BM25_COMMON_TOKEN_RATIO of its rows; `lexemeCache` memoizes
 * token -> 'simple' lexemes (a pure function of the token).
 */
export interface Bm25StopList {
    common: ReadonlySet<string>;
    lexemeCache: Map<string, string[]>;
}
const LEXEME_CACHE_MAX = 5_000;

/**
 * bm25Search — `text_tsv @@ (phraseto || phraseto || …)` + ts_rank ranking,
 * canonical/non-tombstone filtering and the metadata-filter allowlist
 * applied exactly like the FTS5 path. One statement, all user text bound.
 */
export async function bm25Search(
    pool: Pool,
    workspaceId: string,
    query: string,
    limit: number,
    rawFilter: VerbatimQueryFilter | undefined,
    actorScopes: ReadonlyArray<string> | undefined,
    stopList?: Bm25StopList,
): Promise<Bm25Envelope<VerbatimSearchResult>> {
    // D2: array-valued filter fields (e.g. `types: string[]`) become an
    // IN (...) pushdown instead of being silently dropped. Placeholders are
    // renumbered to follow the token params ($2..$k+1); the LIMIT param
    // follows the filter params.
    let tokens = query.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return makeBm25Envelope([], true);
    // Common-token stop-list: drop single-lexeme tokens that appear in most rows (they force ts_rank to score most of
    // the table and carry no ranking signal). Multi-lexeme tokens are phrases and are never touched. When EVERY
    // meaningful token is common (a punctuation-only token like `???` is not a meaningful token, so `the ???` counts)
    // there is nothing selective to rank by: an unfiltered query returns no BM25 hits instead of a full scan (the
    // vector leg still answers). A query with a metadata filter runs the ORIGINAL query instead: the filter bounds the
    // candidate set, and returning nothing for a query the filter could answer would be a regression.
    if (stopList && stopList.common.size > 0) {
        const cache = stopList.lexemeCache;
        const missing = [...new Set(tokens.filter((t) => !cache.has(t)))];
        if (missing.length > 0) {
            if (cache.size + missing.length > LEXEME_CACHE_MAX) cache.clear();
            for (const [tok, lex] of await lexemesForTokens(pool, missing)) cache.set(tok, lex);
        }
        const part = partitionTokens(tokens, (t) => cache.get(t) ?? [], stopList.common);
        if (part.droppedAny) {
            if (!part.hasSelective) {
                if (buildSqlFilterEntries(rawFilter).length === 0) return makeBm25Envelope([], true);
                // filtered: keep every original token (pre-stop-list query)
            } else {
                tokens = part.kept;
            }
        }
    }
    const filter = pgFilterSql(rawFilter, tokens.length + 2);
    // Scope policy in SQL, BEFORE the LIMIT (security_scope_arr; see postgresVerbatimScopeArr.ts). The JS
    // applyActorScopeFilter below stays only as a final assertion.
    const effectiveScopes = actorScopes ?? getCurrentActorScopes();
    const scope = scopeFilterSql(effectiveScopes, tokens.length + 2 + filter.params.length, 'v.security_scope_arr');
    const limitParam = `$${tokens.length + 2 + filter.params.length + scope.params.length}`;

    // The OR-joined per-token phraseto tsquery is wrapped in one sub-SELECT
    // so the expression is written once and reused for both @@ and ts_rank.
    const tokenParams = tokens.map((_, i) => `$${i + 2}`);
    const tsqueryExpr = tokenParams.map((p) => `phraseto_tsquery('simple', ${p})`).join(' || ');
    const sql = `
        SELECT v.id, v.text, v.type, v.label, v.tags, v.project, v.ecosystem, v."updatedAt", v.security_scopes,
               ts_rank(v.text_tsv, q.query) AS raw_score
        FROM verbatim v, (SELECT ${tsqueryExpr} AS query) q
        WHERE v.workspace_id = $1 AND v.is_canonical = 1 AND v.is_tombstone = 0 AND v.text_tsv @@ q.query
        ${filter.sql}
        ${scope.sql}
        ORDER BY raw_score DESC, v.id ASC
        LIMIT ${limitParam}
    `;
    const rows = await pool.query(sql, [workspaceId, ...tokens, ...filter.params, ...scope.params, limit]);
    // Hits carry the RAW ts_rank here (a pure function of document + query, so comparable across rows and, in Phase 3,
    // across slices). The scale is decided exactly once, in finalizeKeywordHits, on the final list.
    const raw = rows.rows.map((r) => rowToResult({ ...r, score: Number((r as Record<string, unknown>).raw_score ?? 0) }));
    return makeBm25Envelope(finalizeKeywordHits(raw, effectiveScopes), true);
}

/**
 * The single exit of the keyword leg: take RAW-scored hits (best-first, already cut to the limit), apply the scope
 * policy as a final assertion, then normalize ONCE. Filtering strictly before normalizing is the contract: a hit the
 * actor cannot see must never set the scale of the ones they can. Phase 3 (multi-slice) calls this after merging each
 * slice's raw hits and re-cutting to `limit`.
 */
export function finalizeKeywordHits<T extends VerbatimSearchResult & { score: number }>(
    rawHits: readonly T[],
    effectiveScopes: ReadonlyArray<string> | undefined,
): T[] {
    // The SQL predicate already applied the policy (L4); this is only an assertion and must never remove a row.
    const visible = applyActorScopeFilter(rawHits as T[], effectiveScopes);
    if (visible.length !== rawHits.length) log.warn(`[verbatim-scope] bm25 SQL scope predicate returned ${rawHits.length - visible.length} row(s) the JS policy rejects; dropped`);
    return normalizeKeywordHits(visible);
}

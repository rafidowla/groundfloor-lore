/**
 * sqliteVerbatimFts.ts — keyword (BM25) search for SqliteVerbatimStore.
 *
 * 3.21 step 2 part 1. Tokenizer selection reuses the SAME CJK/Latin
 * threshold policy the Lance path uses (`isCjkCorpus`, extracted from
 * ftsTokenizerProfile.ts in this same step) but produces SQLite FTS5
 * syntax instead of LanceDB's tokenizer options: `porter unicode61
 * remove_diacritics 2` (default — English-oriented stemming, diacritic-
 * insensitive) or `trigram` (CJK — FTS5 ships no per-language segmenter,
 * so whitespace-free scripts need n-grams to be searchable at all, same
 * rationale as the Lance path's `ngram` choice).
 *
 * `bm25Search` returns the SAME `Bm25Envelope` shape the Lance path
 * returns, via the SAME `makeBm25Envelope` helper (verbatimBm25Result.ts).
 * BM25 scores are NOT bit-identical across engines (design section 1,
 * "parity target") — the contract is same top-k id SET, ordering only
 * required to agree where scores differ by more than epsilon.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { isCjkCorpus } from './ftsTokenizerProfile.js';
import { makeBm25Envelope, type Bm25Envelope } from './verbatimBm25Result.js';
import type { VerbatimSearchResult, VerbatimQueryFilter } from '../providers/types.js';
import { escapeLikeWildcards, buildSqlFilterEntries } from './verbatimHistory.js';
import { applyActorScopeFilter } from '../security/scopeFilter.js';
import { getCurrentActorScopes } from '../security/actorContext.js';
import { DEFAULT_TOKENIZER, CJK_TOKENIZER } from './sqliteVerbatimSchema.js';

/**
 * SHORT_TOKEN_MIN_LEN (3) — FTS5's `trigram` tokenizer indexes 3-character
 * windows; a MATCH query shorter than that has no trigram to look up and
 * returns EMPTY rows, not an error (verified empirically: `t MATCH '保险'`
 * against a trigram column containing "...保险证明..." returns zero rows).
 * That's silently WRONG, not a genuine no-match — most Chinese words are
 * 1-2 characters, so this hit the common case, not an edge case. Since it
 * doesn't throw, the existing try/catch around the native MATCH query
 * can't see it; it has to be checked BEFORE running that query.
 */
const SHORT_TOKEN_MIN_LEN = 3;

/** Codepoint-aware length — CJK BMP characters are 1 UTF-16 code unit each
 *  so `.length` would already agree here, but this stays correct for any
 *  astral-plane characters too (`[...s].length` counts codepoints, not
 *  UTF-16 units). */
function charLength(s: string): number {
    return [...s].length;
}

/** Sample-driven tokenizer choice for the SQLite FTS5 table — the SQLite
 *  analogue of ftsTokenizerProfile.ts's `detectTokenizerProfile`, sharing
 *  its CJK/Latin threshold decision via `isCjkCorpus`. */
export function detectSqliteTokenizer(sampleTexts: readonly string[]): string {
    return isCjkCorpus(sampleTexts) ? CJK_TOKENIZER : DEFAULT_TOKENIZER;
}

/** Read the FTS5 table's current tokenizer spec from sqlite_master, so
 *  `initialize()` can compare it against `detectSqliteTokenizer`'s verdict
 *  and decide whether a rebuild is warranted (mirrors reconcileFtsTokenizer's
 *  drift check on the Lance side, at the granularity this schema affords —
 *  a single CREATE VIRTUAL TABLE statement to parse instead of a JSON
 *  sidecar). Returns null if the table doesn't exist yet. */
export function currentFtsTokenizer(db: DatabaseType): string | null {
    const row = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='verbatim_fts'`,
    ).get() as { sql: string } | undefined;
    if (!row?.sql) return null;
    const m = row.sql.match(/tokenize\s*=\s*'([^']*)'/i);
    return m ? m[1]! : null;
}

/** Rebuild the FTS5 table with a new tokenizer — drop + recreate + refill
 *  from the base table, then rebuild triggers (createSchema is idempotent
 *  and re-adds them). Used when `currentFtsTokenizer` disagrees with
 *  `detectSqliteTokenizer`'s verdict on the live corpus. Best-effort: a
 *  failure here degrades to the existing (possibly suboptimal) tokenizer,
 *  never throws — matches the Lance path's non-fatal reconcile stance. */
export function rebuildFtsTable(db: DatabaseType, tokenizer: string): void {
    const run = db.transaction(() => {
        db.exec(`DROP TABLE IF EXISTS verbatim_fts;`);
        db.exec(`
            CREATE VIRTUAL TABLE verbatim_fts USING fts5(
                text, content='verbatim', content_rowid='rowid', tokenize='${tokenizer.replace(/'/g, "''")}'
            );
        `);
        db.exec(`INSERT INTO verbatim_fts(rowid, text) SELECT rowid, text FROM verbatim;`);
    });
    run();
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
 * Ranked substring fallback for a query the trigram tokenizer cannot
 * express (any whitespace-split token under SHORT_TOKEN_MIN_LEN chars).
 * ALL tokens must appear (AND, case-insensitive) — same candidate
 * predicate the genuine-FTS-error LIKE fallback uses below, but RANKED
 * (`ranked: true`), not forced to 1.0: score is total substring-occurrence
 * count across all tokens, normalized to [0,1] by the max count in the
 * result set — the SAME normalization SHAPE the native-FTS path uses
 * (divide by the result set's own maximum), substituting occurrence-count
 * for bm25()'s magnitude as the underlying relevance signal. This is not
 * true BM25 (no IDF, no length normalization) but it IS a genuine,
 * deterministic ranking — marking it `ranked: true` is required for
 * correctness, not just test convenience: recall/retrieve.ts's RRF fusion
 * excludes anything marked unranked, so a short CJK query would find
 * nothing in hybrid recall if this were marked `ranked: false` the way
 * the genuine-FTS-error path is. Tie-break: score desc, then id asc,
 * matching every other ranked result set in this codebase.
 */
function shortTokenSubstringSearch(
    db: DatabaseType,
    tokens: readonly string[],
    limit: number,
    filterSql: string,
    filterParams: readonly unknown[],
    actorScopes: ReadonlyArray<string> | undefined,
): Bm25Envelope<VerbatimSearchResult> {
    if (tokens.length === 0) return makeBm25Envelope([], true);
    const likeClauses = tokens.map(() => `lower(v.text) LIKE ? ESCAPE '\\'`).join(' AND ');
    const likeParams = tokens.map((t) => `%${escapeLikeWildcards(t.toLowerCase())}%`);
    const sql = `
        SELECT v.rowid, v.id, v.text, v.type, v.label, v.tags, v.project, v.ecosystem, v.updatedAt, v.security_scopes
        FROM verbatim v
        WHERE v.is_canonical = 1 AND v.is_tombstone = 0 AND ${likeClauses}
        ${filterSql}
    `;
    const candidates = db.prepare(sql).all(...likeParams, ...filterParams) as Array<Record<string, unknown>>;
    const scored = candidates.map((r) => {
        const lowerText = String(r.text ?? '').toLowerCase();
        let count = 0;
        for (const t of tokens) {
            const needle = t.toLowerCase();
            if (needle.length === 0) continue;
            let idx = 0;
            while ((idx = lowerText.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
        }
        return { row: r, count };
    });
    const maxCount = Math.max(...scored.map((s) => s.count), 1);
    scored.sort((a, b) => (b.count - a.count) || String(a.row.id).localeCompare(String(b.row.id)));
    const mapped = scored.slice(0, limit).map((s) => rowToResult({ ...s.row, score: s.count / maxCount }));
    const filtered = applyActorScopeFilter(mapped, actorScopes ?? getCurrentActorScopes());
    return makeBm25Envelope(filtered, true);
}

/**
 * Escapes a free-text query so it can NEVER be parsed as FTS5 query syntax
 * (Opus review follow-up, 3.21 step 2). `?`-bound parameters protect
 * against ordinary SQL injection, but FTS5's `MATCH` operator applies its
 * OWN mini-language to the bound STRING VALUE itself — binding is not
 * escaping here. Unescaped user text containing `AND`/`OR`/`NOT`/`NEAR(...)`
 * (boolean/proximity operators), a trailing `*` (prefix-wildcard operator),
 * a `column:term` filter (this table only exposes `text`, but the operator
 * still changes parsing), or an unbalanced `"` (parse error) is interpreted
 * as FTS5 syntax, not literal content — silently changing match semantics,
 * or throwing and forcing the unranked LIKE-scan fallback for ordinary text
 * that merely happens to contain FTS5-special characters.
 *
 * Fix: split on whitespace and wrap EVERY token as an FTS5 string literal
 * (embedded `"` doubled, FTS5's own escaping rule for a quoted string). A
 * quoted single-token phrase matches exactly like the same bareword token
 * would (both go through the same tokenizer) — so quoting alone is a no-op
 * for term MATCHING; it only changes behavior for a token that would
 * otherwise be parsed as an operator (`AND`, `OR`, `NOT`, `NEAR(...)`, a
 * `col:term` filter, a trailing `*`), which now becomes a literal search
 * for that word, never an operator.
 *
 * Opus review follow-up #3 — the tokens are joined with ` OR `, NOT a bare
 * space. A bare space between un-operatored FTS5 terms is itself an
 * OPERATOR: FTS5's documented default combining rule for adjacent terms is
 * implicit AND — verified empirically (`MATCH 'vet dog nonexistentword'`
 * against a row containing "vet" and "dog" but not "nonexistentword"
 * returns ZERO rows). That was already true of the RAW, unescaped query
 * before this suite's quoting fix landed — quoting each token and joining
 * with a space preserved the pre-existing implicit-AND behavior rather
 * than introducing it. But Lance's keyword path
 * (`table.query().fullTextSearch(query, {columns:'text'})`, see
 * verbatimStore.ts) uses LanceDB's default `MatchQuery` operator, which is
 * OR — a natural-language query ("What did the vet say was wrong after the
 * dog started limping?") ranks by how MANY of the query's terms a row
 * contains, and a row containing only "dog" and "limping" (not "what",
 * "did", "the", "vet", "say", "wrong", "after", "started") still matches
 * and can rank highly. Under AND, that same query against SQLite would
 * require literally every one of those words present — including common
 * stopwords the porter tokenizer does NOT strip (unlike Lance's
 * `removeStopWords: true` default) — matching almost nothing: a severe
 * keyword-recall gap and an engine-parity violation, not merely a
 * different scoring curve. Joining with ` OR ` instead makes bm25()
 * rank by how many/which terms match, the same shape as Lance's default,
 * while the per-token quoting still neutralizes every operator listed
 * above — a token that IS the literal word "or"/"and"/"not"/"near" is
 * still a quoted phrase, combined via the OR we now insert BETWEEN
 * tokens, never re-interpreted as a second, nested operator.
 */
export function escapeFts5Query(query: string): string {
    const tokens = query.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return '""';
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * bm25Search — native FTS5 `MATCH` + `bm25()` ranking, joined back to the
 * base table so canonical/non-tombstone filtering and the metadata-filter
 * allowlist apply identically to the Lance path. Two fallbacks, for two
 * different reasons:
 *   - A query token shorter than the trigram tokenizer's 3-char window
 *     (only reachable when the LIVE tokenizer is `trigram` — the porter
 *     path has no such floor) routes straight to the RANKED substring
 *     fallback above, before ever running the native MATCH query — native
 *     FTS5 would silently return zero rows for it, not an error.
 *   - A `LIKE` substring scan (UNRANKED — matching Lance's degrade-path
 *     semantics) only when FTS5 itself ERRORS — e.g. a query string FTS5's
 *     parser rejects (bare punctuation, an unbalanced quote) — never
 *     merely because a query legitimately found zero rows.
 */
export function bm25Search(
    db: DatabaseType,
    query: string,
    limit: number,
    filter: VerbatimQueryFilter | undefined,
    actorScopes: ReadonlyArray<string> | undefined,
): Bm25Envelope<VerbatimSearchResult> {
    // D2: array-valued filter fields (e.g. `types: string[]`) become an
    // IN (...) pushdown instead of being silently dropped.
    const filterEntries = buildSqlFilterEntries(filter as Record<string, unknown> | undefined);
    const filterSql = filterEntries.map((e) => `AND v.${e.column} ${e.op}`).join(' ');
    const filterParams = filterEntries.flatMap((e) => e.params);

    const rawTokens = query.split(/\s+/).filter((t) => t.length > 0);
    const tokenizer = currentFtsTokenizer(db);
    if (tokenizer === CJK_TOKENIZER && rawTokens.some((t) => charLength(t) < SHORT_TOKEN_MIN_LEN)) {
        return shortTokenSubstringSearch(db, rawTokens, limit, filterSql, filterParams, actorScopes);
    }

    try {
        const sql = `
            SELECT v.rowid, v.id, v.text, v.type, v.label, v.tags, v.project, v.ecosystem, v.updatedAt, v.security_scopes,
                   bm25(verbatim_fts) as raw_score
            FROM verbatim_fts
            JOIN verbatim v ON v.rowid = verbatim_fts.rowid
            WHERE verbatim_fts MATCH ? AND v.is_canonical = 1 AND v.is_tombstone = 0
            ${filterSql}
            ORDER BY raw_score ASC, v.id ASC
            LIMIT ?
        `;
        const rows = db.prepare(sql).all(escapeFts5Query(query), ...filterParams, limit) as Array<Record<string, unknown>>;
        // bm25() in SQLite returns a NEGATIVE score where more negative is
        // more relevant (the FTS5 doc convention: "smaller is better").
        // Normalize to a POSITIVE [0,1]-ish scale like the Lance path does
        // (divide by the magnitude of the best score in the result set) so
        // callers treat "higher score = more relevant" uniformly across
        // engines.
        const magnitudes = rows.map((r) => Math.abs(Number(r.raw_score ?? 0)));
        const maxMag = Math.max(...magnitudes, 1e-9);
        const mapped = rows.map((r) => rowToResult({ ...r, score: Math.abs(Number(r.raw_score ?? 0)) / maxMag }));
        const filtered = applyActorScopeFilter(mapped, actorScopes ?? getCurrentActorScopes());
        return makeBm25Envelope(filtered, true);
    } catch {
        // FTS5 itself errored (malformed MATCH query, etc.) — degrade to an
        // unranked LIKE scan, mirroring the Lance path's last-resort net.
        const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
        if (tokens.length === 0) return makeBm25Envelope([], true);
        const likeClauses = tokens.map(() => `lower(v.text) LIKE ? ESCAPE '\\'`).join(' AND ');
        const likeParams = tokens.map((t) => `%${t.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
        const sql = `
            SELECT v.id, v.text, v.type, v.label, v.tags, v.project, v.ecosystem, v.updatedAt, v.security_scopes
            FROM verbatim v
            WHERE v.is_canonical = 1 AND v.is_tombstone = 0 AND ${likeClauses}
            ${filterSql}
            LIMIT ?
        `;
        try {
            const rows = db.prepare(sql).all(...likeParams, ...filterParams, limit) as Array<Record<string, unknown>>;
            const mapped = rows.map((r) => rowToResult({ ...r, score: 1.0 }));
            const filtered = applyActorScopeFilter(mapped, actorScopes ?? getCurrentActorScopes());
            return makeBm25Envelope(filtered, false);
        } catch {
            return makeBm25Envelope([], false);
        }
    }
}

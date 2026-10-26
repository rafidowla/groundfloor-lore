/**
 * postgresBm25StopList.ts - a per-workspace document-frequency stop-list for the
 * Postgres keyword (BM25) leg.
 *
 * WHY: `ts_rank` must score every row a query matches. A token that appears in
 * a large share of the rows (65% of a 1M-row table in the 2026-10 re-measure)
 * forces a parallel seq scan that ranks most of the table (~170 ms), yet such a
 * token carries almost no ranking signal. At query time bm25Search drops those
 * tokens from the tsquery when a more selective token remains.
 *
 * WHAT IS STORED (additive, auto-applied with the rest of the verbatim schema,
 * see postgresVerbatimSchema.ts):
 *   - `verbatim_common_lexemes`       (workspace_id, lexeme, doc_ratio, doc_count)
 *   - `verbatim_common_lexemes_meta`  (workspace_id, total_rows, sample_rows, ratio, common_count, built_at)
 * Both are derived data: rebuilt from `text_tsv`, excluded from workspace backups.
 *
 * HOW IT IS COMPUTED: `ts_stat` over a bounded `TABLESAMPLE SYSTEM` sample of the
 * workspace's canonical, non-tombstone rows (the exact rows the BM25 query can
 * return). Measured cost is ~130 ms for a 30k-row sample, flat in table size
 * (full `ts_stat` at 100k rows is ~435 ms and grows linearly). A lexeme is
 * "common" when it occurs in >= `ratio` of the sampled rows. The sample uses
 * REPEATABLE so the row count and the statistics describe the same rows.
 * `pg_stats.most_common_elems` was rejected: it is whole-partition including
 * history and tombstone rows, depends on autovacuum having analysed the leaf,
 * and cannot be forced from here.
 *
 * WHEN IT RUNS: never inline on the recall path.
 *   - PostgresVerbatimStore.ensureFtsIndex()  (bulk ingest finish; awaited, ~130 ms)
 *   - PostgresVerbatimStore.compact()         (the VACUUM ANALYZE path; forced)
 *   - a fire-and-forget background job kicked from bm25Search when the list is
 *     missing or stale (rows moved by >= STALE_DRIFT, ratio setting changed, or
 *     older than MAX_AGE_MS), checked at most once per RECHECK_MS.
 *
 * Setting: LORE_BM25_COMMON_TOKEN_RATIO (default 0.2; 0 or unparsable-negative
 * turns the feature off, giving exactly the pre-existing query).
 */

import type { Pool, PoolClient } from 'pg';

export const COMMON_LEXEMES_TABLE = 'verbatim_common_lexemes';
export const COMMON_LEXEMES_META_TABLE = 'verbatim_common_lexemes_meta';

export const BM25_STOPLIST_DDL: string[] = [
    `CREATE TABLE IF NOT EXISTS ${COMMON_LEXEMES_TABLE} (
    workspace_id TEXT NOT NULL,
    lexeme TEXT NOT NULL,
    doc_ratio DOUBLE PRECISION NOT NULL,
    doc_count BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, lexeme)
)`,
    `CREATE TABLE IF NOT EXISTS ${COMMON_LEXEMES_META_TABLE} (
    workspace_id TEXT PRIMARY KEY,
    total_rows BIGINT NOT NULL,
    sample_rows BIGINT NOT NULL,
    ratio DOUBLE PRECISION NOT NULL,
    common_count INTEGER NOT NULL,
    built_at TIMESTAMPTZ NOT NULL
)`,
];

/**
 * Remove one workspace's persisted list (both tables) so the next query rebuilds it. `schema` qualifies the
 * tables (restore may target a non-default schema); a database that predates the tables is a no-op.
 * Returns the number of rows removed.
 */
export async function clearStopListRows(client: Pick<Pool, 'query'>, workspaceId: string, schema?: string): Promise<number> {
    const q = (t: string): string => (schema ? `"${schema.replace(/"/g, '""')}".${t}` : t);
    let removed = 0;
    for (const t of [COMMON_LEXEMES_TABLE, COMMON_LEXEMES_META_TABLE]) {
        const present = await client.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [q(t)]);
        if (!present.rows[0]?.ok) continue;
        const r = await client.query(`DELETE FROM ${q(t)} WHERE workspace_id = $1`, [workspaceId]);
        removed += r.rowCount ?? 0;
    }
    return removed;
}

export const DEFAULT_COMMON_TOKEN_RATIO = 0.2;
/** Below this many rows ts_rank over every match is cheap, so no stop-list is kept (an empty list is stored). */
export const MIN_ROWS_FOR_STOPLIST = 5_000;
/** Rows the statistics sample aims for. */
export const SAMPLE_TARGET_ROWS = 30_000;
/** Hard cap on stored lexemes (a tiny ratio could otherwise admit most of the vocabulary). */
export const MAX_COMMON_LEXEMES = 2_000;
/** Rebuild when the row count moved by this fraction since the last build. */
export const STALE_DRIFT = 0.2;
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const RECHECK_MS = 60_000;

/**
 * LORE_BM25_COMMON_TOKEN_RATIO -> a ratio in (0, 1], or 0 for "off". Unset or
 * garbage falls back to the default; values >= 1.0 of "more than every row" (> 1)
 * are off because no token can exceed 100% of the rows.
 */
export function bm25CommonTokenRatio(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.LORE_BM25_COMMON_TOKEN_RATIO;
    if (raw === undefined || raw.trim() === '') return DEFAULT_COMMON_TOKEN_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_COMMON_TOKEN_RATIO;
    if (n <= 0 || n > 1) return 0;
    return n;
}

export interface StopListState {
    lexemes: ReadonlySet<string>;
    /** The ratio the list was built with. */
    ratio: number;
    /** Row count (store.count() semantics) when it was built. */
    totalRows: number;
    builtAtMs: number;
}

/** Read the persisted list, or null when this workspace has never been built. */
export async function loadStopList(pool: Pool, workspaceId: string): Promise<StopListState | null> {
    const meta = await pool.query<{ total_rows: string; ratio: number; built_at: Date }>(
        `SELECT total_rows, ratio, built_at FROM ${COMMON_LEXEMES_META_TABLE} WHERE workspace_id = $1`,
        [workspaceId],
    );
    const m = meta.rows[0];
    if (!m) return null;
    const lex = await pool.query<{ lexeme: string }>(
        `SELECT lexeme FROM ${COMMON_LEXEMES_TABLE} WHERE workspace_id = $1`,
        [workspaceId],
    );
    return {
        lexemes: new Set(lex.rows.map((r) => r.lexeme)),
        ratio: Number(m.ratio),
        totalRows: Number(m.total_rows),
        builtAtMs: new Date(m.built_at).getTime(),
    };
}

/** Whether a built list should be rebuilt. `currentRows` is the cheap cached count(). */
export function isStopListStale(state: StopListState, currentRows: number, ratio: number, nowMs: number): boolean {
    if (Math.abs(state.ratio - ratio) > 1e-9) return true;
    if (nowMs - state.builtAtMs > MAX_AGE_MS) return true;
    const base = Math.max(state.totalRows, 1);
    return Math.abs(currentRows - state.totalRows) / base >= STALE_DRIFT;
}

/**
 * Compute and persist the list for one workspace on `client` (a background
 * connection). `totalRows` is the workspace's physical row count (count()
 * semantics) and is only used for the staleness baseline and the sample size.
 * Replaces the workspace's rows atomically under an advisory lock so two
 * processes building at once serialize instead of colliding.
 */
export async function buildStopList(client: PoolClient, workspaceId: string, ratio: number, totalRows: number): Promise<StopListState> {
    let sampleRows = 0;
    let found: Array<{ lexeme: string; ndoc: number }> = [];
    if (totalRows >= MIN_ROWS_FOR_STOPLIST) {
        const pct = Math.min(100, Math.max(0.001, (100 * SAMPLE_TARGET_ROWS) / totalRows));
        const seed = 20261025;
        const cnt = await client.query<{ c: string }>(
            `SELECT count(*) AS c FROM verbatim TABLESAMPLE SYSTEM ($2::float8) REPEATABLE ($3::int)
              WHERE workspace_id = $1 AND is_canonical = 1 AND is_tombstone = 0`,
            [workspaceId, pct, seed],
        );
        sampleRows = Number(cnt.rows[0]?.c ?? 0);
        if (sampleRows > 0) {
            const st = await client.query<{ word: string; ndoc: string }>(
                `SELECT word, ndoc FROM ts_stat(format(
                    'SELECT text_tsv FROM verbatim TABLESAMPLE SYSTEM (%s) REPEATABLE (%s) WHERE workspace_id = %L AND is_canonical = 1 AND is_tombstone = 0',
                    $2::float8, $3::int, $1::text))
                  WHERE ndoc::float8 / $4::float8 >= $5::float8
                  ORDER BY ndoc DESC, word ASC
                  LIMIT ${MAX_COMMON_LEXEMES}`,
                [workspaceId, pct, seed, sampleRows, ratio],
            );
            found = st.rows.map((r) => ({ lexeme: r.word, ndoc: Number(r.ndoc) }));
        }
    }
    await client.query('BEGIN');
    try {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`lore_bm25_stoplist:${workspaceId}`]);
        await client.query(`DELETE FROM ${COMMON_LEXEMES_TABLE} WHERE workspace_id = $1`, [workspaceId]);
        if (found.length > 0) {
            await client.query(
                `INSERT INTO ${COMMON_LEXEMES_TABLE} (workspace_id, lexeme, doc_ratio, doc_count)
                 SELECT $1, t.lexeme, t.ndoc::float8 / $4::float8, t.ndoc
                   FROM unnest($2::text[], $3::bigint[]) AS t(lexeme, ndoc)`,
                [workspaceId, found.map((f) => f.lexeme), found.map((f) => f.ndoc), sampleRows],
            );
        }
        await client.query(
            `INSERT INTO ${COMMON_LEXEMES_META_TABLE} (workspace_id, total_rows, sample_rows, ratio, common_count, built_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (workspace_id) DO UPDATE SET total_rows = EXCLUDED.total_rows, sample_rows = EXCLUDED.sample_rows,
                 ratio = EXCLUDED.ratio, common_count = EXCLUDED.common_count, built_at = EXCLUDED.built_at`,
            [workspaceId, totalRows, sampleRows, ratio, found.length],
        );
        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* the connection is discarded by the pool guard on failure */ }
        throw err;
    }
    return { lexemes: new Set(found.map((f) => f.lexeme)), ratio, totalRows, builtAtMs: Date.now() };
}

/**
 * Split a query's whitespace tokens into those to keep and the common ones.
 * `lexemesOf` returns the 'simple' lexemes a token parses to. A token is
 * droppable ONLY when it parses to exactly one lexeme that is in the list: a
 * multi-lexeme token (`foo-bar`, a URL, `a.b`) is a phrase and is never
 * touched, so phrase semantics are preserved. Tokens that parse to nothing
 * (punctuation) neither count as common nor as a selective term.
 */
export function partitionTokens(
    tokens: string[],
    lexemesOf: (token: string) => readonly string[],
    common: ReadonlySet<string>,
): { kept: string[]; droppedAny: boolean; hasSelective: boolean } {
    const kept: string[] = [];
    let droppedAny = false;
    let hasSelective = false;
    for (const t of tokens) {
        const lex = lexemesOf(t);
        if (lex.length === 1 && common.has(lex[0]!)) { droppedAny = true; continue; }
        kept.push(t);
        if (lex.length > 0) hasSelective = true;
    }
    return { kept, droppedAny, hasSelective };
}

/** The 'simple' lexemes for each token, resolved by Postgres itself so tokenisation can never drift from the stored tsvector. */
export async function lexemesForTokens(pool: Pool, tokens: string[]): Promise<Map<string, string[]>> {
    const res = await pool.query<{ tok: string; lex: string[] }>(
        `SELECT t.tok, tsvector_to_array(to_tsvector('simple', t.tok)) AS lex FROM unnest($1::text[]) AS t(tok)`,
        [tokens],
    );
    return new Map(res.rows.map((r) => [r.tok, r.lex]));
}

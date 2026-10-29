/**
 * postgresVerbatimScopeArr.ts - the `verbatim.security_scope_arr text[]` column: the SQL-filterable twin of the JSON
 * TEXT `security_scopes` column (Phase 0 lane L4).
 *
 * WHY: scopes used to be filtered in JS AFTER `LIMIT`, so a scoped actor who can see ~5% of a workspace got ~5% of
 * topK back. The vector and keyword legs now filter in SQL:
 *   `(cardinality(security_scope_arr) = 0 OR security_scope_arr && $scopes)`
 * Same policy as security/scopeFilter.ts: no scopes on the row = public; otherwise the row needs one scope the actor holds.
 *
 * ONE SOURCE OF TRUTH: the TEXT column stays (backups, history, getById and older builds all read it). The array is
 * DERIVED from it by {@link SCOPE_FUNCTIONS_DDL}'s `verbatim_scopes_to_arr()` in a BEFORE INSERT OR UPDATE OF
 * security_scopes trigger, so every writer - this build's, an older build still running against the database, and a
 * restore of a bundle made before the column existed - ends up with a consistent array, and a scoped row can never
 * appear public because some writer forgot the new column. Writers in this build also write the array explicitly
 * (the trigger then re-derives the same value); that keeps the INSERT self-describing and the column NOT NULL.
 *
 * FAIL CLOSED: text that is not a JSON array/string of scopes maps to a sentinel scope no actor holds, so a
 * corrupted row is hidden from scoped actors rather than shown to them. (The previous JS filter treated unreadable
 * text as public; real writers only ever store `JSON.stringify(string[])`, so this only ever bites corrupt data.)
 *
 * UPGRADE of a database that predates the column ({@link ensureScopeArr}, run from ensureVerbatimSchema inside the
 * schema advisory lock, every statement autocommitted):
 *   1. ADD COLUMN ... NOT NULL DEFAULT '{}' (constant default: catalog-only, no rewrite)
 *   2. the functions, then the trigger - from here on every new write is correct
 *   3. per-workspace batched BACKFILL of the rows already there (keyset on row_id, small autocommitted batches),
 *      recorded by a comment on the workspace's partition so a crash retries and a finished one is never rescanned
 *   4. the GIN index, built CONCURRENTLY per partition and attached to a parent index (a partitioned parent cannot be
 *      indexed CONCURRENTLY directly), so live writers are not blocked
 * A workspace's backfill runs on that workspace's own store open (before its first query), so no workspace is
 * ever served from an unfilled array.
 */

import type { PoolClient } from 'pg';

import { log } from '../../logger.js';
import { VERBATIM_SCOPE_INDEX_NAME } from './postgresVerbatimPartitionDdl.js';

/** Scope no actor holds; stands in for text that cannot be read as a scope list (fail closed). */
export const UNREADABLE_SCOPE_SENTINEL = '__lore_unreadable_scopes__';
/** Trigger name on `verbatim` / `verbatim_next`. */
export const SCOPE_ARR_TRIGGER_NAME = 'verbatim_scope_arr_biu';
/** Comment stamped on a workspace partition once its backfill completed. */
export const SCOPE_BACKFILL_MARKER = 'lore:security_scope_arr backfilled v1';
/** Rows per backfill batch (one autocommitted UPDATE each). */
const BACKFILL_BATCH = 5_000;

/**
 * Mirrors security/scopeFilter.normalizeScopes for what the writers store (a JSON array of strings): array ->
 * its non-empty string members; a JSON string -> comma split; NULL / '' / JSON null -> no scopes (public); anything
 * unreadable (invalid JSON, object, number, bool) -> the fail-closed sentinel. Result is distinct and sorted.
 */
export const SCOPE_FUNCTIONS_DDL: readonly string[] = [
    `CREATE OR REPLACE FUNCTION verbatim_scopes_to_arr(t text) RETURNS text[] AS $$
DECLARE
    j jsonb;
    out text[];
BEGIN
    IF t IS NULL OR t = '' THEN RETURN '{}'; END IF;
    BEGIN
        j := t::jsonb;
    EXCEPTION WHEN others THEN
        RETURN ARRAY['${UNREADABLE_SCOPE_SENTINEL}'];
    END;
    CASE jsonb_typeof(j)
        WHEN 'null' THEN RETURN '{}';
        WHEN 'array' THEN
            SELECT coalesce(array_agg(DISTINCT s ORDER BY s), '{}') INTO out
              FROM (SELECT (e #>> '{}') COLLATE "C" AS s FROM jsonb_array_elements(j) AS x(e) WHERE jsonb_typeof(e) = 'string') q
             WHERE s <> '';
            RETURN out;
        WHEN 'string' THEN
            SELECT coalesce(array_agg(DISTINCT s ORDER BY s), '{}') INTO out
              FROM (SELECT btrim(p) COLLATE "C" AS s FROM unnest(string_to_array(j #>> '{}', ',')) AS p) q
             WHERE s <> '';
            RETURN out;
        ELSE RETURN ARRAY['${UNREADABLE_SCOPE_SENTINEL}'];
    END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE`,
    `CREATE OR REPLACE FUNCTION verbatim_scope_arr_apply() RETURNS trigger AS $$
BEGIN
    NEW.security_scope_arr := verbatim_scopes_to_arr(NEW.security_scopes);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql`,
];

/** Creates the derive-the-array trigger on `table` only when absent (re-creating takes a lock that stalls live writers). */
export function scopeArrTriggerIfAbsentDdl(table: string): string {
    return `
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('${table}') AND tgname = '${SCOPE_ARR_TRIGGER_NAME}') THEN
        CREATE TRIGGER ${SCOPE_ARR_TRIGGER_NAME}
            BEFORE INSERT OR UPDATE OF security_scopes ON ${table}
            FOR EACH ROW EXECUTE FUNCTION verbatim_scope_arr_apply();
    END IF;
END $$;`;
}

/**
 * SQL scope predicate for a search leg. `actorScopes === undefined` (no actor bound: local mode / daemon-internal)
 * adds nothing; `[]` (an authenticated actor holding no scopes) matches public rows only. `param` is the 1-based
 * placeholder number for the scopes array, which is returned as the single entry of `params`.
 * Same policy as security/scopeFilter.applyActorScopeFilter, evaluated BEFORE the LIMIT.
 */
export function scopeFilterSql(
    actorScopes: ReadonlyArray<string> | undefined, param: number, col = 'security_scope_arr',
): { sql: string; params: string[][] } {
    if (actorScopes === undefined) return { sql: '', params: [] };
    return {
        sql: `AND (cardinality(${col}) = 0 OR ${col} && $${param}::text[])`,
        params: [scopesToArray(actorScopes)],
    };
}

/** JS twin of verbatim_scopes_to_arr for the writers: distinct, sorted, non-empty strings. */
export function scopesToArray(scopes: readonly string[] | undefined | null): string[] {
    if (!scopes) return [];
    return [...new Set(scopes.filter((s): s is string => typeof s === 'string' && s !== ''))].sort();
}

/** JS twin of verbatim_scopes_to_arr for a stored JSON TEXT value (the keep-existing-scopes paths hold the raw text). */
export function scopesJsonToArray(json: string | null | undefined): string[] {
    if (json === null || json === undefined || json === '') return [];
    try {
        const v: unknown = JSON.parse(json);
        if (v === null) return [];
        if (Array.isArray(v)) return scopesToArray(v.filter((e): e is string => typeof e === 'string'));
        if (typeof v === 'string') return scopesToArray(v.split(',').map((x) => x.trim()));
    } catch { /* falls through to fail-closed */ }
    return [UNREADABLE_SCOPE_SENTINEL];
}

/** What the upgrade still has to do, from one catalog probe. */
interface ScopeArrState {
    column: boolean;
    functions: boolean;
    trigger: boolean;
    indexValid: boolean;
}

async function probe(client: PoolClient): Promise<ScopeArrState> {
    const res = await client.query<ScopeArrState>(
        `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('verbatim') AND attname = 'security_scope_arr' AND NOT attisdropped) AS "column",
                to_regprocedure('verbatim_scopes_to_arr(text)') IS NOT NULL AND to_regprocedure('verbatim_scope_arr_apply()') IS NOT NULL AS "functions",
                EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('verbatim') AND tgname = '${SCOPE_ARR_TRIGGER_NAME}') AS "trigger",
                coalesce((SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('${VERBATIM_SCOPE_INDEX_NAME}')), false) AS "indexValid"`,
    );
    return res.rows[0]!;
}

/**
 * ensureScopeArr - bring `verbatim` (already partitioned, `workspaceId`'s partition present) to the scope-array
 * layout and backfill `workspaceId`'s rows. Idempotent; the common re-open is one catalog probe plus one
 * partition-comment read. Must run inside runSchemaBootstrap's advisory lock.
 */
export async function ensureScopeArr(client: PoolClient, workspaceId: string): Promise<void> {
    const st = await probe(client);
    if (!st.column) {
        await client.query(`ALTER TABLE verbatim ADD COLUMN IF NOT EXISTS security_scope_arr text[] NOT NULL DEFAULT '{}'`);
    }
    if (!st.functions) for (const stmt of SCOPE_FUNCTIONS_DDL) await client.query(stmt);
    if (!st.trigger) await client.query(scopeArrTriggerIfAbsentDdl('verbatim'));
    await backfillWorkspace(client, workspaceId);
    if (!st.indexValid) await buildScopeIndexConcurrently(client);
}

/** The workspace's partition (regclass text + whether its backfill marker is set), or null when it has none. */
async function partitionOf(client: PoolClient, workspaceId: string): Promise<{ rel: string; done: boolean } | null> {
    const res = await client.query<{ rel: string; comment: string | null }>(
        `SELECT c.oid::regclass::text AS rel, obj_description(c.oid, 'pg_class') AS comment
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = to_regclass('verbatim') AND pg_get_expr(c.relpartbound, c.oid) = format('FOR VALUES IN (%L)', $1::text)`,
        [workspaceId],
    );
    const row = res.rows[0];
    return row ? { rel: row.rel, done: row.comment === SCOPE_BACKFILL_MARKER } : null;
}

/**
 * Batched backfill of one workspace: derive the array from the TEXT column for rows where they disagree.
 * Keyset on the (workspace_id, row_id) primary key; each batch is its own autocommitted statement. The marker
 * (a comment on the partition) is written only after the last batch, so a crash simply re-scans next open. Only rows
 * whose array is wrong are updated: public rows (the overwhelming majority) are not rewritten.
 */
export async function backfillWorkspace(client: PoolClient, workspaceId: string, batchSize = BACKFILL_BATCH): Promise<number> {
    const part = await partitionOf(client, workspaceId);
    if (!part || part.done) return 0;
    let after = '0';
    let updated = 0;
    for (;;) {
        const res = await client.query<{ scanned: number; last: string | null; changed: number }>(
            `WITH b AS (SELECT row_id, security_scopes, security_scope_arr FROM verbatim
                         WHERE workspace_id = $1 AND row_id > $2 ORDER BY row_id LIMIT $3),
                  u AS (UPDATE verbatim v SET security_scope_arr = verbatim_scopes_to_arr(b.security_scopes)
                          FROM b WHERE v.workspace_id = $1 AND v.row_id = b.row_id
                           AND NOT (b.security_scope_arr @> verbatim_scopes_to_arr(b.security_scopes)
                                    AND b.security_scope_arr <@ verbatim_scopes_to_arr(b.security_scopes))
                        RETURNING 1)
             SELECT (SELECT count(*) FROM b)::int AS scanned, (SELECT max(row_id) FROM b) AS last, (SELECT count(*) FROM u)::int AS changed`,
            [workspaceId, after, batchSize],
        );
        const r = res.rows[0]!;
        if (r.scanned === 0 || r.last === null) break;
        updated += r.changed;
        after = r.last;
    }
    // The partition identifier is regclass::text (already quoted); the comment text is a constant.
    await client.query(`COMMENT ON TABLE ${part.rel} IS '${SCOPE_BACKFILL_MARKER}'`);
    if (updated > 0) log.info(`[verbatim-scope-arr] backfilled security_scope_arr for ${updated} row(s) of workspace ${workspaceId}`);
    return updated;
}

/**
 * Build the GIN index on every partition CONCURRENTLY, then create the parent index ON ONLY and attach each partition
 * index (the parent turns valid with the last attach). Resumable: an INVALID leftover from a cancelled concurrent
 * build is dropped and rebuilt, an already-attached partition index is skipped. statement_timeout is lifted for the
 * session while the builds run (a big partition outlasts the pool's default) and restored before the client is returned.
 */
export async function buildScopeIndexConcurrently(client: PoolClient): Promise<void> {
    const parts = await client.query<{ rel: string; idx: string }>(
        `SELECT i.inhrelid::regclass::text AS rel, quote_ident(c.relname || '_scope_arr_gin') AS idx
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = to_regclass('verbatim') ORDER BY c.relname`,
    );
    // Every plain GIN index on exactly (security_scope_arr) of one partition, with whether it is already attached to a
    // parent index. A partition created while the parent index existed carries an auto-named attached clone.
    const scopeIndexes = (rel: string) => client.query<{ name: string; valid: boolean; attached: boolean }>(
        `SELECT quote_ident(ic.relname) AS name, i.indisvalid AS valid,
                EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = ic.oid) AS attached
           FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
          WHERE i.indrelid = $1::regclass AND am.amname = 'gin' AND i.indnatts = 1 AND i.indpred IS NULL
            AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'security_scope_arr')`,
        [rel],
    );
    await client.query('SET statement_timeout = 0');
    try {
        for (const p of parts.rows) {
            const have = (await scopeIndexes(p.rel)).rows;
            for (const bad of have.filter((x) => !x.valid && !x.attached)) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${bad.name}`);
            if (!have.some((x) => x.valid)) {
                await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${p.idx} ON ${p.rel} USING gin(security_scope_arr)`);
            }
        }
        await client.query(`CREATE INDEX IF NOT EXISTS ${VERBATIM_SCOPE_INDEX_NAME} ON ONLY verbatim USING gin(security_scope_arr)`);
        for (const p of parts.rows) {
            const have = (await scopeIndexes(p.rel)).rows;
            if (have.some((x) => x.attached)) continue;
            const free = have.find((x) => x.valid);
            if (free) await client.query(`ALTER INDEX ${VERBATIM_SCOPE_INDEX_NAME} ATTACH PARTITION ${free.name}`);
        }
    } finally {
        await client.query('RESET statement_timeout');
    }
}

/**
 * postgresVerbatimSchema.ts — Postgres engine: the verbatim DDL.
 *
 * Mirrors `engines/sqliteVerbatimSchema.ts` createSchema + changes-log,
 * row-for-row, with the three Postgres substitutions (see below):
 *
 *   1. SQLite's implicit `rowid INTEGER PRIMARY KEY AUTOINCREMENT` becomes
 *      `row_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`, and every
 *      table leads with `workspace_id TEXT NOT NULL` — rows are keyed per
 *      workspace, every later query filters `workspace_id = $1` (no DB-level
 *      multi-tenancy beyond the column; the placement directory is out of
 *      scope).
 *   2. FTS5 external-content table -> a plain `text_tsv tsvector` column +
 *      GIN index, maintained by a BEFORE INSERT OR UPDATE trigger so the
 *      column can never drift from `text`. Tokenizer: `to_tsvector('simple', …)`
 *      — see TOKENIZER NOTE below.
 *   3. The float32-LE BLOB -> pgvector `vector(DIMENSION)` + an HNSW
 *      `(vector_cosine_ops)` index PER WORKSPACE (cosine, the same distance
 *      the SQLite brute-force path computes). `verbatim` is LIST-partitioned
 *      by `workspace_id`; the HNSW (and every other) index is declared on
 *      the partitioned parent, so each workspace partition owns its own
 *      graph and a small workspace never searches through a large
 *      neighbour's vectors. See "PARTITIONING" below. DIMENSION IS A PARAMETER: callers read the
 *      embedding manifest (`engines/embeddingFingerprint.ts`,
 *      `<ws>/.lore/lancedb/embedding_model.json`; the current default is
 *      Xenova/multilingual-e5-small, 384-d) — it is NEVER hard-coded here. A
 *      pre-existing store whose column dimension differs from the requested
 *      one fails LOUDLY (manifest mismatch) — never a silent rebuild.
 *
 * Like SQLite keeps it, history/tombstone rows are indexed too (the trigger
 * fires on every row; search-time filtering excludes non-canonical /
 * tombstone rows via the join, matching the Lance model).
 */

import type { PoolClient } from 'pg';

import { BM25_STOPLIST_DDL, COMMON_LEXEMES_TABLE, COMMON_LEXEMES_META_TABLE } from './postgresVerbatim/postgresBm25StopList.js';
import { migrateVerbatimToPartitioned } from './postgresVerbatimPartitionMigration.js';
import { SCOPE_FUNCTIONS_DDL, scopeArrTriggerIfAbsentDdl, ensureScopeArr } from './postgresVerbatimScopeArr.js';
import {
    VERBATIM_INDEX_NAMES, TEXT_TSV_FUNCTION_DDL, partitionedVerbatimDdl, ensureWorkspacePartition, assertDimension,
    ensureVerbatimPartitionKeyColumn,
} from './postgresVerbatimPartitionDdl.js';

export {
    PGVECTOR_HNSW_MAX_DIMENSION, VERBATIM_INDEX_NAMES, VERBATIM_SCOPE_INDEX_NAME, VERBATIM_COLUMNS, TEXT_TSV_FUNCTION_DDL, partitionedVerbatimDdl,
    verbatimPartitionName, ensureWorkspacePartition,
} from './postgresVerbatimPartitionDdl.js';


/**
 * TOKENIZER NOTE (vs SQLite `tokenize='porter unicode61 remove_diacritics 2'`):
 * Postgres has no `porter` configuration; the closest per-language config
 * ('english') would add English-only stemming plus stop-word removal, i.e. a
 * WORSE and asymmetric approximation. `simple` lowercases and splits on the
 * default parser's boundaries but does NOT stem and does NOT fold diacritics
 * ("café" does not match "cafe"), so keyword-search RECALL can differ from
 * FTS5 at the edges. The engine-contract parity gates normalize only ranked full-text
 * ORDER (FTS5 bm25 vs ts_rank) and keeps the same result set; if gate runs
 * show membership drift on accented/stemmed terms, this choice — not the gate
 * — is the documented first suspect.
 */
const TEXT_TSV_TRIGGER_DDL = `
CREATE OR REPLACE FUNCTION verbatim_text_tsv_apply() RETURNS trigger AS $$
BEGIN
    NEW.text_tsv := to_tsvector('simple', NEW.text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER verbatim_text_tsv_biur
    BEFORE INSERT OR UPDATE ON verbatim
    FOR EACH ROW EXECUTE FUNCTION verbatim_text_tsv_apply();
`;

/**
 * PARTITIONING (decision D3, 2026-10-23)
 *
 * `verbatim` is `PARTITION BY LIST (workspace_id)`, one partition per
 * workspace named `verbatim_ws_<24 hex of sha256(workspace_id)>` (workspace
 * ids are arbitrary text, so the name is derived, never interpolated).
 *
 *   - Why partitions and not partial indexes (`... WHERE workspace_id = 'x'`):
 *     a planner only picks a partial index when the query's predicate is
 *     provably implied by the index predicate, which needs a LITERAL (not a
 *     bind parameter) and one index definition per workspace chosen at
 *     query time. LIST partitioning prunes on `workspace_id = $1` natively
 *     (plan-time with a custom plan, run-time for a generic plan), keeps ONE
 *     schema (indexes declared once on the parent are created on every
 *     present and future partition automatically), and gives O(1) workspace
 *     removal (DETACH/DROP the partition). Cost: the primary key must carry
 *     the partition key — `(workspace_id, row_id)` — and a brief ACCESS
 *     EXCLUSIVE lock on the parent while a NEW workspace's partition is
 *     created (once per workspace, ever).
 *   - `row_id` is `BIGINT NOT NULL DEFAULT nextval('verbatim_row_seq')`, not
 *     an identity column: identity on a partitioned table is not portable
 *     across the PG 14-17 range this engine supports, a shared sequence
 *     default is inherited by every partition on every version. Writers never
 *     name `row_id`, so behaviour is unchanged.
 *   - The partition for a workspace is created by {@link ensureWorkspacePartition}
 *     from the same advisory-locked bootstrap that creates the schema, on the
 *     first open of a workspace's store (so before its first write).
 *   - A database created by an earlier release holds ONE plain `verbatim`
 *     table; {@link ensureVerbatimSchema} hands that to
 *     postgresVerbatimPartitionMigration.ts, which converts it in place.
 */

/** Statement 0: the extension. Must exist before the `vector(DIMENSION)` column type can be resolved. */
export const CREATE_VECTOR_EXTENSION_DDL = `CREATE EXTENSION IF NOT EXISTS vector`;

/** Creates the tsvector trigger on `verbatim` only when absent (re-creating takes a SHARE ROW EXCLUSIVE lock that stalls live writers). */
export const TEXT_TSV_TRIGGER_IF_ABSENT_DDL = `
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('verbatim') AND tgname = 'verbatim_text_tsv_biur') THEN
        CREATE TRIGGER verbatim_text_tsv_biur
            BEFORE INSERT OR UPDATE ON verbatim
            FOR EACH ROW EXECUTE FUNCTION verbatim_text_tsv_apply();
    END IF;
END $$;`;

/**
 * `verbatim_changes_log` is no longer created on Postgres (Phase 0, shard-ready): the table has no workspace column, nothing
 * populates it and nothing reads it (the SQLite table feeds the SQLite -> LanceDB promotion tail copy, which never runs for
 * a Postgres workspace; see docs/CONFIGURATION.md and test/postgres-changes-log-pin-unit.ts). A database that already has
 * the (empty) table keeps it until {@link dropVerbatimChangesLog}, the explicit contract step.
 */
export const VERBATIM_CHANGES_LOG_TABLE = 'verbatim_changes_log';

/**
 * CONTRACT step (never run at startup): drop the unused `verbatim_changes_log`. Refuses (keeps the table) if it holds any
 * row, because that would mean something did write to it. Returns what happened.
 */
export async function dropVerbatimChangesLog(client: Pick<PoolClient, 'query'>): Promise<{ dropped: boolean; refused?: string }> {
    const t = await client.query<{ t: string | null }>(`SELECT to_regclass('${VERBATIM_CHANGES_LOG_TABLE}')::text AS t`);
    if (!t.rows[0]?.t) return { dropped: false };
    const n = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${VERBATIM_CHANGES_LOG_TABLE}`);
    if (Number(n.rows[0]?.n ?? '0') > 0) return { dropped: false, refused: `${VERBATIM_CHANGES_LOG_TABLE} holds ${n.rows[0]!.n} row(s); something wrote to it, so it was kept` };
    await client.query(`DROP TABLE ${VERBATIM_CHANGES_LOG_TABLE}`);
    return { dropped: true };
}

/**
 * The verbatim DDL as a statement array, PARAMETERIZED on the embedding
 * dimension: the extension, the sequence + partitioned parent + its indexes,
 * the tsvector function + trigger. It creates NO
 * partition (see {@link ensureWorkspacePartition}). Exported for tests and
 * contract tests to run the SAME statements the engine runs — do not inline
 * copies elsewhere.
 */
export function verbatimSchema_ddl(dimension: number): string[] {
    return [
        CREATE_VECTOR_EXTENSION_DDL,
        ...partitionedVerbatimDdl(dimension, 'verbatim', 'verbatim'),
        TEXT_TSV_FUNCTION_DDL,
        TEXT_TSV_TRIGGER_IF_ABSENT_DDL,
        // security_scope_arr is derived from the JSON TEXT column by a trigger (see postgresVerbatimScopeArr.ts).
        ...SCOPE_FUNCTIONS_DDL,
        scopeArrTriggerIfAbsentDdl('verbatim'),
        // Additive: the BM25 common-token stop-list tables (derived data, see postgresBm25StopList.ts).
        ...BM25_STOPLIST_DDL,
    ];
}

/**
 * ensureVerbatimSchema — create the partitioned verbatim table, indexes,
 * trigger, changes-log and `workspaceId`'s partition if absent (idempotent),
 * or convert a pre-partitioning single table in place first. `dimension` MUST come from the
 * embedding manifest the caller loaded. For a pre-existing table the vector
 * column dimension is checked FIRST and a mismatch aborts the whole call
 * before any DDL runs.
 */
export async function ensureVerbatimSchema(client: PoolClient, workspaceId: string, dimension: number): Promise<void> {
    if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
        throw new Error('ensureVerbatimSchema: workspaceId must be a non-empty string');
    }
    const ddl = verbatimSchema_ddl(dimension);
    await client.query(ddl[0]!); // CREATE EXTENSION vector — the column type below resolves against it
    await ensureVectorColumn(client, dimension);
    const state = await verbatimTableState(client);
    // L3: an older database lacks the column; the migration below copies VERBATIM_COLUMNS (which names it), so add it first.
    if (state !== 'absent') await ensureVerbatimPartitionKeyColumn(client, 'verbatim');
    if (state === 'legacy') {
        // Pre-partitioning database: one plain table. Convert in place (resumable; see the migration module).
        await migrateVerbatimToPartitioned(client, dimension);
    } else if (state === 'absent' || !(await schemaIsCurrent(client))) {
        // A partitioned table from before the scope-array column must gain it (and its trigger) BEFORE the list below
        // runs: that list's plain `CREATE INDEX IF NOT EXISTS ... (security_scope_arr)` would otherwise fail on the
        // missing column, or build the index with a blocking lock. ensureScopeArr builds it concurrently instead.
        if (state === 'partitioned') await ensureScopeArr(client, workspaceId);
        // Skipped on the common re-open: every statement below is IF NOT EXISTS, but even a no-op
        // CREATE INDEX IF NOT EXISTS takes a SHARE lock on the table (and on EVERY partition of a
        // partitioned one) before it finds the index exists, which would stall live writers.
        for (let i = 1; i < ddl.length; i++) await client.query(ddl[i]!);
    }
    // The BM25 stop-list tables are additive and independent of the table/index set above: when only they are missing
    // (a database from before the feature) create just them, instead of making schemaIsCurrent() fail and re-running
    // every CREATE INDEX IF NOT EXISTS (a SHARE lock per partition) once at first open after the upgrade.
    const present = await client.query<{ ok: boolean }>(
        `SELECT to_regclass('${COMMON_LEXEMES_TABLE}') IS NOT NULL AND to_regclass('${COMMON_LEXEMES_META_TABLE}') IS NOT NULL AS ok`,
    );
    if (present.rows[0]?.ok !== true) for (const stmt of BM25_STOPLIST_DDL) await client.query(stmt);
    await ensureWorkspacePartition(client, workspaceId);
    // Common re-open: one catalog probe + one partition-comment read. Upgrade/backfill path: see postgresVerbatimScopeArr.ts.
    await ensureScopeArr(client, workspaceId);
}

/** 'absent' (no table), 'legacy' (plain table from an earlier release), 'partitioned'. */
export async function verbatimTableState(client: PoolClient): Promise<'absent' | 'legacy' | 'partitioned'> {
    const res = await client.query<{ relkind: string }>(`SELECT relkind FROM pg_class WHERE oid = to_regclass('verbatim')`);
    const kind = res.rows[0]?.relkind;
    if (kind === undefined) return 'absent';
    if (kind === 'p') return 'partitioned';
    if (kind === 'r') return 'legacy';
    throw new Error(`ensureVerbatimSchema: "verbatim" exists with unexpected relkind "${kind}" — refusing to touch it`);
}

/** True when the parent, every named index, the trigger and the row sequence already exist. */
async function schemaIsCurrent(client: PoolClient): Promise<boolean> {
    const res = await client.query<{ ok: boolean }>(
        `SELECT (SELECT count(*) FROM pg_class WHERE relname = ANY($1::text[]) AND relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = to_regclass('verbatim'))) = $2
            AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('verbatim') AND tgname = 'verbatim_text_tsv_biur')
            AND to_regclass('verbatim_row_seq') IS NOT NULL AS ok`,
        [VERBATIM_INDEX_NAMES as unknown as string[], VERBATIM_INDEX_NAMES.length],
    );
    return res.rows[0]?.ok === true;
}

/**
 * ensureVectorColumn — the dimension idempotency gate. When the verbatim
 * table already has a `vector` column, its declared dimension must equal the
 * requested one (an embedding-manifest change without a fresh database is
 * exactly the accident this catches); anything else throws. A table without
 * a vector column also throws: this engine is its only schema author, so a
 * column-less verbatim table means someone else created it — refusing to
 * guess beats a confusing failure at the first vector write. A missing TABLE
 * is fine (fresh store): the CREATE TABLE above stamps the dimension.
 */
export async function ensureVectorColumn(client: PoolClient, dimension: number): Promise<void> {
    assertDimension(dimension, 'ensureVectorColumn');
    const probe = await client.query(`
        SELECT format_type(a.atttypid, a.atttypmod) AS col_type
          FROM pg_attribute a
         WHERE a.attrelid = to_regclass('verbatim')
           AND a.attname = 'vector'
           AND a.attnum > 0
           AND NOT a.attisdropped`);
    if (probe.rowCount === 0) return; // no verbatim table (or no vector column in it)
    const colType = String(probe.rows[0]?.col_type ?? '');
    if (colType === 'vector') {
        throw new Error(
            'ensureVectorColumn: verbatim.vector exists WITHOUT a declared dimension '
            + `(type "vector", expected vector(${dimension})) — not created by this engine's schema; refusing to guess`,
        );
    }
    const match = /^vector\((\d+)\)$/.exec(colType);
    if (!match) {
        throw new Error(
            `ensureVectorColumn: verbatim.vector has unexpected type "${colType}" `
            + `(expected vector(${dimension})) — not created by this engine's schema; refusing to touch the store`,
        );
    }
    const stored = Number(match[1]);
    if (stored !== dimension) {
        throw new Error(
            `ensureVectorColumn: embedding manifest mismatch — verbatim.vector is vector(${stored}) `
            + `but the manifest requires vector(${dimension}). Refusing to silently rebuild; `
            + `use a database matching the manifest, or re-ingest into a fresh one`,
        );
    }
}


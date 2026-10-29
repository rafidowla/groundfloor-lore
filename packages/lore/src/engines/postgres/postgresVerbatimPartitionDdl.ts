/**
 * postgresVerbatimPartitionDdl.ts - the building blocks of the LIST-partitioned
 * `verbatim` layout (see the PARTITIONING notes in postgresVerbatimSchema.ts):
 * column and index definitions, the per-workspace partition helper and the
 * dimension guard. Split out so the in-place migration module and the schema
 * module can both import them without a cycle.
 */

import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { quoteIdent } from './postgresBackupDiscovery.js';

/**
 * pgvector's HNSW index supports at most 2000 dimensions for the `vector`
 * type (the column itself allows 16000). Since this schema always builds the
 * HNSW index, a dimension above this is rejected up front with a clear error
 * instead of a cryptic index failure.
 */
export const PGVECTOR_HNSW_MAX_DIMENSION = 2000;

/** Index/constraint names of the partitioned parent (names are schema-global, so migrations rename to these). */
export const VERBATIM_INDEX_NAMES = [
    'verbatim_pkey', 'verbatim_canonical_id_uq', 'verbatim_id_idx', 'verbatim_content_hash_idx',
    'verbatim_project_idx', 'verbatim_text_tsv_gin', 'verbatim_vector_hnsw',
] as const;

/**
 * Scope-array GIN index on the partitioned parent (one per partition). Kept OUT of {@link VERBATIM_INDEX_NAMES} on
 * purpose: `schemaIsCurrent` counts those names, and a database from before this index existed must be upgraded by
 * the concurrent per-partition build in postgresVerbatimScopeArr.ts, not by re-running the plain
 * `CREATE INDEX IF NOT EXISTS` list (which would build it with a blocking SHARE lock on every partition).
 */
export const VERBATIM_SCOPE_INDEX_NAME = 'verbatim_scope_arr_gin';

/** Every physical column of `verbatim` in declaration order (copy lists, tests). */
export const VERBATIM_COLUMNS = [
    'row_id', 'workspace_id', 'id', 'text', 'vector', 'content_hash', 'type', 'label', 'tags', 'project',
    'ecosystem', '"updatedAt"', 'security_scopes', 'security_scope_arr', 'is_canonical', 'is_tombstone', 'superseded_at',
    'created_at', 'updated_at', 'partition_key', 'text_tsv',
] as const;

/** Column definitions shared by `verbatim` and the migration's staging table `verbatim_next`. */
const VERBATIM_COLUMN_DEFS = (dimension: number): string => `
    row_id BIGINT NOT NULL DEFAULT nextval('verbatim_row_seq'),
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    text TEXT NOT NULL,
    vector vector(${dimension}),
    content_hash TEXT,
    type TEXT,
    label TEXT,
    tags TEXT,
    project TEXT,
    ecosystem TEXT,
    "updatedAt" TEXT,
    security_scopes TEXT,
    security_scope_arr TEXT[] NOT NULL DEFAULT '{}',
    is_canonical INTEGER NOT NULL DEFAULT 1,
    is_tombstone INTEGER NOT NULL DEFAULT 0,
    superseded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    partition_key TEXT NOT NULL DEFAULT '',
    text_tsv tsvector NOT NULL DEFAULT ''::tsvector`;

/**
 * DDL that creates the PARTITIONED parent table named `table` (`verbatim`, or
 * `verbatim_next` while a migration builds it) with its indexes, each named
 * `<indexPrefix>_<suffix>`. Does NOT create the tsvector trigger (the
 * migration attaches it after its bulk copy so the copy does not recompute
 * every tsvector).
 */
export function partitionedVerbatimDdl(dimension: number, table: string, indexPrefix: string): string[] {
    assertDimension(dimension, 'partitionedVerbatimDdl');
    return [
        `CREATE SEQUENCE IF NOT EXISTS verbatim_row_seq AS BIGINT`,
        `CREATE TABLE IF NOT EXISTS ${table} (${VERBATIM_COLUMN_DEFS(dimension)},
    CONSTRAINT ${indexPrefix}_pkey PRIMARY KEY (workspace_id, row_id)
) PARTITION BY LIST (workspace_id)`,
        // Fast "the current row for this id" lookup — canonical rows are unique per
        // (workspace, id); history snapshots are not, and are not indexed here (see
        // the SQLite comment on verbatim_canonical_id_uq).
        `CREATE UNIQUE INDEX IF NOT EXISTS ${indexPrefix}_canonical_id_uq ON ${table}(workspace_id, id) WHERE is_canonical = 1`,
        `CREATE INDEX IF NOT EXISTS ${indexPrefix}_id_idx ON ${table}(workspace_id, id)`,
        `CREATE INDEX IF NOT EXISTS ${indexPrefix}_content_hash_idx ON ${table}(workspace_id, content_hash)`,
        `CREATE INDEX IF NOT EXISTS ${indexPrefix}_project_idx ON ${table}(workspace_id, project)`,
        // Full-text (replaces the FTS5 external-content virtual table); one GIN per partition.
        `CREATE INDEX IF NOT EXISTS ${indexPrefix}_text_tsv_gin ON ${table} USING gin(text_tsv)`,
        // Scope filter pushdown: `security_scope_arr && $scopes` (cardinality() = 0 is the public-row arm, a seq/filter test).
        // `<indexPrefix>_scope_arr_gin` matches VERBATIM_SCOPE_INDEX_NAME for the live table.
        `CREATE INDEX IF NOT EXISTS ${indexPrefix}_scope_arr_gin ON ${table} USING gin(security_scope_arr)`,
        // Vector: HNSW, cosine ops — same distance as the SQLite/Lance path. Declared on the
        // partitioned parent, Postgres builds one independent HNSW graph per workspace partition.
        `CREATE INDEX IF NOT EXISTS ${indexPrefix}_vector_hnsw ON ${table} USING hnsw(vector vector_cosine_ops)`,
    ];
}


/**
 * Phase 0 lane L3: add `partition_key TEXT NOT NULL DEFAULT ''` to `table` (a plain legacy `verbatim`, the partitioned
 * parent, or a staging `verbatim_next`) when it is missing. A constant-default ADD COLUMN is catalog-only on PG 11+ (no
 * rewrite, and it propagates to every partition); `ADD COLUMN IF NOT EXISTS` still takes ACCESS EXCLUSIVE when the
 * column exists, so the catalog is probed first and an up-to-date table is never locked. Returns true when added.
 */
export async function ensureVerbatimPartitionKeyColumn(client: PoolClient, table: string): Promise<boolean> {
    const probe = await client.query<{ present: boolean; exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists,
                EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = 'partition_key'
                          AND attnum > 0 AND NOT attisdropped) AS present`,
        [table],
    );
    const row = probe.rows[0];
    if (!row || row.exists !== true || row.present === true) return false;
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT ''`);
    return true;
}

/** The trigger FUNCTION (replaceable without any table lock). */
export const TEXT_TSV_FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION verbatim_text_tsv_apply() RETURNS trigger AS $$
BEGIN
    NEW.text_tsv := to_tsvector('simple', NEW.text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;


/** Deterministic partition name for a workspace (24 hex = 96 bits of sha256; never user text). */
export function verbatimPartitionName(workspaceId: string): string {
    return `verbatim_ws_${createHash('sha256').update(workspaceId).digest('hex').slice(0, 24)}`;
}

/**
 * ensureWorkspacePartition — create `workspaceId`'s partition (and, via the
 * parent's partitioned indexes, its own HNSW/GIN/btree indexes) if absent.
 * Idempotent and safe across processes: callers run it inside
 * runSchemaBootstrap's advisory lock, and the check-then-create is repeated
 * as `CREATE TABLE IF NOT EXISTS`. The existence probe is a catalog read, so
 * the ACCESS EXCLUSIVE lock `CREATE TABLE ... PARTITION OF` takes on the
 * parent is paid ONCE per workspace, never on a re-open. Returns true when it
 * created the partition. Throws if the derived name is already taken by a
 * relation that is not a partition of `verbatim` (a 96-bit hash collision or
 * foreign object — refusing beats writing into the wrong table).
 *
 * A partition that already holds this workspace's bound under ANOTHER name is
 * reused (returns false), never duplicated: `CREATE ... PARTITION OF` would
 * fail with an overlap error and the workspace could not be written to. Such
 * a partition was created by 3.37.0 / 3.37.1's restore (generic
 * `verbatim_ws_<12 hex>` name); this is what lets a workspace restored on
 * those builds open on a later one.
 *
 * `schema` (optional) qualifies the parent and the partition; omitted, both
 * resolve through the connection's search_path, as every runtime caller does.
 */
export async function ensureWorkspacePartition(
    client: PoolClient, workspaceId: string, parent = 'verbatim', schema?: string,
): Promise<boolean> {
    if (typeof workspaceId !== 'string' || workspaceId === '') {
        throw new Error('ensureWorkspacePartition: workspaceId must be a non-empty string');
    }
    const name = verbatimPartitionName(workspaceId);
    // `qualify` feeds to_regclass (plain names resolve through search_path); `ident` is the quoted form spliced into DDL.
    const qualify = (rel: string): string => (schema === undefined ? rel : `${quoteIdent(schema)}.${quoteIdent(rel)}`);
    const ident = (rel: string): string => (schema === undefined ? quoteIdent(rel) : qualify(rel));
    const probe = await client.query<{ attached: boolean | null }>(
        `SELECT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid AND i.inhparent = to_regclass($2)) AS attached
           FROM pg_class c WHERE c.oid = to_regclass($1)`,
        [qualify(name), qualify(parent)],
    );
    if (probe.rowCount !== 0) {
        if (probe.rows[0]?.attached) return false;
        throw new Error(`ensureWorkspacePartition: relation ${name} exists but is not a partition of ${parent} — refusing to guess`);
    }
    // Same bound under a different name (a partition another path created): reuse it.
    const byBound = await client.query(
        `SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = to_regclass($1) AND pg_get_expr(c.relpartbound, c.oid) = format('FOR VALUES IN (%L)', $2::text)`,
        [qualify(parent), workspaceId],
    );
    if ((byBound.rowCount ?? 0) > 0) return false;
    const stmt = await client.query<{ ddl: string }>(
        `SELECT format('CREATE TABLE IF NOT EXISTS %s PARTITION OF %s FOR VALUES IN (%L)', $1::text, $3::text, $2::text) AS ddl`,
        [ident(name), workspaceId, ident(parent)],
    );
    await client.query(stmt.rows[0]!.ddl);
    return true;
}


/** Shared dimension guard: integer within pgvector's HNSW range, with a named-context error. */
export function assertDimension(dimension: number, context: string): void {
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > PGVECTOR_HNSW_MAX_DIMENSION) {
        throw new Error(
            `${context}: embedding dimension must be an integer in 1..${PGVECTOR_HNSW_MAX_DIMENSION} `
            + `(pgvector HNSW limit), got ${JSON.stringify(dimension)}`,
        );
    }
}

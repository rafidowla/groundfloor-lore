/**
 * postgresEdgeSchema.ts - Postgres engine: the `edges` table layout (design D3, edge layout 2).
 *
 * EDGE LAYOUT 2 (this file) keys an edge by the integer surrogate keys of its endpoints:
 *
 *   PRIMARY KEY (workspace_id, src_sk, dst_sk, relation)
 *
 * and carries NO text endpoint ids - reads that must return them join `nodes` on `sk`
 * (`nodes.sk` is a BIGINT identity; public text ids are unchanged and `sk` never leaves the engine).
 *
 * `sk` IS UNIQUE PER WORKSPACE, NOT PER DATABASE. The database-wide identity sequence happens to hand out
 * distinct values, but nothing may rely on that: a logical restore shifts `sk` by an offset only on overlap, a
 * workspace moved or split to another database keeps its own `sk` values, and a shard owns its own
 * sequence. The invariant the schema enforces is `UNIQUE (workspace_id, sk)` on `nodes`
 * ({@link workspaceSkIndexSpecs}), so EVERY join from an edge endpoint to a node names both columns:
 * `JOIN nodes s ON s.workspace_id = e.workspace_id AND s.sk = e.src_sk`. Why `workspace_id` still leads the
 * edge key: every query filters it, the logical backup lane selects and deletes rows by it
 * (`WHERE workspace_id = $1`), and a leading workspace_id lets this ONE index serve the workspace-wide
 * scans (count, queryEdges, prune, workspace delete) AND the forward lookup (workspace_id, src_sk), so no
 * second index is needed for either.
 *
 * Secondary indexes (kept minimal, each tied to a call site):
 *   - `idx_edges_ws_dst_sk (workspace_id, dst_sk)`  reverse direction: in-traversal, `target` filters,
 *                                            deleteNode, the orphan check. Workspace-led because the node
 *                                            side of every join is workspace-scoped; btree deduplication
 *                                            keeps the entry small for hub nodes.
 *   - `idx_edges_dst_sk (dst_sk)`            the previous reverse index. KEPT (expand/migrate/contract) so
 *                                            an older build running against the same database keeps its plans;
 *                                            {@link dropGlobalSkIndexes} removes it, together with
 *                                            `idx_nodes_sk`, once the workspace-led ones are valid. Never
 *                                            dropped at startup.
 *   - `idx_edges_relation (workspace_id, relation)`  relation-only reads: supersession recall
 *                                            ('corrects'), link rebuild, prune by relation.
 *
 * Column order is deliberate: the five 8-byte columns come first so the heap tuple has no alignment
 * padding in front of the variable-length text columns.
 *
 * `src_sk` / `dst_sk` carry `COMMENT ON COLUMN ... 'lore:references nodes.sk'`
 * ({@link edgeReferenceCommentDdl}) so the logical backup/restore lane remaps them; a real FOREIGN KEY
 * is deliberately not used (restore loads tables in an order it controls, and a FK would cost an
 * index probe per edge write).
 *
 * LAYOUT GUARD: the table comment `lore:edge-layout=<n>` records the layout. An engine that knows
 * layout N refuses a database stamped with a higher one ({@link assertEdgeLayoutSupported}). Engines
 * older than the guard have no such check, but they also cannot run against layout 2: their bootstrap
 * backfill and every edge write name `source_id` / `target_id`, which no longer exist, so they fail
 * loudly instead of writing rows without surrogate keys.
 *
 * LEGACY (layout 1, text-keyed) tables are converted in place by `postgresEdgePkMigration.ts`; the
 * additive steps a layout-1 table needs first (sk columns, provenance columns, sk backfill) live at the
 * bottom of this file and run only when a layout-1 table is found. The migration resolves every endpoint
 * through `nodes` itself, so the old sk backfill is gone: a stored `src_sk` / `dst_sk` is never trusted.
 */
import type { PoolClient } from 'pg';

/** The edge table layout this engine writes and understands. */
export const EDGE_LAYOUT_VERSION = 2;
const LAYOUT_PREFIX = 'lore:edge-layout=';

/** Columns shared by the layout-2 table, in storage order (see the header for why). */
export const EDGE_TABLE_COLUMNS_DDL = `
    src_sk BIGINT NOT NULL,
    dst_sk BIGINT NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    created_at TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    workspace_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'extracted',
    origin TEXT,
    policy_version TEXT,
    model_fingerprint TEXT`;

/** `CREATE TABLE` for a layout-2 edges table named `table` (primary key added separately so a bulk copy can load first). */
export const edgeTableDdl = (table: string): string => `CREATE TABLE IF NOT EXISTS ${table} (${EDGE_TABLE_COLUMNS_DDL}\n)`;

export const EDGE_PRIMARY_KEY_COLUMNS = 'workspace_id, src_sk, dst_sk, relation';

/**
 * Wrap an index creation so it runs only while the workspace-led constraint `UNIQUE (workspace_id, sk)` does not
 * exist yet. Once the contract step ({@link dropGlobalSkIndexes}) has dropped the database-wide index, the
 * constraint's presence stops every later open from re-creating it (which would undo the contract). The index's own
 * presence is checked too: `CREATE INDEX IF NOT EXISTS` takes its SHARE lock before the existence check, and on every
 * open that lock would queue behind (and deadlock with) a background CREATE INDEX CONCURRENTLY on the same table.
 */
const indexName = (createIndex: string): string => {
    const m = /IF NOT EXISTS (\w+) ON /.exec(createIndex);
    if (!m) throw new Error(`unlessWorkspaceSkConstraint: no index name in ${createIndex}`);
    return m[1]!;
};

const unlessWorkspaceSkConstraint = (createIndex: string): string => `DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${NODES_WORKSPACE_SK_INDEX}' AND conrelid = 'nodes'::regclass)
       AND to_regclass('${indexName(createIndex)}') IS NULL THEN
        ${createIndex};
    END IF;
END $$`;

/**
 * `nodes.sk` - the identity column the edge keys point at. Idempotent. `idx_nodes_sk` (database-wide unique) is
 * KEPT for old builds - created only until `UNIQUE (workspace_id, sk)` exists; the per-workspace invariant is
 * {@link workspaceSkIndexSpecs}, built by postgresWorkspaceSk.ts.
 */
export function nodesSurrogateKeyDdl(): string[] {
    return [
        'ALTER TABLE nodes ADD COLUMN IF NOT EXISTS sk BIGINT GENERATED BY DEFAULT AS IDENTITY',
        unlessWorkspaceSkConstraint('CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_sk ON nodes(sk)'),
    ];
}

/** The unique index on `nodes (workspace_id, sk)`; promoted to a constraint of the same name once valid. */
export const NODES_WORKSPACE_SK_INDEX = 'nodes_workspace_sk_key';
/** The workspace-led reverse-direction edge index. */
export const EDGES_WS_DST_SK_INDEX = 'idx_edges_ws_dst_sk';
/** Database-wide indexes the contract step ({@link dropGlobalSkIndexes}) removes. */
export const GLOBAL_SK_INDEXES = ['idx_nodes_sk', 'idx_edges_dst_sk'] as const;

export interface WorkspaceSkIndexSpec {
    readonly name: string;
    readonly table: 'nodes' | 'edges';
    readonly unique: boolean;
    /** Column list inside the parentheses. */
    readonly columns: string;
}

/** The two indexes the per-workspace `sk` invariant needs, in build order. */
export function workspaceSkIndexSpecs(): readonly WorkspaceSkIndexSpec[] {
    return [
        { name: NODES_WORKSPACE_SK_INDEX, table: 'nodes', unique: true, columns: 'workspace_id, sk' },
        { name: EDGES_WS_DST_SK_INDEX, table: 'edges', unique: false, columns: 'workspace_id, dst_sk' },
    ];
}

/** `CREATE [UNIQUE] INDEX [CONCURRENTLY] IF NOT EXISTS ...` for one spec. CONCURRENTLY cannot run in a transaction. */
export function workspaceSkIndexDdl(spec: WorkspaceSkIndexSpec, concurrently: boolean): string {
    return `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${spec.name} ON ${spec.table}(${spec.columns})`;
}

/** Fresh layout-2 table + its indexes, comments and layout stamp. Idempotent, safe to replay on every open. */
export function currentEdgeSchemaDdl(): string[] {
    return [
        edgeTableDdl('edges'),
        `DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'edges'::regclass AND contype = 'p') THEN
        ALTER TABLE edges ADD PRIMARY KEY (${EDGE_PRIMARY_KEY_COLUMNS});
    END IF;
END $$`,
        unlessWorkspaceSkConstraint('CREATE INDEX IF NOT EXISTS idx_edges_dst_sk ON edges(dst_sk)'),
        'CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(workspace_id, relation)',
        ...edgeReferenceCommentDdl(),
        edgeLayoutStampDdl('edges'),
    ];
}

/**
 * Declares, for the logical backup/restore lane (postgresBackupDiscovery.ts), that `src_sk` / `dst_sk`
 * hold `nodes.sk` values. Restoring into a non-empty database shifts `nodes.sk` (an identity column) to
 * stay clear of existing ids; the shift is applied to every column that references it, and discovery
 * finds those through a FOREIGN KEY or this comment syntax (`lore:references <table>.<column>`). The
 * statement only writes when the comment differs, so replaying it on every open takes no table lock.
 */
export function edgeReferenceCommentDdl(table: string = 'edges'): string[] {
    return ['src_sk', 'dst_sk'].map((col) => `DO $$
BEGIN
    IF col_description('${table}'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = '${col}'))
       IS DISTINCT FROM 'lore:references nodes.sk' THEN
        COMMENT ON COLUMN ${table}.${col} IS 'lore:references nodes.sk';
    END IF;
END $$`);
}

/** Stamps the layout on `table` (only writes when it differs). */
export function edgeLayoutStampDdl(table: string): string {
    return `DO $$
BEGIN
    IF obj_description('${table}'::regclass, 'pg_class') IS DISTINCT FROM '${LAYOUT_PREFIX}${EDGE_LAYOUT_VERSION}' THEN
        COMMENT ON TABLE ${table} IS '${LAYOUT_PREFIX}${EDGE_LAYOUT_VERSION}';
    END IF;
END $$`;
}

/** The layout stamped on `edges`: 0 = no table yet, 1 = legacy text-keyed (no stamp), n = stamped. */
export async function readEdgeLayout(client: Pick<PoolClient, 'query'>): Promise<number> {
    const res = await client.query<{ present: boolean; legacy: boolean; stamp: string | null }>(
        `SELECT to_regclass('edges') IS NOT NULL AS present,
                EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = current_schema() AND table_name = 'edges' AND column_name = 'source_id') AS legacy,
                obj_description(to_regclass('edges'), 'pg_class') AS stamp`,
    );
    const row = res.rows[0]!;
    if (!row.present) return 0;
    const m = row.stamp?.startsWith(LAYOUT_PREFIX) ? Number(row.stamp.slice(LAYOUT_PREFIX.length)) : NaN;
    if (Number.isInteger(m) && m >= 2) return m;
    return row.legacy ? 1 : EDGE_LAYOUT_VERSION; // an unstamped table without text endpoints is layout 2 built before the stamp
}

/** Refuses a database whose edge layout is newer than this engine understands. Throws with an upgrade instruction. */
export async function assertEdgeLayoutSupported(client: Pick<PoolClient, 'query'>): Promise<number> {
    const layout = await readEdgeLayout(client);
    if (layout > EDGE_LAYOUT_VERSION) {
        throw new Error(
            `postgres edges table uses layout ${layout}, but this Lore build only understands layout ${EDGE_LAYOUT_VERSION}. `
            + 'Refusing to open the database (writing with an older engine would corrupt edge keys). Upgrade Lore, or point it at a database created by this version.',
        );
    }
    return layout;
}

/* ── layout 1 (legacy, text-keyed): additive steps that run only while such a table exists ───────────── */

/** Adds the surrogate-key and provenance columns a layout-1 table may still lack, so the migration's SELECT can name them (idempotent). */
export function legacyEdgeColumnsDdl(): string[] {
    return [
        `ALTER TABLE edges
            ADD COLUMN IF NOT EXISTS src_sk BIGINT,
            ADD COLUMN IF NOT EXISTS dst_sk BIGINT,
            ADD COLUMN IF NOT EXISTS origin TEXT,
            ADD COLUMN IF NOT EXISTS policy_version TEXT,
            ADD COLUMN IF NOT EXISTS model_fingerprint TEXT,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`,
    ];
}

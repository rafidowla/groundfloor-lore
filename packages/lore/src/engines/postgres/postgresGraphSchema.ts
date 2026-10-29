/**
 * postgresGraphSchema.ts — Postgres engine: the graph DDL.
 *
 * NODES: mirrors `engines/sqlite/sqliteGraphSchema.ts` NODES_DDL exactly,
 * column FOR column in the same order, so `rowToLoreNode` (`engines/loreNodeRow.ts`)
 * and every later postgres read/write slice can be ported 1:1 from the
 * `sqlite/*` modules. The ONLY differences, by design (see below):
 *
 *   1. Every table leads with `workspace_id TEXT NOT NULL`, and the primary
 *      keys include it — one Postgres database holds many workspaces, keyed
 *      per row. EVERY query later slices issue filters `workspace_id = $1`;
 *      there is no DB-level multi-tenancy beyond this column (the placement
 *      directory is explicitly out of scope).
 *   2. Mixed-case column names are double-quoted. SQLite stores `createdAt`
 *      case-insensitively; Postgres would fold it to `createdat` unquoted,
 *      and the ported row mappers read the exact SQLite names.
 *   3. SQLite `REAL` -> `DOUBLE PRECISION` (both are 8-byte IEEE doubles; pg
 *      `REAL` would silently narrow confidenceScore/confirmation_score to
 *      4 bytes). `INTEGER` stays `INTEGER` (4-byte counters/flags/revision,
 *      same as the SQLite declared type).
 *   4. `id TEXT PRIMARY KEY` becomes a composite PK column (`id` inside the
 *      (workspace_id, id) key) — same uniqueness, same column set.
 *
 * `nodes.sk` is an identity column but is unique only PER WORKSPACE as far as the schema is concerned:
 * `UNIQUE (workspace_id, sk)` (postgresWorkspaceSk.ts) is the invariant, and every join from an edge to a node
 * names both columns. Do not write `ON s.sk = e.src_sk` without the workspace.
 *
 * Node indexes mirror SQLite's one-for-one, each prefixed with workspace_id so the
 * shared per-workspace queries can use them (including the hot
 * `(workspace_id, "updatedAt" DESC, id)` ordering that backs keyset paging).
 *
 * EDGES: no longer a mirror of the SQLite table. Postgres keys an edge by the
 * integer surrogate keys of its endpoints and stores no text ids - see
 * postgresEdgeSchema.ts (layout 2) and postgresEdgePkMigration.ts (in-place
 * conversion of the old text-keyed table). Public reads still return the same
 * text ids, in the same order, through a join on `nodes.sk`.
 */

import type { PoolClient } from 'pg';
import {
    assertEdgeLayoutSupported, currentEdgeSchemaDdl, nodesSurrogateKeyDdl, readEdgeLayout,
} from './postgresEdgeSchema.js';
import { migrateEdgesToSurrogatePk } from './postgresEdgePkMigration.js';
import { asOfSchemaDdl, backfillValidTimeColumns } from './postgresAsOfSchema.js';
import { ensureKeywordIndexes, type KeywordIndexEnsureResult } from './postgresKeywordIndex.js';
import { ensureWorkspaceSk } from './postgresWorkspaceSk.js';
import { ensureCreatedAtTs, ensurePartitionColumns, partitionKeySchemaDdl } from './postgresPartitionKeySchema.js';
import { LINK_OPTOUT_PG_DDL } from './postgresGraphLinkOptOut.js';

/**
 * The graph DDL for a FRESH database as a statement array: nodes table + its
 * indexes, then the edge-layout-2 table + its indexes (postgresEdgeSchema.ts).
 * Exported for replay scripts and contract tests to run the SAME statements
 * the engine runs — do not inline copies elsewhere. An existing layout-1
 * (text-keyed) edges table is NOT handled here: `ensureGraphSchema` migrates it.
 */
export function graphSchema_ddl(): string[] {
    return [NODES_DDL, ...nodesSurrogateKeyDdl(), ...currentEdgeSchemaDdl(), ...asOfSchemaDdl(), ...partitionKeySchemaDdl(), LINK_OPTOUT_PG_DDL];
}

/**
 * ensureGraphSchema — create the graph tables if absent (idempotent; safe to
 * run on every open). Tables are workspace-shared: `workspaceId` is validated
 * and then only documents intent — DDL itself is per-database, rows are
 * per-workspace.
 */
export async function ensureGraphSchema(
    client: PoolClient,
    workspaceId: string,
    opts: { keywordIndexInlineRowLimit?: number } = {},
): Promise<GraphSchemaResult> {
    if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
        throw new Error('ensureGraphSchema: workspaceId must be a non-empty string');
    }
    await assertEdgeLayoutSupported(client); // a newer layout than this build knows: refuse before touching anything
    await client.query(NODES_DDL);
    for (const ddl of nodesSurrogateKeyDdl()) await client.query(ddl);
    if ((await readEdgeLayout(client)) === 1) {
        // Text-keyed edges: convert in place (batched, resumable, swapped in one transaction).
        await migrateEdgesToSurrogatePk(client);
    }
    for (const ddl of currentEdgeSchemaDdl()) await client.query(ddl); // fresh DB: creates the table; migrated DB: no-ops
    for (const ddl of asOfSchemaDdl()) await client.query(ddl);
    await ensurePartitionColumns(client); // L3: partition_key (nodes, edges) + created_at_ts; catalog-probed, lock-free when present
    await client.query(LINK_OPTOUT_PG_DDL); // additive: durable link opt-out (postgresGraphLinkOptOut.ts)
    await backfillValidTimeColumns(client, workspaceId); // this workspace's legacy nodes: no-op once every text bound has its timestamp
    // L3: created_at_ts pending-rows index + legacy backfill: inline when small, `createdAtTsPending` (background) when large.
    const createdAt = await ensureCreatedAtTs(client, opts.keywordIndexInlineRowLimit === undefined ? {} : { inlineRowLimit: opts.keywordIndexInlineRowLimit });
    // Keyword-search indexes (postgresKeywordIndex.ts): inline for small tables; on a large one the
    // result says `pending` and the graph handle builds them in the background.
    const keyword = await ensureKeywordIndexes(client, opts.keywordIndexInlineRowLimit === undefined ? {} : { inlineRowLimit: opts.keywordIndexInlineRowLimit });
    // Per-workspace `sk` (postgresWorkspaceSk.ts): UNIQUE (workspace_id, sk) + the workspace-led edge index, inline
    // when small, `workspaceSkPending` when large (the graph handle then builds them in the background). The
    // lore_entity foreign key is added by the same step on the table-storage bootstrap, once that table exists.
    const sk = await ensureWorkspaceSk(client, opts.keywordIndexInlineRowLimit === undefined ? {} : { inlineRowLimit: opts.keywordIndexInlineRowLimit });
    return { ...keyword, workspaceSkPending: sk.pending, createdAtTsPending: createdAt.pending };
}

/** What the graph bootstrap leaves for the handle to finish in the background. */
export interface GraphSchemaResult extends KeywordIndexEnsureResult {
    /** Large table, workspace-led `sk` structures still missing: the caller should start the background build. */
    workspaceSkPending: boolean;
    /** Large table, legacy `created_at_ts` rows still to fill (and the pending index to build): background job. */
    createdAtTsPending: boolean;
}

/**
 * Column-for-column mirror of sqliteGraphSchema.ts NODES_DDL (see file header
 * for the four deliberate differences). `revision INTEGER NOT NULL DEFAULT 0`
 * is the CAS column the node-batch contract reads/writes.
 */
const NODES_DDL = `
CREATE TABLE IF NOT EXISTS nodes (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    project TEXT NOT NULL DEFAULT '*',
    ecosystem TEXT NOT NULL DEFAULT '*',
    metadata TEXT NOT NULL DEFAULT '{}',
    "createdAt" TEXT NOT NULL DEFAULT '',
    "updatedAt" TEXT NOT NULL DEFAULT '',
    syncedAt TEXT NOT NULL DEFAULT '',
    security_scopes TEXT NOT NULL DEFAULT '[]',
    language TEXT NOT NULL DEFAULT '',
    ephemeral INTEGER NOT NULL DEFAULT 0,
    ttl_ms INTEGER NOT NULL DEFAULT 0,
    stale INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    classification TEXT NOT NULL DEFAULT 'tactical',
    anchor_stale INTEGER NOT NULL DEFAULT 0,
    anchor_stale_since TEXT NOT NULL DEFAULT '',
    "validFrom" TEXT NOT NULL DEFAULT '',
    "validUntil" TEXT NOT NULL DEFAULT '',
    supersededBy TEXT NOT NULL DEFAULT '',
    supersededAt TEXT NOT NULL DEFAULT '',
    supersededReason TEXT NOT NULL DEFAULT '',
    lastAccessedAt TEXT NOT NULL DEFAULT '',
    last_retrieved_at TEXT NOT NULL DEFAULT '',
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    partial_count INTEGER NOT NULL DEFAULT 0,
    confirmation_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(workspace_id, type);
CREATE INDEX IF NOT EXISTS idx_nodes_updatedAt ON nodes(workspace_id, "updatedAt" DESC, id);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(workspace_id, project);
CREATE INDEX IF NOT EXISTS idx_nodes_ecosystem ON nodes(workspace_id, ecosystem);
CREATE INDEX IF NOT EXISTS idx_nodes_supersededBy ON nodes(workspace_id, supersededBy);
CREATE INDEX IF NOT EXISTS idx_nodes_validtime ON nodes(workspace_id, "validFrom", "validUntil");
-- Id-prefix lookups (the recall-time deferred-* scan): LIKE 'prefix%' can only use a btree under a non-C collation
-- with text_pattern_ops. The primary key (workspace_id, id) cannot serve it. Built once per database; on a very
-- large existing table the first open after upgrade holds a write lock for the build (seconds per million rows).
CREATE INDEX IF NOT EXISTS idx_nodes_id_prefix ON nodes(workspace_id, id text_pattern_ops);
`;

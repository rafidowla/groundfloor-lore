/**
 * postgresWorkspacePartitions.ts — the per-workspace partition provisioning
 * hook used by restore (and available to any future "create workspace" path).
 *
 * A table partitioned `BY LIST (workspace_id)` has one partition per
 * workspace. Restoring into a workspace that has no partition yet must create
 * it first, or the insert fails with "no partition of relation found for row".
 *
 * Contract:
 *   - HASH partitioning (fixed partitions) or a DEFAULT partition: nothing to do.
 *   - LIST on `workspace_id` alone: ensure a partition `FOR VALUES IN (<ws>)`
 *     exists. Existence is judged by the partition BOUND, not by name, so a
 *     partition another lane created under its own naming scheme is found and
 *     reused. Partitions created here are named
 *     `<parent>_ws_<12 hex of sha256(workspace_id)>`; indexes defined on the
 *     parent (e.g. the pgvector HNSW index) are created on it by Postgres.
 *   - Anything else (RANGE, multi-column key): refused loudly — there is no
 *     safe way to guess a bound.
 *
 * A caller that needs its own DDL (tablespace, per-partition index tuning)
 * passes `provision` in the restore options; it replaces the default for that
 * table.
 */

import * as crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { quoteIdent, quoteLiteral, WORKSPACE_COLUMN, type BackupTable } from './postgresBackupDiscovery.js';

/** Custom provisioner: make sure `table` can accept rows for `workspaceId`. */
export type PartitionProvisioner = (client: PoolClient, table: BackupTable, workspaceId: string) => Promise<void>;

interface PartInfo { partstrat: string; partnatts: number; keycol: string | null }

async function partitionInfo(client: PoolClient, qualified: string): Promise<PartInfo | null> {
    const res = await client.query<PartInfo>(
        `SELECT pt.partstrat::text AS partstrat, pt.partnatts::int AS partnatts,
                (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = pt.partrelid AND a.attnum = pt.partattrs[0]) AS keycol
           FROM pg_partitioned_table pt WHERE pt.partrelid = $1::regclass`,
        [qualified],
    );
    return res.rows[0] ?? null;
}

/**
 * ensureWorkspacePartition — default provisioner (see file header). Idempotent;
 * runs inside the caller's transaction, so a failed restore leaves no
 * stray partition behind.
 */
export async function ensureWorkspacePartition(client: PoolClient, table: BackupTable, workspaceId: string): Promise<void> {
    if (!table.partitioned) return;
    const info = await partitionInfo(client, table.qualified);
    if (!info) return;
    if (info.partstrat === 'h') return;
    if (info.partstrat !== 'l' || info.partnatts !== 1 || info.keycol !== WORKSPACE_COLUMN) {
        throw new Error(
            `partition provisioning: ${table.name} is partitioned in a way Lore cannot provision per workspace `
            + `(strategy ${info.partstrat}, key ${info.keycol ?? '?'}). Provide a custom provisioner or pre-create the partition.`,
        );
    }
    const expected = `FOR VALUES IN (${quoteLiteral(workspaceId)})`;
    const existing = await client.query(
        `SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = $1::regclass AND pg_get_expr(c.relpartbound, c.oid) = $2`,
        [table.qualified, expected],
    );
    if ((existing.rowCount ?? 0) > 0) return;
    const suffix = crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0, 12);
    const partName = `${table.name.slice(0, 40)}_ws_${suffix}`;
    const schemaPrefix = table.qualified.slice(0, table.qualified.length - quoteIdent(table.name).length);
    await client.query(`CREATE TABLE IF NOT EXISTS ${schemaPrefix}${quoteIdent(partName)} PARTITION OF ${table.qualified} ${expected}`);
}

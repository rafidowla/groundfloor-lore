/**
 * postgresVerbatimPartitionMigration.ts — convert a pre-partitioning
 * `verbatim` (ONE plain table, one HNSW index for every workspace) into the
 * LIST-partitioned-by-workspace layout, in place.
 *
 * Runs inside runSchemaBootstrap's advisory lock (one migrator at a time;
 * other Lore processes opening the database wait on that lock, then find the
 * partitioned table). Live writers and readers on OTHER, already-open
 * connections keep using the old table until the final swap.
 *
 * PHASES (every phase is idempotent; a crash anywhere resumes at the right one)
 *
 *   1. STAGE   create `verbatim_next` (partitioned, same columns, indexes named
 *              `verbatim_next_*` so names do not collide with the live table's),
 *              the shared `verbatim_row_seq`, a one-row progress table, and one
 *              partition per workspace found in the old table.
 *   2. COPY    ascending `row_id` batches of BATCH_SIZE, ONE TRANSACTION PER
 *              BATCH: insert the batch (tuples route to their workspace
 *              partition; `row_id` and `text_tsv` are copied verbatim, the
 *              tsvector trigger is not attached yet so nothing is recomputed)
 *              and advance the high-water mark in `verbatim_partition_progress`
 *              in the same transaction. Killing the process loses at most the
 *              batch in flight; the next run continues from the stored mark
 *              (`ON CONFLICT DO NOTHING` also makes a re-copied batch harmless).
 *   3. SWAP    ONE transaction: ACCESS EXCLUSIVE lock on the old table (writers
 *              and readers wait; bounded by lock_timeout 60 s, after which the
 *              attempt fails loudly and the next open retries only this phase),
 *              then a CATCH-UP pass for whatever live writers did during the
 *              copy (rows deleted, rows whose flags changed, rows inserted
 *              behind the high-water mark, workspaces that appeared), a row-count
 *              equality check that aborts the swap on any mismatch, the
 *              sequence advance, the tsvector trigger, and the renames:
 *                verbatim            -> verbatim_pre_partition (+ its indexes
 *                                       renamed `*_pre_partition`)
 *                verbatim_next       -> verbatim   (+ indexes -> canonical names)
 *   4. KEEP    the old table is NOT dropped — it is the rollback. After the
 *              operator has verified the new layout:
 *                DROP TABLE verbatim_pre_partition;   (or dropPrePartitionVerbatim)
 *              it costs only disk; nothing reads or writes it.
 *
 * CATCH-UP INVARIANT: this engine never UPDATEs a row's `text`, `vector` or
 * `text_tsv` in place — a changed document is a NEW row (upsertCanonical /
 * replaceCanonical insert a fresh row_id) and the only in-place UPDATEs touch
 * flag/timestamp columns (is_canonical, superseded_at, "updatedAt"). The
 * catch-up therefore compares every column except those three bulky ones.
 *
 * LIMITS: the copy needs room for a second copy of the table until the old
 * one is dropped; the swap holds a table lock for the catch-up scan (seconds
 * for a million rows); `statement_timeout` is raised for the swap transaction
 * only (pool default is 30 s).
 */

import type { PoolClient } from 'pg';

import { log } from '../../logger.js';
import {
    VERBATIM_COLUMNS, VERBATIM_INDEX_NAMES, TEXT_TSV_FUNCTION_DDL, partitionedVerbatimDdl, ensureWorkspacePartition,
} from './postgresVerbatimPartitionDdl.js';

const BATCH_SIZE = 2_000;
const COLS = VERBATIM_COLUMNS.join(', ');
const O_COLS = VERBATIM_COLUMNS.map((c) => `o.${c}`).join(', ');
/** Columns catch-up compares/updates (see CATCH-UP INVARIANT): everything except the key and the three bulky immutable ones. */
const SCALAR_COLS = VERBATIM_COLUMNS.filter((c) => !['row_id', 'workspace_id', 'text', 'vector', 'text_tsv'].includes(c));

export interface PartitionMigrationOptions {
    /** Rows per copy transaction (default 2000). */
    batchSize?: number;
    /** Test seam: stop (return 'paused') after this many copy batches, as a crash would. */
    maxBatches?: number;
    /** Test seam: runs between the last copy batch and the swap (simulates live writers). */
    beforeSwap?: (client: PoolClient) => Promise<void>;
}

/** Workspaces present in a table, via a loose index scan (no full-table DISTINCT). */
async function workspacesOf(client: PoolClient, table: string): Promise<string[]> {
    const res = await client.query<{ ws: string }>(
        `WITH RECURSIVE w AS (
             SELECT min(workspace_id) AS ws FROM ${table}
             UNION ALL
             SELECT (SELECT min(workspace_id) FROM ${table} WHERE workspace_id > w.ws) FROM w WHERE w.ws IS NOT NULL
         ) SELECT ws FROM w WHERE ws IS NOT NULL`,
    );
    return res.rows.map((r) => r.ws);
}

/** @returns 'migrated' once the swap committed, 'paused' only when `maxBatches` (a test seam) stopped the copy. */
export async function migrateVerbatimToPartitioned(
    client: PoolClient, dimension: number, opts: PartitionMigrationOptions = {},
): Promise<'migrated' | 'paused'> {
    const batchSize = opts.batchSize ?? BATCH_SIZE;
    if ((await client.query(`SELECT to_regclass('verbatim_pre_partition') AS t`)).rows[0]?.t) {
        throw new Error('verbatim partition migration: verbatim_pre_partition already exists — drop or rename it first (refusing to overwrite a rollback copy)');
    }

    // 1. STAGE
    for (const stmt of partitionedVerbatimDdl(dimension, 'verbatim_next', 'verbatim_next')) await client.query(stmt);
    await client.query(`CREATE TABLE IF NOT EXISTS verbatim_partition_progress (id INTEGER PRIMARY KEY CHECK (id = 1), hwm BIGINT NOT NULL)`);
    await client.query(`INSERT INTO verbatim_partition_progress (id, hwm) VALUES (1, 0) ON CONFLICT DO NOTHING`);
    for (const ws of await workspacesOf(client, 'verbatim')) await ensureWorkspacePartition(client, ws, 'verbatim_next');

    // 2. COPY
    let batches = 0;
    let copied = 0;
    for (;;) {
        if (opts.maxBatches !== undefined && batches >= opts.maxBatches) return 'paused';
        await client.query('BEGIN');
        try {
            const hwmRow = await client.query<{ hwm: string }>(`SELECT hwm FROM verbatim_partition_progress WHERE id = 1 FOR UPDATE`);
            const hwm = hwmRow.rows[0]!.hwm;
            const res = await client.query<{ n: number; last: string | null }>(
                `WITH b AS (SELECT ${COLS} FROM verbatim WHERE row_id > $1 ORDER BY row_id LIMIT $2),
                      ins AS (INSERT INTO verbatim_next (${COLS}) SELECT ${COLS} FROM b ON CONFLICT DO NOTHING)
                 SELECT count(*)::int AS n, max(row_id) AS last FROM b`,
                [hwm, batchSize],
            );
            const n = res.rows[0]!.n;
            if (n > 0) await client.query(`UPDATE verbatim_partition_progress SET hwm = $1 WHERE id = 1`, [res.rows[0]!.last]);
            await client.query('COMMIT');
            if (n === 0) break;
            batches++;
            copied += n;
            if (batches % 50 === 0) log.info(`[verbatim-partition-migration] copied ${copied} rows (hwm ${res.rows[0]!.last})`);
        } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        }
    }
    if (opts.beforeSwap) await opts.beforeSwap(client);

    // 3. SWAP
    await swap(client);
    log.info(`[verbatim-partition-migration] done: ${copied} rows copied this run; old table kept as verbatim_pre_partition (DROP TABLE it after verifying)`);
    return 'migrated';
}

async function swap(client: PoolClient): Promise<void> {
    await client.query(TEXT_TSV_FUNCTION_DDL); // lock-free (function only)
    await client.query('BEGIN');
    try {
        await client.query(`SET LOCAL lock_timeout = '60s'`);
        await client.query(`SET LOCAL statement_timeout = '900s'`);
        await client.query(`LOCK TABLE verbatim IN ACCESS EXCLUSIVE MODE`);

        // CATCH-UP (see the header's invariant).
        for (const ws of await workspacesOf(client, 'verbatim')) await ensureWorkspacePartition(client, ws, 'verbatim_next');
        await client.query(
            `DELETE FROM verbatim_next n WHERE NOT EXISTS (SELECT 1 FROM verbatim o WHERE o.workspace_id = n.workspace_id AND o.row_id = n.row_id)`,
        );
        const changed = SCALAR_COLS.map((c) => `o.${c} IS DISTINCT FROM n.${c}`).join(' OR ');
        await client.query(
            `UPDATE verbatim_next n SET ${SCALAR_COLS.map((c) => `${c} = o.${c}`).join(', ')}
               FROM verbatim o WHERE o.workspace_id = n.workspace_id AND o.row_id = n.row_id AND (${changed})`,
        );
        await client.query(
            `INSERT INTO verbatim_next (${COLS}) SELECT ${O_COLS} FROM verbatim o
              WHERE NOT EXISTS (SELECT 1 FROM verbatim_next n WHERE n.workspace_id = o.workspace_id AND n.row_id = o.row_id)`,
        );
        const counts = await client.query<{ o: string; n: string }>(
            `SELECT (SELECT count(*) FROM verbatim) AS o, (SELECT count(*) FROM verbatim_next) AS n`,
        );
        if (counts.rows[0]!.o !== counts.rows[0]!.n) {
            throw new Error(
                `verbatim partition migration: row count mismatch after catch-up (old ${counts.rows[0]!.o}, new ${counts.rows[0]!.n}) — swap aborted, nothing changed`,
            );
        }

        await client.query(`SELECT setval('verbatim_row_seq', GREATEST((SELECT coalesce(max(row_id), 0) FROM verbatim_next), 1))`);
        await client.query(
            `CREATE TRIGGER verbatim_text_tsv_biur BEFORE INSERT OR UPDATE ON verbatim_next FOR EACH ROW EXECUTE FUNCTION verbatim_text_tsv_apply()`,
        );
        // Rename old indexes out of the way, then the tables, then the new indexes into the canonical names.
        for (const idx of VERBATIM_INDEX_NAMES) await client.query(`ALTER INDEX IF EXISTS ${idx} RENAME TO ${idx}_pre_partition`);
        await client.query(`ALTER TABLE verbatim RENAME TO verbatim_pre_partition`);
        await client.query(`ALTER TABLE verbatim_next RENAME TO verbatim`);
        for (const idx of VERBATIM_INDEX_NAMES) await client.query(`ALTER INDEX ${idx.replace('verbatim_', 'verbatim_next_')} RENAME TO ${idx}`);
        await client.query(`DROP TABLE verbatim_partition_progress`);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    }
}

/** Ops helper: drop the rollback copy left by a finished migration. Returns false when there is none. */
export async function dropPrePartitionVerbatim(client: PoolClient): Promise<boolean> {
    const has = await client.query(`SELECT to_regclass('verbatim_pre_partition') AS t`);
    if (!has.rows[0]?.t) return false;
    await client.query(`DROP TABLE verbatim_pre_partition`);
    return true;
}

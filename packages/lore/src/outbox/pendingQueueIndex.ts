/**
 * 3.38.3 — partial index for the replicator's "next batch" read.
 *
 * `listPendingForWorkspace` filters `workspace = ? AND status IN ('pending', 'failed')` ordered by
 * `sequenceId`. Its only usable index was `idx_outbox_workspace_seq (workspace, sequenceId)`, so
 * every batch walked past every replicated row still kept for pruning (7 days by default) before
 * reaching the first pending one: ~40 ms per 100-row batch with 79k replicated rows at 125k nodes,
 * growing linearly with the retained history.
 *
 * `idx_outbox_pending_ws_seq` covers only the rows still to do. SQLite uses a partial index only
 * when the query's WHERE contains the index's WHERE term, so both are rendered from
 * `PENDING_STATUS_TERM`. Test: test/outbox-pending-queue-index-unit.ts
 * asserts the plan.
 */
import { log } from '../logger.js';

export const PENDING_STATUS_TERM = `status IN ('pending', 'failed')`;

export const PENDING_QUEUE_INDEX_SQL =
    `CREATE INDEX IF NOT EXISTS idx_outbox_pending_ws_seq ON outbox_entries(workspace, sequenceId) WHERE ${PENDING_STATUS_TERM}`;

/**
 * SP-21: 'failed' rows whose nextAttemptAt is in the future are excluded. julianday() on both
 * sides — ISO 'T' timestamps compare wrong as raw strings against SQLite's space format, and
 * datetime() truncates the sub-second first backoff step (retryBaseMs = 500 ms).
 */
export const LIST_PENDING_FOR_WORKSPACE_SQL = `SELECT * FROM outbox_entries
             WHERE workspace = ? AND ${PENDING_STATUS_TERM}
               AND (nextAttemptAt IS NULL OR julianday(nextAttemptAt) <= julianday('now'))
             ORDER BY sequenceId ASC
             LIMIT ?`;

/** Create the pending-queue index. Never throws: on failure the batch read still works, it just walks more rows. */
export function ensurePendingQueueIndex(db: { exec(sql: string): unknown }): boolean {
    try {
        db.exec(PENDING_QUEUE_INDEX_SQL);
        return true;
    } catch (err) {
        log.warn(`[outbox] could not create the pending-queue index (${(err as Error).message}); batch reads will scan replicated rows`);
        return false;
    }
}

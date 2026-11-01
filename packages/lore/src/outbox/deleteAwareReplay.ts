/**
 * outbox/deleteAwareReplay.ts — 3.34.0 (slice 2): a stale UPSERT must not resurrect a node (or edge,
 * or verbatim text) that a LATER delete already removed.
 *
 * RA-6 (`replicator.isSupersededFailed`) covers only a `failed` row with a newer `replicated` row.
 * That misses the common interleaving: upsert (seq 1, still pending or failed) -> delete (seq 2,
 * pending, replicating or replicated). Replaying seq 1 recreates what seq 2 removed. The rule here
 * is the missing half and applies to an upsert row in ANY status:
 *
 *     upsert(seq N) is skipped (dead, SUPERSEDED_DEAD_ERROR) when the same entity has a delete row
 *     with sequenceId > N whose status is pending / replicating / replicated.
 *
 * A `failed` or `dead` delete does NOT supersede: it may never apply, so the upsert stays. A later
 * re-create (upsert seq 3) is untouched; only seq 1 is skipped, so the final state is still seq 3.
 *
 * It lives in the shared outbox layer, so every lane (the SQLite hot lane and the arcade lane, which
 * share OutboxReplicator and one OutboxStore) gets it. Stores that cannot answer (the file store has
 * no guard methods) fail open: the replay proceeds exactly as before.
 */
import { log } from '../logger.js';
import { keyOfEntry, supersessionFamilySql, type EntityFamily } from './supersession.js';
import type { OutboxEntry } from './types.js';

const UPSERT_KINDS: ReadonlySet<string> = new Set(['node.upsert', 'edge.upsert', 'verbatim.upsert']);
const DELETE_KINDS: Record<EntityFamily, string> = {
    node: "('node.delete')",
    edge: "('edge.delete')",
    verbatim: "('verbatim.tombstone', 'verbatim.purge')",
};

/**
 * 3.38.3 — one partial index per family, holding only that family's delete rows.
 *
 * Without it `sqliteHasNewerDeleteForKey` can only use `idx_outbox_workspace_seq`, so each check
 * walks every later row of the workspace (O(n) per queued upsert, O(n^2) to drain a bulk import:
 * a 125k-node ingest left ~60k rows pending and blocked recall for seconds per call). Upserts never
 * enter these indexes, so the write path pays nothing.
 *
 * The WHERE clause must be textually the same `operationKind IN ...` term the lookup uses, or
 * SQLite will not pick a partial index (one combined index over all delete kinds is ignored), so
 * both are built from DELETE_KINDS. Test: test/outbox-delete-kind-index-unit.ts asserts the plan.
 */
export const DELETE_KIND_INDEX_SQL: Record<EntityFamily, string> = {
    node: `CREATE INDEX IF NOT EXISTS idx_outbox_delete_node ON outbox_entries(workspace, sequenceId) WHERE operationKind IN ${DELETE_KINDS.node}`,
    edge: `CREATE INDEX IF NOT EXISTS idx_outbox_delete_edge ON outbox_entries(workspace, sequenceId) WHERE operationKind IN ${DELETE_KINDS.edge}`,
    verbatim: `CREATE INDEX IF NOT EXISTS idx_outbox_delete_verbatim ON outbox_entries(workspace, sequenceId) WHERE operationKind IN ${DELETE_KINDS.verbatim}`,
};

/** Create the delete-kind indexes. Never throws: on failure the lookup still works, it just scans. */
export function ensureDeleteKindIndexes(db: { exec(sql: string): unknown }): boolean {
    let ok = true;
    for (const [family, sql] of Object.entries(DELETE_KIND_INDEX_SQL)) {
        try {
            db.exec(sql);
        } catch (err) {
            ok = false;
            log.warn(`[outbox] could not create the ${family} delete-kind index (${(err as Error).message}); delete-supersede checks will scan`);
        }
    }
    return ok;
}

/** SQL side (SqliteOutboxStore.hasNewerDeleteForKey delegates here). */
export function sqliteHasNewerDeleteForKey(
    db: { prepare(sql: string): { get(...p: unknown[]): unknown } },
    workspace: string,
    family: EntityFamily,
    key: string,
    sequenceId: number,
): boolean {
    const fam = supersessionFamilySql(family);
    const r = db.prepare(hasNewerDeleteSql(family))
        .get(workspace, sequenceId, ...Array<string>(fam.match.binds).fill(key));
    return r !== undefined;
}

/** The lookup's SQL (exported so the index test can EXPLAIN the exact query). Binds: workspace, seq, key x N. */
export function hasNewerDeleteSql(family: EntityFamily): string {
    return `SELECT 1 AS hit FROM outbox_entries
         WHERE workspace = ? AND status IN ('pending', 'replicating', 'replicated')
           AND operationKind IN ${DELETE_KINDS[family]} AND sequenceId > ? AND ${supersessionFamilySql(family).match.sql}
         LIMIT 1`;
}

/** Number of key binds the family's lookup takes after workspace and seq. */
export function hasNewerDeleteKeyBinds(family: EntityFamily): number {
    return supersessionFamilySql(family).match.binds;
}

/** Replicator side: true when `entry` is an upsert that a later delete supersedes. Never throws. */
export async function isSupersededByLaterDelete(
    store: object,
    entry: OutboxEntry,
    log: (m: string) => void,
): Promise<boolean> {
    const fn = (store as { hasNewerDeleteForKey?: (ws: string, f: EntityFamily, key: string, seq: number) => Promise<boolean> }).hasNewerDeleteForKey;
    const identity = keyOfEntry(entry);
    if (typeof fn !== 'function' || !UPSERT_KINDS.has(entry.operationKind ?? '') || identity === null
        || typeof entry.sequenceId !== 'number' || !entry.workspace) return false;
    try {
        return await fn.call(store, entry.workspace, identity.family, identity.key, entry.sequenceId);
    } catch (err) {
        log(`[outbox replicator] delete-supersede check threw for ${entry.id} (non-fatal): ${(err as Error).message}`);
        return false;
    }
}

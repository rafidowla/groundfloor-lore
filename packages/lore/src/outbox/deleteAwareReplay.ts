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
import { keyOfEntry, supersessionFamilySql, type EntityFamily } from './supersession.js';
import type { OutboxEntry } from './types.js';

const UPSERT_KINDS: ReadonlySet<string> = new Set(['node.upsert', 'edge.upsert', 'verbatim.upsert']);
const DELETE_KINDS: Record<EntityFamily, string> = {
    node: "('node.delete')",
    edge: "('edge.delete')",
    verbatim: "('verbatim.tombstone', 'verbatim.purge')",
};

/** SQL side (SqliteOutboxStore.hasNewerDeleteForKey delegates here). */
export function sqliteHasNewerDeleteForKey(
    db: { prepare(sql: string): { get(...p: unknown[]): unknown } },
    workspace: string,
    family: EntityFamily,
    key: string,
    sequenceId: number,
): boolean {
    const fam = supersessionFamilySql(family);
    const r = db.prepare(
        `SELECT 1 AS hit FROM outbox_entries
         WHERE workspace = ? AND status IN ('pending', 'replicating', 'replicated')
           AND operationKind IN ${DELETE_KINDS[family]} AND sequenceId > ? AND ${fam.match.sql}
         LIMIT 1`,
    ).get(workspace, sequenceId, ...Array<string>(fam.match.binds).fill(key));
    return r !== undefined;
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

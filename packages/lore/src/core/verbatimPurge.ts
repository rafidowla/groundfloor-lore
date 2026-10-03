/**
 * verbatimPurge.ts — physical removal of a node's verbatim rows (3.27.0).
 *
 * Shared by the inline `nodeDelete({ purge: true })` path (nodeDeleteService)
 * and the `verbatim.purge` outbox replay (outbox/wiring.ts), so both converge
 * to the same state: the ids AND their `#rev<ts>` history rows are gone and no
 * embedding call was made.
 *
 * Store capability ladder (never throws where the tombstone path would not):
 *   1. `purgeWithHistory(ids)` — ids + history (LanceDB, SQLite),
 *   2. `physicalDeleteMany(ids)` — exact ids only (cloud/Dataplane: history
 *      rows are separate rows and stay, as for the orphan-cascade delete),
 *   3. `physicalDelete(id)` per id,
 *   4. `tombstone(id, reason)` per id as a last resort (history stays and a
 *      marker row is written), reported through the returned `mode`.
 */
export interface PurgeCapableStore {
    purgeWithHistory?: (ids: string[]) => Promise<number>;
    physicalDeleteMany?: (ids: string[]) => Promise<number>;
    physicalDelete?: (id: string) => Promise<void>;
    tombstone?: (id: string, reason: string) => Promise<void>;
}

export type PurgeMode = 'purgeWithHistory' | 'physicalDeleteMany' | 'physicalDelete' | 'tombstone' | 'none';

export async function purgeVerbatimRows(store: PurgeCapableStore, ids: string[], reason: string): Promise<PurgeMode> {
    if (ids.length === 0) return 'none';
    if (typeof store.purgeWithHistory === 'function') {
        await store.purgeWithHistory(ids);
        return 'purgeWithHistory';
    }
    if (typeof store.physicalDeleteMany === 'function') {
        await store.physicalDeleteMany(ids);
        return 'physicalDeleteMany';
    }
    if (typeof store.physicalDelete === 'function') {
        for (const id of ids) await store.physicalDelete(id);
        return 'physicalDelete';
    }
    if (typeof store.tombstone === 'function') {
        for (const id of ids) await store.tombstone(id, reason);
        return 'tombstone';
    }
    return 'none';
}

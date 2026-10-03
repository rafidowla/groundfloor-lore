/**
 * dataplaneVerbatimDelete.ts — the hard-delete half of the cloud verbatim store (review C #8).
 *
 * Local parity: `VerbatimStore.delete(id)` is a TOMBSTONE (it calls tombstone with the reason below)
 * and `physicalDelete(id)` / `physicalDeleteMany(ids)` are the hard deletes the orphan sweeper and the
 * half-completion reaper use. A hard delete removes exactly the canonical rows named; their
 * `<id>#rev<ts>` snapshots are separate rows and stay (local `DELETE … WHERE id = ?` is the same).
 */
import { buildDataplaneScopeFilter, type DataplaneScope } from './dataplaneScopeFilter.js';
import type { ScopedBulkClient } from './dataplaneScopedIo.js';

/** The reason local `delete()` records on the tombstone it writes. */
export const LEGACY_DELETE_REASON = 'legacy verbatim.delete() call (no reason supplied)';

const DELETE_CHUNK = 100;

/** Hard-delete the canonical rows `ids` in (org, Lore workspace) scope, chunked. Returns the ids processed. */
export async function physicalDeleteRows(
    client: Pick<ScopedBulkClient, 'deleteByQuery'>,
    scope: DataplaneScope,
    collection: string,
    connection: string | undefined,
    ids: readonly string[],
): Promise<number> {
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const filter = buildDataplaneScopeFilter(scope, { loreId: ids.slice(i, i + DELETE_CHUNK) }, 'crud', 0).server as object;
        await client.deleteByQuery(scope.dataplaneWorkspaceId, collection, filter, connection);
    }
    return ids.length;
}

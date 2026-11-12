/**
 * purgeFence.ts — "was this node purged since I read it?" for writers that RESTORE a snapshot
 * taken before their own write (today: bulkIngest's cancel-restore, mcp/bulkIngestCancel.ts, and
 * rollback_changeset's previous_state restore, MCP + HTTP).
 *
 * Why: such a restore is create-if-absent (`nodeUpsert`) fed with a pre-read. A
 * `nodeDelete({ purge: true })` landing anywhere between that pre-read and the restore — before
 * the bulk write (the bulk write then re-creates the id, legitimately) or after it — would
 * otherwise have the restore write the ERASED content back. The pre-read cannot be moved under
 * the node lock (the restore is a separate, later lock acquisition), so the purge leaves a mark
 * here instead and the restore checks it under the lock (`NodeUpsertHooks.purgeFence`).
 *
 * Memory stays bounded: marks are only kept while at least one fence is open, and the table is
 * cleared when the last one closes. A fence only cares about purges after it opened, so dropping
 * older marks loses nothing. Process-local, like the node lock it pairs with.
 */
import { nodeLockKey } from './nodeWriteLock.js';

let epoch = 0;
let openFences = 0;
const purgedAt = new Map<string, number>();

export interface PurgeFence {
    /** True when `(workspace, id)` was purged after this fence opened. */
    purgedSince(workspace: string, id: string): boolean;
    /** Idempotent. Every opened fence MUST be closed (use try/finally). */
    close(): void;
}

export function openPurgeFence(): PurgeFence {
    const openedAt = epoch;
    openFences++;
    let closed = false;
    return {
        purgedSince: (workspace, id) => (purgedAt.get(nodeLockKey(workspace, id)) ?? -1) > openedAt,
        close: () => {
            if (closed) return;
            closed = true;
            openFences--;
            if (openFences === 0) purgedAt.clear();
        },
    };
}

/** Called by the purge paths, under the node lock, before they report success. */
export function notePurged(workspace: string, ids: readonly string[]): void {
    if (openFences === 0) return;
    const at = ++epoch;
    for (const id of ids) purgedAt.set(nodeLockKey(workspace, id), at);
}

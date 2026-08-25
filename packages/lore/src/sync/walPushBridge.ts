/**
 * walPushBridge.ts — Convert WAL entries into CloudSyncClient push
 * changes and execute the push.
 *
 * Per AUTH_AND_SYNC_DESIGN.md: local edits queue in the WAL; the sync
 * engine periodically pushes accumulated changes to cloud. Cloud
 * re-validates ReBAC + replays each op into its own storage. Cloud is
 * authoritative for who-sees-what, so a push that fails the
 * permission check is a rejected change, not an error in our code.
 *
 * This module ships two primitives:
 *
 *   walEntryToSyncPushChange(entry, workspaceId)
 *     Pure converter. Wraps a WAL `{op, data, timestamp, entryId}`
 *     into a SyncPushChange `{id, workspaceId, op, payload,
 *     capturedAt}`. No I/O. Testable.
 *
 *   pushWalEntries(client, workspaceId, entries)
 *     Higher-level — converts a batch + calls client.pushChanges.
 *     Returns the SyncPushResult so the caller can decide what to do
 *     with the accepted vs rejected ids (advance the WAL cursor for
 *     accepted; retry rejected on next tick).
 *
 * What's deliberately NOT here (separate follow-up PR):
 *   - WAL cursor management (track last-acked entryId per workspace)
 *   - Hooking the poller to actually fan out push per workspace
 *   - Permission-aware pre-filtering (don't even attempt push when
 *     the user lacks `write`; just leave the WAL pending)
 *
 * Why split it that way: the converter + push call are tiny and
 * pure. The cursor / poller wiring touches existing files
 * (syncEngine.ts, services.ts) and warrants its own review.
 */

import type {
    CloudSyncClient,
    SyncPushChange,
    SyncPushResult,
} from './cloudSyncClient.js';
import type { WalEntry } from '../engines/syncEngine.js';

/**
 * Convert a WAL entry into a SyncPushChange envelope cloud accepts.
 * Pure — no I/O.
 */
export function walEntryToSyncPushChange(
    entry: WalEntry,
    workspaceId: string,
): SyncPushChange {
    return {
        id: entry.entryId,
        workspaceId,
        op: entry.op,
        payload: entry.data,
        capturedAt: entry.timestamp,
    };
}

/**
 * Push a batch of WAL entries for one workspace through CloudSyncClient.
 * Returns the SyncPushResult; caller maps accepted ids → advance WAL
 * cursor, rejected ids → retry-on-next-tick (or surface to operator).
 *
 * Empty input → empty result; no network call.
 */
export async function pushWalEntries(
    client: CloudSyncClient,
    workspaceId: string,
    entries: ReadonlyArray<WalEntry>,
): Promise<SyncPushResult> {
    if (entries.length === 0) {
        return { accepted: [], rejected: [] };
    }
    const changes = entries.map((e) => walEntryToSyncPushChange(e, workspaceId));
    return await client.pushChanges(workspaceId, changes);
}

/**
 * Convenience: split a SyncPushResult into "WAL cursor can advance
 * past these" vs "retry these next tick." Pure.
 *
 * Useful for callers that own the WAL cursor — they pass the result
 * here, get back the two id sets, and update the cursor (or retry
 * queue) accordingly without duplicating the partition logic.
 */
export function partitionPushResult(result: SyncPushResult): {
    advancePastIds: ReadonlyArray<string>;
    retryIds: ReadonlyArray<string>;
    rejectionsByReason: ReadonlyArray<{ reason: string; ids: string[] }>;
} {
    const grouped = new Map<string, string[]>();
    for (const r of result.rejected) {
        const list = grouped.get(r.reason) ?? [];
        list.push(r.id);
        grouped.set(r.reason, list);
    }
    return {
        advancePastIds: result.accepted,
        retryIds: result.rejected.map((r) => r.id),
        rejectionsByReason: Array.from(grouped.entries()).map(([reason, ids]) => ({ reason, ids })),
    };
}

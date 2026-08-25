/**
 * noCloudSyncClient.ts — No-op CloudSyncClient.
 *
 * Selected when LORE_CLOUD_URL is unset (today's local-only install
 * baseline). All methods return safe-degenerate values:
 *   listMyWorkspaces  → []
 *   pullWorkspaceSnapshot → null   (caller leaves local copy alone)
 *   pushChanges       → all rejected (caller treats as transient;
 *                       WAL stays intact)
 *   isReachable       → true        (we never fail because we never
 *                       call anything; the polling loop treats this
 *                       as "no work to do" rather than "cloud down")
 *
 * Returning [] from listMyWorkspaces would, naively, cause the
 * reconciler to delete every local workspace. Guard: callers must
 * check `isCloudConfigured` (services.ts decides) before calling
 * the reconcile path. The no-op client here is explicitly only safe
 * for callers that want to gracefully no-op when cloud isn't
 * configured.
 */

import type {
    CloudSyncClient,
    SyncSnapshot,
    SyncPushChange,
    SyncPushResult,
    SyncedWorkspace,
} from './cloudSyncClient.js';

export class NoCloudSyncClient implements CloudSyncClient {
    async listMyWorkspaces(): Promise<SyncedWorkspace[]> {
        return [];
    }

    async pullWorkspaceSnapshot(_workspaceId: string, _version: string): Promise<SyncSnapshot | null> {
        return null;
    }

    async pushChanges(_workspaceId: string, changes: SyncPushChange[]): Promise<SyncPushResult> {
        return {
            accepted: [],
            rejected: changes.map((c) => ({
                id: c.id,
                reason: 'no_cloud_configured: LORE_CLOUD_URL is unset; running local-only',
            })),
        };
    }

    async isReachable(): Promise<boolean> {
        // We never fail because we never call. The polling loop reads
        // this as "nothing to do" rather than "down."
        return true;
    }
}

/**
 * cloudSyncClient.ts — Interface for Lore's cloud-sync target.
 *
 * Per AUTH_AND_SYNC_DESIGN.md (2026-05-10), local Lore is a *cached
 * client* of cloud Lore: it pulls only the workspaces the user is
 * authorized to see, pushes WAL changes only when the user has write
 * permission on a workspace, and reconciles when sharing changes
 * (revocation propagates from cloud → local). v1 is poll-based with
 * last-write-wins; websockets + delta sync upgrade later.
 *
 * This module declares the interface only. Two implementations:
 *
 *   `NoCloudSyncClient` — silent no-op for the local-only case
 *   (`LORE_CLOUD_URL` unset). Returns the operator's own workspaces
 *   list from local disk; push is a no-op; revocations never fire.
 *
 *   `HttpSyncClient` — talks to a Lore Cloud HTTP API at the URL
 *   given in `LORE_CLOUD_URL`. Wire shape is documented inline at
 *   each method so the cloud-side handler can match.
 *
 * Selection happens in services.ts at boot: when `LORE_CLOUD_URL` is
 * unset, the No-op is used and Lore behaves exactly like today
 * (single user, local-only). When set, the HTTP client takes over.
 *
 * The interface is designed so route handlers and the periodic
 * polling loop are mode-agnostic — they call `syncClient.foo()` and
 * the right thing happens (or nothing happens, gracefully).
 */

/**
 * One workspace as the cloud knows it. Local Lore mirrors this list
 * to decide which `<LORE_HOME>/workspaces/<id>/` directories should
 * exist locally.
 */
export interface SyncedWorkspace {
    /** Stable workspace id (= portal_workspace.id). UUID-keyed in cloud. */
    workspaceId: string;
    /** Operator-facing display name; cloud is authoritative. */
    displayName: string;
    /** Account / tenant the workspace belongs to. */
    accountId: string;
    /** Permissions the current user holds on this workspace. */
    permissions: ReadonlyArray<'administer' | 'read' | 'write' | 'delete' | 'ddl' | 'manage_members'>;
    /**
     * Cloud version stamp. Used by the polling loop to decide whether
     * a local pull is needed. Opaque string — cloud may use ISO time,
     * monotonic counter, or a content hash.
     */
    version: string;
}

/**
 * One change captured in the WAL on local Lore, packaged for push.
 *
 * The field set is deliberately small: we ship the operation name,
 * the workspace it scoped to, and an opaque payload. Cloud is
 * responsible for replay; local doesn't try to encode semantics.
 */
export interface SyncPushChange {
    /** Change-set id minted at WAL append time. Idempotency key. */
    id: string;
    workspaceId: string;
    /** e.g. 'upsert_node', 'store_edge', 'delete_node'. Matches WAL op. */
    op: string;
    /** JSON-serializable payload. Cloud re-runs this through the same op. */
    payload: unknown;
    /** ISO 8601 — when local captured the change. */
    capturedAt: string;
}

export interface SyncPushResult {
    /** Echo the change ids cloud accepted. */
    accepted: string[];
    /** Change ids cloud rejected (e.g. permission denied). */
    rejected: Array<{ id: string; reason: string }>;
}

export interface CloudSyncClient {
    /**
     * GET the workspaces this user is authorized to see, plus their
     * versions. Local Lore compares to its own state and pulls /
     * drops as needed.
     *
     * Wire: GET /sync/workspaces
     *       Authorization: Bearer <user-jwt>
     *       → 200 { workspaces: SyncedWorkspace[] }
     *
     * Returns an empty list when no auth is configured (no-op client).
     */
    listMyWorkspaces(): Promise<SyncedWorkspace[]>;

    /**
     * Pull a workspace's full state. v1 fetches everything as one
     * blob (last-write-wins, no delta). Caller writes the result to
     * `<LORE_HOME>/workspaces/<workspaceId>/.lore/`.
     *
     * Wire: GET /sync/workspaces/{id}/snapshot
     *       Authorization: Bearer <user-jwt>
     *       → 200 stream / archive (shape TBD; v1 expectation: tar
     *         of the .lore/ directory contents)
     *
     * Returns null in the no-op case; caller treats that as "nothing
     * to pull" and leaves the local copy intact.
     */
    pullWorkspaceSnapshot(workspaceId: string, version: string): Promise<SyncSnapshot | null>;

    /**
     * Push a batch of WAL-captured changes for a workspace. Cloud
     * verifies the user has `write` and replays the ops.
     *
     * Wire: POST /sync/workspaces/{id}/push
     *       Authorization: Bearer <user-jwt>
     *       Body: { changes: SyncPushChange[] }
     *       → 200 SyncPushResult
     *
     * No-op client returns all-rejected so the WAL doesn't drain
     * prematurely (caller treats persistent rejection as "cloud
     * unreachable, retry later").
     */
    pushChanges(workspaceId: string, changes: SyncPushChange[]): Promise<SyncPushResult>;

    /**
     * Cheap connectivity probe. `true` when the cloud target is
     * reachable + authenticated. Used by the polling loop to skip
     * loops when the cloud is down. Always `true` in the no-op
     * client (it never fails because it never calls anything).
     */
    isReachable(): Promise<boolean>;
}

/**
 * Snapshot returned by pullWorkspaceSnapshot. v1: just an opaque
 * `bytes` buffer the local installer extracts. v2 may switch to a
 * stream + content-hash header for resumable pulls.
 */
export interface SyncSnapshot {
    workspaceId: string;
    version: string;
    bytes: Uint8Array;
    /** Optional checksum for integrity verification. */
    sha256?: string;
}

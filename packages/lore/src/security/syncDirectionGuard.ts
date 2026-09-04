/**
 * syncDirectionGuard.ts — Asymmetric sync enforcement (V3.0 Phase A6).
 *
 * Encodes the hard rule from `lore-sync-architecture-corrected-2026-05-07`:
 *
 *   Local-First (single-user, local-primary workspaces):
 *     - source of truth: local
 *     - sync up: yes (local → user's personal cloud)
 *     - sync down: yes (user's other devices via cloud relay)
 *
 *   Cloud-Only (enterprise verticals):
 *     - source of truth: cloud
 *     - sync up: yes for things originating locally (queries, in-flight)
 *     - sync down: NEVER persist enterprise data to local disk
 *
 * The guard sits at every write boundary that could persist data to
 * disk. Storage adapters call `assertCanPersistLocally` before writing
 * a Lore node to local SurrealDB / LanceDB. Sync engines call
 * `assertCanSyncDown` before applying a cloud→local sync delta. Both
 * throw a typed error when the policy denies the operation, so the
 * caller can refuse gracefully (audit + reject the inbound write
 * rather than continuing).
 *
 * Why a separate module: the rule is invariant across substrate
 * adapters (SurrealDB, LanceDB, future SQL). Centralizing the gate makes
 * "I forgot to add the check" impossible to ship — every persistence
 * call routes through this guard.
 */

export type WorkspacePolicy = 'local-first' | 'cloud-only';

export interface WorkspacePolicyEntry {
    workspace: string;
    policy: WorkspacePolicy;
    /**
     * For cloud-only workspaces: whether transient in-memory access is
     * allowed (RAM/UI rendering). Default true. When false, even the
     * data-in-flight path is rejected (e.g., for highly regulated
     * workspaces that should not be reachable from this device).
     */
    allowDataInFlight?: boolean;
    /**
     * For cloud-only workspaces: optional opt-in to encrypted-at-rest
     * offline cache (per the corrected sync decision's escape hatch).
     * Default false. Storage callers honor it via
     * `mayPersistEncryptedCache`.
     */
    allowEncryptedOfflineCache?: boolean;
}

export class SyncPolicyError extends Error {
    constructor(
        public readonly code:
        | 'cloud-only-no-local-persist'
        | 'cloud-only-no-sync-down'
        | 'cloud-only-not-reachable'
        | 'unknown-workspace',
        message: string,
        public readonly workspace: string,
    ) {
        super(message);
        this.name = 'SyncPolicyError';
    }
}

export class SyncDirectionGuard {
    private readonly entries = new Map<string, Required<WorkspacePolicyEntry>>();

    register(entry: WorkspacePolicyEntry): void {
        if (!entry.workspace) throw new Error('workspace required');
        this.entries.set(entry.workspace, {
            workspace: entry.workspace,
            policy: entry.policy,
            allowDataInFlight: entry.allowDataInFlight ?? true,
            allowEncryptedOfflineCache: entry.allowEncryptedOfflineCache ?? false,
        });
    }

    unregister(workspace: string): boolean {
        return this.entries.delete(workspace);
    }

    list(): WorkspacePolicyEntry[] {
        return Array.from(this.entries.values());
    }

    policyOf(workspace: string): WorkspacePolicy {
        const entry = this.entries.get(workspace);
        if (!entry) {
            throw new SyncPolicyError(
                'unknown-workspace',
                `workspace '${workspace}' has no registered sync policy`,
                workspace,
            );
        }
        return entry.policy;
    }

    /**
     * Assert that a node belonging to the given workspace may be
     * persisted to local disk.
     *
     * Local-First: always yes.
     * Cloud-Only: yes only if `allowEncryptedOfflineCache` is set AND
     *   the caller is the encrypted-cache writer (signaled via
     *   `intent: 'encrypted-cache'`). Otherwise no.
     */
    assertCanPersistLocally(input: {
        workspace: string;
        intent?: 'normal' | 'encrypted-cache';
    }): void {
        const entry = this.requireEntry(input.workspace);
        if (entry.policy === 'local-first') return;
        // cloud-only:
        if (input.intent === 'encrypted-cache' && entry.allowEncryptedOfflineCache) return;
        throw new SyncPolicyError(
            'cloud-only-no-local-persist',
            `workspace '${input.workspace}' is cloud-only; local persist denied`,
            input.workspace,
        );
    }

    /**
     * Assert that a sync engine may apply a cloud→local delta.
     *
     * Local-First: yes — that's how multi-device relay works.
     * Cloud-Only: NEVER. Source of truth is cloud; nothing should
     *   travel down to local persist. (Data-in-flight is fine; that
     *   bypasses this guard because there's no persist to permit.)
     */
    assertCanSyncDown(workspace: string): void {
        const entry = this.requireEntry(workspace);
        if (entry.policy === 'local-first') return;
        throw new SyncPolicyError(
            'cloud-only-no-sync-down',
            `workspace '${workspace}' is cloud-only; cloud→local sync denied`,
            workspace,
        );
    }

    /**
     * Assert that data-in-flight access (RAM, UI, AI inference) is
     * allowed for the workspace. Always allowed for local-first;
     * gated by `allowDataInFlight` for cloud-only.
     */
    assertCanReadInFlight(workspace: string): void {
        const entry = this.requireEntry(workspace);
        if (entry.policy === 'local-first') return;
        if (entry.allowDataInFlight) return;
        throw new SyncPolicyError(
            'cloud-only-not-reachable',
            `workspace '${workspace}' is cloud-only with in-flight access disabled`,
            workspace,
        );
    }

    /**
     * Predicate variant for code paths that prefer a boolean over a
     * thrown error. Returns false on any policy denial.
     */
    canPersistLocally(input: { workspace: string; intent?: 'normal' | 'encrypted-cache' }): boolean {
        try { this.assertCanPersistLocally(input); return true; }
        catch (err) {
            if (err instanceof SyncPolicyError) {
                // unknown-workspace is a configuration error, not a policy
                // denial — propagate so callers don't silently treat
                // unconfigured workspaces as denied.
                if (err.code === 'unknown-workspace') throw err;
                return false;
            }
            throw err;
        }
    }

    canSyncDown(workspace: string): boolean {
        try { this.assertCanSyncDown(workspace); return true; }
        catch (err) { if (err instanceof SyncPolicyError) return false; throw err; }
    }

    canReadInFlight(workspace: string): boolean {
        try { this.assertCanReadInFlight(workspace); return true; }
        catch (err) { if (err instanceof SyncPolicyError) return false; throw err; }
    }

    private requireEntry(workspace: string): Required<WorkspacePolicyEntry> {
        const entry = this.entries.get(workspace);
        if (!entry) {
            throw new SyncPolicyError(
                'unknown-workspace',
                `workspace '${workspace}' has no registered sync policy`,
                workspace,
            );
        }
        return entry;
    }
}

/**
 * Gate a cloud→local sync-down (audit L-035). Fail-CLOSED for a registered
 * cloud-only workspace (rethrow as a refusal the poller records as
 * pullsFailed); fail-OPEN for an unknown/unregistered workspace and any other
 * policy code, so ordinary local-first multi-workspace sync is unaffected
 * (not every cloud workspace the user is authorized for is registered
 * locally). Exported as a named helper so the daemon's applySnapshot host
 * callback AND its tests call the SAME production logic — not a duplicate.
 */
export function guardSyncDown(guard: SyncDirectionGuard, workspaceId: string): void {
    try {
        guard.assertCanSyncDown(workspaceId);
    } catch (e) {
        if (e instanceof SyncPolicyError && e.code === 'cloud-only-no-sync-down') {
            throw new Error(`sync-down refused: workspace '${workspaceId}' is cloud-only`);
        }
        // unknown-workspace (and any other policy code) → allow.
    }
}

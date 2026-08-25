/**
 * security/workspaceQuota.ts — Sprint C3 per-workspace write quota.
 *
 * The existing `engines/quotaManager.ts` enforces a STORAGE-bytes
 * budget against measured disk usage (slow, runs on the ingestion
 * path with a freshly-walked breakdown). It's the right surface for
 * the periodic banner UI but the wrong shape for hot-path writes.
 *
 * Sprint C3 ships a complementary, write-time quota:
 *   - Per-workspace node-count cap (workspace.maxNodes)
 *   - Per-workspace storage-bytes cap (workspace.maxStorageBytes)
 * Both come from workspaces.json. Absent means "no cap".
 *
 * Hot-path implementation:
 *   - In-memory `WorkspaceCounter` keyed by workspace name.
 *   - Boot reconciles counters from LocalGraph.getStats() once per
 *     workspace (cheap — already on the boot path for /api/health).
 *   - Every accepted hot-lane write increments the relevant counter.
 *     We DO NOT decrement on delete in C3 (counters drift upward
 *     bounded by reconcile cadence); a periodic reconcile job
 *     re-reads stats every RECONCILE_MS (10 min default). Drift is
 *     acceptable because deletes are rare on the steady-state path
 *     and a workspace at 99% of cap will reconcile down before the
 *     operator hits the wall.
 *   - For storage bytes the counter approximates: every node.upsert
 *     adds an estimated payload size (UTF-8 length of label + body).
 *     Reconcile pulls true on-disk byte usage from the storage
 *     inspector (out of band).
 *
 * Cloud extension:
 *   Per-tenant aggregation across workspaces is out of scope for C3.
 *   The IWorkspaceQuotaStore interface below has just enough surface
 *   to swap in a Redis-backed implementation; the cloud-activation
 *   track wires that.
 *
 * Response shape on exceed:
 *   HTTP 429 { error: 'workspace_quota_exceeded', dimension, current, cap }
 *   This is OUR rate-limit code (slowapi-style retries are pointless;
 *   the operator must raise the cap or archive data).
 */

import type { ServerResponse } from 'node:http';
import type { WorkspaceEntry } from '../config/workspaces.js';

export interface WorkspaceQuotaSnapshot {
    nodeCount: number;
    storageBytes: number;
}

export interface IWorkspaceQuotaStore {
    /** Read current counters for a workspace (zeros if unseen). */
    snapshot(workspace: string): WorkspaceQuotaSnapshot;
    /** Increment counters after an accepted write. */
    increment(workspace: string, delta: { nodes?: number; bytes?: number }): void;
    /** Reset (boot reconcile / periodic reconcile call site). */
    reconcile(workspace: string, snap: WorkspaceQuotaSnapshot): void;
    /** Test-only — drop all state. */
    _resetAll(): void;
}

/** In-process counter map. Default impl for local mode. */
export class InMemoryWorkspaceQuotaStore implements IWorkspaceQuotaStore {
    private map = new Map<string, WorkspaceQuotaSnapshot>();

    snapshot(workspace: string): WorkspaceQuotaSnapshot {
        return this.map.get(workspace) ?? { nodeCount: 0, storageBytes: 0 };
    }

    increment(workspace: string, delta: { nodes?: number; bytes?: number }): void {
        const prev = this.snapshot(workspace);
        this.map.set(workspace, {
            nodeCount: prev.nodeCount + (delta.nodes ?? 0),
            storageBytes: prev.storageBytes + (delta.bytes ?? 0),
        });
    }

    reconcile(workspace: string, snap: WorkspaceQuotaSnapshot): void {
        this.map.set(workspace, snap);
    }

    _resetAll(): void {
        this.map.clear();
    }
}

export interface QuotaCheckDeps {
    store: IWorkspaceQuotaStore;
    /** Resolves the workspace entry's quota fields (may return undefined). */
    getWorkspaceEntry: (workspace: string) => WorkspaceEntry | undefined;
}

export type QuotaDimension = 'maxNodes' | 'maxStorageBytes';

export interface QuotaResult {
    allowed: boolean;
    dimension?: QuotaDimension;
    current?: number;
    cap?: number;
}

/**
 * checkWorkspaceQuota — pure decision function.
 *
 * For the write under consideration, are we under cap? Caller passes
 * the *projected* deltas (nodes added, bytes added). Returns
 * { allowed: false, dimension, current, cap } when the new totals
 * would exceed any configured cap.
 */
export function checkWorkspaceQuota(
    deps: QuotaCheckDeps,
    workspace: string,
    delta: { nodes?: number; bytes?: number },
): QuotaResult {
    const entry = deps.getWorkspaceEntry(workspace);
    if (!entry) return { allowed: true };
    const snap = deps.store.snapshot(workspace);
    if (entry.maxNodes !== undefined && entry.maxNodes !== null) {
        const projected = snap.nodeCount + (delta.nodes ?? 0);
        if (projected > entry.maxNodes) {
            return {
                allowed: false,
                dimension: 'maxNodes',
                current: snap.nodeCount,
                cap: entry.maxNodes,
            };
        }
    }
    if (entry.maxStorageBytes !== undefined && entry.maxStorageBytes !== null) {
        const projected = snap.storageBytes + (delta.bytes ?? 0);
        if (projected > entry.maxStorageBytes) {
            return {
                allowed: false,
                dimension: 'maxStorageBytes',
                current: snap.storageBytes,
                cap: entry.maxStorageBytes,
            };
        }
    }
    return { allowed: true };
}

/**
 * enforceQuotaOrReject — HTTP-shaped helper for hot-path routes.
 *
 * If quota exceeded, writes HTTP 429 + JSON body and returns
 * `{ handled: true }`. Caller bails. If allowed, returns
 * `{ handled: false }` and caller proceeds; caller MUST call
 * `deps.store.increment(workspace, delta)` after the write commits.
 *
 * We keep the increment OUTSIDE this helper so the caller can choose
 * to skip the bump if its substrate write fails (avoiding the
 * "counter-up-on-failed-write" drift).
 */
export function enforceQuotaOrReject(
    deps: QuotaCheckDeps,
    res: ServerResponse,
    workspace: string,
    delta: { nodes?: number; bytes?: number },
): { handled: boolean } {
    const result = checkWorkspaceQuota(deps, workspace, delta);
    if (result.allowed) return { handled: false };
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        error: 'workspace_quota_exceeded',
        dimension: result.dimension,
        current: result.current,
        cap: result.cap,
        workspace,
        hint: 'raise the cap in workspaces.json, archive content, or switch workspace',
    }));
    return { handled: true };
}

/**
 * enforceNodeWriteQuota — Sprint C3 convenience wrapper used by the
 * POST /api/node hot path. Computes byte estimate from a node payload's
 * label + body, then defers to enforceQuotaOrReject. Returns the same
 * `{ handled }` shape so callers can `if (result.handled) return true`.
 *
 * Extracted from nodes.ts to keep that file under the 800-line cap.
 */
export function enforceNodeWriteQuota(
    deps: QuotaCheckDeps,
    res: ServerResponse,
    workspace: string,
    nodeData: { label?: unknown; body?: unknown },
): { handled: boolean } {
    const labelBytes = Buffer.byteLength(String(nodeData.label ?? ''), 'utf8');
    const bodyBytes = Buffer.byteLength(String(nodeData.body ?? ''), 'utf8');
    return enforceQuotaOrReject(deps, res, workspace, { nodes: 1, bytes: labelBytes + bodyBytes });
}

/** Increment the quota counter after a node write commits. */
export function bumpNodeWriteQuota(
    store: IWorkspaceQuotaStore,
    workspace: string,
    nodeData: { label?: unknown; body?: unknown },
): void {
    const labelBytes = Buffer.byteLength(String(nodeData.label ?? ''), 'utf8');
    const bodyBytes = Buffer.byteLength(String(nodeData.body ?? ''), 'utf8');
    store.increment(workspace, { nodes: 1, bytes: labelBytes + bodyBytes });
}

/** Boot-time reconcile helper. Caller plugs in graph + storage probes. */
export async function reconcileWorkspace(
    store: IWorkspaceQuotaStore,
    workspace: string,
    probe: () => Promise<WorkspaceQuotaSnapshot>,
): Promise<void> {
    try {
        const snap = await probe();
        store.reconcile(workspace, snap);
    } catch {
        // Don't fail boot on a single workspace probe error.
    }
}

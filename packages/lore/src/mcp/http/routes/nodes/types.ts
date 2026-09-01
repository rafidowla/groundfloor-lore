/**
 * types.ts — shared types for the /api/node* route family.
 *
 * NodesDeps is the dependency bundle passed to every node-route handler;
 * LoreGraph is the local/cloud graph union those handlers operate on.
 * Kept in one place so the thin dispatcher (../nodes.ts) and each
 * per-endpoint handler agree on the same shapes without a dispatcher↔
 * handler import cycle.
 */

import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../../services.js';
import type { LocalGraphRegistry } from '../../../../engines/localGraphRegistry.js';
import type { AuditLog } from '../../../../security/audit.js';
import type { OutboxLagCache } from '../../../../outbox/lagCache.js';
import type { PendingOpsStore } from '../../../../security/pendingOps.js';
import type { OutboxStore } from '../../../../outbox/types.js';
import type { WorkspaceVerbatimResolver } from '../../../../outbox/workspaceVerbatimResolver.js';
import type { LoreGraphHandle } from '../../../../storage/loreStorageClient.js';

// Widened for the Kùzu removal: naming the two CONCRETE classes silently
// excluded SurrealGraph (see engines/htmlExport.ts). Need more than the
// shared handle? Feature-detect and refuse — do not re-narrow to a class.
export type LoreGraph = LoreGraphHandle;

export interface NodesDeps {
    store: StorageBundle;
    auditLog: AuditLog;
    /** Allows the route to call `gateRoute` for ReBAC checks. */
    deploymentMode: 'local' | 'cloud';
    /** Dataplane handle used by ReBAC checks. Null in local mode. */
    dataplane: GroundfloorClient | null;
    /** Phase 6 P1.B — multi-workspace LocalGraph registry. Optional;
     *  absent → legacy `deps.store.loreGraph` path. */
    graphRegistry?: LocalGraphRegistry;
    /**
     * P2 (isolation) — per-workspace verbatim (LanceDB) resolver. Threaded so
     * GET /api/node/supersession-candidates runs its vector scan against the
     * REQUESTED workspace's OWN LanceDB instead of the boot-bound (active-
     * workspace) store. Absent (cloud/tests) → the vector scan is skipped for a
     * non-active workspace (degrades to no candidate pairs), never seeded from
     * the active store. */
    workspaceVerbatimResolver?: WorkspaceVerbatimResolver;
    /** Phase 6 P2 — HITL pending-ops store (`onMismatch: 'hitl'`). */
    pendingOpsStore?: PendingOpsStore;
    /** Phase 6 P2 — core node types (always active). */
    coreNodeTypes?: ReadonlyArray<string>;
    /** Slice-4 (arcade) — vocab-policy lookup SEAM. When present the vocab gate
     *  resolves the policy through this closure (arcade: relational-lane
     *  cell_policies) instead of getWorkspaceVocabPolicy. Absent → local
     *  behavior byte-identical. See storeNodeGates.GateDeps.getVocabPolicy. */
    getVocabPolicy?: (workspace: string) => import('../../../../config/workspaces.js').WorkspaceVocabPolicy;
    /** Sprint O2 — outbox for hot-lane writes (records node.upsert +
     *  verbatim.upsert before substrate writes; optional). */
    outboxStore?: OutboxStore;
    /**
     * INLINE verbatim writer. Local mode leaves this unset (HTTP seed goes
     * through the outbox + replicator). Cloud mode passes storageClient so
     * DataplaneVectorStore.store runs on the request path — the replicator
     * does not re-apply verbatim in cloud (getVerbatim is undefined). Arcade
     * without an outbox lane uses the same hook as the no-outbox fallback. */
    inlineVerbatim?: import('../../../../core/nodeService.js').VerbatimWriter;
    /** Sprint O4 — backpressure lag cache (optional; absent = skip). */
    outboxLagCache?: OutboxLagCache;
    /** Sprint C3 — per-workspace write-time quota store + entry lookup.
     *  When both are wired the route refuses with HTTP 429
     *  workspace_quota_exceeded before any substrate write. Optional
     *  so test/cloud wiring without the store still types. */
    quotaStore?: import('../../../../security/workspaceQuota.js').IWorkspaceQuotaStore;
    getWorkspaceEntryForQuota?: (workspace: string) => import('../../../../config/workspaces.js').WorkspaceEntry | undefined;
}

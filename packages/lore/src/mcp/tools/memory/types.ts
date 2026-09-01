/**
 * types.ts — shared dependency bundle for the knowledge-graph mutation
 * tools (store_node, store_edge, mark_stale, delete_node, delete_edge,
 * supersede_node). Each tool lives in its own file under ./; this is the
 * one shape they all agree on.
 */

import { z } from 'zod';
import type { VersionStore } from '../../../outbox/versionStore.js';
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import type { ConfigManager } from '../../../config/configManager.js';
import type { AuditLog } from '../../../security/audit.js';
import type { WriteAheadLog } from '../../../engines/syncEngine.js';
import type { StorageBundle } from '../../services.js';
import type { PendingOpsStore } from '../../../security/pendingOps.js';
import type { OutboxStore } from '../../../outbox/types.js';
import type { OutboxLagCache } from '../../../outbox/lagCache.js';

export interface MemoryToolsDeps {
    store: StorageBundle;
    configManager: ConfigManager;
    auditLog: AuditLog;
    detectedScope: { workspace: string; ecosystem: string };
    /** WAL is `let`-mutable in main() (replaced with the keychain-upgraded SyncEngine's WAL); read fresh per call. */
    getWal: () => WriteAheadLog;
    /** Domain config — used in descriptors. */
    domain: string;
    edgeRelations: string[];
    /** Pre-merged enums (core + workspace contributions). */
    nodeTypesEnum: ReturnType<typeof z.enum>;
    /** Architecture gap #2 integration — when wired, callers can
     *  pass `async_embed: true` to store_node to skip the synchronous
     *  embed-and-mirror step. The node still lands in the graph
     *  immediately; embedding catches up in the background. The
     *  consistency sweeper (gap #9) heals any drift the queue can't
     *  drain. Optional so tests + cloud-mode paths that don't wire
     *  it ignore the flag. */
    embedQueue?: { enqueue: (nodeId: string, text: string) => void };
    nodeTypesDescription: string;
    edgeRelationsEnum: ReturnType<typeof z.enum>;
    /**
     * Phase 6 P1.C — multi-workspace LocalGraph registry. When wired,
     * store_node / store_edge / delete_node resolve the target graph
     * via `registry.getOrOpen(workspace ?? active)` so writes physically
     * land in the requested workspace's store. When `workspace` is
     * omitted, behavior matches pre-P1.C (active workspace). Optional
     * so cloud-mode and test fixtures fall back to `store.loreGraph`.
     */
    graphRegistry?: LocalGraphRegistry;
    /**
     * Phase 6 P2 — pending-ops store. Optional so test fixtures + cloud
     * mode (where HITL routing lives behind the Dataplane approval
     * service) can pass undefined; in that case the vocab policy
     * 'hitl' verdict downgrades to a 'reject' with a hint pointing at
     * the missing HITL store rather than silently accepting the write.
     */
    pendingOpsStore?: PendingOpsStore;
    /**
     * Phase 6 P2 — core node types always active. The
     * vocab-policy engine treats core types as always available.
     * Populated from the active SchemaLoader's domain schema at boot.
     */
    coreNodeTypes: ReadonlyArray<string>;
    /** Feature 8 — version store. When wired, store_node records versions + honours changeset_id. */
    versionStore?: VersionStore;
    /**
     * SP-F3 — outbox hot-lane store. When wired, store_node / store_edge /
     * delete_node record an outbox row (operationKind node.upsert /
     * verbatim.upsert / edge.upsert / node.delete) BEFORE the substrate
     * write, mirroring the REST routes (postNode.ts / edges.ts). This gives
     * MCP-originated writes the same durability + crash-recovery-replay +
     * replication coverage the universal-write-path invariant promises, and
     * (with SP-F3's per-workspace replay routing) makes the replicator apply
     * them to the correct workspace. Optional so cloud mode + test fixtures
     * that don't wire an outbox keep the prior direct-write behavior.
     */
    outboxStore?: OutboxStore;
    /** SP-F3 — per-workspace lag cache for MCP-write backpressure (O4),
     *  mirroring REST `checkOutboxBackpressure`. Optional. */
    outboxLagCache?: OutboxLagCache;
    /**
     * L-033 — per-workspace write-quota store. store_node is the PRIMARY
     * ingestion path for agents, yet the quota was only enforced on HTTP
     * POST /api/node, letting MCP writes blow past workspace.maxNodes /
     * maxStorageBytes AND leaving the counter stale for mixed-surface
     * deployments. When wired (paired with getWorkspaceEntryForQuota), the
     * store_node tool enforces the SAME quota and bumps the SAME counter the
     * REST path uses (one shared IWorkspaceQuotaStore instance). Optional so
     * cloud mode + test fixtures that don't wire it keep the prior no-quota
     * behavior — identical guard convention to postNode.ts. */
    quotaStore?: import('../../../security/workspaceQuota.js').IWorkspaceQuotaStore;
    /** L-033 — resolves a workspace's quota fields (maxNodes / maxStorageBytes).
     *  Required alongside quotaStore for the gate to fire; absent → no cap. */
    getWorkspaceEntryForQuota?: (workspace: string) => import('../../../config/workspaces.js').WorkspaceEntry | undefined;
    /**
     * L-056 — per-workspace VerbatimStore resolver. delete_node routes the
     * graph delete to the resolved workspace's store but, without this, would
     * tombstone the verbatim vector in the boot-bound store — splitting the
     * delete across two workspaces. When wired, the tombstone lands in the
     * SAME workspace as the graph delete (mirrors verbatim.ts / bulk-store).
     * Optional so cloud mode + test fixtures fall back to store.loreVerbatim.
     */
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<import('../../../engines/verbatimStore.js').VerbatimStore> };
    /**
     * Cloud primary verbatim write. When set, store_node still records
     * the outbox row but also writes DataplaneVectorStore on the request
     * path (replicator does not apply verbatim in cloud). Local leaves
     * this unset. */
    inlineVerbatim?: import('../../../core/nodeService.js').VerbatimWriter;
}

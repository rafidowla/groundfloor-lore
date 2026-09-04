/**
 * shared.ts — types + body helper for the retention/verbatim route family.
 */

import type { IncomingMessage } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../../services.js';
import type { AuditLog } from '../../../../security/audit.js';
import type { LocalGraphRegistry } from '../../../../engines/localGraphRegistry.js';
import type { WorkspaceVerbatimResolver } from '../../../../outbox/workspaceVerbatimResolver.js';
import type { OutboxStore } from '../../../../outbox/types.js';
import { readBoundedBody } from '../../helpers.js';

export interface RetentionSweepResult {
    policy: { autoArchiveSupersededAfterDays: number | null };
    eligible: number;
    archived: number;
    sample: Array<{ id: string; supersededAt: string }>;
    dryRun: boolean;
}

export interface RetentionDeps {
    store: StorageBundle;
    auditLog: AuditLog;
    runRetentionSweep: (dryRun: boolean) => Promise<RetentionSweepResult>;
    /** Allows the route to call `gateRoute` for ReBAC checks. */
    deploymentMode: 'local' | 'cloud';
    /** Dataplane handle used by ReBAC checks. Null in local mode. */
    dataplane: GroundfloorClient | null;
    /** L-012 — active (boot-detected) workspace scope. Optional; only the
     *  active-vs-requested comparison inside the resolver uses it, and the
     *  resolver routes by the requested workspace regardless, so absence is
     *  harmless (falls back to ''). */
    detectedScope?: { workspace: string; ecosystem: string };
    /** L-012 — per-workspace graph registry. When present, workspace-taking
     *  retention routes resolve the REQUESTED workspace instead of the
     *  boot/active store. Optional so cloud-mode and test fixtures that mock
     *  only StorageBundle fall back to the boot store (behavior unchanged). */
    graphRegistry?: LocalGraphRegistry;
    /** L-012 — per-workspace verbatim resolver (the same SP-F3
     *  WorkspaceVerbatimResolver the outbox replicator uses). When present,
     *  verbatim reads/searches route to the REQUESTED workspace's LanceDB
     *  instead of the boot-active store. Optional; absent → boot store
     *  (deps.store.loreVerbatim), identical to today. */
    workspaceVerbatimResolver?: WorkspaceVerbatimResolver;
    /**
     * ITEM X-pruneeph (2026-09-03) — POST /api/prune-ephemeral's per-node
     * delete now goes through the same outbox-first discipline as
     * DELETE /api/node / POST /api/nodes/prune hard_delete: a `node.delete`
     * row before the substrate delete and a `verbatim.tombstone` row after
     * the vector tombstone. Optional so cloud mode / test fixtures without
     * an outbox wired keep the prior direct-delete-only behavior.
     *
     * ITEM X-markstale (2026-09-03) — this same field is also used by
     * POST /api/mark-stale, which records a `node.mark_stale` outbox row per
     * locked chunk BEFORE applying the substrate update (mirrors the MCP
     * mark_stale tool and the bulk-delete REST route). Optional so cloud
     * mode + test fixtures that don't wire an outbox keep the prior
     * direct-write behavior (no durability/replay coverage, same as before
     * this fix).
     */
    outboxStore?: OutboxStore;
}

/**
 * Read the request body as a string, capped at the helper-wide 10 MB
 * MAX_BODY_BYTES. Rejects with `{ code: 'payload_too_large' }` on
 * overflow so callers can map to HTTP 413 via writeOversizeError.
 */
export async function readBody(req: IncomingMessage): Promise<string> {
    return readBoundedBody(req);
}

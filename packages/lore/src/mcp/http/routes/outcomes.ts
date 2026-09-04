/**
 * outcomes.ts — HTTP mirrors for the outcome MCP tools (Feature 2).
 *
 *   POST /api/nodes/:id/outcomes   — record a success/failure/partial outcome
 *   GET  /api/nodes/:id/outcomes   — retrieve outcome history + confirmation score
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import type { AuxStore } from '../../../outbox/auxStore.js';
import type { VersionStore } from '../../../outbox/versionStore.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { gateRoute } from '../../../security/routeGate.js';
// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeError, parseJsonBody, isInvalidJsonBody, writeInvalidJson } from '../helpers.js';
import { bindRouteTarget, isLegacyBypass } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';

export interface OutcomesRouteDeps {
    store: StorageBundle;
    auxStore: AuxStore;
    versionStore?: VersionStore;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    /**
     * Sprint L1c (cross-workspace routing) — per-workspace graph registry.
     * When present, the graph-counter side of POST /api/nodes/:id/outcomes
     * routes its node read + upsert to the REQUESTED workspace's graph
     * instead of the boot/active `store.loreGraph`. Absent (cloud/tests) →
     * falls back to the boot store, so the no-registry path is unchanged.
     */
    graphRegistry?: LocalGraphRegistry;
}

function calcConfirmationScore(success: number, failure: number, partial: number): number {
    const total = success + failure + partial * 0.5;
    if (total === 0) return 0;
    return Math.round((success / total) * 1000) / 1000;
}

const OUTCOMES_RE = /^\/api\/nodes\/([^/]+)\/outcomes$/;

export async function tryOutcomesRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: OutcomesRouteDeps,
): Promise<boolean> {

    const match = OUTCOMES_RE.exec(pathname);
    if (!match) return false;
    const nodeId = match[1];

    /* ─── POST /api/nodes/:id/outcomes ─────────────────────────── */
    if (req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. First phase binds to the caller's own workspace (the body
        // hasn't been parsed yet). The pure legacy/direct-call bypass (no
        // principal/slot) is the ONE null-without-denial case — it falls through
        // to the body-workspace re-gate below. Otherwise a null return is a
        // DENIAL. Detected up front so we never depend on res.headersSent (stub
        // responses don't track it).
        if (!isLegacyBypass(undefined) &&
            bindRouteTarget(res, { intent: 'write' }) === null) return true;
        let body: string;
        try {
            body = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }
        try {
            const parsed = parseJsonBody(body) as {
                workspace?: string;
                status?: string;
                notes?: string;
                recorded_by?: string;
            };
            if (!parsed.workspace || typeof parsed.workspace !== 'string') {
                writeError(res, 400, 'invalid_request', '`workspace` is required in POST body');
                return true;
            }
            const allowed = ['success', 'failure', 'partial'];
            if (!parsed.status || !allowed.includes(parsed.status)) {
                writeError(res, 400, 'invalid_request', '`status` must be one of: success, failure, partial');
                return true;
            }
            const workspace = parsed.workspace;
            const status = parsed.status as 'success' | 'failure' | 'partial';

            // R4 #1 — the first-phase bind above targeted the caller's OWN
            // workspace and so only confirms the token has SOME write scope; it
            // never checked the body-supplied target. This route then writes the
            // outcome, node counters, and version into `workspace` (below), so
            // without a gate on the REAL target a workspace-A token could mutate
            // workspace B. Re-gate on parsed.workspace. Null principal =
            // legacy/local bypass.
            if (bindRouteTarget(res, { requested: workspace, intent: 'write' }) === null) return true;

            // Sprint L1c — route the graph-counter side to the REQUESTED
            // workspace. The aux/version stores are workspace-keyed by row
            // (recordOutcome/getOutcomeCount take `workspace`), but the graph
            // node read + upsert below targeted the boot store regardless of
            // `workspace`. Resolve the requested workspace's graph so the
            // confirmation counters land in that app's database. Registry
            // absent (cloud/tests) → boot store, behavior unchanged.
            // Both `deps.store.loreGraph` and `getGraphHandle`'s return type
            // are `LoreGraphHandle` (this file's `LoreGraph` alias), so no
            // cast is needed either way — the pre-widening casts here bridged
            // `LocalGraph`/a union down to the alias; that gap is gone now.
            // getGraphHandle honours the workspace's declared engine,
            // resolving the requested workspace's own graph rather than
            // silently mis-scoring outcome counters against the wrong node.
            let graph: LoreGraph = deps.store.loreGraph;
            if (deps.graphRegistry) {
                try {
                    graph = await deps.graphRegistry.getGraphHandle(workspace);
                } catch (err) {
                    if (err instanceof WorkspaceNotFoundError) {
                        writeError(res, 404, 'workspace_not_found', `workspace not found: ${err.requested}`, {
                            requested: err.requested,
                            known: err.known,
                        });
                        return true;
                    }
                    throw err;
                }
            }
            await graph.initialize();

            const node = await graph.getNode(nodeId);
            if (!node) {
                writeError(res, 404, 'node_not_found', `node not found: ${nodeId}`, { node_id: nodeId });
                return true;
            }

            const outcomeId = randomUUID();
            deps.auxStore.recordOutcome({
                id: outcomeId,
                nodeId,
                workspace,
                status,
                notes: parsed.notes,
                recordedBy: parsed.recorded_by,
            });

            const counts = deps.auxStore.getOutcomeCount(nodeId, workspace);
            const newScore = calcConfirmationScore(counts.success, counts.failure, counts.partial);

            await withTransactionConflictRetry(() => graph.upsertNode({
                ...node,
                success_count: counts.success,
                failure_count: counts.failure,
                partial_count: counts.partial,
                confirmation_score: newScore,
            }));

            deps.auxStore.incrementCounter(workspace, `outcomes_${status}`);

            if (deps.versionStore) {
                try {
                    deps.versionStore.recordVersion({
                        versionId: randomUUID(), nodeId, workspace,
                        timestamp: new Date().toISOString(), principal: 'http',
                        operation: 'outcome',
                        previousState: node,
                        newState: { ...node, success_count: counts.success, failure_count: counts.failure, partial_count: counts.partial, confirmation_score: newScore },
                        changesetId: null,
                    });
                } catch { /* non-fatal */ }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                outcome_id: outcomeId,
                node_id: nodeId,
                workspace,
                status,
                new_confirmation_score: newScore,
                counts,
            }));
        } catch (err) {
            // X-json400 (2026-09-03 audit) — malformed JSON used to fall
            // through to 500 here; parseJsonBody's tagged error is caught
            // first now.
            if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    /* ─── GET /api/nodes/:id/outcomes ──────────────────────────── */
    if (req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const params = new URL(url, 'http://localhost').searchParams;
            const workspace = params.get('workspace') ?? '';
            const limit = Math.min(100, Math.max(1, parseInt(params.get('limit') ?? '20', 10) || 20));

            if (!workspace) {
                writeError(res, 400, 'invalid_request', '`workspace` query param is required');
                return true;
            }
            if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return true;

            const outcomes = deps.auxStore.getOutcomes(nodeId, workspace, limit);
            const counts = deps.auxStore.getOutcomeCount(nodeId, workspace);
            const score = calcConfirmationScore(counts.success, counts.failure, counts.partial);
            const total = counts.success + counts.failure + counts.partial;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ node_id: nodeId, workspace, confirmation_score: score, total_count: total, counts, outcomes }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    return false;
}

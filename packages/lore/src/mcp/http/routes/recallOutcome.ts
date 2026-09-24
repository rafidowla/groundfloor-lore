/**
 * recallOutcome.ts — 3.21 step 3(h). HTTP mirror of the MCP `recall_outcome`
 * tool: POST /api/recall/outcome.
 *
 * Split into its own file (mirrors outcomes.ts's existing precedent for
 * `/api/nodes/:id/outcomes`) rather than folded into search.ts, which is
 * already near CLAUDE.md's 800-line file-size hard cap.
 *
 * Feeds the EXISTING outcome-weighting mechanism via
 * recall/recallOutcome.ts's applyRecallOutcome() — same 'success'/
 * 'failure'/'partial' vocabulary and meaning as record_outcome / POST
 * /api/nodes/:id/outcomes (the outcome of ACTING on the recalled memory,
 * not a relevance judgment — see that file's doc comment for why a
 * separate relevance vocabulary was rejected). No new ranking math lives
 * here or there.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import type { AuxStore } from '../../../outbox/auxStore.js';
import type { VersionStore } from '../../../outbox/versionStore.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import {
    readBoundedBody, isPayloadTooLarge, writeOversizeError, writeWorkspaceRequired,
    writeError, extractWorkspace, parseJsonBody, isInvalidJsonBody, writeInvalidJson,
} from '../helpers.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';
import { applyRecallOutcome, isRecallOutcomeValue } from '../../../recall/recallOutcome.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';

type LoreGraph = LoreGraphHandle;

export interface RecallOutcomeRouteDeps {
    store: StorageBundle;
    auxStore?: AuxStore;
    versionStore?: VersionStore;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    graphRegistry?: LocalGraphRegistry;
}

/**
 * POST /api/recall/outcome — body {node_id, workspace, outcome, query_id?,
 * recorded_by?}. `deps.auxStore` absent (cloud/tests without it wired) ⇒
 * this route is not mounted at all (see dispatcher.ts's `deps.auxStore &&`
 * guard, matching /api/nodes/:id/outcomes's own gating).
 */
export async function tryRecallOutcomeRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: RecallOutcomeRouteDeps,
): Promise<boolean> {
    if (pathname !== '/api/recall/outcome' || req.method !== 'POST') return false;
    if (!deps.auxStore) {
        writeError(res, 501, 'not_configured', 'outcome tracking is not wired on this deployment');
        return true;
    }
    const auxStore = deps.auxStore;

    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'write' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

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
            node_id?: string;
            workspace?: string;
            outcome?: string;
            query_id?: string;
            recorded_by?: string;
        };
        const queryParams = new URL(url, 'http://localhost').searchParams;
        const workspace = extractWorkspace(parsed as Record<string, unknown>, queryParams);
        if (!workspace) {
            writeWorkspaceRequired(res);
            return true;
        }
        if (workspace === '*') {
            writeError(res, 400, 'cross_workspace_not_supported', '/api/recall/outcome requires a single named workspace');
            return true;
        }
        if (!parsed.node_id || typeof parsed.node_id !== 'string') {
            writeError(res, 400, 'invalid_request', '`node_id` is required');
            return true;
        }
        if (!isRecallOutcomeValue(parsed.outcome)) {
            writeError(res, 400, 'invalid_request', '`outcome` must be one of: success, failure, partial');
            return true;
        }
        // D-021 — per-token write-scope gate on the REAL target workspace.
        if (bindRouteTarget(res, { requested: workspace, intent: 'write' }) === null) return true;

        let graph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            try {
                graph = await deps.graphRegistry.getGraphHandle(workspace);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found', `workspace not found: ${err.requested}`, { requested: err.requested, known: err.known });
                    return true;
                }
                throw err;
            }
        }

        const result = await applyRecallOutcome({
            auxStore, graph, versionStore: deps.versionStore,
            nodeId: parsed.node_id, workspace, outcome: parsed.outcome,
            queryId: parsed.query_id, recordedBy: parsed.recorded_by, principal: 'http',
        });
        if (!result.ok) {
            writeError(res, 404, 'node_not_found', `node not found: ${parsed.node_id}`, { node_id: parsed.node_id });
            return true;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            outcome_id: result.outcomeId,
            node_id: parsed.node_id,
            workspace,
            outcome: parsed.outcome,
            status: result.status,
            new_confirmation_score: result.newConfirmationScore,
            counts: result.counts,
            ...(parsed.query_id ? { query_id: parsed.query_id } : {}),
        }));
    } catch (err) {
        if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
        writeError(res, 500, 'internal_error', redactError(err));
    }
    return true;
}

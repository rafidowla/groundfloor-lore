/**
 * supersede.ts — POST /api/node/supersede + /api/node/unsupersede.
 *
 * HTTP/CLI mirrors of the supersede_node / unsupersede_node MCP tools:
 *   - supersede:   soft-supersede oldId → newId (body { oldId, newId, reason? })
 *   - unsupersede: reverse a supersession (body { id })
 * Both require an explicit workspace (Sprint L1c — no silent fallback).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { gateRoute } from '../../../../security/routeGate.js';
import { bindRouteTarget } from '../../../../security/routeWorkspaceBinding.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeWorkspaceRequired, extractWorkspace, writeError } from '../../helpers.js';
import { WorkspaceNotFoundError } from '../../../../engines/localGraphRegistry.js';
import { recordHotWrite } from '../../../../outbox/hotLane.js';
import { log } from '../../../../logger.js';
import type { LoreGraph, NodesDeps } from './types.js';
import { redactError } from '../../../../security/logRedact.js';

export async function handleSupersede(req: IncomingMessage, res: ServerResponse, url: string, deps: NodesDeps): Promise<void> {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'write' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    // L-068 — gateRoute above is a no-op in local mode, so the per-token
    // write-scope gate below is the real authz boundary. It is applied AFTER
    // the body is parsed so it can check the REQUESTED workspace (the actual
    // write target), not the caller's own. Null principal = local/legacy bypass.
    let body: string;
    try {
        body = await readBoundedBody(req);
    } catch (err) {
        if (isPayloadTooLarge(err)) { writeOversizeError(res); return; }
        writeError(res, 400, 'bad_request', redactError(err));
        return;
    }
    try {
        const parsed = JSON.parse(body || '{}') as { oldId?: string; newId?: string; reason?: string; workspace?: string; project?: string };
        // Sprint L1c — workspace required (writer). No silent fallback.
        const supersedeWs = extractWorkspace(parsed as Record<string, unknown>, new URL(url, 'http://localhost').searchParams);
        if (!supersedeWs) { writeWorkspaceRequired(res); return; }
        // RA2-reaudit2/D-021 — bind write-scope on the REQUESTED workspace
        // (`supersedeWs`, the target of getOrOpen below), not the caller's own.
        // Pre-fix, an app token bound to A — holding only `write`, not
        // `cross-workspace-write` — could supersede nodes in B.
        if (bindRouteTarget(res, { requested: supersedeWs, intent: 'write' }) === null) return;
        if (!parsed.oldId || !parsed.newId) {
            writeError(res, 400, 'bad_request', '`oldId` and `newId` are required in POST body');
            return;
        }
        // NW-3a (api-001) — resolve the registry-bound target graph for
        // `supersedeWs` and write THERE, mirroring postNode.ts. Pre-fix,
        // this route validated `workspace` but called the boot-bound
        // storageClient, so the supersede landed in the default graph
        // regardless of the param.
        let targetGraph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            try {
                // getGraphHandle honours the workspace's declared engine —
                // getOrOpen is the Kùzu substrate accessor and used to land
                // supersede/unsupersede on a Surreal workspace's unused, empty
                // Kùzu graph instead. Still runs assertWorkspaceOpenAllowed.
                targetGraph = await deps.graphRegistry.getGraphHandle(supersedeWs);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found', `workspace not found: ${err.requested}`, {
                        requested: err.requested,
                        known: err.known,
                    });
                    return;
                }
                throw err;
            }
        }
        const result = await targetGraph.supersedeNode(parsed.oldId, parsed.newId, parsed.reason);
        if (result.ok) {
            // Parity with the supersede_node MCP tool (its Fix #3 / C-R3-02
            // block): also write the semantic `supersedes` edge so the
            // supersession is queryable via traverse()/subgraph from the REST
            // surface — pre-fix only the MCP tool wrote it, so traverse showed
            // no supersession for REST-driven supersedes. Outbox-first
            // (durable + crash-replay), same edge shape, still non-fatal: the
            // denormalized supersededBy field is the authoritative recall
            // filter; an edge failure is LOGGED, never silently dropped.
            const supersedeEdge = {
                sourceId: parsed.newId,
                targetId: parsed.oldId,
                relation: 'supersedes',
                confidence: 'extracted' as const,
                confidenceScore: 1.0,
            };
            try {
                if (deps.outboxStore) {
                    await recordHotWrite(deps.outboxStore, {
                        workspace: supersedeWs,
                        operationKind: 'edge.upsert',
                        payload: supersedeEdge,
                        initiator: 'http:POST /api/node/supersede',
                        operation: 'edge.upsert',
                    });
                }
                await targetGraph.addEdge(supersedeEdge);
            } catch (edgeErr) {
                log.warn(`[Lore] POST /api/node/supersede: supersedes edge ${parsed.newId}->${parsed.oldId} failed (non-fatal; supersededAt is authoritative): ${redactError(edgeErr)}`);
            }
        }
        deps.auditLog.log({
            toolName: 'supersede_node',
            args: { oldId: parsed.oldId, newId: parsed.newId, reason: parsed.reason ?? null, surface: 'http' },
            result: result.ok ? 'success' : 'error',
            resultDetail: result.ok ? undefined : result.reason,
            durationMs: 0,
        });
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (supErr) {
        writeError(res, 500, 'internal_error', redactError(supErr));
    }
}

export async function handleUnsupersede(req: IncomingMessage, res: ServerResponse, url: string, deps: NodesDeps): Promise<void> {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'write' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    // L-068 / RA2-reaudit2 — write-scope gate applied AFTER parse, on the
    // requested workspace (see handleSupersede). Null principal = local bypass.
    let body: string;
    try {
        body = await readBoundedBody(req);
    } catch (err) {
        if (isPayloadTooLarge(err)) { writeOversizeError(res); return; }
        writeError(res, 400, 'bad_request', redactError(err));
        return;
    }
    try {
        const parsed = JSON.parse(body || '{}') as { id?: string; workspace?: string; project?: string };
        // Sprint L1c — workspace required (writer). No silent fallback.
        const unsupersedeWs = extractWorkspace(parsed as Record<string, unknown>, new URL(url, 'http://localhost').searchParams);
        if (!unsupersedeWs) { writeWorkspaceRequired(res); return; }
        // RA2-reaudit2/D-021 — bind on the REQUESTED workspace, not the caller's own.
        if (bindRouteTarget(res, { requested: unsupersedeWs, intent: 'write' }) === null) return;
        if (!parsed.id) {
            writeError(res, 400, 'bad_request', '`id` is required in POST body');
            return;
        }
        // NW-3a (api-001) — same workspace-routing fix as supersede above.
        let targetGraph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            try {
                targetGraph = await deps.graphRegistry.getGraphHandle(unsupersedeWs);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found', `workspace not found: ${err.requested}`, {
                        requested: err.requested,
                        known: err.known,
                    });
                    return;
                }
                throw err;
            }
        }
        // 2026-08-17 (functional-correctness, cluster 4 medium) — capture the
        // CURRENT supersededBy BEFORE unsupersedeNode clears it, so the
        // `supersedes` edge handleSupersede wrote (newId -[supersedes]->
        // oldId) can be removed too. Without this, unsupersede reversed the
        // denormalized field but left the graph edge asserting the
        // supersession forever — traverse()/subgraph kept showing it.
        const beforeNode = await targetGraph.getNode(parsed.id);
        const priorSupersededBy = beforeNode?.supersededBy ?? null;
        const ok = await targetGraph.unsupersedeNode(parsed.id);
        if (ok && priorSupersededBy) {
            try {
                await targetGraph.deleteEdge(priorSupersededBy, parsed.id, 'supersedes');
            } catch (edgeErr) {
                log.warn(`[Lore] POST /api/node/unsupersede: supersedes edge ${priorSupersededBy}->${parsed.id} removal failed (non-fatal; supersededBy is authoritative): ${redactError(edgeErr)}`);
            }
        }
        deps.auditLog.log({
            toolName: 'unsupersede_node',
            args: { id: parsed.id, surface: 'http' },
            result: ok ? 'success' : 'error',
            resultDetail: ok ? undefined : 'not-found',
            durationMs: 0,
        });
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
    } catch (unsupErr) {
        writeError(res, 500, 'internal_error', redactError(unsupErr));
    }
}

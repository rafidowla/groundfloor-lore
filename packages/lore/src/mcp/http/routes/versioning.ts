/**
 * versioning.ts — HTTP mirrors for the versioning MCP tools (Feature 8).
 *
 *   GET  /api/nodes/:id/history            — version log for a single node
 *   GET  /api/workspaces/:name/diff        — workspace changes since a timestamp
 *   POST /api/changesets                   — open a new atomic changeset
 *   POST /api/changesets/:id/commit        — commit buffered writes
 *   POST /api/changesets/:id/rollback      — discard or reverse a changeset
 *   GET  /api/workspaces/:name/snapshot    — export workspace state as JSONL
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import type { VersionStore } from '../../../outbox/versionStore.js';
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import type { LoreNode } from '../../../providers/types.js';
import { gateRoute } from '../../../security/routeGate.js';
// Widened for the Kùzu removal: naming the two CONCRETE classes silently
// excluded SurrealGraph (see engines/htmlExport.ts). Need more than the
// shared handle? Feature-detect and refuse — do not re-narrow to a class.
type LoreGraph = LoreGraphHandle;
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeError } from '../helpers.js';
import { bindRouteTarget, isLegacyBypass } from '../../../security/routeWorkspaceBinding.js';
import { resolveTargetGraph } from '../../tools/workspaceResolve.js';
import { redactError } from '../../../security/logRedact.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import type { OutboxStore } from '../../../outbox/types.js';
import type { VerbatimStore } from '../../../engines/verbatimStore.js';
// 1.M7 (2026-08-17 audit) — changeset commit/rollback write through the
// shared orchestration (outbox + verbatim + embed), not raw graph writes.
import { applyChangesetUpsert, applyChangesetDelete, type ChangesetWriteDeps } from '../../changesetWrite.js';

export interface VersioningRouteDeps {
    versionStore: VersionStore;
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    /** 1.M7 — changeset write orchestration. Optional; absent → inline
     *  verbatim via the storage facade (cloud / tests). */
    outboxStore?: OutboxStore;
    embedQueue?: { enqueue: (nodeId: string, text: string, workspace?: string) => void };
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<VerbatimStore> };
}

/** 1.M7 — build the shared changeset-write deps for one initiator label. */
function changesetWriteDeps(deps: VersioningRouteDeps, workspace: string, initiator: string): ChangesetWriteDeps {
    return {
        outboxStore: deps.outboxStore,
        embedQueue: deps.embedQueue,
        verbatim: deps.store.storageClient,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
        bootVerbatim: deps.store.loreVerbatim,
        activeWorkspace: workspace,
        initiator,
    };
}

export async function tryVersioningRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: VersioningRouteDeps,
): Promise<boolean> {

    /* ─── GET /api/nodes/:id/history ────────────────────────────── */
    const historyMatch = /^\/api\/nodes\/([^/]+)\/history$/.exec(pathname);
    if (historyMatch && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const nodeId = historyMatch[1];
            const params = new URL(url, 'http://localhost').searchParams;
            const requestedWs = params.get('workspace') ?? undefined;
            // The pure legacy/direct-call bypass (no principal/slot/requested) is
            // the ONE case bindRouteTarget returns null without writing a denial;
            // it falls back to the historical empty-string default. Otherwise a
            // null return is a scope DENIAL (4xx already written) — stop. Detected
            // up front so we never depend on res.headersSent (stub responses
            // don't track it).
            let workspace: string;
            if (isLegacyBypass(requestedWs)) {
                workspace = '';
            } else {
                const target = bindRouteTarget(res, { requested: requestedWs, intent: 'read' });
                if (target === null) return true;
                workspace = target;
            }
            const limit = Math.min(200, Math.max(1, parseInt(params.get('limit') ?? '50', 10) || 50));
            const versions = deps.versionStore.getVersions(nodeId, workspace, limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ node_id: nodeId, workspace, count: versions.length, versions }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    /* ─── GET /api/workspaces/:name/diff ────────────────────────── */
    const diffMatch = /^\/api\/workspaces\/([^/]+)\/diff$/.exec(pathname);
    if (diffMatch && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const workspace = diffMatch[1];
            if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return true;
            const params = new URL(url, 'http://localhost').searchParams;
            const since = params.get('since') ?? '';
            const limit = Math.min(1000, Math.max(1, parseInt(params.get('limit') ?? '200', 10) || 200));
            if (!since) {
                writeError(res, 400, 'invalid_request', '`since` query param is required (ISO 8601 timestamp)');
                return true;
            }
            const all = deps.versionStore.getDiff(workspace, since);
            const trimmed = all.slice(0, limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ workspace, since, total: all.length, returned: trimmed.length, changes: trimmed }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    /* ─── POST /api/changesets ──────────────────────────────────── */
    if (pathname === '/api/changesets' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode, so without this a read-only app token could invoke this
        // mutating route. First phase binds to the caller's own workspace (the
        // body hasn't been parsed yet). The pure legacy/direct-call bypass is the
        // ONE null-without-denial case — it falls through to the body-workspace
        // re-gate below. Otherwise a null return is a DENIAL. Detected up front so
        // we never depend on res.headersSent (stub responses don't track it).
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
            const parsed = JSON.parse(body || '{}') as { workspace?: string };
            if (!parsed.workspace || typeof parsed.workspace !== 'string') {
                writeError(res, 400, 'invalid_request', '`workspace` is required in POST body');
                return true;
            }
            // R4 #2 — re-gate on the REAL target. The first-phase bind above
            // targeted the caller's OWN workspace so it never authorized the
            // body workspace; createChangeset binds the changeset to
            // parsed.workspace, and commit/rollback later apply node
            // upserts/DELETES into it. Without this a workspace-A token could
            // create (and then commit) a changeset in workspace B.
            const target = bindRouteTarget(res, { requested: parsed.workspace, intent: 'write' });
            if (target === null) return true;
            const changesetId = deps.versionStore.createChangeset(parsed.workspace);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ changeset_id: changesetId, workspace: parsed.workspace, status: 'open' }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    /* ─── POST /api/changesets/:id/commit ──────────────────────── */
    const commitMatch = /^\/api\/changesets\/([^/]+)\/commit$/.exec(pathname);
    if (commitMatch && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. First phase binds to the caller's own workspace (the
        // changeset hasn't been looked up yet). The pure legacy/direct-call
        // bypass is the ONE null-without-denial case — it falls through to the
        // changeset-workspace re-gate below. Otherwise a null return is a DENIAL.
        // Detected up front so we never depend on res.headersSent (stub responses
        // don't track it).
        if (!isLegacyBypass(undefined) &&
            bindRouteTarget(res, { intent: 'write' }) === null) return true;
        try {
            const changesetId = commitMatch[1];
            const cs = deps.versionStore.getChangeset(changesetId);
            if (!cs) {
                writeError(res, 404, 'changeset_not_found', `changeset not found: ${changesetId}`, { changeset_id: changesetId });
                return true;
            }
            // R4 #2 — gate on the CHANGESET's workspace (the real write target);
            // the first-phase bind above targeted the caller's own workspace.
            // commit applies the staged upsertNode/deleteNode into cs.workspace's
            // graph below.
            if (bindRouteTarget(res, { requested: cs.workspace, intent: 'write' }) === null) return true;
            if (cs.status !== 'open') {
                writeError(res, 409, 'changeset_not_open', `changeset is not open (status: ${cs.status})`, { status: cs.status });
                return true;
            }

            const writes = deps.versionStore.getChangesetWrites(changesetId);
            let applied = 0;
            let failed = 0;
            const errors: string[] = [];

            // Local-mode routing: apply writes to the changeset's OWN workspace,
            // not the boot/active store. Registry absent (cloud/tests) →
            // resolveTargetGraph returns the boot store, so behavior is unchanged.
            const gres = await resolveTargetGraph(deps.store, deps.graphRegistry, cs.workspace, cs.workspace);
            if (!gres.ok) {
                if ('missing' in gres) {
                    writeError(res, 400, 'workspace_required', 'pass workspace=<name> as body field or query param', { changeset_id: changesetId });
                    return true;
                }
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${gres.requested}`, { requested: gres.requested, known: gres.known });
                return true;
            }
            const graph = gres.graph as LoreGraph;
            await graph.initialize();

            for (const w of writes) {
                try {
                    if (w.operation === 'upsert_node') {
                        const p = w.payload as { workspace: string; nodeData: Record<string, unknown> };
                        const nodeId = String(p.nodeData['id'] ?? '');
                        const prevNode = await graph.getNode(nodeId);
                        // 1.M7 — route through nodeService (outbox +
                        // verbatim + embed) instead of a raw graph write.
                        await applyChangesetUpsert(
                            changesetWriteDeps(deps, cs.workspace, 'http:POST /api/changesets/:id/commit'),
                            graph, p.workspace, p.nodeData,
                        );
                        deps.versionStore.recordVersion({
                            versionId: randomUUID(), nodeId, workspace: p.workspace,
                            timestamp: new Date().toISOString(), principal: 'changeset',
                            operation: 'upsert',
                            previousState: prevNode ?? null,
                            newState: p.nodeData,
                            changesetId,
                        });
                        applied++;
                    } else if (w.operation === 'delete_node') {
                        const p = w.payload as { workspace: string; node_id: string };
                        const prevNode = await graph.getNode(p.node_id);
                        // 1.M7 — graph delete + verbatim tombstone.
                        await applyChangesetDelete(
                            changesetWriteDeps(deps, cs.workspace, 'http:POST /api/changesets/:id/commit'),
                            graph, p.workspace, p.node_id,
                            'node deleted via changeset commit',
                        );
                        deps.versionStore.recordVersion({
                            versionId: randomUUID(), nodeId: p.node_id, workspace: p.workspace,
                            timestamp: new Date().toISOString(), principal: 'changeset',
                            operation: 'delete',
                            previousState: prevNode ?? null,
                            newState: null,
                            changesetId,
                        });
                        applied++;
                    }
                } catch (writeErr) {
                    errors.push(`seq ${w.seq}: ${(writeErr as Error).message}`);
                    failed++;
                }
            }

            deps.versionStore.updateChangeset(changesetId, 'committed');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ changeset_id: changesetId, status: 'committed', applied, failed, errors }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    /* ─── POST /api/changesets/:id/rollback ────────────────────── */
    const rollbackMatch = /^\/api\/changesets\/([^/]+)\/rollback$/.exec(pathname);
    if (rollbackMatch && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. First phase binds to the caller's own workspace (the
        // changeset hasn't been looked up yet). The pure legacy/direct-call
        // bypass is the ONE null-without-denial case — it falls through to the
        // changeset-workspace re-gate below. Otherwise a null return is a DENIAL.
        // Detected up front so we never depend on res.headersSent (stub responses
        // don't track it).
        if (!isLegacyBypass(undefined) &&
            bindRouteTarget(res, { intent: 'write' }) === null) return true;
        try {
            const changesetId = rollbackMatch[1];
            const cs = deps.versionStore.getChangeset(changesetId);
            if (!cs) {
                writeError(res, 404, 'changeset_not_found', `changeset not found: ${changesetId}`, { changeset_id: changesetId });
                return true;
            }
            // R4 #2 — gate on the CHANGESET's workspace (the real write target);
            // the first-phase bind above targeted the caller's own workspace.
            // rollback reverses staged upsertNode/deleteNode into cs.workspace's
            // graph below.
            if (bindRouteTarget(res, { requested: cs.workspace, intent: 'write' }) === null) return true;
            if (cs.status === 'rolled_back') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ changeset_id: changesetId, status: 'rolled_back', note: 'already rolled back — no-op' }));
                return true;
            }
            if (cs.status === 'open') {
                deps.versionStore.updateChangeset(changesetId, 'rolled_back');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ changeset_id: changesetId, status: 'rolled_back', reversed: 0, note: 'open changeset discarded before any writes' }));
                return true;
            }

            // committed — reverse each versioned write (newest-first)
            const versions = deps.versionStore.getVersionsByChangeset(changesetId);
            let reversed = 0;
            let failed = 0;
            const errors: string[] = [];

            // Local-mode routing: reverse writes on the changeset's OWN workspace,
            // not the boot/active store. Registry absent → boot store (unchanged).
            const gres = await resolveTargetGraph(deps.store, deps.graphRegistry, cs.workspace, cs.workspace);
            if (!gres.ok) {
                if ('missing' in gres) {
                    writeError(res, 400, 'workspace_required', 'pass workspace=<name> as body field or query param', { changeset_id: changesetId });
                    return true;
                }
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${gres.requested}`, { requested: gres.requested, known: gres.known });
                return true;
            }
            const graph = gres.graph as LoreGraph;
            await graph.initialize();

            for (const v of [...versions].reverse()) {
                try {
                    if (v.previousState != null) {
                        // 1.M7 — restore through nodeService so the REVERTED
                        // text also reaches the search index.
                        await applyChangesetUpsert(
                            changesetWriteDeps(deps, cs.workspace, 'http:POST /api/changesets/:id/rollback'),
                            graph, v.workspace, v.previousState as unknown as Record<string, unknown>,
                        );
                    } else if (v.operation === 'upsert') {
                        await applyChangesetDelete(
                            changesetWriteDeps(deps, cs.workspace, 'http:POST /api/changesets/:id/rollback'),
                            graph, v.workspace, v.nodeId,
                            'node created by rolled-back changeset',
                        );
                    }
                    reversed++;
                } catch (revErr) {
                    errors.push(`${v.nodeId}: ${(revErr as Error).message}`);
                    failed++;
                }
            }

            deps.versionStore.updateChangeset(changesetId, 'rolled_back');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ changeset_id: changesetId, status: 'rolled_back', reversed, failed, errors }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    /* ─── GET /api/workspaces/:name/snapshot ────────────────────── */
    const snapshotMatch = /^\/api\/workspaces\/([^/]+)\/snapshot$/.exec(pathname);
    if (snapshotMatch && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const workspace = snapshotMatch[1];
            if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return true;
            const params = new URL(url, 'http://localhost').searchParams;
            const includeArchived = params.get('include_archived') === 'true';

            // Local-mode routing: snapshot the REQUESTED workspace, not the
            // boot/active store. Registry absent → boot store (unchanged).
            const gres = await resolveTargetGraph(deps.store, deps.graphRegistry, workspace, workspace);
            if (!gres.ok) {
                if ('missing' in gres) {
                    writeError(res, 400, 'workspace_required', 'pass workspace=<name> as body field or query param');
                    return true;
                }
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${gres.requested}`, { requested: gres.requested, known: gres.known });
                return true;
            }
            const graph = gres.graph as LoreGraph;
            await graph.initialize();

            // R4 #7 — `'*'`, not the workspace name. The 4th argument is `project`, a
            // CALLER-OWNED node field that every engine turns into a strict
            // `n.project = $project`; it is not guaranteed to equal the workspace name
            // (Atlas stores project='v3' inside workspace='default', and any explicit
            // `project` on a write is preserved verbatim). retrieve.ts:314-321 documents
            // this substitution as the mistake that "silently makes keyword fallback
            // empty while the vector path still appears healthy". The physical workspace
            // boundary is already enforced by the graph resolved above — each workspace
            // is its own database — so the name here only ever DROPPED that workspace's
            // own rows.
            const allNodes = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
            const filtered = includeArchived
                ? allNodes
                : allNodes.filter((n) => !n.status || n.status !== 'archived');
            const jsonl = filtered.map((n) => JSON.stringify(n)).join('\n');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ workspace, format: 'jsonl', node_count: filtered.length, snapshot: jsonl }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    return false;
}

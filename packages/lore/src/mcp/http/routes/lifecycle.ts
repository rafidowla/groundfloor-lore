/**
 * lifecycle.ts — HTTP mirrors for the lifecycle MCP tools (Feature 1).
 *
 *   POST /api/nodes/prune          — archive or hard-delete nodes by filter
 *   POST /api/nodes/:id/restore    — un-archive a node back to active
 *   GET  /api/prune-jobs/:id       — poll a prune job status
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import type { AuxStore } from '../../../outbox/auxStore.js';
import type { VersionStore } from '../../../outbox/versionStore.js';
import { loadWorkspaces } from '../../../config/workspaces.js';
// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import type { WorkspaceVerbatimResolver } from '../../../outbox/workspaceVerbatimResolver.js';
import { resolveTargetGraph } from '../../tools/workspaceResolve.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeError, writeWorkspaceRequired, parseJsonBody, isInvalidJsonBody, writeInvalidJson } from '../helpers.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import { bindRouteTarget, isLegacyBypass } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';
import { withNodeLock } from '../../../core/nodeWriteLock.js';
import { recordHotWrite } from '../../../outbox/hotLane.js';
import type { OutboxStore } from '../../../outbox/types.js';
import type { WriteAheadLog } from '../../../engines/syncEngine.js';

export interface LifecycleRouteDeps {
    store: StorageBundle;
    auxStore: AuxStore;
    versionStore?: VersionStore;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    /**
     * Local-mode per-workspace graph registry (Postgres model). When present,
     * each listed op routes its graph read/write to the REQUESTED workspace
     * instead of the boot/active store. Absent (cloud/tests) → resolver falls
     * back to the boot store, so behavior is unchanged.
     */
    graphRegistry?: LocalGraphRegistry;
    /** Postgres-model isolation — opens the REQUESTED workspace's VerbatimStore
     *  for the hard-delete tombstone. Absent (cloud/tests) → boot fallback. */
    workspaceVerbatimResolver?: WorkspaceVerbatimResolver;
    /**
     * 2026-09-03 (A2 finding 2 fix) — when wired, hard_delete records a
     * `verbatim.tombstone` outbox row (after its `node.delete` row) so a
     * replay of a stale `verbatim.upsert` from an earlier create can't
     * outlive the delete and resurrect the tombstoned content. Optional so
     * cloud mode / tests that don't wire an outbox keep the prior
     * direct-tombstone-only behavior.
     */
    outboxStore?: OutboxStore;
    /**
     * ITEM X-walnode (2026-09-03) — when wired, hard_delete appends a
     * `delete_node` WAL entry (active-workspace only), mirroring the MCP
     * prune sibling and store_node / store_edge / delete_node. Optional so
     * cloud mode / tests that don't wire a WAL keep prior behavior.
     */
    getWal?: () => WriteAheadLog;
}

export async function tryLifecycleRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: LifecycleRouteDeps,
): Promise<boolean> {

    /* ─── POST /api/nodes/prune ─────────────────────────────────── */
    if (pathname === '/api/nodes/prune' && req.method === 'POST') {
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
                workspace?: string;
                dry_run?: boolean;
                classification?: string;
                older_than_days?: number;
                tags?: string;
                hard_delete?: boolean;
            };
            if (!parsed.workspace || typeof parsed.workspace !== 'string') {
                writeError(res, 400, 'invalid_request', '`workspace` is required in POST body');
                return true;
            }
            const workspace = parsed.workspace;

            // L-048 — per-token write-scope gate, mirroring DELETE /api/node
            // (nodes-delete.ts:96-111). The ReBAC gateRoute above covers the
            // deployment-mode/SpiceDB axis; this covers the per-token axis so a
            // read-only or cross-workspace-restricted Bearer can't prune.
            // Null principal (local/legacy) bypasses — preserved.
            if (bindRouteTarget(res, { requested: workspace, intent: 'write' }) === null) return true;

            const dry_run = parsed.dry_run !== false; // default true
            const hard_delete = parsed.hard_delete === true;

            // L-031 — the prune route is gated on 'write' above (covers the
            // archive/soft path). A hard_delete is destructive and must
            // additionally hold the finer 'delete' permission (mirrors
            // config.ts drop). In local mode gateRoute short-circuits
            // allowed:true, so this is a no-op for single-operator daemons.
            if (hard_delete) {
                const delGate = await gateRoute(
                    { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
                    { permission: 'delete' },
                );
                if (!delGate.allowed) { writePermissionDenied(res, delGate); return true; }
            }

            const wsFile = loadWorkspaces();
            const wsEntry = wsFile.workspaces.find((w) => w.name === workspace);
            if (!wsEntry) {
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${workspace}`, { workspace });
                return true;
            }
            if (hard_delete && !(wsEntry as unknown as Record<string, unknown>).allowHardDelete) {
                writeError(
                    res, 403, 'hard_delete_not_allowed',
                    'Set allowHardDelete=true in workspaces.json for this workspace to enable permanent deletion.',
                );
                return true;
            }

            // Local-mode routing (Postgres model): resolve the REQUESTED
            // workspace's graph, not the boot/active store. The wsEntry check
            // above already 404s unknown workspaces; the resolver's
            // {ok:false,...} branches stay for the registry path / defense.
            // graphRegistry undefined (cloud/tests) → resolver returns the boot
            // store, preserving prior behavior.
            const activeWorkspace = getCurrentPrincipal()?.workspace ?? workspace;
            const graphRes = await resolveTargetGraph(deps.store, deps.graphRegistry, activeWorkspace, workspace);
            if (!graphRes.ok) {
                if ('missing' in graphRes) {
                    writeError(res, 400, 'workspace_required', '`workspace` is required in POST body');
                    return true;
                }
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${graphRes.requested}`, { requested: graphRes.requested, known: graphRes.known });
                return true;
            }
            const graph = graphRes.graph as LoreGraph;
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

            const cutoff = typeof parsed.older_than_days === 'number'
                ? new Date(Date.now() - parsed.older_than_days * 86400000).toISOString()
                : null;

            const filterTags = parsed.tags
                ? parsed.tags.split(',').map((t) => t.toLowerCase().trim()).filter(Boolean)
                : [];

            const matched: typeof allNodes = [];
            let protectedCount = 0;

            for (const node of allNodes) {
                if (node.status === 'protected') {
                    if (
                        (!parsed.classification || node.classification === parsed.classification) &&
                        (!cutoff || node.createdAt < cutoff)
                    ) {
                        protectedCount++;
                    }
                    continue;
                }
                if (node.status === 'archived') continue;
                if (parsed.classification && node.classification !== parsed.classification) continue;
                if (cutoff && node.createdAt >= cutoff) continue;
                if (filterTags.length > 0) {
                    // node.tags is a normalized lowercase string[] (Pass 3).
                    if (!filterTags.every((t) => (node.tags ?? []).includes(t))) continue;
                }
                matched.push(node);
            }

            if (dry_run) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    dry_run: true,
                    workspace,
                    matched: matched.length,
                    protected_count: protectedCount,
                    would_archive: hard_delete ? 0 : matched.length,
                    would_hard_delete: hard_delete ? matched.length : 0,
                    preview: matched.slice(0, 20).map((n) => ({
                        id: n.id, type: n.type, label: n.label,
                        classification: n.classification ?? 'tactical',
                        createdAt: n.createdAt,
                    })),
                    hint: 'Re-run with dry_run=false to apply changes.',
                }));
                return true;
            }

            const jobId = deps.auxStore.createPruneJob(workspace, {
                classification: parsed.classification as 'foundational' | 'tactical' | 'observational' | undefined,
                olderThanDays: parsed.older_than_days,
                tags: parsed.tags,
                hardDelete: hard_delete,
                dryRun: false,
            });

            let archived = 0;
            let hardDeleted = 0;
            let skipped = 0;

            for (const node of matched) {
                try {
                    // QA A2 finding 1 (2026-09-03) — `node` here is a STALE
                    // snapshot from the pre-loop listNodes() read above. A
                    // concurrent POST /api/node upsert can land on this id
                    // AFTER the snapshot but BEFORE this id's turn in the loop
                    // (prune may be iterating thousands of other ids first —
                    // no lock contention needed, just elapsed wall-clock time).
                    // Writing `{ ...node, status: 'archived' }` inside the lock
                    // would silently REVERT that concurrent write to its
                    // pre-loop content — the lock only serializes access, it
                    // does not refresh the snapshot. Fix: re-read the node
                    // fresh INSIDE the lock and re-check the SAME eligibility
                    // filters that built `matched`; skip (don't touch it) if it
                    // no longer qualifies or is gone, and patch status onto the
                    // fresh read instead of the stale one. The graph write +
                    // its verbatim tombstone run under the SAME
                    // per-(workspace,id) lock `nodeUpsert` holds
                    // (core/nodeWriteLock.ts), so a concurrent same-id
                    // POST /api/node cannot interleave between them
                    // (hard-delete). Raw substrate primitives only inside — no
                    // lock re-entry (nodeWriteLock.ts rule 1).
                    const applied = await withNodeLock(workspace, node.id, async (): Promise<
                        { kind: 'archive' | 'hard_delete'; node: typeof node } | null
                    > => {
                        const fresh = await graph.getNode(node.id);
                        if (!fresh) return null; // deleted since the snapshot.
                        if (fresh.status === 'protected' || fresh.status === 'archived') return null;
                        if (parsed.classification && fresh.classification !== parsed.classification) return null;
                        if (cutoff && fresh.createdAt >= cutoff) return null;
                        if (filterTags.length > 0 && !filterTags.every((t) => (fresh.tags ?? []).includes(t))) return null;

                        if (hard_delete) {
                            // QA A2 round-2 finding 1 (2026-09-03) — record
                            // node.delete BEFORE the substrate delete, same
                            // outbox-first pattern as DELETE /api/node
                            // (nodes-delete.ts) and the MCP prune sibling.
                            // Without this, a still-pending node.upsert from
                            // this id's original create has nothing in the
                            // 'node' outbox family to supersede it, and a
                            // crash-recovery replay resurrects the node in
                            // the GRAPH after this hard delete.
                            if (deps.outboxStore) {
                                await recordHotWrite(deps.outboxStore, {
                                    workspace,
                                    operationKind: 'node.delete',
                                    payload: { id: fresh.id },
                                    initiator: 'http:prune',
                                    operation: 'node.delete',
                                });
                            }
                            await withTransactionConflictRetry(() => graph.deleteNode(fresh.id));
                            // audit 2026-06-18 — hard_delete must ALSO tombstone the LanceDB
                            // vector (mirrors delete_node F2a/L-056 + the MCP prune sibling).
                            // Graph-only delete left the embedding orphaned, so 'permanently
                            // deleted' content stayed semantically recallable. Non-fatal.
                            try {
                                // Postgres-model isolation — tombstone the REQUESTED
                                // workspace's LanceDB (the graph delete above already
                                // routed to it), not the boot/active store. getOrOpen
                                // is cached; boot fallback only when no resolver
                                // (cloud/tests). The delete fallback (for a backend
                                // lacking tombstone) MUST hit the SAME resolved store —
                                // routing it to deps.store.storageClient.verbatimDelete
                                // would delete from the ACTIVE workspace's LanceDB,
                                // orphaning B's vector and (on an id collision)
                                // corrupting A's, exactly the confinement leak this
                                // routing exists to prevent.
                                const targetVerbatim = deps.workspaceVerbatimResolver
                                    ? await deps.workspaceVerbatimResolver.getOrOpen(workspace)
                                    : deps.store.loreVerbatim;
                                const vstore = targetVerbatim as unknown as {
                                    tombstone?: (id: string, reason: string) => Promise<void>;
                                    delete?: (id: string) => Promise<void>;
                                };
                                const reason = 'graph node hard-deleted via /api/nodes/prune';
                                if (typeof vstore.tombstone === 'function') {
                                    await vstore.tombstone(`lore:${fresh.id}`, reason);
                                } else if (typeof vstore.delete === 'function') {
                                    await vstore.delete(`lore:${fresh.id}`);
                                }
                                // QA A2 finding 2 (2026-09-03) — record a
                                // verbatim.tombstone outbox row so a stale
                                // pending `verbatim.upsert` from an earlier
                                // POST /api/node on this id can't later replay
                                // AFTER this tombstone and resurrect the
                                // content (outbox/types.ts). Non-fatal: the
                                // synchronous tombstone above already ran.
                                if (deps.outboxStore) {
                                    await recordHotWrite(deps.outboxStore, {
                                        workspace,
                                        operationKind: 'verbatim.tombstone',
                                        payload: { id: `lore:${fresh.id}`, reason },
                                        initiator: 'http:prune',
                                        operation: 'verbatim.tombstone',
                                    });
                                }
                            } catch (vErr) {
                                console.error(`[Lore HTTP] prune verbatim tombstone failed for ${fresh.id}: ${(vErr as Error).message}`);
                            }
                            // ITEM X-walnode (2026-09-03) — append a
                            // `delete_node` WAL entry, same active-workspace
                            // gate `graphRes.isActive` uses elsewhere in this
                            // handler, still inside the SAME lock the delete
                            // + tombstone ran under.
                            if (graphRes.isActive && deps.getWal) {
                                deps.getWal().append('delete_node', { id: fresh.id, workspace });
                            }
                            return { kind: 'hard_delete', node: fresh };
                        }
                        await withTransactionConflictRetry(() => graph.upsertNode({ ...fresh, status: 'archived' }));
                        return { kind: 'archive', node: fresh };
                    });

                    if (!applied) {
                        skipped++;
                        continue;
                    }
                    if (applied.kind === 'hard_delete') hardDeleted++;
                    else archived++;

                    if (deps.versionStore) {
                        try {
                            deps.versionStore.recordVersion({
                                versionId: randomUUID(), nodeId: applied.node.id, workspace,
                                timestamp: new Date().toISOString(), principal: 'http',
                                operation: applied.kind === 'hard_delete' ? 'delete' : 'archive',
                                previousState: applied.node,
                                newState: applied.kind === 'hard_delete' ? null : { ...applied.node, status: 'archived' },
                                changesetId: null,
                            });
                        } catch { /* non-fatal */ }
                    }
                } catch {
                    skipped++;
                }
            }

            const jobResult = { matched: matched.length, archived, hardDeleted, skipped, protectedCount, dryRun: false };
            deps.auxStore.updatePruneJob(jobId, { status: 'completed', result: jobResult });

            if (archived > 0) deps.auxStore.incrementCounter(workspace, 'nodes_archived', archived);
            if (hardDeleted > 0) deps.auxStore.incrementCounter(workspace, 'nodes_hard_deleted', hardDeleted);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                job_id: jobId, workspace,
                matched: matched.length, archived,
                hard_deleted: hardDeleted, skipped,
                protected_count: protectedCount,
                dry_run: false,
            }));
        } catch (err) {
            // X-json400 (2026-09-03 audit) — malformed JSON used to fall
            // through to internal_error/500 here (client mistake reported
            // as a server crash); parseJsonBody's tagged error is caught
            // first now.
            if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    /* ─── POST /api/nodes/:id/restore ──────────────────────────── */
    const restoreMatch = /^\/api\/nodes\/([^/]+)\/restore$/.exec(pathname);
    if (restoreMatch && req.method === 'POST') {
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
            const nodeId = restoreMatch[1];
            const parsed = parseJsonBody(body) as { workspace?: string };
            const workspace = parsed.workspace ?? '';

            // B4 (audit 2026-06-18) — per-token write-scope gate, mirroring the
            // prune route above and DELETE /api/node. gateRoute covers the
            // deployment-mode/SpiceDB axis (a no-op in local mode); this covers
            // the per-token axis so a read-only Bearer can't un-delete/restore a
            // node, AND a cross-workspace restore without cross-workspace-write
            // fails closed with 403 workspace_forbidden (not a later 400 from
            // resolveTargetGraph). `workspace || undefined` resolves an empty
            // workspace against the principal's own bound workspace. Null
            // principal (local/legacy) bypasses — preserved (matches prune).
            //
            // bindRouteTarget returns null WITHOUT writing a denial only in the
            // pure legacy/direct-call-bypass case (no principal, no binding
            // slot, no requested workspace) — see routeWorkspaceBinding.ts step
            // 7. Since `requested` here is only undefined when the body omits
            // `workspace` entirely, checking `res.headersSent` to distinguish
            // "denied" from "bypass" is unreliable (stub ServerResponses in unit
            // tests don't track it — see schema.ts's identical caveat). Detect
            // the bypass up front via the shared isLegacyBypass helper so a real
            // 403 denial (principal present, cross-workspace) is never confused
            // with the no-target bypass: any other null return is a denial the
            // gate already wrote, so stop. In the bypass case itself there is no
            // target to route the restore to — pre-Wave-4 this returned 400
            // workspace_required, so restore it explicitly instead of a bodyless
            // handled=true (matches prune's `workspace` requirement above).
            const principal = getCurrentPrincipal();
            const requestedRestoreWorkspace = workspace || undefined;
            if (isLegacyBypass(requestedRestoreWorkspace)) {
                writeWorkspaceRequired(res);
                return true;
            }
            const boundRestoreTarget = bindRouteTarget(res, { requested: requestedRestoreWorkspace, intent: 'write' });
            if (boundRestoreTarget === null) return true; // denial already written.
            const effectiveWorkspace: string | undefined = boundRestoreTarget;

            // Local-mode routing (Postgres model): route the restore to the
            // REQUESTED workspace. An empty body workspace resolves against the
            // token's bound workspace (preserves the prior lenient behavior).
            // graphRegistry undefined (cloud/tests) → resolver returns the boot
            // store, preserving prior behavior.
            const graphRes = await resolveTargetGraph(deps.store, deps.graphRegistry, principal?.workspace ?? workspace, effectiveWorkspace);
            if (!graphRes.ok) {
                if ('missing' in graphRes) {
                    writeError(res, 400, 'workspace_required', 'pass workspace=<name> in POST body');
                    return true;
                }
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${graphRes.requested}`, { requested: graphRes.requested, known: graphRes.known });
                return true;
            }
            const graph = graphRes.graph as LoreGraph;
            await graph.initialize();

            // Read-modify-write on one id — the getNode AND the write it
            // derives from run inside the shared per-(workspace,id) lock
            // (core/nodeWriteLock.ts). Split across the lock boundary, a
            // concurrent same-id POST /api/node could land between them and
            // then be silently reverted to this pre-restore snapshot. Raw
            // graph primitives only: no re-entry (nodeWriteLock.ts rule 1).
            const restored = await withNodeLock(effectiveWorkspace, nodeId, async () => {
                const found = await graph.getNode(nodeId);
                if (!found) return null;
                const prev = found.status ?? 'active';
                await withTransactionConflictRetry(() => graph.upsertNode({ ...found, status: 'active' }));
                return { node: found, previousStatus: prev };
            });
            if (!restored) {
                writeError(res, 404, 'node_not_found', `node not found: ${nodeId}`, { id: nodeId });
                return true;
            }
            const { node, previousStatus } = restored;

            if (deps.versionStore) {
                try {
                    deps.versionStore.recordVersion({
                        versionId: randomUUID(), nodeId, workspace,
                        timestamp: new Date().toISOString(), principal: 'http',
                        operation: 'restore',
                        previousState: { ...node, status: previousStatus },
                        newState: { ...node, status: 'active' },
                        changesetId: null,
                    });
                } catch { /* non-fatal */ }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, id: nodeId, previous_status: previousStatus, new_status: 'active' }));
        } catch (err) {
            // X-json400 (2026-09-03 audit) — same fix as the prune route above.
            if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    /* ─── GET /api/prune-jobs/:id ───────────────────────────────── */
    const pruneJobMatch = /^\/api\/prune-jobs\/(.+)$/.exec(pathname);
    if (pruneJobMatch && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const jobId = pruneJobMatch[1];
            const job = deps.auxStore.getPruneJob(jobId);
            if (!job) {
                writeError(res, 404, 'job_not_found', `prune job not found: ${jobId}`, { job_id: jobId });
                return true;
            }
            // R5 #2 — the prune-job record carries its workspace + result counts
            // + options; gateRoute('read') is a no-op for the workspace boundary
            // in local mode, so gate on job.workspace (fetch-then-gate, like the
            // approvals get-by-id sibling) before returning it. Null principal =
            // legacy/local bypass.
            if (bindRouteTarget(res, { requested: job.workspace, intent: 'read' }) === null) return true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(job));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    return false;
}

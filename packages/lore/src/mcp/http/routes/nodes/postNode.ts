/**
 * postNode.ts — POST /api/node — upsert a node from the UI / HTTP clients.
 *
 * Mirrors store_node MCP tool semantics: upsert the graph node, then write
 * the verbatim seed at canonical `lore:<id>` so all surfaces hit the same
 * row. Runs the full write gauntlet in order: ReBAC → strict-fields →
 * token-scoped write gate → workspace-required → outbox backpressure →
 * registry resolution → vocab policy → quota → outbox-first hot writes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { WorkspaceNotFoundError } from '../../../../engines/localGraphRegistry.js';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeWorkspaceRequired, checkOutboxBackpressure, writeError } from '../../helpers.js';
import { enforceStrictFields, enforceVocabPolicy } from '../storeNodeGates.js';
import { bindRouteTarget, isLegacyBypass } from '../../../../security/routeWorkspaceBinding.js';
import { nodeUpsert, resolveAutolinkHandles } from '../../../../core/nodeService.js';
// 1.1 (2026-08-17 audit) — retry SurrealDB transaction-conflict write drops
// (same wrapper bulkIngest already uses; no-op on Kùzu).
import { withTransactionConflictRetry } from '../../../../engines/transactionConflictRetry.js';
import type { LoreGraph, NodesDeps } from './types.js';
import { assertSafeLanceId } from '../../../../engines/verbatimHistory.js';
import { redactError } from '../../../../security/logRedact.js';

export async function handlePostNode(req: IncomingMessage, res: ServerResponse, url: string, deps: NodesDeps): Promise<void> {
    // NW-5b — audit-coverage. POST /api/node — the primary HTTP write —
    // was NOT emitting an audit row pre-fix. Capture timing + outcome
    // around the whole handler. The finally block reads res.statusCode
    // and the captured node-id/workspace to classify result.
    const __auditStartedAt = Date.now();
    const __auditCtx: { workspace: string | null; nodeId: string | null; errored: boolean; resultDetail?: string } = {
        workspace: null, nodeId: null, errored: false,
    };
    try {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'write' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    let body: string;
    try {
        body = await readBoundedBody(req);
    } catch (err) {
        if (isPayloadTooLarge(err)) { writeOversizeError(res); return; }
        writeError(res, 400, 'bad_request', redactError(err));
        return;
    }
    try {
        const nodeData = JSON.parse(body);
        if (nodeData && typeof nodeData === 'object' && !Array.isArray(nodeData)) {
            if (typeof nodeData.id === 'string') __auditCtx.nodeId = nodeData.id;
            if (typeof nodeData.workspace === 'string') __auditCtx.workspace = nodeData.workspace;
        }
        if (!nodeData || typeof nodeData !== 'object' || Array.isArray(nodeData)) {
            writeError(res, 400, 'bad_request', 'body must be a JSON object');
            return;
        }
        if (!nodeData.id || !nodeData.type || !nodeData.label) {
            writeError(res, 400, 'bad_request', 'id, type, and label are required');
            return;
        }
        // RC2 audit (2026-05-17): without these type checks, an
        // adversarial caller sending `label: ["a", "b"]` crashed the
        // upsertNode trim path with a 500 "p.trim is not a function".
        // Reject non-string identity fields before they ever reach the
        // graph layer.
        if (typeof nodeData.id !== 'string'
            || typeof nodeData.type !== 'string'
            || typeof nodeData.label !== 'string') {
            writeError(res, 400, 'bad_request', 'id, type, and label must be strings');
            return;
        }
        // SECURITY: node id flows into LanceDB where() predicates. Reject
        // unsafe chars here so nodes are never created in a state where they
        // can't be queried, tombstoned, or deleted.
        try {
            assertSafeLanceId(nodeData.id, 'postNode');
        } catch (e) {
            writeError(res, 400, 'invalid_node_id', (e as Error).message);
            return;
        }
        // Phase 6 P2 — strict additionalProperties:false gate.
        if (enforceStrictFields(nodeData, res).handled) return;

        // Phase 6 P3 — token-scoped write gate. The principal is bound by
        // middleware; routes that go through the auth gauntlet always have
        // one in production. Tests can bypass by binding their own via
        // runWithPrincipal, or skip the gate by leaving the ALS store unset
        // (no principal/slot means no auth was performed → keep legacy
        // behavior so existing fixtures don't have to be rewritten).
        const requestedNodeWorkspace = typeof nodeData.workspace === 'string' ? nodeData.workspace : undefined;
        // The pure legacy/direct-call bypass (no principal/slot/requested) is the
        // ONE case bindRouteTarget returns null without writing a denial — no auth
        // was performed, so fall through to legacy behavior (workspace stays
        // whatever the body provided, checked as `requestedWorkspace` below).
        // Otherwise a null return is a scope DENIAL (4xx already written) — stop.
        // Detected up front so we never depend on res.headersSent (stub responses
        // don't track it — that was masking a real cross-workspace 403).
        const legacyBypass = isLegacyBypass(requestedNodeWorkspace);
        const boundTarget = legacyBypass
            ? null
            : bindRouteTarget(res, { requested: requestedNodeWorkspace, intent: 'write' });
        if (boundTarget === null) {
            if (!legacyBypass) return; // denial written — stop.
        } else if (!nodeData.workspace) {
            // Default workspace = the resolved target when caller omits it.
            // P3 fixes the cross-app contamination class: Claude Code
            // (token bound to developer) never accidentally writes to the
            // active workspace if active got switched to personal.
            nodeData.workspace = boundTarget;
        }
        // Sprint L1c — workspace is required. No silent fallback to
        // activeName(). Principal-default fill happens above only when an
        // explicit workspace is provided to the auth gate; we require an
        // explicit workspace string here regardless.
        const requestedWorkspace =
            typeof nodeData.workspace === 'string' && nodeData.workspace.length > 0
                ? nodeData.workspace
                : undefined;
        if (!requestedWorkspace) {
            writeWorkspaceRequired(res);
            return;
        }
        // Sprint O4 — backpressure (503 outbox_lag) after L workspace
        // check, before outbox commit. Per-workspace isolation via cache
        // key; miss → fail-open.
        if (checkOutboxBackpressure(res, requestedWorkspace, deps.outboxLagCache)) return;
        // Phase 6 P1.B — route writes through the multi-workspace registry
        // when wired. Falls back to the legacy boot-bound graph when no
        // registry is wired (cloud mode, tests, etc.).
        let targetGraph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            const resolvedWorkspace = requestedWorkspace;
            try {
                // getGraphHandle resolves the workspace's DECLARED engine
                // (Kùzu or Surreal) instead of unconditionally handing back a
                // Kùzu handle — a Surreal-backed workspace was silently
                // upserting into its empty, unused Kùzu store. Still runs
                // assertWorkspaceOpenAllowed via its internal getOrOpen call.
                targetGraph = await deps.graphRegistry.getGraphHandle(resolvedWorkspace);
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
        // Phase 6 P2 — workspace vocab policy gate. Default mode='open' is a
        // no-op; reject/hitl write their own response, warn surfaces a
        // typeWarning we attach below.
        const vocab = await enforceVocabPolicy(nodeData, res, {
            pendingOpsStore: deps.pendingOpsStore,
            coreNodeTypes: deps.coreNodeTypes,
            activeWorkspace: deps.graphRegistry?.activeName() ?? '*',
            getVocabPolicy: deps.getVocabPolicy,
        });
        if (vocab.handled) return;
        const typeWarning = vocab.typeWarning;

        // O2: outbox-first — graph.upsert + verbatim.upsert recorded before
        // substrate writes (LanceDB async; O-D3).
        const skipEmbed = nodeData.embed === false;

        // Sprint C3 — per-workspace quota gate (see workspaceQuota.ts).
        if (deps.quotaStore && deps.getWorkspaceEntryForQuota) {
            const { enforceNodeWriteQuota } = await import('../../../../security/workspaceQuota.js');
            const q = enforceNodeWriteQuota({ store: deps.quotaStore, getWorkspaceEntry: deps.getWorkspaceEntryForQuota }, res, requestedWorkspace, nodeData);
            if (q.handled) return;
        }

        // NW-7f (api-006) — track create-vs-update so we can return
        // HTTP 201 on first-create + 200 on update, matching POST
        // /api/workspaces and standard REST convention. A pre-read on
        // the target graph is the cheapest existence check available;
        // it adds one Kùzu lookup that is already on the hot path for
        // version capture (see storeNode.ts:266). The upsert itself
        // remains atomic — the pre-read is advisory only. If the pre-
        // read throws (test fixtures with mock graphs that lack getNode,
        // or a transient read fault), fall back to "treat as update" —
        // a 200 with isNew:false is the conservative legacy answer
        // rather than mis-signaling a create.
        let __isNew = false;
        try {
            const existing = await targetGraph.getNode(nodeData.id);
            __isNew = !existing;
        } catch { /* fixture / transient — fall through as update */ }

        // W3-SERVICE-LAYER — the guarded write core (outbox-first
        // node.upsert + verbatim.upsert fan-out + graph rollback) now lives
        // in core/nodeService.nodeUpsert, shared with the MCP store_node
        // tool. This route still owns its own gauntlet (ReBAC, principal
        // default, backpressure, quota, create-vs-update) above/below; only
        // the substrate orchestration is delegated. REST has no WAL /
        // version / async_embed paths (those hooks stay unset), and — as
        // before — writes verbatim ONLY when an outbox is wired (no inline
        // verbatim fallback for HTTP), so `verbatim` is intentionally omitted.
        //
        // 2026-08-17 (functional-correctness, low #26) — autolink was never
        // wired here at all, so a node written through POST /api/node (the
        // UI's write path) got zero semantic edges while the identical MCP
        // store_node write did. The resolution itself moved into
        // core/nodeService.resolveAutolinkHandles (2026-08-19, launch-
        // readiness item 4) so REST, MCP and the embedded wrappers share ONE
        // copy of the "Audit fix #5" per-workspace wiring instead of four
        // drift-prone inline ones. Runtime parity is pinned by
        // test/rest-mcp-autolink-parity-e2e.ts.
        const autolink = await resolveAutolinkHandles({
            bootGraph: deps.store.loreGraph,
            bootVerbatim: deps.store.loreVerbatim,
            resolver: deps.workspaceVerbatimResolver,
            workspace: requestedWorkspace,
            targetGraph,
            tracker: deps.store.autolinkTracker,
        });
        const writeResult = await withTransactionConflictRetry(() => nodeUpsert(
            {
                id: nodeData.id,
                workspace: requestedWorkspace,
                ecosystem: typeof nodeData.ecosystem === 'string' ? nodeData.ecosystem : '*',
                nodeData: nodeData as Record<string, unknown>,
                targetGraph,
                initiator: 'http:POST /api/node',
                skipEmbed,
            },
            {
                outboxStore: deps.outboxStore,
                verbatim: deps.inlineVerbatim,
                autolink,
            },
        ));
        if (!writeResult.ok) {
            writeError(res, 500, 'internal_error', writeResult.error.message);
            return;
        }
        // Sprint C3 — bump quota counter only after substrate writes
        // resolved (see bumpNodeWriteQuota in workspaceQuota.ts).
        if (deps.quotaStore) {
            const { bumpNodeWriteQuota } = await import('../../../../security/workspaceQuota.js');
            bumpNodeWriteQuota(deps.quotaStore, requestedWorkspace, nodeData);
        }
        const okHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (typeWarning) okHeaders['X-Lore-Type-Warning'] = typeWarning;
        // NW-7f (api-006) — 201 on first-create matches POST /api/workspaces
        // and HTTP conventions; 200 on update preserves the legacy shape
        // for idempotent re-puts. `isNew` in the body lets callers branch
        // without parsing the status line.
        res.writeHead(__isNew ? 201 : 200, okHeaders);
        res.end(JSON.stringify({ ok: true, id: nodeData.id, isNew: __isNew, ...(typeWarning ? { warning: typeWarning } : {}) }));
    } catch (saveErr) {
        writeError(res, 500, 'internal_error', redactError(saveErr));
    }
    } catch (outerErr) {
        // Outer handler — shouldn't be reached (inner try covers the
        // hot path) but if a pre-body call throws (gateRoute, etc.) we
        // want the audit to still fire.
        __auditCtx.errored = true;
        __auditCtx.resultDetail = (outerErr as Error).message;
        throw outerErr;
    } finally {
        try {
            const status = res.statusCode || 0;
            const ok = !__auditCtx.errored && status >= 200 && status < 300;
            deps.auditLog.log({
                toolName: 'http:post_node',
                args: { workspace: __auditCtx.workspace, nodeId: __auditCtx.nodeId, status },
                result: ok ? 'success' : 'error',
                resultDetail: __auditCtx.resultDetail ?? (status >= 400 ? `http_${status}` : undefined),
                durationMs: Date.now() - __auditStartedAt,
            });
        } catch (logErr) {
            console.error(`[Lore HTTP] audit emission failed for POST /api/node: ${(logErr as Error).message}`);
        }
    }
}

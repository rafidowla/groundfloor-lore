/**
 * policy.ts — stale-marking + workspace retention policy + deferred/ephemeral
 * cleanup routes.
 *
 *   POST /api/mark-stale                 — bulk-mark nodes stale by tag
 *   GET  /api/workspace/retention        — read active workspace policy
 *   PUT  /api/workspace/retention        — patch active workspace policy
 *   POST /api/workspace/retention/sweep  — run the auto-archive sweep now
 *   POST /api/resolve-deferred           — stamp a deferred-* node resolved
 *   POST /api/prune-ephemeral            — drop expired ephemeral nodes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    getActiveWorkspaceName,
    getWorkspaceRetention,
    setWorkspaceRetention,
} from '../../../../config/workspaces.js';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { isPayloadTooLarge, writeOversizeError, writeError } from '../../helpers.js';
import { resolveTargetGraph } from '../../../tools/workspaceResolve.js';
import { bindRouteTarget, isLegacyBypass } from '../../../../security/routeWorkspaceBinding.js';
import { type RetentionDeps, readBody } from './shared.js';
import { redactError } from '../../../../security/logRedact.js';
import { withNodeLocks, chunkForLocking, BULK_LOCK_CHUNK_SIZE } from '../../../../core/nodeWriteLock.js';
import { recordHotWrite } from '../../../../outbox/hotLane.js';
import { safePruneEphemeralNodes } from '../../../../engines/safeEphemeralPrune.js';
// FIND-2026-06-19-01 — call the pure sweep implementation directly with the
// SWEEP TARGET's own resolved substrates, instead of deps.runRetentionSweep
// (a closure fixed over the boot graph/verbatim/active-workspace).
import { runRetentionSweep } from '../../../services.js';

/**
 * resolveScopedGraph — Postgres-model isolation (2026-06-19). These routes
 * carry no `workspace` body param; they operate on the request's BOUND
 * target (set by bindRouteTarget — the principal's own workspace unless a
 * cross-workspace/daemon-operator lane widened it). Falls back to the boot
 * graph when no registry (cloud/tests). Writes the error envelope and
 * returns null on an unknown workspace.
 *
 * `target` must already have been resolved via bindRouteTarget by the
 * caller — this function only opens the substrate for it (assertWorkspace-
 * OpenAllowed re-verifies against the binding).
 */
async function resolveScopedGraph(
    deps: RetentionDeps,
    res: ServerResponse,
    target: string,
): Promise<RetentionDeps['store']['loreGraph'] | null> {
    if (!deps.graphRegistry) return deps.store.loreGraph;
    const gres = await resolveTargetGraph(deps.store, deps.graphRegistry, deps.detectedScope?.workspace ?? '', target);
    if (gres.ok) return gres.graph;
    if ('requested' in gres) {
        writeError(res, 404, 'workspace_not_found', `workspace not found: ${gres.requested}`, { requested: gres.requested, known: gres.known });
    } else {
        writeError(res, 400, 'workspace_required', 'pass workspace=<name> as body field or query param');
    }
    return null;
}

/** Returns true once a response has been written. */
export async function tryPolicyRoutes(req: IncomingMessage, res: ServerResponse, deps: RetentionDeps, pathname: string): Promise<boolean> {
    // Gap #3 — mark orientation-pack (or any tag) nodes stale. Called
    // by scripts/mark-pack-stale.sh post-commit hook when a large
    // changeset is detected. Also reachable from the CLI via
    // `lore mark-stale --tags <tag,...>`.
    if (pathname === '/api/mark-stale' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. No workspace param on this route — binds to the caller's
        // own workspace. The pure legacy/direct-call bypass (no principal, no
        // slot) is the ONE case bindRouteTarget returns null without writing a
        // denial: it falls back to the boot/active workspace, matching the
        // pre-sweep resolveScopedGraph default. Otherwise a null return is a
        // DENIAL (the 4xx is already written). Detected up front so we never
        // depend on res.headersSent (stub responses don't track it).
        let target: string;
        if (isLegacyBypass(undefined)) {
            target = deps.detectedScope?.workspace ?? '';
        } else {
            const bound = bindRouteTarget(res, { intent: 'write' });
            if (bound === null) return true;
            target = bound;
        }
        let body: string;
        try {
            body = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }
        let parsed: { tags?: string[] };
        try {
            parsed = JSON.parse(body || '{}') as { tags?: string[] };
        } catch (parseErr) {
            // 2026-09-03 (X-markstale audit fix) — a malformed body used to
            // fall into the outer try/catch below and come back as a 500
            // internal_error; a syntactically bad request body is a client
            // error, not a server one.
            writeError(res, 400, 'invalid_json_body', redactError(parseErr));
            return true;
        }
        try {
            if (!Array.isArray(parsed.tags) || parsed.tags.length === 0) {
                writeError(res, 400, 'invalid_request', '`tags` array is required and must be non-empty');
                return true;
            }
            const graph = await resolveScopedGraph(deps, res, target);
            if (!graph) return true;
            // 2026-09-03 (X-markstale audit fix) — was a direct
            // `graph.markStaleByTags(parsed.tags)` call: no outbox row, no
            // per-node lock, so a crash between resolving the tag match and
            // applying the flag lost the operation with nothing for
            // replay/crash-recovery to see. Resolve the matched ids FIRST
            // (read-only), then apply in per-chunk locked + outbox-recorded
            // regions — mirrors bulkWriteEdgesDelete.ts's handleBulkDelete
            // chunking (core/nodeWriteLock.ts BULK_LOCK_CHUNK_SIZE).
            const matchedIds = await graph.findNodeIdsByTags(parsed.tags);
            let marked = 0;
            let anyOutboxCommitFailure = false;
            for (const chunk of chunkForLocking(matchedIds, BULK_LOCK_CHUNK_SIZE)) {
                await withNodeLocks(target, chunk, async () => {
                    if (deps.outboxStore) {
                        try {
                            await recordHotWrite(deps.outboxStore, {
                                workspace: target,
                                operationKind: 'node.mark_stale',
                                payload: { ids: chunk },
                                initiator: 'http:POST /api/mark-stale',
                                operation: 'graph.markStaleByIds',
                            });
                        } catch (err) {
                            anyOutboxCommitFailure = true;
                            console.error(`[Lore HTTP] mark-stale: outbox commit failed for a chunk of ${chunk.length} id(s): ${redactError(err)}`);
                            return;
                        }
                    }
                    marked += await graph.markStaleByIds(chunk);
                });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ marked, tags: parsed.tags, ok: !anyOutboxCommitFailure }));
        } catch (msErr) {
            writeError(res, 500, 'internal_error', redactError(msErr));
        }
        return true;
    }

    // Workspace retention policy — GET reads, PUT patches.
    if (pathname === '/api/workspace/retention' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // R2-002/D-021 — bind the read to the PRINCIPAL's workspace, not the
        // daemon-active one. gateRoute is a no-op in local mode, so without this
        // an app token bound to ws A would read whatever ws is currently active
        // (set by a different app), crossing the per-app isolation boundary.
        // No `requested` → bindRouteTarget resolves the bound principal's own
        // workspace and scope-checks it; a null return is then a 4xx DENIAL and
        // we must stop. The ONE null-without-denial case is the pure legacy/
        // direct-call bypass (no principal/slot) — keep the historical active-
        // workspace default for that path only. Detected up front so we never
        // depend on res.headersSent (stub responses don't track it).
        let readTargetWs: string;
        if (isLegacyBypass(undefined)) {
            readTargetWs = getActiveWorkspaceName();
        } else {
            const bound = bindRouteTarget(res, { intent: 'read' });
            if (bound === null) return true;
            readTargetWs = bound;
        }
        try {
            const policy = getWorkspaceRetention(readTargetWs);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(policy));
        } catch (rErr) {
            writeError(res, 500, 'internal_error', redactError(rErr));
        }
        return true;
    }

    if (pathname === '/api/workspace/retention' && req.method === 'PUT') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. No workspace param on this route — binds to the caller's
        // own workspace, mirroring the GET handler's bypass-vs-denied disambiguation
        // (isLegacyBypass up front; never res.headersSent).
        let putTargetWs: string;
        if (isLegacyBypass(undefined)) {
            putTargetWs = getActiveWorkspaceName();
        } else {
            const bound = bindRouteTarget(res, { intent: 'write' });
            if (bound === null) return true;
            putTargetWs = bound;
        }
        let body: string;
        try {
            body = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }
        try {
            const patch = JSON.parse(body || '{}') as Partial<{
                hideSupersededInRecall: boolean;
                hideSupersededInGraph: boolean;
                autoArchiveSupersededAfterDays: number | null;
            }>;
            // R2-002 — mutate the principal's OWN ws (the one bindRouteTarget
            // resolved above), not the daemon-active ws. Otherwise app-A could
            // rewrite the active ws's (app-B's) retention policy.
            const updated = setWorkspaceRetention(putTargetWs, patch);
            deps.auditLog.log({
                toolName: 'workspace.retention.update',
                args: { patch },
                result: 'success',
                durationMs: 0,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(updated));
        } catch (rErr) {
            writeError(res, 500, 'internal_error', redactError(rErr));
        }
        return true;
    }

    // Manually run the auto-archive sweep. Useful for testing policies
    // and for "do it now" UX. POST body optional: { dryRun?: boolean } —
    // when true, returns counts without actually tombstoning.
    if (pathname === '/api/workspace/retention/sweep' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // FIND-2026-06-19-01 — L-068/D-021 per-token write-scope gate:
        // gateRoute above is a no-op in local mode. No workspace param on
        // this route — binds to the caller's own workspace. Unlike the other
        // handlers in this file, the resolved target IS consumed downstream:
        // it picks which workspace's graph/verbatim/policy the sweep runs
        // against, closing the gate-one-act-another hole where the bind
        // passed but the sweep still ran against the boot/active workspace.
        // The ONE null-without-denial case is the pure legacy/direct-call bypass
        // (no principal/slot): it falls back to the boot/active workspace,
        // matching this route's pre-fix behavior for that path only. Otherwise a
        // null return is a DENIAL (4xx already written). Detected up front so we
        // never depend on res.headersSent (stub responses don't track it).
        let sweepTarget: string;
        if (isLegacyBypass(undefined)) {
            sweepTarget = deps.detectedScope?.workspace ?? getActiveWorkspaceName();
        } else {
            const bound = bindRouteTarget(res, { intent: 'write' });
            if (bound === null) return true;
            sweepTarget = bound;
        }
        let body: string;
        try {
            body = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }
        // Parse opts separately from runSweep so JSON-parse failures
        // surface as 400 (client error) instead of being conflated
        // with sweep-engine errors (5xx). Audit rc4-workspace flagged
        // this: malformed body was returning 500 with the parser's
        // message, masking which side owned the bug.
        let opts: { dryRun?: boolean };
        try {
            opts = JSON.parse(body || '{}') as { dryRun?: boolean };
        } catch (parseErr) {
            writeError(res, 400, 'invalid_json', `malformed JSON body: ${(parseErr as Error).message}`);
            return true;
        }
        try {
            // FIND-2026-06-19-01 — resolve the SWEEP TARGET's own graph +
            // verbatim store rather than delegating to deps.runRetentionSweep
            // (a closure fixed over the boot graph/verbatim/active-workspace
            // policy). Without this, a ws-a write token could dryRun-leak the
            // boot workspace's eligible-count/node-ids/timestamps, or
            // non-dry-run tombstone the boot workspace's verbatim rows.
            const graph = await resolveScopedGraph(deps, res, sweepTarget);
            if (!graph) return true;
            const verbatimStore = deps.workspaceVerbatimResolver
                ? await deps.workspaceVerbatimResolver.getOrOpen(sweepTarget)
                : deps.store.loreVerbatim;
            const result = await runRetentionSweep(
                { graph, verbatimStore, auditLog: deps.auditLog, workspace: sweepTarget },
                opts.dryRun === true,
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (sErr) {
            writeError(res, 500, 'internal_error', redactError(sErr));
        }
        return true;
    }

    //   POST /api/resolve-deferred
    //   body: { id: string, commit?: string }
    if (pathname === '/api/resolve-deferred' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. No workspace param on this route — binds to the caller's
        // own workspace. The ONE null-without-denial case is the pure legacy/
        // direct-call bypass (no principal/slot): it falls back to the boot/
        // active workspace, matching the pre-sweep resolveScopedGraph default.
        // Otherwise a null return is a DENIAL. Detected up front so we never
        // depend on res.headersSent (stub responses don't track it).
        let wsTarget: string;
        if (isLegacyBypass(undefined)) {
            wsTarget = deps.detectedScope?.workspace ?? '';
        } else {
            const bound = bindRouteTarget(res, { intent: 'write' });
            if (bound === null) return true;
            wsTarget = bound;
        }
        let body: string;
        try { body = await readBody(req); }
        catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }
        try {
            const parsed = JSON.parse(body || '{}') as { id?: string; commit?: string };
            if (!parsed.id || typeof parsed.id !== 'string') {
                writeError(res, 400, 'invalid_request', '`id` is required (deferred-* node ID)');
                return true;
            }
            const target = await resolveScopedGraph(deps, res, wsTarget);
            if (!target) return true;
            const graph = target as unknown as { getNode?: unknown };
            if (typeof graph.getNode !== 'function') {
                writeError(res, 501, 'not_supported', 'resolve-deferred not supported by current graph backend');
                return true;
            }
            const { stampResolved } = await import('../../../../engines/deferred.js');
            const result = await stampResolved(target as never, parsed.id, parsed.commit);
            if (!result) {
                writeError(res, 404, 'not_found', `Deferred node '${parsed.id}' not found.`);
                return true;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: result.node.id,
                label: result.node.label,
                resolved_at: result.metadata['resolved_at'],
                resolved_by_commit: result.metadata['resolved_by_commit'] ?? null,
            }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    //   POST /api/prune-ephemeral
    //   body: { defaultTtlMs?: number }
    if (pathname === '/api/prune-ephemeral' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'delete' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. No workspace param on this route — binds to the caller's
        // own workspace. The ONE null-without-denial case is the pure legacy/
        // direct-call bypass (no principal/slot): it falls back to the boot/
        // active workspace, matching the pre-sweep resolveScopedGraph default.
        // Otherwise a null return is a DENIAL. Detected up front so we never
        // depend on res.headersSent (stub responses don't track it).
        let pruneTarget: string;
        if (isLegacyBypass(undefined)) {
            pruneTarget = deps.detectedScope?.workspace ?? '';
        } else {
            const bound = bindRouteTarget(res, { intent: 'write' });
            if (bound === null) return true;
            pruneTarget = bound;
        }
        let body: string;
        try { body = await readBody(req); }
        catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }
        try {
            const parsed = JSON.parse(body || '{}') as { defaultTtlMs?: number };
            const ttl = typeof parsed.defaultTtlMs === 'number' && Number.isFinite(parsed.defaultTtlMs)
                ? parsed.defaultTtlMs
                : 3_600_000;
            // Sprint 16: route through the graph facade. Every local engine
            // and DataplaneGraph implements pruneEphemeralNodes natively, so
            // the prior 501-fallback guard is no longer needed.
            // 2026-06-19: resolve the principal's workspace (Postgres-model
            // isolation) rather than the boot/active store via storageClient.
            const graph = await resolveScopedGraph(deps, res, pruneTarget);
            if (!graph) return true;

            // ITEM X-pruneeph (2026-09-03) — SurrealGraph exposes a
            // query-only listExpiredEphemeralNodeIds() so THIS route can
            // drive the per-node delete itself, through the exact
            // nodeWriteLock / outbox / verbatim-tombstone discipline
            // POST /api/nodes/prune hard_delete uses (retention sibling:
            // mcp/http/routes/lifecycle.ts). graph.pruneEphemeralNodes()
            // itself is unchanged and calls deleteNode() directly with none
            // of that — no lock, no outbox row, no verbatim tombstone —
            // orphaning the LanceDB vector row and leaving the outbox blind
            // to the delete. Engines that don't expose the safe query
            // method (DataplaneGraph, ArcadeGraphStore) fall back to the
            // pre-fix direct call — safePruneEphemeralNodes handles that
            // fallback itself. Shared with the `prune_ephemeral` MCP tool
            // (mcp/tools/governance.ts) and the daemon's boot-time prune
            // (mcp/server.ts) — see engines/safeEphemeralPrune.ts.
            const deleted = await safePruneEphemeralNodes({
                graph,
                workspace: pruneTarget,
                ttl,
                outboxStore: deps.outboxStore,
                initiator: 'http:prune-ephemeral',
                tombstoneVerbatim: async (verbatimId, reason) => {
                    const targetVerbatim = deps.workspaceVerbatimResolver
                        ? await deps.workspaceVerbatimResolver.getOrOpen(pruneTarget)
                        : deps.store.loreVerbatim;
                    const vstore = targetVerbatim as unknown as {
                        tombstone?: (id: string, reason: string) => Promise<void>;
                        delete?: (id: string) => Promise<void>;
                    };
                    if (typeof vstore.tombstone === 'function') {
                        await vstore.tombstone(verbatimId, reason);
                    } else if (typeof vstore.delete === 'function') {
                        await vstore.delete(verbatimId);
                    }
                },
                onLog: (message) => console.error(`[Lore HTTP] ${message}`),
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, deleted }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    return false;
}

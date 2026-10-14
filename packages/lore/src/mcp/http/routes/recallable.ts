/**
 * recallable.ts - POST /api/nodes/recallable (3.34.0 N5, "recallable now").
 *
 * After a bulk write returns, embeddings are produced asynchronously. A caller that needs to recall
 * its own writes (a test, an import tool, a follow-up job) asks THIS route instead of sleeping or
 * hammering recall: it blocks server-side until every id is recallable, or the timeout - and a
 * timeout is a 200 status (`ready:false, timedOut:true`), not an error.
 *
 * Body (exactly one of `ids` / `allBeforeNow`):
 *   { workspace, ids: string[],            timeoutMs? }   // capped list (LORE_RECALLABLE_MAX_IDS)
 *   { workspace, allBeforeNow: true,       timeoutMs? }   // everything queued before this request
 * Response: RecallableResult (providers/types.ts) + `workspace`.
 *
 * Codes: 400 bad_request | recallable_too_many_ids | recallable_invalid_request | workspace_required,
 *        501 recallable_not_supported (engine cannot answer; see core/recallableWaiter.ts).
 *
 * Confinement: ids are looked up ONLY in the request's workspace (its graph, vector store and outbox
 * lane), so an id that belongs elsewhere is `not_found` - indistinguishable from an id that never
 * existed. The route is authenticated, read-permission gated, and uses its own rate-limit bucket
 * (`recallable` locally, `arcade_recallable` on the arcade listener) because a request holds a
 * connection open for up to the timeout.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeJson, writeError, writeWorkspaceRequired, parseJsonBody, isInvalidJsonBody, writeInvalidJson } from '../helpers.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';
import { awaitRecallable } from '../../../core/recallableWaiter.js';
import type { OutboxStore } from '../../../outbox/types.js';
import type { OutboxLagCache } from '../../../outbox/lagCache.js';
import type { WorkspaceVerbatimResolver } from '../../../outbox/workspaceVerbatimResolver.js';

export interface RecallableDeps {
    store: StorageBundle;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    graphRegistry?: LocalGraphRegistry;
    workspaceVerbatimResolver?: WorkspaceVerbatimResolver;
    outboxStore?: OutboxStore;
    outboxLagCache?: Pick<OutboxLagCache, 'waitForRefresh'> | { waitForRefresh?: OutboxLagCache['waitForRefresh'] };
}

/** Default wait when the caller omits `timeoutMs` (env LORE_RECALLABLE_TIMEOUT_MS, default 10000). */
export function recallableDefaultTimeoutMs(): number { return envInt('LORE_RECALLABLE_TIMEOUT_MS', 10_000, 0); }
/** Hard ceiling; a larger request is clamped, not rejected (env LORE_RECALLABLE_MAX_TIMEOUT_MS, default 60000). */
export function recallableMaxTimeoutMs(): number { return envInt('LORE_RECALLABLE_MAX_TIMEOUT_MS', 60_000, 1); }
/** Max ids per request (env LORE_RECALLABLE_MAX_IDS, default 500, hard max 1000). */
export function recallableMaxIds(): number { return Math.min(1000, envInt('LORE_RECALLABLE_MAX_IDS', 500, 1)); }

function envInt(name: string, dflt: number, min: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}

export async function tryRecallableRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: RecallableDeps,
): Promise<boolean> {
    if (pathname !== '/api/nodes/recallable' || req.method !== 'POST') return false;

    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
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
        const parsed = parseJsonBody(body) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            writeError(res, 400, 'bad_request', 'body must be a JSON object');
            return true;
        }
        const workspace = typeof parsed['workspace'] === 'string' && parsed['workspace'].length > 0 ? parsed['workspace'] : undefined;
        if (!workspace) { writeWorkspaceRequired(res); return true; }
        if (workspace === '*') {
            writeError(res, 400, 'recallable_invalid_request', 'recallable is per workspace; workspace "*" is not allowed');
            return true;
        }
        if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return true;

        const hasIds = parsed['ids'] !== undefined;
        const all = parsed['allBeforeNow'] === true;
        if (parsed['allBeforeNow'] !== undefined && typeof parsed['allBeforeNow'] !== 'boolean') {
            writeError(res, 400, 'recallable_invalid_request', 'allBeforeNow must be a boolean');
            return true;
        }
        if (hasIds === all) {
            writeError(res, 400, 'recallable_invalid_request', 'send exactly one of: ids (array of node ids) or allBeforeNow: true');
            return true;
        }
        let ids: string[] = [];
        if (hasIds) {
            const raw = parsed['ids'];
            if (!Array.isArray(raw) || raw.length === 0 || raw.some((i) => typeof i !== 'string' || i.length === 0 || i.length > 512)) {
                writeError(res, 400, 'recallable_invalid_request', 'ids must be a non-empty array of non-empty node-id strings');
                return true;
            }
            const cap = recallableMaxIds();
            if (raw.length > cap) {
                writeError(res, 400, 'recallable_too_many_ids', `at most ${cap} ids per request (got ${raw.length}); split the list or use allBeforeNow`, { max: cap, received: raw.length });
                return true;
            }
            ids = raw as string[];
        }
        const tRaw = parsed['timeoutMs'];
        if (tRaw !== undefined && (typeof tRaw !== 'number' || !Number.isFinite(tRaw) || tRaw < 0)) {
            writeError(res, 400, 'recallable_invalid_request', 'timeoutMs must be a non-negative number');
            return true;
        }
        const timeoutMs = Math.min(typeof tRaw === 'number' ? Math.floor(tRaw) : recallableDefaultTimeoutMs(), recallableMaxTimeoutMs());

        // Resolve THIS workspace's graph + vector store (same resolution as bulk write/list).
        let graph = deps.store.loreGraph;
        let resolved = workspace;
        let vector: unknown = deps.store.loreVerbatim;
        try {
            if (deps.graphRegistry) graph = await deps.graphRegistry.getGraphHandle(workspace);
            if (deps.workspaceVerbatimResolver) vector = await deps.workspaceVerbatimResolver.getOrOpen(workspace);
        } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${err.requested}`, { requested: err.requested, known: err.known });
                return true;
            }
            if (err instanceof Error && err.message.startsWith('workspace_not_found')) {
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${workspace}`, { requested: workspace });
                return true;
            }
            throw err;
        }

        // A dropped connection stops the wait instead of leaving a timer per abandoned request.
        const ac = new AbortController();
        res.once('close', () => { if (!res.writableEnded) ac.abort(); });
        const out = await awaitRecallable({
            vector: vector as Parameters<typeof awaitRecallable>[0]['vector'],
            graph: graph as { getNodesByIds(ids: string[]): Promise<Map<string, unknown>> },
            outbox: deps.outboxStore,
            workspace: resolved,
            waitForRefresh: deps.outboxLagCache?.waitForRefresh
                ? (ms, sig) => deps.outboxLagCache!.waitForRefresh!(ms, sig)
                : undefined,
        }, hasIds ? { ids, timeoutMs, signal: ac.signal } : { allBeforeNow: true, timeoutMs, signal: ac.signal });

        if (!out.supported) {
            writeError(res, 501, 'recallable_not_supported', out.reason);
            return true;
        }
        writeJson(res, 200, { ...out, workspace: resolved });
    } catch (err) {
        if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
        console.error(`[Lore HTTP] POST /api/nodes/recallable failed: ${redactError(err)}`);
        writeError(res, 500, 'internal_error', redactError(err));
    }
    return true;
}

/**
 * mcp/http/routes/analytics.ts — Sprint C5 analytical REST siblings.
 *
 * Closes the B-local deferred parity gap: MCP `time_series` +
 * `aggregate` tools had no REST sibling. With this route, no-code
 * callers and SDK clients can drive analytics via HTTP without
 * speaking MCP.
 *
 *   POST /api/time-series  — bucketed time series
 *   POST /api/aggregate    — count / sum / avg / min / max / groupBy / distinct
 *
 * Request body matches the MCP tool input shape 1:1 (workspace
 * required, Sprint L invariant). Response body mirrors the MCP tool's
 * JSON payload: `{ points: [...] }` for time_series,
 * `{ value | groups | values: ... }` for aggregate.
 *
 * Sprint L workspace_required is enforced here just like every other
 * /api/* write route — empty workspace → 400 workspace_required.
 *
 * Cloud activation: when DataplaneAnalyticalStorage lands, this route
 * stays unchanged — it speaks the IAnalyticalStorage interface, not
 * a substrate.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    AnalyticalScanCapExceeded,
    resolveGroupByLimit,
    type IAnalyticalStorage,
    type AggregationType,
    type TimeBucket,
} from '../../../contracts/index.js';
import type { Filter } from '../../../engines/collectionStorage.js';
import { readJsonBody, writeError } from '../helpers.js';
import { redactError } from '../../../security/logRedact.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';

export interface AnalyticsDeps {
    /** Null in cloud mode pre-step-#6. When null, routes return 503
     *  analytical_not_wired so callers know the surface exists but
     *  the impl hasn't shipped for the deployment mode yet. Also the
     *  active-workspace fallback when resolveAnalytical is absent. */
    analytical: IAnalyticalStorage | null;
    /**
     * Local-mode (Postgres model) per-workspace analytical resolver. When wired,
     * each route builds an IAnalyticalStorage over the REQUESTED workspace's
     * graph instead of the boot/active one. Absent (cloud/tests) → fall back to
     * `analytical`. Throws WorkspaceNotFoundError for an unknown workspace
     * (caught by the handler's try/catch).
     */
    resolveAnalytical?: (workspace: string) => Promise<IAnalyticalStorage | null>;
}

const AGGREGATIONS = new Set<AggregationType>(['count', 'sum', 'avg', 'min', 'max']);
const BUCKETS = new Set<TimeBucket>(['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']);

/**
 * Thrown by `parseFilter` for a malformed nested `filterJson` string.
 *
 * Distinct from a generic `Error` so the route handlers below can map it to
 * `400 invalid_filter_json` instead of falling through to the generic
 * `500 internal_error` catch — a client-side bad-request has no business
 * being reported as a server fault.
 */
class InvalidFilterJsonError extends Error {
    constructor(detail: string) {
        super(`filterJson is not valid JSON: ${detail}`);
        this.name = 'InvalidFilterJsonError';
    }
}

function parseFilter(raw: unknown): Filter | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'object') return raw as Filter;
    if (typeof raw === 'string') {
        try { return JSON.parse(raw) as Filter; }
        catch (err) { throw new InvalidFilterJsonError(err instanceof Error ? err.message : String(err)); }
    }
    return undefined;
}

/**
 * Map the two client-caused analytical errors to their documented client
 * error codes; returns false when `err` is neither (caller falls through to
 * its generic 500 handling). `AnalyticalScanCapExceeded` uses 400 (not 413):
 * the request itself is well-formed, it is the current dataset/filter
 * combination that exceeds the operator-configured cap — same class of
 * refusal as any other over-broad-query 400, and consistent with the other
 * `invalid_*`/`*_required` 400s this route already returns.
 */
function writeAnalyticalClientError(res: ServerResponse, err: unknown): boolean {
    if (err instanceof InvalidFilterJsonError) {
        writeError(res, 400, 'invalid_filter_json', err.message);
        return true;
    }
    if (err instanceof AnalyticalScanCapExceeded) {
        writeError(res, 400, 'analytical_scan_cap_exceeded', err.message, { cap: err.cap, matched: err.matched });
        return true;
    }
    return false;
}

function notWired(res: ServerResponse, tool: string): boolean {
    writeError(res, 503, 'analytical_not_wired', 'IAnalyticalStorage backend not yet wired for this deployment mode', { tool });
    return true;
}

function reqWorkspace(body: Record<string, unknown>, res: ServerResponse): string | null {
    const ws = typeof body.workspace === 'string' ? body.workspace.trim() : '';
    if (!ws) {
        writeError(res, 400, 'workspace_required', 'pass `workspace` in request body (Sprint L invariant)');
        return null;
    }
    return ws;
}

/**
 * SP-04 — token-scoped read gate for the analytics routes. These had ZERO
 * principal references: they read `workspace` from the body and query that
 * workspace's analytical/tabular store with no check, so a token bound to
 * workspace A could time-series / aggregate over workspace B's data. A
 * principal bound to A requesting B needs cross-workspace-read. Null principal
 * = legacy/local bypass (matches inspect.ts / versioning.ts). Returns true
 * when it has written a 4xx and the caller must `return true`.
 */
function denyAnalyticsCrossWorkspaceRead(res: ServerResponse, workspace: string): boolean {
    return bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null;
}

export async function tryAnalyticsRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: AnalyticsDeps,
): Promise<boolean> {
    if (req.method !== 'POST') return false;

    if (pathname === '/api/time-series') {
        if (!deps.analytical && !deps.resolveAnalytical) return notWired(res, 'time_series');
        let body: Record<string, unknown>;
        try { body = (await readJsonBody(req)) as Record<string, unknown>; }
        catch (err) {
            console.error(`[Lore HTTP] POST /api/time-series body parse failed: ${redactError(err)}`);
            writeError(res, 400, 'invalid_request_body', 'request body must be valid JSON');
            return true;
        }
        const workspace = reqWorkspace(body, res);
        if (!workspace) return true;
        if (denyAnalyticsCrossWorkspaceRead(res, workspace)) return true;
        const collection = typeof body.collection === 'string' ? body.collection : '';
        const timeField = typeof body.timeField === 'string' ? body.timeField : '';
        const bucket = body.bucket as TimeBucket;
        const aggregation = body.aggregation as AggregationType;
        if (!collection || !timeField) {
            writeError(res, 400, 'invalid_request_body', 'collection and timeField are required strings');
            return true;
        }
        if (!BUCKETS.has(bucket)) {
            writeError(res, 400, 'invalid_bucket', `bucket must be one of ${[...BUCKETS].join(',')}`);
            return true;
        }
        if (!AGGREGATIONS.has(aggregation)) {
            writeError(res, 400, 'invalid_aggregation', `aggregation must be one of ${[...AGGREGATIONS].join(',')}`);
            return true;
        }
        try {
            const a = deps.resolveAnalytical ? await deps.resolveAnalytical(workspace) : deps.analytical;
            if (!a) return notWired(res, 'time_series');
            const filter = parseFilter(body.filter ?? body.filterJson);
            const points = await a.timeSeries(
                collection,
                timeField,
                bucket,
                aggregation,
                typeof body.field === 'string' ? body.field : null,
                filter,
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ points }));
        } catch (err) {
            if (writeAnalyticalClientError(res, err)) return true;
            console.error(`[Lore HTTP] POST /api/time-series failed: ${redactError(err)}`);
            writeError(res, 500, 'internal_error', 'an internal error occurred');
        }
        return true;
    }

    if (pathname === '/api/aggregate') {
        if (!deps.analytical && !deps.resolveAnalytical) return notWired(res, 'aggregate');
        let body: Record<string, unknown>;
        try { body = (await readJsonBody(req)) as Record<string, unknown>; }
        catch (err) {
            console.error(`[Lore HTTP] POST /api/aggregate body parse failed: ${redactError(err)}`);
            writeError(res, 400, 'invalid_request_body', 'request body must be valid JSON');
            return true;
        }
        const workspace = reqWorkspace(body, res);
        if (!workspace) return true;
        if (denyAnalyticsCrossWorkspaceRead(res, workspace)) return true;
        const collection = typeof body.collection === 'string' ? body.collection : '';
        const aggregation = body.aggregation as AggregationType;
        if (!collection) {
            writeError(res, 400, 'invalid_request_body', 'collection is required');
            return true;
        }
        try {
            const a = deps.resolveAnalytical ? await deps.resolveAnalytical(workspace) : deps.analytical;
            if (!a) return notWired(res, 'aggregate');
            const filter = parseFilter(body.filter ?? body.filterJson);
            if (body.distinct === true) {
                if (typeof body.field !== 'string') {
                    writeError(res, 400, 'invalid_request_body', 'distinct requires field');
                    return true;
                }
                const requestedDistinctLimit = typeof body.limit === 'number' ? body.limit : undefined;
                const values = await a.distinct(collection, body.field, filter, requestedDistinctLimit);
                // LORE_ANALYTICAL_GROUP_LIMIT — same resolveGroupByLimit
                // SqliteAnalyticalStorage.distinct used to cap the result
                // set (see the groupBy branch below for the full rationale).
                const { clamped: distinctClamped } = resolveGroupByLimit(requestedDistinctLimit);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ values, ...(distinctClamped ? { truncated: true } : {}) }));
                return true;
            }
            if (typeof body.groupBy === 'string') {
                // CRITICAL (audit 2026-06-18) — the groupBy path skipped the
                // aggregation allowlist (only the non-groupBy path below checked
                // it), so `aggregation` flowed raw into renderAggExpr → Cypher
                // injection (DETACH DELETE). Validate here for a clean 400; the
                // engine now also allowlists as the root defense.
                if (!AGGREGATIONS.has(aggregation)) {
                    writeError(res, 400, 'invalid_aggregation', `aggregation must be one of ${[...AGGREGATIONS].join(',')}`);
                    return true;
                }
                const requestedLimit = typeof body.limit === 'number' ? body.limit : undefined;
                const groups = await a.groupBy(
                    collection,
                    body.groupBy,
                    aggregation,
                    typeof body.field === 'string' ? body.field : null,
                    filter,
                    requestedLimit,
                );
                // LORE_ANALYTICAL_GROUP_LIMIT (docs/CONFIGURATION.md) — same
                // resolution SqliteAnalyticalStorage.groupBy applied to cap
                // the result set; surface it so a caller knows the group
                // list may be incomplete.
                const { clamped } = resolveGroupByLimit(requestedLimit);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ groups, ...(clamped ? { truncated: true } : {}) }));
                return true;
            }
            if (!AGGREGATIONS.has(aggregation)) {
                writeError(res, 400, 'invalid_aggregation', `aggregation must be one of ${[...AGGREGATIONS].join(',')}`);
                return true;
            }
            let value: number | null;
            switch (aggregation) {
                case 'count': value = await a.count(collection, filter); break;
                case 'sum':
                case 'avg':
                case 'min':
                case 'max':
                    if (typeof body.field !== 'string') {
                        writeError(res, 400, 'invalid_request_body', `${aggregation} requires field`);
                        return true;
                    }
                    if (aggregation === 'sum') value = await a.sum(collection, body.field, filter);
                    else if (aggregation === 'avg') value = await a.avg(collection, body.field, filter);
                    else if (aggregation === 'min') value = await a.min<number>(collection, body.field, filter);
                    else value = await a.max<number>(collection, body.field, filter);
                    break;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ value }));
        } catch (err) {
            if (writeAnalyticalClientError(res, err)) return true;
            console.error(`[Lore HTTP] POST /api/aggregate failed: ${redactError(err)}`);
            writeError(res, 500, 'internal_error', 'an internal error occurred');
        }
        return true;
    }

    return false;
}

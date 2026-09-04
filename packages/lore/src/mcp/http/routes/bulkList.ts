/**
 * bulkList.ts — POST /api/nodes/bulk-list (Sprint W W4).
 *
 * Bulk node enumeration with cursor-based pagination. Atlas's read
 * tools needed this for the X6.6/X7 cold-warmup path: today /api/nodes
 * caps at 1k nodes per response and is throttled by the generic-bucket
 * rate limit (cap 100, refill 5/s in security/rateLimit.ts) — so a
 * 5,829-node dataset cold-warmup takes ~18 minutes. This endpoint:
 *
 *   - Returns up to 1,000 nodes per call (same as listNodes upper bound)
 *   - Cursor-based, NOT offset-based — not every graph engine honors
 *     offset reliably, and cursors are robust to inserts during pagination
 *   - Is RATE-LIMIT-EXEMPT (the only /api/* endpoint that is, beyond
 *     /api/health + /api/auth/bootstrap). Auth + ReBAC gates still
 *     run; the exemption is bucket-only.
 *
 * Cursor format: base64url JSON {updatedAt, id}. Server-side Cypher
 * orders by updatedAt DESC, id ASC so the cursor is a stable
 * tiebreaker even when multiple nodes share an updatedAt timestamp.
 *
 * Body shape:
 *   {
 *     workspace?: string,
 *     ecosystem?: string,    // R4 #6 — scope; omitted/'*' = every ecosystem
 *     type?: string | string[],
 *     tag?: string | string[],
 *     limit?: number,        // default 500, max 1000
 *     cursor?: string,       // opaque; pass back the value from a prior response
 *   }
 *
 * Response shape:
 *   {
 *     count: number,
 *     hasMore: boolean,
 *     nextCursor: string | null,
 *     workspace: string | null,
 *     ecosystem: string,     // the scope actually enforced
 *     nodes: LoreNode[],
 *   }
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
import { filterNodesByActorScope } from '../../../security/scopeFilter.js';
import { ecosystemMatches } from '../../../core/ecosystemMatch.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import type { BulkListQuery } from '../../../providers/types.js';

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;

export interface BulkListDeps {
    store: StorageBundle;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    graphRegistry?: LocalGraphRegistry;
}

interface BulkListBody {
    workspace?: unknown;
    /**
     * R4 #6 — ecosystem scope. This route builds its BulkListQuery with no
     * ecosystem at all and responds with the RAW rows, which carry `content`
     * on every engine — so it returned every ecosystem's full node bodies
     * while the sibling read surfaces were being confined. Omitted/'*' =
     * every ecosystem (unchanged for existing callers); a concrete value is
     * pushed down AND enforced in JS below.
     */
    ecosystem?: unknown;
    type?: unknown;
    tag?: unknown;
    limit?: unknown;
    cursor?: unknown;
}

interface CursorPayload {
    updatedAt: string;
    id: string;
}

function decodeCursor(raw: unknown): CursorPayload | null | { _err: string } {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') return { _err: 'cursor must be a string' };
    try {
        const json = Buffer.from(raw, 'base64url').toString('utf8');
        const parsed = JSON.parse(json) as CursorPayload;
        if (typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') {
            return { _err: 'cursor payload missing updatedAt or id' };
        }
        return parsed;
    } catch {
        return { _err: 'cursor not valid base64url JSON' };
    }
}

function encodeCursor(node: { updatedAt: string; id: string }): string {
    return Buffer.from(
        JSON.stringify({ updatedAt: node.updatedAt, id: node.id }),
        'utf8',
    ).toString('base64url');
}

function normalizeArray(raw: unknown): string[] | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'string') return raw.length > 0 ? [raw] : null;
    if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
    return null;
}

async function resolveTargetGraph(
    deps: BulkListDeps,
    requestedWorkspace: string | undefined,
): Promise<{ graph: LoreGraph; resolvedWorkspace: string } | { error: string; requested?: string; known?: string[] }> {
    let targetGraph: LoreGraph = deps.store.loreGraph;
    let resolvedWorkspace = requestedWorkspace ?? '';
    if (deps.graphRegistry) {
        resolvedWorkspace = requestedWorkspace ?? deps.graphRegistry.activeName();
        try {
            targetGraph = await deps.graphRegistry.getGraphHandle(resolvedWorkspace);
        } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
                return { error: 'workspace_not_found', requested: err.requested, known: err.known };
            }
            throw err;
        }
    }
    return { graph: targetGraph, resolvedWorkspace };
}

export async function tryBulkListRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: BulkListDeps,
): Promise<boolean> {
    if (pathname !== '/api/nodes/bulk-list' || req.method !== 'POST') return false;

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
        const parsed = parseJsonBody(body) as BulkListBody;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            writeError(res, 400, 'bad_request', 'body must be a JSON object');
            return true;
        }

        const requestedWorkspace = typeof parsed.workspace === 'string' && parsed.workspace.length > 0
            ? parsed.workspace : undefined;
        // Sprint L1 — workspace is required. No silent fallback to active workspace.
        if (!requestedWorkspace) {
            writeWorkspaceRequired(res);
            return true;
        }
        // SP-04 — token-scoped read gate. bulk-list enumerates up to 1k
        // nodes per page and is rate-limit-exempt, so an unscoped read is
        // a high-volume cross-workspace exfil. A principal bound to A
        // requesting B (or "*") needs cross-workspace-read. Null principal
        // = legacy/local bypass (same as the write routes).
        if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'read' }) === null) return true;
        const types = normalizeArray(parsed.type);
        const tags = normalizeArray(parsed.tag);
        const limitRaw = typeof parsed.limit === 'number' ? parsed.limit : 500;
        const limit = Math.min(Math.max(Math.floor(limitRaw), 1), 1000);
        const cursorResult = decodeCursor(parsed.cursor);
        if (cursorResult && '_err' in cursorResult) {
            writeError(res, 400, 'invalid_cursor', cursorResult._err);
            return true;
        }
        const cursor = cursorResult as CursorPayload | null;

        const resolved = await resolveTargetGraph(deps, requestedWorkspace);
        if ('error' in resolved) {
            writeError(res, 404, resolved.error, `workspace not found: ${resolved.requested}`, {
                requested: resolved.requested,
                known: resolved.known,
            });
            return true;
        }
        // Cloud parity — bulk-list is a graph-adapter method now (SurrealGraph:
        // SurrealQL; DataplaneGraph: SDK on lore_node). The route owns
        // cursor base64url (de/en)coding + limit clamp; the adapter owns the
        // (updatedAt DESC, id ASC) ordering, limit+1 hasMore detection, and
        // nextCursor selection. gateRoute already 503s cloud-without-Dataplane.
        // bulkList is declared on LoreGraphHandle — every graph substrate
        // (LocalGraph, SurrealGraph, DataplaneGraph) implements it directly.
        const requestedEcosystem = typeof parsed.ecosystem === 'string' && parsed.ecosystem.length > 0
            ? parsed.ecosystem
            : '*';
        const query: BulkListQuery = {
            types: types ?? undefined,
            tags: tags ?? undefined,
            // R4 #6/#7 — `project` is NOT the workspace. It is a caller-owned
            // node field that is not guaranteed to equal the workspace name
            // (Atlas stores project='v3' inside workspace='default'), and
            // every engine turns it into a strict equality predicate.
            // retrieve.ts:314-321 documents this exact substitution as the
            // mistake that "silently makes keyword fallback empty while the
            // vector path still appears healthy"; /api/query was corrected to
            // '*' for it. The physical workspace boundary is already enforced
            // by the graph resolution above (each workspace is its own
            // database), so passing the workspace name here only ever DROPPED
            // that workspace's own rows.
            project: undefined,
            ecosystem: requestedEcosystem !== '*' ? requestedEcosystem : undefined,
            limit,
            cursor,
        };
        const page = await resolved.graph.bulkList(query);
        // The pushdown is an optimisation; this is the decision point (see
        // core/ecosystemMatch.ts). Applied to the RAW rows, which is what the
        // response hands back — `content` included.
        const scopedNodes = requestedEcosystem === '*'
            ? page.nodes
            : page.nodes.filter((n) => ecosystemMatches((n as { ecosystem?: unknown }).ecosystem as string | undefined, requestedEcosystem));
        // 3.1 (2026-08-17) — row-level security_scopes confinement: hide
        // nodes whose scopes don't intersect the bound actor's scopes before
        // the list is serialized. Undefined actor scopes ⇒ no filtering.
        const confinedNodes = filterNodesByActorScope(scopedNodes);
        const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;

        writeJson(res, 200, {
            count: confinedNodes.length,
            hasMore: page.hasMore,
            nextCursor,
            workspace: resolved.resolvedWorkspace || null,
            ecosystem: requestedEcosystem,
            nodes: confinedNodes,
        });
    } catch (err) {
        // X-json400 (2026-09-03 audit) — malformed JSON used to fall
        // through to 500 here; parseJsonBody's tagged error is caught
        // first now.
        if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
        console.error(`[Lore HTTP] POST /api/nodes/bulk-list failed: ${redactError(err)}`);
        writeError(res, 500, 'internal_error', redactError(err));
    }
    return true;
}

/**
 * collections.ts — Phase 2 item 5: SDK-aligned tabular CRUD over HTTP.
 *
 * URL pattern matches `groundfloor-ts-sdk/src/client.ts` exactly so
 * the same SDK code can target Lore (local) or Dataplane (cloud) by
 * changing only the base URL:
 *
 *   POST   /v1/schema                            — createCollection
 *   GET    /v1/schema                            — listCollections (finding #7, 2026-09-03)
 *   GET    /v1/schema/{name}                     — getCollectionSchema
 *   POST   /v1/{collection}                      — insert (single row in body)
 *   GET    /v1/{collection}/{id}                 — get by primary key
 *   POST   /v1/{collection}/query                — query (filter+opts in body)
 *   PUT    /v1/{collection}                      — update by query ({filter, updates})
 *   DELETE /v1/{collection}                      — delete by query ({filter})
 *
 *   Phase 2.5 bulk variants (SDK-aligned URLs):
 *   POST   /v1/{collection}/bulk                 — bulkInsert ({records[]})
 *   POST   /v1/{collection}/count                — count ({filter?})
 *   PUT    /v1/{collection}/update-by-query      — updateByQuery ({filter, fields})
 *   DELETE /v1/{collection}/delete-by-query      — deleteByQuery ({filter}) — refuses all-filter
 *   POST   /v1/{collection}/truncate             — truncate (full wipe; preserves schema)
 *
 * The `/v1/schema` namespace is used for collection management
 * because `POST /v1/{collection}` is taken by single-row insert.
 * Verbatim from the TS SDK URL convention (`/v1/schema` for create,
 * `/v1/schema/{name}` for read).
 *
 * Auth: every /v1/* path requires a Bearer token (gated upstream by
 * httpAuth.ts BEARER_REQUIRED_NON_API_PATHS). Host + Origin checks
 * apply too — the daemon binds 127.0.0.1 only, so cross-origin
 * browser fetches are rejected before reaching this file.
 *
 * Handlers delegate to the same shared functions used by the
 * `collection_*` MCP tools (handleCreateCollection, handleInsert,
 * handleGet, handleQuery, handleUpdate, handleDelete) so behavior is
 * identical across surfaces. See packages/lore/src/mcp/tools/
 * collections.ts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

import {
    handleCreateCollection,
    handleSchemaGet,
    handleSchemaListPaged,
    handleInsert,
    handleGet,
    handleQuery,
    handleUpdate,
    handleDelete,
    handleBulkInsert,
    handleCount,
    handleUpdateByQuery,
    handleDeleteByQuery,
    handleTruncate,
} from '../../tools/collections.js';
import {
    describeTransactionFailure,
    handleTransaction,
} from '../../tools/collectionsTransaction.js';
import { handleJoinQuery } from '../../tools/collectionsJoin.js';
import { filterNodeZ, describeFilterZodError } from '../../tools/collectionsFilterSchema.js';
import { sdkCollectionSchemaZ, describeSchemaZodError } from '../../tools/collectionsSchemaTranslate.js';
import { CollectionValidationError } from '../../../engines/collectionRowValidation.js';
import type { ITableStorage, Row } from '../../../contracts/tables.js';
import type { Filter, FindOptions } from '../../../engines/collectionStorage.js';
import { readJsonBody, writeJson, writeError, isPayloadTooLarge, MAX_BODY_BYTES, PAYLOAD_TOO_LARGE } from '../helpers.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import { getCurrentWorkspaceId } from '../../../security/workspaceContext.js';
import { bindRouteTarget, isLegacyBypass } from '../../../security/routeWorkspaceBinding.js';
import type { StorageBundle } from '../../services.js';
import { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import { resolveTargetTableStorage } from '../../tools/workspaceResolve.js';
import { gateRoute } from '../../../security/routeGate.js'; // F-COL3
import { writePermissionDenied } from '../../../security/rebacGate.js'; // F-COL3
import type { GroundfloorClient } from 'groundfloor-ts-sdk'; // F-COL3

export interface CollectionsRoutesDeps {
    tableStorage: ITableStorage;
    /**
     * local-mode (Postgres model) per-workspace routing. OPTIONAL so this
     * file stays independently tsc-safe and test fixtures that mock only
     * `tableStorage` keep working. When `store`+`graphRegistry` are present,
     * each op resolves the REQUESTED workspace's table storage (the isolation
     * boundary between apps). When `graphRegistry` is absent the resolver
     * returns the boot store → behavior is unchanged.
     */
    store?: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    /**
     * F-COL3 — RouteGateDeps shape for the ReBAC object-level authz gate
     * (gateRoute). OPTIONAL so this file stays tsc-safe and unchanged for test
     * fixtures / unwired callers. When BOTH are present, every /v1 op runs
     * gateRoute (read/write per method) — local mode short-circuits to the
     * token-scope check, cloud mode defers to SpiceDB via the dataplane.
     * F-COL3 TODO: thread deploymentMode+dataplane from the dispatcher
     * (mcp/http/dispatcher.ts tryCollectionsRoutes call site) — until then the
     * gate is a no-op and the principal-scope gates below are the enforced layer.
     */
    deploymentMode?: 'local' | 'cloud';
    dataplane?: GroundfloorClient | null;
}

const META_PREFIX = '/v1/schema';
const V1_PREFIX = '/v1/';

/**
 * classifyStorageErr — Map a thrown storage error to an HTTP envelope.
 *
 * Used by every /v1/{collection}/... catch block so the daemon returns
 * a clean 4xx (not 500) when the request is structurally fine but the
 * target collection or row is missing or conflicting. The default still
 * surfaces the op-specific `opCode` and 500 for unknown errors.
 *
 * RC2 audit (2026-05-17) — Phase 1 finding: `/v1/{collection}/count` and
 * siblings returned 500 with a leaked SqliteTableStorage internal message
 * ("unknown table 'X' (createTable first)") when the collection didn't
 * exist. That's a structural client error (404), not a server crash.
 */
function classifyStorageErr(
    e: Error,
    opCode: string,
): { status: number; code: string; message: string; extras?: Record<string, unknown> } {
    // Payload-too-large is set as a structured code by readBoundedBody;
    // pass it through as 413 rather than treating it as a server error.
    if (isPayloadTooLarge(e)) {
        return {
            status: 413,
            code: PAYLOAD_TOO_LARGE,
            message: `request body exceeded ${MAX_BODY_BYTES} bytes`,
        };
    }
    // QA follow-up (2026-09-03) — readJsonBody (mcp/http/helpers.ts) throws
    // a plain `Error('invalid JSON body: ...')` on malformed JSON (truncated
    // body, trailing comma, etc). That's a structural client error (400),
    // not a server crash — every route that calls readJsonBody inside its
    // try block previously fell through to this function's 500 fallback
    // (e.g. `insert_failed`/`bulk_insert_failed`) with no indication the
    // body itself was unparseable.
    if (/^invalid JSON body:/i.test(e.message)) {
        return { status: 400, code: 'invalid_json_body', message: e.message };
    }
    // QA round-3 (A3) — the routes below now run `body.filter` through the
    // now-.strict() filterNodeZ (previously unvalidated); map a resulting
    // ZodError to 400 filter_invalid, naming the key, not a 500.
    if (e instanceof z.ZodError) {
        const detail = describeFilterZodError(e);
        if (detail) {
            return { status: 400, code: detail.code, message: detail.message };
        }
        return { status: 400, code: 'invalid_request', message: 'request body failed validation' };
    }
    // F6 (2026-09-03 audit) — collectionRowValidation.ts already validated
    // the row against its declared schema BEFORE the storage call, so this
    // is a structural client error (400), not a server crash. Read the
    // table/field/row-index off the error's own properties (not off the
    // message) so the response names them exactly, with no regex parsing
    // and no risk of `redactError`-style mangling.
    if (e instanceof CollectionValidationError) {
        return {
            status: 400,
            code: 'invalid_row',
            message: e.message,
            extras: {
                table: e.table,
                ...(e.field === undefined ? {} : { field: e.field }),
                ...(e.rowIndex === undefined ? {} : { row_index: e.rowIndex }),
            },
        };
    }
    const m = e.message;
    const unknownMatch = m.match(/unknown table '([^']+)'/i);
    if (unknownMatch) {
        return {
            status: 404,
            code: 'collection_not_found',
            message: `collection '${unknownMatch[1]}' not found`,
        };
    }
    // QA follow-up (2026-09-03) — `SqliteTableStorage.requireSchema` throws a
    // DIFFERENT message than "unknown table" when the table physically
    // exists on disk but its schema wasn't reloaded (schemas.json deleted,
    // or an upgrade dropped it, then the daemon restarted): "table 'X'
    // exists in the DB but its schema is not cached...". That regex above
    // never matched it, so GET/DELETE `/v1/{collection}/{id}` fell through
    // to the 500 fallback below. From the API's point of view the
    // collection is not currently reachable either way — re-declaring the
    // same schema via `collection_create`/`POST /v1/schema` restores access
    // (data is preserved) — so this is honestly a 404, not a 400: the
    // request itself isn't malformed, the collection just isn't resolvable
    // right now.
    const uncachedMatch = m.match(/table '([^']+)' exists in the DB but its schema is not cached/i);
    if (uncachedMatch) {
        return {
            status: 404,
            code: 'collection_not_found',
            message: `collection '${uncachedMatch[1]}' schema is not loaded — re-declare it via `
                + 'collection_create/POST /v1/schema with the original schema to restore access '
                + '(data is preserved)',
        };
    }
    // R4 #9 — match the REAL backend messages, not just the engine-agnostic
    // 'duplicate primary key': better-sqlite3 throws 'UNIQUE constraint failed:
    // <table>.<col>' and the former local graph engine a 'duplicated primary
    // key' runtime exception. These previously fell through to a 500 that
    // LEAKED the raw backend text. Return a clean 409 with no internal detail.
    if (/duplicate primary key|UNIQUE constraint failed|duplicated primary key|primary key.*already exists/i.test(m)) {
        return { status: 409, code: 'duplicate_primary_key', message: 'a row with this primary key already exists' };
    }
    // R4 #9 — a NOT NULL violation is a client error (missing required field),
    // not a 500 (also reachable via the R4 #8 type-aware backfill).
    if (/NOT NULL constraint failed/i.test(m)) {
        return { status: 400, code: 'missing_required_field', message: 'a required field is missing or null' };
    }
    // Round-E A3 fix: INVALID (structurally malformed / over-nested) used to
    // share the ALL branch's wording and its 400 all_filter_refused code —
    // including "use collection_truncate to wipe" advice — even for a
    // filter that targets exactly one row but merely nests too deep. Check
    // the INVALID phrasing (unique to assertValidFilter's INVALID throw,
    // collectionsFilterScope.ts) first so it gets its own code with no
    // all-filter/truncate advice.
    if (/structurally invalid filter/i.test(m)) {
        return { status: 400, code: 'filter_invalid', message: m };
    }
    if (/empty\/all filter|use truncate/i.test(m)) {
        return { status: 400, code: 'all_filter_refused', message: m };
    }
    // R4 #9 — do NOT leak raw storage-engine text on the 500 fallthrough.
    return { status: 500, code: opCode, message: 'internal storage error' };
}

/**
 * L-067 — per-token write-scope gate for the MUTATING /v1/{collection}
 * operations (POST insert/bulk/truncate, PUT, DELETE). The tabular CRUD
 * surface required a Bearer upstream but enforced neither ReBAC nor the
 * per-token write scope, so a read-only token could insert/update/delete.
 * Mirrors nodes-delete.ts: a bound principal must hold 'write' for the
 * request's workspace; a null/local principal bypasses (preserved). Reads
 * (GET, POST query, POST count) do NOT call this. Returns true when it wrote
 * a 4xx (caller must `return true`).
 */
async function denyCollectionWrite(res: ServerResponse, deps?: CollectionsRoutesDeps): Promise<boolean> {
    if (await gateReBAC(res, 'write', deps)) return true; // F-COL3
    // The pure legacy/direct-call bypass is the ONE case where bindRouteTarget
    // returns null WITHOUT writing a denial (no principal, no slot, no requested
    // workspace). Detect it up front and skip the gate — otherwise this returns
    // true ("handled") but never writes a response and the client hangs forever.
    // Matches the sibling route families (schema.ts, versioning.ts, …).
    const requested = getCurrentWorkspaceId() ?? undefined;
    return !isLegacyBypass(requested) &&
        bindRouteTarget(res, { requested, intent: 'write' }) === null;
}

/**
 * F-COL3 — ReBAC object-level authz gate for the /v1 tabular surface (the only
 * REST family that never called gateRoute, so cloud mode had no SpiceDB check).
 * No-op unless BOTH deploymentMode+dataplane are wired (see CollectionsRoutesDeps
 * F-COL3 TODO). Local mode short-circuits to the token-scope check inside
 * gateRoute; the principal-scope gates remain the always-on local layer.
 * Returns true when it wrote a denial envelope (caller must `return true`).
 */
async function gateReBAC(
    res: ServerResponse,
    permission: 'read' | 'write',
    deps?: CollectionsRoutesDeps,
): Promise<boolean> {
    if (!deps || deps.deploymentMode === undefined || deps.dataplane === undefined) return false;
    const gate = await gateRoute({ deploymentMode: deps.deploymentMode, dataplane: deps.dataplane }, { permission });
    if (gate.allowed) return false;
    writePermissionDenied(res, gate);
    return true;
}

/**
 * audit 2026-06-25 — per-token cross-workspace READ gate for the /v1 tabular
 * GET/query/count surface. routeDeps() routes to the REQUESTED workspace
 * (getCurrentWorkspaceId() tenant header), but the read handlers never checked
 * the principal may read it — so a workspace-A token with an X-Lore-Workspace:B
 * header could read B's collection rows. Mirrors denyCollectionWrite: a bound
 * principal must hold read for the request's workspace; a null/local principal
 * bypasses (preserved). Returns true when it wrote a 4xx (caller must return).
 */
async function denyCollectionRead(res: ServerResponse, deps?: CollectionsRoutesDeps): Promise<boolean> {
    if (await gateReBAC(res, 'read', deps)) return true; // F-COL3
    // The pure legacy/direct-call bypass is the ONE case where bindRouteTarget
    // returns null WITHOUT writing a denial (no principal, no slot, no requested
    // workspace). Detect it up front and skip the gate — otherwise this returns
    // true ("handled") but never writes a response and the client hangs forever.
    // Matches the sibling route families (schema.ts, versioning.ts, …).
    const requested = getCurrentWorkspaceId() ?? undefined;
    return !isLegacyBypass(requested) &&
        bindRouteTarget(res, { requested, intent: 'read' }) === null;
}

/**
 * routeDeps — local-mode (Postgres model) per-workspace routing.
 *
 * Every /v1/* collection op (read OR write) targets a workspace. Like the
 * `denyCollectionWrite` gate, the requested workspace is the one bound to the
 * current request context (`getCurrentWorkspaceId()`, falling back to the
 * principal's workspace). A workspace-taking op MUST route its data read/write
 * to the REQUESTED workspace, not the boot/active store — that's the isolation
 * boundary between apps sharing one daemon.
 *
 * Returns deps whose `tableStorage` is the per-workspace store on success, or
 * `null` after writing a 4xx envelope (the caller must `return true`).
 *
 * Boot fallback: when `graphRegistry` (or `store`) is absent the resolver
 * returns the boot store, so the returned deps are equivalent to the input —
 * behavior is unchanged for embedded/cloud/tests.
 */
async function routeDeps(
    deps: CollectionsRoutesDeps,
    res: ServerResponse,
): Promise<CollectionsRoutesDeps | null> {
    // No registry/store wired (embedded, cloud, or test fixtures) → boot store.
    if (!deps.graphRegistry || !deps.store) return deps;
    const active = deps.graphRegistry.activeName();
    // The request-bound workspace is the routing target; fall back to the
    // active workspace name so `requested` is always non-empty (the resolver
    // treats empty as `workspace_required`).
    const p = getCurrentPrincipal();
    const requested = getCurrentWorkspaceId() ?? p?.workspace ?? active;
    const r = await resolveTargetTableStorage(deps.store, deps.graphRegistry, active, requested);
    if (!r.ok) {
        if ('missing' in r) {
            writeError(res, 400, 'workspace_required', 'a workspace must be bound to route this collection op');
            return null;
        }
        writeError(res, 404, 'workspace_not_found',
            `workspace '${r.requested}' not found (known: ${r.known.join(', ')})`);
        return null;
    }
    return { ...deps, tableStorage: r.tableStorage };
}

/**
 * tryCollectionsRoutes — Returns true if the request was handled by a
 * `/v1/*` route. Mirrors the convention used by every other route
 * family (`tryNodesRoutes`, `tryWorkspacesRoutes`, etc.).
 *
 * Family ordering note: the dispatcher must call this BEFORE any
 * `/api/*` family check (those skip on prefix mismatch anyway, so
 * order is purely about minimizing wasted compares).
 */
export async function tryCollectionsRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: CollectionsRoutesDeps,
): Promise<boolean> {
    if (!pathname.startsWith(V1_PREFIX)) return false;

    /* ─── POST /v1/transaction — atomic typed mutations ───────── */
    if ((pathname === '/v1/transaction' || pathname === '/v1/transaction/')
        && req.method === 'POST') {
        if (await denyCollectionWrite(res, deps)) return true;
        try {
            const body = await readJsonBody(req);
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            writeJson(res, 200, await handleTransaction(rdeps, body));
        } catch (error) {
            const failure = describeTransactionFailure(error);
            writeError(res, failure.status, failure.code, failure.message, {
                ...(failure.failed_op_index === undefined
                    ? {}
                    : { failed_op_index: failure.failed_op_index }),
                reason: failure.reason,
                // B2 — carry table/field through for an invalid_row failure,
                // same as insert/bulk_insert's classifyStorageErr extras.
                ...(failure.table === undefined ? {} : { table: failure.table }),
                ...(failure.field === undefined ? {} : { field: failure.field }),
            });
        }
        return true;
    }

    /* ─── POST /v1/query — multi-hop join ─────────────────────── */
    if ((pathname === '/v1/query' || pathname === '/v1/query/')
        && req.method === 'POST') {
        if (await denyCollectionRead(res, deps)) return true;
        try {
            const body = await readJsonBody(req);
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            writeJson(res, 200, await handleJoinQuery(rdeps, body));
        } catch (error) {
            const message = (error as Error).message ?? '';
            if (/invalid identifier|filter_too_nested|empty (and|or)|joinMany accepts at most|joinMany requires|join not supported/i.test(message)) {
                writeError(res, 400, 'invalid_join_query', 'join query was rejected');
            } else {
                const c = classifyStorageErr(error as Error, 'join_query_failed');
                writeError(res, c.status, c.code, c.message);
            }
        }
        return true;
    }

    /* ─── meta: createCollection ──────────────────────────────── */
    if (pathname === META_PREFIX && req.method === 'POST') {
        if (await denyCollectionWrite(res, deps)) return true; // L-067 — creating a collection is a mutating op; require write scope.
        try {
            const body = await readJsonBody(req);
            // Round-S fix (2026-09-04, finding 1) — used to duck-type the
            // body instead of running it through the same zod schema
            // `collection_create` already validates against, so a field
            // with the wrong key or an unrecognized type (`type:'text'`,
            // not `field_type`/COLUMN_TYPE_ENUM) silently persisted with
            // type `undefined` — see describeSchemaZodError below.
            const schema = sdkCollectionSchemaZ.parse(body);
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const created = await handleCreateCollection(rdeps, schema);
            writeJson(res, 201, created);
        } catch (e) {
            if (e instanceof z.ZodError) {
                const d = describeSchemaZodError(e);
                writeError(res, 400, d.code, d.message);
                return true;
            }
            // audit 2026-06-25 — route through classifyStorageErr so a structural
            // error maps to a clean 4xx and the 500 fallthrough returns a generic
            // 'internal storage error' instead of leaking the raw engine message.
            const c = classifyStorageErr(e as Error, 'create_collection_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    /* ─── meta: listCollections ────────────────────────────────
     * Finding #7 (2026-09-03) — `GET /v1/schema` (no trailing name)
     * used to fall through to the `/v1/{collection}` segment split
     * below, where `schema` is a RESERVED top-level segment, so it
     * 404'd as `unknown_v1_path`. There was no way to enumerate
     * collections short of already knowing a name. Handled here,
     * BEFORE the `startsWith(META_PREFIX + '/')` schema-get branch,
     * since a bare `/v1/schema` doesn't match that prefix anyway —
     * ordering only matters relative to the segment-split fallthrough.
     *
     * Finding B3 (round E, 2026-09-03) — paginated via `?limit=`,
     * `?offset=`/`?cursor=`, `?withCounts=` query params (defaults:
     * 100 / 0 / false — see `handleSchemaListPaged`). Non-numeric
     * limit/offset fall back to their defaults rather than 400ing,
     * matching this codebase's existing GET-list query-param
     * convention (e.g. routes/versioning.ts, routes/edges.ts).
     *
     * Finding B3 (round E2, 2026-09-03) — `?cursor=` is now a keyset
     * cursor (the name of the last entry on the prior page), stable
     * under concurrent collection creates/drops; `?offset=` remains
     * supported as a raw, best-effort position but is NOT stable
     * under concurrent creates/drops — prefer following `?cursor=`
     * for a correct full-set walk. A cursor from before this fix
     * (`{offset}`-shaped) fails to decode and falls back to
     * `?offset=` (0 if absent), same as any other malformed cursor.
     */
    if (pathname === META_PREFIX && req.method === 'GET') {
        if (await denyCollectionRead(res, deps)) return true;
        try {
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const qp = new URL(url, 'http://localhost').searchParams;
            const limitRaw = qp.get('limit');
            const offsetRaw = qp.get('offset');
            const result = await handleSchemaListPaged(rdeps, {
                limit: limitRaw !== null ? Number(limitRaw) : undefined,
                offset: offsetRaw !== null ? Number(offsetRaw) : undefined,
                cursor: qp.get('cursor') ?? undefined,
                withCounts: qp.get('withCounts') === 'true',
            });
            writeJson(res, 200, result);
        } catch (e) {
            const c = classifyStorageErr(e as Error, 'schema_list_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    /* ─── meta: getCollectionSchema ───────────────────────────── */
    if (pathname.startsWith(META_PREFIX + '/') && req.method === 'GET') {
        const name = decodeURIComponent(pathname.slice(META_PREFIX.length + 1));
        if (await denyCollectionRead(res, deps)) return true; // RA2-reaudit2 — cross-workspace read gate (mirrors line 319/339); a collection schema is workspace-scoped metadata
        try {
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const schema = await handleSchemaGet(rdeps, name);
            if (!schema) {
                writeError(res, 404, 'collection_not_found',
                    `collection '${name}' not introspectable from this adapter`);
                return true;
            }
            writeJson(res, 200, schema);
        } catch (e) {
            // audit 2026-06-25 — don't leak the raw storage-engine error.
            const c = classifyStorageErr(e as Error, 'schema_get_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    /* ─── /v1/{collection}/{id?} | /v1/{collection}/query ─────── */
    const tail = pathname.slice(V1_PREFIX.length);
    // RC2 audit (2026-05-17): keep empty segments rather than dropping
    // them silently. `/v1//count` was being parsed as POST /v1/count
    // (insert into a table literally named "count"), which surfaced as
    // a 500 with an internal SQLite message. Treat any empty segment as
    // a malformed path and 404 it before reaching a handler.
    const segments = tail.split('/');
    if (segments.length === 0 || segments.some((s) => s.length === 0)) {
        writeError(res, 404, 'unknown_v1_path',
            `no /v1 route for ${pathname}`);
        return true;
    }
    // Reserved top-level segments under /v1/ — handled by the meta
    // routes above, or reserved by the SDK for future use (sql, authz).
    // If we got here with one of these, it's an unsupported variant
    // (e.g. wrong method) and should 404 rather than be treated as a
    // collection name.
    const RESERVED = new Set(['schema', 'sql', 'authz', 'transaction', 'query']);
    if (RESERVED.has(segments[0])) {
        writeError(res, 404, 'unknown_v1_path',
            `no /v1 route for ${pathname}`);
        return true;
    }
    const collection = decodeURIComponent(segments[0]);
    const sub = segments[1] !== undefined ? decodeURIComponent(segments[1]) : undefined;
    // After URI-decoding, the collection identifier must still be a
    // simple opaque label. SQLite would accept arbitrary strings in
    // quoted-identifier form, but anything that doesn't match the
    // existing snake_case convention on this surface is a strong
    // indicator of injection probing — fail closed.
    if (!/^[A-Za-z0-9_-]+$/.test(collection)) {
        writeError(res, 400, 'invalid_collection_name',
            'collection name must match /^[A-Za-z0-9_-]+$/');
        return true;
    }

    /* GET /v1/{collection}/{id} — single-row read */
    if (req.method === 'GET' && sub !== undefined && segments.length === 2) {
        if (await denyCollectionRead(res, deps)) return true; // audit 2026-06-25 — cross-workspace read gate
        try {
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const row = await handleGet(rdeps, collection, sub);
            if (row === null) {
                writeError(res, 404, 'row_not_found',
                    `no row with id '${sub}' in '${collection}'`);
                return true;
            }
            writeJson(res, 200, row);
        } catch (e) {
            const c = classifyStorageErr(e as Error, 'get_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    /* POST /v1/{collection}/query */
    if (req.method === 'POST' && sub === 'query' && segments.length === 2) {
        if (await denyCollectionRead(res, deps)) return true; // audit 2026-06-25 — cross-workspace read gate
        try {
            const body = await readJsonBody(req) as { filter?: Filter; opts?: FindOptions };
            // QA round-3 (A3) — reads are lower-risk than the mutate routes
            // below, but get the same strict filter validation for consistency.
            const filter = filterNodeZ.optional().parse(body?.filter);
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const result = await handleQuery(rdeps, collection, filter, body?.opts);
            writeJson(res, 200, result);
        } catch (e) {
            const c = classifyStorageErr(e as Error, 'query_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    /* ── Phase 2.5 bulk variants ──────────────────────────────── */

    /* POST /v1/{collection}/bulk — bulk insert */
    if (req.method === 'POST' && sub === 'bulk' && segments.length === 2) {
        if (await denyCollectionWrite(res, deps)) return true; // L-067
        try {
            const body = await readJsonBody(req) as { records?: Row[] };
            if (!body || !Array.isArray(body.records)) {
                writeError(res, 400, 'invalid_bulk_body',
                    'body must be {records: Row[]}');
                return true;
            }
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const result = await handleBulkInsert(rdeps, collection, body.records);
            writeJson(res, 201, { success: true, data: result });
        } catch (e) {
            // F6 — pass `extras` through so an invalid_row 400 names the
            // offending table/field/row_index, not just a bare message.
            const c = classifyStorageErr(e as Error, 'bulk_insert_failed');
            writeError(res, c.status, c.code, c.message, c.extras);
        }
        return true;
    }

    /* POST /v1/{collection}/count — count rows (optional filter in body) */
    if (req.method === 'POST' && sub === 'count' && segments.length === 2) {
        if (await denyCollectionRead(res, deps)) return true; // audit 2026-06-25 — cross-workspace read gate
        try {
            const body = await readJsonBody(req) as { filter?: Filter };
            // QA round-3 — see POST /v1/{collection}/query above.
            const filter = filterNodeZ.optional().parse(body?.filter);
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const result = await handleCount(rdeps, collection, filter);
            writeJson(res, 200, { success: true, data: result });
        } catch (e) {
            const c = classifyStorageErr(e as Error, 'count_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    /* PUT /v1/{collection}/update-by-query — bulk update */
    if (req.method === 'PUT' && sub === 'update-by-query' && segments.length === 2) {
        if (await denyCollectionWrite(res, deps)) return true; // L-067
        try {
            const body = await readJsonBody(req) as { filter?: Filter; fields?: Record<string, unknown>; all?: boolean };
            if (!body || !body.filter || !body.fields) {
                writeError(res, 400, 'invalid_update_by_query_body',
                    'body must be {filter: Filter, fields: object}');
                return true;
            }
            const filter = filterNodeZ.parse(body.filter); // QA round-3 (A3)
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            // X-allrows — `all:true` opt-in, same semantics as collection_update.
            const result = await handleUpdateByQuery(rdeps, collection, filter, body.fields, body.all === true);
            writeJson(res, 200, { success: true, data: result });
        } catch (e) {
            // QA follow-up — pass `extras` through so an invalid_row 400
            // names the offending table/field, matching insert/bulk_insert.
            const c = classifyStorageErr(e as Error, 'update_by_query_failed');
            writeError(res, c.status, c.code, c.message, c.extras);
        }
        return true;
    }

    /* DELETE /v1/{collection}/delete-by-query — bulk delete (rejects all-filter) */
    if (req.method === 'DELETE' && sub === 'delete-by-query' && segments.length === 2) {
        if (await denyCollectionWrite(res, deps)) return true; // L-067
        try {
            const body = await readJsonBody(req) as { filter?: Filter; all?: boolean };
            if (!body || !body.filter) {
                writeError(res, 400, 'invalid_delete_by_query_body',
                    'body must be {filter: Filter}');
                return true;
            }
            // QA round-3 — see PUT /v1/{collection}/update-by-query above.
            const filter = filterNodeZ.parse(body.filter);
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            // X-allrows — `all:true` opt-in, same semantics as collection_delete.
            const result = await handleDeleteByQuery(rdeps, collection, filter, body.all === true);
            writeJson(res, 200, { success: true, data: result });
        } catch (e) {
            // isAllFilter throws — classifyStorageErr maps it to 400.
            const c = classifyStorageErr(e as Error, 'delete_by_query_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    /*
     * DELETE /v1/{collection}/{id} — delete by primary key.
     *
     * F-DEL8 — the SDK/docs/DATAPLANE_INTEGRATION.md have always
     * documented this shape (mirrors `GET /v1/{collection}/{id}`
     * above), but only the filter form (`DELETE /v1/{collection}`
     * with `{filter}` body) and `delete-by-query` existed; this path
     * previously fell through to the 405 at the bottom of this
     * function. The `sub === 'delete-by-query'` branch above already
     * claimed that literal segment, so any other two-segment DELETE
     * lands here.
     *
     * Same response shape as the filter-delete branch below
     * (`{ deleted: number }`) so callers don't need to branch on
     * which DELETE shape they used.
     */
    if (req.method === 'DELETE' && sub !== undefined && segments.length === 2) {
        if (await denyCollectionWrite(res, deps)) return true; // L-067
        try {
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            // The primary-key column isn't necessarily named "id" — read
            // it off the schema (falls back to "id" when the schema isn't
            // introspectable, matching the historical getByKey behavior).
            const schema = await handleSchemaGet(rdeps, collection);
            const pkField = schema?.fields.find((f) => f.primary_key)?.name ?? 'id';
            const result = await handleDelete(rdeps, collection, { eq: { [pkField]: sub } });
            if (result.deleted === 0) {
                writeError(res, 404, 'row_not_found',
                    `no row with id '${sub}' in '${collection}'`);
                return true;
            }
            writeJson(res, 200, result);
        } catch (e) {
            const c = classifyStorageErr(e as Error, 'delete_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    /* POST /v1/{collection}/truncate — full wipe, preserves schema */
    if (req.method === 'POST' && sub === 'truncate' && segments.length === 2) {
        if (await denyCollectionWrite(res, deps)) return true; // L-067
        try {
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const result = await handleTruncate(rdeps, collection);
            writeJson(res, 200, { success: true, data: result });
        } catch (e) {
            const c = classifyStorageErr(e as Error, 'truncate_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    /* POST /v1/{collection} — insert single row */
    if (req.method === 'POST' && sub === undefined && segments.length === 1) {
        if (await denyCollectionWrite(res, deps)) return true; // L-067
        try {
            const body = await readJsonBody(req) as Row;
            if (!body || typeof body !== 'object') {
                writeError(res, 400, 'invalid_record', 'body must be a JSON object (the row)');
                return true;
            }
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const inserted = await handleInsert(rdeps, collection, body);
            writeJson(res, 201, inserted);
        } catch (e) {
            // F6 — pass `extras` through so an invalid_row 400 names the
            // offending table/field, not just a bare message.
            const c = classifyStorageErr(e as Error, 'insert_failed');
            writeError(res, c.status, c.code, c.message, c.extras);
        }
        return true;
    }

    /* PUT /v1/{collection} — update by query, body = {filter, updates} */
    if (req.method === 'PUT' && sub === undefined && segments.length === 1) {
        if (await denyCollectionWrite(res, deps)) return true; // L-067
        try {
            const body = await readJsonBody(req) as { filter: Filter; updates: Record<string, unknown> };
            if (!body || !body.filter || !body.updates) {
                writeError(res, 400, 'invalid_update_body',
                    'body must be {filter: Filter, updates: object}');
                return true;
            }
            const filter = filterNodeZ.parse(body.filter); // QA round-3 (A3) — the hole this finding reproduced
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const result = await handleUpdate(rdeps, collection, filter, body.updates);
            writeJson(res, 200, result);
        } catch (e) {
            // QA follow-up — pass `extras` through so an invalid_row 400
            // names the offending table/field, matching insert/bulk_insert.
            const c = classifyStorageErr(e as Error, 'update_failed');
            writeError(res, c.status, c.code, c.message, c.extras);
        }
        return true;
    }

    /* DELETE /v1/{collection} — delete by query, body = {filter} */
    if (req.method === 'DELETE' && sub === undefined && segments.length === 1) {
        if (await denyCollectionWrite(res, deps)) return true; // L-067
        try {
            const body = await readJsonBody(req) as { filter: Filter };
            if (!body || !body.filter) {
                writeError(res, 400, 'invalid_delete_body',
                    'body must be {filter: Filter}');
                return true;
            }
            // QA round-3 — see PUT /v1/{collection} above.
            const filter = filterNodeZ.parse(body.filter);
            const rdeps = await routeDeps(deps, res);
            if (!rdeps) return true;
            const result = await handleDelete(rdeps, collection, filter);
            writeJson(res, 200, result);
        } catch (e) {
            const c = classifyStorageErr(e as Error, 'delete_failed');
            writeError(res, c.status, c.code, c.message);
        }
        return true;
    }

    writeError(res, 405, 'method_not_allowed',
        `method ${req.method} not allowed on ${pathname}`);
    return true;
}

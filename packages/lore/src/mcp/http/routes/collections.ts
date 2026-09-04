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

import {
    handleCreateCollection,
    handleSchemaGet,
    handleSchemaListPaged,
} from '../../tools/collections.js';
import {
    describeTransactionFailure,
    handleTransaction,
} from '../../tools/collectionsTransaction.js';
import { handleJoinQuery } from '../../tools/collectionsJoin.js';
import { sdkCollectionSchemaZ, describeSchemaZodError } from '../../tools/collectionsSchemaTranslate.js';
import { readJsonBody, writeJson, writeError } from '../helpers.js';
import { z } from 'zod';
import {
    type CollectionsRoutesDeps,
    V1_PREFIX,
    classifyStorageErr,
    denyCollectionWrite,
    denyCollectionRead,
    routeDeps,
    tryCollectionsRowRoutes,
} from './collectionsRowRoutes.js';

// Re-exported for anything (tests, other route files) that only knows this
// file's path — collectionsRowRoutes.ts is the split-out implementation
// detail, collections.ts stays the stable public surface.
export type { CollectionsRoutesDeps };

const META_PREFIX = '/v1/schema';

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

    /* ─── /v1/{collection}/{id?} | /v1/{collection}/query ───────
     * Split out into collectionsRowRoutes.ts (this file was at the
     * 800-line file-size cap) — every route keyed on a `{collection}`
     * path segment lives there. Pure extraction: same dispatch, same
     * order, no behavior change.
     */
    return tryCollectionsRowRoutes(req, res, url, pathname, deps);
}

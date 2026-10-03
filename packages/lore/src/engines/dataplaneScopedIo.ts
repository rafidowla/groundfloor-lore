/**
 * dataplaneScopedIo.ts — small shared helpers for scoped cloud reads/writes.
 *
 * Purpose:
 *   The graph, verbatim store and collection storage all need the same three
 *   primitives on top of dataplaneScopeFilter: (1) scoped upsert (update-by-query
 *   → insert on 0 matched → retry the update once on a PK conflict), (2) mapping
 *   a raw row back to logical ids (`lore_id` → `id`, so the hashed row key never
 *   leaves the adapter), (3) applying the client-side scope predicate with a
 *   fail-closed drop + log.
 *
 * No SDK import: the client is typed structurally.
 */

import { log } from '../logger.js';
import {
    buildDataplaneScopeFilter,
    dataplaneRowKey,
    guardScope,
    scopeRowFields,
    type DataplaneScope,
    type EngineOp,
    type ScopeFilterInput,
} from './dataplaneScopeFilter.js';

export interface ScopedGetClient {
    get<T = unknown>(tenantId: string, collection: string, id: string, connection?: string): Promise<T>;
}

export interface ScopedUpsertClient extends ScopedGetClient {
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated?: number }>;
    insert<T = unknown>(tenantId: string, collection: string, record: T, connection?: string): Promise<unknown>;
}

/**
 * True when `err` is the engine's "no such record" signal. The real engine answers GET-by-id with
 * HTTP 200 and `{success:false, error:{code:'ERR_NOT_FOUND'}}`. The 1.x SDK returns that envelope
 * (handled in scopedGetRow as a RESPONSE); the 3.x SDK (v3-enterprise-scale, TS-3) THROWS a
 * GroundfloorError for a 200 `{success:false}` body, with `statusCode` = the HTTP status (200 for an
 * opaque string code) and the symbolic code on `engineCode`. Both must count as "no such row", else a
 * first-time upsert throws instead of inserting. Structured fields only — never message text.
 */
function isNotFoundError(err: unknown): boolean {
    const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; engineCode?: unknown } | null | undefined;
    if (!e || typeof e !== 'object') return false;
    return e.status === 404 || e.statusCode === 404 || e.code === 'ERR_NOT_FOUND' || e.engineCode === 'ERR_NOT_FOUND';
}

/**
 * Identity lookup by ROW KEY (D2): `GET /collections/{c}/{id}`, never a filtered `limit: N` query
 * (those are not identity lookups: the SQLite connector ignores filters and returns arbitrary
 * rows, so `limit: 1` would return somebody else's row and the real one would look absent).
 *
 * Returns the raw row (still carrying the physical `id`) iff it passes guardScope for `loreId`;
 * null when the engine says it does not exist OR the row is out of scope (logged, fail closed).
 * ANY other failure (5xx, network, malformed response) is re-thrown: callers must not treat a
 * transient outage as "no row" and then overwrite counters / created_at from defaults.
 *
 * Accepts the raw engine envelope (`{success, data, error}` — what the current TS SDK returns
 * from get(), the SDK only throws on a non-2xx) and a bare row (an SDK build that unwraps).
 */
export async function scopedGetRow(
    client: ScopedGetClient,
    scope: DataplaneScope,
    collection: string,
    loreId: string,
    connection?: string,
): Promise<Record<string, unknown> | null> {
    let res: unknown;
    try {
        res = await client.get<unknown>(scope.dataplaneWorkspaceId, collection, dataplaneRowKey(scope, loreId), connection);
    } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
    }
    if (res === null || res === undefined) return null;
    if (typeof res !== 'object') throw new Error(`cloud get ${collection}: unexpected response type ${typeof res}`);
    let row = res as Record<string, unknown>;
    if (typeof row['success'] === 'boolean' && ('data' in row || 'error' in row)) {
        if (row['success'] === false) {
            const error = row['error'] as { code?: unknown; message?: unknown } | null | undefined;
            if (error?.code === 'ERR_NOT_FOUND') return null;
            throw Object.assign(new Error(`cloud get ${collection} failed: ${String(error?.message ?? 'unknown error')}`), { code: error?.code });
        }
        const data = row['data'];
        if (data === null || data === undefined) return null;
        if (typeof data !== 'object') throw new Error(`cloud get ${collection}: unexpected data type ${typeof data}`);
        row = data as Record<string, unknown>;
    }
    if (guardScope(row, scope, loreId)) return row;
    log.error('[cloud-scope] cloud_scope_mismatch — dropped out-of-scope row on get', { collection, loreId });
    return null;
}

/**
 * True for a structured HTTP 409 (duplicate key) — what a strict connector MAY return; the real
 * engine returns 500 ERR_QUERY for duplicates, handled by insertLostRace (scoped GET). Decided on
 * the structured status only (SDK `GroundfloorError.statusCode`, or a
 * `status` field): matching the message text misclassified unrelated failures
 * ("connection reset (409 bytes …)", a 500 that quotes "duplicate key") as a
 * write-write conflict and turned them into a silent retry.
 */
export function isConflictError(err: unknown): boolean {
    const e = err as { status?: unknown; statusCode?: unknown } | null | undefined;
    if (!e || typeof e !== 'object') return false;
    return e.status === 409 || e.statusCode === 409;
}

/**
 * Scoped upsert of one logical row. `fields` are the non-identity columns; the
 * identity + scope columns (`id`=row key, lore_id, lore_workspace, org_id) are
 * added here so no caller can forget them. The row key is NOT part of the update
 * payload (primary keys are immutable) — only insert carries it.
 *
 * Returns 'inserted' | 'updated'.
 */
export async function scopedUpsert(
    client: ScopedUpsertClient,
    scope: DataplaneScope,
    collection: string,
    loreId: string,
    fields: Record<string, unknown>,
    connection?: string,
): Promise<'inserted' | 'updated'> {
    const ident = scopeRowFields(scope, loreId);
    const filter = buildDataplaneScopeFilter(scope, { loreId }, 'crud', 0).server as object;
    const { id: _rowKey, ...updateIdent } = ident;
    void _rowKey;
    const updateFields = { ...fields, ...updateIdent };
    const tenant = scope.dataplaneWorkspaceId;
    const res = await client.updateByQuery(tenant, collection, filter, updateFields, connection);
    if ((res?.updated ?? 0) > 0) return 'updated';
    try {
        await client.insert(tenant, collection, { ...fields, ...ident }, connection);
        return 'inserted';
    } catch (err) {
        if (!(await insertLostRace(client, scope, collection, loreId, err, connection))) throw err;
        // A concurrent writer inserted the same row key between our update and
        // insert. Retry the update once; if it still matches nothing, surface it.
        const retry = await client.updateByQuery(tenant, collection, filter, updateFields, connection);
        if ((retry?.updated ?? 0) > 0) return 'updated';
        throw err;
    }
}

/**
 * Did this failed insert lose a duplicate-key race? The engine reports a duplicate PK / unique
 * index violation as HTTP 500 ERR_QUERY with a deliberately opaque message (engine
 * `DataplaneError::Query`, origin/main src/error.rs) — there is no 409 and no structured code,
 * and message text is not parsed. So: a structured 409 is a conflict; any other insert failure is
 * disambiguated by ONE scoped GET by row key — the row exists (in scope) => it was a conflict
 * (update it); it does not exist (or the GET itself fails) => the insert failed for a real
 * reason and the original error is surfaced.
 */
async function insertLostRace(
    client: ScopedGetClient,
    scope: DataplaneScope,
    collection: string,
    loreId: string,
    insertError: unknown,
    connection: string | undefined,
): Promise<boolean> {
    if (isConflictError(insertError)) return true;
    try {
        return (await scopedGetRow(client, scope, collection, loreId, connection)) !== null;
    } catch {
        return false;
    }
}

/** Raw row → logical row: `id` becomes the logical `lore_id`; the row key is dropped from view. */
export function unscopeRow(row: Record<string, unknown>): Record<string, unknown> {
    const loreId = row['lore_id'];
    if (typeof loreId !== 'string' || loreId === '') return row;
    return { ...row, id: loreId };
}

/**
 * Apply the client-side scope predicate to engine results (fail closed): rows
 * that fail are dropped and logged, never returned.
 */
export function keepInScope<T extends Record<string, unknown>>(
    rows: readonly T[],
    predicate: (row: Record<string, unknown>) => boolean,
    what: string,
): T[] {
    const out: T[] = [];
    let dropped = 0;
    for (const r of rows) {
        if (predicate(r)) out.push(r);
        else dropped++;
    }
    if (dropped > 0) log.error('[cloud-scope] dropped out-of-scope rows returned by the engine', { what, dropped });
    return out;
}

/* ─── Scoped bulk count / delete (engine in-memory matcher limits) ───────── */

/**
 * Operators the engine's in-memory `Filter::matches` (used by count,
 * delete-by-query and update-by-query on EVERY connector) evaluates correctly.
 * It returns false for starts_with / ends_with / regex / exists / nin, and
 * `contains` is string-only — so a delete or count carrying one of those matches
 * nothing in production while an over-permissive test double happily matches N.
 */
const ENGINE_MEMORY_SAFE_OPS: ReadonlySet<EngineOp> = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);

/** True when `input` carries a clause the engine's count/delete matcher cannot evaluate. */
export function needsClientEvaluation(input: ScopeFilterInput): boolean {
    if ((input.tags ?? []).some((t) => t.trim() !== '')) return true; // server clause is `contains`
    return (input.extra ?? []).some((e) => !ENGINE_MEMORY_SAFE_OPS.has(e.op));
}

/**
 * pageRepeats — true when a page at offset > 0 starts with the same physical row (`id`) as the first page:
 * the connector ignored `offset` (the engine's SQLite connector runs `SELECT id, data FROM t LIMIT n` with no
 * ORDER BY / OFFSET, sqlite.rs:186-245). Offset walks stop on it instead of re-reading, and re-counting, the
 * same rows up to their cap; how many pages that took would otherwise depend on other workspaces' volume.
 */
export function pageRepeats(firstHead: unknown, pageHead: unknown): boolean {
    return firstHead !== undefined && firstHead !== null && pageHead === firstHead;
}

/** Rows a slow-path scan may inspect before it gives up (before any delete). */
export const SCOPED_SCAN_CAP = 50_000;
const SCAN_PAGE = 500;
const DELETE_CHUNK = 100;

export interface ScopedBulkClient {
    query<T = unknown>(tenantId: string, collection: string, options?: unknown, connection?: string): Promise<{ records: T[]; has_more?: boolean }>;
    count(tenantId: string, collection: string, filter?: object, connection?: string): Promise<number>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted: number }>;
}

/**
 * Slow path: page through the scoped candidate rows (sorted by lore_id for a
 * stable offset walk), keep those the CLIENT predicate accepts, and return their
 * logical ids. Throws before returning anything if the scan would exceed `cap` —
 * callers delete only after this resolves, so an oversized scan never does a
 * partial delete.
 */
async function collectMatchingIds(
    client: ScopedBulkClient,
    scope: DataplaneScope,
    collection: string,
    input: ScopeFilterInput,
    connection: string | undefined,
    cap: number,
): Promise<string[]> {
    const built = buildDataplaneScopeFilter(scope, input, 'crud', 0);
    // The scan's SERVER filter carries only clauses every connector evaluates the same
    // way (scope + the memory-safe ops); the unsafe ones are applied by the client
    // predicate above, so a connector that mishandles them cannot hide matching rows.
    const scanFilter = buildDataplaneScopeFilter(
        scope,
        { ...input, tags: [], extra: (input.extra ?? []).filter((e) => ENGINE_MEMORY_SAFE_OPS.has(e.op)) },
        'crud',
        0,
    ).server;
    const ids: string[] = [];
    let head: unknown;
    for (let offset = 0; ; offset += SCAN_PAGE) {
        if (offset >= cap) {
            throw new Error(`cloud scoped bulk operation scanned ${cap} rows without finishing; narrow the filter (clauses the engine cannot evaluate server-side need a client-side scan)`);
        }
        const limit = Math.min(SCAN_PAGE, cap - offset);
        const res = await client.query<Record<string, unknown>>(
            scope.dataplaneWorkspaceId,
            collection,
            { filter: scanFilter, sort: [{ field: 'lore_id', direction: 'asc' }], limit, offset },
            connection,
        );
        const records = res.records ?? [];
        if (offset === 0) head = records[0]?.['id'];
        else if (pageRepeats(head, records[0]?.['id'])) {
            throw new Error('cloud scoped bulk operation: the connector ignored offset paging (e.g. SQLite), so the scan cannot be completed; nothing was changed');
        }
        for (const r of records) {
            if (built.clientPredicate(r)) ids.push(r['lore_id'] as string);
        }
        if (records.length < limit) return ids;
    }
}

/** Count rows in scope matching `input`; client-evaluated when the engine matcher cannot do it. */
export async function scopedCount(
    client: ScopedBulkClient,
    scope: DataplaneScope,
    collection: string,
    input: ScopeFilterInput,
    connection?: string,
    cap: number = SCOPED_SCAN_CAP,
): Promise<number> {
    if (!needsClientEvaluation(input)) {
        const built = buildDataplaneScopeFilter(scope, input, 'crud', 0);
        return await client.count(scope.dataplaneWorkspaceId, collection, built.server as object, connection);
    }
    return (await collectMatchingIds(client, scope, collection, input, connection, cap)).length;
}

/**
 * Delete rows in scope matching `input`. Fast path: one delete-by-query. Slow
 * path (clauses the engine matcher cannot evaluate): resolve the matching logical
 * ids with a client-side scan, then delete them by `lore_id in [...]` — still
 * org + Lore-workspace scoped. Not atomic against concurrent writers (a row
 * changed between scan and delete is deleted by id regardless of the new value).
 */
export async function scopedDelete(
    client: ScopedBulkClient,
    scope: DataplaneScope,
    collection: string,
    input: ScopeFilterInput,
    connection?: string,
    cap: number = SCOPED_SCAN_CAP,
): Promise<number> {
    if (!needsClientEvaluation(input)) {
        const built = buildDataplaneScopeFilter(scope, input, 'crud', 0);
        const res = await client.deleteByQuery(scope.dataplaneWorkspaceId, collection, built.server as object, connection);
        return res?.deleted ?? 0;
    }
    const ids = await collectMatchingIds(client, scope, collection, input, connection, cap);
    let deleted = 0;
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const chunk = ids.slice(i, i + DELETE_CHUNK);
        const filter = buildDataplaneScopeFilter(scope, { loreId: chunk }, 'crud', 0).server as object;
        const res = await client.deleteByQuery(scope.dataplaneWorkspaceId, collection, filter, connection);
        deleted += res?.deleted ?? 0;
    }
    return deleted;
}

/**
 * normaliseVertexRecord — bring a traversed vertex's physical id to the bare row key.
 * The engine's Arango traverse returns the vertex document (`id` = `_key` = the `lw1_…`
 * row key), so this is a no-op today; it also accepts `<collection>/<key>` and `_key`-only
 * shapes so a connector change cannot make the id === rowKey scope guard drop every
 * vertex. It rewrites the id's form only; scope is decided by the row's own columns.
 */
export function normaliseVertexRecord(r: Record<string, unknown>, collection: string): Record<string, unknown> {
    if (!r || typeof r !== 'object') return r;
    const id = r['id'];
    if (typeof id === 'string') {
        const prefix = `${collection}/`;
        return id.startsWith(prefix) ? { ...r, id: id.slice(prefix.length) } : r;
    }
    const key = r['_key'];
    return typeof key === 'string' ? { ...r, id: key } : r;
}

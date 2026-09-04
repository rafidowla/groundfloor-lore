/**
 * collections.ts — Phase 2 item 4: SDK-aligned tabular CRUD over MCP.
 *
 * Tools (mirror `groundfloor-ts-sdk/src/client.ts` shape so the same
 * SDK can target Lore (local) or Dataplane (cloud) by changing only
 * the base URL):
 *
 *   - collection_create        — define a new collection (CollectionSchema)
 *   - collection_schema_get    — read a defined collection's schema
 *   - collection_insert        — insert a single row
 *   - collection_get           — fetch one row by primary key
 *   - collection_query         — filter + sort + limit + offset
 *   - collection_update        — bulk update by filter, returns {updated}
 *   - collection_delete        — bulk delete by filter, returns {deleted}
 *
 * **Vocab translation** at the boundary (SDK → ITableStorage):
 *   field_type   → type
 *   primary_key  → primary
 * SDK names are externally visible; Lore's internal `ColumnDecl` keeps
 * its own names. Same translator is reused by the REST routes.
 *
 * **Filter shape** mirrors `Filter` from `src/engines/collectionStorage.ts` — // D2-hygiene-2: stale plugins/storage.ts ref (moved v3.11.0)
 * conjunctive AND across keys, no OR/NOT, no nested. The SDK's
 * QueryOptions.filter is freeform `object`; we accept the same Filter
 * shape (eq/contains/startsWith/gt/gte/lt/lte/in) and document it.
 *
 * See project_phase2_investigation_2026_05_15 for the full design
 * notes and docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md for the multi-substrate
 * deferral rationale.
 */

import { z } from 'zod';
import { mcpToolError } from './mcpToolError.js';
import { log } from '../../logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type {
    ITableStorage,
    Row,
    TableSchema,
} from '../../contracts/tables.js';
import type { Filter, FilterNode, FindOptions } from '../../engines/collectionStorage.js';
import { CollectionValidationError, validateRowAgainstSchema } from '../../engines/collectionRowValidation.js';
import { assertMcpScope, type McpScopeMode } from './mcpScope.js';
import type { StorageBundle } from '../services.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { resolveTargetTableStorage, workspaceRequiredEnvelope as workspaceRequiredEnvelopeShared } from './workspaceResolve.js';
import { registerCollectionTransactionTool } from './collectionsTransaction.js';
import { registerCollectionJoinQueryTool } from './collectionsJoin.js';
import { registerCollectionByQueryTools } from './collectionsByQuery.js'; // X-allrows split (800-line cap)
import { filterNodeZ, optionalFilterNodeZ, filterInvalidMcpEnvelope } from './collectionsFilterSchema.js';
// F-COL5 split — the write-guard classifier lives in collectionsFilterScope.ts.
// Re-export so existing consumers keep their import path.
export { isAllFilter, classifyFilterScope, type FilterScope } from './collectionsFilterScope.js';
import { assertValidFilter } from './collectionsFilterScope.js';
// 1.M6 split (file-size cap) — query/count handlers live in collectionsQuery.ts.
// Re-export so existing consumers keep their import path.
export { handleQuery, handleCount, type QueryResultShape, type CountResultShape } from './collectionsQuery.js';
import { handleQuery, handleCount } from './collectionsQuery.js';

/* ------------------------------------------------------------------ */
/*  SDK ↔ Lore translation                                             */
/* ------------------------------------------------------------------ */
// F-COL6 split (file-size cap) — the SDK↔Lore schema vocabulary boundary
// and its zod mirrors live in collectionsSchemaTranslate.ts. Re-export so
// existing consumers keep their import path.
export {
    sdkToInternalSchema,
    internalToSdkSchema,
    type SdkFieldSchema,
    type SdkCollectionSchema,
} from './collectionsSchemaTranslate.js';
import {
    sdkToInternalSchema,
    internalToSdkSchema,
    sdkCollectionSchemaZ,
} from './collectionsSchemaTranslate.js';
import type { SdkCollectionSchema } from './collectionsSchemaTranslate.js';

/**
 * Filter shape exposed to callers. Matches `Filter` from table storage.
 * Each key is conjunction-only; multiple keys → AND.
 */
const filterZ = optionalFilterNodeZ;

const findOptionsZ = z.object({
    limit: z.number().int().positive().optional(),
    orderBy: z.string().optional(),
    orderDir: z.enum(['asc', 'desc']).optional(),
}).optional();

/* ------------------------------------------------------------------ */
/*  Handler bodies (shared between MCP tools and REST routes)          */
/* ------------------------------------------------------------------ */

export interface CollectionsDeps {
    /**
     * Boot/active-workspace table storage. Used as the fallback when no
     * graphRegistry/store is wired (embedded/cloud mode, tests) so behavior
     * is unchanged from before per-workspace routing existed.
     */
    tableStorage: ITableStorage;
    /**
     * Local-mode per-workspace routing inputs (all OPTIONAL — when absent the
     * resolver returns the boot store and behavior is unchanged):
     *   - store: the boot StorageBundle (carries loreGraph for the active ws)
     *   - graphRegistry: opens/serves each workspace's own LocalGraph
     *   - activeWorkspace: the daemon's currently-active workspace name
     */
    store?: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    activeWorkspace?: string;
}

/* handleQuery / handleCount / QueryResultShape / CountResultShape moved to
 * collectionsQuery.ts (1.M6 file-size split) — re-exported at the top. */

export async function handleCreateCollection(
    deps: CollectionsDeps,
    schema: SdkCollectionSchema,
): Promise<SdkCollectionSchema> {
    await deps.tableStorage.createTable(sdkToInternalSchema(schema));
    return schema;
}

/**
 * getIntrospectableSchema — same private-map side channel as
 * `handleSchemaGet` (ITableStorage exposes no schema-get method), reused
 * by the row-validation call sites below. Returns `undefined` when the
 * adapter isn't introspectable — those callers skip pre-validation and
 * behave exactly as before (fail open, never break an adapter that
 * doesn't expose its schemas).
 *
 * Exported (not just module-private) so `collectionsTransaction.ts`'s
 * `handleTransaction` can resolve the same schema for insert/update/upsert
 * ops before calling `runTransaction` — QA finding B2 (2026-09-03):
 * collection_transaction / POST /v1/transaction bypassed
 * collectionRowValidation.ts entirely, silently coercing rows that every
 * other write path (insert/update/bulk_insert/update_by_query) rejects.
 */
export function getIntrospectableSchema(deps: CollectionsDeps, name: string): TableSchema | undefined {
    const introspectable = deps.tableStorage as ITableStorage & {
        schemas?: Map<string, TableSchema>;
    };
    return introspectable.schemas?.get(name);
}

export async function handleSchemaGet(
    deps: CollectionsDeps,
    name: string,
): Promise<SdkCollectionSchema | null> {
    // ITableStorage exposes no schema-get method; SqliteTableStorage caches
    // schemas on a private map. Read it via that side channel when present;
    // return null when the adapter isn't introspectable (treat as "not yet
    // introspectable", not "not found"). Future: a getSchema(name) method.
    const internal = getIntrospectableSchema(deps, name);
    return internal ? internalToSdkSchema(internal) : null;
}

// B3 split (round E, file-size cap) — collection_schema_list / GET /v1/schema's
// paginated handler lives in collectionsSchemaList.ts (mirrors 1.M6 above).
export {
    handleSchemaListPaged, DEFAULT_SCHEMA_LIST_LIMIT, MAX_SCHEMA_LIST_LIMIT,
    type SdkCollectionSchemaSummary, type SchemaListPageOptions, type SchemaListPageResult,
} from './collectionsSchemaList.js';
import {
    handleSchemaListPaged, DEFAULT_SCHEMA_LIST_LIMIT, MAX_SCHEMA_LIST_LIMIT,
    type SdkCollectionSchemaSummary,
} from './collectionsSchemaList.js';

/**
 * Finding #7 (2026-09-03) — there was no way to enumerate collections
 * short of already knowing a name. `rowCount` is surfaced when the
 * backend reports one; adapters that can't produce it cheaply leave it
 * undefined. Left exactly as it was pre-B3 (unpaginated, always
 * counted) for existing direct callers/tests — the tool/route now call
 * `handleSchemaListPaged` (collectionsSchemaList.ts) instead.
 */
export async function handleSchemaList(
    deps: CollectionsDeps,
): Promise<SdkCollectionSchemaSummary[]> {
    const summaries = await deps.tableStorage.listTables();
    return summaries.map((s): SdkCollectionSchemaSummary => ({
        ...internalToSdkSchema(s),
        rowCount: s.rowCount,
    }));
}

/**
 * F6 (2026-09-03 audit) — validate the row against its declared schema
 * BEFORE calling into ITableStorage.insert, so an unknown column, a
 * wrong-typed value, or an empty row is rejected as a clean 400/tool
 * error (via CollectionValidationError) instead of surfacing as a 500
 * from deep inside the SQLite engine. See collectionRowValidation.ts.
 */
export async function handleInsert(
    deps: CollectionsDeps,
    collection: string,
    record: Row,
): Promise<Row> {
    const schema = getIntrospectableSchema(deps, collection);
    if (schema) validateRowAgainstSchema(schema, record, 'insert');
    await deps.tableStorage.insert(collection, record);
    return record;
}

export async function handleGet(
    deps: CollectionsDeps,
    collection: string,
    id: unknown,
): Promise<Row | null> {
    return await deps.tableStorage.getByKey(collection, id);
}


/**
 * F-COL2: refuse an unscoped destructive op unless the caller explicitly
 * opts in with `all: true`. An absent/empty/all filter would otherwise
 * update or delete every row. Throws when the guard trips.
 */
function assertScopedOrAllOptIn(op: string, filter: FilterNode | undefined, all: boolean | undefined): void {
    const scope = assertValidFilter(op, filter); // F-COL5
    if (all !== true && scope === 'ALL') {
        throw new Error(`${op} refuses an empty/all filter — pass all:true to confirm an unscoped ${op}, or use collection_truncate.`);
    }
}

export async function handleUpdate(
    deps: CollectionsDeps,
    collection: string,
    filter: FilterNode,
    patch: Record<string, unknown>,
    all?: boolean, // F-COL2
): Promise<{ updated: number }> {
    assertScopedOrAllOptIn('collection_update', filter, all); // F-COL2
    // F6 — validate the supplied patch fields against the schema (partial:
    // an update patch need not be non-empty or carry every required column).
    const schema = getIntrospectableSchema(deps, collection);
    if (schema) validateRowAgainstSchema(schema, patch, 'update');
    const updated = await deps.tableStorage.update(collection, filter, patch, { all }); // X-allrows
    return { updated };
}

export async function handleDelete(
    deps: CollectionsDeps,
    collection: string,
    filter: FilterNode,
    all?: boolean, // F-COL2
): Promise<{ deleted: number }> {
    assertScopedOrAllOptIn('collection_delete', filter, all); // F-COL2
    const deleted = await deps.tableStorage.delete(collection, filter, { all }); // X-allrows
    return { deleted };
}

/* ── Phase 2.5 bulk variants ───────────────────────────────────── */

export interface BulkInsertResultShape {
    inserted: number;
    ids: string[];
    total_requested: number;
}


export async function handleBulkInsert(
    deps: CollectionsDeps,
    collection: string,
    records: Row[],
): Promise<BulkInsertResultShape> {
    if (!records || records.length === 0) {
        throw new Error('records must be a non-empty array');
    }
    // F-T09: cap row count (1000, matching bulkWrite.ITEM_CAP) AND total bytes
    // (16 MiB) — refuse oversize before insert to bound memory/wall-time DoS.
    if (records.length > 1000) throw new Error(`at most 1000 records per call (got ${records.length})`);
    if (JSON.stringify(records).length > 16 * 1024 * 1024) throw new Error('records payload exceeds 16 MiB cap');
    // F6 — validate every row against the schema BEFORE inserting any of
    // them, naming the failing row's index so a bulk 400 is actionable.
    const schema = getIntrospectableSchema(deps, collection);
    if (schema) {
        records.forEach((row, index) => validateRowAgainstSchema(schema, row, 'insert', index));
    }
    await deps.tableStorage.insertBatch(collection, records);
    // Best-effort id capture: caller's records may carry an `id` field
    // (the SDK's CRM convention) — mirror that. Records without an
    // id contribute an empty string to keep the array length stable.
    const ids = records.map(r => String(r['id'] ?? ''));
    return {
        inserted: records.length,
        ids,
        total_requested: records.length,
    };
}


export interface UpdateByQueryResultShape {
    updated: number;
    collection: string;
}

export async function handleUpdateByQuery(
    deps: CollectionsDeps,
    collection: string,
    filter: FilterNode,
    fields: Record<string, unknown>,
    all?: boolean, // X-allrows — was hardcoded `undefined` (no opt-in existed)
): Promise<UpdateByQueryResultShape> {
    assertScopedOrAllOptIn('collection_update_by_query', filter, all); // D2-data-4, X-allrows
    // F6 — same partial-patch validation as handleUpdate.
    const schema = getIntrospectableSchema(deps, collection);
    if (schema) validateRowAgainstSchema(schema, fields, 'update');
    const updated = await deps.tableStorage.update(collection, filter, fields, { all }); // X-allrows
    return { updated, collection };
}

export interface DeleteByQueryResultShape {
    deleted: number;
    collection: string;
}

export async function handleDeleteByQuery(
    deps: CollectionsDeps,
    collection: string,
    filter: FilterNode,
    all?: boolean, // X-allrows — was unconditionally refused; no opt-in existed
): Promise<DeleteByQueryResultShape> {
    const scope = assertValidFilter('delete-by-query', filter); // F-COL5
    if (all !== true && scope === 'ALL') {
        throw new Error('delete-by-query refuses an empty/all filter — pass all:true to confirm, or use truncate to wipe a collection.');
    }
    const deleted = await deps.tableStorage.delete(collection, filter, { all }); // X-allrows
    return { deleted, collection };
}

export interface TruncateResultShape {
    truncated: boolean;
    deleted: number;
}

export async function handleTruncate(
    deps: CollectionsDeps,
    collection: string,
): Promise<TruncateResultShape> {
    const deleted = await deps.tableStorage.truncate(collection);
    return { truncated: true, deleted };
}

/* ------------------------------------------------------------------ */
/*  MCP tool registration                                              */
/* ------------------------------------------------------------------ */

function ok(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * F6 (2026-09-03 audit) — MCP envelope for a rejected row. Deliberately
 * bypasses `mcpToolError`/`redactError`: redactError hashes every quoted
 * string in a message (`'unknown column 'email'…'` → `'id#40ce4379'…`),
 * which would destroy the exact field/table names this error exists to
 * surface. table/field/row_index are read off the structured
 * CollectionValidationError properties, not parsed out of prose, so
 * nothing sensitive-looking needs to pass through the hash in the first
 * place. Mirrors the existing `{error: '<code>', ...}` shape used by
 * `workspaceRequiredEnvelope` above.
 */
function collectionValidationEnvelope(
    e: CollectionValidationError,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                error: 'invalid_row',
                table: e.table,
                ...(e.field === undefined ? {} : { field: e.field }),
                ...(e.rowIndex === undefined ? {} : { row_index: e.rowIndex }),
                message: e.message,
            }, null, 2),
        }],
        isError: true,
    };
}

// X-allrows split — shared with collectionsByQuery.ts's collection_update_by_query/
// collection_delete_by_query registrations, which moved out for the 800-line cap.
export function filterOrRowOrGeneric(toolName: string, e: unknown) { // QA round-3 — shared catch for the 4 write tools below
    if (e instanceof z.ZodError) return filterInvalidMcpEnvelope(e);
    if (e instanceof CollectionValidationError) return collectionValidationEnvelope(e); // F6
    return mcpToolError(toolName, e, log);
}

/**
 * Sprint L1e — workspace_required guard. Mirrors REST 400 shape.
 * Today's collections handlers operate on the active workspace's
 * ITableStorage; the schema requires workspace for forward-compat
 * with per-workspace table routing.
 */
function workspaceRequiredEnvelope(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name> as a tool argument' }, null, 2) }],
        isError: true,
    };
}

function isMissingWorkspace(args: { workspace?: unknown }): boolean {
    const ws = args.workspace;
    return !ws || typeof ws !== 'string' || ws.length === 0;
}

/**
 * SP-01 — combined workspace gate for collection_* handlers. Runs the
 * Sprint L1e workspace_required check, then the bound-principal scope
 * check. Returns the error envelope to return as-is, or null when the
 * call is permitted. `read` for query/get/count/schema_get, `write`
 * for all mutating CRUD.
 */
function gateWorkspace(
    args: { workspace?: unknown },
    mode: McpScopeMode,
): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
    if (isMissingWorkspace(args)) return workspaceRequiredEnvelope();
    return assertMcpScope(args.workspace as string, mode);
}

/**
 * workspaceNotFoundEnvelope — MCP error when a workspace argument names a
 * workspace the registry doesn't know. Mirrors the REST 404 shape.
 */
function workspaceNotFoundEnvelope(
    requested: string,
    known: string[],
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'workspace_not_found', requested, known }, null, 2),
        }],
        isError: true,
    };
}

/**
 * SP-02 (2026-06-19, Postgres-model isolation) — per-call workspace routing.
 * Resolve the REQUESTED workspace's own ITableStorage and return per-call
 * CollectionsDeps pointing at it, so the shared handler reads/writes that
 * workspace's database — not the boot/active one. Fallback: when routing inputs
 * are absent (embedded/cloud/tests) the resolver returns the boot store and we
 * hand back `deps` unchanged. Returns per-call deps on success, or an MCP error
 * envelope (workspace_required / workspace_not_found) to return as-is.
 */
async function resolveDepsForWorkspace(
    deps: CollectionsDeps,
    requested: string,
):
    Promise<
        | { ok: true; deps: CollectionsDeps }
        | { ok: false; envelope: { content: Array<{ type: 'text'; text: string }>; isError: true } }
    > {
    // No routing inputs wired → boot fallback, behavior unchanged.
    if (!deps.store || !deps.graphRegistry) {
        return { ok: true, deps };
    }
    const res = await resolveTargetTableStorage(
        deps.store,
        deps.graphRegistry,
        deps.activeWorkspace ?? requested,
        requested,
    );
    if (!res.ok) {
        if ('missing' in res) {
            return { ok: false, envelope: workspaceRequiredEnvelopeShared() };
        }
        return { ok: false, envelope: workspaceNotFoundEnvelope(res.requested, res.known) };
    }
    return { ok: true, deps: { ...deps, tableStorage: res.tableStorage } };
}

const workspaceFieldZ = z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).');

export function registerCollectionTools(mcpServer: McpServer, deps: CollectionsDeps): void {
    registerCollectionTransactionTool(mcpServer, deps, {
        gateWorkspace,
        resolveDeps: resolveDepsForWorkspace,
    });
    registerCollectionJoinQueryTool(mcpServer, deps, {
        gateWorkspace,
        resolveDeps: resolveDepsForWorkspace,
    });
    registerCollectionByQueryTools(mcpServer, deps, { // X-allrows split (800-line cap)
        gateWorkspace,
        resolveDeps: resolveDepsForWorkspace,
    });
    mcpServer.tool(
        'collection_create',
        'Create a new collection (table). Mirrors GroundfloorClient.createCollection — uses SDK field names (field_type, primary_key). Local mode backs each collection with a SQLite table; cloud mode is not yet implemented.',
        { ...sdkCollectionSchemaZ.shape, workspace: workspaceFieldZ },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const schema = sdkCollectionSchemaZ.parse(args);
                const created = await handleCreateCollection(routed.deps, schema);
                return ok(created);
            } catch (e) { return mcpToolError('collection_create', e, log); }
        },
    );

    mcpServer.tool(
        'collection_schema_get',
        'Read a defined collection\'s schema. Returns null if the adapter doesn\'t expose introspection (SqliteTableStorage caches schemas in-memory only — schema is visible after a same-process createTable, not across daemon restarts).',
        { name: z.string(), workspace: workspaceFieldZ },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'read');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const schema = await handleSchemaGet(routed.deps, args.name as string);
                return ok(schema);
            } catch (e) { return mcpToolError('collection_schema_get', e, log); }
        },
    );

    mcpServer.tool(
        'collection_schema_list',
        `List every collection (table) declared in this workspace's adapter. Complements collection_schema_get — use this to discover names first. Returns {schemas: []} when nothing has been created yet. Paginated (finding B3): defaults to the first ${DEFAULT_SCHEMA_LIST_LIMIT} entries (max ${MAX_SCHEMA_LIST_LIMIT} per call) with rowCount omitted; pass withCounts:true to include a per-collection row count, and follow the response's nextCursor (when present) to page through the rest.`,
        {
            workspace: workspaceFieldZ,
            limit: z.number().int().positive().max(MAX_SCHEMA_LIST_LIMIT).optional()
                .describe(`Max entries to return. Default ${DEFAULT_SCHEMA_LIST_LIMIT}, max ${MAX_SCHEMA_LIST_LIMIT}.`),
            offset: z.number().int().nonnegative().optional()
                .describe('Zero-based offset into the collection list. Ignored when `cursor` is given; unstable under concurrent creates/drops.'),
            cursor: z.string().optional()
                .describe('Opaque cursor from a prior response\'s nextCursor. Takes precedence over `offset`; stable under concurrent creates/drops.'),
            withCounts: z.boolean().optional()
                .describe('Compute a rowCount per returned collection (one COUNT(*) each). Default false.'),
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'read');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleSchemaListPaged(routed.deps, {
                    limit: args.limit as number | undefined,
                    offset: args.offset as number | undefined,
                    cursor: args.cursor as string | undefined,
                    withCounts: args.withCounts as boolean | undefined,
                });
                return ok(result);
            } catch (e) { return mcpToolError('collection_schema_list', e, log); }
        },
    );

    mcpServer.tool(
        'collection_insert',
        'Insert a single row into a collection. Mirrors GroundfloorClient.insert. Throws on primary-key collision.',
        {
            collection: z.string(),
            record: z.record(z.string(), z.unknown()),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const inserted = await handleInsert(
                    routed.deps,
                    args.collection as string,
                    args.record as Row,
                );
                return ok(inserted);
            } catch (e) {
                // F6 — keep the field/table names readable; don't run them
                // through mcpToolError's redactError hashing.
                if (e instanceof CollectionValidationError) return collectionValidationEnvelope(e);
                return mcpToolError('collection_insert', e, log);
            }
        },
    );

    mcpServer.tool(
        'collection_get',
        'Fetch one row by primary key. Mirrors GroundfloorClient.get. Returns null when the row is absent.',
        {
            collection: z.string(),
            id: z.union([z.string(), z.number(), z.boolean()]),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'read');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const row = await handleGet(routed.deps, args.collection as string, args.id);
                return ok(row);
            } catch (e) { return mcpToolError('collection_get', e, log); }
        },
    );

    mcpServer.tool(
        'collection_query',
        'Query rows with filter + sort + limit. Mirrors GroundfloorClient.query. Returns {records, total_count, has_more}. has_more is true when the caller requested `limit` and got exactly that many rows back.',
        {
            collection: z.string(),
            filter: filterZ,
            opts: findOptionsZ,
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'read');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleQuery(
                    routed.deps,
                    args.collection as string,
                    args.filter as FilterNode | undefined,
                    args.opts as FindOptions | undefined,
                );
                return ok(result);
            } catch (e) { return mcpToolError('collection_query', e, log); }
        },
    );

    mcpServer.tool(
        'collection_update',
        'Bulk update rows matching the filter. Mirrors GroundfloorClient.update. Returns {updated: count}.',
        {
            collection: z.string(),
            filter: filterNodeZ,
            updates: z.record(z.string(), z.unknown()),
            all: z.boolean().optional().describe('F-COL2: required true to confirm an unscoped update (empty/all filter).'),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleUpdate(
                    routed.deps,
                    args.collection as string,
                    filterNodeZ.parse(args.filter), // QA round-3
                    args.updates as Record<string, unknown>,
                    args.all as boolean | undefined, // F-COL2
                );
                return ok(result);
            } catch (e) { return filterOrRowOrGeneric('collection_update', e); }
        },
    );

    mcpServer.tool(
        'collection_delete',
        'Bulk delete rows matching the filter. Mirrors GroundfloorClient.delete. Returns {deleted: count}.',
        {
            collection: z.string(),
            filter: filterNodeZ,
            all: z.boolean().optional().describe('F-COL2: required true to confirm an unscoped delete (empty/all filter).'),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleDelete(
                    routed.deps,
                    args.collection as string,
                    filterNodeZ.parse(args.filter), // QA round-3
                    args.all as boolean | undefined, // F-COL2
                );
                return ok(result);
            } catch (e) { return filterOrRowOrGeneric('collection_delete', e); }
        },
    );

    /* ─── Phase 2.5 bulk variants ────────────────────────────── */

    mcpServer.tool(
        'collection_bulk_insert',
        'Insert many rows in one call. Mirrors GroundfloorClient.bulkInsert. Returns {inserted, ids, total_requested}. Throws if records is empty.',
        {
            collection: z.string(),
            records: z.array(z.record(z.string(), z.unknown())),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleBulkInsert(
                    routed.deps,
                    args.collection as string,
                    args.records as Row[],
                );
                return ok(result);
            } catch (e) {
                if (e instanceof CollectionValidationError) return collectionValidationEnvelope(e); // F6
                return mcpToolError('collection_bulk_insert', e, log);
            }
        },
    );

    mcpServer.tool(
        'collection_count',
        'Count rows in a collection (optionally filtered). Mirrors GroundfloorClient.count. Returns {count, collection}.',
        {
            collection: z.string(),
            filter: filterZ,
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'read');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleCount(
                    routed.deps,
                    args.collection as string,
                    args.filter as FilterNode | undefined,
                );
                return ok(result);
            } catch (e) { return mcpToolError('collection_count', e, log); }
        },
    );

    mcpServer.tool(
        'collection_truncate',
        'Remove ALL rows from a collection while preserving the schema. Mirrors GroundfloorClient.truncate. Returns {truncated: true, deleted: count}. The designated endpoint for intentional full wipes.',
        {
            collection: z.string(),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleTruncate(routed.deps, args.collection as string);
                return ok(result);
            } catch (e) { return mcpToolError('collection_truncate', e, log); }
        },
    );
}

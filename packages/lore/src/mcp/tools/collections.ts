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
    ColumnDecl,
    ColumnType,
    ITableStorage,
    Row,
    TableSchema,
} from '../../contracts/tables.js';
import type { Filter, FilterNode, FindOptions } from '../../engines/collectionStorage.js';
import { isFilterAnd, isFilterNot, isFilterOr } from '../../engines/collectionStorage.js';
import { assertMcpScope, type McpScopeMode } from './mcpScope.js';
import type { StorageBundle } from '../services.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { resolveTargetTableStorage, workspaceRequiredEnvelope as workspaceRequiredEnvelopeShared } from './workspaceResolve.js';
import { registerCollectionTransactionTool } from './collectionsTransaction.js';
import { registerCollectionJoinQueryTool } from './collectionsJoin.js';
import { filterNodeZ, optionalFilterNodeZ } from './collectionsFilterSchema.js';
// 1.M6 split (file-size cap) — query/count handlers live in collectionsQuery.ts.
// Re-export so existing consumers keep their import path.
export { handleQuery, handleCount, type QueryResultShape, type CountResultShape } from './collectionsQuery.js';
import { handleQuery, handleCount } from './collectionsQuery.js';

/* ------------------------------------------------------------------ */
/*  SDK ↔ Lore translation                                             */
/* ------------------------------------------------------------------ */

/**
 * SDK FieldSchema (from v3/groundfloor-ts-sdk/src/types.ts) — exposed
 * directly in the MCP tool input schemas so external callers see the
 * SDK names, not Lore's internal names.
 */
export interface SdkFieldSchema {
    name: string;
    field_type: ColumnType;
    required?: boolean;
    indexed?: boolean;
    unique?: boolean;
    primary_key?: boolean;
}

export interface SdkCollectionSchema {
    name: string;
    fields: SdkFieldSchema[];
    description?: string;
    metadata?: Record<string, string>;
}

export function sdkToInternalSchema(schema: SdkCollectionSchema): TableSchema {
    return {
        name: schema.name,
        description: schema.description,
        columns: schema.fields.map((f): ColumnDecl => ({
            name: f.name,
            type: f.field_type,
            primary: f.primary_key,
            required: f.required,
            unique: f.unique,
            indexed: f.indexed,
        })),
    };
}

export function internalToSdkSchema(schema: TableSchema): SdkCollectionSchema {
    return {
        name: schema.name,
        description: schema.description,
        fields: schema.columns.map((c): SdkFieldSchema => ({
            name: c.name,
            field_type: c.type,
            required: c.required,
            indexed: c.indexed,
            unique: c.unique,
            primary_key: c.primary,
        })),
    };
}

/* ------------------------------------------------------------------ */
/*  Zod schemas (shared between MCP tools and REST routes)             */
/* ------------------------------------------------------------------ */

const COLUMN_TYPE_ENUM = z.enum([
    'string', 'integer', 'float', 'boolean', 'date', 'datetime', 'json',
]);

const sdkFieldSchemaZ = z.object({
    name: z.string(),
    field_type: COLUMN_TYPE_ENUM,
    required: z.boolean().optional(),
    indexed: z.boolean().optional(),
    unique: z.boolean().optional(),
    primary_key: z.boolean().optional(),
});

const sdkCollectionSchemaZ = z.object({
    name: z.string(),
    fields: z.array(sdkFieldSchemaZ),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
});

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

export async function handleSchemaGet(
    deps: CollectionsDeps,
    name: string,
): Promise<SdkCollectionSchema | null> {
    // ITableStorage exposes no schema-get method; KuzuTableStorage caches
    // schemas on a private map. Read it via that side channel when present;
    // return null when the adapter isn't introspectable (treat as "not yet
    // introspectable", not "not found"). Future: a getSchema(name) method.
    const introspectable = deps.tableStorage as ITableStorage & {
        schemas?: Map<string, TableSchema>;
    };
    const internal = introspectable.schemas?.get(name);
    return internal ? internalToSdkSchema(internal) : null;
}

export async function handleInsert(
    deps: CollectionsDeps,
    collection: string,
    record: Row,
): Promise<Row> {
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
    if (all !== true && isAllFilter(filter)) {
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
    const updated = await deps.tableStorage.update(collection, filter, patch);
    return { updated };
}

export async function handleDelete(
    deps: CollectionsDeps,
    collection: string,
    filter: FilterNode,
    all?: boolean, // F-COL2
): Promise<{ deleted: number }> {
    assertScopedOrAllOptIn('collection_delete', filter, all); // F-COL2
    const deleted = await deps.tableStorage.delete(collection, filter);
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
): Promise<UpdateByQueryResultShape> {
    assertScopedOrAllOptIn('collection_update_by_query', filter, undefined); // D2-data-4
    const updated = await deps.tableStorage.update(collection, filter, fields);
    return { updated, collection };
}

export interface DeleteByQueryResultShape {
    deleted: number;
    collection: string;
}

/**
 * F-COL1: a contains/startsWith/endsWith entry whose value is empty or
 * whitespace-only is NOT a real predicate — it compiles to LIKE '%%'
 * (matches every row), so it must NOT count as scoping or it sneaks past
 * isAllFilter and silently wipes the collection.
 */
function isScopingTextGroup(g: Record<string, string> | undefined): boolean {
    return !!g && Object.values(g).some(v => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Returns true if the filter is "all" — every clause missing, empty, or
 * (for text predicates) an empty/whitespace value matching everything
 * (F-COL1). Rejected before destructive ops; use `truncate` to wipe.
 *
 * Nested and/or/not (WP2) must recurse rather than being treated as
 * automatically scoped:
 * - AND is unscoped only if every branch is unscoped — one real predicate
 *   narrows the whole AND, so `every` is correct.
 * - OR is unscoped if any branch is unscoped — one unscoped branch means
 *   the union already covers every row, so `some` is correct.
 * - NOT never counts as unscoped: negating an unscoped filter (matches
 *   everything) produces a filter matching NOTHING, not everything, so
 *   `not` is never the dangerous case and stays `false` unconditionally.
 */
export function isAllFilter(filter: FilterNode | undefined): boolean {
    if (!filter) return true;
    if (isFilterNot(filter)) return false;
    if (isFilterAnd(filter)) return filter.and.every(isAllFilter);
    if (isFilterOr(filter)) return filter.or.some(isAllFilter);
    const f = filter as Filter & { endsWith?: Record<string, string> };
    // F-COL1: text predicates only scope when at least one value is non-empty.
    if (isScopingTextGroup(filter.contains) || isScopingTextGroup(filter.startsWith) || isScopingTextGroup(f.endsWith)) return false;
    const groups = [filter.eq, filter.gt, filter.gte, filter.lt, filter.lte, filter.in];
    return groups.every(g => !g || Object.keys(g).length === 0);
}

export async function handleDeleteByQuery(
    deps: CollectionsDeps,
    collection: string,
    filter: FilterNode,
): Promise<DeleteByQueryResultShape> {
    if (isAllFilter(filter)) {
        throw new Error(
            'delete-by-query refuses an empty/all filter — use truncate to wipe a collection.',
        );
    }
    const deleted = await deps.tableStorage.delete(collection, filter);
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
    mcpServer.tool(
        'collection_create',
        'Create a new collection (table). Mirrors GroundfloorClient.createCollection — uses SDK field names (field_type, primary_key). Local mode backs each collection with a Kùzu node table; cloud mode is not yet implemented.',
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
        'Read a defined collection\'s schema. Returns null if the adapter doesn\'t expose introspection (KuzuTableStorage caches schemas in-memory only — schema is visible after a same-process createTable, not across daemon restarts).',
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
            } catch (e) { return mcpToolError('collection_insert', e, log); }
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
                    args.filter as FilterNode,
                    args.updates as Record<string, unknown>,
                    args.all as boolean | undefined, // F-COL2
                );
                return ok(result);
            } catch (e) { return mcpToolError('collection_update', e, log); }
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
                    args.filter as FilterNode,
                    args.all as boolean | undefined, // F-COL2
                );
                return ok(result);
            } catch (e) { return mcpToolError('collection_delete', e, log); }
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
            } catch (e) { return mcpToolError('collection_bulk_insert', e, log); }
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
        'collection_update_by_query',
        'Update all records matching a filter. Mirrors GroundfloorClient.updateByQuery. Distinct from collection_update only by SDK-shaped response: {updated, collection}.',
        {
            collection: z.string(),
            filter: filterNodeZ,
            fields: z.record(z.string(), z.unknown()),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleUpdateByQuery(
                    routed.deps,
                    args.collection as string,
                    args.filter as FilterNode,
                    args.fields as Record<string, unknown>,
                );
                return ok(result);
            } catch (e) { return mcpToolError('collection_update_by_query', e, log); }
        },
    );

    mcpServer.tool(
        'collection_delete_by_query',
        'Delete all records matching a filter. Mirrors GroundfloorClient.deleteByQuery. Refuses empty/all filter (footgun guard) — use collection_truncate for full wipes. Returns {deleted, collection}.',
        {
            collection: z.string(),
            filter: filterNodeZ,
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const denied = gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await resolveDepsForWorkspace(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleDeleteByQuery(
                    routed.deps,
                    args.collection as string,
                    args.filter as FilterNode,
                );
                return ok(result);
            } catch (e) { return mcpToolError('collection_delete_by_query', e, log); }
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

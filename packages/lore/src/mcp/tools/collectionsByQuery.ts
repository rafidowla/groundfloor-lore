/**
 * collectionsByQuery.ts — MCP registration for collection_update_by_query /
 * collection_delete_by_query, plus their handler bodies.
 *
 * X-allrows split (2026-09-03, 800-line cap) — these two `mcpServer.tool(...)`
 * registrations moved out of collections.ts to make room for the `all: true`
 * opt-in both tools gained. Mirrors the existing collectionsTransaction.ts/
 * collectionsJoin.ts split pattern: a small `RegistrationHelpers` interface
 * for the shared gateWorkspace/resolveDeps callbacks, passed in by
 * `registerCollectionTools`.
 *
 * ITEM collections-cycle (2026-09) — `handleUpdateByQuery`, `handleDeleteByQuery`
 * and `filterOrRowOrGeneric` moved INTO this file from collections.ts. They
 * used to be defined there and imported here as VALUES, while this file's
 * `registerCollectionByQueryTools` is imported back into collections.ts as a
 * VALUE — a genuine two-way runtime `require` cycle (unlike the harmless
 * `import type`-only cycles collectionsJoin.ts/collectionsTransaction.ts
 * still have with collections.ts). Now the edge runs one way: collections.ts
 * imports FROM this file (as it already did for `registerCollectionByQueryTools`)
 * and re-exports these three names so existing importers (HTTP routes,
 * tests) keep their `tools/collections.js` import path unchanged.
 * `CollectionsDeps`/`getIntrospectableSchema` and `assertScopedOrAllOptIn`
 * moved to collectionsDeps.ts/collectionsFilterScope.ts respectively — both
 * zero-dependency modules this file and collections.ts import one-way.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { filterNodeZ, filterInvalidMcpEnvelope } from './collectionsFilterSchema.js';
import type { McpScopeMode } from './mcpScope.js';
import type { FilterNode } from '../../engines/collectionStorage.js';
import { CollectionValidationError, validateRowAgainstSchema } from '../../engines/collectionRowValidation.js';
import { assertScopedOrAllOptIn, assertValidFilter } from './collectionsFilterScope.js';
import { type CollectionsDeps, getIntrospectableSchema } from './collectionsDeps.js';
import { mcpToolError } from './mcpToolError.js';
import { log } from '../../logger.js';

type McpEnvelope = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: true;
};

function ok(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
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
    // F6 — same partial-patch validation as collections.ts's handleUpdate.
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

/**
 * F6 (2026-09-03 audit) — MCP envelope for a rejected row. Deliberately
 * bypasses `mcpToolError`/`redactError`: redactError hashes every quoted
 * string in a message (`'unknown column 'email'…'` → `'id#40ce4379'…`),
 * which would destroy the exact field/table names this error exists to
 * surface. table/field/row_index are read off the structured
 * CollectionValidationError properties, not parsed out of prose, so
 * nothing sensitive-looking needs to pass through the hash in the first
 * place.
 *
 * Exported (not just module-private) — collections.ts's collection_insert/
 * collection_bulk_insert tool registrations call it directly (the exact
 * same CollectionValidationError branch `filterOrRowOrGeneric` below uses,
 * inlined there rather than routed through this file's shared catch because
 * neither of those two call sites can throw a ZodError inline).
 */
export function collectionValidationEnvelope(
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

// X-allrows split — shared with collections.ts's collection_update/
// collection_delete tool registrations.
export function filterOrRowOrGeneric(toolName: string, e: unknown) { // QA round-3 — shared catch for the 4 write tools
    if (e instanceof z.ZodError) return filterInvalidMcpEnvelope(e);
    if (e instanceof CollectionValidationError) return collectionValidationEnvelope(e); // F6
    return mcpToolError(toolName, e, log);
}

export interface CollectionByQueryRegistrationHelpers {
    gateWorkspace(args: { workspace?: unknown }, mode: McpScopeMode): McpEnvelope | null;
    resolveDeps(
        deps: CollectionsDeps,
        requested: string,
    ): Promise<{ ok: true; deps: CollectionsDeps } | { ok: false; envelope: McpEnvelope & { isError: true } }>;
}

export function registerCollectionByQueryTools(
    mcpServer: McpServer,
    deps: CollectionsDeps,
    helpers: CollectionByQueryRegistrationHelpers,
): void {
    mcpServer.tool(
        'collection_update_by_query',
        'Update all records matching a filter. Mirrors GroundfloorClient.updateByQuery. Distinct from collection_update only by SDK-shaped response: {updated, collection}.',
        {
            collection: z.string(),
            filter: filterNodeZ,
            fields: z.record(z.string(), z.unknown()),
            all: z.boolean().optional().describe('X-allrows: required true to confirm an unscoped update (empty/all filter, or a scoped filter that data-dependently matches every row).'),
            workspace: z.string().min(1),
        },
        async (args) => {
            try {
                const denied = helpers.gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await helpers.resolveDeps(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleUpdateByQuery(
                    routed.deps,
                    args.collection as string,
                    filterNodeZ.parse(args.filter), // QA round-3
                    args.fields as Record<string, unknown>,
                    args.all as boolean | undefined, // X-allrows
                );
                return ok(result);
            } catch (e) { return filterOrRowOrGeneric('collection_update_by_query', e); }
        },
    );

    mcpServer.tool(
        'collection_delete_by_query',
        'Delete all records matching a filter. Mirrors GroundfloorClient.deleteByQuery. Refuses empty/all filter (footgun guard) — use collection_truncate for full wipes. Returns {deleted, collection}.',
        {
            collection: z.string(),
            filter: filterNodeZ,
            all: z.boolean().optional().describe('X-allrows: required true to confirm an unscoped delete (empty/all filter, or a scoped filter that data-dependently matches every row).'),
            workspace: z.string().min(1),
        },
        async (args) => {
            try {
                const denied = helpers.gateWorkspace(args, 'write');
                if (denied) return denied;
                const routed = await helpers.resolveDeps(deps, args.workspace as string);
                if (!routed.ok) return routed.envelope;
                const result = await handleDeleteByQuery(
                    routed.deps,
                    args.collection as string,
                    filterNodeZ.parse(args.filter), // QA round-3
                    args.all as boolean | undefined, // X-allrows
                );
                return ok(result);
            } catch (e) { return filterOrRowOrGeneric('collection_delete_by_query', e); }
        },
    );
}

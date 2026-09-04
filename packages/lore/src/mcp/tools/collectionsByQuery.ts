/**
 * collectionsByQuery.ts — MCP registration for collection_update_by_query /
 * collection_delete_by_query.
 *
 * X-allrows split (2026-09-03, 800-line cap) — these two `mcpServer.tool(...)`
 * registrations moved out of collections.ts to make room for the `all: true`
 * opt-in both tools gained (see `handleUpdateByQuery`/`handleDeleteByQuery`,
 * still defined and exported from collections.ts — only the MCP wiring moved).
 * Mirrors the existing collectionsTransaction.ts/collectionsJoin.ts split
 * pattern: a small `RegistrationHelpers` interface for the shared
 * gateWorkspace/resolveDeps callbacks, passed in by `registerCollectionTools`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { filterNodeZ } from './collectionsFilterSchema.js';
import type { McpScopeMode } from './mcpScope.js';
import {
    handleUpdateByQuery,
    handleDeleteByQuery,
    filterOrRowOrGeneric,
    type CollectionsDeps,
} from './collections.js';

type McpEnvelope = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: true;
};

function ok(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
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

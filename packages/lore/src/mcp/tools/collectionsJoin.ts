/**
 * Multi-hop collection join: shared handler + MCP registration.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FilterNode } from '../../engines/collectionStorage.js';
import type { JoinHop, JoinQuery, Row } from '../../contracts/tables.js';
import { MAX_JOIN_HOPS } from '../../contracts/tables.js';
import { filterNodeZ } from './collectionsFilterSchema.js';
import type { McpScopeMode } from './mcpScope.js';
import type { CollectionsDeps } from './collections.js';

const joinHopZ = z.object({
    collection: z.string().min(1),
    on: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    type: z.enum(['inner', 'left']),
});

export const joinQueryBodyZ = z.object({
    from: z.string().min(1),
    join: z.array(joinHopZ).min(1).max(MAX_JOIN_HOPS),
    where: filterNodeZ.optional(),
    opts: z.object({
        limit: z.number().int().positive().optional(),
        orderBy: z.string().optional(),
        orderDir: z.enum(['asc', 'desc']).optional(),
    }).optional(),
    limit: z.number().int().positive().optional(),
});

export async function handleJoinQuery(
    deps: CollectionsDeps,
    body: unknown,
): Promise<{ records: Row[] }> {
    const parsed = joinQueryBodyZ.parse(body);
    if (!deps.tableStorage.joinMany) {
        throw new Error('join not supported on this adapter');
    }
    const query: JoinQuery = {
        from: parsed.from,
        join: parsed.join as JoinHop[],
        where: parsed.where as FilterNode | undefined,
        opts: {
            ...(parsed.opts ?? {}),
            ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        },
    };
    const records = await deps.tableStorage.joinMany(query);
    return { records };
}

type McpEnvelope = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: true;
};

export interface CollectionJoinRegistrationHelpers {
    gateWorkspace(args: { workspace?: unknown }, mode: McpScopeMode): McpEnvelope | null;
    resolveDeps(
        deps: CollectionsDeps,
        requested: string,
    ): Promise<{ ok: true; deps: CollectionsDeps } | { ok: false; envelope: McpEnvelope & { isError: true } }>;
}

export function registerCollectionJoinQueryTool(
    mcpServer: McpServer,
    deps: CollectionsDeps,
    helpers: CollectionJoinRegistrationHelpers,
): void {
    mcpServer.tool(
        'collection_join_query',
        'Join 1–4 related collections. Body is { from, join, where?, opts? }. No raw SQL.',
        {
            from: joinQueryBodyZ.shape.from,
            join: joinQueryBodyZ.shape.join,
            where: filterNodeZ.optional(),
            opts: joinQueryBodyZ.shape.opts,
            workspace: z.string().min(1),
        },
        async (args) => {
            const denied = helpers.gateWorkspace(args, 'read');
            if (denied) return denied;
            const routed = await helpers.resolveDeps(deps, args.workspace as string);
            if (!routed.ok) return routed.envelope;
            try {
                const result = await handleJoinQuery(routed.deps, args);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                        error: (error as Error).message,
                    }, null, 2) }],
                    isError: true,
                };
            }
        },
    );
}

/**
 * recallExpandTool.ts — the `recall_expand` MCP tool (3.21 step 3(g)).
 *
 * Pairs with `recall`'s `compact:true` candidates: a caller inspects the
 * thin {id, label, snippet, score, matchedBy, updatedAt} list, decides
 * which ids are worth the token cost of a full body, and fetches exactly
 * those via this call. Confinement (workspace / ecosystem / actor scope)
 * is enforced by the shared expandCandidates() — see recallExpand.ts's own
 * doc comment for why a separate confinement pass is required here (an id
 * a caller could not have recalled must not be expandable either).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertMcpScope } from '../mcpScope.js';
import { expandCandidates, MAX_EXPAND_IDS } from '../../../recall/recallExpand.js';
import { WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import type { SearchToolsDeps } from './types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';

export function registerRecallExpandTool(mcpServer: McpServer, deps: SearchToolsDeps): void {
    mcpServer.tool(
        'recall_expand',
        `Fetch full node bodies for up to ${MAX_EXPAND_IDS} ids returned as \`recall\`'s compact:true candidates. Confined to the SAME workspace/ecosystem/actor scope recall itself enforces — an id outside that scope is silently dropped from the response, not an error.`,
        {
            ids: z.array(z.string().min(1)).min(1).max(MAX_EXPAND_IDS).describe(`Candidate ids to expand (from a prior recall's compact:true response). Max ${MAX_EXPAND_IDS}; duplicates are ignored.`),
            workspace: z.string().min(1).describe('Workspace scope (required). Must be the SAME workspace the originating recall ran against — a named workspace only, not "*".'),
            ecosystem: z.string().min(1).optional().describe('Ecosystem scope. Defaults to the daemon-detected scope, matching recall\'s own default.'),
        },
        async ({ ids, workspace, ecosystem }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                if (workspace === '*') {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'cross_workspace_not_supported', hint: 'recall_expand requires a single named workspace, matching the workspace the originating recall ran against' }, null, 2) }], isError: true };
                }
                // SP-01 — bound-principal workspace scope (read); same gate `recall` applies.
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                const effectiveEcosystem = ecosystem ?? deps.detectedScope.ecosystem;

                const graph = deps.graphRegistry
                    ? await deps.graphRegistry.getGraphHandle(workspace)
                    : deps.store.loreGraph;
                const nodes = await expandCandidates(graph, ids, effectiveEcosystem);

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            requested: ids.length,
                            expanded: nodes.length,
                            nodes,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                if (error instanceof WorkspaceNotFoundError) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_found', requested: error.requested, known: error.known }, null, 2) }], isError: true };
                }
                return mcpToolError('recall_expand', error, log);
            }
        },
    );
}

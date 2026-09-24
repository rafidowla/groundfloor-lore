/**
 * recallOutcomeTool.ts — the `recall_outcome` MCP tool (3.21 step 3(h)).
 *
 * A recall-adjacent front door onto the EXISTING outcome-weighting
 * mechanism (Feature 2's `record_outcome` / node_outcomes / ranking.ts's
 * outcomeWeight()). No new ranking math, and — per Opus review round 2 —
 * no new vocabulary either: `outcome` is record_outcome's own
 * 'success' | 'failure' | 'partial', meaning exactly what it means there
 * (the result of ACTING on the recalled memory), not a relevance
 * judgment on the recall itself. See recall/recallOutcome.ts's doc
 * comment for why a separate relevance vocabulary was rejected (it would
 * have collided with ranking.ts's deliberate failure-boost policy).
 * Relevance feedback is NOT a ranking signal in 3.21.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertMcpScope } from '../mcpScope.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from '../workspaceResolve.js';
import { applyRecallOutcome } from '../../../recall/recallOutcome.js';
import type { SearchToolsDeps } from './types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';

export function registerRecallOutcomeTool(mcpServer: McpServer, deps: SearchToolsDeps): void {
    mcpServer.tool(
        'recall_outcome',
        `Record the OUTCOME of acting on a recalled node — did following it work? — feeding the SAME outcome-weighting ranking.ts already applies via record_outcome's node_outcomes mechanism. Same vocabulary and meaning as 'record_outcome': 'success' = acting on the node's content worked, 'failure' = it misled (ranking.ts deliberately ranks a failure-flagged node HIGHER afterward, as a warning — this is NOT "downrank irrelevant results"), 'partial' = mixed. This is outcome feedback, not relevance feedback — 3.21 has no relevance-based ranking signal; if the recalled node was simply off-topic, don't call this. Pass the \`queryId\` a prior recall/search response carried, if you have one, to tie the outcome to that call.`,
        {
            nodeId: z.string().min(1).describe('Id of the recalled node this outcome is attributed to.'),
            workspace: z.string().min(1).describe('Workspace the node lives in (required — a single named workspace, not "*").'),
            outcome: z.enum(['success', 'failure', 'partial']).describe(`Identical to record_outcome's own field: 'success' = acting on the node worked, 'failure' = it misled (ranks HIGHER afterward as a warning, by ranking.ts's existing design), 'partial' = mixed. Not a relevance judgment.`),
            queryId: z.string().optional().describe('Correlation token from a prior recall/search response (its `queryId` field), if available. Folded into the outcome record for audit — not required.'),
        },
        async ({ nodeId, workspace, outcome, queryId }) => {
            try {
                if (!deps.auxStore) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_configured', hint: 'outcome tracking is not wired on this deployment' }, null, 2) }], isError: true };
                }
                if (workspace === '*') {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'cross_workspace_not_supported', hint: 'recall_outcome requires a single named workspace' }, null, 2) }], isError: true };
                }
                // SP-01 — recording an outcome mutates the node's counters; write scope.
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;

                const resolved = await resolveTargetGraph(deps.store, deps.graphRegistry, deps.detectedScope.workspace, workspace);
                if (!resolved.ok) {
                    if ('missing' in resolved) return workspaceRequiredEnvelope();
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_found', requested: resolved.requested, known: resolved.known }, null, 2) }], isError: true };
                }

                const result = await applyRecallOutcome({
                    auxStore: deps.auxStore, graph: resolved.graph, versionStore: deps.versionStore,
                    nodeId, workspace, outcome, queryId, recordedBy: 'mcp', principal: 'mcp',
                });
                if (!result.ok) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'node_not_found', node_id: nodeId }, null, 2) }], isError: true };
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            outcome_id: result.outcomeId,
                            node_id: nodeId,
                            workspace,
                            outcome,
                            status: result.status,
                            new_confirmation_score: result.newConfirmationScore,
                            counts: result.counts,
                            ...(queryId ? { query_id: queryId } : {}),
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('recall_outcome', error, log);
            }
        },
    );
}

/**
 * outcomes.ts — Outcome feedback tools (Feature 2, 2026-05-26).
 *
 * Tools:
 *   record_outcome     — record a success/failure/partial outcome for a node
 *   get_node_outcomes  — retrieve outcome history + confirmation score
 *
 * Outcome counters (success_count, failure_count, partial_count,
 * confirmation_score) are denormalized onto the LoreNode in the graph so
 * recall ranking can boost high-confidence nodes without joining.
 * The raw outcome rows live in AuxStore's node_outcomes table for
 * audit / drill-down access.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageBundle } from '../services.js';
import type { AuxStore } from '../../outbox/auxStore.js';
import type { VersionStore } from '../../outbox/versionStore.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { assertMcpScope } from './mcpScope.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from './workspaceResolve.js';
import { log } from '../../logger.js';
import { mcpToolError } from './mcpToolError.js';
import { withTransactionConflictRetry } from '../../engines/transactionConflictRetry.js';

export interface OutcomeDeps {
    store: StorageBundle;
    auxStore: AuxStore;
    /** Feature 8: optional version store. When wired, record_outcome writes create version records. */
    versionStore?: VersionStore;
    /**
     * Local-mode multi-workspace registry. When wired, record_outcome's graph
     * counter denormalization resolves the requested workspace's graph instead
     * of the boot/active store, so the denormalized counters land in the same
     * workspace as the authoritative SQLite/AuxStore rows. Optional so
     * cloud-mode + test fixtures fall back to `store.loreGraph`.
     */
    graphRegistry?: LocalGraphRegistry;
    /** Active workspace, used as the resolver's fallback. Optional so callers
     *  that don't wire it default to the requested workspace. */
    detectedScope?: { workspace: string; ecosystem: string };
}

/** Recalculate confirmation score from counters. 0 when no outcomes. */
function calcConfirmationScore(success: number, failure: number, partial: number): number {
    const total = success + failure + partial * 0.5;
    if (total === 0) return 0;
    return Math.round((success / total) * 1000) / 1000;
}

export function registerOutcomeTools(server: McpServer, deps: OutcomeDeps): void {

    /* ─── record_outcome ────────────────────────────────────────── */
    server.tool(
        'record_outcome',
        'Record a use-outcome for a knowledge node. Increments the node\'s outcome counters and recalculates its confirmation_score. Use "success" when the node\'s content led to a correct result, "failure" when it misled, "partial" for mixed results.',
        {
            node_id:     z.string().describe('Id of the node this outcome is attributed to.'),
            workspace:   z.string().min(1).describe('Workspace the node lives in.'),
            status:      z.enum(['success', 'failure', 'partial']).describe('Outcome classification.'),
            notes:       z.string().optional().describe('Optional free-text notes explaining the outcome.'),
            recorded_by: z.string().optional().describe('Actor recording the outcome (user id, agent name, etc.).'),
        },
        async ({ node_id, workspace, status, notes, recorded_by }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                // Local-mode routing: the graph counter denormalization must
                // land in the REQUESTED workspace's graph, not the boot/active
                // store. (The AuxStore/SQLite side below is already workspace-
                // scoped by its `workspace` column.) When no registry is wired
                // (cloud / tests) the resolver returns the boot store, so
                // behavior is unchanged.
                const resolved = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope?.workspace ?? workspace,
                    workspace,
                );
                if (!resolved.ok) {
                    if ('missing' in resolved) return workspaceRequiredEnvelope();
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                error: 'workspace_not_found',
                                requested: resolved.requested,
                                known: resolved.known,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                const graph = resolved.graph;
                await graph.initialize();

                const node = await graph.getNode(node_id);
                if (!node) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'node_not_found', node_id }, null, 2) }], isError: true };
                }

                // Insert outcome row.
                const outcomeId = randomUUID();
                deps.auxStore.recordOutcome({ id: outcomeId, nodeId: node_id, workspace, status, notes, recordedBy: recorded_by });

                // Recompute counters from SQLite (authoritative source).
                const counts = deps.auxStore.getOutcomeCount(node_id, workspace);
                const newScore = calcConfirmationScore(counts.success, counts.failure, counts.partial);

                // Update the graph node with new counters + score.
                await withTransactionConflictRetry(() => graph.upsertNode({
                    ...node,
                    success_count:      counts.success,
                    failure_count:      counts.failure,
                    partial_count:      counts.partial,
                    confirmation_score: newScore,
                }));

                // Bump corpus counter.
                deps.auxStore.incrementCounter(workspace, `outcomes_${status}`);

                // Feature 8: record version (non-fatal).
                if (deps.versionStore) {
                    try {
                        deps.versionStore.recordVersion({
                            versionId: randomUUID(), nodeId: node_id, workspace,
                            timestamp: new Date().toISOString(), principal: 'mcp',
                            operation: 'outcome',
                            previousState: node,
                            newState: { ...node, success_count: counts.success, failure_count: counts.failure, partial_count: counts.partial, confirmation_score: newScore },
                            changesetId: null,
                        });
                    } catch { /* non-fatal */ }
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            outcome_id: outcomeId,
                            node_id,
                            workspace,
                            status,
                            new_confirmation_score: newScore,
                            counts,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('record_outcome', error, log);
            }
        },
    );

    /* ─── get_node_outcomes ─────────────────────────────────────── */
    server.tool(
        'get_node_outcomes',
        'Retrieve outcome history and confirmation score for a node.',
        {
            node_id:   z.string().describe('Id of the node to retrieve outcomes for.'),
            workspace: z.string().min(1).describe('Workspace the node lives in.'),
            limit:     z.number().int().min(1).max(100).default(20).describe('Max number of outcome records to return (default 20).'),
        },
        async ({ node_id, workspace, limit }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                const outcomes = deps.auxStore.getOutcomes(node_id, workspace, limit);
                const counts   = deps.auxStore.getOutcomeCount(node_id, workspace);
                const score    = calcConfirmationScore(counts.success, counts.failure, counts.partial);
                const total    = counts.success + counts.failure + counts.partial;

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            node_id,
                            workspace,
                            confirmation_score: score,
                            total_count: total,
                            counts,
                            outcomes,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('record_outcome', error, log);
            }
        },
    );
}

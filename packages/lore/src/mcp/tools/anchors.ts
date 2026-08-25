/**
 * anchors.ts — Anchor tracking tools (Feature 6 Phase 1, 2026-05-26).
 *
 * Tools:
 *   check_anchors — inspect a node's anchor references and optionally flag as stale
 *
 * Phase 1 scope: store anchor metadata, flag stale, surface in check_anchors.
 * Auto-demotion (lowering classification tier of stale-anchor nodes) is
 * deferred to Feature 6 Phase 2 once Feature 1 lifecycle data accumulates.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageBundle } from '../services.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { parseAnchors } from '../anchorParse.js';
import { assertMcpScope } from './mcpScope.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from './workspaceResolve.js';
import { log } from '../../logger.js';
import { mcpToolError } from './mcpToolError.js';
import { withTransactionConflictRetry } from '../../engines/transactionConflictRetry.js';

export interface AnchorDeps {
    store: StorageBundle;
    // Phase 6 P1.C — per-workspace graph routing (local/Postgres model). When
    // absent (cloud / tests), resolveTargetGraph falls back to the boot store,
    // so behavior is unchanged on the no-registry path.
    graphRegistry?: LocalGraphRegistry;
    detectedScope?: { workspace: string; ecosystem: string };
}

export function registerAnchorTools(server: McpServer, deps: AnchorDeps): void {

    /* ─── check_anchors ─────────────────────────────────────────── */
    server.tool(
        'check_anchors',
        'Inspect a node\'s anchor references and optionally flag the node as anchor-stale. Phase 1: surfaces anchor metadata only. Actual link-checking (HTTP HEAD requests, node existence) is a Phase 2 concern.',
        {
            id:         z.string().describe('Id of the node to check anchors for.'),
            workspace:  z.string().min(1).describe('Workspace the node lives in.'),
            mark_stale: z.boolean().default(false).describe('When true, set anchor_stale=true and record anchor_stale_since=now on the node. Use when you have out-of-band knowledge that an anchor is stale (e.g. a URL returned 404, a referenced decision was superseded).'),
        },
        async ({ id, workspace, mark_stale }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope. mark_stale
                // mutates the node, so it requires write; pure inspection
                // requires read.
                const scopeDenied = assertMcpScope(workspace, mark_stale ? 'write' : 'read');
                if (scopeDenied) return scopeDenied;
                // Phase 6 P1.C — route to the REQUESTED workspace's graph, not
                // the boot/active store. Registry absent → boot store (cloud /
                // tests), so the no-registry path is unchanged.
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

                const node = await graph.getNode(id);
                if (!node) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'node_not_found', id }, null, 2) }], isError: true };
                }

                const anchors = parseAnchors(node.anchors);
                let staleMarked = false;

                if (mark_stale && !node.anchor_stale) {
                    await withTransactionConflictRetry(() => graph.upsertNode({
                        ...node,
                        anchor_stale: true,
                        anchor_stale_since: new Date().toISOString(),
                    }));
                    staleMarked = true;
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            id,
                            workspace,
                            anchor_count: anchors.length,
                            anchor_stale: staleMarked ? true : (node.anchor_stale ?? false),
                            anchor_stale_since: staleMarked
                                ? new Date().toISOString()
                                : (node.anchor_stale_since ?? null),
                            anchors,
                            stale_marked: staleMarked,
                            hint: anchors.length === 0
                                ? 'This node has no anchors. Add anchors via store_node with anchors: \'[{"type":"url","ref":"https://..."}]\'.'
                                : 'Phase 1: anchor freshness is not automatically verified. Use mark_stale=true when you detect a stale reference.',
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('check_anchors', error, log);
            }
        },
    );
}

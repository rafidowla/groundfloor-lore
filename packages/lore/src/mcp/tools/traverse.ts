/**
 * traverse.ts — Multi-hop graph walk.
 *
 * Tool:
 *   - traverse  follow LoreEdge edges from a starting node up to depth
 *
 * Wraps the same negative-evidence envelope (v1.1.1 P2) the rest of
 * the read-only tools use: confidence:0 + actionable explanation when
 * the start node is missing OR has no neighbours, so agents stop
 * retrying with id variations / increased depth.
 *
 * Lives in its own file because search.ts and recall.ts share a
 * `buildLanguageHint` helper that traverse doesn't need — keeping
 * traverse alone avoids forcing it into that grouping prematurely.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageBundle } from '../services.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { assertMcpScope } from './mcpScope.js';
import { ecosystemMatches } from '../../core/ecosystemMatch.js';
import { confinedTraverse, type NeighborGraph } from '../../engines/graphNeighbors.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from './workspaceResolve.js';
import { log } from '../../logger.js';
import { mcpToolError } from './mcpToolError.js';
import { filterNodesByActorScope } from '../../security/scopeFilter.js';

export interface TraverseToolDeps {
    store: StorageBundle;
    /**
     * Local-mode multi-workspace registry. Optional: when absent
     * (cloud-mode / tests) resolveTargetGraph falls back to the boot
     * store, preserving prior single-workspace behavior.
     */
    graphRegistry?: LocalGraphRegistry;
    /**
     * Boot/active workspace, used as the resolver's active-workspace hint.
     * Its `ecosystem` is deliberately NOT the default for the walk's scope —
     * see the `traverseEcosystem` note in the handler.
     * Optional — most tool deps carry detectedScope already.
     */
    detectedScope?: { workspace: string; ecosystem?: string };
}

export function registerTraverseTool(mcpServer: McpServer, deps: TraverseToolDeps): void {
    mcpServer.tool(
        'traverse',
        'Follow graph edges from a starting node to find all connected knowledge',
        {
            nodeId: z.string().describe('Starting node ID'),
            depth: z.number().optional().describe('Max traversal depth (default: 2, max: 5)'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
            ecosystem: z.string().min(1).optional().describe('Ecosystem scope for the walk. Omitted = every ecosystem in the workspace (the workspace is the isolation boundary). A host serving several tenants out of ONE workspace passes the caller\'s ecosystem here; nodes outside it are then invisible to the walk.'),
        },
        async ({ nodeId, depth, workspace, ecosystem }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                // Local-mode routing — resolve the requested workspace's
                // graph so the traversal reads from THAT workspace's store,
                // not the boot/active default. Registry-absent (cloud/tests)
                // falls back to the boot store, so behavior is unchanged.
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
                const targetGraph = resolved.graph;
                const startNode = await targetGraph.getNode(nodeId);
                if (!startNode) {
                    // v1.1.1 P2 — unknown-node case. Wrap the not-found
                    // error in the negative-evidence envelope so the
                    // agent sees confidence:0 + actionable reason instead
                    // of just "node not found" (which it sometimes treats
                    // as a hint to retry with a different id format).
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                ok: false,
                                error: `Node '${nodeId}' not found.`,
                                _meta: {
                                    confidence: 0,
                                    negative_evidence: `Node id "${nodeId}" does not exist in the graph. This is not a misformat — the node simply isn't there. Use search/recall to find candidate ids; do NOT retry traverse with id variations.`,
                                    sources_consulted: 1,
                                },
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }

                // Per-hop ecosystem confinement. `graph.traverse()` walks
                // LoreEdge with NO ecosystem predicate, so a correctly-scoped
                // start node can pull a DIFFERENT ecosystem's node into the
                // result set across a single edge — and autolink used to draw
                // exactly such cross-ecosystem edges (engines/reconnect.ts).
                // retrieve.ts added this filter to `recall` for that reason;
                // this tool runs the same walk and returns full `content` for
                // every neighbour, so it needs it at least as badly. Since R6
                // the confinement is applied to the WALK, not to its output —
                // see the `confinedTraverse` call below.
                //
                // The start node is checked too: entering the walk from a
                // foreign node is the same boundary crossing as ending on one.
                //
                // R4 #5 — the DEFAULT is '*', NOT `deps.detectedScope.ecosystem`.
                // detectedScope comes from bootSteps.ts `resolveWorkspaceScope`,
                // which substring-matches process.cwd() against
                // workspace-paths.json ONCE at boot. Defaulting to it made
                // traverse hard-fail with "Node 'X' not found." on a node that
                // exists in the requested workspace, purely because of the
                // directory the daemon happened to start in — the documented
                // `local` mode (one daemon, several apps, each node stamped
                // with the STORING session's detectedScope at storeNode.ts).
                // traverse had no ecosystem filter at all before, so that was a
                // regression on previously-working input, and `get_node`
                // returns the same node's full content unscoped, which made
                // "not found" untrue on the neighbouring tool.
                //
                // The workspace is the hard isolation boundary
                // (core/ecosystemMatch.ts, CLAUDE.md); ecosystem is a scope a
                // cooperating host STATES per request. A boot-global value
                // cannot separate two tenants, so it must not be the thing that
                // decides visibility — the same reasoning
                // security/routeWorkspaceBinding.ts applies to the workspace
                // axis ("NEVER consults detectedScope / any boot value").
                const traverseEcosystem = ecosystem ?? '*';
                if (!ecosystemMatches((startNode as { ecosystem?: string }).ecosystem, traverseEcosystem)) {
                    // The node DOES exist — say so, rather than repeating
                    // get_node's "not found" about a row get_node will return.
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                ok: false,
                                error: `Node '${nodeId}' is outside the requested ecosystem scope '${traverseEcosystem}'.`,
                                _meta: {
                                    confidence: 0,
                                    negative_evidence: `Node id "${nodeId}" exists but is not visible in ecosystem "${traverseEcosystem}". Absence here is a SCOPE result, not a missing node — do NOT retry traverse with id variations. Re-issue with the node's own ecosystem, or with ecosystem:"*", if the caller is entitled to it.`,
                                    sources_consulted: 1,
                                },
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                // R6 #2 — FRONTIER-PRUNING, not output filtering.
                //
                // This used to call `targetGraph.traverse()` unconfined and
                // filter only the RESULT, so the walk passed THROUGH foreign
                // hops freely: on center(alpha) → mid(beta) → far(alpha) it
                // returned `far`, while `GET /api/subgraph` — the REST twin
                // this tool's own reasoning is copied into, and which
                // DEC-SCOPE-SURFACE-CLASS puts in the SAME class — returned
                // only the centre, because its confinement prunes the frontier.
                // Two answers to one reachability question under one concrete
                // scope, with nothing stating which was right.
                //
                // Pruning is the settled semantic (DEC-SCOPE-REACHABILITY): a
                // scoped walk may not ROUTE THROUGH a node the caller cannot
                // see. Post-filtering still discloses that a path exists, and
                // its length, through rows the scope excludes — on the
                // one-workspace-many-tenants host these scopes exist for, that
                // IS the topology that must not cross.
                //
                // `confinedTraverse` (engines/graphNeighbors.ts) is literally
                // `subgraphFetch`'s walk with the confidence filter opened up,
                // so the two surfaces share ONE BFS rather than one paragraph.
                //
                // The UNSCOPED path stays on `targetGraph.traverse()`: with
                // scope '*' the predicate is a tautology, so pruning and
                // post-filtering are provably the same node set, and the engine
                // path keeps its memoisation and the cross-engine parity
                // sub-order that suite pins.
                const results = traverseEcosystem === '*'
                    ? await targetGraph.traverse(nodeId, depth ?? 2)
                    : await confinedTraverse(
                        targetGraph as unknown as NeighborGraph,
                        nodeId,
                        depth ?? 2,
                        traverseEcosystem,
                    );

                // 3.1 (2026-08-17) — row-level security_scopes confinement on
                // the traversal RESULT: drop hops whose node the bound actor
                // may not see before the tool result is returned. Hop order is
                // preserved; the envelope below is computed from the confined
                // set so count and confidence stay consistent. Undefined actor
                // scopes ⇒ no filtering.
                const survivorIds = new Set(
                    filterNodesByActorScope(results.map((r) => r.node)).map((n) => n.id),
                );
                const confinedResults = results.filter((r) => survivorIds.has(r.node.id));

                // v1.1.1 P2 — empty-traversal envelope. A node with no
                // connected neighbours at the requested depth is the
                // "isolated node" case; tell the agent absence is the
                // answer rather than retrying with depth+1 indefinitely.
                const meta = confinedResults.length === 0
                    ? {
                        confidence: 0,
                        negative_evidence: `Node "${startNode.id}" has no connected neighbours at depth <= ${depth ?? 2}. Absence is informative — this node is isolated in the current scope. Increasing depth probably won't help; consider widening project scope or accepting the node as standalone.`,
                        sources_consulted: 1,
                    }
                    : { confidence: 1, sources_consulted: 1 };

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            startNode: { id: startNode.id, type: startNode.type, label: startNode.label },
                            connectedNodes: confinedResults.length,
                            results: confinedResults.map((item) => ({
                                depth: item.depth,
                                relation: item.relation,
                                id: item.node.id,
                                type: item.node.type,
                                label: item.node.label,
                                content: item.node.content,
                                tags: item.node.tags,
                            })),
                            _meta: meta,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('traverse', error, log);
            }
        },
    );
}

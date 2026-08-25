/**
 * lifecycle.ts — Knowledge lifecycle management tools (Feature 1, 2026-05-26).
 *
 * Tools:
 *   prune_nodes     — archive (or hard-delete) nodes by classification + age
 *   restore_node    — un-archive a node back to active
 *   get_prune_status — check the status of a previous prune_nodes job
 *
 * Design notes:
 *   - Protected nodes (status='protected') are NEVER modified by prune_nodes.
 *   - dry_run=true (default) is safe to call at any time — read-only.
 *   - Hard-delete is only allowed when workspace.allowHardDelete=true AND
 *     the caller explicitly passes hard_delete=true.
 *   - Prune jobs are tracked in AuxStore's prune_jobs table so the caller
 *     can poll get_prune_status for async progress.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageBundle } from '../services.js';
import type { AuxStore } from '../../outbox/auxStore.js';
import type { VersionStore } from '../../outbox/versionStore.js';
import { loadWorkspaces } from '../../config/workspaces.js';
import { assertMcpScope } from './mcpScope.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from './workspaceResolve.js';
import { log } from '../../logger.js';
import { mcpToolError } from './mcpToolError.js';
import { withTransactionConflictRetry } from '../../engines/transactionConflictRetry.js';

export interface LifecycleDeps {
    store: StorageBundle;
    auxStore: AuxStore;
    /** Feature 8: optional version store. When wired, prune/restore writes create version records. */
    versionStore?: VersionStore;
    /**
     * Phase 6 P1 — multi-workspace registry. When wired (local mode), prune/restore
     * route their graph reads/writes to the REQUESTED workspace's store via
     * resolveTargetGraph. Optional: absent (cloud/tests) → resolver falls back to
     * the boot-bound store.loreGraph, preserving prior single-store behavior.
     */
    graphRegistry?: LocalGraphRegistry;
    /** Active (boot) workspace, used as the resolver's fallback context. Optional. */
    detectedScope?: { workspace: string; ecosystem?: string };
    /** Per-workspace verbatim resolver — routes the hard-delete tombstone to the requested workspace. */
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<StorageBundle['loreVerbatim']> };
}

export function registerLifecycleTools(server: McpServer, deps: LifecycleDeps): void {

    /* ─── prune_nodes ───────────────────────────────────────────── */
    server.tool(
        'prune_nodes',
        'Archive (or hard-delete) nodes matching a classification tier and/or age threshold. Protected nodes are never touched. Default dry_run=true is always safe — it returns a preview without modifying anything.',
        {
            workspace:       z.string().min(1).describe('Target workspace.'),
            dry_run:         z.boolean().default(true).describe('When true (default), return a preview list without modifying any nodes.'),
            classification:  z.enum(['foundational', 'tactical', 'observational']).optional().describe('Only prune nodes of this classification tier. Omit to match all tiers (excluding foundational when hard_delete=true).'),
            older_than_days: z.number().int().min(1).optional().describe('Only prune nodes whose createdAt is older than this many days.'),
            tags:            z.string().optional().describe('Comma-separated tag filter — only nodes containing ALL listed tags are eligible.'),
            hard_delete:     z.boolean().default(false).describe('When true and workspace.allowHardDelete=true, permanently delete matched nodes instead of archiving them.'),
        },
        async ({ workspace, dry_run, classification, older_than_days, tags, hard_delete }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                const wsFile = loadWorkspaces();
                const wsEntry = wsFile.workspaces.find((w) => w.name === workspace);
                if (!wsEntry) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_found', workspace }, null, 2) }], isError: true };
                }

                // Hard-delete guard.
                if (hard_delete && !wsEntry.allowHardDelete) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'hard_delete_not_allowed', hint: 'Set allowHardDelete=true in workspaces.json for this workspace to enable permanent deletion.' }, null, 2) }], isError: true };
                }

                // Phase 6 P1.C — route to the REQUESTED workspace's store. When
                // graphRegistry is absent (cloud/tests) the resolver returns the
                // boot store, so behavior is unchanged on the no-registry path.
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

                // Fetch all nodes in the workspace (filtering happens in JS).
                // R4 #7 — `'*'`, not the workspace name. The 4th argument is `project`, a
                // CALLER-OWNED node field that every engine turns into a strict
                // `n.project = $project`; it is not guaranteed to equal the workspace name
                // (Atlas stores project='v3' inside workspace='default', and any explicit
                // `project` on a write is preserved verbatim). retrieve.ts:314-321 documents
                // this substitution as the mistake that "silently makes keyword fallback
                // empty while the vector path still appears healthy". The physical workspace
                // boundary is already enforced by the graph resolved above — each workspace
                // is its own database — so the name here only ever DROPPED that workspace's
                // own rows.
                const allNodes = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });

                const cutoff = older_than_days
                    ? new Date(Date.now() - older_than_days * 86400000).toISOString()
                    : null;

                const filterTags = tags
                    ? tags.split(',').map((t) => t.toLowerCase().trim()).filter(Boolean)
                    : [];

                const matched: typeof allNodes = [];
                let protectedCount = 0;

                for (const node of allNodes) {
                    // Never prune protected nodes.
                    if (node.status === 'protected') {
                        if (
                            (!classification || node.classification === classification) &&
                            (!cutoff || node.createdAt < cutoff)
                        ) {
                            protectedCount++;
                        }
                        continue;
                    }
                    // Skip already-archived nodes.
                    if (node.status === 'archived') continue;

                    // Classification filter.
                    if (classification && node.classification !== classification) continue;

                    // Age filter.
                    if (cutoff && node.createdAt >= cutoff) continue;

                    // Tag filter — node.tags is a normalized lowercase
                    // string[] (Pass 3).
                    if (filterTags.length > 0) {
                        if (!filterTags.every((t) => (node.tags ?? []).includes(t))) continue;
                    }

                    matched.push(node);
                }

                if (dry_run) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                dry_run: true,
                                workspace,
                                matched: matched.length,
                                protected_count: protectedCount,
                                would_archive: hard_delete ? 0 : matched.length,
                                would_hard_delete: hard_delete ? matched.length : 0,
                                preview: matched.slice(0, 20).map((n) => ({
                                    id: n.id, type: n.type, label: n.label,
                                    classification: n.classification ?? 'tactical',
                                    createdAt: n.createdAt,
                                })),
                                hint: 'Re-run with dry_run=false to apply changes.',
                            }, null, 2),
                        }],
                    };
                }

                // Create a job record.
                const jobId = deps.auxStore.createPruneJob(workspace, {
                    classification, olderThanDays: older_than_days, tags,
                    hardDelete: hard_delete, dryRun: false,
                });

                let archived = 0;
                let hardDeleted = 0;
                let skipped = 0;

                for (const node of matched) {
                    try {
                        if (hard_delete) {
                            await withTransactionConflictRetry(() => graph.deleteNode(node.id));
                            // audit 2026-06-18 — hard_delete must ALSO tombstone the
                            // LanceDB vector (mirrors delete_node F2a/L-056). Graph-only
                            // delete left the embedding orphaned, so 'permanently
                            // deleted' content stayed semantically recallable. Non-fatal.
                            try {
                                // L-056 — tombstone in the RESOLVED workspace's verbatim
                                // store so it lands in the same workspace as the graph
                                // delete above. Fall back to the boot singleton when no
                                // resolver (cloud / test fixtures).
                                const targetVerbatim = deps.workspaceVerbatimResolver
                                    ? await deps.workspaceVerbatimResolver.getOrOpen(resolved.resolvedWorkspace)
                                    : deps.store.loreVerbatim;
                                const vstore = targetVerbatim as unknown as { tombstone?: (id: string, reason: string) => Promise<void> };
                                if (typeof vstore.tombstone === 'function') {
                                    await vstore.tombstone(`lore:${node.id}`, 'graph node hard-deleted via prune_nodes');
                                } else {
                                    await deps.store.storageClient.verbatimDelete(`lore:${node.id}`);
                                }
                            } catch (vErr) {
                                console.error(`[Lore MCP] prune_nodes verbatim tombstone failed for ${node.id}: ${(vErr as Error).message}`);
                            }
                            hardDeleted++;
                        } else {
                            // Soft archive: set status='archived'.
                            await withTransactionConflictRetry(() => graph.upsertNode({ ...node, status: 'archived' }));
                            archived++;
                        }
                        // Feature 8: record version (non-fatal).
                        if (deps.versionStore) {
                            try {
                                deps.versionStore.recordVersion({
                                    versionId: randomUUID(), nodeId: node.id, workspace,
                                    timestamp: new Date().toISOString(), principal: 'mcp',
                                    operation: hard_delete ? 'delete' : 'archive',
                                    previousState: node,
                                    newState: hard_delete ? null : { ...node, status: 'archived' },
                                    changesetId: null,
                                });
                            } catch { /* non-fatal */ }
                        }
                    } catch {
                        skipped++;
                    }
                }

                const jobResult = {
                    matched: matched.length,
                    archived,
                    hardDeleted,
                    skipped,
                    protectedCount,
                    dryRun: false,
                };
                deps.auxStore.updatePruneJob(jobId, { status: 'completed', result: jobResult });

                const result = {
                    job_id: jobId,
                    matched: matched.length,
                    archived,
                    hard_deleted: hardDeleted,
                    skipped,
                    protected_count: protectedCount,
                    dry_run: false,
                };

                // Bump AuxStore corpus counter.
                if (archived > 0) deps.auxStore.incrementCounter(workspace, 'nodes_archived', archived);
                if (hardDeleted > 0) deps.auxStore.incrementCounter(workspace, 'nodes_hard_deleted', hardDeleted);

                return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                return mcpToolError('prune_nodes', error, log);
            }
        },
    );

    /* ─── restore_node ──────────────────────────────────────────── */
    server.tool(
        'restore_node',
        'Restore an archived node back to active status.',
        {
            id:        z.string().describe('Node id to restore.'),
            workspace: z.string().min(1).describe('Workspace the node lives in.'),
        },
        async ({ id, workspace }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                // Phase 6 P1.C — route to the REQUESTED workspace's store. No-registry
                // path falls back to the boot store, preserving prior behavior.
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
                const previousStatus = node.status ?? 'active';
                await withTransactionConflictRetry(() => graph.upsertNode({ ...node, status: 'active' }));
                // Feature 8: record version (non-fatal).
                if (deps.versionStore) {
                    try {
                        deps.versionStore.recordVersion({
                            versionId: randomUUID(), nodeId: id, workspace,
                            timestamp: new Date().toISOString(), principal: 'mcp',
                            operation: 'restore',
                            previousState: { ...node, status: previousStatus },
                            newState: { ...node, status: 'active' },
                            changesetId: null,
                        });
                    } catch { /* non-fatal */ }
                }
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ success: true, id, previous_status: previousStatus, new_status: 'active' }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('prune_nodes', error, log);
            }
        },
    );

    /* ─── get_prune_status ──────────────────────────────────────── */
    server.tool(
        'get_prune_status',
        'Get the status and result of a prune_nodes job.',
        {
            job_id: z.string().describe('Job id returned by prune_nodes.'),
        },
        async ({ job_id }) => {
            try {
                const job = deps.auxStore.getPruneJob(job_id);
                if (!job) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'job_not_found', job_id }, null, 2) }], isError: true };
                }
                // R5 #2 — the prune-job record carries its workspace + result
                // counts/options; gate on job.workspace (fetch-then-gate, like
                // the approvals get-by-id sibling) so a foreign-workspace token
                // can't read another tenant's job by guessing its id.
                const scopeDenied = assertMcpScope(job.workspace, 'read');
                if (scopeDenied) return scopeDenied;
                return { content: [{ type: 'text' as const, text: JSON.stringify(job, null, 2) }] };
            } catch (error) {
                return mcpToolError('prune_nodes', error, log);
            }
        },
    );
}

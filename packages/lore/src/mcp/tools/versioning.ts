/**
 * versioning.ts — Node versioning + changeset tools (Feature 8, 2026-05-26).
 *
 * Tools:
 *   node_history       — version log for a single node (newest-first)
 *   diff_workspace     — all node changes in a workspace since a timestamp
 *   begin_changeset    — open an atomic transaction → returns changesetId
 *   commit_changeset   — apply all buffered writes atomically + record versions
 *   rollback_changeset — discard (open) or reverse (committed) a changeset
 *   export_snapshot    — serialize current workspace state as JSONL
 *
 * Version records are written automatically by store_node, record_outcome,
 * prune_nodes, and restore_node when versionStore is wired into their deps.
 * These tools expose the read + changeset control surface.
 *
 * Changeset write format (payload stored in changeset_writes):
 *   upsert_node: { workspace: string; nodeData: Record<string, unknown> }
 *   delete_node: { workspace: string; node_id: string }
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageBundle } from '../services.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import type { VersionStore } from '../../outbox/versionStore.js';
import type { LoreNode } from '../../providers/types.js';
import { requireWorkspaceGraph } from '../../engines/requireWorkspaceGraph.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from './workspaceResolve.js';
import { assertMcpScope } from './mcpScope.js';
import { checkWorkspaceQuota, type IWorkspaceQuotaStore } from '../../security/workspaceQuota.js';
import type { WorkspaceEntry } from '../../config/workspaces.js';
import { log } from '../../logger.js';
import { mcpToolError } from './mcpToolError.js';
import type { OutboxStore } from '../../outbox/types.js';
import type { VerbatimStore } from '../../engines/verbatimStore.js';
// 1.M7 (2026-08-17 audit) — changeset commit/rollback write through the
// shared orchestration (outbox + verbatim + embed), not raw graph writes.
import { applyChangesetUpsert, applyChangesetDelete, type ChangesetWriteDeps } from '../changesetWrite.js';

export interface VersioningDeps {
    versionStore: VersionStore;
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    detectedScope: { workspace: string; ecosystem: string };
    /** L-033 (R-005) — the shared per-workspace write quota. When wired,
     *  commit_changeset enforces it across ALL buffered upserts so a changeset
     *  can't bypass workspace.maxNodes/maxStorageBytes (the store_node buffer
     *  branch returns before the hot-path quota gate). Optional → no-op when
     *  unwired (cloud / tests), matching storeNode.ts. */
    quotaStore?: IWorkspaceQuotaStore;
    getWorkspaceEntryForQuota?: (workspace: string) => WorkspaceEntry | undefined;
    /** 1.M7 — changeset commit/rollback write orchestration (outbox /
     *  embed queue / per-workspace verbatim resolver). Optional: when
     *  absent, changeset writes fall back to inline verbatim via the
     *  storage facade (cloud / tests). */
    outboxStore?: OutboxStore;
    embedQueue?: { enqueue: (nodeId: string, text: string, workspace?: string) => void };
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<VerbatimStore> };
}

/** 1.M7 — build the shared changeset-write deps for one initiator label. */
function changesetWriteDeps(deps: VersioningDeps, initiator: string): ChangesetWriteDeps {
    return {
        outboxStore: deps.outboxStore,
        embedQueue: deps.embedQueue,
        verbatim: deps.store.storageClient,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
        bootVerbatim: deps.store.loreVerbatim,
        activeWorkspace: deps.detectedScope.workspace,
        initiator,
    };
}

export function registerVersioningTools(server: McpServer, deps: VersioningDeps): void {

    /* ─── node_history ──────────────────────────────────────────── */
    server.tool(
        'node_history',
        'Return the version history of a node (newest-first). Each entry shows the operation, timestamp, principal, and before/after state. Compacted (expired) entries are excluded.',
        {
            node_id:   z.string().describe('Node id to retrieve history for.'),
            workspace: z.string().min(1).describe('Workspace the node lives in.'),
            limit:     z.number().int().min(1).max(200).default(50).describe('Max versions to return (default 50).'),
        },
        async ({ node_id, workspace, limit }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                const versions = deps.versionStore.getVersions(node_id, workspace, limit);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ node_id, workspace, count: versions.length, versions }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('node_history', error, log);
            }
        },
    );

    /* ─── diff_workspace ────────────────────────────────────────── */
    server.tool(
        'diff_workspace',
        'Return all node changes in a workspace since a given ISO timestamp. Each entry includes the operation, node id, and before/after state. Useful for incremental sync, auditing, and detecting drift.',
        {
            workspace: z.string().min(1).describe('Target workspace.'),
            since:     z.string().describe('ISO 8601 timestamp — return all changes at or after this time.'),
            limit:     z.number().int().min(1).max(1000).default(200).describe('Max version records to return (default 200).'),
        },
        async ({ workspace, since, limit }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                const all = deps.versionStore.getDiff(workspace, since);
                const trimmed = all.slice(0, limit);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            workspace, since,
                            total: all.length, returned: trimmed.length,
                            changes: trimmed,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('node_history', error, log);
            }
        },
    );

    /* ─── begin_changeset ───────────────────────────────────────── */
    server.tool(
        'begin_changeset',
        'Open an atomic write transaction for the given workspace. Returns a changesetId. Pass this id to store_node (changeset_id param) to buffer writes. Commit or roll back with commit_changeset / rollback_changeset.',
        {
            workspace: z.string().min(1).describe('Workspace scope for this changeset.'),
        },
        async ({ workspace }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (write).
                // commit_changeset / rollback_changeset take only a
                // changeset_id (no workspace arg); gating changeset
                // creation here transitively scopes the whole lifecycle —
                // a scoped principal cannot open a changeset against
                // another workspace, so it can never commit one either.
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                const changesetId = deps.versionStore.createChangeset(workspace);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ changeset_id: changesetId, workspace, status: 'open' }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('node_history', error, log);
            }
        },
    );

    /* ─── commit_changeset ──────────────────────────────────────── */
    server.tool(
        'commit_changeset',
        'Apply all buffered writes for a changeset atomically to the graph. Each write creates a version record. If any write fails, the changeset is still marked committed — the error is reported and writes already applied are NOT automatically reversed. Use rollback_changeset to undo a partially-committed changeset.',
        {
            changeset_id: z.string().describe('Changeset id returned by begin_changeset.'),
        },
        async ({ changeset_id }) => {
            try {
                const cs = deps.versionStore.getChangeset(changeset_id);
                if (!cs) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'changeset_not_found', changeset_id }, null, 2) }], isError: true };
                }
                if (cs.status !== 'open') {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'changeset_not_open', status: cs.status }, null, 2) }], isError: true };
                }

                // SP-01 (final-audit 2026-06-18) — commit applies graph writes for
                // cs.workspace. begin_changeset gated CREATION, but commit takes only
                // a changeset_id, so the "transitive scoping" assumption did not hold:
                // a scoped/read-only principal could commit a changeset for a workspace
                // it cannot write. Re-assert write scope on the changeset's own workspace.
                const scopeDenied = assertMcpScope(cs.workspace, 'write');
                if (scopeDenied) return scopeDenied;

                const writes = deps.versionStore.getChangesetWrites(changeset_id);

                // L-033 (R-005) — enforce the per-workspace write quota BEFORE
                // applying any write. The store_node buffer branch returns
                // before the hot-path quota gate, so a changeset is the one
                // write path that could otherwise blow past
                // workspace.maxNodes/maxStorageBytes. Aggregate the buffered
                // upserts per workspace and refuse the WHOLE commit atomically
                // (graph untouched, changeset left OPEN so the cap can be
                // raised or the changeset rolled back) if it would exceed.
                // No-op when quota is unwired (cloud / tests).
                const quotaBytesOf = (nd: Record<string, unknown>): number =>
                    Buffer.byteLength(String(nd['label'] ?? ''), 'utf8') +
                    Buffer.byteLength(String(nd['content'] ?? nd['body'] ?? ''), 'utf8');
                if (deps.quotaStore && deps.getWorkspaceEntryForQuota) {
                    const perWs = new Map<string, { nodes: number; bytes: number }>();
                    for (const w of writes) {
                        if (w.operation !== 'upsert_node') continue;
                        const p = w.payload as { workspace: string; nodeData: Record<string, unknown> };
                        const cur = perWs.get(p.workspace) ?? { nodes: 0, bytes: 0 };
                        cur.nodes += 1;
                        cur.bytes += quotaBytesOf(p.nodeData);
                        perWs.set(p.workspace, cur);
                    }
                    for (const [ws, delta] of perWs) {
                        const q = checkWorkspaceQuota(
                            { store: deps.quotaStore, getWorkspaceEntry: deps.getWorkspaceEntryForQuota },
                            ws, delta,
                        );
                        if (!q.allowed) {
                            return {
                                content: [{
                                    type: 'text' as const,
                                    text: JSON.stringify({
                                        error: 'workspace_quota_exceeded',
                                        dimension: q.dimension,
                                        current: q.current,
                                        cap: q.cap,
                                        workspace: ws,
                                        changeset_id,
                                        status: cs.status, // still 'open' — not committed
                                        applied: 0,
                                    }, null, 2),
                                }],
                                isError: true,
                            };
                        }
                    }
                }

                let applied = 0;
                let failed = 0;
                const errors: string[] = [];
                // Accumulate the per-workspace delta of writes that actually
                // landed, so we bump the quota counter AFTER success (mirrors
                // storeNode.ts: bump only on a committed write).
                const appliedDelta = new Map<string, { nodes: number; bytes: number }>();

                for (const w of writes) {
                    try {
                        if (w.operation === 'upsert_node') {
                            const p = w.payload as { workspace: string; nodeData: Record<string, unknown> };
                            const resolved = await resolveTargetGraph(
                                deps.store, deps.graphRegistry,
                                deps.detectedScope.workspace, p.workspace,
                            );
                            if (!resolved.ok) {
                                errors.push(`seq ${w.seq}: workspace_not_found (${p.workspace})`);
                                failed++;
                                continue;
                            }
                            const graph = resolved.graph;
                            const nodeId = String(p.nodeData['id'] ?? '');
                            const prevNode = await graph.getNode(nodeId);
                            // 1.M7 — route through nodeService (outbox +
                            // verbatim + embed) instead of a raw graph
                            // write, so changeset-created nodes become
                            // searchable like any direct write.
                            await applyChangesetUpsert(
                                changesetWriteDeps(deps, 'mcp:commit_changeset'),
                                graph, p.workspace, p.nodeData,
                            );
                            const ad = appliedDelta.get(p.workspace) ?? { nodes: 0, bytes: 0 };
                            ad.nodes += 1;
                            ad.bytes += quotaBytesOf(p.nodeData);
                            appliedDelta.set(p.workspace, ad);
                            deps.versionStore.recordVersion({
                                versionId: randomUUID(),
                                nodeId,
                                workspace: p.workspace,
                                timestamp: new Date().toISOString(),
                                principal: 'changeset',
                                operation: 'upsert',
                                previousState: prevNode ?? null,
                                newState: p.nodeData,
                                changesetId: changeset_id,
                            });
                            applied++;
                        } else if (w.operation === 'delete_node') {
                            const p = w.payload as { workspace: string; node_id: string };
                            const resolved = await resolveTargetGraph(
                                deps.store, deps.graphRegistry,
                                deps.detectedScope.workspace, p.workspace,
                            );
                            if (!resolved.ok) {
                                errors.push(`seq ${w.seq}: workspace_not_found (${p.workspace})`);
                                failed++;
                                continue;
                            }
                            const graph = resolved.graph;
                            const prevNode = await graph.getNode(p.node_id);
                            // 1.M7 — graph delete + verbatim tombstone in
                            // the same workspace (was graph-only, leaving
                            // the deleted text live in the search index).
                            await applyChangesetDelete(
                                changesetWriteDeps(deps, 'mcp:commit_changeset'),
                                graph, p.workspace, p.node_id,
                                'node deleted via commit_changeset',
                            );
                            deps.versionStore.recordVersion({
                                versionId: randomUUID(),
                                nodeId: p.node_id,
                                workspace: p.workspace,
                                timestamp: new Date().toISOString(),
                                principal: 'changeset',
                                operation: 'delete',
                                previousState: prevNode ?? null,
                                newState: null,
                                changesetId: changeset_id,
                            });
                            applied++;
                        }
                    } catch (writeErr) {
                        errors.push(`seq ${w.seq}: ${(writeErr as Error).message}`);
                        failed++;
                    }
                }

                // L-033 (R-005) — bump the shared write-quota counter by the
                // upserts that actually landed (mirrors storeNode's bump-after-
                // success; failed/skipped writes are not counted).
                if (deps.quotaStore) {
                    for (const [ws, delta] of appliedDelta) deps.quotaStore.increment(ws, delta);
                }

                deps.versionStore.updateChangeset(changeset_id, 'committed');
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ changeset_id, status: 'committed', applied, failed, errors }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('node_history', error, log);
            }
        },
    );

    /* ─── rollback_changeset ────────────────────────────────────── */
    server.tool(
        'rollback_changeset',
        'Roll back a changeset. If still open: discards buffered writes (no graph writes occurred). If already committed: re-applies previous_state for each write to reverse changes. Idempotent — calling on an already-rolled-back changeset is a no-op.',
        {
            changeset_id: z.string().describe('Changeset id to roll back.'),
        },
        async ({ changeset_id }) => {
            try {
                const cs = deps.versionStore.getChangeset(changeset_id);
                if (!cs) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'changeset_not_found', changeset_id }, null, 2) }], isError: true };
                }
                // SP-01 (final-audit 2026-06-18) — rollback reverses committed graph
                // writes; gate on the changeset's workspace (rollback takes only an id).
                const scopeDenied = assertMcpScope(cs.workspace, 'write');
                if (scopeDenied) return scopeDenied;
                if (cs.status === 'rolled_back') {
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify({ changeset_id, status: 'rolled_back', note: 'already rolled back — no-op' }, null, 2) }],
                    };
                }

                if (cs.status === 'open') {
                    // No graph writes have been applied — discard buffered ops.
                    deps.versionStore.updateChangeset(changeset_id, 'rolled_back');
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify({ changeset_id, status: 'rolled_back', reversed: 0, note: 'open changeset discarded before any writes' }, null, 2) }],
                    };
                }

                // status === 'committed' — reverse each versioned write (newest-first).
                const versions = deps.versionStore.getVersionsByChangeset(changeset_id);
                let reversed = 0;
                let failed = 0;
                const errors: string[] = [];

                for (const v of [...versions].reverse()) {
                    try {
                        const resolved = await resolveTargetGraph(
                            deps.store, deps.graphRegistry,
                            deps.detectedScope.workspace, v.workspace,
                        );
                        if (!resolved.ok) { failed++; continue; }
                        const graph = resolved.graph;
                        if (v.previousState != null) {
                            // Node existed before — restore it. 1.M7: route
                            // through nodeService so the REVERTED text also
                            // reaches the verbatim/search index (a raw graph
                            // restore left the post-commit text searchable).
                            await applyChangesetUpsert(
                                changesetWriteDeps(deps, 'mcp:rollback_changeset'),
                                graph, v.workspace, v.previousState as unknown as Record<string, unknown>,
                            );
                        } else if (v.operation === 'upsert') {
                            // Node was brand-new — delete it to undo the create.
                            await applyChangesetDelete(
                                changesetWriteDeps(deps, 'mcp:rollback_changeset'),
                                graph, v.workspace, v.nodeId,
                                'node created by rolled-back changeset',
                            );
                        }
                        reversed++;
                    } catch (revErr) {
                        errors.push(`${v.nodeId}: ${(revErr as Error).message}`);
                        failed++;
                    }
                }

                deps.versionStore.updateChangeset(changeset_id, 'rolled_back');
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ changeset_id, status: 'rolled_back', reversed, failed, errors }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('node_history', error, log);
            }
        },
    );

    /* ─── export_snapshot ───────────────────────────────────────── */
    server.tool(
        'export_snapshot',
        'Serialize current workspace state as JSONL (one JSON object per node per line). This is a read-only projection of Lore\'s graph — not the source of truth. Use for git-visible snapshots, migrations, or external tooling.',
        {
            workspace:        z.string().min(1).describe('Workspace to snapshot.'),
            format:           z.enum(['jsonl']).default('jsonl').describe('Serialization format (currently only "jsonl").'),
            include_archived: z.boolean().default(false).describe('When true, include archived nodes in the snapshot.'),
        },
        async ({ workspace, format: _format, include_archived }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                // Local-mode (Postgres model) routing: snapshot the REQUESTED
                // workspace's graph, not the boot/active store. Registry absent
                // (cloud / tests) → resolver returns the boot store (unchanged).
                const resolved = await resolveTargetGraph(
                    deps.store, deps.graphRegistry,
                    deps.detectedScope.workspace, workspace,
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
                const graph = requireWorkspaceGraph(resolved.graph, 'export_snapshot', 'JSONL node walk runs on the local paged scan');
                await graph.initialize();
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
                const filtered = include_archived
                    ? allNodes
                    : allNodes.filter((n) => !n.status || n.status !== 'archived');
                const jsonl = filtered.map((n) => JSON.stringify(n)).join('\n');
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            workspace,
                            format: 'jsonl',
                            node_count: filtered.length,
                            snapshot: jsonl,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('node_history', error, log);
            }
        },
    );
}

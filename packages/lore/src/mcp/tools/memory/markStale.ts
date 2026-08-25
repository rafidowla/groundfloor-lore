/**
 * markStale.ts — the mark_stale MCP tool (Gap #3). Marks every LoreNode
 * whose tags field contains ANY of the provided tags as stale=true, so
 * recall/search surface a stale_warning for AI callers to verify before
 * trusting the content.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from '../workspaceResolve.js';
import { assertMcpScope } from '../mcpScope.js';
import type { MemoryToolsDeps } from './types.js';
import { log } from '../../../logger.js';
import { mcpToolError } from '../mcpToolError.js';
import { redactError } from '../../../security/logRedact.js';

export function registerMarkStaleTool(mcpServer: McpServer, deps: MemoryToolsDeps): void {
    mcpServer.tool(
        'mark_stale',
        'Mark all LoreNodes stale whose tags field contains ANY of the provided tags. Use after significant codebase changes to flag orientation-pack or other knowledge nodes that may be out of date. Stale nodes surface stale_warning:true in recall/search results so AI callers know to verify before trusting the content.',
        {
            tags: z.array(z.string()).min(1).describe('Tags to match — any node whose tags list contains ANY of these values (exact membership, case-insensitive) will be marked stale. Example: ["orientation-pack"] marks every node whose tags include "orientation-pack". Pass 2 (2026-06-24): the column is STRING[]; substring matching was dropped.'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1b: no silent fallback).'),
        },
        async ({ tags, workspace: _ws }) => {
            // NW-5b — audit-coverage. mark_stale is a bulk mutator —
            // the audit row records the tag-set rather than a single id.
            const __auditStartedAt = Date.now();
            const __auditCtx: { workspace: string | null; resultDetail?: string; errored: boolean } = {
                workspace: _ws ?? null, errored: false,
            };
            try {
                if (!_ws || typeof _ws !== 'string' || _ws.length === 0) {
                    __auditCtx.errored = true;
                    __auditCtx.resultDetail = 'workspace_required';
                    return workspaceRequiredEnvelope();
                }
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(_ws, 'write');
                if (scopeDenied) { __auditCtx.errored = true; __auditCtx.resultDetail = 'scope_denied'; return scopeDenied; }
                // Local-mode (Postgres model) routing: mark_stale is a bulk
                // graph mutator, so it MUST land in the REQUESTED workspace's
                // graph rather than the boot/active store. Resolve via the
                // multi-workspace registry (mirrors delete_node). When the
                // registry is absent (cloud / tests) the resolver returns the
                // boot store, so behavior is unchanged on that path.
                const resolvedGraph = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope.workspace,
                    _ws,
                );
                if (!resolvedGraph.ok) {
                    __auditCtx.errored = true;
                    if ('missing' in resolvedGraph) {
                        __auditCtx.resultDetail = 'workspace_required';
                        return workspaceRequiredEnvelope();
                    }
                    __auditCtx.resultDetail = 'workspace_not_found';
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                error: 'workspace_not_found',
                                requested: resolvedGraph.requested,
                                known: resolvedGraph.known,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                __auditCtx.workspace = resolvedGraph.resolvedWorkspace;
                const marked = await resolvedGraph.graph.markStaleByTags(tags);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ marked, tags, ok: true }, null, 2),
                    }],
                };
            } catch (error) {
                __auditCtx.errored = true;
                // F-T05 — redact before the message lands in audit.jsonl (engines
                // echo ids/paths/content); mirrors the embedded-write audit path.
                __auditCtx.resultDetail = redactError(error);
                return mcpToolError('mark_stale', error, log);
            } finally {
                try {
                    deps.auditLog.log({
                        toolName: 'mark_stale',
                        args: { workspace: __auditCtx.workspace, tags },
                        result: __auditCtx.errored ? 'error' : 'success',
                        resultDetail: __auditCtx.resultDetail,
                        durationMs: Date.now() - __auditStartedAt,
                    });
                } catch (logErr) {
                    console.error(`[Lore MCP] audit emission failed for mark_stale: ${(logErr as Error).message}`);
                }
            }
        },
    );
}

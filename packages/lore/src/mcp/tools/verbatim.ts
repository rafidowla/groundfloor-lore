/**
 * verbatim.ts — Verbatim-store MCP tools (Lore Core).
 *
 * Per `lore-build-priority-order-2026-05-09` step #5a, these are the
 * universal Core skills DEF/Loom (and any other consumer) calls to
 * read/write the verbatim layer directly — distinct from `store_node`
 * which writes the graph node + a verbatim seed in one shot.
 *
 * Tools:
 *   - store_verbatim   — direct insert/update of a verbatim row
 *   - search_verbatim  — hybrid (BM25 + vector) verbatim search
 *   - get_verbatim     — fetch a verbatim row by id
 *
 * Wire-format note: tool args are MCP-flat strings. The verbatim layer
 * accepts the legacy `{ metadata: {...} }` shape today; tool callers
 * pass the contract-shaped flat fields and we translate at the
 * boundary so the wire stays stable when VerbatimStore eventually
 * collapses onto IVerbatimStore.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageBundle } from '../services.js';
import type { VerbatimStore } from '../../engines/verbatimStore.js';
import { redactError } from '../../security/logRedact.js';
import { assertMcpScope } from './mcpScope.js';
import { assertSafeVerbatimId } from '../../engines/verbatimHistory.js';
import { hybridVerbatimSearch } from '../../engines/verbatimHybridSearch.js';

/** Hit shape both scorers return on this surface (providers' verbatim row). */
type VerbatimSearchHit = { id: string; score: number; text: string; metadata: Record<string, unknown> | null };

/** Thrown by getWorkspacePath (via the resolver) when the name is
 *  unknown — message-prefixed `workspace_not_found:`. The verbatim
 *  resolver does not wrap it in WorkspaceNotFoundError, so detect by
 *  prefix to surface the same `workspace_not_found` envelope the graph
 *  tools return. */
function isWorkspaceNotFound(err: unknown): boolean {
    return err instanceof Error && err.message.startsWith('workspace_not_found:');
}

export interface VerbatimToolsDeps {
    store: StorageBundle;
    /**
     * L-025/L-026 — per-workspace VerbatimStore resolver. When wired, the
     * verbatim read/write tools route through the REQUESTED workspace's
     * LanceDB instead of the boot-bound global store (the gap the resolver
     * was built to close for the outbox replicator). Optional so cloud
     * mode (resolver undefined) and test fixtures that don't wire it keep
     * the boot-singleton fallback — same back-compat discipline as
     * graphRegistry being optional in the search tools.
     */
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<VerbatimStore> };
}

export function registerVerbatimTools(mcpServer: McpServer, deps: VerbatimToolsDeps): void {
    /* ─── store_verbatim ──────────────────────────────────────── */
    mcpServer.tool(
        'store_verbatim',
        'Insert or update a verbatim document directly (raw text + provenance). For graph-node-with-verbatim, use store_node instead.',
        {
            id: z.string().describe('Stable id (typically a content hash or canonical url). Re-storing the same id is an idempotent update.'),
            text: z.string().describe('Document text. BM25 + vector indexed.'),
            source: z.string().optional().describe('Where this came from (e.g. "gmail:msg-abc123", "file:/Users/x/foo.pdf").'),
            label: z.string().optional().describe('Human-readable label (subject line, file basename).'),
            tags: z.string().optional().describe('Comma-separated tag string for ad-hoc grouping.'),
            sourceCreatedAt: z.string().optional().describe('ISO 8601 timestamp of original document creation.'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async (args) => {
            try {
                if (!args.workspace || typeof args.workspace !== 'string' || args.workspace.length === 0) {
                    return { content: [{ type: 'text', text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(args.workspace, 'write');
                if (scopeDenied) return scopeDenied;
                // 2.5 — reject 'lore:' (node-derived namespace) + '#rev' (internal
                // revision suffix); a direct verbatim write must not overwrite a
                // node's canonical row or forge its revision history.
                assertSafeVerbatimId(args.id, 'store_verbatim');
                const doc = {
                    id: args.id,
                    text: args.text,
                    metadata: {
                        type: args.source,
                        label: args.label,
                        tags: args.tags,
                        updatedAt: args.sourceCreatedAt,
                    },
                };
                // L-026 — write to the REQUESTED workspace's LanceDB via the
                // resolver, not the boot-bound store. Fallback to the boot
                // singleton when no resolver (cloud/tests).
                if (deps.workspaceVerbatimResolver) {
                    try {
                        const ws = await deps.workspaceVerbatimResolver.getOrOpen(args.workspace);
                        await ws.store(doc);
                    } catch (err) {
                        if (isWorkspaceNotFound(err)) {
                            return { content: [{ type: 'text', text: JSON.stringify({ error: 'workspace_not_found', requested: args.workspace }) }], isError: true };
                        }
                        throw err;
                    }
                } else {
                    await deps.store.storageClient.verbatimStore(doc);
                }
                return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: args.id }) }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `store_verbatim failed: ${redactError(err)}` }], isError: true };
            }
        },
    );

    /* ─── search_verbatim ─────────────────────────────────────── */
    mcpServer.tool(
        'search_verbatim',
        'Hybrid (BM25 + vector) search across verbatim documents. Returns ranked rows with id, score, text, source.',
        {
            query: z.string().describe('Free-text query.'),
            limit: z.number().int().positive().max(100).optional().describe('Max rows. Default 10.'),
            includeText: z.boolean().optional().describe('When false, omit full text; return snippet only. Default true.'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async (args) => {
            try {
                if (!args.workspace || typeof args.workspace !== 'string' || args.workspace.length === 0) {
                    return { content: [{ type: 'text', text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(args.workspace, 'read');
                if (scopeDenied) return scopeDenied;
                const limit = args.limit ?? 10;
                // L-025 — read from the REQUESTED workspace's LanceDB via the
                // resolver, not the boot-bound store. Fallback to the boot
                // singleton when no resolver (cloud/tests).
                // Cluster-5 medium (2026-08-18) — the description said
                // "Hybrid (BM25 + vector)" but only the vector half ever ran.
                // Both scorers now run and fuse (RRF, fail-closed on an
                // unranked BM25 fallback) — same fusion the recall seed pass
                // uses. Scores are normalized RRF (0..1).
                let hits;
                if (deps.workspaceVerbatimResolver) {
                    try {
                        const ws = await deps.workspaceVerbatimResolver.getOrOpen(args.workspace);
                        hits = await hybridVerbatimSearch<VerbatimSearchHit>(ws as never, args.query, limit);
                    } catch (err) {
                        if (isWorkspaceNotFound(err)) {
                            return { content: [{ type: 'text', text: JSON.stringify({ error: 'workspace_not_found', requested: args.workspace }) }], isError: true };
                        }
                        throw err;
                    }
                } else {
                    hits = await hybridVerbatimSearch<VerbatimSearchHit>({
                        search: (q: string, l: number) => deps.store.storageClient.verbatimSearch(q, l),
                        bm25Search: (q: string, l: number) => deps.store.storageClient.verbatimBm25Search(q, l),
                    } as never, args.query, limit);
                }
                const includeText = args.includeText ?? true;
                const rows = hits.map(f => ({
                    id: f.hit.id,
                    score: f.score,
                    text: includeText ? f.hit.text : undefined,
                    snippet: includeText ? undefined : f.hit.text.slice(0, 240),
                    source: (f.hit.metadata as Record<string, unknown> | null | undefined)?.['type'],
                    label: (f.hit.metadata as Record<string, unknown> | null | undefined)?.['label'],
                    matchedBy: f.matchedBy,
                }));
                return { content: [{ type: 'text', text: JSON.stringify({ rows }) }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `search_verbatim failed: ${redactError(err)}` }], isError: true };
            }
        },
    );

    /* ─── get_verbatim ────────────────────────────────────────── */
    mcpServer.tool(
        'get_verbatim',
        'Fetch a verbatim row by id. Returns null if absent.',
        {
            id: z.string().describe('Verbatim row id.'),
            contentOnly: z.boolean().optional().describe('When true, return just text (skip contentHash). Cheaper. Default false.'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async (args) => {
            try {
                if (!args.workspace || typeof args.workspace !== 'string' || args.workspace.length === 0) {
                    return { content: [{ type: 'text', text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(args.workspace, 'read');
                if (scopeDenied) return scopeDenied;
                // L-025 — resolve the REQUESTED workspace's verbatim store
                // for the getById read; fallback to the boot singleton when
                // no resolver (cloud/tests).
                let inner = deps.store.loreVerbatim as { getById?: (id: string) => Promise<{ text?: string; contentHash?: string } | null> };
                if (deps.workspaceVerbatimResolver) {
                    try {
                        inner = await deps.workspaceVerbatimResolver.getOrOpen(args.workspace) as unknown as typeof inner;
                    } catch (err) {
                        if (isWorkspaceNotFound(err)) {
                            return { content: [{ type: 'text', text: JSON.stringify({ error: 'workspace_not_found', requested: args.workspace }) }], isError: true };
                        }
                        throw err;
                    }
                }
                if (typeof inner.getById !== 'function') {
                    return { content: [{ type: 'text', text: 'get_verbatim not supported by current verbatim backend' }], isError: true };
                }
                const r = await inner.getById(args.id);
                if (!r) {
                    return { content: [{ type: 'text', text: JSON.stringify({ row: null }) }] };
                }
                const row = args.contentOnly
                    ? { id: args.id, text: r.text }
                    : { id: args.id, text: r.text, contentHash: r.contentHash };
                return { content: [{ type: 'text', text: JSON.stringify({ row }) }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `get_verbatim failed: ${redactError(err)}` }], isError: true };
            }
        },
    );
}

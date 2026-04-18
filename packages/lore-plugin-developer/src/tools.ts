/**
 * developer/tools.ts — Register the 10 developer-plugin MCP tools.
 *
 * Called by ILorePlugin.registerTools(server, ctx) only when the
 * developer plugin is active in the workspace. The tools reach the
 * graph through DeveloperApi; core server has no knowledge of them.
 *
 * Tools:
 *   code_query, code_context, link_knowledge_to_code
 *   gitnexus_query, gitnexus_context, gitnexus_impact, gitnexus_cypher
 *   list_repos, detect_changes, rename
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PluginContext } from '@lore-core/plugins/types.js';
import type { DeveloperApi } from './api.js';
import { proxyQuery, proxyContext, proxyImpact, proxyCypher } from './gitnexusProxy.js';
import { detectChanges, rename, listRepos, formatReposMarkdown } from './nativeTools.js';

interface WalLike {
    append(op: string, data: unknown): void;
}

interface SyncEngineLike {
    getWal(): WalLike;
}

export function registerDeveloperTools(
    server: McpServer,
    api: DeveloperApi,
    ctx: PluginContext,
): void {
    // WAL access via ctx.syncEngine — the WAL is core infrastructure
    // (offline-first sync lives in the core engine); plugins write to
    // it via this narrow cast rather than importing the engine directly.
    const wal = (ctx.syncEngine as SyncEngineLike | null)?.getWal?.();

    /* ─── code_query ───────────────────────────────────────────── */
    server.tool(
        'code_query',
        'Search code symbols by name or file path. Returns functions, classes, methods, and interfaces from the unified graph.',
        {
            query: z.string().describe('Search term — matched against symbol name and file path'),
            repo: z.string().optional().describe('Optional: filter by repository name'),
            limit: z.number().optional().describe('Maximum results (default: 20)'),
        },
        async ({ query, repo, limit }) => {
            try {
                const results = await api.queryCodeSymbols(query, repo, limit ?? 20);
                if (results.length === 0) {
                    return {
                        content: [{ type: 'text' as const, text: `No code symbols found matching "${query}". Run "lore index" to import code from GitNexus.` }],
                    };
                }
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            count: results.length,
                            symbols: results.map((s) => ({ uid: s.uid, name: s.name, kind: s.kind, filePath: s.filePath, line: `${s.startLine}-${s.endLine}`, repo: s.repo })),
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
            }
        },
    );

    /* ─── code_context ─────────────────────────────────────────── */
    server.tool(
        'code_context',
        '360° view of a code symbol — shows callers, callees, and connected knowledge nodes (decisions, conventions, bugs)',
        { uid: z.string().describe('CodeSymbol UID from a prior code_query result') },
        async ({ uid }) => {
            try {
                const context = await api.getCodeSymbolContext(uid);
                if (!context.symbol) {
                    return { content: [{ type: 'text' as const, text: `No code symbol found with UID "${uid}".` }] };
                }
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            symbol: {
                                uid: context.symbol.uid,
                                name: context.symbol.name,
                                kind: context.symbol.kind,
                                filePath: context.symbol.filePath,
                                line: `${context.symbol.startLine}-${context.symbol.endLine}`,
                                repo: context.symbol.repo,
                            },
                            callers: context.callers.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath })),
                            callees: context.callees.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath })),
                            knowledge: context.knowledge.map((k) => ({ id: k.id, type: k.type, label: k.label })),
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
            }
        },
    );

    /* ─── link_knowledge_to_code ───────────────────────────────── */
    server.tool(
        'link_knowledge_to_code',
        'Create a cross-pillar edge linking a knowledge node (decision, convention, bug) to a code symbol. Enables queries like "what decisions affect this function?"',
        {
            nodeId: z.string().describe('LoreNode ID'),
            symbolUid: z.string().describe('CodeSymbol UID from a prior code_query result'),
            relation: z.string().optional().describe('Relationship type (default: "applies_to")'),
        },
        async ({ nodeId, symbolUid, relation }) => {
            try {
                const resolved = relation ?? 'applies_to';
                await api.linkKnowledgeToCode(nodeId, symbolUid, resolved);
                wal?.append('link_knowledge_to_code', { nodeId, symbolUid, relation: resolved });
                return { content: [{ type: 'text' as const, text: `Linked knowledge "${nodeId}" → code "${symbolUid}" (${resolved})` }] };
            } catch (err) {
                return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
            }
        },
    );

    /* ─── gitnexus proxy tools ─────────────────────────────────── */
    server.tool(
        'gitnexus_query',
        'Search code execution flows using GitNexus (BM25 + semantic vector search)',
        {
            query: z.string().describe('Natural language or keyword search query'),
            repo: z.string().optional().describe('Target repository name'),
            goal: z.string().optional().describe('What you want to find — helps ranking'),
        },
        async ({ query, repo, goal }) => {
            const result = proxyQuery(query, repo, goal);
            return { content: [{ type: 'text' as const, text: result.text }], isError: !result.success };
        },
    );

    server.tool(
        'gitnexus_context',
        '360° view of a code symbol: callers, callees, processes, imports (via GitNexus)',
        {
            name: z.string().describe('Symbol name'),
            repo: z.string().optional().describe('Target repository name'),
        },
        async ({ name, repo }) => {
            const result = proxyContext(name, repo);
            return { content: [{ type: 'text' as const, text: result.text }], isError: !result.success };
        },
    );

    server.tool(
        'gitnexus_impact',
        'Blast radius analysis: what breaks if you change a symbol (via GitNexus)',
        {
            target: z.string().describe('Symbol or file to analyze'),
            repo: z.string().optional().describe('Target repository name'),
            direction: z.string().optional().describe('"upstream" (what depends on this) or "downstream"'),
        },
        async ({ target, repo, direction }) => {
            const result = proxyImpact(target, repo, direction);
            return { content: [{ type: 'text' as const, text: result.text }], isError: !result.success };
        },
    );

    server.tool(
        'gitnexus_cypher',
        'Execute raw Cypher query against the GitNexus code knowledge graph',
        {
            query: z.string().describe('Cypher query to execute'),
            repo: z.string().optional().describe('Target repository name'),
        },
        async ({ query, repo }) => {
            const result = proxyCypher(query, repo);
            return { content: [{ type: 'text' as const, text: result.text }], isError: !result.success };
        },
    );

    /* ─── list_repos ───────────────────────────────────────────── */
    server.tool(
        'list_repos',
        'List all repositories indexed by GitNexus',
        {},
        async () => {
            try {
                const repos = listRepos();
                return { content: [{ type: 'text' as const, text: formatReposMarkdown(repos) }] };
            } catch (err) {
                return { content: [{ type: 'text' as const, text: `Failed to list repos: ${(err as Error).message}` }], isError: true };
            }
        },
    );

    /* ─── detect_changes ───────────────────────────────────────── */
    server.tool(
        'detect_changes',
        'Analyze uncommitted git changes and find affected code symbols in the knowledge graph',
        {
            repo_path: z.string().optional().describe('Path to git repository (default: cwd)'),
            scope: z.enum(['unstaged', 'staged', 'all']).optional().describe('Which changes to detect (default: unstaged)'),
        },
        async ({ repo_path, scope }) => {
            try {
                const repoPath = repo_path ?? process.cwd();
                const result = await detectChanges(api, repoPath, scope ?? 'unstaged');
                const lines: string[] = [`## Uncommitted Changes (${result.totalFilesChanged} files)`, ''];
                if (result.changedSymbols.length > 0) {
                    lines.push(`### Affected Symbols (${result.changedSymbols.length})`, '');
                    lines.push('| Symbol | Kind | File | Change |', '|---|---|---|---|');
                    for (const s of result.changedSymbols) {
                        lines.push(`| ${s.name} | ${s.kind} | ${s.filePath} | ${s.changeType} |`);
                    }
                }
                if (result.unmappedFiles.length > 0) {
                    lines.push('', `### Unmapped Files (${result.unmappedFiles.length})`, '');
                    for (const f of result.unmappedFiles) lines.push(`- ${f}`);
                }
                if (result.totalFilesChanged === 0) lines.push('No uncommitted changes detected.');
                return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text' as const, text: `Failed: ${(err as Error).message}` }], isError: true };
            }
        },
    );

    /* ─── rename ───────────────────────────────────────────────── */
    server.tool(
        'rename',
        'Multi-file coordinated rename using knowledge graph + text search. Preview by default (dry_run=true).',
        {
            symbol_name: z.string().describe('Current symbol name to rename'),
            new_name: z.string().describe('The new name for the symbol'),
            repo_path: z.string().optional().describe('Path to repository root'),
            dry_run: z.boolean().optional().describe('Preview without applying (default: true)'),
        },
        async ({ symbol_name, new_name, repo_path, dry_run }) => {
            try {
                const repoPath = repo_path ?? process.cwd();
                const isDryRun = dry_run ?? true;
                const result = await rename(api, symbol_name, new_name, repoPath, isDryRun);
                const lines: string[] = [
                    `## Rename: ${symbol_name} → ${new_name}`,
                    `**Mode:** ${isDryRun ? 'Preview (dry run)' : 'Applied'}`,
                    `**Files affected:** ${result.filesAffected}`,
                    `**Total edits:** ${result.edits.length}`,
                    '',
                ];
                if (result.edits.length > 0) {
                    lines.push('| File | Line | Confidence |', '|---|---|---|');
                    for (const edit of result.edits) {
                        const relPath = edit.filePath.replace(repoPath + '/', '');
                        lines.push(`| ${relPath} | L${edit.line} | ${edit.source} |`);
                    }
                } else {
                    lines.push('No references found for this symbol.');
                }
                return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
            } catch (err) {
                return { content: [{ type: 'text' as const, text: `Rename failed: ${(err as Error).message}` }], isError: true };
            }
        },
    );
}

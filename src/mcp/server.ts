#!/usr/bin/env node
/**
 * server.ts — Unified Groundfloor Lore MCP Server.
 *
 * Purpose:
 *   Exposes the unified Kùzu knowledge graph as an MCP server over stdio.
 *   Combines institutional knowledge (decisions, conventions, bugs) and
 *   code intelligence into a single MCP tool surface.
 *
 * Architecture:
 *   Uses @modelcontextprotocol/sdk for stdio transport.
 *   Delegates storage to LocalGraph (Kùzu embedded graph).
 *   Each tool maps to one or more graph operations.
 *
 * MCP Tools:
 *   Knowledge: store_node, store_edge, traverse, search, recall,
 *              delete_node, list_nodes, stats, register_project
 *
 * Transport: stdio (stdin/stdout)
 * Error Behavior: Returns MCP error responses; does not crash the server.
 * Side Effects: Reads/writes .lore/graph/ via LocalGraph.
 * Determinism: Non-deterministic (depends on database state).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LocalGraph, type LoreNode } from '../engines/localGraph.js';
import { SyncEngine, WriteAheadLog } from '../engines/syncEngine.js';
import { SurrealAdapter } from '../engines/surrealAdapter.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { proxyQuery, proxyContext, proxyImpact, proxyCypher } from './gitnexusProxy.js';
import { detectChanges, rename, listRepos, formatReposMarkdown } from './nativeTools.js';

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * ProjectMapping — Maps a project name to its ecosystem and workspace paths.
 */
interface ProjectMapping {
    ecosystem: string;
    paths: string[];
}

/**
 * ProjectRegistry — Workspace-to-project configuration.
 * Loaded from ~/.groundfloor/projects.json.
 */
interface ProjectRegistry {
    projects: Record<string, ProjectMapping>;
}

/**
 * ResolvedScope — Auto-detected project and ecosystem for this workspace.
 */
interface ResolvedScope {
    project: string;
    ecosystem: string;
}

/* ─── Project Auto-Detection ──────────────────────────────────── */

/**
 * loadProjectRegistry — Reads project registry from disk.
 *
 * Inputs: None (reads ~/.groundfloor/projects.json).
 * Outputs: ProjectRegistry or empty registry on error.
 * Side Effects: File read.
 * Error Behavior: Returns empty registry on file not found or parse error.
 */
function loadProjectRegistry(): ProjectRegistry {
    const registryPath = path.join(os.homedir(), '.groundfloor', 'projects.json');
    try {
        const rawContent = fs.readFileSync(registryPath, 'utf-8');
        return JSON.parse(rawContent) as ProjectRegistry;
    } catch {
        return { projects: {} };
    }
}

/**
 * resolveProjectScope — Detects project/ecosystem from CWD.
 *
 * Matches process.cwd() against path fragments in the registry.
 * Returns '*' if no match found.
 */
function resolveProjectScope(): ResolvedScope {
    const currentWorkingDirectory = process.cwd();
    const registry = loadProjectRegistry();

    for (const [projectName, mapping] of Object.entries(registry.projects)) {
        for (const pathFragment of mapping.paths) {
            if (currentWorkingDirectory.includes(pathFragment)) {
                return { project: projectName, ecosystem: mapping.ecosystem };
            }
        }
    }

    return { project: '*', ecosystem: '*' };
}

/**
 * resolveGraphPath — Determines where to create the .lore/ graph directory.
 *
 * Priority: 1) Git repo root, 2) CWD, 3) ~/.groundfloor/
 */
function resolveGraphPath(): string {
    // Always use the global ~/.groundfloor path.
    // This ensures the same graph is accessible regardless of which
    // IDE/tool starts the MCP server (Cursor, Antigravity, CLI, etc.)
    return path.join(os.homedir(), '.groundfloor');
}

/* ─── Server Setup ────────────────────────────────────────────── */

const detectedScope = resolveProjectScope();
const graphBasePath = resolveGraphPath();
const graph = new LocalGraph(graphBasePath);
const loreDir = path.join(graphBasePath, '.lore');

/**
 * resolveSyncAdapter — Auto-detect SurrealDB and create an adapter.
 *
 * Priority:
 *   1. SURREAL_URL + SURREAL_PASS env vars (explicit config)
 *   2. Fallback to localhost:8000 with password from infra/surrealdb/.env
 *   3. Returns null if no credentials found (offline mode)
 *
 * Side Effects: Reads env vars and optionally infra/.env file.
 * Determinism: Deterministic for a given environment.
 */
function resolveSyncAdapter(): SurrealAdapter | null {
    let url = process.env['SURREAL_URL'];
    const username = process.env['SURREAL_USER'] ?? 'root';
    const orgId = process.env['SURREAL_ORG_ID'] ?? 'default';
    const namespace = process.env['SURREAL_NAMESPACE'] ?? 'groundfloor';
    const database = process.env['SURREAL_DATABASE'] ?? 'lore';

    // Check env var first, then try local infra/.env
    let password = process.env['SURREAL_PASS'];
    if (!password) {
        try {
            const envPath = path.join(graphBasePath, 'infra', 'surrealdb', '.env');
            const envContent = fs.readFileSync(envPath, 'utf-8');

            // Parse all key=value pairs from .env
            const passMatch = envContent.match(/SURREAL_ROOT_PASS=(.+)/);
            if (passMatch) {
                password = passMatch[1].trim();
            }
            if (!url) {
                const urlMatch = envContent.match(/SURREAL_URL=(.+)/);
                if (urlMatch) {
                    url = urlMatch[1].trim();
                }
            }
        } catch {
            // No local .env — stay offline
        }
    }

    if (!password) return null;
    if (!url) url = 'ws://127.0.0.1:8001/rpc';

    return new SurrealAdapter({ url, namespace, database, username, password, orgId });
}

const adapter = resolveSyncAdapter();
const syncEngine = new SyncEngine(graph, loreDir, adapter);
const wal = syncEngine.getWal();

const server = new McpServer({
    name: 'groundfloor-lore',
    version: '1.0.0',
});

/* ─── Tool: store_node ────────────────────────────────────────── */

server.tool(
    'store_node',
    'Create or update a knowledge node (decision, convention, bug pattern, etc.)',
    {
        id: z.string().describe('Unique identifier (e.g., "baas-body-stream-fix")'),
        type: z.enum(['decision', 'convention', 'bug_pattern', 'file_ref', 'architecture', 'troubleshooting', 'note'])
            .describe('Node type'),
        label: z.string().describe('Human-readable title'),
        content: z.string().optional().describe('Full text content'),
        tags: z.string().optional().describe('Comma-separated tags (e.g., "platform,baasclient,error-handling")'),
        metadata: z.string().optional().describe('JSON metadata (e.g., {"date":"2026-03-25","author":"team"})'),
        project: z.string().optional().describe('Project scope (auto-detected from workspace if omitted)'),
        ecosystem: z.string().optional().describe('Ecosystem scope (auto-detected from workspace if omitted)'),
    },
    async ({ id, type, label, content, tags, metadata, project, ecosystem }) => {
        try {
            const scopedProject = project ?? detectedScope.project;
            const scopedEcosystem = ecosystem ?? detectedScope.ecosystem;

            const node = await graph.upsertNode({
                id,
                type,
                label,
                content: content ?? '',
                tags: tags ?? '',
                project: scopedProject,
                ecosystem: scopedEcosystem,
                metadata: metadata ?? '{}',
            });

            // Buffer write to WAL for async sync
            wal.append('upsert_node', { ...node });

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        node: { id: node.id, type: node.type, label: node.label, project: scopedProject, ecosystem: scopedEcosystem },
                        message: `Node '${id}' stored successfully (project: ${scopedProject}, ecosystem: ${scopedEcosystem}).`,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: store_edge ────────────────────────────────────────── */

server.tool(
    'store_edge',
    'Create a relationship between two knowledge nodes',
    {
        sourceId: z.string().describe('Source node ID'),
        targetId: z.string().describe('Target node ID'),
        relation: z.enum(['decided_for', 'caused_by', 'applies_to', 'fixed_by', 'supersedes', 'related_to', 'depends_on'])
            .describe('Relationship type'),
        bidirectional: z.boolean().optional().describe('Create edge in both directions (default: true)'),
    },
    async ({ sourceId, targetId, relation, bidirectional }) => {
        try {
            const useBidirectional = bidirectional ?? true;

            if (useBidirectional) {
                await graph.addBidirectionalEdge({ sourceId, targetId, relation });
            } else {
                await graph.addEdge({ sourceId, targetId, relation });
            }

            // Buffer write to WAL for async sync
            wal.append('add_edge', { sourceId, targetId, relation });

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        edge: { sourceId, targetId, relation, bidirectional: useBidirectional },
                        message: `Edge '${sourceId}' ${useBidirectional ? '↔' : '→'} '${targetId}' (${relation}) created.`,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: traverse ──────────────────────────────────────────── */

server.tool(
    'traverse',
    'Follow graph edges from a starting node to find all connected knowledge',
    {
        nodeId: z.string().describe('Starting node ID'),
        depth: z.number().optional().describe('Max traversal depth (default: 2, max: 5)'),
    },
    async ({ nodeId, depth }) => {
        try {
            const startNode = await graph.getNode(nodeId);
            if (!startNode) {
                return {
                    content: [{ type: 'text' as const, text: `Node '${nodeId}' not found.` }],
                    isError: true,
                };
            }

            const results = await graph.traverse(nodeId, depth ?? 2);

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        startNode: { id: startNode.id, type: startNode.type, label: startNode.label },
                        connectedNodes: results.length,
                        results: results.map((item) => ({
                            depth: item.depth,
                            relation: item.relation,
                            id: item.node.id,
                            type: item.node.type,
                            label: item.node.label,
                            content: item.node.content,
                            tags: item.node.tags,
                        })),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: search ────────────────────────────────────────────── */

server.tool(
    'search',
    'Full-text search across all knowledge nodes',
    {
        query: z.string().describe('Search query'),
        limit: z.number().optional().describe('Max results (default: 20)'),
    },
    async ({ query, limit }) => {
        try {
            const results = await graph.search(query, limit ?? 20, detectedScope.project, detectedScope.ecosystem);

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        query,
                        scope: { project: detectedScope.project, ecosystem: detectedScope.ecosystem },
                        resultCount: results.length,
                        results: results.map((node) => ({
                            id: node.id, type: node.type, label: node.label,
                            content: node.content, tags: node.tags, project: node.project,
                        })),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: recall ────────────────────────────────────────────── */

server.tool(
    'recall',
    'High-level knowledge recall: searches for a topic and traverses related nodes',
    {
        topic: z.string().describe('Topic to recall (e.g., "BaaSClient", "auth conventions")'),
        depth: z.number().optional().describe('Traversal depth from each search result (default: 1)'),
    },
    async ({ topic, depth }) => {
        try {
            const searchResults = await graph.search(topic, 10, detectedScope.project, detectedScope.ecosystem);

            if (searchResults.length === 0) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            topic,
                            scope: { project: detectedScope.project, ecosystem: detectedScope.ecosystem },
                            message: `No knowledge found for topic '${topic}'.`,
                            results: [],
                        }, null, 2),
                    }],
                };
            }

            const traversalDepth = depth ?? 1;
            const allNodes = new Map<string, { node: LoreNode; source: string; depth: number }>();

            for (const node of searchResults) {
                allNodes.set(node.id, { node, source: 'search', depth: 0 });
            }

            for (const searchNode of searchResults) {
                const connected = await graph.traverse(searchNode.id, traversalDepth);
                for (const item of connected) {
                    if (!allNodes.has(item.node.id)) {
                        allNodes.set(item.node.id, {
                            node: item.node,
                            source: `via ${searchNode.id}`,
                            depth: item.depth,
                        });
                    }
                }
            }

            const recalledNodes = Array.from(allNodes.values())
                .sort((nodeA, nodeB) => nodeA.depth - nodeB.depth);

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        topic,
                        scope: { project: detectedScope.project, ecosystem: detectedScope.ecosystem },
                        totalRecalled: recalledNodes.length,
                        directMatches: searchResults.length,
                        connectedMatches: recalledNodes.length - searchResults.length,
                        knowledge: recalledNodes.map((item) => ({
                            id: item.node.id, type: item.node.type, label: item.node.label,
                            content: item.node.content, tags: item.node.tags,
                            project: item.node.project, source: item.source,
                        })),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: delete_node ───────────────────────────────────────── */

server.tool(
    'delete_node',
    'Remove a knowledge node and all its relationships',
    {
        id: z.string().describe('Node ID to delete'),
    },
    async ({ id }) => {
        try {
            const deleted = await graph.deleteNode(id);
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        deleted,
                        message: deleted ? `Node '${id}' deleted.` : `Node '${id}' not found.`,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: list_nodes ────────────────────────────────────────── */

server.tool(
    'list_nodes',
    'List all knowledge nodes, optionally filtered by type or tag',
    {
        type: z.enum(['decision', 'convention', 'bug_pattern', 'file_ref', 'architecture', 'troubleshooting', 'note'])
            .optional().describe('Filter by node type'),
        tag: z.string().optional().describe('Filter by tag'),
    },
    async ({ type, tag }) => {
        try {
            const nodes = await graph.listNodes(type, tag, detectedScope.project, detectedScope.ecosystem);
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        count: nodes.length,
                        scope: { project: detectedScope.project, ecosystem: detectedScope.ecosystem },
                        filter: { type: type ?? 'all', tag: tag ?? 'all' },
                        nodes: nodes.map((node) => ({
                            id: node.id, type: node.type, label: node.label,
                            tags: node.tags, project: node.project, updatedAt: node.updatedAt,
                        })),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: register_project ──────────────────────────────────── */

server.tool(
    'register_project',
    'Register a new project in the Lore project registry.',
    {
        name: z.string().describe('Project name (e.g., "videosnap", "tenant-coi")'),
        ecosystem: z.string().describe('Ecosystem group (e.g., "groundfloor")'),
        paths: z.array(z.string()).describe('Workspace path fragments to match'),
    },
    async ({ name, ecosystem, paths: pathFragments }) => {
        try {
            const registryPath = path.join(os.homedir(), '.groundfloor', 'projects.json');
            let registry: ProjectRegistry;

            try {
                const rawContent = fs.readFileSync(registryPath, 'utf-8');
                registry = JSON.parse(rawContent) as ProjectRegistry;
            } catch {
                registry = { projects: {} };
            }

            const alreadyExists = name in registry.projects;
            registry.projects[name] = { ecosystem, paths: pathFragments };

            fs.mkdirSync(path.dirname(registryPath), { recursive: true });
            fs.writeFileSync(registryPath, JSON.stringify(registry, null, 4) + '\n', 'utf-8');

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        action: alreadyExists ? 'updated' : 'registered',
                        project: { name, ecosystem, paths: pathFragments },
                        message: `Project '${name}' ${alreadyExists ? 'updated' : 'registered'} in ecosystem '${ecosystem}'.`,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: stats ─────────────────────────────────────────────── */

server.tool(
    'stats',
    'Get knowledge graph statistics (node count, edge count, type breakdown)',
    {},
    async () => {
        try {
            const graphStats = await graph.getStats();
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        ...graphStats,
                        graphPath: path.join(graphBasePath, '.lore', 'graph'),
                        engine: 'kùzu',
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: who_is_working ─────────────────────────────────────── */

server.tool(
    'who_is_working',
    'See team developer activity — who is working on what, filtered by symbol or file',
    {
        symbol: z.string().optional().describe('Filter by symbol name (e.g., "UserService")'),
    },
    async ({ symbol }) => {
        try {
            const syncStatus = syncEngine.getStatus();

            if (!syncStatus.hasAdapter) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            message: 'No remote sync adapter configured — team awareness requires a shared backend (SurrealDB).',
                            hint: 'Configure SURREAL_URL, SURREAL_USER, SURREAL_PASS environment variables to enable team sync.',
                            localStatus: {
                                walPending: syncStatus.walPending,
                                lastSync: syncStatus.lastSync,
                            },
                        }, null, 2),
                    }],
                };
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        message: 'Team awareness is available.',
                        filter: symbol ?? 'all',
                        note: 'Query remote backend for active developers.',
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: sync_status ───────────────────────────────────────── */

server.tool(
    'sync_status',
    'Get the current sync engine status — WAL pending count, last sync time, remote connectivity',
    {},
    async () => {
        try {
            const status = syncEngine.getStatus();

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        walPending: status.walPending,
                        lastSync: status.lastSync === '1970-01-01T00:00:00.000Z' ? 'never' : status.lastSync,
                        remoteConfigured: status.hasAdapter,
                        autoSyncing: status.isAutoSyncing,
                        engine: 'kùzu',
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: code_query ────────────────────────────────────────── */

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
            const results = await graph.queryCodeSymbols(query, repo, limit ?? 20);

            if (results.length === 0) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `No code symbols found matching "${query}". Run "lore index" to import code from GitNexus.`,
                    }],
                };
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        count: results.length,
                        symbols: results.map((symbolResult) => ({
                            uid: symbolResult.uid,
                            name: symbolResult.name,
                            kind: symbolResult.kind,
                            filePath: symbolResult.filePath,
                            line: `${symbolResult.startLine}-${symbolResult.endLine}`,
                            repo: symbolResult.repo,
                        })),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: code_context ──────────────────────────────────────── */

server.tool(
    'code_context',
    '360° view of a code symbol — shows callers, callees, and connected knowledge nodes (decisions, conventions, bugs)',
    {
        uid: z.string().describe('CodeSymbol UID from a prior code_query result'),
    },
    async ({ uid }) => {
        try {
            const context = await graph.getCodeSymbolContext(uid);

            if (!context.symbol) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `No code symbol found with UID "${uid}".`,
                    }],
                };
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
                        callers: context.callers.map((callerSymbol) => ({
                            name: callerSymbol.name,
                            kind: callerSymbol.kind,
                            filePath: callerSymbol.filePath,
                        })),
                        callees: context.callees.map((calleeSymbol) => ({
                            name: calleeSymbol.name,
                            kind: calleeSymbol.kind,
                            filePath: calleeSymbol.filePath,
                        })),
                        knowledge: context.knowledge.map((knowledgeNode) => ({
                            id: knowledgeNode.id,
                            type: knowledgeNode.type,
                            label: knowledgeNode.label,
                        })),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: link_knowledge_to_code ────────────────────────────── */

server.tool(
    'link_knowledge_to_code',
    'Create a cross-pillar edge linking a knowledge node (decision, convention, bug) to a code symbol. Enables queries like "what decisions affect this function?"',
    {
        nodeId: z.string().describe('LoreNode ID (e.g., "baas-body-stream-fix")'),
        symbolUid: z.string().describe('CodeSymbol UID from a prior code_query result'),
        relation: z.string().optional().describe('Relationship type (default: "applies_to")'),
    },
    async ({ nodeId, symbolUid, relation }) => {
        try {
            const resolvedRelation = relation ?? 'applies_to';
            await graph.linkKnowledgeToCode(nodeId, symbolUid, resolvedRelation);

            // Buffer to WAL
            wal.append('link_knowledge_to_code', { nodeId, symbolUid, relation: resolvedRelation });

            return {
                content: [{
                    type: 'text' as const,
                    text: `Linked knowledge "${nodeId}" → code "${symbolUid}" (${resolvedRelation})`,
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── GitNexus Proxy Tools ────────────────────────────────────── */

/**
 * gitnexus_query — Search execution flows related to a concept.
 *
 * Proxies GitNexus's hybrid BM25 + vector search.
 * Returns processes (call chains) ranked by relevance.
 */
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
        return {
            content: [{ type: 'text' as const, text: result.text }],
            isError: !result.success,
        };
    },
);

/**
 * gitnexus_context — 360° view of a code symbol.
 *
 * Shows callers, callees, processes, and file location.
 */
server.tool(
    'gitnexus_context',
    '360° view of a code symbol: callers, callees, processes, imports (via GitNexus)',
    {
        name: z.string().describe('Symbol name (e.g., "validateUser", "AuthService")'),
        repo: z.string().optional().describe('Target repository name'),
    },
    async ({ name, repo }) => {
        const result = proxyContext(name, repo);
        return {
            content: [{ type: 'text' as const, text: result.text }],
            isError: !result.success,
        };
    },
);

/**
 * gitnexus_impact — Blast radius analysis.
 *
 * Returns what would break if you change a symbol.
 * Affected symbols grouped by depth (d=1 WILL BREAK, d=2 LIKELY AFFECTED, d=3 MAY NEED TESTING).
 */
server.tool(
    'gitnexus_impact',
    'Blast radius analysis: what breaks if you change a symbol (via GitNexus)',
    {
        target: z.string().describe('Symbol or file to analyze'),
        repo: z.string().optional().describe('Target repository name'),
        direction: z.string().optional().describe('"upstream" (what depends on this) or "downstream" (what this depends on)'),
    },
    async ({ target, repo, direction }) => {
        const result = proxyImpact(target, repo, direction);
        return {
            content: [{ type: 'text' as const, text: result.text }],
            isError: !result.success,
        };
    },
);

/**
 * gitnexus_cypher — Execute raw Cypher against the code knowledge graph.
 *
 * Full Cypher query access for advanced structural queries.
 */
server.tool(
    'gitnexus_cypher',
    'Execute raw Cypher query against the GitNexus code knowledge graph',
    {
        query: z.string().describe('Cypher query to execute'),
        repo: z.string().optional().describe('Target repository name'),
    },
    async ({ query, repo }) => {
        const result = proxyCypher(query, repo);
        return {
            content: [{ type: 'text' as const, text: result.text }],
            isError: !result.success,
        };
    },
);

/* ─── Native Tools (detect_changes, rename, list_repos) ──────── */

/**
 * list_repos — List all repositories indexed by GitNexus.
 */
server.tool(
    'list_repos',
    'List all repositories indexed by GitNexus',
    {},
    async () => {
        try {
            const repos = listRepos();
            const text = formatReposMarkdown(repos);
            return { content: [{ type: 'text' as const, text }] };
        } catch (listError) {
            return {
                content: [{ type: 'text' as const, text: `Failed to list repos: ${(listError as Error).message}` }],
                isError: true,
            };
        }
    },
);

/**
 * detect_changes — Analyze uncommitted changes and find affected code symbols.
 */
server.tool(
    'detect_changes',
    'Analyze uncommitted git changes and find affected code symbols in the knowledge graph',
    {
        repo_path: z.string().optional().describe('Path to git repository (default: current working directory)'),
        scope: z.enum(['unstaged', 'staged', 'all']).optional().describe('Which changes to detect (default: unstaged)'),
    },
    async ({ repo_path, scope }) => {
        try {
            const repoPath = repo_path ?? process.cwd();
            const result = await detectChanges(graph, repoPath, scope ?? 'unstaged');

            const lines: string[] = [
                `## Uncommitted Changes (${result.totalFilesChanged} files)`,
                '',
            ];

            if (result.changedSymbols.length > 0) {
                lines.push(`### Affected Symbols (${result.changedSymbols.length})`, '');
                lines.push('| Symbol | Kind | File | Change |');
                lines.push('|---|---|---|---|');
                for (const symbol of result.changedSymbols) {
                    lines.push(`| ${symbol.name} | ${symbol.kind} | ${symbol.filePath} | ${symbol.changeType} |`);
                }
            }

            if (result.unmappedFiles.length > 0) {
                lines.push('', `### Unmapped Files (${result.unmappedFiles.length})`, '');
                for (const file of result.unmappedFiles) {
                    lines.push(`- ${file}`);
                }
            }

            if (result.totalFilesChanged === 0) {
                lines.push('No uncommitted changes detected.');
            }

            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        } catch (detectError) {
            return {
                content: [{ type: 'text' as const, text: `Failed: ${(detectError as Error).message}` }],
                isError: true,
            };
        }
    },
);

/**
 * rename — Multi-file coordinated rename using graph + text search.
 */
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
            const result = await rename(graph, symbol_name, new_name, repoPath, isDryRun);

            const lines: string[] = [
                `## Rename: ${symbol_name} → ${new_name}`,
                `**Mode:** ${isDryRun ? '🔍 Preview (dry run)' : '✅ Applied'}`,
                `**Files affected:** ${result.filesAffected}`,
                `**Total edits:** ${result.edits.length}`,
                '',
            ];

            if (result.edits.length > 0) {
                lines.push('| File | Line | Confidence |');
                lines.push('|---|---|---|');
                for (const edit of result.edits) {
                    const relPath = edit.filePath.replace(repoPath + '/', '');
                    lines.push(`| ${relPath} | L${edit.line} | ${edit.source} |`);
                }
            } else {
                lines.push('No references found for this symbol.');
            }

            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        } catch (renameError) {
            return {
                content: [{ type: 'text' as const, text: `Rename failed: ${(renameError as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── MCP Resources ──────────────────────────────────────────── */

/**
 * repos — List all indexed repositories.
 */
server.resource(
    'repos',
    'lore://repos',
    { description: 'All indexed repositories' },
    async () => {
        const repos = listRepos();
        return {
            contents: [{
                uri: 'lore://repos',
                text: formatReposMarkdown(repos),
                mimeType: 'text/markdown',
            }],
        };
    },
);

/**
 * setup — Setup and configuration guide.
 */
server.resource(
    'setup',
    'lore://setup',
    { description: 'Lore setup and configuration guide' },
    async () => {
        const repos = listRepos();
        const status = syncEngine.getStatus();
        const lines: string[] = [
            '# Groundfloor Lore — Setup',
            '',
            '## Status',
            `- **Engine:** Kùzu (local graph)`,
            `- **Repos indexed:** ${repos.length}`,
            `- **Sync:** ${status.hasAdapter ? 'ONLINE' : 'OFFLINE (no SurrealDB)'}`,
            '',
            '## Commands',
            '- `lore init` — Initialize .lore/ directory',
            '- `lore index` — Index code from GitNexus',
            '- `lore doctor` — Health check',
            '- `lore sync` — Push/pull to SurrealDB',
            '',
            '## MCP Tools (21 total)',
            '- 9 knowledge tools (store, search, recall, traverse, ...)',
            '- 3 code bridge tools (code_query, code_context, link_knowledge_to_code)',
            '- 4 GitNexus proxy tools (query, context, impact, cypher)',
            '- 3 native tools (list_repos, detect_changes, rename)',
            '- 2 team tools (who_is_working, sync_status)',
        ];
        return {
            contents: [{
                uri: 'lore://setup',
                text: lines.join('\n'),
                mimeType: 'text/markdown',
            }],
        };
    },
);

/**
 * repo context — Overview of a specific repo's code graph.
 */
server.resource(
    'repo_context',
    'lore://repo/{name}/context',
    { description: 'Repository overview: symbol count, file count, staleness' },
    async (uri) => {
        const repoName = uri.pathname.split('/')[2] ?? '';
        const symbols = await graph.queryCodeSymbols('', repoName, 9999);
        const fileSet = new Set(symbols.map((symbolItem) => symbolItem.filePath));
        const kindCounts: Record<string, number> = {};
        for (const symbolItem of symbols) {
            kindCounts[symbolItem.kind] = (kindCounts[symbolItem.kind] ?? 0) + 1;
        }
        const lines = [
            `# ${repoName} — Context`,
            '',
            `| Metric | Value |`,
            `|---|---|`,
            `| Symbols | ${symbols.length} |`,
            `| Files | ${fileSet.size} |`,
            ...Object.entries(kindCounts).map(([kind, count]) => `| ${kind} | ${count} |`),
        ];
        return {
            contents: [{
                uri: uri.href,
                text: lines.join('\n'),
                mimeType: 'text/markdown',
            }],
        };
    },
);

/**
 * repo clusters — Functional areas (by top-level directory).
 */
server.resource(
    'repo_clusters',
    'lore://repo/{name}/clusters',
    { description: 'Functional areas grouped by directory structure' },
    async (uri) => {
        const repoName = uri.pathname.split('/')[2] ?? '';
        const symbols = await graph.queryCodeSymbols('', repoName, 9999);
        const dirCounts: Record<string, number> = {};
        for (const symbolItem of symbols) {
            const dir = symbolItem.filePath.split('/').slice(0, 2).join('/');
            dirCounts[dir] = (dirCounts[dir] ?? 0) + 1;
        }
        const sorted = Object.entries(dirCounts).sort((entryA, entryB) => entryB[1] - entryA[1]);
        const lines = [
            `# ${repoName} — Clusters`,
            '',
            '| Directory | Symbols |',
            '|---|---|',
            ...sorted.map(([dir, count]) => `| ${dir} | ${count} |`),
        ];
        return {
            contents: [{
                uri: uri.href,
                text: lines.join('\n'),
                mimeType: 'text/markdown',
            }],
        };
    },
);

/**
 * repo processes — Execution flows (approximated from CALLS chains).
 */
server.resource(
    'repo_processes',
    'lore://repo/{name}/processes',
    { description: 'Execution flows based on call chains' },
    async (uri) => {
        const repoName = uri.pathname.split('/')[2] ?? '';
        // Use gitnexus proxy for richer process data if available
        const result = proxyCypher(
            `MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel IS NOT NULL RETURN p.heuristicLabel AS process, count(s) AS steps ORDER BY steps DESC LIMIT 20`,
            repoName,
        );
        return {
            contents: [{
                uri: uri.href,
                text: result.success ? result.text : `# ${repoName} — Processes\n\nNo process data available. Run \`gitnexus analyze\` to generate execution flows.`,
                mimeType: 'text/markdown',
            }],
        };
    },
);

/**
 * repo schema — Graph schema for Cypher queries.
 */
server.resource(
    'repo_schema',
    'lore://repo/{name}/schema',
    { description: 'Graph schema: node types, edge types, properties' },
    async (uri) => {
        const lines = [
            '# Lore Graph Schema',
            '',
            '## Node Tables',
            '- **LoreNode**: id, type, label, content, tags, project, ecosystem, metadata, createdAt, updatedAt, syncedAt',
            '- **CodeSymbol**: uid, name, kind, filePath, startLine, endLine, content, signature, returnType, parameterCount, repo',
            '- **DevActivity**: id, dev, project, action, filePath, timestamp, tool',
            '',
            '## Relationship Tables',
            '- **LoreEdge**: FROM LoreNode TO LoreNode (sourceId, targetId, relation)',
            '- **CodeRelation**: FROM CodeSymbol TO CodeSymbol (type, confidence, reason)',
            '- **LoreAppliesToCode**: FROM LoreNode TO CodeSymbol (relation)',
            '',
            '## CodeRelation Types',
            'CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, CONTAINS, DEFINES, ACCESSES, OVERRIDES, MEMBER_OF',
            '',
            '## LoreNode Types',
            'decision, convention, bug_pattern, file_ref, architecture, troubleshooting, note',
        ];
        return {
            contents: [{
                uri: uri.href,
                text: lines.join('\n'),
                mimeType: 'text/markdown',
            }],
        };
    },
);

/* ─── Server Start ────────────────────────────────────────────── */

/**
 * main — Initialize graph and start MCP server on stdio.
 *
 * Side Effects: Opens Kùzu database, starts stdio listener.
 * Error Behavior: Exits process with code 1 on fatal startup error.
 */
async function main(): Promise<void> {
    await graph.initialize();

    // Attempt SurrealDB connection if adapter is configured
    if (adapter) {
        try {
            await adapter.connect();
            console.error(`[Lore MCP] Sync: ONLINE — connected to SurrealDB`);
        } catch (syncConnError) {
            console.error(`[Lore MCP] Sync: OFFLINE — SurrealDB unreachable (${(syncConnError as Error).message})`);
        }
    } else {
        console.error(`[Lore MCP] Sync: OFFLINE — no SurrealDB credentials configured`);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[Lore MCP] Server v1.0.0 started on stdio.`);
    console.error(`[Lore MCP] Graph: ${path.join(graphBasePath, '.lore', 'graph')}`);
    console.error(`[Lore MCP] Scope: project=${detectedScope.project}, ecosystem=${detectedScope.ecosystem}`);
    console.error(`[Lore MCP] Engine: Kùzu (unified graph)`);
}

main().catch((startupError) => {
    console.error('[Lore MCP] Failed to start:', startupError);
    process.exit(1);
});

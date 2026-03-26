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
import fs from 'fs';
import path from 'path';
import os from 'os';

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
    const currentWorkingDirectory = process.cwd();

    // Try to find git repo root
    let searchDirectory = currentWorkingDirectory;
    while (searchDirectory !== path.dirname(searchDirectory)) {
        if (fs.existsSync(path.join(searchDirectory, '.git'))) {
            return searchDirectory;
        }
        searchDirectory = path.dirname(searchDirectory);
    }

    // Fallback to home directory
    return path.join(os.homedir(), '.groundfloor');
}

/* ─── Server Setup ────────────────────────────────────────────── */

const detectedScope = resolveProjectScope();
const graphBasePath = resolveGraphPath();
const graph = new LocalGraph(graphBasePath);
const loreDir = path.join(graphBasePath, '.lore');
const syncEngine = new SyncEngine(graph, loreDir, null);
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

/* ─── Server Start ────────────────────────────────────────────── */

/**
 * main — Initialize graph and start MCP server on stdio.
 *
 * Side Effects: Opens Kùzu database, starts stdio listener.
 * Error Behavior: Exits process with code 1 on fatal startup error.
 */
async function main(): Promise<void> {
    await graph.initialize();

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

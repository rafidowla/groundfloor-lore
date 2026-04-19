#!/usr/bin/env node
/**
 * server.ts — Unified Groundfloor Lore MCP Server.
 *
 * Purpose:
 *   Exposes the unified Kùzu knowledge graph as an MCP server.
 *   Combines institutional knowledge (decisions, conventions, bugs) and
 *   code intelligence into a single MCP tool surface.
 *
 * Architecture:
 *   Uses @modelcontextprotocol/sdk for transport (stdio or HTTP).
 *   Delegates storage to LocalGraph (Kùzu embedded graph).
 *   Each tool maps to one or more graph operations.
 *
 * Transport:
 *   Default: stdio (stdin/stdout) — one IDE spawns one process.
 *   --http:  Streamable HTTP daemon on port 3847 — multiple IDEs share one process.
 *   The HTTP mode solves Kùzu's single-writer file lock constraint.
 *
 * Error Behavior: Returns MCP error responses; does not crash the server.
 * Side Effects: Reads/writes .lore/graph/ via LocalGraph.
 * Determinism: Non-deterministic (depends on database state).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalGraph, type LoreNode } from '../engines/localGraph.js';
import { VerbatimStore, buildVerbatimText } from '../engines/verbatimStore.js';
import { SyncEngine, WriteAheadLog } from '../engines/syncEngine.js';
import { TsSdkAdapter } from '../engines/tsSdkAdapter.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { SchemaLoader } from '../schemas/loader.js';
import { ConfigManager } from '../config/configManager.js';
import { setApiKey, getApiKey, hasApiKey, deleteApiKey } from '../config/keychain.js';
import {
    loadWorkspaces,
    getActiveWorkspacePath,
    getActiveWorkspaceName,
    createWorkspace,
    switchWorkspace,
    deleteWorkspace,
} from '../config/workspaces.js';
import { stream as llmStream, getCapability } from '../providers/llmDispatch.js';
import { decide as decideExtraction, type ExtractPayload } from '../providers/extractRouter.js';
import { reconnectGraph, reconnectOneNode } from '../engines/reconnect.js';
import { PluginRegistry } from '../plugins/registry.js';
import { lockDownDataDir } from '../security/permissions.js';
import { ensureAuthToken, getAuthTokenPath } from '../security/authToken.js';
import { validateRequest, writeAuthFailure } from '../security/httpAuth.js';
import {
    assertPathAllowed,
    loadExtraIngestionRoots,
    PathAllowlistError,
} from '../security/pathAllowlist.js';
import { RateLimiter, classifyRequest } from '../security/rateLimit.js';
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
    // V2.1: the graph lives under the currently-active workspace.
    // On first boot, loadWorkspaces() auto-writes a "default" entry that
    // points at ~/.groundfloor — preserving V2.0 data without migration.
    // Subsequent workspaces are created under ~/.groundfloor/workspaces/{name}/.
    try {
        return getActiveWorkspacePath();
    } catch (err) {
        console.error(`[Lore MCP] Workspace resolve failed (${(err as Error).message}); falling back to ~/.groundfloor`);
        return path.join(os.homedir(), '.groundfloor');
    }
}

/* ─── Server Setup ────────────────────────────────────────────── */

const detectedScope = resolveProjectScope();
const graphBasePath = resolveGraphPath();

const schemaLoader = new SchemaLoader(graphBasePath);
const domainSchema = schemaLoader.get();
const nodeTypesEnum = z.enum(domainSchema.nodeTypes as [string, ...string[]]);
const edgeRelationsEnum = z.enum(domainSchema.edgeRelations as [string, ...string[]]);

const graph = new LocalGraph(graphBasePath);
const verbatimStore = new VerbatimStore(graphBasePath);
const loreDir = path.join(graphBasePath, '.lore');
const configManager = new ConfigManager(loreDir);
const pluginRegistry = new PluginRegistry(configManager);
pluginRegistry.boot();
console.error(`[Lore MCP] Plugins active: ${configManager.read().plugins.join(', ') || '(none)'}`);

// Plugin schema registration runs inside main() after graph.initialize()
// — see line ~1432 in main(). Doing it there avoids racing the Kùzu
// connection open with the main() init path.
const orphanStateAtBoot = pluginRegistry.getOrphanState();
if (orphanStateAtBoot.blocking) {
    console.error(`[Lore MCP] ⚠ Orphan plugins detected: ${orphanStateAtBoot.orphans.join(', ')}. /api/* is blocked until resolved via POST /api/orphan.`);
}

/**
 * resolveSyncAdapter — Auto-detect Dataplane API keys and create a TS-SDK adapter.
 *
 * Priority:
 *   1. DATAPLANE_URL + DATAPLANE_API_KEY env vars
 *   2. Returns null if no credentials found (offline mode)
 *
 * Side Effects: Reads env vars.
 * Determinism: Deterministic for a given environment.
 */
function resolveSyncAdapter(): TsSdkAdapter | null {
    let baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
    const apiKey = process.env['DATAPLANE_API_KEY'];
    const tenantId = process.env['DATAPLANE_TENANT_ID'] ?? 'groundfloor_lore';
    const orgId = process.env['DATAPLANE_ORG_ID'] ?? 'default';

    if (!apiKey) return null;

    return new TsSdkAdapter({ baseUrl, apiKey, tenantId, orgId });
}

const adapter = resolveSyncAdapter();
const syncEngine = new SyncEngine(graph, loreDir, adapter);
const wal = syncEngine.getWal();

/**
 * Phase 4: Lightweight Dataplane health-ping.
 *
 * Invariants:
 *   - Fires exactly once at boot.
 *   - Sends NO graph contents, NO node counts, NO user data. Just
 *     "is the tenant reachable". Matches Non-Goal #4.
 *   - Honors config.telemetryOptOut. When true, we skip the ping entirely
 *     and treat dataplane as 'offline'.
 *   - Failure is non-fatal. Airplane-mode boot must succeed even when
 *     /etc/hosts points Dataplane at a black hole.
 */
type DataplaneState = 'unknown' | 'offline' | 'opted-out' | 'bound' | 'error';
let dataplaneState: DataplaneState = 'unknown';

async function fireBootHealthPing(): Promise<void> {
    try {
        const cfg = configManager.read();
        if (cfg.telemetryOptOut) {
            dataplaneState = 'opted-out';
            console.error('[Lore MCP] Dataplane ping: opted-out (config.telemetryOptOut=true)');
            return;
        }
        if (!adapter) {
            dataplaneState = 'offline';
            console.error('[Lore MCP] Dataplane ping: offline (no DATAPLANE_API_KEY env var)');
            return;
        }
        await adapter.connect();
        dataplaneState = 'bound';
        console.error('[Lore MCP] Dataplane ping: bound');
    } catch (err) {
        dataplaneState = 'error';
        console.error(`[Lore MCP] Dataplane ping: failed (${(err as Error).message}) — continuing offline`);
    }
}

function getDataplaneState(): DataplaneState {
    return dataplaneState;
}

// Fire the ping non-blockingly; server boot must not wait on it.
void fireBootHealthPing();

/**
 * createMcpServer — Factory function to create and configure an McpServer instance.
 *
 * Purpose:
 *   Creates a new McpServer with all tools and resources registered.
 *   In stdio mode, called once. In HTTP mode, called per client session
 *   since McpServer binds to a single transport and cannot be reused.
 *
 * @returns Fully configured McpServer instance.
 *
 * Side Effects: None (tools operate on shared graph/syncEngine singletons).
 * Determinism: Deterministic.
 */
function createMcpServer(): McpServer {
    const mcpServer = new McpServer({
        name: 'groundfloor-lore',
        version: '1.0.0',
    });

/* ─── Tool: store_node ────────────────────────────────────────── */

mcpServer.tool(
    'store_node',
    `Create or update a knowledge node within the ${domainSchema.domain} domain`,
    {
        id: z.string().describe('Unique identifier (e.g., "baas-body-stream-fix")'),
        type: nodeTypesEnum.describe(`Node type (options: ${domainSchema.nodeTypes.join(', ')})`),
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

            verbatimStore.store({
                id,
                text: buildVerbatimText(label, content ?? '', tags ?? ''),
                metadata: { type, label, tags: tags ?? '', project: scopedProject, ecosystem: scopedEcosystem, updatedAt: node.updatedAt }
            }).catch((err) => console.error(`[Lore MCP] VerbatimStore write failed for '${id}':`, err));

            // V2.1 ingest hook (Option A): immediately draw semantic
            // neighbor edges to this node's top-K similar neighbors. Keeps
            // the graph connected as new knowledge arrives.
            // Opt out via config.pluginConfig.developer.autoLinkOnIngest=false.
            const cfgForHook = configManager.read();
            const devCfg = (cfgForHook.pluginConfig?.developer ?? {}) as { autoLinkOnIngest?: boolean };
            if (devCfg.autoLinkOnIngest !== false) {
                void reconnectOneNode(graph, verbatimStore, pluginRegistry, {
                    id,
                    label,
                    content: content ?? '',
                    tags: tags ?? '',
                    type,
                    project: scopedProject,
                    ecosystem: scopedEcosystem,
                }).catch((err) => console.error(`[Lore MCP] ingest-hook reconnect failed for '${id}':`, err));
            }

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

mcpServer.tool(
    'store_edge',
    'Create a relationship between two knowledge nodes',
    {
        sourceId: z.string().describe('Source node ID'),
        targetId: z.string().describe('Target node ID'),
        relation: edgeRelationsEnum.describe(`Relationship type (options: ${domainSchema.edgeRelations.join(', ')})`),
        bidirectional: z.boolean().optional().describe('Create edge in both directions (default: true)'),
        // C1 — confidence tier. Defaults to 'extracted' (user-asserted fact).
        confidence: z.enum(['extracted', 'inferred', 'ambiguous']).optional().describe(
            "Confidence tier. 'extracted' = user/rule-asserted fact (default). 'inferred' = LLM or similarity-inferred. 'ambiguous' = candidate needing human review.",
        ),
        confidenceScore: z.number().min(0).max(1).optional().describe(
            'Optional numeric confidence in [0,1]. Defaults to 1.0 for extracted, or the inference score for inferred/ambiguous.',
        ),
    },
    async ({ sourceId, targetId, relation, bidirectional, confidence, confidenceScore }) => {
        try {
            const useBidirectional = bidirectional ?? true;
            const conf = confidence ?? 'extracted';
            const score = confidenceScore ?? (conf === 'extracted' ? 1.0 : 0.5);

            if (useBidirectional) {
                await graph.addBidirectionalEdge({
                    sourceId, targetId, relation,
                    confidence: conf, confidenceScore: score,
                });
            } else {
                await graph.addEdge({
                    sourceId, targetId, relation,
                    confidence: conf, confidenceScore: score,
                });
            }

            // Buffer write to WAL for async sync
            wal.append('add_edge', { sourceId, targetId, relation, confidence: conf, confidenceScore: score });

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        edge: { sourceId, targetId, relation, bidirectional: useBidirectional, confidence: conf, confidenceScore: score },
                        message: `Edge '${sourceId}' ${useBidirectional ? '↔' : '→'} '${targetId}' (${relation}, ${conf}) created.`,
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

mcpServer.tool(
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

mcpServer.tool(
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

mcpServer.tool(
    'recall',
    'High-level knowledge recall: searches for a topic and traverses related nodes',
    {
        topic: z.string().describe('Topic to recall (e.g., "BaaSClient", "auth conventions")'),
        depth: z.number().optional().describe('Traversal depth from each search result (default: 1)'),
    },
    async ({ topic, depth }) => {
        try {
            const verbatimCount = await verbatimStore.count();
            let seedNodeIds: string[] = [];
            
            if (verbatimCount > 0) {
                const results = await verbatimStore.search(topic, 10);
                seedNodeIds = results.map(r => r.id);
            }
            
            let searchResults: LoreNode[] = [];
            
            if (verbatimCount === 0 || seedNodeIds.length === 0) {
                searchResults = await graph.search(topic, 10, detectedScope.project, detectedScope.ecosystem);
            } else {
                for (const id of seedNodeIds) {
                    const node = await graph.getNode(id);
                    if (node) searchResults.push(node);
                }
            }

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

            // Update Hot Cache
            for (const item of recalledNodes) {
                graph.sessionCache.pushNode(item.node.id);
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        topic,
                        searchMode: verbatimCount > 0 ? 'semantic' : 'keyword',
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

mcpServer.tool(
    'delete_node',
    'Remove a knowledge node and all its relationships',
    {
        id: z.string().describe('Node ID to delete'),
    },
    async ({ id }) => {
        try {
            const deleted = await graph.deleteNode(id);
            if (deleted) verbatimStore.delete(id).catch((err) => console.error(`[Lore MCP] VerbatimStore delete failed for '${id}':`, err));
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

mcpServer.tool(
    'list_nodes',
    'List all knowledge nodes, optionally filtered by type or tag',
    {
        type: nodeTypesEnum.optional().describe('Filter by node type'),
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

mcpServer.tool(
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

mcpServer.tool(
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
                        verbatimDocuments: await verbatimStore.count(),
                        graphPath: path.join(graphBasePath, '.lore', 'graph'),
                        engine: 'kùzu + lancedb',
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

mcpServer.tool(
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
                            message: 'No remote sync adapter configured — team awareness requires a shared backend (Groundfloor Dataplane).',
                            hint: 'Configure DATAPLANE_URL, DATAPLANE_API_KEY, DATAPLANE_TENANT_ID environment variables to enable team sync.',
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

mcpServer.tool(
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

/* ─── Tool: get_hot_context ───────────────────────────────────── */

mcpServer.tool(
    'get_hot_context',
    'Retrieve the Hot Cache: the most recently stored or accessed knowledge nodes. Use this to maintain immediate context.',
    {},
    async () => {
        try {
            const context = graph.sessionCache.getHotContext();
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(context, null, 2),
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

/* ─── Tool: read_document_for_ingestion ───────────────────────── */

mcpServer.tool(
    'read_document_for_ingestion',
    'Read a raw text or markdown document from the filesystem so that the AI can chunk it and ingest it into the knowledge graph.',
    {
        filePath: z.string().describe('Absolute path to the document'),
    },
    async ({ filePath }) => {
        // S4 — enforce the ingestion allowlist before any disk read.
        // Rejects ~/.ssh/id_rsa, ~/.aws/credentials, ~/.groundfloor/auth.
        // token, macOS keychain files, and anything not under an explicitly
        // allowed root. See packages/lore/src/security/pathAllowlist.ts
        // for the full policy.
        let resolvedPath: string;
        try {
            resolvedPath = assertPathAllowed(filePath, {
                workspaceRoot: graphBasePath,
                extraRoots: loadExtraIngestionRoots(path.join(os.homedir(), '.groundfloor')),
            });
        } catch (err) {
            if (err instanceof PathAllowlistError) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Ingestion denied (${err.code}): ${err.message}`,
                    }],
                    isError: true,
                };
            }
            throw err;
        }

        try {
            const content = fs.readFileSync(resolvedPath, 'utf-8');
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        filePath: resolvedPath,
                        content,
                        instructions: 'Please parse this content into LoreNode objects. For each distinct item you find, use the store_node tool to insert it into the graph.'
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

// V2.1 cleanup (Option C): the 10 developer-specific MCP tools have
// moved into src/plugins/developer/tools.ts and register themselves via
// ILorePlugin.registerTools. Core server has no knowledge of them.
// pluginRegistry.registerTools(mcpServer, pluginCtx) runs at the end
// of this factory function.


/* ─── Plugin tool + resource registration ───────────────────── */

// Each active plugin registers its own MCP tools AND resources against
// this server via ILorePlugin.registerTools. Core has no knowledge of
// plugin-specific surfaces.
pluginRegistry.registerTools(mcpServer, {
    graph,
    verbatimStore,
    syncEngine,
    syncAdapter: adapter,
    schemaLoader,
    scope: detectedScope,
    loreDir,
});

    return mcpServer;
}

/* ─── Server Start ────────────────────────────────────────────── */

/** Default port for HTTP daemon mode. Override with LORE_PORT env var. */
const LORE_HTTP_PORT = parseInt(process.env['LORE_PORT'] ?? '3847', 10);

/**
 * S3 — localhost auth token. Populated at the top of main() from
 * ~/.groundfloor/auth.token (generated if missing). Consumed by the
 * HTTP request validator on every /api/* request.
 *
 * Module-level mutable: set once at boot, read on every request. Never
 * reassigned after boot; the daemon is restarted to rotate.
 */
let authToken = '';

/**
 * S5 — rate limiter shared across all /api/* handlers. Per-endpoint-class
 * token buckets; see src/security/rateLimit.ts for the defaults.
 */
const rateLimiter = new RateLimiter();

/** Active HTTP sessions — maps session ID to transport instance. */
const activeSessions = new Map<string, StreamableHTTPServerTransport>();

/**
 * main — Initialize graph and start MCP server.
 *
 * Purpose:
 *   Supports two transport modes:
 *   - stdio (default): each IDE spawns its own process.
 *   - HTTP (--http flag): single daemon, multiple IDEs connect via HTTP.
 *
 * Inputs:
 *   - process.argv: checks for '--http' flag.
 *   - LORE_PORT env var: HTTP port (default 3847).
 *
 * Side Effects: Opens Kùzu database, starts listener (stdio or HTTP).
 * Error Behavior: Exits process with code 1 on fatal startup error.
 * Concurrency: HTTP mode creates per-session McpServer+transport pairs,
 *   all sharing a single Kùzu graph instance.
 */
async function main(): Promise<void> {
    // S1 — File permission lockdown (Phase 0 security hardening).
    // Tighten ~/.groundfloor (data home) AND the active workspace root if
    // it differs (custom workspace paths can live anywhere). Must run
    // before graph.initialize() so Kùzu files inherit the 0700 parent dir.
    try {
        const dataHome = path.join(os.homedir(), '.groundfloor');
        const lockedPaths = new Set<string>([dataHome]);
        if (graphBasePath !== dataHome) lockedPaths.add(graphBasePath);
        for (const root of lockedPaths) {
            const summary = lockDownDataDir(root);
            const touched = summary.directoriesFixed + summary.filesFixed;
            if (touched > 0 || summary.errors.length > 0) {
                console.error(
                    `[Lore MCP] Perm lockdown ${root}: dirs=${summary.directoriesFixed} files=${summary.filesFixed} skipped=${summary.skipped} errors=${summary.errors.length}`,
                );
                for (const err of summary.errors) console.error(`[Lore MCP]   ${err}`);
            }
        }
    } catch (lockErr) {
        console.error(`[Lore MCP] Perm lockdown failed (non-fatal): ${(lockErr as Error).message}`);
    }

    // S3 — ensure the localhost auth token exists. Written with 0600.
    // After this line, every /api/* handler (except the public allowlist)
    // requires Authorization: Bearer <token>. UI bootstraps via
    // /api/auth/bootstrap (Host+Origin gated).
    const dataHome = path.join(os.homedir(), '.groundfloor');
    authToken = ensureAuthToken(dataHome);
    console.error(`[Lore MCP] Auth token at ${getAuthTokenPath(dataHome)} (0600)`);

    await graph.initialize();

    // V2.1 / Option C: each active plugin registers its own Kùzu schema
    // (e.g. developer plugin's CodeFile/CodeSymbol tables) and attaches
    // its typed api surface. Core never touches plugin-specific tables.
    try {
        await pluginRegistry.registerSchemas(graph.createPluginGraphContext());
        for (const plugin of pluginRegistry.active()) {
            console.error(`[Lore MCP] Plugin schema ready: ${plugin.name}`);
        }
    } catch (schemaErr) {
        console.error(`[Lore MCP] Plugin schema registration failed: ${(schemaErr as Error).message}`);
    }

    await verbatimStore.initialize();

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

    const useHttp = process.argv.includes('--http');

    if (useHttp) {
        // HTTP daemon mode — per-session McpServer+transport pairs
        const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const url = req.url ?? '';

            // ── S3: first gate — Host + Origin + Bearer token validation ──
            // Rejects DNS-rebinding attempts (bad Host), cross-origin browser
            // attacks (bad Origin), and unauthorized callers (missing/bad
            // Bearer). Public paths (/health, /api/health, /api/auth/
            // bootstrap) skip the bearer check but still must pass Host and
            // Origin. See packages/lore/src/security/httpAuth.ts.
            const authCheck = validateRequest(req, { port: LORE_HTTP_PORT, token: authToken });
            if (!authCheck.ok) {
                writeAuthFailure(res, authCheck);
                return;
            }

            // ── S5: rate limiting ──
            // After auth, debit a token from the matching bucket. Liveness
            // paths (health, bootstrap) are exempt. Exhausted bucket → 429
            // with a Retry-After hint. See src/security/rateLimit.ts for
            // the per-class limits.
            const bucket = classifyRequest(url, req.method ?? 'GET');
            if (bucket) {
                const r = rateLimiter.tryConsume(bucket);
                if (!r.allowed) {
                    res.writeHead(429, {
                        'Content-Type': 'application/json',
                        'Retry-After': String(r.retryAfterSec),
                    });
                    res.end(JSON.stringify({
                        error: 'rate limited',
                        bucket,
                        retryAfterSec: r.retryAfterSec,
                    }));
                    return;
                }
            }

            // Bootstrap endpoint — the UI calls this once on load to fetch
            // the auth token, then attaches it as Authorization: Bearer on
            // every subsequent /api/* request. Safe because: (a) validate
            // Request already enforced Host + Origin must be localhost, so
            // a hostile cross-origin tab can't reach here; (b) UI is always
            // same-origin on the daemon's port in production, or served
            // from localhost:5173 in dev (also allowed Origin).
            if (url === '/api/auth/bootstrap' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ token: authToken }));
                return;
            }

            // Orphan-decision gate: when a plugin has been deactivated but the
            // user hasn't chosen Keep/Drop/Re-enable, block every /api/* path
            // except /api/health (so UI can render the modal), /api/orphan
            // (so the user can resolve it), and /api/workspaces/* (so the user
            // can escape by switching workspaces). Matches Option C in
            // docs/V2_implementation_plan.md.
            const orphanExempt =
                url === '/api/health' ||
                url === '/api/orphan' ||
                url.startsWith('/api/workspaces');
            if (url.startsWith('/api/') && !orphanExempt) {
                const orphanState = pluginRegistry.getOrphanState();
                if (orphanState.blocking) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        code: 'orphan_decision_required',
                        orphans: orphanState.orphans,
                        resolve: 'POST /api/orphan {plugin, decision: keep|drop|reenable, confirm?: "DROP"}',
                    }));
                    return;
                }
            }

            // Health check endpoint for monitoring
            if (url === '/health' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', version: '1.0.0', sessions: activeSessions.size }));
                return;
            }

            // MCP endpoint
            if (url === '/mcp') {
                const sessionId = req.headers['mcp-session-id'] as string | undefined;

                // Route to existing session if header present
                if (sessionId && activeSessions.has(sessionId)) {
                    const existingTransport = activeSessions.get(sessionId)!;
                    await existingTransport.handleRequest(req, res);
                    return;
                }

                // New session — create fresh McpServer + transport
                const sessionTransport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                });

                sessionTransport.onclose = () => {
                    const sid = sessionTransport.sessionId;
                    if (sid) {
                        activeSessions.delete(sid);
                        console.error(`[Lore MCP] Session ${sid.slice(0, 8)}... closed (${activeSessions.size} active)`);
                    }
                };

                const sessionServer = createMcpServer();
                await sessionServer.connect(sessionTransport);

                // Store session after connection (sessionId is set during handleRequest)
                await sessionTransport.handleRequest(req, res);

                const newSessionId = sessionTransport.sessionId;
                if (newSessionId) {
                    activeSessions.set(newSessionId, sessionTransport);
                    console.error(`[Lore MCP] New session ${newSessionId.slice(0, 8)}... (${activeSessions.size} active)`);
                }
                return;
            }

            // V2.1: Node detail for the UI drawer. Returns the node itself,
            // plus its immediate neighbors and the edges connecting them.
            // Consumed by the node-click drawer + "Ask about this" chat flow.
            if (url.startsWith('/api/node') && req.method === 'GET') {
                try {
                    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
                    if (!id) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'id query param required' }));
                        return;
                    }
                    // Core only knows about LoreNodes. Plugin-contributed
                    // nodes (file:, symbol:) are in topology but not
                    // individually addressable here — V1 limitation, can
                    // add a pluginRegistry hook later.
                    const stripped = id.startsWith('lore:') ? id.slice(5) : id;
                    const node = await graph.getNode(stripped);
                    if (!node) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `Node "${id}" not found` }));
                        return;
                    }
                    // Pull immediate neighbors in both directions via a direct
                    // 1-hop Cypher match (simpler than traverse, which uses
                    // a recursive pattern that some kuzu-lite builds choke on).
                    const pluginCtxForNode = graph.createPluginGraphContext();
                    const outRows = await pluginCtxForNode.queryRows(
                        `MATCH (n:LoreNode {id: $id})-[e:LoreEdge]->(m:LoreNode)
                         RETURN m.id AS id, m.label AS label, m.type AS type,
                                e.relation AS rel, e.confidence AS conf, e.confidenceScore AS score`,
                        { id: stripped },
                    ).catch(() => []);
                    const inRows = await pluginCtxForNode.queryRows(
                        `MATCH (m:LoreNode)-[e:LoreEdge]->(n:LoreNode {id: $id})
                         RETURN m.id AS id, m.label AS label, m.type AS type,
                                e.relation AS rel, e.confidence AS conf, e.confidenceScore AS score`,
                        { id: stripped },
                    ).catch(() => []);
                    const neighbors = [
                        ...outRows.map((r) => ({
                            id: r.id as string,
                            label: r.label as string,
                            type: r.type as string,
                            relation: (r.rel as string) || 'related_to',
                            confidence: (r.conf as string) ?? 'extracted',
                            confidenceScore: typeof r.score === 'number' ? r.score : 1.0,
                            depth: 1,
                        })),
                        ...inRows.map((r) => ({
                            id: r.id as string,
                            label: r.label as string,
                            type: r.type as string,
                            relation: `← ${(r.rel as string) || 'related_to'}`,
                            confidence: (r.conf as string) ?? 'extracted',
                            confidenceScore: typeof r.score === 'number' ? r.score : 1.0,
                            depth: 1,
                        })),
                    ];
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ node, neighbors }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // Save / create a node from the UI dashboard
            if (url === '/api/node' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const nodeData = JSON.parse(body);
                        if (!nodeData.id || !nodeData.type || !nodeData.label) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'id, type, and label are required' }));
                            return;
                        }
                        await graph.upsertNode(nodeData);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, id: nodeData.id }));
                    } catch (saveErr) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (saveErr as Error).message }));
                    }
                });
                return;
            }

            // Full-text content search from the UI dashboard
            if (url.startsWith('/api/search') && req.method === 'GET') {
                try {
                    const searchParams = new URL(url, 'http://localhost').searchParams;
                    const query = searchParams.get('q') ?? '';
                    const results = await graph.search(query, 50);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(results));
                } catch (searchErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (searchErr as Error).message }));
                }
                return;
            }

            // UI Visualizer Data API Endpoint. Core returns LoreNode/LoreEdge;
            // active plugins contribute their own slice (e.g. developer
            // plugin emits CodeFile/CodeSymbol + cross-pillar edges) via
            // ILorePlugin.contributeTopology.
            if (url === '/api/topology' && req.method === 'GET') {
                try {
                    const topology = await graph.getTopology(500);
                    const pluginCtx = graph.createPluginGraphContext();
                    for (const plugin of pluginRegistry.active()) {
                        if (typeof plugin.contributeTopology !== 'function') continue;
                        try {
                            const slice = await plugin.contributeTopology(pluginCtx, 500);
                            topology.nodes.push(...slice.nodes);
                            topology.edges.push(...slice.edges);
                        } catch (pluginErr) {
                            console.error(`[/api/topology] plugin "${plugin.name}" contribute failed:`, (pluginErr as Error).message);
                        }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(topology));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // UI health check: status + active config snapshot + sync adapter status
            if (url === '/api/health' && req.method === 'GET') {
                try {
                    const cfg = configManager.read();
                    const orphanState = pluginRegistry.getOrphanState();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: orphanState.blocking ? 'orphan_decision_required' : 'ok',
                        version: '2.1.0',
                        activePlugins: cfg.plugins,
                        defaultMode: cfg.defaultMode,
                        llmProvider: cfg.llmProvider,
                        workspace: getActiveWorkspaceName(),
                        dataplane: getDataplaneState(),
                        telemetryOptOut: Boolean(cfg.telemetryOptOut),
                        sessions: activeSessions.size,
                        orphans: orphanState.orphans,
                    }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'degraded', error: (err as Error).message }));
                }
                return;
            }

            // V2.1: Workspace registry — Slack-style hard switching between
            // independent graphs. Each workspace = its own .lore/ directory,
            // never cross-visible. Switching requires a daemon restart so the
            // Kùzu graph + VerbatimStore can re-initialize against the new path.
            if (url === '/api/workspaces' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(loadWorkspaces()));
                return;
            }

            if (url === '/api/workspaces' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const { name } = JSON.parse(body || '{}') as { name?: string };
                        if (!name) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'name required' }));
                            return;
                        }
                        const entry = createWorkspace(name);
                        res.writeHead(201, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ created: entry, workspaces: loadWorkspaces() }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            if (url === '/api/workspaces/switch' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const { name } = JSON.parse(body || '{}') as { name?: string };
                        if (!name) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'name required' }));
                            return;
                        }
                        if (name === getActiveWorkspaceName()) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ active: name, restarting: false }));
                            return;
                        }
                        switchWorkspace(name);
                        res.writeHead(202, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ active: name, restarting: true }));
                        // Defer exit so the response flushes cleanly; launchd
                        // KeepAlive=true will relaunch immediately and the daemon
                        // will bind to the new workspace on the next boot.
                        setTimeout(() => {
                            console.error(`[Lore MCP] Workspace switched to "${name}" — exiting for restart.`);
                            process.exit(0);
                        }, 150);
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            if (url.startsWith('/api/workspaces/') && req.method === 'DELETE') {
                const name = decodeURIComponent(url.slice('/api/workspaces/'.length));
                try {
                    const next = deleteWorkspace(name);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(next));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // V2.1: Reconnect the knowledge graph via semantic neighbors.
            // POST body: {k?, threshold?, apply?}. Dry-run by default — returns
            // proposed edges + similarity histogram so the UI can calibrate
            // the threshold before committing. apply=true prunes prior
            // inferred edges and inserts the new set.
            if (url === '/api/graph/reconnect' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const { k, threshold, apply, force } = JSON.parse(body || '{}') as {
                            k?: number;
                            threshold?: number;
                            apply?: boolean;
                            force?: boolean;
                        };
                        const result = await reconnectGraph(graph, verbatimStore, pluginRegistry, {
                            k,
                            minSim: threshold,
                            dryRun: !apply,
                            force,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // V2.1: Reconsume — the "refresh everything" button. Does the
            // full re-embed + reconnect pipeline in one call: pulls every
            // LoreNode + CodeFile (with child-symbol preview) + CodeSymbol,
            // re-embeds against the latest content, prunes old inferred
            // edges, and lays a fresh cross-pillar edge set. Always applies.
            if (url === '/api/graph/reconsume' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const { k, threshold, force } = JSON.parse(body || '{}') as {
                            k?: number;
                            threshold?: number;
                            force?: boolean;
                        };
                        const result = await reconnectGraph(graph, verbatimStore, pluginRegistry, {
                            k,
                            minSim: threshold,
                            dryRun: false,
                            pruneInferred: true,
                            force,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // V2.1 / Option C: ingest-files is developer-plugin-owned.
            // Core reaches it through the plugin's opaque api surface;
            // returns 501 if the developer plugin isn't active here.
            if (url === '/api/graph/ingest-files' && req.method === 'POST') {
                try {
                    const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                    const devApi = devPlugin?.api as
                        | { ingestFilesFromSymbols: () => Promise<{ filesCreated: number; edgesCreated: number }> }
                        | undefined;
                    if (!devApi) {
                        res.writeHead(501, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'ingest-files requires the "developer" plugin (not active in this workspace)' }));
                        return;
                    }
                    const stats = await devApi.ingestFilesFromSymbols();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, ...stats }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // Orphan plugin resolution endpoint. GET returns state; POST applies
            // the user's decision (keep/drop/reenable). 'drop' requires the
            // literal string "DROP" in confirm to match the CLI/UI prompt.
            if (url === '/api/orphan' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(pluginRegistry.getOrphanState()));
                return;
            }

            if (url === '/api/orphan' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const { plugin, decision, confirm } = JSON.parse(body || '{}') as {
                            plugin?: string;
                            decision?: 'keep' | 'drop' | 'reenable';
                            confirm?: string;
                        };
                        if (!plugin || !decision) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'plugin and decision required' }));
                            return;
                        }
                        if (decision === 'drop' && confirm !== 'DROP') {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'drop requires confirm="DROP"' }));
                            return;
                        }
                        const next = pluginRegistry.resolveOrphan(plugin, decision);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            resolved: plugin,
                            decision,
                            orphanState: pluginRegistry.getOrphanState(),
                            config: next,
                        }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // UI config read: returns the live config (without API keys)
            if (url === '/api/config' && req.method === 'GET') {
                try {
                    const cfg = configManager.read();
                    const hasKey = await hasApiKey(cfg.llmProvider);
                    const capability = getCapability(cfg.llmProvider);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ...cfg, hasApiKey: hasKey, capability }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // UI config write: PATCH partial updates. `apiKey` goes to keychain,
            // all other fields merge into .lore/config.json.
            if (url === '/api/config' && req.method === 'PATCH') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const update = JSON.parse(body || '{}') as Record<string, unknown>;
                        const { apiKey, ...configFields } = update;
                        const next = configManager.patch(configFields);
                        if (typeof apiKey === 'string' && apiKey.length > 0) {
                            const ok = await setApiKey(next.llmProvider, apiKey);
                            if (!ok) {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'keychain write failed' }));
                                return;
                            }
                        } else if (apiKey === null) {
                            await deleteApiKey(next.llmProvider);
                        }
                        const hasKey = await hasApiKey(next.llmProvider);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ...next, hasApiKey: hasKey, capability: getCapability(next.llmProvider) }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // File extraction gate (Phase 2). The server reads the LIVE
            // capability manifest of the configured LLM and either accepts
            // + returns a chunking/caption plan (202), or rejects with the
            // accepted-types list (415). BYOK only — DEF Cloud path is
            // greyed out in UI until the Groundfloor sign-in workflow ships.
            if (url === '/api/extract' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(body || '{}') as Partial<ExtractPayload>;
                        if (!payload.filename || !payload.mimeType || payload.content === undefined) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'filename, mimeType, content required' }));
                            return;
                        }
                        const cfg = configManager.read();
                        const cap = getCapability(cfg.llmProvider);
                        const decision = decideExtraction(payload as ExtractPayload, cap);
                        res.writeHead(decision.status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            accepted: decision.accepted,
                            provider: cfg.llmProvider,
                            capability: cap,
                            ...decision.body,
                        }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // Chat SSE stream — routes every message to the local/BYOK LLM.
            // Never falls back to any cloud pathway silently.
            if (url === '/api/chat' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    let message = '';
                    try {
                        const parsed = JSON.parse(body || '{}') as { message?: string };
                        message = (parsed.message ?? '').trim();
                    } catch {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'invalid JSON body' }));
                        return;
                    }
                    if (!message) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'message required' }));
                        return;
                    }

                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                        'X-Accel-Buffering': 'no',
                    });

                    const write = (evt: Record<string, unknown>): void => {
                        res.write(`data: ${JSON.stringify(evt)}\n\n`);
                    };

                    try {
                        const cfg = configManager.read();
                        const key = await getApiKey(cfg.llmProvider);
                        write({ type: 'start', provider: cfg.llmProvider });

                        // V2.1: if the message references `[node:id]` markers
                        // (added by the "Ask about this" button on the node
                        // detail drawer), load those nodes + their immediate
                        // neighbors and prepend as a system-prompt addendum so
                        // the LLM answers in scope. Focus event still fires
                        // so the canvas pans to the primary reference.
                        let enrichedMessage = message;

                        // Phase 1 / C2 — collect each active plugin's system-
                        // prompt contribution and stash it to prepend below.
                        // Plugins teach the LLM about their domain (tone,
                        // vocabulary, when to call which tool). `llmStream`
                        // takes a single string; we fold the contributions
                        // into that string rather than using a separate
                        // 'system' role (local Qwen has no system role, and
                        // uniformity across providers is simpler).
                        const pluginPromptParts = pluginRegistry.getSystemPromptContributions({
                            graph,
                            verbatimStore,
                            syncEngine,
                            syncAdapter: adapter,
                            schemaLoader,
                            scope: detectedScope,
                            loreDir,
                        });
                        const markerRe = /\[node:([\w\-.:]+)\]/gi;
                        const referencedIds: string[] = [];
                        let m;
                        while ((m = markerRe.exec(message)) !== null) {
                            referencedIds.push(m[1]);
                        }
                        if (referencedIds.length > 0) {
                            const contextBlocks: string[] = [];
                            const chatCtx = graph.createPluginGraphContext();
                            for (const rawId of referencedIds) {
                                const id = rawId.startsWith('lore:') ? rawId.slice(5) : rawId;
                                try {
                                    const refNode = await graph.getNode(id);
                                    if (!refNode) continue;
                                    // Use a plain 1-hop Cypher — traverse uses a
                                    // recursive pattern that some kuzu-lite builds
                                    // refuse.
                                    const outRows = await chatCtx.queryRows(
                                        `MATCH (n:LoreNode {id: $id})-[e:LoreEdge]->(m:LoreNode)
                                         RETURN m.id AS id, m.label AS label, m.type AS type, e.relation AS rel`,
                                        { id },
                                    ).catch(() => []);
                                    const inRows = await chatCtx.queryRows(
                                        `MATCH (m:LoreNode)-[e:LoreEdge]->(n:LoreNode {id: $id})
                                         RETURN m.id AS id, m.label AS label, m.type AS type, e.relation AS rel`,
                                        { id },
                                    ).catch(() => []);
                                    const neighborLines = [...outRows, ...inRows]
                                        .slice(0, 10)
                                        .map((r) => `  - ${r.rel ?? 'related_to'} → ${r.type}: ${r.label} (${r.id})`)
                                        .join('\n');
                                    contextBlocks.push(
                                        `## Referenced node: ${refNode.label} (id=${refNode.id}, type=${refNode.type})\n\n${refNode.content || '(no content)'}\n\n### Connected to:\n${neighborLines || '  (no edges yet)'}`,
                                    );
                                } catch (refErr) {
                                    console.error(`[/api/chat] failed to load ref node "${rawId}":`, (refErr as Error).message);
                                }
                            }
                            if (contextBlocks.length > 0) {
                                enrichedMessage = `You are answering about specific knowledge node(s) the user has referenced. Use the context below as the primary source; cite by id when you reply.\n\n${contextBlocks.join('\n\n---\n\n')}\n\n## User question\n${message}`;
                                write({ type: 'focus', nodeId: referencedIds[0], matches: referencedIds });
                            }
                        } else {
                            // Fallback: regex-match tokens against node labels
                            // for camera pan (Phase 3 focus fallback).
                            try {
                                const topology = await graph.getTopology(500);
                                const tokens = message
                                    .toLowerCase()
                                    .split(/[^a-z0-9_\-:]+/i)
                                    .filter((t) => t.length >= 4);
                                const matches: string[] = [];
                                for (const node of topology.nodes) {
                                    const label = (node.label ?? node.id).toLowerCase();
                                    if (tokens.some((tok) => label.includes(tok))) {
                                        matches.push(node.id);
                                        if (matches.length >= 3) break;
                                    }
                                }
                                if (matches.length > 0) {
                                    write({ type: 'focus', nodeId: matches[0], matches });
                                }
                            } catch {
                                // Focus fallback is best-effort.
                            }
                        }

                        // Prepend plugin prompt contributions (C2). They go
                        // AFTER any [node:id] context we built above, so
                        // domain guidance frames how the LLM treats the
                        // referenced nodes. If no plugins contributed, this
                        // is a no-op.
                        if (pluginPromptParts.length > 0) {
                            const preamble = pluginPromptParts.join('\n\n');
                            enrichedMessage = `${preamble}\n\n---\n\n${enrichedMessage}`;
                        }

                        for await (const chunk of llmStream(cfg.llmProvider, enrichedMessage, key)) {
                            if (chunk.kind === 'token' && chunk.content) {
                                write({ type: 'token', content: chunk.content });
                            } else if (chunk.kind === 'model_loading') {
                                // V2.1: first-run Qwen download progress.
                                write({
                                    type: 'model_loading',
                                    status: chunk.status,
                                    file: chunk.file,
                                    progress: chunk.progress,
                                });
                            } else if (chunk.kind === 'error') {
                                write({ type: 'error', message: chunk.message });
                            } else if (chunk.kind === 'done') {
                                write({ type: 'done' });
                            }
                        }
                    } catch (err) {
                        write({ type: 'error', message: `chat pipeline: ${(err as Error).message}` });
                    } finally {
                        res.end();
                    }
                });
                return;
            }

            // Visualizer Frontend Endpoint
            if (url === '/explore' && req.method === 'GET') {
                try {
                    const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
                    // When running from dist/mcp, root is ../../
                    // When running from src/mcp, root is ../../ 
                    // Wait, from src/mcp, package root is ../../ as well. 
                    const htmlPath = path.resolve(__dirnameLocal, '../../src/public/explore.html');
                    const html = fs.readFileSync(htmlPath, 'utf8');
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(html);
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Failed to load explore HTML dashboard: ' + (err as Error).message);
                }
                return;
            }

            // Unknown path
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found. Use /mcp for MCP or /health for status.' }));
        });

        httpServer.listen(LORE_HTTP_PORT, '127.0.0.1', () => {
            console.error(`[Lore MCP] Server v1.0.0 started on HTTP :${LORE_HTTP_PORT}`);
            console.error(`[Lore MCP] Endpoint: http://127.0.0.1:${LORE_HTTP_PORT}/mcp`);
            console.error(`[Lore MCP] Health:   http://127.0.0.1:${LORE_HTTP_PORT}/health`);
            console.error(`[Lore MCP] Graph: ${path.join(graphBasePath, '.lore', 'graph')}`);
            console.error(`[Lore MCP] Scope: project=${detectedScope.project}, ecosystem=${detectedScope.ecosystem}`);
            console.error(`[Lore MCP] Engine: Kùzu (unified graph)`);
        });

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.error('[Lore MCP] Shutting down...');
            httpServer.close();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            httpServer.close();
            process.exit(0);
        });
    } else {
        // stdio mode — backward compatible, one IDE per process
        const server = createMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);

        console.error(`[Lore MCP] Server v1.0.0 started on stdio.`);
        console.error(`[Lore MCP] Graph: ${path.join(graphBasePath, '.lore', 'graph')}`);
        console.error(`[Lore MCP] Scope: project=${detectedScope.project}, ecosystem=${detectedScope.ecosystem}`);
        console.error(`[Lore MCP] Engine: Kùzu (unified graph)`);
    }
}

main().catch((startupError) => {
    console.error('[Lore MCP] Failed to start:', startupError);
    process.exit(1);
});


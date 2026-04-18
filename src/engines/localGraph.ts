/**
 * localGraph.ts — Kùzu Embedded Graph Database for Unified Lore.
 *
 * Purpose:
 *   Provides the local-first graph database for both code intelligence and
 *   institutional knowledge. Uses Kùzu (embedded graph DB via @kineviz/kuzu-lite)
 *   for native Cypher queries and cross-pillar traversals.
 *
 * Architecture:
 *   Replaces the separate SQLite (knowledge) and Kùzu (code) databases from
 *   the GitNexus/Lore split with a single unified graph. All reads and writes
 *   are local (<1ms). Sync to hosted SurrealDB is handled by the sync engine.
 *
 * Node Tables:
 *   - LoreNode: decisions, conventions, bug patterns, architecture notes
 *   - CodeSymbol: functions, classes, methods, interfaces (future)
 *   - DevActivity: developer branch/file tracking (future)
 *
 * Relationship Tables:
 *   - LoreEdge: knowledge ↔ knowledge relationships
 *   - LoreAppliesToCode: knowledge ↔ code cross-pillar edges (future)
 *   - CodeRelation: code ↔ code relationships (future)
 *
 * Side Effects: Creates/reads .lore/graph/ directory in the specified base path.
 * Determinism: Deterministic for a given database state.
 * Thread Safety: Single-writer (Kùzu constraint). Reads are concurrent-safe.
 * Idempotency: Schema creation is idempotent (IF NOT EXISTS).
 */

import { Database, Connection, type QueryResult } from '@kineviz/kuzu-lite';
import path from 'path';
import fs from 'fs';

// inferLanguage moved to src/plugins/developer/operations.ts alongside
// the CodeFile operations it supports.

import type { GraphProvider, LoreNode, LoreEdge, TraversalResult, GraphStats } from '../providers/types.js';
export type { LoreNode, LoreEdge, TraversalResult, GraphStats };

/* ─── Types ───────────────────────────────────────────────────── */



/**
 * CodeSymbol — A code element imported from GitNexus.
 *
 * Represents a function, class, method, interface, or other
 * structural code element with its location and relationships.
 */
export interface CodeSymbol {
    /** Unique identifier from GitNexus */
    uid: string;
    /** Symbol name */
    name: string;
    /** Kind: Function, Class, Method, Interface, File, etc. */
    kind: string;
    /** Source file path relative to repo root */
    filePath: string;
    /** Line number where the symbol starts */
    startLine: number;
    /** Line number where the symbol ends */
    endLine: number;
    /** Symbol source content (may be empty for large symbols) */
    content: string;
    /** Function/method signature */
    signature: string;
    /** Return type annotation */
    returnType: string;
    /** Number of parameters (for functions/methods) */
    parameterCount: number;
    /** Repository this symbol belongs to */
    repo: string;
}

/**
 * CodeRelationEdge — A relationship between two code symbols.
 */
export interface CodeRelationEdge {
    sourceUid: string;
    targetUid: string;
    type: string;
    confidence: number;
    reason: string;
}

/**
 * DevActivity — A developer activity event for team awareness.
 *
 * Tracks which developer is working on which file/project
 * to enable real-time team coordination and awareness.
 */
export interface DevActivity {
    /** developer identifier (e.g., git user.email or hostname) */
    dev: string;
    /** project name */
    project: string;
    /** action type: 'editing', 'reviewing', 'debugging', 'idle' */
    action: string;
    /** file being worked on (optional) */
    filePath: string;
    /** ISO 8601 timestamp of this activity */
    timestamp: string;
    /** tool being used: 'cursor', 'antigravity', 'vscode', etc. */
    tool: string;
}



/**
 * LoreGraphError — Custom error for graph operations.
 *
 * Purpose: Wraps Kùzu errors with context about the operation that failed.
 */
export class LoreGraphError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly cause?: unknown,
    ) {
        super(`[LoreGraph:${operation}] ${message}`);
        this.name = 'LoreGraphError';
    }
}

/* ─── Local Graph ─────────────────────────────────────────────── */

export class SessionCacheManager {
    private cachePath: string;
    private maxItems = 10;

    constructor(basePath: string) {
        this.cachePath = path.join(basePath, '.lore', 'hot_session.json');
    }

    pushNode(nodeId: string): void {
        const cache = this.readCache();
        // Remove if exists
        cache.recent_nodes = cache.recent_nodes.filter((id) => id !== nodeId);
        // Push to front
        cache.recent_nodes.unshift(nodeId);
        // Truncate
        if (cache.recent_nodes.length > this.maxItems) {
            cache.recent_nodes = cache.recent_nodes.slice(0, this.maxItems);
        }
        this.writeCache(cache);
    }

    getHotContext(): { recent_nodes: string[] } {
        return this.readCache();
    }

    private readCache(): { recent_nodes: string[] } {
        try {
            if (fs.existsSync(this.cachePath)) {
                return JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
            }
        } catch {
            // IGNORE
        }
        return { recent_nodes: [] };
    }

    private writeCache(cache: { recent_nodes: string[] }): void {
        try {
            fs.writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), 'utf-8');
        } catch {
            // IGNORE
        }
    }
}

/**
 * LocalGraph — Kùzu-backed unified graph for code + knowledge.
 *
 * Purpose:
 *   Manages the local embedded graph database. All MCP tools delegate to
 *   this class for reads and writes. The graph lives in .lore/graph/ within
 *   the repository root (or a specified base path).
 *
 * Inputs: basePath — directory where .lore/graph/ will be created.
 * Outputs: Query results as typed objects.
 *
 * Side Effects:
 *   - Creates .lore/graph/ directory on initialization.
 *   - Reads/writes Kùzu database files.
 *
 * Error Behavior: Throws LoreGraphError on database failures.
 * Concurrency: Single-writer. Multiple readers are safe.
 * Performance: All operations are local (<1ms for typical queries).
 */
export class LocalGraph implements GraphProvider {
    private database: Database;
    private connection: Connection;
    private graphPath: string;
    private initialized: boolean = false;
    public sessionCache: SessionCacheManager;

    /**
     * Creates a new LocalGraph instance.
     *
     * @param basePath - Root directory for the .lore/graph/ data.
     *                   Typically the repository root or ~/.groundfloor/.
     */
    constructor(basePath: string) {
        const loreDir = path.join(basePath, '.lore');
        fs.mkdirSync(loreDir, { recursive: true });
        this.graphPath = path.join(loreDir, 'graph');

        this.database = new Database(this.graphPath);
        this.connection = new Connection(this.database);
        this.sessionCache = new SessionCacheManager(basePath);
    }

    /**
     * initialize — Creates the graph schema if it does not exist.
     *
     * Purpose: Ensures all node and relationship tables are present.
     *   Safe to call multiple times (idempotent).
     *
     * Side Effects: Creates Kùzu tables in the graph database.
     * Determinism: Idempotent.
     * Error Behavior: Throws LoreGraphError if schema creation fails.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            // ─── Node Tables ────────────────────────────────────────────
            await this.connection.query(`
                CREATE NODE TABLE IF NOT EXISTS LoreNode (
                    id STRING,
                    type STRING,
                    label STRING,
                    content STRING,
                    tags STRING,
                    project STRING,
                    ecosystem STRING,
                    metadata STRING,
                    createdAt STRING,
                    updatedAt STRING,
                    syncedAt STRING,
                    security_scopes STRING[],
                    PRIMARY KEY (id)
                )
            `);

            // ─── Relationship Tables ────────────────────────────────────
            await this.connection.query(`
                CREATE REL TABLE IF NOT EXISTS LoreEdge (
                    FROM LoreNode TO LoreNode,
                    relation STRING
                )
            `);

            // V2.1 / Option C: plugin-owned tables (CodeSymbol, CodeFile,
            // CodeRelation, FileContains, LoreAppliesToCode, LoreTouchesFile,
            // DevActivity) are created by their respective plugin's
            // `registerSchema` hook, invoked by PluginRegistry after the
            // core tables above are in place. Core Lore is plugin-agnostic.

            // ─── Schema Migrations ─────────────────────────────────────────
            // Add columns that may be missing from older databases.
            // Kùzu doesn't support ALTER TABLE IF NOT EXISTS, so we catch
            // and ignore errors for columns that already exist.
            const migrations = [
                `ALTER TABLE LoreNode ADD project STRING DEFAULT '*'`,
                `ALTER TABLE LoreNode ADD ecosystem STRING DEFAULT '*'`,
                `ALTER TABLE LoreNode ADD security_scopes STRING[] DEFAULT []`,
            ];
            for (const migration of migrations) {
                try {
                    await this.connection.query(migration);
                } catch {
                    // Column already exists — expected, ignore
                }
            }

            this.initialized = true;
        } catch (error) {
            throw new LoreGraphError(
                'Failed to initialize graph schema',
                'initialize',
                error,
            );
        }
    }

    /**
     * upsertNode — Create or update a knowledge node.
     *
     * Purpose: Inserts a new node or updates an existing one by ID.
     *   Sets createdAt on insert, updatedAt on every call.
     *
     * @param nodeData - The node data to upsert.
     * @returns The upserted node.
     *
     * Side Effects: Writes to Kùzu database.
     * Determinism: Deterministic for a given input.
     * Idempotency: Safe to retry (upsert semantics).
     */
    async upsertNode(nodeData: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode> {
        await this.initialize();

        const now = new Date().toISOString();
        const existingNode = await this.getNode(nodeData.id);

        try {
            if (existingNode) {
                 const stmt = await this.connection.prepare(
                    `MATCH (n:LoreNode {id: $id})
                     SET n.type = $type,
                         n.label = $label,
                         n.content = $content,
                         n.tags = $tags,
                         n.project = $project,
                         n.ecosystem = $ecosystem,
                         n.metadata = $metadata,
                         n.updatedAt = $updatedAt,
                         n.syncedAt = $syncedAt,
                         n.security_scopes = $security_scopes`,
                );
                await this.connection.execute(stmt, {
                    id: nodeData.id,
                    type: nodeData.type,
                    label: nodeData.label,
                    content: nodeData.content,
                    tags: nodeData.tags,
                    project: nodeData.project,
                    ecosystem: nodeData.ecosystem,
                    metadata: nodeData.metadata,
                    updatedAt: now,
                    syncedAt: '',
                    security_scopes: nodeData.security_scopes || [],
                });

                this.sessionCache.pushNode(nodeData.id);

                return {
                    ...nodeData,
                    createdAt: existingNode.createdAt,
                    updatedAt: now,
                    syncedAt: null,
                };
            } else {
                 const stmt = await this.connection.prepare(
                    `CREATE (n:LoreNode {
                        id: $id,
                        type: $type,
                        label: $label,
                        content: $content,
                        tags: $tags,
                        project: $project,
                        ecosystem: $ecosystem,
                        metadata: $metadata,
                        createdAt: $createdAt,
                        updatedAt: $updatedAt,
                        syncedAt: $syncedAt,
                        security_scopes: $security_scopes
                    })`,
                );
                await this.connection.execute(stmt, {
                    id: nodeData.id,
                    type: nodeData.type,
                    label: nodeData.label,
                    content: nodeData.content,
                    tags: nodeData.tags,
                    project: nodeData.project,
                    ecosystem: nodeData.ecosystem,
                    metadata: nodeData.metadata,
                    createdAt: now,
                    updatedAt: now,
                    syncedAt: '',
                    security_scopes: nodeData.security_scopes || [],
                });

                this.sessionCache.pushNode(nodeData.id);

                return {
                    ...nodeData,
                    createdAt: now,
                    updatedAt: now,
                    syncedAt: null,
                };
            }
        } catch (error) {
            throw new LoreGraphError(
                `Failed to upsert node '${nodeData.id}'`,
                'upsertNode',
                error,
            );
        }
    }

    /**
     * getNode — Retrieve a single knowledge node by ID.
     *
     * @param id - The node ID to look up.
     * @returns The node if found, null otherwise.
     *
     * Side Effects: Reads from Kùzu database.
     * Determinism: Deterministic.
     */
    async getNode(id: string): Promise<LoreNode | null> {
        await this.initialize();

        try {
            const stmt = await this.connection.prepare(
                `MATCH (n:LoreNode {id: $id}) RETURN n.*`,
            );
            const result = await this.connection.execute(stmt, { id }) as QueryResult;
            const rows = await result.getAll();
            if (rows.length === 0) return null;

            return this.rowToLoreNode(rows[0]);
        } catch (error) {
            throw new LoreGraphError(
                `Failed to get node '${id}'`,
                'getNode',
                error,
            );
        }
    }

    /**
     * addEdge — Create a directed relationship between two nodes.
     *
     * @param edge - Source, target, and relation type.
     *
     * Side Effects: Writes to Kùzu database.
     * Error Behavior: Throws if either node does not exist.
     */
    async addEdge(edge: LoreEdge): Promise<void> {
        await this.initialize();

        try {
            const stmt = await this.connection.prepare(
                `MATCH (a:LoreNode {id: $sourceId}), (b:LoreNode {id: $targetId})
                 CREATE (a)-[:LoreEdge {relation: $relation}]->(b)`,
            );
            await this.connection.execute(stmt, {
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                relation: edge.relation,
            });
        } catch (error) {
            throw new LoreGraphError(
                `Failed to add edge ${edge.sourceId} → ${edge.targetId}`,
                'addEdge',
                error,
            );
        }
    }

    /**
     * addBidirectionalEdge — Create edges in both directions.
     *
     * @param edge - Source, target, and relation type.
     *
     * Side Effects: Writes two edges to Kùzu database.
     */
    async addBidirectionalEdge(edge: LoreEdge): Promise<void> {
        await this.addEdge(edge);
        await this.addEdge({
            sourceId: edge.targetId,
            targetId: edge.sourceId,
            relation: edge.relation,
        });
    }

    /**
     * V2.1: pruneInferredLoreEdges — Delete every LoreEdge whose relation
     * field starts with the given prefix (e.g. "semantic_neighbor").
     * Used by reconnectGraph before re-inserting a fresh batch.
     *
     * Only touches inferred edges; human-asserted relations like
     * "supersedes"/"refers_to" are left alone.
     *
     * @returns the number of edges deleted.
     */
    async pruneInferredLoreEdges(relationPrefix: string): Promise<number> {
        await this.initialize();
        try {
            const countStmt = await this.connection.prepare(
                `MATCH ()-[e:LoreEdge]->() WHERE e.relation STARTS WITH $p RETURN count(e) AS cnt`,
            );
            const countResult = await this.connection.execute(countStmt, { p: relationPrefix }) as QueryResult;
            const rows = await countResult.getAll();
            const count = Number(rows[0]?.cnt ?? 0);

            const delStmt = await this.connection.prepare(
                `MATCH ()-[e:LoreEdge]->() WHERE e.relation STARTS WITH $p DELETE e`,
            );
            await this.connection.execute(delStmt, { p: relationPrefix });
            return count;
        } catch (error) {
            throw new LoreGraphError(
                `Failed to prune inferred edges with prefix '${relationPrefix}'`,
                'pruneInferredLoreEdges',
                error,
            );
        }
    }

    // V2.1 / Option C: cross-pillar operations (pruneInferredCrossEdges,
    // listCodeFiles*, listCodeSymbols) moved to src/plugins/developer/
    // operations.ts. Callers now reach them via
    // pluginRegistry.get('developer')?.api.*. Keeping the core engine
    // ignorant of whether any specific plugin is active.

    /**
     * traverse — Walk the graph from a starting node.
     *
     * Purpose: Follows edges up to a specified depth, returning all
     *   connected nodes with their distance and connecting relation.
     *
     * @param nodeId - Starting node ID.
     * @param maxDepth - Maximum traversal depth (1-5, default: 2).
     * @returns Array of traversal results sorted by depth.
     *
     * Side Effects: Reads from Kùzu database.
     * Performance: Bounded by maxDepth. Typical <5ms for depth 2.
     */
    async traverse(nodeId: string, maxDepth: number = 2): Promise<TraversalResult[]> {
        await this.initialize();
        const clampedDepth = Math.min(Math.max(maxDepth, 1), 5);

        try {
            // Use MATCH with recursive edge pattern
            const result = await this.connection.query(
                `MATCH (start:LoreNode)-[e:LoreEdge* 1..${clampedDepth}]->(connected:LoreNode)
                 WHERE start.id = '${this.escapeString(nodeId)}'
                 RETURN connected.*, length(e) AS depth, e[length(e)-1].relation AS relation`,
            ) as QueryResult;

            const rows = await result.getAll();
            const seen = new Set<string>();
            const results: TraversalResult[] = [];

            for (const row of rows) {
                const record = row as Record<string, unknown>;
                const node = this.rowToLoreNode(record);
                if (!seen.has(node.id) && node.id !== nodeId) {
                    seen.add(node.id);
                    results.push({
                        node,
                        depth: (record['depth'] as number) ?? 1,
                        relation: (record['relation'] as string) ?? 'related_to',
                    });
                }
            }

            return results.sort((nodeA, nodeB) => nodeA.depth - nodeB.depth);
        } catch (error) {
            throw new LoreGraphError(
                `Failed to traverse from '${nodeId}'`,
                'traverse',
                error,
            );
        }
    }

    /**
     * search — Full-text keyword search across knowledge nodes.
     *
     * Purpose: Finds nodes whose label, content, or tags contain the query string.
     *   Optionally filtered by project and ecosystem scope.
     *
     * @param query - Search query string.
     * @param limit - Maximum results (default: 20).
     * @param project - Optional project filter ('*' for all).
     * @param ecosystem - Optional ecosystem filter ('*' for all).
     * @returns Array of matching nodes.
     *
     * Side Effects: Reads from Kùzu database.
     * Performance: Linear scan with CONTAINS. Future: add FTS index.
     */
    async search(
        query: string,
        limit: number = 20,
        project: string = '*',
        ecosystem: string = '*',
    ): Promise<LoreNode[]> {
        await this.initialize();

        const escapedQuery = this.escapeString(query.toLowerCase());

        try {
            let cypher = `MATCH (n:LoreNode) WHERE
                (lower(n.label) CONTAINS '${escapedQuery}' OR lower(n.content) CONTAINS '${escapedQuery}' OR lower(n.tags) CONTAINS '${escapedQuery}')`;

            if (project !== '*') {
                cypher += ` AND (n.project = '${this.escapeString(project)}' OR n.project = '*')`;
            }
            if (ecosystem !== '*') {
                cypher += ` AND (n.ecosystem = '${this.escapeString(ecosystem)}' OR n.ecosystem = '*')`;
            }

            cypher += ` RETURN n.* LIMIT ${limit}`;

            const result = await this.connection.query(cypher) as QueryResult;
            const rows = await result.getAll();

            return rows.map((row) => this.rowToLoreNode(row as Record<string, unknown>));
        } catch (error) {
            throw new LoreGraphError(
                `Failed to search for '${query}'`,
                'search',
                error,
            );
        }
    }

    /**
     * listNodes — List all nodes with optional type/tag/scope filters.
     *
     * @param type - Optional node type filter.
     * @param tag - Optional tag filter (substring match).
     * @param project - Optional project filter ('*' for all).
     * @param ecosystem - Optional ecosystem filter ('*' for all).
     * @returns Array of matching nodes.
     */
    async getTopology(limit: number = 300): Promise<{ nodes: any[]; edges: any[] }> {
        await this.initialize();

        try {
            const nodes: any[] = [];
            const edges: any[] = [];

            // LoreNode (knowledge) — decisions, conventions, bug patterns, etc.
            const loreNodesResult = await this.connection.query(`MATCH (n:LoreNode) RETURN n LIMIT ${limit}`) as any;
            for (const row of await loreNodesResult.getAll()) {
                const n: any = row['n'];
                nodes.push({ id: n.id, label: n.label, type: n.type, project: n.project, group: n.type });
            }
            const loreEdgesResult = await this.connection.query(
                `MATCH (n:LoreNode)-[e:LoreEdge]->(m:LoreNode) RETURN n.id AS source, e.relation AS relation, m.id AS target LIMIT ${limit}`,
            ) as any;
            for (const row of await loreEdgesResult.getAll()) {
                edges.push({ from: row['source'], to: row['target'], label: row['relation'] });
            }

            // V2.1: CodeFile nodes + FileContains edges + LoreTouchesFile edges.
            try {
                const fileNodesResult = await this.connection.query(`MATCH (f:CodeFile) RETURN f LIMIT ${limit}`) as any;
                for (const row of await fileNodesResult.getAll()) {
                    const f: any = row['f'];
                    nodes.push({
                        id: `file:${f.path}`,
                        label: (f.path as string).split('/').slice(-2).join('/'),
                        type: 'code_file',
                        project: f.repo,
                        group: 'code_file',
                    });
                }
                const fcResult = await this.connection.query(
                    `MATCH (f:CodeFile)-[:FileContains]->(s:CodeSymbol) RETURN f.path AS fpath, s.uid AS suid LIMIT ${limit * 4}`,
                ) as any;
                for (const row of await fcResult.getAll()) {
                    edges.push({ from: `file:${row['fpath']}`, to: `symbol:${row['suid']}`, label: 'contains' });
                }
                const ltResult = await this.connection.query(
                    `MATCH (n:LoreNode)-[r:LoreTouchesFile]->(f:CodeFile) RETURN n.id AS nid, f.path AS fpath, r.relation AS rel LIMIT ${limit}`,
                ) as any;
                for (const row of await ltResult.getAll()) {
                    edges.push({ from: row['nid'], to: `file:${row['fpath']}`, label: row['rel'] ?? 'touches' });
                }
            } catch {
                // CodeFile tables missing on older graphs; ignore
            }

            // CodeSymbol nodes + CodeRelation edges + LoreAppliesToCode edges.
            try {
                const symNodesResult = await this.connection.query(`MATCH (s:CodeSymbol) RETURN s LIMIT ${limit * 4}`) as any;
                for (const row of await symNodesResult.getAll()) {
                    const s: any = row['s'];
                    nodes.push({
                        id: `symbol:${s.uid}`,
                        label: s.name,
                        type: 'code_symbol',
                        project: s.repo,
                        group: 'code_symbol',
                    });
                }
                const crResult = await this.connection.query(
                    `MATCH (a:CodeSymbol)-[e:CodeRelation]->(b:CodeSymbol) RETURN a.uid AS src, e.type AS rel, b.uid AS dst LIMIT ${limit * 4}`,
                ) as any;
                for (const row of await crResult.getAll()) {
                    edges.push({ from: `symbol:${row['src']}`, to: `symbol:${row['dst']}`, label: row['rel'] });
                }
                const laResult = await this.connection.query(
                    `MATCH (n:LoreNode)-[e:LoreAppliesToCode]->(s:CodeSymbol) RETURN n.id AS nid, s.uid AS suid, e.relation AS rel LIMIT ${limit}`,
                ) as any;
                for (const row of await laResult.getAll()) {
                    edges.push({ from: row['nid'], to: `symbol:${row['suid']}`, label: row['rel'] ?? 'applies_to' });
                }
            } catch {
                // CodeSymbol tables missing on older graphs; ignore
            }

            return { nodes, edges };
        } catch (error) {
            throw new LoreGraphError(
                'Failed to extract graph topology',
                'getTopology',
                error,
            );
        }
    }

    /**
     * listNodes — List all nodes with optional type/tag/scope filters.
     *
     * @param type - Optional node type filter.
     * @param tag - Optional tag filter (substring match).
     * @param project - Optional project filter ('*' for all).
     * @param ecosystem - Optional ecosystem filter ('*' for all).
     * @returns Array of matching nodes.
     */
    async listNodes(
        type?: string,
        tag?: string,
        project: string = '*',
        ecosystem: string = '*',
    ): Promise<LoreNode[]> {
        await this.initialize();

        try {
            let cypher = 'MATCH (n:LoreNode) WHERE true';

            if (type) {
                cypher += ` AND n.type = '${this.escapeString(type)}'`;
            }
            if (tag) {
                cypher += ` AND lower(n.tags) CONTAINS '${this.escapeString(tag.toLowerCase())}'`;
            }
            if (project !== '*') {
                cypher += ` AND (n.project = '${this.escapeString(project)}' OR n.project = '*')`;
            }
            if (ecosystem !== '*') {
                cypher += ` AND (n.ecosystem = '${this.escapeString(ecosystem)}' OR n.ecosystem = '*')`;
            }

            cypher += ' RETURN n.* ORDER BY n.updatedAt DESC';

            const result = await this.connection.query(cypher) as QueryResult;
            const rows = await result.getAll();

            return rows.map((row) => this.rowToLoreNode(row as Record<string, unknown>));
        } catch (error) {
            throw new LoreGraphError(
                'Failed to list nodes',
                'listNodes',
                error,
            );
        }
    }

    /**
     * deleteNode — Remove a node and all its edges.
     *
     * @param id - Node ID to delete.
     * @returns true if the node existed and was deleted.
     *
     * Side Effects: Removes node and connected edges from Kùzu database.
     */
    async deleteNode(id: string): Promise<boolean> {
        await this.initialize();

        const existingNode = await this.getNode(id);
        if (!existingNode) return false;

        const escaped = this.escapeString(id);
        try {
            // Delete all edges connected to this node (both directions)
            await this.connection.query(
                `MATCH (n:LoreNode {id: '${escaped}'})-[e:LoreEdge]-() DELETE e`,
            );
            // Delete the node itself
            await this.connection.query(
                `MATCH (n:LoreNode {id: '${escaped}'}) DELETE n`,
            );

            return true;
        } catch (error) {
            throw new LoreGraphError(
                `Failed to delete node '${id}'`,
                'deleteNode',
                error,
            );
        }
    }

    /**
     * getStats — Return summary statistics for the graph.
     *
     * @returns Node count, edge count, and type breakdown.
     */
    async getStats(): Promise<GraphStats> {
        await this.initialize();

        try {
            const nodeResult = await this.connection.query(
                'MATCH (n:LoreNode) RETURN count(n) AS cnt',
            ) as QueryResult;
            const nodeRows = await nodeResult.getAll();
            const nodeCount = (nodeRows[0] as Record<string, unknown>)?.['cnt'] as number ?? 0;

            const edgeResult = await this.connection.query(
                'MATCH ()-[e:LoreEdge]->() RETURN count(e) AS cnt',
            ) as QueryResult;
            const edgeRows = await edgeResult.getAll();
            const edgeCount = (edgeRows[0] as Record<string, unknown>)?.['cnt'] as number ?? 0;

            const typeResult = await this.connection.query(
                'MATCH (n:LoreNode) RETURN n.type AS type, count(n) AS cnt',
            ) as QueryResult;
            const typeRows = await typeResult.getAll();
            const typeBreakdown: Record<string, number> = {};
            for (const row of typeRows) {
                const record = row as Record<string, unknown>;
                const nodeType = record['type'] as string;
                const count = record['cnt'] as number;
                if (nodeType) typeBreakdown[nodeType] = count;
            }

            // Code intelligence stats
            let codeSymbolCount = 0;
            let codeRelationCount = 0;
            try {
                const codeResult = await this.connection.query(
                    'MATCH (s:CodeSymbol) RETURN count(s) AS cnt',
                ) as QueryResult;
                const codeRows = await codeResult.getAll();
                codeSymbolCount = (codeRows[0] as Record<string, unknown>)?.['cnt'] as number ?? 0;

                const codeRelResult = await this.connection.query(
                    'MATCH ()-[r:CodeRelation]->() RETURN count(r) AS cnt',
                ) as QueryResult;
                const codeRelRows = await codeRelResult.getAll();
                codeRelationCount = (codeRelRows[0] as Record<string, unknown>)?.['cnt'] as number ?? 0;
            } catch {
                // Code tables may not exist in older graphs
            }

            return { nodeCount, edgeCount, typeBreakdown, codeSymbolCount, codeRelationCount };
        } catch (error) {
            throw new LoreGraphError(
                'Failed to get stats',
                'getStats',
                error,
            );
        }
    }

    /**
     * lintGraph — Perform health checks manually on the graph.
     *
     * Purpose: Identifies orphaned knowledge nodes and code links to missing symbols.
     *
     * @returns Array of warning strings.
     */
    async lintGraph(): Promise<string[]> {
        await this.initialize();
        const warnings: string[] = [];

        try {
            // Rule 1: Orphaned nodes (no edges, excluding simple notes)
            const orphanQuery = `MATCH (n:LoreNode) WHERE NOT (n)-[]-() AND n.type <> 'note' RETURN n.id AS id, n.type AS type`;
            const orphanResult = await this.connection.query(orphanQuery) as QueryResult;
            for (const row of await orphanResult.getAll()) {
                const record = row as Record<string, unknown>;
                warnings.push(`Orphan: ${record['type']} node '${record['id']}' has no relationships.`);
            }

            // Rule 2: Bug patterns missing code links
            try {
                const bugQuery = `MATCH (n:LoreNode) WHERE n.type = 'bug_pattern' AND NOT (n)-[:LoreAppliesToCode]->(:CodeSymbol) RETURN n.id AS id`;
                const bugResult = await this.connection.query(bugQuery) as QueryResult;
                for (const row of await bugResult.getAll()) {
                    const record = row as Record<string, unknown>;
                    warnings.push(`Missing Link: bug_pattern '${record['id']}' is not linked to any CodeSymbol.`);
                }
            } catch {
                // Ignore if Code tables aren't indexed yet
            }

            return warnings;
        } catch (error) {
            throw new LoreGraphError('Failed to lint graph', 'lintGraph', error);
        }
    }

    /**
     * getUnsyncedNodes — Retrieve nodes not yet synced to hosted DB.
     *
     * Purpose: Used by the sync engine to find nodes that need to be
     *   pushed to SurrealDB.
     *
     * @returns Array of nodes with null or empty syncedAt.
     */
    async getUnsyncedNodes(): Promise<LoreNode[]> {
        await this.initialize();

        try {
            const result = await this.connection.query(
                `MATCH (n:LoreNode) WHERE n.syncedAt = '' RETURN n.*`,
            ) as QueryResult;
            const rows = await result.getAll();
            return rows.map((row) => this.rowToLoreNode(row as Record<string, unknown>));
        } catch (error) {
            throw new LoreGraphError(
                'Failed to get unsynced nodes',
                'getUnsyncedNodes',
                error,
            );
        }
    }

    /**
     * markSynced — Mark a node as synced to hosted DB.
     *
     * @param id - Node ID to mark.
     */
    async markSynced(id: string): Promise<void> {
        await this.initialize();
        const now = new Date().toISOString();

        try {
            const stmt = await this.connection.prepare(
                `MATCH (n:LoreNode {id: $id}) SET n.syncedAt = $syncedAt`,
            );
            await this.connection.execute(stmt, { id, syncedAt: now });
        } catch (error) {
            throw new LoreGraphError(
                `Failed to mark '${id}' as synced`,
                'markSynced',
                error,
            );
        }
    }

    /**
     * close — Gracefully close the database connection.
     *
     * Side Effects: Closes Kùzu connection and database handles.
     */
    /**
     * V2.1 / Option C — returns a narrow query surface plugins can use
     * to register their own schema + read/write their own nodes without
     * importing this class directly. See src/plugins/types.ts
     * (PluginGraphContext) for the contract.
     *
     * This method intentionally returns an opaque shape rather than the
     * raw Connection so plugins can't reach into LocalGraph internals.
     */
    createPluginGraphContext(): {
        executeQuery(cypher: string, params?: Record<string, unknown>): Promise<unknown>;
        queryRows(cypher: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
    } {
        return {
            executeQuery: async (cypher: string, params?: Record<string, unknown>) => {
                await this.initialize();
                if (!params || Object.keys(params).length === 0) {
                    return await this.connection.query(cypher);
                }
                const stmt = await this.connection.prepare(cypher);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return await this.connection.execute(stmt, params as any);
            },
            queryRows: async (cypher: string, params?: Record<string, unknown>) => {
                await this.initialize();
                let result: QueryResult;
                if (!params || Object.keys(params).length === 0) {
                    result = await this.connection.query(cypher) as QueryResult;
                } else {
                    const stmt = await this.connection.prepare(cypher);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    result = await this.connection.execute(stmt, params as any) as QueryResult;
                }
                const rows = await result.getAll();
                return rows as Array<Record<string, unknown>>;
            },
        };
    }

    async close(): Promise<void> {
        try {
            await this.connection.close();
            await this.database.close();
        } catch {
            // Ignore close errors
        }
        this.initialized = false;
    }

    /* ─── Private Helpers ─────────────────────────────────────────── */

    /**
     * escapeString — Escape single quotes for inline Cypher values.
     *
     * Used for queries where parameterized execution is not possible
     * (e.g., dynamic CONTAINS). Prevents Cypher injection.
     */
    private escapeString(value: string): string {
        return value.replace(/'/g, "\\'");
    }

    /**
     * rowToLoreNode — Convert a Kùzu result row to a LoreNode.
     *
     * @param row - Record from getAll() or getNext().
     * @returns Typed LoreNode.
     */
    private rowToLoreNode(row: Record<string, unknown>): LoreNode {
        // kuzu-lite getAll() returns keys like "n.id", "n.label", etc.
        // Handle both prefixed ("n.id") and unprefixed ("id") keys.
        const getValue = (key: string): unknown => {
            return row[key] ?? row[`n.${key}`] ?? row[`connected.${key}`] ?? undefined;
        };

        return {
            id: (getValue('id') as string) ?? '',
            type: (getValue('type') as LoreNode['type']) ?? 'note',
            label: (getValue('label') as string) ?? '',
            content: (getValue('content') as string) ?? '',
            tags: (getValue('tags') as string) ?? '',
            project: (getValue('project') as string) ?? '*',
            ecosystem: (getValue('ecosystem') as string) ?? '*',
            metadata: (getValue('metadata') as string) ?? '{}',
            createdAt: (getValue('createdAt') as string) ?? '',
            updatedAt: (getValue('updatedAt') as string) ?? '',
            syncedAt: (getValue('syncedAt') as string) || null,
            security_scopes: (getValue('security_scopes') as string[]) ?? [],
        };
    }

    /* ─── Code Intelligence Methods ───────────────────────────────── */

    /**
     * upsertCodeSymbol — Create or update a code symbol.
     *
     * @param symbol - The code symbol to upsert.
     *
     * Side Effects: Writes to Kùzu CodeSymbol table.
     * Idempotency: Yes — upsert by uid.
     */
    // V2.1 / Option C: upsertCodeFile, addFileContains, addLoreTouchesFile,
    // ingestFilesFromSymbols all moved to src/plugins/developer/operations.ts.
    // Callers reach them via pluginRegistry.get('developer')?.api.

    async upsertCodeSymbol(symbol: CodeSymbol): Promise<void> {
        await this.initialize();

        try {
            const stmt = await this.connection.prepare(
                `MERGE (s:CodeSymbol {uid: $uid})
                 SET s.name = $name, s.kind = $kind, s.filePath = $filePath,
                     s.startLine = $startLine, s.endLine = $endLine,
                     s.content = $content, s.signature = $signature,
                     s.returnType = $returnType, s.parameterCount = $parameterCount,
                     s.repo = $repo`,
            );
            await this.connection.execute(stmt, {
                uid: symbol.uid,
                name: symbol.name,
                kind: symbol.kind,
                filePath: symbol.filePath,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
                content: symbol.content,
                signature: symbol.signature,
                returnType: symbol.returnType,
                parameterCount: symbol.parameterCount,
                repo: symbol.repo,
            });
        } catch (error) {
            throw new LoreGraphError(
                `Failed to upsert code symbol '${symbol.uid}'`,
                'upsertCodeSymbol',
                error,
            );
        }
    }

    /**
     * addCodeRelation — Create a relationship between two code symbols.
     *
     * @param edge - Source uid, target uid, type, confidence, reason.
     *
     * Side Effects: Writes to Kùzu CodeRelation table.
     */
    async addCodeRelation(edge: CodeRelationEdge): Promise<void> {
        await this.initialize();

        try {
            const stmt = await this.connection.prepare(
                `MATCH (a:CodeSymbol {uid: $sourceUid}), (b:CodeSymbol {uid: $targetUid})
                 CREATE (a)-[:CodeRelation {type: $type, confidence: $confidence, reason: $reason}]->(b)`,
            );
            await this.connection.execute(stmt, {
                sourceUid: edge.sourceUid,
                targetUid: edge.targetUid,
                type: edge.type,
                confidence: edge.confidence,
                reason: edge.reason,
            });
        } catch (error) {
            throw new LoreGraphError(
                `Failed to add code relation ${edge.sourceUid} → ${edge.targetUid}`,
                'addCodeRelation',
                error,
            );
        }
    }

    /**
     * linkKnowledgeToCode — Create a cross-pillar edge.
     *
     * Purpose: Links a knowledge node (decision, convention, bug) to a code
     *   symbol. This is the "killer feature" — cross-pillar traversal.
     *
     * @param nodeId - LoreNode ID.
     * @param symbolUid - CodeSymbol UID.
     * @param relation - Relationship type (e.g., "applies_to", "documents").
     *
     * Side Effects: Writes to Kùzu LoreAppliesToCode table.
     */
    async linkKnowledgeToCode(nodeId: string, symbolUid: string, relation: string): Promise<void> {
        await this.initialize();

        try {
            const stmt = await this.connection.prepare(
                `MATCH (n:LoreNode {id: $nodeId}), (s:CodeSymbol {uid: $symbolUid})
                 CREATE (n)-[:LoreAppliesToCode {relation: $relation}]->(s)`,
            );
            await this.connection.execute(stmt, { nodeId, symbolUid, relation });
        } catch (error) {
            throw new LoreGraphError(
                `Failed to link '${nodeId}' → '${symbolUid}'`,
                'linkKnowledgeToCode',
                error,
            );
        }
    }

    /**
     * queryCodeSymbols — Search code symbols by name or file path.
     *
     * @param query - Search string (matched against name and filePath).
     * @param repo - Optional repository filter.
     * @param limit - Maximum results (default: 20).
     * @returns Matching code symbols.
     */
    async queryCodeSymbols(query: string, repo?: string, limit: number = 20): Promise<CodeSymbol[]> {
        await this.initialize();

        try {
            const escapedQuery = this.escapeString(query.toLowerCase());
            let cypher = `MATCH (s:CodeSymbol)
                          WHERE lower(s.name) CONTAINS '${escapedQuery}'
                             OR lower(s.filePath) CONTAINS '${escapedQuery}'`;
            if (repo) {
                cypher += ` AND s.repo = '${this.escapeString(repo)}'`;
            }
            cypher += ` RETURN s.* LIMIT ${limit}`;

            const result = await this.connection.query(cypher) as QueryResult;
            const rows = await result.getAll();
            return rows.map((row) => this.rowToCodeSymbol(row as Record<string, unknown>));
        } catch (error) {
            throw new LoreGraphError(
                `Failed to query code symbols '${query}'`,
                'queryCodeSymbols',
                error,
            );
        }
    }

    /**
     * getCodeSymbolContext — Get a symbol and all its relationships.
     *
     * @param uid - CodeSymbol UID.
     * @returns The symbol with its callers, callees, and connected knowledge.
     */
    async getCodeSymbolContext(uid: string): Promise<{
        symbol: CodeSymbol | null;
        callers: CodeSymbol[];
        callees: CodeSymbol[];
        knowledge: LoreNode[];
    }> {
        await this.initialize();

        try {
            // Get the symbol
            const symResult = await this.connection.query(
                `MATCH (s:CodeSymbol {uid: '${this.escapeString(uid)}'}) RETURN s.*`,
            ) as QueryResult;
            const symRows = await symResult.getAll();
            const symbol = symRows.length > 0
                ? this.rowToCodeSymbol(symRows[0] as Record<string, unknown>)
                : null;

            // Get callers (who calls this symbol)
            const callersResult = await this.connection.query(
                `MATCH (caller:CodeSymbol)-[:CodeRelation {type: 'CALLS'}]->(s:CodeSymbol {uid: '${this.escapeString(uid)}'})
                 RETURN caller.*`,
            ) as QueryResult;
            const callerRows = await callersResult.getAll();
            const callers = callerRows.map((row) => this.rowToCodeSymbol(row as Record<string, unknown>, 'caller'));

            // Get callees (what this symbol calls)
            const calleesResult = await this.connection.query(
                `MATCH (s:CodeSymbol {uid: '${this.escapeString(uid)}'})-[:CodeRelation {type: 'CALLS'}]->(callee:CodeSymbol)
                 RETURN callee.*`,
            ) as QueryResult;
            const calleeRows = await calleesResult.getAll();
            const callees = calleeRows.map((row) => this.rowToCodeSymbol(row as Record<string, unknown>, 'callee'));

            // Get connected knowledge
            const knowledgeResult = await this.connection.query(
                `MATCH (n:LoreNode)-[:LoreAppliesToCode]->(s:CodeSymbol {uid: '${this.escapeString(uid)}'})
                 RETURN n.*`,
            ) as QueryResult;
            const knowledgeRows = await knowledgeResult.getAll();
            const knowledge = knowledgeRows.map((row) => this.rowToLoreNode(row as Record<string, unknown>));

            return { symbol, callers, callees, knowledge };
        } catch (error) {
            throw new LoreGraphError(
                `Failed to get context for '${uid}'`,
                'getCodeSymbolContext',
                error,
            );
        }
    }

    /**
     * getCrossPillarEdges — Get all knowledge↔code edges for a repo.
     *
     * Purpose: Called before clearCodeSymbols to save cross-pillar edges
     *   so they can be restored after re-indexing. Prevents knowledge links
     *   from being orphaned when code symbols are refreshed.
     *
     * @param repo - Repository name to filter by.
     * @returns Array of cross-pillar edge data (nodeId, symbolUid, relation).
     *
     * Side Effects: Reads from Kùzu database.
     */
    async getCrossPillarEdges(repo: string): Promise<{ nodeId: string; symbolUid: string; relation: string }[]> {
        await this.initialize();

        try {
            const result = await this.connection.query(
                `MATCH (n:LoreNode)-[r:LoreAppliesToCode]->(s:CodeSymbol {repo: '${this.escapeString(repo)}'})
                 RETURN n.id AS nodeId, s.uid AS symbolUid, r.relation AS relation`,
            ) as QueryResult;
            const rows = await result.getAll();

            return rows.map((row) => {
                const record = row as Record<string, unknown>;
                return {
                    nodeId: (record['nodeId'] as string) ?? '',
                    symbolUid: (record['symbolUid'] as string) ?? '',
                    relation: (record['relation'] as string) ?? 'applies_to',
                };
            });
        } catch {
            // Table may not exist yet — return empty
            return [];
        }
    }

    /**
     * clearCodeSymbols — Remove all code symbols for a repo (before re-index).
     *
     * @param repo - Repository name to clear.
     * @returns Number of symbols removed.
     */
    async clearCodeSymbols(repo: string): Promise<number> {
        await this.initialize();

        try {
            // Count first
            const countResult = await this.connection.query(
                `MATCH (s:CodeSymbol {repo: '${this.escapeString(repo)}'}) RETURN count(s) AS cnt`,
            ) as QueryResult;
            const countRows = await countResult.getAll();
            const count = (countRows[0] as Record<string, unknown>)?.['cnt'] as number ?? 0;

            // Delete edges first, then nodes
            await this.connection.query(
                `MATCH (s:CodeSymbol {repo: '${this.escapeString(repo)}'})-[r:CodeRelation]->() DELETE r`,
            );
            await this.connection.query(
                `MATCH ()-[r:CodeRelation]->(s:CodeSymbol {repo: '${this.escapeString(repo)}'}) DELETE r`,
            );
            await this.connection.query(
                `MATCH ()-[r:LoreAppliesToCode]->(s:CodeSymbol {repo: '${this.escapeString(repo)}'}) DELETE r`,
            );
            await this.connection.query(
                `MATCH (s:CodeSymbol {repo: '${this.escapeString(repo)}'}) DELETE s`,
            );

            return count;
        } catch (error) {
            throw new LoreGraphError(
                `Failed to clear code symbols for '${repo}'`,
                'clearCodeSymbols',
                error,
            );
        }
    }

    /**
     * rowToCodeSymbol — Convert a Kùzu result row to a CodeSymbol.
     */
    private rowToCodeSymbol(row: Record<string, unknown>, prefix: string = 's'): CodeSymbol {
        const getValue = (key: string): unknown => {
            return row[key] ?? row[`${prefix}.${key}`] ?? undefined;
        };

        return {
            uid: (getValue('uid') as string) ?? '',
            name: (getValue('name') as string) ?? '',
            kind: (getValue('kind') as string) ?? '',
            filePath: (getValue('filePath') as string) ?? '',
            startLine: (getValue('startLine') as number) ?? 0,
            endLine: (getValue('endLine') as number) ?? 0,
            content: (getValue('content') as string) ?? '',
            signature: (getValue('signature') as string) ?? '',
            returnType: (getValue('returnType') as string) ?? '',
            parameterCount: (getValue('parameterCount') as number) ?? 0,
            repo: (getValue('repo') as string) ?? '',
        };
    }

    /* ─── Code Graph Helpers (for native tools) ────────────────── */

    /**
     * queryCodeSymbolsByName — Find code symbols by exact name match.
     *
     * @param name - Exact symbol name to match.
     * @returns Matching CodeSymbol records.
     *
     * Side Effects: Reads from Kùzu database.
     */
    async queryCodeSymbolsByName(name: string): Promise<CodeSymbol[]> {
        await this.initialize();
        try {
            const result = await this.connection.query(
                `MATCH (s:CodeSymbol) WHERE s.name = '${this.escapeString(name)}' RETURN s.*`,
            ) as QueryResult;
            const rows = await result.getAll();
            return rows.map((row) => this.rowToCodeSymbol(row as Record<string, unknown>));
        } catch {
            return [];
        }
    }

    /**
     * getCodeSymbolByUid — Get a single code symbol by its UID.
     *
     * @param uid - CodeSymbol UID.
     * @returns The symbol, or null if not found.
     *
     * Side Effects: Reads from Kùzu database.
     */
    async getCodeSymbolByUid(uid: string): Promise<CodeSymbol | null> {
        await this.initialize();
        try {
            const result = await this.connection.query(
                `MATCH (s:CodeSymbol {uid: '${this.escapeString(uid)}'}) RETURN s.*`,
            ) as QueryResult;
            const rows = await result.getAll();
            return rows.length > 0 ? this.rowToCodeSymbol(rows[0] as Record<string, unknown>) : null;
        } catch {
            return null;
        }
    }

    /**
     * getCodeRelationsTo — Get all incoming code relations to a symbol.
     *
     * Purpose: Finds all symbols that reference the target (callers, importers,
     *   extenders). Used by the native rename tool to find all references.
     *
     * @param targetUid - UID of the target symbol.
     * @returns Array of CodeRelationEdge records pointing to the target.
     *
     * Side Effects: Reads from Kùzu database.
     */
    async getCodeRelationsTo(targetUid: string): Promise<CodeRelationEdge[]> {
        await this.initialize();
        try {
            const result = await this.connection.query(
                `MATCH (source:CodeSymbol)-[r:CodeRelation]->(target:CodeSymbol {uid: '${this.escapeString(targetUid)}'})
                 RETURN source.uid AS sourceUid, target.uid AS targetUid,
                        r.type AS type, r.confidence AS confidence, r.reason AS reason`,
            ) as QueryResult;
            const rows = await result.getAll();
            return rows.map((row) => {
                const record = row as Record<string, unknown>;
                return {
                    sourceUid: (record['sourceUid'] as string) ?? '',
                    targetUid: (record['targetUid'] as string) ?? '',
                    type: (record['type'] as string) ?? '',
                    confidence: (record['confidence'] as number) ?? 1.0,
                    reason: (record['reason'] as string) ?? '',
                };
            });
        } catch {
            return [];
        }
    }

    /* ─── DevActivity (Team Awareness) ────────────────────────── */

    /**
     * recordDevActivity — Upsert a developer activity heartbeat.
     *
     * Purpose: Records what a developer is currently working on.
     *   Each developer gets one activity record per project, updated
     *   in-place on each heartbeat (MERGE on id).
     *
     * @param activity - DevActivity event to record.
     *
     * Side Effects: Writes to Kùzu DevActivity table.
     * Idempotency: Yes — MERGE upserts.
     * Determinism: Deterministic.
     */
    async recordDevActivity(activity: DevActivity): Promise<void> {
        await this.initialize();

        const activityId = `${activity.dev}::${activity.project}`;
        try {
            const stmt = await this.connection.prepare(
                `MERGE (a:DevActivity {id: $id})
                 SET a.dev = $dev, a.project = $project, a.action = $action,
                     a.filePath = $filePath, a.timestamp = $timestamp, a.tool = $tool`,
            );
            await this.connection.execute(stmt, {
                id: activityId,
                dev: activity.dev,
                project: activity.project,
                action: activity.action,
                filePath: activity.filePath,
                timestamp: activity.timestamp,
                tool: activity.tool,
            });
        } catch (error) {
            throw new LoreGraphError(
                `Failed to record activity for '${activity.dev}'`,
                'recordDevActivity',
                error,
            );
        }
    }

    /**
     * getActiveDevs — Query currently active developers.
     *
     * Purpose: Returns DevActivity records updated within the last N minutes.
     *   Used by the who_is_working MCP tool for team awareness.
     *
     * @param project - Optional project filter.
     * @param activeWindowMinutes - How many minutes back counts as "active" (default: 30).
     * @returns Array of active DevActivity records.
     *
     * Side Effects: Reads from Kùzu database.
     * Determinism: Non-deterministic (time-dependent).
     */
    async getActiveDevs(project?: string, activeWindowMinutes: number = 30): Promise<DevActivity[]> {
        await this.initialize();

        try {
            let cypher = `MATCH (a:DevActivity) RETURN a`;
            if (project) {
                cypher = `MATCH (a:DevActivity) WHERE a.project = '${this.escapeString(project)}' RETURN a`;
            }

            const result = await this.connection.query(cypher) as QueryResult;
            const rows = await result.getAll();

            const cutoff = new Date(Date.now() - activeWindowMinutes * 60 * 1000).toISOString();

            return rows
                .map((row) => {
                    const record = row as Record<string, unknown>;
                    const getField = (key: string): unknown => record[key] ?? record[`a.${key}`] ?? undefined;
                    return {
                        dev: (getField('dev') as string) ?? '',
                        project: (getField('project') as string) ?? '',
                        action: (getField('action') as string) ?? '',
                        filePath: (getField('filePath') as string) ?? '',
                        timestamp: (getField('timestamp') as string) ?? '',
                        tool: (getField('tool') as string) ?? '',
                    };
                })
                .filter((activity) => activity.timestamp >= cutoff);
        } catch {
            // Table may not exist yet
            return [];
        }
    }

    /**
     * clearStaleActivity — Remove activity records older than a threshold.
     *
     * Purpose: Garbage collection for stale heartbeats. Called periodically
     *   or on sync to prevent unbounded growth.
     *
     * @param olderThanMinutes - Remove records older than this (default: 60).
     * @returns Number of records removed.
     *
     * Side Effects: Deletes from Kùzu DevActivity table.
     */
    async clearStaleActivity(olderThanMinutes: number = 60): Promise<number> {
        await this.initialize();

        try {
            const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
            const countResult = await this.connection.query(
                `MATCH (a:DevActivity) WHERE a.timestamp < '${cutoff}' RETURN count(a) AS cnt`,
            ) as QueryResult;
            const countRows = await countResult.getAll();
            const count = (countRows[0] as Record<string, unknown>)?.['cnt'] as number ?? 0;

            if (count > 0) {
                await this.connection.query(
                    `MATCH (a:DevActivity) WHERE a.timestamp < '${cutoff}' DELETE a`,
                );
            }

            return count;
        } catch {
            return 0;
        }
    }
}


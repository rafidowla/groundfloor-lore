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
                    legalHold BOOLEAN DEFAULT FALSE,
                    PRIMARY KEY (id)
                )
            `);

            // ─── Relationship Tables ────────────────────────────────────
            // C1 (Phase 1) — confidence tiers on every edge. Defaults mean
            // pre-C1 callers get the conservative 'extracted' interpretation;
            // reconnect explicitly tags its edges as 'inferred'.
            await this.connection.query(`
                CREATE REL TABLE IF NOT EXISTS LoreEdge (
                    FROM LoreNode TO LoreNode,
                    relation STRING,
                    confidence STRING DEFAULT 'extracted',
                    confidenceScore DOUBLE DEFAULT 1.0
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
                // C1 edge-confidence migration. Existing DBs get the columns
                // with their defaults; the backfill pass below retags legacy
                // semantic-reconnect edges as 'inferred'.
                `ALTER TABLE LoreEdge ADD confidence STRING DEFAULT 'extracted'`,
                `ALTER TABLE LoreEdge ADD confidenceScore DOUBLE DEFAULT 1.0`,
                // C-ent0 (Phase 1) inert enterprise hook. Every LoreNode gets
                // a legalHold flag, default false. No core code enforces it
                // today — this is groundwork. When an enterprise plugin ships
                // a RetentionPolicy, the delete path will consult this field.
                `ALTER TABLE LoreNode ADD legalHold BOOLEAN DEFAULT FALSE`,
            ];
            for (const migration of migrations) {
                try {
                    await this.connection.query(migration);
                } catch {
                    // Column already exists — expected, ignore
                }
            }

            // ─── C1 Backfill: retag reconnect-authored semantic edges ───
            // Pre-C1 reconnect encoded confidence in the relation string
            // (`semantic_neighbor:0.823`). After the ALTER above they'd all
            // sit at the default confidence='extracted' + score=1.0, which
            // is wrong. This pass:
            //   1. Flips confidence to 'inferred' for every semantic edge.
            //   2. Parses the similarity score out of the relation suffix
            //      and writes it to confidenceScore.
            //
            // Idempotent: only touches edges whose stored score is still
            // the default 1.0 AND have the semantic_neighbor prefix. Once
            // a score is properly stored, we don't re-parse it.
            try {
                const retagStmt = await this.connection.prepare(
                    `MATCH ()-[e:LoreEdge]->()
                     WHERE e.relation STARTS WITH 'semantic_neighbor:'
                       AND e.confidence = 'extracted'
                     SET e.confidence = 'inferred'`,
                );
                await this.connection.execute(retagStmt, {});

                // Read back every inferred edge whose score is still the
                // default and parse the suffix. Iterating in JS is simpler
                // than embedding substring parsing in Cypher.
                const toScoreStmt = await this.connection.prepare(
                    `MATCH (a:LoreNode)-[e:LoreEdge]->(b:LoreNode)
                     WHERE e.confidence = 'inferred'
                       AND e.confidenceScore = 1.0
                       AND e.relation STARTS WITH 'semantic_neighbor:'
                     RETURN a.id AS src, b.id AS tgt, e.relation AS rel`,
                );
                const toScoreRes = await this.connection.execute(toScoreStmt, {}) as QueryResult;
                const rows = await toScoreRes.getAll();
                let rescored = 0;
                for (const row of rows) {
                    const r = row as Record<string, unknown>;
                    const rel = String(r['rel'] ?? '');
                    const m = /^semantic_neighbor:([0-9]+(\.[0-9]+)?)$/.exec(rel);
                    if (!m) continue;
                    const score = parseFloat(m[1]);
                    if (!Number.isFinite(score) || score < 0 || score > 1) continue;
                    const upd = await this.connection.prepare(
                        `MATCH (a:LoreNode {id: $src})-[e:LoreEdge]->(b:LoreNode {id: $tgt})
                         WHERE e.relation = $rel AND e.confidenceScore = 1.0
                         SET e.confidenceScore = $score`,
                    );
                    await this.connection.execute(upd, {
                        src: String(r['src']),
                        tgt: String(r['tgt']),
                        rel,
                        score,
                    });
                    rescored++;
                }
                if (rescored > 0) {
                    console.error(`[LocalGraph] C1 backfill: rescored ${rescored} inferred edges`);
                }
            } catch (backfillErr) {
                // Non-fatal: defaults are safe, just not optimal.
                console.error(
                    `[LocalGraph] C1 backfill pass failed (non-fatal): ${(backfillErr as Error).message}`,
                );
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

        // C1 — confidence tagging. Callers that omit confidence get
        // 'extracted' (user-asserted) with score 1.0, matching the schema
        // default. Reconnect passes 'inferred' + the cosine similarity.
        const confidence = edge.confidence ?? 'extracted';
        const confidenceScore = edge.confidenceScore ?? 1.0;

        try {
            const stmt = await this.connection.prepare(
                `MATCH (a:LoreNode {id: $sourceId}), (b:LoreNode {id: $targetId})
                 CREATE (a)-[:LoreEdge {
                    relation: $relation,
                    confidence: $confidence,
                    confidenceScore: $confidenceScore
                 }]->(b)`,
            );
            await this.connection.execute(stmt, {
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                relation: edge.relation,
                confidence,
                confidenceScore,
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
     * @param edge - Source, target, and relation type (confidence propagates).
     *
     * Side Effects: Writes two edges to Kùzu database.
     */
    async addBidirectionalEdge(edge: LoreEdge): Promise<void> {
        await this.addEdge(edge);
        await this.addEdge({
            sourceId: edge.targetId,
            targetId: edge.sourceId,
            relation: edge.relation,
            confidence: edge.confidence,
            confidenceScore: edge.confidenceScore,
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
        // Depth is used inside a Cypher variable-length pattern bound
        // ([e:LoreEdge* 1..N]) which Kùzu parameters don't substitute into,
        // so it must be a literal. We inline it only after validating it's a
        // small positive integer — never a user-controlled string.
        const clampedDepth = Math.min(Math.max(Math.trunc(maxDepth), 1), 5);
        if (!Number.isInteger(clampedDepth) || clampedDepth < 1 || clampedDepth > 5) {
            throw new LoreGraphError(
                `Invalid traversal depth ${maxDepth}`,
                'traverse',
                null,
            );
        }

        try {
            // `nodeId` goes through a bound parameter — no string interpolation
            // of user input into the query. The depth literal above is already
            // validated as an integer in [1,5].
            const stmt = await this.connection.prepare(
                `MATCH (start:LoreNode)-[e:LoreEdge* 1..${clampedDepth}]->(connected:LoreNode)
                 WHERE start.id = $nodeId
                 RETURN connected.*, length(e) AS depth, e[length(e)-1].relation AS relation`,
            );
            const result = await this.connection.execute(stmt, { nodeId }) as QueryResult;

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

        // Clamp limit to a safe integer range. Kùzu parameters work for
        // literal values including numbers, but the pattern is defense-in-
        // depth — keep the number a number.
        const clampedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);

        try {
            // All user input goes through bound parameters. The WHERE clause
            // is assembled from a fixed set of known-shape fragments; no
            // user string enters the Cypher text.
            const params: Record<string, unknown> = {
                q: query.toLowerCase(),
                limit: clampedLimit,
            };
            let cypher = `MATCH (n:LoreNode) WHERE
                (lower(n.label) CONTAINS $q OR lower(n.content) CONTAINS $q OR lower(n.tags) CONTAINS $q)`;

            if (project !== '*') {
                cypher += ` AND (n.project = $project OR n.project = '*')`;
                params.project = project;
            }
            if (ecosystem !== '*') {
                cypher += ` AND (n.ecosystem = $ecosystem OR n.ecosystem = '*')`;
                params.ecosystem = ecosystem;
            }

            cypher += ` RETURN n.* LIMIT $limit`;

            const stmt = await this.connection.prepare(cypher);
            const result = await this.connection.execute(stmt, params) as QueryResult;
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

            // LoreNode (knowledge) — core memory primitive. Plugins contribute
            // their own topology slices via ILorePlugin.contributeTopology
            // (invoked by callers that have access to the plugin registry;
            // LocalGraph stays plugin-agnostic).
            const loreNodesResult = await this.connection.query(`MATCH (n:LoreNode) RETURN n LIMIT ${limit}`) as any;
            for (const row of await loreNodesResult.getAll()) {
                const n: any = row['n'];
                nodes.push({ id: n.id, label: n.label, type: n.type, project: n.project, group: n.type });
            }
            const loreEdgesResult = await this.connection.query(
                `MATCH (n:LoreNode)-[e:LoreEdge]->(m:LoreNode)
                 RETURN n.id AS source,
                        e.relation AS relation,
                        e.confidence AS confidence,
                        e.confidenceScore AS confidenceScore,
                        m.id AS target
                 LIMIT ${limit}`,
            ) as any;
            for (const row of await loreEdgesResult.getAll()) {
                edges.push({
                    from: row['source'],
                    to: row['target'],
                    label: row['relation'],
                    confidence: row['confidence'] ?? 'extracted',
                    confidenceScore: row['confidenceScore'] ?? 1.0,
                });
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
            const params: Record<string, unknown> = {};
            let cypher = 'MATCH (n:LoreNode) WHERE true';

            if (type) {
                cypher += ` AND n.type = $type`;
                params.type = type;
            }
            if (tag) {
                cypher += ` AND lower(n.tags) CONTAINS $tag`;
                params.tag = tag.toLowerCase();
            }
            if (project !== '*') {
                cypher += ` AND (n.project = $project OR n.project = '*')`;
                params.project = project;
            }
            if (ecosystem !== '*') {
                cypher += ` AND (n.ecosystem = $ecosystem OR n.ecosystem = '*')`;
                params.ecosystem = ecosystem;
            }

            cypher += ' RETURN n.* ORDER BY n.updatedAt DESC';

            const stmt = await this.connection.prepare(cypher);
            const result = await this.connection.execute(stmt, params) as QueryResult;
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

        try {
            // kuzu-lite does NOT support deleting via an undirected relationship
            // pattern ("Binder exception: Delete undirected rel is not supported").
            // Issue two directed deletes — outgoing, then incoming — to clear
            // edges in both directions before removing the node itself.
            const outStmt = await this.connection.prepare(
                `MATCH (n:LoreNode {id: $id})-[e:LoreEdge]->() DELETE e`,
            );
            await this.connection.execute(outStmt, { id });

            const inStmt = await this.connection.prepare(
                `MATCH ()-[e:LoreEdge]->(n:LoreNode {id: $id}) DELETE e`,
            );
            await this.connection.execute(inStmt, { id });

            // Delete the node itself
            const nodeStmt = await this.connection.prepare(
                `MATCH (n:LoreNode {id: $id}) DELETE n`,
            );
            await this.connection.execute(nodeStmt, { id });

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

    // escapeString was removed in Phase 0 / S2 — single-quote escaping
    // is not safe against Cypher injection (comments, backticks, nested
    // quoting all bypass it). All read paths now use prepare/execute
    // with bound parameters. Do NOT reintroduce a string-escape helper;
    // route every user input through parameters instead.

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

    // V2.1 / Option C: all developer-specific graph operations moved to
    // src/plugins/developer/operations.ts. Core callers reach them via
    // pluginRegistry.get('developer')?.api (see DeveloperApi contract).
}

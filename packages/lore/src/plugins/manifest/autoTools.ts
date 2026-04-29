/**
 * autoTools.ts — Per-type / per-relation MCP tools synthesised from a
 * Tier 1 manifest's schema.
 *
 * For every node type declared in `lore.schema.nodeTypes`, this module
 * registers two MCP tools on the per-session McpServer:
 *
 *   store_<type>({ id, label, content?, tags?, ... })
 *     — upserts a node of that type via the same primitives `store_node`
 *       uses (graph.upsertNode + WAL append + verbatim store).
 *   list_<type>({ tag?, limit? })
 *     — lists nodes of that type via the same primitives `list_nodes` uses.
 *
 * For every edge relation declared in `lore.schema.edgeRelations`, this
 * module registers:
 *
 *   connect_<relation>({ sourceId, targetId, bidirectional?, confidence?, confidenceScore? })
 *     — writes an edge of that relation type via the same primitives
 *       `store_edge` uses.
 *
 * Why thin wrappers, not duplicated logic: the auto-tools call into the
 * same engine surfaces (graph, verbatim, WAL) that the canonical
 * `store_node` / `store_edge` tools call. They differ from the canonical
 * tools in two ways:
 *
 *   1. **Type/relation is fixed** — the user doesn't pass it; the
 *      caller already knows from the tool name.
 *   2. **No per-row reconnect hook** — same as the bulk `lore_plugin_ingest`
 *      runner. Reconnect is a separate sweep concern; firing N reconnect
 *      jobs from N rapid auto-tool calls would queue uselessly.
 *
 * Discoverability: an MCP client doing `tools/list` sees `store_greeting`,
 * `list_greeting`, `connect_greets` and immediately knows what the plugin
 * is for. Way clearer than "scroll through the type enum on store_node".
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodTypeAny } from 'zod';

import type { PluginContext } from '../types.js';
import type { PluginManifest, QuerySpec, QueryParameter, RawCypherQuerySpec, PatternQuerySpec } from '../manifest.js';
import { expandPattern, isPatternQueryEntry } from './queryPatterns.js';

/**
 * Minimal interface our handlers need from the substrate. Defined locally
 * so this file doesn't import LocalGraph / VerbatimStore / SyncEngine
 * directly (which would invert the plugin → engine dependency arrow).
 * The shapes match the engine implementations one-for-one.
 */
interface UpsertNodeRequest {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string;
    project: string;
    ecosystem: string;
    metadata: string;
    language: string | null;
}

interface UpsertedNode {
    id: string;
    type: string;
    label: string;
    updatedAt: string;
}

interface AutoToolsGraph {
    upsertNode(req: UpsertNodeRequest): Promise<UpsertedNode>;
    /**
     * Positional signature — see `engines/localGraph.ts:listNodes`.
     * `project = '*'` and `ecosystem = '*'` mean "any scope".
     */
    listNodes(
        type?: string,
        tag?: string,
        project?: string,
        ecosystem?: string,
    ): Promise<Array<{
        id: string;
        type: string;
        label: string;
        tags: string;
        project: string;
        updatedAt: string;
    }>>;
    addEdge(req: {
        sourceId: string;
        targetId: string;
        relation: string;
        confidence?: 'extracted' | 'inferred' | 'ambiguous';
        confidenceScore?: number;
    }): Promise<void>;
    addBidirectionalEdge(req: {
        sourceId: string;
        targetId: string;
        relation: string;
        confidence?: 'extracted' | 'inferred' | 'ambiguous';
        confidenceScore?: number;
    }): Promise<void>;
}

interface AutoToolsVerbatim {
    store(args: {
        id: string;
        text: string;
        metadata: Record<string, unknown>;
    }): Promise<void>;
}

interface AutoToolsSyncEngine {
    getWal(): { append(op: string, payload: Record<string, unknown>): void };
}

/**
 * Subset of LocalGraph our query tools need. `queryRows` lives on the
 * PluginGraphContext returned by `createPluginGraphContext()` — the
 * substrate-portable wrapper plugins normally consume — not on the
 * LocalGraph instance itself.
 */
interface AutoToolsQueryGraph {
    createPluginGraphContext(): {
        queryRows(cypher: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
    };
}

/**
 * Register the auto-tools for one Tier 1 manifest plugin against a
 * given per-session McpServer. Idempotent per session — calling twice
 * registers the same tool name twice (the SDK throws), which matches
 * how every other plugin's `registerTools` behaves.
 */
export function registerAutoTools(
    server: McpServer,
    ctx: PluginContext,
    manifest: PluginManifest,
): void {
    const schema = manifest.lore?.schema;
    if (!schema) return;

    const graph = ctx.graph as AutoToolsGraph;
    const verbatim = ctx.verbatimStore as AutoToolsVerbatim;
    const sync = ctx.syncEngine as AutoToolsSyncEngine;
    const scope = ctx.scope;
    const pluginName = manifest.name;

    for (const nt of schema.nodeTypes ?? []) {
        registerStoreTool(server, nt.name, nt.description, pluginName, graph, verbatim, sync, scope);
        registerListTool(server, nt.name, nt.description, pluginName, graph, scope);
    }

    for (const er of schema.edgeRelations ?? []) {
        registerConnectTool(server, er.name, er.description, pluginName, graph, sync);
    }

    // Query templates — register as `<plugin>_<queryId>` MCP tools.
    // Both raw-cypher and stock-pattern forms route through the same
    // tool-registration path; patterns are expanded into raw-cypher
    // specs at registration time.
    const queries = manifest.lore?.queries ?? [];
    if (queries.length > 0) {
        const queryGraph = ctx.graph as AutoToolsQueryGraph;
        for (const q of queries) {
            let rawSpec: RawCypherQuerySpec;
            if (isPatternQueryEntry(q)) {
                const p = q as unknown as PatternQuerySpec;
                rawSpec = expandPattern({
                    id: p.id,
                    description: p.description,
                    pattern: p.pattern,
                    bindNodeType: p.bindNodeType,
                    parameters: p.parameters,
                });
            } else {
                rawSpec = q as RawCypherQuerySpec;
            }
            registerQueryTool(server, rawSpec, pluginName, queryGraph);
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// store_<type>
// ────────────────────────────────────────────────────────────────────────

function registerStoreTool(
    server: McpServer,
    typeName: string,
    typeDescription: string,
    pluginName: string,
    graph: AutoToolsGraph,
    verbatim: AutoToolsVerbatim,
    sync: AutoToolsSyncEngine,
    scope: { project: string; ecosystem: string },
): void {
    server.tool(
        `store_${typeName}`,
        `Create or update a "${typeName}" node. ${typeDescription} (auto-generated from plugin "${pluginName}".)`,
        {
            id: z.string().describe(`Stable id for this ${typeName} (used for upsert and idempotent re-runs).`),
            label: z.string().describe('Short human-readable title.'),
            content: z.string().optional().describe('Long-form body text. Optional.'),
            tags: z.string().optional().describe('Comma-separated tags. Optional.'),
            project: z.string().optional().describe(`Project scope (defaults to "${scope.project}").`),
            ecosystem: z.string().optional().describe(`Ecosystem scope (defaults to "${scope.ecosystem}").`),
        },
        async ({ id, label, content, tags, project, ecosystem }) => {
            try {
                const scopedProject = project ?? scope.project;
                const scopedEcosystem = ecosystem ?? scope.ecosystem;
                const tagsCsv = tags ?? '';
                const node = await graph.upsertNode({
                    id,
                    type: typeName,
                    label,
                    content: content ?? '',
                    tags: tagsCsv,
                    project: scopedProject,
                    ecosystem: scopedEcosystem,
                    metadata: JSON.stringify({ via: `store_${typeName}`, plugin: pluginName }),
                    language: null,
                });
                sync.getWal().append('upsert_node', { ...node });
                verbatim.store({
                    id: `lore:${id}`,
                    text: buildVerbatimText(label, content ?? '', tagsCsv),
                    metadata: { type: typeName, label, tags: tagsCsv, project: scopedProject, ecosystem: scopedEcosystem, updatedAt: node.updatedAt },
                }).catch((err) => console.error(`[auto-tools] verbatim write failed for ${id}: ${(err as Error).message}`));
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            node: { id: node.id, type: node.type, label: node.label, project: scopedProject, ecosystem: scopedEcosystem },
                            message: `${typeName} '${id}' stored via auto-tool.`,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
            }
        },
    );
}

// ────────────────────────────────────────────────────────────────────────
// list_<type>
// ────────────────────────────────────────────────────────────────────────

function registerListTool(
    server: McpServer,
    typeName: string,
    typeDescription: string,
    pluginName: string,
    graph: AutoToolsGraph,
    scope: { project: string; ecosystem: string },
): void {
    server.tool(
        `list_${typeName}`,
        `List "${typeName}" nodes. ${typeDescription} (auto-generated from plugin "${pluginName}".)`,
        {
            tag: z.string().optional().describe('Filter to nodes carrying this tag.'),
            limit: z.number().int().positive().max(1000).optional().describe('Max rows (default 100).'),
        },
        async ({ tag, limit }) => {
            try {
                // listNodes is positional: (type, tag, project, ecosystem). It
                // doesn't support a server-side limit — slice client-side here.
                const all = await graph.listNodes(typeName, tag);
                const sliced = limit !== undefined ? all.slice(0, limit) : all;
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            count: sliced.length,
                            totalMatching: all.length,
                            scope,
                            filter: { type: typeName, tag: tag ?? 'all' },
                            nodes: sliced,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
            }
        },
    );
}

// ────────────────────────────────────────────────────────────────────────
// connect_<relation>
// ────────────────────────────────────────────────────────────────────────

function registerConnectTool(
    server: McpServer,
    relationName: string,
    relationDescription: string,
    pluginName: string,
    graph: AutoToolsGraph,
    sync: AutoToolsSyncEngine,
): void {
    server.tool(
        `connect_${relationName}`,
        `Create a "${relationName}" edge. ${relationDescription} (auto-generated from plugin "${pluginName}".)`,
        {
            sourceId: z.string().describe('Source node id.'),
            targetId: z.string().describe('Target node id.'),
            bidirectional: z.boolean().optional().describe('Create the edge in both directions (default false).'),
            confidence: z.enum(['extracted', 'inferred', 'ambiguous']).optional()
                .describe('Confidence tier (default "extracted" — user-asserted fact).'),
            confidenceScore: z.number().min(0).max(1).optional()
                .describe('Numeric confidence 0..1, paired with `confidence`.'),
        },
        async ({ sourceId, targetId, bidirectional, confidence, confidenceScore }) => {
            try {
                const req = {
                    sourceId,
                    targetId,
                    relation: relationName,
                    confidence: confidence ?? 'extracted' as const,
                    confidenceScore,
                };
                if (bidirectional) {
                    await graph.addBidirectionalEdge(req);
                } else {
                    await graph.addEdge(req);
                }
                sync.getWal().append('add_edge', { ...req, bidirectional: bidirectional ?? false });
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            edge: { sourceId, targetId, relation: relationName },
                            message: `Edge ${sourceId} -[${relationName}]-> ${targetId} stored via auto-tool.`,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
            }
        },
    );
}

// ────────────────────────────────────────────────────────────────────────
// Query templates → <plugin>_<queryId>
// ────────────────────────────────────────────────────────────────────────

function registerQueryTool(
    server: McpServer,
    spec: RawCypherQuerySpec,
    pluginName: string,
    graph: AutoToolsQueryGraph,
): void {
    const toolName = `${pluginName}_${spec.id}`;
    const argsSchema = buildQueryArgsSchema(spec.parameters ?? []);

    server.tool(
        toolName,
        `${spec.description} (parameterised Cypher template auto-registered from plugin "${pluginName}".)`,
        argsSchema,
        async (args: Record<string, unknown>) => {
            try {
                const allParams = coerceQueryParameters(spec.parameters ?? [], args);
                // Kùzu errors when the params dict has keys the cypher
                // doesn't reference (e.g. stock pattern `list_recent`
                // declares `limit` for client-side slicing — the cypher
                // body itself uses a literal LIMIT 1000). Only pass
                // through params that appear in the cypher body.
                const referenced = extractCypherParamNames(spec.cypher);
                const params: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(allParams)) {
                    if (referenced.has(k)) params[k] = v;
                }
                const pgctx = graph.createPluginGraphContext();
                const allRows = await pgctx.queryRows(spec.cypher, params);
                // Apply client-side limit if the caller declared one.
                const callerLimit = typeof allParams['limit'] === 'number' ? (allParams['limit'] as number) : undefined;
                const rows = callerLimit !== undefined ? allRows.slice(0, callerLimit) : allRows;
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            count: rows.length,
                            totalMatching: allRows.length,
                            query: spec.id,
                            plugin: pluginName,
                            params: allParams,
                            rows,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}

/**
 * Build the Zod arg schema the MCP SDK uses for tool argument validation.
 * Each declared parameter becomes a property; required defaults to true.
 */
function buildQueryArgsSchema(params: QueryParameter[]): Record<string, ZodTypeAny> {
    const shape: Record<string, ZodTypeAny> = {};
    for (const p of params) {
        let base: ZodTypeAny;
        if (p.type === 'string') base = z.string();
        else if (p.type === 'number') base = z.number();
        else base = z.boolean();
        const required = p.required ?? true;
        shape[p.name] = required
            ? base.describe(p.description)
            : base.optional().describe(p.description);
    }
    return shape;
}

/** Extract the set of `$name` parameter references appearing in a Cypher body. */
function extractCypherParamNames(cypher: string): Set<string> {
    const out = new Set<string>();
    const re = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cypher)) !== null) {
        out.add(m[1]!);
    }
    return out;
}

/**
 * Coerce caller args into a typed params dict for `graph.queryRows`. The
 * Zod schema above already enforces shape; this is a defence-in-depth
 * pass that strips unknown keys (so callers can't smuggle extra keys
 * into the query) and re-validates types.
 */
function coerceQueryParameters(
    declared: QueryParameter[],
    args: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of declared) {
        if (!(p.name in args)) continue;
        const v = args[p.name];
        if (v === undefined || v === null) continue;
        if (p.type === 'string' && typeof v === 'string') out[p.name] = v;
        else if (p.type === 'number' && typeof v === 'number') out[p.name] = v;
        else if (p.type === 'boolean' && typeof v === 'boolean') out[p.name] = v;
        else throw new Error(`parameter "${p.name}" expected ${p.type}, got ${typeof v}`);
    }
    return out;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Tiny replica of `engines/verbatimStore.ts`'s buildVerbatimText. Kept
 * inline so this file doesn't have to import the engine module (and
 * cross the plugin → engine boundary). The format is concatenation of
 * label, content, and tag list — small enough to mirror; if the
 * upstream contract ever drifts, the test suite's regression check
 * against a known-good sample catches it.
 */
function buildVerbatimText(label: string, content: string, tags: string): string {
    const parts: string[] = [];
    if (label) parts.push(label);
    if (content) parts.push(content);
    if (tags) parts.push(tags);
    return parts.join('\n\n');
}

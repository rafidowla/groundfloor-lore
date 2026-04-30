/**
 * developer/index.ts — Developer plugin manifest for Lore V2.
 *
 * The Developer plugin contributes tools that bridge the memory graph
 * to code intelligence:
 *   - code_query, code_context, link_knowledge_to_code
 *   - gitnexus_query, gitnexus_context, gitnexus_impact, gitnexus_cypher
 *   - list_repos, detect_changes, rename
 *
 * Scope note (Phase 1):
 *   The tool *definitions* continue to live in src/mcp/server.ts where
 *   they close over the LocalGraph / GitNexus proxy singletons. The
 *   core server registers them conditionally on `pluginRegistry.isActive('developer')`.
 *   A follow-up phase can physically move them into
 *   `./tools.ts` — the manifest here tracks the contract.
 *
 * Table ownership:
 *   The developer plugin owns the `CodeSymbol` / `REF_BY` Kùzu tables
 *   managed by LocalGraph. These names are collision-checked at boot.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
    AnalyticalProjection,
    ILorePlugin,
    PluginCloudSchemaContext,
    PluginContext,
    PluginGraphContext,
    PluginTelemetryPayload,
    EmbeddableNode,
    ReconnectEdgeProposal,
} from '@lore-core/plugins/types.js';
import { registerDeveloperSchema } from './schema.js';
import { registerDeveloperCloudSchema } from './cloudSchema.js';
import { pruneInferredDeveloperEdges } from './operations.js';
import {
    CODE_FILE_COLL,
    CODE_RELATION_COLL,
    CODE_SYMBOL_COLL,
    FILE_CONTAINS_COLL,
    LORE_APPLIES_TO_CODE_COLL,
    LORE_NODE_COLL,
    LORE_TOUCHES_FILE_COLL,
    developerCollectionDecls,
} from './collections.js';
import { contributeDeveloperReconnectNodes, routeDeveloperReconnectEdge, contributeDeveloperTopology, recalibrateDeveloperNode } from './reconnect.js';
import { buildDeveloperApi, bindApiSelfReference, bindPluginContext, type DeveloperApi } from './api.js';
import { registerDeveloperTools } from './tools.js';
import { registerAtlasTools } from './atlasToolsRegistrar.js';
import { indexCommand as devIndexCommand, ingestFilesCommand as devIngestFilesCommand, analyzeCommand as devAnalyzeCommand, reposCommand as devReposCommand } from './cli.js';

const TOOL_NAMES = [
    'code_query',
    'code_context',
    'link_knowledge_to_code',
    'gitnexus_query',
    'gitnexus_context',
    'gitnexus_impact',
    'gitnexus_cypher',
    'list_repos',
    'detect_changes',
    'rename',
    // Q1.2 — moved from core server.ts. Team-awareness tool filters by
    // developer symbol/file vocabulary, which is a plugin concern.
    'who_is_working',
] as const;

export const DEVELOPER_TOOL_NAMES: ReadonlyArray<string> = TOOL_NAMES;

export const developerPlugin: ILorePlugin = {
    name: 'developer',
    version: '2.0.0',
    description: 'Code intelligence + institutional knowledge for engineering workspaces',

    // Kùzu tables the Developer plugin is responsible for. Collision-checked
    // at boot — if two active plugins claim overlapping names, boot aborts.
    ownedTables: ['CodeSymbol', 'REF_BY'],

    // Node types introduced by the plugin (superset of base schema).
    nodeTypes: ['decision', 'convention', 'bug_pattern', 'architecture', 'troubleshooting', 'code_symbol'],
    edgeRelations: ['references', 'supersedes', 'implements', 'called_by', 'refers_to'],

    // Q1.4 — Declarative IR. Authoritative descriptor for the
    // developer plugin's contribution to the graph: CodeFile +
    // CodeSymbol node tables plus the REF_BY symbol-call REL, and
    // the seven LoreNode subtypes this plugin reasons about.
    // `ownedTables` above still works for compat; the registry and
    // tooling prefer `ir.*` when set.
    ir: {
        version: '1.0.0',
        // CodeFile is declared by registerSchema but historically
        // missing from ownedTables (pre-Q1.4 oversight); the IR
        // entry pulls it back into the declared surface.
        ownedNodeTables: ['CodeFile', 'CodeSymbol'],
        ownedEdgeTables: ['REF_BY', 'FileContains', 'CodeRelation', 'LoreTouchesFile', 'LoreAppliesToCode'],
        nodeKinds: ['decision', 'convention', 'bug_pattern', 'architecture', 'troubleshooting', 'code_file', 'code_symbol'],
        edgeKinds: ['references', 'supersedes', 'implements', 'called_by', 'refers_to', 'contains', 'touches', 'applies_to'],
    },

    uiHints: {
        modeLabel: 'Developer',
        systemPrompt:
            'You are a senior software engineer with deep understanding of this codebase. ' +
            'For code questions, the Lore tools (code_query, code_context, code_full_context, ' +
            'code_impact, code_pagerank, code_dead_code, recall) return AUTHORITATIVE answers ' +
            "from a structural index of every symbol. Their data is current. " +
            'Prefer them over Read/Grep/Bash. ' +
            'Do NOT call Read on a file already returned by a Lore tool — the tool result IS ' +
            "the answer. Don't double-check by reading the same file you just got back. " +
            'Cite symbols by UID when reporting findings.',
        defaultFilterTypes: ['decision', 'convention', 'bug_pattern', 'code_symbol'],
        cameraFocusTag: 'developer',
    },

    /**
     * V2.1 cleanup: register the 10 developer MCP tools through the
     * plugin's own module. server.ts has no knowledge of these tools.
     */
    /**
     * Phase boundary fix (2026-04-27) — bindRuntime fires once at daemon
     * boot (BEFORE HTTP server starts) so daemon-level HTTP routes that
     * call into devApi (e.g. /api/code-similar) can reach verbatimStore
     * even when no MCP session is active. registerTools binds the same
     * thing per-MCP-session as a backstop.
     */
    bindRuntime(ctx: PluginContext): void {
        bindPluginContext(ctx);
    },

    registerTools(server: McpServer, ctx: PluginContext): void {
        // Re-bind on every MCP session in case bindRuntime was skipped
        // (e.g. plugin loaded mid-session). Idempotent.
        bindPluginContext(ctx);
        const api = (developerPlugin as ILorePlugin & { api?: DeveloperApi }).api;
        if (!api) {
            console.error('[developer plugin] registerTools called before registerSchema attached the api — skipping.');
            return;
        }
        registerDeveloperTools(server, api, ctx);

        // Phase 6.1 wiring — register the 12 NEW Atlas analytics + git-signal
        // tools alongside the legacy developer tools. The AtlasContext is
        // built lazily on first call and cached for the daemon's lifetime.
        // v1: AtlasContext scoped to a single repoRoot (process.cwd by
        // default, OR LORE_ATLAS_REPO_ROOT env override). Multi-repo
        // support is the next iteration — would parse all registered
        // repos and union the resolved graph.
        const atlasRepoRoot = process.env.LORE_ATLAS_REPO_ROOT ?? process.cwd();
        try {
            registerAtlasTools(server, { repoRoot: atlasRepoRoot });
        } catch (err) {
            console.error(`[developer plugin] registerAtlasTools failed (non-fatal): ${(err as Error).message}`);
        }
    },

    /**
     * Q2.2 slice 5c — declare canonical → substrate-name mappings.
     *
     * Applied by PluginRegistry.registerSchemas() before the per-plugin
     * registerSchema/registerCloudSchema runs, so storage ops issued
     * from inside those hooks (or any later op) can resolve the
     * substrate-specific table/collection name + the edge source/target
     * primary-key fields automatically. Replaces the per-call EdgeShapeHint
     * threading and the substrate-pair lookup table from slice 5b.
     */
    contributeCollectionDecls() {
        return developerCollectionDecls;
    },

    /**
     * V2.1 / Option C: own the developer-specific Kùzu schema. Called
     * by the registry once at boot after the core graph is initialized.
     * Also the natural place to build the plugin's typed API since we
     * have the PluginGraphContext in hand.
     */
    async registerSchema(ctx: PluginGraphContext): Promise<void> {
        await registerDeveloperSchema(ctx);
        // Attach the typed api so outside callers can reach developer ops
        // without importing plugin internals. See src/plugins/developer/api.ts
        // for the DeveloperApi contract.
        const api = buildDeveloperApi(ctx);
        bindApiSelfReference(api);
        (developerPlugin as ILorePlugin & { api?: DeveloperApi }).api = api;
    },

    /**
     * Q2.2 slice 4 — cloud-mode schema push.
     *
     * Invoked by DataplaneGraph on each tenant's first touch, AFTER
     * core lore_node / lore_edge collections are provisioned. Lands 7
     * developer-owned collections that mirror the 7 Kùzu tables this
     * plugin declares in ./schema.ts. Idempotent on "already exists" —
     * safe across daemon restarts and across many tenants.
     *
     * Plugin operations (MERGE/MATCH/CREATE Cypher over these
     * collections) are NOT yet routed in cloud mode — that's a
     * follow-up slice (see createPluginGraphContext stub on
     * DataplaneGraph). This slice establishes schema parity so the
     * collections EXIST when op routing lands, and so operators
     * enabling cloud mode today see their tenant's schema land
     * without manual provisioning.
     */
    async registerCloudSchema(ctx: PluginCloudSchemaContext): Promise<void> {
        await registerDeveloperCloudSchema(ctx);
    },

    /**
     * V2.1 / Option C: hand the core reconnect pass all the CodeFile
     * and CodeSymbol nodes as embeddable items, with disk-read content
     * enrichment via `gitnexus list`.
     */
    async contributeReconnectNodes(ctx: PluginGraphContext): Promise<EmbeddableNode[]> {
        return await contributeDeveloperReconnectNodes(ctx);
    },

    /**
     * V2.1 / Option C: route cross-pillar semantic edges into the
     * developer-owned rel tables (LoreTouchesFile, LoreAppliesToCode).
     * Returns true if we routed it; false so core or another plugin
     * can try.
     */
    async routeReconnectEdge(proposal: ReconnectEdgeProposal, ctx: PluginGraphContext): Promise<boolean> {
        return await routeDeveloperReconnectEdge(proposal, ctx);
    },

    /**
     * V2.1 / Option C: clear our own inferred edges before a reconnect
     * apply so re-runs don't duplicate.
     */
    async pruneInferredEdges(relationPrefix: string, ctx: PluginGraphContext): Promise<number> {
        const stats = await pruneInferredDeveloperEdges(ctx, relationPrefix);
        return stats.touchesFile + stats.appliesToCode;
    },

    async contributeTopology(ctx: PluginGraphContext, limit: number, projects?: string[] | string) {
        return await contributeDeveloperTopology(ctx, limit, projects);
    },

    /**
     * Q1.8 — Plugin recalibrate hook. Handles `file:<path>` and
     * `symbol:<uid>` markers. Returns null for any other prefix so
     * the server's dispatcher can try the next plugin.
     *
     * Implementation lives in `./reconnect.ts` alongside the full
     * reconnect pass — recalibrate is the single-node variant of the
     * same flow, and keeping them in one module lets them share the
     * embedding/enrichment machinery.
     */
    async recalibrate(markerId: string, ctx: PluginContext) {
        return await recalibrateDeveloperNode(markerId, ctx);
    },

    /**
     * V2.2 — make "Ask about this" work on CodeFile / CodeSymbol nodes.
     * Before this hook existed the chat context expander only checked
     * the core LoreNode table, so asking about a `file:src/foo.ts` or
     * `symbol:SomeFn#doThing` marker returned no content and Gemma
     * correctly (but uselessly) said "I don't have enough information
     * in the knowledge graph to answer that."
     *
     * Prefix routing:
     *   - "file:<path>"     → look up CodeFile by path, gather FileContains
     *                         neighbors (symbols declared in the file) +
     *                         LoreTouchesFile neighbors (lore nodes linked
     *                         to the file)
     *   - "symbol:<uid>"    → look up CodeSymbol, gather CodeRelation
     *                         neighbors (callers/callees) + FileContains
     *                         parent + LoreAppliesToCode neighbors
     *
     * Returns null for any other prefix so the next plugin gets a turn.
     */
    async resolveChatContext(markerId: string, ctx: PluginGraphContext) {
        if (markerId.startsWith('file:')) {
            const filePath = markerId.slice('file:'.length);
            const f = await ctx.storage.get<Record<string, unknown>>(
                CODE_FILE_COLL,
                'path',
                filePath,
            ).catch(() => null);
            if (!f) return null;

            // Symbols declared in this file (FileContains outgoing).
            // Two-step: traverse FileContains, then fetch the connected
            // CodeSymbols by uid.
            const fcEdges = await ctx.storage.traverse(
                FILE_CONTAINS_COLL,
                filePath,
                'out',
                { limit: 20 },
            ).catch(() => []);
            const symUids = fcEdges.map((e) => e.targetId).filter(Boolean);
            const symRows: Array<Record<string, unknown>> = symUids.length === 0
                ? []
                : await ctx.storage.find<Record<string, unknown>>(
                    CODE_SYMBOL_COLL,
                    { in: { uid: symUids } },
                    { limit: 20 },
                ).catch(() => []);

            // Lore nodes that touch this file (LoreTouchesFile incoming).
            const ltEdges = await ctx.storage.traverse(
                LORE_TOUCHES_FILE_COLL,
                filePath,
                'in',
                { limit: 10 },
            ).catch(() => []);
            const loreIds = ltEdges.map((e) => e.sourceId).filter(Boolean);
            const loreRows: Array<Record<string, unknown>> = loreIds.length === 0
                ? []
                : await ctx.storage.find<Record<string, unknown>>(
                    LORE_NODE_COLL,
                    { in: { id: loreIds } },
                    { limit: 10 },
                ).catch(() => []);

            const neighbors = [
                ...symRows.map((r) => ({
                    id: String(r['uid'] ?? ''),
                    label: String(r['name'] ?? ''),
                    type: String(r['kind'] ?? 'symbol'),
                    relation: 'contains',
                })),
                ...loreRows.map((r) => ({
                    id: String(r['id'] ?? ''),
                    label: String(r['label'] ?? ''),
                    type: String(r['type'] ?? 'lore'),
                    relation: 'touched_by',
                })),
            ];

            const language = String(f['language'] ?? 'unknown');
            const loc = f['loc'] != null ? String(f['loc']) : '?';
            const repo = String(f['repo'] ?? '');
            const content = [
                `File: ${filePath}`,
                `Language: ${language}`,
                `Lines of code: ${loc}`,
                repo ? `Repository: ${repo}` : null,
                '',
                `This file contains ${fcEdges.length} symbol${fcEdges.length === 1 ? '' : 's'}${fcEdges.length >= 20 ? ' (first 20 shown)' : ''}.`,
                ltEdges.length > 0
                    ? `Linked to ${ltEdges.length} knowledge node${ltEdges.length === 1 ? '' : 's'}.`
                    : 'No knowledge nodes are linked to this file yet — the graph may need a reconnect pass.',
            ].filter(Boolean).join('\n');

            return {
                label: filePath,
                type: 'code_file',
                content,
                neighbors,
            };
        }

        if (markerId.startsWith('symbol:')) {
            const uid = markerId.slice('symbol:'.length);
            const s = await ctx.storage.get<Record<string, unknown>>(
                CODE_SYMBOL_COLL,
                'uid',
                uid,
            ).catch(() => null);
            if (!s) return null;

            // Callers / callees via CodeRelation. Two-step like above:
            // traverse the edges, then fetch the connected CodeSymbol
            // rows by uid.
            const outEdges = await ctx.storage.traverse<{ kind?: string }>(
                CODE_RELATION_COLL,
                uid,
                'out',
                { limit: 10 },
            ).catch(() => []);
            const outIds = outEdges.map((e) => e.targetId).filter(Boolean);
            const outRows: Array<Record<string, unknown>> = outIds.length === 0
                ? []
                : await ctx.storage.find<Record<string, unknown>>(
                    CODE_SYMBOL_COLL,
                    { in: { uid: outIds } },
                    { limit: 10 },
                ).catch(() => []);
            const outById = new Map(outRows.map((r) => [String(r['uid'] ?? ''), r]));

            const inEdges = await ctx.storage.traverse<{ kind?: string }>(
                CODE_RELATION_COLL,
                uid,
                'in',
                { limit: 10 },
            ).catch(() => []);
            const inIds = inEdges.map((e) => e.sourceId).filter(Boolean);
            const inRows: Array<Record<string, unknown>> = inIds.length === 0
                ? []
                : await ctx.storage.find<Record<string, unknown>>(
                    CODE_SYMBOL_COLL,
                    { in: { uid: inIds } },
                    { limit: 10 },
                ).catch(() => []);
            const inById = new Map(inRows.map((r) => [String(r['uid'] ?? ''), r]));

            const neighbors = [
                ...outEdges.map((e) => {
                    const r = outById.get(e.targetId) ?? {};
                    return {
                        id: e.targetId,
                        label: String(r['name'] ?? ''),
                        type: String(r['kind'] ?? 'symbol'),
                        relation: String(e.edgeProps.kind ?? 'calls'),
                    };
                }),
                ...inEdges.map((e) => {
                    const r = inById.get(e.sourceId) ?? {};
                    return {
                        id: e.sourceId,
                        label: String(r['name'] ?? ''),
                        type: String(r['kind'] ?? 'symbol'),
                        relation: `called_by:${String(e.edgeProps.kind ?? 'calls')}`,
                    };
                }),
            ];

            const content = [
                `Symbol: ${String(s['name'] ?? uid)}`,
                `Kind: ${String(s['kind'] ?? 'unknown')}`,
                `File: ${String(s['filePath'] ?? '?')} (lines ${String(s['lineStart'] ?? '?')}-${String(s['lineEnd'] ?? '?')})`,
                '',
                s['signature'] ? `Signature:\n${String(s['signature'])}` : null,
                '',
                s['docComment'] ? `Documentation:\n${String(s['docComment'])}` : null,
            ].filter(Boolean).join('\n');

            return {
                label: String(s['name'] ?? uid),
                type: 'code_symbol',
                content: content || `Symbol ${uid} found but has no signature or docComment recorded.`,
                neighbors,
            };
        }

        return null;
    },

    /**
     * Phase 1 / C2 — add code-intelligence guidance to the chat system
     * prompt. Tells the LLM: (a) prefer graph-backed impact analysis
     * before speculating about callers/dependents, (b) treat
     * confidence='inferred' edges as hints not facts, and (c) cite
     * symbols by UID when they're available in-scope.
     *
     * The older `uiHints.systemPrompt` field predates this hook and was
     * previously used only by the removed Mode pill. We route it through
     * the new hook so it takes effect on every chat, and extend it with
     * the C1 confidence-aware guidance.
     */
    /**
     * Phase 5 / C12 — retention policy. Developer plugin keeps:
     *   - decisions/conventions/architecture/bug_patterns FOREVER (they
     *     age like wine — older decisions are more valuable as context)
     *   - notes archived after 1 year (they're typically ephemeral
     *     session handoffs / working-state checkpoints)
     *   - troubleshooting kept forever (recurring issues benefit from
     *     full history)
     *
     * `archive` action is handled by C11 when the daily-sweep runtime
     * lands; until then this is declarative metadata the UI can show.
     */
    contributeRetentionPolicy() {
        return [
            { nodeType: 'decision',        condition: 'age' as const, ageThresholdDays: 10_000, action: 'keep-forever' as const },
            { nodeType: 'convention',      condition: 'age' as const, ageThresholdDays: 10_000, action: 'keep-forever' as const },
            { nodeType: 'architecture',    condition: 'age' as const, ageThresholdDays: 10_000, action: 'keep-forever' as const },
            { nodeType: 'bug_pattern',     condition: 'age' as const, ageThresholdDays: 10_000, action: 'keep-forever' as const },
            { nodeType: 'troubleshooting', condition: 'age' as const, ageThresholdDays: 10_000, action: 'keep-forever' as const },
            { nodeType: 'note',            condition: 'age' as const, ageThresholdDays: 365,    action: 'archive' as const },
        ];
    },

    /**
     * Boundary cleanup (2026-04-27) — domain node types owned by this
     * plugin. Core ships only generic types (decision/convention/note);
     * dev concepts that fail the family-workspace test live here so a
     * non-dev workspace doesn't see them in store_node.
     */
    contributeNodeTypes() {
        return [
            { name: 'bug_pattern',     description: 'Recurring code bug + root cause + fix' },
            { name: 'architecture',    description: 'High-level code structure or design' },
            { name: 'troubleshooting', description: 'Step-by-step recovery steps for a known failure' },
            { name: 'file_ref',        description: 'Pointer to a code file, for cross-referencing' },
            { name: 'schema',          description: 'Data schema or table definition' },
        ];
    },

    /**
     * Boundary cleanup (2026-04-27) — edge relations owned by this
     * plugin. 'fixed_by' implies bugs (a code concept); kept here so a
     * non-dev workspace doesn't see it in store_edge.
     */
    contributeEdgeRelations() {
        return [
            { name: 'fixed_by', description: 'Bug or issue resolved by a specific commit, PR, or change' },
        ];
    },

    /**
     * Q1.5 — developer analytical projections.
     *
     * Three projections targeting the "shape of my code" questions
     * the LoreNode graph layer can answer without hitting gitnexus:
     *   - lore-nodes-by-type: breakdown of institutional knowledge
     *     by type (decision / convention / bug_pattern / ...).
     *   - lore-nodes-by-month: authoring velocity — when did we
     *     last write things down?
     *   - symbols-per-file: top-N files by symbol count — complexity
     *     hotspots. Intentionally capped at LIMIT 50 so the projection
     *     returns a renderable table even on 10k-symbol repos.
     *
     * All three run against the tables this plugin already owns
     * (LoreNode, CodeFile, CodeSymbol) — no cross-plugin reads.
     */
    contributeAnalyticalProjections(): AnalyticalProjection[] {
        return [
            {
                id: 'lore-nodes-by-type',
                label: 'Lore nodes by type',
                description: 'Count of LoreNode entries grouped by type (decision, convention, bug_pattern, etc.), sorted by frequency.',
                intentKeywords: ['lore', 'node', 'type', 'decision', 'convention', 'how many', 'by'],
                columns: [
                    { name: 'type', kind: 'dimension' },
                    { name: 'count', kind: 'measure' },
                ],
                async run(ctx: PluginGraphContext) {
                    // Substrate-portable: PluginStorage has no GROUP BY,
                    // so we pull the (id, type) pairs and aggregate in JS.
                    // LoreNode populations are bounded (lo thousands at
                    // most), so the round-trip cost is acceptable. The
                    // limit is a safety cap, not a real boundary.
                    const all = await ctx.storage.find<Record<string, unknown>>(
                        LORE_NODE_COLL,
                        {},
                        { limit: 100_000 },
                    );
                    const counts = new Map<string, number>();
                    const sourceNodeIds: string[] = [];
                    for (const r of all) {
                        const id = String(r['id'] ?? '');
                        if (id) sourceNodeIds.push(id);
                        const type = String(r['type'] ?? '(untyped)');
                        counts.set(type, (counts.get(type) ?? 0) + 1);
                    }
                    const rows = [...counts.entries()]
                        .map(([type, count]) => ({ type, count }))
                        .sort((a, b) => b.count - a.count);
                    return {
                        columns: [
                            { name: 'type', kind: 'dimension' as const },
                            { name: 'count', kind: 'measure' as const },
                        ],
                        rows,
                        sourceNodeIds,
                    };
                },
            },
            {
                id: 'lore-nodes-by-month',
                label: 'Lore nodes authored by month',
                description: 'Count of LoreNode entries grouped by YYYY-MM of their createdAt timestamp. Reveals knowledge-capture velocity.',
                intentKeywords: ['lore', 'node', 'month', 'velocity', 'when', 'authored', 'created'],
                columns: [
                    { name: 'month', kind: 'time' },
                    { name: 'count', kind: 'measure' },
                ],
                async run(ctx: PluginGraphContext) {
                    // Substrate-portable JS-side aggregation. See the
                    // sibling lore-nodes-by-type projection for rationale.
                    const all = await ctx.storage.find<Record<string, unknown>>(
                        LORE_NODE_COLL,
                        {},
                        { limit: 100_000 },
                    );
                    const counts = new Map<string, number>();
                    const sourceNodeIds: string[] = [];
                    for (const r of all) {
                        const createdAt = String(r['createdAt'] ?? '');
                        if (!createdAt) continue;
                        const id = String(r['id'] ?? '');
                        if (id) sourceNodeIds.push(id);
                        const month = createdAt.slice(0, 7);
                        counts.set(month, (counts.get(month) ?? 0) + 1);
                    }
                    const rows = [...counts.entries()]
                        .map(([month, count]) => ({ month, count }))
                        .sort((a, b) => a.month.localeCompare(b.month));
                    return {
                        columns: [
                            { name: 'month', kind: 'time' as const },
                            { name: 'count', kind: 'measure' as const },
                        ],
                        rows,
                        sourceNodeIds,
                    };
                },
            },
            {
                id: 'symbols-per-file',
                label: 'Symbols per file (top 50)',
                description: 'Top 50 CodeFiles by number of CodeSymbols they contain. Complexity hotspots surface first.',
                intentKeywords: ['symbol', 'file', 'per', 'complexity', 'count', 'top'],
                columns: [
                    { name: 'file_path', kind: 'dimension' },
                    { name: 'symbol_count', kind: 'measure' },
                ],
                async run(ctx: PluginGraphContext) {
                    // Substrate-portable: count symbols per file by
                    // grouping CodeSymbol rows by filePath in JS.
                    // CodeSymbol carries `filePath` directly (it's how
                    // FileContains was synthesized), so we can skip the
                    // edge traversal entirely. Cap at 100k symbols — same
                    // safety margin as ingestFilesFromSymbols.
                    const all = await ctx.storage.find<Record<string, unknown>>(
                        CODE_SYMBOL_COLL,
                        {},
                        { limit: 100_000 },
                    );
                    const counts = new Map<string, number>();
                    for (const r of all) {
                        const filePath = String(r['filePath'] ?? '');
                        if (!filePath) continue;
                        counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
                    }
                    const rows = [...counts.entries()]
                        .map(([file_path, symbol_count]) => ({ file_path, symbol_count }))
                        .sort((a, b) => b.symbol_count - a.symbol_count)
                        .slice(0, 50);
                    return {
                        columns: [
                            { name: 'file_path', kind: 'dimension' as const },
                            { name: 'symbol_count', kind: 'measure' as const },
                        ],
                        rows,
                        sourceNodeIds: rows.map((r) => r.file_path).filter(Boolean),
                    };
                },
            },
        ];
    },

    contributeSystemPrompt(_ctx: PluginContext): string | null {
        return [
            developerPlugin.uiHints.systemPrompt,
            "When the graph shows an edge with confidence='inferred', treat the relationship as a hint " +
            "derived from semantic similarity — not a user-asserted fact. Acknowledge uncertainty when " +
            "reasoning over such edges. Extracted edges may be cited as established.",
            'Before suggesting code edits, call code_impact (or gitnexus_impact alias) to surface blast radius. ' +
            'Before renaming anything, use rename with dry_run: true and relay the preview.',
            // Direct anti-hedging instruction. The eval (commit 9c287c6) showed
            // the agent calling Lore tools then ALSO reading the matching files
            // — paying for both. Tell it explicitly to stop.
            'TOOL DISCIPLINE: When a Lore tool returns a file path or symbol uid, that result ' +
            'already contains what you need to answer the user. Do not re-read the file to ' +
            'verify. The graph IS authoritative. If a Lore tool says "function X is in ' +
            'src/foo.ts at line 42," report that — do not Read src/foo.ts to check.',
        ].join(' ');
    },

    /**
     * Developer-owned graph stats surfaced under
     * `GraphStats.pluginStats.developer`. Keeps the old
     * `codeSymbolCount` / `codeRelationCount` keys so downstream
     * callers (graphReport, MCP stats endpoint, UI) read the same
     * metric names they did before the boundary cleanup.
     */
    async contributeStats(ctx: PluginGraphContext): Promise<Record<string, number> | null> {
        let codeSymbolCount = 0;
        let codeRelationCount = 0;
        try {
            codeSymbolCount = await ctx.storage.count(CODE_SYMBOL_COLL, {});
        } catch {
            // Table may not exist yet (fresh graph before registerSchema).
        }
        try {
            codeRelationCount = await ctx.storage.countEdges(CODE_RELATION_COLL, {});
        } catch {
            // Same rationale as above.
        }
        return { codeSymbolCount, codeRelationCount };
    },

    /**
     * Developer-owned lint warning: bug_pattern nodes that aren't
     * linked to any CodeSymbol via LoreAppliesToCode. Lives in the
     * plugin because both the predicate (LoreAppliesToCode) and the
     * target (CodeSymbol) are developer-scoped vocabulary.
     */
    async contributeValidations(ctx: PluginGraphContext): Promise<Array<{ warning: string }> | null> {
        const warnings: Array<{ warning: string }> = [];
        try {
            // Find all bug_pattern nodes, then check each for outgoing
            // LoreAppliesToCode edges. PluginStorage has no NOT-EXISTS
            // operator, so we do the existence check via per-node
            // traverse + emptiness test. Bounded by the (typically
            // small) bug_pattern population — substrate-portable.
            const bugRows = await ctx.storage.find<Record<string, unknown>>(
                LORE_NODE_COLL,
                { eq: { type: 'bug_pattern' } },
                { limit: 1_000 },
            );
            for (const row of bugRows) {
                const id = String(row['id'] ?? '');
                if (!id) continue;
                const edges = await ctx.storage.traverse(
                    LORE_APPLIES_TO_CODE_COLL,
                    id,
                    'out',
                    { limit: 1 },
                ).catch(() => []);
                if (edges.length === 0) {
                    warnings.push({ warning: `Missing Link: bug_pattern '${id}' is not linked to any CodeSymbol.` });
                }
            }
        } catch {
            // CodeSymbol table may not exist yet — skip the check.
        }
        return warnings;
    },

    /**
     * Contribute `lore index` + `lore ingest-files` as plugin-owned
     * CLI commands. The handlers live in ./cli.ts so the plugin boundary
     * stays clean — core CLI just dispatches on name.
     */
    registerCliCommands() {
        return {
            analyze: {
                help: 'Build the code index for a repository (auto-installs the indexer on first run)',
                handler: devAnalyzeCommand,
            },
            index: {
                help: 'Import code symbols from the code index into the unified knowledge graph',
                handler: devIndexCommand,
            },
            'ingest-files': {
                help: 'Synthesize CodeFile nodes + FileContains edges from existing CodeSymbols',
                handler: devIngestFilesCommand,
            },
            repos: {
                help: 'Manage indexed code repositories (list / add / batch / remove / freshness / install-hook)',
                handler: devReposCommand,
            },
        };
    },

    /**
     * Plugin-owned doctor check: GitNexus CLI availability. Replaces
     * the block in core cli/commands.ts that used to if-check
     * `pluginRegistry.isActive('developer')`.
     */
    async contributeDoctorChecks(ctx: PluginContext) {
        const api = (developerPlugin as ILorePlugin & { api?: DeveloperApi }).api;
        if (!api) {
            return [{
                label: 'developer plugin',
                ok: false,
                message: 'developer plugin api unavailable — registerSchema did not run.',
            }];
        }
        if (api.isGitNexusAvailable()) {
            const repos = api.listGitNexusRepos();
            return [{
                label: 'developer plugin',
                ok: true,
                message: `Code indexer available: ${repos.length} repo(s) indexed`,
            }];
        }
        return [{
            label: 'developer plugin',
            ok: false,
            message: 'Code indexer not set up — run `lore setup` to install it.',
        }];
        void ctx;
    },

    async getTelemetryPayload(ctx: PluginContext): Promise<PluginTelemetryPayload | null> {
        // Phase 4 ships health-ping only; this payload is not yet sent on the wire.
        const graph = ctx.graph as { stats?: () => Promise<{ nodes: number; edges: number }> };
        const stats = await graph.stats?.();
        return {
            pluginName: 'developer',
            version: '2.0.0',
            nodeCount: stats?.nodes ?? 0,
            edgeCount: stats?.edges ?? 0,
            tableNames: ['CodeSymbol', 'REF_BY'],
        };
    },
};

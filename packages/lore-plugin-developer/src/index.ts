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
    ILorePlugin,
    PluginContext,
    PluginGraphContext,
    PluginTelemetryPayload,
    EmbeddableNode,
    ReconnectEdgeProposal,
} from '@lore-core/plugins/types.js';
import { registerDeveloperSchema } from './schema.js';
import { pruneInferredDeveloperEdges } from './operations.js';
import { contributeDeveloperReconnectNodes, routeDeveloperReconnectEdge, contributeDeveloperTopology } from './reconnect.js';
import { buildDeveloperApi, bindApiSelfReference, type DeveloperApi } from './api.js';
import { registerDeveloperTools } from './tools.js';

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

    uiHints: {
        modeLabel: 'Developer',
        systemPrompt:
            'You are a senior software engineer with deep understanding of this codebase. ' +
            'When the user asks about code, default to graph-backed facts (code_query, ' +
            'code_context, gitnexus_impact) before speculating. Prefer citing symbols by UID.',
        defaultFilterTypes: ['decision', 'convention', 'bug_pattern', 'code_symbol'],
        cameraFocusTag: 'developer',
    },

    /**
     * V2.1 cleanup: register the 10 developer MCP tools through the
     * plugin's own module. server.ts has no knowledge of these tools.
     */
    registerTools(server: McpServer, ctx: PluginContext): void {
        const api = (developerPlugin as ILorePlugin & { api?: DeveloperApi }).api;
        if (!api) {
            console.error('[developer plugin] registerTools called before registerSchema attached the api — skipping.');
            return;
        }
        registerDeveloperTools(server, api, ctx);
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

    async contributeTopology(ctx: PluginGraphContext, limit: number) {
        return await contributeDeveloperTopology(ctx, limit);
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
            const fileRows = await ctx.queryRows(
                `MATCH (f:CodeFile {path: $path})
                 RETURN f.path AS path, f.language AS language, f.repo AS repo, f.loc AS loc`,
                { path: filePath },
            ).catch(() => []);
            if (fileRows.length === 0) return null;
            const f = fileRows[0] as Record<string, unknown>;

            // Symbols declared in this file (FileContains outgoing)
            const symRows = await ctx.queryRows(
                `MATCH (f:CodeFile {path: $path})-[:FileContains]->(s:CodeSymbol)
                 RETURN s.uid AS id, s.name AS label, s.kind AS type
                 LIMIT 20`,
                { path: filePath },
            ).catch(() => []);
            // Lore nodes that touch this file (LoreTouchesFile incoming)
            const loreRows = await ctx.queryRows(
                `MATCH (l:LoreNode)-[:LoreTouchesFile]->(f:CodeFile {path: $path})
                 RETURN l.id AS id, l.label AS label, l.type AS type
                 LIMIT 10`,
                { path: filePath },
            ).catch(() => []);

            const neighbors = [
                ...symRows.map((r) => ({
                    id: String((r as Record<string, unknown>)['id'] ?? ''),
                    label: String((r as Record<string, unknown>)['label'] ?? ''),
                    type: String((r as Record<string, unknown>)['type'] ?? 'symbol'),
                    relation: 'contains',
                })),
                ...loreRows.map((r) => ({
                    id: String((r as Record<string, unknown>)['id'] ?? ''),
                    label: String((r as Record<string, unknown>)['label'] ?? ''),
                    type: String((r as Record<string, unknown>)['type'] ?? 'lore'),
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
                `This file contains ${symRows.length} symbol${symRows.length === 1 ? '' : 's'}${symRows.length >= 20 ? ' (first 20 shown)' : ''}.`,
                loreRows.length > 0
                    ? `Linked to ${loreRows.length} knowledge node${loreRows.length === 1 ? '' : 's'}.`
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
            const symRows = await ctx.queryRows(
                `MATCH (s:CodeSymbol {uid: $uid})
                 RETURN s.uid AS uid, s.name AS name, s.kind AS kind, s.filePath AS filePath,
                        s.lineStart AS lineStart, s.lineEnd AS lineEnd, s.signature AS signature,
                        s.docComment AS docComment`,
                { uid },
            ).catch(() => []);
            if (symRows.length === 0) return null;
            const s = symRows[0] as Record<string, unknown>;

            // Callers / callees via CodeRelation
            const outRows = await ctx.queryRows(
                `MATCH (s:CodeSymbol {uid: $uid})-[r:CodeRelation]->(t:CodeSymbol)
                 RETURN t.uid AS id, t.name AS label, t.kind AS type, r.kind AS rel
                 LIMIT 10`,
                { uid },
            ).catch(() => []);
            const inRows = await ctx.queryRows(
                `MATCH (t:CodeSymbol)-[r:CodeRelation]->(s:CodeSymbol {uid: $uid})
                 RETURN t.uid AS id, t.name AS label, t.kind AS type, r.kind AS rel
                 LIMIT 10`,
                { uid },
            ).catch(() => []);

            const neighbors = [
                ...outRows.map((r) => ({
                    id: String((r as Record<string, unknown>)['id'] ?? ''),
                    label: String((r as Record<string, unknown>)['label'] ?? ''),
                    type: String((r as Record<string, unknown>)['type'] ?? 'symbol'),
                    relation: String((r as Record<string, unknown>)['rel'] ?? 'calls'),
                })),
                ...inRows.map((r) => ({
                    id: String((r as Record<string, unknown>)['id'] ?? ''),
                    label: String((r as Record<string, unknown>)['label'] ?? ''),
                    type: String((r as Record<string, unknown>)['type'] ?? 'symbol'),
                    relation: `called_by:${String((r as Record<string, unknown>)['rel'] ?? 'calls')}`,
                })),
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

    contributeSystemPrompt(_ctx: PluginContext): string | null {
        return [
            developerPlugin.uiHints.systemPrompt,
            "When the graph shows an edge with confidence='inferred', treat the relationship as a hint " +
            "derived from semantic similarity — not a user-asserted fact. Acknowledge uncertainty when " +
            "reasoning over such edges. Extracted edges may be cited as established.",
            'Before suggesting code edits on a symbol, call gitnexus_impact to surface blast radius. ' +
            'Before renaming anything, use gitnexus_rename with dry_run: true and relay the preview.',
        ].join(' ');
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

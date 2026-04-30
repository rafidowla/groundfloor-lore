/**
 * mcp/tools.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * MCP tool definitions — schemas for the 18 code_* tools.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 6 (MCP tool surface).
 *
 * Each tool definition has a name, plain-English description, JSON
 * Schema input, and a `mode` parameter (where applicable) for the
 * thin/standard/full response shaping per the two-tier principle.
 *
 * Handlers live in mcp/handlers.ts; aliases (gitnexus_*) live in
 * mcp/aliases.ts. ILorePlugin.registerTools() wires everything in
 * a Phase 6.1 follow-up — the registration glue depends on the
 * developer plugin's existing PluginContext shape.
 */

export type ToolMode = 'thin' | 'standard' | 'full';

export interface ToolDef {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

const MODE_SCHEMA = {
    type: 'string',
    enum: ['thin', 'standard', 'full'],
    default: 'thin',
    description: 'Response verbosity. thin = id+label+1-line snippet (smallest LLM-token cost); standard = + signature + file:line + short context; full = full body + neighbours + metadata.',
};

export const ATLAS_TOOLS: readonly ToolDef[] = [
    // ───────── replacements for gitnexus_* tools ─────────
    {
        name: 'code_query',
        description: 'Semantic + graph search over the codebase. Reuses Lore\'s Xenova embeddings + graph context.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language or keyword query.' },
                limit: { type: 'integer', default: 10, minimum: 1, maximum: 100 },
                mode: MODE_SCHEMA,
            },
            required: ['query'],
        },
    },
    {
        name: 'code_context',
        description: '360-degree view of one symbol — signature, callers, callees, file location, related Lore knowledge.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Symbol name or qualified name (e.g., parseFile or Greeter.greet).' },
                depth: { type: 'integer', default: 1, minimum: 0, maximum: 3 },
                mode: MODE_SCHEMA,
            },
            required: ['name'],
        },
    },
    {
        name: 'code_impact',
        description: 'Blast radius for a symbol — depth-tiered (d1=WILL BREAK, d2=LIKELY, d3=MAY NEED TESTING).',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'Symbol id, name, or qualified name.' },
                direction: { type: 'string', enum: ['upstream', 'downstream'], default: 'upstream' },
                maxDepth: { type: 'integer', default: 3, minimum: 1, maximum: 5 },
                mode: MODE_SCHEMA,
            },
            required: ['target'],
        },
    },
    {
        name: 'code_detect_changes',
        description: 'Map git diff to affected symbols. Use scope=staged before commit; scope=compare with baseRef for branch-vs-base.',
        inputSchema: {
            type: 'object',
            properties: {
                scope: { type: 'string', enum: ['staged', 'unstaged', 'compare'], default: 'staged' },
                baseRef: { type: 'string', description: 'Required when scope=compare. e.g., \'main\'.' },
                mode: MODE_SCHEMA,
            },
        },
    },
    {
        name: 'code_rename',
        description: 'Rename a symbol with dry-run preview. Walks the call graph + import graph to identify every reference. Phase 6.1 handler hooks into existing developer-plugin nativeTools rename infra.',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Symbol name or qualified name to rename.' },
                newName: { type: 'string' },
                dryRun: { type: 'boolean', default: true },
            },
            required: ['symbol', 'newName'],
        },
    },
    {
        name: 'code_cypher',
        description: 'Execute a custom Cypher query against the developer-plugin Kùzu graph. Read-only; results truncated to 1000 rows.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Cypher query string.' },
                parameters: { type: 'object', description: 'Optional parameter map.' },
            },
            required: ['query'],
        },
    },
    {
        name: 'code_search_ast',
        description: 'Search for AST patterns across the codebase using tree-sitter\'s query language. Useful for "find all try/catch where catch ignores the error" / "find all empty arrow functions".',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Tree-sitter query pattern (S-expression).' },
                language: { type: 'string', description: 'Optional language filter (e.g., typescript).' },
                limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
            },
            required: ['pattern'],
        },
    },

    // ───────── new analytics tools (Phase 4) ─────────
    {
        name: 'code_blast_radius',
        description: 'Depth-tiered (d1/d2/d3) reachability. Same as code_impact but with explicit edgeKinds knob.',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Symbol id, name, or qualified name.' },
                direction: { type: 'string', enum: ['upstream', 'downstream'], default: 'upstream' },
                edgeKinds: {
                    type: 'array',
                    items: { type: 'string', enum: ['calls', 'imports', 'extends', 'implements', 'contains'] },
                    default: ['calls', 'imports'],
                },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'code_pagerank',
        description: 'Symbol-importance ranking (PageRank). Higher score = more central / depended on. Useful for onboarding ("what should I read first?").',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
            },
        },
    },
    {
        name: 'code_coupling',
        description: 'Per-module afferent / efferent / instability metrics. Identifies stable hubs and volatile leaves.',
        inputSchema: {
            type: 'object',
            properties: {
                module: { type: 'string', description: 'Optional — filter to a single module path. Omit for the full ranking.' },
            },
        },
    },
    {
        name: 'code_cycles',
        description: 'Find dependency cycles (strongly-connected components). Returns members of each cycle with size 2+.',
        inputSchema: {
            type: 'object',
            properties: {
                minSize: { type: 'integer', default: 2, minimum: 2 },
            },
        },
    },
    {
        name: 'code_dead_code',
        description: 'Symbols with zero inbound references. Filtered to callable kinds; entry-point patterns exempted.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Optional — filter to a single file.' },
                limit: { type: 'integer', default: 100, minimum: 1, maximum: 1000 },
            },
        },
    },
    {
        name: 'code_hotspots',
        description: 'High-complexity × high-churn symbols. Ranks where bugs accumulate. Falls back to complexity-only when churn data unavailable.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
                minComplexity: { type: 'integer', default: 2, minimum: 1 },
                churnSinceDays: { type: 'integer', default: 30 },
            },
        },
    },
    {
        name: 'code_layer_violations',
        description: 'Edges that violate user-declared LayerSpec rules. Default LayerSpec: ui→core OK, ui⇏plugins, core⇏plugins.',
        inputSchema: {
            type: 'object',
            properties: {
                layerSpec: {
                    type: 'object',
                    description: 'Optional override of the default LayerSpec.',
                },
            },
        },
    },
    {
        name: 'code_tectonic_map',
        description: 'Module topology — modules as nodes, cross-module edges with per-kind weights, cyclic-module flags. Suitable for visualisation.',
        inputSchema: { type: 'object', properties: {} },
    },

    // ───────── new git tools (Phase 5) ─────────
    {
        name: 'code_churn',
        description: 'Recent change activity per file. Returns commits + additions + deletions over the lookback window.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Optional repo-relative path. Omit for whole-repo churn.' },
                sinceDays: { type: 'integer', default: 30, minimum: 1 },
            },
        },
    },
    {
        name: 'code_lineage',
        description: 'Per-line authorship history of a symbol. Output of git blame --line-porcelain over the symbol\'s byte range.',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Symbol id, name, or qualified name.' },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'code_pr_risk',
        description: 'Risk score for the current change set (staged or compare with baseRef). Combines blast radius × complexity × churn. Returns a band: low / medium / high / critical.',
        inputSchema: {
            type: 'object',
            properties: {
                scope: { type: 'string', enum: ['staged', 'unstaged', 'compare'], default: 'staged' },
                baseRef: { type: 'string' },
                sinceDaysForChurn: { type: 'integer', default: 30 },
            },
        },
    },
];

export const ATLAS_TOOL_NAMES: ReadonlySet<string> = new Set(ATLAS_TOOLS.map((t) => t.name));

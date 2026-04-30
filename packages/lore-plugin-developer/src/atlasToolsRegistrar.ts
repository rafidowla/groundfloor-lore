/**
 * developer/atlasToolsRegistrar.ts — Phase 6.1 wiring.
 *
 * Registers the 12 NEW Atlas analytics + git-signal MCP tools with
 * the live McpServer. Defined in mcp/tools.ts; handlers in
 * mcp/handlers.ts; this module is the registration glue + the
 * AtlasContext cache.
 *
 * Tool surface (12 tools):
 *   Analytics (8): code_blast_radius, code_pagerank, code_coupling,
 *                  code_cycles, code_dead_code, code_hotspots,
 *                  code_layer_violations, code_tectonic_map
 *   Git signals (4): code_churn, code_lineage, code_pr_risk,
 *                    code_detect_changes
 *
 * The 6 analytics + git-signal handlers in mcp/handlers.ts work off a
 * snapshot AtlasContext (parsed-graph + resolved-relations in memory).
 * This module builds that AtlasContext lazily on first call and caches
 * it for the daemon's lifetime. A workspace `lore analyze --refresh-atlas`
 * (future CLI) invalidates the cache.
 *
 * Phase: 6.1 (deferred handlers wiring).
 *
 * The 5 deferred Phase 6.1 handlers in mcp/handlers-phase61.ts
 * (code_query, code_context, code_rename, code_cypher, code_search_ast)
 * are NOT registered here — they overlap with names already in tools.ts
 * (the Kùzu-backed implementations from Part A). Registering both
 * would conflict on tool name. Atlas's parsed-graph is one source of
 * truth; the live Kùzu graph is another; the live graph wins for
 * those four overlaps because it has full per-workspace state.
 *
 * License-compliance note: original work; see
 * `docs/PLAN_replace_gitnexus_in_developer_plugin.md` section 10.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    handleBlastRadius,
    handleChurn,
    handleCoupling,
    handleCycles,
    handleDeadCode,
    handleDetectChanges,
    handleHotspots,
    handleLayerViolations,
    handleLineage,
    handlePageRank,
    handlePrRisk,
    handleTectonicMap,
    type AtlasContext,
} from './mcp/handlers.js';
import { parseRepo } from './parser/index.js';
import { resolveRepo } from './resolver/index.js';

/**
 * Lazily-built per-workspace AtlasContext. parseRepo + resolveRepo on
 * the lore monorepo takes ~3s; we run it once on first analytics-tool
 * call and cache. Multi-repo support (parse all 12 registered repos
 * and union the graph) is the next iteration — single-repo (REPO_ROOT)
 * is acceptable for v1 because the lore monorepo is the primary code
 * the developer plugin's user-of-its-own-tools cares about.
 */
let cachedContext: AtlasContext | null = null;
let buildPromise: Promise<AtlasContext> | null = null;

async function getOrBuildAtlasContext(repoRoot: string): Promise<AtlasContext> {
    if (cachedContext) return cachedContext;
    if (!buildPromise) {
        buildPromise = (async () => {
            const t0 = Date.now();
            console.error(`[atlas-tools] building AtlasContext for ${repoRoot}...`);
            const parsed = await parseRepo(repoRoot);
            const resolved = await resolveRepo(repoRoot, parsed.files);
            const dt = Date.now() - t0;
            console.error(`[atlas-tools]   parsed ${parsed.files.length} files / ${resolved.counts.symbols} symbols / ${resolved.relations.length} relations (${dt}ms)`);
            const ctx: AtlasContext = {
                repoRoot,
                table: resolved.table,
                relations: resolved.relations,
            };
            cachedContext = ctx;
            return ctx;
        })();
    }
    return buildPromise;
}

/** Test/CLI hook to invalidate the cached AtlasContext (no public CLI yet). */
export function invalidateAtlasContext(): void {
    cachedContext = null;
    buildPromise = null;
}

/** Wrap a handler in the standard MCP {content, isError} envelope. */
function wrap<T>(name: string, fn: () => T | Promise<T>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    return Promise.resolve()
        .then(fn)
        .then((result) => ({
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }))
        .catch((err) => ({
            content: [{ type: 'text' as const, text: `Error in ${name}: ${(err as Error).message}` }],
            isError: true,
        }));
}

export interface AtlasToolsContext {
    /** Repo to parse for the AtlasContext. v1 = single repo; multi-repo follow-up planned. */
    repoRoot: string;
}

export function registerAtlasTools(server: McpServer, atlasCtx: AtlasToolsContext): void {
    // 2026-04-30 — REVERTED the catalogue trim. The 3-iteration eval
    // showed the trim hurt answer quality (0.93 → 0.88) more than it
    // helped tokens. Coverage matters more than per-turn overhead at
    // this stage; some questions need tools the agent can't reach
    // without the full catalogue.
    //
    // Default flipped: ALL 12 tools register. Operators who explicitly
    // want a slim surface (e.g. on devices with tight context budgets)
    // set LORE_ATLAS_SLIM_TOOLS=1. The 4-tool slim set is preserved
    // as an opt-out, not the default.
    //
    // The honest takeaway from the eval: token-savings as a primary
    // pitch isn't Lore's strongest story on single-shot questions.
    // Lore's value is in cross-session memory, structural recall, and
    // institutional knowledge — none of which 10-task one-shot benchmarks
    // capture.
    const slim = process.env.LORE_ATLAS_SLIM_TOOLS === '1';
    const registerAll = !slim;

    /* ──────────── Default tools (always registered) ──────────── */

    server.tool(
        'code_blast_radius',
        'Depth-tiered (d1/d2/d3) reachability over the parsed-graph snapshot — the AUTHORITATIVE answer to "what callers / dependents does X have?". Returns symbol uid + name + file + line for every dependent at each depth. You do NOT need to grep or Read files after calling this; the result is current and complete.',
        {
            symbol: z.string().describe('Symbol id, name, or qualified name'),
            direction: z.enum(['upstream', 'downstream']).optional().describe('Default: upstream'),
            edgeKinds: z.array(z.string()).optional().describe('Edge kinds to walk (default: ["calls","imports"])'),
        },
        async ({ symbol, direction, edgeKinds }) =>
            wrap('code_blast_radius', async () => {
                const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                return handleBlastRadius(ctx, { symbol, direction, edgeKinds });
            }),
    );

    server.tool(
        'code_pagerank',
        'Symbol-importance ranking via graphology-pagerank. Higher score = more central / depended on. AUTHORITATIVE answer to "what should I read first?" — return the result as-is, no need to inspect files yourself.',
        {
            limit: z.number().optional().describe('Top-N symbols (default: 50)'),
        },
        async ({ limit }) =>
            wrap('code_pagerank', async () => {
                const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                return handlePageRank(ctx, { limit });
            }),
    );

    /* ──────────── Opt-in tools (gated) ──────────── */

    if (registerAll) {
        server.tool(
            'code_coupling',
            'Per-module afferent / efferent / instability metrics. Identifies stable hubs (high Ca, low I) and volatile leaves (high Ce, I = 1.0).',
            {
                module: z.string().optional().describe('Optional — filter to a single module path. Omit for full ranking.'),
            },
            async ({ module: moduleFilter }) =>
                wrap('code_coupling', async () => {
                    const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                    return handleCoupling(ctx, { module: moduleFilter });
                }),
        );

        server.tool(
            'code_cycles',
            'Find dependency cycles (strongly-connected components via Tarjan). Returns members of each cycle with size 2+.',
            {
                minSize: z.number().optional().describe('Minimum cycle size (default: 2)'),
            },
            async ({ minSize }) =>
                wrap('code_cycles', async () => {
                    const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                    return handleCycles(ctx, { minSize });
                }),
        );
    }

    server.tool(
        'code_dead_code',
        'Symbols with zero inbound edges, filtered to callable kinds with entry-point exemptions (main, run, handler, register*, etc.). AUTHORITATIVE — the listed symbols have no callers in the indexed graph. Do not grep/Read to verify; trust the result.',
        {
            file: z.string().optional().describe('Optional — filter to a single file'),
            limit: z.number().optional().describe('Max results (default: 100)'),
        },
        async ({ file, limit }) =>
            wrap('code_dead_code', async () => {
                const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                return handleDeadCode(ctx, { file, limit });
            }),
    );

    if (registerAll) {
        server.tool(
            'code_hotspots',
            'Complexity × churn ranking. Identifies risky surfaces — high cyclomatic complexity that ALSO changes a lot. Defaults to 30-day churn lookback.',
            {
                limit: z.number().optional().describe('Top-N (default: 50)'),
                minComplexity: z.number().optional().describe('Filter floor (default: 2)'),
                churnSinceDays: z.number().optional().describe('Churn lookback in days (default: 30)'),
            },
            async ({ limit, minComplexity, churnSinceDays }) =>
                wrap('code_hotspots', async () => {
                    const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                    return handleHotspots(ctx, { limit, minComplexity, churnSinceDays });
                }),
        );

        server.tool(
            'code_layer_violations',
            'Edges that violate user-declared LayerSpec rules. Default LayerSpec: ui→core OK, ui⇏plugins, core⇏plugins.',
            {
                layerSpec: z.record(z.string(), z.unknown()).optional().describe('Optional override of the default LayerSpec'),
            },
            async ({ layerSpec }) =>
                wrap('code_layer_violations', async () => {
                    const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                    return handleLayerViolations(ctx, { layerSpec: layerSpec as never });
                }),
        );

        server.tool(
            'code_tectonic_map',
            'Module topology — modules as nodes, cross-module edges with per-kind weights, cyclic-module flags. Suitable for visualisation.',
            {},
            async () =>
                wrap('code_tectonic_map', async () => {
                    const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                    return handleTectonicMap(ctx);
                }),
        );

        /* ──────────── Opt-in git-signal tools ──────────── */

        server.tool(
            'code_churn',
            'Recent change activity per file (commits + additions + deletions over the lookback window). Reads `git log --since=N days ago --numstat`. AUTHORITATIVE — do not run git log yourself; this tool already did.',
            {
                file: z.string().optional().describe('Optional repo-relative path. Omit for whole-repo churn.'),
                sinceDays: z.number().optional().describe('Lookback in days (default: 30)'),
            },
            async ({ file, sinceDays }) =>
                wrap('code_churn', async () => {
                    const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                    return handleChurn(ctx, { file, sinceDays });
                }),
        );

        server.tool(
            'code_lineage',
            'Per-line authorship history of a symbol. Output of git blame --line-porcelain over the symbol\'s byte range, plus distinct-author roll-up.',
            {
                symbol: z.string().describe('Symbol id, name, or qualified name'),
            },
            async ({ symbol }) =>
                wrap('code_lineage', async () => {
                    const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                    return handleLineage(ctx, { symbol });
                }),
        );
    }

    server.tool(
        'code_pr_risk',
        'Risk score for the current change set (staged or compare with baseRef). Combines blast radius × complexity × churn into a band: low / medium / high / critical.',
        {
            scope: z.enum(['staged', 'unstaged', 'compare']).optional().describe('Default: staged'),
            baseRef: z.string().optional().describe('Required when scope=compare (e.g. "main")'),
            sinceDaysForChurn: z.number().optional().describe('Churn lookback (default: 30)'),
        },
        async ({ scope, baseRef, sinceDaysForChurn }) =>
            wrap('code_pr_risk', async () => {
                const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                return handlePrRisk(ctx, { scope, baseRef, sinceDaysForChurn });
            }),
    );

    if (registerAll) {
        server.tool(
            'code_detect_changes',
            'Map git diff to affected symbols (Atlas-native variant of detect_changes). Use scope=staged before commit; scope=compare with baseRef for branch-vs-base.',
            {
                scope: z.enum(['staged', 'unstaged', 'compare']).optional().describe('Default: staged'),
                baseRef: z.string().optional().describe('Required when scope=compare'),
            },
            async ({ scope, baseRef }) =>
                wrap('code_detect_changes', async () => {
                    const ctx = await getOrBuildAtlasContext(atlasCtx.repoRoot);
                    return handleDetectChanges(ctx, { scope, baseRef });
                }),
        );
    }

    if (slim) {
        console.error('[atlas-tools] LORE_ATLAS_SLIM_TOOLS=1 — registered 4 essential tools only (code_blast_radius, code_pagerank, code_dead_code, code_pr_risk). Unset to register all 12.');
    } else {
        console.error('[atlas-tools] registered all 12 tools (default). Set LORE_ATLAS_SLIM_TOOLS=1 to register 4 essentials only.');
    }
}

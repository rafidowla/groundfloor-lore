/**
 * mcp/handlers.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * MCP tool handlers — dispatch into parser / resolver / analytics / git.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 6 (MCP tool surface).
 *
 * Each handler takes a typed `args` plus an `AtlasContext` (the
 * resolved-graph snapshot the daemon caches per workspace). Returns a
 * JSON-serialisable result shaped per the tool's mode parameter.
 *
 * The Phase 6.1 follow-up wires these into ILorePlugin.registerTools()
 * — that registration glue depends on the developer plugin's existing
 * PluginContext shape and sits at the plugin entry point.
 *
 * v1 ships handlers for the analytics + git tools (the unique value).
 * Handlers that integrate with Lore's existing Xenova embeddings /
 * verbatimStore semantic search (code_query) and the developer
 * plugin's existing rename infra (code_rename) are deferred to
 * Phase 6.1 — they require live PluginContext from the daemon, not
 * just the parsed-graph snapshot.
 */

import type { ParsedRelation, ParsedSymbol } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';
import {
    blastRadius,
    deadCode,
    dependencyCycles,
    hotspots,
    layerViolations,
    moduleCoupling,
    symbolPageRank,
    tectonicMap,
    defaultLoreLayerSpec,
    type LayerSpec,
} from '../analytics/index.js';
import {
    detectChanges,
    fileChurn,
    prRisk,
    repoChurn,
    symbolLineage,
    symbolAuthors,
    churnScore,
    type DetectScope,
} from '../git/index.js';

/**
 * The cached per-workspace graph snapshot every Atlas analytic / git
 * tool reads from. The daemon refreshes this on `lore analyze` and
 * keeps it in memory so MCP tool calls stay fast.
 */
export interface AtlasContext {
    repoRoot: string;
    table: SymbolTable;
    relations: ParsedRelation[];
}

/**
 * Resolve a name-or-id to a ParsedSymbol. Tries id-first lookup, then
 * qualified-name match, then bare-name fallback.
 */
function findSymbol(table: SymbolTable, nameOrId: string): ParsedSymbol | null {
    const byId = table.byId.get(nameOrId);
    if (byId) return byId;
    const qmatch = table.byQualifiedName.get(nameOrId);
    if (qmatch && qmatch.length > 0) return qmatch[0];
    for (const sym of table.all) {
        if (sym.name === nameOrId) return sym;
    }
    return null;
}

function thinSymbol(sym: ParsedSymbol): { id: string; name: string; file: string; line: number; kind: string } {
    return {
        id: sym.id,
        name: sym.qualifiedName,
        file: sym.file,
        line: sym.byteRange.startLine,
        kind: sym.kind,
    };
}

/* ──────────── Analytics handlers ──────────── */

export function handleBlastRadius(
    ctx: AtlasContext,
    args: { symbol: string; direction?: 'upstream' | 'downstream'; edgeKinds?: string[] },
) {
    const sym = findSymbol(ctx.table, args.symbol);
    if (!sym) return { error: `symbol not found: ${args.symbol}` };
    const edgeKinds = args.edgeKinds ? new Set(args.edgeKinds) : undefined;
    const br = blastRadius(sym.id, ctx.table, ctx.relations, args.direction ?? 'upstream', edgeKinds ? { edgeKinds } : {});
    return {
        symbol: thinSymbol(sym),
        direction: args.direction ?? 'upstream',
        d1: br.d1.map(thinSymbol),
        d2: br.d2.map(thinSymbol),
        d3: br.d3.map(thinSymbol),
    };
}

export function handleImpact(ctx: AtlasContext, args: { target: string; direction?: 'upstream' | 'downstream' }) {
    return handleBlastRadius(ctx, { symbol: args.target, direction: args.direction });
}

export function handlePageRank(ctx: AtlasContext, args: { limit?: number }) {
    const result = symbolPageRank(ctx.table, ctx.relations, { topN: args.limit ?? 50 });
    return {
        top: result.top.map((entry) => {
            const sym = ctx.table.byId.get(entry.symbolId);
            return {
                ...thinSymbol(sym ?? { id: entry.symbolId } as ParsedSymbol),
                score: entry.score,
            };
        }),
    };
}

export function handleCoupling(ctx: AtlasContext, args: { module?: string }) {
    const all = moduleCoupling(ctx.table, ctx.relations);
    if (args.module) return { coupling: all.filter((c) => c.module === args.module) };
    return { coupling: all };
}

export function handleCycles(ctx: AtlasContext, args: { minSize?: number }) {
    const cycles = dependencyCycles(ctx.table, ctx.relations, { minSize: args.minSize ?? 2 });
    return {
        cycles: cycles.map((c) => ({
            size: c.size,
            members: c.members.map((id) => {
                const sym = ctx.table.byId.get(id);
                return sym ? thinSymbol(sym) : { id, name: id };
            }),
        })),
    };
}

export function handleDeadCode(ctx: AtlasContext, args: { file?: string; limit?: number }) {
    const report = deadCode(ctx.table, ctx.relations);
    let candidates = report.candidates;
    if (args.file) candidates = candidates.filter((c) => c.file === args.file);
    return {
        stats: report.stats,
        candidates: candidates.slice(0, args.limit ?? 100).map(thinSymbol),
    };
}

export function handleHotspots(
    ctx: AtlasContext,
    args: { limit?: number; minComplexity?: number; churnSinceDays?: number },
) {
    const churnByFile = repoChurn(ctx.repoRoot, args.churnSinceDays ?? 30);
    const lookup = (filePath: string) => churnScore(churnByFile.get(filePath));
    const report = hotspots(ctx.table, lookup, {
        topN: args.limit ?? 50,
        minComplexity: args.minComplexity ?? 2,
    });
    return {
        hasChurnData: report.hasChurnData,
        entries: report.entries.map((e) => ({
            ...thinSymbol(e.symbol),
            complexity: e.complexity,
            churn: e.churn,
            score: Math.round(e.score * 100) / 100,
        })),
    };
}

export function handleLayerViolations(ctx: AtlasContext, args: { layerSpec?: LayerSpec }) {
    const violations = layerViolations(ctx.table, ctx.relations, args.layerSpec ?? defaultLoreLayerSpec());
    return { violations };
}

export function handleTectonicMap(ctx: AtlasContext) {
    const t = tectonicMap(ctx.table, ctx.relations);
    return {
        nodes: t.nodes,
        edges: t.edges,
        cyclicModules: Array.from(t.cyclicModules),
    };
}

/* ──────────── Git handlers ──────────── */

export function handleChurn(ctx: AtlasContext, args: { file?: string; sinceDays?: number }) {
    if (args.file) {
        const stats = fileChurn(ctx.repoRoot, args.file, args.sinceDays ?? 30);
        return { file: args.file, ...stats };
    }
    const map = repoChurn(ctx.repoRoot, args.sinceDays ?? 30);
    return { repo: Array.from(map.entries()).map(([file, stats]) => ({ file, ...stats })) };
}

export function handleLineage(ctx: AtlasContext, args: { symbol: string }) {
    const sym = findSymbol(ctx.table, args.symbol);
    if (!sym) return { error: `symbol not found: ${args.symbol}` };
    const blame = symbolLineage(ctx.repoRoot, sym);
    const authors = symbolAuthors(ctx.repoRoot, sym);
    return {
        symbol: thinSymbol(sym),
        authors,
        blame,
    };
}

export function handlePrRisk(
    ctx: AtlasContext,
    args: { scope?: DetectScope; baseRef?: string; sinceDaysForChurn?: number },
) {
    const report = prRisk(ctx.repoRoot, ctx.table, ctx.relations, {
        scope: args.scope ?? 'staged',
        baseRef: args.baseRef,
        sinceDaysForChurn: args.sinceDaysForChurn ?? 30,
    });
    return {
        band: report.band,
        totalScore: report.totalScore,
        factors: report.factors.map((f) => ({
            ...thinSymbol(f.symbol),
            blastD1: f.blastD1,
            complexity: f.complexity,
            churn: f.churn,
            score: Math.round(f.score * 100) / 100,
        })),
    };
}

export function handleDetectChanges(
    ctx: AtlasContext,
    args: { scope?: DetectScope; baseRef?: string },
) {
    const affected = detectChanges(ctx.repoRoot, ctx.table, args.scope ?? 'staged', args.baseRef);
    return {
        scope: args.scope ?? 'staged',
        baseRef: args.baseRef,
        affected: affected.map((a) => ({
            ...thinSymbol(a.symbol),
            ranges: a.overlappingRanges.map((r) => ({ startLine: r.startLine, endLine: r.endLine })),
        })),
    };
}

/**
 * Single registry of all Atlas v1 handlers. ILorePlugin.registerTools()
 * (Phase 6.1 follow-up) iterates this map alongside ATLAS_TOOLS to wire
 * the MCP server.
 *
 * code_query, code_context, code_rename, code_cypher, code_search_ast
 * are deferred to Phase 6.1 — they need live PluginContext (verbatim
 * store, Kùzu connection, existing nativeTools rename) which sits at
 * the plugin entry point, not in this module.
 */
export const ATLAS_HANDLERS: Map<string, (ctx: AtlasContext, args: never) => unknown> = new Map<string, (ctx: AtlasContext, args: never) => unknown>([
    ['code_impact', handleImpact as never],
    ['code_blast_radius', handleBlastRadius as never],
    ['code_pagerank', handlePageRank as never],
    ['code_coupling', handleCoupling as never],
    ['code_cycles', handleCycles as never],
    ['code_dead_code', handleDeadCode as never],
    ['code_hotspots', handleHotspots as never],
    ['code_layer_violations', handleLayerViolations as never],
    ['code_tectonic_map', handleTectonicMap as never],
    ['code_churn', handleChurn as never],
    ['code_lineage', handleLineage as never],
    ['code_pr_risk', handlePrRisk as never],
    ['code_detect_changes', handleDetectChanges as never],
]);

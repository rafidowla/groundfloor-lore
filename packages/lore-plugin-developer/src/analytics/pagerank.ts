/**
 * analytics/pagerank.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * PageRank over the symbol graph — caches scores on CodeSymbol.pagerank.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Builds a directed graph from the call+import edges and runs PageRank
 * to score symbol importance. Higher scores = more central / depended
 * on in the graph. Useful for "what are the load-bearing symbols in
 * this codebase" / "what should I review first when onboarding."
 *
 * Uses graphology (MIT) + graphology-pagerank (MIT). Both already
 * declared as runtime deps.
 */

import { DirectedGraph } from 'graphology';
import pagerank from 'graphology-pagerank';
import type { ParsedRelation } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';

export interface PageRankResult {
    /** symbolId → pagerank score (sum of all scores ≈ 1). */
    scores: Map<string, number>;
    /** Top-N most-important symbols by score. */
    top: Array<{ symbolId: string; score: number }>;
}

/**
 * Compute PageRank on the symbol graph. By default uses `calls` +
 * `imports` edges (the "this is structural / runtime importance"
 * view). Pass `edgeKinds` to override (e.g., include `extends` for
 * type-hierarchy importance).
 */
export function symbolPageRank(
    table: SymbolTable,
    relations: readonly ParsedRelation[],
    options: { edgeKinds?: ReadonlySet<string>; topN?: number } = {},
): PageRankResult {
    const edgeKinds = options.edgeKinds ?? new Set(['calls', 'imports']);
    const topN = options.topN ?? 50;

    const g = new DirectedGraph({ allowSelfLoops: true, multi: false });
    // Use mergeNode (idempotent) — Atlas symbol IDs can repeat for
    // overloads / duplicate declarations across files.
    for (const sym of table.all) {
        g.mergeNode(sym.id);
    }
    for (const rel of relations) {
        if (!edgeKinds.has(rel.kind)) continue;
        // Skip file-pseudo-node sources (Phase 4 hasn't extended schema yet).
        if (rel.sourceId.startsWith('file:')) continue;
        if (!g.hasNode(rel.sourceId) || !g.hasNode(rel.targetId)) continue;
        if (g.hasEdge(rel.sourceId, rel.targetId)) continue;
        g.addEdge(rel.sourceId, rel.targetId);
    }

    if (g.order === 0) return { scores: new Map(), top: [] };

    const raw = pagerank(g, { alpha: 0.85, tolerance: 1e-6, maxIterations: 100 });
    const scores = new Map<string, number>();
    const ranked: Array<{ symbolId: string; score: number }> = [];
    for (const [id, score] of Object.entries(raw)) {
        scores.set(id, score);
        ranked.push({ symbolId: id, score });
    }
    ranked.sort((a, b) => b.score - a.score);

    return { scores, top: ranked.slice(0, topN) };
}

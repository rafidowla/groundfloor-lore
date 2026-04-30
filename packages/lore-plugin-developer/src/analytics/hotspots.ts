/**
 * analytics/hotspots.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Complexity x churn ranking — depends on Phase 5 churn data.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Hotspots = files / symbols with high complexity AND high churn.
 * The heuristic: high-complexity code that changes often is where
 * bugs accumulate. Score = complexity × churn.
 *
 * Phase 5 supplies churn data. Until Phase 5 lands, callers can
 * pass a `churnLookup` function that returns 0 for unknown files;
 * the result will be all zeros (which the caller can detect and
 * fall back to a complexity-only ranking).
 */

import type { ParsedSymbol } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';

export interface HotspotEntry {
    symbol: ParsedSymbol;
    complexity: number;
    churn: number;
    score: number;
}

export interface HotspotReport {
    entries: HotspotEntry[];
    /** Whether Phase 5 churn data was available. If false, scores
     *  collapse to complexity-only — caller may want to surface that. */
    hasChurnData: boolean;
}

/**
 * Score symbols by complexity × churn. `churnLookup(filePath)` returns
 * a non-negative number representing recent churn (commits, line
 * changes — Phase 5 owns the exact metric). The scoring is monotonic
 * in both inputs.
 */
export function hotspots(
    table: SymbolTable,
    churnLookup: (filePath: string) => number,
    options: { topN?: number; minComplexity?: number } = {},
): HotspotReport {
    const topN = options.topN ?? 50;
    const minComplexity = options.minComplexity ?? 2;

    let hasChurnData = false;
    const entries: HotspotEntry[] = [];

    for (const sym of table.all) {
        if (sym.complexity < minComplexity) continue;
        const churn = churnLookup(sym.file);
        if (churn > 0) hasChurnData = true;
        entries.push({
            symbol: sym,
            complexity: sym.complexity,
            churn,
            score: sym.complexity * (churn || 1),  // fall back to complexity-only when churn = 0
        });
    }

    entries.sort((a, b) => b.score - a.score);
    return { entries: entries.slice(0, topN), hasChurnData };
}

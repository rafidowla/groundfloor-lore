/**
 * analytics/blastRadius.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Depth-tiered (d1/d2/d3) reachability over the call/import graph.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Computes the "blast radius" of a symbol — the set of symbols that
 * could be affected by a change to it. Direction:
 *
 *   - 'upstream' — who calls this symbol? (dependents that would
 *     break if this symbol's contract changes)
 *   - 'downstream' — what does this symbol call? (its dependencies)
 *
 * Returns three depth tiers that map directly to the impact rubric in
 * the project's CLAUDE.md ("d=1 WILL BREAK; d=2 LIKELY AFFECTED;
 * d=3 MAY NEED TESTING"). BFS layer-by-layer; each visited symbol
 * lands in the lowest depth at which it was first encountered.
 */

import type { ParsedRelation, ParsedSymbol } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';

export interface BlastRadius {
    /** Direct callers / callees. WILL BREAK on contract change. */
    d1: ParsedSymbol[];
    /** 2-hop reachable. LIKELY AFFECTED. */
    d2: ParsedSymbol[];
    /** 3-hop reachable. MAY NEED TESTING. */
    d3: ParsedSymbol[];
}

/** Build adjacency lists for a single direction. */
function buildAdjacency(
    relations: readonly ParsedRelation[],
    direction: 'upstream' | 'downstream',
    edgeKinds: ReadonlySet<string>,
): Map<string, string[]> {
    const adj = new Map<string, string[]>();
    for (const rel of relations) {
        if (!edgeKinds.has(rel.kind)) continue;
        // Upstream: traverse from target back to source (who reaches me?).
        // Downstream: traverse from source forward (who do I reach?).
        const from = direction === 'upstream' ? rel.targetId : rel.sourceId;
        const to = direction === 'upstream' ? rel.sourceId : rel.targetId;
        const list = adj.get(from);
        if (list) list.push(to);
        else adj.set(from, [to]);
    }
    return adj;
}

/**
 * Compute the depth-tiered blast radius for `symbolId`. By default
 * follows `calls` + `imports` edges; pass `edgeKinds` to override.
 */
export function blastRadius(
    symbolId: string,
    table: SymbolTable,
    relations: readonly ParsedRelation[],
    direction: 'upstream' | 'downstream' = 'upstream',
    options: { edgeKinds?: ReadonlySet<string> } = {},
): BlastRadius {
    const edgeKinds = options.edgeKinds ?? new Set(['calls', 'imports']);
    const adj = buildAdjacency(relations, direction, edgeKinds);
    const visited = new Set<string>([symbolId]);
    const tiers: string[][] = [[], [], []];

    let frontier = adj.get(symbolId) ?? [];
    for (let depth = 0; depth < 3; depth += 1) {
        const next: string[] = [];
        for (const id of frontier) {
            if (visited.has(id)) continue;
            visited.add(id);
            tiers[depth].push(id);
            const onward = adj.get(id);
            if (onward) next.push(...onward);
        }
        frontier = next;
    }

    const resolveTier = (ids: string[]): ParsedSymbol[] => {
        const out: ParsedSymbol[] = [];
        for (const id of ids) {
            const sym = table.byId.get(id);
            if (sym) out.push(sym);
        }
        return out;
    };

    return {
        d1: resolveTier(tiers[0]),
        d2: resolveTier(tiers[1]),
        d3: resolveTier(tiers[2]),
    };
}

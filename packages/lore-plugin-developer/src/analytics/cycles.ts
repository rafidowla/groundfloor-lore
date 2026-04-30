/**
 * analytics/cycles.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Tarjan SCC enumeration via graphology-components.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Finds strongly-connected components of size > 1 — i.e., dependency
 * cycles. A symbol pair (A, B) where A calls B and B calls A is an
 * SCC of size 2; longer cycles emerge as SCCs of size 3+.
 */

// graphology exposes both a default Graph class and named DirectedGraph;
// we use DirectedGraph (a named export) which TypeScript resolves cleanly
// under Node16 module resolution.
import { DirectedGraph } from 'graphology';
import { stronglyConnectedComponents } from 'graphology-components';
import type { ParsedRelation } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';

export interface DependencyCycle {
    /** symbolIds in the cycle. */
    members: string[];
    /** Number of members. */
    size: number;
}

export function dependencyCycles(
    table: SymbolTable,
    relations: readonly ParsedRelation[],
    options: { edgeKinds?: ReadonlySet<string>; minSize?: number } = {},
): DependencyCycle[] {
    const edgeKinds = options.edgeKinds ?? new Set(['calls', 'imports']);
    const minSize = options.minSize ?? 2;

    const g = new DirectedGraph({ allowSelfLoops: false, multi: false });
    for (const sym of table.all) g.mergeNode(sym.id);
    for (const rel of relations) {
        if (!edgeKinds.has(rel.kind)) continue;
        if (rel.sourceId.startsWith('file:')) continue;
        if (!g.hasNode(rel.sourceId) || !g.hasNode(rel.targetId)) continue;
        if (rel.sourceId === rel.targetId) continue;
        if (g.hasEdge(rel.sourceId, rel.targetId)) continue;
        g.addEdge(rel.sourceId, rel.targetId);
    }

    if (g.order === 0) return [];

    const components = stronglyConnectedComponents(g);
    const cycles: DependencyCycle[] = [];
    for (const component of components) {
        if (component.length >= minSize) {
            cycles.push({ members: component, size: component.length });
        }
    }
    cycles.sort((a, b) => b.size - a.size);
    return cycles;
}

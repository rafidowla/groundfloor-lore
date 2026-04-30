/**
 * analytics/tectonicMap.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Module topology view — aggregates symbols into modules with size, instability, dominant deps.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Returns a graph-shaped output suitable for visualisation:
 *   - nodes: one per module with size + instability + symbolCount
 *   - edges: aggregated cross-module edge counts (Module → Module)
 *
 * Reuses `coupling.ts` outputs rather than recomputing — fast.
 */

import * as path from 'node:path';
import type { ParsedRelation } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';
import { moduleCoupling, type ModuleCoupling } from './coupling.js';

export interface TectonicNode extends ModuleCoupling {
    /** Total bytes / LOC in this module — derived from symbols + files. */
    bytes: number;
    /** Lines of code. */
    loc: number;
}

export interface TectonicEdge {
    fromModule: string;
    toModule: string;
    weight: number;
    /** Per-edge-kind breakdown for the inter-module edges. */
    byKind: Record<string, number>;
}

export interface TectonicMap {
    nodes: TectonicNode[];
    edges: TectonicEdge[];
    /** Modules involved in any cycle — flagged for UI emphasis. */
    cyclicModules: Set<string>;
}

function defaultModuleOf(filePath: string): string {
    return path.dirname(filePath);
}

export function tectonicMap(
    table: SymbolTable,
    relations: readonly ParsedRelation[],
    options: { moduleOf?: (filePath: string) => string; edgeKinds?: ReadonlySet<string> } = {},
): TectonicMap {
    const moduleOf = options.moduleOf ?? defaultModuleOf;
    const edgeKinds = options.edgeKinds ?? new Set(['calls', 'imports']);

    // Coupling per module (afferent / efferent / instability).
    const couplings = moduleCoupling(table, relations, { moduleOf, edgeKinds });
    const couplingMap = new Map(couplings.map((c) => [c.module, c]));

    // Aggregate per-module size (bytes + LOC).
    // We don't have direct access to ParsedFile here, so derive from
    // symbol count as a rough proxy. Phase 4 follow-up could thread
    // ParsedFile[] through for exact byte counts.
    const symbolCount = new Map<string, number>();
    const symbolModule = new Map<string, string>();
    for (const sym of table.all) {
        const mod = moduleOf(sym.file);
        symbolModule.set(sym.id, mod);
        symbolCount.set(mod, (symbolCount.get(mod) ?? 0) + 1);
    }

    const nodes: TectonicNode[] = [];
    for (const c of couplings) {
        nodes.push({
            ...c,
            bytes: 0,           // TODO Phase 4 follow-up: thread ParsedFile in
            loc: 0,
        });
    }

    // Build cross-module edges with per-kind breakdown.
    const edgeMap = new Map<string, TectonicEdge>();
    for (const rel of relations) {
        if (!edgeKinds.has(rel.kind)) continue;
        if (rel.sourceId.startsWith('file:')) continue;
        const fromMod = symbolModule.get(rel.sourceId);
        const toMod = symbolModule.get(rel.targetId);
        if (!fromMod || !toMod || fromMod === toMod) continue;
        const key = `${fromMod}→${toMod}`;
        const existing = edgeMap.get(key);
        if (existing) {
            existing.weight += 1;
            existing.byKind[rel.kind] = (existing.byKind[rel.kind] ?? 0) + 1;
        } else {
            edgeMap.set(key, {
                fromModule: fromMod,
                toModule: toMod,
                weight: 1,
                byKind: { [rel.kind]: 1 },
            });
        }
    }

    // Cyclic-module flag: any module that has both an outbound and inbound
    // edge with the same opposite module is part of a 2-cycle. Larger
    // cycles are caught by analytics/cycles.ts; here we use a simple
    // 2-cycle indicator for the topology view.
    const cyclicModules = new Set<string>();
    const edges = Array.from(edgeMap.values());
    const reverseLookup = new Set(edges.map((e) => `${e.toModule}→${e.fromModule}`));
    for (const e of edges) {
        if (reverseLookup.has(`${e.fromModule}→${e.toModule}`)
            && couplingMap.has(e.fromModule)
            && couplingMap.has(e.toModule)) {
            cyclicModules.add(e.fromModule);
            cyclicModules.add(e.toModule);
        }
    }

    edges.sort((a, b) => b.weight - a.weight);

    return { nodes, edges, cyclicModules };
}

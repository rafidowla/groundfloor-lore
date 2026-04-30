/**
 * analytics/coupling.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Per-module afferent / efferent / instability metrics.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 4 (architectural analytics).
 *
 * Coupling metrics per module (defined as a directory path). For each
 * module:
 *
 *   - afferent (Ca):  count of edges INTO this module from outside
 *   - efferent (Ce):  count of edges OUT of this module to outside
 *   - instability (I):  Ce / (Ca + Ce). 0 = stable; 1 = volatile.
 *
 * "Module" boundary defaults to the immediate-parent directory of each
 * symbol's file. Caller can pass a custom moduleOf() function for
 * coarser groupings (e.g., bucket all of `packages/lore/src/*` under
 * one module).
 */

import * as path from 'node:path';
import type { ParsedRelation } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';

export interface ModuleCoupling {
    module: string;
    afferent: number;
    efferent: number;
    /** Ce / (Ca + Ce). null when both are zero. */
    instability: number | null;
    /** Symbols in this module. */
    symbolCount: number;
}

/** Default: parent directory of the file. e.g. `packages/lore/src/foo.ts` → `packages/lore/src`. */
function defaultModuleOf(filePath: string): string {
    return path.dirname(filePath);
}

export function moduleCoupling(
    table: SymbolTable,
    relations: readonly ParsedRelation[],
    options: { moduleOf?: (filePath: string) => string; edgeKinds?: ReadonlySet<string> } = {},
): ModuleCoupling[] {
    const moduleOf = options.moduleOf ?? defaultModuleOf;
    const edgeKinds = options.edgeKinds ?? new Set(['calls', 'imports']);

    // 1. symbolId → moduleName
    const symbolModule = new Map<string, string>();
    const moduleSymbols = new Map<string, number>();
    for (const sym of table.all) {
        const mod = moduleOf(sym.file);
        symbolModule.set(sym.id, mod);
        moduleSymbols.set(mod, (moduleSymbols.get(mod) ?? 0) + 1);
    }

    // 2. count cross-module edges per direction.
    const aff = new Map<string, number>();   // module → afferent count
    const eff = new Map<string, number>();   // module → efferent count

    for (const rel of relations) {
        if (!edgeKinds.has(rel.kind)) continue;
        if (rel.sourceId.startsWith('file:')) continue;
        const srcMod = symbolModule.get(rel.sourceId);
        const tgtMod = symbolModule.get(rel.targetId);
        if (!srcMod || !tgtMod) continue;
        if (srcMod === tgtMod) continue; // intra-module edge — neither aff nor eff
        eff.set(srcMod, (eff.get(srcMod) ?? 0) + 1);
        aff.set(tgtMod, (aff.get(tgtMod) ?? 0) + 1);
    }

    // 3. Assemble.
    const out: ModuleCoupling[] = [];
    for (const [mod, count] of moduleSymbols) {
        const a = aff.get(mod) ?? 0;
        const e = eff.get(mod) ?? 0;
        out.push({
            module: mod,
            afferent: a,
            efferent: e,
            instability: a + e === 0 ? null : e / (a + e),
            symbolCount: count,
        });
    }

    out.sort((x, y) => (y.afferent + y.efferent) - (x.afferent + x.efferent));
    return out;
}

/**
 * resolver/callGraph.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Call-graph resolver fallback — same-file + imported-function + heuristic method dispatch.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 2 (cross-file resolution — fallback path).
 *
 * **DEFERRED to Phase 2 fast-follow.** Call-graph construction needs
 * each per-language walker to emit raw call-site triples
 * `(callerSymbolId, calleeName, byteRange)` alongside ParsedSymbol[].
 * Today's walkers (Phase 1) emit only symbol declarations, not call
 * sites. Adding call-site extraction touches every walker (~3 days
 * across all 8 languages).
 *
 * The fast-follow shape:
 *   1. Each walker grows a `calls: ParsedCall[]` field on its returned
 *      WalkerOutput (alongside symbols / imports).
 *   2. `parser/types.ts` adds `ParsedCall` (callerSymbolId, calleeName,
 *      byteRange, isMethodCall, receiverHint?).
 *   3. This file imports `ParsedCall[]` from each ParsedFile and
 *      resolves each calleeName against the symbol table + import
 *      graph, emitting ParsedRelation[kind=calls] edges.
 *
 * This split keeps Phase 2 v1 shippable with import + inheritance
 * edges; the call graph lands as a focused follow-up PR.
 */

import type { ParsedFile, ParsedRelation } from '../parser/types.js';
import type { SymbolTable } from './symbolTable.js';
import type { ResolutionContext } from './importGraph.js';

/**
 * Stub: returns an empty edge set. Kept callable so the orchestrator
 * can wire it in once the walker enhancement lands without a second
 * orchestrator change.
 */
export function buildCallEdges(
    _files: readonly ParsedFile[],
    _table: SymbolTable,
    _ctx: ResolutionContext,
): ParsedRelation[] {
    // Phase 2 fast-follow will replace this stub with real resolution
    // once walkers emit ParsedCall[].
    return [];
}

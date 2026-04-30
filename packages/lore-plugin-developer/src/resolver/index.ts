/**
 * resolver/index.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Orchestrator: routes each file's resolution work and merges results
 * into a single edge stream.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 2 (cross-file resolution — fallback path).
 *
 * Public API:
 *   - resolveRepo(repoRoot, parsedFiles): Promise<ResolveResult>
 *
 * Strategy (locked at Phase 2 kickoff):
 *
 *   The plan originally proposed Stack Graphs as the primary cross-file
 *   resolver. At Phase 2 kickoff (2026-04-30) we audited the JS/WASM
 *   binding situation and confirmed: github/stack-graphs has only Rust
 *   crates today; the npm `tree-sitter-stack-graphs` package is a
 *   placeholder with no `main` entry and no working JS interface. The
 *   two options were (a) add a Rust sidecar binary as a build-time +
 *   ship-time dependency, or (b) use the per-language fallback
 *   resolver shims the plan already documented as the alternative.
 *
 *   Decision: ship (b) for v1. Stack Graphs becomes a future
 *   enhancement when interface-dispatch / generic-type resolution
 *   becomes a measurable bottleneck. Recorded in PHASE_2_OUTPUT.md.
 *
 * What v1 produces:
 *   - Symbol table (workspace-wide + per-file).
 *   - Import edges for TypeScript / JavaScript / Python.
 *   - Inheritance edges (extends / implements) — landed in inheritance.ts.
 *   - Containment edges (parent → child) — derived from parentSymbolId
 *     chains the parser already produces.
 *
 * Deferred to Phase 2 fast-follow (separate PR after this one merges):
 *   - Call graph edges. Requires extending the per-language walkers to
 *     emit call sites alongside ParsedSymbol (i.e., capture every
 *     `call_expression` / `function_call` / `method_invocation` node
 *     as a (callerSymbolId, calleeName, byteRange) triple). The
 *     resolver matches calleeName against the symbol table + import
 *     graph to produce ParsedRelation[kind=calls] edges. ~3 days
 *     across all 8 languages.
 *
 * The fast-follow split keeps Phase 2 v1 shippable end-to-end without
 * reworking every walker.
 */

import type { ParsedFile, ParsedRelation } from '../parser/types.js';
import {
    buildSymbolTable,
    type SymbolTable,
} from './symbolTable.js';
import {
    buildResolutionContext,
    buildImportEdges,
    type ResolutionContext,
} from './importGraph.js';
import { buildInheritanceEdges } from './inheritance.js';

export interface ResolveResult {
    table: SymbolTable;
    context: ResolutionContext;
    relations: ParsedRelation[];
    diagnostics: string[];
    /** Counts for observability. */
    counts: {
        symbols: number;
        files: number;
        importEdges: number;
        importsResolved: number;
        importsUnresolved: number;
        inheritanceEdges: number;
        containsEdges: number;
        durationMs: number;
    };
}

export async function resolveRepo(
    repoRoot: string,
    parsedFiles: readonly ParsedFile[],
): Promise<ResolveResult> {
    const startedAt = Date.now();
    const diagnostics: string[] = [];

    // 1. Symbol table.
    const table = buildSymbolTable(parsedFiles);

    // 2. Resolution context (tsconfig paths, file set).
    const context = await buildResolutionContext(repoRoot, parsedFiles);

    // 3. Import edges.
    const importResult = buildImportEdges(parsedFiles, table, context);

    // 4. Inheritance edges.
    const inheritanceEdges = buildInheritanceEdges(parsedFiles, table);

    // 5. Containment edges (parent → child) — derived from parentSymbolId.
    const containsEdges: ParsedRelation[] = [];
    for (const sym of table.all) {
        if (sym.parentSymbolId) {
            containsEdges.push({
                sourceId: sym.parentSymbolId,
                targetId: sym.id,
                kind: 'contains',
                confidence: 1.0,
                reason: 'parser parentSymbolId chain',
            });
        }
    }

    const relations: ParsedRelation[] = [
        ...importResult.edges,
        ...inheritanceEdges,
        ...containsEdges,
    ];

    return {
        table,
        context,
        relations,
        diagnostics,
        counts: {
            symbols: table.all.length,
            files: parsedFiles.length,
            importEdges: importResult.edges.length,
            importsResolved: importResult.resolved,
            importsUnresolved: importResult.unresolved,
            inheritanceEdges: inheritanceEdges.length,
            containsEdges: containsEdges.length,
            durationMs: Date.now() - startedAt,
        },
    };
}

// Re-exports for callers that want lower-level access.
export { buildSymbolTable, lookupByQualifiedName, lookupInFile } from './symbolTable.js';
export type { SymbolTable } from './symbolTable.js';
export { buildResolutionContext, buildImportEdges, resolveImport } from './importGraph.js';
export type { ResolutionContext } from './importGraph.js';
export { buildInheritanceEdges } from './inheritance.js';

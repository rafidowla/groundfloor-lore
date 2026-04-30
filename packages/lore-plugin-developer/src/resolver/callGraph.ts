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
 * Phase: 2.1 (call-graph fast-follow).
 *
 * Strategy: each ParsedFile carries a `calls: ParsedCall[]` populated
 * by the per-language walker. Each ParsedCall is a triple of
 * `(callerSymbolId, calleeName, byteRange)` plus a method-call flag
 * and receiver hint. The resolver matches each calleeName against:
 *
 *   1. Same-file local symbols (highest confidence — direct AST proximity)
 *   2. Symbols imported into the calling file (resolved via the import
 *      graph context built during Phase 2's resolver pass)
 *   3. Workspace-wide qualified-name match (e.g., `Foo.bar`)
 *   4. Workspace-wide bare-name match (lowest confidence — many
 *      candidates possible; we pick the first and flag low confidence
 *      so analytics can weight accordingly)
 *
 * Calls that don't match anywhere are dropped silently in v1; the
 * unresolved-rate is logged at the orchestrator level. Phase 9 (data
 * layer) and a possible future Stack Graphs path can sharpen this.
 */

import type { ParsedFile, ParsedRelation, ParsedSymbol } from '../parser/types.js';
import type { SymbolTable } from './symbolTable.js';
import { resolveImport, type ResolutionContext } from './importGraph.js';

interface FileImportTargets {
    /** importedName → resolvedFilePath (where the symbol was imported FROM). */
    namedImports: Map<string, string>;
    /** Wildcard / namespace imports — list of file paths brought in via `import * as ns from ...`. */
    wildcardSources: string[];
}

/**
 * Pre-compute, per file, a name→destinationFile map for resolved
 * imports. Used by the call resolver to handle "this name was imported,
 * so look in that file."
 */
function buildPerFileImportTargets(
    files: readonly ParsedFile[],
    ctx: ResolutionContext,
): Map<string, FileImportTargets> {
    const out = new Map<string, FileImportTargets>();
    for (const file of files) {
        const targets: FileImportTargets = { namedImports: new Map(), wildcardSources: [] };
        for (const imp of file.imports) {
            const resolved = resolveImport(file.path, file.language, imp, ctx);
            if (!resolved) continue;
            if (imp.names.length === 0 || imp.names.includes('*')) {
                targets.wildcardSources.push(resolved);
                continue;
            }
            for (const name of imp.names) {
                if (name === '*') continue;
                targets.namedImports.set(name, resolved);
            }
        }
        out.set(file.path, targets);
    }
    return out;
}

/**
 * Resolve a single ParsedCall to its target ParsedSymbol, using the
 * priority chain documented above. Returns null if no match.
 */
function resolveCall(
    call: ParsedFile['calls'][number],
    callerFile: string,
    table: SymbolTable,
    importTargets: FileImportTargets,
): { target: ParsedSymbol; confidence: number; reason: string } | null {
    const callee = call.calleeName;

    // 1. Same-file local symbol.
    const localCandidates = table.byFile.get(callerFile)?.get(callee) ?? [];
    if (localCandidates.length === 1) {
        return {
            target: localCandidates[0],
            confidence: 1.0,
            reason: 'same-file local match',
        };
    }
    if (localCandidates.length > 1) {
        // Pick first; method overloads / multiple impls are common.
        return {
            target: localCandidates[0],
            confidence: 0.85,
            reason: `same-file with ${localCandidates.length} candidates; picked first`,
        };
    }

    // 2. Imported into this file.
    const importedFromFile = importTargets.namedImports.get(callee);
    if (importedFromFile) {
        const targets = table.byFile.get(importedFromFile)?.get(callee) ?? [];
        if (targets.length > 0) {
            return {
                target: targets[0],
                confidence: 0.95,
                reason: `imported from ${importedFromFile}`,
            };
        }
    }

    // 2b. Wildcard import — search every wildcard source for a match.
    for (const wildcardFile of importTargets.wildcardSources) {
        const targets = table.byFile.get(wildcardFile)?.get(callee) ?? [];
        if (targets.length > 0) {
            return {
                target: targets[0],
                confidence: 0.8,
                reason: `wildcard import from ${wildcardFile}`,
            };
        }
    }

    // 3. Workspace-wide qualified-name match (e.g., callee was 'Foo.bar').
    const qualMatch = table.byQualifiedName.get(callee);
    if (qualMatch && qualMatch.length > 0) {
        return {
            target: qualMatch[0],
            confidence: 0.7,
            reason: `workspace-wide qualified-name match (${qualMatch.length} candidate${qualMatch.length === 1 ? '' : 's'})`,
        };
    }

    // 4. Workspace-wide bare-name match.
    let bareCandidates: ParsedSymbol[] = [];
    for (const [, fileMap] of table.byFile) {
        const matches = fileMap.get(callee);
        if (matches && matches.length > 0) {
            bareCandidates = bareCandidates.concat(matches);
        }
    }
    // Filter to callable kinds (function/method) — avoids matching a
    // class name when looking for the constructor (TS pattern), etc.
    const callable = bareCandidates.filter((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'class');
    if (callable.length > 0) {
        return {
            target: callable[0],
            confidence: 0.5,
            reason: `workspace-wide bare-name match (${callable.length} candidates)`,
        };
    }

    return null;
}

/**
 * Build call-graph edges across the workspace. One ParsedRelation
 * (kind=calls) per resolved ParsedCall.
 */
export function buildCallEdges(
    files: readonly ParsedFile[],
    table: SymbolTable,
    ctx: ResolutionContext,
): { edges: ParsedRelation[]; resolved: number; unresolved: number } {
    const importTargets = buildPerFileImportTargets(files, ctx);
    const edges: ParsedRelation[] = [];
    let resolved = 0;
    let unresolved = 0;

    for (const file of files) {
        const targetsForFile = importTargets.get(file.path) ?? { namedImports: new Map(), wildcardSources: [] };
        for (const call of file.calls) {
            const match = resolveCall(call, file.path, table, targetsForFile);
            if (!match) {
                unresolved += 1;
                continue;
            }
            resolved += 1;
            edges.push({
                sourceId: call.callerSymbolId,
                targetId: match.target.id,
                kind: 'calls',
                confidence: match.confidence,
                reason: match.reason,
            });
        }
    }

    return { edges, resolved, unresolved };
}

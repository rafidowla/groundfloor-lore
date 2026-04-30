/**
 * resolver/symbolTable.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Per-file and workspace-wide symbol tables (fallback path).
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 2 (cross-file resolution — fallback path).
 *
 * Builds two indexes from a list of ParsedFile:
 *
 *   - byQualifiedName: Map<qualifiedName, ParsedSymbol[]>
 *       Workspace-wide lookup. The same qualified name CAN map to
 *       multiple symbols (e.g., a function defined in two languages,
 *       or method overloads), so the value is an array.
 *
 *   - byFile: Map<filePath, Map<localName, ParsedSymbol[]>>
 *       Per-file lookup. Used when resolving same-file references
 *       without going through the import graph.
 *
 * The table is the foundation for both the import graph (matches
 * import targets) and the call graph (matches function references).
 *
 * Language-agnostic: this builder doesn't care about per-language
 * AST shapes; it operates on the already-parsed ParsedSymbol output.
 */

import type { ParsedFile, ParsedSymbol } from '../parser/types.js';

export interface SymbolTable {
    /** Lookup by fully qualified name. */
    readonly byQualifiedName: Map<string, ParsedSymbol[]>;
    /** Per-file lookup: filePath → localName → symbols. */
    readonly byFile: Map<string, Map<string, ParsedSymbol[]>>;
    /** All symbols, in insertion order. Useful for resolver iteration. */
    readonly all: readonly ParsedSymbol[];
    /** Lookup by symbol id (the parser's stable ID format). */
    readonly byId: Map<string, ParsedSymbol>;
}

/**
 * Build a symbol table from a list of parsed files. Pure function;
 * the result is owned by the caller and can be discarded freely.
 */
export function buildSymbolTable(files: readonly ParsedFile[]): SymbolTable {
    const byQualifiedName = new Map<string, ParsedSymbol[]>();
    const byFile = new Map<string, Map<string, ParsedSymbol[]>>();
    const byId = new Map<string, ParsedSymbol>();
    const all: ParsedSymbol[] = [];

    for (const file of files) {
        const fileMap = new Map<string, ParsedSymbol[]>();
        byFile.set(file.path, fileMap);

        for (const symbol of file.symbols) {
            all.push(symbol);
            byId.set(symbol.id, symbol);

            // Workspace-wide qualified-name index.
            const qList = byQualifiedName.get(symbol.qualifiedName);
            if (qList) qList.push(symbol);
            else byQualifiedName.set(symbol.qualifiedName, [symbol]);

            // Per-file local-name index.
            const localList = fileMap.get(symbol.name);
            if (localList) localList.push(symbol);
            else fileMap.set(symbol.name, [symbol]);
        }
    }

    return { byQualifiedName, byFile, byId, all };
}

/**
 * Look up a symbol by qualified name. Convenience over reading the map
 * directly. Returns the first match if multiple symbols share the
 * name; returns null if none.
 */
export function lookupByQualifiedName(table: SymbolTable, qualifiedName: string): ParsedSymbol | null {
    const list = table.byQualifiedName.get(qualifiedName);
    return list && list.length > 0 ? list[0] : null;
}

/**
 * Look up symbols by local name within a file. Returns all matches
 * (multiple symbols can share a local name in the same file —
 * e.g., function overloads in TypeScript declaration files).
 */
export function lookupInFile(table: SymbolTable, filePath: string, name: string): ParsedSymbol[] {
    const fileMap = table.byFile.get(filePath);
    if (!fileMap) return [];
    return fileMap.get(name) ?? [];
}

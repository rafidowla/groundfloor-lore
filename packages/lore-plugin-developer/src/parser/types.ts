/**
 * parser/types.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * ParsedSymbol, ParsedFile, ParsedRelation type contracts.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * These types are the parser's public output shape. Phase 3 maps them
 * into the developer plugin's existing Kùzu schema (CodeSymbol /
 * CodeFile / CodeRelation tables) via `operations.ts`. Keeping the
 * parser output decoupled from the storage shape lets us evolve either
 * side independently and makes the in-memory model easier to test.
 */

/**
 * Languages supported in the v1 parser. The string value is used as
 * the discriminator on `ParsedFile.language` and as the key into the
 * grammar registry in `parser/grammars.ts`.
 */
export type Language =
    | 'typescript'
    | 'tsx'
    | 'javascript'
    | 'python'
    | 'go'
    | 'rust'
    | 'java'
    | 'csharp'
    | 'c'
    | 'cpp'
    | 'ruby';

/**
 * Symbol kinds the parser emits. A small fixed vocabulary; per-language
 * walkers map their AST node types onto these.
 */
export type SymbolKind =
    | 'function'
    | 'method'
    | 'class'
    | 'interface'
    | 'enum'
    | 'constant'
    | 'variable'
    | 'type'
    | 'module'
    | 'decorator';

/**
 * Half-open byte range in the source file: `[start, end)`.
 */
export interface ByteRange {
    /** Inclusive start byte offset. */
    start: number;
    /** Exclusive end byte offset. */
    end: number;
    /** 1-based start line number. */
    startLine: number;
    /** 1-based end line number (inclusive). */
    endLine: number;
}

/**
 * A symbol extracted from source.
 *
 * `id` strategy: `<repoRelativePath>:<qualifiedName>:<kind>`. Stable
 * across re-parses as long as path + qualified name don't change.
 * Renames produce new IDs (Phase 6's rename tool records the mapping
 * explicitly).
 */
export interface ParsedSymbol {
    id: string;
    name: string;
    qualifiedName: string;
    kind: SymbolKind;
    file: string;
    byteRange: ByteRange;
    signature: string;
    complexity: number;
    parentSymbolId: string | null;
    parsedAt: string;
}

/**
 * An import statement extracted from source.
 */
export interface ParsedImport {
    /** Raw module specifier as written in source. */
    moduleSpecifier: string;
    /** Imported names. Empty = side-effect-only. `['*']` = wildcard. */
    names: string[];
    byteRange: ByteRange;
}

/**
 * The full parser output for one file.
 */
export interface ParsedFile {
    path: string;
    language: Language;
    symbols: ParsedSymbol[];
    imports: ParsedImport[];
    sizeBytes: number;
    loc: number;
    parsedAt: string;
}

/**
 * A relationship between two symbols.
 */
export type RelationKind =
    | 'calls'
    | 'imports'
    | 'extends'
    | 'implements'
    | 'contains';

export interface ParsedRelation {
    sourceId: string;
    targetId: string;
    kind: RelationKind;
    /** 0..1; 1.0 for direct AST extraction, <1 for heuristic resolves. */
    confidence: number;
    reason: string;
}

/**
 * Diagnostic emitted during parsing. Non-fatal — the walker logs and continues.
 */
export interface ParseDiagnostic {
    file: string;
    severity: 'info' | 'warn' | 'error';
    message: string;
    byteRange?: ByteRange;
}

/**
 * Result of `parseRepo`.
 */
export interface ParseRepoResult {
    files: ParsedFile[];
    diagnostics: ParseDiagnostic[];
    durationMs: number;
    skipped: Array<{ path: string; reason: string }>;
}

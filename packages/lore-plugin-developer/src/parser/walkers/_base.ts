/**
 * parser/walkers/_base.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Shared walker utilities (cyclomatic complexity, byte-range helpers).
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * These helpers are shared by every per-language walker. They sit at
 * the layer just above tree-sitter's SyntaxNode but below the
 * language-specific extraction logic. Anything language-specific
 * (e.g. "what AST node type is a function in this grammar") lives in
 * the per-language walker.
 */

import type Parser from 'web-tree-sitter';
import type { ByteRange, ParsedSymbol, SymbolKind } from '../types.js';

/**
 * Build a ByteRange from a tree-sitter SyntaxNode. Tree-sitter exposes
 * byte offsets and 0-based row/column natively; we convert rows to
 * 1-based line numbers (the convention Lore uses everywhere).
 */
export function byteRangeFromNode(node: Parser.SyntaxNode): ByteRange {
    return {
        start: node.startIndex,
        end: node.endIndex,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    };
}

/**
 * Build the stable id for a ParsedSymbol from its components. Per the
 * Phase 0 ID-strategy decision: `<file>:<qualifiedName>:<kind>`. This
 * is the same id format that Phase 7's cutover mapping table uses.
 *
 * `file` should be repo-relative with forward slashes (the parser
 * normalises before reaching here).
 */
export function buildSymbolId(file: string, qualifiedName: string, kind: SymbolKind): string {
    return `${file}:${qualifiedName}:${kind}`;
}

/**
 * Compute cyclomatic complexity for a tree-sitter subtree.
 *
 * Definition: 1 (entry point) + number of decision points encountered
 * while walking. Decision points are AST nodes whose `type` matches the
 * caller's `decisionTypes` set — that set is language-specific and
 * passed in by the walker. Common decision types across languages:
 * if, else_if, while, for, switch_case, conditional_expression (?:),
 * logical_and (&&), logical_or (||), catch.
 *
 * We don't try to canonicalise across languages here; let each walker
 * pass the right type names for its grammar. Keeps the walker honest
 * about its own AST and avoids surprises when a node type rename
 * happens upstream.
 */
export function cyclomaticComplexity(
    node: Parser.SyntaxNode,
    decisionTypes: ReadonlySet<string>,
): number {
    let count = 1;
    walkSubtree(node, (n) => {
        if (decisionTypes.has(n.type)) count += 1;
    });
    return count;
}

/**
 * Iterate every descendant of `root` (including `root`). Synchronous;
 * uses an explicit stack so deep ASTs don't blow the JS call stack.
 */
export function walkSubtree(
    root: Parser.SyntaxNode,
    visit: (node: Parser.SyntaxNode) => void,
): void {
    const stack: Parser.SyntaxNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        visit(node);
        for (let i = node.childCount - 1; i >= 0; i--) {
            const child = node.child(i);
            if (child) stack.push(child);
        }
    }
}

/**
 * Count source lines (LOC) excluding empty / whitespace-only lines.
 * Used by ParsedFile.loc.
 */
export function countLoc(source: string): number {
    let loc = 0;
    let inLine = false;
    for (let i = 0; i < source.length; i++) {
        const ch = source.charCodeAt(i);
        if (ch === 0x0a /* \n */) {
            if (inLine) loc += 1;
            inLine = false;
        } else if (ch !== 0x20 /* space */ && ch !== 0x09 /* tab */ && ch !== 0x0d /* \r */) {
            inLine = true;
        }
    }
    if (inLine) loc += 1; // last line without trailing \n
    return loc;
}

/**
 * Slice a substring by byte range from the parsed source.
 *
 * Tree-sitter byte offsets are byte-accurate against the original
 * UTF-8 input. JavaScript strings are UTF-16. We work with UTF-8
 * buffers throughout the parser to keep offsets honest; this helper
 * decodes the slice once.
 */
export function sliceBytes(sourceUtf8: Uint8Array, range: ByteRange): string {
    return new TextDecoder('utf-8').decode(sourceUtf8.slice(range.start, range.end));
}

/**
 * Build a single-line signature string from a node.
 *
 * Most languages give us a useful signature by taking the first line
 * of the symbol's source text (function declaration line + close-paren).
 * For multi-line declarations (Python decorators, TS overload chains)
 * we cap at 200 chars; analytics in Phase 4 don't care about exact
 * text and the signature is just for display.
 */
export function buildSignature(sourceUtf8: Uint8Array, node: Parser.SyntaxNode): string {
    const text = new TextDecoder('utf-8').decode(
        sourceUtf8.slice(node.startIndex, node.endIndex),
    );
    const firstLine = text.split(/\n/, 1)[0]?.trim() ?? '';
    return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

/**
 * Helper used by walkers to construct a finished ParsedSymbol from
 * the per-call extracted fields. Centralises the `parsedAt` timestamp
 * and id construction so walkers don't duplicate that boilerplate.
 */
export function makeParsedSymbol(args: {
    name: string;
    qualifiedName: string;
    kind: SymbolKind;
    file: string;
    byteRange: ByteRange;
    signature: string;
    complexity: number;
    parentSymbolId: string | null;
    parsedAt?: string;
}): ParsedSymbol {
    return {
        id: buildSymbolId(args.file, args.qualifiedName, args.kind),
        name: args.name,
        qualifiedName: args.qualifiedName,
        kind: args.kind,
        file: args.file,
        byteRange: args.byteRange,
        signature: args.signature,
        complexity: args.complexity,
        parentSymbolId: args.parentSymbolId,
        parsedAt: args.parsedAt ?? new Date().toISOString(),
    };
}

/**
 * Per-walker contract: every language's walker module exports a single
 * `walk` function with this shape. The walker takes the grammar's
 * SyntaxNode (the file's root) plus the source bytes plus the
 * repo-relative path, and returns symbols + imports.
 *
 * Returning ParsedRelation directly is left as a Phase 2 concern — the
 * walker focuses on what's extractable from one file's AST without
 * cross-file resolution. The `contains` relation (parent → child) is
 * implicit via parentSymbolId chains.
 */
export interface WalkerOutput {
    symbols: ParsedSymbol[];
    imports: import('../types.js').ParsedImport[];
}

export type WalkerFn = (
    rootNode: Parser.SyntaxNode,
    sourceUtf8: Uint8Array,
    file: string,
) => WalkerOutput;

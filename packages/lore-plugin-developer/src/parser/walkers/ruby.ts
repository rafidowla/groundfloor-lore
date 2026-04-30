/**
 * parser/walkers/ruby.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Ruby walker.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Extracts: method (instance method), singleton_method (class method),
 * class, module, module-level UPPER_SNAKE constants, and require /
 * require_relative imports (recognised as call expressions).
 */

import type Parser from 'web-tree-sitter';
import type { ParsedCall, ParsedImport, ParsedSymbol, SymbolKind } from '../types.js';
import {
    buildSignature,
    byteRangeFromNode,
    cyclomaticComplexity,
    extractCallsInBody,
    makeParsedSymbol,
    walkSubtree,
    type WalkerFn,
} from './_base.js';

const RUBY_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if',
    'elsif',
    'unless',
    'while',
    'until',
    'for',
    'case',
    'when',
    'rescue',
    'binary',  // overcounts but acceptable for v1
    'ternary',
]);

function nameOf(node: Parser.SyntaxNode): string | null {
    const n = node.childForFieldName('name');
    return n ? n.text : null;
}

function isModuleConstant(name: string): boolean {
    // Ruby constants start with uppercase. We only flag UPPER_SNAKE_CASE
    // module-level constants (matching gitnexus's typical filter); class
    // names already get caught via `class` extraction.
    return /^[A-Z][A-Z0-9_]*$/.test(name);
}

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
    const out: ParsedImport[] = [];
    walkSubtree(rootNode, (n) => {
        if (n.type !== 'call') return;
        const method = n.childForFieldName('method');
        if (!method) return;
        const methodName = method.text;
        if (methodName !== 'require' && methodName !== 'require_relative' && methodName !== 'autoload') return;
        const args = n.childForFieldName('arguments');
        if (!args || args.namedChildCount === 0) return;
        const firstArg = args.namedChild(0);
        if (!firstArg) return;
        // string node typically has a string_content child.
        const text = firstArg.text.replace(/^['"]|['"]$/g, '');
        out.push({
            moduleSpecifier: text,
            names: [],
            byteRange: byteRangeFromNode(n),
        });
    });
    return out;
}

function extractInBody(
    body: Parser.SyntaxNode,
    sourceUtf8: Uint8Array,
    file: string,
    parentSymbolId: string | null,
    parentQ: string | null,
    parentKind: SymbolKind | null,
    out: ParsedSymbol[],
): void {
    for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (!child) continue;

        // tree-sitter-ruby wraps class/module/method bodies in a
        // `body_statement` node. Recurse into it transparently.
        if (child.type === 'body_statement') {
            extractInBody(child, sourceUtf8, file, parentSymbolId, parentQ, parentKind, out);
            continue;
        }

        if (child.type === 'class' || child.type === 'module') {
            const name = nameOf(child);
            if (!name) continue;
            const kind: SymbolKind = child.type === 'class' ? 'class' : 'module';
            const qname = parentQ ? `${parentQ}::${name}` : name;
            const sym = makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind,
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: 1,
                parentSymbolId,
            });
            out.push(sym);
            // Body children are siblings of the name field; iterate the whole node.
            extractInBody(child, sourceUtf8, file, sym.id, qname, kind, out);
        } else if (child.type === 'method' || child.type === 'singleton_method') {
            const name = nameOf(child);
            if (!name) continue;
            const kind: SymbolKind = parentKind === 'class' || parentKind === 'module' ? 'method' : 'function';
            const qname = parentQ ? `${parentQ}#${name}` : name;
            out.push(makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind,
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, RUBY_DECISION_TYPES),
                parentSymbolId,
            }));
        } else if (parentKind === null && child.type === 'assignment') {
            // Module-level assignment to a constant.
            const lhs = child.childForFieldName('left');
            if (lhs && lhs.type === 'constant' && isModuleConstant(lhs.text)) {
                const name = lhs.text;
                out.push(makeParsedSymbol({
                    name,
                    qualifiedName: name,
                    kind: 'constant',
                    file,
                    byteRange: byteRangeFromNode(child),
                    signature: buildSignature(sourceUtf8, child),
                    complexity: 1,
                    parentSymbolId,
                }));
            }
        }
    }
}

export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    extractInBody(rootNode, sourceUtf8, file, null, null, null, symbols);

    // Phase 2.1: extract calls per method body. Ruby has many call shapes; we
    // handle the dominant ones:
    //   - call  → x.foo or x.foo(args)  (method or qualified-name call)
    //   - identifier as method (bare name without parens) is parsed as
    //     identifier; we don't catch it here without scope analysis.
    // require / require_relative / autoload calls are filtered — they're
    // imports, not call edges. (Already extracted as ParsedImports above.)
    const calls: ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'method' && node.type !== 'singleton_method') return;
        const body = node.childForFieldName('body');
        if (!body) return;
        const owner = symbols.find((s) =>
            s.byteRange.start <= node.startIndex && s.byteRange.end >= node.endIndex
            && (s.kind === 'method' || s.kind === 'function'));
        if (!owner) return;
        calls.push(...extractCallsInBody(body, owner.id, RUBY_CALL_NODE_TYPES, extractRubyCallee));
    });

    return { symbols, imports: extractImports(rootNode), calls };
};

const RUBY_CALL_NODE_TYPES: ReadonlySet<string> = new Set(['call']);

const RUBY_IMPORT_METHODS = new Set(['require', 'require_relative', 'autoload']);

function extractRubyCallee(node: Parser.SyntaxNode): { name: string; isMethod: boolean; receiver: string | null } | null {
    const method = node.childForFieldName('method');
    if (!method) return null;
    const methodName = method.text;
    // Filter out require/require_relative/autoload — already captured as imports.
    if (RUBY_IMPORT_METHODS.has(methodName)) return null;
    const receiver = node.childForFieldName('receiver');
    return {
        name: methodName,
        isMethod: !!receiver,
        receiver: receiver?.text ?? null,
    };
}

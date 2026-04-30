/**
 * parser/walkers/rust.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Rust walker.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Extracts: function_item, impl_item (methods inside attribute to the
 * impl's target type), struct_item, enum_item, trait_item, mod_item,
 * type_item, const_item, static_item, and use_declaration imports.
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

const RUST_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_expression',
    'else_clause',
    'for_expression',
    'while_expression',
    'loop_expression',
    'match_expression',
    'match_arm',
    'binary_expression', // overcounts; acceptable for v1
]);

function nameOf(node: Parser.SyntaxNode): string | null {
    const n = node.childForFieldName('name');
    return n ? n.text : null;
}

function pushSimple(
    out: ParsedSymbol[],
    node: Parser.SyntaxNode,
    sourceUtf8: Uint8Array,
    file: string,
    kind: SymbolKind,
    parentSymbolId: string | null,
    parentQ: string | null,
): void {
    const name = nameOf(node);
    if (!name) return;
    const qname = parentQ ? `${parentQ}::${name}` : name;
    out.push(makeParsedSymbol({
        name,
        qualifiedName: qname,
        kind,
        file,
        byteRange: byteRangeFromNode(node),
        signature: buildSignature(sourceUtf8, node),
        complexity: cyclomaticComplexity(node, RUST_DECISION_TYPES),
        parentSymbolId,
    }));
}

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
    const out: ParsedImport[] = [];
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const child = rootNode.namedChild(i);
        if (!child) continue;
        if (child.type !== 'use_declaration') continue;
        const argument = child.childForFieldName('argument');
        if (!argument) continue;
        out.push({
            moduleSpecifier: argument.text,
            names: [],
            byteRange: byteRangeFromNode(child),
        });
    }
    return out;
}

function extractInBody(
    body: Parser.SyntaxNode,
    sourceUtf8: Uint8Array,
    file: string,
    parentSymbolId: string | null,
    parentQ: string | null,
    inImpl: boolean,
    out: ParsedSymbol[],
): void {
    for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (!child) continue;

        switch (child.type) {
            case 'function_item': {
                const kind: SymbolKind = inImpl || parentSymbolId ? 'method' : 'function';
                pushSimple(out, child, sourceUtf8, file, kind, parentSymbolId, parentQ);
                break;
            }
            case 'struct_item':
                pushSimple(out, child, sourceUtf8, file, 'class', parentSymbolId, parentQ);
                break;
            case 'enum_item':
                pushSimple(out, child, sourceUtf8, file, 'enum', parentSymbolId, parentQ);
                break;
            case 'trait_item': {
                const name = nameOf(child);
                if (!name) break;
                const qname = parentQ ? `${parentQ}::${name}` : name;
                const sym = makeParsedSymbol({
                    name,
                    qualifiedName: qname,
                    kind: 'interface',
                    file,
                    byteRange: byteRangeFromNode(child),
                    signature: buildSignature(sourceUtf8, child),
                    complexity: 1,
                    parentSymbolId,
                });
                out.push(sym);
                const innerBody = child.childForFieldName('body');
                if (innerBody) extractInBody(innerBody, sourceUtf8, file, sym.id, qname, true, out);
                break;
            }
            case 'mod_item': {
                const name = nameOf(child);
                if (!name) break;
                const qname = parentQ ? `${parentQ}::${name}` : name;
                const sym = makeParsedSymbol({
                    name,
                    qualifiedName: qname,
                    kind: 'module',
                    file,
                    byteRange: byteRangeFromNode(child),
                    signature: buildSignature(sourceUtf8, child),
                    complexity: 1,
                    parentSymbolId,
                });
                out.push(sym);
                const innerBody = child.childForFieldName('body');
                if (innerBody) extractInBody(innerBody, sourceUtf8, file, sym.id, qname, false, out);
                break;
            }
            case 'impl_item': {
                // impl Block: methods inside attribute to the target type.
                const typeNode = child.childForFieldName('type');
                const targetName = typeNode ? typeNode.text : 'impl';
                const innerBody = child.childForFieldName('body');
                if (innerBody) {
                    // Use targetName as the parent qname so methods get qualified properly.
                    extractInBody(innerBody, sourceUtf8, file, parentSymbolId, targetName, true, out);
                }
                break;
            }
            case 'type_item':
                pushSimple(out, child, sourceUtf8, file, 'type', parentSymbolId, parentQ);
                break;
            case 'const_item':
                pushSimple(out, child, sourceUtf8, file, 'constant', parentSymbolId, parentQ);
                break;
            case 'static_item':
                pushSimple(out, child, sourceUtf8, file, 'variable', parentSymbolId, parentQ);
                break;
            default:
                break;
        }
    }
}

export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    extractInBody(rootNode, sourceUtf8, file, null, null, false, symbols);

    // Phase 2.1: extract calls per function-item body. Rust has two call shapes:
    //   - call_expression  → free function or method-style on path: foo() or Foo::bar()
    //   - method_call_expression  → instance method: x.foo()
    // Macros (println!) appear as macro_invocation; skipped — not real call edges.
    const calls: ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'function_item') return;
        const body = node.childForFieldName('body');
        if (!body) return;
        const owner = symbols.find((s) =>
            s.byteRange.start <= node.startIndex && s.byteRange.end >= node.endIndex
            && (s.kind === 'function' || s.kind === 'method'));
        if (!owner) return;
        calls.push(...extractCallsInBody(body, owner.id, RUST_CALL_NODE_TYPES, extractRustCallee));
    });

    return { symbols, imports: extractImports(rootNode), calls };
};

const RUST_CALL_NODE_TYPES: ReadonlySet<string> = new Set([
    'call_expression',
    'method_call_expression',
]);

function extractRustCallee(node: Parser.SyntaxNode): { name: string; isMethod: boolean; receiver: string | null } | null {
    if (node.type === 'method_call_expression') {
        const receiver = node.childForFieldName('value');
        const method = node.childForFieldName('method');
        if (method) {
            return { name: method.text, isMethod: true, receiver: receiver?.text ?? null };
        }
        return null;
    }
    // call_expression
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') {
        return { name: fn.text, isMethod: false, receiver: null };
    }
    if (fn.type === 'scoped_identifier' || fn.type === 'field_expression') {
        // Foo::bar()  or  obj.field()  → extract trailing identifier
        const last = fn.namedChild(fn.namedChildCount - 1);
        if (last && (last.type === 'identifier' || last.type === 'field_identifier')) {
            const head = fn.namedChild(0);
            return {
                name: last.text,
                isMethod: fn.type === 'field_expression',
                receiver: head?.text ?? null,
            };
        }
    }
    return null;
}

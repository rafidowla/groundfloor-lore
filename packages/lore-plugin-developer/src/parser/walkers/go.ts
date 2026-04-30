/**
 * parser/walkers/go.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Go walker.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Extracts: function declarations, method declarations (with receiver
 * type as parent), type declarations (struct / interface / alias),
 * const declarations, var declarations, and import declarations.
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

const GO_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_statement',
    'for_statement',
    'expression_switch_statement',
    'type_switch_statement',
    'select_statement',
    'expression_case',
    'default_case',
    'type_case',
    'communication_case',
    'binary_expression',  // includes && and || — overcounts but acceptable for v1
]);

function nameOf(node: Parser.SyntaxNode): string | null {
    const name = node.childForFieldName('name');
    return name ? name.text : null;
}

/** Resolve receiver type name from a method_declaration's receiver field. */
function receiverTypeName(node: Parser.SyntaxNode): string | null {
    const receiver = node.childForFieldName('receiver');
    if (!receiver) return null;
    // receiver is a parameter_list; find the type identifier.
    let typeName: string | null = null;
    for (let i = 0; i < receiver.namedChildCount; i++) {
        const param = receiver.namedChild(i);
        if (!param) continue;
        // Look for type_identifier or pointer_type → type_identifier.
        const typeNode = param.childForFieldName('type');
        if (!typeNode) continue;
        if (typeNode.type === 'type_identifier') {
            typeName = typeNode.text;
        } else if (typeNode.type === 'pointer_type') {
            const inner = typeNode.namedChild(0);
            if (inner && inner.type === 'type_identifier') {
                typeName = inner.text;
            }
        }
        if (typeName) break;
    }
    return typeName;
}

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
    const out: ParsedImport[] = [];
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const child = rootNode.namedChild(i);
        if (!child) continue;
        if (child.type !== 'import_declaration') continue;

        // import_spec children — single or list.
        for (let j = 0; j < child.namedChildCount; j++) {
            const spec = child.namedChild(j);
            if (!spec) continue;
            if (spec.type === 'import_spec') {
                const path = spec.childForFieldName('path');
                if (path) {
                    out.push({
                        moduleSpecifier: path.text.replace(/^"|"$/g, ''),
                        names: [],
                        byteRange: byteRangeFromNode(spec),
                    });
                }
            } else if (spec.type === 'import_spec_list') {
                for (let k = 0; k < spec.namedChildCount; k++) {
                    const inner = spec.namedChild(k);
                    if (!inner || inner.type !== 'import_spec') continue;
                    const path = inner.childForFieldName('path');
                    if (path) {
                        out.push({
                            moduleSpecifier: path.text.replace(/^"|"$/g, ''),
                            names: [],
                            byteRange: byteRangeFromNode(inner),
                        });
                    }
                }
            }
        }
    }
    return out;
}

export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const child = rootNode.namedChild(i);
        if (!child) continue;

        if (child.type === 'function_declaration') {
            const name = nameOf(child);
            if (!name) continue;
            symbols.push(makeParsedSymbol({
                name,
                qualifiedName: name,
                kind: 'function',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, GO_DECISION_TYPES),
                parentSymbolId: null,
            }));
        } else if (child.type === 'method_declaration') {
            const name = nameOf(child);
            if (!name) continue;
            const receiver = receiverTypeName(child);
            const qname = receiver ? `${receiver}.${name}` : name;
            symbols.push(makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind: 'method',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, GO_DECISION_TYPES),
                parentSymbolId: null, // receiver type sits in qualifiedName; cross-file resolver fills the edge in Phase 2
            }));
        } else if (child.type === 'type_declaration') {
            // type_declaration wraps type_spec children.
            for (let j = 0; j < child.namedChildCount; j++) {
                const spec = child.namedChild(j);
                if (!spec) continue;
                if (spec.type !== 'type_spec' && spec.type !== 'type_alias') continue;
                const name = nameOf(spec);
                if (!name) continue;
                const inner = spec.childForFieldName('type');
                let kind: SymbolKind = 'type';
                if (inner) {
                    if (inner.type === 'struct_type') kind = 'class';
                    else if (inner.type === 'interface_type') kind = 'interface';
                }
                symbols.push(makeParsedSymbol({
                    name,
                    qualifiedName: name,
                    kind,
                    file,
                    byteRange: byteRangeFromNode(spec),
                    signature: buildSignature(sourceUtf8, spec),
                    complexity: 1,
                    parentSymbolId: null,
                }));
            }
        } else if (child.type === 'const_declaration' || child.type === 'var_declaration') {
            const declKind: SymbolKind = child.type === 'const_declaration' ? 'constant' : 'variable';
            for (let j = 0; j < child.namedChildCount; j++) {
                const spec = child.namedChild(j);
                if (!spec) continue;
                if (spec.type !== 'const_spec' && spec.type !== 'var_spec') continue;
                // Each spec may declare multiple names.
                for (let k = 0; k < spec.namedChildCount; k++) {
                    const id = spec.namedChild(k);
                    if (!id || id.type !== 'identifier') continue;
                    const name = id.text;
                    symbols.push(makeParsedSymbol({
                        name,
                        qualifiedName: name,
                        kind: declKind,
                        file,
                        byteRange: byteRangeFromNode(spec),
                        signature: buildSignature(sourceUtf8, spec),
                        complexity: 1,
                        parentSymbolId: null,
                    }));
                }
            }
        }
    }
    // Phase 2.1: extract calls per function/method body.
    // Go call_expression has function child:
    //   - identifier  → free function call: foo()
    //   - selector_expression  → method/qualified call: x.Foo() or pkg.Foo()
    //   - func_literal-then-call shapes → dynamic, skipped
    const calls: ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'function_declaration' && node.type !== 'method_declaration') return;
        const body = node.childForFieldName('body');
        if (!body) return;
        const owner = symbols.find((s) =>
            s.byteRange.start <= node.startIndex && s.byteRange.end >= node.endIndex
            && (s.kind === 'function' || s.kind === 'method'));
        if (!owner) return;
        calls.push(...extractCallsInBody(body, owner.id, GO_CALL_NODE_TYPES, extractGoCallee));
    });

    return { symbols, imports: extractImports(rootNode), calls };
};

const GO_CALL_NODE_TYPES: ReadonlySet<string> = new Set(['call_expression']);

function extractGoCallee(node: Parser.SyntaxNode): { name: string; isMethod: boolean; receiver: string | null } | null {
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') {
        return { name: fn.text, isMethod: false, receiver: null };
    }
    if (fn.type === 'selector_expression') {
        const operand = fn.childForFieldName('operand');
        const field = fn.childForFieldName('field');
        if (field) {
            return { name: field.text, isMethod: true, receiver: operand?.text ?? null };
        }
    }
    return null;
}

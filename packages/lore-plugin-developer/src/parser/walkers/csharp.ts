/**
 * parser/walkers/csharp.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * C# walker.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Extracts: namespace_declaration / file_scoped_namespace_declaration,
 * class_declaration, interface_declaration, struct_declaration,
 * record_declaration, method_declaration, constructor_declaration,
 * enum_declaration, and using_directive imports.
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

const CS_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_statement',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'switch_section',
    'case_switch_label',
    'catch_clause',
    'conditional_expression',
    'binary_expression', // overcounts
]);

const TYPE_DECL = new Set([
    'class_declaration',
    'interface_declaration',
    'struct_declaration',
    'record_declaration',
    'enum_declaration',
]);

function nameOf(node: Parser.SyntaxNode): string | null {
    const n = node.childForFieldName('name');
    return n ? n.text : null;
}

function kindOfTypeDecl(t: string): SymbolKind {
    switch (t) {
        case 'interface_declaration':
            return 'interface';
        case 'enum_declaration':
            return 'enum';
        default:
            return 'class';
    }
}

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
    const out: ParsedImport[] = [];
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const child = rootNode.namedChild(i);
        if (!child) continue;
        if (child.type !== 'using_directive') continue;
        const nameNode = child.childForFieldName('name') ?? child.namedChild(child.namedChildCount - 1);
        if (!nameNode) continue;
        out.push({
            moduleSpecifier: nameNode.text,
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
    out: ParsedSymbol[],
): void {
    for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (!child) continue;

        if (child.type === 'namespace_declaration' || child.type === 'file_scoped_namespace_declaration') {
            const name = nameOf(child);
            if (!name) continue;
            const qname = parentQ ? `${parentQ}.${name}` : name;
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
            const inner = child.childForFieldName('body') ?? child;
            if (inner !== child) extractInBody(inner, sourceUtf8, file, sym.id, qname, out);
            else {
                // file_scoped_namespace_declaration: contents follow the declaration directly
                for (let j = 0; j < body.namedChildCount; j++) {
                    const sibling = body.namedChild(j);
                    if (!sibling || sibling === child) continue;
                    if (TYPE_DECL.has(sibling.type)) {
                        // Walk the rest at this scope as namespace children.
                        extractInBody(body, sourceUtf8, file, sym.id, qname, out);
                        return;
                    }
                }
            }
        } else if (TYPE_DECL.has(child.type)) {
            const name = nameOf(child);
            if (!name) continue;
            const kind = kindOfTypeDecl(child.type);
            const qname = parentQ ? `${parentQ}.${name}` : name;
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
            const inner = child.childForFieldName('body');
            if (inner) extractInBody(inner, sourceUtf8, file, sym.id, qname, out);
        } else if (child.type === 'method_declaration' || child.type === 'constructor_declaration') {
            const name = nameOf(child) ?? 'constructor';
            const qname = parentQ ? `${parentQ}.${name}` : name;
            out.push(makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind: 'method',
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, CS_DECISION_TYPES),
                parentSymbolId,
            }));
        }
    }
}

export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    extractInBody(rootNode, sourceUtf8, file, null, null, symbols);

    // Phase 2.1: extract calls per method/constructor body. C# call shapes:
    //   - invocation_expression  → foo() / obj.foo() / Class.foo()
    //   - object_creation_expression  → new Foo()
    const calls: ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'method_declaration' && node.type !== 'constructor_declaration') return;
        const body = node.childForFieldName('body');
        if (!body) return;
        const owner = symbols.find((s) =>
            s.byteRange.start <= node.startIndex && s.byteRange.end >= node.endIndex
            && s.kind === 'method');
        if (!owner) return;
        calls.push(...extractCallsInBody(body, owner.id, CS_CALL_NODE_TYPES, extractCsCallee));
    });

    return { symbols, imports: extractImports(rootNode), calls };
};

const CS_CALL_NODE_TYPES: ReadonlySet<string> = new Set([
    'invocation_expression',
    'object_creation_expression',
]);

function extractCsCallee(node: Parser.SyntaxNode): { name: string; isMethod: boolean; receiver: string | null } | null {
    if (node.type === 'object_creation_expression') {
        const type = node.childForFieldName('type');
        if (type) return { name: type.text, isMethod: false, receiver: null };
        return null;
    }
    // invocation_expression: function field is identifier OR member_access_expression
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') {
        return { name: fn.text, isMethod: false, receiver: null };
    }
    if (fn.type === 'member_access_expression') {
        const expr = fn.childForFieldName('expression');
        const member = fn.childForFieldName('name');
        if (member) {
            return { name: member.text, isMethod: true, receiver: expr?.text ?? null };
        }
    }
    return null;
}

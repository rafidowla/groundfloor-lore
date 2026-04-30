/**
 * parser/walkers/python.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Python walker.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Extracts: function definitions, class definitions, methods (functions
 * inside classes), module-level UPPER_SNAKE_CASE assignments as constants,
 * and import statements. Decorated definitions are unwrapped — the
 * inner function/class is the symbol; the decorator chain is captured
 * as part of the signature.
 */

import type Parser from 'web-tree-sitter';
import type { ParsedImport, ParsedSymbol, SymbolKind } from '../types.js';
import {
    buildSignature,
    byteRangeFromNode,
    cyclomaticComplexity,
    extractCallsInBody,
    makeParsedSymbol,
    walkSubtree,
    type WalkerFn,
} from './_base.js';

const PY_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_statement',
    'elif_clause',
    'else_clause',
    'for_statement',
    'while_statement',
    'try_statement',
    'except_clause',
    'conditional_expression',
    'boolean_operator', // and / or
    'match_statement',
    'case_clause',
]);

/** Unwrap a decorated_definition to its inner function/class. */
function unwrapDecorated(node: Parser.SyntaxNode): Parser.SyntaxNode {
    if (node.type === 'decorated_definition') {
        const inner = node.childForFieldName('definition')
            ?? node.namedChildren.find((n: Parser.SyntaxNode) =>
                n.type === 'function_definition' || n.type === 'class_definition');
        return inner ?? node;
    }
    return node;
}

function nameOf(node: Parser.SyntaxNode): string | null {
    const name = node.childForFieldName('name');
    return name ? name.text : null;
}

function buildQName(name: string, parentQ: string | null): string {
    return parentQ ? `${parentQ}.${name}` : name;
}

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
    const out: ParsedImport[] = [];
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const child = rootNode.namedChild(i);
        if (!child) continue;

        if (child.type === 'import_statement') {
            // import X, Y as Z
            const names: string[] = [];
            let moduleSpec = '';
            walkSubtree(child, (n) => {
                if (n.type === 'dotted_name' && n.parent?.type !== 'aliased_import') {
                    if (!moduleSpec) moduleSpec = n.text;
                    names.push(n.text);
                }
            });
            out.push({
                moduleSpecifier: moduleSpec || names[0] || '',
                names: names.length > 0 ? Array.from(new Set(names)) : [],
                byteRange: byteRangeFromNode(child),
            });
        } else if (child.type === 'import_from_statement') {
            // from X import a, b
            const moduleNode = child.childForFieldName('module_name');
            const moduleSpec = moduleNode ? moduleNode.text : '';
            const names: string[] = [];
            for (let j = 0; j < child.namedChildCount; j++) {
                const sub = child.namedChild(j);
                if (!sub) continue;
                if (sub === moduleNode) continue;
                if (sub.type === 'dotted_name' || sub.type === 'identifier') {
                    names.push(sub.text);
                } else if (sub.type === 'wildcard_import') {
                    names.push('*');
                } else if (sub.type === 'aliased_import') {
                    const inner = sub.namedChildren.find((n: Parser.SyntaxNode) =>
                        n.type === 'dotted_name' || n.type === 'identifier');
                    if (inner) names.push(inner.text);
                }
            }
            out.push({
                moduleSpecifier: moduleSpec,
                names: Array.from(new Set(names)),
                byteRange: byteRangeFromNode(child),
            });
        }
    }
    return out;
}

function isModuleConstant(name: string): boolean {
    return /^[A-Z_][A-Z0-9_]*$/.test(name);
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
        let child = body.namedChild(i);
        if (!child) continue;

        // Unwrap decorators.
        if (child.type === 'decorated_definition') {
            child = unwrapDecorated(child);
        }

        if (child.type === 'function_definition' || child.type === 'class_definition') {
            const name = nameOf(child);
            if (!name) continue;
            const kind: SymbolKind = child.type === 'function_definition'
                ? (parentKind === 'class' ? 'method' : 'function')
                : 'class';
            const qname = buildQName(name, parentQ);
            const sym = makeParsedSymbol({
                name,
                qualifiedName: qname,
                kind,
                file,
                byteRange: byteRangeFromNode(child),
                signature: buildSignature(sourceUtf8, child),
                complexity: cyclomaticComplexity(child, PY_DECISION_TYPES),
                parentSymbolId,
            });
            out.push(sym);

            const innerBody = child.childForFieldName('body');
            if (innerBody) {
                extractInBody(innerBody, sourceUtf8, file, sym.id, qname, kind, out);
            }
        } else if (child.type === 'expression_statement' && parentKind === null) {
            // Module-level assignment: capture UPPER_SNAKE constants.
            const inner = child.namedChild(0);
            if (inner && inner.type === 'assignment') {
                const target = inner.childForFieldName('left');
                if (target && target.type === 'identifier' && isModuleConstant(target.text)) {
                    const name = target.text;
                    out.push(makeParsedSymbol({
                        name,
                        qualifiedName: buildQName(name, parentQ),
                        kind: 'constant',
                        file,
                        byteRange: byteRangeFromNode(inner),
                        signature: buildSignature(sourceUtf8, inner),
                        complexity: 1,
                        parentSymbolId,
                    }));
                }
            }
        }
    }
}

const PY_CALL_NODE_TYPES: ReadonlySet<string> = new Set(['call']);

function extractPyCallee(node: Parser.SyntaxNode): { name: string; isMethod: boolean; receiver: string | null } | null {
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return { name: fn.text, isMethod: false, receiver: null };
    if (fn.type === 'attribute') {
        const obj = fn.childForFieldName('object');
        const attr = fn.childForFieldName('attribute');
        if (attr) return { name: attr.text, isMethod: true, receiver: obj?.text ?? null };
    }
    return null;
}

export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    extractInBody(rootNode, sourceUtf8, file, null, null, null, symbols);
    const imports = extractImports(rootNode);

    const calls: import('../types.js').ParsedCall[] = [];
    walkSubtree(rootNode, (node) => {
        if (node.type !== 'function_definition') return;
        const body = node.childForFieldName('body');
        if (!body) return;
        const owner = symbols.find((s) =>
            s.byteRange.start <= node.startIndex && s.byteRange.end >= node.endIndex
            && (s.kind === 'function' || s.kind === 'method'));
        if (!owner) return;
        calls.push(...extractCallsInBody(body, owner.id, PY_CALL_NODE_TYPES, extractPyCallee));
    });

    return { symbols, imports, calls };
};

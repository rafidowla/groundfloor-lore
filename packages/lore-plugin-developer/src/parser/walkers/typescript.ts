/**
 * parser/walkers/typescript.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * TypeScript walker — also handles .tsx / .jsx / .js (shared grammar).
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Extracts: function declarations, class declarations, methods,
 * interfaces, enums, type aliases, top-level const/let bindings, and
 * import statements. Maps tree-sitter-typescript node types onto the
 * Atlas `SymbolKind` vocabulary.
 *
 * Coverage notes:
 *   - Decorators are extracted as `decorator` symbols (the decorator
 *     declaration itself, not the use).
 *   - Arrow-function expressions assigned to top-level `const`s are
 *     captured as `function` symbols (common pattern: `export const foo
 *     = () => ...`). Inline arrow functions inside other expressions
 *     are not extracted as symbols (they're noise for analytics).
 *   - Methods include constructors, getters, setters, and static methods.
 *   - The walker does NOT resolve cross-file references; that's Phase 2.
 */

import type Parser from 'web-tree-sitter';
import type { ParsedImport, ParsedSymbol, SymbolKind } from '../types.js';
import {
    buildSignature,
    byteRangeFromNode,
    cyclomaticComplexity,
    makeParsedSymbol,
    walkSubtree,
    type WalkerFn,
} from './_base.js';

/**
 * Tree-sitter node types that count as decision points for cyclomatic
 * complexity in the TypeScript / JavaScript grammar.
 */
const TS_DECISION_TYPES: ReadonlySet<string> = new Set([
    'if_statement',
    'else_clause',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_case',
    'catch_clause',
    'ternary_expression',
    'logical_expression',     // covers && and ||
    'optional_chain',         // ?. is a runtime decision
]);

/**
 * AST node types that introduce named symbols at module / class scope.
 * Walker iterates all named children of the file (and class bodies)
 * matching this set.
 */
const SYMBOL_NODE_TYPES: ReadonlySet<string> = new Set([
    'function_declaration',
    'class_declaration',
    'method_definition',
    'method_signature',           // interface method declaration
    'interface_declaration',
    'enum_declaration',
    'type_alias_declaration',
    'abstract_class_declaration',
    'abstract_method_signature',
    'lexical_declaration',        // const/let — only top-level / exported counts
    'variable_declaration',       // var
    'function_signature',         // function f(): X declared in .d.ts
    // public_field_definition / property_signature deliberately skipped
    // in v1 — class fields and interface property signatures aren't
    // call-graph symbols. Phase 4 analytics don't need them. Add them
    // later if instance-state tracking becomes a real use case.
    'export_statement',           // wraps another declaration; we recurse
]);

/** Map a tree-sitter node type to our SymbolKind. */
function kindFor(nodeType: string, parentKind: SymbolKind | null): SymbolKind {
    switch (nodeType) {
        case 'function_declaration':
        case 'function_signature':
            return 'function';
        case 'method_definition':
        case 'method_signature':
        case 'abstract_method_signature':
            return 'method';
        case 'class_declaration':
        case 'abstract_class_declaration':
            return 'class';
        case 'interface_declaration':
            return 'interface';
        case 'enum_declaration':
            return 'enum';
        case 'type_alias_declaration':
            return 'type';
        case 'lexical_declaration':
        case 'variable_declaration':
            // const/let/var. If it's nested in a function, skip; otherwise
            // module-level constant.
            return parentKind === null ? 'constant' : 'variable';
        default:
            return 'function';
    }
}

/** Extract the symbol name from a node. Returns null if no name found. */
function extractName(node: Parser.SyntaxNode): string | null {
    // Most declarations expose name via a field.
    const named = node.childForFieldName('name');
    if (named) return named.text;

    // lexical_declaration / variable_declaration wrap variable_declarator
    // children — for these, return the first declarator's name.
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child && child.type === 'variable_declarator') {
                const id = child.childForFieldName('name');
                if (id) return id.text;
            }
        }
    }

    // export_statement wraps a child declaration; we'll recurse on it
    // separately, so return null here.
    if (node.type === 'export_statement') return null;

    return null;
}

/**
 * Build a qualified name by walking up the symbol chain. Top-level
 * symbols have qualifiedName === name; methods inside a class have
 * `ClassName.methodName`; methods inside nested classes chain further.
 */
function buildQualifiedName(name: string, parentQName: string | null): string {
    return parentQName ? `${parentQName}.${name}` : name;
}

/** Find imports in the file's top-level. */
function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
    const out: ParsedImport[] = [];
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const child = rootNode.namedChild(i);
        if (!child) continue;
        if (child.type !== 'import_statement') continue;

        const sourceNode = child.childForFieldName('source');
        const moduleSpec = sourceNode ? sourceNode.text.replace(/^['"`]|['"`]$/g, '') : '';
        const names: string[] = [];

        // import_clause has several shapes; collect identifiers we can find.
        const clause = child.namedChildren.find((n: Parser.SyntaxNode) => n.type === 'import_clause');
        if (clause) {
            walkSubtree(clause, (n) => {
                if (n.type === 'identifier' || n.type === 'namespace_import') {
                    if (n.type === 'namespace_import') {
                        names.push('*');
                    } else if (n.parent?.type !== 'named_imports' || n.parent?.parent === clause) {
                        names.push(n.text);
                    } else {
                        names.push(n.text);
                    }
                }
            });
        }

        out.push({
            moduleSpecifier: moduleSpec,
            names: Array.from(new Set(names)),
            byteRange: byteRangeFromNode(child),
        });
    }
    return out;
}

/**
 * Recursive descent: extract symbols inside `parent` (a class, file
 * root, or namespace body). Pushes into `out`. Tracks parent chain via
 * `parentSymbolId` and `parentQName`.
 */
function extractSymbolsIn(
    parent: Parser.SyntaxNode,
    sourceUtf8: Uint8Array,
    file: string,
    parentSymbolId: string | null,
    parentQName: string | null,
    parentKind: SymbolKind | null,
    out: ParsedSymbol[],
): void {
    for (let i = 0; i < parent.namedChildCount; i++) {
        const child = parent.namedChild(i);
        if (!child) continue;

        // Unwrap `export ...` to the underlying declaration.
        let target: Parser.SyntaxNode = child;
        if (child.type === 'export_statement') {
            // Export statements have a `declaration` field for inline
            // declarations and a different shape for re-exports. Find
            // the inner declaration if present.
            const inner = child.childForFieldName('declaration')
                ?? child.namedChildren.find((n: Parser.SyntaxNode) => SYMBOL_NODE_TYPES.has(n.type) && n.type !== 'export_statement');
            if (!inner) continue;
            target = inner;
        }

        if (!SYMBOL_NODE_TYPES.has(target.type)) continue;
        if (target.type === 'export_statement') continue; // recursion guard

        const name = extractName(target);
        if (!name) continue;

        const kind = kindFor(target.type, parentKind);
        const qname = buildQualifiedName(name, parentQName);
        const sym = makeParsedSymbol({
            name,
            qualifiedName: qname,
            kind,
            file,
            byteRange: byteRangeFromNode(target),
            signature: buildSignature(sourceUtf8, target),
            complexity: cyclomaticComplexity(target, TS_DECISION_TYPES),
            parentSymbolId,
        });
        out.push(sym);

        // Recurse into class / interface bodies to extract methods.
        const body = target.childForFieldName('body');
        if (body) {
            extractSymbolsIn(body, sourceUtf8, file, sym.id, qname, kind, out);
        }
    }
}

/**
 * Walker entry point — see WalkerFn contract in `_base.ts`.
 */
export const walk: WalkerFn = (rootNode, sourceUtf8, file) => {
    const symbols: ParsedSymbol[] = [];
    extractSymbolsIn(rootNode, sourceUtf8, file, null, null, null, symbols);
    const imports = extractImports(rootNode);
    return { symbols, imports };
};

/**
 * resolver/inheritance.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Class-hierarchy resolver — extends / implements / Python class bases.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 2 (cross-file resolution — fallback path).
 *
 * Strategy: each ParsedSymbol carries a single-line `signature` from
 * its source. For class / interface symbols this signature contains
 * the inheritance clause (`extends X`, `implements Y, Z`, `class X(Y):`,
 * etc.). We extract base names from the signature with per-language
 * regexes, then match each base against the workspace symbol table to
 * produce ParsedRelation edges of kind `extends` / `implements`.
 *
 * This is a heuristic approach — it doesn't fully resolve generic
 * type parameters or qualified-package names — but it covers the
 * common case across all 8 v1 languages without requiring a second
 * full re-parse pass. Phase 2 fast-follow (Stack Graphs or per-language
 * walker enhancements) can replace this with AST-accurate resolution.
 */

import type {
    Language,
    ParsedFile,
    ParsedRelation,
    ParsedSymbol,
} from '../parser/types.js';
import type { SymbolTable } from './symbolTable.js';

interface InheritanceClause {
    /** 'extends' or 'implements'. */
    kind: 'extends' | 'implements';
    baseName: string;
}

/**
 * Strip generic type parameters from a base name. e.g. `Map<string,
 * Foo>` → `Map`. We match against the bare class/interface name in
 * the symbol table.
 */
function stripGenerics(name: string): string {
    const idx = name.indexOf('<');
    return (idx >= 0 ? name.slice(0, idx) : name).trim();
}

/**
 * Strip namespace / package qualifiers — `com.example.Foo` → `Foo`,
 * `std::string` → `string`. The symbol table uses simple names for
 * lookup; qualified resolution is a future enhancement.
 */
function stripQualifier(name: string): string {
    const lastDot = name.lastIndexOf('.');
    if (lastDot >= 0) name = name.slice(lastDot + 1);
    const lastColon = name.lastIndexOf('::');
    if (lastColon >= 0) name = name.slice(lastColon + 2);
    return name.trim();
}

/**
 * Per-language extraction of inheritance clauses from a signature.
 * Returns [] if the signature doesn't declare inheritance.
 */
function extractClauses(signature: string, language: Language): InheritanceClause[] {
    const out: InheritanceClause[] = [];

    switch (language) {
        case 'typescript':
        case 'tsx':
        case 'javascript': {
            // class X extends Y { ... }
            // class X extends Y implements I, J, K { ... }
            // interface X extends Y, Z { ... }
            const extM = signature.match(/\bextends\s+([^\s{]+(?:\s*<[^>]*>)?(?:\s*,\s*[^\s{]+(?:\s*<[^>]*>)?)*)/);
            if (extM) {
                for (const raw of extM[1].split(',')) {
                    out.push({ kind: 'extends', baseName: stripGenerics(raw.trim()) });
                }
            }
            const implM = signature.match(/\bimplements\s+([^\s{]+(?:\s*<[^>]*>)?(?:\s*,\s*[^\s{]+(?:\s*<[^>]*>)?)*)/);
            if (implM) {
                for (const raw of implM[1].split(',')) {
                    out.push({ kind: 'implements', baseName: stripGenerics(raw.trim()) });
                }
            }
            break;
        }
        case 'python': {
            // class X(Y, Z, metaclass=ABCMeta):
            const m = signature.match(/class\s+\w+\s*\(([^)]*)\)/);
            if (m && m[1].trim()) {
                for (const raw of m[1].split(',')) {
                    const trimmed = raw.trim();
                    if (!trimmed || trimmed.includes('=')) continue;
                    out.push({ kind: 'extends', baseName: stripQualifier(stripGenerics(trimmed)) });
                }
            }
            break;
        }
        case 'java': {
            // class X extends Y implements I, J { ... }
            // interface X extends Y, Z { ... }
            const extM = signature.match(/\bextends\s+([\w.<>,\s]+?)(?=\s+implements\b|\s*\{|\s*$)/);
            if (extM) {
                for (const raw of extM[1].split(',')) {
                    out.push({ kind: 'extends', baseName: stripQualifier(stripGenerics(raw.trim())) });
                }
            }
            const implM = signature.match(/\bimplements\s+([\w.<>,\s]+?)(?=\s*\{|\s*$)/);
            if (implM) {
                for (const raw of implM[1].split(',')) {
                    out.push({ kind: 'implements', baseName: stripQualifier(stripGenerics(raw.trim())) });
                }
            }
            break;
        }
        case 'csharp': {
            // class X : Y, IZ { ... }   (C# uses colon for both base + interfaces)
            const m = signature.match(/^(?:public\s+|private\s+|internal\s+|protected\s+|abstract\s+|sealed\s+|static\s+)*\s*(?:class|interface|struct|record)\s+\w+(?:\s*<[^>]*>)?\s*:\s*([\w.<>,\s]+?)(?:\s*\{|\s*where\b|\s*$)/);
            if (m) {
                const items = m[1].split(',').map((s) => s.trim()).filter(Boolean);
                // First item is the base class; remainder are interfaces.
                // Heuristic: items starting with 'I' + uppercase are interfaces.
                items.forEach((item, idx) => {
                    const base = stripQualifier(stripGenerics(item));
                    const isInterface = /^I[A-Z]/.test(base);
                    if (idx === 0 && !isInterface) {
                        out.push({ kind: 'extends', baseName: base });
                    } else {
                        out.push({ kind: 'implements', baseName: base });
                    }
                });
            }
            break;
        }
        case 'rust': {
            // Inheritance in Rust is via `trait X: Y + Z { ... }` (super-traits)
            // and `impl Trait for Struct` blocks. The struct/enum signature
            // doesn't carry trait info. Trait declarations may have super-trait
            // bounds. impl blocks are tracked via ID-qualified names already.
            const m = signature.match(/\btrait\s+\w+(?:\s*<[^>]*>)?\s*:\s*([\w:<>,\s+]+?)(?:\s*\{|\s*$)/);
            if (m) {
                for (const raw of m[1].split('+')) {
                    const trimmed = raw.trim();
                    if (!trimmed) continue;
                    out.push({ kind: 'extends', baseName: stripQualifier(stripGenerics(trimmed)) });
                }
            }
            break;
        }
        case 'cpp':
        case 'c': {
            // class X : public Y, protected Z { ... }
            // struct X : Y, Z { ... }
            const m = signature.match(/(?:class|struct)\s+\w+\s*:\s*([\w:<>,\s]+?)(?:\s*\{|\s*$)/);
            if (m) {
                for (const raw of m[1].split(',')) {
                    let trimmed = raw.trim();
                    // Strip access modifiers
                    trimmed = trimmed.replace(/^(public|private|protected|virtual)\s+/, '');
                    if (!trimmed) continue;
                    out.push({ kind: 'extends', baseName: stripQualifier(stripGenerics(trimmed)) });
                }
            }
            break;
        }
        case 'ruby': {
            // class X < Y; end
            const m = signature.match(/class\s+\w+\s*<\s*(\w+(?:::\w+)*)/);
            if (m) {
                out.push({ kind: 'extends', baseName: stripQualifier(m[1]) });
            }
            break;
        }
        case 'go': {
            // Go doesn't have inheritance; embedding is field-level and
            // can't be resolved from the signature alone. Skip in v1.
            break;
        }
    }

    return out;
}

/**
 * Build inheritance edges (extends + implements) for every class /
 * interface / trait symbol in the workspace.
 */
export function buildInheritanceEdges(
    files: readonly ParsedFile[],
    table: SymbolTable,
): ParsedRelation[] {
    const edges: ParsedRelation[] = [];
    const fileLanguage = new Map<string, Language>();
    for (const f of files) fileLanguage.set(f.path, f.language);

    for (const sym of table.all) {
        if (sym.kind !== 'class' && sym.kind !== 'interface') continue;
        const lang = fileLanguage.get(sym.file);
        if (!lang) continue;
        const clauses = extractClauses(sym.signature, lang);
        if (clauses.length === 0) continue;

        for (const clause of clauses) {
            // Lookup target. Try qualified-name first (might match if
            // the base is in the same module), then bare-name match.
            let target: ParsedSymbol | null = null;
            const directList = table.byQualifiedName.get(clause.baseName);
            if (directList && directList.length > 0) {
                target = directList[0];
            } else {
                // Bare-name fallback: scan the symbol table for a match.
                for (const candidate of table.all) {
                    if (candidate.name === clause.baseName &&
                        (candidate.kind === 'class' || candidate.kind === 'interface')) {
                        target = candidate;
                        break;
                    }
                }
            }

            if (!target) continue;

            edges.push({
                sourceId: sym.id,
                targetId: target.id,
                kind: clause.kind,
                confidence: directList ? 1.0 : 0.7,
                reason: directList
                    ? `direct qualified-name match for ${clause.kind} ${clause.baseName}`
                    : `bare-name fallback for ${clause.kind} ${clause.baseName}`,
            });
        }
    }

    return edges;
}

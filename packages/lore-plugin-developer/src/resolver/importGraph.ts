/**
 * resolver/importGraph.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Import-graph fallback — relative imports + workspace aliases.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 2 (cross-file resolution — fallback path).
 *
 * Resolves each ParsedImport's `moduleSpecifier` to a repo-relative
 * file path when possible. Builds a map from (importingFile,
 * importedName) → [resolvedFilePath, ...] suitable for the call graph
 * resolver to look up "where does this import point?"
 *
 * Resolution strategies (per language family):
 *   - TypeScript / JavaScript: relative paths, tsconfig "paths" aliases,
 *     index.ts / .ts / .tsx / .js extension search.
 *   - Python: dotted modules with relative ('.' / '..') prefix support.
 *   - Other languages: direct file-path matching only (Go module paths,
 *     Rust crate paths, Java packages — these need package-manager
 *     awareness which is deferred to a per-language enhancement).
 *
 * Returns ParsedRelation edges of kind `imports` for every successfully
 * resolved import. Unresolved imports are logged in the diagnostics
 * stream so callers can surface them.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
    Language,
    ParsedFile,
    ParsedImport,
    ParsedRelation,
} from '../parser/types.js';
import type { SymbolTable } from './symbolTable.js';

/**
 * Resolution context: per-repo metadata that drives import resolution.
 * Built once per parseRepo call and reused across all files.
 */
export interface ResolutionContext {
    repoRoot: string;
    /** Map: alias prefix → [target-prefix, ...] from tsconfig.json `paths`. */
    tsAliases: Map<string, string[]>;
    /** Set of repo-relative file paths that exist. Used for extension search. */
    repoFileSet: Set<string>;
}

/**
 * Build a resolution context from the parsed file list + filesystem.
 * Reads tsconfig.json `paths` if present.
 */
export async function buildResolutionContext(
    repoRoot: string,
    parsedFiles: readonly ParsedFile[],
): Promise<ResolutionContext> {
    const tsAliases = new Map<string, string[]>();
    try {
        const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
        const raw = await fs.readFile(tsconfigPath, 'utf-8');
        // tsconfig is a JSON file but often contains comments; strip them.
        const cleaned = raw.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
        const cfg = JSON.parse(cleaned);
        const paths = cfg?.compilerOptions?.paths;
        const baseUrl = cfg?.compilerOptions?.baseUrl ?? '.';
        if (paths && typeof paths === 'object') {
            for (const [key, valueRaw] of Object.entries(paths)) {
                const values = Array.isArray(valueRaw) ? valueRaw as string[] : [String(valueRaw)];
                // Strip the trailing /* if any.
                const aliasPrefix = key.replace(/\*$/, '').replace(/\/$/, '');
                const targets = values.map((v) => {
                    const stripped = v.replace(/\*$/, '').replace(/\/$/, '');
                    return path.posix.normalize(path.posix.join(baseUrl, stripped));
                });
                tsAliases.set(aliasPrefix, targets);
            }
        }
    } catch {
        // tsconfig absent or unreadable — fine, just no aliases.
    }

    const repoFileSet = new Set<string>(parsedFiles.map((f) => f.path));
    return { repoRoot, tsAliases, repoFileSet };
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];
const PY_EXTENSIONS = ['.py', '.pyi'];

/**
 * Try to resolve a moduleSpecifier from a TypeScript / JavaScript file
 * to a repo-relative file path. Returns null if no match found.
 */
function resolveTypeScriptImport(
    fromFile: string,
    moduleSpecifier: string,
    ctx: ResolutionContext,
): string | null {
    // ESM convention: TS source imports use `.js` / `.jsx` / `.mjs`
    // suffixes even though the on-disk file is `.ts` / `.tsx` / `.mts`.
    // Strip the JS-side suffix so findFileWithExtensions can re-attach
    // the right TS extension and find the actual file.
    const stripped = moduleSpecifier.replace(/\.(jsx?|mjs|cjs)$/, '');

    // 1. Relative imports
    if (stripped.startsWith('./') || stripped.startsWith('../')) {
        const dir = path.posix.dirname(fromFile);
        const joined = path.posix.normalize(path.posix.join(dir, stripped));
        return findFileWithExtensions(joined, TS_EXTENSIONS, ctx);
    }

    // 2. tsconfig paths aliases
    for (const [aliasPrefix, targets] of ctx.tsAliases) {
        if (!aliasPrefix) continue;
        if (stripped === aliasPrefix || stripped.startsWith(aliasPrefix + '/')) {
            const remainder = stripped.slice(aliasPrefix.length).replace(/^\//, '');
            for (const target of targets) {
                const candidate = remainder ? path.posix.join(target, remainder) : target;
                const resolved = findFileWithExtensions(candidate, TS_EXTENSIONS, ctx);
                if (resolved) return resolved;
            }
        }
    }

    // 3. Bare specifier — likely a node_modules package; not part of repo graph.
    return null;
}

/**
 * Try to resolve a Python import. Handles relative imports (leading
 * dots) and dotted absolute imports against the repo file tree.
 */
function resolvePythonImport(
    fromFile: string,
    moduleSpecifier: string,
    ctx: ResolutionContext,
): string | null {
    if (!moduleSpecifier) return null;

    if (moduleSpecifier.startsWith('.')) {
        // Relative: count leading dots → that many levels up.
        let level = 0;
        while (moduleSpecifier[level] === '.') level += 1;
        const remainder = moduleSpecifier.slice(level).replace(/\./g, '/');
        let dir = path.posix.dirname(fromFile);
        for (let i = 1; i < level; i++) dir = path.posix.dirname(dir);
        const joined = remainder ? path.posix.join(dir, remainder) : dir;
        return findFileWithExtensions(joined, PY_EXTENSIONS, ctx)
            ?? findFileWithExtensions(path.posix.join(joined, '__init__'), PY_EXTENSIONS, ctx);
    }

    // Absolute dotted: foo.bar.baz → foo/bar/baz.py or foo/bar/baz/__init__.py
    const asPath = moduleSpecifier.replace(/\./g, '/');
    return findFileWithExtensions(asPath, PY_EXTENSIONS, ctx)
        ?? findFileWithExtensions(path.posix.join(asPath, '__init__'), PY_EXTENSIONS, ctx);
}

/**
 * Find a file in the repo with one of the given extensions appended.
 * Also tries `<base>/index.<ext>` as a last resort (Node-style index lookup).
 */
function findFileWithExtensions(
    base: string,
    extensions: readonly string[],
    ctx: ResolutionContext,
): string | null {
    // Direct hit (specifier already has extension or is exact).
    if (ctx.repoFileSet.has(base)) return base;

    for (const ext of extensions) {
        const withExt = base + ext;
        if (ctx.repoFileSet.has(withExt)) return withExt;
    }

    // index lookup
    for (const ext of extensions) {
        const indexPath = path.posix.join(base, 'index' + ext);
        if (ctx.repoFileSet.has(indexPath)) return indexPath;
    }

    return null;
}

/**
 * Resolve a single import to a file path, dispatching by language.
 */
export function resolveImport(
    fromFile: string,
    fromLanguage: Language,
    importSpec: ParsedImport,
    ctx: ResolutionContext,
): string | null {
    switch (fromLanguage) {
        case 'typescript':
        case 'tsx':
        case 'javascript':
            return resolveTypeScriptImport(fromFile, importSpec.moduleSpecifier, ctx);
        case 'python':
            return resolvePythonImport(fromFile, importSpec.moduleSpecifier, ctx);
        // Go / Rust / Java / C# / C / C++ / Ruby: resolution requires
        // package-manager awareness (go.mod, Cargo.toml, mvn pom, etc.)
        // which we don't yet model. v1 leaves these unresolved; a
        // per-language fast-follow can extend this dispatch.
        default:
            return null;
    }
}

/**
 * Resolve every import in every file, producing ParsedRelation edges
 * of kind `imports`. The edges target the FIRST symbol matched in the
 * destination file (or no edge if the file has no symbols matching the
 * imported names).
 */
export function buildImportEdges(
    files: readonly ParsedFile[],
    table: SymbolTable,
    ctx: ResolutionContext,
): { edges: ParsedRelation[]; resolved: number; unresolved: number } {
    const edges: ParsedRelation[] = [];
    let resolved = 0;
    let unresolved = 0;

    for (const file of files) {
        for (const imp of file.imports) {
            const targetFile = resolveImport(file.path, file.language, imp, ctx);
            if (!targetFile) {
                unresolved += 1;
                continue;
            }
            resolved += 1;

            const fileMap = table.byFile.get(targetFile);
            if (!fileMap) continue;

            // For each imported name, find the matching symbol in the
            // target file and emit an edge from the importing file's
            // first symbol (or a synthetic file-level marker) to the
            // imported symbol. Source side of the edge is the file
            // path; storage layer maps that to a CodeFile node.
            const namesToFind = imp.names.length > 0 ? imp.names : ['*'];
            for (const importedName of namesToFind) {
                if (importedName === '*') {
                    // Wildcard: emit one edge per public symbol in the target file.
                    for (const [, symbols] of fileMap) {
                        for (const sym of symbols) {
                            edges.push({
                                sourceId: `file:${file.path}`,
                                targetId: sym.id,
                                kind: 'imports',
                                confidence: 0.85,
                                reason: `wildcard import from '${imp.moduleSpecifier}'`,
                            });
                        }
                    }
                } else {
                    const matches = fileMap.get(importedName);
                    if (matches && matches.length > 0) {
                        for (const sym of matches) {
                            edges.push({
                                sourceId: `file:${file.path}`,
                                targetId: sym.id,
                                kind: 'imports',
                                confidence: 1.0,
                                reason: `import { ${importedName} } from '${imp.moduleSpecifier}'`,
                            });
                        }
                    }
                }
            }
        }
    }

    return { edges, resolved, unresolved };
}

/**
 * parser/grammars.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Per-language WASM grammar registration + singleton loader.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Wraps web-tree-sitter's Parser.init() and Parser.Language.load() with
 * caching so each grammar's WASM file is read from disk and parsed once
 * per process lifetime. Grammars live as vendored .wasm blobs under
 * `packages/lore-plugin-developer/grammars/` (see grammars/README.md
 * for provenance + Unlicense compatibility note).
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import Parser from 'web-tree-sitter';
import type { Language } from './types.js';

/** Map a logical Language to its vendored WASM filename. */
const GRAMMAR_FILES: Record<Language, string> = {
    typescript: 'tree-sitter-typescript.wasm',
    tsx: 'tree-sitter-tsx.wasm',
    javascript: 'tree-sitter-javascript.wasm',
    python: 'tree-sitter-python.wasm',
    go: 'tree-sitter-go.wasm',
    rust: 'tree-sitter-rust.wasm',
    java: 'tree-sitter-java.wasm',
    csharp: 'tree-sitter-c_sharp.wasm',
    c: 'tree-sitter-c.wasm',
    cpp: 'tree-sitter-cpp.wasm',
    ruby: 'tree-sitter-ruby.wasm',
};

/** Map of file extensions (no dot, lowercase) to their Language. */
const EXTENSION_MAP: Record<string, Language> = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    py: 'python',
    pyi: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cs: 'csharp',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hxx: 'cpp',
    hh: 'cpp',
    rb: 'ruby',
};

/**
 * Detect the language of a file by extension. Returns null for files we
 * don't have a walker for — caller treats those as skipped.
 */
export function getLanguageFor(filePath: string): Language | null {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return EXTENSION_MAP[ext] ?? null;
}

/**
 * Resolve the absolute filesystem path to a vendored grammar WASM blob.
 * Uses import.meta.url so it works from both source (tsx) and dist
 * (post-tsc-alias) without per-environment configuration.
 */
function grammarPath(language: Language): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/parser/grammars.ts → ../../grammars/<file>
    // dist/lore-plugin-developer/src/parser/grammars.js → ../../../../packages/lore-plugin-developer/grammars/<file>
    // We resolve via the package root (parent of `src`), which works in both layouts.
    let dir = here;
    while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, 'packages', 'lore-plugin-developer', 'grammars');
        // Cheap existence check via path traversal; the actual file
        // existence check happens when web-tree-sitter tries to read it.
        if (path.basename(dir) === 'groundfloor-lore' || path.basename(path.dirname(dir)) === 'groundfloor-lore') {
            return path.join(candidate, GRAMMAR_FILES[language]);
        }
        // Walk up looking for a `grammars` directory we can match.
        const localGrammars = path.join(dir, '..', 'grammars', GRAMMAR_FILES[language]);
        const fromPlugin = path.join(dir, '..', '..', 'grammars', GRAMMAR_FILES[language]);
        if (path.basename(path.dirname(dir)) === 'lore-plugin-developer') {
            return localGrammars;
        }
        if (path.basename(path.dirname(path.dirname(dir))) === 'lore-plugin-developer') {
            return fromPlugin;
        }
        dir = path.dirname(dir);
    }
    // Last-resort default: relative to the file's grandparent grandparent.
    return path.join(here, '..', '..', 'grammars', GRAMMAR_FILES[language]);
}

/** Init runtime once per process. */
let parserInitPromise: Promise<void> | null = null;

/** Loaded Language objects, keyed by Language. */
const loadedLanguages = new Map<Language, Parser.Language>();

/**
 * Lazily initialize web-tree-sitter and load + cache the requested
 * grammar. Subsequent calls return the cached Language object.
 */
export async function loadGrammar(language: Language): Promise<Parser.Language> {
    if (!parserInitPromise) {
        parserInitPromise = Parser.init();
    }
    await parserInitPromise;

    const cached = loadedLanguages.get(language);
    if (cached) return cached;

    const wasmPath = grammarPath(language);
    const lang = await Parser.Language.load(wasmPath);
    loadedLanguages.set(language, lang);
    return lang;
}

/**
 * Acquire a Parser configured for the given language. Each call returns
 * a fresh Parser (web-tree-sitter parsers aren't thread-safe; treating
 * them as per-call resources is the simplest model).
 */
export async function getParser(language: Language): Promise<Parser> {
    const lang = await loadGrammar(language);
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
}

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
    // Layouts:
    //   src layout (tsx):  <root>/packages/lore-plugin-developer/src/parser/grammars.ts
    //                      grammars at <root>/packages/lore-plugin-developer/grammars/
    //   dist layout:       <root>/dist/lore-plugin-developer/src/parser/grammars.js
    //                      grammars STILL at <root>/packages/lore-plugin-developer/grammars/
    //                      (build does NOT copy WASM into dist — they're vendored
    //                       in source; we resolve absolute every time).
    //
    // Strategy: walk up looking for the project root (a dir whose name
    // is `groundfloor-lore`, OR a dir containing both `packages/` and
    // either `dist/` or `node_modules/`). From there, join
    // `packages/lore-plugin-developer/grammars/<file>`.
    let dir = here;
    while (dir !== path.dirname(dir)) {
        // Direct match: this dir IS the project root.
        if (path.basename(dir) === 'groundfloor-lore') {
            return path.join(dir, 'packages', 'lore-plugin-developer', 'grammars', GRAMMAR_FILES[language]);
        }
        dir = path.dirname(dir);
    }
    // Fallback: relative resolution from src layout (tsx run from a
    // worktree where the project-root name differs).
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

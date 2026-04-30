/**
 * parser/index.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Public API: parseFile, parseRepo, getLanguageFor.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 1 (parser foundation).
 *
 * Three callable surfaces:
 *
 *   - getLanguageFor(filePath): Language | null
 *       Pure synchronous lookup by extension.
 *
 *   - parseFile(absPath, repoRoot?): Promise<ParsedFile>
 *       Read + parse one file; dispatch to the correct walker.
 *
 *   - parseRepo(repoRoot): Promise<ParseRepoResult>
 *       Enumerate via `git ls-files`, parse each, aggregate.
 *
 * Walker registry is intentionally permissive in v1: languages with a
 * registered walker get full extraction; languages without one (the 7
 * other v1 languages until their walkers land) are skipped with a
 * diagnostic. This keeps `parseRepo` useful as walkers are added
 * incrementally.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
    Language,
    ParsedFile,
    ParseDiagnostic,
    ParseRepoResult,
} from './types.js';
import { getLanguageFor as detectLanguage, getParser } from './grammars.js';
import { countLoc, type WalkerFn } from './walkers/_base.js';
import { walk as walkTypeScript } from './walkers/typescript.js';
import { walk as walkPython } from './walkers/python.js';
import { walk as walkGo } from './walkers/go.js';
import { walk as walkRust } from './walkers/rust.js';
import { walk as walkJava } from './walkers/java.js';
import { walk as walkCSharp } from './walkers/csharp.js';
import { walk as walkCpp } from './walkers/cpp.js';
import { walk as walkRuby } from './walkers/ruby.js';

/** Re-export so callers don't need to know the grammar module. */
export { detectLanguage as getLanguageFor };
export * from './types.js';

/**
 * Walker registry. All 8 v1 languages mapped (TS+TSX+JS share one
 * walker; C+CPP share one walker).
 */
const WALKERS: Partial<Record<Language, WalkerFn>> = {
    typescript: walkTypeScript,
    tsx: walkTypeScript,
    javascript: walkTypeScript,
    python: walkPython,
    go: walkGo,
    rust: walkRust,
    java: walkJava,
    csharp: walkCSharp,
    c: walkCpp,
    cpp: walkCpp,
    ruby: walkRuby,
};

/** Cap on per-file size we'll attempt to parse (bytes). Prevents OOM on weird repos. */
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Parse one file. The path may be absolute or repo-relative; if
 * `repoRoot` is provided, we record paths as repo-relative on the
 * ParsedFile so analytics in later phases can use them as stable
 * keys.
 */
export async function parseFile(
    filePath: string,
    repoRoot?: string,
): Promise<ParsedFile | null> {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot ?? process.cwd(), filePath);
    const repoRel = repoRoot
        ? path.relative(repoRoot, absPath).split(path.sep).join('/')
        : absPath;

    const language = detectLanguage(absPath);
    if (!language) return null;

    const buf = await fs.readFile(absPath);
    if (buf.byteLength > MAX_FILE_BYTES) {
        // Caller will record this as skipped via parseRepo's catch path.
        throw new Error(`file too large (${buf.byteLength} bytes > ${MAX_FILE_BYTES})`);
    }

    const sourceUtf8 = new Uint8Array(buf);
    const sourceText = new TextDecoder('utf-8').decode(sourceUtf8);

    const walker = WALKERS[language];
    if (!walker) {
        // Walker not implemented for this language yet. Return a
        // ParsedFile with the file metadata but no symbols, so
        // analytics can still see the file and so the diagnostic
        // surface in parseRepo can flag it.
        return {
            path: repoRel,
            language,
            symbols: [],
            imports: [],
            sizeBytes: buf.byteLength,
            loc: countLoc(sourceText),
            parsedAt: new Date().toISOString(),
        };
    }

    const parser = await getParser(language);
    try {
        const tree = parser.parse(sourceText);
        if (!tree) {
            throw new Error('tree-sitter returned no tree');
        }
        const { symbols, imports } = walker(tree.rootNode, sourceUtf8, repoRel);
        tree.delete();
        return {
            path: repoRel,
            language,
            symbols,
            imports,
            sizeBytes: buf.byteLength,
            loc: countLoc(sourceText),
            parsedAt: new Date().toISOString(),
        };
    } finally {
        parser.delete();
    }
}

/**
 * Enumerate files in `repoRoot` via `git ls-files`. Matches gitnexus's
 * filtering posture (Phase 0 carry-in #4): tracked + new-but-not-ignored
 * files, respecting `.gitignore`. Falls back to a directory walk only
 * when git is unavailable; documented in PHASE_1_OUTPUT.md.
 */
function enumerateFiles(repoRoot: string): string[] {
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`git ls-files failed: ${result.stderr || result.error?.message || 'unknown error'}`);
    }
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * Parse every supported file under `repoRoot`. Returns aggregate
 * ParseRepoResult. Sequential by default — keeps memory pressure
 * predictable on large repos. A future optimisation could parallelise
 * via a worker pool once we have profiling data; for v1 sequential is
 * fine and simple.
 */
export async function parseRepo(repoRoot: string): Promise<ParseRepoResult> {
    const startedAt = Date.now();
    const repoFiles = enumerateFiles(repoRoot);
    const files: ParsedFile[] = [];
    const diagnostics: ParseDiagnostic[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const relPath of repoFiles) {
        const absPath = path.join(repoRoot, relPath);
        const language = detectLanguage(absPath);
        if (!language) {
            skipped.push({ path: relPath, reason: 'unsupported extension' });
            continue;
        }
        if (!WALKERS[language]) {
            skipped.push({ path: relPath, reason: `walker for ${language} not yet implemented` });
            continue;
        }
        try {
            const parsed = await parseFile(absPath, repoRoot);
            if (parsed) files.push(parsed);
        } catch (err) {
            diagnostics.push({
                file: relPath,
                severity: 'warn',
                message: `parse failed: ${(err as Error).message}`,
            });
        }
    }

    return {
        files,
        diagnostics,
        durationMs: Date.now() - startedAt,
        skipped,
    };
}

/**
 * Convenience helper: parse a single file by absolute path and return
 * just the symbol list. Used by tests + the Phase 5 detect-changes
 * subsystem when only the symbols matter.
 */
export async function parseSymbolsOnly(absPath: string, repoRoot?: string): Promise<ParsedFile['symbols']> {
    const parsed = await parseFile(absPath, repoRoot);
    return parsed?.symbols ?? [];
}

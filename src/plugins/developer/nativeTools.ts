/**
 * nativeTools.ts — Native implementations of detect_changes, rename, and list_repos.
 *
 * Purpose:
 *   Provides native implementations for tools that GitNexus only exposes via
 *   its MCP protocol (no CLI equivalent). These implementations use Lore's
 *   own Kùzu CodeSymbol/CodeRelation tables and git commands directly,
 *   avoiding in-process import of GitNexus internals (which would risk
 *   N-API native addon conflicts between Kùzu and LadybugDB).
 *
 * Architecture:
 *   - detect_changes: `git diff` → match to CodeSymbol by filePath
 *   - rename: Kùzu CodeRelation query → file-level text replacement
 *   - list_repos: reads ~/.gitnexus/registry.json
 *
 * Side Effects: git commands (read-only), file reads, file writes (rename only).
 * Determinism: Non-deterministic (depends on git state, filesystem).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { CodeSymbol } from './types.js';
import type { DeveloperApi } from './api.js';

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * ChangedSymbol — A code symbol affected by uncommitted changes.
 */
export interface ChangedSymbol {
    /** Symbol UID */
    uid: string;
    /** Symbol name */
    name: string;
    /** Symbol kind (Function, Class, etc.) */
    kind: string;
    /** File path containing the change */
    filePath: string;
    /** How the file was changed: 'modified', 'added', 'deleted', 'renamed' */
    changeType: string;
}

/**
 * DetectChangesResult — Result of uncommitted change analysis.
 */
export interface DetectChangesResult {
    /** Changed symbols mapped to code graph */
    changedSymbols: ChangedSymbol[];
    /** Files changed that have no matching symbols (new/untracked files) */
    unmappedFiles: string[];
    /** Total number of files changed */
    totalFilesChanged: number;
}

/**
 * RenameEdit — A single file edit for a rename operation.
 */
export interface RenameEdit {
    /** Absolute file path */
    filePath: string;
    /** Line number (1-indexed) */
    line: number;
    /** Original text */
    original: string;
    /** Replacement text */
    replacement: string;
    /** Confidence: 'graph' (high) or 'text_search' (lower) */
    source: 'graph' | 'text_search';
}

/**
 * RenameResult — Result of a rename operation.
 */
export interface RenameResult {
    /** All proposed edits */
    edits: RenameEdit[];
    /** Whether edits were applied (false = dry_run) */
    applied: boolean;
    /** Number of files affected */
    filesAffected: number;
}

/**
 * RepoInfo — Information about an indexed repository.
 */
export interface RepoInfo {
    /** Repository name */
    name: string;
    /** Absolute path to the repository */
    path: string;
    /** When it was indexed */
    indexedAt: string;
    /** Number of symbols (if available) */
    symbolCount?: number;
}

/* ─── detect_changes ─────────────────────────────────────────── */

/**
 * detectChanges — Analyze uncommitted git changes and map to code symbols.
 *
 * Purpose: Shows developers which symbols in their code graph are affected
 *   by their current uncommitted work. Replaces GitNexus's MCP-only
 *   detect_changes tool using Lore's Kùzu CodeSymbol table.
 *
 * @param api - DeveloperApi for plugin-owned Kùzu queries.
 * @param repoPath - Path to the git repository.
 * @param scope - 'unstaged' (default), 'staged', or 'all'.
 * @returns DetectChangesResult with affected symbols and unmapped files.
 *
 * Side Effects: Executes `git diff` as read-only child process.
 * Determinism: Non-deterministic (depends on git working directory state).
 * Idempotency: Yes — read-only operation.
 */
export async function detectChanges(
    api: DeveloperApi,
    repoPath: string,
    scope: 'unstaged' | 'staged' | 'all' = 'unstaged',
): Promise<DetectChangesResult> {
    // Get changed files from git
    const changedFiles = getGitChangedFiles(repoPath, scope);

    if (changedFiles.length === 0) {
        return { changedSymbols: [], unmappedFiles: [], totalFilesChanged: 0 };
    }

    const changedSymbols: ChangedSymbol[] = [];
    const unmappedFiles: string[] = [];

    for (const change of changedFiles) {
        // Query Kùzu for symbols in this file
        const symbols = await api.queryCodeSymbols(change.filePath);

        if (symbols.length > 0) {
            for (const symbol of symbols) {
                changedSymbols.push({
                    uid: symbol.uid,
                    name: symbol.name,
                    kind: symbol.kind,
                    filePath: change.filePath,
                    changeType: change.type,
                });
            }
        } else {
            unmappedFiles.push(change.filePath);
        }
    }

    return {
        changedSymbols,
        unmappedFiles,
        totalFilesChanged: changedFiles.length,
    };
}

/**
 * getGitChangedFiles — Run git diff to get list of changed files.
 *
 * @param repoPath - Path to git repository.
 * @param scope - Which changes to detect.
 * @returns Array of { filePath, type } for changed files.
 *
 * Side Effects: Executes git command.
 * Error Behavior: Returns empty array if git fails.
 */
function getGitChangedFiles(
    repoPath: string,
    scope: 'unstaged' | 'staged' | 'all',
): Array<{ filePath: string; type: string }> {
    try {
        let diffCmd: string;
        switch (scope) {
            case 'staged':
                diffCmd = 'git diff --cached --name-status';
                break;
            case 'all':
                diffCmd = 'git diff HEAD --name-status';
                break;
            default:
                diffCmd = 'git diff --name-status';
        }

        const output = execSync(diffCmd, {
            cwd: repoPath,
            encoding: 'utf-8',
            timeout: 10000,
        }).trim();

        if (!output) return [];

        return output.split('\n').map((line) => {
            const [statusCode, ...pathParts] = line.split('\t');
            const filePath = pathParts.join('\t'); // Handle paths with tabs
            const typeMap: Record<string, string> = {
                'M': 'modified',
                'A': 'added',
                'D': 'deleted',
                'R': 'renamed',
                'C': 'copied',
            };
            return {
                filePath,
                type: typeMap[statusCode?.charAt(0) ?? 'M'] ?? 'modified',
            };
        }).filter((change) => change.filePath);
    } catch {
        return [];
    }
}

/* ─── rename ─────────────────────────────────────────────────── */

/**
 * rename — Multi-file coordinated rename using the Kùzu graph + text search.
 *
 * Purpose: Finds all references to a symbol via graph edges (high confidence)
 *   and regex text search (lower confidence). Preview by default (dry_run=true).
 *   Replaces GitNexus's MCP-only rename tool.
 *
 * @param api - DeveloperApi for plugin-owned Kùzu queries.
 * @param symbolName - Current name of the symbol to rename.
 * @param newName - New name for the symbol.
 * @param repoPath - Path to the repository root.
 * @param dryRun - If true, preview without applying (default: true).
 * @returns RenameResult with proposed/applied edits.
 *
 * Side Effects: Reads files for text search. Writes files if dryRun=false.
 * Determinism: Deterministic for a given file system state.
 * Idempotency: Dry run is idempotent. Apply is NOT idempotent.
 */
export async function rename(
    api: DeveloperApi,
    symbolName: string,
    newName: string,
    repoPath: string,
    dryRun: boolean = true,
): Promise<RenameResult> {
    const edits: RenameEdit[] = [];

    // Phase 1: Graph-based references (high confidence)
    const graphEdits = await findGraphReferences(api, symbolName, repoPath);
    edits.push(...graphEdits);

    // Phase 2: Text search fallback (lower confidence)
    const textEdits = findTextReferences(symbolName, repoPath, edits);
    edits.push(...textEdits);

    // Apply if not dry run
    if (!dryRun && edits.length > 0) {
        applyRenameEdits(edits, symbolName, newName);
    }

    const filesAffected = new Set(edits.map((edit) => edit.filePath)).size;

    return { edits, applied: !dryRun, filesAffected };
}

/**
 * findGraphReferences — Find symbol references via Kùzu CodeRelation edges.
 *
 * Queries CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY edges
 * that reference the target symbol. These are high-confidence results.
 */
async function findGraphReferences(
    api: DeveloperApi,
    symbolName: string,
    repoPath: string,
): Promise<RenameEdit[]> {
    const edits: RenameEdit[] = [];

    // Find the symbol itself
    const symbols = await api.queryCodeSymbolsByName(symbolName);

    for (const symbol of symbols) {
        // Add the declaration itself
        const absPath = path.join(repoPath, symbol.filePath);
        if (fs.existsSync(absPath)) {
            edits.push({
                filePath: absPath,
                line: symbol.startLine,
                original: symbolName,
                replacement: symbolName, // placeholder — actual replacement happens in applyRenameEdits
                source: 'graph',
            });
        }

        // Find all incoming references (callers, importers, etc.)
        const relations = await api.getCodeRelationsTo(symbol.uid);
        for (const relation of relations) {
            // Get the source symbol's file
            const sourceSymbol = await api.getCodeSymbolByUid(relation.sourceUid);
            if (sourceSymbol) {
                const sourceAbsPath = path.join(repoPath, sourceSymbol.filePath);
                if (fs.existsSync(sourceAbsPath)) {
                    edits.push({
                        filePath: sourceAbsPath,
                        line: sourceSymbol.startLine,
                        original: symbolName,
                        replacement: symbolName,
                        source: 'graph',
                    });
                }
            }
        }
    }

    return edits;
}

/**
 * findTextReferences — Regex fallback to find additional references.
 *
 * Searches source files for the symbol name as a word boundary match.
 * Deduplicates against graph-found references.
 */
function findTextReferences(
    symbolName: string,
    repoPath: string,
    existingEdits: RenameEdit[],
): RenameEdit[] {
    const edits: RenameEdit[] = [];
    const existingLocations = new Set(
        existingEdits.map((edit) => `${edit.filePath}:${edit.line}`),
    );

    try {
        // Use grep for fast text search
        const grepOutput = execSync(
            `grep -rnw "${symbolName}" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" --include="*.py" --include="*.java" --include="*.go" --include="*.rs" --include="*.rb" --include="*.cs" . 2>/dev/null || true`,
            { cwd: repoPath, encoding: 'utf-8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
        ).trim();

        if (!grepOutput) return edits;

        for (const line of grepOutput.split('\n')) {
            const match = line.match(/^\.\/(.+?):(\d+):/);
            if (match) {
                const filePath = path.join(repoPath, match[1]);
                const lineNum = parseInt(match[2], 10);
                const locationKey = `${filePath}:${lineNum}`;

                // Skip node_modules, dist, .git
                if (filePath.includes('node_modules') || filePath.includes('/dist/') || filePath.includes('/.git/')) {
                    continue;
                }

                if (!existingLocations.has(locationKey)) {
                    edits.push({
                        filePath,
                        line: lineNum,
                        original: symbolName,
                        replacement: symbolName,
                        source: 'text_search',
                    });
                }
            }
        }
    } catch {
        // grep failed — non-fatal
    }

    return edits;
}

/**
 * applyRenameEdits — Apply rename edits to files.
 *
 * Replaces the old symbol name with the new name in each file.
 * Uses word-boundary-aware replacement to avoid partial matches.
 *
 * Side Effects: Writes to filesystem.
 */
function applyRenameEdits(
    edits: RenameEdit[],
    oldName: string,
    newName: string,
): void {
    // Group edits by file
    const byFile = new Map<string, RenameEdit[]>();
    for (const edit of edits) {
        const existing = byFile.get(edit.filePath) ?? [];
        existing.push(edit);
        byFile.set(edit.filePath, existing);
    }

    // Apply to each file
    const wordBoundaryRegex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g');

    for (const [filePath] of byFile) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const updated = content.replace(wordBoundaryRegex, newName);
            if (updated !== content) {
                fs.writeFileSync(filePath, updated, 'utf-8');
            }
        } catch {
            // File read/write failed — skip silently
        }
    }
}

/**
 * escapeRegex — Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─── list_repos ─────────────────────────────────────────────── */

/**
 * listRepos — List all repositories indexed by GitNexus.
 *
 * Purpose: Reads the GitNexus registry file (~/.gitnexus/registry.json)
 *   and returns formatted repo information. Replaces the GitNexus
 *   `list_repos` MCP tool.
 *
 * @returns Array of RepoInfo objects.
 *
 * Side Effects: Reads filesystem.
 * Determinism: Deterministic for a given filesystem state.
 * Idempotency: Yes — read-only.
 */
export function listRepos(): RepoInfo[] {
    const registryPath = path.join(os.homedir(), '.gitnexus', 'registry.json');

    if (!fs.existsSync(registryPath)) {
        return [];
    }

    try {
        const raw = fs.readFileSync(registryPath, 'utf-8');
        const registry = JSON.parse(raw) as Record<string, unknown>;
        const repos: RepoInfo[] = [];

        // Registry format: { "repos": { "name": { "path": "...", "indexedAt": "..." } } }
        const repoEntries = (registry['repos'] ?? registry) as Record<string, Record<string, unknown>>;

        for (const [name, info] of Object.entries(repoEntries)) {
            if (typeof info === 'object' && info !== null) {
                repos.push({
                    name,
                    path: (info['path'] as string) ?? '',
                    indexedAt: (info['indexedAt'] as string) ?? (info['created'] as string) ?? '',
                    symbolCount: (info['symbolCount'] as number) ?? undefined,
                });
            }
        }

        return repos;
    } catch {
        return [];
    }
}

/**
 * formatReposMarkdown — Format repo list as markdown table.
 *
 * @param repos - Array of RepoInfo objects.
 * @returns Markdown-formatted string.
 */
export function formatReposMarkdown(repos: RepoInfo[]): string {
    if (repos.length === 0) {
        return 'No repositories indexed. Run `gitnexus analyze <path>` to index a repository.';
    }

    const lines: string[] = [
        `## Indexed Repositories (${repos.length})`,
        '',
        '| Name | Path | Indexed |',
        '|---|---|---|',
    ];

    for (const repo of repos) {
        const indexedDate = repo.indexedAt ? new Date(repo.indexedAt).toLocaleDateString() : 'Unknown';
        lines.push(`| ${repo.name} | ${repo.path} | ${indexedDate} |`);
    }

    return lines.join('\n');
}

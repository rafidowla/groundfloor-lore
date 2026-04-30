/**
 * codeIndexer.ts — Repo-registry reads + Atlas-backed indexing entry points.
 *
 * **Phase 7 retirement (2026-04-30):** This module used to shell out
 * to the gitnexus CLI binary (`gitnexus analyze`, `gitnexus cypher`,
 * temp-file output parsing) for both repo discovery and full-repo
 * indexing. Phase 7's destructive cutover replaced the data side of
 * that pipeline with Atlas's tree-sitter-based parser + resolver
 * (atlasIndexer.indexRepoWithAtlas). This module now:
 *
 *   - keeps the same public surface for back-compat with api.ts /
 *     repoOps.ts callers (renaming would ripple through ~12 call
 *     sites for no operational benefit until v1.1 cleans up names)
 *   - reads the repo registry from `~/.gitnexus/registry.json` (the
 *     gitnexus binary still maintains this file when it's present;
 *     post-retirement it becomes a "repo discovery" file Atlas owns
 *     OR we add a native registry file in v1.1)
 *   - delegates indexing to api.indexRepoWithAtlas (which closes over
 *     the live PluginGraphContext)
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Functions surface:
 *   listGitNexusRepos      — registry read (no subprocess)
 *   getGitNexusRepo        — registry lookup
 *   isGitNexusAvailable    — DEPRECATED; returns true post-retirement
 *   importFromGitNexus     — DELEGATES to api.indexRepoWithAtlas
 *   indexAllRepos          — DELEGATES to api.indexRepoWithAtlas per repo
 *   generateSymbolUid      — DEPRECATED; legacy uid format helper
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DeveloperApi } from './api.js';

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * GitNexusRepoEntry — A repo entry from the registry file.
 *
 * Field name is preserved for back-compat. Post-Phase-7 the file is
 * still authoritative for repo discovery (until a native Atlas
 * registry replaces it in v1.1+).
 */
export interface GitNexusRepoEntry {
    name: string;
    path: string;
    storagePath: string;
    indexedAt: string;
    lastCommit: string;
    stats: {
        files: number;
        nodes: number;
        edges: number;
        communities: number;
        processes: number;
        embeddings: number;
    };
}

/**
 * IndexResult — Summary of a code-indexing operation.
 *
 * Shape preserved from the gitnexus era so api.ts callers continue to
 * compile. Phase 7 changes the underlying meaning only:
 *   symbolsImported / relationsImported now come from atlasIndexer's
 *   AtlasIndexResult (parseRepo + resolveRepo + upsert).
 */
export interface IndexResult {
    repo: string;
    symbolsImported: number;
    relationsImported: number;
    symbolsCleared: number;
    durationMs: number;
    errors: string[];
}

/* ─── Registry ────────────────────────────────────────────────── */

/**
 * Read the registry of indexed repos. Post-retirement this is still
 * `~/.gitnexus/registry.json` because no other component maintains
 * this file and rewriting registry-management is a v1.1 concern (the
 * gitnexus binary's analyze command writes this file when present;
 * Atlas's indexing path doesn't update it currently — also a v1.1
 * follow-up).
 */
export function listGitNexusRepos(): GitNexusRepoEntry[] {
    const registryPath = path.join(os.homedir(), '.gitnexus', 'registry.json');
    try {
        const content = fs.readFileSync(registryPath, 'utf-8');
        return JSON.parse(content) as GitNexusRepoEntry[];
    } catch {
        return [];
    }
}

export function getGitNexusRepo(repoName: string): GitNexusRepoEntry | null {
    const repos = listGitNexusRepos();
    return repos.find((repo) => repo.name === repoName) ?? null;
}

/**
 * @deprecated Phase 7 retirement — Atlas runs in-process and does not
 * shell out to the gitnexus binary. Always returns true so existing
 * `if (api.isGitNexusAvailable())` guards still pass. Drop the
 * guards (and this function) in v1.1.
 */
export function isGitNexusAvailable(): boolean {
    return true;
}

/**
 * @deprecated Phase 7 — gitnexus uid format `<repo>::<file>::<name>::<Kind>`
 * is no longer the canonical Atlas uid format (which is
 * `<file>:<qualifiedName>:<kind>`). Kept exported for any caller
 * holding old uids in transit; drop in v1.1.
 */
export function generateSymbolUid(repo: string, filePath: string, name: string, kind: string): string {
    return `${repo}::${filePath}::${name}::${kind}`;
}

/* ─── Indexing — Atlas-backed ─────────────────────────────────── */

/**
 * Pull symbols + relations into Lore's Kùzu graph for one repo.
 *
 * **Phase 7 retirement note**: name preserved for back-compat with
 * api.ts; underlying behaviour is now atlasIndexer.indexRepoWithAtlas
 * (parseRepo + resolveRepo + upsert) — no gitnexus subprocess, no
 * temp-file parsing. v1.1 renames this to `indexRepo` and updates
 * the api surface.
 */
export async function importFromGitNexus(
    repo: GitNexusRepoEntry,
    api: DeveloperApi,
): Promise<IndexResult> {
    const startedAt = Date.now();
    try {
        const result = await api.indexRepoWithAtlas(repo.path, { repoName: repo.name, clearFirst: true });
        return {
            repo: result.repo,
            symbolsImported: result.symbolsUpserted,
            relationsImported: result.relationsInserted,
            symbolsCleared: 0,   // Atlas's clearFirst is internal; no per-call count surfaced
            durationMs: result.durationMs,
            errors: [],
        };
    } catch (err) {
        return {
            repo: repo.name,
            symbolsImported: 0,
            relationsImported: 0,
            symbolsCleared: 0,
            durationMs: Date.now() - startedAt,
            errors: [(err as Error).message],
        };
    }
}

/**
 * Index every repo in the registry via Atlas. Sequential — keeps
 * memory pressure bounded and avoids tripping over a shared Kùzu
 * write lock. v1.1 may parallelise after benchmarking.
 */
export async function indexAllRepos(api: DeveloperApi): Promise<IndexResult[]> {
    const repos = listGitNexusRepos();
    const out: IndexResult[] = [];
    for (const repo of repos) {
        const result = await importFromGitNexus(repo, api);
        out.push(result);
    }
    return out;
}

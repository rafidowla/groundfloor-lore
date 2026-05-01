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
 * IndexedRepo — A repo entry from the registry file. Renamed from
 * `GitNexusRepoEntry` on 2026-04-30 (v1.1) to drop the leaked vendor
 * name from the public type surface.
 *
 * `GitNexusRepoEntry` retained as a deprecated type alias for one
 * release window. Drop in v1.2.
 */
export interface IndexedRepo {
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

/** @deprecated Renamed to `IndexedRepo` on 2026-04-30. Drop in v1.2. */
export type GitNexusRepoEntry = IndexedRepo;

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
 * Atlas registry path resolution. Native Atlas registry lives at
 * `<LORE_HOME>/atlas-registry.json`. Falls back to the legacy
 * `~/.gitnexus/registry.json` so users with an existing gitnexus
 * install don't have to migrate manually — the gitnexus binary kept
 * this file current pre-Phase-7. v1.1 adds the Atlas writer; this
 * read path supports both files transparently.
 */
function atlasRegistryPath(): string {
    const loreHome = process.env['LORE_HOME'] || path.join(os.homedir(), '.groundfloor');
    return path.join(loreHome, 'atlas-registry.json');
}
function legacyGitnexusRegistryPath(): string {
    return path.join(os.homedir(), '.gitnexus', 'registry.json');
}

/**
 * Read the registry of indexed repos. Tries the native Atlas registry
 * first (`<LORE_HOME>/atlas-registry.json`), falls back to the legacy
 * gitnexus registry if Atlas's hasn't been initialised yet.
 */
export function listGitNexusRepos(): IndexedRepo[] {
    // Try Atlas-native first.
    try {
        const content = fs.readFileSync(atlasRegistryPath(), 'utf-8');
        return JSON.parse(content) as IndexedRepo[];
    } catch { /* fall through to legacy */ }

    // Fall back to legacy gitnexus registry.
    try {
        const content = fs.readFileSync(legacyGitnexusRegistryPath(), 'utf-8');
        return JSON.parse(content) as IndexedRepo[];
    } catch {
        return [];
    }
}

export function getGitNexusRepo(repoName: string): IndexedRepo | null {
    const repos = listGitNexusRepos();
    return repos.find((repo) => repo.name === repoName) ?? null;
}

/**
 * Write the Atlas registry. v1.1 entry point — `addRepo` /
 * `removeRepo` / `indexAllRepos` should call this after their work to
 * keep the registry current. Today nothing calls it; the gitnexus
 * binary kept the legacy file fresh. Once v1.1 wires this in, Atlas
 * owns its own registry end-to-end.
 */
export function writeAtlasRegistry(repos: IndexedRepo[]): void {
    const p = atlasRegistryPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(repos, null, 2), 'utf-8');
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
    repo: IndexedRepo,
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

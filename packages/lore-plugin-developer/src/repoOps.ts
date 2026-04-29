/**
 * repoOps.ts — Repo discovery, add, remove, freshness, and hook install.
 *
 * Phase 1 of the Add-Project UI feature (per
 * decision-add-project-ui-phase1-defaults-2026-04-27).
 *
 * Architecture:
 *   - All gitnexus-aware code lives here in the developer plugin.
 *   - Core (`packages/lore/src/mcp/server.ts`) calls these via DeveloperApi
 *     to stay clean of plugin vocabulary (per CLAUDE.md plugin boundary).
 *   - Subprocess shells out to `gitnexus analyze` — never imports.
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as indexer from './codeIndexer.js';
import { loreHomePath } from '@lore-core/config/loreHome.js';
import type { DeveloperApi } from './api.js';

/* ─── Repo tags (stored separately from gitnexus registry) ─────── */

/**
 * Tags live in `~/.groundfloor/.lore/repo-tags.json` so we don't touch
 * gitnexus's registry file (which gitnexus rewrites on its own runs).
 *
 * Shape: { "<repo-name>": ["tag1", "tag2"], ... }
 */
const REPO_TAGS_FILE = loreHomePath('.lore', 'repo-tags.json');

function readRepoTagsFile(): Record<string, string[]> {
    try {
        if (!fs.existsSync(REPO_TAGS_FILE)) return {};
        const raw = fs.readFileSync(REPO_TAGS_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, string[]>;
        if (!parsed || typeof parsed !== 'object') return {};
        return parsed;
    } catch {
        return {};
    }
}

function writeRepoTagsFile(tags: Record<string, string[]>): void {
    const dir = path.dirname(REPO_TAGS_FILE);
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch { /* best effort */ }
    fs.writeFileSync(REPO_TAGS_FILE, JSON.stringify(tags, null, 2));
}

export function getRepoTags(repoName: string): string[] {
    const all = readRepoTagsFile();
    return all[repoName] ?? [];
}

export function setRepoTags(repoName: string, tags: string[]): string[] {
    // Normalize: lowercase, trim, dedupe, drop empty
    const normalized = Array.from(new Set(
        tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0 && t.length <= 40),
    )).sort();
    const all = readRepoTagsFile();
    if (normalized.length === 0) {
        delete all[repoName];
    } else {
        all[repoName] = normalized;
    }
    writeRepoTagsFile(all);
    return normalized;
}

export function listAllRepoTags(): Array<{ tag: string; repos: string[] }> {
    const all = readRepoTagsFile();
    const tagMap = new Map<string, string[]>();
    for (const [repoName, tags] of Object.entries(all)) {
        for (const tag of tags) {
            if (!tagMap.has(tag)) tagMap.set(tag, []);
            tagMap.get(tag)!.push(repoName);
        }
    }
    return Array.from(tagMap.entries())
        .map(([tag, repos]) => ({ tag, repos: repos.sort() }))
        .sort((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * reposForTags — given a set of tags, return all repo names that have
 * at least ONE matching tag (OR semantics — broad inclusion, not strict
 * intersection). Used by /api/topology?tags= to filter.
 */
export function reposForTags(tags: string[]): string[] {
    if (tags.length === 0) return [];
    const all = readRepoTagsFile();
    const wanted = new Set(tags.map((t) => t.toLowerCase()));
    const matched: string[] = [];
    for (const [repoName, repoTags] of Object.entries(all)) {
        if (repoTags.some((t) => wanted.has(t))) matched.push(repoName);
    }
    return matched.sort();
}

/* ─── Built-in skip patterns ───────────────────────────────────── */

/**
 * Folders we never index — vendored deps, build output, our own indexes.
 * Matches the locked Phase-1 default list (see decision node).
 */
export const DEFAULT_SKIP_DIRS = new Set<string>([
    'node_modules',
    'dist',
    'build',
    '.next',
    'vendor',
    'target',
    '.git',
    'coverage',
    '.gitnexus',
    '.lore',
]);

/* ─── Types ────────────────────────────────────────────────────── */

export interface DiscoveredRepo {
    /** Suggested name (folder basename). */
    name: string;
    /** Absolute path. */
    path: string;
    /** True if this repo is already indexed in the registry. */
    alreadyIndexed: boolean;
    /** Bytes on disk (rough — sum of immediate file sizes). */
    sizeBytes?: number;
    /** Has a .git directory. Always true for results. */
    hasGit: true;
}

export interface RepoFreshness {
    name: string;
    /** When the repo was last fully analyzed by the indexer. */
    indexedAt: string;
    /** Commit recorded at last analyze. */
    lastIndexedCommit: string;
    /** Current HEAD in the worktree. Null if git read failed. */
    currentHeadCommit: string | null;
    /** True when current HEAD differs from last-indexed commit. */
    behindHead: boolean;
    /** Hours since last analyze. */
    hoursSinceIndex: number;
    /** Verdict: 'fresh' | 'stale' | 'never'. */
    status: 'fresh' | 'stale' | 'never';
    /** Reason for stale/never status, for UI display. */
    reason?: string;
}

export interface AddRepoResult {
    /** Repo name in the registry. */
    name: string;
    /** Path indexed. */
    path: string;
    /** Did we run analyze just now? (false = was already analyzed) */
    analyzed: boolean;
    /** Did we import into Lore's graph? */
    imported: boolean;
    /** Symbols loaded into Lore. */
    symbolCount?: number;
    /** Was the post-commit hook installed? */
    hookInstalled?: boolean;
    /** Errors that didn't fully block — analyze warnings, etc. */
    warnings?: string[];
}

/* ─── Discovery ────────────────────────────────────────────────── */

/**
 * discoverRepos — Walk a parent folder; return git repos found.
 *
 * Shallow mode (default): only direct subfolders.
 * Deep mode: walks up to maxDepth, skipping DEFAULT_SKIP_DIRS.
 *
 * Marks each result with alreadyIndexed by cross-referencing the
 * gitnexus registry.
 */
export function discoverRepos(
    parentPath: string,
    opts: { depth?: 'shallow' | 'deep'; maxDepth?: number } = {},
): DiscoveredRepo[] {
    const depth = opts.depth ?? 'shallow';
    const maxDepth = opts.maxDepth ?? 4;

    if (!fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) {
        return [];
    }

    const found: string[] = [];
    if (depth === 'shallow') {
        for (const entry of safeReaddir(parentPath)) {
            const full = path.join(parentPath, entry);
            if (isGitRepo(full)) found.push(full);
        }
    } else {
        walkForGitRepos(parentPath, found, 0, maxDepth);
    }

    const registry = indexer.listGitNexusRepos();
    const indexedPaths = new Set(registry.map((r) => path.resolve(r.path)));

    return found
        .map((repoPath) => ({
            name: path.basename(repoPath),
            path: repoPath,
            alreadyIndexed: indexedPaths.has(path.resolve(repoPath)),
            hasGit: true as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function walkForGitRepos(
    dir: string,
    out: string[],
    depth: number,
    maxDepth: number,
): void {
    if (depth > maxDepth) return;
    if (isGitRepo(dir)) {
        out.push(dir);
        return; // do not recurse into the repo itself
    }
    for (const entry of safeReaddir(dir)) {
        if (DEFAULT_SKIP_DIRS.has(entry)) continue;
        const full = path.join(dir, entry);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(full);
        } catch {
            continue;
        }
        if (stat.isDirectory()) walkForGitRepos(full, out, depth + 1, maxDepth);
    }
}

function isGitRepo(p: string): boolean {
    try {
        return fs.statSync(path.join(p, '.git')).isDirectory()
            // worktrees and submodules have .git as a file pointer
            || fs.statSync(path.join(p, '.git')).isFile();
    } catch {
        return false;
    }
}

function safeReaddir(p: string): string[] {
    try {
        return fs.readdirSync(p);
    } catch {
        return [];
    }
}

/* ─── Freshness ────────────────────────────────────────────────── */

/**
 * getRepoFreshness — Tell the UI whether a repo's index is up-to-date.
 *
 * Compares lastIndexedCommit to current HEAD and indexedAt to wall clock.
 * "Stale" means either the worktree has new commits OR the index is older
 * than 24h with nightly enabled (caller decides the threshold from config).
 */
export function getRepoFreshness(
    name: string,
    staleAfterHours: number = 24,
): RepoFreshness | null {
    const repo = indexer.getGitNexusRepo(name);
    if (!repo) return null;

    const indexedAt = repo.indexedAt;
    const lastIndexedCommit = repo.lastCommit ?? '';
    const currentHeadCommit = readHeadCommit(repo.path);

    const indexedDate = new Date(indexedAt).getTime();
    const hoursSinceIndex = (Date.now() - indexedDate) / 36e5;

    const behindHead =
        currentHeadCommit !== null &&
        lastIndexedCommit !== '' &&
        currentHeadCommit !== lastIndexedCommit;

    let status: RepoFreshness['status'] = 'fresh';
    let reason: string | undefined;
    if (behindHead) {
        status = 'stale';
        reason = `worktree has new commits since last index`;
    } else if (hoursSinceIndex > staleAfterHours) {
        status = 'stale';
        reason = `last indexed ${Math.round(hoursSinceIndex)}h ago`;
    }

    return {
        name,
        indexedAt,
        lastIndexedCommit,
        currentHeadCommit,
        behindHead,
        hoursSinceIndex,
        status,
        reason,
    };
}

function readHeadCommit(repoPath: string): string | null {
    try {
        return execSync('git rev-parse HEAD', {
            cwd: repoPath,
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}

/* ─── Add a repo (analyze + import) ────────────────────────────── */

/**
 * addRepo — Run `gitnexus analyze` if needed, then import to Lore.
 *
 * If the repo already has a `.gitnexus/` folder and is up-to-date with
 * HEAD, we skip the analyze step and only import. Otherwise we run a
 * fresh analyze.
 *
 * Optionally installs the post-commit auto-refresh hook.
 *
 * Side effects:
 *   - May spawn `gitnexus analyze` (~30-90s for new repos).
 *   - Writes to `.gitnexus/` and `~/.gitnexus/registry.json`.
 *   - Calls into Lore's developer-plugin tables via importFromGitNexus.
 *   - Optionally writes `.git/hooks/post-commit`.
 */
export async function addRepo(
    repoPath: string,
    api: DeveloperApi,
    opts: { installHook?: boolean; force?: boolean } = {},
): Promise<AddRepoResult> {
    const absPath = path.resolve(repoPath);
    if (!fs.existsSync(absPath)) {
        throw new Error(`Repo path does not exist: ${absPath}`);
    }
    if (!isGitRepo(absPath)) {
        throw new Error(`Not a git repo (no .git found): ${absPath}`);
    }

    const warnings: string[] = [];
    const name = path.basename(absPath);
    const indexerStorage = path.join(absPath, '.gitnexus');
    const headCommit = readHeadCommit(absPath);

    // Decide whether to run analyze.
    const existingEntry = indexer.listGitNexusRepos()
        .find((r) => path.resolve(r.path) === absPath);
    const headIsCurrent =
        existingEntry !== undefined &&
        headCommit !== null &&
        existingEntry.lastCommit === headCommit &&
        fs.existsSync(indexerStorage);

    let analyzed = false;
    if (opts.force || !headIsCurrent) {
        await runAnalyze(absPath);
        analyzed = true;
    }

    // After analyze, fetch the (now-updated) registry entry and import.
    const repoEntry = indexer.listGitNexusRepos()
        .find((r) => path.resolve(r.path) === absPath);
    if (!repoEntry) {
        throw new Error(`Analyze finished but registry entry not found for ${absPath}`);
    }

    const importResult = await api.importFromGitNexus(repoEntry);

    let hookInstalled = false;
    if (opts.installHook) {
        try {
            installPostCommitHook(absPath);
            hookInstalled = true;
        } catch (e) {
            warnings.push(`Hook install failed: ${(e as Error).message}`);
        }
    }

    return {
        name: repoEntry.name,
        path: repoEntry.path,
        analyzed,
        imported: true,
        symbolCount: importResult?.symbolsImported,
        hookInstalled,
        warnings: warnings.length ? warnings : undefined,
    };
}

/**
 * findGitnexusBin — Resolve gitnexus binary by absolute path. Critical
 * because the launchd-managed daemon doesn't inherit user shell PATH,
 * so `spawn('npx', …)` and `spawn('gitnexus', …)` both fail with ENOENT.
 *
 * Search order: bundled (Lore's own node_modules) → homebrew → /usr/local → nvm.
 */
function findGitnexusBin(): string | null {
    // Walk up from this module to find the lore repo root with node_modules/.bin/gitnexus
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, 'node_modules', '.bin', 'gitnexus');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    const fallbacks = [
        '/opt/homebrew/bin/gitnexus',
        '/usr/local/bin/gitnexus',
        path.join(os.homedir(), '.nvm/versions/node', process.version, 'bin/gitnexus'),
    ];
    for (const c of fallbacks) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

/**
 * runAnalyze — Spawn `gitnexus analyze <path>`. Streams stderr to
 * Lore's log directory so the user can debug if it fails.
 */
function runAnalyze(repoPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const bin = findGitnexusBin();
        if (!bin) {
            reject(new Error('gitnexus binary not found — install via `npm install -g gitnexus` or ensure Lore was built with bundled deps'));
            return;
        }

        const logDir = loreHomePath('logs');
        try {
            fs.mkdirSync(logDir, { recursive: true });
        } catch { /* best-effort */ }
        const logPath = path.join(logDir, 'add-repo-analyze.log');
        const out = fs.openSync(logPath, 'a');

        // Invoke node explicitly to bypass the shebang. The launchd-managed
        // daemon's PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — no nvm, no node —
        // so `#!/usr/bin/env node` fails with exit 127. process.execPath is
        // the node binary running the daemon itself; always exists.
        const child = spawn(process.execPath, [bin, 'analyze', repoPath], {
            stdio: ['ignore', out, out],
        });

        const watchdog = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`gitnexus analyze timed out after 5min — see ${logPath}`));
        }, 5 * 60 * 1000);

        child.on('exit', (code) => {
            clearTimeout(watchdog);
            try { fs.closeSync(out); } catch { /* ignore */ }
            if (code === 0) resolve();
            else reject(new Error(`gitnexus analyze exited ${code} — see ${logPath}`));
        });
        child.on('error', (err) => {
            clearTimeout(watchdog);
            try { fs.closeSync(out); } catch { /* ignore */ }
            reject(err);
        });
    });
}

/* ─── Remove a repo ────────────────────────────────────────────── */

export interface RemoveRepoResult {
    name: string;
    symbolsCleared: number;
    registryUpdated: boolean;
}

/**
 * removeRepo — Drop the repo from Lore's graph and gitnexus registry.
 *
 * Does NOT delete the repo's `.gitnexus/` folder on disk — re-adding
 * later can reuse it. Use `--purge` (future) to nuke that folder too.
 */
export async function removeRepo(
    name: string,
    api: DeveloperApi,
): Promise<RemoveRepoResult> {
    const symbolsCleared = await api.clearCodeSymbols(name);

    const registryPath = path.join(os.homedir(), '.gitnexus', 'registry.json');
    let registryUpdated = false;
    try {
        const raw = fs.readFileSync(registryPath, 'utf-8');
        const list = JSON.parse(raw) as Array<{ name: string }>;
        const filtered = list.filter((r) => r.name !== name);
        if (filtered.length !== list.length) {
            fs.writeFileSync(registryPath, JSON.stringify(filtered, null, 2));
            registryUpdated = true;
        }
    } catch { /* registry may not exist; that's fine */ }

    return { name, symbolsCleared, registryUpdated };
}

/* ─── Post-commit hook installer ───────────────────────────────── */

/**
 * installPostCommitHook — Copy our shipped post-commit script into the
 * target repo's .git/hooks/. Refuses to overwrite an existing hook
 * unless force=true.
 *
 * The hook source lives in scripts/hooks/post-commit at the lore repo
 * root; we resolve it via the package install path.
 */
export function installPostCommitHook(
    repoPath: string,
    opts: { force?: boolean } = {},
): { installed: boolean; reason?: string } {
    const hooksDir = path.join(repoPath, '.git', 'hooks');
    if (!fs.existsSync(hooksDir)) {
        throw new Error(`No .git/hooks directory at ${repoPath}`);
    }
    const dest = path.join(hooksDir, 'post-commit');

    if (fs.existsSync(dest) && !opts.force) {
        return { installed: false, reason: 'post-commit hook already exists' };
    }

    const source = findShippedHookSource();
    if (!source) {
        throw new Error('Lore post-commit hook source not found in package install');
    }
    const content = fs.readFileSync(source, 'utf-8');
    fs.writeFileSync(dest, content, { mode: 0o755 });
    return { installed: true };
}

/**
 * findShippedHookSource — Locate scripts/hooks/post-commit relative to
 * this module, walking up to the lore repo root. Works in both
 * source-tree and published-package layouts.
 */
function findShippedHookSource(): string | null {
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, 'scripts', 'hooks', 'post-commit');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

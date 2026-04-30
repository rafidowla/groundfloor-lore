/**
 * git/churn.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * `git log --numstat` parsed per file.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 5 (git signals — host-agnostic).
 *
 * Captures recent change activity per file by parsing `git log
 * --numstat`. Used as input to hotspots.ts (complexity × churn) and
 * prRisk.ts. Host-agnostic — works equally on GitHub, Bitbucket,
 * GitLab, self-hosted git.
 */

import { spawnSync } from 'node:child_process';

export interface ChurnStats {
    /** Number of commits touching this file in the window. */
    commits: number;
    /** Total additions (lines) across those commits. */
    additions: number;
    /** Total deletions (lines) across those commits. */
    deletions: number;
}

/**
 * Compute churn for one file over the last `sinceDays` (default 30).
 * Returns zeros for files git doesn't know about.
 */
export function fileChurn(
    repoRoot: string,
    filePath: string,
    sinceDays = 30,
): ChurnStats {
    const result = spawnSync(
        'git',
        ['log', `--since=${sinceDays} days ago`, '--numstat', '--format=', '--', filePath],
        { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) return { commits: 0, additions: 0, deletions: 0 };
    return parseNumstat(result.stdout);
}

function parseNumstat(stdout: string): ChurnStats {
    let commits = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const [a, d] = [parts[0], parts[1]];
        if (a === '-' || d === '-') continue; // binary file
        const aNum = parseInt(a, 10);
        const dNum = parseInt(d, 10);
        if (!Number.isFinite(aNum) || !Number.isFinite(dNum)) continue;
        commits += 1;
        additions += aNum;
        deletions += dNum;
    }
    return { commits, additions, deletions };
}

/**
 * Compute churn for every file in the repo in a single git invocation.
 * Returns a Map keyed by repo-relative path. Faster than per-file when
 * scoring many files (e.g., feeding hotspots.ts).
 */
export function repoChurn(repoRoot: string, sinceDays = 30): Map<string, ChurnStats> {
    const out = new Map<string, ChurnStats>();
    const result = spawnSync(
        'git',
        ['log', `--since=${sinceDays} days ago`, '--numstat', '--format=__COMMIT__'],
        { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0) return out;

    for (const line of result.stdout.split('\n')) {
        if (line.startsWith('__COMMIT__') || !line.trim()) continue;
        const parts = line.split(/\t/);
        if (parts.length < 3) continue;
        const [a, d, file] = parts;
        if (a === '-' || d === '-') continue;
        const aNum = parseInt(a, 10);
        const dNum = parseInt(d, 10);
        if (!Number.isFinite(aNum) || !Number.isFinite(dNum)) continue;
        const existing = out.get(file) ?? { commits: 0, additions: 0, deletions: 0 };
        existing.commits += 1;
        existing.additions += aNum;
        existing.deletions += dNum;
        out.set(file, existing);
    }
    return out;
}

/**
 * Convenience: total-line-changes-per-file as a single scalar.
 * Suitable as the `churnLookup` callback hotspots.ts expects.
 */
export function churnScore(stats: ChurnStats | undefined): number {
    if (!stats) return 0;
    return stats.additions + stats.deletions;
}

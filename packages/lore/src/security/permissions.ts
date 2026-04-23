/**
 * permissions.ts — File-system permission lockdown (Phase 0 / S1).
 *
 * Why this exists: Lore's data directory (~/.groundfloor) defaulted to
 * world-readable (0755 / 0644) under macOS umask, so any local user or
 * rogue process on the same Mac could read the knowledge graph, embeddings,
 * workspace registry, and logs. Personal and Family plugins will store
 * photos, medical records, and financial documents — plaintext-and-readable
 * to the world is malpractice.
 *
 * What this does:
 *   - At daemon startup, walks the Lore data tree rooted at the given path
 *     (typically ~/.groundfloor or an alternate workspace root).
 *   - Enforces 0700 on every directory and 0600 on every file it owns.
 *   - Self-heals drift — if a file was created with a permissive umask or
 *     an external tool relaxed perms, we tighten them on each boot.
 *
 * Platform notes:
 *   - POSIX (macOS, Linux): chmod is honored; symlinks skipped to avoid
 *     changing perms on link targets outside the tree.
 *   - Windows: chmod is largely a no-op; this function logs and returns
 *     without erroring. NTFS ACLs would be the proper tool there — deferred
 *     until Lore targets Windows first-class.
 *
 * Invariants:
 *   - Never follows symlinks (lstat + skip).
 *   - Never recurses outside the root.
 *   - Idempotent — safe to call on every boot.
 *   - Does not fail the daemon on error; logs and continues. A permission
 *     miss is not worth bricking the user's ability to start Lore.
 */

import * as fs from 'fs';
import * as path from 'path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface LockdownResult {
    directoriesFixed: number;
    filesFixed: number;
    skipped: number;
    errors: string[];
}

/**
 * lockDownDataDir — Walk `root` and tighten perms on every dir/file.
 *
 * Returns a summary of what was touched. Callers log the summary; errors
 * are collected but do not throw.
 *
 * Complexity: O(n) in the number of entries under root.
 */
export function lockDownDataDir(root: string): LockdownResult {
    const result: LockdownResult = {
        directoriesFixed: 0,
        filesFixed: 0,
        skipped: 0,
        errors: [],
    };

    // Windows: chmod is mostly a no-op; bail with a note.
    if (process.platform === 'win32') {
        return result;
    }

    if (!fs.existsSync(root)) {
        // Nothing to lock down yet — daemon will create it, and subsequent
        // boots will lock down what's there.
        return result;
    }

    walk(root, result);
    return result;
}

function walk(current: string, result: LockdownResult): void {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(current);
    } catch (err) {
        result.errors.push(`lstat ${current}: ${(err as Error).message}`);
        return;
    }

    // Skip symlinks — following them could chmod files outside the data tree.
    if (stat.isSymbolicLink()) {
        result.skipped += 1;
        return;
    }

    if (stat.isDirectory()) {
        // Tighten directory perms first so we can still traverse into it.
        if ((stat.mode & 0o777) !== DIR_MODE) {
            try {
                fs.chmodSync(current, DIR_MODE);
                result.directoriesFixed += 1;
            } catch (err) {
                result.errors.push(`chmod dir ${current}: ${(err as Error).message}`);
                return;
            }
        }

        let entries: string[];
        try {
            entries = fs.readdirSync(current);
        } catch (err) {
            result.errors.push(`readdir ${current}: ${(err as Error).message}`);
            return;
        }

        for (const entry of entries) {
            walk(path.join(current, entry), result);
        }
        return;
    }

    if (stat.isFile()) {
        if ((stat.mode & 0o777) !== FILE_MODE) {
            try {
                fs.chmodSync(current, FILE_MODE);
                result.filesFixed += 1;
            } catch (err) {
                result.errors.push(`chmod file ${current}: ${(err as Error).message}`);
            }
        }
        return;
    }

    // Anything else (socket, block device, FIFO): skip silently. Lore
    // shouldn't be creating these; if they exist, they're not ours to touch.
    result.skipped += 1;
}

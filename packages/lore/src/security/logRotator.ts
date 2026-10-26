/**
 * logRotator.ts — Boot-time rotation for append-only log files (Phase 7a / F3).
 *
 * Two growing-forever files that S1 / S9 never rotated:
 *   ~/.groundfloor/audit.jsonl             (C6 append-only audit log)
 *   ~/.groundfloor/logs/lore-mcp.log       (launchd stderr redirect)
 *   ~/.groundfloor/logs/lore-mcp.out       (launchd stdout redirect)
 *
 * Approach:
 *   - Run at daemon boot. Any file larger than `maxBytes` OR older
 *     than `maxAgeDays` gets renamed with a timestamp suffix and
 *     gzipped. A fresh empty file takes its place with the right perms
 *     so downstream writers (audit.log, launchd) see a valid inode.
 *   - Rotation retention: keep the last `retainCount` rotated files
 *     per log. Older get deleted.
 *
 * Why at boot (not scheduled):
 *   - Daemon restart is the natural quiescent moment. No in-flight
 *     writes to worry about.
 *   - For a single-user daemon that restarts on IDE launch / system
 *     boot, at-boot is frequent enough to never let files grow
 *     materially between rotations.
 *   - Simpler than cron: no timer, no race with active writers.
 *
 * Not in scope:
 *   - Real-time rotation during a single uptime. If the daemon runs
 *     for weeks producing a 500 MB log, we eat that until next boot.
 *     Acceptable for single-user; may need revisiting for long-running
 *     multi-user deployments (alongside D1 work).
 *   - Signal-driven rotation (logrotate-style USR1). Same reason.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export interface RotateOptions {
    /** Rotate if the file is larger than this (bytes). Default: 10 MB. */
    maxBytes?: number;
    /** Rotate if the file is older than this (days). Default: 7. */
    maxAgeDays?: number;
    /** Keep last N rotated files. Default: 30. */
    retainCount?: number;
    /** File mode for the fresh empty file after rotation. Default: 0600. */
    freshMode?: number;
    /** Clock (tests). Drives the archive timestamp and the age check. Default: `() => new Date()`. */
    now?: () => Date;
}

export interface RotateResult {
    rotated: boolean;
    reason?: 'size' | 'age';
    beforeBytes?: number;
    afterBytes?: number;
    rotatedTo?: string;
    retained?: number;
    deleted?: number;
    error?: string;
}

const DEFAULTS: Required<RotateOptions> = {
    maxBytes: 10 * 1024 * 1024,
    maxAgeDays: 7,
    retainCount: 30,
    freshMode: 0o600,
    now: () => new Date(),
};

/** Upper bound on `-N` suffix attempts when archive names collide. */
const MAX_ARCHIVE_SUFFIX = 100;

// ─── Archive naming + ordering ───────────────────────────────────────────

/** Split `<base>.<ts>[-N].gz` into its embedded timestamp and numeric collision suffix (none = 0). */
function parseArchiveName(name: string, base: string): { ts: string; n: number } {
    const rest = name.startsWith(base + '.') ? name.slice(base.length + 1) : name;
    const stem = rest.endsWith('.gz') ? rest.slice(0, -3) : rest;
    const m = /^(.*Z)-(\d+)$/.exec(stem);
    return m ? { ts: m[1]!, n: Number(m[2]) } : { ts: stem, n: 0 };
}

/**
 * Shared archive ordering key: mtime, then the timestamp embedded in the name, then the numeric collision suffix
 * (no suffix = 0). A plain lexical sort gets `...Z-1.gz` vs `...Z.gz` wrong ('-' sorts before '.'), hence the parse.
 * Returns <0 when `a` is older than `b`.
 */
export function compareArchives(
    a: { name: string; mtimeMs: number },
    b: { name: string; mtimeMs: number },
    base: string,
): number {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    const pa = parseArchiveName(a.name, base);
    const pb = parseArchiveName(b.name, base);
    if (pa.ts !== pb.ts) return pa.ts < pb.ts ? -1 : 1;
    return pa.n - pb.n;
}

/** All `<filePath>.<ts>[-N].gz` rotated archives (full paths), oldest → newest by {@link compareArchives}. */
export function listRotatedArchives(filePath: string): string[] {
    try {
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        return fs.readdirSync(dir)
            .filter((f) => f.startsWith(base + '.') && f.endsWith('.gz'))
            .map((f) => ({ name: f, full: path.join(dir, f), mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => compareArchives(a, b, base))
            .map((x) => x.full);
    } catch {
        return [];
    }
}

/** Write `data` to a NEW archive file (never overwrites): `<ts>.gz`, then `<ts>-1.gz` … up to a bound. */
function writeArchiveExclusive(filePath: string, timestamp: string, data: Buffer): string {
    for (let n = 0; n <= MAX_ARCHIVE_SUFFIX; n++) {
        const target = `${filePath}.${timestamp}${n === 0 ? '' : `-${n}`}.gz`;
        try {
            fs.writeFileSync(target, data, { mode: 0o600, flag: 'wx' });
            return target;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
            try { fs.unlinkSync(target); } catch { /* partial file may not exist */ }
            throw err;
        }
    }
    throw new Error(`archive name collision: ${MAX_ARCHIVE_SUFFIX} suffixes exhausted for ${timestamp}`);
}

/**
 * rotateIfNeeded — evaluate one log file; rotate if thresholds exceeded.
 *
 * Non-throwing: logs errors to stderr and returns them in the result.
 * The caller should never fail daemon boot because log rotation failed.
 */
export function rotateIfNeeded(filePath: string, options: RotateOptions = {}): RotateResult {
    const opts = { ...DEFAULTS, ...options };
    const result: RotateResult = { rotated: false };

    if (!fs.existsSync(filePath)) return result;

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        result.error = (err as Error).message;
        return result;
    }

    const ageDays = (opts.now().getTime() - stat.mtimeMs) / (24 * 60 * 60 * 1000);
    const reason: 'size' | 'age' | null =
        stat.size > opts.maxBytes ? 'size'
        : ageDays > opts.maxAgeDays ? 'age'
        : null;

    if (reason == null) return result;

    result.beforeBytes = stat.size;
    result.reason = reason;

    // Rotate: rename + gzip.
    const timestamp = opts.now().toISOString().replace(/[:.]/g, '-');
    let rotatedPath = '';

    try {
        // Read → gzip → write the rotated copy.
        const bytes = fs.readFileSync(filePath);
        const gz = zlib.gzipSync(bytes);
        // 'wx' + suffix retry: two rotations in the same millisecond must never overwrite an earlier archive.
        rotatedPath = writeArchiveExclusive(filePath, timestamp, gz);
        // Truncate the original in place (preserves inode — matters for
        // launchd, which holds an open fd to the file). Can't just
        // unlink: that would break the fd.
        fs.truncateSync(filePath, 0);
        fs.chmodSync(filePath, opts.freshMode);
        result.rotated = true;
        result.rotatedTo = rotatedPath;
        result.afterBytes = 0;
    } catch (err) {
        result.error = (err as Error).message;
        return result;
    }

    // Retention sweep: find all rotated copies, keep the newest N, delete older.
    try {
        const rotated = listRotatedArchives(filePath).reverse(); // newest first, same ordering as auditChain
        result.retained = Math.min(rotated.length, opts.retainCount);
        result.deleted = 0;
        for (const old of rotated.slice(opts.retainCount)) {
            try {
                fs.unlinkSync(old);
                result.deleted += 1;
            } catch { /* ignore individual delete failures */ }
        }
    } catch {
        // Retention is best-effort; if it fails, the rotation still happened.
    }

    return result;
}

/**
 * rotateStandardLogs — run rotateIfNeeded against the three known log
 * locations. Called at boot from main() after perm lockdown.
 */
export function rotateStandardLogs(dataHome: string): Array<{ path: string; result: RotateResult }> {
    const paths = [
        path.join(dataHome, 'audit.jsonl'),
        path.join(dataHome, 'feedback.jsonl'),   // V2.2 thumbs feedback store
        path.join(dataHome, 'logs', 'lore-mcp.log'),
        path.join(dataHome, 'logs', 'lore-mcp.out'),
    ];
    return paths.map((p) => ({ path: p, result: rotateIfNeeded(p) }));
}

/**
 * rotateWorkspaceDispatchLog — rotate `tool-dispatch.jsonl` for one
 * workspace. Called after workspace detection so the correct `.lore/`
 * directory is known.
 *
 * Unlike the standard-log paths, the dispatch log lives in the
 * workspace `.lore/` dir (not `dataHome`), so it cannot be part of
 * the static list above. `rotateIfNeeded` truncates in place
 * (preserving the inode), so the module-level WriteStream in
 * toolDispatchLog.ts stays valid — no stream reset is needed.
 */
export function rotateWorkspaceDispatchLog(loreDir: string): { path: string; result: RotateResult } {
    const logPath = path.join(loreDir, 'tool-dispatch.jsonl');
    return { path: logPath, result: rotateIfNeeded(logPath) };
}

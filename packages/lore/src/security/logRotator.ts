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
 *   - For a personal-use daemon that restarts on IDE launch / system
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
};

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

    const ageDays = (Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000);
    const reason: 'size' | 'age' | null =
        stat.size > opts.maxBytes ? 'size'
        : ageDays > opts.maxAgeDays ? 'age'
        : null;

    if (reason == null) return result;

    result.beforeBytes = stat.size;
    result.reason = reason;

    // Rotate: rename + gzip.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedPath = `${filePath}.${timestamp}.gz`;

    try {
        // Read → gzip → write the rotated copy.
        const bytes = fs.readFileSync(filePath);
        const gz = zlib.gzipSync(bytes);
        fs.writeFileSync(rotatedPath, gz, { mode: 0o600 });
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
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        const rotated = fs.readdirSync(dir)
            .filter((f) => f.startsWith(base + '.') && f.endsWith('.gz'))
            .map((f) => ({
                name: f,
                full: path.join(dir, f),
                mtime: fs.statSync(path.join(dir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
        result.retained = Math.min(rotated.length, opts.retainCount);
        result.deleted = 0;
        for (const old of rotated.slice(opts.retainCount)) {
            try {
                fs.unlinkSync(old.full);
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

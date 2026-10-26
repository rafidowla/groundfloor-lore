/**
 * workspaceErase/lock.ts — cross-process exclusive lock for the erase pass (lane f6b).
 *
 * The daemon, an embedded host, the CLI (`restore`, `erase-now`) and a second host on the same Lore home can
 * all reach the erase code. Only one of them runs an erase or a restore at a time. The lock is a file under
 * the Lore home created with `wx` (fails if it exists). It is stale-safe two ways: the holder's pid is gone
 * (same machine), or the file has not been refreshed for `staleMs` (a holder refreshes it while it works, so
 * a long erase is never mistaken for a dead one). The erasers are idempotent and match by permanent id, so
 * even a rare double run (two processes both judging a lock stale) finishes the same job twice rather than
 * damaging anything.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const ERASE_LOCK_FILE = 'workspace-erase.lock';
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;

export interface EraseLockOptions {
    /** A lock file not refreshed for this long is stale. Default 15 min. */
    staleMs?: number;
    /** How often a held lock refreshes its mtime. Default 30 s. */
    heartbeatMs?: number;
    /** Test seams. */
    pid?: number;
    isPidAlive?: (pid: number) => boolean;
    nowMs?: () => number;
}

export interface EraseLock {
    release(): void;
}

interface LockBody { pid: number; host: string; nonce: string; startedAt: string }

export const eraseLockPath = (home: string): string => path.join(home, ERASE_LOCK_FILE);

const defaultAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

function readBody(file: string): LockBody | null {
    try {
        const b = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockBody>;
        if (typeof b.pid === 'number' && typeof b.nonce === 'string' && typeof b.host === 'string') return b as LockBody;
    } catch { /* unreadable / torn: treated as unknown */ }
    return null;
}

function isStale(file: string, o: Required<Pick<EraseLockOptions, 'staleMs' | 'isPidAlive' | 'nowMs'>>): { stale: boolean; body: LockBody | null } {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return { stale: false, body: null }; } // vanished: caller retries the create
    const body = readBody(file);
    if (body && body.host === os.hostname() && !o.isPidAlive(body.pid)) return { stale: true, body };
    return { stale: o.nowMs() - st.mtimeMs > o.staleMs, body };
}

/**
 * Try once to take the lock. Returns null when another live holder has it. Never throws for "busy"; throws only
 * for filesystem problems that make locking impossible (read-only home).
 */
export function tryAcquireEraseLock(home: string, opts: EraseLockOptions = {}): EraseLock | null {
    const file = eraseLockPath(home);
    const pid = opts.pid ?? process.pid;
    const staleOpts = { staleMs: opts.staleMs ?? DEFAULT_STALE_MS, isPidAlive: opts.isPidAlive ?? defaultAlive, nowMs: opts.nowMs ?? Date.now };
    fs.mkdirSync(home, { recursive: true });
    const body: LockBody = { pid, host: os.hostname(), nonce: randomBytes(8).toString('hex'), startedAt: new Date().toISOString() };

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const fd = fs.openSync(file, 'wx');
            try { fs.writeSync(fd, JSON.stringify(body)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            return makeHandle(file, body.nonce, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        const { stale, body: seen } = isStale(file, staleOpts);
        if (!stale) return null;
        // Take over atomically: only one process can rename the file away. If what we moved aside is not the
        // lock we judged stale (a live holder created a fresh one in between), put it back and report busy.
        const tomb = `${file}.stale.${process.pid}.${body.nonce}`;
        try { fs.renameSync(file, tomb); } catch { continue; }
        const moved = readBody(tomb);
        if (seen && moved && moved.nonce !== seen.nonce) {
            try { fs.linkSync(tomb, file); } catch { /* someone else already re-created it: fine */ }
            try { fs.unlinkSync(tomb); } catch { /* best-effort */ }
            return null;
        }
        try { fs.unlinkSync(tomb); } catch { /* best-effort */ }
    }
    return null;
}

function makeHandle(file: string, nonce: string, heartbeatMs: number): EraseLock {
    let released = false;
    const timer = setInterval(() => {
        try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* lock lost: release() is still safe */ }
    }, heartbeatMs);
    timer.unref?.();
    return {
        release(): void {
            if (released) return;
            released = true;
            clearInterval(timer);
            // Remove only OUR lock — never one a later holder took over.
            if (readBody(file)?.nonce === nonce) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
        },
    };
}

/** Run `fn` holding the lock; returns `{ ran: false }` without running when another holder has it. */
export async function withEraseLock<T>(home: string, fn: () => Promise<T>, opts: EraseLockOptions = {}): Promise<{ ran: true; value: T } | { ran: false }> {
    const lock = tryAcquireEraseLock(home, opts);
    if (!lock) return { ran: false };
    try { return { ran: true, value: await fn() }; } finally { lock.release(); }
}

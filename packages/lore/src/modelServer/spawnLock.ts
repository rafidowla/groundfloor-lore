/**
 * modelServer/spawnLock.ts — Lore 3.24 review blocker A. The single-server
 * invariant for one key: who may spawn a server, which spawned server may
 * run, and whose files a process may delete.
 *
 * `server.lock` (paths.ts `lockPath`) always holds ONE pid:
 *   - the spawning host's pid, from the moment it wins the spawn race until
 *     the server it spawned claims the lock;
 *   - the server's own pid for the server's whole lifetime.
 * A lock naming a LIVE pid is conclusive — it is never stolen, whatever its
 * age. Only a lock naming a dead pid is stale. The D9 §5.4 "stale after 15s"
 * age rule survives only as a fallback for an empty/unreadable lock (an
 * older build wrote the lock empty, or a writer died mid-write), and even
 * then only when the pidfile does not name a live server.
 *
 * Every read-modify-write of the lock happens inside `withGuard`, a tiny
 * O_EXCL mutex (`server.lock.guard`) held only across a synchronous
 * critical section. Without it, two processes that both see the same dead
 * pid would both "steal" the lock, the second deleting the first's fresh
 * claim — exactly the orphaned-second-server bug the review found.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockPath, lockGuardPath, pidPath, buildServerEnv } from './paths.js';

/** D9 §5.4's "stale after 15s", applied ONLY to a lock whose content names
 *  no pid (see the file header) — a lock naming a live pid is never stale. */
export const EMPTY_LOCK_STALE_MS = 15_000;
/** A guard file is held for microseconds (a synchronous critical section),
 *  so one naming a live pid is waited for, never stolen; one with no
 *  readable pid is treated as abandoned after this long. */
const EMPTY_GUARD_STALE_MS = 5_000;
/** Give up acquiring the guard after this long — callers treat that as
 *  "someone else is busy with the lock" (a client polls, a server yields). */
const GUARD_WAIT_MS = 3_000;

/** True if `pid` names a live process. `kill(pid, 0)` sends nothing; ESRCH
 *  means gone, EPERM means it exists under another uid (still alive). Any
 *  other error is "can't tell, assume alive" so a probe glitch never
 *  triggers an over-eager steal. */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

/** Parse a pid file / lock file. Returns null for missing, empty or junk. */
export function readPidFile(file: string): number | null {
    try {
        const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
        return null;
    }
}

/** Atomically replace `file` with `pid` (tmp + rename), so a reader never
 *  sees a half-written lock. */
function writePidAtomic(file: string, pid: number): void {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, String(pid), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

function ageMs(file: string): number {
    try {
        return Date.now() - fs.statSync(file).mtimeMs;
    } catch {
        return Infinity;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Run `fn` (synchronous) while holding the guard. Returns `undefined` if
 *  the guard could not be acquired within GUARD_WAIT_MS. */
async function withGuard<T>(guard: string, fn: () => T): Promise<T | undefined> {
    const until = Date.now() + GUARD_WAIT_MS;
    for (;;) {
        try {
            fs.writeFileSync(guard, String(process.pid), { flag: 'wx', mode: 0o600 });
            try {
                return fn();
            } finally {
                try { fs.rmSync(guard, { force: true }); } catch { /* best effort */ }
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        const holder = readPidFile(guard);
        if (holder !== null ? !isPidAlive(holder) : ageMs(guard) > EMPTY_GUARD_STALE_MS) {
            // The holder died inside its critical section — the only way a
            // guard is left behind. Re-check right before removing to keep
            // the window for deleting a fresh guard as small as possible.
            if (readPidFile(guard) === holder) {
                try { fs.rmSync(guard, { force: true }); } catch { /* best effort */ }
            }
            continue;
        }
        if (Date.now() >= until) return undefined;
        await sleep(5 + Math.floor(Math.random() * 15));
    }
}

/** Is the current lock content stale, i.e. may it be replaced? Caller holds
 *  the guard. `self` (and `alsoMine`) never count as stale-able owners —
 *  the caller decides separately what a lock naming them means. */
function lockIsStale(loreHome: string, key: string, lock: string): boolean {
    const owner = readPidFile(lock);
    if (owner !== null) return !isPidAlive(owner);
    // Empty or unreadable lock: no owner to ask. A live server named by the
    // pidfile keeps it; otherwise it's stale once it's older than any
    // legitimate spawn could take.
    const serverPid = readPidFile(pidPath(loreHome, key));
    if (serverPid !== null) return !isPidAlive(serverPid);
    return ageMs(lock) > EMPTY_LOCK_STALE_MS;
}

/**
 * Client side: try to win the right to spawn a server. True means the lock
 * now names `process.pid` and the caller must spawn. False means someone
 * live holds it (a spawning host, or the server itself) — poll the socket.
 */
export async function tryAcquireSpawnLock(loreHome: string, key: string): Promise<boolean> {
    const lock = lockPath(loreHome, key);
    const won = await withGuard(lockGuardPath(loreHome, key), () => {
        if (fs.existsSync(lock)) {
            // Our own pid (another client in this process is mid-spawn)
            // is live and therefore never stale — no double spawn.
            if (!lockIsStale(loreHome, key, lock)) return false;
        }
        writePidAtomic(lock, process.pid);
        return true;
    });
    return won === true;
}

/** Remove the lock iff it still names `pid`. Used by a spawner whose server
 *  never came up, and by a server on its way out. */
export async function releaseLockIfOwned(loreHome: string, key: string, pid: number = process.pid): Promise<void> {
    const lock = lockPath(loreHome, key);
    await withGuard(lockGuardPath(loreHome, key), () => {
        if (readPidFile(lock) === pid) fs.rmSync(lock, { force: true });
    });
}

/**
 * Server side: claim the lock for this server process. Returns null on
 * success, or the reason this server must yield (exit 0 without touching
 * any file) because another live process owns the key.
 *   - absent lock → claim;
 *   - lock names this process or its parent (the host that spawned it) →
 *     rewrite with our own pid;
 *   - lock names any other live pid → yield;
 *   - lock is stale (dead pid, or empty and stale per `lockIsStale`) → claim.
 */
export async function serverClaimLock(loreHome: string, key: string): Promise<string | null> {
    const lock = lockPath(loreHome, key);
    const result = await withGuard(lockGuardPath(loreHome, key), (): string | null => {
        const owner = readPidFile(lock);
        const mine = owner === process.pid || (owner !== null && owner === process.ppid);
        if (fs.existsSync(lock) && !mine && !lockIsStale(loreHome, key, lock)) {
            return owner !== null ? `lock held by live pid ${owner}` : 'lock held by a live server (empty lock)';
        }
        writePidAtomic(lock, process.pid);
        return null;
    });
    return result === undefined ? 'could not acquire the lock guard' : result;
}

const SELF = fileURLToPath(import.meta.url);
/** Sibling entry point, with THIS module's own extension: `main.js` from the
 *  compiled `dist/` a host installs, `main.ts` under tsx (dev/tests) — the
 *  same rule verbatimSearchWorkerProxy.ts uses for its fork entry. */
const MAIN_ENTRY = path.join(path.dirname(SELF), 'main' + path.extname(SELF));
/** Node flags for the child. Under tsx the loader flags in `execArgv` are
 *  what let a plain `process.execPath` child load `main.ts`. From compiled
 *  JS none are needed, and inheriting the FIRST host's flags (`--inspect`,
 *  heap limits) into a process every host shares would be wrong. */
const CHILD_EXEC_ARGV = path.extname(SELF) === '.ts' ? process.execArgv : [];

/** Spawn a detached model-server child with ONLY the vars in
 *  `SERVER_ENV_ALLOWLIST` (paths.ts `buildServerEnv`). `LORE_HOME` is
 *  force-set to the machine-level home the client keyed the server on, so
 *  the server's `<LORE_HOME>/models` cache is the one every host shares.
 *  The child is direct (no wrapper re-exec), so its parent pid is this
 *  process — which is what lets `serverClaimLock` recognise the lock this
 *  process wrote as its spawner's. */
export function spawnServerChild(loreHome: string): void {
    const child = spawn(process.execPath, [...CHILD_EXEC_ARGV, MAIN_ENTRY], {
        env: buildServerEnv(loreHome, process.env),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    // Detached, shared and meant to outlive this host: a spawn failure
    // surfaces only through the caller's readiness poll timing out.
    child.once('error', () => { /* surfaced via the readiness poll */ });
    child.unref();
}

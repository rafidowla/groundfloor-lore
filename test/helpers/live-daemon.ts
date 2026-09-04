/**
 * test/helpers/live-daemon.ts — shared spawn/poll helpers for live-daemon E2E
 * suites (mvp-live, mvp-crash-recovery, mvp-scale). Boots the real daemon as a
 * subprocess with an ISOLATED HOME on a free port via `--http`, mirroring the
 * pattern from e2e-q2-1-server-mode.ts. Nothing here touches :3847 or the
 * operator's real ~/.groundfloor.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'packages/lore/src/mcp/server.ts');

export interface DaemonHandle {
    proc: ChildProcessWithoutNullStreams;
    home: string;
    port: number;
    token: string;
    log: { text: string };
}

export function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object') { const p = addr.port; srv.close(() => resolve(p)); }
            else { srv.close(() => reject(new Error('no free port'))); }
        });
    });
}

export async function waitForReady(port: number, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 150));
    }
    return false;
}

/**
 * Spawn a daemon. Pass `home` to REUSE a data dir (e.g. restart after a crash);
 * omit it for a fresh isolated dir. Pass `port` to pin one; omit for a free port.
 */
export async function spawnDaemon(opts: { home?: string; port?: number } = {}): Promise<DaemonHandle> {
    const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lore-live-e2e-'));
    const port = opts.port ?? await findFreePort();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), LORE_PORT: String(port) };
    // Spawn the daemon with THIS test runner's own Node (process.execPath) + the
    // tsx loader (`--import tsx` runs the .ts source directly, no build step). Using
    // the same Node the tests run under keeps the prebuilt native addons (the legacy graph engine /
    // LanceDB / better-sqlite3) matched to the runtime — an `npx` wrapper can
    // resolve a different Node (e.g. a second nvm version) and hit a
    // NODE_MODULE_VERSION mismatch. detached:true puts the child in its own process
    // GROUP so killDaemon() can signal the whole group (no orphaned daemon holding
    // the legacy engine's on-disk lock across a restart).
    const proc = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY, '--http'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const log = { text: '' };
    proc.stdout.on('data', (c) => { log.text += c.toString(); });
    proc.stderr.on('data', (c) => { log.text += c.toString(); });
    return { proc, home, port, token: '', log };
}

export async function fetchAuthToken(port: number, home: string): Promise<string> {
    // The bootstrap route requires the one-time nonce the daemon minted at
    // boot (security/authToken.ts's ensureBootstrapNonce) — same trust
    // tier as reading auth.token directly, since spawnDaemon sets HOME to
    // this test's isolated dir and no LORE_HOME override, so the daemon's
    // default dataHome resolves to `<home>/.groundfloor`.
    const noncePath = path.join(home, '.groundfloor', 'bootstrap.nonce');
    const nonce = fs.readFileSync(noncePath, 'utf-8').trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/bootstrap?nonce=${encodeURIComponent(nonce)}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    if (!res.ok) throw new Error(`bootstrap failed ${res.status}`);
    return (await res.json() as { token: string }).token;
}

/** Signal the daemon's whole process GROUP (npx → tsx → node). Falls back to a
 *  direct kill if the group send fails. Returns a promise that resolves when the
 *  child has actually exited (or after `waitMs`). */
export async function killDaemon(h: DaemonHandle, signal: NodeJS.Signals = 'SIGKILL', waitMs = 8000): Promise<void> {
    const exited = new Promise<void>((res) => h.proc.once('exit', () => res()));
    try {
        if (h.proc.pid) process.kill(-h.proc.pid, signal); // negative pid = process group
        else h.proc.kill(signal);
    } catch {
        try { h.proc.kill(signal); } catch { /* already gone */ }
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, waitMs))]);
}

/** Kill the daemon group and (optionally) remove its home. */
export function cleanup(h: DaemonHandle | null, opts: { removeHome?: boolean } = { removeHome: true }): void {
    if (!h) return;
    try { if (h.proc.pid) process.kill(-h.proc.pid, 'SIGKILL'); else h.proc.kill('SIGKILL'); }
    catch { try { h.proc.kill('SIGKILL'); } catch { /* noop */ } }
    if (opts.removeHome !== false) { try { fs.rmSync(h.home, { recursive: true, force: true }); } catch { /* noop */ } }
}

/**
 * test/helpers/readiness335.ts - shared plumbing for the 3.35.0 production-readiness e2e suites
 * (test/readiness335-*.ts). Thin wrappers over live-daemon.ts: boot a real daemon on an isolated
 * HOME + free port, talk to it over its public REST surface, read its on-disk files.
 * Nothing here touches :3847 or the operator's real ~/.groundfloor (the daemon env is built
 * explicitly by spawnDaemon: HOME is always a fresh temp dir).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnDaemon, waitForReady, fetchAuthToken, killDaemon, type DaemonHandle } from './live-daemon.js';

export interface ApiResult { status: number; text: string; body: any; headers: Headers }
export interface Api {
    base: string;
    get(p: string, auth?: boolean): Promise<ApiResult>;
    post(p: string, body: unknown): Promise<ApiResult>;
}

export function apiFor(h: DaemonHandle): Api {
    const base = `http://127.0.0.1:${h.port}`;
    const hdr = (): Record<string, string> => ({ Authorization: `Bearer ${h.token}`, Origin: base });
    const wrap = async (r: Response): Promise<ApiResult> => {
        const text = await r.text();
        let body: any = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, text, body, headers: r.headers };
    };
    return {
        base,
        get: async (p, auth = true) => wrap(await fetch(`${base}${p}`, { headers: auth ? hdr() : { Origin: base } })),
        post: async (p, body) => wrap(await fetch(`${base}${p}`, { method: 'POST', headers: { ...hdr(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })),
    };
}

/** Spawn, wait for /health, bootstrap a token. Throws with the daemon log on failure. */
export async function bootDaemon(opts: Parameters<typeof spawnDaemon>[0] = {}, readyMs = 60_000): Promise<DaemonHandle> {
    const h = await spawnDaemon(opts);
    if (!(await waitForReady(h.port, readyMs))) {
        await killDaemon(h, 'SIGKILL');
        throw new Error(`daemon never became ready\n${h.log.text.slice(-3000)}`);
    }
    h.token = await fetchAuthToken(h.port, h.home);
    return h;
}

/** Stop a daemon and wait until its process group is gone (so the next boot on the same home is clean). */
export async function stopDaemon(h: DaemonHandle, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    await killDaemon(h, signal, 15_000);
    // The group leader exiting does not prove the model-server child etc. released the home; give it a beat.
    await new Promise((r) => setTimeout(r, 1500));
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, label: string, stepMs = 250): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`);
        await new Promise((r) => setTimeout(r, stepMs));
    }
}

/** Poll /api/health until the outbox depth is 0. Returns the final health body. */
export async function waitOutboxDrained(api: Api, timeoutMs = 60_000): Promise<any> {
    return waitFor(async () => {
        const r = await api.get('/api/health');
        const depth = r.body?.outbox?.depth;
        return r.status === 200 && depth === 0 ? r.body : null;
    }, timeoutMs, 'outbox depth 0');
}

/** All regular files under a dir (relative paths), for "which engine's files exist" assertions. */
export function listFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full); else out.push(path.relative(dir, full));
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
}

export function makeChecker(title: string): { check: (label: string, ok: boolean, detail?: string) => void; finish: () => never } {
    let pass = 0, fail = 0;
    console.log(title);
    return {
        check(label, ok, detail) {
            if (ok) { pass++; console.log(`  [PASS] ${label}`); } else { fail++; console.error(`  [FAIL] ${label}${detail ? ` - ${detail}` : ''}`); }
        },
        finish() {
            console.log(`\n${pass} passed, ${fail} failed`);
            process.exit(fail > 0 ? 1 : 0);
        },
    };
}

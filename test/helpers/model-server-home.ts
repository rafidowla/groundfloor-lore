/**
 * test/helpers/model-server-home.ts — shared teardown for model-server tests
 * (Lore 3.24 D1). A test that removes a LORE_HOME while a server it caused
 * is still running races that server's log writes (the ENOTEMPTY rmdir
 * `<home>/logs` flake). Every model-server test must stop the servers it
 * caused BEFORE `rmSync(home)` — `removeHome` does both.
 *
 * Which pids: every server that ever started for this home logs
 * `model server starting {"pid":N}` into `<home>/logs/model-server.log`, and
 * the live one is named by its pidfile. A pid is signalled only if it is
 * still alive AND its command line is a model-server entry point — so a
 * long-dead pid the OS has since reused for something else is never hit.
 */

import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { serverKey, pidPath, logPath } from '../../packages/lore/src/modelServer/paths.js';

function pidsFromLog(home: string, message: string): number[] {
    let text = '';
    try { text = fs.readFileSync(logPath(home), 'utf8'); } catch { return []; }
    const out: number[] = [];
    for (const line of text.split('\n')) {
        if (!line.includes(`[model-server] ${message}`)) continue;
        const m = /"pid":(\d+)/.exec(line);
        if (m) out.push(Number(m[1]));
    }
    return out;
}

/** Pids of every server process that started for `home` (from its log). */
export function startedServerPids(home: string): number[] {
    return [...new Set(pidsFromLog(home, 'model server starting'))];
}

/** Pids of every server that reached `listen()` for `home` (from its log). */
export function listeningServerPids(home: string): number[] {
    return pidsFromLog(home, 'model server listening');
}

export function readServerPidFile(home: string): number | null {
    try {
        const n = parseInt(fs.readFileSync(pidPath(home, serverKey(home)), 'utf8').trim(), 10);
        return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
        return null;
    }
}

/** Alive and not a zombie. */
export function isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
    const res = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)]);
    const stat = res.stdout.toString().trim();
    return stat.length > 0 && !stat.startsWith('Z');
}

function isModelServerProcess(pid: number): boolean {
    const res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)]);
    return /modelServer[/\\]main\.(ts|js)|wedged-model-server/.test(res.stdout.toString());
}

export async function waitForProcessExit(pid: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (isProcessAlive(pid)) {
        if (Date.now() >= until) return false;
        await new Promise((r) => setTimeout(r, 50));
    }
    return true;
}

/** SIGTERM every live server this home caused, wait for exit, SIGKILL any
 *  straggler. Returns the pids it had to signal. */
export async function stopServersForHome(home: string, extraPids: number[] = []): Promise<number[]> {
    const own = readServerPidFile(home);
    const candidates = new Set<number>([...startedServerPids(home), ...extraPids, ...(own ? [own] : [])]);
    const live = [...candidates].filter((pid) => pid !== process.pid && isProcessAlive(pid) && isModelServerProcess(pid));
    for (const pid of live) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    for (const pid of live) {
        if (await waitForProcessExit(pid, 8_000)) continue;
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        await waitForProcessExit(pid, 3_000);
    }
    return live;
}

/** Stop the home's servers, then remove it. */
export async function removeHome(home: string, extraPids: number[] = []): Promise<void> {
    await stopServersForHome(home, extraPids);
    fs.rmSync(home, { recursive: true, force: true });
}

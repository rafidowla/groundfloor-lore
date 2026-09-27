#!/usr/bin/env tsx
/**
 * model-server-spawn-race-unit.ts — Lore 3.24 D1, review blocker A: only one
 * shared model server may ever run per key, and no server may delete another
 * server's files.
 *
 *  1. kill -9 a live server, then 4 separate client PROCESSES enter
 *     spawnOrConnect at the same instant: exactly one new server ever
 *     reaches listen(), every other server that started has exited, all
 *     clients end `shared` on that one pid, and its files are intact.
 *  2. 3 servers started at the same instant on a stale home (lock naming a
 *     dead pid, and separately a lock naming their common parent): one
 *     wins, the others exit 0 without touching its files.
 *  3. A live server's lock backdated past 15s is not stolen — by a client
 *     or by a newly started server.
 *  4. gracefulClose removes pid/token/lock only when they name itself.
 *  5. Every path is built from realpath(home): a symlinked home and the
 *     real one share one run dir, one key and one server.
 *  6. SF5: a run dir that is a symlink, or has group/other bits, makes the
 *     client fall back loudly (nothing spawned) and the server refuse to
 *     start.
 *
 * Run: npx tsx test/model-server-spawn-race-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ModelServerClient, ModelServerUnavailableError } from '../packages/lore/src/modelServer/client.js';
import { serverKey, runDir, socketPath, tokenPath, pidPath, lockPath, logPath, buildServerEnv } from '../packages/lore/src/modelServer/paths.js';
import { tryAcquireSpawnLock } from '../packages/lore/src/modelServer/spawnLock.js';
import {
    removeHome, startedServerPids, listeningServerPids, readServerPidFile, isProcessAlive, waitForProcessExit,
} from './helpers/model-server-home.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const CHILD = path.join(here, 'helpers', 'model-server-race-client-child.ts');
const MAIN = path.join(repoRoot, 'packages', 'lore', 'src', 'modelServer', 'main.ts');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

const GENEROUS = { readyMs: 25_000, restartBudgetMs: 20_000, maxRestarts: 5, callMs: 30_000, probeMs: 1000 };
const mkHome = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-race-${tag}-`));
const readPid = (file: string): number | null => {
    try { const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); return Number.isInteger(n) ? n : null; } catch { return null; }
};

/** Connect a client (no model load) and return the server pid it is on. */
async function connectOnce(home: string, tag: string): Promise<{ client: ModelServerClient; pid: number }> {
    const client = new ModelServerClient({ loreHome: home, clientId: `race-${tag}`, ...GENEROUS });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => client.rerank({ modelId: 'unused', cacheDir: '', query: 'q', passages: ['p'] }, ac.signal), { name: 'AbortError' });
    const pid = client.status().server?.pid;
    assert.ok(pid, 'client must report a server pid');
    return { client, pid };
}

/** Start a server via one client, then kill -9 it, leaving stale files. */
async function startAndKill(home: string): Promise<number> {
    const { client, pid } = await connectOnce(home, 'boot');
    await client.dispose();
    process.kill(pid, 'SIGKILL');
    assert.ok(await waitForProcessExit(pid, 5_000), 'killed server must exit');
    const key = serverKey(home);
    assert.equal(readPid(pidPath(home, key)), pid, 'stale pidfile left behind');
    assert.equal(readPid(lockPath(home, key)), pid, 'stale lock left behind');
    return pid;
}

function runChild(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [...process.execArgv, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
}

async function assertOnlyWinnerLives(home: string, winner: number, before: number[]): Promise<void> {
    const listeners = listeningServerPids(home).filter((p) => !before.includes(p));
    assert.deepEqual(listeners, [winner], `exactly one server may reach listen() (got ${JSON.stringify(listeners)})`);
    for (const pid of startedServerPids(home)) {
        if (pid === winner) continue;
        assert.ok(await waitForProcessExit(pid, 10_000), `losing server ${pid} must have exited (no orphan)`);
    }
    const key = serverKey(home);
    assert.ok(isProcessAlive(winner), 'winner must still be running');
    assert.equal(readPid(pidPath(home, key)), winner, "winner's pidfile intact");
    assert.equal(readPid(lockPath(home, key)), winner, "winner's lock intact");
    assert.ok(fs.existsSync(tokenPath(home, key)), "winner's token intact");
    assert.ok(fs.existsSync(socketPath(home, key)), "winner's socket intact");
    const { client, pid } = await connectOnce(home, 'after');
    await client.dispose();
    assert.equal(pid, winner, 'a new client must reach the winner');
}

console.log('model-server spawn race — one server per key, nobody deletes a peer\'s files\n');

await test('kill -9, then 4 client processes spawnOrConnect at the same instant: one server, all shared, no orphan', async () => {
    const home = mkHome('clients');
    try {
        const dead = await startAndKill(home);
        const before = listeningServerPids(home);
        const goAt = Date.now() + 3_000; // lets every child finish booting tsx first
        const results = await Promise.all([0, 1, 2, 3].map(() => runChild([CHILD, home, String(goAt)])));
        const parsed = results.map((r) => {
            assert.equal(r.code, 0, `client child failed: ${r.out}`);
            return JSON.parse(r.out.trim().split('\n').pop()!) as { mode: string; pid: number | null; late: number };
        });
        for (const p of parsed) assert.equal(p.mode, 'shared', `every client must end shared: ${JSON.stringify(parsed)}`);
        const pids = new Set(parsed.map((p) => p.pid));
        assert.equal(pids.size, 1, `all clients must share ONE server pid: ${JSON.stringify(parsed)}`);
        const winner = [...pids][0]!;
        assert.notEqual(winner, dead);
        await assertOnlyWinnerLives(home, winner, before);
    } finally {
        await removeHome(home);
    }
});

for (const variant of ['dead-pid lock', 'lock naming their common parent'] as const) {
    await test(`3 servers started at the same instant on a stale home (${variant}): one wins, the others exit 0 and leave its files alone`, async () => {
        const home = mkHome('servers');
        try {
            await startAndKill(home);
            if (variant !== 'dead-pid lock') fs.writeFileSync(lockPath(home, serverKey(home)), String(process.pid));
            const before = listeningServerPids(home);
            const env = buildServerEnv(home, process.env);
            const codes = await Promise.all([0, 1, 2].map(async () => {
                const child = spawn(process.execPath, [...process.execArgv, MAIN], { env, stdio: 'ignore' });
                return new Promise<{ pid: number; code: number | null }>((resolve) => {
                    let done = false;
                    child.on('exit', (code) => { done = true; resolve({ pid: child.pid!, code }); });
                    // the winner keeps running — resolve it once it listens
                    const poll = setInterval(() => {
                        if (done) { clearInterval(poll); return; }
                        if (readServerPidFile(home) === child.pid) { clearInterval(poll); resolve({ pid: child.pid!, code: null }); }
                    }, 50);
                });
            }));
            const running = codes.filter((c) => c.code === null);
            assert.equal(running.length, 1, `exactly one server must keep running: ${JSON.stringify(codes)}`);
            for (const c of codes) if (c.code !== null) assert.equal(c.code, 0, `a losing server must exit 0: ${JSON.stringify(codes)}`);
            await assertOnlyWinnerLives(home, running[0].pid, before);
        } finally {
            await removeHome(home);
        }
    });
}

await test('a LIVE server\'s lock backdated past 15s is never stolen (client or server)', async () => {
    const home = mkHome('old-lock');
    try {
        const { client, pid } = await connectOnce(home, 'live');
        await client.dispose();
        const key = serverKey(home);
        const lock = lockPath(home, key);
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, old, old);
        assert.equal(await tryAcquireSpawnLock(home, key), false, 'a client must not steal a live server\'s old lock');
        const res = await runChild([MAIN], buildServerEnv(home, process.env));
        assert.equal(res.code, 0, "a second server must yield with exit 0");
        await assertOnlyWinnerLives(home, pid, []);
    } finally {
        await removeHome(home);
    }
});

await test('gracefulClose removes pid/token/lock only when they name itself', async () => {
    const home = mkHome('close-own');
    try {
        const { client, pid } = await connectOnce(home, 'close');
        await client.dispose();
        const key = serverKey(home);
        // Pretend a successor owns the key: files name someone else.
        fs.writeFileSync(pidPath(home, key), String(process.pid));
        fs.writeFileSync(lockPath(home, key), String(process.pid));
        process.kill(pid, 'SIGTERM');
        assert.ok(await waitForProcessExit(pid, 10_000), 'server must exit on SIGTERM');
        assert.equal(readPid(pidPath(home, key)), process.pid, 'pidfile naming another pid must survive');
        assert.equal(readPid(lockPath(home, key)), process.pid, 'lock naming another pid must survive');
        assert.ok(fs.existsSync(tokenPath(home, key)), 'token must survive when the pidfile is not ours');

        // And the normal case: its own files are removed.
        fs.rmSync(pidPath(home, key), { force: true });
        fs.rmSync(lockPath(home, key), { force: true });
        const second = await connectOnce(home, 'close2');
        await second.client.dispose();
        process.kill(second.pid, 'SIGTERM');
        assert.ok(await waitForProcessExit(second.pid, 10_000));
        for (const f of [pidPath(home, key), lockPath(home, key), tokenPath(home, key), socketPath(home, key)]) {
            assert.ok(!fs.existsSync(f), `own file must be removed on close: ${f}`);
        }
    } finally {
        await removeHome(home);
    }
});

await test('realpath(home): a symlinked home shares the real home\'s key, run dir and server', async () => {
    const home = mkHome('realpath');
    const link = `${home}-link`;
    fs.symlinkSync(home, link);
    try {
        const real = fs.realpathSync(home);
        assert.equal(serverKey(link), serverKey(real));
        assert.equal(runDir(link, serverKey(link)), runDir(real, serverKey(real)));
        assert.ok(runDir(link, serverKey(link)).startsWith(real), 'run dir must be built from the realpath');
        const a = await connectOnce(link, 'via-link');
        const b = await connectOnce(real, 'via-real');
        await Promise.all([a.client.dispose(), b.client.dispose()]);
        assert.equal(a.pid, b.pid, 'both spellings must reach one server');
    } finally {
        fs.rmSync(link, { force: true });
        await removeHome(home);
    }
});

for (const kind of ['symlink', 'group/other bits'] as const) {
    await test(`SF5: a run dir with ${kind} → client falls back loudly without spawning; server refuses to start`, async () => {
        const home = mkHome('unsafe');
        try {
            const key = serverKey(home);
            const dir = runDir(home, key);
            fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
            if (kind === 'symlink') {
                const target = path.join(home, 'elsewhere');
                fs.mkdirSync(target, { mode: 0o700 });
                fs.symlinkSync(target, dir);
            } else {
                fs.mkdirSync(dir, { mode: 0o700 });
                fs.chmodSync(dir, 0o755);
            }
            const errors: string[] = [];
            const client = new ModelServerClient({ loreHome: home, clientId: 'unsafe', ...GENEROUS, log: { error: (m) => errors.push(m), warn: () => {} } });
            const ac = new AbortController();
            ac.abort();
            const started = Date.now();
            await assert.rejects(() => client.rerank({ modelId: 'unused', cacheDir: '', query: 'q', passages: ['p'] }, ac.signal), ModelServerUnavailableError);
            assert.ok(Date.now() - started < 2_000, 'an unsafe dir is permanent — no retry loop');
            const st = client.status();
            await client.dispose();
            assert.equal(st.mode, 'fallback');
            assert.match(st.reason ?? '', /unsafe model-server directory/);
            assert.ok(errors.some((m) => m.includes('falling back') && m.includes('unsafe')), 'fallback must be loud with a clear reason');
            assert.equal(startedServerPids(home).length, 0, 'nothing may be spawned');

            const res = await runChild([MAIN], buildServerEnv(home, process.env));
            assert.equal(res.code, 1, 'the server must refuse to start');
            assert.match(fs.readFileSync(logPath(home), 'utf8'), /refusing to start: unsafe model-server directory/);
        } finally {
            await removeHome(home);
        }
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env tsx
/**
 * model-server-cli-unit.ts — D9 (3.24 slice C2b) CLI coverage for
 * `lore models server status` / `lore models server stop`.
 *
 * Spawns the real CLI (`cli/index.ts` via tsx, same as `model-server-*`
 * lifecycle tests spawn the real server via `modelServer/main.ts`) as a
 * subprocess against an isolated temp `LORE_HOME`, so this exercises the
 * command exactly as an operator would run it — real argv parsing, real
 * `process.exit()` codes, real stdout — rather than mocking `process.exit`
 * to call the command function in-process.
 *
 * No network. Every scenario cleans up its own child processes and temp
 * dir; the "server up" scenarios reap the spawned server via SIGTERM (with
 * a SIGKILL fallback for a wedged process only), never by pattern-matching
 * `pkill`/`killall`.
 *
 * Run: npx tsx test/model-server-cli-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serverKey, socketPath } from '../packages/lore/src/modelServer/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const mainTsPath = path.join(repoRoot, 'packages', 'lore', 'src', 'modelServer', 'main.ts');
const cliIndexPath = path.join(repoRoot, 'packages', 'lore', 'src', 'cli', 'index.ts');


let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

let homeCounter = 0;
function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-cli-${tag}-${homeCounter++}-`));
}

function spawnServer(loreHome: string): ChildProcess {
    return spawn(tsxBin, [mainTsPath], {
        env: { ...process.env, LORE_HOME: loreHome },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function runCli(loreHome: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
    const res = spawnSync(tsxBin, [cliIndexPath, ...args], {
        env: { ...process.env, LORE_HOME: loreHome },
        encoding: 'utf8',
        timeout: 20000,
    });
    return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function waitForListening(sockPath: string, timeoutMs = 15000): Promise<void> {
    const net = await import('node:net');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (fs.existsSync(sockPath)) {
            const ok = await new Promise<boolean>((resolve) => {
                const s = net.createConnection(sockPath);
                s.once('connect', () => { s.destroy(); resolve(true); });
                s.once('error', () => resolve(false));
            });
            if (ok) return;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${sockPath} to accept connections`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

/** SIGTERM a child, wait for exit, SIGKILL only if it doesn't die — this
 *  targets the exact `ChildProcess` this file spawned, never a pattern
 *  match against process names/ports. */
async function reapChild(child: ChildProcess, timeoutMs = 10000): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) return;
    if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
    }
    if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    for (let i = 0; i < 20; i++) {
        const res = spawnSync('ps', ['-p', String(pid)]);
        const stillThere = res.status === 0 && res.stdout.toString().includes(String(pid));
        if (!stillThere) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`pid ${pid} still visible in \`ps -p\` after reap attempt`);
}

function rmHome(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log('model-server CLI — `lore models server status`/`stop`, real spawned CLI + server\n');

await test('status: no server running -> "not running", exit 0', async () => {
    const home = mkLoreHome('status-none');
    try {
        const res = runCli(home, ['models', 'server', 'status']);
        assert.equal(res.code, 0, `expected exit 0, got ${res.code}. stderr:\n${res.stderr}`);
        assert.match(res.stdout, /not running/i);
    } finally {
        rmHome(home);
    }
});

await test('status --json: no server running -> {running:false}, exit 0', async () => {
    const home = mkLoreHome('status-none-json');
    try {
        const res = runCli(home, ['models', 'server', 'status', '--json']);
        assert.equal(res.code, 0, `expected exit 0, got ${res.code}. stderr:\n${res.stderr}`);
        const parsed = JSON.parse(res.stdout.trim());
        assert.deepEqual(parsed, { running: false });
    } finally {
        rmHome(home);
    }
});

await test('stop: no server running -> exit 0, message printed', async () => {
    const home = mkLoreHome('stop-none');
    try {
        const res = runCli(home, ['models', 'server', 'stop']);
        assert.equal(res.code, 0, `expected exit 0, got ${res.code}. stderr:\n${res.stderr}`);
        assert.match(res.stdout, /not running/i);
    } finally {
        rmHome(home);
    }
});

await test('status: server running -> reports real pid, and --json parses with the same fields', async () => {
    const home = mkLoreHome('status-live');
    const server = spawnServer(home);
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);

        const human = runCli(home, ['models', 'server', 'status']);
        assert.equal(human.code, 0, `expected exit 0, got ${human.code}. stderr:\n${human.stderr}`);
        assert.match(human.stdout, /running/i);
        assert.match(human.stdout, /PID:/);

        const jsonRes = runCli(home, ['models', 'server', 'status', '--json']);
        assert.equal(jsonRes.code, 0, `expected exit 0, got ${jsonRes.code}. stderr:\n${jsonRes.stderr}`);
        const parsed = JSON.parse(jsonRes.stdout.trim()) as Record<string, unknown>;
        assert.equal(parsed.running, true);
        assert.equal(typeof parsed.pid, 'number');
        assert.equal(typeof parsed.socket, 'string');
        assert.equal(typeof parsed.protocolVersion, 'number');
        assert.equal(typeof parsed.uptimeMs, 'number');
        assert.equal(typeof parsed.clients, 'number');
        assert.equal(typeof parsed.queueDepth, 'number');
        assert.equal(typeof parsed.idleExitMs, 'number');
        assert.ok((parsed.rssBytes as number) > 0, 'rssBytes reported');
        assert.ok(Array.isArray(parsed.models), 'models array reported (empty before any call)');
        assert.match(human.stdout, /Memory \(RSS\):/);
        assert.ok((parsed.pid as number) > 0);
    } finally {
        await reapChild(server);
        rmHome(home);
    }
});

await test('stop: server running -> server process exits and socket file is removed', async () => {
    const home = mkLoreHome('stop-live');
    const server = spawnServer(home);
    let reaped = false;
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);

        const res = runCli(home, ['models', 'server', 'stop']);
        assert.equal(res.code, 0, `expected exit 0, got ${res.code}. stderr:\n${res.stderr}`);
        assert.match(res.stdout, /shutdown/i);

        // The server should exit on its own in response to the protocol
        // message — wait for the child's own 'exit' event (no signal sent
        // by this test) rather than polling the socket, so a false pass
        // can't come from some OTHER process happening to also not be
        // listening on that path.
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('server did not exit on its own after `stop`')),
                10000,
            );
            server.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        reaped = true;
        assert.equal(server.signalCode, null, 'server should have exited via process.exit(0), not a signal');
        assert.equal(fs.existsSync(sock), false, 'socket file should be removed by gracefulClose()');
    } finally {
        if (!reaped) await reapChild(server);
        rmHome(home);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

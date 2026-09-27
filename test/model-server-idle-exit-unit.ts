#!/usr/bin/env tsx
/**
 * model-server-idle-exit-unit.ts — D9 (3.24 slice C1) lifecycle: bootstrap
 * timeout and idle-after-activity exit, both via real spawned servers with
 * short overrides of `LORE_MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS` /
 * `LORE_MODEL_SERVER_IDLE_EXIT_MS` (config.ts) so the test doesn't wait out the
 * real 30s/60s defaults.
 *
 * Two distinct self-exit paths in server.ts, both worth covering because
 * they're armed differently:
 *  - bootstrap timeout: armed unconditionally right after `listen()`,
 *    cleared forever the moment any client ever connects. Covers "nobody
 *    ever showed up".
 *  - idle timeout: NEVER armed at startup (a fresh server with zero
 *    clients does not idle-exit on its own — only the bootstrap timer
 *    covers that case). It only arms via `reconsiderIdle()`, called from
 *    `onClientDisconnect`/`onActivityEnd` — i.e. after there has been at
 *    least one client or one dispatched request. Covers "used, then
 *    abandoned".
 * Both exit through the same `gracefulClose()`, which removes the
 * socket/pidfile/token files before `process.exit(0)` — checked below as
 * part of "the server really is gone", not just "the process died".
 *
 * Run: npx tsx test/model-server-idle-exit-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    FrameDecoder,
    encodeFrame,
    PROTOCOL_VERSION,
    type DecodeEvent,
} from '../packages/lore/src/modelServer/protocol.js';
import { serverKey, socketPath, tokenPath, pidPath } from '../packages/lore/src/modelServer/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const mainTsPath = path.join(repoRoot, 'packages', 'lore', 'src', 'modelServer', 'main.ts');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-idle-exit-${tag}-`));
}

function spawnServer(loreHome: string, extraEnv: Record<string, string>): ChildProcess {
    return spawn(tsxBin, [mainTsPath], {
        env: { ...process.env, LORE_HOME: loreHome, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

async function waitForListening(sockPath: string, timeoutMs = 20000): Promise<void> {
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

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => reject(new Error(`process did not self-exit within ${timeoutMs}ms`)), timeoutMs);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
}

interface WireClient {
    socket: net.Socket;
    send(header: Record<string, unknown>, body?: Buffer): void;
    nextFrame(timeoutMs?: number): Promise<DecodeEvent>;
    close(): void;
}

function connectRaw(sockPath: string): WireClient {
    const socket = net.createConnection(sockPath);
    const decoder = new FrameDecoder();
    const pending: DecodeEvent[] = [];
    const waiters: Array<(ev: DecodeEvent) => void> = [];
    socket.on('data', (chunk) => {
        for (const ev of decoder.push(chunk)) {
            const w = waiters.shift();
            if (w) w(ev);
            else pending.push(ev);
        }
    });
    return {
        socket,
        send(header, body) { socket.write(encodeFrame(header, body)); },
        nextFrame(timeoutMs = 20000) {
            return new Promise((resolve, reject) => {
                const queued = pending.shift();
                if (queued) { resolve(queued); return; }
                const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
                waiters.push((ev) => { clearTimeout(timer); resolve(ev); });
            });
        },
        close() { socket.destroy(); },
    };
}

async function helloOk(client: WireClient, token: string): Promise<void> {
    client.send({ type: 'hello', v: PROTOCOL_VERSION, token, clientId: 'idle-exit-test' });
    const ev = await client.nextFrame();
    assert.equal(ev.kind, 'frame');
    if (ev.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(ev.header, { type: 'helloOk', v: PROTOCOL_VERSION });
}

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
}

console.log('model-server idle/bootstrap exit — real spawned servers, short timeout overrides\n');

await test('bootstrap timeout: a server nobody ever connects to exits on its own and cleans up its files', async () => {
    const home = mkLoreHome('bootstrap');
    const child = spawnServer(home, {
        LORE_MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS: '500',
        // Keep idle huge and irrelevant — this path must be the bootstrap
        // timer, not a coincidental idle-timer firing.
        LORE_MODEL_SERVER_IDLE_EXIT_MS: '3600000',
    });
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        assert.ok(fs.existsSync(pidPath(home, key)), 'sanity: pidfile must exist while the server is up');

        // Deliberately never connect a client.
        await waitForExit(child, 10000);
        assert.equal(child.exitCode, 0, 'bootstrap-timeout exit must be a clean process.exit(0)');

        assert.ok(!fs.existsSync(sock), 'socket file must be removed by gracefulClose()');
        assert.ok(!fs.existsSync(pidPath(home, key)), 'pidfile must be removed by gracefulClose()');
        assert.ok(!fs.existsSync(tokenPath(home, key)), 'token file must be removed by gracefulClose()');
    } finally {
        await reapChild(child);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('idle timeout: a server that has been used and then abandoned exits on its own and cleans up its files', async () => {
    const home = mkLoreHome('idle');
    const child = spawnServer(home, {
        // Generous bootstrap timeout so it never fires in this test — the
        // client below connects well inside it either way.
        LORE_MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS: '30000',
        LORE_MODEL_SERVER_IDLE_EXIT_MS: '500',
    });
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const token = fs.readFileSync(tokenPath(home, key), 'utf8');

        const client = connectRaw(sock);
        await helloOk(client, token);
        // No embed/rerank activity at all — this exercises the pure
        // connect-then-disconnect idle path, not activity-end.
        client.close();

        // The idle timer only arms on disconnect (reconsiderIdle()), then
        // waits the full LORE_MODEL_SERVER_IDLE_EXIT_MS — allow comfortable
        // margin above that for the disconnect + timer + graceful-close
        // sequence.
        await waitForExit(child, 10000);
        assert.equal(child.exitCode, 0, 'idle-timeout exit must be a clean process.exit(0)');

        assert.ok(!fs.existsSync(sock), 'socket file must be removed by gracefulClose()');
        assert.ok(!fs.existsSync(pidPath(home, key)), 'pidfile must be removed by gracefulClose()');
        assert.ok(!fs.existsSync(tokenPath(home, key)), 'token file must be removed by gracefulClose()');
    } finally {
        await reapChild(child);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('idle timeout: a still-connected client keeps the server alive well past the idle window', async () => {
    const home = mkLoreHome('idle-pinned');
    const child = spawnServer(home, {
        LORE_MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS: '30000',
        LORE_MODEL_SERVER_IDLE_EXIT_MS: '500',
    });
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const token = fs.readFileSync(tokenPath(home, key), 'utf8');

        const client = connectRaw(sock);
        await helloOk(client, token);

        // Wait well past the 500ms idle window while still connected.
        await new Promise((r) => setTimeout(r, 1500));

        assert.equal(child.exitCode, null, 'a connected client must prevent idle exit — clients.size > 0 keeps isIdle() false');
        client.send({ type: 'status', id: 'still-alive' });
        const ev = await client.nextFrame(5000);
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        assert.equal((ev.header as Record<string, unknown>).type, 'statusResult');

        client.close();
    } finally {
        await reapChild(child);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

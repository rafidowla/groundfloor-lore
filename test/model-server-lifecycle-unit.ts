#!/usr/bin/env tsx
/**
 * model-server-lifecycle-unit.ts — D9 (3.24 slice C1) server process
 * lifecycle: hello auth/version gating, status/shutdown over the protocol,
 * on-disk file modes, liveness-probe-before-bind (second start against a
 * live socket exits 0 without disrupting the first; a stale socket from a
 * killed process is detected and replaced).
 *
 * Spawns the real `modelServer/main.ts` entry point via `tsx` as a child
 * process, each test against its own isolated `LORE_HOME` temp directory so
 * runs never collide. No mocking of protocol.ts/paths.ts/config.ts — this
 * drives the actual on-wire frame format over a real unix socket.
 *
 * Run: npx tsx test/model-server-lifecycle-unit.ts
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
import { serverKey, runDir, socketPath, tokenPath, pidPath } from '../packages/lore/src/modelServer/paths.js';

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
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-lifecycle-${tag}-`));
}

function spawnServer(loreHome: string, extraEnv: Record<string, string> = {}): ChildProcess {
    return spawn(tsxBin, [mainTsPath], {
        env: { ...process.env, LORE_HOME: loreHome, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** Poll until the socket path exists on disk and accepts a connection, or
 *  time out. Returns once a bare TCP-level connect succeeds (no hello). */
async function waitForListening(sockPath: string, timeoutMs = 15000): Promise<void> {
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

/** Poll until the socket path stops accepting connections (the listening
 *  process has actually died, even though the inode/file may still be on
 *  disk), or time out. Inverse of waitForListening. */
async function waitForNotListening(sockPath: string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const stillListening = await new Promise<boolean>((resolve) => {
            const s = net.createConnection(sockPath);
            s.once('connect', () => { s.destroy(); resolve(true); });
            s.once('error', () => resolve(false));
        });
        if (!stillListening) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${sockPath} to stop accepting connections`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

function readToken(loreHome: string): string {
    const key = serverKey(loreHome);
    return fs.readFileSync(tokenPath(loreHome, key), 'utf8');
}

/** The server's OWN pid, from the pidfile it writes with its own
 *  `process.pid` — NOT the same as the `ChildProcess.pid` returned by
 *  `spawn(tsxBin, ...)` above: tsx v4 re-execs itself as a child node
 *  process for ESM loader-hook isolation, so the spawned wrapper's pid and
 *  the actual server process's pid are consistently one apart (confirmed
 *  by direct repro). The pidfile is the ground truth for "which OS process
 *  is actually serving this key" in every assertion below. */
function readServerPid(loreHome: string): number {
    const key = serverKey(loreHome);
    return parseInt(fs.readFileSync(pidPath(loreHome, key), 'utf8').trim(), 10);
}

interface WireClient {
    socket: net.Socket;
    send(header: Record<string, unknown>, body?: Buffer): void;
    /** Wait for the next decoded frame (any kind), with a timeout. */
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
        send(header, body) {
            socket.write(encodeFrame(header, body));
        },
        nextFrame(timeoutMs = 5000) {
            return new Promise((resolve, reject) => {
                const queued = pending.shift();
                if (queued) { resolve(queued); return; }
                const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
                waiters.push((ev) => { clearTimeout(timer); resolve(ev); });
            });
        },
        close() {
            socket.destroy();
        },
    };
}

async function helloOk(client: WireClient, token: string): Promise<void> {
    client.send({ type: 'hello', v: PROTOCOL_VERSION, token, clientId: 'lifecycle-test' });
    const ev = await client.nextFrame();
    assert.equal(ev.kind, 'frame');
    if (ev.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(ev.header, { type: 'helloOk', v: PROTOCOL_VERSION });
}

/** SIGTERM a child, wait for its 'exit' event (or already-exited), then
 *  double-check via `ps -p` that the pid is truly gone — small per-file
 *  duplicated helper per this repo's no-shared-utils convention. */
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
    // Give the OS a brief moment to actually reap the process table entry.
    for (let i = 0; i < 20; i++) {
        const { spawnSync } = await import('node:child_process');
        const res = spawnSync('ps', ['-p', String(pid)]);
        const stillThere = res.status === 0 && res.stdout.toString().includes(String(pid));
        if (!stillThere) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`pid ${pid} still visible in \`ps -p\` after reap attempt`);
}

console.log('model-server lifecycle — real spawned server, real unix socket\n');

await test('hello: bad token is rejected with helloErr unauthorized, connection closes', async () => {
    const home = mkLoreHome('badtoken');
    const child = spawnServer(home);
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const client = connectRaw(sock);
        client.send({ type: 'hello', v: PROTOCOL_VERSION, token: 'not-the-real-token' });
        const ev = await client.nextFrame();
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        assert.deepEqual(ev.header, { type: 'helloErr', reason: 'unauthorized' });
        await new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
        client.close();
    } finally {
        await reapChild(child);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('hello: bad protocol version is rejected with helloErr bad_version, connection closes', async () => {
    const home = mkLoreHome('badversion');
    const child = spawnServer(home);
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const token = readToken(home);
        const client = connectRaw(sock);
        client.send({ type: 'hello', v: PROTOCOL_VERSION + 999, token });
        const ev = await client.nextFrame();
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        assert.deepEqual(ev.header, { type: 'helloErr', reason: 'bad_version' });
        await new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
        client.close();
    } finally {
        await reapChild(child);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('status: returns a live snapshot with correct pid and protocol version', async () => {
    const home = mkLoreHome('status');
    const child = spawnServer(home);
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const token = readToken(home);
        const client = connectRaw(sock);
        await helloOk(client, token);
        client.send({ type: 'status', id: 'st1' });
        const ev = await client.nextFrame();
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        const h = ev.header as Record<string, unknown>;
        assert.equal(h.type, 'statusResult');
        assert.equal(h.id, 'st1');
        assert.ok((h.rssBytes as number) > 0, 'status carries rssBytes');
        assert.deepEqual(h.models, [], 'no models served before the first call');
        // NOT child.pid — tsx re-execs internally, so the spawn()ed
        // wrapper's pid is not the real server process's pid. The pidfile
        // (written by the server itself from its own process.pid) is the
        // ground truth.
        assert.equal(h.pid, readServerPid(home));
        assert.equal(h.protocolVersion, PROTOCOL_VERSION);
        assert.equal(h.clients, 1);
        assert.equal(typeof h.uptimeMs, 'number');
        assert.ok((h.uptimeMs as number) >= 0);
        client.close();
    } finally {
        await reapChild(child);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('shutdown: valid token stops the server (shutdownOk, then the process actually exits)', async () => {
    const home = mkLoreHome('shutdown');
    const child = spawnServer(home);
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const token = readToken(home);
        const client = connectRaw(sock);
        await helloOk(client, token);
        const exitPromise = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        client.send({ type: 'shutdown', id: 'sd1', token });
        const ev = await client.nextFrame();
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        assert.deepEqual(ev.header, { type: 'shutdownOk', id: 'sd1' });
        await Promise.race([exitPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('process did not exit within 10s of shutdownOk')), 10000))]);
        assert.equal(child.exitCode, 0, 'a graceful shutdown must exit 0');
        client.close();
        // The process already exited on its own — confirm ps agrees (no
        // separate SIGTERM needed, but reapChild is a no-op-safe check).
        await reapChild(child);
        assert.ok(!fs.existsSync(sock), 'socket file must be removed on graceful shutdown');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('shutdown: wrong token is rejected (unauthorized error), server keeps running', async () => {
    const home = mkLoreHome('shutdown-badtoken');
    const child = spawnServer(home);
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const token = readToken(home);
        const client = connectRaw(sock);
        await helloOk(client, token);
        client.send({ type: 'shutdown', id: 'sd2', token: 'wrong-token' });
        const ev = await client.nextFrame();
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        const h = ev.header as Record<string, unknown>;
        assert.equal(h.type, 'error');
        assert.equal(h.name, 'unauthorized');
        // Server must still be up — a follow-up status call should succeed.
        client.send({ type: 'status', id: 'st-after' });
        const ev2 = await client.nextFrame();
        assert.equal(ev2.kind, 'frame');
        if (ev2.kind !== 'frame') throw new Error('unreachable');
        assert.equal((ev2.header as Record<string, unknown>).type, 'statusResult');
        client.close();
    } finally {
        await reapChild(child);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('file modes: run dir 0700, token file 0600, pidfile holds a valid positive pid', async () => {
    const home = mkLoreHome('filemodes');
    const child = spawnServer(home);
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const dir = runDir(home, key);
        const dirMode = fs.statSync(dir).mode & 0o777;
        assert.equal(dirMode, 0o700, `run dir mode was ${dirMode.toString(8)}`);
        const tokMode = fs.statSync(tokenPath(home, key)).mode & 0o777;
        assert.equal(tokMode, 0o600, `token file mode was ${tokMode.toString(8)}`);
        const pidFile = pidPath(home, key);
        assert.ok(fs.existsSync(pidFile));
        const pidContents = fs.readFileSync(pidFile, 'utf8').trim();
        // NOT child.pid — see readServerPid's doc comment. Assert the
        // pidfile holds a well-formed positive integer, and separately
        // cross-check it against a live `status` round-trip's self-reported
        // pid for internal consistency, which is the strongest assertion
        // available without relying on tsx's internal process topology.
        const pidNum = Number(pidContents);
        assert.ok(Number.isInteger(pidNum) && pidNum > 0, `pidfile contents not a valid pid: ${pidContents}`);
        const token = readToken(home);
        const client = connectRaw(sock);
        await helloOk(client, token);
        client.send({ type: 'status', id: 'pid-crosscheck' });
        const ev = await client.nextFrame();
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        assert.equal((ev.header as Record<string, unknown>).pid, pidNum);
        client.close();
    } finally {
        await reapChild(child);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('second server start against a live socket exits 0 immediately and does not disrupt the first', async () => {
    const home = mkLoreHome('second-live');
    const first = spawnServer(home);
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const firstPidFileContents = fs.readFileSync(pidPath(home, key), 'utf8').trim();

        const second = spawnServer(home);
        const secondExit = await new Promise<number | null>((resolve) => {
            second.once('exit', (code) => resolve(code));
        });
        assert.equal(secondExit, 0, 'a second server against an already-listening socket must exit 0');

        // The first server must still be fully functional afterward.
        const token = readToken(home);
        const client = connectRaw(sock);
        await helloOk(client, token);
        client.send({ type: 'status', id: 'still-alive' });
        const ev = await client.nextFrame();
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        // NOT first.pid — see readServerPid's doc comment; compare against
        // the pidfile snapshot captured before the second spawn instead.
        assert.equal((ev.header as Record<string, unknown>).pid, Number(firstPidFileContents));
        client.close();

        // The pidfile must still name the FIRST server's pid — the second
        // process must never have overwritten it.
        assert.equal(fs.readFileSync(pidPath(home, key), 'utf8').trim(), firstPidFileContents);
    } finally {
        await reapChild(first);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('a stale socket (from a killed process) is detected and replaced by a fresh bind', async () => {
    const home = mkLoreHome('stale-socket');
    const first = spawnServer(home);
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        // NOT first.pid — see readServerPid's doc comment; capture the
        // real server's own self-reported pid from its pidfile before
        // killing it, since the file is about to be left behind stale
        // rather than cleaned up (SIGKILL, not a graceful shutdown).
        const firstPid = readServerPid(home);

        // Hard-kill the REAL server process (by its own pid, not
        // `first.pid` / `first.kill()`) so it cannot clean up its own
        // socket/pidfile/token files — this is the "stale socket" scenario,
        // distinct from a graceful shutdown which already removes them.
        // Killing `first` (the tsx wrapper `spawn()` returns) is NOT
        // equivalent: tsx re-execs itself into a child node process that
        // actually runs main.ts, and SIGKILLing only the wrapper leaves
        // that child orphaned and still listening — confirmed by an
        // earlier run of this test, where the "replacement" server's pid
        // came back identical to the pre-kill pid because the original
        // server process was, in fact, never killed.
        try {
            process.kill(firstPid, 'SIGKILL');
        } catch {
            /* already gone */
        }
        await waitForNotListening(sock);
        assert.ok(fs.existsSync(sock), 'sanity: SIGKILL must leave the socket file behind on disk');
        // The wrapper process may or may not notice/exit on its own once
        // its child dies; reap it defensively so it can't leak.
        await reapChild(first).catch(() => { /* best-effort */ });

        const second = spawnServer(home);
        try {
            await waitForListening(sock);
            const token = readToken(home);
            const client = connectRaw(sock);
            await helloOk(client, token);
            client.send({ type: 'status', id: 'after-stale-replace' });
            const ev = await client.nextFrame();
            assert.equal(ev.kind, 'frame');
            if (ev.kind !== 'frame') throw new Error('unreachable');
            const h = ev.header as Record<string, unknown>;
            // NOT second.pid — see readServerPid's doc comment; the second
            // server's own pidfile is ground truth for its real pid.
            assert.equal(h.pid, readServerPid(home));
            assert.notEqual(h.pid, firstPid, 'the replacement server must be a genuinely new process');
            client.close();
        } finally {
            await reapChild(second);
        }
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

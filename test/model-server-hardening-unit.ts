#!/usr/bin/env tsx
/**
 * model-server-hardening-unit.ts — Lore 3.24 slice D2, review-324
 * server-side request hardening fixes:
 *
 *   - SF6:  every `is*` protocol guard rejects array elements of the wrong
 *     type (`texts`/`passages` must be `string[]`), and a bad request from
 *     an authenticated client always comes back as a `bad_request` error
 *     frame — never a thrown error or an unhandled rejection — with the
 *     connection staying alive afterward.
 *   - SF8:  a rerank `cancel` actually reaches `LocalRerankProvider.score()`
 *     via its `AbortSignal`, freeing the concurrency slot promptly — a
 *     later rerank on the cap-1 server is not `busy`.
 *   - Unauthenticated-socket nits: a small pre-auth frame-size ceiling
 *     (oversize frame before hello -> connection closed) and a
 *     per-connection hello deadline (no hello -> connection closed).
 *   - FrameDecoder quadratic-concat fix: a frame split across MANY small
 *     chunks still decodes correctly (protocol.ts's own codec test suite
 *     already covers byte-by-byte splitting; this adds a dedicated case
 *     framed around the fix this slice makes).
 *
 * Two kinds of tests here:
 *   1. Fast, in-process tests that call `attachConnection()` directly
 *      against a bare `net.Server`, with a mock `ConnectionDeps` — no
 *      model files needed, since malformed embed/rerank requests are
 *      rejected by protocol.ts's type guards before any provider is ever
 *      touched.
 *   2. One test that spawns a REAL server process (via main.ts), pointed
 *      at a temp LORE_HOME holding the real rerank model
 *      (`installRerankModel()`, test/helpers/rerank-model-fixture.ts), following the same
 *      send-two-frames-back-to-back-on-one-socket determinism pattern as
 *      test/model-server-rerank-busy-unit.ts.
 *
 * Run: npx tsx test/model-server-hardening-unit.ts
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
    isEmbedMessage,
    isRerankMessage,
    PROTOCOL_VERSION,
    type DecodeEvent,
} from '../packages/lore/src/modelServer/protocol.js';
import { attachConnection, type ConnectionDeps, type StatusSnapshot } from '../packages/lore/src/modelServer/connection.js';
import { EmbedQueue } from '../packages/lore/src/modelServer/queue.js';
import { ModelServerLogger } from '../packages/lore/src/modelServer/log.js';
import { serverKey, socketPath, tokenPath } from '../packages/lore/src/modelServer/paths.js';
import { DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE } from '../packages/lore/src/recall/rerankConfig.js';
import { installRerankModel } from './helpers/rerank-model-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const mainTsPath = path.join(repoRoot, 'packages', 'lore', 'src', 'modelServer', 'main.ts');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

console.log('model-server hardening — review-324 SF6/SF8/pre-auth/FrameDecoder fixes\n');

// ─── Part 1: FrameDecoder quadratic-concat fix + protocol guard tests ──

await test('FrameDecoder: a frame split across many small chunks decodes correctly', async () => {
    const decoder = new FrameDecoder();
    const header = { type: 'result', id: 'chunked', op: 'query', count: 1, dim: 4 };
    const body = Buffer.from(new Float32Array([1, 2, 3, 4]).buffer);
    const whole = encodeFrame(header, body);
    // Split into ~40 pieces of 3 bytes each — "many small chunks", well
    // beyond a couple of TCP segments' worth of splitting.
    const events: DecodeEvent[] = [];
    for (let i = 0; i < whole.length; i += 3) {
        events.push(...decoder.push(whole.subarray(i, Math.min(i + 3, whole.length))));
    }
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'frame');
    if (events[0]!.kind !== 'frame') return;
    assert.deepEqual(events[0]!.header, header);
    assert.ok(events[0]!.body.equals(body));
});

await test('FrameDecoder: setMaxFrameBytes rejects an over-limit frame, then accepts it once raised', async () => {
    const decoder = new FrameDecoder(1024);
    const header = { type: 'hello', v: PROTOCOL_VERSION, token: 'x' };
    const body = Buffer.alloc(2000);
    const buf = encodeFrame(header, body);
    const tooLarge = decoder.push(buf);
    assert.equal(tooLarge.length, 1);
    assert.equal(tooLarge[0]!.kind, 'tooLarge');

    decoder.setMaxFrameBytes(1024 * 1024);
    const ok = decoder.push(encodeFrame(header, body));
    assert.equal(ok.length, 1);
    assert.equal(ok[0]!.kind, 'frame');
});

await test('protocol: isEmbedMessage rejects texts with a non-string element', async () => {
    assert.equal(isEmbedMessage({ type: 'embed', id: 'a', op: 'documentBatch', modelId: 'm', texts: ['ok', 123] }), false);
    assert.equal(isEmbedMessage({ type: 'embed', id: 'a', op: 'documentBatch', modelId: 'm', texts: ['ok', 'also ok'] }), true);
});

await test('protocol: isRerankMessage rejects passages with a null element', async () => {
    const base = { type: 'rerank', id: 'a', modelId: 'm', cacheDir: '/x', query: 'q' };
    assert.equal(isRerankMessage({ ...base, passages: [null, 'ok'] }), false);
    assert.equal(isRerankMessage({ ...base, passages: ['ok', 'also ok'] }), true);
});

// ─── Part 2: connection.ts hardening, via a bare net.Server + attachConnection() ──

interface WireClient {
    socket: net.Socket;
    send(header: Record<string, unknown>, body?: Buffer): void;
    nextFrame(timeoutMs?: number): Promise<DecodeEvent>;
    close(): void;
}

function connectRaw(port: number): WireClient {
    const socket = net.createConnection(port, '127.0.0.1');
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
        nextFrame(timeoutMs = 15000) {
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

interface MockServer {
    port: number;
    token: string;
    close(): Promise<void>;
}

/** Start a bare net.Server that wires every connection straight into
 *  `attachConnection()` with a minimal mock `ConnectionDeps` — no
 *  model-server process, no model files. `helloDeadlineMs` lets the
 *  hello-deadline test use a short deadline instead of the 5s default. */
function startMockServer(logDir: string, helloDeadlineMs?: number): Promise<MockServer> {
    const token = 'test-token-hardening';
    const log = new ModelServerLogger(path.join(logDir, 'mock-model-server.log'));
    const embedQueue = new EmbedQueue();
    const status: StatusSnapshot = {
        pid: process.pid,
        uptimeMs: 0,
        clients: 0,
        queueDepth: 0,
        protocolVersion: PROTOCOL_VERSION,
        idleMs: 0,
        rssBytes: 0,
        models: [],
    };
    const deps: ConnectionDeps = {
        token,
        embedQueue,
        log,
        queueMaxPerClient: 100,
        textCharLimit: 10_000,
        onClientConnect: () => {},
        onClientDisconnect: () => {},
        onActivityStart: () => {},
        onActivityEnd: () => {},
        getStatus: () => status,
        requestShutdown: () => false,
        helloDeadlineMs,
    };
    const server = net.createServer((socket) => attachConnection(socket, deps));
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            const addr = server.address();
            if (addr === null || typeof addr === 'string') { reject(new Error('expected a TCP address')); return; }
            resolve({
                port: addr.port,
                token,
                close: () => new Promise<void>((res) => server.close(() => res())),
            });
        });
    });
}

async function helloOk(client: WireClient, token: string): Promise<void> {
    client.send({ type: 'hello', v: PROTOCOL_VERSION, token, clientId: 'hardening-test' });
    const ev = await client.nextFrame();
    assert.equal(ev.kind, 'frame');
    if (ev.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(ev.header, { type: 'helloOk', v: PROTOCOL_VERSION });
}

{
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ms-hardening-mock-'));
    const mock = await startMockServer(logDir);
    try {
        const client = connectRaw(mock.port);
        await helloOk(client, mock.token);

        await test('SF6: malformed texts (non-string element) -> bad_request error frame, server stays alive', async () => {
            client.send({ type: 'embed', id: 'bad-texts', op: 'documentBatch', modelId: 'whatever', texts: [123, 'ok'] });
            const ev = await client.nextFrame();
            assert.equal(ev.kind, 'frame');
            if (ev.kind !== 'frame') return;
            const h = ev.header as Record<string, unknown>;
            assert.equal(h.type, 'error');
            assert.equal(h.name, 'bad_request');

            // Server still alive: a plain status request on the SAME
            // connection still gets a normal response.
            client.send({ type: 'status', id: 'still-alive-1' });
            const ev2 = await client.nextFrame();
            assert.equal(ev2.kind, 'frame');
            if (ev2.kind !== 'frame') return;
            assert.equal((ev2.header as Record<string, unknown>).type, 'statusResult');
        });

        await test('SF6: rerank passages:[null] -> bad_request error frame, server stays alive', async () => {
            client.send({
                type: 'rerank', id: 'bad-passages', modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE,
                cacheDir: '/ignored', query: 'q', passages: [null, 'ok'],
            });
            const ev = await client.nextFrame();
            assert.equal(ev.kind, 'frame');
            if (ev.kind !== 'frame') return;
            const h = ev.header as Record<string, unknown>;
            assert.equal(h.type, 'error');
            assert.equal(h.name, 'bad_request');

            client.send({ type: 'status', id: 'still-alive-2' });
            const ev2 = await client.nextFrame();
            assert.equal(ev2.kind, 'frame');
            if (ev2.kind !== 'frame') return;
            assert.equal((ev2.header as Record<string, unknown>).type, 'statusResult');
        });

        client.close();
    } finally {
        await mock.close();
        fs.rmSync(logDir, { recursive: true, force: true });
    }
}

{
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ms-hardening-oversize-'));
    const mock = await startMockServer(logDir);
    try {
        await test('pre-auth oversize frame -> connection closed', async () => {
            const socket = net.createConnection(mock.port, '127.0.0.1');
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('error', reject);
            });
            // Never send hello — go straight to an oversize frame. Content
            // doesn't matter, only that totalLen exceeds the pre-auth cap
            // (64 KiB, per connection.ts's PRE_AUTH_MAX_FRAME_BYTES).
            const oversize = encodeFrame({ type: 'hello', v: PROTOCOL_VERSION, token: 'x' }, Buffer.alloc(200 * 1024));
            const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
            socket.write(oversize);
            await Promise.race([
                closed,
                new Promise((_, reject) => setTimeout(() => reject(new Error('connection was not closed within 10s')), 10_000)),
            ]);
        });
    } finally {
        await mock.close();
        fs.rmSync(logDir, { recursive: true, force: true });
    }
}

{
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ms-hardening-deadline-'));
    const mock = await startMockServer(logDir, 300); // short deadline for a fast test
    try {
        await test('no hello -> connection closed after the hello deadline', async () => {
            const socket = net.createConnection(mock.port, '127.0.0.1');
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('error', reject);
            });
            const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
            await Promise.race([
                closed,
                new Promise((_, reject) => setTimeout(() => reject(new Error('connection was not closed within 10s of the 300ms deadline')), 10_000)),
            ]);
        });
    } finally {
        await mock.close();
        fs.rmSync(logDir, { recursive: true, force: true });
    }
}

// ─── Part 3: SF8 rerank-abort-frees-the-slot, through a real spawned server ──

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-hardening-${tag}-`));
}

function spawnServer(loreHome: string, extraEnv: Record<string, string> = {}): ChildProcess {
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

function connectRawUnix(sockPath: string): WireClient {
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
        nextFrame(timeoutMs = 60000) {
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

{
    const home = mkLoreHome('rerank-abort');
    await installRerankModel(home);

    // Cap concurrency at 1 so the abort's effect on the slot is observable:
    // if the abort never reached the provider, a later request would see
    // the slot still held and come back `busy`.
    const child = spawnServer(home, { LORE_RECALL_RERANK_MAX_CONCURRENT: '1' });
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock, 30000);
        const token = fs.readFileSync(tokenPath(home, key), 'utf8');
        const client = connectRawUnix(sock);
        await helloOk(client, token);

        await test('SF8: a rerank cancel aborts score() and frees the slot — a later call is not busy', async () => {
            const passages = ['passage one about headphones', 'passage two about sourdough bread'];
            // Sent back to back, no await between: one ordered byte
            // stream, so connection.ts registers the AbortController for
            // r1 (synchronously, before r1's first await) before it
            // processes the cancel frame for the same id — see
            // model-server-rerank-busy-unit.ts's header comment for why
            // this ordering is deterministic on a single socket.
            client.send({ type: 'rerank', id: 'abort-r1', modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir: '/ignored-by-server', query: 'headphones', passages });
            client.send({ type: 'cancel', id: 'abort-r1' });

            const byType = new Map<string, Record<string, unknown>>();
            for (let i = 0; i < 2; i++) {
                const ev = await client.nextFrame(60000);
                assert.equal(ev.kind, 'frame');
                if (ev.kind !== 'frame') continue;
                const h = ev.header as Record<string, unknown>;
                byType.set(h.type as string, h);
            }

            const cancelAck = byType.get('cancelAck');
            assert.ok(cancelAck, `expected a cancelAck frame, got: ${JSON.stringify([...byType.values()])}`);
            if (cancelAck) assert.equal(cancelAck.cancelled, true, 'cancel must find and abort the in-flight rerank controller');

            // r1 either lost the race to the abort (error) or, rarely,
            // completed just before the cancel landed (result) — either
            // way it must not be `busy` (that would mean the concurrency
            // check itself misbehaved) and the slot must end up free.
            const r1 = byType.get('error') ?? byType.get('result');
            assert.ok(r1, `expected an error or result frame for abort-r1, got: ${JSON.stringify([...byType.values()])}`);
            if (byType.get('error')) assert.notEqual(byType.get('error')!.name, 'busy', 'abort-r1 must not fail with busy — cap is 1 and nothing else was in flight');

            // The real assertion: a fresh rerank request now succeeds
            // rather than getting busy — proving the concurrency slot was
            // released promptly once the abort reached score().
            client.send({ type: 'rerank', id: 'abort-r2', modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir: '/ignored-by-server', query: 'recovery', passages: ['a single passage'] });
            const ev2 = await client.nextFrame(60000);
            assert.equal(ev2.kind, 'frame');
            if (ev2.kind !== 'frame') return;
            const h2 = ev2.header as Record<string, unknown>;
            assert.equal(h2.type, 'result', `expected abort-r2 to succeed (slot freed), got ${JSON.stringify(h2)}`);
        });

        client.close();
    } finally {
        await reapChild(child);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

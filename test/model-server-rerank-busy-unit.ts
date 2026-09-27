#!/usr/bin/env tsx
/**
 * model-server-rerank-busy-unit.ts — D9 (3.24 slice C1) §5.7 machine-wide
 * rerank concurrency cap, exercised through a real spawned server.
 *
 * `queue.ts`'s header comment explains the design: rerank is deliberately
 * NOT queued by this server — it goes straight to
 * `LocalRerankProvider.score()`, which already enforces its own
 * process-wide concurrency cap (`LORE_RECALL_RERANK_MAX_CONCURRENT`,
 * default 2) and throws `RerankBusyError` synchronously, before any
 * inference work starts, the instant that cap is exceeded — see
 * `localRerankProvider.ts` around `rerankActiveScoreRuns`. `handlers.ts`'s
 * `handleRerank()` maps that to `ModelServerError('busy', ...)`, which
 * `connection.ts` sends back as `{type:'error', name:'busy'}`.
 *
 * This test sets the cap to 1 and fires two rerank requests back to back
 * on the SAME connection with no delay between them. That (not two
 * separate sockets) is what makes the ordering deterministic: a single
 * socket is one ordered byte stream, so `FrameDecoder` always yields
 * request 1's frame before request 2's, and `connection.ts` processes
 * frames from one chunk synchronously in order — so request 1's
 * `score()` call is always the one whose synchronous, pre-inference
 * counter check-and-increment runs first, and request 2's synchronous
 * check is guaranteed to observe the cap already occupied. No timing
 * assumption about model load speed is needed here (unlike
 * model-server-concurrency-unit.ts), because the busy check itself is
 * synchronous, before any real inference begins.
 *
 * Then checks the server's own cap: default 4 (all hosts share one pool),
 * and `LORE_MODEL_SERVER_RERANK_MAX_CONCURRENT` taking precedence over an
 * explicit `LORE_RECALL_RERANK_MAX_CONCURRENT`.
 *
 * Run: npx tsx test/model-server-rerank-busy-unit.ts
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
import { serverKey, socketPath, tokenPath } from '../packages/lore/src/modelServer/paths.js';
import { DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE } from '../packages/lore/src/recall/rerankConfig.js';

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
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-rerank-busy-${tag}-`));
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

async function helloOk(client: WireClient, token: string): Promise<void> {
    client.send({ type: 'hello', v: PROTOCOL_VERSION, token, clientId: 'rerank-busy-test' });
    const ev = await client.nextFrame();
    assert.equal(ev.kind, 'frame');
    if (ev.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(ev.header, { type: 'helloOk', v: PROTOCOL_VERSION });
}

console.log('model-server rerank busy — machine-wide concurrency cap, through a real spawned server\n');

const home = mkLoreHome('main');
process.env.LORE_HOME = home;
const { fetchRerankCommand } = await import('../packages/lore/src/cli/commands/modelsFetch.js');
await fetchRerankCommand([]);
const { loreHomePath } = await import('../packages/lore/src/config/loreHome.js');
const cacheDir = loreHomePath('models');

// Cap this server's own rerank concurrency at 1, so a second concurrent
// rerank request is guaranteed to be rejected rather than possibly
// succeeding (default cap is 2, which two requests alone would never
// exceed).
const child = spawnServer(home, { LORE_RECALL_RERANK_MAX_CONCURRENT: '1' });

try {
    const key = serverKey(home);
    const sock = socketPath(home, key);
    await waitForListening(sock);
    const token = fs.readFileSync(tokenPath(home, key), 'utf8');
    const client = connectRaw(sock);
    await helloOk(client, token);

    await test('rerank: a second concurrent request is rejected with busy while the cap (1) is held by the first', async () => {
        const passages = [
            'A comprehensive review of the top noise-cancelling headphones under $100.',
            'How to bake sourdough bread at home, step by step.',
            'Wireless earbuds vs over-ear headphones: which is better for travel?',
        ];
        // Sent back to back, no await between: one ordered byte stream —
        // see the file header for why this makes the outcome deterministic.
        client.send({ type: 'rerank', id: 'busy-r1', modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir, query: 'headphones', passages });
        client.send({ type: 'rerank', id: 'busy-r2', modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir, query: 'headphones', passages });

        const byId = new Map<string, Record<string, unknown>>();
        for (let i = 0; i < 2; i++) {
            const ev = await client.nextFrame(30000);
            assert.equal(ev.kind, 'frame');
            if (ev.kind !== 'frame') throw new Error('unreachable');
            byId.set((ev.header as Record<string, unknown>).id as string, ev.header as Record<string, unknown>);
        }

        const r1 = byId.get('busy-r1');
        const r2 = byId.get('busy-r2');
        assert.ok(r1, 'missing response for busy-r1');
        assert.ok(r2, 'missing response for busy-r2');
        if (!r1 || !r2) return;

        // r1 held the (only) concurrency slot and must succeed normally.
        assert.equal(r1.type, 'result', `expected busy-r1 to succeed, got ${JSON.stringify(r1)}`);
        // r2 arrived while r1's score() call still occupied the cap, and
        // must be rejected as busy — not queued, not silently merged.
        assert.equal(r2.type, 'error', `expected busy-r2 to be rejected, got ${JSON.stringify(r2)}`);
        assert.equal(r2.name, 'busy');
    });

    await test('rerank: after the busy rejection, the server recovers and a fresh request succeeds', async () => {
        const passages = ['a single passage to rerank after recovery'];
        client.send({ type: 'rerank', id: 'busy-r3', modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir, query: 'recovery check', passages });
        const ev = await client.nextFrame(30000);
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        const h = ev.header as Record<string, unknown>;
        assert.equal(h.type, 'result', `expected recovery request to succeed, got ${JSON.stringify(h)}`);
        assert.equal(h.count, 1);
    });

    client.close();
} finally {
    await reapChild(child);
}

/** Spawns a server with `env` (both cap vars cleared first), fires `n`
 *  rerank requests back to back on one connection, returns each response
 *  type in request order ('result' | 'busy' | other error name). */
async function burst(n: number, env: Record<string, string>): Promise<string[]> {
    const baseEnv = { ...process.env };
    delete baseEnv.LORE_RECALL_RERANK_MAX_CONCURRENT;
    delete baseEnv.LORE_MODEL_SERVER_RERANK_MAX_CONCURRENT;
    const server = spawn(tsxBin, [mainTsPath], {
        env: { ...baseEnv, LORE_HOME: home, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        const key = serverKey(home);
        const sock = socketPath(home, key);
        await waitForListening(sock);
        const c = connectRaw(sock);
        await helloOk(c, fs.readFileSync(tokenPath(home, key), 'utf8'));
        const passages = ['noise-cancelling headphones review', 'sourdough bread recipe'];
        for (let i = 0; i < n; i++) {
            c.send({ type: 'rerank', id: `b${i}`, modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir, query: 'headphones', passages });
        }
        const byId = new Map<string, string>();
        for (let i = 0; i < n; i++) {
            const ev = await c.nextFrame(30000);
            if (ev.kind !== 'frame') throw new Error(`unexpected decode event ${ev.kind}`);
            const h = ev.header as Record<string, unknown>;
            byId.set(h.id as string, h.type === 'result' ? 'result' : String(h.name));
        }
        c.close();
        return Array.from({ length: n }, (_, i) => byId.get(`b${i}`) ?? 'missing');
    } finally {
        await reapChild(server);
    }
}

try {
    await test('shared server default cap is 4 (one pool for every host): 5 back-to-back → 4 results, 5th busy', async () => {
        assert.deepEqual(await burst(5, {}), ['result', 'result', 'result', 'result', 'busy']);
    });

    await test('LORE_MODEL_SERVER_RERANK_MAX_CONCURRENT wins over LORE_RECALL_RERANK_MAX_CONCURRENT', async () => {
        assert.deepEqual(
            await burst(3, { LORE_MODEL_SERVER_RERANK_MAX_CONCURRENT: '2', LORE_RECALL_RERANK_MAX_CONCURRENT: '1' }),
            ['result', 'result', 'busy'],
        );
    });
} finally {
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

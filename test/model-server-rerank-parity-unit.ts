#!/usr/bin/env tsx
/**
 * model-server-rerank-parity-unit.ts — D9 (3.24 slice C1) rerank parity.
 *
 * Same claim as model-server-embed-parity-unit.ts, for rerank: a
 * server-mediated `rerank` call must be bit-identical to calling the SAME
 * `LocalRerankProvider.score()` in-process — `handlers.ts` only relocates
 * where the unchanged provider runs. Real cross-encoder model (downloaded
 * once via `fetchRerankCommand([])`, the same "online, verified-by-manifest"
 * path `lore models fetch-rerank` uses — this is deliberate, not a
 * convenience shortcut: `LocalRerankProvider.score()` always refuses an
 * uncached model with `model_absent`, exactly what
 * `test/d8-rerank-e2e.ts` step 6 exercises for the OPPOSITE case (no
 * cache). This test needs the opposite fixture — a real, present cache —
 * so it fetches its own into an isolated `LORE_HOME`, shared by both the
 * spawned server and the in-process comparison call).
 *
 * Must FAIL, never skip, if parity breaks or inference errors out.
 *
 * Run: npx tsx test/model-server-rerank-parity-unit.ts
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
    decodeVectors,
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
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-rerank-parity-${tag}-`));
}

function spawnServer(loreHome: string): ChildProcess {
    return spawn(tsxBin, [mainTsPath], {
        env: { ...process.env, LORE_HOME: loreHome },
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
    client.send({ type: 'hello', v: PROTOCOL_VERSION, token, clientId: 'rerank-parity-test' });
    const ev = await client.nextFrame();
    assert.equal(ev.kind, 'frame');
    if (ev.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(ev.header, { type: 'helloOk', v: PROTOCOL_VERSION });
}

console.log('model-server rerank parity — real spawned server vs. real in-process LocalRerankProvider\n');

const home = mkLoreHome('main');
// Populate <home>/models with the real, manifest-verified default rerank
// model BEFORE spawning the server — both the server (via cacheDir in its
// rerank message) and the in-process comparison call read from this same
// cache dir, matching modelId/dtype exactly.
process.env.LORE_HOME = home;
const { fetchRerankCommand } = await import('../packages/lore/src/cli/commands/modelsFetch.js');
await fetchRerankCommand([]);
const { loreHomePath } = await import('../packages/lore/src/config/loreHome.js');
const cacheDir = loreHomePath('models');
const { LocalRerankProvider } = await import('../packages/lore/src/providers/localRerankProvider.js');

const child = spawnServer(home);
const inProcessProvider = new LocalRerankProvider({ modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir });

try {
    const key = serverKey(home);
    const sock = socketPath(home, key);
    await waitForListening(sock);
    const token = fs.readFileSync(tokenPath(home, key), 'utf8');
    const client = connectRaw(sock);
    await helloOk(client, token);

    await test('rerank: server-mediated scores are bit-identical to in-process score()', async () => {
        const query = 'best budget noise-cancelling headphones';
        const passages = [
            'A comprehensive review of the top noise-cancelling headphones under $100.',
            'How to bake sourdough bread at home, step by step.',
            'Wireless earbuds vs over-ear headphones: which is better for travel?',
            'The history of the Roman aqueduct system.',
            'Budget headphones with active noise cancellation compared side by side.',
        ];
        const id = 'rr1';
        client.send({ type: 'rerank', id, modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir, query, passages });
        const ev = await client.nextFrame();
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        const h = ev.header as Record<string, unknown>;
        if (h.type === 'error') throw new Error(`server returned error: ${JSON.stringify(h)}`);
        assert.equal(h.type, 'result');
        assert.equal(h.id, id);
        assert.equal(h.count, passages.length);
        const serverScores = decodeVectors(ev.body, h.count as number, h.dim as number).map((v) => v[0]!);
        const inProcScores = await inProcessProvider.score(query, passages);
        assert.deepEqual(serverScores, inProcScores);
    });

    await test("rerank: server log file never contains this test's literal query/passage text", async () => {
        const { logPath } = await import('../packages/lore/src/modelServer/paths.js');
        const logFile = logPath(home);
        assert.ok(fs.existsSync(logFile), `expected a log file at ${logFile}`);
        const contents = fs.readFileSync(logFile, 'utf8');
        assert.ok(!contents.includes('noise-cancelling headphones'), 'log file must never contain payload text');
        assert.ok(!contents.includes('Roman aqueduct'), 'log file must never contain payload text');
    });

    client.close();
} finally {
    await reapChild(child);
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

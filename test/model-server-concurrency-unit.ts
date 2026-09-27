#!/usr/bin/env tsx
/**
 * model-server-concurrency-unit.ts — D9 (3.24 slice C1) `queue.ts`'s
 * round-robin / query-ahead-of-batch priority, exercised through a real
 * spawned server (not by calling EmbedQueue's methods directly — the point
 * is to prove connection.ts wires clientId/priority into the queue
 * correctly, and that dispatch really is single-concurrency end to end).
 *
 * Both scenarios below exploit the same fact: the FIRST embed request a
 * freshly spawned server receives always takes real, model-load-dominated
 * time (session/tokenizer init from disk, well over a second) — far longer
 * than it takes this test to fire several more requests down the wire
 * immediately after it, without awaiting a response. That gives a wide,
 * reliable window in which those follow-up requests are guaranteed to have
 * reached the server's queue before the first request's task resolves and
 * `pump()` asks the queue what to run next — which is what makes the
 * exact dispatch order asserted below deterministic rather than a race.
 * (See queue.ts's own header comment for the algorithm being exercised.)
 *
 * Run: npx tsx test/model-server-concurrency-unit.ts
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
import { LocalEmbeddingProvider, DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from '../packages/lore/src/providers/localEmbeddingProvider.js';

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
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-concurrency-${tag}-`));
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

async function helloOk(client: WireClient, clientTag: string, token: string): Promise<void> {
    client.send({ type: 'hello', v: PROTOCOL_VERSION, token, clientId: clientTag });
    const ev = await client.nextFrame();
    assert.equal(ev.kind, 'frame');
    if (ev.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(ev.header, { type: 'helloOk', v: PROTOCOL_VERSION });
}

function embedHeader(id: string, op: 'query' | 'documentBatch', extra: Record<string, unknown>): Record<string, unknown> {
    return { type: 'embed', id, op, modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, ...extra };
}

console.log('model-server concurrency — round-robin, priority, and no-merging, through a real spawned server\n');

const home = mkLoreHome('main');
const child = spawnServer(home);
const inProcessProvider = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });

try {
    const key = serverKey(home);
    const sock = socketPath(home, key);
    await waitForListening(sock);
    const token = fs.readFileSync(tokenPath(home, key), 'utf8');

    await test('query-ahead-of-batch: a query enqueued behind two batches still completes before the older batch', async () => {
        const client = connectRaw(sock);
        await helloOk(client, 'concurrency-priority', token);

        // batch1 is this server's very first embed request: it is
        // dispatched (and starts real, model-load-dominated inference)
        // synchronously, before this call returns — see the file header.
        client.send(embedHeader('batch1', 'documentBatch', { texts: Array.from({ length: 24 }, (_, i) => `warm-up document number ${i} about pangolins and printers.`) }));
        // Sent immediately after, with no await in between: both land in
        // this client's queue while batch1 is still running.
        client.send(embedHeader('batch2', 'documentBatch', { texts: ['a later, lower-priority batch document'] }));
        client.send(embedHeader('query1', 'query', { text: 'a higher-priority interactive query' }));

        const order: string[] = [];
        for (let i = 0; i < 3; i++) {
            const ev = await client.nextFrame(30000);
            assert.equal(ev.kind, 'frame');
            if (ev.kind !== 'frame') throw new Error('unreachable');
            const h = ev.header as Record<string, unknown>;
            if (h.type === 'error') throw new Error(`server returned error: ${JSON.stringify(h)}`);
            order.push(h.id as string);
        }
        assert.deepEqual(order, ['batch1', 'query1', 'batch2'], 'query1 must be dispatched ahead of the older batch2, only after the already-running batch1 finishes');
        client.close();
    });

    await test('two clients: round-robin dispatch order, and no cross-client merging of results', async () => {
        const clientA = connectRaw(sock);
        const clientB = connectRaw(sock);
        await helloOk(clientA, 'concurrency-client-a', token);
        await helloOk(clientB, 'concurrency-client-b', token);

        const textA1 = 'Client A: the migratory patterns of Arctic terns.';
        const textB1 = 'Client B: a history of the printing press.';
        const textA2 = 'Client A: how volcanic glass forms obsidian.';
        const textB2 = 'Client B: the physics of soap bubbles.';

        // A1 is this (fresh) server's first embed request: dispatched and
        // running well before this whole block returns (real inference,
        // model-load-dominated, comfortably over a second). B1/A2/B2 are
        // sent from small delays apart — NOT to race the dispatch (any of
        // them landing before A1 resolves is enough for that), but because
        // two *different* OS sockets give no cross-socket delivery-order
        // guarantee: the kernel may deliver a same-process write to socket
        // B before an earlier write to socket A even when this script
        // issued them A-then-B. A 50ms gap is several orders of magnitude
        // above local unix-socket IPC latency, so it reliably preserves
        // the A1, B1, A2, B2 arrival order this test depends on, while
        // staying far inside the multi-second model-load budget.
        const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
        clientA.send(embedHeader('a1', 'documentBatch', { texts: [textA1] }));
        await delay(50);
        clientB.send(embedHeader('b1', 'documentBatch', { texts: [textB1] }));
        await delay(50);
        clientA.send(embedHeader('a2', 'documentBatch', { texts: [textA2] }));
        await delay(50);
        clientB.send(embedHeader('b2', 'documentBatch', { texts: [textB2] }));

        // Collect all 4 responses in true arrival order across both
        // sockets (whichever client's frame arrives first).
        type Tagged = { from: 'A' | 'B'; header: Record<string, unknown>; body: Buffer };
        const results: Tagged[] = [];
        const pending = new Set<Promise<Tagged>>();
        const nextFrom = (c: WireClient, from: 'A' | 'B'): Promise<Tagged> =>
            c.nextFrame(30000).then((ev) => {
                assert.equal(ev.kind, 'frame');
                if (ev.kind !== 'frame') throw new Error('unreachable');
                const h = ev.header as Record<string, unknown>;
                if (h.type === 'error') throw new Error(`server returned error: ${JSON.stringify(h)}`);
                return { from, header: h, body: ev.body };
            });
        let pA = nextFrom(clientA, 'A');
        let pB = nextFrom(clientB, 'B');
        let remainingA = 2, remainingB = 2;
        while (results.length < 4) {
            const promises: Array<Promise<Tagged>> = [];
            if (remainingA > 0) promises.push(pA);
            if (remainingB > 0) promises.push(pB);
            const winner = await Promise.race(promises);
            results.push(winner);
            if (winner.from === 'A') {
                remainingA--;
                if (remainingA > 0) pA = nextFrom(clientA, 'A');
            } else {
                remainingB--;
                if (remainingB > 0) pB = nextFrom(clientB, 'B');
            }
        }
        void pending;

        const order = results.map((r) => r.header.id as string);
        assert.deepEqual(order, ['a1', 'b1', 'a2', 'b2'], 'dispatch must alternate A/B round-robin, per queue.ts\'s fairness rule');

        // Correctness / no-merging: each response's vector must match a
        // fresh, independent in-process embedding of THAT exact text —
        // and not, say, an average with the concurrently-enqueued sibling
        // request's text, which is what a forward-pass merge bug would
        // produce.
        const byId = new Map(results.map((r) => [r.header.id as string, r]));
        const expected: Array<[string, string]> = [['a1', textA1], ['b1', textB1], ['a2', textA2], ['b2', textB2]];
        for (const [id, text] of expected) {
            const r = byId.get(id);
            assert.ok(r, `missing response for ${id}`);
            if (!r) continue;
            const [serverVec] = decodeVectors(r.body, r.header.count as number, r.header.dim as number);
            const [inProcVec] = await inProcessProvider.embedDocumentBatch([text]);
            assert.deepEqual(serverVec, inProcVec, `${id}'s embedding must match its own text, not a merged/cross-contaminated result`);
        }

        clientA.close();
        clientB.close();
    });
} finally {
    await reapChild(child);
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

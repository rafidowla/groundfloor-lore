#!/usr/bin/env tsx
/**
 * model-server-embed-parity-unit.ts — D9 (3.24 slice C1) embed parity.
 *
 * Proves `handlers.ts`'s central claim (see its own file header): a
 * server-mediated embed call is bit-identical to calling the SAME
 * `LocalEmbeddingProvider` in-process, for every op the protocol exposes —
 * because the server never re-implements inference, it only relocates
 * where the existing provider runs. Real model (the already-cached default
 * `Xenova/multilingual-e5-small`, 384-dim), real ONNX inference on both
 * sides — no mocking, since a mock could never catch a marshalling bug in
 * `encodeVectors`/`decodeVectors` or the JSON header round-trip.
 *
 * Also checks the hard privacy invariant `log.ts` documents: the server's
 * own log file must never contain the literal text of any query/document
 * this test sent.
 *
 * Must FAIL, never skip, if parity breaks or if inference errors out —
 * this is exercising the real inference path, not a fixture.
 *
 * Run: npx tsx test/model-server-embed-parity-unit.ts
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
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-embed-parity-${tag}-`));
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
    client.send({ type: 'hello', v: PROTOCOL_VERSION, token, clientId: 'embed-parity-test' });
    const ev = await client.nextFrame();
    assert.equal(ev.kind, 'frame');
    if (ev.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(ev.header, { type: 'helloOk', v: PROTOCOL_VERSION });
}

async function embedViaServer(
    client: WireClient,
    id: string,
    req: Record<string, unknown>,
): Promise<{ header: Record<string, unknown>; body: Buffer }> {
    client.send({ type: 'embed', id, modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, ...req });
    const ev = await client.nextFrame();
    assert.equal(ev.kind, 'frame');
    if (ev.kind !== 'frame') throw new Error('unreachable');
    const h = ev.header as Record<string, unknown>;
    if (h.type === 'error') throw new Error(`server returned error: ${JSON.stringify(h)}`);
    assert.equal(h.type, 'result');
    assert.equal(h.id, id);
    return { header: h, body: ev.body };
}

console.log('model-server embed parity — real spawned server vs. real in-process LocalEmbeddingProvider\n');

const home = mkLoreHome('main');
const child = spawnServer(home);
const inProcessProvider = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });

try {
    const key = serverKey(home);
    const sock = socketPath(home, key);
    await waitForListening(sock);
    const token = fs.readFileSync(tokenPath(home, key), 'utf8');
    const client = connectRaw(sock);
    await helloOk(client, token);

    await test('embedQuery: server-mediated result is bit-identical to in-process', async () => {
        const text = 'What is the capital of France?';
        const { header, body } = await embedViaServer(client, 'q1', { op: 'query', text });
        const [serverVec] = decodeVectors(body, header.count as number, header.dim as number);
        const inProcVec = await inProcessProvider.embedQuery(text);
        assert.equal(header.dim, DEFAULT_LOCAL_MODEL_DIM);
        assert.deepEqual(serverVec, inProcVec);
    });

    await test('embedDocument: bit-identical, including non-English text', async () => {
        const text = '東京は日本の首都です。これはテスト文です。';
        const { header, body } = await embedViaServer(client, 'd1', { op: 'document', text });
        const [serverVec] = decodeVectors(body, header.count as number, header.dim as number);
        const inProcVec = await inProcessProvider.embedDocument(text);
        assert.deepEqual(serverVec, inProcVec);
    });

    await test('embedDocumentBatch: bit-identical across a mixed-language batch', async () => {
        const texts = [
            'The quick brown fox jumps over the lazy dog.',
            'Le renard brun rapide saute par-dessus le chien paresseux.',
            '素早い茶色の狐が怠け者の犬を飛び越える。',
            'A',
        ];
        const { header, body } = await embedViaServer(client, 'db1', { op: 'documentBatch', texts });
        const serverVecs = decodeVectors(body, header.count as number, header.dim as number);
        const inProcVecs = await inProcessProvider.embedDocumentBatch(texts);
        assert.equal(serverVecs.length, texts.length);
        assert.deepEqual(serverVecs, inProcVecs);
    });

    await test('splitIntoWindows: identical window boundaries for a long multi-window text', async () => {
        // Long enough (with a small window/overlap) to force >= 3 windows.
        const paragraph = 'Lore is a shared model server for embeddings and reranking. ';
        const text = paragraph.repeat(80);
        const windowTokens = 32;
        const overlapTokens = 8;
        const { header } = await embedViaServer(client, 'w1', {
            op: 'splitIntoWindows',
            text,
            windowTokens,
            overlapTokens,
        });
        const serverWindows = header.windows as string[];
        const inProcWindows = await inProcessProvider.splitIntoWindows(text, windowTokens, overlapTokens);
        assert.ok(serverWindows.length >= 3, `expected >= 3 windows, got ${serverWindows.length}`);
        assert.deepEqual(serverWindows, inProcWindows);
    });

    await test("server log file never contains this test's literal query/document text", async () => {
        // log.ts writes to <LORE_HOME's shared logPath>; import it the same
        // way server.ts does to find the exact file this run wrote to.
        const { logPath } = await import('../packages/lore/src/modelServer/paths.js');
        const logFile = logPath(home);
        assert.ok(fs.existsSync(logFile), `expected a log file at ${logFile}`);
        const contents = fs.readFileSync(logFile, 'utf8');
        const forbidden = [
            'What is the capital of France?',
            '東京は日本の首都です',
            'The quick brown fox jumps over the lazy dog.',
            'Lore is a shared model server for embeddings and reranking.',
        ];
        for (const needle of forbidden) {
            assert.ok(!contents.includes(needle), `log file must never contain payload text, but found: ${JSON.stringify(needle)}`);
        }
    });

    await test('status lists the served embedding model (ids only) and a non-zero rssBytes', async () => {
        client.send({ type: 'status', id: 'st-served' });
        const ev = await client.nextFrame();
        if (ev.kind !== 'frame') throw new Error(`expected frame, got ${ev.kind}`);
        const h = ev.header as { type: string; rssBytes: number; models: Array<{ kind: string; id: string; lastUsedAt: number }> };
        assert.equal(h.type, 'statusResult');
        assert.ok(h.rssBytes > 0);
        const embed = h.models.find((m) => m.kind === 'embed' && m.id === DEFAULT_LOCAL_MODEL_ID);
        assert.ok(embed, `expected ${DEFAULT_LOCAL_MODEL_ID} in served models, got ${JSON.stringify(h.models)}`);
        assert.ok(embed.lastUsedAt > 0);
    });

    client.close();
} finally {
    await reapChild(child);
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

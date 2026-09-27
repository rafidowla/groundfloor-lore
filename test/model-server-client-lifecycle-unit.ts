#!/usr/bin/env tsx
/**
 * model-server-client-lifecycle-unit.ts — D9 (3.24 slice C2a) client-side
 * lifecycle: `ModelServerClient` drives a REAL spawned `main.ts` server
 * process over a real unix socket (no mocking of clientConnection.ts /
 * protocol.ts) for:
 *   - embed()/rerank() bit-identical parity vs. calling the same local
 *     providers in-process (rerank model installed by `installRerankModel()`,
 *     test/helpers/rerank-model-fixture.ts).
 *   - status()/onStatus callback transitions: an unspawnable-within-budget
 *     server drives a loud shared->fallback transition, and the background
 *     recovery probe self-heals it back to shared once the (still-running,
 *     detached) server finishes booting.
 *   - `kill -9` of the server the client itself spawned: the NEXT call
 *     transparently respawns and succeeds (lazy recovery, no forced
 *     fallback transition for an idle connection loss — see client.ts's
 *     file header).
 *   - a stale socket left behind by an already-killed server: a client's
 *     FIRST-ever connect attempt against that loreHome recovers cleanly.
 *   - two independent `ModelServerClient` instances against the same
 *     loreHome converge on ONE server process (the O_EXCL lock race in
 *     clientConnection.ts's `spawnOrConnect()`).
 *
 * Run: npx tsx test/model-server-client-lifecycle-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ModelServerClient, ModelServerUnavailableError, type ModelStatus } from '../packages/lore/src/modelServer/client.js';
import { serverKey, socketPath, pidPath } from '../packages/lore/src/modelServer/paths.js';
import { LocalEmbeddingProvider, DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { LocalRerankProvider } from '../packages/lore/src/providers/localRerankProvider.js';
import { DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE } from '../packages/lore/src/recall/rerankConfig.js';
import { installRerankModel } from './helpers/rerank-model-fixture.js';
import { removeHome } from './helpers/model-server-home.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-client-${tag}-`));
}

function readServerPid(loreHome: string): number | null {
    const key = serverKey(loreHome);
    const p = pidPath(loreHome, key);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').trim();
    return raw ? parseInt(raw, 10) : null;
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

function isAlive(pid: number): boolean {
    const res = spawnSync('ps', ['-p', String(pid)]);
    return res.status === 0 && res.stdout.toString().includes(String(pid));
}

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (fn()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

/** Kills every model-server pid this run's temp homes recorded, best-effort,
 *  by pid only — never by pattern. */
const spawnedPids = new Set<number>();
function trackHome(loreHome: string): void {
    const pid = readServerPid(loreHome);
    if (pid !== null) spawnedPids.add(pid);
}
function cleanupAllTrackedPids(): void {
    for (const pid of spawnedPids) {
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
}

console.log('model-server client lifecycle — real ModelServerClient against a real spawned server\n');

const GENEROUS = { readyMs: 25_000, restartBudgetMs: 20_000, maxRestarts: 5, callMs: 30_000, probeMs: 1000 };

// ---------------------------------------------------------------------
await test('embed happy path: ModelServerClient result is bit-identical to in-process LocalEmbeddingProvider', async () => {
    const home = mkLoreHome('embed-happy');
    const client = new ModelServerClient({ loreHome: home, clientId: 'lifecycle-embed', ...GENEROUS });
    const inProc = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });
    try {
        const text = 'What is the capital of France?';
        const { vectors } = await client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text });
        const inProcVec = await inProc.embedQuery(text);
        assert.deepEqual(vectors?.[0], inProcVec);

        const texts = ['alpha document one', 'beta document two, longer than the first'];
        const { vectors: batch } = await client.embed({ op: 'documentBatch', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, texts });
        const inProcBatch = await inProc.embedDocumentBatch(texts);
        assert.deepEqual(batch, inProcBatch);

        const status = client.status();
        assert.equal(status.mode, 'shared');
        trackHome(home);
    } finally {
        await client.dispose();
        await removeHome(home);
    }
});

// ---------------------------------------------------------------------
await test('rerank happy path: ModelServerClient result is bit-identical to in-process LocalRerankProvider', async () => {
    const home = mkLoreHome('rerank-happy');
    const cacheDir = await installRerankModel(home);
    const client = new ModelServerClient({ loreHome: home, clientId: 'lifecycle-rerank', ...GENEROUS });
    const inProc = new LocalRerankProvider({ modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir });
    try {
        const query = 'capital of France';
        const passages = ['Paris is the capital of France.', 'Bananas are yellow.', 'The Eiffel Tower is in Paris.'];
        const scores = await client.rerank({ modelId: DEFAULT_RERANK_MODEL, dtype: DEFAULT_RERANK_DTYPE, cacheDir, query, passages });
        const inProcScores = await inProc.score(query, passages);
        assert.deepEqual(scores, inProcScores);
        trackHome(home);
    } finally {
        await client.dispose();
        await removeHome(home);
    }
});

// ---------------------------------------------------------------------
await test('unspawnable-within-budget server: loud shared->fallback transition, onStatus fires, _meta-worthy reason set', async () => {
    const home = mkLoreHome('unspawnable');
    const statuses: ModelStatus[] = [];
    const errors: string[] = [];
    const client = new ModelServerClient({
        loreHome: home,
        clientId: 'lifecycle-unspawnable',
        // Deliberately far too small for a real cold boot (model load +
        // ONNX session init) to finish within — forces the FIRST attempt to
        // fail, and restartBudgetMs/maxRestarts are tiny too so the client
        // gives up (rather than retrying) and transitions loudly. The
        // detached spawn keeps running in the background regardless (see
        // clientConnection.ts's spawnOrConnect doc) and should finish
        // moments later, which the recovery probe below picks up.
        readyMs: 150,
        restartBudgetMs: 50,
        maxRestarts: 1,
        callMs: 30_000,
        probeMs: 500,
        log: { error: (m) => errors.push(m), warn: () => {}, debug: () => {} },
        onStatus: (s) => statuses.push(s),
    });
    try {
        await assert.rejects(
            () => client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'hi' }),
            ModelServerUnavailableError,
        );
        assert.equal(client.status().mode, 'fallback');
        assert.ok(client.status().reason, 'fallback status must carry a reason');
        assert.ok(statuses.some((s) => s.mode === 'fallback'), 'onStatus must have fired at least one fallback status');
        assert.ok(errors.some((m) => m.includes('falling back')), 'a loud log.error must announce the fallback transition');

        // Background recovery: the detached server this failed attempt
        // spawned should finish booting and get picked up by the probe.
        await waitFor(() => client.status().mode === 'shared', 25_000, 'client.status().mode to recover to shared');
        assert.ok(statuses.some((s) => s.mode === 'shared'), 'onStatus must have fired a recovery status');
        trackHome(home);
    } finally {
        await client.dispose();
        await removeHome(home);
    }
});

// ---------------------------------------------------------------------
await test('kill -9 of the spawned server: next call transparently respawns and succeeds', async () => {
    const home = mkLoreHome('kill-respawn');
    const client = new ModelServerClient({ loreHome: home, clientId: 'lifecycle-kill', ...GENEROUS });
    try {
        await client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'first call spawns the server' });
        const firstPid = readServerPid(home);
        assert.ok(firstPid, 'expected a pidfile after the first successful call');

        const key = serverKey(home);
        const sock = socketPath(home, key);
        process.kill(firstPid!, 'SIGKILL');
        await waitForNotListening(sock);

        const { vectors } = await client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'second call after kill -9' });
        assert.ok(vectors && vectors[0].length === DEFAULT_LOCAL_MODEL_DIM);

        const secondPid = readServerPid(home);
        assert.ok(secondPid, 'expected a pidfile after respawn');
        assert.notEqual(secondPid, firstPid, 'respawned server must be a different OS process');
        trackHome(home);
    } finally {
        await client.dispose();
        await removeHome(home);
    }
});

// ---------------------------------------------------------------------
await test('stale socket from an already-killed server: a FRESH client recovers cleanly on first connect', async () => {
    const home = mkLoreHome('stale-socket');
    const bootstrap = new ModelServerClient({ loreHome: home, clientId: 'lifecycle-stale-bootstrap', ...GENEROUS });
    let killedPid: number | null = null;
    try {
        await bootstrap.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'bootstrap' });
        killedPid = readServerPid(home);
        assert.ok(killedPid);
        const key = serverKey(home);
        const sock = socketPath(home, key);
        // Kill the real server WITHOUT going through bootstrap.dispose()
        // (which would send a graceful shutdown and clean up the socket) —
        // this leaves socket/pidfile/token behind stale, matching what a
        // hard crash looks like.
        process.kill(killedPid, 'SIGKILL');
        await waitForNotListening(sock);
    } finally {
        // bootstrap's own conn is already dead; disposing just clears its
        // timers, it must not resurrect the process we just killed.
        await bootstrap.dispose();
    }

    const fresh = new ModelServerClient({ loreHome: home, clientId: 'lifecycle-stale-fresh', ...GENEROUS });
    try {
        const { vectors } = await fresh.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'after stale socket' });
        assert.ok(vectors && vectors[0].length === DEFAULT_LOCAL_MODEL_DIM);
        assert.equal(fresh.status().mode, 'shared');
        const newPid = readServerPid(home);
        assert.ok(newPid && newPid !== killedPid);
        trackHome(home);
    } finally {
        await fresh.dispose();
        await removeHome(home);
    }
});

// ---------------------------------------------------------------------
await test('two independent ModelServerClient instances against the same loreHome converge on one server', async () => {
    const home = mkLoreHome('two-clients');
    const a = new ModelServerClient({ loreHome: home, clientId: 'lifecycle-two-a', ...GENEROUS });
    const b = new ModelServerClient({ loreHome: home, clientId: 'lifecycle-two-b', ...GENEROUS });
    try {
        const [ra, rb] = await Promise.all([
            a.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'client A' }),
            b.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'client B' }),
        ]);
        assert.ok(ra.vectors && rb.vectors);
        const pidA = a.status().server?.pid;
        const pidB = b.status().server?.pid;
        assert.ok(pidA && pidB, 'both clients must report a server pid');
        assert.equal(pidA, pidB, 'both clients must have converged on the SAME server process');
        trackHome(home);
    } finally {
        await Promise.all([a.dispose(), b.dispose()]);
        await removeHome(home);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
cleanupAllTrackedPids();
if (failed > 0) process.exit(1);

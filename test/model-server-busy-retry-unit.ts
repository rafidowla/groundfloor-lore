#!/usr/bin/env tsx
/**
 * model-server-busy-retry-unit.ts — Lore 3.24 review slice D3, SF11 parity
 * rule (D9 §5.5.3 decision), `busy` half: a per-client embed queue
 * rejection (`ModelServerError('busy', ...)`, see connection.ts's
 * `queueMaxPerClient`) must not fail a shared-mode caller — in-process has
 * no such limit — so `SharedEmbeddingProvider.callWithBusyRetry()` retries
 * with a bounded backoff (100/200/400/800/1600ms) before ever falling back.
 *
 * Forces a real `busy` rejection deterministically. `queue.ts`'s
 * `EmbedQueue.depthFor(clientId)` counts only tasks NOT YET dispatched — a
 * client's first in-flight request is spliced out of its queue (and the
 * client dropped from the map entirely) the instant the queue's pump loop
 * picks it up, which happens synchronously within that same `enqueue()`
 * call. So with `LORE_MODEL_SERVER_QUEUE_MAX_PER_CLIENT=1` (forwarded to
 * the spawned child via `paths.ts`'s `SERVER_ENV_ALLOWLIST`), TWO
 * concurrent requests from one client are not enough to see `busy` — the
 * second is simply queued behind the first (depth 0 -> admitted -> depth
 * 1). A THIRD request is what sees `depthFor(cid) >= 1` and gets rejected.
 * This test fires three calls on the SAME `SharedEmbeddingProvider`/
 * `ModelServerClient` (hence the same connection/cid) with no `await`
 * between them, so all three frames land on the server in send order while
 * the first is still the only one dispatched:
 *   1. a slow 40-text `embedDocumentBatch` — dispatched immediately;
 *   2. a fast `embedQuery` — queued behind it (depth becomes 1);
 *   3. a second fast `embedQuery` — sees depth 1 >= 1 and is rejected
 *      `busy`, which `SharedEmbeddingProvider.callWithBusyRetry()` retries.
 *
 * A warm-up call runs first (server spawn + model load) so the actual race
 * reflects steady-state per-call latency, not cold-start noise.
 *
 * Run: npx tsx test/model-server-busy-retry-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ModelServerClient } from '../packages/lore/src/modelServer/client.js';
import { SharedEmbeddingProvider } from '../packages/lore/src/modelServer/sharedEmbeddingProvider.js';
import { serverKey, pidPath } from '../packages/lore/src/modelServer/paths.js';
import { LocalEmbeddingProvider, DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from '../packages/lore/src/providers/localEmbeddingProvider.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-busy-retry-${tag}-`));
}

function readServerPid(loreHome: string): number | null {
    const key = serverKey(loreHome);
    const p = pidPath(loreHome, key);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').trim();
    return raw ? parseInt(raw, 10) : null;
}

function isAlive(pid: number): boolean {
    const res = spawnSync('ps', ['-p', String(pid)]);
    return res.status === 0 && res.stdout.toString().includes(String(pid));
}

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

console.log('model-server embed busy retry (SF11) — a forced per-client busy rejection retries then succeeds via shared, never exhausting to fallback\n');

const GENEROUS = { readyMs: 25_000, restartBudgetMs: 20_000, maxRestarts: 5, callMs: 30_000, probeMs: 1000 };

const savedQueueMax = process.env.LORE_MODEL_SERVER_QUEUE_MAX_PER_CLIENT;
process.env.LORE_MODEL_SERVER_QUEUE_MAX_PER_CLIENT = '1'; // forwarded to the spawned server child via SERVER_ENV_ALLOWLIST

const queryTextA = 'a quick query fired right behind the batch below, while it is still the only thing dispatched';
const queryTextB = 'a second quick query fired immediately after the first, which is what actually sees the full queue';
const batchTexts = Array.from({ length: 40 }, (_, i) => `slice d3 busy-retry fixture document number ${i} — enough real text to keep CPU inference from being instantaneous.`);

await test('a forced busy rejection retries with backoff and succeeds via shared (no exhaustion, no status change)', async () => {
    const home = mkLoreHome('main');
    const inProc = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });
    const [expectedQueryA, expectedQueryB, expectedBatch] = await Promise.all([
        inProc.embedQuery(queryTextA),
        inProc.embedQuery(queryTextB),
        inProc.embedDocumentBatch ? inProc.embedDocumentBatch(batchTexts) : Promise.all(batchTexts.map((t) => inProc.embedDocument(t))),
    ]);

    const infoLogs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const client = new ModelServerClient({ loreHome: home, clientId: 'sf11-busy-retry', ...GENEROUS });
    const shared = new SharedEmbeddingProvider({
        modelId: DEFAULT_LOCAL_MODEL_ID,
        dimension: DEFAULT_LOCAL_MODEL_DIM,
        client,
        log: { info: (msg, ctx) => infoLogs.push({ msg, ctx }) },
    });
    try {
        // Warm-up: establishes the connection and loads the model in the
        // server process, outside the timed race below.
        await shared.embedQuery('warm up call before the busy race');
        assert.equal(client.status().mode, 'shared');
        infoLogs.length = 0; // only care about logs from the race itself

        // No await between these three — all three frames go out on the
        // same connection while the batch call is still the only thing
        // dispatched (queueMaxPerClient=1): the batch is admitted and
        // dispatched immediately, queryA is admitted and queues behind it
        // (depth becomes 1), and queryB sees depth 1 >= 1 and is rejected
        // busy — see the file doc comment for why two calls isn't enough.
        const pBatch = shared.embedDocumentBatch(batchTexts);
        const pQueryA = shared.embedQuery(queryTextA);
        const pQueryB = shared.embedQuery(queryTextB);
        const [batchVecs, queryVecA, queryVecB] = await Promise.all([pBatch, pQueryA, pQueryB]);

        assert.deepEqual(batchVecs, expectedBatch, 'batch result must be bit-identical to in-process');
        assert.deepEqual(queryVecA, expectedQueryA, 'queryA result must be bit-identical to in-process');
        assert.deepEqual(queryVecB, expectedQueryB, 'queryB result must be bit-identical to in-process');
        assert.equal(client.status().mode, 'shared', 'a busy retry must not change modelStatus() out of shared');

        const retryLogs = infoLogs.filter((l) => l.msg.includes('busy — retrying'));
        assert.ok(retryLogs.length >= 1, `expected at least one busy-retry log; got: ${JSON.stringify(infoLogs)}`);

        const exhaustedFallbackLogs = infoLogs.filter((l) => l.msg.includes('falling back in-process for this one call') && l.ctx?.code === 'busy');
        assert.equal(exhaustedFallbackLogs.length, 0, `busy retry must succeed via shared before exhausting — must not fall back; got: ${JSON.stringify(exhaustedFallbackLogs)}`);

        trackHome(home);
    } finally {
        await client.dispose();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
cleanupAllTrackedPids();
if (savedQueueMax === undefined) delete process.env.LORE_MODEL_SERVER_QUEUE_MAX_PER_CLIENT; else process.env.LORE_MODEL_SERVER_QUEUE_MAX_PER_CLIENT = savedQueueMax;
if (failed > 0) process.exit(1);

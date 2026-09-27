#!/usr/bin/env tsx
/**
 * model-server-kill-mid-embed-unit.ts — D9 (3.24 slice C3c) release gate:
 * a `kill -9` on the shared model server WHILE a large `documentBatch`
 * embed request is genuinely in flight must not lose the caller's work —
 * a retry of the same logical call against a freshly-respawned server must
 * succeed, with output bit-identical to embedding the same input in-process
 * via `LocalEmbeddingProvider`.
 *
 * Retry shape (D9 §5.5 / O5, review blocker B): the client restarts first
 * and falls back only after that fails. The in-flight call's connection is
 * lost, the client destroys it, runs its restart loop (dead-pid lock
 * reclaim, no 15s stall), retries the call ONCE on the new server, and the
 * ORIGINAL promise resolves — no fallback, no `ModelServerUnavailableError`,
 * no in-process model load.
 *
 * Run: npx tsx test/model-server-kill-mid-embed-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ModelServerClient, type ModelStatus } from '../packages/lore/src/modelServer/client.js';
import { removeHome } from './helpers/model-server-home.js';
import { LocalEmbeddingProvider, DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from '../packages/lore/src/providers/localEmbeddingProvider.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-killmid-${tag}-`));
}
function isAlive(pid: number): boolean {
    const res = spawnSync('ps', ['-p', String(pid)]);
    return res.status === 0 && res.stdout.toString().includes(String(pid));
}
const spawnedPids = new Set<number>();
function trackPid(pid: number | null | undefined): void { if (pid) spawnedPids.add(pid); }
function cleanupAllTrackedPids(): void {
    for (const pid of spawnedPids) {
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
}
async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for: ${label}`);
}

console.log('D9 §6 release gate — kill -9 mid-embed: the in-flight call succeeds on a restarted server, bit-identical output\n');

const GENEROUS = { readyMs: 25_000, restartBudgetMs: 20_000, maxRestarts: 5, callMs: 30_000, probeMs: 1000 };

// A batch big/long enough to keep the CPU-bound embed pipeline busy for a
// couple of seconds, giving a comfortable in-flight window to kill into.
const BATCH: string[] = Array.from({ length: 140 }, (_, i) =>
    `Document ${i}: the quick brown fox jumps over the lazy dog near the riverbank while the old lighthouse keeper writes in his logbook about the tide tables and the migrating birds heading south for the winter season, entry number ${i}.`,
);

await test('kill -9 while a large documentBatch embed is in flight: the SAME call resolves via a restarted server with no fallback, bit-identical to in-process', async () => {
    const home = mkLoreHome('main');
    const statuses: ModelStatus[] = [];
    const errors: string[] = [];
    const client = new ModelServerClient({
        loreHome: home,
        clientId: 'gate-kill-mid-embed',
        ...GENEROUS,
        log: { error: (m) => errors.push(m), warn: () => {} },
        onStatus: (s) => statuses.push(s),
    });
    try {
        // Warm the connection first so we have a real pid to kill and the
        // big request is written immediately.
        await client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'warm up' });
        const pidBefore = client.status().server?.pid;
        assert.ok(pidBefore, 'expected a real server pid after the warm-up call');
        trackPid(pidBefore);

        const inFlight = client.embed({ op: 'documentBatch', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, texts: BATCH });
        // Give the request a moment to be genuinely in flight, then kill
        // the process working on it.
        await new Promise((r) => setTimeout(r, 300));
        process.kill(pidBefore!, 'SIGKILL');

        const result = await inFlight; // must NOT reject
        assert.ok(result.vectors, 'the in-flight call must resolve with vectors');
        assert.equal(result.vectors!.length, BATCH.length);
        for (const v of result.vectors!) assert.equal(v.length, DEFAULT_LOCAL_MODEL_DIM);

        assert.equal(client.status().mode, 'shared', 'restart-first: the client must never have left shared mode');
        assert.ok(!statuses.some((s) => s.mode === 'fallback'), 'no fallback status may have been emitted');
        assert.ok(!errors.some((m) => m.includes('falling back')), 'no loud fallback may have been logged');
        const pidAfter = client.status().server?.pid;
        assert.ok(pidAfter, 'expected a real server pid after the retried call');
        assert.notEqual(pidAfter, pidBefore, 'the retried call must have gone through a FRESH server process');
        trackPid(pidAfter);

        const inProcessProvider = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });
        const inProcVecs = await inProcessProvider.embedDocumentBatch(BATCH);
        assert.deepEqual(result.vectors, inProcVecs);

        await waitFor(() => isAlive(pidAfter!), 2000, 'restarted server still alive right after serving the call');
    } finally {
        await client.dispose();
        await removeHome(home);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
cleanupAllTrackedPids();
if (failed > 0) process.exit(1);

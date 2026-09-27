#!/usr/bin/env tsx
/**
 * d9-model-server-release-gate-unit.ts — D9 (3.24 slice C3a) release-gate
 * suite (D9 §6), covering the items NOT already exercised by the existing
 * `test/model-server-*.ts` files:
 *
 *   - 4 independent hosts against the same loreHome converge on exactly
 *     ONE spawned server (existing coverage: only 2, in
 *     model-server-client-lifecycle-unit.ts).
 *   - stale-lock reclaim, BOTH signals in clientConnection.ts's
 *     `spawnOrConnect()` exercised directly and independently: (a) a dead
 *     pid in `pidPath` reclaims immediately, with no 15s stall; (b) a lock
 *     with no pidfile yet, older than `EMPTY_LOCK_STALE_MS` (spawnLock.ts), reclaims via the
 *     age fallback. (Existing "stale socket" coverage kills a real server
 *     and always leaves a pidfile behind — it never isolates the
 *     age-only fallback path, which needs a lock with NO pidfile at all.)
 *   - rerank fail-open: an aborted call must reject without the client
 *     ever treating the connection as dead (client.ts's rerank() passes
 *     the caller's own AbortSignal with no client-imposed deadline
 *     specifically so a slow-but-alive server fails open — see its
 *     doc comment). Proven with a PRE-aborted signal, which
 *     clientConnection.ts's `call()` rejects before ever writing the
 *     request frame to the socket — no real rerank model needed.
 *   - security: embed payload text must never appear in the model
 *     server's own log file (`connection.ts`'s debug logs record only
 *     `{id, op, ms}` / `{id, passages: length, ms}`, never content).
 *
 * NOT covered here — see this slice's report for why: env-allowlist
 * end-to-end (macOS/Darwin has no equivalent of Linux's
 * `/proc/<pid>/environ`, and `ps`/`ps -E` do not expose another process's
 * env on this sandboxed host either, even same-user — the filtering logic
 * itself, `spawnServerChild()` in clientConnection.ts, was read and
 * confirmed correct by inspection: it builds an allowlist-only `env`
 * object from scratch, never spreads `process.env`).
 *
 * Run: npx tsx test/d9-model-server-release-gate-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ModelServerClient } from '../packages/lore/src/modelServer/client.js';
import { ModelServerConnection } from '../packages/lore/src/modelServer/clientConnection.js';
import { serverKey, runDir, lockPath, pidPath, logPath } from '../packages/lore/src/modelServer/paths.js';
import { LocalEmbeddingProvider, DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { removeHome } from './helpers/model-server-home.js';
void LocalEmbeddingProvider; // imported for parity with sibling test files' pattern; not otherwise used directly here

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-gate-${tag}-`));
}

function isAlive(pid: number): boolean {
    const res = spawnSync('ps', ['-p', String(pid)]);
    return res.status === 0 && res.stdout.toString().includes(String(pid));
}

const spawnedPids = new Set<number>();
function trackPid(pid: number | null | undefined): void {
    if (pid) spawnedPids.add(pid);
}
function cleanupAllTrackedPids(): void {
    for (const pid of spawnedPids) {
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
}

console.log('D9 §6 release-gate suite — 4-host convergence, stale-lock reclaim, rerank fail-open, no-payload-in-log\n');

const GENEROUS = { readyMs: 25_000, restartBudgetMs: 20_000, maxRestarts: 5, callMs: 30_000, probeMs: 1000 };

// ---------------------------------------------------------------------
await test('4 independent hosts against the same loreHome converge on exactly one server process', async () => {
    const home = mkLoreHome('four-hosts');
    const clients = Array.from({ length: 4 }, (_, i) => new ModelServerClient({ loreHome: home, clientId: `gate-host-${i}`, ...GENEROUS }));
    try {
        const results = await Promise.all(clients.map((c, i) => c.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: `host ${i}` })));
        for (const r of results) assert.ok(r.vectors && r.vectors[0]?.length === DEFAULT_LOCAL_MODEL_DIM);
        const pids = clients.map((c) => c.status().server?.pid);
        for (const p of pids) assert.ok(p, 'every client must report a server pid');
        const distinctPids = new Set(pids);
        assert.equal(distinctPids.size, 1, `all 4 hosts must have converged on the SAME server process, saw pids: ${[...distinctPids].join(',')}`);
        for (const p of pids) trackPid(p);
    } finally {
        await Promise.all(clients.map((c) => c.dispose()));
        await removeHome(home);
    }
});

// ---------------------------------------------------------------------
await test('stale lock reclaimed via dead-pid signal — no 15s stall', async () => {
    const home = mkLoreHome('stale-deadpid');
    const key = serverKey(home);
    fs.mkdirSync(runDir(home, key), { recursive: true, mode: 0o700 }); // SF5: the run dir must be private
    // A guaranteed-dead pid: spawnSync blocks until the child has fully
    // exited and been reaped, so by the time we read `.pid` the process no
    // longer exists (astronomically unlikely to be reused within this
    // test's lifetime).
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(dead.pid, 'expected a pid from the short-lived helper process');
    fs.writeFileSync(pidPath(home, key), String(dead.pid));
    fs.writeFileSync(lockPath(home, key), ''); // fresh mtime — must NOT need the 15s age fallback to reclaim
    const startedAt = Date.now();
    const conn = await ModelServerConnection.spawnOrConnect({ loreHome: home, key, readyMs: 25_000, clientId: 'gate-deadpid' });
    const elapsedMs = Date.now() - startedAt;
    try {
        assert.ok(elapsedMs < 12_000, `dead-pid reclaim must not wait out the 15s age fallback — took ${elapsedMs}ms`);
        const pid = Number(fs.readFileSync(pidPath(home, key), 'utf8').trim());
        assert.ok(Number.isInteger(pid) && pid > 0 && pid !== dead.pid, 'a fresh server must have been spawned under a NEW pid');
        trackPid(pid);
    } finally {
        await conn.close();
        await removeHome(home);
    }
});

// ---------------------------------------------------------------------
await test('stale lock reclaimed via age fallback — no pidfile at all', async () => {
    const home = mkLoreHome('stale-age');
    const key = serverKey(home);
    fs.mkdirSync(runDir(home, key), { recursive: true, mode: 0o700 }); // SF5: the run dir must be private
    // Lock present, but NO pidfile — the narrower race where a process
    // died between taking the lock and ever registering its pid. Backdate
    // the lock's mtime well past EMPTY_LOCK_STALE_MS (15s, spawnLock.ts; empty lock only)
    // so the age check alone must be what reclaims it.
    const lock = lockPath(home, key);
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(lock, old, old);
    assert.ok(!fs.existsSync(pidPath(home, key)), 'precondition: no pidfile must exist yet for this to isolate the age-only path');
    const conn = await ModelServerConnection.spawnOrConnect({ loreHome: home, key, readyMs: 25_000, clientId: 'gate-stale-age' });
    try {
        const pid = Number(fs.readFileSync(pidPath(home, key), 'utf8').trim());
        assert.ok(Number.isInteger(pid) && pid > 0, 'a fresh server must have spawned and registered its own pid');
        trackPid(pid);
    } finally {
        await conn.close();
        await removeHome(home);
    }
});

// ---------------------------------------------------------------------
await test('rerank: an aborted call fails open — status stays shared, connection stays usable, no restart', async () => {
    const home = mkLoreHome('rerank-abort');
    const client = new ModelServerClient({ loreHome: home, clientId: 'gate-rerank-abort', ...GENEROUS });
    try {
        // Warm the connection to a real 'shared' status first.
        await client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'warm up' });
        assert.equal(client.status().mode, 'shared');

        const controller = new AbortController();
        controller.abort(); // pre-aborted: clientConnection.ts's call() rejects before ever writing to the socket — no real rerank model/cache needed.
        await assert.rejects(
            () => client.rerank({ modelId: 'dummy-model', cacheDir: os.tmpdir(), query: 'q', passages: ['a', 'b'] }, controller.signal),
            (err: unknown) => err instanceof Error && err.name === 'AbortError',
        );
        assert.equal(client.status().mode, 'shared', 'an aborted rerank call must NEVER be treated as a dead connection — status must stay shared, not flip to fallback');

        const pidBefore = client.status().server?.pid;
        const { vectors } = await client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'still alive after abort' });
        assert.ok(vectors && vectors[0]?.length === DEFAULT_LOCAL_MODEL_DIM, 'the SAME connection must still serve real calls after the aborted rerank');
        assert.equal(client.status().server?.pid, pidBefore, 'no restart must have happened because of the aborted call');
        trackPid(pidBefore);
    } finally {
        await client.dispose();
        await removeHome(home);
    }
});

// ---------------------------------------------------------------------
await test('security: embed payload text never appears in the model server\'s own log file', async () => {
    const home = mkLoreHome('no-payload-log');
    const key = serverKey(home);
    const prevLogLevel = process.env.LORE_LOG_LEVEL;
    process.env.LORE_LOG_LEVEL = 'debug'; // SERVER_ENV_ALLOWLIST-carried, so the spawned server logs at debug too
    const CANARY = 'CANARY-PAYLOAD-8f21c-must-never-be-logged-verbatim';
    const client = new ModelServerClient({ loreHome: home, clientId: 'gate-no-payload', ...GENEROUS });
    try {
        await client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: CANARY });
        trackPid(client.status().server?.pid);
        const file = logPath(home);
        const deadline = Date.now() + 5_000;
        let content = '';
        while (Date.now() < deadline) {
            content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
            if (content.includes('embed ok')) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(content.includes('embed ok'), `expected the server's debug log at ${file} to record the embed call at all (structural sanity check before the negative assertion)`);
        assert.ok(!content.includes(CANARY), `the embed payload text must never appear verbatim in the server's own log file (${file})`);
        void key;
    } finally {
        await client.dispose();
        if (prevLogLevel === undefined) delete process.env.LORE_LOG_LEVEL; else process.env.LORE_LOG_LEVEL = prevLogLevel;
        await removeHome(home);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
cleanupAllTrackedPids();
if (failed > 0) process.exit(1);

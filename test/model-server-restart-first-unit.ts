#!/usr/bin/env tsx
/**
 * model-server-restart-first-unit.ts — Lore 3.24 D1, review blocker B (O5)
 * and SF2/SF3: on a lost connection or a missed deadline the client
 * restarts the server and retries the call once BEFORE it falls back.
 *
 *  1. Two embeds in flight when the server is kill -9'd: both resolve, and
 *     exactly one replacement server is started (single-flight recovery).
 *  2. A wedged server (answers hello, then nothing; ignores shutdown and
 *     SIGTERM): the call's deadline fires, the client asks it to shut down,
 *     escalates to SIGKILL, restarts a real server and the call succeeds —
 *     all within a bounded time.
 *  3. Crash loop (SF2): the server dies between calls three times → loud
 *     fallback with a "crash loop" reason, and no further server is started.
 *
 * Run: npx tsx test/model-server-restart-first-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ModelServerClient, ModelServerUnavailableError, type ModelStatus } from '../packages/lore/src/modelServer/client.js';
import { DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { removeHome, startedServerPids, isProcessAlive, waitForProcessExit } from './helpers/model-server-home.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEDGED = path.join(here, 'helpers', 'wedged-model-server.ts');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

const GENEROUS = { readyMs: 25_000, restartBudgetMs: 20_000, maxRestarts: 5, callMs: 30_000, probeMs: 1000 };
const mkHome = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-restart-${tag}-`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const query = (client: ModelServerClient, text: string) =>
    client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text });

function recorder() {
    const errors: string[] = [];
    const warns: string[] = [];
    const statuses: ModelStatus[] = [];
    return { errors, warns, statuses, log: { error: (m: string) => errors.push(m), warn: (m: string) => warns.push(m) }, onStatus: (s: ModelStatus) => statuses.push(s) };
}

async function killAndWait(pid: number): Promise<void> {
    process.kill(pid, 'SIGKILL');
    assert.ok(await waitForProcessExit(pid, 5_000), `pid ${pid} must exit after SIGKILL`);
    await sleep(200); // let the client's socket see the close
}

console.log('model-server restart-first (O5) — restart and retry once before falling back\n');

await test('kill -9 with two embeds in flight: both resolve on ONE replacement server, no fallback', async () => {
    const home = mkHome('two');
    const rec = recorder();
    const client = new ModelServerClient({ loreHome: home, clientId: 'restart-two', ...GENEROUS, log: rec.log, onStatus: rec.onStatus });
    try {
        await query(client, 'warm up');
        const before = client.status().server!.pid!;
        // Big enough that neither call can finish before the kill lands.
        const texts = Array.from({ length: 400 }, (_, i) =>
            `Document ${i}: the quick brown fox jumps over the lazy dog near the riverbank while the old lighthouse keeper writes about tide tables and migrating birds, entry ${i}.`);
        let settledBeforeKill = 0;
        const a = client.embed({ op: 'documentBatch', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, texts });
        const b = client.embed({ op: 'documentBatch', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, texts: texts.slice(0, 200) });
        void a.finally(() => { settledBeforeKill++; }).catch(() => {});
        void b.finally(() => { settledBeforeKill++; }).catch(() => {});
        await sleep(150);
        const settledAtKill = settledBeforeKill;
        process.kill(before, 'SIGKILL');
        assert.equal(settledAtKill, 0, 'both calls must still be in flight when the server is killed');
        const [ra, rb] = await Promise.all([a, b]);
        assert.equal(ra.vectors?.length, 400);
        assert.equal(rb.vectors?.length, 200);
        assert.equal(client.status().mode, 'shared');
        assert.ok(!rec.statuses.some((s) => s.mode === 'fallback'), 'no fallback may be emitted');
        const after = client.status().server!.pid!;
        assert.notEqual(after, before);
        assert.equal(startedServerPids(home).length, 2, `exactly one replacement server: ${JSON.stringify(startedServerPids(home))}`);
    } finally {
        await client.dispose();
        await removeHome(home);
    }
});

await test('a wedged server is shut down / SIGKILLed, a real server is restarted, and the call succeeds within budget', async () => {
    const home = mkHome('wedged');
    const fake = spawn(process.execPath, [...process.execArgv, WEDGED], { env: { ...process.env, LORE_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
    const fakePid = fake.pid!;
    const rec = recorder();
    const callMs = 5_000;
    const client = new ModelServerClient({ loreHome: home, clientId: 'restart-wedged', ...GENEROUS, callMs, log: rec.log, onStatus: rec.onStatus });
    try {
        await new Promise<void>((resolve, reject) => {
            let out = '';
            const t = setTimeout(() => reject(new Error(`wedged fake never listened: ${out}`)), 20_000);
            fake.stdout!.on('data', (d) => { out += d; if (out.includes('listening')) { clearTimeout(t); resolve(); } });
            fake.once('exit', (code) => { clearTimeout(t); reject(new Error(`wedged fake exited ${code}: ${out}`)); });
        });
        const started = Date.now();
        const res = await query(client, 'hello through a wedge');
        const elapsed = Date.now() - started;
        assert.equal(res.vectors?.[0]?.length, DEFAULT_LOCAL_MODEL_DIM, 'the call must succeed on the restarted server');
        assert.equal(client.status().mode, 'shared');
        assert.ok(!rec.statuses.some((s) => s.mode === 'fallback'), 'no fallback may be emitted');
        assert.ok(!isProcessAlive(fakePid), 'the wedged server must be dead');
        assert.ok(rec.warns.some((m) => m.includes(`pid ${fakePid} unresponsive; sending SIGKILL`)), `SIGKILL escalation must be logged: ${JSON.stringify(rec.warns)}`);
        const newPid = client.status().server!.pid!;
        assert.notEqual(newPid, fakePid);
        // callMs (the wedge) + shutdown/SIGTERM/SIGKILL steps (1s each) + a
        // server start and model load (readyMs) + the retried call.
        const budget = callMs + 3 * 1_000 + GENEROUS.readyMs + callMs;
        assert.ok(elapsed < budget, `recovery took ${elapsed}ms, budget ${budget}ms`);
        console.log(`    (wedge → recovered in ${elapsed}ms)`);
    } finally {
        await client.dispose();
        await removeHome(home, [fakePid]);
    }
});

await test('crash loop (SF2): three deaths between calls → loud "crash loop" fallback, and no respawn', async () => {
    const home = mkHome('loop');
    const rec = recorder();
    const client = new ModelServerClient({ loreHome: home, clientId: 'restart-loop', ...GENEROUS, log: rec.log, onStatus: rec.onStatus });
    try {
        await query(client, 'call 0');
        for (let i = 1; i <= 2; i++) {
            await killAndWait(client.status().server!.pid!);
            await query(client, `call ${i}`); // death i: restarted, still shared
            assert.equal(client.status().mode, 'shared', `after death ${i} the client must still be shared`);
        }
        await killAndWait(client.status().server!.pid!);
        const startedBefore = startedServerPids(home).length;
        await assert.rejects(() => query(client, 'call 3'), (err: unknown) => {
            assert.ok(err instanceof ModelServerUnavailableError);
            assert.match(err.reason, /crash loop/);
            return true;
        });
        const st = client.status();
        assert.equal(st.mode, 'fallback');
        assert.match(st.reason ?? '', /crash loop: model server connection lost 3 times/);
        assert.ok(rec.errors.some((m) => m.includes('falling back') && m.includes('crash loop')), 'crash-loop fallback must be loud');
        await sleep(3_000);
        assert.equal(startedServerPids(home).length, startedBefore, 'no server may be started once in a crash loop');
        assert.equal(startedBefore, 3, 'three servers total: the original and two restarts');
    } finally {
        await client.dispose();
        await removeHome(home);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

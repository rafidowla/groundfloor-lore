#!/usr/bin/env tsx
/**
 * model-server-fallback-release-unit.ts — Lore 3.24 review slice D3, SF10
 * (D9 §5.5.3): when a `SharedEmbeddingProvider` has lazily created an
 * in-process fallback embedding model (because the shared server was
 * unreachable) and the client later recovers back to `shared`, the
 * fallback model must be released — not left resident for the rest of the
 * process's life — via `SharedEmbeddingProvider.releaseFallback()`, wired
 * into `modelServer/applicability.ts`'s `attachModelServer()` `onStatus`
 * callback on the fallback->shared transition.
 *
 * This drives the REAL integration path — `attachModelServer()` — rather
 * than re-implementing the onStatus wiring in the test, using the same
 * "unspawnable-within-budget forces a loud fallback, then the background
 * recovery probe self-heals it" pattern already proven in
 * `model-server-client-lifecycle-unit.ts`. The three timing env vars below
 * are read ONCE by `applicability.ts` at module-import time (they back
 * module-level `parseEnvInt(...)` constants, not per-call options), so they
 * are set before that module is ever imported — hence the dynamic import
 * below instead of a static one.
 *
 * A short `LORE_MODEL_SERVER_PROBE_MS` is used deliberately (NOT lengthened
 * to outrun the first fallback call's cold model load): recovery routinely
 * gets detected WHILE that first call is still in flight, which is exactly
 * the race `SharedEmbeddingProvider.releaseFallback()`'s bounded retry
 * (found and fixed by this test — see its own doc comment) exists to
 * handle, since `releaseLocalEmbeddingPipeline()` correctly declines to
 * dispose an in-flight entry and nothing else re-triggers a release once
 * this instance has dropped its own reference.
 *
 * Run: npx tsx test/model-server-fallback-release-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

process.env.LORE_MODEL_SERVER = '1'; // opt this test process into eligibility
process.env.LORE_MODEL_SERVER_READY_MS = '150';
process.env.LORE_MODEL_SERVER_RESTART_BUDGET_MS = '50';
process.env.LORE_MODEL_SERVER_RESTARTS = '1';
process.env.LORE_MODEL_SERVER_PROBE_MS = '500';
delete process.env.LORE_LOCAL_EMBEDDING_DEVICE;

const { attachModelServer } = await import('../packages/lore/src/modelServer/applicability.js');
const {
    LocalEmbeddingProvider,
    DEFAULT_LOCAL_MODEL_ID,
    DEFAULT_LOCAL_MODEL_DIM,
    _pipelineCacheSizeForTests,
    _resetLocalEmbeddingPipelineForTests,
} = await import('../packages/lore/src/providers/localEmbeddingProvider.js');
const { serverKey, pidPath } = await import('../packages/lore/src/modelServer/paths.js');
type PublicModelStatus = Awaited<ReturnType<typeof attachModelServer>>['modelStatus'] extends () => infer R ? R : never;

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-fallback-release-${tag}-`));
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

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (fn()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
        await new Promise((r) => setTimeout(r, 100));
    }
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

console.log('model-server fallback release (SF10) — real attachModelServer(), fallback->shared recovery frees the local model\n');

await test('fallback creates a local pipeline; recovery to shared releases it and logs at info', async () => {
    const home = mkLoreHome('main');
    _resetLocalEmbeddingPipelineForTests();
    const infoLogs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const statuses: PublicModelStatus[] = [];
    const provider = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });
    const attachment = attachModelServer({
        loreHome: home,
        deploymentMode: 'local',
        embeddingProvider: provider,
        injectedEmbeddingProvider: false,
        clientId: 'sf10-fallback-release',
        onModelStatus: (s) => statuses.push(s),
        log: {
            warn: () => {},
            error: () => {},
            debug: () => {},
            info: (msg, ctx) => infoLogs.push({ msg, ctx }),
        },
    });
    try {
        // The shared server can't boot within 150ms, so this call must
        // transparently succeed via the lazily-created LOCAL fallback
        // inside SharedEmbeddingProvider — SharedEmbeddingProvider never
        // surfaces ModelServerUnavailableError to its own callers.
        const vec = await attachment.embeddingProvider.embedQuery('hello from the fallback path');
        assert.equal(vec.length, DEFAULT_LOCAL_MODEL_DIM);
        // Checked against the RECORDED status history, not a synchronous
        // `attachment.modelStatus()` read right after this call: the local
        // fallback's own model load can take longer than the background
        // recovery probe interval, so by the time this awaited call
        // resolves, status may already have raced ahead to 'shared' — the
        // onStatus history is what proves the transition actually happened.
        assert.ok(statuses.some((s) => s.mode === 'fallback'), 'onStatus must have recorded a fallback transition');
        assert.ok(_pipelineCacheSizeForTests() >= 1, 'the local fallback must have actually loaded a real pipeline');

        // The detached server this failed attempt spawned keeps booting in
        // the background; the recovery probe should pick it up shortly.
        await waitFor(() => attachment.modelStatus().mode === 'shared', 25_000, 'attachment.modelStatus().mode to recover to shared');
        assert.ok(statuses.some((s) => s.mode === 'shared'), 'onStatus must have fired a recovery status');

        // releaseFallback() is invoked synchronously inside the onStatus
        // callback on the fallback->shared transition, but the actual
        // release can be DEFERRED past that point: the first fallback call's
        // cold model load is often still in flight when recovery is
        // detected, and releaseLocalEmbeddingPipeline() correctly declines
        // to dispose an in-flight entry. releaseFallback()'s own bounded
        // retry (~15.75s worst case) covers that gap — this timeout must
        // comfortably exceed it.
        await waitFor(() => _pipelineCacheSizeForTests() === 0, 20_000, 'pipeline cache to drop to 0 after release');

        const released = infoLogs.find((l) => l.msg.includes('released in-process fallback embedding model'));
        assert.ok(released, `expected an info log announcing the release; got: ${JSON.stringify(infoLogs)}`);
        assert.equal(released!.ctx?.pipelineReleased, true, 'the release log must report that a pipeline was actually released');
        assert.equal(released!.ctx?.modelId, DEFAULT_LOCAL_MODEL_ID);

        trackHome(home);
    } finally {
        await attachment.dispose();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
cleanupAllTrackedPids();
if (failed > 0) process.exit(1);

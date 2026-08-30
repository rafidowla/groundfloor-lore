#!/usr/bin/env tsx
/**
 * test/worker-embed-overrides-unit.ts — proves that when
 * VerbatimSearchWorkerProxy is constructed with `embedOverrides`, the real
 * forked search-worker CHILD PROCESS actually receives them via the
 * LORE_WORKER_EMBED_OVERRIDES env var (verbatimSearchWorkerEntry.ts reads
 * this to build the child's embedding provider — see services.ts
 * createEmbeddingProvider). A bug that dropped/ignored overrides (e.g. always
 * forking with the parent's bare env) would silently fall back to the
 * default embedding model in every worker-isolated workspace.
 *
 * Why inspect the real forked process's OS environment instead of waiting
 * for the worker to report `ready`: the override modelId used here
 * ('test-model-xyz') is a synthetic fixture, not a real HF model id — letting
 * the child actually try to load it would either hang on a network fetch or
 * fail non-deterministically depending on network access, and neither result
 * says anything about whether the ENV VAR ITSELF was propagated correctly.
 * That propagation is a synchronous fact: `VerbatimSearchWorkerProxy.spawn()`
 * builds the `env` object and calls the real `child_process.fork()`
 * synchronously (before any `await`), so by the time `initialize()` yields
 * control the real child process already exists with its real env block. We
 * read it straight back out of the OS via `ps -Eww` (macOS/BSD), then
 * SIGKILL the child — no network, no model load, no ready-timeout budget.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Dynamic imports here (not static) match the sibling worker-isolation test
// this file is modeled after (test/verbatim-search-worker-e2e.ts) and the
// wider convention for standalone tsx scripts under test/ that reach into
// packages/lore/src/*.js directly — see test/audit-bw1-token-store-unit.ts,
// test/auth-ephemeral-token-unit.ts, etc. for the same top-level pattern.
const { VerbatimSearchWorkerProxy } =
    await import('../packages/lore/src/engines/verbatimSearchWorkerProxy.js');
const { WORKER_ENV } =
    await import('../packages/lore/src/engines/verbatimWorkerProtocol.js');

/** Proxy-internal fields (`child`, `.pid`) are TS-private, not JS-private —
 *  accessible at runtime. Named once here (not inline-cast at each call
 *  site) so the assumed shape is stated in exactly one place. */
type ProxyInternals = { child: ChildProcess | null };

function sleep(ms: number): Promise<void> {
    let resolve: (v: void | PromiseLike<void>) => void = () => {};
    let reject: (e?: unknown) => void = () => {};
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    setTimeout(resolve, ms);
    return promise;
}

let passed = 0;
let failed = 0;

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name} — ${(err as Error).message}`);
        failed++;
    }
}

/**
 * Reads one env var's raw value out of a LIVE process's environment via
 * `ps -Eww <pid>` (BSD/macOS `ps`; `-E` prints the env block, `-ww`
 * disables truncation). Retried briefly: a just-fork()'d process may need a
 * beat before its env block is visible to `ps`, and the child here is racing
 * to (unsuccessfully) load a fake model, so it can also exit mid-poll.
 */
async function readChildEnvVar(pid: number, name: string): Promise<string | undefined> {
    const pattern = new RegExp(`[ \\t]${name}=(\\S*)`);
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const out = execFileSync('ps', ['-Eww', '-p', String(pid)], { encoding: 'utf8' });
            const match = out.match(pattern);
            if (match) return match[1];
        } catch {
            // `ps` exits non-zero once the pid is gone — stop polling, nothing left to read.
            return undefined;
        }
        await sleep(25);
    }
    return undefined;
}

/**
 * Constructs a real VerbatimSearchWorkerProxy, kicks off `initialize()`
 * (fire-and-forget — it will never resolve for a fake model id, and we don't
 * need it to), grabs the real child's pid, reads back the requested env vars
 * from the OS, then SIGKILLs the child. Returns the captured raw values.
 */
async function spawnAndCaptureEnv(
    basePath: string,
    embedOverrides: Record<string, unknown> | undefined,
    names: readonly string[],
): Promise<Record<string, string | undefined>> {
    const proxy = new VerbatimSearchWorkerProxy(basePath, embedOverrides);
    const internals = proxy as unknown as ProxyInternals; // documented shape — see ProxyInternals
    // Fire-and-forget: for a fake modelId this call will hang or eventually
    // reject once the pipeline fetch fails. Either way it never affects the
    // env-propagation fact we're checking, so swallow the rejection.
    proxy.initialize().catch(() => { /* expected: fake model never loads */ });

    // spawn() builds env + calls the real fork() synchronously before the
    // first `await` inside initialize()/ensureChild(), so `child` should
    // already be set. Poll briefly regardless, to be robust to scheduling.
    let pid: number | undefined;
    for (let attempt = 0; attempt < 40 && pid === undefined; attempt++) {
        pid = internals.child?.pid;
        if (pid === undefined) await sleep(10);
    }
    assert.ok(pid !== undefined, 'proxy must have forked a real child process with a pid');

    try {
        const result: Record<string, string | undefined> = {};
        for (const name of names) {
            result[name] = await readChildEnvVar(pid, name);
        }
        return result;
    } finally {
        try { internals.child?.kill('SIGKILL'); } catch { /* best-effort */ }
    }
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-embed-overrides-unit-'));

try {
    await it('child receives the exact JSON-serialized embedOverrides via LORE_WORKER_EMBED_OVERRIDES', async () => {
        const overrides = { device: 'cpu-test', modelId: 'test-model-xyz' };
        const basePath = path.join(HOME, 'ws-a');
        fs.mkdirSync(basePath, { recursive: true });

        const env = await spawnAndCaptureEnv(basePath, overrides, [WORKER_ENV.EMBED_OVERRIDES]);
        const raw = env[WORKER_ENV.EMBED_OVERRIDES];
        assert.ok(raw !== undefined, `${WORKER_ENV.EMBED_OVERRIDES} must be set on the child's env`);
        assert.equal(raw, JSON.stringify(overrides), 'child env var must be the exact JSON.stringify of the overrides object');

        const parsed = JSON.parse(decodeURIComponent(raw!)) as { device: string; modelId: string };
        assert.equal(parsed.device, 'cpu-test', 'device override must round-trip to the child unchanged');
        assert.equal(parsed.modelId, 'test-model-xyz', 'modelId override must round-trip to the child unchanged');
    });

    await it('child also receives the correct workspace base path and worker marker (sanity on the capture method itself)', async () => {
        const overrides = { device: 'cpu-test', modelId: 'test-model-xyz' };
        const basePath = path.join(HOME, 'ws-b');
        fs.mkdirSync(basePath, { recursive: true });

        const env = await spawnAndCaptureEnv(basePath, overrides, [WORKER_ENV.BASE_PATH, WORKER_ENV.IS_WORKER]);
        assert.equal(env[WORKER_ENV.BASE_PATH], basePath, 'the forked child must receive the exact workspace base path');
        assert.equal(env[WORKER_ENV.IS_WORKER], '1', 'the forked child must be marked as a search worker');
    });

    await it('a proxy constructed WITHOUT embedOverrides does NOT set LORE_WORKER_EMBED_OVERRIDES on the child (no stale/default leakage)', async () => {
        const basePath = path.join(HOME, 'ws-c');
        fs.mkdirSync(basePath, { recursive: true });

        const env = await spawnAndCaptureEnv(basePath, undefined, [WORKER_ENV.EMBED_OVERRIDES]);
        assert.equal(env[WORKER_ENV.EMBED_OVERRIDES], undefined, 'omitting embedOverrides must leave the env var entirely unset — not "{}", not a default value');
    });

    await it('two proxies with DIFFERENT embedOverrides fork children with DIFFERENT env values (not a shared/cached default)', async () => {
        const overridesA = { device: 'cpu-test', modelId: 'test-model-xyz' };
        const overridesB = { device: 'coreml', modelId: 'another-model-abc' };
        const basePathA = path.join(HOME, 'ws-d');
        const basePathB = path.join(HOME, 'ws-e');
        fs.mkdirSync(basePathA, { recursive: true });
        fs.mkdirSync(basePathB, { recursive: true });

        const [envA, envB] = await Promise.all([
            spawnAndCaptureEnv(basePathA, overridesA, [WORKER_ENV.EMBED_OVERRIDES]),
            spawnAndCaptureEnv(basePathB, overridesB, [WORKER_ENV.EMBED_OVERRIDES]),
        ]);

        assert.equal(envA[WORKER_ENV.EMBED_OVERRIDES], JSON.stringify(overridesA), 'proxy A child must carry proxy A\'s overrides');
        assert.equal(envB[WORKER_ENV.EMBED_OVERRIDES], JSON.stringify(overridesB), 'proxy B child must carry proxy B\'s overrides');
        assert.notEqual(envA[WORKER_ENV.EMBED_OVERRIDES], envB[WORKER_ENV.EMBED_OVERRIDES], 'sibling proxies must not leak each other\'s overrides');
    });
} finally {
    fs.rmSync(HOME, { recursive: true, force: true });
}

console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log('OK');
process.exit(0);

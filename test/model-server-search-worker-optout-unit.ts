#!/usr/bin/env tsx
/**
 * model-server-search-worker-optout-unit.ts — D9 (3.24 slice C3a), gap fix
 * #1: a search worker forked WITHOUT a `parentEmbedder` builds its own
 * embedding provider and used to call `attachModelServer()` with no
 * `modelServer` option at all (verbatimSearchWorkerEntry.ts) — so a host
 * that constructed `createLore({ modelServer: false })` still had that
 * worker's own child attach to the shared model server on its own. The
 * host's opt-out only ever reached the PARENT's own `attachModelServer`
 * call, never the child's.
 *
 * The fix threads the opt-out through a new env var
 * (`WORKER_ENV.MODEL_SERVER`, set to `'0'` by
 * `VerbatimSearchWorkerProxy.spawn()` when its new `modelServer` ctor param
 * is `false`) so the child's own `attachModelServer()` call passes
 * `modelServer: false` too when the parent opted out.
 *
 * This proves the fix at the observable-side-effect level: when eligible
 * (LORE_MODEL_SERVER='1' opts a test process in) and NOT opted out, the
 * child's `attachModelServer` constructs a real `ModelServerClient`, whose
 * first real embed call reaches `ModelServerConnection`'s spawn-or-connect
 * path far enough to create the run directory + lock file under that
 * worker's own `LORE_HOME` (clientConnection.ts:210-211, unconditional on
 * whether the actual server process finishes booting). When opted out via
 * `modelServer: false` on the proxy, NO such directory is ever created —
 * `attachModelServer` short-circuits to a no-op passthrough, exactly as it
 * does for a legitimately-ineligible host.
 *
 * Never asserts the shared server actually reaches 'shared' status — that
 * would require a cold model load in the CHILD's OWN model-server child
 * (a grandchild fork) and is already covered end-to-end by
 * model-server-client-lifecycle-unit.ts / the Gap-2 `_meta.models` test in
 * this same slice. Here we only need proof that a spawn attempt was (or
 * was not) made — the run dir + lock file are created synchronously at the
 * START of that attempt, before any child process is even forked.
 *
 * Run: npx tsx test/model-server-search-worker-optout-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { serverKey, runDir } from '../packages/lore/src/modelServer/paths.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

function mkHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `ms-worker-optout-${tag}-`));
}

async function main() {
    console.log('model-server search-worker opt-out — no-parentEmbedder child respects modelServer:false (3.24 C3a gap fix)\n');

    // Opt a test process into shared-model-server eligibility (normally
    // gated off inside a test process — see applicability.ts's
    // isTestProcess() check) and give both the client and the worker itself
    // a generous budget so a cold spawn attempt has time to reach the
    // lock-file step even on a loaded CI-style machine.
    process.env.LORE_MODEL_SERVER = '1';
    process.env.LORE_MODEL_SERVER_READY_MS ??= '15000';
    process.env.LORE_MODEL_SERVER_RESTART_BUDGET_MS ??= '15000';
    process.env.LORE_MODEL_SERVER_RESTARTS ??= '1';
    process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';
    delete process.env.LORE_LOCAL_EMBEDDING_DEVICE; // must be unset/'cpu' to stay eligible

    // ── Case A: eligible, NOT opted out — a spawn attempt IS made ───────
    const homeEligible = mkHome('eligible');
    process.env.LORE_HOME = homeEligible;
    const proxyEligible = new VerbatimSearchWorkerProxy(
        path.join(homeEligible, 'store'),
        undefined, undefined, false, false,
        undefined, // modelServer: undefined — defers to env/eligibility, same as pre-fix default
    );
    try {
        await proxyEligible.initialize();
        await test('eligible + not opted out: a store() call causes the child to attempt a real shared-server spawn (run dir created)', async () => {
            await proxyEligible.storeBatch([
                { id: 'lore:optout-a1', text: 'control case document for the shared model server opt-out test', metadata: {} },
            ] as never[]);
            const key = serverKey(homeEligible);
            const dir = runDir(homeEligible, key);
            assert.ok(fs.existsSync(dir), `expected a model-server run dir to have been created at ${dir} (proves the child's attachModelServer call constructed a real ModelServerClient and reached spawnOrConnect)`);
        });
    } finally {
        await proxyEligible.close();
        fs.rmSync(homeEligible, { recursive: true, force: true });
    }

    // ── Case B: eligible per env, but explicitly opted out on the proxy ─
    const homeOptOut = mkHome('optout');
    process.env.LORE_HOME = homeOptOut;
    const proxyOptOut = new VerbatimSearchWorkerProxy(
        path.join(homeOptOut, 'store'),
        undefined, undefined, false, false,
        false, // modelServer: false — the host's own opt-out, must reach the child
    );
    try {
        await proxyOptOut.initialize();
        await test('opted out via modelServer:false: a store() call never attempts a shared-server spawn (no run dir created) — the gap fix', async () => {
            await proxyOptOut.storeBatch([
                { id: 'lore:optout-b1', text: 'opted-out case document for the shared model server opt-out test', metadata: {} },
            ] as never[]);
            const key = serverKey(homeOptOut);
            const dir = runDir(homeOptOut, key);
            assert.ok(!fs.existsSync(dir), `expected NO model-server run dir at ${dir} — modelServer:false on the proxy must reach the child's own attachModelServer() call via WORKER_ENV.MODEL_SERVER`);
            // Sanity: the store still works end-to-end via the child's own
            // (in-process, unshared) embedder — opting out of the shared
            // server must not break normal operation.
            assert.equal(await proxyOptOut.count(), 1, 'row persisted via the child\'s own in-process embedder despite the opt-out');
        });
    } finally {
        await proxyOptOut.close();
        fs.rmSync(homeOptOut, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

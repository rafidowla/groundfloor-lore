#!/usr/bin/env tsx
/**
 * model-server-attach-unit.ts — D9 (3.24 slice C2a) host-wiring layer
 * (`modelServer/applicability.ts`):
 *   - eligibility gating: a test process (this file IS one —
 *     `isTestProcess()` matches any `tsx test/*.ts` entry) is ineligible
 *     unless `LORE_MODEL_SERVER=1` opts it in; `opts.modelServer === false`
 *     and `LORE_MODEL_SERVER=0` both force ineligible/disabled regardless.
 *   - `attachModelServer()`'s no-op path when ineligible: original
 *     embeddingProvider untouched, no rerankBackend override, `modelStatus()`
 *     always `{mode:'in_process'}}`, and critically — no `ModelServerClient`
 *     is ever constructed, so no lock file / socket / spawn attempt is
 *     observable on disk.
 *   - a host process that constructs a `ModelServerClient`, makes one real
 *     call, and exits WITHOUT calling `dispose()` still exits promptly —
 *     validates the `conn.ref()`/`conn.unref()` wiring around `embed()`/
 *     `rerank()` in client.ts (an idle connection must not keep the event
 *     loop alive).
 *
 * Run: npx tsx test/model-server-attach-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    isEligibleForSharedModelServer,
    attachModelServer,
} from '../packages/lore/src/modelServer/applicability.js';
import { LocalEmbeddingProvider, DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { serverKey, runDir, pidPath } from '../packages/lore/src/modelServer/paths.js';

function readServerPid(loreHome: string): number | null {
    const key = serverKey(loreHome);
    const p = pidPath(loreHome, key);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').trim();
    return raw ? parseInt(raw, 10) : null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-attach-${tag}-`));
}

console.log('model-server attach/applicability — eligibility gating + host-exit-without-dispose\n');

const savedEnv = { LORE_MODEL_SERVER: process.env.LORE_MODEL_SERVER, LORE_LOCAL_EMBEDDING_DEVICE: process.env.LORE_LOCAL_EMBEDDING_DEVICE };
function restoreEnv(): void {
    if (savedEnv.LORE_MODEL_SERVER === undefined) delete process.env.LORE_MODEL_SERVER; else process.env.LORE_MODEL_SERVER = savedEnv.LORE_MODEL_SERVER;
    if (savedEnv.LORE_LOCAL_EMBEDDING_DEVICE === undefined) delete process.env.LORE_LOCAL_EMBEDDING_DEVICE; else process.env.LORE_LOCAL_EMBEDDING_DEVICE = savedEnv.LORE_LOCAL_EMBEDDING_DEVICE;
}

// ---------------------------------------------------------------------
await test('a test process (this one) is ineligible without LORE_MODEL_SERVER=1, no matter what else is true', async () => {
    delete process.env.LORE_MODEL_SERVER;
    const provider = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });
    const eligible = isEligibleForSharedModelServer({
        deploymentMode: 'local',
        embeddingProvider: provider,
        injectedEmbeddingProvider: false,
    });
    assert.equal(eligible, false, 'a test process must be ineligible unless LORE_MODEL_SERVER=1 opts it in');
    restoreEnv();
});

await test('LORE_MODEL_SERVER=1 opts a test process back in (all other conditions held)', async () => {
    process.env.LORE_MODEL_SERVER = '1';
    const provider = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });
    const eligible = isEligibleForSharedModelServer({
        deploymentMode: 'local',
        embeddingProvider: provider,
        injectedEmbeddingProvider: false,
    });
    assert.equal(eligible, true);
    restoreEnv();
});

await test('attachModelServer(): ineligible test process is a pure no-op — no lock file, no client, in_process status', async () => {
    delete process.env.LORE_MODEL_SERVER;
    const home = mkLoreHome('ineligible-noop');
    const provider = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });
    const attachment = attachModelServer({
        loreHome: home,
        deploymentMode: 'local',
        embeddingProvider: provider,
        injectedEmbeddingProvider: false,
    });
    try {
        assert.equal(attachment.embeddingProvider, provider, 'must return the SAME provider instance, not a wrapper');
        assert.equal(attachment.rerankBackend, undefined, 'must not override the rerank backend');
        assert.deepEqual(attachment.modelStatus().mode, 'in_process');
        // No client was ever constructed, so the modelServer run dir for
        // this key must never have been created.
        const key = serverKey(home);
        const dir = runDir(home, key);
        assert.equal(fs.existsSync(dir), false, `attachModelServer() must not touch ${dir} when ineligible`);
        await attachment.dispose();
        restoreEnv();
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('attachModelServer(): opts.modelServer === false forces in_process regardless of env', async () => {
    process.env.LORE_MODEL_SERVER = '1'; // would otherwise make this eligible
    const home = mkLoreHome('explicit-off');
    const provider = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });
    const attachment = attachModelServer({
        loreHome: home,
        deploymentMode: 'local',
        embeddingProvider: provider,
        injectedEmbeddingProvider: false,
        modelServer: false,
    });
    try {
        assert.equal(attachment.embeddingProvider, provider);
        assert.equal(attachment.rerankBackend, undefined);
        assert.deepEqual(attachment.modelStatus().mode, 'in_process');
        const key = serverKey(home);
        assert.equal(fs.existsSync(runDir(home, key)), false);
        await attachment.dispose();
        restoreEnv();
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------
await test('host process exits promptly without calling dispose() (validates conn ref/unref wiring)', async () => {
    const home = mkLoreHome('exit-no-dispose');
    // `.mts`, not `.ts`: this temp dir has no package.json ancestor to tell
    // Node/tsx the file is ESM, and the script below uses top-level await —
    // under the ambient CJS default that fails to even transform, let alone
    // run. The explicit ESM extension sidesteps the ambient-module-type
    // lookup entirely.
    const childScript = path.join(home, 'child.mts');
    // A minimal host: construct a ModelServerClient directly (bypassing
    // eligibility gating — that's covered above), make ONE real call, and
    // exit WITHOUT calling dispose(). If the connection's socket were left
    // permanently ref'd (the bug fixed this turn), this child would hang
    // and never reach its own natural exit.
    fs.writeFileSync(childScript, `
import { ModelServerClient } from ${JSON.stringify(path.join(repoRoot, 'packages/lore/src/modelServer/client.ts'))};
import { DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from ${JSON.stringify(path.join(repoRoot, 'packages/lore/src/providers/localEmbeddingProvider.ts'))};

const client = new ModelServerClient({
    loreHome: ${JSON.stringify(home)},
    readyMs: 25000,
    restartBudgetMs: 20000,
    maxRestarts: 5,
    callMs: 30000,
    probeMs: 1000,
    clientId: 'exit-no-dispose-child',
});
await client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'host exits without dispose' });
console.log('CHILD_CALL_DONE');
// Deliberately no client.dispose() here — that is the point of this test.
`.trimStart());

    const start = Date.now();
    const child = spawn(tsxBin, [childScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    let sawCallDone = false;
    let callDoneAt = 0;
    child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('CHILD_CALL_DONE')) { sawCallDone = true; callDoneAt = Date.now(); }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const exited = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } resolve({ code: null, timedOut: true }); }, 30_000);
        child.once('exit', (code) => { clearTimeout(timer); resolve({ code, timedOut: false }); });
    });

    assert.equal(exited.timedOut, false, `child process hung and had to be SIGKILLed after 30s (stderr: ${stderr})`);
    assert.equal(exited.code, 0, `child must exit 0 (stderr: ${stderr})`);
    assert.ok(sawCallDone, 'child must have completed its embed() call before exiting');
    const exitLatencyMs = Date.now() - callDoneAt;
    assert.ok(exitLatencyMs < 5000, `child took ${exitLatencyMs}ms to exit after its last call completed — expected a prompt exit (unref'd socket)`);

    // The child's own detached server outlives the child process (by
    // design — that's the whole point of the shared server) and is never
    // "owned" by anything else in this test file; clean it up by its own
    // pidfile-reported pid, never by pattern.
    const leftoverPid = readServerPid(home);
    if (leftoverPid !== null) {
        try { process.kill(leftoverPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

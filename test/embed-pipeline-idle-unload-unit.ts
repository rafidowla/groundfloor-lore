#!/usr/bin/env tsx
/**
 * embed-pipeline-idle-unload-unit.ts — LORE-ASK-EMBED-IDLE-UNLOAD.
 *
 * `docs/PERFORMANCE-MEMORY.md` §8.3 found the local ONNX embedding pipeline
 * does NOT leak per embed cycle (`embed-only` config: ~0 MB/cycle, R²=0.686
 * noise) — it loads once and is cached forever, module-wide, and
 * `dispose()` never clears it. This isn't a leak fix; it's an OPT-IN
 * idle-unload for a long-lived host that indexes in bursts and then idles,
 * porting the same pattern `providers/llmDispatch.ts` already uses for the
 * embedded-LLM pipeline — except defaulting to "never unload" (0) instead
 * of that side's 3-minute default, since this pipeline isn't the one that
 * leaks.
 *
 * `LORE_EMBED_IDLE_UNLOAD_MS` is read ONCE at module-eval time (a plain
 * module-scoped `const` in localEmbeddingProvider.ts), so each scenario
 * below runs in its own freshly spawned child process with the env var set
 * before that module is ever imported — see test/helpers/embed-idle-unload-child.ts
 * and the identical constraint/pattern in
 * test/embedded-abandoned-dispose-exit-unit.ts.
 *
 * Covers:
 *   1. A pipeline with `inFlight > 0` is never unloaded (mid-batch guard).
 *   2. After the idle window, the cache entry is dropped.
 *   3. A subsequent embed transparently reloads and produces the SAME
 *      vector as before (correctness never depends on the cache).
 *   4. Default (no env var) never unloads — today's behavior, unchanged.
 *   5. `releaseLocalEmbeddingPipeline()` releases immediately when idle,
 *      reports whether it released, and a reload afterward still works.
 *
 * Loads the real HuggingFace/ONNX pipeline (no mocking) — this is a
 * correctness contract about actual pipeline lifecycle, not just cache
 * bookkeeping. Each scenario is a real model load, so this test is slower
 * than a typical unit test but still bounded (each child has a generous
 * but finite timeout).
 *
 * Run: npx tsx test/embed-pipeline-idle-unload-unit.ts
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(REPO_ROOT, 'test', 'helpers', 'embed-idle-unload-child.ts');

/** Generous enough for a cold-cache-hit model load + inference on a loaded
 *  machine; short enough that a real hang isn't a coffee break. */
const CHILD_TIMEOUT_MS = 60_000;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

interface ChildResult {
    code: number | null;
    stdout: string;
    stderr: string;
    result: Record<string, unknown> | null;
}

async function runChild(scenario: string, envOverrides: Record<string, string> = {}): Promise<ChildResult> {
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', CHILD, scenario],
        {
            cwd: REPO_ROOT,
            env: { ...process.env, ...envOverrides },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    let code: number | null = null;
    const done = new Promise<void>((resolve) => {
        child.once('exit', (exitCode) => { code = exitCode; resolve(); });
    });
    const timedOut = await Promise.race([done.then(() => false), sleep(CHILD_TIMEOUT_MS).then(() => true)]);
    if (timedOut) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        throw new Error(`child (${scenario}) did not exit within ${CHILD_TIMEOUT_MS}ms\nstdout: ${stdout}\nstderr: ${stderr}`);
    }

    const line = /RESULT: (\{.*\})/.exec(stdout);
    const result = line ? JSON.parse(line[1]) : null;
    return { code, stdout, stderr, result };
}

console.log('embed-pipeline-idle-unload-unit\n');

await test('LORE_EMBED_IDLE_UNLOAD_MS unset (default): pipeline never unloads', async () => {
    const { code, result, stdout, stderr } = await runChild('default-never-unload');
    assert.equal(code, 0, `child exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.ok(result, `child produced no RESULT line\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.equal(result!.cacheAfterEmbed, 1, 'pipeline should be cached right after an embed');
    assert.equal(result!.cacheAfterWait, 1, 'default behavior (no env var) must never unload the pipeline');
});

await test('LORE_EMBED_IDLE_UNLOAD_MS=1000: idle pipeline is unloaded, then transparently reloads with the same vector', async () => {
    const { code, result, stdout, stderr } = await runChild('unload-and-reload', { LORE_EMBED_IDLE_UNLOAD_MS: '1000' });
    assert.equal(code, 0, `child exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.ok(result, `child produced no RESULT line\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.equal(result!.cacheAfterEmbed, 1, 'pipeline should be cached right after an embed');
    assert.equal(result!.cacheAfterWait, 0, 'pipeline should be evicted after the idle window elapses');
    assert.equal(result!.cacheAfterReload, 1, 'a subsequent embed should transparently reload and re-cache the pipeline');
    assert.equal(result!.vecLenBefore, result!.vecLenAfter, 'reloaded pipeline must produce a vector of the same dimension');
    assert.ok(
        (result!.maxAbsDiff as number) < 1e-4,
        `reloaded pipeline produced a materially different vector for the same input (maxAbsDiff=${result!.maxAbsDiff})`,
    );
});

await test('a pipeline with inFlight > 0 is never unloaded mid-batch', async () => {
    const { code, result, stdout, stderr } = await runChild('inflight-guard', { LORE_EMBED_IDLE_UNLOAD_MS: '100' });
    assert.equal(code, 0, `child exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.ok(result, `child produced no RESULT line\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.equal(result!.sawZeroWhileRunning, false, 'sweeper must never evict a pipeline that has inFlight > 0 (an active batch embed)');
    assert.equal(result!.vectorCount, 120, 'the batch embed must complete fully despite an aggressive idle window');
    assert.equal(result!.allSameLength, true, 'every vector in the batch must have the same dimension');
});

await test('releaseLocalEmbeddingPipeline() releases an idle pipeline immediately and a reload still works', async () => {
    const { code, result, stdout, stderr } = await runChild('explicit-release');
    assert.equal(code, 0, `child exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.ok(result, `child produced no RESULT line\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.equal(result!.cacheAfterEmbed, 1, 'pipeline should be cached right after an embed');
    assert.equal(result!.released, true, 'releaseLocalEmbeddingPipeline() should report that it released an idle pipeline');
    assert.equal(result!.cacheAfterRelease, 0, 'cache should be empty immediately after an explicit release (no sweeper wait)');
    assert.equal(result!.cacheAfterReload, 1, 'a subsequent embed should transparently reload after an explicit release');
    assert.ok(
        (result!.maxAbsDiff as number) < 1e-4,
        `reloaded pipeline after explicit release produced a materially different vector (maxAbsDiff=${result!.maxAbsDiff})`,
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env tsx
/**
 * embedded-abandoned-dispose-exit-unit.ts — Lore must not leave a REFERENCED
 * TIMER holding an embedding host's event loop open after a teardown that
 * never reached `dispose()`.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 *
 * The outbox replicator's between-tick nap was a plain, REFERENCED
 * `setTimeout` (outbox/replicator.ts `sleep`). It is stopped in exactly one
 * place — step 4 of the ordered drain — which only runs inside `dispose()`.
 * So any teardown path that does not reach `dispose()` left a 250 ms timer
 * rearming forever and the host process never exited.
 *
 * That path is not hypothetical, and it is not a caller bug. Atlas's
 * `EmbeddedLore.close()` bounds its wait for the maintenance lock and, on
 * timeout, DELIBERATELY skips the clean dispose — tearing native handles down
 * under a mid-flight compaction is the RD-F13 corruption interleave, so
 * skipping is the correct choice. Its stated fallback is that "the OS will
 * reap the handles at process exit" — and a timer of ours that rearms forever
 * is precisely what stops the process from getting there.
 *
 * Closing the loop honestly: fixing the timer does NOT make an abandoned
 * instance exit, because the un-closed SurrealGraph holds the loop on its own
 * (upstream `@surrealdb/node`, and only `dispose()` closes it). What the fix
 * buys is that the timer is no longer ALSO holding it — so the remaining
 * holder is a real substrate handle the host can reason about, not an
 * invisible one.
 *
 * The symptom is maximally deceptive, which is why this test exists rather
 * than a comment: `process._getActiveHandles()` does not report timers, so a
 * hung host shows an EMPTY handle list and no error — reading exactly like a
 * leaked native addon resource. (`process.getActiveResourcesInfo()` does
 * report `Timeout`; use that.)
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 *
 *   A. Abandoning leaves NO referenced timer of ours on the loop. This is the
 *      regression. Scoped deliberately to timers: an un-closed SurrealGraph
 *      holds the loop by itself (`@surrealdb/node` — measured; a lifecycle
 *      child that skips `graph.close()` never exits), and only `dispose()`
 *      closes it, so "an abandoned instance exits" is a promise Lore cannot
 *      keep and this test does not pretend otherwise.
 *   B. The DISPOSED path still exits ON ITS OWN. Control: the fix must not
 *      have been bought by breaking the normal teardown.
 *   C. The DAEMON-shaped drain (deploymentMode 'local' gets `buildDrain()`,
 *      not the embedded variant) also exits, and disposing twice is safe.
 *      Covered here because the suite's other shutdown test injects a FAKE
 *      drain, so nothing else runs the real one over real handles.
 *   D. The disposed child never calls `process.exit`, so a leaked handle is
 *      the only thing that could keep it alive.
 *
 * Run: npx tsx test/embedded-abandoned-dispose-exit-unit.ts
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(REPO_ROOT, 'test', 'helpers', 'embedded-teardown-child.ts');

/** Generous enough for a cold embedded boot (ONNX provider init dominates) on
 *  a loaded machine, short enough that a real hang is not a coffee break. A
 *  healthy child finishes in a few seconds; the leak hangs forever, so there
 *  is no borderline case this could flake on. */
const EXIT_WINDOW_MS = 60_000;

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
    // Executor form, not `Promise.withResolvers` — this package's TS lib
    // target is ES2022 and the test-type gate is shrink-only for new files.
    return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

interface ChildOutcome {
    exited: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    elapsedMs: number;
}

/** Run the teardown child and report whether it exited on its OWN within
 *  `windowMs`. Killed (process group) if not, so a hung child never wedges
 *  the suite — the same shape as surreal-process-exit-unit.ts's runner. */
async function runChild(dir: string, mode: 'dispose' | 'abandon' | 'local', windowMs: number): Promise<ChildOutcome> {
    const startedAt = Date.now();
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', CHILD, dir, mode],
        {
            cwd: REPO_ROOT,
            // Squeeze the access-tracker flush interval (default 60s) so a
            // stale post-teardown flush would fire INSIDE the child's 2s
            // grace window instead of long after it exited. Without this the
            // resurrection regression is invisible to a short test.
            env: { ...process.env, LORE_ACCESS_FLUSH_MS: '250' },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    let code: number | null = null;
    let exited = false;
    const done = new Promise<void>((resolve) => {
        child.once('exit', (exitCode) => { code = exitCode; exited = true; resolve(); });
    });
    await Promise.race([done, sleep(windowMs)]);
    // Snapshot BEFORE the kill — `exited` is mutated by the handler above, so
    // reading it after would report every hung child as clean and the test
    // would pass unconditionally.
    const exitedOnOwn = exited;
    const exitCodeOnOwn = code;
    if (!exitedOnOwn && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        await Promise.race([done, sleep(2_000)]);
    }
    return { exited: exitedOnOwn, code: exitCodeOnOwn, stdout, stderr, elapsedMs: Date.now() - startedAt };
}

console.log('Embedded teardown — the host process can exit');

await test('an ABANDONED embedded instance leaves no referenced timer holding the host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-teardown-abandon-'));
    try {
        const outcome = await runChild(dir, 'abandon', EXIT_WINDOW_MS);
        assert.ok(
            outcome.stdout.includes('teardown complete: abandoned'),
            `child did not finish its work\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
        );
        const line = /RESOURCES: (\[.*\])/.exec(outcome.stdout);
        assert.ok(line, `child did not report its active resources\nstdout: ${outcome.stdout}`);
        const resources = JSON.parse(line[1]) as string[];
        assert.ok(
            !resources.includes('Timeout'),
            'a referenced timer is armed after abandoning the instance — it will hold an embedding host '
            + 'open forever, and `process._getActiveHandles()` will NOT show it. The usual culprit is the '
            + `outbox replicator's nap losing its unref (outbox/replicator.ts \`sleep\`). Got: ${JSON.stringify(resources)}`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('a DISPOSED instance stays closed — no background flush re-opens its store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-teardown-dispose-'));
    try {
        const outcome = await runChild(dir, 'dispose', EXIT_WINDOW_MS);
        assert.ok(
            outcome.stdout.includes('teardown complete: disposed'),
            `child did not finish its work\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
        );
        assert.equal(
            outcome.exited, true,
            'the host did not exit after a clean dispose. The access-time tracker most likely flushed after '
            + 'teardown and `SurrealGraph.stampAccessTimes` re-opened the closed store — an unowned native '
            + 'engine holds the loop open and NOTHING shows in `process._getActiveHandles()`. Check that the '
            + `drain still calls stopAllAccessTrackers() and that close() still sets the closed tombstone.\nstderr: ${outcome.stderr}`,
        );
        assert.equal(outcome.code, 0, `expected a clean exit, got ${outcome.code}\nstderr: ${outcome.stderr}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('the DAEMON-shaped drain (local mode) also exits, and a double dispose is safe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-teardown-local-'));
    try {
        const outcome = await runChild(dir, 'local', EXIT_WINDOW_MS);
        assert.ok(
            outcome.stdout.includes('teardown complete: local drain, disposed twice'),
            `child did not finish its work\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
        );
        assert.equal(outcome.exited, true,
            `the daemon-shaped drain did not let the process exit\nstderr: ${outcome.stderr}`);
        assert.equal(outcome.code, 0, `expected a clean exit, got ${outcome.code}\nstderr: ${outcome.stderr}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('the DISPOSED branch never calls process.exit — a leak is the only thing that could hold it open', () => {
    const source = fs.readFileSync(CHILD, 'utf8');
    const disposeBranch = source.slice(
        source.indexOf("if (mode === 'dispose')"),
        source.indexOf('} else {'),
    );
    assert.ok(disposeBranch.length > 0, 'could not locate the dispose branch in the child');
    assert.ok(
        !/process\.exit\s*\(/.test(disposeBranch),
        'the dispose branch must NOT call process.exit — that would mask the leak this test exists to catch. '
        + '(The abandon branch does call it, deliberately; see its comment.)',
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

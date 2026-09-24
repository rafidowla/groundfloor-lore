#!/usr/bin/env tsx
/**
 * test/embedded-sqlite-dispose-settles-unit.ts — regression pin for the
 * 2026-09-18 `schema-approve-embedded-unit.ts` hang.
 *
 * ── The defect this pins ────────────────────────────────────────────────
 *
 * Once SqliteGraph became the default boot graph for a fresh workspace
 * (pr/3.21.0-03-graph-engine-selection), `lore.dispose()` on an embedded
 * instance stopped settling: the outbox replicator's between-tick nap is a
 * deliberately UNREF'D `setTimeout` (outbox/replicator.ts `sleep`) — it only
 * fires on its own schedule if something ELSE keeps the event loop alive
 * until then. With SurrealGraph as the boot graph, its own open native
 * handle (`@surrealdb/node`) happened to do that through the whole drain, so
 * the nap always got a chance to fire before `stop()`'s
 * `await loopPromise` (shutdownDrain.ts step 4) needed it to. SqliteGraph
 * (better-sqlite3) opens no such handle, so once it is the boot graph and
 * dispose()'s drain has closed everything else, NOTHING pumps the loop —
 * the unref'd timer never fires and `stop()` hangs forever. Under a
 * top-level `await` (as in a `tsx` test script) this surfaced as Node's
 * "Detected unsettled top-level await" diagnostic + exit code 13; inside a
 * real embedding host it is a plain, permanent hang — `await lore.dispose()`
 * never returns and every line after it never runs.
 *
 * The fix (outbox/replicator.ts `stop()`/`sleep()`) races the nap's timer
 * against a signal `stop()` resolves directly, so `stop()` wakes its own nap
 * immediately instead of depending on an unrelated substrate handle to pump
 * the event loop for it. The nap's timer stays unref'd (an
 * abandoned/never-stopped replicator must still hold no handle of its own —
 * see test/embedded-abandoned-dispose-exit-unit.ts).
 *
 * ── What is asserted ────────────────────────────────────────────────────
 *
 *   A. A fresh embedded boot really lands on the 'sqlite' default (a
 *      silent fallback to 'surreal' would make the rest of this pin pass
 *      for the wrong reason).
 *   B. After a write that is genuinely routed through the outbox
 *      (asyncEmbed: true — so the replicator has started and ticked at
 *      least once against SqliteGraph), `dispose()` resolves within a
 *      bound instead of hanging.
 *   C. The host process exits ON ITS OWN afterward (no leaked handle holds
 *      the loop open), same property test/embedded-abandoned-dispose-exit-
 *      unit.ts pins for the SurrealGraph path.
 *
 * Run: npx tsx test/embedded-sqlite-dispose-settles-unit.ts
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(REPO_ROOT, 'test', 'helpers', 'embedded-sqlite-dispose-child.ts');

/** Generous enough for a cold embedded boot (ONNX provider init dominates)
 *  on a loaded machine, short enough that a real hang is not a coffee
 *  break — a healthy child finishes in a few seconds; the regression hangs
 *  forever, so there is no borderline case this could flake on. */
const EXIT_WINDOW_MS = 60_000;

/** The bound on dispose() ITSELF (not boot). Generous relative to the
 *  measured cost (well under a second in practice — SqliteGraph write +
 *  one replicator tick), tight enough to catch a real multi-second stall
 *  a partial fix (e.g. a fixed-delay workaround) would introduce. */
const DISPOSE_BOUND_MS = 15_000;

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

interface ChildOutcome {
    exited: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
}

/** Run the child and report whether it exited on its OWN within `windowMs`.
 *  Killed (process group) if not, so a hung child never wedges the suite. */
async function runChild(dir: string, windowMs: number): Promise<ChildOutcome> {
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', CHILD, dir],
        {
            cwd: REPO_ROOT,
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
    return { exited: exitedOnOwn, code: exitCodeOnOwn, stdout, stderr };
}

console.log('Embedded dispose() on a fresh (sqlite-default) home must settle and let the host exit');

await test('a fresh embedded boot defaults to sqlite, a write routes through the outbox, and dispose() settles + the host exits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sqlite-dispose-'));
    try {
        const outcome = await runChild(dir, EXIT_WINDOW_MS);
        assert.match(
            outcome.stdout, /GRAPH_ENGINE: sqlite/,
            `child did not confirm a sqlite boot (fresh-home default) — got:\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
        );
        assert.ok(
            outcome.stdout.includes('teardown complete: sqlite disposed'),
            `child did not finish its work — dispose() likely hung\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
        );
        assert.equal(
            outcome.exited, true,
            'the host did not exit on its own after dispose() — dispose() (or the shutdown drain) is hanging. '
            + 'The usual culprit is the outbox replicator\'s nap losing its ability to wake on stop() '
            + `(outbox/replicator.ts sleep/stop) once SqliteGraph is the boot graph.\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
        );
        assert.equal(outcome.code, 0, `expected a clean exit, got ${outcome.code}\nstderr: ${outcome.stderr}`);

        const m = /DISPOSE_MS: (\d+)/.exec(outcome.stdout);
        assert.ok(m, `child did not report DISPOSE_MS\nstdout: ${outcome.stdout}`);
        const disposeMs = Number(m![1]);
        assert.ok(
            disposeMs < DISPOSE_BOUND_MS,
            `dispose() took ${disposeMs}ms, expected under ${DISPOSE_BOUND_MS}ms`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

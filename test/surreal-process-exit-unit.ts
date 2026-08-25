#!/usr/bin/env tsx
/**
 * surreal-process-exit-unit.ts — a host process that used SurrealGraph must be
 * able to EXIT.
 *
 * This is not a hypothetical. `@surrealdb/node@3.0.3` leaks a live libuv handle
 * from the `DEFINE INDEX` statement that actually builds an index: after
 * `close()`, the process never exits. It is specific to the BUILDING define —
 * a no-op `IF NOT EXISTS` re-define on an existing index is clean, and so is
 * ordinary index-maintained writing — which makes it maximally deceptive:
 * only the very first boot of a workspace hangs, once per machine, looking
 * like a fluke.
 *
 * That is why `applySurrealSchema` defines no secondary indexes by default
 * (and why doing so costs nothing: the Kùzu binding exposes no CREATE INDEX
 * surface at all, so LocalGraph has none either — see
 * migration/adapters/kuzuMigrationAdapter.ts `addIndex: false`).
 *
 * Both halves are asserted:
 *   A. The DEFAULT engine lifecycle — open, write, read, traverse, close —
 *      lets the process exit promptly and cleanly. This is the regression that
 *      matters: any future statement that leaks a handle fails here.
 *   B. `LORE_SURREAL_DEFINE_INDEXES=1` still exhibits the upstream leak. It is
 *      asserted rather than ignored so the opt-in stays honestly labelled —
 *      and when a future @surrealdb/node fixes it, this test fails and tells
 *      us the indexes can be turned on.
 *
 * Run: npx tsx test/surreal-process-exit-unit.ts
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIFECYCLE_SCRIPT = path.join(REPO_ROOT, 'test', 'helpers', 'surreal-lifecycle-child.ts');

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
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

interface ChildOutcome {
    exited: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    elapsedMs: number;
}

/**
 * Run the lifecycle child and report whether it exited on its own within
 * `windowMs`. Killed if it does not, so a hung child never wedges the suite.
 */
async function runLifecycle(dir: string, env: NodeJS.ProcessEnv, windowMs: number): Promise<ChildOutcome> {
    const startedAt = Date.now();
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', LIFECYCLE_SCRIPT, dir],
        { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    let code: number | null = null;
    let exited = false;
    const done = new Promise<void>((resolve) => {
        child.once('exit', (exitCode) => { code = exitCode; exited = true; resolve(); });
    });
    await Promise.race([done, sleep(windowMs)]);
    // Snapshot BEFORE the kill: `exited` is mutated by the exit handler, so
    // reading it afterwards would report every hung child as having exited on
    // its own — the test would pass no matter what.
    const exitedOnOwn = exited;
    const exitCodeOnOwn = code;
    if (!exitedOnOwn && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        await Promise.race([done, sleep(2000)]);
    }
    return { exited: exitedOnOwn, code: exitCodeOnOwn, stdout, stderr, elapsedMs: Date.now() - startedAt };
}

console.log('SurrealGraph — host process can exit');

await test('the default engine lifecycle leaves the process able to exit cleanly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-exit-'));
    try {
        const outcome = await runLifecycle(dir, {}, 20_000);
        assert.ok(
            outcome.stdout.includes('lifecycle complete'),
            `child did not finish its work\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
        );
        assert.equal(outcome.exited, true,
            `process did not exit within 20s — something leaked a live handle\nstderr: ${outcome.stderr}`);
        assert.equal(outcome.code, 0, `expected a clean exit, got ${outcome.code}\nstderr: ${outcome.stderr}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('exit does not depend on an explicit process.exit() call', async () => {
    // The child never calls process.exit — it simply returns. A leaked handle
    // is therefore the only thing that can keep it alive, which is exactly the
    // property under test.
    const source = fs.readFileSync(LIFECYCLE_SCRIPT, 'utf8');
    assert.ok(!/process\.exit\s*\(/.test(source),
        'the lifecycle child must NOT call process.exit — that would mask the leak this test exists to catch');
});

await test('LORE_SURREAL_DEFINE_INDEXES=1 still reproduces the upstream handle leak', async () => {
    // Ratchet on a known @surrealdb/node@3.0.3 defect. If this starts FAILING,
    // upstream fixed DEFINE INDEX and the secondary indexes can become the
    // default — update surrealConnection.ts's INDEX_STATEMENTS comment and
    // move them into SCHEMA_STATEMENTS.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-exit-idx-'));
    try {
        const outcome = await runLifecycle(dir, { LORE_SURREAL_DEFINE_INDEXES: '1' }, 8_000);
        assert.ok(
            outcome.stdout.includes('lifecycle complete'),
            `child did not finish its work\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
        );
        assert.equal(outcome.exited, false,
            'DEFINE INDEX no longer leaks a handle — upstream is fixed; promote the indexes to the default schema');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

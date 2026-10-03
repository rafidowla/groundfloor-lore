#!/usr/bin/env tsx
/**
 * maintain-cli-exit-unit.ts — 3.26.0: `lore maintain` exits non-zero when an
 * enabled step recorded errors.
 *
 * 3.25.2 made the MCP `maintain` tool answer `ok: false` + `isError` for a run
 * whose enabled step failed; the CLI printed a `FAILED:` line but still exited
 * 0, so a cron job or wrapper script saw success. These cases drive the real
 * `maintainCommand` against workspaces in this process's isolated test home.
 *
 * The failure is produced the way a damaged store produces it: the workspace's
 * `.lore/lancedb` is a regular file, so the LanceDB probe throws and both
 * `compaction` and `versionCleanup` record an error. Node retention and
 * ephemeral expiry are switched off, so no graph store is opened.
 *
 * Run: npx tsx test/maintain-cli-exit-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createWorkspace, deleteWorkspace } from '../packages/lore/src/config/workspaces.js';
import { loreHome } from '../packages/lore/src/config/loreHome.js';
import { maintainCommand } from '../packages/lore/src/cli/commands/maintain.js';

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

interface CliRun { exitCode: number | null; stdout: string; stderr: string }

/** Run `maintainCommand` in-process, capturing output and the exit code it asks
 *  for (null = returned without calling `process.exit`). */
async function runCli(args: string[]): Promise<CliRun> {
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    const origExit = process.exit.bind(process);
    let exitCode: number | null = null;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
    process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error('__exit__'); }) as typeof process.exit;
    try {
        await maintainCommand(args);
    } catch (e) {
        if ((e as Error).message !== '__exit__') throw e;
    } finally {
        console.log = origLog;
        console.error = origError;
        process.exit = origExit;
    }
    return { exitCode, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** `--force`: skip the daemon/lock preflight (no daemon is involved here). */
const BASE_FLAGS = ['--no-node-retention', '--no-ephemeral', '--force'];

function brokenWorkspace(name: string): void {
    const entry = createWorkspace(name, {}, loreHome());
    fs.mkdirSync(path.join(entry.path, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(entry.path, '.lore', 'lancedb'), 'not a directory', 'utf-8');
}

console.log('\nlore maintain — exit code when an enabled step fails\n');

const created: string[] = [];
try {
    brokenWorkspace('cli-exit-broken');
    created.push('cli-exit-broken');
    createWorkspace('cli-exit-healthy', {}, loreHome());
    created.push('cli-exit-healthy');

    await test('a failed enabled step: full report printed, FAILED line, exit 1', async () => {
        const r = await runCli(['cli-exit-broken', ...BASE_FLAGS]);
        assert.equal(r.exitCode, 1);
        assert.match(r.stdout, /FAILED: .*compaction/, 'the human report names the failed step');
    });

    await test('--dry-run reports the same failure with exit 1', async () => {
        const r = await runCli(['cli-exit-broken', '--dry-run', ...BASE_FLAGS]);
        assert.equal(r.exitCode, 1);
        assert.match(r.stdout, /FAILED: /);
    });

    await test('--json: stdout stays a plain reports array, summary on stderr, exit 1', async () => {
        const r = await runCli(['cli-exit-broken', '--json', ...BASE_FLAGS]);
        assert.equal(r.exitCode, 1);
        const reports = JSON.parse(r.stdout) as Array<{ operations: Array<{ operation: string; errors: string[] }> }>;
        assert.ok(Array.isArray(reports) && reports.length === 1, 'one report, unchanged shape');
        const compaction = reports[0].operations.find((o) => o.operation === 'compaction');
        assert.ok(compaction && compaction.errors.length > 0, 'per-operation errors[] kept');
        assert.match(r.stderr, /\[maintain\] FAILED: .*compaction/);
    });

    await test('a failing step that is switched off does not fail the run', async () => {
        const r = await runCli(['cli-exit-broken', '--no-compaction', '--no-version-cleanup', ...BASE_FLAGS]);
        assert.equal(r.exitCode, null, 'returns normally (the CLI entry then exits 0)');
        assert.doesNotMatch(r.stdout, /FAILED: /);
    });

    await test('a healthy workspace returns normally with no FAILED line', async () => {
        const r = await runCli(['cli-exit-healthy', ...BASE_FLAGS]);
        assert.equal(r.exitCode, null);
        assert.doesNotMatch(r.stdout, /FAILED: /);
    });

    await test('--all: one failing workspace fails the run, the healthy one is still reported', async () => {
        const r = await runCli(['--all', '--json', ...BASE_FLAGS]);
        assert.equal(r.exitCode, 1);
        const reports = JSON.parse(r.stdout) as Array<{ scopeLabel?: string }>;
        const labels = reports.map((x) => x.scopeLabel);
        assert.ok(labels.includes('workspace:cli-exit-broken'));
        assert.ok(labels.includes('workspace:cli-exit-healthy'), 'a failure does not stop the remaining workspaces');
    });
} finally {
    for (const name of created) {
        try { deleteWorkspace(name, loreHome()); } catch { /* best effort — the test home is per-pid and temporary */ }
    }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

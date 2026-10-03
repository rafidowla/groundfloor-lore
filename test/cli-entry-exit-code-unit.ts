#!/usr/bin/env tsx
/**
 * cli-entry-exit-code-unit.ts — 3.26.0: the CLI entry point keeps a command's
 * `process.exitCode`.
 *
 * `cli/index.ts` ended every non-`serve` command with a hard-coded
 * `process.exit(0)`. `process.exit(code)` overrides `process.exitCode`, so the
 * commands that report a failure by setting `process.exitCode = 1` and then
 * returning (`doctor --json`, `outbox requeue-dead`, `verbatim`) printed their
 * error and exited 0. A script or cron job saw success.
 *
 * In-process calls cannot see this (the bug is in the dispatcher, after the
 * command returns), so these cases spawn the real CLI against a throwaway
 * `LORE_HOME`, the same way `legacy-engine-cli-refusal-unit.ts` does.
 *
 * Run: npx tsx test/cli-entry-exit-code-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(repoRoot, 'packages/lore/src/cli/index.ts');

async function getFreePort(): Promise<number> {
    const net = await import('node:net');
    return await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

interface CliRun { status: number | null; stdout: string; stderr: string }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cli-entry-exit-'));
// Never 3847/3848: a free port with nothing bound, so any daemon preflight a
// command runs finds nothing.
const port = await getFreePort();

function runCli(args: string[]): CliRun {
    const r = spawnSync(tsxBin, [cliEntry, ...args], {
        env: { ...process.env, LORE_HOME: home, LORE_PORT: String(port), LORE_MODEL_SERVER: '0' },
        encoding: 'utf-8',
        timeout: 60_000,
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

console.log('\nCLI entry point — a command\'s process.exitCode survives the final exit\n');

try {
    test('outbox requeue-dead on a directory with no outbox: error printed, exit 1', () => {
        const emptyDir = path.join(home, 'no-outbox');
        fs.mkdirSync(emptyDir, { recursive: true });
        const r = runCli(['outbox', 'requeue-dead', '--lore-dir', emptyDir]);
        assert.match(r.stderr, /No outbox\.sqlite under/);
        assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stderr}`);
    });

    test('doctor --json with issues: ok:false on stdout, exit 1', () => {
        // A home with no `.lore/` store: doctor reports it as a failed check.
        const r = runCli(['doctor', '--json']);
        const report = JSON.parse(r.stdout) as { ok: boolean; issues: number };
        assert.equal(report.ok, false);
        assert.ok(report.issues > 0, 'at least one issue reported');
        assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    });

    test('a command that succeeds still exits 0', () => {
        const r = runCli(['workspaces', 'list']);
        assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
        assert.match(r.stdout, /default/);
    });

    test('an unknown command still exits 1', () => {
        const r = runCli(['definitely-not-a-command']);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /Unknown command/);
    });
} finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

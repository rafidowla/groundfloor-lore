#!/usr/bin/env tsx
/**
 * test/legacy-engine-cli-refusal-unit.ts — round-S fix (2026-09-04),
 * finding 3: pin every real CLI entry point that opens the workspace
 * graph to the legacy-engine refusal, by spawning the actual `lore` CLI
 * (`cli/index.ts`) against a throwaway LORE_HOME.
 *
 * ── WHY THIS TEST EXISTS INSTEAD OF A PRODUCTION FIX ────────────────────────
 *
 * QA smoke finding 12 (<SCRATCH>/audit/smoke-final/12-legacy-engine.mjs)
 * reported that `openWorkspaceGraph(wsPath)` "did NOT throw" for a
 * workspace declaring `graphEngine: 'kuzu'`. Tracing it down: the repro
 * script called `openWorkspaceGraph` DIRECTLY, as a one-off Node script
 * with no `LORE_HOME` env var set and not running under `test/`
 * (`config/loreHome.ts`'s `isTestProcess()` only special-cases a `test/`
 * entry point) — so `resolveGraphEngineForPath`'s default `opts.home`
 * resolved to the REAL machine's `~/.groundfloor`, not the throwaway home
 * the repro had actually written its legacy-engine workspace entry into.
 * `resolveGraphEngineForPath` then found no workspace at that path in the
 * WRONG workspaces.json and silently fell back to the default engine
 * ('surreal') — exactly the silent-fallback bug this whole subsystem
 * exists to prevent, except the mismatch was between the repro script and
 * its own environment, not inside `openWorkspaceGraph` itself.
 *
 * Every REAL CLI caller resolves its home the same way `resolveReadGraph`/
 * `openGraphForCli` do: `loreHome()` (cli/commands/shared.ts's
 * `resolveGraphBasePath()` IS `loreHome()`), which is exactly the home
 * `resolveGraphEngineForPath`'s default parameter falls back to when no
 * explicit `opts.home` is given (`engines/openWorkspaceGraph.ts`,
 * `config/workspaces.ts`'s `loadWorkspaces(home: string = loreHome())`).
 * So a REAL CLI invocation — where `LORE_HOME` in the process env IS the
 * home whose workspaces.json declares the legacy engine — has no seam for
 * this mismatch: engine resolution and the CLI's own home resolution are
 * the SAME call. `test/daemon-engine-routing-unit.ts` and
 * `test/open-workspace-graph-unit.ts` already prove
 * `openWorkspaceGraph`/`LocalGraphRegistry.getGraphHandle` refuse
 * correctly when `home`/`workspaceId` are passed explicitly (the shape
 * every production caller uses) — `lore compact` was checked separately
 * and does not open the graph at all (it says so in its own comments;
 * it only probes the on-disk SurrealDB lock file). `lore backup`/`lore
 * restore` operate at the snapshot/filesystem level and do not call
 * `openWorkspaceGraph` either.
 *
 * Per the finding's own instruction — "if NO production caller can reach
 * it that way, do not change production code; instead write a test that
 * pins each CLI entry point to the refusal" — this file does exactly
 * that for `lore status` and `lore doctor`, the two entry points named in
 * the finding that DO call `openWorkspaceGraph` directly
 * (cli/commands/status.ts, cli/commands/doctor.ts), by spawning the real
 * `cli/index.ts` dispatcher end-to-end (real argv parsing, real command
 * dispatch, real process env) against a throwaway LORE_HOME whose boot
 * workspace (path === LORE_HOME, the only workspace `lore status`/`lore
 * doctor` with no args can ever open) declares `graphEngine: 'kuzu'`.
 *
 * Asserts the refusal's own wording surfaces in the CLI's output (the
 * `code`/`status` fields are `LegacyGraphEngineRemovedError`-internal and
 * not machine-readable from text-mode CLI output; the message text IS the
 * user-facing contract here) AND that no `.lore/surreal` directory was
 * created — i.e. it never silently opened (or created) a SurrealDB store
 * at the workspace's real, non-empty legacy-engine location.
 *
 * Run: npx tsx test/legacy-engine-cli-refusal-unit.ts
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

// The exact phrase from LegacyGraphEngineRemovedError's message
// (engines/graphEngineSelector.ts) — unique enough that a match proves the
// SPECIFIC refusal fired, not just "some error happened".
const REFUSAL_PHRASE = /legacy graph engine\s*.*\s*declaration is no longer supported/i;

function makeThrowawayHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-legacy-cli-refusal-'));
    // `lore status`/`lore doctor` with no args always open `loreHome()`
    // itself (cli/commands/shared.ts's `resolveGraphBasePath()`), i.e. the
    // workspace whose registered path === home. Declaring the "default"
    // entry's engine as the removed one is the only way a no-args
    // invocation can reach it.
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        version: 1,
        active: 'default',
        workspaces: [{ name: 'default', path: home, createdAt: new Date().toISOString(), graphEngine: 'kuzu' }],
    }, null, 2));
    return home;
}

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

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ok   ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL ${name}`);
        console.error('       ' + ((err as Error).message ?? String(err)));
        failed++;
    }
}

console.log('legacy-engine CLI refusal — real `lore status`/`lore doctor` against a throwaway LORE_HOME');

for (const cmd of ['status', 'doctor'] as const) {
    await test(`lore ${cmd} refuses a legacy-engine boot workspace (real CLI, real env) and creates no .lore/surreal`, async () => {
        const home = makeThrowawayHome();
        // Never 3847/3848 — an OS-assigned free port with nothing bound,
        // so the daemon-preflight probe both commands run finds nothing
        // and falls through to the direct open this test is pinning.
        const port = await getFreePort();
        try {
            const result = spawnSync(tsxBin, [cliEntry, cmd], {
                env: { ...process.env, LORE_HOME: home, LORE_PORT: String(port) },
                encoding: 'utf-8',
                timeout: 30_000,
            });
            const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
            assert.match(
                combined, REFUSAL_PHRASE,
                `expected the legacy-engine refusal in \`lore ${cmd}\`'s output, got:\n${combined}`,
            );
            assert.match(combined, /kuzu/i, 'the refusal must name the removed engine');
            const surrealDirExists = fs.existsSync(path.join(home, '.lore', 'surreal'));
            assert.equal(
                surrealDirExists, false,
                `\`lore ${cmd}\` must never create .lore/surreal for a legacy-engine workspace — it would be a silently WRONG, empty store`,
            );
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
}

await test('control: the same throwaway-home shape with graphEngine:"surreal" (or absent) does NOT refuse and DOES create .lore/surreal', async () => {
    // Proves the assertions above are actually discriminating on the
    // engine declaration, not on some other property of the throwaway
    // home (a missing token, an empty registry, etc).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-legacy-cli-control-'));
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        version: 1,
        active: 'default',
        workspaces: [{ name: 'default', path: home, createdAt: new Date().toISOString(), graphEngine: 'surreal' }],
    }, null, 2));
    const port = await getFreePort();
    try {
        const result = spawnSync(tsxBin, [cliEntry, 'status'], {
            env: { ...process.env, LORE_HOME: home, LORE_PORT: String(port) },
            encoding: 'utf-8',
            timeout: 30_000,
        });
        const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        assert.doesNotMatch(combined, REFUSAL_PHRASE, `a surreal-declared workspace must not be refused, got:\n${combined}`);
        assert.equal(
            fs.existsSync(path.join(home, '.lore', 'surreal')), true,
            'a surreal-declared workspace must actually open (and create) its store',
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

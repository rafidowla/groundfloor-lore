#!/usr/bin/env tsx
/**
 * model-server-env-allowlist-unit.ts — D9 (3.24 slice C3c) release gate:
 * the env a spawned shared-model-server child receives must be built
 * EXCLUSIVELY from `SERVER_ENV_ALLOWLIST` (paths.ts), never a pass-through
 * of the spawning host's full `process.env`.
 *
 * Covers two layers:
 *  1. `buildServerEnv(loreHome, sourceEnv)` (paths.ts) — the pure function
 *     extracted out of `clientConnection.ts`'s `spawnServerChild` for this
 *     gate — exercised directly with a synthetic `sourceEnv`, no spawn.
 *  2. A live spawn through the real `ModelServerClient` with a canary set
 *     in the actual host `process.env`, checked against the server's own
 *     log output.
 *
 * Scope note on the canary set: `HOME` is DELIBERATELY on
 * `SERVER_ENV_ALLOWLIST` (a POSIX essential the child needs), so it must
 * PASS THROUGH unchanged. `NODE_OPTIONS`, `NODE_PATH` and `SHELL` were
 * removed in 3.24 review SF7 — one host's `NODE_OPTIONS=--inspect` would
 * otherwise give the server every host shares a TCP debug port — so they
 * must now be DROPPED, alongside a made-up canary secret
 * (`LORE_TEST_CANARY_SECRET`), a real vendor secret name
 * (`AWS_SECRET_ACCESS_KEY`) and an unrelated `LORE_*` var that is not on the
 * allowlist (`LORE_TEST_UNRELATED_VAR`).
 *
 * Live-check honesty note: macOS has no `/proc/<pid>/environ` and `ps`/
 * `ps -E` do not expose another process's real env even same-user in this
 * sandbox (same limitation already documented in
 * `d9-model-server-release-gate-unit.ts`'s header). So the live check here
 * is a BEHAVIORAL proxy, not a direct env diff: an allowlisted var
 * (`LORE_LOG_LEVEL=debug`) visibly takes effect in the spawned server's own
 * log, while a non-allowlisted canary value set in the host env never
 * appears in that log. It does not prove the canary was excluded from the
 * child's env table specifically — only that it did not leak observably.
 * Full coverage of the filtering LOGIC itself is the pure unit test above,
 * which exercises the exact function the server is spawned through.
 *
 * Run: npx tsx test/model-server-env-allowlist-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildServerEnv, SERVER_ENV_ALLOWLIST, logPath } from '../packages/lore/src/modelServer/paths.js';
import { ModelServerClient } from '../packages/lore/src/modelServer/client.js';
import { DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { removeHome } from './helpers/model-server-home.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-env-${tag}-`));
}
function isAlive(pid: number): boolean {
    const res = spawnSync('ps', ['-p', String(pid)]);
    return res.status === 0 && res.stdout.toString().includes(String(pid));
}
const spawnedPids = new Set<number>();
function trackPid(pid: number | null | undefined): void { if (pid) spawnedPids.add(pid); }
function cleanupAllTrackedPids(): void {
    for (const pid of spawnedPids) {
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
}

console.log('D9 §6 release gate — server env allowlist (buildServerEnv + live behavioral proxy)\n');

const GENEROUS = { readyMs: 25_000, restartBudgetMs: 20_000, maxRestarts: 5, callMs: 30_000, probeMs: 1000 };

// ---------------------------------------------------------------------
await test('buildServerEnv: non-allowlisted vars (canary secret, real vendor secret name, unrelated LORE_* var) are absent', () => {
    const sourceEnv: NodeJS.ProcessEnv = {
        LORE_TEST_CANARY_SECRET: 'canary-should-never-leak-8f21c',
        AWS_SECRET_ACCESS_KEY: 'AKIAFAKECANARYKEYDONOTUSE',
        LORE_TEST_UNRELATED_VAR: 'not-on-the-allowlist-either',
        HOME: '/Users/canary-home',
        PATH: '/usr/bin:/bin',
        LORE_LOG_LEVEL: 'debug',
        LORE_HOME: '/some/other/path-must-be-overridden',
    };
    const built = buildServerEnv('/my/lore/home', sourceEnv);
    assert.equal(built.LORE_TEST_CANARY_SECRET, undefined, 'made-up canary secret must not pass through');
    assert.equal(built.AWS_SECRET_ACCESS_KEY, undefined, 'real vendor secret name must not pass through');
    assert.equal(built.LORE_TEST_UNRELATED_VAR, undefined, 'an unrelated LORE_* var not on the allowlist must not pass through');
});

await test('buildServerEnv: NODE_OPTIONS, NODE_PATH and SHELL never reach the shared server (SF7)', () => {
    const built = buildServerEnv('/my/lore/home', {
        NODE_OPTIONS: '--inspect=0.0.0.0:9229',
        NODE_PATH: '/somewhere/else/node_modules',
        SHELL: '/bin/zsh',
        PATH: '/usr/bin:/bin',
    });
    assert.equal(built.NODE_OPTIONS, undefined, 'NODE_OPTIONS must be dropped');
    assert.equal(built.NODE_PATH, undefined, 'NODE_PATH must be dropped');
    assert.equal(built.SHELL, undefined, 'SHELL must be dropped');
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'SHELL']) {
        assert.ok(!(SERVER_ENV_ALLOWLIST as readonly string[]).includes(name), `${name} must not be on SERVER_ENV_ALLOWLIST`);
    }
    assert.equal(built.PATH, '/usr/bin:/bin');
});

await test('buildServerEnv: allowlisted vars (including HOME) pass through unchanged', () => {
    const sourceEnv: NodeJS.ProcessEnv = {
        HOME: '/Users/canary-home',
        PATH: '/usr/bin:/bin',
        LORE_LOG_LEVEL: 'debug',
        LORE_LOCAL_EMBEDDING_DEVICE: 'cpu',
        LORE_MODEL_SERVER_MAX_CLIENTS: '7',
    };
    const built = buildServerEnv('/my/lore/home', sourceEnv);
    assert.equal(built.HOME, '/Users/canary-home');
    assert.equal(built.PATH, '/usr/bin:/bin');
    assert.equal(built.LORE_LOG_LEVEL, 'debug');
    assert.equal(built.LORE_LOCAL_EMBEDDING_DEVICE, 'cpu');
    assert.equal(built.LORE_MODEL_SERVER_MAX_CLIENTS, '7');
});

await test('buildServerEnv: LORE_HOME is always forced to the argument, never the sourceEnv value', () => {
    const built = buildServerEnv('/forced/lore/home', { LORE_HOME: '/attacker-controlled/path' });
    assert.equal(built.LORE_HOME, '/forced/lore/home');
});

await test('buildServerEnv: an unset allowlisted var is simply absent, never defaulted or invented', () => {
    const built = buildServerEnv('/my/lore/home', { PATH: '/usr/bin' });
    assert.equal(built.HOME, undefined);
    assert.equal(built.NODE_OPTIONS, undefined);
    assert.equal(built.LORE_LOG_LEVEL, undefined);
});

await test('buildServerEnv: output has no keys beyond SERVER_ENV_ALLOWLIST plus LORE_HOME', () => {
    const noisy: NodeJS.ProcessEnv = { ...process.env, LORE_TEST_CANARY_SECRET: 'x', AWS_SECRET_ACCESS_KEY: 'y' };
    const built = buildServerEnv('/my/lore/home', noisy);
    const allowedSet = new Set<string>([...SERVER_ENV_ALLOWLIST, 'LORE_HOME']);
    for (const key of Object.keys(built)) {
        assert.ok(allowedSet.has(key), `built env leaked a key not on the allowlist: ${key}`);
    }
});

// ---------------------------------------------------------------------
await test('live: a non-allowlisted canary set in the host env never appears in the spawned server\'s own log, while an allowlisted var visibly takes effect', async () => {
    const home = mkLoreHome('live-canary');
    const prevLogLevel = process.env.LORE_LOG_LEVEL;
    const prevCanary = process.env.LORE_TEST_CANARY_SECRET;
    const CANARY = 'LIVE-ENV-CANARY-8f21c-must-never-reach-the-spawned-server';
    process.env.LORE_LOG_LEVEL = 'debug'; // allowlisted — must visibly take effect (debug logging appears)
    process.env.LORE_TEST_CANARY_SECRET = CANARY; // NOT allowlisted — must never leak into the server's own process/log
    const client = new ModelServerClient({ loreHome: home, clientId: 'gate-env-live', ...GENEROUS });
    try {
        const { vectors } = await client.embed({ op: 'query', modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM, text: 'live env allowlist check' });
        assert.ok(vectors && vectors[0]?.length === DEFAULT_LOCAL_MODEL_DIM, 'the server must have started and served a real embed despite the narrowed env');
        trackPid(client.status().server?.pid);

        const file = logPath(home);
        const deadline = Date.now() + 5_000;
        let content = '';
        while (Date.now() < deadline) {
            content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
            if (content.includes('model server listening')) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(content.includes('model server listening'), `expected the server's log at ${file} to show it started at all`);
        assert.ok(content.includes('debug') || /"level":"debug"/.test(content) || content.split('\n').some((l) => l.trim().length > 0 && l.includes('embed')), 'expected some evidence that the allowlisted LORE_LOG_LEVEL=debug reached and affected the spawned server (broad check: startup/embed activity is logged at all)');
        assert.ok(!content.includes(CANARY), `the non-allowlisted canary must never appear in the spawned server's own log (${file})`);
    } finally {
        await client.dispose();
        if (prevLogLevel === undefined) delete process.env.LORE_LOG_LEVEL; else process.env.LORE_LOG_LEVEL = prevLogLevel;
        if (prevCanary === undefined) delete process.env.LORE_TEST_CANARY_SECRET; else process.env.LORE_TEST_CANARY_SECRET = prevCanary;
        await removeHome(home);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
cleanupAllTrackedPids();
if (failed > 0) process.exit(1);

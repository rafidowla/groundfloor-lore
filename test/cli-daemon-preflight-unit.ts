#!/usr/bin/env tsx
/**
 * cli-daemon-preflight-unit.ts — finding 11 follow-up (round E) regression,
 * extended for round E2's false-positive-refusal fix.
 *
 * SW-11 gave `lore doctor` and `lore status` a LORE_PORT-aware daemon
 * preflight + a shortened openSurreal retry budget (doctor.ts's
 * openGraphForDoctor(), status.ts's openGraphForStatus()) so a store already
 * held by a running daemon fails fast with a clear message instead of
 * sitting through the ~15s single-writer retry storm and dumping a raw
 * driver error. The other 18 commands that open the workspace graph
 * directly (recall, sync, embed, verbatim, supersede, markStale, getFull,
 * resolve, export, reconnect, report, lint, diagnose, retention, setup,
 * init, migrateEmbedding, migrate) had none of that — this file proves the
 * fix (a single shared `openGraphForCli` helper in cli/commands/shared.ts)
 * for three representative commands (recall/export/sync) plus `init`.
 *
 * Round E2 (2026-09-03) finding: the round-E preflight refused whenever
 * ANY process answered 200 on `/api/health` at LORE_PORT, with NO check
 * that the answering daemon was serving THIS `LORE_HOME` — so `lore init`
 * on a brand-new home was refused by a totally unrelated Lore install
 * reachable on the same port number, and any command against an
 * already-initialized-but-unlocked home was refused the same way. The fix
 * (`isDaemonServingHome()` in migrateWorkspaceToWorkspaceShared.ts) only
 * refuses when a Bearer built from THIS home's own `auth.token` gets back a
 * matching `loreHome` from that port's `/api/health`. This file's five
 * scenarios, each run in its own child process (fresh module cache, so each
 * gets its own LORE_HOME / LORE_PORT env at import time — DEFAULT_PORT in
 * migrateWorkspaceToWorkspaceShared.ts is read once at module load):
 *
 *   1. "unrelateddaemon" — an unrelated Lore install answers `/api/health`
 *      200 on LORE_PORT (anonymous, no `loreHome`), but THIS home has no
 *      `auth.token` (never had a daemon boot against it) and its store is
 *      genuinely free. recall/export/sync must open it DIRECTLY and
 *      SUCCEED (no throw) — this is qa/B5-round2/wrong-home-inprocess.mts's
 *      shape. Fails pre-fix: the old isDaemonUp()-only check refused just
 *      because *something* answered the port.
 *
 *   2. "initfresh" — same unrelated-daemon shape, but against a brand-new,
 *      never-`lore init`'d home (qa/B5-round2/init-fresh-with-daemon.mts).
 *      `lore init` must succeed and actually create `.lore/`.
 *
 *   3. "owndaemon" — a fake daemon on LORE_PORT that DOES write this home's
 *      `auth.token` and answers with a matching `loreHome` when presented
 *      that Bearer (a genuine "it really is our own daemon" fixture). All
 *      three commands must still refuse fast with the friendly "store is
 *      held by a running Lore process" message, and never touch the
 *      on-disk store.
 *
 *   4. "lockvictim" — a holder child process opens the SAME workspace
 *      directly (a real SurrealGraph handle) and keeps it open. No daemon
 *      answers LORE_PORT at all (an OS-assigned free port with nothing
 *      bound to it — never 3847/3848). All three commands must fall
 *      through to a direct open, hit the real single-writer lock, and
 *      report the same friendly message fast (well under the old 15s
 *      budget), never the raw
 *      `[LoreGraph:openSurreal] Failed to open embedded SurrealDB…` driver
 *      message, and never a "different home" mismatch phrase (no daemon
 *      was ever seen here at all).
 *
 *   5. "mismatchlocked" — THIS home's own (stale) `auth.token` exists, a
 *      real holder process holds the store's lock directly, AND an
 *      unrelated daemon answers LORE_PORT claiming a DIFFERENT `loreHome`
 *      for that Bearer. The command must not treat the unrelated daemon as
 *      proof of ownership (so it still attempts — and hits — the real
 *      lock), but the resulting message must be the HONEST mismatch one:
 *      "a Lore process answers on port N but reports a different home; the
 *      store is held by another process."
 *
 * Fails on the pre-fix base: scenario 1/2 would refuse (isDaemonUp() alone
 * treats any 200 as "ours"). Scenario 3 already passed pre-fix (coincidentally
 * — the old check also refused here) but is kept as an explicit regression
 * so the fix doesn't overcorrect into never refusing. Scenario 4 is
 * unaffected by round E2 (no daemon involved at all) and stays a control.
 * Scenario 5 is new: pre-fix there was no "different home" message at all —
 * every daemon-adjacent lock conflict got the generic port-based message.
 *
 * No framework — tsx-run, assert-based, exits non-zero on failure.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const selfPath = fileURLToPath(import.meta.url);
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

const COMMANDS = ['recall', 'export', 'sync'] as const;
type CommandUnderTest = (typeof COMMANDS)[number];

/** Bind an ephemeral port, read it, and release it immediately — used to
 *  hand the "lockvictim" scenario a LORE_PORT that is guaranteed free
 *  (never 3847/3848; we must never probe those). */
async function getFreePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const srv = http.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

/* ─────────────────────────── Child-process bodies ─────────────────────── */

/** Run one command under test against the (already-configured-via-env)
 *  workspace, capturing whether it threw and how long it took. Each command
 *  is invoked directly (not via the cli/index.ts dispatcher) so a thrown
 *  CliDaemonLockError is observable here instead of being swallowed by
 *  main().catch. */
async function runCommand(cmd: CommandUnderTest, home: string): Promise<{ threw: string | null; elapsedMs: number }> {
    const t0 = Date.now();
    let threw: string | null = null;
    try {
        if (cmd === 'recall') {
            const { recallCommand } = await import('../packages/lore/src/cli/commands/recall.js');
            await recallCommand(['some-topic-that-will-never-be-reached']);
        } else if (cmd === 'export') {
            const { exportCommand } = await import('../packages/lore/src/cli/commands/export.js');
            const outPath = path.join(home, `export-${process.pid}.html`);
            await exportCommand(['html', '--output', outPath]);
        } else {
            fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
            const { syncCommand } = await import('../packages/lore/src/cli/commands/sync.js');
            await syncCommand([]);
        }
    } catch (e) {
        threw = (e as Error).message;
    }
    return { threw, elapsedMs: Date.now() - t0 };
}

/**
 * Round E2 scenario 1 — an unrelated Lore install answers `/api/health` 200
 * on LORE_PORT (anonymous body, no `loreHome`), but THIS home has never had
 * a daemon boot against it (no `auth.token`). Mirrors
 * qa/B5-round2/wrong-home-inprocess.mts. The command must open the store
 * DIRECTLY and SUCCEED — the old isDaemonUp()-only check refused here just
 * because *something* answered the port.
 */
async function childUnrelatedDaemon(cmd: CommandUnderTest): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(home, { recursive: true });
    // No auth.token — this home has never had a daemon boot against it, so
    // nothing can prove the answering process is ours.
    assert.ok(!fs.existsSync(path.join(home, 'auth.token')), 'test setup: no auth.token expected');

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if ((req.url ?? '').startsWith('/api/health')) {
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok' })); // unrelated daemon, anonymous body
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);

    const { threw, elapsedMs } = await runCommand(cmd, home);
    server.close();

    const surrealDirExists = fs.existsSync(path.join(home, '.lore', 'surreal'));
    console.log('===RESULT_START===');
    console.log(`THREW=${threw === null ? '' : JSON.stringify(threw)}`);
    console.log(`SURREAL_DIR_EXISTS=${surrealDirExists}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log('===RESULT_END===');
    process.exit(0);
}

/**
 * Round E2 scenario 2 — same unrelated-daemon shape as above, but against a
 * brand-new, never-`lore init`'d home. Mirrors
 * qa/B5-round2/init-fresh-with-daemon.mts. `lore init` must succeed.
 */
async function childInitFresh(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(home, { recursive: true }); // brand new, empty — never lore-init'd
    assert.ok(!fs.existsSync(path.join(home, 'auth.token')), 'test setup: no auth.token expected');
    assert.ok(!fs.existsSync(path.join(home, '.lore')), 'test setup: not yet initialized');

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if ((req.url ?? '').startsWith('/api/health')) {
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok' })); // unrelated daemon, anonymous body
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);

    const t0 = Date.now();
    let threw: string | null = null;
    try {
        const { initCommand } = await import('../packages/lore/src/cli/commands/init.js');
        await initCommand([]);
    } catch (e) {
        threw = (e as Error).message;
    }
    const elapsedMs = Date.now() - t0;
    server.close();

    const loreDirExists = fs.existsSync(path.join(home, '.lore'));
    console.log('===RESULT_START===');
    console.log(`THREW=${threw === null ? '' : JSON.stringify(threw)}`);
    console.log(`LORE_DIR_EXISTS=${loreDirExists}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log('===RESULT_END===');
    process.exit(0);
}

/**
 * Round E2 scenario 3 — a fake daemon that DOES write this home's
 * `auth.token` and answers with a matching `loreHome` when presented that
 * exact Bearer: a genuine "it really is our own daemon" fixture. The
 * command must still refuse fast with the friendly message.
 */
async function childOwnDaemon(cmd: CommandUnderTest): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(home, { recursive: true });
    const token = 'own-daemon-test-token';
    fs.writeFileSync(path.join(home, 'auth.token'), token, 'utf-8');

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if ((req.url ?? '').startsWith('/api/health')) {
            res.writeHead(200);
            // Mirrors the real route (FINDING 4, 2026-09-03): only a
            // request presenting the CORRECT Bearer gets the full body
            // (loreHome included); anything else gets the anonymous lite
            // body.
            if (req.headers.authorization === `Bearer ${token}`) {
                res.end(JSON.stringify({ status: 'ok', loreHome: home }));
            } else {
                res.end(JSON.stringify({ status: 'ok' }));
            }
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);

    const { threw, elapsedMs } = await runCommand(cmd, home);
    server.close();

    const surrealDirExists = fs.existsSync(path.join(home, '.lore', 'surreal'));
    console.log('===RESULT_START===');
    console.log(`THREW=${threw === null ? '' : JSON.stringify(threw)}`);
    console.log(`SURREAL_DIR_EXISTS=${surrealDirExists}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log('===RESULT_END===');
    process.exit(0);
}

async function childHolder(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { openWorkspaceGraph } = await import('../packages/lore/src/engines/openWorkspaceGraph.js');
    const graph = openWorkspaceGraph(home);
    await graph.initialize();
    console.log('HOLDER_READY');
    // Held until the parent SIGKILLs this process. Self-timeout as a
    // leak-safety net in case that somehow doesn't happen.
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    await graph.close();
}

async function childLockVictim(cmd: CommandUnderTest): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { threw, elapsedMs } = await runCommand(cmd, home);
    console.log('===RESULT_START===');
    console.log(`THREW=${threw === null ? '' : JSON.stringify(threw)}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log('===RESULT_END===');
    process.exit(0);
}

/**
 * Round E2 scenario 5's victim. `home` already has its own (stale)
 * auth.token on disk (written by the orchestrator before spawning both the
 * holder and this victim) and its store is already locked by a separately
 * spawned holder process (real, cross-process file lock — unlike HTTP,
 * this works fine across processes). The "unrelated daemon" itself is
 * started HERE, in-process, and answers with a DIFFERENT loreHome for any
 * Bearer — mirroring qa/B5-round2/wrong-home-inprocess.mts's documented
 * reason for keeping the fake daemon in the same process as the code under
 * test: a `fetch()` from one spawned child to an HTTP server bound in a
 * SIBLING spawned child is blocked by this sandbox's cross-process
 * loopback-HTTP restriction, even though real cross-process file locks are
 * unaffected.
 */
async function childMismatchVictim(cmd: CommandUnderTest): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const unrelatedHome = process.env['UNRELATED_HOME']!;

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if ((req.url ?? '').startsWith('/api/health')) {
            // Answers ANY Bearer with a DIFFERENT loreHome — a real,
            // reachable daemon, just not the one serving `home`.
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok', loreHome: unrelatedHome }));
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);

    const { threw, elapsedMs } = await runCommand(cmd, home);
    server.close();

    console.log('===RESULT_START===');
    console.log(`THREW=${threw === null ? '' : JSON.stringify(threw)}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log('===RESULT_END===');
    process.exit(0);
}

/**
 * Round E3 scenario (2026-09-03, finding: low) — `home`'s own store is
 * genuinely locked by a real holder (same shape as scenarioLockConflict),
 * AND a process on LORE_PORT answers `/api/health` with 401 (rejected our
 * Bearer) rather than a 200 with a different `loreHome`. The direct-open
 * fallback still hits the real lock either way, but the message must say
 * so honestly: the daemon never told us WHOSE home it serves — only that
 * our credential didn't work — so it must NOT say "reports a different
 * home" (that phrase was shown here before this fix, which is false: no
 * home was ever reported).
 */
async function childCredentialRejectedVictim(cmd: CommandUnderTest): Promise<void> {
    const home = process.env['LORE_HOME']!;

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if ((req.url ?? '').startsWith('/api/health')) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);

    const { threw, elapsedMs } = await runCommand(cmd, home);
    server.close();

    console.log('===RESULT_START===');
    console.log(`THREW=${threw === null ? '' : JSON.stringify(threw)}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log('===RESULT_END===');
    process.exit(0);
}

/* ───────────────────────────── Orchestrator ────────────────────────────── */

function extractSection(stdout: string, marker: string): string {
    const startTag = '===RESULT_START===';
    const endTag = '===RESULT_END===';
    const startIdx = stdout.indexOf(startTag);
    const endIdx = stdout.indexOf(endTag);
    assert.ok(startIdx !== -1 && endIdx !== -1, `child stdout missing ${startTag}/${endTag} markers:\n${stdout}`);
    const section = stdout.slice(startIdx + startTag.length, endIdx);
    const m = new RegExp(`${marker}=(.*)`).exec(section);
    assert.ok(m, `child stdout missing ${marker}= marker:\n${stdout}`);
    return m![1]!.trim();
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`);
        failed++;
    }
}

/** Round E2 scenario 1 — unrelated daemon, home never touched by a daemon:
 *  must open directly and SUCCEED (was the false-positive-refusal bug). */
async function scenarioUnrelatedDaemon(cmd: CommandUnderTest): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-clipreflight-unrelated-${cmd}-`));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'unrelateddaemon', cmd], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `${cmd} unrelateddaemon child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const stdout = result.stdout;

    const threwRaw = extractSection(stdout, 'THREW');
    const threw = threwRaw ? (JSON.parse(threwRaw) as string) : null;
    const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));
    const surrealDirExists = extractSection(stdout, 'SURREAL_DIR_EXISTS') === 'true';

    assert.equal(threw, null,
        `expected ${cmd} to open the store directly and succeed despite an unrelated daemon on LORE_PORT; it threw: ${threw}`);
    assert.equal(surrealDirExists, true,
        `${cmd} should have opened (and thereby created) the on-disk store — an unrelated daemon on the port must not block it`);
    assert.ok(elapsedMs < 5_000, `expected ${cmd} to finish in well under 5s; took ${elapsedMs}ms`);
}

/** Round E2 scenario 2 — same unrelated-daemon shape, against a brand-new
 *  home: `lore init` must succeed. */
async function scenarioInitFresh(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-clipreflight-initfresh-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'initfresh'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `initfresh child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const stdout = result.stdout;

    const threwRaw = extractSection(stdout, 'THREW');
    const threw = threwRaw ? (JSON.parse(threwRaw) as string) : null;
    const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));
    const loreDirExists = extractSection(stdout, 'LORE_DIR_EXISTS') === 'true';

    assert.equal(threw, null, `expected "lore init" to succeed on a fresh home despite an unrelated daemon on LORE_PORT; it threw: ${threw}`);
    assert.equal(loreDirExists, true, 'expected "lore init" to have created .lore/');
    assert.ok(elapsedMs < 5_000, `expected init to finish in well under 5s; took ${elapsedMs}ms`);
}

/** Round E2 scenario 3 — a daemon that genuinely IS this home's own (writes
 *  its auth.token, answers with a matching loreHome): must still refuse. */
async function scenarioOwnDaemon(cmd: CommandUnderTest): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-clipreflight-own-${cmd}-`));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'owndaemon', cmd], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `${cmd} owndaemon child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const stdout = result.stdout;

    const threwRaw = extractSection(stdout, 'THREW');
    const threw = threwRaw ? (JSON.parse(threwRaw) as string) : null;
    const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));
    const surrealDirExists = extractSection(stdout, 'SURREAL_DIR_EXISTS') === 'true';

    assert.ok(threw, `expected ${cmd} to throw a daemon-lock error against its OWN daemon; it returned normally`);
    assert.match(threw!, /store is held by a running Lore process/,
        `expected the friendly daemon-lock message from ${cmd}; got: ${threw}`);
    assert.equal(surrealDirExists, false,
        `${cmd} must not have opened/created the on-disk store while its own daemon answers over HTTP`);
    assert.ok(elapsedMs < 5_000, `expected ${cmd} to finish in well under 5s via the daemon preflight; took ${elapsedMs}ms`);
}

async function scenarioLockConflict(cmd: CommandUnderTest): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-clipreflight-lock-${cmd}-`));
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    const freePort = await getFreePort(); // guaranteed nothing is listening here — never 3847/3848

    const holder = spawn(tsxBin, [selfPath, '--child', 'holder'], {
        env: { ...process.env, LORE_HOME: home },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
        await new Promise<void>((resolve, reject) => {
            let buf = '';
            const timer = setTimeout(() => reject(new Error('holder did not become ready in time')), 15_000);
            holder.stdout!.on('data', (chunk) => {
                buf += chunk.toString();
                if (buf.includes('HOLDER_READY')) { clearTimeout(timer); resolve(); }
            });
            holder.on('exit', (code) => { clearTimeout(timer); reject(new Error(`holder exited early, code=${code}`)); });
        });

        const result = spawnSync(tsxBin, [selfPath, '--child', 'lockvictim', cmd], {
            env: { ...process.env, LORE_HOME: home, LORE_PORT: String(freePort) },
            encoding: 'utf-8',
            timeout: 30_000, // baseline sits at ~15-16.5s here; give it room
        });
        assert.equal(result.status, 0, `${cmd} lockvictim child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        const stdout = result.stdout;

        const threwRaw = extractSection(stdout, 'THREW');
        const threw = threwRaw ? (JSON.parse(threwRaw) as string) : null;
        const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));

        assert.ok(threw, `expected ${cmd} to throw a daemon-lock error; it returned normally`);
        assert.match(threw!, /store is held by a running Lore process/,
            `expected the friendly lock message from ${cmd}; got: ${threw}`);
        assert.doesNotMatch(threw!, /Failed to open embedded SurrealDB/,
            `raw driver error leaked through from ${cmd}: ${threw}`);
        assert.doesNotMatch(threw!, /different home/,
            `no daemon was ever seen in this scenario — the message must not claim one was: ${threw}`);
        assert.ok(elapsedMs < 8_000,
            `expected ${cmd} to hit the shortened lock-probe budget (well under the old 15s storm); took ${elapsedMs}ms`);
    } finally {
        holder.kill('SIGKILL');
    }
}

/**
 * Round E2 scenario 5 — THIS home's own (stale) auth.token exists, a real
 * holder process holds the store's lock directly, AND an unrelated daemon
 * answers LORE_PORT claiming a DIFFERENT loreHome. The command must not
 * treat the unrelated daemon as proof of ownership (so it still attempts —
 * and hits — the real lock), and the resulting message must be the HONEST
 * mismatch one, not the generic "held by a running Lore process" phrasing.
 */
async function scenarioMismatchLocked(cmd: CommandUnderTest): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-clipreflight-mismatch-${cmd}-`));
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    // A stale auth.token: some daemon booted against this home at some
    // point in the past, even though nothing here is running now.
    fs.writeFileSync(path.join(home, 'auth.token'), 'stale-own-token', 'utf-8');
    // The "unrelated daemon" itself is started inside the victim child (see
    // childMismatchVictim's comment) — a `fetch()` from one spawned child to
    // an HTTP server bound in a SIBLING spawned child is blocked by this
    // sandbox's cross-process loopback-HTTP restriction, even though a real
    // cross-process file lock (the holder below) is unaffected.
    const unrelatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-clipreflight-mismatch-unrelated-home-'));

    const holder = spawn(tsxBin, [selfPath, '--child', 'holder'], {
        env: { ...process.env, LORE_HOME: home },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
        await new Promise<void>((resolve, reject) => {
            let buf = '';
            const timer = setTimeout(() => reject(new Error('holder did not become ready in time')), 15_000);
            holder.stdout!.on('data', (chunk) => {
                buf += chunk.toString();
                if (buf.includes('HOLDER_READY')) { clearTimeout(timer); resolve(); }
            });
            holder.on('exit', (code) => { clearTimeout(timer); reject(new Error(`holder exited early, code=${code}`)); });
        });

        const result = spawnSync(tsxBin, [selfPath, '--child', 'mismatchvictim', cmd], {
            env: { ...process.env, LORE_HOME: home, UNRELATED_HOME: unrelatedHome },
            encoding: 'utf-8',
            timeout: 30_000, // baseline sits at ~15-16.5s here; give it room
        });
        assert.equal(result.status, 0, `${cmd} mismatchlocked child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        const stdout = result.stdout;

        const threwRaw = extractSection(stdout, 'THREW');
        const threw = threwRaw ? (JSON.parse(threwRaw) as string) : null;
        const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));

        assert.ok(threw, `expected ${cmd} to throw a daemon-lock error; it returned normally`);
        assert.match(threw!, /a Lore process answers on port \d+ but reports a different home/,
            `expected the honest mismatch message from ${cmd}; got: ${threw}`);
        assert.match(threw!, /held by another process/,
            `expected the mismatch message to still say the store is held; got: ${threw}`);
        assert.doesNotMatch(threw!, /Failed to open embedded SurrealDB/,
            `raw driver error leaked through from ${cmd}: ${threw}`);
        assert.ok(elapsedMs < 8_000,
            `expected ${cmd} to hit the shortened lock-probe budget (well under the old 15s storm); took ${elapsedMs}ms`);
    } finally {
        holder.kill('SIGKILL');
    }
}

/**
 * Round E3 (2026-09-03, finding: low) — same lock shape as
 * scenarioLockConflict, but a process on LORE_PORT answers `/api/health`
 * with 401 instead of nothing. The fallback still hits the real lock, but
 * pre-fix, `cliDaemonLockMessage()` collapsed BOTH "reported a different
 * home" and "rejected our credential" into the same `mismatchedHomeSeen`
 * bit, so a 401 (which asserts nothing about whose home it is) printed the
 * exact same "reports a different home" text as a genuine mismatch. The
 * message must instead say the credential was rejected.
 */
async function scenarioCredentialRejectedLocked(cmd: CommandUnderTest): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-clipreflight-credrejected-${cmd}-`));
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    // A stale auth.token: isDaemonServingHome() only sends a Bearer (and
    // thus can only learn a daemon rejected it) when a token exists on
    // disk — without one it skips the network probe entirely.
    fs.writeFileSync(path.join(home, 'auth.token'), 'stale-own-token', 'utf-8');
    const freePort = await getFreePort();

    const holder = spawn(tsxBin, [selfPath, '--child', 'holder'], {
        env: { ...process.env, LORE_HOME: home },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
        await new Promise<void>((resolve, reject) => {
            let buf = '';
            const timer = setTimeout(() => reject(new Error('holder did not become ready in time')), 15_000);
            holder.stdout!.on('data', (chunk) => {
                buf += chunk.toString();
                if (buf.includes('HOLDER_READY')) { clearTimeout(timer); resolve(); }
            });
            holder.on('exit', (code) => { clearTimeout(timer); reject(new Error(`holder exited early, code=${code}`)); });
        });

        const result = spawnSync(tsxBin, [selfPath, '--child', 'credentialrejectedvictim', cmd], {
            env: { ...process.env, LORE_HOME: home, LORE_PORT: String(freePort) },
            encoding: 'utf-8',
            timeout: 30_000,
        });
        assert.equal(result.status, 0, `${cmd} credentialrejected child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        const stdout = result.stdout;

        const threwRaw = extractSection(stdout, 'THREW');
        const threw = threwRaw ? (JSON.parse(threwRaw) as string) : null;
        const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));

        assert.ok(threw, `expected ${cmd} to throw a daemon-lock error; it returned normally`);
        assert.match(threw!, /rejected this CLI's credential/i,
            `expected the honest rejected-credential message from ${cmd}; got: ${threw}`);
        assert.doesNotMatch(threw!, /reports a different home/i,
            `no home was ever reported (401 only) — the message must not claim one was: ${threw}`);
        assert.doesNotMatch(threw!, /Failed to open embedded SurrealDB/,
            `raw driver error leaked through from ${cmd}: ${threw}`);
        assert.ok(elapsedMs < 8_000,
            `expected ${cmd} to hit the shortened lock-probe budget (well under the old 15s storm); took ${elapsedMs}ms`);
    } finally {
        holder.kill('SIGKILL');
    }
}

async function main(): Promise<void> {
    console.log('Finding 11 follow-up (round E) + round E2 home-check fix — CLI commands honour the shared daemon preflight');
    for (const cmd of COMMANDS) {
        await test(`${cmd}: unrelated daemon on LORE_PORT, home never touched by a daemon: opens directly, succeeds`, () => scenarioUnrelatedDaemon(cmd));
    }
    await test('init: unrelated daemon on LORE_PORT, brand-new home: init succeeds', scenarioInitFresh);
    for (const cmd of COMMANDS) {
        await test(`${cmd}: daemon genuinely serving THIS home is detected; refuses fast, never opens the store`, () => scenarioOwnDaemon(cmd));
    }
    for (const cmd of COMMANDS) {
        await test(`${cmd}: store held by another process, no daemon reachable: friendly lock message, fast`, () => scenarioLockConflict(cmd));
    }
    for (const cmd of COMMANDS) {
        await test(`${cmd}: own home locked by a holder + unrelated daemon on the port: honest mismatch message`, () => scenarioMismatchLocked(cmd));
    }
    for (const cmd of COMMANDS) {
        await test(`${cmd}: own home locked by a holder + a process on the port rejects our credential (401): honest "rejected" message, not "different home"`, () => scenarioCredentialRejectedLocked(cmd));
    }

    if (failed > 0) {
        console.error(`\n${failed} test(s) failed, ${passed} passed`);
        process.exit(1);
    }
    console.log(`\nall ${passed} tests passed`);
}

/* ────────────────────────────── Dispatch ───────────────────────────────── */

const childIdx = process.argv.indexOf('--child');
if (childIdx !== -1) {
    const which = process.argv[childIdx + 1];
    const cmdArg = process.argv[childIdx + 2] as CommandUnderTest | undefined;
    if (which === 'unrelateddaemon') await childUnrelatedDaemon(cmdArg!);
    else if (which === 'initfresh') await childInitFresh();
    else if (which === 'owndaemon') await childOwnDaemon(cmdArg!);
    else if (which === 'holder') await childHolder();
    else if (which === 'lockvictim') await childLockVictim(cmdArg!);
    else if (which === 'mismatchvictim') await childMismatchVictim(cmdArg!);
    else if (which === 'credentialrejectedvictim') await childCredentialRejectedVictim(cmdArg!);
    else { console.error(`unknown --child ${which}`); process.exit(2); }
} else {
    await main();
}

#!/usr/bin/env tsx
/**
 * test/O6-drain-cli-unit.ts — Sprint O6 drain-failed CLI flag tests.
 *
 * Exercises the `outboxCommand`'s flag parsing + dispatch shape WITHOUT
 * spinning a graph engine / VerbatimStore. The end-to-end behavior with
 * real substrates is covered by O6-self-heal-unit.ts via the replicator
 * harness; this file pins the flag parser + the CLI router contract:
 *
 *   T1 — `lore outbox --help` prints subcommand list (no exit)
 *   T2 — `lore outbox drain-failed --help` prints flag list (no exit)
 *   T3 — `lore outbox bogus` exits non-zero with unknown-subcommand error
 *   T4 — parseDrainFlags defaults: checkSubstrate=true, markDead=false,
 *        dryRun=false (matches spec)
 *   T5 — parseDrainFlags parses --workspace, --dry-run, --mark-dead,
 *        --limit, --no-check-substrate
 *   T6 — parseDrainFlags ignores invalid --limit (negative / NaN)
 *   T7 — parseDrainFlags short-form -h sets help=true
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { outboxCommand, parseDrainFlags, buildDrainWiringInput } from '../packages/lore/src/cli/commands/outbox.js';

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];

function test(name: string, fn: () => Promise<void> | void): void {
    cases.push({ name, fn });
}

async function runAll(): Promise<void> {
    for (const c of cases) {
        try {
            await c.fn();
            passed++;
            console.log(`  ✓ ${c.name}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${c.name}: ${(err as Error).message}`);
        }
    }
}

function captureConsole(): { restore: () => void; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg?: unknown) => { out.push(String(msg ?? '')); };
    console.error = (msg?: unknown) => { err.push(String(msg ?? '')); };
    return {
        restore: () => { console.log = origLog; console.error = origErr; },
        out, err,
    };
}

function captureExit(): { restore: () => void; readonly code: number | null } {
    const orig = process.exit;
    const tracker = { code: null as number | null };
    (process as unknown as { exit: (n?: number) => void }).exit = (n?: number) => {
        tracker.code = n ?? 0;
        throw new Error(`__test_exit_${tracker.code}`);
    };
    return {
        restore: () => { (process as unknown as { exit: typeof orig }).exit = orig; },
        get code() { return tracker.code; },
    };
}

console.log('Sprint O6 drain-failed CLI unit tests');

test('T1 outbox --help prints subcommand list', async () => {
    const cap = captureConsole();
    try { await outboxCommand([]); } finally { cap.restore(); }
    const joined = cap.out.join('\n');
    assert.match(joined, /drain-failed/);
    assert.match(joined, /Subcommands/);
});

test('T2 drain-failed --help prints flag list', async () => {
    const cap = captureConsole();
    try { await outboxCommand(['drain-failed', '--help']); } finally { cap.restore(); }
    const joined = cap.out.join('\n');
    assert.match(joined, /--workspace/);
    assert.match(joined, /--check-substrate/);
    assert.match(joined, /--mark-dead/);
    assert.match(joined, /--dry-run/);
});

test('T3 outbox bogus exits non-zero with unknown-subcommand error', async () => {
    const cap = captureConsole();
    const exitCap = captureExit();
    let threw = false;
    try { await outboxCommand(['bogus-subcommand']); }
    catch (e) { threw = String((e as Error).message).startsWith('__test_exit_'); }
    finally { cap.restore(); exitCap.restore(); }
    assert.equal(threw, true);
    assert.notEqual(exitCap.code, 0);
    assert.match(cap.err.join('\n'), /Unknown 'lore outbox' subcommand/);
});

test('T4 parseDrainFlags defaults', () => {
    const f = parseDrainFlags([]);
    assert.equal(f.checkSubstrate, true);
    assert.equal(f.markDead, false);
    assert.equal(f.dryRun, false);
    assert.equal(f.workspace, undefined);
    assert.equal(f.limit, undefined);
    assert.equal(f.help, false);
});

test('T5 parseDrainFlags parses full flag set', () => {
    const f = parseDrainFlags(['--workspace', 'ws1', '--dry-run', '--mark-dead', '--no-check-substrate', '--limit', '42']);
    assert.equal(f.workspace, 'ws1');
    assert.equal(f.dryRun, true);
    assert.equal(f.markDead, true);
    assert.equal(f.checkSubstrate, false);
    assert.equal(f.limit, 42);
});

test('T6 parseDrainFlags ignores invalid --limit', () => {
    const fNeg = parseDrainFlags(['--limit', '-5']);
    const fNaN = parseDrainFlags(['--limit', 'abc']);
    assert.equal(fNeg.limit, undefined);
    assert.equal(fNaN.limit, undefined);
});

test('T7 parseDrainFlags short-form -h sets help', () => {
    const f = parseDrainFlags(['-h']);
    assert.equal(f.help, true);
});

// L-004 — drain-failed must thread a getGraphForWorkspace resolver so a
// non-default workspace's rows are verified against THAT workspace's declared
// graph engine, not the boot-bound graph. Previously no resolver was passed →
// wiring.resolveGraph fell back to the boot graph for every row (false
// negatives on atlas rows). buildDrainWiringInput is the pure seam; we assert
// the resolver is present and routes by workspace through getGraphHandle — the
// engine-aware registry accessor — without opening real graphs.
test('T8 buildDrainWiringInput threads an engine-aware per-workspace resolver', async () => {
    const opened: string[] = [];
    const fakeGraph = { __fake: true };
    const registry = {
        getGraphHandle: async (ws: string) => { opened.push(ws); return fakeGraph; },
    };
    const input = buildDrainWiringInput({ loreDir: '/tmp/.lore', bootGraph: fakeGraph, registry });

    // getGraph returns the pre-opened boot graph synchronously (boot fallback).
    assert.equal(input.getGraph(), fakeGraph);

    // getGraphForWorkspace MUST be present (the L-004 fix) …
    assert.equal(typeof input.getGraphForWorkspace, 'function', 'resolver getter present');
    const resolver = input.getGraphForWorkspace();
    assert.equal(typeof resolver, 'function', 'resolver is a function');

    // … and routes each row's probe to its OWN workspace's graph handle.
    const g = await resolver!('atlas');
    assert.equal(g, fakeGraph);
    assert.deepEqual(opened, ['atlas'], 'resolver opened the requested workspace through getGraphHandle');

    // loreDir is passed through unchanged (outbox SQLite location must not move).
    assert.equal(input.loreDir, '/tmp/.lore');
});

/*
 * ─────────────────────────────────────────────────────────────────────────
 * X-outboxcli (2026-09-03, high) — real-substrate daemon/lock preflight
 * regression tests, T9-T13.
 *
 * T1-T8 above pin the flag parser + dispatch shape WITHOUT a real graph
 * engine, per this file's own header. `--check-substrate` (the default)
 * DOES open a real graph store via LocalGraphRegistry, and — before this
 * fix — did so with NO daemon/lock preflight at all: with a daemon (or any
 * other process) holding the active workspace's store, `lore outbox
 * drain-failed` sat through the full ~15s openSurreal retry storm and then
 * died with the raw `[LoreGraph:openSurreal] Failed to open embedded
 * SurrealDB…` driver error, instead of the friendly refusal every other
 * store-touching CLI command gives (openGraphForCli's 18 callers in
 * shared.ts; the probeSurrealLock users in compact.ts/backup.ts/
 * restore.ts/maintain.ts). Reproduced in
 * qa/X-outboxcli-repro/repro.mts: a bare holder SurrealGraph (no daemon at
 * all) made BOTH `drain-failed` and `drain-failed --no-check-substrate`
 * hang ~15.8s and throw the raw error — the unconditional boot-graph open
 * used to run before the --check-substrate/--no-check-substrate branch
 * decision, so even the documented "SQLite-only, daemon-safe" path was not
 * actually SQLite-only.
 *
 * These tests spawn each scenario in its OWN `tsx` child process, exactly
 * like test/compact-maintain-otherdaemon-unit.ts and
 * test/cli-daemon-preflight-unit.ts: `DEFAULT_PORT` in
 * migrateWorkspaceToWorkspaceShared.ts is `Number(process.env['LORE_PORT']
 * ?? 3847)`, evaluated ONCE at module load, so every scenario needs its own
 * process to set LORE_PORT before that module is first imported. No port in
 * this file is ever 3847/3848 — every daemon here binds an OS-assigned free
 * port.
 *
 * T9  — check-substrate (default flags) refuses FAST (well under the old
 *       ~15s budget) with the friendly message when the active workspace's
 *       graph store is genuinely held by another process and no daemon
 *       answers LORE_PORT at all — the "lock the HTTP preflight can't see"
 *       fallback layer. No raw `[LoreGraph:openSurreal]` text reaches
 *       stderr.
 * T10 — --no-check-substrate proceeds normally and FAST against the SAME
 *       locked store — proves the SQLite-only path no longer touches the
 *       graph at all (this is the part of the fix beyond the narrow
 *       --check-substrate ask: the shared eager boot-graph open used to
 *       break this path's own "daemon-safe" documentation too).
 * T11 — check-substrate refuses via the isDaemonServingHome() preflight,
 *       FAST (well under a second — no graph open ever attempted), against
 *       a REAL spawned daemon serving this exact home.
 * T12 — --force bypasses the HTTP-preflight refusal against a rejected-
 *       token fake daemon with NO real underlying lock — the sweep
 *       actually runs and reports on the seeded row.
 * T13 — --force against a GENUINE on-disk lock still prints the standard
 *       "proceeding with --force; daemon/lock checks skipped" notice, but
 *       (force can bypass a refusal, not physics) still fails — FAST, with
 *       the friendly message, never the raw driver error.
 * ─────────────────────────────────────────────────────────────────────────
 */

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(selfPath), '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const SERVER_ENTRY = path.join(repoRoot, 'packages/lore/src/mcp/server.ts');

function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object') { const p = addr.port; srv.close(() => resolve(p)); }
            else srv.close(() => reject(new Error('no free port')));
        });
    });
}

/** Seed one 'failed' row in the active workspace's outbox SQLite store, the
 *  shape drain-failed's sweep examines. Returns the active workspace's path
 *  + name (both needed by the lock-holder fixtures below). */
async function seedFailedRow(home: string): Promise<{ wsPath: string; wsName: string }> {
    const { getActiveWorkspacePath, getActiveWorkspaceName } = await import('../packages/lore/src/config/workspaces.js');
    const { SqliteOutboxStore } = await import('../packages/lore/src/outbox/sqliteStore.js');
    const wsPath = getActiveWorkspacePath(home);
    const wsName = getActiveWorkspaceName(home);
    const loreDir = path.join(wsPath, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const store = new SqliteOutboxStore(loreDir);
    const nowIso = new Date().toISOString();
    await store.record({
        id: 'row-1',
        operation: 'node.upsert',
        initiator: 'test:O6-drain-cli-unit',
        createdAt: nowIso,
        updatedAt: nowIso,
        steps: [],
        completed: false,
        workspace: wsName,
        operationKind: 'node.upsert',
        payload: { id: 'n1' },
        status: 'pending',
    });
    await store.markEntryStatus!('row-1', 'failed', { error: 'seed' });
    return { wsPath, wsName };
}

/** Open (and immediately close) then re-open a SurrealGraph on `wsPath`, so
 *  the second handle is a genuine live holder of the on-disk lock — same
 *  fixture shape as compact-maintain-otherdaemon-unit.ts's childT2/childT6. */
async function holdGraphStore(wsPath: string, wsName: string): Promise<{ close: () => Promise<void> }> {
    const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
    const seeder = new SurrealGraph(wsPath, { workspaceId: wsName });
    await seeder.initialize();
    await seeder.close();
    const holder = new SurrealGraph(wsPath, { workspaceId: wsName });
    await holder.initialize();
    return { close: () => holder.close() };
}

function startRejectingDaemon(): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if ((req.url ?? '').startsWith('/api/health')) {
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'unauthorized' }));
                return;
            }
            res.writeHead(404);
            res.end('{}');
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as { port: number }).port });
        });
    });
}

function runOutboxCapturing(args: string[]): Promise<{ exitCode: number | null; out: string[]; err: string[]; elapsedMs: number }> {
    return (async () => {
        const out: string[] = [];
        const err: string[] = [];
        const origLog = console.log;
        const origErr = console.error;
        console.log = (msg?: unknown) => { out.push(String(msg ?? '')); };
        console.error = (msg?: unknown) => { err.push(String(msg ?? '')); };
        const origExit = process.exit.bind(process);
        let exitCode: number | null = null;
        (process as unknown as { exit: (n?: number) => void }).exit = (n?: number) => {
            exitCode = n ?? 0;
            throw new Error('__test_exit__');
        };
        const t0 = Date.now();
        try {
            await outboxCommand(args);
        } catch (e) {
            if ((e as Error).message !== '__test_exit__') throw e;
        } finally {
            const elapsedMs = Date.now() - t0;
            console.log = origLog;
            console.error = origErr;
            (process as unknown as { exit: typeof origExit }).exit = origExit;
            return { exitCode, out, err, elapsedMs };
        }
    })();
}

/* ─────────────────────────── Child-process bodies ─────────────────────── */

async function childT9(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { wsPath, wsName } = await seedFailedRow(home);
    const holder = await holdGraphStore(wsPath, wsName);

    const { exitCode, err, elapsedMs } = await runOutboxCapturing(['drain-failed']);
    await holder.close().catch(() => undefined);

    console.log('===RESULT_START===');
    console.log(`EXIT_CODE=${exitCode === null ? '' : exitCode}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log(`STDERR_JOINED=${err.join(' | ').replace(/\n/g, ' ')}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT10(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { wsPath, wsName } = await seedFailedRow(home);
    const holder = await holdGraphStore(wsPath, wsName);

    const { exitCode, out, err, elapsedMs } = await runOutboxCapturing(['drain-failed', '--no-check-substrate']);
    await holder.close().catch(() => undefined);

    console.log('===RESULT_START===');
    console.log(`EXIT_CODE=${exitCode === null ? '' : exitCode}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log(`STDOUT_JOINED=${out.join(' | ').replace(/\n/g, ' ')}`);
    console.log(`STDERR_JOINED=${err.join(' | ').replace(/\n/g, ' ')}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT11(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    await seedFailedRow(home);
    const port = await findFreePort();
    // Set BEFORE any import that transitively pulls in
    // migrateWorkspaceToWorkspaceShared.js (outbox.js does, via the
    // --check-substrate branch's dynamic import) — DEFAULT_PORT there is
    // read once at module load.
    process.env['LORE_PORT'] = String(port);

    const proc = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY, '--http'], {
        cwd: repoRoot,
        env: { ...process.env, LORE_HOME: home, LORE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    proc.stdout.on('data', (c) => { log += c.toString(); });
    proc.stderr.on('data', (c) => { log += c.toString(); });

    async function waitReady(timeoutMs = 20_000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 150));
        }
        return false;
    }

    let exitCode: number | null = null;
    let err: string[] = [];
    let elapsedMs = -1;
    try {
        const ready = await waitReady();
        if (!ready) throw new Error(`real daemon never became ready:\n${log}`);
        const result = await runOutboxCapturing(['drain-failed']);
        exitCode = result.exitCode;
        err = result.err;
        elapsedMs = result.elapsedMs;
    } finally {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }

    console.log('===RESULT_START===');
    console.log(`EXIT_CODE=${exitCode === null ? '' : exitCode}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log(`STDERR_JOINED=${err.join(' | ').replace(/\n/g, ' ')}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT12(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    await seedFailedRow(home);

    fs.writeFileSync(path.join(home, 'auth.token'), 'stale-token', 'utf-8');
    const { server, port } = await startRejectingDaemon();
    process.env['LORE_PORT'] = String(port);

    // First: no --force must refuse (control, mirrors compact's T1/T8).
    const refused = await runOutboxCapturing(['drain-failed']);
    // Then: --force must bypass the refusal and actually run the sweep.
    const forced = await runOutboxCapturing(['drain-failed', '--force']);
    server.close();

    console.log('===RESULT_START===');
    console.log(`REFUSED_EXIT_CODE=${refused.exitCode === null ? '' : refused.exitCode}`);
    console.log(`REFUSED_STDERR=${refused.err.join(' | ').replace(/\n/g, ' ')}`);
    console.log(`FORCED_EXIT_CODE=${forced.exitCode === null ? '' : forced.exitCode}`);
    console.log(`FORCED_STDOUT=${forced.out.join(' | ').replace(/\n/g, ' ')}`);
    console.log(`FORCED_STDERR=${forced.err.join(' | ').replace(/\n/g, ' ')}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT13(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { wsPath, wsName } = await seedFailedRow(home);
    const holder = await holdGraphStore(wsPath, wsName);

    const { exitCode, err, elapsedMs } = await runOutboxCapturing(['drain-failed', '--force']);
    await holder.close().catch(() => undefined);

    console.log('===RESULT_START===');
    console.log(`EXIT_CODE=${exitCode === null ? '' : exitCode}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log(`STDERR_JOINED=${err.join(' | ').replace(/\n/g, ' ')}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
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

function runChild(name: string, timeoutMs = 30_000): { stdout: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-O6-drain-cli-${name}-`));
    const { LORE_PORT: _unused, ...restEnv } = process.env;
    const result = spawnSync(tsxBin, [selfPath, '--child', name], {
        env: { ...restEnv, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: timeoutMs,
    });
    assert.equal(result.status, 0, `child ${name} failed (status=${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return { stdout: result.stdout };
}

// Registered via the same `test()`/`cases` mechanism as T1-T8 above (it only
// pushes onto `cases`; `runAll()` below is what actually executes them, in
// registration order, awaiting each in turn — spawnSync-driven child bodies
// are fine here since `runAll()` awaits each case's fn()).
function registerRealSubstrateTests(): void {
    test('T9 check-substrate refuses FAST with the friendly message against a genuine on-disk lock, no daemon reachable', async () => {
        const { stdout } = runChild('t9');
        const exitCode = extractSection(stdout, 'EXIT_CODE');
        const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));
        const stderrJoined = extractSection(stdout, 'STDERR_JOINED');
        assert.equal(exitCode, '1', 'drain-failed must exit(1) while the graph store is genuinely held');
        assert.ok(elapsedMs < 5000, `expected a fast refusal well under the old ~15s budget, got ${elapsedMs}ms`);
        assert.match(stderrJoined, /store is held by a running Lore process/i, `expected the friendly lock message, got: ${stderrJoined}`);
        assert.doesNotMatch(stderrJoined, /\[LoreGraph:openSurreal\]/, `must not leak the raw driver error, got: ${stderrJoined}`);
    });

    test('T10 --no-check-substrate proceeds normally and FAST against the SAME locked store (SQLite-only, never touches the graph)', async () => {
        const { stdout } = runChild('t10');
        const exitCode = extractSection(stdout, 'EXIT_CODE');
        const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));
        const stdoutJoined = extractSection(stdout, 'STDOUT_JOINED');
        const stderrJoined = extractSection(stdout, 'STDERR_JOINED');
        assert.equal(exitCode, '', 'drain-failed --no-check-substrate must not exit/throw while the graph store is locked');
        assert.ok(elapsedMs < 5000, `expected the SQLite-only path to stay fast, got ${elapsedMs}ms`);
        assert.match(stdoutJoined, /examined:\s*1/, `expected the sweep to have examined the seeded row, got: ${stdoutJoined}`);
        assert.doesNotMatch(stderrJoined, /\[LoreGraph:openSurreal\]/, `must never attempt a graph open on this path, got: ${stderrJoined}`);
    });

    test('T11 check-substrate refuses via isDaemonServingHome preflight against a REAL spawned daemon serving this home', async () => {
        const { stdout } = runChild('t11', 60_000); // real daemon boot is slower than the other, fully in-process cases
        const exitCode = extractSection(stdout, 'EXIT_CODE');
        const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));
        const stderrJoined = extractSection(stdout, 'STDERR_JOINED');
        assert.equal(exitCode, '1', 'drain-failed must exit(1) when the real daemon confirms it serves this home');
        assert.ok(elapsedMs < 5000, `expected the HTTP preflight to refuse near-instantly (no graph open attempted), got ${elapsedMs}ms`);
        assert.match(stderrJoined, /daemon is running/i, `expected daemonRefuseMessage's text, got: ${stderrJoined}`);
    });

    test('T12 --force bypasses the HTTP-preflight refusal against a rejected-token fake daemon with no real lock, and the sweep actually runs', async () => {
        const { stdout } = runChild('t12');
        const refusedExit = extractSection(stdout, 'REFUSED_EXIT_CODE');
        const refusedStderr = extractSection(stdout, 'REFUSED_STDERR');
        const forcedExit = extractSection(stdout, 'FORCED_EXIT_CODE');
        const forcedStdout = extractSection(stdout, 'FORCED_STDOUT');
        const forcedStderr = extractSection(stdout, 'FORCED_STDERR');
        assert.equal(refusedExit, '1', 'without --force, a rejected-token daemon must still refuse (otherDaemonReachable)');
        assert.match(refusedStderr, /rejected this CLI token/i, `expected otherDaemonRefuseMessage's text, got: ${refusedStderr}`);
        assert.equal(forcedExit, '', '--force must let the sweep actually run (no exit/throw) when nothing really holds the store');
        assert.match(forcedStderr, /proceeding with --force; daemon\/lock checks skipped/, `expected the standard --force bypass notice, got: ${forcedStderr}`);
        assert.match(forcedStdout, /examined:\s*1/, `expected the sweep to have actually examined the seeded row, got: ${forcedStdout}`);
    });

    test('T13 --force against a GENUINE on-disk lock still prints the bypass notice but fails FAST with the friendly message (not raw)', async () => {
        const { stdout } = runChild('t13');
        const exitCode = extractSection(stdout, 'EXIT_CODE');
        const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));
        const stderrJoined = extractSection(stdout, 'STDERR_JOINED');
        assert.equal(exitCode, '1', '--force cannot make a genuinely locked store open — must still exit(1)');
        assert.ok(elapsedMs < 5000, `expected the shortened open-retry budget to still apply under --force, got ${elapsedMs}ms`);
        assert.match(stderrJoined, /proceeding with --force; daemon\/lock checks skipped/, `expected the bypass notice, got: ${stderrJoined}`);
        assert.match(stderrJoined, /store is held by a running Lore process/i, `expected the friendly lock message even under --force, got: ${stderrJoined}`);
        assert.doesNotMatch(stderrJoined, /\[LoreGraph:openSurreal\]/, `must not leak the raw driver error even under --force, got: ${stderrJoined}`);
    });
}

/* ────────────────────────────── Dispatch ───────────────────────────────── */

const childIdx = process.argv.indexOf('--child');
if (childIdx !== -1) {
    const which = process.argv[childIdx + 1];
    const CHILDREN: Record<string, () => Promise<void>> = {
        t9: childT9, t10: childT10, t11: childT11, t12: childT12, t13: childT13,
    };
    const fn = which ? CHILDREN[which] : undefined;
    if (!fn) { console.error(`unknown --child ${which}`); process.exit(2); }
    await fn();
} else {
    registerRealSubstrateTests();
    await runAll();

    console.log('');
    console.log(`passed:  ${passed}`);
    console.log(`failed:  ${failed}`);
    if (failed > 0) process.exit(1);
    console.log('OK');
}

#!/usr/bin/env tsx
/**
 * status-daemon-preflight-unit.ts — `lore status` daemon preflight + lock
 * handling regression coverage.
 *
 * `status.ts` (packages/lore/src/cli/commands/status.ts) has the same SW-11
 * shape as `doctor.ts` — a home-aware daemon preflight (`isDaemonServingHome`,
 * round E2, 2026-09-03) plus a shortened `openSurreal` retry budget
 * (`STATUS_OPEN_BUDGET_MS`) and a friendly lock message for the case that
 * preflight misses — but `grep -rl statusCommand test/` returned nothing:
 * zero automated coverage existed for it before this file, even though
 * doctor/recall/export/compact all have their own (doctor-daemon-port-unit.ts,
 * cli-daemon-preflight-unit.ts).
 *
 * Five scenarios, each driven by directly calling the real `statusCommand`
 * inside a freshly spawned `tsx` child process (fresh module cache per
 * scenario — `DEFAULT_PORT` in migrateWorkspaceToWorkspaceShared.ts is read
 * once at module load from `LORE_PORT`, so each scenario needs its own
 * process to pick up its own port). Within the child, `console.log` /
 * `console.error` are captured and `process.exit` is intercepted (thrown as a
 * sentinel, caught locally) instead of actually calling the real
 * `process.exit` — statusCommand calls that synchronously on several
 * branches, and letting it actually fire mid-write risks truncating captured
 * stdio piped back to the parent. The child then prints its own captured
 * results as `KEY=value` markers and exits cleanly itself via a real
 * `process.exit(0)` at the very end, once nothing more needs to be written —
 * the same pattern doctor-daemon-port-unit.ts and cli-daemon-preflight-unit.ts
 * already use for their own child-process result markers.
 *
 *   1. "owndaemon" — a fake daemon that DOES write this home's `auth.token`
 *      and answers `/api/health` with a matching `loreHome` for that exact
 *      Bearer (a genuine "it really is our own daemon" fixture, same shape as
 *      cli-daemon-preflight-unit.ts's childOwnDaemon). status must refuse
 *      fast (< 5s) with the store-held message and exit code 1, without ever
 *      opening the on-disk store.
 *
 *   2. "unrelateddaemon" — a daemon answers `/api/health` 200 on LORE_PORT,
 *      but this home has no `auth.token` (never had a daemon boot against
 *      it) and its store is genuinely free. isDaemonServingHome() skips the
 *      network probe entirely with no token on disk, so status must open the
 *      store DIRECTLY and print real (zero, for a fresh store) counts —
 *      succeeding despite the unrelated daemon being reachable on the port.
 *
 *   3. "lockvictim" — a holder child process (a real SurrealGraph handle,
 *      spawned separately so the single-writer lock is a genuine cross-process
 *      file lock) holds the SAME workspace directly. No daemon answers
 *      LORE_PORT at all (an OS-assigned free port with nothing bound to it —
 *      never 3847/3848). status must fall through to a direct open, hit the
 *      real lock, and report the friendly SW-11 message fast (well under the
 *      old 15s retry-storm budget), never the raw
 *      `[LoreGraph:openSurreal] Failed to open embedded SurrealDB…` driver
 *      text.
 *
 *   4. "freestore" — no daemon reachable at all, no token, and the store is
 *      genuinely free: status must print the normal full output (Status
 *      header, Knowledge Graph section, Sync section) and exit normally (no
 *      `process.exit` call at all).
 *
 *   5. "missingloredir" — a brand-new home with no `.lore/` directory at all:
 *      status must print the `lore init` message and exit code 1, without
 *      ever probing a daemon or opening a graph.
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

/** Thrown by the intercepted `process.exit` instead of actually terminating
 *  the process — lets a child scenario observe statusCommand's exit code
 *  without risking truncated stdio from a real exit mid-write. */
class ProcessExitSignal extends Error {
    constructor(public readonly code: number) {
        super(`process.exit(${code})`);
    }
}

/** Drive the real statusCommand in-process: capture console.log/console.error
 *  output, intercept process.exit as a thrown sentinel, and time the call.
 *  `exitCode` is `null` when statusCommand returned normally (no exit call at
 *  all) — its success path never calls process.exit. */
async function runStatusCapturing(): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    elapsedMs: number;
}> {
    const { statusCommand } = await import('../packages/lore/src/cli/commands/status.js');

    const origLog = console.log;
    const origError = console.error;
    const origExit = process.exit;
    let stdout = '';
    let stderr = '';
    console.log = ((...args: unknown[]) => { stdout += args.map(String).join(' ') + '\n'; }) as typeof console.log;
    console.error = ((...args: unknown[]) => { stderr += args.map(String).join(' ') + '\n'; }) as typeof console.error;
    let exitCode: number | null = null;
    process.exit = ((code?: number) => {
        exitCode = code ?? 0;
        throw new ProcessExitSignal(exitCode);
    }) as typeof process.exit;

    const t0 = Date.now();
    try {
        await statusCommand([]);
    } catch (e) {
        if (!(e instanceof ProcessExitSignal)) throw e;
    } finally {
        console.log = origLog;
        console.error = origError;
        process.exit = origExit;
    }
    const elapsedMs = Date.now() - t0;
    return { stdout, stderr, exitCode, elapsedMs };
}

/** Print a child's captured result as `KEY=value` markers between fixed
 *  delimiters, exactly like doctor-daemon-port-unit.ts's own child bodies —
 *  the multi-line stdout/stderr text is JSON-stringified so embedded
 *  newlines survive the line-oriented marker format. */
function printResult(result: { stdout: string; stderr: string; exitCode: number | null; elapsedMs: number }): void {
    console.log('===RESULT_START===');
    console.log(`STDOUT=${JSON.stringify(result.stdout)}`);
    console.log(`STDERR=${JSON.stringify(result.stderr)}`);
    console.log(`EXIT_CODE=${result.exitCode === null ? 'null' : String(result.exitCode)}`);
    console.log(`ELAPSED_MS=${result.elapsedMs}`);
    console.log('===RESULT_END===');
}

/**
 * Scenario 1 — a fake daemon that DOES write this home's `auth.token` and
 * answers with a matching `loreHome` for that exact Bearer. status must
 * refuse fast with the friendly message and never touch the on-disk store.
 */
async function childOwnDaemon(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    const token = 'own-daemon-status-test-token';
    fs.writeFileSync(path.join(home, 'auth.token'), token, 'utf-8');

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if ((req.url ?? '').startsWith('/api/health')) {
            res.writeHead(200);
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

    const result = await runStatusCapturing();
    server.close();
    printResult(result);
    process.exit(0);
}

/**
 * Scenario 2 — a daemon answers `/api/health` 200 on LORE_PORT, but this
 * home has no `auth.token` (never had a daemon boot against it). status must
 * open the store directly and succeed.
 */
async function childUnrelatedDaemon(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
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

    const result = await runStatusCapturing();
    server.close();
    printResult(result);
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

/**
 * Scenario 3 — the store is genuinely locked by a separately spawned holder
 * process, and no daemon answers LORE_PORT at all. status must fall through
 * to a direct open, hit the real lock, and report the friendly message fast.
 */
async function childLockVictim(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    assert.ok(!fs.existsSync(path.join(home, 'auth.token')), 'test setup: no auth.token expected');
    const result = await runStatusCapturing();
    printResult(result);
    process.exit(0);
}

/**
 * Scenario 4 — no daemon reachable, no token, store genuinely free. status
 * must print the normal full output and return without ever calling
 * process.exit.
 */
async function childFreeStore(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    assert.ok(!fs.existsSync(path.join(home, 'auth.token')), 'test setup: no auth.token expected');

    const result = await runStatusCapturing();
    printResult(result);
    process.exit(0);
}

/**
 * Scenario 5 — a brand-new home with no `.lore/` directory at all. status
 * must print the "lore init" message and exit 1, without probing a daemon or
 * opening a graph.
 */
async function childMissingLoreDir(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    assert.ok(!fs.existsSync(path.join(home, '.lore')), 'test setup: .lore must not exist yet');

    const result = await runStatusCapturing();
    printResult(result);
    process.exit(0);
}

/* ───────────────────────────── Orchestrator ────────────────────────────── */

interface StatusResult { stdout: string; stderr: string; exitCode: number | null; elapsedMs: number }

function extractResult(stdout: string): StatusResult {
    const startTag = '===RESULT_START===';
    const endTag = '===RESULT_END===';
    const startIdx = stdout.indexOf(startTag);
    const endIdx = stdout.indexOf(endTag);
    assert.ok(startIdx !== -1 && endIdx !== -1, `child stdout missing ${startTag}/${endTag} markers:\n${stdout}`);
    const section = stdout.slice(startIdx + startTag.length, endIdx);
    const grab = (marker: string): string => {
        const m = new RegExp(`^${marker}=(.*)$`, 'm').exec(section);
        assert.ok(m, `child stdout missing ${marker}= marker:\n${stdout}`);
        return m![1]!;
    };
    const exitRaw = grab('EXIT_CODE');
    return {
        stdout: JSON.parse(grab('STDOUT')) as string,
        stderr: JSON.parse(grab('STDERR')) as string,
        exitCode: exitRaw === 'null' ? null : Number(exitRaw),
        elapsedMs: Number(grab('ELAPSED_MS')),
    };
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

async function scenarioOwnDaemon(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-status-owndaemon-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'owndaemon'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `owndaemon child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const { stderr, exitCode, elapsedMs } = extractResult(result.stdout);

    assert.equal(exitCode, 1, `expected status to exit(1) when its own daemon holds the store; stderr:\n${stderr}`);
    assert.match(stderr, /store is held by a running Lore process/,
        `expected the friendly daemon-lock message; got stderr:\n${stderr}`);
    assert.doesNotMatch(stderr, /Failed to open embedded SurrealDB/,
        `raw driver error leaked through: ${stderr}`);
    assert.equal(fs.existsSync(path.join(home, '.lore', 'surreal')), false,
        'status must not have opened/created the on-disk store while its own daemon answers over HTTP');
    assert.ok(elapsedMs < 5_000, `expected status to finish in well under 5s via the daemon preflight; took ${elapsedMs}ms`);
}

async function scenarioUnrelatedDaemon(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-status-unrelated-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'unrelateddaemon'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `unrelateddaemon child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const { stdout, stderr, exitCode, elapsedMs } = extractResult(result.stdout);

    assert.equal(exitCode, null,
        `expected status to open the store directly and return normally despite an unrelated daemon on LORE_PORT; stderr:\n${stderr}`);
    assert.match(stdout, /@groundfloor\/lore — Status/, `expected the normal status header; got stdout:\n${stdout}`);
    assert.match(stdout, /Nodes:\s*0/, `expected a real (zero) node count on a fresh store; got stdout:\n${stdout}`);
    assert.match(stdout, /Edges:\s*0/, `expected a real (zero) edge count on a fresh store; got stdout:\n${stdout}`);
    assert.ok(elapsedMs < 5_000, `expected status to finish in well under 5s; took ${elapsedMs}ms`);
}

async function scenarioLockConflict(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-status-lock-'));
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

        const result = spawnSync(tsxBin, [selfPath, '--child', 'lockvictim'], {
            env: { ...process.env, LORE_HOME: home, LORE_PORT: String(freePort) },
            encoding: 'utf-8',
            timeout: 30_000, // baseline sits at ~15-16.5s pre-fix; give it room
        });
        assert.equal(result.status, 0, `lockvictim child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        const { stderr, exitCode, elapsedMs } = extractResult(result.stdout);

        assert.equal(exitCode, 1, `expected status to exit(1) when the store is locked by another process; stderr:\n${stderr}`);
        assert.match(stderr, /store is held by a running Lore process/,
            `expected the friendly lock message; got stderr:\n${stderr}`);
        assert.doesNotMatch(stderr, /Failed to open embedded SurrealDB/,
            `raw driver error leaked through: ${stderr}`);
        assert.doesNotMatch(stderr, /openSurreal/,
            `raw internal operation name leaked through: ${stderr}`);
        assert.ok(elapsedMs < 8_000,
            `expected the shortened lock-probe budget (well under the old 15s storm); took ${elapsedMs}ms`);
    } finally {
        holder.kill('SIGKILL');
    }
}

async function scenarioFreeStore(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-status-free-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'freestore'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `freestore child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const { stdout, stderr, exitCode, elapsedMs } = extractResult(result.stdout);

    assert.equal(exitCode, null, `expected status to return normally on a free store; stderr:\n${stderr}`);
    assert.match(stdout, /@groundfloor\/lore — Status/, `expected the normal status header; got stdout:\n${stdout}`);
    assert.match(stdout, /Knowledge Graph/, `expected the Knowledge Graph section; got stdout:\n${stdout}`);
    assert.match(stdout, /Sync/, `expected the Sync section; got stdout:\n${stdout}`);
    assert.equal(stderr, '', `expected no stderr output on the normal success path; got: ${stderr}`);
    assert.ok(elapsedMs < 5_000, `expected status to finish in well under 5s; took ${elapsedMs}ms`);
}

async function scenarioMissingLoreDir(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-status-missingdir-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'missingloredir'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `missingloredir child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const { stderr, exitCode, elapsedMs } = extractResult(result.stdout);

    assert.equal(exitCode, 1, `expected status to exit(1) when .lore/ is missing; stderr:\n${stderr}`);
    assert.match(stderr, /No \.lore\/ directory found/, `expected the missing-dir message; got stderr:\n${stderr}`);
    assert.match(stderr, /lore init/, `expected the message to point at "lore init"; got stderr:\n${stderr}`);
    assert.ok(elapsedMs < 2_000, `expected the missing-dir check to be immediate (no daemon probe, no graph open); took ${elapsedMs}ms`);
}

async function main(): Promise<void> {
    console.log('lore status — daemon preflight + lock handling regression coverage');
    await test('own daemon on LORE_PORT (auth.token present, health confirms this home): refused fast, exit 1', scenarioOwnDaemon);
    await test('unrelated daemon on LORE_PORT (home never daemon-booted, no auth.token): opens directly, prints real counts', scenarioUnrelatedDaemon);
    await test('no daemon, store held by a holder process: friendly lock message within the shortened budget', scenarioLockConflict);
    await test('no daemon, free store: normal full status output, no exit call', scenarioFreeStore);
    await test('missing .lore dir: "lore init" message, exit 1', scenarioMissingLoreDir);

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
    if (which === 'owndaemon') await childOwnDaemon();
    else if (which === 'unrelateddaemon') await childUnrelatedDaemon();
    else if (which === 'holder') await childHolder();
    else if (which === 'lockvictim') await childLockVictim();
    else if (which === 'freestore') await childFreeStore();
    else if (which === 'missingloredir') await childMissingLoreDir();
    else { console.error(`unknown --child ${which}`); process.exit(2); }
} else {
    await main();
}

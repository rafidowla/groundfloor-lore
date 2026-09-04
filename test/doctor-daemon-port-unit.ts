#!/usr/bin/env tsx
/**
 * doctor-daemon-port-unit.ts — SW-11 regression: `lore doctor` daemon
 * detection + lock-conflict handling.
 *
 * Before the fix, `doctor.ts` probed the daemon's `/api/health` on a
 * hardcoded port 3847, ignoring `LORE_PORT`. A daemon on a non-default port
 * went undetected, so doctor fell through to a direct store open — and
 * because SurrealDB's `surrealkv` backend takes a single-writer lock on the
 * whole workspace directory, that collided with whatever holds it (the real
 * daemon, or another CLI process) and sat in the full 15s `openSurreal`
 * retry storm before dumping a raw driver error.
 *
 * Two scenarios, each run in its own child process (fresh module cache, so
 * each gets its own `LORE_HOME` / `LORE_PORT` env at import time — the
 * `DEFAULT_PORT` constant in migrateWorkspaceToWorkspaceShared.ts is read
 * once at module load):
 *
 *   1. "httpdaemon" — a plain HTTP server on an OS-assigned ephemeral port
 *      stands in for the daemon; `LORE_PORT` points at it. Doctor must
 *      detect it (any port, via the shared isDaemonUp()/DEFAULT_PORT), read
 *      the graph via `/api/topology`, and NEVER touch the on-disk store
 *      (no `.lore/surreal` directory created, no lock-flavoured message,
 *      finishes in well under 5s).
 *
 *   2. "lockvictim" — a holder child process opens the SAME workspace
 *      directly (a real SurrealGraph handle) and keeps it open. No daemon
 *      answers `LORE_PORT` (an OS-assigned free port with nothing bound to
 *      it — never 3847/3848). Doctor must fall through to a direct open,
 *      hit the real single-writer lock, and report the SW-11 friendly
 *      message ("store is held by a running Lore process — set LORE_PORT to
 *      reach it or stop it") — fast (well under the old 15s budget), not
 *      the raw `[LoreGraph:openSurreal] Failed to open embedded SurrealDB…`
 *      driver message.
 *
 * Fails on the pre-fix base: scenario 1 never finds the fake daemon (wrong
 * hardcoded port) and instead silently succeeds via a direct open of the
 * (empty, unlocked) store — creating `.lore/surreal` and never producing a
 * "Graph (via daemon)" finding. Scenario 2 still detects no daemon (same
 * outcome pre- and post-fix there) but sits in the full ~15s retry budget
 * and reports the raw driver message instead of the SW-11 one.
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

/** Capture doctor's --json stdout (the JSON is written after console.log is
 *  restored, via process.stdout.write) and how long the command took. */
async function runDoctorJsonCapturingStdout(): Promise<{ json: string; elapsedMs: number }> {
    const { doctorCommand } = await import('../packages/lore/src/cli/commands/doctor.js');
    const origWrite = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = ((chunk: unknown) => {
        out += typeof chunk === 'string' ? chunk : String(chunk);
        return true;
    }) as typeof process.stdout.write;
    const t0 = Date.now();
    try {
        await doctorCommand(['--json']);
    } finally {
        process.stdout.write = origWrite;
    }
    return { json: out, elapsedMs: Date.now() - t0 };
}

/** Same as runDoctorJsonCapturingStdout, but reports whether doctorCommand
 *  threw instead of letting it propagate — used by the json-throw safety-net
 *  scenario below, where the whole point is to observe what --json mode
 *  does when the diagnostic body throws (pre-fix: nothing reaches stdout at
 *  all; post-fix: a valid JSON envelope with a `fatal` field). */
async function runDoctorJsonCapturingStdoutAllowThrow(): Promise<{ json: string; elapsedMs: number; threw: string | null }> {
    const { doctorCommand } = await import('../packages/lore/src/cli/commands/doctor.js');
    const origWrite = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = ((chunk: unknown) => {
        out += typeof chunk === 'string' ? chunk : String(chunk);
        return true;
    }) as typeof process.stdout.write;
    const t0 = Date.now();
    let threw: string | null = null;
    try {
        await doctorCommand(['--json']);
    } catch (e) {
        threw = (e as Error).message ?? String(e);
    } finally {
        process.stdout.write = origWrite;
    }
    return { json: out, elapsedMs: Date.now() - t0, threw };
}

async function childHttpDaemon(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.token'), 'fake-token-for-sw11-test', 'utf-8');

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const url = req.url ?? '';
        if (url.startsWith('/api/health')) {
            res.writeHead(200);
            // Mirrors the real route: the lite anonymous body has no
            // `workspace` field; only a Bearer-authenticated caller gets
            // the full body that carries it. Doctor is expected to read
            // this and forward it as /api/topology's ?workspace=.
            res.end(JSON.stringify(req.headers.authorization ? { workspace: 'test-ws' } : {}));
            return;
        }
        if (url.startsWith('/api/topology')) {
            // Enforce the real route's SP-04 workspace_required /
            // workspace_forbidden gate, so this test cannot pass unless
            // doctor actually sends ?workspace= (finding 11 follow-up,
            // round E: doctor used to call /api/topology with no
            // workspace param at all and always 400'd against the real
            // daemon, silently masked here by a mock that accepted anything).
            const urlObj = new URL(url, 'http://127.0.0.1');
            const ws = urlObj.searchParams.get('workspace');
            if (!ws) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'workspace_required' }));
                return;
            }
            if (ws !== 'test-ws') {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'workspace_forbidden' }));
                return;
            }
            res.writeHead(200);
            res.end(JSON.stringify({ nodes: [], edges: [] }));
            return;
        }
        if (url.startsWith('/api/config')) {
            res.writeHead(req.headers.authorization ? 200 : 401);
            res.end(JSON.stringify({}));
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);
    process.chdir(home); // no package.json here — keeps doctor's `npm audit` probe a fast local failure, not a network call

    const { json, elapsedMs } = await runDoctorJsonCapturingStdout();
    server.close();

    const surrealDirExists = fs.existsSync(path.join(home, '.lore', 'surreal'));
    console.log('===RESULT_JSON_START===');
    console.log(json.trim());
    console.log('===RESULT_JSON_END===');
    console.log(`SURREAL_DIR_EXISTS=${surrealDirExists}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    process.exit(0);
}

/**
 * Round E2 (2026-09-03, low finding) — doctor's own `probeJson` collapsed
 * every non-200 `/api/topology` response into a single `null`, so a
 * genuine `403 workspace_forbidden` (the daemon resolved a workspace but
 * refused this caller for it — e.g. a token guessed for the wrong home) was
 * reported identically to an actual shape mismatch: "unexpected shape".
 * `probeJson` now returns the real status code, so doctor can say "403
 * workspace_forbidden" distinctly. Mirrors qa/B5-round2/doctor-403-test.mts.
 */
async function childHttp403(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.token'), 'fake-token-for-403-test', 'utf-8');

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const url = req.url ?? '';
        if (url.startsWith('/api/health')) {
            res.writeHead(200);
            res.end(JSON.stringify(req.headers.authorization ? { workspace: 'test-ws' } : {}));
            return;
        }
        if (url.startsWith('/api/topology')) {
            // Simulate SP-04 workspace_forbidden: a workspace resolved,
            // but this caller isn't authorized for it.
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'workspace_forbidden' }));
            return;
        }
        if (url.startsWith('/api/config')) {
            res.writeHead(req.headers.authorization ? 200 : 401);
            res.end(JSON.stringify({}));
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);
    process.chdir(home); // no package.json here — keeps doctor's `npm audit` probe a fast local failure, not a network call

    const { json, elapsedMs } = await runDoctorJsonCapturingStdout();
    server.close();

    console.log('===RESULT_JSON_START===');
    console.log(json.trim());
    console.log('===RESULT_JSON_END===');
    console.log(`ELAPSED_MS=${elapsedMs}`);
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

async function childLockVictim(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    process.chdir(home); // fast local `npm audit` failure, not a network call
    const { json, elapsedMs } = await runDoctorJsonCapturingStdout();
    console.log('===RESULT_JSON_START===');
    console.log(json.trim());
    console.log('===RESULT_JSON_END===');
    console.log(`ELAPSED_MS=${elapsedMs}`);
    process.exit(0);
}

/**
 * Finding (2026-09-03, wal-directory): `.lore/sync.wal` replaced by a
 * directory (a real-world corruption pattern — some external tool `mkdir -p`s
 * a path it assumes doesn't exist yet) made WriteAheadLog.readPending()'s
 * `fs.readFileSync` throw EISDIR. That check had no try/catch of its own, so
 * it took the whole diagnostic body down with it. Doctor now wraps it: the
 * failure becomes a `⚠ WAL check failed: …` finding (counted as an issue,
 * same as any other real on-disk problem doctor already reports), not a
 * crash — --json mode must still emit a normal, valid envelope, with no
 * `fatal` field (this failure never reaches the outer safety net at all).
 */
async function childWalDirectory(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(path.join(home, '.lore', 'sync.wal'), { recursive: true }); // sync.wal IS a directory
    process.chdir(home); // fast local `npm audit` failure, not a network call
    const { json, elapsedMs } = await runDoctorJsonCapturingStdoutAllowThrow();
    // Capture doctorCommand's own exitCode signal as a marker rather than
    // actually exiting with it — this wrapper process's own exit status is
    // reserved for "did the child script itself crash", checked separately
    // by the orchestrator.
    const doctorExitCode = process.exitCode ?? 0;
    console.log('===RESULT_JSON_START===');
    console.log(json.trim());
    console.log('===RESULT_JSON_END===');
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log(`DOCTOR_EXITCODE=${doctorExitCode}`);
    process.exit(0);
}

/**
 * Finding (2026-09-03, json-throw): doctorCommand's try/finally restored
 * console.log on any throw, but had no catch — the throw just kept
 * propagating past the JSON-emission code at the bottom of the function. In
 * --json mode, that meant NOTHING reached stdout at all (main() printed a
 * plain-text fatal line instead, to stderr) — a caller that only reads
 * stdout got neither a success envelope nor a parseable failure one.
 *
 * Reproduced here by monkey-patching `fs.existsSync` (via createRequire, so
 * the patch lands on the actual shared CJS exports object, not a snapshot —
 * see the note below) to throw ONLY for the exact `loreDir` path doctor.ts
 * checks at the very top of its body with `import fs from 'fs'` — a call
 * with no try/catch of its own, deliberately still true after the
 * wal-directory fix above (that fix only wraps the WAL-specific check
 * further down). Every other `fs.existsSync` call is left alone.
 *
 * NOTE on why this targets doctor.ts's OWN default-imported `fs` and not,
 * say, a call inside engines/openWorkspaceGraph.ts: Node's ESM synthetic
 * namespace for a builtin module snapshots each named export's value once,
 * so mutating the shared CJS object does NOT reach a `import * as fs from
 * 'node:fs'` (namespace-import) consumer — verified empirically. It DOES
 * reach a plain `import fs from 'fs'` (default-import) consumer, which is
 * what doctor.ts itself uses, so this is targeted at doctor.ts's own
 * unguarded existsSync(loreDir) call specifically.
 */
async function childJsonThrowSafetyNet(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    process.chdir(home); // fast local `npm audit` failure, not a network call
    const loreDir = path.join(home, '.lore');

    const { createRequire } = await import('node:module');
    const fsCjs = createRequire(import.meta.url)('fs') as typeof fs;
    const origExistsSync = fsCjs.existsSync;
    const injectedMessage = `EACCES: permission denied, stat '${loreDir}' (injected by test)`;
    fsCjs.existsSync = ((p: unknown) => {
        if (p === loreDir) {
            throw new Error(injectedMessage);
        }
        return origExistsSync(p as fs.PathLike);
    }) as typeof fsCjs.existsSync;

    const { json, elapsedMs, threw } = await runDoctorJsonCapturingStdoutAllowThrow();
    fsCjs.existsSync = origExistsSync;
    // Same reasoning as childWalDirectory above — report doctorCommand's
    // exitCode as a marker, exit this wrapper cleanly ourselves.
    const doctorExitCode = process.exitCode ?? 0;

    console.log('===RESULT_JSON_START===');
    console.log(json.trim());
    console.log('===RESULT_JSON_END===');
    console.log(`THREW=${threw === null ? '' : JSON.stringify(threw)}`);
    console.log(`ELAPSED_MS=${elapsedMs}`);
    console.log(`INJECTED_MESSAGE=${JSON.stringify(injectedMessage)}`);
    console.log(`DOCTOR_EXITCODE=${doctorExitCode}`);
    process.exit(0);
}

/* ───────────────────────────── Orchestrator ────────────────────────────── */

interface DoctorFinding { kind: string; message: string }
interface DoctorJson { ok: boolean; issues: number; findings: DoctorFinding[] }

function extractSection(stdout: string, marker: string): string {
    const startTag = '===RESULT_JSON_START===';
    const endTag = '===RESULT_JSON_END===';
    const startIdx = stdout.indexOf(startTag);
    const endIdx = stdout.indexOf(endTag);
    assert.ok(startIdx !== -1 && endIdx !== -1, `child stdout missing ${startTag}/${endTag} markers:\n${stdout}`);
    if (marker === 'json') return stdout.slice(startIdx + startTag.length, endIdx).trim();
    const m = new RegExp(`${marker}=(\\S+)`).exec(stdout.slice(endIdx));
    assert.ok(m, `child stdout missing ${marker}= marker:\n${stdout}`);
    return m![1]!;
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

async function scenarioHttp403(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sw11-403-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'http403'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `http403 child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const stdout = result.stdout;

    const parsed = JSON.parse(extractSection(stdout, 'json')) as DoctorJson;
    const topoFinding = parsed.findings.find(f => /topology/.test(f.message));
    assert.ok(topoFinding, `expected a topology-related finding; got:\n${JSON.stringify(parsed.findings, null, 2)}`);
    assert.equal(topoFinding!.kind, 'warn', `expected the 403 to be reported as a warn-kind finding; got kind=${topoFinding!.kind}`);
    assert.match(topoFinding!.message, /403/, `expected the real 403 status code to be reported; got: ${topoFinding!.message}`);
    assert.match(topoFinding!.message, /workspace_forbidden/, `expected the workspace_forbidden error code to be reported; got: ${topoFinding!.message}`);
    assert.doesNotMatch(topoFinding!.message, /unexpected shape/,
        `round E2 fix: a 403 must be reported distinctly, not collapsed into "unexpected shape"; got: ${topoFinding!.message}`);
}

async function scenarioHttpDaemon(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sw11-http-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'httpdaemon'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `httpdaemon child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const stdout = result.stdout;

    const parsed = JSON.parse(extractSection(stdout, 'json')) as DoctorJson;
    const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));
    const surrealDirExists = extractSection(stdout, 'SURREAL_DIR_EXISTS') === 'true';

    const viaDaemon = parsed.findings.find(f => f.kind === 'pass' && f.message.startsWith('Graph (via daemon):'));
    assert.ok(viaDaemon, `expected a "Graph (via daemon): …" finding; got:\n${JSON.stringify(parsed.findings, null, 2)}`);

    const lockLike = parsed.findings.find(f =>
        /openSurreal|Failed to open embedded SurrealDB|store is held by a running Lore process/.test(f.message));
    assert.equal(lockLike, undefined, `expected no lock-conflict finding; got: ${JSON.stringify(lockLike)}`);

    assert.equal(surrealDirExists, false, 'doctor must not have opened/created the on-disk store while a daemon answers over HTTP');
    assert.ok(elapsedMs < 5_000, `expected doctor to finish in well under 5s via the HTTP path; took ${elapsedMs}ms`);
}

async function scenarioLockConflict(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sw11-lock-'));
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
            timeout: 30_000, // baseline sits in ~15-16.5s here; give it room
        });
        assert.equal(result.status, 0, `lockvictim child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        const stdout = result.stdout;

        const parsed = JSON.parse(extractSection(stdout, 'json')) as DoctorJson;
        const elapsedMs = Number(extractSection(stdout, 'ELAPSED_MS'));

        const friendly = parsed.findings.find(f =>
            f.kind === 'fail' && f.message === 'Graph error: store is held by a running Lore process — set LORE_PORT to reach it or stop it');
        assert.ok(friendly, `expected the SW-11 friendly lock message; got:\n${JSON.stringify(parsed.findings, null, 2)}`);

        const raw = parsed.findings.find(f => /Failed to open embedded SurrealDB/.test(f.message));
        assert.equal(raw, undefined, `raw driver error leaked through: ${JSON.stringify(raw)}`);

        assert.ok(elapsedMs < 8_000, `expected the shortened lock-probe budget (well under the old 15s storm); took ${elapsedMs}ms`);
    } finally {
        holder.kill('SIGKILL');
    }
}

/** Extract a `KEY=value` marker from the tail of stdout (after the JSON
 *  block), capturing the whole rest of the line rather than \S+ — several
 *  of the new markers below carry JSON-stringified strings with spaces. */
function extractLineValue(stdout: string, marker: string): string {
    const endTag = '===RESULT_JSON_END===';
    const endIdx = stdout.indexOf(endTag);
    assert.ok(endIdx !== -1, `child stdout missing ${endTag} marker:\n${stdout}`);
    const tail = stdout.slice(endIdx);
    const m = new RegExp(`^${marker}=(.*)$`, 'm').exec(tail);
    assert.ok(m, `child stdout missing ${marker}= marker:\n${stdout}`);
    return m![1]!.trim();
}

async function scenarioWalDirectory(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-waldir-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'waldirectory'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `waldirectory child process crashed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const stdout = result.stdout;

    const jsonText = extractSection(stdout, 'json');
    let parsed: DoctorJson & { fatal?: string };
    try {
        parsed = JSON.parse(jsonText);
    } catch (e) {
        throw new Error(`--json mode did not emit valid JSON when sync.wal is a directory: ${(e as Error).message}\nraw:\n${jsonText}`);
    }

    assert.equal(parsed.ok, false, `expected ok:false when sync.wal is a directory; got:\n${JSON.stringify(parsed, null, 2)}`);
    assert.ok(parsed.issues >= 1, `expected at least one issue counted; got issues=${parsed.issues}`);
    assert.equal(parsed.fatal, undefined, 'the WAL check is guarded locally — this must NOT reach the outer fatal safety net');

    const walFinding = parsed.findings.find(f => /WAL check failed/.test(f.message));
    assert.ok(walFinding, `expected a "WAL check failed" finding; got:\n${JSON.stringify(parsed.findings, null, 2)}`);
    assert.equal(walFinding!.kind, 'warn', `expected the WAL failure to be a warn-kind finding; got kind=${walFinding!.kind}`);

    const doctorExitCode = Number(extractLineValue(stdout, 'DOCTOR_EXITCODE'));
    assert.notEqual(doctorExitCode, 0, `expected doctorCommand to set a non-zero exitCode when it found an issue; got ${doctorExitCode}`);
}

async function scenarioJsonThrowSafetyNet(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-jsonthrow-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'jsonthrow'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 20_000,
    });
    assert.equal(result.status, 0, `jsonthrow child process crashed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const stdout = result.stdout;

    const threwRaw = extractLineValue(stdout, 'THREW');
    assert.equal(threwRaw, '', `doctorCommand(['--json']) must resolve, not reject, when its body throws; it threw: ${threwRaw}`);

    const injectedMessage = JSON.parse(extractLineValue(stdout, 'INJECTED_MESSAGE')) as string;
    const jsonText = extractSection(stdout, 'json');
    let parsed: DoctorJson & { fatal?: string };
    try {
        parsed = JSON.parse(jsonText);
    } catch (e) {
        throw new Error(`--json mode emitted NO valid JSON when the diagnostic body threw (the pre-fix bug): ${(e as Error).message}\nraw:\n${jsonText}`);
    }

    assert.equal(parsed.ok, false, `expected ok:false on a fatal throw; got:\n${JSON.stringify(parsed, null, 2)}`);
    assert.ok(parsed.fatal, `expected a "fatal" field on the JSON envelope; got:\n${JSON.stringify(parsed, null, 2)}`);
    assert.ok(parsed.fatal!.includes(injectedMessage), `expected fatal to include the injected error message; got fatal=${parsed.fatal}`);

    const doctorExitCode = Number(extractLineValue(stdout, 'DOCTOR_EXITCODE'));
    assert.notEqual(doctorExitCode, 0, `expected doctorCommand to set a non-zero exitCode on a fatal throw in --json mode; got ${doctorExitCode}`);
}

async function main(): Promise<void> {
    console.log('SW-11 — lore doctor: daemon detection honours LORE_PORT + explains a lock conflict');
    await test('daemon on a non-default LORE_PORT is detected; doctor reports via HTTP and never opens the store', scenarioHttpDaemon);
    await test('daemon rejects the resolved workspace (403 workspace_forbidden): doctor reports it distinctly, not as "unexpected shape"', scenarioHttp403);
    await test('store held by another process, no daemon reachable: doctor reports the lock message fast, not the raw driver error', scenarioLockConflict);
    await test('sync.wal replaced by a directory: doctor reports a WAL-check-failed finding, valid JSON, no crash', scenarioWalDirectory);
    await test('--json mode still emits a valid envelope (ok:false, fatal set) when the diagnostic body throws unexpectedly', scenarioJsonThrowSafetyNet);

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
    if (which === 'httpdaemon') await childHttpDaemon();
    else if (which === 'http403') await childHttp403();
    else if (which === 'holder') await childHolder();
    else if (which === 'lockvictim') await childLockVictim();
    else if (which === 'waldirectory') await childWalDirectory();
    else if (which === 'jsonthrow') await childJsonThrowSafetyNet();
    else { console.error(`unknown --child ${which}`); process.exit(2); }
} else {
    await main();
}

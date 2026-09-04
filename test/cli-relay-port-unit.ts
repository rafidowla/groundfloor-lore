#!/usr/bin/env tsx
/**
 * cli-relay-port-unit.ts — regression: the CLI's HTTP-to-daemon relay
 * helpers honour `LORE_PORT` instead of hardcoding 127.0.0.1:3847.
 *
 * Finding (2026-09-03): `cli/commands/migrateWorkspaceToWorkspaceShared.ts`
 * exports `DEFAULT_PORT` (`Number(process.env.LORE_PORT ?? 3847)`) as the one
 * shared source of truth for the local daemon's port, and `doctor.ts` /
 * `shared.ts`'s `openGraphForCli` preflight already resolve through it. But
 * six other CLI commands' own HTTP-relay helpers — the ones that try the
 * daemon FIRST, before ever falling back to a direct store open — still
 * built their request URL/options with a literal `3847`:
 *
 *   - supersede.ts   tryHttpSupersede()   POST /api/node/supersede
 *   - recall.ts      tryHttpRecall()      GET  /api/recall
 *   - recall.ts      tryHttpGetFull()     GET  /api/node-full  (also used by getFull.ts)
 *   - markStale.ts   tryHttpMarkStale()   POST /api/mark-stale
 *   - verbatim.ts    tryHttpReap()        POST /api/verbatim/reap
 *   - export.ts      fetchHtmlExportViaDaemon()  GET /api/export/html
 *   - report.ts      fetchReportViaDaemon()      GET /api/report
 *
 * With `LORE_PORT` set to a non-default port (the daemon itself already
 * honours `LORE_PORT` — see mcp/server.ts), every one of these relays missed
 * the running daemon entirely and silently fell through to the direct-store
 * fallback path instead of erroring loudly, which is exactly the kind of
 * "wrong answer, no error" failure mode LORE_PORT support is supposed to
 * avoid (a daemon holds the store's single-writer lock, so the direct-open
 * fallback would normally hit the ~15s openSurreal retry storm — masked here
 * only because these particular commands' fallback paths don't need the
 * store locked to "succeed" quietly with stale/local behaviour).
 *
 * This test stands up a fake daemon on an OS-assigned ephemeral port (never
 * 3847/3848 — scratch only), points `LORE_PORT` at it, and drives each of the
 * six relays' owning command. Each fake-daemon route increments a counter
 * before answering; the test asserts every counter is 1 (the relay actually
 * reached the daemon over HTTP) and that no on-disk store was ever touched
 * (`.lore/surreal` never created) — the direct-open fallback's tell.
 *
 * Fails on the pre-fix code (each relay hardcoding 3847): every counter
 * stays 0, because the fake daemon never receives a single request — it's
 * listening on the ephemeral port, not 3847. Passes post-fix.
 *
 * No framework — tsx-run, assert-based, exits non-zero on failure.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const selfPath = fileURLToPath(import.meta.url);
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

interface Counters {
    recall: number;
    nodeFull: number;
    supersede: number;
    markStale: number;
    verbatimReap: number;
    exportHtml: number;
    report: number;
}

/** Runs entirely inside the child process: starts the fake daemon, points
 *  LORE_PORT at it, drives each relay-owning command, and reports counts. */
async function childDriveAllRelays(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.token'), 'fake-token-for-relay-port-test', 'utf-8');

    const counters: Counters = {
        recall: 0, nodeFull: 0, supersede: 0, markStale: 0,
        verbatimReap: 0, exportHtml: 0, report: 0,
    };

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const p = url.pathname;

        if (p === '/api/recall' && req.method === 'GET') {
            counters.recall++;
            res.writeHead(200);
            res.end(JSON.stringify({ topic: url.searchParams.get('topic'), crossProject: true, hits: 0, projects: [], results: [] }));
            return;
        }
        if (p === '/api/node-full' && req.method === 'GET') {
            counters.nodeFull++;
            res.writeHead(200);
            res.end(JSON.stringify({
                found: true, id: url.searchParams.get('id'), type: 'note', label: 'relay-port-test',
                project: null, tags: '', content: 'hello from fake daemon', language: null, metadata: null,
            }));
            return;
        }
        if (p === '/api/node/supersede' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                counters.supersede++;
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        if (p === '/api/mark-stale' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                counters.markStale++;
                res.writeHead(200);
                res.end(JSON.stringify({ marked: 3 }));
            });
            return;
        }
        if (p === '/api/verbatim/reap' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                counters.verbatimReap++;
                res.writeHead(200);
                res.end(JSON.stringify({ prefix: 'lore:', apply: false, inspected: 0, alive: 0, orphans: 0, tombstoned: 0, sample: [] }));
            });
            return;
        }
        if (p === '/api/export/html' && req.method === 'GET') {
            counters.exportHtml++;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>fake export</body></html>');
            return;
        }
        if (p === '/api/report' && req.method === 'GET') {
            counters.report++;
            res.writeHead(200, { 'Content-Type': 'text/markdown' });
            res.end('# fake report');
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'unmapped route in fake daemon', path: p }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);

    // Import AFTER LORE_PORT is set — each command module's DEFAULT_PORT
    // (re-exported from migrateWorkspaceToWorkspaceShared.ts) is read once,
    // at module-evaluation time.
    const { recallCommand } = await import('../packages/lore/src/cli/commands/recall.js');
    const { getFullCommand } = await import('../packages/lore/src/cli/commands/getFull.js');
    const { supersedeCommand } = await import('../packages/lore/src/cli/commands/supersede.js');
    const { markStaleCommand } = await import('../packages/lore/src/cli/commands/markStale.js');
    const { verbatimCommand } = await import('../packages/lore/src/cli/commands/verbatim.js');
    const { exportCommand } = await import('../packages/lore/src/cli/commands/export.js');
    const { reportCommand } = await import('../packages/lore/src/cli/commands/report.js');

    // Silence each command's normal console output — only the JSON summary
    // at the end should reach the orchestrator's parser.
    const realLog = console.log;
    const realWrite = process.stdout.write.bind(process.stdout);
    console.log = () => {};
    process.stdout.write = (() => true) as typeof process.stdout.write;

    let caught: string | null = null;
    try {
        await recallCommand(['relay-port-test-topic', '--cross-project']);
        await getFullCommand(['relay-port-test-id']);
        await supersedeCommand(['old-id', 'new-id']);
        await markStaleCommand(['--tags', 'relay-port-test']);
        await verbatimCommand(['reap']);
        const exportOut = path.join(home, 'export-out.html');
        await exportCommand(['html', '--output', exportOut]);
        await reportCommand([]);
    } catch (e) {
        caught = (e as Error).message ?? String(e);
    } finally {
        console.log = realLog;
        process.stdout.write = realWrite;
    }

    server.close();

    const surrealDirExists = fs.existsSync(path.join(home, '.lore', 'surreal'));
    console.log('===RESULT_JSON_START===');
    console.log(JSON.stringify({ counters, surrealDirExists, caught }));
    console.log('===RESULT_JSON_END===');
    process.exit(0);
}

/* ───────────────────────────── Orchestrator ────────────────────────────── */

function extractJson(stdout: string): { counters: Counters; surrealDirExists: boolean; caught: string | null } {
    const startTag = '===RESULT_JSON_START===';
    const endTag = '===RESULT_JSON_END===';
    const startIdx = stdout.indexOf(startTag);
    const endIdx = stdout.indexOf(endTag);
    assert.ok(startIdx !== -1 && endIdx !== -1, `child stdout missing result markers:\n${stdout}`);
    return JSON.parse(stdout.slice(startIdx + startTag.length, endIdx).trim());
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

async function scenarioAllRelaysReachNonDefaultPort(): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-relay-port-'));
    const result = spawnSync(tsxBin, [selfPath, '--child', 'driveall'], {
        env: { ...process.env, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: 30_000,
    });
    assert.equal(result.status, 0, `child failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const { counters, surrealDirExists, caught } = extractJson(result.stdout);

    assert.equal(caught, null, `a relay-owning command threw unexpectedly: ${caught}`);
    assert.equal(counters.recall, 1, `lore recall never reached the fake daemon on the non-default LORE_PORT (still hardcoding 3847?); counters=${JSON.stringify(counters)}`);
    assert.equal(counters.nodeFull, 1, `lore get-full never reached the fake daemon on the non-default LORE_PORT; counters=${JSON.stringify(counters)}`);
    assert.equal(counters.supersede, 1, `lore supersede never reached the fake daemon on the non-default LORE_PORT; counters=${JSON.stringify(counters)}`);
    assert.equal(counters.markStale, 1, `lore mark-stale never reached the fake daemon on the non-default LORE_PORT; counters=${JSON.stringify(counters)}`);
    assert.equal(counters.verbatimReap, 1, `lore verbatim reap never reached the fake daemon on the non-default LORE_PORT; counters=${JSON.stringify(counters)}`);
    assert.equal(counters.exportHtml, 1, `lore export html never reached the fake daemon on the non-default LORE_PORT; counters=${JSON.stringify(counters)}`);
    assert.equal(counters.report, 1, `lore report never reached the fake daemon on the non-default LORE_PORT; counters=${JSON.stringify(counters)}`);

    assert.equal(surrealDirExists, false, 'a relay fell through to the direct-open fallback and touched the on-disk store instead of reaching the daemon over HTTP');
}

async function main(): Promise<void> {
    console.log('CLI relay HTTP helpers honour LORE_PORT (not a hardcoded 127.0.0.1:3847)');
    await test('recall / get-full / supersede / mark-stale / verbatim-reap / export-html / report all reach a daemon on a non-default LORE_PORT', scenarioAllRelaysReachNonDefaultPort);

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
    if (which === 'driveall') await childDriveAllRelays();
    else { console.error(`unknown --child ${which}`); process.exit(2); }
} else {
    await main();
}

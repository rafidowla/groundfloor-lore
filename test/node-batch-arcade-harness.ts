/**
 * test/node-batch-arcade-harness.ts - shared plumbing for the two LIVE node-batch suites
 * (node-batch-arcade-live-e2e.ts, node-batch-two-daemon-e2e.ts): boots real arcade-mode daemons
 * from a source tree (default: this checkout) against an externally managed ArcadeDB, provisions
 * one app, issues a tenant token, and offers a tiny JSON HTTP client + a direct ArcadeDB query helper.
 *
 * Environment (required):
 *   LORE_ARCADE_E2E_URL                  e.g. http://127.0.0.1:2624  (never 2480)
 *   LORE_ARCADE_E2E_ROOT_PASSWORD_FILE   file holding the server's root password (never echoed)
 * Optional:
 *   NODE_BATCH_TREE   source tree to boot the daemons from (default: this checkout); used by the
 *                     old-main contrast run, which points it at a checkout WITHOUT the primitive.
 *   NODE_BATCH_PORTS  "p1,p2" (default 48471,48472; never 3847)
 *
 * Every daemon gets HOME and LORE_HOME in a fresh temp dir, so ~/.groundfloor is never touched. The
 * second daemon starts from a checkpointed COPY of the first one's provisioning registry (the registry
 * holds the app's service password and the issued token, so both daemons authenticate to the SAME
 * ArcadeDB database as the SAME tenant/app).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const TREE = process.env['NODE_BATCH_TREE'] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARCADE_URL = (process.env['LORE_ARCADE_E2E_URL'] ?? '').replace(/\/+$/, '');
const PW_FILE = process.env['LORE_ARCADE_E2E_ROOT_PASSWORD_FILE'] ?? '';
if (!ARCADE_URL || !PW_FILE) throw new Error('set LORE_ARCADE_E2E_URL and LORE_ARCADE_E2E_ROOT_PASSWORD_FILE');
if (/:(2480|3847)\b/.test(ARCADE_URL)) throw new Error(`refusing to use ${ARCADE_URL}`);
const ROOT_PASSWORD = fs.readFileSync(PW_FILE, 'utf8').trim();
export const PORTS = (process.env['NODE_BATCH_PORTS'] ?? '48471,48472').split(',').map(Number) as [number, number];
if (PORTS.some((p) => p === 3847)) throw new Error('refusing port 3847');

export interface Res { status: number; json: Record<string, unknown>; raw: string }

export async function call(port: number, method: string, urlPath: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> {
    const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: {
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const raw = await r.text();
    let json: Record<string, unknown> = {};
    try { json = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* non-JSON */ }
    return { status: r.status, json, raw };
}

export interface Daemon { proc: ChildProcess; port: number; home: string; log: { text: string }; operator: string }

export async function startDaemon(port: number, home: string, trace = true): Promise<Daemon> {
    fs.mkdirSync(home, { recursive: true });
    const log = { text: '' };
    const proc = spawn(path.join(TREE, 'node_modules/.bin/tsx'), [path.join(TREE, 'packages/lore/src/mcp/server.ts'), '--http'], {
        cwd: TREE,
        env: {
            PATH: process.env['PATH'],
            HOME: home,
            TMPDIR: os.tmpdir(),
            LORE_HOME: home,
            LORE_PORT: String(port),
            LORE_DEPLOYMENT_MODE: 'arcade',
            ARCADE_BASE_URL: ARCADE_URL,
            ARCADE_ROOT_PASSWORD: ROOT_PASSWORD,
            ...(trace ? { LORE_NODE_BATCH_TRACE: '1' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout!.on('data', (c) => { log.text += c.toString(); });
    proc.stderr!.on('data', (c) => { log.text += c.toString(); });
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline && !up) {
        try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* not up yet */ }
        if (!up) await new Promise((r) => setTimeout(r, 300));
    }
    if (!up) { proc.kill('SIGTERM'); throw new Error(`daemon on ${port} did not come up:\n${log.text.slice(-2000)}`); }
    let operator = '';
    for (let i = 0; i < 20 && !operator; i++) {
        try { operator = fs.readFileSync(path.join(home, 'auth.token'), 'utf8').trim(); } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    return { proc, port, home, log, operator };
}

export function stopDaemon(d: Daemon | null | undefined): void {
    if (!d) return;
    try { d.proc.kill('SIGTERM'); } catch { /* already gone */ }
}

/** Provision `customerId/appId` and issue one read+write token on `d`. Returns the tenant token. */
export async function provisionAndIssue(d: Daemon, customerId: string, appId: string): Promise<string> {
    const prov = await call(d.port, 'POST', '/api/arcade/apps', { token: d.operator, body: { customerId, appId, embedDim: 384 } });
    if (prov.status !== 201 && prov.status !== 200) throw new Error(`provision failed ${prov.status}: ${prov.raw}`);
    const issue = await call(d.port, 'POST', `/api/arcade/apps/${customerId}/${appId}/tokens`, { token: d.operator, body: { scopes: ['read', 'write'] } });
    const tok = String(issue.json['token'] ?? '');
    if (!tok.startsWith('lore_at_')) throw new Error(`token issue failed ${issue.status}: ${issue.raw}`);
    return tok;
}

/** Start daemon 2 from a checkpointed copy of daemon 1's provisioning registry (same app, same service password, same token). */
export async function startSecondDaemon(d1: Daemon, port: number, home: string): Promise<Daemon> {
    fs.mkdirSync(home, { recursive: true });
    const src = path.join(d1.home, 'arcade-provisioning.sqlite');
    const db = new Database(src);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    fs.copyFileSync(src, path.join(home, 'arcade-provisioning.sqlite'));
    return startDaemon(port, home);
}

/** Direct ArcadeDB command (SQL) on `db`, bypassing the daemons. */
export async function arcadeSql(db: string, command: string, params: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
    const r = await fetch(`${ARCADE_URL}/api/v1/command/${encodeURIComponent(db)}`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`root:${ROOT_PASSWORD}`).toString('base64')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'sql', command, params }),
    });
    const j = await r.json() as { result?: Array<Record<string, unknown>>; error?: string };
    if (!r.ok) throw new Error(`arcade sql ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j.result ?? [];
}

export async function dropApp(d: Daemon, customerId: string, appId: string): Promise<void> {
    try { await call(d.port, 'POST', `/api/arcade/apps/${customerId}/${appId}/disable`, { token: d.operator }); } catch { /* best effort */ }
}

export const mkHome = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `lore335-${tag}-`));
export const rmHome = (h: string): void => { try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ } };
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

#!/usr/bin/env tsx
/**
 * test/pending-commit-crash-e2e.ts - 3.35.0 (R3) live check against a REAL ArcadeDB.
 *
 * A writer process is SIGKILLed between its outbox record and its flip (test-only hook on
 * ArcadeHttp.command), twice:
 *   - BEFORE the graph commit is sent  -> the row is left `pending_commit`, the node never lands
 *   - right AFTER the commit lands     -> the row is left `pending_commit`, the node is in the graph
 * Then a fresh process opens the same outbox file (the restart) while ArcadeDB is PAUSED (graph
 * unreachable: rows must stay pending_commit and nothing replays), then unpauses it (rows settle:
 * committed -> ready -> replicated, never-committed -> retracted).
 *
 * Production request path: tryArcadeDataRoutes (POST /api/node) + the arcade replicator wiring, over a
 * persistent SQLite outbox file shared by the processes.
 *
 * Run (container-backed; not on the fast npm gate):
 *   LORE_ARCADE_E2E_URL=http://127.0.0.1:2623 LORE_ARCADE_E2E_ROOT_PASSWORD_FILE=<file> \
 *   LIVE_CONTAINER=lore335-robust-arcade npx tsx test/pending-commit-crash-e2e.ts
 */
import './arcade-e2e-env.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

const ROLE = process.argv[2] ?? 'parent';
const RUN_TAG = process.env['CRASH_TAG'] ?? `${Date.now().toString(36)}${process.pid.toString(36)}`;
const LORE_HOME = process.env['CRASH_HOME'] ?? path.join(os.tmpdir(), `pc-crash-lorehome-${RUN_TAG}`);
fs.mkdirSync(LORE_HOME, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME;

import { provisionApp, destroyApp, closeRegistryDb, ARCADE_BASE_URL } from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { issueToken, closeTokenDb } from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { ArcadeCellPool } from '../packages/lore/src/engines/arcade/arcadeCellPool.js';
import { ArcadeHttp } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { tryArcadeDataRoutes } from '../packages/lore/src/mcp/http/routes/arcadeData.js';
import { arcadeCellKey } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { wireArcadeReplicator } from '../packages/lore/src/engines/arcade/arcadeOutboxWiring.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { AuditLog } from '../packages/lore/src/security/audit.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';

process.env['ARCADE_BASE_URL'] ??= ARCADE_BASE_URL;
const CONTAINER = process.env['LIVE_CONTAINER'] ?? '';
const CELL = { customerId: `crash${RUN_TAG.slice(-5)}`, appId: 'crashapp' };
const REGISTRY_DB_PATH = path.join(LORE_HOME, 'arcade-provisioning.sqlite');
const OUT_DIR = path.join(LORE_HOME, 'outbox');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { pass++; console.log(`  [PASS] ${label}`); } else { fail++; console.error(`  [FAIL] ${label}${detail ? ` - ${detail}` : ''}`); }
};

function mkReq(method: string, url: string, bearer: string, body?: unknown) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = method; req.url = url; req.headers = { authorization: `Bearer ${bearer}` };
  process.nextTick(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return req;
}
function mkRes() {
  const captured = { status: 0, body: undefined as unknown };
  let raw = '';
  const res = {
    headersSent: false, statusCode: 200,
    writeHead(status: number) { captured.status = status; return res; },
    setHeader() { return res; },
    end(chunk?: string) { if (chunk) raw += chunk; if (captured.status === 0) captured.status = res.statusCode; try { captured.body = raw ? JSON.parse(raw) : undefined; } catch { captured.body = raw; } },
    write(chunk: string) { raw += chunk; return true; },
  };
  return { res, captured };
}

async function rig() {
  const embedder = new LocalEmbeddingProvider();
  const pool = new ArcadeCellPool({ registryDbPath: REGISTRY_DB_PATH, embedder });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const store = new SqliteOutboxStore(OUT_DIR);
  const token = issueToken({ tenantId: CELL.customerId, appId: CELL.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
  const logs: string[] = [];
  const handle = wireArcadeReplicator({ store, embedder, log: (m) => { logs.push(m); console.log(`    [replicator] ${m}`); } });
  const auditLog = new AuditLog();
  const put = async (id: string) => {
    const req = mkReq('POST', '/api/node', token, { workspace: CELL.appId, id, type: 'decision', label: `crash ${id}`, content: `crash check ${id} ${RUN_TAG}` });
    const { res, captured } = mkRes();
    await tryArcadeDataRoutes(req as never, res as never, '/api/node', '/api/node', token, { pool, auditLog, outboxStore: store } as never);
    return { status: captured.status, body: captured.body };
  };
  const getFromGraph = async (id: string) => (await pool.getOrBuild(token)).bundle.loreGraph.getNode(id);
  return { pool, store, handle, put, logs, getFromGraph, laneKey: arcadeCellKey(CELL.customerId, CELL.appId) };
}

/** Child: write acknowledged nodes, then die at the armed point of the target's graph commit. */
async function writerChild(): Promise<void> {
  const [mode, ackList, target] = [process.argv[3]!, process.argv[4]!, process.argv[5]!];
  const { put, handle, store } = await rig();
  let armed = false;
  const orig = ArcadeHttp.prototype.command;
  ArcadeHttp.prototype.command = async function (this: ArcadeHttp, db: string, sql: string, params?: Record<string, unknown>) {
    const hit = armed && params?.['id'] === target && /^(INSERT|UPDATE)/i.test(sql.trim());
    if (hit && mode === 'before') process.kill(process.pid, 'SIGKILL');
    const r = await orig.call(this, db, sql, params);
    if (hit && mode === 'after') process.kill(process.pid, 'SIGKILL');
    return r;
  } as typeof orig;
  for (const id of ackList.split(',').filter(Boolean)) {
    const r = await put(id);
    if (r.status >= 200 && r.status < 300) console.log(`ACK ${id}`);
    else console.log(`NOACK ${id} ${r.status}`);
  }
  for (let i = 0; i < 20; i++) { await handle.replicator.tickOnce(); await sleep(20); }
  armed = true;
  console.log(`ARMED ${mode} ${target}`);
  const r = await put(target); // the process dies inside this call
  console.log(`SURVIVED ${target} status=${r.status}`);
  process.exit(3);
}

/** Child: the restart. Opens the same outbox file, reports what it does while the graph is down, then up. */
async function restartChild(): Promise<void> {
  const { store, handle, getFromGraph, laneKey } = await rig();
  const unfinished = async () => ((await store.listUnfinished?.()) ?? []).filter((e) => e.workspace === laneKey);
  const statuses = async () => Object.fromEntries((await unfinished()).map((e) => [(e.payload as { id: string }).id, e.status]));
  console.log(`STATE-AT-OPEN ${JSON.stringify(await statuses())}`);
  // The parent unpauses ArcadeDB at the absolute time RESTART_UNPAUSE_AT; the child's startup eats part of any
  // relative window, so the down phase is judged against the wall clock (with a margin before the unpause).
  const unpauseAt = process.env['RESTART_UNPAUSE_AT'] ? Number(process.env['RESTART_UNPAUSE_AT']) : 0;
  const down = unpauseAt > 0;
  const t0 = Date.now();
  let reported = false;
  for (;;) {
    try { await handle.replicator.tickOnce(); } catch { /* */ }
    if (!reported && Date.now() > unpauseAt + 500) {
      reported = true;
      console.log('GRAPH-BACK');
    }
    const st = await statuses();
    if (down && !reported && Date.now() < unpauseAt - 1500) console.log(`WHILE-DOWN ${JSON.stringify(st)}`);
    if (reported && !Object.values(st).includes('pending_commit') && Object.keys(st).length === 0) break;
    if (Date.now() - t0 > 150_000) break;
    await sleep(500);
  }
  console.log(`STATE-AFTER ${JSON.stringify(await statuses())}`);
  console.log(`DEAD ${JSON.stringify(await store.deadLetterSummary?.(laneKey))}`);
  const present: Record<string, boolean> = {};
  for (const id of (process.env['CHECK_IDS'] ?? '').split(',').filter(Boolean)) present[id] = (await getFromGraph(id)) !== null;
  console.log(`IN-GRAPH ${JSON.stringify(present)}`);
  await handle.stop();
  store.close?.();
  process.exit(0);
}

function runChild(args: string[], env: Record<string, string> = {}): Promise<{ out: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', __filename_(), ...args], { env: { ...process.env, CRASH_HOME: LORE_HOME, CRASH_TAG: RUN_TAG, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => undefined);
    child.on('close', (code, signal) => resolve({ out, code, signal }));
  });
}
const __filename_ = (): string => new URL(import.meta.url).pathname;
const lines = (out: string, prefix: string): string[] => out.split('\n').filter((l) => l.startsWith(prefix));
const jsonOf = (out: string, prefix: string): Record<string, unknown> => { const l = lines(out, prefix).pop(); return l ? JSON.parse(l.slice(prefix.length + 1)) : {}; };

async function parent(): Promise<void> {
  console.log(`=== pending_commit crash/restart live check (${ARCADE_BASE_URL}) ===`);
  if (!CONTAINER) throw new Error('LIVE_CONTAINER is required');
  const embedder = new LocalEmbeddingProvider();
  await provisionApp(CELL, { registryDbPath: REGISTRY_DB_PATH, embedDim: embedder.dimension });
  const env = { LORE_PENDING_COMMIT_GRACE_MS: '2000', LORE_PENDING_COMMIT_SWEEP_MS: '300', LORE_ARCADE_REQUEST_TIMEOUT_MS: '3000' };

  console.log('\n--- writer 1: 2 acknowledged writes, then SIGKILL BEFORE the graph commit of X1 ---');
  const w1 = await runChild(['writer', 'before', 'ack-1,ack-2', 'X1'], env);
  console.log(`  child: ${lines(w1.out, 'ACK').join(' | ')}  killed by ${w1.signal}`);
  check('writer 1 died by SIGKILL mid-write (X1 never acknowledged)', w1.signal === 'SIGKILL' && !w1.out.includes('SURVIVED'));
  console.log('\n--- writer 2: 1 acknowledged write, then SIGKILL right AFTER the graph commit of Y1 landed ---');
  const w2 = await runChild(['writer', 'after', 'ack-3', 'Y1'], env);
  console.log(`  child: ${lines(w2.out, 'ACK').join(' | ')}  killed by ${w2.signal}`);
  check('writer 2 died by SIGKILL mid-write (Y1 never acknowledged)', w2.signal === 'SIGKILL' && !w2.out.includes('SURVIVED'));

  const store = new SqliteOutboxStore(OUT_DIR);
  const laneKey = arcadeCellKey(CELL.customerId, CELL.appId);
  const rows = ((await store.listUnfinished?.()) ?? []).filter((e) => e.workspace === laneKey);
  const pc = rows.filter((e) => e.status === 'pending_commit').map((e) => (e.payload as { id: string }).id).sort();
  console.log(`  outbox after the crashes: ${JSON.stringify(rows.map((e) => `${(e.payload as { id: string }).id}:${e.status}`))}`);
  check('both unfinished writes are left pending_commit (not pending, not dead)', JSON.stringify(pc) === JSON.stringify(['X1', 'Y1']), JSON.stringify(pc));
  store.close?.();

  console.log(`\n--- restart with ArcadeDB PAUSED (graph unreachable) for ~14 s, then unpaused ---`);
  spawnSync('docker', ['pause', CONTAINER], { stdio: 'ignore' });
  const unpauseAt = Date.now() + 14_000;
  const unpauser = (async () => { await sleep(14_000); spawnSync('docker', ['unpause', CONTAINER], { stdio: 'ignore' }); })();
  const rs = await runChild(['restart'], { ...env, RESTART_UNPAUSE_AT: String(unpauseAt), CHECK_IDS: 'ack-1,ack-2,ack-3,X1,Y1' });
  await unpauser;
  const whileDown = lines(rs.out, 'WHILE-DOWN');
  const lastDown = whileDown.length ? JSON.parse(whileDown[whileDown.length - 1]!.slice('WHILE-DOWN'.length + 1)) as Record<string, string> : {};
  console.log(`  while the graph was down: ${JSON.stringify(lastDown)}`);
  check('graph unreachable: X1 and Y1 stay pending_commit (never flipped or retracted blindly)', lastDown['X1'] === 'pending_commit' && lastDown['Y1'] === 'pending_commit', JSON.stringify(lastDown));
  const inGraph = jsonOf(rs.out, 'IN-GRAPH') as Record<string, boolean>;
  const after = jsonOf(rs.out, 'STATE-AFTER');
  const dead = jsonOf(rs.out, 'DEAD') as { deadLettered?: number };
  console.log(`  after the graph returned: outbox=${JSON.stringify(after)} inGraph=${JSON.stringify(inGraph)} dead=${JSON.stringify(dead)}`);
  check('every acknowledged node is in the graph (ack-1, ack-2, ack-3)', ['ack-1', 'ack-2', 'ack-3'].every((i) => inGraph[i] === true), JSON.stringify(inGraph));
  check('X1 (killed before the commit, never acknowledged) was NOT applied', inGraph['X1'] === false, JSON.stringify(inGraph));
  check('Y1 (commit landed before the kill) is present - settled ready, not retracted', inGraph['Y1'] === true, JSON.stringify(inGraph));
  check('no pending_commit row left; outbox drained', Object.keys(after).length === 0, JSON.stringify(after));
  check('0 dead-lettered rows', (dead.deadLettered ?? -1) === 0, JSON.stringify(dead));

  console.log(`=== ${pass}/${pass + fail} passed ===`);
  spawnSync('docker', ['unpause', CONTAINER], { stdio: 'ignore' });
  try { await destroyApp(CELL, { registryDbPath: REGISTRY_DB_PATH }); } catch { /* */ }
  closeTokenDb(); closeRegistryDb();
  try { fs.rmSync(LORE_HOME, { recursive: true, force: true }); } catch { /* */ }
  process.exit(fail > 0 ? 1 : 0);
}

const main = ROLE === 'writer' ? writerChild : ROLE === 'restart' ? restartChild : parent;
main().catch((err) => {
  console.error(err);
  if (CONTAINER) spawnSync('docker', ['unpause', CONTAINER], { stdio: 'ignore' });
  process.exit(1);
});

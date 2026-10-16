#!/usr/bin/env tsx
/**
 * test/hung-arcade-lock-hold-e2e.ts - 3.35.0 (b) live check against a REAL ArcadeDB.
 *
 * ArcadeDB that ACCEPTS connections but never answers (`docker pause`) used to hold the per-node
 * write lock for the whole retry chain of a write (a read retried twice at the request timeout, then
 * the write itself, then the settle re-read) and let every queued writer on the same node wait
 * behind it with no bound. This drives the production request path (tryArcadeDataRoutes:
 * POST /api/node) with three concurrent writes (two on one node id, one on another) while the
 * container is paused, then unpauses and proves writes resume with no dead rows.
 *
 * It prints, for the paused window: the time each write took to fail, the status/code it failed
 * with, and how many log lines were emitted (by class) - the "before" and "after" numbers for the PR.
 *
 * Run (container-backed; not on the fast npm gate):
 *   LORE_ARCADE_E2E_URL=http://127.0.0.1:2623 LORE_ARCADE_E2E_ROOT_PASSWORD_FILE=<file> \
 *   LIVE_CONTAINER=lore335-robust-arcade npx tsx test/hung-arcade-lock-hold-e2e.ts
 */

// Must stay the first import: maps LORE_ARCADE_E2E_* onto ARCADE_BASE_URL / ARCADE_ROOT_PASSWORD.
import './arcade-e2e-env.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

const RUN_TAG = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const LORE_HOME = path.join(os.tmpdir(), `hung-arcade-lorehome-${RUN_TAG}`);
fs.mkdirSync(LORE_HOME, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME; // BEFORE any provisioner import resolves loreHomePath()

import { provisionApp, destroyApp, closeRegistryDb, ARCADE_BASE_URL } from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { issueToken, closeTokenDb } from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { ArcadeCellPool } from '../packages/lore/src/engines/arcade/arcadeCellPool.js';
import { tryArcadeDataRoutes } from '../packages/lore/src/mcp/http/routes/arcadeData.js';
import { arcadeCellKey } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { wireArcadeReplicator } from '../packages/lore/src/engines/arcade/arcadeOutboxWiring.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { AuditLog } from '../packages/lore/src/security/audit.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';

process.env['ARCADE_BASE_URL'] ??= ARCADE_BASE_URL;

const CONTAINER = process.env['LIVE_CONTAINER'] ?? '';
const REQUEST_TIMEOUT_MS = Number(process.env['LORE_ARCADE_REQUEST_TIMEOUT_MS'] ?? 30_000);
let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  [PASS] ${label}`); }
  else { fail++; console.error(`  [FAIL] ${label}${detail ? ` - ${detail}` : ''}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Capture every log line the product emits while the engine is hung.
const logLines: string[] = [];
let capturing = false;
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (capturing && !line.startsWith('  [') && !line.startsWith('---')) logLines.push(line);
    orig(...args);
  };
}

const CELL = { customerId: `hang${RUN_TAG.slice(-5)}`, appId: 'hangapp' };
const REGISTRY_DB_PATH = path.join(LORE_HOME, 'arcade-provisioning.sqlite');
const embedder = new LocalEmbeddingProvider();
const auditLog = new AuditLog();

function mkReq(method: string, url: string, bearer: string, body?: unknown) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = method; req.url = url; req.headers = { authorization: `Bearer ${bearer}` };
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}
function mkRes() {
  const captured = { status: 0, body: undefined as unknown };
  let raw = '';
  const res = {
    headersSent: false, statusCode: 200,
    writeHead(status: number) { captured.status = status; return res; },
    setHeader() { return res; },
    end(chunk?: string) {
      if (chunk) raw += chunk;
      if (captured.status === 0) captured.status = res.statusCode;
      try { captured.body = raw ? JSON.parse(raw) : undefined; } catch { captured.body = raw; }
    },
    write(chunk: string) { raw += chunk; return true; },
  };
  return { res, captured };
}

async function main(): Promise<void> {
  console.log(`=== hung-ArcadeDB lock-hold live check (${ARCADE_BASE_URL}) request timeout=${REQUEST_TIMEOUT_MS}ms ===`);
  if (!CONTAINER) throw new Error('LIVE_CONTAINER is required (the container that is paused/unpaused)');
  await provisionApp(CELL, { registryDbPath: REGISTRY_DB_PATH, embedDim: embedder.dimension });
  const pool = new ArcadeCellPool({ registryDbPath: REGISTRY_DB_PATH, embedder });
  const outDir = path.join(LORE_HOME, 'outbox');
  fs.mkdirSync(outDir, { recursive: true });
  const outStore = new SqliteOutboxStore(outDir);
  const token = issueToken({ tenantId: CELL.customerId, appId: CELL.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
  const laneKey = arcadeCellKey(CELL.customerId, CELL.appId);
  const handle = wireArcadeReplicator({ store: outStore, embedder, log: (m) => { if (capturing) logLines.push(m); } });

  async function drive(method: string, apiPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const req = mkReq(method, apiPath, token, body);
    const { res, captured } = mkRes();
    await tryArcadeDataRoutes(req as never, res as never, apiPath, apiPath.split('?')[0]!, token, { pool, auditLog, outboxStore: outStore } as never);
    return { status: captured.status, body: captured.body };
  }
  const put = (id: string, n: number) => drive('POST', '/api/node', { workspace: CELL.appId, id, type: 'decision', label: `hang ${id}`, content: `hang check ${id} write ${n} ${RUN_TAG}` });

  // Seed both nodes while healthy.
  for (const id of ['h-a', 'h-b']) {
    const r = await put(id, 0);
    check(`healthy write ${id} -> 2xx`, r.status >= 200 && r.status < 300, JSON.stringify(r));
  }
  for (let i = 0; i < 20; i++) { await handle.replicator.tickOnce(); await sleep(20); }

  console.log(`\n--- docker pause ${CONTAINER}: three concurrent writes (h-a x2, h-b x1) ---`);
  spawnSync('docker', ['pause', CONTAINER], { stdio: 'ignore' });
  capturing = true;
  const t0 = Date.now();
  const timings: Array<{ name: string; ms: number; status: number; body: string }> = [];
  const one = async (name: string, id: string, n: number) => {
    const r = await put(id, n);
    timings.push({ name, ms: Date.now() - t0, status: r.status, body: JSON.stringify(r.body).slice(0, 200) });
  };
  // Stagger the second same-id writer slightly so it is certainly queued behind the first.
  await Promise.all([one('h-a #1', 'h-a', 1), one('h-b #1', 'h-b', 1), (async () => { await sleep(300); await one('h-a #2 (queued)', 'h-a', 2); })()]);
  capturing = false;
  const counts = new Map<string, number>();
  for (const l of logLines) { const k = l.replace(/\d+/g, 'N').slice(0, 90); counts.set(k, (counts.get(k) ?? 0) + 1); }
  console.log('  per-write outcome while hung:');
  for (const t of timings.sort((a, b) => a.ms - b.ms)) console.log(`    ${t.name.padEnd(18)} failed after ${t.ms} ms  status=${t.status}  body=${t.body}`);
  console.log(`  log lines emitted while hung: ${logLines.length} (distinct classes ${counts.size})`);
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    x${v}  ${k}`);
  const maxMs = Math.max(...timings.map((t) => t.ms));
  const firstSameId = timings.find((t) => t.name === 'h-a #1')!;
  console.log(`  RESULT lock-hold proxy (first same-id writer failed after) = ${firstSameId.ms} ms; slowest writer = ${maxMs} ms`);
  check('no write reported success while the engine was hung', timings.every((t) => t.status >= 400), JSON.stringify(timings.map((t) => t.status)));
  const bound = REQUEST_TIMEOUT_MS + 5_000;
  if (process.env['EXPECT_BOUNDED'] === '1') {
    check(`first writer released the lock within request timeout + margin (${firstSameId.ms} ms <= ${bound})`, firstSameId.ms <= bound);
    check(`every writer (incl. queued) failed within 2 x (timeout + margin) (${maxMs} ms)`, maxMs <= 2 * bound);
    check(`log lines for ${timings.length} failed writes stay small (${logLines.length} <= 12)`, logLines.length <= 12);
  }

  console.log(`\n--- docker unpause ${CONTAINER}: writes resume ---`);
  spawnSync('docker', ['unpause', CONTAINER], { stdio: 'ignore' });
  await sleep(1_500);
  let resumed = 0;
  for (const id of ['h-a', 'h-b', 'h-c']) {
    let r = await put(id, 9);
    for (let k = 0; k < 10 && r.status >= 400; k++) { await sleep(1_000); r = await put(id, 9); }
    if (r.status >= 200 && r.status < 300) resumed++;
  }
  check('writes resume after unpause (3/3)', resumed === 3, `resumed=${resumed}`);
  const deadline = Date.now() + 120_000;
  let unfinished = 0;
  for (;;) {
    try { await handle.replicator.tickOnce(); } catch { /* */ }
    unfinished = ((await outStore.listUnfinished?.()) ?? []).filter((e) => e.workspace === laneKey && e.status !== 'dead').length;
    if (unfinished === 0 || Date.now() > deadline) break;
    await sleep(500);
  }
  const summary = await outStore.deadLetterSummary?.(laneKey);
  console.log(`  outbox lane unfinished=${unfinished} deadLetterSummary=${JSON.stringify(summary)}`);
  check('0 dead-lettered rows', (summary?.deadLettered ?? -1) === 0, JSON.stringify(summary));
  check('outbox drained to empty', unfinished === 0, `unfinished=${unfinished}`);

  await handle.stop();
  outStore.close?.();
  console.log(`=== ${pass}/${pass + fail} passed ===`);
  try { await destroyApp(CELL, { registryDbPath: REGISTRY_DB_PATH }); } catch { /* */ }
  closeTokenDb(); closeRegistryDb();
  try { fs.rmSync(LORE_HOME, { recursive: true, force: true }); } catch { /* */ }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  if (CONTAINER) spawnSync('docker', ['unpause', CONTAINER], { stdio: 'ignore' });
  try { fs.rmSync(LORE_HOME, { recursive: true, force: true }); } catch { /* */ }
  process.exit(1);
});

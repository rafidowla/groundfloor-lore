#!/usr/bin/env tsx
/**
 * test/outbox-no-dataloss-arcade-e2e.ts - 3.35.0 (a)/(p) live check against a REAL ArcadeDB.
 *
 * Drives the production request path (tryArcadeDataRoutes: POST /api/nodes/bulk + POST /api/node),
 * the real lane outbox (SqliteOutboxStore) and the real Arcade replicator against an ArcadeDB
 * server, and asserts the 3.35.0 guarantee: an acknowledged write is never dead-lettered because of
 * a ConcurrentModificationException or an outage.
 *
 *   Phase 1  >=4 concurrent writers (bulk + single, OVERLAPPING ids) for LIVE_DURATION_MS (60 s).
 *   Phase 2  the same load, with the ArcadeDB container stopped for LIVE_OUTAGE_MS (30 s) mid-load
 *            and restarted.
 *   After each phase: 0 dead rows, the cell lane drains to empty, every acknowledged node id is
 *   present in ArcadeDB (GET /api/node). Prints how many ConcurrentModification responses ArcadeDB
 *   returned and how many the replicator retried as transient.
 *
 * Run (container-backed; not on the fast npm gate):
 *   LORE_ARCADE_E2E_URL=http://127.0.0.1:2621 LORE_ARCADE_E2E_ROOT_PASSWORD_FILE=<file> \
 *   LIVE_CONTAINER=lore335-outbox-arcade npx tsx test/outbox-no-dataloss-arcade-e2e.ts
 * LIVE_CONTAINER is the docker container the outage phase stops/starts (skipped when unset).
 */

// Must stay the first import: maps LORE_ARCADE_E2E_* onto ARCADE_BASE_URL / ARCADE_ROOT_PASSWORD.
import './arcade-e2e-env.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

const RUN_TAG = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const LORE_HOME = path.join(os.tmpdir(), `outbox-nodl-lorehome-${RUN_TAG}`);
fs.mkdirSync(LORE_HOME, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME; // BEFORE any provisioner import resolves loreHomePath()

import {
  provisionApp, destroyApp, closeRegistryDb, ARCADE_BASE_URL,
} from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { issueToken, closeTokenDb } from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { ArcadeCellPool } from '../packages/lore/src/engines/arcade/arcadeCellPool.js';
import { tryArcadeDataRoutes } from '../packages/lore/src/mcp/http/routes/arcadeData.js';
import { arcadeCellKey } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { wireArcadeReplicator } from '../packages/lore/src/engines/arcade/arcadeOutboxWiring.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { AuditLog } from '../packages/lore/src/security/audit.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';

process.env['ARCADE_BASE_URL'] ??= ARCADE_BASE_URL;

const DURATION_MS = Number(process.env['LIVE_DURATION_MS'] ?? 60_000);
const OUTAGE_MS = Number(process.env['LIVE_OUTAGE_MS'] ?? 30_000);
const WRITERS = Number(process.env['LIVE_WRITERS'] ?? 6);
const BULK = Number(process.env['LIVE_BULK'] ?? 5);
const CONTAINER = process.env['LIVE_CONTAINER'] ?? '';
const DRAIN_TIMEOUT_MS = Number(process.env['LIVE_DRAIN_TIMEOUT_MS'] ?? 240_000);

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  [PASS] ${label}`); }
  else { fail++; console.error(`  [FAIL] ${label}${detail ? ` - ${detail}` : ''}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Count every ConcurrentModification response ArcadeDB returns (request path AND replicator).
let cmeResponses = 0;
// arcadeHttp talks node:http (not fetch): wrap http.request and inspect 5xx bodies.
const realRequest = http.request;
(http as { request: typeof http.request }).request = ((...args: unknown[]) => {
  const req = (realRequest as (...a: unknown[]) => http.ClientRequest)(...args);
  req.on('response', (res) => {
    if ((res.statusCode ?? 0) < 500) return;
    let body = '';
    res.on('data', (c: Buffer) => { if (body.length < 8192) body += c.toString('utf8'); });
    res.on('end', () => { if (body.includes('ConcurrentModificationException')) cmeResponses++; });
  });
  return req;
}) as typeof http.request;
syncBuiltinESMExports();

const CELL = { customerId: `nodl${RUN_TAG.slice(-5)}`, appId: 'nodlaapp' }; // unique per run: a killed run leaves no collision
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
  console.log(`=== outbox no-data-loss live check (${ARCADE_BASE_URL}) writers=${WRITERS} duration=${DURATION_MS}ms outage=${CONTAINER ? OUTAGE_MS : 0}ms ===`);
  await provisionApp(CELL, { registryDbPath: REGISTRY_DB_PATH, embedDim: embedder.dimension });
  const pool = new ArcadeCellPool({ registryDbPath: REGISTRY_DB_PATH, embedder });
  const outDir = path.join(LORE_HOME, 'outbox');
  fs.mkdirSync(outDir, { recursive: true });
  const outStore = new SqliteOutboxStore(outDir);
  const token = issueToken({ tenantId: CELL.customerId, appId: CELL.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
  const laneKey = arcadeCellKey(CELL.customerId, CELL.appId);

  let transientLines = 0;
  const handle = wireArcadeReplicator({
    store: outStore, embedder,
    log: (m) => { if (m.includes('transient failure #')) transientLines++; if (m.includes('marked dead') && !m.includes('superseded')) console.error(m.slice(0, 400)); },
  });

  async function drive(method: string, apiPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const req = mkReq(method, apiPath, token, body);
    const { res, captured } = mkRes();
    await tryArcadeDataRoutes(req as never, res as never, apiPath, apiPath.split('?')[0]!, token, { pool, auditLog, outboxStore: outStore } as never);
    return { status: captured.status, body: captured.body };
  }

  const acked = new Set<string>();
  let writeErrors = 0;
  let acks = 0;
  const OVERLAP = 12; // shared id pool -> concurrent upserts of the same node
  let stopWriters = false;
  let stopTicks = false;
  const ticker = (async () => {
    while (!stopTicks) { try { await handle.replicator.tickOnce(); } catch { /* */ } await sleep(10); }
  })();

  function writer(n: number): Promise<void> {
    return (async () => {
      let i = 0;
      while (!stopWriters) {
        i++;
        const bulk = (i + n) % 2 === 0;
        const mk = (id: string) => ({ id, type: 'decision', label: `live ${id}`, content: `writer ${n} iteration ${i} touching ${id} ${RUN_TAG}` });
        const ids = bulk
          ? Array.from({ length: BULK }, (_, k) => (k < Math.ceil(BULK * 0.6) ? `ov-${(i + k) % OVERLAP}` : `u${phaseNo}-${n}-${i}-${k}`))
          : [i % 3 === 0 ? `u${phaseNo}-${n}-${i}` : `ov-${(i * 7 + n) % OVERLAP}`];
        try {
          const r = bulk
            ? await drive('POST', '/api/nodes/bulk', { workspace: CELL.appId, nodes: ids.map(mk) })
            : await drive('POST', '/api/node', { workspace: CELL.appId, ...mk(ids[0]!) });
          const b = r.body as { ok?: boolean; succeeded?: number; results?: Array<{ id?: string; ok?: boolean }> } | undefined;
          if (r.status >= 200 && r.status < 300 && (bulk ? b?.ok === true && b?.succeeded === ids.length : true)) {
            for (const id of ids) acked.add(id);
            acks++;
          } else writeErrors++;
        } catch { writeErrors++; }
        await sleep(5);
      }
    })();
  }

  let phaseNo = 0;
  async function runLoad(label: string, withOutage: boolean): Promise<void> {
    phaseNo++;
    console.log(`\n--- ${label} ---`);
    stopWriters = false;
    const writers = Array.from({ length: WRITERS }, (_, n) => writer(n));
    if (withOutage) {
      await sleep(Math.min(8_000, DURATION_MS / 4));
      console.log(`  docker stop ${CONTAINER} (outage ${OUTAGE_MS} ms)`);
      spawnSync('docker', ['stop', '-t', '2', CONTAINER], { stdio: 'ignore' });
      await sleep(OUTAGE_MS);
      console.log(`  docker start ${CONTAINER}`);
      spawnSync('docker', ['start', CONTAINER], { stdio: 'ignore' });
      await sleep(Math.max(5_000, DURATION_MS - Math.min(8_000, DURATION_MS / 4) - OUTAGE_MS));
    } else {
      await sleep(DURATION_MS);
    }
    stopWriters = true;
    await Promise.all(writers);
    console.log(`  writers done: acks=${acks} acknowledged-ids=${acked.size} writeErrors(not acknowledged)=${writeErrors}`);
    // Drain: tick until the lane has no unfinished rows.
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    let unfinished = 0;
    for (;;) {
      // 'dead' rows are counted separately below (RA-6 superseded rows are dead by design, not loss).
      unfinished = ((await outStore.listUnfinished?.()) ?? []).filter((e) => e.workspace === laneKey && e.status !== 'dead').length;
      if (unfinished === 0 || Date.now() > deadline) break;
      if (Math.floor((Date.now() - deadline + DRAIN_TIMEOUT_MS) / 1000) % 30 === 0) console.log(`  draining... unfinished=${unfinished}`);
      await sleep(1_000);
    }
    const summary = await outStore.deadLetterSummary?.(laneKey);
    const deadRows = (await outStore.listDeadPage?.({ workspace: laneKey, limit: 20 })) ?? [];
    for (const d of deadRows.filter((x) => x.lastError !== 'superseded by newer same-key write (RA-6)').slice(0, 5)) console.error(`  DEAD ${d.operationKind} ${d.id} reason=${(d as { deadReason?: string }).deadReason} err=${String(d.lastError).slice(0, 300)}`);
    const stats = handle.replicator.getStats();
    console.log(`  CME responses seen from ArcadeDB (request path + replicator) = ${cmeResponses}`);
    console.log(`  replicator: transient retries = ${stats.transientRetries} (log lines ${transientLines}), failures = ${stats.failures}, dead = ${stats.dead}`);
    console.log(`  outbox lane unfinished = ${unfinished}; deadLetterSummary = ${JSON.stringify(summary)}`);
    check(`${label}: 0 dead-lettered rows (RA-6 superseded rows excluded: ${summary?.deadSuperseded ?? 0})`, (summary?.deadLettered ?? -1) === 0, JSON.stringify(summary));
    check(`${label}: outbox drained to empty`, unfinished === 0, `unfinished=${unfinished}`);
    // Every acknowledged node must be present in ArcadeDB.
    const missing: string[] = [];
    const idList = [...acked];
    for (let k = 0; k < idList.length; k += 8) {
      await Promise.all(idList.slice(k, k + 8).map(async (id) => {
        const r = await drive('GET', `/api/node?workspace=${CELL.appId}&id=${encodeURIComponent(id)}`);
        if (r.status !== 200) missing.push(`${id}:${r.status}`);
      }));
    }
    check(`${label}: every acknowledged node present in ArcadeDB (${idList.length} ids)`, missing.length === 0, `missing=${JSON.stringify(missing.slice(0, 10))}`);
  }

  await runLoad('phase 1: concurrent writers, overlapping ids', false);
  const cmePhase1 = cmeResponses;
  const transientPhase1 = handle.replicator.getStats().transientRetries;
  if (CONTAINER) await runLoad('phase 2: ArcadeDB stopped ~30 s mid-load, then restarted', true);
  else console.log('\n(phase 2 skipped: LIVE_CONTAINER not set)');

  stopTicks = true;
  await ticker;
  await handle.stop();
  outStore.close?.();
  console.log(`\nTOTALS: CME responses phase1=${cmePhase1} total=${cmeResponses}; replicator transient retries phase1=${transientPhase1} total=${handle.replicator.getStats().transientRetries}`);
  console.log(`=== ${pass}/${pass + fail} passed ===`);
  try { await destroyApp(CELL, { registryDbPath: REGISTRY_DB_PATH }); } catch { /* */ }
  closeTokenDb(); closeRegistryDb();
  try { fs.rmSync(LORE_HOME, { recursive: true, force: true }); } catch { /* */ }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); try { fs.rmSync(LORE_HOME, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });

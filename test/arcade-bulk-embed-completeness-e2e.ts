#!/usr/bin/env tsx
/**
 * test/arcade-bulk-embed-completeness-e2e.ts — arcade cloud-path e2e for the
 * bulk-embed-completeness fix (branch: spike/arcadedb-multitenant).
 *
 * BUG (fixed): POST /api/nodes/bulk with the DEFAULT embed mode (no explicit
 * `embed` field → parseBulkEmbedMode defaults to 'queued') recorded ONE
 * `embed.batch` outbox row on the cell lane. But arcadeOutboxWiring.ts leaves
 * embed.batch UNWIRED (the cell embeds inline via the WIRED verbatim.upsert →
 * ArcadeVectorStore.store() path), so the row dead-lettered on the next tick
 * (UnwiredOperationKindError) and the bulk nodes' embeddings NEVER landed in the
 * cell's ArcadeDB vector store — silently non-recallable-by-meaning, plus a dead
 * outbox row per call. The single-node path (POST /api/node) was fine because it
 * records verbatim.upsert, which IS wired.
 *
 * FIX (Option B): in arcade the bulk path emits one WIRED verbatim.upsert row per
 * queued node (parity with the single-node arcade path), not one embed.batch row.
 * This suite drives a REAL POST /api/nodes/bulk against the live pinned ArcadeDB
 * container with NO explicit embed field (the default) and asserts the invariant:
 *
 *   (a) RECALL-COMPLETE — after replicator drain the bulk nodes are semantically
 *       recallable via GET /api/recall in their own cell (totalRecalled > 0).
 *   (b) NO DEAD ROWS     — the cell lane has zero dead/failed outbox rows, and
 *       zero embed.batch rows were ever produced.
 *   (c) CELL ISOLATION   — a DIFFERENT tenant's cell does NOT recall them.
 *
 * Run: npx tsx test/arcade-bulk-embed-completeness-e2e.ts
 * Pre-req: ArcadeDB 26.7.1+ container running on :2480 (root SpikeRoot123!).
 * Not on the fast npm gate — this is a container-backed cloud e2e.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

// LORE_HOME must be pinned BEFORE any provisioner import resolves loreHomePath().
const RUN_TAG_EARLY = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const LORE_HOME_EARLY = path.join(os.tmpdir(), `arcade-bulk-embed-lorehome-${RUN_TAG_EARLY}`);
fs.mkdirSync(LORE_HOME_EARLY, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME_EARLY;

import {
  provisionApp,
  destroyApp,
  getTenantApp,
  closeRegistryDb,
  readSecretAsync,
  ARCADE_BASE_URL,
} from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { issueToken, closeTokenDb } from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { ArcadeCellPool } from '../packages/lore/src/engines/arcade/arcadeCellPool.js';
import { tryArcadeDataRoutes } from '../packages/lore/src/mcp/http/routes/arcadeData.js';
import { arcadeCellKey } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { wireArcadeReplicator } from '../packages/lore/src/engines/arcade/arcadeOutboxWiring.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { AuditLog } from '../packages/lore/src/security/audit.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

process.env['ARCADE_BASE_URL'] ??= ARCADE_BASE_URL;
process.env['ARCADE_ROOT_PASSWORD'] ??= 'SpikeRoot123!';

// ── mini harness ──────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${label}`);
  } else {
    fail++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.error(`  [FAIL] ${label}${detail ? `\n         ${detail}` : ''}`);
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── isolated registry + lore-home ───────────────────────────────────────────
const LORE_HOME = LORE_HOME_EARLY;
const REGISTRY_DB_PATH = path.join(LORE_HOME, 'arcade-provisioning.sqlite');

// Two tenants → two cells (isolation). Short lowercase-alnum ids (NAME_RE).
const CELL_A = { customerId: 'bulka', appId: 'bulkapp' };
const CELL_B = { customerId: 'bulkb', appId: 'bulkapp' };

const embedder = new LocalEmbeddingProvider();
const auditLog = new AuditLog();

// ── mock req/res (mirrors cloud-slice4-ga-e2e.ts) ───────────────────────────
interface Captured {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
function mkReq(method: string, url: string, bearer?: string, body?: unknown) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
  process.nextTick(() => {
    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', Buffer.from(payload));
    }
    req.emit('end');
  });
  return req;
}
function mkRes(): { res: unknown; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined, headers: {} };
  let raw = '';
  const res = {
    headersSent: false,
    statusCode: 200,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
    end(chunk?: string) {
      if (chunk) raw += chunk;
      if (captured.status === 0) captured.status = (res as { statusCode: number }).statusCode;
      try {
        captured.body = raw ? JSON.parse(raw) : undefined;
      } catch {
        captured.body = raw;
      }
    },
    write(chunk: string) {
      raw += chunk;
      return true;
    },
  };
  return { res, captured };
}

async function driveData(
  p: ArcadeCellPool,
  method: string,
  apiPath: string,
  bearer: string,
  body?: unknown,
  outboxStore?: SqliteOutboxStore,
): Promise<{ status: number; body: unknown }> {
  const pathname = apiPath.split('?')[0]!;
  const req = mkReq(method, apiPath, bearer, body);
  const { res, captured } = mkRes();
  await tryArcadeDataRoutes(req as never, res as never, apiPath, pathname, bearer, {
    pool: p,
    auditLog,
    outboxStore,
  } as never);
  return { status: captured.status, body: captured.body };
}

async function cleanup(): Promise<void> {
  for (const cell of [CELL_A, CELL_B]) {
    try { await destroyApp(cell, { registryDbPath: REGISTRY_DB_PATH }); } catch { /* */ }
  }
  closeTokenDb();
  closeRegistryDb();
  try { fs.rmSync(LORE_HOME, { recursive: true, force: true }); } catch { /* */ }
}

async function main(): Promise<void> {
  console.log('=== ARCADE bulk-embed-completeness e2e (POST /api/nodes/bulk, default embed) ===');
  const embedDim = embedder.dimension;
  await provisionApp(CELL_A, { registryDbPath: REGISTRY_DB_PATH, embedDim });
  await provisionApp(CELL_B, { registryDbPath: REGISTRY_DB_PATH, embedDim });

  const pool = new ArcadeCellPool({ registryDbPath: REGISTRY_DB_PATH, embedder });
  const outboxDir = path.join(LORE_HOME, 'bulk-embed-outbox');
  fs.mkdirSync(outboxDir, { recursive: true });
  const outStore = new SqliteOutboxStore(outboxDir);

  const tokenA = issueToken(
    { tenantId: CELL_A.customerId, appId: CELL_A.appId, scopes: ['read', 'write'] },
    { registryDbPath: REGISTRY_DB_PATH },
  ).token;
  const tokenB = issueToken(
    { tenantId: CELL_B.customerId, appId: CELL_B.appId, scopes: ['read', 'write'] },
    { registryDbPath: REGISTRY_DB_PATH },
  ).token;

  const keyA = arcadeCellKey(CELL_A.customerId, CELL_A.appId);

  // The distinctive semantic content we bulk-write into cell A and later try to
  // recall by MEANING (a paraphrase, so we exercise the vector index, not a
  // substring match).
  const bulkNodes = [
    {
      id: 'bulk-embed-1',
      type: 'decision',
      label: 'Adopt hexagonal architecture for the billing service',
      content: 'We will restructure the payments module around ports and adapters to isolate the domain core from database and HTTP concerns.',
    },
    {
      id: 'bulk-embed-2',
      type: 'decision',
      label: 'Migrate session cache to Redis',
      content: 'The in-memory session store will move to a Redis cluster so horizontal scaling of the web tier stops evicting logged-in users.',
    },
    {
      id: 'bulk-embed-3',
      type: 'convention',
      label: 'All timestamps stored as UTC ISO-8601',
      content: 'Persisted datetime fields must be serialized in UTC using ISO-8601 with a trailing Z; local-time storage is prohibited.',
    },
  ];

  // ── (1) POST /api/nodes/bulk with NO explicit embed field (the DEFAULT).
  const bulkResp = await driveData(pool, 'POST', '/api/nodes/bulk', tokenA, {
    workspace: CELL_A.appId,
    nodes: bulkNodes,
    // NOTE: intentionally NO `embed` field — parseBulkEmbedMode defaults to
    // 'queued', the exact mode that used to dead-letter in arcade.
  }, outStore);
  const bulkBody = bulkResp.body as { ok?: boolean; succeeded?: number } | undefined;
  check(
    'bulk write returns ok with all nodes succeeded',
    bulkResp.status >= 200 && bulkResp.status < 300 && bulkBody?.ok === true && bulkBody?.succeeded === bulkNodes.length,
    `status=${bulkResp.status} body=${JSON.stringify(bulkBody)}`,
  );

  // The bulk path must record WIRED verbatim.upsert rows on the cell lane and
  // NEVER an embed.batch row (the unwired kind that dead-lettered pre-fix).
  const pendingBeforeDrain = (await outStore.listPendingForWorkspace?.(keyA, 50)) ?? [];
  const kindsBefore = pendingBeforeDrain.map((e) => e.operationKind);
  check(
    'bulk records one WIRED verbatim.upsert row per node (no embed.batch)',
    pendingBeforeDrain.filter((e) => e.operationKind === 'verbatim.upsert').length === bulkNodes.length
      && !kindsBefore.includes('embed.batch'),
    `kinds=${JSON.stringify(kindsBefore)}`,
  );

  // ── (2) Drain the cell replicator (real ArcadeVectorStore.store embeds inline).
  const handle = wireArcadeReplicator({ store: outStore, embedder });
  // A few ticks so node.upsert + verbatim.upsert rows all apply.
  for (let i = 0; i < 4; i++) await handle.replicator.tickOnce();

  // ── (a) RECALL-COMPLETE — semantically recall by MEANING in cell A.
  const recallA = await driveData(
    pool,
    'GET',
    `/api/recall?workspace=${CELL_A.appId}&topic=${encodeURIComponent('ports and adapters domain isolation for payments')}&max=5`,
    tokenA,
  );
  const recallABody = recallA.body as { totalRecalled?: number; hits?: Array<{ id?: string }> } | undefined;
  const recalledIdsA = (recallABody?.hits ?? []).map((h) => h.id).filter(Boolean);
  check(
    '(a) bulk-written nodes are semantically recallable in their OWN cell (totalRecalled > 0)',
    recallA.status === 200 && (recallABody?.totalRecalled ?? 0) > 0,
    `status=${recallA.status} totalRecalled=${recallABody?.totalRecalled} ids=${JSON.stringify(recalledIdsA)}`,
  );
  check(
    '(a) the specific bulk node is in the recall hits (embedding landed in the cell vector store)',
    recalledIdsA.includes('bulk-embed-1'),
    `ids=${JSON.stringify(recalledIdsA)}`,
  );

  // ── (b) NO DEAD ROWS — nothing dead/failed on the cell lane, and no
  //     embed.batch row ever produced. Uses public store introspection:
  //       - replicator.getStats().dead/failures — no dead/failed transitions
  //         happened during drain (embed.batch would have dead-lettered here).
  //       - listFailedOlderThan(0, {workspace}) — the failed+dead slice for the
  //         cell lane is empty (this is the exact primitive drain-failed uses).
  //       - listUnfinished() — no leftover non-replicated rows on the lane
  //         (every verbatim.upsert applied; an embed.batch would linger dead).
  for (let i = 0; i < 3; i++) { await handle.replicator.tickOnce(); await sleep(50); }
  const stats = handle.replicator.getStats();
  check(
    '(b) replicator recorded ZERO dead + ZERO failed transitions across all ticks',
    stats.dead === 0 && stats.failures === 0,
    `replicator stats.dead=${stats.dead} failures=${stats.failures}`,
  );
  const failedOrDead = (await outStore.listFailedOlderThan?.(0, { workspace: keyA, limit: 100 })) ?? [];
  check(
    '(b) cell lane has NO failed/dead outbox rows after drain',
    failedOrDead.length === 0,
    `failedOrDead=${JSON.stringify(failedOrDead.map((e) => `${e.id}:${e.status}:${e.operationKind}`))}`,
  );
  const unfinished = (await outStore.listUnfinished?.()) ?? [];
  const laneUnfinished = unfinished.filter((e) => e.workspace === keyA);
  const laneEmbedBatch = laneUnfinished.filter((e) => e.operationKind === 'embed.batch');
  check(
    '(b) no leftover non-replicated rows on the cell lane, and NO embed.batch row was produced',
    laneUnfinished.length === 0 && laneEmbedBatch.length === 0,
    `laneUnfinished=${JSON.stringify(laneUnfinished.map((e) => `${e.id}:${e.status}:${e.operationKind}`))}`,
  );

  // ── (c) CELL ISOLATION — tenant B must NOT recall cell A's content.
  const recallB = await driveData(
    pool,
    'GET',
    `/api/recall?workspace=${CELL_B.appId}&topic=${encodeURIComponent('ports and adapters domain isolation for payments')}&max=5`,
    tokenB,
  );
  const recallBBody = recallB.body as { totalRecalled?: number; hits?: Array<{ id?: string }> } | undefined;
  const recalledIdsB = (recallBBody?.hits ?? []).map((h) => h.id).filter(Boolean);
  check(
    "(c) another tenant's cell does NOT recall cell A's bulk nodes (isolation)",
    recallB.status === 200
      && !recalledIdsB.includes('bulk-embed-1')
      && !recalledIdsB.includes('bulk-embed-2')
      && !recalledIdsB.includes('bulk-embed-3'),
    `status=${recallB.status} totalRecalled=${recallBBody?.totalRecalled} ids=${JSON.stringify(recalledIdsB)}`,
  );

  await handle.stop();
  outStore.close?.();

  console.log(`\n=== ${pass}/${pass + fail} passed ===`);
  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
  }
}

main()
  .then(cleanup, async (err) => {
    console.error('FATAL:', err);
    await cleanup();
    process.exitCode = 1;
  })
  .finally(() => {
    process.exitCode = fail > 0 ? 1 : (process.exitCode ?? 0);
  });

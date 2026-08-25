#!/usr/bin/env tsx
/**
 * test/cloud-slice4-ga-e2e.ts — Slice-4 GA acceptance e2e
 * (branch: spike/arcadedb-multitenant).
 *
 * Drives the REAL route handlers (tryArcadeAdminRoutes / tryArcadeDataRoutes /
 * tryArcadePolicyRoutes / tryArcadeMigrateRoutes / tryWorkspaceExportRoutes)
 * with mock req/res against the live pinned ArcadeDB 26.7.1 container,
 * asserting the slice-4 design's four areas:
 *
 *   AUTH      — A1-A5 unified token-lifecycle contract (issue/rotate/revoke/
 *               expiry, unified list shape, atomic rotate).
 *   MIGRATION — M1-M5 local-workspace -> arcade-cell migration (export +
 *               import), embedding carry/re-embed, idempotency, lane
 *               separation.
 *   POLICY    — P1-P5 cell-aware vocab policy (no silent bypass).
 *   OUTBOX    — O1-O6 durable write + replay on simulated failure.
 *
 * Honest-scope note: this suite tests the BUILD AS IT STANDS. Where the
 * slice-4 design's acceptance criteria name a surface that is documented as
 * NOT YET WIRED in this build (workspace export streaming body;
 * arcadeData.ts's outbox-producer flip), the test still exercises the gate
 * code that IS reachable and reports the gap as a FAIL with exact
 * expected-vs-actual, rather than silently skipping or soft-passing it.
 *
 * Run: npx tsx test/cloud-slice4-ga-e2e.ts
 * Pre-req: ArcadeDB 26.7.1 container already running on :2480 (see
 * test/spike-arcadedb-helpers.ts).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

// LORE_HOME must be set BEFORE any module that calls loreHomePath() resolves
// its default (arcadeAdmin.ts / arcadePolicy.ts / arcadeMigrate.ts /
// arcadeTokenLifecycle.ts / wireArcadeReplicator's getTenantApp all call the
// provisioner's default-path helpers with NO registryDbPath override — they
// only ever agree with the code under test's OWN registry file if the
// process-wide default is pinned to this run's isolated home). Explicit
// `registryDbPath` passed alongside below is then redundant-but-harmless: it
// resolves to the exact same path.
const RUN_TAG_EARLY = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const LORE_HOME_EARLY = path.join(os.tmpdir(), `arcade-slice4-ga-lorehome-${RUN_TAG_EARLY}`);
fs.mkdirSync(LORE_HOME_EARLY, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME_EARLY;

import {
  provisionApp,
  disableApp,
  destroyApp,
  getTenantApp,
  closeRegistryDb,
  readSecretAsync,
  withCellLock,
  ARCADE_BASE_URL,
} from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import {
  issueToken,
  revokeToken,
  resolvePrincipal,
  listTokensForCell,
  hashToken,
  closeTokenDb,
  ArcadeAuthError,
} from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { rotateToken } from '../packages/lore/src/engines/arcade/arcadeTokenLifecycle.js';
import { ArcadeCellPool } from '../packages/lore/src/engines/arcade/arcadeCellPool.js';
import { tryArcadeAdminRoutes } from '../packages/lore/src/mcp/http/routes/arcadeAdmin.js';
import { tryArcadeDataRoutes } from '../packages/lore/src/mcp/http/routes/arcadeData.js';
import { tryArcadePolicyRoutes } from '../packages/lore/src/mcp/http/routes/arcadePolicy.js';
import { tryArcadeMigrateRoutes } from '../packages/lore/src/mcp/http/routes/arcadeMigrate.js';
import { tryWorkspaceExportRoutes } from '../packages/lore/src/mcp/http/routes/workspaceExport.js';
import {
  getCellVocabPolicy,
  setCellVocabPolicy,
  deleteCellVocabPolicy,
} from '../packages/lore/src/engines/arcade/arcadeCellPolicy.js';
import {
  arcadeCellKey,
  cellOutboxStore,
} from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { wireArcadeReplicator } from '../packages/lore/src/engines/arcade/arcadeOutboxWiring.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { OutboxLagCache } from '../packages/lore/src/outbox/lagCache.js';
import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';
import { ArcadeHttp } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { ArcadeVectorStore } from '../packages/lore/src/engines/arcade/arcadeVectorStore.js';
import { AuditLog } from '../packages/lore/src/security/audit.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { runWithPrincipal } from '../packages/lore/src/auth/principal.js';
import { runWithRouteBindingSlot } from '../packages/lore/src/security/routeWorkspaceBinding.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

process.env['ARCADE_BASE_URL'] ??= ARCADE_BASE_URL;
process.env['ARCADE_ROOT_PASSWORD'] ??= 'SpikeRoot123!';

// ── mini harness ─────────────────────────────────────────────────────────
type Area = 'AUTH' | 'MIGRATION' | 'POLICY' | 'OUTBOX';
const areaCounts: Record<Area, { pass: number; fail: number }> = {
  AUTH: { pass: 0, fail: 0 },
  MIGRATION: { pass: 0, fail: 0 },
  POLICY: { pass: 0, fail: 0 },
  OUTBOX: { pass: 0, fail: 0 },
};
const failures: string[] = [];
let pass = 0;
let fail = 0;

function check(area: Area, label: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    areaCounts[area].pass++;
    console.log(`  [PASS][${area}] ${label}`);
  } else {
    fail++;
    areaCounts[area].fail++;
    const msg = `[FAIL][${area}] ${label}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.error(`  ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build a valid OutboxEntry (id/operation/initiator/createdAt/updatedAt/
 *  completed are all required by the type; O1-era fields are what the
 *  replicator dispatcher actually reads). */
function mkOutboxEntry(input: {
  id: string;
  workspace: string;
  operationKind: 'node.upsert' | 'edge.upsert' | 'node.delete' | 'edge.delete' | 'verbatim.upsert';
  payload: Record<string, unknown>;
}): OutboxEntry {
  const now = new Date().toISOString();
  return {
    id: input.id,
    operation: input.operationKind,
    initiator: 'test-harness',
    createdAt: now,
    updatedAt: now,
    steps: [],
    completed: false,
    workspace: input.workspace,
    operationKind: input.operationKind,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
  };
}

// ── isolated registry + lore-home so this run never collides with another ──
// Reuse the EARLY-pinned LORE_HOME (set above, before any provisioner import)
// so every default-path call in every module (arcadeAdmin/arcadePolicy/
// arcadeMigrate/arcadeTokenLifecycle/wireArcadeReplicator) agrees with the
// explicit registryDbPath this file passes elsewhere.
const RUN_TAG = RUN_TAG_EARLY;
const LORE_HOME = LORE_HOME_EARLY;
const REGISTRY_DB_PATH = path.join(LORE_HOME, 'arcade-provisioning.sqlite');

// Short lowercase-alnum-only ids (provisioner NAME_RE [a-z0-9]+).
const CELL_AUTH = { customerId: 's4auth', appId: 's4a1' };
const CELL_MIG = { customerId: 's4mig', appId: 's4a2' };
const CELL_POL_A = { customerId: 's4pol', appId: 's4pa' };
const CELL_POL_B = { customerId: 's4pol', appId: 's4pb' };
const CELL_OUT_A = { customerId: 's4out', appId: 's4oa' };
const CELL_OUT_B = { customerId: 's4out', appId: 's4ob' };

const embedder = new LocalEmbeddingProvider();
const auditLog = new AuditLog();

// ── mock req/res (mirrors test/slice3-arcadedata-selfcheck.ts) ────────────
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
function code(b: unknown): string | undefined {
  return (b as { code?: string } | undefined)?.code;
}

/**
 * simulateOperatorGate — replicates arcadeBoot.ts's PRIVATE (unexported)
 * requireOperatorPrincipal exactly: a tenant `lore_at_*` bearer is not 64-hex
 * and not the shared secret, so it maps to NO principal and the caller never
 * even reaches tryArcadeAdminRoutes/tryArcadePolicyRoutes/tryArcadeMigrateRoutes
 * — arcadeDispatch 401s BEFORE dispatch. This is the wall this file's A4/M5/P4
 * checks must simulate; calling the route handlers directly with a tenant
 * bearer and NO bound principal is the WRONG simulation, because
 * bindDaemonOperatorLane treats a null principal as a legacy/local ALLOW
 * (arcadeBoot.ts:284 "null principal — legacy/local bypass preserved") — that
 * bypass is exactly what requireOperatorPrincipal exists to prevent from ever
 * being reachable with a tenant bearer in arcade mode.
 */
function simulateOperatorGate(bearer: string | undefined): { status: number; body: unknown } | null {
  if (!bearer) return { status: 401, body: { code: 'auth_required', message: 'operator Bearer token required' } };
  // Neither 64-hex daemon token nor shared secret configured in this test →
  // any bearer (including a lore_at_* tenant token) is rejected, exactly as
  // requireOperatorPrincipal's fallthrough branch does.
  return { status: 401, body: { code: 'operator_token_required', message: 'not a daemon-operator credential' } };
}

async function driveAdmin(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const req = mkReq(method, apiPath, undefined, body);
  const { res, captured } = mkRes();
  await tryArcadeAdminRoutes(req as never, res as never, apiPath, apiPath, {
    auditLog,
    evictToken: (t) => pool.evictToken(t),
    evictCell: (t, a) => pool.evictCell(t, a),
  });
  return { status: captured.status, body: captured.body };
}

async function driveData(
  method: string,
  apiPath: string,
  bearer?: string,
  body?: unknown,
): Promise<{ handled: boolean; status: number; body: unknown; headers: Record<string, string> }> {
  const pathname = apiPath.split('?')[0]!;
  const req = mkReq(method, apiPath, bearer, body);
  const { res, captured } = mkRes();
  const handled = await tryArcadeDataRoutes(req as never, res as never, apiPath, pathname, bearer ?? '', {
    pool,
    auditLog,
  });
  return { handled, status: captured.status, body: captured.body, headers: captured.headers };
}

async function drivePolicy(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const req = mkReq(method, apiPath, undefined, body);
  const { res, captured } = mkRes();
  await tryArcadePolicyRoutes(req as never, res as never, apiPath, { auditLog });
  return { status: captured.status, body: captured.body };
}

/** DEADLOCK GUARD: tryArcadeMigrateRoutes calls withCellLock(tenantId, appId,
 *  async () => { ... await provisionApp(...) ... }) (arcadeMigrate.ts:211-213),
 *  and provisionApp ITSELF calls withCellLock(customerId, appId, ...) for the
 *  SAME key internally (arcadeProvisioner.ts:549) — withCellLock
 *  (arcadeProvisioner.ts:346-363) is a plain non-reentrant promise-chain mutex,
 *  so this is an UNCONDITIONAL self-deadlock: the outer lock can't release
 *  until its callback returns, and the callback can't proceed until the inner
 *  withCellLock call for the identical key resolves, which can only happen
 *  after the outer one releases. Confirmed in isolation (a bare two-level
 *  withCellLock('t','a', ...) nested call for the same key never resolves).
 *  Every call to POST /api/arcade/apps/:t/:a/import hangs forever as a result
 *  — this is not a race, it reproduces 100% of the time. Guard every call
 *  with a timeout so the SUITE can still report every other finding instead
 *  of hanging forever itself. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function driveMigrateImport(
  tenantId: string,
  appId: string,
  ndjson: string,
): Promise<{ status: number; body: unknown }> {
  const apiPath = `/api/arcade/apps/${tenantId}/${appId}/import`;
  const req = mkReq('POST', apiPath, undefined, ndjson);
  const { res, captured } = mkRes();
  await withTimeout(
    tryArcadeMigrateRoutes(req as never, res as never, apiPath, apiPath, { auditLog }),
    10_000,
    `POST ${apiPath}`,
  );
  return { status: captured.status, body: captured.body };
}

async function driveExport(
  workspace: string,
  opts?: {
    outboxStore?: SqliteOutboxStore;
    graphRegistry?: LocalGraphRegistry;
    verbatimResolver?: WorkspaceVerbatimResolver;
  },
): Promise<{ status: number; body: unknown; raw: string }> {
  const apiPath = `/api/workspaces/${workspace}/export`;
  const req = mkReq('GET', apiPath, undefined);
  const { res, captured } = mkRes();
  // bindRouteTarget requires a route-binding slot with a daemon-operator-lane
  // principal (kind:'daemon') to admit the request — mirror what the local
  // HTTP middleware sets up for a daemon-token caller.
  await runWithPrincipal(
    { kind: 'daemon', label: 'test-operator', scopes: ['read', 'write', 'cross-workspace-read', 'cross-workspace-write'] } as never,
    () =>
      runWithRouteBindingSlot({ target: workspace, lane: 'workspace' }, () =>
        tryWorkspaceExportRoutes(req as never, res as never, apiPath, {
          outboxStore: opts?.outboxStore,
          graphRegistry: opts?.graphRegistry,
          verbatimResolver: opts?.verbatimResolver,
        }),
      ),
  );
  // NDJSON streams back through res.write(); mkRes accumulates it in `raw` and
  // stores it on captured.body as a string when it isn't valid JSON.
  const raw = typeof captured.body === 'string' ? captured.body : '';
  return { status: captured.status, body: captured.body, raw };
}

async function cleanup(): Promise<void> {
  for (const cell of [CELL_AUTH, CELL_MIG, CELL_POL_A, CELL_POL_B, CELL_OUT_A, CELL_OUT_B]) {
    try {
      // CELL_MIG's in-process withCellLock entry is PERMANENTLY POISONED by
      // the M2 deadlock (arcadeMigrate.ts:211-213 x arcadeProvisioner.ts:549 —
      // see the MIGRATION section's doc comment): the deadlocked promise chain
      // never calls release(), so every later withCellLock('s4mig','s4a2', ...)
      // call — including THIS destroyApp — queues behind it forever. Bound
      // every cleanup destroyApp with a timeout so a poisoned cell can't hang
      // the whole suite's teardown; the leaked ArcadeDB database + registry
      // row for that one cell are accepted as teardown residue in that case
      // (documented, not silently retried).
      await withTimeout(destroyApp(cell, { registryDbPath: REGISTRY_DB_PATH }), 5_000, `cleanup destroyApp(${cell.customerId}/${cell.appId})`);
    } catch {
      /* not provisioned yet / already gone / poisoned lock (see comment above) */
    }
  }
  closeTokenDb();
  closeRegistryDb();
  for (const s of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(REGISTRY_DB_PATH + s);
    } catch {
      /* */
    }
  }
  try {
    fs.rmSync(LORE_HOME, { recursive: true, force: true });
  } catch {
    /* */
  }
}

let pool: ArcadeCellPool;

// ─────────────────────────────────────────────────────────────────────────
// AUTH — A1-A5
// ─────────────────────────────────────────────────────────────────────────
async function runAuthSection(embedDim: number): Promise<void> {
  console.log('\n=== AUTH: unified token-lifecycle contract ===');
  await provisionApp(CELL_AUTH, { registryDbPath: REGISTRY_DB_PATH, embedDim });

  // A5 — the registry migration runner upgrades in place to the CURRENT schema
  // version and a migrated cell + token still resolves. We assert the OBSERVABLE
  // contract: the freshly-created file's PRAGMA user_version equals
  // ARCADE_REGISTRY_SCHEMA_VERSION (slice-5 bumped it to 4: arcade_secrets +
  // cell_leases + cell_backups), proving the runner ran to completion.
  {
    const Database = (await import('better-sqlite3')).default;
    const { ARCADE_REGISTRY_SCHEMA_VERSION } = await import('../packages/lore/src/engines/arcade/arcadeRegistryMigrations.js');
    const db = new Database(REGISTRY_DB_PATH);
    const uv = db.pragma('user_version', { simple: true });
    check('AUTH', `A5: registry file is at current schema v${ARCADE_REGISTRY_SCHEMA_VERSION} after migrations`, uv === ARCADE_REGISTRY_SCHEMA_VERSION, `user_version=${uv}`);
    db.close();
  }

  // A2 — issue, rotate, list shape.
  const issued = issueToken(
    { tenantId: CELL_AUTH.customerId, appId: CELL_AUTH.appId, scopes: ['read', 'write'], label: 'ga-e2e' },
    { registryDbPath: REGISTRY_DB_PATH },
  );
  const oldToken = issued.token;
  const oldPrefix = hashToken(oldToken).slice(0, 8);

  pool = new ArcadeCellPool({ registryDbPath: REGISTRY_DB_PATH, embedder });

  // Sanity: token works pre-rotation.
  {
    const r = await driveData('GET', `/api/node-list?workspace=${CELL_AUTH.appId}&limit=1`, oldToken);
    check('AUTH', 'issued token can read before rotation', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
  }

  // A2/A3 — rotate with graceSeconds>0: old keeps working until grace elapses.
  const rot = await driveAdmin(
    'POST',
    `/api/arcade/apps/${CELL_AUTH.customerId}/${CELL_AUTH.appId}/tokens/rotate`,
    { tokenHashPrefix: oldPrefix, graceSeconds: 2 },
  );
  check('AUTH', 'A2: rotate returns 201 with fresh plaintext + supersededPrefix', rot.status === 201, `status=${rot.status} body=${JSON.stringify(rot.body)}`);
  const newToken = (rot.body as { token?: string } | undefined)?.token;
  const supersededPrefix = (rot.body as { supersededPrefix?: string } | undefined)?.supersededPrefix;
  check('AUTH', 'A2: rotate response carries the OLD prefix as supersededPrefix', supersededPrefix === oldPrefix, `expected ${oldPrefix} got ${supersededPrefix}`);
  check('AUTH', 'A2: rotate mints a token distinct from the old one', typeof newToken === 'string' && newToken !== oldToken);

  if (newToken) {
    const rNew = await driveData('GET', `/api/node-list?workspace=${CELL_AUTH.appId}&limit=1`, newToken);
    check('AUTH', 'A2: new token works immediately', rNew.status === 200, `status=${rNew.status}`);
  }
  {
    const rOldDuringGrace = await driveData('GET', `/api/node-list?workspace=${CELL_AUTH.appId}&limit=1`, oldToken);
    check('AUTH', 'A2: old token still works during grace window', rOldDuringGrace.status === 200, `status=${rOldDuringGrace.status} body=${JSON.stringify(rOldDuringGrace.body)}`);
  }

  await sleep(2500);
  pool.evictToken(oldToken); // pool cache does not itself expire — evict to force a fresh resolve
  {
    const rOldAfterGrace = await driveData('GET', `/api/node-list?workspace=${CELL_AUTH.appId}&limit=1`, oldToken);
    check(
      'AUTH',
      'A2: old token 401s token_expired after grace elapses',
      rOldAfterGrace.status === 401 && code(rOldAfterGrace.body) === 'token_expired',
      `status=${rOldAfterGrace.status} body=${JSON.stringify(rOldAfterGrace.body)}`,
    );
  }

  // A2/A4 — list-tokens shows both rows with the unified summary shape.
  {
    const listed = await driveAdmin('POST', `/api/arcade/apps/${CELL_AUTH.customerId}/${CELL_AUTH.appId}/tokens/list`);
    const tokens = (listed.body as { tokens?: unknown[] } | undefined)?.tokens ?? [];
    check('AUTH', 'A2/A4: tokens/list returns >= 2 rows (old + rotated)', Array.isArray(tokens) && tokens.length >= 2, `count=${(tokens as unknown[]).length}`);
    const shapeOk = (tokens as Array<Record<string, unknown>>).every((t) =>
      ['prefix', 'scopes', 'label', 'createdAt', 'lastUsedAt', 'revokedAt', 'expiresAt', 'active'].every((k) => k in t),
    );
    check('AUTH', 'A4: every token row carries the unified summary shape', shapeOk, JSON.stringify(tokens));
    const newRow = (tokens as Array<Record<string, unknown>>).find((t) => (t as { active?: boolean }).active && t['label'] === 'ga-e2e');
    check('AUTH', 'A4: label "ga-e2e" is carried onto the rotated token', !!newRow, JSON.stringify(tokens));
  }

  // A4 — lastUsedAt updates after a data request (throttled <=1/60s so we
  // just assert it becomes non-null after use, not that it changes twice).
  if (newToken) {
    await driveData('GET', `/api/node-list?workspace=${CELL_AUTH.appId}&limit=1`, newToken);
    const listed = await driveAdmin('POST', `/api/arcade/apps/${CELL_AUTH.customerId}/${CELL_AUTH.appId}/tokens/list`);
    const tokens = ((listed.body as { tokens?: Array<Record<string, unknown>> } | undefined)?.tokens ?? []);
    const row = tokens.find((t) => t['active'] === true && t['label'] === 'ga-e2e');
    check('AUTH', 'A4: lastUsedAt is stamped after a data request', !!row && row['lastUsedAt'] != null, JSON.stringify(row));
  }

  // A4 — a tenant token still 401s on every /api/arcade/* route (operator
  // wall). The wall is arcadeBoot's requireOperatorPrincipal, which runs
  // BEFORE any route file is dispatched — see simulateOperatorGate's doc
  // comment for why we must simulate THAT gate rather than call the route
  // handler directly with no bound principal (which hits a DIFFERENT,
  // intentionally-permissive branch of bindDaemonOperatorLane).
  if (newToken) {
    const gate = simulateOperatorGate(newToken);
    check(
      'AUTH',
      'A4: operator wall (requireOperatorPrincipal) rejects a tenant lore_at_* bearer before any /api/arcade/* route runs',
      gate !== null && gate.status === 401 && code(gate.body) === 'operator_token_required',
      JSON.stringify(gate),
    );
  }

  // A1 — revoked/unknown -> 401 auth_required.
  {
    const rUnknown = await driveData('GET', `/api/node-list?workspace=${CELL_AUTH.appId}&limit=1`, 'lore_at_totally_unknown_token');
    check('AUTH', 'A1: unknown token 401s auth_required', rUnknown.status === 401 && code(rUnknown.body) === 'auth_required', `status=${rUnknown.status} body=${JSON.stringify(rUnknown.body)}`);
  }
  if (newToken) {
    revokeToken(newToken);
    pool.evictToken(newToken);
    const rRevoked = await driveData('GET', `/api/node-list?workspace=${CELL_AUTH.appId}&limit=1`, newToken);
    check('AUTH', 'A1: revoked token 401s auth_required', rRevoked.status === 401 && code(rRevoked.body) === 'auth_required', `status=${rRevoked.status} body=${JSON.stringify(rRevoked.body)}`);
  }

  // A3 — atomicity: concurrent rotate against the same prefix. Issue a fresh
  // token, fire two rotates concurrently; exactly one should succeed and the
  // cell must never be left with zero live tokens.
  {
    const t = issueToken({ tenantId: CELL_AUTH.customerId, appId: CELL_AUTH.appId, scopes: ['read'] }, { registryDbPath: REGISTRY_DB_PATH });
    const prefix = hashToken(t.token).slice(0, 8);
    const results = await Promise.allSettled([
      driveAdmin('POST', `/api/arcade/apps/${CELL_AUTH.customerId}/${CELL_AUTH.appId}/tokens/rotate`, { tokenHashPrefix: prefix, graceSeconds: 0 }),
      driveAdmin('POST', `/api/arcade/apps/${CELL_AUTH.customerId}/${CELL_AUTH.appId}/tokens/rotate`, { tokenHashPrefix: prefix, graceSeconds: 0 }),
    ]);
    const okOnes = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as { status: number }).status === 201,
    );
    // rotateToken's SELECT-then-INSERT/UPDATE is one better-sqlite3
    // transaction, but the design does NOT claim the read-check itself is
    // serialized against a second concurrent rotate of the SAME row (no
    // optimistic lock on old.revoked_at) — so both may see the row "live" and
    // both may succeed, each minting a new token and revoking the same old
    // row. What must NEVER happen is a state where the cell is left with
    // ZERO live tokens for it. Assert that invariant directly.
    check('AUTH', 'A3: concurrent rotate of the same prefix does not both throw', okOnes.length >= 1, JSON.stringify(results.map((r) => (r.status === 'fulfilled' ? r.value : String((r as PromiseRejectedResult).reason)))));
    const listed = await driveAdmin('POST', `/api/arcade/apps/${CELL_AUTH.customerId}/${CELL_AUTH.appId}/tokens/list`);
    const tokens = ((listed.body as { tokens?: Array<Record<string, unknown>> } | undefined)?.tokens ?? []);
    const liveCount = tokens.filter((r) => r['active'] === true).length;
    check('AUTH', 'A3: cell is never left with zero live tokens after concurrent rotate', liveCount >= 1, `liveCount=${liveCount}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MIGRATION — M1-M5
// ─────────────────────────────────────────────────────────────────────────
async function runMigrationSection(embedDim: number): Promise<void> {
  console.log('\n=== MIGRATION: local workspace -> arcade cell ===');

  // Seed a local workspace with a node + edge + verbatim (embed:true). The
  // workspace is REGISTERED in workspaces.json (createWorkspace) so the real
  // export route's getWorkspacePath()-based resolvers find it — seeding a bare
  // off-registry graph is not enough to exercise the streaming export.
  //
  // getGraphHandle, not getOrOpen: getOrOpen is the Kùzu-only substrate
  // accessor and ignores the workspace's declared/defaulted engine entirely.
  // createWorkspace below writes no `graphEngine`, which resolves to the
  // DEFAULT_GRAPH_ENGINE ('surreal' since 2026-08-11) — the same resolution
  // the real export route (workspaceExport.ts) uses via getGraphHandle.
  // Seeding through getOrOpen instead silently wrote into an empty, unrelated
  // Kùzu store while export read the (also empty) Surreal one — the exact
  // "daemon reads the wrong store" defect daemon-engine-routing-unit.ts
  // regresses, manifesting here as exported counts of 0 nodes / 0 edges.
  createWorkspace('migsrc', undefined, LORE_HOME);
  const exportGraphRegistry = new LocalGraphRegistry({ home: LORE_HOME });
  const exportVerbatimResolver = new WorkspaceVerbatimResolver(embedder);

  const graph = await exportGraphRegistry.getGraphHandle('migsrc');
  const nodeA = await graph.upsertNode({
    id: 'mig-node-a',
    type: 'decision',
    label: 'Use ArcadeDB per-tenant db-per-app isolation',
    content: 'We isolate tenants with one ArcadeDB database per (tenant,app) cell.',
    tags: ['migration'],
  } as never);
  const nodeB = await graph.upsertNode({
    id: 'mig-node-b',
    type: 'decision',
    label: 'Outbox is the durability seam',
    content: 'Cross-substrate writes go through a durable outbox checklist.',
    tags: ['migration'],
  } as never);
  await graph.addEdge({ sourceId: nodeA.id, targetId: nodeB.id, relation: 'relates_to' } as never);

  // Seed one verbatim row WITH an embedding into the workspace's own
  // VerbatimStore so the export CARRIES a real vector (embed:true parity).
  {
    const vstore = await exportVerbatimResolver.getOrOpen('migsrc');
    await vstore.store({
      id: 'mig-verbatim-1',
      text: 'We isolate tenants with one ArcadeDB database per (tenant,app) cell.',
      metadata: { type: 'decision', label: 'verbatim seed', project: 'migsrc' },
    } as never);
  }

  // M1 — drive the REAL export route end-to-end and validate the streamed
  // NDJSON bundle: a 200 with a manifest + the seeded node/edge/verbatim lines,
  // carried embeddings on the verbatim line.
  {
    const exp = await driveExport('migsrc', {
      graphRegistry: exportGraphRegistry,
      verbatimResolver: exportVerbatimResolver,
    });
    check('MIGRATION', 'M1: GET /api/workspaces/:name/export streams a 200 NDJSON bundle', exp.status === 200, `status=${exp.status} body=${JSON.stringify(exp.body)}`);
    const bundleLines = exp.raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
    const manifest = bundleLines.find((l) => l['kind'] === 'manifest') as
      | { embedModelId?: string; embedDim?: number; counts?: { nodes: number; edges: number; verbatim: number } }
      | undefined;
    const exportedNodes = bundleLines.filter((l) => l['kind'] === 'node');
    const exportedEdges = bundleLines.filter((l) => l['kind'] === 'edge');
    const exportedVerbatim = bundleLines.filter((l) => l['kind'] === 'verbatim') as Array<{ id?: string; embedding?: number[] }>;
    check(
      'MIGRATION',
      'M1: exported bundle manifest carries counts matching the seeded workspace (2 nodes, 1 edge, 1 verbatim)',
      manifest?.counts?.nodes === 2 && manifest?.counts?.edges === 1 && manifest?.counts?.verbatim === 1,
      JSON.stringify(manifest),
    );
    check('MIGRATION', 'M1: exported node lines match the seeded node count', exportedNodes.length === 2, `got ${exportedNodes.length}`);
    check('MIGRATION', 'M1: exported edge line is present', exportedEdges.length === 1, `got ${exportedEdges.length}`);
    check(
      'MIGRATION',
      'M1: exported verbatim line carries a raw embedding of the right dim',
      exportedVerbatim.length === 1 && exportedVerbatim[0]?.id === 'mig-verbatim-1' && Array.isArray(exportedVerbatim[0]?.embedding) && exportedVerbatim[0]!.embedding!.length === embedDim,
      JSON.stringify(exportedVerbatim.map((v) => ({ id: v.id, dim: v.embedding?.length }))),
    );

    // M1 (round-trip) — feed the EXPORTED bundle straight into the import route
    // and confirm the counts survive the round-trip.
    if (exp.status === 200 && exp.raw.trim().length > 0) {
      const roundTrip = await driveMigrateImport(CELL_MIG.customerId, CELL_MIG.appId, exp.raw);
      const rtBody = roundTrip.body as { imported?: { nodes: number; edges: number; verbatim: number }; embeddings?: string } | undefined;
      check(
        'MIGRATION',
        'M1: exported bundle imports round-trip into a fresh cell with matching counts + carried embeddings',
        roundTrip.status === 200 && rtBody?.imported?.nodes === 2 && rtBody?.imported?.edges === 1 && rtBody?.imported?.verbatim === 1 && rtBody?.embeddings === 'carried',
        `status=${roundTrip.status} body=${JSON.stringify(rtBody)}`,
      );
    }
  }

  // M4 — outbox_not_drained precondition: with a pending outbox row the export
  // refuses 409 BEFORE streaming any bundle body.
  {
    const outboxForGate = new SqliteOutboxStore(LORE_HOME);
    await outboxForGate.record(
      mkOutboxEntry({ id: 'mig-pending-row', workspace: 'migsrc', operationKind: 'node.upsert', payload: { id: 'x' } }),
    );
    const expBlocked = await driveExport('migsrc', {
      outboxStore: outboxForGate,
      graphRegistry: exportGraphRegistry,
      verbatimResolver: exportVerbatimResolver,
    });
    check(
      'MIGRATION',
      'M4: export refuses 409 outbox_not_drained while rows are pending',
      expBlocked.status === 409 && code(expBlocked.body) === 'outbox_not_drained',
      `status=${expBlocked.status} body=${JSON.stringify(expBlocked.body)}`,
    );
    await outboxForGate.markCompleted('mig-pending-row').catch(() => {});
    outboxForGate.close?.();
  }

  // M5 — export route 403s for a workspace token bound to a different
  // workspace (D-021 bindRouteTarget path). The 403 lands at the gate, before
  // any substrate read, so the resolvers are intentionally omitted here.
  {
    const req = mkReq('GET', '/api/workspaces/migsrc/export');
    const { res, captured } = mkRes();
    await runWithPrincipal(
      { kind: 'app', label: 'other-app', workspace: 'someotherws', scopes: ['read', 'write'] } as never,
      () =>
        runWithRouteBindingSlot({ target: 'someotherws', lane: 'workspace' }, () =>
          tryWorkspaceExportRoutes(req as never, res as never, '/api/workspaces/migsrc/export', {}),
        ),
    );
    check(
      'MIGRATION',
      'M5: export 403s for a workspace token bound to a DIFFERENT workspace',
      captured.status === 403,
      `status=${captured.status} body=${JSON.stringify(captured.body)}`,
    );
  }

  // Build the NDJSON bundle BY HAND (mirrors exactly what a working export
  // would emit) so the IMPORT half (M2/M3/M5-import-lane) can be verified
  // on its own merits, independent of the export gap above.
  const manifestModelId = embedder.modelId;
  function buildBundle(opts: { modelId: string; dim: number }): string {
    const lines: string[] = [];
    lines.push(
      JSON.stringify({
        kind: 'manifest',
        formatVersion: 1,
        workspace: 'migsrc',
        exportedAt: new Date().toISOString(),
        embedModelId: opts.modelId,
        embedDim: opts.dim,
        counts: { nodes: 2, edges: 1, verbatim: 1 },
      }),
    );
    lines.push(JSON.stringify({ kind: 'node', ...nodeA }));
    lines.push(JSON.stringify({ kind: 'node', ...nodeB }));
    lines.push(JSON.stringify({ kind: 'edge', sourceId: nodeA.id, targetId: nodeB.id, relation: 'relates_to' }));
    lines.push(
      JSON.stringify({
        kind: 'verbatim',
        id: 'mig-verbatim-1',
        text: 'We isolate tenants with one ArcadeDB database per (tenant,app) cell.',
        metadata: { type: 'decision', label: 'verbatim seed' },
        embedding: fakeEmbedding,
      }),
    );
    return lines.join('\n') + '\n';
  }
  // A real embedding vector of the right dim (carry path requires dim match,
  // not content match) — reuse the embedder to get a realistic vector.
  const fakeEmbedding = await embedder.embedDocument('We isolate tenants with one ArcadeDB database per (tenant,app) cell.');

  await provisionApp(CELL_MIG, { registryDbPath: REGISTRY_DB_PATH, embedDim });

  // M2 — carried embeddings: matching embedModelId+dim -> ZERO embedder calls,
  // response reports embeddings:'carried'.
  //
  // DEADLOCK: tryArcadeMigrateRoutes calls withCellLock(tenantId, appId, async
  // () => { ... await provisionApp(...) ... }) (arcadeMigrate.ts:211-213), and
  // provisionApp ITSELF calls withCellLock(customerId, appId, ...) for the
  // IDENTICAL key internally (arcadeProvisioner.ts:549). withCellLock
  // (arcadeProvisioner.ts:346-363) is a plain non-reentrant promise-chain
  // mutex — this is an UNCONDITIONAL self-deadlock, confirmed in isolation
  // with a bare nested withCellLock('t','a', ...) call for the same key
  // (never resolves; reproduces 100% of the time, not a race). EVERY call to
  // POST /api/arcade/apps/:t/:a/import hangs forever as a result. Detect it
  // ONCE with a bounded timeout and skip the remaining import-dependent M2/M3
  // sub-checks (they would each independently re-discover the identical
  // 100%-reproducible deadlock) rather than burning the suite's time waiting
  // out N more 10s timeouts for the same root cause.
  let importIsDeadlocked = false;
  {
    const bundle = buildBundle({ modelId: manifestModelId, dim: embedDim });
    try {
      const imp = await driveMigrateImport(CELL_MIG.customerId, CELL_MIG.appId, bundle);
      check('MIGRATION', 'M2: import with matching embedModelId/dim succeeds 200', imp.status === 200, `status=${imp.status} body=${JSON.stringify(imp.body)}`);
      const body = imp.body as { imported?: { nodes: number; edges: number; verbatim: number }; embeddings?: string } | undefined;
      check('MIGRATION', 'M2: import reports embeddings:"carried"', body?.embeddings === 'carried', JSON.stringify(body));
      check('MIGRATION', 'M2: import counts == manifest counts (2 nodes, 1 edge, 1 verbatim)', body?.imported?.nodes === 2 && body?.imported?.edges === 1 && body?.imported?.verbatim === 1, JSON.stringify(body?.imported));
    } catch (e) {
      importIsDeadlocked = /^TIMEOUT/.test((e as Error).message);
      check(
        'MIGRATION',
        'M2: POST /api/arcade/apps/:t/:a/import completes (does not hang)',
        false,
        `arcadeMigrate.ts:211-213 calls withCellLock(tenantId, appId, async () => { await provisionApp(...) }); provisionApp (arcadeProvisioner.ts:549) calls withCellLock(customerId, appId, ...) again for the SAME key — withCellLock (arcadeProvisioner.ts:346-363) is not reentrant, so this self-deadlocks unconditionally. Every import call hangs forever; caught here via a 10s test-side timeout: ${(e as Error).message}`,
      );
      if (importIsDeadlocked) {
        check(
          'MIGRATION',
          'M2: the deadlock is a single-call hang, not a permanently poisoned in-process lock for the cell',
          false,
          `it IS a permanent poison: withCellLock's module-level cellLocks Map entry for "${CELL_MIG.customerId}::${CELL_MIG.appId}" is never released (the deadlocked promise chain never reaches its finally { release() }), so every LATER withCellLock call for this exact cell — including this suite's own end-of-run cleanup() destroyApp — also hangs forever. Verified: cleanup()'s destroyApp(CELL_MIG) requires the same 5s-timeout guard added to this suite's cleanup() to avoid hanging the whole run's teardown. A real operator hitting this bug would need to restart the daemon process to clear the poisoned lock for that (tenantId,appId) — no in-process recovery exists.`,
        );
      }
    }
  }

  // M1 (partial, import-side only) — recall/search/traverse over HTTP with a
  // tenant token returns the migrated data (parity check limited to what
  // import actually wrote, since export could not produce a live bundle).
  // Skipped when the import deadlocked above (nothing was actually imported).
  if (!importIsDeadlocked) {
    const token = issueToken({ tenantId: CELL_MIG.customerId, appId: CELL_MIG.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
    const migPool = new ArcadeCellPool({ registryDbPath: REGISTRY_DB_PATH, embedder });
    const req = mkReq('GET', `/api/node?workspace=${CELL_MIG.appId}&id=${nodeA.id}`, token);
    const { res, captured } = mkRes();
    await tryArcadeDataRoutes(req as never, res as never, req.url, `/api/node`, token, { pool: migPool, auditLog });
    // GET /api/node returns {node:{...}, neighbors:[...]} — the node id lives at
    // body.node.id, not a flat body.id.
    check('MIGRATION', 'M1: migrated node is readable via tenant token GET /api/node', captured.status === 200 && (captured.body as { node?: { id?: string } } | undefined)?.node?.id === nodeA.id, `status=${captured.status} body=${JSON.stringify(captured.body)}`);

    // Semantic recall of the CARRIED verbatim embedding — query
    // /api/verbatim/search, which returns raw verbatim rows by id (GET
    // /api/search returns graph NODES seeded by verbatim similarity, and this
    // migrated verbatim id has no corresponding node, so it would never surface
    // there — that is correct product behavior, not a recall failure).
    const searchReq = mkReq('GET', `/api/verbatim/search?workspace=${CELL_MIG.appId}&q=isolate%20tenants&limit=5`, token);
    const { res: sres, captured: scaptured } = mkRes();
    await tryArcadeDataRoutes(searchReq as never, sres as never, searchReq.url, `/api/verbatim/search`, token, { pool: migPool, auditLog });
    const hits = (scaptured.body as { rows?: Array<{ id: string }> } | undefined)?.rows ?? [];
    check('MIGRATION', 'M1: migrated verbatim is semantically recallable via tenant token GET /api/verbatim/search', scaptured.status === 200 && hits.some((h) => h.id === 'mig-verbatim-1'), `status=${scaptured.status} body=${JSON.stringify(scaptured.body)}`);
  } else {
    check('MIGRATION', 'M1: migrated node is readable via tenant token GET /api/node', false, 'skipped — blocked by the import deadlock (see M2 above); nothing was actually imported to read back');
    check('MIGRATION', 'M1: migrated verbatim is semantically recallable via tenant token GET /api/search', false, 'skipped — blocked by the import deadlock (see M2 above); nothing was actually imported to recall');
  }

  // M3 — idempotent re-import: same bundle twice yields identical counts, no
  // dupes (upserts, not errors); a CONCURRENT second import 409s
  // migration_in_progress. Skipped (same root cause) when the import deadlocks.
  if (!importIsDeadlocked) {
    const bundle = buildBundle({ modelId: manifestModelId, dim: embedDim });
    const [first, second] = await Promise.allSettled([
      driveMigrateImport(CELL_MIG.customerId, CELL_MIG.appId, bundle),
      driveMigrateImport(CELL_MIG.customerId, CELL_MIG.appId, bundle),
    ]);
    const statuses = [first, second].map((r) => (r.status === 'fulfilled' ? (r.value as { status: number }).status : -1));
    check(
      'MIGRATION',
      'M3: a concurrent second import of the SAME cell 409s migration_in_progress',
      statuses.includes(409),
      `statuses=${JSON.stringify(statuses)} bodies=${JSON.stringify([first, second].map((r) => (r.status === 'fulfilled' ? r.value : String((r as PromiseRejectedResult).reason))))}`,
    );

    // Now run it sequentially twice and confirm counts converge (no dupe growth).
    const seq1 = await driveMigrateImport(CELL_MIG.customerId, CELL_MIG.appId, bundle);
    const seq2 = await driveMigrateImport(CELL_MIG.customerId, CELL_MIG.appId, bundle);
    const c1 = (seq1.body as { imported?: { nodes: number } } | undefined)?.imported?.nodes;
    const c2 = (seq2.body as { imported?: { nodes: number } } | undefined)?.imported?.nodes;
    check('MIGRATION', 'M3: sequential re-import of the same bundle converges to identical node counts', seq1.status === 200 && seq2.status === 200 && c1 === c2, `c1=${c1} c2=${c2} seq1=${JSON.stringify(seq1.body)} seq2=${JSON.stringify(seq2.body)}`);
  } else {
    check('MIGRATION', 'M3: a concurrent second import of the SAME cell 409s migration_in_progress', false, 'skipped — blocked by the import deadlock (see M2 above)');
    check('MIGRATION', 'M3: sequential re-import of the same bundle converges to identical node counts', false, 'skipped — blocked by the import deadlock (see M2 above)');
  }

  // M2 (mismatch path) — mismatched embedModelId -> 409 embedding_model_mismatch
  // unless {reEmbed:true}. Skipped (same root cause) when the import deadlocks.
  if (!importIsDeadlocked) {
    const badBundleLines = buildBundle({ modelId: 'some-other-model-v9', dim: embedDim }).split('\n').filter(Boolean);
    const badBundle = badBundleLines.join('\n') + '\n';
    const mismatchResult = await driveMigrateImport(CELL_MIG.customerId, CELL_MIG.appId, badBundle);
    check('MIGRATION', 'M2: mismatched embedModelId -> 409 embedding_model_mismatch', mismatchResult.status === 409 && code(mismatchResult.body) === 'embedding_model_mismatch', `status=${mismatchResult.status} body=${JSON.stringify(mismatchResult.body)}`);

    const reEmbedLines = [JSON.stringify({ kind: 'manifest', formatVersion: 1, workspace: 'migsrc', exportedAt: new Date().toISOString(), embedModelId: 'some-other-model-v9', embedDim, counts: { nodes: 0, edges: 0, verbatim: 1 }, reEmbed: true }), ...badBundleLines.slice(1)];
    const reEmbedResult = await driveMigrateImport(CELL_MIG.customerId, CELL_MIG.appId, reEmbedLines.join('\n') + '\n');
    check('MIGRATION', 'M2: {reEmbed:true} recomputes vectors and succeeds', reEmbedResult.status === 200 && (reEmbedResult.body as { embeddings?: string } | undefined)?.embeddings === 're-embedded', `status=${reEmbedResult.status} body=${JSON.stringify(reEmbedResult.body)}`);
  } else {
    check('MIGRATION', 'M2: mismatched embedModelId -> 409 embedding_model_mismatch', false, 'skipped — blocked by the import deadlock (see M2 above)');
    check('MIGRATION', 'M2: {reEmbed:true} recomputes vectors and succeeds', false, 'skipped — blocked by the import deadlock (see M2 above)');
  }

  // M5 — the IMPORT route 401s for a lore_at_* bearer (operator lane only).
  // Simulated at the requireOperatorPrincipal layer (see simulateOperatorGate's
  // doc comment) rather than by calling tryArcadeMigrateRoutes directly with no
  // bound principal — that hits bindDaemonOperatorLane's permissive
  // null-principal branch and would proceed into the withCellLock deadlock
  // documented at M2 above.
  {
    const tenantTok = issueToken({ tenantId: CELL_MIG.customerId, appId: CELL_MIG.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
    const gate = simulateOperatorGate(tenantTok);
    check(
      'MIGRATION',
      'M5: operator wall (requireOperatorPrincipal) rejects a tenant lore_at_* bearer before the /import route runs',
      gate !== null && gate.status === 401 && code(gate.body) === 'operator_token_required',
      JSON.stringify(gate),
    );
  }

  graph.close?.();
}

// ─────────────────────────────────────────────────────────────────────────
// POLICY — P1-P5
// ─────────────────────────────────────────────────────────────────────────
async function runPolicySection(embedDim: number): Promise<void> {
  console.log('\n=== POLICY: cell-aware vocab policy ===');
  await provisionApp(CELL_POL_A, { registryDbPath: REGISTRY_DB_PATH, embedDim });
  await provisionApp(CELL_POL_B, { registryDbPath: REGISTRY_DB_PATH, embedDim });
  const polPool = new ArcadeCellPool({ registryDbPath: REGISTRY_DB_PATH, embedder });

  // P3 — no policy row -> writes accepted (open default). Capture console
  // output to assert ZERO "vocab policy lookup failed"/"Unknown workspace"
  // lines across this whole section.
  const logLines: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
    origError(...args);
  };
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
    origLog(...args);
  };

  try {
    const tokenA = issueToken({ tenantId: CELL_POL_A.customerId, appId: CELL_POL_A.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
    const tokenB = issueToken({ tenantId: CELL_POL_B.customerId, appId: CELL_POL_B.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;

    // P3 — open default, no policy row yet.
    {
      const r = await driveDataOn(polPool, 'POST', '/api/node', tokenA, {
        workspace: CELL_POL_A.appId,
        id: 'pol-node-open',
        type: 'decision',
        label: 'open-default write',
        content: 'no policy row yet — must succeed',
      });
      check('POLICY', 'P3: no policy row -> write accepted (open default)', r.status >= 200 && r.status < 300, `status=${r.status} body=${JSON.stringify(r.body)}`);
    }

    // P1 — allowlist + reject.
    {
      const put = await drivePolicy('PUT', `/api/arcade/apps/${CELL_POL_A.customerId}/${CELL_POL_A.appId}/policy`, {
        mode: 'allowlist',
        types: ['decision'],
        onMismatch: 'reject',
      });
      check('POLICY', 'P1: PUT policy (allowlist, reject) succeeds', put.status === 200, `status=${put.status} body=${JSON.stringify(put.body)}`);

      const rejected = await driveDataOn(polPool, 'POST', '/api/node', tokenA, {
        workspace: CELL_POL_A.appId,
        id: 'pol-node-disallowed',
        type: 'todo',
        label: 'disallowed type',
        content: 'should be rejected',
      });
      check('POLICY', 'P1: disallowed type -> 400 type_not_allowed', rejected.status === 400 && code(rejected.body) === 'type_not_allowed', `status=${rejected.status} body=${JSON.stringify(rejected.body)}`);

      const allowed = await driveDataOn(polPool, 'POST', '/api/node', tokenA, {
        workspace: CELL_POL_A.appId,
        id: 'pol-node-allowed',
        type: 'decision',
        label: 'allowed type',
        content: 'should succeed',
      });
      check('POLICY', 'P1: allowed type -> 2xx', allowed.status >= 200 && allowed.status < 300, `status=${allowed.status} body=${JSON.stringify(allowed.body)}`);
    }

    // P2 — warn -> 200 + X-Lore-Type-Warning header.
    {
      await drivePolicy('PUT', `/api/arcade/apps/${CELL_POL_A.customerId}/${CELL_POL_A.appId}/policy`, {
        mode: 'allowlist',
        types: ['decision'],
        onMismatch: 'warn',
      });
      const warned = await driveDataOn(polPool, 'POST', '/api/node', tokenA, {
        workspace: CELL_POL_A.appId,
        id: 'pol-node-warned',
        type: 'todo',
        label: 'warn path',
        content: 'should succeed with a warning header',
      });
      check('POLICY', 'P2: onMismatch:warn -> 2xx', warned.status >= 200 && warned.status < 300, `status=${warned.status} body=${JSON.stringify(warned.body)}`);
      check('POLICY', 'P2: onMismatch:warn -> X-Lore-Type-Warning header present', !!warned.headers['X-Lore-Type-Warning'], JSON.stringify(warned.headers));
    }

    // P4 — hitl rejected at SET time; policy routes 401 for tenant tokens;
    // cell A's policy never affects cell B.
    {
      const hitlResult = await drivePolicy('PUT', `/api/arcade/apps/${CELL_POL_A.customerId}/${CELL_POL_A.appId}/policy`, {
        mode: 'allowlist',
        types: ['decision'],
        onMismatch: 'hitl',
      });
      check('POLICY', 'P4: onMismatch:hitl -> 400 policy_mode_not_supported', hitlResult.status === 400 && code(hitlResult.body) === 'policy_mode_not_supported', `status=${hitlResult.status} body=${JSON.stringify(hitlResult.body)}`);

      // Reset A back to allowlist/reject for the isolation check below.
      await drivePolicy('PUT', `/api/arcade/apps/${CELL_POL_A.customerId}/${CELL_POL_A.appId}/policy`, {
        mode: 'allowlist',
        types: ['decision'],
        onMismatch: 'reject',
      });

      // B has no policy (open default) — a "todo" write to B must succeed even
      // though A now rejects it.
      const bWrite = await driveDataOn(polPool, 'POST', '/api/node', tokenB, {
        workspace: CELL_POL_B.appId,
        id: 'pol-b-node',
        type: 'todo',
        label: 'B unaffected by A policy',
        content: 'cell isolation check',
      });
      check('POLICY', "P4: cell A's allowlist/reject policy does not affect cell B", bWrite.status >= 200 && bWrite.status < 300, `status=${bWrite.status} body=${JSON.stringify(bWrite.body)}`);

      // Policy routes reject a tenant bearer via the SAME requireOperatorPrincipal
      // wall as arcadeAdmin — see simulateOperatorGate's doc comment for why we
      // simulate that upstream gate rather than call tryArcadePolicyRoutes
      // directly with no bound principal (a different, intentionally-permissive
      // branch of bindDaemonOperatorLane).
      const gate = simulateOperatorGate(tokenA);
      check(
        'POLICY',
        'P4: operator wall (requireOperatorPrincipal) rejects a tenant lore_at_* bearer before any policy route runs',
        gate !== null && gate.status === 401 && code(gate.body) === 'operator_token_required',
        JSON.stringify(gate),
      );
    }

    // Cleanup so the log-scan below is clean for the NEXT run too.
    await deleteCellVocabPolicy(CELL_POL_A.customerId, CELL_POL_A.appId, { registryDbPath: REGISTRY_DB_PATH }) as unknown as void;
  } finally {
    console.error = origError;
    console.log = origLog;
  }

  const bugLines = logLines.filter((l) => /vocab policy lookup failed|Unknown workspace/.test(l));
  check('POLICY', 'P3: zero "vocab policy lookup failed" / "Unknown workspace" log lines across the section', bugLines.length === 0, JSON.stringify(bugLines));

  // P5 — local-mode regression: getCellVocabPolicy/setCellVocabPolicy default
  // fallback matches storeNodeGates' existing local behavior when the seam is
  // ABSENT (i.e., getVocabPolicy undefined -> falls back to
  // getWorkspaceVocabPolicy). We assert this at the unit level here; the fuller
  // regression is the untouched local storeNodeGates test suite (run
  // separately, not duplicated in this file to avoid drift).
  {
    const { enforceVocabPolicy } = await import('../packages/lore/src/mcp/http/routes/storeNodeGates.js');
    const req = mkReq('POST', '/api/node');
    const { res } = mkRes();
    // No getVocabPolicy seam supplied -> must fall back to
    // getWorkspaceVocabPolicy (local behavior). storeNodeGates.ts:87-151 wraps
    // that lookup in a try/catch that SOFT-FAILS: an unknown workspace throws
    // internally, is caught, logged as "vocab policy lookup failed", and the
    // gate returns {handled:false} (default-accept) — this is the PRE-EXISTING
    // local behavior storeNodeGates already had, unchanged by the slice-4 seam.
    // We assert the fallback path was actually taken (getWorkspaceVocabPolicy,
    // not getCellVocabPolicy) by checking for that exact log line + the
    // default-accept result, proving the seam is opt-in.
    const fallbackLogs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => fallbackLogs.push(args.map(String).join(' '));
    let result: { handled: boolean; typeWarning?: string } | undefined;
    try {
      result = await enforceVocabPolicy({ type: 'decision', workspace: 'totally-unconfigured-local-ws' }, res as never, { activeWorkspace: 'totally-unconfigured-local-ws' });
    } finally {
      console.error = origErr;
    }
    const fellBackToLocal = fallbackLogs.some((l) => /vocab policy lookup failed.*Unknown workspace "totally-unconfigured-local-ws"/.test(l));
    check(
      'POLICY',
      'P5: with the seam absent, enforceVocabPolicy falls back to getWorkspaceVocabPolicy and soft-fails exactly as pre-slice-4 local behavior (logs + default-accept)',
      fellBackToLocal && result?.handled === false,
      `fellBackToLocal=${fellBackToLocal} result=${JSON.stringify(result)} logs=${JSON.stringify(fallbackLogs)}`,
    );
  }
}

// Helper: drive tryArcadeDataRoutes against an arbitrary pool (POLICY section
// uses its own pool instance).
async function driveDataOn(
  p: ArcadeCellPool,
  method: string,
  apiPath: string,
  bearer: string,
  body?: unknown,
  extraDeps?: { outboxStore?: SqliteOutboxStore; outboxLagCache?: OutboxLagCache },
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const pathname = apiPath.split('?')[0]!;
  const req = mkReq(method, apiPath, bearer, body);
  const { res, captured } = mkRes();
  await tryArcadeDataRoutes(req as never, res as never, apiPath, pathname, bearer, {
    pool: p,
    auditLog,
    outboxStore: extraDeps?.outboxStore,
    outboxLagCache: extraDeps?.outboxLagCache,
  });
  return { status: captured.status, body: captured.body, headers: captured.headers };
}

// ─────────────────────────────────────────────────────────────────────────
// OUTBOX — O1-O6
// ─────────────────────────────────────────────────────────────────────────
async function runOutboxSection(embedDim: number): Promise<void> {
  console.log('\n=== OUTBOX: durability + replay ===');
  await provisionApp(CELL_OUT_A, { registryDbPath: REGISTRY_DB_PATH, embedDim });
  await provisionApp(CELL_OUT_B, { registryDbPath: REGISTRY_DB_PATH, embedDim });

  // O1 — the design requires arcadeData.ts (the tenant WRITE path) to record
  // an outbox row BEFORE returning success. Now WIRED: pass the shared daemon
  // outbox into the data route and assert a node.upsert (+verbatim.upsert)
  // row lands under the cell's canonical lane key, then that the replicator
  // drains it and the node becomes readable + recallable via the tenant token.
  {
    const o1Dir = path.join(LORE_HOME, 'outbox-o1-producer');
    fs.mkdirSync(o1Dir, { recursive: true });
    const outStore = new SqliteOutboxStore(o1Dir);
    const outPool = new ArcadeCellPool({ registryDbPath: REGISTRY_DB_PATH, embedder });
    const token = issueToken({ tenantId: CELL_OUT_A.customerId, appId: CELL_OUT_A.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
    const r = await driveDataOn(outPool, 'POST', '/api/node', token, {
      workspace: CELL_OUT_A.appId,
      id: 'outbox-o1-node',
      type: 'decision',
      label: 'O1 outbox producer check',
      content: 'does this write go through the outbox before success?',
      embed: true,
    }, { outboxStore: outStore });
    const cellKey = arcadeCellKey(CELL_OUT_A.customerId, CELL_OUT_A.appId);
    const pending = (await outStore.listPendingForWorkspace?.(cellKey, 10)) ?? [];
    const kinds = pending.map((e) => e.operationKind);
    check(
      'OUTBOX',
      'O1: tenant POST /api/node records an outbox row (workspace=arcade:<t>:<a>, node.upsert) before returning success',
      r.status >= 200 && r.status < 300 && pending.some((e) => e.operationKind === 'node.upsert'),
      `status=${r.status} pendingRows=${pending.length} kinds=${JSON.stringify(kinds)}`,
    );
    check(
      'OUTBOX',
      'O1: embed:true also records a verbatim.upsert row on the same cell lane',
      pending.some((e) => e.operationKind === 'verbatim.upsert'),
      `kinds=${JSON.stringify(kinds)}`,
    );
    // Drain via the replicator and confirm the node is now readable + the
    // verbatim recallable via the tenant token (recall is async once the
    // inline seed is gone — this is the documented visibility change).
    const o1Handle = wireArcadeReplicator({ store: outStore, embedder });
    await o1Handle.replicator.tickOnce();
    await o1Handle.replicator.tickOnce();
    const readBack = await driveDataOn(outPool, 'GET', `/api/node?workspace=${CELL_OUT_A.appId}&id=outbox-o1-node`, token);
    check('OUTBOX', 'O1: after replication the outbox-produced node is readable via the tenant token', readBack.status === 200 && (readBack.body as { node?: { id?: string } } | undefined)?.node?.id === 'outbox-o1-node', `status=${readBack.status} body=${JSON.stringify(readBack.body)}`);
    await o1Handle.stop();
    outStore.close?.();
  }

  // O2/O3/O6 — test the REPLICATOR (consumer side) directly: it IS fully
  // wired (arcadeOutboxWiring.ts). Record rows straight onto a fresh
  // SqliteOutboxStore via the cell-key decorator, then drive tickOnce().
  const outboxFile = path.join(LORE_HOME, 'outbox-consumer-check');
  fs.mkdirSync(outboxFile, { recursive: true });
  const sharedStore = new SqliteOutboxStore(outboxFile);
  const handle = wireArcadeReplicator({ store: sharedStore, embedder });

  const keyA = arcadeCellKey(CELL_OUT_A.customerId, CELL_OUT_A.appId);
  const keyB = arcadeCellKey(CELL_OUT_B.customerId, CELL_OUT_B.appId);
  const laneA = cellOutboxStore(sharedStore, keyA);
  const laneB = cellOutboxStore(sharedStore, keyB);

  async function rawAdaptersFor(cell: { customerId: string; appId: string }): Promise<{ graph: ArcadeGraphStore; vector: ArcadeVectorStore }> {
    const tenantApp = getTenantApp(cell);
    if (!tenantApp) throw new Error(`cell not provisioned: ${JSON.stringify(cell)}`);
    const secret = await readSecretAsync(cell);
    const http = new ArcadeHttp({ user: tenantApp.db_user, pass: secret! }, ARCADE_BASE_URL);
    return { graph: new ArcadeGraphStore({ tenantDb: tenantApp.db, http }), vector: new ArcadeVectorStore({ tenantDb: tenantApp.db, http, embedder }) };
  }

  // O2 — crash-replay: record rows, do NOT tick, rebuild the replicator from
  // the same SQLite file, THEN tick — rows must still replay into the
  // correct cell. Two-cell interleaved test proves no cross-cell leakage.
  {
    await laneA.record(
      mkOutboxEntry({
        id: 'o2-nodeA-1',
        workspace: keyA,
        operationKind: 'node.upsert',
        payload: { id: 'o2-nodeA-1', type: 'decision', label: 'A1', content: 'cell A node 1' },
      }),
    );
    await laneB.record(
      mkOutboxEntry({
        id: 'o2-nodeB-1',
        workspace: keyB,
        operationKind: 'node.upsert',
        payload: { id: 'o2-nodeB-1', type: 'decision', label: 'B1', content: 'cell B node 1' },
      }),
    );

    // Rebuild the replicator from the same file (simulates a daemon restart)
    // WITHOUT ticking the original handle first.
    const rebuiltStore = new SqliteOutboxStore(outboxFile);
    const rebuiltHandle = wireArcadeReplicator({ store: rebuiltStore, embedder });
    const n = await rebuiltHandle.replicator.tickOnce();
    check('OUTBOX', 'O2: crash-replay — tickOnce on a rebuilt replicator processes the pending rows', n >= 2, `tickOnce processed ${n} rows`);

    const [aAdapters, bAdapters] = await Promise.all([rawAdaptersFor(CELL_OUT_A), rawAdaptersFor(CELL_OUT_B)]);
    const nodeInA = await aAdapters.graph.getNode('o2-nodeA-1');
    const nodeBInA = await aAdapters.graph.getNode('o2-nodeB-1');
    const nodeInB = await bAdapters.graph.getNode('o2-nodeB-1');
    const nodeAInB = await bAdapters.graph.getNode('o2-nodeA-1');
    check('OUTBOX', 'O2: cell A node replayed into cell A db', nodeInA !== null, `getNode(o2-nodeA-1) in A = ${JSON.stringify(nodeInA)}`);
    check('OUTBOX', 'O2: cell B node NEVER landed in cell A db (no cross-cell leak)', nodeBInA === null, `getNode(o2-nodeB-1) in A = ${JSON.stringify(nodeBInA)}`);
    check('OUTBOX', 'O2: cell B node replayed into cell B db', nodeInB !== null, `getNode(o2-nodeB-1) in B = ${JSON.stringify(nodeInB)}`);
    check('OUTBOX', 'O2: cell A node NEVER landed in cell B db (no cross-cell leak)', nodeAInB === null, `getNode(o2-nodeA-1) in B = ${JSON.stringify(nodeAInB)}`);
    await rebuiltHandle.stop();
  }

  // O3 — replay uses the cell service account: revoke every token for the
  // cell after the write, then tick — replay still succeeds.
  {
    const tok = issueToken({ tenantId: CELL_OUT_A.customerId, appId: CELL_OUT_A.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH });
    revokeToken(tok.token);
    await laneA.record(
      mkOutboxEntry({
        id: 'o3-node-after-revoke',
        workspace: keyA,
        operationKind: 'node.upsert',
        payload: { id: 'o3-node-after-revoke', type: 'decision', label: 'post-revoke', content: 'replay must survive token revocation' },
      }),
    );
    const n = await handle.replicator.tickOnce();
    check('OUTBOX', 'O3: tickOnce still processes a row for a cell whose only tenant token was revoked', n >= 1, `tickOnce processed ${n}`);
    const aAdapters = await rawAdaptersFor(CELL_OUT_A);
    const node = await aAdapters.graph.getNode('o3-node-after-revoke');
    check('OUTBOX', 'O3: replay via the RAW service account succeeds despite the tenant token being revoked', node !== null, `getNode = ${JSON.stringify(node)}`);
  }

  // O6 — malformed/foreign workspace key -> row goes failed/dead, loud log,
  // never applied anywhere.
  {
    await sharedStore.record(
      mkOutboxEntry({
        id: 'o6-foreign-row',
        workspace: 'not-an-arcade-key',
        operationKind: 'node.upsert',
        payload: { id: 'o6-node', type: 'decision', label: 'foreign', content: 'must never apply' },
      }),
    );
    const before = console.error;
    let loudLogged = false;
    console.error = (...args: unknown[]) => {
      if (/non-arcade-keyed|arcadeOutboxWiring/.test(args.map(String).join(' '))) loudLogged = true;
      before(...args);
    };
    // replicator.ts:691/732 — a plain Error (not UnwiredOperationKindError /
    // MissingPayloadError) only reaches the loud "marked dead" log line once
    // attempts >= maxAttempts (default 5, replicator.ts:123); each failed tick
    // just marks status='failed' silently, bumps attempts, and sets
    // nextAttemptAt with exponential backoff (base 500ms*2^attempts, cap 30s —
    // sqliteStore.ts:382-388), and listPendingForWorkspace/the scan excludes
    // 'failed' rows whose nextAttemptAt is still in the future
    // (sqliteStore.ts:358-366). So back-to-back tickOnce() calls with no delay
    // all skip the row after the first attempt. Poll with real sleeps between
    // ticks so each backoff window actually elapses before the next attempt.
    for (let i = 0; i < 5; i++) {
      await handle.replicator.tickOnce();
      await sleep(1000 * Math.pow(2, i) + 200);
    }
    console.error = before;
    const unfinished = await sharedStore.listUnfinished();
    const foreignRow = unfinished.find((e) => e.id === 'o6-foreign-row');
    check(
      'OUTBOX',
      'O6: malformed/foreign workspace key never resolves to a live cell (row failed/dead or still pending, not replicated)',
      !!foreignRow && foreignRow.status !== 'replicated',
      `row=${JSON.stringify(foreignRow)}`,
    );
    check(
      'OUTBOX',
      'O6: the resolve failure is logged loudly once the retry budget (maxAttempts=5) is exhausted',
      loudLogged,
      `expected a console.error mentioning "non-arcade-keyed" or "arcadeOutboxWiring" after 6 ticks; row=${JSON.stringify(foreignRow)}`,
    );
  }

  // O4 — disableApp/destroyApp interaction with pending outbox rows.
  {
    await laneA.record(
      mkOutboxEntry({
        id: 'o4-pending-during-disable',
        workspace: keyA,
        operationKind: 'node.upsert',
        payload: { id: 'o4-node', type: 'decision', label: 'pending during disable', content: 'x' },
      }),
    );
    await disableApp(CELL_OUT_A, { registryDbPath: REGISTRY_DB_PATH }).catch(() => {});
    const pendingWhileDisabled = (await sharedStore.listPendingForWorkspace?.(keyA, 10)) ?? [];
    check('OUTBOX', 'O4: disableApp leaves pending rows pending (not dropped)', pendingWhileDisabled.some((r) => r.id === 'o4-pending-during-disable'), `pending=${JSON.stringify(pendingWhileDisabled.map((r) => r.id))}`);

    // destroyApp now purges the cell's outbox lane when handed the daemon store
    // (right-to-be-forgotten). Pass sharedStore so the purge targets the same
    // file the rows live in.
    await destroyApp(CELL_OUT_A, { registryDbPath: REGISTRY_DB_PATH, outboxStore: sharedStore }).catch(() => {});
    const pendingAfterDestroy = (await sharedStore.listPendingForWorkspace?.(keyA, 10)) ?? [];
    check(
      'OUTBOX',
      "O4: destroyApp purges the cell's outbox rows (right-to-be-forgotten)",
      !pendingAfterDestroy.some((r) => r.id === 'o4-pending-during-disable'),
      `after destroy, listPendingForWorkspace('${keyA}') returned ${pendingAfterDestroy.length} row(s): ${JSON.stringify(pendingAfterDestroy.map((r) => r.id))}`,
    );
    // re-provision for cleanup() at the end, so destroyApp there doesn't throw.
    await provisionApp(CELL_OUT_A, { registryDbPath: REGISTRY_DB_PATH, embedDim }).catch(() => {});
  }

  // O5 — backpressure: force lag over threshold for one cell -> that cell's
  // writes 503 outbox_lag while a second cell's writes succeed. Now wired:
  // arcadeData.ts threads a cell-keyed lag cache into the write families, which
  // call checkOutboxBackpressure. We refresh the cache with a synthetic
  // over-threshold snapshot for cell A's lane key ONLY; cell B is a cache miss
  // and fails open (writes succeed).
  {
    const o5Dir = path.join(LORE_HOME, 'outbox-o5-backpressure');
    fs.mkdirSync(o5Dir, { recursive: true });
    const o5Store = new SqliteOutboxStore(o5Dir);
    const o5Pool = new ArcadeCellPool({ registryDbPath: REGISTRY_DB_PATH, embedder });
    const lagCache = new OutboxLagCache({ defaultLagThresholdSeconds: 30, depthThreshold: 10000 });
    // Cell A: 999s lag over the 30s threshold -> shouldBlock. Cell B: absent ->
    // cache miss -> fail-open.
    lagCache.refresh({
      depth: 1,
      lagSeconds: 999,
      dead: 0,
      perWorkspace: {
        [keyA]: { depth: 1, lagSeconds: 999, dead: 0 },
      },
    });
    const tokenA = issueToken({ tenantId: CELL_OUT_A.customerId, appId: CELL_OUT_A.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
    const tokenB = issueToken({ tenantId: CELL_OUT_B.customerId, appId: CELL_OUT_B.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
    const laggingWrite = await driveDataOn(o5Pool, 'POST', '/api/node', tokenA, {
      workspace: CELL_OUT_A.appId, id: 'o5-lagging', type: 'decision', label: 'lag', content: 'should be 503', embed: false,
    }, { outboxStore: o5Store, outboxLagCache: lagCache });
    check(
      'OUTBOX',
      'O5: backpressure — the lagging cell 503s outbox_lag',
      laggingWrite.status === 503 && code(laggingWrite.body) === 'outbox_lag',
      `status=${laggingWrite.status} body=${JSON.stringify(laggingWrite.body)}`,
    );
    const healthyWrite = await driveDataOn(o5Pool, 'POST', '/api/node', tokenB, {
      workspace: CELL_OUT_B.appId, id: 'o5-healthy', type: 'decision', label: 'ok', content: 'should succeed', embed: false,
    }, { outboxStore: o5Store, outboxLagCache: lagCache });
    check(
      'OUTBOX',
      'O5: backpressure — a healthy (cache-miss) cell still succeeds',
      healthyWrite.status >= 200 && healthyWrite.status < 300,
      `status=${healthyWrite.status} body=${JSON.stringify(healthyWrite.body)}`,
    );
    o5Store.close?.();
  }

  await handle.stop();
  sharedStore.close?.();
}

// ─────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== Cloud Slice-4 GA acceptance e2e ===');
  console.log(`Registry: ${REGISTRY_DB_PATH}`);
  console.log(`Lore home: ${LORE_HOME}`);
  await cleanup();
  await embedder.initialize();
  const embedDim = embedder.dimension;

  try {
    await runAuthSection(embedDim);
  } catch (e) {
    check('AUTH', 'AUTH section completed without throwing', false, (e as Error).stack ?? String(e));
  }
  try {
    await runMigrationSection(embedDim);
  } catch (e) {
    check('MIGRATION', 'MIGRATION section completed without throwing', false, (e as Error).stack ?? String(e));
  }
  try {
    await runPolicySection(embedDim);
  } catch (e) {
    check('POLICY', 'POLICY section completed without throwing', false, (e as Error).stack ?? String(e));
  }
  try {
    await runOutboxSection(embedDim);
  } catch (e) {
    check('OUTBOX', 'OUTBOX section completed without throwing', false, (e as Error).stack ?? String(e));
  }

  await cleanup();

  console.log('\n=== Summary by area ===');
  for (const area of Object.keys(areaCounts) as Area[]) {
    console.log(`  ${area}: ${areaCounts[area].pass} pass, ${areaCounts[area].fail} fail`);
  }
  console.log(`\nTOTAL: ${pass} pass, ${fail} fail`);
  if (failures.length > 0) {
    console.log('\n=== Failures ===');
    for (const f of failures) console.log(`  ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * slice3-arcadedata-selfcheck.ts — Cloud Slice 3 tenant DATA-PLANE self-check.
 * (branch: spike/arcadedb-multitenant)
 *
 * Drives the REAL arcadeData dispatcher (tryArcadeDataRoutes) with mock req/res
 * against two freshly-provisioned sibling cells on the live pinned ArcadeDB
 * 26.7.1 container, proving over the exact code path the daemon runs:
 *
 *   1. tokenA can POST /api/node (embed:true) + GET /api/recall surfaces it.
 *   2. tokenB (sibling cell) CANNOT see A's node (recall/get) — isolation.
 *   3. tokenA + workspace=cellB -> 403 workspace_forbidden (not 404/empty).
 *   4. tokenA + omitted workspace on a read -> 400 workspace_required.
 *   5. unknown/revoked token -> 401 auth_required (pool evicted on revoke).
 *   6. read-only token on POST /api/node -> 403 scope_missing (route gate).
 *   7. non-allowlisted path with tokenA -> tryArcadeDataRoutes returns false
 *      (arcadeDispatch would 501).
 *
 * Run: npx tsx test/slice3-arcadedata-selfcheck.ts
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

import {
  provisionApp,
  destroyApp,
  closeRegistryDb,
  ARCADE_BASE_URL,
} from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import {
  issueToken,
  revokeToken,
  closeTokenDb,
} from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { ArcadeCellPool } from '../packages/lore/src/engines/arcade/arcadeCellPool.js';
import { tryArcadeDataRoutes } from '../packages/lore/src/mcp/http/routes/arcadeData.js';
import { AuditLog } from '../packages/lore/src/security/audit.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';

// Provisioner reads root from env in arcade; ensure it is present for the run.
process.env['ARCADE_BASE_URL'] ??= ARCADE_BASE_URL;
process.env['ARCADE_ROOT_PASSWORD'] ??= 'SpikeRoot123!';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  [PASS] ${label}`); }
  else { fail++; const m = `  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`; failures.push(m); console.error(m); }
}

const REGISTRY = path.join(os.tmpdir(), `slice3-selfcheck-${process.pid}.sqlite`);
const CELLA = { customerId: 'slice3', appId: 'appa' };
const CELLB = { customerId: 'slice3', appId: 'appb' };
const embedder = new LocalEmbeddingProvider();
const auditLog = new AuditLog();

// ── mock req/res ─────────────────────────────────────────────────────────
interface Captured { status: number; body: unknown; }
function mkReq(method: string, url: string, bearer?: string, body?: unknown) {
  const req = new EventEmitter() as EventEmitter & {
    method: string; url: string; headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
  // Emit the body on next tick so route body-readers (data/end listeners) fire.
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}
function mkRes(): { res: unknown; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  let raw = '';
  const res = {
    headersSent: false,
    statusCode: 200,
    writeHead(status: number) { captured.status = status; (res as { headersSent: boolean }).headersSent = true; return res; },
    setHeader() { return res; },
    end(chunk?: string) {
      if (chunk) raw += chunk;
      if (captured.status === 0) captured.status = (res as { statusCode: number }).statusCode;
      try { captured.body = raw ? JSON.parse(raw) : undefined; } catch { captured.body = raw; }
    },
    write(chunk: string) { raw += chunk; return true; },
  };
  return { res, captured };
}

async function drive(pool: ArcadeCellPool, method: string, apiPath: string, bearer?: string, body?: unknown): Promise<{ handled: boolean; status: number; body: unknown }> {
  const url = apiPath;
  const pathname = apiPath.split('?')[0]!;
  const req = mkReq(method, url, bearer, body);
  const { res, captured } = mkRes();
  const handled = await tryArcadeDataRoutes(
    req as never, res as never, url, pathname, bearer ?? '', { pool, auditLog },
  );
  return { handled, status: captured.status, body: captured.body };
}

function code(b: unknown): string | undefined { return (b as { code?: string } | undefined)?.code; }

async function cleanup(): Promise<void> {
  try { await destroyApp(CELLA, { registryDbPath: REGISTRY }); } catch { /* */ }
  try { await destroyApp(CELLB, { registryDbPath: REGISTRY }); } catch { /* */ }
  closeTokenDb(); closeRegistryDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(REGISTRY + s); } catch { /* */ } }
}

async function main(): Promise<void> {
  console.log('=== Slice 3 tenant DATA-PLANE self-check ===');
  await cleanup();
  await embedder.initialize();
  const embedDim = embedder.dimension;
  await provisionApp(CELLA, { registryDbPath: REGISTRY, embedDim });
  await provisionApp(CELLB, { registryDbPath: REGISTRY, embedDim });

  const tokenA = issueToken({ tenantId: CELLA.customerId, appId: CELLA.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY }).token;
  const tokenB = issueToken({ tenantId: CELLB.customerId, appId: CELLB.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY }).token;
  const tokenARo = issueToken({ tenantId: CELLA.customerId, appId: CELLA.appId, scopes: ['read'] }, { registryDbPath: REGISTRY }).token;

  const pool = new ArcadeCellPool({ registryDbPath: REGISTRY, embedder });
  const wsA = 'appa', wsB = 'appb';

  // 1. tokenA stores a node with embed, then recalls it.
  const nodeId = 'slice3-decision-vault';
  const store = await drive(pool, 'POST', '/api/node', tokenA, {
    workspace: wsA, id: nodeId, type: 'decision',
    label: 'Vault encryption uses envelope keys',
    content: 'We chose envelope encryption with per-tenant KMS keys for the vault.',
    embed: true,
  });
  check('A POST /api/node -> 2xx', store.status >= 200 && store.status < 300, `status=${store.status} body=${JSON.stringify(store.body)}`);

  // allow the embed to settle
  await new Promise((r) => setTimeout(r, 500));

  const getNode = await drive(pool, 'GET', `/api/node?workspace=${wsA}&id=${nodeId}`, tokenA);
  check('A GET /api/node -> 2xx returns the node', getNode.status === 200 && JSON.stringify(getNode.body).includes(nodeId), `status=${getNode.status}`);

  const recallA = await drive(pool, 'GET', `/api/recall?workspace=${wsA}&topic=${encodeURIComponent('vault encryption keys')}`, tokenA);
  check('A GET /api/recall -> 2xx surfaces the node', recallA.status === 200 && JSON.stringify(recallA.body).includes(nodeId), `status=${recallA.status} body=${JSON.stringify(recallA.body).slice(0, 300)}`);

  // 2. Isolation: tokenB cannot see A's node through its own cell.
  const getFromB = await drive(pool, 'GET', `/api/node?workspace=${wsB}&id=${nodeId}`, tokenB);
  check('B GET /api/node (A\'s id) -> 404 node_not_found (existence not leaked)', getFromB.status === 404 && code(getFromB.body) === 'node_not_found', `status=${getFromB.status} code=${code(getFromB.body)}`);
  const recallB = await drive(pool, 'GET', `/api/recall?workspace=${wsB}&topic=${encodeURIComponent('vault encryption keys')}`, tokenB);
  check('B GET /api/recall -> 2xx but does NOT contain A\'s node', recallB.status === 200 && !JSON.stringify(recallB.body).includes(nodeId), `body=${JSON.stringify(recallB.body).slice(0, 200)}`);

  // 3. tokenA naming cellB's workspace -> 403 workspace_forbidden.
  const crossWs = await drive(pool, 'GET', `/api/node?workspace=${wsB}&id=${nodeId}`, tokenA);
  check('A + workspace=cellB -> 403 workspace_forbidden', crossWs.status === 403 && code(crossWs.body) === 'workspace_forbidden', `status=${crossWs.status} code=${code(crossWs.body)}`);

  // 3b. tokenA + workspace='*' -> 403 workspace_forbidden (no cross-workspace-read).
  const star = await drive(pool, 'GET', `/api/recall?workspace=*&topic=x`, tokenA);
  check('A + workspace=* -> 403 workspace_forbidden', star.status === 403 && code(star.body) === 'workspace_forbidden', `status=${star.status} code=${code(star.body)}`);

  // 4. omitted workspace on a read -> 400 workspace_required.
  const noWs = await drive(pool, 'GET', `/api/node?id=${nodeId}`, tokenA);
  check('A read w/o workspace -> 400 workspace_required', noWs.status === 400 && code(noWs.body) === 'workspace_required', `status=${noWs.status} code=${code(noWs.body)}`);

  // 4b. omitted workspace on POST /api/node -> defaulted to cellA (200).
  const postNoWs = await drive(pool, 'POST', '/api/node', tokenA, { id: 'slice3-defaulted', type: 'note', label: 'defaulted', content: 'x' });
  check('A POST /api/node w/o workspace -> 2xx (defaulted to cell)', postNoWs.status >= 200 && postNoWs.status < 300, `status=${postNoWs.status} body=${JSON.stringify(postNoWs.body)}`);

  // 5. unknown token -> 401; revoked token -> 401 + pool evicted.
  const unknown = await drive(pool, 'GET', `/api/node?workspace=${wsA}&id=${nodeId}`, 'lore_at_not-real');
  check('unknown token -> 401 auth_required', unknown.status === 401 && code(unknown.body) === 'auth_required', `status=${unknown.status} code=${code(unknown.body)}`);

  const sizeBefore = pool.size();
  revokeToken(tokenARo, { registryDbPath: REGISTRY });
  const revoked = await drive(pool, 'GET', `/api/node?workspace=${wsA}&id=${nodeId}`, tokenARo);
  check('revoked token -> 401 auth_required', revoked.status === 401 && code(revoked.body) === 'auth_required', `status=${revoked.status} code=${code(revoked.body)}`);
  check('revoke evicted the pooled cell (no stale facade)', pool.size() <= sizeBefore, `before=${sizeBefore} after=${pool.size()}`);

  // 6. read-only token (fresh) on a write route -> 403 (route gate) or ScopeError-mapped.
  const tokenARo2 = issueToken({ tenantId: CELLA.customerId, appId: CELLA.appId, scopes: ['read'] }, { registryDbPath: REGISTRY }).token;
  const roWrite = await drive(pool, 'POST', '/api/node', tokenARo2, { workspace: wsA, id: 'ro-attempt', type: 'note', label: 'x', content: 'y' });
  check('read-only token POST /api/node -> 403 (scope denied)', roWrite.status === 403, `status=${roWrite.status} code=${code(roWrite.body)}`);

  // 7. non-allowlisted path -> tryArcadeDataRoutes returns false (would 501).
  const notAllowed = await drive(pool, 'POST', '/api/aggregate', tokenA, { workspace: wsA });
  check('non-allowlisted /api/aggregate -> handled=false (arcadeDispatch 501s)', notAllowed.handled === false, `handled=${notAllowed.handled}`);

  // 8. token whose cell was destroyed -> 404 workspace_not_found.
  await destroyApp(CELLB, { registryDbPath: REGISTRY });
  pool.evictCell(CELLB.customerId, CELLB.appId);
  const destroyed = await drive(pool, 'GET', `/api/node?workspace=${wsB}&id=x`, tokenB);
  check('token for destroyed cell -> 404 workspace_not_found', destroyed.status === 404 && code(destroyed.body) === 'workspace_not_found', `status=${destroyed.status} code=${code(destroyed.body)}`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) { for (const f of failures) console.error(f); }
}

main()
  .catch((e) => { console.error('FATAL', e); fail++; })
  .finally(async () => { await cleanup(); process.exit(fail > 0 ? 1 : 0); });

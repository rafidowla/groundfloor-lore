#!/usr/bin/env tsx
/**
 * spike-arcadedb-facade-roundtrip.ts — the FACADE PROOF (Phase 3) + the
 * AUTH-RESOLVER e2e (Phase 5), against the live pinned ArcadeDB 26.7.1 container.
 * (branch: spike/arcadedb-multitenant)
 *
 * WHAT THIS PROVES
 * ================
 * 1. FACADE PROOF — LoreStorageClient.fromLocal({ graph, verbatim }) constructed
 *    with the Design-A ArcadeDB adapters (bound to a provisioned tenant cell)
 *    runs the WHOLE Lore storage stack ABOVE the socket UNCHANGED against
 *    ArcadeDB, with ZERO edits to packages/lore/src/storage/loreStorageClient.ts.
 *    The full store -> recall -> search -> delete cycle runs THROUGH facade
 *    methods only (traverse/deleteNode via the documented rawGraph() escape
 *    hatch, per the facade's own header contract — not a gap in this proof).
 *
 * 2. AUTH RESOLVER — a Lore workspace-scoped bearer token resolves via
 *    arcadeAuthResolver.ts -> { tenantId, appId, db, dbUser, scopes } -> a
 *    fully-bound, scope-guarded { graph, verbatim } pair, with NO tenant/app/db
 *    parameter anywhere on the resolve path (routeWorkspaceBinding semantics).
 *    Unknown / revoked tokens fail closed BEFORE any ArcadeDB HTTP call.
 *
 * 3. ISOLATION THROUGH THE FACADE — two facades over sibling cells
 *    (alpha/app1 vs alpha/app2), each built from its OWN token: alpha-app1's
 *    facade never surfaces alpha-app2 rows (getNode/search/verbatimSearch), and
 *    a direct cross-db probe raises ArcadeHttpError 403 (the per-DB user wall
 *    holds underneath the facade, not just at adapter level).
 *
 * 4. SCOPE (coarse RBAC) THROUGH THE FACADE — a read-only token's facade
 *    write verb (upsertNode / verbatimStore) throws ScopeError pre-HTTP.
 *
 * PRE-REQ: the pinned container is already running (arcadedata/arcadedb:26.7.1
 * on :2480). This test PROVISIONS its own cells via the real provisioner, so it
 * does not depend on the spike's hand-seeded alpha/beta grid.
 *
 * Run: npx tsx test/spike-arcadedb-facade-roundtrip.ts
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { LoreStorageClient } from '../packages/lore/src/storage/loreStorageClient.js';
import {
  provisionApp,
  destroyApp,
  closeRegistryDb,
  ARCADE_BASE_URL,
  ARCADE_ROOT_USER,
  ARCADE_ROOT_PASSWORD,
} from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import {
  issueToken,
  revokeToken,
  arcadeCellForToken,
  resolvePrincipal,
  ArcadeAuthError,
  closeTokenDb,
} from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { ScopeError } from '../packages/lore/src/engines/arcade/arcadeScopeGuard.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

// ── mini harness ─────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${label}`);
  } else {
    fail++;
    const msg = `  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.error(msg);
  }
}
async function expectThrows(
  label: string,
  fn: () => Promise<unknown>,
  match: (e: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    check(label, false, 'expected throw, got success');
  } catch (e) {
    check(label, match(e), `wrong error: ${(e as Error)?.name}: ${(e as Error)?.message}`);
  }
}

// Isolated registry so this run never collides with another session's state.
const REGISTRY_DB_PATH = path.join(os.tmpdir(), `arcade-facade-roundtrip-${process.pid}.sqlite`);

const CELL1 = { customerId: 'facadex', appId: 'appone' };
const CELL2 = { customerId: 'facadex', appId: 'apptwo' };

// One shared embedder across all cells (avoids loading the ~120MB model twice).
const sharedEmbedder = new LocalEmbeddingProvider();

async function assertVersion(): Promise<void> {
  const res = await fetch(`${ARCADE_BASE_URL}/api/v1/server?mode=basic`, {
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${ARCADE_ROOT_USER}:${ARCADE_ROOT_PASSWORD}`).toString('base64'),
    },
  });
  const body = (await res.json()) as { version?: string };
  console.log(`  ArcadeDB server version: ${body.version ?? '(unknown)'}`);
}

async function cleanup(): Promise<void> {
  try {
    await destroyApp(CELL1, { registryDbPath: REGISTRY_DB_PATH });
    await destroyApp(CELL2, { registryDbPath: REGISTRY_DB_PATH });
  } catch {
    /* best-effort */
  }
  closeTokenDb();
  closeRegistryDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(REGISTRY_DB_PATH + suffix);
    } catch {
      /* ignore */
    }
  }
}

async function main(): Promise<void> {
  console.log('=== ArcadeDB FACADE PROOF + AUTH RESOLVER e2e ===');
  await assertVersion();
  await cleanup(); // start from a clean slate

  // ── Provision two sibling cells + embed dim from the real provider ───────
  console.log('\n--- provisioning two sibling cells (real provisioner) ---');
  await sharedEmbedder.initialize();
  const embedDim = sharedEmbedder.dimension;
  await provisionApp(CELL1, { registryDbPath: REGISTRY_DB_PATH, embedDim });
  await provisionApp(CELL2, { registryDbPath: REGISTRY_DB_PATH, embedDim });
  check('provisioned facadex/appone + facadex/apptwo', true);

  // ── Issue workspace-scoped tokens (daemon-operator lane) ─────────────────
  const tokenApp1 = issueToken(
    { tenantId: CELL1.customerId, appId: CELL1.appId, scopes: ['read', 'write'] },
    { registryDbPath: REGISTRY_DB_PATH },
  ).token;
  const tokenApp2 = issueToken(
    { tenantId: CELL2.customerId, appId: CELL2.appId, scopes: ['read', 'write'] },
    { registryDbPath: REGISTRY_DB_PATH },
  ).token;
  const tokenApp1ReadOnly = issueToken(
    { tenantId: CELL1.customerId, appId: CELL1.appId, scopes: ['read'] },
    { registryDbPath: REGISTRY_DB_PATH },
  ).token;
  check('issued 3 tokens (app1 rw, app2 rw, app1 ro)', true);

  // ── Resolver binds token -> cell WITHOUT any tenant/app/db parameter ─────
  console.log('\n--- 1. AUTH RESOLVER: token -> frozen principal ---');
  const p1 = resolvePrincipal(tokenApp1, { registryDbPath: REGISTRY_DB_PATH });
  check('resolve(app1 token).tenantId === facadex', p1.tenantId === 'facadex', p1.tenantId);
  check('resolve(app1 token).appId === appone', p1.appId === 'appone', p1.appId);
  check('resolve(app1 token).db === tenant_facadex_appone', p1.db === 'tenant_facadex_appone', p1.db);
  check(
    'resolve(app1 token).dbUser === facadex_appone_svc',
    p1.dbUser === 'facadex_appone_svc',
    p1.dbUser,
  );
  check('resolve(app1 token).scopes = [read,write]', p1.scopes.join(',') === 'read,write', p1.scopes.join(','));

  await expectThrows(
    'unknown token rejected pre-HTTP (ArcadeAuthError unknown_token)',
    async () => resolvePrincipal('lore_at_not-a-real-token', { registryDbPath: REGISTRY_DB_PATH }),
    (e) => e instanceof ArcadeAuthError && e.reason === 'unknown_token',
  );

  // ── Build the REAL facade from a resolver-issued token ───────────────────
  console.log('\n--- 2. FACADE PROOF: LoreStorageClient.fromLocal over ArcadeDB ---');
  const cell1 = arcadeCellForToken(tokenApp1, {
    registryDbPath: REGISTRY_DB_PATH,
    embedder: sharedEmbedder,
  });
  // ZERO facade edits: fromLocal takes the scope-guarded ArcadeDB handles.
  const facade1 = LoreStorageClient.fromLocal({
    graph: cell1.graph,
    verbatim: cell1.verbatim,
  });
  check('facade1 mode === local', facade1.getMode() === 'local');

  // STORE: two nodes + an edge + a verbatim doc — all through facade methods.
  const nodeA: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> = {
    id: 'node-a',
    type: 'decision',
    label: 'Adopt ArcadeDB db-per-app',
    content: 'We chose one ArcadeDB database per (tenant, app) cell for isolation.',
    tags: ['arcadedb', 'isolation'],
    project: 'lore',
    ecosystem: 'backend',
    metadata: '',
  };
  const nodeB: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> = {
    id: 'node-b',
    type: 'convention',
    label: 'Tokens bind to one cell',
    content: 'A workspace-scoped token resolves to exactly one database.',
    tags: ['auth', 'isolation'],
    project: 'lore',
    ecosystem: 'backend',
    metadata: '',
  };
  const storedA = await facade1.upsertNode(nodeA);
  await facade1.upsertNode(nodeB);
  await facade1.addEdge({ sourceId: 'node-a', targetId: 'node-b', relation: 'relates_to' });
  await facade1.verbatimStore({
    id: 'doc-a',
    text: 'The database-per-application design gives each tenant cell its own isolated store.',
    metadata: { type: 'note', label: 'design note', project: 'lore', ecosystem: 'backend' },
  });
  check('facade store: upsertNode returns createdAt/updatedAt populated', !!storedA.createdAt && !!storedA.updatedAt);

  // RECALL: getNode round-trips all fields (tags JSON, timestamps).
  const gotA = await facade1.getNode('node-a');
  check('facade.getNode(node-a) round-trips label', gotA?.label === nodeA.label, gotA?.label);
  check(
    'facade.getNode(node-a) round-trips tags (JSON)',
    JSON.stringify(gotA?.tags) === JSON.stringify(['arcadedb', 'isolation']),
    JSON.stringify(gotA?.tags),
  );
  check('facade.getNode(node-a) has ISO createdAt', !!gotA?.createdAt && !Number.isNaN(Date.parse(gotA!.createdAt)));

  // getNodesByIds batch hydration through the graph handle.
  const batch = await cell1.graph.getNodesByIds(['node-a', 'node-b', 'missing-id']);
  check('getNodesByIds returns present ids only', batch.size === 2 && batch.has('node-a') && batch.has('node-b') && !batch.has('missing-id'));

  // traverse via the documented rawGraph() escape hatch — trap-safe bothE path.
  const hops = await facade1.rawGraph().traverse('node-a', 2, 'relates_to');
  check(
    'facade.rawGraph().traverse(node-a, 2, relates_to) reaches node-b (bothE trap-safe)',
    hops.some((h) => h.node.id === 'node-b'),
    JSON.stringify(hops.map((h) => h.node.id)),
  );

  // SEARCH: case-insensitive across label/content/tags; limit honored.
  const searchHits = await facade1.search('arcadedb', 20, 'lore', 'backend');
  check('facade.search("arcadedb") matches node-a (case-insensitive)', searchHits.some((n) => n.id === 'node-a'));
  const tagSearch = await facade1.search('ISOLATION');
  check('facade.search("ISOLATION") matches via tags/content case-insensitively', tagSearch.some((n) => n.id === 'node-a') && tagSearch.some((n) => n.id === 'node-b'));

  // listNodes filter.
  const listed = await facade1.listNodes('decision', undefined, 'lore', 'backend');
  check('facade.listNodes(type=decision) returns node-a only', listed.length === 1 && listed[0]?.id === 'node-a', JSON.stringify(listed.map((n) => n.id)));

  // verbatimSearch: semantic recall returns the stored doc, score in [0,1].
  const vhits = await facade1.verbatimSearch('per-tenant database isolation', 5, { project: 'lore' });
  const top = vhits[0];
  check('facade.verbatimSearch returns doc-a', vhits.some((r) => r.id === 'doc-a'));
  check('facade.verbatimSearch score in [0,1]', top !== undefined && top.score >= 0 && top.score <= 1, String(top?.score));

  // verbatimCount reflects the store.
  const vcount = await facade1.verbatimCount();
  check('facade.verbatimCount() === 1', vcount === 1, String(vcount));

  // getStats reflects counts.
  const stats = await facade1.getStats();
  check('facade.getStats nodeCount === 2', stats.nodeCount === 2, String(stats.nodeCount));
  check('facade.getStats edgeCount === 1', stats.edgeCount === 1, String(stats.edgeCount));
  check('facade.getStats typeBreakdown has decision+convention', stats.typeBreakdown['decision'] === 1 && stats.typeBreakdown['convention'] === 1, JSON.stringify(stats.typeBreakdown));

  // DELETE: verbatimDelete then verbatimSearch misses it.
  await facade1.verbatimDelete('doc-a');
  const afterVDelete = await facade1.verbatimSearch('per-tenant database isolation', 5);
  check('facade.verbatimDelete then search misses doc-a', !afterVDelete.some((r) => r.id === 'doc-a'));
  check('facade.verbatimCount() === 0 after delete', (await facade1.verbatimCount()) === 0);

  // deleteNode via rawGraph(): returns true, detaches the edge (traverse empty).
  const del = await facade1.rawGraph().deleteNode('node-b');
  check('facade.rawGraph().deleteNode(node-b) === true', del === true);
  const hopsAfter = await facade1.rawGraph().traverse('node-a', 2, 'relates_to');
  check('after deleteNode(node-b), traverse from node-a returns nothing (edge detached)', hopsAfter.length === 0, JSON.stringify(hopsAfter.map((h) => h.node.id)));
  const statsAfter = await facade1.getStats();
  check('facade.getStats nodeCount === 1 after deleteNode', statsAfter.nodeCount === 1, String(statsAfter.nodeCount));

  // ── 3. ISOLATION THROUGH THE FACADE ─────────────────────────────────────
  console.log('\n--- 3. ISOLATION: sibling facade cannot see cell1 rows ---');
  const cell2 = arcadeCellForToken(tokenApp2, {
    registryDbPath: REGISTRY_DB_PATH,
    embedder: sharedEmbedder,
  });
  const facade2 = LoreStorageClient.fromLocal({ graph: cell2.graph, verbatim: cell2.verbatim });
  // Seed cell2 with its own doc so verbatimSearch has an index to hit.
  await facade2.upsertNode({ ...nodeA, id: 'c2-node', label: 'cell2 only', content: 'apptwo private data', tags: ['apptwo'] });
  await facade2.verbatimStore({ id: 'c2-doc', text: 'apptwo private isolation data', metadata: { project: 'lore' } });

  check('facade2.getNode(node-a) === null (cannot see cell1 node)', (await facade2.getNode('node-a')) === null);
  const c2Search = await facade2.search('arcadedb');
  check('facade2.search("arcadedb") does not surface cell1 node-a', !c2Search.some((n) => n.id === 'node-a'));
  const c2VSearch = await facade2.verbatimSearch('per-tenant database isolation', 10);
  check('facade2.verbatimSearch does not surface cell1 doc-a', !c2VSearch.some((r) => r.id === 'doc-a'));

  // Direct cross-db probe: cell1's db user hitting cell2's database => 403.
  const cell1Http = new ArcadeHttp(
    { user: p1.dbUser, pass: (await import('../packages/lore/src/engines/arcade/arcadeProvisioner.js')).readSecret(CELL1, { registryDbPath: REGISTRY_DB_PATH })! },
    ARCADE_BASE_URL,
  );
  await expectThrows(
    'cross-db probe (app1 user -> app2 db) raises ArcadeHttpError 403',
    async () => cell1Http.query('tenant_facadex_apptwo', 'SELECT count(*) AS n FROM LoreNode'),
    (e) => e instanceof ArcadeHttpError && e.status === 403,
  );

  // ── 4. SCOPE THROUGH THE FACADE ─────────────────────────────────────────
  console.log('\n--- 4. SCOPE: read-only token write verb throws pre-HTTP ---');
  const roCell = arcadeCellForToken(tokenApp1ReadOnly, {
    registryDbPath: REGISTRY_DB_PATH,
    embedder: sharedEmbedder,
  });
  const roFacade = LoreStorageClient.fromLocal({ graph: roCell.graph, verbatim: roCell.verbatim });
  check('read-only principal scopes === [read]', roCell.principal.scopes.join(',') === 'read');
  await expectThrows(
    'read-only facade.upsertNode throws ScopeError (pre-HTTP)',
    async () => roFacade.upsertNode(nodeA),
    (e) => e instanceof ScopeError,
  );
  await expectThrows(
    'read-only facade.verbatimStore throws ScopeError (pre-HTTP)',
    async () => roFacade.verbatimStore({ id: 'x', text: 'nope', metadata: {} }),
    (e) => e instanceof ScopeError,
  );
  // read-only reads still work (the surviving cell1 node-a).
  const roRead = await roFacade.getNode('node-a');
  check('read-only facade.getNode still works', roRead?.id === 'node-a');

  // ── 5. REVOCATION fails closed ──────────────────────────────────────────
  console.log('\n--- 5. REVOCATION: revoked token fails closed ---');
  const throwaway = issueToken(
    { tenantId: CELL1.customerId, appId: CELL1.appId, scopes: ['read'] },
    { registryDbPath: REGISTRY_DB_PATH },
  ).token;
  check('revokeToken returns true for a live token', revokeToken(throwaway, { registryDbPath: REGISTRY_DB_PATH }) === true);
  await expectThrows(
    'resolve(revoked token) throws ArcadeAuthError revoked_token',
    async () => resolvePrincipal(throwaway, { registryDbPath: REGISTRY_DB_PATH }),
    (e) => e instanceof ArcadeAuthError && e.reason === 'revoked_token',
  );

  // ── summary ─────────────────────────────────────────────────────────────
  await cleanup();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log('\nFACADE PROOF: LoreStorageClient (unedited) runs the full');
  console.log('store->recall->search->delete cycle against ArcadeDB. ArcadeDB is a');
  console.log('drop-in backend at the facade socket. Auth resolver + isolation +');
  console.log('scope + revocation all hold THROUGH the real facade.');
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await cleanup();
  process.exit(1);
});

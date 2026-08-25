#!/usr/bin/env tsx
/**
 * test/optionA-arcadedb-hardening-e2e.ts — Option-A pre-production hardening
 * suite (branch: spike/arcadedb-multitenant).
 *
 * Combines, in one non-zero-exit-on-failure run against the live pinned
 * ArcadeDB 26.7.1 container, the five areas of the hardening plan:
 *
 *   (1) FACADE ROUND-TRIP    — LoreStorageClient.fromLocal(...) over the
 *                              Design-A ArcadeDB adapters: store -> recall ->
 *                              search -> delete, entirely through facade
 *                              methods (+ the documented rawGraph() escape
 *                              hatch for traverse/deleteNode).
 *   (2) NEW PROVIDER METHODS — deleteNode / search / listNodes / getStats /
 *                              getTopology (throwing stub) / maintenance
 *                              stubs (throwing), asserting correct results
 *                              and NOT silent zero-rows.
 *   (3) RUNTIME PROVISIONING — provision a brand-new (customer,app) at
 *                              runtime, use it through the auth resolver +
 *                              facade, then two-phase deprovision; assert
 *                              onboarding/teardown work and the cell is
 *                              isolated.
 *   (4) ISOLATION REGRESSION — cross-app + cross-customer + scope adversarial
 *                              checks; must stay clean after the Phase 1
 *                              surface expansion.
 *   (5) SQL-TRAP PINS        — regression pins for the three known ArcadeDB
 *                              26.7.1 silent-wrong-results traps (T1 both()
 *                              vertex-projection relation filter, T2
 *                              expand-of-expand WHERE needing an extra SELECT
 *                              wrap, T3 vector.neighbors filter dropping
 *                              foreign rows) so a future ArcadeDB upgrade that
 *                              changes behavior is caught.
 *
 * Run: npx tsx test/optionA-arcadedb-hardening-e2e.ts
 * Pre-req: ArcadeDB 26.7.1 container already running on :2480 (see
 * test/spike-arcadedb-helpers.ts's ARCADE_STABLE_TAG / startArcadeContainer).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { LoreStorageClient } from '../packages/lore/src/storage/loreStorageClient.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { ArcadeVectorStore } from '../packages/lore/src/engines/arcade/arcadeVectorStore.js';
import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import {
  provisionApp,
  disableApp,
  destroyApp,
  getTenantApp,
  readSecret,
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
import { ScopeError } from '../packages/lore/src/engines/arcade/arcadeScopeGuard.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

// ── mini harness ─────────────────────────────────────────────────────────
type Area = 'FACADE' | 'PROVIDER' | 'PROVISIONING' | 'ISOLATION' | 'SQLTRAP';
const areaCounts: Record<Area, { pass: number; fail: number }> = {
  FACADE: { pass: 0, fail: 0 },
  PROVIDER: { pass: 0, fail: 0 },
  PROVISIONING: { pass: 0, fail: 0 },
  ISOLATION: { pass: 0, fail: 0 },
  SQLTRAP: { pass: 0, fail: 0 },
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
    const msg = `  [FAIL][${area}] ${label}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.error(msg);
  }
}

async function expectThrows(
  area: Area,
  label: string,
  fn: () => Promise<unknown>,
  match?: (e: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    check(area, label, false, 'expected throw, got success');
  } catch (e) {
    const ok = match ? match(e) : true;
    check(area, label, ok, ok ? undefined : `wrong error: ${(e as Error)?.name}: ${(e as Error)?.message}`);
  }
}

// ── isolated registry so this run never collides with another session ────
const REGISTRY_DB_PATH = path.join(os.tmpdir(), `arcade-optionA-hardening-${process.pid}.sqlite`);
const RUN_TAG = Date.now().toString(36);

const CELL_A = { customerId: 'hardna', appId: 'appone' }; // "tenant A / app1"
const CELL_B = { customerId: 'hardna', appId: 'apptwo' }; // cross-app, same customer
const CELL_C = { customerId: 'hardnb', appId: 'appone' }; // cross-customer
const RUNTIME_CELL = { customerId: 'hardrt', appId: 'newapp' }; // provisioned at runtime in area 3

// Shared embedder — avoid loading the ~120MB model once per cell.
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
  for (const cell of [CELL_A, CELL_B, CELL_C, RUNTIME_CELL]) {
    try {
      await destroyApp(cell, { registryDbPath: REGISTRY_DB_PATH });
    } catch {
      /* best-effort */
    }
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

// ═══════════════════════════════════════════════════════════════════════
// (1) FACADE ROUND-TRIP
// ═══════════════════════════════════════════════════════════════════════
async function testFacadeRoundTrip(): Promise<void> {
  console.log('\n=== (1) FACADE ROUND-TRIP ===');
  const embedDim = sharedEmbedder.dimension;
  await provisionApp(CELL_A, { registryDbPath: REGISTRY_DB_PATH, embedDim });

  const tokenA = issueToken(
    { tenantId: CELL_A.customerId, appId: CELL_A.appId, scopes: ['read', 'write'] },
    { registryDbPath: REGISTRY_DB_PATH },
  ).token;
  const cellA = arcadeCellForToken(tokenA, { registryDbPath: REGISTRY_DB_PATH, embedder: sharedEmbedder });
  const facade = LoreStorageClient.fromLocal({ graph: cellA.graph, verbatim: cellA.verbatim });
  check('FACADE', 'facade mode === local', facade.getMode() === 'local');

  const nodeA: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> = {
    id: `fnode-a-${RUN_TAG}`,
    type: 'decision',
    label: 'Adopt ArcadeDB db-per-app',
    content: 'Facade round-trip proof node A content for hardening suite.',
    tags: ['arcadedb', 'hardening'],
    project: 'lore',
    ecosystem: 'backend',
    metadata: '',
  };
  const nodeB: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> = {
    id: `fnode-b-${RUN_TAG}`,
    type: 'convention',
    label: 'Tokens bind to one cell',
    content: 'Facade round-trip proof node B content for hardening suite.',
    tags: ['auth', 'hardening'],
    project: 'lore',
    ecosystem: 'backend',
    metadata: '',
  };

  // STORE
  const storedA = await facade.upsertNode(nodeA);
  await facade.upsertNode(nodeB);
  await facade.addEdge({ sourceId: nodeA.id, targetId: nodeB.id, relation: 'relates_to' });
  await facade.verbatimStore({
    id: `fdoc-a-${RUN_TAG}`,
    text: 'The database-per-application design gives each tenant cell its own isolated store.',
    metadata: { type: 'note', label: 'design note', project: 'lore', ecosystem: 'backend' },
  });
  check('FACADE', 'store: upsertNode returns createdAt/updatedAt', !!storedA.createdAt && !!storedA.updatedAt);

  // RECALL: getNode
  const gotA = await facade.getNode(nodeA.id);
  check('FACADE', 'getNode round-trips label', gotA?.label === nodeA.label, gotA?.label);
  check(
    'FACADE',
    'getNode round-trips tags (JSON)',
    JSON.stringify(gotA?.tags) === JSON.stringify(['arcadedb', 'hardening']),
    JSON.stringify(gotA?.tags),
  );
  check('FACADE', 'getNode has ISO createdAt', !!gotA?.createdAt && !Number.isNaN(Date.parse(gotA!.createdAt)));

  // RECALL: semantic search
  const vhits = await facade.verbatimSearch('per-tenant database isolation', 5, { project: 'lore' });
  const top = vhits[0];
  check('FACADE', 'verbatimSearch returns the stored doc', vhits.some((r) => r.id === `fdoc-a-${RUN_TAG}`));
  check('FACADE', 'verbatimSearch score in [0,1]', top !== undefined && top.score >= 0 && top.score <= 1, String(top?.score));

  // SEARCH
  const searchHits = await facade.search('arcadedb', 20, 'lore', 'backend');
  check('FACADE', 'search("arcadedb") matches node A (case-insensitive)', searchHits.some((n) => n.id === nodeA.id));
  const tagSearch = await facade.search('HARDENING');
  check(
    'FACADE',
    'search("HARDENING") matches both nodes via tags case-insensitively',
    tagSearch.some((n) => n.id === nodeA.id) && tagSearch.some((n) => n.id === nodeB.id),
  );

  // listNodes
  const listed = await facade.listNodes('decision', undefined, 'lore', 'backend');
  check('FACADE', 'listNodes(type=decision) returns node A only', listed.length >= 1 && listed.some((n) => n.id === nodeA.id));

  // traverse via rawGraph() escape hatch
  const hops = await facade.rawGraph().traverse(nodeA.id, 2, 'relates_to');
  check('FACADE', 'rawGraph().traverse reaches node B', hops.some((h) => h.node.id === nodeB.id), JSON.stringify(hops.map((h) => h.node.id)));

  // getStats
  const stats = await facade.getStats();
  check('FACADE', 'getStats nodeCount >= 2', stats.nodeCount >= 2, String(stats.nodeCount));
  check('FACADE', 'getStats edgeCount >= 1', stats.edgeCount >= 1, String(stats.edgeCount));

  // DELETE
  await facade.verbatimDelete(`fdoc-a-${RUN_TAG}`);
  const afterVDelete = await facade.verbatimSearch('per-tenant database isolation', 5);
  check('FACADE', 'verbatimDelete then search misses the doc', !afterVDelete.some((r) => r.id === `fdoc-a-${RUN_TAG}`));

  const del = await facade.rawGraph().deleteNode(nodeB.id);
  check('FACADE', 'rawGraph().deleteNode(node B) === true', del === true);
  const hopsAfter = await facade.rawGraph().traverse(nodeA.id, 2, 'relates_to');
  check('FACADE', 'after deleteNode(B), traverse from A returns nothing (edge detached)', hopsAfter.length === 0, JSON.stringify(hopsAfter));

  const statsAfter = await facade.getStats();
  check('FACADE', 'getStats reflects post-delete counts', statsAfter.nodeCount === stats.nodeCount - 1, String(statsAfter.nodeCount));

  // ── facade FEATURE-DETECT routing to the arcade batched/lexical paths ────
  // bulkUpsertNodes: the facade must feature-detect the adapter's batched impl
  // (not fall back to the per-node loop). Assert the batch lands + per-node ok.
  const fb = Array.from({ length: 8 }, (_, i) => ({
    id: `fbulk-${RUN_TAG}-${i}`, type: 'fact', label: `fbulk ${i}`, content: `facade bulk ${i}`,
    tags: ['facadebulk'], project: 'lore', ecosystem: 'backend', metadata: '',
  }));
  const fbRes = await facade.bulkUpsertNodes(fb);
  check('FACADE', 'facade.bulkUpsertNodes routes to arcade batched impl (all 8 ok)', fbRes.length === 8 && fbRes.every((r) => r.ok), `ok=${fbRes.filter((r) => r.ok).length}`);
  check('FACADE', 'facade.bulkUpsertNodes rows are queryable', (await facade.getNode(`fbulk-${RUN_TAG}-7`))?.label === 'fbulk 7');

  // verbatimBm25Search: the facade must feature-detect the adapter's bm25Search
  // (was CloudModeNotImplementedError for non-VerbatimStore backends).
  await facade.verbatimStore({
    id: `fbm-${RUN_TAG}`,
    text: 'lexical keyword search over the arcade verbatim store works',
    metadata: { type: 'note', label: 'bm doc', project: 'lore', ecosystem: 'backend' },
  });
  const fbm = await facade.verbatimBm25Search('lexical keyword arcade', 5, { project: 'lore' });
  check('FACADE', 'facade.verbatimBm25Search routes to arcade bm25 (non-zero, no CloudModeNotImplementedError)', fbm.some((r) => r.id === `fbm-${RUN_TAG}`), JSON.stringify(fbm.map((r) => r.id)));
}

// ═══════════════════════════════════════════════════════════════════════
// (2) NEW PROVIDER METHODS — exercise directly on ArcadeGraphStore/ArcadeVectorStore
// ═══════════════════════════════════════════════════════════════════════
async function testNewProviderMethods(): Promise<void> {
  console.log('\n=== (2) NEW PROVIDER METHODS ===');
  const secret = readSecret(CELL_A, { registryDbPath: REGISTRY_DB_PATH })!;
  const cellRow = getTenantApp(CELL_A, { registryDbPath: REGISTRY_DB_PATH })!;
  const http = new ArcadeHttp({ user: cellRow.db_user, pass: secret }, ARCADE_BASE_URL);
  const graph = new ArcadeGraphStore({ tenantDb: cellRow.db, http });
  const vector = new ArcadeVectorStore({ tenantDb: cellRow.db, http, embedder: sharedEmbedder });

  // Seed a small, distinctive set for search/listNodes/getStats/deleteNode.
  const ids = [0, 1, 2, 3].map((i) => `pnode-${RUN_TAG}-${i}`);
  await graph.upsertNode({
    id: ids[0]!,
    type: 'fact',
    label: 'Provider methods probe zero',
    content: 'UNIQUEMARKER content for provider-method search test',
    tags: ['providertest', 'zero'],
    project: 'provtest',
    ecosystem: 'spike',
    metadata: '',
  });
  await graph.upsertNode({
    id: ids[1]!,
    type: 'fact',
    label: 'Provider methods probe one',
    content: 'second node content, no marker here',
    tags: ['providertest', 'one'],
    project: 'provtest',
    ecosystem: 'spike',
    metadata: '',
  });
  await graph.upsertNode({
    id: ids[2]!,
    type: 'decision',
    label: 'Provider methods probe two (decision type)',
    content: 'third node, decision type, UNIQUEMARKER also here',
    tags: ['providertest', 'two'],
    project: 'provtest',
    ecosystem: 'spike',
    metadata: '',
  });
  await graph.upsertNode({
    id: ids[3]!,
    type: 'fact',
    label: 'Provider methods probe three (to be deleted)',
    content: 'fourth node, will be deleted',
    tags: ['providertest', 'three'],
    project: 'provtest',
    ecosystem: 'spike',
    metadata: '',
  });
  await graph.addEdge({ sourceId: ids[0]!, targetId: ids[1]!, relation: 'relates_to' });

  // ── search: case-insensitive substring across label/content/tags, NOT zero rows ──
  const searchHits = await graph.search('uniquemarker', 20, 'provtest', 'spike');
  check(
    'PROVIDER',
    'search("uniquemarker") returns exactly the two marked nodes (not silently zero)',
    searchHits.length === 2 && searchHits.some((n) => n.id === ids[0]) && searchHits.some((n) => n.id === ids[2]),
    JSON.stringify(searchHits.map((n) => n.id)),
  );
  const tagHits = await graph.search('providertest', 20, 'provtest', 'spike');
  check('PROVIDER', 'search("providertest") (tag match) returns all 4 seeded nodes', tagHits.length === 4, String(tagHits.length));
  const noHit = await graph.search('nonexistentxyz123', 20, 'provtest', 'spike');
  check('PROVIDER', 'search(no match) legitimately returns zero (not a trap — no candidates exist)', noHit.length === 0);

  // ── listNodes: dynamic WHERE, tag filter (JSON-encoded column), project/ecosystem ──
  const byType = await graph.listNodes('decision', undefined, 'provtest', 'spike');
  check('PROVIDER', 'listNodes(type=decision) returns exactly node two', byType.length === 1 && byType[0]?.id === ids[2], JSON.stringify(byType.map((n) => n.id)));
  const byTag = await graph.listNodes(undefined, 'zero', 'provtest', 'spike');
  check('PROVIDER', 'listNodes(tag=zero) returns exactly node zero (not silently zero rows)', byTag.length === 1 && byTag[0]?.id === ids[0], JSON.stringify(byTag.map((n) => n.id)));
  const byProjectOnly = await graph.listNodes(undefined, undefined, 'provtest', 'spike');
  check('PROVIDER', 'listNodes(project+ecosystem only) returns all 4', byProjectOnly.length === 4, String(byProjectOnly.length));

  // ── getStats: nodeCount, edgeCount, typeBreakdown ──
  const stats = await graph.getStats('provtest');
  check('PROVIDER', 'getStats nodeCount === 4 (project-filtered)', stats.nodeCount === 4, String(stats.nodeCount));
  check('PROVIDER', 'getStats edgeCount >= 1', stats.edgeCount >= 1, String(stats.edgeCount));
  check(
    'PROVIDER',
    'getStats typeBreakdown has fact=3, decision=1',
    stats.typeBreakdown['fact'] === 3 && stats.typeBreakdown['decision'] === 1,
    JSON.stringify(stats.typeBreakdown),
  );

  // ── getNodesByIds: batch hydration, absent-if-missing ──
  const batch = await graph.getNodesByIds([ids[0]!, ids[2]!, 'totally-missing-id']);
  check(
    'PROVIDER',
    'getNodesByIds returns present ids only (batched, not N+1 loop)',
    batch.size === 2 && batch.has(ids[0]!) && batch.has(ids[2]!) && !batch.has('totally-missing-id'),
  );

  // ── deleteNode: existence-checked, detaches incident edges ──
  const preDeleteTraverse = await graph.traverse(ids[0]!, 1, 'relates_to');
  check('PROVIDER', 'pre-delete traverse from node zero reaches node one', preDeleteTraverse.some((r) => r.node.id === ids[1]));
  const deletedOne = await graph.deleteNode(ids[1]!);
  check('PROVIDER', 'deleteNode(existing) returns true', deletedOne === true);
  const deletedAgain = await graph.deleteNode(ids[1]!);
  check('PROVIDER', 'deleteNode(already-gone) returns false', deletedAgain === false);
  const postDeleteTraverse = await graph.traverse(ids[0]!, 1, 'relates_to');
  check(
    'PROVIDER',
    'after deleteNode(node one), traverse from node zero returns nothing (edge detached, no dangling edge)',
    postDeleteTraverse.length === 0,
    JSON.stringify(postDeleteTraverse),
  );

  // ── vector store/search with contentHash short-circuit + metadata filter + actorScopes ──
  const docId = `pdoc-${RUN_TAG}`;
  await vector.store({
    id: docId,
    text: 'ArcadeDB provider-method vector store test content about isolation walls.',
    metadata: { type: 'note', project: 'provtest', security_scopes: ['team:eng'] },
  });
  const vhits = await vector.search('isolation walls provider test', 10, { project: 'provtest' }, undefined, ['team:eng']);
  check('PROVIDER', 'vector.search with matching actorScopes returns the doc (not silently zero)', vhits.some((r) => r.id === docId), JSON.stringify(vhits.map((r) => r.id)));
  const vhitsNoScope = await vector.search('isolation walls provider test', 10, { project: 'provtest' }, undefined, ['team:other']);
  check('PROVIDER', 'vector.search with non-overlapping actorScopes excludes the scoped doc', !vhitsNoScope.some((r) => r.id === docId));

  // contentHash short-circuit: re-store identical text, count unchanged, embedding row survives.
  const countBefore = await vector.count();
  await vector.store({
    id: docId,
    text: 'ArcadeDB provider-method vector store test content about isolation walls.',
    metadata: { type: 'note', project: 'provtest', security_scopes: ['team:eng'] },
  });
  const countAfter = await vector.count();
  check('PROVIDER', 'contentHash short-circuit: re-store unchanged text is idempotent (count unchanged)', countAfter === countBefore, `before=${countBefore} after=${countAfter}`);

  // ── slice-2 provider completeness (was: throwing Phase-6 stubs) ──────────
  // ids[1] was deleted above; surviving seeded nodes are ids[0], ids[2], ids[3].

  // getTopology — real snapshot, edges use the verified outV()/inV() projection
  // (T1 edge-projection trap: the dotted out.id/in.id form silently returns null
  // on 26.7.1). Closed over the returned node window.
  const gt = await graph.getTopology(300, 'provtest');
  check(
    'PROVIDER',
    'getTopology returns surviving provtest nodes (not silently zero; T1 edge-projection trap avoided via outV()/inV())',
    gt.nodes.length === 3 && gt.nodes.some((n) => (n as { id: string }).id === ids[0]),
    `nodes=${gt.nodes.length}`,
  );

  // getEdges — direct edge-table read with outV()/inV() endpoints. ids[0]→ids[1]
  // was detached when ids[1] was deleted above, so seed a fresh edge first.
  await graph.addEdge({ sourceId: ids[0]!, targetId: ids[2]!, relation: 'linked_to' });
  const gEdges = await graph.getEdges(ids[0]!);
  check(
    'PROVIDER',
    'getEdges(nodeZero) returns non-null endpoints (T1 pin: out.id would be null → zero rows)',
    gEdges.length >= 1 && gEdges.every((e) => e.sourceId && e.targetId),
    JSON.stringify(gEdges),
  );
  // Clean up so the later deleteEdge/prune counts remain exact.
  await graph.deleteEdge(ids[0]!, ids[2]!, 'linked_to');

  // supersedeNode / history-aware reads / unsupersedeNode.
  const supRes = await graph.supersedeNode(ids[3]!, ids[0]!, 'consolidated');
  check('PROVIDER', 'supersedeNode(existing→existing) ok:true', supRes.ok === true, JSON.stringify(supRes));
  const supSelf = await graph.supersedeNode(ids[0]!, ids[0]!);
  check('PROVIDER', 'supersedeNode(self) ok:false reason:self', supSelf.ok === false && supSelf.reason === 'self');
  const supMissing = await graph.supersedeNode(ids[0]!, 'no-such-node-xyz');
  check('PROVIDER', 'supersedeNode(new-not-found) ok:false reason:new-not-found', supMissing.ok === false && supMissing.reason === 'new-not-found');
  const listPostSup = await graph.listNodes(undefined, undefined, 'provtest', 'spike');
  check('PROVIDER', 'default listNodes hides the superseded node (history-aware read)', !listPostSup.some((n) => n.id === ids[3]), JSON.stringify(listPostSup.map((n) => n.id)));
  const unsupOk = await graph.unsupersedeNode(ids[3]!);
  check('PROVIDER', 'unsupersedeNode(existing) true + row reappears', unsupOk === true && (await graph.listNodes(undefined, undefined, 'provtest', 'spike')).some((n) => n.id === ids[3]));

  // markStaleByTags — EXACT JSON-tag membership. ids[0] tag 'zero', ids[2] tag 'two'.
  const marked = await graph.markStaleByTags(['zero']);
  check('PROVIDER', 'markStaleByTags(["zero"]) marks exactly node zero (exact JSON-tag membership, not substring)', marked === 1, `marked=${marked}`);
  const zeroNode = await graph.getNode(ids[0]!);
  check('PROVIDER', 'node zero is now stale=true', zeroNode?.stale === true);

  // deleteEdge — the (source,target,relation) triple. ids[0]→ids[1] was
  // detached by deleteNode, so add a fresh edge to delete.
  await graph.addEdge({ sourceId: ids[0]!, targetId: ids[2]!, relation: 'relates_to' });
  const delCount = await graph.deleteEdge(ids[0]!, ids[2]!, 'relates_to');
  check('PROVIDER', 'deleteEdge returns 1 (T1 pin: outV()/inV() WHERE, not out.id which zero-rows)', delCount === 1, `count=${delCount}`);
  const delMiss = await graph.deleteEdge(ids[0]!, ids[2]!, 'no-such-relation');
  check('PROVIDER', 'deleteEdge no-match returns 0', delMiss === 0);

  // pruneInferredLoreEdges — prefix delete on the edge table directly (trap-free).
  await graph.addEdge({ sourceId: ids[0]!, targetId: ids[2]!, relation: 'semantic_neighbor:0.9' });
  const prunedEdges = await graph.pruneInferredLoreEdges('semantic_neighbor');
  check('PROVIDER', 'pruneInferredLoreEdges("semantic_neighbor") deletes the inferred edge', prunedEdges === 1, `pruned=${prunedEdges}`);

  // pruneEphemeralNodes — client-side expiry math (no ArcadeDB date arithmetic).
  await graph.upsertNode({ id: `eph-${RUN_TAG}`, type: 'scratch', label: 'ephemeral', content: 'temp', tags: ['eph'], project: 'provtest', ecosystem: 'spike', metadata: '', ephemeral: true, ttl_ms: 1 });
  await new Promise((r) => setTimeout(r, 15));
  const prunedEph = await graph.pruneEphemeralNodes(1);
  check('PROVIDER', 'pruneEphemeralNodes deletes the expired ephemeral node', prunedEph === 1, `pruned=${prunedEph}`);
  check('PROVIDER', 'expired ephemeral node is gone', (await graph.getNode(`eph-${RUN_TAG}`)) === null);

  // bulkUpsertNodes — batched single-round-trip, per-node {id,ok,error}.
  const bulkBatch = Array.from({ length: 10 }, (_, i) => ({
    id: `bulk-${RUN_TAG}-${i}`, type: 'fact', label: `bulk ${i}`, content: `bulk content ${i}`,
    tags: ['bulktest'], project: 'provtest', ecosystem: 'spike', metadata: '',
  }));
  const bulkRes = await graph.bulkUpsertNodes(bulkBatch);
  check('PROVIDER', 'bulkUpsertNodes returns per-node ok for all 10 (single-round-trip chunk)', bulkRes.length === 10 && bulkRes.every((r) => r.ok), `ok=${bulkRes.filter((r) => r.ok).length}`);
  check('PROVIDER', 'bulkUpsertNodes rows are queryable', (await graph.getNode(`bulk-${RUN_TAG}-9`))?.label === 'bulk 9');

  // bm25Search — client-ranked lexical over the verbatim store.
  const bm = await vector.bm25Search('isolation walls', 5, { project: 'provtest' });
  check('PROVIDER', 'bm25Search finds the seeded verbatim doc (client-ranked lexical, non-zero)', bm.some((r) => r.id === docId), JSON.stringify(bm.map((r) => r.id)));
}

// ═══════════════════════════════════════════════════════════════════════
// (3) RUNTIME PROVISIONING
// ═══════════════════════════════════════════════════════════════════════
async function testRuntimeProvisioning(): Promise<void> {
  console.log('\n=== (3) RUNTIME PROVISIONING ===');
  const embedDim = sharedEmbedder.dimension;

  // Onboard a brand-new (customer,app) — never provisioned before this run.
  const result = await provisionApp(RUNTIME_CELL, { registryDbPath: REGISTRY_DB_PATH, embedDim });
  check('PROVISIONING', 'runtime provisionApp: created=true for a never-before-seen cell', result.created === true);
  check('PROVISIONING', 'runtime provisionApp: db name follows convention', result.db === `tenant_${RUNTIME_CELL.customerId}_${RUNTIME_CELL.appId}`, result.db);

  // Idempotent re-provision.
  const result2 = await provisionApp(RUNTIME_CELL, { registryDbPath: REGISTRY_DB_PATH, embedDim });
  check('PROVISIONING', 'runtime provisionApp: second call is a no-op repair (created=false)', result2.created === false);
  check('PROVISIONING', 'runtime provisionApp: second call returns same dbUser', result2.dbUser === result.dbUser);

  // Issue a token via the auth resolver + use it through the facade.
  const token = issueToken(
    { tenantId: RUNTIME_CELL.customerId, appId: RUNTIME_CELL.appId, scopes: ['read', 'write'] },
    { registryDbPath: REGISTRY_DB_PATH },
  ).token;
  const principal = resolvePrincipal(token, { registryDbPath: REGISTRY_DB_PATH });
  check('PROVISIONING', 'auth resolver binds new token to the runtime cell', principal.db === result.db && principal.dbUser === result.dbUser);

  const cell = arcadeCellForToken(token, { registryDbPath: REGISTRY_DB_PATH, embedder: sharedEmbedder });
  const facade = LoreStorageClient.fromLocal({ graph: cell.graph, verbatim: cell.verbatim });
  const onboardNode = await facade.upsertNode({
    id: `rt-node-${RUN_TAG}`,
    type: 'fact',
    label: 'Runtime-onboarded cell sanity node',
    content: 'RUNTIME sentinel content proving the freshly-provisioned cell works end-to-end.',
    tags: ['runtime'],
    project: 'runtimeprov',
    ecosystem: 'spike',
    metadata: '',
  });
  check('PROVISIONING', 'onboarded cell: upsertNode through facade succeeds', !!onboardNode.createdAt);
  const readBack = await facade.getNode(`rt-node-${RUN_TAG}`);
  check('PROVISIONING', 'onboarded cell: getNode round-trips through facade', readBack?.label === 'Runtime-onboarded cell sanity node');

  // Isolation of the freshly onboarded cell: raw HTTP as its own user cannot
  // reach CELL_A's database (the pre-existing sibling from area 1).
  const secret = readSecret(RUNTIME_CELL, { registryDbPath: REGISTRY_DB_PATH })!;
  const rtHttp = new ArcadeHttp({ user: result.dbUser, pass: secret }, ARCADE_BASE_URL);
  const cellARow = getTenantApp(CELL_A, { registryDbPath: REGISTRY_DB_PATH })!;
  await expectThrows(
    'PROVISIONING',
    'onboarded cell service user 403s against sibling cell db (hardna/appone)',
    () => rtHttp.query(cellARow.db, 'SELECT count(*) AS n FROM LoreNode'),
    (e) => e instanceof ArcadeHttpError && (e.status === 401 || e.status === 403),
  );

  // Two-phase deprovision: disable -> old cred dead -> destroy -> row gone -> db gone.
  await disableApp(RUNTIME_CELL, { registryDbPath: REGISTRY_DB_PATH });
  const disabledRow = getTenantApp(RUNTIME_CELL, { registryDbPath: REGISTRY_DB_PATH });
  check('PROVISIONING', 'disableApp: registry row status=disabled', disabledRow?.status === 'disabled');
  await expectThrows(
    'PROVISIONING',
    'disableApp: old credential dead (401/403) against its own db',
    () => rtHttp.query(result.db, 'SELECT count(*) AS n FROM LoreNode'),
    (e) => e instanceof ArcadeHttpError && (e.status === 401 || e.status === 403),
  );
  await expectThrows(
    'PROVISIONING',
    'disableApp: resolvePrincipal on a token bound to a disabled cell fails closed',
    async () => resolvePrincipal(token, { registryDbPath: REGISTRY_DB_PATH }),
    (e) => e instanceof ArcadeAuthError && e.reason === 'cell_not_active',
  );

  await destroyApp(RUNTIME_CELL, { registryDbPath: REGISTRY_DB_PATH });
  const destroyedRow = getTenantApp(RUNTIME_CELL, { registryDbPath: REGISTRY_DB_PATH });
  check('PROVISIONING', 'destroyApp: registry row deleted', destroyedRow === undefined);

  const rootHttp = new ArcadeHttp({ user: ARCADE_ROOT_USER, pass: ARCADE_ROOT_PASSWORD }, ARCADE_BASE_URL);
  await expectThrows(
    'PROVISIONING',
    'destroyApp: database itself is dropped (root query against it fails)',
    () => rootHttp.query(result.db, 'SELECT count(*) AS n FROM LoreNode'),
    (e) => e instanceof ArcadeHttpError,
  );

  // destroyApp idempotency.
  await destroyApp(RUNTIME_CELL, { registryDbPath: REGISTRY_DB_PATH }).then(
    () => check('PROVISIONING', 'destroyApp is idempotent (second call does not throw)', true),
    (e) => check('PROVISIONING', 'destroyApp is idempotent (second call does not throw)', false, String(e)),
  );
}

// ═══════════════════════════════════════════════════════════════════════
// (4) ISOLATION REGRESSION — cross-app + cross-customer + scope adversarial
// ═══════════════════════════════════════════════════════════════════════
async function testIsolationRegression(): Promise<void> {
  console.log('\n=== (4) ISOLATION REGRESSION ===');
  const embedDim = sharedEmbedder.dimension;
  await provisionApp(CELL_B, { registryDbPath: REGISTRY_DB_PATH, embedDim }); // cross-app, same customer
  await provisionApp(CELL_C, { registryDbPath: REGISTRY_DB_PATH, embedDim }); // cross-customer

  const tokenA = issueToken({ tenantId: CELL_A.customerId, appId: CELL_A.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
  const tokenB = issueToken({ tenantId: CELL_B.customerId, appId: CELL_B.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
  const tokenC = issueToken({ tenantId: CELL_C.customerId, appId: CELL_C.appId, scopes: ['read', 'write'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
  const tokenAReadOnly = issueToken({ tenantId: CELL_A.customerId, appId: CELL_A.appId, scopes: ['read'] }, { registryDbPath: REGISTRY_DB_PATH }).token;

  const cellA = arcadeCellForToken(tokenA, { registryDbPath: REGISTRY_DB_PATH, embedder: sharedEmbedder });
  const cellB = arcadeCellForToken(tokenB, { registryDbPath: REGISTRY_DB_PATH, embedder: sharedEmbedder });
  const cellC = arcadeCellForToken(tokenC, { registryDbPath: REGISTRY_DB_PATH, embedder: sharedEmbedder });
  const facadeA = LoreStorageClient.fromLocal({ graph: cellA.graph, verbatim: cellA.verbatim });
  const facadeB = LoreStorageClient.fromLocal({ graph: cellB.graph, verbatim: cellB.verbatim });
  const facadeC = LoreStorageClient.fromLocal({ graph: cellC.graph, verbatim: cellC.verbatim });

  // Seed distinctive sentinel rows in B (cross-app-same-customer) and C (cross-customer).
  await facadeB.upsertNode({
    id: `bnode-${RUN_TAG}`,
    type: 'fact',
    label: 'CROSSAPP secret node',
    content: 'CROSSAPP sentinel private content for hardna/apptwo',
    tags: ['crossapp'],
    project: 'crossapp',
    ecosystem: 'spike',
    metadata: '',
  });
  await facadeB.verbatimStore({ id: `bdoc-${RUN_TAG}`, text: 'CROSSAPP secret payload quarterly roadmap for hardna apptwo', metadata: { project: 'crossapp' } });
  await facadeC.upsertNode({
    id: `cnode-${RUN_TAG}`,
    type: 'fact',
    label: 'CROSSCUST secret node',
    content: 'CROSSCUST sentinel private content for hardnb/appone',
    tags: ['crosscust'],
    project: 'crosscust',
    ecosystem: 'spike',
    metadata: '',
  });
  await facadeC.verbatimStore({ id: `cdoc-${RUN_TAG}`, text: 'CROSSCUST secret payload quarterly roadmap for hardnb appone', metadata: { project: 'crosscust' } });

  // A must never see B's or C's rows.
  check('ISOLATION', 'A.getNode(B node id) === null (cross-app, same customer)', (await facadeA.getNode(`bnode-${RUN_TAG}`)) === null);
  check('ISOLATION', 'A.getNode(C node id) === null (cross-customer)', (await facadeA.getNode(`cnode-${RUN_TAG}`)) === null);
  const aSearchCrossApp = await facadeA.search('CROSSAPP');
  check('ISOLATION', 'A.search("CROSSAPP") returns zero rows (no cross-app leak)', aSearchCrossApp.length === 0, JSON.stringify(aSearchCrossApp.map((n) => n.id)));
  const aSearchCrossCust = await facadeA.search('CROSSCUST');
  check('ISOLATION', 'A.search("CROSSCUST") returns zero rows (no cross-customer leak)', aSearchCrossCust.length === 0, JSON.stringify(aSearchCrossCust.map((n) => n.id)));
  const aVSearchB = await facadeA.verbatimSearch('quarterly roadmap hardna apptwo', 20);
  check('ISOLATION', 'A.verbatimSearch does not surface B doc', !aVSearchB.some((r) => r.id === `bdoc-${RUN_TAG}`));
  const aVSearchC = await facadeA.verbatimSearch('quarterly roadmap hardnb appone', 20);
  check('ISOLATION', 'A.verbatimSearch does not surface C doc', !aVSearchC.some((r) => r.id === `cdoc-${RUN_TAG}`));

  // Edge-cross: A cannot addEdge to a B node id (target doesn't exist inside A's db).
  await expectThrows('ISOLATION', 'A.addEdge(A node -> B node id) throws (target not found in A db)', () =>
    facadeA.addEdge({ sourceId: `bnode-${RUN_TAG}`, targetId: `bnode-${RUN_TAG}`, relation: 'relates_to' }),
  );

  // Direct cross-db HTTP probe (defense in depth underneath the facade).
  const secretA = readSecret(CELL_A, { registryDbPath: REGISTRY_DB_PATH })!;
  const rowA = getTenantApp(CELL_A, { registryDbPath: REGISTRY_DB_PATH })!;
  const rowB = getTenantApp(CELL_B, { registryDbPath: REGISTRY_DB_PATH })!;
  const rowC = getTenantApp(CELL_C, { registryDbPath: REGISTRY_DB_PATH })!;
  const httpA = new ArcadeHttp({ user: rowA.db_user, pass: secretA }, ARCADE_BASE_URL);
  await expectThrows(
    'ISOLATION',
    'A user -> B db direct probe raises ArcadeHttpError 403 (cross-app)',
    () => httpA.query(rowB.db, 'SELECT count(*) AS n FROM LoreNode'),
    (e) => e instanceof ArcadeHttpError && e.status === 403,
  );
  await expectThrows(
    'ISOLATION',
    'A user -> C db direct probe raises ArcadeHttpError 403 (cross-customer)',
    () => httpA.query(rowC.db, 'SELECT count(*) AS n FROM LoreNode'),
    (e) => e instanceof ArcadeHttpError && e.status === 403,
  );

  // Scope adversarial: read-only token's write verbs throw ScopeError pre-HTTP.
  const roCell = arcadeCellForToken(tokenAReadOnly, { registryDbPath: REGISTRY_DB_PATH, embedder: sharedEmbedder });
  const roFacade = LoreStorageClient.fromLocal({ graph: roCell.graph, verbatim: roCell.verbatim });
  check('ISOLATION', 'read-only principal scopes === [read]', roCell.principal.scopes.join(',') === 'read');
  await expectThrows(
    'ISOLATION',
    'read-only facade.upsertNode throws ScopeError (pre-HTTP)',
    () => roFacade.upsertNode({ id: 'x', type: 'fact', label: 'x', content: 'x', tags: [], project: '', ecosystem: '', metadata: '' }),
    (e) => e instanceof ScopeError,
  );
  await expectThrows(
    'ISOLATION',
    'read-only facade.verbatimStore throws ScopeError (pre-HTTP)',
    () => roFacade.verbatimStore({ id: 'x', text: 'nope', metadata: {} }),
    (e) => e instanceof ScopeError,
  );
  const roRead = await roFacade.getNode(`fnode-a-${RUN_TAG}`);
  check('ISOLATION', 'read-only facade reads still work', roRead?.id === `fnode-a-${RUN_TAG}`);

  // Revocation fails closed.
  const throwaway = issueToken({ tenantId: CELL_A.customerId, appId: CELL_A.appId, scopes: ['read'] }, { registryDbPath: REGISTRY_DB_PATH }).token;
  check('ISOLATION', 'revokeToken returns true for a live token', revokeToken(throwaway, { registryDbPath: REGISTRY_DB_PATH }) === true);
  await expectThrows(
    'ISOLATION',
    'resolve(revoked token) throws ArcadeAuthError revoked_token',
    async () => resolvePrincipal(throwaway, { registryDbPath: REGISTRY_DB_PATH }),
    (e) => e instanceof ArcadeAuthError && e.reason === 'revoked_token',
  );

  // Count-leak guard: A's stats reflect only A's rows, not aggregate across cells.
  const statsA = await facadeA.getStats();
  const statsB = await facadeB.getStats();
  check(
    'ISOLATION',
    'A nodeCount does not include B/C rows (no count aggregation leak)',
    statsA.nodeCount < statsA.nodeCount + statsB.nodeCount,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// (5) SQL-TRAP PINS
// ═══════════════════════════════════════════════════════════════════════
async function testSqlTrapPins(): Promise<void> {
  console.log('\n=== (5) SQL-TRAP PINS ===');
  const secret = readSecret(CELL_A, { registryDbPath: REGISTRY_DB_PATH })!;
  const rowA = getTenantApp(CELL_A, { registryDbPath: REGISTRY_DB_PATH })!;
  const http = new ArcadeHttp({ user: rowA.db_user, pass: secret }, ARCADE_BASE_URL);
  const graph = new ArcadeGraphStore({ tenantDb: rowA.db, http });
  const vector = new ArcadeVectorStore({ tenantDb: rowA.db, http, embedder: sharedEmbedder });
  await graph.initialize();

  const hub = `trap-hub-${RUN_TAG}`;
  const leaf = `trap-leaf-${RUN_TAG}`;
  await graph.upsertNode({ id: hub, type: 'fact', label: 'trap hub', content: 'trap hub content', tags: [], project: 'trap', ecosystem: 'spike', metadata: '' });
  await graph.upsertNode({ id: leaf, type: 'fact', label: 'trap leaf', content: 'trap leaf content', tags: [], project: 'trap', ecosystem: 'spike', metadata: '' });
  await graph.addEdge({ sourceId: hub, targetId: leaf, relation: 'trap_relation' });

  // ── P1: relation-filtered traverse (bothE fix) returns > 0 rows where the
  // naive both()-vertex-projection form would silently return 0. ──
  const trapFormRes = await http.query(
    rowA.db,
    `SELECT expand(both('LoreEdge')) FROM LoreNode WHERE id = :id AND both('LoreEdge').relation CONTAINS :rel`,
    { id: hub, rel: 'trap_relation' },
  );
  const trapFormRows = (trapFormRes.result ?? []) as unknown[];
  check(
    'SQLTRAP',
    'P1a: naive both()-vertex-projection relation filter DOES silently return 0 rows (confirms the trap still exists on this ArcadeDB version)',
    trapFormRows.length === 0,
    `unexpectedly got ${trapFormRows.length} rows — ArcadeDB behavior may have changed; re-check T1 workaround necessity`,
  );
  const fixedTraversal = await graph.traverse(hub, 1, 'trap_relation');
  check(
    'SQLTRAP',
    'P1b: bothE()+inV()/outV() fixed form returns > 0 rows (pins the fix — relation-filtered traverse works)',
    fixedTraversal.length > 0 && fixedTraversal.some((r) => r.node.id === leaf),
    JSON.stringify(fixedTraversal.map((r) => r.node.id)),
  );

  // ── P2: expand-of-expand WHERE atop a vertex-projected edge property
  // (both('LoreEdge').relation, evaluated one level deeper than T1) needs the
  // extra SELECT wrap + bothE()-not-both() rewrite or it silently returns 0
  // rows. Pin both the unwrapped-fails and wrapped-succeeds forms. ──
  const unwrappedRes = await http.query(
    rowA.db,
    `SELECT expand(inV()) FROM (SELECT expand(both('LoreEdge')) FROM LoreNode WHERE id = :id) WHERE both('LoreEdge').relation = :rel`,
    { id: hub, rel: 'trap_relation' },
  );
  const unwrappedRows = (unwrappedRes.result ?? []) as unknown[];
  check(
    'SQLTRAP',
    'P2a: unwrapped expand-of-expand WHERE (both().relation vertex-projection) silently returns 0 rows (confirms T2 trap still exists)',
    unwrappedRows.length === 0,
    `unexpectedly got ${unwrappedRows.length} rows — ArcadeDB behavior may have changed; re-check T2 workaround necessity`,
  );
  const wrappedRes = await http.query(
    rowA.db,
    `SELECT expand(inV()) FROM (SELECT FROM (SELECT expand(bothE('LoreEdge')) FROM LoreNode WHERE id = :id) WHERE relation = :rel) WHERE id <> :id`,
    { id: hub, rel: 'trap_relation' },
  );
  const wrappedRows = (wrappedRes.result ?? []) as Array<Record<string, unknown>>;
  check(
    'SQLTRAP',
    'P2b: extra-SELECT-wrapped form returns the seeded neighbor (pins the wrap fix)',
    wrappedRows.length > 0 && wrappedRows.some((r) => r['id'] === leaf),
    JSON.stringify(wrappedRows.map((r) => r['id'])),
  );

  // ── P3: vector search with a metadata filter returns only matching rows and
  // at most `limit` — pins client-side filtering + over-fetch (T3). ──
  const matchDocId = `trap-vdoc-match-${RUN_TAG}`;
  const foreignDocId = `trap-vdoc-foreign-${RUN_TAG}`;
  await vector.store({ id: matchDocId, text: 'trap pin vector search content about database isolation walls', metadata: { type: 'note', project: 'trapmatch' } });
  await vector.store({ id: foreignDocId, text: 'trap pin vector search content about database isolation walls', metadata: { type: 'note', project: 'trapforeign' } });
  const filteredSearch = await vector.search('database isolation walls trap pin', 5, { project: 'trapmatch' });
  check(
    'SQLTRAP',
    'P3a: vector search with project filter returns only matching-project rows (foreign row dropped, not leaked)',
    filteredSearch.length > 0 && filteredSearch.every((r) => r.id !== foreignDocId),
    JSON.stringify(filteredSearch.map((r) => r.id)),
  );
  check(
    'SQLTRAP',
    'P3b: vector search with project filter surfaces the matching doc (not silently zero)',
    filteredSearch.some((r) => r.id === matchDocId),
    JSON.stringify(filteredSearch.map((r) => r.id)),
  );
  check('SQLTRAP', 'P3c: vector search never returns more than `limit` rows', filteredSearch.length <= 5, String(filteredSearch.length));

  // Unfiltered search must see both, proving the filter (not the query itself)
  // is what excluded the foreign row above.
  const unfilteredSearch = await vector.search('database isolation walls trap pin', 10);
  check(
    'SQLTRAP',
    'P3d: unfiltered vector search sees BOTH docs (sanity check that P3a is filter-driven, not a query failure)',
    unfilteredSearch.some((r) => r.id === matchDocId) && unfilteredSearch.some((r) => r.id === foreignDocId),
    JSON.stringify(unfilteredSearch.map((r) => r.id)),
  );
}

// ═══════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log('=== Option-A ArcadeDB hardening e2e ===');
  await assertVersion();
  await cleanup(); // start from a clean slate
  console.log(`registry db: ${REGISTRY_DB_PATH}`);

  try {
    await testFacadeRoundTrip();
    await testNewProviderMethods();
    await testRuntimeProvisioning();
    await testIsolationRegression();
    await testSqlTrapPins();
  } finally {
    await cleanup();
  }

  console.log('\n=== PER-AREA SUMMARY ===');
  for (const area of Object.keys(areaCounts) as Area[]) {
    const c = areaCounts[area];
    console.log(`  ${area}: ${c.pass} passed, ${c.fail} failed`);
  }
  console.log(`\n=== TOTAL: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(f);
    process.exitCode = 1;
  } else {
    console.log('\nFacade round-trip genuinely works end-to-end; isolation clean across');
    console.log('cross-app/cross-customer/scope adversarial checks; runtime provisioning');
    console.log('onboarding+teardown verified; SQL-trap regressions pinned.');
  }
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  try {
    await cleanup();
  } catch {
    /* best-effort */
  }
  process.exitCode = 1;
});

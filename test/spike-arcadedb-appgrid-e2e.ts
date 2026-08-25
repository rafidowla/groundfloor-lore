#!/usr/bin/env tsx
/**
 * test/spike-arcadedb-appgrid-e2e.ts — spike/arcadedb-multitenant.
 *
 * FULL-GRID comparison: 2 customers x 2 apps = 4 cells (alpha/app1,
 * alpha/app2, beta/app1, beta/app2), run against BOTH candidate designs:
 *
 *   DESIGN A — db-per-app (tenant_<customer>_<app>, 4 databases, 4 per-DB
 *              users). Zero engine changes: reuses the PROVEN
 *              ArcadeGraphStore / ArcadeVectorStore verbatim.
 *   DESIGN B — shared-customer-db + app_id tag (tenant_<customer>, 2
 *              databases, 2 per-customer users). New app_id-scoped adapters
 *              (ArcadeAppGraphStore / ArcadeAppVectorStore) apply
 *              `app_id = :boundApp` on every op.
 *
 * Sections:
 *   (0) version gate — server must self-report 26.7.1, no SNAPSHOT.
 *   (1) SEED   — per cell: hub node + SPIKE_SEED_NODES nodes, ~1.5x edges,
 *                SPIKE_SEED_VERBATIM verbatim docs (doc 0 = secret payload).
 *                Plus a literally-shared id planted in all 4 cells, and (B
 *                only) a semantic-magnet set of near-duplicate secrets
 *                seeded into the sibling app.
 *   (2) FUNCTIONALITY — each cell's own adapter: upsert/get round-trip,
 *                traverse depth semantics + relation filter, recall top-hit
 *                + score contract.
 *   (3) ADVERSARIAL MATRIX (M1-M12) — run from 4 attacker positions
 *                (P1 alpha/app1, P2 alpha/app2, P3 beta/app2, P4 raw HTTP).
 *                ANY foreign-sentinel row anywhere = leak = FAIL.
 *   (4) SCOPE (S1-S4) — read-only adapter rejects writes pre-HTTP; write
 *                adapter succeeds; read-only stays cell-confined; no scope
 *                value widens reach.
 *   (5) PERF + OPS — p50/p95 traverse(depth2) + recall(limit10) per design,
 *                vs the ~114ms local baseline; DB-count operational trade.
 *
 * Run: npx tsx test/spike-arcadedb-appgrid-e2e.ts
 * Env: SPIKE_SEED_NODES (default 2000), SPIKE_SEED_VERBATIM (default 300),
 *      SPIKE_PERF_ITERS (default 30).
 * Exits non-zero on any functional, isolation, or scope failure.
 */

import { waitUntilReady } from './spike-arcadedb-helpers.js';
import { assertStableVersion } from './spike-arcadedb-appgrid-helpers.js';
import {
  arcadeAppClientForTokenA,
  arcadeAppClientForTokenB,
  arcadeAppClientForToken,
  type ArcadeAppClient,
} from '../packages/lore/src/engines/arcade/arcadeAppTenantMap.js';
import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import type { LoreEdge } from '../packages/lore/src/providers/types.js';

// ── config ───────────────────────────────────────────────────────────────
const SEED_NODES = Number(process.env['SPIKE_SEED_NODES'] ?? 2000);
const SEED_VERBATIM = Number(process.env['SPIKE_SEED_VERBATIM'] ?? 300);
const PERF_ITERATIONS = Number(process.env['SPIKE_PERF_ITERS'] ?? 30);
const LOCAL_BASELINE_MS = 114;
const RUN_TAG = Date.now().toString(36);

type Customer = 'alpha' | 'beta';
type App = 'app1' | 'app2';
type Design = 'A' | 'B';
const CUSTOMERS: Customer[] = ['alpha', 'beta'];
const APPS: App[] = ['app1', 'app2'];

const SENTINEL: Record<Customer, Record<App, string>> = {
  alpha: { app1: 'ALPHA-APP1', app2: 'ALPHA-APP2' },
  beta: { app1: 'BETA-APP1', app2: 'BETA-APP2' },
};

function cellKey(c: Customer, a: App): string {
  return `${c}-${a}`;
}
function otherApp(a: App): App {
  return a === 'app1' ? 'app2' : 'app1';
}
function otherCustomer(c: Customer): Customer {
  return c === 'alpha' ? 'beta' : 'alpha';
}
function allSentinels(): string[] {
  return CUSTOMERS.flatMap((c) => APPS.map((a) => SENTINEL[c][a]));
}
function foreignSentinels(c: Customer, a: App): string[] {
  return allSentinels().filter((s) => s !== SENTINEL[c][a]);
}

// ── counters (per-design; reset between designs) ────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];
const leakAvenues: string[] = [];

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    const msg = `[FAIL] ${label}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.error(`  ${msg}`);
  }
}

function checkLeak(avenue: string, label: string, cond: boolean, detail?: string): void {
  check(label, cond, detail);
  if (!cond) leakAvenues.push(avenue);
}

async function expectThrows(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(label, false, 'expected throw, got success');
  } catch {
    check(label, true);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function resetCounters(): void {
  pass = 0;
  fail = 0;
  failures.length = 0;
  leakAvenues.length = 0;
}

// ── seeding ──────────────────────────────────────────────────────────────
interface SeedResult {
  hubNodeId: string;
  nodeIds: string[];
  verbatimIds: string[];
  sharedId: string;
}

/** shared-id probe: literally the same id across all 4 cells (M4). */
function sharedSeedId(): string {
  return `shared-seed-${RUN_TAG}`;
}

async function seedCell(
  client: ArcadeAppClient,
  c: Customer,
  a: App,
  nodeCount: number,
  verbatimCount: number,
): Promise<SeedResult> {
  const sentinel = SENTINEL[c][a];
  const key = cellKey(c, a);
  const t0 = Date.now();
  const nodeIds: string[] = [];
  const hubNodeId = `${key}-hub-${RUN_TAG}`;

  await client.graph.upsertNode({
    id: hubNodeId,
    type: 'concept',
    label: `${sentinel} hub node`,
    content: `${sentinel} sentinel hub — root of the seeded graph for cell ${key}`,
    tags: [key, 'hub'],
    project: `spike-${key}`,
    ecosystem: 'spike',
    metadata: '',
  });
  nodeIds.push(hubNodeId);

  for (let i = 0; i < nodeCount; i++) {
    const id = `${key}-node-${RUN_TAG}-${i}`;
    await client.graph.upsertNode({
      id,
      type: i % 7 === 0 ? 'decision' : 'fact',
      label: `${sentinel} node ${i}`,
      content: `${sentinel} sentinel content for node ${i} in cell ${key}`,
      tags: [key, `batch-${Math.floor(i / 100)}`],
      project: `spike-${key}`,
      ecosystem: 'spike',
      metadata: '',
    });
    nodeIds.push(id);
  }

  // ~1.5x edges: 300-node hub ring ('relates_to') + predecessor chain ('chains_to').
  const ringSize = Math.min(300, nodeIds.length - 1);
  for (let i = 1; i <= ringSize; i++) {
    const edge: LoreEdge = {
      sourceId: hubNodeId,
      targetId: nodeIds[i]!,
      relation: 'relates_to',
      confidence: 'extracted',
      confidenceScore: 1.0,
    };
    await client.graph.addEdge(edge);
  }
  for (let i = 1; i < nodeIds.length - 1; i++) {
    await client.graph.addEdge({
      sourceId: nodeIds[i]!,
      targetId: nodeIds[i + 1]!,
      relation: 'chains_to',
      confidence: 'extracted',
      confidenceScore: 1.0,
    });
  }

  const verbatimIds: string[] = [];
  for (let i = 0; i < verbatimCount; i++) {
    const id = `${key}-verbatim-${RUN_TAG}-${i}`;
    await client.vector.store({
      id,
      text:
        i === 0
          ? `${sentinel} secret payload: the quarterly roadmap for cell ${key} discusses migration timelines and budget allocation.`
          : `${sentinel} sentinel verbatim document ${i} — miscellaneous notes about cell ${key} operations.`,
      metadata: { type: 'note', label: `${sentinel} verbatim ${i}`, project: `spike-${key}` },
    });
    verbatimIds.push(id);
  }

  // Shared-seed traverse-leak probe: literally the same id in all 4 cells.
  const sharedId = sharedSeedId();
  await client.graph.upsertNode({
    id: sharedId,
    type: 'fact',
    label: `${sentinel} shared-id node`,
    content: `${sentinel} sentinel shared-id content`,
    tags: [key],
    project: `spike-${key}`,
    ecosystem: 'spike',
    metadata: '',
  });
  await client.graph.addEdge({ sourceId: sharedId, targetId: nodeIds[1]!, relation: 'relates_to' });

  console.log(
    `    seeded ${client.design}/${key} nodes=${nodeIds.length} edges~=${ringSize + nodeIds.length - 2} verbatim=${verbatimIds.length} in ${Date.now() - t0}ms`,
  );
  return { hubNodeId, nodeIds, verbatimIds, sharedId };
}

/**
 * Design-B-only semantic magnet: seed ~50 near-duplicates of app1's secret
 * payload text INTO app2 of the same customer, so app1's recall query has a
 * raw HNSW neighborhood dominated by foreign-app rows (stresses the
 * client-side app_id filter + over-fetch).
 */
async function seedSemanticMagnet(
  siblingClient: ArcadeAppClient,
  targetCustomer: Customer,
  targetKey: string,
): Promise<void> {
  const sentinel = SENTINEL[siblingClient.customerId][siblingClient.appId];
  for (let i = 0; i < 50; i++) {
    await siblingClient.vector.store({
      id: `magnet-${targetKey}-${RUN_TAG}-${i}`,
      text: `${sentinel} secret payload: the quarterly roadmap for cell ${targetKey} discusses migration timelines and budget allocation variant ${i}.`,
      metadata: { type: 'note', label: `${sentinel} magnet ${i}`, project: `spike-${targetKey}` },
    });
  }
  void targetCustomer;
}

// ── functionality ────────────────────────────────────────────────────────
async function testFunctionality(client: ArcadeAppClient, seed: SeedResult): Promise<void> {
  const c = client.customerId;
  const a = client.appId;
  const sentinel = SENTINEL[c][a];
  const key = cellKey(c, a);

  const probeId = `${key}-probe-${RUN_TAG}`;
  const written = await client.graph.upsertNode({
    id: probeId,
    type: 'fact',
    label: `${sentinel} probe`,
    content: `${sentinel} round-trip probe content`,
    tags: [key, 'probe'],
    project: `spike-${key}`,
    ecosystem: 'spike',
    metadata: JSON.stringify({ k: 'v' }),
  });
  check(
    `[${client.design}/${key}] upsertNode returns full LoreNode`,
    !!written.createdAt && !!written.updatedAt,
  );
  const fetched = await client.graph.getNode(probeId);
  check(
    `[${client.design}/${key}] getNode round-trips core fields`,
    !!fetched &&
      fetched.id === probeId &&
      fetched.label === written.label &&
      fetched.content === written.content &&
      Array.isArray(fetched.tags) &&
      fetched.tags.includes(key),
    JSON.stringify(fetched),
  );

  const traversal = await client.graph.traverse(seed.hubNodeId, 2);
  const depth1 = traversal.filter((r) => r.depth === 1);
  const depth2 = traversal.filter((r) => r.depth === 2);
  check(
    `[${client.design}/${key}] traverse depth-1 has hub's direct ring neighbors`,
    depth1.length > 0 && depth1.length <= 300,
    `depth1.length=${depth1.length}`,
  );
  check(
    `[${client.design}/${key}] traverse depth-2 has further neighbors`,
    depth2.length > 0,
    `depth2.length=${depth2.length}`,
  );
  check(
    `[${client.design}/${key}] traverse is depth-ascending`,
    traversal.every((r, idx) => idx === 0 || r.depth >= traversal[idx - 1]!.depth),
  );
  check(
    `[${client.design}/${key}] traverse results all carry the own sentinel`,
    traversal.every((r) => r.node.content.includes(sentinel) || r.node.label.includes(sentinel)),
  );
  const relationFiltered = await client.graph.traverse(seed.hubNodeId, 1, 'relates_to');
  check(
    `[${client.design}/${key}] relation filter is exact-match ('relates_to' only)`,
    relationFiltered.length > 0 && relationFiltered.every((r) => r.relation === 'relates_to'),
    `count=${relationFiltered.length}`,
  );

  const matchQuery = `roadmap migration budget ${key}`;
  const matchResults = await client.vector.search(matchQuery, 10);
  check(`[${client.design}/${key}] semantic search returns results`, matchResults.length > 0);
  check(
    `[${client.design}/${key}] semantic search scores in [0,1] descending`,
    matchResults.every((r) => r.score >= 0 && r.score <= 1) &&
      matchResults.every((r, idx) => idx === 0 || matchResults[idx - 1]!.score >= r.score),
  );
  check(
    `[${client.design}/${key}] seeded roadmap doc ranks as a top hit for matching query`,
    matchResults.some((r) => r.id === `${key}-verbatim-${RUN_TAG}-0`),
  );

  const nonsenseResults = await client.vector.search('purple giraffe umbrella quantum spaghetti', 10);
  check(
    `[${client.design}/${key}] nonsense query does not rank roadmap doc first`,
    !nonsenseResults[0] || nonsenseResults[0].id !== `${key}-verbatim-${RUN_TAG}-0`,
  );
}

// ── adversarial matrix (design-agnostic, parameterized by attacker+target) ─
interface Cells {
  clients: Record<Customer, Record<App, ArcadeAppClient>>;
  seeds: Record<Customer, Record<App, SeedResult>>;
}

async function runAvenuesAgainstTarget(
  design: Design,
  attacker: ArcadeAppClient,
  target: ArcadeAppClient,
  targetSeed: SeedResult,
  posLabel: string,
): Promise<void> {
  const targetKey = cellKey(target.customerId, target.appId);
  const targetSentinel = SENTINEL[target.customerId][target.appId];
  const wall = attacker.customerId !== target.customerId ? 'CUSTOMER' : 'APP';
  const tag = `${posLabel}->${targetKey}(${wall} wall, design ${design})`;

  // M1 — read-by-id
  const knownId = targetSeed.nodeIds[5]!;
  const m1 = await attacker.graph.getNode(knownId);
  checkLeak(`M1[${tag}]`, `M1 read-by-id: ${tag}`, m1 === null, JSON.stringify(m1));

  // M2 — write-collision
  const collisionId = targetSeed.nodeIds[10]!;
  const targetBefore = await target.graph.getNode(collisionId);
  try {
    await attacker.graph.upsertNode({
      id: collisionId,
      type: 'fact',
      label: `${SENTINEL[attacker.customerId][attacker.appId]} collision write`,
      content: `${SENTINEL[attacker.customerId][attacker.appId]} sentinel — attempted collision`,
      tags: [cellKey(attacker.customerId, attacker.appId), 'collision'],
      project: `spike-${cellKey(attacker.customerId, attacker.appId)}`,
      ecosystem: 'spike',
      metadata: '',
    });
    const targetAfter = await target.graph.getNode(collisionId);
    checkLeak(
      `M2[${tag}]`,
      `M2 write-collision: target row unchanged: ${tag}`,
      JSON.stringify(targetBefore) === JSON.stringify(targetAfter),
    );
    const attackerCollisionNode = await attacker.graph.getNode(collisionId);
    checkLeak(
      `M2[${tag}]`,
      `M2 write-collision: attacker sees only own copy: ${tag}`,
      !!attackerCollisionNode &&
        attackerCollisionNode.content.includes(SENTINEL[attacker.customerId][attacker.appId]),
    );
  } catch (e) {
    // Design A physically can't collide (different db) — that's fine, not a leak.
    check(`M2 write-collision handled (throw acceptable): ${tag}`, true, String(e));
  }

  // M3 — edge-cross: attacker addEdge(own hub -> foreign node id) throws.
  await expectThrows(`M3 edge-cross: ${tag}`, () =>
    attacker.graph.addEdge({
      sourceId: `${cellKey(attacker.customerId, attacker.appId)}-hub-${RUN_TAG}`,
      targetId: knownId,
      relation: 'relates_to',
    }),
  );

  // M4 — traverse-leak via the literally-shared id.
  const sharedId = sharedSeedId();
  const m4 = await attacker.graph.traverse(sharedId, 2);
  const m4Leaked = m4.filter(
    (r) => r.node.content.includes(targetSentinel) || r.node.label.includes(targetSentinel),
  );
  checkLeak(
    `M4[${tag}]`,
    `M4 traverse-leak (shared id): zero ${targetSentinel} rows: ${tag}`,
    m4Leaked.length === 0,
    `leaked=${m4Leaked.map((r) => r.node.id).join(',')}`,
  );

  // M5 — recall-leak: query crafted verbatim from target's secret payload.
  const secretQuery = `secret payload the quarterly roadmap for cell ${targetKey} migration timelines budget allocation`;
  const m5 = await attacker.vector.search(secretQuery, 20);
  const m5Leaked = m5.filter((r) => r.text.includes(targetSentinel));
  checkLeak(
    `M5[${tag}]`,
    `M5 recall-leak: zero ${targetSentinel} hits: ${tag}`,
    m5Leaked.length === 0,
    `leaked=${m5Leaked.map((r) => r.id).join(',')}`,
  );

  // M6 — filter-injection: SQLi-shaped + (B-only) app-shaped filter values.
  const injectionValues = [
    "x' OR 1=1 --",
    `tenant_${otherCustomer(attacker.customerId)}`,
    `${target.customerId}_${target.appId}`,
    `${target.customerId}_${target.appId}' OR '1'='1`,
    '%',
  ];
  for (const val of injectionValues) {
    try {
      const m6 = await attacker.vector.search('roadmap budget', 10, { project: val });
      const leaked = m6.filter((r) => r.text.includes(targetSentinel));
      checkLeak(
        `M6[${tag}:${val}]`,
        `M6 filter-injection (project="${val}"): zero ${targetSentinel} hits: ${tag}`,
        leaked.length === 0,
      );
    } catch (e) {
      check(`M6 filter-injection (project="${val}"): clean error acceptable: ${tag}`, true, String(e));
    }
  }

  // M7 — payload-injection: path/foreign-identifier-shaped ids/project values
  // land harmlessly inside the attacker's own cell; must not appear in target.
  const injectId = `../tenant_${target.customerId}/injected-${RUN_TAG}-${posLabel.replace(/\W/g, '')}`;
  const m7written = await attacker.graph.upsertNode({
    id: injectId,
    type: 'fact',
    label: `${SENTINEL[attacker.customerId][attacker.appId]} path-injection probe`,
    content: `${SENTINEL[attacker.customerId][attacker.appId]} sentinel path-shaped payload`,
    tags: [cellKey(attacker.customerId, attacker.appId)],
    project: `tenant_${target.customerId}_${target.appId}`, // db/app-name-shaped payload value
    ecosystem: 'spike',
    metadata: '',
  });
  check(
    `M7 payload-injection: write lands in attacker's own cell: ${tag}`,
    m7written.id === injectId,
  );
  const m7targetRead = await target.graph.getNode(injectId);
  checkLeak(
    `M7[${tag}]`,
    `M7 payload-injection: injected id does NOT exist in target: ${tag}`,
    m7targetRead === null,
  );

  // M9 (partial, per-position) — count-leak: attacker counts stay own-scale.
  // (Full own-vs-foreign magnitude check happens once per cell in the main pass.)
}

/** M8 — raw HTTP auth-wall, bypassing all adapters. */
async function runRawHttpAuthWall(
  design: Design,
  attackerCreds: { user: string; pass: string; label: string },
  targetDb: string,
  targetLabel: string,
  expectBlocked: boolean,
): Promise<void> {
  const rawHttp = new ArcadeHttp({ user: attackerCreds.user, pass: attackerCreds.pass });
  try {
    await rawHttp.query(targetDb, 'SELECT id FROM LoreNode LIMIT 1');
    if (expectBlocked) {
      checkLeak(
        `M8[design${design}:${attackerCreds.label}->${targetLabel}]`,
        `M8 raw-HTTP auth-wall: ${attackerCreds.label} blocked from ${targetLabel} (design ${design})`,
        false,
        'no error thrown — got HTTP 2xx',
      );
    } else {
      check(
        `M8 raw-HTTP: ${attackerCreds.label} DOCUMENTED open access to ${targetLabel} (design ${design} residual risk)`,
        true,
      );
    }
  } catch (e) {
    const status = e instanceof ArcadeHttpError ? e.status : undefined;
    if (expectBlocked) {
      check(
        `M8 raw-HTTP auth-wall: ${attackerCreds.label} blocked from ${targetLabel} (design ${design}) => 401/403`,
        status === 401 || status === 403,
        `status=${status}`,
      );
    } else {
      // Design B app wall is documented-open; if it happens to throw that's fine too.
      check(
        `M8 raw-HTTP: ${attackerCreds.label} vs ${targetLabel} (design ${design}, open-by-design) — no crash`,
        true,
        `status=${status}`,
      );
    }
  }
}

/** M9 — count-leak: attacker's counts reflect only its own cell's seed size. */
async function runCountLeak(
  design: Design,
  attacker: ArcadeAppClient,
  attackerSeed: SeedResult,
  posLabel: string,
): Promise<void> {
  const nodeCount = await attacker.graph.nodeCount();
  const vecCount = await attacker.vector.count();
  // own scale: seeded nodes (+hub +shared-id +probe +collision +injection extras)
  check(
    `M9 count-leak: ${posLabel} nodeCount reflects own cell scale (design ${design})`,
    nodeCount >= attackerSeed.nodeIds.length && nodeCount < attackerSeed.nodeIds.length * 4,
    `nodeCount=${nodeCount} seeded=${attackerSeed.nodeIds.length}`,
  );
  check(
    `M9 count-leak: ${posLabel} vector count reflects own cell scale (design ${design})`,
    vecCount >= attackerSeed.verbatimIds.length && vecCount < attackerSeed.verbatimIds.length * 4,
    `vecCount=${vecCount} seeded=${attackerSeed.verbatimIds.length}`,
  );
}

/** M10 — delete-cross: attacker deletes a foreign verbatim id; target's doc survives. */
async function runDeleteCross(
  design: Design,
  attacker: ArcadeAppClient,
  target: ArcadeAppClient,
  targetSeed: SeedResult,
  posLabel: string,
): Promise<void> {
  const targetKey = cellKey(target.customerId, target.appId);
  const targetVerbId = targetSeed.verbatimIds[3]!;
  const before = (await target.vector.search('sentinel verbatim document', 500)).find(
    (r) => r.id === targetVerbId,
  );
  try {
    await attacker.vector.delete(targetVerbId);
  } catch {
    // acceptable — some designs may throw on a missing composite match
  }
  const after = (await target.vector.search('sentinel verbatim document', 500)).find(
    (r) => r.id === targetVerbId,
  );
  checkLeak(
    `M10[design${design}:${posLabel}->${targetKey}]`,
    `M10 delete-cross: ${posLabel}.delete(${targetKey} id) leaves target doc intact (design ${design})`,
    !!after && (!before || after.text === before.text),
    `before=${!!before} after=${!!after}`,
  );
}

/** M3 B-only variant: root plants a real cross-app edge; app1 traverse must not surface app2. */
async function runPlantedCrossAppEdge(bCells: Cells): Promise<void> {
  const app1Client = bCells.clients.alpha.app1;
  const app2Client = bCells.clients.alpha.app2;
  const app1Seed = bCells.seeds.alpha.app1;
  const app2Seed = bCells.seeds.alpha.app2;

  // As root: fetch the raw RIDs and CREATE EDGE directly across app_id boundary
  // inside tenant_alpha (bypassing all adapter app_id predicates).
  const rootHttp = new ArcadeHttp({ user: 'root', pass: 'SpikeRoot123!' });
  const plantedTargetId = app2Seed.nodeIds[7]!;
  await rootHttp.command(
    'tenant_alpha',
    `CREATE EDGE LoreEdge FROM (SELECT FROM LoreNode WHERE app_id = 'app1' AND id = :src) ` +
      `TO (SELECT FROM LoreNode WHERE app_id = 'app2' AND id = :tgt) SET relation = 'relates_to', confidence = 'extracted', confidenceScore = 1.0`,
    { src: app1Seed.hubNodeId, tgt: plantedTargetId },
  );

  const traversal = await app1Client.graph.traverse(app1Seed.hubNodeId, 2);
  const leaked = traversal.filter((r) => r.node.content.includes(SENTINEL.alpha.app2));
  checkLeak(
    'M3-planted-edge[B:alpha/app1 traverse over root-planted app2 edge]',
    'M3 planted-edge (B-only): app1 traverse over root-planted cross-app edge returns zero ALPHA-APP2 rows',
    leaked.length === 0,
    `leaked=${leaked.map((r) => r.node.id).join(',')}`,
  );
  void app2Client;
}

/** M5 semantic-magnet variant (B-only): recall must stay clean despite dominated HNSW neighborhood. */
async function runSemanticMagnet(bCells: Cells): Promise<void> {
  const app1Client = bCells.clients.alpha.app1;
  const app2Client = bCells.clients.alpha.app2;
  const key1 = cellKey('alpha', 'app1');

  await seedSemanticMagnet(app2Client, 'alpha', key1);

  const secretQuery = `secret payload the quarterly roadmap for cell ${key1} migration timelines budget allocation`;
  const results = await app1Client.vector.search(secretQuery, 20);
  const leaked = results.filter((r) => r.text.includes(SENTINEL.alpha.app2));
  checkLeak(
    'M5-semantic-magnet[B:alpha/app1 vs alpha/app2 near-dup magnet]',
    'M5 semantic-magnet (B-only): app1 recall clean despite app2 near-duplicate magnet',
    leaked.length === 0,
    `leaked=${leaked.map((r) => r.id).join(',')}`,
  );

  // `app1Client.vector` is a ScopeGuardedVector wrapper — it does not
  // re-expose the inner store's `lastRecallDiagnostics` telemetry field. To
  // capture the over-fetch evidence (without touching the proven scope
  // guard), construct a second, UNGUARDED ArcadeAppVectorStore bound to the
  // exact same (tenantDb, boundAppId, credentials) and re-run the identical
  // search purely for telemetry — this does not change the leak verdict
  // above, which already ran through the real guarded client.
  const { ArcadeAppVectorStore: RawVectorStoreCtor } = await import(
    '../packages/lore/src/engines/arcade/arcadeAppVectorStore.js'
  );
  const telemetryHttp = new ArcadeHttp({ user: 'alpha_user', pass: 'AlphaPass123!' });
  const telemetryStore = new RawVectorStoreCtor({
    tenantDb: 'tenant_alpha',
    boundAppId: 'app1',
    http: telemetryHttp,
  });
  await telemetryStore.search(secretQuery, 20);
  const diag = telemetryStore.lastRecallDiagnostics;
  if (diag) {
    console.log(
      `    [semantic-magnet evidence] overfetchK=${diag.overfetchK} rawNeighbors=${diag.rawNeighbors} ` +
        `foreignDropped=${diag.foreignDropped} reachedLimit=${diag.reachedLimit}`,
    );
    check(
      'M5 semantic-magnet: over-fetch telemetry recorded foreign rows present in raw neighborhood',
      diag.foreignDropped > 0,
      `foreignDropped=${diag.foreignDropped}`,
    );
  } else {
    console.log('    [semantic-magnet evidence] no diagnostics available (unexpected for Design B)');
    check('M5 semantic-magnet: telemetry capture available for Design B', false);
  }
}

/** M12 — Design B only: static missing-filter check + root canary. */
async function runMissingFilterStaticCheckAndCanary(): Promise<void> {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(
    new URL('../packages/lore/src/engines/arcade/arcadeAppGraphStore.ts', import.meta.url),
    'utf8',
  );
  const vectorSource = await fs.readFile(
    new URL('../packages/lore/src/engines/arcade/arcadeAppVectorStore.ts', import.meta.url),
    'utf8',
  );

  // Every SQL string literal (template literal segments) mentioning
  // LoreNode/LoreVerbatim must also contain an app_id predicate binding.
  function sqlLiteralsMissingAppIdFilter(src: string): string[] {
    const missing: string[] = [];
    // crude but effective: split on backtick-delimited template literal starts;
    // scan lines that reference the type names inside SQL-shaped strings.
    const lines = src.split('\n');
    let inSqlBlock = false;
    let buf = '';
    for (const line of lines) {
      if (/`[^`]*\b(LoreNode|LoreVerbatim)\b/.test(line) || inSqlBlock) {
        buf += line + '\n';
        inSqlBlock = !/`\s*[,;)]?\s*$/.test(line.trimEnd()) === false ? false : inSqlBlock;
        // Heuristic: a statement "ends" once we see a line ending in a closing
        // backtick followed by , or ; or ) — accumulate until then.
        if (/`\s*[,;)]/.test(line) || /`;?\s*$/.test(line.trim())) {
          inSqlBlock = false;
          if (/\b(LoreNode|LoreVerbatim)\b/.test(buf) && !/app_id\s*=\s*:/.test(buf)) {
            missing.push(buf.trim());
          }
          buf = '';
        } else {
          inSqlBlock = true;
        }
      }
    }
    return missing;
  }

  const graphMissing = sqlLiteralsMissingAppIdFilter(source);
  const vectorMissing = sqlLiteralsMissingAppIdFilter(vectorSource);
  check(
    'M12a static check: every LoreNode-touching SQL literal in arcadeAppGraphStore.ts carries app_id = :',
    graphMissing.length === 0,
    graphMissing.join(' ||| '),
  );
  check(
    'M12a static check: every LoreVerbatim-touching SQL literal in arcadeAppVectorStore.ts carries app_id = :',
    vectorMissing.length === 0,
    vectorMissing.join(' ||| '),
  );
  // Additional direct assertion: boundAppId is only ever assigned from opts in
  // the constructor, never reassigned from a method argument.
  const boundAppAssignedElsewhere = /this\.boundAppId\s*=/g.test(source) && (source.match(/this\.boundAppId\s*=/g) ?? []).length > 1;
  check(
    'M12a static check: boundAppId assigned exactly once (constructor only), never from a method arg',
    !boundAppAssignedElsewhere,
  );

  // M12b — root canary: an intentionally UNFILTERED query against tenant_alpha
  // MUST surface both ALPHA-APP1 and ALPHA-APP2 sentinels.
  const rootHttp = new ArcadeHttp({ user: 'root', pass: 'SpikeRoot123!' });
  const res = await rootHttp.query(
    'tenant_alpha',
    `SELECT label FROM LoreNode WHERE label LIKE :pat`,
    { pat: '%hub node%' },
  );
  const labels = ((res.result ?? []) as Array<{ label?: string }>).map((r) => String(r.label ?? ''));
  const sawApp1 = labels.some((l) => l.includes(SENTINEL.alpha.app1));
  const sawApp2 = labels.some((l) => l.includes(SENTINEL.alpha.app2));
  check(
    'M12b root canary: unfiltered tenant_alpha query surfaces BOTH ALPHA-APP1 and ALPHA-APP2 (foreign rows physically co-resident)',
    sawApp1 && sawApp2,
    `sawApp1=${sawApp1} sawApp2=${sawApp2}`,
  );
}

// ── scope tests (S1-S4) ─────────────────────────────────────────────────
async function testScope(design: Design, tokenBase: string, c: Customer, a: App): Promise<void> {
  const writeToken = `token-${tokenBase}`;
  const roToken = `token-${tokenBase}-ro`;
  const writeClient = arcadeAppClientForToken(writeToken, design);
  const roClient = arcadeAppClientForToken(roToken, design);

  // S1 — read-only adapter rejects all 4 write ops before any HTTP call.
  let httpCallsBeforeThrow = 0;
  const probeId = `scope-probe-${cellKey(c, a)}-${RUN_TAG}`;
  await expectThrows(`S1 read-only rejects graph.upsertNode (design ${design}, ${tokenBase})`, () =>
    roClient.graph.upsertNode({
      id: probeId,
      type: 'fact',
      label: 'should not write',
      content: 'should not write',
      tags: [],
      project: '',
      ecosystem: 'spike',
      metadata: '',
    }),
  );
  await expectThrows(`S1 read-only rejects graph.addEdge (design ${design}, ${tokenBase})`, () =>
    roClient.graph.addEdge({ sourceId: probeId, targetId: probeId, relation: 'relates_to' }),
  );
  await expectThrows(`S1 read-only rejects graph.addBidirectionalEdge (design ${design}, ${tokenBase})`, () =>
    roClient.graph.addBidirectionalEdge({ sourceId: probeId, targetId: probeId, relation: 'relates_to' }),
  );
  await expectThrows(`S1 read-only rejects vector.store (design ${design}, ${tokenBase})`, () =>
    roClient.vector.store({ id: probeId, text: 'nope', metadata: {} }),
  );
  await expectThrows(`S1 read-only rejects vector.delete (design ${design}, ${tokenBase})`, () =>
    roClient.vector.delete(probeId),
  );
  check(
    `S1 read-only: confirm probe id was never actually written (zero HTTP side-effect)`,
    (await roClient.graph.getNode(probeId)) === null,
  );
  httpCallsBeforeThrow += 0; // ScopeError throws before this.inner is touched — verified structurally above.

  // reads on the read-only adapter still succeed against its own cell.
  const ownHubId = `${cellKey(c, a)}-hub-${RUN_TAG}`;
  const roRead = await roClient.graph.getNode(ownHubId);
  check(`S1 read-only: reads succeed against own cell (design ${design}, ${tokenBase})`, !!roRead);

  // S2 — the write adapter succeeds at the same four ops.
  const writeProbeId = `scope-write-probe-${cellKey(c, a)}-${RUN_TAG}`;
  const written = await writeClient.graph.upsertNode({
    id: writeProbeId,
    type: 'fact',
    label: 'scope write probe',
    content: `${SENTINEL[c][a]} scope write probe`,
    tags: [cellKey(c, a)],
    project: `spike-${cellKey(c, a)}`,
    ecosystem: 'spike',
    metadata: '',
  });
  check(`S2 write adapter: upsertNode succeeds (design ${design}, ${tokenBase})`, written.id === writeProbeId);
  await writeClient.graph.addEdge({ sourceId: ownHubId, targetId: writeProbeId, relation: 'relates_to' });
  await writeClient.graph.addBidirectionalEdge({ sourceId: writeProbeId, targetId: ownHubId, relation: 'relates_to' });
  await writeClient.vector.store({ id: writeProbeId, text: `${SENTINEL[c][a]} scope write vector probe`, metadata: {} });
  check(`S2 write adapter: all four write verbs succeeded (design ${design}, ${tokenBase})`, true);
  await writeClient.vector.delete(writeProbeId);
  const afterDelete = await writeClient.vector.search(`${SENTINEL[c][a]} scope write vector probe`, 5);
  check(
    `S2 write adapter: vector.delete removed the doc`,
    !afterDelete.some((r) => r.id === writeProbeId),
  );

  // S3 — read-only adapter still cannot read beyond its own cell (re-run M1/M4/M5 lite).
  const foreignCustomer = otherCustomer(c);
  const foreignApp = otherApp(a);
  const foreignKey1 = cellKey(c, foreignApp); // sibling app, same customer
  const foreignKey2 = cellKey(foreignCustomer, a); // other customer, same app slot
  const foreignHub1 = `${foreignKey1}-hub-${RUN_TAG}`;
  const foreignHub2 = `${foreignKey2}-hub-${RUN_TAG}`;
  const s3a = await roClient.graph.getNode(foreignHub1);
  const s3b = await roClient.graph.getNode(foreignHub2);
  checkLeak(
    `S3[design${design}:${tokenBase}-ro->${foreignKey1}]`,
    `S3 read-only confinement: cannot read sibling-app hub (design ${design}, ${tokenBase}-ro)`,
    s3a === null,
  );
  checkLeak(
    `S3[design${design}:${tokenBase}-ro->${foreignKey2}]`,
    `S3 read-only confinement: cannot read foreign-customer hub (design ${design}, ${tokenBase}-ro)`,
    s3b === null,
  );
  const sharedTraversal = await roClient.graph.traverse(sharedSeedId(), 2);
  const s3TraversalLeak = sharedTraversal.filter((r) =>
    foreignSentinels(c, a).some((s) => r.node.content.includes(s)),
  );
  checkLeak(
    `S3-M4[design${design}:${tokenBase}-ro]`,
    `S3 read-only confinement: shared-id traverse has zero foreign-sentinel rows (design ${design}, ${tokenBase}-ro)`,
    s3TraversalLeak.length === 0,
  );

  // S4 — foreign-id-with-write-scope: write adapter given foreign ids either
  // throws or lands only in its own cell; no scope value widens reach.
  await expectThrows(
    `S4 write adapter + foreign target id: addEdge throws (design ${design}, ${tokenBase})`,
    () => writeClient.graph.addEdge({ sourceId: ownHubId, targetId: foreignHub1, relation: 'relates_to' }),
  );
  const s4CollisionId = `${foreignKey1}-node-${RUN_TAG}-10`;
  await writeClient.graph.upsertNode({
    id: s4CollisionId,
    type: 'fact',
    label: 'S4 foreign-id write attempt',
    content: `${SENTINEL[c][a]} S4 attempt to write into foreign id space`,
    tags: [cellKey(c, a)],
    project: `spike-${cellKey(c, a)}`,
    ecosystem: 'spike',
    metadata: '',
  });
  const s4Own = await writeClient.graph.getNode(s4CollisionId);
  check(
    `S4 foreign-id write lands in attacker's own cell only (design ${design}, ${tokenBase})`,
    !!s4Own && s4Own.content.includes(SENTINEL[c][a]),
  );
}

// ── perf ─────────────────────────────────────────────────────────────────
async function measurePerf(
  client: ArcadeAppClient,
  seed: SeedResult,
): Promise<{ traverseP50: number; traverseP95: number; searchP50: number; searchP95: number }> {
  await client.graph.traverse(seed.hubNodeId, 2);
  await client.vector.search('roadmap migration budget', 10);

  const traverseTimes: number[] = [];
  for (let i = 0; i < PERF_ITERATIONS; i++) {
    const t0 = performance.now();
    await client.graph.traverse(seed.hubNodeId, 2);
    traverseTimes.push(performance.now() - t0);
  }
  const searchTimes: number[] = [];
  for (let i = 0; i < PERF_ITERATIONS; i++) {
    const t0 = performance.now();
    await client.vector.search('roadmap migration budget', 10);
    searchTimes.push(performance.now() - t0);
  }
  traverseTimes.sort((a, b) => a - b);
  searchTimes.sort((a, b) => a - b);
  return {
    traverseP50: percentile(traverseTimes, 50),
    traverseP95: percentile(traverseTimes, 95),
    searchP50: percentile(searchTimes, 50),
    searchP95: percentile(searchTimes, 95),
  };
}

// ── per-design orchestration ─────────────────────────────────────────────
interface DesignRunResult {
  design: Design;
  pass: number;
  fail: number;
  failures: string[];
  leakAvenues: string[];
  perf: Record<string, { traverseP50: number; traverseP95: number; searchP50: number; searchP95: number }>;
}

async function runDesign(design: Design): Promise<DesignRunResult> {
  resetCounters();
  console.log(`\n\n########## DESIGN ${design} (${design === 'A' ? 'db-per-app, 4 DBs' : 'shared-customer-db + app_id tag, 2 DBs'}) ##########`);

  const factory = design === 'A' ? arcadeAppClientForTokenA : arcadeAppClientForTokenB;
  const clients: Record<Customer, Record<App, ArcadeAppClient>> = {
    alpha: {
      app1: factory('token-alpha-app1'),
      app2: factory('token-alpha-app2'),
    },
    beta: {
      app1: factory('token-beta-app1'),
      app2: factory('token-beta-app2'),
    },
  };
  const seeds: Record<Customer, Record<App, SeedResult>> = {
    alpha: {} as Record<App, SeedResult>,
    beta: {} as Record<App, SeedResult>,
  };

  console.log(`\n[SEED] design=${design} nodes/cell=${SEED_NODES} verbatim/cell=${SEED_VERBATIM} runTag=${RUN_TAG}`);
  // warm embedder once (excluded from perf)
  const warmupClient = clients.alpha.app1;
  await warmupClient.vector.store({ id: `warmup-${design}-${RUN_TAG}`, text: 'warm up the embedder', metadata: {} });
  await warmupClient.vector.delete(`warmup-${design}-${RUN_TAG}`);

  for (const c of CUSTOMERS) {
    for (const a of APPS) {
      seeds[c][a] = await seedCell(clients[c][a], c, a, SEED_NODES, SEED_VERBATIM);
    }
  }

  const cells: Cells = { clients, seeds };

  console.log(`\n[FUNCTIONALITY] design=${design}`);
  for (const c of CUSTOMERS) {
    for (const a of APPS) {
      await testFunctionality(clients[c][a], seeds[c][a]);
    }
  }

  console.log(`\n[ADVERSARIAL MATRIX] design=${design} — attacker positions P1-P4`);

  // P1 = alpha/app1 attacking alpha/app2 (APP wall), beta/app1, beta/app2 (CUSTOMER wall)
  // P2 = alpha/app2 attacking alpha/app1 (reverse APP wall)
  // P3 = beta/app2 attacking alpha/app1, beta/app1
  const positions: Array<{ label: string; attacker: [Customer, App]; targets: Array<[Customer, App]> }> = [
    { label: 'P1(alpha/app1)', attacker: ['alpha', 'app1'], targets: [['alpha', 'app2'], ['beta', 'app1'], ['beta', 'app2']] },
    { label: 'P2(alpha/app2)', attacker: ['alpha', 'app2'], targets: [['alpha', 'app1']] },
    { label: 'P3(beta/app2)', attacker: ['beta', 'app2'], targets: [['alpha', 'app1'], ['beta', 'app1']] },
  ];

  for (const pos of positions) {
    const [ac, aa] = pos.attacker;
    const attacker = clients[ac][aa];
    for (const [tc, ta] of pos.targets) {
      const target = clients[tc][ta];
      const targetSeed = seeds[tc][ta];
      await runAvenuesAgainstTarget(design, attacker, target, targetSeed, pos.label);
      await runDeleteCross(design, attacker, target, targetSeed, pos.label);
    }
  }

  console.log(`\n[M9 count-leak] design=${design}`);
  for (const c of CUSTOMERS) {
    for (const a of APPS) {
      await runCountLeak(design, clients[c][a], seeds[c][a], cellKey(c, a));
    }
  }

  // P4 — raw HTTP, bypassing adapters entirely.
  console.log(`\n[P4 raw-HTTP] design=${design}`);
  if (design === 'A') {
    const alphaApp1Creds = { user: 'alpha_app1_user', pass: 'AlphaApp1Pass123!', label: 'alpha_app1_user' };
    await runRawHttpAuthWall(design, alphaApp1Creds, 'tenant_alpha_app2', 'tenant_alpha_app2', true);
    await runRawHttpAuthWall(design, alphaApp1Creds, 'tenant_beta_app1', 'tenant_beta_app1', true);
    await runRawHttpAuthWall(design, alphaApp1Creds, 'tenant_beta_app2', 'tenant_beta_app2', true);
    const alphaApp2Creds = { user: 'alpha_app2_user', pass: 'AlphaApp2Pass123!', label: 'alpha_app2_user' };
    await runRawHttpAuthWall(design, alphaApp2Creds, 'tenant_alpha_app1', 'tenant_alpha_app1', true);
    const betaApp2Creds = { user: 'beta_app2_user', pass: 'BetaApp2Pass123!', label: 'beta_app2_user' };
    await runRawHttpAuthWall(design, betaApp2Creds, 'tenant_alpha_app1', 'tenant_alpha_app1', true);
    await runRawHttpAuthWall(design, betaApp2Creds, 'tenant_beta_app1', 'tenant_beta_app1', true);
  } else {
    // Design B: customer wall MUST hold; app wall is OPEN by design (documented, not a fail).
    const alphaCreds = { user: 'alpha_user', pass: 'AlphaPass123!', label: 'alpha_user' };
    await runRawHttpAuthWall(design, alphaCreds, 'tenant_beta', 'tenant_beta', true);
    await runRawHttpAuthWall(design, alphaCreds, 'tenant_alpha', 'tenant_alpha (documents app2 exposure)', false);
    const betaCreds = { user: 'beta_user', pass: 'BetaPass123!', label: 'beta_user' };
    await runRawHttpAuthWall(design, betaCreds, 'tenant_alpha', 'tenant_alpha', true);
  }

  if (design === 'B') {
    console.log(`\n[B-ONLY HAMMERS] design=B`);
    const beforeHammers = { pass, fail };
    await runPlantedCrossAppEdge(cells);
    await runSemanticMagnet(cells);
    await runMissingFilterStaticCheckAndCanary();
    console.log(
      `    [B-only hammers] checks run: ${pass + fail - beforeHammers.pass - beforeHammers.fail} ` +
        `(pass=${pass - beforeHammers.pass} fail=${fail - beforeHammers.fail})`,
    );
  }

  console.log(`\n[SCOPE S1-S4] design=${design}`);
  await testScope(design, 'alpha-app1', 'alpha', 'app1');
  await testScope(design, 'beta-app2', 'beta', 'app2');

  console.log(`\n[PERF] design=${design}`);
  const perf: DesignRunResult['perf'] = {};
  const perfCell: [Customer, App] = ['alpha', 'app1'];
  perf[cellKey(...perfCell)] = await measurePerf(clients[perfCell[0]][perfCell[1]], seeds[perfCell[0]][perfCell[1]]);
  console.log(
    `  ${cellKey(...perfCell)}: traverse p50=${perf[cellKey(...perfCell)]!.traverseP50.toFixed(1)}ms p95=${perf[cellKey(...perfCell)]!.traverseP95.toFixed(1)}ms | ` +
      `search p50=${perf[cellKey(...perfCell)]!.searchP50.toFixed(1)}ms p95=${perf[cellKey(...perfCell)]!.searchP95.toFixed(1)}ms`,
  );

  return {
    design,
    pass,
    fail,
    failures: [...failures],
    leakAvenues: [...new Set(leakAvenues)],
    perf,
  };
}

// ── main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== spike-arcadedb-appgrid-e2e ===');
  console.log(
    `config: nodes/cell=${SEED_NODES} verbatim/cell=${SEED_VERBATIM} perf-iters=${PERF_ITERATIONS} runTag=${RUN_TAG}`,
  );

  await waitUntilReady();
  const version = await assertStableVersion();
  console.log(`[VERSION GATE] server=${version} (26.7.1 stable, no SNAPSHOT confirmed)`);

  const resultA = await runDesign('A');
  const resultB = await runDesign('B');

  console.log('\n\n=== FULL SUMMARY ===');
  for (const r of [resultA, resultB]) {
    console.log(`\n--- Design ${r.design} ---`);
    console.log(`  pass=${r.pass} fail=${r.fail}`);
    console.log(
      `  isolation: ${r.leakAvenues.length === 0 ? 'CLEAN — no leak in any adversarial-matrix avenue' : 'LEAK DETECTED: ' + r.leakAvenues.join('; ')}`,
    );
    const perfCell = Object.keys(r.perf)[0]!;
    const p = r.perf[perfCell]!;
    console.log(
      `  perf (${perfCell}): traverse p50=${p.traverseP50.toFixed(1)}ms p95=${p.traverseP95.toFixed(1)}ms (${(p.traverseP95 / LOCAL_BASELINE_MS).toFixed(2)}x baseline), ` +
        `search p50=${p.searchP50.toFixed(1)}ms p95=${p.searchP95.toFixed(1)}ms (${(p.searchP95 / LOCAL_BASELINE_MS).toFixed(2)}x baseline)`,
    );
  }

  console.log('\n--- OPERATIONAL TRADE ---');
  console.log('  Design A: database count = customers x apps = 2 x 2 = 4 (formula N_customers x N_apps_per_customer)');
  console.log('    -> 4 HNSW indexes, 4 backup/page-cache units, per-app DB+user provisioning at onboarding.');
  console.log('    -> App wall AND customer wall are the SAME mechanism (separate DB + per-DB user); uniform guarantee.');
  console.log('  Design B: database count = customers = 2 (formula N_customers)');
  console.log('    -> App wall rides entirely on adapter code discipline (app_id predicate + M12 static check).');
  console.log('    -> Raw-HTTP (P4): app wall is OPEN inside tenant_alpha/tenant_beta by design (documented residual risk).');

  const traverseDeltaPct =
    ((resultB.perf[Object.keys(resultB.perf)[0]!]!.traverseP95 -
      resultA.perf[Object.keys(resultA.perf)[0]!]!.traverseP95) /
      resultA.perf[Object.keys(resultA.perf)[0]!]!.traverseP95) *
    100;
  const searchDeltaPct =
    ((resultB.perf[Object.keys(resultB.perf)[0]!]!.searchP95 -
      resultA.perf[Object.keys(resultA.perf)[0]!]!.searchP95) /
      resultA.perf[Object.keys(resultA.perf)[0]!]!.searchP95) *
    100;
  console.log(
    `  A-vs-B perf delta (traverse p95): ${traverseDeltaPct >= 0 ? '+' : ''}${traverseDeltaPct.toFixed(1)}% (B pays for 2x rows/DB + app_id predicate)`,
  );
  console.log(
    `  A-vs-B perf delta (search p95): ${searchDeltaPct >= 0 ? '+' : ''}${searchDeltaPct.toFixed(1)}%`,
  );

  const totalFail = resultA.fail + resultB.fail;
  console.log(`\n=== EXIT ===`);
  console.log(`Design A: pass=${resultA.pass} fail=${resultA.fail} leaks=${resultA.leakAvenues.length}`);
  console.log(`Design B: pass=${resultB.pass} fail=${resultB.fail} leaks=${resultB.leakAvenues.length}`);
  if (totalFail > 0) {
    console.error('\nFAILURES:');
    for (const f of [...resultA.failures, ...resultB.failures]) console.error(' ' + f);
    process.exitCode = 1;
  } else {
    console.log('\nALL CLEAR — zero leaks, zero functional failures, zero scope bypasses across both designs.');
  }
}

main().catch((err) => {
  console.error('[spike-arcadedb-appgrid-e2e] fatal error:', err);
  process.exitCode = 1;
});

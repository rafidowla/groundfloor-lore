#!/usr/bin/env tsx
/**
 * test/spike-arcadedb-isolation-e2e.ts — spike/arcadedb-multitenant.
 *
 * Headline test for the ArcadeDB multi-tenant spike. Proves (or disproves)
 * that two tenants sharing ONE ArcadeDB server, each with its own database +
 * its own adapter instance constructed via arcadeClientForToken(), can never
 * see each other's data — across every avenue in the adversarial matrix from
 * the spike spec — while still being fully functional per-tenant.
 *
 * Sections:
 *   (1) SEED    — ~2000-5000 nodes + ~1.5x edges + ~500 verbatim docs PER
 *                 TENANT via the adapter. Every alpha row carries an 'ALPHA'
 *                 sentinel in label/content/text; every beta row carries
 *                 'BETA'.
 *   (2) FUNCTIONALITY — per tenant: upsert->getNode round-trip, addEdge->
 *                 traverse(depth 2) with correct depths + relation filter,
 *                 verbatimStore->verbatimSearch top-hit + score contract.
 *   (3) ISOLATION — the full adversarial matrix (I1-I11). ANY leak = FAIL.
 *   (4) PERF    — p50/p95 for traverse depth-2 and verbatimSearch, printed
 *                 and compared to the Lore local baseline (~114ms recall).
 *
 * Run: npx tsx test/spike-arcadedb-isolation-e2e.ts
 * Exits non-zero on any functional or isolation failure.
 *
 * Pre-requisite: ArcadeDB spike server running (see
 * test/spike-arcadedb-helpers.ts) with tenant_alpha / tenant_beta databases
 * and alpha_user / beta_user created (see test/spike-arcadedb-setup.ts).
 */

import {
  arcadeClientForToken,
  type ArcadeTenantClient,
} from '../packages/lore/src/engines/arcade/arcadeTenantMap.js';
import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import type { LoreEdge } from '../packages/lore/src/providers/types.js';
import { waitUntilReady } from './spike-arcadedb-helpers.js';

// ── config ───────────────────────────────────────────────────────────────
const SEED_NODES_PER_TENANT = Number(process.env['SPIKE_SEED_NODES'] ?? 2000);
const SEED_VERBATIM_PER_TENANT = Number(process.env['SPIKE_SEED_VERBATIM'] ?? 500);
const PERF_ITERATIONS = Number(process.env['SPIKE_PERF_ITERS'] ?? 50);
const LOCAL_BASELINE_MS = 114;
const RUN_TAG = Date.now().toString(36); // disambiguate this run's ids from any stale rows

// ── counters ─────────────────────────────────────────────────────────────
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

// ── seeding ──────────────────────────────────────────────────────────────
interface SeedResult {
  hubNodeId: string;
  nodeIds: string[];
  verbatimIds: string[];
}

async function seedTenant(
  client: ArcadeTenantClient,
  sentinel: 'ALPHA' | 'BETA',
  nodeCount: number,
  verbatimCount: number,
): Promise<SeedResult> {
  const t0 = Date.now();
  const nodeIds: string[] = [];
  const hubNodeId = `${sentinel.toLowerCase()}-hub-${RUN_TAG}`;

  // Hub node — every other node in the first "ring" connects to it, so
  // traverse(depth 2) from the hub has real fan-out to measure and assert on.
  await client.graph.upsertNode({
    id: hubNodeId,
    type: 'concept',
    label: `${sentinel} hub node`,
    content: `${sentinel} sentinel hub — root of the seeded graph for tenant ${client.tenantId}`,
    tags: [sentinel.toLowerCase(), 'hub'],
    project: `spike-${client.tenantId}`,
    ecosystem: 'spike',
    metadata: '',
  });
  nodeIds.push(hubNodeId);

  for (let i = 0; i < nodeCount; i++) {
    const id = `${sentinel.toLowerCase()}-node-${RUN_TAG}-${i}`;
    await client.graph.upsertNode({
      id,
      type: i % 7 === 0 ? 'decision' : 'fact',
      label: `${sentinel} node ${i}`,
      content: `${sentinel} sentinel content for node ${i} in tenant ${client.tenantId}`,
      tags: [sentinel.toLowerCase(), `batch-${Math.floor(i / 100)}`],
      project: `spike-${client.tenantId}`,
      ecosystem: 'spike',
      metadata: '',
    });
    nodeIds.push(id);
  }

  // ~1.5x edges: connect the first 300 nodes directly to the hub (depth-1
  // ring), then chain every node to its predecessor (depth-2+ reachability),
  // giving traverse(hub, 2) a real, countable frontier.
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
    const id = `${sentinel.toLowerCase()}-verbatim-${RUN_TAG}-${i}`;
    await client.vector.store({
      id,
      text:
        i === 0
          ? `${sentinel} secret payload: the quarterly roadmap for tenant ${client.tenantId} discusses migration timelines and budget allocation.`
          : `${sentinel} sentinel verbatim document ${i} — miscellaneous notes about tenant ${client.tenantId} operations.`,
      metadata: {
        type: 'note',
        label: `${sentinel} verbatim ${i}`,
        project: `spike-${client.tenantId}`,
      },
    });
    verbatimIds.push(id);
  }

  console.log(
    `  seeded tenant=${client.tenantId} nodes=${nodeIds.length} edges~=${ringSize + nodeIds.length - 2} verbatim=${verbatimIds.length} in ${Date.now() - t0}ms`,
  );
  return { hubNodeId, nodeIds, verbatimIds };
}

// ── functionality ────────────────────────────────────────────────────────
async function testFunctionality(
  client: ArcadeTenantClient,
  sentinel: 'ALPHA' | 'BETA',
  seed: SeedResult,
): Promise<void> {
  console.log(`\n[FUNCTIONALITY] tenant=${client.tenantId}`);

  // upsert -> getNode round trip
  const probeId = `${sentinel.toLowerCase()}-probe-${RUN_TAG}`;
  const written = await client.graph.upsertNode({
    id: probeId,
    type: 'fact',
    label: `${sentinel} probe`,
    content: `${sentinel} round-trip probe content`,
    tags: [sentinel.toLowerCase(), 'probe'],
    project: `spike-${client.tenantId}`,
    ecosystem: 'spike',
    metadata: JSON.stringify({ k: 'v' }),
  });
  check(`${client.tenantId}: upsertNode returns full LoreNode`, !!written.createdAt && !!written.updatedAt);
  const fetched = await client.graph.getNode(probeId);
  check(
    `${client.tenantId}: getNode round-trips core fields`,
    !!fetched &&
      fetched.id === probeId &&
      fetched.label === written.label &&
      fetched.content === written.content &&
      fetched.project === written.project &&
      Array.isArray(fetched.tags) &&
      fetched.tags.includes(sentinel.toLowerCase()),
    JSON.stringify(fetched),
  );

  // addEdge -> traverse(depth 2), correct depths + relation filter
  const traversal = await client.graph.traverse(seed.hubNodeId, 2);
  const depth1 = traversal.filter((r) => r.depth === 1);
  const depth2 = traversal.filter((r) => r.depth === 2);
  check(
    `${client.tenantId}: traverse depth-1 has hub's direct ring neighbors`,
    depth1.length > 0 && depth1.length <= 300,
    `depth1.length=${depth1.length}`,
  );
  check(
    `${client.tenantId}: traverse depth-2 has further neighbors`,
    depth2.length > 0,
    `depth2.length=${depth2.length}`,
  );
  check(
    `${client.tenantId}: traverse is depth-ascending`,
    traversal.every((r, idx) => idx === 0 || r.depth >= traversal[idx - 1]!.depth),
  );
  check(
    `${client.tenantId}: traverse results all carry the ${sentinel} sentinel`,
    traversal.every((r) => r.node.content.includes(sentinel) || r.node.label.includes(sentinel)),
  );
  const relationFiltered = await client.graph.traverse(seed.hubNodeId, 1, 'relates_to');
  check(
    `${client.tenantId}: relation filter is exact-match ('relates_to' only)`,
    relationFiltered.length > 0 && relationFiltered.every((r) => r.relation === 'relates_to'),
    `count=${relationFiltered.length}`,
  );

  // verbatimStore -> verbatimSearch: stored doc should be a top hit for a
  // semantically matching query; a nonsense query should not rank it first.
  const matchQuery = `roadmap migration budget ${client.tenantId}`;
  const matchResults = await client.vector.search(matchQuery, 10);
  const topHit = matchResults[0];
  check(
    `${client.tenantId}: semantic search returns results`,
    matchResults.length > 0,
  );
  check(
    `${client.tenantId}: semantic search scores in [0,1] descending`,
    matchResults.every((r) => r.score >= 0 && r.score <= 1) &&
      matchResults.every((r, idx) => idx === 0 || matchResults[idx - 1]!.score >= r.score),
  );
  check(
    `${client.tenantId}: seeded roadmap doc ranks as a top hit for matching query`,
    matchResults.some((r) => r.id === `${sentinel.toLowerCase()}-verbatim-${RUN_TAG}-0`),
    `topHit.id=${topHit?.id}`,
  );

  const nonsenseQuery = 'purple giraffe umbrella quantum spaghetti';
  const nonsenseResults = await client.vector.search(nonsenseQuery, 10);
  const nonsenseTop = nonsenseResults[0];
  check(
    `${client.tenantId}: nonsense query does not rank roadmap doc first`,
    !nonsenseTop || nonsenseTop.id !== `${sentinel.toLowerCase()}-verbatim-${RUN_TAG}-0`,
  );
}

// ── isolation adversarial matrix ─────────────────────────────────────────
async function testIsolation(
  alpha: ArcadeTenantClient,
  beta: ArcadeTenantClient,
  seedAlpha: SeedResult,
  seedBeta: SeedResult,
): Promise<void> {
  console.log(`\n[ISOLATION] adversarial matrix — alpha adapter attacking beta data`);

  // I1 — read-by-id: alpha getNode(<known beta id>) => null.
  const betaKnownId = seedBeta.nodeIds[5]!;
  const i1 = await alpha.graph.getNode(betaKnownId);
  check('I1 read-by-id: alpha.getNode(beta id) => null', i1 === null, JSON.stringify(i1));

  // I2 — write-collision: alpha upsertNode with an id that exists in beta.
  const collisionId = seedBeta.nodeIds[10]!;
  const betaNodeBefore = await beta.graph.getNode(collisionId);
  await alpha.graph.upsertNode({
    id: collisionId,
    type: 'fact',
    label: 'ALPHA collision write',
    content: 'ALPHA sentinel — attempted collision into betas id space',
    tags: ['alpha', 'collision'],
    project: 'spike-alpha',
    ecosystem: 'spike',
    metadata: '',
  });
  const betaNodeAfter = await beta.graph.getNode(collisionId);
  const alphaCollisionNode = await alpha.graph.getNode(collisionId);
  check(
    'I2 write-collision: beta node byte-identical after alpha writes same id',
    JSON.stringify(betaNodeBefore) === JSON.stringify(betaNodeAfter),
  );
  check(
    'I2 write-collision: alpha sees its OWN collision node, not betas',
    !!alphaCollisionNode && alphaCollisionNode.content.includes('ALPHA'),
  );

  // I3 — edge-cross: alpha addEdge(alpha node -> beta node id) => throws.
  await expectThrows('I3 edge-cross: alpha.addEdge(alpha->beta id) throws (target not found)', () =>
    alpha.graph.addEdge({
      sourceId: seedAlpha.hubNodeId,
      targetId: betaKnownId,
      relation: 'relates_to',
    }),
  );

  // I4 — traverse-leak: identical seed id (the hub naming is tenant-prefixed,
  // so use a genuinely shared literal id seeded into both DBs) — traverse
  // from it in alpha must return ONLY ALPHA-sentinel content.
  const sharedId = `shared-seed-${RUN_TAG}`;
  await alpha.graph.upsertNode({
    id: sharedId,
    type: 'fact',
    label: 'ALPHA shared-id node',
    content: 'ALPHA sentinel shared-id content',
    tags: ['alpha'],
    project: 'spike-alpha',
    ecosystem: 'spike',
    metadata: '',
  });
  await beta.graph.upsertNode({
    id: sharedId,
    type: 'fact',
    label: 'BETA shared-id node',
    content: 'BETA sentinel shared-id content',
    tags: ['beta'],
    project: 'spike-beta',
    ecosystem: 'spike',
    metadata: '',
  });
  await alpha.graph.addEdge({ sourceId: sharedId, targetId: seedAlpha.nodeIds[1]!, relation: 'relates_to' });
  const i4 = await alpha.graph.traverse(sharedId, 2);
  check(
    'I4 traverse-leak: alpha traverse(shared id) contains zero BETA-sentinel nodes',
    i4.every((r) => !r.node.content.includes('BETA') && !r.node.label.includes('BETA')),
    `leaked=${i4.filter((r) => r.node.content.includes('BETA')).map((r) => r.node.id).join(',')}`,
  );

  // I5 — recall-leak: alpha verbatimSearch crafted to match a BETA-only doc.
  const betaSecretQuery = `${beta.tenantId} secret payload quarterly roadmap migration budget`;
  const i5 = await alpha.vector.search(betaSecretQuery, 20);
  check(
    'I5 recall-leak: alpha verbatimSearch(beta-targeted query) has zero BETA-sentinel hits',
    i5.every((r) => !r.text.includes('BETA')),
    `leaked=${i5.filter((r) => r.text.includes('BETA')).map((r) => r.id).join(',')}`,
  );

  // I6 — filter-injection: escape-y filter values must not surface beta rows
  // and must not cause anything other than a clean empty/param-rejection.
  try {
    const i6a = await alpha.vector.search('roadmap budget', 10, {
      project: "x' OR 1=1 --",
    });
    check(
      'I6a filter-injection (SQLi-shaped project filter): no beta rows, no crash',
      i6a.every((r) => !r.text.includes('BETA')),
    );
  } catch (e) {
    check('I6a filter-injection: clean error (no crash/leak) is acceptable', true, String(e));
  }
  try {
    const i6b = await alpha.vector.search('roadmap budget', 10, {
      project: 'tenant_beta',
    });
    check(
      'I6b filter-injection (db-name-shaped project filter): no beta rows',
      i6b.every((r) => !r.text.includes('BETA')),
    );
  } catch (e) {
    check('I6b filter-injection: clean error (no crash/leak) is acceptable', true, String(e));
  }

  // I7 — db-name-injection: payload strings shaped like a path/db-name must
  // never influence the URL database segment. Verified two ways: (a) runtime
  // — the op completes harmlessly inside tenant_alpha; (b) code-review — the
  // adapter source never interpolates a method argument into the URL path.
  const injectId = `../tenant_beta/injected-${RUN_TAG}`;
  const i7written = await alpha.graph.upsertNode({
    id: injectId,
    type: 'fact',
    label: 'ALPHA path-injection probe',
    content: 'ALPHA sentinel tenant_beta ../tenant_beta path-shaped payload',
    tags: ['alpha'],
    project: 'tenant_beta', // db-name-shaped payload value
    ecosystem: 'spike',
    metadata: '',
  });
  const i7read = await alpha.graph.getNode(injectId);
  check(
    'I7 db-name-injection: path/db-name-shaped payload lands harmlessly in tenant_alpha',
    i7written.id === injectId && !!i7read && i7read.id === injectId,
  );
  const betaStillClean = await beta.graph.getNode(injectId);
  check(
    'I7 db-name-injection: injected id does NOT exist in tenant_beta',
    betaStillClean === null,
  );
  // Static code-review check: db name is never built from a method arg.
  const httpSource = await (await import('node:fs/promises')).readFile(
    new URL('../packages/lore/src/engines/arcade/arcadeHttp.ts', import.meta.url),
    'utf8',
  );
  const dbTemplateUsesArg = /`\/api\/v1\/(command|query)\/\$\{(?!this\.|db\b)/.test(httpSource);
  check(
    'I7b code-review: URL db segment is only ever a plain db param, never payload-derived',
    /\$\{db\}/.test(httpSource) && !dbTemplateUsesArg,
  );

  // I8 — auth-wall: raw HTTP as alpha_user against tenant_beta => 401/403.
  const alphaRawHttp = new ArcadeHttp({ user: 'alpha_user', pass: 'AlphaPass123!' });
  try {
    await alphaRawHttp.query('tenant_beta', 'SELECT 1 as x');
    check('I8 auth-wall: alpha_user querying tenant_beta is rejected', false, 'no error thrown');
  } catch (e) {
    const isAuthError = e instanceof ArcadeHttpError && (e.status === 401 || e.status === 403);
    check(
      'I8 auth-wall: alpha_user querying tenant_beta => 401/403 from ArcadeDB itself',
      isAuthError,
      e instanceof ArcadeHttpError ? `status=${e.status} body=${e.body}` : String(e),
    );
  }

  // I9 — count/stats-leak: alpha counts reflect ONLY alpha's seed sizes.
  const alphaNodeCount = await alpha.graph.nodeCount();
  const betaNodeCount = await beta.graph.nodeCount();
  const alphaVerbCount = await alpha.vector.count();
  const betaVerbCount = await beta.vector.count();
  check(
    'I9 count-leak: alpha nodeCount reflects only alpha seed scale (not aggregate)',
    alphaNodeCount < alphaNodeCount + betaNodeCount &&
      alphaNodeCount >= seedAlpha.nodeIds.length &&
      alphaNodeCount < seedAlpha.nodeIds.length + seedBeta.nodeIds.length,
    `alpha=${alphaNodeCount} beta=${betaNodeCount}`,
  );
  check(
    'I9 count-leak: alpha verbatim count reflects only alpha seed scale',
    alphaVerbCount >= seedAlpha.verbatimIds.length &&
      alphaVerbCount < seedAlpha.verbatimIds.length + seedBeta.verbatimIds.length,
    `alphaVerb=${alphaVerbCount} betaVerb=${betaVerbCount}`,
  );

  // I10 — delete-cross: alpha delete using a beta doc id => beta doc survives.
  const betaVerbId = seedBeta.verbatimIds[3]!;
  const betaVerbBefore = (await beta.vector.search(`sentinel verbatim document`, 500)).find(
    (r) => r.id === betaVerbId,
  );
  await alpha.vector.delete(betaVerbId);
  const betaVerbAfterResults = await beta.vector.search(`sentinel verbatim document`, 500);
  const betaVerbAfter = betaVerbAfterResults.find((r) => r.id === betaVerbId);
  check(
    'I10 delete-cross: alpha.vector.delete(beta doc id) leaves betas doc intact',
    !!betaVerbAfter && (!betaVerbBefore || betaVerbAfter.text === betaVerbBefore.text),
    `before=${!!betaVerbBefore} after=${!!betaVerbAfter}`,
  );

  // I11 — token-map: unknown token throws before any HTTP call; a resolved
  // client's tenant db is immutable (readonly, no setter — verified by
  // TypeScript at compile time; runtime check re-derives the same client
  // twice and asserts db never changes).
  await expectThrows('I11a token-map: arcadeClientForToken(unknown) throws before any HTTP call', async () => {
    const { arcadeClientForToken } = await import(
      '../packages/lore/src/engines/arcade/arcadeTenantMap.js'
    );
    arcadeClientForToken('unknown-token-xyz');
  });
  const reResolved = arcadeClientForToken('token-alpha');
  check(
    'I11b token-map: token-alpha always resolves to tenant_alpha, never tenant_beta',
    reResolved.db === 'tenant_alpha' && alpha.db === 'tenant_alpha',
  );
}

// ── perf ─────────────────────────────────────────────────────────────────
async function measurePerf(
  client: ArcadeTenantClient,
  seed: SeedResult,
): Promise<{ traverseP50: number; traverseP95: number; searchP50: number; searchP95: number }> {
  console.log(`\n[PERF] tenant=${client.tenantId} (${PERF_ITERATIONS} iterations, embedder warm-up excluded)`);

  // Warm up (JIT / connection warm-up; embedder already warmed at seed time).
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
  const result = {
    traverseP50: percentile(traverseTimes, 50),
    traverseP95: percentile(traverseTimes, 95),
    searchP50: percentile(searchTimes, 50),
    searchP95: percentile(searchTimes, 95),
  };
  console.log(
    `  traverse(depth2): p50=${result.traverseP50.toFixed(1)}ms p95=${result.traverseP95.toFixed(1)}ms`,
  );
  console.log(
    `  verbatimSearch(limit10): p50=${result.searchP50.toFixed(1)}ms p95=${result.searchP95.toFixed(1)}ms`,
  );
  const riskThreshold = LOCAL_BASELINE_MS * 3;
  for (const [label, p95] of [
    ['traverse', result.traverseP95],
    ['verbatimSearch', result.searchP95],
  ] as const) {
    if (p95 > riskThreshold) {
      console.warn(
        `  [RISK] ${client.tenantId} ${label} p95=${p95.toFixed(1)}ms exceeds ~3x local baseline (${riskThreshold}ms)`,
      );
    }
  }
  return result;
}

// ── main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== spike-arcadedb-isolation-e2e ===');
  console.log(`config: nodes/tenant=${SEED_NODES_PER_TENANT} verbatim/tenant=${SEED_VERBATIM_PER_TENANT} perf-iters=${PERF_ITERATIONS} runTag=${RUN_TAG}`);

  await waitUntilReady();

  const alpha = arcadeClientForToken('token-alpha');
  const beta = arcadeClientForToken('token-beta');

  console.log('\n[SEED] warming embedder + seeding both tenants...');
  const embedderWarmupStart = Date.now();
  // Warm the shared embedder once, excluded from perf timings later.
  await alpha.vector.store({ id: `warmup-${RUN_TAG}`, text: 'warm up the embedder', metadata: {} });
  await alpha.vector.delete(`warmup-${RUN_TAG}`);
  console.log(`  embedder warm-up: ${Date.now() - embedderWarmupStart}ms (excluded from perf)`);

  const seedAlpha = await seedTenant(alpha, 'ALPHA', SEED_NODES_PER_TENANT, SEED_VERBATIM_PER_TENANT);
  const seedBeta = await seedTenant(beta, 'BETA', SEED_NODES_PER_TENANT, SEED_VERBATIM_PER_TENANT);

  await testFunctionality(alpha, 'ALPHA', seedAlpha);
  await testFunctionality(beta, 'BETA', seedBeta);

  await testIsolation(alpha, beta, seedAlpha, seedBeta);
  // Reverse direction too — beta attacking alpha — cheap insurance beyond the
  // spec's alpha-attacks-beta framing, using the same shared-id + secret-query
  // probes already seeded.
  console.log(`\n[ISOLATION] reverse direction — beta adapter attacking alpha data`);
  const revKnownId = seedAlpha.nodeIds[5]!;
  const rev1 = await beta.graph.getNode(revKnownId);
  check('I1-rev: beta.getNode(alpha id) => null', rev1 === null);
  const revSecretQuery = `${alpha.tenantId} secret payload quarterly roadmap migration budget`;
  const rev5 = await beta.vector.search(revSecretQuery, 20);
  check(
    'I5-rev: beta verbatimSearch(alpha-targeted query) has zero ALPHA-sentinel hits',
    rev5.every((r) => !r.text.includes('ALPHA')),
    `leaked=${rev5.filter((r) => r.text.includes('ALPHA')).map((r) => r.id).join(',')}`,
  );

  const alphaPerf = await measurePerf(alpha, seedAlpha);
  const betaPerf = await measurePerf(beta, seedBeta);

  console.log('\n=== SUMMARY ===');
  console.log(`pass=${pass} fail=${fail}`);
  console.log(`isolation: ${failures.length === 0 ? 'CLEAN — no leak detected in any adversarial-matrix case' : 'LEAK DETECTED'}`);
  console.log(
    `perf vs local baseline (~${LOCAL_BASELINE_MS}ms recall): ` +
      `alpha traverse p95=${alphaPerf.traverseP95.toFixed(1)}ms (${(alphaPerf.traverseP95 / LOCAL_BASELINE_MS).toFixed(2)}x), ` +
      `alpha search p95=${alphaPerf.searchP95.toFixed(1)}ms (${(alphaPerf.searchP95 / LOCAL_BASELINE_MS).toFixed(2)}x), ` +
      `beta traverse p95=${betaPerf.traverseP95.toFixed(1)}ms (${(betaPerf.traverseP95 / LOCAL_BASELINE_MS).toFixed(2)}x), ` +
      `beta search p95=${betaPerf.searchP95.toFixed(1)}ms (${(betaPerf.searchP95 / LOCAL_BASELINE_MS).toFixed(2)}x)`,
  );

  if (fail > 0) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(f);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[spike-arcadedb-isolation-e2e] fatal error:', err);
  process.exitCode = 1;
});

#!/usr/bin/env tsx
/**
 * spike-arcadedb-provisioner.ts — proof that the REAL provisioning routine
 * (packages/lore/src/engines/arcade/arcadeProvisioner.ts) replaces the
 * inline db/schema/user creation the spike helpers did by hand, and is:
 *   - idempotent (provision twice, second call is a no-op repair)
 *   - correctly walled (per-DB service user 403s on a sibling db)
 *   - capable of onboarding a brand-new customer at runtime (no code change,
 *     no redeploy — "gamma" was never in the original alpha/beta grid)
 *   - a working two-phase deprovision (disable -> dead token -> destroy)
 *
 * Run: npx tsx test/spike-arcadedb-provisioner.ts
 */

import {
  provisionApp,
  disableApp,
  destroyApp,
  getTenantApp,
  readSecret,
  listTenantApps,
  provisioningDbPath,
  closeRegistryDb,
  ARCADE_BASE_URL,
  ARCADE_ROOT_USER,
  ARCADE_ROOT_PASSWORD,
} from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

async function assertStableVersion(): Promise<string> {
  const res = await fetch(`${ARCADE_BASE_URL}/api/v1/server?mode=basic`, {
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${ARCADE_ROOT_USER}:${ARCADE_ROOT_PASSWORD}`).toString('base64'),
    },
  });
  const body = (await res.json()) as { version?: string };
  return body.version ?? '';
}

// Isolated registry DB for this test run so it doesn't collide with any
// other session's ~/.groundfloor state (loreHome.ts already isolates test
// processes into a per-pid temp home, but we pin an explicit path here too
// so the test is self-describing and easy to inspect after a failure).
const REGISTRY_DB_PATH = path.join(
  os.tmpdir(),
  `arcade-provisioner-test-${process.pid}.sqlite`,
);

const GRID: Array<{ customerId: string; appId: string }> = [
  { customerId: 'alpha', appId: 'app1' },
  { customerId: 'alpha', appId: 'app2' },
  { customerId: 'beta', appId: 'app1' },
  { customerId: 'beta', appId: 'app2' },
];
const GAMMA = { customerId: 'gamma', appId: 'app1' };

async function main(): Promise<void> {
  console.log('=== 0. Version gate ===');
  const version = await assertStableVersion();
  console.log(`  server version: ${version}`);
  check(
    'version starts with 26.7.1, no SNAPSHOT',
    version.startsWith('26.7.1') && !/SNAPSHOT/i.test(version),
    version,
  );

  console.log(`\n  registry db: ${REGISTRY_DB_PATH}`);
  console.log(`  (default provisioningDbPath() would be: ${provisioningDbPath()})`);

  console.log('\n=== 1. Provision the four grid cells (alpha/app1, alpha/app2, beta/app1, beta/app2) ===');
  const results: Record<string, Awaited<ReturnType<typeof provisionApp>>> = {};
  for (const cell of GRID) {
    const key = `${cell.customerId}_${cell.appId}`;
    const r = await provisionApp(cell, { registryDbPath: REGISTRY_DB_PATH });
    results[key] = r;
    console.log(`  provisioned ${r.db} (user=${r.dbUser}, created=${r.created})`);
    check(`${key}: created=true on first provision`, r.created === true);
    check(`${key}: db name matches convention`, r.db === `tenant_${cell.customerId}_${cell.appId}`);
  }
  check('all four grid cells provisioned', Object.keys(results).length === 4);

  console.log('\n=== 2. Idempotency: re-run provisionApp for every grid cell ===');
  for (const cell of GRID) {
    const key = `${cell.customerId}_${cell.appId}`;
    const before = results[key]!;
    const secretBefore = readSecret(cell, { registryDbPath: REGISTRY_DB_PATH });
    const r2 = await provisionApp(cell, { registryDbPath: REGISTRY_DB_PATH });
    check(`${key}: second call reports created=false`, r2.created === false);
    check(`${key}: second call returns same db`, r2.db === before.db);
    check(`${key}: second call returns same dbUser`, r2.dbUser === before.dbUser);
    const secretAfter = readSecret(cell, { registryDbPath: REGISTRY_DB_PATH });
    check(`${key}: password unchanged across idempotent re-provision`, secretBefore === secretAfter);

    // Third call for good measure — no error, no drift.
    await provisionApp(cell, { registryDbPath: REGISTRY_DB_PATH });
  }

  console.log('\n=== 3. Runtime onboarding: provision a brand-new customer (gamma/app1) ===');
  const gammaResult = await provisionApp(GAMMA, { registryDbPath: REGISTRY_DB_PATH });
  console.log(`  provisioned ${gammaResult.db} (user=${gammaResult.dbUser}, created=${gammaResult.created})`);
  check('gamma/app1: created=true (never existed before)', gammaResult.created === true);
  check('gamma/app1: db name follows convention', gammaResult.db === 'tenant_gamma_app1');

  console.log('\n=== 4. Schema is actually usable: write + read a node through the provisioned user ===');
  const gammaSecret = readSecret(GAMMA, { registryDbPath: REGISTRY_DB_PATH });
  check('gamma/app1: secret resolvable via readSecret', typeof gammaSecret === 'string' && gammaSecret.length > 0);
  const gammaHttp = new ArcadeHttp({ user: gammaResult.dbUser, pass: gammaSecret! }, ARCADE_BASE_URL);
  await gammaHttp.command(
    gammaResult.db,
    'UPDATE LoreNode SET id=:id, label=:label, content=:content, createdAt=:now, updatedAt=:now UPSERT WHERE id=:id',
    { id: 'gamma-sanity-1', label: 'GAMMA-APP1 sanity node', content: 'gamma payload', now: new Date().toISOString() },
  );
  const readBack = await gammaHttp.query(gammaResult.db, 'SELECT label FROM LoreNode WHERE id = :id', {
    id: 'gamma-sanity-1',
  });
  const label = String((readBack.result?.[0] as { label?: string } | undefined)?.label ?? '');
  check('gamma/app1: node round-trips through provisioned schema + user', label === 'GAMMA-APP1 sanity node', label);

  console.log('\n=== 5. Isolation: gamma/app1 service user 403s on a sibling db ===');
  for (const cell of GRID) {
    const sibling = results[`${cell.customerId}_${cell.appId}`]!;
    try {
      await gammaHttp.query(sibling.db, 'SELECT id FROM LoreNode LIMIT 1');
      check(`gamma user blocked from ${sibling.db}`, false, 'no error thrown — LEAK');
    } catch (e) {
      const status = e instanceof ArcadeHttpError ? e.status : undefined;
      check(`gamma user blocked from ${sibling.db}`, status === 401 || status === 403, `status=${status}`);
    }
  }

  console.log('\n=== 6. Registry listing reflects all five cells ===');
  const all = listTenantApps({ registryDbPath: REGISTRY_DB_PATH });
  check('registry lists 5 active tenant_apps rows', all.length === 5, JSON.stringify(all.map((r) => `${r.tenant_id}/${r.app_id}:${r.status}`)));
  check('all five rows are status=active', all.every((r) => r.status === 'active'));

  console.log('\n=== 7. Two-phase deprovision: disableApp then destroyApp on gamma/app1 ===');
  await disableApp(GAMMA, { registryDbPath: REGISTRY_DB_PATH });
  const disabledRow = getTenantApp(GAMMA, { registryDbPath: REGISTRY_DB_PATH });
  check('gamma/app1: registry row status=disabled after disableApp', disabledRow?.status === 'disabled');

  // Old credential should now be dead — the password was rotated to an
  // unrecoverable random value as part of disableApp.
  try {
    await gammaHttp.query(gammaResult.db, 'SELECT id FROM LoreNode LIMIT 1');
    check('gamma/app1: old service credential dead after disableApp', false, 'old credential still works — LEAK');
  } catch (e) {
    const status = e instanceof ArcadeHttpError ? e.status : undefined;
    check('gamma/app1: old service credential dead after disableApp', status === 401 || status === 403, `status=${status}`);
  }

  await destroyApp(GAMMA, { registryDbPath: REGISTRY_DB_PATH });
  const destroyedRow = getTenantApp(GAMMA, { registryDbPath: REGISTRY_DB_PATH });
  check('gamma/app1: registry row deleted after destroyApp', destroyedRow === undefined);

  // Database itself should be gone — root query against it should fail.
  const rootHttp = new ArcadeHttp({ user: ARCADE_ROOT_USER, pass: ARCADE_ROOT_PASSWORD }, ARCADE_BASE_URL);
  try {
    await rootHttp.query(gammaResult.db, 'SELECT id FROM LoreNode LIMIT 1');
    check('gamma/app1: database dropped after destroyApp', false, 'db still queryable — destroy did not drop it');
  } catch (e) {
    check('gamma/app1: database dropped after destroyApp', e instanceof ArcadeHttpError, String(e));
  }

  console.log('\n=== 8. destroyApp is idempotent (second call on already-destroyed cell is a no-op) ===');
  try {
    await destroyApp(GAMMA, { registryDbPath: REGISTRY_DB_PATH });
    check('destroyApp: second call does not throw', true);
  } catch (e) {
    check('destroyApp: second call does not throw', false, String(e));
  }

  console.log('\n=== SUMMARY ===');
  console.log(`  pass=${pass} fail=${fail}`);
  closeRegistryDb();
  if (fs.existsSync(REGISTRY_DB_PATH)) fs.rmSync(REGISTRY_DB_PATH, { force: true });
  if (fs.existsSync(`${REGISTRY_DB_PATH}-wal`)) fs.rmSync(`${REGISTRY_DB_PATH}-wal`, { force: true });
  if (fs.existsSync(`${REGISTRY_DB_PATH}-shm`)) fs.rmSync(`${REGISTRY_DB_PATH}-shm`, { force: true });
  if (fail > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log(f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

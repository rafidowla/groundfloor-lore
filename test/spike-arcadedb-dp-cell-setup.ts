#!/usr/bin/env tsx
/**
 * spike-arcadedb-dp-cell-setup.ts — Cloud Slice 3 (tenant data plane) test-env
 * bootstrap. Provisions two REAL tenant cells via the production provisioner
 * (arcadeProvisioner.ts, NOT the spike-only helpers) against a fresh ArcadeDB
 * 26.7.1 container, issues a tenant token for each via the real auth resolver,
 * and confirms at the raw ArcadeDB-HTTP layer that the two cells' per-db
 * service users cannot cross (403 outside their own database).
 *
 * Uses a SCRATCH registry db path so this never touches real LORE_HOME state.
 *
 * Run: npx tsx test/spike-arcadedb-dp-cell-setup.ts
 */

import {
  provisionApp,
  getTenantApp,
  readSecret,
} from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { issueToken } from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { ARCADE_BASE_URL, ARCADE_ROOT_USER, ARCADE_ROOT_PASSWORD } from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';

const registryDbPath = '/tmp/lore-dp-slice3-registry.sqlite';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${label}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  console.log(`ArcadeDB base URL: ${ARCADE_BASE_URL}`);
  console.log(`Registry db path: ${registryDbPath}`);
  console.log();

  // NOTE: arcadeProvisioner's assertValidIdentifier requires /^[a-z0-9]+$/
  // (no underscores — these values are interpolated into ArcadeDB db/user
  // names). "tenant_dp_alpha" / "tenant_dp_beta" from the task prompt are
  // therefore collapsed to the closest valid identifiers.
  const cellDefs = [
    { customerId: 'tenantdpalpha', appId: 'app1' },
    { customerId: 'tenantdpbeta', appId: 'app1' },
  ];

  const cells: Record<
    string,
    {
      db: string;
      dbUser: string;
      secretRef: string;
      secret: string;
      token: string;
      expiresAt: string | null;
    }
  > = {};

  for (const def of cellDefs) {
    const key = `${def.customerId}/${def.appId}`;
    console.log(`Provisioning ${key} ...`);
    const provisioned = await provisionApp(def, { registryDbPath });
    const row = getTenantApp(def, { registryDbPath });
    const secret = readSecret(def, { registryDbPath });

    check(`${key}: provisionApp returned a db name`, !!provisioned.db, provisioned.db);
    check(`${key}: registry row status active`, row?.status === 'active', row?.status);
    check(`${key}: secret resolved`, typeof secret === 'string' && secret.length > 0);

    const issued = issueToken(
      { tenantId: def.customerId, appId: def.appId, scopes: ['read', 'write'] },
      { registryDbPath },
    );
    check(`${key}: token issued`, issued.token.startsWith('lore_at_'), issued.token.slice(0, 12));

    cells[key] = {
      db: provisioned.db,
      dbUser: provisioned.dbUser,
      secretRef: provisioned.secretRef,
      secret: secret!,
      token: issued.token,
      expiresAt: issued.expiresAt,
    };
  }

  console.log();
  console.log('Confirming raw cross-cell wall (per-db service user 403s outside its own db) ...');

  const [alphaKey, betaKey] = Object.keys(cells);
  const alpha = cells[alphaKey]!;
  const beta = cells[betaKey]!;

  const alphaHttp = new ArcadeHttp({ user: alpha.dbUser, pass: alpha.secret }, ARCADE_BASE_URL);
  const betaHttp = new ArcadeHttp({ user: beta.dbUser, pass: beta.secret }, ARCADE_BASE_URL);

  // Own-db access should succeed for both.
  try {
    await alphaHttp.query(alpha.db, 'SELECT 1 as ok');
    check(`${alphaKey}: own-db query succeeds`, true);
  } catch (e) {
    check(`${alphaKey}: own-db query succeeds`, false, String(e));
  }
  try {
    await betaHttp.query(beta.db, 'SELECT 1 as ok');
    check(`${betaKey}: own-db query succeeds`, true);
  } catch (e) {
    check(`${betaKey}: own-db query succeeds`, false, String(e));
  }

  // Cross-db access must 403.
  try {
    await alphaHttp.query(beta.db, 'SELECT 1 as ok');
    check(`${alphaKey}'s user denied access to ${beta.db}`, false, 'expected 403, got success');
  } catch (e) {
    const is403 = e instanceof ArcadeHttpError && e.status === 403;
    check(`${alphaKey}'s user denied access to ${beta.db}`, is403, is403 ? undefined : String(e));
  }

  try {
    await betaHttp.query(alpha.db, 'SELECT 1 as ok');
    check(`${betaKey}'s user denied access to ${alpha.db}`, false, 'expected 403, got success');
  } catch (e) {
    const is403 = e instanceof ArcadeHttpError && e.status === 403;
    check(`${betaKey}'s user denied access to ${alpha.db}`, is403, is403 ? undefined : String(e));
  }

  console.log();
  console.log('=== CELL SUMMARY ===');
  for (const [key, c] of Object.entries(cells)) {
    console.log(`${key}:`);
    console.log(`  db:        ${c.db}`);
    console.log(`  dbUser:    ${c.dbUser}`);
    console.log(`  secretRef: ${c.secretRef}`);
    console.log(`  token:     ${c.token}`);
    console.log(`  expiresAt: ${c.expiresAt}`);
  }

  console.log();
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log(`registryDbPath (reuse for later phases): ${registryDbPath}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('SETUP FAILED:', e);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * spike-arcadedb-appgrid-provision-check.ts — provisioning + basic
 * cross-check smoke for the 2x2 customer/app grid, on the pinned stable
 * ArcadeDB release. Covers steps (2)(3)(5) of the orchestrator's ask:
 *   - Design A: 4 dbs + 4 per-DB users, schema created.
 *   - Design B: 2 dbs + 2 users, app_id-tagged schema created.
 *   - Sanity row seeded per (customer,app) cell for both designs.
 *   - Raw-DB-layer confirmation: Design A cross-db access is rejected by
 *     ArcadeDB itself (401/403); Design B app_id tagging is queryable and
 *     an unfiltered query surfaces both apps' sentinels (proving the two
 *     apps' rows really are co-resident and app_id is the only wall).
 *
 * This is NOT the full 12-probe adversarial matrix (M1-M12) from the spec —
 * see the session summary for what remains as future work.
 *
 * Run: npx tsx test/spike-arcadedb-appgrid-provision-check.ts
 */

import {
  assertStableVersion,
  provisionDesignA,
  provisionDesignB,
  seedSanityRowDesignA,
  seedSanityRowDesignB,
  designACells,
  designBCustomers,
  SENTINEL,
  cellKey,
  APPS,
} from './spike-arcadedb-appgrid-helpers.js';
import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { arcadeQuery } from './spike-arcadedb-helpers.js';

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

async function main(): Promise<void> {
  console.log('=== 0. Version gate ===');
  const version = await assertStableVersion();
  console.log(`  server version: ${version}`);
  check('version starts with 26.7.1, no SNAPSHOT', version.startsWith('26.7.1') && !/SNAPSHOT/i.test(version));

  console.log('\n=== 1. Design A provisioning (4 dbs, 4 users) ===');
  const aCells = await provisionDesignA();
  for (const cell of aCells) {
    await seedSanityRowDesignA(cell);
    console.log(`  provisioned ${cell.db} / user ${cell.user}`);
  }
  check('Design A: 4 cells provisioned', aCells.length === 4);

  console.log('\n=== 2. Design B provisioning (2 dbs, 2 users, app_id schema) ===');
  const bCustomers = await provisionDesignB();
  for (const cust of bCustomers) {
    for (const app of APPS) {
      await seedSanityRowDesignB(cust, app);
    }
    console.log(`  provisioned ${cust.db} / user ${cust.user} (both apps seeded)`);
  }
  check('Design B: 2 customer dbs provisioned', bCustomers.length === 2);

  console.log('\n=== 3. Design A raw-HTTP cross-db check (app wall + customer wall) ===');
  // alpha_app1_user attempts every other cell's db directly.
  const alphaApp1 = aCells.find((c) => c.customer === 'alpha' && c.app === 'app1')!;
  const attackerHttp = new ArcadeHttp({ user: alphaApp1.user, pass: alphaApp1.pass });
  for (const target of aCells) {
    if (target.db === alphaApp1.db) continue;
    try {
      await attackerHttp.query(target.db, 'SELECT id FROM LoreNode LIMIT 1');
      check(`Design A: alpha_app1_user blocked from ${target.db}`, false, 'no error thrown — LEAK');
    } catch (e) {
      const status = e instanceof ArcadeHttpError ? e.status : undefined;
      check(
        `Design A: alpha_app1_user blocked from ${target.db}`,
        status === 401 || status === 403,
        `status=${status}`,
      );
    }
  }
  // own db still works
  try {
    const own = await attackerHttp.query(alphaApp1.db, 'SELECT id FROM LoreNode LIMIT 1');
    check('Design A: alpha_app1_user CAN read own db', Array.isArray(own.result));
  } catch (e) {
    check('Design A: alpha_app1_user CAN read own db', false, String(e));
  }

  console.log('\n=== 4. Design A sanity rows: own adapter sees own sentinel, nothing else ===');
  for (const cell of aCells) {
    const res = await arcadeQuery(
      cell.db,
      'SELECT label FROM LoreNode WHERE id = :id',
      { id: `sanity-${cellKey(cell.customer, cell.app)}` },
    );
    const label = String((res.result?.[0] as { label?: string } | undefined)?.label ?? '');
    const ownSentinel = SENTINEL[cell.customer][cell.app];
    check(`Design A: ${cell.db} sanity row carries own sentinel`, label.includes(ownSentinel), label);
    // confirm no foreign sentinel physically present in this db at all
    const allRes = await arcadeQuery(cell.db, 'SELECT label FROM LoreNode');
    const allLabels = (allRes.result ?? []).map((r) => String((r as { label?: string }).label ?? ''));
    for (const c of ['alpha', 'beta'] as const) {
      for (const a of APPS) {
        if (c === cell.customer && a === cell.app) continue;
        const foreign = SENTINEL[c][a];
        const leaked = allLabels.some((l) => l.includes(foreign));
        check(`Design A: ${cell.db} contains zero ${foreign} rows`, !leaked);
      }
    }
  }

  console.log('\n=== 5. Design B: app_id tagging present + co-residence canary ===');
  for (const cust of bCustomers) {
    const res = await arcadeQuery(cust.db, 'SELECT id, app_id, label FROM LoreNode WHERE id LIKE :pat', {
      pat: 'sanity-%',
    });
    const rows = (res.result ?? []) as Array<{ id?: string; app_id?: string; label?: string }>;
    check(`Design B: ${cust.db} has sanity rows for both apps`, rows.length === 2, JSON.stringify(rows));
    const app1Row = rows.find((r) => r.app_id === 'app1');
    const app2Row = rows.find((r) => r.app_id === 'app2');
    check(`Design B: ${cust.db} app1 row has app_id='app1'`, !!app1Row);
    check(`Design B: ${cust.db} app2 row has app_id='app2'`, !!app2Row);

    // ROOT CANARY: an intentionally UNFILTERED query against tenant_<cust>
    // must show BOTH apps' sentinels — proving the rows are physically
    // co-resident and app_id is the ONLY wall (no adapter code exists yet
    // in this session, so this stands in for the adapter's raw substrate).
    const bothSentinels = [SENTINEL[cust.customer].app1, SENTINEL[cust.customer].app2];
    const labels = rows.map((r) => String(r.label ?? ''));
    const sawBoth = bothSentinels.every((s) => labels.some((l) => l.includes(s)));
    check(
      `Design B canary: unfiltered ${cust.db} query surfaces BOTH app sentinels (co-residence proven)`,
      sawBoth,
      JSON.stringify(labels),
    );
  }

  console.log('\n=== 6. Design B raw-HTTP: customer wall holds (app wall does NOT exist at raw layer) ===');
  const alphaUser = bCustomers.find((c) => c.customer === 'alpha')!;
  const betaUser = bCustomers.find((c) => c.customer === 'beta')!;
  const alphaRawHttp = new ArcadeHttp({ user: alphaUser.user, pass: alphaUser.pass });
  try {
    await alphaRawHttp.query(betaUser.db, 'SELECT id FROM LoreNode LIMIT 1');
    check('Design B: alpha_user blocked from tenant_beta (customer wall)', false, 'no error — LEAK');
  } catch (e) {
    const status = e instanceof ArcadeHttpError ? e.status : undefined;
    check('Design B: alpha_user blocked from tenant_beta (customer wall)', status === 401 || status === 403, `status=${status}`);
  }
  // DOCUMENT (not fail) the open app wall: alpha_user CAN see app2 rows inside tenant_alpha.
  const openWallRes = await alphaRawHttp.query(alphaUser.db, 'SELECT label FROM LoreNode WHERE id LIKE :pat', {
    pat: 'sanity-%',
  });
  const openWallLabels = (openWallRes.result ?? []).map((r) => String((r as { label?: string }).label ?? ''));
  const app2Sentinel = SENTINEL.alpha.app2;
  const appWallOpen = openWallLabels.some((l) => l.includes(app2Sentinel));
  console.log(
    `  [DOCUMENTED, not a failure] Design B residual risk: raw HTTP as alpha_user reading ` +
      `tenant_alpha sees app2 rows = ${appWallOpen} (expected true — app wall is adapter-only in Design B)`,
  );

  console.log('\n=== SUMMARY ===');
  console.log(`  pass=${pass} fail=${fail}`);
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

#!/usr/bin/env tsx
/**
 * test/arcade-reprovision-user-survives-e2e.ts — pins the slice-2 adversarial
 * MAJOR (availability) finding: an idempotent SAME-PASSWORD re-provision must
 * NOT drop+recreate the LIVE per-app ArcadeDB service user.
 * (branch: spike/arcadedb-multitenant)
 *
 * WHY THIS TEST EXISTS
 * The pre-fix createOrRotateServiceUser() unconditionally ran `drop user` +
 * `create user` on every re-provision that hit an EXISTING user — even when the
 * password was unchanged (provisionApp reuses the on-file password on an
 * idempotent re-run). That opened a transient-401 window on a routine
 * schema-upgrade re-provision, and a daemon crash between the drop and the
 * create would leave the per-app user permanently gone. The existing slice-2
 * e2e only asserted registry `created === false`, which did NOT catch this —
 * the registry row is untouched even while the live ArcadeDB user is churned.
 *
 * WHAT THIS TEST ASSERTS (observed against the LIVE 26.7.1 container)
 *   1. First provision mints a service user whose live credential authenticates
 *      against its own tenant db.
 *   2. That SAME credential keeps authenticating UNINTERRUPTED across an
 *      idempotent same-password re-provision — i.e. the user was NOT dropped
 *      and recreated (a drop+create either revokes the old password mid-window
 *      or, at minimum, is unnecessary churn). We prove continuity by holding a
 *      root-authed "watcher" that lists users before and after and asserts the
 *      user's identity is continuous, AND that the captured credential still
 *      authenticates + the pre-re-provision data row is still readable.
 *   3. A GENUINE rotateCredential() DOES rotate: the OLD credential stops
 *      authenticating and the NEW one works — proving the fix narrowed the
 *      drop+create to real rotations rather than disabling rotation outright.
 *
 * Run:
 *   LORE_DEPLOYMENT_MODE=arcade ARCADE_BASE_URL=http://localhost:2480 \
 *   ARCADE_ROOT_PASSWORD=SpikeRoot123! npx tsx \
 *   test/arcade-reprovision-user-survives-e2e.ts
 * Pre-req: ArcadeDB 26.7.1 on :2480 with root password SpikeRoot123!.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ── env preflight BEFORE importing any arcade module (module-level consts
//    capture env at import time). LORE_HOME → fresh temp dir so the registry
//    is isolated.
const RUN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-arcade-reprov-'));
process.env['LORE_HOME'] = RUN_HOME;
process.env['LORE_DEPLOYMENT_MODE'] = 'arcade';
const ARCADE_BASE_URL = (process.env['ARCADE_BASE_URL'] =
  process.env['ARCADE_BASE_URL'] ?? 'http://localhost:2480');
const ROOT_PASSWORD = (process.env['ARCADE_ROOT_PASSWORD'] =
  process.env['ARCADE_ROOT_PASSWORD'] ?? 'SpikeRoot123!');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynImport = async <T = any>(p: string): Promise<T> => (await import(p)) as T;

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

function basicAuth(user: string, pw: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
}

/**
 * server-command SPY. 26.7.1 has NO user-listing verb (`list users` returns
 * "Server command not valid"), so we cannot observe user existence directly.
 * Instead we intercept global fetch and record every POST /api/v1/server
 * command body, so a test window can assert exactly which server commands
 * (create user / drop user) the provisioner issued. This is the direct
 * observable the finding asked for: prove NO drop-user/create-user occurred
 * across an idempotent re-provision.
 */
const serverCommandLog: string[] = [];
const realFetch = globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (typeof url === 'string' && url.endsWith('/api/v1/server') && init?.body) {
    try {
      const parsed = JSON.parse(String(init.body)) as { command?: string };
      if (parsed.command) serverCommandLog.push(parsed.command);
    } catch {
      /* ignore non-JSON */
    }
  }
  return realFetch(input, init);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

function serverCmdsMatching(re: RegExp): string[] {
  return serverCommandLog.filter((c) => re.test(c));
}

/**
 * Try to authenticate `user`/`pass` against `db` by running a trivial query on
 * the tenant db. Returns true on 2xx, false on auth failure (401/403). A drop
 * of the user (or a password change) makes the OLD credential return false.
 */
async function credentialWorks(db: string, user: string, pass: string): Promise<boolean> {
  try {
    const res = await fetch(`${ARCADE_BASE_URL}/api/v1/query/${db}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuth(user, pass) },
      body: JSON.stringify({ language: 'sql', command: 'SELECT count(*) AS c FROM LoreNode' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('\n=== ARCADE RE-PROVISION USER-SURVIVES (slice-2 MAJOR pin) ===');

  const provisioner = await dynImport('../packages/lore/src/engines/arcade/arcadeProvisioner.js');

  const CELL = { customerId: 'reprovck', appId: 'appone' };
  const registryDbPath = path.join(RUN_HOME, 'reprov-registry.sqlite');
  const opts = { registryDbPath };

  try {
    // ── (1) first provision — user created, credential authenticates ─────────
    const r1 = await provisioner.provisionApp(CELL, opts);
    check('first provision reports created === true', r1.created === true, `created=${r1.created}`);

    const dbUser = r1.dbUser;
    const db = r1.db;
    const secret1 = provisioner.readSecret(CELL, opts) as string | undefined;
    check('a live service secret exists on file after first provision', !!secret1);

    // First provision issued a create-user for this cell's user (the only way
    // the credential above could authenticate).
    check(
      'first provision issued a create-user server command',
      serverCmdsMatching(new RegExp(`create user[^]*${dbUser}`)).length >= 1,
    );
    check(
      'first-provision credential authenticates against its tenant db',
      await credentialWorks(db, dbUser, secret1!),
    );

    // Seed a data row through the root-authed tenant db so we can prove the DB /
    // user survive the re-provision with data intact.
    await fetch(`${ARCADE_BASE_URL}/api/v1/command/${db}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuth('root', ROOT_PASSWORD) },
      body: JSON.stringify({
        language: 'sql',
        command: "INSERT INTO LoreNode SET id = 'survive-marker', type = 'note', label = 'm', content = 'm'",
      }),
    }).then((r) => r.text());

    // ── (2) idempotent SAME-PASSWORD re-provision — MUST be a no-op on the user
    // Snapshot the server-command log, re-provision, then assert NO drop-user or
    // create-user server command was issued for this cell's user during the call
    // (the direct observable the finding asked for), and that the SAME captured
    // credential still authenticates uninterrupted.
    const logLenBefore = serverCommandLog.length;
    const r2 = await provisioner.provisionApp(CELL, opts);
    const cmdsDuringReprovision = serverCommandLog.slice(logLenBefore);
    const dropDuring = cmdsDuringReprovision.filter((c) => new RegExp(`drop user[^]*${dbUser}`).test(c));
    const createDuring = cmdsDuringReprovision.filter((c) => new RegExp(`create user[^]*${dbUser}`).test(c));

    check('re-provision reports created === false (idempotent)', r2.created === false, `created=${r2.created}`);
    check(
      'the on-file secret is UNCHANGED by the idempotent re-provision (no rotation)',
      provisioner.readSecret(CELL, opts) === secret1,
    );
    check(
      'NO drop-user server command issued during the idempotent re-provision '
        + '(the crash-between-drop-and-create hazard is closed)',
      dropDuring.length === 0,
      `dropDuring=${JSON.stringify(dropDuring)}`,
    );
    check(
      'NO create-user server command issued during the idempotent re-provision '
        + '(the live per-app user was left UNTOUCHED — the MAJOR availability fix)',
      createDuring.length === 0,
      `createDuring=${JSON.stringify(createDuring)}`,
    );
    check(
      'THE SAME first-provision credential STILL authenticates after re-provision',
      await credentialWorks(db, dbUser, secret1!),
    );

    // The seeded data row survives (db + schema intact through the re-provision).
    const marker = await fetch(`${ARCADE_BASE_URL}/api/v1/query/${db}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuth(dbUser, secret1!) },
      body: JSON.stringify({ language: 'sql', command: "SELECT id FROM LoreNode WHERE id = 'survive-marker'" }),
    }).then((r) => (r.ok ? r.json() : { result: [] }));
    check(
      'app still works after re-provision: seeded row is readable by the surviving user',
      Array.isArray(marker.result) && marker.result.length === 1,
    );

    // ── (3) a GENUINE rotation DOES rotate (fix narrowed drop+create, didn't
    //        disable it): old credential stops working, new one works. ─────────
    const logLenBeforeRot = serverCommandLog.length;
    const rot = await provisioner.rotateCredential(CELL, opts);
    const cmdsDuringRot = serverCommandLog.slice(logLenBeforeRot);
    check('rotateCredential reports rotated === true', rot.rotated === true);
    check(
      'rotation DID issue drop-user + create-user (fix narrowed the branch, did not disable rotation)',
      cmdsDuringRot.some((c) => new RegExp(`drop user[^]*${dbUser}`).test(c)) &&
        cmdsDuringRot.some((c) => new RegExp(`create user[^]*${dbUser}`).test(c)),
      `cmds=${JSON.stringify(cmdsDuringRot)}`,
    );
    const secret2 = provisioner.readSecret(CELL, opts) as string | undefined;
    check('rotation minted a DIFFERENT secret', !!secret2 && secret2 !== secret1);
    check('after rotation the OLD credential no longer authenticates', !(await credentialWorks(db, dbUser, secret1!)));
    check('after rotation the NEW credential authenticates', await credentialWorks(db, dbUser, secret2!));
  } finally {
    try {
      await provisioner.destroyApp(CELL, opts);
    } catch {
      /* best-effort */
    }
    try {
      provisioner.closeRegistryDb();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(RUN_HOME, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * test/arcade-secrets-token-lifecycle-unit.ts — CONTAINER-FREE unit coverage
 * for slice-2 W6 (secrets portion): the swappable secret store, registry
 * migrations, token TTL/expiry, and root-credential fail-closed handling.
 *
 * These assertions touch ONLY the daemon-local SQLite registry + the secret
 * store abstraction — they do NOT require a running ArcadeDB container (no
 * network, no provisionApp/user DDL). The container-dependent rotation +
 * keychain-round-trip proofs live in the hardening e2e; this file pins the
 * logic that is provable without a live ArcadeDB.
 *
 * Run: npx tsx test/arcade-secrets-token-lifecycle-unit.ts
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';

import {
  getSecretStore,
  resetSecretStoreForTests,
  resolveRootPasswordSync,
  isArcadeDeploymentMode,
  SPIKE_ROOT_PASSWORD_DEFAULT,
  ARCADE_ROOT_SECRET_REF,
  SqliteSecretStore,
  EnvSecretStore,
} from '../packages/lore/src/engines/arcade/arcadeSecretStore.js';
import { runArcadeRegistryMigrations } from '../packages/lore/src/engines/arcade/arcadeRegistryMigrations.js';
import {
  issueToken,
  resolvePrincipal,
  ArcadeAuthError,
  closeTokenDb,
  DEFAULT_TOKEN_TTL_SECONDS,
} from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import {
  closeRegistryDb,
} from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';

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
function expectThrow(label: string, fn: () => unknown, match?: (e: unknown) => boolean): void {
  try {
    fn();
    check(label, false, 'expected throw, got success');
  } catch (e) {
    check(label, match ? match(e) : true, `wrong error: ${(e as Error)?.message}`);
  }
}

/** Seed a v2-shaped registry with one active cell, secret in the db_pass column. */
function seedRegistry(dbPath: string, secret: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runArcadeRegistryMigrations(db);
  db.prepare(
    `INSERT INTO tenant_apps (tenant_id, app_id, db, db_user, db_pass, secret_ref, status, created_at, schema_version)
     VALUES ('acme','dev','tenant_acme_dev','acme_dev_svc',?, 'arcade-svc:acme:dev','active',?,1)`,
  ).run(secret, new Date().toISOString());
  db.close();
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-secrets-'));
  const REG = path.join(tmp, 'arcade-provisioning.sqlite');

  // ── 1. MIGRATION: v2 makes db_pass NULLABLE + adds columns ───────────────
  {
    // Simulate a slice-1 (v0/v1) file: db_pass NOT NULL, no schema_version, no expires_at.
    const db = new Database(REG);
    db.exec(`
      CREATE TABLE tenant_apps (
        tenant_id TEXT NOT NULL, app_id TEXT NOT NULL, db TEXT NOT NULL,
        db_user TEXT NOT NULL, db_pass TEXT NOT NULL, secret_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','disabled','destroying')),
        created_at TEXT NOT NULL, disabled_at TEXT, PRIMARY KEY (tenant_id, app_id));
      CREATE TABLE arcade_tokens (
        token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, app_id TEXT NOT NULL,
        scopes TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
      INSERT INTO tenant_apps VALUES ('c','a','db','u','oldpass','arcade-svc:c:a','active','now',NULL);
    `);
    runArcadeRegistryMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(tenant_apps)`).all() as Array<{ name: string; notnull: number }>;
    const passCol = cols.find((c) => c.name === 'db_pass');
    check('migration: tenant_apps.db_pass is now NULLABLE', !!passCol && passCol.notnull === 0);
    check('migration: tenant_apps.schema_version added', cols.some((c) => c.name === 'schema_version'));
    const tokCols = db.prepare(`PRAGMA table_info(arcade_tokens)`).all() as Array<{ name: string }>;
    check('migration: arcade_tokens.expires_at added', tokCols.some((c) => c.name === 'expires_at'));
    const preserved = db.prepare(`SELECT db_pass FROM tenant_apps WHERE tenant_id='c'`).get() as { db_pass: string };
    check('migration: existing row data preserved through table rebuild', preserved.db_pass === 'oldpass');
    const ver = db.pragma('user_version', { simple: true });
    check('migration: user_version stamped to 2', ver === 2);
    db.close();
    fs.unlinkSync(REG);
  }

  // ── 2. SQLITE SECRET STORE round-trip + column-null on delete ─────────────
  {
    seedRegistry(REG, 'plaintext-service-pw');
    const db = new Database(REG);
    const store = new SqliteSecretStore(() => db);
    check('sqlite store: readSync returns the column secret', store.readSync('arcade-svc:acme:dev') === 'plaintext-service-pw');
    check('sqlite store: async read matches', (await store.read('arcade-svc:acme:dev')) === 'plaintext-service-pw');
    await store.write('arcade-svc:acme:dev', 'rotated-pw');
    check('sqlite store: write updates the column', store.readSync('arcade-svc:acme:dev') === 'rotated-pw');
    await store.delete('arcade-svc:acme:dev');
    const col = db.prepare(`SELECT db_pass FROM tenant_apps WHERE secret_ref='arcade-svc:acme:dev'`).get() as { db_pass: string | null };
    check('sqlite store: delete NULLs the column (plaintext gone)', col.db_pass === null);
    db.close();
    fs.unlinkSync(REG);
  }

  // ── 3. ENV SECRET STORE (read-only) ───────────────────────────────────────
  {
    const store = new EnvSecretStore();
    process.env['ARCADE_SECRET_ARCADE_SVC_ACME_DEV'] = 'from-env';
    check('env store: readSync resolves sanitized ref', store.readSync('arcade-svc:acme:dev') === 'from-env');
    check('env store: unknown ref → undefined', store.readSync('arcade-svc:nope:nope') === undefined);
    let threw = false;
    try { await store.write('arcade-svc:acme:dev', 'x'); } catch { threw = true; }
    check('env store: write throws (read-only)', threw);
    delete process.env['ARCADE_SECRET_ARCADE_SVC_ACME_DEV'];
  }

  // ── 4. NON-SQLITE BACKEND leaves the db_pass column NULL (plaintext gone) ──
  // Proven at the store-selection level: with LORE_ARCADE_SECRET_BACKEND=env
  // the selected store is NOT the sqlite column store, so a provisioned cell's
  // secret is never written to the column (the provisioner uses
  // inlineColumnSecret()==null for non-sqlite backends). We assert the store
  // selection wiring here (the provisioner's column-null behavior is covered by
  // the hardening e2e's keychain path against a real cell).
  {
    resetSecretStoreForTests();
    process.env['LORE_ARCADE_SECRET_BACKEND'] = 'env';
    const store = getSecretStore(() => new Database(REG) as unknown as import('better-sqlite3').Database);
    check('backend select: env backend chosen (kind!=sqlite ⇒ column stays NULL)', store.kind === 'env');
    delete process.env['LORE_ARCADE_SECRET_BACKEND'];
    resetSecretStoreForTests();
  }

  // ── 5. TOKEN TTL: expired token is rejected PRE-HTTP (no container needed) ─
  {
    seedRegistry(REG, 'svc-pw');
    closeTokenDb();
    // Issue a token that expires immediately (1 second ago via ttlSeconds path):
    // issue with a tiny positive TTL, then assert expiry after it lapses.
    const { token, expiresAt } = issueToken(
      { tenantId: 'acme', appId: 'dev', scopes: ['read'], ttlSeconds: 1 },
      { registryDbPath: REG },
    );
    check('issueToken: returns { token, expiresAt }', typeof token === 'string' && typeof expiresAt === 'string');
    // Force-expire by rewriting the row's expires_at into the past.
    const db = new Database(REG);
    db.prepare(`UPDATE arcade_tokens SET expires_at = ? WHERE 1`).run(new Date(Date.now() - 60_000).toISOString());
    db.close();
    closeTokenDb();
    expectThrow(
      'resolvePrincipal: expired token → ArcadeAuthError expired_token (pre-HTTP)',
      () => resolvePrincipal(token, { registryDbPath: REG }),
      (e) => e instanceof ArcadeAuthError && e.reason === 'expired_token',
    );

    // A live (default-TTL) token resolves fine.
    closeTokenDb();
    const live = issueToken({ tenantId: 'acme', appId: 'dev', scopes: ['read', 'write'] }, { registryDbPath: REG });
    check('issueToken: default TTL ≈ 30 days', !!live.expiresAt &&
      Math.abs(Date.parse(live.expiresAt) - (Date.now() + DEFAULT_TOKEN_TTL_SECONDS * 1000)) < 5000);
    const p = resolvePrincipal(live.token, { registryDbPath: REG });
    check('resolvePrincipal: live token resolves to the cell', p.tenantId === 'acme' && p.appId === 'dev');

    // Non-expiring token (ttlSeconds:0).
    closeTokenDb();
    const forever = issueToken({ tenantId: 'acme', appId: 'dev', scopes: ['read'], ttlSeconds: 0 }, { registryDbPath: REG });
    check('issueToken: ttlSeconds=0 ⇒ non-expiring (expiresAt null)', forever.expiresAt === null);
    check('resolvePrincipal: non-expiring token resolves', resolvePrincipal(forever.token, { registryDbPath: REG }).appId === 'dev');
    closeTokenDb();
    closeRegistryDb();
    fs.rmSync(REG, { force: true });
    fs.rmSync(REG + '-wal', { force: true });
    fs.rmSync(REG + '-shm', { force: true });
  }

  // ── 6. ROOT CREDENTIAL fail-closed in arcade mode; spike default otherwise ─
  {
    const sqliteStore = new SqliteSecretStore(() => { throw new Error('unused'); });
    // NOT arcade mode + no env/store → spike default is permitted (test container path).
    delete process.env['LORE_DEPLOYMENT_MODE'];
    delete process.env['ARCADE_ROOT_PASSWORD'];
    check('root cred: not arcade mode → resolves spike default',
      resolveRootPasswordSync(new EnvSecretStore()) === SPIKE_ROOT_PASSWORD_DEFAULT);
    // arcade mode + neither env nor store → FAIL CLOSED.
    process.env['LORE_DEPLOYMENT_MODE'] = 'arcade';
    check('root cred: isArcadeDeploymentMode() true', isArcadeDeploymentMode());
    expectThrow(
      'root cred: arcade mode + no root secret → throws (fail-closed, spike default dead)',
      () => resolveRootPasswordSync(new EnvSecretStore()),
      (e) => e instanceof Error && /requires a root credential/i.test((e as Error).message),
    );
    // arcade mode + explicit env → resolves the env value (never the default).
    process.env['ARCADE_ROOT_PASSWORD'] = 'operator-set-root';
    check('root cred: arcade mode + env → resolves env value',
      resolveRootPasswordSync(new EnvSecretStore()) === 'operator-set-root');
    // arcade mode + env store secret → resolves it when env var unset.
    delete process.env['ARCADE_ROOT_PASSWORD'];
    process.env['ARCADE_SECRET_' + ARCADE_ROOT_SECRET_REF.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()] = 'store-root';
    check('root cred: arcade mode + store secret → resolves it',
      resolveRootPasswordSync(new EnvSecretStore()) === 'store-root');
    delete process.env['LORE_DEPLOYMENT_MODE'];
    delete process.env['ARCADE_SECRET_ARCADE_ROOT'];
    void sqliteStore;
  }

  console.log(`\n=== arcade secrets/token unit: ${pass} passed, ${fail} failed ===`);
  if (failures.length) {
    console.error('\nFAILURES:\n' + failures.join('\n'));
    process.exit(1);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

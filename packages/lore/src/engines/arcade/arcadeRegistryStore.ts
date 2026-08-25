/**
 * arcadeRegistryStore.ts — the daemon-local SQLite registry
 * (`arcade-provisioning.sqlite`): connection lifecycle, tenant_apps row helpers,
 * and the secret-store indirection. Split out of arcadeProvisioner.ts for the
 * file-size budget (slice 5); behaviour is unchanged.
 * (branch: spike/arcadedb-multitenant, slice 5 GA hardening)
 *
 * Relational-lane decision (see project CLAUDE.md / spike DECISION FRAME): the
 * `tenant_apps` table is daemon-local INFRASTRUCTURE bookkeeping — it records
 * what THIS daemon provisioned, not tenant graph/vector data — so it lives in
 * the daemon's SQLite lane, never inside ArcadeDB. It is the single source of
 * truth the token registry resolves against.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

import { loreHomePath } from '../../config/loreHome.js';
import { runArcadeRegistryMigrations } from './arcadeRegistryMigrations.js';
import { getSecretStore, type ArcadeSecretStore } from './arcadeSecretStore.js';

export interface TenantAppRow {
  tenant_id: string;
  app_id: string;
  db: string;
  db_user: string;
  secret_ref: string;
  status: 'active' | 'disabled' | 'destroying';
  created_at: string;
  disabled_at: string | null;
}

// ── connection lifecycle (single cached handle, keyed by path) ──────────────

let cachedDb: DatabaseType | null = null;
let cachedDbPath: string | null = null;

export function provisioningDbPath(): string {
  return loreHomePath('arcade-provisioning.sqlite');
}

export function openRegistryDb(dbPath: string = provisioningDbPath()): DatabaseType {
  if (cachedDb && cachedDbPath === dbPath) return cachedDb;
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Schema (tenant_apps + arcade_tokens + slice-5 cell_leases/arcade_secrets/
  // cell_backups) is owned by the versioned migration runner — idempotent.
  runArcadeRegistryMigrations(db);
  cachedDb = db;
  cachedDbPath = dbPath;
  return db;
}

/** Test/ops hook: force-close the cached handle (e.g. before deleting the file). */
export function closeRegistryDb(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
    cachedDbPath = null;
  }
}

// ── secret store indirection (the KMS/keychain swap point) ──────────────────
//
// The store is keyed by secretRef and selected by LORE_ARCADE_SECRET_BACKEND.
// The SQLite backend reads/writes tenant_apps.db_pass via the registry handle;
// keychain/env/kms hold the secret externally (column stays NULL).

export function secretStore(registryDbPath?: string): ArcadeSecretStore {
  // The supplier resolves the SAME registry handle the provisioner is using,
  // honoring a test/ops-provided registryDbPath (openRegistryDb caches by path).
  return getSecretStore(() => openRegistryDb(registryDbPath));
}

/**
 * inlineColumnSecret — the value to persist in the tenant_apps.db_pass COLUMN
 * for a given backend. The sqlite backend keeps the secret in the column (dev
 * default); every other backend (keychain/env/kms) leaves the column NULL and
 * holds the secret in the external store. This is what makes "plaintext gone
 * from the column" true under a non-sqlite backend.
 */
export function inlineColumnSecret(store: ArcadeSecretStore, secret: string): string | null {
  return store.kind === 'sqlite' ? secret : null;
}

/**
 * persistSecret — write a cell's service password through the secret store.
 * For sqlite this is a no-op (the row upsert already wrote the column); for
 * keychain/env/kms it writes to the external store. Async because the store seam
 * is async (keychain/kms). Never logs the secret.
 */
export async function persistSecret(
  store: ArcadeSecretStore,
  secretRef: string,
  secret: string,
): Promise<void> {
  if (store.kind === 'sqlite') return; // already written inline by the row upsert
  await store.write(secretRef, secret);
}

/**
 * loadSecret — read a cell's service password through the secret store. Prefers
 * the synchronous fast-path (sqlite/env) and falls back to async
 * (keychain/kms). The kms backend has NO readSync, so async is required there.
 */
export async function loadSecret(
  store: ArcadeSecretStore,
  secretRef: string,
): Promise<string | undefined> {
  const sync = store.readSync?.(secretRef);
  if (sync !== undefined) return sync;
  return store.read(secretRef);
}

// ── tenant_apps row helpers ─────────────────────────────────────────────────

export function getTenantAppRow(
  db: DatabaseType,
  tenantId: string,
  appId: string,
): (TenantAppRow & { db_pass: string | null }) | undefined {
  return db
    .prepare(
      `SELECT tenant_id, app_id, db, db_user, db_pass, secret_ref, status, created_at, disabled_at
       FROM tenant_apps WHERE tenant_id = ? AND app_id = ?`,
    )
    .get(tenantId, appId) as (TenantAppRow & { db_pass: string | null }) | undefined;
}

// Upsert the cell row. `dbPass` is the secret to store INLINE in the column and
// is populated only for the sqlite backend; for keychain/env/kms the column is
// left NULL (the secret lives in the external store). db_pass is NULLABLE
// (registry migration v2), so passing null is valid.
export function upsertTenantAppRow(
  db: DatabaseType,
  row: {
    tenantId: string;
    appId: string;
    dbName: string;
    dbUser: string;
    dbPass: string | null;
    secretRef: string;
    status: 'active' | 'disabled' | 'destroying';
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO tenant_apps (tenant_id, app_id, db, db_user, db_pass, secret_ref, status, created_at, disabled_at)
     VALUES (@tenantId, @appId, @dbName, @dbUser, @dbPass, @secretRef, @status, @createdAt, NULL)
     ON CONFLICT(tenant_id, app_id) DO UPDATE SET
       db = excluded.db,
       db_user = excluded.db_user,
       db_pass = excluded.db_pass,
       secret_ref = excluded.secret_ref,
       status = 'active',
       disabled_at = NULL`,
  ).run(row);
}

export function listTenantAppRows(db: DatabaseType): TenantAppRow[] {
  return db
    .prepare(
      `SELECT tenant_id, app_id, db, db_user, secret_ref, status, created_at, disabled_at
       FROM tenant_apps ORDER BY tenant_id, app_id`,
    )
    .all() as TenantAppRow[];
}

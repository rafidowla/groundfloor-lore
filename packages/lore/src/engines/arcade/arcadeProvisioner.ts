/**
 * arcadeProvisioner.ts — public-verb FACADE for the ArcadeDB multi-tenant
 * (db-per-app / "Design A") production provisioning path.
 * (branch: spike/arcadedb-multitenant, slice 5 GA hardening)
 *
 * Slice 5 split this module (it sat at the 800-line hard cap) into one-concern
 * files, keeping this file as the public facade with re-exports so existing
 * tests/routes don't churn:
 *   - arcadeRootTransport.ts  — root creds + TLS-hardened root ArcadeHttp.
 *   - arcadeRegistryStore.ts  — SQLite registry lifecycle + tenant_apps rows +
 *                               secret-store indirection.
 *   - arcadeServiceUser.ts    — create/rotate/DROP the per-db service user.
 *   - arcadeCellLease.ts      — cross-daemon (multi-process) provisioning lock.
 *
 * Ownership boundary (see arcadeHttp.ts + arcadeRootTransport.ts): root/service
 * credentials for ArcadeDB are held ONLY behind the root transport. Tenant-facing
 * adapters build their own per-app db-scoped ArcadeHttp and never call
 * `.serverCommand()`. This module is the ONLY production caller of the root
 * transport's server commands.
 *
 * Idempotency: every verb below is safe to re-run (schema DDL is IF NOT EXISTS,
 * the live user is left untouched on a same-password re-provision, registry rows
 * are upserts). Slice 5 wraps each verb in `withCellLease` — the in-process
 * mutex PLUS a durable cross-daemon lease — so two daemon PROCESSES sharing one
 * registry file can't race create/drop-user; the loser sees CellLeaseHeldError
 * (→ 409 cell_lease_held) or waits and converges.
 *
 * Secrets posture: the ArcadeDB per-app service password is stored via the
 * swappable secret store (sqlite | keychain | env | kms). Under kms it is
 * envelope-encrypted (arcade_secrets) and tenant_apps.db_pass is NULL — the
 * plaintext is off-column. inlineColumnSecret keys on kind==='sqlite', so no
 * caller changes when the backend flips.
 */

import * as crypto from 'node:crypto';

import { DEFAULT_LOCAL_MODEL_DIM } from '../../providers/localEmbeddingProvider.js';
import { ArcadeHttpError } from './arcadeHttp.js';
import { graphSchemaDdl, verbatimSchemaDdl } from './arcadeSchema.js';
import {
  ARCADE_BASE_URL,
  ARCADE_ROOT_USER,
  ARCADE_ROOT_PASSWORD,
  spikeArcadeServerCommand,
  spikeArcadeCommand,
} from './arcadeRootTransport.js';
import {
  provisioningDbPath,
  openRegistryDb,
  closeRegistryDb,
  secretStore,
  inlineColumnSecret,
  persistSecret,
  loadSecret,
  getTenantAppRow,
  upsertTenantAppRow,
  listTenantAppRows,
  type TenantAppRow,
} from './arcadeRegistryStore.js';
import {
  createOrRotateServiceUser,
  dropServiceUser,
} from './arcadeServiceUser.js';
import { withCellLease } from './arcadeCellLease.js';

// ── re-exports (stable public surface — existing callers unchanged) ──────────
export {
  ARCADE_BASE_URL,
  ARCADE_ROOT_USER,
  ARCADE_ROOT_PASSWORD,
} from './arcadeRootTransport.js';
export {
  provisioningDbPath,
  closeRegistryDb,
} from './arcadeRegistryStore.js';
export type { TenantAppRow } from './arcadeRegistryStore.js';
export { withCellLease, withCellLock, CellLeaseHeldError } from './arcadeCellLease.js';

// ── types ────────────────────────────────────────────────────────────────

export interface ProvisionAppTenantInput {
  customerId: string;
  appId: string;
}

export interface ProvisionAppTenantResult {
  db: string;
  dbUser: string;
  secretRef: string;
  /** true if this call created new state; false if it was a no-op repair of an already-active cell. */
  created: boolean;
}

// ── naming ───────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9]+$/;

function assertValidIdentifier(kind: string, value: string): void {
  if (!NAME_RE.test(value)) {
    throw new Error(
      `[arcadeProvisioner] invalid ${kind} "${value}": must match ${NAME_RE} ` +
        `(lowercase alphanumeric only — this value is interpolated into SQL ` +
        `identifiers and ArcadeDB db/user names, so it cannot contain quotes, ` +
        `spaces, or SQL metacharacters).`,
    );
  }
}

export function dbNameFor(customerId: string, appId: string): string {
  return `tenant_${customerId}_${appId}`;
}

export function dbUserFor(customerId: string, appId: string): string {
  return `${customerId}_${appId}_svc`;
}

export function secretRefFor(customerId: string, appId: string): string {
  return `arcade-svc:${customerId}:${appId}`;
}

// ── ArcadeDB root-authed helpers (this module + arcadeServiceUser only) ─────

async function ensureDatabase(dbName: string): Promise<void> {
  try {
    await spikeArcadeServerCommand(`create database ${dbName}`);
  } catch (e) {
    if (!(e instanceof ArcadeHttpError) || !/already exists/i.test(e.body)) throw e;
  }
}

// Schema DDL — sourced ENTIRELY from arcadeSchema.ts (single source of truth),
// so the daemon-operator provisioning path here and the adapter lazy-init path
// cannot drift. Every statement is IF NOT EXISTS, so a re-run against an existing
// cell upgrades its schema in place (additive-only).
async function applyDesignASchema(dbName: string, embedDim: number): Promise<void> {
  for (const stmt of graphSchemaDdl()) {
    await spikeArcadeCommand(dbName, stmt);
  }
  for (const stmt of verbatimSchemaDdl(embedDim)) {
    await spikeArcadeCommand(dbName, stmt);
  }
}

// ── public API ───────────────────────────────────────────────────────────

/**
 * provisionApp — idempotent. Wrapped in withCellLease (in-process mutex + durable
 * cross-daemon lease). A same-password re-run is a TRUE no-op on the live user.
 *
 * Steps:
 *   1. ensureDatabase(tenant_<tenantId>_<appId>)
 *   2. apply Design-A schema DDL (IF NOT EXISTS everywhere)
 *   3. create-or-rotate the per-DB service user, admin on exactly one db
 *   4. upsert the tenant_apps SQLite row (source of truth for token registry)
 */
export async function provisionApp(
  input: ProvisionAppTenantInput,
  opts?: { registryDbPath?: string; embedDim?: number },
): Promise<ProvisionAppTenantResult> {
  const { customerId, appId } = input;
  assertValidIdentifier('customerId', customerId);
  assertValidIdentifier('appId', appId);

  return withCellLease(customerId, appId, async () => {
    const dbName = dbNameFor(customerId, appId);
    const dbUser = dbUserFor(customerId, appId);
    const secretRef = secretRefFor(customerId, appId);
    const embedDim = opts?.embedDim ?? DEFAULT_LOCAL_MODEL_DIM;

    const registryDb = openRegistryDb(opts?.registryDbPath);
    const store = secretStore(opts?.registryDbPath);
    const existing = getTenantAppRow(registryDb, customerId, appId);
    const created = existing === undefined;

    // Reuse the existing password on a repair re-run (read THROUGH the store so a
    // keychain/kms-backed cell reuses its live external secret rather than
    // churning). Mint a fresh 32-byte password only the first time.
    const priorSecret = existing ? await loadSecret(store, secretRef) : undefined;
    const dbPass = priorSecret ?? crypto.randomBytes(32).toString('base64url');

    await ensureDatabase(dbName);
    await applyDesignASchema(dbName, embedDim);
    // Only rotate the live ArcadeDB user when we minted a FRESH password
    // (priorSecret undefined). A same-password re-provision is a TRUE no-op.
    await createOrRotateServiceUser(dbUser, dbPass, dbName, {
      rotateIfExists: priorSecret === undefined,
      assumeExists: existing !== undefined && priorSecret !== undefined,
    });

    upsertTenantAppRow(registryDb, {
      tenantId: customerId,
      appId,
      dbName,
      dbUser,
      dbPass: inlineColumnSecret(store, dbPass),
      secretRef,
      status: 'active',
      createdAt: existing?.created_at ?? new Date().toISOString(),
    });
    // For non-sqlite backends (keychain/env/kms) write the secret to the external
    // store (the column was set NULL by the upsert above). Under kms this is the
    // envelope-encrypt into arcade_secrets.
    await persistSecret(store, secretRef, dbPass);

    return { db: dbName, dbUser, secretRef, created };
  }, { registryDbPath: opts?.registryDbPath });
}

/**
 * disableApp — phase 1 of two-phase deprovision. Rotates the service user to an
 * unrecoverable password (revoke equivalent) and marks the row 'disabled'.
 */
export async function disableApp(
  input: ProvisionAppTenantInput,
  opts?: { registryDbPath?: string },
): Promise<void> {
  const { customerId, appId } = input;
  assertValidIdentifier('customerId', customerId);
  assertValidIdentifier('appId', appId);

  return withCellLease(customerId, appId, async () => {
    const registryDb = openRegistryDb(opts?.registryDbPath);
    const store = secretStore(opts?.registryDbPath);
    const row = getTenantAppRow(registryDb, customerId, appId);
    if (!row) return; // nothing to disable — idempotent no-op

    const deadPassword = crypto.randomBytes(32).toString('base64url');
    // Always rotate: disable swaps the live user to an unrecoverable password.
    await createOrRotateServiceUser(row.db_user, deadPassword, row.db, {
      rotateIfExists: true,
    });

    registryDb
      .prepare(
        `UPDATE tenant_apps SET status = 'disabled', disabled_at = ?, db_pass = ?
         WHERE tenant_id = ? AND app_id = ?`,
      )
      .run(new Date().toISOString(), inlineColumnSecret(store, deadPassword), customerId, appId);
    await persistSecret(store, row.secret_ref, deadPassword);
  }, { registryDbPath: opts?.registryDbPath });
}

/**
 * destroyApp — phase 2 of two-phase deprovision. Drops the ArcadeDB database,
 * DROPS THE SERVER-LEVEL USER (slice-5 cleanup fix), purges the cell's outbox
 * lane, deletes the external secret + arcade_secrets row, and deletes the
 * registry row. Idempotent: dropping an already-gone db/user is swallowed.
 *
 * Ordering inside the lease (slice-5 design): mark 'destroying' → drop database →
 * DROP USER → purge outbox → store.delete(secretRef) → delete registry row.
 */
export async function destroyApp(
  input: ProvisionAppTenantInput,
  // Slice-4 outboxStore (structural, avoids an import cycle) → purge the lane.
  opts?: { registryDbPath?: string; outboxStore?: { deleteByWorkspace?: (workspace: string) => Promise<number> } },
): Promise<void> {
  const { customerId, appId } = input;
  assertValidIdentifier('customerId', customerId);
  assertValidIdentifier('appId', appId);

  return withCellLease(customerId, appId, async () => {
    const registryDb = openRegistryDb(opts?.registryDbPath);
    const store = secretStore(opts?.registryDbPath);
    const row = getTenantAppRow(registryDb, customerId, appId);
    const dbName = row?.db ?? dbNameFor(customerId, appId);
    const dbUser = row?.db_user ?? dbUserFor(customerId, appId);
    const secretRef = row?.secret_ref ?? secretRefFor(customerId, appId);

    registryDb
      .prepare(`UPDATE tenant_apps SET status = 'destroying' WHERE tenant_id = ? AND app_id = ?`)
      .run(customerId, appId);

    try {
      await spikeArcadeServerCommand(`drop database ${dbName}`);
    } catch (e) {
      if (!(e instanceof ArcadeHttpError) || !/not exist|not found/i.test(e.body)) throw e;
    }

    // SLICE-5 CLEANUP FIX: drop the server-level ArcadeDB user so it does not
    // orphan forever (the concrete bug). Idempotent twin of create — a
    // not-exists response is swallowed. Ordered AFTER the db drop, BEFORE the
    // registry row delete, so a crash between steps still converges on re-run.
    await dropServiceUser(dbUser);

    // Right-to-be-forgotten: purge the cell's outbox lane (arcade:<t>:<a>).
    if (opts?.outboxStore?.deleteByWorkspace) await opts.outboxStore.deleteByWorkspace(`arcade:${customerId}:${appId}`);
    // Purge the external secret (no-op for env; NULLs the column for sqlite;
    // deletes the arcade_secrets row for kms) so no credential outlives the db.
    await store.delete(secretRef);

    registryDb
      .prepare(`DELETE FROM tenant_apps WHERE tenant_id = ? AND app_id = ?`)
      .run(customerId, appId);
  }, { registryDbPath: opts?.registryDbPath });
}

/**
 * rotateCredential — operator verb to mint a FRESH service password for an active
 * cell and swap it in. Crash-tolerant ordering: mint → write to store FIRST →
 * drop+create the ArcadeDB user. Returns the ref (never the secret).
 */
export async function rotateCredential(
  input: ProvisionAppTenantInput,
  opts?: { registryDbPath?: string },
): Promise<{ rotated: boolean; secretRef: string }> {
  const { customerId, appId } = input;
  assertValidIdentifier('customerId', customerId);
  assertValidIdentifier('appId', appId);

  return withCellLease(customerId, appId, async () => {
    const registryDb = openRegistryDb(opts?.registryDbPath);
    const store = secretStore(opts?.registryDbPath);
    const row = getTenantAppRow(registryDb, customerId, appId);
    if (!row || row.status !== 'active') {
      throw new Error(
        `[arcadeProvisioner] cannot rotate credential for ` +
          `(${customerId}, ${appId}): cell is ${row ? `'${row.status}'` : 'not provisioned'}`,
      );
    }

    const fresh = crypto.randomBytes(32).toString('base64url');

    // (2) store FIRST (crash-recoverable): column for sqlite, external store for
    //     keychain/env/kms (envelope-encrypt under kms).
    registryDb
      .prepare(`UPDATE tenant_apps SET db_pass = ? WHERE tenant_id = ? AND app_id = ?`)
      .run(inlineColumnSecret(store, fresh), customerId, appId);
    await persistSecret(store, row.secret_ref, fresh);

    // (3) drop+create the ArcadeDB user with the new password. Always rotate.
    await createOrRotateServiceUser(row.db_user, fresh, row.db, {
      rotateIfExists: true,
    });

    return { rotated: true, secretRef: row.secret_ref };
  }, { registryDbPath: opts?.registryDbPath });
}

/** Read-only lookup used by the token registry / ops tooling. */
export function getTenantApp(
  input: ProvisionAppTenantInput,
  opts?: { registryDbPath?: string },
): TenantAppRow | undefined {
  const registryDb = openRegistryDb(opts?.registryDbPath);
  const row = getTenantAppRow(registryDb, input.customerId, input.appId);
  if (!row) return undefined;
  const { db_pass: _dbPass, ...rest } = row;
  return rest;
}

/**
 * readSecret — resolve the live service-account secret THROUGH the secret store.
 * Synchronous fast-path: works for sqlite (default) + env. keychain/kms return
 * undefined here (async-only) — use readSecretAsync in that case.
 */
export function readSecret(
  input: ProvisionAppTenantInput,
  opts?: { registryDbPath?: string },
): string | undefined {
  const secretRef = secretRefFor(input.customerId, input.appId);
  return secretStore(opts?.registryDbPath).readSync?.(secretRef);
}

/**
 * readSecretAsync — async secret resolution that works for EVERY backend
 * (including keychain/kms). Prefer this at async call sites.
 */
export async function readSecretAsync(
  input: ProvisionAppTenantInput,
  opts?: { registryDbPath?: string },
): Promise<string | undefined> {
  const secretRef = secretRefFor(input.customerId, input.appId);
  return loadSecret(secretStore(opts?.registryDbPath), secretRef);
}

export function listTenantApps(opts?: { registryDbPath?: string }): TenantAppRow[] {
  return listTenantAppRows(openRegistryDb(opts?.registryDbPath));
}

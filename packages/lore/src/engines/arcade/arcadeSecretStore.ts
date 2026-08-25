/**
 * arcadeSecretStore.ts — swappable secret store for ArcadeDB per-app
 * service-account passwords (and the root/service credential).
 * (branch: spike/arcadedb-multitenant, slice 2 W6 — secrets portion)
 *
 * WHY THIS EXISTS
 * ---------------
 * Slice 1 stored the ArcadeDB per-app service password as plaintext in the
 * `tenant_apps.db_pass` SQLite column and read it directly from
 * `arcadeProvisioner.readSecret`. That was called out as a Phase-7 deferral.
 * This module IS that phase: it puts the secret behind a stable indirection so
 * the storage medium is swappable without touching a single caller or the
 * registry schema.
 *
 * THE SEAM (KMS-ready)
 * --------------------
 * `ArcadeSecretStore` is the whole seam. It is keyed by the already-shipped
 * `secretRef` string ('arcade-svc:<tenant>:<app>' for a cell, 'arcade-root'
 * for the root credential). The interface is async so a future KMS/Vault
 * backend is a NEW impl of this interface with ZERO schema or caller change —
 * exactly what the slice-1 header promised. Refs are stable identifiers, never
 * secret material, so they are safe to log.
 *
 * A synchronous fast-path (`readSync`) is provided ONLY for the SQLite and env
 * backends, so the existing synchronous call sites (`arcadeCellForToken`,
 * `readSecret`) keep working unchanged during this pass. A backend that cannot
 * answer synchronously (keychain, a future KMS) returns `undefined` from
 * `readSync` and callers fall back to the async `read`. New async-capable call
 * sites should prefer `read`.
 *
 * BACKENDS (selected by LORE_ARCADE_SECRET_BACKEND)
 * -------------------------------------------------
 *   - 'sqlite'   (default): today's `tenant_apps.db_pass` column, unchanged for
 *                dev. The column is now NULLABLE (registry migration v2) so a
 *                cell whose secret has migrated out reads NULL here.
 *   - 'keychain': OS keychain via the existing keytarLoader pattern
 *                (service-namespaced, account = secretRef). Async only.
 *   - 'env'      (read-only): ARCADE_SECRET_<SANITIZED_REF> for containerized
 *                deploys where secrets are injected as env vars.
 *
 * NEVER LOGS SECRET MATERIAL. Only refs (which are non-secret identifiers)
 * appear in any log line this module emits.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { loadKeytar } from '../../security/keytarLoader.js';
import { KmsSecretStore } from './arcadeKmsSecretStore.js';

/**
 * The swappable secret-store seam. A KMS/Vault backend is a new implementation
 * of exactly this interface — no schema change, no caller change.
 *
 * `read`/`write`/`delete` are async (the seam is async so the KMS impl can be).
 * `readSync` is an OPTIONAL fast-path: backends that can answer without I/O
 * (sqlite/env) implement it; backends that cannot (keychain/KMS) return
 * undefined and callers use the async path.
 */
export interface ArcadeSecretStore {
  /** async read — the canonical read path (works for every backend). */
  read(ref: string): Promise<string | undefined>;
  /** persist a secret under `ref`. */
  write(ref: string, value: string): Promise<void>;
  /** remove a secret (idempotent). */
  delete(ref: string): Promise<void>;
  /**
   * synchronous fast-path — returns undefined if this backend cannot answer
   * synchronously (keychain/KMS), in which case the caller uses `read`.
   */
  readSync?(ref: string): string | undefined;
  /** stable name for logs (non-secret). */
  readonly kind: 'sqlite' | 'keychain' | 'env' | 'kms';
}

export type ArcadeSecretBackend = 'sqlite' | 'keychain' | 'env' | 'kms';

const KEYCHAIN_SERVICE = 'groundfloor-lore.arcade';

/** Sanitize a secretRef into an env-var suffix: A–Z0–9_ uppercase. */
function envVarNameFor(ref: string): string {
  return 'ARCADE_SECRET_' + ref.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

// ── SQLite backend (default) ────────────────────────────────────────────────
//
// Reads/writes the `tenant_apps.db_pass` column keyed by secret_ref. This is
// the today-behaviour backend: it keeps dev unchanged. The provisioner owns the
// registry connection and passes it in via a supplier so this module never
// opens its own handle (single-writer discipline for the registry file).

export class SqliteSecretStore implements ArcadeSecretStore {
  readonly kind = 'sqlite' as const;
  constructor(private readonly dbSupplier: () => DatabaseType) {}

  readSync(ref: string): string | undefined {
    const row = this.dbSupplier()
      .prepare(`SELECT db_pass FROM tenant_apps WHERE secret_ref = ?`)
      .get(ref) as { db_pass: string | null } | undefined;
    return row?.db_pass ?? undefined;
  }

  read(ref: string): Promise<string | undefined> {
    return Promise.resolve(this.readSync(ref));
  }

  write(ref: string, value: string): Promise<void> {
    // The provisioner is the row owner; it upserts db_pass alongside the rest
    // of the row on provision. A standalone write here updates the column for a
    // ref that already has a row (rotation). If no row matches, this is a no-op
    // and the async path returns — the provisioner's upsert is the create path.
    this.dbSupplier()
      .prepare(`UPDATE tenant_apps SET db_pass = ? WHERE secret_ref = ?`)
      .run(value, ref);
    return Promise.resolve();
  }

  delete(ref: string): Promise<void> {
    this.dbSupplier()
      .prepare(`UPDATE tenant_apps SET db_pass = NULL WHERE secret_ref = ?`)
      .run(ref);
    return Promise.resolve();
  }
}

// ── env backend (read-only, containerized deploys) ──────────────────────────

export class EnvSecretStore implements ArcadeSecretStore {
  readonly kind = 'env' as const;

  readSync(ref: string): string | undefined {
    const v = process.env[envVarNameFor(ref)];
    return v && v.length > 0 ? v : undefined;
  }

  read(ref: string): Promise<string | undefined> {
    return Promise.resolve(this.readSync(ref));
  }

  write(_ref: string, _value: string): Promise<void> {
    throw new Error(
      `[arcadeSecretStore] env backend is read-only; cannot write secret ` +
        `(set ${envVarNameFor(_ref)} in the environment instead)`,
    );
  }

  delete(_ref: string): Promise<void> {
    // Env is externally managed; a delete is a no-op (the operator unsets it).
    return Promise.resolve();
  }
}

// ── keychain backend (OS keychain via keytar) ───────────────────────────────
//
// Account = secretRef, service-namespaced. No synchronous fast-path (keytar is
// async native I/O), so readSync is intentionally absent → callers use `read`.

export class KeychainSecretStore implements ArcadeSecretStore {
  readonly kind = 'keychain' as const;

  async read(ref: string): Promise<string | undefined> {
    const keytar = await loadKeytar('[arcadeSecretStore]');
    if (!keytar) {
      throw new Error(
        `[arcadeSecretStore] keychain backend selected but keytar is ` +
          `unavailable (native bindings failed to load); cannot read secret ref`,
      );
    }
    const v = await keytar.getPassword(KEYCHAIN_SERVICE, ref);
    return v ?? undefined;
  }

  async write(ref: string, value: string): Promise<void> {
    const keytar = await loadKeytar('[arcadeSecretStore]');
    if (!keytar) {
      throw new Error(
        `[arcadeSecretStore] keychain backend selected but keytar is unavailable; cannot write secret ref`,
      );
    }
    await keytar.setPassword(KEYCHAIN_SERVICE, ref, value);
  }

  async delete(ref: string): Promise<void> {
    const keytar = await loadKeytar('[arcadeSecretStore]');
    if (!keytar) return; // nothing to delete if the store never opened
    await keytar.deletePassword(KEYCHAIN_SERVICE, ref);
  }
}

// ── selection + singleton ────────────────────────────────────────────────────

let cachedStore: ArcadeSecretStore | null = null;
let cachedBackend: ArcadeSecretBackend | null = null;

export function resolveSecretBackend(): ArcadeSecretBackend {
  const raw = (process.env['LORE_ARCADE_SECRET_BACKEND'] ?? 'sqlite').toLowerCase();
  if (raw === 'keychain' || raw === 'env' || raw === 'sqlite' || raw === 'kms') return raw;
  console.error(
    `[arcadeSecretStore] ignoring invalid LORE_ARCADE_SECRET_BACKEND=${raw} ` +
      `(expected 'sqlite', 'keychain', 'env', or 'kms'); defaulting to 'sqlite'`,
  );
  return 'sqlite';
}

/**
 * getSecretStore — the process-wide store, selected by
 * LORE_ARCADE_SECRET_BACKEND. The SQLite backend needs the provisioner's
 * registry DB handle, so the provisioner passes a supplier; other backends
 * ignore it.
 */
export function getSecretStore(dbSupplier: () => DatabaseType): ArcadeSecretStore {
  const backend = resolveSecretBackend();
  // The sqlite AND kms backends close over `dbSupplier` (which honors the
  // caller's registry path), so they are built fresh each call — never cached —
  // to avoid a stale supplier pinning the wrong registry file across
  // differently-pathed callers (tests use custom registryDbPaths). The supplier
  // itself is cheap (openRegistryDb caches the actual handle by path).
  // keychain/env are stateless and safe to cache.
  if (backend === 'sqlite') return new SqliteSecretStore(dbSupplier);
  if (backend === 'kms') {
    // Envelope-encryption backend lives in its own file (one-concern) but is
    // selected here — the seam is unchanged for every caller. The KEK/provider
    // is resolved lazily inside KmsSecretStore's construction (loadKmsKeyProvider),
    // so importing the module is cheap; only selecting kms resolves the KEK.
    return new KmsSecretStore(dbSupplier);
  }
  if (cachedStore && cachedBackend === backend) return cachedStore;
  cachedStore = backend === 'keychain' ? new KeychainSecretStore() : new EnvSecretStore();
  cachedBackend = backend;
  return cachedStore;
}

/** Test/ops hook — drop the cached store so a test can re-select a backend. */
export function resetSecretStoreForTests(): void {
  cachedStore = null;
  cachedBackend = null;
}

// ── root/service credential resolution (fail-closed in arcade mode) ─────────

export const ARCADE_ROOT_SECRET_REF = 'arcade-root';

/** The compiled-in spike default — VALID ONLY for the local test container. */
export const SPIKE_ROOT_PASSWORD_DEFAULT = 'SpikeRoot123!';

/**
 * True when the daemon is (or is being booted) in arcade deployment mode.
 * W1 threads LORE_DEPLOYMENT_MODE=arcade end-to-end; until then this env read
 * is the single signal the secret layer keys its fail-closed behaviour off of.
 * Kept here (not in configManager) so the secrets portion is self-contained and
 * does not widen the substrate deploymentMode union ahead of W1.
 */
export function isArcadeDeploymentMode(): boolean {
  return (process.env['LORE_DEPLOYMENT_MODE'] ?? '').toLowerCase() === 'arcade';
}

/**
 * getRootSecretStore — the store used for the ROOT credential (ref
 * 'arcade-root'). It is DELIBERATELY independent of the per-app sqlite column
 * store: the root credential is never a `tenant_apps` row, so root resolution
 * must never open/close the registry DB (doing so mid-provision would close the
 * caller's registry handle). For the 'sqlite' selection the root falls back to
 * env-only (the registry has no root secret); 'keychain'/'env' use their own
 * backend. The result is a store whose readSync only ever consults env, so it
 * cannot perturb the registry connection.
 */
export function getRootSecretStore(): ArcadeSecretStore {
  const backend = resolveSecretBackend();
  // keychain keeps 'arcade-root' in the OS keychain; every other selection
  // (sqlite/env) resolves the root from env vars only — never the registry DB.
  return backend === 'keychain' ? new KeychainSecretStore() : new EnvSecretStore();
}

/**
 * preflightKmsSelfTest — boot-time fail-closed check for the kms backend
 * (mirrors resolveRootPassword's posture). Validates the KEK resolves AND does a
 * self-test encrypt/decrypt of a canary DEK through the configured provider. If
 * the KEK is absent/wrong-length/wrong-mode, or the round-trip fails, this
 * throws so an arcade daemon can never boot with a broken envelope key. Only
 * called when the selected backend is kms. Never logs secret material.
 */
export async function preflightKmsSelfTest(): Promise<void> {
  if (resolveSecretBackend() !== 'kms') return;
  // Lazy-load the provider seam so non-kms deploys never touch the crypto path.
  const { loadKmsKeyProvider } = await import('./arcadeKmsSecretStore.js');
  const provider = loadKmsKeyProvider(); // resolves the KEK (throws fail-closed)
  const { plaintextKey, wrappedKey, keyId } = await provider.generateDataKey();
  const unwrapped = await provider.decryptDataKey(wrappedKey, keyId);
  if (!unwrapped.equals(plaintextKey)) {
    throw new Error(
      `[arcadeSecretStore] kms backend self-test FAILED: canary DEK did not round-trip ` +
        `(provider=${provider.providerId}). Refusing to boot with a broken envelope key.`,
    );
  }
}

/**
 * resolveRootPassword — the root/service-account password for ArcadeDB
 * server-command DDL (create/drop db + user). Resolution order:
 *   1. explicit ARCADE_ROOT_PASSWORD env (operator/CI override), else
 *   2. the secret store under ref 'arcade-root' (async path), else
 *   3. the compiled-in spike default — PERMITTED ONLY when NOT in arcade
 *      deployment mode (i.e. the local test-container path).
 *
 * In arcade deployment mode, step 3 is DEAD: if neither env nor the store
 * yields a root password, this throws (fail-closed) so a production daemon can
 * never silently authenticate ArcadeDB with the spike default.
 *
 * Never logs the resolved value.
 */
export async function resolveRootPassword(
  store: ArcadeSecretStore,
): Promise<string> {
  const fromEnv = process.env['ARCADE_ROOT_PASSWORD'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const fromStore = await store.read(ARCADE_ROOT_SECRET_REF);
  if (fromStore && fromStore.length > 0) return fromStore;

  if (isArcadeDeploymentMode()) {
    throw new Error(
      `[arcadeSecretStore] arcade deployment mode requires a root credential: ` +
        `set ARCADE_ROOT_PASSWORD or store a secret under ref '${ARCADE_ROOT_SECRET_REF}' ` +
        `(backend=${store.kind}). The compiled-in spike default is disabled in ` +
        `arcade mode — refusing to boot with it.`,
    );
  }
  return SPIKE_ROOT_PASSWORD_DEFAULT;
}

/**
 * Synchronous root-password resolution for the legacy synchronous provisioner
 * transport. env > store.readSync (sqlite/env only) > spike default, with the
 * SAME fail-closed rule in arcade mode. Backends without a sync path
 * (keychain/KMS) must set ARCADE_ROOT_PASSWORD in arcade mode; if they don't,
 * this fails closed rather than falling through to the spike default.
 */
export function resolveRootPasswordSync(store: ArcadeSecretStore): string {
  const fromEnv = process.env['ARCADE_ROOT_PASSWORD'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const fromStore = store.readSync?.(ARCADE_ROOT_SECRET_REF);
  if (fromStore && fromStore.length > 0) return fromStore;

  if (isArcadeDeploymentMode()) {
    throw new Error(
      `[arcadeSecretStore] arcade deployment mode requires a root credential: ` +
        `set ARCADE_ROOT_PASSWORD (backend=${store.kind} cannot resolve ` +
        `'${ARCADE_ROOT_SECRET_REF}' synchronously). Refusing the spike default in arcade mode.`,
    );
  }
  return SPIKE_ROOT_PASSWORD_DEFAULT;
}

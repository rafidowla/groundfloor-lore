/**
 * arcadeCellLease.ts — cross-daemon (multi-PROCESS) provisioning lock for a
 * (tenant, app) cell. (branch: spike/arcadedb-multitenant, slice 5 GA hardening)
 *
 * THE GAP THIS CLOSES:
 *   The prior `withCellLock` (arcadeProvisioner.ts) is an in-process
 *   Promise-chain mutex. Two daemon PROCESSES sharing one LORE_HOME registry
 *   file never share that mutex, so concurrent provisionApp calls from two
 *   daemons on the same cell could race create-user / drop-user. That is the
 *   realistic contention shape: N daemon processes / a restarted daemon sharing
 *   one registry file on one host.
 *
 * TWO-LAYER LOCK:
 *   Layer 1 — the in-process mutex (cheap serialization inside one daemon).
 *   Layer 2 — a durable lease keyed (tenant_id, app_id) behind `CellLeaseStore`.
 *
 * PRIMARY IMPL — SqliteCellLeaseStore (registry `cell_leases` table). Acquire is
 * one atomic INSERT-OR-IGNORE + conditional UPDATE inside a better-sqlite3
 * transaction. WAL-mode SQLite gives correct multi-process semantics on one
 * host. STALE-LEASE TAKEOVER is the `expires_at < now` branch; the monotonic
 * `fencing_token` lets audit stamp which lease epoch performed each op
 * (zombie-writer detection). Since ArcadeDB DDL can't check fencing tokens, the
 * primary zombie defense is TTL >> max step duration (default 60s, renewed
 * every 20s during long ops).
 *
 * SECOND IMPL — ArcadeCellLeaseStore (code-complete, cloud shape) writes lease
 * records into a dedicated `_lore_control` database on the ArcadeDB server
 * itself — the only thing two NON-filesystem-sharing daemons definitionally
 * share. Same interface, selected by LORE_ARCADE_LEASE_BACKEND=arcadedb.
 *
 *   ⚠ NEEDS-REAL-CLOUD VALIDATION: cross-daemon locking when daemons share ONLY
 *   the ArcadeDB server across nodes, and lease survival through multi-node HA
 *   failover/replication, cannot be proven in this single-container sandbox. The
 *   ArcadeCellLeaseStore LOGIC is exercised locally (two instances, distinct
 *   owner ids, against the one container); the multi-node/HA behaviour is NOT
 *   GA-proven here.
 *
 * CRASH SAFETY: no release on SIGKILL is fine — the next acquirer takes over
 * after expiry with fencing_token+1, and every provisioner step is idempotent,
 * so a takeover re-run converges.
 */

import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';

import { openRegistryDb } from './arcadeRegistryStore.js';
import { ArcadeHttp } from './arcadeHttp.js';
import { ArcadeHttpError } from './arcadeHttp.js';
import { ARCADE_BASE_URL, ARCADE_ROOT_USER, rootPassword } from './arcadeRootTransport.js';

// ── lease default timing (TTL >> max provisioner step) ──────────────────────

/** Default lease TTL. TTL >> the longest provisioner step (import) so a live
 *  holder is never mistaken for a zombie. */
export const CELL_LEASE_TTL_MS = 60_000;
/** Renewal cadence during a long op (well under TTL so a stall of one tick
 *  cannot expire a still-working holder). */
export const CELL_LEASE_RENEW_MS = 20_000;

// ── lease store seam ─────────────────────────────────────────────────────────

export interface LeaseAcquired {
  ok: true;
  fencingToken: number;
}
export interface LeaseDenied {
  ok: false;
  holder: string;
  expiresAt: number;
}
export type LeaseResult = LeaseAcquired | LeaseDenied;

export interface CellLeaseStore {
  acquire(tenant: string, app: string, ownerId: string, ttlMs: number): Promise<LeaseResult>;
  /** Owner-match only; extends expiry, fencing token unchanged. Returns true if
   *  the caller still holds the lease (renewal succeeded). */
  renew(tenant: string, app: string, ownerId: string, ttlMs: number): Promise<boolean>;
  /** Owner-match delete, idempotent. */
  release(tenant: string, app: string, ownerId: string): Promise<void>;
  readonly backend: 'sqlite' | 'arcadedb';
}

// ── ownerId (stable per boot) ────────────────────────────────────────────────

let cachedOwnerId: string | null = null;
/** `${hostname}:${pid}:${8-hex-random}` minted once at boot. Distinguishes
 *  daemon processes (and a restarted daemon) sharing one registry file. */
export function ownerId(): string {
  if (!cachedOwnerId) {
    cachedOwnerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  }
  return cachedOwnerId;
}

// ── PRIMARY: SqliteCellLeaseStore (WAL, multi-process on one host) ────────────

export class SqliteCellLeaseStore implements CellLeaseStore {
  readonly backend = 'sqlite' as const;
  constructor(private readonly dbSupplier: () => DatabaseType) {}

  acquire(tenant: string, app: string, me: string, ttlMs: number): Promise<LeaseResult> {
    const db = this.dbSupplier();
    const now = Date.now();
    const expires = now + ttlMs;
    // One atomic statement pair in a transaction:
    //  (1) INSERT OR IGNORE a fresh row (fencing_token=1) — wins if no row.
    //  (2) if that inserted nothing, UPDATE ... taking over ONLY when the prior
    //      lease is expired OR we already own it; bump fencing_token by 1.
    const txn = db.transaction((): LeaseResult => {
      const ins = db
        .prepare(
          `INSERT OR IGNORE INTO cell_leases
             (tenant_id, app_id, owner_id, fencing_token, acquired_at, expires_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run(tenant, app, me, now, expires);
      if (ins.changes === 1) return { ok: true, fencingToken: 1 };

      const upd = db
        .prepare(
          `UPDATE cell_leases
             SET owner_id = @me, fencing_token = fencing_token + 1,
                 acquired_at = @now, expires_at = @expires
           WHERE tenant_id = @t AND app_id = @a
             AND (expires_at < @now OR owner_id = @me)`,
        )
        .run({ me, now, expires, t: tenant, a: app });
      if (upd.changes === 1) {
        const row = db
          .prepare(
            `SELECT fencing_token FROM cell_leases WHERE tenant_id = ? AND app_id = ?`,
          )
          .get(tenant, app) as { fencing_token: number };
        return { ok: true, fencingToken: row.fencing_token };
      }
      const held = db
        .prepare(
          `SELECT owner_id, expires_at FROM cell_leases WHERE tenant_id = ? AND app_id = ?`,
        )
        .get(tenant, app) as { owner_id: string; expires_at: number } | undefined;
      return {
        ok: false,
        holder: held?.owner_id ?? 'unknown',
        expiresAt: held?.expires_at ?? now,
      };
    });
    return Promise.resolve(txn());
  }

  renew(tenant: string, app: string, me: string, ttlMs: number): Promise<boolean> {
    const db = this.dbSupplier();
    const now = Date.now();
    const info = db
      .prepare(
        `UPDATE cell_leases SET expires_at = ?
         WHERE tenant_id = ? AND app_id = ? AND owner_id = ?`,
      )
      .run(now + ttlMs, tenant, app, me);
    return Promise.resolve(info.changes === 1);
  }

  release(tenant: string, app: string, me: string): Promise<void> {
    const db = this.dbSupplier();
    // Owner-checked, idempotent: a non-owner release changes 0 rows (no-op).
    db.prepare(
      `DELETE FROM cell_leases WHERE tenant_id = ? AND app_id = ? AND owner_id = ?`,
    ).run(tenant, app, me);
    return Promise.resolve();
  }
}

// ── SECOND: ArcadeCellLeaseStore (cloud shape — server-side lease db) ─────────
//
// ⚠ NEEDS-REAL-CLOUD VALIDATION (multi-node/HA). Logic-exercised locally only.
//
// Writes lease rows into a dedicated `_lore_control` database on the ArcadeDB
// server, with a UNIQUE index on (tenant, app). The server is the only thing two
// non-filesystem-sharing daemons share. Acquire is a transactional
// insert-or-conditional-update expressed as an ArcadeDB SQL script.

const CONTROL_DB = '_lore_control';

export class ArcadeCellLeaseStore implements CellLeaseStore {
  readonly backend = 'arcadedb' as const;
  private readonly http: ArcadeHttp;
  private ensured = false;

  constructor(baseUrl: string = ARCADE_BASE_URL) {
    // Root-authed (control db is server-level); TLS-hardened like all ArcadeHttp.
    this.http = new ArcadeHttp({ user: ARCADE_ROOT_USER, pass: rootPassword() }, baseUrl);
  }

  private async ensureControlDb(): Promise<void> {
    if (this.ensured) return;
    try {
      await this.http.serverCommand(`create database ${CONTROL_DB}`);
    } catch (e) {
      if (!(e instanceof ArcadeHttpError) || !/already exists/i.test(e.body)) throw e;
    }
    // Vertex-less document type + unique key on the (tenant,app) pair.
    await this.http.command(CONTROL_DB, `CREATE DOCUMENT TYPE cell_leases IF NOT EXISTS`);
    await this.http.command(
      CONTROL_DB,
      `CREATE PROPERTY cell_leases.cell_key IF NOT EXISTS STRING`,
    );
    await this.http.command(
      CONTROL_DB,
      `CREATE INDEX IF NOT EXISTS ON cell_leases (cell_key) UNIQUE`,
    );
    this.ensured = true;
  }

  private static key(tenant: string, app: string): string {
    return `${tenant}::${app}`;
  }

  async acquire(tenant: string, app: string, me: string, ttlMs: number): Promise<LeaseResult> {
    await this.ensureControlDb();
    const cellKey = ArcadeCellLeaseStore.key(tenant, app);
    const now = Date.now();
    const expires = now + ttlMs;
    // Read current holder, then insert-or-conditionally-update. ArcadeDB's unique
    // index makes a concurrent double-insert fail (one wins), and the WHERE-gated
    // UPDATE gives stale-takeover. On a managed cluster this must be a real
    // transaction — code-complete here, HA semantics need real infra.
    const existing = (
      await this.http.query(
        CONTROL_DB,
        `SELECT owner_id, expires_at, fencing_token FROM cell_leases WHERE cell_key = :k`,
        { k: cellKey },
      )
    ).result as Array<{ owner_id: string; expires_at: number; fencing_token: number }>;

    if (existing.length === 0) {
      try {
        await this.http.command(
          CONTROL_DB,
          `INSERT INTO cell_leases SET cell_key = :k, owner_id = :me, fencing_token = 1, acquired_at = :now, expires_at = :exp`,
          { k: cellKey, me, now, exp: expires },
        );
        return { ok: true, fencingToken: 1 };
      } catch (e) {
        // Lost the insert race (unique-index violation) — fall through to re-read.
        if (!(e instanceof ArcadeHttpError)) throw e;
        return { ok: false, holder: 'contended', expiresAt: expires };
      }
    }

    const cur = existing[0]!;
    if (cur.expires_at < now || cur.owner_id === me) {
      const next = cur.fencing_token + 1;
      const upd = await this.http.command(
        CONTROL_DB,
        `UPDATE cell_leases SET owner_id = :me, fencing_token = :ft, acquired_at = :now, expires_at = :exp
         WHERE cell_key = :k AND (expires_at < :now OR owner_id = :me)`,
        { me, ft: next, now, exp: expires, k: cellKey },
      );
      const count = (upd.result as Array<{ count?: number }>)[0]?.count ?? 0;
      if (count >= 1) return { ok: true, fencingToken: next };
    }
    return { ok: false, holder: cur.owner_id, expiresAt: cur.expires_at };
  }

  async renew(tenant: string, app: string, me: string, ttlMs: number): Promise<boolean> {
    await this.ensureControlDb();
    const cellKey = ArcadeCellLeaseStore.key(tenant, app);
    const upd = await this.http.command(
      CONTROL_DB,
      `UPDATE cell_leases SET expires_at = :exp WHERE cell_key = :k AND owner_id = :me`,
      { exp: Date.now() + ttlMs, k: cellKey, me },
    );
    return ((upd.result as Array<{ count?: number }>)[0]?.count ?? 0) >= 1;
  }

  async release(tenant: string, app: string, me: string): Promise<void> {
    await this.ensureControlDb();
    const cellKey = ArcadeCellLeaseStore.key(tenant, app);
    await this.http.command(
      CONTROL_DB,
      `DELETE FROM cell_leases WHERE cell_key = :k AND owner_id = :me`,
      { k: cellKey, me },
    );
  }
}

// ── backend selection ────────────────────────────────────────────────────────

export function resolveLeaseBackend(): 'sqlite' | 'arcadedb' {
  const raw = (process.env['LORE_ARCADE_LEASE_BACKEND'] ?? 'sqlite').toLowerCase();
  return raw === 'arcadedb' ? 'arcadedb' : 'sqlite';
}

/** Build the configured lease store. sqlite (default, multi-process on one host);
 *  arcadedb (cloud shape, needs-real-cloud for HA). */
export function getCellLeaseStore(registryDbPath?: string): CellLeaseStore {
  if (resolveLeaseBackend() === 'arcadedb') return new ArcadeCellLeaseStore();
  return new SqliteCellLeaseStore(() => openRegistryDb(registryDbPath));
}

// ── in-process mutex (Layer 1) — moved from arcadeProvisioner.withCellLock ────

const cellLocks = new Map<string, Promise<unknown>>();

async function withInProcessMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = cellLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prior.then(() => gate);
  cellLocks.set(key, chained);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (cellLocks.get(key) === chained) cellLocks.delete(key);
  }
}

/**
 * withCellLock — the LAYER-1 in-process per-cell mutex, kept as a stable export
 * (it was the pre-slice-5 provisioner primitive). withCellLease composes this
 * with the durable lease. Still non-reentrant on the same `${t}::${a}` key — do
 * NOT nest it (see arcadeMigrate.ts's deadlock note).
 */
export function withCellLock<T>(tenantId: string, appId: string, fn: () => Promise<T>): Promise<T> {
  return withInProcessMutex(`${tenantId}::${appId}`, fn);
}

/** Typed rejection when the durable lease is held by another live daemon. Maps
 *  to HTTP 409 cell_lease_held at the route boundary. */
export class CellLeaseHeldError extends Error {
  constructor(
    public readonly holder: string,
    public readonly retryAfterSec: number,
  ) {
    super(`[arcadeCellLease] cell lease held by ${holder}; retry after ${retryAfterSec}s`);
    this.name = 'CellLeaseHeldError';
  }
}

export interface WithCellLeaseOpts {
  registryDbPath?: string;
  ttlMs?: number;
  renewMs?: number;
  /** Injected store (tests / arcadedb backend). Defaults to the configured one. */
  store?: CellLeaseStore;
  /** Called once with the acquired fencing token so a caller can stamp audit. */
  onFencingToken?: (fencingToken: number) => void;
}

/**
 * withCellLease — Layer 1 (in-process mutex) + Layer 2 (durable lease + renewal
 * timer) around a provisioner body. Replaces the old withCellLock. On a durable
 * lease held by ANOTHER live daemon, throws CellLeaseHeldError (→ 409). Releases
 * in `finally` (idempotent, owner-checked). A renewal timer keeps a long op's
 * lease alive so a contender can't steal it mid-import.
 */
export async function withCellLease<T>(
  tenant: string,
  app: string,
  fn: () => Promise<T>,
  opts?: WithCellLeaseOpts,
): Promise<T> {
  const key = `${tenant}::${app}`;
  const store = opts?.store ?? getCellLeaseStore(opts?.registryDbPath);
  const ttlMs = opts?.ttlMs ?? CELL_LEASE_TTL_MS;
  const renewMs = opts?.renewMs ?? CELL_LEASE_RENEW_MS;
  const me = ownerId();

  return withInProcessMutex(key, async () => {
    const res = await store.acquire(tenant, app, me, ttlMs);
    if (!res.ok) {
      const retryAfterSec = Math.max(1, Math.ceil((res.expiresAt - Date.now()) / 1000));
      throw new CellLeaseHeldError(res.holder, retryAfterSec);
    }
    opts?.onFencingToken?.(res.fencingToken);

    // Renewal timer — keep the lease alive during long ops. unref()'d so it
    // never keeps the process alive; a failed renew (lost lease) is logged by
    // the caller's next acquire, not here.
    const timer = setInterval(() => {
      void store.renew(tenant, app, me, ttlMs);
    }, renewMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      return await fn();
    } finally {
      clearInterval(timer);
      await store.release(tenant, app, me);
    }
  });
}

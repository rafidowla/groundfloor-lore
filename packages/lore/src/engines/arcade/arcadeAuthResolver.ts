/**
 * arcadeAuthResolver.ts — REAL token → bound-adapter resolver for the ArcadeDB
 * db-per-app ("Design A") production path.
 * (branch: spike/arcadedb-multitenant, pre-production hardening slice)
 *
 * Replaces the hardcoded arcadeAppTenantMap.ts (ARCADE_APP_TOKEN_MAP) — an
 * 8-entry literal whose passwords were derivable ("<Cap>Pass123!") and whose
 * cells were compiled in — with a persisted resolver that reads its bindings
 * from the same daemon-local SQLite the provisioner writes.
 *
 * ── CONCEPTUAL ALIGNMENT with routeWorkspaceBinding (D-021 lesson) ──────────
 * An ArcadeDB (tenantId, appId) cell IS the cloud analogue of a local-mode
 * workspace: one token, one database, deny-by-default, no silent fallback to
 * any "active" default cell. Mirroring src/security/routeWorkspaceBinding.ts:
 *
 *   - A token binds to EXACTLY ONE (tenantId, appId) cell, fixed at ISSUE time.
 *   - NO method here takes a tenant / app / db parameter. The ONLY input is the
 *     opaque bearer token; everything reach-defining (tenantId, appId, db,
 *     dbUser, secret) comes from the two persisted SQLite rows, NEVER from the
 *     request payload. This is the exact invariant the spike's map documented
 *     ("db name and boundAppId derived ONLY here") — now enforced by persisted
 *     records rather than a literal.
 *   - `scopes` gate VERBS ONLY (read | write). A scope can NEVER widen reach:
 *     a read-only token is not a wider lens and a write token is not a
 *     cross-cell key. Reach is fixed by the cell binding (coarse-RBAC decision;
 *     ReBAC deferred to Dataplane + app).
 *   - Unknown / revoked / disabled tokens fail CLOSED, BEFORE any HTTP call to
 *     ArcadeDB (deny-by-default — no fallback to an "active" cell).
 *
 * ── DEFENSE IN DEPTH (two independent walls) ────────────────────────────────
 *   1. This resolver hands back adapters bound to exactly the token's cell db.
 *   2. Even if (1) mis-resolved, the per-DB ArcadeDB service user physically
 *      403s outside its one database (the proven auth wall). The resolver's
 *      correctness is not the sole line of defense.
 *
 * ── SECRETS POSTURE (honest scope) ──────────────────────────────────────────
 * The ArcadeDB per-app service password is NOT stored in this source file (the
 * spike map's derivable-password anti-pattern is gone). It lives in the
 * provisioner's `tenant_apps` SQLite row and is read here via the provisioner's
 * `readSecret` indirection (keyed by secretRef) — so a Phase-7 KMS/keychain
 * backend swap changes only the provisioner's read/writeSecret, not this file.
 * Token secrets: only sha256(token) is persisted (arcade_tokens.token_hash);
 * the plaintext token is never stored. See relationalLaneDecision — this
 * bookkeeping is daemon infrastructure, so it stays in SQLite, never ArcadeDB.
 */

import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

import { ArcadeHttp } from './arcadeHttp.js';
import { ArcadeGraphStore } from './arcadeGraphStore.js';
import { ArcadeVectorStore } from './arcadeVectorStore.js';
import type { Scope } from './arcadeScopeGuard.js';
import {
  ScopedArcadeGraphHandle,
  ScopedArcadeVectorHandle,
} from './arcadeScopedHandle.js';
import {
  provisioningDbPath,
  getTenantApp,
  readSecret,
  readSecretAsync,
  ARCADE_BASE_URL,
} from './arcadeProvisioner.js';
import { runArcadeRegistryMigrations } from './arcadeRegistryMigrations.js';
import type { EmbeddingProvider } from '../../providers/types.js';

// ── token format ───────────────────────────────────────────────────────────
//
// Opaque bearer: `lore_at_<base64url(32 random bytes)>`. Only the sha256 hash
// is ever persisted or compared, so the plaintext exists solely in the caller's
// hands + the Authorization header — never at rest.

const TOKEN_PREFIX = 'lore_at_';

export function mintToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// ── resolved principal (frozen) ─────────────────────────────────────────────

export interface ArcadePrincipal {
  readonly tenantId: string;
  readonly appId: string;
  readonly db: string;
  readonly dbUser: string;
  /** subset of ['read','write'] — gates verbs only, never widens reach. */
  readonly scopes: readonly Scope[];
}

/**
 * The fully-bound, scope-guarded adapter pair ready for
 * LoreStorageClient.fromLocal({ graph, verbatim }).
 *
 * `graph` / `verbatim` are the SCOPE-GUARDED handles (ScopedArcadeGraphHandle /
 * ScopedArcadeVectorHandle) — write verbs throw ScopeError before any HTTP call
 * when the principal lacks 'write'. `rawGraph` / `rawVector` expose the
 * underlying un-gated adapters for the (rare) daemon-internal caller that has
 * already authorized the write itself; the facade proof uses `graph`/`verbatim`.
 */
export interface BoundArcadeCell {
  readonly principal: ArcadePrincipal;
  readonly graph: ScopedArcadeGraphHandle;
  readonly verbatim: ScopedArcadeVectorHandle;
  readonly rawGraph: ArcadeGraphStore;
  readonly rawVector: ArcadeVectorStore;
}

// ── typed rejection (fail-closed, pre-HTTP) ─────────────────────────────────

export class ArcadeAuthError extends Error {
  constructor(
    public readonly reason:
      | 'unknown_token'
      | 'revoked_token'
      | 'expired_token'
      | 'cell_not_active'
      | 'cell_missing'
      | 'secret_missing',
    message: string,
  ) {
    super(`[arcadeAuthResolver] ${reason}: ${message}`);
    this.name = 'ArcadeAuthError';
  }
}

// ── arcade_tokens registry (co-located with tenant_apps) ────────────────────
//
// One SQLite file, two tables: tenant_apps (owned by the provisioner) is the
// cell source-of-truth; arcade_tokens (owned here) maps token-hash -> cell +
// scopes. resolve() joins the two. Both are daemon infrastructure, per
// relationalLaneDecision — never inside ArcadeDB.

let cachedDb: DatabaseType | null = null;
let cachedDbPath: string | null = null;

function openTokenDb(dbPath: string = provisioningDbPath()): DatabaseType {
  if (cachedDb && cachedDbPath === dbPath) return cachedDb;
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Schema (arcade_tokens incl. expires_at) is owned by the shared versioned
  // migration runner — idempotent, so it's safe whether the provisioner or this
  // resolver opens the file first.
  runArcadeRegistryMigrations(db);
  cachedDb = db;
  cachedDbPath = dbPath;
  return db;
}

/** Test/ops hook — drop the cached handle (e.g. before deleting the file). */
export function closeTokenDb(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
    cachedDbPath = null;
  }
}

/**
 * openTokenDbForLifecycle — the internal token-registry handle, exposed to the
 * sibling `arcadeTokenLifecycle.ts` (rotate) so it shares ONE better-sqlite3
 * connection (WAL, migrations already run) rather than opening a second handle
 * to the same file. The rotate verb lives in its own module for the file-size
 * budget; keeping the DB handle here keeps a single source of truth for the
 * registry connection.
 */
export function openTokenDbForLifecycle(dbPath?: string): DatabaseType {
  return openTokenDb(dbPath);
}

interface TokenRow {
  token_hash: string;
  tenant_id: string;
  app_id: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
  label?: string | null;
  last_used_at?: string | null;
}

/** Default token lifetime when a caller doesn't specify one: 30 days. */
export const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Throttle window for the last_used_at stamp — parity with auth/tokens.ts.
 *  A token persists its last-use stamp at most once per this interval. */
export const LAST_USED_THROTTLE_MS = 60_000;

function normalizeScopes(raw: unknown): Scope[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: Scope[] = [];
  for (const s of arr) {
    if (s === 'read' || s === 'write') out.push(s);
  }
  return out;
}

// ── daemon-operator token lifecycle (issue / revoke) ────────────────────────
//
// Issuing a token is a daemon-operator control-plane operation (same lane as
// the provisioner) — a tenant bearer token can never reach it. The cell MUST
// already be provisioned (an active tenant_apps row); we refuse to issue a
// token for a cell that doesn't exist so a token can never out-live/pre-date
// its database.

export function issueToken(
  input: {
    tenantId: string;
    appId: string;
    scopes: readonly Scope[];
    /**
     * Token lifetime in seconds. Omitted → DEFAULT_TOKEN_TTL_SECONDS (30 days).
     * `0` → NON-EXPIRING (expires_at stays NULL); the caller/operator is
     * responsible for auditing that choice.
     */
    ttlSeconds?: number;
    /** Operator-facing label, parity with `lore auth create --label`. Optional;
     *  stored verbatim (NULL when omitted) and surfaced by `list-tokens`. */
    label?: string;
  },
  opts?: { registryDbPath?: string },
): { token: string; expiresAt: string | null } {
  const cell = getTenantApp(
    { customerId: input.tenantId, appId: input.appId },
    { registryDbPath: opts?.registryDbPath },
  );
  if (!cell || cell.status !== 'active') {
    throw new ArcadeAuthError(
      'cell_missing',
      `refusing to issue a token for un-provisioned/inactive cell ` +
        `(${input.tenantId}, ${input.appId}); provision the app first`,
    );
  }
  const scopes = normalizeScopes(input.scopes);
  const token = mintToken();
  const now = new Date();
  const ttl = input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  // ttl === 0 ⇒ non-expiring (NULL). Negative/NaN are treated as the default
  // rather than accidentally minting an already-dead token.
  const expiresAt =
    ttl === 0
      ? null
      : new Date(now.getTime() + (Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TOKEN_TTL_SECONDS) * 1000).toISOString();
  const db = openTokenDb(opts?.registryDbPath);
  db.prepare(
    `INSERT INTO arcade_tokens (token_hash, tenant_id, app_id, scopes, created_at, revoked_at, expires_at, label)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    hashToken(token),
    input.tenantId,
    input.appId,
    JSON.stringify(scopes),
    now.toISOString(),
    expiresAt,
    input.label ?? null,
  );
  return { token, expiresAt }; // token returned ONCE — only the hash is retained.
}

/** Revoke a token (idempotent). Returns true if a live token was revoked. */
export function revokeToken(token: string, opts?: { registryDbPath?: string }): boolean {
  const db = openTokenDb(opts?.registryDbPath);
  const info = db
    .prepare(
      `UPDATE arcade_tokens SET revoked_at = ?
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .run(new Date().toISOString(), hashToken(token));
  return info.changes > 0;
}

/**
 * A control-plane view of a token — the token PLAINTEXT is never retained
 * (only its hash is persisted at issue time), so listing exposes the
 * non-secret hash-PREFIX for correlation with audit entries, plus scopes and
 * lifecycle timestamps. Used by the operator `list-tokens` admin route.
 */
export interface ArcadeTokenSummary {
  /** non-secret hash prefix (arcade: token_hash.slice(0,8)) — the operator
   *  correlation handle, the arcade analogue of local's first-12-chars prefix. */
  prefix: string;
  scopes: Scope[];
  /** operator-facing label (migration v3 column), NULL when none was given. */
  label: string | null;
  createdAt: string;
  /** throttled last-use stamp (migration v3), NULL until first use. */
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  /** true when NOT revoked and NOT past its (non-null) expiry — a cheap derive. */
  active: boolean;
}

/**
 * List the tokens issued for one cell (operator control-plane read). Returns
 * the non-secret hash prefix + scopes + lifecycle stamps — NEVER a token
 * plaintext (it is not retained). Newest first.
 */
export function listTokensForCell(
  input: { tenantId: string; appId: string },
  opts?: { registryDbPath?: string },
): ArcadeTokenSummary[] {
  const db = openTokenDb(opts?.registryDbPath);
  const rows = db
    .prepare(
      `SELECT token_hash, scopes, label, created_at, last_used_at, revoked_at, expires_at
       FROM arcade_tokens WHERE tenant_id = ? AND app_id = ?
       ORDER BY created_at DESC`,
    )
    .all(input.tenantId, input.appId) as Array<
    Pick<
      TokenRow,
      'token_hash' | 'scopes' | 'label' | 'created_at' | 'last_used_at' | 'revoked_at' | 'expires_at'
    >
  >;
  const now = Date.now();
  return rows.map((r) => {
    let parsed: unknown = [];
    try { parsed = JSON.parse(r.scopes); } catch { parsed = []; }
    const expired = r.expires_at !== null && r.expires_at !== undefined && now > Date.parse(r.expires_at);
    return {
      prefix: r.token_hash.slice(0, 8),
      scopes: normalizeScopes(parsed),
      label: r.label ?? null,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? null,
      revokedAt: r.revoked_at,
      expiresAt: r.expires_at,
      active: r.revoked_at === null && !expired,
    };
  });
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve a token to its frozen principal — everything reach-defining comes
 * from the two persisted rows, NOTHING from the caller. Fails closed (throws
 * ArcadeAuthError) BEFORE any ArcadeDB HTTP call for unknown / revoked tokens
 * and inactive / missing cells.
 */
export function resolvePrincipal(
  token: string,
  opts?: { registryDbPath?: string },
): ArcadePrincipal {
  const db = openTokenDb(opts?.registryDbPath);
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT token_hash, tenant_id, app_id, scopes, created_at, revoked_at, expires_at, last_used_at
       FROM arcade_tokens WHERE token_hash = ?`,
    )
    .get(tokenHash) as TokenRow | undefined;

  if (!row) throw new ArcadeAuthError('unknown_token', 'no binding for this token');
  if (row.revoked_at) throw new ArcadeAuthError('revoked_token', 'token has been revoked');
  // Fail-closed on TTL expiry — pre-HTTP, like every other rejection here, so an
  // expired token never reaches ArcadeDB. NULL expires_at = non-expiring.
  if (row.expires_at && Date.now() > Date.parse(row.expires_at)) {
    throw new ArcadeAuthError('expired_token', `token expired at ${row.expires_at}`);
  }

  // Join tenant_apps for the cell's db/user/secret + status. status MUST be
  // 'active' — a disabled/destroying cell fails closed even if the token row
  // is still live (defense in depth against a stale token outliving a disable).
  const cell = getTenantApp(
    { customerId: row.tenant_id, appId: row.app_id },
    { registryDbPath: opts?.registryDbPath },
  );
  if (!cell) {
    throw new ArcadeAuthError(
      'cell_missing',
      `token binds (${row.tenant_id}, ${row.app_id}) but no such provisioned cell`,
    );
  }
  if (cell.status !== 'active') {
    throw new ArcadeAuthError(
      'cell_not_active',
      `cell (${row.tenant_id}, ${row.app_id}) is '${cell.status}', not active`,
    );
  }

  // Observability stamp — throttled last-use (parity with local tokens.ts
  // LAST_USED_THROTTLE_MS). A cheap UPDATE gated to ≤1 write / 60s; SQLite WAL
  // needs no explicit lock. Never affects the resolution decision — a stamp
  // failure must not fail an otherwise-valid request, so it is best-effort.
  try {
    const prev = row.last_used_at ? Date.parse(row.last_used_at) : 0;
    const nowMs = Date.now();
    if (!Number.isFinite(prev) || nowMs - prev >= LAST_USED_THROTTLE_MS) {
      db.prepare(`UPDATE arcade_tokens SET last_used_at = ? WHERE token_hash = ?`).run(
        new Date(nowMs).toISOString(),
        tokenHash,
      );
    }
  } catch {
    /* best-effort observability write; never blocks a valid request. */
  }

  return Object.freeze({
    tenantId: row.tenant_id,
    appId: row.app_id,
    db: cell.db,
    dbUser: cell.db_user,
    scopes: Object.freeze(normalizeScopes(JSON.parse(row.scopes))),
  });
}

/**
 * arcadeCellForToken — the one-call entry point: token → fully-bound,
 * scope-guarded { graph, vector } pair for exactly the token's cell,
 * ready to hand to LoreStorageClient.fromLocal.
 *
 * Reach is fixed here: the ArcadeHttp is constructed with the cell's own
 * db-scoped service user (403-walled to one database), and both adapters
 * capture `db` immutably at construction — the returned pair CANNOT be
 * re-pointed at another cell. The scope guard gates verbs on top.
 *
 * @param embedder optional shared EmbeddingProvider (test/perf hook — pass one
 *                 instance to avoid every cell loading its own ~120MB model).
 */
export function arcadeCellForToken(
  token: string,
  opts?: {
    baseUrl?: string;
    registryDbPath?: string;
    embedder?: EmbeddingProvider;
  },
): BoundArcadeCell {
  const principal = resolvePrincipal(token, { registryDbPath: opts?.registryDbPath });

  const secret = readSecret(
    { customerId: principal.tenantId, appId: principal.appId },
    { registryDbPath: opts?.registryDbPath },
  );
  if (!secret) {
    throw new ArcadeAuthError(
      'secret_missing',
      `no service-account secret on file for cell (${principal.tenantId}, ${principal.appId}); ` +
        `an async-only secret backend (keychain/kms) requires arcadeCellForTokenAsync`,
    );
  }
  return buildBoundCell(principal, secret, opts);
}

/**
 * arcadeCellForTokenAsync — the async twin required when the secret backend is
 * async-only (keychain/kms have NO readSync fast-path, so the sync build above
 * throws secret_missing). Resolves the secret via readSecretAsync. The cell pool
 * uses this so a kms-backed deploy works through the same LRU pool.
 */
export async function arcadeCellForTokenAsync(
  token: string,
  opts?: {
    baseUrl?: string;
    registryDbPath?: string;
    embedder?: EmbeddingProvider;
  },
): Promise<BoundArcadeCell> {
  const principal = resolvePrincipal(token, { registryDbPath: opts?.registryDbPath });
  const secret = await readSecretAsync(
    { customerId: principal.tenantId, appId: principal.appId },
    { registryDbPath: opts?.registryDbPath },
  );
  if (!secret) {
    throw new ArcadeAuthError(
      'secret_missing',
      `no service-account secret on file for cell (${principal.tenantId}, ${principal.appId})`,
    );
  }
  return buildBoundCell(principal, secret, opts);
}

/** Shared cell builder — reach fixed by the principal's db + db-scoped user;
 *  both adapters capture `db` immutably. Scope guard gates verbs on top. */
function buildBoundCell(
  principal: ArcadePrincipal,
  secret: string,
  opts?: { baseUrl?: string; embedder?: EmbeddingProvider },
): BoundArcadeCell {
  const baseUrl = opts?.baseUrl ?? ARCADE_BASE_URL;
  const http = new ArcadeHttp({ user: principal.dbUser, pass: secret }, baseUrl);
  const rawGraph = new ArcadeGraphStore({ tenantDb: principal.db, http });
  const rawVector = new ArcadeVectorStore({
    tenantDb: principal.db,
    http,
    embedder: opts?.embedder,
  });

  // Scope-guard the FULL provider surface so the returned pair is both
  // (a) verb-gated (coarse RBAC — a read-only token's write verbs throw
  // ScopeError pre-HTTP) and (b) directly droppable into
  // LoreStorageClient.fromLocal (it satisfies LoreGraphHandle / LoreVectorHandle).
  // The guard adds no reach — it delegates to the same tenantDb-bound adapters.
  const graph = new ScopedArcadeGraphHandle(
    // ArcadeGraphStore structurally satisfies LoreGraphHandle (full
    // GraphProvider + maintenance surface — slice 2 replaced the throwing
    // Phase-6 stubs with real implementations) AND the ArcadeExtraGraph surface
    // (deleteEdge/getEdges/bulkUpsertNodes/getGraphContext) the wrapper forwards.
    rawGraph as unknown as import('../../storage/loreStorageClient.js').LoreGraphHandle &
      import('./arcadeScopedHandle.js').ArcadeExtraGraph,
    principal.scopes,
  );
  const verbatim = new ScopedArcadeVectorHandle(rawVector, principal.scopes);

  return Object.freeze({ principal, graph, verbatim, rawGraph, rawVector });
}

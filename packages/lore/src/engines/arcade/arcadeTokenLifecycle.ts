/**
 * arcadeTokenLifecycle.ts — the ROTATE verb of the arcade token-lifecycle
 * contract (spike/arcadedb-multitenant, Slice 4).
 *
 * ── TokenLifecycleContract (the aligned contract) ────────────────────────────
 * An app holds exactly ONE opaque bearer bound at issue time to exactly ONE
 * data boundary. The operator lane exposes issue / list / revoke / rotate /
 * expiry-sweep with identical SEMANTICS in both local and arcade modes. This
 * module adds the arcade `rotate` verb (local mode already composes rotate from
 * issue + scheduled-revoke with existing primitives; documented, not coded).
 *
 * rotate(oldTokenRef, {graceSeconds=0}) in ONE better-sqlite3 transaction:
 *   (a) resolve the old row — it MUST be live (not revoked, not expired);
 *   (b) INSERT a fresh token row copying tenant_id / app_id / scopes / label;
 *   (c) set the old row's expiry:
 *         graceSeconds === 0 → revoked_at = now (old token dies immediately);
 *         graceSeconds  > 0  → expires_at = now + graceSeconds (old token keeps
 *                              working through the grace window, then fails
 *                              closed exactly like any expired token → 401
 *                              token_expired).
 * Grace REUSES the existing expiry machinery — no new state machine. The single
 * transaction is the atomicity guarantee (A3): a crash between (b) and (c)
 * rolls back, so the cell can never be left with zero live tokens.
 *
 * The cell-pool cache is keyed by TOKEN HASH, so the old token keeps hitting its
 * cached facade through grace by design — no cache eviction is needed here.
 */

import {
  mintToken,
  hashToken,
  openTokenDbForLifecycle,
  ArcadeAuthError,
  assertValidTokenTtlSeconds,
  DEFAULT_TOKEN_TTL_SECONDS,
} from './arcadeAuthResolver.js';
import type { Database as DatabaseType } from 'better-sqlite3';

/** Shortest hash prefix rotate/revoke will resolve; `list-tokens` shows 8. */
export const MIN_TOKEN_PREFIX_LEN = 8;

/**
 * The operator drives rotate from `list-tokens` output, which exposes only a
 * non-secret hash PREFIX (never the plaintext). So rotate identifies the token
 * to retire two ways:
 *   - `byToken`  — the caller still holds the old plaintext (CLI convenience);
 *   - `byPrefix` — the operator has only the 8-char hash prefix + tenant/app.
 * Exactly one must be supplied.
 */
export type RotateTarget =
  | { byToken: string }
  | { byPrefix: string; tenantId: string; appId: string };

export interface LiveTokenRow {
  token_hash: string;
  tenant_id: string;
  app_id: string;
  scopes: string;
  revoked_at: string | null;
  expires_at: string | null;
  label: string | null;
}

export interface RotateResult {
  /** The fresh plaintext token — returned EXACTLY once (only its hash is kept). */
  token: string;
  /** The new token's expiry: now + ttlSeconds (default 30 days). Never null. */
  expiresAt: string | null;
  /** The retired token's non-secret hash prefix, for operator correlation. */
  supersededPrefix: string;
}

/** Default arcade token TTL applied to the freshly-minted rotation token when
 *  the operator does not override it — matches DEFAULT_TOKEN_TTL_SECONDS. The
 *  rotated token's lifetime does NOT copy the old token's remaining TTL. */
const DEFAULT_ROTATE_TTL_SECONDS = DEFAULT_TOKEN_TTL_SECONDS;

/**
 * findTokenRowByPrefix — shared by rotate and revoke-by-prefix. Prefix lookup,
 * scoped to the cell so a prefix can never select another cell's token. Returns
 * undefined for no match or a prefix shorter than MIN_TOKEN_PREFIX_LEN; an
 * ambiguous prefix within one cell is a hard error (fail loud rather than
 * silently act on the wrong token).
 */
export function findTokenRowByPrefix(
  db: DatabaseType,
  tenantId: string,
  appId: string,
  prefix: string,
): LiveTokenRow | undefined {
  if (prefix.length < MIN_TOKEN_PREFIX_LEN) return undefined;
  const matches = db
    .prepare(
      `SELECT token_hash, tenant_id, app_id, scopes, revoked_at, expires_at, label
       FROM arcade_tokens
       WHERE tenant_id = ? AND app_id = ? AND substr(token_hash, 1, length(?)) = ?`,
    )
    .all(tenantId, appId, prefix, prefix) as LiveTokenRow[];
  if (matches.length > 1) {
    throw new ArcadeAuthError(
      'unknown_token',
      `hash prefix '${prefix}' is ambiguous for cell (${tenantId}, ${appId})`,
    );
  }
  return matches[0];
}

/**
 * revokeTokenByPrefix — revoke the (single) token in cell (tenantId, appId)
 * whose hash starts with `prefix`. Throws ArcadeAuthError('unknown_token') when
 * nothing matches or the prefix is ambiguous. `revoked` is false when the token
 * was already revoked (idempotent, like revokeToken).
 */
export function revokeTokenByPrefix(
  target: { tenantId: string; appId: string; prefix: string },
  opts?: { registryDbPath?: string },
): { revoked: boolean; prefix: string } {
  const db = openTokenDbForLifecycle(opts?.registryDbPath);
  const row = findTokenRowByPrefix(db, target.tenantId, target.appId, target.prefix);
  if (!row) throw new ArcadeAuthError('unknown_token', 'no binding for the token to revoke');
  const info = db
    .prepare(`UPDATE arcade_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), row.token_hash);
  return { revoked: info.changes > 0, prefix: row.token_hash.slice(0, MIN_TOKEN_PREFIX_LEN) };
}

/**
 * rotateToken — retire `oldToken`, mint a replacement bound to the SAME cell +
 * scopes + label, atomically. `graceSeconds` keeps the old token live for a
 * window (0 = immediate revoke).
 *
 * Fails closed (ArcadeAuthError) when the old token is unknown / already
 * revoked / already expired — you cannot rotate a dead credential.
 */
export function rotateToken(
  target: RotateTarget,
  input?: { graceSeconds?: number; ttlSeconds?: number },
  opts?: { registryDbPath?: string },
): RotateResult {
  // G11 — same contract as issueToken: absent → default 30d, present → finite
  // integer in [60s, 365d] or InvalidTokenTtlError. No non-expiring rotation.
  assertValidTokenTtlSeconds(input?.ttlSeconds);
  const db = openTokenDbForLifecycle(opts?.registryDbPath);
  const graceSeconds = Math.max(0, Math.trunc(input?.graceSeconds ?? 0));
  const ttlSeconds = input?.ttlSeconds ?? DEFAULT_ROTATE_TTL_SECONDS;

  const newToken = mintToken();
  const newHash = hashToken(newToken);

  const runInTx = db.transaction((): { supersededPrefix: string; expiresAt: string | null } => {
    let old: LiveTokenRow | undefined;
    if ('byToken' in target) {
      old = db
        .prepare(
          `SELECT token_hash, tenant_id, app_id, scopes, revoked_at, expires_at, label
           FROM arcade_tokens WHERE token_hash = ?`,
        )
        .get(hashToken(target.byToken)) as LiveTokenRow | undefined;
    } else {
      old = findTokenRowByPrefix(db, target.tenantId, target.appId, target.byPrefix);
    }

    if (!old) throw new ArcadeAuthError('unknown_token', 'no binding for the token to rotate');
    if (old.revoked_at) {
      throw new ArcadeAuthError('revoked_token', 'cannot rotate a revoked token');
    }
    if (old.expires_at && Date.now() > Date.parse(old.expires_at)) {
      throw new ArcadeAuthError('expired_token', 'cannot rotate an expired token');
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const newExpiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    // (b) INSERT the replacement copying the reach-defining binding verbatim.
    db.prepare(
      `INSERT INTO arcade_tokens
         (token_hash, tenant_id, app_id, scopes, created_at, revoked_at, expires_at, label)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(newHash, old.tenant_id, old.app_id, old.scopes, nowIso, newExpiresAt, old.label ?? null);

    // (c) retire the old row via the EXISTING expiry machinery.
    if (graceSeconds === 0) {
      db.prepare(`UPDATE arcade_tokens SET revoked_at = ? WHERE token_hash = ?`).run(
        nowIso,
        old.token_hash,
      );
    } else {
      const graceExpiry = new Date(now.getTime() + graceSeconds * 1000).toISOString();
      db.prepare(`UPDATE arcade_tokens SET expires_at = ? WHERE token_hash = ?`).run(
        graceExpiry,
        old.token_hash,
      );
    }
    return { supersededPrefix: old.token_hash.slice(0, 8), expiresAt: newExpiresAt };
  });

  const { supersededPrefix, expiresAt } = runInTx();
  return { token: newToken, expiresAt, supersededPrefix };
}

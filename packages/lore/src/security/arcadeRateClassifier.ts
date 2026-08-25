/**
 * arcadeRateClassifier.ts — arcade-mode request → rate-limit bucket classifier
 * and per-request key derivation. (slice 5 GA hardening)
 *
 * FINDING: arcadeDispatch wired NO RateLimiter; security/rateLimit.ts is
 * local-server-middleware only. This module adds the arcade bucket classes +
 * their configs, kept next to rateLimit.ts (one concern) so RateLimiter can be
 * constructed with these configs in arcade mode.
 *
 * Bucket classes (per design):
 *   arcade_provision  — POST provision: cap 5, refill 5/min (DDL + user create).
 *   arcade_migrate    — import/export/backup/restore: cap 2, refill 2/10min.
 *   arcade_admin      — issue/revoke/list tokens, policy: cap 20, refill 60/min.
 *   destructive       — destroy/disable (reuse the existing destructive class).
 *   generic           — tenant data plane (reuse existing generic).
 *
 * KEYING: operator ops key on the operator principal (bootstrap/shared-secret
 * label + token prefix) so one operator's churn is isolated; a tenantKey of
 * `${tenantId}:${appId}` (parsed from the path) is composed in for provision/
 * migrate so one cell's churn can't starve another's onboarding. Tenant data
 * plane keys on hashToken(bearer) prefix (per-token buckets, W9 model).
 *
 * /health and /api/health are NOT classified here (the dispatcher answers them
 * before the limiter runs) — belt-and-braces, classifyArcadeRequest returns null
 * for them.
 */

import type { BucketConfig } from './rateLimit.js';

/** Arcade bucket configs, merged into the RateLimiter's default table so the
 *  arcade classes resolve. destructive/generic already exist in the base table
 *  (mode 'cloud'); these ADD the arcade-specific classes. */
export function arcadeBucketConfigs(): Record<string, BucketConfig> {
  return {
    // DDL + user create is expensive — tight bucket.
    arcade_provision: { capacity: 5, refillPerMs: 5 / 60_000 },
    // import/export/backup/restore mirror reconnect's cost profile.
    arcade_migrate: { capacity: 2, refillPerMs: 2 / 600_000 },
    // token/policy admin — generous but bounded.
    arcade_admin: { capacity: 20, refillPerMs: 60 / 60_000 },
  };
}

/**
 * classifyArcadeRequest — map an arcade request to a bucket class, or null to
 * skip the limiter (health). Operator control-plane paths start /api/arcade/;
 * everything else /api/ is the tenant data plane.
 */
export function classifyArcadeRequest(pathname: string, method: string): string | null {
  if (pathname === '/health' || pathname === '/api/health') return null;

  if (pathname.startsWith('/api/arcade/')) {
    // destroy (DELETE bare cell) / disable → destructive
    if (method === 'DELETE') return 'destructive';
    if (/\/disable$/.test(pathname) && method === 'POST') return 'destructive';
    // provision (POST /api/arcade/apps)
    if (pathname === '/api/arcade/apps' && method === 'POST') return 'arcade_provision';
    // migrate family: import/export/backup/restore
    if (/\/(import|export|backup|restore)$/.test(pathname)) return 'arcade_migrate';
    // everything else operator (issue/revoke/list tokens, policy, list-apps)
    return 'arcade_admin';
  }

  // Tenant data plane — the existing generic/destructive model, keyed per-token.
  if (pathname.startsWith('/api/')) {
    if (method === 'DELETE') return 'destructive';
    return 'generic';
  }
  return null;
}

/** Parse `${tenantId}:${appId}` from an /api/arcade/apps/:t/:a[/...] path, else
 *  undefined. Used as the tenantKey so one cell's churn is isolated. */
export function arcadeTenantKeyFromPath(pathname: string): string | undefined {
  const m = /^\/api\/arcade\/apps\/([a-z0-9]+)\/([a-z0-9]+)(?:\/|$)/.exec(pathname);
  return m ? `${m[1]}:${m[2]}` : undefined;
}

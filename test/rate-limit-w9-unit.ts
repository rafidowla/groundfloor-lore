#!/usr/bin/env tsx
/**
 * test/rate-limit-w9-unit.ts — W9 rate-limit redesign.
 *
 * Pins the per-(class × principal × tenant) bucket invariants + the
 * mode-aware defaults + the config snapshot shape + the 429 header
 * contract that the middleware reads from.
 *
 * Spec pins:
 *   T1: Two tokens hammer concurrently → each sees own bucket, no cross-starvation.
 *   T2: Local mode single token burst 5000 calls → no 429s within cap.
 *   T3: Cloud mode → 429s after per-tenant cap (1000); other tenants unaffected.
 *   T7: getConfigSnapshot() shape used by /api/health.
 *   T8: 429 carries X-RateLimit-Remaining=0 + X-RateLimit-Reset>0
 *       semantics (the limiter return shape; middleware writes them as headers).
 */

import assert from 'node:assert/strict';
import { RateLimiter, RATE_LIMIT_EXEMPT_PATHS, classifyRequest } from '../packages/lore/src/security/rateLimit.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('W9 rate-limit redesign');

/* T1 — per-token isolation */
test('T1 two tokens drain own buckets; one bursting does not starve the other', () => {
    const limiter = new RateLimiter('cloud'); // cloud generic cap=1000
    const now = 1_000_000;
    // Drain token A (cap 1000 → call 1001 times, 1 should fail)
    let aAllowed = 0, aDenied = 0;
    for (let i = 0; i < 1001; i++) {
        const r = limiter.tryConsume('generic', { principalKey: 'token-A' }, now);
        if (r.allowed) aAllowed++; else aDenied++;
    }
    assert.equal(aAllowed, 1000, `A allowed=${aAllowed} (expected 1000)`);
    assert.equal(aDenied, 1, `A denied=${aDenied} (expected 1)`);
    // Token B is unaffected — fresh bucket
    const rB = limiter.tryConsume('generic', { principalKey: 'token-B' }, now);
    assert.equal(rB.allowed, true, 'token-B should not be starved by token-A burst');
    assert.equal(rB.remaining, 999, `B remaining=${rB.remaining}`);
    assert.equal(rB.limit, 1000);
});

/* T2 — local mode: cap 5000, no 429s within cap */
test('T2 local mode single token burst 5000 → all allowed within cap', () => {
    const limiter = new RateLimiter('local'); // local generic cap=5000
    // Fixed `nowMs` so the refill stays at 0 across the burst —
    // otherwise the loop's wall-time leaks refill tokens and we'd be
    // measuring the loop speed, not the cap. Real callers don't pin
    // time; this just isolates the cap invariant from refill timing.
    const now = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 5000; i++) {
        const r = limiter.tryConsume('generic', { principalKey: 'one-token' }, now);
        if (r.allowed) allowed++;
    }
    assert.equal(allowed, 5000, `expected 5000 allowed; got ${allowed}`);
    // 5001st must 429 at the same instant.
    const overflow = limiter.tryConsume('generic', { principalKey: 'one-token' }, now);
    assert.equal(overflow.allowed, false);
});

/* T3 — cloud mode: per-tenant cap 1000, other tenants unaffected */
test('T3 cloud mode per-tenant cap 1000 enforced; other tenants unaffected', () => {
    const limiter = new RateLimiter('cloud');
    const now = 1_000_000;
    let tenant1Allowed = 0, tenant1Denied = 0;
    for (let i = 0; i < 1100; i++) {
        const r = limiter.tryConsume('generic', { principalKey: 'app', tenantKey: 'tenant-1' }, now);
        if (r.allowed) tenant1Allowed++; else tenant1Denied++;
    }
    assert.equal(tenant1Allowed, 1000);
    assert.equal(tenant1Denied, 100);
    // tenant-2 (same principal, different tenant key) gets its own bucket
    const tenant2 = limiter.tryConsume('generic', { principalKey: 'app', tenantKey: 'tenant-2' }, now);
    assert.equal(tenant2.allowed, true);
    assert.equal(tenant2.remaining, 999);
});

test('T3b env override (LORE_RATE_LIMIT_CAP) wins over mode defaults', () => {
    process.env.LORE_RATE_LIMIT_CAP = '12';
    process.env.LORE_RATE_LIMIT_REFILL = '7';
    try {
        const limiter = new RateLimiter('local');
        const snapshot = limiter.getConfigSnapshot();
        assert.equal(snapshot.defaults.generic!.capacity, 12);
        assert.equal(snapshot.defaults.generic!.refillPerSec, 7);
        assert.equal(snapshot.envOverride.cap, 12);
        assert.equal(snapshot.envOverride.refillPerSec, 7);
        // Verify enforcement: 13th request denied
        for (let i = 0; i < 12; i++) {
            const r = limiter.tryConsume('generic', { principalKey: 't' });
            assert.equal(r.allowed, true, `req ${i} should be allowed`);
        }
        const overflow = limiter.tryConsume('generic', { principalKey: 't' });
        assert.equal(overflow.allowed, false);
    } finally {
        delete process.env.LORE_RATE_LIMIT_CAP;
        delete process.env.LORE_RATE_LIMIT_REFILL;
    }
});

/* T7 — config snapshot shape (for /api/health) */
test('T7 getConfigSnapshot returns {mode, defaults, exemptPaths, envOverride}', () => {
    const limiter = new RateLimiter('local');
    const snap = limiter.getConfigSnapshot();
    assert.equal(snap.mode, 'local');
    assert.ok(snap.defaults.generic, 'snapshot must include generic bucket');
    assert.equal(snap.defaults.generic!.capacity, 5000);
    assert.equal(snap.defaults.generic!.refillPerSec, 500);
    // Exempt paths = 2 liveness + 5 bulk endpoints. /api/auth/bootstrap is
    // intentionally NOT exempt (audit fix #6) — it has its own dedicated
    // `bootstrap` bucket; the dedicated test pins that contract.
    for (const p of [
        '/health', '/api/health',
        '/api/nodes/bulk-list', '/api/nodes/bulk', '/api/edges/bulk',
        '/api/nodes/bulk-delete', '/api/recall/bulk',
    ]) {
        assert.ok(snap.exemptPaths.includes(p), `exemptPaths missing ${p}`);
    }
    assert.ok(!snap.exemptPaths.includes('/api/auth/bootstrap'),
        '/api/auth/bootstrap must NOT be exempt (audit fix #6)');
    assert.ok(snap.defaults.bootstrap, 'snapshot must include bootstrap bucket');
    assert.equal(snap.defaults.bootstrap!.capacity, 5);
    assert.equal(typeof snap.envOverride.cap, 'object'); // null when unset
});

test('T7 classifyRequest skips every exempt path', () => {
    for (const p of RATE_LIMIT_EXEMPT_PATHS) {
        const c = classifyRequest(p, 'GET');
        assert.equal(c, null, `${p} must be exempt (classifier returned ${c})`);
        // POST exemption also applies for the bulk-write paths.
        const cp = classifyRequest(p, 'POST');
        assert.equal(cp, null, `${p} POST must also be exempt`);
    }
});

test('T7 classifyRequest routes /api/* (non-exempt) into generic', () => {
    assert.equal(classifyRequest('/api/node', 'POST'), 'generic');
    assert.equal(classifyRequest('/api/recall?topic=x', 'GET'), 'generic');
    assert.equal(classifyRequest('/api/node/foo', 'DELETE'), 'destructive');
    assert.equal(classifyRequest('/api/chat', 'POST'), 'chat');
});

/* T8 — 429 limiter return shape (the middleware writes these as headers) */
test('T8 limiter 429 return includes limit + remaining=0 + retryAfterSec>=1', () => {
    const limiter = new RateLimiter('cloud'); // generic cap=1000
    for (let i = 0; i < 1000; i++) limiter.tryConsume('generic', { principalKey: 't' });
    const denied = limiter.tryConsume('generic', { principalKey: 't' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.limit, 1000);
    assert.equal(denied.remaining, 0);
    assert.ok(denied.retryAfterSec >= 1, `retryAfterSec should be >= 1; got ${denied.retryAfterSec}`);
    assert.ok(denied.resetSec >= 1, `resetSec should be >= 1; got ${denied.resetSec}`);
});

test('T8 allowed return includes limit + remaining (for headers on success too)', () => {
    const limiter = new RateLimiter('local');
    const r = limiter.tryConsume('generic', { principalKey: 't' });
    assert.equal(r.allowed, true);
    assert.equal(r.limit, 5000);
    assert.equal(r.remaining, 4999);
    assert.equal(r.retryAfterSec, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

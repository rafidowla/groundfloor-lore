#!/usr/bin/env tsx
/**
 * test/rate-limit-bootstrap-unit.ts — Audit fix #6.
 *
 * Pins the dedicated bootstrap bucket + the removal of /api/auth/bootstrap
 * from the exempt list. The bootstrap endpoint returns the master token to
 * any localhost caller; it must be rate-limited so an unauthenticated local
 * process can't hammer it.
 *
 * Pins:
 *   T1: classifyRequest('/api/auth/bootstrap','GET') → 'bootstrap' (no longer null/exempt)
 *   T2: bootstrap bucket exists in both modes with capacity 5
 *   T3: 6 rapid calls → exactly 5 allowed, 1 denied (429)
 *   T4: exempt list no longer contains /api/auth/bootstrap
 *   T5: a non-GET to the path falls through to generic (only GET mints)
 */

import assert from 'node:assert/strict';
import { RateLimiter, RATE_LIMIT_EXEMPT_PATHS, classifyRequest } from '../packages/lore/src/security/rateLimit.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('Audit fix #6 — bootstrap rate limit');

test('T1 classifyRequest routes /api/auth/bootstrap GET to the bootstrap bucket', () => {
    const bucket = classifyRequest('/api/auth/bootstrap', 'GET');
    assert.equal(bucket, 'bootstrap', `got ${bucket}`);
});

test('T2 bootstrap bucket exists in local + cloud with capacity 5', () => {
    for (const mode of ['local', 'cloud'] as const) {
        const limiter = new RateLimiter(mode);
        const snap = limiter.getConfigSnapshot();
        assert.ok(snap.defaults.bootstrap, `no bootstrap bucket in ${mode}`);
        assert.equal(snap.defaults.bootstrap.capacity, 5, `${mode} bootstrap capacity`);
    }
});

test('T3 6 rapid bootstrap calls → 5 allowed, 1 denied', () => {
    const limiter = new RateLimiter('local');
    const now = 1_000_000;
    let allowed = 0, denied = 0;
    for (let i = 0; i < 6; i++) {
        const r = limiter.tryConsume('bootstrap', { principalKey: 'anon' }, now);
        if (r.allowed) allowed++; else denied++;
    }
    assert.equal(allowed, 5, `allowed=${allowed} (expected 5)`);
    assert.equal(denied, 1, `denied=${denied} (expected 1)`);
    // The denied call must carry a retry-after > 0.
    const r = limiter.tryConsume('bootstrap', { principalKey: 'anon' }, now);
    assert.ok(!r.allowed, 'still denied');
    assert.ok(r.retryAfterSec > 0, 'retryAfterSec set');
});

test('T4 exempt list no longer contains /api/auth/bootstrap', () => {
    assert.ok(!RATE_LIMIT_EXEMPT_PATHS.includes('/api/auth/bootstrap'),
        'bootstrap is still exempt — the rate limit would never fire');
});

test('T5 non-GET on the bootstrap path falls through to generic (only GET mints)', () => {
    const bucket = classifyRequest('/api/auth/bootstrap', 'POST');
    assert.equal(bucket, 'generic', `POST should hit generic, got ${bucket}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

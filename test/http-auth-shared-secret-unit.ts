#!/usr/bin/env tsx
/**
 * http-auth-shared-secret-unit.ts — verifies that validateRequest
 * accepts EITHER the per-session token OR a pre-supplied shared
 * secret (LORE_MCP_AUTH_TOKEN), used by service-to-service callers
 * (DEF/Loom) in cloud mode.
 */

import assert from 'node:assert/strict';
import { validateRequest } from '../packages/lore/src/security/httpAuth.js';

const SESSION = 'a'.repeat(64);
const SECRET = 'b'.repeat(64);
const WRONG = 'c'.repeat(64);

function req(authValue?: string, host = 'localhost:3847', origin?: string) {
    return {
        url: '/api/protected',
        method: 'GET',
        headers: {
            host,
            ...(origin ? { origin } : {}),
            ...(authValue ? { authorization: authValue } : {}),
        },
    } as never;
}

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('validateRequest — shared-secret acceptance');

test('accepts the session token when no secret configured', () => {
    const r = validateRequest(req(`Bearer ${SESSION}`), { port: 3847, token: SESSION });
    assert.equal(r.ok, true);
});

test('rejects an unknown token when no secret configured', () => {
    const r = validateRequest(req(`Bearer ${WRONG}`), { port: 3847, token: SESSION });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 401);
});

test('accepts the session token when shared secret is also configured', () => {
    const r = validateRequest(req(`Bearer ${SESSION}`), {
        port: 3847, token: SESSION, sharedSecret: SECRET,
    });
    assert.equal(r.ok, true);
});

test('accepts the shared secret as Bearer', () => {
    const r = validateRequest(req(`Bearer ${SECRET}`), {
        port: 3847, token: SESSION, sharedSecret: SECRET,
    });
    assert.equal(r.ok, true);
});

test('rejects an unknown token even when shared secret is configured', () => {
    const r = validateRequest(req(`Bearer ${WRONG}`), {
        port: 3847, token: SESSION, sharedSecret: SECRET,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 401);
});

test('shared secret is case-insensitive (matches the regex)', () => {
    const upperSecret = SECRET.toUpperCase();
    const r = validateRequest(req(`Bearer ${upperSecret}`), {
        port: 3847, token: SESSION, sharedSecret: SECRET,
    });
    assert.equal(r.ok, true);
});

test('empty shared secret string is treated as not-configured (no false-allow)', () => {
    // Edge case: getSharedSecret may return '' if env var is empty.
    // Should NOT treat empty string as a valid match.
    const r = validateRequest(req(`Bearer ${WRONG}`), {
        port: 3847, token: SESSION, sharedSecret: '',
    });
    assert.equal(r.ok, false);
});

test('public-allowlist path skips bearer entirely (bootstrap reachable)', () => {
    const r = validateRequest(
        { url: '/api/auth/bootstrap', method: 'GET', headers: { host: 'localhost:3847' } } as never,
        { port: 3847, token: SESSION, sharedSecret: SECRET },
    );
    assert.equal(r.ok, true);
});

test('non-/api path requires no bearer', () => {
    const r = validateRequest(
        { url: '/health', method: 'GET', headers: { host: 'localhost:3847' } } as never,
        { port: 3847, token: SESSION },
    );
    assert.equal(r.ok, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

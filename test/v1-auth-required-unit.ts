#!/usr/bin/env tsx
/**
 * v1-auth-required-unit.ts — R2 audit #1 (high). The /v1/* SDK tabular-CRUD
 * surface (collections.ts) is documented as Bearer-required, but the gate
 * entry was the trailing-slash prefix '/v1/'. The matcher appends its own
 * suffix (`url===p || url.startsWith(p+'?') || url.startsWith(p+'/')`), so
 * '/v1/' only matched '/v1/', '/v1//', '/v1/?' — NEVER '/v1/schema',
 * '/v1/<coll>', '/v1/<coll>/query', '/v1/<coll>/truncate' — leaving the entire
 * surface (incl. destructive truncate / delete-by-query) reachable token-free.
 * Fixed by registering '/v1' (slash-free), mirroring the working '/mcp' entry.
 *
 * Run: npm run test:unit:v1-auth-required
 */

import assert from 'node:assert/strict';
import { validateRequest } from '../packages/lore/src/security/httpAuth.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

const PORT = 3847;
const SESSION = 'a'.repeat(64); // valid 64-hex session token shape
function req(url: string, authValue?: string) {
    return {
        url, method: 'GET',
        headers: { host: `localhost:${PORT}`, ...(authValue ? { authorization: authValue } : {}) },
    } as never;
}

console.log('R2 #1 — /v1/* requires a Bearer token (no token-free CRUD)');

// Every real /v1/* path must require auth: no Authorization → 401.
const PROTECTED = [
    '/v1/schema',
    '/v1/users',
    '/v1/users/123',
    '/v1/users/query',
    '/v1/users/bulk',
    '/v1/users/truncate',
    '/v1/users/delete-by-query',
    '/v1/users?limit=10',
    '/v1',          // bare prefix
    '/v1/',         // trailing-slash form (the only one that matched before)
    '/v1//x',
];
for (const url of PROTECTED) {
    test(`no token on ${url} → 401`, () => {
        const r = validateRequest(req(url), { port: PORT, token: SESSION });
        assert.equal(r.ok, false, `${url} must be gated`);
        if (!r.ok) assert.equal(r.status, 401, `${url} → 401 auth required`);
    });
}

// A valid token on a /v1/* path passes the bearer gate (no over-blocking).
test('valid session token on /v1/users/truncate → ok', () => {
    const r = validateRequest(req('/v1/users/truncate', `Bearer ${SESSION}`), { port: PORT, token: SESSION });
    assert.equal(r.ok, true, 'valid token must pass');
});

// Does NOT over-match an unrelated slash-free path that merely shares the prefix.
test('unrelated /v1abc is not forced through the /v1 bearer gate (no over-match)', () => {
    // /v1abc is not under /v1/; it is not a real route, and must behave as
    // before (not newly gated by the '/v1' prefix). With no token it is treated
    // as a non-bearer-required, non-/api path → allowed by validateRequest.
    const r = validateRequest(req('/v1abc'), { port: PORT, token: SESSION });
    assert.equal(r.ok, true, '/v1abc must not be swept into the /v1 gate');
});

// Sibling /mcp gate still fires (regression guard for the shared matcher).
test('no token on /mcp → 401 (sibling gate intact)', () => {
    const r = validateRequest(req('/mcp'), { port: PORT, token: SESSION });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 401);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

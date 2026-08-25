/**
 * security-network-hygiene-unit.ts — D-RRR regression tests.
 *
 * Validates the three-layer auth stack in httpAuth.ts without starting a
 * daemon. validateRequest() is pure (no I/O), so we construct minimal
 * IncomingMessage-shaped objects inline.
 *
 * Five tests — one per D-RRR defense:
 *   1. requiresBearerToken   — /api/* without token → 401
 *   2. validTokenAllowed     — /api/* with valid token → ok
 *   3. publicPathNoToken     — /api/health needs no token
 *   4. rejectsBadHost        — Host: evil.com → 403
 *   5. rejectsCrossOrigin    — Origin: https://evil.com → 403
 *   6. acceptsLocalhostHosts — 127.0.0.1 / localhost / ::1 all accepted
 *   7. noCorsSurface         — CORS test: cross-origin Origin rejected; no
 *                              CORS header is emitted (validateRequest is
 *                              pure, so absence of emission is verified by
 *                              testing that the result is ok:false for a
 *                              cross-origin Origin, meaning the handler
 *                              never reaches CORS-header-emitting code)
 */

import assert from 'node:assert/strict';
import { validateRequest } from '../packages/lore/src/security/httpAuth.js';
import type { IncomingMessage } from 'node:http';

const PORT = 7849;
const TOKEN = 'a'.repeat(64); // valid 64-char hex-shaped token
const CONFIG = { port: PORT, token: TOKEN };

function makeReq(overrides: {
    url?: string;
    host?: string;
    origin?: string;
    auth?: string;
}): IncomingMessage {
    const headers: Record<string, string> = {
        host: overrides.host ?? `localhost:${PORT}`,
    };
    if (overrides.origin !== undefined) headers['origin'] = overrides.origin;
    if (overrides.auth !== undefined) headers['authorization'] = overrides.auth;
    return {
        url: overrides.url ?? '/api/recall',
        method: 'GET',
        headers,
    } as unknown as IncomingMessage;
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${(err as Error).message}`);
        failed++;
    }
}

console.log('\nnetwork-hygiene: D-RRR auth stack');

// 1. /api/* without Bearer token → 401
test('requiresBearerToken — /api/nodes returns 401 without token', () => {
    const result = validateRequest(makeReq({ url: '/api/nodes' }), CONFIG);
    assert.equal(result.ok, false);
    assert.equal((result as { status: number }).status, 401);
});

// 2. /api/* with correct Bearer token → ok
test('validTokenAllowed — /api/nodes returns ok with correct token', () => {
    const result = validateRequest(
        makeReq({ url: '/api/nodes', auth: `Bearer ${TOKEN}` }),
        CONFIG,
    );
    assert.equal(result.ok, true);
});

// 3. Public paths skip Bearer requirement
test('publicPathNoToken — /api/health needs no token', () => {
    const result = validateRequest(makeReq({ url: '/api/health' }), CONFIG);
    assert.equal(result.ok, true);
});

test('requiresBearerToken — /api/recall now requires token (removed from public set 2026-06-19)', () => {
    const result = validateRequest(makeReq({ url: '/api/recall' }), CONFIG);
    assert.equal(result.ok, false);
});

// 4. Bad Host header → 403 (DNS-rebinding defense)
test('rejectsBadHost — Host: evil.com → 403', () => {
    const result = validateRequest(
        makeReq({ url: '/api/health', host: 'evil.com' }),
        CONFIG,
    );
    assert.equal(result.ok, false);
    assert.equal((result as { status: number }).status, 403);
});

test('rejectsBadHost — no Host header → 403', () => {
    const result = validateRequest(
        { url: '/api/health', method: 'GET', headers: {} } as unknown as IncomingMessage,
        CONFIG,
    );
    assert.equal(result.ok, false);
    assert.equal((result as { status: number }).status, 403);
});

// 5. Cross-origin Origin header → 403 (cross-origin browser defense)
test('rejectsCrossOrigin — Origin: https://evil.com → 403', () => {
    const result = validateRequest(
        makeReq({ url: '/api/health', origin: 'https://evil.com' }),
        CONFIG,
    );
    assert.equal(result.ok, false);
    assert.equal((result as { status: number }).status, 403);
});

// 6. Localhost Host variants all accepted
for (const host of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]) {
    test(`acceptsLocalhostHosts — Host: ${host} → ok`, () => {
        const result = validateRequest(
            makeReq({ url: '/api/health', host }),
            CONFIG,
        );
        assert.equal(result.ok, true);
    });
}

// 7. localhost Origin variants accepted (no CORS rejection for local UI)
for (const origin of [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
]) {
    test(`acceptsLocalhostOrigin — Origin: ${origin} → ok`, () => {
        const result = validateRequest(
            makeReq({ url: '/api/health', origin }),
            CONFIG,
        );
        assert.equal(result.ok, true);
    });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

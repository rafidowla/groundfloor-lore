#!/usr/bin/env tsx
/**
 * bootstrap-nonce-required-unit.ts — regression test for the
 * unauthenticated-bootstrap-token-leak fix.
 *
 * THE VULN: GET /api/auth/bootstrap minted the full daemon-operator
 * bearer token for ANY caller that could satisfy Host+Origin — and
 * Origin is OPTIONAL (isAllowedOrigin returns true when absent), so a
 * same-machine caller that simply omitted the Origin header (curl, a
 * sandboxed process, a network-only local tool) got the master token
 * with zero proof of anything beyond TCP-socket reachability.
 *
 * THE FIX: the daemon mints a one-time nonce to
 * `<LORE_HOME>/bootstrap.nonce` (0600, same trust tier as auth.token)
 * at boot. GET /api/auth/bootstrap now additionally requires the
 * caller to present that nonce (?nonce=<value>); presenting it consumes
 * it (one-time use), so a captured request/nonce can't be replayed
 * after the legitimate caller has already bootstrapped. See
 * security/authToken.ts (ensureBootstrapNonce/consumeBootstrapNonce)
 * and mcp/http/middleware.ts's /api/auth/bootstrap handler.
 *
 * Drives `runHttpGates` directly (no live daemon), mirroring the
 * tw3a-cross-tenant-isolation-unit.ts harness style. Every request below
 * uses valid Host but OMITS Origin — exactly the attacker-favorable
 * shape the original vuln exploited — so a pass here proves the nonce
 * (not Origin) is what now blocks the unauthenticated caller.
 *
 * Pins:
 *   T1: no nonce query param → rejected (not 200, no token in body)
 *   T2: wrong/garbage nonce → rejected
 *   T3: correct current nonce → 200 + the real token
 *   T4: replaying the SAME nonce a second time → rejected (one-time use)
 *   T5: Host gate still applies on top (bad Host → 403 even with a
 *       valid, unconsumed nonce)
 *   T6: Origin gate still applies on top (cross-origin Origin → 403
 *       even with a valid, unconsumed nonce)
 *
 * Run: npx tsx test/bootstrap-nonce-required-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runHttpGates, type HttpGateDeps } from '../packages/lore/src/mcp/http/middleware.js';
import { ensureBootstrapNonce, getBootstrapNoncePath } from '../packages/lore/src/security/authToken.js';
import type { RateLimiter } from '../packages/lore/src/security/rateLimit.js';

const PORT = 5931;
const TOKEN = 'f'.repeat(64);

/** A no-op rate limiter that always allows — rate limiting on the bootstrap
 *  bucket is covered separately by rate-limit-bootstrap-unit.ts. */
const allowAllLimiter: RateLimiter = {
    tryConsume: () => ({ allowed: true, limit: 1000, remaining: 999, resetSec: 60, retryAfterSec: 0 }),
} as unknown as RateLimiter;

function fakeReq(url: string, headers: Record<string, string | undefined>): IncomingMessage {
    return { method: 'GET', url, headers, on: () => undefined } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        headersSent: false,
        setHeader() { return this; },
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function makeDeps(dataHome: string): HttpGateDeps {
    return {
        port: PORT,
        dataHome,
        getAuthToken: () => TOKEN,
        rateLimiter: allowAllLimiter,
        deploymentMode: 'local',
        getBootstrapWorkspace: () => 'dev',
    };
}

/** Valid Host, Origin OMITTED — the exact shape the original vuln let through. */
function attackerHeaders(nonceQuery: string): { url: string; headers: Record<string, string> } {
    return {
        url: `/api/auth/bootstrap${nonceQuery}`,
        headers: { host: `127.0.0.1:${PORT}` },
    };
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack}`); failed++; }
}

console.log('bootstrap-nonce-required: unauthenticated-bootstrap-token-leak fix');

await test('T1 no nonce query param → rejected, no token in body', async () => {
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bootstrap-nonce-'));
    ensureBootstrapNonce(dataHome);
    const { url, headers } = attackerHeaders('');
    const res = fakeRes();
    const gate = await runHttpGates(fakeReq(url, headers), res, makeDeps(dataHome));
    assert.equal(gate.handled, true, 'gate must short-circuit the bootstrap route');
    assert.notEqual(res._status, 200, `expected non-200, got ${res._status}`);
    assert.doesNotMatch(res._body, /"token"/, 'response body must not carry the token');
    fs.rmSync(dataHome, { recursive: true, force: true });
});

await test('T2 wrong/garbage nonce → rejected', async () => {
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bootstrap-nonce-'));
    ensureBootstrapNonce(dataHome);
    const { url, headers } = attackerHeaders('?nonce=' + '0'.repeat(64));
    const res = fakeRes();
    const gate = await runHttpGates(fakeReq(url, headers), res, makeDeps(dataHome));
    assert.equal(gate.handled, true);
    assert.notEqual(res._status, 200, `expected non-200, got ${res._status}`);
    assert.doesNotMatch(res._body, /"token"/, 'response body must not carry the token');
    fs.rmSync(dataHome, { recursive: true, force: true });
});

await test('T3 correct current nonce → 200 with the real token', async () => {
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bootstrap-nonce-'));
    const nonce = ensureBootstrapNonce(dataHome);
    const { url, headers } = attackerHeaders('?nonce=' + encodeURIComponent(nonce));
    const res = fakeRes();
    const gate = await runHttpGates(fakeReq(url, headers), res, makeDeps(dataHome));
    assert.equal(gate.handled, true);
    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as { token: string };
    assert.equal(body.token, TOKEN);
    fs.rmSync(dataHome, { recursive: true, force: true });
});

await test('T4 replaying the same nonce a second time → rejected (one-time use)', async () => {
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bootstrap-nonce-'));
    const nonce = ensureBootstrapNonce(dataHome);
    const { url, headers } = attackerHeaders('?nonce=' + encodeURIComponent(nonce));

    const first = fakeRes();
    const gate1 = await runHttpGates(fakeReq(url, headers), first, makeDeps(dataHome));
    assert.equal(gate1.handled, true);
    assert.equal(first._status, 200, 'first use must succeed');

    // The nonce file must be gone after a successful consume.
    assert.equal(fs.existsSync(getBootstrapNoncePath(dataHome)), false, 'nonce file must be deleted after use');

    const second = fakeRes();
    const gate2 = await runHttpGates(fakeReq(url, headers), second, makeDeps(dataHome));
    assert.equal(gate2.handled, true);
    assert.notEqual(second._status, 200, `replay must be rejected, got ${second._status}`);
    assert.doesNotMatch(second._body, /"token"/, 'replayed response must not carry the token');
    fs.rmSync(dataHome, { recursive: true, force: true });
});

await test('T5 bad Host header → 403, even with a valid unconsumed nonce', async () => {
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bootstrap-nonce-'));
    const nonce = ensureBootstrapNonce(dataHome);
    const res = fakeRes();
    const req = fakeReq(`/api/auth/bootstrap?nonce=${encodeURIComponent(nonce)}`, { host: 'evil.com' });
    const gate = await runHttpGates(req, res, makeDeps(dataHome));
    assert.equal(gate.handled, true);
    assert.equal(res._status, 403, `expected 403 (Host gate), got ${res._status}`);
    // The Host gate must reject BEFORE the nonce is consumed.
    assert.equal(fs.existsSync(getBootstrapNoncePath(dataHome)), true, 'nonce must survive a Host-gate rejection');
    fs.rmSync(dataHome, { recursive: true, force: true });
});

await test('T6 cross-origin Origin → 403, even with a valid unconsumed nonce', async () => {
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bootstrap-nonce-'));
    const nonce = ensureBootstrapNonce(dataHome);
    const res = fakeRes();
    const req = fakeReq(`/api/auth/bootstrap?nonce=${encodeURIComponent(nonce)}`, {
        host: `127.0.0.1:${PORT}`,
        origin: 'https://evil.example.com',
    });
    const gate = await runHttpGates(req, res, makeDeps(dataHome));
    assert.equal(gate.handled, true);
    assert.equal(res._status, 403, `expected 403 (Origin gate), got ${res._status}`);
    assert.equal(fs.existsSync(getBootstrapNoncePath(dataHome)), true, 'nonce must survive an Origin-gate rejection');
    fs.rmSync(dataHome, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

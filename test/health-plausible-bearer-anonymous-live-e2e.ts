#!/usr/bin/env tsx
/**
 * test/health-plausible-bearer-anonymous-live-e2e.ts — B1 QA finding
 * (2026-09-03, round E): a plausible-SHAPED app token
 * (`lore_<workspace>_<43 chars>`) that doesn't resolve in the registry
 * (missing / revoked / expired) used to 401 even against a PUBLIC path
 * like /health and /api/health, because mcp/http/middleware.ts resolved
 * the principal for every request — before the public-path handler ran —
 * and turned an unresolved-but-plausible Bearer into a hard 401 there too.
 *
 * That contradicted docs/OPERATIONS.md's documented contract for
 * /api/health ("Anonymous request (no Bearer, or an invalid one): you get
 * back exactly the /health lite body") and turned a liveness probe
 * carrying a stale/garbage scoped token into an outage.
 *
 * Fix: security/httpAuth.ts now exports `requiresBearerAuth(url)` (the
 * same Layer-3 predicate validateRequest uses internally); middleware.ts
 * consults it before failing a request over an unresolved plausible
 * token, and falls back to anonymous (principal stays null) on paths
 * where a Bearer was never required. Non-public / Bearer-required paths
 * (e.g. /api/stats) are UNCHANGED — they must still 401.
 *
 * This is a live-daemon regression test (real --http process, isolated
 * HOME, ephemeral port) per the QA finding's explicit ask, so it proves
 * the fix through the real HTTP stack, not just the pure predicate.
 * See test/http-auth-shared-secret-unit.ts / test/route-gates-l068-unit.ts
 * for the pure-function companion coverage of validateRequest itself.
 */

import assert from 'node:assert/strict';
import { spawnDaemon, waitForReady, fetchAuthToken, killDaemon, cleanup, type DaemonHandle } from './helpers/live-daemon.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('Live-daemon: plausible-but-unresolvable Bearer on a public path falls back to anonymous');

// Syntactically valid app-token SHAPE (`lore_<workspace>_<43 base64url>`)
// that was never issued — isPlausibleToken() accepts it, resolveByPlaintext()
// returns 'missing'.
const GARBAGE_PLAUSIBLE_TOKEN = `lore_default_${'x'.repeat(43)}`;

await test('bad-plausible Bearer on GET /health -> 200 lite (same body as no auth)', async () => {
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon();
        const ready = await waitForReady(h.port, 60_000);
        assert.ok(ready, `daemon never became ready\n${h.log.text}`);
        const base = `http://127.0.0.1:${h.port}`;

        const anon = await fetch(`${base}/health`);
        assert.equal(anon.status, 200, `control (no auth) expected 200, got ${anon.status}`);
        const anonBody = await anon.json();

        const garbage = await fetch(`${base}/health`, {
            headers: { Authorization: `Bearer ${GARBAGE_PLAUSIBLE_TOKEN}` },
        });
        const garbageText = await garbage.text();
        assert.equal(garbage.status, 200, `expected 200 lite for a garbage-but-plausible Bearer on /health, got ${garbage.status}: ${garbageText}`);
        const garbageBody = JSON.parse(garbageText);
        assert.deepEqual(Object.keys(garbageBody).sort(), Object.keys(anonBody).sort(), 'garbage-Bearer /health body must have the same shape as the anonymous control');
    } finally {
        if (h) { await killDaemon(h); cleanup(h); }
    }
});

await test('bad-plausible Bearer on GET /api/health -> 200 lite (same body as no auth), valid Bearer still gets the full body', async () => {
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon();
        const ready = await waitForReady(h.port, 60_000);
        assert.ok(ready, `daemon never became ready\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port, h.home);
        const base = `http://127.0.0.1:${h.port}`;

        const anon = await fetch(`${base}/api/health`);
        assert.equal(anon.status, 200, `control (no auth) expected 200, got ${anon.status}`);
        const anonBody = await anon.json() as Record<string, unknown>;
        assert.ok(!('loreHome' in anonBody), 'anonymous /api/health must be the lite body (no loreHome)');

        const garbage = await fetch(`${base}/api/health`, {
            headers: { Authorization: `Bearer ${GARBAGE_PLAUSIBLE_TOKEN}` },
        });
        const garbageText = await garbage.text();
        assert.equal(garbage.status, 200, `expected 200 lite for a garbage-but-plausible Bearer on /api/health, got ${garbage.status}: ${garbageText}`);
        const garbageBody = JSON.parse(garbageText) as Record<string, unknown>;
        assert.ok(!('loreHome' in garbageBody), 'garbage-Bearer /api/health must still be the lite body (no loreHome)');
        assert.deepEqual(Object.keys(garbageBody).sort(), Object.keys(anonBody).sort(), 'garbage-Bearer /api/health body must have the same shape as the anonymous control');

        // Control: a REAL Bearer still gets the rich snapshot — this fix
        // must not have collapsed the authenticated path too.
        const authed = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${h.token}` } });
        assert.equal(authed.status, 200, `authed /api/health expected 200, got ${authed.status}`);
        const authedBody = await authed.json() as Record<string, unknown>;
        assert.ok('loreHome' in authedBody, 'a VALID Bearer must still get the full body (loreHome present)');
    } finally {
        if (h) { await killDaemon(h); cleanup(h); }
    }
});

await test('bad-plausible Bearer on a PROTECTED route (GET /api/stats) still 401s — public-path fallback must not weaken non-public auth', async () => {
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon();
        const ready = await waitForReady(h.port, 60_000);
        assert.ok(ready, `daemon never became ready\n${h.log.text}`);
        const base = `http://127.0.0.1:${h.port}`;

        const noAuth = await fetch(`${base}/api/stats`);
        assert.equal(noAuth.status, 401, `expected 401 with no Bearer on /api/stats, got ${noAuth.status}`);

        const garbage = await fetch(`${base}/api/stats`, {
            headers: { Authorization: `Bearer ${GARBAGE_PLAUSIBLE_TOKEN}` },
        });
        const garbageText = await garbage.text();
        assert.equal(garbage.status, 401, `expected 401 for a garbage-but-plausible Bearer on the PROTECTED /api/stats, got ${garbage.status}: ${garbageText}`);
        const body = JSON.parse(garbageText) as { code?: string };
        assert.equal(body.code, 'auth_required', `expected auth_required, got ${JSON.stringify(body)}`);
    } finally {
        if (h) { await killDaemon(h); cleanup(h); }
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

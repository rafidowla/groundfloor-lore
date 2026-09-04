#!/usr/bin/env tsx
/**
 * test/health-anonymous-lite-unit.ts — FINDING 4 (2026-09-03, Rafi DECISION):
 * an anonymous local caller of GET /api/health gets the LITE body; a
 * Bearer-authenticated caller gets the FULL body. Docs match.
 *
 * Before this fix, /api/health served the full rich snapshot (per-workspace
 * node/edge counts, `loreHome`, outbox depth, the live rate-limit config) to
 * ANY local process with no token — a local-privilege-escalation gap. This
 * suite pins the split directly at the handler (no live daemon needed —
 * companion regression coverage in test/e2e-q2-1-server-mode.ts and the
 * other live-daemon suites drives the real HTTP path end to end and proves
 * production wiring; see PR notes).
 *
 * Three areas, one per the FIX spec's sub-items:
 *   (a) local mode — mcp/http/routes/diagnostic/health.ts handleHealth
 *   (b) arcade mode — mcp/arcadeBoot.ts isOperatorBearer + its /health,
 *       /api/health branch
 *   (c) `lore doctor` — source-shape pin that its /api/health probe now
 *       authenticates with a discoverable local token (can't drive this
 *       one live: doctor's probe is hardcoded to port 3847, which this
 *       build's hard rules forbid touching even transiently)
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { tryDiagnosticRoutes } from '../packages/lore/src/mcp/http/routes/diagnostic.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { RateLimiter } from '../packages/lore/src/security/rateLimit.js';
import { isOperatorBearer } from '../packages/lore/src/mcp/arcadeBoot.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('FINDING 4 — /api/health anonymous(lite) vs Bearer(full) split');

/* ═══════════════════════ (a) local mode — handleHealth ═══════════════════ */

const AUTHED: Principal = { kind: 'app', workspace: 'default', scopes: ['read'], label: 't', allowedWorkspaces: ['default'] };

function reqGet(): IncomingMessage {
    return { method: 'GET', on(event: string, cb: (chunk?: Buffer) => void) {
        if (event === 'end') setImmediate(() => cb());
        return this;
    } } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function makeFakeGraph(nodeCount: number, edgeCount: number): unknown {
    return { getStats: async () => ({ nodeCount, edgeCount, typeBreakdown: {} }) };
}
function baseDeps(overrides: Record<string, unknown> = {}): Parameters<typeof tryDiagnosticRoutes>[4] {
    return {
        store: { loreGraph: makeFakeGraph(3, 2), loreVerbatim: { count: async () => 0 } },
        configManager: { read: () => ({ llmProvider: 'none', telemetryOptOut: false }) },
        activeSessions: new Map(),
        deploymentMode: 'local',
        getDataplaneState: () => 'offline',
        rateLimiter: new RateLimiter('local'),
        ...overrides,
    } as never;
}

// The exact key sets the two bodies must (not) carry — mirrors
// handleHealthLite's literal shape vs handleHealth's full shape.
const LITE_ONLY_KEYS = ['status', 'version', 'sessions', 'backgroundReconnect', 'embeddingBackend'];
const FULL_ONLY_KEYS = ['loreHome', 'workspaces', 'workspace', 'rateLimit', 'outbox', 'deploymentMode', 'dataplane', 'telemetryOptOut', 'orphans', 'llmProvider', 'perWorkspaceOutbox'];

await test('(a) ANONYMOUS GET /api/health returns exactly the lite body — no loreHome/workspaces/rateLimit/sessions-rich data', async () => {
    const res = fakeRes();
    await tryDiagnosticRoutes(reqGet(), res, '/api/health', '/api/health', baseDeps());
    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    for (const k of LITE_ONLY_KEYS) {
        assert.ok(k in body, `lite body must carry "${k}"; got keys: ${Object.keys(body).join(',')}`);
    }
    for (const k of FULL_ONLY_KEYS) {
        assert.ok(!(k in body), `anonymous body must NOT carry "${k}" (full-body-only field); got: ${JSON.stringify(body)}`);
    }
    // Exactly the handleHealthLite shape — no extra keys leaked either.
    assert.deepEqual(Object.keys(body).sort(), LITE_ONLY_KEYS.slice().sort(), `unexpected key set: ${Object.keys(body).join(',')}`);
});

await test('(a) BEARER-AUTHENTICATED GET /api/health returns the FULL body — loreHome/workspaces/rateLimit all present', async () => {
    const res = fakeRes();
    await runWithPrincipal(AUTHED, () => tryDiagnosticRoutes(reqGet(), res, '/api/health', '/api/health', baseDeps()));
    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    for (const k of FULL_ONLY_KEYS) {
        assert.ok(k in body, `authenticated body must carry "${k}"; got keys: ${Object.keys(body).join(',')}`);
    }
    assert.equal(typeof body.loreHome, 'string');
    const ws = body.workspaces as { perWorkspaceStats?: unknown };
    assert.ok(ws.perWorkspaceStats && typeof ws.perWorkspaceStats === 'object', 'expected workspaces.perWorkspaceStats');
    assert.ok(body.rateLimit !== null, 'expected a non-null rateLimit snapshot when a rateLimiter is wired');
});

await test('(a) GET /health (liveness) is ALWAYS the lite body regardless of auth — unaffected by this fix', async () => {
    const anon = fakeRes();
    await tryDiagnosticRoutes(reqGet(), anon, '/health', '/health', baseDeps());
    const authed = fakeRes();
    await runWithPrincipal(AUTHED, () => tryDiagnosticRoutes(reqGet(), authed, '/health', '/health', baseDeps()));
    assert.equal(anon._body, authed._body, '/health must not vary with auth (it never surfaced the rich body)');
});

/* ═══════════════════════ (b) arcade mode — isOperatorBearer ═══════════════ */

const OP_TOKEN = 'a'.repeat(64);
const SHARED_SECRET = 'b'.repeat(64);

function reqWithAuth(bearer?: string): IncomingMessage {
    return { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} } as unknown as IncomingMessage;
}

await test('(b) isOperatorBearer: no Authorization header → false (anonymous)', () => {
    assert.equal(isOperatorBearer(reqWithAuth(undefined), OP_TOKEN, undefined), false);
});

await test('(b) isOperatorBearer: matching 64-hex daemon token → true', () => {
    assert.equal(isOperatorBearer(reqWithAuth(OP_TOKEN), OP_TOKEN, undefined), true);
});

await test('(b) isOperatorBearer: matching shared secret → true', () => {
    assert.equal(isOperatorBearer(reqWithAuth(SHARED_SECRET), OP_TOKEN, SHARED_SECRET), true);
});

await test('(b) isOperatorBearer: a tenant lore_at_* token (not operator-shaped) → false', () => {
    assert.equal(isOperatorBearer(reqWithAuth('lore_myws_' + 'x'.repeat(43)), OP_TOKEN, SHARED_SECRET), false);
});

await test('(b) isOperatorBearer: wrong 64-hex value → false', () => {
    assert.equal(isOperatorBearer(reqWithAuth('c'.repeat(64)), OP_TOKEN, SHARED_SECRET), false);
});

// Source-shape pin: the health branch in arcadeDispatch must actually gate
// on isOperatorBearer and must include `version` + `mode` for BOTH bodies
// while confining `arcadeBaseUrl`/`rateLimit` to the authenticated one —
// arcadeDispatch itself isn't exported (it needs a full ArcadeCellPool/
// AuditLog/outbox boot to invoke directly), so this pins the wiring by
// reading the source, the same style test/sw23-plugin-hooks-removed-unit.ts
// and test/sw12-version-source-unit.ts already use for this exact file.
await test('(b) arcadeDispatch health branch is gated on isOperatorBearer (source pin)', () => {
    const src = fs.readFileSync(new URL('../packages/lore/src/mcp/arcadeBoot.ts', import.meta.url), 'utf-8');
    const branchStart = src.indexOf("pathname === '/health' || pathname === '/api/health'");
    assert.ok(branchStart >= 0, 'expected the /health /api/health branch to still exist');
    const branch = src.slice(branchStart, branchStart + 700);
    assert.match(branch, /isOperatorBearer\(req, deps\.authToken, deps\.sharedSecret\)/, 'health branch must gate on isOperatorBearer');
    assert.match(branch, /status: 'ok', version: VERSION, mode: 'arcade' \}/, 'anonymous body must be exactly {status, version, mode}');
    assert.match(branch, /arcadeBaseUrl: ARCADE_BASE_URL/, 'authenticated body must still carry arcadeBaseUrl');
    assert.match(branch, /rateLimit: deps\.limiter\.getConfigSnapshot\(\)/, 'authenticated body must still carry the rate-limit snapshot');
});

/* ═══════════════════ (c) lore doctor — loreHome auto-detect ═══════════════ *
 *
 * doctor's /api/health probe is hardcoded to 127.0.0.1:3847 (probeHttp /
 * probeJson in cli/commands/doctor.ts) — this build's hard rules forbid
 * touching port 3847 even transiently, so a live probe can't be driven here.
 * Source-shape pin instead: the initial probe must now read a token from
 * the guessed LORE_HOME (when one is already on disk) and pass it along,
 * instead of unconditionally probing anonymously — otherwise the daemon's
 * `loreHome` field (now Bearer-only, per this same finding) would silently
 * stop being discoverable and doctor would always fall back to the
 * (possibly wrong) env-derived guess.
 */

await test('(c) doctor reads a local token before its first /api/health probe (source pin)', () => {
    const src = fs.readFileSync(new URL('../packages/lore/src/cli/commands/doctor.ts', import.meta.url), 'utf-8');
    const probeSite = src.indexOf("probeJson('/api/health', null)");
    assert.equal(probeSite, -1, 'the FIRST /api/health probe must no longer be unconditionally anonymous (null token)');
    assert.match(src, /guessTokenPath/, 'expected doctor to compute a guessed token path before probing');
    assert.match(src, /probeJson\('\/api\/health', guessToken\)/, 'expected the first probe to pass the guessed token');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

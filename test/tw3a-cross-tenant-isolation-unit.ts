#!/usr/bin/env tsx
/**
 * tw3a-cross-tenant-isolation-unit.ts — TW-3a / findings
 * sec-tenant-header-unauthenticated + ent-cloud-tenant-header-not-bound-to-
 * principal regression. CRITICAL cloud-mode multi-tenant breach.
 *
 * THE VULN (base = swarm/integration-3): in cloud mode the
 * `X-Lore-Workspace` request header sets the active tenant/workspace for
 * the request (middleware.ts bindWorkspaceToRequest → workspaceContext →
 * DataplaneGraph.tenantProvider), but it was trusted VERBATIM and NEVER
 * reconciled with the authenticated principal. An authenticated caller
 * scoped to workspace A could send `X-Lore-Workspace: B` and the daemon
 * would bind tenant B — reading/writing another customer's data. The
 * binding is the value DataplaneGraph routes every read/write through, so
 * confidentiality + integrity are both breached.
 *
 * THE FIX (branch = swarm/TW-3a): the resolved principal carries an
 * explicit `allowedWorkspaces` set; the cloud header gate validates
 * `X-Lore-Workspace` against the principal (own workspace / allow-list /
 * cross-workspace-{read,write} scope) BEFORE binding it. A mismatch is a
 * fail-closed 403 — never a silent fallback. The intent (read vs write) is
 * derived from the HTTP method so a write to a foreign tenant requires
 * cross-workspace-WRITE.
 *
 * What this proves:
 *   - principal P scoped to A + header B on a READ (GET)  → 403, NOTHING
 *     bound (tenant B never selected → B untouched/unreadable).
 *   - principal P scoped to A + header B on a WRITE (POST) → 403, nothing
 *     bound (tenant B never written).
 *   - control: principal P + header A → gate passes, binds tenant A.
 *   - the master/service (shared-secret) principal WITH cross-workspace
 *     scopes + header B → allowed (preserved capability), binds B.
 *   - local mode (null principal, no header) → no cloud binding, no 4xx
 *     (the round-2 null-principal localhost-trust path does not regress).
 *
 * On base, the B reads/writes SUCCEED (handled:false, tenant B bound) —
 * the breach. On branch they 403.
 *
 * Drives `runHttpGates` (the exact gate that binds the header) directly,
 * mirroring the route-test harness in sp04 / sw05. No disk, no network:
 * every assertion fires at the gate before any substrate access.
 *
 * Run: npx tsx test/tw3a-cross-tenant-isolation-unit.ts
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runHttpGates, runWithWorkspaceIfAny, type HttpGateDeps } from '../packages/lore/src/mcp/http/middleware.js';
import {
    getCurrentWorkspaceId,
    runWithWorkspace,
} from '../packages/lore/src/security/workspaceContext.js';
import type { RateLimiter } from '../packages/lore/src/security/rateLimit.js';

const PORT = 4931;
const A = 'tenant-acme';
const B = 'tenant-victim-corp';

/** A 64-hex token — the bootstrap session token shape. */
const SESSION_TOKEN = 'a'.repeat(64);
/** A different 64-hex token — the cloud shared secret (service principal). */
const SHARED_SECRET = 'b'.repeat(64);

/** A no-op rate limiter that always allows (we are not testing rate limits). */
const allowAllLimiter: RateLimiter = {
    tryConsume: () => ({ allowed: true, limit: 1000, remaining: 999, resetSec: 60, retryAfterSec: 0 }),
} as unknown as RateLimiter;

function fakeReq(
    method: string,
    url: string,
    headers: Record<string, string | undefined>,
): IncomingMessage {
    return {
        method,
        url,
        headers,
        on: () => undefined,
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string; _ended: boolean } {
    const r = {
        _status: 0, _body: '', _ended: false,
        headersSent: false,
        setHeader() { return this; },
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) {
            (this as { _body: string })._body = body ?? '';
            (this as { _ended: boolean })._ended = true;
        },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string; _ended: boolean };
}

function cloudDeps(bootstrapWorkspace: string): HttpGateDeps {
    return {
        port: PORT,
        getAuthToken: () => SESSION_TOKEN,
        getSharedSecret: () => SHARED_SECRET,
        rateLimiter: allowAllLimiter,
        deploymentMode: 'cloud',
        getBootstrapWorkspace: () => bootstrapWorkspace,
    };
}

function localDeps(bootstrapWorkspace: string): HttpGateDeps {
    return {
        port: PORT,
        getAuthToken: () => SESSION_TOKEN,
        getSharedSecret: () => undefined,
        rateLimiter: allowAllLimiter,
        deploymentMode: 'local',
        getBootstrapWorkspace: () => bootstrapWorkspace,
    };
}

/** Localhost host header so the Host/Origin gate passes. */
function withAuth(
    bearer: string,
    workspaceHeader?: string,
): Record<string, string | undefined> {
    const h: Record<string, string | undefined> = {
        host: `127.0.0.1:${PORT}`,
        authorization: `Bearer ${bearer}`,
    };
    if (workspaceHeader !== undefined) h['x-lore-workspace'] = workspaceHeader;
    return h;
}

/**
 * Run the gates inside a CLEAN workspace context so we can observe what
 * (if anything) the request resolves to. We seed a sentinel binding; if the
 * gate 403s before resolving, no workspace flows through (proving tenant B
 * was never selected).
 *
 * L-032: runHttpGates NO LONGER enterWith-binds the workspace; it RETURNS
 * the validated `workspaceId` on the handled:false result. The dispatcher
 * then wraps the rest of dispatch in the callback-scoped runWithWorkspace.
 * This harness mirrors the dispatcher: it wraps the observation in
 * runWithWorkspaceIfAny(result.workspaceId, ...) and reads
 * getCurrentWorkspaceId() INSIDE that scope, so `boundWorkspace` reflects
 * exactly what downstream routes will see — and the sentinel proves the
 * binding is scoped (it is NOT mutated by the gate itself).
 */
async function runAndObserve(
    deps: HttpGateDeps,
    req: IncomingMessage,
    res: ServerResponse & { _status: number; _body: string },
): Promise<{ handled: boolean; status: number; body: string; boundWorkspace: string | null }> {
    const SENTINEL = '__never-bound__';
    return runWithWorkspace({ workspaceId: SENTINEL }, async () => {
        const result = await runHttpGates(req, res, deps);
        // The gate must NOT have mutated the surrounding scope (no enterWith).
        assert.equal(
            getCurrentWorkspaceId(),
            SENTINEL,
            'runHttpGates must not mutate the caller workspace scope (L-032: no enterWith leak)',
        );
        const resolved = result.handled ? undefined : result.workspaceId;
        // Mirror the dispatcher: bind the resolved workspace in a callback
        // scope and observe what a downstream route would read.
        const bound = runWithWorkspaceIfAny(resolved, () => getCurrentWorkspaceId());
        return {
            handled: result.handled,
            status: res._status,
            body: res._body,
            // Sentinel still present ⇒ no tenant flowed through to dispatch.
            boundWorkspace: bound === SENTINEL ? null : bound,
        };
    });
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

(async () => {
    console.log('tw3a-cross-tenant-isolation-unit.ts — cloud tenant header bound to principal');

    /* ── EXPLOIT: principal scoped to A, header B → cross-tenant breach ── */

    await test('EXPLOIT READ: principal A + X-Lore-Workspace:B (GET) → 403, tenant B NOT bound', async () => {
        const deps = cloudDeps(A); // session token ⇒ bootstrap principal scoped to A
        const req = fakeReq('GET', '/api/search?q=x', withAuth(SESSION_TOKEN, B));
        const res = fakeRes();
        const out = await runAndObserve(deps, req, res);
        assert.equal(out.handled, true, 'the gate must handle (reject) the request');
        assert.equal(out.status, 403, `expected 403, got ${out.status}: ${out.body}`);
        assert.match(out.body, /workspace_forbidden/, out.body);
        assert.equal(out.boundWorkspace, null, 'tenant B must NEVER be bound (B unreadable)');
        // Belt-and-suspenders: the victim tenant id must not appear as a bound value.
        assert.notEqual(out.boundWorkspace, B, 'victim tenant must not be routed');
    });

    await test('EXPLOIT WRITE: principal A + X-Lore-Workspace:B (POST) → 403, tenant B NOT bound', async () => {
        const deps = cloudDeps(A);
        const req = fakeReq('POST', '/api/nodes', withAuth(SESSION_TOKEN, B));
        const res = fakeRes();
        const out = await runAndObserve(deps, req, res);
        assert.equal(out.handled, true, 'the gate must handle (reject) the write');
        assert.equal(out.status, 403, `expected 403, got ${out.status}: ${out.body}`);
        assert.match(out.body, /workspace_forbidden/, out.body);
        assert.equal(out.boundWorkspace, null, 'tenant B must NEVER be bound (no foreign write)');
    });

    /* ── CONTROL: principal A + header A → succeeds, binds A ── */

    await test('CONTROL READ: principal A + X-Lore-Workspace:A (GET) → passes, binds tenant A', async () => {
        const deps = cloudDeps(A);
        const req = fakeReq('GET', '/api/search?q=x', withAuth(SESSION_TOKEN, A));
        const res = fakeRes();
        const out = await runAndObserve(deps, req, res);
        assert.equal(out.handled, false, `own-workspace read must pass the gate: ${out.status} ${out.body}`);
        assert.equal(out.boundWorkspace, A, 'must bind the principal own tenant A');
    });

    await test('CONTROL WRITE: principal A + X-Lore-Workspace:A (POST) → passes, binds tenant A', async () => {
        const deps = cloudDeps(A);
        const req = fakeReq('POST', '/api/nodes', withAuth(SESSION_TOKEN, A));
        const res = fakeRes();
        const out = await runAndObserve(deps, req, res);
        assert.equal(out.handled, false, `own-workspace write must pass the gate: ${out.status} ${out.body}`);
        assert.equal(out.boundWorkspace, A, 'must bind the principal own tenant A');
    });

    /* ── PRESERVED: master/service principal (cross-workspace scopes) may target B ── */

    await test('SERVICE: shared-secret principal (cross-workspace) + header B → allowed, binds B', async () => {
        const deps = cloudDeps(A); // boot ws A, but shared secret has cross-workspace-*
        const req = fakeReq('POST', '/api/nodes', withAuth(SHARED_SECRET, B));
        const res = fakeRes();
        const out = await runAndObserve(deps, req, res);
        assert.equal(out.handled, false, `cross-workspace service write must pass: ${out.status} ${out.body}`);
        assert.equal(out.boundWorkspace, B, 'service principal may legitimately target tenant B');
    });

    /* ── REGRESSION GUARD: empty header still 400 (Q2.1 contract intact) ── */

    await test('GUARD: principal A + missing X-Lore-Workspace → 400 workspace_header_required', async () => {
        const deps = cloudDeps(A);
        const req = fakeReq('GET', '/api/search?q=x', withAuth(SESSION_TOKEN)); // no ws header
        const res = fakeRes();
        const out = await runAndObserve(deps, req, res);
        assert.equal(out.handled, true);
        assert.equal(out.status, 400, out.body);
        assert.match(out.body, /workspace_header_required/, out.body);
    });

    /* ── REGRESSION GUARD: local mode unaffected (null-principal path intact) ── */

    await test('GUARD: local mode, no header → gate passes, no cloud binding (round-2 path intact)', async () => {
        const deps = localDeps(A);
        // Bearerless local request (round-2 localhost-trust path) — no principal.
        const req = fakeReq('GET', '/api/search?q=x', { host: `127.0.0.1:${PORT}` });
        const res = fakeRes();
        const out = await runAndObserve(deps, req, res);
        // Local mode skips the cloud workspace gate entirely.
        assert.notEqual(out.status, 403, `local mode must not 403 on tenant routing: ${out.body}`);
        assert.equal(out.boundWorkspace, null, 'local mode binds no cloud tenant');
    });

    await test('GUARD: local mode with foreign X-Lore-Workspace header is DENIED (fail-closed, no cloud routing)', async () => {
        const deps = localDeps(A);
        const req = fakeReq('GET', '/api/search?q=x', withAuth(SESSION_TOKEN, B));
        const res = fakeRes();
        const out = await runAndObserve(deps, req, res);
        assert.equal(out.status, 403, `expected 403, got ${out.status}: ${out.body}`);
        assert.match(out.body, /workspace_forbidden/, out.body);
        assert.equal(out.boundWorkspace, null, 'tenant B must NEVER be bound (fail-closed, not routed)');
    });

    /* ── L-032: workspace binding is callback-scoped, not enterWith-leaked ── */

    await test('L-032: gate does not enterWith-leak; binding only lives inside runWithWorkspaceIfAny', async () => {
        const deps = cloudDeps(A);
        const req = fakeReq('GET', '/api/search?q=x', withAuth(SESSION_TOKEN, A));
        const res = fakeRes();
        // Run the gate OUTSIDE any workspace scope.
        const result = await runHttpGates(req, res, deps);
        assert.equal(result.handled, false, `own-workspace read must pass: ${res._status} ${res._body}`);
        // The gate itself must NOT have bound anything into this async chain.
        assert.equal(getCurrentWorkspaceId(), null, 'gate must not bind via enterWith — nothing bound outside a scope');
        const resolved = result.handled ? undefined : result.workspaceId;
        assert.equal(resolved, A, 'gate returns the validated workspace id');
        // Bound ONLY inside the callback scope...
        const inside = runWithWorkspaceIfAny(resolved, () => getCurrentWorkspaceId());
        assert.equal(inside, A, 'workspace is visible inside the callback scope');
        // ...and popped immediately after — no leak past the scope.
        assert.equal(getCurrentWorkspaceId(), null, 'workspace binding pops on scope exit (no cross-request leak)');
    });

    await test('L-032: two interleaved cloud requests for different tenants never cross-contaminate', async () => {
        const observed: Array<string | null> = [];
        const driveOne = async (bearer: string, header: string): Promise<void> => {
            const deps = cloudDeps(A);
            const req = fakeReq('POST', '/api/nodes', withAuth(bearer, header));
            const res = fakeRes();
            const result = await runHttpGates(req, res, deps);
            const resolved = result.handled ? undefined : result.workspaceId;
            await runWithWorkspaceIfAny(resolved, async () => {
                // Yield so the two requests interleave on the event loop.
                await new Promise((r) => setImmediate(r));
                observed.push(getCurrentWorkspaceId());
            });
        };
        // Request 1: service principal targeting B (allowed). Request 2: own A.
        await Promise.all([
            driveOne(SHARED_SECRET, B),
            driveOne(SESSION_TOKEN, A),
        ]);
        const sorted = [...observed].sort();
        assert.deepEqual(sorted, [A, B].sort(),
            `each interleaved request must read ONLY its own workspace; got ${JSON.stringify(observed)}`);
    });

    console.log(`\nTW-3a: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

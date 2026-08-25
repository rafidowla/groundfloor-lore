#!/usr/bin/env tsx
/**
 * test/route-gates-l068-unit.ts — regression tests for the L-068 systemic fix:
 * the 25 mutating REST routes that previously enforced authz only via gateRoute
 * (a no-op in local mode) now also enforce a per-token write-scope gate. Covers
 * a representative mutating route from several of the gated files; each asserts a
 * read-only token → 403, and (where safe) a null principal bypasses (local).
 *
 * The gate sits right after gateRoute, which returns allowed:true immediately in
 * local mode, so a {deploymentMode:'local', dataplane:null} deps stub is enough
 * to reach the per-token gate without wiring real stores.
 *
 * Style mirrors launch-readiness-b1b6-unit.ts (fakeReq/fakeRes + runWithPrincipal).
 */

import { strict as assert } from 'node:assert';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleDaemonRestart } from '../packages/lore/src/mcp/http/routes/diagnostic/daemonControl.js';
import { handleSupersede } from '../packages/lore/src/mcp/http/routes/nodes/supersede.js';
import { tryPolicyRoutes } from '../packages/lore/src/mcp/http/routes/retention/policy.js';
import { tryVerbatimRoutes } from '../packages/lore/src/mcp/http/routes/retention/verbatim.js';
import { tryWorkspaceMgmtRoutes } from '../packages/lore/src/mcp/http/routes/workspaces/workspaceMgmt.js';
import { tryAuditRoutes } from '../packages/lore/src/mcp/http/routes/audit.js';
import { trySyncRoutes } from '../packages/lore/src/mcp/http/routes/sync.js';
import { tryAnchorsRoutes } from '../packages/lore/src/mcp/http/routes/anchors.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';

function appPrincipal(workspace: string, scopes: TokenScope[]): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${workspace}` };
}
const READ = appPrincipal('test-ws', ['read']);
const WRITE = appPrincipal('test-ws', ['read', 'write']);

function fakeReq(method: string, url?: string, body?: string): IncomingMessage {
    if (body !== undefined) {
        let consumed = false;
        return {
            method, url,
            on(event: string, cb: (chunk?: Buffer) => void) {
                if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
                if (event === 'end') setImmediate(() => cb());
                return this;
            },
        } as unknown as IncomingMessage;
    }
    return { method, url, on: () => undefined } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function denialCode(res: { _body: string }): string {
    try { const o = JSON.parse(res._body) as { error?: string; code?: string }; return o.error ?? o.code ?? ''; }
    catch { return ''; }
}
// Local-mode deps stub: gateRoute({deploymentMode:'local'}) → allowed, so the
// per-token gate is the next check. Cast — the handler 403s before using the rest.
const LOCAL = { deploymentMode: 'local', dataplane: null } as never;

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void> | void) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
};

console.log('route-gates-l068-unit.ts');

/* daemonControl — read-only must NOT be able to restart the daemon.
   (Only the 403 path is tested: a null/write principal would trigger the real
   shutdown drain, which must never run inside the test process.) */
test('daemonControl: POST /api/daemon/restart with read-only token → 403 (no restart)', async () => {
    const res = fakeRes();
    await runWithPrincipal(READ, () => handleDaemonRestart(res));
    assert.equal(res._status, 403, `expected 403, got ${res._status}: ${res._body}`);
    // Wave-4b: daemon restart is a daemon-wide operator op gated via
    // bindDaemonOperatorLane, not the per-workspace write-scope gate — an app
    // token (even read+write) without 'cross-workspace-write' gets
    // workspace_forbidden, not scope_missing/denied.
    assert.equal(denialCode(res), 'workspace_forbidden', `expected workspace_forbidden; got ${res._status} ${res._body}`);
});

/* supersede */
test('supersede: POST /api/node/supersede with read-only token → 403', async () => {
    const res = fakeRes();
    await runWithPrincipal(READ, () => handleSupersede(
        fakeReq('POST', '/api/node/supersede', '{}'), res, '/api/node/supersede', LOCAL));
    assert.equal(res._status, 403);
    assert.ok(['scope_missing', 'denied'].includes(denialCode(res)), `expected a write-scope denial (scope_missing|denied); got `);
});

/* retention/policy — prune-ephemeral */
test('retention/policy: POST /api/prune-ephemeral with read-only token → 403', async () => {
    const res = fakeRes();
    await runWithPrincipal(READ, () => tryPolicyRoutes(
        fakeReq('POST', '/api/prune-ephemeral', '{}'), res, LOCAL, '/api/prune-ephemeral'));
    assert.equal(res._status, 403);
    assert.ok(['scope_missing', 'denied'].includes(denialCode(res)), `expected a write-scope denial (scope_missing|denied); got `);
});

test('retention/policy: POST /api/prune-ephemeral with NO principal → not 403 (local bypass preserved)', async () => {
    const res = fakeRes();
    await tryPolicyRoutes(fakeReq('POST', '/api/prune-ephemeral', '{}'), res, LOCAL, '/api/prune-ephemeral');
    assert.notEqual(res._status, 403, 'null principal must bypass the per-token gate in local mode');
});

/* retention/verbatim — reap */
test('retention/verbatim: POST /api/verbatim/reap with read-only token → 403', async () => {
    const res = fakeRes();
    await runWithPrincipal(READ, () => tryVerbatimRoutes(
        fakeReq('POST', '/api/verbatim/reap', '{}'), res, '/api/verbatim/reap', LOCAL, '/api/verbatim/reap'));
    assert.equal(res._status, 403);
    assert.ok(['scope_missing', 'denied'].includes(denialCode(res)), `expected a write-scope denial (scope_missing|denied); got `);
});

/* workspaces — create */
test('workspaceMgmt: POST /api/workspaces with read-only token → 403', async () => {
    const res = fakeRes();
    await runWithPrincipal(READ, () => tryWorkspaceMgmtRoutes(
        fakeReq('POST', '/api/workspaces', '{}'), res, '/api/workspaces', '/api/workspaces', LOCAL));
    assert.equal(res._status, 403);
    assert.ok(['scope_missing', 'denied'].includes(denialCode(res)), `expected a write-scope denial (scope_missing|denied); got `);
});

test('workspaceMgmt: DELETE /api/workspaces/foo with read-only token → 403', async () => {
    const res = fakeRes();
    await runWithPrincipal(READ, () => tryWorkspaceMgmtRoutes(
        fakeReq('DELETE', '/api/workspaces/foo'), res, '/api/workspaces/foo', '/api/workspaces/foo', LOCAL));
    assert.equal(res._status, 403);
    assert.ok(['scope_missing', 'denied'].includes(denialCode(res)), `expected a write-scope denial (scope_missing|denied); got `);
});

/* audit — feedback */
test('audit: POST /api/feedback with read-only token → 403', async () => {
    const res = fakeRes();
    await runWithPrincipal(READ, () => tryAuditRoutes(
        fakeReq('POST', '/api/feedback', '{}'), res, '/api/feedback', '/api/feedback', LOCAL));
    assert.equal(res._status, 403);
    // Wave-4b: FeedbackStore is a daemon-wide JSONL file, gated via
    // bindDaemonOperatorLane, not the per-workspace write-scope gate — an app
    // token (even read+write) without 'cross-workspace-write' gets
    // workspace_forbidden, not scope_missing/denied.
    assert.equal(denialCode(res), 'workspace_forbidden', `expected workspace_forbidden; got ${res._status} ${res._body}`);
});

/* a write-scoped token must NOT be blocked by the gate (no over-block) — it
   passes the per-token check and proceeds (then may 4xx/5xx on the stub deps,
   but never 403 scope_missing). */
test('write-scoped token passes the gate (not 403) on POST /api/prune-ephemeral', async () => {
    const res = fakeRes();
    await runWithPrincipal(WRITE, () => tryPolicyRoutes(
        fakeReq('POST', '/api/prune-ephemeral', '{}'), res, LOCAL, '/api/prune-ephemeral'));
    assert.notEqual(denialCode(res), 'scope_missing', `write token wrongly gated: ${res._status} ${res._body}`);
});

/* sync — second-round sweep finding (previously ZERO auth) */
test('sync: POST /api/sync/push with read-only token → 403', async () => {
    const res = fakeRes();
    const syncDeps = { getSyncEngine: () => ({} as never) } as never;
    await runWithPrincipal(READ, () => trySyncRoutes(fakeReq('POST', '/api/sync/push', '{}'), res, '/api/sync/push', '/api/sync/push', syncDeps));
    assert.equal(res._status, 403);
    assert.ok(['scope_missing', 'denied'].includes(denialCode(res)), `expected a write-scope denial (scope_missing|denied); got `);
});

/* anchors — a GET that conditionally WRITES via mark_stale=true */
test('anchors: GET …/anchors?mark_stale=true with read-only token → 403 (write path gated)', async () => {
    const res = fakeRes();
    const url = '/api/nodes/n1/anchors?workspace=test-ws&mark_stale=true';
    await runWithPrincipal(READ, () => tryAnchorsRoutes(fakeReq('GET', url), res, url, '/api/nodes/n1/anchors', LOCAL));
    assert.equal(res._status, 403);
    assert.ok(['scope_missing', 'denied'].includes(denialCode(res)), `expected a write-scope denial (scope_missing|denied); got `);
});

test('anchors: GET …/anchors (no mark_stale) with read-only token → NOT 403 (pure read stays read-only)', async () => {
    const res = fakeRes();
    const url = '/api/nodes/n1/anchors?workspace=test-ws';
    await runWithPrincipal(READ, () => tryAnchorsRoutes(fakeReq('GET', url), res, url, '/api/nodes/n1/anchors', LOCAL));
    assert.notEqual(res._status, 403, `pure read must not be write-gated; got ${res._status}: ${res._body}`);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

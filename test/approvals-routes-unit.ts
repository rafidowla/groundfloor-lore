#!/usr/bin/env tsx
/**
 * approvals-routes-unit.ts — drive the pure handlers (`handleList`,
 * `handleGetById`, `handleDecide`) against InMemoryPendingOpsStore.
 * No HTTP plumbing — those handlers are split out so we can test the
 * status-code mapping + error-class translation directly.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    handleList,
    handleGetById,
    handleDecide,
    tryApprovalsRoutes,
} from '../packages/lore/src/mcp/http/routes/approvals.js';
import { InMemoryPendingOpsStore } from '../packages/lore/src/security/inMemoryPendingOpsStore.js';
import { InMemoryReplayHandlerRegistry } from '../packages/lore/src/security/approvalReplay.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';

// L-010 / L-011 — drive tryApprovalsRoutes (not just the pure handlers) so
// the new authz gates fire. Harness mirrors test/sp04-http-read-scope-unit.ts.
function appPrincipal(workspace: string, scopes: TokenScope[]): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${workspace}` };
}
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
// Local mode → gateRoute short-circuits allowed:true, so the token-scope
// branch is what these tests assert.
function approvalsDeps(store: InMemoryPendingOpsStore, registry: InMemoryReplayHandlerRegistry | null = null) {
    return {
        getPendingOpsStore: () => store,
        getReplayRegistry: () => registry,
        deploymentMode: 'local' as const,
        dataplane: null,
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('handleList');

    await test('returns all rows when no filters given', async () => {
        const store = new InMemoryPendingOpsStore();
        await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'a', args: {} });
        await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'a', args: {} });
        const r = await handleList(store, new URLSearchParams());
        assert.equal(r.status, 200);
        assert.equal((r.body as { approvals: unknown[] }).approvals.length, 2);
    });

    await test('filters by status / workspaceId / initiator', async () => {
        const store = new InMemoryPendingOpsStore();
        await store.enqueue({ operation: 'op', workspaceId: 'w-a', initiator: 'alice', args: {} });
        await store.enqueue({ operation: 'op', workspaceId: 'w-b', initiator: 'bob',   args: {} });
        const r = await handleList(store, new URLSearchParams({ workspaceId: 'w-a', initiator: 'alice' }));
        const rows = (r.body as { approvals: { workspaceId: string }[] }).approvals;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].workspaceId, 'w-a');
    });

    await test('rejects unknown status with 400 invalid_status', async () => {
        const store = new InMemoryPendingOpsStore();
        const r = await handleList(store, new URLSearchParams({ status: 'borked' }));
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_status');
    });

    await test('rejects non-positive limit with 400 invalid_limit', async () => {
        const store = new InMemoryPendingOpsStore();
        const r = await handleList(store, new URLSearchParams({ limit: '0' }));
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_limit');
    });

    console.log('\nhandleGetById');

    await test('returns 200 with the row when present', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'a', args: {} });
        const r = await handleGetById(store, op.id);
        assert.equal(r.status, 200);
        assert.equal((r.body as { id: string }).id, op.id);
    });

    await test('returns 404 not_found when missing', async () => {
        const store = new InMemoryPendingOpsStore();
        const r = await handleGetById(store, 'never-was');
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'not_found');
    });

    console.log('\nhandleDecide');

    type DecideOkBody = { approval: { decidedBy?: string; status: string }; replay: { status: string } };

    await test('approve: actor wins over body decidedBy (no registry → replay: skipped)', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'alice', args: {} });
        const r = await handleDecide(store, op.id,
            { decision: 'approved', reason: 'ok', decidedBy: 'liar' },
            'admin-actor',
        );
        assert.equal(r.status, 200);
        const body = r.body as DecideOkBody;
        assert.equal(body.approval.decidedBy, 'admin-actor');
        assert.equal(body.approval.status, 'approved');
        assert.equal(body.replay.status, 'skipped');
    });

    await test('approve: falls back to body decidedBy when no actor', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'alice', args: {} });
        const r = await handleDecide(store, op.id,
            { decision: 'approved', decidedBy: 'admin' },
            null,
        );
        assert.equal(r.status, 200);
        assert.equal((r.body as DecideOkBody).approval.decidedBy, 'admin');
    });

    await test('reject: replay is skipped even if registry is given', async () => {
        const store = new InMemoryPendingOpsStore();
        const reg = new InMemoryReplayHandlerRegistry();
        let handlerRan = false;
        reg.register('op', async () => { handlerRan = true; });
        const op = await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'alice', args: {} });
        const r = await handleDecide(store, op.id, { decision: 'rejected' }, 'admin', reg);
        assert.equal(r.status, 200);
        const body = r.body as DecideOkBody;
        assert.equal(body.approval.status, 'rejected');
        assert.equal(body.replay.status, 'skipped');
        assert.equal(handlerRan, false);
    });

    await test('approve + registry + handler succeeds → replay executed, row advanced to executed', async () => {
        const store = new InMemoryPendingOpsStore();
        const reg = new InMemoryReplayHandlerRegistry();
        let receivedArgs: unknown = null;
        reg.register('forget_person', async (args, ctx) => {
            receivedArgs = args;
            assert.equal(ctx.workspaceId, 'ws-a');
            assert.equal(ctx.initiator, 'alice');
        });
        const op = await store.enqueue({
            operation: 'forget_person',
            workspaceId: 'ws-a',
            initiator: 'alice',
            args: { personId: 'mom' },
        });
        const r = await handleDecide(store, op.id, { decision: 'approved' }, 'admin', reg);
        assert.equal(r.status, 200);
        const body = r.body as DecideOkBody;
        assert.equal(body.replay.status, 'executed');
        assert.equal(body.approval.status, 'executed', 'row advanced past approved');
        assert.deepEqual(receivedArgs, { personId: 'mom' });
    });

    await test('approve + registry but handler missing → no-handler, row stays approved', async () => {
        const store = new InMemoryPendingOpsStore();
        const reg = new InMemoryReplayHandlerRegistry();
        const op = await store.enqueue({ operation: 'mystery_op', workspaceId: 'w', initiator: 'alice', args: {} });
        const r = await handleDecide(store, op.id, { decision: 'approved' }, 'admin', reg);
        assert.equal(r.status, 200);
        const body = r.body as DecideOkBody & { replay: { status: string; operation?: string } };
        assert.equal(body.replay.status, 'no-handler');
        assert.equal(body.replay.operation, 'mystery_op');
        assert.equal(body.approval.status, 'approved');
    });

    await test('approve + registry + handler throws → failed, row stays approved, error surfaced', async () => {
        const store = new InMemoryPendingOpsStore();
        const reg = new InMemoryReplayHandlerRegistry();
        reg.register('boom', async () => { throw new Error('handler exploded'); });
        const op = await store.enqueue({ operation: 'boom', workspaceId: 'w', initiator: 'alice', args: {} });
        const r = await handleDecide(store, op.id, { decision: 'approved' }, 'admin', reg);
        assert.equal(r.status, 200);
        const body = r.body as DecideOkBody & { replay: { status: string; error?: string } };
        assert.equal(body.replay.status, 'failed');
        assert.match(body.replay.error ?? '', /handler exploded/);
        assert.equal(body.approval.status, 'approved');
    });

    await test('returns 401 missing_decider when neither actor nor body provides one', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'alice', args: {} });
        const r = await handleDecide(store, op.id, { decision: 'approved' }, null);
        assert.equal(r.status, 401);
        assert.equal((r.body as { code: string }).code, 'missing_decider');
    });

    await test('returns 400 invalid_decision on bad decision value', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'alice', args: {} });
        const r = await handleDecide(store, op.id, { decision: 'maybe' }, 'admin');
        assert.equal(r.status, 400);
        assert.equal((r.body as { code: string }).code, 'invalid_decision');
    });

    await test('returns 404 not_found when op id missing', async () => {
        const store = new InMemoryPendingOpsStore();
        const r = await handleDecide(store, 'gone', { decision: 'approved' }, 'admin');
        assert.equal(r.status, 404);
        assert.equal((r.body as { code: string }).code, 'not_found');
    });

    await test('returns 403 self_approval_forbidden when decider == initiator', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'alice', args: {} });
        const r = await handleDecide(store, op.id, { decision: 'approved' }, 'alice');
        assert.equal(r.status, 403);
        assert.equal((r.body as { code: string }).code, 'self_approval_forbidden');
    });

    await test('returns 409 op_stale on already-decided op', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'w', initiator: 'alice', args: {} });
        await store.decide({ id: op.id, decision: 'approved', decidedBy: 'admin1' });
        const r = await handleDecide(store, op.id, { decision: 'rejected' }, 'admin2');
        assert.equal(r.status, 409);
        assert.equal((r.body as { code: string }).code, 'op_stale');
        assert.equal((r.body as { currentStatus: string }).currentStatus, 'approved');
    });

    /* ===================================================================
     * L-010 — POST /api/approvals/{id}/decision authorization gate.
     * The decision endpoint triggers replay (real destructive execution);
     * it must be authorized against the OP's own workspace.
     * =================================================================== */
    console.log('\nL-010 — decision endpoint authz gate');

    await test('L-010: principal in workspace A deciding an op in workspace B → 403 workspace_forbidden', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'B', initiator: 'bob', args: {} });
        const res = fakeRes();
        await runWithPrincipal(appPrincipal('A', ['read', 'write']), () =>
            tryApprovalsRoutes(fakeReq('POST', `/api/approvals/${op.id}/decision`, JSON.stringify({ decision: 'approved' })),
                res, `/api/approvals/${op.id}/decision`, `/api/approvals/${op.id}/decision`, approvalsDeps(store)));
        assert.equal(res._status, 403, `expected 403; got ${res._status}: ${res._body}`);
        assert.equal(JSON.parse(res._body).code, 'workspace_forbidden'); // Wave 5 {code, message}
        // The op must still be pending — the gate blocked before decide().
        assert.equal((await store.getById(op.id))?.status, 'pending');
    });

    await test('L-010: principal bound to the op\'s workspace reaches handleDecide (200)', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'B', initiator: 'bob', args: {} });
        const res = fakeRes();
        await runWithPrincipal(appPrincipal('B', ['read', 'write']), () =>
            tryApprovalsRoutes(fakeReq('POST', `/api/approvals/${op.id}/decision`, JSON.stringify({ decision: 'approved', decidedBy: 'admin' })),
                res, `/api/approvals/${op.id}/decision`, `/api/approvals/${op.id}/decision`, approvalsDeps(store)));
        assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    });

    await test('L-010: cross-workspace-write principal can decide a foreign op (200)', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'B', initiator: 'bob', args: {} });
        const res = fakeRes();
        await runWithPrincipal(appPrincipal('A', ['read', 'write', 'cross-workspace-write']), () =>
            tryApprovalsRoutes(fakeReq('POST', `/api/approvals/${op.id}/decision`, JSON.stringify({ decision: 'approved', decidedBy: 'admin' })),
                res, `/api/approvals/${op.id}/decision`, `/api/approvals/${op.id}/decision`, approvalsDeps(store)));
        assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    });

    await test('L-010: read-only principal is refused (403 at a write-scope gate)', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'B', initiator: 'bob', args: {} });
        const res = fakeRes();
        await runWithPrincipal(appPrincipal('B', ['read']), () =>
            tryApprovalsRoutes(fakeReq('POST', `/api/approvals/${op.id}/decision`, JSON.stringify({ decision: 'approved' })),
                res, `/api/approvals/${op.id}/decision`, `/api/approvals/${op.id}/decision`, approvalsDeps(store)));
        assert.equal(res._status, 403, `expected 403; got ${res._status}: ${res._body}`);
        // The decision route gates on op.approverPermission ('administer') via
        // gateRoute (approvals.ts:296); in local mode that scope check (added
        // 2026-06-20 commit 1a4ec7b) refuses a read-only token FIRST with
        // { code:'denied' }. requireWriteToWorkspace, surfaced via the
        // chokepoint writeDenial as { code:'scope_missing' } (Wave 5 canonical
        // envelope; was { error:'scope_missing' }), is reached only by
        // write-scoped tokens. Assert the property (refused at a write gate),
        // not which gate fired.
        const b = JSON.parse(res._body) as { code?: string };
        assert.ok(b.code === 'scope_missing' || b.code === 'denied', `expected a write-scope denial; got ${res._body}`);
    });

    await test('L-010: no principal bound → legacy bypass reaches handleDecide (200)', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'B', initiator: 'bob', args: {} });
        const res = fakeRes();
        await tryApprovalsRoutes(fakeReq('POST', `/api/approvals/${op.id}/decision`, JSON.stringify({ decision: 'approved', decidedBy: 'admin' })),
            res, `/api/approvals/${op.id}/decision`, `/api/approvals/${op.id}/decision`, approvalsDeps(store));
        assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
    });

    await test('L-010: unknown op id → 404 not_found', async () => {
        const store = new InMemoryPendingOpsStore();
        const res = fakeRes();
        await runWithPrincipal(appPrincipal('A', ['read', 'write']), () =>
            tryApprovalsRoutes(fakeReq('POST', `/api/approvals/ghost/decision`, JSON.stringify({ decision: 'approved' })),
                res, `/api/approvals/ghost/decision`, `/api/approvals/ghost/decision`, approvalsDeps(store)));
        assert.equal(res._status, 404, `expected 404; got ${res._status}: ${res._body}`);
        assert.equal(JSON.parse(res._body).code, 'not_found');
    });

    /* ===================================================================
     * L-011 — GET /api/approvals (list) + GET /api/approvals/{id} read scope.
     * Workspace is an authorization boundary, not just a client filter.
     * =================================================================== */
    console.log('\nL-011 — approvals read-scope gate');

    async function seedTwoWorkspaces(): Promise<InMemoryPendingOpsStore> {
        const store = new InMemoryPendingOpsStore();
        await store.enqueue({ operation: 'op', workspaceId: 'A', initiator: 'alice', args: {} });
        await store.enqueue({ operation: 'op', workspaceId: 'B', initiator: 'bob', args: {} });
        return store;
    }

    await test('L-011: principal A GET /api/approvals with NO workspaceId returns ONLY A\'s ops', async () => {
        const store = await seedTwoWorkspaces();
        const res = fakeRes();
        await runWithPrincipal(appPrincipal('A', ['read']), () =>
            tryApprovalsRoutes(fakeReq('GET', '/api/approvals'), res, '/api/approvals', '/api/approvals', approvalsDeps(store)));
        assert.equal(res._status, 200, res._body);
        const rows = JSON.parse(res._body).approvals as { workspaceId: string }[];
        assert.ok(rows.length > 0 && rows.every(r => r.workspaceId === 'A'), `expected only A's ops; got ${JSON.stringify(rows.map(r => r.workspaceId))}`);
    });

    await test('L-011: principal A GET /api/approvals?workspaceId=B → 403 workspace_forbidden', async () => {
        const store = await seedTwoWorkspaces();
        const res = fakeRes();
        await runWithPrincipal(appPrincipal('A', ['read']), () =>
            tryApprovalsRoutes(fakeReq('GET', '/api/approvals?workspaceId=B'), res, '/api/approvals?workspaceId=B', '/api/approvals', approvalsDeps(store)));
        assert.equal(res._status, 403, `expected 403; got ${res._status}: ${res._body}`);
        assert.equal(JSON.parse(res._body).code, 'workspace_forbidden'); // Wave 5 {code, message}
    });

    await test('L-011: cross-workspace-read principal GET /api/approvals (no filter) returns ALL', async () => {
        const store = await seedTwoWorkspaces();
        const res = fakeRes();
        await runWithPrincipal(appPrincipal('A', ['read', 'cross-workspace-read']), () =>
            tryApprovalsRoutes(fakeReq('GET', '/api/approvals'), res, '/api/approvals', '/api/approvals', approvalsDeps(store)));
        assert.equal(res._status, 200, res._body);
        const rows = JSON.parse(res._body).approvals as { workspaceId: string }[];
        assert.equal(rows.length, 2, 'cross-workspace-read sees both tenants');
    });

    await test('L-011: principal A GET /api/approvals/{idOfBsOp} → 403 workspace_forbidden', async () => {
        const store = new InMemoryPendingOpsStore();
        const bOp = await store.enqueue({ operation: 'op', workspaceId: 'B', initiator: 'bob', args: {} });
        const res = fakeRes();
        await runWithPrincipal(appPrincipal('A', ['read']), () =>
            tryApprovalsRoutes(fakeReq('GET', `/api/approvals/${bOp.id}`), res, `/api/approvals/${bOp.id}`, `/api/approvals/${bOp.id}`, approvalsDeps(store)));
        assert.equal(res._status, 403, `expected 403; got ${res._status}: ${res._body}`);
        assert.equal(JSON.parse(res._body).code, 'workspace_forbidden'); // Wave 5 {code, message}
    });

    await test('L-011: no principal bound → list returns everything (bypass preserved)', async () => {
        const store = await seedTwoWorkspaces();
        const res = fakeRes();
        await tryApprovalsRoutes(fakeReq('GET', '/api/approvals'), res, '/api/approvals', '/api/approvals', approvalsDeps(store));
        assert.equal(res._status, 200, res._body);
        assert.equal((JSON.parse(res._body).approvals as unknown[]).length, 2);
    });

    /* ===================================================================
     * L-029 — the decision gate must consume the OP's persisted
     * approverPermission, not hardcode 'administer'. Drive the cloud-mode
     * ReBAC path (gateRoute defers to dataplane.checkPermission) with a
     * spy dataplane that records the permission it was asked to check.
     * No principal is bound, so only the gateRoute permission gate runs.
     * =================================================================== */
    console.log('\nL-029 — decision gate consumes persisted approverPermission');

    // Minimal spy: dataplaneAuthz.checkPermission calls the SDK's protected
    // `fetch('/v1/authz/check', {body})`. Record the `permission` from the
    // body and answer allowed so the request proceeds to handleDecide.
    function spyDataplane(): { client: GroundfloorClient; seen: string[] } {
        const seen: string[] = [];
        const client = {
            fetch(_path: string, opts: { body?: string }) {
                const parsed = opts.body ? JSON.parse(opts.body) as { permission?: string } : {};
                if (parsed.permission) seen.push(parsed.permission);
                return Promise.resolve({ success: true, data: { allowed: true } });
            },
        } as unknown as GroundfloorClient;
        return { client, seen };
    }
    function cloudDeps(store: InMemoryPendingOpsStore, dataplane: GroundfloorClient) {
        return {
            getPendingOpsStore: () => store,
            getReplayRegistry: () => null,
            deploymentMode: 'cloud' as const,
            dataplane,
        };
    }

    await test('L-029: op with approverPermission=manage_members → gate checks manage_members (NOT administer)', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({
            operation: 'invite_member', workspaceId: 'B', initiator: 'bob', args: {},
            approverPermission: 'manage_members',
        });
        const { client, seen } = spyDataplane();
        const res = fakeRes();
        // Cloud gate needs a bound actor (getCurrentActor) + workspace context.
        await runWithWorkspace({ workspaceId: 'B' }, () =>
            runWithActor({ portalUserId: 'admin-user', scopes: [] }, () =>
                tryApprovalsRoutes(
                    fakeReq('POST', `/api/approvals/${op.id}/decision`, JSON.stringify({ decision: 'approved', decidedBy: 'admin' })),
                    res, `/api/approvals/${op.id}/decision`, `/api/approvals/${op.id}/decision`,
                    cloudDeps(store, client))));
        assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
        assert.deepEqual(seen, ['manage_members'], `gate must check the persisted permission; saw ${JSON.stringify(seen)}`);
    });

    await test('L-029: op WITHOUT approverPermission → gate falls back to administer', async () => {
        const store = new InMemoryPendingOpsStore();
        const op = await store.enqueue({ operation: 'op', workspaceId: 'B', initiator: 'bob', args: {} });
        const { client, seen } = spyDataplane();
        const res = fakeRes();
        await runWithWorkspace({ workspaceId: 'B' }, () =>
            runWithActor({ portalUserId: 'admin-user', scopes: [] }, () =>
                tryApprovalsRoutes(
                    fakeReq('POST', `/api/approvals/${op.id}/decision`, JSON.stringify({ decision: 'approved', decidedBy: 'admin' })),
                    res, `/api/approvals/${op.id}/decision`, `/api/approvals/${op.id}/decision`,
                    cloudDeps(store, client))));
        assert.equal(res._status, 200, `expected 200; got ${res._status}: ${res._body}`);
        assert.deepEqual(seen, ['administer'], `default must be administer; saw ${JSON.stringify(seen)}`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

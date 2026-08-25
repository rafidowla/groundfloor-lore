#!/usr/bin/env tsx
/**
 * test/rebac-l2-unit.ts — T1c unit tests for the L2 permission evaluator.
 *
 * Exercises:
 *   - Expression parsing: terms, unknowns, empty
 *   - permissionCheck: allowed via direct relation, allowed via group,
 *     allowed via parent inheritance
 *   - permissionCheck denials with structured reason: no-schema, no-action,
 *     no-relation-matches, unknown-relation
 *   - The Property Manager scenario end-to-end:
 *       schema declares `property.approve_ticket: editor | owner`
 *       and `property.transfer_owner: owner`. Alice editor-of PropertyA
 *       can approve_ticket but cannot transfer_owner.
 *   - setSchema rebuilds known relations (workspaces evolve their schema).
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { RebacStore } from '../packages/lore/src/security/rebac.js';
import {
    RebacEvaluator,
    parsePermissionExpression,
} from '../packages/lore/src/security/rebacEvaluator.js';
import {
    DEFAULT_SCHEMA_V2,
    type LoreSchemaV2,
} from '../packages/lore/src/schemas/types.js';
// L-031 — destructive hard-delete routes must gate on the finer 'delete'
// permission (not 'write'). Drive the real routes in cloud mode with a
// permission-recording dataplane fake to prove which permission the gate
// asks for.
import { tryNodeDeleteRoute } from '../packages/lore/src/mcp/http/routes/nodes-delete.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { tryLifecycleRoutes } from '../packages/lore/src/mcp/http/routes/lifecycle.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => {
                console.log(`  ✓ ${name}`);
                passed++;
            },
            (err: Error) => {
                console.error(`  ✗ ${name}`);
                console.error(`    ${err.message}`);
                failed++;
            },
        );
}

// kuzu-lite's native bindings segfault / Mmap-fail under repeated
// One store across all tests; reset data between tests instead.
let _shared: { store: RebacStore; nodes: Set<string>; cleanup: () => void } | null = null;

async function makeFixture(): Promise<{ store: RebacStore; nodes: Set<string>; cleanup: () => void }> {
    if (_shared) {
        // Reset between tests: clear tuples, then the node set.
        await _shared.store.clearAll();
        _shared.nodes.clear();
        return _shared;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rebac-l2-test-'));
    // The graph node set the endpoint probe answers from. On Kùzu this was a
    // real LoreNode table; the store no longer cares which engine supplies it,
    // which is the point of the injected probe.
    const nodes = new Set<string>();
    const store = new RebacStore(path.join(dir, 'rebac.sqlite'), async (ids) =>
        new Set(ids.filter((id) => nodes.has(id))));
    await store.ensureSchema();
    const tmpDir = dir;
    _shared = {
        store,
        nodes,
        cleanup: () => { /* shared — no-op between tests; closed at process exit below */ },
    };
    process.on('exit', () => {
        try { store.close(); } catch { /* ignore */ }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
    return _shared;
}

function seedNode(nodes: Set<string>, id: string): void {
    nodes.add(id);
}

const PROPERTY_SCHEMA: LoreSchemaV2 = {
    ...DEFAULT_SCHEMA_V2,
    nodeTypes: [
        { name: 'property', description: 'A real-estate property.', kind: 'factual' },
        { name: 'lease', description: 'A lease contract.', kind: 'factual' },
    ],
    permissions: {
        property: {
            view: 'viewer | editor | owner',
            approve_ticket: 'editor | owner',
            transfer_owner: 'owner',
        },
    },
};

async function main() {
    console.log('rebac L2 — T1c');

    /* ---------- parser ---------- */

    await test('parsePermissionExpression splits OR terms', () => {
        const r = parsePermissionExpression('editor | owner | viewer', ['owner', 'editor', 'viewer']);
        assert.deepEqual(r.terms.sort(), ['editor', 'owner', 'viewer']);
        assert.deepEqual(r.unknown, []);
    });

    await test('parsePermissionExpression separates unknowns', () => {
        const r = parsePermissionExpression('editor | superhero', ['owner', 'editor']);
        assert.deepEqual(r.terms, ['editor']);
        assert.deepEqual(r.unknown, ['superhero']);
    });

    await test('parsePermissionExpression handles empty', () => {
        const r = parsePermissionExpression('', ['owner']);
        assert.deepEqual(r.terms, []);
        assert.deepEqual(r.unknown, []);
    });

    /* ---------- check denials with structured reason ---------- */

    await test('denied: resourceType not in schema', async () => {
        const f = await makeFixture();
        try {
            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);
            const r = await evaluator.check({
                subject: 'alice', action: 'view', resource: 'pA', resourceType: 'unicorn',
            });
            assert.equal(r.allowed, false);
            assert.equal(r.reason.kind, 'denied');
            if (r.reason.kind === 'denied') {
                assert.equal(r.reason.cause, 'no-schema');
            }
        } finally { f.cleanup(); }
    });

    await test('denied: action not declared on resourceType', async () => {
        const f = await makeFixture();
        try {
            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);
            const r = await evaluator.check({
                subject: 'alice', action: 'launch_rocket', resource: 'pA', resourceType: 'property',
            });
            assert.equal(r.allowed, false);
            if (r.reason.kind === 'denied') assert.equal(r.reason.cause, 'no-action');
        } finally { f.cleanup(); }
    });

    await test('denied: no relation matches', async () => {
        const f = await makeFixture();
        try {
            seedNode(f.nodes, 'alice');
            seedNode(f.nodes, 'pA');
            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);
            const r = await evaluator.check({
                subject: 'alice', action: 'view', resource: 'pA', resourceType: 'property',
            });
            assert.equal(r.allowed, false);
            if (r.reason.kind === 'denied') assert.equal(r.reason.cause, 'no-relation-matches');
        } finally { f.cleanup(); }
    });

    await test('denied: schema references an unknown relation', async () => {
        const f = await makeFixture();
        try {
            seedNode(f.nodes, 'alice');
            seedNode(f.nodes, 'pA');
            const bad: LoreSchemaV2 = {
                ...PROPERTY_SCHEMA,
                permissions: {
                    property: { view: 'editor | superhero' },
                },
            };
            const evaluator = new RebacEvaluator(f.store, bad);
            const r = await evaluator.check({
                subject: 'alice', action: 'view', resource: 'pA', resourceType: 'property',
            });
            assert.equal(r.allowed, false);
            if (r.reason.kind === 'denied') {
                assert.equal(r.reason.cause, 'unknown-relation');
                assert.match(String(r.reason.detail), /superhero/);
            }
        } finally { f.cleanup(); }
    });

    /* ---------- happy paths ---------- */

    await test('allowed: direct editor satisfies approve_ticket', async () => {
        const f = await makeFixture();
        try {
            seedNode(f.nodes, 'alice');
            seedNode(f.nodes, 'pA');
            await f.store.grant({ subject: 'alice', relation: 'editor', resource: 'pA', grantedBy: 'sys' });
            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);
            const r = await evaluator.check({
                subject: 'alice', action: 'approve_ticket', resource: 'pA', resourceType: 'property',
            });
            assert.equal(r.allowed, true);
            if (r.reason.kind === 'allowed') {
                assert.equal(r.reason.viaRelation, 'editor');
            }
        } finally { f.cleanup(); }
    });

    await test('allowed: viewer-only satisfies view', async () => {
        const f = await makeFixture();
        try {
            seedNode(f.nodes, 'alice');
            seedNode(f.nodes, 'pA');
            await f.store.grant({ subject: 'alice', relation: 'viewer', resource: 'pA', grantedBy: 'sys' });
            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);
            const r = await evaluator.check({
                subject: 'alice', action: 'view', resource: 'pA', resourceType: 'property',
            });
            assert.equal(r.allowed, true);
            if (r.reason.kind === 'allowed') assert.equal(r.reason.viaRelation, 'viewer');
        } finally { f.cleanup(); }
    });

    /* ---------- the canonical scenario ---------- */

    await test('Property Manager scenario: editor can approve_ticket but NOT transfer_owner', async () => {
        const f = await makeFixture();
        try {
            seedNode(f.nodes, 'alice');
            seedNode(f.nodes, 'pA');
            await f.store.grant({ subject: 'alice', relation: 'editor', resource: 'pA', grantedBy: 'sys' });

            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);

            const approve = await evaluator.check({
                subject: 'alice', action: 'approve_ticket', resource: 'pA', resourceType: 'property',
            });
            assert.equal(approve.allowed, true, 'editor satisfies approve_ticket');

            const transfer = await evaluator.check({
                subject: 'alice', action: 'transfer_owner', resource: 'pA', resourceType: 'property',
            });
            assert.equal(transfer.allowed, false, 'editor does NOT satisfy transfer_owner');
            if (transfer.reason.kind === 'denied') {
                assert.equal(transfer.reason.cause, 'no-relation-matches');
            }
        } finally { f.cleanup(); }
    });

    await test('Property Manager scenario via parent: lease inherits approve_ticket through PropertyA', async () => {
        const f = await makeFixture();
        try {
            seedNode(f.nodes, 'alice');
            seedNode(f.nodes, 'pA');
            seedNode(f.nodes, 'leaseA');
            await f.store.grant({ subject: 'alice', relation: 'editor', resource: 'pA', grantedBy: 'sys' });
            await f.store.grant({ subject: 'leaseA', relation: 'parent', resource: 'pA', grantedBy: 'sys' });

            // The schema declares actions on `property`. We model leases as
            // also-property-typed for this minimal scenario; in real usage
            // the schema declares `lease` actions inheriting from property
            // via an explicit lease entry. Keep this test focused on the
            // parent-walk part: pretend the action is asked on the lease's
            // resourceType 'property' (since the policy lives there).
            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);
            const r = await evaluator.check({
                subject: 'alice', action: 'approve_ticket', resource: 'leaseA', resourceType: 'property',
            });
            assert.equal(r.allowed, true, 'editor on PropertyA inherits approve_ticket on leaseA');
        } finally { f.cleanup(); }
    });

    await test('Property Manager scenario: Alice cannot approve_ticket on Bob\'s property', async () => {
        const f = await makeFixture();
        try {
            seedNode(f.nodes, 'alice');
            seedNode(f.nodes, 'bob');
            seedNode(f.nodes, 'pA');
            seedNode(f.nodes, 'pB');
            await f.store.grant({ subject: 'alice', relation: 'editor', resource: 'pA', grantedBy: 'sys' });
            await f.store.grant({ subject: 'bob', relation: 'editor', resource: 'pB', grantedBy: 'sys' });

            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);
            const aliceOnPB = await evaluator.check({
                subject: 'alice', action: 'approve_ticket', resource: 'pB', resourceType: 'property',
            });
            assert.equal(aliceOnPB.allowed, false, 'cross-property denial');
        } finally { f.cleanup(); }
    });

    /* ---------- group inheritance via L2 ---------- */

    await test('allowed: subject is a member of an editor group', async () => {
        const f = await makeFixture();
        try {
            seedNode(f.nodes, 'alice');
            seedNode(f.nodes, 'editorsGroup');
            seedNode(f.nodes, 'pA');
            await f.store.grant({ subject: 'alice', relation: 'member', resource: 'editorsGroup', grantedBy: 'sys' });
            await f.store.grant({ subject: 'editorsGroup', relation: 'editor', resource: 'pA', grantedBy: 'sys' });

            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);
            const r = await evaluator.check({
                subject: 'alice', action: 'approve_ticket', resource: 'pA', resourceType: 'property',
            });
            assert.equal(r.allowed, true);
        } finally { f.cleanup(); }
    });

    /* ---------- schema mutation ---------- */

    await test('setSchema rebuilds known relations on the fly', async () => {
        const f = await makeFixture();
        try {
            seedNode(f.nodes, 'alice');
            seedNode(f.nodes, 'pA');
            await f.store.grant({ subject: 'alice', relation: 'viewer', resource: 'pA', grantedBy: 'sys' });

            const evaluator = new RebacEvaluator(f.store, PROPERTY_SCHEMA);
            // Original schema does not have a `read` action.
            const r1 = await evaluator.check({
                subject: 'alice', action: 'read', resource: 'pA', resourceType: 'property',
            });
            assert.equal(r1.allowed, false);

            evaluator.setSchema({
                ...PROPERTY_SCHEMA,
                permissions: {
                    property: { ...PROPERTY_SCHEMA.permissions!.property, read: 'viewer | editor | owner' },
                },
            });
            const r2 = await evaluator.check({
                subject: 'alice', action: 'read', resource: 'pA', resourceType: 'property',
            });
            assert.equal(r2.allowed, true);
        } finally { f.cleanup(); }
    });

    /* ---------- L-031: destructive routes gate on 'delete' ---------- */

    console.log('\nL-031 — destructive hard-delete gates on permission:delete');

    function fakeReq(method: string, url?: string, body?: string): IncomingMessage {
        // Minimal req: routes that read a body register a 'data'/'end'
        // handler; emit the body synchronously on subscribe.
        const handlers: Record<string, ((chunk?: unknown) => void)[]> = {};
        return {
            method, url,
            on(event: string, cb: (chunk?: unknown) => void) {
                (handlers[event] ??= []).push(cb);
                if (event === 'end') {
                    if (body !== undefined) for (const d of (handlers['data'] ?? [])) d(Buffer.from(body));
                    cb();
                }
                return this;
            },
        } as unknown as IncomingMessage;
    }
    function fakeRes(): ServerResponse & { _status: number; _body: string } {
        const r = {
            _status: 0, _body: '',
            writeHead(s: number) { (this as { _status: number })._status = s; return this; },
            end(b?: string) { (this as { _body: string })._body = b ?? ''; },
        };
        return r as unknown as ServerResponse & { _status: number; _body: string };
    }
    /** Dataplane fake whose /v1/authz/check grants only the permissions in
     *  `granted`, recording every permission it was asked for. */
    function recordingDataplane(granted: Set<string>) {
        const asked: string[] = [];
        const client = {
            fetch(path: string, init: { body?: string }) {
                if (path === '/v1/authz/check') {
                    const body = init.body ? JSON.parse(init.body) as { permission: string } : { permission: '' };
                    asked.push(body.permission);
                    return Promise.resolve({ success: true, data: { allowed: granted.has(body.permission) } });
                }
                return Promise.resolve({ success: true, data: {} });
            },
        };
        return { client: client as unknown as Parameters<typeof tryNodeDeleteRoute>[4]['dataplane'], asked };
    }
    const CTX = <T>(fn: () => T): T =>
        runWithWorkspace({ workspaceId: 'ws-1' }, () => runWithActor({ portalUserId: 'u1', scopes: [] }, fn));

    await test('DELETE /api/node: write-but-not-delete is refused 403 and the gate asked for delete', async () => {
        const dp = recordingDataplane(new Set(['write'])); // delete NOT granted
        const res = fakeRes();
        await CTX(() => tryNodeDeleteRoute(
            fakeReq('DELETE', '/api/node/n1?workspace=ws-1'), res, '/api/node/n1?workspace=ws-1', '/api/node/n1',
            { deploymentMode: 'cloud', dataplane: dp.client, store: {} as never, auditLog: {} as never } as Parameters<typeof tryNodeDeleteRoute>[4],
        ));
        assert.equal(res._status, 403, `expected 403; got ${res._status}: ${res._body}`);
        assert.deepEqual(dp.asked, ['delete'], 'node hard-delete gate must ask for delete, not write');
    });

    await test('DELETE /api/node: delete-granting principal passes the gate (not 403)', async () => {
        const dp = recordingDataplane(new Set(['write', 'delete']));
        const res = fakeRes();
        // Storage is unwired; once the gate passes the route will 4xx/5xx on
        // the missing graph — we only assert it is NOT a permission 403.
        await CTX(() => tryNodeDeleteRoute(
            fakeReq('DELETE', '/api/node/n1?workspace=ws-1'), res, '/api/node/n1?workspace=ws-1', '/api/node/n1',
            { deploymentMode: 'cloud', dataplane: dp.client, store: { loreGraph: { async deleteNode() { return false; }, async initialize() {} }, loreVerbatim: { async delete() {} } } as never, auditLog: { log() {} } as never } as Parameters<typeof tryNodeDeleteRoute>[4],
        ));
        assert.deepEqual(dp.asked, ['delete'], 'gate asked for delete');
        assert.notEqual(res._status, 403, `delete-granted principal must pass the gate; got ${res._status}: ${res._body}`);
    });

    await test('DELETE /api/edge: write-but-not-delete is refused 403 and the gate asked for delete', async () => {
        const dp = recordingDataplane(new Set(['write']));
        const res = fakeRes();
        const url = '/api/edge?sourceId=a&targetId=b&relation=r&workspace=ws-1';
        await CTX(() => tryEdgesRoutes(
            fakeReq('DELETE', url), res, url, '/api/edge',
            { deploymentMode: 'cloud', dataplane: dp.client, store: {} as never } as Parameters<typeof tryEdgesRoutes>[4],
        ));
        assert.equal(res._status, 403, `expected 403; got ${res._status}: ${res._body}`);
        assert.deepEqual(dp.asked, ['delete'], 'edge hard-delete gate must ask for delete, not write');
    });

    await test('POST /api/nodes/prune hard_delete: write-but-not-delete is refused 403 (delete gate fires after the write gate)', async () => {
        const dp = recordingDataplane(new Set(['write'])); // passes the first write gate, fails the delete gate
        const res = fakeRes();
        const body = JSON.stringify({ workspace: 'ws-1', hard_delete: true, dry_run: false });
        await CTX(() => tryLifecycleRoutes(
            fakeReq('POST', '/api/nodes/prune', body), res, '/api/nodes/prune', '/api/nodes/prune',
            { deploymentMode: 'cloud', dataplane: dp.client, store: {} as never, auxStore: {} as never } as Parameters<typeof tryLifecycleRoutes>[4],
        ));
        assert.equal(res._status, 403, `expected 403; got ${res._status}: ${res._body}`);
        assert.deepEqual(dp.asked, ['write', 'delete'], 'prune asks write first, then delete for hard_delete');
    });

    await test('POST /api/nodes/prune archive (no hard_delete): only the write gate fires, never delete', async () => {
        const dp = recordingDataplane(new Set(['write'])); // archive needs only write
        const res = fakeRes();
        const body = JSON.stringify({ workspace: 'ws-1', dry_run: true }); // archive/soft path, dry run
        await CTX(() => tryLifecycleRoutes(
            fakeReq('POST', '/api/nodes/prune', body), res, '/api/nodes/prune', '/api/nodes/prune',
            { deploymentMode: 'cloud', dataplane: dp.client, store: {} as never, auxStore: {} as never } as Parameters<typeof tryLifecycleRoutes>[4],
        ));
        // The archive path passes the write gate and must NOT request 'delete'.
        assert.deepEqual(dp.asked, ['write'], 'archive must gate on write only, never delete');
        assert.notEqual(res._status, 403, `write-granted archive must pass the gate; got ${res._status}: ${res._body}`);
    });

    /* ---------- summary ---------- */

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('test runner crashed:', err);
    process.exit(1);
});

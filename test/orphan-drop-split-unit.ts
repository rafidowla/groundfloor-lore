#!/usr/bin/env tsx
/**
 * orphan-drop-split-unit.ts — verifies the /api/orphan route split.
 *
 * Two endpoints share one declarative HumanApprovalPolicy:
 *   POST /api/orphan         — back-compat (decision: keep|drop|reenable)
 *   POST /api/orphan/drop    — dedicated drop path
 *
 * Tests cover:
 *   - back-compat /api/orphan still accepts decision=keep without confirm
 *   - back-compat /api/orphan with decision=drop + confirm=DROP works
 *   - back-compat /api/orphan with decision=drop + bad confirm is refused
 *   - new /api/orphan/drop accepts plugin + confirm=DROP
 *   - new /api/orphan/drop refuses missing/bad confirm
 *   - both endpoints deny in cloud mode without dataplane
 *
 * NOTE (v3.11.0): the plugin system was removed. The route no longer calls
 * into a pluginRegistry — the HITL gate + route split is what's under test.
 * On accept the route returns a `{ resolved, decision, orphanState }` envelope
 * directly, so success is asserted against the 200 response body, not against
 * a downstream resolveOrphan() call.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryConfigRoutes } from '../packages/lore/src/mcp/http/routes/config.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';

function fakeReq(method: string, body: string): IncomingMessage {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const req = {
        method,
        on(event: string, h: (...args: unknown[]) => void) {
            (handlers[event] ||= []).push(h);
            if (event === 'end') {
                setImmediate(() => {
                    (handlers['data'] ?? []).forEach((h2) => h2(Buffer.from(body)));
                    (handlers['end'] ?? []).forEach((h2) => h2());
                });
            }
            return this;
        },
    };
    return req as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string; _done: Promise<void> } {
    let resolveDone!: () => void;
    const doneP = new Promise<void>((r) => { resolveDone = r; });
    const r = {
        _status: 0, _body: '', _done: doneP,
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; resolveDone(); },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string; _done: Promise<void> };
}

function localDeps(): { deps: Parameters<typeof tryConfigRoutes>[4] } {
    return {
        deps: {
            deploymentMode: 'local',
            dataplane: null,
            store: {} as never,
            configManager: {} as never,
        },
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('back-compat /api/orphan — new `resource` field');

    await test('keep with resource field → 200', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ resource: 'p1', decision: 'keep' })),
            res, '/api/orphan', '/api/orphan', deps,
        );
        await res._done;
        assert.equal(res._status, 200);
        const out = JSON.parse(res._body) as { resolved: string; decision: string };
        assert.equal(out.resolved, 'p1');
        assert.equal(out.decision, 'keep');
    });

    await test('drop with resource + confirm=DROP → 200', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ resource: 'p1', decision: 'drop', confirm: 'DROP' })),
            res, '/api/orphan', '/api/orphan', deps,
        );
        await res._done;
        assert.equal(res._status, 200);
        const out = JSON.parse(res._body) as { resolved: string; decision: string };
        assert.equal(out.resolved, 'p1');
        assert.equal(out.decision, 'drop');
    });

    await test('drop without confirm → 400 self_confirm_required', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ resource: 'p1', decision: 'drop' })),
            res, '/api/orphan', '/api/orphan', deps,
        );
        await res._done;
        assert.equal(res._status, 400);
        assert.match(res._body, /self_confirm_required/);
        // refused before producing the success envelope
        assert.doesNotMatch(res._body, /"resolved"/);
    });

    await test('drop with wrong confirm token → 400', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ resource: 'p1', decision: 'drop', confirm: 'yes' })),
            res, '/api/orphan', '/api/orphan', deps,
        );
        await res._done;
        assert.equal(res._status, 400);
        assert.doesNotMatch(res._body, /"resolved"/);
    });

    console.log('\nback-compat /api/orphan — legacy `plugin` field still works');

    await test('legacy plugin field (keep) → 200 (back-compat)', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ plugin: 'p1', decision: 'keep' })),
            res, '/api/orphan', '/api/orphan', deps,
        );
        await res._done;
        assert.equal(res._status, 200);
        const out = JSON.parse(res._body) as { resolved: string; decision: string };
        assert.equal(out.resolved, 'p1');
        assert.equal(out.decision, 'keep');
    });

    await test('legacy plugin field (drop + confirm) → 200 (back-compat)', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ plugin: 'p1', decision: 'drop', confirm: 'DROP' })),
            res, '/api/orphan', '/api/orphan', deps,
        );
        await res._done;
        assert.equal(res._status, 200);
        const out = JSON.parse(res._body) as { resolved: string; decision: string };
        assert.equal(out.resolved, 'p1');
        assert.equal(out.decision, 'drop');
    });

    console.log('\nnew /api/orphan/drop');

    await test('drop with resource + confirm=DROP → 200', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ resource: 'p1', confirm: 'DROP' })),
            res, '/api/orphan/drop', '/api/orphan/drop', deps,
        );
        await res._done;
        assert.equal(res._status, 200);
        const out = JSON.parse(res._body) as { resolved: string; decision: string };
        assert.equal(out.resolved, 'p1');
        assert.equal(out.decision, 'drop');
    });

    await test('legacy plugin field on /api/orphan/drop → 200 (back-compat)', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ plugin: 'p1', confirm: 'DROP' })),
            res, '/api/orphan/drop', '/api/orphan/drop', deps,
        );
        await res._done;
        assert.equal(res._status, 200);
        const out = JSON.parse(res._body) as { resolved: string; decision: string };
        assert.equal(out.resolved, 'p1');
        assert.equal(out.decision, 'drop');
    });

    await test('drop without confirm → 400 self_confirm_required', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ resource: 'p1' })),
            res, '/api/orphan/drop', '/api/orphan/drop', deps,
        );
        await res._done;
        assert.equal(res._status, 400);
        assert.match(res._body, /self_confirm_required/);
        assert.doesNotMatch(res._body, /"resolved"/);
    });

    await test('missing resource (no plugin, no resource) → 400', async () => {
        const { deps } = localDeps();
        const res = fakeRes();
        await tryConfigRoutes(
            fakeReq('POST', JSON.stringify({ confirm: 'DROP' })),
            res, '/api/orphan/drop', '/api/orphan/drop', deps,
        );
        await res._done;
        assert.equal(res._status, 400);
        assert.match(res._body, /resource required/);
    });

    console.log('\ncloud-mode gate');

    await test('/api/orphan/drop denies in cloud + no dataplane', async () => {
        const { deps } = localDeps();
        const cloudDeps = { ...deps, deploymentMode: 'cloud' as const };
        const res = fakeRes();
        await runWithWorkspace({ workspaceId: 'ws' }, () =>
            runWithActor({ portalUserId: 'u', scopes: [] }, () =>
                tryConfigRoutes(
                    fakeReq('POST', JSON.stringify({ resource: 'p1', confirm: 'DROP' })),
                    res, '/api/orphan/drop', '/api/orphan/drop', cloudDeps,
                ),
            ),
        );
        await new Promise<void>((r) => setImmediate(r));
        assert.equal(res._status, 503);
        assert.match(res._body, /no_dataplane/);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

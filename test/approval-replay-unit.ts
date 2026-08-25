#!/usr/bin/env tsx
/**
 * approval-replay-unit.ts — replayApprovedOp + InMemoryReplayHandlerRegistry.
 *
 * Drives the pure replay helper against in-memory PendingOp rows and
 * stub handlers. Confirms the three outcomes (executed / no-handler /
 * failed) plus the status precondition + the argsJson decode path +
 * the ctx fields handed to handlers.
 */

import assert from 'node:assert/strict';
import {
    InMemoryReplayHandlerRegistry,
    replayApprovedOp,
    type ReplayContext,
} from '../packages/lore/src/security/approvalReplay.js';
import type { PendingOp } from '../packages/lore/src/security/pendingOps.js';

function makeOp(overrides: Partial<PendingOp> = {}): PendingOp {
    return {
        id: 'op-1',
        operation: 'forget_person',
        workspaceId: 'ws',
        initiator: 'alice',
        argsJson: JSON.stringify({ personId: 'mom', confirm: true }),
        status: 'approved',
        createdAt: '2026-05-10T00:00:00.000Z',
        decidedAt: '2026-05-10T00:01:00.000Z',
        decidedBy: 'admin',
        ...overrides,
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('InMemoryReplayHandlerRegistry');

    await test('register + get returns the handler', () => {
        const reg = new InMemoryReplayHandlerRegistry();
        const h = async () => { /* */ };
        reg.register('op', h);
        assert.equal(reg.get('op'), h);
        assert.equal(reg.get('other'), undefined);
        return Promise.resolve();
    });

    await test('duplicate register throws', () => {
        const reg = new InMemoryReplayHandlerRegistry();
        reg.register('op', async () => { /* */ });
        assert.throws(() => reg.register('op', async () => { /* */ }), /already registered/);
        return Promise.resolve();
    });

    console.log('\nreplayApprovedOp');

    await test('executed: handler runs and receives parsed args + ctx', async () => {
        const reg = new InMemoryReplayHandlerRegistry();
        let received: { args: unknown; ctx: ReplayContext } | null = null;
        reg.register('forget_person', async (args, ctx) => { received = { args, ctx }; });
        const r = await replayApprovedOp(makeOp(), reg);
        assert.equal(r.kind, 'executed');
        assert.deepEqual(received!.args, { personId: 'mom', confirm: true });
        assert.equal(received!.ctx.workspaceId, 'ws');
        assert.equal(received!.ctx.initiator, 'alice');
    });

    await test('no-handler when operation is not registered', async () => {
        const reg = new InMemoryReplayHandlerRegistry();
        const r = await replayApprovedOp(makeOp({ operation: 'unknown_op' }), reg);
        assert.equal(r.kind, 'no-handler');
        if (r.kind === 'no-handler') assert.equal(r.operation, 'unknown_op');
    });

    await test('failed when handler throws — error is surfaced', async () => {
        const reg = new InMemoryReplayHandlerRegistry();
        reg.register('boom', async () => { throw new Error('disk full'); });
        const r = await replayApprovedOp(makeOp({ operation: 'boom' }), reg);
        assert.equal(r.kind, 'failed');
        if (r.kind === 'failed') assert.match(r.error.message, /disk full/);
    });

    await test('refuses to replay non-approved op (defensive guard)', async () => {
        const reg = new InMemoryReplayHandlerRegistry();
        reg.register('op', async () => { /* */ });
        const r = await replayApprovedOp(makeOp({ status: 'pending' }), reg);
        assert.equal(r.kind, 'failed');
        if (r.kind === 'failed') assert.match(r.error.message, /expected 'approved'/);
    });

    await test('refuses to replay already-executed op', async () => {
        const reg = new InMemoryReplayHandlerRegistry();
        reg.register('op', async () => { /* */ });
        const r = await replayApprovedOp(makeOp({ status: 'executed' }), reg);
        assert.equal(r.kind, 'failed');
    });

    await test('refuses to replay rejected op', async () => {
        const reg = new InMemoryReplayHandlerRegistry();
        reg.register('op', async () => { /* */ });
        const r = await replayApprovedOp(makeOp({ status: 'rejected' }), reg);
        assert.equal(r.kind, 'failed');
    });

    await test('failed when argsJson is malformed', async () => {
        const reg = new InMemoryReplayHandlerRegistry();
        let called = false;
        reg.register('op', async () => { called = true; });
        const r = await replayApprovedOp(
            makeOp({ operation: 'op', argsJson: '{not valid json' }),
            reg,
        );
        assert.equal(r.kind, 'failed');
        if (r.kind === 'failed') assert.match(r.error.message, /unparseable argsJson/);
        assert.equal(called, false, 'handler must not run when argsJson is bad');
    });

    await test('handler receiving null args (op enqueued with no args)', async () => {
        const reg = new InMemoryReplayHandlerRegistry();
        let receivedArgs: unknown = 'unset';
        reg.register('op', async (args) => { receivedArgs = args; });
        const r = await replayApprovedOp(
            makeOp({ operation: 'op', argsJson: 'null' }),
            reg,
        );
        assert.equal(r.kind, 'executed');
        assert.equal(receivedArgs, null);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

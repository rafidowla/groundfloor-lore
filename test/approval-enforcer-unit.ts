#!/usr/bin/env tsx
/**
 * approval-enforcer-unit.ts — verifies the three outcomes
 * (`execute`, `self-confirm-required`, `enqueued`) and that the
 * second-party path actually writes to the queue with the right
 * scope + initiator + rationale.
 */

import assert from 'node:assert/strict';
import { enforceApproval } from '../packages/lore/src/security/approvalEnforcer.js';
import { InMemoryPendingOpsStore } from '../packages/lore/src/security/inMemoryPendingOpsStore.js';
import type { HumanApprovalPolicy } from '../packages/lore/src/security/humanApproval.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('enforceApproval — automated tier');

    await test('automated → execute, no queue write', async () => {
        const store = new InMemoryPendingOpsStore();
        const r = await enforceApproval({
            operation: 'list_notes',
            policy: { tier: 'automated' },
            args: {},
            workspaceId: 'ws-1',
            initiator: 'alice',
            pendingOpsStore: store,
        });
        assert.equal(r.kind, 'execute');
        assert.equal((await store.list()).length, 0);
    });

    console.log('\nenforceApproval — self-confirm tier');

    await test('self-confirm without confirm token → self-confirm-required', async () => {
        const store = new InMemoryPendingOpsStore();
        const policy: HumanApprovalPolicy = {
            tier: 'self-confirm',
            rationale: 'destructive: removes all rows for the person',
        };
        const r = await enforceApproval({
            operation: 'forget_person',
            policy, args: {},
            workspaceId: 'ws', initiator: 'alice',
            pendingOpsStore: store,
        });
        assert.equal(r.kind, 'self-confirm-required');
        if (r.kind !== 'self-confirm-required') return;
        assert.equal(r.error.code, 'self_confirm_required');
        assert.equal(r.error.operation, 'forget_person');
        assert.equal(r.error.field, 'confirm');
        assert.match(r.error.message, /destructive: removes all rows/);
        assert.equal((await store.list()).length, 0);
    });

    await test('self-confirm with confirm: true → execute', async () => {
        const store = new InMemoryPendingOpsStore();
        const r = await enforceApproval({
            operation: 'forget_person',
            policy: { tier: 'self-confirm', rationale: 'destructive' },
            args: { confirm: true },
            workspaceId: 'ws', initiator: 'alice',
            pendingOpsStore: store,
        });
        assert.equal(r.kind, 'execute');
    });

    await test('self-confirm with literal confirm token (orphan-drop style)', async () => {
        const store = new InMemoryPendingOpsStore();
        const policy: HumanApprovalPolicy = {
            tier: 'self-confirm',
            confirmToken: 'DROP',
            rationale: 'orphan-drop',
        };
        // wrong token → still gated
        const denied = await enforceApproval({
            operation: 'orphan_drop', policy, args: { confirm: 'yes' },
            workspaceId: 'ws', initiator: 'alice', pendingOpsStore: store,
        });
        assert.equal(denied.kind, 'self-confirm-required');
        if (denied.kind === 'self-confirm-required') {
            assert.equal(denied.error.expected, 'DROP');
        }
        // right token → execute
        const ok = await enforceApproval({
            operation: 'orphan_drop', policy, args: { confirm: 'DROP' },
            workspaceId: 'ws', initiator: 'alice', pendingOpsStore: store,
        });
        assert.equal(ok.kind, 'execute');
    });

    await test('confirmField override is honored', async () => {
        const store = new InMemoryPendingOpsStore();
        const r = await enforceApproval({
            operation: 'op',
            policy: { tier: 'self-confirm', rationale: 'x' },
            args: { iAmSure: true },
            confirmField: 'iAmSure',
            workspaceId: 'ws', initiator: 'alice',
            pendingOpsStore: store,
        });
        assert.equal(r.kind, 'execute');
    });

    console.log('\nenforceApproval — second-party tier');

    await test('second-party → enqueued, queue gets a pending row', async () => {
        const store = new InMemoryPendingOpsStore();
        const policy: HumanApprovalPolicy = {
            tier: 'second-party',
            rationale: 'workspace-wide config edit',
        };
        const r = await enforceApproval({
            operation: 'edit_workspace_config',
            policy,
            args: { setting: 'x', value: 1 },
            workspaceId: 'ws-9',
            initiator: 'alice',
            pendingOpsStore: store,
        });
        assert.equal(r.kind, 'enqueued');
        if (r.kind !== 'enqueued') return;
        assert.equal(r.pendingOp.operation, 'edit_workspace_config');
        assert.equal(r.pendingOp.workspaceId, 'ws-9');
        assert.equal(r.pendingOp.initiator, 'alice');
        assert.equal(r.pendingOp.status, 'pending');
        assert.equal(r.pendingOp.enqueueRationale, 'workspace-wide config edit');
        // L-029 — approverPermission threads end-to-end. Default is 'administer'
        // when the policy doesn't pin a narrower one.
        assert.equal(r.pendingOp.approverPermission, 'administer');
        assert.deepEqual(JSON.parse(r.pendingOp.argsJson), { setting: 'x', value: 1 });
        // Queue actually contains it.
        const rows = await store.list({ status: 'pending' });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, r.pendingOp.id);
        // …and the persisted row carries the same approverPermission.
        assert.equal(rows[0].approverPermission, 'administer');
    });

    await test('second-party → enqueued persists a narrower approverPermission (L-029)', async () => {
        const store = new InMemoryPendingOpsStore();
        const policy: HumanApprovalPolicy = {
            tier: 'second-party',
            rationale: 'membership change',
            approverPermission: 'manage_members',
        };
        const r = await enforceApproval({
            operation: 'invite_member',
            policy,
            args: { user: 'bob' },
            workspaceId: 'ws-9',
            initiator: 'alice',
            pendingOpsStore: store,
        });
        assert.equal(r.kind, 'enqueued');
        if (r.kind !== 'enqueued') return;
        // The decided approverPermission is carried onto the pending row, not
        // silently dropped — so the decision endpoint can enforce the narrower gate.
        assert.equal(r.pendingOp.approverPermission, 'manage_members');
        const rows = await store.list({ status: 'pending' });
        assert.equal(rows[0].approverPermission, 'manage_members');
    });

    await test('second-party preserves args even when nested/large', async () => {
        const store = new InMemoryPendingOpsStore();
        const big = { a: { b: { c: [1, 2, 3] } }, list: [{ k: 'v' }] };
        const r = await enforceApproval({
            operation: 'op',
            policy: { tier: 'second-party', rationale: 'r' },
            args: big,
            workspaceId: 'ws', initiator: 'u',
            pendingOpsStore: store,
        });
        assert.equal(r.kind, 'enqueued');
        if (r.kind !== 'enqueued') return;
        assert.deepEqual(JSON.parse(r.pendingOp.argsJson), big);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

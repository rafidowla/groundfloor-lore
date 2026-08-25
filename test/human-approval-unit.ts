#!/usr/bin/env tsx
/**
 * human-approval-unit.ts — decideApproval policy tests.
 */

import assert from 'node:assert/strict';
import {
    decideApproval,
    formatSelfConfirmError,
    type ApprovalDecision,
    type HumanApprovalPolicy,
} from '../packages/lore/src/security/humanApproval.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('decideApproval');

test('automated → execute regardless of args', () => {
    const policy: HumanApprovalPolicy = { tier: 'automated' };
    const r = decideApproval({ policy, args: { whatever: true } });
    assert.deepEqual(r, { kind: 'execute' } satisfies ApprovalDecision);
});

test('self-confirm with confirm:true (default token) accepts boolean true', () => {
    const policy: HumanApprovalPolicy = { tier: 'self-confirm', rationale: 'destructive' };
    const r = decideApproval({ policy, args: { confirm: true } });
    assert.equal(r.kind, 'execute');
});

test('self-confirm without confirm field → needs-self-confirm', () => {
    const policy: HumanApprovalPolicy = { tier: 'self-confirm', rationale: 'destructive' };
    const r = decideApproval({ policy, args: {} });
    assert.equal(r.kind, 'needs-self-confirm');
    if (r.kind === 'needs-self-confirm') {
        assert.equal(r.field, 'confirm');
        assert.equal(r.expectedToken, true);
    }
});

test('self-confirm with confirm:false → needs-self-confirm', () => {
    const r = decideApproval({
        policy: { tier: 'self-confirm', rationale: 'destructive' },
        args: { confirm: false },
    });
    assert.equal(r.kind, 'needs-self-confirm');
});

test("self-confirm with literal-string token (e.g. 'DROP') only accepts the exact match", () => {
    const policy: HumanApprovalPolicy = {
        tier: 'self-confirm',
        rationale: 'orphan-drop semantics',
        confirmToken: 'DROP',
    };
    assert.equal(decideApproval({ policy, args: { confirm: 'DROP' } }).kind, 'execute');
    assert.equal(decideApproval({ policy, args: { confirm: 'drop' } }).kind, 'needs-self-confirm');
    assert.equal(decideApproval({ policy, args: { confirm: true } }).kind, 'needs-self-confirm');
    assert.equal(decideApproval({ policy, args: {} }).kind, 'needs-self-confirm');
});

test('self-confirm honors confirmField override', () => {
    const policy: HumanApprovalPolicy = { tier: 'self-confirm' };
    const r = decideApproval({ policy, args: { i_understand: true }, confirmField: 'i_understand' });
    assert.equal(r.kind, 'execute');
});

test('second-party → enqueue with default approverPermission=administer', () => {
    const r = decideApproval({
        policy: { tier: 'second-party', rationale: 'workspace deletion' },
        args: { confirm: true }, // confirm token is ignored at this tier
    });
    assert.equal(r.kind, 'enqueue');
    if (r.kind === 'enqueue') assert.equal(r.approverPermission, 'administer');
});

test('second-party with explicit approverPermission=manage_members', () => {
    const r = decideApproval({
        policy: { tier: 'second-party', approverPermission: 'manage_members' },
        args: {},
    });
    assert.equal(r.kind, 'enqueue');
    if (r.kind === 'enqueue') assert.equal(r.approverPermission, 'manage_members');
});

console.log('\nformatSelfConfirmError');

test('formats helpful error for boolean confirm', () => {
    const decision = decideApproval({
        policy: { tier: 'self-confirm', rationale: 'deletes all your nodes' },
        args: {},
    }) as Extract<ApprovalDecision, { kind: 'needs-self-confirm' }>;
    const err = formatSelfConfirmError('forget_person', decision, 'deletes all your nodes');
    assert.equal(err.code, 'self_confirm_required');
    assert.equal(err.operation, 'forget_person');
    assert.equal(err.field, 'confirm');
    assert.match(err.message, /confirm=`true`/);
    assert.match(err.message, /deletes all your nodes/);
});

test('formats error for literal-string confirm', () => {
    const decision = decideApproval({
        policy: { tier: 'self-confirm', confirmToken: 'DROP' },
        args: {},
    }) as Extract<ApprovalDecision, { kind: 'needs-self-confirm' }>;
    const err = formatSelfConfirmError('orphan_drop', decision);
    assert.match(err.message, /confirm=the literal 'DROP'/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

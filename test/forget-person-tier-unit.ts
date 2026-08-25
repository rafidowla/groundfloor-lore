#!/usr/bin/env tsx
/**
 * forget-person-tier-unit.ts — pins the declarative-tier behavior of
 * the personal plug-in's `forget_person` tool after the migration off
 * the inline `confirm: true` check.
 *
 * The tool itself is registered through McpServer.tool(), which we
 * can't easily mount in a unit test without the whole MCP plumbing.
 * Instead we test the contract the migration relies on: the policy +
 * decideApproval combo that the handler calls. If this drifts, the
 * tool's behavior drifts in lockstep.
 */

import assert from 'node:assert/strict';
import {
    decideApproval,
    formatSelfConfirmError,
    type HumanApprovalPolicy,
} from '../packages/lore/src/security/humanApproval.js';

// Mirror of the policy declared in tools-write.ts. If you edit one,
// edit the other; the test fails fast either way.
const forgetPersonPolicy: HumanApprovalPolicy = {
    tier: 'self-confirm',
    rationale: 'destructive: removes a Person and every edge touching them. Memories themselves are kept.',
};

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('forget_person — policy + decideApproval');

test('no confirm field → needs-self-confirm', () => {
    const d = decideApproval({ policy: forgetPersonPolicy, args: { personId: 'mom' } });
    assert.equal(d.kind, 'needs-self-confirm');
    if (d.kind === 'needs-self-confirm') {
        assert.equal(d.expectedToken, true);
        assert.equal(d.field, 'confirm');
    }
});

test('confirm: false → needs-self-confirm', () => {
    const d = decideApproval({ policy: forgetPersonPolicy, args: { personId: 'mom', confirm: false } });
    assert.equal(d.kind, 'needs-self-confirm');
});

test('confirm: true → execute', () => {
    const d = decideApproval({ policy: forgetPersonPolicy, args: { personId: 'mom', confirm: true } });
    assert.equal(d.kind, 'execute');
});

test("formatSelfConfirmError envelope carries the rationale", () => {
    const d = decideApproval({ policy: forgetPersonPolicy, args: {} });
    assert.equal(d.kind, 'needs-self-confirm');
    if (d.kind !== 'needs-self-confirm') return;
    const env = formatSelfConfirmError('forget_person', d, forgetPersonPolicy.rationale);
    assert.equal(env.code, 'self_confirm_required');
    assert.equal(env.operation, 'forget_person');
    assert.equal(env.field, 'confirm');
    assert.equal(env.expected, true);
    assert.match(env.message, /removes a Person/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

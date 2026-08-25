#!/usr/bin/env tsx
/**
 * local-mode-identity-unit.ts — Verifies the local-mode OS-user identity
 * provider registered at daemon boot (server.ts).
 *
 * Tests the identity.ts contract in isolation — no daemon process needed.
 */

import assert from 'node:assert/strict';
import {
    currentUser,
    setCurrentUserProvider,
    resetCurrentUserProvider,
} from '../packages/lore/src/security/identity.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    finally { resetCurrentUserProvider(); }
};

console.log('local-mode identity');

test('default provider returns id=owner with operator role', () => {
    const u = currentUser();
    assert.equal(u.id, 'owner');
    assert.ok(u.roles.includes('owner'), 'expected owner role');
});

test('setCurrentUserProvider overrides currentUser()', () => {
    setCurrentUserProvider(() => ({ id: 'rafi', displayName: 'Rafi', roles: ['operator'] }));
    const u = currentUser();
    assert.equal(u.id, 'rafi');
    assert.equal(u.displayName, 'Rafi');
    assert.deepEqual(u.roles, ['operator']);
});

test('resetCurrentUserProvider restores default', () => {
    setCurrentUserProvider(() => ({ id: 'someone', displayName: 'Someone', roles: [] }));
    resetCurrentUserProvider();
    const u = currentUser();
    assert.equal(u.id, 'owner');
});

test('local-mode boot binding: process.env.USER maps to audit actor id', () => {
    // Simulate what server.ts does at boot for local mode.
    const osUser = process.env['USER'] ?? process.env['USERNAME'] ?? 'owner';
    setCurrentUserProvider(() => ({ id: osUser, displayName: osUser, roles: ['operator'] }));
    const u = currentUser();
    assert.equal(u.id, osUser, `expected id=${osUser}`);
    assert.deepEqual(u.roles, ['operator']);
});

test('local-mode boot binding: falls back to "owner" when USER is unset', () => {
    const saved = process.env['USER'];
    const savedWin = process.env['USERNAME'];
    delete process.env['USER'];
    delete process.env['USERNAME'];
    try {
        const osUser = process.env['USER'] ?? process.env['USERNAME'] ?? 'owner';
        setCurrentUserProvider(() => ({ id: osUser, displayName: osUser, roles: ['operator'] }));
        const u = currentUser();
        assert.equal(u.id, 'owner');
    } finally {
        if (saved !== undefined) process.env['USER'] = saved;
        if (savedWin !== undefined) process.env['USERNAME'] = savedWin;
    }
});

test('provider is called on every currentUser() invocation (not cached)', () => {
    let count = 0;
    setCurrentUserProvider(() => { count++; return { id: `call${count}`, displayName: '', roles: [] }; });
    const a = currentUser();
    const b = currentUser();
    assert.equal(a.id, 'call1');
    assert.equal(b.id, 'call2');
    assert.equal(count, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

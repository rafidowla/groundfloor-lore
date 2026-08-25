#!/usr/bin/env tsx
/**
 * operator-identity-unit.ts — read/write of <LORE_HOME>/operator.json
 * against a tmp dir (no real LORE_HOME touched).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    operatorIdentityPath,
    readOperatorIdentity,
    writeOperatorIdentity,
    clearOperatorIdentity,
    type OperatorIdentity,
} from '../packages/lore/src/security/operatorIdentity.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

function tmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-op-'));
}

function rm(home: string): void {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ }
}

console.log('operatorIdentity');

test('readOperatorIdentity returns null when file is absent', () => {
    const home = tmpHome();
    try {
        assert.equal(readOperatorIdentity(home), null);
    } finally { rm(home); }
});

test('write + read round-trip preserves all fields', () => {
    const home = tmpHome();
    try {
        const ident: OperatorIdentity = {
            portalUserId: 'user_abc',
            displayName: 'Alice',
            scopes: ['admin', 'finance'],
            boundAt: '2026-05-10T12:00:00Z',
            source: 'manual',
        };
        writeOperatorIdentity(ident, home);
        const read = readOperatorIdentity(home);
        assert.deepEqual(read, ident);
    } finally { rm(home); }
});

test('writeOperatorIdentity sets file mode to 0600', () => {
    const home = tmpHome();
    try {
        writeOperatorIdentity({
            portalUserId: 'u', scopes: [], boundAt: 't', source: 'manual',
        }, home);
        const stat = fs.statSync(operatorIdentityPath(home));
        // mask the mode bits to just permissions
        const perm = stat.mode & 0o777;
        assert.equal(perm, 0o600, `expected 0600, got ${perm.toString(8)}`);
    } finally { rm(home); }
});

test('writeOperatorIdentity overwrites an existing file (idempotent re-bind)', () => {
    const home = tmpHome();
    try {
        writeOperatorIdentity({
            portalUserId: 'u1', scopes: [], boundAt: 't1', source: 'manual',
        }, home);
        writeOperatorIdentity({
            portalUserId: 'u2', scopes: ['x'], boundAt: 't2', source: 'manual',
        }, home);
        const read = readOperatorIdentity(home);
        assert.equal(read?.portalUserId, 'u2');
        assert.deepEqual(read?.scopes, ['x']);
    } finally { rm(home); }
});

test('readOperatorIdentity returns null when JSON is malformed', () => {
    const home = tmpHome();
    try {
        fs.writeFileSync(operatorIdentityPath(home), '{ not json');
        assert.equal(readOperatorIdentity(home), null);
    } finally { rm(home); }
});

test('readOperatorIdentity rejects an unknown source value', () => {
    const home = tmpHome();
    try {
        fs.writeFileSync(operatorIdentityPath(home), JSON.stringify({
            portalUserId: 'u', scopes: [], boundAt: 't', source: 'magic',
        }));
        assert.equal(readOperatorIdentity(home), null);
    } finally { rm(home); }
});

test('readOperatorIdentity rejects empty portalUserId', () => {
    const home = tmpHome();
    try {
        fs.writeFileSync(operatorIdentityPath(home), JSON.stringify({
            portalUserId: '', scopes: [], boundAt: 't', source: 'manual',
        }));
        assert.equal(readOperatorIdentity(home), null);
    } finally { rm(home); }
});

test('readOperatorIdentity normalizes a missing scopes field to []', () => {
    const home = tmpHome();
    try {
        fs.writeFileSync(operatorIdentityPath(home), JSON.stringify({
            portalUserId: 'u', boundAt: 't', source: 'manual',
        }));
        const r = readOperatorIdentity(home);
        assert.deepEqual(r?.scopes, []);
    } finally { rm(home); }
});

test('clearOperatorIdentity returns true when the file existed', () => {
    const home = tmpHome();
    try {
        writeOperatorIdentity({
            portalUserId: 'u', scopes: [], boundAt: 't', source: 'manual',
        }, home);
        assert.equal(clearOperatorIdentity(home), true);
        assert.equal(readOperatorIdentity(home), null);
    } finally { rm(home); }
});

test('clearOperatorIdentity returns false when file is absent', () => {
    const home = tmpHome();
    try {
        assert.equal(clearOperatorIdentity(home), false);
    } finally { rm(home); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

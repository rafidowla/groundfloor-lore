#!/usr/bin/env tsx
/**
 * test/schema-change-audit-unit.ts — T4 unit tests
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SchemaChangeAuditLogger,
    type SchemaChangeAuditEntry,
} from '../packages/lore/src/security/schemaChangeAudit.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

function withTmp<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-schema-change-'));
    try { return fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

const NOW = new Date().toISOString();

const BASE: SchemaChangeAuditEntry = {
    at: NOW,
    workspace: 'wsA',
    schemaVersionAfter: 2,
    kind: 'node_type.added',
    target: 'know.Tenant',
    proposedBy: 'ai:gemma-1b',
    approvedBy: 'human:rafi',
    migration: 'lazy',
};

console.log('schema-change audit — T4');

test('append + list', () => {
    withTmp(dir => {
        const log = new SchemaChangeAuditLogger(dir);
        log.append(BASE);
        log.append({ ...BASE, kind: 'field.added', target: 'know.Tenant.ssn', migration: 'lazy' });
        log.append({ ...BASE, kind: 'permission.changed', target: 'know.Tenant.transfer_owner', migration: 'not-applicable' });
        assert.equal(log.list().length, 3);
        assert.equal(log.count(), 3);
    });
});

test('filter by kind', () => {
    withTmp(dir => {
        const log = new SchemaChangeAuditLogger(dir);
        log.append(BASE);
        log.append({ ...BASE, kind: 'field.added', target: 'know.Tenant.ssn' });
        log.append({ ...BASE, kind: 'edge_type.added', target: 'leases' });
        assert.equal(log.list({ kind: 'field.added' }).length, 1);
        assert.equal(log.list({ kind: 'node_type.added' }).length, 1);
    });
});

test('filter by targetPrefix', () => {
    withTmp(dir => {
        const log = new SchemaChangeAuditLogger(dir);
        log.append({ ...BASE, target: 'know.Tenant' });
        log.append({ ...BASE, target: 'know.Lease' });
        log.append({ ...BASE, target: 'mem.Conversation' });
        assert.equal(log.list({ targetPrefix: 'know.' }).length, 2);
        assert.equal(log.list({ targetPrefix: 'mem.' }).length, 1);
    });
});

test('append validates: missing required fields throw', () => {
    withTmp(dir => {
        const log = new SchemaChangeAuditLogger(dir);
        assert.throws(() => log.append({ ...BASE, workspace: '' }), /workspace/);
        assert.throws(() => log.append({ ...BASE, target: '' }), /target/);
        assert.throws(() => log.append({ ...BASE, proposedBy: '' }), /proposedBy/);
        assert.throws(() => log.append({ ...BASE, approvedBy: '' }), /approvedBy/);
    });
});

test('append validates: unknown kind rejected', () => {
    withTmp(dir => {
        const log = new SchemaChangeAuditLogger(dir);
        assert.throws(
            () => log.append({ ...BASE, kind: 'totally.invented' as 'node_type.added' }),
            /unknown schema-change kind/,
        );
    });
});

test('append validates: invalid migration strategy rejected', () => {
    withTmp(dir => {
        const log = new SchemaChangeAuditLogger(dir);
        assert.throws(
            () => log.append({ ...BASE, migration: 'magical' as 'lazy' }),
            /invalid migration strategy/,
        );
    });
});

test('before/after snapshots round-trip', () => {
    withTmp(dir => {
        const log = new SchemaChangeAuditLogger(dir);
        log.append({
            ...BASE,
            kind: 'field.type_changed',
            target: 'know.Tenant.score',
            before: { type: 'string' },
            after: { type: 'number' },
            migration: 'dual-shape',
        });
        const got = log.list()[0];
        assert.deepEqual(got.before, { type: 'string' });
        assert.deepEqual(got.after, { type: 'number' });
        assert.equal(got.migration, 'dual-shape');
    });
});

test('returns empty when no file exists yet', () => {
    withTmp(dir => {
        const log = new SchemaChangeAuditLogger(dir);
        assert.deepEqual(log.list(), []);
        assert.equal(log.count(), 0);
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env tsx
/**
 * test/exception-queue-unit.ts — T8 unit tests
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    ClassificationExceptionQueue,
    type ExceptionQueueEntry,
    type ExceptionResolution,
} from '../packages/lore/src/security/classificationExceptionQueue.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

function withTmp<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-exception-queue-'));
    try { return fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

const NOW = new Date().toISOString();

function entry(id: string, overrides: Partial<ExceptionQueueEntry> = {}): ExceptionQueueEntry {
    return {
        id,
        at: NOW,
        workspace: 'wsA',
        inputFingerprint: `fp:${id}`,
        guess: {
            decidedBy: 'ai:gemma-1b',
            confidence: 0.78,
            proposedKind: 'factual',
            proposedNodeType: 'know.Note',
        },
        ...overrides,
    };
}

console.log('classification exception queue — T8');

/* ---------- enqueue + listOpen ---------- */

test('enqueue + listOpen returns open entries', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        q.enqueue(entry('e1'));
        q.enqueue(entry('e2'));
        const open = q.listOpen();
        assert.equal(open.length, 2);
        assert.equal(open[0].id, 'e1');
    });
});

test('listOpen filters by workspace', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        q.enqueue(entry('e1', { workspace: 'wsA' }));
        q.enqueue(entry('e2', { workspace: 'wsB' }));
        assert.equal(q.listOpen({ workspace: 'wsA' }).length, 1);
        assert.equal(q.listOpen({ workspace: 'wsB' }).length, 1);
    });
});

test('getOpen finds by id, or returns null', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        q.enqueue(entry('e1'));
        assert.ok(q.getOpen('e1'));
        assert.equal(q.getOpen('missing'), null);
    });
});

test('counts: open + resolved', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        q.enqueue(entry('e1'));
        q.enqueue(entry('e2'));
        assert.deepEqual(q.counts(), { open: 2, resolved: 0 });
        q.resolve({
            entryId: 'e1', resolvedAt: NOW, resolvedBy: 'human:rafi',
            decision: 'route', finalKind: 'factual', finalNodeType: 'know.Note',
        });
        assert.deepEqual(q.counts(), { open: 1, resolved: 1 });
    });
});

/* ---------- resolve flows ---------- */

test('resolve: route → moves to resolved with kind+nodeType', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        q.enqueue(entry('e1'));
        const rec = q.resolve({
            entryId: 'e1', resolvedAt: NOW, resolvedBy: 'human:rafi',
            decision: 'route', finalKind: 'factual', finalNodeType: 'know.Note',
            note: 'looks fine to me',
        });
        assert.equal(rec.entry.id, 'e1');
        assert.equal(rec.resolution.decision, 'route');
        assert.equal(q.getOpen('e1'), null);
        const resolved = q.listResolved();
        assert.equal(resolved.length, 1);
        assert.equal(resolved[0].entry.id, 'e1');
    });
});

test('resolve: drop → requires reason', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        q.enqueue(entry('e1'));
        assert.throws(() => q.resolve({
            entryId: 'e1', resolvedAt: NOW, resolvedBy: 'sys', decision: 'drop',
        }), /requires a reason/);
        // Now with a reason it succeeds.
        q.resolve({
            entryId: 'e1', resolvedAt: NOW, resolvedBy: 'sys',
            decision: 'drop', reason: 'duplicate of e0',
        });
        assert.equal(q.counts().open, 0);
        assert.equal(q.counts().resolved, 1);
    });
});

test('resolve: route requires kind+nodeType', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        q.enqueue(entry('e1'));
        assert.throws(() => q.resolve({
            entryId: 'e1', resolvedAt: NOW, resolvedBy: 'human:rafi',
            decision: 'route',
        }), /finalKind.*finalNodeType|requires/);
    });
});

test('resolve: throws when entry not in open queue', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        assert.throws(() => q.resolve({
            entryId: 'missing', resolvedAt: NOW, resolvedBy: 'sys',
            decision: 'route', finalKind: 'factual', finalNodeType: 'know.Note',
        }), /not in open queue/);
    });
});

test('resolve: cannot resolve same entry twice', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        q.enqueue(entry('e1'));
        q.resolve({
            entryId: 'e1', resolvedAt: NOW, resolvedBy: 'sys',
            decision: 'route', finalKind: 'factual', finalNodeType: 'know.Note',
        });
        assert.throws(() => q.resolve({
            entryId: 'e1', resolvedAt: NOW, resolvedBy: 'sys',
            decision: 'route', finalKind: 'factual', finalNodeType: 'know.Note',
        }), /not in open queue/);
    });
});

/* ---------- validation ---------- */

test('enqueue validates required fields', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        assert.throws(() => q.enqueue(entry('', {})), /missing `id`/);
        assert.throws(() => q.enqueue(entry('e', { workspace: '' })), /workspace/);
        assert.throws(() => q.enqueue(entry('e', { inputFingerprint: '' })), /inputFingerprint/);
    });
});

test('listResolved filters by workspace', () => {
    withTmp(dir => {
        const q = new ClassificationExceptionQueue(dir);
        q.enqueue(entry('a', { workspace: 'wsA' }));
        q.enqueue(entry('b', { workspace: 'wsB' }));
        q.resolve({ entryId: 'a', resolvedAt: NOW, resolvedBy: 'sys', decision: 'route', finalKind: 'factual', finalNodeType: 'know.Note' });
        q.resolve({ entryId: 'b', resolvedAt: NOW, resolvedBy: 'sys', decision: 'route', finalKind: 'factual', finalNodeType: 'know.Note' });
        assert.equal(q.listResolved({ workspace: 'wsA' }).length, 1);
        assert.equal(q.listResolved({ workspace: 'wsB' }).length, 1);
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

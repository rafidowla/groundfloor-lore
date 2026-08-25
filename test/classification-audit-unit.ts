#!/usr/bin/env tsx
/**
 * test/classification-audit-unit.ts — T3 unit tests
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    ClassificationAuditLogger,
    type ClassificationAuditEntry,
} from '../packages/lore/src/security/classificationAudit.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${(err as Error).message}`);
        failed++;
    }
}

function withTmp<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-class-audit-'));
    try { return fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

function ts(offsetSec: number = 0): string {
    return new Date(Date.now() + offsetSec * 1000).toISOString();
}

const BASE: ClassificationAuditEntry = {
    at: ts(),
    workspace: 'wsA',
    inputFingerprint: 'fp:abc',
    sourceId: 'filesystem:/tmp/foo.txt',
    connector: 'filesystem',
    decidedBy: 'rule:default-text',
    outcome: 'routed',
    kind: 'factual',
    nodeType: 'note',
};

console.log('classification audit — T3');

test('append + list round-trips', () => {
    withTmp(dir => {
        const log = new ClassificationAuditLogger(dir);
        log.append(BASE);
        log.append({ ...BASE, sourceId: 'filesystem:/tmp/bar.txt', inputFingerprint: 'fp:def' });
        const all = log.list();
        assert.equal(all.length, 2);
        assert.equal(all[0].sourceId, 'filesystem:/tmp/foo.txt');
        assert.equal(all[1].sourceId, 'filesystem:/tmp/bar.txt');
    });
});

test('count tracks entry total', () => {
    withTmp(dir => {
        const log = new ClassificationAuditLogger(dir);
        assert.equal(log.count(), 0);
        log.append(BASE);
        log.append({ ...BASE, inputFingerprint: 'fp:2' });
        log.append({ ...BASE, inputFingerprint: 'fp:3' });
        assert.equal(log.count(), 3);
    });
});

test('list filters by workspace, outcome, decidedByPrefix', () => {
    withTmp(dir => {
        const log = new ClassificationAuditLogger(dir);
        log.append(BASE);
        log.append({ ...BASE, workspace: 'wsB', inputFingerprint: 'fp:b', decidedBy: 'ai:gemma-1b', confidence: 0.62, outcome: 'queued-exception', kind: undefined, nodeType: undefined });
        log.append({ ...BASE, inputFingerprint: 'fp:c', decidedBy: 'ai:gemma-1b', confidence: 0.93 });

        assert.equal(log.list({ workspace: 'wsB' }).length, 1);
        assert.equal(log.list({ outcome: 'queued-exception' }).length, 1);
        assert.equal(log.list({ decidedByPrefix: 'ai:' }).length, 2);
        assert.equal(log.list({ decidedByPrefix: 'rule:' }).length, 1);
    });
});

test('list applies limit', () => {
    withTmp(dir => {
        const log = new ClassificationAuditLogger(dir);
        for (let i = 0; i < 5; i++) {
            log.append({ ...BASE, inputFingerprint: `fp:${i}` });
        }
        assert.equal(log.list({ limit: 3 }).length, 3);
    });
});

test('list filters by sinceIso/untilIso', () => {
    withTmp(dir => {
        const log = new ClassificationAuditLogger(dir);
        const t0 = ts(-100);
        const t1 = ts(0);
        const t2 = ts(100);
        log.append({ ...BASE, at: t0, inputFingerprint: 'a' });
        log.append({ ...BASE, at: t1, inputFingerprint: 'b' });
        log.append({ ...BASE, at: t2, inputFingerprint: 'c' });
        assert.equal(log.list({ sinceIso: t1 }).length, 2);
        assert.equal(log.list({ untilIso: t1 }).length, 2);
        assert.equal(log.list({ sinceIso: t1, untilIso: t1 }).length, 1);
    });
});

test('append validates: AI decision requires confidence', () => {
    withTmp(dir => {
        const log = new ClassificationAuditLogger(dir);
        assert.throws(() => log.append({
            ...BASE,
            decidedBy: 'ai:gemma',
            confidence: undefined,
        }), /confidence/);
    });
});

test('append validates: routed outcome requires kind+nodeType', () => {
    withTmp(dir => {
        const log = new ClassificationAuditLogger(dir);
        assert.throws(() => log.append({
            ...BASE,
            outcome: 'routed',
            kind: undefined,
            nodeType: undefined,
        }), /kind.*nodeType|requires/);
    });
});

test('list returns empty when file does not exist', () => {
    withTmp(dir => {
        const log = new ClassificationAuditLogger(dir);
        // log not yet appended to → no file yet
        assert.deepEqual(log.list(), []);
        assert.equal(log.count(), 0);
    });
});

test('queued-exception outcome valid without kind/nodeType', () => {
    withTmp(dir => {
        const log = new ClassificationAuditLogger(dir);
        log.append({
            ...BASE,
            decidedBy: 'ai:gemma',
            confidence: 0.55,
            outcome: 'queued-exception',
            kind: undefined,
            nodeType: undefined,
        });
        assert.equal(log.list().length, 1);
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}

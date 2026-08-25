#!/usr/bin/env tsx
/**
 * test/multi-master-sync-unit.ts — A7 unit tests
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    ConflictLog,
    MultiMasterMerger,
    type ChangeRecord,
    type NodeState,
} from '../packages/lore/src/engines/multiMasterSync.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

function withTmp<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mmsync-'));
    try { return fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

const empty = (id: string): NodeState => ({ nodeId: id, fields: {}, lastWrite: {} });

const change = (overrides: Partial<ChangeRecord> = {}): ChangeRecord => ({
    nodeId: 'n1',
    field: 'title',
    value: 'hello',
    wallClockMs: 1000,
    lamport: 1,
    deviceId: 'A',
    ...overrides,
});

console.log('multi-master sync — A7');

/* ---------- single change ---------- */

test('first change applies cleanly, no conflict logged', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        const r = merger.applyChange(empty('n1'), change());
        assert.equal(r.kind, 'applied');
        if (r.kind === 'applied') {
            assert.equal(r.nextState.fields.title, 'hello');
            assert.equal(r.conflictsResolved, 0);
        }
        assert.equal(log.count(), 0);
    });
});

/* ---------- LWW: wallclock ---------- */

test('LWW: newer wallclock wins', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        const a = merger.applyChange(empty('n1'), change({ wallClockMs: 1000, deviceId: 'A', value: 'old' }));
        if (a.kind !== 'applied') throw new Error();
        const b = merger.applyChange(a.nextState, change({ wallClockMs: 2000, deviceId: 'B', value: 'new' }));
        assert.equal(b.kind, 'applied');
        if (b.kind === 'applied') {
            assert.equal(b.nextState.fields.title, 'new');
            assert.equal(b.conflictsResolved, 1);
        }
        const conflicts = log.list();
        assert.equal(conflicts.length, 1);
        assert.equal(conflicts[0].rationale, 'wallclock');
    });
});

test('LWW: older wallclock loses, no-op', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        const a = merger.applyChange(empty('n1'), change({ wallClockMs: 2000, value: 'newer' }));
        if (a.kind !== 'applied') throw new Error();
        const b = merger.applyChange(a.nextState, change({ wallClockMs: 1000, value: 'older' }));
        assert.equal(b.kind, 'no-op');
        if (b.kind === 'no-op') assert.equal(b.reason, 'older-than-current');
        // Conflict logged because values differ.
        assert.equal(log.count(), 1);
    });
});

/* ---------- LWW: lamport tiebreak ---------- */

test('LWW: same wallclock, higher lamport wins', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        const a = merger.applyChange(empty('n1'), change({ wallClockMs: 1000, lamport: 5, value: 'A' }));
        if (a.kind !== 'applied') throw new Error();
        const b = merger.applyChange(a.nextState, change({ wallClockMs: 1000, lamport: 7, value: 'B', deviceId: 'B' }));
        assert.equal(b.kind, 'applied');
        if (b.kind === 'applied') {
            assert.equal(b.nextState.fields.title, 'B');
        }
        const c = log.list()[0];
        assert.equal(c.rationale, 'lamport');
    });
});

/* ---------- LWW: device-id tiebreak ---------- */

test('LWW: same wallclock + lamport, higher device-id wins', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        const a = merger.applyChange(empty('n1'), change({ deviceId: 'A', value: 'a' }));
        if (a.kind !== 'applied') throw new Error();
        const b = merger.applyChange(a.nextState, change({ deviceId: 'B', value: 'b' }));
        assert.equal(b.kind, 'applied');
        if (b.kind === 'applied') {
            assert.equal(b.nextState.fields.title, 'b');
        }
        const c = log.list()[0];
        assert.equal(c.rationale, 'device-id');
    });
});

/* ---------- duplicate ---------- */

test('exact duplicate change → no-op, no conflict log', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        const a = merger.applyChange(empty('n1'), change());
        if (a.kind !== 'applied') throw new Error();
        const b = merger.applyChange(a.nextState, change());
        assert.equal(b.kind, 'no-op');
        if (b.kind === 'no-op') assert.equal(b.reason, 'duplicate');
        assert.equal(log.count(), 0);
    });
});

/* ---------- delete ---------- */

test('delete: incoming __delete with newer clock wipes node', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        const a = merger.applyChange(empty('n1'), change({ wallClockMs: 1000, value: 'present' }));
        if (a.kind !== 'applied') throw new Error();
        const del = merger.applyChange(a.nextState, change({
            field: '__delete', value: undefined, wallClockMs: 2000, deviceId: 'B',
        }));
        assert.equal(del.kind, 'applied');
        if (del.kind === 'applied') {
            assert.equal(del.nextState.deleted, true);
            assert.equal(Object.keys(del.nextState.fields).length, 0);
        }
        assert.equal(log.count(), 1);
    });
});

test('delete: incoming __delete with older clock loses', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        const a = merger.applyChange(empty('n1'), change({ wallClockMs: 2000, value: 'present' }));
        if (a.kind !== 'applied') throw new Error();
        const del = merger.applyChange(a.nextState, change({
            field: '__delete', value: undefined, wallClockMs: 1000,
        }));
        assert.equal(del.kind, 'no-op');
        // Conflict logged with rationale.
        assert.equal(log.count(), 1);
    });
});

/* ---------- batch ---------- */

test('applyBatch is order-independent (deterministic merge)', () => {
    withTmp(dir => {
        const log1 = new ConflictLog(path.join(dir, 'order1'));
        const log2 = new ConflictLog(path.join(dir, 'order2'));
        const m1 = new MultiMasterMerger(log1);
        const m2 = new MultiMasterMerger(log2);
        const c1: ChangeRecord = change({ wallClockMs: 1000, deviceId: 'A', value: 'a' });
        const c2: ChangeRecord = change({ wallClockMs: 2000, deviceId: 'B', value: 'b' });
        const c3: ChangeRecord = change({ wallClockMs: 1500, deviceId: 'C', value: 'c' });
        const r1 = m1.applyBatch(empty('n1'), [c1, c2, c3]);
        const r2 = m2.applyBatch(empty('n1'), [c3, c1, c2]);
        assert.deepEqual(r1.state.fields, r2.state.fields);
        // Latest wallclock wins: c2 (wallClockMs=2000, value 'b').
        assert.equal(r1.state.fields.title, 'b');
    });
});

/* ---------- conflict log queries ---------- */

test('conflict log filters by nodeId and limit', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        const a1 = merger.applyChange(empty('n1'), change({ nodeId: 'n1', wallClockMs: 1000, value: 'a' }));
        if (a1.kind !== 'applied') throw new Error();
        merger.applyChange(a1.nextState, change({ nodeId: 'n1', wallClockMs: 2000, value: 'b' }));

        const b1 = merger.applyChange(empty('n2'), change({ nodeId: 'n2', wallClockMs: 1000, value: 'x' }));
        if (b1.kind !== 'applied') throw new Error();
        merger.applyChange(b1.nextState, change({ nodeId: 'n2', wallClockMs: 2000, value: 'y' }));

        assert.equal(log.list({ nodeId: 'n1' }).length, 1);
        assert.equal(log.list({ nodeId: 'n2' }).length, 1);
        assert.equal(log.list({ limit: 1 }).length, 1);
    });
});

/* ---------- mismatched node id ---------- */

test('applyChange with mismatched nodeId throws', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);
        assert.throws(
            () => merger.applyChange(empty('n1'), change({ nodeId: 'OTHER' })),
            /nodeId mismatch/,
        );
    });
});

/* ---------- canonical scenario ---------- */

test('canonical: two-device edit on same field — newer wallclock wins, conflict logged', () => {
    withTmp(dir => {
        const log = new ConflictLog(dir);
        const merger = new MultiMasterMerger(log);

        // Device A edits at t=1000.
        const aWrite: ChangeRecord = {
            nodeId: 'note-1', field: 'body', value: 'A version',
            wallClockMs: 1000, lamport: 1, deviceId: 'phone',
        };
        // Device B edits the same field at t=2000 — last to write wins.
        const bWrite: ChangeRecord = {
            nodeId: 'note-1', field: 'body', value: 'B version',
            wallClockMs: 2000, lamport: 1, deviceId: 'laptop',
        };
        const result = merger.applyBatch(empty('note-1'), [aWrite, bWrite]);
        assert.equal(result.state.fields.body, 'B version');
        assert.equal(result.conflictsResolved, 1);
        const c = log.list()[0];
        assert.equal(c.winner.deviceId, 'laptop');
        assert.equal(c.loser.deviceId, 'phone');
        assert.equal(c.rationale, 'wallclock');
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

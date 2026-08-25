#!/usr/bin/env tsx
/**
 * test/outbox-unit.ts — durable outbox machinery (architecture gap #1).
 *
 * Coverage:
 *   - FileOutboxStore round-trips entries through atomic write-rename
 *   - withOutbox records before handler runs, marks completed on success
 *   - withOutbox leaves the entry unfinished when handler throws
 *   - recovery dispatches pending steps to registered handlers
 *   - recovery is idempotent across re-runs
 *   - recovery surfaces missing-handler + handler-failure as report items
 *   - corrupt outbox file does not crash on read
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { withOutbox } from '../packages/lore/src/outbox/coordinator.js';
import {
    recoverOutbox,
    InMemoryOutboxHandlerRegistry,
} from '../packages/lore/src/outbox/recovery.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

function mkTmp(): { loreDir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-outbox-'));
    return {
        loreDir: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

console.log('outbox');

/* ---------- FileOutboxStore ---------- */

test('record + listUnfinished round-trips an entry', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        await store.record({
            id: 'op-1', operation: 'store_node', initiator: 'human:r',
            createdAt: '2026-05-16T00:00:00Z', updatedAt: '2026-05-16T00:00:00Z',
            steps: [{ kind: 'graph.upsert', status: 'pending' }],
            completed: false,
        });
        const pending = await store.listUnfinished();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].id, 'op-1');
        assert.equal(pending[0].steps[0].status, 'pending');
    } finally { t.cleanup(); }
});

test('markStep updates status + finishedAt', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        await store.record({
            id: 'op-2', operation: 'op', initiator: 'r',
            createdAt: 'x', updatedAt: 'x',
            steps: [{ kind: 'a', status: 'pending' }, { kind: 'b', status: 'pending' }],
            completed: false,
        });
        await store.markStep('op-2', 0, 'done');
        await store.markStep('op-2', 1, 'failed', 'simulated');
        const all = await store.listUnfinished();
        assert.equal(all[0].steps[0].status, 'done');
        assert.equal(all[0].steps[1].status, 'failed');
        assert.equal(all[0].steps[1].error, 'simulated');
        assert.ok(all[0].steps[0].finishedAt);
        assert.ok(all[0].steps[1].finishedAt);
    } finally { t.cleanup(); }
});

test('markCompleted excludes the entry from listUnfinished', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        await store.record({
            id: 'op-3', operation: 'op', initiator: 'r',
            createdAt: 'x', updatedAt: 'x',
            steps: [{ kind: 'a', status: 'done' }],
            completed: false,
        });
        await store.markCompleted('op-3');
        assert.equal((await store.listUnfinished()).length, 0);
    } finally { t.cleanup(); }
});

test('corrupt outbox file is treated as empty', async () => {
    const t = mkTmp();
    try {
        fs.writeFileSync(path.join(t.loreDir, 'outbox.json'), '{not valid');
        const store = new FileOutboxStore(t.loreDir);
        const pending = await store.listUnfinished();
        assert.equal(pending.length, 0);
        // Still writable.
        await store.record({
            id: 'after-corrupt', operation: 'op', initiator: 'r',
            createdAt: 'x', updatedAt: 'x',
            steps: [{ kind: 'a', status: 'pending' }],
            completed: false,
        });
        assert.equal((await store.listUnfinished()).length, 1);
    } finally { t.cleanup(); }
});

/* ---------- withOutbox ---------- */

test('withOutbox records BEFORE handler runs', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        let captured: number = -1;
        await withOutbox(store, {
            id: 'wb-1', operation: 'demo', initiator: 'r',
            steps: [{ kind: 'a' }, { kind: 'b' }],
        }, async ({ markStep }) => {
            // Mid-handler: outbox must already contain this entry.
            const all = await store.listUnfinished();
            captured = all.length;
            await markStep(0, 'done');
            await markStep(1, 'done');
        });
        assert.equal(captured, 1, 'entry was visible mid-handler');
        // After success + default removeOnComplete: entry gone.
        assert.equal((await store.listUnfinished()).length, 0);
    } finally { t.cleanup(); }
});

test('withOutbox leaves entry unfinished when handler throws', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        await assert.rejects(
            withOutbox(store, {
                id: 'wb-2', operation: 'demo', initiator: 'r',
                steps: [{ kind: 'a' }, { kind: 'b' }],
            }, async ({ markStep }) => {
                await markStep(0, 'done');
                throw new Error('boom');
            }),
            /boom/,
        );
        const pending = await store.listUnfinished();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].steps[0].status, 'done');
        assert.equal(pending[0].steps[1].status, 'pending');
    } finally { t.cleanup(); }
});

test('withOutbox leaves entry unfinished if handler succeeds without marking every step', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        // Intentionally forget to mark step 1.
        await withOutbox(store, {
            id: 'wb-3', operation: 'demo', initiator: 'r',
            steps: [{ kind: 'a' }, { kind: 'b' }],
        }, async ({ markStep }) => {
            await markStep(0, 'done');
        });
        const pending = await store.listUnfinished();
        assert.equal(pending.length, 1, 'entry NOT marked completed — recovery picks it up');
    } finally { t.cleanup(); }
});

/* ---------- recovery ---------- */

test('recovery completes a handler that runs to success', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        await store.record({
            id: 'rec-1', operation: 'demo', initiator: 'r',
            createdAt: 'x', updatedAt: 'x',
            steps: [
                { kind: 'graph.upsert', status: 'done' },
                { kind: 'vector.upsert', status: 'pending', payload: { id: 'n1' } },
            ],
            completed: false,
        });
        const reg = new InMemoryOutboxHandlerRegistry();
        let saw: unknown = null;
        reg.register('vector.upsert', async (payload) => { saw = payload; });
        const report = await recoverOutbox(store, reg);
        assert.equal(report.discovered, 1);
        assert.equal(report.completed, 1);
        assert.deepEqual(saw, { id: 'n1' }, 'handler received the step payload');
        assert.equal((await store.listUnfinished()).length, 0);
    } finally { t.cleanup(); }
});

test('recovery flags missing handler without crashing the pass', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        await store.record({
            id: 'rec-2', operation: 'demo', initiator: 'r',
            createdAt: 'x', updatedAt: 'x',
            steps: [{ kind: 'unknown.kind', status: 'pending' }],
            completed: false,
        });
        const reg = new InMemoryOutboxHandlerRegistry();
        const report = await recoverOutbox(store, reg);
        assert.equal(report.completed, 0);
        assert.equal(report.stillUnfinished.length, 1);
        assert.equal(report.stepFailures.length, 1);
        assert.match(report.stepFailures[0].error, /no handler/);
    } finally { t.cleanup(); }
});

test('recovery is idempotent — already-done steps are not re-run', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        await store.record({
            id: 'rec-3', operation: 'demo', initiator: 'r',
            createdAt: 'x', updatedAt: 'x',
            steps: [
                { kind: 'a', status: 'done' },
                { kind: 'b', status: 'pending' },
            ],
            completed: false,
        });
        let aRuns = 0;
        let bRuns = 0;
        const reg = new InMemoryOutboxHandlerRegistry();
        reg.register('a', async () => { aRuns++; });
        reg.register('b', async () => { bRuns++; });
        await recoverOutbox(store, reg);
        assert.equal(aRuns, 0, 'done step not re-run');
        assert.equal(bRuns, 1);
        // Second recovery pass: nothing to do.
        await recoverOutbox(store, reg);
        assert.equal(bRuns, 1, 'recovery is idempotent across passes');
    } finally { t.cleanup(); }
});

test('recovery captures handler-throw and continues to next entry', async () => {
    const t = mkTmp();
    try {
        const store = new FileOutboxStore(t.loreDir);
        await store.record({
            id: 'fail', operation: 'op', initiator: 'r',
            createdAt: 'x', updatedAt: 'x',
            steps: [{ kind: 'flaky', status: 'pending' }],
            completed: false,
        });
        await store.record({
            id: 'good', operation: 'op', initiator: 'r',
            createdAt: 'x', updatedAt: 'x',
            steps: [{ kind: 'solid', status: 'pending' }],
            completed: false,
        });
        const reg = new InMemoryOutboxHandlerRegistry();
        reg.register('flaky', async () => { throw new Error('still down'); });
        reg.register('solid', async () => { /* succeed */ });
        const report = await recoverOutbox(store, reg);
        assert.equal(report.completed, 1, 'good entry finished');
        assert.equal(report.stillUnfinished.length, 1, 'flaky entry still pending');
        assert.match(report.stepFailures[0].error, /still down/);
    } finally { t.cleanup(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

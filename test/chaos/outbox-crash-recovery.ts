#!/usr/bin/env tsx
/**
 * test/chaos/outbox-crash-recovery.ts — proves the outbox completes
 * a two-substrate write that crashed mid-way on the NEXT process's
 * boot recovery, with no data loss.
 *
 * Simulates the specific failure mode: graph upsert succeeds, then
 * the daemon dies BEFORE the vector mirror lands. On the "next boot"
 * (a fresh FileOutboxStore pointed at the same loreDir + recovery
 * pass), the missing mirror is replayed and the workspace ends up
 * consistent.
 *
 * Why this matters: the unit tests (outbox-unit.ts, sync-embedding-
 * unit.ts) cover the individual mechanisms. This test crosses the
 * process boundary — a fresh store loads the on-disk outbox file,
 * dispatches handlers, and proves the durable trail actually works
 * end-to-end.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileOutboxStore } from '../../packages/lore/src/outbox/store.js';
import { withOutbox } from '../../packages/lore/src/outbox/coordinator.js';
import {
    recoverOutbox,
    InMemoryOutboxHandlerRegistry,
} from '../../packages/lore/src/outbox/recovery.js';

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-chaos-outbox-'));
    return { loreDir: dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

console.log('chaos: outbox crash-recovery');

test('crash between graph upsert and vector mirror → next-boot recovery completes it', async () => {
    const t = mkTmp();
    try {
        // === Process 1 "alive" — writes graph, marks done, then dies ===
        const graphRows = new Set<string>(); // simulates Kuzu
        const vectorRows = new Set<string>(); // simulates LanceDB

        const store1 = new FileOutboxStore(t.loreDir);
        let crashed = false;
        try {
            await withOutbox(store1, {
                id: 'crash-test-1',
                operation: 'store_node',
                initiator: 'human:test',
                steps: [
                    { kind: 'graph.upsert', payload: { nodeId: 'n1' } },
                    { kind: 'vector.mirror', payload: { nodeId: 'n1' } },
                ],
            }, async ({ markStep }) => {
                graphRows.add('n1');
                await markStep(0, 'done');
                // SIMULATE CRASH HERE — throw before step 1 finishes.
                crashed = true;
                throw new Error('SIMULATED_CRASH between graph and vector');
            });
        } catch (err) {
            assert.match((err as Error).message, /SIMULATED_CRASH/);
        }
        assert.equal(crashed, true);
        assert.ok(graphRows.has('n1'), 'graph write landed before crash');
        assert.ok(!vectorRows.has('n1'), 'vector write did NOT happen pre-crash');

        // Outbox file should now record one unfinished entry with
        // graph.upsert=done and vector.mirror=pending.
        const preBootCheck = await new FileOutboxStore(t.loreDir).listUnfinished();
        assert.equal(preBootCheck.length, 1);
        assert.equal(preBootCheck[0].steps[0].status, 'done');
        assert.equal(preBootCheck[0].steps[1].status, 'pending');

        // === Process 2 "next boot" — fresh store + recovery ===
        const store2 = new FileOutboxStore(t.loreDir);
        const registry = new InMemoryOutboxHandlerRegistry();
        registry.register('graph.upsert', async () => {
            // Already done in process 1 — recovery skips done steps,
            // this handler should never fire for our entry. Registered
            // anyway to prove that.
            throw new Error('graph.upsert should not re-run');
        });
        registry.register('vector.mirror', async (payload) => {
            const id = (payload as { nodeId: string }).nodeId;
            vectorRows.add(id);
        });

        const report = await recoverOutbox(store2, registry);
        assert.equal(report.discovered, 1);
        assert.equal(report.completed, 1, 'recovery completed the entry');
        assert.equal(report.stillUnfinished.length, 0);
        assert.equal(report.stepFailures.length, 0);

        // Final state: BOTH substrates consistent.
        assert.ok(graphRows.has('n1'));
        assert.ok(vectorRows.has('n1'), 'vector write finally landed on next boot');

        const post = await store2.listUnfinished();
        assert.equal(post.length, 0, 'outbox is clean after successful recovery');
    } finally { t.cleanup(); }
});

test('multiple concurrent crashed writes all recover on next boot', async () => {
    const t = mkTmp();
    try {
        const graphRows = new Set<string>();
        const vectorRows = new Set<string>();

        // Inject 5 in-flight writes, each crashing after graph step.
        const store1 = new FileOutboxStore(t.loreDir);
        for (let i = 0; i < 5; i++) {
            try {
                await withOutbox(store1, {
                    id: `c-${i}`, operation: 'store_node', initiator: 'r',
                    steps: [
                        { kind: 'graph.upsert', payload: { nodeId: `n${i}` } },
                        { kind: 'vector.mirror', payload: { nodeId: `n${i}` } },
                    ],
                }, async ({ markStep }) => {
                    graphRows.add(`n${i}`);
                    await markStep(0, 'done');
                    throw new Error('crash');
                });
            } catch { /* expected */ }
        }
        assert.equal(graphRows.size, 5);
        assert.equal(vectorRows.size, 0);
        assert.equal((await store1.listUnfinished()).length, 5);

        // Recover on "next boot"
        const store2 = new FileOutboxStore(t.loreDir);
        const reg = new InMemoryOutboxHandlerRegistry();
        reg.register('graph.upsert', async () => { throw new Error('should not run'); });
        reg.register('vector.mirror', async (payload) => {
            vectorRows.add((payload as { nodeId: string }).nodeId);
        });
        const report = await recoverOutbox(store2, reg);
        assert.equal(report.completed, 5);
        assert.equal(vectorRows.size, 5, 'all 5 mirrored after recovery');
    } finally { t.cleanup(); }
});

test('handler that throws on recovery does NOT corrupt the outbox; retry next boot succeeds', async () => {
    const t = mkTmp();
    try {
        const store1 = new FileOutboxStore(t.loreDir);
        try {
            await withOutbox(store1, {
                id: 'flaky', operation: 'op', initiator: 'r',
                steps: [{ kind: 'flaky.step' }],
            }, async () => { throw new Error('initial crash'); });
        } catch { /* expected */ }

        // === Boot 1: handler throws ===
        const store2 = new FileOutboxStore(t.loreDir);
        let attempts = 0;
        const regFailing = new InMemoryOutboxHandlerRegistry();
        regFailing.register('flaky.step', async () => {
            attempts++; throw new Error('still down');
        });
        const report1 = await recoverOutbox(store2, regFailing);
        assert.equal(report1.completed, 0);
        assert.equal(report1.stillUnfinished.length, 1);
        assert.equal(attempts, 1);

        // Outbox entry is still present, marked failed (not corrupted).
        const stillThere = await store2.listUnfinished();
        assert.equal(stillThere.length, 1);

        // === Boot 2: handler works now ===
        const store3 = new FileOutboxStore(t.loreDir);
        const regWorking = new InMemoryOutboxHandlerRegistry();
        regWorking.register('flaky.step', async () => { /* succeeds */ });
        const report2 = await recoverOutbox(store3, regWorking);
        assert.equal(report2.completed, 1, 'second boot completes it');
        assert.equal((await store3.listUnfinished()).length, 0);
    } finally { t.cleanup(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

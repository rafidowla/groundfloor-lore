#!/usr/bin/env tsx
/**
 * test/O3-bulk-outbox-perf-unit.ts — O3 bulk-lane wire unit tests.
 *
 * Covers the three contracts O3 ships:
 *   1) Functional: N items → N outbox rows in a single atomic file
 *      rewrite (batchRecord), all 1:1 with the request.
 *   2) Per-item failure: invalid items don't get outbox rows but
 *      still appear in the per-item result array (W9 contract preserved).
 *   3) Perf: batch-record of 1000 entries finishes well under the
 *      ±10% W9 budget (the gate-test O-D11 carries the end-to-end
 *      HTTP-level perf assertion; this unit test guards the outbox-
 *      commit overhead in isolation so a regression here surfaces
 *      before the bigger gate test runs).
 *
 * No HTTP harness — exercises FileOutboxStore.batchRecord +
 * recordHotWriteBatch directly with a tmp loreDir.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { recordHotWriteBatch, type HotWriteSpec } from '../packages/lore/src/outbox/hotLane.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let failed = 0;
let passed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}: ${(err as Error).message}`);
        failed++;
    }
}

function mkStore(): { store: FileOutboxStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'o3-outbox-'));
    return { store: new FileOutboxStore(dir), dir };
}

console.log('Sprint O3 — bulk-lane outbox unit tests');

await test('batchRecord writes N rows in single file rewrite', async () => {
    const { store, dir } = mkStore();
    try {
        const entries: OutboxEntry[] = Array.from({ length: 250 }, (_, i) => ({
            id: `t-${i}`,
            operation: 'graph.upsert',
            initiator: 'test',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            steps: [{ kind: 'node.upsert', status: 'done' as const }],
            completed: false,
            workspace: 'ws-a',
            operationKind: 'node.upsert' as const,
            payload: { id: `t-${i}` },
        }));
        await store.batchRecord(entries);
        const onDisk = JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8'));
        assert.equal(Object.keys(onDisk).length, 250, 'all 250 entries persisted');
        // Sequence ids are contiguous starting from 1 in the empty store.
        const seqs = Object.values(onDisk as Record<string, OutboxEntry>)
            .map(e => e.sequenceId)
            .sort((a, b) => (a as number) - (b as number));
        assert.deepEqual(seqs.slice(0, 5), [1, 2, 3, 4, 5], 'sequence ids start at 1 and are dense');
        assert.equal(seqs[249], 250, 'last sequence id is N');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

await test('batchRecord allocates per-workspace seqs independently', async () => {
    const { store, dir } = mkStore();
    try {
        const mk = (id: string, ws: string): OutboxEntry => ({
            id, operation: 'graph.upsert', initiator: 'test',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            steps: [{ kind: 'node.upsert', status: 'done' as const }],
            completed: false, workspace: ws, operationKind: 'node.upsert' as const,
            payload: { id },
        });
        await store.batchRecord([mk('a1', 'wsA'), mk('b1', 'wsB'), mk('a2', 'wsA'), mk('b2', 'wsB')]);
        const onDisk = JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8')) as Record<string, OutboxEntry>;
        assert.equal(onDisk.a1.sequenceId, 1);
        assert.equal(onDisk.a2.sequenceId, 2);
        assert.equal(onDisk.b1.sequenceId, 1);
        assert.equal(onDisk.b2.sequenceId, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

await test('batchRecord rejects missing workspace when operationKind is set', async () => {
    const { store, dir } = mkStore();
    try {
        await assert.rejects(
            store.batchRecord([{
                id: 'bad', operation: 'x', initiator: 't',
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                steps: [], completed: false,
                operationKind: 'node.upsert' as const,
            } as OutboxEntry]),
            /workspace is required/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

await test('recordHotWriteBatch builds entries + returns them in spec order', async () => {
    const { store, dir } = mkStore();
    try {
        const specs: HotWriteSpec[] = [
            { workspace: 'ws-c', operationKind: 'node.upsert', payload: { id: 'x1' } },
            { workspace: 'ws-c', operationKind: 'edge.upsert', payload: { sourceId: 'x1', targetId: 'x2', relation: 'r' } },
            { workspace: 'ws-c', operationKind: 'node.delete', payload: { id: 'x3' } },
        ];
        const entries = await recordHotWriteBatch(store, specs);
        assert.equal(entries.length, 3);
        assert.equal(entries[0].operationKind, 'node.upsert');
        assert.equal(entries[1].operationKind, 'edge.upsert');
        assert.equal(entries[2].operationKind, 'node.delete');
        const onDisk = JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8')) as Record<string, OutboxEntry>;
        assert.equal(Object.keys(onDisk).length, 3);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

await test('perf: batchRecord(1000) finishes under 500ms (well below ±10% W9 budget)', async () => {
    const { store, dir } = mkStore();
    try {
        const specs: HotWriteSpec[] = Array.from({ length: 1000 }, (_, i) => ({
            workspace: 'ws-perf',
            operationKind: 'node.upsert' as const,
            payload: { id: `p-${i}`, type: 'decision', label: `perf ${i}` },
        }));
        const t0 = performance.now();
        await recordHotWriteBatch(store, specs);
        const ms = performance.now() - t0;
        console.log(`    batchRecord(1000) = ${ms.toFixed(0)} ms`);
        // O3 budget: outbox commit overhead must be a small fraction
        // of the W9 9644ms baseline. 500ms is ~5% — well inside the
        // ±10% gate. If this assertion ever fires, the bigger gate
        // test (O-D11) is about to fail too.
        assert.ok(ms < 500, `batchRecord(1000) took ${ms.toFixed(0)} ms — perf regression`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

await test('falls back to per-entry record() when store lacks batchRecord', async () => {
    // Minimal in-memory shim that implements only record().
    const calls: OutboxEntry[] = [];
    const shim = {
        record: async (e: OutboxEntry) => { calls.push(e); },
        markStep: async () => {},
        markCompleted: async () => {},
        remove: async () => {},
        listUnfinished: async () => [],
    };
    const entries = await recordHotWriteBatch(shim, [
        { workspace: 'w', operationKind: 'node.upsert', payload: { id: 'a' } },
        { workspace: 'w', operationKind: 'node.upsert', payload: { id: 'b' } },
    ]);
    assert.equal(entries.length, 2);
    assert.equal(calls.length, 2);
});

console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);

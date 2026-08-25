#!/usr/bin/env tsx
/**
 * test/fc1-embed-overflow-unit.ts — 2026-08-17 audit finding M2 (cluster 1).
 *
 * Embed-queue overflow silently discarded embeds: enqueue() returned false at
 * capacity, every caller ignored the return value, and the SP-11 onOverflow
 * hook was never wired by any caller — so a shed embed was simply lost, with
 * the sweep-based recovery it pointed at never running in embedded mode.
 *
 * Fixes under test:
 *   - EmbedQueue.onOverflow now carries the job's workspace (needed to route
 *     the durable fallback).
 *   - wireEmbedQueue forwards onOverflow (previously impossible to wire).
 *   - The daemon's wiring (server.ts) re-enqueues shed embeds as durable
 *     outbox embed.batch rows — exercised here at the seam level: queue →
 *     onOverflow → recordHotWriteBatch against a real SqliteOutboxStore.
 *
 * Run: npx tsx test/fc1-embed-overflow-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbedQueue } from '../packages/lore/src/embed/queue.js';
import { wireEmbedQueue } from '../packages/lore/src/embed/wiring.js';
import { recordHotWriteBatch } from '../packages/lore/src/outbox/hotLane.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

async function main() {
    console.log('M2 — embed-queue overflow is no longer a silent drop');

    await test('T1.M2a onOverflow fires with the workspace; enqueue returns false', async () => {
        const drops: Array<{ nodeId: string; text: string; workspace?: string }> = [];
        let releaseGate!: () => void;
        const gate = { promise: new Promise<void>((resolve) => { releaseGate = resolve; }) };
        const queue = new EmbedQueue({ concurrency: 1, maxQueueSize: 1, onOverflow: (d) => drops.push(d) });
        queue.start(async () => { await gate.promise; }); // executor parked until released
        try {
            assert.equal(queue.enqueue('n1', 'text one', 'ws-a'), true, 'first job in flight');
            assert.equal(queue.enqueue('n2', 'text two', 'ws-b'), true, 'second job fills pending (cap 1)');
            assert.equal(queue.enqueue('n3', 'text three', 'ws-c'), false, 'third job overflows');
            assert.equal(drops.length, 1);
            assert.deepEqual(drops[0], { nodeId: 'n3', text: 'text three', workspace: 'ws-c' },
                'the drop payload carries workspace (pre-fix: workspace was lost, fallback could not route)');
            assert.equal(queue.stats().droppedOverflow, 1);
        } finally {
            releaseGate();
            queue.stop();
        }
    });

    await test('T1.M2b wireEmbedQueue forwards onOverflow (was impossible to wire)', async () => {
        const drops: Array<{ nodeId: string; workspace?: string }> = [];
        let releaseGate!: () => void;
        const gate = { promise: new Promise<void>((resolve) => { releaseGate = resolve; }) };
        const blockingGraph = {
            getNode: async () => { await gate.promise; return null; },
        };
        const queue = wireEmbedQueue({
            graph: blockingGraph as never,
            vectorStore: {} as never,
            concurrency: 1,
            onOverflow: (d) => drops.push(d),
        });
        try {
            // default cap is 10_000 pending — exceed it with the executor parked.
            const total = 1 + 10_000 + 1; // 1 in flight + 10_000 pending + 1 overflow
            let falseCount = 0;
            for (let i = 0; i < total; i++) {
                if (!queue.enqueue(`n${i}`, `text ${i}`, i % 2 === 0 ? 'ws-even' : 'ws-odd')) falseCount++;
            }
            assert.equal(falseCount, 1, 'exactly one job overflows');
            assert.equal(drops.length, 1, 'wired onOverflow fired through the factory');
            assert.equal(drops[0]!.workspace, 'ws-odd', 'workspace routed (i=total-1=10001 is odd)');
        } finally {
            releaseGate();
            queue.stop();
        }
    });

    await test('T1.M2c the daemon fallback shape: shed embed becomes a durable outbox embed.batch row', async () => {
        // Mirrors server.ts's onOverflow closure 1:1 (the closure itself needs
        // a full createLore boot; this exercises the same mechanism at its seam).
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc1-overflow-'));
        try {
            const outbox = new SqliteOutboxStore(dir);
            const dropped = { nodeId: 'n-overflow', text: 'shed embed text', workspace: 'ws-b' };
            await recordHotWriteBatch(outbox, [{
                workspace: dropped.workspace,
                operationKind: 'embed.batch',
                payload: { texts: [dropped.text], targetNodeIds: [dropped.nodeId] },
                initiator: 'embedQueue.overflow',
                operation: 'embed.batch',
            }]);
            const pending = await outbox.listPendingForWorkspace!('ws-b', 10);
            assert.equal(pending.length, 1, 'the shed embed is DURABLE, not dropped');
            assert.equal(pending[0]!.operationKind, 'embed.batch');
            const payload = pending[0]!.payload as { texts: string[]; targetNodeIds: string[] };
            assert.deepEqual(payload.targetNodeIds, ['n-overflow']);
            assert.deepEqual(payload.texts, ['shed embed text']);
            outbox.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

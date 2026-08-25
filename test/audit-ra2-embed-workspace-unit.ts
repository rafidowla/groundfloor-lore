#!/usr/bin/env tsx
/**
 * audit-ra2-embed-workspace-unit.ts — re-audit 2026-06-25-reaudit2 (HIGH).
 *
 * The async embed queue's executor read from / wrote to the BOOT workspace's
 * graph + vector store for every job. An import targeting workspace B enqueued
 * into this boot queue, so the executor looked the node up in the boot graph
 * (not found → embed silently SKIPPED) and would have written B's embedding into
 * the boot LanceDB. wireEmbedQueue now resolves a job's workspace to ITS stores.
 */

import assert from 'node:assert/strict';
import { wireEmbedQueue } from '../packages/lore/src/embed/wiring.js';

function fakeGraph(nodes: Record<string, { type?: string }>) {
    return {
        async getNode(id: string) {
            const n = nodes[id];
            return n ? { id, type: n.type ?? 'note', label: id, content: '', tags: '', project: '*', ecosystem: '*', updatedAt: '' } : null;
        },
    } as never;
}
function fakeStore() {
    const stored: string[] = [];
    return { stored, async store(doc: { id: string }) { stored.push(doc.id); } } as { stored: string[] } & never;
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

console.log('RA2 — embed queue routes jobs to their workspace store');

await test('workspace-tagged job embeds into the RESOLVED workspace store, not boot', async () => {
    const bootStore = fakeStore();
    const wsBStore = fakeStore();
    const queue = wireEmbedQueue({
        graph: fakeGraph({}),                       // boot graph has nothing
        vectorStore: bootStore as never,
        resolveStores: async (ws: string) => ws === 'ws-b'
            ? { graph: fakeGraph({ 'n1': {} }), vectorStore: wsBStore as never }
            : null,
    });
    queue.enqueue('n1', 'text-for-b', 'ws-b');
    await queue.drained();
    queue.stop();
    assert.deepEqual((wsBStore as unknown as { stored: string[] }).stored, ['lore:n1'], 'embedded into ws-b store');
    assert.deepEqual((bootStore as unknown as { stored: string[] }).stored, [], 'boot store untouched');
});

await test('untagged job falls back to the boot store (store_node / active-workspace path)', async () => {
    const bootStore = fakeStore();
    const queue = wireEmbedQueue({
        graph: fakeGraph({ 'n2': {} }),
        vectorStore: bootStore as never,
        resolveStores: async () => null,
    });
    queue.enqueue('n2', 'text-for-boot');           // no workspace
    await queue.drained();
    queue.stop();
    assert.deepEqual((bootStore as unknown as { stored: string[] }).stored, ['lore:n2'], 'embedded into boot store');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

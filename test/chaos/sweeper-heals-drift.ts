#!/usr/bin/env tsx
/**
 * test/chaos/sweeper-heals-drift.ts — injects drift between the
 * graph and vector substrates, runs the sweeper, and verifies the
 * gap is closed by the next embed-queue drain.
 *
 * Scenario: someone (bug, sync race, plugin error) wrote nodes to
 * the graph but failed to mirror to the vector store. Without the
 * sweeper, those nodes stay invisible to semantic search forever.
 * With the sweeper, every 30min (or on-demand via runConsistencySweep)
 * the gap is detected + re-enqueued.
 */

import { strict as assert } from 'node:assert';

import { runConsistencySweep } from '../../packages/lore/src/diagnostics/sweeper.js';
import type { GraphReader } from '../../packages/lore/src/diagnostics/consistency.js';
import type { LoreNode } from '../../packages/lore/src/providers/types.js';
import type { VerbatimStore } from '../../packages/lore/src/engines/verbatimStore.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

interface MutableGraph extends GraphReader {
    getNode: (id: string) => Promise<LoreNode | null>;
    add: (n: LoreNode) => void;
    remove: (id: string) => void;
}

function mutableGraph(seed: LoreNode[] = []): MutableGraph {
    const map = new Map<string, LoreNode>(seed.map(n => [n.id, n]));
    return {
        async listNodes() { return Array.from(map.values()); },
        async getNode(id) { return map.get(id) ?? null; },
        add(n) { map.set(n.id, n); },
        remove(id) { map.delete(id); },
    };
}

function mutableVectorStore(seed: string[] = []): VerbatimStore & { add: (id: string) => void; delete: (id: string) => void; ids: () => string[] } {
    const set = new Set<string>(seed);
    return {
        async listIds(prefix?: string) {
            const all = Array.from(set);
            return prefix ? all.filter(id => id.startsWith(prefix)) : all;
        },
        add(id) { set.add(id); },
        delete(id) { set.delete(id); },
        ids() { return Array.from(set); },
    } as unknown as VerbatimStore & { add: (id: string) => void; delete: (id: string) => void; ids: () => string[] };
}

const node = (id: string): LoreNode => ({
    id, type: 't', label: `L${id}`, content: `C${id}`, tags: '',
    project: '', ecosystem: '', metadata: '{}',
    createdAt: '2026-05-17T00:00:00Z', updatedAt: '2026-05-17T00:00:00Z',
    syncedAt: null,
});

console.log('chaos: sweeper heals drift');

test('drift injected after sync: sweeper re-enqueues every missing id', async () => {
    // 10 nodes in graph, 3 missing from vector store (drift)
    const graph = mutableGraph([
        node('a'), node('b'), node('c'), node('d'), node('e'),
        node('f'), node('g'), node('h'), node('i'), node('j'),
    ]);
    const vector = mutableVectorStore([
        'lore:a', 'lore:b', 'lore:c', 'lore:d', 'lore:e',
        'lore:f', 'lore:g',
        // 'h', 'i', 'j' missing — simulated drift
    ]);
    const enqueueCalls: Array<{ id: string; text: string }> = [];
    const embedQueue = {
        enqueue(id: string, text: string) {
            enqueueCalls.push({ id, text });
            // Simulate the executor: actually adds to vector store.
            vector.add(`lore:${id}`);
        },
    };

    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue,
    }, { workspace: 'dev' });

    assert.equal(result.report.missingEmbeddings.length, 3);
    assert.equal(result.enqueuedForReEmbed, 3);
    assert.deepEqual(enqueueCalls.map(c => c.id).sort(), ['h', 'i', 'j']);

    // After the synchronous executor drained, vector should be in sync.
    assert.equal(vector.ids().length, 10);

    // Second sweep on a now-consistent workspace finds nothing.
    const second = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue,
    }, { workspace: 'dev' });
    assert.equal(second.report.hasIssues, false);
    assert.equal(second.enqueuedForReEmbed, 0);
});

test('partial-drift across multiple sweeps converges to consistency', async () => {
    // Realistic: each sweep heals what it sees; new writes between
    // sweeps can introduce new drift; eventually consistent.
    const graph = mutableGraph([node('a'), node('b')]);
    const vector = mutableVectorStore(['lore:a']); // b is missing
    const embedQueue = {
        enqueue: (id: string) => vector.add(`lore:${id}`),
    };

    // Sweep 1: heals b
    await runConsistencySweep({ graph, vectorStore: vector, tableStorage: null, embedQueue }, { workspace: 'dev' });
    assert.equal(vector.ids().length, 2);

    // New write happens (c added to graph, NOT mirrored — drift again)
    graph.add(node('c'));

    // Sweep 2: heals c
    await runConsistencySweep({ graph, vectorStore: vector, tableStorage: null, embedQueue }, { workspace: 'dev' });
    assert.equal(vector.ids().length, 3);

    // Sweep 3: nothing to do
    const final = await runConsistencySweep({ graph, vectorStore: vector, tableStorage: null, embedQueue }, { workspace: 'dev' });
    assert.equal(final.report.hasIssues, false);
});

test('orphan embeddings (vector has, graph doesn\'t) are NEVER deleted by the sweep', async () => {
    // Operator may want orphans preserved as tombstones; the sweeper
    // observes but does not destroy.
    const graph = mutableGraph([node('alive')]);
    const vector = mutableVectorStore(['lore:alive', 'lore:dead-1', 'lore:dead-2']);
    const embedQueue = { enqueue: () => { /* should never be called for orphans */ } };

    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue,
    }, { workspace: 'dev' });

    assert.equal(result.report.orphanEmbeddings.length, 2);
    assert.equal(result.observedButSkipped, 2);
    // The vector store STILL has the orphans — sweep didn't touch them.
    assert.deepEqual(vector.ids().sort(), ['lore:alive', 'lore:dead-1', 'lore:dead-2']);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

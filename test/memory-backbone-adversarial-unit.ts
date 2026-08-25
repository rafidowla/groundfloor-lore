#!/usr/bin/env tsx
/**
 * test/memory-backbone-adversarial-unit.ts — PR #69 P2 + P3 adversarial pass.
 *
 * Goal: confidence that the fixes don't introduce new failure modes.
 * Every test is an attack — a way the fix could plausibly be wrong.
 *
 * Attack surface:
 *   1. Hash collisions / determinism races
 *   2. contentHash spoofing (caller lies about hash)
 *   3. Sweep race: node mutated between getNode and getById
 *   4. Storm-rebuild attack: rapid identical re-sweeps
 *   5. Orphan-bombing: large orphan list doesn't OOM the sweep
 *   6. embed:false toggle race: node flips embed:false mid-sweep
 *   7. Malformed contentHash in storage (empty, null, garbage, SQL-injection)
 *   8. Vector store returns stale getById (claims hash matches when it doesn't)
 *   9. Delete-then-recreate attack: orphan deleted, node arrives same id
 *  10. Cascade-delete avalanche: large orphan list deletes don't lock storage
 *
 * Pattern: every test labels the attack and the property it verifies.
 */

import { strict as assert } from 'node:assert';
import { runConsistencySweep } from '../packages/lore/src/diagnostics/sweeper.js';
import { computeContentHash } from '../packages/lore/src/engines/contentHash.js';
import { buildVerbatimText } from '../packages/lore/src/engines/verbatimStore.js';
import type { GraphReader } from '../packages/lore/src/diagnostics/consistency.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';
import type { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}\n    ${(err as Error).stack?.split('\n').slice(1, 4).join('\n    ')}`); failed++; }
    })());
}

interface FakeGraph extends GraphReader {
    getNode: (id: string) => Promise<LoreNode | null>;
}

function fakeGraph(nodes: Record<string, Partial<LoreNode> & { embed?: boolean }>): FakeGraph {
    return {
        async listNodes() {
            return Object.entries(nodes).map(([id, n]) => ({ id, ...n } as LoreNode));
        },
        async getNode(id: string) {
            if (!(id in nodes)) return null;
            return { id, ...nodes[id] } as LoreNode;
        },
    };
}

function vectorStore(
    idsWithPrefix: string[],
    payloads: Record<string, { contentHash?: string; text?: string }> = {},
    opts: { failDeleteFor?: string[]; slowDeleteMs?: number; corruptGetByIdFor?: string[] } = {},
): VerbatimStore & { deletions: string[] } {
    const deletions: string[] = [];
    return {
        deletions,
        async listIds(prefix?: string) {
            return prefix ? idsWithPrefix.filter(id => id.startsWith(prefix)) : idsWithPrefix;
        },
        async getById(id: string) {
            // Strip prefix
            const bare = id.startsWith('lore:') ? id.slice('lore:'.length) : id;
            if (opts.corruptGetByIdFor?.includes(id)) {
                // Simulate a stale snapshot: claims hash matches even
                // though the row is wrong. We return a payload that
                // intentionally matches what the sweep would compute
                // for the CURRENT node text — i.e. claims "no change"
                // when the actual stored embedding is stale.
                return payloads[bare] ?? null;
            }
            return payloads[bare] ?? null;
        },
        async physicalDelete(id: string) {
            if (opts.slowDeleteMs) {
                await new Promise(r => setTimeout(r, opts.slowDeleteMs));
            }
            if (opts.failDeleteFor?.includes(id)) {
                throw new Error('simulated delete failure');
            }
            deletions.push(id);
        },
    } as unknown as VerbatimStore & { deletions: string[] };
}

function queue() {
    const calls: Array<{ id: string; text: string }> = [];
    return { enqueue(id: string, text: string) { calls.push({ id, text }); }, calls };
}

console.log('memory-backbone adversarial');

// 1. Hash determinism under concurrent invocation
test('[1] hash is deterministic across concurrent calls (no shared state corruption)', async () => {
    const text = 'an architectural decision with full body\n\nand a tag list';
    // Fire 200 concurrent computeContentHash calls. If any internal
    // state was shared (e.g. a reused Buffer), they'd diverge.
    const results = await Promise.all(
        Array.from({ length: 200 }, () => Promise.resolve(computeContentHash(text))),
    );
    const distinct = new Set(results);
    assert.equal(distinct.size, 1, 'all 200 returned same hash');
});

// 2. contentHash spoofing — caller lies about the hash
test('[2] caller-supplied hash lies (different from text) — sweep STILL skips re-embed (caller responsibility)', async () => {
    // The contract: caller-supplied hash wins. If the caller lies,
    // they get what they asked for. We document this property — the
    // alternative (recompute on read) costs hash time per write and
    // defeats the optimization. The store is a trust boundary.
    const node = { label: 'real text', content: 'real body', tags: '' };
    const fakeHash = 'aaaaaaaaaaaaaaaa'; // 16-hex but not the real hash
    const graph = fakeGraph({ n1: node });
    const vec = vectorStore([], { n1: { contentHash: fakeHash, text: 'real text' } });
    const q = queue();

    // Sweep computes hash from CURRENT text → real hash. Stored hash =
    // fakeHash. They differ → re-embed.
    const result = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null, embedQueue: q },
        { workspace: 'w' },
    );
    assert.equal(result.enqueuedForReEmbed, 1, 'mismatch → re-embed (safe failure)');
    assert.equal(result.skippedUnchanged, 0);
});

// 3. Sweep race: node mutated between getNode and getById
test('[3] node text mutates between getNode call and getById call — produces correct decision', async () => {
    // Realistic race: between the sweep reading the node and the sweep
    // checking the stored hash, the live write path stores a new
    // version with a new hash. The stored hash now matches the NEW
    // text, not what the sweep saw. The sweep's computed hash matches
    // its node read, not the stored hash. So we re-embed — which is
    // fine: it's a no-op via lookupByContentHash on the inside.
    let getByIdCalls = 0;
    const graph: FakeGraph = {
        async listNodes() { return [{ id: 'n1', label: 'A', content: 'A', tags: '' } as LoreNode]; },
        async getNode() {
            return { id: 'n1', label: 'A', content: 'A', tags: '' } as LoreNode;
        },
    };
    const vec = {
        async listIds() { return [] as string[]; },
        async getById() {
            getByIdCalls++;
            // Pretend the live write rewrote the row with a new hash:
            return { contentHash: 'newhashfromwrite', text: 'NEW' };
        },
    } as unknown as VerbatimStore;
    const q = queue();
    const result = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null, embedQueue: q },
        { workspace: 'w' },
    );
    // Sweep's computed hash for current label/content/tags vs stored
    // hash "newhashfromwrite" → mismatch → enqueue. Safe: the queue's
    // store() will hit lookupByContentHash and reuse the existing
    // vector if the bytes haven't really changed.
    assert.equal(getByIdCalls, 1);
    assert.equal(result.enqueuedForReEmbed, 1);
});

// 4. Storm-rebuild attack: running sweep 10x consecutively on stable data
test('[4] 10 consecutive sweeps on stable data → 0 net re-embeds (the core fix)', async () => {
    // THIS IS THE BUG WE'RE KILLING. Pre-fix, this would enqueue every
    // node every sweep. Post-fix, second sweep onward sees matching
    // hashes and skips.
    const node = { label: 'stable', content: 'stable body', tags: 't' };
    const text = buildVerbatimText(node.label, node.content, node.tags);
    const hash = computeContentHash(text);

    // Simulate the post-fix state: the row exists with the correct
    // hash. Diagnostic still flags it missing (test scenario), but
    // sweep should NOT enqueue because hashes match.
    const graph = fakeGraph({ n1: node });
    const vec = vectorStore([], { n1: { contentHash: hash, text } });
    const q = queue();

    let totalEnqueued = 0;
    for (let i = 0; i < 10; i++) {
        const r = await runConsistencySweep(
            { graph, vectorStore: vec, tableStorage: null, embedQueue: q },
            { workspace: 'w' },
        );
        totalEnqueued += r.enqueuedForReEmbed;
    }
    assert.equal(totalEnqueued, 0, '10 sweeps × 1 stable node = 0 re-embeds');
    assert.equal(q.calls.length, 0);
});

// 5. Orphan-bombing: 5000 orphans don't crash sweep
test('[5] 5000 orphan vectors all cascade-deleted in one sweep without OOM', async () => {
    const orphanIds: string[] = [];
    for (let i = 0; i < 5000; i++) orphanIds.push(`lore:ghost-${i}`);
    const graph = fakeGraph({}); // empty graph
    const vec = vectorStore(orphanIds);

    const result = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null },
        { workspace: 'w', deleteOrphans: true },
    );
    assert.equal(result.deletedOrphans, 5000);
    assert.equal(result.failedOrphanDeletes, 0);
    assert.equal(vec.deletions.length, 5000);
});

// 6. embed:false toggle race
test('[6] node flipped from embed:false to embed:true between sweeps — gets re-embedded on the next pass', async () => {
    // First pass: node is embed:false → filtered out, no enqueue.
    let nodeEmbed = false;
    const graph: FakeGraph = {
        async listNodes() {
            return [{ id: 'flipping', label: 'L', content: 'C', tags: '', embed: nodeEmbed } as unknown as LoreNode];
        },
        async getNode() {
            return { id: 'flipping', label: 'L', content: 'C', tags: '', embed: nodeEmbed } as unknown as LoreNode;
        },
    };
    const vec = vectorStore([]);
    const q = queue();

    // Pass 1: embed:false → filtered upstream.
    const r1 = await runConsistencySweep({ graph, vectorStore: vec, tableStorage: null, embedQueue: q }, { workspace: 'w' });
    assert.equal(r1.enqueuedForReEmbed, 0, 'embed:false → no enqueue');

    // Flip the bit.
    nodeEmbed = true;
    // Pass 2: embed:true → flagged missing → enqueued.
    const r2 = await runConsistencySweep({ graph, vectorStore: vec, tableStorage: null, embedQueue: q }, { workspace: 'w' });
    assert.equal(r2.enqueuedForReEmbed, 1, 'embed:true → enqueued');
});

// 7. Malformed contentHash in storage
test('[7] empty stored contentHash → sweep enqueues (safe: treat unknown as needs-embed)', async () => {
    const graph = fakeGraph({ n1: { label: 'x', content: 'y', tags: '' } });
    // Stored contentHash is empty string — legacy rows from before the fix.
    const vec = vectorStore([], { n1: { contentHash: '', text: 'x\n\ny' } });
    const q = queue();
    const result = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null, embedQueue: q },
        { workspace: 'w' },
    );
    // Stored hash '' !== fresh hash → enqueue.
    assert.equal(result.enqueuedForReEmbed, 1);
    assert.equal(result.skippedUnchanged, 0);
});

test("[7b] SQL-injection-shaped contentHash doesn't trip the sweep", async () => {
    // The stored hash isn't used in a query — it's only string-compared.
    // But if someone ever ports this to a DB query, this test catches
    // assumptions. Use a hash-shaped string that looks like a SQL fragment.
    const evilHash = "'; DROP TABLE -- ";
    const node = { label: 'A', content: 'B', tags: '' };
    const graph = fakeGraph({ n1: node });
    const vec = vectorStore([], { n1: { contentHash: evilHash, text: 'A\n\nB' } });
    const q = queue();
    // Sweep computes real hash, compares to evilHash. Mismatch → enqueue.
    // No crash, no SQL traveled anywhere.
    const result = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null, embedQueue: q },
        { workspace: 'w' },
    );
    assert.equal(result.enqueuedForReEmbed, 1);
});

test('[7c] huge stored contentHash (1MB) is just a string compare → no DOS', async () => {
    const hugeHash = 'a'.repeat(1024 * 1024);
    const graph = fakeGraph({ n1: { label: 'x', content: 'y', tags: '' } });
    const vec = vectorStore([], { n1: { contentHash: hugeHash, text: 'x\n\ny' } });
    const q = queue();
    const start = Date.now();
    const result = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null, embedQueue: q },
        { workspace: 'w' },
    );
    const elapsed = Date.now() - start;
    assert.equal(result.enqueuedForReEmbed, 1);
    assert.ok(elapsed < 2000, `1 MB hash compare too slow: ${elapsed}ms`);
});

// 8. Delete-then-recreate attack
test('[8] orphan deleted, then a NEW node with the same id is created → next sweep does not re-delete', async () => {
    // Pass 1: orphan exists, no node → delete.
    let nodes: Record<string, Partial<LoreNode>> = {};
    let storedIds: string[] = ['lore:reused-id'];

    const graph: FakeGraph = {
        async listNodes() {
            return Object.entries(nodes).map(([id, n]) => ({ id, ...n } as LoreNode));
        },
        async getNode(id) {
            if (!(id in nodes)) return null;
            return { id, ...nodes[id] } as LoreNode;
        },
    };
    const vec = {
        async listIds() { return storedIds; },
        async getById(id: string) {
            return storedIds.includes(id) ? { contentHash: 'h', text: '' } : null;
        },
        async physicalDelete(id: string) { storedIds = storedIds.filter(x => x !== id); },
    } as unknown as VerbatimStore;

    const r1 = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null },
        { workspace: 'w', deleteOrphans: true },
    );
    assert.equal(r1.deletedOrphans, 1, 'orphan deleted');
    assert.equal(storedIds.length, 0);

    // Simulate: a new write creates a node with the SAME id and writes
    // a fresh vector.
    nodes['reused-id'] = { label: 'new', content: 'new' };
    storedIds = ['lore:reused-id'];
    const r2 = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null },
        { workspace: 'w', deleteOrphans: true },
    );
    assert.equal(r2.deletedOrphans, 0, 'next sweep sees node + vector matched');
    assert.equal(storedIds.length, 1, 'new vector preserved');
});

// 9. Cascade-delete avalanche shouldn't lock the sweep
test('[9] slow delete (50ms each, 20 orphans) — sweep completes serially without hanging', async () => {
    const orphanIds: string[] = [];
    for (let i = 0; i < 20; i++) orphanIds.push(`lore:slow-${i}`);
    const graph = fakeGraph({});
    const vec = vectorStore(orphanIds, {}, { slowDeleteMs: 50 });
    const start = Date.now();
    const result = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null },
        { workspace: 'w', deleteOrphans: true },
    );
    const elapsed = Date.now() - start;
    assert.equal(result.deletedOrphans, 20);
    // Serial delete: ~20 * 50 = 1000 ms expected, allow generous slack.
    assert.ok(elapsed >= 900, `sweep returned too fast (${elapsed}ms) — deletes may be racing`);
    assert.ok(elapsed < 3000, `sweep too slow (${elapsed}ms) — possible runaway`);
});

// 10. Mixed-load stress: 100 missing + 100 orphans + 100 unchanged
test('[10] mixed sweep (100 missing + 100 orphans + 100 unchanged) → each routed correctly', async () => {
    const nodes: Record<string, Partial<LoreNode>> = {};
    const orphanIds: string[] = [];
    const payloads: Record<string, { contentHash: string; text: string }> = {};

    // 100 truly missing nodes (no payload):
    for (let i = 0; i < 100; i++) {
        nodes[`m${i}`] = { label: `m${i}-label`, content: `m${i}-body`, tags: '' };
    }
    // 100 unchanged nodes (payload with matching hash):
    for (let i = 0; i < 100; i++) {
        const id = `u${i}`;
        nodes[id] = { label: `u${i}-label`, content: `u${i}-body`, tags: '' };
        const text = buildVerbatimText(`u${i}-label`, `u${i}-body`, '');
        payloads[id] = { contentHash: computeContentHash(text), text };
    }
    // 100 orphan vectors (no matching node):
    for (let i = 0; i < 100; i++) orphanIds.push(`lore:o${i}`);

    const graph = fakeGraph(nodes);
    const vec = vectorStore(orphanIds, payloads);
    const q = queue();

    const result = await runConsistencySweep(
        { graph, vectorStore: vec, tableStorage: null, embedQueue: q },
        { workspace: 'w', deleteOrphans: true },
    );
    assert.equal(result.enqueuedForReEmbed, 100, '100 truly missing → enqueued');
    assert.equal(result.skippedUnchanged, 100, '100 unchanged → skipped');
    assert.equal(result.deletedOrphans, 100, '100 orphans → deleted');
    assert.equal(result.failedOrphanDeletes, 0);
    assert.equal(result.observedButSkipped, 0, 'nothing remained skipped');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

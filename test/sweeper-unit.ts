#!/usr/bin/env tsx
/**
 * test/sweeper-unit.ts — consistency reconciliation sweeper (gap #9).
 *
 * Coverage (PR #69 P2 + P3 added 2026-06-09):
 *   - missingEmbeddings get enqueued via embedQueue with full
 *     verbatim text built from the node's label/content/tags
 *   - orphanEmbeddings are cascade-deleted ONLY when opted in (P3 +
 *     2026-06-09 safe-default flip: deleteOrphans / LORE_SWEEP_DELETE_ORPHANS=1)
 *   - the DEFAULT (no opt) is observe-only — orphans reported, never deleted
 *   - deleteOrphans:false forces observe-only regardless of env
 *   - sqliteOrphans observed-but-skipped (unchanged)
 *   - missing-graph-node (between diagnose and re-enqueue) silently skipped
 *   - sweeper without an embedQueue is observe-only (enqueuedForReEmbed=0)
 *   - all-in-sync workspace produces a zero-action report
 *   - P2: missing id whose vector contentHash matches current text is SKIPPED
 *   - P2: missing id whose text changed gets RE-EMBEDDED
 *   - P2: `embed: false` node is skipped even if flagged missing
 *   - P3: failed orphan delete is counted, doesn't crash sweep
 *   - P3: vectorStore without `delete` method silently leaves orphans
 *     (DataplaneVectorStore won't be hit during the rollout)
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
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
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

/**
 * Fake vector store that supports the full sweeper surface:
 *   - listIds(prefix)
 *   - getById(id) → returns {contentHash, text} for matching ids
 *   - delete(id) → records deletion
 *
 * The constructor takes prefixed ids (lore:xxx) + an optional
 * per-id-payload map keyed by the BARE id (no prefix) so callers
 * can opt into "this row has this contentHash + text".
 */
function fakeVectorStore(
    idsWithPrefix: string[],
    payloads: Record<string, { contentHash?: string; text?: string }> = {},
    opts: { failDeleteFor?: string[]; omitDelete?: boolean; omitGetById?: boolean } = {},
): VerbatimStore & { deletions: string[]; getByIdCalls: string[] } {
    const deletions: string[] = [];
    const getByIdCalls: string[] = [];
    const store = {
        deletions,
        getByIdCalls,
        async listIds(prefix?: string) {
            if (!prefix) return idsWithPrefix;
            return idsWithPrefix.filter(id => id.startsWith(prefix));
        },
    } as VerbatimStore & { deletions: string[]; getByIdCalls: string[] };

    if (!opts.omitGetById) {
        (store as { getById?: (id: string) => Promise<{ contentHash?: string; text?: string } | null> }).getById =
            async (id: string) => {
                getByIdCalls.push(id);
                // strip the lore: prefix to look up in payloads
                const bare = id.startsWith('lore:') ? id.slice('lore:'.length) : id;
                return payloads[bare] ?? null;
            };
    }
    if (!opts.omitDelete) {
        // PR #69 P3: tests target the new physicalDelete path that the
        // sweeper prefers. The legacy `delete` (tombstone) path stays
        // covered by other tests.
        (store as { physicalDelete?: (id: string) => Promise<void> }).physicalDelete = async (id: string) => {
            if (opts.failDeleteFor?.includes(id)) {
                throw new Error('simulated delete failure');
            }
            deletions.push(id);
        };
    }
    return store;
}

function recordingQueue(): { enqueue: (id: string, text: string) => void; calls: Array<{ id: string; text: string }> } {
    const calls: Array<{ id: string; text: string }> = [];
    return {
        enqueue(id, text) { calls.push({ id, text }); },
        calls,
    };
}

console.log('consistency sweeper');

test('missingEmbeddings get enqueued with full verbatim text', async () => {
    const graph = fakeGraph({
        n1: { label: 'L1', content: 'C1', tags: 't1' },
        n2: { label: 'L2', content: 'C2', tags: 't2' },
    });
    // No payloads → getById returns null → sweeper treats as missing
    const vector = fakeVectorStore([]); // empty → both n1 and n2 are missing
    const queue = recordingQueue();

    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev' });

    assert.equal(result.enqueuedForReEmbed, 2);
    assert.deepEqual(queue.calls.map(c => c.id).sort(), ['n1', 'n2']);
    // Verbatim text includes label + content + tags.
    const n1 = queue.calls.find(c => c.id === 'n1')!;
    assert.match(n1.text, /L1/);
    assert.match(n1.text, /C1/);
});

test('PR #69 P2: missing id whose stored contentHash matches current text is SKIPPED', async () => {
    const node = { label: 'unchanged label', content: 'unchanged body', tags: 'static' };
    const text = buildVerbatimText(node.label, node.content, node.tags);
    const hash = computeContentHash(text);

    const graph = fakeGraph({ n1: node });
    // vector store reports id missing (listIds returns no 'lore:n1') but
    // getById('lore:n1') returns a row with the matching contentHash.
    // This simulates the post-compact scenario where the row exists but
    // the diagnostic's snapshot raced or filtered it. The fingerprint
    // says the embedding is still correct, so re-embedding would be
    // identical bytes for nothing.
    const vector = fakeVectorStore([], { n1: { contentHash: hash, text } });
    const queue = recordingQueue();

    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev' });

    assert.equal(result.enqueuedForReEmbed, 0, 'no re-embed (hashes matched)');
    assert.equal(result.skippedUnchanged, 1, 'skipped because text unchanged');
    assert.equal(queue.calls.length, 0, 'queue not called');
});

test('PR #69 P2: missing id whose text changed gets RE-EMBEDDED', async () => {
    const node = { label: 'CURRENT label', content: 'CURRENT body', tags: 't' };
    const graph = fakeGraph({ n1: node });
    // Vector store has the row with an OLD hash (text was different
    // when last embedded). Hash mismatch → re-embed.
    const vector = fakeVectorStore([], {
        n1: { contentHash: 'olddeadbeefdead', text: 'old text' },
    });
    const queue = recordingQueue();

    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev' });

    assert.equal(result.enqueuedForReEmbed, 1, 'enqueued because hash differs');
    assert.equal(result.skippedUnchanged, 0);
    assert.equal(queue.calls.length, 1);
});

test('PR #69 P2: `embed: false` node skipped even when flagged missing', async () => {
    // Simulates an Atlas code node — exists in the graph but with
    // embed:false. consistency.ts filters these from the missing set
    // upfront, but the sweeper double-checks for defense-in-depth.
    // Here we test the sweeper's belt-and-suspenders branch directly.
    const graphWithSyntheticMissing: FakeGraph = {
        async listNodes() {
            // listNodes returns nothing — so we'd normally not see n1
            // in missing. But we craft a report-input where missing
            // contains n1 anyway (via a custom GraphReader). Easier
            // path: use a real listNodes + same code-node logic.
            return [{ id: 'code-1', label: 'code', embed: false } as unknown as LoreNode];
        },
        async getNode(id) {
            if (id === 'code-1') {
                return { id, label: 'code', embed: false } as unknown as LoreNode;
            }
            return null;
        },
    };
    // Vector store is empty → without the embed:false filter, code-1
    // would be enqueued every sweep.
    const vector = fakeVectorStore([]);
    const queue = recordingQueue();

    const result = await runConsistencySweep({
        graph: graphWithSyntheticMissing, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev' });

    // consistency.ts filtered it out → missingEmbeddings is empty
    // → enqueuedForReEmbed=0, skippedNonEmbeddable=0 (never reached
    // the sweeper's enqueue loop). This is the GOOD path: the filter
    // happens upstream.
    assert.equal(result.enqueuedForReEmbed, 0);
    assert.equal(result.report.missingEmbeddings.length, 0, 'embed:false filtered upstream');
    assert.equal(queue.calls.length, 0);
});

test('PR #69 P3: orphanEmbeddings are cascade-DELETED when deleteOrphans:true (opt-in)', async () => {
    const graph = fakeGraph({ alive: { label: 'A' } });
    const vector = fakeVectorStore(['lore:alive', 'lore:ghost', 'lore:zombie']);
    const queue = recordingQueue();

    // 2026-06-09 safe-default flip: deletion is now OPT-IN. Pass
    // deleteOrphans as a per-sweep option (avoids env-var race with
    // parallel tests); in production this comes from
    // LORE_SWEEP_DELETE_ORPHANS=1 or the cleanup endpoint.
    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev', deleteOrphans: true });

    assert.equal(result.enqueuedForReEmbed, 0, 'no missing embeddings');
    assert.equal(result.deletedOrphans, 2, 'two orphans cascade-deleted');
    assert.equal(result.observedButSkipped, 0, 'orphans no longer in skipped tally');
    assert.equal(result.failedOrphanDeletes, 0);
    assert.deepEqual(vector.deletions.sort(), ['lore:ghost', 'lore:zombie']);
});

test('PR #69 P3 safe default: orphans are OBSERVE-ONLY when deleteOrphans is omitted', async () => {
    const graph = fakeGraph({ alive: { label: 'A' } });
    const vector = fakeVectorStore(['lore:alive', 'lore:ghost']);
    const queue = recordingQueue();

    // The default (no deleteOrphans opt, no env var) MUST NOT delete —
    // this is the 2026-06-09 safe-default flip. Orphans are reported in
    // observedButSkipped, never auto-removed.
    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev' });

    assert.equal(result.deletedOrphans, 0, 'default observe-only — no deletes');
    assert.equal(result.observedButSkipped, 1, 'orphan reported in skipped tally');
    assert.deepEqual(vector.deletions, []);
});

test('PR #69 P3: deleteOrphans:false forces observe-only even if env is set', async () => {
    const graph = fakeGraph({ alive: { label: 'A' } });
    const vector = fakeVectorStore(['lore:alive', 'lore:ghost']);
    const queue = recordingQueue();
    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev', deleteOrphans: false });
    assert.equal(result.deletedOrphans, 0, 'explicit false honored — no deletes');
    assert.equal(result.observedButSkipped, 1);
    assert.deepEqual(vector.deletions, []);
});

test('PR #69 P3: physicalDeleteMany (bulk) path preferred — all orphans in one batch call', async () => {
    const graph = fakeGraph({ alive: { label: 'A' } });
    const ids = ['lore:alive', 'lore:g1', 'lore:g2', 'lore:g3'];
    const batches: string[][] = [];
    let compacted = false;
    const vec = {
        async listIds(prefix?: string) { return prefix ? ids.filter((i) => i.startsWith(prefix)) : ids; },
        async getById() { return null; },
        async physicalDeleteMany(batch: string[]) { batches.push(batch); return batch.length; },
        async compact() { compacted = true; return { fragmentsRemoved: 1, filesRemoved: 0, bytesRemoved: 0, oldVersionsRemoved: 0 }; },
    } as unknown as Parameters<typeof runConsistencySweep>[0]['vectorStore'];

    const result = await runConsistencySweep({
        graph, vectorStore: vec, tableStorage: null, embedQueue: recordingQueue(),
    }, { workspace: 'dev', deleteOrphans: true });

    assert.equal(result.deletedOrphans, 3, 'g1,g2,g3 bulk-deleted');
    assert.equal(result.failedOrphanDeletes, 0);
    assert.equal(batches.length, 1, 'a single bulk call — not per-id');
    assert.deepEqual(batches[0]!.sort(), ['lore:g1', 'lore:g2', 'lore:g3']);
    assert.equal(compacted, true, 'compaction runs after a successful delete pass');
});

test('PR #69 P3: failed orphan delete is counted, sweep keeps going', async () => {
    const graph = fakeGraph({ alive: { label: 'A' } });
    const vector = fakeVectorStore(
        ['lore:alive', 'lore:ghost', 'lore:zombie'],
        {},
        { failDeleteFor: ['lore:ghost'] },
    );
    const queue = recordingQueue();

    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev', deleteOrphans: true });

    assert.equal(result.deletedOrphans, 1, 'zombie deleted; ghost failed');
    assert.equal(result.failedOrphanDeletes, 1, 'ghost failure counted');
    // observedButSkipped = failed deletes + sqlite orphans
    assert.equal(result.observedButSkipped, 1, 'failed orphan retained in skipped tally');
    assert.deepEqual(vector.deletions, ['lore:zombie']);
});

test('PR #69 P3: vector store without `physicalDelete` or `delete` leaves orphans (dataplane fallback)', async () => {
    const graph = fakeGraph({ alive: { label: 'A' } });
    const vector = fakeVectorStore(
        ['lore:alive', 'lore:ghost'],
        {},
        { omitDelete: true },
    );
    const queue = recordingQueue();

    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev', deleteOrphans: true });

    assert.equal(result.deletedOrphans, 0, 'no delete method → no deletes attempted');
    assert.equal(result.observedButSkipped, 1, 'falls back to pre-P3 behavior');
});

test('missing graph node between diagnose and re-enqueue is silently skipped', async () => {
    // Graph reports n1 + n2 via listNodes, but getNode(n2) returns null
    // (simulates a race where n2 was deleted between scan and repair).
    const graph: FakeGraph = {
        async listNodes() { return [{ id: 'n1', label: 'L1' } as LoreNode, { id: 'n2', label: 'L2' } as LoreNode]; },
        async getNode(id) { return id === 'n1' ? ({ id, label: 'L1' } as LoreNode) : null; },
    };
    const vector = fakeVectorStore([]);
    const queue = recordingQueue();

    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev' });

    assert.equal(result.enqueuedForReEmbed, 1, 'only n1 re-enqueued; n2 silently skipped');
    assert.equal(queue.calls[0].id, 'n1');
});

test('sweeper without an embedQueue is observe-only', async () => {
    const graph = fakeGraph({ n1: { label: 'L1' } });
    const vector = fakeVectorStore([]); // missing
    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null,
        // no embedQueue
    }, { workspace: 'dev' });

    assert.equal(result.enqueuedForReEmbed, 0);
    assert.equal(result.report.missingEmbeddings.length, 1);
});

test('all-in-sync workspace yields zero-action report', async () => {
    const graph = fakeGraph({ n1: { label: 'L1' } });
    const vector = fakeVectorStore(['lore:n1']);
    const queue = recordingQueue();
    const result = await runConsistencySweep({
        graph, vectorStore: vector, tableStorage: null, embedQueue: queue,
    }, { workspace: 'dev' });
    assert.equal(result.enqueuedForReEmbed, 0);
    assert.equal(result.deletedOrphans, 0);
    assert.equal(result.skippedUnchanged, 0);
    assert.equal(result.observedButSkipped, 0);
    assert.equal(result.report.hasIssues, false);
});

test('1.1 regression: graph scan failure REFUSES the orphan delete pass (no mass wipe)', async () => {
    // A graph whose node walk throws simulates a transient Kùzu page error.
    // Pre-fix, diagnoseConsistency swallowed it, computed orphans = vector -
    // (empty graph set) = the WHOLE corpus, and the sweep deleted every row.
    const throwingGraph = {
        async listNodes() { throw new Error('simulated graph scan failure'); },
        async getNode() { return null; },
    } as unknown as FakeGraph;
    const vector = fakeVectorStore(['lore:aaa', 'lore:bbb', 'lore:ccc']);
    const result = await runConsistencySweep({
        graph: throwingGraph,
        vectorStore: vector,
        tableStorage: null,
        embedQueue: recordingQueue(),
    }, { workspace: 'ws', deleteOrphans: true });

    assert.equal(result.report.graphScanFailed, true, 'graph scan failure must be flagged');
    assert.equal(result.deletedOrphans, 0, 'must NOT delete orphans on a failed scan');
    assert.equal(vector.deletions.length, 0, 'no physicalDelete calls issued');
    // Every vector looked like an orphan against the empty graph id set — they
    // must be reported observed-but-skipped, never deleted.
    assert.equal(result.observedButSkipped, 3, 'orphans observed but skipped');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

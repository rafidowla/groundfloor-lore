#!/usr/bin/env tsx
/**
 * test/sweep-recall-e2e-unit.ts — PR #69 P3 end-to-end against real
 * LanceDB: after the sweep cascade-deletes an orphan vector, that row
 * must no longer surface in search/recall.
 *
 * Why this test exists:
 *   The thorough cross-surface validation workflow flagged this as a
 *   real coverage gap: sweeper-unit asserts physicalDelete is called,
 *   and memory-backbone-integration I-6 asserts listIds drops the row,
 *   but no test runs the full pipeline:
 *     (1) store node with embedding,
 *     (2) graph node removed (simulates a delete),
 *     (3) sweep runs → cascade-deletes the orphan,
 *     (4) search() called → row must not appear.
 *
 *   That last hop is what an end-user-visible regression would look
 *   like: a vector that should be gone still shows up in recall.
 *   The cascade-delete is correct only if the search side is also
 *   correct (cache invalidation, search-cache epoch bump). This test
 *   exercises that contract.
 *
 * What this pins:
 *   E1. store(text-a) → search(text-a) finds id `lore:a`.
 *   E2. node a removed from graph, b still present → sweep deletes
 *       lore:a as orphan, leaves lore:b alone.
 *   E3. After sweep, search(text-a) returns NO result for `lore:a`.
 *       (The vector must be physically gone, not just tombstoned;
 *       tombstones would still show in listIds and could leak into
 *       search depending on filter semantics.)
 *   E4. search(text-b) still returns `lore:b` — sweep didn't over-delete.
 *
 * Uses the same deterministic mock embedder + temp LanceDB pattern
 * from test/memory-backbone-integration.ts.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { runConsistencySweep } from '../packages/lore/src/diagnostics/sweeper.js';
import type { EmbeddingProvider, LoreNode } from '../packages/lore/src/providers/types.js';
import type { GraphReader } from '../packages/lore/src/diagnostics/consistency.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/**
 * Deterministic 16-dim embedder. Two distinct inputs produce orthogonal
 * vectors so the search disambiguates them cleanly.
 */
class DeterministicEmbedder implements EmbeddingProvider {
    readonly modelId = 'deterministic-mock';
    readonly dimension = 16;
    async initialize() { /* no-op */ }
    async embedDocument(text: string) { return this.vec(text); }
    async embedQuery(text: string) { return this.vec(text); }
    async embedDocumentBatch(texts: string[]) { return texts.map(t => this.vec(t)); }
    private vec(text: string): number[] {
        const v = new Array(16).fill(0);
        for (let i = 0; i < text.length; i++) v[i % 16] += text.charCodeAt(i) / 1000;
        const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map(x => x / mag);
    }
}

function fakeGraph(nodes: Record<string, Partial<LoreNode>>): GraphReader & { getNode: (id: string) => Promise<LoreNode | null> } {
    return {
        async listNodes() {
            return Object.entries(nodes).map(([id, n]) => ({ id, ...n } as LoreNode));
        },
        async getNode(id: string) {
            return id in nodes ? ({ id, ...nodes[id] } as LoreNode) : null;
        },
    };
}

console.log('\n=== sweep → recall end-to-end (real LanceDB) ===\n');

test('E1+E2+E3+E4: orphan cascade-delete actually removes vector from search results', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-pr69-sweeprecall-'));
    const store = new VerbatimStore(dir, new DeterministicEmbedder());
    try {
        await store.initialize();

        // E1 — store two distinct nodes.
        const textA = 'apple architecture decision body alpha';
        const textB = 'banana bug pattern body bravo';
        await store.store({
            id: 'lore:a',
            text: textA,
            metadata: {
                type: 'decision', label: 'A', tags: '',
                project: '*', ecosystem: '*',
                updatedAt: '2026-06-09', security_scopes: [],
            },
        });
        await store.store({
            id: 'lore:b',
            text: textB,
            metadata: {
                type: 'bug_pattern', label: 'B', tags: '',
                project: '*', ecosystem: '*',
                updatedAt: '2026-06-09', security_scopes: [],
            },
        });

        // Both visible in listIds.
        const idsBefore = await store.listIds('lore:');
        assert.ok(idsBefore.includes('lore:a'), 'E1: lore:a present pre-sweep');
        assert.ok(idsBefore.includes('lore:b'), 'E1: lore:b present pre-sweep');

        // E1 — search(textA) hits lore:a.
        const beforeA = await store.search(textA, 5);
        const beforeAIds = beforeA.map(r => r.id);
        assert.ok(beforeAIds.includes('lore:a'), `E1: search(textA) MUST find lore:a; got ${beforeAIds.join(', ')}`);

        // E2 — graph now has only b. Sweep should classify a as orphan.
        const graph = fakeGraph({ b: { label: 'B' } });

        const vectorStoreView = {
            listIds: (prefix?: string) => store.listIds(prefix),
            getById: (id: string) => store.getById(id),
            physicalDelete: (id: string) => store.physicalDelete(id),
            // Bulk path (2026-06-09) — the sweep prefers physicalDeleteMany,
            // so expose it here to exercise the batched id-IN delete against
            // REAL LanceDB end-to-end.
            physicalDeleteMany: (ids: string[]) => store.physicalDeleteMany(ids),
            // B (2026-06-09) — expose compact so the sweep exercises its
            // compact-after-delete wiring against REAL LanceDB. Returns
            // OptimizeStats; the sweep ignores the value (best-effort).
            compact: () => store.compact(),
        };

        // deleteOrphans:true — opt-in (the default is observe-only after the
        // 2026-06-09 safe-default flip). This also triggers compact() above.
        const result = await runConsistencySweep(
            { graph, vectorStore: vectorStoreView, tableStorage: null },
            { workspace: 'e2e', deleteOrphans: true },
        );

        assert.equal(result.deletedOrphans, 1, `E2: exactly one orphan cascade-deleted; got ${result.deletedOrphans}`);
        assert.equal(result.failedOrphanDeletes, 0);

        // E3 — search(textA) MUST return nothing for lore:a.
        // We allow other ids if any happened to match (unlikely with our
        // deterministic embedder + distinct inputs) — what matters is
        // that lore:a does NOT come back. This is the user-visible
        // contract: deleted vectors disappear from recall.
        const afterA = await store.search(textA, 5);
        const afterAIds = afterA.map(r => r.id);
        assert.ok(
            !afterAIds.includes('lore:a'),
            `E3: search(textA) MUST NOT return the cascade-deleted lore:a; got ${afterAIds.join(', ')}. ` +
            `This is the regression that would let a "deleted" vector haunt recall — exactly the PR #69 P3 bug.`,
        );

        // listIds also confirms physical removal (defense-in-depth).
        const idsAfter = await store.listIds('lore:');
        assert.ok(!idsAfter.includes('lore:a'), 'E3: lore:a physically removed from listIds');

        // E4 — search(textB) still finds lore:b.
        const afterB = await store.search(textB, 5);
        const afterBIds = afterB.map(r => r.id);
        assert.ok(
            afterBIds.includes('lore:b'),
            `E4: sweep MUST NOT over-delete; lore:b should still be searchable. Got ${afterBIds.join(', ')}`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

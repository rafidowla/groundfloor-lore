#!/usr/bin/env tsx
/**
 * test/nodeupsert-concurrent-split-brain-unit.ts — regression for the
 * cross-substrate split-brain in `core/nodeService.ts`'s `nodeUpsert()`
 * under concurrent same-id writes.
 *
 * The bug (confirmed by execution against the real production stack with
 * injected jitter): `nodeUpsert()` has 3 externally-visible write steps —
 * (1) outbox `node.upsert` record, (2) `targetGraph.upsertNode`, (3)
 * verbatim/vector fan-out. Only step 2 was serialized per id (and only on
 * `SurrealGraph`, via its private `nodeWriteChain`). Steps 1 and 3 ran
 * completely unserialized relative to each other and to step 2's ordering,
 * so two concurrent same-id `nodeUpsert()` calls could commit their graph
 * writes in one order and their verbatim writes in the OPPOSITE order — the
 * graph ends up holding one caller's content while the verbatim/search
 * mirror durably holds the OTHER caller's stale content, with BOTH callers
 * seeing `{ ok: true }`.
 *
 * The fix: `nodeService.ts` now holds a module-level `KeyedMutex`
 * (`nodeUpsertLock`) keyed by `workspace + id` that wraps the WHOLE step
 * 1-3 sequence, forcing one strict, shared order across all three
 * substrates for a given id.
 *
 * Reproduction shape (real production stack, no mocks): a real
 * `SurrealGraph` (embedded SurrealDB), a real `VerbatimStore` (LanceDB,
 * constant-vector embedder — no model load), and a real `FileOutboxStore`,
 * wired through `nodeUpsert()` exactly as `outboxStore` + `inlineVerbatim`
 * (the cloud-primary-write shape `applyVerbatimFanout` documents — outbox
 * durability write PLUS a synchronous inline verbatim write). Jitter is
 * injected on the verbatim-write step: the FIRST call whose verbatim write
 * arrives is delayed, so — pre-fix — the SECOND call's (faster) verbatim
 * write can land first and then get overwritten by the delayed first
 * write, even though the graph's last writer is the opposite call. Which
 * literal call (A/B) arrives first is tracked at runtime, not assumed, so
 * the repro does not depend on winning any particular scheduling race.
 *
 * Run: npx tsx test/nodeupsert-concurrent-split-brain-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/** Constant-vector embedder: avoids loading a real model. */
class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'split-brain-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

// Plain `new Promise` executor — `Promise.withResolvers` is not on this
// package's TS lib target (see surrealConnection.ts's identical note).
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('\nnodeUpsert concurrent same-id split-brain — outer per-(workspace,id) lock regression\n');

test('two concurrent nodeUpsert() for the SAME id: final graph content and final verbatim content agree', async () => {
    const g = mkTmp('lore-splitbrain-g-');
    const v = mkTmp('lore-splitbrain-v-');
    const o = mkTmp('lore-splitbrain-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    try {
        await graph.initialize();
        await store.initialize();

        const id = 'split-brain-node';
        const workspace = 'w';

        // Jitter: the FIRST call whose verbatim write REACHES the store is,
        // under the pre-fix code, the call whose GRAPH write landed first —
        // and therefore the one whose content the LATER, second graph write
        // (same-id UPDATE, forced by SurrealGraph's own per-id
        // nodeWriteChain) overwrites. Delaying that first verbatim arrival
        // lets the second call's (faster) verbatim write land ahead of it,
        // so the LAST verbatim writer ends up being the call whose content
        // the graph no longer holds — the split-brain. Order is tracked at
        // runtime, not assumed, so the repro doesn't depend on which
        // literal call (A/B) wins any particular race.
        let verbatimArrivalOrder = 0;
        const inlineVerbatim = {
            verbatimStore: async (w: { id: string; text: string; metadata: Record<string, unknown> }) => {
                const myOrder = verbatimArrivalOrder++;
                if (myOrder === 0) await delay(75);
                return store.store(w);
            },
        };

        // `Promise.all([...])` evaluates its array left-to-right, so the
        // 'A' call's nodeUpsert() synchronous prefix (through lock
        // acquisition) runs strictly before the 'B' call's — which literal
        // call finishes LAST (and therefore wins both substrates) is a
        // property of the fix under test, not assumed here.
        const [resA, resB] = await Promise.all([
            nodeUpsert(
                {
                    id, workspace, ecosystem: '*', initiator: 'test:A',
                    nodeData: { id, type: 'note', label: 'A', content: 'content-A', tags: ['t'], security_scopes: [] as string[] },
                    targetGraph: graph,
                },
                { outboxStore, inlineVerbatim },
            ),
            nodeUpsert(
                {
                    id, workspace, ecosystem: '*', initiator: 'test:B',
                    nodeData: { id, type: 'note', label: 'B', content: 'content-B', tags: ['t'], security_scopes: [] as string[] },
                    targetGraph: graph,
                },
                { outboxStore, inlineVerbatim },
            ),
        ]);
        if (!resA.ok) throw new Error(`call A must succeed: ${resA.error.message}`);
        if (!resB.ok) throw new Error(`call B must succeed: ${resB.error.message}`);

        const graphNode = await graph.getNode(id);
        assert.ok(graphNode, 'graph node must exist after both writes');
        const winner = graphNode.label; // 'A' or 'B' — whichever write landed last in the graph.
        const loser = winner === 'A' ? 'B' : 'A';

        const verbatimRow = await store.getById(`lore:${id}`);
        assert.ok(verbatimRow, 'verbatim row must exist after both writes');
        const verbatimText = verbatimRow.text ?? '';

        // The regression this test pins down: pre-fix, this could read
        // `content-<loser>` while the graph read `content-<winner>` — a
        // durable cross-substrate disagreement both callers saw as
        // `ok: true`. Post-fix, ONE lock covers steps 1-3 for both calls,
        // so whichever call's graph write is LAST is also whichever call's
        // verbatim write is LAST — they cannot diverge.
        assert.equal(
            verbatimText.includes(`content-${winner}`),
            true,
            `split-brain reproduced: graph holds "${winner}" but verbatim row is "${verbatimText}"`,
        );
        assert.equal(
            verbatimText.includes(`content-${loser}`),
            false,
            `split-brain reproduced: verbatim row carries the graph-stale loser ("${loser}")'s content`,
        );
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

test('N=8 concurrent nodeUpsert() for the SAME id: graph and verbatim agree on the same final writer', async () => {
    const g = mkTmp('lore-splitbrain-n8-g-');
    const v = mkTmp('lore-splitbrain-n8-v-');
    const o = mkTmp('lore-splitbrain-n8-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    try {
        await graph.initialize();
        await store.initialize();

        const id = 'split-brain-node-n8';
        const workspace = 'w';
        const N = 8;

        // Every call's verbatim write jitters a random 0-30ms so the writes
        // arrive in an order unrelated to call-issue order — an adversarial
        // shuffle of step 3 relative to step 2 across all N calls.
        const inlineVerbatim = {
            verbatimStore: async (w: { id: string; text: string; metadata: Record<string, unknown> }) => {
                await delay(Math.random() * 30);
                return store.store(w);
            },
        };

        const results = await Promise.all(Array.from({ length: N }, (_, i) => nodeUpsert(
            {
                id, workspace, ecosystem: '*', initiator: `test:n8-${i}`,
                nodeData: { id, type: 'note', label: String(i), content: `content-${i}`, tags: ['t'], security_scopes: [] as string[] },
                targetGraph: graph,
            },
            { outboxStore, inlineVerbatim },
        )));
        for (const r of results) {
            if (!r.ok) throw new Error(`every concurrent call must succeed: ${r.error.message}`);
        }

        const graphNode = await graph.getNode(id);
        assert.ok(graphNode, 'graph node must exist');
        const verbatimRow = await store.getById(`lore:${id}`);
        assert.ok(verbatimRow, 'verbatim row must exist');
        const verbatimText = verbatimRow.text ?? '';

        assert.equal(
            verbatimText.includes(`content-${graphNode.label}`),
            true,
            `split-brain: graph's last writer was label "${graphNode.label}" but verbatim text is "${verbatimText}"`,
        );
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

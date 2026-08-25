#!/usr/bin/env tsx
/**
 * test/nw1d-upsertnode-toctou-unit.ts — NW-1d regression unit.
 *
 * Closes audit finding `conc-upsertnode-toctou-no-write-serialization`.
 *
 * What this pins down
 * ───────────────────
 * `SurrealGraph.upsertNode` does `getNode(id) → branch CREATE-vs-SET`.
 * Without write serialization, two concurrent same-id upserts both
 * observe `existingNode === null` (getNode is memoized on
 * workspace/epoch/id, so both racers can read the SAME cached null),
 * both take the CREATE branch, and the second collides on the
 * `LoreNode.id` unique key — surfaced as a thrown `LoreGraphError`.
 *
 * Adversarial setup
 * ─────────────────
 * Fire N=50 concurrent `upsertNode({id: 'x', label: 'L' + i})` calls
 * via `Promise.all`. Acceptance:
 *  - NO call rejects (no `LoreGraphError`, no UNIQUE-violation).
 *  - Final state has EXACTLY ONE node with id 'x'.
 *  - Its `label` is one of the inputs (last-writer-wins is fine — we
 *    don't constrain WHICH of L0..L49 won, just that the row exists
 *    and is well-formed).
 *
 * On base (before NW-1d) this test reliably fails on the CREATE/CREATE
 * race. On branch it passes because `KeyedMutex.run(nodeData.id, …)`
 * forces same-id calls into FIFO order: the second `getNode` runs
 * only after the first CREATE commits, so it sees the row and takes
 * the SET branch.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

async function withGraph<T>(fn: (g: SurrealGraph) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-nw1d-'));
    const graph = new SurrealGraph(dir);
    await graph.initialize();
    try {
        return await fn(graph);
    } finally {
        await graph.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

console.log('NW-1d · upsertNode TOCTOU — concurrent same-id race');

async function run() {
    await test('50 concurrent same-id upsertNode calls produce exactly one node, no UNIQUE error', async () => {
        await withGraph(async graph => {
            const N = 50;
            const id = 'x';

            const calls: Array<Promise<unknown>> = [];
            for (let i = 0; i < N; i++) {
                calls.push(graph.upsertNode({
                    id,
                    type: 'decision',
                    label: 'L' + i,
                    content: 'content-' + i,
                    tags: [],
                    project: null,
                    ecosystem: null,
                    metadata: {},
                }));
            }

            // On base, at least one of these settles with rejected
            // (UNIQUE / PK collision). `allSettled` lets us assemble
            // a clear diagnostic showing the failure shape.
            const results = await Promise.allSettled(calls);
            const rejections = results.filter(r => r.status === 'rejected');
            if (rejections.length > 0) {
                const first = rejections[0] as PromiseRejectedResult;
                const msg = (first.reason instanceof Error)
                    ? first.reason.message
                    : String(first.reason);
                assert.fail(
                    `expected zero rejections from N=${N} concurrent upsertNode(${id}) ` +
                    `calls; got ${rejections.length}. First failure: ${msg}`,
                );
            }

            const node = await graph.getNode(id);
            assert.ok(node, 'expected exactly one node with id "x" to exist');
            assert.equal(node!.id, id);
            assert.ok(
                /^L\d+$/.test(node!.label),
                `label "${node!.label}" should be one of L0..L${N - 1}`,
            );

            // Hydrating by id MUST return exactly one row — duplicate-create
            // on base would surface as a row count > 1 here.
            const hits = await graph.getNodesByIds([id]);
            assert.equal(hits.size, 1, `expected exactly 1 row for id "${id}", got ${hits.size}`);
            assert.ok(hits.get(id), 'expected the hydrated map to contain id "x"');
        });
    });

    // Independence smoke — KeyedMutex does NOT block independent ids.
    // Two distinct-id upserts queued in order on the same chain entry
    // would be a regression. We measure that the map drains to zero
    // size after a couple of distinct-id calls settle.
    await test('KeyedMutex keys distinct ids independently (post-run map drains)', async () => {
        const { KeyedMutex } = await import('../packages/lore/src/engines/writeQueue.js');
        const km = new KeyedMutex();
        let aDone = false; let bDone = false;
        await Promise.all([
            km.run('a', async () => { aDone = true; }),
            km.run('b', async () => { bDone = true; }),
        ]);
        assert.equal(aDone, true);
        assert.equal(bDone, true);
        assert.equal(km.size(), 0, 'KeyedMutex map should drain to 0 after tails settle');
    });

    // Same-key ordering — second op observes the first's result before
    // it runs. Pins the contract used by upsertNode's TOCTOU fix.
    await test('KeyedMutex same-key ops run strictly FIFO', async () => {
        const { KeyedMutex } = await import('../packages/lore/src/engines/writeQueue.js');
        const km = new KeyedMutex();
        const trace: string[] = [];
        const op = (tag: string, ms: number) => async () => {
            trace.push('start:' + tag);
            await new Promise(r => setTimeout(r, ms));
            trace.push('end:' + tag);
        };
        await Promise.all([
            km.run('k', op('A', 30)),
            km.run('k', op('B', 5)),
            km.run('k', op('C', 5)),
        ]);
        assert.deepEqual(trace, [
            'start:A', 'end:A',
            'start:B', 'end:B',
            'start:C', 'end:C',
        ], 'same-key ops must serialize strictly FIFO');
    });

    // A predecessor's rejection must NOT poison the next op for the
    // same key. The next op gets to run; its caller observes its own
    // outcome. The predecessor's caller still observes the rejection.
    await test('KeyedMutex predecessor rejection does not propagate to next op', async () => {
        const { KeyedMutex } = await import('../packages/lore/src/engines/writeQueue.js');
        const km = new KeyedMutex();
        const first = km.run('k', async () => { throw new Error('boom'); });
        const second = km.run('k', async () => 42);
        await assert.rejects(first, /boom/, 'first caller observes its rejection');
        assert.equal(await second, 42, 'second caller is not poisoned by first');
    });
}

run().then(() => {
    console.log(`\nNW-1d: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}).catch(err => {
    console.error('NW-1d harness crashed:', err);
    process.exit(2);
});

#!/usr/bin/env tsx
/**
 * test/bidirectional-edge-selfloop-unit.ts — regression pin for a
 * KeyedMutex self-loop deadlock in `addBidirectionalEdge`, found 2026-09-18
 * while investigating an unrelated outbox-replicator hang.
 *
 * ── The defect this pins ────────────────────────────────────────────────
 *
 * `addBidirectionalEdge` locks a forward key (`src|tgt|relation`) and a
 * reverse key (`tgt|src|relation`) as two NESTED `KeyedMutex.run()` calls,
 * ordered so two callers always take the pair in the same order. For a
 * SELF-LOOP edge (`sourceId === targetId`, same relation) the forward and
 * reverse keys are the IDENTICAL string, so the "outer" and "inner" calls
 * both target that one key. `KeyedMutex.run(key, op)`
 * (engines/writeQueue.ts) stores the in-flight promise for `key` BEFORE its
 * op settles, so the inner call's lookup reads back the OUTER call's own
 * still-pending promise and chains onto it — the outer can't resolve until
 * the inner op runs, and the inner op can't start until the outer's own
 * promise (its predecessor) resolves. Permanent deadlock.
 *
 * SurrealGraph and SqliteGraph both had this (SqliteGraph copied the
 * pattern verbatim when it was built for 3.21). Fixed in
 * engines/graphShared/bidirectionalEdgeLock.ts: when the two keys collide,
 * take ONE lock instead of two nested ones.
 *
 * ── What is asserted, on BOTH engines (LORE_TEST_GRAPH_ENGINE) ─────────
 *
 *   A. `addBidirectionalEdge(a, a, relation)` (a genuine self-loop)
 *      resolves within a bound instead of hanging, and both directions
 *      (there is only one, since src===tgt) are queryable afterward.
 *   B. Per-triple serialization survives the fix: a normal (non-self-loop)
 *      `addBidirectionalEdge` still serializes against a concurrent
 *      `addEdge` on the SAME triple — the slow op's effect is not
 *      clobbered by the fast one racing past it.
 *
 * Run: npx tsx test/bidirectional-edge-selfloop-unit.ts
 *      LORE_TEST_GRAPH_ENGINE=sqlite npx tsx test/bidirectional-edge-selfloop-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTestGraphEngine, testGraphEngineName } from './helpers/testGraphEngine.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not resolve within ${ms}ms — likely deadlocked`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function node(id: string): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return { id, type: 'decision', label: `L ${id}`, content: `C ${id}`, tags: [], project: 'p', ecosystem: 'e', metadata: '{}' };
}

async function main(): Promise<void> {
    console.log(`bidirectional-edge-selfloop-unit — engine=${testGraphEngineName()}`);

    await test('addBidirectionalEdge(a, a, relation) — a genuine self-loop — resolves (does not deadlock)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selfloop-'));
        try {
            const g = createTestGraphEngine(dir, { cacheDisabled: true });
            await g.initialize();
            await g.upsertNode(node('a'));

            await withTimeout(
                g.addBidirectionalEdge({ sourceId: 'a', targetId: 'a', relation: 'related_to' }),
                10_000,
                'addBidirectionalEdge(a, a, ...)',
            );

            const edges = await g.queryEdges({ source: 'a', limit: 10, offset: 0 });
            assert.equal(edges.length, 1, `expected exactly one self-loop edge, got ${JSON.stringify(edges)}`);
            assert.equal(edges[0]!.sourceId, 'a');
            assert.equal(edges[0]!.targetId, 'a');
            assert.equal(edges[0]!.relation, 'related_to');

            // A second call on the SAME self-loop key must also complete —
            // pins that the fix doesn't leave the key's chain wedged after
            // the first call (which the deadlock, pre-fix, would have).
            await withTimeout(
                g.addBidirectionalEdge({ sourceId: 'a', targetId: 'a', relation: 'related_to' }),
                10_000,
                'second addBidirectionalEdge(a, a, ...)',
            );
            await g.close().catch(() => undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await test('a normal addBidirectionalEdge still serializes against a concurrent addEdge on the SAME triple', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-selfloop-serialize-'));
        try {
            const g = createTestGraphEngine(dir, { cacheDisabled: true });
            await g.initialize();
            await g.upsertNode(node('x'));
            await g.upsertNode(node('y'));

            // Fire both concurrently. Whichever wins, the SECOND writer to
            // actually run must observe the first one's effect already
            // applied (proof they ran strictly one-after-the-other, not
            // interleaved) — that only holds if both still take the same
            // per-triple lock after the fix.
            const order: string[] = [];
            const bidi = g.addBidirectionalEdge({ sourceId: 'x', targetId: 'y', relation: 'refers_to' })
                .then(() => { order.push('bidi'); });
            const single = g.addEdge({ sourceId: 'x', targetId: 'y', relation: 'refers_to' })
                .then(() => { order.push('single'); });

            await withTimeout(Promise.all([bidi, single]), 10_000, 'concurrent bidi+single on the same triple');
            assert.equal(order.length, 2, `both writers must complete, got ${JSON.stringify(order)}`);

            // Forward edge exists exactly once regardless of interleave order
            // (addEdge is an upsert-shaped write in both engines).
            const forward = await g.queryEdges({ source: 'x', limit: 10, offset: 0 });
            const matches = forward.filter((e) => e.targetId === 'y' && e.relation === 'refers_to');
            assert.equal(matches.length, 1, `expected exactly one x->y edge, got ${JSON.stringify(matches)}`);

            // The reverse edge (bidi's half) must also have landed — proof
            // the bidirectional call's SECOND addEdge (the reverse) was not
            // dropped by interleaving with the concurrent single addEdge.
            const reverse = await g.queryEdges({ source: 'y', limit: 10, offset: 0 });
            const reverseMatches = reverse.filter((e) => e.targetId === 'x' && e.relation === 'refers_to');
            assert.equal(reverseMatches.length, 1, `expected exactly one y->x reverse edge, got ${JSON.stringify(reverseMatches)}`);
            await g.close().catch(() => undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

await main();

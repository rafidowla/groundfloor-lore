#!/usr/bin/env tsx
/**
 * call-tally-unit.ts — the per-instance operation counter, and its cost.
 *
 * Exists because Phase 7 could not answer "what does Atlas ask Lore for?".
 * Lore's audit log records writes only; the tool-dispatch log sees only calls
 * arriving through Lore's own MCP server, and an embedded host bypasses that
 * entirely. The mix had to be inferred from Atlas's source instead of measured.
 *
 * Two things need proving, and the second is the one that would quietly not be
 * true: that the counts are RIGHT, and that counting is cheap enough to leave
 * on. "No measurable write cost" is a claim, so it is measured here rather than
 * asserted in a comment.
 *
 * Run: npx tsx test/call-tally-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CallTally, callTallyEnabled, shapeDepth, shapeLimit } from '../packages/lore/src/engines/callTally.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

function node(id: string): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id, type: 'decision', label: `L ${id}`, content: `C ${id}`,
        tags: ['t'], project: 'p', ecosystem: 'e', metadata: '{}',
    };
}

console.log('Atlas enablement — per-instance call tally');

/* ─── the counter itself ─────────────────────────────────────────── */

await test('counts operations and breaks them down by shape', () => {
    const t = new CallTally(true);
    t.record('listNodes', shapeLimit(undefined, true));
    t.record('listNodes', shapeLimit(10));
    t.record('listNodes', shapeLimit(10));
    t.record('traverse', shapeDepth(3));
    const snap = t.snapshot();
    assert.equal(snap.total, 4);
    const list = snap.entries.find((e) => e.op === 'listNodes')!;
    assert.equal(list.count, 3);
    assert.deepEqual(list.shapes, { 'limit=unbounded': 1, 'limit<=10': 2 });
    assert.equal(snap.entries.find((e) => e.op === 'traverse')!.shapes['depth=3'], 1);
    assert.equal(snap.entries[0]!.op, 'listNodes', 'busiest operation first');
});

await test('a disabled tally records nothing', () => {
    const t = new CallTally(false);
    for (let i = 0; i < 100; i++) t.record('listNodes');
    assert.equal(t.snapshot().total, 0);
});

await test('LORE_CALL_TALLY=0 disables; default is ON', () => {
    // Default ON is deliberate: a counter that is off by default is not there
    // on the day someone needs the answer, which is how Phase 7 ended up
    // inferring the mix from source.
    assert.equal(callTallyEnabled(undefined), true, 'default on');
    assert.equal(callTallyEnabled('0'), false);
    assert.equal(callTallyEnabled('false'), false);
    assert.equal(callTallyEnabled('1'), true);
});

await test('reset starts a fresh window without discarding the instance', () => {
    const t = new CallTally(true);
    t.record('getNode');
    const before = t.snapshot().since;
    t.reset();
    assert.equal(t.snapshot().total, 0);
    assert.ok(t.snapshot().since >= before, 'window restarted');
});

await test('shape bucketing distinguishes the cases that actually differ', () => {
    // Phase 7 measured a 27x spread between limit=1 and unbounded on SurrealDB.
    // Bucketing must not collapse those two into one key.
    assert.notEqual(shapeLimit(1), shapeLimit(undefined, true));
    assert.equal(shapeLimit(5), 'limit<=10');
    assert.equal(shapeLimit(5000), 'limit>1000');
    assert.equal(shapeLimit(undefined), 'limit=default');
});

/* ─── wired into a real engine ───────────────────────────────────── */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tally-'));
const g = new SurrealGraph(dir, { workspaceId: 'w', cacheDisabled: true });
await g.initialize();
for (let i = 0; i < 40; i++) await g.upsertNode(node(`n${String(i).padStart(3, '0')}`));
for (let i = 0; i + 1 < 40; i++) {
    await g.addEdge({ sourceId: `n${String(i).padStart(3, '0')}`, targetId: `n${String(i + 1).padStart(3, '0')}`, relation: 'refers_to' });
}

await test('a real engine records the reads a host actually issues', async () => {
    g.callTally.reset();
    await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
    await g.listNodes(undefined, undefined, '*', '*', 10);
    await g.getNode('n000');
    await g.traverse('n000', 3);
    await g.traverseDirected('n000', 2);
    await g.listNodeSummaries(undefined, undefined, '*', '*', undefined, { unbounded: true });
    await g.search('L n0', 5, '*', '*');

    const ops = Object.fromEntries(g.callTally.snapshot().entries.map((e) => [e.op, e.count]));
    for (const op of ['listNodes', 'getNode', 'traverse', 'traverseDirected', 'listNodeSummaries', 'search']) {
        assert.ok(ops[op]! >= 1, `${op} was counted (saw ${JSON.stringify(ops)})`);
    }
    assert.equal(ops['listNodes'], 2, 'both listNodes calls counted');

    const list = g.callTally.snapshot().entries.find((e) => e.op === 'listNodes')!;
    assert.deepEqual(list.shapes, { 'limit=unbounded': 1, 'limit<=10': 1 },
        'the unbounded call is distinguishable from the bounded one — the whole point');
});

await test('the tally is PER-INSTANCE, not process-global', async () => {
    // This is the ownership argument in executable form: if two graphs in one
    // process shared state, the counter would be process-global state created
    // by a library that does not own the process, and would need an ownership
    // gate per CLAUDE.md. It does not, because they do not.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tally2-'));
    const g2 = new SurrealGraph(dir2, { workspaceId: 'w2', cacheDisabled: true });
    await g2.initialize();
    try {
        g.callTally.reset();
        g2.callTally.reset();
        await g.getNode('n000');
        assert.equal(g.callTally.snapshot().total, 1, 'first graph saw its own call');
        assert.equal(g2.callTally.snapshot().total, 0, 'second graph saw nothing');
    } finally {
        await g2.close().catch(() => undefined);
        fs.rmSync(dir2, { recursive: true, force: true });
    }
});

await test('MEASURED: counting costs nothing observable against a real read', async () => {
    // The claim is "no measurable write cost", so it is measured rather than
    // asserted in a comment. Two things about HOW, both learned the hard way:
    //
    // 1. MINIMUM of several runs per side, not a single sample. Wall-clock over
    //    200 calls picks up any unrelated load on the machine, and that noise is
    //    one-directional — scheduling can only make a run slower, never faster
    //    than the work actually takes. The minimum is therefore the least
    //    contaminated estimate, where a single sample is a coin flip. The first
    //    version of this test used one sample per side and failed roughly one
    //    run in three.
    //
    // 2. ONE-SIDED bound. The claim is "counting adds cost"; only the tally
    //    being SLOWER can falsify it. A symmetric `Math.abs(...)` bound also
    //    fails when the tally happens to measure faster, which is noise and not
    //    a defect — that was the actual cause of both observed failures. 25%
    //    headroom absorbs a scheduling hiccup and still catches the regression
    //    worth catching: a tally costing anything near the read itself.
    const REPS = 200;
    const ROUNDS = 3;
    const run = async (enabled: boolean): Promise<number> => {
        g.callTally.setEnabled(enabled);
        const t0 = performance.now();
        for (let i = 0; i < REPS; i++) await g.getNode(`n${String(i % 40).padStart(3, '0')}`);
        return performance.now() - t0;
    };
    await run(true); // warm the pool and page cache before timing anything

    // Interleaved rather than all-ON-then-all-OFF, so drift in machine load
    // partway through hits both sides instead of biasing one.
    const onRuns: number[] = [];
    const offRuns: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
        onRuns.push(await run(true));
        offRuns.push(await run(false));
    }
    const on = Math.min(...onRuns);
    const off = Math.min(...offRuns);
    const overheadPct = ((on - off) / off) * 100;
    console.log(`      ${REPS} getNode calls, best of ${ROUNDS}: tally ON ${on.toFixed(1)}ms, `
        + `OFF ${off.toFixed(1)}ms (${overheadPct >= 0 ? '+' : ''}${overheadPct.toFixed(1)}%)`);
    assert.ok(
        overheadPct < 25,
        `counting must not add measurable cost; measured +${overheadPct.toFixed(1)}% `
        + `(ON best ${on.toFixed(1)}ms of [${onRuns.map((v) => v.toFixed(0)).join(', ')}], `
        + `OFF best ${off.toFixed(1)}ms of [${offRuns.map((v) => v.toFixed(0)).join(', ')}])`,
    );
});

await g.close().catch(() => undefined);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

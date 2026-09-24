#!/usr/bin/env tsx
/**
 * test/rc321h-recall-outcome-unit.ts — Lore 3.21 step 3(h).
 *
 * `applyRecallOutcome()` (recall/recallOutcome.ts) is the shared core the
 * `recall_outcome` MCP tool and POST /api/recall/outcome both call. Pins:
 *   - vocabulary is IDENTICAL to record_outcome's own: 'success' |
 *     'failure' | 'partial' — no translation, no 'used'/'not_used'/'wrong'
 *     (Opus review round 2: that vocabulary collided with ranking.ts's
 *     deliberate failure-boost policy — see recallOutcome.ts's doc
 *     comment).
 *   - it writes through the SAME AuxStore.recordOutcome + graph.upsertNode
 *     path record_outcome already uses (real AuxStore, real SQLite file).
 *   - an outcome changes SUBSEQUENT ranking exactly as ranking.ts's existing
 *     outcomeWeight() formula defines — no new ranking math, verified by
 *     calling outcomeWeight() directly on the updated node.
 *   - queryId (when supplied) is recoverable from the outcome's notes.
 *   - node_not_found is a clean error, not a throw/crash.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuxStore } from '../packages/lore/src/outbox/auxStore.js';
import { applyRecallOutcome, isRecallOutcomeValue } from '../packages/lore/src/recall/recallOutcome.js';
import { outcomeWeight } from '../packages/lore/src/recall/ranking.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rc321h-'));
}

const WS = 'rc321h-ws';

function baseNode(id: string): LoreNode {
    return {
        id, type: 'note', label: `Label ${id}`, content: 'content', tags: [],
        project: WS, ecosystem: '*', updatedAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z', syncedAt: null,
    } as unknown as LoreNode;
}

/** In-memory graph fixture: getNode/upsertNode over a plain Map, mirroring
 *  how the real LoreGraphHandle round-trips success_count/failure_count/
 *  partial_count/confirmation_score fields verbatim. */
function makeGraph() {
    const nodes = new Map<string, LoreNode>();
    return {
        nodes,
        async initialize() { /* noop */ },
        async getNode(id: string) { return nodes.get(id) ?? null; },
        async upsertNode(n: LoreNode) { nodes.set(n.id, n); return n; },
    };
}

console.log('RC321h — recall outcome vocabulary (identical to record_outcome) + ranking effect');

await test('isRecallOutcomeValue: accepts exactly success/failure/partial (record_outcome\'s own vocabulary)', () => {
    assert.equal(isRecallOutcomeValue('success'), true);
    assert.equal(isRecallOutcomeValue('failure'), true);
    assert.equal(isRecallOutcomeValue('partial'), true);
    assert.equal(isRecallOutcomeValue('used'), false, 'the REJECTED relevance vocabulary must not be accepted');
    assert.equal(isRecallOutcomeValue('not_used'), false);
    assert.equal(isRecallOutcomeValue('wrong'), false);
    assert.equal(isRecallOutcomeValue(undefined), false);
});

await test('applyRecallOutcome: "success" updates the node\'s success_count (no vocabulary translation)', async () => {
    const dir = makeTmpDir();
    const auxStore = AuxStore.open(dir);
    const graph = makeGraph();
    graph.nodes.set('n1', baseNode('n1'));
    const result = await applyRecallOutcome({ auxStore, graph, nodeId: 'n1', workspace: WS, outcome: 'success', principal: 'test' });
    assert.ok(result.ok);
    if (result.ok) {
        assert.equal(result.status, 'success');
        assert.equal(result.counts.success, 1);
        assert.equal(result.counts.failure, 0);
    }
    const updated = graph.nodes.get('n1')!;
    assert.equal((updated as unknown as { success_count: number }).success_count, 1);
    auxStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

await test('applyRecallOutcome: "failure" updates the node\'s failure_count', async () => {
    const dir = makeTmpDir();
    const auxStore = AuxStore.open(dir);
    const graph = makeGraph();
    graph.nodes.set('n1', baseNode('n1'));
    const result = await applyRecallOutcome({ auxStore, graph, nodeId: 'n1', workspace: WS, outcome: 'failure', principal: 'test' });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.status, 'failure');
    const updated = graph.nodes.get('n1')! as unknown as { failure_count: number };
    assert.equal(updated.failure_count, 1);
    auxStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

await test('applyRecallOutcome: "partial" updates the node\'s partial_count', async () => {
    const dir = makeTmpDir();
    const auxStore = AuxStore.open(dir);
    const graph = makeGraph();
    graph.nodes.set('n1', baseNode('n1'));
    const result = await applyRecallOutcome({ auxStore, graph, nodeId: 'n1', workspace: WS, outcome: 'partial', principal: 'test' });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.status, 'partial');
    const updated = graph.nodes.get('n1')! as unknown as { partial_count: number };
    assert.equal(updated.partial_count, 1);
    auxStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

await test('applyRecallOutcome: node_not_found is a clean error result, not a throw', async () => {
    const dir = makeTmpDir();
    const auxStore = AuxStore.open(dir);
    const graph = makeGraph(); // empty — no nodes registered
    const result = await applyRecallOutcome({ auxStore, graph, nodeId: 'missing', workspace: WS, outcome: 'success', principal: 'test' });
    assert.deepEqual(result, { ok: false, code: 'node_not_found' });
    auxStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

await test('applyRecallOutcome: queryId (when supplied) is recoverable from the outcome row\'s notes', async () => {
    const dir = makeTmpDir();
    const auxStore = AuxStore.open(dir);
    const graph = makeGraph();
    graph.nodes.set('n1', baseNode('n1'));
    await applyRecallOutcome({ auxStore, graph, nodeId: 'n1', workspace: WS, outcome: 'success', queryId: 'q-abc-123', principal: 'test' });
    const [row] = auxStore.getOutcomes('n1', WS, 10);
    assert.ok(row!.notes?.includes('q-abc-123'), `expected the queryId to be recoverable from notes, got: ${row!.notes}`);
    auxStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

await test('applyRecallOutcome: no queryId ⇒ notes is null (no forced text on the common path)', async () => {
    const dir = makeTmpDir();
    const auxStore = AuxStore.open(dir);
    const graph = makeGraph();
    graph.nodes.set('n1', baseNode('n1'));
    await applyRecallOutcome({ auxStore, graph, nodeId: 'n1', workspace: WS, outcome: 'success', principal: 'test' });
    const [row] = auxStore.getOutcomes('n1', WS, 10);
    assert.equal(row!.notes, null);
    auxStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

await test('an outcome changes SUBSEQUENT ranking exactly as ranking.ts\'s existing outcomeWeight() defines (no new ranking math)', async () => {
    const dir = makeTmpDir();
    const auxStore = AuxStore.open(dir);
    const graph = makeGraph();
    graph.nodes.set('n1', baseNode('n1'));

    // Before any outcome: neutral weight.
    assert.equal(outcomeWeight(graph.nodes.get('n1')!), 1.0);

    // Record 5 'failure' outcomes — OUTCOME_SATURATION in ranking.ts is 5,
    // so this reaches full saturation: failureSignal=1, saturation=1 ⇒
    // outcomeWeight = 1 + FAILURE_BOOST(0.5)*1*1 = 1.5. This is
    // ranking.ts's DELIBERATE policy (a node flagged as having misled
    // ranks HIGHER afterward, as a warning) — not something this test or
    // recall_outcome redefines.
    for (let i = 0; i < 5; i++) {
        await applyRecallOutcome({ auxStore, graph, nodeId: 'n1', workspace: WS, outcome: 'failure', principal: 'test' });
    }
    const afterFailures = graph.nodes.get('n1')!;
    assert.equal(outcomeWeight(afterFailures), 1.5, 'outcomeWeight must match ranking.ts\'s own formula exactly — this test does not redefine it');

    // A subsequent 'success' outcome shifts the mix (5 failure + 1 success
    // out of 6 total, still saturated) — recompute by hand from the SAME
    // formula ranking.ts documents, and assert applyRecallOutcome produced
    // a node outcomeWeight() agrees with, proving the write path and the
    // read path (ranking.ts) are not just individually correct but
    // CONSISTENT with each other.
    await applyRecallOutcome({ auxStore, graph, nodeId: 'n1', workspace: WS, outcome: 'success', principal: 'test' });
    const afterMixed = graph.nodes.get('n1')! as unknown as { success_count: number; failure_count: number; partial_count: number };
    assert.equal(afterMixed.success_count, 1);
    assert.equal(afterMixed.failure_count, 5);
    const total = 6;
    const saturation = Math.min(total / 5, 1.0);
    const failureSignal = 5 / total;
    const weightedTotal = 1 + 5 + 0 * 0.5;
    const confirmSignal = 1 / weightedTotal;
    const expected = 1.0 + 0.5 * failureSignal * saturation + 0.2 * confirmSignal * saturation;
    assert.equal(outcomeWeight(graph.nodes.get('n1')!), expected);

    auxStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

await test('applyRecallOutcome: confirmation_score is recomputed identically to record_outcome\'s own formula', async () => {
    const dir = makeTmpDir();
    const auxStore = AuxStore.open(dir);
    const graph = makeGraph();
    graph.nodes.set('n1', baseNode('n1'));
    await applyRecallOutcome({ auxStore, graph, nodeId: 'n1', workspace: WS, outcome: 'success', principal: 'test' });
    const r2 = await applyRecallOutcome({ auxStore, graph, nodeId: 'n1', workspace: WS, outcome: 'success', principal: 'test' });
    assert.ok(r2.ok);
    // 2 success, 0 failure, 0 partial → total=2, score = round((2/2)*1000)/1000 = 1.
    if (r2.ok) assert.equal(r2.newConfirmationScore, 1);
    auxStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

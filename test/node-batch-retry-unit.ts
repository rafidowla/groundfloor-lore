#!/usr/bin/env tsx
/**
 * test/node-batch-retry-unit.ts - 3.35.0 (D10): the one retry helper around `commitNodeBatch`.
 *
 *   - contention x3 then success: prepare() runs before EVERY attempt, so conditions are re-judged
 *   - contention x4: NodeBatchContentionError (retryable 503), nothing written, backoff is full-jitter
 *   - unknown: never retried; settled by re-reading the plan's stamps (committed / rival / still unknown)
 *   - refusals (precondition / revision / exists) end the loop immediately
 *   - a PLAIN write (no checks, one cas or insert) is the same call (the seam for item r)
 *   - writePreconditioned: a precondition that stops holding between attempts is refused on the retry
 *   - the HTTP mapping of a contention error is a 503 {code:'contention', retryable:true}
 *
 * Run: npx tsx test/node-batch-retry-unit.ts
 */
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import {
    commitNodeBatchWithRetry, settleNodeBatchUnknown, NodeBatchContentionError, isNodeBatchContention, MAX_BATCH_ATTEMPTS,
    type NodeBatchPlan,
} from '../packages/lore/src/engines/graphShared/nodeBatchRetry.js';
import type { NodeBatchOutcome, NodeBatchWrite, NodeBatchCapable } from '../packages/lore/src/engines/graphShared/nodeBatch.js';
import { OutcomeUnknownError } from '../packages/lore/src/engines/graphShared/writeOutcome.js';
import { writePreconditioned } from '../packages/lore/src/core/preconditionedWrite.js';
import { ItemConditionError } from '../packages/lore/src/core/conditionalChecks.js';
import { writeContention } from '../packages/lore/src/mcp/http/helpers.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const STAMP = '2026-10-01T00:00:00.000Z';
const nodeIn = (id: string) => ({ id, type: 'note', label: id, content: id, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });
const casW = (id: string, expectedRevision: number): NodeBatchWrite => ({ kind: 'cas', node: nodeIn(id), expectedRevision, mustExist: false, updatedAt: STAMP });
const insW = (id: string): NodeBatchWrite => ({ kind: 'insert', node: nodeIn(id), updatedAt: STAMP });
const stored = (id: string, revision: number, updatedAt = STAMP): LoreNode => ({ ...nodeIn(id), createdAt: STAMP, updatedAt, syncedAt: null, revision } as unknown as LoreNode);

/** A graph whose commitNodeBatch answers from a script; every submitted plan is recorded. */
function scripted(answers: NodeBatchOutcome[], nodes: Map<string, LoreNode> = new Map()) {
    const calls: NodeBatchPlan[] = [];
    const graph: NodeBatchCapable & { getNode(id: string): Promise<LoreNode | null> } = {
        async commitNodeBatch(checks, writes) { calls.push({ checks, writes }); return answers[Math.min(calls.length - 1, answers.length - 1)]!; },
        async getNode(id) { return nodes.get(id) ?? null; },
    };
    return { graph, calls, nodes };
}
const noSleep = { sleep: async () => undefined, random: () => 0.5 };
const OK: NodeBatchOutcome = { ok: true, revisions: { a: 2 } };
const CONTENTION: NodeBatchOutcome = { ok: false, code: 'contention' };

await test('contention x3 then success: 4 attempts, prepare() runs before each one (conditions re-judged)', async () => {
    const { graph, calls } = scripted([CONTENTION, CONTENTION, CONTENTION, OK]);
    const seen: number[] = [];
    const out = await commitNodeBatchWithRetry(graph, async (attempt) => { seen.push(attempt); return { checks: [{ id: 'x', revision: 1 }], writes: [casW('a', 1)] }; }, noSleep);
    assert.deepEqual(out, { ok: true, revisions: { a: 2 }, attempts: 4 });
    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.equal(calls.length, 4);
});

await test('prepare() re-judging ends the write: a condition that stops holding on attempt 3 throws and nothing more is submitted', async () => {
    const { graph, calls } = scripted([CONTENTION]);
    await assert.rejects(
        commitNodeBatchWithRetry(graph, async (attempt) => {
            if (attempt === 3) throw new ItemConditionError({ error: 'x moved', failedPreconditions: [{ id: 'x', expected: 1, found: 2 }] });
            return { checks: [{ id: 'x', revision: 1 }], writes: [casW('a', 1)] };
        }, noSleep),
        ItemConditionError,
    );
    assert.equal(calls.length, 2, 'only attempts 1 and 2 reached the engine');
});

await test('contention x4: NodeBatchContentionError (code contention, retryable, 503), exactly MAX_BATCH_ATTEMPTS submissions', async () => {
    assert.equal(MAX_BATCH_ATTEMPTS, 4);
    const { graph, calls } = scripted([CONTENTION]);
    const waits: number[] = [];
    const err = await commitNodeBatchWithRetry(graph, async () => ({ checks: [], writes: [casW('a', 0)] }),
        { sleep: async (ms) => { waits.push(ms); }, random: () => 0.999 }).then(() => null, (e) => e);
    assert.ok(isNodeBatchContention(err));
    assert.ok(err instanceof NodeBatchContentionError);
    assert.equal(err.code, 'contention'); assert.equal(err.retryable, true); assert.equal(err.status, 503); assert.equal(err.attempts, 4);
    assert.equal(calls.length, 4);
    assert.equal(waits.length, 3, 'no sleep after the last attempt');
    // full jitter: each wait is below the exponential cap 20 * 2^(n-1)
    waits.forEach((w, i) => assert.ok(w >= 0 && w < 20 * 2 ** i, `wait ${i} = ${w}`));
});

await test('the HTTP mapping of a contention error: 503, Retry-After, {code:"contention", retryable:true}', () => {
    const captured: { status?: number; headers?: Record<string, unknown>; body?: string } = {};
    const res = { writeHead(s: number, h: Record<string, unknown>) { captured.status = s; captured.headers = h; return this; }, end(b: string) { captured.body = b; } };
    assert.equal(writeContention(res as unknown as ServerResponse, new NodeBatchContentionError(4)), true);
    assert.equal(captured.status, 503);
    assert.ok(captured.headers && 'Retry-After' in captured.headers);
    const body = JSON.parse(captured.body!);
    assert.equal(body.code, 'contention'); assert.equal(body.retryable, true);
    assert.equal(writeContention(res as unknown as ServerResponse, new Error('other')), false);
});

await test('refusals end the loop at once: precondition / revision / exists are not retried', async () => {
    for (const refusal of [
        { ok: false, code: 'precondition', index: 0, id: 'x', actual: 5 },
        { ok: false, code: 'revision', index: 0, id: 'a', actual: 3 },
        { ok: false, code: 'exists', index: 0, id: 'a' },
    ] as NodeBatchOutcome[]) {
        const { graph, calls } = scripted([refusal]);
        const out = await commitNodeBatchWithRetry(graph, async () => ({ checks: [], writes: [insW('a')] }), noSleep);
        assert.equal(out.ok, false);
        assert.equal(calls.length, 1);
        assert.equal((out as { code: string }).code, (refusal as { code: string }).code);
    }
});

await test('unknown: no retry; settled as committed when every write shows its own stamp', async () => {
    const nodes = new Map([['a', stored('a', 2)]]);
    const { graph, calls } = scripted([{ ok: false, code: 'unknown' }], nodes);
    const out = await commitNodeBatchWithRetry(graph, async () => ({ checks: [], writes: [casW('a', 1)] }), noSleep);
    assert.equal(calls.length, 1, 'never replayed');
    assert.deepEqual(out, { ok: true, revisions: { a: 2 }, attempts: 1 });
});

await test('unknown: settled as a revision conflict when a rival moved the node, as exists when a rival created the id', async () => {
    const rival = new Map([['a', stored('a', 3, '2026-10-02T00:00:00.000Z')]]);
    const out = await commitNodeBatchWithRetry(scripted([{ ok: false, code: 'unknown' }], rival).graph, async () => ({ checks: [], writes: [casW('a', 1)] }), noSleep);
    assert.deepEqual(out, { ok: false, code: 'revision', index: 0, id: 'a', actual: 3, attempts: 1 });
    const taken = new Map([['n', stored('n', 1, '2026-10-02T00:00:00.000Z')]]);
    const out2 = await commitNodeBatchWithRetry(scripted([{ ok: false, code: 'unknown' }], taken).graph, async () => ({ checks: [], writes: [insW('n')] }), noSleep);
    assert.deepEqual(out2, { ok: false, code: 'exists', index: 0, id: 'n', attempts: 1 });
});

await test('unknown that the re-read cannot prove (old state still showing, or the read fails) throws OutcomeUnknownError', async () => {
    const old = new Map([['a', stored('a', 1, '2026-09-01T00:00:00.000Z')]]);
    await assert.rejects(
        commitNodeBatchWithRetry(scripted([{ ok: false, code: 'unknown' }], old).graph, async () => ({ checks: [], writes: [casW('a', 1)] }), noSleep),
        OutcomeUnknownError,
    );
    await assert.rejects(settleNodeBatchUnknown(async () => { throw new Error('down'); }, { checks: [], writes: [casW('a', 1)] }, 1), OutcomeUnknownError);
    await assert.rejects(settleNodeBatchUnknown(undefined, { checks: [], writes: [casW('a', 1)] }, 1), OutcomeUnknownError);
});

await test('a PLAIN write (no checks) is the same call: cas and insert, one write each', async () => {
    const a = scripted([{ ok: true, revisions: { p: 4 } }]);
    assert.equal((await commitNodeBatchWithRetry(a.graph, async () => ({ checks: [], writes: [casW('p', 3)] }), noSleep)).ok, true);
    assert.deepEqual(a.calls[0]!.checks, []);
    const b = scripted([CONTENTION, { ok: true, revisions: { q: 1 } }]);
    const out = await commitNodeBatchWithRetry(b.graph, async () => ({ checks: [], writes: [insW('q')] }), noSleep);
    assert.deepEqual(out, { ok: true, revisions: { q: 1 }, attempts: 2 });
});

await test('writePreconditioned: a precondition node that moves during a contention retry is refused on the retry (ItemConditionError)', async () => {
    const nodes = new Map<string, LoreNode>([['x', stored('x', 1)], ['a', stored('a', 1)]]);
    const { graph, calls } = scripted([CONTENTION], nodes);
    const base = graph.commitNodeBatch.bind(graph);
    graph.commitNodeBatch = async (c, w) => { const r = await base(c, w); nodes.set('x', stored('x', 2)); return r; }; // a rival bumps X after attempt 1
    await assert.rejects(
        writePreconditioned(graph, nodeIn('a'), [{ id: 'x', revision: 1 }], { kind: 'cas', expected: 1, updatedAt: STAMP, mustExist: false }),
        (e: unknown) => e instanceof ItemConditionError,
    );
    assert.equal(calls.length, 1, 'the retry was refused before it reached the engine');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

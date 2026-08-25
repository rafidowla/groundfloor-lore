#!/usr/bin/env tsx
/**
 * writePropositions.unit.ts — proposition node ids and (the fix) the
 * `[<session_date>] ` label prefix.
 *
 * The label is the ONLY place a date can ride: lore.recall()'s typed
 * RecallNode surfaces {id,type,label,content,tags,project,source,language}
 * and nothing else, so the `session_date` field these nodes also carry never
 * reaches the answering model (README.md, "dates don't survive
 * lore.recall()"). ingest.ts's turn nodes have carried the date in the label
 * since 2026-08-12; proposition nodes did not, so any temporal question
 * whose evidence surfaced as a proposition lost its date.
 *
 * `lore` is a stub that captures the bulkIngest payload — zero API calls,
 * zero Lore instance, no native bindings.
 */

import assert from 'node:assert/strict';
import type { LoreInstance } from '../../../packages/lore/src/index.js';
import { buildNodeId } from './ingest.js';
import { buildPropositionLabel, buildPropositionNodeId, writePropositions } from './writePropositions.js';
import type { Proposition } from './extractPropositions.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

interface CapturedNode {
    id: string;
    workspace: string;
    ecosystem: string;
    nodeData: Record<string, unknown>;
}

/** Minimal LoreInstance stand-in: records what bulkIngest was handed. */
function stubLore(ok = true): { lore: LoreInstance; calls: Array<{ nodes: CapturedNode[]; opts: unknown }> } {
    const calls: Array<{ nodes: CapturedNode[]; opts: unknown }> = [];
    const lore = {
        bulkIngest: async (nodes: CapturedNode[], opts: unknown) => {
            calls.push({ nodes, opts });
            return {
                ok,
                count: nodes.length,
                results: nodes.map((n) => (ok ? { ok: true, id: n.id } : { ok: false, id: n.id, error: 'boom' })),
            };
        },
    } as unknown as LoreInstance;
    return { lore, calls };
}

const Q = 'gpt4_59149c77';
const SESSION = 'answer_555dfb94';
const DATE = '2023/05/29';

/** The exact fields lore.recall() surfaces back to the answering step —
 *  anything not in here is invisible to the model, date included. */
function recallProjection(node: CapturedNode): { id: string; type: unknown; label: unknown; content: unknown; tags: unknown } {
    const d = node.nodeData;
    return { id: node.id, type: d.type, label: d.label, content: d.content, tags: d.tags };
}

console.log('buildPropositionNodeId');

await test('is the source turn id plus a ::prop<n> suffix', () => {
    assert.equal(buildPropositionNodeId(Q, SESSION, 3, 0), `${Q}::${SESSION}::3::prop0`);
    assert.equal(buildPropositionNodeId(Q, SESSION, 3, 0), `${buildNodeId(Q, SESSION, 3)}::prop0`);
});

console.log('\nbuildPropositionLabel');

await test('prepends [<session_date>] in ingest.ts\'s turn-label format', () => {
    assert.equal(buildPropositionLabel(DATE, 'The user visited MoMA.'), '[2023/05/29] The user visited MoMA.');
});

await test('omits the bracket entirely when there is no session date', () => {
    assert.equal(buildPropositionLabel(null, 'The user visited MoMA.'), 'The user visited MoMA.');
});

await test('collapses whitespace and truncates the text at 80 chars, like ingest.ts', () => {
    const long = 'x'.repeat(200);
    assert.equal(buildPropositionLabel(DATE, long), `[${DATE}] ${'x'.repeat(80)}`);
    assert.equal(buildPropositionLabel(null, 'a\n\nb   c\td'), 'a b c d');
});

await test('the date is never crowded out of the label by a long proposition', () => {
    const label = buildPropositionLabel(DATE, 'y'.repeat(500));
    assert.ok(label.startsWith(`[${DATE}] `), 'date must lead the label');
});

console.log('\nwritePropositions — what actually lands on the node');

const props: Proposition[] = [
    { text: 'The user visited the MoMA on this date.', sourceTurnIndex: 3 },
    { text: 'The user thought the Rothko room was the highlight.', sourceTurnIndex: 3 },
    { text: 'The user paid $25 for the ticket.', sourceTurnIndex: 7 },
];

await test('every node label carries the session date', async () => {
    const { lore, calls } = stubLore();
    const { written } = await writePropositions(lore, Q, SESSION, DATE, props);
    assert.equal(written, 3);
    assert.equal(calls.length, 1);
    for (const node of calls[0]!.nodes) {
        assert.ok(String(node.nodeData.label).startsWith(`[${DATE}] `), `label missing date: ${node.nodeData.label}`);
    }
});

await test('the date survives the recall() field projection (the whole point of the fix)', async () => {
    const { lore, calls } = stubLore();
    await writePropositions(lore, Q, SESSION, DATE, props);
    for (const node of calls[0]!.nodes) {
        const surfaced = recallProjection(node);
        assert.ok(
            JSON.stringify(surfaced).includes(DATE),
            'the date must appear in a field recall() actually returns, not just in nodeData.session_date',
        );
        // Pre-fix this held: the ONLY copy of the date was a custom field.
        assert.equal((node.nodeData as { session_date?: unknown }).session_date, DATE);
    }
});

await test('content stays the pure, untruncated proposition text (only the label changed)', async () => {
    const { lore, calls } = stubLore();
    const longProp: Proposition[] = [{ text: `The user said: ${'z'.repeat(300)}`, sourceTurnIndex: 0 }];
    await writePropositions(lore, Q, SESSION, DATE, longProp);
    const node = calls[0]!.nodes[0]!;
    assert.equal(node.nodeData.content, longProp[0]!.text, 'content must not gain a date prefix or lose length');
    assert.notEqual(node.nodeData.label, node.nodeData.content);
});

await test('no session date → no bracket, and nothing else changes', async () => {
    const { lore, calls } = stubLore();
    await writePropositions(lore, Q, SESSION, null, props);
    const node = calls[0]!.nodes[0]!;
    assert.equal(node.nodeData.label, 'The user visited the MoMA on this date.');
    assert.equal(node.nodeData.session_date, null);
});

await test('ids number per source turn and point back at the right source node', async () => {
    const { lore, calls } = stubLore();
    await writePropositions(lore, Q, SESSION, DATE, props);
    const nodes = calls[0]!.nodes;
    assert.deepEqual(nodes.map((n) => n.id), [
        `${Q}::${SESSION}::3::prop0`,
        `${Q}::${SESSION}::3::prop1`,
        `${Q}::${SESSION}::7::prop0`,
    ]);
    assert.deepEqual(nodes.map((n) => n.nodeData.source_node_id), [
        buildNodeId(Q, SESSION, 3),
        buildNodeId(Q, SESSION, 3),
        buildNodeId(Q, SESSION, 7),
    ]);
    assert.deepEqual(nodes.map((n) => n.nodeData.type), ['proposition', 'proposition', 'proposition']);
});

await test('empty proposition list writes nothing at all', async () => {
    const { lore, calls } = stubLore();
    assert.deepEqual(await writePropositions(lore, Q, SESSION, DATE, []), { written: 0 });
    assert.equal(calls.length, 0);
});

await test('a failed bulkIngest throws rather than reporting success', async () => {
    const { lore } = stubLore(false);
    await assert.rejects(() => writePropositions(lore, Q, SESSION, DATE, props), /bulkIngest reported failures/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env tsx
/**
 * test/rc321g-recall-candidates-unit.ts — Lore 3.21 step 3(g).
 *
 * `buildCompactCandidates()` (recall/recallPreset.ts) shapes a retrieve()
 * outcome into {id, label, snippet<=240, score, matchedBy, updatedAt}
 * candidates. `expandCandidates()` (recall/recallExpand.ts) fetches full
 * bodies for chosen ids, confined to the SAME workspace/ecosystem/actor
 * scope `recall` itself enforces — the core promise of `recall_expand` /
 * POST /api/recall/expand: a caller cannot expand an id outside its scope.
 */

import assert from 'node:assert/strict';
import { buildCompactCandidates, COMPACT_SNIPPET_LEN } from '../packages/lore/src/recall/recallPreset.js';
import { expandCandidates, MAX_EXPAND_IDS } from '../packages/lore/src/recall/recallExpand.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import type { RetrieveOutcome } from '../packages/lore/src/recall/retrieve.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const node = (id: string, over: Partial<LoreNode> = {}): LoreNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content for ${id}`,
    tags: [], project: 'w', ecosystem: '*', updatedAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z', syncedAt: null,
    ...over,
} as unknown as LoreNode);

console.log('RC321g — compact candidates + expand confinement');

await test('buildCompactCandidates: shape + score/matchedBy/updatedAt pass through unchanged', async () => {
    const outcome: RetrieveOutcome = {
        results: [{ node: node('a', { label: 'Alpha' }), score: 0.83, matchedBy: ['semantic', 'bm25'], depth: 0, source: 'seed' }],
        related: [],
        meta: {} as never,
    };
    const [c] = buildCompactCandidates(outcome);
    assert.equal(c!.id, 'a');
    assert.equal(c!.label, 'Alpha');
    assert.equal(c!.score, 0.83);
    assert.deepEqual(c!.matchedBy, ['semantic', 'bm25']);
    assert.equal(c!.updatedAt, '2026-06-01T00:00:00.000Z');
});

await test(`buildCompactCandidates: snippet truncates at ${COMPACT_SNIPPET_LEN} chars (not the 120-char summary length)`, async () => {
    const longContent = 'x'.repeat(500);
    const outcome: RetrieveOutcome = {
        results: [{ node: node('a', { content: longContent }), score: 1, matchedBy: ['semantic'], depth: 0, source: 'seed' }],
        related: [],
        meta: {} as never,
    };
    const [c] = buildCompactCandidates(outcome);
    // truncated to COMPACT_SNIPPET_LEN chars + an ellipsis character.
    assert.equal(c!.snippet!.length, COMPACT_SNIPPET_LEN + 1);
    assert.ok(c!.snippet!.endsWith('…'));
});

await test('buildCompactCandidates: short content is returned verbatim (whitespace-normalised), no truncation marker', async () => {
    const outcome: RetrieveOutcome = {
        results: [{ node: node('a', { content: '  short   content  ' }), score: 1, matchedBy: ['bm25'], depth: 1, source: 'via:a' }],
        related: [],
        meta: {} as never,
    };
    const [c] = buildCompactCandidates(outcome);
    assert.equal(c!.snippet, 'short content');
});

function graphOf(nodes: Record<string, LoreNode>) {
    return {
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, LoreNode>();
            for (const id of ids) { const n = nodes[id]; if (n) m.set(id, n); }
            return m;
        },
    };
}

await test('expandCandidates: fetches found ids, preserves input order, drops not-found ids silently', async () => {
    const graph = graphOf({ a: node('a'), c: node('c') });
    const out = await expandCandidates(graph, ['c', 'a', 'missing'], '*');
    assert.deepEqual(out.map((n) => n.id), ['c', 'a'], 'order follows the requested ids, not insertion order; unknown id silently dropped');
});

await test('expandCandidates: confinement — an id whose workspace never had it is simply never found (per-workspace graph handle IS the boundary)', async () => {
    // Simulates the cross-workspace case: expandCandidates is always called
    // against the CALLER's workspace's own graph handle (wired by the
    // caller, e.g. graphRegistry.getGraphHandle(requestedWorkspace)) — an id
    // that lives only in a different workspace's graph is never even in the
    // Map getNodesByIds returns, so it can never leak across workspaces.
    const otherWorkspaceGraph = graphOf({ a: node('a') }); // id 'secret' not present — lives in a DIFFERENT workspace's graph
    const out = await expandCandidates(otherWorkspaceGraph, ['a', 'secret'], '*');
    assert.deepEqual(out.map((n) => n.id), ['a'], 'a foreign-workspace id must not be expandable, not even silently ignored-but-present');
});

await test('expandCandidates: ecosystem confinement excludes a node outside the requested ecosystem scope', async () => {
    const graph = graphOf({
        inscope: node('inscope', { ecosystem: 'eco-a' }),
        outofscope: node('outofscope', { ecosystem: 'eco-b' }),
    });
    const out = await expandCandidates(graph, ['inscope', 'outofscope'], 'eco-a');
    assert.deepEqual(out.map((n) => n.id), ['inscope'], 'a node from a different ecosystem must not be expandable');
});

await test('expandCandidates: a node tagged ecosystem:"*" is visible to a specific-ecosystem expand (wildcard convention)', async () => {
    const graph = graphOf({ wild: node('wild', { ecosystem: '*' }) });
    const out = await expandCandidates(graph, ['wild'], 'eco-a');
    assert.deepEqual(out.map((n) => n.id), ['wild']);
});

await test('expandCandidates: actor-scope confinement — a scoped node is excluded from an actor without the matching scope', async () => {
    const graph = graphOf({
        secret: node('secret', { security_scopes: ['team-x'] } as Partial<LoreNode>),
        pub: node('pub'), // no security_scopes ⇒ public-within-workspace
    });
    const out = await runWithActor({ portalUserId: 'u1', scopes: ['team-y'] }, async () =>
        expandCandidates(graph, ['secret', 'pub'], '*'));
    assert.deepEqual(out.map((n) => n.id), ['pub'], 'the scoped node must be dropped for an actor lacking that scope');
});

await test('expandCandidates: actor-scope confinement — the same scoped node IS returned to an actor holding the matching scope', async () => {
    const graph = graphOf({ secret: node('secret', { security_scopes: ['team-x'] } as Partial<LoreNode>) });
    const out = await runWithActor({ portalUserId: 'u1', scopes: ['team-x'] }, async () =>
        expandCandidates(graph, ['secret'], '*'));
    assert.deepEqual(out.map((n) => n.id), ['secret']);
});

await test('expandCandidates: no actor bound (local mode) ⇒ no scope filtering, only ecosystem/workspace confinement applies', async () => {
    const graph = graphOf({ secret: node('secret', { security_scopes: ['team-x'] } as Partial<LoreNode>) });
    const out = await expandCandidates(graph, ['secret'], '*'); // no runWithActor wrapper
    assert.deepEqual(out.map((n) => n.id), ['secret']);
});

await test(`expandCandidates: caps at ${MAX_EXPAND_IDS} ids and dedups, rather than fetching everything requested`, async () => {
    const nodes: Record<string, LoreNode> = {};
    const ids: string[] = [];
    for (let i = 0; i < MAX_EXPAND_IDS + 10; i++) { const id = `n${i}`; nodes[id] = node(id); ids.push(id); }
    ids.push('n0', 'n0'); // duplicates of an already-included id
    let calledWith: string[] = [];
    const graph = {
        async getNodesByIds(reqIds: string[]) {
            calledWith = reqIds;
            const m = new Map<string, LoreNode>();
            for (const id of reqIds) { const n = nodes[id]; if (n) m.set(id, n); }
            return m;
        },
    };
    const out = await expandCandidates(graph, ids, '*');
    assert.ok(calledWith.length <= MAX_EXPAND_IDS, `getNodesByIds must be called with at most ${MAX_EXPAND_IDS} ids, got ${calledWith.length}`);
    assert.ok(out.length <= MAX_EXPAND_IDS, `result must be capped at ${MAX_EXPAND_IDS}, got ${out.length}`);
});

await test('expandCandidates: empty ids ⇒ empty result, no graph call', async () => {
    let called = false;
    const graph = { async getNodesByIds() { called = true; return new Map<string, LoreNode>(); } };
    const out = await expandCandidates(graph, [], '*');
    assert.deepEqual(out, []);
    assert.equal(called, false, 'an empty request must short-circuit before touching the graph');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

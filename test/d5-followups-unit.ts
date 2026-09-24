#!/usr/bin/env tsx
/**
 * d5-followups-unit.ts — closes the two remaining gaps left after
 * `d5-review-gaps-unit.ts` (D5 re-review, 2026-09-23):
 *
 *  1. `refillSeedSlots` (recall/supersessionRecall.ts, finding #6a) — one
 *     case the review-gaps suite didn't exercise: what happens when the
 *     spillover candidates run out BEFORE the seed window reaches `limit`
 *     (fewer live/admissible candidates than slots to fill). It must return
 *     a map that is short of `limit`, not throw, not pad with anything
 *     invalid. The review-gaps suite already covers: reaches `limit` when
 *     enough candidates exist, no duplicates, never re-introduces a
 *     superseded node, and respects the caller's admit/visibility gate — so
 *     this file only adds the exhaustion case plus a same-workspace-only
 *     visibility check for completeness.
 *  2. Re-save rule (core/supersessionPolicy.ts, finding #6e,
 *     `runSupersessionValidation`) — the review-gaps suite covers "resave of
 *     an existing superseding node succeeds without re-declaring supersedes"
 *     and "a NEW node still must declare it", both under enforcement ON. It
 *     never exercises enforcement OFF for this same resave scenario. Add
 *     that: with `supersessionPolicy.enforce === false`, a NEW node missing
 *     `supersedes` must succeed too (the whole check is skipped, not just
 *     relaxed for resaves).
 *
 * Run: npx tsx test/d5-followups-unit.ts
 */
import assert from 'node:assert/strict';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string;
    supersededBy?: string; status?: string;
};
const fnode = (id: string, over: Partial<FNode> = {}): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`,
    tags: [], project: 'ws-a', ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});
function fakeGraph(nodes: Record<string, FNode>) {
    return {
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = nodes[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
    };
}

const { refillSeedSlots } = await import('../packages/lore/src/recall/supersessionRecall.js');
const { runSupersessionValidation } = await import('../packages/lore/src/core/supersessionPolicy.js');

/* ─── 1. refillSeedSlots — candidate exhaustion ──────────────────────── */
console.log('D5 follow-ups — refillSeedSlots: candidates exhausted before reaching limit');
{
    type RR = import('../packages/lore/src/recall/retrieve.js').RetrievalResult;
    type MatchKind = import('../packages/lore/src/recall/retrieve.js').MatchKind;
    const NODES: Record<string, FNode> = {
        a: fnode('a'),
        c1: fnode('c1'), c2: fnode('c2'),
        deadNoSuccessor: fnode('deadNoSuccessor', { supersededBy: 'ghost' }), // ghost doesn't exist
        archivedOnly: fnode('archivedOnly', { supersededBy: 'arch' }), arch: fnode('arch', { status: 'archived' }),
        // A superseded spillover candidate whose LIVE successor sits in a
        // different workspace than the caller's admit predicate allows.
        // (Non-superseded spillover is NOT admit-checked by design — see
        // `resolveLiveNodes` doc comment: spillover already passed
        // retrieve()'s own applySeedFilters, so `admit` here only gates
        // successors refill fetches itself.)
        crossWsSuperseded: fnode('crossWsSuperseded', { supersededBy: 'crossWsSuccessor' }),
        crossWsSuccessor: fnode('crossWsSuccessor', { project: 'ws-b' }),
    };
    const graph = fakeGraph(NODES) as never;
    // admit rejects archived nodes AND anything outside 'ws-a' — used to prove
    // refill both resolves superseded chains and respects a workspace-scoped
    // visibility predicate on the successors it fetches itself.
    const admitWsA = ((n: { status?: string; project?: string }) =>
        n.status !== 'archived' && n.project === 'ws-a') as never;
    const prov = new Map<string, { matchedBy: Set<MatchKind>; score: number }>();
    const seedResult = (id: string, score: number): [string, RR] =>
        [id, { node: NODES[id]! as never, score, matchedBy: ['semantic'], depth: 0, source: 'seed' } as RR];

    await test('spillover exhausted before limit: returns short of limit, no throw, no invalid padding', async () => {
        const collected = new Map([seedResult('a', 0.9)]);
        // Only c1 is usable; deadNoSuccessor has no resolvable successor, archivedOnly's
        // successor is itself archived (rejected by admit). Requesting limit=5 but only
        // 2 real seeds + 1 admissible spillover candidate exist.
        const spill = [NODES.c1!, NODES.deadNoSuccessor!, NODES.archivedOnly!] as never[];
        const out = await refillSeedSlots(collected, spill, 5, graph, admitWsA, prov);
        const depth0 = [...out.values()].filter((r) => r.depth === 0).map((r) => r.node.id);
        assert.deepEqual(depth0, ['a', 'c1'], `expected exactly the admissible fill, got ${JSON.stringify(depth0)}`);
        assert.ok(depth0.length < 5, 'must not pretend to reach limit when candidates ran out');
        assert.ok(!depth0.includes('deadNoSuccessor') && !depth0.includes('ghost'), 'no dangling/invalid entries');
        assert.ok(!depth0.includes('archivedOnly') && !depth0.includes('arch'), 'archived successor never admitted');
    });

    await test('a superseded spillover candidate whose successor is outside the admit predicate\'s workspace is skipped, not inserted', async () => {
        const collected = new Map([seedResult('a', 0.9)]);
        const spill = [NODES.crossWsSuperseded!, NODES.c2!] as never[];
        const out = await refillSeedSlots(collected, spill, 3, graph, admitWsA, prov);
        const depth0 = [...out.values()].filter((r) => r.depth === 0).map((r) => r.node.id);
        assert.deepEqual(depth0, ['a', 'c2'], `cross-workspace successor leaked: ${JSON.stringify(depth0)}`);
        assert.ok(!depth0.includes('crossWsSuccessor'), 'out-of-workspace successor must never be admitted');
    });

    await test('all spillover candidates inadmissible: map unchanged apart from existing seeds', async () => {
        const collected = new Map([seedResult('a', 0.9)]);
        const spill = [NODES.deadNoSuccessor!, NODES.archivedOnly!, NODES.crossWsSuperseded!] as never[];
        const out = await refillSeedSlots(collected, spill, 4, graph, admitWsA, prov);
        assert.deepEqual([...out.keys()], ['a'], `expected no fill at all, got ${JSON.stringify([...out.keys()])}`);
    });
}

/* ─── 2. re-save rule — enforcement OFF ──────────────────────────────── */
console.log('\nD5 follow-ups — re-save rule: enforcement off skips the check entirely');
{
    const decision = (content: string) => ({ type: 'decision', label: 'L', content });
    const graphNoEdges = {
        async getNode(id: string) { return { id }; },
        async queryEdges() { return []; },
    } as never;

    await test('enforcement OFF: a brand-new node missing supersedes is NOT refused', async () => {
        const r = await runSupersessionValidation({
            supersessionPolicy: { enforce: false },
            findSupersessionDuplicate: undefined, force: false, supersedes: undefined,
            id: 'brand-new', nodeData: decision('no supersedes declared'), targetGraph: graphNoEdges,
        });
        assert.equal(r.ok, true, JSON.stringify(r));
    });

    await test('enforcement OFF: a resave of a node with existing supersedes edges also passes (same as ON, redundant but must not regress)', async () => {
        const existing = new Set(['dec-1']);
        const graphWithEdges = {
            async getNode(id: string) { return existing.has(id) ? { id } : null; },
            async queryEdges(q: { source?: string }) {
                return q.source === 'dec-1' ? [{ sourceId: 'dec-1', targetId: 'target-a', relation: 'supersedes' }] : [];
            },
        } as never;
        const r = await runSupersessionValidation({
            supersessionPolicy: { enforce: false },
            findSupersessionDuplicate: undefined, force: false, supersedes: undefined,
            id: 'dec-1', nodeData: decision('edited body'), targetGraph: graphWithEdges,
        });
        assert.equal(r.ok, true, JSON.stringify(r));
    });

    await test('control: the SAME missing-supersedes new node IS refused when enforcement is ON', async () => {
        const r = await runSupersessionValidation({
            supersessionPolicy: { enforce: true },
            findSupersessionDuplicate: undefined, force: false, supersedes: undefined,
            id: 'brand-new', nodeData: decision('no supersedes declared'), targetGraph: graphNoEdges,
        });
        assert.ok(!r.ok && r.code === 'missing_supersedes_field', JSON.stringify(r));
    });

    await test('enforcement OFF: near-duplicate / prose checks are also skipped (whole gate is a no-op)', async () => {
        const r = await runSupersessionValidation({
            supersessionPolicy: { enforce: false },
            findSupersessionDuplicate: async () => ({ hit: { id: 'dup-9', score: 0.99 } }),
            force: false, supersedes: undefined,
            id: 'brand-new', nodeData: decision('now SUPERSEDES other-99'), targetGraph: graphNoEdges,
        });
        assert.equal(r.ok, true, JSON.stringify(r));
    });
}

/* ─── 3. supersession replacement keeps the superseded node's SLOT ───── */
// Bug (pre-fix): replaceSupersededInResults did `out.delete(old); out.set(successor)`,
// which appends the successor at the END of Map insertion order. retrieve()
// and search's legacy workspace="*" path both read final rank straight from
// that insertion order (no downstream re-sort), so a superseded rank-1 hit's
// successor landed near the bottom. Documented choices pinned here:
//  - successor ALREADY present at a lower rank → it MOVES UP into the better
//    (superseded node's) slot; its old lower entry is removed (no duplicate).
//    The moved-up entry takes the slot's rank metadata (score/depth/source,
//    so score stays consistent with position) with matchedBy unioned.
//  - two superseded nodes sharing one successor → successor takes the FIRST
//    (best) slot; the second slot is dropped (refillSeedSlots backfills it).
console.log('\nD5 follow-ups — supersession replacement preserves the slot');
{
    type RR = import('../packages/lore/src/recall/retrieve.js').RetrievalResult;
    const { replaceSupersededInResults, resolveLiveNodes } = await import('../packages/lore/src/recall/supersessionRecall.js');
    const N: Record<string, FNode> = {
        a: fnode('a'), b: fnode('b'), c: fnode('c'), d: fnode('d'), e: fnode('e'),
        old1: fnode('old1', { supersededBy: 'new1' }), new1: fnode('new1'),
        chainA: fnode('chainA', { supersededBy: 'chainB' }), chainB: fnode('chainB', { supersededBy: 'chainC' }), chainC: fnode('chainC'),
        dupA: fnode('dupA', { supersededBy: 'shared' }), dupB: fnode('dupB', { supersededBy: 'shared' }), shared: fnode('shared'),
    };
    const g = fakeGraph(N) as never;
    const build = (ids: string[]) => new Map<string, RR>(ids.map((id, i) => [id, {
        node: N[id]! as never, score: 1 - i * 0.1, matchedBy: [i % 2 ? 'keyword' : 'semantic'], depth: 0, source: 'seed',
    } as RR]));
    const order = async (ids: string[]) => [...(await replaceSupersededInResults(build(ids), g)).keys()];

    await test('superseded node at rank 1 → successor is at rank 1', async () => {
        assert.deepEqual(await order(['old1', 'a', 'b', 'c', 'd']), ['new1', 'a', 'b', 'c', 'd']);
    });
    await test('superseded node mid-list → successor takes that exact slot, others keep order', async () => {
        assert.deepEqual(await order(['a', 'b', 'old1', 'c', 'd']), ['a', 'b', 'new1', 'c', 'd']);
    });
    await test('chain A→B→C at rank 1 → C at rank 1', async () => {
        assert.deepEqual(await order(['chainA', 'a', 'b']), ['chainC', 'a', 'b']);
    });
    await test('successor already present at a lower rank → moves up to the better slot, no duplicate', async () => {
        const out = await replaceSupersededInResults(build(['a', 'old1', 'b', 'new1', 'c']), g);
        assert.deepEqual([...out.keys()], ['a', 'new1', 'b', 'c']);
        const r = out.get('new1')!;
        assert.equal(r.score, 0.9, 'moved-up successor takes the slot score (score stays monotonic with position)');
        assert.deepEqual([...r.matchedBy].sort(), ['keyword'], 'both entries were keyword-matched; still keyword only');
    });
    await test('successor ranked ABOVE its superseded node → stays put, matchedBy still unioned', async () => {
        const out3 = await replaceSupersededInResults(build(['new1', 'old1', 'a']), g); // new1=semantic, old1=keyword
        assert.deepEqual([...out3.keys()], ['new1', 'a']);
        assert.deepEqual([...out3.get('new1')!.matchedBy].sort(), ['keyword', 'semantic']);
    });
    await test('successor present lower, matchedBy differs → union recorded', async () => {
        const out2 = await replaceSupersededInResults(build(['a', 'old1', 'new1']), g); // slot old1=keyword, own new1=semantic
        assert.deepEqual([...out2.keys()], ['a', 'new1']);
        assert.deepEqual([...out2.get('new1')!.matchedBy].sort(), ['keyword', 'semantic']);
    });
    await test('two superseded nodes share one successor → successor at the first slot, second slot dropped', async () => {
        assert.deepEqual(await order(['a', 'dupA', 'b', 'dupB', 'c']), ['a', 'shared', 'b', 'c']);
    });
    await test('resolveLiveNodes (flat surfaces): successor present lower moves up, same rule', async () => {
        const ids = (await resolveLiveNodes(['a', 'old1', 'b', 'new1'].map((id) => N[id]!) as never, g)).map((n) => n.id);
        assert.deepEqual(ids, ['a', 'new1', 'b']);
    });
    await test('resolveLiveNodes: rank-1 superseded + shared successor keep slots in place', async () => {
        const ids = (await resolveLiveNodes(['old1', 'dupA', 'a', 'dupB'].map((id) => N[id]!) as never, g)).map((n) => n.id);
        assert.deepEqual(ids, ['new1', 'shared', 'a']);
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

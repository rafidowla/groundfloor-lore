#!/usr/bin/env tsx
/**
 * r3-ecosystem-settlement-unit.ts — one meaning of `'*'`, and a correctness
 * backstop that is not gated on how full the primary result looked.
 *
 *   D1 — THE FALL-THROUGH STILL HAD A THRESHOLD. Round 2's fix for
 *        "multi-tenant crowding" moved the entry condition from
 *        `seedNodeIds.length === 0` to `seeds.length === 0` — which is still
 *        gated on the primary result, the very thing
 *        `ecosystemSeedUnion.ts:49` says must not gate a correctness path
 *        ("A correctness backstop cannot be gated on how full the primary
 *        result looked"). A SINGLE surviving seed suppressed the DB-scoped
 *        keyword branch entirely. Reproduced below: alpha holds 3 nodes (one
 *        with correct verbatim metadata, two legacy rows whose verbatim COPY
 *        of `ecosystem` says '*'), beta holds 40 embedded rows that dominate
 *        the top-K. betaHasVectors=false → [a1,a2,a3]; betaHasVectors=true →
 *        [a1]. `graph.search(q, limit, '*', 'alpha')` would have returned all
 *        three. The crowding failure survived in partial form.
 *
 *   D2 — TWO INCOMPATIBLE READINGS OF `'*'` SHIPPED IN ONE ROUND.
 *        `retrieve.ts` (seed filter + per-hop filter) read a node's `'*'` as a
 *        distinct value matching nothing, and that reading was widened to the
 *        MCP `search` tool, GET /api/search and POST /api/query. The SAME
 *        round's `engines/reconnect.ts` `ecosystemConfinement` and the new
 *        `supersessionCandidates.ts` read `'*'` as a WILDCARD matching
 *        everything. Meanwhile the write side DEFAULTS to `'*'`
 *        (`postNode.ts`, `normaliseBulkNodeScope`, and the
 *        `LoreNode.ecosystem` column DEFAULT), so on any install where
 *        `register_project` set a concrete ecosystem, every node written
 *        without an explicit one was invisible to all four read surfaces while
 *        autolink still linked it and supersession still paired it.
 *
 *        Settled in `core/ecosystemMatch.ts`: `'*'`/`''` is a WILDCARD on both
 *        sides. These tests pin that ONE meaning across the JS decision points
 *        AND the database pushdowns, so the two readings cannot drift apart
 *        again.
 *
 * License: original work for groundfloor-lore.
 */

import assert from 'node:assert/strict';
import { retrieve, type RetrieveContext } from '../packages/lore/src/recall/retrieve.js';
import { ecosystemMatches, isCrossEcosystemPair, isUnscopedEcosystem } from '../packages/lore/src/core/ecosystemMatch.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type Node = { id: string; type: string; label: string; content: string; tags: string[]; project: string; ecosystem: string; updatedAt: string };
const node = (id: string, ecosystem: string): Node => ({
    id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'w', ecosystem,
    updatedAt: '2026-06-01T00:00:00.000Z',
});

/**
 * A workspace shared by two ecosystems.
 *
 *   alpha — a1 (verbatim metadata correctly says 'alpha')
 *           a2, a3 (LEGACY rows: the graph node says 'alpha', the verbatim
 *                   metadata copy says '*' — the exact drift
 *                   core/bulkNodeScope.ts documents)
 *   beta  — 40 embedded rows, which fill any fixed top-K window first.
 */
function crowdedFixture(betaHasVectors: boolean): {
    ctx: RetrieveContext;
    calls: { graphSearchScopes: Array<{ project: string; ecosystem: string }> };
} {
    const graphNodes: Record<string, Node> = {
        a1: node('a1', 'alpha'), a2: node('a2', 'alpha'), a3: node('a3', 'alpha'),
    };
    for (let i = 0; i < 40; i++) graphNodes[`b${i}`] = node(`b${i}`, 'beta');

    // The verbatim row's metadata COPY of ecosystem — which is what a pushdown
    // filter can see, and what can be stale.
    const verbatimEco: Record<string, string> = { a1: 'alpha', a2: '*', a3: '*' };
    for (let i = 0; i < 40; i++) verbatimEco[`b${i}`] = 'beta';

    const allIds = betaHasVectors
        ? [...Array.from({ length: 40 }, (_, i) => `b${i}`), 'a1', 'a2', 'a3']
        : ['a1', 'a2', 'a3'];

    const calls = { graphSearchScopes: [] as Array<{ project: string; ecosystem: string }> };
    const graph = {
        async search(_q: string, _n: number, project: string, ecosystem: string) {
            calls.graphSearchScopes.push({ project, ecosystem });
            // A store honouring the pushdown, with the SETTLED meaning: '*' on
            // the row is a wildcard.
            return Object.values(graphNodes).filter((n) => ecosystemMatches(n.ecosystem, ecosystem)) as never;
        },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, Node>();
            for (const id of ids) { const n = graphNodes[id]; if (n) m.set(id, n); }
            return m as never;
        },
        async traverse() { return [] as never; },
    };
    const hitList = (limit: number, filter?: { ecosystem?: string }) =>
        allIds
            .filter((id) => !filter?.ecosystem || verbatimEco[id] === filter.ecosystem)
            .slice(0, limit)
            .map((id, i) => ({ id: `lore:${id}`, score: 0.9 - i * 0.001 }));
    const ctx = {
        store: {
            loreGraph: graph,
            sessionCache: { pushNode() { /* noop */ } },
            storageClient: {
                async verbatimCount() { return allIds.length; },
                async verbatimSearch(_q: string, n: number, filter?: { ecosystem?: string }) { return hitList(n, filter) as never; },
                async verbatimBm25Search(_q: string, n: number, filter?: { ecosystem?: string }) { return { hits: hitList(n, filter), ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
    return { ctx, calls };
}

console.log('\nOne meaning of "*", and an ungated correctness backstop\n');

/* ─── D1: the fall-through must not be gated on a full-looking result ──── */

await test('D1: baseline — with NO foreign vectors, alpha recalls all three of its nodes', async () => {
    const { ctx } = crowdedFixture(false);
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'alpha', limit: 10 });
    assert.deepEqual(out.results.map((r) => r.node.id).sort(), ['a1', 'a2', 'a3']);
});

await test('D1: a foreign ecosystem getting embedded must NOT cost alpha 2 of its 3 nodes', async () => {
    // Identical alpha data, identical query. The ONLY change is that an
    // unrelated tenant's rows are now in the same workspace's vector index.
    const { ctx } = crowdedFixture(true);
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'alpha', limit: 10 });
    assert.deepEqual(
        out.results.map((r) => r.node.id).sort(), ['a1', 'a2', 'a3'],
        'a SINGLE surviving seed suppressed the DB-scoped keyword branch, silently losing 2/3 of the ecosystem\'s own nodes',
    );
});

await test('D1: the fall-through runs the keyword branch DB-SCOPED to the ecosystem', async () => {
    const { ctx, calls } = crowdedFixture(true);
    await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'alpha', limit: 10 });
    assert.ok(calls.graphSearchScopes.length > 0, 'the keyword branch must have run');
    assert.ok(
        calls.graphSearchScopes.every((s) => s.ecosystem === 'alpha' && s.project === '*'),
        `the scoped keyword branch is the point of the fall-through: ${JSON.stringify(calls.graphSearchScopes)}`,
    );
});

await test('D1: no foreign node rides in on the fall-through', async () => {
    const { ctx } = crowdedFixture(true);
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'alpha', limit: 10 });
    assert.ok(out.results.every((r) => !r.node.id.startsWith('b')), 'the backstop must widen recall, never the boundary');
});

await test('D1: the keyword branch still runs AT MOST once', async () => {
    const { ctx, calls } = crowdedFixture(true);
    await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'alpha', limit: 10 });
    assert.equal(calls.graphSearchScopes.length, 1, 'a full-table scan must not be run twice per recall');
});

await test("D1: search-everything ('*') gains the same supplementary scan — it widens, never confines (Cluster 5a)", async () => {
    // This test pinned the PRE-Cluster-5a control flow ("'*' must not gain a
    // full-table keyword scan") until Finding 5.1 (c9b2bf1) made the bounded
    // keyword scan run on EVERY vector-seeded recall, deliberately including
    // the unscoped default: an embed:false node has no vector row under '*'
    // either. The scan here is DB-scoped to '*', so it cannot confine — it
    // can only add nodes the vector window missed. Updated 2026-08-19.
    const { ctx, calls } = crowdedFixture(true);
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, limit: 10 });
    assert.deepEqual(
        calls.graphSearchScopes, [{ project: '*', ecosystem: '*' }],
        "exactly one supplementary scan, scoped to '*' (search-everything) — never a second, never narrower",
    );
    assert.ok(out.results.length > 0);
});

/* ─── D2: one meaning of '*' ──────────────────────────────────────────── */

await test('D2: the shared predicate — a node stored "*"/"" is unscoped and matches any scope', async () => {
    assert.equal(ecosystemMatches('*', 'alpha'), true);
    assert.equal(ecosystemMatches('', 'alpha'), true);
    assert.equal(ecosystemMatches(undefined, 'alpha'), true);
    assert.equal(ecosystemMatches('alpha', 'alpha'), true);
    assert.equal(ecosystemMatches('beta', 'alpha'), false, 'two CONCRETE ecosystems are still kept apart');
    assert.equal(ecosystemMatches('beta', '*'), true, "a '*' SCOPE is still search-everything");
    assert.equal(isUnscopedEcosystem('*'), true);
    assert.equal(isUnscopedEcosystem('alpha'), false);
});

await test('D2: the pair form agrees with it (reconnect + supersession-candidates)', async () => {
    assert.equal(isCrossEcosystemPair('alpha', 'beta'), true);
    assert.equal(isCrossEcosystemPair('alpha', '*'), false, "an unscoped endpoint pairs with anything — reconnect.ts's documented decision");
    assert.equal(isCrossEcosystemPair('alpha', 'alpha'), false);
});

await test('D2: retrieve() SEEDS agree — a "*" node is returned by a concrete-ecosystem recall', async () => {
    // This is the node every `POST /api/node` without an explicit ecosystem
    // becomes. Under the old strict reading it was invisible to its owner.
    const graphNodes: Record<string, Node> = { global: node('global', '*'), mine: node('mine', 'alpha') };
    const ctx = {
        store: {
            loreGraph: {
                async search(_q: string, _n: number, _p: string, eco: string) {
                    return Object.values(graphNodes).filter((n) => ecosystemMatches(n.ecosystem, eco)) as never;
                },
                async getNodesByIds(ids: string[]) {
                    const m = new Map<string, Node>();
                    for (const id of ids) { const n = graphNodes[id]; if (n) m.set(id, n); }
                    return m as never;
                },
                async traverse() { return [] as never; },
            },
            sessionCache: { pushNode() { /* noop */ } },
            storageClient: {
                async verbatimCount() { return 2; },
                async verbatimSearch() { return [{ id: 'lore:global', score: 0.9 }, { id: 'lore:mine', score: 0.8 }] as never; },
                async verbatimBm25Search() { return { hits: [{ id: 'lore:global', score: 5 }], ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'alpha', limit: 10 });
    assert.deepEqual(
        out.results.map((r) => r.node.id).sort(), ['global', 'mine'],
        "a '*' node is the DEFAULT of every write path — hiding it from its owner's recall is silent data loss",
    );
});

await test('D2: retrieve() HOPS agree — a "*" neighbour is kept, a foreign one is not', async () => {
    const seed = node('seed', 'alpha');
    const ctx = {
        store: {
            loreGraph: {
                async search() { return [seed] as never; },
                async getNodesByIds() { return new Map([['seed', seed]]) as never; },
                async traverse() {
                    return [
                        { node: node('hop-global', '*'), depth: 1 },
                        { node: node('hop-foreign', 'beta'), depth: 1 },
                        { node: node('hop-mine', 'alpha'), depth: 1 },
                    ] as never;
                },
            },
            sessionCache: { pushNode() { /* noop */ } },
            storageClient: {
                async verbatimCount() { return 0; },
                async verbatimSearch() { return [] as never; },
                async verbatimBm25Search() { return { hits: [], ranked: true } as never; },
            },
        },
    } as unknown as RetrieveContext;
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 1, ecosystem: 'alpha', limit: 10 });
    const ids = out.results.map((r) => r.node.id).sort();
    assert.deepEqual(ids, ['hop-global', 'hop-mine', 'seed'], `hop filter disagrees with the seed filter: ${ids.join(', ')}`);
});

await test('D2: two CONCRETE ecosystems are still isolated — the settlement is not a switch-off', async () => {
    const { ctx } = crowdedFixture(true);
    const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0, ecosystem: 'alpha', limit: 50 });
    assert.ok(
        out.results.every((r) => !r.node.id.startsWith('b')),
        'beta nodes name a concrete, different ecosystem and must never appear in an alpha recall',
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

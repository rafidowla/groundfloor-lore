#!/usr/bin/env tsx
/**
 * test/recall-link-ordering-unit.ts - D4: recall's related expansion ordered by link strength, behind
 * LORE_RECALL_LINK_ORDERING (default off). Same cases on SQLite and, when LORE_PG_URL names a throwaway server, Postgres.
 *
 *   parity    flag off (unset / "0" / opts false): collectRelated output is exactly the pre-change algorithm's
 *   order     flag on: strength desc, then label, then id; both edge directions; the strongest of several edges counts
 *   live      a soft-invalidated edge neither ranks nor surfaces a hop
 *   cap       flag on returns the SAME set as flag off (pure reorder; no hop added or dropped)
 *   env       the env flag drives it when opts.linkOrdering is unset
 *   fallback  a graph without queryEdges keeps traversal order
 *
 * Run: npx tsx test/recall-link-ordering-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { collectRelated } from '../packages/lore/src/recall/retrieveRelated.js';
import { linkOrderingEnabled } from '../packages/lore/src/recall/linkOrdering.js';
import { cleanupGateWorkspaces, closeGatePool, createGatePool } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const REL = 'semantic_neighbor';
const node = (id: string, label = id) => ({ id, type: 'note', label, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;

type G = SqliteGraph | PostgresGraph;
const engines: Array<{ name: string; open: () => Promise<G> }> = [{
    name: 'sqlite',
    open: async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rlo-')); dirs.push(base);
        const g = new SqliteGraph(base, { workspaceId: 'rlo' }); await g.initialize(); return g;
    },
}];
const gatePool = await createGatePool('recall-link-ordering');
if (gatePool) {
    await cleanupGateWorkspaces(gatePool);
    let seq = 0;
    engines.push({ name: 'postgres', open: async () => { const g = new PostgresGraph(`pg-gate-rlo-${process.pid}-${seq++}`, gatePool); await g.initialize(); return g; } });
}

const edge = (g: G, s: string, t: string, score: number, relation = REL) =>
    g.addEdge({ sourceId: s, targetId: t, relation, confidence: 'inferred', confidenceScore: score } as never);

/** Seed `s`; neighbours (id,label,score,direction). Labels are chosen so label order disagrees with id order. */
async function fixture(g: G) {
    await g.upsertNode(node('s'));
    const hops: Array<[string, string, number, 'out' | 'in']> = [
        ['n1', 'mid', 0.82, 'out'],
        ['n2', 'zeta', 0.95, 'out'],   // tie with n3 on score: label decides (alpha < zeta)
        ['n3', 'alpha', 0.95, 'in'],   // stored as n3 -> s: direction must not matter
        ['n4', 'low', 0.80, 'out'],
        ['n5', 'same', 0.90, 'out'],   // tie with n6 on score AND label: id decides
        ['n6', 'same', 0.90, 'out'],
    ];
    for (const [id, label, score, dir] of hops) {
        await g.upsertNode(node(id, label));
        await (dir === 'out' ? edge(g, 's', id, score) : edge(g, id, 's', score));
    }
    await edge(g, 's', 'n4', 0.99, 'related_to'); // a stronger edge of another relation to n4: the strongest edge counts
    return hops;
}
const direct = (g: G) => g.getNode('s').then((n) => new Map([['s', { node: n!, score: 1, matchedBy: ['x'], depth: 0, source: 'seed' }]])) as Promise<never>;
const opts = (g: G, extra: Record<string, unknown> = {}) => ({ depth: 1, filterByActorScope: (n: never[]) => n, hopAllowed: () => true, replaceSuperseded: false, admit: (() => true) as never, ...extra }) as never;
const ids = (m: Map<string, { node: { id: string } }>): string[] => [...m.values()].map((r) => r.node.id);

for (const eng of engines) {
    console.log(`\n${eng.name}`);
    await test('flag off (unset, "0", opts false) is exactly the pre-change expansion: traverse order, same scores', async () => {
        const g = await eng.open(); await fixture(g);
        const d = await direct(g);
        const expected = (await g.traverse('s', 1)).map((h) => ({ id: h.node.id, via: 's', relation: h.relation, depth: h.depth, score: 0.3 / (1 + h.depth) }));
        const norm = (m: Map<string, unknown>) => [...(m as Map<string, { node: { id: string }; via: string; relation: string; depth: number; score: number }>).values()].map((r) => ({ id: r.node.id, via: r.via, relation: r.relation, depth: r.depth, score: r.score }));
        const saved = process.env.LORE_RECALL_LINK_ORDERING;
        try {
            delete process.env.LORE_RECALL_LINK_ORDERING;
            assert.deepEqual(norm(await collectRelated(d, g as never, opts(g))), expected);
            process.env.LORE_RECALL_LINK_ORDERING = '0';
            assert.deepEqual(norm(await collectRelated(d, g as never, opts(g))), expected);
            process.env.LORE_RECALL_LINK_ORDERING = '1';
            assert.deepEqual(norm(await collectRelated(d, g as never, opts(g, { linkOrdering: false }))), expected, 'explicit opts wins over env');
        } finally { if (saved === undefined) delete process.env.LORE_RECALL_LINK_ORDERING; else process.env.LORE_RECALL_LINK_ORDERING = saved; }
    });

    await test('flag on: strength desc (both directions, strongest edge), then label, then id', async () => {
        const g = await eng.open(); await fixture(g);
        const got = ids(await collectRelated(await direct(g), g as never, opts(g, { linkOrdering: true })) as never);
        // n4 has a 0.99 related_to edge -> first; then 0.95 tie (alpha n3 before zeta n2); 0.90 tie same label -> id n5,n6; then 0.82, (0.80 n4 already first)
        assert.deepEqual(got, ['n4', 'n3', 'n2', 'n5', 'n6', 'n1']);
    });

    await test('flag on returns the SAME set as flag off (pure reorder: the per-memory cap and node cap are untouched)', async () => {
        const g = await eng.open(); await fixture(g);
        const d = await direct(g);
        const off = ids(await collectRelated(d, g as never, opts(g, { linkOrdering: false })) as never);
        const on = ids(await collectRelated(d, g as never, opts(g, { linkOrdering: true })) as never);
        assert.deepEqual([...on].sort(), [...off].sort());
        assert.equal(on.length, 6);
    });

    await test('live only: a soft-invalidated edge neither ranks nor surfaces its hop', async () => {
        const g = await eng.open(); await fixture(g);
        assert.equal(await g.invalidateEdges([{ sourceId: 's', targetId: 'n2', relation: REL }] as never, new Date().toISOString()), 1);
        const got = ids(await collectRelated(await direct(g), g as never, opts(g, { linkOrdering: true })) as never);
        assert.ok(!got.includes('n2'), 'invalidated edge no longer expands');
        assert.deepEqual(got, ['n4', 'n3', 'n5', 'n6', 'n1']);
    });

    await test('env flag drives ordering when opts.linkOrdering is unset', async () => {
        const g = await eng.open(); await fixture(g);
        const saved = process.env.LORE_RECALL_LINK_ORDERING;
        try {
            process.env.LORE_RECALL_LINK_ORDERING = 'true';
            assert.equal(linkOrderingEnabled(), true);
            assert.deepEqual(ids(await collectRelated(await direct(g), g as never, opts(g)) as never), ['n4', 'n3', 'n2', 'n5', 'n6', 'n1']);
        } finally { if (saved === undefined) delete process.env.LORE_RECALL_LINK_ORDERING; else process.env.LORE_RECALL_LINK_ORDERING = saved; }
    });

    await test('a graph without queryEdges keeps traversal order (no crash)', async () => {
        const g = await eng.open(); await fixture(g);
        const bare = { traverse: g.traverse.bind(g), getNodesByIds: g.getNodesByIds.bind(g) };
        const on = ids(await collectRelated(await direct(g), bare as never, opts(g, { linkOrdering: true })) as never);
        const off = ids(await collectRelated(await direct(g), bare as never, opts(g, { linkOrdering: false })) as never);
        assert.deepEqual(on, off);
    });
}
assert.equal(linkOrderingEnabled({} as never), false, 'default off');
assert.equal(linkOrderingEnabled({ LORE_RECALL_LINK_ORDERING: 'off' } as never), false);

if (gatePool) { await cleanupGateWorkspaces(gatePool); await closeGatePool(gatePool); } else console.log('\n(postgres skipped: LORE_PG_URL not set)');
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

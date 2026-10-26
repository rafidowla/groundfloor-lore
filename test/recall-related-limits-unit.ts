#!/usr/bin/env tsx
/**
 * test/recall-related-limits-unit.ts - C1: the two optional trims on recall's related[] list.
 *
 *   resolve   option (incl. null = off) > env > off; bad env is ignored, bad option throws RangeError
 *   cap       LORE_RECALL_RELATED_PER_HIT keeps each hit's N strongest neighbours (after link ordering); unset = unchanged
 *   hub       LORE_RECALL_RELATED_MAX_DEGREE drops neighbours with more than N live edges (either direction, live only)
 *   combined  hub drops happen before the cap fills, so a hub never wastes a slot
 *   primary   a hub that is a direct hit stays a direct hit (collectRelated never touches the direct map)
 *   bounded   degree is measured with queryEdges reads limited to maxDegree+1 rows (no scan)
 *   fallback  a graph without queryEdges: no crash, nothing dropped
 *
 * Same cases on SQLite and, when LORE_PG_URL names a throwaway server, Postgres.
 * Run: LORE_HOME=$(mktemp -d) LORE_MODEL_SERVER=0 npx tsx test/recall-related-limits-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { collectRelated } from '../packages/lore/src/recall/retrieveRelated.js';
import { exceedsDegree, parseRecallRelatedOption, resolveRelatedLimits } from '../packages/lore/src/recall/relatedLimits.js';
import { cleanupGateWorkspaces, closeGatePool, createGatePool } from './helpers/testPostgres.js';

delete process.env.LORE_RECALL_LINK_ORDERING;
delete process.env.LORE_RECALL_RELATED_PER_HIT;
delete process.env.LORE_RECALL_RELATED_MAX_DEGREE;

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const REL = 'semantic_neighbor';
const node = (id: string, label = id) => ({ id, type: 'note', label, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;

console.log('\nresolve');
await test('option > env > off; null forces off; bad env ignored', () => {
    assert.deepEqual(resolveRelatedLimits(undefined, {} as never), {});
    assert.deepEqual(resolveRelatedLimits(undefined, { LORE_RECALL_RELATED_PER_HIT: '3', LORE_RECALL_RELATED_MAX_DEGREE: ' 20 ' } as never), { perHit: 3, maxDegree: 20 });
    assert.deepEqual(resolveRelatedLimits({ perHit: 2 }, { LORE_RECALL_RELATED_PER_HIT: '3' } as never), { perHit: 2 });
    assert.deepEqual(resolveRelatedLimits({ perHit: null, maxDegree: 9 }, { LORE_RECALL_RELATED_PER_HIT: '3', LORE_RECALL_RELATED_MAX_DEGREE: '20' } as never), { maxDegree: 9 });
    for (const bad of ['0', '-1', '1.5', 'abc', '', ' ']) assert.deepEqual(resolveRelatedLimits(undefined, { LORE_RECALL_RELATED_PER_HIT: bad, LORE_RECALL_RELATED_MAX_DEGREE: bad } as never), {}, `"${bad}" is off`);
});
await test('parseRecallRelatedOption validates', () => {
    assert.equal(parseRecallRelatedOption(undefined), undefined);
    assert.deepEqual(parseRecallRelatedOption({ perHit: 2, maxDegree: null }), { perHit: 2, maxDegree: null });
    for (const bad of [{ perHit: 0 }, { perHit: 1.5 }, { maxDegree: -3 }, { maxDegree: '3' }, { perHit: NaN }]) assert.throws(() => parseRecallRelatedOption(bad as never), RangeError);
    assert.throws(() => parseRecallRelatedOption(5 as never), RangeError);
});

type G = SqliteGraph | PostgresGraph;
const engines: Array<{ name: string; open: () => Promise<G> }> = [{
    name: 'sqlite',
    open: async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rrl-')); dirs.push(base);
        const g = new SqliteGraph(base, { workspaceId: 'rrl' }); await g.initialize(); return g;
    },
}];
const gatePool = await createGatePool('recall-related-limits');
if (gatePool) {
    await cleanupGateWorkspaces(gatePool);
    let seq = 0;
    engines.push({ name: 'postgres', open: async () => { const g = new PostgresGraph(`pg-gate-rrl-${process.pid}-${seq++}`, gatePool); await g.initialize(); return g; } });
}
const edge = (g: G, s: string, t: string, score: number, relation = REL) =>
    g.addEdge({ sourceId: s, targetId: t, relation, confidence: 'inferred', confidenceScore: score } as never);
const opts = (extra: Record<string, unknown> = {}) => ({ depth: 1, filterByActorScope: (n: never[]) => n, hopAllowed: () => true, replaceSuperseded: false, admit: (() => true) as never, ...extra }) as never;
const ids = (m: Map<string, { node: { id: string }; via: string }>): string[] => [...m.values()].map((r) => r.node.id);
const directOf = async (g: G, seeds: string[]) => new Map(await Promise.all(seeds.map(async (id) => [id, { node: (await g.getNode(id))!, score: 1, matchedBy: ['x'], depth: 0, source: 'seed' }] as const))) as never;

/** Seed `s` with strongest-first neighbours a(0.99) b(0.95) c(0.90) d(0.85) e(0.80). */
async function fixture(g: G) {
    await g.upsertNode(node('s'));
    for (const [id, sc] of [['a', 0.99], ['b', 0.95], ['c', 0.90], ['d', 0.85], ['e', 0.80]] as const) { await g.upsertNode(node(id)); await edge(g, 's', id, sc); }
}
/** Give `id` `n` extra live edges to throwaway nodes (so its degree is 1 + n). */
async function inflate(g: G, id: string, n: number, dir: 'out' | 'in' = 'out') {
    for (let i = 0; i < n; i++) {
        const x = `${id}-x${i}`; await g.upsertNode(node(x));
        await (dir === 'out' ? edge(g, id, x, 0.9, 'related_to') : edge(g, x, id, 0.9, 'related_to'));
    }
}

for (const eng of engines) {
    console.log(`\n${eng.name}`);
    await test('limits unset: related[] unchanged (all five, ordered by strength)', async () => {
        const g = await eng.open(); await fixture(g);
        assert.deepEqual(ids(await collectRelated(await directOf(g, ['s']), g as never, opts()) as never), ['a', 'b', 'c', 'd', 'e']);
    });

    await test('perHit keeps the N strongest after ordering, per hit', async () => {
        const g = await eng.open(); await fixture(g);
        const got = await collectRelated(await directOf(g, ['s']), g as never, opts({ relatedLimits: { perHit: 2 } })) as never;
        assert.deepEqual(ids(got), ['a', 'b']);
        // ordering off: the cap keeps the first N in traversal order instead (still exactly N)
        const off = await collectRelated(await directOf(g, ['s']), g as never, opts({ linkOrdering: false, relatedLimits: { perHit: 2 } })) as never;
        assert.equal(ids(off).length, 2);
    });

    await test('perHit applies to every primary hit separately', async () => {
        const g = await eng.open(); await fixture(g);
        await g.upsertNode(node('t'));
        for (const [id, sc] of [['u', 0.9], ['v', 0.8], ['w', 0.7]] as const) { await g.upsertNode(node(id)); await edge(g, 't', id, sc); }
        const got = await collectRelated(await directOf(g, ['s', 't']), g as never, opts({ relatedLimits: { perHit: 2 } })) as never;
        const bySeed = (via: string) => [...(got as Map<string, { node: { id: string }; via: string }>).values()].filter((r) => r.via === via).map((r) => r.node.id);
        assert.deepEqual(bySeed('s'), ['a', 'b']);
        assert.deepEqual(bySeed('t'), ['u', 'v']);
    });

    await test('maxDegree drops a hub neighbour (degree counted in both directions); boundary: degree == max stays', async () => {
        const g = await eng.open(); await fixture(g);
        await inflate(g, 'a', 5, 'out');   // a: 1 (to s) + 5 = 6
        await inflate(g, 'b', 5, 'in');    // b: 1 + 5 = 6, other direction
        await inflate(g, 'c', 4, 'out');   // c: 1 + 4 = 5 (== max, stays)
        const got = await collectRelated(await directOf(g, ['s']), g as never, opts({ relatedLimits: { maxDegree: 5 } })) as never;
        assert.deepEqual(ids(got), ['c', 'd', 'e']);
    });

    await test('maxDegree counts live edges only: a soft-invalidated edge does not make a hub', async () => {
        const g = await eng.open(); await fixture(g);
        await inflate(g, 'a', 5, 'out');
        assert.equal(await g.invalidateEdges([{ sourceId: 'a', targetId: 'a-x0', relation: 'related_to' }, { sourceId: 'a', targetId: 'a-x1', relation: 'related_to' }] as never, new Date().toISOString()), 2);
        // a now has 1 + 3 = 4 live edges
        assert.deepEqual(ids(await collectRelated(await directOf(g, ['s']), g as never, opts({ relatedLimits: { maxDegree: 4 } })) as never), ['a', 'b', 'c', 'd', 'e']);
        assert.deepEqual(ids(await collectRelated(await directOf(g, ['s']), g as never, opts({ relatedLimits: { maxDegree: 3 } })) as never), ['b', 'c', 'd', 'e']);
    });

    await test('combined: a hub never uses up a per-hit slot (cap fills from the non-hubs)', async () => {
        const g = await eng.open(); await fixture(g);
        await inflate(g, 'a', 10);
        const got = await collectRelated(await directOf(g, ['s']), g as never, opts({ relatedLimits: { perHit: 2, maxDegree: 5 } })) as never;
        assert.deepEqual(ids(got), ['b', 'c']);
    });

    await test('a hub that is a primary hit stays a primary hit (only related[] is trimmed)', async () => {
        const g = await eng.open(); await fixture(g);
        await inflate(g, 'a', 10);
        const direct = await directOf(g, ['s', 'a']);
        const got = await collectRelated(direct, g as never, opts({ relatedLimits: { maxDegree: 3, perHit: 1 } })) as never;
        assert.ok(!ids(got).includes('a'), 'a direct hit is never also a neighbour');
        assert.deepEqual([...(direct as Map<string, unknown>).keys()], ['s', 'a'], 'direct map untouched');
    });

    await test('exceedsDegree reads are bounded by maxDegree+1 rows', async () => {
        const g = await eng.open(); await fixture(g);
        await inflate(g, 'a', 30);
        const limits: number[] = [];
        const spy = { queryEdges: (q: { limit: number }) => { limits.push(q.limit); return (g as never as { queryEdges(q: unknown): Promise<never[]> }).queryEdges(q); } };
        assert.equal(await exceedsDegree(spy as never, 'a', 5), true);
        assert.ok(limits.length >= 1 && limits.every((l) => l <= 6), `limits ${limits}`);
        assert.equal(await exceedsDegree(spy as never, 'e', 5), false);
        assert.equal(await exceedsDegree(spy as never, 'a', 31), false, 'degree 31 is not above 31');
        assert.equal(await exceedsDegree(spy as never, 'a', 30), true);
    });

    await test('a graph without queryEdges: no crash, nothing dropped', async () => {
        const g = await eng.open(); await fixture(g); await inflate(g, 'a', 10);
        const bare = { traverse: g.traverse.bind(g), getNodesByIds: g.getNodesByIds.bind(g) };
        const got = await collectRelated(await directOf(g, ['s']), bare as never, opts({ relatedLimits: { maxDegree: 2 } })) as never;
        assert.ok(ids(got).includes('a'));
    });

    await test('env drives the limits when opts.relatedLimits is unset', async () => {
        const g = await eng.open(); await fixture(g);
        process.env.LORE_RECALL_RELATED_PER_HIT = '3';
        try { assert.deepEqual(ids(await collectRelated(await directOf(g, ['s']), g as never, opts()) as never), ['a', 'b', 'c']); }
        finally { delete process.env.LORE_RECALL_RELATED_PER_HIT; }
    });
}

if (gatePool) { await cleanupGateWorkspaces(gatePool); await closeGatePool(gatePool); } else console.log('\n(postgres skipped: LORE_PG_URL not set)');
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

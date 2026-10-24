#!/usr/bin/env tsx
/**
 * test/link-optout-durable-unit.ts - the durable `autolink:false` opt-out, same cases on SQLite and, when LORE_PG_URL
 * names a throwaway server, Postgres.
 *
 *   store       set / get / clear round-trip, idempotent, chunked for large id lists, survives a reopen, scoped to the
 *               workspace, can be recorded before the node row exists, removed when the node is deleted
 *   both ways   an opted-out node gets no edges as a source and none as a neighbour candidate; a node never shrinks
 *               below top-k while enough eligible neighbours exist (oversample + adaptive widening)
 *   rebuild     skips opted-out nodes as sources and as targets; existing edges that touch one are left alone
 *   migration   (sqlite) live queue-file `link_optout` rows move into the workspace store on first touch, expired
 *               non-sticky rows are dropped, the move is idempotent, and an explicit true is not undone by a stale row
 *
 * Lifetime through the real write paths (omit keeps, true clears, delete clears, re-save keeps) is in
 * test/link-optout-lifetime-unit.ts; Postgres backup/restore in test/link-optout-durable-pg.ts.
 *
 * Run: npx tsx test/link-optout-durable-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { StoredVectorLinker } from '../packages/lore/src/link/storedVectorLinker.js';
import { LinkRebuilder, type RebuildSubstrate } from '../packages/lore/src/link/linkRebuilder.js';
import { SqliteRebuildStore } from '../packages/lore/src/link/linkRebuildStore.js';
import { SqliteLinkQueue } from '../packages/lore/src/link/sqliteLinkQueue.js';
import { LinkService } from '../packages/lore/src/link/linkService.js';
import { LINK_DEFAULTS, type LinkPolicy } from '../packages/lore/src/link/linkConfig.js';
import { cleanupGateWorkspaces, createGatePool } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const sorted = (s: Iterable<string>): string[] => [...s].sort();

type G = SqliteGraph | PostgresGraph;
interface Eng { name: string; open: (ws?: string) => Promise<G>; reopen: (ws: string) => Promise<G> }
const sqliteBases = new Map<string, string>();
const engines: Eng[] = [{
    name: 'sqlite',
    open: async (ws = `d-${sqliteBases.size}`) => {
        const base = mkTmp('lod-g-');
        sqliteBases.set(ws, base);
        const g = new SqliteGraph(base, { workspaceId: ws }); await g.initialize(); return g;
    },
    reopen: async (ws) => { const g = new SqliteGraph(sqliteBases.get(ws)!, { workspaceId: ws }); await g.initialize(); return g; },
}];
const gatePool = await createGatePool('link-optout-durable');
if (gatePool) {
    await cleanupGateWorkspaces(gatePool);
    let seq = 0;
    const pgOpen = async (ws: string): Promise<G> => { const g = new PostgresGraph(ws, gatePool); await g.initialize(); return g; };
    engines.push({ name: 'postgres', open: (ws = `pg-gate-lod-${process.pid}-${seq++}`) => pgOpen(ws), reopen: pgOpen });
}

// ---- fake verbatim: in-memory vectors, brute-force cosine; counts kNN calls ----
const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)];
const cos = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]!;
class FakeVerbatim {
    rows = new Map<string, { vec: number[] | null }>();
    knnCalls = 0;
    async getVectors(ids: string[]): Promise<Map<string, number[]>> {
        const m = new Map<string, number[]>();
        for (const id of ids) { const r = this.rows.get(id); if (r?.vec) m.set(id, r.vec); }
        return m;
    }
    async getById(id: string): Promise<{ ecosystem: string } | null> { return this.rows.has(id) ? { ecosystem: '*' } : null; }
    async searchByVector(v: number[], o?: { topK?: number }): Promise<Array<{ id: string; score: number }>> {
        this.knnCalls++;
        return [...this.rows].filter(([, r]) => r.vec).map(([id, r]) => ({ id, score: cos(v, r.vec!) })).sort((x, y) => y.score - x.score).slice(0, o?.topK ?? 10);
    }
    async listIds(prefix?: string): Promise<string[]> { return [...this.rows.keys()].filter((k) => !prefix || k.startsWith(prefix)); }
}
const node = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;
const pol = (k: number, minSim = 0.5): LinkPolicy => ({ minSim, k, dupSim: 0.99999, policyVersion: 'p-test' });
const REL = 'semantic_neighbor';
const WS = 'ws';

async function world(eng: Eng, spec: Array<[string, number]>) {
    const g = await eng.open();
    const vb = new FakeVerbatim();
    for (const [id, deg] of spec) { await g.upsertNode(node(id)); vb.rows.set(`lore:${id}`, { vec: at(deg) }); }
    const linker = (p: LinkPolicy) => new StoredVectorLinker(async () => ({ graph: g as never, verbatim: vb as never }), p, 'fp');
    const pairs = async (): Promise<string[]> => sorted((await g.queryEdges({ relation: REL, limit: 5000, offset: 0 })).map((e: any) => [e.sourceId, e.targetId].sort().join('|')));
    return { g, vb, linker, pairs };
}
const optOut = async (g: G, ids: string[]): Promise<void> => g.setLinkOptOuts(ids, true);
const optedOutOf = async (g: G, ids: string[]): Promise<string[]> => sorted(await g.getLinkOptOuts(ids));

for (const eng of engines) {
    console.log(`\n${eng.name}: store`);

    await test('set / get / clear round-trip; idempotent; unknown ids are simply not opted out', async () => {
        const g = await eng.open();
        await optOut(g, ['a', 'b']);
        await optOut(g, ['a', 'b']); // idempotent
        assert.deepEqual(await optedOutOf(g, ['a', 'b', 'c']), ['a', 'b']);
        await g.setLinkOptOuts(['a', 'never-set'], false);
        assert.deepEqual(await optedOutOf(g, ['a', 'b', 'c']), ['b']);
        assert.deepEqual(await optedOutOf(g, []), []);
    });

    await test('large id lists are chunked correctly (1500 ids)', async () => {
        const g = await eng.open();
        const ids = Array.from({ length: 1500 }, (_, i) => `n${i}`);
        await optOut(g, ids);
        assert.equal((await g.getLinkOptOuts([...ids, 'zz'])).size, 1500);
        await g.setLinkOptOuts(ids.slice(0, 700), false);
        assert.equal((await g.getLinkOptOuts(ids)).size, 800);
    });

    await test('the flag is durable: a reopened store still has it', async () => {
        const ws = eng.name === 'sqlite' ? 'reopen-ws' : `pg-gate-lod-reopen-${process.pid}`;
        const g = await eng.open(ws);
        await optOut(g, ['keep']);
        const g2 = await eng.reopen(ws);
        assert.deepEqual(await optedOutOf(g2, ['keep', 'other']), ['keep']);
    });

    await test('the flag can be recorded before the node row exists and survives the node being created and re-written', async () => {
        const g = await eng.open();
        await optOut(g, ['late']);
        await g.upsertNode(node('late'));
        await g.upsertNode({ ...(node('late') as object), label: 'changed' } as never);
        assert.deepEqual(await optedOutOf(g, ['late']), ['late']);
    });

    await test('deleting the node removes its flag (and only its flag)', async () => {
        const g = await eng.open();
        for (const id of ['x', 'y']) await g.upsertNode(node(id));
        await optOut(g, ['x', 'y']);
        await g.deleteNode('x');
        assert.deepEqual(await optedOutOf(g, ['x', 'y']), ['y']);
        // a re-created node with the same id starts linkable
        await g.upsertNode(node('x'));
        assert.deepEqual(await optedOutOf(g, ['x']), []);
    });

    if (eng.name === 'postgres') {
        await test('postgres: flags are scoped to their workspace', async () => {
            const a = await eng.open(`pg-gate-lod-a-${process.pid}`), b = await eng.open(`pg-gate-lod-b-${process.pid}`);
            await optOut(a, ['same']);
            assert.deepEqual(await optedOutOf(b, ['same']), []);
            assert.deepEqual(await optedOutOf(a, ['same']), ['same']);
        });
    }

    console.log(`\n${eng.name}: both directions`);

    // src sits at 0 deg; 60 opted-out nodes crowd the top of its neighbour list (0.01..0.6 deg); 6 eligible nodes follow (5..10 deg).
    const CROWD: Array<[string, number]> = [['src', 0],
        ...Array.from({ length: 60 }, (_, i): [string, number] => [`o${i}`, 0.01 * (i + 1)]),
        ...Array.from({ length: 6 }, (_, j): [string, number] => [`e${j}`, 5 + j])];
    const crowdOptOuts = CROWD.filter(([id]) => id.startsWith('o')).map(([id]) => id);

    await test('control (no opt-outs): src gets its top-k', async () => {
        const w = await world(eng, CROWD);
        await w.linker(pol(3)).linkBatch(WS, [{ id: 'src' }]);
        assert.deepEqual((await w.pairs()).filter((p) => p.includes('src')).length, 3);
    });

    await test('opted-out nodes crowding the top-k never shrink an eligible source below k (widening beyond the oversample)', async () => {
        const w = await world(eng, CROWD);
        await optOut(w.g, crowdOptOuts);
        const r = await w.linker(pol(3)).linkBatch(WS, [{ id: 'src' }]);
        assert.deepEqual(r.done, ['src']);
        const mine = (await w.pairs()).filter((p) => p.split('|').includes('src'));
        assert.deepEqual(mine, ['e0|src', 'e1|src', 'e2|src'], 'the 3 nearest ELIGIBLE nodes, none of the 60 closer opted-out ones');
    });

    await test('an opted-out node is excluded as a source and as a target in a mixed batch', async () => {
        const w = await world(eng, CROWD);
        await optOut(w.g, crowdOptOuts);
        const ids = CROWD.map(([id]) => ({ id }));
        const r = await w.linker(pol(3)).linkBatch(WS, ids);
        assert.ok(crowdOptOuts.every((o) => r.done.includes(o)), 'opted-out sources are settled (done), not retried');
        const touching = (await w.pairs()).filter((p) => p.split('|').some((x) => x.startsWith('o')));
        assert.deepEqual(touching, [], 'no edge touches an opted-out node');
        const all = await w.pairs();
        assert.ok(all.includes('e0|src') && all.includes('e1|e2'), `eligible nodes still link each other: ${all.join(',')}`);
        for (const x of ['src', 'e0', 'e1', 'e2', 'e3', 'e4', 'e5']) {
            assert.ok(all.filter((p) => p.split('|').includes(x)).length >= 3, `${x} kept at least k=3 links`);
        }
    });

    await test('fewer eligible neighbours than k: gets what exists, widening stops (bounded kNN calls)', async () => {
        const w = await world(eng, [['s', 0], ['o1', 1], ['o2', 2], ['o3', 3], ['e1', 4], ['e2', 5]]);
        await optOut(w.g, ['o1', 'o2', 'o3']);
        await w.linker(pol(4)).linkBatch(WS, [{ id: 's' }]);
        assert.deepEqual((await w.pairs()).filter((p) => p.split('|').includes('s')), ['e1|s', 'e2|s']);
        assert.ok(w.vb.knnCalls <= 4, `bounded widening, got ${w.vb.knnCalls} kNN calls`);
    });

    await test('cost: with no opt-out among the hits the lookup adds no extra kNN round', async () => {
        const w = await world(eng, [['s', 0], ['a', 1], ['b', 2], ['c', 3]]);
        await optOut(w.g, ['far-away-unrelated']);
        await w.linker(pol(2)).linkBatch(WS, [{ id: 's' }]);
        assert.equal(w.vb.knnCalls, 1);
    });

    await test('manual / explicit edges to an opted-out node are unaffected', async () => {
        const w = await world(eng, [['s', 0], ['o', 1]]);
        await optOut(w.g, ['o']);
        await w.g.addEdge({ sourceId: 's', targetId: 'o', relation: 'related_to', confidence: 'extracted' } as never);
        await w.linker(pol(3)).linkBatch(WS, [{ id: 's' }, { id: 'o' }]);
        assert.equal((await w.g.queryEdges({ relation: 'related_to', limit: 10, offset: 0 })).length, 1);
        assert.deepEqual(await w.pairs(), []);
    });

    console.log(`\n${eng.name}: rebuild`);

    const SPEC: Array<[string, number]> = [['a', 0], ['b', 10], ['c', 20], ['d', 30], ['e', 40]];
    function rebuilder(w: Awaited<ReturnType<typeof world>>, p: LinkPolicy): LinkRebuilder {
        const linker = w.linker(p);
        const substrate: RebuildSubstrate = {
            openHandles: (ws) => linker.openHandles(ws),
            computeLinks: (ws, ids) => linker.computeLinks(ws, ids),
            currentStamp: () => linker.currentStamp(),
            writeInferred: (ws, gr, e) => linker.writeInferred(ws, gr, e),
        };
        return new LinkRebuilder({ store: new SqliteRebuildStore(path.join(mkTmp('lod-rb-'), 'q.sqlite')), substrate, batchSize: 2, yieldMs: 0, maxWaitMs: 1000, isBusy: () => false });
    }
    const runRebuild = async (rb: LinkRebuilder) => { await rb.start(WS); await rb.whenIdle(WS); return rb.status(WS)!; };

    await test('from-scratch rebuild: an opted-out node is neither a source nor a target', async () => {
        const w = await world(eng, SPEC);
        await optOut(w.g, ['c']);
        const st = await runRebuild(rebuilder(w, pol(2)));
        assert.equal(st.status, 'done');
        const ps = await w.pairs();
        assert.deepEqual(ps.filter((p) => p.split('|').includes('c')), []);
        assert.ok(ps.length > 0, 'other nodes still link');
            });

    await test('rebuild leaves existing edges that touch an opted-out node alone (no invalidation, no refresh) and counts them', async () => {
        const w = await world(eng, SPEC);
        await w.linker(pol(4)).linkBatch(WS, SPEC.map(([id]) => ({ id })));
        const before = (await w.pairs()).filter((p) => p.split('|').includes('c'));
        assert.ok(before.length > 0, 'precondition: c has arrival links');
        await optOut(w.g, ['c']);
        const st = await runRebuild(rebuilder(w, { ...pol(1, 0.9), policyVersion: 'p-new' }));
        assert.equal(st.status, 'done');
        const after = (await w.pairs()).filter((p) => p.split('|').includes('c'));
        assert.deepEqual(after, before, 'edges touching the opted-out node are still live and unchanged');
        assert.ok((st.skippedOptOut ?? 0) > 0, `skippedOptOut counted: ${JSON.stringify(st)}`);
    });
}

console.log('\nsqlite: migration from the queue file');

const WEEK = 7 * 24 * 3600 * 1000;
function seedLegacy(file: string, withSticky: boolean, rows: Array<[string, string, number, number?]>): void {
    const db = new Database(file);
    db.exec(`CREATE TABLE IF NOT EXISTS link_optout (workspace TEXT NOT NULL, node_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (workspace, node_id));`);
    const hasSticky = (db.prepare(`PRAGMA table_info(link_optout)`).all() as Array<{ name: string }>).some((c) => c.name === 'sticky');
    if (withSticky && !hasSticky) db.exec(`ALTER TABLE link_optout ADD COLUMN sticky INTEGER NOT NULL DEFAULT 0`);
    for (const [ws, id, atMs, sticky] of rows) {
        if (withSticky) db.prepare(`INSERT OR REPLACE INTO link_optout (workspace, node_id, at, sticky) VALUES (?, ?, ?, ?)`).run(ws, id, atMs, sticky ?? 0);
        else db.prepare(`INSERT OR REPLACE INTO link_optout (workspace, node_id, at) VALUES (?, ?, ?)`).run(ws, id, atMs);
    }
    db.close();
}
const legacyCount = (file: string): number => {
    const db = new Database(file, { readonly: true });
    try { return (db.prepare(`SELECT count(*) AS c FROM link_optout`).get() as { c: number }).c; } finally { db.close(); }
};
const FAST = { ...LINK_DEFAULTS, quietMs: 0, maxDelayMs: 0, yieldMs: 0, batchSize: 100, maxAttempts: 3 };
const sqliteEng = engines[0]!;

for (const withSticky of [true, false]) {
    await test(`start(): live legacy rows move into the store, expired non-sticky ones are dropped (${withSticky ? 'with' : 'without'} the sticky column)`, async () => {
        const w = await world(sqliteEng, [['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
        const file = path.join(mkTmp('lod-q-'), 'link-queue.sqlite');
        const now = Date.now();
        seedLegacy(file, withSticky, [
            [WS, 'a', now - 1000], [WS, 'b', now - 2 * WEEK], [WS, 'other-ws-node', now],
            ...(withSticky ? [[WS, 'c', now - 2 * WEEK, 1] as [string, string, number, number]] : []),
        ]);
        const svc = new LinkService({ queue: new SqliteLinkQueue(file), linker: w.linker(pol(3)), config: FAST, resolveGraph: async (ws) => (ws === WS ? w.g : null) });
        svc.start();
        for (let i = 0; i < 100 && (await w.g.getLinkOptOuts(['a'])).size === 0; i++) await new Promise((r) => setTimeout(r, 20));
        const want = withSticky ? ['a', 'c'] : ['a'];
        assert.deepEqual(await optedOutOf(w.g, ['a', 'b', 'c', 'd']), want, 'a is live, c is sticky, b expired');
        await svc.drain(1000);
        svc.close();
        // the only row left belongs to a workspace this graph does not serve
        assert.ok(legacyCount(file) <= 1, `legacy rows for the migrated workspace are gone, got ${legacyCount(file)}`);
    });
}

await test('migration happens before the first link batch: a legacy opt-out already filters arrival links', async () => {
    const w = await world(sqliteEng, [['a', 0], ['b', 1], ['c', 2]]);
    const file = path.join(mkTmp('lod-q-'), 'link-queue.sqlite');
    seedLegacy(file, true, [[WS, 'b', Date.now()]]);
    const svc = new LinkService({ queue: new SqliteLinkQueue(file), linker: w.linker(pol(3)), config: FAST, resolveGraph: async () => w.g });
    svc.signal(WS, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await svc.flush();
    svc.close();
    assert.deepEqual(await w.pairs(), ['a|c'], 'b, still opted out via its legacy row, neither links nor is linked');
});

await test('idempotent: re-running the move (second service, re-seeded row) changes nothing', async () => {
    const w = await world(sqliteEng, [['a', 0], ['b', 1]]);
    const file = path.join(mkTmp('lod-q-'), 'link-queue.sqlite');
    seedLegacy(file, true, [[WS, 'a', Date.now()]]);
    for (let round = 0; round < 2; round++) {
        const svc = new LinkService({ queue: new SqliteLinkQueue(file), linker: w.linker(pol(3)), config: FAST, resolveGraph: async () => w.g });
        await svc.setIntent(WS, ['zzz'], false); // any first touch triggers the move
        svc.close();
        assert.deepEqual(await optedOutOf(w.g, ['a', 'b', 'zzz']), ['a', 'zzz']);
        if (round === 0) seedLegacy(file, true, [[WS, 'a', Date.now()]]); // a crash between "store write" and "drop" leaves the row behind
    }
    assert.equal(legacyCount(file), 0);
});

await test('an explicit autolink:true after a stale legacy row wins (the move runs first, then the clear)', async () => {
    const w = await world(sqliteEng, [['a', 0], ['b', 1]]);
    const file = path.join(mkTmp('lod-q-'), 'link-queue.sqlite');
    seedLegacy(file, true, [[WS, 'a', Date.now()]]);
    const svc = new LinkService({ queue: new SqliteLinkQueue(file), linker: w.linker(pol(3)), config: FAST, resolveGraph: async () => w.g });
    await svc.setIntent(WS, ['a'], true);
    svc.close();
    assert.deepEqual(await optedOutOf(w.g, ['a']), []);
    assert.equal(legacyCount(file), 0);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
if (gatePool) { await cleanupGateWorkspaces(gatePool); await gatePool.end(); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

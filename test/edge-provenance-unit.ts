#!/usr/bin/env tsx
/**
 * test/edge-provenance-unit.ts - edge provenance + soft invalidation (design D3), same cases on SQLite and,
 * when LORE_PG_URL names a throwaway server, Postgres.
 *
 *   stamping    addEdge -> origin 'caller'; batch/Linker -> 'link_on_arrival'; importRaw -> 'import'; bogus origin refused
 *   legacy      default reads carry NO provenance (parity); a SQLite file from before the columns existed upgrades on open
 *   live reads  an invalidated edge is absent from EVERY default read path: getEdge, queryEdges (every filter),
 *               traverse, traverseDirected, getStats, getTopology, lintGraph (orphan check) - and visible with includeInvalidated
 *   deletes     deleteNode and deleteEdge remove invalidated rows too (nothing dangles)
 *   linker      StoredVectorLinker stamps origin/policy_version/model_fingerprint on the batch path AND the single-write fallback
 *
 * Run: npx tsx test/edge-provenance-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { sqliteGraphDataPath } from '../packages/lore/src/engines/sqlite/sqliteGraphSchema.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { StoredVectorLinker } from '../packages/lore/src/link/storedVectorLinker.js';
import type { LinkPolicy } from '../packages/lore/src/link/linkConfig.js';
import { EDGE_ORIGINS, type EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { cleanupGateWorkspaces, closeGatePool, createGatePool } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

type G = SqliteGraph | PostgresGraph;
const engines: Array<{ name: string; open: () => Promise<G> }> = [
    { name: 'sqlite', open: async () => { const g = new SqliteGraph(mkTmp('ep-g-'), { workspaceId: 'ep' }); await g.initialize(); return g; } },
];
const gatePool = await createGatePool('edge-provenance');
if (gatePool) {
    await cleanupGateWorkspaces(gatePool);
    let seq = 0;
    engines.push({ name: 'postgres', open: async () => { const g = new PostgresGraph(`pg-gate-ep-${process.pid}-${seq++}`, gatePool); await g.initialize(); return g; } });
}
const node = (id: string, type = 'note') => ({ id, type, label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;
const REL = 'depends_on';
const K = (s: string, t: string) => ({ sourceId: s, targetId: t, relation: REL });
const AT = '2026-10-23T12:00:00.000Z';

for (const eng of engines) {
    console.log(`\n${eng.name}`);
    const seed = async (ids: string[], type = 'note'): Promise<G> => { const g = await eng.open(); for (const id of ids) await g.upsertNode(node(id, type)); return g; };

    await test('exported origin union covers every writer', () => {
        assert.deepEqual([...EDGE_ORIGINS].sort(), ['caller', 'discovery', 'import', 'link_on_arrival', 'reconnect']);
    });

    await test('addEdge stamps origin caller + created_at, live (validTo null); default reads carry no provenance', async () => {
        const g = await seed(['a', 'b']);
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL });
        const plain = await g.getEdge('a', 'b', REL);
        assert.equal(plain?.provenance, undefined, 'default read keeps the legacy shape');
        const p = (await g.getEdge('a', 'b', REL, { includeProvenance: true }))!.provenance!;
        assert.equal(p.origin, 'caller');
        assert.ok(p.createdAt && !Number.isNaN(Date.parse(p.createdAt)));
        assert.equal(p.validTo, null);
        const listed = (await g.queryEdges({ limit: 10, offset: 0, includeProvenance: true }))[0]!;
        assert.equal(listed.provenance?.origin, 'caller');
    });

    await test('an explicit provenance is kept; an unknown origin is refused', async () => {
        const g = await seed(['a', 'b']);
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL, provenance: { origin: 'discovery', policyVersion: 'v9', modelFingerprint: 'm1' } });
        const p = (await g.getEdge('a', 'b', REL, { includeProvenance: true }))!.provenance!;
        assert.deepEqual([p.origin, p.policyVersion, p.modelFingerprint], ['discovery', 'v9', 'm1']);
        await assert.rejects(() => g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'x', provenance: { origin: 'bogus' as never } }));
    });

    await test('batch writes stamp link_on_arrival with policy + fingerprint; re-assert restamps but keeps created_at', async () => {
        const g = await seed(['a', 'b']);
        await g.addInferredEdgesBatch([{ sourceId: 'a', targetId: 'b', relation: REL, confidenceScore: 0.8, provenance: { origin: 'link_on_arrival', policyVersion: 'p1', modelFingerprint: 'fp1' } }]);
        const first = (await g.getEdge('a', 'b', REL, { includeProvenance: true }))!.provenance!;
        assert.deepEqual([first.origin, first.policyVersion, first.modelFingerprint], ['link_on_arrival', 'p1', 'fp1']);
        await new Promise((r) => setTimeout(r, 15));
        await g.addInferredEdgesBatch([{ sourceId: 'a', targetId: 'b', relation: REL, confidenceScore: 0.9, provenance: { policyVersion: 'p2', modelFingerprint: 'fp2' } }]);
        const second = (await g.getEdge('a', 'b', REL, { includeProvenance: true }))!.provenance!;
        assert.deepEqual([second.policyVersion, second.modelFingerprint], ['p2', 'fp2']);
        assert.equal(new Date(second.createdAt!).getTime(), new Date(first.createdAt!).getTime(), 'created_at is the first write');
    });

    await test('importRaw keeps supplied provenance and defaults to origin import', async () => {
        const g = await seed(['a', 'b', 'c']);
        await g.importRaw([], [
            { sourceId: 'a', targetId: 'b', relation: REL, confidence: 'extracted', confidenceScore: 1 },
            { sourceId: 'b', targetId: 'c', relation: REL, confidence: 'extracted', confidenceScore: 1, provenance: { origin: 'reconnect', policyVersion: 'r1' } },
        ]);
        assert.equal((await g.getEdge('a', 'b', REL, { includeProvenance: true }))!.provenance!.origin, 'import');
        const p = (await g.getEdge('b', 'c', REL, { includeProvenance: true }))!.provenance!;
        assert.deepEqual([p.origin, p.policyVersion], ['reconnect', 'r1']);
    });

    await test('an invalidated edge is absent from EVERY default read path (and present with includeInvalidated)', async () => {
        const g = await seed(['hub', 'x', 'y'], 'concept');
        await g.addEdge({ sourceId: 'hub', targetId: 'x', relation: REL });
        await g.addEdge({ sourceId: 'y', targetId: 'hub', relation: REL });
        const before = {
            edges: (await g.queryEdges({ limit: 50, offset: 0 })).length,
            stats: (await g.getStats()).edgeCount,
            topo: (await g.getTopology(100, undefined, 100)).edges.length,
        };
        assert.deepEqual(before, { edges: 2, stats: 2, topo: 2 });
        assert.equal(await g.invalidateEdges([K('hub', 'x'), K('y', 'hub')], AT), 2);

        assert.equal(await g.getEdge('hub', 'x', REL), null);
        assert.deepEqual(await g.queryEdges({ limit: 50, offset: 0 }), []);
        assert.deepEqual(await g.queryEdges({ limit: 50, offset: 0, source: 'hub' }), []);
        assert.deepEqual(await g.queryEdges({ limit: 50, offset: 0, target: 'hub' }), []);
        assert.deepEqual(await g.queryEdges({ limit: 50, offset: 0, relation: REL }), []);
        assert.deepEqual(await g.traverse('hub', 3), []);
        assert.deepEqual(await g.traverseDirected('hub', 3), []);
        assert.equal((await g.getStats()).edgeCount, 0);
        assert.equal((await g.getTopology(100, undefined, 100)).edges.length, 0);
        assert.equal((await g.lintGraph()).length, 3, 'all three concept nodes are orphans once their only edges are invalid');

        assert.equal((await g.queryEdges({ limit: 50, offset: 0, includeInvalidated: true })).length, 2);
        assert.equal((await g.queryEdges({ limit: 50, offset: 0, target: 'hub', includeInvalidated: true })).length, 1);
        assert.ok(await g.getEdge('hub', 'x', REL, { includeInvalidated: true }));
    });

    await test('traverse sees only the live edges when one of two is invalidated', async () => {
        const g = await seed(['a', 'b', 'c']);
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL });
        await g.addEdge({ sourceId: 'a', targetId: 'c', relation: REL });
        await g.invalidateEdges([K('a', 'b')], AT);
        assert.deepEqual((await g.traverse('a', 2)).map((r) => r.node.id), ['c']);
        assert.deepEqual((await g.traverseDirected('a', 2)).map((r) => `${r.direction}:${r.node.id}`), ['out:c']);
        assert.deepEqual((await g.traverse('b', 2)), [], 'the invalidated edge is not walkable from the other end either');
    });

    await test('re-asserting through addEdge revalidates (valid_to cleared) and the edge is walkable again', async () => {
        const g = await seed(['a', 'b']);
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL });
        await g.invalidateEdges([K('a', 'b')], AT);
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL });
        assert.ok(await g.getEdge('a', 'b', REL));
        assert.equal((await g.traverse('a', 1)).length, 1);
    });

    await test('deleteNode and deleteEdge remove invalidated rows too: nothing dangles', async () => {
        const g = await seed(['a', 'b', 'c']);
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: REL });
        await g.addEdge({ sourceId: 'b', targetId: 'c', relation: REL });
        await g.invalidateEdges([K('a', 'b'), K('b', 'c')], AT);
        assert.equal(await g.deleteEdge('a', 'b', REL), 1, 'deleteEdge reaches an invalidated edge');
        await g.deleteNode('c');
        assert.deepEqual(await g.queryEdges({ limit: 50, offset: 0, includeInvalidated: true }), []);
    });
}

// ───────────── SQLite: a file from before the provenance columns upgrades on open ─────────────
console.log('\nsqlite legacy file');
await test('legacy edges (no provenance columns) are added in place, read as live + origin-less, and stay writable', async () => {
    const base = mkTmp('ep-legacy-');
    const g1 = new SqliteGraph(base, { workspaceId: 'ep' });
    await g1.initialize();
    for (const id of ['a', 'b', 'c']) await g1.upsertNode(node(id));
    await g1.addEdge({ sourceId: 'a', targetId: 'b', relation: REL });
    await g1.close();
    const raw = new Database(sqliteGraphDataPath(base));
    for (const c of ['origin', 'policy_version', 'model_fingerprint', 'created_at', 'valid_to']) raw.exec(`ALTER TABLE edges DROP COLUMN ${c}`);
    raw.close();

    const g2 = new SqliteGraph(base, { workspaceId: 'ep' });
    await g2.initialize();
    const legacy = (await g2.getEdge('a', 'b', REL, { includeProvenance: true }))!;
    assert.equal(legacy.provenance?.origin, undefined, 'legacy row: origin NULL');
    assert.equal(legacy.provenance?.validTo, null, 'legacy row: live');
    assert.equal((await g2.traverse('a', 1)).length, 1);
    await g2.addEdge({ sourceId: 'b', targetId: 'c', relation: REL });
    assert.equal((await g2.getEdge('b', 'c', REL, { includeProvenance: true }))!.provenance!.origin, 'caller');
    await g2.close();
    const g3 = new SqliteGraph(base, { workspaceId: 'ep' });
    await g3.initialize(); // second open: columns already there, no error
    assert.equal((await g3.queryEdges({ limit: 10, offset: 0 })).length, 2);
    await g3.close();
});

// ───────────── Linker stamping (SQLite graph + verbatim, hand-placed vectors) ─────────────
console.log('\nlinker');
class NoEmbed implements EmbeddingProvider {
    readonly dimension = 4; readonly modelId = 'ep-none'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { throw new Error('never embeds'); }
    async embedQuery(): Promise<number[]> { throw new Error('never embeds'); }
    async embedDocument(): Promise<number[]> { throw new Error('never embeds'); }
}
const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180), 0, 0];
const POLICY: LinkPolicy = { minSim: 0.9, k: 5, dupSim: 0.999, policyVersion: 'policy-7' };
async function linkerWorld(batchCapable: boolean) {
    const graph = new SqliteGraph(mkTmp('ep-lg-'), { workspaceId: 'epl' });
    await graph.initialize();
    const verbatim = new SqliteVerbatimStore(mkTmp('ep-lv-'), new NoEmbed());
    await verbatim.initialize();
    const specs = [['a', 0], ['b', 10]] as const;
    for (const [id] of specs) await graph.upsertNode(node(id));
    await verbatim.bulkAddPrebuiltRows(specs.map(([id, deg]) => ({
        id: `lore:${id}`, label: id, text: `t ${id}`, type: 'note', project: 'p', ecosystem: '*', security_scopes: [],
        vector: at(deg), contentHash: `h-${id}`, updatedAt: '2026-10-23T00:00:00.000Z',
    })) as never);
    const handle = batchCapable ? graph : Object.create(graph, { addInferredEdgesBatch: { value: undefined } });
    const linker = new StoredVectorLinker(async () => ({ graph: handle as never, verbatim: verbatim as never }), POLICY, 'fp-model-X');
    return { graph, linker };
}
for (const batchCapable of [true, false]) {
    await test(`Linker stamps link_on_arrival + policy_version + model fingerprint (${batchCapable ? 'batch path' : 'single-write fallback'})`, async () => {
        const w = await linkerWorld(batchCapable);
        await w.linker.linkBatch('ws', [{ id: 'a' }]);
        const e = await w.graph.getEdge('a', 'b', 'semantic_neighbor', { includeProvenance: true });
        assert.ok(e, 'edge written');
        assert.deepEqual([e.provenance?.origin, e.provenance?.policyVersion, e.provenance?.modelFingerprint], ['link_on_arrival', 'policy-7', 'fp-model-X']);
    });
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
if (gatePool) { await cleanupGateWorkspaces(gatePool); await closeGatePool(gatePool); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

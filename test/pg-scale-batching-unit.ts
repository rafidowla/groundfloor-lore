#!/usr/bin/env tsx
/**
 * test/pg-scale-batching-unit.ts - Wave D lane d2: the Postgres scale fixes, pinned through the real paths.
 *
 *   pure         boundedMap keeps INPUT order, never exceeds its limit, rethrows the first failure;
 *                edgesTouching (link rebuild's edge read) returns exactly what the old sequential loop did, pagination included.
 *   embedded+pg  a real `createLore()` over a real Postgres workspace:
 *                  - `nodeDeleteMany` tombstones the whole chunk through ONE batched embed (no per-node embedDocument),
 *                    leaving the same rows `tombstone()` leaves (tombstone canonical + superseded history snapshot, metadata kept);
 *                  - already-tombstoned ids are a no-op (idempotent), absent ids are skipped;
 *                  - the graph side of the chunk goes in ONE `graph.deleteNodes` transaction (nodes, both-direction edges, opt-outs),
 *                    falling back to per-node `deleteNode` if it throws;
 *                  - a throwing `tombstoneMany` falls back to the per-node path and still tombstones every node;
 *                  - the link rebuild (parallel edge/point reads) links same-cluster nodes only, and a second run is a pure no-op diff.
 *
 * Needs LORE_PG_URL (any database on a pgvector server; the dedicated `lore_gate` db is used); skips cleanly without it.
 * Run: LORE_PG_URL=postgres://postgres:...@127.0.0.1:<port>/postgres npx tsx test/pg-scale-batching-unit.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { boundedMap } from '../packages/lore/src/link/boundedMap.js';
import { edgesTouching } from '../packages/lore/src/link/linkDiff.js';
import { createLore } from '../packages/lore/src/index.js';
import { cleanupGateWorkspaces, closeGatePool, createGatePool, gateDbUrl, PG_GATE_WS_PREFIX, stampGateManifest } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log('\npure');
await test('boundedMap: results in input order, concurrency never above the limit', async () => {
    let live = 0, peak = 0;
    const out = await boundedMap([5, 1, 4, 2, 3, 0, 6], 3, async (n) => { live++; peak = Math.max(peak, live); await sleep(n * 3); live--; return n * 10; });
    assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60]);
    assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
    assert.deepEqual(await boundedMap([], 4, async (x) => x), []);
    assert.deepEqual(await boundedMap([1, 2], 0, async (x: number) => x + 1), [2, 3]); // a nonsense limit still runs (width 1)
});
await test('boundedMap: first failure is rethrown and stops handing out new work', async () => {
    let started = 0;
    await assert.rejects(boundedMap(Array.from({ length: 50 }, (_, i) => i), 2, async (i) => { started++; await sleep(1); if (i === 3) throw new Error('boom'); return i; }), /boom/);
    assert.ok(started < 50, `started ${started}`);
});
await test('edgesTouching: same map as a sequential read, first edge per pair wins, pages past 1000', async () => {
    const mk = (s: string, t: string, score: number) => ({ sourceId: s, targetId: t, relation: 'semantic_neighbor', confidenceScore: score });
    const all = [mk('a', 'b', 0.9), mk('b', 'a', 0.8), ...Array.from({ length: 1500 }, (_, i) => mk('hub', `n${i}`, 0.7)), mk('c', 'hub', 0.6)];
    const graph = {
        queryEdges: async (q: { source?: string; target?: string; limit: number; offset: number }) => {
            await sleep(1);
            const rows = all.filter((e) => (q.source !== undefined ? e.sourceId === q.source : e.targetId === q.target));
            return rows.slice(q.offset, q.offset + q.limit);
        },
    };
    const ids = ['a', 'hub', 'b', 'c', 'zzz'];
    const got = await edgesTouching(graph as never, ids);
    // reference: the original sequential algorithm
    const ref = new Map<string, unknown>();
    for (const id of ids) for (const side of ['source', 'target'] as const) {
        for (let offset = 0; ; offset += 1000) {
            const page = await graph.queryEdges({ [side]: id, limit: 1000, offset } as never);
            for (const e of page) { const [lo, hi] = [e.sourceId, e.targetId].sort(); const k = `${lo}\u0000${hi}`; if (!ref.has(k)) ref.set(k, e); }
            if (page.length < 1000) break;
        }
    }
    assert.equal(got.size, ref.size);
    assert.equal(got.size, 1 + 1500 + 1);
    for (const [k, e] of ref) assert.deepEqual(got.get(k), e, k);
    assert.equal(got.get('a\u0000b')!.confidenceScore, 0.9, 'a->b (seen first through a/source) wins over b->a');
});

// ---- embedded createLore over a real Postgres -------------------------------------------------------------------
const gateUrl = gateDbUrl();
const gate = gateUrl ? await createGatePool('pg-scale-batching') : null;
if (!gate || !gateUrl) {
    console.log('\nembedded+pg: SKIPPED (LORE_PG_URL not set)');
} else {
    console.log('\nembedded+pg');
    process.env['LORE_PG_URL'] = gateUrl;
    process.env['LORE_MODEL_SERVER'] = '0';
    process.env['LORE_LINK_REBUILD_YIELD_MS'] = '0';
    const DIM = 4;
    const WS = `${PG_GATE_WS_PREFIX}d2-${Date.now().toString(36)}`;
    // Postgres rows are keyed by the permanent workspace id, not the name; raw SQL below uses WSK.
    const WSK = `${WS}-id`;
    await cleanupGateWorkspaces(gate);

    const counts = { doc: 0, batches: 0, batchItems: 0 };
    // alpha-* texts point near +x, beta-* near +y: cosine ~1 inside a cluster, ~0 across. Anything else: a stable hash vector.
    const vec = (t: string): number[] => {
        const i = Number(/-(\d+)\b/.exec(t)?.[1] ?? 0) * 0.01;
        if (t.includes('alpha')) return [1, i, 0, 0];
        if (t.includes('beta')) return [i, 1, 0, 0];
        const h = createHash('sha256').update(t).digest();
        return [h[0]! + 1, h[1]! + 1, h[2]! + 1, h[3]! + 1].map((x) => x / 256);
    };
    const embedder = {
        dimension: DIM, modelId: 'gate/d2-fixed-4', dtype: 'fp32', maxBatchSize: 8,
        async initialize() { /* no-op */ },
        async embed(t: string) { return vec(t); },
        async embedQuery(t: string) { return vec(t); },
        async embedDocument(t: string) { counts.doc++; return vec(t); },
        async embedDocumentBatch(ts: string[]) { counts.batches++; counts.batchItems += ts.length; return ts.map(vec); },
    };

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-pg-d2-'));
    const wsPath = path.join(home, 'workspaces', WS);
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        version: 1, active: WS,
        workspaces: [{ name: WS, id: WSK, path: wsPath, graphEngine: 'postgres', vectorEngine: 'postgres', createdAt: new Date().toISOString() }],
    }));
    stampGateManifest(wsPath, embedder.modelId, DIM);

    delete process.env['LORE_HOME'];
    const lore = await createLore({ dataDir: home, deploymentMode: 'embedded', embeddingProvider: embedder as never, modelServer: false, linkOnArrival: true } as never) as any;
    const put = (id: string, text: string, extra: Record<string, string> = {}) => lore.nodeUpsert({
        id, workspace: WS, ecosystem: '*',
        nodeData: { id, type: extra['type'] ?? 'note', label: extra['label'] ?? id, content: text, tags: extra['tags'] ?? '', project: WS, ecosystem: '*', metadata: '{}' },
    });
    const rowsOf = async (id: string) => (await gate.query(
        `SELECT is_canonical, is_tombstone, text, type, label, tags, project, ecosystem, (vector IS NOT NULL) AS has_vec, superseded_at
         FROM verbatim WHERE workspace_id = $1 AND id = $2 ORDER BY row_id`, [WSK, `lore:${id}`])).rows;
    const nodeCount = async (ids: string[]) => Number((await gate.query(`SELECT count(*) AS c FROM nodes WHERE workspace_id = $1 AND id = ANY($2::text[])`, [WSK, ids])).rows[0].c);

    try {
        await test('nodeDeleteMany on Postgres tombstones the chunk through ONE batched embed, same rows as tombstone()', async () => {
            const ids = Array.from({ length: 20 }, (_, i) => `del-${i}`);
            for (const id of ids) await put(id, `${id} some body text`, { type: 'decision', label: `Label ${id}`, tags: 'x,y' });
            await lore.awaitEmbeds?.();
            assert.equal(await nodeCount(ids), 20);

            counts.doc = 0; counts.batches = 0; counts.batchItems = 0;
            const res = await lore.nodeDeleteMany({ ids, workspace: WS });
            assert.equal((res.results ?? []).filter((r: any) => r.deleted).length, 20, JSON.stringify(res).slice(0, 300));
            assert.equal((res.results ?? []).filter((r: any) => r.verbatimWarning).length, 0);
            assert.equal(counts.doc, 0, 'no per-node embedDocument call on the batched path');
            assert.equal(counts.batchItems, 20, 'exactly one marker text embedded per node');
            assert.ok(counts.batches <= 3, `batches ${counts.batches}`); // maxBatchSize 8 -> 3 windows

            assert.equal(await nodeCount(ids), 0, 'graph nodes gone');
            for (const id of ids) {
                const rows = await rowsOf(id);
                const live = rows.filter((r: any) => r.is_canonical === 1);
                const hist = rows.filter((r: any) => r.is_canonical === 0);
                assert.equal(live.length, 1, id); assert.equal(hist.length, 1, id);
                assert.equal(live[0].is_tombstone, 1);
                assert.ok(String(live[0].text).startsWith('[TOMBSTONED '), live[0].text);
                assert.ok(String(live[0].text).includes(`${id} some body text`), 'original text kept under the marker');
                assert.equal(live[0].has_vec, true, 'marker text re-embedded');
                assert.equal(hist[0].text, `Label ${id}\n\n${id} some body text\n\nx,y`, 'history snapshot keeps the pre-delete composite text');
                assert.ok(hist[0].superseded_at, 'history snapshot stamped');
                assert.equal(live[0].type, 'decision'); assert.equal(live[0].label, `Label ${id}`); assert.equal(live[0].tags, 'x,y');
            }
        });

        await test('batched and per-node tombstones leave identical metadata; tombstoneMany is idempotent and skips absent ids', async () => {
            await put('eq-a', 'eq-a body', { type: 'bug_pattern', label: 'EQ', tags: 't1' });
            await put('eq-b', 'eq-b body', { type: 'bug_pattern', label: 'EQ', tags: 't1' });
            await lore.awaitEmbeds?.();
            const v = lore.store.loreVerbatim;
            await v.tombstone('lore:eq-a', 'because');
            await v.tombstoneMany(['lore:eq-b', 'lore:does-not-exist'], 'because');
            const [a, b] = [await rowsOf('eq-a'), await rowsOf('eq-b')];
            const shape = (rows: any[]) => rows.map((r) => [r.is_canonical, r.is_tombstone, r.type, r.label, r.tags, r.project, r.ecosystem, r.has_vec]);
            assert.deepEqual(shape(a), shape(b));
            assert.match(String(b.find((r: any) => r.is_canonical === 1).text), /^\[TOMBSTONED [^\]]+ reason: because\]\n\nEQ\n\neq-b body\n\nt1$/);
            const before = (await rowsOf('eq-b')).length;
            await v.tombstoneMany(['lore:eq-b', 'lore:eq-b'], 'again'); // already tombstoned (and duplicated in the call)
            assert.equal((await rowsOf('eq-b')).length, before, 'no extra rows');
            assert.equal((await rowsOf('does-not-exist')).length, 0);
        });

        await test('a failing tombstoneMany falls back to the per-node path and every node is still tombstoned', async () => {
            const ids = Array.from({ length: 6 }, (_, i) => `fb-${i}`);
            for (const id of ids) await put(id, `${id} body`);
            await lore.awaitEmbeds?.();
            const v = lore.store.loreVerbatim;
            let called = 0;
            const original = v.tombstoneMany;
            v.tombstoneMany = async () => { called++; throw new Error('injected batch failure'); };
            counts.doc = 0;
            try {
                const res = await lore.nodeDeleteMany({ ids, workspace: WS });
                assert.equal((res.results ?? []).filter((r: any) => r.deleted).length, 6);
                assert.equal((res.results ?? []).filter((r: any) => r.verbatimWarning).length, 0);
            } finally { v.tombstoneMany = original; }
            assert.equal(called, 1);
            assert.equal(counts.doc, 6, 'per-node embedDocument on the fallback');
            for (const id of ids) assert.equal((await rowsOf(id)).find((r: any) => r.is_canonical === 1)?.is_tombstone, 1, id);
        });

        await test('graph.deleteNodes: one transaction removes nodes, both-direction edges and opt-outs; nodeDeleteMany uses it once', async () => {
            const ids = Array.from({ length: 5 }, (_, i) => `gd-${i}`);
            for (const id of [...ids, 'gd-keep']) await put(id, `${id} body`);
            await lore.awaitEmbeds?.();
            const g = lore.store.loreGraph;
            const edge = (a: string, b: string) => g.addEdge({ sourceId: a, targetId: b, relation: 'related_to', confidenceScore: 0.9 });
            await edge('gd-0', 'gd-1'); await edge('gd-keep', 'gd-2'); await edge('gd-3', 'gd-keep'); await edge('gd-keep', 'gd-4');
            await g.setLinkOptOuts(['gd-1'], true);
            const edgeCount = async () => Number((await gate.query(
                `SELECT count(*) AS c FROM edges e JOIN nodes n ON n.sk IN (e.src_sk, e.dst_sk) WHERE e.workspace_id = $1 AND n.workspace_id = $1 AND n.id LIKE 'gd-%'`, [WSK])).rows[0].c);
            assert.ok(await edgeCount() >= 4);

            // direct call: returns exactly the ids that existed, empty / duplicate input is safe
            assert.deepEqual([...await g.deleteNodes([])], []);
            assert.deepEqual([...await g.deleteNodes(['gd-nope', 'gd-nope'])], []);
            const gone = await g.deleteNodes(['gd-0', 'gd-0', 'gd-nope']);
            assert.deepEqual([...gone], ['gd-0']);
            assert.equal(await nodeCount(['gd-0']), 0);

            // through the service: spy proves the batched call is used once for the chunk and the per-node call not at all
            let batched = 0, single = 0;
            const origMany = g.deleteNodes.bind(g), origOne = g.deleteNode.bind(g);
            g.deleteNodes = async (x: string[]) => { batched++; return origMany(x); };
            g.deleteNode = async (x: string) => { single++; return origOne(x); };
            let res: any;
            try { res = await lore.nodeDeleteMany({ ids: ['gd-1', 'gd-2', 'gd-3', 'gd-4', 'gd-absent'], workspace: WS }); }
            finally { g.deleteNodes = origMany; g.deleteNode = origOne; }
            assert.equal(batched, 1); assert.equal(single, 0);
            const byId = new Map<string, any>((res.results ?? []).map((r: any) => [r.id, r]));
            for (const id of ['gd-1', 'gd-2', 'gd-3', 'gd-4']) assert.equal(byId.get(id)?.deleted, true, id);
            assert.notEqual(byId.get('gd-absent')?.deleted, true);
            assert.equal(await nodeCount([...ids, 'gd-keep']), 1, 'only gd-keep survives');
            assert.equal(await edgeCount(), 0, 'no edge left touching any deleted node');
            assert.equal(Number((await gate.query(`SELECT count(*) AS c FROM link_optout WHERE workspace_id = $1 AND node_id LIKE 'gd-%'`, [WSK])).rows[0].c), 0);
        });

        await test('a failing graph.deleteNodes (all-or-nothing) falls back to per-node deletes', async () => {
            const ids = Array.from({ length: 4 }, (_, i) => `gf-${i}`);
            for (const id of ids) await put(id, `${id} body`);
            await lore.awaitEmbeds?.();
            const g = lore.store.loreGraph;
            const origMany = g.deleteNodes.bind(g);
            let single = 0; const origOne = g.deleteNode.bind(g);
            g.deleteNodes = async () => { throw new Error('injected graph batch failure'); };
            g.deleteNode = async (x: string) => { single++; return origOne(x); };
            let res: any;
            try { res = await lore.nodeDeleteMany({ ids, workspace: WS }); }
            finally { g.deleteNodes = origMany; g.deleteNode = origOne; }
            assert.equal(single, 4);
            assert.equal((res.results ?? []).filter((r: any) => r.deleted).length, 4);
            assert.equal(await nodeCount(ids), 0);
        });

        await test('link rebuild over Postgres (parallel point/edge reads): same-cluster links only, second run is a no-op diff', async () => {
            const alpha = Array.from({ length: 8 }, (_, i) => `rb-alpha-${i}`);
            const beta = Array.from({ length: 8 }, (_, i) => `rb-beta-${i}`);
            for (const id of [...alpha, ...beta]) await put(id, `${id.replace('rb-', '')} cluster text`);
            await lore.awaitEmbeds?.();
            await sleep(800); // let link-on-arrival settle, then clear its edges so the rebuild has real work to do
            await gate.query(`DELETE FROM edges e USING nodes n WHERE e.workspace_id = $1 AND n.sk = e.src_sk AND n.id LIKE 'rb-%'`, [WSK]);
            const svc = lore.store.linkService;
            const run = async () => {
                await svc.startRebuild(WS);
                for (let i = 0; i < 400; i++) {
                    const st = svc.rebuildStatus(WS);
                    if (st && st.status !== 'running') return st;
                    await sleep(50);
                }
                assert.fail('rebuild did not finish');
            };
            const first = await run();
            assert.equal(first.status, 'done');
            assert.ok(first.inserted > 0, 'edges inserted');
            const edges = (await gate.query(
                `SELECT s.id AS s, t.id AS t FROM edges e JOIN nodes s ON s.sk = e.src_sk JOIN nodes t ON t.sk = e.dst_sk
                 WHERE e.workspace_id = $1 AND e.relation = 'semantic_neighbor' AND s.id LIKE 'rb-%'`, [WSK])).rows;
            assert.equal(edges.length, first.inserted);
            for (const e of edges) assert.equal(String(e.s).includes('alpha'), String(e.t).includes('alpha'), `cross-cluster edge ${e.s} -> ${e.t}`);
            for (const id of [...alpha, ...beta]) assert.ok(edges.some((e: any) => e.s === id || e.t === id), `${id} has a link`);
            const second = await run();
            assert.equal(second.inserted, 0); assert.equal(second.invalidated, 0);
            assert.ok(second.unchanged >= edges.length, `unchanged ${second.unchanged}`);
        });
    } finally {
        try { await lore.dispose?.(); } catch { /* shutdown */ }
        await cleanupGateWorkspaces(gate);
        await closeGatePool(gate);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);

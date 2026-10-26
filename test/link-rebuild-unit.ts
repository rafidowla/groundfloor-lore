#!/usr/bin/env tsx
/**
 * test/link-rebuild-unit.ts - rebuild links as a diff (Loop C / D2), same cases on SQLite and, when LORE_PG_URL
 * names a throwaway server, Postgres.
 *
 *   diff        a rebuild reaches exactly the link set a from-scratch computation gives: inserts new, soft-invalidates dropped
 *   unchanged   a second run writes NOTHING (no restamp, created_at kept)
 *   origins     caller / import / reconnect / discovery / legacy NULL-origin edges are never invalidated; a wanted pair they hold is left alone
 *   asymmetry   an edge wanted by only ONE endpoint survives (kNN is not symmetric), however the batches fall
 *   unknown     an endpoint with no stored vector is "unknown" (edge kept); a vanished endpoint is "gone" (edge dropped)
 *   during      old links stay live while the run is mid-way; an arrival during the run keeps its links
 *   resume      sealed / failed runs continue after the checkpoint cursor (no batch repeated), in a new instance too
 *   throttle    yields while busy; still finishes once maxWait passes
 *
 * Run: npx tsx test/link-rebuild-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { sqliteGraphDataPath } from '../packages/lore/src/engines/sqlite/sqliteGraphSchema.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { StoredVectorLinker, type ComputedLinks } from '../packages/lore/src/link/storedVectorLinker.js';
import { LinkRebuilder, type RebuildSubstrate } from '../packages/lore/src/link/linkRebuilder.js';
import { SqliteRebuildStore } from '../packages/lore/src/link/linkRebuildStore.js';
import { createLinkService } from '../packages/lore/src/link/createLinkService.js';
import { tryLinkRebuildRoutes } from '../packages/lore/src/mcp/http/routes/linkRebuild.js';
import type { LinkPolicy } from '../packages/lore/src/link/linkConfig.js';
import { cleanupGateWorkspaces, closeGatePool, createGatePool } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type G = SqliteGraph | PostgresGraph;
interface Eng { name: string; open: () => Promise<{ g: G; nullOrigin: (a: string, b: string) => Promise<void> }> }
const engines: Eng[] = [{
    name: 'sqlite',
    open: async () => {
        const base = mkTmp('lr-g-');
        const g = new SqliteGraph(base, { workspaceId: 'lr' });
        await g.initialize();
        return { g, nullOrigin: async (a, b) => { const raw = new Database(sqliteGraphDataPath(base)); raw.prepare(`UPDATE edges SET origin = NULL WHERE source_id = ? AND target_id = ?`).run(a, b); raw.close(); } };
    },
}];
const gatePool = await createGatePool('link-rebuild');
if (gatePool) {
    await cleanupGateWorkspaces(gatePool);
    let seq = 0;
    engines.push({
        name: 'postgres',
        open: async () => {
            const ws = `pg-gate-lr-${process.pid}-${seq++}`;
            const g = new PostgresGraph(ws, gatePool); await g.initialize();
            return { g, nullOrigin: async (a, b) => { await gatePool.query(`UPDATE edges SET origin = NULL WHERE workspace_id = $1 AND src_sk = (SELECT sk FROM nodes WHERE workspace_id = $1 AND id = $2) AND dst_sk = (SELECT sk FROM nodes WHERE workspace_id = $1 AND id = $3)`, [ws, a, b]); } };
        },
    });
}

// ---- fake verbatim: in-memory vectors, brute-force cosine ----
const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)];
const cos = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]!;
class FakeVerbatim {
    rows = new Map<string, { vec: number[] | null }>();
    async getVectors(ids: string[]): Promise<Map<string, number[]>> {
        const m = new Map<string, number[]>();
        for (const id of ids) { const r = this.rows.get(id); if (r?.vec) m.set(id, r.vec); }
        return m;
    }
    async getById(id: string): Promise<{ ecosystem: string } | null> { return this.rows.has(id) ? { ecosystem: '*' } : null; }
    async searchByVector(v: number[], o?: { topK?: number }): Promise<Array<{ id: string; score: number }>> {
        return [...this.rows].filter(([, r]) => r.vec).map(([id, r]) => ({ id, score: cos(v, r.vec!) })).sort((x, y) => y.score - x.score).slice(0, o?.topK ?? 10);
    }
    async listIds(prefix?: string): Promise<string[]> { return [...this.rows.keys()].filter((k) => !prefix || k.startsWith(prefix)); }
}

const P = (policyVersion: string, minSim: number, k: number): LinkPolicy => ({ minSim, k, dupSim: 0.999, policyVersion });
const P_OLD = P('p-old', 0.5, 4), P_NEW = P('p-new', 0.8, 2), P_SMALL = P('p-small', 0.8, 1);
const FP = 'fp-test';
const SPEC: Array<[string, number]> = [['a', 0], ['b', 10], ['c', 20], ['d', 30], ['e', 40], ['f', 90], ['g', 100], ['h', 200]];
const node = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;
const REL = 'semantic_neighbor';
const WS = 'ws';

/** The link set a from-scratch computation gives (independent of the code under test). */
function expected(spec: Array<[string, number]>, pol: LinkPolicy): Set<string> {
    const out = new Set<string>();
    for (const [x, dx] of spec) {
        const ranked = spec.filter(([y]) => y !== x).map(([y, dy]) => ({ y, s: cos(at(dx), at(dy)) }))
            .sort((p, q) => (q.s - p.s) || p.y.localeCompare(q.y)).filter((h) => h.s >= pol.minSim).slice(0, pol.k);
        for (const h of ranked) out.add(x < h.y ? `${x}|${h.y}` : `${h.y}|${x}`);
    }
    return out;
}

async function build(eng: Eng, spec = SPEC) {
    const { g, nullOrigin } = await eng.open();
    const vb = new FakeVerbatim();
    for (const [id, deg] of spec) { await g.upsertNode(node(id)); vb.rows.set(`lore:${id}`, { vec: at(deg) }); }
    const resolve = async () => ({ graph: g as never, verbatim: vb as never });
    const mk = (pol: LinkPolicy) => new StoredVectorLinker(resolve, pol, FP);
    const storeFile = path.join(mkTmp('lr-st-'), 'q.sqlite');
    const calls: string[][] = [];
    let writes = 0;
    const rebuilder = (linker: StoredVectorLinker, opts: { batchSize?: number; isBusy?: () => boolean; maxWaitMs?: number; wrap?: (s: RebuildSubstrate) => RebuildSubstrate; file?: string; tuning?: { prefetch?: boolean } } = {}) => {
        const base: RebuildSubstrate = {
            openHandles: (w) => linker.openHandles(w),
            computeLinks: (w, ids): Promise<ComputedLinks | null> => { calls.push([...ids]); return linker.computeLinks(w, ids); },
            currentStamp: () => linker.currentStamp(),
            writeInferred: (w, gr, e) => { writes++; return linker.writeInferred(w, gr, e); },
        };
        return new LinkRebuilder({
            store: new SqliteRebuildStore(opts.file ?? storeFile), substrate: opts.wrap ? opts.wrap(base) : base,
            batchSize: opts.batchSize ?? 3, yieldMs: 0, maxWaitMs: opts.maxWaitMs ?? 1000, isBusy: opts.isBusy ?? (() => false), tuning: opts.tuning,
        });
    };
    const live = async (): Promise<Map<string, { origin?: string; policy?: string | null; at?: string }>> => {
        const out = new Map<string, { origin?: string; policy?: string | null; at?: string }>();
        for (const e of await g.queryEdges({ relation: REL, limit: 1000, offset: 0, includeProvenance: true })) {
            out.set(`${e.sourceId}|${e.targetId}`, { origin: e.provenance?.origin, policy: e.provenance?.policyVersion, at: e.provenance?.createdAt });
        }
        return out;
    };
    const liveLinks = async (): Promise<Set<string>> => new Set([...(await live())].filter(([, v]) => v.origin === 'link_on_arrival').map(([k]) => k));
    const run = async (rb: LinkRebuilder) => { await rb.start(WS); await rb.whenIdle(WS); return rb.status(WS)!; };
    return { g, vb, mk, rebuilder, live, liveLinks, run, nullOrigin, calls, writes: () => writes, storeFile };
}
const sorted = (s: Iterable<string>): string[] => [...s].sort();

for (const eng of engines) {
    console.log(`\n${eng.name}`);

    await test('policy change: rebuild == from-scratch set; dropped links soft-invalidated (valid_to), not deleted', async () => {
        const w = await build(eng);
        await w.mk(P_OLD).linkBatch(WS, SPEC.map(([id]) => ({ id })));
        const before = await w.liveLinks();
        assert.deepEqual(sorted(before), sorted(expected(SPEC, P_OLD)), 'precondition: arrival links under the old policy');
        const want = expected(SPEC, P_NEW);
        const dropped = sorted([...before].filter((k) => !want.has(k)));
        assert.ok(dropped.length > 0 && want.size > 0);

        const st = await w.run(w.rebuilder(w.mk(P_NEW)));
        assert.equal(st.status, 'done');
        assert.deepEqual([st.done, st.total], [SPEC.length, SPEC.length]);
        assert.deepEqual(sorted(await w.liveLinks()), sorted(want));
        assert.equal(st.invalidated, dropped.length);
        assert.equal(st.inserted, 0, 'the tighter policy only keeps existing pairs');
        assert.equal(st.refreshed, want.size, 'kept links are restamped p-old -> p-new');
        assert.equal(st.unchanged, 0);
        const all = await w.g.queryEdges({ relation: REL, limit: 1000, offset: 0, includeProvenance: true, includeInvalidated: true });
        const gone = all.filter((e) => e.provenance?.validTo);
        assert.deepEqual(sorted(gone.map((e) => `${e.sourceId}|${e.targetId}`)), dropped, 'invalidated, still readable with includeInvalidated');
        for (const e of await w.g.queryEdges({ relation: REL, limit: 1000, offset: 0, includeProvenance: true })) assert.equal(e.provenance?.policyVersion, 'p-new');
    });

    await test('looser policy: missing links are inserted, nothing invalidated', async () => {
        const w = await build(eng);
        await w.mk(P_SMALL).linkBatch(WS, SPEC.map(([id]) => ({ id })));
        const had = await w.liveLinks();
        const st = await w.run(w.rebuilder(w.mk(P_NEW)));
        const want = expected(SPEC, P_NEW);
        assert.deepEqual(sorted(await w.liveLinks()), sorted(want));
        assert.equal(st.inserted, [...want].filter((k) => !had.has(k)).length);
        assert.ok(st.inserted > 0);
        assert.equal(st.invalidated, 0);
    });

    await test('second run writes nothing: unchanged edges keep their stamp and created_at', async () => {
        const w = await build(eng);
        await w.mk(P_OLD).linkBatch(WS, SPEC.map(([id]) => ({ id })));
        await w.run(w.rebuilder(w.mk(P_NEW)));
        const before = await w.live();
        const writesBefore = w.writes();
        await sleep(15);
        const st = await w.run(w.rebuilder(w.mk(P_NEW)));
        assert.equal(w.writes(), writesBefore, 'no write call at all');
        assert.deepEqual([st.inserted, st.refreshed, st.invalidated], [0, 0, 0]);
        assert.equal(st.unchanged, before.size);
        assert.deepEqual([...await w.live()], [...before], 'provenance (incl. created_at) untouched');
    });

    await test('non link_on_arrival edges are never invalidated; a wanted pair they hold is left alone', async () => {
        const w = await build(eng);
        const add = (s: string, t: string, origin: string) => w.g.addEdge({ sourceId: s, targetId: t, relation: REL, confidence: 'extracted', confidenceScore: 1, provenance: { origin } as never } as never);
        await add('a', 'h', 'caller');      // unwanted, far apart
        await add('b', 'g', 'import');
        await add('c', 'f', 'reconnect');
        await add('d', 'h', 'discovery');
        await add('e', 'g', 'caller'); await w.nullOrigin('e', 'g'); // legacy: no origin
        await add('a', 'b', 'caller');      // WANTED pair, held by a caller edge
        const before = await w.live();
        const st = await w.run(w.rebuilder(w.mk(P_NEW)));
        const after = await w.live();
        for (const k of ['a|h', 'b|g', 'c|f', 'd|h', 'e|g']) assert.deepEqual(after.get(k), before.get(k), `${k} untouched and live`);
        assert.equal(after.get('a|b')?.origin, 'caller', 'not hijacked into link_on_arrival');
        assert.equal(st.invalidated, 0);
        assert.ok(st.keptForeign >= 1);
        const want = expected(SPEC, P_NEW); want.delete('a|b');
        assert.deepEqual(sorted([...after].filter(([, v]) => v.origin === 'link_on_arrival').map(([k]) => k)), sorted(want));
    });

    await test('an edge wanted by only one endpoint survives however batches fall (fresh recheck, batch size 1)', async () => {
        const spec: Array<[string, number]> = [['c', 0], ['b', 5], ['a', 7]];
        const w = await build(eng, spec);
        const pol = P('p-1', 0.8, 1);
        await w.mk(pol).linkBatch(WS, spec.map(([id]) => ({ id })));
        const want = expected(spec, pol);
        assert.deepEqual(sorted(want), ['a|b', 'b|c'], 'precondition: b|c is wanted by c only');
        const st = await w.run(w.rebuilder(w.mk(pol), { batchSize: 1 }));
        assert.equal(st.invalidated, 0);
        assert.equal(st.unchanged, 2, 'each edge judged once');
        assert.deepEqual(sorted(await w.liveLinks()), sorted(want));
    });

    await test('no-vector endpoint: edge kept (unknown); vanished endpoint: edge dropped (gone)', async () => {
        const spec: Array<[string, number]> = [['a', 0], ['b', 10], ['z', 20], ['m', 200]];
        const w = await build(eng, spec);
        w.vb.rows.get('lore:z')!.vec = null;          // z: row without a vector
        await w.g.upsertNode(node('x'));            // x: node in the graph, verbatim row gone (never listed)
        const stamp = { origin: 'link_on_arrival', policyVersion: 'p-old', modelFingerprint: FP } as const;
        await w.g.addInferredEdgesBatch([
            { sourceId: 'a', targetId: 'z', relation: REL, confidenceScore: 0.9, provenance: stamp },
            { sourceId: 'm', targetId: 'x', relation: REL, confidenceScore: 0.9, provenance: stamp },
        ]);
        const st = await w.run(w.rebuilder(w.mk(P_NEW)));
        const live = await w.liveLinks();
        assert.ok(live.has('a|z'), 'edge to a no-vector node is kept');
        assert.ok(!live.has('m|x'), 'edge to a vanished node is dropped');
        assert.ok(st.skippedNoVector >= 1 && st.invalidated === 1);
    });

    await test('mid-run: old links still live; an arrival during the run keeps its links', async () => {
        const w = await build(eng);
        await w.mk(P_OLD).linkBatch(WS, SPEC.map(([id]) => ({ id })));
        const old = await w.liveLinks();
        let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
        let n = 0; let paused!: () => void; const reachedPause = new Promise<void>((r) => { paused = r; });
        const rb = w.rebuilder(w.mk(P_NEW), {
            batchSize: 2, tuning: { prefetch: false }, // the gate counts computeLinks calls: this test pins the sequential order
            wrap: (s) => ({ ...s, computeLinks: async (ws, ids) => { if (++n === 3) { paused(); await gate; } return s.computeLinks(ws, ids); } }),
        });
        await rb.start(WS);
        await reachedPause;
        const mid = rb.status(WS)!;
        assert.equal(mid.status, 'running');
        assert.ok(mid.done > 0 && mid.done < mid.total, 'genuinely mid-run');
        const nowLive = await w.liveLinks();
        const notYet = [...old].filter((k) => k.split('|')[0]! > mid.cursor!);
        assert.ok(notYet.length > 0 && notYet.every((k) => nowLive.has(k)), 'edges of unprocessed nodes are still live');
        // arrival during the run
        w.vb.rows.set('lore:n', { vec: at(15) }); await w.g.upsertNode(node('n'));
        await w.mk(P_NEW).linkBatch(WS, [{ id: 'n' }]);
        const arrival = [...await w.liveLinks()].filter((k) => k.split('|').includes('n'));
        assert.ok(arrival.length > 0);
        release();
        await rb.whenIdle(WS);
        const fin = await w.liveLinks();
        for (const k of arrival) assert.ok(fin.has(k), `arrival link ${k} survived the sweep`);
        assert.equal(rb.status(WS)!.status, 'done');
    });

    await test('resume: a sealed run continues after its cursor in a NEW instance, repeating no batch', async () => {
        const w = await build(eng);
        await w.mk(P_OLD).linkBatch(WS, SPEC.map(([id]) => ({ id })));
        let calls1 = 0; let rbA!: LinkRebuilder;
        rbA = w.rebuilder(w.mk(P_NEW), {
            batchSize: 2,
            wrap: (s) => ({ ...s, computeLinks: async (ws, ids) => { if (++calls1 === 3) rbA.seal(); return s.computeLinks(ws, ids); } }),
        });
        await rbA.start(WS); await rbA.whenIdle(WS);
        const sealed = rbA.status(WS)!;
        assert.equal(sealed.status, 'running', 'seal leaves the checkpoint resumable');
        assert.ok(sealed.cursor && sealed.done > 0 && sealed.done < sealed.total);
        const doneIds = SPEC.map(([id]) => id).filter((id) => id <= sealed.cursor!);
        rbA.close();
        w.calls.length = 0;

        const rbB = w.rebuilder(w.mk(P_NEW), { batchSize: 2 });
        rbB.resumeAll();
        await rbB.whenIdle(WS);
        const fin = rbB.status(WS)!;
        assert.equal(fin.status, 'done');
        assert.equal(fin.done, fin.total);
        const firstNext = SPEC.map(([id]) => id).find((id) => id > sealed.cursor!)!;
        assert.equal(w.calls[0]![0], firstNext, 'the first batch after the restart starts right after the checkpoint cursor');
        assert.ok(doneIds.length > 0 && !w.calls.slice(0, 1).flat().some((id) => doneIds.includes(id)), 'no finished node recomputed');
        assert.deepEqual(sorted(await w.liveLinks()), sorted(expected(SPEC, P_NEW)));
    });

    await test('resume: a failed run restarts at its cursor; a changed policy starts fresh', async () => {
        const w = await build(eng);
        await w.mk(P_OLD).linkBatch(WS, SPEC.map(([id]) => ({ id })));
        let n = 0;
        const rb = w.rebuilder(w.mk(P_NEW), { batchSize: 2, tuning: { prefetch: false }, wrap: (s) => ({ ...s, computeLinks: async (ws, ids) => { if (++n === 3) throw new Error('boom'); return s.computeLinks(ws, ids); } }) });
        const failed1 = await w.run(rb);
        assert.equal(failed1.status, 'failed');
        assert.match(failed1.lastError ?? '', /boom/);
        const cursor = failed1.cursor;
        assert.ok(cursor);
        const started = await rb.start(WS); await rb.whenIdle(WS);
        assert.equal(started.resumed, true);
        const ok = rb.status(WS)!;
        assert.equal(ok.status, 'done');
        assert.equal(ok.runId, failed1.runId, 'same run, counters carried');
        assert.deepEqual(sorted(await w.liveLinks()), sorted(expected(SPEC, P_NEW)));
        // same checkpoint file, different policy -> not resumable
        const other = w.rebuilder(w.mk(P('p-other', 0.8, 2)), { batchSize: 2 });
        const again = await other.start(WS); await other.whenIdle(WS);
        assert.equal(again.resumed, false);
        assert.notEqual(other.status(WS)!.runId, failed1.runId);
    });

    await test('throttle: waits while busy, then runs; maxWait guarantees progress under constant load', async () => {
        const w = await build(eng);
        let busy = true;
        const rb = w.rebuilder(w.mk(P_NEW), { isBusy: () => busy, maxWaitMs: 60_000 });
        await rb.start(WS);
        await sleep(180);
        assert.equal(rb.status(WS)!.done, 0, 'no batch while busy');
        assert.ok(rb.stats().busyWaits >= 1);
        busy = false;
        await rb.whenIdle(WS);
        assert.equal(rb.status(WS)!.status, 'done');

        const w2 = await build(eng);
        const rb2 = w2.rebuilder(w2.mk(P_NEW), { isBusy: () => true, maxWaitMs: 100 });
        const st = await w2.run(rb2);
        assert.equal(st.status, 'done', 'a never-quiet host still finishes');
    });

    await test('cancel stops after the current batch and keeps what was done', async () => {
        const w = await build(eng);
        let rb!: LinkRebuilder; let n = 0;
        rb = w.rebuilder(w.mk(P_NEW), { batchSize: 2, wrap: (s) => ({ ...s, computeLinks: async (ws, ids) => { if (++n === 2) rb.cancel(WS); return s.computeLinks(ws, ids); } }) });
        const st = await w.run(rb);
        assert.equal(st.status, 'cancelled');
        assert.ok(st.done < st.total && st.done >= 2);
    });
}

console.log('\nservice + admin route (sqlite)');
await test('LinkService exposes the rebuild (stats + admin route: start, status, idempotent start, cancel, 404s)', async () => {
    const w = await build(engines[0]!);
    await w.mk(P_OLD).linkBatch(WS, SPEC.map(([id]) => ({ id })));
    const svc = createLinkService({
        loreDir: mkTmp('lr-svc-'), env: { LORE_LINK_ON_ARRIVAL: '1', LORE_LINK_MIN_SIM: '0.8', LORE_LINK_K: '2', LORE_LINK_POLICY_VERSION: 'p-new', LORE_LINK_REBUILD_YIELD_MS: '0', LORE_LINK_REBUILD_BATCH_SIZE: '3' },
        resolveHandles: async () => ({ graph: w.g as never, verbatim: w.vb as never }),
        embeddingProvider: { modelId: 'fp', dtype: 'test' } as never,
    })!;
    const call = async (method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> => {
        const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {} }) as never;
        let status = 0; let text = '';
        const res = { writeHead: (s: number) => { status = s; }, end: (t?: string) => { text = t ?? ''; }, setHeader: () => undefined, headersSent: false } as never;
        const handled = await tryLinkRebuildRoutes(req, res, url, url.split('?')[0]!, { linkService: svc, deploymentMode: 'local', dataplane: null });
        assert.equal(handled, true);
        return { status, json: text ? JSON.parse(text) : null };
    };
    assert.equal((await call('GET', '/api/admin/link-rebuild?workspace=ws')).status, 404, 'nothing recorded yet');
    assert.equal((await call('POST', '/api/admin/link-rebuild', { action: 'start' })).status, 400, 'workspace required');
    assert.equal((await call('POST', '/api/admin/link-rebuild', { workspace: 'ws', action: 'explode' })).status, 400);
    const started = await call('POST', '/api/admin/link-rebuild', { workspace: WS });
    assert.equal(started.status, 202);
    assert.equal(started.json.started, true);
    for (let i = 0; i < 100 && svc.rebuildStatus(WS)?.status === 'running'; i++) await sleep(20);
    const st = await call('GET', '/api/admin/link-rebuild?workspace=ws');
    assert.equal(st.json.rebuild.status, 'done');
    assert.equal(st.json.rebuild.total, SPEC.length);
    assert.ok(st.json.rebuild.invalidated > 0);
    const stats = svc.stats();
    assert.equal(stats.rebuild?.runs.length, 1);
    assert.equal(stats.rebuild?.runs[0]?.workspace, WS);
    assert.equal(stats.rebuild?.active, 0);
    assert.equal((await call('POST', '/api/admin/link-rebuild', { workspace: 'ws', action: 'cancel' })).json.cancelled, false, 'nothing to cancel');
    assert.equal((await call('GET', '/api/admin/link-rebuild')).json.rebuild.runs.length, 1);
    svc.close();
    const off = await tryLinkRebuildRoutes(Object.assign(Readable.from([]), { method: 'GET', headers: {} }) as never, { writeHead: () => undefined, end: () => undefined } as never, '/api/admin/link-rebuild', '/api/admin/link-rebuild', { linkService: null, deploymentMode: 'local', dataplane: null });
    assert.equal(off, true, 'flag off: handled as 404, not a fall-through');
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
if (gatePool) { await cleanupGateWorkspaces(gatePool); await closeGatePool(gatePool); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

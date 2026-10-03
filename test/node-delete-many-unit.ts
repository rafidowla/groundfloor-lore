#!/usr/bin/env tsx
/**
 * node-delete-many-unit.ts — 3.27.0: `LoreInstance.nodeDeleteMany({ ids, workspace, purge? })`.
 *
 * Boots a real embedded `createLore()` per verbatim engine (SQLite and LanceDB
 * verbatim; SQLite graph) on a throwaway home; the background replicator is
 * stopped so every replay is an explicit `tickOnce()`.
 *
 * Pinned, on both engines:
 *   - purge of 55+ nodes (history rows, some with question aliases): every
 *     row is gone, neighbours (`n0#x`, a `_`-id look-alike) survive, no
 *     embedding path (tombstone/store/storeBatch) is called, per-id results
 *     are right and missing ids report deleted:false;
 *   - default (tombstone) mode equals per-id `nodeDelete`: same per-node outbox
 *     kind/order and same final store state;
 *   - replay convergence after a purge: stale pending `verbatim.upsert` rows
 *     (node and alias) do not resurrect content;
 *   - one failing id does not abort the others;
 *   - nodeDeleteMany racing nodeUpsert on overlapping ids: no deadlock, and the
 *     graph and verbatim stores agree afterwards;
 *   - validation errors, and dedupe of repeated ids.
 * LanceDB only: a purge of N nodes issues O(chunks) table queries/deletes.
 *
 * Run: npx tsx test/node-delete-many-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLore } from '../packages/lore/src/index.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const WS = 'default';
const homes: string[] = [];
function seedHome(vectorEngine: 'sqlite' | 'lance'): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-del-many-${vectorEngine}-`));
    homes.push(home);
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: 'default',
        workspaces: [{ name: 'default', path: home, createdAt: '2026-10-02T00:00:00.000Z', graphEngine: 'sqlite', vectorEngine }],
    }, null, 2));
    return home;
}
type Lore = Awaited<ReturnType<typeof createLore>>;
async function boot(home: string): Promise<Lore> {
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });
    await (lore._daemon.outboxWiring.replicator as { stop(): Promise<void> }).stop();
    return lore;
}
const pendingRows = (lore: Lore): Promise<OutboxEntry[]> => lore._daemon.outboxWiring.store.listPendingForWorkspace!(WS, 5000);
async function drain(lore: Lore): Promise<void> {
    const r = lore._daemon.outboxWiring.replicator as { tickOnce(): Promise<number> };
    for (let i = 0; i < 80; i++) {
        if ((await pendingRows(lore)).length === 0) return;
        await r.tickOnce();
    }
    assert.fail(`outbox did not drain: ${JSON.stringify((await pendingRows(lore)).slice(0, 5).map((e) => [e.operationKind, e.status, e.lastError]))}`);
}
const save = (lore: Lore, id: string, body = `${id} body`) => lore.nodeUpsert({
    id, workspace: WS, ecosystem: '*', skipEmbed: true,
    nodeData: { id, type: 'note', label: id, content: body, tags: '', project: WS, ecosystem: '*', metadata: '{}' },
});
const read = (lore: Lore, id: string) => lore.store.storageClient.getNode(id, { workspace: WS });

interface VStore {
    getById(id: string): Promise<{ text?: string } | null>;
    getHistory(id: string): Promise<unknown[]>;
    store(doc: { id: string; text: string; metadata: Record<string, unknown> }): Promise<void>;
}
const META = { type: 'note', label: 'L', tags: '', project: WS, ecosystem: '*', updatedAt: '2026-10-02T00:00:00.000Z', security_scopes: [] as string[] };
const vstore = async (lore: Lore): Promise<VStore> => await lore._daemon.getVerbatimResolver()!.getOrOpen(WS) as unknown as VStore;
async function seedRows(v: VStore, id: string): Promise<void> {
    for (const t of ['one', 'two', 'three']) await v.store({ id, text: `${t} body of ${id}`, metadata: { ...META, updatedAt: `2026-10-02T00:00:0${t.length % 10}.000Z` } });
}
const rowsOf = async (v: VStore, id: string): Promise<number> => ((await v.getById(id)) ? 1 : 0) + (await v.getHistory(id)).length;
const aliasId = (id: string, i: number) => `lore:${id}#q${i}`;
/** Nodes saved in the graph (replayed clean), each with verbatim rows + history for the canonical id and `aliasesOf(i)` aliases. */
async function prepMany(lore: Lore, ids: string[], aliasesOf: (i: number) => number): Promise<VStore> {
    for (const id of ids) assert.ok((await save(lore, id)).ok, `save ${id}`);
    await drain(lore);
    const v = await vstore(lore);
    for (let i = 0; i < ids.length; i++) {
        await seedRows(v, `lore:${ids[i]}`);
        for (let a = 0; a < aliasesOf(i); a++) await seedRows(v, aliasId(ids[i]!, a));
    }
    return v;
}
const queueUpsert = (lore: Lore, id: string) => recordHotWrite(lore._daemon.outboxWiring.store, {
    workspace: WS, operationKind: 'verbatim.upsert', initiator: 'test',
    payload: { id, text: `queued body of ${id}`, metadata: { ...META } },
});
/** Replace the embedding paths with call recorders (the originals still run). */
function spyEmbedPaths(v: VStore): string[] {
    const calls: string[] = [];
    const raw = v as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const m of ['tombstone', 'store', 'storeBatch']) {
        const orig = raw[m];
        if (typeof orig === 'function') raw[m] = async function (this: unknown, ...a: unknown[]) { calls.push(m); return orig.apply(this, a); };
    }
    return calls;
}
/** node key of an outbox row: `lore:x`, `lore:x#q1` and `x` all map to `x`. */
const keyOf = (e: OutboxEntry): string => String(e.payload!['id']).replace(/^lore:/, '').replace(/#q\d+$/, '');
/** Per-node `kind:suffix` sequences (order within a node is the contract; global order is not). */
function perNodeSequences(rows: OutboxEntry[], norm: (k: string) => string): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const e of rows) {
        const k = norm(keyOf(e));
        const suffix = /#q\d+$/.test(String(e.payload!['id'])) ? String(e.payload!['id']).match(/#q\d+$/)![0] : '';
        (m.get(k) ?? m.set(k, []).get(k)!).push(`${e.operationKind}${suffix}`);
    }
    return m;
}

for (const engine of ['sqlite', 'lance'] as const) {
    console.log(`\nembedded createLore - ${engine} verbatim\n`);
    const home = seedHome(engine);
    const lore = await boot(home);
    try {
        await test(`[${engine}] purge of 55 nodes (history, aliases): rows gone, neighbours survive, no embed call, per-id results`, async () => {
            const ids = Array.from({ length: 52 }, (_, i) => `pn${i}`).concat(['pw_1', 'pn0q']);
            const v = await prepMany(lore, ids, (i) => (i % 3 === 0 ? 1 + (i % 2) : 0));
            // Neighbours: another node whose id extends pn0, a look-alike of the `_` id, a node outside the call.
            await seedRows(v, 'lore:pn0#x');
            await seedRows(v, 'lore:pwX1');
            await seedRows(v, aliasId('pn0', 3));      // alias slot that is NOT one of pn0's existing aliases... covered by the 5-slot rule only when unknown
            await prepMany(lore, ['keep1'], () => 1);
            await drain(lore);
            const calls = spyEmbedPaths(v);
            const askIds = [...ids, 'ghost-1', 'ghost-2'];
            const { results } = await lore.nodeDeleteMany({ ids: askIds, workspace: WS, purge: true });
            assert.deepEqual(calls, [], 'purge never tombstones or re-stores (no embedding)');
            assert.equal(results.length, askIds.length);
            assert.deepEqual(results.map((r) => r.id), askIds, 'results in request order');
            for (const r of results) {
                if (r.id.startsWith('ghost')) { assert.equal(r.deleted, false, r.id); assert.equal(r.purged, undefined, r.id); }
                else { assert.equal(r.deleted, true, r.id); assert.equal(r.purged, true, r.id); assert.equal(r.verbatimWarning, undefined, r.id); assert.equal(r.error, undefined, r.id); }
            }
            const kinds = (await pendingRows(lore)).map((e) => e.operationKind);
            assert.equal(kinds.filter((k) => k === 'node.delete').length, askIds.length, 'one node.delete row per id (ghosts too, as nodeDelete)');
            assert.equal(kinds.filter((k) => k === 'verbatim.purge').length, ids.length, 'one verbatim.purge row per deleted node');
            assert.equal(kinds.filter((k) => k === 'verbatim.tombstone').length, 0);
            await drain(lore);
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i]!;
                assert.equal(await read(lore, id), null, `${id} gone from the graph`);
                assert.equal(await rowsOf(v, `lore:${id}`), 0, `lore:${id} and history gone`);
                for (let a = 0; a < (i % 3 === 0 ? 1 + (i % 2) : 0); a++) assert.equal(await rowsOf(v, aliasId(id, a)), 0, `${aliasId(id, a)} gone`);
            }
            assert.ok((await rowsOf(v, 'lore:pn0#x')) >= 2, 'lore:pn0#x (another node) survives with its history');
            assert.ok((await rowsOf(v, 'lore:pwX1')) >= 2, 'lore:pwX1 survives the purge of pw_1 (LIKE wildcard escaped)');
            assert.ok((await rowsOf(v, 'lore:keep1')) >= 2, 'a node outside the call survives');
            assert.ok((await rowsOf(v, aliasId('keep1', 0))) >= 2, 'its alias survives');
            assert.ok(await read(lore, 'keep1'), 'its graph node survives');
        });

        await test(`[${engine}] default (tombstone) nodeDeleteMany equals per-id nodeDelete: outbox kinds/order and final store state`, async () => {
            const n = 12;
            const mIds = Array.from({ length: n }, (_, i) => `tm${i}`);
            const sIds = Array.from({ length: n }, (_, i) => `ts${i}`);
            const aliases = (i: number) => i % 4;
            const v = await prepMany(lore, [...mIds, ...sIds], (i) => aliases(i % n));
            await drain(lore);
            await queueUpsert(lore, aliasId('tm5', 4));   // queued alias upsert not yet in the store: covered in both paths
            await queueUpsert(lore, aliasId('ts5', 4));
            const before = (await pendingRows(lore)).length;
            const out = await lore.nodeDeleteMany({ ids: [...mIds, 'tm-ghost'], workspace: WS });
            const manyRows = (await pendingRows(lore)).slice(before);
            for (const r of out.results) assert.equal(r.deleted, r.id !== 'tm-ghost', r.id);
            assert.ok(out.results.every((r) => r.purged === undefined));
            await drain(lore);
            const mid = (await pendingRows(lore)).length;
            for (const id of sIds) assert.equal((await lore.nodeDelete({ id, workspace: WS })).deleted, true);
            assert.deepEqual((await lore.nodeDelete({ id: 'ts-ghost', workspace: WS })).deleted, false);
            const oneRows = (await pendingRows(lore)).slice(mid);
            const norm = (k: string) => k.replace(/^t[ms]/, 'tX');
            const many = perNodeSequences(manyRows, norm);
            const one = perNodeSequences(oneRows, norm);
            many.delete('tX-ghost'); one.delete('tX-ghost');
            assert.deepEqual([...many.keys()].sort(), [...one.keys()].sort());
            for (const [k, seq] of one) assert.deepEqual(many.get(k), seq, `per-node outbox sequence for ${k}`);
            assert.equal(manyRows.filter((e) => e.operationKind === 'node.delete').length, n + 1, 'node.delete for every id incl. the ghost, as nodeDelete');
            await drain(lore);
            for (let i = 0; i < n; i++) {
                assert.equal(await read(lore, mIds[i]!), null);
                assert.equal(await read(lore, sIds[i]!), null);
                for (const slot of [`lore:%`, ...Array.from({ length: 5 }, (_, a) => `#q${a}`)]) {
                    const idOf = (base: string) => (slot === 'lore:%' ? `lore:${base}` : `lore:${base}${slot}`);
                    const [m, s] = [await v.getById(idOf(mIds[i]!)), await v.getById(idOf(sIds[i]!))];
                    assert.equal(Boolean(m), Boolean(s), `row presence for ${idOf(mIds[i]!)}`);
                    if (m && s) {
                        assert.equal(Boolean(m.text?.startsWith('[TOMBSTONED')), Boolean(s.text?.startsWith('[TOMBSTONED')), `tombstone state for ${idOf(mIds[i]!)}`);
                        assert.equal((await v.getHistory(idOf(mIds[i]!))).length, (await v.getHistory(idOf(sIds[i]!))).length, `history size for ${idOf(mIds[i]!)}`);
                    }
                }
            }
        });

        await test(`[${engine}] stale pending verbatim.upsert (node + alias) does not resurrect content after a many-purge`, async () => {
            const ids = ['st0', 'st1', 'st2'];
            const v = await prepMany(lore, ids, () => 1);
            await drain(lore);
            for (const id of ids) { await queueUpsert(lore, `lore:${id}`); await queueUpsert(lore, aliasId(id, 0)); }
            const { results } = await lore.nodeDeleteMany({ ids, workspace: WS, purge: true });
            assert.ok(results.every((r) => r.deleted && r.purged));
            await drain(lore);
            for (const id of ids) {
                assert.equal(await rowsOf(v, `lore:${id}`), 0, `lore:${id}`);
                assert.equal(await rowsOf(v, aliasId(id, 0)), 0, aliasId(id, 0));
                assert.equal(await read(lore, id), null);
            }
        });

        await test(`[${engine}] one failing id does not abort the others (reported in its result)`, async () => {
            const ids = ['f0', 'f1', 'f2', 'f3'];
            const v = await prepMany(lore, ids, () => 0);
            await drain(lore);
            const raw = v as unknown as { purgeWithHistory?: (ids: string[]) => Promise<number> };
            const orig = raw.purgeWithHistory;
            if (typeof orig !== 'function') return;
            raw.purgeWithHistory = async function (this: unknown, list: string[]) {
                if (list.includes('lore:f2')) throw new Error('simulated purge failure');
                return orig.call(this, list);
            };
            try {
                const { results } = await lore.nodeDeleteMany({ ids, workspace: WS, purge: true });
                const by = new Map(results.map((r) => [r.id, r]));
                for (const id of ['f0', 'f1', 'f3']) { assert.equal(by.get(id)!.deleted, true); assert.equal(by.get(id)!.purged, true, id); }
                assert.equal(by.get('f2')!.deleted, true, 'the graph delete still happened');
                assert.ok(by.get('f2')!.verbatimWarning?.includes('purge failed'), `warning: ${by.get('f2')!.verbatimWarning}`);
                assert.notEqual(by.get('f2')!.purged, true);
                for (const id of ['f0', 'f1', 'f3']) assert.equal(await rowsOf(v, `lore:${id}`), 0, `${id} purged`);
            } finally { raw.purgeWithHistory = orig; }
            await drain(lore); // the pending purge row for f2 completes on replay
            assert.equal(await rowsOf(v, 'lore:f2'), 0, 'replay completes the failed purge');
        });

        await test(`[${engine}] nodeDeleteMany racing nodeUpsert on overlapping ids: no deadlock, graph and verbatim agree`, async () => {
            const ids = Array.from({ length: 60 }, (_, i) => `rc${i}`);
            const v = await prepMany(lore, ids, (i) => i % 2);
            await drain(lore);
            const racers = ids.filter((_, i) => i % 2 === 0 || i % 3 === 0);   // overlap with the delete set
            const work = Promise.all([
                lore.nodeDeleteMany({ ids, workspace: WS, purge: true }),
                ...racers.map((id) => save(lore, id, `${id} rewritten`)),
                lore.nodeDeleteMany({ ids: ids.slice(20, 80), workspace: WS }),   // a second overlapping many-delete (tombstone mode)
            ]);
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('deadlock: race did not settle in 60s')), 60_000); });
            try { await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
            await drain(lore);
            let present = 0, absent = 0;
            for (const id of ids) {
                const node = await read(lore, id);
                const row = await v.getById(`lore:${id}`);
                if (node) {
                    present++;
                    if (row) assert.ok(!row.text?.startsWith('[TOMBSTONED'), `${id}: a live graph node must not have a tombstoned verbatim row`);
                } else {
                    absent++;
                    if (row) assert.ok(row.text?.startsWith('[TOMBSTONED'), `${id}: no graph node but a live verbatim row (split brain)`);
                }
            }
            assert.equal(present + absent, ids.length);
        });

        await test(`[${engine}] validation: workspace, ids shape, max per call, dedupe`, async () => {
            const call = (a: unknown) => (lore as unknown as { nodeDeleteMany(a: unknown): Promise<unknown> }).nodeDeleteMany(a);
            await assert.rejects(call({ ids: ['a'] }), /workspace is required/);
            await assert.rejects(call({ ids: ['a'], workspace: '' }), /workspace is required/);
            await assert.rejects(call({ workspace: WS }), /ids must be a non-empty array/);
            await assert.rejects(call({ ids: [], workspace: WS }), /ids must be a non-empty array/);
            await assert.rejects(call({ ids: 'a', workspace: WS }), /ids must be a non-empty array/);
            await assert.rejects(call({ ids: ['a', ''], workspace: WS }), /every id must be a non-empty string/);
            await assert.rejects(call({ ids: ['a', 7], workspace: WS }), /every id must be a non-empty string/);
            await assert.rejects(call({ ids: Array.from({ length: 10_001 }, (_, i) => `x${i}`), workspace: WS }), /at most 10000 ids per call \(got 10001\)/);
            await prepMany(lore, ['dd'], () => 0);
            await drain(lore);
            const { results } = await lore.nodeDeleteMany({ ids: ['dd', 'dd', 'dd'], workspace: WS, purge: true });
            assert.equal(results.length, 1, 'repeated ids are deduped');
            assert.equal(results[0]!.deleted, true);
        });

        if (engine === 'lance') {
            await test(`[lance] purge of 120 nodes issues O(chunks) table queries/deletes, not O(N)`, async () => {
                const N = 120;
                const ids = Array.from({ length: N }, (_, i) => `lq${i}`);
                const v = await prepMany(lore, ids, () => 1);
                await drain(lore);
                const table = (v as unknown as { table: Record<string, (...a: unknown[]) => unknown> }).table;
                assert.ok(table, 'lance table is open');
                const count = { query: 0, delete: 0 };
                const origQ = table['query']!, origD = table['delete']!;
                table['query'] = function (this: unknown, ...a: unknown[]) { count.query++; return origQ.apply(this, a); };
                table['delete'] = function (this: unknown, ...a: unknown[]) { count.delete++; return origD.apply(this, a); };
                try {
                    const { results } = await lore.nodeDeleteMany({ ids, workspace: WS, purge: true });
                    assert.ok(results.every((r) => r.deleted && r.purged));
                } finally { table['query'] = origQ; table['delete'] = origD; }
                const chunks = Math.ceil(N / 50);
                console.log(`        lance purge of ${N} nodes (${chunks} chunks): ${count.query} queries, ${count.delete} deletes (${(count.query / chunks).toFixed(2)} q/chunk, ${(count.delete / chunks).toFixed(2)} d/chunk)`);
                assert.ok(count.query <= 3 * chunks, `queries ${count.query} must be O(chunks=${chunks}), not O(N=${N})`);
                assert.ok(count.delete <= 2 * chunks, `deletes ${count.delete} must be O(chunks=${chunks}), not O(N=${N})`);
                await drain(lore);
                for (const id of ids) assert.equal(await rowsOf(v, `lore:${id}`), 0, id);
            });
        }
    } finally {
        await lore.dispose('test');
    }
}

for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

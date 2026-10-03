#!/usr/bin/env tsx
/**
 * node-delete-purge-embedded-unit.ts — 3.27.0: `LoreInstance.nodeDelete({ purge: true })`
 * and alias tombstones only for aliases that exist.
 *
 * Boots a real embedded `createLore()` per verbatim engine (SQLite and LanceDB
 * verbatim; SQLite graph) on a throwaway home; the background replicator is
 * stopped so every replay is an explicit `tickOnce()`.
 *
 * Pinned:
 *   - purge: canonical + history + alias rows (and their history) are gone,
 *     `purged: true`, ONE `verbatim.purge` row `{ id: 'lore:<id>', ids }`, and the
 *     store's tombstone()/store() (the embedding paths) are never called;
 *   - default delete is unchanged: tombstone, history kept;
 *   - outbox rows per delete: no alias 2, two aliases 4 (default), purge 2;
 *   - a queued `verbatim.upsert` for an alias that is not in the store yet is
 *     still covered (tombstone row / purge id);
 *   - replay after a purge converges to absent; a stale pending `verbatim.upsert`
 *     (node or alias) and a failed alias upsert do not resurrect content;
 *   - purge of an unknown id: deleted:false, nothing recorded.
 *
 * Run: npx tsx test/node-delete-purge-embedded-unit.ts
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-del-purge-${vectorEngine}-`));
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
const pendingRows = (lore: Lore): Promise<OutboxEntry[]> => lore._daemon.outboxWiring.store.listPendingForWorkspace!(WS, 1000);
async function drain(lore: Lore): Promise<void> {
    const r = lore._daemon.outboxWiring.replicator as { tickOnce(): Promise<number> };
    for (let i = 0; i < 40; i++) {
        if ((await pendingRows(lore)).length === 0) return;
        await r.tickOnce();
    }
    assert.fail(`outbox did not drain: ${JSON.stringify((await pendingRows(lore)).map((e) => [e.operationKind, e.status, e.lastError]))}`);
}
const save = (lore: Lore, id: string) => lore.nodeUpsert({
    id, workspace: WS, ecosystem: '*', skipEmbed: true,
    nodeData: { id, type: 'note', label: id, content: `${id} body`, tags: '', project: WS, ecosystem: '*', metadata: '{}' },
});
const read = (lore: Lore, id: string) => lore.store.storageClient.getNode(id, { workspace: WS });

interface VStore {
    getById(id: string): Promise<{ text?: string } | null>;
    getHistory(id: string): Promise<unknown[]>;
    store(doc: { id: string; text: string; metadata: Record<string, unknown> }): Promise<void>;
    listIds(prefix?: string, opts?: { includeHistory?: boolean }): Promise<string[]>;
}
const META = { type: 'note', label: 'L', tags: '', project: WS, ecosystem: '*', updatedAt: '2026-10-02T00:00:00.000Z', security_scopes: [] as string[] };
const vstore = async (lore: Lore): Promise<VStore> => await lore._daemon.getVerbatimResolver()!.getOrOpen(WS) as unknown as VStore;
async function seedRows(v: VStore, id: string): Promise<void> {
    for (const t of ['one', 'two', 'three']) await v.store({ id, text: `${t} body of ${id}`, metadata: { ...META, updatedAt: `2026-10-02T00:00:0${t.length % 10}.000Z` } });
}
const rowsOf = async (v: VStore, id: string): Promise<number> => ((await v.getById(id)) ? 1 : 0) + (await v.getHistory(id)).length;
const aliasId = (id: string, i: number) => `lore:${id}#q${i}`;
/** A node in the graph (replayed clean) with verbatim rows + history for the canonical id and `aliases` question aliases. */
async function prep(lore: Lore, id: string, aliases: number): Promise<VStore> {
    assert.ok((await save(lore, id)).ok);
    await drain(lore);
    const v = await vstore(lore);
    await seedRows(v, `lore:${id}`);
    for (let i = 0; i < aliases; i++) await seedRows(v, aliasId(id, i));
    return v;
}
const sorted = (a: string[]) => [...a].sort();
const queueUpsert = (lore: Lore, id: string) => recordHotWrite(lore._daemon.outboxWiring.store, {
    workspace: WS, operationKind: 'verbatim.upsert', initiator: 'test',
    payload: { id, text: `queued body of ${id}`, metadata: { ...META } },
});

for (const engine of ['sqlite', 'lance'] as const) {
    console.log(`\nembedded createLore - ${engine} verbatim\n`);
    const home = seedHome(engine);
    const lore = await boot(home);
    try {
        await test(`[${engine}] default delete, no aliases: 2 outbox rows (node.delete + verbatim.tombstone)`, async () => {
            const v = await prep(lore, 'plain', 0);
            await drain(lore);
            const out = await lore.nodeDelete({ id: 'plain', workspace: WS });
            assert.deepEqual(out, { deleted: true, verbatimWarning: undefined });
            assert.deepEqual((await pendingRows(lore)).map((e) => e.operationKind), ['node.delete', 'verbatim.tombstone']);
            assert.ok((await v.getById('lore:plain'))?.text?.startsWith('[TOMBSTONED'), 'tombstoned, not erased');
            assert.ok((await v.getHistory('lore:plain')).length >= 1, 'history kept');
            await drain(lore);
        });

        await test(`[${engine}] default delete, 2 aliases: 4 outbox rows, alias tombstones only for q0/q1`, async () => {
            const v = await prep(lore, 'two', 2);
            await drain(lore);
            assert.equal((await lore.nodeDelete({ id: 'two', workspace: WS })).deleted, true);
            const rows = await pendingRows(lore);
            assert.deepEqual(rows.map((e) => e.operationKind), ['node.delete', 'verbatim.tombstone', 'verbatim.tombstone', 'verbatim.tombstone']);
            assert.deepEqual(sorted(rows.filter((e) => e.operationKind === 'verbatim.tombstone').map((e) => String(e.payload!['id']))),
                sorted(['lore:two', aliasId('two', 0), aliasId('two', 1)]));
            await drain(lore);
            assert.ok((await v.getById(aliasId('two', 0)))?.text?.startsWith('[TOMBSTONED'), 'alias q0 tombstoned by replay');
        });

        await test(`[${engine}] purge, no aliases: 2 rows, one verbatim.purge { id, ids:[lore:<id>] }, outcome purged`, async () => {
            const v = await prep(lore, 'pnone', 0);
            await drain(lore);
            const out = await lore.nodeDelete({ id: 'pnone', workspace: WS, purge: true });
            assert.deepEqual(out, { deleted: true, verbatimWarning: undefined, purged: true });
            const rows = await pendingRows(lore);
            assert.deepEqual(rows.map((e) => e.operationKind), ['node.delete', 'verbatim.purge']);
            assert.deepEqual(rows[1]!.payload, { id: 'lore:pnone', ids: ['lore:pnone'] });
            assert.equal(await rowsOf(v, 'lore:pnone'), 0, 'canonical and history gone');
            await drain(lore);
            assert.equal(await rowsOf(v, 'lore:pnone'), 0, 'still gone after replay');
        });

        await test(`[${engine}] purge with 2 aliases: all rows + history gone, no tombstone()/store() call, neighbours survive`, async () => {
            const v = await prep(lore, 'pa', 2);
            await seedRows(v, 'lore:pa#x');           // a different node whose id extends `pa`
            await seedRows(v, aliasId('pa', 2));      // alias slot that is NOT one of pa's existing aliases
            await drain(lore);
            const calls: string[] = [];
            const raw = v as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
            for (const m of ['tombstone', 'store', 'storeBatch']) {
                const orig = raw[m];
                if (typeof orig === 'function') raw[m] = async function (this: unknown, ...a: unknown[]) { calls.push(m); return orig.apply(this, a); };
            }
            const out = await lore.nodeDelete({ id: 'pa', workspace: WS, purge: true });
            assert.equal(out.purged, true);
            assert.equal(out.verbatimWarning, undefined);
            assert.deepEqual(calls, [], 'the purge path never tombstones or re-stores (no embedding)');
            const rows = await pendingRows(lore);
            assert.deepEqual(rows.map((e) => e.operationKind), ['node.delete', 'verbatim.purge'], 'ONE purge row, no tombstones');
            assert.deepEqual(sorted(rows[1]!.payload!['ids'] as string[]), sorted(['lore:pa', aliasId('pa', 0), aliasId('pa', 1), aliasId('pa', 2)]));
            for (const id of ['lore:pa', aliasId('pa', 0), aliasId('pa', 1)]) assert.equal(await rowsOf(v, id), 0, `${id} gone`);
            assert.ok((await rowsOf(v, 'lore:pa#x')) >= 2, 'lore:pa#x (another node) survives with its history');
            await drain(lore);
            for (const id of ['lore:pa', aliasId('pa', 0), aliasId('pa', 1)]) assert.equal(await rowsOf(v, id), 0, `${id} still gone after replay`);
            assert.ok((await rowsOf(v, 'lore:pa#x')) >= 2, 'neighbour survives replay');
            assert.equal(await read(lore, 'pa'), null);
        });

        await test(`[${engine}] queued alias upsert not yet in the store is still covered (tombstone row and purge id)`, async () => {
            await prep(lore, 'qa', 0);
            await drain(lore);
            await queueUpsert(lore, aliasId('qa', 0));
            assert.equal((await lore.nodeDelete({ id: 'qa', workspace: WS })).deleted, true);
            const tomb = (await pendingRows(lore)).filter((e) => e.operationKind === 'verbatim.tombstone').map((e) => String(e.payload!['id']));
            assert.deepEqual(sorted(tomb), sorted(['lore:qa', aliasId('qa', 0)]));
            await drain(lore);

            await prep(lore, 'qp', 0);
            await drain(lore);
            await queueUpsert(lore, aliasId('qp', 1));
            assert.equal((await lore.nodeDelete({ id: 'qp', workspace: WS, purge: true })).purged, true);
            const purge = (await pendingRows(lore)).find((e) => e.operationKind === 'verbatim.purge');
            assert.deepEqual(sorted(purge!.payload!['ids'] as string[]), sorted(['lore:qp', aliasId('qp', 1)]));
            await drain(lore);
            const v = await vstore(lore);
            assert.equal(await rowsOf(v, aliasId('qp', 1)), 0, 'the queued alias upsert did not resurrect the alias after replay');
        });

        await test(`[${engine}] stale pending verbatim.upsert (node + alias) does not resurrect content after a purge`, async () => {
            const v = await prep(lore, 'stale', 1);
            await drain(lore);
            await queueUpsert(lore, 'lore:stale');
            await queueUpsert(lore, aliasId('stale', 0));
            assert.equal((await lore.nodeDelete({ id: 'stale', workspace: WS, purge: true })).purged, true);
            await drain(lore);
            assert.equal(await rowsOf(v, 'lore:stale'), 0);
            assert.equal(await rowsOf(v, aliasId('stale', 0)), 0);
            assert.equal(await read(lore, 'stale'), null);
        });

        await test(`[${engine}] a failed alias verbatim.upsert is superseded by the replicated purge (payload.ids)`, async () => {
            const v = await prep(lore, 'fail', 1);
            await drain(lore);
            const failing = await queueUpsert(lore, aliasId('fail', 0));
            const store = lore._daemon.outboxWiring.store;
            await store.markEntryStatus!(failing.id, 'failed', { error: 'simulated substrate failure', bumpAttempt: true });
            assert.equal((await lore.nodeDelete({ id: 'fail', workspace: WS, purge: true })).purged, true);
            const r = lore._daemon.outboxWiring.replicator as { tickOnce(): Promise<number> };
            for (let i = 0; i < 6; i++) await r.tickOnce();
            assert.equal(await rowsOf(v, 'lore:fail'), 0);
            assert.equal(await rowsOf(v, aliasId('fail', 0)), 0, 'the failed alias upsert never re-created the alias');
        });

        await test(`[${engine}] purge of an unknown id: deleted:false, nothing recorded`, async () => {
            await drain(lore);
            assert.deepEqual(await lore.nodeDelete({ id: 'nope-nope', workspace: WS, purge: true }), { deleted: false });
            assert.deepEqual((await pendingRows(lore)).filter((e) => e.operationKind === 'verbatim.purge'), []);
        });
    } finally {
        await lore.dispose('test');
    }
}

for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env tsx
/**
 * node-delete-purge-store-unit.ts — 3.27.0: physical purge of a node's verbatim
 * rows (`purgeWithHistory` / `purgeVerbatimRows`) on both vector engines, plus
 * the capability ladder for stores that lack the method (cloud/Dataplane).
 *
 * Pinned:
 *   - LanceDB and SQLite: after 3 saves (history rows) and 2 question aliases
 *     (each with history), a purge leaves zero rows for the node, its history
 *     and its aliases — and makes NO embedding call;
 *   - the match is anchored: node `a` never removes node `a#x`'s rows, and ids
 *     with `_` / `%` never over-match a look-alike neighbour;
 *   - a purge of an id with no rows is a harmless no-op;
 *   - the ladder: purgeWithHistory → physicalDeleteMany (exact ids only) →
 *     physicalDelete → tombstone → 'none'; never throws where tombstone would not.
 *
 * Run: npx tsx test/node-delete-purge-store-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { purgeVerbatimRows, type PurgeCapableStore } from '../packages/lore/src/core/verbatimPurge.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const DIM = 8;
function countingProvider(): EmbeddingProvider & { calls: number } {
    const p = { calls: 0 } as EmbeddingProvider & { calls: number };
    const vec = (text: string): number[] => {
        p.calls++;
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
        const v = new Array<number>(DIM);
        for (let i = 0; i < DIM; i++) { h = Math.imul(h ^ (h >>> 13), 1274126177); v[i] = ((h >>> 0) % 2000 - 1000) / 1000; }
        return v;
    };
    Object.assign(p, {
        dimension: DIM, modelId: 'stub/purge', initialize: async () => undefined,
        embed: async (t: string) => vec(t), embedQuery: async (t: string) => vec(t),
        embedDocument: async (t: string) => vec(t), embedDocumentBatch: async (ts: string[]) => ts.map(vec),
    });
    return p;
}

const META = { type: 'note', label: 'L', tags: '', project: 'default', ecosystem: '*', updatedAt: '2026-10-02T00:00:00.000Z', security_scopes: [] as string[] };
/** Save `id` three times with different text: LanceDB leaves two `#rev` rows, SQLite two non-canonical rows. */
async function saveThrice(store: VerbatimStoreApi, id: string): Promise<void> {
    for (const v of ['one', 'two', 'three']) {
        await store.store({ id, text: `${v} body of ${id}`, metadata: { ...META, updatedAt: `2026-10-02T00:00:0${v.length % 10}.000Z` } });
    }
}
const allIds = (s: VerbatimStoreApi) => s.listIds(undefined, { includeHistory: true });
const rowsOf = async (s: VerbatimStoreApi, id: string): Promise<number> =>
    ((await s.getById(id)) ? 1 : 0) + (await s.getHistory(id)).length;

type Engine = { name: string; make: (dir: string, p: EmbeddingProvider) => VerbatimStoreApi };
const engines: Engine[] = [
    { name: 'lance', make: (d, p) => new VerbatimStore(d, p) },
    { name: 'sqlite', make: (d, p) => new SqliteVerbatimStore(d, p) },
];

for (const eng of engines) {
    console.log(`\n${eng.name} verbatim engine\n`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `purge-store-${eng.name}-`));
    const provider = countingProvider();
    const store = eng.make(dir, provider);
    await store.initialize();
    try {
        await test(`[${eng.name}] purge removes canonical, history, aliases and alias history; no embed call; neighbours survive`, async () => {
            const victim = ['lore:a', 'lore:a#q0', 'lore:a#q1'];
            const neighbours = ['lore:a#x', 'lore:a_b', 'lore:aXb', 'lore:p%q', 'lore:pZZq', 'lore:a#q2'];
            for (const id of [...victim, ...neighbours]) await saveThrice(store, id);
            for (const id of victim) assert.ok((await rowsOf(store, id)) >= 2, `${id} has history before the purge`);
            const embedsBefore = provider.calls;
            const removed = await (store as unknown as PurgeCapableStore).purgeWithHistory!(victim);
            assert.ok(removed >= 3, `purge reported rows removed (got ${removed})`);
            assert.equal(provider.calls, embedsBefore, 'purge makes no embedding call');
            for (const id of victim) assert.equal(await rowsOf(store, id), 0, `${id} and its history are gone`);
            const left = await allIds(store);
            for (const id of victim) assert.ok(!left.some((x) => x === id || x.startsWith(`${id}#rev`)), `no listed row for ${id}`);
            for (const id of neighbours) assert.ok((await rowsOf(store, id)) >= 2, `neighbour ${id} (and its history) survives`);
        });

        await test(`[${eng.name}] wildcard ids: purging lore:a_b / lore:p%q leaves lore:aXb / lore:pZZq alone`, async () => {
            const n = await (store as unknown as PurgeCapableStore).purgeWithHistory!(['lore:a_b', 'lore:p%q']);
            assert.ok(n >= 2);
            assert.equal(await rowsOf(store, 'lore:a_b'), 0);
            assert.equal(await rowsOf(store, 'lore:p%q'), 0);
            assert.ok((await rowsOf(store, 'lore:aXb')) >= 2, 'aXb untouched');
            assert.ok((await rowsOf(store, 'lore:pZZq')) >= 2, 'pZZq untouched');
        });

        await test(`[${eng.name}] purge of ids with no rows is a no-op; purgeVerbatimRows reports the mode`, async () => {
            const before = (await allIds(store)).length;
            await (store as unknown as PurgeCapableStore).purgeWithHistory!(['lore:never']); // returns ids processed, not rows removed
            assert.equal((await allIds(store)).length, before, 'nothing else was removed');
            const mode = await purgeVerbatimRows(store as unknown as PurgeCapableStore, ['lore:aXb'], 'test');
            assert.equal(mode, 'purgeWithHistory');
            assert.equal(await rowsOf(store, 'lore:aXb'), 0);
        });

        await test(`[${eng.name}] default tombstone is unchanged: row kept, marked, history kept`, async () => {
            await saveThrice(store, 'lore:keep');
            await store.tombstone('lore:keep', 'graph node deleted');
            const row = await store.getById('lore:keep');
            assert.ok(row?.text?.startsWith('[TOMBSTONED'), 'tombstone marker row');
            assert.ok((await store.getHistory('lore:keep')).length >= 1, 'history kept');
        });
    } finally {
        await store.close?.();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log('\npurgeVerbatimRows capability ladder\n');

await test('Dataplane-like store (physicalDeleteMany only): exact ids, mode reported', async () => {
    const seen: string[][] = [];
    const s: PurgeCapableStore = { physicalDeleteMany: async (ids) => { seen.push(ids); return ids.length; } };
    assert.equal(await purgeVerbatimRows(s, ['lore:x', 'lore:x#q0'], 'r'), 'physicalDeleteMany');
    assert.deepEqual(seen, [['lore:x', 'lore:x#q0']]);
});
await test('physicalDelete-only store: one call per id', async () => {
    const seen: string[] = [];
    const s: PurgeCapableStore = { physicalDelete: async (id) => { seen.push(id); } };
    assert.equal(await purgeVerbatimRows(s, ['a', 'b'], 'r'), 'physicalDelete');
    assert.deepEqual(seen, ['a', 'b']);
});
await test('tombstone-only store: tombstones each id and says so (never throws)', async () => {
    const seen: Array<[string, string]> = [];
    const s: PurgeCapableStore = { tombstone: async (id, reason) => { seen.push([id, reason]); } };
    assert.equal(await purgeVerbatimRows(s, ['a', 'b'], 'why'), 'tombstone');
    assert.deepEqual(seen, [['a', 'why'], ['b', 'why']]);
});
await test('a store with no usable method: mode none (caller falls back); empty ids: none', async () => {
    assert.equal(await purgeVerbatimRows({}, ['a'], 'r'), 'none');
    assert.equal(await purgeVerbatimRows({ purgeWithHistory: async () => 0 }, [], 'r'), 'none');
});
await test('purgeWithHistory is preferred over physicalDeleteMany', async () => {
    let which = '';
    const s: PurgeCapableStore = {
        purgeWithHistory: async () => { which = 'history'; return 1; },
        physicalDeleteMany: async () => { which = 'many'; return 1; },
    };
    assert.equal(await purgeVerbatimRows(s, ['a'], 'r'), 'purgeWithHistory');
    assert.equal(which, 'history');
});
await test('deleteNodeEverywhere purge on a store with no delete method: legacy delete, warning, NOT purged', async () => {
    const { deleteNodeEverywhere } = await import('../packages/lore/src/core/nodeDeleteService.js');
    const legacy: string[] = [];
    const outcome = await deleteNodeEverywhere({
        id: 'n1',
        workspace: 'ws-none-mode',
        isActive: false,
        graph: { deleteNode: async () => true },
        resolveVerbatim: async () => ({}),
        verbatimDelete: async (vid: string) => { legacy.push(vid); },
        getWal: () => ({ append: () => undefined }) as never,
        initiator: 'test',
        reason: 'r',
        logPrefix: '[test]',
        purge: true,
    });
    assert.equal(outcome.deleted, true);
    assert.equal(outcome.purged, undefined);
    assert.match(outcome.verbatimWarning ?? '', /legacy delete/);
    assert.equal(legacy[0], 'lore:n1');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env tsx
/**
 * outbox/deleteAwareReplay.ts — 3.38.3: the delete-supersede lookup must be served by an index.
 *
 * 3.34.0 added `sqliteHasNewerDeleteForKey` ("does a later delete of this entity exist?"), asked
 * once per queued upsert by the replicator. The only fitting index was
 * `idx_outbox_workspace_seq(workspace, sequenceId)`, so each check walked every later row of the
 * workspace: O(n) per row, O(n^2) to drain a bulk import. In the 3.38.2 filter check a 125k-node
 * SQLite ingest left ~60k rows pending, and the replayer's synchronous queries held the event loop
 * long enough that every recall took 2.5–5 s.
 *
 * 3.38.3 adds one partial index per entity family (`idx_outbox_delete_node|edge|verbatim`, on
 * (workspace, sequenceId) WHERE operationKind IN <that family's delete kinds>). SQLite only uses a
 * partial index when the query's term matches the index's WHERE text, so both are built from the
 * same DELETE_KINDS constant. This file pins:
 *
 *   1. the three indexes exist as soon as the store opens (no lazy DDL on the replay path);
 *   2. EXPLAIN QUERY PLAN for each family's real lookup SQL names that family's index — this is the
 *      test that fails if the query text and index text ever drift apart;
 *   3. an outbox file from before 3.38.3 gets the indexes on its next open;
 *   4. answers are identical with and without the indexes (pending/replicated delete → true,
 *      failed/dead delete → false, other workspace / other family / earlier delete → false);
 *   5. a failed CREATE INDEX only warns and returns false; it never throws and never blocks the open.
 *
 * Correctness of the supersede rule itself lives in test/delete-aware-replay-unit.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    DELETE_KIND_INDEX_SQL, ensureDeleteKindIndexes, hasNewerDeleteKeyBinds, hasNewerDeleteSql,
} from '../packages/lore/src/outbox/deleteAwareReplay.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { keyOfEntry, type EntityFamily } from '../packages/lore/src/outbox/supersession.js';
import type { OutboxEntry, OutboxOperationKind } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const dirs: string[] = [];
function mkDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-delete-kind-index-'));
    dirs.push(dir);
    return dir;
}

type Stmt = { all(...p: unknown[]): Array<Record<string, unknown>>; get(...p: unknown[]): unknown };
type RawDb = { exec(sql: string): void; prepare(sql: string): Stmt };
const rawDb = (s: SqliteOutboxStore): RawDb => (s as unknown as { db: RawDb }).db;
const open = (dir: string) => new SqliteOutboxStore(dir, { retryBaseMs: 20 });

const FAMILIES: EntityFamily[] = ['node', 'edge', 'verbatim'];
const INDEX_NAME: Record<EntityFamily, string> = {
    node: 'idx_outbox_delete_node', edge: 'idx_outbox_delete_edge', verbatim: 'idx_outbox_delete_verbatim',
};
const indexNames = (db: RawDb): string[] =>
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_outbox_delete_%' ORDER BY name")
        .all().map((r) => String(r['name']));

/** One upsert + one delete per family, in workspace `ws`, for entity `tag`. */
const SHAPES: Record<EntityFamily, {
    up: (tag: string) => { operationKind: OutboxOperationKind; operation: string; payload: Record<string, unknown> };
    del: (tag: string) => { operationKind: OutboxOperationKind; operation: string; payload: Record<string, unknown> };
}> = {
    node: {
        up: (t) => ({ operationKind: 'node.upsert', operation: 'graph.upsert', payload: { id: `n-${t}`, type: 'note', label: t } }),
        del: (t) => ({ operationKind: 'node.delete', operation: 'graph.delete', payload: { id: `n-${t}` } }),
    },
    edge: {
        up: (t) => ({ operationKind: 'edge.upsert', operation: 'graph.addEdge', payload: { sourceId: `s-${t}`, targetId: `t-${t}`, relation: 'r', confidence: 'extracted' } }),
        del: (t) => ({ operationKind: 'edge.delete', operation: 'graph.deleteEdge', payload: { sourceId: `s-${t}`, targetId: `t-${t}`, relation: 'r' } }),
    },
    verbatim: {
        up: (t) => ({ operationKind: 'verbatim.upsert', operation: 'verbatim.upsert', payload: { id: `lore:v-${t}`, text: t } }),
        del: (t) => ({ operationKind: 'verbatim.tombstone', operation: 'verbatim.tombstone', payload: { id: `lore:v-${t}` } }),
    },
};

/** Fill a store with a mixed workload; return the questions to ask and their expected answers. */
async function seed(store: SqliteOutboxStore): Promise<Array<{ label: string; ws: string; family: EntityFamily; key: string; seq: number; want: boolean }>> {
    const qs: Array<{ label: string; ws: string; family: EntityFamily; key: string; seq: number; want: boolean }> = [];
    // Background noise: plenty of upserts so a scan and an index lookup differ in shape.
    for (let i = 0; i < 300; i++) {
        const fam = FAMILIES[i % 3]!;
        await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].up(`noise${i}`) });
    }
    for (const fam of FAMILIES) {
        const keyOf = (e: OutboxEntry): string => keyOfEntry(e)!.key;
        // upsert then pending delete -> superseded
        const u1 = await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].up('pend') });
        await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].del('pend') });
        qs.push({ label: `${fam}: later pending delete`, ws: 'w1', family: fam, key: keyOf(u1), seq: u1.sequenceId!, want: true });
        // upsert then replicated delete -> superseded
        const u2 = await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].up('repl') });
        const d2 = await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].del('repl') });
        await store.markEntryStatus!(d2.id, 'replicated');
        qs.push({ label: `${fam}: later replicated delete`, ws: 'w1', family: fam, key: keyOf(u2), seq: u2.sequenceId!, want: true });
        // upsert then failed / dead delete -> NOT superseded
        const u3 = await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].up('fail') });
        const d3 = await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].del('fail') });
        await store.markEntryStatus!(d3.id, 'failed', { error: 'injected' });
        qs.push({ label: `${fam}: later failed delete`, ws: 'w1', family: fam, key: keyOf(u3), seq: u3.sequenceId!, want: false });
        const u4 = await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].up('dead') });
        const d4 = await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].del('dead') });
        await store.markEntryStatus!(d4.id, 'dead', { error: 'injected' });
        qs.push({ label: `${fam}: later dead delete`, ws: 'w1', family: fam, key: keyOf(u4), seq: u4.sequenceId!, want: false });
        // delete BEFORE the upsert (a re-create) -> NOT superseded
        await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].del('recreate') });
        const u5 = await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].up('recreate') });
        qs.push({ label: `${fam}: earlier delete only`, ws: 'w1', family: fam, key: keyOf(u5), seq: u5.sequenceId!, want: false });
        // delete in ANOTHER workspace -> NOT superseded
        const u6 = await recordHotWrite(store, { workspace: 'w1', ...SHAPES[fam].up('foreign') });
        await recordHotWrite(store, { workspace: 'w2', ...SHAPES[fam].del('foreign') });
        qs.push({ label: `${fam}: delete in another workspace`, ws: 'w1', family: fam, key: keyOf(u6), seq: u6.sequenceId!, want: false });
    }
    // A node.delete with a verbatim-shaped id must not answer for the verbatim family.
    const v = await recordHotWrite(store, { workspace: 'w1', ...SHAPES.verbatim.up('cross') });
    await recordHotWrite(store, { workspace: 'w1', operationKind: 'node.delete', operation: 'graph.delete', payload: { id: 'lore:v-cross' } });
    qs.push({ label: 'verbatim: a node.delete of the same id is another family', ws: 'w1', family: 'verbatim', key: 'lore:v-cross', seq: v.sequenceId!, want: false });
    return qs;
}

console.log('\noutbox — delete-kind indexes (3.38.3)\n');

await test('the three delete-kind indexes exist as soon as the store opens', () => {
    const store = open(mkDir());
    assert.deepEqual(indexNames(rawDb(store)), Object.values(INDEX_NAME).sort());
    store.close();
});

await test('each family\'s real lookup SQL is planned on that family\'s index (no workspace scan)', async () => {
    const store = open(mkDir());
    await seed(store);
    rawDb(store).exec('ANALYZE');
    for (const fam of FAMILIES) {
        const binds = ['w1', 0, ...Array<string>(hasNewerDeleteKeyBinds(fam)).fill('k')];
        const plan = rawDb(store).prepare(`EXPLAIN QUERY PLAN ${hasNewerDeleteSql(fam)}`).all(...binds)
            .map((r) => String(r['detail'])).join(' | ');
        assert.match(plan, new RegExp(INDEX_NAME[fam]), `${fam} lookup must use ${INDEX_NAME[fam]}: ${plan}`);
    }
    store.close();
});

await test('the index text and the lookup text share the same delete-kind term', () => {
    for (const fam of FAMILIES) {
        const term = /operationKind IN \([^)]*\)/.exec(DELETE_KIND_INDEX_SQL[fam])?.[0];
        assert.ok(term, `${fam}: index has an operationKind IN term`);
        assert.ok(hasNewerDeleteSql(fam).includes(term), `${fam}: lookup carries the identical term "${term}"`);
    }
});

await test('an outbox file from before 3.38.3 gets the indexes on its next open, rows intact', async () => {
    const dir = mkDir();
    const first = open(dir);
    const qs = await seed(first);
    for (const n of Object.values(INDEX_NAME)) rawDb(first).exec(`DROP INDEX ${n}`); // what a 3.38.2 file looks like
    assert.deepEqual(indexNames(rawDb(first)), []);
    first.close();
    const second = open(dir);
    assert.deepEqual(indexNames(rawDb(second)), Object.values(INDEX_NAME).sort());
    for (const q of qs) assert.equal(await second.hasNewerDeleteForKey(q.ws, q.family, q.key, q.seq), q.want, q.label);
    second.close();
});

await test('answers are identical with and without the indexes', async () => {
    const store = open(mkDir());
    const qs = await seed(store);
    const ask = async () => Promise.all(qs.map((q) => store.hasNewerDeleteForKey(q.ws, q.family, q.key, q.seq)));
    const withIdx = await ask();
    for (const n of Object.values(INDEX_NAME)) rawDb(store).exec(`DROP INDEX ${n}`);
    const without = await ask();
    assert.deepEqual(withIdx, without, 'the index changes speed only, never the answer');
    qs.forEach((q, i) => assert.equal(withIdx[i], q.want, q.label));
    store.close();
});

await test('a failed CREATE INDEX warns and returns false; it never throws', () => {
    const tried: string[] = [];
    const broken = { exec(sql: string): never { tried.push(sql); throw new Error('database is locked'); } };
    assert.equal(ensureDeleteKindIndexes(broken), false);
    assert.equal(tried.length, 3, 'every family is attempted even after the first fails');
    const fine = { exec(sql: string): void { tried.push(sql); } };
    assert.equal(ensureDeleteKindIndexes(fine), true);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

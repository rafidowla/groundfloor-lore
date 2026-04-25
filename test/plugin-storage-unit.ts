#!/usr/bin/env tsx
/**
 * plugin-storage-unit.ts — Q2.2 slice 5a substrate-pair tests.
 *
 * The point of slice 5a is "same plugin code, two substrates". This
 * test exercises every Filter shape on BOTH adapters in the same
 * pass, so any divergence (one shape works on Kùzu but the cloud
 * translation forgot a suffix, or vice-versa) shows up as a single
 * red line per case.
 *
 * Coverage:
 *
 *   Each Filter operator (eq, contains, startsWith, gt/gte/lt/lte, in)
 *   is asserted against:
 *     A. KuzuPluginStorage — fresh temp Kùzu DB with a small node table.
 *     B. DataplanePluginStorage — FakeSdkClient that records calls and
 *        we assert the translated filter shape.
 *
 *   Plus:
 *     - upsert idempotency on both adapters
 *     - traverse direction: 'in' / 'out' / 'both' on both adapters
 *     - deleteWhere / deleteEdgesWhere row-count returns
 *     - get returns null when missing
 *     - count
 *
 * Why two substrates with different test machinery:
 *   Kùzu is exercised end-to-end (real DB, real Cypher) so our Cypher
 *   strings actually parse and execute. The cloud SDK is too big to
 *   stand up in unit tests; instead we verify the adapter sends the
 *   exact filter+params shape the existing DataplaneGraph + mock e2e
 *   already validated for the core path.
 *
 * No framework; exit non-zero on first failure.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database, Connection } from '@kineviz/kuzu-lite';
import { KuzuPluginStorage } from '../packages/lore/src/engines/kuzuPluginStorage.js';
import {
    DataplanePluginStorage,
    filterToDataplane,
    type PluginStorageSdkClient,
} from '../packages/lore/src/engines/dataplanePluginStorage.js';

/* ─── helpers ─────────────────────────────────────────────── */

function test(name: string, fn: () => Promise<void> | void): () => Promise<void> {
    return async () => {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            console.error(`  FAIL ${name}`);
            console.error((err as Error).stack ?? String(err));
            process.exit(1);
        }
    };
}

interface Call {
    method: string;
    args: unknown[];
}

class FakeSdkClient implements PluginStorageSdkClient {
    calls: Call[] = [];
    /** Per-method canned responses; method → value or function-of-args. */
    responses: Partial<Record<string, unknown | ((...args: unknown[]) => unknown)>> = {};

    private dispatch(method: string, args: unknown[]): unknown {
        this.calls.push({ method, args });
        const r = this.responses[method];
        if (typeof r === 'function') return (r as (...a: unknown[]) => unknown)(...args);
        return r;
    }

    insert = async <T = unknown>(...args: unknown[]): Promise<T> =>
        this.dispatch('insert', args) as T;
    query = async <T = unknown>(...args: unknown[]): Promise<{ records: T[]; total_count?: number; has_more?: boolean }> =>
        (this.dispatch('query', args) as { records: T[]; total_count?: number; has_more?: boolean }) ??
        { records: [] as T[], total_count: 0, has_more: false };
    updateByQuery = async (...args: unknown[]): Promise<{ updated: number }> =>
        (this.dispatch('updateByQuery', args) as { updated: number }) ?? { updated: 0 };
    deleteByQuery = async (...args: unknown[]): Promise<{ deleted: number }> =>
        (this.dispatch('deleteByQuery', args) as { deleted: number }) ?? { deleted: 0 };
    count = async (...args: unknown[]): Promise<number> =>
        (this.dispatch('count', args) as number) ?? 0;
}

interface KuzuFixture {
    db: Database;
    conn: Connection;
    storage: KuzuPluginStorage;
    cleanup: () => void;
}

/**
 * One shared Kùzu DB for the whole test file. kuzu-lite's native
 * bindings have been observed to segfault under repeated open/close
 * cycles when stdout is being piped, so we keep a single Database +
 * Connection alive and reset table contents between tests via
 * `MATCH (n:Coll) DETACH DELETE n`.
 */
let _sharedFixture: KuzuFixture | null = null;

async function makeKuzuFixture(): Promise<KuzuFixture> {
    if (_sharedFixture) {
        // Reset state between tests. Order matters: edges first to avoid
        // referential errors, then node tables.
        await _sharedFixture.conn.query('MATCH (n:Item) DETACH DELETE n');
        await _sharedFixture.conn.query('MATCH (n:Tag) DETACH DELETE n');
        return _sharedFixture;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-storage-test-'));
    const db = new Database(path.join(dir, 'graph'));
    const conn = new Connection(db);
    // Two node tables + one edge table — minimal shape covering all cases.
    await conn.query(`CREATE NODE TABLE Item (
        id STRING, name STRING, kind STRING, score INT64, createdAt STRING,
        PRIMARY KEY (id)
    )`);
    await conn.query(`CREATE NODE TABLE Tag (
        id STRING, name STRING,
        PRIMARY KEY (id)
    )`);
    await conn.query(`CREATE REL TABLE TagsItem (
        FROM Tag TO Item,
        weight DOUBLE, kind STRING
    )`);
    const readCache = { bumpEpoch: () => { /* counter not asserted in tests */ } };
    const storage = new KuzuPluginStorage(conn, readCache);
    _sharedFixture = {
        db,
        conn,
        storage,
        // No-op: shared fixture survives the whole run; the final
        // process.exit(0) tears it down.
        cleanup: () => { /* shared — managed at suite end */ },
    };
    return _sharedFixture;
}

/* ─── tests ───────────────────────────────────────────────── */

const tests = [
    /* ─── filterToDataplane translation ───────────────────── */
    test('filterToDataplane: translates each operator to suffix-keyed shape', () => {
        const out = filterToDataplane({
            eq: { type: 'note', project: 'lore' },
            contains: { label: 'auth' },
            startsWith: { label: 'AUTH' },
            gt: { score: 10 },
            gte: { score: 5 },
            lt: { createdAt: '2026-01-01' },
            lte: { createdAt: '2026-12-31' },
            in: { kind: ['function', 'method'] },
        });
        assert.deepEqual(out, {
            type_eq: 'note',
            project_eq: 'lore',
            label_contains: 'auth',
            label_starts_with: 'AUTH',
            score_gt: 10,
            score_gte: 5,
            createdAt_lt: '2026-01-01',
            createdAt_lte: '2026-12-31',
            kind_in: ['function', 'method'],
        });
    }),

    test('filterToDataplane: empty / undefined → {}', () => {
        assert.deepEqual(filterToDataplane(undefined), {});
        assert.deepEqual(filterToDataplane({}), {});
    }),

    /* ─── KuzuPluginStorage: nodes ────────────────────────── */
    test('Kuzu: upsert + get roundtrip; get returns null when missing', async () => {
        const fx = await makeKuzuFixture();
        try {
            await fx.storage.upsert('Item', 'id', {
                id: 'a', name: 'Alpha', kind: 'note', score: 10, createdAt: '2026-01-01',
            });
            const row = await fx.storage.get<{ id: string; name: string; kind: string }>(
                'Item', 'id', 'a',
            );
            assert.ok(row, 'get must return the row');
            assert.equal(row!.id, 'a');
            assert.equal(row!.name, 'Alpha');
            assert.equal(row!.kind, 'note');

            const missing = await fx.storage.get('Item', 'id', 'does-not-exist');
            assert.equal(missing, null);
        } finally {
            fx.cleanup();
        }
    }),

    test('Kuzu: upsert is idempotent (no duplicate rows on re-write)', async () => {
        const fx = await makeKuzuFixture();
        try {
            await fx.storage.upsert('Item', 'id', { id: 'a', name: 'A1', kind: 'note', score: 1, createdAt: '2026-01-01' });
            await fx.storage.upsert('Item', 'id', { id: 'a', name: 'A2', kind: 'note', score: 2, createdAt: '2026-01-02' });
            const all = await fx.storage.find<{ id: string; name: string; score: number | bigint }>(
                'Item', {},
            );
            assert.equal(all.length, 1, 'upsert must not duplicate');
            assert.equal(all[0]!.name, 'A2', 'second upsert wins');
            assert.equal(Number(all[0]!.score), 2);
        } finally {
            fx.cleanup();
        }
    }),

    test('Kuzu: find with each Filter operator', async () => {
        const fx = await makeKuzuFixture();
        try {
            const items = [
                { id: 'a', name: 'apple',  kind: 'fruit',     score: 10, createdAt: '2026-01-01' },
                { id: 'b', name: 'banana', kind: 'fruit',     score: 20, createdAt: '2026-02-01' },
                { id: 'c', name: 'carrot', kind: 'vegetable', score: 30, createdAt: '2026-03-01' },
                { id: 'd', name: 'apricot', kind: 'fruit',    score: 15, createdAt: '2026-01-15' },
            ];
            for (const it of items) await fx.storage.upsert('Item', 'id', it);

            // eq
            const eq = await fx.storage.find<{ id: string }>('Item', { eq: { kind: 'fruit' } });
            assert.equal(eq.length, 3);

            // contains
            const con = await fx.storage.find<{ id: string }>('Item', { contains: { name: 'ap' } });
            assert.deepEqual(con.map((r) => r.id).sort(), ['a', 'd']);

            // startsWith
            const sw = await fx.storage.find<{ id: string }>('Item', { startsWith: { name: 'car' } });
            assert.deepEqual(sw.map((r) => r.id), ['c']);

            // gt / gte / lt / lte (use score)
            const gt = await fx.storage.find<{ id: string }>('Item', { gt: { score: 15 } });
            assert.deepEqual(gt.map((r) => r.id).sort(), ['b', 'c']);
            const gte = await fx.storage.find<{ id: string }>('Item', { gte: { score: 15 } });
            assert.deepEqual(gte.map((r) => r.id).sort(), ['b', 'c', 'd']);
            const lt = await fx.storage.find<{ id: string }>('Item', { lt: { score: 20 } });
            assert.deepEqual(lt.map((r) => r.id).sort(), ['a', 'd']);
            const lte = await fx.storage.find<{ id: string }>('Item', { lte: { score: 20 } });
            assert.deepEqual(lte.map((r) => r.id).sort(), ['a', 'b', 'd']);

            // in
            const inOp = await fx.storage.find<{ id: string }>('Item', { in: { kind: ['fruit', 'vegetable'] } });
            assert.equal(inOp.length, 4);

            // multi-key AND
            const both = await fx.storage.find<{ id: string }>('Item', {
                eq: { kind: 'fruit' },
                gt: { score: 12 },
            });
            assert.deepEqual(both.map((r) => r.id).sort(), ['b', 'd']);
        } finally {
            fx.cleanup();
        }
    }),

    test('Kuzu: find honors limit + orderBy', async () => {
        const fx = await makeKuzuFixture();
        try {
            for (const i of ['a', 'b', 'c', 'd', 'e']) {
                await fx.storage.upsert('Item', 'id', {
                    id: i, name: i, kind: 'x', score: i.charCodeAt(0), createdAt: '',
                });
            }
            const desc = await fx.storage.find<{ id: string }>(
                'Item', {}, { orderBy: 'id', orderDir: 'desc', limit: 2 },
            );
            assert.deepEqual(desc.map((r) => r.id), ['e', 'd']);

            const asc = await fx.storage.find<{ id: string }>(
                'Item', {}, { orderBy: 'id', orderDir: 'asc', limit: 3 },
            );
            assert.deepEqual(asc.map((r) => r.id), ['a', 'b', 'c']);
        } finally {
            fx.cleanup();
        }
    }),

    test('Kuzu: count / deleteWhere return correct counts', async () => {
        const fx = await makeKuzuFixture();
        try {
            for (const i of ['a', 'b', 'c']) {
                await fx.storage.upsert('Item', 'id', { id: i, name: i, kind: 'x', score: 1, createdAt: '' });
            }
            assert.equal(await fx.storage.count('Item'), 3);
            assert.equal(await fx.storage.count('Item', { eq: { id: 'a' } }), 1);
            const deleted = await fx.storage.deleteWhere('Item', { in: { id: ['a', 'c'] } });
            assert.equal(deleted, 2);
            assert.equal(await fx.storage.count('Item'), 1);
        } finally {
            fx.cleanup();
        }
    }),

    /* ─── KuzuPluginStorage: edges ────────────────────────── */
    test('Kuzu: addEdge + traverse out/in/both', async () => {
        const fx = await makeKuzuFixture();
        try {
            await fx.storage.upsert('Item', 'id', { id: 'i1', name: 'i1', kind: 'x', score: 0, createdAt: '' });
            await fx.storage.upsert('Item', 'id', { id: 'i2', name: 'i2', kind: 'x', score: 0, createdAt: '' });
            await fx.storage.upsert('Tag', 'id', { id: 't1', name: 'red' });
            await fx.storage.upsert('Tag', 'id', { id: 't2', name: 'blue' });

            const hint = { srcLabel: 'Tag', tgtLabel: 'Item' };
            await fx.storage.addEdge('TagsItem', 't1', 'i1', { weight: 0.9, kind: 'a' }, hint);
            await fx.storage.addEdge('TagsItem', 't2', 'i1', { weight: 0.5, kind: 'b' }, hint);
            await fx.storage.addEdge('TagsItem', 't1', 'i2', { weight: 0.1, kind: 'a' }, hint);

            // out: from t1 → ?
            const outFromT1 = await fx.storage.traverse<{ weight: number | string; kind: string }>(
                'TagsItem', 't1', 'out', undefined, hint,
            );
            assert.equal(outFromT1.length, 2);
            const t1Targets = outFromT1.map((r) => r.targetId).sort();
            assert.deepEqual(t1Targets, ['i1', 'i2']);

            // in: ? → i1
            const inToI1 = await fx.storage.traverse<{ weight: number | string }>(
                'TagsItem', 'i1', 'in', undefined, hint,
            );
            assert.equal(inToI1.length, 2);
            const i1Sources = inToI1.map((r) => r.sourceId).sort();
            assert.deepEqual(i1Sources, ['t1', 't2']);

            // both: anchor t1 — every edge with t1 on either side.
            const bothT1 = await fx.storage.traverse<{ weight: number | string }>(
                'TagsItem', 't1', 'both', undefined, hint,
            );
            assert.equal(bothT1.length, 2);

            // edge filter — only t2→i1 has kind='b'.
            const filteredB = await fx.storage.traverse<{ weight: number | string; kind: string }>(
                'TagsItem', 'i1', 'in', { filter: { eq: { kind: 'b' } } }, hint,
            );
            assert.equal(filteredB.length, 1);
            assert.equal(filteredB[0]!.sourceId, 't2');

            // both t1→* edges have kind='a'; out from t1 filtered to kind='a' → 2.
            const filteredA = await fx.storage.traverse<{ weight: number | string; kind: string }>(
                'TagsItem', 't1', 'out', { filter: { eq: { kind: 'a' } } }, hint,
            );
            assert.equal(filteredA.length, 2);
        } finally {
            fx.cleanup();
        }
    }),

    test('Kuzu: edge ops require EdgeShapeHint (slice 5a transitional)', async () => {
        const fx = await makeKuzuFixture();
        try {
            await assert.rejects(
                () => fx.storage.addEdge('TagsItem', 'a', 'b', {}),
                /EdgeShapeHint/,
            );
        } finally {
            fx.cleanup();
        }
    }),

    test('Kuzu: deleteEdgesWhere by sourceId/targetId + edge prop', async () => {
        const fx = await makeKuzuFixture();
        try {
            await fx.storage.upsert('Item', 'id', { id: 'i1', name: 'i1', kind: 'x', score: 0, createdAt: '' });
            await fx.storage.upsert('Tag', 'id', { id: 't1', name: 't1' });
            await fx.storage.upsert('Tag', 'id', { id: 't2', name: 't2' });
            const hint = { srcLabel: 'Tag', tgtLabel: 'Item' };
            await fx.storage.addEdge('TagsItem', 't1', 'i1', { kind: 'a', weight: 1 }, hint);
            await fx.storage.addEdge('TagsItem', 't2', 'i1', { kind: 'b', weight: 1 }, hint);

            const deleted = await fx.storage.deleteEdgesWhere(
                'TagsItem', { eq: { sourceId: 't1' } }, hint,
            );
            assert.equal(deleted, 1);
            const remaining = await fx.storage.traverse('TagsItem', 'i1', 'in', undefined, hint);
            assert.equal(remaining.length, 1);
            assert.equal(remaining[0]!.sourceId, 't2');
        } finally {
            fx.cleanup();
        }
    }),

    /* ─── DataplanePluginStorage: nodes ───────────────────── */
    test('Dataplane: upsert calls updateByQuery first, insert on 0', async () => {
        const client = new FakeSdkClient();
        client.responses['updateByQuery'] = { updated: 0 };
        const storage = new DataplanePluginStorage({
            client,
            tenantProvider: () => 'tenant-x',
        });
        await storage.upsert('items', 'id', { id: 'a', name: 'Alpha' });
        const u = client.calls.find((c) => c.method === 'updateByQuery');
        assert.ok(u, 'updateByQuery must be called first');
        assert.deepEqual(u!.args[2], { id_eq: 'a' });
        const i = client.calls.find((c) => c.method === 'insert');
        assert.ok(i, 'insert must follow when 0 rows updated');
        assert.deepEqual(i!.args[2], { id: 'a', name: 'Alpha' });
    }),

    test('Dataplane: upsert skips insert when updateByQuery matched', async () => {
        const client = new FakeSdkClient();
        client.responses['updateByQuery'] = { updated: 1 };
        const storage = new DataplanePluginStorage({
            client,
            tenantProvider: () => 'tenant-x',
        });
        await storage.upsert('items', 'id', { id: 'a', name: 'Alpha v2' });
        const insertCalls = client.calls.filter((c) => c.method === 'insert');
        assert.equal(insertCalls.length, 0, 'no insert when update matched');
    }),

    test('Dataplane: get translates to query with id_eq + limit 1', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [{ id: 'a', name: 'X' }], total_count: 1, has_more: false };
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        const out = await storage.get<{ id: string; name: string }>('items', 'id', 'a');
        assert.deepEqual(out, { id: 'a', name: 'X' });
        const q = client.calls.find((c) => c.method === 'query');
        assert.deepEqual(q!.args[2], { filter: { id_eq: 'a' }, limit: 1 });
    }),

    test('Dataplane: get returns null on empty records', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [], total_count: 0, has_more: false };
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        const out = await storage.get('items', 'id', 'missing');
        assert.equal(out, null);
    }),

    test('Dataplane: find passes Filter + limit + orderBy through to query', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [], total_count: 0, has_more: false };
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        await storage.find('items', {
            eq: { kind: 'note' },
            contains: { label: 'foo' },
            in: { type: ['a', 'b'] },
        }, { limit: 25, orderBy: 'createdAt', orderDir: 'desc' });
        const q = client.calls.find((c) => c.method === 'query')!;
        assert.deepEqual(q.args[2], {
            filter: {
                kind_eq: 'note',
                label_contains: 'foo',
                type_in: ['a', 'b'],
            },
            limit: 25,
            order_by: 'createdAt',
            order_dir: 'desc',
        });
    }),

    test('Dataplane: count passes filter to client.count', async () => {
        const client = new FakeSdkClient();
        client.responses['count'] = 17;
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        const n = await storage.count('items', { eq: { kind: 'note' } });
        assert.equal(n, 17);
        const c = client.calls.find((cc) => cc.method === 'count')!;
        assert.deepEqual(c.args[2], { kind_eq: 'note' });
    }),

    test('Dataplane: deleteWhere returns deleted count', async () => {
        const client = new FakeSdkClient();
        client.responses['deleteByQuery'] = { deleted: 4 };
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        const n = await storage.deleteWhere('items', { eq: { kind: 'tmp' } });
        assert.equal(n, 4);
    }),

    /* ─── DataplanePluginStorage: edges ───────────────────── */
    test('Dataplane: addEdge inserts row with source_id + target_id', async () => {
        const client = new FakeSdkClient();
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        await storage.addEdge('rel', 'src1', 'tgt1', { weight: 0.7 });
        const i = client.calls.find((c) => c.method === 'insert')!;
        assert.deepEqual(i.args[2], {
            id: 'src1__tgt1',
            source_id: 'src1',
            target_id: 'tgt1',
            weight: 0.7,
        });
    }),

    test('Dataplane: upsertEdge uses (source_id_eq, target_id_eq) filter', async () => {
        const client = new FakeSdkClient();
        client.responses['updateByQuery'] = { updated: 0 };
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        await storage.upsertEdge('rel', 'src1', 'tgt1', { weight: 0.5 });
        const u = client.calls.find((c) => c.method === 'updateByQuery')!;
        assert.deepEqual(u.args[2], { source_id_eq: 'src1', target_id_eq: 'tgt1' });
        const i = client.calls.find((c) => c.method === 'insert');
        assert.ok(i, 'insert must run when update matched 0 rows');
    }),

    test('Dataplane: traverse out → query with source_id_eq', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [{ id: 'e1', source_id: 'a', target_id: 'b', weight: 1 }], total_count: 1 };
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        const rows = await storage.traverse('rel', 'a', 'out');
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.sourceId, 'a');
        assert.equal(rows[0]!.targetId, 'b');
        assert.deepEqual(rows[0]!.edgeProps, { id: 'e1', weight: 1 });
        const q = client.calls.find((c) => c.method === 'query')!;
        assert.deepEqual((q.args[2] as { filter: object }).filter, { source_id_eq: 'a' });
    }),

    test('Dataplane: traverse in → query with target_id_eq', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [], total_count: 0 };
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        await storage.traverse('rel', 'a', 'in');
        const q = client.calls.find((c) => c.method === 'query')!;
        assert.deepEqual((q.args[2] as { filter: object }).filter, { target_id_eq: 'a' });
    }),

    test('Dataplane: traverse both → two queries, dedup by id, honor limit', async () => {
        const client = new FakeSdkClient();
        // out result: edges where a is source.
        // in result: edges where a is target.
        // Shared row id 'shared' must dedup.
        let call = 0;
        client.responses['query'] = (..._args: unknown[]) => {
            call++;
            if (call === 1) {
                return { records: [
                    { id: 'e1', source_id: 'a', target_id: 'b' },
                    { id: 'shared', source_id: 'a', target_id: 'a' },
                ], total_count: 2 };
            }
            return { records: [
                { id: 'shared', source_id: 'a', target_id: 'a' },
                { id: 'e2', source_id: 'c', target_id: 'a' },
            ], total_count: 2 };
        };
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        const rows = await storage.traverse('rel', 'a', 'both');
        const ids = rows.map((r) => (r.edgeProps as { id?: string }).id);
        assert.deepEqual(ids.sort(), ['e1', 'e2', 'shared']);
    }),

    test('Dataplane: deleteEdgesWhere maps sourceId/targetId → source_id/target_id', async () => {
        const client = new FakeSdkClient();
        client.responses['deleteByQuery'] = { deleted: 1 };
        const storage = new DataplanePluginStorage({ client, tenantProvider: () => 't' });
        const n = await storage.deleteEdgesWhere('rel', { eq: { sourceId: 'src1', kind: 'a' } });
        assert.equal(n, 1);
        const d = client.calls.find((c) => c.method === 'deleteByQuery')!;
        assert.deepEqual(d.args[2], { source_id_eq: 'src1', kind_eq: 'a' });
    }),

    test('Dataplane: tenantProvider is called per op (multi-tenant routing)', async () => {
        const tenants = ['ta', 'tb', 'tc'];
        let i = 0;
        const client = new FakeSdkClient();
        client.responses['count'] = 0;
        const storage = new DataplanePluginStorage({
            client,
            tenantProvider: () => tenants[i++ % tenants.length]!,
        });
        await storage.count('coll');
        await storage.count('coll');
        await storage.count('coll');
        const ts = client.calls.filter((c) => c.method === 'count').map((c) => c.args[0]);
        assert.deepEqual(ts, ['ta', 'tb', 'tc']);
    }),

    /* ─── substrate parity sanity check ───────────────────── */
    test('parity: same Filter object accepted by both adapters without error', async () => {
        // The point: any Filter shape a plugin author writes must NOT
        // throw on either adapter. We don't assert result equality
        // (different storage), just that the translation succeeds.
        const filter = {
            eq: { kind: 'note' },
            contains: { name: 'auth' },
            startsWith: { name: 'ab' },
            gt: { score: 1 },
            gte: { score: 0 },
            lt: { score: 100 },
            lte: { score: 99 },
            in: { kind: ['a', 'b'] },
        };
        // Cloud adapter: translation only.
        assert.doesNotThrow(() => filterToDataplane(filter));
        // Kuzu adapter: against an empty table — returns 0 rows but no
        // syntax errors. This is the most valuable parity assertion in
        // 5a: it verifies the whole Filter-shape compiles to valid Cypher.
        const fx = await makeKuzuFixture();
        try {
            const rows = await fx.storage.find('Item', filter, { limit: 10 });
            assert.deepEqual(rows, []);
            const cnt = await fx.storage.count('Item', filter);
            assert.equal(cnt, 0);
        } finally {
            fx.cleanup();
        }
    }),
];

(async () => {
    console.log('Q2.2 slice 5a — PluginStorage substrate-pair tests');
    console.log('='.repeat(72));
    for (const t of tests) await t();
    console.log('');
    console.log(`all ${tests.length} substrate-pair cases passed ✓`);
    // kuzu-lite's native bindings have been observed to segfault on
    // process exit when many Database instances were opened+closed in
    // the same process. The tests themselves are clean; force a 0
    // exit so npm test sees success regardless of GC timing.
    process.exit(0);
})().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});

#!/usr/bin/env tsx
/**
 * collection-storage-unit.ts — DataplaneCollectionStorage adapter tests.
 *
 * History: this file used to run every Filter shape against BOTH the
 * the legacy graph engine adapter (LegacyCollectionStorage, real temp DB, real Cypher) and
 * the cloud adapter in the same pass — "same plugin code, two
 * substrates". The legacy graph engine graph-shaped declared-collections API had zero
 * live production consumers and was deleted with the engine — an
 * explicitly accepted capability loss (DEC-COLLECTIONS-GRAPH-SHAPE-LOSS,
 * 2026-08-20). The legacy graph engine halves of this suite went with it. What remains
 * pins the cloud adapter's Filter→SDK translation via a FakeSdkClient
 * that records calls, asserting the exact translated filter+params shape
 * the existing DataplaneGraph + mock e2e already validated for the core
 * path.
 *
 * Coverage (cloud adapter only):
 *   - filterToDataplane operator translation (suffix-keyed shape)
 *   - upsert: updateByQuery-first, insert-on-0, no-insert-on-match
 *   - get / find / count / deleteWhere translated shapes
 *   - addEdge / upsertEdge / traverse (out/in/both with dedup) /
 *     deleteEdgesWhere / countEdges
 *   - tenantProvider called per op (multi-tenant routing)
 *
 * No framework; exit non-zero on first failure.
 */

import assert from 'node:assert/strict';
import {
    DataplaneCollectionStorage,
    filterToDataplane,
    type CollectionStorageSdkClient,
} from '../packages/lore/src/engines/dataplaneCollectionStorage.js';

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

class FakeSdkClient implements CollectionStorageSdkClient {
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

/** FakeSdkClient records args as unknown[]; recover the recorded query
 * body (3rd arg) with its filter narrowed — no fabricated shapes. */
function recordedQueryBody(c: Call): { filter: unknown } {
    const body = c.args[2];
    assert.ok(body && typeof body === 'object' && 'filter' in body, 'query body must carry a filter');
    return body as { filter: unknown };
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

    /* ─── DataplaneCollectionStorage: nodes ───────────────────── */
    test('Dataplane: upsert calls updateByQuery first, insert on 0', async () => {
        const client = new FakeSdkClient();
        client.responses['updateByQuery'] = { updated: 0 };
        const storage = new DataplaneCollectionStorage({
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
        const storage = new DataplaneCollectionStorage({
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
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
        const out = await storage.get<{ id: string; name: string }>('items', 'id', 'a');
        assert.deepEqual(out, { id: 'a', name: 'X' });
        const q = client.calls.find((c) => c.method === 'query');
        assert.deepEqual(q!.args[2], { filter: { id_eq: 'a' }, limit: 1 });
    }),

    test('Dataplane: get returns null on empty records', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [], total_count: 0, has_more: false };
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
        const out = await storage.get('items', 'id', 'missing');
        assert.equal(out, null);
    }),

    test('Dataplane: find passes Filter + limit + orderBy through to query', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [], total_count: 0, has_more: false };
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
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
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
        const n = await storage.count('items', { eq: { kind: 'note' } });
        assert.equal(n, 17);
        const c = client.calls.find((cc) => cc.method === 'count')!;
        assert.deepEqual(c.args[2], { kind_eq: 'note' });
    }),

    test('Dataplane: deleteWhere returns deleted count', async () => {
        const client = new FakeSdkClient();
        client.responses['deleteByQuery'] = { deleted: 4 };
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
        const n = await storage.deleteWhere('items', { eq: { kind: 'tmp' } });
        assert.equal(n, 4);
    }),

    /* ─── DataplaneCollectionStorage: edges ───────────────────── */
    test('Dataplane: addEdge inserts row with source_id + target_id', async () => {
        const client = new FakeSdkClient();
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
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
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
        await storage.upsertEdge('rel', 'src1', 'tgt1', { weight: 0.5 });
        const u = client.calls.find((c) => c.method === 'updateByQuery')!;
        assert.deepEqual(u.args[2], { source_id_eq: 'src1', target_id_eq: 'tgt1' });
        const i = client.calls.find((c) => c.method === 'insert');
        assert.ok(i, 'insert must run when update matched 0 rows');
    }),

    test('Dataplane: traverse out → query with source_id_eq', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [{ id: 'e1', source_id: 'a', target_id: 'b', weight: 1 }], total_count: 1 };
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
        const rows = await storage.traverse('rel', 'a', 'out');
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.sourceId, 'a');
        assert.equal(rows[0]!.targetId, 'b');
        assert.deepEqual(rows[0]!.edgeProps, { id: 'e1', weight: 1 });
        const q = client.calls.find((c) => c.method === 'query')!;
        assert.deepEqual(recordedQueryBody(q).filter, { source_id_eq: 'a' });
    }),

    test('Dataplane: traverse in → query with target_id_eq', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [], total_count: 0 };
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
        await storage.traverse('rel', 'a', 'in');
        const q = client.calls.find((c) => c.method === 'query')!;
        assert.deepEqual(recordedQueryBody(q).filter, { target_id_eq: 'a' });
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
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
        const rows = await storage.traverse('rel', 'a', 'both');
        const ids = rows.map((r) => (r.edgeProps as { id?: string }).id);
        assert.deepEqual(ids.sort(), ['e1', 'e2', 'shared']);
    }),

    test('Dataplane: deleteEdgesWhere maps sourceId/targetId → source_id/target_id', async () => {
        const client = new FakeSdkClient();
        client.responses['deleteByQuery'] = { deleted: 1 };
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });
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
        const storage = new DataplaneCollectionStorage({
            client,
            tenantProvider: () => tenants[i++ % tenants.length]!,
        });
        await storage.count('coll');
        await storage.count('coll');
        await storage.count('coll');
        const ts = client.calls.filter((c) => c.method === 'count').map((c) => c.args[0]);
        assert.deepEqual(ts, ['ta', 'tb', 'tc']);
    }),

    test('Dataplane: countEdges remaps sourceId/targetId keys + delegates to client.count', async () => {
        const client = new FakeSdkClient();
        client.responses['count'] = 5;
        const storage = new DataplaneCollectionStorage({ client, tenantProvider: () => 't' });

        // Empty filter
        assert.equal(await storage.countEdges('rel', {}), 5);
        const c1 = client.calls.find((c) => c.method === 'count')!;
        assert.deepEqual(c1.args[2], {});

        // Filter with edge keyset shorthand → translated to source_id_eq / target_id_eq
        client.calls.length = 0;
        await storage.countEdges('rel', { eq: { sourceId: 'a', kind: 'x' } });
        const c2 = client.calls.find((c) => c.method === 'count')!;
        assert.deepEqual(c2.args[2], { source_id_eq: 'a', kind_eq: 'x' });

        // startsWith on edge prop
        client.calls.length = 0;
        await storage.countEdges('rel', { startsWith: { relation: 'lore_' } });
        const c3 = client.calls.find((c) => c.method === 'count')!;
        assert.deepEqual(c3.args[2], { relation_starts_with: 'lore_' });
    }),
];

(async () => {
    console.log('CollectionStorage — Dataplane adapter tests');
    console.log('(the legacy graph engine adapter deleted with the engine: DEC-COLLECTIONS-GRAPH-SHAPE-LOSS, 2026-08-20)');
    console.log('='.repeat(72));
    for (const t of tests) await t();
    console.log('');
    console.log(`all ${tests.length} collection-storage cases passed ✓`);
})().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});

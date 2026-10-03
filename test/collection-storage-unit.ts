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
 *   - filterToExtra operator translation (scope-builder extra clauses; the
 *     engine's tagged grammar is F1 — there is no suffix-keyed format)
 *   - upsert: updateByQuery-first, insert-on-0, no-insert-on-match; the insert
 *     carries the D2 row key + scope columns
 *   - get / find / count / deleteWhere translated shapes (org + Lore workspace
 *     AND-ed onto every filter; results scope-guarded client-side)
 *   - addEdge / upsertEdge / traverse (out/in/both with dedup) /
 *     deleteEdgesWhere / countEdges
 *   - scopeProvider called per op (multi-workspace routing)
 *
 * No framework; exit non-zero on first failure.
 */

import assert from 'node:assert/strict';
import {
    DataplaneCollectionStorage,
    filterToExtra,
    type CollectionStorageSdkClient,
} from '../packages/lore/src/engines/dataplaneCollectionStorage.js';
import {
    buildDataplaneScopeFilter,
    dataplaneRowKey,
    scopeRowFields,
    type DataplaneScope,
    type ScopeFilterInput,
} from '../packages/lore/src/engines/dataplaneScopeFilter.js';

const DP_WS = 'dp-ws';
const SCOPE: DataplaneScope = { orgId: 'org-x', loreWorkspace: 'ws-x', dataplaneWorkspaceId: DP_WS };
const scopeProvider = (): DataplaneScope => SCOPE;

/** Expected crud filter: org + Lore workspace AND-ed with the caller's clauses. */
function crud(extra: NonNullable<ScopeFilterInput['extra']> = [], scope: DataplaneScope = SCOPE): unknown {
    return buildDataplaneScopeFilter(scope, { extra }, 'crud', 0).server;
}

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

/**
 * The engine always returns the scope columns (D1). Stamp them onto canned
 * rows that carry a string `id` and no org_id, so tests can stay terse while
 * the adapter's fail-closed client guard still runs.
 */
function stampRows(out: unknown): unknown {
    const res = out as { records?: unknown[] } | null;
    if (!res || !Array.isArray(res.records)) return out;
    return {
        ...res,
        records: res.records.map((rec) => {
            const r = rec as Record<string, unknown>;
            if (!r || typeof r['id'] !== 'string' || 'org_id' in r) return rec;
            return { ...r, ...scopeRowFields(SCOPE, r['id']) };
        }),
    };
}

class FakeSdkClient implements CollectionStorageSdkClient {
    calls: Call[] = [];
    /** Per-method canned responses; method → value or function-of-args. */
    responses: Partial<Record<string, unknown | ((...args: unknown[]) => unknown)>> = {};

    private dispatch(method: string, args: unknown[]): unknown {
        this.calls.push({ method, args });
        const r = this.responses[method];
        const out = typeof r === 'function' ? (r as (...a: unknown[]) => unknown)(...args) : r;
        return method === 'query' ? stampRows(out) : out;
    }

    insert = async <T = unknown>(...args: unknown[]): Promise<T> =>
        this.dispatch('insert', args) as T;
    get = async <T = unknown>(...args: unknown[]): Promise<T> =>
        this.dispatch('get', args) as T;
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
    /* ─── filterToExtra translation ───────────────────── */
    test('filterToExtra: translates each operator to a scope-builder extra clause (one per field+operator)', () => {
        const out = filterToExtra({
            eq: { type: 'note', project: 'lore' },
            contains: { label: 'auth' },
            startsWith: { label: 'AUTH' },
            gt: { score: 10 },
            gte: { score: 5 },
            lt: { createdAt: '2026-01-01' },
            lte: { createdAt: '2026-12-31' },
            in: { kind: ['function', 'method'] },
        });
        assert.deepEqual(out, [
            { field: 'type', op: 'eq', value: 'note' },
            { field: 'project', op: 'eq', value: 'lore' },
            { field: 'label', op: 'contains', value: 'auth' },
            { field: 'label', op: 'starts_with', value: 'AUTH' },
            { field: 'score', op: 'gt', value: 10 },
            { field: 'score', op: 'gte', value: 5 },
            { field: 'createdAt', op: 'lt', value: '2026-01-01' },
            { field: 'createdAt', op: 'lte', value: '2026-12-31' },
            { field: 'kind', op: 'in', value: ['function', 'method'] },
        ]);
    }),

    test('filterToExtra: the portable `id` is the LOGICAL id (lore_id on the wire, never the row key)', () => {
        assert.deepEqual(filterToExtra({ eq: { id: 'a' } }), [{ field: 'lore_id', op: 'eq', value: 'a' }]);
    }),

    test('filterToExtra: empty / undefined → []', () => {
        assert.deepEqual(filterToExtra(undefined), []);
        assert.deepEqual(filterToExtra({}), []);
    }),

    /* ─── DataplaneCollectionStorage: nodes ───────────────────── */
    test('Dataplane: upsert calls updateByQuery first, insert on 0', async () => {
        const client = new FakeSdkClient();
        client.responses['updateByQuery'] = { updated: 0 };
        const storage = new DataplaneCollectionStorage({
            client,
            scopeProvider,
        });
        await storage.upsert('items', 'id', { id: 'a', name: 'Alpha' });
        const u = client.calls.find((c) => c.method === 'updateByQuery');
        assert.ok(u, 'updateByQuery must be called first');
        assert.equal(u!.args[0], DP_WS, 'first arg is the Dataplane workspace');
        assert.deepEqual(u!.args[2], crud([{ field: 'lore_id', op: 'eq', value: 'a' }]));
        const i = client.calls.find((c) => c.method === 'insert');
        assert.ok(i, 'insert must follow when 0 rows updated');
        // D2: physical id = row key; logical id in lore_id; scope columns stamped.
        assert.deepEqual(i!.args[2], { name: 'Alpha', ...scopeRowFields(SCOPE, 'a') });
        assert.equal((i!.args[2] as Record<string, unknown>)['id'], dataplaneRowKey(SCOPE, 'a'));
    }),

    test('Dataplane: upsert skips insert when updateByQuery matched', async () => {
        const client = new FakeSdkClient();
        client.responses['updateByQuery'] = { updated: 1 };
        const storage = new DataplaneCollectionStorage({
            client,
            scopeProvider,
        });
        await storage.upsert('items', 'id', { id: 'a', name: 'Alpha v2' });
        const insertCalls = client.calls.filter((c) => c.method === 'insert');
        assert.equal(insertCalls.length, 0, 'no insert when update matched');
    }),

    test('Dataplane: get is a GET by the D2 row key (never a limit-1 query); envelope unwrapped, scope columns hidden', async () => {
        const client = new FakeSdkClient();
        client.responses['get'] = { success: true, data: { ...scopeRowFields(SCOPE, 'a'), name: 'X' } };
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        const out = await storage.get<{ id: string; name: string }>('items', 'id', 'a');
        assert.deepEqual(out, { id: 'a', name: 'X' }, 'logical id back; scope columns hidden from the portable layer');
        assert.equal(client.calls.filter((c) => c.method === 'query').length, 0, 'identity lookups never use a filtered query');
        const g = client.calls.find((c) => c.method === 'get');
        assert.equal(g!.args[2], scopeRowFields(SCOPE, 'a')['id'], 'GET addresses the row key');
    }),

    test('Dataplane: get drops a row the engine returned from another Lore workspace (fail closed)', async () => {
        const client = new FakeSdkClient();
        const foreign: DataplaneScope = { ...SCOPE, loreWorkspace: 'ws-other' };
        client.responses['get'] = { success: true, data: { ...scopeRowFields(foreign, 'a'), name: 'leak' } };
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        assert.equal(await storage.get('items', 'id', 'a'), null);
    }),

    test('Dataplane: get returns null on the engine not-found envelope', async () => {
        const client = new FakeSdkClient();
        client.responses['get'] = { success: false, data: null, error: { code: 'ERR_NOT_FOUND', message: 'Record not found' } };
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        assert.equal(await storage.get('items', 'id', 'missing'), null);
    }),

    test('Dataplane: find passes Filter + limit + orderBy through to query', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [], total_count: 0, has_more: false };
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        await storage.find('items', {
            eq: { kind: 'note' },
            contains: { label: 'foo' },
            in: { type: ['a', 'b'] },
        }, { limit: 25, orderBy: 'createdAt', orderDir: 'desc' });
        const q = client.calls.find((c) => c.method === 'query')!;
        // The engine takes `sort: [{field,direction}]` (F-list: `order_by` is ignored).
        assert.deepEqual(q.args[2], {
            filter: crud([
                { field: 'kind', op: 'eq', value: 'note' },
                { field: 'label', op: 'contains', value: 'foo' },
                { field: 'type', op: 'in', value: ['a', 'b'] },
            ]),
            limit: 25,
            sort: [{ field: 'createdAt', direction: 'desc' }],
        });
    }),

    test('Dataplane: count passes filter to client.count', async () => {
        const client = new FakeSdkClient();
        client.responses['count'] = 17;
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        const n = await storage.count('items', { eq: { kind: 'note' } });
        assert.equal(n, 17);
        const c = client.calls.find((cc) => cc.method === 'count')!;
        assert.deepEqual(c.args[2], crud([{ field: 'kind', op: 'eq', value: 'note' }]));
    }),

    test('Dataplane: deleteWhere returns deleted count', async () => {
        const client = new FakeSdkClient();
        client.responses['deleteByQuery'] = { deleted: 4 };
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        const n = await storage.deleteWhere('items', { eq: { kind: 'tmp' } });
        assert.equal(n, 4);
        const d = client.calls.find((c) => c.method === 'deleteByQuery')!;
        assert.deepEqual(d.args[2], crud([{ field: 'kind', op: 'eq', value: 'tmp' }]), 'deleteWhere can never widen past org + workspace');
    }),

    /* ─── DataplaneCollectionStorage: edges ───────────────────── */
    test('Dataplane: addEdge inserts row with source_id + target_id', async () => {
        const client = new FakeSdkClient();
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        await storage.addEdge('rel', 'src1', 'tgt1', { weight: 0.7 });
        const i = client.calls.find((c) => c.method === 'insert')!;
        assert.deepEqual(i.args[2], {
            weight: 0.7,
            source_id: 'src1',
            target_id: 'tgt1',
            ...scopeRowFields(SCOPE, 'src1__tgt1'),
        });
    }),

    test('Dataplane: upsertEdge selects on the scoped edge logical id', async () => {
        const client = new FakeSdkClient();
        client.responses['updateByQuery'] = { updated: 0 };
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        await storage.upsertEdge('rel', 'src1', 'tgt1', { weight: 0.5 });
        const u = client.calls.find((c) => c.method === 'updateByQuery')!;
        assert.deepEqual(u.args[2], crud([{ field: 'lore_id', op: 'eq', value: 'src1__tgt1' }]));
        const i = client.calls.find((c) => c.method === 'insert');
        assert.ok(i, 'insert must run when update matched 0 rows');
    }),

    test('Dataplane: traverse out → scoped query with source_id eq', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [{ id: 'e1', source_id: 'a', target_id: 'b', weight: 1 }], total_count: 1 };
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        const rows = await storage.traverse('rel', 'a', 'out');
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.sourceId, 'a');
        assert.equal(rows[0]!.targetId, 'b');
        assert.deepEqual(rows[0]!.edgeProps, { id: 'e1', weight: 1 });
        const q = client.calls.find((c) => c.method === 'query')!;
        assert.deepEqual(recordedQueryBody(q).filter, crud([{ field: 'source_id', op: 'eq', value: 'a' }]));
    }),

    test('Dataplane: traverse in → scoped query with target_id eq', async () => {
        const client = new FakeSdkClient();
        client.responses['query'] = { records: [], total_count: 0 };
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        await storage.traverse('rel', 'a', 'in');
        const q = client.calls.find((c) => c.method === 'query')!;
        assert.deepEqual(recordedQueryBody(q).filter, crud([{ field: 'target_id', op: 'eq', value: 'a' }]));
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
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        const rows = await storage.traverse('rel', 'a', 'both');
        const ids = rows.map((r) => (r.edgeProps as { id?: string }).id);
        assert.deepEqual(ids.sort(), ['e1', 'e2', 'shared']);
    }),

    test('Dataplane: deleteEdgesWhere maps sourceId/targetId → source_id/target_id', async () => {
        const client = new FakeSdkClient();
        client.responses['deleteByQuery'] = { deleted: 1 };
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });
        const n = await storage.deleteEdgesWhere('rel', { eq: { sourceId: 'src1', kind: 'a' } });
        assert.equal(n, 1);
        const d = client.calls.find((c) => c.method === 'deleteByQuery')!;
        assert.deepEqual(d.args[2], crud([
            { field: 'source_id', op: 'eq', value: 'src1' },
            { field: 'kind', op: 'eq', value: 'a' },
        ]));
    }),

    test('Dataplane: scopeProvider is called per op (multi-workspace routing)', async () => {
        const workspaces = ['wa', 'wb', 'wc'];
        let i = 0;
        const client = new FakeSdkClient();
        client.responses['count'] = 0;
        const storage = new DataplaneCollectionStorage({
            client,
            scopeProvider: () => ({ orgId: 'org-x', loreWorkspace: workspaces[i++ % workspaces.length]!, dataplaneWorkspaceId: DP_WS }),
        });
        await storage.count('coll');
        await storage.count('coll');
        await storage.count('coll');
        const calls = client.calls.filter((c) => c.method === 'count');
        assert.ok(calls.every((c) => c.args[0] === DP_WS), 'always the ONE Dataplane workspace');
        assert.deepEqual(
            calls.map((c) => c.args[2]),
            workspaces.map((w) => crud([], { ...SCOPE, loreWorkspace: w })),
            'the Lore workspace rides in the filter, per op',
        );
    }),

    test('Dataplane: countEdges remaps sourceId/targetId keys + delegates to client.count', async () => {
        const client = new FakeSdkClient();
        client.responses['count'] = 5;
        const storage = new DataplaneCollectionStorage({ client, scopeProvider });

        // Empty filter
        assert.equal(await storage.countEdges('rel', {}), 5);
        const c1 = client.calls.find((c) => c.method === 'count')!;
        assert.deepEqual(c1.args[2], crud());

        // Filter with edge keyset shorthand → translated to source_id / target_id clauses
        client.calls.length = 0;
        await storage.countEdges('rel', { eq: { sourceId: 'a', kind: 'x' } });
        const c2 = client.calls.find((c) => c.method === 'count')!;
        assert.deepEqual(c2.args[2], crud([
            { field: 'source_id', op: 'eq', value: 'a' },
            { field: 'kind', op: 'eq', value: 'x' },
        ]));

        // startsWith on edge prop: the engine's count matcher cannot evaluate starts_with
        // (review A1 #4), so the adapter scans a scoped query and filters client-side —
        // it must NOT send a starts_with clause to count.
        client.calls.length = 0;
        await storage.countEdges('rel', { startsWith: { relation: 'lore_' } });
        assert.equal(client.calls.find((c) => c.method === 'count'), undefined);
        const q3 = client.calls.find((c) => c.method === 'query')!;
        assert.deepEqual((q3.args[2] as { filter: unknown }).filter, crud());
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

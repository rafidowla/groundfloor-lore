#!/usr/bin/env tsx
/**
 * dataplane-vector-store-unit.ts — Q2.2 slice 3 DataplaneVectorStore unit tests.
 *
 * Covers the adapter in isolation with a fake SDK client + stub embedder.
 * The goal: lock the contract so server.ts can depend on it.
 *
 *   - initialize() is a no-op at boot (lazy per-tenant schema push)
 *   - first op per tenant pushes the lore_verbatim collection; second op
 *     on the same tenant does NOT re-push
 *   - "already exists" on createCollection is tolerated; non-exists errors
 *     propagate AND the cached promise is dropped so a retry actually
 *     re-pushes
 *   - store() upserts via updateByQuery → falls through to insert on
 *     updated=0, and preserves the id across the roundtrip
 *   - store() embeds via the injected embedder (deterministic test stub)
 *   - search() embeds the query, forwards metadata_filter with org_id
 *     injected, strips unsupported security_scopes from the filter, and
 *     maps result shape (score vs _distance, scopes string → array)
 *   - delete() issues deleteByQuery {id_eq}; count() carries org_id
 *   - tenantProvider is called per-op (multi-tenant routing without
 *     reconstructing the adapter)
 */

import assert from 'node:assert/strict';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';

interface Call {
    method: string;
    args: unknown[];
}

class FakeClient {
    calls: Call[] = [];
    responses: Partial<Record<string, unknown | ((...args: unknown[]) => unknown)>> = {};
    throws: Partial<Record<string, Error>> = {};

    vector = {
        search: (...args: unknown[]) => this.dispatch('vector.search', args),
    };

    private async dispatch(method: string, args: unknown[]): Promise<unknown> {
        this.calls.push({ method, args });
        if (this.throws[method]) throw this.throws[method];
        const r = this.responses[method];
        if (typeof r === 'function') return (r as (...a: unknown[]) => unknown)(...args);
        return r;
    }

    createCollection = (...args: unknown[]) => this.dispatch('createCollection', args);
    insert = (...args: unknown[]) => this.dispatch('insert', args);
    updateByQuery = (...args: unknown[]) => this.dispatch('updateByQuery', args);
    deleteByQuery = (...args: unknown[]) => this.dispatch('deleteByQuery', args);
    count = (...args: unknown[]) => this.dispatch('count', args);
}

/**
 * Build an EmbeddingProvider stub for tests. Slice 6a routes embedding
 * through the EmbeddingProvider interface; pre-6a tests passed a bare
 * `embedder` function. The shape below is the minimum the adapter
 * actually reads.
 */
function fakeEmbedder(fn: (t: string) => Promise<number[]>) {
    // The asymmetric-prefix follow-up split embed() into embedQuery /
    // embedDocument. For tests we pass through the same function for
    // all three so the adapter sees a stable per-input vector — the
    // adapter is responsible for picking which method to call, not for
    // synthesising prefixes.
    return {
        modelId: 'fake/test',
        dimension: 4,
        initialize: async () => {},
        embed: fn,
        embedQuery: fn,
        embedDocument: fn,
    };
}

function buildAdapter(overrides: {
    tenant?: string;
    orgId?: string;
    embedder?: (t: string) => Promise<number[]>;
    hasCapability?: (capability: string) => Promise<boolean | null>;
} = {}): {
    adapter: DataplaneVectorStore;
    client: FakeClient;
} {
    const client = new FakeClient();
    const adapter = new DataplaneVectorStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        tenantProvider: () => overrides.tenant ?? 'tenant-alpha',
        orgId: overrides.orgId ?? 'org-main',
        hasCapability: overrides.hasCapability,
        embeddingProvider: fakeEmbedder(overrides.embedder ?? (async (t: string) => {
            // deterministic stub: vector of length 4 tied to input length
            const n = Math.min(8, t.length);
            return [n / 10, (n + 1) / 10, (n + 2) / 10, (n + 3) / 10];
        })),
    });
    return { adapter, client };
}

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

const tests = [
    test('initialize() is a no-op at boot (per-tenant lazy push)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        await adapter.initialize();
        const creates = client.calls.filter((c) => c.method === 'createCollection');
        assert.equal(creates.length, 0, 'initialize() must not hit Dataplane at boot');
    }),

    test('first op per tenant pushes lore_verbatim; second op does NOT re-push', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.store({ id: 'a', text: 'alpha', metadata: {} });
        const after1 = client.calls.filter((c) => c.method === 'createCollection').length;
        assert.equal(after1, 1, 'expected one createCollection on first op');
        const schema = (client.calls.find((c) => c.method === 'createCollection')!.args[1] as { name: string });
        assert.equal(schema.name, 'lore_verbatim');
        await adapter.store({ id: 'b', text: 'beta', metadata: {} });
        const after2 = client.calls.filter((c) => c.method === 'createCollection').length;
        assert.equal(after2, after1, 'schema push must be memoized per tenant');
    }),

    test('"already exists" on createCollection is swallowed; op proceeds', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['createCollection'] = new Error('collection already exists');
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.store({ id: 'a', text: 'alpha', metadata: {} });
        const inserts = client.calls.filter((c) => c.method === 'insert');
        assert.equal(inserts.length, 1, 'store() should proceed past idempotent schema push');
    }),

    test('non-"already exists" createCollection error propagates AND retries next time', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['createCollection'] = new Error('auth failure');
        let threw = false;
        try {
            await adapter.store({ id: 'a', text: 'alpha', metadata: {} });
        } catch (err) {
            threw = true;
            assert.match((err as Error).message, /auth failure/);
        }
        assert.ok(threw, 'expected non-exists error to propagate');
        // Next attempt must actually re-push (cached failure was dropped).
        delete client.throws['createCollection'];
        client.responses['createCollection'] = {};
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.store({ id: 'a', text: 'alpha', metadata: {} });
        const creates = client.calls.filter((c) => c.method === 'createCollection').length;
        assert.ok(creates >= 2, `expected retry after failure, got ${creates} createCollection calls`);
    }),

    test('store() upserts via updateByQuery → insert on updated=0; carries org_id + vector', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.store({
            id: 'n1',
            text: 'hello world',
            metadata: { type: 'note', label: 'H', tags: 't1,t2', project: 'p', ecosystem: 'e', updatedAt: '2026-04-24T00:00:00Z' },
        });
        const upd = client.calls.find((c) => c.method === 'updateByQuery')!;
        assert.deepEqual(upd.args[2], { id_eq: 'n1' });
        const updFields = upd.args[3] as Record<string, unknown>;
        assert.equal(updFields['id'], 'n1');
        assert.equal(updFields['org_id'], 'org-main');
        assert.ok(Array.isArray(updFields['vector']) && (updFields['vector'] as unknown[]).length === 4);
        const ins = client.calls.find((c) => c.method === 'insert');
        assert.ok(ins, 'expected insert fallback when updateByQuery returned updated=0');
        const insRow = ins!.args[2] as Record<string, unknown>;
        assert.equal(insRow['id'], 'n1');
        assert.equal(insRow['project'], 'p');
    }),

    test('store() skips insert when updateByQuery matched a row', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['updateByQuery'] = { updated: 1 };
        await adapter.store({ id: 'n2', text: 'x', metadata: {} });
        const inserts = client.calls.filter((c) => c.method === 'insert');
        assert.equal(inserts.length, 0, 'idempotent upsert: no insert when an existing row was updated');
    }),

    test('search() embeds query, injects org_id, strips security_scopes from filter', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['vector.search'] = { records: [] };
        await adapter.search('query text', 5, {
            type: 'note',
            project: 'p',
            security_scopes: ['admin'], // must be stripped
        });
        const call = client.calls.find((c) => c.method === 'vector.search')!;
        const opts = call.args[2] as { vector: number[]; limit: number; filter: Record<string, unknown> };
        assert.equal(opts.limit, 5);
        assert.ok(Array.isArray(opts.vector) && opts.vector.length === 4);
        assert.equal(opts.filter['org_id'], 'org-main');
        assert.equal(opts.filter['type'], 'note');
        assert.equal(opts.filter['project'], 'p');
        assert.ok(!('security_scopes' in opts.filter), 'security_scopes must be stripped from metadata_filter');
    }),

    test('search() maps score/distance and splits joined security_scopes', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['vector.search'] = {
            records: [
                { id: 'r1', text: 'hello', _distance: 0.2, type: 'note', label: 'L', tags: 't', project: 'p', ecosystem: 'e', updated_at: 'ts', security_scopes: 'a,b' },
                { id: 'r2', text: 'world', score: 0.9, type: 'note', security_scopes: [] },
            ],
        };
        const res = await adapter.search('q', 10);
        assert.equal(res.length, 2);
        // _distance path: score = 1 - 0.2/2 = 0.9
        assert.ok(Math.abs(res[0].score - 0.9) < 1e-6, `expected 0.9 from _distance, got ${res[0].score}`);
        assert.deepEqual(res[0].metadata.security_scopes, ['a', 'b']);
        // explicit score path
        assert.equal(res[1].score, 0.9);
        assert.deepEqual(res[1].metadata.security_scopes, []);
    }),

    test('search() with actorScopes filters rows post-search', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['vector.search'] = {
            records: [
                { id: 'public',  text: 't', _distance: 0.1, type: 'note', security_scopes: [] },
                { id: 'admin',   text: 't', _distance: 0.1, type: 'note', security_scopes: 'admin' },
                { id: 'legal',   text: 't', _distance: 0.1, type: 'note', security_scopes: 'legal' },
                { id: 'admlegal', text: 't', _distance: 0.1, type: 'note', security_scopes: 'admin,legal' },
            ],
        };
        // NW-7d: VectorProvider.search signature is (query, limit, filter, opts, actorScopes)
        // — `opts` (LocalVerbatimStore's includeHistory) was inserted as the 4th param to
        // unify Local and Dataplane signatures. Pass undefined for opts; scopes are 5th.
        const res = await adapter.search('q', 10, undefined, undefined, ['admin']);
        const ids = res.map((r) => r.id).sort();
        assert.deepEqual(ids, ['admin', 'admlegal', 'public'],
            'rows kept iff scopes empty (public) OR intersect actor scopes');
    }),

    test('search() with no actorScopes returns all rows (daemon-internal callers)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['vector.search'] = {
            records: [
                { id: 'a', text: 't', _distance: 0.1, type: 'note', security_scopes: 'admin' },
                { id: 'b', text: 't', _distance: 0.1, type: 'note', security_scopes: 'legal' },
            ],
        };
        const res = await adapter.search('q', 10);
        assert.equal(res.length, 2, 'no filtering when actorScopes omitted');
    }),

    test('bm25Search short-circuits to [] when hasCapability returns false', async () => {
        const probeCalls: string[] = [];
        const { adapter, client } = buildAdapter({
            hasCapability: async (cap) => { probeCalls.push(cap); return false; },
        });
        client.responses['createCollection'] = {};
        const res = await adapter.bm25Search('hello');
        assert.deepEqual(res, []);
        assert.deepEqual(probeCalls, ['RankedFullTextSearch']);
        assert.ok(!client.calls.some((c) => c.method === 'search'),
            'should NOT have called client.search() when capability is absent');
    }),

    test('bm25Search calls client.search() when hasCapability returns true', async () => {
        const { adapter, client } = buildAdapter({
            hasCapability: async () => true,
        });
        client.responses['createCollection'] = {};
        // FakeClient.search returns SDK-shape array with _score populated;
        // first row must have _score for the existing code to proceed.
        (client as unknown as { search: typeof client.search }).search = (async () => [
            { id: 'r1', text: 'x', _score: 0.7, security_scopes: [] },
        ]) as never;
        const res = await adapter.bm25Search('hello');
        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'r1');
        assert.equal(res[0].score, 0.7);
    }),

    test('bm25Search falls open when hasCapability returns null (probe failed)', async () => {
        const { adapter, client } = buildAdapter({
            hasCapability: async () => null,
        });
        client.responses['createCollection'] = {};
        // With probe null, we should still call search() — falls open.
        (client as unknown as { search: typeof client.search }).search = (async () => [
            { id: 'r1', text: 'x', _score: 0.5, security_scopes: [] },
        ]) as never;
        const res = await adapter.bm25Search('q');
        assert.equal(res.length, 1, 'null probe should not block the call');
    }),

    test('bm25Search without hasCapability falls through to legacy _score heuristic', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        // No _score on the first row → existing heuristic returns [].
        (client as unknown as { search: typeof client.search }).search = (async () => [
            { id: 'r1', text: 'x', security_scopes: [] },
        ]) as never;
        const res = await adapter.bm25Search('q');
        assert.deepEqual(res, [], 'no _score on first row → semantic-only fallback');
    }),

    test('bm25Search parses comma-string security_scopes and FILTERS non-intersecting rows (L-006)', async () => {
        const { adapter, client } = buildAdapter({ hasCapability: async () => true });
        client.responses['createCollection'] = {};
        // Cloud connectors round-trip security_scopes as a COMMA-JOINED STRING.
        // Before the fix the BM25 path parsed array-only → string → [] → kept.
        (client as unknown as { search: typeof client.search }).search = (async () => [
            { id: 'public', text: 'x', _score: 0.9, security_scopes: '' },
            { id: 'secret', text: 'x', _score: 0.8, security_scopes: 'secret,legal' },
        ]) as never;
        // Actor holds only 'public' → must NOT see the 'secret,legal' row.
        const res = await adapter.bm25Search('hello', 10, undefined, ['public']);
        const ids = res.map((r) => r.id).sort();
        assert.deepEqual(ids, ['public'],
            'comma-string scoped row that does not intersect actor scopes must be filtered out');
    }),

    test('bm25Search keeps comma-string scoped row when it intersects actor scopes (L-006 control)', async () => {
        const { adapter, client } = buildAdapter({ hasCapability: async () => true });
        client.responses['createCollection'] = {};
        (client as unknown as { search: typeof client.search }).search = (async () => [
            { id: 'secret', text: 'x', _score: 0.8, security_scopes: 'secret,legal' },
        ]) as never;
        const res = await adapter.bm25Search('hello', 10, undefined, ['legal']);
        assert.deepEqual(res.map((r) => r.id), ['secret'],
            'comma-string scoped row that intersects actor scopes must be kept');
    }),

    test('bm25Search treats array scopes identically to comma-string (L-006 parity)', async () => {
        const { adapter, client } = buildAdapter({ hasCapability: async () => true });
        client.responses['createCollection'] = {};
        (client as unknown as { search: typeof client.search }).search = (async () => [
            { id: 'arr', text: 'x', _score: 0.8, security_scopes: ['secret', 'legal'] },
            { id: 'str', text: 'x', _score: 0.7, security_scopes: 'secret,legal' },
        ]) as never;
        // Neither intersects ['public'] → both filtered; proves array and
        // comma-string parse to the same scope set.
        const denied = await adapter.bm25Search('hello', 10, undefined, ['public']);
        assert.deepEqual(denied.map((r) => r.id), [], 'array + comma-string both filtered when no intersection');
        // Both intersect ['legal'] → both kept.
        const allowed = await adapter.bm25Search('hello', 10, undefined, ['legal']);
        assert.deepEqual(allowed.map((r) => r.id).sort(), ['arr', 'str'], 'array + comma-string both kept on intersection');
    }),

    test('delete() issues deleteByQuery {id_eq}; count() carries org_id', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['deleteByQuery'] = { deleted: 1 };
        client.responses['count'] = 42;
        await adapter.delete('n3');
        const del = client.calls.find((c) => c.method === 'deleteByQuery')!;
        assert.deepEqual(del.args[2], { id_eq: 'n3', org_id: 'org-main' });
        const n = await adapter.count();
        assert.equal(n, 42);
        const cnt = client.calls.find((c) => c.method === 'count')!;
        assert.deepEqual(cnt.args[2], { org_id: 'org-main' });
    }),

    test('tenantProvider resolves per-op (multi-tenant on a single adapter)', async () => {
        let current = 'tenant-a';
        const client = new FakeClient();
        client.responses['createCollection'] = {};
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        const adapter = new DataplaneVectorStore({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: client as any,
            tenantProvider: () => current,
            orgId: 'org-main',
            embeddingProvider: fakeEmbedder(async () => [0.1, 0.2, 0.3, 0.4]),
        });
        await adapter.store({ id: 'a', text: 'x', metadata: {} });
        current = 'tenant-b';
        await adapter.store({ id: 'b', text: 'y', metadata: {} });
        const upserts = client.calls.filter((c) => c.method === 'updateByQuery');
        assert.equal(upserts[0].args[0], 'tenant-a');
        assert.equal(upserts[1].args[0], 'tenant-b');
        // Lazy push fires for BOTH tenants, not just one.
        const creates = client.calls.filter((c) => c.method === 'createCollection');
        const tenants = Array.from(new Set(creates.map((c) => c.args[0] as string)));
        assert.deepEqual(tenants.sort(), ['tenant-a', 'tenant-b']);
    }),

    test('getById / listIds are cloud-deferred stubs (null / [])', async () => {
        const { adapter } = buildAdapter();
        assert.equal(await adapter.getById('anything'), null);
        assert.deepEqual(await adapter.listIds('lore:'), []);
    }),
];

async function main(): Promise<void> {
    console.log('Q2.2 slice 3 — DataplaneVectorStore unit tests');
    console.log('='.repeat(72));
    for (const t of tests) await t();
    console.log('');
    console.log(`all ${tests.length} unit tests passed ✓`);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});

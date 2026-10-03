#!/usr/bin/env tsx
/**
 * dataplane-vector-store-unit.ts — Q2.2 slice 3 DataplaneVectorStore unit tests.
 *
 * Covers the adapter in isolation with a fake SDK client + stub embedder.
 * The goal: lock the contract so server.ts can depend on it.
 *
 *   - initialize() is a no-op at boot (lazy per-Dataplane-workspace schema push)
 *   - first op per Dataplane workspace pushes the lore_verbatim collection;
 *     second op on the same workspace does NOT re-push
 *   - "already exists" on createCollection is tolerated; non-exists errors
 *     propagate AND the cached promise is dropped so a retry actually
 *     re-pushes
 *   - store() upserts via updateByQuery → falls through to insert on
 *     updated=0; the row carries the D2 row key + scope columns and the
 *     logical id survives the roundtrip in lore_id
 *   - store() embeds via the injected embedder (deterministic test stub)
 *   - search() embeds the query, forwards the engine-grammar metadata_filter
 *     (string-eq clauses only: org, Lore workspace, caller fields), strips
 *     unsupported security_scopes, over-fetches, drops out-of-scope rows
 *     client-side, and maps result shape (score vs _distance, scopes string →
 *     array)
 *   - delete() issues a scoped deleteByQuery on lore_id; count() is scoped
 *   - loreWorkspaceProvider is called per-op (multi-workspace routing without
 *     reconstructing the adapter); the Dataplane workspace stays fixed
 */

import assert from 'node:assert/strict';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';
import { registryAcceptingAny } from './helpers/workspace-registry.js';
import {
    buildDataplaneScopeFilter,
    dataplaneRowKey,
    scopeRowFields,
    type DataplaneScope,
    type ScopeFilterInput,
} from '../packages/lore/src/engines/dataplaneScopeFilter.js';

const DP_WS = 'dp-ws';
const scopeOf = (ws = 'ws-alpha', org = 'org-main'): DataplaneScope => ({ orgId: org, loreWorkspace: ws, dataplaneWorkspaceId: DP_WS });

/**
 * The engine returns the scope columns on every row (D1). Stamp them onto
 * canned rows with a string `id` and no org_id so tests stay terse while the
 * adapter's fail-closed client predicate still runs.
 */
function stamp(out: unknown, ws = 'ws-alpha', org = 'org-main'): unknown {
    const conv = (rec: unknown): unknown => {
        const r = rec as Record<string, unknown>;
        if (!r || typeof r['id'] !== 'string' || 'org_id' in r) return rec;
        return { ...r, ...scopeRowFields(scopeOf(ws, org), r['id']) };
    };
    if (Array.isArray(out)) return out.map(conv);
    const res = out as { records?: unknown[] } | null;
    if (res && Array.isArray(res.records)) return { ...res, records: res.records.map(conv) };
    return out;
}

interface Call {
    method: string;
    args: unknown[];
}

class FakeClient {
    calls: Call[] = [];
    responses: Partial<Record<string, unknown | ((...args: unknown[]) => unknown)>> = {};
    throws: Partial<Record<string, Error>> = {};

    /** Workspace the canned search rows are stamped as (override to simulate leakage). */
    stampWs = 'ws-alpha';
    /** Installed per test by bm25 cases; collection-first like the real SDK. */
    search?: (...args: unknown[]) => Promise<unknown>;

    vector = {
        search: (...args: unknown[]) => this.dispatch('vector.search', args),
    };

    private async dispatch(method: string, args: unknown[]): Promise<unknown> {
        this.calls.push({ method, args });
        if (this.throws[method]) throw this.throws[method];
        const r = this.responses[method];
        // `query` defaults to an empty page: store() now reads the existing row first (skip-identical, B item 3).
        const out = typeof r === 'function' ? (r as (...a: unknown[]) => unknown)(...args) : r ?? (method === 'query' ? { records: [] } : method === 'get' ? { success: false, data: null, error: { code: 'ERR_NOT_FOUND', message: 'not found' } } : undefined);
        return method === 'vector.search' || method === 'query' ? stamp(out, this.stampWs) : out;
    }

    createCollection = (...args: unknown[]) => this.dispatch('createCollection', args);
    insert = (...args: unknown[]) => this.dispatch('insert', args);
    updateByQuery = (...args: unknown[]) => this.dispatch('updateByQuery', args);
    deleteByQuery = (...args: unknown[]) => this.dispatch('deleteByQuery', args);
    count = (...args: unknown[]) => this.dispatch('count', args);
    query = (...args: unknown[]) => this.dispatch('query', args);
    /** Point read by row key: a miss is the engine's HTTP 200 + ERR_NOT_FOUND envelope (review B #5/#6). */
    get = (...args: unknown[]) => this.dispatch('get', args);
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
    workspace?: string;
    orgId?: string;
    embedder?: (t: string) => Promise<number[]>;
    hasCapability?: (capability: string) => Promise<boolean | null>;
} = {}): {
    adapter: DataplaneVectorStore;
    client: FakeClient;
} {
    const client = new FakeClient();
    if (overrides.workspace) client.stampWs = overrides.workspace;
    const adapter = new DataplaneVectorStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        dataplaneWorkspaceId: DP_WS,
        workspaceRegistry: registryAcceptingAny(),
        loreWorkspaceProvider: () => overrides.workspace ?? 'ws-alpha',
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

/** Expected crud filter (org + Lore workspace AND-ed with the caller's clauses). */
function crud(input: ScopeFilterInput, ws = 'ws-alpha'): unknown {
    return buildDataplaneScopeFilter(scopeOf(ws), input, 'crud', 0).server;
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
    test('initialize() is a no-op at boot (per-workspace lazy push)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        await adapter.initialize();
        const creates = client.calls.filter((c) => c.method === 'createCollection');
        assert.equal(creates.length, 0, 'initialize() must not hit Dataplane at boot');
    }),

    test('first op per Dataplane workspace pushes lore_verbatim; second op does NOT re-push', async () => {
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
        assert.equal(after2, after1, 'schema push must be memoized per Dataplane workspace');
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
        assert.equal(upd.args[0], DP_WS);
        assert.deepEqual(upd.args[2], crud({ loreId: 'n1' }));
        const updFields = upd.args[3] as Record<string, unknown>;
        assert.ok(!('id' in updFields), 'the physical row key is never rewritten by an update');
        assert.ok(Array.isArray(updFields['vector']) && (updFields['vector'] as unknown[]).length === 4);
        const ins = client.calls.find((c) => c.method === 'insert');
        assert.ok(ins, 'expected insert fallback when updateByQuery returned updated=0');
        const insRow = ins!.args[2] as Record<string, unknown>;
        assert.equal(insRow['id'], dataplaneRowKey(scopeOf(), 'n1'), 'D2: physical id is the row key');
        assert.equal(insRow['lore_id'], 'n1', 'logical id survives in lore_id');
        assert.equal(insRow['lore_workspace'], 'ws-alpha');
        assert.equal(insRow['org_id'], 'org-main');
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

    test('search() embeds query, sends engine-grammar string-eq scope filter, strips security_scopes', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['vector.search'] = { records: [] };
        await adapter.search('query text', 5, {
            type: 'note',
            project: 'p',
            security_scopes: ['admin'], // must be stripped
        });
        const call = client.calls.find((c) => c.method === 'vector.search')!;
        const opts = call.args[2] as { vector: number[]; limit: number; filter: unknown };
        assert.equal(call.args[0], DP_WS);
        const built = buildDataplaneScopeFilter(scopeOf(), { type: 'note', project: 'p', revision: 'current' }, 'vector', 5); // C item 8: history rows are excluded unless includeHistory
        assert.equal(opts.limit, built.fetchLimit, 'over-fetch: the client predicate may drop rows');
        assert.ok(opts.limit >= 5);
        assert.ok(Array.isArray(opts.vector) && opts.vector.length === 4);
        assert.deepEqual(opts.filter, built.server, 'org + workspace + type + project + revision_state=current as string-eq clauses');
        assert.ok(!JSON.stringify(opts.filter).includes('security_scopes'), 'security_scopes must be stripped from metadata_filter');
    }),

    test('search() drops rows the engine returned from another Lore workspace (F5: metadata_filter is best-effort)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        const foreign = { ...scopeRowFields(scopeOf('ws-other'), 'leak'), text: 'secret', _distance: 0.1, type: 'note', security_scopes: [] };
        const mine = { id: 'mine', text: 'ok', _distance: 0.1, type: 'note', security_scopes: [] };
        client.responses['vector.search'] = { records: [foreign, mine] };
        const res = await adapter.search('q', 10);
        assert.deepEqual(res.map((r) => r.id), ['mine']);
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
        // D4 (B item 4): normalised then best-first. `score` 0.9 is a cosine SIMILARITY -> (1 + 0.9)/2.
        assert.deepEqual(res.map((r) => r.id), ['r2', 'r1']);
        assert.ok(Math.abs(res[0].score - 0.95) < 1e-9, `expected 0.95 from score, got ${res[0].score}`);
        assert.deepEqual(res[0].metadata.security_scopes, []);
        // _distance path: score = 1 - 0.2/2 = 0.9
        assert.ok(Math.abs(res[1].score - 0.9) < 1e-6, `expected 0.9 from _distance, got ${res[1].score}`);
        assert.deepEqual(res[1].metadata.security_scopes, ['a', 'b']);
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
        assert.deepEqual(res.hits, []);
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
        client.search = (async () => stamp([
            { id: 'r1', text: 'x', _score: 0.7, security_scopes: [] },
        ])) as never;
        const res = await adapter.bm25Search('hello');
        assert.equal(res.hits.length, 1);
        assert.equal(res.hits[0].id, 'r1');
        assert.equal(res.hits[0].score, 0.7);
        assert.equal(res.ranked, true);
    }),

    test('bm25Search falls open when hasCapability returns null (probe failed)', async () => {
        const { adapter, client } = buildAdapter({
            hasCapability: async () => null,
        });
        client.responses['createCollection'] = {};
        // With probe null, we should still call search() — falls open.
        client.search = (async () => stamp([
            { id: 'r1', text: 'x', _score: 0.5, security_scopes: [] },
        ])) as never;
        const res = await adapter.bm25Search('q');
        assert.equal(res.hits.length, 1, 'null probe should not block the call');
    }),

    test('bm25Search without hasCapability: no _score (substring backend) -> hits kept at score 1.0, ranked:false', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        // No _score → substring backend: hits kept (A2 D4), flagged unranked so RRF excludes the lane.
        client.search = (async () => stamp([
            { id: 'r1', text: 'x', security_scopes: [] },
        ])) as never;
        const res = await adapter.bm25Search('q');
        assert.equal(res.hits.length, 1);
        assert.equal(res.hits[0]!.score, 1.0);
        assert.equal(res.ranked, false, 'unranked substring hits must not claim to be a ranking');
    }),

    test('bm25Search parses comma-string security_scopes and FILTERS non-intersecting rows (L-006)', async () => {
        const { adapter, client } = buildAdapter({ hasCapability: async () => true });
        client.responses['createCollection'] = {};
        // Cloud connectors round-trip security_scopes as a COMMA-JOINED STRING.
        // Before the fix the BM25 path parsed array-only → string → [] → kept.
        client.search = (async () => stamp([
            { id: 'public', text: 'x', _score: 0.9, security_scopes: '' },
            { id: 'secret', text: 'x', _score: 0.8, security_scopes: 'secret,legal' },
        ])) as never;
        // Actor holds only 'public' → must NOT see the 'secret,legal' row.
        const res = await adapter.bm25Search('hello', 10, undefined, ['public']);
        const ids = res.hits.map((r) => r.id).sort();
        assert.deepEqual(ids, ['public'],
            'comma-string scoped row that does not intersect actor scopes must be filtered out');
    }),

    test('bm25Search keeps comma-string scoped row when it intersects actor scopes (L-006 control)', async () => {
        const { adapter, client } = buildAdapter({ hasCapability: async () => true });
        client.responses['createCollection'] = {};
        client.search = (async () => stamp([
            { id: 'secret', text: 'x', _score: 0.8, security_scopes: 'secret,legal' },
        ])) as never;
        const res = await adapter.bm25Search('hello', 10, undefined, ['legal']);
        assert.deepEqual(res.hits.map((r) => r.id), ['secret'],
            'comma-string scoped row that intersects actor scopes must be kept');
    }),

    test('bm25Search treats array scopes identically to comma-string (L-006 parity)', async () => {
        const { adapter, client } = buildAdapter({ hasCapability: async () => true });
        client.responses['createCollection'] = {};
        client.search = (async () => stamp([
            { id: 'arr', text: 'x', _score: 0.8, security_scopes: ['secret', 'legal'] },
            { id: 'str', text: 'x', _score: 0.7, security_scopes: 'secret,legal' },
        ])) as never;
        // Neither intersects ['public'] → both filtered; proves array and
        // comma-string parse to the same scope set.
        const denied = await adapter.bm25Search('hello', 10, undefined, ['public']);
        assert.deepEqual(denied.hits.map((r) => r.id), [], 'array + comma-string both filtered when no intersection');
        // Both intersect ['legal'] → both kept.
        const allowed = await adapter.bm25Search('hello', 10, undefined, ['legal']);
        assert.deepEqual(allowed.hits.map((r) => r.id).sort(), ['arr', 'str'], 'array + comma-string both kept on intersection');
    }),

    test('bm25Search over-fetches (no server filter, F4) and drops out-of-scope rows client-side', async () => {
        const { adapter, client } = buildAdapter({ hasCapability: async () => true });
        client.responses['createCollection'] = {};
        let seen: { limit?: number; filter?: unknown } = {};
        client.search = (async (_c: unknown, _q: unknown, opts: { limit?: number; filter?: unknown }) => {
            seen = opts;
            return [
                { ...scopeRowFields(scopeOf('ws-other'), 'foreign'), text: 'x', _score: 0.99, security_scopes: '' },
                ...stamp([{ id: 'mine', text: 'x', _score: 0.5, security_scopes: '' }]) as unknown[],
            ];
        }) as never;
        const res = await adapter.bm25Search('hello', 5);
        assert.deepEqual(res.hits.map((r) => r.id), ['mine']);
        assert.equal(seen.filter, undefined, 'the engine keyword search has no filter');
        assert.equal(seen.limit, buildDataplaneScopeFilter(scopeOf(), {}, 'keyword', 15).fetchLimit, 'C item 8: widened x3 for history/tombstones dropped client-side');
        assert.ok((seen.limit ?? 0) > 5, 'over-fetch compensates for dropped rows');
    }),

    test('physicalDelete() issues scoped deleteByQuery on lore_id; count() is scoped', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['deleteByQuery'] = { deleted: 1 };
        client.responses['count'] = 42;
        await adapter.physicalDelete('n3');
        const del = client.calls.find((c) => c.method === 'deleteByQuery')!;
        assert.deepEqual(del.args[2], crud({ loreId: 'n3' }));
        const n = await adapter.count();
        assert.equal(n, 42);
        const cnt = client.calls.find((c) => c.method === 'count')!;
        assert.deepEqual(cnt.args[2], crud({}));
    }),

    test('loreWorkspaceProvider resolves per-op; ONE Dataplane workspace, schema pushed once', async () => {
        let current = 'ws-a';
        const client = new FakeClient();
        client.responses['createCollection'] = {};
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        const adapter = new DataplaneVectorStore({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: client as any,
            dataplaneWorkspaceId: DP_WS,
            workspaceRegistry: registryAcceptingAny(),
            loreWorkspaceProvider: () => current,
            orgId: 'org-main',
            embeddingProvider: fakeEmbedder(async () => [0.1, 0.2, 0.3, 0.4]),
        });
        await adapter.store({ id: 'a', text: 'x', metadata: {} });
        current = 'ws-b';
        await adapter.store({ id: 'b', text: 'y', metadata: {} });
        const upserts = client.calls.filter((c) => c.method === 'updateByQuery');
        assert.equal(upserts[0].args[0], DP_WS);
        assert.equal(upserts[1].args[0], DP_WS, 'the engine workspace is credential-fixed — never per Lore workspace');
        assert.deepEqual(upserts[0].args[2], crud({ loreId: 'a' }, 'ws-a'));
        assert.deepEqual(upserts[1].args[2], crud({ loreId: 'b' }, 'ws-b'));
        // Schema is per Dataplane workspace: pushed exactly once for both Lore workspaces.
        const creates = client.calls.filter((c) => c.method === 'createCollection');
        assert.equal(creates.length, 1);
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

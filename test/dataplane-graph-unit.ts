#!/usr/bin/env tsx
/**
 * dataplane-graph-unit.ts — Q2.2 DataplaneGraph unit tests.
 *
 * Covers the adapter in isolation with a fake TS-SDK client. The goal
 * isn't Dataplane end-to-end coverage (that's a later e2e slice) — it's
 * verifying the adapter's contract:
 *
 *   - initialize() pushes lore_node + lore_edge schemas and tolerates
 *     "already exists" errors (idempotent boot)
 *   - upsertNode uses updateByQuery, falls through to insert when 0 rows
 *     matched, and preserves the original created_at on updates
 *   - getNode + deleteNode roundtrip correctly; getNode returns null on
 *     404-ish errors
 *   - addEdge writes to lore_edge AND attempts graph.createEdge, ignoring
 *     501 "connector lacks graph support" failures
 *   - traverse tolerates non-graph connectors (empty array instead of throw)
 *   - listNodes / search / getStats / getTopology shape their filters
 *     correctly and carry org_id
 *   - getGraphContext stubs refuse graph ops but expose
 *     detectLanguage
 *   - tenantProvider is called per-operation (multi-tenant routing works
 *     without reconstructing the adapter)
 *
 * No framework; exits non-zero on first failure to match the rest of test/.
 */

import assert from 'node:assert/strict';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';

interface Call {
    method: string;
    args: unknown[];
}

/**
 * FakeClient — records every call, lets tests pre-stage responses per
 * method, and surfaces the call log for assertions.
 */
class FakeClient {
    calls: Call[] = [];
    responses: Partial<Record<string, unknown | ((...args: unknown[]) => unknown)>> = {};
    throws: Partial<Record<string, Error>> = {};

    graph = {
        createEdge: (...args: unknown[]) => this.dispatch('graph.createEdge', args),
        traverse: (...args: unknown[]) => this.dispatch('graph.traverse', args),
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
    get = (...args: unknown[]) => this.dispatch('get', args);
    query = (...args: unknown[]) => this.dispatch('query', args);
    updateByQuery = (...args: unknown[]) => this.dispatch('updateByQuery', args);
    deleteByQuery = (...args: unknown[]) => this.dispatch('deleteByQuery', args);
    count = (...args: unknown[]) => this.dispatch('count', args);
}

function buildAdapter(overrides: { tenant?: string; orgId?: string } = {}): {
    adapter: DataplaneGraph;
    client: FakeClient;
} {
    const client = new FakeClient();
    const adapter = new DataplaneGraph({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        tenantProvider: () => overrides.tenant ?? 'tenant-alpha',
        orgId: overrides.orgId ?? 'org-main',
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
    test('initialize() is a no-op (slice-2: per-tenant lazy push)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        await adapter.initialize();
        const createCalls = client.calls.filter((c) => c.method === 'createCollection');
        assert.equal(createCalls.length, 0, 'boot-time initialize must not hit Dataplane');
    }),

    test('first op per tenant pushes both collections (lazy)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['get'] = null;
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.upsertNode({
            id: 'n-init', type: 'note', label: 'x', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}',
        });
        const createCalls = client.calls.filter((c) => c.method === 'createCollection');
        assert.equal(createCalls.length, 2, 'expected lore_node + lore_edge createCollection on first op');
        const names = createCalls.map((c) => (c.args[1] as { name: string }).name);
        assert.deepEqual(names.sort(), ['lore_edge', 'lore_node']);
        for (const c of createCalls) assert.equal(c.args[0], 'tenant-alpha');
    }),

    test('second op on same tenant does NOT re-push schema', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['get'] = null;
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.upsertNode({ id: 'a', type: 't', label: 'a', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const firstCount = client.calls.filter((c) => c.method === 'createCollection').length;
        await adapter.upsertNode({ id: 'b', type: 't', label: 'b', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const secondCount = client.calls.filter((c) => c.method === 'createCollection').length;
        assert.equal(secondCount, firstCount, 'schema push must be memoized per tenant');
    }),

    test('lazy push tolerates "already exists" on createCollection', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['createCollection'] = new Error('collection already exists');
        client.responses['get'] = null;
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        // Must not throw — "already exists" is swallowed.
        await adapter.upsertNode({ id: 'a', type: 't', label: 'a', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const inserts = client.calls.filter((c) => c.method === 'insert');
        assert.equal(inserts.length, 1, 'op should proceed past idempotent schema push');
    }),

    test('lazy push rethrows non-"already exists" createCollection errors and retries next time', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['createCollection'] = new Error('auth failure');
        let threw = false;
        try {
            await adapter.upsertNode({ id: 'a', type: 't', label: 'a', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        } catch (err) {
            threw = true;
            assert.match((err as Error).message, /auth failure/);
        }
        assert.ok(threw, 'expected non-exists error to propagate');
        // Retry must actually re-attempt (the cached promise is dropped on failure).
        delete client.throws['createCollection'];
        client.responses['createCollection'] = {};
        client.responses['get'] = null;
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        await adapter.upsertNode({ id: 'a', type: 't', label: 'a', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const createCount = client.calls.filter((c) => c.method === 'createCollection').length;
        assert.ok(createCount >= 3, `expected retry after failure (≥3 total createCollection calls), got ${createCount}`);
    }),

    test('upsertNode inserts when updateByQuery matches 0', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['get'] = null; // no prior row
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        const node = await adapter.upsertNode({
            id: 'n1',
            type: 'note',
            label: 'hello',
            content: 'c',
            tags: 'a,b',
            project: 'p',
            ecosystem: 'e',
            metadata: '{}',
        });
        assert.equal(node.id, 'n1');
        assert.ok(node.createdAt.length > 0);
        assert.equal(node.createdAt, node.updatedAt, 'new node createdAt=updatedAt');
        const methods = client.calls.map((c) => c.method);
        assert.ok(methods.includes('updateByQuery'));
        assert.ok(methods.includes('insert'), 'expected insert fallback on updated=0');
        // updateByQuery filter shape sanity. The update is org-scoped (the
        // filter carries org_id so an upsert can't match another tenant's row
        // with the same id) — matches every other org-scoped Dataplane path.
        const upd = client.calls.find((c) => c.method === 'updateByQuery')!;
        assert.deepEqual(upd.args[2], { id_eq: 'n1', org_id: 'org-main' });
    }),

    test('upsertNode skips insert when updateByQuery updated a row', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['get'] = { id: 'n2', created_at: '2020-01-01T00:00:00Z', org_id: 'org-main' }; // F-S07: own-org record
        client.responses['updateByQuery'] = { updated: 1 };
        const node = await adapter.upsertNode({
            id: 'n2', type: 'note', label: 'x', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}',
        });
        assert.equal(node.createdAt, '2020-01-01T00:00:00Z', 'must preserve original created_at on update');
        const inserts = client.calls.filter((c) => c.method === 'insert');
        assert.equal(inserts.length, 0, 'no insert when update matched');
    }),

    test('getNode returns null on 404', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['get'] = new Error('not found 404');
        client.responses['query'] = { records: [] };
        const n = await adapter.getNode('missing');
        assert.equal(n, null);
    }),

    test('getNode roundtrips when record present', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['get'] = {
            id: 'n3', type: 'note', label: 'L', content: 'C', tags: 't',
            project: 'p', ecosystem: 'e', org_id: 'org-main', // F-S07: own-org record
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-02T00:00:00Z',
            language: 'en',
        };
        const n = await adapter.getNode('n3');
        assert.ok(n);
        assert.equal(n!.id, 'n3');
        assert.equal(n!.label, 'L');
        assert.equal(n!.language, 'en');
        assert.equal(n!.createdAt, '2026-04-01T00:00:00Z');
    }),

    // Defense-in-depth org guard on the point-get path (tryGet/guardOrg).
    // getNode must never surface a record stamped with a different org_id,
    // bringing it in line with the org_id filter every list/search path applies.
    test('getNode rejects a record stamped with a foreign org_id', async () => {
        const { adapter, client } = buildAdapter({ orgId: 'org-main' });
        client.responses['get'] = {
            id: 'n4', type: 'note', label: 'L', content: 'C', tags: 't',
            project: 'p', ecosystem: 'e', org_id: 'org-other',
            created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-02T00:00:00Z',
        };
        const n = await adapter.getNode('n4');
        assert.equal(n, null, 'a foreign-org record must be treated as not-found');
    }),

    test('getNode allows a same-org record but rejects a record with NO org stamp (F-S07 fail-closed)', async () => {
        const { adapter, client } = buildAdapter({ orgId: 'org-main' });
        client.responses['get'] = {
            id: 'n5', type: 'note', label: 'OK', content: 'C', tags: 't',
            project: 'p', ecosystem: 'e', org_id: 'org-main',
            created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-02T00:00:00Z',
        };
        assert.equal((await adapter.getNode('n5'))!.id, 'n5');
        // F-S07 — a record with a MISSING org_id is now treated as not-found
        // (fail closed). Previously such an un-stamped row resolved for any
        // tenant — a cross-tenant read of legacy/un-stamped data. Every write
        // path stamps org_id, so a missing org_id is anomalous and must not surface.
        client.responses['get'] = {
            id: 'n6', type: 'note', label: 'Legacy', content: 'C', tags: 't',
            project: 'p', ecosystem: 'e', // no org_id — must NOT resolve under F-S07
            created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-02T00:00:00Z',
        };
        assert.equal(await adapter.getNode('n6'), null, 'a record without org_id must be treated as not-found');
    }),

    test('deleteNode reports truthy only when row actually deleted', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['deleteByQuery'] = { deleted: 1 };
        assert.equal(await adapter.deleteNode('n4'), true);
        client.responses['deleteByQuery'] = { deleted: 0 };
        assert.equal(await adapter.deleteNode('nope'), false);
    }),

    test('addEdge writes lore_edge row AND attempts graph.createEdge', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['insert'] = {};
        client.responses['graph.createEdge'] = { edge_id: 'e1' };
        await adapter.addEdge({ sourceId: 'a', targetId: 'b', relation: 'related_to' });
        const insertCall = client.calls.find((c) => c.method === 'insert');
        assert.ok(insertCall, 'expected edge insert');
        const row = insertCall!.args[2] as Record<string, unknown>;
        assert.equal(row['source_id'], 'a');
        assert.equal(row['target_id'], 'b');
        assert.equal(row['relation'], 'related_to');
        assert.equal(row['org_id'], 'org-main');
        assert.ok(client.calls.some((c) => c.method === 'graph.createEdge'));
    }),

    test('addEdge tolerates 501 from connectors without graph support', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['insert'] = {};
        client.throws['graph.createEdge'] = new Error('501 not supported');
        // Must not throw.
        await adapter.addEdge({ sourceId: 'a', targetId: 'b', relation: 'rel' });
        // But non-501 errors still bubble.
        client.throws['graph.createEdge'] = new Error('boom 500');
        let threw = false;
        try {
            await adapter.addEdge({ sourceId: 'c', targetId: 'd', relation: 'rel' });
        } catch { threw = true; }
        assert.ok(threw, 'expected non-501 graph error to propagate');
    }),

    test('addBidirectionalEdge writes both directions', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['insert'] = {};
        client.responses['graph.createEdge'] = { edge_id: 'e' };
        await adapter.addBidirectionalEdge({ sourceId: 'a', targetId: 'b', relation: 'peer' });
        const inserts = client.calls.filter((c) => c.method === 'insert');
        assert.equal(inserts.length, 2);
        const row0 = inserts[0]!.args[2] as Record<string, unknown>;
        const row1 = inserts[1]!.args[2] as Record<string, unknown>;
        assert.equal(row0['source_id'], 'a');
        assert.equal(row1['source_id'], 'b');
    }),

    test('traverse returns [] when connector lacks graph', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['graph.traverse'] = new Error('501 not supported');
        const out = await adapter.traverse('start');
        assert.deepEqual(out, []);
    }),

    test('traverse maps records to TraversalResult', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['graph.traverse'] = {
            records: [
                { id: 'n2', type: 'note', label: 'L2', relation: 'related_to' },
                { id: 'n3', type: 'note', label: 'L3', relation: 'cites' },
            ],
        };
        const out = await adapter.traverse('n1', 2);
        assert.equal(out.length, 2);
        assert.equal(out[0]!.node.id, 'n2');
        assert.equal(out[0]!.relation, 'related_to');
    }),

    // SEARCH_CONTRACT v1: traverse must report TRUE per-node depth, never
    // hardcode to 1. When the engine annotates records with a depth field we
    // honor it and sort by depth ascending so closer neighbours come first.
    test('traverse reports true per-node depth and sorts ascending', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['graph.traverse'] = {
            records: [
                { id: 'far', type: 'note', label: 'F', relation: 'r', _depth: 3 },
                { id: 'near', type: 'note', label: 'N', relation: 'r', _depth: 1 },
                { id: 'mid', type: 'note', label: 'M', relation: 'r', _depth: 2 },
            ],
        };
        const out = await adapter.traverse('seed', 3);
        assert.deepEqual(out.map((t) => t.node.id), ['near', 'mid', 'far'], 'sorted by depth asc');
        assert.deepEqual(out.map((t) => t.depth), [1, 2, 3], 'true depth preserved, not hardcoded to 1');
    }),

    // CONTRACT-DEVIATION: when the connector exposes NO depth field, the
    // adapter must NOT mislabel every node depth=1; it returns the explicit
    // depth-unknown sentinel (0) so the gap is detectable.
    test('traverse uses depth-unknown sentinel (0) when SDK omits depth', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['graph.traverse'] = {
            records: [
                { id: 'a', type: 'note', label: 'A', relation: 'r' },
                { id: 'b', type: 'note', label: 'B', relation: 'r' },
            ],
        };
        const out = await adapter.traverse('seed', 2);
        assert.deepEqual(out.map((t) => t.depth), [0, 0], 'no fabricated depth=1');
    }),

    // SEARCH_CONTRACT v1: relation filter is an exact (case-sensitive) match;
    // the SDK has no relation predicate so the adapter post-filters records.
    test('traverse applies exact relation filter', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['graph.traverse'] = {
            records: [
                { id: 'a', type: 'note', label: 'A', relation: 'cites', _depth: 1 },
                { id: 'b', type: 'note', label: 'B', relation: 'related_to', _depth: 1 },
            ],
        };
        const out = await adapter.traverse('seed', 2, 'cites');
        assert.deepEqual(out.map((t) => t.node.id), ['a'], 'only exact relation matches survive');
    }),

    // SEARCH_CONTRACT v1: org_id (ReBAC partition) + scope filters are always
    // present on the candidate scan; the keyword surface is applied in-adapter.
    test('search carries org_id + scope filters (no label-only predicate)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = { records: [{ id: 'x', type: 'note', label: 'Lx hello' }] };
        await adapter.search('hello', 5, 'proj', 'eco');
        const q = client.calls.find((c) => c.method === 'query')!;
        const opts = q.args[2] as { filter: Record<string, unknown>; limit: number };
        assert.equal(opts.filter['org_id'], 'org-main', 'org_id partition guard intact');
        assert.equal(opts.filter['project'], 'proj');
        assert.equal(opts.filter['ecosystem'], 'eco');
        // label_contains is no longer pushed down — matching is over the full
        // contracted surface (label OR content OR tags) in-adapter.
        assert.ok(!('label_contains' in opts.filter), 'label-only predicate removed');
    }),

    // SEARCH_CONTRACT v1: a node matches if the query appears in content or
    // tags, not just label. The label-only path used to drop these.
    test('search matches content and tags, not just label', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = {
            records: [
                { id: 'by-label', type: 'note', label: 'needle here', content: '', tags: '' },
                { id: 'by-content', type: 'note', label: 'unrelated', content: 'a needle in content', tags: '' },
                { id: 'by-tags', type: 'note', label: 'unrelated', content: '', tags: 'needle,x' },
                { id: 'no-match', type: 'note', label: 'nope', content: 'nope', tags: 'nope' },
            ],
        };
        const out = await adapter.search('needle', 10);
        const ids = out.map((n) => n.id);
        assert.ok(ids.includes('by-content'), 'content match surfaced');
        assert.ok(ids.includes('by-tags'), 'tags match surfaced');
        assert.ok(!ids.includes('no-match'), 'non-match dropped');
    }),

    // SEARCH_CONTRACT v1: ordering is relevance desc (label > content > tags,
    // multi-field bonus) then updatedAt desc as tie-break.
    test('search orders by relevance desc then updatedAt desc', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = {
            records: [
                { id: 'tags-only', type: 'note', label: 'x', content: 'x', tags: 'needle', updated_at: '2020-01-01' },
                { id: 'label-and-content', type: 'note', label: 'needle', content: 'needle', tags: '', updated_at: '2020-01-01' },
                { id: 'label-older', type: 'note', label: 'a needle', content: '', tags: '', updated_at: '2019-01-01' },
                { id: 'label-newer', type: 'note', label: 'the needle', content: '', tags: '', updated_at: '2021-01-01' },
            ],
        };
        const out = await adapter.search('needle', 10);
        // label+content (score 6) > single label (score 4) > tags-only (score 1).
        // Within the two single-label nodes, newer updatedAt wins.
        assert.deepEqual(
            out.map((n) => n.id),
            ['label-and-content', 'label-newer', 'label-older', 'tags-only'],
        );
    }),

    // Case-insensitive substring per contract.
    test('search is case-insensitive across the match surface', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = {
            records: [{ id: 'm', type: 'note', label: 'The NEEDLE', content: '', tags: '' }],
        };
        const out = await adapter.search('needle', 10);
        assert.deepEqual(out.map((n) => n.id), ['m']);
    }),

    // Limit is enforced AFTER ranking (contract: at most `limit` results).
    test('search enforces limit after ranking', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = {
            records: [
                { id: 'a', type: 'note', label: 'needle', content: 'needle', tags: 'needle', updated_at: '2021' },
                { id: 'b', type: 'note', label: 'needle', content: '', tags: '', updated_at: '2020' },
                { id: 'c', type: 'note', label: '', content: 'needle', tags: '', updated_at: '2019' },
            ],
        };
        const out = await adapter.search('needle', 2);
        assert.equal(out.length, 2, 'never returns more than limit');
        assert.equal(out[0]!.id, 'a', 'highest relevance first');
    }),

    test('listNodes filter includes tag substring match', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = { records: [] };
        await adapter.listNodes('note', 'urgent', 'proj', 'eco');
        const q = client.calls.find((c) => c.method === 'query')!;
        const opts = q.args[2] as { filter: Record<string, unknown> };
        assert.equal(opts.filter['type'], 'note');
        assert.equal(opts.filter['tags_contains'], 'urgent');
    }),

    test('getStats collects counts for both collections', async () => {
        const { adapter, client } = buildAdapter();
        let call = 0;
        client.responses['count'] = (..._args: unknown[]) => {
            call++;
            return call === 1 ? 42 : 17;
        };
        const stats = await adapter.getStats();
        assert.equal(stats.nodeCount, 42);
        assert.equal(stats.edgeCount, 17);
        assert.deepEqual(stats.typeBreakdown, {});
        assert.ok(!('pluginStats' in stats), 'pluginStats field must not exist');
    }),

    test('getStats survives count errors (per-collection)', async () => {
        const { adapter, client } = buildAdapter();
        client.throws['count'] = new Error('connector down');
        const stats = await adapter.getStats();
        assert.equal(stats.nodeCount, 0);
        assert.equal(stats.edgeCount, 0);
    }),

    test('getTopology shapes nodes + edges for graph viz', async () => {
        const { adapter, client } = buildAdapter();
        let q = 0;
        client.responses['query'] = (..._args: unknown[]) => {
            q++;
            return q === 1
                ? { records: [{ id: 'n1', type: 'note', label: 'L' }] }
                : { records: [{ id: 'e1', source_id: 'n1', target_id: 'n2', relation: 'r' }] };
        };
        const topo = await adapter.getTopology(50);
        assert.equal(topo.nodes.length, 1);
        assert.equal(topo.edges.length, 1);
        const e = topo.edges[0] as { source: string; target: string; relation: string };
        assert.equal(e.source, 'n1');
        assert.equal(e.target, 'n2');
    }),

    test('getGraphContext refuses graph ops, allows detectLanguage', async () => {
        const { adapter } = buildAdapter();
        const ctx = adapter.getGraphContext();
        let threw = false;
        try { await ctx.executeQuery('RETURN 1'); } catch { threw = true; }
        assert.ok(threw, 'executeQuery must refuse in cloud mode');
        threw = false;
        try { await ctx.queryRows('MATCH (n) RETURN n'); } catch { threw = true; }
        assert.ok(threw, 'queryRows must refuse in cloud mode');
        // bumpEpoch is a no-op (no throw).
        ctx.bumpEpoch();
        // detectLanguage delegates to core detector (pure function).
        const det = ctx.detectLanguage('Hello there, this is an English sentence for testing.');
        assert.ok(det !== null && typeof det === 'object');
        assert.ok('language' in det && 'confidence' in det);
    }),

    test('getLanguageBreakdown groups by language (with _unknown bucket)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        let calls = 0;
        client.responses['query'] = (() => {
            calls++;
            // First page: 3 records (en, ja, null/empty). Second page: empty
            // (signals scan complete by returning fewer than `limit`).
            if (calls === 1) return {
                records: [
                    { language: 'en' },
                    { language: 'ja' },
                    { language: '' },
                ],
                has_more: false,
            };
            return { records: [], has_more: false };
        }) as never;
        const b = await adapter.getLanguageBreakdown();
        assert.deepEqual(b, { en: 1, ja: 1, _unknown: 1 });
    }),

    test('getLanguageBreakdown paginates until short page', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        let page = 0;
        client.responses['query'] = ((_t: unknown, _c: unknown, opts: { limit: number; offset: number }) => {
            page++;
            // page 1: full page (500 rows of 'en')
            // page 2: half page (signals end)
            if (page === 1) {
                return { records: new Array(opts.limit).fill({ language: 'en' }), has_more: true };
            }
            return { records: new Array(50).fill({ language: 'ja' }), has_more: false };
        }) as never;
        const b = await adapter.getLanguageBreakdown();
        assert.equal(b.en, 500);
        assert.equal(b.ja, 50);
        assert.equal(page, 2, 'should stop after the short page');
    }),

    test('getTopologyOverview groups by project + totalNodes', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        let called = false;
        client.responses['query'] = (() => {
            if (called) return { records: [], has_more: false };
            called = true;
            return {
                records: [
                    { project: 'lore' },
                    { project: 'lore' },
                    { project: 'def' },
                    { project: '' },  // → '*'
                ],
                has_more: false,
            };
        }) as never;
        const overview = await adapter.getTopologyOverview();
        assert.equal(overview.totalNodes, 4);
        // blobs sorted by count desc
        assert.deepEqual(overview.blobs, [
            { project: 'lore', nodeCount: 2 },
            { project: 'def',  nodeCount: 1 },
            { project: '*',    nodeCount: 1 },
        ]);
        assert.deepEqual(overview.aggregateEdges, [], 'edge aggregation deferred to a later slice');
        assert.equal(overview.truncated, undefined);
    }),

    test('getTopologyOverview projects only the `project` field on the query', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['createCollection'] = {};
        client.responses['query'] = (() => ({ records: [], has_more: false })) as never;
        await adapter.getTopologyOverview();
        const qcall = client.calls.find((c) => c.method === 'query');
        assert.ok(qcall, 'expected a query call');
        const opts = qcall!.args[2] as { fields?: string[]; filter?: Record<string, unknown> };
        assert.deepEqual(opts.fields, ['project'], 'should request only the project column');
        assert.deepEqual(opts.filter, { org_id: 'org-main' });
    }),

    test('tenantProvider is read per-operation (multi-tenant safe)', async () => {
        const client = new FakeClient();
        client.responses['updateByQuery'] = { updated: 0 };
        client.responses['insert'] = {};
        client.responses['get'] = null;
        let current = 'tenant-a';
        const adapter = new DataplaneGraph({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: client as any,
            tenantProvider: () => current,
            orgId: 'org',
        });
        await adapter.upsertNode({ id: 'x', type: 'note', label: 'L', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        current = 'tenant-b';
        await adapter.upsertNode({ id: 'y', type: 'note', label: 'L', content: '', tags: '', project: '*', ecosystem: '*', metadata: '{}' });
        const tenantsSeen = new Set(client.calls.filter((c) => c.method === 'updateByQuery').map((c) => c.args[0]));
        assert.ok(tenantsSeen.has('tenant-a'));
        assert.ok(tenantsSeen.has('tenant-b'));
    }),

    // ── SP-14 — the per-tenant plugin cloud-schema hook fan-out was
    //    removed (setPluginSchemaHooks + PluginCloudSchemaHook). The
    //    plugin system is gone (v3.11.0). This test pins the surviving
    //    behaviour: a first-tenant touch pushes ONLY the two core
    //    collections (lore_node + lore_edge), with no plugin fan-out.
    test("SP-14: first tenant touch pushes only core collections (no plugin schema fan-out)", async () => {
        const { adapter, client } = buildAdapter();
        client.responses["createCollection"] = {};
        client.responses["updateByQuery"] = { updated: 0 };
        client.responses["insert"] = {};
        await adapter.upsertNode({ id: "x", type: "note", label: "L", content: "", tags: "", project: "*", ecosystem: "*", metadata: "{}" });
        const createCalls = client.calls.filter((c) => c.method === "createCollection");
        assert.equal(createCalls.length, 2);
        const names = createCalls.map((c) => (c.args[1] as { name: string }).name).sort();
        assert.deepEqual(names, ["lore_edge", "lore_node"]);
    }),

    test('slice-4: getGraphContext error includes op name + cypher snippet', async () => {
        const { adapter } = buildAdapter();
        const ctx = adapter.getGraphContext();
        const cypher = 'MATCH (n:CodeSymbol) WHERE n.name = "foo" RETURN n.uid, n.filePath LIMIT 10';
        let caught: (Error & { cypher?: string }) | null = null;
        try {
            await ctx.executeQuery(cypher);
        } catch (err) {
            caught = err as Error & { cypher?: string };
        }
        assert.ok(caught, 'executeQuery must throw');
        assert.match(caught!.message, /executeQuery refused/);
        assert.match(caught!.message, /MATCH \(n:CodeSymbol\)/);
        assert.equal(caught!.cypher, cypher, 'err.cypher must preserve full original cypher');
    }),

    /* ── cloud parity: queryEdges / deleteEdge / bulkList (2026-06-09) ── */

    test('queryEdges builds a filtered lore_edge query; maps rows; defaults confidence', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = {
            records: [{ source_id: 'A', target_id: 'B', relation: 'depends_on' }],
        };
        const edges = await adapter.queryEdges({ source: 'A', relation: 'depends_on', limit: 50, offset: 10 });
        // Mapping: snake → camel, confidence/score defaulted (lore_edge rows
        // carry no confidence column — addEdge omits it).
        assert.equal(edges.length, 1);
        assert.equal(edges[0]!.sourceId, 'A');
        assert.equal(edges[0]!.targetId, 'B');
        assert.equal(edges[0]!.relation, 'depends_on');
        assert.equal(edges[0]!.confidence, 'extracted');
        assert.equal(edges[0]!.confidenceScore, 1.0);
        // SDK call shape: query(tenant, 'lore_edge', { filter, limit, offset }, conn).
        const q = client.calls.find((c) => c.method === 'query')!;
        assert.equal(q.args[1], 'lore_edge');
        const opts = q.args[2] as { filter: Record<string, unknown>; limit: number; offset: number };
        assert.equal(opts.filter['org_id'], 'org-main');
        assert.equal(opts.filter['source_id_eq'], 'A');
        assert.equal(opts.filter['relation_eq'], 'depends_on');
        assert.equal(opts.filter['target_id_eq'], undefined, 'omitted filter axis must not appear');
        assert.equal(opts.limit, 50);
        assert.equal(opts.offset, 10);
    }),

    test('queryEdges returns [] when SDK yields no records', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = { records: [] };
        const edges = await adapter.queryEdges({ limit: 10, offset: 0 });
        assert.deepEqual(edges, []);
    }),

    test('deleteEdge deleteByQuery on the (source,target,relation) triple; returns deleted count', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['deleteByQuery'] = { deleted: 1 };
        const n = await adapter.deleteEdge('A', 'B', 'depends_on');
        assert.equal(n, 1);
        const del = client.calls.find((c) => c.method === 'deleteByQuery')!;
        assert.equal(del.args[1], 'lore_edge');
        assert.deepEqual(del.args[2], { source_id_eq: 'A', target_id_eq: 'B', relation_eq: 'depends_on', org_id: 'org-main' });
    }),

    test('deleteEdge returns 0 on no match (→ route maps to 404)', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['deleteByQuery'] = { deleted: 0 };
        assert.equal(await adapter.deleteEdge('X', 'Y', 'nope'), 0);
    }),

    test('bulkList: limit+1 fetch, sort (updated_at DESC, id ASC), hasMore + nextCursor', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = {
            records: [
                { id: 'a', type: 'decision', label: 'A', updated_at: '2026-06-09T10:00:00Z' },
                { id: 'b', type: 'decision', label: 'B', updated_at: '2026-06-09T09:00:00Z' },
                { id: 'c', type: 'decision', label: 'C', updated_at: '2026-06-09T08:00:00Z' }, // the +1
            ],
        };
        const page = await adapter.bulkList({ limit: 2, project: 'wsX', types: ['decision'] });
        assert.equal(page.nodes.length, 2, 'sliced to limit');
        assert.equal(page.hasMore, true);
        assert.deepEqual(page.nextCursor, { updatedAt: '2026-06-09T09:00:00Z', id: 'b' });
        const q = client.calls.find((c) => c.method === 'query')!;
        assert.equal(q.args[1], 'lore_node');
        const opts = q.args[2] as { filter: Record<string, unknown>; sort: Array<{ field: string; direction: string }>; limit: number };
        assert.equal(opts.limit, 3, 'fetches limit+1');
        assert.equal(opts.filter['project'], 'wsX');
        assert.equal(opts.filter['type'], 'decision');
        assert.deepEqual(opts.sort, [
            { field: 'updated_at', direction: 'desc' },
            { field: 'id', direction: 'asc' },
        ]);
    }),

    test('bulkList: last page → hasMore=false, nextCursor=null; cursor adds updated_at_lt', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = {
            records: [{ id: 'z', type: 'note', label: 'Z', updated_at: '2026-06-09T07:00:00Z' }],
        };
        const page = await adapter.bulkList({
            limit: 5,
            cursor: { updatedAt: '2026-06-09T08:00:00Z', id: 'y' },
        });
        assert.equal(page.hasMore, false);
        assert.equal(page.nextCursor, null);
        const q = client.calls.find((c) => c.method === 'query')!;
        const opts = q.args[2] as { filter: Record<string, unknown> };
        assert.equal(opts.filter['updated_at_lt'], '2026-06-09T08:00:00Z', 'cursor → strict updated_at_lt (Slice-1)');
    }),

    /* ── maintenance cluster extracted to dataplaneGraphMaintenance.ts (2026-06-09) ── */

    test('supersedeNode: validates both nodes then updateByQuery sets the three fields', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['get'] = { id: 'x', org_id: 'org-main' }; // F-S07: own-org record          // tryGet(old) + tryGet(new) both exist
        client.responses['updateByQuery'] = { updated: 1 };
        const r = await adapter.supersedeNode('old', 'new', 'better');
        assert.deepEqual(r, { ok: true });
        const upd = client.calls.find((c) => c.method === 'updateByQuery')!;
        assert.equal(upd.args[1], 'lore_node');
        assert.deepEqual(upd.args[2], { id_eq: 'old', org_id: 'org-main' });
        const fields = upd.args[3] as Record<string, unknown>;
        assert.equal(fields['supersededBy'], 'new');
        assert.equal(fields['supersededReason'], 'better');
        assert.ok(typeof fields['supersededAt'] === 'string' && (fields['supersededAt'] as string).length > 0);
    }),

    test('supersedeNode: self → {ok:false,reason:self} with no client calls', async () => {
        const { adapter, client } = buildAdapter();
        const r = await adapter.supersedeNode('a', 'a');
        assert.deepEqual(r, { ok: false, reason: 'self' });
        assert.equal(client.calls.length, 0, 'self-supersede must short-circuit before any SDK call');
    }),

    test('supersedeNode: old-not-found / new-not-found guard branches', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['get'] = null;                 // tryGet(old) → null
        assert.deepEqual(await adapter.supersedeNode('ghost', 'new'), { ok: false, reason: 'old-not-found' });
        // old exists, new missing
        client.responses['get'] = (_t: unknown, _c: unknown, id: unknown) => (id === 'old' ? { id: 'old', org_id: 'org-main' } : null);
        assert.deepEqual(await adapter.supersedeNode('old', 'ghost'), { ok: false, reason: 'new-not-found' });
    }),

    test('unsupersedeNode: clears fields; returns updated>0', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['get'] = { id: 'x', org_id: 'org-main' }; // F-S07: own-org record
        client.responses['updateByQuery'] = { updated: 1 };
        assert.equal(await adapter.unsupersedeNode('x'), true);
        const upd = client.calls.find((c) => c.method === 'updateByQuery')!;
        assert.deepEqual(upd.args[3], { supersededBy: '', supersededAt: '', supersededReason: '' });
        // missing node → false, no update
        const fresh = buildAdapter();
        fresh.client.responses['get'] = null;
        assert.equal(await fresh.adapter.unsupersedeNode('ghost'), false);
    }),

    test('markStaleByTags: dedups ids across tags, one update per unique id', async () => {
        const { adapter, client } = buildAdapter();
        // both tag-queries return overlapping ids → dedup to {n1,n2}
        client.responses['query'] = { records: [{ id: 'n1' }, { id: 'n2' }] };
        client.responses['updateByQuery'] = { updated: 1 };
        const marked = await adapter.markStaleByTags(['stale', 'old']);
        assert.equal(marked, 2, 'two unique nodes marked');
        const updates = client.calls.filter((c) => c.method === 'updateByQuery');
        assert.equal(updates.length, 2);
        assert.deepEqual(updates[0]!.args[3], { stale: true });
        // empty / whitespace tags → 0, no calls
        const fresh = buildAdapter();
        assert.equal(await fresh.adapter.markStaleByTags(['  ']), 0);
    }),

    test('pruneEphemeralNodes: deletes only TTL-expired rows (JS-side expiry)', async () => {
        const { adapter, client } = buildAdapter();
        const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        const now = new Date().toISOString();
        client.responses['query'] = { records: [
            { id: 'expired', created_at: twoHoursAgo },   // > 1h default TTL → delete
            { id: 'fresh', created_at: now },             // within TTL → keep
        ] };
        client.responses['deleteByQuery'] = { deleted: 1 };
        const deleted = await adapter.pruneEphemeralNodes(); // default 1h TTL
        assert.equal(deleted, 1, 'only the expired node is pruned');
        const del = client.calls.find((c) => c.method === 'deleteByQuery')!;
        assert.deepEqual(del.args[2], { id_eq: 'expired', org_id: 'org-main' });
    }),

    test('pruneInferredLoreEdges: JS-side prefix filter → deleteByQuery on matches only', async () => {
        const { adapter, client } = buildAdapter();
        client.responses['query'] = { records: [
            { id: 'e1', relation: 'semantic_neighbor:x' }, // matches prefix
            { id: 'e2', relation: 'depends_on' },          // no match
        ] };
        client.responses['deleteByQuery'] = { deleted: 1 };
        const deleted = await adapter.pruneInferredLoreEdges('semantic_neighbor');
        assert.equal(deleted, 1);
        const del = client.calls.find((c) => c.method === 'deleteByQuery')!;
        assert.equal(del.args[1], 'lore_edge');
        assert.deepEqual(del.args[2], { id_eq: 'e1', org_id: 'org-main' });
    }),
];

async function main(): Promise<void> {
    console.log('Q2.2 — DataplaneGraph unit tests');
    console.log('='.repeat(60));
    for (const t of tests) await t();
    console.log('');
    console.log(`all ${tests.length} DataplaneGraph unit tests passed ✓`);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});

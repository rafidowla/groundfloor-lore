#!/usr/bin/env tsx
/**
 * 15-lorestorageclient-facade-unit.ts — Sprint 15 facade unit tests.
 *
 * Asserts:
 *   A. Construction
 *      - fromLocal(graph, verbatim) builds a facade in local mode
 *      - fromDataplane({ graph, verbatim, sdk }) builds a facade in cloud mode
 *      - getMode() reports the right backend
 *   B. Routing — local mode
 *      - Each of the 14 wrapped methods delegates to the right underlying
 *        substrate with the right positional arguments. We use a hand-
 *        rolled "spy" substrate to record the calls.
 *   C. Cloud-mode routing (W4-CLOUD-FACADE-ROUTING)
 *      - fromDataplane({ graph, verbatim, sdk }) builds a switchable cloud
 *        facade over the real DataplaneGraph / DataplaneVectorStore adapters
 *        (constructed against an in-memory mock Dataplane).
 *      - A read method (listNodes) DELEGATES to the cloud adapter and returns
 *        a value instead of throwing CloudModeNotImplementedError — proving
 *        "switch to cloud" works end-to-end through the unified contract.
 *      - rawGraph()/rawVerbatim() expose the cloud handles, not throw.
 *   D. Cross-sprint sentinels preserved through the facade
 *      - Sprint L workspace_required: the facade is a thin pass-through —
 *        listNodes/search forward project+ecosystem unchanged
 *      - Sprint O outbox-first: the facade does NOT add a write path; it
 *        delegates to the substrate which still runs outbox-first.
 *        Verified by asserting upsertNode + verbatimStore + addEdge call
 *        the underlying substrate exactly once with the exact arg shape
 *        (no transform, no bypass).
 *
 * Strategy: no real Kùzu/LanceDB; substrate is a recording stub matching
 * the surface area the facade touches. This isolates "does the facade
 * route correctly" from "does the substrate work" (covered elsewhere).
 */

import assert from 'node:assert/strict';
import {
    LoreStorageClient,
    CloudModeNotImplementedError,
} from '../packages/lore/src/storage/loreStorageClient.js';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => void | Promise<void>) => {
    const wrap = async () => {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (e) {
            console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
            failed++;
        }
    };
    return wrap();
};

console.log('Sprint 15 — LoreStorageClient facade unit');

/* ─── Recording substrate stubs ──────────────────────────────────── */

type Call = { method: string; args: unknown[] };

function makeGraphStub() {
    const calls: Call[] = [];
    const rec = (m: string) => async (...args: unknown[]) => {
        calls.push({ method: m, args });
        // canned return shapes the facade callers expect
        if (m === 'upsertNode') return { id: 'lore:x', type: 'decision', label: 'l', content: 'c', tags: [], project: 'p', ecosystem: 'e', createdAt: 't', updatedAt: 't' };
        if (m === 'getNode') return null;
        if (m === 'listNodes') return [];
        if (m === 'search') return [];
        if (m === 'addEdge') return undefined;
        if (m === 'getStats') return { nodeCount: 0, edgeCount: 0 };
        if (m === 'getTopology') return { nodes: [], edges: [] };
        if (m === 'supersedeNode') return { ok: true };
        if (m === 'markStaleByTags') return 0;
        if (m === 'unsupersedeNode') return true;
        if (m === 'pruneEphemeralNodes') return 0;
        if (m === 'pruneInferredLoreEdges') return 0;
        return undefined;
    };
    return {
        calls,
        // 9 graph methods the facade wraps
        upsertNode: rec('upsertNode'),
        getNode: rec('getNode'),
        listNodes: rec('listNodes'),
        search: rec('search'),
        addEdge: rec('addEdge'),
        getStats: rec('getStats'),
        getTopology: rec('getTopology'),
        supersedeNode: rec('supersedeNode'),
        markStaleByTags: rec('markStaleByTags'),
        // Sprint 16 — remaining destructive ops
        unsupersedeNode: rec('unsupersedeNode'),
        pruneEphemeralNodes: rec('pruneEphemeralNodes'),
        pruneInferredLoreEdges: rec('pruneInferredLoreEdges'),
    };
}

function makeVerbatimStub() {
    const calls: Call[] = [];
    const rec = (m: string) => async (...args: unknown[]) => {
        calls.push({ method: m, args });
        if (m === 'count') return 0;
        if (m === 'search' || m === 'bm25Search') return [];
        return undefined;
    };
    return {
        calls,
        store: rec('store'),
        search: rec('search'),
        count: rec('count'),
        delete: rec('delete'),
        bm25Search: rec('bm25Search'),
    };
}

/* ─── Cloud-mode harness (W4-CLOUD-FACADE-ROUTING) ────────────────── */

/**
 * Tiny deterministic embedding provider — the facade cloud-mode tests only
 * need DataplaneVectorStore to *construct* and to be reachable; they don't
 * exercise similarity quality. Avoids loading the heavy local ONNX model.
 */
const stubEmbedder: EmbeddingProvider = {
    dimension: 4,
    modelId: 'stub-4d',
    async initialize() {},
    async embed() { return [0.1, 0.2, 0.3, 0.4]; },
    async embedQuery() { return [0.1, 0.2, 0.3, 0.4]; },
    async embedDocument() { return [0.1, 0.2, 0.3, 0.4]; },
};

/**
 * FakeSdkClient — recording stub matching the (tenantId, collection, ...)
 * SdkClient shape DataplaneGraph / DataplaneVectorStore call. Mirrors the
 * convention in dataplane-graph-unit.ts: the cloud adapters are driven by a
 * tenant-routing client, not the raw GroundfloorClient (which derives the
 * tenant from the JWT and is wrapped by a routing transport in production).
 * Here we only need to prove the FACADE delegates to the adapter, and that
 * a write/read roundtrips through it — the adapter's own HTTP wiring is
 * covered by dataplane-graph-unit.ts + the cloud e2e.
 */
function makeFakeSdkClient() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const rows = new Map<string, Record<string, unknown>>();
    const rec = (method: string, fn?: (...a: unknown[]) => unknown) =>
        async (...args: unknown[]) => {
            calls.push({ method, args });
            return fn ? fn(...args) : undefined;
        };
    const client = {
        calls,
        createCollection: rec('createCollection', () => ({})),
        // upsertNode path: updateByQuery returns 0 → insert; getNode reads back.
        updateByQuery: rec('updateByQuery', () => ({ updated: 0 })),
        insert: rec('insert', (_t, _c, record) => {
            const r = record as Record<string, unknown>;
            rows.set(String(r['id']), r);
            return r;
        }),
        get: rec('get', (_t, _c, id) => rows.get(String(id)) ?? null),
        query: rec('query', () => ({ records: [], total_count: 0, has_more: false })),
        deleteByQuery: rec('deleteByQuery', () => ({ deleted: 0 })),
        count: rec('count', () => 0),
        delete: rec('delete', () => undefined),
        search: rec('search', () => ({ records: [], total_count: 0, has_more: false })),
        graph: {
            createEdge: rec('graph.createEdge', () => ({ edge_id: 'e1' })),
            traverse: rec('graph.traverse', () => ({ records: [] })),
        },
    };
    return client;
}

/**
 * Build a cloud-mode facade exactly the way services.ts wires it:
 * DataplaneGraph + DataplaneVectorStore + the SDK handle, all threaded into
 * LoreStorageClient.fromDataplane(...). The adapters front a recording fake
 * SDK client (see makeFakeSdkClient).
 */
function makeCloudFacade() {
    const sdk = makeFakeSdkClient();
    const graph = new DataplaneGraph({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: sdk as any,
        tenantProvider: () => 'tenant-facade-test',
        orgId: 'org-facade-test',
    });
    const verbatim = new DataplaneVectorStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: sdk as any,
        tenantProvider: () => 'tenant-facade-test',
        orgId: 'org-facade-test',
        embeddingProvider: stubEmbedder,
    });
    const client = LoreStorageClient.fromDataplane({
        graph,
        verbatim,
        // The SDK handle is retained on the facade; the adapters are what
        // actually front it. Cast through the public type for the factory.
        sdk: sdk as unknown as GroundfloorClient,
    });
    return { client, graph, verbatim, sdk };
}

/* ─── Section A: construction ────────────────────────────────────── */

await test('fromLocal builds local-mode facade', () => {
    const g = makeGraphStub();
    const v = makeVerbatimStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = LoreStorageClient.fromLocal({ graph: g as any, verbatim: v as any });
    assert.equal(client.getMode(), 'local');
});

await test('fromDataplane builds cloud-mode facade over the dataplane adapters', () => {
    const { client } = makeCloudFacade();
    assert.equal(client.getMode(), 'cloud');
});

/* ─── Section B: routing (14 methods) ────────────────────────────── */

function freshClient() {
    const g = makeGraphStub();
    const v = makeVerbatimStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = LoreStorageClient.fromLocal({ graph: g as any, verbatim: v as any });
    return { client, g, v };
}

await test('(1) upsertNode routes to graph.upsertNode with the same node', async () => {
    const { client, g } = freshClient();
    const node = { id: 'a', type: 'decision', label: 'L', content: 'c', tags: [], project: 'p', ecosystem: 'e' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.upsertNode(node as any);
    assert.equal(g.calls.length, 1);
    assert.equal(g.calls[0]!.method, 'upsertNode');
    assert.deepEqual(g.calls[0]!.args[0], node);
});

await test('(2) getNode routes to graph.getNode with the id', async () => {
    const { client, g } = freshClient();
    await client.getNode('lore:x');
    assert.deepEqual(g.calls, [{ method: 'getNode', args: ['lore:x'] }]);
});

await test('(3) listNodes forwards project + ecosystem (Sprint L workspace_required preserved)', async () => {
    const { client, g } = freshClient();
    await client.listNodes('decision', 'auth', 'my-workspace', 'lore', 50);
    // SW-18: facade also forwards the optional `opts` (unbounded) param (undefined here).
    assert.deepEqual(g.calls[0]!.args, ['decision', 'auth', 'my-workspace', 'lore', 50, undefined]);
});

await test('(4) search forwards query + scoping unchanged', async () => {
    const { client, g } = freshClient();
    await client.search('jwt', 5, 'my-workspace', 'lore');
    assert.deepEqual(g.calls[0]!.args, ['jwt', 5, 'my-workspace', 'lore']);
});

await test('(5) addEdge routes to graph.addEdge (Sprint O outbox-first preserved by substrate)', async () => {
    const { client, g } = freshClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edge: any = { sourceId: 'a', targetId: 'b', relation: 'r' };
    await client.addEdge(edge);
    assert.equal(g.calls.length, 1);
    assert.equal(g.calls[0]!.method, 'addEdge');
    assert.deepEqual(g.calls[0]!.args[0], edge);
});

await test('(6) getStats forwards projectFilter', async () => {
    const { client, g } = freshClient();
    await client.getStats('my-workspace');
    assert.deepEqual(g.calls[0]!.args, ['my-workspace']);
});

await test('(7) getTopology forwards limit + projects + edgeLimit', async () => {
    const { client, g } = freshClient();
    await client.getTopology(123, ['p1', 'p2'], 99);
    assert.deepEqual(g.calls[0]!.args, [123, ['p1', 'p2'], 99]);
});

await test('(8) supersedeNode forwards oldId/newId/reason', async () => {
    const { client, g } = freshClient();
    await client.supersedeNode('old', 'new', 'why');
    assert.deepEqual(g.calls[0]!.args, ['old', 'new', 'why']);
});

await test('(9) markStaleByTags forwards tags array', async () => {
    const { client, g } = freshClient();
    await client.markStaleByTags(['t1', 't2']);
    assert.deepEqual(g.calls[0]!.args, [['t1', 't2']]);
});

/* ─── Sprint 16: 3 remaining destructive ops ─────────────────────── */

await test('(9a) unsupersedeNode routes through facade', async () => {
    const { client, g } = freshClient();
    const ok = await client.unsupersedeNode('lore:n1');
    assert.equal(ok, true);
    assert.deepEqual(g.calls[0]!.args, ['lore:n1']);
    assert.equal(g.calls[0]!.method, 'unsupersedeNode');
});

await test('(9b) pruneEphemeralNodes forwards ttl (defaults to 1h)', async () => {
    const { client, g } = freshClient();
    await client.pruneEphemeralNodes();
    assert.deepEqual(g.calls[0]!.args, [3_600_000]);
    const c2 = freshClient();
    await c2.client.pruneEphemeralNodes(60_000);
    assert.deepEqual(c2.g.calls[0]!.args, [60_000]);
});

await test('(9c) pruneInferredLoreEdges forwards relationPrefix', async () => {
    const { client, g } = freshClient();
    await client.pruneInferredLoreEdges('inferred:');
    assert.deepEqual(g.calls[0]!.args, ['inferred:']);
});

await test('(10) verbatimStore routes to verbatim.store (Sprint O write path preserved)', async () => {
    const { client, v } = freshClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = { id: 'd1', content: 'hello', metadata: {} };
    await client.verbatimStore(doc);
    assert.equal(v.calls.length, 1);
    assert.equal(v.calls[0]!.method, 'store');
    assert.deepEqual(v.calls[0]!.args[0], doc);
});

await test('(11) verbatimSearch forwards full positional arg list', async () => {
    const { client, v } = freshClient();
    await client.verbatimSearch('q', 7, { project: 'p' }, { includeHistory: true }, ['scope:a']);
    assert.deepEqual(v.calls[0]!.args, ['q', 7, { project: 'p' }, { includeHistory: true }, ['scope:a']]);
});

await test('(12) verbatimCount routes to verbatim.count', async () => {
    const { client, v } = freshClient();
    const n = await client.verbatimCount();
    assert.equal(n, 0);
    assert.equal(v.calls[0]!.method, 'count');
});

await test('(13) verbatimDelete forwards id', async () => {
    const { client, v } = freshClient();
    await client.verbatimDelete('lore:x');
    assert.deepEqual(v.calls[0]!.args, ['lore:x']);
});

await test('(14) verbatimBm25Search forwards query + limit + filter + scopes', async () => {
    const { client, v } = freshClient();
    await client.verbatimBm25Search('jwt', 4, { project: 'p' }, ['scope:a']);
    assert.deepEqual(v.calls[0]!.args, ['jwt', 4, { project: 'p' }, ['scope:a']]);
});

/* ─── Section C: cloud-mode routing (W4-CLOUD-FACADE-ROUTING) ─────── */

// The blanket CloudModeNotImplementedError stub is GONE. Cloud mode now
// routes through the DataplaneGraph / DataplaneVectorStore adapters via the
// unified contract. These tests prove the facade DELEGATES rather than throws.

await test('cloud-mode listNodes DELEGATES to DataplaneGraph (no CloudModeNotImplementedError)', async () => {
    const { client, sdk } = makeCloudFacade();
    // The point: it routes to the adapter (which hits the SDK client) and
    // returns an array — it does NOT throw CloudModeNotImplementedError.
    const rows = await client.listNodes('decision', undefined, 'p', 'e', 10);
    assert.ok(Array.isArray(rows), 'cloud listNodes should return an array via the adapter');
    assert.ok(
        sdk.calls.some((c) => c.method === 'query'),
        'cloud listNodes must reach the dataplane adapter (SDK query call)',
    );
});

await test('cloud-mode upsertNode + getNode roundtrip through the dataplane adapter', async () => {
    const { client, sdk } = makeCloudFacade();
    const node = {
        id: 'lore:cloud-1', type: 'decision', label: 'Cloud node',
        content: 'c', tags: ['t'], project: 'p', ecosystem: 'e',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.upsertNode(node as any);
    const got = await client.getNode('lore:cloud-1');
    assert.ok(got, 'cloud getNode should retrieve the node the adapter just wrote');
    assert.equal(got!.id, 'lore:cloud-1');
    assert.ok(
        sdk.calls.some((c) => c.method === 'insert'),
        'cloud upsertNode must reach the dataplane adapter (SDK insert call)',
    );
});

await test('cloud-mode verbatimCount DELEGATES to DataplaneVectorStore', async () => {
    const { client } = makeCloudFacade();
    const n = await client.verbatimCount();
    assert.equal(typeof n, 'number', 'cloud verbatimCount should return a number via the adapter');
});

await test('cloud-mode rawGraph / rawVerbatim expose the dataplane handles (no throw)', () => {
    const { client, graph, verbatim } = makeCloudFacade();
    assert.equal(client.rawGraph(), graph);
    assert.equal(client.rawVerbatim(), verbatim);
});

// CloudModeNotImplementedError is still imported + exercised by the
// mis-constructed-facade guard below; reference it here so the no-throw
// intent of the cloud-mode suite is explicit and the import stays used.
void CloudModeNotImplementedError;

await test('mis-constructed facade (no handle) throws a clear non-cloud error', () => {
    // Defensive guard: g()/v() with a null handle is a construction bug,
    // surfaced as a plain Error (NOT CloudModeNotImplementedError, which is
    // now reserved for genuine per-connector unsupported ops).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken = (LoreStorageClient as any).fromDataplane({ graph: null, verbatim: null, sdk: {} });
    assert.throws(() => broken.rawGraph(), (e: unknown) =>
        e instanceof Error && !(e instanceof CloudModeNotImplementedError));
});

/* ─── Section D: cross-sprint sentinels ──────────────────────────── */

await test('Sprint O: facade adds NO write path bypass — each write delegates exactly once', async () => {
    const { client, g, v } = freshClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.upsertNode({ id: 'n1' } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.addEdge({ sourceId: 'a', targetId: 'b', relation: 'r' } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.verbatimStore({ id: 'd1', content: 'c', metadata: {} } as any);
    // 2 graph writes (upsert + addEdge), 1 verbatim write — no extras.
    assert.equal(g.calls.length, 2);
    assert.equal(v.calls.length, 1);
    assert.equal(g.calls[0]!.method, 'upsertNode');
    assert.equal(g.calls[1]!.method, 'addEdge');
    assert.equal(v.calls[0]!.method, 'store');
});

await test('Sprint L: workspace scoping is NOT swallowed by the facade', async () => {
    const { client, g } = freshClient();
    await client.search('q', 10, 'workspace-A', 'eco');
    await client.listNodes(undefined, undefined, 'workspace-B', '*');
    // Both calls forward the workspace + ecosystem param verbatim.
    assert.equal(g.calls[0]!.args[2], 'workspace-A');
    assert.equal(g.calls[0]!.args[3], 'eco');
    assert.equal(g.calls[1]!.args[2], 'workspace-B');
    assert.equal(g.calls[1]!.args[3], '*');
});

await test('rawGraph + rawVerbatim escape hatches expose the underlying handles', () => {
    const { client, g, v } = freshClient();
    assert.equal(client.rawGraph(), g);
    assert.equal(client.rawVerbatim(), v);
});

// (W4-CLOUD-FACADE-ROUTING) The former "rawGraph throws in cloud mode" test
// was removed: cloud mode now returns the live DataplaneGraph /
// DataplaneVectorStore handles. See the Section C cloud-mode routing tests
// above, which assert delegation over the mock Dataplane.

setTimeout(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}, 200);

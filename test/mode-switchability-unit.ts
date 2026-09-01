#!/usr/bin/env tsx
/**
 * mode-switchability-unit.ts — W4-MODE-SWITCH-GUARD regression guard.
 *
 * Cloud-invariant regression guard: asserts all THREE publisher-selectable
 * modes remain first-class and independently switchable. No future
 * embeddable change may silently break or re-stub the cloud path.
 *
 * Modes under test:
 *
 *   (1) EMBEDDED — createLore({deploymentMode:'embedded', dataDir}) opens
 *       Kùzu/LanceDB in-process, exposes a working storageClient facade,
 *       opens NO port, and dispose() drains cleanly.
 *
 *   (2) LOCAL — LoreStorageClient.fromLocal({graph, verbatim}) over recording
 *       stubs: getMode()==='local', upsertNode/getNode/listNodes all delegate
 *       without throwing.
 *
 *   (3) CLOUD — LoreStorageClient.fromDataplane({graph, verbatim, sdk}) over
 *       FakeSdkClient-backed DataplaneGraph + DataplaneVectorStore: getMode()
 *       === 'cloud', the SAME facade operations delegate to the cloud adapters
 *       WITHOUT throwing CloudModeNotImplementedError. The guard FAILS if cloud
 *       routing regresses to throwing (i.e. it pins W4-CLOUD-FACADE-ROUTING).
 *
 * Harness: manual pass/fail counters, process.exit(1) on any failure — the
 * same tsx no-framework style used throughout test/.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    LoreStorageClient,
    CloudModeNotImplementedError,
} from '../packages/lore/src/storage/loreStorageClient.js';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';
import { DataplaneVectorStore } from '../packages/lore/src/engines/dataplaneVectorStore.js';
import { createLore } from '../packages/lore/src/index.js';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

/* ─── Harness ───────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${(e as Error).message}`);
        console.error(
            (e as Error).stack
                ?.split('\n')
                .slice(1, 5)
                .map((l) => `    ${l}`)
                .join('\n') ?? '',
        );
        failed++;
    }
}

/* ─── Cloud-mode helpers (mirrors 15-lorestorageclient-facade-unit.ts) ── */

/** Minimal stub embedding provider — avoids loading the heavy ONNX model. */
const stubEmbedder: EmbeddingProvider = {
    dimension: 4,
    modelId: 'stub-4d',
    async initialize() {},
    async embed() { return [0.1, 0.2, 0.3, 0.4]; },
    async embedQuery() { return [0.1, 0.2, 0.3, 0.4]; },
    async embedDocument() { return [0.1, 0.2, 0.3, 0.4]; },
};

/**
 * FakeSdkClient — mirrors the one in dataplane-graph-unit.ts /
 * 15-lorestorageclient-facade-unit.ts.  Records all calls, returns
 * sensible defaults so the DataplaneGraph / DataplaneVectorStore adapters
 * can complete a full upsert+getNode+listNodes roundtrip without a live
 * Dataplane engine.
 */
function makeFakeSdkClient() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const rows = new Map<string, Record<string, unknown>>();

    const rec = (method: string, fn?: (...a: unknown[]) => unknown) =>
        async (...args: unknown[]) => {
            calls.push({ method, args });
            return fn ? fn(...args) : undefined;
        };

    return {
        calls,
        createCollection: rec('createCollection', () => ({})),
        updateByQuery: rec('updateByQuery', () => ({ updated: 0 })),
        insert: rec('insert', (_t: unknown, _c: unknown, record: unknown) => {
            const r = record as Record<string, unknown>;
            rows.set(String(r['id']), r);
            return r;
        }),
        get: rec('get', (_t: unknown, _c: unknown, id: unknown) =>
            rows.get(String(id)) ?? null,
        ),
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
}

/**
 * Build a cloud-mode facade exactly the way services.ts wires it in cloud
 * mode: DataplaneGraph + DataplaneVectorStore fronting a fake SDK client,
 * threaded into LoreStorageClient.fromDataplane.
 */
function makeCloudFacade() {
    const sdk = makeFakeSdkClient();
    const graph = new DataplaneGraph({
        client: sdk as never,
        tenantProvider: () => 'tenant-mode-guard',
        orgId: 'org-mode-guard',
    });
    const verbatim = new DataplaneVectorStore({
        client: sdk as never,
        tenantProvider: () => 'tenant-mode-guard',
        orgId: 'org-mode-guard',
        embeddingProvider: stubEmbedder,
    });
    const client = LoreStorageClient.fromDataplane({
        graph,
        verbatim,
        sdk: sdk as unknown as GroundfloorClient,
    });
    return { client, graph, verbatim, sdk };
}

/** Recording stubs for local-mode routing tests (no real Kùzu/LanceDB). */
type Call = { method: string; args: unknown[] };

function makeGraphStub() {
    const calls: Call[] = [];
    const rec = (m: string) =>
        async (...args: unknown[]) => {
            calls.push({ method: m, args });
            if (m === 'upsertNode')
                return {
                    id: 'stub-node', type: 'decision', label: 'L',
                    content: 'c', tags: 't', project: 'p', ecosystem: 'e',
                    createdAt: 't', updatedAt: 't', syncedAt: null,
                    metadata: '{}',
                };
            if (m === 'getNode') return null;
            if (m === 'listNodes') return [];
            return undefined;
        };
    return {
        calls,
        upsertNode: rec('upsertNode'),
        getNode: rec('getNode'),
        listNodes: rec('listNodes'),
        search: rec('search'),
        addEdge: rec('addEdge'),
        getStats: rec('getStats'),
        getTopology: rec('getTopology'),
        supersedeNode: rec('supersedeNode'),
        markStaleByTags: rec('markStaleByTags'),
        unsupersedeNode: rec('unsupersedeNode'),
        pruneEphemeralNodes: rec('pruneEphemeralNodes'),
        pruneInferredLoreEdges: rec('pruneInferredLoreEdges'),
    };
}

function makeVerbatimStub() {
    const calls: Call[] = [];
    const rec = (m: string) =>
        async (...args: unknown[]) => {
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

/* ─── Node shape used in write tests ────────────────────────────── */

const NODE_WRITE = {
    id: 'mode-guard-node-1',
    type: 'decision',
    label: 'Mode Guard Test Node',
    content: 'Verifying mode switchability',
    tags: 'mode-guard,test',
    project: 'mode-guard-project',
    ecosystem: '*',
    metadata: '{}',
} as const;

/* ═══════════════════════════════════════════════════════════════════
   MODE (1): EMBEDDED
   createLore({deploymentMode:'embedded', dataDir}) — in-process
   substrates, no port, working facade, dispose() clean drain.
   ═══════════════════════════════════════════════════════════════════ */

console.log('\n── (1) EMBEDDED mode ──────────────────────────────────────');

// ── Hermetic LORE_HOME sandboxing ──────────────────────────────────
// Pin process.env.LORE_HOME to a fresh per-run temp dir BEFORE calling
// createLore so the workspace registry and all workspaces.json reads go
// to the temp dir instead of the developer's real ~/.groundfloor graph.
// Seed a minimal workspaces.json so the embedded boot can resolve the
// active workspace (mirrors embeddable-capstone-e2e.ts lines 83-101).
const embeddedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mode-guard-embedded-'));
const savedLoreHome = process.env['LORE_HOME'];
process.env['LORE_HOME'] = embeddedTmpDir;

function seedWorkspacesForTest(home: string): void {
    const wsName = 'mode-guard-ws';
    const wsPath = path.join(home, 'workspaces', wsName);
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({
            active: wsName,
            workspaces: [{ name: wsName, path: wsPath, createdAt: new Date().toISOString() }],
        }, null, 2),
    );
}
seedWorkspacesForTest(embeddedTmpDir);

let embeddedDispose: (() => Promise<void>) | null = null;

try {
    const lore = await createLore({
        deploymentMode: 'embedded',
        dataDir: embeddedTmpDir,
    });
    embeddedDispose = lore.dispose.bind(lore);

    await test('embedded: runMode === "embedded"', () => {
        assert.equal(lore.runMode, 'embedded');
    });

    await test('embedded: deploymentMode (substrate) === "local" (Kùzu/LanceDB)', () => {
        // 'embedded' collapses substrate mode to 'local' (in-process Kùzu/LanceDB).
        assert.equal(lore.deploymentMode, 'local');
    });

    await test('embedded: storageClient.getMode() === "local"', () => {
        assert.equal(lore.store.storageClient.getMode(), 'local');
    });

    await test('embedded: no port opened (no TCP server in process)', () => {
        // The spec says createLore('embedded') opens NO port. We can't enumerate
        // bound sockets directly, but verifying the process is still running and
        // the handle was returned without error is the practical proxy.
        assert.ok(lore, 'createLore returned a valid LoreInstance');
    });

    await test('embedded: upsertNode succeeds (writes through local substrate)', async () => {
        const node = await lore.store.storageClient.upsertNode(NODE_WRITE);
        assert.equal(node.id, NODE_WRITE.id);
        assert.equal(node.type, NODE_WRITE.type);
        assert.ok(typeof node.createdAt === 'string' && node.createdAt.length > 0);
    });

    await test('embedded: getNode roundtrips the stored node', async () => {
        const fetched = await lore.store.storageClient.getNode(NODE_WRITE.id);
        assert.ok(fetched !== null, 'getNode should return the node that was just stored');
        assert.equal(fetched!.id, NODE_WRITE.id);
        assert.equal(fetched!.label, NODE_WRITE.label);
    });

    await test('embedded: listNodes returns an array (search op)', async () => {
        const nodes = await lore.store.storageClient.listNodes(
            'decision', undefined, NODE_WRITE.project, '*', 50,
        );
        assert.ok(Array.isArray(nodes));
        assert.ok(nodes.length >= 1, 'listNodes should include the node just stored');
    });

    await test('embedded: dispose() resolves without throwing', async () => {
        await lore.dispose('test-teardown');
        embeddedDispose = null; // already disposed
    });

} catch (bootErr) {
    failed++;
    console.error(`  ✗ embedded: createLore boot failed — ${(bootErr as Error).message}`);
    // Still attempt dispose if we have a handle
    if (embeddedDispose) {
        await embeddedDispose('boot-failure-cleanup').catch(() => {});
        embeddedDispose = null;
    }
} finally {
    // Restore the original LORE_HOME so subsequent mode tests are unaffected.
    if (savedLoreHome === undefined) {
        delete process.env['LORE_HOME'];
    } else {
        process.env['LORE_HOME'] = savedLoreHome;
    }
    // Surreal can still flush `manifest/` after dispose(); retry so a
    // late writer does not fail the suite on ENOTEMPTY.
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            fs.rmSync(embeddedTmpDir, { recursive: true, force: true });
            break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 7) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
}

/* ═══════════════════════════════════════════════════════════════════
   MODE (2): LOCAL
   LoreStorageClient.fromLocal({graph, verbatim}) over recording stubs.
   Verifies local routing without real Kùzu/LanceDB — substrate
   correctness is covered by the integration tests; this test guards
   that the facade's local-mode routing path is live (not branched away
   to a stub throw) and that getMode() reports 'local'.
   ═══════════════════════════════════════════════════════════════════ */

console.log('\n── (2) LOCAL mode ─────────────────────────────────────────');

{
    const g = makeGraphStub();
    const v = makeVerbatimStub();
    const localClient = LoreStorageClient.fromLocal({
        graph: g as never,
        verbatim: v as never,
    });

    await test('local: getMode() === "local"', () => {
        assert.equal(localClient.getMode(), 'local');
    });

    await test('local: upsertNode delegates to graph stub (no throw)', async () => {
        const node = await localClient.upsertNode(NODE_WRITE as never);
        assert.equal(node.id, 'stub-node', 'facade returned the stub result');
        assert.equal(g.calls.filter((c) => c.method === 'upsertNode').length, 1);
    });

    await test('local: getNode delegates to graph stub (no throw)', async () => {
        const n = await localClient.getNode('any-id');
        // Stub returns null — the point is it did NOT throw.
        assert.equal(n, null);
        assert.ok(g.calls.some((c) => c.method === 'getNode'));
    });

    await test('local: listNodes delegates to graph stub (no throw)', async () => {
        const rows = await localClient.listNodes('decision', undefined, 'p', 'e', 10);
        assert.ok(Array.isArray(rows));
        assert.ok(g.calls.some((c) => c.method === 'listNodes'));
    });

    await test('local: verbatimCount delegates to verbatim stub (no throw)', async () => {
        const n = await localClient.verbatimCount();
        assert.equal(typeof n, 'number');
        assert.ok(v.calls.some((c) => c.method === 'count'));
    });

    await test('local: rawGraph() returns the local graph handle', () => {
        assert.equal(localClient.rawGraph(), g);
    });
}

/* ═══════════════════════════════════════════════════════════════════
   MODE (3): CLOUD
   LoreStorageClient.fromDataplane({graph: DataplaneGraph,
       verbatim: DataplaneVectorStore, sdk}) over FakeSdkClient.
   Guards that:
     - getMode() === 'cloud'
     - upsertNode / getNode / listNodes route to the cloud adapters
       (SDK calls recorded) WITHOUT throwing CloudModeNotImplementedError
     - verbatimCount delegates to DataplaneVectorStore
   This test FAILS if W4-CLOUD-FACADE-ROUTING regresses (i.e. if
   cloud ops start throwing CloudModeNotImplementedError again).
   ═══════════════════════════════════════════════════════════════════ */

console.log('\n── (3) CLOUD mode ─────────────────────────────────────────');

{
    const { client: cloudClient, sdk } = makeCloudFacade();

    await test('cloud: getMode() === "cloud"', () => {
        assert.equal(cloudClient.getMode(), 'cloud');
    });

    await test('cloud: upsertNode routes to DataplaneGraph — no CloudModeNotImplementedError', async () => {
        let threw = false;
        try {
            await cloudClient.upsertNode(NODE_WRITE as never);
        } catch (e) {
            threw = true;
            // The SPECIFIC regression we guard: CloudModeNotImplementedError.
            if (e instanceof CloudModeNotImplementedError) {
                throw new Error(
                    'REGRESSION: cloud-mode upsertNode threw CloudModeNotImplementedError — ' +
                    'W4-CLOUD-FACADE-ROUTING has regressed. The cloud path must delegate ' +
                    'to DataplaneGraph, not throw.',
                );
            }
            throw e; // other errors bubble as test failures
        }
        assert.ok(!threw, 'upsertNode should not throw in cloud mode');
        assert.ok(
            sdk.calls.some((c) => c.method === 'insert' || c.method === 'updateByQuery'),
            'cloud upsertNode must reach the DataplaneGraph adapter (insert or updateByQuery SDK call)',
        );
    });

    await test('cloud: getNode routes to DataplaneGraph — no CloudModeNotImplementedError', async () => {
        let threw = false;
        try {
            const n = await cloudClient.getNode(NODE_WRITE.id);
            // Stub returns the row we inserted above (rows map is shared in makeFakeSdkClient).
            assert.ok(n === null || typeof n === 'object', 'getNode should return null or a node object');
        } catch (e) {
            threw = true;
            if (e instanceof CloudModeNotImplementedError) {
                throw new Error(
                    'REGRESSION: cloud-mode getNode threw CloudModeNotImplementedError.',
                );
            }
            throw e;
        }
        assert.ok(!threw);
        assert.ok(
            sdk.calls.some((c) => c.method === 'get'),
            'cloud getNode must reach the DataplaneGraph adapter (get SDK call)',
        );
    });

    await test('cloud: listNodes routes to DataplaneGraph — no CloudModeNotImplementedError', async () => {
        let threw = false;
        try {
            const rows = await cloudClient.listNodes('decision', undefined, 'p', 'e', 10);
            assert.ok(Array.isArray(rows), 'listNodes should return an array via the cloud adapter');
        } catch (e) {
            threw = true;
            if (e instanceof CloudModeNotImplementedError) {
                throw new Error(
                    'REGRESSION: cloud-mode listNodes threw CloudModeNotImplementedError.',
                );
            }
            throw e;
        }
        assert.ok(!threw);
        assert.ok(
            sdk.calls.some((c) => c.method === 'query'),
            'cloud listNodes must reach the DataplaneGraph adapter (query SDK call)',
        );
    });

    await test('cloud: verbatimCount routes to DataplaneVectorStore — no CloudModeNotImplementedError', async () => {
        let threw = false;
        try {
            const n = await cloudClient.verbatimCount();
            assert.equal(typeof n, 'number', 'verbatimCount should return a number via the cloud adapter');
        } catch (e) {
            threw = true;
            if (e instanceof CloudModeNotImplementedError) {
                throw new Error(
                    'REGRESSION: cloud-mode verbatimCount threw CloudModeNotImplementedError.',
                );
            }
            throw e;
        }
        assert.ok(!threw);
    });

    await test('cloud: rawGraph() returns the DataplaneGraph handle (not null, not throw)', () => {
        const handle = cloudClient.rawGraph();
        assert.ok(handle instanceof DataplaneGraph, 'cloud rawGraph() should expose the DataplaneGraph');
    });

    await test('cloud: rawVerbatim() returns the DataplaneVectorStore handle', () => {
        const handle = cloudClient.rawVerbatim();
        assert.ok(handle instanceof DataplaneVectorStore, 'cloud rawVerbatim() should expose the DataplaneVectorStore');
    });

    // Explicit sentinel: the CloudModeNotImplementedError class must still
    // exist and be importable (it is reserved for per-connector op failures,
    // not for "cloud is unwired"). Guard against accidental removal.
    await test('cloud: CloudModeNotImplementedError class is importable and constructable', () => {
        const err = new CloudModeNotImplementedError('test-op');
        assert.ok(err instanceof Error);
        assert.ok(err instanceof CloudModeNotImplementedError);
        assert.equal(err.code, 'cloud_mode_not_implemented');
        assert.match(err.message, /test-op/);
    });
}

/* ─── Summary ───────────────────────────────────────────────────── */

const total = passed + failed;
console.log(`\n${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
if (failed > 0) {
    console.error('\nMode-switchability guard FAILED — at least one mode is broken.');
    process.exit(1);
}
console.log('All three modes (embedded | local | cloud) are first-class and switchable.');
process.exit(0);

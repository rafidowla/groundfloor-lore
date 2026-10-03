/**
 * cloud-stores-fixture.ts — shared setup for the cloud-parity scope tests: a mock
 * Dataplane (one credential -> one Dataplane workspace) plus a real DataplaneGraph and
 * DataplaneVectorStore talking to it over HTTP through the fetch-based mock client.
 *
 * The Lore workspace is bound per call with `as(workspaceId, fn)` (AsyncLocalStorage,
 * exactly like production), so two Lore workspaces share ONE Dataplane workspace and
 * the same physical collections — the setup the isolation tests must prove safe.
 */

import { startMockDataplane, type MockDataplane, type MockDataplaneOptions } from './mock-dataplane.js';
import { createMockDataplaneClient } from './mock-dataplane-client.js';
import { DataplaneGraph } from '../../packages/lore/src/engines/dataplaneGraph.js';
import { DataplaneVectorStore } from '../../packages/lore/src/engines/dataplaneVectorStore.js';
import { testRegistry, type TestWorkspaceRegistry } from './workspace-registry.js';
import { runWithWorkspace } from '../../packages/lore/src/security/workspaceContext.js';
import type { EmbeddingProvider } from '../../packages/lore/src/providers/types.js';

export const DP_WORKSPACE = 'dp-ws-fixture';
export const DP_KEY = 'fixture-key';
export const ORG_ID = 'org-fixture';
/**
 * The Dataplane connector the fixture's stores send on EVERY route (review C #1). The mock
 * resolves the connector per route exactly like the engine (sqlite for CRUD/vector, postgresql
 * for keyword search + /v1/transaction, surrealdb for traverse) when none is sent, so a store
 * built without a connection splits its data across three stores. `postgresql` supports
 * /v1/transaction and is one consistent data set.
 */
export const FIXTURE_CONNECTION = 'postgresql';

const DIM = 16;

/** Deterministic bag-of-words embedder: similar text -> similar vectors, no model load. */
export function bagOfWordsEmbedder(): EmbeddingProvider {
    const embed = async (text: string): Promise<number[]> => {
        const v = new Array<number>(DIM).fill(0);
        for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
            let h = 7;
            for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
            v[h % DIM]! += 1;
        }
        return v;
    };
    return {
        modelId: 'fixture/bow',
        dimension: DIM,
        initialize: async () => {},
        embed,
        embedQuery: embed,
        embedDocument: embed,
    } as unknown as EmbeddingProvider;
}

/**
 * A view of the mock client that fills in `connection` when a call leaves it out. It models a test
 * (a "direct writer") talking to the same configured connector as the stores under test; the
 * stores themselves get the PLAIN client and must send the connection on their own.
 */
export function withDefaultConnection(c: ReturnType<typeof createMockDataplaneClient>, conn: string): ReturnType<typeof createMockDataplaneClient> {
    return {
        createCollection: (t, s, k) => c.createCollection(t, s, k ?? conn),
        insert: (t, n, r, k) => c.insert(t, n, r, k ?? conn),
        get: (t, n, i, k) => c.get(t, n, i, k ?? conn),
        query: (t, n, o, k) => c.query(t, n, o, k ?? conn),
        updateByQuery: (t, n, f, u, k) => c.updateByQuery(t, n, f, u, k ?? conn),
        deleteByQuery: (t, n, f, k) => c.deleteByQuery(t, n, f, k ?? conn),
        count: (t, n, f, k) => c.count(t, n, f, k ?? conn),
        getCollectionSchema: (t, n, k) => c.getCollectionSchema(t, n, k ?? conn),
        bulkInsert: (t, n, r, k) => c.bulkInsert(t, n, r, k ?? conn),
        search: (n, q, o) => c.search(n, q, { ...o, connection: o?.connection ?? conn }),
        transaction: (t, ops, o) => c.transaction(t, ops, { ...o, connection: o?.connection ?? conn }),
        vector: { search: (t, n, o) => c.vector.search(t, n, { ...o, connection: o.connection ?? conn }) },
        graph: {
            createEdge: (t, n, o) => c.graph.createEdge(t, n, { ...o, connection: o.connection ?? conn }),
            traverse: (t, n, o) => c.graph.traverse(t, n, { ...o, connection: o.connection ?? conn }),
        },
    };
}

/** A direct mock client on the fixture's connector (see withDefaultConnection). */
export const connectedClient = (url: string, key: string, conn: string = FIXTURE_CONNECTION): ReturnType<typeof createMockDataplaneClient> =>
    withDefaultConnection(createMockDataplaneClient(url, key), conn);

export interface CloudFixture {
    mock: MockDataplane;
    graph: DataplaneGraph;
    vector: DataplaneVectorStore;
    /** The instance's workspace registry; `as()` registers a workspace it binds that is not yet registered (id === name; use `registry.addWithId` first for a distinct id). */
    registry: TestWorkspaceRegistry;
    /** A direct writer on the SAME connector the stores use (e.g. to stage a concurrent insert or a legacy table). */
    rawClient: ReturnType<typeof createMockDataplaneClient>;
    /** Run `fn` with the given Lore workspace bound (ALS). */
    as: <T>(workspaceId: string, fn: () => Promise<T>) => Promise<T>;
    close: () => Promise<void>;
}

export async function startCloudFixture(
    mockOpts: Omit<MockDataplaneOptions, 'apiKeys'> = {},
    extra: { apiKey?: string; /** Connector sent on every route; `null` builds the stores WITHOUT one (engine per-route defaults then apply). */ connection?: string | null; hasCapability?: (c: string) => Promise<boolean | null>; wrapClient?: (c: ReturnType<typeof createMockDataplaneClient>) => ReturnType<typeof createMockDataplaneClient> } = {},
): Promise<CloudFixture> {
    const mock = await startMockDataplane({ ...mockOpts, apiKeys: { [DP_KEY]: DP_WORKSPACE } });
    const raw = createMockDataplaneClient(mock.url, extra.apiKey ?? DP_KEY);
    const client = extra.wrapClient ? extra.wrapClient(raw) : raw; // fault-injection seam (a failing history write)
    const registry = testRegistry();
    const connection = extra.connection === undefined ? FIXTURE_CONNECTION : extra.connection;
    const graph = new DataplaneGraph({
        ...(connection ? { connection } : {}),
        client: client as never,
        dataplaneWorkspaceId: DP_WORKSPACE,
        orgId: ORG_ID,
        workspaceRegistry: registry,
    });
    const vector = new DataplaneVectorStore({
        ...(connection ? { connection } : {}),
        client: client as never,
        dataplaneWorkspaceId: DP_WORKSPACE,
        orgId: ORG_ID,
        workspaceRegistry: registry,
        embeddingProvider: bagOfWordsEmbedder(),
        ...(extra.hasCapability ? { hasCapability: extra.hasCapability } : {}),
    });
    return {
        mock,
        graph,
        vector,
        registry,
        rawClient: connection ? withDefaultConnection(raw, connection) : raw,
        as: (workspaceId, fn) => { if (!registry.has(workspaceId)) registry.add(workspaceId); return runWithWorkspace({ workspaceId }, fn); },
        close: async () => { await vector.close(); await mock.close(); },
    };
}

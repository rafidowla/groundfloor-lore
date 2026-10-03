/**
 * cloudStores.ts — the ONE place the cloud-mode graph + vector store are built
 * (cloud parity A2 item 5).
 *
 * `createGraph`, `createVectorStore` and `maybeUpgradeAdapterFromKeychain` (services.ts)
 * all go through `buildCloudStores`, so the two stores can never be built with different
 * credentials again: previously the keychain upgrade rebuilt only the graph and left the
 * vector store (and its capability probe) on the 'pending-keychain' placeholder key.
 */

// groundfloor-ts-sdk is an optional, cloud-only dependency (TW-1b): loaded lazily below, never statically.
import { DataplaneGraph } from '../engines/dataplaneGraph.js';
import { DataplaneVectorStore } from '../engines/dataplaneVectorStore.js';
import { createLoreDataplaneSdk, type TenantFirstSdk } from '../engines/dataplaneSdkCompat.js';
import { hasCapability as probeCapability } from '../engines/connectorCapabilities.js';
import { log } from '../logger.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { resolveCloudBootConfig, type LoreWorkspaceRegistry } from './cloudBootConfig.js';

export { requireDataplaneOrgId } from './cloudBootConfig.js';

/**
 * loadGroundfloorClient — Lazy, cloud-only loader for the optional groundfloor-ts-sdk
 * dependency (TW-1b). The static import above is type-only (erased); the runtime class is
 * pulled in here via a dynamic import that ONLY executes inside the cloud branches. If the
 * SDK isn't present, surface a clear error instead of a raw ERR_MODULE_NOT_FOUND.
 */
export async function loadGroundfloorClient(): Promise<typeof import('groundfloor-ts-sdk').GroundfloorClient> {
    try {
        const m = await import('groundfloor-ts-sdk');
        return m.GroundfloorClient;
    } catch (err) {
        throw new Error(
            "[Lore MCP] cloud mode requires the optional dependency 'groundfloor-ts-sdk' — " +
                "install it to use deploymentMode:'cloud'. " +
                `(dynamic import failed: ${(err as Error).message})`,
        );
    }
}

export interface BuildCloudStoresOpts {
    apiKey: string;
    baseUrl: string;
    embeddingProvider?: EmbeddingProvider;
    /** Capability probe; default binds the connector-capabilities cache to THIS baseUrl + apiKey. */
    hasCapability?: (capability: string) => Promise<boolean | null>;
    /** Org id; default `requireDataplaneOrgId()` (env). */
    orgId?: string;
    /** Dataplane workspace the credential is bound to; default `resolveDataplaneWorkspaceId()` (env). */
    dataplaneWorkspaceId?: string;
    /** Which Lore workspaces this instance serves; default: the registry under `home` (workspaces.json). */
    workspaceRegistry?: LoreWorkspaceRegistry;
    /** Connector named on EVERY Dataplane call; default `DATAPLANE_CONNECTION` (env). Unset = engine per-route defaults (review C #1). */
    connection?: string;
    /** Data home whose workspaces.json is the registry (default LORE_HOME). */
    home?: string;
    /** Test/host seam: build the tenant-first SDK; default is the live GroundfloorClient. */
    clientFactory?: (baseUrl: string, apiKey: string) => TenantFirstSdk | Promise<TenantFirstSdk>;
}

export async function buildCloudStores(
    opts: BuildCloudStoresOpts,
): Promise<{ graph: DataplaneGraph; vectorStore: DataplaneVectorStore }> {
    const boot = resolveCloudBootConfig(opts);
    const client = opts.clientFactory
        ? await opts.clientFactory(opts.baseUrl, opts.apiKey)
        : createLoreDataplaneSdk(await loadGroundfloorClient(), opts.baseUrl, opts.apiKey);
    const scope = { orgId: boot.orgId, dataplaneWorkspaceId: boot.dataplaneWorkspaceId, workspaceRegistry: boot.workspaceRegistry };
    // Review C #1: one connector on every route of every store, or none and a loud warning.
    const conn = boot.connection ? { connection: boot.connection } : {};
    if (!boot.connection) {
        log.warn('cloud_connection_unset', {
            effect: "no `connection` is sent: the engine picks a connector per route (sqlite CRUD, postgresql keyword search, surrealdb traverse) unless its DEFAULT_CONNECTOR is set; atomic change+history transactions are disabled",
            fix: 'set DATAPLANE_CONNECTION to the connector that holds the Lore collections',
        });
    }
    const graph = new DataplaneGraph({ client: client as never, ...scope, ...conn });
    const vectorStore = new DataplaneVectorStore({
        client: client as never,
        ...scope,
        ...conn,
        ...(opts.embeddingProvider ? { embeddingProvider: opts.embeddingProvider } : {}),
        // Bind a capability probe so bm25Search can skip the call when no connector ranks.
        // Falls open on probe failure.
        hasCapability: opts.hasCapability ?? ((c: string) => probeCapability(opts.baseUrl, opts.apiKey, c)),
    });
    return { graph, vectorStore };
}

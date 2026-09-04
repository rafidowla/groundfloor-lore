/**
 * storageBundle.ts — build the StorageBundle for a deployment mode.
 *
 * Extracted from `mcp/services.ts` (827 lines, cap 800). This is one concern —
 * "assemble the handles a workspace runs on" — and it was the part of
 * `services.ts` most likely to keep growing, because every substrate change
 * lands here: removing the local graph engine that used to gate boot on a
 * specific database being present is one such example.
 */

import { createTableStorage } from '../engines/tableStorageFactory.js';
import { SessionCacheManager } from '../engines/sessionCacheManager.js';
import type { ISessionCache } from '../engines/sessionCache.js';
import { VerbatimStore } from '../engines/verbatimStore.js';
import { PendingAutolinkTracker } from '../engines/pendingAutolink.js';
import { LoreStorageClient } from '../storage/loreStorageClient.js';
import type { ITableStorage } from '../contracts/tables.js';
import {
    loadGroundfloorClient,
    type LoreGraph,
    type LoreVectorStore,
    type StorageBundle,
} from './services.js';

/**
 * Phase 2 MVP cloud-mode stub. Every method throws with the same
 * message so callers see a clear "not yet implemented" instead of an
 * obscure failure. Replace with `DataplaneTableStorage` when the
 * Postgres-backed adapter lands.
 */
const CLOUD_NOT_IMPL_MSG =
    '[tableStorage] cloud-mode tabular CRUD is not implemented in Phase 2 MVP. ' +
    'Local mode is fully supported; cloud-mode lands when DataplaneTableStorage ships. ' +
    'See project_phase2_investigation_2026_05_15.';

const cloudTableStorageStub: ITableStorage = {
    capabilities: () => ({
        join: false, caseSensitiveContains: false,
        extractedJsonFields: false, additiveSchemaEvolution: false,
    }),
    async createTable() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async listTables() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async insert() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async insertBatch() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async query() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async getByKey() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async update() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async delete() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async count() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async truncate() { throw new Error(CLOUD_NOT_IMPL_MSG); },
    async runTransaction() {
        const error = new Error(CLOUD_NOT_IMPL_MSG) as Error & { code: string };
        error.code = 'transaction_not_implemented';
        throw error;
    },
};

/**
 * createStorageClient — StorageBundle factory.
 *
 * In local mode, sdk is null: local speaks the GraphProvider/VectorProvider
 * contract directly (DEC-CONTRACT) via loreGraph + loreVerbatim +
 * storageClient, so there is no SDK transport to construct.
 *
 * In cloud mode, sdk is the real GroundfloorClient (Dataplane SDK), and
 * loreGraph / loreVerbatim point at DataplaneGraph / DataplaneVectorStore.
 */
export async function createStorageClient(
    graph: LoreGraph,
    verbatimStore: LoreVectorStore,
    deploymentMode: 'local' | 'cloud',
    graphBasePath: string,
): Promise<StorageBundle> {
    if (deploymentMode === 'cloud') {
        // TW-7e (conc-dual-sessioncache-clobber-and-unflushed-on-dispose):
        // cloud mode has no LocalGraph-owned cache, so the bundle owns its own
        // SessionCacheManager. (Local mode reuses LocalGraph.sessionCache — see
        // below — so there is exactly ONE writer to hot_session.json.)
        const sessionCache = new SessionCacheManager(graphBasePath);
        const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
        const apiKey = process.env['DATAPLANE_API_KEY'] ?? '';
        const GroundfloorClient = await loadGroundfloorClient();
        const cloudSdk = new GroundfloorClient(baseUrl, apiKey || 'pending-keychain');
        // W4-CLOUD-FACADE-ROUTING — facade routes through the unified contract
        // in cloud mode. The DataplaneGraph + DataplaneVectorStore handles are
        // already constructed (createGraph / createVectorStore in the cloud
        // branch) and threaded in as `graph` / `verbatimStore`; pass them to
        // fromDataplane so g()/v() delegate to the live cloud adapters instead
        // of throwing CloudModeNotImplementedError. `cloudSdk` is retained as
        // the SDK transport the adapters front. This is what makes "switch to
        // cloud" actually work end-to-end through the contract (cloud_invariant
        // / DEC-CLOUD-READY).
        return {
            sdk: cloudSdk,
            loreGraph: graph,
            loreVerbatim: verbatimStore,
            sessionCache,
            tableStorage: cloudTableStorageStub,
            storageClient: LoreStorageClient.fromDataplane({
                graph,
                verbatim: verbatimStore,
                sdk: cloudSdk,
            }),
            // One registry per Lore instance — see StorageBundle.autolinkTracker.
            autolinkTracker: new PendingAutolinkTracker(),
            // SEPARATE registry for operator sweeps — see StorageBundle.sweepTracker.
            sweepTracker: new PendingAutolinkTracker(),
            graphBasePath,
            deploymentMode: 'cloud',
        };
    }
    // This branch used to require a specific local graph class for exactly
    // two things: `sessionCache` (a JSON file keyed on a path) and
    // `getTableStorage()` (SQLite by default since 061e189). That
    // requirement was the furthest-upstream blocker to running a workspace
    // whose graph engine doesn't bundle those, so it was removed: local
    // mode now builds a bundle-owned SessionCacheManager +
    // createTableStorage(path) directly, needing no graph instance to
    // obtain either.
    //
    // The one surviving branch is the structural sessionCache probe below,
    // kept for the TW-7e single-writer invariant. SurrealGraph exposes no
    // sessionCache, so the probe is false for every current engine — it
    // stays as a capability probe (requireWorkspaceGraph's pattern, not a
    // class check) in case a future engine reintroduces one.
    if (!(verbatimStore instanceof VerbatimStore)) {
        throw new Error('createStorageClient: local mode requires VerbatimStore for loreVerbatim');
    }
    // TW-7e (conc-dual-sessioncache-clobber-and-unflushed-on-dispose): there
    // must be exactly ONE SessionCacheManager per `hot_session.json`. A graph
    // that owns one (LocalGraph constructs its own, and its writes push into
    // it) must have that instance REUSED — a second manager is the
    // last-writer-wins race the original bug was. When the graph has none
    // (SurrealGraph has no session-cache integration), the bundle's is the
    // only instance in existence, so the invariant holds for the opposite
    // reason. What must never happen is BOTH.
    // Unchecked cast → named const; reason: `LoreGraph` is the shared-handle
    // union and omits LocalGraph's optional `sessionCache`, so the compiler
    // cannot see the member — every engine that lacks it leaves it absent and
    // `undefined` is the true runtime answer (verified: SurrealGraph has none).
    const graphSessionCache = graph as { sessionCache?: ISessionCache };
    const sessionCache = graphSessionCache.sessionCache ?? new SessionCacheManager(graphBasePath);
    return {
        // DEC-CONTRACT: local mode has no SDK transport. The load-bearing
        // contract is GraphProvider/VectorProvider + LoreStorageClient, which
        // local speaks directly via loreGraph/loreVerbatim/storageClient. The
        // old LocalGroundfloorClient shim was never dispatched against in local
        // mode (W4-DATAPLANE-CLEANUP) and is gone.
        sdk: null,
        loreGraph: graph,
        loreVerbatim: verbatimStore,
        sessionCache,
        // Built from the path alone via the same factory
        // LocalGraph.getTableStorage() delegates to — no graph instance is
        // needed to obtain it.
        tableStorage: createTableStorage(graphBasePath),
        // Sprint 15 — facade: local mode wraps the LocalGraph +
        // VerbatimStore pair the rest of the bundle exposes. Call
        // sites can now hit `bundle.storageClient.upsertNode(...)`
        // instead of `bundle.loreGraph.upsertNode(...)`.
        storageClient: LoreStorageClient.fromLocal({
            graph,
            verbatim: verbatimStore,
        }),
        // One registry per Lore instance — see StorageBundle.autolinkTracker.
        autolinkTracker: new PendingAutolinkTracker(),
        // SEPARATE registry for operator sweeps — see StorageBundle.sweepTracker.
        sweepTracker: new PendingAutolinkTracker(),
        graphBasePath,
        deploymentMode: 'local',
    };
}

/**
 * index.ts — Lore embeddable library entry point.
 *
 * # Quick start (embedded / in-process mode)
 *
 * ```ts
 * import { createLore } from '@groundfloor/lore';
 *
 * // Allocate an isolated Lore instance — no daemon, no port, no process handlers.
 * const lore = await createLore({
 *   deploymentMode: 'embedded',   // in-process; also accepts 'local' and 'cloud'
 *   dataDir: '/path/to/data-home', // optional: isolates this instance's on-disk graph
 * });
 *
 * // Write a node (same orchestration as MCP store_node / POST /api/node).
 * const result = await lore.nodeUpsert({
 *   id: 'my-decision-1',
 *   workspace: 'default',
 *   ecosystem: 'my-project',
 *   nodeData: { type: 'decision', label: 'Use embedded Lore', content: '...' },
 *   skipEmbed: false,   // false = semantic recall is populated (default)
 *   asyncEmbed: true,   // true = embed in background (non-blocking)
 * });
 * if (result.ok) console.log('node written:', result.node.id);
 *
 * // For reads, use the storage-client facade on lore.store:
 * const node = await lore.store.storageClient.getNode('my-decision-1');
 * const hits  = await lore.store.storageClient.search('decision', 10, 'default', 'my-project');
 *
 * // Tear down cleanly when done (stops timers, closes handles — no process.exit needed).
 * await lore.dispose();
 * ```
 *
 * # Modes
 *
 * | `deploymentMode` | Substrates | Transport | Use case |
 * |---|---|---|---|
 * | `'embedded'` | Kùzu + LanceDB (local) | None (in-process) | Library / test / serverless |
 * | `'local'`    | Kùzu + LanceDB (local) | stdio or HTTP daemon | Single-user daemon |
 * | `'cloud'`    | Dataplane (remote)     | HTTP daemon          | Multi-tenant cloud |
 *
 * # Contract guarantees (embedded mode)
 *
 * - No port is bound. No `SIGINT`/`SIGTERM` handlers are registered.
 * - No process-global `uncaughtException`/`unhandledRejection` handlers
 *   are installed — the host application's error handling is never touched.
 * - Two `createLore({ dataDir: A })` and `createLore({ dataDir: B })` in the
 *   same process are fully isolated on disk and do not share graph state.
 * - `dispose()` runs an ordered graceful-shutdown drain without calling
 *   `process.exit`. The host owns the process lifecycle.
 *
 * # Read operations
 *
 * In-process reads go through `lore.store.storageClient` (a `LoreStorageClient`
 * instance). The key read methods are:
 *
 * - `getNode(id, opts?: { workspace? })` — fetch a single node by id.
 * - `listNodes(type?, tag?, project?, ecosystem?, limit?, opts?: { unbounded?, workspace? })` — filtered list.
 * - `search(query, limit?, project?, ecosystem?, opts?: { workspace? })` — vector + keyword search.
 * - `verbatimSearch(query, limit?, filter?, opts?: { includeHistory?, workspace? }, scopes?)` — verbatim fragment search.
 * - `verbatimCount(opts?: { workspace? })` — verbatim document count.
 * - `getStats(projectFilter?, opts?: { workspace? })` — node/edge counts.
 *
 * `workspace` (added 2026-08-17, audit 1.2) routes the read to that
 * workspace's own graph/vector store via the workspace registry; omitted,
 * it falls back to the boot/active workspace (legacy behavior). Note the
 * third positional of `search`/`listNodes` is PROJECT, not workspace —
 * pre-1.2 docs had them swapped.
 *
 * High-level recall (graph traversal + semantic search combined) is available
 * both in-process (`lore.recall(topic, opts)`) and as an MCP tool via
 * `lore.createMcpServer()`. For raw substrate access use `lore.store.storageClient`.
 * See `docs/API_REFERENCE.md` for the full surface.
 *
 * # GPU / hardware acceleration
 *
 * The local embedding pipeline runs on CPU by default and works on every
 * platform with no extra configuration. To enable hardware acceleration pass
 * a `device` override to `createLore()`:
 *
 * ```ts
 * // Recommended: let Lore pick the best available backend automatically.
 * // Order tried: CoreML (Apple Silicon) → CUDA (NVIDIA) → WebGPU → CPU.
 * const lore = await createLore({ embedding: { device: 'auto' } });
 *
 * // Apple Silicon only — fastest on M-series Macs.
 * const lore = await createLore({ embedding: { device: 'coreml' } });
 *
 * // NVIDIA GPU on Linux / Windows.
 * const lore = await createLore({ embedding: { device: 'cuda' } });
 *
 * // Cross-platform GPU (Mac, Windows, Linux with any modern GPU).
 * const lore = await createLore({ embedding: { device: 'webgpu' } });
 * ```
 *
 * All options fall back to CPU automatically if the requested backend is
 * unavailable — the same call is safe to ship on every platform.
 *
 * The equivalent env vars (for daemon / CLI deployments):
 * - `LORE_LOCAL_EMBEDDING_DEVICE=auto` (or coreml / cuda / webgpu / cpu)
 *
 * Programmatic opts passed to `createLore()` take precedence over env vars.
 * After startup, inspect `GET /health` → `.embeddingBackend` to confirm
 * which backend was selected on the current machine.
 *
 * # At-rest encryption
 *
 * Encryption at rest is not wired into the data path. Rely on OS/filesystem
 * encryption (FileVault, LUKS, etc.). App-layer at-rest encryption is out of
 * scope for this release. See `docs/SECURITY_ADVISORIES.md`.
 *
 * # SDK distribution
 *
 * The `file:../../v3/groundfloor-ts-sdk` dev dependency requires the sibling
 * SDK repo to be present on the same machine. Publishing to a registry is
 * tracked as TW-1b / SW-10 (parked pending SDK team release).
 *
 * Importing this module performs NO side effects: it opens no port, starts
 * no listeners, registers no process handlers/timers, and never calls
 * process.exit. All of that is the DAEMON entry's job (mcp/server.ts main(),
 * which only runs when server.ts is the process entrypoint).
 */

export {
    createLore,
    type LoreInstance,
    type CreateLoreOptions,
    type LoreDeploymentMode,
} from './mcp/server.js';

// NodeWriteResult — the discriminated return type of LoreInstance.nodeUpsert().
// Exported so embedding hosts can branch on result.ok without importing from
// the internal core/nodeService.ts path.
export type { NodeWriteResult } from './core/nodeService.js';
export type { BulkIngestOpts, BulkIngestResult, BulkIngestNodeArgs } from './mcp/bulkIngest.js';

// Re-export the storage-client facade — the cloud-swap point and the
// surface embedding hosts operate through. See storage/loreStorageClient.ts.
export { LoreStorageClient } from './storage/loreStorageClient.js';

// LoreNode is the return type of lore.search() and storageClient.getNode().
// Re-exported so embedding hosts can type-check without reaching into internals.
export type { LoreNode, LoreEdge } from './providers/types.js';

// P3 (Atlas): Pin the local embedding model contract so cross-device sync
// can validate dimensions before trusting vectors from another machine.
// Import DEFAULT_LOCAL_MODEL_ID / DEFAULT_LOCAL_MODEL_DIM to assert the
// active model; call preloadLocalModel() at app startup to warm the pipeline
// before the first node write (avoids cold-load latency on first embed).
export {
    DEFAULT_LOCAL_MODEL_ID,
    DEFAULT_LOCAL_MODEL_DIM,
    DEFAULT_LOCAL_MODEL_DTYPE,
    MINILM_L6_V2_MODEL_ID,
    MINILM_L6_V2_MODEL_DIM,
    MULTILINGUAL_E5_SMALL_MODEL_ID,
    MULTILINGUAL_E5_SMALL_MODEL_DIM,
    type LocalEmbeddingProviderOptions,
    type ModelDtype,
} from './providers/localEmbeddingProvider.js';

// P2 (Atlas): in-process recall — same hybrid retrieval as the recall MCP
// tool but returns a typed JS object.  Call via lore.recall(topic, opts).
export type {
    RecallOpts,
    RecallResult,
    RecallResultSummary,
    RecallResultFull,
    RecallHit,
    RecallNode,
    RecallMeta,
} from './recall/inProcessRecall.js';

/** Pre-warm the local embedding pipeline so the first node write doesn't
 *  block on model download.  Pass opts to override the model; defaults to
 *  DEFAULT_LOCAL_MODEL_ID.  Safe to call multiple times (idempotent after
 *  the first successful load). */
export async function preloadLocalModel(
    opts?: import('./providers/localEmbeddingProvider.js').LocalEmbeddingProviderOptions,
): Promise<void> {
    const { LocalEmbeddingProvider } = await import('./providers/localEmbeddingProvider.js');
    const provider = new LocalEmbeddingProvider(opts);
    await provider.initialize();
}

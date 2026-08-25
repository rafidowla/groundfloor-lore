/**
 * syncEngine.ts — Offline-First Sync Engine with WAL.
 *
 * Purpose:
 *   Provides offline-first synchronization between the local Kùzu graph
 *   and a remote backend (the hosted Dataplane). Uses a Write-Ahead Log
 *   (WAL) to buffer writes locally, then pushes them asynchronously when
 *   the remote backend is reachable.
 *
 * Architecture:
 *   Local writes → WAL file (append-only JSONL) → push to remote on sync.
 *   Remote pulls → upsert locally with last-writer-wins conflict resolution.
 *   Auto-sync runs on a configurable interval (default: 30s).
 *
 * Components:
 *   - WriteAheadLog: Append-only JSONL file at .lore/sync.wal
 *   - SyncAdapter: Pluggable interface for remote backends
 *   - SyncEngine: Orchestrates push/pull/conflict resolution
 *
 * Side Effects:
 *   - Reads/writes .lore/sync.wal (WAL file)
 *   - Reads/writes .lore/.last-sync.push (push cursor)
 *   - Reads/writes .lore/.last-sync.pull (pull cursor)
 *   - Reads legacy .lore/.last-sync at construction (one-shot migration)
 *   - Network calls via SyncAdapter
 *
 * Determinism: Non-deterministic (depends on network + remote state).
 * Thread Safety: Single-writer for WAL. SyncEngine is not reentrant.
 * Idempotency: Push is idempotent (upsert semantics on remote).
 */

import fs from 'fs';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';
import path from 'path';
import type { LoreNode, LoreEdge } from '../providers/types.js';
import type { VerbatimStore } from './verbatimStore.js';
import type { DataplaneVectorStore } from './dataplaneVectorStore.js';
import { sweepFreshness, type IFreshnessGraph } from './freshnessEngine.js';
import { upsertVectorMirror, recoverVectorMirrors, type VectorMirrorResult } from './syncVectorMirror.js';
import { LoreStorageClient } from '../storage/loreStorageClient.js';
import { WriteAheadLog, type WalOperation, type WalEntry } from './writeAheadLog.js';
import { CURRENT_DATA_VERSION } from '../migration/coordinator.js';
import { log } from '../logger.js';

// W5-MIGRATION-VERSION: re-export the single source-of-truth data-version
// constant (owned by migration/coordinator.ts) so importers of the sync
// engine can read the same value the migration coordinator uses. The
// coordinator is the home; the sync engine is a consumer — they agree by
// construction because both read THIS constant.
export { CURRENT_DATA_VERSION };

// SW-02: the WAL implementation moved to writeAheadLog.ts to keep this file
// under the 800-line cap. Re-exported here so existing importers of
// WriteAheadLog / WalEntry / WalOperation from './syncEngine.js' keep working.
export { WriteAheadLog };
export type { WalOperation, WalEntry };

type LoreVectorStore = VerbatimStore | DataplaneVectorStore;

/** Architecture backlog #3 — chunk size for pullRemote's two-pass
 *  apply (graph upserts serial within a chunk, vector mirrors parallel).
 *  Default 100 balances Promise.all width with worst-case retry cost
 *  on a chunk failure. Override per-call via pullRemote(opts.batchSize). */
const PULL_BATCH_SIZE = 100;

/**
 * NW-7b — max pull pages per pullRemote() invocation. The remote
 * adapter is hard-capped at 1000 records per call (corr-pull-no-
 * pagination-1000-cap). Before this fix any pull that produced >1000
 * records dropped the overflow on the floor: the cursor advanced past
 * the batch's `updated_at` and the next pull's `since` window skipped
 * the un-returned records forever. We now loop, advancing `since` to
 * the max `updatedAt` of the returned batch, until the adapter
 * returns < 1000 records OR we hit this safety cap.
 *
 * 50 pages × 1000 records = up to 50k records per pull cycle. A
 * larger backlog drains over successive sync cycles. The cap exists
 * so a malformed/looping adapter cannot wedge the loop indefinitely
 * (each loop iteration is a network round-trip).
 */
const PULL_MAX_PAGES = 50;

/** NW-7b — per-page record cap a remote adapter is allowed to return
 *  before we treat the result as "this might be a clipped page; ask
 *  again with the bumped cursor". 1000 matches the existing
 *  tsSdkAdapter limit. Adapters that return strictly less per call
 *  break out of the loop naturally on iteration #1. */
const PULL_PAGE_FULL_THRESHOLD = 1000;

/**
 * NW-7b — file for pulled edges that failed to apply locally. Bug
 * `corr-pull-edges-silently-dropped`: previously a `try { addEdge }
 * catch {}` swallowed every failure (FK violation, missing endpoints,
 * driver hiccup) AND the pull cursor still advanced past those edges.
 * They were gone on retry. We now persist failed edges to a DLQ file
 * (one JSONL per line, `{edge, error, ts}`) so an operator can
 * inspect + replay. The pull-cursor advancement happens AS BEFORE
 * (advancing on partial success is OK because the edges are in the
 * DLQ — they aren't lost) but failures are visible.
 */
const EDGE_DLQ_FILENAME = '.last-sync.pull-edge-dlq.jsonl';
const NODE_DLQ_FILENAME = '.last-sync.pull-node-dlq.jsonl';

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * SyncResult — Result of a push operation.
 */
export interface SyncResult {
    /** Number of nodes successfully pushed */
    nodesPushed: number;
    /** Number of edges successfully pushed */
    edgesPushed: number;
    /** Number of entries that failed */
    failures: number;
    /** Error messages for failed entries */
    errors: string[];
}

/**
 * PullResult — Result of a pullRemote() invocation.
 *
 * NW-7b (err-pullremote-silent-failure-indistinguishable): the legacy
 * shape returned only counters, so a mid-pull network failure looked
 * identical to "nothing changed remotely" (all three zero). The
 * `error` field, when non-undefined, means the pull did NOT complete
 * cleanly — the cursor was NOT advanced, the counters reflect only
 * what landed before the failure, and the caller can surface or retry.
 *
 * The shape is additive (the error field is optional) so callers that
 * only look at the counters keep working unchanged.
 */
export interface PullResult {
    nodesPulled: number;
    edgesPulled: number;
    conflicts: number;
    /** NW-7b — when set, pullRemote() ran into a mid-pull error.
     *  Counters reflect partial progress; the cursor was NOT advanced
     *  for the failed page so the next pull will retry. */
    error?: string;
    /** NW-7b — count of edges that failed to apply locally and were
     *  routed to the edge DLQ (.last-sync.pull-edge-dlq.jsonl). */
    edgesDeadLettered?: number;
    /** C-R3-05 — count of NODES that failed to apply locally and were
     *  routed to the node DLQ (.last-sync.pull-node-dlq.jsonl). Mirrors
     *  edgesDeadLettered: a persistently-failing node no longer throws out
     *  of the pull loop and wedges the cursor. */
    nodesDeadLettered?: number;
    /** NW-7b — number of pages the adapter was queried for. >1 means
     *  pagination engaged (the previous-version hard-cap would have
     *  silently dropped the overflow). */
    pages?: number;
    /** W5-MIGRATION-VERSION — set to the remote's advertised schemaVersion
     *  when it was STRICTLY HIGHER than CURRENT_DATA_VERSION and the batch
     *  was therefore REFUSED (not applied). The pull cursor is NOT advanced
     *  so a future build that understands the newer shape can re-pull it.
     *  Undefined means no version conflict (applied normally). */
    schemaVersionRefused?: number;
}

/**
 * W5-MIGRATION-VERSION — versioned push envelope.
 *
 * Wraps a node/edge batch with the data-version the sender speaks. The
 * SyncEngine stamps CURRENT_DATA_VERSION here on every push so a peer can
 * detect a shape mismatch instead of silently last-writer-wins applying an
 * unknown-newer payload. Adapters opt in by implementing pushVersioned();
 * legacy adapters keep using push(nodes, edges) and are treated as current.
 */
export interface VersionedPushEnvelope {
    /** Data/schema version the sender produced this batch with. */
    schemaVersion: number;
    nodes: LoreNode[];
    edges: LoreEdge[];
}

/**
 * W5-MIGRATION-VERSION — versioned pull result.
 *
 * The node/edge batch plus an optional `schemaVersion` sidecar advertising
 * the version the REMOTE produced the batch with. A missing/undefined value
 * means a legacy peer that predates the handshake — the engine treats it as
 * CURRENT_DATA_VERSION (back-compat, never a failure). A strictly-higher
 * value is refused: the engine logs + skips that batch rather than applying
 * a shape this build may not understand.
 */
export interface VersionedPullResult {
    nodes: LoreNode[];
    edges: LoreEdge[];
    schemaVersion?: number;
}

/**
 * SyncAdapter — Pluggable interface for remote sync backends.
 *
 * Purpose: Abstracts the remote storage backend so the sync engine
 *   can work with the hosted Dataplane or any future backend.
 *
 * Implementations must handle:
 *   - Network failures gracefully (throw, don't crash)
 *   - Idempotent upserts (push may retry)
 *   - Timestamp-based delta queries (pull since X)
 *
 * Error Behavior: Throws on network/auth failures. Caller handles retry.
 * Concurrency: Must be safe for sequential calls. No concurrent guarantees.
 */
export interface SyncAdapter {
    /**
     * push — Send local changes to the remote backend.
     *
     * @param nodes - Nodes to upsert remotely.
     * @param edges - Edges to create remotely.
     * @returns Summary of push results.
     *
     * Side Effects: Writes to remote database.
     * Idempotency: Yes — upsert semantics.
     */
    push(nodes: LoreNode[], edges: LoreEdge[]): Promise<SyncResult>;

    /**
     * pushVersioned — version-aware push (W5-MIGRATION-VERSION).
     *
     * Optional. When implemented, the SyncEngine prefers this over push()
     * and stamps CURRENT_DATA_VERSION onto the envelope so the remote can
     * record/verify the sender's data-version. Adapters that omit it (every
     * legacy adapter, including the current dataplane adapter) keep working
     * via push() and are treated by peers as speaking the current version.
     *
     * @param envelope - schemaVersion + nodes + edges.
     * @returns Summary of push results.
     *
     * Side Effects: Writes to remote database.
     * Idempotency: Yes — upsert semantics.
     */
    pushVersioned?(envelope: VersionedPushEnvelope): Promise<SyncResult>;

    /**
     * pushDeletes — Propagate local node deletions to the remote backend.
     *
     * SW-02 (B2): `delete_node` WAL entries used to be decoded into a
     * `deletedIds` list that was never sent anywhere — yet the WAL still
     * truncated on a successful node/edge push, so local deletes were
     * dropped on sync and the cloud kept deleted nodes forever. The
     * engine now routes `deletedIds` through this hook before truncation.
     *
     * Optional: adapters predating delete-sync may omit it. When absent,
     * the engine leaves `delete_node` entries in the WAL (does NOT
     * truncate them) so no delete is silently lost.
     *
     * @param ids - Node IDs to delete remotely.
     * @returns Summary; `failures > 0` keeps the delete entries in the WAL.
     *
     * Side Effects: Deletes from remote storage.
     * Idempotency: Yes — deleting an already-absent id is a no-op.
     */
    pushDeletes?(ids: string[]): Promise<SyncResult>;

    /**
     * pull — Fetch remote changes since a given timestamp.
     *
     * @param since - ISO 8601 timestamp. Fetch changes after this time.
     * @returns Nodes and edges modified since the given timestamp.
     *
     * Side Effects: Reads from remote database.
     */
    pull(since: string): Promise<{ nodes: LoreNode[]; edges: LoreEdge[] }>;

    /**
     * pullVersioned — version-aware pull (W5-MIGRATION-VERSION).
     *
     * Optional. When implemented, the SyncEngine prefers this over pull()
     * so the remote can advertise the data-version it produced the batch
     * with (the `schemaVersion` sidecar on VersionedPullResult). The engine
     * refuses a strictly-higher version (log + skip) instead of applying an
     * unknown-newer shape; a missing version is treated as current (legacy
     * peer). Adapters that omit this keep working via pull() — an absent
     * version there is likewise treated as current.
     *
     * @param since - ISO 8601 timestamp. Fetch changes after this time.
     * @returns Nodes, edges, and an optional advertised schemaVersion.
     *
     * Side Effects: Reads from remote database.
     */
    pullVersioned?(since: string): Promise<VersionedPullResult>;

    /**
     * isConnected — Check if the remote backend is reachable.
     *
     * @returns true if connected and authenticated.
     *
     * Side Effects: Network health check.
     */
    isConnected(): Promise<boolean>;

    /**
     * connect — Establish connection to the remote backend.
     *
     * Side Effects: Opens network connection, authenticates.
     * Error Behavior: Throws on connection failure.
     */
    connect(): Promise<void>;

    /**
     * disconnect — Close the remote connection.
     *
     * Side Effects: Closes network connection.
     */
    disconnect(): Promise<void>;
}

/* ─── Sync Engine ─────────────────────────────────────────────── */

/**
 * SyncEngine — Orchestrates offline-first push/pull synchronization.
 *
 * Purpose:
 *   Reads pending entries from the WAL, pushes them to the remote
 *   backend via a SyncAdapter, pulls remote changes, and resolves
 *   conflicts using last-writer-wins (by updatedAt timestamp).
 *
 * Inputs:
 *   - localGraph: The Kùzu graph for reading/writing local data.
 *   - adapter: The remote backend adapter (nullable — runs offline).
 *   - loreDir: Path to .lore/ directory for WAL and sync markers.
 *
 * Side Effects:
 *   - Reads/writes WAL file via WriteAheadLog.
 *   - Reads/writes .lore/.last-sync.push (push cursor — advanced by push acks).
 *   - Reads/writes .lore/.last-sync.pull (pull cursor — advanced by pull acks).
 *   - Network calls via SyncAdapter (when connected).
 *   - Upserts to local Kùzu graph (on pull).
 *
 * Error Behavior:
 *   - Network failures are caught and logged, never crash.
 *   - WAL is NOT truncated unless push fully succeeds.
 *
 * Determinism: Non-deterministic (network + timestamps).
 * Thread Safety: Not reentrant. Use one SyncEngine instance.
 */
export class SyncEngine {
    private wal: WriteAheadLog;
    private localGraph: LoreGraphHandle;
    private vectorStore: LoreVectorStore | null;
    private adapter: SyncAdapter | null;
    private loreDir: string;
    /**
     * NW-1b: separated push/pull cursors. Previously a single `.last-sync`
     * marker was shared by both directions — push success stamped a fresh
     * `new Date().toISOString()`, which then became the `since` argument the
     * next pull sent to the remote. Any remote record updated AFTER the
     * previous sync but BEFORE this push completed had `updated_at < since`
     * and was therefore silently dropped from this pull AND every future pull
     * (the cursor only moves forward). The two cursors are now independent:
     *   - `lastPushPath` ← advanced ONLY by `pushPendingInner()` on full ack.
     *   - `lastPullPath` ← advanced ONLY by `pullRemote()` on success; used
     *      as the `since` argument so the remote-delta window is not
     *      clobbered by a fresher push timestamp.
     * `lastSyncPath` is retained as a read-only legacy migration source
     * (see constructor) — never written to after migration. Kept on disk
     * for one release per NW-1b spec so a rollback can still read it.
     */
    private lastSyncPath: string;
    private lastPushPath: string;
    private lastPullPath: string;
    private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
    private isSyncing: boolean = false;
    // SW-02 review (F1): serializes pushPending() — see the public wrapper below.
    private pushChain: Promise<unknown> = Promise.resolve();

    /**
     * @param localGraph - The graph instance. Local mode (Kùzu) is the
     *   primary use case; cloud-mode SyncEngine constructs without
     *   crashing but is effectively a no-op (the cloud daemon writes
     *   directly via Dataplane, so there is no local WAL to push).
     *   markSynced() is local-only — guarded internally where called.
     * @param loreDir - Path to the .lore/ directory.
     * @param adapter - Optional remote sync adapter. If null, runs offline-only.
     * @param vectorStore - Optional vector store. If supplied, pullRemote()
     *   mirrors every pulled-or-conflict-won node into the vector store too,
     *   so semantic search surfaces cloud-synced knowledge locally. Without
     *   it, pulled nodes are graph-only and invisible to recall/search.
     *   Audit 2026-05-13.
     */
    /** Architecture gap #1 — optional durable outbox. When supplied,
     *  per-chunk vector mirrors are wrapped in withOutbox so a crash
     *  between graph upsert and vector mirror leaves a recoverable
     *  trail. Boot's recoverOutbox(handlers) re-runs missed mirrors. */
    private outbox: import('../outbox/types.js').OutboxStore | null;
    /**
     * SP-20 / D-019: optional LoreStorageClient facade. When supplied,
     * pullRemote() routes upsertNode calls through it (the cloud-swap point)
     * rather than calling this.localGraph.upsertNode directly. Callers that
     * construct SyncEngine with a StorageBundle should pass storageClient here.
     */
    private storageClient: LoreStorageClient | null;

    constructor(
        // Handle, not LocalGraph — naming the Kùzu class made sync Kùzu-only.
        localGraph: LoreGraphHandle,
        loreDir: string,
        adapter: SyncAdapter | null = null,
        vectorStore: LoreVectorStore | null = null,
        outbox: import('../outbox/types.js').OutboxStore | null = null,
        storageClient: LoreStorageClient | null = null,
    ) {
        this.localGraph = localGraph;
        this.loreDir = loreDir;
        this.adapter = adapter;
        this.vectorStore = vectorStore;
        this.outbox = outbox;
        this.storageClient = storageClient;
        this.wal = new WriteAheadLog(loreDir, { enabled: adapter !== null }); // see WriteAheadLog's `enabled` doc comment
        this.lastSyncPath = path.join(loreDir, '.last-sync');
        this.lastPushPath = path.join(loreDir, '.last-sync.push');
        this.lastPullPath = path.join(loreDir, '.last-sync.pull');
        // NW-1b boot migration. If only the legacy `.last-sync` exists,
        // seed BOTH new cursor files from it so neither push nor pull
        // re-pulls everything from epoch on first start. The legacy file
        // is intentionally left in place for one release window (per
        // the NW-1b spec) so a rollback to pre-NW-1b code keeps working.
        try {
            const hasPush = fs.existsSync(this.lastPushPath);
            const hasPull = fs.existsSync(this.lastPullPath);
            if (!hasPush || !hasPull) {
                if (fs.existsSync(this.lastSyncPath)) {
                    const legacy = fs.readFileSync(this.lastSyncPath, 'utf-8').trim();
                    if (legacy) {
                        if (!hasPush) fs.writeFileSync(this.lastPushPath, legacy, 'utf-8');
                        if (!hasPull) fs.writeFileSync(this.lastPullPath, legacy, 'utf-8');
                    }
                }
            }
        } catch {
            // Migration is best-effort. A failure here leaves the cursors
            // at epoch, which is safe (full re-pull on next sync) — not
            // data loss. Avoid logging at constructor to keep imports clean.
        }
    }

    /**
     * getWal — Expose the WAL for direct append from MCP tools.
     *
     * @returns The WriteAheadLog instance.
     */
    getWal(): WriteAheadLog {
        return this.wal;
    }

    /**
     * pushPending — Push buffered WAL entries to the remote backend.
     *
     * Reads all pending WAL entries, groups them by type (nodes vs edges),
     * pushes to the remote backend, marks nodes as synced in Kùzu,
     * and truncates the WAL on success.
     *
     * @returns SyncResult with push statistics.
     *
     * Side Effects: Network push, WAL truncation, Kùzu markSynced.
     * Error Behavior: Returns result with failure count on partial failure.
     *   WAL is only truncated if ALL entries succeed.
     */
    /**
     * pushPending — read the WAL, push to the remote, truncate the pushed
     * entries. Serialized (SW-02 review F1): this method is reachable
     * concurrently from sync(), the auto-sync timer, POST /api/sync/push, and
     * the governance MCP tool. The read → await-push → truncatePushed cycle
     * must NOT overlap another — overlapping runs re-push the same entries to
     * the remote and race the WAL rewrite. Each call chains on the previous so
     * they run strictly one at a time (within this process).
     */
    async pushPending(): Promise<SyncResult> {
        const run = this.pushChain.then(() => this.pushPendingInner());
        // Keep the chain alive whether this run resolves or rejects.
        this.pushChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async pushPendingInner(): Promise<SyncResult> {
        if (!this.adapter) {
            return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: ['No sync adapter configured — running offline'] };
        }

        const connected = await this.adapter.isConnected().catch(() => false);
        if (!connected) {
            try {
                await this.adapter.connect();
            } catch (connectionError) {
                return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: [`Cannot connect to remote: ${(connectionError as Error).message}`] };
            }
        }

        const entries = this.wal.readPending();
        if (entries.length === 0) {
            return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: [] };
        }

        // Group entries by type. Core recognizes upsert_node / add_edge /
        // delete_node. Any other op is unrecognized: there is no live
        // producer of such ops (the plugin system was removed in v3.11.0),
        // so they are retained in the WAL rather than pushed or dropped.
        const nodes: LoreNode[] = [];
        const edges: LoreEdge[] = [];
        const deletedIds: string[] = [];

        // SW-02: track which WAL entryIds belong to each category so we can
        // truncate ONLY the entries that were actually pushed+acked. Entries
        // appended during the awaited push (B1) and unrecognized entries (B3)
        // are deliberately never added to a pushed set, so they survive.
        const nodeEntryIds: string[] = [];
        const edgeEntryIds: string[] = [];
        const deleteEntryIds: string[] = [];
        const unrecognizedEntryIds: string[] = []; // B3 — kept, never truncated away

        for (const entry of entries) {
            switch (entry.op) {
                case 'upsert_node':
                    nodes.push(entry.data as unknown as LoreNode);
                    nodeEntryIds.push(entry.entryId);
                    break;
                case 'add_edge':
                    edges.push(entry.data as unknown as LoreEdge);
                    edgeEntryIds.push(entry.entryId);
                    break;
                case 'delete_node':
                    deletedIds.push(entry.data['id'] as string);
                    deleteEntryIds.push(entry.entryId);
                    break;
                default:
                    // SW-02 (B3): an op core doesn't recognize is NOT data we
                    // can push. Previously such entries were dropped on the
                    // next successful truncate — forward/backward-compat data
                    // loss across versions. Keep them in the WAL so a
                    // future/peer version that understands the op can drain it.
                    unrecognizedEntryIds.push(entry.entryId);
                    break;
            }
        }

        try {
            // SW-02: accumulate the entryIds we've actually pushed+acked.
            // Only these get truncated from the WAL at the end. Anything not
            // added here (mid-push appends, unrecognized ops, failed
            // categories) survives to the next cycle.
            const pushedEntryIds = new Set<string>();

            // W5-MIGRATION-VERSION: stamp the current data-version onto the
            // outbound batch. Prefer the version-aware hook when the adapter
            // implements it; otherwise fall back to the legacy push() —
            // a legacy adapter implicitly speaks CURRENT_DATA_VERSION, so no
            // behaviour changes for the dataplane/cloud adapter today.
            const result = typeof this.adapter.pushVersioned === 'function'
                ? await this.adapter.pushVersioned({ schemaVersion: CURRENT_DATA_VERSION, nodes, edges })
                : await this.adapter.push(nodes, edges);
            if (result.failures === 0) {
                for (const id of nodeEntryIds) pushedEntryIds.add(id);
                for (const id of edgeEntryIds) pushedEntryIds.add(id);
            }

            // SW-02 (B2): propagate buffered deletes to the remote before
            // truncating their WAL entries. Only mark delete entries pushed
            // if the adapter both supports pushDeletes AND acks them with no
            // failures. If the adapter can't delete, the entries stay in the
            // WAL (not silently wiped).
            let deletesPushed = 0;
            let deleteFailures = 0;
            const deleteErrors: string[] = [];
            if (deletedIds.length > 0) {
                if (typeof this.adapter.pushDeletes === 'function') {
                    try {
                        const dr = await this.adapter.pushDeletes(deletedIds);
                        deletesPushed = dr.nodesPushed;
                        deleteFailures = dr.failures;
                        deleteErrors.push(...dr.errors);
                        if (dr.failures === 0) {
                            for (const id of deleteEntryIds) pushedEntryIds.add(id);
                        }
                    } catch (deleteErr) {
                        deleteFailures = deletedIds.length;
                        deleteErrors.push(`Deletes: ${(deleteErr as Error).message}`);
                    }
                } else {
                    // Adapter predates delete-sync — surface it but DON'T drop
                    // the deletes; they remain in the WAL for a capable adapter.
                    deleteFailures = deletedIds.length;
                    deleteErrors.push(`Adapter does not support pushDeletes — ${deletedIds.length} delete(s) retained in WAL`);
                }
            }

            // Mark successfully pushed nodes as synced. markSynced is
            // local-only (cloud daemons don't have a sync-flag column,
            // since cloud writes go directly via Dataplane and there's
            // no WAL to mark off). Guard with a duck-typed check rather
            // than instanceof so the engines/ layer doesn't grow a
            // direct LocalGraph import. Sprint 14 — the duck-typed gate
            // makes the inner `as LocalGraph` cast safe (only reached
            // when markSynced exists on the runtime instance).
            //
            // NW-7b (corr-marksynced-stale-during-push): only mark a node
            // synced if THE EXACT WAL entryId we pushed is still
            // representative — i.e., no NEWER upsert_node entry for the
            // same node id landed in the WAL during the awaited push.
            // Re-read the WAL to detect mid-push appends. A re-appended
            // node id is NOT marked synced here so the next sync cycle
            // re-pushes the newer version. Without this gate, the
            // remote keeps the just-pushed version, the local row
            // carries a `syncedAt` that lies about its actual sync
            // state, and recall/diagnostics treat a stale row as
            // current.
            const ducktyped = this.localGraph as { markSynced?: (id: string) => Promise<void> };
            if (result.failures === 0 && typeof ducktyped.markSynced === 'function') {
                const markSynced = ducktyped.markSynced.bind(this.localGraph);
                // Re-read WAL to find entries appended during the
                // awaited push that point at one of our pushed node
                // ids. Such entries have an entryId NOT in
                // pushedEntryIds — they represent a fresher local
                // version we haven't pushed yet.
                const reappendedIds = new Set<string>();
                try {
                    const postPushEntries = this.wal.readPending();
                    for (const e of postPushEntries) {
                        if (e.op !== 'upsert_node') continue;
                        if (pushedEntryIds.has(e.entryId)) continue;
                        const nid = (e.data as { id?: unknown })?.id;
                        if (typeof nid === 'string') reappendedIds.add(nid);
                    }
                } catch {
                    // If the re-read fails, fall back to the
                    // conservative path: skip markSynced for all
                    // pushed nodes (next cycle will re-evaluate).
                    for (const node of nodes) reappendedIds.add(node.id);
                }
                for (const node of nodes) {
                    if (reappendedIds.has(node.id)) {
                        log.warn('[Lore Sync] node re-appended during push — not marking synced', {
                            nodeId: node.id,
                        });
                        continue;
                    }
                    await markSynced(node.id).catch(() => {
                        // Non-fatal — node may have been deleted locally
                    });
                }
            }

            // SW-02 (B1/B2/B3): truncate ONLY the entries we actually pushed
            // and acked. Re-reads the WAL inside truncatePushed, so any entry
            // appended during the awaited pushes above survives, as do
            // unrecognized ops (B3) and any failed category (deletes,
            // node/edge push). Always advance the WAL when at least one entry
            // was pushed; only stamp the PUSH cursor when the whole batch
            // drained cleanly.
            //
            // NW-1b: write the push cursor (`.last-sync.push`) ONLY — never
            // the pull cursor. Earlier this branch stamped a shared
            // `.last-sync` file that the next `pullRemote()` then read as
            // `since`, silently skipping any remote record updated between
            // the previous sync and this push completion.
            const fullySucceeded =
                result.failures === 0 &&
                deleteFailures === 0 && unrecognizedEntryIds.length === 0;
            if (pushedEntryIds.size > 0) {
                this.wal.truncatePushed(pushedEntryIds);
            }
            if (fullySucceeded) {
                this.writeLastPush(new Date().toISOString());
            }

            return {
                nodesPushed: result.nodesPushed + deletesPushed,
                edgesPushed: result.edgesPushed,
                failures: result.failures + deleteFailures,
                errors: [...result.errors, ...deleteErrors],
            };
        } catch (pushError) {
            return {
                nodesPushed: 0,
                edgesPushed: 0,
                failures: entries.length,
                errors: [`Push failed: ${(pushError as Error).message}`],
            };
        }
    }

    /**
     * pullRemote — Pull changes from the remote backend into local Kùzu.
     *
     * Fetches all changes since the last sync timestamp, applies them
     * locally using last-writer-wins conflict resolution.
     *
     * @returns Summary of pulled changes.
     *
     * Side Effects: Upserts to local Kùzu graph. Updates .last-sync.pull.
     * Error Behavior: Returns empty result on network failure.
     *
     * NW-1b: reads + advances the PULL cursor only. The push cursor
     * (`.last-sync.push`) is never read here — it advances independently
     * and reflects the post-push wall clock, not the remote-delta window.
     */
    async pullRemote(): Promise<PullResult> {
        if (!this.adapter) {
            return { nodesPulled: 0, edgesPulled: 0, conflicts: 0 };
        }

        const connected = await this.adapter.isConnected().catch(() => false);
        if (!connected) {
            try {
                await this.adapter.connect();
            } catch (connectErr) {
                // NW-7b (err-pullremote-silent-failure-indistinguishable):
                // a failed connect used to look identical to "nothing
                // new". Surface the error so a caller can distinguish.
                const msg = (connectErr as Error).message;
                log.error('[Lore Sync] pullRemote connect failed', { error: msg });
                return { nodesPulled: 0, edgesPulled: 0, conflicts: 0, error: `connect: ${msg}` };
            }
        }

        let nodesPulled = 0;
        let conflicts = 0;
        let edgesPulled = 0;
        let edgesDeadLettered = 0;
        let nodesDeadLettered = 0;
        // NW-7b — pagination cursor advances within this invocation as we
        // walk pages; the on-disk pull cursor is stamped to the final
        // value only on full success of the page loop.
        let sinceForPage = this.readLastPull();
        let pages = 0;

        try {
            for (let page = 0; page < PULL_MAX_PAGES; page++) {
                // W5-MIGRATION-VERSION: prefer the version-aware pull hook so
                // the remote can advertise the data-version it produced this
                // batch with. Legacy adapters expose only pull() — a batch
                // from them carries no version, which we treat as current.
                const remote: VersionedPullResult = typeof this.adapter.pullVersioned === 'function'
                    ? await this.adapter.pullVersioned(sinceForPage)
                    : await this.adapter.pull(sinceForPage);
                pages++;

                // W5-MIGRATION-VERSION: cross-version guard. A missing/
                // undefined incoming version = legacy peer = current (apply
                // normally). A STRICTLY HIGHER version means the peer/cloud
                // produced a shape this build may not faithfully apply —
                // refuse: log + skip this batch, leave the pull cursor where
                // it is (so a future, version-aware build re-pulls it) rather
                // than silently last-writer-wins applying an unknown shape.
                const incomingVersion = remote.schemaVersion;
                if (incomingVersion !== undefined && incomingVersion > CURRENT_DATA_VERSION) {
                    log.warn('[Lore Sync] pull refused: incoming schemaVersion newer than local', {
                        incomingVersion,
                        currentVersion: CURRENT_DATA_VERSION,
                        records: remote.nodes.length + remote.edges.length,
                    });
                    // Do NOT advance the cursor: writeLastPull is skipped by
                    // returning before the post-loop stamp. The batch is
                    // dropped on the floor on PURPOSE — it is retained on the
                    // remote and re-pulled once this peer is upgraded.
                    const refused: PullResult = {
                        nodesPulled, edgesPulled, conflicts, pages,
                        schemaVersionRefused: incomingVersion,
                    };
                    if (edgesDeadLettered > 0) refused.edgesDeadLettered = edgesDeadLettered;
                    if (nodesDeadLettered > 0) refused.nodesDeadLettered = nodesDeadLettered;
                    return refused;
                }

                const pageRecords = remote.nodes.length + remote.edges.length;

                // Apply nodes with last-writer-wins, chunked for vector
                // mirror parallelism. See header above for the batching
                // rationale (architecture backlog #3).
                let maxUpdatedAtInPage = sinceForPage;
                for (let chunkStart = 0; chunkStart < remote.nodes.length; chunkStart += PULL_BATCH_SIZE) {
                    const chunk = remote.nodes.slice(chunkStart, chunkStart + PULL_BATCH_SIZE);
                    const winners: LoreNode[] = [];

                    for (const remoteNode of chunk) {
                        if (remoteNode.updatedAt && remoteNode.updatedAt > maxUpdatedAtInPage) {
                            maxUpdatedAtInPage = remoteNode.updatedAt;
                        }
                        // C-R3-05 — mirror the edge DLQ for nodes: a single
                        // persistently-failing remote node must NOT throw out of
                        // the pull loop and wedge the cursor forever (edges already
                        // dead-letter + continue; nodes used to abort the whole
                        // page). Dead-letter the node and continue; do NOT push it
                        // to `winners` so the vector mirror never mirrors a node
                        // that did not actually land in the graph.
                        try {
                            const localNode = await this.localGraph.getNode(remoteNode.id);
                            if (localNode) {
                                const localTime = new Date(localNode.updatedAt).getTime();
                                const remoteTime = new Date(remoteNode.updatedAt).getTime();
                                if (remoteTime > localTime) {
                                    if (this.storageClient) {
                                        await this.storageClient.upsertNode(remoteNode);
                                    } else {
                                        await this.localGraph.upsertNode(remoteNode);
                                    }
                                    winners.push(remoteNode);
                                    nodesPulled++;
                                    conflicts++;
                                }
                            } else {
                                if (this.storageClient) {
                                    await this.storageClient.upsertNode(remoteNode);
                                } else {
                                    await this.localGraph.upsertNode(remoteNode);
                                }
                                winners.push(remoteNode);
                                nodesPulled++;
                            }
                        } catch (nodeErr) {
                            const msg = (nodeErr as Error).message;
                            this.appendNodeDeadLetter(remoteNode, msg);
                            nodesDeadLettered++;
                            log.warn('[Lore Sync] pulled node failed to apply; dead-lettered', {
                                error: msg,
                                nodeId: remoteNode.id,
                            });
                        }
                    }

                    if (winners.length > 0) {
                        await this.applyVectorMirrorChunk(winners);
                    }
                }

                // NW-7b (corr-pull-edges-silently-dropped): edge apply
                // failures used to be swallowed with a bare `catch {}`,
                // and the pull cursor still advanced past those edges.
                // Now we route per-edge failures to the DLQ file and
                // surface a count. (The cursor still advances — the
                // edges are persisted in the DLQ, not lost.)
                for (const remoteEdge of remote.edges) {
                    // TW-4b (corr-pull-cursor-stall-edge-only-page): advance
                    // the page cursor from EDGE timestamps too, not nodes
                    // only. The base bug computed `maxUpdatedAtInPage` from
                    // nodes alone, so a FULL page of only edges left the
                    // cursor unmoved and the loop re-fetched the same page
                    // forever, then wall-clock-stamped and skipped records.
                    // `LoreEdge` has no declared timestamp, but adapters may
                    // attach `updatedAt`/`createdAt`; read them defensively
                    // so an edge-bearing page can move the bookmark.
                    const edgeTs = (remoteEdge as { updatedAt?: string; createdAt?: string }).updatedAt
                        ?? (remoteEdge as { updatedAt?: string; createdAt?: string }).createdAt;
                    if (edgeTs && edgeTs > maxUpdatedAtInPage) {
                        maxUpdatedAtInPage = edgeTs;
                    }
                    try {
                        await this.localGraph.addEdge(remoteEdge);
                        edgesPulled++;
                    } catch (edgeErr) {
                        const msg = (edgeErr as Error).message;
                        this.appendEdgeDeadLetter(remoteEdge, msg);
                        edgesDeadLettered++;
                        log.warn('[Lore Sync] pulled edge failed to apply; dead-lettered', {
                            error: msg,
                            sourceId: remoteEdge.sourceId,
                            targetId: remoteEdge.targetId,
                            relation: remoteEdge.relation,
                        });
                    }
                }

                // TW-4b: did this page move the bookmark forward? Capture
                // BEFORE we mutate `sinceForPage` so the stall guard below
                // can tell "full page, cursor frozen" from real progress.
                const cursorAdvancedThisPage = maxUpdatedAtInPage > sinceForPage;
                const pageWasFull = pageRecords >= PULL_PAGE_FULL_THRESHOLD;

                // Advance the in-memory page cursor by the max updatedAt
                // we observed. Adapter MUST treat `since` as exclusive
                // (`updated_at > since`) for pagination to terminate.
                if (cursorAdvancedThisPage) {
                    sinceForPage = maxUpdatedAtInPage;
                }

                // Stop when this page wasn't full — definitely nothing
                // more to pull.
                if (!pageWasFull) break;

                // TW-4b (corr-pull-cursor-stall-edge-only-page): a FULL page
                // that did NOT advance the cursor means the next pull would
                // re-issue the identical `since` and re-fetch this exact page
                // forever (stall) — and the old post-loop path then stamped
                // wall-clock and permanently skipped everything after it.
                // Surface this as an error instead of looping/skipping: leave
                // the on-disk cursor where it is so a future pull retries
                // from the same point once the remote provides advanceable
                // timestamps. NEVER wall-clock-stamp here.
                if (!cursorAdvancedThisPage) {
                    const msg = `pull cursor stalled: a full page (${pageRecords} records) did not advance the cursor past ${sinceForPage} (records carry no greater updated_at; refusing to loop or wall-clock-stamp)`;
                    log.error('[Lore Sync] pullRemote cursor stall', {
                        since: sinceForPage,
                        pageRecords,
                        nodes: remote.nodes.length,
                        edges: remote.edges.length,
                        pages,
                    });
                    const stalled: PullResult = { nodesPulled, edgesPulled, conflicts, error: msg, pages };
                    if (edgesDeadLettered > 0) stalled.edgesDeadLettered = edgesDeadLettered;
                    if (nodesDeadLettered > 0) stalled.nodesDeadLettered = nodesDeadLettered;
                    // Persist cursor advance from any EARLIER full pages that
                    // did make progress before this stalled page, but never
                    // wall-clock: only stamp an observed record timestamp.
                    if (sinceForPage !== this.readLastPull()) {
                        this.writeLastPull(sinceForPage);
                    }
                    return stalled;
                }
            }

            // NW-1b: advance the PULL cursor only. NW-7b/TW-4b: the cursor is
            // stamped to the final page cursor (max updatedAt of all pages),
            // NEVER `new Date().toISOString()`. Wall-clock stamping skips any
            // record that landed on the remote mid-pull with
            // `updated_at < now` but `updated_at > last cursor`. If no record
            // advanced the cursor (e.g. an empty pull cycle), leave the
            // on-disk cursor exactly where it was.
            // (corr-pull-empty-cycle-stamps-wallclock)
            if (sinceForPage !== this.readLastPull()) {
                this.writeLastPull(sinceForPage);
            }

            const result: PullResult = { nodesPulled, edgesPulled, conflicts, pages };
            if (edgesDeadLettered > 0) result.edgesDeadLettered = edgesDeadLettered;
            if (nodesDeadLettered > 0) result.nodesDeadLettered = nodesDeadLettered;
            return result;
        } catch (pullError) {
            // NW-7b (err-pullremote-silent-failure-indistinguishable):
            // log + surface the error. Cursor was NOT advanced for the
            // failed page so the next pull will retry from the same
            // `since` — at-least-once semantics on the remote-delta
            // window.
            const msg = (pullError as Error).message;
            log.error('[Lore Sync] pullRemote mid-pull failure', { error: msg, pages, nodesPulled, edgesPulled });
            const result: PullResult = { nodesPulled, edgesPulled, conflicts, error: msg, pages };
            if (edgesDeadLettered > 0) result.edgesDeadLettered = edgesDeadLettered;
            if (nodesDeadLettered > 0) result.nodesDeadLettered = nodesDeadLettered;
            return result;
        }
    }

    /**
     * NW-7b — vector-mirror chunk apply, extracted so pullRemote() stays
     * readable. Returns silently after marking the outbox step 'done'
     * if every mirror succeeded, 'failed' if every mirror failed, or
     * 'done' with a warning log if any succeeded (partial — outbox
     * StepStatus has no 'partial' value so 'done' + counter log is the
     * least-bad option without expanding the schema).
     *
     * Closes `err-vector-mirror-outbox-step-marked-done-on-failure`:
     * previously the step was unconditionally marked 'done' even when
     * every mirror failed silently, so recovery never re-ran them.
     */
    private async applyVectorMirrorChunk(winners: LoreNode[]): Promise<void> {
        const ids = winners.map(n => n.id);
        const runMirrors = async (): Promise<VectorMirrorResult[]> =>
            Promise.all(winners.map(n => this.upsertVectorMirror(n)));

        if (this.outbox) {
            const { withOutbox } = await import('../outbox/coordinator.js');
            await withOutbox(this.outbox, {
                operation: 'sync.pull.vector_mirror',
                initiator: 'system:sync',
                steps: [{ kind: 'sync.vector.mirror', payload: { nodeIds: ids } }],
            }, async ({ markStep }) => {
                const results = await runMirrors();
                const failures = results.filter(r => !r.ok);
                if (failures.length > 0) {
                    // C-R2-02: ANY mirror failure (not just an all-fail chunk)
                    // marks the step 'failed' so the recovery pass re-runs the
                    // whole chunk. Previously a PARTIAL failure was marked 'done'
                    // — the rows that failed left graph-present/vector-absent
                    // drift the outbox recovery never revisited (healed only by
                    // the separate consistency sweep, which embedded mode lacks).
                    // upsertVectorMirror is idempotent, so re-mirroring the rows
                    // that already succeeded on recovery is harmless. (The outbox
                    // StepStatus has no 'partial', so re-run-all is the safe choice.)
                    const firstError = failures[0].error ?? 'unknown';
                    await markStep(0, 'failed', firstError);
                    log.error('[Lore Sync] vector-mirror chunk had failures — marking step failed for recovery', {
                        failed: failures.length, total: results.length, firstError,
                    });
                } else {
                    await markStep(0, 'done');
                }
            });
        } else {
            const results = await runMirrors();
            const failures = results.filter(r => !r.ok);
            if (failures.length > 0) {
                log.warn('[Lore Sync] vector-mirror chunk had failures (no outbox wired)', {
                    failed: failures.length, total: results.length,
                });
            }
        }
    }

    /**
     * NW-7b — append a failed pulled edge to the per-workspace DLQ
     * file. Best-effort: a DLQ-write failure must not crash the pull
     * (we log it and continue; the in-memory edgesDeadLettered counter
     * still surfaces in the PullResult).
     */
    private appendEdgeDeadLetter(edge: LoreEdge, error: string): void {
        try {
            const line = JSON.stringify({
                edge,
                error,
                ts: new Date().toISOString(),
            }) + '\n';
            fs.appendFileSync(path.join(this.loreDir, EDGE_DLQ_FILENAME), line, { encoding: 'utf-8', mode: 0o600 });
        } catch (dlqErr) {
            log.error('[Lore Sync] failed to append edge to DLQ', { error: (dlqErr as Error).message });
        }
    }

    /**
     * C-R3-05 — append a failed pulled NODE to the per-workspace node DLQ
     * file. Best-effort (mirrors appendEdgeDeadLetter): a DLQ-write failure
     * must not crash the pull; the in-memory nodesDeadLettered counter still
     * surfaces in the PullResult so the caller can re-drive the node later.
     */
    private appendNodeDeadLetter(node: LoreNode, error: string): void {
        try {
            const line = JSON.stringify({
                node,
                error,
                ts: new Date().toISOString(),
            }) + '\n';
            fs.appendFileSync(path.join(this.loreDir, NODE_DLQ_FILENAME), line, { encoding: 'utf-8', mode: 0o600 });
        } catch (dlqErr) {
            log.error('[Lore Sync] failed to append node to DLQ', { error: (dlqErr as Error).message });
        }
    }

    /**
     * recoverVectorMirror — Boot-time recovery for interrupted vector mirrors.
     * Delegates to syncVectorMirror.recoverVectorMirrors (extracted for size).
     */
    async recoverVectorMirror(nodeIds: string[]): Promise<{ recovered: number; skipped: number }> {
        return recoverVectorMirrors(
            this.vectorStore,
            this.localGraph,
            nodeIds,
        );
    }

    private async upsertVectorMirror(remoteNode: LoreNode): Promise<VectorMirrorResult> {
        return upsertVectorMirror(this.vectorStore, remoteNode);
    }

    /**
     * sync — Full sync cycle: push pending, then pull remote.
     *
     * @returns Combined push and pull results.
     */
    async sync(): Promise<{
        push: SyncResult;
        pull: PullResult;
    }> {
        if (this.isSyncing) {
            return {
                push: { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: ['Sync already in progress'] },
                pull: { nodesPulled: 0, edgesPulled: 0, conflicts: 0 },
            };
        }

        this.isSyncing = true;
        try {
            const push = await this.pushPending();
            const pull = await this.pullRemote();
            // Non-blocking freshness sweep after each pull cycle.
            sweepFreshness(this.localGraph as IFreshnessGraph, this.loreDir).catch((e) => {
                console.warn('[Lore Freshness] sweep failed:', (e as Error).message);
            });
            return { push, pull };
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * startAutoSync — Start a periodic background sync.
     *
     * @param intervalMs - Sync interval in milliseconds (default: 30000 = 30s).
     *
     * Side Effects: Starts a setInterval timer.
     */
    startAutoSync(intervalMs: number = 30000): void {
        if (this.autoSyncTimer) return;

        this.autoSyncTimer = setInterval(() => {
            this.sync().catch((syncError) => {
                console.error('[Lore Sync] Auto-sync failed:', (syncError as Error).message);
            });
        }, intervalMs);
    }

    /**
     * stopAutoSync — Stop the periodic background sync.
     *
     * Side Effects: Clears the setInterval timer.
     */
    stopAutoSync(): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
    }

    /**
     * getStatus — Get current sync status for CLI/MCP.
     *
     * @returns Sync status summary.
     */
    getStatus(): {
        walPending: number;
        lastSync: string;
        hasAdapter: boolean;
        isAutoSyncing: boolean;
    } {
        // NW-1b: the public `lastSync` field continues to expose the most-
        // recent successful push timestamp (callers and CLI use it as
        // "last time we synced anything outbound"). The pull cursor is
        // exposed alongside but does not replace it — changing the shape
        // would ripple into the CLI/MCP/REST status surfaces.
        return {
            walPending: this.wal.pendingCount(),
            lastSync: this.readLastPush(),
            hasAdapter: this.adapter !== null,
            isAutoSyncing: this.autoSyncTimer !== null,
        };
    }

    /* ─── Private Helpers ────────────────────────────────────────── */

    /**
     * NW-1b: cursor helpers. Push and pull are independent — push writes
     * `.last-sync.push` (and never `.last-sync.pull`); pull reads + writes
     * `.last-sync.pull`. Combining them caused the `corr-push-clobbers-pull-
     * cursor` data-loss bug where a fresh post-push timestamp became the
     * next pull's `since`, silently skipping any remote record updated
     * in the window between the previous sync and this push completing.
     */
    private readCursor(p: string): string {
        try {
            return fs.readFileSync(p, 'utf-8').trim() || '1970-01-01T00:00:00.000Z';
        } catch {
            return '1970-01-01T00:00:00.000Z';
        }
    }

    private readLastPush(): string {
        return this.readCursor(this.lastPushPath);
    }

    private readLastPull(): string {
        return this.readCursor(this.lastPullPath);
    }

    private writeLastPush(timestamp: string): void {
        fs.writeFileSync(this.lastPushPath, timestamp, 'utf-8');
    }

    private writeLastPull(timestamp: string): void {
        fs.writeFileSync(this.lastPullPath, timestamp, 'utf-8');
    }
}

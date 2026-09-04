/**
 * outbox/dispatcher.ts — replicator's operationKind → substrate-call dispatcher.
 *
 * Sprint O1 (2026-05-24). The replicator reads outbox rows and calls
 * `dispatch(entry)` for each. The dispatcher switches on
 * `entry.operationKind` and calls the existing substrate write
 * function — graph upserts, edge upserts, vector mirror, verbatim
 * stores. This file does NOT define new substrate semantics; it
 * routes outbox payloads back into the writers that already exist.
 *
 * Idempotency strategy: Option A from the O0 audit — substrate
 * writers are responsible for being idempotent against a stable id.
 * `localGraph.upsertNode` already follows the "match-then-set OR
 * create" pattern (audit Section 3) which is safe to replay. The
 * existing `sync.vector.mirror` step handler is documented idempotent
 * (audit Section 5). New operationKinds (node.upsert, edge.upsert)
 * rely on the same upsertNode / addEdge writers — same guarantee.
 *
 * If a substrate MERGE edge case surfaces during O2/O3, the fallback is
 * Option B (sequenced upserts with `lastSequenceId` column on
 * LoreNode). That change would land here as a per-kind branch that
 * passes `sequenceId` to the writer.
 *
 * SCOPE — O1 ships the dispatcher SHELL with the existing
 * `sync.vector.mirror` path wired through. The new kinds
 * (node.upsert, edge.upsert, node.delete, edge.delete,
 * verbatim.upsert) are wired by O2 (hot lane) and O3 (bulk lane)
 * when the producer endpoints route through the outbox. Until then,
 * those dispatch branches throw 'kind not wired' so the gate test
 * O-D1/O-D2 stays red until the corresponding sub-chain lands.
 */

import type { OutboxEntry } from './types.js';
import { computeContentHash } from '../engines/contentHash.js';

/**
 * Sprint O6 (2026-05-24) — outcome of a self-heal verifier probe.
 *
 * `verified` is true iff substrate already holds the row's effect (and
 * therefore the replicator can mark the row 'replicated' instead of
 * leaving it stuck in 'failed').
 *
 * `reason` is a short tag the replicator logs for observability
 * ('substrate-has-node', 'no-verifier-wired', 'kind-not-self-healable',
 * etc.). NOT machine-parsed by callers — purely operator-facing.
 *
 * Verifier methods are best-effort: if a probe throws the caller treats
 * it as "not verified" rather than crashing. Self-heal stays safe: a
 * row that fails to verify is simply left in 'failed' for the next
 * tick or the operator's drain-failed CLI.
 */
export interface VerifyOutcome {
    verified: boolean;
    reason: string;
}
import type { BatchedEmbedder } from '../embed/batchedEmbedder.js';

/**
 * The substrate-side handles the dispatcher needs. Kept narrow so
 * the replicator can be wired against either local-mode (LocalGraph,
 * VerbatimStore) or test fakes without dragging the full daemon
 * dependency tree in.
 */
/**
 * SP-F3 (2026-06-10) — every workspace-sensitive substrate function now
 * receives the originating row's `entry.workspace` as a trailing argument.
 * The production wiring (outbox/wiring.ts) uses it to resolve the TARGET
 * per-workspace graph / verbatim store via the LocalGraphRegistry (+ a
 * per-workspace verbatim resolver) before applying, instead of always
 * writing into the boot-bound instances. Before this fix the replicator
 * replayed node.upsert/verbatim.upsert into the BOOT workspace regardless
 * of entry.workspace — cross-workspace data contamination for any write
 * targeting a non-boot workspace. `workspace` is optional/undefined for
 * legacy rows (pre-Sprint-L) and test stubs, in which case the wiring
 * falls back to the boot instances (prior behavior).
 */
export interface DispatcherSubstrates {
    /** Calls `localGraph.upsertNode(payload as LoreNode)` on the workspace's graph. */
    upsertNode?: (payload: Record<string, unknown>, workspace?: string) => Promise<void>;
    /** Calls `localGraph.addEdge(payload as LoreEdge)` on the workspace's graph. */
    addEdge?: (payload: Record<string, unknown>, workspace?: string) => Promise<void>;
    /** Calls `localGraph.deleteNode(id)` on the workspace's graph. */
    deleteNode?: (id: string, workspace?: string) => Promise<void>;
    /** 2026-09-03 (X-markstale audit fix) — calls `graph.markStaleByIds(ids)`
     *  on the workspace's graph for the row's already-resolved id chunk
     *  (see outbox/types.ts `node.mark_stale`). */
    markStale?: (ids: string[], workspace?: string) => Promise<void>;
    /** Calls `localGraph.deleteEdge(source, target, relation)` on the workspace's graph. */
    deleteEdge?: (payload: { sourceId: string; targetId: string; relation: string }, workspace?: string) => Promise<void>;
    /** Calls `verbatimStore.store({...})` on the workspace's verbatim store. */
    upsertVerbatim?: (payload: Record<string, unknown>, workspace?: string) => Promise<void>;
    /** 2026-09-03 (A2 finding 2 fix) — calls `verbatimStore.tombstone(id, reason)`
     *  on the workspace's verbatim store. Every node-delete path records a
     *  `verbatim.tombstone` row AFTER its `node.delete` row so a replay of a
     *  stale `verbatim.upsert` from an earlier create can't outlive the
     *  delete and resurrect tombstoned content — see outbox/types.ts. */
    tombstoneVerbatim?: (id: string, reason: string, workspace?: string) => Promise<void>;
    /** SP-13 — batched verbatim upsert. The replicator consolidates a run
     *  of adjacent `verbatim.upsert` outbox rows into ONE
     *  `verbatim.upsert.batch` dispatch so the underlying
     *  `verbatimStore.storeBatch` produces a single LanceDB fragment for
     *  the whole run instead of one fragment per row (the per-row write
     *  amplification this sprint closes). Optional so Sprint O tests that
     *  only wire single-row hooks keep working. */
    upsertVerbatimBatch?: (payload: { items: Array<Record<string, unknown>> }, workspace?: string) => Promise<void>;
    /** Half-completion reaper hook (2026-06-09). When a `node.upsert`
     *  entry exhausts its retry budget and goes dead, the hot-lane
     *  verbatim row written before the graph-upsert attempt is left
     *  stranded — a true orphan (vector present, no graph node anywhere).
     *  The replicator calls this on dead-letter to reap it. Best-effort:
     *  a reap failure must NOT fail the dead-letter transition.
     *  Calls `verbatimStore.physicalDelete(id)`. */
    physicalDeleteVerbatim?: (id: string, workspace?: string) => Promise<void>;
    /** Calls `syncEngine.recoverVectorMirror(nodeIds)`. */
    syncVectorMirror?: (payload: { nodeIds: string[] }) => Promise<void>;
    /**
     * Sprint E1 (2026-05-24) — batched embed driver. The dispatcher
     * routes `embed.batch` payloads `{ texts, targetNodeIds }` through
     * a BatchedEmbedder and writes the resulting vectors to the
     * verbatim store via `storeEmbedBatch`. Both hooks are optional
     * so the dispatcher remains usable by tests that don't wire the
     * embed pipeline (Sprint O regression tests inject only the
     * substrate-write hooks they exercise).
     */
    batchedEmbedder?: BatchedEmbedder;
    /**
     * Substrate-write hook that takes the vectors freshly produced by
     * the BatchedEmbedder and persists them. The handler accepts a
     * matched pair (targetNodeIds[i] receives vectors[i]) so the
     * storage layer can decide whether to upsert into LanceDB
     * (`verbatimStore.storeBatch`) or fan out via the existing
     * vector-mirror path. The hook stays narrow so the dispatcher
     * does not import the full VerbatimStore type tree.
     */
    storeEmbedBatch?: (payload: {
        targetNodeIds: string[];
        vectors: number[][];
        /** SP-F2 (2026-06-10) — the exact texts that were embedded,
         *  aligned with targetNodeIds/vectors. The production hook
         *  (outbox/wiring.ts) persists text alongside the vector so the
         *  verbatim row is complete (search results render text), and
         *  derives contentHash from it. Optional so pre-SP-F2 test
         *  stubs keep compiling. */
        texts?: string[];
    }, workspace?: string) => Promise<void>;
    /**
     * Sprint E1 — `embed.done` handler. Optional. Called when an
     * upstream `embed.batch` finishes; updates the originating writes'
     * substrate-fanout state (E2 wires the actual producer). Until
     * E2 lands, the default no-op is fine because no producer ever
     * enqueues `embed.done`.
     */
    onEmbedDone?: (payload: { targetNodeIds: string[] }) => Promise<void>;

    // ---- Sprint O6 (2026-05-24) — verifier hooks ----
    //
    // Cheap idempotent substrate probes the replicator's self-heal tick
    // calls to decide whether a `status='failed'` outbox row whose data
    // is actually already in substrate should be flipped to 'replicated'.
    // Each probe MUST be cheap (indexed lookup, not a scan) and MUST be
    // side-effect-free. Wired by daemon boot in outbox/wiring.ts; tests
    // can stub them per-kind. Optional so the replicator stays usable
    // by sub-chains that don't wire self-heal (test fakes).
    //
    // Convention: each returns true iff substrate has the row's effect.
    // - node.upsert      → graph has node with this id
    // - edge.upsert      → graph has edge (src, tgt, relation)
    // - node.delete      → graph does NOT have node with this id
    // - verbatim.upsert  → verbatim store has row with this id
    // - embed.batch      → every targetNodeId has a vector

    /** Does the workspace's graph hold a LoreNode with this id? */
    hasNode?: (id: string, workspace?: string) => Promise<boolean>;
    /** Does the workspace's graph hold a (src, tgt, relation) edge? */
    hasEdge?: (payload: { sourceId: string; targetId: string; relation: string }, workspace?: string) => Promise<boolean>;
    /** Does the workspace's verbatim store hold a row with this id? */
    hasVerbatim?: (id: string, workspace?: string) => Promise<boolean>;
    /** Do ALL of these targetNodeIds have a vector in the workspace's lance? */
    hasEmbeddings?: (targetNodeIds: string[], workspace?: string) => Promise<boolean>;

    // ---- 2026-08-17 (finding 2.4) — content-witness probes ----
    //
    // The existence probes above answer "does the substrate hold a row with
    // this id?" — sound for a CREATE, but for an UPDATE to an entity that
    // already exists existence is ALWAYS true, so self-heal used to flip a
    // dead row carrying a real edit to 'replicated' while the substrate still
    // held the OLD content. These probes return the stored row itself so
    // verifyApplied can compare the payload's content against what actually
    // landed. When the payload carries content and the matching witness hook
    // is unwired, verifyApplied fails LOUD ('content-witness-unwired') rather
    // than falling back to the unsound existence probe.

    /** Fetch the workspace graph's node record (content-bearing fields), or null. */
    getNode?: (id: string, workspace?: string) => Promise<Record<string, unknown> | null>;
    /** Fetch the workspace verbatim store's row (contentHash / text), or null. */
    getVerbatim?: (id: string, workspace?: string) => Promise<{ contentHash?: string; text?: string } | null>;
}

export class UnwiredOperationKindError extends Error {
    constructor(kind: string) {
        super(`outbox dispatcher: operationKind '${kind}' is not wired in this sub-chain yet`);
        this.name = 'UnwiredOperationKindError';
    }
}

export class MissingPayloadError extends Error {
    constructor(kind: string, field: string) {
        super(`outbox dispatcher: operationKind '${kind}' payload missing required field '${field}'`);
        this.name = 'MissingPayloadError';
    }
}

/* ─── 2.4 (2026-08-17) — content witnesses for self-heal ───────────────
 *
 * verifyApplied's job is "did THIS row's effect land?", not "does a row
 * with this id exist?". Existence is a sound witness for a CREATE and for
 * a delete (absence), but an UPDATE to an existing entity exists whether
 * or not the edit landed — the old existence-only probes let the self-heal
 * sweep flip a dead row carrying a real edit to 'replicated', permanently
 * discarding the edit. The helpers below compare the payload's content
 * against what the substrate actually holds.
 *
 * `updatedAt` is deliberately NOT a witness: the graph writers stamp it
 * themselves (`new Date().toISOString()`) on every upsert rather than
 * persisting the payload's value, so payload and substrate never agree on
 * it even for a fully-applied row.
 */

/** Payload fields compared against the substrate node when present. */
const NODE_CONTENT_WITNESS_FIELDS = ['type', 'label', 'content', 'project', 'ecosystem'] as const;

/**
 * The contentHash a verbatim.upsert payload will persist —
 * `metadata.contentHash` wins (VerbatimStore.store's effectiveHash rule),
 * else the hash of the payload text. null when the payload carries
 * neither (an identity-only row, where existence is a sound witness).
 */
function expectedVerbatimHash(p: Record<string, unknown>): string | null {
    const meta = p['metadata'];
    if (meta && typeof meta === 'object' && !Array.isArray(meta) && 'contentHash' in meta) {
        const metaHash = meta.contentHash;
        if (typeof metaHash === 'string' && metaHash) return metaHash;
    }
    const text = p['text'];
    if (typeof text === 'string' && text) return computeContentHash(text);
    return null;
}

/**
 * The contentHash the stored verbatim row currently holds, derived from
 * the stored text when the row predates the contentHash column. '' when
 * neither is available — never equal to a real expected hash, so such a
 * row fails loud instead of existence-healing.
 */
function storedVerbatimHash(row: { contentHash?: string; text?: string }): string {
    if (typeof row.contentHash === 'string' && row.contentHash) return row.contentHash;
    if (typeof row.text === 'string' && row.text) return computeContentHash(row.text);
    return '';
}

/**
 * Dispatch a single outbox entry to its substrate. Throws on
 * unwired kinds or invalid payloads so the replicator catches the
 * error, bumps `attempts`, and moves to the next entry.
 */
export async function dispatch(
    entry: OutboxEntry,
    substrates: DispatcherSubstrates,
): Promise<void> {
    const kind = entry.operationKind;
    if (!kind) {
        throw new Error(`outbox dispatcher: entry ${entry.id} has no operationKind`);
    }
    const payload = entry.payload ?? {};
    // SP-F3 — the originating workspace. Threaded into every
    // workspace-sensitive substrate so the production wiring applies the
    // write to the TARGET workspace's graph/verbatim, not the boot one.
    const ws = entry.workspace;

    switch (kind) {
        case 'node.upsert': {
            if (!substrates.upsertNode) throw new UnwiredOperationKindError(kind);
            if (!payload['id']) throw new MissingPayloadError(kind, 'id');
            await substrates.upsertNode(payload, ws);
            return;
        }
        case 'edge.upsert': {
            if (!substrates.addEdge) throw new UnwiredOperationKindError(kind);
            if (!payload['sourceId'] || !payload['targetId'] || !payload['relation']) {
                throw new MissingPayloadError(kind, 'sourceId|targetId|relation');
            }
            // 2.2 (2026-08-17) — respect payload.bidirectional. Every edge-
            // write surface records the field and both the MCP tool and the
            // REST route DEFAULT it to true; replaying with only the forward
            // addEdge silently created half the edge. The engines'
            // addBidirectionalEdge is exactly two addEdge calls (forward then
            // reversed — graphEdges.ts / surrealGraph.ts / dataplaneGraph.ts),
            // so two substrate calls here reproduce the original write; each
            // direction's read-decide-write guard keeps replay idempotent, and
            // a throw on the SECOND call leaves the row pending so the reverse
            // direction is retried instead of being marked done half-applied.
            await substrates.addEdge(payload, ws);
            if (payload['bidirectional'] !== false) {
                await substrates.addEdge({
                    ...payload,
                    sourceId: payload['targetId'],
                    targetId: payload['sourceId'],
                }, ws);
            }
            return;
        }
        case 'node.delete': {
            if (!substrates.deleteNode) throw new UnwiredOperationKindError(kind);
            const id = payload['id'];
            if (typeof id !== 'string') throw new MissingPayloadError(kind, 'id');
            await substrates.deleteNode(id, ws);
            return;
        }
        case 'edge.delete': {
            if (!substrates.deleteEdge) throw new UnwiredOperationKindError(kind);
            const sourceId = payload['sourceId'];
            const targetId = payload['targetId'];
            const relation = payload['relation'];
            if (typeof sourceId !== 'string' || typeof targetId !== 'string' || typeof relation !== 'string') {
                throw new MissingPayloadError(kind, 'sourceId|targetId|relation');
            }
            await substrates.deleteEdge({ sourceId, targetId, relation }, ws);
            return;
        }
        case 'node.mark_stale': {
            // 2026-09-03 (X-markstale audit fix). Payload: { ids: string[] } —
            // the chunk's already-resolved ids (outbox/types.ts).
            if (!substrates.markStale) throw new UnwiredOperationKindError(kind);
            const rawIds = (payload as { ids?: unknown }).ids;
            if (!Array.isArray(rawIds)) throw new MissingPayloadError(kind, 'ids');
            const ids = rawIds.filter((x): x is string => typeof x === 'string' && x.length > 0);
            if (ids.length === 0) return;
            await substrates.markStale(ids, ws);
            return;
        }
        case 'verbatim.upsert': {
            if (!substrates.upsertVerbatim) throw new UnwiredOperationKindError(kind);
            await substrates.upsertVerbatim(payload, ws);
            return;
        }
        case 'verbatim.tombstone': {
            // 2026-09-03 (A2 finding 2 fix). Payload: { id: 'lore:<id>', reason }.
            if (!substrates.tombstoneVerbatim) throw new UnwiredOperationKindError(kind);
            const id = payload['id'];
            if (typeof id !== 'string' || !id) throw new MissingPayloadError(kind, 'id');
            const reason = typeof payload['reason'] === 'string' ? payload['reason'] : 'graph node deleted (outbox replay)';
            await substrates.tombstoneVerbatim(id, reason, ws);
            return;
        }
        case 'verbatim.upsert.batch': {
            // SP-13 — consolidated verbatim upsert. Payload contract:
            //   { items: Array<{ id, text, metadata }> }
            // The replicator merges adjacent verbatim.upsert rows into one
            // of these so storeBatch writes a single LanceDB fragment for
            // the whole run. The synthesized payload always carries an
            // `items` array (see replicator.replicateConsolidatedVerbatim).
            if (!substrates.upsertVerbatimBatch) throw new UnwiredOperationKindError(kind);
            const rawItems = (payload as { items?: unknown }).items;
            if (!Array.isArray(rawItems)) throw new MissingPayloadError(kind, 'items');
            const items = rawItems.filter(
                (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x),
            );
            await substrates.upsertVerbatimBatch({ items }, ws);
            return;
        }
        case 'sync.vector.mirror': {
            if (!substrates.syncVectorMirror) throw new UnwiredOperationKindError(kind);
            const ids = Array.isArray((payload as { nodeIds?: unknown[] }).nodeIds)
                ? ((payload as { nodeIds: unknown[] }).nodeIds).filter((x): x is string => typeof x === 'string')
                : [];
            await substrates.syncVectorMirror({ nodeIds: ids });
            return;
        }
        case 'embed.batch': {
            // Sprint E1 (2026-05-24). Payload contract:
            //   { texts: string[]; targetNodeIds: string[] }
            // Both arrays must be the same length — texts[i] is the
            // body to embed for targetNodeIds[i]. The handler calls
            // BatchedEmbedder.embedBatch (which chunks internally per
            // provider cap) then hands the vectors + ids to
            // storeEmbedBatch for persistence. E2 will be the
            // producer; this handler is wired in E1 so the dispatcher
            // switch stays exhaustive and operators can pre-stage
            // outbox entries for smoke tests.
            if (!substrates.batchedEmbedder) throw new UnwiredOperationKindError(kind);
            if (!substrates.storeEmbedBatch) throw new UnwiredOperationKindError(kind);
            const rawTexts = (payload as { texts?: unknown }).texts;
            const rawIds = (payload as { targetNodeIds?: unknown }).targetNodeIds;
            if (!Array.isArray(rawTexts) || !Array.isArray(rawIds)) {
                throw new MissingPayloadError(kind, 'texts|targetNodeIds');
            }
            const texts = rawTexts.filter((x): x is string => typeof x === 'string');
            const targetNodeIds = rawIds.filter((x): x is string => typeof x === 'string');
            if (texts.length !== targetNodeIds.length) {
                throw new MissingPayloadError(kind, 'texts.length === targetNodeIds.length');
            }
            const vectors = await substrates.batchedEmbedder.embedBatch(texts);
            await substrates.storeEmbedBatch({ targetNodeIds, vectors, texts }, ws);
            return;
        }
        case 'load.received': {
            // Sprint Z1 (2026-05-24) — notification-only marker emitted
            // by POST /api/load after the streaming-upload body has been
            // fully written to the job's temp file. Z1 does not process
            // rows; Z2 wires the substrate-native loader handler that
            // reopens tempFilePath and drives the actual row writes.
            // Until then this branch is a deliberate no-op so the
            // dispatcher exhaustiveness check holds AND the replicator
            // immediately marks the row 'replicated' (no substrate
            // side effect — the side effect is the temp file on disk,
            // which load_jobs.temp_file_path already tracks).
            return;
        }
        case 'load.done': {
            // Sprint Z2 (2026-05-24) — notification-only marker
            // emitted by loadJobsRunner when a bulk-load job
            // transitions to 'complete' (or 'failed'). No replicator
            // handler needs to fire; the side effects (substrate
            // rows + load_jobs row state) are already durable. The
            // entry exists so dashboards / Sprint E re-embed
            // schedulers can subscribe to load completions without
            // scanning load_jobs.
            return;
        }
        case 'stream.event': {
            // Sprint S (2026-05-24) — warm-lane streaming-ingest marker.
            // The HTTP /api/stream/connect route commits one outbox
            // row per event via LocalStreamConsumer. There is no
            // additional substrate side effect to replay here — the
            // row IS the durable record of the streamed event, and
            // downstream consumers (Sprint R recall, dashboards) read
            // it like any other outbox entry. Returning immediately
            // advances the row to 'replicated', mirroring the
            // load.received + migration.* notification-only pattern.
            return;
        }
        case 'migration.started':
        case 'migration.applied':
        case 'migration.failed': {
            // Sprint H1 (2026-05-24) — MigrationCoordinator notifications.
            // The substrate side effect (schema change) already happened
            // inside the coordinator BEFORE the outbox row was recorded;
            // there is nothing for the dispatcher to replay. We return
            // immediately so the replicator marks the row 'replicated'.
            // The row stays as an audit trail in outbox_entries for
            // dashboards / observability — same pattern as load.received
            // + load.done above. Sprint O6 self-heal returns
            // 'kind-not-self-healable' for these (see verifyApplied).
            return;
        }
        case 'embed.done': {
            // Sprint E1 — no-op-friendly. If no handler is wired the
            // dispatcher treats the entry as a success (the originating
            // write's status advancement is then a pure outbox-state
            // transition with no substrate side effect). Producers
            // (E2) will start enqueuing these once the producer side
            // ships; until then this branch sees no traffic in
            // production.
            const rawIds = (payload as { targetNodeIds?: unknown }).targetNodeIds;
            const targetNodeIds = Array.isArray(rawIds)
                ? rawIds.filter((x): x is string => typeof x === 'string')
                : [];
            if (substrates.onEmbedDone) {
                await substrates.onEmbedDone({ targetNodeIds });
            }
            return;
        }
        default: {
            // Exhaustiveness check — TypeScript will catch a missing
            // branch when a new operationKind is added to the union.
            const _exhaustive: never = kind;
            throw new Error(`outbox dispatcher: unknown operationKind '${_exhaustive}'`);
        }
    }
}

/**
 * Sprint O6 (2026-05-24) — self-heal verifier dispatch.
 *
 * Called by `OutboxReplicator.runSelfHealTick()` for each candidate
 * `status='failed'` row whose grace window has expired. Returns a
 * `VerifyOutcome`: when `verified` is true the replicator flips the row
 * to 'replicated' (no substrate side effect; the data is already there).
 *
 * Cheap by contract: every branch is an indexed lookup (id-only PK or
 * (sourceId, targetId, relation) tuple). NEVER a scan. If a future
 * operationKind needs an expensive probe, gate it behind an index
 * BEFORE wiring the verifier — see the scope-guard note in
 * lore-phase6-spec-2026-05-21/O6-outbox-self-heal.md.
 *
 * Never throws — a verifier hook that errors degrades to
 * { verified: false, reason: 'verifier-threw' } so self-heal stays
 * safe on a misbehaving substrate.
 */
export async function verifyApplied(
    entry: OutboxEntry,
    substrates: DispatcherSubstrates,
): Promise<VerifyOutcome> {
    const kind = entry.operationKind;
    if (!kind) return { verified: false, reason: 'no-operation-kind' };
    const payload = entry.payload ?? {};
    // SP-F3 — probe the TARGET workspace's substrates, not the boot ones.
    const ws = entry.workspace;
    try {
        switch (kind) {
            case 'node.upsert': {
                const id = payload['id'];
                if (typeof id !== 'string' || !id) return { verified: false, reason: 'missing-id' };
                // 2.4 — when the payload carries content, existence proves
                // nothing (an update target exists whether or not the edit
                // landed). Compare the content-bearing fields against the
                // substrate row; fail loud when no witness hook is wired.
                const witnessFields = NODE_CONTENT_WITNESS_FIELDS.filter((f) => typeof payload[f] === 'string');
                if (witnessFields.length > 0) {
                    if (!substrates.getNode) return { verified: false, reason: 'content-witness-unwired' };
                    const node = await substrates.getNode(id, ws);
                    if (!node) return { verified: false, reason: 'substrate-missing-node' };
                    for (const f of witnessFields) {
                        if (String(node[f] ?? '') !== String(payload[f])) {
                            return { verified: false, reason: 'substrate-content-stale' };
                        }
                    }
                    return { verified: true, reason: 'substrate-content-matches' };
                }
                // Identity-only payload — existence is a sound witness.
                if (!substrates.hasNode) return { verified: false, reason: 'no-verifier-wired' };
                const ok = await substrates.hasNode(id, ws);
                return { verified: ok, reason: ok ? 'substrate-has-node' : 'substrate-missing-node' };
            }
            case 'edge.upsert': {
                if (!substrates.hasEdge) return { verified: false, reason: 'no-verifier-wired' };
                const sourceId = payload['sourceId'];
                const targetId = payload['targetId'];
                const relation = payload['relation'];
                if (typeof sourceId !== 'string' || typeof targetId !== 'string' || typeof relation !== 'string') {
                    return { verified: false, reason: 'missing-edge-triple' };
                }
                const fwd = await substrates.hasEdge({ sourceId, targetId, relation }, ws);
                if (!fwd) return { verified: false, reason: 'substrate-missing-edge' };
                // 2.2 (2026-08-17) — a bidirectional row is fully applied only
                // when BOTH directions landed. Probing just the forward triple
                // confirmed half-applied rows as 'substrate-has-edge' and the
                // self-heal sweep marked them replicated with the reverse
                // direction permanently missing.
                if (payload['bidirectional'] !== false) {
                    const rev = await substrates.hasEdge({ sourceId: targetId, targetId: sourceId, relation }, ws);
                    if (!rev) return { verified: false, reason: 'substrate-missing-reverse-edge' };
                }
                return { verified: true, reason: 'substrate-has-edge' };
            }
            case 'node.delete': {
                if (!substrates.hasNode) return { verified: false, reason: 'no-verifier-wired' };
                const id = payload['id'];
                if (typeof id !== 'string' || !id) return { verified: false, reason: 'missing-id' };
                const present = await substrates.hasNode(id, ws);
                // node.delete is "verified" when substrate confirms ABSENCE.
                return { verified: !present, reason: present ? 'substrate-still-has-node' : 'substrate-confirms-deleted' };
            }
            case 'edge.delete': {
                if (!substrates.hasEdge) return { verified: false, reason: 'no-verifier-wired' };
                const sourceId = payload['sourceId'];
                const targetId = payload['targetId'];
                const relation = payload['relation'];
                if (typeof sourceId !== 'string' || typeof targetId !== 'string' || typeof relation !== 'string') {
                    return { verified: false, reason: 'missing-edge-triple' };
                }
                const present = await substrates.hasEdge({ sourceId, targetId, relation }, ws);
                return { verified: !present, reason: present ? 'substrate-still-has-edge' : 'substrate-confirms-edge-deleted' };
            }
            case 'node.mark_stale': {
                // 2026-09-03 (X-markstale audit fix) — verified when EVERY id in
                // the chunk is either stale=true or absent (deleted since the
                // row was recorded — nothing left to mark, not a failure).
                // Reuses the existing content-witness `getNode` hook rather than
                // adding a new verifier — no new substrate surface needed.
                const rawIds = (payload as { ids?: unknown }).ids;
                const ids = Array.isArray(rawIds) ? rawIds.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
                if (ids.length === 0) return { verified: false, reason: 'missing-ids' };
                if (!substrates.getNode) return { verified: false, reason: 'content-witness-unwired' };
                for (const id of ids) {
                    const node = await substrates.getNode(id, ws);
                    if (node && node['stale'] !== true) {
                        return { verified: false, reason: 'substrate-not-stale' };
                    }
                }
                return { verified: true, reason: 'substrate-marked-stale-or-absent' };
            }
            case 'verbatim.upsert': {
                const id = payload['id'];
                if (typeof id !== 'string' || !id) return { verified: false, reason: 'missing-id' };
                // 2.4 — contentHash witness: a dead row carrying 'BRAND NEW
                // TEXT' over an existing 'OLD TEXT' row must NOT heal on
                // existence alone.
                const expected = expectedVerbatimHash(payload);
                if (expected) {
                    if (!substrates.getVerbatim) return { verified: false, reason: 'content-witness-unwired' };
                    const row = await substrates.getVerbatim(id, ws);
                    if (!row) return { verified: false, reason: 'substrate-missing-verbatim' };
                    return storedVerbatimHash(row) === expected
                        ? { verified: true, reason: 'substrate-content-matches' }
                        : { verified: false, reason: 'substrate-content-stale' };
                }
                if (!substrates.hasVerbatim) return { verified: false, reason: 'no-verifier-wired' };
                const ok = await substrates.hasVerbatim(id, ws);
                return { verified: ok, reason: ok ? 'substrate-has-verbatim' : 'substrate-missing-verbatim' };
            }
            case 'verbatim.tombstone': {
                // 2026-09-03 (A2 finding 2 fix). Verified when the substrate
                // row is either absent (physically reaped elsewhere) or
                // carries the '[TOMBSTONED' marker `VerbatimStore.tombstone`
                // writes — mirrors node.delete's "verified iff absent" shape.
                const id = payload['id'];
                if (typeof id !== 'string' || !id) return { verified: false, reason: 'missing-id' };
                if (!substrates.getVerbatim) return { verified: false, reason: 'content-witness-unwired' };
                const row = await substrates.getVerbatim(id, ws);
                if (!row) return { verified: true, reason: 'substrate-missing-verbatim' };
                const tombstoned = typeof row.text === 'string' && row.text.startsWith('[TOMBSTONED');
                return { verified: tombstoned, reason: tombstoned ? 'substrate-tombstoned' : 'substrate-still-live' };
            }
            case 'verbatim.upsert.batch': {
                // SP-13 — self-heal a consolidated verbatim batch by probing
                // every item's id; verified only when ALL are present AND
                // (2.4) every content-bearing item's stored contentHash
                // matches the payload's.
                const raw = payload['items'];
                const items = Array.isArray(raw)
                    ? raw.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
                    : [];
                const ids = items.map((it) => it['id']).filter((x): x is string => typeof x === 'string' && !!x);
                if (ids.length === 0) return { verified: false, reason: 'missing-ids' };
                if (substrates.getVerbatim) {
                    for (const it of items) {
                        const id = typeof it['id'] === 'string' ? it['id'] : '';
                        if (!id) return { verified: false, reason: 'missing-ids' };
                        const row = await substrates.getVerbatim(id, ws);
                        if (!row) return { verified: false, reason: 'substrate-missing-verbatim' };
                        const expected = expectedVerbatimHash(it);
                        if (expected && storedVerbatimHash(row) !== expected) {
                            return { verified: false, reason: 'substrate-content-stale' };
                        }
                    }
                    return { verified: true, reason: 'substrate-content-matches' };
                }
                if (!substrates.hasVerbatim) return { verified: false, reason: 'no-verifier-wired' };
                for (const id of ids) {
                    if (!(await substrates.hasVerbatim(id, ws))) {
                        return { verified: false, reason: 'substrate-missing-verbatim' };
                    }
                }
                return { verified: true, reason: 'substrate-has-verbatim' };
            }
            case 'embed.batch': {
                const raw = payload['targetNodeIds'];
                const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
                if (ids.length === 0) return { verified: false, reason: 'missing-target-ids' };
                // 2.4 — content witness. hasEmbeddings only proves A verbatim
                // row exists per id, so a failed re-embed (e.g. after an
                // embedding-model change) was confirmed 'has-embeddings' by
                // the STALE vector it was meant to replace. The production
                // storeEmbedBatch persists contentHash = hash(text) (see
                // outbox/wiring.ts), so the payload's texts are the witness.
                const rawTexts = payload['texts'];
                const texts = Array.isArray(rawTexts) ? rawTexts.filter((x): x is string => typeof x === 'string') : [];
                if (texts.length === ids.length && substrates.getVerbatim) {
                    for (let i = 0; i < ids.length; i++) {
                        const row = await substrates.getVerbatim(ids[i]!, ws);
                        if (!row) return { verified: false, reason: 'substrate-missing-embeddings' };
                        if (storedVerbatimHash(row) !== computeContentHash(texts[i]!)) {
                            return { verified: false, reason: 'substrate-content-stale' };
                        }
                    }
                    return { verified: true, reason: 'substrate-content-matches' };
                }
                if (!substrates.hasEmbeddings) return { verified: false, reason: 'no-verifier-wired' };
                const ok = await substrates.hasEmbeddings(ids, ws);
                return { verified: ok, reason: ok ? 'substrate-has-embeddings' : 'substrate-missing-embeddings' };
            }
            case 'sync.vector.mirror':
            case 'embed.done':
            case 'load.received':
            case 'load.done':
            case 'migration.started':
            case 'migration.applied':
            case 'migration.failed':
            case 'stream.event':
                // Non-self-healable kinds: sync.vector.mirror is a
                // recovery primitive that doesn't carry id-shaped state
                // we can probe cheaply; embed.done is a marker write;
                // load.received (Sprint Z1) is a notification marker —
                // its only side effect is a temp file on disk which
                // load_jobs.temp_file_path tracks separately.
                return { verified: false, reason: 'kind-not-self-healable' };
            default: {
                const _exhaustive: never = kind;
                return { verified: false, reason: `unknown-kind-${_exhaustive}` };
            }
        }
    } catch (err) {
        return { verified: false, reason: `verifier-threw:${(err as Error).message.slice(0, 80)}` };
    }
}

/**
 * nodeService.ts — transport-agnostic guarded node-write orchestration.
 *
 * W3-SERVICE-LAYER. The guarded node-write sequence — vocab-policy verdict,
 * outbox-first hot write + verbatim fan-out + rollback, optional WAL append,
 * version record, and ingest-time autolink — used to be coded TWICE and
 * divergently: once in the MCP `store_node` tool
 * (mcp/tools/memory/storeNode.ts) and again in the REST route
 * (mcp/http/routes/nodes/postNode.ts). `LoreStorageClient` only exposed
 * substrate primitives, so the in-process API was strictly weaker than
 * HTTP/MCP.
 *
 * Verbatim fan-out + TW-4a rollback live in `nodeServiceVerbatim.ts`
 * (file-size split). This module owns the rest of the orchestration as a
 * pure data-in / data-out function:
 *   - `nodeUpsert(deps, args): Promise<NodeWriteResult>` — no req/res, no MCP
 *     envelope. The two transport handlers resolve their own gauntlet (ReBAC,
 *     MCP scope, principal default, quota, backpressure, body parsing,
 *     changeset buffering — all transport-specific and intentionally NOT
 *     shared) and then delegate the actual write to this one path.
 *   - `resolveVocabVerdict(...)` — the shared vocab-policy lookup. Each
 *     transport shapes the verdict into its own envelope (MCP `{content,
 *     isError}` vs HTTP status codes), but the policy decision itself is
 *     computed identically here.
 *
 * Cloud invariant (DEC-CLOUD-READY): every write here routes through the
 * caller-supplied `targetGraph` (LocalGraph or DataplaneGraph), the
 * `OutboxStore`, and the storage-client verbatim facade — all of which
 * support local AND cloud mode. Nothing here is hard-wired to local-only.
 * The autolink hook is the one local-only optimisation today (reconnect is
 * not yet Dataplane-native), gated behind `autolink` being supplied AND
 * `isActiveWorkspace`, exactly as the MCP tool gated it before.
 */

import { randomUUID } from 'node:crypto';
import { tagsToArray } from '../engines/normalizeTags.js';
import { assertSafeLanceId } from '../engines/verbatimHistory.js';
import { reconnectOneNode } from '../engines/reconnect.js';
import { defaultAutolinkTracker, PendingAutolinkTracker } from '../engines/pendingAutolink.js';
import { redactId, redactError } from '../security/logRedact.js';
import { CAPPED_NODE_TEXT_FIELDS, MAX_NODE_FIELD_BYTES, exceedsNodeFieldCap } from '../engines/nodeFieldLimits.js';
import { log } from '../logger.js';
import { recordHotWrite } from '../outbox/hotLane.js';
import { KeyedMutex } from '../engines/writeQueue.js';
import { applyVerbatimFanout, rollbackPartialWrite } from './nodeServiceVerbatim.js';
import {
    checkVocab,
    type VocabCheckResult,
} from '../engines/vocabPolicy.js';
import { getWorkspaceVocabPolicy } from '../config/workspaces.js';
import type { LoreNode } from '../providers/types.js';
import type { OutboxStore } from '../outbox/types.js';
import type { VersionStore } from '../outbox/versionStore.js';
import type { WriteAheadLog } from '../engines/syncEngine.js';

/* ─── Minimal substrate contracts (local | cloud) ──────────────────── */

/** The subset of a graph the write core needs. Both LocalGraph and
 *  DataplaneGraph satisfy this — no cloud hard-wiring. */
export interface NodeWriteGraph {
    upsertNode(node: Record<string, unknown>): Promise<LoreNode>;
    deleteNode(id: string): Promise<unknown>;
    /** Optional read-back used to mirror the existing row's security_scopes
     *  onto the verbatim row (2.1/2.2). Both LocalGraph and DataplaneGraph
     *  satisfy it; minimal test fakes may omit it (falls back to []). */
    getNode?(id: string): Promise<LoreNode | null>;
}

/** The subset of the storage-client facade used for the inline (no-outbox)
 *  verbatim path. Mirrors LoreStorageClient.verbatimStore. */
export interface VerbatimWriter {
    verbatimStore(write: {
        id: string;
        text: string;
        metadata: Record<string, unknown>;
    }): Promise<unknown>;
}

/** Local graph + verbatim handles the autolink (reconnect) hook reads from.
 *  Supplied only when the write landed in the active local workspace. */
export interface AutolinkHandles {
    graph: Parameters<typeof reconnectOneNode>[0];
    verbatim: Parameters<typeof reconnectOneNode>[1];
    /**
     * The OWNING Lore instance's in-flight autolink registry (lives on the
     * StorageBundle — one per `createLore()`). REQUIRED, not optional: the
     * fire-and-forget hook below is only drainable because something holds a
     * handle on it, and a call site that quietly omitted the tracker would
     * re-open the exact use-after-close race pendingAutolink.ts exists to
     * close — silently, since the write still returns ok. Making it required
     * puts that check on tsc instead of on a reviewer. Test callers that
     * construct handles by hand fall back to `defaultAutolinkTracker` at
     * runtime.
     */
    tracker: PendingAutolinkTracker;
}

/**
 * resolveAutolinkHandles — the ONE copy of the per-workspace autolink wiring
 * every write surface shares: the REST POST /api/node route
 * (mcp/http/routes/nodes/postNode.ts), the MCP store_node tool
 * (mcp/tools/memory/storeNode.ts), and the embedded lib:nodeUpsert /
 * lib:nodeUpsertBatch wrappers (mcp/server.ts).
 *
 * 2026-08-19 (launch-readiness backlog item 4 follow-up) — this block used to
 * be FOUR inline copies of the same "Audit fix #5" resolution. The original
 * defect (REST never fired autolink at all, so REST-written nodes were
 * permanently edgeless while identical MCP writes were not) existed precisely
 * because the wiring lived per-surface and drifted; one shared function makes
 * the next drift a deliberate edit here instead of a silent per-surface
 * omission. The REST-vs-MCP runtime parity is pinned by
 * test/rest-mcp-autolink-parity-e2e.ts.
 *
 * Semantics (unchanged from all four prior copies): default to the BOOT
 * store's graph + verbatim; when a per-workspace verbatim resolver is wired
 * (local multi-workspace), open the TARGET workspace's verbatim store and
 * pair it with the caller's already-resolved target graph. A resolver failure
 * falls back to the boot stores — autolink is a best-effort hook and must
 * never fail the write.
 */
export async function resolveAutolinkHandles(opts: {
    /** Boot-bound fallback graph, used when no per-workspace resolver is wired. */
    bootGraph: AutolinkHandles['graph'];
    /** Boot-bound fallback verbatim store. */
    bootVerbatim: AutolinkHandles['verbatim'];
    /** Per-workspace verbatim resolver, when wired (absent in cloud mode). */
    resolver?: { getOrOpen(workspace: string): Promise<AutolinkHandles['verbatim']> } | null;
    /** The workspace the write TARGETS. */
    workspace: string;
    /** The caller's already-resolved target-workspace graph. */
    targetGraph: AutolinkHandles['graph'];
    tracker: PendingAutolinkTracker;
}): Promise<AutolinkHandles> {
    let graph = opts.bootGraph;
    let verbatim = opts.bootVerbatim;
    if (opts.resolver) {
        try {
            verbatim = await opts.resolver.getOrOpen(opts.workspace);
            graph = opts.targetGraph;
        } catch { /* fall back to boot stores */ }
    }
    return { graph, verbatim, tracker: opts.tracker };
}

/* ─── Inputs / outputs ─────────────────────────────────────────────── */

/**
 * Fully-resolved node-write request. The CALLER has already run its
 * transport gauntlet and resolved the target graph + workspace. The
 * `nodeData` is the exact record handed to `targetGraph.upsertNode`
 * (identity fields + project/ecosystem normalised) — the write core does
 * not re-derive it so both transports keep their existing field shapes.
 */
export interface NodeUpsertArgs {
    /** The id being written (for verbatim key + version + autolink + logs). */
    id: string;
    /** Resolved workspace the write targets (outbox routing + version). */
    workspace: string;
    /** Resolved ecosystem (verbatim metadata + autolink). */
    ecosystem: string;
    /** The exact record passed to `targetGraph.upsertNode`. */
    nodeData: Record<string, unknown>;
    /** Resolved target graph (LocalGraph | DataplaneGraph). */
    targetGraph: NodeWriteGraph;
    /** Identifies the caller in outbox initiator + version principal. */
    initiator: string;

    /** `embed: false` → graph row only, no verbatim/autolink. */
    skipEmbed?: boolean;
    /** `async_embed: true` → enqueue verbatim instead of synchronous write
     *  (only honoured when `embedQueue` is supplied). */
    asyncEmbed?: boolean;

    /** Whether the write landed in the active workspace — gates WAL append
     *  + autolink, exactly as the MCP tool did (P1.C scope). */
    isActiveWorkspace?: boolean;
}

/** Optional orchestration hooks. Each transport wires the subset it used
 *  before; absent hooks reproduce the prior "feature not wired" branch. */
export interface NodeUpsertHooks {
    /** Outbox hot-lane store. When wired, node.upsert + verbatim.upsert
     *  rows are recorded BEFORE substrate writes (durability + replay +
     *  per-workspace replication). Absent → inline verbatim write. */
    outboxStore?: OutboxStore;
    /** Async-embed queue (gap #2). Used only when `args.asyncEmbed`.
     *  RC-round4: the 3rd `workspace` arg is REQUIRED-in-spirit for local
     *  multi-app mode — without it the EmbedQueue executor's resolveStores
     *  can't route the embed to the requested workspace's LanceDB and falls
     *  back to the boot store. Optional in the type only so cloud/test
     *  fixtures that never pass a non-active workspace still satisfy it. */
    embedQueue?: { enqueue: (nodeId: string, text: string, workspace?: string) => void };
    /** Inline verbatim writer (storage-client facade). Used only when no
     *  outbox is wired and embedding is not skipped/async. */
    verbatim?: VerbatimWriter;
    /**
     * Primary verbatim write that still runs when `outboxStore` is wired.
     * Cloud mode records `verbatim.upsert` for durability, but the
     * replicator leaves `getVerbatim` undefined (it must not re-apply
     * into a boot LanceDB). Without this hook the outbox row dead-letters
     * and Dataplane never sees the vector. Local HTTP leaves this unset
     * so the replicator remains the one writer. */
    inlineVerbatim?: VerbatimWriter;
    /** WAL handle. When supplied AND the write is active-workspace, an
     *  `upsert_node` entry is appended after both stores succeed. */
    getWal?: () => WriteAheadLog;
    /** Version store. When supplied, records a version (non-fatal). The
     *  caller pre-reads previous state and passes it as `previousState`. */
    versionStore?: VersionStore;
    /** Previous node state captured by the caller for the version record. */
    previousState?: LoreNode | null;
    /** Principal string stamped on the version record. The MCP tool used
     *  the literal `'mcp'`; defaults to that when omitted so the version
     *  shape is unchanged. */
    versionPrincipal?: string;
    /** Local autolink handles (reconnect). Supplied only when the write is
     *  active-workspace local mode AND embedding is not skipped. */
    autolink?: AutolinkHandles;
}

/** Discriminated result. Plain data — no transport envelope. */
export type NodeWriteResult =
    | {
          ok: true;
          /** The upserted node as returned by the graph layer. */
          node: LoreNode;
      }
    | {
          ok: false;
          /** Stable, branchable failure code. */
          code: 'verbatim_unavailable' | 'invalid_node_id' | 'field_too_large' | 'write_failed';
          /** Underlying error (already logged + rolled back here). */
          error: Error;
      };

/* ─── Vocab-policy verdict (shared lookup, transport-shaped envelope) ─ */

export type VocabVerdict =
    | { decision: 'accept' }
    | { decision: 'warn'; reason: string | undefined }
    | { decision: 'reject'; result: VocabCheckResult }
    | { decision: 'hitl'; reason: string | undefined; hint?: string };

/**
 * Run the per-workspace vocab policy for `type`. Returns a transport-neutral
 * verdict; the caller shapes it (MCP envelope vs HTTP status). Soft policy-
 * read failures (e.g. workspaces.json edited mid-request) downgrade to
 * `accept` after logging — identical to both prior call sites.
 */
export function resolveVocabVerdict(input: {
    workspace: string;
    type: string;
    coreTypes: ReadonlyArray<string>;
    logPrefix: string;
}): VocabVerdict {
    try {
        const policy = getWorkspaceVocabPolicy(input.workspace);
        const verdict = checkVocab({
            policy,
            type: input.type,
            coreTypes: input.coreTypes,
        });
        if (verdict.decision === 'reject') return { decision: 'reject', result: verdict };
        if (verdict.decision === 'hitl') {
            return { decision: 'hitl', reason: verdict.reason, ...(verdict.hint ? { hint: verdict.hint } : {}) };
        }
        if (verdict.decision === 'warn') return { decision: 'warn', reason: verdict.reason };
        return { decision: 'accept' };
    } catch (policyErr) {
        log.error(
            `${input.logPrefix} vocab policy lookup failed for "${input.workspace}" (non-fatal): ${(policyErr as Error).message}`,
        );
        return { decision: 'accept' };
    }
}

/* ─── The guarded write core ────────────────────────────────────────── */

/**
 * Per-(workspace,id) write-ordering lock for `nodeUpsert`'s externally
 * visible write sequence (outbox `node.upsert` record → graph upsert →
 * verbatim/vector fan-out — steps 1-3 below). MUST be a module-level
 * singleton: constructing a fresh `KeyedMutex` per call is a no-op lock
 * (nothing to chain against). Keyed by `workspace + id`, not `id` alone,
 * so concurrent writes to the SAME id in DIFFERENT workspaces never
 * contend with each other — this matters because `DataplaneGraph` (cloud)
 * is one shared instance routing many tenants via AsyncLocalStorage, not
 * one instance per workspace the way `SurrealGraph` is.
 *
 * Root cause this closes: before this lock, only step 2
 * (`targetGraph.upsertNode`) was serialized per id — and only on
 * `SurrealGraph`, via its own private `nodeWriteChain` (writeQueue.ts).
 * Steps 1 and 3 ran completely unserialized relative to each other AND to
 * step 2's ordering, so two concurrent same-id `nodeUpsert()` calls could
 * apply their graph writes (step 2) in one order and their verbatim/vector
 * writes (step 3) in the OPPOSITE order — a durable split-brain where the
 * graph holds one caller's content and the verbatim/search mirror holds
 * the other's, with BOTH callers seeing `ok: true`. Widening the lock to
 * cover the whole step 1-3 sequence forces one strict, shared order across
 * all three substrates for a given id. `SurrealGraph.nodeWriteChain` stays
 * in place underneath as harmless defense-in-depth for callers that reach
 * `upsertNode`/`deleteNode` directly without going through this
 * orchestration (e.g. `bulkUpsertNodes` — a separate, NOT-yet-covered
 * write surface; see bulkWrite.ts / bulkLoader/surrealAdapter.ts).
 */
const nodeUpsertLock = new KeyedMutex();

/**
 * nodeUpsert — outbox-first guarded node write shared by store_node (MCP)
 * and POST /api/node (REST). Behaviour is identical to the prior inline
 * implementations; this is a straight extraction.
 *
 * Order of operations (unchanged from both prior handlers):
 *   1. Outbox `node.upsert` row (when outbox wired) — BEFORE the substrate
 *      write so a crash mid-write leaves a recoverable, replicated trail.
 *   2. `targetGraph.upsertNode(nodeData)`.
 *   3. Verbatim fan-out under the canonical `lore:<id>` key:
 *        - skipEmbed → nothing (graph-only node).
 *        - asyncEmbed + embedQueue → enqueue; consistency sweeper heals drift.
 *        - outbox wired → record `verbatim.upsert`; rollback graph on failure.
 *        - else → inline `verbatim.verbatimStore`; rollback graph on failure.
 *      On verbatim failure BOTH traces are retracted (the graph node is
 *      deleted AND the node.upsert outbox row is removed so the replicator
 *      can't resurrect it) and `{ ok: false }` is returned — NO partial
 *      state. If a retraction itself fails, nodeUpsert THROWS rather than
 *      masking the orphan as a clean handled failure (TW-4a).
 *   4. WAL append (active-workspace only, when wired).
 *   5. Version record (non-fatal, when wired).
 *   6. Ingest-time autolink (active-workspace local, when supplied + !skipEmbed).
 */
export async function nodeUpsert(
    args: NodeUpsertArgs,
    hooks: NodeUpsertHooks = {},
): Promise<NodeWriteResult> {
    const { id, workspace, ecosystem, nodeData, targetGraph, initiator } = args;
    const skipEmbed = args.skipEmbed === true;
    const logPrefix = `[Lore] ${initiator}`;

    // 0. Validate the node id at the SHARED chokepoint. The verbatim row is
    //    keyed `lore:<id>` and assertSafeLanceId-guarded on every write/replay;
    //    an id with unsafe chars (' ( ; etc.) would let the graph node persist
    //    while the verbatim.upsert can NEVER apply — a durable orphan the caller
    //    saw as success. The HTTP (postNode) and MCP (store_node) surfaces guard
    //    up front, but the in-process nodeUpsert() bypassed them; validating here
    //    means all three surfaces inherit it. Fail BEFORE any write.
    try {
        assertSafeLanceId(id, 'nodeService.nodeUpsert');
    } catch (e) {
        return { ok: false, code: 'invalid_node_id', error: e as Error };
    }

    // 0b. Per-field size cap (audit fix #2). Every transport lands here —
    //     MCP store_node, REST postNode, the embedded createLore() nodeUpsert,
    //     and bulk ingest. Capping at the shared chokepoint means a caller
    //     that bypasses Zod (the embedded library API has no schema) is still
    //     bounded. Fail BEFORE any write, naming the offending field.
    for (const field of CAPPED_NODE_TEXT_FIELDS) {
        const v = nodeData[field];
        if (exceedsNodeFieldCap(v)) {
            return {
                ok: false,
                code: 'field_too_large',
                error: new Error(
                    `node field '${field}' exceeds the ${MAX_NODE_FIELD_BYTES}-byte limit`,
                ),
            };
        }
    }

    // 0c. Merge the top-level `id` into `nodeData` when nodeData omits it,
    //     and REFUSE the write when the two disagree. `id` is a required
    //     top-level arg (validated at step 0) but `targetGraph.upsertNode`
    //     keys on `nodeData.id` — before this fix the two were never
    //     reconciled, so the embedded library's own documented quick-start
    //     shape, `nodeUpsert({ id, workspace, ecosystem, nodeData: { type,
    //     label, content } })`, threw `invalid_node_id: expected a string,
    //     received undefined` at the graph layer (both engines require
    //     `nodeData.id`; SurrealDB's toNodeRid rejects undefined outright).
    //     The MCP (store_node) and REST (postNode) surfaces already build
    //     nodeData with `id` populated, so this changes nothing for them.
    //
    //     WHY mismatch is a refusal, not the silent nodeData-wins treatment
    //     `project`/`ecosystem` get below: those are classification tags — a
    //     disagreement mislabels a node. `id` is the node's IDENTITY across
    //     ALL THREE substrates, and this function derives it from the
    //     TOP-LEVEL arg everywhere else: the verbatim row is keyed
    //     `lore:<id>`, the outbox/version/audit records name `id`, and
    //     callers read back by `id`. Silently persisting under nodeData.id
    //     (the pre-fix behavior) therefore wrote the graph row under one id
    //     and the verbatim mirror under ANOTHER — a cross-substrate
    //     split-brain the caller saw as ok:true. Standing rule: a silent
    //     wrong answer is worse than an error, so both-present-but-unequal
    //     fails BEFORE any write. An identical duplicate (every existing
    //     caller) is left untouched. Error message names both ids truncated
    //     + JSON-escaped, matching assertSafeLanceId's attributable-refusal
    //     style.
    {
        const dataId = (nodeData as Record<string, unknown>).id;
        if (dataId === undefined || dataId === null || dataId === '') {
            (nodeData as Record<string, unknown>).id = id;
        } else if (dataId !== id) {
            const shown = (v: unknown) => JSON.stringify(typeof v === 'string' ? v.slice(0, 120) : v);
            return {
                ok: false,
                code: 'invalid_node_id',
                error: new Error(
                    `node id mismatch: top-level id (value: ${shown(id)}) disagrees with nodeData.id (value: ${shown(dataId)}) — pass ONE id, or the same id in both places`,
                ),
            };
        }
    }

    // #1 — default `project` to the resolved workspace at the shared
    // chokepoint, so one write path cannot disagree with another about what a
    // node's `project` is when the caller didn't say. `store_node` already set
    // project=scopedWorkspace while postNode / bulk-write / embedded
    // nodeUpsert passed the raw body through, leaving HTTP-written nodes on
    // the `'*'` schema default; the two populations then sorted, grouped and
    // reported differently for no reason the caller could see. A caller's
    // explicit non-default project is preserved.
    //
    // R5 #7 — the ORIGINAL justification here is dead and must not be revived:
    // it claimed the enumeration routes (GET /api/nodes, bulk-list) and the
    // MCP list/inspect tools all filtered nodes on project == the workspace
    // name. They no longer do — and the claim was written in the SAME
    // uncommitted batch that deleted those filters.
    // DEC-SCOPE-HONESTY removed that filter from GET /api/nodes, POST
    // /api/nodes/bulk-list, GET /api/node-list, MCP `list_nodes` and five more
    // sites, on the grounds that the workspace name is NEVER a valid `project`
    // value (Atlas stores project='v3' inside workspace='default') and the
    // physical boundary is the resolved graph — each workspace is its own
    // database. So this default is a NORMALISATION, not a read-visibility
    // dependency: no read filters on it, and nothing here may be cited as
    // evidence that one does.
    {
        const proj = (nodeData as Record<string, unknown>).project;
        if (typeof proj !== 'string' || proj.length === 0 || proj === '*') {
            (nodeData as Record<string, unknown>).project = workspace;
        }
    }

    // 4.1 (2026-08-17, functional-correctness) — `ecosystem` is a REQUIRED
    // top-level arg to nodeUpsert, but before this fix it was used for
    // autolink + outbox routing ONLY and never reached `targetGraph.
    // upsertNode`, so the graph column fell to its schema default '*'
    // (unscoped — every ecosystem-confined recall then saw it). The MCP
    // (store_node) and REST (postNode) surfaces already build nodeData with
    // `ecosystem` populated, so this only changes behavior for callers that
    // omit it — chiefly the embedded library's own documented quick-start
    // shape, `nodeUpsert({ id, workspace, ecosystem, nodeData: { type,
    // label, content } })`. Same normalization pattern as `project` above:
    // default when omitted, never override an explicit value.
    {
        const eco = (nodeData as Record<string, unknown>).ecosystem;
        if (typeof eco !== 'string' || eco.length === 0) {
            (nodeData as Record<string, unknown>).ecosystem = ecosystem;
        }
    }

    // Bulk-write-fan-out bug audit (2026-08-21) — `content` is optional on
    // the legal POST /api/node surface (a node can be created with no body
    // text), but `targetGraph.upsertNode` below wrote whatever came through
    // verbatim, including `undefined`. LocalGraph's Cypher tolerates a NULL
    // `content` column; SurrealDB does not — `search()`'s
    // `string::lowercase(content)` throws `Incorrect arguments for function
    // string::lowercase(). Expected string but found NONE` the moment ANY
    // node in the workspace has a NONE content field, taking down search for
    // the whole workspace, not just that node. Coerced here (not only at the
    // later verbatim-text step, `String(nodeData.content ?? '')` below) so
    // the graph row itself never carries NONE/undefined content on either
    // engine — same normalize-once-at-the-boundary shape as `project`/
    // `ecosystem` above.
    {
        const content = (nodeData as Record<string, unknown>).content;
        if (typeof content !== 'string') {
            (nodeData as Record<string, unknown>).content = content == null ? '' : String(content);
        }
    }

    // 2.1/2.2 (2026-08-17) — the verbatim/vector mirror must carry the node's
    // effective security_scopes, or row-level scope filtering fails open on the
    // primary surfaces (store_node / POST /api/node never send scopes). Read the
    // existing row's scopes once when the caller omitted them, so the verbatim
    // metadata mirrors the graph row instead of defaulting to [].
    if (nodeData['security_scopes'] === undefined && typeof targetGraph.getNode === 'function') {
        try {
            nodeData['security_scopes'] = (await targetGraph.getNode(id))?.security_scopes ?? [];
        } catch {
            nodeData['security_scopes'] = [];
        }
    }

    // 1-3. Outbox `node.upsert` record → substrate graph upsert →
    //      verbatim/vector fan-out. These are the three externally-visible
    //      writes of a node write; they now run under ONE per-(workspace,id)
    //      lock (`nodeUpsertLock`, defined above) so two concurrent calls
    //      for the same id cannot land their graph and verbatim/vector
    //      writes in different relative orders (split-brain — see the lock's
    //      doc comment for the full root-cause account).
    const lockKey = `${workspace}\u0000${id}`;
    const writeOutcome = await nodeUpsertLock.run(lockKey, async (): Promise<{ node: LoreNode } | { verbatimError: Error }> => {
        // 1. Outbox-first node.upsert (durability + replay + per-workspace replication).
        //    TW-4a — capture the recorded entry so the verbatim-failure rollback
        //    below can RETRACT it. Without this, deleting the graph node on a
        //    verbatim failure left the node.upsert row pending; the replicator then
        //    re-applied it (dispatcher case 'node.upsert'), resurrecting a graph-
        //    only orphan — the exact partial state the rollback claims to prevent.
        let nodeUpsertOutboxEntryId: string | null = null;
        if (hooks.outboxStore) {
            const nodeUpsertEntry = await recordHotWrite(hooks.outboxStore, {
                workspace,
                operationKind: 'node.upsert',
                payload: nodeData,
                initiator,
                operation: 'graph.upsert',
            });
            nodeUpsertOutboxEntryId = nodeUpsertEntry.id;
        }

        // 2. Substrate graph upsert.
        //    2.1 (2026-08-17 functional-correctness) — this call previously had
        //    NO failure handling: when it threw (e.g. a SurrealDB transaction
        //    conflict under concurrent writes), the caller was told the write
        //    FAILED, step 3 never ran, and the step-1 node.upsert outbox row was
        //    never retracted — the replicator later replayed it, creating the
        //    node anyway with NO verbatim row (permanently invisible to semantic
        //    recall). Route the failure through the SAME retraction mechanism
        //    the step-3 verbatim-failure path uses (rollbackPartialWrite), so
        //    both failure paths behave identically: graph node deleted (no-op
        //    cleanup of any partial row on a failed create) + outbox row
        //    retracted (or a compensating node.delete recorded when the
        //    replicator already claimed it, C-R2-03).
        let node: LoreNode;
        try {
            node = await targetGraph.upsertNode(nodeData);
        } catch (graphErr) {
            log.error(`${logPrefix} graph upsert failed for ${redactId(id)}: ${redactError(graphErr)} — retracting the node.upsert outbox row so the replicator cannot replay a write the caller was told failed`);
            await rollbackPartialWrite({
                id,
                workspace,
                initiator,
                logPrefix,
                targetGraph,
                outboxStore: hooks.outboxStore,
                nodeUpsertOutboxEntryId,
                verbatimError: graphErr as Error,
            });
            throw graphErr;
        }

        // 3. Verbatim fan-out (canonical `lore:<id>` key) + rollback on failure.
        //    Lives in nodeServiceVerbatim.ts (file-size split).
        const verbatimWriteFailed = await applyVerbatimFanout({
            skipEmbed,
            asyncEmbed: args.asyncEmbed,
            id,
            workspace,
            initiator,
            logPrefix,
            node,
            nodeData,
            targetGraph,
            hooks,
            nodeUpsertOutboxEntryId,
        });
        if (verbatimWriteFailed) {
            return { verbatimError: verbatimWriteFailed };
        }
        return { node };
    });
    if ('verbatimError' in writeOutcome) {
        return { ok: false, code: 'verbatim_unavailable', error: writeOutcome.verbatimError };
    }
    const { node } = writeOutcome;

    // 4. WAL append — active-workspace only (P1.C scope), when wired.
    if (args.isActiveWorkspace && hooks.getWal) {
        hooks.getWal().append('upsert_node', { ...node });
    }

    // 5. Version record (non-fatal), when wired.
    if (hooks.versionStore) {
        try {
            hooks.versionStore.recordVersion({
                versionId: randomUUID(),
                nodeId: id,
                workspace,
                timestamp: new Date().toISOString(),
                principal: hooks.versionPrincipal ?? 'mcp',
                operation: 'upsert',
                previousState: hooks.previousState ?? null,
                newState: node,
                changesetId: null,
            });
        } catch { /* non-fatal */ }
    }

    // 6. Ingest-time autolink, when supplied.
    //
    // 2026-08-17 (functional-correctness 1.3/1.4) — this gate used to be
    // `!skipEmbed && args.isActiveWorkspace && hooks.autolink`. Both extra
    // conditions were bugs, not safety checks:
    //   - `!skipEmbed` made the hook UNREACHABLE from bulkIngest, which
    //     always passes `skipEmbed: true` (it embeds separately, later, in
    //     its own batch step) while explicitly requesting `autolink: true`.
    //     Autolink is independent of whether THIS call embeds the node —
    //     it draws similarity edges via its own embed + search, regardless.
    //   - `args.isActiveWorkspace` blocked autolink for every workspace
    //     except the one the daemon booted into, even when the caller (see
    //     mcp/server.ts's embedded nodeUpsert, "Audit fix #5", and
    //     mcp/tools/memory/storeNode.ts's autolink hook) had ALREADY
    //     resolved `hooks.autolink.graph`/`.verbatim` to the correct TARGET
    //     workspace. Every workspace but the boot one silently accumulated
    //     zero semantic edges forever.
    // Callers are still responsible for wiring `hooks.autolink` to the
    // RIGHT workspace's graph/verbatim (both current callers do); this gate
    // no longer second-guesses that by only trusting the boot workspace.
    //
    // Still NOT awaited: autolink costs an extra ONNX embed + vector search
    // per node, and putting that on the synchronous write path is the exact
    // regression bulkIngest.ts exists to avoid. But the promise is now TRACKED
    // on the owning instance's PendingAutolinkTracker so the ordered shutdown
    // drain can await it before Kùzu/LanceDB close. Untracked, a burst of
    // writes followed by dispose() raced the close: reconnect writes died
    // against closed handles inside reconnectOneNode's own swallow-catch and
    // the edges vanished silently.
    //
    // The `isSealed()` guard is the other half, and it must be read BEFORE
    // `reconnectOneNode` is called, not after: once the drain has begun there
    // is nothing useful a new autolink can do — its writes would land on
    // handles about to close — so a late write skips the hook rather than
    // registering doomed work the drain has already walked past. The guard and
    // the `track()` sit in ONE synchronous block (no await between them), so a
    // write is unambiguously either tracked-and-drained or never-started;
    // there is no interleaving in which it is neither. The node's own graph +
    // verbatim writes above are untouched — only the best-effort edge
    // inference is skipped. See engines/pendingAutolink.ts for the rationale.
    if (hooks.autolink) {
        const tracker = hooks.autolink.tracker ?? defaultAutolinkTracker;
        if (!tracker.isSealed()) {
            const label = String(nodeData.label ?? '');
            const content = String(nodeData.content ?? '');
            const tagsArr = tagsToArray(nodeData.tags as string | string[] | null | undefined);
            tracker.track(reconnectOneNode(hooks.autolink.graph, hooks.autolink.verbatim, {
                id,
                label,
                content,
                tags: tagsArr,
                type: String(nodeData.type ?? ''),
                project: workspace,
                ecosystem,
            }, {
                // 3.1 — when this call already wrote (or queued) the
                // canonical verbatim row above (i.e. !skipEmbed), don't let
                // reconnectOneNode write it again — two independent,
                // unserialized writers of the same row produced permanent
                // duplicate canonical rows under concurrency. When skipEmbed
                // is true, step 3 above wrote NOTHING, so reconnectOneNode's
                // own store() is the only writer and must run.
                skipStore: !skipEmbed,
            }).catch((err) => log.error(`${logPrefix} ingest-hook reconnect failed for ${redactId(id)}: ${redactError(err)}`)));
        }
    }

    return { ok: true, node };
}

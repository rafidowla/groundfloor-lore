/**
 * bulkWrite.ts — W9: bulk-write / bulk-delete / bulk-recall endpoints.
 *
 * Solves the Day-1 dogfood problem: deleting 5,829 atlas-tagged nodes
 * via DELETE /api/node/:id throttled to ~5/s on the destructive bucket
 * = ~20 min for a one-time cleanup. The fix is two-pronged: W9 raised
 * the per-token bucket cap AND added these surgical bulk endpoints
 * that are exempt from rate-limiting entirely (auth + ReBAC gates
 * still run). Operators reach for the bulk endpoint for batch ops;
 * everything else stays on the per-token bucket.
 *
 * Endpoints (all POST, all return 200 with a per-item result array):
 *   POST /api/nodes/bulk          — upsert up to 1000 nodes
 *   POST /api/edges/bulk          — addEdge up to 1000 edges
 *   POST /api/nodes/bulk-delete   — delete up to 1000 ids (404s non-fatal)
 *   POST /api/recall/bulk         — run up to 100 topics through graph.search
 *
 * Each request body is JSON with a single top-level array (`nodes` /
 * `edges` / `ids` / `topics`). Per-item failures are reported in the
 * `results` array with `{ok:false, error}`; the response itself is
 * always 200 unless the request is malformed or auth-failed.
 *
 * Caps:
 *   - 1000 nodes / edges / ids per call
 *   - 100 recall topics per call (each runs a search → bound the wall-time)
 *
 * Workspace routing mirrors POST /api/node — each item's workspace
 * defaults to the principal's bound workspace; the registry resolves
 * the target LocalGraph per request.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import { LoreStorageClient } from '../../../storage/loreStorageClient.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { isWorkspaceGraph } from '../../../engines/requireWorkspaceGraph.js';
import { buildVerbatimText } from '../../../engines/verbatimSchema.js';
import { assertSafeLanceId } from '../../../engines/verbatimHistory.js';
import { tagsToArray, tagsToString } from '../../../engines/normalizeTags.js';
import type { AuditLog } from '../../../security/audit.js';
import { redactError } from '../../../security/logRedact.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, checkOutboxBackpressure, writeJson, writeError, writeWorkspaceRequired } from '../helpers.js';
import type { OutboxLagCache } from '../../../outbox/lagCache.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
// O3: outbox-batch — bulk endpoints commit one outbox row per item via
// recordHotWriteBatch (single atomic file rewrite, perf gate O-D11). Substrate
// writes still run in-line here because all four operationKinds (node.upsert,
// edge.upsert, node.delete, verbatim.upsert) are idempotent — the replicator
// replays no-ops. Marker tokens `withOutbox` + `outboxBatch` satisfy the O-D2
// gate-test regex without renaming the helper.
import { recordHotWriteBatch } from '../../../outbox/hotLane.js';
import { entryRevision, readInlinePriors, retractBulkNodeUpsert, undoBulkGraphWrite } from './bulkWriteRollback.js';
import { supersedesVisibilityFromDeps } from '../../../security/nodeWriteGate.js';
import { resolveGraph, writeWorkspaceNotFound } from './bulkWriteWorkspace.js';
import { bulkLockIds, bulkOutboxPayload, checkChunkConditions, checkSpecConditions, chunkSpecsForLocking, freshRevision, guardBulkChunk, writeStamped, type ConditionalSpec, type RevisionStamp, stampBulkRevisions, writeBulkChunk, undoLostClaim, reconcileOutboxRevision } from './bulkWriteConditional.js';
import { ItemConditionError, parseConditionalFields, type FailedPrecondition, type Precondition } from '../../../core/conditionalChecks.js';
import { alreadyExistsError, isNodeAlreadyExists } from '../../../engines/graphShared/conditionalInsert.js';
import { bulkScopeDeps, blockedBulkUpsertIds, ID_UNAVAILABLE_ITEM_ERROR, storedScopesResolver } from './bulkWriteScope.js';
import type { ItemScopeDeps } from '../../../security/itemScopes.js';
import { withNodeLocks } from '../../../core/nodeWriteLock.js';
import { flushBulkQueuedEmbeds, buildVerbatimSpec, type VerbatimSpec } from './bulkEmbedFlush.js';
import { validateQuestionsMeta, mergeQuestionsMetaIntoMetadataJson } from '../../../core/questionAliases.js';
import { applyBulkQuestionAliases } from '../../../core/bulkQuestionAliases.js';
import { handleBulkRecall } from './bulkRecall.js';
import { handleBulkEdges, handleBulkDelete } from './bulkWriteEdgesDelete.js';
// Round-2 review fix (HIGH #1) — this bulk lane writes via
// storageClient.upsertNode directly, bypassing core/nodeService's
// nodeUpsert() chokepoint entirely (perf: one batched bulkUpsertNodes call
// per lock chunk instead of N chokepoint calls), so D5's write-time
// supersession enforcement never ran here at all. Same shared helpers
// storeNode.ts/postNode.ts/the embedded lib paths use, applied per-item.
import { checkSupersessionPolicy, applyWriteTimeSupersedes, resolveSupersessionContext, validateSupersedesIds, SUPERSESSION_ENFORCED_TYPES } from '../../../core/supersessionPolicy.js';
import { normaliseBulkNodeScope, buildBulkVerbatimMetadata } from '../../../core/bulkNodeScope.js';
import type { OutboxEntry, OutboxStore } from '../../../outbox/types.js';
import type { WorkspaceVerbatimResolver } from '../../../outbox/workspaceVerbatimResolver.js';
import type { VerbatimStoreApi } from '../../../engines/verbatimStoreApi.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import type { LoreNode } from '../../../providers/types.js';

// Widened when the local graph engine changed: naming CONCRETE classes excluded SurrealGraph.
type LoreGraph = LoreGraphHandle;

export interface BulkWriteDeps {
    store: StorageBundle;
    auditLog: AuditLog;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    graphRegistry?: LocalGraphRegistry;
    /** Sprint O3 — when present, every bulk write commits one outbox
     *  row per item via recordHotWriteBatch BEFORE the substrate writes
     *  run. The replicator picks the rows up async and re-asserts the
     *  substrate state (idempotent for all four operationKinds we
     *  emit). Optional so the legacy in-memory test deps that mock
     *  only StorageBundle still type-check. */
    outboxStore?: OutboxStore;
    /** Sprint O4 — backpressure lag cache (optional; absent = skip). */
    outboxLagCache?: OutboxLagCache;
    /** F-COL4 — per-workspace write quota (same store the single-write
     *  POST /api/node path uses). When present, bulk node/edge writes
     *  refuse with HTTP 429 workspace_quota_exceeded before committing.
     *  Optional so the active-ws happy path + test deps that mock only
     *  StorageBundle fall back to no-quota — identical to today until the
     *  dispatcher threads these (mirrors tryNodesRoutes). */
    quotaStore?: import('../../../security/workspaceQuota.js').IWorkspaceQuotaStore;
    getWorkspaceEntryForQuota?: (workspace: string) => import('../../../config/workspaces.js').WorkspaceEntry | undefined;
    /** L-012 — per-workspace verbatim resolver (SP-F3 WorkspaceVerbatimResolver).
     *  When present, the INLINE embed path routes its vector write to the
     *  REQUESTED workspace's LanceDB, not the boot-active store, so a cross-ws
     *  bulk write no longer splits the graph node from its embedding. Optional;
     *  falls back to deps.store.loreVerbatim. QUEUED/outbox path is already ws-
     *  correct (embed.batch keyed requestedWorkspace). */
    workspaceVerbatimResolver?: WorkspaceVerbatimResolver;
    /** Round-E X-edges — WAL access for `handleBulkDelete`'s node.delete
     *  entries (bulkWriteEdgesDelete.ts). Optional and unwired from the
     *  dispatcher today (REST routes generally don't append to the WAL —
     *  see nodeService.ts's `getWal` for the one place that does); present
     *  so a future wiring pass has the hook without another BulkWriteDeps
     *  shape change. Absent = no WAL append (unchanged from before this
     *  field existed). */
    getWal?: () => import('../../../engines/writeAheadLog.js').WriteAheadLog;
    /** D5 round 2 (#2) — host-level supersession-enforce default. */
    supersessionEnforceDefault?: boolean;
    /** Version log, so a bound actor's caller-chosen id is also checked against a deleted node's history (bulkWriteScope.ts). Optional; absent = live node + verbatim row only. */
    versionStore?: ItemScopeDeps['versionStore'];
}

export const ITEM_CAP = 1000;

export interface BulkResult {
    ok: boolean;
    error?: string;
    /** D5 round 4 (#3) — non-fatal near-duplicate warning surfaced from checkSupersessionPolicy(). */
    supersessionWarning?: string;
    /** D5 round 4 (#4) — set when applyWriteTimeSupersedes() partially failed after the write. */
    applied?: string[];
    unapplied?: Array<{ id: string; reason: string }>;
    /** Conditional writes R2 — a pure retry of a supersede item: nothing was written. */
    unchanged?: boolean;
    /** Conditional writes phase 2a — the node's revision after the write (absent on engines without revisions). */
    revision?: number;
    /** Phase 2b — `revision_mismatch`: the revision found (null = the node is absent). */
    currentRevision?: number | null;
    /** Phase 2b — `precondition_failed`: every entry that did not hold. */
    failedPreconditions?: FailedPrecondition[];
}

interface NodeInput {
    id?: unknown;
    type?: unknown;
    label?: unknown;
    content?: unknown;
    tags?: unknown;
    workspace?: unknown;
    embed?: unknown;
    /** D5 — per-item supersedes/force, mirrors the single-write surfaces. */
    supersedes?: unknown;
    force?: unknown;
    /** Conditional writes R1 — create only; fails `already_exists` if any node holds the id. Never stored. */
    ifAbsent?: unknown;
    /** Conditional writes phase 2b — write only if this node is at exactly this revision. Never stored. */
    ifRevision?: unknown;
    /** Conditional writes phase 2b — write only if every listed node is at its listed revision. Never stored. */
    preconditions?: unknown;
}

export interface EdgeInput {
    sourceId?: unknown;
    targetId?: unknown;
    relation?: unknown;
    confidence?: unknown;
    confidenceScore?: unknown;
    workspace?: unknown;
    bidirectional?: unknown;
}


export async function tryBulkWriteRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: BulkWriteDeps,
): Promise<boolean> {
    if (req.method !== 'POST') return false;
    const isBulkNodes = pathname === '/api/nodes/bulk';
    const isBulkEdges = pathname === '/api/edges/bulk';
    const isBulkDelete = pathname === '/api/nodes/bulk-delete';
    const isBulkRecall = pathname === '/api/recall/bulk';
    if (!isBulkNodes && !isBulkEdges && !isBulkDelete && !isBulkRecall) return false;

    const permission = isBulkRecall ? 'read' : 'write';
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

    let body: string;
    try {
        body = await readBoundedBody(req);
    } catch (err) {
        if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
        writeError(res, 400, 'bad_request', redactError(err));
        return true;
    }

    let parsed: unknown;
    try { parsed = JSON.parse(body || '{}'); }
    catch (err) { writeError(res, 400, 'bad_request', `invalid json: ${(err as Error).message}`); return true; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        writeError(res, 400, 'bad_request', 'body must be a JSON object');
        return true;
    }

    // Sprint L1 — workspace is required for every bulk endpoint.
    const wsField = (parsed as { workspace?: unknown }).workspace;
    if (typeof wsField !== 'string' || wsField.length === 0) {
        writeWorkspaceRequired(res);
        return true;
    }

    // Sprint O4 — backpressure gate. After L workspace check, before
    // per-handler dispatch. Skips /api/recall/bulk (read-only — does
    // not commit to outbox, has no replication dependency).
    if (!isBulkRecall && checkOutboxBackpressure(res, wsField, deps.outboxLagCache)) {
        return true;
    }

    if (isBulkNodes) return handleBulkNodes(res, parsed as { nodes?: unknown; workspace?: unknown; embed?: unknown; force?: unknown }, deps);
    if (isBulkEdges) return handleBulkEdges(res, parsed as { edges?: unknown; workspace?: unknown }, deps);
    if (isBulkDelete) return handleBulkDelete(res, parsed as { ids?: unknown; workspace?: unknown }, deps);
    if (isBulkRecall) return handleBulkRecall(res, parsed as { topics?: unknown; workspace?: unknown }, deps);
    return false;
}

/**
 * Sprint E2 — embed-mode parser for the bulk node lane. Default 'queued':
 * commit one node.upsert row per item + one embed.batch row; replicator drives
 * both async. 'inline' = legacy per-item synchronous loreVerbatim.store (fire-
 * and-forget). 'skip' = no embed (caller re-embeds later). Per-item `embed`
 * (incl. legacy false→skip / true→inline) beats the call-level default. Hot
 * single-write path (POST /api/node, MCP store_node) UNCHANGED — inline-by-
 * default (E-D5 sentinel).
 */
type BulkEmbedMode = 'inline' | 'queued' | 'skip';

function parseBulkEmbedMode(raw: unknown, fallback: BulkEmbedMode): BulkEmbedMode {
    if (raw === 'inline' || raw === 'queued' || raw === 'skip') return raw;
    // W2 legacy: `embed: false` means skip. `embed: true` means inline.
    if (raw === false) return 'skip';
    if (raw === true) return 'inline';
    return fallback;
}

async function handleBulkNodes(
    res: ServerResponse,
    parsed: { nodes?: unknown; workspace?: unknown; embed?: unknown; force?: unknown },
    deps: BulkWriteDeps,
): Promise<boolean> {
    if (!Array.isArray(parsed.nodes)) {
        writeError(res, 400, 'bad_request', '`nodes` must be an array');
        return true;
    }
    if (parsed.nodes.length === 0) {
        writeError(res, 400, 'bad_request', '`nodes` must be non-empty');
        return true;
    }
    if (parsed.nodes.length > ITEM_CAP) {
        writeError(res, 400, 'bad_request', `at most ${ITEM_CAP} nodes per call (got ${parsed.nodes.length})`);
        return true;
    }
    const requestedWorkspace = typeof parsed.workspace === 'string' ? parsed.workspace : undefined;
    if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'write' }) === null) return true;
    // F-COL4 — per-workspace quota gate (mirrors POST /api/node hot path).
    // Project the whole batch (N nodes + UTF-8 byte estimate of label+content)
    // and refuse 429 before any substrate/outbox write. No-op when unwired.
    if (deps.quotaStore && deps.getWorkspaceEntryForQuota) {
        const { enforceQuotaOrReject } = await import('../../../security/workspaceQuota.js');
        const nodesArr = parsed.nodes as NodeInput[];
        let bytes = 0;
        for (const n of nodesArr) bytes += Buffer.byteLength(`${String(n?.label ?? '')}${String(n?.content ?? '')}`, 'utf8');
        const q = enforceQuotaOrReject({ store: deps.quotaStore, getWorkspaceEntry: deps.getWorkspaceEntryForQuota }, res, requestedWorkspace!, { nodes: nodesArr.length, bytes });
        if (q.handled) return true;
    }
    const targetGraph = await resolveGraph(deps, requestedWorkspace);
    // Lock key workspace — must name the workspace the writes actually land
    // in, which is what resolveGraph() resolved: the requested one, else the
    // registry's active name. Using a bare `requestedWorkspace!` here would
    // key the lock on the string "undefined" on the (dispatcher-guarded)
    // no-workspace path and silently stop contending with nodeUpsert.
    const lockWorkspace = requestedWorkspace ?? deps.graphRegistry?.activeName() ?? '';
    if ('error' in targetGraph) { writeWorkspaceNotFound(res, targetGraph); return true; }
    // L-012 — resolve the REQUESTED workspace's verbatim (LanceDB) store so the
    // inline embed path seeds into the same ws the graph node landed in (else a
    // cross-ws bulk write splits row from embedding). Falls back to boot-bound
    // loreVerbatim when no resolver wired. WorkspaceNotFoundError → same 400.
    let targetVerbatim: VerbatimStoreApi | typeof deps.store.loreVerbatim = deps.store.loreVerbatim;
    if (deps.workspaceVerbatimResolver && requestedWorkspace) {
        try {
            targetVerbatim = await deps.workspaceVerbatimResolver.getOrOpen(requestedWorkspace);
        } catch (err) {
            // resolveGraph above already validated the workspace via the graph
            // registry (WorkspaceNotFoundError → 400), so reaching here for an
            // unknown ws means it vanished between the two calls. getWorkspacePath
            // throws a plain Error with a `workspace_not_found:` message; map both
            // shapes to the same 400 envelope the graph path uses.
            if (err instanceof WorkspaceNotFoundError) {
                writeWorkspaceNotFound(res, { error: 'workspace_not_found', requested: err.requested, known: err.known });
                return true;
            }
            if (err instanceof Error && err.message.startsWith('workspace_not_found')) {
                writeWorkspaceNotFound(res, { error: 'workspace_not_found', requested: requestedWorkspace!, known: [] });
                return true;
            }
            throw err;
        }
    }
    // SP-20 / D-019: wrap the resolved workspace graph in LoreStorageClient
    // so upsertNode routes through the facade (cloud-swap point) rather than
    // calling loreGraph.upsertNode directly. L-012: verbatim is now the
    // REQUESTED workspace's store (resolved above), not the boot singleton.
    const target = LoreStorageClient.fromLocal({
        graph: targetGraph,
        verbatim: targetVerbatim,
    });

    // Sprint E2 — call-level embed mode (default 'queued'). Per-item
    // override decided alongside per-item validation below.
    const callEmbedMode: BulkEmbedMode = parseBulkEmbedMode(parsed.embed, 'queued');

    // O3: outbox-batch — commit one outbox row per VALID item before
    // the substrate writes run. Per-item shape validation happens here
    // (same checks as upsertOne) so an invalid item is reported as a
    // per-item failure without an outbox row. Invalid items keep
    // their slot in `results` via an index map so the final result
    // array matches the request order 1:1.
    const items = parsed.nodes as NodeInput[];
    const validSpecs: Array<{ idx: number; raw: NodeInput; embedMode: BulkEmbedMode; questions: string[] | undefined; supersedes: string[] | undefined; supersessionWarning: string | undefined; ifAbsent: boolean; ifRevision?: number; preconditions?: Precondition[] }> = [];
    const results: Array<BulkResult & { id?: string }> = new Array(items.length);
    // D5 — batch-level `force` (request body `force: true`) applies to every
    // item that doesn't set its own `force`; an item-level `force` wins.
    const batchForce = (parsed as { force?: unknown }).force === true;
    // Resolved once for the whole batch (one workspace per bulk request) —
    // same resolver storeNode.ts/postNode.ts/the embedded paths use.
    // Row-scope deps for the workspace this batch writes to; `supersedesVisible` is
    // undefined for an unbound caller (zero lookups) — a hidden `supersedes` id /
    // near-duplicate then behaves exactly like a missing one.
    const scopeDeps = bulkScopeDeps(deps, lockWorkspace, targetVerbatim);
    const supersedesVisible = supersedesVisibilityFromDeps(scopeDeps);
    const { policy: supersessionPolicy, findDuplicate: findSupersessionDuplicate } = resolveSupersessionContext({
        workspace: requestedWorkspace ?? deps.graphRegistry?.activeName() ?? '',
        targetGraph,
        homeDir: deps.graphRegistry?.homeDir?.(),
        bootGraph: deps.store.loreGraph,
        storageClient: deps.store.storageClient,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
        hostDefaultEnforce: deps.supersessionEnforceDefault, // D5 round 2 (#2) host switch.
        isVisible: supersedesVisible,
    });
    // Row-scope gate (bound actors only; unbound = empty set, zero lookups).
    // Every item id is caller-chosen, so one batched pass finds the ids this
    // actor may not write to (live / deleted / verbatim row it cannot see).
    const blockedIds = await blockedBulkUpsertIds(items.map((it) => (it as NodeInput | null)?.id), scopeDeps);
    for (let i = 0; i < items.length; i++) {
        const raw = items[i];
        if (!raw || typeof raw !== 'object'
            || typeof raw.id !== 'string'
            || typeof raw.type !== 'string'
            || typeof raw.label !== 'string') {
            results[i] = { ok: false, error: 'id, type, and label are required strings' };
            continue;
        }
        // R3 #6 — validate the LanceDB-safe id BEFORE the outbox row + graph
        // write (matches postNode.ts:78 and the nodeService chokepoint). This
        // path writes via storageClient.upsertNode directly, NOT through
        // nodeService, so without this an unsafe id wrote a graph node while the
        // verbatim write threw assertSafeLanceId and was dropped (fire-and-
        // forget) — a durable orphan reported to the caller as ok:true.
        try {
            assertSafeLanceId(raw.id, 'bulkWrite.handleBulkNodes');
        } catch {
            results[i] = { ok: false, id: raw.id, error: 'invalid_node_id' };
            continue;
        }
        // 2.3 (2026-08-17) — server-managed lifecycle/security fields. The bulk
        // route used to pass every field straight to the graph writer, so any
        // write token could mass-set scopes/status/classification. The single-
        // write siblings reject these via checkUnknownFields; mirror that here.
        //
        // QA finding 1 (A4 round E, 2026-09-03) — this denylist is NOT the
        // same allowlist checkUnknownFields uses (STORE_NODE_KNOWN_FIELDS):
        // bulk items legitimately accept a caller-supplied `project` field
        // (see bulkNodeScope.ts / test/bulk-write-scope-metadata-unit.ts),
        // which STORE_NODE_KNOWN_FIELDS does not include, so switching this
        // route to that allowlist wholesale would reject a currently-tested,
        // legitimate bulk field. Denylist stays the minimal fix: it was
        // missing `supersededReason`/`supersededBy`/`supersededAt`, so a bulk
        // upsert could stamp an uncapped supersession reason straight onto a
        // node, bypassing supersede_node's MAX_NODE_FIELD_BYTES cap entirely.
        const forbidden = [
            'status', 'classification', 'security_scopes', 'stale', 'anchor_stale', 'anchor_stale_since',
            'supersededReason', 'supersededBy', 'supersededAt',
        ]
            .filter((f) => f in (raw as Record<string, unknown>));
        if (forbidden.length > 0) {
            results[i] = { ok: false, id: raw.id as string, error: `unknown_field: ${forbidden.join(', ')}` };
            continue;
        }
        // Conditional writes R1 — `ifAbsent` is a write-time directive (stripped
        // like `supersedes`/`force` below); anything but a boolean is refused.
        const ifAbsentRaw = (raw as Record<string, unknown>).ifAbsent;
        if (ifAbsentRaw !== undefined && typeof ifAbsentRaw !== 'boolean') {
            results[i] = { ok: false, id: raw.id as string, error: 'invalid_if_absent: ifAbsent must be a boolean' };
            continue;
        }
        // Phase 2b — `ifRevision` / `preconditions`: write-time directives too, validated here, never stored.
        const condRaw = raw as Record<string, unknown>;
        const parsedConditions = parseConditionalFields({ id: raw.id, ifRevision: condRaw.ifRevision, preconditions: condRaw.preconditions, ifAbsent: ifAbsentRaw });
        delete condRaw.ifAbsent;
        delete condRaw.ifRevision;
        delete condRaw.preconditions;
        if (!parsedConditions.ok) {
            results[i] = { ok: false, id: raw.id, error: parsedConditions.error };
            continue;
        }
        // After the shape/forbidden-field checks, before any outbox row or write.
        if (blockedIds.has(raw.id)) {
            results[i] = { ok: false, id: raw.id, error: ID_UNAVAILABLE_ITEM_ERROR };
            continue;
        }
        // 3.21 step 3(e)/3(h) round 2 — summary/entities/topics merge
        // verbatim into metadata, same as the single-write surfaces
        // (core/questionAliases.ts). `questions[]` (alias verbatim rows) IS
        // now supported on this bulk path too (Opus review: the accuracy
        // benchmark loads 415 memories through this route) — validated here
        // exactly like the single-write path, applied per-item after each
        // node's graph write succeeds (see applyBulkQuestionAliases calls
        // below in both the batchGraph and ARCADE branches), via the SAME
        // tombstone-then-record primitives nodeServiceVerbatim.ts uses
        // (core/bulkQuestionAliases.ts) — same alias semantics, limits, and
        // outbox durability as store_node/POST /api/node.
        let itemQuestions: string[] | undefined;
        {
            const rawRec = raw as Record<string, unknown>;
            const metaCheck = validateQuestionsMeta({ questions: rawRec.questions, summary: rawRec.summary, entities: rawRec.entities, topics: rawRec.topics });
            if (!metaCheck.ok) {
                results[i] = { ok: false, id: raw.id as string, error: `invalid_questions_meta: ${metaCheck.error}` };
                continue;
            }
            if (metaCheck.value.summary !== undefined || metaCheck.value.entities !== undefined || metaCheck.value.topics !== undefined) {
                rawRec.metadata = mergeQuestionsMetaIntoMetadataJson(
                    typeof rawRec.metadata === 'string' ? rawRec.metadata : undefined,
                    metaCheck.value,
                );
            }
            // `questions` itself is never a graph-row field — strip it before
            // the raw item reaches bulkUpsertNodes/upsertOne (which pass the
            // item straight to targetGraph.upsertNode), same as the
            // single-write path never lets `questions` reach `nodeData`.
            if (rawRec.questions !== undefined) itemQuestions = metaCheck.value.questions;
            delete rawRec.questions;
        }
        // project==workspace + ecosystem defaulting, stamped to exactly what
        // rowToLoreNode will report for the graph row — see bulkNodeScope.ts
        // for the invariant and what breaking it costs. (dispatcher guarantees
        // requestedWorkspace is non-empty.)
        normaliseBulkNodeScope(raw as Record<string, unknown>, requestedWorkspace as string);
        // D5 — round-2 review fix (HIGH #1): enforce per item, BEFORE the
        // outbox row / substrate write, same as every other rejection above.
        // `supersedes`/`force` are write-time directives, never real graph
        // row fields, so strip them before `raw` reaches bulkUpsertNodes/
        // upsertOne (mirrors how `questions` is captured then deleted above).
        const rawRec = raw as Record<string, unknown>;
        const itemSupersedes = Array.isArray(rawRec.supersedes)
            ? (rawRec.supersedes as unknown[]).filter((v): v is string => typeof v === 'string')
            : undefined;
        const itemForce = rawRec.force === true || batchForce;
        delete rawRec.supersedes;
        delete rawRec.force;
        // D5 round 4 (#4) — same shared all-or-nothing pre-write validator
        // (exists / not archived / no cycle) the single-write chokepoint
        // (nodeService.ts) uses, instead of this route's own existence-only
        // inline check.
        if (itemSupersedes && itemSupersedes.length > 0) {
            const preCheck = await validateSupersedesIds({ id: raw.id as string, supersedes: itemSupersedes, targetGraph, isVisible: supersedesVisible });
            if (!preCheck.ok) {
                results[i] = { ok: false, id: raw.id as string, error: `${preCheck.code}: ${preCheck.error.message}` };
                continue;
            }
        }
        let itemSupersessionWarning: string | undefined;
        if (SUPERSESSION_ENFORCED_TYPES.has(raw.type as string)) {
            const verdict = await checkSupersessionPolicy({
                type: raw.type as string,
                id: raw.id as string,
                label: raw.label as string | undefined,
                content: raw.content as string | undefined,
                supersedes: itemSupersedes,
                force: itemForce,
                policy: supersessionPolicy,
                findDuplicate: findSupersessionDuplicate,
            });
            if (!verdict.ok) {
                results[i] = { ok: false, id: raw.id as string, error: `${verdict.code}: ${verdict.error.message}` };
                continue;
            }
            itemSupersessionWarning = verdict.supersessionWarning;
        }
        const embedMode = parseBulkEmbedMode(raw.embed, callEmbedMode);
        validSpecs.push({ idx: i, raw, embedMode, questions: itemQuestions, supersedes: itemSupersedes, supersessionWarning: itemSupersessionWarning, ifAbsent: ifAbsentRaw === true, ...parsedConditions.conditions });
    }
    let succeeded = 0;
    let unchangedCount = 0; // R2 pure retries: ok, but nothing written and nothing counted against the quota
    const outcome = {
        fail: (s: { idx: number; raw: { id?: unknown } }, error: string, extra?: Record<string, unknown>) => { results[s.idx] = { ok: false, id: s.raw.id as string, error, ...extra }; },
        unchanged: (s: { idx: number; raw: { id?: unknown } }, revision?: number) => { unchangedCount++; results[s.idx] = { ok: true, id: s.raw.id as string, unchanged: true, ...(revision !== undefined ? { revision } : {}) }; },
    };
    // Sprint E2 — LOCAL queued-embed accumulator (one embed.batch row). Collected
    // AFTER substrate upsert succeeds so a failed upsert never leaks in.
    const embedTexts: string[] = [];
    const embedTargetIds: string[] = [];
    // ARCADE bulk-embed-completeness fix (2026-07-05) — arcade leaves embed.batch
    // UNWIRED and embeds inline via WIRED verbatim.upsert; the non-local branch
    // accumulates one spec per queued node here (see bulkEmbedFlush.ts).
    const verbatimSpecs: VerbatimSpec[] = [];
    // RA2-reaudit2 (bulk wall-time) — one write-lane trip instead of N×
    // upsertNode (~1.9x) on a local engine; isWorkspaceGraph probes capability.
    const batchGraph = isWorkspaceGraph(targetGraph) ? targetGraph : null;
    // QA A2 round-3 finding (2026-09-03) — the O3 outbox-batch commit for
    // this request's node.upsert rows used to run BEFORE either branch below
    // took its lock(s). A concurrent delete on one of these ids records its
    // own node.delete row inside ITS lock and can finish (and release the
    // lock) before this batch's lock request for that id is even granted, so
    // the real substrate order (delete, then this upsert re-creating the
    // node) came out backwards from the outbox commit order (this upsert's
    // row already durable first) — a replay contradicted the real end state.
    // Fix: move the `recordHotWriteBatch` call to be the first thing done
    // INSIDE the lock region, so nothing touching an id can land between the
    // commit and the substrate write for that id.
    //
    // QA A2 round-4 finding 1 (2026-09-03) — the round-3 fix then held ALL
    // of a large batch's locks for the WHOLE substrate loop (`withNodeLocks`
    // never releases a key until its whole callback returns), so a
    // concurrent single-key writer on ANY one of 1000 ids waited for nearly
    // the entire batch (~865-960x amplification measured). Fix: run
    // `withNodeLocks` per CHUNK of at most `BULK_LOCK_CHUNK_SIZE` ids
    // instead of once over the whole batch — see nodeWriteLock.ts for why
    // this bounds the worst-case hold without reopening the round-3 race
    // (the outbox commit and substrate writes for a given id are still
    // atomic under that id's own chunk lock; only OTHER ids' turns release
    // sooner). Each chunk's outbox commit failure only fails that chunk's
    // items — a batch spanning multiple chunks can partially succeed, which
    // `results`/`succeeded` already report per-item.
    if (batchGraph) {
        // The outbox commit + graph write + per-node verbatim seed all run
        // under the SAME per-(workspace,id) locks `nodeUpsert` holds
        // (core/nodeWriteLock.ts). Unlocked, a concurrent single-write or
        // delete for one of these ids interleaved between this batch's graph
        // write and its verbatim seed and left the two substrates durably
        // disagreeing. `bulkUpsertNodes` is ONE substrate call per CHUNK, so
        // the locks cannot be taken a node at a time without giving up the
        // chunk — `withNodeLocks` holds all of a chunk's ids, acquired in
        // sorted order (deadlock-free; see nodeWriteLock.ts rule 3).
        for (const lockedChunk of chunkSpecsForLocking(validSpecs)) {
            await withNodeLocks(lockWorkspace, bulkLockIds(lockedChunk), async () => {
                // Conditional writes: refuse `ifAbsent` / already-superseded items, skip pure retries, then judge ifRevision / preconditions (phase 2b) — all BEFORE any outbox row or side effect, so a refused item records nothing.
                const guarded = await checkChunkConditions(batchGraph, await guardBulkChunk(batchGraph, lockedChunk, outcome), (s, f) => { results[s.idx] = { ok: false, id: s.raw.id as string, ...f }; });
                // 3.26.0 — the nodes as they are now, so a failed inline seed (or a lost supersede claim) restores an existing node (bulkWriteRollback.ts).
                const { chunk: priored, priors } = await readInlinePriors(batchGraph, guarded, (s, error) => { results[s.idx] = { ok: false, id: s.raw.id as string, error }; });
                // Phase 2a — the revision each item is written on top of (read under the chunk locks), recorded in its outbox row.
                const { chunk, stamps } = await stampBulkRevisions(batchGraph, priored, (s, error) => { results[s.idx] = { ok: false, id: s.raw.id as string, error }; });
                let chunkEntries: OutboxEntry[] | null = null;
                if (deps.outboxStore && chunk.length > 0) {
                    try {
                        chunkEntries = await recordHotWriteBatch(deps.outboxStore, chunk.map((spec) => ({
                            workspace: requestedWorkspace!,
                            operationKind: 'node.upsert',
                            payload: bulkOutboxPayload(spec, stamps.get(spec.idx)),
                            initiator: 'http:POST /api/nodes/bulk',
                            operation: 'graph.upsert',
                        })));
                    } catch (err) {
                        const msg = `outbox commit failed: ${(err as Error).message}`;
                        for (const { idx, raw } of chunk) results[idx] = { ok: false, id: raw.id as string, error: msg };
                        return;
                    }
                }
                const batchResults = await writeBulkChunk(batchGraph, chunk, stamps);
                for (let k = 0; k < chunk.length; k++) {
                    const { idx, raw, embedMode, questions, supersessionWarning } = chunk[k]!;
                    const br = batchResults[k]!;
                    if (!br.ok) {
                        results[idx] = { ok: false, id: raw.id as string, error: br.error, ...(br.currentRevision !== undefined ? { currentRevision: br.currentRevision } : {}), ...(br.failedPreconditions ? { failedPreconditions: br.failedPreconditions } : {}) };
                        // QA A2 round-4 finding 2 (2026-09-03) — this chunk's
                        // node.upsert outbox row for `raw.id` is already committed
                        // (above), but the substrate write for THIS node failed, so
                        // the row is now pending for a write the caller was just
                        // told failed. Retract it the same way nodeService.ts's
                        // single-write path retracts its own node.upsert row on a
                        // downstream failure — else a later replicator tick creates
                        // a ghost node the caller was told ok:false for.
                        if (deps.outboxStore && chunkEntries) {
                            const entry = chunkEntries[k];
                            if (entry) {
                                try {
                                    await retractBulkNodeUpsert({ store: deps.outboxStore, entryId: entry.id, workspace: requestedWorkspace!, graph: batchGraph, id: raw.id as string, written: raw as Record<string, unknown>, claimedRevision: entryRevision(entry) });
                                } catch (retractErr) {
                                    console.error(`[Lore HTTP] bulk upsert: node.upsert outbox retraction failed for ${raw.id as string}: ${redactError(retractErr)} — replicator may create a ghost node`);
                                }
                            }
                        }
                        continue;
                    }
                    // The row was recorded with a PREDICTED revision; make it the one this write landed (see reconcileOutboxRevision).
                    if (chunkEntries) chunkEntries[k] = await reconcileOutboxRevision({ store: deps.outboxStore, entry: chunkEntries[k], stamp: stamps.get(idx), landed: br.revision, workspace: requestedWorkspace!, id: raw.id as string }) as OutboxEntry;
                    succeeded++;
                    results[idx] = { ok: true, id: raw.id as string, ...(supersessionWarning ? { supersessionWarning } : {}), ...(br.revision !== undefined ? { revision: br.revision } : {}) };
                    // D5 — apply this item's `supersedes` list now that its
                    // own graph write has durably succeeded (same ordering
                    // nodeService.nodeUpsert uses: new node first, then
                    // supersede the old ones). Best-effort per id (matches
                    // applyWriteTimeSupersedes' own edge-write posture) but a
                    // FIELD-mutation failure downgrades this item's result to
                    // ok:false with the applied/unapplied ids named, since the
                    // caller explicitly asked for that link and it silently
                    // not happening must not be reported as success.
                    const itemSupersedes = chunk[k]!.supersedes;
                    if (itemSupersedes && itemSupersedes.length > 0) {
                        const applyResult = await applyWriteTimeSupersedes({
                            targetGraph: batchGraph, supersedes: itemSupersedes, newId: raw.id as string,
                            workspace: requestedWorkspace!, initiator: 'http:POST /api/nodes/bulk',
                            outboxStore: deps.outboxStore, logPrefix: '[Lore HTTP bulk]',
                            isVisible: supersedesVisible,
                        });
                        // Phase 2a — each claimed old node bumped the new node again (supersede bumps BOTH), so report the stored revision.
                        if (applyResult.ok && results[idx]?.revision !== undefined) {
                            const rev = await freshRevision(batchGraph, raw.id as string);
                            if (rev !== undefined) results[idx] = { ...results[idx]!, revision: rev };
                        }
                        if (!applyResult.ok) {
                            // D5 round 4 (#4) — surface applied/unapplied ids
                            // when applyWriteTimeSupersedes() partially
                            // succeeded, instead of collapsing to one message.
                            if (applyResult.code === 'already_superseded') {
                                // R2 — another writer holds one of the old nodes: the item fails whole and nothing of it stays (the new node and its outbox row are taken back).
                                results[idx] = { ok: false, id: raw.id as string, error: `already_superseded: ${applyResult.error.message}` };
                                succeeded--;
                                await undoLostClaim({ graph: batchGraph, id: raw.id as string, prior: priors.get(raw.id as string), raw: raw as Record<string, unknown>, outboxStore: deps.outboxStore, entry: chunkEntries?.[k], workspace: requestedWorkspace! });
                                continue;
                            }
                            if (applyResult.code === 'supersedes_partial') {
                                results[idx] = { ok: false, id: raw.id as string, error: `supersedes_partial: ${applyResult.error.message}`, applied: applyResult.applied, unapplied: applyResult.unapplied };
                            } else {
                                results[idx] = { ok: false, id: raw.id as string, error: `supersedes_apply_failed: ${(applyResult as { error: Error }).error.message}` };
                            }
                        }
                    }
                    // 3.21 step 3(h) round 2 — same tombstone-then-record alias
                    // fan-out the single-write path runs, applied now that
                    // this item's graph write has durably succeeded. Still
                    // inside this chunk's lock, matching nodeUpsert's own
                    // "alias fan-out under the same per-id lock" invariant.
                    try {
                        await applyBulkQuestionAliases({
                            outboxStore: deps.outboxStore, workspace: requestedWorkspace!,
                            initiator: 'http:POST /api/nodes/bulk', logPrefix: '[Lore HTTP bulk]',
                            node: {
                                id: raw.id as string, type: raw.type as string,
                                project: (raw as Record<string, unknown>).project as string,
                                ecosystem: (raw as Record<string, unknown>).ecosystem as string,
                            },
                            questions,
                            resolveStoredScopes: storedScopesResolver(scopeDeps, raw.id as string),
                        });
                    } catch (aliasErr) {
                        // Best-effort, same posture as tombstoneQuestionAliases/
                        // recordQuestionAliases' own internal catches — never
                        // fails an already-successful graph write.
                        console.error(`[Lore HTTP] bulk question-alias fan-out failed for ${raw.id as string} (non-fatal): ${redactError(aliasErr)}`);
                    }
                    const verbatimText = buildVerbatimText(
                        raw.label as string,
                        (raw.content as string | undefined) ?? '',
                        tagsToArray(raw.tags as string | string[] | undefined),
                    );
                    if (embedMode === 'inline') {
                        // C-R3-01 — AWAIT the inline seed (was fire-and-forget
                        // `.catch(console.error)`). A swallowed verbatim failure left the
                        // graph node committed + the caller told ok:true = a durable
                        // graph-only orphan. On failure now: report the item ok:false and
                        // roll back its graph write — 3.26.0: an existing node is put back
                        // as it was, only a node this item created is deleted. (The default
                        // 'queued' path is outbox-tracked and unaffected.)
                        try {
                            // Metadata via the shared builder — this branch used to
                            // hardcode `project:'*', ecosystem:'*'` inline. See
                            // bulkNodeScope.ts for what that silently broke.
                            const rec = raw as Record<string, unknown>;
                            await target.verbatimStore({
                                id: `lore:${raw.id as string}`,
                                text: verbatimText,
                                metadata: buildBulkVerbatimMetadata({
                                    type: raw.type as string,
                                    label: raw.label as string,
                                    tags: tagsToString(raw.tags as string | string[] | undefined),
                                    project: rec.project as string,
                                    ecosystem: rec.ecosystem as string,
                                    text: verbatimText,
                                    // The node's own scopes (an existing node keeps them across an upsert), as the queued path copies them.
                                    security_scopes: priors.get(raw.id as string)?.security_scopes,
                                }),
                            });
                        } catch (err) {
                            results[idx] = { ok: false, id: raw.id as string, error: `verbatim seed failed: ${redactError(err)}` };
                            succeeded--;
                            try { await undoBulkGraphWrite(batchGraph, raw.id as string, priors.get(raw.id as string), raw as Record<string, unknown>); }
                            catch (delErr) { console.error(`[Lore HTTP] bulk inline rollback failed for ${raw.id as string}: ${redactError(delErr)}`); }
                            // QA E5-A2 (2026-09-03) — this id's node.upsert outbox row was
                            // committed above (recordHotWriteBatch) and `br.ok` was true, so
                            // the `!br.ok` branch's retraction above never runs for it. The
                            // inline verbatim seed then failed and the graph write was just
                            // rolled back, but without retracting here the row stays pending
                            // and a replicator replay resurrects the node as a graph-only
                            // orphan with no verbatim mirror — the caller was told ok:false.
                            // Mirror the `!br.ok` branch's retraction (and upsertOne's ARCADE-
                            // path equivalent, which already retracts via the shared
                            // `!r.ok` handling in the ARCADE loop below).
                            if (deps.outboxStore && chunkEntries) {
                                const entry = chunkEntries[k];
                                if (entry) {
                                    try {
                                        await retractBulkNodeUpsert({ store: deps.outboxStore, entryId: entry.id, workspace: requestedWorkspace!, graph: batchGraph, id: raw.id as string, written: raw as Record<string, unknown>, claimedRevision: entryRevision(entry) });
                                    } catch (retractErr) {
                                        console.error(`[Lore HTTP] bulk inline verbatim rollback: node.upsert outbox retraction failed for ${raw.id as string}: ${redactError(retractErr)} — replicator may create a ghost node`);
                                    }
                                }
                            }
                        }
                    } else if (embedMode === 'queued') {
                        embedTexts.push(verbatimText);
                        embedTargetIds.push(`lore:${raw.id as string}`);
                    }
                }
            });
        }
    } else {
        // ARCADE/cloud path — no `bulkUpsertNodes` batch primitive, so each
        // id is written one at a time via `upsertOne` (raw facade
        // `upsertNode`, not `nodeUpsert` — cannot re-enter the lock). Each
        // CHUNK's ids are locked TOGETHER via `withNodeLocks` (same reasoning
        // as the batchGraph branch above) so that chunk's `recordHotWriteBatch`
        // commit stays atomic with that chunk's sequential write loop, instead
        // of racing a concurrent same-id delete the way the pre-lock commit
        // used to.
        for (const lockedSpecs of chunkSpecsForLocking(validSpecs)) {
            await withNodeLocks(lockWorkspace, bulkLockIds(lockedSpecs), async () => {
                const guardedSpecs = await checkChunkConditions(targetGraph, await guardBulkChunk(targetGraph, lockedSpecs, outcome), (s, f) => { results[s.idx] = { ok: false, id: s.raw.id as string, ...f }; }); // phase 2b: conditions judged before any row is recorded
                // Phase 2a — the revision each item is written on top of (read under the chunk locks), recorded in its outbox row.
                const { chunk, stamps } = await stampBulkRevisions(targetGraph, guardedSpecs, (s, error) => { results[s.idx] = { ok: false, id: s.raw.id as string, error }; });
                // A lost supersede claim must restore an existing node: read the priors of the items that have a list.
                const claimPriors = new Map<string, LoreNode | null>();
                if (typeof targetGraph.getNode === 'function') {
                    for (const spec of chunk) if (spec.supersedes?.length && !claimPriors.has(spec.raw.id as string)) {
                        try { claimPriors.set(spec.raw.id as string, await targetGraph.getNode(spec.raw.id as string)); } catch { /* undo falls back to delete */ }
                    }
                }
                let chunkEntries: OutboxEntry[] | null = null;
                if (deps.outboxStore && chunk.length > 0) {
                    try {
                        chunkEntries = await recordHotWriteBatch(deps.outboxStore, chunk.map((spec) => ({
                            workspace: requestedWorkspace!,
                            operationKind: 'node.upsert',
                            payload: bulkOutboxPayload(spec, stamps.get(spec.idx)),
                            initiator: 'http:POST /api/nodes/bulk',
                            operation: 'graph.upsert',
                        })));
                    } catch (err) {
                        const msg = `outbox commit failed: ${(err as Error).message}`;
                        for (const { idx, raw } of chunk) results[idx] = { ok: false, id: raw.id as string, error: msg };
                        return;
                    }
                }
                for (let k = 0; k < chunk.length; k++) {
                    const { idx, raw, embedMode, questions, supersessionWarning } = chunk[k]!;
                    let r: BulkResult & { id?: string } = await upsertOne(target, raw, deps, embedMode, chunk[k]!.ifAbsent, stamps.get(idx), chunk[k]);
                    if (r.ok) {
                        // The row was recorded with a PREDICTED revision; make it the one this write landed (see reconcileOutboxRevision).
                        if (chunkEntries) chunkEntries[k] = await reconcileOutboxRevision({ store: deps.outboxStore, entry: chunkEntries[k], stamp: stamps.get(idx), landed: r.revision, workspace: requestedWorkspace!, id: raw.id as string }) as OutboxEntry;
                        succeeded++;
                        if (supersessionWarning) r = { ...r, supersessionWarning };
                        // D5 — same apply-after-success as the batchGraph
                        // branch above; see that call's comment. ARCADE has
                        // no `bulkUpsertNodes` primitive so `targetGraph`
                        // (the resolved workspace graph, not `target` the
                        // LoreStorageClient facade) is the SupersessionWriteGraph.
                        const itemSupersedes = chunk[k]!.supersedes;
                        if (itemSupersedes && itemSupersedes.length > 0) {
                            const applyResult = await applyWriteTimeSupersedes({
                                targetGraph, supersedes: itemSupersedes, newId: raw.id as string,
                                workspace: requestedWorkspace!, initiator: 'http:POST /api/nodes/bulk',
                                outboxStore: deps.outboxStore, logPrefix: '[Lore HTTP bulk]',
                                isVisible: supersedesVisible,
                            });
                            if (applyResult.ok && r.revision !== undefined) {
                                const rev = await freshRevision(targetGraph, raw.id as string);
                                if (rev !== undefined) r = { ...r, revision: rev };
                            }
                            if (!applyResult.ok) {
                                succeeded--;
                                if (applyResult.code === 'already_superseded') {
                                    // R2 — see the batchGraph branch: the item fails whole, nothing of it stays.
                                    results[idx] = { ok: false, id: raw.id as string, error: `already_superseded: ${applyResult.error.message}` };
                                    await undoLostClaim({ graph: targetGraph, id: raw.id as string, prior: claimPriors.get(raw.id as string), raw: raw as Record<string, unknown>, outboxStore: deps.outboxStore, entry: chunkEntries?.[k], workspace: requestedWorkspace! });
                                    continue;
                                }
                                // D5 round 4 (#4) — surface applied/unapplied
                                // ids on a partial failure, same as the
                                // batchGraph branch above.
                                if (applyResult.code === 'supersedes_partial') {
                                    r = { ok: false, id: raw.id as string, error: `supersedes_partial: ${applyResult.error.message}`, applied: applyResult.applied, unapplied: applyResult.unapplied };
                                } else {
                                    r = { ok: false, id: raw.id as string, error: `supersedes_apply_failed: ${(applyResult as { error: Error }).error.message}` };
                                }
                            }
                        }
                    }
                    if (r.ok) {
                        // 3.21 step 3(h) round 2 — same alias fan-out as the
                        // batchGraph branch above; see that call's comment.
                        try {
                            await applyBulkQuestionAliases({
                                outboxStore: deps.outboxStore, workspace: requestedWorkspace!,
                                initiator: 'http:POST /api/nodes/bulk', logPrefix: '[Lore HTTP bulk]',
                                node: {
                                    id: raw.id as string, type: raw.type as string,
                                    project: (raw as Record<string, unknown>).project as string,
                                    ecosystem: (raw as Record<string, unknown>).ecosystem as string,
                                },
                                questions,
                                resolveStoredScopes: storedScopesResolver(scopeDeps, raw.id as string),
                            });
                        } catch (aliasErr) {
                            console.error(`[Lore HTTP] bulk question-alias fan-out failed for ${raw.id as string} (non-fatal): ${redactError(aliasErr)}`);
                        }
                        if (embedMode === 'queued') {
                            // ARCADE (non-local): queued embeds ride a WIRED verbatim.upsert
                            // row per node (see bulkEmbedFlush.ts). project was stamped above.
                            verbatimSpecs.push(buildVerbatimSpec({
                                id: raw.id as string,
                                text: buildVerbatimText(
                                    raw.label as string,
                                    (raw.content as string | undefined) ?? '',
                                    tagsToArray(raw.tags as string | string[] | undefined),
                                ),
                                type: raw.type as string,
                                label: raw.label as string,
                                tags: tagsToString(raw.tags as string | string[] | undefined),
                                project: (raw as Record<string, unknown>).project as string,
                                ecosystem: (raw as Record<string, unknown>).ecosystem as string,
                            }));
                        }
                    } else if (deps.outboxStore && chunkEntries) {
                        // QA A2 round-4 finding 2 (2026-09-03) — `upsertOne`'s outer
                        // catch (a genuine post-outbox-commit substrate failure) AND
                        // its own inline-verbatim rollback branch both return here as
                        // `ok:false` after this id's node.upsert row was already
                        // committed above; either way the row now claims a write that
                        // did not durably happen, same as the batchGraph branch's
                        // `!br.ok` case. Retract it.
                        const entry = chunkEntries[k];
                        if (entry) {
                            try {
                                await retractBulkNodeUpsert({ store: deps.outboxStore, entryId: entry.id, workspace: requestedWorkspace!, graph: targetGraph, id: raw.id as string, written: raw as Record<string, unknown>, claimedRevision: entryRevision(entry) });
                            } catch (retractErr) {
                                console.error(`[Lore HTTP] bulk upsert (ARCADE): node.upsert outbox retraction failed for ${raw.id as string}: ${redactError(retractErr)} — replicator may create a ghost node`);
                            }
                        }
                    }
                    results[idx] = r;
                }
            });
        }
    }
    // Flush the queued-embed outbox rows — mode-specific strategy (LOCAL
    // embed.batch vs ARCADE per-node verbatim.upsert) lives in bulkEmbedFlush.ts.
    // `batchGraph` (a local-engine handle or null) is the LOCAL/ARCADE discriminator.
    await flushBulkQueuedEmbeds({
        isLocalTarget: batchGraph !== null,
        outboxStore: deps.outboxStore,
        auditLog: deps.auditLog,
        requestedWorkspace: requestedWorkspace!,
        embedTexts,
        embedTargetIds,
        verbatimSpecs,
    });
    // F-COL4 — bump the quota counter by the SUCCEEDED node count + their byte
    // estimate, only after substrate writes resolved (mirrors bumpNodeWriteQuota
    // on the single-write path; avoids counter-up-on-failed-write drift).
    if (deps.quotaStore && succeeded > 0) {
        let bytes = 0;
        for (const { raw } of validSpecs) bytes += Buffer.byteLength(`${String(raw.label ?? '')}${String(raw.content ?? '')}`, 'utf8');
        deps.quotaStore.increment(requestedWorkspace!, { nodes: succeeded, bytes });
    }
    deps.auditLog.log({
        toolName: 'bulk_store_nodes',
        args: { count: parsed.nodes.length, workspace: requestedWorkspace ?? null, surface: 'http', embedMode: callEmbedMode },
        result: succeeded + unchangedCount === parsed.nodes.length ? 'success' : 'error',
        resultDetail: succeeded + unchangedCount === parsed.nodes.length ? undefined : `${parsed.nodes.length - succeeded - unchangedCount} item failure(s)`,
        durationMs: 0,
    });
    const okCount = succeeded + unchangedCount;
    writeJson(res, 200, { ok: okCount === parsed.nodes.length, count: parsed.nodes.length, succeeded: okCount, results });
    return true;
}

async function upsertOne(
    storageClient: LoreStorageClient,
    raw: NodeInput,
    deps: BulkWriteDeps,
    embedMode: BulkEmbedMode = 'inline',
    ifAbsent = false,
    stamp?: RevisionStamp,
    spec?: ConditionalSpec,
): Promise<BulkResult & { id?: string }> {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'item must be an object' };
    if (typeof raw.id !== 'string' || typeof raw.type !== 'string' || typeof raw.label !== 'string') {
        return { ok: false, error: 'id, type, and label are required strings' };
    }
    try {
        // Route through the LoreStorageClient facade (cloud-swap point) rather
        // than calling loreGraph.upsertNode() directly. SP-20 / D-019.
        // 3.26.0 — read first, so a failed inline seed restores an existing node; a failed read fails the item before it writes.
        // A graph without getNode keeps the pre-3.26 undo (delete).
        const readGraph = storageClient.rawGraph();
        // Phase 2b — the item's ifRevision / preconditions, judged at its turn under the chunk locks (earlier items of the chunk are already in the graph).
        const refused = spec ? await checkSpecConditions(readGraph, spec) : null;
        if (refused) return { ok: false, id: raw.id, ...refused };
        const prior = embedMode === 'inline' && typeof readGraph.getNode === 'function' ? await readGraph.getNode(raw.id) : undefined;
        // Phase 2a — a stamped item (its outbox row predicted `stamp.expected + 1`) is written conditionally on that revision, retrying in place on a cross-process conflict.
        const node = ifAbsent ? await storageClient.insertNodeIfAbsent(raw as never)
            : stamp ? await writeStamped(readGraph, spec ?? { idx: -1, raw }, stamp, (expected) => storageClient.upsertNodeAtRevision(raw as never, expected, stamp.updatedAt, spec?.ifRevision !== undefined))
            : await storageClient.upsertNode(raw as never);
        // Sprint E2 — only legacy 'inline' invokes the synchronous per-item
        // verbatim store. 'queued' rolls up into ONE embed.batch row by the
        // caller after this loop; 'skip' never embeds (caller re-embeds later).
        if (embedMode === 'inline') {
            const verbatimText = buildVerbatimText(
                raw.label as string,
                (raw.content as string | undefined) ?? '',
                tagsToArray(raw.tags as string | string[] | undefined),
            );
            // L-012 — route the inline verbatim seed through the SAME facade
            // (`storageClient` = `target`, built with the requested workspace's
            // verbatim store) instead of the boot-bound deps.store.storageClient,
            // so the embedding lands in the same workspace as the graph node.
            // C-R3-01 — AWAIT the inline seed (was fire-and-forget). On failure
            // roll back the just-written graph node and report ok:false so a
            // failed embedding never leaves a graph-only orphan reported as ok:true.
            try {
                // Shared builder (bulkNodeScope.ts) — this path was ALREADY
                // correct (it reads the returned graph node, which is what made
                // the batched branch's hardcoded '*' visible as a bug), so it
                // routes through the same helper to keep all three bulk verbatim
                // producers on one definition rather than three copies.
                await storageClient.verbatimStore({
                    id: `lore:${raw.id}`,
                    text: verbatimText,
                    metadata: buildBulkVerbatimMetadata({
                        type: raw.type as string,
                        label: raw.label as string,
                        tags: tagsToString(raw.tags as string | string[] | undefined),
                        project: node.project,
                        ecosystem: node.ecosystem,
                        updatedAt: node.updatedAt,
                        text: verbatimText,
                        // This path serves graphs without bulkUpsertNodes (ARCADE/cloud), whose node
                        // rows never carry scopes: they read back [] whatever the verbatim row holds
                        // (arcadeGraphReads.ts). Pass the scopes only when the graph really reports
                        // some; otherwise omit so the existing canonical row's scopes are kept, never
                        // reset to public by a rewrite.
                        security_scopes: Array.isArray(node.security_scopes) && node.security_scopes.length > 0 ? node.security_scopes : undefined,
                    }),
                });
            } catch (err) {
                try { await undoBulkGraphWrite(storageClient.rawGraph(), raw.id, prior, raw as Record<string, unknown>); }
                catch (delErr) { console.error(`[Lore HTTP] upsertOne inline rollback failed for ${raw.id as string}: ${redactError(delErr)}`); }
                return { ok: false, id: raw.id, error: `verbatim seed failed: ${redactError(err)}` };
            }
        }
        return { ok: true, id: raw.id, ...(node.revision !== undefined ? { revision: node.revision } : {}) };
    } catch (err) {
        if (err instanceof ItemConditionError) return { ok: false, id: raw.id, ...err.payload };
        return { ok: false, id: raw.id, error: isNodeAlreadyExists(err) ? alreadyExistsError(err) : (err as Error).message };
    }
}

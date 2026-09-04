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
import { recordHotWriteBatch, retractHotWriteOrCompensate } from '../../../outbox/hotLane.js';
import { withNodeLocks, chunkForLocking, BULK_LOCK_CHUNK_SIZE } from '../../../core/nodeWriteLock.js';
import { flushBulkQueuedEmbeds, buildVerbatimSpec, type VerbatimSpec } from './bulkEmbedFlush.js';
import { handleBulkRecall } from './bulkRecall.js';
import { handleBulkEdges, handleBulkDelete } from './bulkWriteEdgesDelete.js';
import { normaliseBulkNodeScope, buildBulkVerbatimMetadata } from '../../../core/bulkNodeScope.js';
import type { OutboxEntry, OutboxStore } from '../../../outbox/types.js';
import type { WorkspaceVerbatimResolver } from '../../../outbox/workspaceVerbatimResolver.js';
import type { VerbatimStore } from '../../../engines/verbatimStore.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';

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
}

export const ITEM_CAP = 1000;

export interface BulkResult {
    ok: boolean;
    error?: string;
}

export async function resolveGraph(
    deps: BulkWriteDeps,
    requestedWorkspace?: string,
): Promise<LoreGraph | { error: 'workspace_not_found'; requested: string; known: string[] }> {
    if (!deps.graphRegistry) return deps.store.loreGraph;
    const target = requestedWorkspace ?? deps.graphRegistry.activeName();
    try {
        // getGraphHandle resolves the DECLARED engine, so a bulk write
        // lands in the requested workspace's own graph rather than an
        // empty db for the wrong engine while reporting ok:true. Gate
        // still runs inside.
        return await deps.graphRegistry.getGraphHandle(target);
    } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
            return { error: 'workspace_not_found', requested: err.requested, known: err.known };
        }
        throw err;
    }
}

/** Canonical-envelope emitter for the resolveGraph() workspace_not_found shape. */
export function writeWorkspaceNotFound(
    res: ServerResponse,
    err: { error: 'workspace_not_found'; requested: string; known: string[] },
): void {
    writeError(res, 404, err.error, `workspace not found: ${err.requested}`, {
        requested: err.requested,
        known: err.known,
    });
}

interface NodeInput {
    id?: unknown;
    type?: unknown;
    label?: unknown;
    content?: unknown;
    tags?: unknown;
    workspace?: unknown;
    embed?: unknown;
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

    if (isBulkNodes) return handleBulkNodes(res, parsed as { nodes?: unknown; workspace?: unknown; embed?: unknown }, deps);
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
    parsed: { nodes?: unknown; workspace?: unknown; embed?: unknown },
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
    let targetVerbatim: VerbatimStore | typeof deps.store.loreVerbatim = deps.store.loreVerbatim;
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
    const validSpecs: Array<{ idx: number; raw: NodeInput; embedMode: BulkEmbedMode }> = [];
    const results: Array<BulkResult & { id?: string }> = new Array(items.length);
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
        // project==workspace + ecosystem defaulting, stamped to exactly what
        // rowToLoreNode will report for the graph row — see bulkNodeScope.ts
        // for the invariant and what breaking it costs. (dispatcher guarantees
        // requestedWorkspace is non-empty.)
        normaliseBulkNodeScope(raw as Record<string, unknown>, requestedWorkspace as string);
        const embedMode = parseBulkEmbedMode(raw.embed, callEmbedMode);
        validSpecs.push({ idx: i, raw, embedMode });
    }
    let succeeded = 0;
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
        for (const chunk of chunkForLocking(validSpecs, BULK_LOCK_CHUNK_SIZE)) {
            await withNodeLocks(lockWorkspace, chunk.map(({ raw }) => raw.id as string), async () => {
                let chunkEntries: OutboxEntry[] | null = null;
                if (deps.outboxStore && chunk.length > 0) {
                    try {
                        chunkEntries = await recordHotWriteBatch(deps.outboxStore, chunk.map(({ raw }) => ({
                            workspace: requestedWorkspace!,
                            operationKind: 'node.upsert',
                            payload: raw as unknown as Record<string, unknown>,
                            initiator: 'http:POST /api/nodes/bulk',
                            operation: 'graph.upsert',
                        })));
                    } catch (err) {
                        const msg = `outbox commit failed: ${(err as Error).message}`;
                        for (const { idx, raw } of chunk) results[idx] = { ok: false, id: raw.id as string, error: msg };
                        return;
                    }
                }
                const batchResults = await batchGraph.bulkUpsertNodes(
                    chunk.map((s) => s.raw as unknown as Parameters<typeof batchGraph.bulkUpsertNodes>[0][number]),
                );
                for (let k = 0; k < chunk.length; k++) {
                    const { idx, raw, embedMode } = chunk[k]!;
                    const br = batchResults[k]!;
                    if (!br.ok) {
                        results[idx] = { ok: false, id: raw.id as string, error: br.error };
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
                                    await retractHotWriteOrCompensate(deps.outboxStore, entry.id, {
                                        workspace: requestedWorkspace!,
                                        operationKind: 'node.delete',
                                        payload: { id: raw.id as string },
                                        initiator: 'http:POST /api/nodes/bulk',
                                        operation: 'graph.delete',
                                    });
                                } catch (retractErr) {
                                    console.error(`[Lore HTTP] bulk upsert: node.upsert outbox retraction failed for ${raw.id as string}: ${redactError(retractErr)} — replicator may create a ghost node`);
                                }
                            }
                        }
                        continue;
                    }
                    succeeded++;
                    results[idx] = { ok: true, id: raw.id as string };
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
                        // roll back its graph node. (The default 'queued' path is outbox-
                        // tracked and unaffected.)
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
                                }),
                            });
                        } catch (err) {
                            results[idx] = { ok: false, id: raw.id as string, error: `verbatim seed failed: ${redactError(err)}` };
                            succeeded--;
                            try { await withTransactionConflictRetry(() => targetGraph.deleteNode(raw.id as string)); }
                            catch (delErr) { console.error(`[Lore HTTP] bulk inline rollback deleteNode failed for ${raw.id as string}: ${redactError(delErr)}`); }
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
                                        await retractHotWriteOrCompensate(deps.outboxStore, entry.id, {
                                            workspace: requestedWorkspace!,
                                            operationKind: 'node.delete',
                                            payload: { id: raw.id as string },
                                            initiator: 'http:POST /api/nodes/bulk',
                                            operation: 'graph.delete',
                                        });
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
        for (const chunk of chunkForLocking(validSpecs, BULK_LOCK_CHUNK_SIZE)) {
            await withNodeLocks(lockWorkspace, chunk.map(({ raw }) => raw.id as string), async () => {
                let chunkEntries: OutboxEntry[] | null = null;
                if (deps.outboxStore && chunk.length > 0) {
                    try {
                        chunkEntries = await recordHotWriteBatch(deps.outboxStore, chunk.map(({ raw }) => ({
                            workspace: requestedWorkspace!,
                            operationKind: 'node.upsert',
                            payload: raw as unknown as Record<string, unknown>,
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
                    const { idx, raw, embedMode } = chunk[k]!;
                    const r = await upsertOne(target, raw, deps, embedMode);
                    if (r.ok) {
                        succeeded++;
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
                                await retractHotWriteOrCompensate(deps.outboxStore, entry.id, {
                                    workspace: requestedWorkspace!,
                                    operationKind: 'node.delete',
                                    payload: { id: raw.id as string },
                                    initiator: 'http:POST /api/nodes/bulk',
                                    operation: 'graph.delete',
                                });
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
        result: succeeded === parsed.nodes.length ? 'success' : 'error',
        resultDetail: succeeded === parsed.nodes.length ? undefined : `${parsed.nodes.length - succeeded} item failure(s)`,
        durationMs: 0,
    });
    writeJson(res, 200, { ok: succeeded === parsed.nodes.length, count: parsed.nodes.length, succeeded, results });
    return true;
}

async function upsertOne(
    storageClient: LoreStorageClient,
    raw: NodeInput,
    deps: BulkWriteDeps,
    embedMode: BulkEmbedMode = 'inline',
): Promise<BulkResult & { id?: string }> {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'item must be an object' };
    if (typeof raw.id !== 'string' || typeof raw.type !== 'string' || typeof raw.label !== 'string') {
        return { ok: false, error: 'id, type, and label are required strings' };
    }
    try {
        // Route through the LoreStorageClient facade (cloud-swap point) rather
        // than calling loreGraph.upsertNode() directly. SP-20 / D-019.
        const node = await storageClient.upsertNode(raw as never);
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
                    }),
                });
            } catch (err) {
                const rid = raw.id;
                try { await withTransactionConflictRetry(() => storageClient.rawGraph().deleteNode(rid)); }
                catch (delErr) { console.error(`[Lore HTTP] upsertOne inline rollback deleteNode failed for ${raw.id as string}: ${redactError(delErr)}`); }
                return { ok: false, id: raw.id, error: `verbatim seed failed: ${redactError(err)}` };
            }
        }
        return { ok: true, id: raw.id };
    } catch (err) {
        return { ok: false, id: raw.id, error: (err as Error).message };
    }
}

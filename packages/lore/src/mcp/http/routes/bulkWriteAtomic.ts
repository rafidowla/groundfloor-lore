/**
 * bulkWriteAtomic.ts - 3.35.0 (S2): `POST /api/nodes/bulk` with `atomic: true`, the all-or-nothing node batch.
 *
 * Every item lands, or none does, ACROSS DAEMONS sharing one database: the whole batch is ONE
 * `commitNodeBatch` (engines/graphShared/nodeBatch.ts) - one ArcadeDB sqlscript transaction, or one SQLite
 * `BEGIN IMMEDIATE` transaction - so no other daemon sees a partial batch, and no write to any batch item can
 * slip in between our read and our commit without one side aborting.
 *
 * Response (`atomic` only; the non-atomic response is untouched):
 *   200 {ok:true, atomic:true, count, succeeded, results:[{ok:true,id,revision,...}]}
 *   409 {ok:false, code, failedIndex, id, reason}   a condition failed (already_exists | revision_mismatch |
 *                                                   precondition_failed); nothing was written
 *   422 {ok:false, code, failedIndex?, reason}      the request is refused whole (invalid_item, atomic_batch_too_large,
 *                                                   atomic_lock_cap, atomic_duplicate_ids, atomic_inline_embed_unsupported,
 *                                                   atomic_supersedes_unsupported, atomic_edges_unsupported)
 *   501 {ok:false, code:'not_supported', reason}    the engine has no atomic multi-node commit (Dataplane, Surreal)
 *   503 {ok:false, code, retryable, reason}         contention (retries exhausted) | lock_timeout | arcade_unavailable |
 *                                                   timeout | outcome_unknown (retryable:false, see below); nothing written
 *                                                   except for outcome_unknown
 *
 * Flow (plan 3.2): validate + refuse -> hold EVERY item and precondition lock at once (budgeted wait) -> read every
 * item, judge its conditions, stamp the revision it is written on top of -> record all outbox rows ONCE (`pending_commit`,
 * with the predicted revisions) -> `commitNodeBatchWithRetry` (D10: re-reads and re-judges on a contention retry, re-records
 * only the rows whose stamp moved) -> flip the rows ready / retract them all. A plain item (no `ifRevision`) whose revision a
 * rival moved is re-stamped and the batch re-submitted (bounded by MAX_REVISION_ATTEMPTS); an `ifRevision`, `ifAbsent` or
 * precondition miss is final.
 *
 * An `unknown` commit outcome is settled by re-reading (nodeBatchRetry.ts). When it cannot be proved - including a MIXED
 * outcome, some items showing this batch's stamp and some not - the answer is `outcome_unknown`, the outbox rows stay
 * `pending_commit`, and the replicator's sweep settles each row from the graph. Never retried blindly.
 *
 * Preconditions are judged against the state BEFORE the batch (all items commit together, so none sees another's new
 * revision). A precondition that names an item of the same batch is covered by that item's own revision guard.
 *
 * What atomic does NOT cover: recall. Vectors are written per item when the outbox replays, so items become searchable one
 * by one; see `POST /api/nodes/recallable` to wait for a set of ids.
 */
import type { ServerResponse } from 'node:http';
import type { LoreNode } from '../../../providers/types.js';
import type { OutboxEntry, OutboxStore } from '../../../outbox/types.js';
import { recordHotWriteBatch, commitHotRows } from '../../../outbox/hotLane.js';
import { redactError } from '../../../security/logRedact.js';
import { buildVerbatimText } from '../../../engines/verbatimSchema.js';
import { tagsToArray, tagsToString } from '../../../engines/normalizeTags.js';
import { withNodeLocks, NodeLockTimeoutError } from '../../../core/nodeWriteLock.js';
import {
    ItemConditionError, findFailedPreconditions, preconditionFailedMessage, revisionMismatchMessage, type FailedPrecondition,
} from '../../../core/conditionalChecks.js';
import {
    MAX_NODE_BATCH_CHECKS, MAX_NODE_BATCH_WRITES, hasNodeBatchSupport,
    type NodeBatchCapable, type NodeBatchCheck, type NodeBatchNodeInput, type NodeBatchWrite,
} from '../../../engines/graphShared/nodeBatch.js';
import { commitNodeBatchWithRetry, isNodeBatchContention, NodeBatchContentionError, type NodeBatchPlan, type NodeBatchResult } from '../../../engines/graphShared/nodeBatchRetry.js';
import { alreadyExistsError, isNodeAlreadyExists, NodeAlreadyExistsError } from '../../../engines/graphShared/conditionalInsert.js';
import { MAX_REVISION_ATTEMPTS, revisionOf } from '../../../engines/graphShared/revision.js';
import { isOutcomeUnknown } from '../../../engines/graphShared/writeOutcome.js';
import { applyBulkQuestionAliases } from '../../../core/bulkQuestionAliases.js';
import type { ItemScopeDeps } from '../../../security/itemScopes.js';
import { writeJson } from '../helpers.js';
import { NODE_BUSY_RETRY_AFTER_S } from '../helpers.js';
import { entryRevision, retractBulkNodeUpsert } from './bulkWriteRollback.js';
import { bulkLockIds, bulkOutboxPayload, reconcileOutboxRevision, type ConditionalSpec, type RevisionStamp } from './bulkWriteConditional.js';
import { classifyItemWriteError } from './bulkWriteErrors.js';
import { storedScopesResolver } from './bulkWriteScope.js';
import { buildVerbatimSpec, type VerbatimSpec } from './bulkEmbedFlush.js';

/** D3: at most 100 items and 400 distinct lock ids (items + precondition ids) per atomic batch. */
export const ATOMIC_ITEM_CAP = MAX_NODE_BATCH_WRITES;
export const ATOMIC_LOCK_ID_CAP = MAX_NODE_BATCH_CHECKS;

const INITIATOR = 'http:POST /api/nodes/bulk';

/** A request refused whole, before anything is read or written. */
export interface AtomicRefusal { status: number; body: Record<string, unknown> }

const refuse = (status: number, code: string, reason: string, failedIndex?: number): AtomicRefusal =>
    ({ status, body: { ok: false, code, ...(failedIndex !== undefined ? { failedIndex } : {}), reason } });

const isInline = (v: unknown): boolean => v === 'inline' || v === true;

/**
 * Body-level refusals (D3-D6): the cap, `embed:'inline'` (a failed inline seed cannot be rolled back with the graph), item
 * `supersedes` (it commits as separate statements), `edges` (nodes only), duplicate ids. Pure: no graph, no I/O.
 * `atomic` must be a boolean; the caller only gets here when it is present.
 */
export function atomicRefusal(parsed: { atomic?: unknown; nodes: unknown[]; embed?: unknown; edges?: unknown }): AtomicRefusal | null {
    if (typeof parsed.atomic !== 'boolean') return refuse(400, 'bad_request', '`atomic` must be a boolean');
    if (!parsed.atomic) return null;
    if (parsed.nodes.length > ATOMIC_ITEM_CAP) return refuse(422, 'atomic_batch_too_large', `an atomic batch takes at most ${ATOMIC_ITEM_CAP} nodes (got ${parsed.nodes.length}); send smaller batches or use atomic:false`);
    if (parsed.edges !== undefined) return refuse(422, 'atomic_edges_unsupported', 'an atomic batch is nodes only; edges cannot be part of it');
    if (isInline(parsed.embed)) return refuse(422, 'atomic_inline_embed_unsupported', "embed:'inline' cannot be atomic (a failed vector write cannot be rolled back with the graph); use the default queued embedding");
    const seen = new Set<string>();
    for (let i = 0; i < parsed.nodes.length; i++) {
        const it = parsed.nodes[i] as Record<string, unknown> | null;
        if (!it || typeof it !== 'object') continue;
        if (isInline(it['embed'])) return refuse(422, 'atomic_inline_embed_unsupported', `item ${i}: embed:'inline' cannot be atomic; use the default queued embedding`, i);
        const sup = it['supersedes'];
        if (sup !== undefined && sup !== null && !(Array.isArray(sup) && sup.length === 0)) return refuse(422, 'atomic_supersedes_unsupported', `item ${i}: \`supersedes\` cannot be part of an atomic batch; supersede in a separate call`, i);
        if (typeof it['id'] === 'string') {
            if (seen.has(it['id'])) return refuse(422, 'atomic_duplicate_ids', `item ${i}: id '${it['id']}' appears twice in one atomic batch`, i);
            seen.add(it['id']);
        }
    }
    return null;
}

/** Write a refusal. Returns true (the response is written). */
export function writeAtomicRefusal(res: ServerResponse, r: AtomicRefusal): true {
    writeJson(res, r.status, r.body);
    return true;
}

/** D11: the engine has no atomic multi-node commit. */
export function writeAtomicNotSupported(res: ServerResponse): true {
    return writeAtomicRefusal(res, refuse(501, 'not_supported', 'this storage engine has no atomic multi-node commit, so atomic:true is not available here; send atomic:false'));
}

type AtomicGraph = NodeBatchCapable & { getNode(id: string): Promise<LoreNode | null> };

/** The graph handle that carries the primitive, or null (-> 501). */
export function atomicGraphOf(...candidates: unknown[]): AtomicGraph | null {
    for (const g of candidates) if (hasNodeBatchSupport(g) && typeof (g as { getNode?: unknown }).getNode === 'function') return g as AtomicGraph;
    return null;
}

/** A validated bulk item as the atomic path needs it. */
export interface AtomicSpec extends ConditionalSpec {
    embedMode: 'inline' | 'queued' | 'skip';
    questions: string[] | undefined;
    supersessionWarning: string | undefined;
}

export interface AtomicRun {
    res: ServerResponse;
    outboxStore?: OutboxStore;
    /** The workspace named in the request (outbox rows) and the one the locks are keyed on. */
    workspace: string;
    lockWorkspace: string;
    graph: AtomicGraph;
    specs: readonly AtomicSpec[];
    /** Per-item validation failures recorded by the shared item validator (a hole = valid). */
    results: Array<{ ok: boolean; id?: string; error?: string; revision?: number; supersessionWarning?: string }>;
    scopeDeps: ItemScopeDeps;
    /** Queued-embed sinks (the route flushes them after a commit). `isLocalTarget` picks the local embed.batch vs per-node rows. */
    embeds: { isLocalTarget: boolean; embedTexts: string[]; embedTargetIds: string[]; verbatimSpecs: VerbatimSpec[] };
}

export type AtomicItemResult = { ok: true; id: string; revision: number; supersessionWarning?: string };

/** Thrown inside the prepare step: the item at `idx` failed a condition (nothing is written). */
class AtomicConditionFailure extends Error {
    constructor(readonly idx: number, readonly id: string, readonly code: string, readonly payload: { error: string; currentRevision?: number | null; failedPreconditions?: FailedPrecondition[] }) {
        super(payload.error);
        this.name = 'AtomicConditionFailure';
    }
}

/** Thrown inside the prepare step: the outbox rows could not be recorded (nothing is written). */
class AtomicOutboxFailure extends Error {
    constructor(cause: unknown) {
        super(`outbox commit failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'AtomicOutboxFailure';
    }
}

const fail = (res: ServerResponse, status: number, body: Record<string, unknown>, retryAfterS?: number): null => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...(retryAfterS !== undefined ? { 'Retry-After': String(retryAfterS) } : {}) });
    res.end(JSON.stringify({ ok: false, ...body }));
    return null;
};

/**
 * Run the atomic batch. Returns the number of items committed (the route then flushes the queued embeds and answers 200),
 * or null when this function has ALREADY written the (error) response.
 */
export async function runAtomicBulk(a: AtomicRun): Promise<number | null> {
    const { res, graph, specs, workspace } = a;
    const bad = a.results.findIndex((r) => r !== undefined && !r.ok);
    if (bad >= 0) return fail(res, 422, { code: 'invalid_item', failedIndex: bad, ...(a.results[bad]!.id ? { id: a.results[bad]!.id } : {}), reason: a.results[bad]!.error });
    const lockIds = bulkLockIds(specs);
    if (lockIds.length > ATOMIC_LOCK_ID_CAP) return fail(res, 422, { code: 'atomic_lock_cap', reason: `an atomic batch may name at most ${ATOMIC_LOCK_ID_CAP} distinct node ids including preconditions (got ${lockIds.length})` });

    const store = a.outboxStore;
    const idOf = (s: ConditionalSpec): string => s.raw.id as string;
    const writeIds = new Set(specs.map(idOf));
    const stamps = new Map<number, RevisionStamp>();
    const rowKey = new Map<number, string>();
    const rows = new Map<number, OutboxEntry>();
    let owners: AtomicSpec[] = [];
    let checkOwners: Array<{ id: string; spec: AtomicSpec }> = [];

    const retractAll = async (): Promise<void> => {
        if (!store) return;
        for (const spec of specs) {
            const entry = rows.get(spec.idx);
            if (!entry) continue;
            try { await retractBulkNodeUpsert({ store, entryId: entry.id, workspace, graph, id: idOf(spec), written: spec.raw as Record<string, unknown>, claimedRevision: entryRevision(entry) }); }
            catch (err) { console.error(`[Lore HTTP] atomic bulk: outbox retraction failed for ${idOf(spec)}: ${redactError(err)} — replicator may create a ghost node`); }
        }
        rows.clear();
    };

    /** Record every row once; on a retry re-record only the rows whose stamp moved. */
    const syncRows = async (): Promise<void> => {
        if (!store) return;
        const changed = specs.filter((s) => rowKey.get(s.idx) !== `${stamps.get(s.idx)!.expected}:${stamps.get(s.idx)!.updatedAt}`);
        if (changed.length === 0) return;
        try {
            for (const s of changed) {
                const old = rows.get(s.idx);
                if (old) { if (store.removeIfPending) await store.removeIfPending(old.id); else await store.remove(old.id); rows.delete(s.idx); }
            }
            const made = await recordHotWriteBatch(store, changed.map((s) => ({
                workspace, operationKind: 'node.upsert' as const, payload: bulkOutboxPayload(s, stamps.get(s.idx)), initiator: INITIATOR,
                operation: 'graph.upsert', pendingCommit: true, // R3: flipped ready once the batch committed
            })));
            changed.forEach((s, k) => { rows.set(s.idx, made[k]!); rowKey.set(s.idx, `${stamps.get(s.idx)!.expected}:${stamps.get(s.idx)!.updatedAt}`); });
        } catch (err) { throw new AtomicOutboxFailure(err); }
    };

    /** D10: runs before EVERY attempt - reads each item afresh, judges its conditions, stamps, records/updates the rows. */
    const prepare = async (): Promise<NodeBatchPlan> => {
        const checks = new Map<string, { revision: number; spec: AtomicSpec }>();
        const expecteds: number[] = [];
        for (const spec of specs) {
            const id = idOf(spec);
            const row = await graph.getNode(id);
            if (spec.ifAbsent) {
                if (row) throw new AtomicConditionFailure(spec.idx, id, 'already_exists', { error: alreadyExistsError(new Error(`a node with id '${id}' already exists in this workspace`)) });
                expecteds.push(0);
            } else {
                const found = row ? revisionOf(row) : null;
                if (spec.ifRevision !== undefined && found !== spec.ifRevision) {
                    throw new AtomicConditionFailure(spec.idx, id, 'revision_mismatch', { error: revisionMismatchMessage(id, spec.ifRevision, found), currentRevision: found });
                }
                expecteds.push(spec.ifRevision ?? revisionOf(row));
            }
            if (spec.preconditions && spec.preconditions.length > 0) {
                const failed = await findFailedPreconditions(graph, spec.preconditions);
                if (failed.length > 0) throw new AtomicConditionFailure(spec.idx, id, 'precondition_failed', { error: preconditionFailedMessage(failed), failedPreconditions: failed });
                // A precondition on an item of this same batch is covered by that item's own revision guard; the rest are touched.
                for (const p of spec.preconditions) if (!writeIds.has(p.id) && !checks.has(p.id)) checks.set(p.id, { revision: p.revision, spec });
            }
        }
        // One stamp for the whole batch; a retry keeps it only while nothing it was stamped on top of has moved.
        const unchanged = specs.every((s, k) => stamps.get(s.idx)?.expected === expecteds[k]);
        const now = new Date().toISOString();
        const writes: NodeBatchWrite[] = specs.map((spec, k) => {
            const updatedAt = unchanged ? stamps.get(spec.idx)!.updatedAt : now;
            stamps.set(spec.idx, { expected: expecteds[k]!, updatedAt });
            const node = spec.raw as unknown as NodeBatchNodeInput;
            return spec.ifAbsent ? { kind: 'insert', node, updatedAt }
                : { kind: 'cas', node, expectedRevision: expecteds[k]!, mustExist: spec.ifRevision !== undefined, updatedAt };
        });
        owners = [...specs];
        checkOwners = [...checks].map(([id, c]) => ({ id, spec: c.spec }));
        await syncRows();
        const list: NodeBatchCheck[] = [...checks].map(([id, c]) => ({ id, revision: c.revision }));
        return { checks: list, writes };
    };

    let result: NodeBatchResult | undefined;
    let held = false;
    try {
        await withNodeLocks(a.lockWorkspace, lockIds, async () => {
            held = true;
            for (let pass = 1; ; pass++) {
                result = await commitNodeBatchWithRetry(graph, prepare);
                if (result.ok || result.code !== 'revision') return;
                const spec = owners[result.index];
                // A plain item whose revision a rival moved is re-stamped and the batch re-submitted; ifRevision is final.
                if (!spec || spec.ifRevision !== undefined) return;
                if (pass >= MAX_REVISION_ATTEMPTS) throw new NodeBatchContentionError(MAX_REVISION_ATTEMPTS);
            }
        });
    } catch (err) {
        return handleThrown(a, err, held, retractAll);
    }
    const r = result!;
    if (!r.ok) {
        await retractAll();
        const spec = r.code === 'precondition' ? checkOwners[r.index]?.spec : owners[r.index];
        const idx = spec?.idx;
        if (r.code === 'exists') return fail(res, 409, { code: 'already_exists', failedIndex: idx, id: r.id, reason: alreadyExistsError(new NodeAlreadyExistsError(r.id)) });
        if (r.code === 'revision') return fail(res, 409, { code: 'revision_mismatch', failedIndex: idx, id: r.id, currentRevision: r.actual, reason: revisionMismatchMessage(r.id, spec?.ifRevision ?? 0, r.actual ?? 0) });
        if (r.code === 'precondition') {
            let list: FailedPrecondition[] = [];
            try { list = spec?.preconditions ? await findFailedPreconditions(graph, spec.preconditions) : []; } catch { /* keep the fallback */ }
            const p = spec?.preconditions?.find((x) => x.id === r.id);
            if (list.length === 0 && p) list = [{ id: p.id, expected: p.revision, found: r.actual ?? null }];
            return fail(res, 409, { code: 'precondition_failed', failedIndex: idx, id: r.id, failedPreconditions: list, reason: list.length ? preconditionFailedMessage(list) : `precondition_failed: ${r.id} changed while the batch was committing` });
        }
        return fail(res, 500, { code: 'write_failed', failedIndex: idx, id: r.id, reason: `unexpected node batch outcome '${r.code}'` });
    }

    // Committed: every row becomes replicable. Rows whose predicted revision equals what landed flip in ONE call.
    const out: AtomicItemResult[] = [];
    const flipNow: string[] = [];
    for (const spec of specs) {
        const id = idOf(spec);
        const landed = r.revisions[id]!;
        const entry = rows.get(spec.idx);
        if (entry && entryRevision(entry) !== undefined && entryRevision(entry) !== landed) {
            await reconcileOutboxRevision({ store, entry, stamp: stamps.get(spec.idx), landed, workspace, id });
        } else if (entry) flipNow.push(entry.id);
        out.push({ ok: true, id, revision: landed, ...(spec.supersessionWarning ? { supersessionWarning: spec.supersessionWarning } : {}) });
    }
    await commitHotRows(store, flipNow);
    for (const spec of specs) await afterCommit(a, spec);
    specs.forEach((s, k) => { a.results[s.idx] = out[k]!; });
    return specs.length;
}

/** Per-item follow-ups once the graph rows are durable: question aliases and the queued-embed sinks. Never fails the batch. */
async function afterCommit(a: AtomicRun, spec: AtomicSpec): Promise<void> {
    const raw = spec.raw as unknown as Record<string, unknown> & { id: string; type: string; label: string };
    try {
        await applyBulkQuestionAliases({
            outboxStore: a.outboxStore, workspace: a.workspace, initiator: INITIATOR, logPrefix: '[Lore HTTP bulk]',
            node: { id: raw.id, type: raw.type, project: raw['project'] as string, ecosystem: raw['ecosystem'] as string },
            questions: spec.questions,
            resolveStoredScopes: storedScopesResolver(a.scopeDeps, raw.id),
        });
    } catch (err) { console.error(`[Lore HTTP] atomic bulk question-alias fan-out failed for ${raw.id} (non-fatal): ${redactError(err)}`); }
    if (spec.embedMode !== 'queued') return;
    const tags = raw['tags'] as string | string[] | undefined;
    const text = buildVerbatimText(raw.label, (raw['content'] as string | undefined) ?? '', tagsToArray(tags));
    if (a.embeds.isLocalTarget) { a.embeds.embedTexts.push(text); a.embeds.embedTargetIds.push(`lore:${raw.id}`); return; }
    a.embeds.verbatimSpecs.push(buildVerbatimSpec({
        id: raw.id, text, type: raw.type, label: raw.label, tags: tagsToString(tags),
        project: raw['project'] as string, ecosystem: raw['ecosystem'] as string,
    }));
}

/** Map everything thrown on the way to a response; nothing is written except after `outcome_unknown`. */
async function handleThrown(a: AtomicRun, err: unknown, held: boolean, retractAll: () => Promise<void>): Promise<null> {
    const { res } = a;
    if (err instanceof NodeLockTimeoutError && !held) {
        // The locks were never all free: nothing recorded, nothing read, nothing written.
        return fail(res, 503, { code: 'lock_timeout', retryable: true, reason: `another write to one of these nodes has not finished (waited ${err.waitedMs} ms); nothing was written, retry after ${NODE_BUSY_RETRY_AFTER_S}s` }, NODE_BUSY_RETRY_AFTER_S);
    }
    if (isOutcomeUnknown(err)) {
        // Rows stay pending_commit: the sweep settles each from the graph. A blind retry could double-apply.
        const idx = a.specs.find((s) => (s.raw.id as string) === (err as { id?: string }).id)?.idx;
        return fail(res, 503, { code: 'outcome_unknown', retryable: false, ...(idx !== undefined ? { failedIndex: idx } : {}), reason: `${(err as Error).message}; the batch may or may not have been applied - read the nodes before retrying` });
    }
    await retractAll();
    if (err instanceof AtomicConditionFailure) {
        return fail(res, 409, { code: err.code, failedIndex: err.idx, id: err.id, ...(err.payload.currentRevision !== undefined ? { currentRevision: err.payload.currentRevision } : {}), ...(err.payload.failedPreconditions ? { failedPreconditions: err.payload.failedPreconditions } : {}), reason: err.payload.error });
    }
    if (err instanceof ItemConditionError) return fail(res, 409, { code: 'condition_failed', reason: err.message });
    if (isNodeAlreadyExists(err)) return fail(res, 409, { code: 'already_exists', reason: alreadyExistsError(err as Error) });
    if (isNodeBatchContention(err)) return fail(res, 503, { code: 'contention', retryable: true, reason: (err as Error).message }, 1);
    if (err instanceof AtomicOutboxFailure) return fail(res, 503, { code: 'outbox_unavailable', retryable: true, reason: `${err.message}; nothing was written` }, NODE_BUSY_RETRY_AFTER_S);
    // A read or write that failed outright (nothing was applied): keep the bulk route's vocabulary.
    const c = classifyItemWriteError(err).error;
    const at = c.indexOf(': ');
    const code = at > 0 ? c.slice(0, at) : 'write_failed';
    const transient = code === 'arcade_unavailable' || code === 'timeout' || code === 'node_busy';
    return fail(res, transient ? 503 : 500, { code, ...(transient ? { retryable: true } : {}), reason: `${c}; nothing was written` }, transient ? NODE_BUSY_RETRY_AFTER_S : undefined);
}

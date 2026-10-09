/**
 * bulkWriteConditional.ts — the conditional-write steps of POST /api/nodes/bulk
 * (conditional writes, phase 1): the per-item `ifAbsent` directive (R1) and the
 * supersede guard (R2). Split from bulkWrite.ts (file-size cap).
 *
 * Everything here runs UNDER the chunk's node locks (the item ids plus the ids
 * its `supersedes` list names, see {@link bulkLockIds}), before the chunk's
 * outbox commit, so a refused item has no side effect to take back: no outbox
 * row, no graph row, no vector, no supersede.
 *
 * What the lock cannot cover is another process on the same database. For that
 * the engines carry the check themselves (`insertNodeIfAbsent`: a unique-key
 * INSERT; `supersedeNode`: a conditional UPDATE). A refusal discovered there,
 * after the item's own write, is undone with {@link undoLostClaim}.
 */
import type { LoreNode } from '../../../providers/types.js';
import type { OutboxEntry, OutboxStore } from '../../../outbox/types.js';
import { createNodeIfAbsent, alreadyExistsError, isNodeAlreadyExists, type ConditionalInsertGraph, type NodeInput } from '../../../engines/graphShared/conditionalInsert.js';
import { alreadySupersededMessage } from '../../../engines/graphShared/supersedeGuard.js';
import { redactError } from '../../../security/logRedact.js';
import { entryRevision, retractBulkNodeUpsert, undoBulkGraphWrite } from './bulkWriteRollback.js';
import { recordHotWrite } from '../../../outbox/hotLane.js';
import { MAX_REVISION_ATTEMPTS, hasRevisionSupport, isRevisionConflict, revisionOf, type RevisionedGraph } from '../../../engines/graphShared/revision.js';
import { BULK_LOCK_CHUNK_SIZE, chunkForLocking } from '../../../core/nodeWriteLock.js';
import { ItemConditionError, REVISION_UNSUPPORTED, checkItemConditions, revisionMismatchMessage, type FailedPrecondition, type Precondition } from '../../../core/conditionalChecks.js';

/** The fields of a validated bulk item the conditional steps look at. */
export interface ConditionalSpec {
    idx: number;
    raw: { id?: unknown };
    ifAbsent?: boolean;
    supersedes?: string[];
    /** Phase 2b — write only if this node is at exactly this revision. */
    ifRevision?: number;
    /** Phase 2b — write only if every listed node is at its listed revision. */
    preconditions?: Precondition[];
}

/** Ids a chunk must lock: its own ids, every `supersedes` target and every precondition id. */
export function bulkLockIds(specs: readonly ConditionalSpec[]): string[] {
    const ids = new Set<string>();
    for (const s of specs) {
        ids.add(s.raw.id as string);
        for (const old of s.supersedes ?? []) ids.add(old);
        for (const p of s.preconditions ?? []) ids.add(p.id);
    }
    return [...ids];
}

/**
 * Split items into consecutive chunks, each holding at most
 * `BULK_LOCK_CHUNK_SIZE` items (as before). Three rules keep every outbox row
 * honest (an item's row is recorded only AFTER its conditions pass, and never
 * predicts a revision that chains on an unresolved write):
 *
 *   - an item with `ifRevision` or `preconditions` gets a chunk of its OWN. Its
 *     conditions are judged under that chunk's locks (its id, its precondition
 *     ids, its supersedes targets) BEFORE its row is recorded, so a failed
 *     condition records no row at all (nothing for the replicator to claim);
 *   - a chunk never holds the same ITEM id twice: a repeated id starts a new
 *     chunk, so every item is stamped from a read taken after the earlier
 *     same-id write resolved (the replicator claims rows without the node lock,
 *     so reconciling a too-high row after the fact can lose that race);
 *   - a chunk holds at least one item.
 *
 * Order is preserved and chunks run sequentially, so items still apply strictly
 * in array order: a precondition sees every earlier item's landed revision.
 */
export function chunkSpecsForLocking<S extends ConditionalSpec>(specs: readonly S[]): S[][] {
    if (!specs.some(hasConditions) && new Set(specs.map((s) => s.raw.id as string)).size === specs.length) return chunkForLocking(specs, BULK_LOCK_CHUNK_SIZE);
    const chunks: S[][] = [];
    let cur: S[] = [];
    let itemIds = new Set<string>();
    const flush = (): void => { if (cur.length > 0) chunks.push(cur); cur = []; itemIds = new Set(); };
    for (const spec of specs) {
        if (hasConditions(spec)) { flush(); chunks.push([spec]); continue; }
        if (itemIds.has(spec.raw.id as string) || cur.length >= BULK_LOCK_CHUNK_SIZE) flush();
        cur.push(spec);
        itemIds.add(spec.raw.id as string);
    }
    flush();
    return chunks;
}

/** Item has a phase 2b condition. */
function hasConditions(s: ConditionalSpec): boolean { return s.ifRevision !== undefined || (s.preconditions?.length ?? 0) > 0; }

/** Extra fields a failed conditional item carries in its result. */
export interface ConditionFailure { error: string; currentRevision?: number | null; failedPreconditions?: FailedPrecondition[] }

/**
 * What an item's outbox row is stamped with (phase 2a): the revision read under
 * the lock (`expected`; the row records `expected + 1`) and the single
 * `updatedAt` stamp the graph write reuses.
 */
export interface RevisionStamp { expected: number; updatedAt: string }

/**
 * The outbox payload of an item: the `ifAbsent` flag rides along so replay is
 * insert-only; a stamped item carries its `updatedAt` and predicted `revision`
 * so replay is gated by revision and does not rewrite `updatedAt`.
 */
export function bulkOutboxPayload(spec: ConditionalSpec, stamp?: RevisionStamp): Record<string, unknown> {
    const raw = spec.raw as Record<string, unknown>;
    if (spec.ifAbsent) return { ...raw, ifAbsent: true };
    return stamp ? { ...raw, updatedAt: stamp.updatedAt, revision: stamp.expected + 1 } : raw;
}

/**
 * Read, under the chunk locks, the revision each item will be written on top of.
 * {@link chunkSpecsForLocking} never puts the same item id in one chunk twice, so
 * the `next` chaining below is a defensive no-op for routed callers (kept so a
 * direct caller handing a duplicate-id chunk still gets a consistent chain). A graph
 * without revision support, or an `ifAbsent` item (insert-only, always rev 1),
 * gets no stamp and keeps its legacy payload. A node that cannot be read fails
 * the item before anything is recorded.
 */
export async function stampBulkRevisions<S extends ConditionalSpec>(
    graph: { getNode?(id: string): Promise<LoreNode | null> } & RevisionedGraph,
    specs: readonly S[],
    fail: (spec: S, error: string) => void,
): Promise<{ chunk: S[]; stamps: Map<number, RevisionStamp> }> {
    const stamps = new Map<number, RevisionStamp>();
    const getNode = graph.getNode?.bind(graph);
    if (!hasRevisionSupport(graph) || !getNode) return { chunk: [...specs], stamps };
    const chunk: S[] = [];
    const next = new Map<string, number>();
    for (const spec of specs) {
        if (spec.ifAbsent) { chunk.push(spec); continue; }
        const id = spec.raw.id as string;
        try {
            const predicted = next.get(id) ?? revisionOf(await getNode(id));
            // ifRevision: the write is conditional on EXACTLY n (never the read value). A predicted
            // mismatch leaves the prediction alone: the item will fail at its turn and write nothing.
            const expected = spec.ifRevision ?? predicted;
            stamps.set(spec.idx, { expected, updatedAt: new Date().toISOString() });
            if (spec.ifRevision === undefined || spec.ifRevision === predicted) next.set(id, expected + 1);
            chunk.push(spec);
        } catch (err) {
            fail(spec, `could not read the node before writing: ${(err as Error).message}; nothing was written`);
        }
    }
    return { chunk, stamps };
}

/**
 * Conditional write with a bounded in-place retry. A conflict means the node
 * is not at `expected`: another daemon moved it past (revisions only go up), or
 * an earlier same-id item of the chunk wrote nothing, so the stamp chained too
 * high (the node is BELOW `expected`). The retry therefore lands wherever the
 * node actually is, which can be above OR below what the item's outbox row
 * predicted. A row below the landed revision is safe (replay skips it); a row
 * above it is not (replay would raise the stored revision with no accepted
 * mutation), so the caller reconciles the row with the landed revision
 * ({@link reconcileOutboxRevision}).
 */
export async function writeAtRevisionRetrying(
    graph: { getNode?(id: string): Promise<LoreNode | null> },
    id: string,
    stamp: RevisionStamp,
    write: (expected: number) => Promise<LoreNode>,
): Promise<LoreNode> {
    let expected = stamp.expected;
    for (let attempt = 1; ; attempt++) {
        try { return await write(expected); }
        catch (err) {
            if (!isRevisionConflict(err) || attempt >= MAX_REVISION_ATTEMPTS || typeof graph.getNode !== 'function') throw err;
            expected = revisionOf(await graph.getNode(id));
        }
    }
}

/**
 * Write a stamped item. `ifRevision` items make ONE conditional attempt on
 * exactly n, update-only (an absent row is a conflict, never created). A
 * conflict IS the answer (another daemon moved or deleted the node), so it
 * becomes an {@link ItemConditionError} carrying the revision found now (null
 * when absent). Other stamped items keep {@link writeAtRevisionRetrying}.
 */
export async function writeStamped(
    graph: { getNode?(id: string): Promise<LoreNode | null> },
    spec: ConditionalSpec,
    stamp: RevisionStamp,
    write: (expected: number) => Promise<LoreNode>,
): Promise<LoreNode> {
    const id = spec.raw.id as string;
    if (spec.ifRevision === undefined) return writeAtRevisionRetrying(graph, id, stamp, write);
    try { return await write(stamp.expected); }
    catch (err) {
        if (!isRevisionConflict(err)) throw err;
        let found: number | null = err.actual;
        if (typeof graph.getNode === 'function') { try { const n = await graph.getNode(id); found = n ? revisionOf(n) : null; } catch { /* keep the conflict's value */ } }
        throw new ItemConditionError({ error: revisionMismatchMessage(id, spec.ifRevision, found), currentRevision: found });
    }
}

/**
 * Make a stamped item's outbox row say the revision its inline write actually
 * landed. The row was recorded BEFORE any write of the chunk with a predicted
 * `expected + 1`, and the prediction chains same-id items, so it is wrong
 * whenever an earlier item wrote nothing (precondition_failed, ifRevision
 * mismatch, a throw), or a cross-daemon conflict moved the retry. A row above
 * the landed revision would, on replay, raise the stored revision with no
 * accepted mutation, so the row is re-recorded (same payload and `updatedAt`,
 * `revision` = landed) whenever the two differ.
 *
 * Returns the entry that now stands (the new one, or the old one when nothing
 * changed). A row the replicator already claimed is left alone: it carries
 * this item's content, and the revision it raises on replay cannot be taken
 * back by a compensating row (that one would sort even higher). Never throws;
 * a failure to re-record puts the original payload back so the write is not lost.
 */
export async function reconcileOutboxRevision(input: {
    store: OutboxStore | undefined;
    entry: OutboxEntry | null | undefined;
    stamp: RevisionStamp | undefined;
    /** The revision the inline write landed (the node returned by the conditional write). */
    landed: number | undefined;
    workspace: string;
    id: string;
}): Promise<OutboxEntry | null | undefined> {
    const { store, entry, stamp, landed, workspace, id } = input;
    if (!store || !entry || !stamp || landed === undefined) return entry;
    const recorded = entryRevision(entry);
    if (recorded === undefined || recorded === landed) return entry;
    const payload = entry.payload as Record<string, unknown>;
    const record = (p: Record<string, unknown>): Promise<OutboxEntry> =>
        recordHotWrite(store, { workspace, operationKind: 'node.upsert', payload: p, initiator: entry.initiator, operation: 'graph.upsert' });
    try {
        if (store.removeIfPending ? !(await store.removeIfPending(entry.id)) : (await store.remove(entry.id), false)) return entry;
    } catch (err) {
        console.error(`[Lore HTTP] bulk upsert: could not take back the outbox row of ${id} to correct its revision (${recorded} -> ${landed}): ${redactError(err)}`);
        return entry;
    }
    try { return await record({ ...payload, revision: landed }); }
    catch (err) {
        console.error(`[Lore HTTP] bulk upsert: could not re-record the outbox row of ${id} at revision ${landed}: ${redactError(err)} — restoring the original row`);
        try { return await record(payload); }
        catch (err2) { console.error(`[Lore HTTP] bulk upsert: outbox row of ${id} is lost, replay will not carry this write: ${redactError(err2)}`); return null; }
    }
}

/** Run an item's conditions (under the locks, right before its write); the failure payload or null. */
export async function checkSpecConditions(graph: { getNode?(id: string): Promise<LoreNode | null> }, spec: ConditionalSpec): Promise<ConditionFailure | null> {
    if (!hasConditions(spec)) return null;
    try { return await checkItemConditions(graph, spec.raw.id as string, spec); }
    catch (err) { return { error: `could not read the node before writing: ${(err as Error).message}; nothing was written` }; }
}

/**
 * Judge the conditions of a chunk's conditional items, under the chunk locks and
 * BEFORE any outbox row is recorded. A failing item is reported through `fail`
 * and left out of the returned chunk, so it never gets a row (nothing to retract,
 * nothing a replicator could claim). Items without conditions pass untouched.
 * {@link chunkSpecsForLocking} gives a conditional item a chunk of its own, so
 * every earlier item of the request has already landed when this runs.
 */
export async function checkChunkConditions<S extends ConditionalSpec>(
    graph: { getNode?(id: string): Promise<LoreNode | null> },
    specs: readonly S[],
    fail: (spec: S, failure: ConditionFailure) => void,
): Promise<S[]> {
    const keep: S[] = [];
    for (const spec of specs) {
        const refused = await checkSpecConditions(graph, spec);
        if (refused) fail(spec, refused); else keep.push(spec);
    }
    return keep;
}

/** The revision stored now, for a result reported after write-time `supersedes` bumped the node again. */
export async function freshRevision(graph: { getNode?(id: string): Promise<LoreNode | null> }, id: string): Promise<number | undefined> {
    if (typeof graph.getNode !== 'function') return undefined;
    try { const n = await graph.getNode(id); return n && n.revision !== undefined ? n.revision : undefined; }
    catch { return undefined; }
}

/**
 * Decide, under the locks, which items of a chunk may be written.
 *
 *   - a pure retry (it has `supersedes`, every target is already superseded by
 *     this item's id, and the node at this id exists) is `unchanged`: nothing is
 *     written, not even the item's fields;
 *   - a target superseded by a DIFFERENT id fails the item `already_superseded`;
 *   - `ifAbsent` on an id that holds any node fails the item `already_exists`;
 *   - a node that cannot be read fails the item (its write could not be judged).
 *
 * Returns the items to write, in order.
 */
export async function guardBulkChunk<S extends ConditionalSpec>(
    graph: { getNode?(id: string): Promise<LoreNode | null> },
    specs: readonly S[],
    outcome: { fail(spec: NoInfer<S>, error: string, extra?: Record<string, unknown>): void; unchanged(spec: NoInfer<S>, revision?: number): void },
): Promise<S[]> {
    const keep: S[] = [];
    const getNode = typeof graph.getNode === 'function' ? graph.getNode.bind(graph) : undefined;
    for (const spec of specs) {
        const id = spec.raw.id as string;
        const hasSupersedes = !!spec.supersedes && spec.supersedes.length > 0;
        if (hasConditions(spec) && (!getNode || !hasRevisionSupport(graph))) { outcome.fail(spec, REVISION_UNSUPPORTED); continue; }
        if ((!spec.ifAbsent && !hasSupersedes) || !getNode) { keep.push(spec); continue; }
        try {
            const existing = await getNode(id);
            let retried = hasSupersedes;
            let refusal: string | undefined;
            for (const oldId of spec.supersedes ?? []) {
                const old = await getNode(oldId);
                const by = old?.supersededBy ?? '';
                if (by && by !== id) { refusal = `already_superseded: ${alreadySupersededMessage(oldId, by)}`; break; }
                if (by !== id) retried = false; // free (or missing, which the apply step reports)
            }
            if (refusal) { outcome.fail(spec, refusal); continue; }
            if (retried && existing) {
                if (spec.ifRevision === undefined) { outcome.unchanged(spec, existing.revision); continue; }
                // Phase 2b — a pure retry that carries ifRevision n. The original request left the node at
                // n + 1 (its write) + one bump per distinct claimed target, so that exact value is the only
                // proof "the original landed and nothing else changed". Stored == n means the item never
                // landed (fall through to a normal conditional write); anything else is ambiguous: mismatch.
                const stored = revisionOf(existing);
                if (stored === spec.ifRevision + 1 + new Set(spec.supersedes).size) { outcome.unchanged(spec, stored); continue; }
                if (stored !== spec.ifRevision) { outcome.fail(spec, revisionMismatchMessage(id, spec.ifRevision, stored), { currentRevision: stored }); continue; }
            }
            if (spec.ifAbsent && existing) {
                outcome.fail(spec, alreadyExistsError(new Error(`a node with id '${id}' already exists in this workspace`)));
                continue;
            }
        } catch (err) {
            outcome.fail(spec, `could not read the node before writing: ${(err as Error).message}; nothing was written`);
            continue;
        }
        keep.push(spec);
    }
    return keep;
}

/** Per-item result of {@link writeBulkChunk}; `revision` is the stored revision after the write. */
export type BulkWriteItem = { id: string; ok: boolean; error?: string; revision?: number; currentRevision?: number | null; failedPreconditions?: FailedPrecondition[] };

/**
 * Write a chunk through `bulkUpsertNodes`, keeping the order. A chunk with no
 * `ifAbsent` item (and no revision stamps) is ONE `bulkUpsertNodes` call, as
 * before. Otherwise the `ifAbsent` items are created one at a time
 * (insert-only) between the runs of plain items, so two items of the same batch
 * naming one id still see each other. Stamped items (phase 2a) are written one
 * at a time with {@link writeAtRevisionRetrying}, reusing the `updatedAt`
 * recorded in their outbox row and reporting the stored revision.
 */
export async function writeBulkChunk(
    graph: ConditionalInsertGraph & RevisionedGraph & { bulkUpsertNodes(batch: NodeInput[]): Promise<Array<{ id: string; ok: boolean; error?: string }>> },
    chunk: readonly ConditionalSpec[],
    stamps?: ReadonlyMap<number, RevisionStamp>,
): Promise<BulkWriteItem[]> {
    if (!chunk.some((s) => s.ifAbsent) && !(stamps && stamps.size > 0)) return graph.bulkUpsertNodes(chunk.map((s) => s.raw as unknown as NodeInput));
    const out: BulkWriteItem[] = [];
    let run: ConditionalSpec[] = [];
    const flush = async (): Promise<void> => {
        if (run.length === 0) return;
        out.push(...await graph.bulkUpsertNodes(run.map((s) => s.raw as unknown as NodeInput)));
        run = [];
    };
    for (const spec of chunk) {
        const stamp = stamps?.get(spec.idx);
        if (!spec.ifAbsent && !stamp && !hasConditions(spec)) { run.push(spec); continue; }
        await flush();
        const id = spec.raw.id as string;
        // Phase 2b — the conditions are judged NOW, at the item's turn, so an earlier item of this chunk is visible.
        const refused = await checkSpecConditions(graph as { getNode?(id: string): Promise<LoreNode | null> }, spec);
        if (refused) { out.push({ id, ok: false, ...refused }); continue; }
        try {
            const node = stamp && hasRevisionSupport(graph)
                ? await writeStamped(graph as { getNode?(id: string): Promise<LoreNode | null> }, spec, stamp, (expected) => graph.upsertNodeAtRevision(spec.raw as unknown as NodeInput, expected, stamp.updatedAt, spec.ifRevision !== undefined))
                : await createNodeIfAbsent(graph, spec.raw as unknown as NodeInput);
            out.push({ id, ok: true, ...(node.revision !== undefined ? { revision: node.revision } : {}) });
        } catch (err) {
            if (err instanceof ItemConditionError) out.push({ id, ok: false, ...err.payload });
            else out.push({ id, ok: false, error: isNodeAlreadyExists(err) ? alreadyExistsError(err) : (err as Error).message });
        }
    }
    await flush();
    return out;
}

/**
 * The item's supersede claim was lost to another writer AFTER its own node was
 * written (a different process won the conditional UPDATE). Put the graph back
 * (a node the item created is deleted, an existing one restored) and take the
 * item's outbox row back, so nothing of the refused item survives.
 */
export async function undoLostClaim(input: {
    graph: Parameters<typeof undoBulkGraphWrite>[0];
    id: string;
    prior: LoreNode | null | undefined;
    raw: Record<string, unknown>;
    outboxStore?: OutboxStore;
    entry?: OutboxEntry | null;
    workspace: string;
}): Promise<void> {
    const { graph, id, prior, raw, outboxStore, entry, workspace } = input;
    try { await undoBulkGraphWrite(graph, id, prior, raw); }
    catch (err) { console.error(`[Lore HTTP] bulk already_superseded rollback failed for ${id}: ${redactError(err)}`); }
    if (outboxStore && entry) {
        try { await retractBulkNodeUpsert({ store: outboxStore, entryId: entry.id, workspace, graph, id, written: raw, claimedRevision: entryRevision(entry) }); }
        catch (err) { console.error(`[Lore HTTP] bulk already_superseded rollback: outbox retraction failed for ${id}: ${redactError(err)} — replicator may create a ghost node`); }
    }
}

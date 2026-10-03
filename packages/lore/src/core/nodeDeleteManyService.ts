/**
 * nodeDeleteManyService.ts — batched `deleteNodeEverywhere` (3.27.0).
 *
 * `LoreInstance.nodeDeleteMany` deletes many nodes with the SAME per-node
 * semantics as `nodeDelete` (core/nodeDeleteService.ts): per node, outbox
 * `node.delete` first, then the graph delete, then `verbatim.tombstone` (plus
 * existing-alias tombstones) or `verbatim.purge`; WAL `delete_node` appended
 * for the active workspace; the embedded replay guard told about each inline
 * delete. What changes is the cost per node, which matters after a reindex
 * deletes hundreds of stale code nodes:
 *   - locking: ids run in chunks of BULK_LOCK_CHUNK_SIZE under `withNodeLocks`
 *     (sorted acquisition, deadlock-free against nodeUpsert/nodeDelete/bulk
 *     writers); one chunk is released before the next is taken;
 *   - outbox: one batched insert for the chunk's `node.delete` rows, one for
 *     its verbatim rows (per-node order preserved: delete row before verbatim
 *     rows);
 *   - alias existence: one batched lookup per chunk (existingAliasRowIdsMany);
 *   - purge: ONE store call per chunk (LanceDB: a few filtered queries, SQLite:
 *     one transaction) instead of one per node.
 *
 * ONE `verbatim.purge` outbox row PER NODE, not one per chunk. A chunk-wide
 * row (`id` = first node, `ids` = every verbatim id) is NOT safe: the
 * supersession key of a row is `payload.id` only (outbox/supersession.ts
 * keyOfEntry), so a later replicated upsert/tombstone for the chunk's FIRST
 * node would mark the whole failed row superseded and silently drop the other
 * nodes' purges, while a newer save of any other node in the row would not
 * supersede it at all, and a retry could then purge content re-created after
 * the delete. Per-node rows keep keyOfEntry / supersessionFamilySql / the
 * dispatcher verify case exactly as proven for `nodeDelete`. The batched insert
 * keeps the cost low (one transaction for the chunk).
 *
 * One failing id never aborts the others: it is reported in its result.
 * Nothing inside the chunk lock re-enters it (nodeWriteLock.ts rule 1): every
 * call is a RAW substrate primitive.
 */
import { redactId, redactError } from '../security/logRedact.js';
import { recordHotWrite, recordHotWriteBatch, type HotWriteSpec } from '../outbox/hotLane.js';
import type { OutboxEntry } from '../outbox/types.js';
import { withNodeLocks, BULK_LOCK_CHUNK_SIZE, chunkForLocking } from './nodeWriteLock.js';
import { aliasRowId, MAX_QUESTIONS } from './questionAliases.js';
import { purgeVerbatimRows, type PurgeCapableStore } from './verbatimPurge.js';
import { existingAliasRowIdsMany, type NodeDeleteInput, type NodeDeleteOutcome } from './nodeDeleteService.js';

/** Per-id outcome of `nodeDeleteMany`. `error` is set when that id failed
 *  (the other ids are unaffected); `deleted` then reflects what happened. */
export interface NodeDeleteManyItem extends NodeDeleteOutcome {
    id: string;
    error?: string;
}

export interface NodeDeleteManyResult {
    /** One entry per distinct requested id, in request order. */
    results: NodeDeleteManyItem[];
}

export type NodeDeleteManyInput = Omit<NodeDeleteInput, 'id'> & { ids: string[] };

interface Work {
    id: string;
    item: NodeDeleteManyItem;
    entry: OutboxEntry | null;
    /** The graph node existed and was removed (verbatim steps apply). */
    deleted: boolean;
    /** The verbatim step ran far enough that the WAL append applies. */
    walAppend: boolean;
}

const slots = (id: string): string[] => Array.from({ length: MAX_QUESTIONS }, (_, i) => aliasRowId(id, i));

export async function deleteNodesEverywhere(input: NodeDeleteManyInput): Promise<NodeDeleteManyResult> {
    const byId = new Map<string, NodeDeleteManyItem>();
    for (const chunk of chunkForLocking(input.ids, BULK_LOCK_CHUNK_SIZE)) {
        try {
            await withNodeLocks(input.workspace, chunk, async () => {
                for (const item of await deleteChunk(input, chunk)) byId.set(item.id, item);
            });
        } catch (err) {
            // Lock acquisition itself failed: nothing in this chunk ran.
            for (const id of chunk) if (!byId.has(id)) byId.set(id, { id, deleted: false, error: redactError(err) });
        }
    }
    return { results: input.ids.map((id) => byId.get(id) ?? { id, deleted: false, error: 'not processed' }) };
}

/** One chunk, all under the chunk's node locks. Never throws per-id. */
async function deleteChunk(input: NodeDeleteManyInput, ids: string[]): Promise<NodeDeleteManyItem[]> {
    const { workspace, initiator, outboxStore } = input;
    const work: Work[] = ids.map((id) => ({ id, item: { id, deleted: false }, entry: null, deleted: false, walAppend: false }));
    const fail = (w: Work, err: unknown): void => { w.item.error = redactError(err); };

    // 1. node.delete rows first (SP-F3 outbox-first), one batched insert; a
    //    batch failure falls back to per-id so one bad row only fails its id.
    if (outboxStore) {
        const specs: HotWriteSpec[] = ids.map((id) => ({ workspace, operationKind: 'node.delete', payload: { id }, initiator, operation: 'node.delete' }));
        try {
            const entries = await recordHotWriteBatch(outboxStore, specs);
            work.forEach((w, i) => { w.entry = entries[i]!; });
        } catch {
            for (let i = 0; i < work.length; i++) {
                try { work[i]!.entry = await recordHotWrite(outboxStore, specs[i]!); } catch (err) { fail(work[i]!, err); }
            }
        }
    }

    // 2. graph deletes (raw), telling the replay guard about each inline delete.
    for (const w of work) {
        if (w.item.error) continue;
        try {
            w.deleted = await input.graph.deleteNode(w.id);
            if (w.entry) input.onInlineDeleteApplied?.(w.entry);
            w.item.deleted = w.deleted;
        } catch (err) { fail(w, err); }
    }
    const live = work.filter((w) => w.deleted);
    if (live.length === 0) return work.map((w) => w.item);

    // 3. the workspace's verbatim store; if it cannot be resolved every deleted
    //    node reports it (as nodeDelete throws), and the WAL append is skipped.
    let store: unknown;
    try { store = await input.resolveVerbatim(); } catch (err) { for (const w of live) fail(w, err); return work.map((w) => w.item); }

    // 4. which alias rows exist: one batched lookup (null = every slot, as before).
    const aliasMap = await existingAliasRowIdsMany(live.map((w) => w.id), workspace, store, outboxStore);
    for (const w of live) w.walAppend = true;

    if (input.purge) await purgeChunk(input, store, live, aliasMap);
    else await tombstoneChunk(input, store, live, aliasMap);

    // 5. ITEM X-walnode — WAL append for the active workspace, inside the lock.
    if (input.isActive) for (const w of live) if (w.walAppend) input.getWal().append('delete_node', { id: w.id, workspace });
    return work.map((w) => w.item);
}

async function purgeChunk(
    input: NodeDeleteManyInput, store: unknown, live: Work[], aliasMap: Map<string, string[] | null>,
): Promise<void> {
    const { workspace, initiator, outboxStore } = input;
    const idsOf = new Map<Work, string[]>(live.map((w) => [w, [`lore:${w.id}`, ...(aliasMap.get(w.id) ?? slots(w.id))]]));
    let todo = live;
    // Record BEFORE the physical delete (a crash in between leaves pending
    // purges that replay completes). One row per node; one batched insert.
    if (outboxStore) {
        const specs: HotWriteSpec[] = live.map((w) => ({
            workspace, operationKind: 'verbatim.purge', payload: { id: `lore:${w.id}`, ids: idsOf.get(w)! }, initiator, operation: 'verbatim.purge',
        }));
        try {
            await recordHotWriteBatch(outboxStore, specs);
        } catch {
            todo = [];
            for (let i = 0; i < live.length; i++) {
                try { await recordHotWrite(outboxStore, specs[i]!); todo.push(live[i]!); } catch (err) { warn(input, live[i]!, 'purge', err); }
            }
        }
    }
    if (todo.length === 0) return;
    const allIds = [...new Set(todo.flatMap((w) => idsOf.get(w)!))];
    const apply = async (ws: Work[], ids: string[]): Promise<void> => {
        const mode = await purgeVerbatimRows(store as PurgeCapableStore, ids, input.reason);
        if (mode === 'none') for (const vid of ids) await input.verbatimDelete(vid);
        for (const w of ws) {
            if (mode === 'tombstone') w.item.verbatimWarning = 'verbatim purge unsupported by this store; rows were tombstoned instead';
            else if (mode === 'none') w.item.verbatimWarning = 'verbatim purge unsupported by this store; rows went through the legacy delete instead';
            else w.item.purged = true;
        }
    };
    try {
        await apply(todo, allIds);
    } catch {
        // The chunk-wide call failed: retry node by node (idempotent) so a bad
        // id only fails itself.
        for (const w of todo) {
            try { await apply([w], idsOf.get(w)!); } catch (err) { warn(input, w, 'purge', err); }
        }
    }
}

async function tombstoneChunk(
    input: NodeDeleteManyInput, store: unknown, live: Work[], aliasMap: Map<string, string[] | null>,
): Promise<void> {
    const { workspace, initiator, outboxStore } = input;
    const tomb = store as { tombstone?: (id: string, reason: string) => Promise<void> };
    // Tombstones re-embed, so they stay one store call per node (sequential).
    const done: Work[] = [];
    for (const w of live) {
        try {
            if (typeof tomb.tombstone === 'function') await tomb.tombstone(`lore:${w.id}`, input.reason);
            else await input.verbatimDelete(`lore:${w.id}`);
            done.push(w);
        } catch (err) { warn(input, w, 'tombstone', err); }
    }
    if (!outboxStore || done.length === 0) return;
    // QA A2 finding 2 — a verbatim.tombstone row AFTER the node.delete row, so
    // a stale pending `verbatim.upsert` cannot resurrect the content. Alias
    // tombstones follow their node's row (3.21 step 3(e)); only existing ones
    // when known.
    const rowsOf = (w: Work): HotWriteSpec[] => [
        { workspace, operationKind: 'verbatim.tombstone', payload: { id: `lore:${w.id}`, reason: input.reason }, initiator, operation: 'verbatim.tombstone' },
        ...(aliasMap.get(w.id) ?? slots(w.id)).map((rowId): HotWriteSpec => ({
            workspace, operationKind: 'verbatim.tombstone', payload: { id: rowId, reason: 'node rewritten — aliases replaced' }, initiator, operation: 'verbatim.tombstone',
        })),
    ];
    try {
        await recordHotWriteBatch(outboxStore, done.flatMap(rowsOf));
    } catch {
        // Per node: the main row is load-bearing (warning on failure), alias
        // rows are best-effort exactly as tombstoneQuestionAliases.
        for (const w of done) {
            const [main, ...aliases] = rowsOf(w);
            try { await recordHotWrite(outboxStore, main!); } catch (err) { warn(input, w, 'tombstone', err); continue; }
            for (const a of aliases) {
                try { await recordHotWrite(outboxStore, a); } catch (err) {
                    console.error(`${input.logPrefix} question-alias tombstone record failed for ${redactId(String(a.payload['id']))} (non-fatal): ${redactError(err)}`);
                }
            }
        }
    }
}

function warn(input: NodeDeleteManyInput, w: Work, what: 'purge' | 'tombstone', err: unknown): void {
    w.item.verbatimWarning = `verbatim ${what} failed: ${redactError(err)}`;
    console.error(`${input.logPrefix} Verbatim ${what} failed for ${redactId(w.id)}: ${redactError(err)}`);
}

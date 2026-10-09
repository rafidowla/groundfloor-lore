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
import { retractBulkNodeUpsert, undoBulkGraphWrite } from './bulkWriteRollback.js';

/** The fields of a validated bulk item the conditional steps look at. */
export interface ConditionalSpec {
    idx: number;
    raw: { id?: unknown };
    ifAbsent?: boolean;
    supersedes?: string[];
}

/** Ids a chunk must lock: its own ids plus every `supersedes` target. */
export function bulkLockIds(specs: readonly ConditionalSpec[]): string[] {
    const ids = new Set<string>();
    for (const s of specs) {
        ids.add(s.raw.id as string);
        for (const old of s.supersedes ?? []) ids.add(old);
    }
    return [...ids];
}

/** The outbox payload of an item: the `ifAbsent` flag rides along so replay is insert-only. */
export function bulkOutboxPayload(spec: ConditionalSpec): Record<string, unknown> {
    const raw = spec.raw as Record<string, unknown>;
    return spec.ifAbsent ? { ...raw, ifAbsent: true } : raw;
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
    outcome: { fail(spec: NoInfer<S>, error: string): void; unchanged(spec: NoInfer<S>): void },
): Promise<S[]> {
    const keep: S[] = [];
    const getNode = typeof graph.getNode === 'function' ? graph.getNode.bind(graph) : undefined;
    for (const spec of specs) {
        const id = spec.raw.id as string;
        const hasSupersedes = !!spec.supersedes && spec.supersedes.length > 0;
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
            if (retried && existing) { outcome.unchanged(spec); continue; }
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

/**
 * Write a chunk through `bulkUpsertNodes`, keeping the order. A chunk with no
 * `ifAbsent` item is ONE `bulkUpsertNodes` call, as before. Otherwise the
 * `ifAbsent` items are created one at a time (insert-only) between the runs of
 * plain items, so two items of the same batch naming one id still see each
 * other.
 */
export async function writeBulkChunk(
    graph: ConditionalInsertGraph & { bulkUpsertNodes(batch: NodeInput[]): Promise<Array<{ id: string; ok: boolean; error?: string }>> },
    chunk: readonly ConditionalSpec[],
): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    if (!chunk.some((s) => s.ifAbsent)) return graph.bulkUpsertNodes(chunk.map((s) => s.raw as unknown as NodeInput));
    const out: Array<{ id: string; ok: boolean; error?: string }> = [];
    let run: ConditionalSpec[] = [];
    const flush = async (): Promise<void> => {
        if (run.length === 0) return;
        out.push(...await graph.bulkUpsertNodes(run.map((s) => s.raw as unknown as NodeInput)));
        run = [];
    };
    for (const spec of chunk) {
        if (!spec.ifAbsent) { run.push(spec); continue; }
        await flush();
        const id = spec.raw.id as string;
        try {
            await createNodeIfAbsent(graph, spec.raw as unknown as NodeInput);
            out.push({ id, ok: true });
        } catch (err) {
            out.push({ id, ok: false, error: isNodeAlreadyExists(err) ? alreadyExistsError(err) : (err as Error).message });
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
        try { await retractBulkNodeUpsert({ store: outboxStore, entryId: entry.id, workspace, graph, id, written: raw }); }
        catch (err) { console.error(`[Lore HTTP] bulk already_superseded rollback: outbox retraction failed for ${id}: ${redactError(err)} — replicator may create a ghost node`); }
    }
}

/**
 * bulkWriteRollback.ts — undo of one failed item of POST /api/nodes/bulk.
 *
 * Split from bulkWrite.ts (file-size cap). 3.26.0: a failed UPDATE no longer
 * deletes the node it was updating, the same rule the single-write path
 * applies in core/nodeServiceVerbatim.ts (`rollbackPartialWrite`):
 *
 *   - graph side: a node that existed before the item's write is put back as
 *     it was; only a node the item created is deleted;
 *   - outbox side: when the item's `node.upsert` row was already claimed by
 *     the replicator, the compensating row describes what the graph holds NOW:
 *     a `node.upsert` of the node when it is present, a `node.delete` when it
 *     is not. Before, it was always a `node.delete`, whose replay removed an
 *     existing node.
 *
 * Callers hold the item's node lock (the chunk's `withNodeLocks`).
 */
import type { LoreNode } from '../../../providers/types.js';
import type { OutboxStore } from '../../../outbox/types.js';
import { restoreNodeInline } from '../../../core/nodeServiceVerbatim.js';
import { retractNodeUpsertRow } from '../../../core/nodeServiceConditional.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';

const INITIATOR = 'http:POST /api/nodes/bulk';

/** `getNode` is optional: a minimal graph without it keeps the pre-3.26 undo (delete). */
interface ReadGraph { getNode?(id: string): Promise<LoreNode | null> }
interface WriteGraph { upsertNode(node: never): Promise<unknown>; deleteNode(id: string): Promise<unknown> }
interface InlineSpec { idx: number; raw: { id?: unknown }; embedMode: string; /** A non-empty list needs the prior too: a lost supersede claim restores it. */ supersedes?: string[] }

/**
 * The nodes as they are before a chunk's write, for the items whose write can
 * be undone after it landed (`embed: 'inline'`: the verbatim seed runs after
 * the graph write). Call it under the chunk's locks, before the outbox commit.
 * An item whose node cannot be read is failed here and left out of the chunk:
 * nothing is written for it, since its write could not be undone. A graph
 * without `getNode` yields no priors.
 */
export async function readInlinePriors<S extends InlineSpec>(
    graph: ReadGraph,
    specs: readonly S[],
    fail: (spec: S, error: string) => void,
): Promise<{ chunk: S[]; priors: Map<string, LoreNode | null> }> {
    const priors = new Map<string, LoreNode | null>();
    const chunk: S[] = [];
    for (const spec of specs) {
        const id = spec.raw.id as string;
        if ((spec.embedMode === 'inline' || !!spec.supersedes?.length) && !priors.has(id) && typeof graph.getNode === 'function') {
            try {
                priors.set(id, await graph.getNode(id));
            } catch (err) {
                fail(spec, `could not read the node before writing: ${(err as Error).message}; nothing was written`);
                continue;
            }
        }
        chunk.push(spec);
    }
    return { chunk, priors };
}

/** Undo an item's graph write that landed: restore `prior`, or delete the
 *  node when the item created it. A node removed meanwhile by a delete that
 *  takes no node lock is not brought back. `written` is the item's payload. */
export async function undoBulkGraphWrite(
    graph: WriteGraph & ReadGraph, id: string, prior: LoreNode | null | undefined, written: Record<string, unknown>,
): Promise<void> {
    if (!prior) { await withTransactionConflictRetry(() => graph.deleteNode(id)); return; }
    if (typeof graph.getNode === 'function' && await graph.getNode(id) === null) return;
    await restoreNodeInline(graph as never, prior, written);
}

/**
 * Retract the `node.upsert` outbox row of a failed item. Still pending: it is
 * removed. Already claimed: a compensating row is recorded so its replay ends
 * on what the graph holds now (see the module comment). Throws when the row
 * could be neither removed nor compensated; callers log and carry on.
 */
export async function retractBulkNodeUpsert(input: {
    store: OutboxStore;
    entryId: string;
    workspace: string;
    graph: ReadGraph;
    id: string;
    written: Record<string, unknown>;
    /** The revision the item's claimed outbox row carries (see retractNodeUpsertRow). */
    claimedRevision?: number;
}): Promise<void> {
    await retractNodeUpsertRow({ ...input, initiator: INITIATOR });
}

/** The `revision` an item's outbox entry was recorded with (absent for an unstamped/insert-only row). */
export function entryRevision(entry: { payload?: unknown } | null | undefined): number | undefined {
    const r = (entry?.payload as { revision?: unknown } | undefined)?.revision;
    return typeof r === 'number' ? r : undefined;
}

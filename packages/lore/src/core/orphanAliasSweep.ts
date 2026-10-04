/**
 * orphanAliasSweep.ts — purge question-alias verbatim rows whose parent graph
 * node is gone (3.27.1).
 *
 * Why: on 3.27.0 with LORE_SEARCH_WORKER=1 the search-worker proxy returned
 * [] from `getExistingIds` (and a dead-half 0 from `purgeWithHistory`), so
 * `nodeDelete`/`nodeDeleteMany` — tombstone and purge modes alike — deleted
 * the graph node but never tombstoned or purged its `lore:<id>#q<i>` alias
 * rows (core/questionAliases.ts). Nothing queued them either, so they stay in
 * the verbatim store forever. Recall drops them (an alias hit maps to its
 * parent id, which no longer hydrates) but they still cost disk, index space
 * and BM25/vector candidates. This is the idempotent cleanup.
 *
 * Engine-neutral: only `listIds('lore:')`, `getById` and the purge ladder
 * (core/verbatimPurge.ts) are used, so it runs on LanceDB and SQLite stores and
 * through the search-worker proxy (all three are in FORWARDED_METHODS). Graph
 * existence is one batched `getNodesByIds` per chunk, never per id.
 *
 * Safety, in order of importance:
 *   1. An alias is purged only when its parent is ABSENT from the graph. If the
 *      graph read throws, nothing in that pass is purged (absence is never
 *      inferred from a failure).
 *   2. `lore:foo#q3` is ambiguous: an alias of node `foo`, or the canonical row
 *      of a node literally named `foo#q3`. A row whose own node id exists in the
 *      graph is canonical and is never touched.
 *   3. Lock + ordering. nodeUpsert takes the per-(workspace,id) write lock
 *      (core/nodeWriteLock.ts) and, inside it, records the outbox row, writes
 *      the GRAPH node, and only then fans out the verbatim/alias rows
 *      (core/nodeService.ts steps 1-3; nodeServiceVerbatim.ts). So under that
 *      lock an alias row cannot exist ahead of its parent graph node; the sweep
 *      therefore re-reads graph existence INSIDE `withNodeLocks` for each chunk
 *      of parents and acts on that authoritative answer, not the pre-lock scan.
 *      Replay can still land rows later (a queued `node.upsert` /
 *      `verbatim.upsert` the replicator has not applied), so parents with a
 *      queued save, or aliases with a queued upsert, are skipped
 *      (`skippedPending`) and picked up by a later pass once the queue drains.
 *   4. Aliases already tombstoned (`[TOMBSTONED` text, i.e. deleted correctly
 *      in tombstone mode) are inert and kept by design (verbatim is append-only
 *      memory); they are skipped unless `includeTombstoned` is set.
 *
 * Nothing inside the lock re-enters it (nodeWriteLock.ts rule 1): every call is
 * a raw substrate primitive.
 */

import type { OutboxStore } from '../outbox/types.js';
import { withNodeLocks, BULK_LOCK_CHUNK_SIZE, chunkForLocking } from './nodeWriteLock.js';
import { parseAliasRowId } from './questionAliases.js';
import { purgeVerbatimRows, type PurgeCapableStore, type PurgeMode } from './verbatimPurge.js';
import { isRevisionHistoryId } from '../engines/verbatimHistory.js';
import { redactError } from '../security/logRedact.js';

/** Default cap on orphan alias rows handled per pass. */
export const ORPHAN_ALIAS_SWEEP_MAX_ORPHANS = 10_000;
/** Parents checked per batched graph read. */
const GRAPH_CHECK_CHUNK = 100;
const LANCE_ID_PREFIX = 'lore:';

export interface OrphanAliasSweepInput {
    /** The RESOLVED workspace name (lock key, outbox queries). */
    workspace: string;
    /** The workspace's own graph; only `getNodesByIds` is used. */
    graph: { getNodesByIds(ids: string[]): Promise<Map<string, unknown>> };
    /** The workspace's verbatim store (LanceDB, SQLite, or the worker proxy). */
    verbatim: unknown;
    /** Optional: when wired, queued saves of a parent / alias skip it. */
    outboxStore?: OutboxStore;
    /** Count only; no purge, no write. */
    dryRun?: boolean;
    /** Cap on orphan alias rows handled this pass (default 10_000). */
    maxOrphans?: number;
    /** Also purge aliases already tombstoned (default false). */
    includeTombstoned?: boolean;
    /** Reason handed to the tombstone last-resort rung. */
    reason?: string;
}

export interface OrphanAliasSweepResult {
    dryRun: boolean;
    /** Alias rows examined (ids matching the alias shape; `#rev` rows excluded). */
    scanned: number;
    /** Alias rows whose parent is confirmed absent under the lock, including the skipped ones. */
    orphans: number;
    /** Alias rows physically removed (0 on a dry run). */
    purged: number;
    /** Orphans left alone because the parent or the alias has a queued outbox save. */
    skippedPending: number;
    /** Orphans left alone because the alias is already tombstoned. */
    skippedTombstoned: number;
    /** More than `maxOrphans` orphans exist; run again. */
    truncated: boolean;
    /** Which rung of the purge ladder ran (last chunk), when any purge ran. */
    mode?: PurgeMode;
    /** Per-chunk failures; the sweep continues past them. */
    errors: string[];
}

type SweepStore = PurgeCapableStore & {
    listIds?: (prefix?: string) => Promise<string[]>;
    getById?: (id: string) => Promise<{ text?: string } | null>;
};

/** Of `rowIds`, which are queued, and for which parents a node save is queued. */
async function queuedFor(
    outbox: OutboxStore | undefined, workspace: string, parents: string[], rowIds: string[],
): Promise<{ parents: Set<string>; rows: Set<string> }> {
    const out = { parents: new Set<string>(), rows: new Set<string>() };
    if (!outbox) return out;
    if (typeof outbox.queuedVerbatimUpsertIds === 'function' && typeof outbox.newestNodeUpsertAfter === 'function') {
        for (const r of await outbox.queuedVerbatimUpsertIds(workspace, rowIds)) out.rows.add(r);
        for (const p of parents) if (await outbox.newestNodeUpsertAfter(workspace, p, 0)) out.parents.add(p);
        return out;
    }
    // A store without the targeted lookups: scan the unfinished rows instead.
    const rowSet = new Set(rowIds);
    const parentSet = new Set(parents);
    for (const e of await outbox.listUnfinished()) {
        if (e.workspace !== undefined && e.workspace !== workspace) continue;
        const id = (e.payload as { id?: unknown } | undefined)?.id;
        if (typeof id !== 'string') continue;
        if (e.operationKind === 'node.upsert' && parentSet.has(id)) out.parents.add(id);
        if (e.operationKind === 'verbatim.upsert' && rowSet.has(id)) out.rows.add(id);
    }
    return out;
}

export async function sweepOrphanAliases(input: OrphanAliasSweepInput): Promise<OrphanAliasSweepResult> {
    const { workspace, graph, outboxStore } = input;
    const dryRun = input.dryRun === true;
    const maxOrphans = Math.max(1, input.maxOrphans ?? ORPHAN_ALIAS_SWEEP_MAX_ORPHANS);
    const store = input.verbatim as SweepStore;
    const result: OrphanAliasSweepResult = {
        dryRun, scanned: 0, orphans: 0, purged: 0, skippedPending: 0, skippedTombstoned: 0, truncated: false, errors: [],
    };
    if (typeof store.listIds !== 'function') return result;

    // 1. Enumerate alias rows (ids only), grouped by parent node id.
    let allIds: string[];
    try {
        allIds = await store.listIds(LANCE_ID_PREFIX);
    } catch (err) {
        result.errors.push(`listIds failed: ${redactError(err)}`);
        return result;
    }
    const byParent = new Map<string, Array<{ rowId: string; ownNodeId: string }>>();
    for (const rowId of allIds) {
        if (!rowId.startsWith(LANCE_ID_PREFIX) || isRevisionHistoryId(rowId)) continue;
        const ownNodeId = rowId.slice(LANCE_ID_PREFIX.length);
        const parsed = parseAliasRowId(ownNodeId);
        if (!parsed) continue;
        result.scanned += 1;
        const list = byParent.get(parsed.parentId);
        if (list) list.push({ rowId, ownNodeId }); else byParent.set(parsed.parentId, [{ rowId, ownNodeId }]);
    }
    if (byParent.size === 0) return result;

    // 2. Batched graph existence (outside the lock): collect candidate parents.
    //    A parent is a candidate when it is absent AND no alias row's own node
    //    id is a live node (the `foo#q3` ambiguity).
    const candidates: string[] = [];
    const parents = [...byParent.keys()];
    /** parent -> its alias rows that are true orphans: parent absent AND the
     *  row's own node id absent too (else it is a canonical `foo#q3` node). */
    const orphansOf = async (parentIds: string[]): Promise<Map<string, Array<{ rowId: string; ownNodeId: string }>>> => {
        const probe = new Set<string>();
        for (const p of parentIds) { probe.add(p); for (const a of byParent.get(p)!) probe.add(a.ownNodeId); }
        const found = await graph.getNodesByIds([...probe]);
        const out = new Map<string, Array<{ rowId: string; ownNodeId: string }>>();
        for (const p of parentIds) {
            if (found.has(p)) continue;
            const rows = byParent.get(p)!.filter((a) => !found.has(a.ownNodeId));
            if (rows.length > 0) out.set(p, rows);
        }
        return out;
    };
    for (let i = 0; i < parents.length; i += GRAPH_CHECK_CHUNK) {
        const chunk = parents.slice(i, i + GRAPH_CHECK_CHUNK);
        try {
            for (const p of (await orphansOf(chunk)).keys()) candidates.push(p);
        } catch (err) {
            // Absence is never inferred from a failed read.
            result.errors.push(`graph read failed: ${redactError(err)}`);
            return result;
        }
    }
    if (candidates.length === 0) return result;

    // 3. Per chunk of candidate parents: lock, re-check, skip queued, purge.
    let budget = maxOrphans;
    for (const chunk of chunkForLocking(candidates, BULK_LOCK_CHUNK_SIZE)) {
        if (budget <= 0) { result.truncated = true; break; }
        try {
            await withNodeLocks(workspace, chunk, async () => {
                const orphans = await orphansOf(chunk); // authoritative, under the lock
                const live = chunk.filter((p) => orphans.has(p));
                if (live.length === 0) return;
                const rowIds = live.flatMap((p) => orphans.get(p)!.map((a) => a.rowId));
                const queued = await queuedFor(outboxStore, workspace, live, rowIds);
                const toPurge: string[] = [];
                for (const p of live) {
                    for (const { rowId } of orphans.get(p)!) {
                        if (budget <= 0) { result.truncated = true; break; }
                        budget -= 1;
                        result.orphans += 1;
                        if (queued.parents.has(p) || queued.rows.has(rowId)) { result.skippedPending += 1; continue; }
                        if (!input.includeTombstoned && typeof store.getById === 'function') {
                            const row = await store.getById(rowId);
                            if (typeof row?.text === 'string' && row.text.startsWith('[TOMBSTONED')) { result.skippedTombstoned += 1; continue; }
                        }
                        toPurge.push(rowId);
                    }
                }
                if (toPurge.length === 0 || dryRun) return;
                result.mode = await purgeVerbatimRows(store, toPurge, input.reason ?? 'orphaned question alias (parent node deleted)');
                result.purged += toPurge.length;
            });
        } catch (err) {
            result.errors.push(`chunk failed: ${redactError(err)}`);
        }
    }
    return result;
}

/**
 * dataplaneWorkspacePurgeApply.ts — the DELETING half of `lore maintain cloud-purge` (the scan half is
 * `dataplaneWorkspacePurge.ts`; this module reuses its walk, classification, end states and filter assertion).
 *
 * Purpose:
 *   Hard-delete the rows of a deleted Lore workspace from the shared Dataplane collections, with a per-row
 *   proof: a row is only ever deleted if a read-only walk saw it as `keyed` (org + workspace match and `id`
 *   equals the D2 row key of its `lore_id`). Unkeyed rows are never deleted (reported only); a collection that
 *   cannot be fully enumerated ends `unverifiable`, never with a broad server-matched delete.
 *
 * Per collection, passes repeat: walk (read-only) -> guard() -> delete the keyed rows -> walk again, until a
 * walk collects zero keyed rows. That final walk + the count cross-check (`crossCheck`) decide the end state.
 *   - Fresh keyed rows go out in chunks of <= 100: `deleteByQuery(and[org eq, ws eq, lore_id in chunk,
 *     or[id_eq chunk-key…]])`. The `id_eq` list makes an unkeyed row that happens to share a `lore_id` undeletable.
 *   - The engine's returned `deleted` count is recorded but NEVER trusted (the engine swallows per-row failures).
 *   - A key seen again in a later walk is a survivor: deleted singly with `and[{id_eq: rowKey}, org eq, ws eq]`
 *     (the one filter SQLite pushes down at any table size). A key seen a THIRD time aborts (`aborted-no-progress`:
 *     deletes report success but do not take effect).
 *   - `lore_verbatim` is purged by the same raw scoped deletes; the verbatim store's own `delete()` writes
 *     tombstones and is never used. `/v1/transaction` is never used.
 *
 * Hooks (all injected so the CLI owns policy):
 *   - `guard()` runs before EVERY delete pass; a throw aborts the whole run (`aborted-guard`), nothing further is
 *     sent. The CLI makes it re-read the registry and throw if the target id is live again.
 *   - `probeCheck(probe)` runs once, on the first `lore_node` walk, before any `lore_node` delete, so a write that
 *     lands after the caller's pre-apply probe is still caught. A throw aborts (`aborted-probe`); `lore_node` is
 *     purged last, so earlier collections may already be gone (exit 2: partial deletion).
 *   - `onProgress(ev)` is advisory; an exception thrown by it is swallowed so reporting can never break the run.
 *
 * Exit codes (`exitCode`): 0 every collection complete / complete-small; 2 runtime failure, guard/probe abort or
 * no-progress abort (partial deletion possible); 3 safe but not provably complete (unverifiable collection,
 * scan cap, max-rows). A client error thrown mid-run is caught and becomes exit 2 with the counts so far.
 * Idempotent: a rerun after completion finds zero keyed rows, sends zero deletes, exits 0.
 */

import {
    engineField,
    engineIdEq,
    type DataplaneScope,
    type EngineFilter,
} from './dataplaneScopeFilter.js';
import type { ScopedBulkClient } from './dataplaneScopedIo.js';
import {
    assertPurgeScopeFilter,
    crossCheck,
    purgeScope,
    scanEndState,
    walkPurgeCollection,
    type CountCheck,
    type PurgeEndState,
    type PurgeScanClient,
    type PurgeTarget,
    type WalkLimits,
    type WriteProbe,
} from './dataplaneWorkspacePurge.js';

export const APPLY_DELETE_CHUNK = 100;

/** The scan client plus `deleteByQuery` (same calling convention as `physicalDeleteRows`: tenant, collection, filter, connection). */
export type PurgeApplyClient = PurgeScanClient & Pick<ScopedBulkClient, 'deleteByQuery'>;

export type PurgeApplyEndState = PurgeEndState | 'incomplete' | 'not-reached';
export type PurgeApplyOutcome =
    | 'complete' | 'unverifiable' | 'max-rows'
    | 'aborted-guard' | 'aborted-probe' | 'aborted-no-progress' | 'failed';
export type PurgeExitCode = 0 | 2 | 3;

export interface PurgeApplyCollectionResult {
    collection: string;
    /** Distinct keyed row keys seen across all passes. */
    keyedSeen: number;
    /** Delete attempts made (bulk rows + single survivor deletes); what the engine really did is only known by the final walk. */
    deleted: number;
    /** Sum of the engine's reported `deleted` counts (untrusted). */
    reportedDeleted: number;
    survivorsRetried: number;
    unkeyed: number;
    unkeyedSamples: string[];
    foreignSeen: number;
    /** Walks performed (the last one is the zero-keyed verification walk when the collection finished). */
    passes: number;
    /** complete | complete-small | unverifiable from the final walk; `incomplete` = the run stopped inside this collection; `not-reached`. */
    endState: PurgeApplyEndState;
    countCheck: CountCheck | null;
}

export interface PurgeApplyResult {
    target: PurgeTarget;
    connection: string;
    collections: PurgeApplyCollectionResult[];
    outcome: PurgeApplyOutcome;
    exitCode: PurgeExitCode;
    /** Human-readable reason for any non-`complete` outcome (error text, guard message, offending keys). */
    message: string | null;
    /** The collection the run stopped in (abort / failure / max-rows), else null. */
    stoppedIn: string | null;
    totals: { deleted: number; reportedDeleted: number; survivorsRetried: number; unkeyed: number };
    /** Delete requests sent (bulk chunks + single survivor deletes). */
    deleteRequests: number;
}

export type PurgeProgressEvent =
    | { phase: 'walk'; collection: string; pass: number; keyed: number; unkeyed: number; foreign: number }
    | { phase: 'delete'; collection: string; pass: number; attempted: number; survivors: number }
    | { phase: 'collection-done'; collection: string; endState: PurgeApplyEndState };

export interface ApplyPurgeInput {
    client: PurgeApplyClient;
    target: PurgeTarget;
    connection: string;
    collections: readonly string[];
    /** Called before every delete pass; throw to abort the run. Sync or async. */
    guard: () => void | Promise<void>;
    /** Called once on the first `lore_node` walk (before any `lore_node` delete); throw to abort the run. */
    probeCheck?: (probe: WriteProbe) => void | Promise<void>;
    /** Stop cleanly once this many delete attempts have been made (outcome `max-rows`, exit 3). */
    maxRows?: number;
    limits?: Partial<WalkLimits>;
    onProgress?: (ev: PurgeProgressEvent) => void;
}

/** Thrown internally to unwind to the run boundary with a distinct outcome. */
class PurgeStop extends Error {
    constructor(readonly outcome: PurgeApplyOutcome, message: string) { super(message); }
}

const errText = (e: unknown): string => `${(e as Error)?.constructor?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`;

/**
 * Chunk filter: scope + `lore_id in` + `or[id_eq…]` (both the logical and the physical key must match).
 * The physical key MUST be an `id_eq`, never a field clause on `id`: delete-by-query re-checks every row with
 * the engine's in-memory matcher, which reads `record.fields`, and connectors keep the id out of the fields
 * (postgres.rs row_to_record, arangodb.rs document_to_record) — so `id in […]` matches nothing there.
 */
function chunkFilter(scope: DataplaneScope, rows: ReadonlyArray<{ rowKey: string; loreId: string }>): { and: EngineFilter[] } {
    const filter: EngineFilter = { and: [
        engineField('org_id', 'eq', scope.orgId),
        engineField('lore_workspace', 'eq', scope.loreWorkspace),
        engineField('lore_id', 'in', rows.map((r) => r.loreId)),
        { or: rows.map((r) => engineIdEq(r.rowKey)) },
    ] };
    assertPurgeScopeFilter(filter, scope);
    return filter;
}

/** Single-row filter: `id_eq` + scope. */
function singleFilter(scope: DataplaneScope, rowKey: string): { and: EngineFilter[] } {
    const filter: EngineFilter = { and: [
        engineIdEq(rowKey),
        engineField('org_id', 'eq', scope.orgId),
        engineField('lore_workspace', 'eq', scope.loreWorkspace),
    ] };
    assertPurgeScopeFilter(filter, scope);
    return filter;
}

const emptyResult = (collection: string, endState: PurgeApplyEndState): PurgeApplyCollectionResult => ({
    collection, keyedSeen: 0, deleted: 0, reportedDeleted: 0, survivorsRetried: 0, unkeyed: 0, unkeyedSamples: [],
    foreignSeen: 0, passes: 0, endState, countCheck: null,
});

/**
 * Purge `collections` (in the order given; use `purgeCollectionOrder`) for `target`. Never throws for runtime
 * failures: they come back as `outcome`/`exitCode`. Throws only on invalid input, before any request.
 */
export async function applyWorkspacePurge(input: ApplyPurgeInput): Promise<PurgeApplyResult> {
    const scope = purgeScope(input.target);
    if (!input.connection) throw new Error('cloud-purge: a connection is required');
    if (typeof input.guard !== 'function') throw new Error('cloud-purge: a guard is required');
    if (input.maxRows !== undefined && (!Number.isInteger(input.maxRows) || input.maxRows < 1)) throw new Error('cloud-purge: maxRows must be a positive integer');
    const { client, connection } = input;
    const results = input.collections.map((c) => emptyResult(c, 'not-reached'));
    let deleteRequests = 0;
    let attempted = 0;
    let probeChecked = false;
    let outcome: PurgeApplyOutcome = 'complete';
    let message: string | null = null;
    let stoppedIn: string | null = null;
    const emit = (ev: PurgeProgressEvent): void => { try { input.onProgress?.(ev); } catch { /* advisory only */ } };
    const budget = (): number => (input.maxRows === undefined ? Infinity : input.maxRows - attempted);

    async function purgeCollection(res: PurgeApplyCollectionResult): Promise<void> {
        const collection = res.collection;
        const times = new Map<string, number>(); // row key -> walks that saw it as keyed
        res.endState = 'incomplete';
        for (;;) {
            const w = await walkPurgeCollection(client, scope, collection, connection, {
                trackWrites: collection === 'lore_node', ...(input.limits ? { limits: input.limits } : {}),
            });
            res.passes++;
            res.unkeyed = w.unkeyed;
            res.unkeyedSamples = w.unkeyedSamples;
            res.foreignSeen = Math.max(res.foreignSeen, w.foreign);
            emit({ phase: 'walk', collection, pass: res.passes, keyed: w.keyed.length, unkeyed: w.unkeyed, foreign: w.foreign });
            if (collection === 'lore_node' && !probeChecked) {
                probeChecked = true;
                if (input.probeCheck && w.probe) {
                    try { await input.probeCheck(w.probe); }
                    catch (e) { throw new PurgeStop('aborted-probe', `recent-write probe refused: ${(e as Error)?.message ?? String(e)}`); }
                }
            }
            // Distinct keyed rows of THIS walk (a lying connector could repeat one inside a walk).
            const rows = [...new Map(w.keyed.map((k) => [k.rowKey, k])).values()];
            if (rows.length === 0) {
                let end = scanEndState(w);
                if (end === 'capped') end = 'unverifiable'; // cannot happen with zero keyed rows; never claim completeness
                let countCheck: CountCheck | null = null;
                if (end === 'complete' || end === 'complete-small') {
                    countCheck = await crossCheck(client, scope, w, connection);
                    if (countCheck.exceeds) end = 'unverifiable';
                }
                res.countCheck = countCheck;
                res.endState = end;
                return;
            }
            if (budget() <= 0) throw new PurgeStop('max-rows', `max-rows (${input.maxRows}) reached in ${collection}`);
            try { await input.guard(); }
            catch (e) { throw new PurgeStop('aborted-guard', `aborted: target is registered again (${(e as Error)?.message ?? String(e)})`); }

            const fresh: typeof rows = [];
            const survivors: typeof rows = [];
            for (const r of rows) {
                const n = (times.get(r.rowKey) ?? 0) + 1;
                times.set(r.rowKey, n);
                if (n === 1) fresh.push(r); else if (n === 2) survivors.push(r);
                else throw new PurgeStop('aborted-no-progress', `no progress in ${collection}: row ${r.rowKey} was seen ${n} times after delete requests (deletes report success but do not take effect)`);
            }
            res.keyedSeen = times.size;
            emit({ phase: 'delete', collection, pass: res.passes, attempted: fresh.length + survivors.length, survivors: survivors.length });

            for (let i = 0; i < fresh.length && budget() > 0; i += APPLY_DELETE_CHUNK) {
                const chunk = fresh.slice(i, i + Math.min(APPLY_DELETE_CHUNK, budget()));
                const r = await client.deleteByQuery(scope.dataplaneWorkspaceId, collection, chunkFilter(scope, chunk), connection);
                deleteRequests++; attempted += chunk.length; res.deleted += chunk.length;
                res.reportedDeleted += typeof r?.deleted === 'number' ? r.deleted : 0;
            }
            for (const s of survivors) {
                if (budget() <= 0) break;
                const r = await client.deleteByQuery(scope.dataplaneWorkspaceId, collection, singleFilter(scope, s.rowKey), connection);
                deleteRequests++; attempted++; res.deleted++; res.survivorsRetried++;
                res.reportedDeleted += typeof r?.deleted === 'number' ? r.deleted : 0;
            }
        }
    }

    for (const res of results) {
        try {
            await purgeCollection(res);
            emit({ phase: 'collection-done', collection: res.collection, endState: res.endState });
            if (res.endState === 'unverifiable' && outcome === 'complete') outcome = 'unverifiable';
        } catch (e) {
            stoppedIn = res.collection;
            if (e instanceof PurgeStop) { outcome = e.outcome; message = e.message; }
            else { outcome = 'failed'; message = errText(e); }
            break;
        }
    }

    const exitCode: PurgeExitCode = outcome === 'complete' ? 0 : outcome === 'unverifiable' || outcome === 'max-rows' ? 3 : 2;
    const sum = (f: (r: PurgeApplyCollectionResult) => number): number => results.reduce((a, r) => a + f(r), 0);
    return {
        target: { ...input.target }, connection, collections: results, outcome, exitCode, message, stoppedIn,
        totals: { deleted: sum((r) => r.deleted), reportedDeleted: sum((r) => r.reportedDeleted), survivorsRetried: sum((r) => r.survivorsRetried), unkeyed: sum((r) => r.unkeyed) },
        deleteRequests,
    };
}

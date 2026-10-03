/**
 * dataplaneWorkspacePurge.ts — read-only scan of a DELETED Lore workspace's Dataplane rows
 * (the scan half of `lore maintain cloud-purge`; the apply half is `dataplaneWorkspacePurgeApply.ts`).
 *
 * Purpose:
 *   A deleted Lore workspace leaves its rows in the shared Dataplane collections. Before anything is
 *   deleted we must enumerate exactly which rows belong to that workspace, prove each one by its row
 *   key, and know whether the enumeration was complete. This module does the enumeration and nothing
 *   else: it takes a client typed to `query` + `count` ONLY (`PurgeScanClient`), so no path in here can
 *   send a mutating request.
 *
 * Scope is built by hand (`{orgId, loreWorkspace: targetId}`): `resolveDataplaneScope` fails closed for
 * an unregistered id, and the target is by definition unregistered.
 *
 * Row classes (see `classifyPurgeRow`): keyed = org + workspace match and `id` equals the D2 row key of
 * `lore_id` (the only rows a purge may ever delete); unkeyed = scope columns match but the key does not
 * (counted, never deleted); foreign = org or workspace differs (proves the connector ignored the filter).
 *
 * End states (`scanEndState`): complete | complete-small | capped | unverifiable. `capped` is the
 * keyed-id cap (the walk is a valid lower bound; an apply loop rescans after deleting).
 *
 * Error Behavior:
 *   `assertPurgeScopeFilter` throws before ANY request when the filter is not an `and` carrying both scope
 *   clauses (so it can never be `'all'`). Client errors from query propagate; a failed `count` is recorded
 *   on the report and downgrades the state to `unverifiable`.
 */

import {
    dataplaneRowKey,
    engineAnd,
    engineField,
    type DataplaneScope,
    type EngineFilter,
} from './dataplaneScopeFilter.js';
import { pageRepeats, SCOPED_SCAN_CAP, type ScopedBulkClient } from './dataplaneScopedIo.js';

/* ─── Constants ───────────────────────────────────────────────── */

export const WALK_PAGE = 500;
export const KEYED_ID_CAP = 5_000;
/** A recorded deletion is "still being written" when a keyed row is newer than deletedAt + this. */
export const RECORDED_WRITE_GRACE_MS = 5 * 60_000;

/** Structural client for the scan: `query` and `count` only, so a scan cannot mutate by construction. */
export type PurgeScanClient = Pick<ScopedBulkClient, 'query' | 'count'>;

export interface PurgeTarget {
    orgId: string;
    /** The deleted workspace's permanent id. */
    loreWorkspace: string;
    dataplaneWorkspaceId?: string;
}

export interface WalkLimits { keyedCap: number; scanCap: number }
const DEFAULT_LIMITS: WalkLimits = { keyedCap: KEYED_ID_CAP, scanCap: SCOPED_SCAN_CAP };

/* ─── Scope + filter safety ───────────────────────────────────── */

/** Hand-built scope; throws on empty ids so a blank target can never produce a broad filter. */
export function purgeScope(t: PurgeTarget): DataplaneScope {
    if (typeof t.orgId !== 'string' || t.orgId === '') throw new Error('cloud-purge: orgId is required');
    if (typeof t.loreWorkspace !== 'string' || t.loreWorkspace === '') throw new Error('cloud-purge: target workspace id is required');
    return { orgId: t.orgId, loreWorkspace: t.loreWorkspace, dataplaneWorkspaceId: t.dataplaneWorkspaceId ?? '' };
}

const hasEqClause = (items: unknown[], field: string, value: string): boolean =>
    items.some((c) => {
        const f = (c as { field?: { field?: unknown; operator?: unknown; value?: { string?: unknown } } } | null)?.field;
        return !!f && f.field === field && f.operator === 'eq' && f.value?.string === value;
    });

/**
 * Throws unless `filter` is an `and` containing BOTH `org_id eq <org>` and `lore_workspace eq <target>`.
 * Rejects `'all'`, a single clause, and an `and` missing either. Every request of a purge (scan and apply) must pass this first.
 */
export function assertPurgeScopeFilter(filter: unknown, scope: DataplaneScope): asserts filter is { and: EngineFilter[] } {
    const items = filter !== null && typeof filter === 'object' ? (filter as { and?: unknown }).and : undefined;
    if (!Array.isArray(items)) throw new Error('cloud-purge: refusing to send a filter that is not an `and` of scope clauses');
    if (!hasEqClause(items, 'org_id', scope.orgId)) throw new Error('cloud-purge: filter lacks the org_id scope clause');
    if (!hasEqClause(items, 'lore_workspace', scope.loreWorkspace)) throw new Error('cloud-purge: filter lacks the lore_workspace scope clause');
}

/** `and[org_id eq, lore_workspace eq]`, asserted. `engineAnd([])` would be `'all'`, which the assertion rejects. */
export function buildPurgeScanFilter(scope: DataplaneScope): { and: EngineFilter[] } {
    const filter = engineAnd([engineField('org_id', 'eq', scope.orgId), engineField('lore_workspace', 'eq', scope.loreWorkspace)]);
    assertPurgeScopeFilter(filter, scope);
    return filter;
}

/* ─── Classification ──────────────────────────────────────────── */

export type PurgeRowClass = 'keyed' | 'unkeyed' | 'foreign';

export function classifyPurgeRow(row: unknown, scope: DataplaneScope): PurgeRowClass {
    if (row === null || typeof row !== 'object') return 'foreign';
    const r = row as Record<string, unknown>;
    if (r['org_id'] !== scope.orgId || r['lore_workspace'] !== scope.loreWorkspace) return 'foreign';
    const loreId = r['lore_id'];
    if (typeof loreId !== 'string' || loreId === '' || typeof r['id'] !== 'string') return 'unkeyed';
    try {
        return r['id'] === dataplaneRowKey(scope, loreId) ? 'keyed' : 'unkeyed';
    } catch {
        return 'unkeyed'; // dataplaneRowKey refuses a U+001F in an id: such a row cannot carry a valid key
    }
}

/* ─── Recent-write probe ──────────────────────────────────────── */

export interface WriteProbe {
    /** Newest parsable `updated_at` / `created_at` among KEYED rows (epoch ms), or null. */
    newestWriteMs: number | null;
    /** Timestamp values that were present but not parsable (never trusted). */
    unparsable: number;
    /** Keyed rows carrying neither timestamp field. */
    missing: number;
    rowsSeen: number;
}

export const newWriteProbe = (): WriteProbe => ({ newestWriteMs: null, unparsable: 0, missing: 0, rowsSeen: 0 });

function parseIso(v: unknown): number | null {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
}

export function observeWrite(probe: WriteProbe, row: Record<string, unknown>): void {
    probe.rowsSeen++;
    let any = false;
    for (const f of ['updated_at', 'created_at'] as const) {
        const v = row[f];
        if (v === undefined || v === null || v === '') continue;
        any = true;
        const ms = parseIso(v);
        if (ms === null) probe.unparsable++;
        else if (probe.newestWriteMs === null || ms > probe.newestWriteMs) probe.newestWriteMs = ms;
    }
    if (!any) probe.missing++;
}

export interface ProbeDecision {
    refuse: boolean;
    /** 'unknown' = keyed rows exist but none carried a parsable timestamp: NOT refused here, the caller decides. */
    verdict: 'ok' | 'refuse' | 'unknown' | 'no-rows';
    reason: string;
}

/**
 * Recorded deletion (`deletedAtMs` set): refuse when the newest write is later than deletedAt + 5 min
 * (another instance is serving this id). Unrecorded id: refuse when the newest write is within `minAgeMs` of now.
 */
export function probeDecision(probe: WriteProbe, o: { deletedAtMs: number | null; nowMs: number; minAgeMs: number }): ProbeDecision {
    if (probe.rowsSeen === 0) return { refuse: false, verdict: 'no-rows', reason: 'no keyed rows seen' };
    const newest = probe.newestWriteMs;
    if (newest === null) return { refuse: false, verdict: 'unknown', reason: `no parsable timestamp on ${probe.rowsSeen} keyed rows` };
    if (o.deletedAtMs !== null) {
        const limit = o.deletedAtMs + RECORDED_WRITE_GRACE_MS;
        return newest > limit
            ? { refuse: true, verdict: 'refuse', reason: `newest write ${new Date(newest).toISOString()} is after deletion + 5 min` }
            : { refuse: false, verdict: 'ok', reason: 'no write after the recorded deletion' };
    }
    return newest > o.nowMs - o.minAgeMs
        ? { refuse: true, verdict: 'refuse', reason: `newest write ${new Date(newest).toISOString()} is within the minimum age` }
        : { refuse: false, verdict: 'ok', reason: 'newest write is older than the minimum age' };
}

/* ─── Walk ────────────────────────────────────────────────────── */

export type WalkStop = 'short-page' | 'empty-page' | 'repeat' | 'keyed-cap' | 'scan-cap' | 'clamped';

export interface PurgeWalk {
    collection: string;
    keyed: Array<{ rowKey: string; loreId: string }>;
    unkeyed: number;
    foreign: number;
    /** Up to 5 `lore_id`s (or `id`s) of unkeyed rows. */
    unkeyedSamples: string[];
    stoppedBecause: WalkStop;
    /** The raw page the walk stopped on was full (a filter/offset-ignoring connector may hide more rows). */
    lastPageFull: boolean;
    /** The counts are a lower bound (the walk did not see the whole collection). */
    lowerBound: boolean;
    rowsExamined: number;
    pages: number;
    /** Present only when `trackWrites` was requested. */
    probe: WriteProbe | null;
}

/**
 * One read-only offset walk of `collection` under the scope filter. Stops on a short/empty page, a repeated
 * page (offset ignored), `limits.keyedCap` keyed ids (whole page kept), or `limits.scanCap` raw rows.
 * `has_more === true` on a short page means the engine clamped our limit: reported as `clamped` (lower bound).
 */
export async function walkPurgeCollection(
    client: PurgeScanClient,
    scope: DataplaneScope,
    collection: string,
    connection: string,
    opts: { trackWrites?: boolean; limits?: Partial<WalkLimits> } = {},
): Promise<PurgeWalk> {
    const limits = { ...DEFAULT_LIMITS, ...opts.limits };
    const filter = buildPurgeScanFilter(scope);
    const w: PurgeWalk = {
        collection, keyed: [], unkeyed: 0, foreign: 0, unkeyedSamples: [], stoppedBecause: 'short-page', lastPageFull: false,
        lowerBound: false, rowsExamined: 0, pages: 0, probe: opts.trackWrites ? newWriteProbe() : null,
    };
    let head: unknown;
    for (let offset = 0; ; offset += WALK_PAGE) {
        if (offset >= limits.scanCap) { w.stoppedBecause = 'scan-cap'; break; }
        assertPurgeScopeFilter(filter, scope);
        const res = await client.query<Record<string, unknown>>(
            scope.dataplaneWorkspaceId, collection,
            { filter, sort: [{ field: 'lore_id', direction: 'asc' }], limit: WALK_PAGE, offset },
            connection,
        );
        const records = res.records ?? [];
        w.pages++;
        w.lastPageFull = records.length >= WALK_PAGE;
        if (offset === 0) head = records[0]?.['id'];
        else if (pageRepeats(head, records[0]?.['id'])) { w.stoppedBecause = 'repeat'; break; }
        w.rowsExamined += records.length;
        for (const r of records) {
            const cls = classifyPurgeRow(r, scope);
            if (cls === 'foreign') w.foreign++;
            else if (cls === 'unkeyed') {
                w.unkeyed++;
                if (w.unkeyedSamples.length < 5) w.unkeyedSamples.push(String(r['lore_id'] ?? r['id'] ?? ''));
            } else {
                w.keyed.push({ rowKey: r['id'] as string, loreId: r['lore_id'] as string });
                if (w.probe) observeWrite(w.probe, r);
            }
        }
        if (records.length < WALK_PAGE) {
            w.stoppedBecause = res.has_more === true ? 'clamped' : records.length === 0 ? 'empty-page' : 'short-page';
            break;
        }
        if (w.keyed.length >= limits.keyedCap) { w.stoppedBecause = 'keyed-cap'; break; }
    }
    w.lowerBound = !(w.stoppedBecause === 'short-page' || w.stoppedBecause === 'empty-page');
    return w;
}

/* ─── End state ───────────────────────────────────────────────── */

export type PurgeEndState = 'complete' | 'complete-small' | 'capped' | 'unverifiable';

/**
 * complete: no foreign rows, ended on a short/empty page. complete-small: foreign rows seen (filter ignored)
 * but the raw page was short, so the whole collection was seen. capped: stopped at the keyed-id cap.
 * unverifiable: filter or offset ignored on a full page (repeat), scan cap, or a clamped limit.
 */
export function scanEndState(w: Pick<PurgeWalk, 'stoppedBecause' | 'foreign'>): PurgeEndState {
    switch (w.stoppedBecause) {
        case 'short-page':
        case 'empty-page':
            return w.foreign > 0 ? 'complete-small' : 'complete';
        case 'keyed-cap':
            return 'capped';
        default:
            return 'unverifiable';
    }
}

/* ─── Dry-run scan ────────────────────────────────────────────── */

export interface CountCheck {
    count: number | null;
    /** What the walk explains: keyed + unkeyed rows seen. */
    explained: number;
    /** true when the count exceeds what the walk explains (or the count failed). */
    exceeds: boolean;
    error?: string;
}

export interface CollectionScan {
    collection: string;
    keyed: number;
    unkeyed: number;
    foreign: number;
    unkeyedSamples: string[];
    stoppedBecause: WalkStop;
    lastPageFull: boolean;
    lowerBound: boolean;
    rowsExamined: number;
    endState: PurgeEndState;
    countCheck: CountCheck | null;
    /** Only `lore_node` is probed. */
    probe: WriteProbe | null;
}

export interface PurgeScanReport {
    target: PurgeTarget;
    connection: string;
    collections: CollectionScan[];
}

const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const BUILT_IN = ['lore_edge', 'lore_version', 'lore_verbatim', 'lore_node'] as const;

/** The design's order: edges, versions, app collections, verbatim, nodes LAST. Rejects `transaction`, malformed and duplicate names. */
export function purgeCollectionOrder(extra: readonly string[] = []): string[] {
    for (const e of extra) {
        if (e === 'transaction' || !COLLECTION_NAME.test(e)) throw new Error(`cloud-purge: invalid collection name '${e}'`);
        if ((BUILT_IN as readonly string[]).includes(e)) throw new Error(`cloud-purge: collection '${e}' is already built in`);
    }
    if (new Set(extra).size !== extra.length) throw new Error('cloud-purge: duplicate --collection');
    return ['lore_edge', 'lore_version', ...extra, 'lore_verbatim', 'lore_node'];
}

/** Cross-check `count(filter)` against what the walk explains. Zero is only "consistent with complete". */
export async function crossCheck(client: PurgeScanClient, scope: DataplaneScope, w: PurgeWalk, connection: string): Promise<CountCheck> {
    const explained = w.keyed.length + w.unkeyed;
    const filter = buildPurgeScanFilter(scope);
    assertPurgeScopeFilter(filter, scope);
    try {
        const count = await client.count(scope.dataplaneWorkspaceId, w.collection, filter, connection);
        return { count, explained, exceeds: count > explained };
    } catch (e) {
        return { count: null, explained, exceeds: true, error: `${(e as Error)?.constructor?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}` };
    }
}

/**
 * Dry-run: one walk (+ one count cross-check) per collection, in the order given, `lore_node` probed for
 * recent writes. Sends only query/count requests. No printing: the CLI formats the report.
 */
export async function scanWorkspaceForPurge(input: {
    client: PurgeScanClient;
    target: PurgeTarget;
    connection: string;
    collections: readonly string[];
    limits?: Partial<WalkLimits>;
}): Promise<PurgeScanReport> {
    const scope = purgeScope(input.target);
    if (!input.connection) throw new Error('cloud-purge: a connection is required');
    const out: CollectionScan[] = [];
    for (const collection of input.collections) {
        const w = await walkPurgeCollection(input.client, scope, collection, input.connection, {
            trackWrites: collection === 'lore_node', ...(input.limits ? { limits: input.limits } : {}),
        });
        let endState = scanEndState(w);
        let countCheck: CountCheck | null = null;
        if (endState === 'complete' || endState === 'complete-small') {
            countCheck = await crossCheck(input.client, scope, w, input.connection);
            if (countCheck.exceeds) endState = 'unverifiable';
        }
        out.push({
            collection, keyed: w.keyed.length, unkeyed: w.unkeyed, foreign: w.foreign, unkeyedSamples: w.unkeyedSamples,
            stoppedBecause: w.stoppedBecause, lastPageFull: w.lastPageFull, lowerBound: w.lowerBound, rowsExamined: w.rowsExamined,
            endState, countCheck, probe: w.probe,
        });
    }
    return { target: { ...input.target }, connection: input.connection, collections: out };
}

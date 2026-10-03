/**
 * dataplaneVerbatimHistory.ts — revision history for the cloud verbatim store (cloud parity C
 * item 8, D6 as amended by R3). Mirrors the local VerbatimStore model exactly:
 *
 *   - history rows live in the SAME collection as the canonical row, under the logical id
 *     `<id>#rev<ISO-8601 ms timestamp>` (so their D2 row key differs and `isRevisionHistoryId`
 *     recognises them);
 *   - a tombstone is a canonical row whose text starts with `[TOMBSTONED <ts> reason: …]`;
 *   - `revision_state` ('current' | 'history' | 'tombstone') is a convenience column. It is written
 *     and pushed down ONLY when the collection declares it (a collection provisioned by an older
 *     Lore cannot gain a column — Dataplane has no additive ALTER, F8), and NEVER trusted: the
 *     state of a row is always derivable from its own `lore_id` and `text`, which every
 *     collection has, so legacy collections behave identically (just without server push-down).
 *
 * Snapshot timestamps are the SNAPSHOT time, not the stored `updated_at`: the engine overwrites
 * `updated_at` on every update, so it cannot order revisions.
 */
import { randomUUID } from 'node:crypto';
import { buildDataplaneScopeFilter, scopeRowFields, type DataplaneScope } from './dataplaneScopeFilter.js';
import { scopedGetRow, scopedUpsert, type ScopedUpsertClient } from './dataplaneScopedIo.js';
import { chunkGroups, isDuplicateKeyConflict, type DataplaneTransactionRunner, type TransactionOp } from './dataplaneTransaction.js';
import { isRevisionHistoryId } from './verbatimHistory.js';

export type RevisionState = 'current' | 'history' | 'tombstone';

export const TOMBSTONE_PREFIX = '[TOMBSTONED';
/** `#rev` + a 24-char ISO-8601 ms UTC timestamp (…Z). */
const REV_SUFFIX_LEN = '#rev'.length + 24;

/** State of a raw row, from its own id/text (never from the optional `revision_state` column). */
export function rowRevisionState(row: Record<string, unknown>): RevisionState {
    const loreId = row['lore_id'];
    if (typeof loreId === 'string' && isRevisionHistoryId(loreId)) return 'history';
    const text = row['text'];
    if (typeof text === 'string' && text.startsWith(TOMBSTONE_PREFIX)) return 'tombstone';
    return 'current';
}

/** True when a normal (not includeHistory) read may return the row. */
export function isCurrentRow(row: Record<string, unknown>): boolean {
    return rowRevisionState(row) === 'current';
}

/** True when `candidate` is exactly `<id>#rev<ts>` (a snapshot OF `id`, not of some longer id). */
export function isSnapshotOf(candidate: string, id: string): boolean {
    return candidate.startsWith(`${id}#rev`) && candidate.length === id.length + REV_SUFFIX_LEN && isRevisionHistoryId(candidate);
}

let lastMs = 0;
/** ISO timestamp for a snapshot id, strictly increasing within the process (same-ms snapshots must not collide). */
export function nextRevisionTimestamp(): string {
    const now = Date.now();
    lastMs = now > lastMs ? now : lastMs + 1;
    return new Date(lastMs).toISOString();
}

/**
 * A fresh snapshot timestamp after the one chosen collided with another process's snapshot of the
 * same row in the same millisecond. Still a plain ISO-8601 ms timestamp (so the `#rev<ts>` id keeps
 * the shape every reader parses and still sorts by time); the 1-20 ms random step makes two writers
 * that collide once unlikely to collide again.
 */
export function bumpRevisionTimestamp(): string {
    lastMs = Math.max(lastMs, Date.now()) + 1 + Math.floor(Math.random() * 20);
    return new Date(lastMs).toISOString();
}

/** Attempts (original + retries) at a snapshot id before a collision is reported as a failure. */
const REV_COLLISION_ATTEMPTS = 4;

export function tombstoneText(ts: string, reason: string, oldText: string): string {
    return `${TOMBSTONE_PREFIX} ${ts} reason: ${reason}]\n\n${oldText}`;
}

export const COPIED_COLUMNS = ['vector', 'text', 'type', 'label', 'tags', 'project', 'ecosystem', 'updated_at', 'security_scopes', 'content_hash'] as const;

/**
 * The history row for an existing canonical row `existing`: identity/scope columns for the
 * `<id>#rev<ts>` logical id plus a verbatim copy of the content columns (the previous text,
 * vector and metadata, with its own `updated_at`).
 */
export function snapshotRowFields(
    scope: DataplaneScope,
    loreId: string,
    ts: string,
    existing: Record<string, unknown>,
    revisionColumn: boolean,
    fallbackVector?: number[],
): { historyId: string; fields: Record<string, unknown> } {
    const historyId = `${loreId}#rev${ts}`;
    const fields: Record<string, unknown> = {};
    for (const c of COPIED_COLUMNS) if (existing[c] !== undefined && existing[c] !== null) fields[c] = existing[c];
    if (!Array.isArray(fields['vector']) && fallbackVector) fields['vector'] = fallbackVector;
    if (revisionColumn) fields['revision_state'] = 'history';
    return { historyId, fields: { ...fields, ...scopeRowFields(scope, historyId) } };
}

/** The create / update forms of one scoped row write (what `scopedUpsert` does, as transaction ops). */
export function canonicalOps(
    scope: DataplaneScope,
    collection: string,
    loreId: string,
    fields: Record<string, unknown>,
): { create: TransactionOp; update: TransactionOp } {
    const ident = scopeRowFields(scope, loreId);
    const { id: _rowKey, ...updateIdent } = ident;
    void _rowKey;
    return {
        create: { op: 'create', collection, fields: { ...fields, ...ident } },
        update: {
            op: 'update',
            collection,
            filter: buildDataplaneScopeFilter(scope, { loreId }, 'crud', 0).server as object,
            fields: { ...fields, ...updateIdent },
        },
    };
}

export interface SnapshotGroup {
    /** Logical id of the row being written (what a failed batch reports as not written). */
    id: string;
    /** `[history create, canonical write]` — one atomic unit. Empty for a change-only group. */
    ops: TransactionOp[];
    /** Separate-write fallback, in order: the change first, then the history row. */
    change: () => Promise<unknown>;
    history: () => Promise<unknown>; // result ignored
    what: string;
    /** The same group under a new snapshot timestamp (a `#rev<ts>` id collision); absent for change-only groups. */
    rebuild?: (ts: string) => SnapshotGroup;
}

/**
 * A batch write that stopped part-way (review C #9). `notWritten` lists the logical ids whose write
 * did not complete: the failing chunk (atomic, so none of it applied) or the unfinished separate
 * writes, and every group after it. Everything else in the batch IS written.
 */
export class VerbatimBatchWriteError extends Error {
    constructor(readonly notWritten: string[], readonly cause: unknown, total: number) {
        const shown = notWritten.slice(0, 200).join(', ');
        const more = notWritten.length > 200 ? ` (+${notWritten.length - 200} more)` : '';
        super(`${(cause as Error)?.message ?? String(cause)} -- ${notWritten.length} of ${total} rows not written: ${shown}${more}`);
        this.name = 'VerbatimBatchWriteError';
    }
}

/**
 * The change + history group for overwriting an EXISTING canonical row `existing` (raw, as read)
 * with `fields`: the previous content is copied to `<id>#rev<ts>` first. `fallbackVector` covers a
 * connector whose GET omits the vector column.
 */
export function buildSnapshotGroup(a: {
    client: ScopedUpsertClient;
    scope: DataplaneScope;
    collection: string;
    connection?: string;
    loreId: string;
    fields: Record<string, unknown>;
    existing: Record<string, unknown>;
    revisionColumn: boolean;
    fallbackVector?: number[];
    ts?: string;
}): SnapshotGroup {
    const make = (ts: string): SnapshotGroup => {
        const snap = snapshotRowFields(a.scope, a.loreId, ts, a.existing, a.revisionColumn, a.fallbackVector);
        const hist = canonicalOps(a.scope, a.collection, snap.historyId, snap.fields);
        const canon = canonicalOps(a.scope, a.collection, a.loreId, a.fields);
        const { id: _k, lore_id: _l, lore_workspace: _w, org_id: _o, ...historyCols } = snap.fields;
        void _k; void _l; void _w; void _o;
        return {
            id: a.loreId,
            // History first: the engine runs ops in order, so a duplicate history key (another
            // process snapshotting the same row in the same ms) aborts before the canonical row
            // changes; writeSnapshotGroups then rebuilds the group under a bumped timestamp.
            ops: [hist.create, canon.update],
            change: () => scopedUpsert(a.client, a.scope, a.collection, a.loreId, a.fields, a.connection),
            // Separate path: scopedUpsert would silently overwrite another writer's snapshot of the
            // same ms, so look first and move to a later timestamp when the id is taken.
            history: async () => {
                let t = ts;
                for (let attempt = 1; ; attempt++) {
                    const s = snapshotRowFields(a.scope, a.loreId, t, a.existing, a.revisionColumn, a.fallbackVector);
                    if (await scopedGetRow(a.client, a.scope, a.collection, s.historyId, a.connection) === null) {
                        const { id: _a, lore_id: _b, lore_workspace: _c, org_id: _d, ...cols } = s.fields;
                        void _a; void _b; void _c; void _d;
                        await scopedUpsert(a.client, a.scope, a.collection, s.historyId, cols, a.connection);
                        return;
                    }
                    if (attempt >= REV_COLLISION_ATTEMPTS) throw new Error(`snapshot id ${s.historyId} is taken and ${attempt} later timestamps were too`);
                    t = bumpRevisionTimestamp();
                }
            },
            what: `verbatim:${a.loreId}`,
            rebuild: make,
        };
    };
    return make(a.ts ?? nextRevisionTimestamp());
}

/** Write one snapshot group: atomically when the route exists, else change then history (failure counted). */
export async function writeSnapshotGroup(runner: DataplaneTransactionRunner, tenant: string, group: SnapshotGroup): Promise<void> {
    let g = group;
    for (let attempt = 1; ; attempt++) {
        try {
            await runner.writeWithHistory({ tenant, ops: g.ops, key: `lore-${randomUUID()}`, what: g.what, change: g.change, history: async () => { await g.history(); } });
            return;
        } catch (err) {
            if (!g.rebuild || !isDuplicateKeyConflict(err) || attempt >= REV_COLLISION_ATTEMPTS) throw err;
            g = g.rebuild(bumpRevisionTimestamp());
        }
    }
}

/**
 * Write many snapshot groups (review C #9). Order: change-only groups first (no transaction form;
 * they must not be left behind by a failing chunk), then the transactional groups chunked to the
 * engine's 100-op limit with each pair kept whole, one chunk at a time. When a chunk's route is
 * unavailable its groups take the separate-write path. The first failure stops everything after it
 * and is thrown as a VerbatimBatchWriteError naming every id not written. Atomicity is per chunk,
 * not across the batch (see dataplaneTransaction.ts). A chunk that loses a `#rev<ts>` id to
 * another process (duplicate key; nothing applied) is rebuilt under a later timestamp and resent.
 */
export async function writeSnapshotGroups(
    runner: DataplaneTransactionRunner,
    tenant: string,
    groups: readonly SnapshotGroup[],
    concurrency: number,
): Promise<void> {
    const done = new Set<string>(); // logical ids (a collision rebuild replaces the group object)
    const fail = (cause: unknown): never => {
        throw new VerbatimBatchWriteError(groups.filter((g) => !done.has(g.id)).map((g) => g.id), cause, groups.length);
    };
    const writeSeparately = async (list: readonly SnapshotGroup[]): Promise<void> => {
        let next = 0;
        let failure: unknown;
        let failed = false;
        const worker = async (): Promise<void> => {
            while (!failed && next < list.length) {
                const g = list[next++]!;
                try {
                    await g.change();
                    done.add(g.id);
                    try { await g.history(); } catch (err) { runner.recordHistoryFailure(g.what, err); }
                } catch (err) { if (!failed) { failed = true; failure = err; } }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
        if (failed) fail(failure);
    };
    await writeSeparately(groups.filter((g) => g.ops.length === 0));
    for (let chunk of chunkGroups(groups.filter((g) => g.ops.length > 0))) {
        let outcome: 'committed' | 'unavailable' | undefined;
        for (let attempt = 1; outcome === undefined; attempt++) {
            try {
                outcome = await runner.tryCommit(tenant, chunk.flatMap((g) => g.ops), `lore-${randomUUID()}`);
            } catch (err) {
                if (!isDuplicateKeyConflict(err) || attempt >= REV_COLLISION_ATTEMPTS || chunk.some((g) => !g.rebuild)) fail(err);
                chunk = chunk.map((g) => g.rebuild!(bumpRevisionTimestamp())); // nothing was applied
            }
        }
        if (outcome === 'committed') { for (const g of chunk) done.add(g.id); continue; }
        await writeSeparately(chunk);
    }
}

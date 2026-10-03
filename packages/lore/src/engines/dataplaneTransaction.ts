/**
 * dataplaneTransaction.ts — atomic "change + history" writes over Dataplane's `POST /v1/transaction`
 * (cloud parity Slice C item 8, D6 as amended by R3).
 *
 * What this module decides
 * ────────────────────────
 *   1. Is the route there?  Detected ONCE PER CLIENT (= once per process in production, a client is
 *      built once and `transactionRunnerFor` caches the runner in a WeakMap), on FIRST USE, by simply
 *      trying the real transaction. No probe request is sent and no sentinel row is ever written:
 *        - an SDK build without a `transaction` method is "absent" without any request;
 *        - a server without the route answers 404, and a connector that cannot run transactions
 *          (SQLite) answers 501 UNSUPPORTED_CONNECTOR; both are returned by the engine BEFORE any
 *          operation executes (groundfloor-dataplane-oss handlers.rs:5438 / postgres.rs:1444), so a
 *          404/501 never leaves a half-applied write behind and the very write we wanted to do is
 *          then done through the fallback path below.
 *        - an OLD engine without the route reads the attempt as a single-record create of a collection
 *          named "transaction" (201, no `committed`): treated as absent too, and the one junk row it
 *          wrote is deleted again (cleanupFallthroughRow, best effort).
 *      A cheap OPTIONS/HEAD probe was rejected: it would add a request per process for no gain and
 *      the engine has no capability endpoint that names this route. Any OTHER failure (5xx, network,
 *      400/409/…) is NOT cached as "absent": it is surfaced to the caller as a failed write.
 *      The connector is part of "is it there": /v1/transaction runs on `postgresql` when no connection
 *      is named while the CRUD routes run on `sqlite` (engine handlers.rs:265-277 vs :5782), so
 *      with NO configured connection (`DATAPLANE_CONNECTION`) transactions are never attempted:
 *      the route is treated as unavailable, once, with a single warning.
 *   2. Route present: the change and its history row go in ONE transaction (at most 100 ops), so
 *      either both exist or neither does. A failed transaction writes nothing and throws.
 *   3. Route absent (R3): the change is written first, then the history row separately. A history
 *      write failure does NOT fail the change (the caller already has a durable change); it is
 *      counted and surfaced in /health (`getCloudHistoryHealth`). No flag switches this.
 *
 * Hazards handled here (all verified against engine origin/main)
 * ───────────────────────────────────────────────────────────────
 *   - ALIAS REFERENCES: a TOP-LEVEL string field value of exactly `$<alias>.id` is read by the
 *     engine as a reference to an earlier op's generated id (`try_resolve_alias_ref_pg`), and an
 *     undeclared alias fails the WHOLE transaction. A user-controlled string (a node label, a
 *     verbatim text) can have that shape, so a group carrying one is never sent through the
 *     transaction route: it is written by the separate-write path (counted as `aliasFallbacks`).
 *   - IDEMPOTENCY: the engine caches EVERY response (errors included) per (workspace, key) and
 *     replays it, so a retry after a failure MUST use a new key. Keys are `lore-<uuid>`; the
 *     conflict retry appends `-u`.
 *   - ATOMICITY IS PER TRANSACTION: a request is capped at 100 ops, so callers with more than 50
 *     change+history pairs (storeBatch) are chunked; each chunk is atomic, the batch as a whole is
 *     not (a failure in chunk N leaves chunks 1..N-1 committed; the caller's retry skips rows that
 *     are already identical).
 *
 * No SDK import: the client is typed structurally.
 */
import { log } from '../logger.js';
import type { TransactionOp, TransactionOptions, TransactionResult } from './dataplaneSdkCompat.js';
import { engineAnd, engineField, engineIdEq } from './dataplaneScopeFilter.js';

export type { TransactionOp } from './dataplaneSdkCompat.js';

/** Engine limit on operations per transaction (dsl/validator.rs). */
export const MAX_TRANSACTION_OPS = 100;

export type TransactionSupport = 'unknown' | 'present' | 'absent';

export interface TransactionCapableClient {
    transaction?(tenantId: string, operations: TransactionOp[], options?: TransactionOptions): Promise<TransactionResult>;
    /** Used only to remove the junk row an old engine's fall-through create leaves (see cleanupFallthroughRow). */
    deleteByQuery?(tenantId: string, collection: string, filter: object, connection?: string): Promise<unknown>;
}

export interface CloudHistoryHealth {
    /** What first use found: 'unknown' until a write needed a transaction. */
    transactions: TransactionSupport;
    /** change+history groups committed atomically. */
    atomicCommits: number;
    /** groups written by the separate-write fallback (route absent, or an alias-shaped value). */
    separateWrites: number;
    /** groups skipped from the transaction route because a field value looked like `$alias.id`. */
    aliasFallbacks: number;
    /** history rows that could not be written after their change was (separate-write path only). */
    historyWriteFailures: number;
    /** transactions that committed an update matching no row; their created rows were removed and the group re-written separately. */
    zeroMatchFallbacks: number;
    lastHistoryFailure?: { at: string; what: string; message: string };
}

/** An `update` op whose result says it matched no row (engine postgres.rs / arangodb.rs: `matched` = rows affected). */
function zeroMatchUpdate(ops: readonly TransactionOp[], res: TransactionResult): boolean {
    const results = Array.isArray(res?.results) ? res.results : [];
    return ops.some((op, i) => {
        if (op.op !== 'update') return false;
        const r = results.find((x) => x?.op_index === i) ?? results[i];
        return r?.matched === 0;
    });
}

const ALIAS_REF = /^\$[a-z_][a-z0-9_]*\.id$/;

function carriesAliasRef(op: TransactionOp): boolean {
    const scan = (rec: Record<string, unknown>): boolean => Object.values(rec).some((v) => typeof v === 'string' && ALIAS_REF.test(v));
    switch (op.op) {
        case 'create':
        case 'update': return scan(op.fields);
        case 'bulk_create': return op.records.some(scan);
        default: return false;
    }
}

function statusOf(err: unknown): number | undefined {
    const e = err as { status?: unknown; statusCode?: unknown } | null | undefined;
    if (!e || typeof e !== 'object') return undefined;
    if (typeof e.statusCode === 'number') return e.statusCode;
    return typeof e.status === 'number' ? e.status : undefined;
}

/**
 * A duplicate-key rejection of a create inside the transaction. The SDK's GroundfloorError carries only
 * `message` and `statusCode` (no `.code`, groundfloor-ts-sdk errors), so the only thing to go on is a 409
 * plus the message the engine builds for a unique violation (`... duplicate key value violates unique
 * constraint "<coll>_pkey"`, postgres.rs insert_single_in_pg_tx). 409 also covers "request with this
 * Idempotency-Key is still in flight" and every other failed op (missing relation, ...): none of those
 * may be retried as an update, so the message is required, not just the status.
 */
const DUPLICATE_KEY = /duplicate key|unique constraint/i;
export function isDuplicateKeyConflict(err: unknown): boolean {
    const m = (err as { message?: unknown } | null | undefined)?.message;
    return statusOf(err) === 409 && typeof m === 'string' && DUPLICATE_KEY.test(m);
}

/** The engine answered 2xx but did not say `committed: true` (review C #4). `reported` is the committed value seen. */
class TransactionNotCommitted extends Error {
    constructor(readonly reported: unknown, readonly response?: unknown) {
        super(reported === false
            ? 'dataplane transaction reported committed:false'
            : 'dataplane transaction response did not report committed:true');
    }
}

export type CommitOutcome = 'committed' | 'unavailable';

export class DataplaneTransactionRunner {
    private support: TransactionSupport = 'unknown';
    private readonly counters = { atomicCommits: 0, separateWrites: 0, aliasFallbacks: 0, historyWriteFailures: 0, zeroMatchFallbacks: 0 };
    private lastFailure?: CloudHistoryHealth['lastHistoryFailure'];

    constructor(private readonly client: TransactionCapableClient, private readonly connection?: string) {}

    health(): CloudHistoryHealth {
        return { transactions: this.support, ...this.counters, ...(this.lastFailure ? { lastHistoryFailure: { ...this.lastFailure } } : {}) };
    }

    private markAbsent(why: string): void {
        if (this.support === 'absent') return;
        this.support = 'absent';
        log.warn('cloud_transactions_absent', { why, effect: 'history rows are written after their change, separately (failures counted in /health)' });
    }

    /**
     * Try to commit `ops` atomically. 'committed' = all applied. 'unavailable' = nothing was sent
     * or nothing was applied (route absent / alias-shaped value): the caller must write the group
     * itself. A genuine failure throws and applied nothing. `retryOps` (the same writes with
     * updates instead of creates) is sent once, under a new key, when a create hits a duplicate key.
     */
    async tryCommit(tenant: string, ops: TransactionOp[], key: string, retryOps?: TransactionOp[]): Promise<CommitOutcome> {
        if (ops.length === 0) return 'committed';
        if (ops.length > MAX_TRANSACTION_OPS) throw new Error(`dataplane transaction: ${ops.length} ops exceeds the ${MAX_TRANSACTION_OPS}-op limit; chunk first`);
        if (this.support === 'absent') return 'unavailable';
        // Review C #1: the engine resolves the connector of /v1/transaction (postgresql) differently from
        // the CRUD routes (sqlite), so a transaction sent without an explicit connection can run on a
        // different database than the one the rest of Lore reads and writes. Never send one blind.
        if (!this.connection) { this.markAbsent('no Dataplane connection configured (DATAPLANE_CONNECTION)'); return 'unavailable'; }
        if (typeof this.client.transaction !== 'function') { this.markAbsent('sdk has no transaction()'); return 'unavailable'; }
        if (ops.some(carriesAliasRef)) { this.counters.aliasFallbacks++; return 'unavailable'; }
        let sent = ops;
        const send = async (o: TransactionOp[], k: string): Promise<TransactionResult> => {
            sent = o;
            const res = await this.client.transaction!(tenant, o, { connection: this.connection!, idempotencyKey: k });
            // Review C #4: success is `committed === true`, nothing weaker. An engine without the route
            // can route the call to a record create (201, a record, no `committed`); that must not read as success.
            const reported = (res as { committed?: unknown } | null | undefined)?.committed;
            if (reported !== true) throw new TransactionNotCommitted(reported, res);
            return res;
        };
        let res: TransactionResult;
        try {
            try {
                res = await send(ops, key);
            } catch (err) {
                if (retryOps && isDuplicateKeyConflict(err)) res = await send(retryOps, `${key}-u`);
                else throw err;
            }
        } catch (err) {
            const st = statusOf(err);
            if (this.support !== 'present' && (st === 404 || st === 501)) { this.markAbsent(`HTTP ${st}`); return 'unavailable'; }
            // First use, 2xx, no `committed` at all: not this route (see send). Once the route has answered
            // properly even once, the same response is a malfunction and fails the write.
            if (err instanceof TransactionNotCommitted && err.reported === undefined && this.support === 'unknown') {
                this.markAbsent('response had no `committed` field (an engine without /v1/transaction)');
                await this.cleanupFallthroughRow(tenant, err.response);
                return 'unavailable';
            }
            throw err;
        }
        this.support = 'present';
        // Review C #3: the engine commits an update that matched nothing (`matched: 0`) without complaint.
        // The change we meant to make did not happen, so the history created beside it must not stay.
        if (zeroMatchUpdate(sent, res)) {
            await this.compensate(tenant, sent, key);
            this.counters.zeroMatchFallbacks++;
            log.warn('cloud_transaction_zero_match', { key, effect: 'rows created by the transaction were removed; the group is written by the separate-write path' });
            return 'unavailable';
        }
        this.counters.atomicCommits++;
        return 'committed';
    }

    /**
     * Review C follow-up C. On an engine WITHOUT /v1/transaction the route `POST /v1/:collection` matches
     * with collection = "transaction", so our first-use attempt is read as a single-record create and
     * leaves ONE junk row (carrying the whole ops payload) in a collection named "transaction"
     * (engine handlers.rs create_record; the SQLite connector even creates the table). The attempt body
     * cannot be shaped to be rejected there: the create route accepts any flat body, and the engine has
     * no schema for a collection that does not exist. So the row is removed right away, best effort:
     * by the id the create answered with (`id_eq`: delete-by-query matches in memory against the row's fields,
     * and the physical id is not one of them), inside collection "transaction" only. A failed removal is
     * logged and never fails the write (the change still goes through the separate-write path). The
     * empty table itself stays (nothing Lore may drop). Happens at most once per client.
     */
    private async cleanupFallthroughRow(tenant: string, response: unknown): Promise<void> {
        const id = (response as { id?: unknown } | null | undefined)?.id;
        if (typeof id !== 'string' || id === '' || typeof this.client.deleteByQuery !== 'function') {
            log.warn('cloud_transaction_fallthrough_row_left', { why: 'no row id in the response, or the client cannot delete', collection: 'transaction' });
            return;
        }
        try {
            await this.client.deleteByQuery(tenant, 'transaction', engineIdEq(id) as object, this.connection);
        } catch (err) {
            log.warn('cloud_transaction_fallthrough_row_left', { why: (err as Error)?.message ?? String(err), collection: 'transaction', id });
        }
    }

    /**
     * Undo the creates of a transaction that committed but whose update matched no row: delete each created
     * row by its row key, scoped to the same org + workspace, in ONE transaction. If this fails the history
     * rows are orphaned, which is surfaced as a failure of the write (never swallowed).
     */
    private async compensate(tenant: string, sent: TransactionOp[], key: string): Promise<void> {
        const del = (collection: string, f: Record<string, unknown>): TransactionOp => {
            const id = f['id'];
            if (typeof id !== 'string' || id === '') throw new Error(`dataplane transaction compensation: a created ${collection} row has no id`);
            const clauses = [engineField('id', 'eq', id)];
            for (const col of ['org_id', 'lore_workspace']) if (typeof f[col] === 'string') clauses.push(engineField(col, 'eq', f[col]));
            return { op: 'delete', collection, filter: engineAnd(clauses) as object };
        };
        const ops: TransactionOp[] = [];
        for (const op of sent) {
            if (op.op === 'create') ops.push(del(op.collection, op.fields));
            else if (op.op === 'bulk_create') for (const r of op.records) ops.push(del(op.collection, r));
        }
        if (ops.length === 0) return;
        try {
            const r = await this.client.transaction!(tenant, ops, { connection: this.connection!, idempotencyKey: `${key}-c` });
            if ((r as { committed?: unknown } | null | undefined)?.committed !== true) throw new TransactionNotCommitted((r as { committed?: unknown } | null | undefined)?.committed);
        } catch (err) {
            log.error('cloud_transaction_compensation_failed', { key, message: (err as Error)?.message ?? String(err) });
            throw new Error(`dataplane transaction: an update matched no row and removing the rows its transaction created failed (${(err as Error)?.message ?? String(err)}); history rows for ${key} may be orphaned`);
        }
    }

    /**
     * One change + its history. Atomic when the route exists; otherwise `change()` then `history()`
     * with a history failure counted instead of thrown. `change()` failing always propagates (and
     * history is then never attempted).
     */
    async writeWithHistory<T>(a: {
        tenant: string;
        ops: TransactionOp[];
        retryOps?: TransactionOp[];
        key: string;
        what: string;
        change: () => Promise<T>;
        history: () => Promise<void>;
    }): Promise<{ atomic: boolean; value?: T }> {
        if (await this.tryCommit(a.tenant, a.ops, a.key, a.retryOps) === 'committed') return { atomic: true };
        const value = await a.change();
        this.counters.separateWrites++;
        try { await a.history(); } catch (err) { this.recordHistoryFailure(a.what, err); }
        return { atomic: false, value };
    }

    recordHistoryFailure(what: string, err: unknown): void {
        this.counters.historyWriteFailures++;
        const message = (err as Error)?.message ?? String(err);
        this.lastFailure = { at: new Date().toISOString(), what, message };
        log.warn('cloud_history_write_failed', { what, message });
    }
}

const runners = new WeakMap<object, DataplaneTransactionRunner>();
const live = new Set<WeakRef<DataplaneTransactionRunner>>();

/** The runner for a client (shared by graph, verbatim store and version store, so detection and counters are one). */
export function transactionRunnerFor(client: unknown, connection?: string): DataplaneTransactionRunner {
    const key = client as object;
    let r = runners.get(key);
    if (!r) {
        r = new DataplaneTransactionRunner(client as TransactionCapableClient, connection);
        runners.set(key, r);
        live.add(new WeakRef(r));
    }
    return r;
}

/** Aggregate over the live runners of this process, or null when no cloud store has run (local mode). */
export function getCloudHistoryHealth(): CloudHistoryHealth | null {
    let out: CloudHistoryHealth | null = null;
    for (const ref of [...live]) {
        const r = ref.deref();
        if (!r) { live.delete(ref); continue; }
        const h = r.health();
        if (!out) { out = h; continue; }
        out = {
            transactions: out.transactions === h.transactions ? out.transactions : (out.transactions === 'unknown' ? h.transactions : out.transactions),
            atomicCommits: out.atomicCommits + h.atomicCommits,
            separateWrites: out.separateWrites + h.separateWrites,
            aliasFallbacks: out.aliasFallbacks + h.aliasFallbacks,
            historyWriteFailures: out.historyWriteFailures + h.historyWriteFailures,
            zeroMatchFallbacks: out.zeroMatchFallbacks + h.zeroMatchFallbacks,
            ...(h.lastHistoryFailure ?? out.lastHistoryFailure ? { lastHistoryFailure: (h.lastHistoryFailure ?? out.lastHistoryFailure)! } : {}),
        };
    }
    return out;
}

/** Split change+history groups into transactions of at most MAX_TRANSACTION_OPS ops, groups kept whole. */
export function chunkGroups<G extends { ops: TransactionOp[] }>(groups: readonly G[]): G[][] {
    const chunks: G[][] = [];
    let cur: G[] = [];
    let n = 0;
    for (const g of groups) {
        if (g.ops.length > MAX_TRANSACTION_OPS) throw new Error(`dataplane transaction group of ${g.ops.length} ops exceeds ${MAX_TRANSACTION_OPS}`);
        if (n + g.ops.length > MAX_TRANSACTION_OPS) { chunks.push(cur); cur = []; n = 0; }
        cur.push(g);
        n += g.ops.length;
    }
    if (cur.length > 0) chunks.push(cur);
    return chunks;
}

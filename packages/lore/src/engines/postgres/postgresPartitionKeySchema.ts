/**
 * postgresPartitionKeySchema.ts - Postgres engine, Phase 0 lane L3.
 *
 * Two additive pieces of shard-ready data model on the graph tables:
 *
 *   partition_key   TEXT NOT NULL DEFAULT ''   on nodes and edges (verbatim's copy lives in
 *                   postgresVerbatimPartitionDdl.ts). A constant-default ADD COLUMN is a catalog-only
 *                   change on PG 11+ (no table rewrite). See engines/graphShared/partitionKey.ts for the rules.
 *   created_at_ts   TIMESTAMPTZ                on nodes. Typed twin of the TEXT `"createdAt"` (same
 *                   pattern and the same {@link toPgTimestamp} parse as valid_from_at / valid_until_at);
 *                   written on every insert, backfilled here for older rows.
 *
 * Everything is idempotent and runs inside `runSchemaBootstrap` (advisory-locked, autocommitted
 * statements). `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE even when the column
 * is already there, so {@link ensurePartitionColumns} probes the catalog first and only alters when a
 * column is missing: re-opening an up-to-date database takes no table lock. The pending-rows index is built
 * CONCURRENTLY, but only OFF the bootstrap path (see {@link ensureCreatedAtTs}).
 */
import type { Pool, PoolClient } from 'pg';
import { poolGuardFor } from './postgresPoolGuard.js';
import { toPgTimestamp } from './postgresAsOfSchema.js';

type Q = Pick<PoolClient, 'query'>;

/** Plain idempotent DDL for a FRESH database / replay scripts (graphSchema_ddl). Not used on re-open. */
export function partitionKeySchemaDdl(): string[] {
    return [
        "ALTER TABLE nodes ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT ''",
        'ALTER TABLE nodes ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ',
        "ALTER TABLE edges ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT ''",
    ];
}

const REQUIRED: ReadonlyArray<{ table: 'nodes' | 'edges'; column: string; ddl: string }> = [
    { table: 'nodes', column: 'partition_key', ddl: "ALTER TABLE nodes ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT ''" },
    { table: 'nodes', column: 'created_at_ts', ddl: 'ALTER TABLE nodes ADD COLUMN IF NOT EXISTS created_at_ts TIMESTAMPTZ' },
    { table: 'edges', column: 'partition_key', ddl: "ALTER TABLE edges ADD COLUMN IF NOT EXISTS partition_key TEXT NOT NULL DEFAULT ''" },
];

/** Add whichever of the three columns is missing; takes no table lock when all are present. Returns the columns added. */
export async function ensurePartitionColumns(client: Q): Promise<string[]> {
    const have = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name IN ('nodes', 'edges')
           AND column_name IN ('partition_key', 'created_at_ts')`,
    );
    const present = new Set(have.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const added: string[] = [];
    for (const r of REQUIRED) {
        if (present.has(`${r.table}.${r.column}`)) continue;
        await client.query(r.ddl);
        added.push(`${r.table}.${r.column}`);
    }
    return added;
}

const PENDING_INDEX = 'idx_nodes_created_at_ts_pending';
const BUILD_LOCK_KEY = 7_364_920_119; // distinct from the schema (…117), keyword (…118) build keys
export const CREATED_AT_TS_INLINE_ROW_LIMIT = 50_000;

/**
 * Tiny partial index of the rows the backfill still has to fill, so the "anything left?" probe never scans the
 * table. `concurrently` is only for the background job: bootstrap holds the cluster-wide schema advisory lock and
 * CREATE INDEX CONCURRENTLY waits for every older transaction, including the other openers parked on that very
 * lock (40P01 deadlock, seen in pg-workspace-sk-unit). A failed concurrent build leaves an INVALID index behind;
 * it is dropped and rebuilt so a retry converges.
 */
export async function ensureCreatedAtTsPendingIndex(client: Q, concurrently: boolean): Promise<void> {
    const st = await client.query<{ indisvalid: boolean }>(
        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
        [PENDING_INDEX],
    );
    if (st.rows.length > 0 && st.rows[0]!.indisvalid) return;
    if (st.rows.length > 0) await client.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS ${PENDING_INDEX}`);
    await client.query(
        `CREATE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${PENDING_INDEX} ON nodes(workspace_id, id)
         WHERE "createdAt" <> '' AND created_at_ts IS NULL`,
    );
}

async function pendingIndexValid(client: Q): Promise<boolean> {
    const r = await client.query(
        `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace AND i.indisvalid AND i.indisready`,
        [PENDING_INDEX],
    );
    return (r.rowCount ?? 0) > 0;
}

/**
 * Bootstrap step. Small table (<= inlineRowLimit rows): plain index + inline backfill (well under a second).
 * Large table: nothing heavy runs under the schema lock; `pending` tells the graph handle to run
 * {@link startCreatedAtTsBuild} in the background. A large table whose index is valid and has nothing left to fill
 * costs one index probe and reports not pending.
 */
export async function ensureCreatedAtTs(client: Q, opts: { inlineRowLimit?: number } = {}): Promise<{ pending: boolean }> {
    const limit = Math.trunc(opts.inlineRowLimit ?? CREATED_AT_TS_INLINE_ROW_LIMIT);
    const probe = await client.query<{ n: string }>(`SELECT count(*) AS n FROM (SELECT 1 FROM nodes LIMIT ${limit + 1}) s`);
    if (Number(probe.rows[0]!.n) <= limit) {
        await ensureCreatedAtTsPendingIndex(client, false);
        await backfillCreatedAtTs(client);
        return { pending: false };
    }
    if (await pendingIndexValid(client)) {
        const left = await client.query(`SELECT 1 FROM nodes WHERE "createdAt" <> '' AND created_at_ts IS NULL LIMIT 1`);
        return { pending: (left.rowCount ?? 0) > 0 };
    }
    return { pending: true };
}

const BACKFILL_BATCH = 5_000;

/**
 * Fill `created_at_ts` for rows written before the column existed. Batched per workspace (keyset on
 * (workspace_id, id), each batch its own autocommitted statement) and re-checks the text it read, so a concurrent
 * write is never overwritten with a stale derivation. Rows whose text does not parse stay NULL and are skipped by
 * the keyset, so the loop ends. Idempotent. Returns rows updated.
 */
export async function backfillCreatedAtTs(client: Q, batch: number = BACKFILL_BATCH, isCancelled: () => boolean = () => false): Promise<number> {
    let total = 0;
    const wss = await client.query<{ workspace_id: string }>(
        `SELECT DISTINCT workspace_id FROM nodes WHERE "createdAt" <> '' AND created_at_ts IS NULL ORDER BY workspace_id`,
    );
    for (const { workspace_id: ws } of wss.rows) {
        let lastId = '';
        let first = true;
        for (;;) {
            if (isCancelled()) return total;
            const res = await client.query<{ id: string; ca: string }>(
                `SELECT id, "createdAt" AS ca FROM nodes
                 WHERE workspace_id = $1 AND "createdAt" <> '' AND created_at_ts IS NULL AND ($2::boolean OR id > $3)
                 ORDER BY id LIMIT $4`,
                [ws, first, lastId, batch],
            );
            first = false;
            if (res.rows.length === 0) break;
            lastId = res.rows[res.rows.length - 1]!.id;
            const rows = res.rows.map((r) => ({ r, t: toPgTimestamp(r.ca) })).filter((x) => x.t !== null);
            if (rows.length > 0) {
                const upd = await client.query(
                    `UPDATE nodes n SET created_at_ts = v.t
                     FROM unnest($2::text[], $3::text[], $4::timestamptz[]) AS v(id, ca, t)
                     WHERE n.workspace_id = $1 AND n.id = v.id AND n."createdAt" = v.ca AND n.created_at_ts IS NULL`,
                    [ws, rows.map((x) => x.r.id), rows.map((x) => x.r.ca), rows.map((x) => x.t)],
                );
                total += upd.rowCount ?? 0;
            }
            if (res.rows.length < batch) break;
        }
    }
    return total;
}

/* ── background build for a large legacy table, shared per pool ─── */

interface Running { done: Promise<void>; owners: Set<object>; ctl: AbortController }
const running = new WeakMap<Pool, Running>();

/**
 * Concurrent pending-index build + batched backfill as a guarded background job (own advisory lock, own
 * connection, no statement timeout). Never rejects. One job per pool; further owners join it; the last owner out
 * aborts it. Every step is idempotent, so an aborted or skipped job simply resumes on the next open.
 */
export function startCreatedAtTsBuild(pool: Pool, owner: object): Promise<void> {
    const existing = running.get(pool);
    if (existing) { existing.owners.add(owner); return existing.done; }
    const state: Running = { done: Promise.resolve(), owners: new Set([owner]), ctl: new AbortController() };
    const cancelled = (): boolean => state.ctl.signal.aborted;
    state.done = (async () => {
        try {
            await poolGuardFor(pool).run('created-at-ts-build', async (client) => {
                const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [BUILD_LOCK_KEY]);
                if (!lock.rows[0]!.ok) return; // another process is on it
                try {
                    await ensureCreatedAtTsPendingIndex(client, true);
                    await backfillCreatedAtTs(client, BACKFILL_BATCH, cancelled);
                } finally {
                    await client.query('SELECT pg_advisory_unlock($1)', [BUILD_LOCK_KEY]).catch(() => undefined);
                }
            }, { signal: state.ctl.signal, timeoutMs: 0 });
        } catch (err) {
            if (!cancelled()) console.warn(`[PostgresGraph] background created_at_ts build failed: ${(err as Error).message}`);
        } finally {
            running.delete(pool);
        }
    })();
    running.set(pool, state);
    return state.done;
}

export async function releaseCreatedAtTsBuild(pool: Pool | null, owner: object): Promise<void> {
    const state = pool ? running.get(pool) : undefined;
    if (!pool || !state) return;
    state.owners.delete(owner);
    if (state.owners.size > 0) return;
    state.ctl.abort();
    await state.done;
}

/** The running build's promise for this pool (tests, graceful shutdown). */
export function createdAtTsBuildDone(pool: Pool | null): Promise<void> {
    return (pool ? running.get(pool)?.done : undefined) ?? Promise.resolve();
}

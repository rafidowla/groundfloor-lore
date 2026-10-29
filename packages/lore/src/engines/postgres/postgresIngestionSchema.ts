/**
 * postgresIngestionSchema.ts — Postgres engine: the ingestion-coordinator DDL.
 *
 * Mirrors `ingestion/sqliteStore.ts` table-for-table with the Postgres
 * substitutions: JSONB for params / result / pending payload, TIMESTAMPTZ for
 * times, and `workspace_id TEXT NOT NULL` on EVERY table as the hard tenant
 * column (every query the store issues filters on it).
 *
 * Table names carry a `lore_ingest_` prefix (SQLite uses bare `ingest_`) because
 * the structured-table side writes user tables named `ingest_<profile>` into the
 * same database: a profile called "jobs" must not collide with coordinator state.
 *
 * Uniqueness the store relies on (every ON CONFLICT in postgresIngestionStore.ts names a workspace-led key):
 *   - jobs:       UNIQUE (workspace_id, job_id); the legacy PRIMARY KEY (job_id) is kept until
 *                 {@link dropLegacyIngestionKeys}, which promotes the workspace-led key to PRIMARY KEY (workspace_id, job_id)
 *   - sources:    PRIMARY KEY (workspace_id, source_id) + UNIQUE (workspace_id, sha256)
 *   - deliveries: UNIQUE (workspace_id, job_id, delivery_id)  (replay guard); legacy PRIMARY KEY (job_id, delivery_id)
 *   - pending:    UNIQUE (workspace_id, job_id); legacy PRIMARY KEY (job_id)
 *   After the contract step all three tables carry a workspace-led PRIMARY KEY (rule R1) and no leftover UNIQUE twin.
 * The two new unique keys are NOT in {@link ingestionSchema_ddl}: they are built with CREATE UNIQUE INDEX CONCURRENTLY
 * by {@link ensureIngestionWorkspaceKeys}, outside the schema advisory lock (a concurrent build waits for every
 * older transaction, including openers parked on that lock). `workspace_id` has been NOT NULL on every table since
 * the store was introduced, so there is no column to add or backfill.
 * Every statement is idempotent (run by `runSchemaBootstrap`, autocommitted).
 */
import type { Pool } from 'pg';

export const INGEST_TABLES = {
    sources: 'lore_ingest_sources',
    jobs: 'lore_ingest_jobs',
    pending: 'lore_ingest_pending',
    deliveries: 'lore_ingest_deliveries',
} as const;

export function ingestionSchema_ddl(): string[] {
    const { sources, jobs, pending, deliveries } = INGEST_TABLES;
    return [
        `CREATE TABLE IF NOT EXISTS ${sources} (
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    storage_ref TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (workspace_id, source_id),
    UNIQUE (workspace_id, sha256)
)`,
        // Additive: set when blob retention removed the source file's bytes (the row is kept).
        `ALTER TABLE ${sources} ADD COLUMN IF NOT EXISTS blob_purged_at TIMESTAMPTZ`,
        `CREATE TABLE IF NOT EXISTS ${jobs} (
    job_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    processor_id TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_error TEXT,
    params JSONB NOT NULL DEFAULT '{}'::jsonb,
    parent_job_id TEXT,
    remote_request_id TEXT,
    results_written_at TIMESTAMPTZ,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    UNIQUE (workspace_id, job_id)
)`,
        // Additive: claim lease for stuck-job reclaim. Null outside `running` and for rows claimed by a pre-lease build.
        `ALTER TABLE ${jobs} ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
        `CREATE INDEX IF NOT EXISTS lore_ingest_jobs_due ON ${jobs} (workspace_id, state, next_attempt_at, created_at)`,
        `CREATE INDEX IF NOT EXISTS lore_ingest_jobs_list ON ${jobs} (workspace_id, created_at, job_id)`,
        `CREATE INDEX IF NOT EXISTS lore_ingest_jobs_source ON ${jobs} (workspace_id, source_id)`,
        `CREATE TABLE IF NOT EXISTS ${pending} (
    job_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
)`,
        `CREATE INDEX IF NOT EXISTS lore_ingest_pending_ws ON ${pending} (workspace_id, created_at)`,
        `CREATE TABLE IF NOT EXISTS ${deliveries} (
    job_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (job_id, delivery_id)
)`,
        `CREATE INDEX IF NOT EXISTS lore_ingest_deliveries_seen ON ${deliveries} (workspace_id, seen_at)`,
    ];
}

/** The workspace-led unique keys the store's ON CONFLICT targets rely on. */
export const INGEST_WORKSPACE_KEYS = [
    { table: INGEST_TABLES.pending, name: 'lore_ingest_pending_ws_job_key', columns: 'workspace_id, job_id', legacyPk: 'lore_ingest_pending_pkey' },
    { table: INGEST_TABLES.deliveries, name: 'lore_ingest_deliveries_ws_job_delivery_key', columns: 'workspace_id, job_id, delivery_id', legacyPk: 'lore_ingest_deliveries_pkey' },
] as const;

/** Distinct from the schema-bootstrap (…117) and keyword-index (…118) keys. */
const INGEST_KEY_BUILD_LOCK = 7_364_920_119;
const LOCK_POLL_MS = 200;
const LOCK_DEADLINE_MS = 10 * 60_000;

/** Column names of an index key in key order (the SELECT list for an alias `i` over pg_index). */
const INDEX_COLUMNS_SQL = `(SELECT array_agg(a.attname::text ORDER BY k.ord)
      FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)`;

/**
 * True when the table has a VALID, ready, plain (no predicate, no expression) unique index over exactly these columns, in
 * this order. A PRIMARY KEY counts: after the contract step the workspace-led key IS the primary key, and the startup
 * check must not rebuild a UNIQUE constraint beside it.
 */
async function hasUniqueIndexOn(q: Pick<Pool, 'query'>, table: string, columns: readonly string[]): Promise<boolean> {
    const r = await q.query(
        `SELECT 1 FROM pg_index i
          WHERE i.indrelid = $1::regclass AND i.indisunique AND i.indisvalid AND i.indisready
            AND i.indpred IS NULL AND i.indexprs IS NULL AND ${INDEX_COLUMNS_SQL} = $2::text[]`,
        [table, [...columns]]);
    return (r.rowCount ?? 0) > 0;
}

const colsOf = (k: { columns: string }): string[] => k.columns.split(',').map((c) => c.trim());

async function keyIsReady(pool: Pick<Pool, 'query'>): Promise<boolean> {
    for (const k of INGEST_WORKSPACE_KEYS) if (!(await hasUniqueIndexOn(pool, k.table, colsOf(k)))) return false;
    return true;
}

/**
 * ensureIngestionWorkspaceKeys - build the workspace-led unique keys on lore_ingest_pending / lore_ingest_deliveries.
 *
 * Call AFTER `runSchemaBootstrap` has released the schema lock. Each key is a CREATE UNIQUE INDEX CONCURRENTLY (no write
 * lock) attached with ADD CONSTRAINT ... UNIQUE USING INDEX. Idempotent: ready keys are left alone, an INVALID leftover
 * from a cancelled build is dropped and rebuilt, and a constraint-less valid index is attached. Builders are serialized
 * by an advisory lock taken with pg_try_advisory_lock + polling (a blocking wait would sit in an open statement and a
 * concurrent build would wait for it: deadlock). Throws if the keys cannot be built, because the store's ON CONFLICT
 * targets need them.
 */
export async function ensureIngestionWorkspaceKeys(pool: Pool): Promise<void> {
    const deadline = Date.now() + LOCK_DEADLINE_MS;
    for (;;) {
        if (await keyIsReady(pool)) return;
        const client = await pool.connect();
        let locked = false;
        let broken = false;
        try {
            const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [INGEST_KEY_BUILD_LOCK]);
            locked = got.rows[0]!.ok;
            if (!locked) {
                if (Date.now() > deadline) throw new Error('ingestion workspace keys: gave up waiting for another process that is building them');
            } else {
                await client.query('SET statement_timeout = 0');
                for (const k of INGEST_WORKSPACE_KEYS) {
                    if (await hasUniqueIndexOn(client, k.table, colsOf(k))) continue; // already there (maybe as the primary key after the contract)
                    const has = await client.query<{ valid: boolean }>(
                        `SELECT i.indisvalid AND i.indisready AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`, [k.name]);
                    if (has.rows[0] && !has.rows[0].valid) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${k.name}`);
                    if (!has.rows[0] || !has.rows[0].valid) {
                        await client.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${k.name} ON ${k.table} (${k.columns})`);
                    }
                    await client.query(`DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${k.name}' AND conrelid = '${k.table}'::regclass) THEN
        ALTER TABLE ${k.table} ADD CONSTRAINT ${k.name} UNIQUE USING INDEX ${k.name};
    END IF;
END $$`);
                }
            }
        } catch (err) {
            broken = true;
            throw err;
        } finally {
            if (locked) {
                try { await client.query('RESET statement_timeout'); await client.query('SELECT pg_advisory_unlock($1)', [INGEST_KEY_BUILD_LOCK]); }
                catch { broken = true; /* a connection that may still hold the lock never goes back to the pool */ }
            }
            client.release(broken);
        }
        if (!locked) await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
}

/**
 * The workspace-led PRIMARY KEY each ingestion table ends up with after the contract step (rule R1: every primary key
 * leads with workspace_id; a table with no primary key is hash-sharded on a hidden row id and has no REPLICA IDENTITY).
 * `unique` is the expand-window UNIQUE constraint over the same columns that the promoted primary key replaces.
 */
export const INGEST_PRIMARY_KEYS = [
    { table: INGEST_TABLES.jobs, columns: 'workspace_id, job_id', pk: 'lore_ingest_jobs_pkey', index: 'lore_ingest_jobs_ws_pk_idx' },
    { table: INGEST_TABLES.pending, columns: 'workspace_id, job_id', pk: 'lore_ingest_pending_pkey', index: 'lore_ingest_pending_ws_pk_idx' },
    { table: INGEST_TABLES.deliveries, columns: 'workspace_id, job_id, delivery_id', pk: 'lore_ingest_deliveries_pkey', index: 'lore_ingest_deliveries_ws_pk_idx' },
] as const;

type Q = Pick<import('pg').PoolClient, 'query'>;

/** Name and columns of the table's current PRIMARY KEY, if it has one. */
async function currentPk(client: Q, table: string): Promise<{ name: string; columns: string[] } | undefined> {
    const r = await client.query<{ name: string; columns: string[] }>(
        `SELECT c.conname AS name,
                (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
           FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'p'`, [table]);
    return r.rows[0];
}

/**
 * CONTRACT step (never run at startup; invoke it by hand once every host runs a build that uses the workspace-led keys):
 * make the workspace-led key the PRIMARY KEY of lore_ingest_jobs / pending / deliveries, replacing the single-column legacy
 * primary key and the now-redundant UNIQUE constraint over the same columns.
 *
 * Refuses (returns the reasons, changes nothing) unless the workspace-led unique key already exists and is valid on all
 * three tables, which proves the expand step ran. Per table: (1) build `<table>_ws_pk_idx` with CREATE UNIQUE INDEX
 * CONCURRENTLY (no write lock; an INVALID leftover from a cancelled run is dropped and rebuilt; a failed build, i.e.
 * duplicate rows, drops its leftover and refuses). (2) In ONE transaction: DROP the old primary key, ADD CONSTRAINT
 * `<table>_pkey` PRIMARY KEY USING INDEX, DROP the UNIQUE constraint(s) over the same columns. The table is never left
 * without a primary key. Idempotent: a table whose primary key is already workspace-led is skipped, so a re-run is a
 * no-op and an interrupted run is finished (the transaction is atomic, so only the built index can be left over).
 * ON CONFLICT (workspace_id, ...) inference resolves to the new primary key index. A table that does not exist (ingestion never
 * opened on this database) is skipped. Needs an autocommit client.
 * `postgresBackupJobIds.ts` re-minting of restored job ids is no longer required for uniqueness (it still works).
 */
export async function dropLegacyIngestionKeys(client: Q): Promise<{ dropped: string[]; promoted: string[]; refused: string[] }> {
    const refused: string[] = [];
    const todo: Array<(typeof INGEST_PRIMARY_KEYS)[number]> = [];
    for (const t of INGEST_PRIMARY_KEYS) {
        // A database where ingestion never opened (e.g. embedded hosts that do not ingest) has no ingestion tables, so
        // there is no legacy key to drop. Skip instead of failing the whole contract on `$1::regclass`. If ingestion opens
        // later it creates the tables with both keys, and a re-run of the contract promotes them.
        const exists = await client.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t.table]);
        if (!exists.rows[0]?.ok) continue;
        const cols = colsOf(t);
        const pk = await currentPk(client, t.table);
        if (pk && pk.columns.join(',') === cols.join(',')) continue; // already contracted
        todo.push(t);
        if (!(await hasUniqueIndexOn(client, t.table, cols))) {
            const name = t.table === INGEST_TABLES.jobs ? 'lore_ingest_jobs_workspace_id_job_id_key'
                : INGEST_WORKSPACE_KEYS.find((k) => k.table === t.table)!.name;
            refused.push(`replacement unique key ${name} is missing or invalid`);
        }
    }
    if (refused.length > 0) return { dropped: [], promoted: [], refused };
    const dropped: string[] = [];
    const promoted: string[] = [];
    for (const t of todo) {
        const cols = colsOf(t);
        // (1) the index, outside any transaction
        const has = await client.query<{ valid: boolean }>(
            `SELECT i.indisvalid AND i.indisready AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`, [t.index]);
        if (has.rows[0] && !has.rows[0].valid) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${t.index}`);
        if (!has.rows[0] || !has.rows[0].valid) {
            try {
                await client.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${t.index} ON ${t.table} (${t.columns})`);
            } catch (err) {
                await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${t.index}`);
                refused.push(`${t.table}: cannot build the workspace-led primary key index: ${(err as Error).message}`);
                continue;
            }
        }
        // (2) swap in one transaction
        await client.query('BEGIN');
        try {
            const old = await currentPk(client, t.table);
            if (old) { await client.query(`ALTER TABLE ${t.table} DROP CONSTRAINT ${old.name}`); dropped.push(`${t.table}.${old.name}`); }
            await client.query(`ALTER TABLE ${t.table} ADD CONSTRAINT ${t.pk} PRIMARY KEY USING INDEX ${t.index}`);
            const dups = await client.query<{ conname: string }>(
                `SELECT c.conname FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
                  WHERE c.conrelid = $1::regclass AND c.contype = 'u' AND ${INDEX_COLUMNS_SQL} = $2::text[]`, [t.table, cols]);
            for (const d of dups.rows) { await client.query(`ALTER TABLE ${t.table} DROP CONSTRAINT ${d.conname}`); dropped.push(`${t.table}.${d.conname}`); }
            await client.query('COMMIT');
            promoted.push(`${t.table} PRIMARY KEY (${t.columns})`);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
    }
    return { dropped, promoted, refused };
}

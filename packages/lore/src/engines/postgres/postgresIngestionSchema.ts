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
 * Uniqueness the store relies on:
 *   - jobs:       PRIMARY KEY (job_id) — deterministic ids; a composite
 *                 UNIQUE (workspace_id, job_id) for tenant-scoped lookups
 *   - sources:    PRIMARY KEY (workspace_id, source_id) + UNIQUE (workspace_id, sha256)
 *   - deliveries: PRIMARY KEY (job_id, delivery_id)  (replay guard)
 *   - pending:    PRIMARY KEY (job_id)
 * Every statement is idempotent (run by `runSchemaBootstrap`, autocommitted).
 */

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

/**
 * migration/store.ts — SQLite-backed migrations table for Sprint H.
 *
 * DECISION (audit Section 5; H1 scope guard): the migrations table
 * lives in its own `migrations.sqlite` file under <loreDir>, NOT
 * co-located in outbox.sqlite. Rationale:
 *
 *   1. H-D9 regression sentinel greps the outbox sqliteStore for the
 *      unchanged `CREATE TABLE IF NOT EXISTS outbox_entries` DDL. Adding
 *      a co-located CREATE TABLE migrations to that file risks
 *      accidental edits that drift the outbox schema; isolation keeps
 *      H-D9 trivially green throughout Sprint H.
 *   2. Independent backup/restore lifecycle. The migrations table is
 *      the source of truth for "what schema does this lore home
 *      currently have applied" — operators may want to ship/restore it
 *      separately from the outbox (which is short-lived ephemeral
 *      replication state).
 *   3. The outbox file is hot — every write touches it. Migrations
 *      sees ~1 write per schema change. Sharing a WAL on a hot file
 *      buys nothing and complicates concurrency reasoning.
 *
 * Cost: one extra small SQLite file under <loreDir>/migrations.sqlite.
 * Trade accepted.
 *
 * Schema (CREATE TABLE migrations) intentionally encodes ROLLED_BACK as
 * a terminal state so the H-D7 gate test (H3) finds it as a string
 * literal in this source file — see the schema grep in
 * test/sprint-H-online-migration-property.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';
import type {
    MigrationKind,
    MigrationPhase,
    MigrationRow,
    MigrationStatus,
    SubstrateName,
} from './types.js';

const SQLITE_FILE = 'migrations.sqlite';

/**
 * Migrations table DDL. CREATE TABLE migrations + the literal
 * 'rolled_back' status are both required by the Sprint H gate test
 * (H-D7 in H3). Keep both present even when fields evolve.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS migrations (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  substrate   TEXT NOT NULL,
  target      TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  phase       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'running', 'applied', 'failed', 'rolled_back')),
  paramsJson  TEXT NOT NULL,
  appliedAt   TEXT,
  error       TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migrations_status ON migrations(status);
CREATE INDEX IF NOT EXISTS idx_migrations_substrate_target ON migrations(substrate, target);
CREATE INDEX IF NOT EXISTS idx_migrations_workspace ON migrations(workspace);
`;

interface RawRow {
    id: string;
    kind: string;
    substrate: string;
    target: string;
    workspace: string;
    phase: string;
    status: string;
    paramsJson: string;
    appliedAt: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

function rowToMigration(r: RawRow): MigrationRow {
    return {
        id: r.id,
        kind: r.kind as MigrationKind,
        substrate: r.substrate as SubstrateName,
        target: r.target,
        workspace: r.workspace,
        phase: r.phase as MigrationPhase,
        status: r.status as MigrationStatus,
        paramsJson: r.paramsJson,
        appliedAt: r.appliedAt ?? undefined,
        error: r.error ?? undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    };
}

export interface MigrationsStoreInsertInput {
    id: string;
    kind: MigrationKind;
    substrate: SubstrateName;
    target: string;
    workspace: string;
    phase: MigrationPhase;
    paramsJson: string;
}

export interface MigrationsStoreUpdateInput {
    status: MigrationStatus;
    phase?: MigrationPhase;
    error?: string;
    appliedAt?: string;
}

export class MigrationsStore {
    private readonly db: DatabaseType;
    private readonly filePath: string;

    constructor(loreDir: string) {
        if (!fs.existsSync(loreDir)) fs.mkdirSync(loreDir, { recursive: true });
        this.filePath = path.join(loreDir, SQLITE_FILE);
        this.db = new Database(this.filePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(SCHEMA_SQL);
    }

    get path(): string {
        return this.filePath;
    }

    insertPending(input: MigrationsStoreInsertInput): void {
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT INTO migrations
              (id, kind, substrate, target, workspace, phase, status, paramsJson, createdAt, updatedAt)
            VALUES
              (@id, @kind, @substrate, @target, @workspace, @phase, 'pending', @paramsJson, @createdAt, @updatedAt)
        `).run({ ...input, createdAt: now, updatedAt: now });
    }

    update(id: string, input: MigrationsStoreUpdateInput): void {
        const now = new Date().toISOString();
        const existing = this.get(id);
        if (!existing) throw new Error(`migrations: cannot update unknown id '${id}'`);
        this.db.prepare(`
            UPDATE migrations
            SET status     = @status,
                phase      = COALESCE(@phase, phase),
                error      = @error,
                appliedAt  = COALESCE(@appliedAt, appliedAt),
                updatedAt  = @updatedAt
            WHERE id = @id
        `).run({
            id,
            status: input.status,
            phase: input.phase ?? null,
            error: input.error ?? null,
            appliedAt: input.appliedAt ?? null,
            updatedAt: now,
        });
    }

    get(id: string): MigrationRow | undefined {
        const row = this.db.prepare(`SELECT * FROM migrations WHERE id = ?`).get(id) as RawRow | undefined;
        return row ? rowToMigration(row) : undefined;
    }

    list(opts: { status?: MigrationStatus; substrate?: SubstrateName; workspace?: string; limit?: number } = {}): MigrationRow[] {
        const where: string[] = [];
        const params: Record<string, unknown> = {};
        if (opts.status) { where.push('status = @status'); params['status'] = opts.status; }
        if (opts.substrate) { where.push('substrate = @substrate'); params['substrate'] = opts.substrate; }
        if (opts.workspace) { where.push('workspace = @workspace'); params['workspace'] = opts.workspace; }
        const limit = opts.limit ?? 200;
        const sql = `SELECT * FROM migrations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY createdAt DESC LIMIT ${limit}`;
        const rows = this.db.prepare(sql).all(params) as RawRow[];
        return rows.map(rowToMigration);
    }

    close(): void {
        this.db.close();
    }
}

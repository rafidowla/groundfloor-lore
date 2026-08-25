/**
 * migration/adapters/sqliteMigrationAdapter.ts — SQLite adapter.
 *
 * Implements the SubstrateMigrationAdapter contract for an arbitrary
 * better-sqlite3 Database handle. SQLite supports:
 *
 *   - ALTER TABLE ADD COLUMN  (online, native)
 *   - CREATE TABLE IF NOT EXISTS  (online, native)
 *   - CREATE INDEX IF NOT EXISTS  (online — readers see the index
 *     after CREATE completes; writers block briefly on the metadata
 *     update but in-flight transactions are not killed)
 *   - DROP COLUMN  (>= SQLite 3.35; native, online for most rows)
 *
 * Reverse paths:
 *   - reverseAddColumn → SQLite ALTER TABLE DROP COLUMN (3.35+);
 *     if the running SQLite is older, returns ok=false with reason
 *     so the coordinator surfaces the limitation upward.
 *   - reverseAddTable → DROP TABLE IF EXISTS
 *   - reverseAddIndex → DROP INDEX IF EXISTS
 *
 * The adapter does NOT own the SQLite handle — callers pass it in.
 * Today the only on-disk SQLite the daemon owns is load_jobs.sqlite
 * (Sprint Z), but this adapter is connection-agnostic so it works for
 * outbox.sqlite OR migrations.sqlite OR any future SQLite the daemon
 * spins up. H1 unit tests construct adapters against ephemeral
 * in-memory DBs to exercise every verb without touching real state.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type {
    AdapterCapabilities,
    AdapterOpResult,
    AddColumnSpec,
    AddIndexSpec,
    AddTableSpec,
    DropOldSpec,
    MigrateDataSpec,
    PrepareDropColumnSpec,
    PrepareRenameSpec,
    PrepareTypeChangeSpec,
    SubstrateMigrationAdapter,
    SubstrateName,
} from '../types.js';
import { assertSafeDdlFragment } from './ddlSafety.js';

function quoteIdent(name: string): string {
    // Defense-in-depth: SQLite identifiers go in double-quotes; embedded
    // quotes are doubled. Reject anything with backticks or semicolons
    // outright since those are never valid identifier chars and the
    // most likely sign of a spec-injection attempt.
    if (/[`;\n]/.test(name)) throw new Error(`sqlite migration: refusing unsafe identifier '${name}'`);
    return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * Probe the SQLite ALTER TABLE DROP COLUMN feature. SQLite >= 3.35 (2021)
 * supports it natively. If unavailable, reverseAddColumn returns ok=false
 * with reason='drop-column-not-supported' so the coordinator can degrade
 * gracefully.
 */
function detectDropColumnSupport(db: DatabaseType): boolean {
    try {
        const row = db.prepare(`SELECT sqlite_version() AS v`).get() as { v: string };
        const [maj, min] = row.v.split('.').map((x) => parseInt(x, 10));
        if (maj > 3) return true;
        if (maj === 3 && min >= 35) return true;
        return false;
    } catch {
        return false;
    }
}

export class SqliteMigrationAdapter implements SubstrateMigrationAdapter {
    readonly substrate: SubstrateName = 'sqlite';
    private readonly db: DatabaseType;
    private readonly dropColumnSupported: boolean;

    constructor(db: DatabaseType) {
        this.db = db;
        this.dropColumnSupported = detectDropColumnSupport(db);
    }

    capabilities(): AdapterCapabilities {
        return {
            addColumn: true,
            addTable: true,
            addIndex: true,
            renameColumn: false, // decomposed via expand/migrate/contract (H2)
            changeType: false,   // SQLite has no ALTER COLUMN TYPE
            dropColumn: this.dropColumnSupported,
        };
    }

    async addColumn(spec: AddColumnSpec): Promise<AdapterOpResult> {
        try {
            // SQLite has no IF NOT EXISTS for ALTER TABLE ADD COLUMN —
            // probe pragma_table_info first so the operation is idempotent.
            const colName = spec.column.trim().split(/\s+/)[0];
            const present = this.columnExists(spec.table, colName);
            if (present) return { ok: true, reason: 'already-present' };
            this.db.exec(`ALTER TABLE ${quoteIdent(spec.table)} ADD COLUMN ${assertSafeDdlFragment(spec.column, 'sqlite addColumn')}`);
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `sqlite-add-column-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    async addTable(spec: AddTableSpec): Promise<AdapterOpResult> {
        try {
            this.db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(spec.table)} (${assertSafeDdlFragment(spec.columns, 'sqlite addTable')})`);
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `sqlite-add-table-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    async addIndex(spec: AddIndexSpec): Promise<AdapterOpResult> {
        try {
            // CREATE INDEX in SQLite is fast + non-locking for index
            // builds on small tables; on larger tables it acquires a
            // brief write lock but does not block reads.
            this.db.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdent(spec.indexName)} ON ${quoteIdent(spec.table)}(${assertSafeDdlFragment(spec.columns, 'sqlite addIndex')})`);
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `sqlite-add-index-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    async reverseAddColumn(spec: AddColumnSpec): Promise<AdapterOpResult> {
        if (!this.dropColumnSupported) {
            return { ok: false, reason: 'drop-column-not-supported', detail: { hint: 'sqlite<3.35; expand/migrate/contract rebuild needed (H2)' } };
        }
        try {
            const colName = spec.column.trim().split(/\s+/)[0];
            if (!this.columnExists(spec.table, colName)) return { ok: true, reason: 'already-absent' };
            this.db.exec(`ALTER TABLE ${quoteIdent(spec.table)} DROP COLUMN ${quoteIdent(colName)}`);
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `sqlite-drop-column-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    async reverseAddTable(spec: AddTableSpec): Promise<AdapterOpResult> {
        try {
            this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(spec.table)}`);
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `sqlite-drop-table-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    async reverseAddIndex(spec: AddIndexSpec): Promise<AdapterOpResult> {
        try {
            this.db.exec(`DROP INDEX IF EXISTS ${quoteIdent(spec.indexName)}`);
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `sqlite-drop-index-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    // ----- destructive verbs — H2 wires runtime. H1 ships native DROP COLUMN
    //       so operators can already script it via the adapter directly. -----

    async dropColumn(spec: DropOldSpec): Promise<AdapterOpResult> {
        if (!this.dropColumnSupported) {
            return { ok: false, reason: 'drop-column-not-supported', detail: { hint: 'sqlite<3.35; expand/migrate/contract rebuild needed (H2)' } };
        }
        try {
            if (!this.columnExists(spec.table, spec.column)) return { ok: true, reason: 'already-absent' };
            this.db.exec(`ALTER TABLE ${quoteIdent(spec.table)} DROP COLUMN ${quoteIdent(spec.column)}`);
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `sqlite-drop-column-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    // ----- H2 expand/migrate/contract verbs -----

    /** Phase 1 EXPAND for rename — add the new column with the same type
     *  as the source. Idempotent: a second call returns ok=true with
     *  reason='already-present'. */
    async prepareRename(spec: PrepareRenameSpec): Promise<AdapterOpResult> {
        try {
            if (this.columnExists(spec.table, spec.toColumn)) return { ok: true, reason: 'already-present' };
            this.db.exec(`ALTER TABLE ${quoteIdent(spec.table)} ADD COLUMN ${assertSafeDdlFragment(spec.columnDdl, 'sqlite prepareExpand')}`);
            return { ok: true, detail: { phase: 'expand', verb: 'prepareRename' } };
        } catch (err) {
            return { ok: false, reason: `sqlite-prepare-rename-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    /** Phase 1 EXPAND for type-change — add a replacement column with the
     *  new type. Identical mechanics to prepareRename; surfaced separately
     *  so the coordinator can distinguish the operator intent in the
     *  migrations table + outbox payload. */
    async prepareTypeChange(spec: PrepareTypeChangeSpec): Promise<AdapterOpResult> {
        try {
            if (this.columnExists(spec.table, spec.toColumn)) return { ok: true, reason: 'already-present' };
            this.db.exec(`ALTER TABLE ${quoteIdent(spec.table)} ADD COLUMN ${assertSafeDdlFragment(spec.columnDdl, 'sqlite prepareExpand')}`);
            return { ok: true, detail: { phase: 'expand', verb: 'prepareTypeChange' } };
        } catch (err) {
            return { ok: false, reason: `sqlite-prepare-type-change-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    /** Phase 1 EXPAND for drop — no-op (column stays until Phase 3).
     *  The coordinator still records this so dual-write logic can skip
     *  the column even though it still exists on the substrate. */
    async prepareDropColumn(spec: PrepareDropColumnSpec): Promise<AdapterOpResult> {
        // No substrate change; column drops in Phase 3 (contract).
        if (!this.columnExists(spec.table, spec.column)) return { ok: true, reason: 'already-absent' };
        return { ok: true, detail: { phase: 'expand', verb: 'prepareDropColumn', noop: true } };
    }

    /** Phase 2 MIGRATE — batched UPDATE copying fromColumn → toColumn.
     *  Checkpoints per batch (Sprint Z3 pattern): if interrupted, a
     *  follow-up call resumes by only updating rows where toColumn IS NULL.
     *
     *  4.4/cluster-4 low (2026-08-18) — the WHERE used to carry
     *  `${from} IS NOT NULL AND ...`, which excluded NULL-valued source
     *  rows from the backfill entirely, so a rename silently replaced
     *  NULLs with the new column's DEFAULT instead of copying NULL
     *  through. The predicate is now the null-safe inequality
     *  `${to} IS NOT ${from}` alone: it selects exactly the rows whose
     *  target differs from the source (including from=NULL,to=DEFAULT),
     *  and — because SQLite's IS NOT is null-safe — it stops selecting a
     *  row once copied, so the batch loop still converges (a bare
     *  `to IS NULL` disjunct would re-match NULL→NULL rows forever). */
    async migrateData(spec: MigrateDataSpec): Promise<AdapterOpResult> {
        const batchSize = spec.batchSize ?? 500;
        let total = 0;
        let batches = 0;
        const t = quoteIdent(spec.table);
        const from = quoteIdent(spec.fromColumn);
        const to = quoteIdent(spec.toColumn);
        try {
            if (!this.columnExists(spec.table, spec.fromColumn)) {
                return { ok: false, reason: 'sqlite-migrate-data-failed:source-column-missing' };
            }
            if (!this.columnExists(spec.table, spec.toColumn)) {
                return { ok: false, reason: 'sqlite-migrate-data-failed:target-column-missing' };
            }
            // Backfill rows where the target differs from the source (or
            // is NULL). The `${to} IS NOT ${from}` form catches both the
            // NULL case and the "DEFAULT 0 but source is 7" case where
            // ADD COLUMN populated the new column with a placeholder.
            const updateSql = `UPDATE ${t} SET ${to} = ${from} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${to} IS NOT ${from} LIMIT ${batchSize})`;
            const stmt = this.db.prepare(updateSql);
            // Loop until no rows updated.
            for (;;) {
                const info = stmt.run();
                batches++;
                if (info.changes === 0) break;
                total += info.changes;
                // Safety: cap iterations to avoid runaway loops.
                if (batches > 1_000_000) {
                    return { ok: false, reason: 'sqlite-migrate-data-failed:batch-cap-exceeded', detail: { batches, total } };
                }
            }
            return { ok: true, detail: { phase: 'migrate', rowsCopied: total, batches } };
        } catch (err) {
            return { ok: false, reason: `sqlite-migrate-data-failed:${(err as Error).message.slice(0, 120)}`, detail: { batches, total } };
        }
    }

    /** Phase 3 CONTRACT, atomic form (4.4, 2026-08-18) — the catch-up
     *  backfill AND the drop of the old column in ONE transaction.
     *
     *  Why: advance() used to run migrateData once (Phase 2) and then, at
     *  Phase 3, drop the old column without re-copying — any UPDATE or
     *  INSERT that landed in the dual-write window after the Phase-2
     *  backfill was silently discarded when the old column dropped. A
     *  single BEGIN IMMEDIATE transaction closes that window on SQLite:
     *  concurrent writers (same or other processes) block on the write
     *  lock until COMMIT, then see the post-contract schema and fail
     *  loudly ("no such column") instead of silently writing a doomed
     *  value. Reuses migrateData's null-safe predicate so NULL source
     *  values copy through as NULL (cluster-4 low). */
    async contract(spec: { table: string; fromColumn: string; toColumn: string; column: string; batchSize?: number }): Promise<AdapterOpResult> {
        const batchSize = spec.batchSize ?? 500;
        const t = quoteIdent(spec.table);
        const from = quoteIdent(spec.fromColumn);
        const to = quoteIdent(spec.toColumn);
        const drop = quoteIdent(spec.column);
        let total = 0;
        try {
            if (!this.columnExists(spec.table, spec.fromColumn)) {
                return { ok: false, reason: 'sqlite-contract-failed:source-column-missing' };
            }
            if (!this.columnExists(spec.table, spec.toColumn)) {
                return { ok: false, reason: 'sqlite-contract-failed:target-column-missing' };
            }
            this.db.exec('BEGIN IMMEDIATE');
            try {
                const updateSql = `UPDATE ${t} SET ${to} = ${from} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${to} IS NOT ${from} LIMIT ${batchSize})`;
                const stmt = this.db.prepare(updateSql);
                for (;;) {
                    const info = stmt.run();
                    if (info.changes === 0) break;
                    total += info.changes;
                }
                if (this.columnExists(spec.table, spec.column)) {
                    if (this.dropColumnSupported) {
                        this.db.exec(`ALTER TABLE ${t} DROP COLUMN ${drop}`);
                    } else {
                        // sqlite < 3.35: table-rebuild inside the same tx.
                        this.rebuildTableDroppingColumn(spec.table, spec.column);
                    }
                }
                this.db.exec('COMMIT');
            } catch (innerErr) {
                this.db.exec('ROLLBACK');
                throw innerErr;
            }
            return { ok: true, detail: { phase: 'contract', mechanism: 'atomic-catchup-drop', rowsCopiedLate: total } };
        } catch (err) {
            return { ok: false, reason: `sqlite-contract-failed:${(err as Error).message.slice(0, 120)}`, detail: { rowsCopiedLate: total } };
        }
    }

    /** Phase 3 CONTRACT — drop the old column. On SQLite >= 3.35 uses
     *  native DROP COLUMN; older builds get a table-rebuild fallback. */
    async dropOld(spec: DropOldSpec): Promise<AdapterOpResult> {
        try {
            if (!this.columnExists(spec.table, spec.column)) return { ok: true, reason: 'already-absent' };
            if (this.dropColumnSupported) {
                this.db.exec(`ALTER TABLE ${quoteIdent(spec.table)} DROP COLUMN ${quoteIdent(spec.column)}`);
                return { ok: true, detail: { phase: 'contract', mechanism: 'native-drop-column' } };
            }
            // Fallback: table-rebuild. Get current schema sans the column,
            // copy data into new table, swap. SQLite < 3.35 only.
            this.db.exec('BEGIN');
            try {
                this.rebuildTableDroppingColumn(spec.table, spec.column);
                this.db.exec('COMMIT');
            } catch (innerErr) {
                this.db.exec('ROLLBACK');
                throw innerErr;
            }
            return { ok: true, detail: { phase: 'contract', mechanism: 'table-rebuild' } };
        } catch (err) {
            return { ok: false, reason: `sqlite-drop-old-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    /** Create-and-swap rebuild dropping one column. MUST be called inside
     *  an open transaction (owns neither BEGIN nor COMMIT) so dropOld and
     *  the atomic contract() verb share the mechanics. */
    private rebuildTableDroppingColumn(table: string, column: string): void {
        const cols = this.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
        const keep = cols.filter((c) => c.name !== column);
        if (keep.length === cols.length) return;
        const tmp = `${table}__rebuild_${Date.now()}`;
        const colDefs = keep.map((c) => {
            let def = `${quoteIdent(c.name)} ${c.type}`;
            if (c.notnull) def += ' NOT NULL';
            if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT ${c.dflt_value}`;
            if (c.pk) def += ' PRIMARY KEY';
            return def;
        }).join(', ');
        const colList = keep.map((c) => quoteIdent(c.name)).join(', ');
        this.db.exec(`CREATE TABLE ${quoteIdent(tmp)} (${colDefs})`);
        this.db.exec(`INSERT INTO ${quoteIdent(tmp)} (${colList}) SELECT ${colList} FROM ${quoteIdent(table)}`);
        this.db.exec(`DROP TABLE ${quoteIdent(table)}`);
        this.db.exec(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(table)}`);
    }

    private columnExists(table: string, column: string): boolean {
        try {
            const rows = this.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>;
            return rows.some((r) => r.name === column);
        } catch {
            return false;
        }
    }
}

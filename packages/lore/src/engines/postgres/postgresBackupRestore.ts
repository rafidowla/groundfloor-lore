/**
 * postgresBackupRestore.ts — restore a workspace bundle into one workspace.
 *
 * ORDER OF OPERATIONS (nothing is written before step 2 succeeds):
 *   1. outbox lane drained (refuse otherwise);
 *   2. bundle verified end to end, offline (`bundle_hash_mismatch`, zero writes);
 *   3. ONE transaction: lock the target workspace, check the bundle's tables and
 *      column types against the live schema, refuse a non-empty target unless
 *      `force` (then clear it, in dependency order), provision partitions,
 *      choose surrogate-id shifts, load, read every table back and compare
 *      counts AND content checksums with the manifest, re-seat sequences, COMMIT.
 *
 * ONE TRANSACTION, ALWAYS. Rows are loaded in batches but committed once, so a
 * failure anywhere (constraint, disk, verification) leaves the target exactly
 * as it was. Postgres handles very large transactions (they cost WAL and
 * time, not client memory), and the blast radius is a single workspace's rows.
 * A resumable multi-commit mode is deliberately NOT built: it would leave a
 * half-restored workspace visible to readers, which is the failure this
 * module exists to avoid. If a workspace ever outgrows one transaction, add
 * resumability then, with the same verify-then-commit contract.
 *
 * SURROGATE IDS. Identity/serial columns are global to the database, not per
 * workspace, so restoring next to the source (or any workspace sharing the
 * server) can collide. After the target is cleared, each identity column's
 * bundle range [min,max] is tested against the live table: no overlap keeps
 * the original ids (disaster recovery restores byte-for-byte); an overlap
 * shifts the WHOLE column by one constant offset placing the restored ids
 * above both the table's current max and the sequence. Every column that
 * references that id (declared FOREIGN KEY, or a `lore:references` column
 * comment) is shifted by the same offset, so references stay consistent. The
 * read-back verification undoes the shift, so it proves content equality
 * including the references. Sequences are then moved to at least max(id).
 *
 * THE TARGET MUST BE QUIESCED: the transaction is READ COMMITTED with a
 * per-workspace advisory lock, which serializes restores but does not stop an
 * application from writing into the workspace while it is being replaced.
 */

import type { Pool, PoolClient } from 'pg';
import {
    BACKUP_SESSION_SETTINGS, discoverWorkspaceSchema, loadOrder, quoteIdent, quoteLiteral, WORKSPACE_COLUMN,
    type BackupTable,
} from './postgresBackupDiscovery.js';
import {
    BundleHashMismatchError, bundleRows, RowChecksum, rowLine, verifyBundle,
    type BundleHeader, type BundleTrailer,
} from './postgresBackupBundle.js';
import { streamWorkspaceRows } from './postgresBackupExport.js';
import { ensureWorkspacePartition, type PartitionProvisioner } from './postgresWorkspacePartitions.js';
import {
    BUNDLE_HASH_MISMATCH, LogicalBackupError, OUTBOX_NOT_DRAINED, RESTORE_TARGET_NOT_EMPTY, SCHEMA_MISMATCH,
    VERIFICATION_FAILED, type LogicalRestoreSummary,
} from '../workspaceLogicalBackup.js';

export interface RestoreOptions {
    bundlePath: string;
    targetWorkspaceId: string;
    schema?: string;
    force?: boolean;
    /** Rows per INSERT. Default 500. */
    batchRows?: number;
    outboxDepth?: () => Promise<number>;
    /** Replace the default per-workspace partition provisioning. */
    provision?: PartitionProvisioner;
    /** TEST SEAM: awaited after each INSERT batch, inside the restore transaction. */
    afterBatch?: (table: string, rowsSoFar: number) => Promise<void>;
}

interface TablePlan {
    index: number;            // position in the bundle
    target: BackupTable;      // live table, with `columns` narrowed to the bundle's columns (bundle order)
    remap: Map<string, bigint>; // column -> shift (only non-zero)
}

/** Fit the bundle's tables to the live schema, or explain exactly what does not fit. */
function planTables(header: BundleHeader, live: Map<string, BackupTable>): { table: BackupTable }[] {
    const problems: string[] = [];
    const out: { table: BackupTable }[] = [];
    for (const spec of header.tables) {
        const t = live.get(spec.name);
        if (!t) { problems.push(`table ${spec.name} is not in the target schema (or has no ${WORKSPACE_COLUMN} column)`); continue; }
        const byName = new Map(t.columns.map((c) => [c.name, c] as const));
        const cols: BackupTable['columns'] = [];
        for (const c of spec.columns) {
            const live1 = byName.get(c.name);
            if (!live1) { problems.push(`${spec.name}.${c.name} (${c.type}) is not in the target schema`); continue; }
            if (live1.type !== c.type) problems.push(`${spec.name}.${c.name} is ${c.type} in the bundle but ${live1.type} in the target`);
            cols.push(live1);
        }
        const inBundle = new Set(spec.columns.map((c) => c.name));
        for (const c of t.columns) {
            if (!inBundle.has(c.name) && c.notNull && !c.hasDefault) {
                problems.push(`${spec.name}.${c.name} is NOT NULL with no default in the target but absent from the bundle`);
            }
        }
        out.push({ table: { ...t, columns: cols } });
    }
    if (problems.length > 0) {
        throw new LogicalBackupError(SCHEMA_MISMATCH, `bundle does not fit the target schema; nothing was written:\n  - ${problems.join('\n  - ')}`);
    }
    return out;
}

/** Number as exact decimal text -> bigint, refusing anything that is not an integer. */
function big(text: string): bigint {
    if (!/^-?\d+$/.test(text)) throw new Error(`not an integer: ${text}`);
    return BigInt(text);
}

async function countWorkspaceRows(client: PoolClient, t: BackupTable, lit: string): Promise<number> {
    const r = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${t.qualified} WHERE ${quoteIdent(WORKSPACE_COLUMN)} = ${lit}`);
    return Number(r.rows[0]!.n);
}

/** Decide, per identity column, the constant shift that keeps restored ids clear of everything already there. */
async function chooseIdShifts(
    client: PoolClient, plans: { table: BackupTable }[], trailer: BundleTrailer, header: BundleHeader,
): Promise<Map<string, Map<string, bigint>>> {
    const shifts = new Map<string, bigint>(); // "table.column" -> shift
    for (let i = 0; i < plans.length; i++) {
        const t = plans[i]!.table;
        for (const col of header.tables[i]!.identityColumns) {
            const range = trailer.tables[i]!.identityRanges[col];
            if (!range || !t.identityColumns.includes(col)) continue;
            const q = quoteIdent(col);
            const min = big(range.min);
            const max = big(range.max);
            const hit = await client.query(`SELECT 1 FROM ${t.qualified} WHERE ${q} BETWEEN ${min} AND ${max} LIMIT 1`);
            if ((hit.rowCount ?? 0) === 0) continue; // original ids are free: keep them
            const cur = await currentIdCeiling(client, t, col);
            shifts.set(`${t.name}.${col}`, cur + 1n - min);
        }
    }
    // Columns that reference a shifted id move with it.
    const perTable = new Map<string, Map<string, bigint>>();
    const put = (table: string, col: string, by: bigint): void => {
        const m = perTable.get(table) ?? new Map<string, bigint>();
        m.set(col, by);
        perTable.set(table, m);
    };
    for (const [key, by] of shifts) { const [tn, col] = key.split('.') as [string, string]; put(tn, col, by); }
    for (const spec of header.tables) {
        for (const ref of spec.references) {
            const by = shifts.get(`${ref.refTable}.${ref.refColumn}`);
            if (by !== undefined) put(spec.name, ref.column, by);
        }
    }
    return perTable;
}

/**
 * The sequence that feeds an identity / serial column, or null. `pg_get_serial_sequence`
 * only sees identity columns and sequences OWNED BY the column; a column defaulted from a
 * free-standing sequence (`DEFAULT nextval('verbatim_row_seq')`, the vector lane's
 * `verbatim.row_id`) is found through the dependency its default expression records.
 */
async function sequenceOf(client: PoolClient, qualified: string, col: string): Promise<string | null> {
    const owned = (await client.query<{ s: string | null }>(`SELECT pg_get_serial_sequence($1, $2) AS s`, [qualified, col])).rows[0]?.s;
    if (owned) return owned;
    const dep = await client.query<{ s: string }>(
        `SELECT d.refobjid::regclass::text AS s
           FROM pg_attrdef ad
           JOIN pg_depend d ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid AND d.refclassid = 'pg_class'::regclass
           JOIN pg_class sc ON sc.oid = d.refobjid AND sc.relkind = 'S'
          WHERE ad.adrelid = $1::regclass
            AND ad.adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)
          LIMIT 1`,
        [qualified, col],
    );
    return dep.rows[0]?.s ?? null;
}

/** Highest id in use or already handed out by the column's sequence. */
async function currentIdCeiling(client: PoolClient, t: BackupTable, col: string): Promise<bigint> {
    const mx = await client.query<{ m: string }>(`SELECT COALESCE(max(${quoteIdent(col)}), 0)::text AS m FROM ${t.qualified}`);
    let ceiling = big(mx.rows[0]!.m);
    const seqName = await sequenceOf(client, t.qualified, col);
    if (seqName) {
        const lv = await client.query<{ v: string | null }>(
            `SELECT s.last_value::text AS v FROM pg_sequences s JOIN pg_class c ON c.relname = s.sequencename
               JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname WHERE c.oid = $1::regclass`,
            [seqName],
        );
        const v = lv.rows[0]?.v;
        if (v) { const b = big(v); if (b > ceiling) ceiling = b; }
    }
    return ceiling;
}

function insertSql(plan: TablePlan): string {
    const t = plan.target;
    const cols = [quoteIdent(WORKSPACE_COLUMN), ...t.columns.map((c) => quoteIdent(c.name))].join(', ');
    const values = [
        `$2::${t.workspaceIdType}`,
        ...t.columns.map((c, j) => {
            const by = plan.remap.get(c.name);
            const raw = `(u.r->>${j})`;
            return by !== undefined && by !== 0n ? `(${raw}::bigint + ${by.toString()})::${c.type}` : `${raw}::${c.type}`;
        }),
    ].join(', ');
    const override = t.identityColumns.length > 0 ? ' OVERRIDING SYSTEM VALUE' : '';
    return `INSERT INTO ${t.qualified} (${cols})${override} SELECT ${values} FROM jsonb_array_elements($1::jsonb) AS u(r)`;
}

export async function restoreWorkspaceBundle(pool: Pool, opts: RestoreOptions): Promise<LogicalRestoreSummary> {
    const startedAt = Date.now();
    const target = opts.targetWorkspaceId;
    if (typeof target !== 'string' || target.trim() === '') throw new LogicalBackupError('invalid_workspace', 'restore: targetWorkspaceId must be a non-empty string', 400);
    if (opts.outboxDepth) {
        const depth = await opts.outboxDepth();
        if (depth > 0) throw new LogicalBackupError(OUTBOX_NOT_DRAINED, `workspace '${target}' has ${depth} un-drained outbox rows; drain before restore`);
    }
    let header: BundleHeader;
    let trailer: BundleTrailer;
    try {
        ({ header, trailer } = await verifyBundle(opts.bundlePath));
    } catch (err) {
        if (err instanceof BundleHashMismatchError) {
            throw new LogicalBackupError(BUNDLE_HASH_MISMATCH, `restore bundle failed verification; zero writes applied: ${err.message}`);
        }
        throw err;
    }
    const batchRows = opts.batchRows ?? 500;
    const warnings = header.excluded.map((e) => `bundle did not carry table '${e.table}': ${e.reason}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const s of BACKUP_SESSION_SETTINGS) await client.query(s);
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`lore-pg-restore:${target}`]);
        const lit = (await client.query<{ l: string }>('SELECT quote_literal($1::text) AS l', [target])).rows[0]!.l;

        const schema = await discoverWorkspaceSchema(client, opts.schema ?? (header.schema === 'public' ? undefined : header.schema));
        const live = new Map(schema.tables.map((t) => [t.name, t] as const));
        const fitted = planTables(header, live);

        // Non-empty check spans EVERY workspace table, not just the bundle's: a table added after the
        // backup still holds this workspace's rows and must not be left behind a "restored" workspace.
        let existing = 0;
        const counts = new Map<string, number>();
        for (const t of schema.tables) { const n = await countWorkspaceRows(client, t, lit); counts.set(t.name, n); existing += n; }
        if (existing > 0 && !opts.force) {
            throw new LogicalBackupError(RESTORE_TARGET_NOT_EMPTY, `target workspace '${target}' already holds ${existing} row(s); pass force to restore over it`);
        }
        let cleared = 0;
        if (existing > 0) {
            for (const t of loadOrder(schema.tables).reverse()) {
                if ((counts.get(t.name) ?? 0) === 0) continue;
                const r = await client.query(`DELETE FROM ${t.qualified} WHERE ${quoteIdent(WORKSPACE_COLUMN)} = ${lit}`);
                cleared += r.rowCount ?? 0;
            }
        }

        const provision = opts.provision ?? ensureWorkspacePartition;
        for (const { table } of fitted) if (table.partitioned) await provision(client, table, target);

        const shifts = await chooseIdShifts(client, fitted, trailer, header);
        const plans: TablePlan[] = fitted.map(({ table }, index) => ({ index, target: table, remap: shifts.get(table.name) ?? new Map() }));

        // Dependency order for loading; the bundle is normally already in it.
        const order = loadOrder(plans.map((p) => p.target)).map((t) => plans.findIndex((p) => p.target.name === t.name));
        const bundleInOrder = order.every((v, i) => v === i);
        const sqls = plans.map(insertSql);
        const loaded = plans.map(() => 0);

        const loadFrom = async (rows: AsyncIterable<{ table: number; values: (string | null)[] }>): Promise<void> => {
            let curTable = -1;
            let batch: (string | null)[][] = [];
            let chars = 0;
            const flush = async (): Promise<void> => {
                if (batch.length === 0) return;
                await client.query(sqls[curTable]!, [JSON.stringify(batch), target]);
                loaded[curTable]! += batch.length;
                if (opts.afterBatch) await opts.afterBatch(plans[curTable]!.target.name, loaded[curTable]!);
                batch = [];
                chars = 0;
            };
            for await (const row of rows) {
                if (row.table !== curTable) { await flush(); curTable = row.table; }
                batch.push(row.values);
                chars += row.values.reduce((a, v) => a + (v === null ? 4 : v.length), 0);
                if (batch.length >= batchRows || chars > 4_000_000) await flush();
            }
            await flush();
        };
        if (bundleInOrder) {
            await loadFrom(bundleRows(opts.bundlePath));
        } else {
            // Bundle order violates the live schema's dependencies: one filtered pass per table, in the right order.
            for (const idx of order) {
                await loadFrom((async function* () { for await (const r of bundleRows(opts.bundlePath)) if (r.table === idx) yield r; })());
            }
        }

        // Read every table back, undo the id shifts, and compare with the manifest.
        for (const plan of plans) {
            const want = trailer.tables[plan.index]!;
            const sum = new RowChecksum();
            const n = await streamWorkspaceRows(client, plan.target, target, 2000, (values) => sum.add(rowLine(plan.index, values)), { unmap: plan.remap });
            if (n !== want.rowCount) {
                throw new LogicalBackupError(VERIFICATION_FAILED, `table ${want.name}: restored ${n} row(s) but the manifest says ${want.rowCount}; restore rolled back`, 500);
            }
            if (sum.hex() !== want.checksum) {
                throw new LogicalBackupError(VERIFICATION_FAILED, `table ${want.name}: restored content does not match the manifest checksum; restore rolled back`, 500);
            }
        }

        // Leave every sequence at or past the highest id in its table.
        for (const plan of plans) {
            if (loaded[plan.index] === 0) continue;
            for (const col of plan.target.identityColumns) {
                const seq = await sequenceOf(client, plan.target.qualified, col);
                if (!seq) continue;
                const ceiling = await currentIdCeiling(client, plan.target, col);
                if (ceiling > 0n) await client.query(`SELECT setval($1::regclass, $2::bigint, true)`, [seq, ceiling.toString()]);
            }
        }
        await client.query('COMMIT');

        const idRemaps: LogicalRestoreSummary['idRemaps'] = [];
        for (const plan of plans) for (const [column, by] of plan.remap) idRemaps.push({ table: plan.target.name, column, offset: by.toString() });
        return {
            sourceWorkspaceId: header.sourceWorkspaceId, targetWorkspaceId: target,
            totalRows: trailer.tables.reduce((a, t) => a + t.rowCount, 0),
            tables: trailer.tables.map((t) => ({ name: t.name, rowCount: t.rowCount, checksum: t.checksum })),
            clearedRows: cleared, idRemaps, manifestHash: trailer.manifestHash,
            durationMs: Date.now() - startedAt, warnings,
        };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
        throw err;
    } finally {
        client.release();
    }
}

// Re-exported so the quoting helper shared with DDL callers has one home.
export { quoteLiteral };

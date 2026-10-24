/**
 * postgresBackupExport.ts — export ONE workspace's rows to a bundle.
 *
 * CONSISTENCY: the whole export runs in a single `REPEATABLE READ READ ONLY`
 * transaction, so every table (and the per-table `count(*)` cross-check) sees
 * the same snapshot no matter what writers commit meanwhile. Rows stream
 * through server-side cursors in fixed-size batches — memory is bounded by one
 * batch, not by the workspace.
 *
 * ISOLATION: every SELECT is `WHERE workspace_id = <this workspace>`; tables
 * with no `workspace_id` are not read at all (they are listed as excluded).
 *
 * HONESTY: success is reported only after (1) each table's streamed row count
 * equals a snapshot `count(*)`, and (2) the finished file is re-read and
 * verified (byte hash, counts, checksums). A workspace with no rows at all is
 * refused — it is a typo, not a backup.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { VERSION } from '../../version.js';
import {
    BACKUP_SESSION_SETTINGS, discoverWorkspaceSchema, loadOrder, pgvectorVersion, quoteIdent, serverVersion,
    WORKSPACE_COLUMN, type BackupTable,
} from './postgresBackupDiscovery.js';
import {
    BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, BundleWriter, RangeTracker, RowChecksum, rowLine, verifyBundle,
    type BundleHeader, type BundleTableStats,
} from './postgresBackupBundle.js';
import {
    LogicalBackupError, OUTBOX_NOT_DRAINED, VERIFICATION_FAILED, WORKSPACE_EMPTY,
    type LogicalBackupSummary,
} from '../workspaceLogicalBackup.js';

export interface ExportOptions {
    workspaceId: string;
    outDir: string;
    schema?: string;
    /** Rows per cursor FETCH. Default 2000. */
    fetchSize?: number;
    /** gzip the bundle. Default true. */
    gzip?: boolean;
    outboxDepth?: () => Promise<number>;
    /** TEST SEAM: awaited after every fetched batch, while the snapshot is open. */
    afterBatch?: (table: string, rowsSoFar: number) => Promise<void>;
    now?: () => Date;
}

/** SELECT list for a table's exported columns; `unmap` shifts remapped integer columns back to their bundle values. */
export function exportSelectList(table: BackupTable, unmap?: Map<string, bigint>): string {
    return table.columns.map((c) => {
        const off = unmap?.get(c.name);
        const q = quoteIdent(c.name);
        return off !== undefined && off !== 0n ? `(${q}::bigint - ${off.toString()})::text` : `${q}::text`;
    }).join(', ');
}

/**
 * Stream a table's rows for one workspace through a cursor, calling `onRow`
 * with each row's text values. The caller owns the surrounding transaction.
 */
export async function streamWorkspaceRows(
    client: PoolClient,
    table: BackupTable,
    workspaceId: string,
    fetchSize: number,
    onRow: (values: (string | null)[]) => void,
    opts: { unmap?: Map<string, bigint>; afterBatch?: ExportOptions['afterBatch'] } = {},
): Promise<number> {
    const lit = (await client.query<{ l: string }>('SELECT quote_literal($1::text) AS l', [workspaceId])).rows[0]!.l;
    const cursor = `lore_bk_${table.name.replace(/[^a-z0-9_]/gi, '_').slice(0, 40)}`;
    // A table with no exportable columns (only workspace_id) still has rows to count.
    const list = table.columns.length > 0 ? exportSelectList(table, opts.unmap) : `1::text`;
    await client.query(
        `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${list} FROM ${table.qualified} WHERE ${quoteIdent(WORKSPACE_COLUMN)} = ${lit}`,
    );
    let n = 0;
    try {
        for (;;) {
            const res = await client.query<(string | null)[]>({ text: `FETCH FORWARD ${fetchSize} FROM ${cursor}`, rowMode: 'array' });
            if (res.rows.length === 0) break;
            for (const row of res.rows) onRow(table.columns.length > 0 ? row : []);
            n += res.rows.length;
            if (opts.afterBatch) await opts.afterBatch(table.name, n);
        }
    } finally {
        await client.query(`CLOSE ${cursor}`);
    }
    return n;
}

export async function exportWorkspaceBundle(pool: Pool, opts: ExportOptions): Promise<LogicalBackupSummary> {
    const startedAt = Date.now();
    const ws = opts.workspaceId;
    if (typeof ws !== 'string' || ws.trim() === '') throw new LogicalBackupError('invalid_workspace', 'backup: workspaceId must be a non-empty string', 400);
    if (opts.outboxDepth) {
        const depth = await opts.outboxDepth();
        if (depth > 0) {
            throw new LogicalBackupError(OUTBOX_NOT_DRAINED, `workspace '${ws}' has ${depth} un-drained outbox rows; drain before backup (a backup must not snapshot a graph ahead of its vectors)`);
        }
    }
    const fetchSize = opts.fetchSize ?? 2000;
    const gzip = opts.gzip ?? true;
    const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    fs.mkdirSync(opts.outDir, { recursive: true });
    const safeName = ws.replace(/[^A-Za-z0-9._-]/g, '_');
    const finalPath = path.join(opts.outDir, `lore-pgbackup-${safeName}-${stamp}.ndjson${gzip ? '.gz' : ''}`);
    const partialPath = `${finalPath}.partial`;
    const manifestPath = `${finalPath}.manifest.json`;

    const client = await pool.connect();
    let writer: BundleWriter | undefined;
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        for (const s of BACKUP_SESSION_SETTINGS) await client.query(s);
        const schema = await discoverWorkspaceSchema(client, opts.schema);
        const tables = loadOrder(schema.tables);
        const lit = (await client.query<{ l: string }>('SELECT quote_literal($1::text) AS l', [ws])).rows[0]!.l;

        // Snapshot truth, per table: what the cursor must end up having streamed.
        const expected = new Map<string, number>();
        for (const t of tables) {
            const r = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${t.qualified} WHERE ${quoteIdent(WORKSPACE_COLUMN)} = ${lit}`);
            expected.set(t.name, Number(r.rows[0]!.n));
        }
        const total = [...expected.values()].reduce((a, b) => a + b, 0);
        if (total === 0) {
            throw new LogicalBackupError(WORKSPACE_EMPTY, `workspace '${ws}' has no rows in any of ${tables.length} workspace table(s) of schema '${schema.schema}'; refusing to write an empty backup (wrong workspace name?)`, 404);
        }

        const header: BundleHeader = {
            t: 'header', format: BUNDLE_FORMAT, formatVersion: BUNDLE_FORMAT_VERSION,
            createdAt: (opts.now?.() ?? new Date()).toISOString(),
            loreVersion: VERSION,
            pgvectorVersion: await pgvectorVersion(client),
            serverVersion: await serverVersion(client),
            schema: schema.schema,
            schemaFingerprint: schema.fingerprint,
            sourceWorkspaceId: ws,
            tables: tables.map((t) => ({
                name: t.name, partitioned: t.partitioned, workspaceIdType: t.workspaceIdType,
                columns: t.columns.map((c) => ({ name: c.name, type: c.type, notNull: c.notNull })),
                generatedColumns: t.generatedColumns, identityColumns: t.identityColumns, references: t.references,
            })),
            excluded: schema.excluded,
        };
        writer = new BundleWriter(partialPath, gzip);
        await writer.line(JSON.stringify(header));

        const stats: BundleTableStats[] = [];
        for (let ti = 0; ti < tables.length; ti++) {
            const t = tables[ti]!;
            const sum = new RowChecksum();
            const ranges = new Map(t.identityColumns.map((c) => [c, new RangeTracker()] as const));
            const idPos = t.identityColumns.map((c) => [c, t.columns.findIndex((x) => x.name === c)] as const);
            const pending: string[] = [];
            const n = await streamWorkspaceRows(client, t, ws, fetchSize, (values) => {
                const line = rowLine(ti, values);
                sum.add(line);
                for (const [c, pos] of idPos) ranges.get(c)!.add(values[pos] ?? null);
                pending.push(line);
            }, {
                afterBatch: async (name, soFar) => {
                    for (const l of pending.splice(0)) await writer!.line(l);
                    if (opts.afterBatch) await opts.afterBatch(name, soFar);
                },
            });
            for (const l of pending.splice(0)) await writer.line(l);
            if (n !== expected.get(t.name)) {
                throw new LogicalBackupError(VERIFICATION_FAILED, `table ${t.name}: streamed ${n} rows but the snapshot holds ${expected.get(t.name)}; backup discarded`, 500);
            }
            const identityRanges: BundleTableStats['identityRanges'] = {};
            for (const [c, r] of ranges) { const j = r.toJSON(); if (j) identityRanges[c] = j; }
            stats.push({ name: t.name, rowCount: n, checksum: sum.hex(), identityRanges });
        }
        const trailer = await writer.finish(stats);
        writer = undefined;
        await client.query('ROLLBACK');

        // Re-read what hit the disk before calling it a backup.
        const verified = await verifyBundle(partialPath);
        if (verified.trailer.manifestHash !== trailer.manifestHash) {
            throw new LogicalBackupError(VERIFICATION_FAILED, 'written bundle failed re-verification; backup discarded', 500);
        }
        fs.renameSync(partialPath, finalPath);
        fs.writeFileSync(manifestPath, JSON.stringify({ header, trailer }, null, 2) + '\n');
        const warnings = schema.excluded.map((e) => `table '${e.table}' not backed up: ${e.reason}`);
        return {
            bundlePath: finalPath, manifestPath, workspaceId: ws, totalRows: total,
            tables: stats.map((s) => ({ name: s.name, rowCount: s.rowCount, checksum: s.checksum })),
            excluded: schema.excluded, manifestHash: trailer.manifestHash,
            bytes: fs.statSync(finalPath).size, durationMs: Date.now() - startedAt, warnings,
        };
    } catch (err) {
        if (writer) await writer.abort().catch(() => undefined);
        fs.rmSync(partialPath, { force: true });
        try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
        throw err;
    } finally {
        client.release();
    }
}

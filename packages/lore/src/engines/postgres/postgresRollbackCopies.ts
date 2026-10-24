/**
 * postgresRollbackCopies.ts — inspect, verify and drop the rollback copies the two
 * in-place Postgres migrations leave behind.
 *
 *   verbatim_pre_partition   the pre-partitioning `verbatim` table      (postgresVerbatimPartitionMigration.ts)
 *   edges_pre_pk             the text-keyed (layout 1) `edges` table    (postgresEdgePkMigration.ts)
 *
 * Both migrations keep the old table so an operator can roll back; nothing reads or writes it
 * afterwards and it costs only disk. This module backs `lore postgres rollback-copies`.
 *
 * SAFETY RULES (enforced here, not only in the CLI):
 *   - {@link ROLLBACK_COPIES} is a FIXED allowlist. A table name never reaches SQL from a caller:
 *     the SQL below only interpolates the literals in that list.
 *   - `edges_dangling` (edges quarantined by the edge migration) is NOT a rollback copy. It is the only
 *     record of those edges and is never touched by anything here; a test pins that.
 *   - Inspecting is read-only (a READ ONLY transaction) and runs no DDL.
 *   - Dropping re-verifies in the SAME transaction that takes an ACCESS EXCLUSIVE lock on the copy, and
 *     refuses (unless forced) when verification fails.
 *
 * WHAT VERIFICATION MEANS. The migrations check old = new (+ quarantined) at the instant of the swap, under
 * a lock. Live writers carry on afterwards, so equality of counts is not a valid test later: rows are
 * inserted, and rows deleted on purpose (node purge, edge unlink) are absent from the live table. What can
 * be checked is the direction that matters for a rollback copy: is there anything in the copy that the live
 * table has LOST without an accounted reason?
 *   verbatim: every (workspace_id, row_id) in the copy is present in live `verbatim`.
 *   edges:    every copy edge whose endpoints still resolve through `nodes` is present in live `edges`;
 *             copy edges whose endpoint is gone are reported as quarantined (in `edges_dangling`) or
 *             "endpoint removed since" (their node was deleted later).
 * A failure is therefore a strong signal, not proof of loss: a row deleted on purpose since the migration
 * also shows up as missing. The report carries a sample so the operator can judge; `force` accepts it.
 */

import type { PoolClient } from 'pg';

import { dropPrePkEdges } from './postgresEdgePkMigration.js';
import { dropPrePartitionVerbatim } from './postgresVerbatimPartitionMigration.js';

/** The ONLY tables this module will ever drop, and the live table each one is checked against. */
export const ROLLBACK_COPIES = [
    { name: 'verbatim_pre_partition', live: 'verbatim', from: 'the verbatim partitioning migration' },
    { name: 'edges_pre_pk', live: 'edges', from: 'the edge layout 2 (surrogate key) migration' },
] as const;

export type RollbackCopyName = (typeof ROLLBACK_COPIES)[number]['name'];
export const ROLLBACK_COPY_NAMES: readonly RollbackCopyName[] = ROLLBACK_COPIES.map((c) => c.name);

/** Quarantine table of the edge migration: reported, never dropped. */
export const QUARANTINE_TABLE = 'edges_dangling';

export interface RollbackCheck {
    name: string;
    ok: boolean;
    detail: string;
}

export interface RollbackCopyReport {
    name: RollbackCopyName;
    liveTable: string;
    from: string;
    exists: boolean;
    rows: number;
    /** pg_total_relation_size of the copy (table + indexes + TOAST). */
    bytes: number;
    liveRows: number;
    checks: RollbackCheck[];
    /** True when the copy exists and every check passed. */
    verified: boolean;
    /** Up to {@link SAMPLE_LIMIT} copy rows missing from the live table (ids only). */
    sampleMissing: string[];
}

export interface RollbackInspection {
    copies: RollbackCopyReport[];
    quarantine: { exists: boolean; rows: number };
}

export interface DropOutcome {
    name: RollbackCopyName;
    dropped: boolean;
    /** Why nothing was dropped: 'absent', or 'unverified' (verification failed and force was not given). */
    skipped?: 'absent' | 'unverified';
    forced?: boolean;
    report: RollbackCopyReport;
}

const SAMPLE_LIMIT = 5;
const INSPECT_STATEMENT_TIMEOUT = '3600s';

const num = (v: unknown): number => Number(v ?? 0);

async function exists(client: PoolClient, table: string): Promise<boolean> {
    return (await client.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [table])).rows[0]?.t != null;
}

async function relSize(client: PoolClient, table: string): Promise<number> {
    return num((await client.query<{ s: string }>(`SELECT pg_total_relation_size(to_regclass($1)) AS s`, [table])).rows[0]?.s);
}

async function count(client: PoolClient, table: string): Promise<number> {
    // `table` is always a literal from ROLLBACK_COPIES / QUARANTINE_TABLE, never caller input.
    return num((await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
}

function emptyReport(def: (typeof ROLLBACK_COPIES)[number]): RollbackCopyReport {
    return { name: def.name, liveTable: def.live, from: def.from, exists: false, rows: 0, bytes: 0, liveRows: 0, checks: [], verified: false, sampleMissing: [] };
}

async function inspectVerbatim(client: PoolClient, report: RollbackCopyReport): Promise<void> {
    const kind = (await client.query<{ k: string | null }>(`SELECT relkind AS k FROM pg_class WHERE oid = to_regclass('verbatim')`)).rows[0]?.k ?? null;
    report.checks.push(kind === 'p'
        ? { name: 'live_layout', ok: true, detail: 'live verbatim is the partitioned table' }
        : { name: 'live_layout', ok: false, detail: kind === null ? 'live verbatim table does not exist' : `live verbatim is not partitioned (relkind ${kind})` });
    if (kind === null) return;
    report.liveRows = await count(client, 'verbatim');
    const res = await client.query<{ total: string; missing: string }>(
        `SELECT count(*) AS total, count(*) FILTER (WHERE v.row_id IS NULL) AS missing
           FROM verbatim_pre_partition o
           LEFT JOIN verbatim v ON v.workspace_id = o.workspace_id AND v.row_id = o.row_id`,
    );
    const missing = num(res.rows[0]?.missing);
    report.checks.push({
        name: 'ids_present', ok: missing === 0,
        detail: missing === 0
            ? `all ${report.rows} copy rows exist in live verbatim (live has ${report.liveRows})`
            : `${missing} of ${report.rows} copy rows are missing from live verbatim (live has ${report.liveRows})`,
    });
    if (missing > 0) {
        const sample = await client.query<{ w: string; id: string }>(
            `SELECT o.workspace_id AS w, o.id AS id FROM verbatim_pre_partition o
               LEFT JOIN verbatim v ON v.workspace_id = o.workspace_id AND v.row_id = o.row_id
              WHERE v.row_id IS NULL ORDER BY o.row_id LIMIT ${SAMPLE_LIMIT}`,
        );
        report.sampleMissing = sample.rows.map((r) => `${r.w}/${r.id}`);
    }
}

async function inspectEdges(client: PoolClient, report: RollbackCopyReport): Promise<void> {
    const layout = (await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'edges' AND column_name IN ('src_sk', 'dst_sk')`,
    )).rows[0]?.n;
    const layout2 = num(layout) === 2;
    report.checks.push(layout2
        ? { name: 'live_layout', ok: true, detail: 'live edges is layout 2 (surrogate keys)' }
        : { name: 'live_layout', ok: false, detail: 'live edges is not layout 2 (no src_sk/dst_sk): the migration did not complete' });
    if (!layout2) return;
    report.liveRows = await count(client, 'edges');
    const hasQ = await exists(client, QUARANTINE_TABLE);
    const dangling = hasQ
        ? `LEFT JOIN ${QUARANTINE_TABLE} d ON d.workspace_id = r.workspace_id AND d.source_id = r.source_id AND d.target_id = r.target_id AND d.relation = r.relation`
        : '';
    const dFlag = hasQ ? 'd.workspace_id IS NOT NULL' : 'false';
    const classified = `
        WITH r AS (
            SELECT o.workspace_id, o.source_id, o.target_id, o.relation, s.sk AS ssk, t.sk AS dsk
              FROM edges_pre_pk o
              LEFT JOIN nodes s ON s.workspace_id = o.workspace_id AND s.id = o.source_id
              LEFT JOIN nodes t ON t.workspace_id = o.workspace_id AND t.id = o.target_id),
        c AS (
            SELECT r.*, (r.ssk IS NOT NULL AND r.dsk IS NOT NULL) AS resolvable,
                   (e.src_sk IS NOT NULL) AS live, ${dFlag} AS quarantined
              FROM r
              LEFT JOIN edges e ON e.workspace_id = r.workspace_id AND e.src_sk = r.ssk AND e.dst_sk = r.dsk AND e.relation = r.relation
              ${dangling})`;
    const res = await client.query<{ total: string; present: string; quarantined: string; gone: string; missing: string }>(
        `${classified}
         SELECT count(*) AS total,
                count(*) FILTER (WHERE resolvable AND live) AS present,
                count(*) FILTER (WHERE NOT resolvable AND quarantined) AS quarantined,
                count(*) FILTER (WHERE NOT resolvable AND NOT quarantined) AS gone,
                count(*) FILTER (WHERE resolvable AND NOT live) AS missing
           FROM c`,
    );
    const row = res.rows[0]!;
    const missing = num(row.missing);
    report.checks.push({
        name: 'edges_accounted', ok: missing === 0,
        detail: `${report.rows} copy edges = ${num(row.present)} in live edges + ${num(row.quarantined)} quarantined in ${QUARANTINE_TABLE} `
            + `+ ${num(row.gone)} whose endpoint was removed since + ${missing} missing (live has ${report.liveRows})`,
    });
    if (missing > 0) {
        const sample = await client.query<{ w: string; s: string; t: string; rel: string }>(
            `${classified}
             SELECT workspace_id AS w, source_id AS s, target_id AS t, relation AS rel FROM c
              WHERE resolvable AND NOT live ORDER BY workspace_id, source_id, target_id, relation LIMIT ${SAMPLE_LIMIT}`,
        );
        report.sampleMissing = sample.rows.map((r) => `${r.w}/${r.s}->${r.t} (${r.rel})`);
    }
}

async function inspectOne(client: PoolClient, def: (typeof ROLLBACK_COPIES)[number]): Promise<RollbackCopyReport> {
    const report = emptyReport(def);
    if (!(await exists(client, def.name))) return report;
    report.exists = true;
    report.rows = await count(client, def.name);
    report.bytes = await relSize(client, def.name);
    if (def.name === 'verbatim_pre_partition') await inspectVerbatim(client, report);
    else await inspectEdges(client, report);
    report.verified = report.checks.length > 0 && report.checks.every((c) => c.ok);
    return report;
}

async function readOnly<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
    await client.query('BEGIN READ ONLY');
    try {
        await client.query(`SET LOCAL statement_timeout = '${INSPECT_STATEMENT_TIMEOUT}'`);
        const out = await fn();
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
            console.error(`[lore-pg] rollback after failed inspection also failed: ${(rollbackErr as Error).name}`);
        });
        throw err;
    }
}

/** Read-only: which rollback copies exist, their size, and whether each verifies against the live table. */
export async function inspectRollbackCopies(client: PoolClient): Promise<RollbackInspection> {
    return readOnly(client, async () => {
        const copies: RollbackCopyReport[] = [];
        for (const def of ROLLBACK_COPIES) copies.push(await inspectOne(client, def));
        const hasQ = await exists(client, QUARANTINE_TABLE);
        return { copies, quarantine: { exists: hasQ, rows: hasQ ? await count(client, QUARANTINE_TABLE) : 0 } };
    });
}

/**
 * Drop the named rollback copies. `names` must already be allowlisted names (the type enforces it; the runtime
 * check below is the backstop for a caller that cast). All-or-nothing: if any selected copy fails verification
 * and `force` is false, NOTHING is dropped and every outcome is reported `unverified`/`absent`.
 */
export async function dropRollbackCopies(
    client: PoolClient, names: readonly RollbackCopyName[], opts: { force?: boolean } = {},
): Promise<DropOutcome[]> {
    for (const n of names) {
        if (!ROLLBACK_COPY_NAMES.includes(n)) throw new Error(`dropRollbackCopies: "${String(n)}" is not a rollback copy`);
    }
    const defs = ROLLBACK_COPIES.filter((d) => names.includes(d.name));
    await client.query('BEGIN');
    try {
        await client.query(`SET LOCAL lock_timeout = '10s'`);
        await client.query(`SET LOCAL statement_timeout = '${INSPECT_STATEMENT_TIMEOUT}'`);
        // Lock the copies first so nothing can start using one between the check and the drop.
        for (const def of defs) {
            if (await exists(client, def.name)) await client.query(`LOCK TABLE ${def.name} IN ACCESS EXCLUSIVE MODE`);
        }
        const reports: RollbackCopyReport[] = [];
        for (const def of defs) reports.push(await inspectOne(client, def));
        const blocked = reports.some((r) => r.exists && !r.verified) && !opts.force;
        const outcomes: DropOutcome[] = [];
        for (const report of reports) {
            if (!report.exists) { outcomes.push({ name: report.name, dropped: false, skipped: 'absent', report }); continue; }
            if (blocked) { outcomes.push({ name: report.name, dropped: false, skipped: 'unverified', report }); continue; }
            const dropped = report.name === 'verbatim_pre_partition' ? await dropPrePartitionVerbatim(client) : await dropPrePkEdges(client);
            outcomes.push({ name: report.name, dropped, forced: opts.force === true && !report.verified, report });
        }
        await client.query('COMMIT');
        return outcomes;
    } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
            console.error(`[lore-pg] rollback after failed drop also failed: ${(rollbackErr as Error).name}`);
        });
        throw err;
    }
}

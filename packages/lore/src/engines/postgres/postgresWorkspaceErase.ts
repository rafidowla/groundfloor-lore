/**
 * postgresWorkspaceErase.ts — the Postgres `WorkspaceEraser` (lane f6a).
 *
 * "Delete means delete": once a workspace delete is confirmed and its recovery window has passed, every
 * Postgres row, partition, per-workspace view and per-field index Lore holds for the workspace is removed,
 * then counted again. See engines/workspaceErase/types.ts for the contract this implements.
 *
 * ===================================================================================================
 * THE KEY, AND THE SWITCH THAT GATES THE DESTRUCTIVE PART
 * ===================================================================================================
 * The eraser matches rows by ONE key: the target's PERMANENT workspace id (config/workspaceIds.ts), as a
 * bound parameter. It never matches by name. Since 3.37 the Postgres engine stores that id in
 * `workspace_id` (PostgresGraph, PostgresVerbatimStore, PostgresIngestionStore and the table store are all
 * constructed with the id that postgresWorkspaceKey.ts resolves; postgresRekey.ts rewrites rows written
 * earlier under the NAME). So a rename no longer orphans rows and a reused name can never reach a deleted
 * workspace's rows: erasing by id deletes exactly the deleted workspace's data.
 *
 * The destructive path is still behind one switch, {@link POSTGRES_ROWS_KEYED_BY}, which says `'permanent-id'`.
 * With `rowsKeyedBy: 'workspace-name'` (tests of the old behaviour) `erase()` deletes NOTHING: it counts what
 * is there (by permanent id, and by name for information only) and returns `unverifiable` (or
 * `not-applicable` when both counts are 0).
 *
 * WHAT IS COVERED — by catalog discovery, not a list (a hard-coded list silently misses the next table):
 *   - every ordinary / partitioned table in the schema with a `workspace_id` column (text, varchar or uuid),
 *     INCLUDING migration scaffolding the logical backup deliberately skips (`edges_next`, `edges_pre_pk`,
 *     `verbatim_pre_partition`, `verbatim_common_lexemes(_meta)`, `edges_dangling`): a copy of a deleted
 *     workspace's rows in a rollback table is still a copy;
 *   - the workspace's list-partition of a partitioned table (`verbatim_ws_<hash>`; recognised by its
 *     bound `FOR VALUES IN ('<id>')`, not by name): DETACH + DROP, which also frees the disk;
 *   - per-workspace read views `lore_tv_<entity_type_id>` (the id is baked into the view body);
 *   - per-field partial indexes `lore_ev_<field_id>_u|_i` on lore_entity_value.
 * Tables with no `workspace_id` are skipped only when listed in {@link GLOBAL_POSTGRES_TABLES}; a table that
 * is neither covered nor listed, or whose columns look workspace-scoped under another name, makes the
 * result `unverifiable` instead of silently "complete". A test fails the build when a new table appears
 * that is in none of the three groups.
 */

import type { Pool, PoolClient } from 'pg';
import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from '../workspaceErase/types.js';
import {
    discoverWorkspaceSchema, loadOrder, quoteIdent, quoteLiteral, WORKSPACE_COLUMN, type BackupTable,
} from './postgresBackupDiscovery.js';
import { closePostgresPool, createPostgresPool } from './postgresClient.js';
import { closeSharedPostgresPool, sharedPostgresPool } from './postgresPoolOwner.js';
import { TABLE_TABLES, TABLE_VIEW_PREFIX } from './postgresTableSchema.js';

export type PostgresRowKey = 'permanent-id' | 'workspace-name';

/**
 * What the Postgres engine stores in `workspace_id`. `'permanent-id'` since 3.37 (the name-to-id rewrite in
 * postgresRekey.ts runs when an engine opens). `'workspace-name'` would make the eraser only count.
 */
export const POSTGRES_ROWS_KEYED_BY: PostgresRowKey = 'permanent-id';

/**
 * Tables with NO workspace column that are deliberately not erased, each with the reason. A test requires
 * every table of a fully initialised store to be either workspace-scoped (erased) or listed here.
 */
export const GLOBAL_POSTGRES_TABLES: Readonly<Record<string, string>> = {
    verbatim_changes_log: 'promotion change log mirror; nothing populates it in Postgres and it holds row ids only (no text, no workspace column)',
    verbatim_partition_progress: 'verbatim partitioning migration high-water mark (one global row, no workspace data)',
    lore_pg_rekey_ledger: 'one-time name-to-permanent-id rewrite ledger (postgresRekey.ts); its `key_id` is the id already rewritten, with row counts only, no workspace data',
    edges_pk_progress: 'edge surrogate-key migration cursor (one global row; its `ws` column is checked separately for the target)',
};

const DEFAULT_BATCH_ROWS = 5_000;
const LOCK_TIMEOUT = '10s';
const DDL_ATTEMPTS = 3;
const WORKSPACE_ID_TYPES = /^(text|character varying(\(\d+\))?|uuid)$/;
/** Column names that suggest "this row belongs to a workspace" under some other spelling. */
const WORKSPACE_LIKE_COLUMN = /(workspace|tenant|(^|_)ws($|_))/i;

export interface PostgresWorkspaceEraseOptions {
    /** Use this pool instead of the process-shared one (tests). The caller keeps ownership of it. */
    pool?: Pool;
    /**
     * Open a private pool (from `LORE_PG_URL`) on first use and end it in `close()`, instead of touching the process-shared
     * pool. Hosts that already own the shared pool (daemon, embedded) MUST use this: `close()` on the shared pool would end it.
     */
    dedicatedPool?: boolean;
    /** Database schema holding the workspace tables. Default: the connection's current schema. */
    schema?: string;
    /** Rows deleted per statement/transaction. Default 5,000. */
    batchRows?: number;
    /** See {@link POSTGRES_ROWS_KEYED_BY}. Default: that constant. Default `'permanent-id'`; tests pass `'workspace-name'` to exercise the count-only mode. */
    rowsKeyedBy?: PostgresRowKey;
    /** Run VACUUM on the tables rows were deleted from (so dead row versions are reclaimed). Default true. */
    vacuum?: boolean;
}

export interface PostgresWorkspaceEraser extends WorkspaceEraser {
    /** Release the pool when this eraser opened the shared one itself. Safe to call more than once. */
    close(): Promise<void>;
}

interface Scoped {
    name: string;
    qualified: string;
    partitioned: boolean;
    /** SQL predicate selecting the target's rows; `$1` is the workspace key. */
    pred: string;
}

interface Inventory {
    schema: string;
    /** Deletion order: scaffolding copies first, then workspace tables children-before-parents. */
    scoped: Scoped[];
    /** Tables with a `workspace_id` of a type the eraser cannot compare. */
    unsupported: string[];
    /** Tables with a workspace-like column the eraser does not understand and no global-table entry. */
    unknownScoped: string[];
}

const ident = (schema: string, name: string): string => `${quoteIdent(schema)}.${quoteIdent(name)}`;

function predicateFor(type: string): string {
    return type === 'uuid' ? `${quoteIdent(WORKSPACE_COLUMN)}::text = $1` : `${quoteIdent(WORKSPACE_COLUMN)} = $1`;
}

async function buildInventory(client: PoolClient, schema: string | undefined): Promise<Inventory> {
    const found = await discoverWorkspaceSchema(client, schema);
    const schemaName = found.schema;
    const ordered = loadOrder(found.tables).reverse(); // children before parents
    const known = new Set(found.tables.map((t) => t.name));

    // Everything with a workspace_id column, to catch the scaffolding tables discovery excludes on purpose.
    const withCol = (await client.query<{ relname: string; relkind: string; type: string }>(
        `SELECT c.relname, c.relkind::text AS relkind, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
          ORDER BY c.relname`,
        [schemaName, WORKSPACE_COLUMN],
    )).rows;
    const scaffolding: Scoped[] = [];
    const unsupported: string[] = [];
    for (const r of withCol) {
        if (known.has(r.relname)) continue;
        if (!WORKSPACE_ID_TYPES.test(r.type)) { unsupported.push(r.relname); continue; }
        scaffolding.push({ name: r.relname, qualified: ident(schemaName, r.relname), partitioned: r.relkind === 'p', pred: predicateFor(r.type) });
    }

    // Tables with no workspace_id but a workspace-like column, or any column-less table not on the global list.
    const withoutCol = (await client.query<{ relname: string; cols: string[] | null }>(
        `SELECT c.relname,
                (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~* $2) AS cols
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
            AND NOT EXISTS (SELECT 1 FROM pg_attribute w WHERE w.attrelid = c.oid AND w.attname = $3 AND w.attnum > 0 AND NOT w.attisdropped)
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
          ORDER BY c.relname`,
        [schemaName, WORKSPACE_LIKE_COLUMN.source, WORKSPACE_COLUMN],
    )).rows;
    const unknownScoped = withoutCol
        .filter((r) => (r.cols?.length ?? 0) > 0 && !(r.relname in GLOBAL_POSTGRES_TABLES))
        .map((r) => `${r.relname}(${(r.cols ?? []).join(',')})`);

    const scoped: Scoped[] = [
        ...scaffolding,
        ...ordered.map((t: BackupTable) => ({ name: t.name, qualified: t.qualified, partitioned: t.partitioned, pred: predicateFor(t.workspaceIdType) })),
    ];
    return { schema: schemaName, scoped, unsupported, unknownScoped };
}

async function countRows(client: PoolClient, t: Scoped, key: string): Promise<number> {
    const res = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t.qualified} WHERE ${t.pred}`, [key]);
    return Number(res.rows[0]?.n ?? '0');
}

async function countAll(client: PoolClient, inv: Inventory, key: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of inv.scoped) out[t.name] = await countRows(client, t, key);
    return out;
}

const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);

async function tableExists(client: PoolClient, schema: string, name: string): Promise<boolean> {
    const res = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [ident(schema, name)]);
    return res.rows[0]?.ok === true;
}

/** Singleton migration cursor that can hold one workspace key; reported (not edited) when it names the target. */
async function cursorResidue(client: PoolClient, schema: string, key: string): Promise<number> {
    if (!(await tableExists(client, schema, 'edges_pk_progress'))) return 0;
    const res = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${ident(schema, 'edges_pk_progress')} WHERE ws = $1`, [key]);
    return Number(res.rows[0]?.n ?? '0');
}

interface TypedObjects { viewNames: string[]; indexNames: string[] }

/** Per-workspace read views and per-field partial indexes that belong to the key. Must run BEFORE the rows go. */
async function typedObjects(client: PoolClient, inv: Inventory, key: string): Promise<TypedObjects> {
    const views = new Set<string>();
    const indexes = new Set<string>();
    if (await tableExists(client, inv.schema, TABLE_TABLES.entityType)) {
        const r = await client.query<{ id: string }>(
            `SELECT entity_type_id::text AS id FROM ${ident(inv.schema, TABLE_TABLES.entityType)} WHERE ${WORKSPACE_COLUMN} = $1`, [key]);
        for (const row of r.rows) views.add(`${TABLE_VIEW_PREFIX}${row.id}`);
    }
    if (await tableExists(client, inv.schema, TABLE_TABLES.fieldDef)) {
        const r = await client.query<{ id: string }>(
            `SELECT field_id::text AS id FROM ${ident(inv.schema, TABLE_TABLES.fieldDef)} WHERE ${WORKSPACE_COLUMN} = $1`, [key]);
        for (const row of r.rows) { indexes.add(`lore_ev_${row.id}_u`); indexes.add(`lore_ev_${row.id}_i`); }
    }
    // Views left over from an earlier, interrupted erase (type rows already gone): the id literal is in the body.
    const lit = `${WORKSPACE_COLUMN} = ${quoteLiteral(key)}`;
    const orphan = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'v' AND c.relname LIKE $2
            AND position($3 in pg_get_viewdef(c.oid)) > 0`,
        [inv.schema, `${TABLE_VIEW_PREFIX.replace(/_/g, '\\_')}%`, lit]);
    for (const row of orphan.rows) views.add(row.relname);

    // Keep only what exists.
    const existingViews = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'v' AND c.relname = ANY($2::text[])`, [inv.schema, [...views]]);
    const existingIdx = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'i' AND c.relname = ANY($2::text[])`, [inv.schema, [...indexes]]);
    return { viewNames: existingViews.rows.map((r) => r.relname).sort(), indexNames: existingIdx.rows.map((r) => r.relname).sort() };
}

/** Run DDL in a short transaction with a lock timeout; retry a few times when the lock cannot be had. */
async function ddl(client: PoolClient, statements: string[]): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= DDL_ATTEMPTS; attempt++) {
        try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
            for (const s of statements) await client.query(s);
            await client.query('COMMIT');
            return;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            lastErr = e;
            if ((e as { code?: string }).code !== '55P03') throw e; // lock_not_available: retry; anything else is real
        }
    }
    throw lastErr;
}

/** The partition of `t` that holds exactly this key (bound `FOR VALUES IN ('<key>')`), if any. */
async function keyPartition(client: PoolClient, t: Scoped, key: string): Promise<string | null> {
    const res = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = $1::regclass AND pg_get_expr(c.relpartbound, c.oid) = $2`,
        [t.qualified, `FOR VALUES IN (${quoteLiteral(key)})`]);
    return res.rows[0]?.relname ?? null;
}

export function createPostgresWorkspaceEraser(opts: PostgresWorkspaceEraseOptions = {}): PostgresWorkspaceEraser {
    const ownsShared = opts.pool === undefined && opts.dedicatedPool !== true;
    let dedicated: Pool | null = null;
    const pool = (): Pool => {
        if (opts.pool) return opts.pool;
        if (opts.dedicatedPool) { dedicated ??= createPostgresPool(); return dedicated; }
        return sharedPostgresPool();
    };
    const batchRows = Math.max(1, Math.floor(opts.batchRows ?? DEFAULT_BATCH_ROWS));
    const rowsKeyedBy: PostgresRowKey = opts.rowsKeyedBy ?? POSTGRES_ROWS_KEYED_BY;
    const doVacuum = opts.vacuum !== false;

    async function erase(target: EraseTarget, eraseOpts: EraseOptions = {}): Promise<EraseStepResult> {
        if (!target.id || target.id.trim() === '') throw new Error('postgres workspace erase: target.id (permanent workspace id) is required');
        const client = await pool().connect();
        try {
            const inv = await buildInventory(client, opts.schema);
            if (inv.scoped.length === 0) {
                return { store: 'postgres', status: 'not-applicable', removed: {}, remaining: {}, detail: 'no workspace tables exist in this database schema' };
            }
            if (rowsKeyedBy !== 'permanent-id') return await countOnly(client, inv, target);
            return await destructive(client, inv, target, eraseOpts);
        } finally {
            client.release();
        }
    }

    /** Count-only mode (`rowsKeyedBy: 'workspace-name'`): delete nothing, report what a count finds. */
    async function countOnly(client: PoolClient, inv: Inventory, target: EraseTarget): Promise<EraseStepResult> {
        const byId = await countAll(client, inv, target.id);
        const byName = target.name && target.name !== target.id ? await countAll(client, inv, target.name) : {};
        const remaining: Record<string, number> = { ...byId };
        for (const [table, n] of Object.entries(byName)) remaining[`by-name:${table}`] = n;
        if (sum(byId) === 0 && sum(byName) === 0) {
            return {
                store: 'postgres', status: 'not-applicable', removed: {}, remaining,
                detail: 'Nothing found for this workspace in Postgres (checked by permanent id, and by name for information). Nothing was deleted.',
            };
        }
        return {
            store: 'postgres', status: 'unverifiable', removed: {}, remaining,
            detail: `NOTHING WAS DELETED. Postgres rows are stored under the workspace NAME, not its permanent id, and a name can `
                + `already belong to a newer workspace, so Lore refuses to erase by name. Found ${sum(byId)} row(s) under the permanent id and `
                + `${sum(byName)} row(s) under the name '${target.name}' (the latter may belong to another workspace that now uses that name). `
                + `They need the engine's name-to-permanent-id migration before they can be erased safely.`,
        };
    }

    async function destructive(client: PoolClient, inv: Inventory, target: EraseTarget, eraseOpts: EraseOptions): Promise<EraseStepResult> {
        const key = target.id;
        const removed: Record<string, number> = {};
        const bump = (k: string, n: number): void => { if (n > 0) removed[k] = (removed[k] ?? 0) + n; };
        let aborted = false;
        const stop = (): boolean => { if (eraseOpts.signal?.aborted) aborted = true; return aborted; };
        const vacuumTables = new Set<string>();

        // 0. Find what exists for the target before any row goes (typed views/indexes are found through rows).
        const found = await typedObjects(client, inv, key);
        const before = await countAll(client, inv, key);
        const partitions = new Map<string, string>();
        for (const t of inv.scoped.filter((s) => s.partitioned)) {
            const p = await keyPartition(client, t, key);
            if (p) partitions.set(t.name, p);
        }
        const startedWithData = sum(before) > 0 || found.viewNames.length > 0 || found.indexNames.length > 0 || partitions.size > 0;

        // 1. Per-workspace views and per-field indexes (dropped without CASCADE: a dependent object stops the drop loudly).
        if (!stop() && (found.viewNames.length > 0 || found.indexNames.length > 0)) {
            await ddl(client, [
                ...found.viewNames.map((v) => `DROP VIEW IF EXISTS ${ident(inv.schema, v)}`),
                ...found.indexNames.map((i) => `DROP INDEX IF EXISTS ${ident(inv.schema, i)}`),
            ]);
            bump('views', found.viewNames.length);
            bump('field_indexes', found.indexNames.length);
        }

        // 2. Per-workspace partitions: DETACH + DROP (counted first, so the receipt can say how many rows went).
        for (const t of inv.scoped.filter((s) => s.partitioned)) {
            if (stop()) break;
            const part = partitions.get(t.name);
            if (!part) continue;
            const rows = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${ident(inv.schema, part)}`)).rows[0]?.n ?? '0');
            await ddl(client, [
                `ALTER TABLE ${t.qualified} DETACH PARTITION ${ident(inv.schema, part)}`,
                `DROP TABLE ${ident(inv.schema, part)}`,
            ]);
            bump(t.name, rows);
            bump('partitions', 1);
        }

        // 3. Whatever is left, in bounded batches, children before parents. Every statement repeats the key
        //    predicate, so a ctid that also exists in another partition/table row can never delete a neighbour.
        for (const t of inv.scoped) {
            while (!stop()) {
                const res = await client.query(
                    `DELETE FROM ${t.qualified} WHERE ctid = ANY (ARRAY(SELECT ctid FROM ${t.qualified} WHERE ${t.pred} LIMIT $2)) AND ${t.pred}`,
                    [key, batchRows]);
                const n = res.rowCount ?? 0;
                if (n === 0) break;
                bump(t.name, n);
                vacuumTables.add(t.qualified);
            }
            if (aborted) break;
        }

        // 4. Reclaim dead row versions (best effort; a failure is reported, never fatal).
        let vacuumNote = '';
        if (doVacuum && !aborted && vacuumTables.size > 0) {
            try {
                await client.query('SET statement_timeout = 0');
                for (const q of vacuumTables) await client.query(`VACUUM ${q}`);
            } catch (e) {
                vacuumNote = ` VACUUM could not run (${(e as Error).message}); dead row versions stay until autovacuum.`;
            } finally {
                await client.query('RESET statement_timeout').catch(() => undefined);
            }
        }

        // 5. Verify with a fresh count of everything.
        const remaining = await countAll(client, inv, key);
        const after = await typedObjects(client, inv, key);
        remaining['views'] = after.viewNames.length;
        remaining['field_indexes'] = after.indexNames.length;
        let leftPartitions = 0;
        for (const t of inv.scoped.filter((s) => s.partitioned)) if (await keyPartition(client, t, key)) leftPartitions++;
        remaining['partitions'] = leftPartitions;
        const cursor = await cursorResidue(client, inv.schema, key);
        if (cursor > 0) remaining['edges_pk_progress'] = cursor;

        const left = sum(remaining);
        const caveats: string[] = [];
        if (inv.unsupported.length > 0) caveats.push(`tables whose workspace_id type cannot be compared were not erased: ${inv.unsupported.join(', ')}`);
        if (inv.unknownScoped.length > 0) caveats.push(`tables with workspace-like columns Lore does not know how to erase: ${inv.unknownScoped.join(', ')}`);
        if (cursor > 0) caveats.push('the edge-migration cursor still names this workspace (global migration state, left untouched)');
        if (aborted) caveats.push('erase was aborted before it finished');
        const detail = (caveats.join('; ') + vacuumNote).trim() || undefined;

        let status: EraseStepResult['status'];
        if (left > 0) status = 'partial';
        else if (caveats.length > 0) status = 'unverifiable';
        else if (!startedWithData) status = 'not-applicable';
        else status = 'complete';
        const result: EraseStepResult = { store: 'postgres', status, removed, remaining };
        if (detail) result.detail = detail;
        return result;
    }

    return {
        store: 'postgres',
        erase,
        close: async () => {
            if (dedicated) { const p = dedicated; dedicated = null; await closePostgresPool(p); }
            else if (ownsShared) await closeSharedPostgresPool();
        },
    };
}

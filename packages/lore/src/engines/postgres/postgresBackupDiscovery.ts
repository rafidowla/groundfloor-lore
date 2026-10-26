/**
 * postgresBackupDiscovery.ts — find, from the database itself, every table
 * that belongs to a workspace and everything a logical backup/restore needs
 * to know about it.
 *
 * WHY DISCOVERY AND NOT A LIST: several lanes keep adding tables (edge
 * surrogate ids, per-workspace partitioned vectors, `lore_ingest_*` jobs). A
 * hard-coded list silently misses the next one, and "the backup succeeded"
 * without a table is exactly the failure this module exists to prevent. The
 * contract instead is structural:
 *
 *   - a table with a `workspace_id` column is workspace data -> exported;
 *   - a table WITHOUT one is reported as `excluded` with a reason (never
 *     silently dropped), so an operator can see what a backup does not carry;
 *   - partitions are never listed on their own: the partitioned PARENT is
 *     exported/restored (filtered by `workspace_id`, so partition pruning does
 *     the work), and the restore side provisions the target's partition.
 *
 * Surrogate numeric ids (identity / serial columns) and the columns that
 * point at them are discovered too, because restoring next to other
 * workspaces must not collide with their ids. A referencing column is found
 * through a declared FOREIGN KEY, or — for references the schema cannot
 * declare — a column comment of the form `lore:references <table>.<column>`
 * (see {@link REFERENCE_COMMENT_PREFIX}).
 *
 * All catalog reads are plain SELECTs, safe inside a READ ONLY transaction.
 */

import * as crypto from 'node:crypto';
import type { PoolClient } from 'pg';

/** Column that scopes a row to a workspace. The one convention the whole engine shares. */
export const WORKSPACE_COLUMN = 'workspace_id';

/**
 * Column-comment marker for a reference to another table's surrogate id that
 * the schema does not (or cannot) declare as a FOREIGN KEY, e.g.
 * `COMMENT ON COLUMN edges.src_nid IS 'lore:references nodes.nid'`.
 */
export const REFERENCE_COMMENT_PREFIX = 'lore:references ';

/** Types a `workspace_id` may have: the ones an equality parameter and a cast both round-trip. */
const WORKSPACE_ID_TYPES = /^(text|character varying(\(\d+\))?|uuid)$/;

export interface BackupColumn {
    name: string;
    /** `format_type` of the column, e.g. `text`, `double precision`, `vector(384)`. */
    type: string;
    notNull: boolean;
    /** Column has a default (or is identity) — an extra target column with one may be left unset on restore. */
    hasDefault: boolean;
}

export interface ColumnReference {
    column: string;
    refTable: string;
    refColumn: string;
    source: 'foreign_key' | 'comment';
}

export interface BackupTable {
    /** Unqualified table name. */
    name: string;
    /** Schema-qualified, quoted identifier, ready to splice into SQL. */
    qualified: string;
    partitioned: boolean;
    /** `format_type` of the table's `workspace_id`. */
    workspaceIdType: string;
    /** Exported columns, in attnum order, EXCLUDING `workspace_id` and generated columns. */
    columns: BackupColumn[];
    /** Generated (computed) columns — recomputed by the server, never exported. */
    generatedColumns: string[];
    /** Identity / serial integer columns (surrogate ids). */
    identityColumns: string[];
    /** Columns holding another table's surrogate id. */
    references: ColumnReference[];
    /** Tables (names) this one has a declared FOREIGN KEY to; used for load/delete ordering. */
    dependsOn: string[];
}

/**
 * Tables that carry `workspace_id` but are migration scaffolding, not workspace data: a copy of the same rows
 * under a different shape (so exporting it would double-restore), kept only until an operator drops it.
 * `edges_dangling` is NOT here: quarantined legacy edges are data the operator still has to resolve, so they are backed up.
 */
const TRANSIENT_TABLES: Record<string, string> = {
    edges_next: 'edge surrogate-key migration staging table (a partial copy of edges) - not workspace data',
    verbatim_common_lexemes: 'derived BM25 common-token stop-list (rebuilt from text_tsv) - not workspace data',
    verbatim_common_lexemes_meta: 'derived BM25 common-token stop-list metadata (rebuilt from text_tsv) - not workspace data',
    edges_pre_pk: 'pre-surrogate-key rollback copy of edges, kept until dropPrePkEdges - superseded by edges',
    lore_pg_rekey_ledger: 'database-wide record of the one-time name-to-permanent-id row rewrite - not workspace data',
};

export interface ExcludedTable {
    table: string;
    reason: string;
}

export interface DiscoveredWorkspaceSchema {
    schema: string;
    tables: BackupTable[];
    excluded: ExcludedTable[];
    /** sha256 over the included tables' structure — changes whenever a column/type/table does. */
    fingerprint: string;
}

/** Quote an SQL identifier. */
export function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a SQL string literal (for the few places a value cannot be a parameter, e.g. DDL). */
export function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

interface RelRow { oid: string; relname: string; relkind: string }
interface AttRow {
    attrelid: string; attnum: number; attname: string; type: string; attnotnull: boolean;
    attidentity: string; attgenerated: string; default_expr: string | null; comment: string | null;
}
interface FkRow { conrelid: string; confrelid: string; conkey: number[]; confkey: number[] }

/**
 * discoverWorkspaceSchema — read the catalog and classify every ordinary and
 * partitioned table in `schema` (default: the connection's current schema).
 */
export async function discoverWorkspaceSchema(client: PoolClient, schema?: string): Promise<DiscoveredWorkspaceSchema> {
    const schemaName = schema ?? (await client.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]?.s;
    if (!schemaName) throw new Error('postgres backup: no current schema (empty search_path) — pass a schema explicitly');

    const rels = (await client.query<RelRow>(
        `SELECT c.oid::text AS oid, c.relname, c.relkind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
            AND NOT EXISTS (SELECT 1 FROM pg_depend d
                             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
          ORDER BY c.relname`,
        [schemaName],
    )).rows;
    if (rels.length === 0) return { schema: schemaName, tables: [], excluded: [], fingerprint: fingerprintOf([], []) };

    const oids = rels.map((r) => r.oid);
    const atts = (await client.query<AttRow>(
        `SELECT a.attrelid::text AS attrelid, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull, a.attidentity::text AS attidentity, a.attgenerated::text AS attgenerated,
                pg_get_expr(d.adbin, d.adrelid) AS default_expr, col_description(a.attrelid, a.attnum) AS comment
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attrelid, a.attnum`,
        [oids],
    )).rows;
    const fks = (await client.query<FkRow>(
        `SELECT conrelid::text AS conrelid, confrelid::text AS confrelid, conkey, confkey
           FROM pg_constraint WHERE contype = 'f' AND conparentid = 0 AND conrelid = ANY($1::oid[])`,
        [oids],
    )).rows;

    const attsByRel = new Map<string, AttRow[]>();
    for (const a of atts) {
        const list = attsByRel.get(a.attrelid) ?? [];
        list.push(a);
        attsByRel.set(a.attrelid, list);
    }
    const nameByOid = new Map(rels.map((r) => [r.oid, r.relname] as const));
    const attName = (oid: string, num: number): string | undefined =>
        attsByRel.get(oid)?.find((a) => a.attnum === num)?.attname;

    const tables: BackupTable[] = [];
    const excluded: ExcludedTable[] = [];
    for (const rel of rels) {
        const all = attsByRel.get(rel.oid) ?? [];
        const transient = TRANSIENT_TABLES[rel.relname];
        if (transient !== undefined) {
            excluded.push({ table: rel.relname, reason: transient });
            continue;
        }
        const ws = all.find((a) => a.attname === WORKSPACE_COLUMN);
        if (!ws) {
            excluded.push({ table: rel.relname, reason: `no ${WORKSPACE_COLUMN} column — not workspace-scoped, so a per-workspace backup cannot select its rows` });
            continue;
        }
        if (!WORKSPACE_ID_TYPES.test(ws.type)) {
            excluded.push({ table: rel.relname, reason: `${WORKSPACE_COLUMN} has unsupported type ${ws.type} (need text, varchar or uuid)` });
            continue;
        }
        const generatedColumns: string[] = [];
        const columns: BackupColumn[] = [];
        const identityColumns: string[] = [];
        for (const a of all) {
            if (a.attname === WORKSPACE_COLUMN) continue;
            if (a.attgenerated !== '') { generatedColumns.push(a.attname); continue; }
            const isIdentity = a.attidentity !== '' || /^nextval\(/.test(a.default_expr ?? '');
            if (isIdentity && /^(smallint|integer|bigint)$/.test(a.type)) identityColumns.push(a.attname);
            columns.push({ name: a.attname, type: a.type, notNull: a.attnotnull, hasDefault: a.default_expr !== null || a.attidentity !== '' });
        }
        const references: ColumnReference[] = [];
        const dependsOn = new Set<string>();
        for (const fk of fks.filter((f) => f.conrelid === rel.oid)) {
            const refTable = nameByOid.get(fk.confrelid);
            if (refTable === undefined) continue; // points outside the scanned schema: no ordering/remap to do
            if (refTable !== rel.relname) dependsOn.add(refTable);
            fk.conkey.forEach((num, i) => {
                const column = attName(rel.oid, num);
                const refColumn = attName(fk.confrelid, fk.confkey[i] ?? -1);
                if (column && refColumn) references.push({ column, refTable, refColumn, source: 'foreign_key' });
            });
        }
        for (const a of all) {
            if (!a.comment?.startsWith(REFERENCE_COMMENT_PREFIX)) continue;
            const m = /^([^.\s]+)\.([^.\s]+)$/.exec(a.comment.slice(REFERENCE_COMMENT_PREFIX.length).trim());
            if (!m) continue;
            if (!references.some((r) => r.column === a.attname)) {
                references.push({ column: a.attname, refTable: m[1]!, refColumn: m[2]!, source: 'comment' });
            }
            if (m[1] !== rel.relname) dependsOn.add(m[1]!);
        }
        tables.push({
            name: rel.relname,
            qualified: `${quoteIdent(schemaName)}.${quoteIdent(rel.relname)}`,
            partitioned: rel.relkind === 'p',
            workspaceIdType: ws.type,
            columns, generatedColumns, identityColumns, references,
            dependsOn: [...dependsOn].sort(),
        });
    }
    return { schema: schemaName, tables, excluded, fingerprint: fingerprintOf(tables, excluded) };
}

function fingerprintOf(tables: BackupTable[], excluded: ExcludedTable[]): string {
    const shape = tables.map((t) => [t.name, t.partitioned, t.workspaceIdType, t.columns.map((c) => [c.name, c.type]), t.generatedColumns]);
    return crypto.createHash('sha256').update(JSON.stringify({ shape, excluded: excluded.map((e) => e.table) })).digest('hex');
}

/**
 * Tables ordered parents-before-children by declared dependency (stable
 * alphabetical otherwise). A cycle is broken by name order rather than
 * refused — FKs in a cycle must be DEFERRABLE to load at all, and the
 * database says so loudly when they are not.
 */
export function loadOrder(tables: BackupTable[]): BackupTable[] {
    const byName = new Map(tables.map((t) => [t.name, t] as const));
    const done = new Set<string>();
    const visiting = new Set<string>();
    const out: BackupTable[] = [];
    const visit = (t: BackupTable): void => {
        if (done.has(t.name) || visiting.has(t.name)) return;
        visiting.add(t.name);
        for (const dep of t.dependsOn) {
            const parent = byName.get(dep);
            if (parent) visit(parent);
        }
        visiting.delete(t.name);
        done.add(t.name);
        out.push(t);
    };
    [...tables].sort((a, b) => a.name.localeCompare(b.name)).forEach(visit);
    return out;
}

/** Installed pgvector version, or null when the extension is absent. */
export async function pgvectorVersion(client: PoolClient): Promise<string | null> {
    const res = await client.query<{ v: string }>(`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`);
    return res.rows[0]?.v ?? null;
}

/** Server version string, e.g. `16.4`. */
export async function serverVersion(client: PoolClient): Promise<string> {
    const res = await client.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
    return res.rows[0]?.v ?? 'unknown';
}

/**
 * Session settings that make every value's TEXT form identical on export,
 * verification and restore (time zone, date/interval style, float precision,
 * bytea encoding), plus the timeouts a long bulk copy would otherwise trip
 * (the shared pool sets a 30 s statement timeout and 60 s idle-in-transaction
 * timeout). `SET LOCAL`: dies with the transaction, never leaks into the pool.
 */
export const BACKUP_SESSION_SETTINGS: readonly string[] = [
    `SET LOCAL statement_timeout = 0`,
    `SET LOCAL idle_in_transaction_session_timeout = 0`,
    `SET LOCAL TimeZone = 'UTC'`,
    `SET LOCAL DateStyle = 'ISO, YMD'`,
    `SET LOCAL IntervalStyle = 'iso_8601'`,
    `SET LOCAL extra_float_digits = 3`,
    `SET LOCAL bytea_output = 'hex'`,
];

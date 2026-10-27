/**
 * postgresRekey.ts — one-time rewrite of Postgres rows from workspace NAME to PERMANENT workspace id.
 *
 * Before this migration every `workspace_id` column held the workspace NAME (see postgresWorkspaceKey.ts for why
 * that was unsafe). {@link ensureRekeyed} runs when a store opens with a key that came from the registry:
 *
 *   - Targets: every registry workspace (live) and every deleted (held) workspace recorded in the deletion log
 *     (postgresRekeyPlan.ts). Deleted workspaces are re-keyed too, under their RECORDED id, so a later erase can
 *     find their rows.
 *   - Scope: every ordinary / partitioned table that has a text `workspace_id` column, found from the catalog
 *     (so a new table is covered without editing a list), scaffolding tables included.
 *   - One transaction per workspace across all of its tables: `UPDATE t SET workspace_id = <id> WHERE workspace_id
 *     = <name>`. Foreign keys that include `workspace_id` are made deferrable inside the transaction only. A
 *     list-partitioned table (`verbatim`) gets the id's partition first; the emptied name partition is dropped.
 *     Per-workspace table views (`lore_tv_*`, which bake the key in as a literal) are rebuilt.
 *   - Recorded in `lore_pg_rekey_ledger` (inside the same transaction), so it runs once per workspace.
 *   - MIXED-KEY GUARD: if rows exist under BOTH a workspace's name and its id, nothing for that workspace is
 *     changed and {@link PostgresRekeyConflictError} says which tables. A conflict on the workspace being opened
 *     is thrown; a conflict on some other workspace is logged and left for its own open.
 *   - Rows under a key that is neither a registry id nor a registry name are left alone and counted in a log line.
 *   - Idempotent: a recorded workspace is skipped; a re-run after a crash finds nothing under the name.
 *
 * Runs under the schema advisory lock (runSchemaBootstrap), AFTER the store's own schema DDL. A process that
 * still runs an older build against the same database would write name-keyed rows again; upgrade every process.
 */

import type { Pool, PoolClient } from 'pg';
import { log } from '../../logger.js';
import { quoteIdent, quoteLiteral, WORKSPACE_COLUMN, type BackupTable } from './postgresBackupDiscovery.js';
import { buildRekeyPlan, type RekeyPlan, type RekeyTarget } from './postgresRekeyPlan.js';
import { runSchemaBootstrap } from './postgresStartup.js';
import { loadCatalog } from './postgresTableCatalog.js';
import { TABLE_TABLES } from './postgresTableSchema.js';
import { viewDdl } from './postgresTableViews.js';
import { ensureWorkspacePartition } from './postgresWorkspacePartitions.js';
import { registryHomeForKey } from './postgresWorkspaceKey.js';

export const REKEY_LEDGER_TABLE = 'lore_pg_rekey_ledger';
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${REKEY_LEDGER_TABLE} (
    key_id TEXT PRIMARY KEY,
    rekeyed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rows_moved BIGINT NOT NULL DEFAULT 0,
    by_table JSONB NOT NULL DEFAULT '{}'::jsonb
)`;

/** Rows exist under both a workspace's name and its permanent id: refuse rather than merge. */
export class PostgresRekeyConflictError extends Error {
    public readonly code = 'postgres_rekey_mixed_keys' as const;
    constructor(public readonly id: string, public readonly tables: string[], public readonly names: string[], afterRekey = false) {
        super(afterRekey
            ? `Postgres rows for workspace id '${id}' were written under its old name (${names.map((n) => `'${n}'`).join(', ')}) after it was re-keyed to its permanent id `
                + `(tables: ${tables.join(', ')}); a process on an older Lore build is probably still writing to this database. Stop it and upgrade it. `
                + `Lore will not merge the rows; nothing was changed. Decide which set is current, remove the other, and reopen.`
            : `Postgres rows for workspace id '${id}' exist under BOTH its name (${names.map((n) => `'${n}'`).join(', ')}) and its permanent id `
                + `(tables: ${tables.join(', ')}). Lore will not merge them; nothing was changed. Decide which set is current, remove the other, and reopen.`);
        this.name = 'PostgresRekeyConflictError';
    }
}

interface KeyedTable { name: string; qualified: string; partitioned: boolean; oid: string }

const doneKeys = new WeakMap<Pool, Set<string>>();
const inflight = new WeakMap<Pool, Map<string, Promise<void>>>();

/**
 * Re-key the rows of every registry workspace to its permanent id (see file header). No-op when `key` did not
 * come from the registry resolver, or when everything is already recorded. Safe to call on every open.
 */
export async function ensureRekeyed(pool: Pool, key: string): Promise<void> {
    const home = registryHomeForKey(key);
    if (home === undefined) return;
    let done = doneKeys.get(pool);
    if (!done) { done = new Set(); doneKeys.set(pool, done); }
    if (done.has(key)) return;
    let flights = inflight.get(pool);
    if (!flights) { flights = new Map(); inflight.set(pool, flights); }
    const id = `${home}\0${key}`;
    let p = flights.get(id);
    if (!p) {
        p = run(pool, home, key).then(() => { done!.add(key); }).finally(() => { flights!.delete(id); });
        flights.set(id, p);
    }
    await p;
}

async function run(pool: Pool, home: string, key: string): Promise<void> {
    const plan = buildRekeyPlan(home);
    await runSchemaBootstrap(pool, {}, (client) => migrate(client, plan, key));
}

async function currentSchema(client: PoolClient): Promise<string> {
    return (await client.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
}

async function discoverKeyedTables(client: PoolClient, schema: string): Promise<KeyedTable[]> {
    const r = await client.query<{ relname: string; relkind: string; oid: string }>(
        `SELECT c.relname, c.relkind::text AS relkind, c.oid::text AS oid
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
            AND format_type(a.atttypid, a.atttypmod) ~ '^(text|character varying(\\(\\d+\\))?)$'
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
          ORDER BY c.relname`,
        [schema, WORKSPACE_COLUMN]);
    return r.rows.map((x) => ({ name: x.relname, qualified: `${quoteIdent(schema)}.${quoteIdent(x.relname)}`, partitioned: x.relkind === 'p', oid: x.oid }));
}

/** table name -> (key -> row count) for the given keys, one pass per table. */
async function observe(client: PoolClient, tables: KeyedTable[], keys: string[]): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    for (const t of tables) {
        const r = await client.query<{ k: string; n: string }>(
            `SELECT ${WORKSPACE_COLUMN}::text AS k, count(*)::text AS n FROM ${t.qualified} WHERE ${WORKSPACE_COLUMN} = ANY($1::text[]) GROUP BY 1`, [keys]);
        if (r.rows.length > 0) out.set(t.name, new Map(r.rows.map((x) => [x.k, Number(x.n)])));
    }
    return out;
}

/** One round trip: per keyed table, rows under any of the (recorded) workspace's old names. Any hit refuses the open; nothing is changed. */
async function refuseNameKeyedStragglers(client: PoolClient, tables: KeyedTable[], t: RekeyTarget): Promise<void> {
    if (tables.length === 0) return;
    const sql = tables.map((x, i) => `(SELECT ${i}::int AS i FROM ${x.qualified} WHERE ${WORKSPACE_COLUMN} = ANY($1::text[]) LIMIT 1)`).join(' UNION ALL ');
    const hit = (await client.query<{ i: number }>(sql, [t.names])).rows.map((r) => tables[r.i]!.name).sort();
    if (hit.length > 0) throw new PostgresRekeyConflictError(t.id, hit, t.names, true);
}

async function migrate(client: PoolClient, plan: RekeyPlan, openedKey: string): Promise<void> {
    if (plan.targets.length === 0) return;
    await client.query(LEDGER_DDL);
    const recorded = new Set((await client.query<{ key_id: string }>(`SELECT key_id FROM ${REKEY_LEDGER_TABLE}`)).rows.map((r) => r.key_id));
    const pending = plan.targets.filter((t) => !recorded.has(t.id));
    // Already re-keyed, but the workspace being opened may have name-keyed rows again (an older build wrote them after the upgrade).
    const recheck = plan.targets.find((t) => t.id === openedKey && recorded.has(t.id) && t.names.length > 0);
    if (pending.length === 0 && recheck === undefined) return;

    const schema = await currentSchema(client);
    const tables = await discoverKeyedTables(client, schema);
    if (recheck !== undefined) await refuseNameKeyedStragglers(client, tables, recheck);
    if (pending.length === 0) return;
    if ((await client.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${quoteIdent(schema)}.edges_pk_progress`])).rows[0]?.ok) {
        throw new Error('postgres re-key: an edge surrogate-key migration is still in progress (edges_pk_progress exists); finish it by reopening a workspace on the previous build, then retry');
    }
    const allKeys = [...new Set(pending.flatMap((t) => [t.id, ...t.names]))];
    const seen = await observe(client, tables, allKeys);

    let migratedWorkspaces = 0;
    let rowsMoved = 0;
    for (const t of pending) {
        const nameTables = tables.filter((x) => t.names.some((n) => (seen.get(x.name)?.get(n) ?? 0) > 0));
        const idTables = tables.filter((x) => (seen.get(x.name)?.get(t.id) ?? 0) > 0);
        if (nameTables.length > 0 && idTables.length > 0) {
            const err = new PostgresRekeyConflictError(t.id, [...new Set([...nameTables, ...idTables].map((x) => x.name))].sort(), t.names);
            if (t.id === openedKey) throw err;
            log.warn(`[pg-rekey] ${err.message}`);
            continue;
        }
        const moved = await rekeyOne(client, schema, tables, nameTables, t);
        migratedWorkspaces++;
        rowsMoved += moved;
    }

    // Rows under a key that is no registry id (a name nobody claims, or another tool's key): left alone, counted.
    if (rowsMoved > 0) {
        let strays = 0;
        for (const t of tables) {
            const r = await client.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM ${t.qualified} WHERE ${WORKSPACE_COLUMN} <> ALL($1::text[])`, [plan.knownIds]);
            strays += Number(r.rows[0]?.n ?? '0');
        }
        log.info(`[pg-rekey] re-keyed ${migratedWorkspaces} workspace(s), ${rowsMoved} row(s), from workspace name to permanent id; `
            + `${strays} row(s) under a key that matches no registry workspace id were left untouched`
            + (plan.shadowed.length > 0 ? `; ${plan.shadowed.length} deleted workspace(s) share a name with another workspace, whose rows went to the other one` : ''));
    }
}

async function rekeyOne(client: PoolClient, schema: string, all: KeyedTable[], nameTables: KeyedTable[], t: RekeyTarget): Promise<number> {
    const byTable: Record<string, number> = {};
    let total = 0;
    await client.query('BEGIN');
    try {
        await client.query(`SET LOCAL statement_timeout = 0`);
        await client.query(`SET LOCAL lock_timeout = '60s'`);
        const altered = nameTables.length > 0 ? await deferForeignKeys(client, schema, all) : [];
        for (const tbl of nameTables) {
            // The provisioner knows each table's partition naming (verbatim has its own), so no special case here.
            if (tbl.partitioned) await ensureWorkspacePartition(client, { name: tbl.name, qualified: tbl.qualified, partitioned: true } as unknown as BackupTable, t.id);
        }
        for (const tbl of nameTables) {
            const r = await client.query(`UPDATE ${tbl.qualified} SET ${WORKSPACE_COLUMN} = $1 WHERE ${WORKSPACE_COLUMN} = ANY($2::text[])`, [t.id, t.names]);
            byTable[tbl.name] = r.rowCount ?? 0;
            total += r.rowCount ?? 0;
        }
        if (altered.length > 0) await restoreForeignKeys(client, altered);
        for (const tbl of nameTables.filter((x) => x.partitioned)) await dropEmptyNamePartitions(client, schema, tbl, t.names);
        await rebuildViews(client, schema, t.id);
        await client.query(
            `INSERT INTO ${REKEY_LEDGER_TABLE} (key_id, rows_moved, by_table) VALUES ($1, $2, $3::jsonb) ON CONFLICT (key_id) DO NOTHING`,
            [t.id, total, JSON.stringify(byTable)]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
    }
    return total;
}

interface AlteredFk { rel: string; name: string }

/** Make every non-deferrable foreign key that touches a workspace table deferrable for this transaction, and defer all. */
async function deferForeignKeys(client: PoolClient, schema: string, tables: KeyedTable[]): Promise<AlteredFk[]> {
    const oids = tables.map((x) => x.oid);
    const r = await client.query<{ rel: string; name: string; deferrable: boolean }>(
        `SELECT format('%I.%I', n.nspname, cl.relname) AS rel, con.conname AS name, con.condeferrable AS deferrable
           FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE con.contype = 'f' AND n.nspname = $1 AND con.conparentid = 0
            AND (con.conrelid = ANY($2::oid[]) OR con.confrelid = ANY($2::oid[]))`,
        [schema, oids]);
    const altered: AlteredFk[] = [];
    for (const fk of r.rows) {
        if (fk.deferrable) continue;
        await client.query(`ALTER TABLE ${fk.rel} ALTER CONSTRAINT ${quoteIdent(fk.name)} DEFERRABLE INITIALLY IMMEDIATE`);
        altered.push({ rel: fk.rel, name: fk.name });
    }
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    return altered;
}

async function restoreForeignKeys(client: PoolClient, altered: AlteredFk[]): Promise<void> {
    await client.query('SET CONSTRAINTS ALL IMMEDIATE'); // fires the deferred checks now, so a violation rolls the whole workspace back
    for (const fk of altered) await client.query(`ALTER TABLE ${fk.rel} ALTER CONSTRAINT ${quoteIdent(fk.name)} NOT DEFERRABLE`);
}

/** The name-keyed list partition of a partitioned table is empty after the move: detach and drop it. */
async function dropEmptyNamePartitions(client: PoolClient, schema: string, t: KeyedTable, names: string[]): Promise<void> {
    for (const name of names) {
        const p = await client.query<{ relname: string }>(
            `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
              WHERE i.inhparent = $1::regclass AND pg_get_expr(c.relpartbound, c.oid) = $2`,
            [t.qualified, `FOR VALUES IN (${quoteLiteral(name)})`]);
        const part = p.rows[0]?.relname;
        if (!part) continue;
        const q = `${quoteIdent(schema)}.${quoteIdent(part)}`;
        const left = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${q}`)).rows[0]?.n ?? '0');
        if (left > 0) throw new Error(`postgres re-key: partition ${part} of ${t.name} still holds ${left} row(s) after the move; refusing to drop it`);
        await client.query(`ALTER TABLE ${t.qualified} DETACH PARTITION ${q}`);
        await client.query(`DROP TABLE ${q}`);
    }
}

/** Per-workspace read views bake the key in as a literal: recreate them for the id. */
async function rebuildViews(client: PoolClient, schema: string, id: string): Promise<void> {
    const has = await client.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${quoteIdent(schema)}.${quoteIdent(TABLE_TABLES.entityType)}`]);
    if (!has.rows[0]?.ok) return;
    const cat = await loadCatalog(client, id);
    for (const meta of cat.values()) await client.query(viewDdl(id, meta));
}

/**
 * postgresTableStorage.ts - Postgres ITableStorage (Tables phase P1, slice 1).
 *
 * Rows are narrow `lore_entity_value` rows under a `lore_entity` header (see
 * postgresTableSchema.ts); reads go through generated per-type views
 * (postgresTableViews.ts) so a table reads like an ordinary typed table and
 * joins to `nodes` / other tables in ONE statement. The store is BOUND to one
 * workspace: `workspace_id` leads every key and is baked into every view, so no
 * query can cross the boundary.
 *
 * VALID-time "as of D" (`queryAsOf`) is a SQL predicate on the entity header
 * applied BEFORE `LIMIT` - never a page filter. Recorded time lives on the value
 * rows (an update supersedes, never overwrites); a recorded-time as-of is slice 2.
 *
 * Schema cache: `schemas` is public and loaded at `open()` because ingestion's
 * tableWriter reads `storage.schemas.get(table)` synchronously. A table created
 * by ANOTHER process becomes visible on the next unknown-table miss (one reload).
 */

import type { Pool } from 'pg';
import type {
    BackendCapabilities, DestructiveWriteOptions, EvolutionStep, ITableStorage, JoinHop, JoinQuery, JoinSpec,
    ListTablesOptions, Row, TableOp, TableOpResult, TableSchema, TableSchemaSummary,
} from '../../contracts/tables.js';
import { MAX_JOIN_HOPS } from '../../contracts/tables.js';
import type { FilterNode, FindOptions } from '../collectionStorage.js';
import { listSqliteTables } from '../sqliteTableList.js';
import { assertIdent } from '../whereClause.js';
import { withTransaction } from './postgresClient.js';
import { sharedPostgresPool } from './postgresPoolOwner.js';
import { runSchemaBootstrap } from './postgresStartup.js';
import { ensureGraphSchema } from './postgresGraphSchema.js';
import { TABLE_TABLES, tableSchemaDdl } from './postgresTableSchema.js';
import { buildMeta, flagsOf, loadCatalog, pickPrimary, sameSchema, validateSchema, type TableMeta } from './postgresTableCatalog.js';
import { fieldIndexDdl, qi, viewDdl } from './postgresTableViews.js';
import { decodePgRow, encodePgValue, selectExpr, type Encoded } from './postgresTableCodec.js';
import { buildPgWhere } from './postgresTableWhere.js';
import { deleteRows, insertRows, runOps, truncateRows, updateRows, type WriteCtx } from './postgresTableWrites.js';
import { evolveTable } from './postgresTableEvolve.js';

const L = 'PostgresTableStorage';
const DEFAULT_LIMIT = 10_000;

export interface AsOfOptions { asOf?: Date | string }

export class PostgresTableStorage implements ITableStorage {
    /** Declared schemas by table name (public: tableWriter / introspection read it synchronously). */
    readonly schemas = new Map<string, TableSchema>();
    private metas = new Map<string, TableMeta>();

    private constructor(private readonly pool: Pool, readonly workspace: string) {}

    /** Open (bootstrapping the schema if needed) a store bound to `workspace`. Throws if LORE_PG_URL is unset. */
    static async open(workspace: string, pool: Pool = sharedPostgresPool()): Promise<PostgresTableStorage> {
        if (!workspace) throw new Error(`${L}.open: workspace is required`);
        await runSchemaBootstrap(pool, {}, async (client) => {
            await ensureGraphSchema(client, workspace); // lore_entity.memory_node_sk references nodes(sk)
            for (const stmt of tableSchemaDdl()) await client.query(stmt);
        });
        const s = new PostgresTableStorage(pool, workspace);
        await s.reload();
        return s;
    }

    capabilities(): BackendCapabilities {
        return { join: true, maxJoinHops: MAX_JOIN_HOPS, caseSensitiveContains: true, extractedJsonFields: false, additiveSchemaEvolution: true };
    }

    // ---- schema cache ----------------------------------------------------

    private async reload(): Promise<void> {
        const cat = await loadCatalog(this.pool, this.workspace);
        this.metas = cat;
        this.schemas.clear();
        for (const [n, m] of cat) this.schemas.set(n, m.schema);
    }

    private remember(meta: TableMeta): void {
        this.metas.set(meta.schema.name, meta);
        this.schemas.set(meta.schema.name, meta.schema);
    }

    private async ensure(...tables: string[]): Promise<void> {
        if (tables.some(t => !this.metas.has(t))) await this.reload();
    }

    private meta(table: string, op: string): TableMeta {
        const m = this.metas.get(table);
        if (!m) throw new Error(`${L}.${op}: unknown table '${table}' (createTable first)`);
        return m;
    }

    private ctx(client: WriteCtx['client']): WriteCtx {
        return { client, workspace: this.workspace, meta: (t, op) => this.meta(t, op) };
    }

    /** The read view for `table`: a typed relation callers may join to `nodes` or each other in raw SQL. */
    async readView(table: string): Promise<string> {
        await this.ensure(table);
        return this.meta(table, 'readView').view;
    }

    // ---- DDL ---------------------------------------------------------------

    async createTable(schema: TableSchema): Promise<void> {
        validateSchema(schema);
        const meta = await withTransaction(this.pool, async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lore_tables:${this.workspace}`]);
            const existing = (await loadCatalog(client, this.workspace, schema.name)).get(schema.name);
            if (existing) {
                if (sameSchema(existing.schema, schema)) return existing;
                throw new Error(`${L}.createTable: table '${schema.name}' already exists with a different shape (migration required - use evolveSchema for additive changes)`);
            }
            const t = await client.query(
                `INSERT INTO ${TABLE_TABLES.entityType} (workspace_id, name, description) VALUES ($1, $2, $3) RETURNING entity_type_id`,
                [this.workspace, schema.name, schema.description ?? null]);
            const typeId = Number((t.rows[0] as { entity_type_id: string }).entity_type_id);
            const ids = new Map<string, number>();
            for (let i = 0; i < schema.columns.length; i++) {
                const c = schema.columns[i]!;
                const f = await client.query(
                    `INSERT INTO ${TABLE_TABLES.fieldDef} (workspace_id, entity_type_id, name, data_type, flags, position, decl_json)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING field_id`,
                    [this.workspace, typeId, c.name, c.type, flagsOf(c), i, JSON.stringify(c)]);
                ids.set(c.name, Number((f.rows[0] as { field_id: string }).field_id));
            }
            const m = buildMeta(typeId, schema, ids);
            for (const c of schema.columns) for (const ddl of fieldIndexDdl(ids.get(c.name)!, c)) await client.query(ddl);
            await client.query(viewDdl(this.workspace, m));
            return m;
        });
        this.remember(meta);
    }

    async listTables(opts: ListTablesOptions = {}): Promise<TableSchemaSummary[]> {
        await this.reload();
        return listSqliteTables({ schemas: this.schemas, count: t => this.count(t), pickPrimary }, opts);
    }

    async evolveSchema(name: string, newSchema: TableSchema): Promise<EvolutionStep[]> {
        await this.ensure(name);
        const { steps, meta } = await withTransaction(this.pool, async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lore_tables:${this.workspace}`]);
            const fresh = (await loadCatalog(client, this.workspace, name)).get(name);
            if (!fresh) throw new Error(`${L}.evolveSchema: unknown table '${name}' (createTable first)`);
            return evolveTable(client, this.workspace, fresh, name, newSchema);
        });
        this.remember(meta);
        return steps;
    }

    // ---- writes ------------------------------------------------------------

    async insert(table: string, row: Row): Promise<void> {
        await this.ensure(table);
        await withTransaction(this.pool, async (c) => { await insertRows(this.ctx(c), table, [row], 'insert'); });
    }

    async insertBatch(table: string, rows: Row[]): Promise<void> {
        await this.ensure(table);
        if (rows.length === 0) { this.meta(table, 'insertBatch'); return; }
        await withTransaction(this.pool, async (c) => { await insertRows(this.ctx(c), table, rows, 'insertBatch'); });
    }

    async update(table: string, filter: FilterNode, patch: Partial<Row>, opts?: DestructiveWriteOptions): Promise<number> {
        await this.ensure(table);
        return withTransaction(this.pool, (c) => updateRows(this.ctx(c), table, filter, patch, 'update', opts));
    }

    async delete(table: string, filter: FilterNode, opts?: DestructiveWriteOptions): Promise<number> {
        await this.ensure(table);
        return withTransaction(this.pool, (c) => deleteRows(this.ctx(c), table, filter, 'delete', opts));
    }

    async truncate(table: string): Promise<number> {
        await this.ensure(table);
        return withTransaction(this.pool, (c) => truncateRows(this.ctx(c), table));
    }

    async runTransaction(ops: TableOp[]): Promise<TableOpResult[]> {
        await this.ensure(...ops.map(o => o.collection));
        return withTransaction(this.pool, (c) => runOps(this.ctx(c), ops));
    }

    // ---- reads -------------------------------------------------------------

    private selectList(meta: TableMeta, alias = 'v'): string {
        return meta.schema.columns.map(c => `${selectExpr(`${alias}.${qi(c.name)}`, c.type)} AS ${qi(c.name)}`).join(', ');
    }

    private async select(table: string, op: string, filter: FilterNode | undefined, opts: FindOptions | undefined, asOf?: Date | string): Promise<Row[]> {
        await this.ensure(table);
        const meta = this.meta(table, op);
        const types = new Map(meta.schema.columns.map(c => [c.name, c.type] as const));
        const built = buildPgWhere(filter, { qualify: k => `v.${qi(k)}`, typeOf: k => types.get(k) });
        const params: Encoded[] = [...built.params];
        let where = built.where;
        if (asOf !== undefined) {
            params.push(encodePgValue(asOf, 'datetime', 'asOf'));
            const p = `$${params.length}::timestamptz`;
            const pred = `(v._lore_valid_from IS NULL OR v._lore_valid_from <= ${p}) AND (v._lore_valid_to IS NULL OR v._lore_valid_to > ${p})`;
            where = where ? `${where} AND ${pred}` : `WHERE ${pred}`;
        }
        let order = 'ORDER BY v._lore_entity_id';
        if (opts?.orderBy) {
            assertIdent(opts.orderBy);
            const ct = types.get(opts.orderBy);
            if (!ct) throw new Error(`${L}.${op}: unknown orderBy column '${opts.orderBy}' on table '${table}'`);
            const desc = opts.orderDir === 'desc';
            const col = ct === 'string' ? `v.${qi(opts.orderBy)} COLLATE "C"` : `v.${qi(opts.orderBy)}`;
            order = `ORDER BY ${col} ${desc ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}, v._lore_entity_id`;
        }
        const limit = typeof opts?.limit === 'number' ? opts.limit : DEFAULT_LIMIT;
        let sql = `SELECT ${this.selectList(meta)} FROM ${meta.view} v ${where} ${order}`;
        if (Number.isFinite(limit)) sql += ` LIMIT ${Math.max(0, Math.floor(limit))}`;
        const r = await this.pool.query(sql, params);
        return (r.rows as Row[]).map(row => decodePgRow(row, meta.schema.columns));
    }

    async query(table: string, filter?: FilterNode, opts?: FindOptions): Promise<Row[]> {
        return this.select(table, 'query', filter, opts);
    }

    /** VALID-time as of `asOf`: rows whose [valid_from, valid_to) contains it. A SQL predicate applied before LIMIT. */
    async queryAsOf(table: string, asOf: Date | string, filter?: FilterNode, opts?: FindOptions): Promise<Row[]> {
        return this.select(table, 'queryAsOf', filter, opts, asOf);
    }

    async getByKey<T extends Row = Row>(table: string, key: unknown): Promise<T | null> {
        await this.ensure(table);
        const meta = this.meta(table, 'getByKey');
        let pk: Encoded;
        try { pk = encodePgValue(key, meta.pk.type, 'key'); } catch { return null; }
        if (pk === null) return null;
        const r = await this.pool.query(
            `SELECT ${this.selectList(meta)} FROM ${meta.view} v WHERE v._lore_pk = $1 LIMIT 1`, [String(pk)]);
        const row = r.rows[0] as Row | undefined;
        return row ? (decodePgRow(row, meta.schema.columns) as T) : null;
    }

    async count(table: string, filter?: FilterNode): Promise<number> {
        await this.ensure(table);
        const meta = this.meta(table, 'count');
        const types = new Map(meta.schema.columns.map(c => [c.name, c.type] as const));
        const { where, params } = buildPgWhere(filter, { qualify: k => `v.${qi(k)}`, typeOf: k => types.get(k) });
        const r = await this.pool.query(`SELECT count(*)::bigint AS c FROM ${meta.view} v ${where}`, params);
        return Number((r.rows[0] as { c: string }).c);
    }

    /**
     * Typed rows joined to their memory node in ONE statement (node key = the row's reserved `_memory_node_id`).
     * Node columns come back as `node.id|type|label|content`. `inner` (default) drops rows with no node.
     */
    async queryWithNodes(table: string, filter?: FilterNode, opts?: FindOptions & AsOfOptions & { join?: 'inner' | 'left' }): Promise<Row[]> {
        await this.ensure(table);
        const meta = this.meta(table, 'queryWithNodes');
        const types = new Map(meta.schema.columns.map(c => [c.name, c.type] as const));
        const built = buildPgWhere(filter, { qualify: k => `v.${qi(k)}`, typeOf: k => types.get(k), startAt: 1 });
        const params: Encoded[] = [this.workspace, ...built.params];
        let where = built.where;
        if (opts?.asOf !== undefined) {
            params.push(encodePgValue(opts.asOf, 'datetime', 'asOf'));
            const p = `$${params.length}::timestamptz`;
            const pred = `(v._lore_valid_from IS NULL OR v._lore_valid_from <= ${p}) AND (v._lore_valid_to IS NULL OR v._lore_valid_to > ${p})`;
            where = where ? `${where} AND ${pred}` : `WHERE ${pred}`;
        }
        const limit = typeof opts?.limit === 'number' ? opts.limit : DEFAULT_LIMIT;
        const kw = opts?.join === 'left' ? 'LEFT JOIN' : 'INNER JOIN';
        let sql = `SELECT ${this.selectList(meta)}, n.id AS "node.id", n.type AS "node.type", n.label AS "node.label", n.content AS "node.content" ` +
            `FROM ${meta.view} v ${kw} nodes n ON n.workspace_id = $1 AND n.id = v._lore_memory_node_id ${where} ORDER BY v._lore_entity_id`;
        if (Number.isFinite(limit)) sql += ` LIMIT ${Math.max(0, Math.floor(limit))}`;
        const r = await this.pool.query(sql, params);
        return (r.rows as Row[]).map(row => ({
            ...decodePgRow(row, meta.schema.columns),
            'node.id': row['node.id'], 'node.type': row['node.type'], 'node.label': row['node.label'], 'node.content': row['node.content'],
        }));
    }

    // ---- joins -------------------------------------------------------------

    async join(leftTable: string, join: JoinSpec, filter?: FilterNode, opts?: FindOptions): Promise<Row[]> {
        const hop: JoinHop = { collection: join.table, on: { from: join.on.left, to: join.on.right }, type: 'inner' };
        return this.runJoin(leftTable, [hop], filter, opts, 'join', Number.POSITIVE_INFINITY);
    }

    async joinMany(query: JoinQuery): Promise<Row[]> {
        const hops = query.join ?? [];
        if (hops.length < 1) throw new Error('joinMany requires at least one hop');
        if (hops.length > MAX_JOIN_HOPS) throw new Error(`joinMany accepts at most ${MAX_JOIN_HOPS} hops (got ${hops.length})`);
        return this.runJoin(query.from, hops, query.where, query.opts, 'joinMany', DEFAULT_LIMIT);
    }

    private async runJoin(from: string, hops: JoinHop[], where: FilterNode | undefined, opts: FindOptions | undefined, op: string, defaultLimit: number): Promise<Row[]> {
        const tables = [from, ...hops.map(h => h.collection)];
        await this.ensure(...tables);
        const metas = tables.map(t => this.meta(t, op));
        const al = tables.map((_, i) => `j${i}`);
        const cols: string[] = [];
        metas.forEach((m, i) => m.schema.columns.forEach(c => cols.push(`${selectExpr(`${al[i]}.${qi(c.name)}`, c.type)} AS ${qi(`${tables[i]}.${c.name}`)}`)));
        let sql = `SELECT ${cols.join(', ')} FROM ${metas[0]!.view} j0`;
        hops.forEach((h, i) => {
            assertIdent(h.on.from); assertIdent(h.on.to);
            sql += ` ${h.type === 'left' ? 'LEFT JOIN' : 'INNER JOIN'} ${metas[i + 1]!.view} ${al[i + 1]} ON ${al[i]}.${qi(h.on.from)} = ${al[i + 1]}.${qi(h.on.to)}`;
        });
        const types = new Map<string, import('../../contracts/tables.js').ColumnType>();
        for (const m of metas) for (const c of m.schema.columns) if (!types.has(c.name)) types.set(c.name, c.type);
        const qualify = (k: string): string => {
            const i = metas.findIndex(m => m.fields.has(k));
            return i >= 0 ? `${al[i]}.${qi(k)}` : qi(k);
        };
        const built = buildPgWhere(where, { qualify, typeOf: k => types.get(k) });
        sql += ` ${built.where}`;
        const order = al.map(a => `${a}._lore_entity_id`).join(', ');
        if (opts?.orderBy) {
            assertIdent(opts.orderBy.replace(/\./g, '_'));
            const aliasHit = cols.some(c => c.endsWith(` AS ${qi(opts.orderBy!)}`));
            sql += ` ORDER BY ${aliasHit ? qi(opts.orderBy) : qualify(opts.orderBy)} ${opts.orderDir === 'desc' ? 'DESC' : 'ASC'}, ${order}`;
        } else {
            sql += ` ORDER BY ${order}`;
        }
        const limit = typeof opts?.limit === 'number' ? Math.max(0, Math.floor(opts.limit)) : defaultLimit;
        if (Number.isFinite(limit)) sql += ` LIMIT ${limit}`;
        const r = await this.pool.query(sql, built.params);
        return (r.rows as Row[]).map(row => {
            const out: Row = {};
            metas.forEach((m, i) => Object.assign(out, decodePgRow(row, m.schema.columns, `${tables[i]}.`)));
            return out;
        });
    }

    async close(): Promise<void> {
        // The shared pool belongs to postgresPoolOwner; this handle only drops its caches.
        this.metas.clear();
        this.schemas.clear();
    }
}


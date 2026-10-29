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
 * rows (an update supersedes, never overwrites); `queryAsOf(..., { time: 'recorded' })`
 * answers "what did we know on D" from them (slice 2). Slice 2 also adds the `money`
 * column kind, per-value provenance (opt-in on write and on read) and typed row links.
 *
 * Schema cache: `schemas` is public and loaded at `open()` because ingestion's
 * tableWriter reads `storage.schemas.get(table)` synchronously. A table created
 * by ANOTHER process becomes visible on the next unknown-table miss (one reload).
 */

import type { Pool, PoolClient } from 'pg';
import type {
    BackendCapabilities, DestructiveWriteOptions, EvolutionStep, ITableStorage, JoinHop, JoinQuery, JoinSpec,
    ListTablesOptions, Row, TableOp, TableOpResult, TableSchema, TableSchemaSummary,
} from '../../contracts/tables.js';
import { MAX_JOIN_HOPS } from '../../contracts/tables.js';
import type { FilterNode, FindOptions } from '../collectionStorage.js';
import { listSqliteTables } from '../sqliteTableList.js';
import { assertIdent } from '../whereClause.js';
import { withTransaction } from './postgresClient.js';
import { withReadOnlyTransaction, type ReadOnlyTxOptions } from './postgresReadOnlyTx.js';
import { sharedPostgresPool } from './postgresPoolOwner.js';
import { ensureRekeyed } from './postgresRekey.js';
import { ensureWorkspaceSk, releaseWorkspaceSkBuild, startWorkspaceSkBuild, workspaceSkBuildDone } from './postgresWorkspaceSk.js';
import { cancelFieldIndexBuild, ensureFieldIndexes } from './postgresFieldIndexes.js';
import { runSchemaBootstrap } from './postgresStartup.js';
import { ensureGraphSchema } from './postgresGraphSchema.js';
import { CURRENCY_SUFFIX, TABLE_TABLES, tableSchemaDdl } from './postgresTableSchema.js';
import { bindTableReviewApi, type TableReviewApi } from './postgresTableReviewApi.js';
import { buildMeta, columnTypes, flagsOf, loadCatalog, pickPrimary, sameSchema, validateSchema, type TableMeta } from './postgresTableCatalog.js';
import { fieldIndexDdl, qi, recordedSourceSql, selectColumn, viewDdl } from './postgresTableViews.js';
import { decodePgRow, encodePgValue, type Encoded } from './postgresTableCodec.js';
import { buildPgWhere } from './postgresTableWhere.js';
import {
    deleteRows, insertRows, runOps, truncateRows, updateRows, type ProvenanceByColumnInput, type WriteCtx,
} from './postgresTableWrites.js';
import { evolveTable } from './postgresTableEvolve.js';
import { loadProvenance, type ProvenanceByColumn, type ValueProvenance } from './postgresTableProvenance.js';
import { MixedCurrencyError } from './postgresTableErrors.js';
import {
    addLink, closeLink, defineLinkType, listLinks, listLinkTypes,
    type AddLinkInput, type EntityLink, type LinkCtx, type LinkTypeDef, type LinkTypeInfo, type ListLinksOptions, type RowRef,
} from './postgresTableLinks.js';

export type { ProvenanceByColumnInput, ValueProvenance, ProvenanceByColumn, AddLinkInput, EntityLink, LinkTypeDef, LinkTypeInfo, ListLinksOptions, RowRef };
export type { StoredProvenance } from './postgresTableProvenance.js';
export type { LinkCardinality } from './postgresTableLinks.js';
export { MixedCurrencyError, TableLinkError } from './postgresTableErrors.js';

const L = 'PostgresTableStorage';
const DEFAULT_LIMIT = 10_000;

export interface AsOfOptions { asOf?: Date | string }

/**
 * Which "time" an as-of instant means. `valid` (the default) = when the fact was true in the world; `recorded` = what
 * Lore knew at that instant ("what did we believe on D"). `validAt` adds a valid-time instant on top of a recorded-time
 * read (the bitemporal question); it is rejected without `time: 'recorded'`.
 */
export interface TemporalOptions { time?: 'valid' | 'recorded'; validAt?: Date | string }
/** Opt in to per-value provenance on a read: each row gains a `_provenance` object keyed by column. */
export interface ProvenanceReadOptions { provenance?: boolean }
export type QueryAsOfOptions = FindOptions & TemporalOptions & ProvenanceReadOptions;
export type MoneyAggregate = 'sum' | 'avg' | 'min' | 'max';
export interface MoneyAggregateResult { amount: string; currency: string; count: number }

interface TimeSel extends TemporalOptions { asOf?: Date | string }

export class PostgresTableStorage implements ITableStorage {
    /** Declared schemas by table name (public: tableWriter / introspection read it synchronously). */
    readonly schemas = new Map<string, TableSchema>();
    private metas = new Map<string, TableMeta>();

    private constructor(private readonly pool: Pool, readonly workspace: string) {}

    /** Open (bootstrapping the schema if needed) a store bound to `workspace`. Throws if LORE_PG_URL is unset. */
    static async open(workspace: string, pool: Pool = sharedPostgresPool()): Promise<PostgresTableStorage> {
        if (!workspace) throw new Error(`${L}.open: workspace is required`);
        const skPending = await runSchemaBootstrap(pool, {}, async (client) => {
            await ensureGraphSchema(client, workspace); // lore_entity.(workspace_id, memory_node_sk) references nodes(workspace_id, sk)
            for (const stmt of tableSchemaDdl()) await client.query(stmt);
            // The composite lore_entity -> nodes FK needs the lore_entity table AND UNIQUE (workspace_id, sk): add it now.
            return (await ensureWorkspaceSk(client)).pending;
        });
        await ensureRekeyed(pool, workspace); // one-time name -> permanent-id row rewrite (postgresRekey.ts)
        const s = new PostgresTableStorage(pool, workspace);
        // Large database: finish the workspace-led structures off the open path (reads/writes are correct without them).
        if (skPending) void startWorkspaceSkBuild(pool, s);
        // Workspace-led names for the D10 per-field indexes; after the rekey, which fixes the id they hash.
        s.fieldIndexes = (await ensureFieldIndexes(pool, workspace)).done;
        await s.reload();
        return s;
    }

    /** Background field-index build for this workspace (resolves immediately when nothing was missing). Test hook. */
    fieldIndexes: Promise<void> = Promise.resolve();

    /** Resolves when the background workspace-sk build and this workspace's field-index build have finished. */
    async waitForIndexes(): Promise<void> {
        await workspaceSkBuildDone(this.pool);
        await this.fieldIndexes;
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

    /** Review queue + alias table for this workspace (Postgres only; see postgresTableReview.ts / postgresTableAlias.ts). */
    reviewApi(): TableReviewApi { return bindTableReviewApi(this.pool, this.workspace); }

    private ctx(client: WriteCtx['client']): WriteCtx {
        return { client, workspace: this.workspace, meta: (t, op) => this.meta(t, op) };
    }

    /**
     * Run `fn` in a READ ONLY snapshot transaction (timeouts applied) over a catalogue loaded INSIDE that
     * transaction. The query-plan executor's only door to the database: it cannot write, and the catalogue it
     * validates against is the one its SQL runs on.
     */
    async runReadOnly<T>(opts: ReadOnlyTxOptions, fn: (client: PoolClient, tables: ReadonlyMap<string, TableMeta>) => Promise<T>): Promise<T> {
        return withReadOnlyTransaction(this.pool, opts, async (client) => fn(client, await loadCatalog(client, this.workspace)));
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
            for (const c of schema.columns) for (const ddl of fieldIndexDdl(this.workspace, ids.get(c.name)!, c)) await client.query(ddl);
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

    /** `wopts.provenance` (column name -> provenance) records where each listed value came from; omitted = none. */
    async insert(table: string, row: Row, wopts?: { provenance?: ProvenanceByColumnInput }): Promise<void> {
        await this.ensure(table);
        await withTransaction(this.pool, async (c) => { await insertRows(this.ctx(c), table, [row], 'insert', wopts?.provenance ? [wopts.provenance] : undefined); });
    }

    /** `wopts.provenance[i]` belongs to `rows[i]`. */
    async insertBatch(table: string, rows: Row[], wopts?: { provenance?: Array<ProvenanceByColumnInput | undefined> }): Promise<void> {
        await this.ensure(table);
        if (rows.length === 0) { this.meta(table, 'insertBatch'); return; }
        if (wopts?.provenance && wopts.provenance.length > rows.length) {
            throw new Error(`${L}.insertBatch: ${wopts.provenance.length} provenance entries for ${rows.length} rows`);
        }
        await withTransaction(this.pool, async (c) => { await insertRows(this.ctx(c), table, rows, 'insertBatch', wopts?.provenance); });
    }

    /**
     * `opts.provenance` attaches provenance to the patched values. A patch that carries provenance always writes a new
     * recorded version (the provenance is new information even when the value is unchanged).
     */
    async update(table: string, filter: FilterNode, patch: Partial<Row>, opts?: DestructiveWriteOptions & { provenance?: ProvenanceByColumnInput }): Promise<number> {
        await this.ensure(table);
        const { provenance, ...destructive } = opts ?? {};
        return withTransaction(this.pool, (c) => updateRows(this.ctx(c), table, filter, patch, 'update', opts ? destructive : undefined, provenance));
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

    private selectList(meta: TableMeta, alias = 'v', withEntityId = false): string {
        const cols = meta.schema.columns.map(c => `${selectColumn(alias, c)} AS ${qi(c.name)}`);
        if (withEntityId) cols.push(`${alias}._lore_entity_id AS "_lore_entity_id"`);
        return cols.join(', ');
    }

    /**
     * The FROM relation and the extra WHERE conjuncts for a time selection. `params` is appended to in place and the
     * placeholders are numbered from its length, so callers with leading params (queryWithNodes) just seed the array.
     */
    private timeSource(meta: TableMeta, t: TimeSel, params: Encoded[]): { from: string; preds: string[] } {
        const op = (a: Date | string, what: string): string => { params.push(encodePgValue(a, 'datetime', what)); return `$${params.length}::timestamptz`; };
        const validPred = (p: string): string => `(v._lore_valid_from IS NULL OR v._lore_valid_from <= ${p}) AND (v._lore_valid_to IS NULL OR v._lore_valid_to > ${p})`;
        if (t.time !== undefined && t.time !== 'valid' && t.time !== 'recorded') throw new Error(`${L}: time must be 'valid' or 'recorded'`);
        if (t.time === 'recorded') {
            if (t.asOf === undefined) throw new Error(`${L}: time 'recorded' requires an as-of instant`);
            const rec = op(t.asOf, 'asOf');
            const preds = t.validAt === undefined ? [] : [validPred(op(t.validAt, 'validAt'))];
            return { from: `${recordedSourceSql(this.workspace, meta, rec)} v`, preds };
        }
        if (t.validAt !== undefined) throw new Error(`${L}: validAt applies only with time 'recorded' (for valid time pass the instant as asOf)`);
        return { from: `${meta.view} v`, preds: t.asOf === undefined ? [] : [validPred(op(t.asOf, 'asOf'))] };
    }

    /** Attach `_provenance` to each row (opt-in). `recordedAt` reads the provenance known at that instant. */
    private async attachProvenance(meta: TableMeta, rows: Row[], ids: string[], recordedAt: Date | string | undefined): Promise<void> {
        const at = recordedAt === undefined ? undefined : String(encodePgValue(recordedAt, 'datetime', 'asOf'));
        const prov = await loadProvenance(this.pool, this.workspace, meta, ids, at);
        rows.forEach((row, i) => { (row as Row)['_provenance'] = prov.get(ids[i]!) ?? {}; });
    }

    private async select(table: string, op: string, filter: FilterNode | undefined, opts: FindOptions | undefined, t: TimeSel = {}, provenance = false): Promise<Row[]> {
        await this.ensure(table);
        const meta = this.meta(table, op);
        const types = columnTypes(meta.schema);
        const built = buildPgWhere(filter, { qualify: k => `v.${qi(k)}`, typeOf: k => types.get(k) });
        const params: Encoded[] = [...built.params];
        const src = this.timeSource(meta, t, params);
        let where = built.where;
        for (const pred of src.preds) where = where ? `${where} AND ${pred}` : `WHERE ${pred}`;
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
        let sql = `SELECT ${this.selectList(meta, 'v', provenance)} FROM ${src.from} ${where} ${order}`;
        if (Number.isFinite(limit)) sql += ` LIMIT ${Math.max(0, Math.floor(limit))}`;
        const r = await this.pool.query(sql, params);
        const raw = r.rows as Row[];
        const out = raw.map(row => decodePgRow(row, meta.schema.columns));
        if (provenance) await this.attachProvenance(meta, out, raw.map(x => String(x['_lore_entity_id'])), t.time === 'recorded' ? t.asOf : undefined);
        return out;
    }

    async query(table: string, filter?: FilterNode, opts?: FindOptions & ProvenanceReadOptions): Promise<Row[]> {
        return this.select(table, 'query', filter, opts, {}, opts?.provenance === true);
    }

    /**
     * Rows as of `asOf`. Default (and `time: 'valid'`): VALID time - rows whose [valid_from, valid_to) contains it, a SQL
     * predicate applied before LIMIT. `time: 'recorded'`: what Lore KNEW at `asOf` (each value as it stood then); add
     * `validAt` to also require validity at another instant. Header-held reserved columns (`_memory_node_id`, `_source_id`,
     * `_valid_from`, `_valid_to`) are overwritten in place, so a recorded read shows their current value.
     */
    async queryAsOf(table: string, asOf: Date | string, filter?: FilterNode, opts?: QueryAsOfOptions): Promise<Row[]> {
        return this.select(table, 'queryAsOf', filter, opts, { asOf, time: opts?.time, validAt: opts?.validAt }, opts?.provenance === true);
    }

    async getByKey<T extends Row = Row>(table: string, key: unknown, ropts?: ProvenanceReadOptions): Promise<T | null> {
        await this.ensure(table);
        const meta = this.meta(table, 'getByKey');
        let pk: Encoded;
        try { pk = encodePgValue(key, meta.pk.type, 'key'); } catch { return null; }
        if (pk === null) return null;
        const prov = ropts?.provenance === true;
        const r = await this.pool.query(
            `SELECT ${this.selectList(meta, 'v', prov)} FROM ${meta.view} v WHERE v._lore_pk = $1 LIMIT 1`, [String(pk)]);
        const row = r.rows[0] as Row | undefined;
        if (!row) return null;
        const out = decodePgRow(row, meta.schema.columns);
        if (prov) await this.attachProvenance(meta, [out], [String(row['_lore_entity_id'])], undefined);
        return out as T;
    }

    async count(table: string, filter?: FilterNode): Promise<number> {
        await this.ensure(table);
        const meta = this.meta(table, 'count');
        const types = columnTypes(meta.schema);
        const { where, params } = buildPgWhere(filter, { qualify: k => `v.${qi(k)}`, typeOf: k => types.get(k) });
        const r = await this.pool.query(`SELECT count(*)::bigint AS c FROM ${meta.view} v ${where}`, params);
        return Number((r.rows[0] as { c: string }).c);
    }

    /**
     * Typed rows joined to their memory node in ONE statement (node key = the row's reserved `_memory_node_id`).
     * Node columns come back as `node.id|type|label|content`. `inner` (default) drops rows with no node.
     */
    async queryWithNodes(table: string, filter?: FilterNode, opts?: FindOptions & AsOfOptions & TemporalOptions & ProvenanceReadOptions & { join?: 'inner' | 'left' }): Promise<Row[]> {
        await this.ensure(table);
        const meta = this.meta(table, 'queryWithNodes');
        const types = columnTypes(meta.schema);
        const built = buildPgWhere(filter, { qualify: k => `v.${qi(k)}`, typeOf: k => types.get(k), startAt: 1 });
        const params: Encoded[] = [this.workspace, ...built.params];
        const src = this.timeSource(meta, { asOf: opts?.asOf, time: opts?.time, validAt: opts?.validAt }, params);
        let where = built.where;
        for (const pred of src.preds) where = where ? `${where} AND ${pred}` : `WHERE ${pred}`;
        const prov = opts?.provenance === true;
        const limit = typeof opts?.limit === 'number' ? opts.limit : DEFAULT_LIMIT;
        const kw = opts?.join === 'left' ? 'LEFT JOIN' : 'INNER JOIN';
        let sql = `SELECT ${this.selectList(meta, 'v', prov)}, n.id AS "node.id", n.type AS "node.type", n.label AS "node.label", n.content AS "node.content" ` +
            `FROM ${src.from} ${kw} nodes n ON n.workspace_id = $1 AND n.id = v._lore_memory_node_id ${where} ORDER BY v._lore_entity_id`;
        if (Number.isFinite(limit)) sql += ` LIMIT ${Math.max(0, Math.floor(limit))}`;
        const r = await this.pool.query(sql, params);
        const raw = r.rows as Row[];
        const out = raw.map(row => ({
            ...decodePgRow(row, meta.schema.columns),
            'node.id': row['node.id'], 'node.type': row['node.type'], 'node.label': row['node.label'], 'node.content': row['node.content'],
        }));
        if (prov) await this.attachProvenance(meta, out, raw.map(x => String(x['_lore_entity_id'])), opts?.time === 'recorded' ? opts.asOf : undefined);
        return out;
    }

    // ---- money -------------------------------------------------------------

    /**
     * Aggregate a `money` column over the rows matching `filter`. Money is NEVER combined across currencies: if the matching
     * values span more than one currency this throws MixedCurrencyError (filter on `<column>__currency` to pick one).
     * Returns null when no row has a value. `amount` is a decimal string (no float rounding).
     */
    async aggregateMoney(table: string, column: string, agg: MoneyAggregate, filter?: FilterNode, topts?: TemporalOptions & AsOfOptions): Promise<MoneyAggregateResult | null> {
        await this.ensure(table);
        const meta = this.meta(table, 'aggregateMoney');
        const f = meta.fields.get(column);
        if (!f || f.col.type !== 'money') throw new Error(`${L}.aggregateMoney: '${column}' is not a money column of '${table}'`);
        if (!['sum', 'avg', 'min', 'max'].includes(agg)) throw new Error(`${L}.aggregateMoney: unsupported aggregate '${String(agg)}'`);
        const types = columnTypes(meta.schema);
        const built = buildPgWhere(filter, { qualify: k => `v.${qi(k)}`, typeOf: k => types.get(k) });
        const params: Encoded[] = [...built.params];
        const src = this.timeSource(meta, { asOf: topts?.asOf, time: topts?.time, validAt: topts?.validAt }, params);
        let where = built.where;
        for (const pred of [...src.preds, `v.${qi(column)} IS NOT NULL`]) where = where ? `${where} AND ${pred}` : `WHERE ${pred}`;
        const r = await this.pool.query(
            `SELECT v.${qi(column + CURRENCY_SUFFIX)}::text AS currency, ${agg}(v.${qi(column)})::text AS amount, count(*)::int AS n
               FROM ${src.from} ${where} GROUP BY 1 ORDER BY 1`, params);
        const rows = r.rows as Array<{ currency: string; amount: string; n: number }>;
        if (rows.length === 0) return null;
        if (rows.length > 1) throw new MixedCurrencyError(column, rows.map(x => x.currency));
        return { amount: rows[0]!.amount, currency: rows[0]!.currency, count: rows[0]!.n };
    }

    // ---- record links ------------------------------------------------------

    private linkCtx(): LinkCtx {
        return { db: this.pool, workspace: this.workspace, meta: (t, op) => this.meta(t, op) };
    }

    /** Define a typed relationship between two tables. Idempotent for an identical definition; a different one throws `link_type_conflict`. */
    async defineLinkType(def: LinkTypeDef): Promise<LinkTypeInfo> {
        await this.ensure(def.fromTable, def.toTable);
        return defineLinkType(this.linkCtx(), def);
    }

    async listLinkTypes(): Promise<LinkTypeInfo[]> {
        return listLinkTypes(this.linkCtx());
    }

    /** Link two rows (by primary key). Cardinality is enforced among OPEN links. Throws TableLinkError. */
    async addLink(input: AddLinkInput): Promise<{ linkId: string }> {
        await this.ensure(input.from.table, input.to.table);
        return addLink(this.linkCtx(), input);
    }

    /** Soft-invalidate a link (sets valid_to, default now). Returns false if it does not exist or is already closed. */
    async closeLink(linkId: string, validTo?: Date | string): Promise<boolean> {
        return closeLink(this.linkCtx(), linkId, validTo);
    }

    /** Links touching one row. Default: valid now, both directions; `asOf` for valid time; `includeClosed` for full history. */
    async listLinks(ref: RowRef, opts?: ListLinksOptions): Promise<EntityLink[]> {
        await this.ensure(ref.table);
        return listLinks(this.linkCtx(), ref, opts);
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
        metas.forEach((m, i) => m.schema.columns.forEach(c => cols.push(`${selectColumn(al[i]!, c)} AS ${qi(`${tables[i]}.${c.name}`)}`)));
        let sql = `SELECT ${cols.join(', ')} FROM ${metas[0]!.view} j0`;
        hops.forEach((h, i) => {
            assertIdent(h.on.from); assertIdent(h.on.to);
            sql += ` ${h.type === 'left' ? 'LEFT JOIN' : 'INNER JOIN'} ${metas[i + 1]!.view} ${al[i + 1]} ON ${al[i]}.${qi(h.on.from)} = ${al[i + 1]}.${qi(h.on.to)}`;
        });
        const types = new Map<string, import('../../contracts/tables.js').ColumnType>();
        for (const m of metas) for (const [n, ty] of columnTypes(m.schema)) if (!types.has(n)) types.set(n, ty);
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
        // The shared pool belongs to postgresPoolOwner; this handle only drops its caches (and leaves any background build).
        await releaseWorkspaceSkBuild(this.pool, this);
        await cancelFieldIndexBuild(this.pool, this.workspace);
        this.metas.clear();
        this.schemas.clear();
    }
}


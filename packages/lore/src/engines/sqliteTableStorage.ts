/**
 * sqliteTableStorage.ts — ITableStorage backed by SQLite (better-sqlite3).
 *
 * Why a dedicated relational backend exists:
 *   Lore's local engine is conceptually tri-substrate (graph + vector +
 *   relational). Hosting all three on the graph engine was a convenience —
 *   its node tables ARE relational rows behind a Cypher veneer — but it
 *   confused the mental model and meant the graph engine carried double
 *   duty. Splitting the relational store out into SQLite makes the layout match the cloud's
 *   shape (Postgres for relational, ArangoDB for graph, Zilliz/Qdrant
 *   for vector) and makes "which substrate is this on?" answerable by
 *   looking at the file name on disk.
 *
 * Layout: one SQLite database file per workspace at
 *   <workspace>/.lore/tables.sqlite
 * Tables created in that DB correspond one-to-one with
 * `ITableStorage.createTable` calls. JOIN is supported (SQLite is a
 * relational store) — implements the optional `join` member.
 *
 * Synchronous-by-design: better-sqlite3 is a synchronous API; we wrap
 * the calls in resolved Promises so the ITableStorage contract (which
 * is async) is satisfied without giving up better-sqlite3's perf
 * advantage on the local-mode hot path.
 *
 * The same schema-cache-persistence approach applies here:
 * `createTable` is idempotent and the in-memory `schemas` map is the
 * source for `getByKey` (needs the pk column name) and for
 * `collection_schema_get`. Schemas are persisted to a sidecar JSON
 * file when `schemaCachePath` is supplied so they survive restarts
 * before the caller re-declares them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import Database from 'better-sqlite3';
import { buildSqliteWhere, quoteSqliteIdent as quoteIdent } from './whereClause.js';
import type { FilterNode, FindOptions } from './collectionStorage.js';
import {
    deleteSqliteTableRows,
    insertSqliteTableRow,
    runSqliteTableTransaction,
    updateSqliteTableRows,
    type SqliteTableMutationContext,
} from './sqliteTableTransaction.js';
import { listSqliteTables } from './sqliteTableList.js';
import {
    MAX_JOIN_HOPS,
    type ColumnDecl,
    type ColumnType,
    type DestructiveWriteOptions,
    type EvolutionStep,
    type JoinHop,
    type JoinQuery,
    type JoinSpec,
    type ListTablesOptions,
    type Row,
    type TableOp,
    type TableOpResult,
    type TableSchema,
    type TableSchemaSummary,
} from '../contracts/tables.js';
import type { RelationalProvider } from '../providers/relationalTypes.js';

/** Map ColumnType → SQLite type. JSON serialized to TEXT (SQLite has
 *  no native JSON column type, only json1 extension functions). */
function sqliteType(t: ColumnType): string {
    switch (t) {
        case 'string':   return 'TEXT';
        case 'integer':  return 'INTEGER';
        case 'float':    return 'REAL';
        case 'boolean':  return 'INTEGER'; // SQLite stores 0/1
        case 'date':     return 'TEXT';    // ISO YYYY-MM-DD
        case 'datetime': return 'TEXT';    // ISO 8601
        case 'json':     return 'TEXT';    // JSON-stringified
    }
}

function pickPrimary(cols: ColumnDecl[]): ColumnDecl {
    const pks = cols.filter(c => c.primary);
    if (pks.length !== 1) {
        throw new Error(
            `SqliteTableStorage: schema requires exactly one primary column, got ${pks.length}`,
        );
    }
    return pks[0];
}

/** Case-insensitive string forms accepted for boolean columns. */
const BOOLEAN_TRUE_STRINGS: Record<string, true> = {
    true: true, '1': true, yes: true, y: true, on: true,
};
const BOOLEAN_FALSE_STRINGS: Record<string, true> = {
    false: true, '0': true, no: true, n: true, off: true,
};

/**
 * Parse a boolean column value into SQLite's 0/1 integer form. Real booleans
 * pass through; numbers coerce (0 → false, non-zero → true); strings match
 * the canonical sets above case-insensitively.
 *
 * Audit 5.5 (2026-08-17): the previous implementation used plain JS
 * truthiness (`v ? 1 : 0`), so EVERY non-empty string — 'false', '0', 'no' —
 * was stored as TRUE, and the same wrong coercion was applied to filter
 * values, so `query({eq:{active:'false'}})` returned the TRUE rows.
 *
 * An unparseable value THROWS rather than being stored. Rationale: unlike
 * integer/float (where SQLite affinity preserves a verbatim string) there is
 * no lossless "verbatim" representation for a boolean column — the value
 * must become 0 or 1 — so silently guessing corrupts the data with no
 * signal (exactly the tabularImport.ts contract says must not happen),
 * while throwing surfaces the bad row to the caller.
 */
function encodeBoolean(v: unknown): number {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') {
        if (Number.isNaN(v)) {
            throw new Error('SqliteTableStorage: cannot store NaN in a boolean column');
        }
        return v === 0 ? 0 : 1;
    }
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        // Object.hasOwn, not a bare lookup: a plain Record lookup would treat
        // prototype keys ('constructor' etc.) as TRUE.
        if (Object.hasOwn(BOOLEAN_TRUE_STRINGS, s)) return 1;
        if (Object.hasOwn(BOOLEAN_FALSE_STRINGS, s)) return 0;
        throw new Error(
            `SqliteTableStorage: unparseable boolean value ${JSON.stringify(v)} ` +
            `(expected a boolean, a number, or one of ` +
            `${[...Object.keys(BOOLEAN_TRUE_STRINGS), ...Object.keys(BOOLEAN_FALSE_STRINGS)].join('/')})`,
        );
    }
    throw new Error(
        `SqliteTableStorage: unparseable boolean value of type ${typeof v}`,
    );
}

/** Encode a value for SQLite. Booleans → 0/1 (parsed — see encodeBoolean),
 *  json/objects → JSON.stringify, primitives passthrough, null/undefined → null.
 *  Exported so SqliteAnalyticalStorage encodes filter values with the SAME
 *  coercion the write/read paths use (audit cluster 5, 2026-08-17). */
export function encodeValue(v: unknown, type: ColumnType): unknown {
    if (v === null || v === undefined) return null;
    if (type === 'boolean') return encodeBoolean(v);
    if (type === 'json') return typeof v === 'string' ? v : JSON.stringify(v);
    return v;
}

/** Decode a SQLite value back to its declared type. Exported so
 *  SqliteAnalyticalStorage decodes aggregate results with the SAME mapping
 *  as row reads (audit cluster 5, 2026-08-17). */
export function decodeValue(v: unknown, type: ColumnType): unknown {
    if (v === null || v === undefined) return null;
    if (type === 'boolean') return v === 1 || v === '1' || v === true;
    if (type === 'json') {
        if (typeof v !== 'string') return v;
        try { return JSON.parse(v); } catch { return v; }
    }
    return v;
}

/**
 * Build a parameterised WHERE clause matching the Filter shape. Delegates
 * to the shared, guarded `buildSqliteWhere` (SW-01); the only SQLite-specific
 * bit is value encoding by declared column type — booleans → 0/1, json/objects
 * → JSON-string — which better-sqlite3 needs to bind. Unknown columns pass
 * through unchanged. LIKE operators (contains/startsWith) stay string-coerced
 * inside the shared builder — they're text matches.
 */
function buildWhereClause(
    filter: FilterNode | undefined,
    colTypes?: Map<string, ColumnType>,
    alias?: string,
): { where: string; params: unknown[] } {
    return buildSqliteWhere(filter, {
        alias,
        encode: (k, v) => {
            const t = colTypes?.get(k);
            return t !== undefined ? encodeValue(v, t) : v;
        },
    });
}

/** Build a column-name → declared-type map from one or more schemas
 *  (multiple for joins). First declaration wins on name collisions. */
function colTypeMap(...schemas: TableSchema[]): Map<string, ColumnType> {
    const m = new Map<string, ColumnType>();
    for (const s of schemas) {
        for (const c of s.columns) if (!m.has(c.name)) m.set(c.name, c.type);
    }
    return m;
}

export class SqliteTableStorage implements RelationalProvider {
    private readonly db: DatabaseType;
    /** In-memory schema map. Persisted to disk when `schemaCachePath` set. */
    private readonly schemas: Map<string, TableSchema> = new Map();
    private cacheLoaded = false;

    /**
     * @param dbPath          Absolute path to the SQLite file. Parent dir
     *                        must exist (caller responsibility — usually
     *                        the workspace's .lore/ which is created at
     *                        workspace registration).
     * @param schemaCachePath Optional sidecar JSON file for the schema
     *                        map. When set, schemas reload on first use
     *                        and persist after each createTable so the
     *                        store survives a daemon restart.
     */
    constructor(
        dbPath: string,
        private readonly schemaCachePath?: string,
    ) {
        this.db = new Database(dbPath);
        // Pragma tuning: WAL for concurrent readers; foreign_keys ON in
        // case callers use them; synchronous=NORMAL is the documented
        // recommendation when paired with WAL for write performance.
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
    }

    /**
     * Public handle accessor.
     *
     * Needed so `SqliteAnalyticalStorage` can run aggregates over the SAME
     * database and connection this store writes through, rather than opening a
     * second handle to the same file. Two handles would each carry their own
     * WAL read snapshot, so an aggregate could miss a row that was just
     * written — exactly the class of skew the analytical rebuild exists to end.
     */
    getDatabase(): DatabaseType {
        return this.db;
    }

    /**
     * Collection name → physical table name. Identity here: this store creates
     * tables under the declared collection name. Exposed so the analytical
     * store shares ONE resolver with its table store instead of assuming the
     * mapping, which is what let a split resolver pair drift apart before.
     */
    resolveCollectionTable(coll: string): string {
        return coll;
    }

    /**
     * Declared column-name → ColumnType map for a table, or null when the
     * table is unknown. Read-only accessor so SqliteAnalyticalStorage can
     * encode filter values and decode aggregate results with the SAME type
     * map the write/read paths use (audit cluster 5, 2026-08-17).
     */
    getColumnTypes(table: string): Map<string, ColumnType> | null {
        this.loadSchemaCacheOnce();
        const schema = this.schemas.get(table);
        if (!schema) return null;
        const m = new Map<string, ColumnType>();
        for (const c of schema.columns) m.set(c.name, c.type);
        return m;
    }

    /** Close the underlying database handle. Idempotent. */
    close(): void {
        if (this.db.open) this.db.close();
    }

    private loadSchemaCacheOnce(): void {
        if (this.cacheLoaded) return;
        this.cacheLoaded = true;
        if (!this.schemaCachePath) return;
        if (!fs.existsSync(this.schemaCachePath)) return;
        try {
            const raw = fs.readFileSync(this.schemaCachePath, 'utf-8');
            const parsed = JSON.parse(raw) as Record<string, TableSchema>;
            for (const [name, schema] of Object.entries(parsed)) {
                this.schemas.set(name, schema);
            }
        } catch (err) {
            console.warn(
                `[SqliteTableStorage] failed to load schema cache from ${this.schemaCachePath} ` +
                `— starting empty: ${(err as Error).message}`,
            );
        }
    }

    private persistSchemaCache(): void {
        if (!this.schemaCachePath) return;
        try {
            const obj: Record<string, TableSchema> = {};
            for (const [k, v] of this.schemas.entries()) obj[k] = v;
            const tmp = `${this.schemaCachePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
            fs.renameSync(tmp, this.schemaCachePath);
        } catch (err) {
            console.error(
                `[SqliteTableStorage] failed to persist schema cache to ${this.schemaCachePath}: ${(err as Error).message}`,
            );
        }
    }

    capabilities() {
        return {
            join: true,
            maxJoinHops: MAX_JOIN_HOPS,
            // SQLite's default LIKE is case-INSENSITIVE for ASCII;
            // we set PRAGMA case_sensitive_like = ON would change that
            // but we don't, so report honestly.
            caseSensitiveContains: false,
            extractedJsonFields: true,
            additiveSchemaEvolution: true,
        };
    }

    async createTable(schema: TableSchema): Promise<void> {
        this.loadSchemaCacheOnce();
        // Validate identifier upfront so the quoteIdent helper never
        // surprises a caller mid-statement.
        quoteIdent(schema.name);
        pickPrimary(schema.columns);

        const existing = this.schemas.get(schema.name);
        if (existing) {
            // Re-declare with same shape → no-op. Different shape → error.
            if (JSON.stringify(existing) === JSON.stringify(schema)) return;
            throw new Error(
                `SqliteTableStorage: table '${schema.name}' already exists with a different shape. ` +
                `Schema migrations are out of scope for this adapter; drop the table or define a new one.`,
            );
        }

        const colDefs: string[] = [];
        for (const c of schema.columns) {
            const parts = [quoteIdent(c.name), sqliteType(c.type)];
            if (c.primary) parts.push('PRIMARY KEY');
            if (c.required && !c.primary) parts.push('NOT NULL');
            if (c.unique && !c.primary) parts.push('UNIQUE');
            colDefs.push(parts.join(' '));

            // Architecture gap #6 — extracted-and-indexed sidecar
            // columns for JSON columns. Only meaningful for type=json.
            if (c.type === 'json' && c.extractedFields) {
                for (const ef of c.extractedFields) {
                    quoteIdent(ef.key); // validate identifier safety
                    const sidecar = `${c.name}__${ef.key}`;
                    colDefs.push(`${quoteIdent(sidecar)} ${sqliteType(ef.type)}`);
                }
            }
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(schema.name)} (${colDefs.join(', ')})`);

        // Secondary indexes on `indexed: true` columns (primary already
        // gets a unique index from SQLite). Index name namespaced by
        // table to avoid collisions.
        for (const c of schema.columns) {
            if (c.indexed && !c.primary) {
                this.db.exec(
                    `CREATE INDEX IF NOT EXISTS "idx_${schema.name}_${c.name}" ` +
                    `ON ${quoteIdent(schema.name)} (${quoteIdent(c.name)})`,
                );
            }
            if (c.type === 'json' && c.extractedFields) {
                for (const ef of c.extractedFields) {
                    if (ef.indexed) {
                        const sidecar = `${c.name}__${ef.key}`;
                        this.db.exec(
                            `CREATE INDEX IF NOT EXISTS "idx_${schema.name}_${sidecar}" ` +
                            `ON ${quoteIdent(schema.name)} (${quoteIdent(sidecar)})`,
                        );
                    }
                }
            }
        }

        this.schemas.set(schema.name, schema);
        this.persistSchemaCache();
    }

    /**
     * Finding #7 / finding B3 (round E) — see sqliteTableList.ts (file-size
     * split) for the pagination + `withCounts` fan-out-bounding rationale.
     */
    async listTables(opts: ListTablesOptions = {}): Promise<TableSchemaSummary[]> {
        this.loadSchemaCacheOnce();
        return listSqliteTables({
            schemas: this.schemas,
            count: (table) => this.count(table),
            pickPrimary,
        }, opts);
    }

    async insert(table: string, row: Row): Promise<void> {
        this.loadSchemaCacheOnce();
        insertSqliteTableRow(this.mutationContext(), table, row);
    }

    async insertBatch(table: string, rows: Row[]): Promise<void> {
        if (rows.length === 0) return;
        this.loadSchemaCacheOnce();
        const ctx = this.mutationContext();
        const insertOne = this.db.transaction((batch: Row[]) => {
            for (let i = 0; i < batch.length; i++) {
                insertSqliteTableRow(ctx, table, batch[i]!, 'insertBatch', i);
            }
        });
        insertOne(rows);
    }

    async query(table: string, filter?: FilterNode, opts?: FindOptions): Promise<Row[]> {
        this.loadSchemaCacheOnce();
        const schema = this.requireSchema(table, 'query');
        const { where, params } = buildWhereClause(filter, colTypeMap(schema));
        let sql = `SELECT * FROM ${quoteIdent(table)} ${where}`;
        if (opts?.orderBy) {
            const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
            sql += ` ORDER BY ${quoteIdent(opts.orderBy)} ${dir}`;
        }
        // SW-18 (Audit E9): apply a default cap when the caller supplies no
        // limit — prevents full table scans at enterprise scale. Pass
        // { limit: Infinity } or a very large number to get all rows (rare;
        // only batch callers should need this).
        // 1.M6 (2026-08-17 audit) — `LIMIT Infinity` is a SQLite syntax
        // error, so the documented escape hatch threw instead of working;
        // omit the clause entirely for non-finite limits.
        const effectiveLimit = typeof opts?.limit === 'number'
            ? Math.max(0, Math.floor(opts.limit))
            : 10_000;
        if (Number.isFinite(effectiveLimit)) {
            sql += ` LIMIT ${effectiveLimit}`;
        }
        const rows = this.db.prepare(sql).all(...params) as Row[];
        return rows.map(r => this.decodeRow(r, schema));
    }

    async getByKey<T extends Row = Row>(table: string, key: unknown): Promise<T | null> {
        this.loadSchemaCacheOnce();
        const schema = this.requireSchema(table, 'getByKey');
        const pk = pickPrimary(schema.columns);
        const row = this.db.prepare(
            `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(pk.name)} = ? LIMIT 1`,
        ).get(key) as Row | undefined;
        if (!row) return null;
        return this.decodeRow(row, schema) as T;
    }

    async update(
        table: string,
        filter: FilterNode,
        patch: Partial<Row>,
        opts?: DestructiveWriteOptions,
    ): Promise<number> {
        this.loadSchemaCacheOnce();
        return updateSqliteTableRows(this.mutationContext(), table, filter, patch, 'update', opts);
    }

    async delete(table: string, filter: FilterNode, opts?: DestructiveWriteOptions): Promise<number> {
        this.loadSchemaCacheOnce();
        return deleteSqliteTableRows(this.mutationContext(), table, filter, 'delete', opts);
    }

    async count(table: string, filter?: FilterNode): Promise<number> {
        this.loadSchemaCacheOnce();
        const schema = this.requireSchema(table, 'count');
        const { where, params } = buildWhereClause(filter, colTypeMap(schema));
        const row = this.db.prepare(
            `SELECT COUNT(*) AS c FROM ${quoteIdent(table)} ${where}`,
        ).get(...params) as { c: number };
        return row.c;
    }

    async truncate(table: string): Promise<number> {
        this.loadSchemaCacheOnce();
        this.requireSchema(table, 'truncate');
        // SQLite has no TRUNCATE; use unconditional DELETE which the
        // engine optimises (the "truncate optimisation") when no WHERE.
        const count = await this.count(table);
        this.db.exec(`DELETE FROM ${quoteIdent(table)}`);
        return count;
    }

    async runTransaction(ops: TableOp[]): Promise<TableOpResult[]> {
        this.loadSchemaCacheOnce();
        return runSqliteTableTransaction(this.mutationContext(), ops);
    }

    async join(
        leftTable: string,
        join: JoinSpec,
        filter?: FilterNode,
        opts?: FindOptions,
    ): Promise<Row[]> {
        this.loadSchemaCacheOnce();
        const leftSchema = this.requireSchema(leftTable, 'join');
        const rightSchema = this.requireSchema(join.table, 'join');
        // Build an unambiguous SELECT prefixing column names with the
        // table they came from so plugins can disambiguate.
        const cols: string[] = [];
        for (const c of leftSchema.columns) cols.push(`l.${quoteIdent(c.name)} AS "${leftTable}.${c.name}"`);
        for (const c of rightSchema.columns) cols.push(`r.${quoteIdent(c.name)} AS "${join.table}.${c.name}"`);
        // Filter applies to either side; the where-clause builder uses
        // unaliased column names, so we wrap it in a CTE-style subquery
        // to keep the filter API consistent with `query`. Caller can
        // disambiguate with prefixed keys.
        const { where, params } = buildWhereClause(filter, colTypeMap(leftSchema, rightSchema));
        let sql = `SELECT ${cols.join(', ')} FROM ${quoteIdent(leftTable)} l ` +
                  `INNER JOIN ${quoteIdent(join.table)} r ON l.${quoteIdent(join.on.left)} = r.${quoteIdent(join.on.right)} ${where}`;
        if (opts?.orderBy) {
            const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
            sql += ` ORDER BY ${quoteIdent(opts.orderBy)} ${dir}`;
        }
        if (typeof opts?.limit === 'number') sql += ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
        // No per-column decode here — joined results carry prefixed
        // column names so the schema lookup is ambiguous. Callers that
        // need typed shapes can post-process.
        return this.db.prepare(sql).all(...params) as Row[];
    }

    async joinMany(query: JoinQuery): Promise<Row[]> {
        const hops = query.join ?? [];
        if (hops.length < 1) {
            throw new Error('joinMany requires at least one hop');
        }
        if (hops.length > MAX_JOIN_HOPS) {
            throw new Error(`joinMany accepts at most ${MAX_JOIN_HOPS} hops (got ${hops.length})`);
        }
        this.loadSchemaCacheOnce();
        const tables = [query.from, ...hops.map((hop: JoinHop) => hop.collection)];
        const schemas = tables.map(table => this.requireSchema(table, 'joinMany'));
        const aliases = tables.map((_, index) => `j${index}`);
        const cols: string[] = [];
        for (let i = 0; i < schemas.length; i++) {
            for (const column of schemas[i]!.columns) {
                cols.push(`${aliases[i]}.${quoteIdent(column.name)} AS "${tables[i]}.${column.name}"`);
            }
        }
        let sql = `SELECT ${cols.join(', ')} FROM ${quoteIdent(tables[0]!)} ${aliases[0]}`;
        for (let i = 0; i < hops.length; i++) {
            const hop = hops[i]!;
            const joinKw = hop.type === 'left' ? 'LEFT JOIN' : 'INNER JOIN';
            sql += ` ${joinKw} ${quoteIdent(hop.collection)} ${aliases[i + 1]}`
                + ` ON ${aliases[i]}.${quoteIdent(hop.on.from)} = ${aliases[i + 1]}.${quoteIdent(hop.on.to)}`;
        }
        const types = colTypeMap(...schemas);
        const qualify = (column: string): string => {
            const hits: string[] = [];
            for (let i = 0; i < schemas.length; i++) {
                if (schemas[i]!.columns.some(c => c.name === column)) hits.push(aliases[i]!);
            }
            const alias = hits[0];
            return alias ? `${alias}."${column}"` : `"${column}"`;
        };
        const { where, params } = buildSqliteWhere(query.where, {
            qualify,
            encode: (k, v) => {
                const t = types.get(k);
                return t !== undefined ? encodeValue(v, t) : v;
            },
        });
        sql += ` ${where}`;
        const opts = query.opts;
        if (opts?.orderBy) {
            const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
            sql += ` ORDER BY ${quoteIdent(opts.orderBy)} ${dir}`;
        }
        const effectiveLimit = typeof opts?.limit === 'number'
            ? Math.max(0, Math.floor(opts.limit))
            : 10_000;
        if (Number.isFinite(effectiveLimit)) {
            sql += ` LIMIT ${effectiveLimit}`;
        }
        return this.db.prepare(sql).all(...params) as Row[];
    }

    /**
     * Architecture gap #11 — additive schema evolution. Compares the
     * cached schema for `name` against `newSchema` and applies only
     * additive changes (ADD COLUMN / CREATE INDEX / new
     * extractedFields). Destructive changes throw with a pointer
     * to the Phase 4 orchestrator.
     */
    async evolveSchema(name: string, newSchema: TableSchema): Promise<EvolutionStep[]> {
        this.loadSchemaCacheOnce();
        const current = this.requireSchema(name, 'evolveSchema');
        if (newSchema.name !== name) {
            throw new Error(
                `evolveSchema: name mismatch (current '${name}' vs new '${newSchema.name}'). ` +
                `Rename is a destructive change — use the Phase 4 orchestrator.`,
            );
        }

        const currentByName = new Map(current.columns.map(c => [c.name, c]));
        const newByName = new Map(newSchema.columns.map(c => [c.name, c]));

        // Destructive checks: any removed column or type/primary change
        // gets refused with a clear message.
        for (const oldCol of current.columns) {
            const next = newByName.get(oldCol.name);
            if (!next) {
                throw new Error(
                    `evolveSchema: column '${oldCol.name}' was removed. Destructive. ` +
                    `Use the Phase 4 expand→migrate→contract orchestrator.`,
                );
            }
            if (next.type !== oldCol.type) {
                throw new Error(
                    `evolveSchema: column '${oldCol.name}' type change ${oldCol.type} → ${next.type}. ` +
                    `Destructive — route via Phase 4 orchestrator (field.type_changed decomposition).`,
                );
            }
            if (!!next.primary !== !!oldCol.primary) {
                throw new Error(
                    `evolveSchema: column '${oldCol.name}' primary-key flag changed. Destructive.`,
                );
            }
        }

        const steps: EvolutionStep[] = [];

        // 1.M8 (2026-08-17 audit) — the schema cache was updated only at the
        // very end, so a mid-way ALTER failure left the DB ahead of the
        // cache permanently: every later write to an applied-but-uncached
        // column was silently dropped. Track a working schema and persist
        // the cache after EACH successful ALTER, so a failure leaves the
        // cache accurately describing what physically exists.
        const working: TableSchema = { ...current, columns: current.columns.map(c => ({ ...c })) };
        const commitWorking = (): void => {
            this.schemas.set(name, { ...working, columns: working.columns.map(c => ({ ...c })) });
            this.persistSchemaCache();
        };

        // Additive: brand-new columns.
        for (const newCol of newSchema.columns) {
            if (currentByName.has(newCol.name)) continue;
            if (newCol.primary) {
                throw new Error(
                    `evolveSchema: cannot add a primary-key column ('${newCol.name}') to an existing table. ` +
                    `Primary keys are fixed at create time.`,
                );
            }
            // Build the same column-def fragment createTable uses.
            const parts = [quoteIdent(newCol.name), sqliteType(newCol.type)];
            if (newCol.required) {
                // R4 #8 — type-aware backfill default. A blanket DEFAULT '' put a
                // text empty-string into INTEGER/REAL/boolean columns (wrong type
                // for every existing row). Emit DEFAULT 0 for numeric + boolean;
                // DEFAULT '' only for string/json/date.
                const numericDefault = newCol.type === 'integer' || newCol.type === 'float' || newCol.type === 'boolean';
                parts.push(numericDefault ? 'NOT NULL DEFAULT 0' : 'NOT NULL DEFAULT \'\'');
            }
            if (newCol.unique) {
                // RA2-reaudit2 — SQLite rejects `ALTER TABLE ADD COLUMN ... UNIQUE`
                // unconditionally. Fail up front with a clear message rather than
                // emitting DDL the engine refuses mid-migration.
                throw new Error(`evolveSchema: cannot add UNIQUE column '${newCol.name}' to '${name}' — SQLite forbids ALTER TABLE ADD COLUMN ... UNIQUE. Add it non-unique then CREATE UNIQUE INDEX, or rebuild the table.`);
            }
            this.db.exec(`ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${parts.join(' ')}`);
            steps.push({ kind: 'add_column', column: newCol.name });
            working.columns.push({ ...newCol, extractedFields: newCol.extractedFields ? [...newCol.extractedFields] : undefined });
            commitWorking();
            if (newCol.indexed) {
                this.db.exec(
                    `CREATE INDEX IF NOT EXISTS "idx_${name}_${newCol.name}" ` +
                    `ON ${quoteIdent(name)} (${quoteIdent(newCol.name)})`,
                );
                steps.push({ kind: 'add_index', column: newCol.name });
            }
            // Add sidecar columns for any extractedFields on the new column.
            if (newCol.type === 'json' && newCol.extractedFields) {
                for (const ef of newCol.extractedFields) {
                    quoteIdent(ef.key);
                    const sidecar = `${newCol.name}__${ef.key}`;
                    this.db.exec(
                        `ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${quoteIdent(sidecar)} ${sqliteType(ef.type)}`,
                    );
                    steps.push({ kind: 'add_extracted_field', column: newCol.name, extractedKey: ef.key });
                    if (ef.indexed) {
                        this.db.exec(
                            `CREATE INDEX IF NOT EXISTS "idx_${name}_${sidecar}" ` +
                            `ON ${quoteIdent(name)} (${quoteIdent(sidecar)})`,
                        );
                    }
                }
            }
        }

        // Additive: new index on a previously-unindexed column.
        for (const newCol of newSchema.columns) {
            const old = currentByName.get(newCol.name);
            if (!old) continue;
            if (newCol.indexed && !old.indexed && !old.primary) {
                this.db.exec(
                    `CREATE INDEX IF NOT EXISTS "idx_${name}_${newCol.name}" ` +
                    `ON ${quoteIdent(name)} (${quoteIdent(newCol.name)})`,
                );
                steps.push({ kind: 'add_index', column: newCol.name });
                const wc = working.columns.find(c => c.name === newCol.name);
                if (wc) { wc.indexed = true; commitWorking(); }
            }
        }

        // Additive: new extractedFields on an existing json column.
        for (const newCol of newSchema.columns) {
            const old = currentByName.get(newCol.name);
            if (!old || newCol.type !== 'json') continue;
            const oldKeys = new Set((old.extractedFields ?? []).map(e => e.key));
            for (const ef of newCol.extractedFields ?? []) {
                if (oldKeys.has(ef.key)) continue;
                quoteIdent(ef.key);
                const sidecar = `${newCol.name}__${ef.key}`;
                this.db.exec(
                    `ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${quoteIdent(sidecar)} ${sqliteType(ef.type)}`,
                );
                steps.push({ kind: 'add_extracted_field', column: newCol.name, extractedKey: ef.key });
                const wc = working.columns.find(c => c.name === newCol.name);
                if (wc) { wc.extractedFields = [...(wc.extractedFields ?? []), ef]; commitWorking(); }
                if (ef.indexed) {
                    this.db.exec(
                        `CREATE INDEX IF NOT EXISTS "idx_${name}_${sidecar}" ` +
                        `ON ${quoteIdent(name)} (${quoteIdent(sidecar)})`,
                    );
                }
            }
        }

        // Final commit: the working schema now reflects every applied
        // change (and, after a mid-way throw, only the applied ones).
        commitWorking();

        return steps;
    }

    private requireSchema(table: string, op: string): TableSchema {
        const s = this.schemas.get(table);
        if (!s) {
            // RC2 audit (2026-05-17) Phase 2 — schema-cache mismatch.
            // The DB may physically hold rows for a table whose schema
            // is no longer cached (deleted schemas.json, fresh boot
            // before redeclaration, etc.). Without this branch the
            // caller saw a generic "unknown table" and would not know
            // a re-declare would non-destructively recover the data.
            let physicallyExists = false;
            try {
                const row = this.db.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                ).get(table) as { name?: string } | undefined;
                physicallyExists = !!(row && row.name === table);
            } catch {
                // sqlite_master probe failed (db closed, IO error,
                // etc.) — fall back to the original message rather
                // than masking it.
            }
            if (physicallyExists) {
                throw new Error(
                    `SqliteTableStorage.${op}: table '${table}' exists in the DB but its `
                    + 'schema is not cached. Likely cause: schemas.json was deleted or '
                    + 'an upgrade dropped it. Re-declare the table via createTable() with '
                    + 'the original schema to restore access — data is preserved.',
                );
            }
            throw new Error(
                `SqliteTableStorage.${op}: unknown table '${table}' (createTable first)`,
            );
        }
        return s;
    }

    private mutationContext(): SqliteTableMutationContext {
        return {
            db: this.db,
            requireSchema: (table, op) => this.requireSchema(table, op),
            encodeValue,
            buildWhere: (filter, schema) => buildWhereClause(filter, colTypeMap(schema)),
        };
    }

    private decodeRow(row: Row, schema: TableSchema): Row {
        const out: Row = {};
        for (const c of schema.columns) {
            if (c.name in row) out[c.name] = decodeValue(row[c.name], c.type);
        }
        return out;
    }
}

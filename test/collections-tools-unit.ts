#!/usr/bin/env tsx
/**
 * test/collections-tools-unit.ts — Phase 2 item 4 tests.
 *
 * Verifies the SDK ↔ Lore vocab translation and each handler body
 * (handleCreateCollection, handleInsert, handleGet, handleQuery,
 * handleUpdate, handleDelete, handleSchemaGet) against an in-memory
 * ITableStorage stub. Real the legacy graph engine integration is covered by
 * test/local-graph-table-storage-unit.ts; this file tests the
 * boundary translation + result shaping that the MCP tools (and the
 * REST routes that share these handlers) layer on top.
 */

import { strict as assert } from 'node:assert';

import {
    handleCreateCollection,
    handleSchemaGet,
    handleSchemaList,
    handleSchemaListPaged,
    DEFAULT_SCHEMA_LIST_LIMIT,
    MAX_SCHEMA_LIST_LIMIT,
    handleInsert,
    handleGet,
    handleQuery,
    handleUpdate,
    handleDelete,
    handleBulkInsert,
    handleCount,
    handleUpdateByQuery,
    handleDeleteByQuery,
    handleTruncate,
    isAllFilter,
    sdkToInternalSchema,
    internalToSdkSchema,
    registerCollectionTools,
    type SdkCollectionSchema,
} from '../packages/lore/src/mcp/tools/collections.js';
import { handleTransaction } from '../packages/lore/src/mcp/tools/collectionsTransaction.js';
import { CollectionValidationError, validateRowAgainstSchema } from '../packages/lore/src/engines/collectionRowValidation.js';
import type {
    ITableStorage,
    ListTablesOptions,
    Row,
    TableOp,
    TableOpResult,
    TableSchema,
    TableSchemaSummary,
} from '../packages/lore/src/contracts/tables.js';
import type { Filter, FilterNode, FindOptions } from '../packages/lore/src/engines/collectionStorage.js';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

/** In-memory ITableStorage for unit tests — NOT a legacy graph engine round-trip. */
class FakeTableStorage implements ITableStorage {
    public schemas = new Map<string, TableSchema>();
    private rows = new Map<string, Map<unknown, Row>>();
    public lastQuery: { table: string; filter?: FilterNode; opts?: FindOptions } | null = null;

    capabilities() {
        return {
            join: false,
            caseSensitiveContains: false,
            extractedJsonFields: false,
            additiveSchemaEvolution: false,
        };
    }
    async createTable(schema: TableSchema): Promise<void> {
        this.schemas.set(schema.name, schema);
        if (!this.rows.has(schema.name)) this.rows.set(schema.name, new Map());
    }
    async listTables(opts: ListTablesOptions = {}): Promise<TableSchemaSummary[]> {
        // Mirrors SqliteTableStorage.listTables (incl. the B3 round E2
        // keyset fix): name-sorted for stable pagination, `after`
        // (keyset, `n > after`) takes precedence over `offset` (raw
        // position, unstable under concurrent creates), limit slices
        // BEFORE any counting, withCounts (default true, matching the
        // original unpaginated behavior) gates whether rowCount is
        // computed at all.
        const { offset = 0, limit, withCounts = true, after } = opts;
        const names = Array.from(this.schemas.keys()).sort();
        const start = after !== undefined ? names.findIndex((n) => n > after) : offset;
        const sliceStart = start === -1 ? names.length : start;
        const pageNames = limit === undefined ? names.slice(sliceStart) : names.slice(sliceStart, sliceStart + limit);
        return pageNames.map((name) => {
            const schema = this.schemas.get(name)!;
            return {
                name: schema.name,
                columns: schema.columns,
                primaryKey: schema.columns.find(c => c.primary)?.name ?? '',
                rowCount: withCounts ? (this.rows.get(schema.name)?.size ?? 0) : undefined,
            };
        });
    }
    async insert(table: string, row: Row): Promise<void> {
        const tbl = this.rows.get(table) ?? new Map();
        const pkCol = this.schemas.get(table)?.columns.find(c => c.primary)?.name;
        const key = pkCol ? row[pkCol] : JSON.stringify(row);
        if (tbl.has(key)) throw new Error(`duplicate primary key: ${key}`);
        tbl.set(key, { ...row });
        this.rows.set(table, tbl);
    }
    async insertBatch(table: string, rows: Row[]): Promise<void> {
        for (const r of rows) await this.insert(table, r);
    }
    async query(table: string, filter?: FilterNode, opts?: FindOptions): Promise<Row[]> {
        this.lastQuery = { table, filter, opts };
        const tbl = this.rows.get(table) ?? new Map();
        let out = Array.from(tbl.values());
        const eq = filter && 'eq' in filter ? (filter as Filter).eq : undefined;
        if (eq) {
            for (const [k, v] of Object.entries(eq)) {
                out = out.filter(r => r[k] === v);
            }
        }
        if (opts?.orderBy) {
            const dir = opts.orderDir === 'desc' ? -1 : 1;
            const key = opts.orderBy;
            out.sort((a, b) => {
                const av = a[key] as number | string;
                const bv = b[key] as number | string;
                return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
            });
        }
        if (opts?.limit) out = out.slice(0, opts.limit);
        return out;
    }
    async getByKey<T extends Row = Row>(table: string, key: unknown): Promise<T | null> {
        const r = this.rows.get(table)?.get(key);
        return (r as T) ?? null;
    }
    async update(table: string, filter: FilterNode, patch: Partial<Row>): Promise<number> {
        const matches = await this.query(table, filter);
        for (const r of matches) Object.assign(r, patch);
        return matches.length;
    }
    async delete(table: string, filter: FilterNode): Promise<number> {
        const matches = await this.query(table, filter);
        const tbl = this.rows.get(table)!;
        const pkCol = this.schemas.get(table)?.columns.find(c => c.primary)?.name;
        for (const r of matches) tbl.delete(pkCol ? r[pkCol] : JSON.stringify(r));
        return matches.length;
    }
    async count(table: string, filter?: FilterNode): Promise<number> {
        return (await this.query(table, filter)).length;
    }
    async truncate(table: string): Promise<number> {
        const tbl = this.rows.get(table) ?? new Map();
        const n = tbl.size;
        tbl.clear();
        return n;
    }
    async runTransaction(ops: TableOp[]): Promise<TableOpResult[]> {
        const before = new Map(
            [...this.rows].map(([table, rows]) => [
                table,
                new Map([...rows].map(([key, row]) => [key, { ...row }])),
            ]),
        );
        const results: TableOpResult[] = [];
        let failedOpIndex = -1;
        try {
            for (let i = 0; i < ops.length; i++) {
                failedOpIndex = i;
                const op = ops[i]!;
                if (op.op === 'insert') {
                    await this.insert(op.collection, op.row);
                    const pk = this.schemas.get(op.collection)?.columns.find(c => c.primary)?.name;
                    results.push({ op: 'insert', collection: op.collection, key: pk ? op.row[pk] : undefined });
                } else if (op.op === 'update') {
                    results.push({ op: 'update', collection: op.collection, count: await this.update(op.collection, op.filter, op.patch) });
                } else if (op.op === 'delete') {
                    results.push({ op: 'delete', collection: op.collection, count: await this.delete(op.collection, op.filter) });
                } else {
                    const pk = this.schemas.get(op.collection)?.columns.find(c => c.primary)?.name;
                    const key = pk ? op.row[pk] : undefined;
                    const current = await this.getByKey(op.collection, key);
                    if (current) await this.update(op.collection, { eq: { [pk!]: key } }, op.row);
                    else await this.insert(op.collection, op.row);
                    results.push({ op: 'upsert', collection: op.collection, key });
                }
            }
            return results;
        } catch (error) {
            this.rows = before;
            (error as Error & { failedOpIndex: number }).failedOpIndex = failedOpIndex;
            throw error;
        }
    }
}

const SDK_SCHEMA: SdkCollectionSchema = {
    name: 'customers',
    description: 'CRM customers',
    fields: [
        { name: 'id', field_type: 'string', primary_key: true, required: true },
        { name: 'email', field_type: 'string', unique: true, indexed: true },
        { name: 'age', field_type: 'integer', required: false },
    ],
};

console.log('collections MCP tools — Phase 2 item 4');

/* ---------- vocab translation ---------- */

test('sdkToInternalSchema: field_type → type, primary_key → primary', () => {
    const internal = sdkToInternalSchema(SDK_SCHEMA);
    assert.equal(internal.name, 'customers');
    assert.equal(internal.columns[0].name, 'id');
    assert.equal(internal.columns[0].type, 'string');
    assert.equal(internal.columns[0].primary, true);
    assert.equal(internal.columns[0].required, true);
    assert.equal(internal.columns[1].unique, true);
    assert.equal(internal.columns[1].indexed, true);
    assert.equal(internal.columns[2].required, false);
});

test('internalToSdkSchema: type → field_type, primary → primary_key (round-trip)', () => {
    const internal = sdkToInternalSchema(SDK_SCHEMA);
    const sdk = internalToSdkSchema(internal);
    assert.equal(sdk.fields[0].field_type, 'string');
    assert.equal(sdk.fields[0].primary_key, true);
    assert.equal(sdk.fields[1].unique, true);
    assert.deepEqual(sdk.fields.map(f => f.name), ['id', 'email', 'age']);
});

/* ---------- handlers ---------- */

test('handleCreateCollection delegates to ITableStorage.createTable', async () => {
    const store = new FakeTableStorage();
    const result = await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    assert.deepEqual(result, SDK_SCHEMA);
    assert.ok(store.schemas.has('customers'));
    // Internal schema has Lore vocab.
    assert.equal(store.schemas.get('customers')?.columns[0].primary, true);
});

test('handleSchemaGet returns SDK-shaped schema after createCollection', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    const out = await handleSchemaGet({ tableStorage: store }, 'customers');
    assert.ok(out);
    assert.equal(out!.name, 'customers');
    assert.equal(out!.fields[0].field_type, 'string');
    assert.equal(out!.fields[0].primary_key, true);
});

test('handleSchemaGet returns null for unknown collection', async () => {
    const store = new FakeTableStorage();
    const out = await handleSchemaGet({ tableStorage: store }, 'nonexistent');
    assert.equal(out, null);
});

/* ---------- handleSchemaList (finding #7, 2026-09-03) ---------- */

test('handleSchemaList returns [] when nothing has been created', async () => {
    const store = new FakeTableStorage();
    const out = await handleSchemaList({ tableStorage: store });
    assert.deepEqual(out, []);
});

test('handleSchemaList returns both collections, SDK-shaped, after two creates', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    const ORDERS_SCHEMA: SdkCollectionSchema = {
        name: 'orders',
        fields: [
            { name: 'id', field_type: 'string', primary_key: true, required: true },
            { name: 'amount', field_type: 'integer' },
        ],
    };
    await handleCreateCollection({ tableStorage: store }, ORDERS_SCHEMA);

    const out = await handleSchemaList({ tableStorage: store });
    assert.equal(out.length, 2);
    const byName = new Map(out.map(s => [s.name, s]));
    assert.ok(byName.has('customers'));
    assert.ok(byName.has('orders'));
    assert.equal(byName.get('customers')!.fields[0].field_type, 'string');
    assert.equal(byName.get('customers')!.fields[0].primary_key, true);
    assert.equal(byName.get('orders')!.fields.map(f => f.name).join(','), 'id,amount');
});

test('handleSchemaList reports rowCount per collection', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await handleInsert({ tableStorage: store }, 'customers', { id: 'c1', email: 'a@x.com', age: 1 });
    await handleInsert({ tableStorage: store }, 'customers', { id: 'c2', email: 'b@x.com', age: 2 });

    const out = await handleSchemaList({ tableStorage: store });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.rowCount, 2);
});

/* ---------- handleSchemaListPaged (finding B3, round E, 2026-09-03) ----------
 * Original finding #7 fix (handleSchemaList/listTables) had no pagination
 * and no way to skip the per-table COUNT(*) fan-out. These prove the fix:
 * a 250-table workspace's default call is capped at DEFAULT_SCHEMA_LIST_LIMIT
 * with a cursor, the cursor can be followed to enumerate every table exactly
 * once, and withCounts controls whether rowCount is computed at all. */

async function makeManyTables(store: FakeTableStorage, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
        // Zero-padded names sort predictably (t0000, t0001, ...) so
        // "first page" / "next page" assertions below are deterministic.
        await handleCreateCollection({ tableStorage: store }, {
            name: `t${String(i).padStart(4, '0')}`,
            fields: [{ name: 'id', field_type: 'string', primary_key: true }],
        });
    }
}

test('handleSchemaListPaged: default call on 250 tables returns DEFAULT_SCHEMA_LIST_LIMIT + a cursor', async () => {
    const store = new FakeTableStorage();
    await makeManyTables(store, 250);

    const page = await handleSchemaListPaged({ tableStorage: store });
    assert.equal(page.schemas.length, DEFAULT_SCHEMA_LIST_LIMIT);
    assert.equal(page.schemas[0]!.name, 't0000');
    assert.equal(page.schemas[DEFAULT_SCHEMA_LIST_LIMIT - 1]!.name, `t${String(DEFAULT_SCHEMA_LIST_LIMIT - 1).padStart(4, '0')}`);
    assert.ok(typeof page.nextCursor === 'string' && page.nextCursor.length > 0);
});

test('handleSchemaListPaged: following the cursor enumerates all 250 tables exactly once, then stops', async () => {
    const store = new FakeTableStorage();
    await makeManyTables(store, 250);

    const seen: string[] = [];
    let cursor: string | undefined;
    let iterations = 0;
    do {
        const page: Awaited<ReturnType<typeof handleSchemaListPaged>> = await handleSchemaListPaged({ tableStorage: store }, { cursor });
        for (const s of page.schemas) seen.push(s.name);
        cursor = page.nextCursor;
        iterations++;
        assert.ok(iterations <= 10, 'pagination did not terminate within a sane number of pages');
    } while (cursor !== undefined);

    assert.equal(seen.length, 250);
    assert.equal(new Set(seen).size, 250, 'no table should appear twice across pages');
    assert.equal(iterations, 3); // 100 + 100 + 50, ceil(250/100)
});

test('handleSchemaListPaged: withCounts false (default) omits rowCount', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await handleInsert({ tableStorage: store }, 'customers', { id: 'c1', email: 'a@x.com', age: 1 });

    const page = await handleSchemaListPaged({ tableStorage: store });
    assert.equal(page.schemas.length, 1);
    assert.equal(page.schemas[0]!.rowCount, undefined);
});

test('handleSchemaListPaged: withCounts true includes rowCount', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await handleInsert({ tableStorage: store }, 'customers', { id: 'c1', email: 'a@x.com', age: 1 });
    await handleInsert({ tableStorage: store }, 'customers', { id: 'c2', email: 'b@x.com', age: 2 });

    const page = await handleSchemaListPaged({ tableStorage: store }, { withCounts: true });
    assert.equal(page.schemas.length, 1);
    assert.equal(page.schemas[0]!.rowCount, 2);
});

test('handleSchemaListPaged: no nextCursor when everything fits on one page', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);

    const page = await handleSchemaListPaged({ tableStorage: store });
    assert.equal(page.schemas.length, 1);
    assert.equal(page.nextCursor, undefined);
});

test('handleSchemaListPaged: limit is clamped to MAX_SCHEMA_LIST_LIMIT', async () => {
    const store = new FakeTableStorage();
    await makeManyTables(store, 5);

    const page = await handleSchemaListPaged({ tableStorage: store }, { limit: MAX_SCHEMA_LIST_LIMIT + 500 });
    assert.equal(page.schemas.length, 5);
    assert.equal(page.nextCursor, undefined);
});

/* ---------- handleSchemaListPaged keyset cursor (finding B3, round E2, 2026-09-03) ----------
 * The round-E fix's cursor encoded a raw numeric offset, but the
 * underlying name-sorted list is re-derived fresh on every call — a
 * table created between two page fetches, whose name sorts before the
 * boundary, shifts every later name's position by one, so the
 * boundary entry comes back twice. The fix switches the cursor to a
 * keyset (last-returned name, `n > lastName`), which doesn't move
 * when something is created elsewhere in the set. */

test('handleSchemaListPaged: creating a table before the page boundary mid-walk causes no duplicates and no skips', async () => {
    const store = new FakeTableStorage();
    await makeManyTables(store, 25); // t0000..t0024

    const page1 = await handleSchemaListPaged({ tableStorage: store }, { limit: 10 });
    assert.equal(page1.schemas.length, 10);
    assert.equal(page1.schemas[9]!.name, 't0009');
    assert.ok(page1.nextCursor);

    // Sorts before every existing "t..." name and before the just-returned
    // boundary entry ("t0009") — this is the shape that triggered the
    // duplicate under the old offset-based cursor.
    await handleCreateCollection({ tableStorage: store }, {
        name: 'aaa_inserted_before_boundary',
        fields: [{ name: 'id', field_type: 'string', primary_key: true }],
    });

    const seen: string[] = [...page1.schemas.map(s => s.name)];
    let cursor: string | undefined = page1.nextCursor;
    let iterations = 1;
    while (cursor !== undefined) {
        const page: Awaited<ReturnType<typeof handleSchemaListPaged>> = await handleSchemaListPaged({ tableStorage: store }, { limit: 10, cursor });
        for (const s of page.schemas) seen.push(s.name);
        cursor = page.nextCursor;
        iterations++;
        assert.ok(iterations <= 10, 'pagination did not terminate within a sane number of pages');
    }

    // The 25 pre-existing tables must each appear exactly once across the
    // full walk — no duplicate of the page1/page2 boundary ("t0009"), and
    // nothing skipped ("t0010" must still be present).
    const tTableSeen = seen.filter(n => n.startsWith('t0'));
    assert.equal(tTableSeen.length, 25, `expected all 25 pre-existing tables exactly once, got: ${JSON.stringify(tTableSeen)}`);
    assert.equal(new Set(tTableSeen).size, 25, 'no pre-existing table should appear twice across pages');
    assert.ok(tTableSeen.includes('t0010'), 't0010 must not be skipped');
    assert.equal(seen.filter(n => n === 't0009').length, 1, 't0009 (the page1/page2 boundary) must not be duplicated');
});

test('handleSchemaListPaged: a table created after the page boundary appears exactly once', async () => {
    const store = new FakeTableStorage();
    await makeManyTables(store, 25); // t0000..t0024

    const page1 = await handleSchemaListPaged({ tableStorage: store }, { limit: 10 });
    assert.ok(page1.nextCursor);

    // Sorts after every existing name, so it lands at the very end of the walk.
    await handleCreateCollection({ tableStorage: store }, {
        name: 'zzz_inserted_after_boundary',
        fields: [{ name: 'id', field_type: 'string', primary_key: true }],
    });

    const seen: string[] = [...page1.schemas.map(s => s.name)];
    let cursor: string | undefined = page1.nextCursor;
    let iterations = 1;
    while (cursor !== undefined) {
        const page: Awaited<ReturnType<typeof handleSchemaListPaged>> = await handleSchemaListPaged({ tableStorage: store }, { limit: 10, cursor });
        for (const s of page.schemas) seen.push(s.name);
        cursor = page.nextCursor;
        iterations++;
        assert.ok(iterations <= 10, 'pagination did not terminate within a sane number of pages');
    }

    assert.equal(seen.filter(n => n === 'zzz_inserted_after_boundary').length, 1,
        'a table created after the boundary must appear exactly once in the rest of the walk');
});

test('handleSchemaListPaged: an old-style numeric-offset cursor is treated as malformed and ignored', async () => {
    const store = new FakeTableStorage();
    await makeManyTables(store, 5); // t0000..t0004

    // Shape produced by the pre-round-E2 encoder (`{offset: number}`,
    // no `after` field) — must not throw, and must not be honored as a
    // position; it should fall back to `offset` (0, since none is given
    // here) exactly like garbage/truncated base64url does.
    const oldStyleCursor = Buffer.from(JSON.stringify({ offset: 2 }), 'utf8').toString('base64url');

    const page = await handleSchemaListPaged({ tableStorage: store }, { cursor: oldStyleCursor });
    assert.equal(page.schemas.length, 5, 'old-style cursor should fall back to offset 0, returning the full set');
    assert.equal(page.schemas[0]!.name, 't0000');
});

test('handleInsert returns the inserted record', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    const row = { id: 'c1', email: 'a@x.com', age: 30 };
    const result = await handleInsert({ tableStorage: store }, 'customers', row);
    assert.deepEqual(result, row);
});

test('handleInsert throws on duplicate primary key', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await handleInsert({ tableStorage: store }, 'customers', { id: 'c1', email: 'a' });
    await assert.rejects(
        () => handleInsert({ tableStorage: store }, 'customers', { id: 'c1', email: 'b' }),
        /duplicate primary key/,
    );
});

test('handleGet returns the row by primary key', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await handleInsert({ tableStorage: store }, 'customers', { id: 'c1', email: 'a@x.com', age: 30 });
    const out = await handleGet({ tableStorage: store }, 'customers', 'c1');
    assert.equal((out as Record<string, unknown>)?.email, 'a@x.com');
});

test('handleGet returns null when row absent', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    const out = await handleGet({ tableStorage: store }, 'customers', 'nope');
    assert.equal(out, null);
});

test('handleQuery returns {records, total_count, has_more} shape', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insertBatch('customers', [
        { id: 'a', email: 'a@x.com', age: 1 },
        { id: 'b', email: 'b@x.com', age: 2 },
        { id: 'c', email: 'c@x.com', age: 3 },
    ]);
    const out = await handleQuery({ tableStorage: store }, 'customers', undefined, undefined);
    assert.equal(out.records.length, 3);
    assert.equal(out.total_count, 3);
    assert.equal(out.has_more, false);
});

test('handleQuery sets has_more=true when limit reached exactly', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insertBatch('customers', [
        { id: 'a', email: 'a@x.com' },
        { id: 'b', email: 'b@x.com' },
        { id: 'c', email: 'c@x.com' },
    ]);
    const out = await handleQuery({ tableStorage: store }, 'customers', undefined, { limit: 2 });
    assert.equal(out.records.length, 2);
    assert.equal(out.has_more, true);
});

test('handleQuery applies eq filter', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insertBatch('customers', [
        { id: 'a', email: 'x@x.com', age: 1 },
        { id: 'b', email: 'x@x.com', age: 2 },
        { id: 'c', email: 'y@x.com', age: 3 },
    ]);
    const out = await handleQuery(
        { tableStorage: store },
        'customers',
        { eq: { email: 'x@x.com' } },
        undefined,
    );
    assert.equal(out.records.length, 2);
});

test('handleUpdate returns {updated: count} and applies patch', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insert('customers', { id: 'u1', email: 'old@x.com', age: 1 });
    const result = await handleUpdate(
        { tableStorage: store },
        'customers',
        { eq: { id: 'u1' } },
        { email: 'new@x.com' },
    );
    assert.equal(result.updated, 1);
    const row = await handleGet({ tableStorage: store }, 'customers', 'u1');
    assert.equal((row as Record<string, unknown>)?.email, 'new@x.com');
});

test('handleDelete returns {deleted: count} and removes the row', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insert('customers', { id: 'd1', email: 'gone@x.com' });
    const result = await handleDelete(
        { tableStorage: store },
        'customers',
        { eq: { id: 'd1' } },
    );
    assert.equal(result.deleted, 1);
    const row = await handleGet({ tableStorage: store }, 'customers', 'd1');
    assert.equal(row, null);
});

test('handleTransaction returns every operation result atomically', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insert('customers', { id: 'old', email: 'old@x.com' });
    const result = await handleTransaction({ tableStorage: store }, {
        operations: [
            { op: 'insert', collection: 'customers', row: { id: 'new', email: 'new@x.com' } },
            { op: 'update', collection: 'customers', filter: { eq: { id: 'old' } }, patch: { email: 'updated@x.com' } },
        ],
    });
    assert.equal(result.results.length, 2);
    assert.equal((await store.getByKey('customers', 'old'))?.email, 'updated@x.com');
});

/* ---------- F-COL2 (Wave 2): unscoped update/delete data-loss guard ---------- */

test('F-COL2: handleUpdate REFUSES an empty/all filter without all:true (no silent wipe)', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insert('customers', { id: 'u1', email: 'a@x.com' });
    await store.insert('customers', { id: 'u2', email: 'b@x.com' });
    // Empty filter matches every row → must be refused unless the caller opts in.
    await assert.rejects(
        () => handleUpdate({ tableStorage: store }, 'customers', {} as never, { email: 'WIPED@x.com' }),
        /refuses an empty\/all filter|all:true/i,
        'unscoped update must be refused',
    );
    // Explicit opt-in (all:true) proceeds — the intentional bulk update.
    const ok = await handleUpdate({ tableStorage: store }, 'customers', {} as never, { email: 'intentional@x.com' }, true);
    assert.equal(ok.updated, 2);
});

test('F-COL2: handleUpdate REFUSES a nested and/or filter that reduces to all-rows', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insert('customers', { id: 'u3', email: 'c@x.com' });
    await store.insert('customers', { id: 'u4', email: 'd@x.com' });
    // `or: [{ eq: {} }]` still matches every row — the empty leaf inside the
    // OR must not be waved through just because it's wrapped in a boolean node.
    const nestedAllFilter = { or: [{ eq: {} }] } as never;
    await assert.rejects(
        () => handleUpdate({ tableStorage: store }, 'customers', nestedAllFilter, { email: 'WIPED@x.com' }),
        /refuses an empty\/all filter|all:true/i,
        'nested empty-inside-or update must be refused',
    );
    const ok = await handleUpdate({ tableStorage: store }, 'customers', nestedAllFilter, { email: 'intentional@x.com' }, true);
    assert.equal(ok.updated, 2);
});

test('F-COL2: handleDelete REFUSES an empty/all filter without all:true (no silent wipe)', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insert('customers', { id: 'd1', email: 'x@x.com' });
    await store.insert('customers', { id: 'd2', email: 'y@x.com' });
    await assert.rejects(
        () => handleDelete({ tableStorage: store }, 'customers', {} as never),
        /refuses an empty\/all filter|all:true/i,
        'unscoped delete must be refused',
    );
    // F-COL1: a whitespace/empty `contains` is also treated as all-rows → refused.
    await assert.rejects(
        () => handleDelete({ tableStorage: store }, 'customers', { contains: { email: '' } } as never),
        /refuses an empty\/all filter|all:true/i,
        'empty-contains must not bypass the guard',
    );
    const ok = await handleDelete({ tableStorage: store }, 'customers', {} as never, true);
    assert.equal(ok.deleted, 2);
});

test('F-COL2: handleDelete REFUSES a nested and/or filter that reduces to all-rows', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insert('customers', { id: 'd3', email: 'z@x.com' });
    await store.insert('customers', { id: 'd4', email: 'w@x.com' });
    // `and: [{ eq: {} }, { eq: {} }]` — every branch is unscoped, so the AND
    // as a whole still matches every row and must not bypass the guard.
    const nestedAllFilter = { and: [{ eq: {} }, { eq: {} }] } as never;
    await assert.rejects(
        () => handleDelete({ tableStorage: store }, 'customers', nestedAllFilter),
        /refuses an empty\/all filter|all:true/i,
        'nested empty-inside-and delete must be refused',
    );
    const ok = await handleDelete({ tableStorage: store }, 'customers', nestedAllFilter, true);
    assert.equal(ok.deleted, 2);
});

/* ---------- Phase 2.5 bulk variants ---------- */

test('handleBulkInsert returns {inserted, ids, total_requested}', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    const result = await handleBulkInsert({ tableStorage: store }, 'customers', [
        { id: 'b1', email: 'b1@x.com' },
        { id: 'b2', email: 'b2@x.com' },
    ]);
    assert.equal(result.inserted, 2);
    assert.equal(result.total_requested, 2);
    assert.deepEqual(result.ids, ['b1', 'b2']);
});

test('handleBulkInsert throws on empty records array', async () => {
    const store = new FakeTableStorage();
    await assert.rejects(
        () => handleBulkInsert({ tableStorage: store }, 'customers', []),
        /non-empty/,
    );
});

test('handleCount returns {count, collection}', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insertBatch('customers', [
        { id: 'a', email: 'a@x.com' },
        { id: 'b', email: 'b@x.com' },
    ]);
    const r = await handleCount({ tableStorage: store }, 'customers');
    assert.equal(r.count, 2);
    assert.equal(r.collection, 'customers');
});

test('handleCount with filter only counts matching rows', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insertBatch('customers', [
        { id: 'a', email: 'x@x.com' },
        { id: 'b', email: 'x@x.com' },
        { id: 'c', email: 'y@x.com' },
    ]);
    const r = await handleCount({ tableStorage: store }, 'customers', { eq: { email: 'x@x.com' } });
    assert.equal(r.count, 2);
});

test('handleUpdateByQuery returns {updated, collection}', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insert('customers', { id: 'u1', email: 'old@x.com', age: 1 });
    const r = await handleUpdateByQuery(
        { tableStorage: store }, 'customers',
        { eq: { id: 'u1' } }, { email: 'new@x.com' },
    );
    assert.equal(r.updated, 1);
    assert.equal(r.collection, 'customers');
});

test('isAllFilter recognises empty/missing filters', () => {
    assert.equal(isAllFilter(undefined), true);
    assert.equal(isAllFilter({}), true);
    assert.equal(isAllFilter({ eq: {} }), true);
    assert.equal(isAllFilter({ eq: { id: 'a' } }), false);
    assert.equal(isAllFilter({ contains: { name: 'x' } }), false);
});

test('isAllFilter recurses into nested and/or/not filters (blind-spot fix)', () => {
    // Bug case: an empty leaf nested inside `or` still matches every row —
    // the recursion must reach it, not stop at the boolean node.
    assert.equal(isAllFilter({ or: [{ eq: {} }] }), true);
    // Bug case: every branch of an `and` is unscoped → the AND is unscoped too.
    assert.equal(isAllFilter({ and: [{ eq: {} }, { eq: {} }] }), true);
    // Regression guard: one real predicate in an `and` narrows the whole
    // thing — must stay scoped even though a sibling branch is empty.
    assert.equal(isAllFilter({ and: [{ eq: { status: 'archived' } }, { eq: {} }] }), false);
    // Both `or` branches are real predicates — the union is still scoped.
    assert.equal(
        isAllFilter({ or: [{ eq: { status: 'archived' } }, { eq: { status: 'draft' } }] }),
        false,
    );
    // `not` of an all-filter matches nothing, not everything — never unscoped.
    assert.equal(isAllFilter({ not: { eq: {} } }), false);
    // Multi-level nesting: empty leaf wrapped in `and`, wrapped in `or` —
    // confirms the recursion reaches leaves at any depth, not just one level.
    assert.equal(isAllFilter({ or: [{ and: [{ eq: {} }] }] }), true);
});

test('handleDeleteByQuery refuses an all-filter (footgun guard)', async () => {
    const store = new FakeTableStorage();
    await assert.rejects(
        () => handleDeleteByQuery({ tableStorage: store }, 'customers', {}),
        /use truncate/i,
    );
    await assert.rejects(
        () => handleDeleteByQuery({ tableStorage: store }, 'customers', { eq: {} }),
        /use truncate/i,
    );
});

test('handleDeleteByQuery returns {deleted, collection} for a real filter', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insertBatch('customers', [
        { id: 'd1', email: 'gone@x.com' },
        { id: 'd2', email: 'stay@x.com' },
    ]);
    const r = await handleDeleteByQuery(
        { tableStorage: store }, 'customers',
        { eq: { email: 'gone@x.com' } },
    );
    assert.equal(r.deleted, 1);
    assert.equal(r.collection, 'customers');
});

test('handleTruncate wipes the collection and returns {truncated, deleted}', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, SDK_SCHEMA);
    await store.insertBatch('customers', [
        { id: 'a', email: 'a@x.com' },
        { id: 'b', email: 'b@x.com' },
        { id: 'c', email: 'c@x.com' },
    ]);
    const r = await handleTruncate({ tableStorage: store }, 'customers');
    assert.equal(r.truncated, true);
    assert.equal(r.deleted, 3);
    const remaining = await handleCount({ tableStorage: store }, 'customers');
    assert.equal(remaining.count, 0);
});

/* ---------- F6 (2026-09-03 audit): reject invalid rows before storage ---------- */
// Before this fix, none of these threw a recognizable error — they either
// silently succeeded with corrupted data (string into integer) or blew up
// deep inside SqliteTableStorage as a plain, unclassified Error (surfaced
// by the REST/MCP layers as a 500). Every case here must now throw
// CollectionValidationError, naming the offending table + field.

const VALIDATION_SCHEMA: SdkCollectionSchema = {
    name: 'accounts',
    fields: [
        { name: 'id', field_type: 'string', primary_key: true, required: true },
        { name: 'name', field_type: 'string' },
        { name: 'age', field_type: 'integer' },
        { name: 'active', field_type: 'boolean' },
    ],
};

test('handleInsert rejects an unknown field with table + field named', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleInsert({ tableStorage: store }, 'accounts', { id: 'a1', bogus: 'x' } as Row),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.table, 'accounts');
            assert.equal(err.field, 'bogus');
            return true;
        },
    );
    // Nothing was stored.
    assert.equal(await handleGet({ tableStorage: store }, 'accounts', 'a1'), null);
});

test('handleInsert rejects a wrong-typed boolean ("maybe" is not true/false)', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleInsert({ tableStorage: store }, 'accounts', { id: 'a2', active: 'maybe' } as unknown as Row),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.field, 'active');
            return true;
        },
    );
});

test('handleInsert rejects an object where a string column is declared', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleInsert({ tableStorage: store }, 'accounts', { id: 'a3', name: { first: 'x' } } as unknown as Row),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.field, 'name');
            return true;
        },
    );
});

test('handleInsert rejects an array where an integer column is declared', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleInsert({ tableStorage: store }, 'accounts', { id: 'a4', age: [1, 2, 3] } as unknown as Row),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.field, 'age');
            return true;
        },
    );
});

test('handleInsert rejects an empty row', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleInsert({ tableStorage: store }, 'accounts', {} as Row),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.table, 'accounts');
            return true;
        },
    );
});

test('handleInsert rejects a numeric string into an integer column (reject, not coerce)', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleInsert({ tableStorage: store }, 'accounts', { id: 'a5', age: '5' } as unknown as Row),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.field, 'age');
            return true;
        },
    );
});

test('handleInsert still accepts a fully valid row', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    const row = { id: 'ok1', name: 'Ada', age: 30, active: true };
    const result = await handleInsert({ tableStorage: store }, 'accounts', row);
    assert.deepEqual(result, row);
    const got = await handleGet({ tableStorage: store }, 'accounts', 'ok1');
    assert.equal((got as Record<string, unknown>)?.active, true);
});

/**
 * Round-S fix (2026-09-04, finding 1) — a column whose `type` was never
 * recorded (e.g. a schema persisted before the create route validated its
 * body) must not reject every value with the nonsensical "expected type
 * 'undefined'". `typeMatches`'s switch has no case for a missing type, so
 * it always returned falsy for one, and every insert 400'd regardless of
 * the value's actual shape — this was the exact failure mode QA smoke
 * finding 11 hit downstream of finding 1's create-time hole.
 */
test('validateRowAgainstSchema does not reject a value when the column type is undefined', () => {
    const schemaWithMissingType: TableSchema = {
        name: 'legacy_coll',
        columns: [
            { name: 'id', type: undefined as unknown as TableSchema['columns'][number]['type'], primary: true },
            { name: 'val', type: undefined as unknown as TableSchema['columns'][number]['type'] },
        ],
    };
    // Must not throw, and must not mention "'undefined'" for either column.
    assert.doesNotThrow(() => validateRowAgainstSchema(schemaWithMissingType, { id: 'r1', val: 'a' }, 'insert'));
});

test('handleInsert with an undefined-typed column accepts the row instead of 400ing "expected type \'undefined\'"', async () => {
    const store = new FakeTableStorage();
    const schema: TableSchema = {
        name: 'legacy_coll2',
        columns: [{ name: 'id', type: undefined as unknown as TableSchema['columns'][number]['type'], primary: true }],
    };
    await store.createTable(schema);
    const result = await handleInsert({ tableStorage: store }, 'legacy_coll2', { id: 'r1' });
    assert.deepEqual(result, { id: 'r1' });
});

test('handleBulkInsert rejects a bad row and names its index + field, inserting nothing', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleBulkInsert({ tableStorage: store }, 'accounts', [
            { id: 'b1', name: 'ok' },
            { id: 'b2', bogus: true } as unknown as Row,
            { id: 'b3', name: 'also ok' },
        ]),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.rowIndex, 1);
            assert.equal(err.field, 'bogus');
            return true;
        },
    );
    // Pre-validation runs before any insert call, so row 0 (which would have
    // succeeded on its own) must NOT have been written either.
    assert.equal(await handleGet({ tableStorage: store }, 'accounts', 'b1'), null);
});

test('handleUpdate rejects an unknown field in the patch', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await store.insert('accounts', { id: 'u1', name: 'old' });
    await assert.rejects(
        () => handleUpdate({ tableStorage: store }, 'accounts', { eq: { id: 'u1' } }, { bogus: 'x' }),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.field, 'bogus');
            return true;
        },
    );
});

test('handleUpdate rejects a wrong-typed value in the patch', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await store.insert('accounts', { id: 'u2', age: 1 });
    await assert.rejects(
        () => handleUpdate({ tableStorage: store }, 'accounts', { eq: { id: 'u2' } }, { age: 'old' }),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.field, 'age');
            return true;
        },
    );
});

/* ---------- B2 (QA finding, 2026-09-03): handleTransaction pre-validates
 * every op, matching handleInsert/handleUpdate/handleBulkInsert/
 * handleUpdateByQuery above. Before this fix, collection_transaction /
 * POST /v1/transaction called runTransaction directly with no schema/
 * filter check, so a wrong-typed value was silently coerced (or an
 * unknown column surfaced as an opaque, unclassified Error) instead of
 * a clean CollectionValidationError with nothing applied. */

test('handleTransaction rejects a numeric string into an integer column, naming the op index + field', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleTransaction({ tableStorage: store }, {
            operations: [
                { op: 'insert', collection: 'accounts', row: { id: 'tx-a1', age: '5' } },
            ],
        }),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.table, 'accounts');
            assert.equal(err.field, 'age');
            assert.equal(err.rowIndex, 0); // reuses the bulk row_index convention for the op index
            return true;
        },
    );
    assert.equal(await handleGet({ tableStorage: store }, 'accounts', 'tx-a1'), null); // nothing applied
});

test('handleTransaction rejects an unknown column, naming the op index + field, nothing applied', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleTransaction({ tableStorage: store }, {
            operations: [
                { op: 'insert', collection: 'accounts', row: { id: 'tx-a2', bogus: 1 } },
            ],
        }),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.table, 'accounts');
            assert.equal(err.field, 'bogus');
            assert.equal(err.rowIndex, 0);
            return true;
        },
    );
    assert.equal(await handleGet({ tableStorage: store }, 'accounts', 'tx-a2'), null);
});

test('handleTransaction rejects an unknown column in an upsert row', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleTransaction({ tableStorage: store }, {
            operations: [
                { op: 'upsert', collection: 'accounts', row: { id: 'tx-a3', bogus: 1 } },
            ],
        }),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.field, 'bogus');
            return true;
        },
    );
});

test('handleTransaction rejects a wrong-typed value in an update patch', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await store.insert('accounts', { id: 'tx-a4', age: 1 });
    await assert.rejects(
        () => handleTransaction({ tableStorage: store }, {
            operations: [
                { op: 'update', collection: 'accounts', filter: { eq: { id: 'tx-a4' } }, patch: { age: 'old' } },
            ],
        }),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.field, 'age');
            return true;
        },
    );
    // Patch was never applied.
    assert.equal((await handleGet({ tableStorage: store }, 'accounts', 'tx-a4') as Row).age, 1);
});

test('handleTransaction validates every op BEFORE running any of them (first op valid, second invalid)', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleTransaction({ tableStorage: store }, {
            operations: [
                { op: 'insert', collection: 'accounts', row: { id: 'tx-good', name: 'ok' } },
                { op: 'insert', collection: 'accounts', row: { id: 'tx-bad', bogus: 1 } },
            ],
        }),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.equal(err.rowIndex, 1);
            return true;
        },
    );
    // Op 0 would have succeeded on its own — pre-validating every op first
    // means it must NOT have been written either.
    assert.equal(await handleGet({ tableStorage: store }, 'accounts', 'tx-good'), null);
});

test('handleTransaction still accepts a fully valid transaction (200-equivalent: resolves)', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    const result = await handleTransaction({ tableStorage: store }, {
        operations: [
            { op: 'insert', collection: 'accounts', row: { id: 'tx-ok', name: 'Ada', age: 30, active: true } },
        ],
    });
    assert.equal(result.results.length, 1);
    assert.equal((await handleGet({ tableStorage: store }, 'accounts', 'tx-ok') as Row).name, 'Ada');
});

test('handleTransaction refuses an empty/all filter on an update op (defense-in-depth, no all:true escape hatch)', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await store.insert('accounts', { id: 'tx-scope-1', name: 'keep-me' });
    await assert.rejects(
        () => handleTransaction({ tableStorage: store }, {
            operations: [
                { op: 'update', collection: 'accounts', filter: {}, patch: { name: 'WIPED' } },
            ],
        }),
        /refuses a structurally invalid filter|empty\/all filter/i,
    );
    assert.equal((await handleGet({ tableStorage: store }, 'accounts', 'tx-scope-1') as Row).name, 'keep-me');
});

test('handleTransaction refuses an empty/all filter on a delete op (defense-in-depth)', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await store.insert('accounts', { id: 'tx-scope-2', name: 'keep-me-too' });
    await assert.rejects(
        () => handleTransaction({ tableStorage: store }, {
            operations: [
                { op: 'delete', collection: 'accounts', filter: {} },
            ],
        }),
        /refuses a structurally invalid filter|empty\/all filter/i,
    );
    assert.equal(await handleGet({ tableStorage: store }, 'accounts', 'tx-scope-2') !== null, true);
});

/* ---------- QA follow-up (2026-09-03, low): describeValue NaN/Infinity ---------- */
// JSON.stringify(NaN) and JSON.stringify(Infinity) both serialize to the
// string "null", so before this fix an invalid NaN/Infinity value rendered
// as the misleading "number null" — indistinguishable from an actual null.

test('handleInsert names a NaN value literally, not as "number null"', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleInsert({ tableStorage: store }, 'accounts', { id: 'nan1', age: NaN } as unknown as Row),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.ok(err.message.includes('NaN'), `expected message to name NaN, got: ${err.message}`);
            assert.ok(!err.message.includes('number null'), `message must not read "number null": ${err.message}`);
            return true;
        },
    );
});

test('handleInsert names an Infinity value literally, not as "number null"', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    await assert.rejects(
        () => handleInsert({ tableStorage: store }, 'accounts', { id: 'inf1', age: Infinity } as unknown as Row),
        (err: unknown) => {
            assert.ok(err instanceof CollectionValidationError);
            assert.ok(err.message.includes('Infinity'), `expected message to name Infinity, got: ${err.message}`);
            assert.ok(!err.message.includes('number null'), `message must not read "number null": ${err.message}`);
            return true;
        },
    );
});

/*
 * A3 round-2 (QA finding, 2026-09-03) — assertValidFilter's INVALID message
 * (collectionsFilterScope.ts) used to quote and/or in single quotes
 * ("an 'and'/'or' with no branches..."). mcpToolError -> redactError
 * (security/logRedact.ts) treats any single-quoted token as a possible
 * leaked node id and hashes it, so an MCP caller of collection_update /
 * collection_delete (the tools that route assertValidFilter's throw
 * through mcpToolError) saw mangled "id#<hash>" garbage in place of the
 * operator names instead of readable guidance. Drives the REAL registered
 * `collection_update` MCP tool handler (via registerCollectionTools, same
 * stub-server capture pattern test/sp23-mcp-tools-unit.ts uses) with a
 * filter nested past MAX_FILTER_NESTING, and asserts the envelope text is
 * still readable.
 */
type McpToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function captureRegisteredTools(store: FakeTableStorage): Record<string, McpToolHandler> {
    const tools: Record<string, McpToolHandler> = {};
    const server = {
        tool(name: string, _desc: string, _schema: unknown, fn: McpToolHandler) { tools[name] = fn; },
    };
    registerCollectionTools(server as never, { tableStorage: store });
    return tools;
}

function nestAnd(depth: number, leaf: unknown): unknown {
    let f = leaf;
    for (let i = 0; i < depth; i++) f = { and: [f] };
    return f;
}

test('collection_update MCP tool: an over-nested filter error envelope keeps and/or readable, with no id# redaction garbage', async () => {
    const store = new FakeTableStorage();
    await handleCreateCollection({ tableStorage: store }, VALIDATION_SCHEMA);
    const tools = captureRegisteredTools(store);
    const result = await tools['collection_update']!({
        collection: 'accounts',
        filter: nestAnd(9, { eq: { id: 'r1' } }), // depth 9 > MAX_FILTER_NESTING (8)
        updates: { name: 'x' },
        workspace: 'ws-test',
    });
    assert.equal(result.isError, true);
    const text = result.content[0]!.text;
    assert.match(text, /and\/or/, `expected readable "and/or" wording, got: ${text}`);
    assert.ok(!/id#[0-9a-f]{8}/.test(text), `expected no redaction hash garbage, got: ${text}`);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

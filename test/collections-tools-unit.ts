#!/usr/bin/env tsx
/**
 * test/collections-tools-unit.ts — Phase 2 item 4 tests.
 *
 * Verifies the SDK ↔ Lore vocab translation and each handler body
 * (handleCreateCollection, handleInsert, handleGet, handleQuery,
 * handleUpdate, handleDelete, handleSchemaGet) against an in-memory
 * ITableStorage stub. Real Kùzu integration is covered by
 * test/local-graph-table-storage-unit.ts; this file tests the
 * boundary translation + result shaping that the MCP tools (and the
 * REST routes that share these handlers) layer on top.
 */

import { strict as assert } from 'node:assert';

import {
    handleCreateCollection,
    handleSchemaGet,
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
    type SdkCollectionSchema,
} from '../packages/lore/src/mcp/tools/collections.js';
import { handleTransaction } from '../packages/lore/src/mcp/tools/collectionsTransaction.js';
import type {
    ITableStorage,
    Row,
    TableOp,
    TableOpResult,
    TableSchema,
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

/** In-memory ITableStorage for unit tests — NOT a Kùzu round-trip. */
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

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env tsx
/**
 * sqlite-table-storage-unit.ts — verifies SqliteTableStorage implements
 * the full ITableStorage contract against a real on-disk SQLite file
 * (per-test tmpdir). better-sqlite3 has no in-memory mocking story —
 * the cost of a real file in /tmp is negligible.
 *
 * Coverage:
 *   - createTable idempotent + schema-change error
 *   - insert / insertBatch (transaction semantics)
 *   - query with every Filter operator + orderBy/limit
 *   - getByKey hit + miss
 *   - update / delete + delete refuses empty-filter
 *   - count + truncate
 *   - join (inner) with prefixed columns
 *   - JSON column round-trips
 *   - schema-cache persistence across instances
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

function mkTmp(): { dbPath: string; cachePath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sqlite-'));
    return {
        dbPath: path.join(dir, 'tables.sqlite'),
        cachePath: path.join(dir, 'schemas.json'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

const TENANT: TableSchema = {
    name: 'tenant',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string', required: true, indexed: true },
        { name: 'rent', type: 'integer' },
        { name: 'active', type: 'boolean' },
        { name: 'moved_in', type: 'datetime' },
        { name: 'meta', type: 'json' },
    ],
};

console.log('SqliteTableStorage');

/* ---------- schema lifecycle ---------- */

test('createTable creates the table and is idempotent', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.createTable(TENANT); // second call: no-op
        await s.insert('tenant', { id: 't1', name: 'Alice', rent: 1200, active: true });
        const got = await s.getByKey('tenant', 't1');
        assert.equal((got as any).name, 'Alice');
        s.close();
    } finally { t.cleanup(); }
});

test('createTable with changed shape throws', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await assert.rejects(
            () => s.createTable({ ...TENANT, columns: [...TENANT.columns, { name: 'extra', type: 'string' }] }),
            /already exists with a different shape/i,
        );
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- Q1.10 — all-or-nothing typed transactions ---------- */

test('runTransaction commits insert, update, delete, and upsert together', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insertBatch('tenant', [
            { id: 'old', name: 'Old', rent: 10 },
            { id: 'gone', name: 'Gone', rent: 20 },
        ]);
        const results = await s.runTransaction([
            { op: 'insert', collection: 'tenant', row: { id: 'new', name: 'New', rent: 30 } },
            { op: 'update', collection: 'tenant', filter: { eq: { id: 'old' } }, patch: { rent: 11 } },
            { op: 'delete', collection: 'tenant', filter: { eq: { id: 'gone' } } },
            { op: 'upsert', collection: 'tenant', row: { id: 'new', name: 'Newer', rent: 31 } },
        ]);
        assert.equal(results.length, 4);
        assert.equal((await s.getByKey('tenant', 'old'))?.rent, 11);
        assert.equal(await s.getByKey('tenant', 'gone'), null);
        assert.equal((await s.getByKey('tenant', 'new'))?.name, 'Newer');
        s.close();
    } finally { t.cleanup(); }
});

test('runTransaction rolls every touched table back when one operation fails', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.createTable({
            name: 'ledger',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'amount', type: 'integer', required: true },
            ],
        });
        await s.insert('tenant', { id: 'existing', name: 'Before', rent: 5 });
        await assert.rejects(
            () => s.runTransaction([
                { op: 'update', collection: 'tenant', filter: { eq: { id: 'existing' } }, patch: { rent: 99 } },
                { op: 'insert', collection: 'ledger', row: { id: 'bad', amount: null } },
                { op: 'insert', collection: 'tenant', row: { id: 'never', name: 'Never' } },
            ]),
            (error: Error & { failedOpIndex?: number }) => {
                assert.equal(error.failedOpIndex, 1);
                return true;
            },
        );
        assert.equal((await s.getByKey('tenant', 'existing'))?.rent, 5);
        assert.equal(await s.getByKey('tenant', 'never'), null);
        assert.equal(await s.count('ledger'), 0);
        s.close();
    } finally { t.cleanup(); }
});

test('runTransaction rejects 101 operations before writing anything', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        const operations = Array.from({ length: 101 }, (_, index) => ({
            op: 'insert' as const,
            collection: 'tenant',
            row: { id: `t-${index}`, name: `Tenant ${index}` },
        }));
        await assert.rejects(() => s.runTransaction(operations), /at most 100 operations/);
        assert.equal(await s.count('tenant'), 0);
        s.close();
    } finally { t.cleanup(); }
});

test('createTable refuses an injection-style identifier', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await assert.rejects(
            () => s.createTable({ name: 'tenant; DROP TABLE tenant--', columns: [{ name: 'id', type: 'string', primary: true }] }),
            /invalid identifier/i,
        );
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- insert + query ---------- */

test('insert + query round-trips every column type including JSON and boolean', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insert('tenant', {
            id: 't1', name: 'Alice', rent: 1200, active: true,
            moved_in: '2026-01-15T10:00:00Z', meta: { tags: ['vip', 'paid'] },
        });
        const got = await s.getByKey('tenant', 't1') as any;
        assert.equal(got.active, true, 'boolean round-trip');
        assert.deepEqual(got.meta, { tags: ['vip', 'paid'] }, 'JSON round-trip');
        assert.equal(got.rent, 1200);
        assert.equal(got.moved_in, '2026-01-15T10:00:00Z');
        s.close();
    } finally { t.cleanup(); }
});

test('insertBatch is transactional and atomic', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insertBatch('tenant', [
            { id: 'a', name: 'A', rent: 1000, active: true },
            { id: 'b', name: 'B', rent: 1500, active: false },
            { id: 'c', name: 'C', rent: 2000, active: true },
        ]);
        assert.equal(await s.count('tenant'), 3);
        s.close();
    } finally { t.cleanup(); }
});

test('insertBatch rolls back the whole batch on a constraint violation', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insert('tenant', { id: 'a', name: 'A' });
        await assert.rejects(
            () => s.insertBatch('tenant', [
                { id: 'b', name: 'B' },
                { id: 'a', name: 'duplicate' }, // collides with existing 'a'
            ]),
        );
        // Verify atomicity: neither 'b' nor the duplicate landed.
        assert.equal(await s.count('tenant'), 1);
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- filter operators ---------- */

test('query supports eq, contains, startsWith, gt, gte, lt, lte, in', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insertBatch('tenant', [
            { id: '1', name: 'Alice', rent: 1000, active: true },
            { id: '2', name: 'Bob', rent: 1500, active: false },
            { id: '3', name: 'Charlie', rent: 2000, active: true },
            { id: '4', name: 'Annie', rent: 800, active: true },
        ]);

        const eq = await s.query('tenant', { eq: { name: 'Bob' } });
        assert.equal(eq.length, 1);

        const contains = await s.query('tenant', { contains: { name: 'li' } });
        assert.equal(contains.length, 2); // Alice, Charlie

        const starts = await s.query('tenant', { startsWith: { name: 'A' } });
        assert.equal(starts.length, 2); // Alice, Annie

        const gt = await s.query('tenant', { gt: { rent: 1000 } });
        assert.equal(gt.length, 2); // Bob, Charlie

        const between = await s.query('tenant', { gte: { rent: 1000 }, lte: { rent: 1500 } });
        assert.equal(between.length, 2); // Alice, Bob

        const inOp = await s.query('tenant', { in: { name: ['Alice', 'Charlie'] } });
        assert.equal(inOp.length, 2);

        const emptyIn = await s.query('tenant', { in: { name: [] } });
        assert.equal(emptyIn.length, 0, 'IN with empty list matches nothing');

        const ordered = await s.query('tenant', undefined, { orderBy: 'rent', orderDir: 'desc', limit: 2 });
        assert.deepEqual(ordered.map((r: any) => r.id), ['3', '2']);
        s.close();
    } finally { t.cleanup(); }
});

test('contains escapes LIKE wildcards from the user', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insertBatch('tenant', [
            { id: '1', name: '100% effort' },
            { id: '2', name: '50 percent effort' },
        ]);
        // Literal '%' in the search string must NOT act as a wildcard.
        const matches = await s.query('tenant', { contains: { name: '100%' } });
        assert.equal(matches.length, 1);
        assert.equal((matches[0] as any).id, '1');
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- update / delete / count / truncate ---------- */

test('update returns the change count and respects the filter', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insertBatch('tenant', [
            { id: '1', name: 'A', rent: 1000, active: true },
            { id: '2', name: 'B', rent: 1500, active: true },
        ]);
        const n = await s.update('tenant', { gte: { rent: 1500 } }, { active: false });
        assert.equal(n, 1);
        const updated = await s.getByKey('tenant', '2') as any;
        assert.equal(updated.active, false);
        s.close();
    } finally { t.cleanup(); }
});

test('delete with empty filter is refused (use truncate)', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insert('tenant', { id: '1', name: 'A' });
        await assert.rejects(
            () => s.delete('tenant', {}),
            /refusing to delete all rows.*truncate/i,
        );
        s.close();
    } finally { t.cleanup(); }
});

// re-audit 2026-06-25 — symmetric with delete: empty-filter update is refused.
test('update with empty filter is refused (no mass-patch)', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insert('tenant', { id: '1', name: 'A' });
        await assert.rejects(
            () => s.update('tenant', {}, { name: 'patched' }),
            /refusing to update all rows.*empty\/all filter/i,
        );
        // The row is untouched.
        assert.equal((await s.getByKey('tenant', '1') as { name: string }).name, 'A');
        s.close();
    } finally { t.cleanup(); }
});

test('truncate removes all rows and returns the deleted count', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insertBatch('tenant', [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }]);
        const n = await s.truncate('tenant');
        assert.equal(n, 3);
        assert.equal(await s.count('tenant'), 0);
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- join ---------- */

test('inner join returns prefixed column names', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.createTable({
            name: 'lease',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'tenant_id', type: 'string', indexed: true },
                { name: 'rent', type: 'integer' },
            ],
        });
        await s.insertBatch('tenant', [
            { id: 't1', name: 'Alice' },
            { id: 't2', name: 'Bob' },
        ]);
        await s.insertBatch('lease', [
            { id: 'L1', tenant_id: 't1', rent: 1000 },
            { id: 'L2', tenant_id: 't1', rent: 1100 },
            { id: 'L3', tenant_id: 't2', rent: 1500 },
        ]);
        const rows = await s.join!('tenant', { table: 'lease', on: { left: 'id', right: 'tenant_id' } }) as any[];
        assert.equal(rows.length, 3);
        // Prefixed-column convention.
        assert.ok('tenant.name' in rows[0], 'left columns prefixed');
        assert.ok('lease.rent' in rows[0], 'right columns prefixed');
        s.close();
    } finally { t.cleanup(); }
});

test('nested or/and/not filter matches the equivalent handwritten WHERE', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(TENANT);
        await s.insertBatch('tenant', [
            { id: 'a', name: 'Ann', rent: 100, active: true },
            { id: 'b', name: 'Bob', rent: 200, active: false },
            { id: 'c', name: 'Cal', rent: 300, active: true },
            { id: 'd', name: 'Dee', rent: 400, active: false },
            { id: 'e', name: 'Eve', rent: 500, active: true },
            { id: 'f', name: 'Fay', rent: 600, active: false },
        ]);
        const found = await s.query('tenant', {
            or: [
                { and: [{ eq: { active: true } }, { gte: { rent: 300 } }] },
                { not: { lt: { rent: 600 } } },
            ],
        });
        const ids = found.map(r => r.id).sort();
        assert.deepEqual(ids, ['c', 'e', 'f']);
        await assert.rejects(
            () => s.query('tenant', { eq: { 'id); DROP TABLE': 'x' } }),
            /invalid identifier/i,
        );
        await assert.rejects(
            () => s.query('tenant', { or: [{ eq: { 'id); DROP': 'x' } }] }),
            /invalid identifier/i,
        );
        s.close();
    } finally { t.cleanup(); }
});

test('joinMany supports inner and left hops and rejects a fifth hop', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'customers',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'address_id', type: 'string' },
            ],
        });
        await s.createTable({
            name: 'addresses',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'city', type: 'string' },
            ],
        });
        await s.createTable({
            name: 'orders',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'customer_id', type: 'string' },
                { name: 'amount', type: 'integer' },
            ],
        });
        await s.insert('addresses', { id: 'ad1', city: 'Austin' });
        await s.insert('customers', { id: 'c1', address_id: 'ad1' });
        await s.insert('customers', { id: 'c2', address_id: 'missing' });
        await s.insert('orders', { id: 'o1', customer_id: 'c1', amount: 10 });
        await s.insert('orders', { id: 'o2', customer_id: 'c2', amount: 20 });
        const inner = await s.joinMany!({
            from: 'orders',
            join: [
                { collection: 'customers', on: { from: 'customer_id', to: 'id' }, type: 'inner' },
                { collection: 'addresses', on: { from: 'address_id', to: 'id' }, type: 'inner' },
            ],
        });
        assert.equal(inner.length, 1);
        assert.equal(inner[0]!['orders.id'], 'o1');
        assert.equal(inner[0]!['addresses.city'], 'Austin');
        const left = await s.joinMany!({
            from: 'orders',
            join: [
                { collection: 'customers', on: { from: 'customer_id', to: 'id' }, type: 'left' },
                { collection: 'addresses', on: { from: 'address_id', to: 'id' }, type: 'left' },
            ],
        });
        assert.equal(left.length, 2);
        await assert.rejects(
            () => s.joinMany!({
                from: 'orders',
                join: [
                    { collection: 'customers', on: { from: 'customer_id', to: 'id' }, type: 'inner' },
                    { collection: 'addresses', on: { from: 'address_id', to: 'id' }, type: 'inner' },
                    { collection: 'customers', on: { from: 'id', to: 'id' }, type: 'inner' },
                    { collection: 'addresses', on: { from: 'id', to: 'id' }, type: 'inner' },
                    { collection: 'customers', on: { from: 'id', to: 'id' }, type: 'inner' },
                ],
            }),
            /at most 4 hops/i,
        );
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- schema-cache persistence ---------- */

test('schema cache survives a fresh storage instance pointed at the same files', async () => {
    const t = mkTmp();
    try {
        const s1 = new SqliteTableStorage(t.dbPath, t.cachePath);
        await s1.createTable(TENANT);
        await s1.insert('tenant', { id: 't1', name: 'Alice', rent: 999 });
        s1.close();

        // Fresh instance: cache file must let it locate the schema
        // without re-declaration.
        const s2 = new SqliteTableStorage(t.dbPath, t.cachePath);
        const got = await s2.getByKey('tenant', 't1') as any;
        assert.equal(got.name, 'Alice');
        assert.equal(got.rent, 999);
        s2.close();
    } finally { t.cleanup(); }
});

test('corrupt schema cache file does not crash the constructor', async () => {
    const t = mkTmp();
    try {
        fs.writeFileSync(t.cachePath, '{not valid json');
        const s = new SqliteTableStorage(t.dbPath, t.cachePath);
        // Constructor doesn't load eagerly; first call triggers parse.
        // Should fall back to an empty in-memory map silently.
        await s.createTable(TENANT);
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- error paths ---------- */

/* ---------- Architecture gap #11 — additive schema evolution ---------- */

test('evolveSchema adds a new column (ALTER TABLE ADD COLUMN)', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'tenant',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'name', type: 'string' },
            ],
        });
        await s.insert('tenant', { id: '1', name: 'A' });

        const steps = await s.evolveSchema!('tenant', {
            name: 'tenant',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'name', type: 'string' },
                { name: 'rent', type: 'integer', indexed: true },
            ],
        });
        assert.ok(steps.some(s => s.kind === 'add_column' && s.column === 'rent'));
        assert.ok(steps.some(s => s.kind === 'add_index' && s.column === 'rent'));

        // Existing row is still queryable + new column writable.
        await s.insert('tenant', { id: '2', name: 'B', rent: 1000 });
        const got = await s.getByKey('tenant', '2') as any;
        assert.equal(got.rent, 1000);
        s.close();
    } finally { t.cleanup(); }
});

test('evolveSchema adds an index to a previously-unindexed column', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 't',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'email', type: 'string' },
            ],
        });
        const steps = await s.evolveSchema!('t', {
            name: 't',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'email', type: 'string', indexed: true },
            ],
        });
        assert.deepEqual(steps, [{ kind: 'add_index', column: 'email' }]);
        s.close();
    } finally { t.cleanup(); }
});

test('evolveSchema adds extractedFields to an existing json column', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'e',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'meta', type: 'json' },
            ],
        });
        const steps = await s.evolveSchema!('e', {
            name: 'e',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'meta', type: 'json', extractedFields: [{ key: 'tag', type: 'string', indexed: true }] },
            ],
        });
        assert.ok(steps.some(s => s.kind === 'add_extracted_field' && s.extractedKey === 'tag'));
        // New writes populate the sidecar.
        await s.insert('e', { id: '1', meta: { tag: 'auth' } });
        const matches = await s.query('e', { eq: { 'meta__tag': 'auth' } });
        assert.equal(matches.length, 1);
        s.close();
    } finally { t.cleanup(); }
});

test('evolveSchema refuses destructive changes (drop column → orchestrator)', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'd',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'doomed', type: 'string' },
            ],
        });
        await assert.rejects(
            () => s.evolveSchema!('d', {
                name: 'd',
                columns: [{ name: 'id', type: 'string', primary: true }],
            }),
            /column 'doomed' was removed.*Phase 4/i,
        );
        s.close();
    } finally { t.cleanup(); }
});

test('evolveSchema refuses adding a UNIQUE column (SQLite forbids it)', async () => {
    // RA2-reaudit2 — SQLite rejects ALTER TABLE ADD COLUMN ... UNIQUE; fail up
    // front with a clear message instead of emitting DDL the engine rejects.
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'u',
            columns: [{ name: 'id', type: 'string', primary: true }],
        });
        await assert.rejects(
            () => s.evolveSchema!('u', {
                name: 'u',
                columns: [
                    { name: 'id', type: 'string', primary: true },
                    { name: 'email', type: 'string', unique: true },
                ],
            }),
            /UNIQUE column.*SQLite forbids|CREATE UNIQUE INDEX/i,
        );
        s.close();
    } finally { t.cleanup(); }
});

test('evolveSchema refuses type changes (→ orchestrator)', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'tc',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'age', type: 'string' },
            ],
        });
        await assert.rejects(
            () => s.evolveSchema!('tc', {
                name: 'tc',
                columns: [
                    { name: 'id', type: 'string', primary: true },
                    { name: 'age', type: 'integer' },
                ],
            }),
            /type change.*Phase 4/i,
        );
        s.close();
    } finally { t.cleanup(); }
});

test('evolveSchema refuses adding a new primary-key column', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'p',
            columns: [{ name: 'id', type: 'string', primary: true }],
        });
        await assert.rejects(
            () => s.evolveSchema!('p', {
                name: 'p',
                columns: [
                    { name: 'id', type: 'string', primary: true },
                    { name: 'id2', type: 'string', primary: true },
                ],
            }),
            /primary-key/i,
        );
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- Architecture gap #8 — capability flags ---------- */

test('capabilities() reports SQLite\'s actual feature set', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        const caps = s.capabilities();
        assert.equal(caps.join, true, 'SQLite supports JOIN');
        assert.equal(caps.maxJoinHops, 4);
        assert.equal(caps.caseSensitiveContains, false, 'LIKE is case-insensitive by default');
        assert.equal(caps.extractedJsonFields, true);
        assert.equal(caps.additiveSchemaEvolution, true);
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- Architecture gap #6 — indexed JSON columns ---------- */

test('extractedFields auto-creates sidecar columns and queries hit them', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'event',
            columns: [
                { name: 'id', type: 'string', primary: true },
                {
                    name: 'meta', type: 'json',
                    extractedFields: [
                        { key: 'tag', type: 'string', indexed: true },
                        { key: 'priority', type: 'integer' },
                    ],
                },
            ],
        });
        await s.insertBatch('event', [
            { id: 'e1', meta: { tag: 'auth', priority: 1 } },
            { id: 'e2', meta: { tag: 'auth', priority: 5 } },
            { id: 'e3', meta: { tag: 'billing', priority: 3 } },
            { id: 'e4', meta: { other: 'no tag' } },
        ]);
        // Query against the sidecar column name <json>__<key>
        const authRows = await s.query('event', { eq: { 'meta__tag': 'auth' } });
        assert.equal(authRows.length, 2);
        const highPriority = await s.query('event', { gte: { 'meta__priority': 3 } });
        assert.equal(highPriority.length, 2);
        // decodeRow only returns declared columns; sidecars are
        // present in storage but hidden from the result shape.
        assert.ok('meta' in authRows[0]);
        assert.ok(!('meta__tag' in authRows[0]), 'sidecars hidden from query result');
    } finally { t.cleanup(); }
});

test('extractedFields handles JSON-string and missing inner field gracefully', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'e',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'meta', type: 'json', extractedFields: [{ key: 'k', type: 'string' }] },
            ],
        });
        // JSON passed as string
        await s.insert('e', { id: '1', meta: '{"k":"x"}' });
        // Missing inner field → sidecar is null
        await s.insert('e', { id: '2', meta: { other: 'y' } });
        // Null meta → sidecar is null
        await s.insert('e', { id: '3', meta: null });
        const matches = await s.query('e', { eq: { 'meta__k': 'x' } });
        assert.equal(matches.length, 1);
        assert.equal((matches[0] as any).id, '1');
    } finally { t.cleanup(); }
});

test('extractedFields stay in sync on update', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({
            name: 'e',
            columns: [
                { name: 'id', type: 'string', primary: true },
                { name: 'meta', type: 'json', extractedFields: [{ key: 'tag', type: 'string', indexed: true }] },
            ],
        });
        await s.insert('e', { id: '1', meta: { tag: 'old' } });
        await s.update('e', { eq: { id: '1' } }, { meta: { tag: 'new' } });
        const found = await s.query('e', { eq: { 'meta__tag': 'new' } });
        assert.equal(found.length, 1);
        const stale = await s.query('e', { eq: { 'meta__tag': 'old' } });
        assert.equal(stale.length, 0, 'old sidecar value is no longer queryable');
    } finally { t.cleanup(); }
});

test('unknown-table operations throw a clear error', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await assert.rejects(() => s.query('nonexistent'), /unknown table 'nonexistent'/i);
        await assert.rejects(() => s.insert('nonexistent', { x: 1 }), /unknown table 'nonexistent'/i);
        s.close();
    } finally { t.cleanup(); }
});

/* ---------- R4 #8 — evolveSchema type-aware backfill default ---------- */
// Adding a REQUIRED non-string column used 'NOT NULL DEFAULT ''' for ALL types,
// putting a text empty-string into an INTEGER/REAL/boolean column. Backfilled
// rows must carry a type-correct default (0 for numeric), not ''.
test('R4#8 evolveSchema adds a required INTEGER column with DEFAULT 0 (not text)', async () => {
    const t = mkTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable({ name: 'tenant', columns: [
            { name: 'id', type: 'string', primary: true },
            { name: 'name', type: 'string', required: true, indexed: true },
        ] });
        await s.insert('tenant', { id: 't1', name: 'Alice' });
        // add a REQUIRED integer column → existing row backfilled
        await s.evolveSchema('tenant', { name: 'tenant', columns: [
            { name: 'id', type: 'string', primary: true },
            { name: 'name', type: 'string', required: true, indexed: true },
            { name: 'score', type: 'integer', required: true },
            { name: 'ratio', type: 'float', required: true },
        ] });
        const row = await s.getByKey('tenant', 't1') as { score?: unknown; ratio?: unknown } | null;
        assert.ok(row, 'backfilled row exists');
        assert.equal(typeof row!.score, 'number', `integer backfill must be numeric, got ${typeof row!.score} (${JSON.stringify(row!.score)})`);
        assert.equal(row!.score, 0, 'integer default is 0');
        assert.equal(typeof row!.ratio, 'number', 'float backfill must be numeric');
        assert.equal(row!.ratio, 0, 'float default is 0');
    } finally { t.cleanup(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

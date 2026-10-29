#!/usr/bin/env tsx
/**
 * test/sqlite-partition-key-unit.ts - Phase 0 lane L3 on the SQLite engine: `nodes.partition_key`.
 *
 *   write/read    upsertNode / insertNodeIfAbsent / upsertNodeAtRevision / bulkUpsertNodes / importRaw / commitNodeBatch
 *                 store the key; getNode / getNodesByIds / listNodes / bulkList (export) report it
 *   unkeyed       a node with no key has NO `partitionKey` property on any read (output shape unchanged)
 *   immutability  '' -> 'x' allowed; same / omitted key fine; 'x' -> 'y' and 'x' -> '' refused with PARTITION_KEY_IMMUTABLE
 *                 on every path; the in-SQL guard refuses a second connection that keyed the row first
 *   migration     an existing file without the column gains it on open (existing rows read as unkeyed); idempotent
 *   backup        backupTo() copies the key
 *
 * Run: npx tsx test/sqlite-partition-key-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { sqliteGraphDataPath } from '../packages/lore/src/engines/sqlite/sqliteGraphSchema.js';
import { isPartitionKeyImmutable } from '../packages/lore/src/engines/graphShared/partitionKey.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const node = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}', ...over }) as never;
const refused = async (fn: () => Promise<unknown>, label: string): Promise<void> => {
    let err: unknown;
    try { await fn(); } catch (e) { err = e; }
    assert.ok(isPartitionKeyImmutable(err), `${label}: expected PARTITION_KEY_IMMUTABLE, got ${err instanceof Error ? err.message : String(err)}`);
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-p0l3-sqlite-'));
const raw = (dir: string, sql: string, ...p: unknown[]): unknown[] => {
    const db = new Database(sqliteGraphDataPath(dir));
    try {
        const st = db.prepare(sql);
        return st.reader ? st.all(...p) : (st.run(...p), []);
    } finally { db.close(); }
};

const dir = path.join(root, 'a');
const g = new SqliteGraph(dir, { workspaceId: 'a' });
await g.initialize();

console.log('write / read');
await test('upsertNode stores the key; every read reports it', async () => {
    const w = await g.upsertNode(node('k1', { partitionKey: 'tenant-a' }));
    assert.equal(w.partitionKey, 'tenant-a');
    assert.equal((await g.getNode('k1'))?.partitionKey, 'tenant-a');
    assert.equal((await g.getNodesByIds(['k1'])).get('k1')?.partitionKey, 'tenant-a');
    assert.equal((await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true })).find((n) => n.id === 'k1')?.partitionKey, 'tenant-a');
    const page = await g.bulkList({ limit: 100 });
    assert.equal(page.nodes.find((n) => n['id'] === 'k1')?.['partitionKey'], 'tenant-a', 'export (bulkList) carries the key');
});
await test("an unkeyed node has NO partitionKey property on any read; stored column is ''", async () => {
    const w = await g.upsertNode(node('u1'));
    assert.ok(!('partitionKey' in w));
    assert.ok(!('partitionKey' in ((await g.getNode('u1')) as object)));
    assert.ok(!('partitionKey' in ((await g.getNodesByIds(['u1'])).get('u1') as object)));
    assert.ok(!('partitionKey' in (await g.bulkList({ limit: 100 })).nodes.find((n) => n['id'] === 'u1')!));
    assert.deepEqual(raw(dir, 'SELECT partition_key FROM nodes WHERE id = ?', 'u1'), [{ partition_key: '' }]);
});
await test('insertNodeIfAbsent / upsertNodeAtRevision / bulkUpsertNodes / importRaw / commitNodeBatch store the key', async () => {
    assert.equal((await g.insertNodeIfAbsent(node('i1', { partitionKey: 'tb' }))).partitionKey, 'tb');
    await g.upsertNodeAtRevision(node('r1', { partitionKey: 'tb' }), 0, '2026-02-01T00:00:00.000Z');
    const bulk = await g.bulkUpsertNodes([node('b1', { partitionKey: 'tc' }), node('b2')]);
    assert.ok(bulk.every((b) => b.ok));
    const now = '2026-03-01T00:00:00.000Z';
    await g.importRaw([{ ...(node('imp1', { partitionKey: 'td' }) as object), createdAt: now, updatedAt: now, syncedAt: now } as never], []);
    const out = await g.commitNodeBatch([], [{ kind: 'insert', node: node('cb1', { partitionKey: 'te' }), updatedAt: now }] as never);
    assert.equal(out.ok, true, JSON.stringify(out));
    const keys = Object.fromEntries((raw(dir, 'SELECT id, partition_key FROM nodes') as Array<{ id: string; partition_key: string }>).map((r) => [r.id, r.partition_key]));
    assert.deepEqual([keys['i1'], keys['r1'], keys['b1'], keys['b2'], keys['imp1'], keys['cb1']], ['tb', 'tb', 'tc', '', 'td', 'te']);
});

console.log('immutability');
await test("'' -> 'x' allowed; same key and omitted key keep it", async () => {
    await g.upsertNode(node('m1'));
    await g.upsertNode(node('m1', { partitionKey: 'x' }));
    await g.upsertNode(node('m1', { partitionKey: 'x', label: 'again' }));
    await g.upsertNode(node('m1', { label: 'no key given' }));
    assert.equal((await g.getNode('m1'))?.partitionKey, 'x');
});
await test("'x' -> 'y' and 'x' -> '' are refused on every write path; the row is unchanged", async () => {
    await refused(() => g.upsertNode(node('m1', { partitionKey: 'y' })), 'upsertNode x->y');
    await refused(() => g.upsertNode(node('m1', { partitionKey: '' })), 'upsertNode x->empty');
    const rev = (await g.getNode('m1'))!.revision!;
    await refused(() => g.upsertNodeAtRevision(node('m1', { partitionKey: 'y' }), rev, '2026-04-01T00:00:00.000Z'), 'upsertNodeAtRevision');
    const bulk = await g.bulkUpsertNodes([node('m1', { partitionKey: 'y' })]);
    assert.equal(bulk[0]?.ok, false);
    assert.match(String(bulk[0]?.error), /PARTITION_KEY_IMMUTABLE/);
    await refused(() => g.commitNodeBatch([], [{ kind: 'cas', node: node('m1', { partitionKey: 'y' }), expectedRevision: rev, mustExist: true, updatedAt: '2026-04-01T00:00:00.000Z' }] as never), 'commitNodeBatch');
    assert.equal((await g.getNode('m1'))?.partitionKey, 'x');
    assert.equal((await g.getNode('m1'))?.label, 'no key given');
});
await test('the in-SQL guard refuses a second connection that keyed the row after the read', async () => {
    await g.upsertNode(node('race1'));
    const g2 = new SqliteGraph(dir, { workspaceId: 'a' });
    await g2.initialize();
    raw(dir, "UPDATE nodes SET partition_key = 'first' WHERE id = 'race1'");
    // g has no cache of the keyless row that could short-circuit the JS check (cache disabled below); force the SQL path.
    await refused(() => g2.upsertNode(node('race1', { partitionKey: 'second' })), 'racing writer');
    assert.deepEqual(raw(dir, "SELECT partition_key FROM nodes WHERE id = 'race1'"), [{ partition_key: 'first' }]);
    await g2.close();
});

console.log('migration / backup');
await test('an existing file without the column gains it on open; rows read as unkeyed; reopening is a no-op', async () => {
    const d2 = path.join(root, 'old');
    const first = new SqliteGraph(d2, { workspaceId: 'old' });
    await first.initialize();
    await first.upsertNode(node('legacy'));
    await first.close();
    const db = new Database(sqliteGraphDataPath(d2));
    db.exec('ALTER TABLE nodes DROP COLUMN partition_key');
    db.close();
    for (let i = 0; i < 2; i++) {
        const again = new SqliteGraph(d2, { workspaceId: 'old' });
        await again.initialize();
        const n = await again.getNode('legacy');
        assert.ok(n);
        if (i === 0) {
            assert.ok(!('partitionKey' in n), 'legacy row reads as unkeyed');
            await again.upsertNode(node('legacy', { partitionKey: 'now-keyed' }));
        } else {
            assert.equal(n.partitionKey, 'now-keyed', 'second open is a no-op and keeps the data');
        }
        await again.close();
    }
});
await test('backupTo() preserves the key', async () => {
    const dest = path.join(root, 'backup.sqlite');
    await g.backupTo(dest);
    const db = new Database(dest, { readonly: true });
    try {
        assert.deepEqual(db.prepare("SELECT partition_key FROM nodes WHERE id = 'k1'").all(), [{ partition_key: 'tenant-a' }]);
    } finally { db.close(); }
});

await g.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

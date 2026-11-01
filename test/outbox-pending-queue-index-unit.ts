#!/usr/bin/env tsx
/**
 * outbox/pendingQueueIndex.ts — 3.38.3: the replicator's "next batch" read must not walk replicated rows.
 *
 * `listPendingForWorkspace` (status IN ('pending', 'failed'), ordered by sequenceId) was served by
 * `idx_outbox_workspace_seq`, so each batch stepped over every replicated row still kept for
 * pruning: ~40 ms per batch with 79k replicated rows in the 3.38.2 filter check, linear in history.
 * 3.38.3 adds the partial index `idx_outbox_pending_ws_seq`. This file pins:
 *
 *   1. the index exists as soon as the store opens;
 *   2. EXPLAIN QUERY PLAN of the real batch SQL names the new index (fails if the query's status
 *      term and the index's WHERE text drift apart);
 *   3. the index text and the query text share PENDING_STATUS_TERM;
 *   4. an outbox file from before 3.38.3 gets the index on its next open;
 *   5. batches are identical with and without the index, including the SP-21 retry-time rule
 *      (a 'failed' row whose nextAttemptAt is in the future is skipped) and per-workspace isolation;
 *   6. a failed CREATE INDEX only warns and returns false; it never throws.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    ensurePendingQueueIndex, LIST_PENDING_FOR_WORKSPACE_SQL, PENDING_QUEUE_INDEX_SQL, PENDING_STATUS_TERM,
} from '../packages/lore/src/outbox/pendingQueueIndex.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const dirs: string[] = [];
function mkDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-pending-queue-index-'));
    dirs.push(dir);
    return dir;
}

type Stmt = { all(...p: unknown[]): Array<Record<string, unknown>>; run(...p: unknown[]): unknown };
type RawDb = { exec(sql: string): void; prepare(sql: string): Stmt };
const rawDb = (s: SqliteOutboxStore): RawDb => (s as unknown as { db: RawDb }).db;
const open = (dir: string) => new SqliteOutboxStore(dir, { retryBaseMs: 20 });
const INDEX = 'idx_outbox_pending_ws_seq';
const hasIndex = (db: RawDb): boolean =>
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${INDEX}'`).all().length === 1;

/** Mostly-replicated history plus a few pending, failed-due, failed-later and dead rows, in two workspaces. */
async function seed(store: SqliteOutboxStore): Promise<void> {
    const db = rawDb(store);
    for (let i = 0; i < 600; i++) {
        const ws = i % 5 === 0 ? 'w2' : 'w1';
        const e = await recordHotWrite(store, { workspace: ws, operationKind: 'node.upsert', operation: 'graph.upsert', payload: { id: `n-${i}`, type: 'note', label: `n${i}` } });
        const r = i % 50;
        if (r === 7) continue; // pending
        if (r === 11) { await store.markEntryStatus!(e.id, 'failed', { error: 'injected' }); db.prepare(`UPDATE outbox_entries SET nextAttemptAt = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), e.id); continue; }
        if (r === 13) { await store.markEntryStatus!(e.id, 'failed', { error: 'injected' }); db.prepare(`UPDATE outbox_entries SET nextAttemptAt = ? WHERE id = ?`).run(new Date(Date.now() + 3_600_000).toISOString(), e.id); continue; }
        if (r === 17) { await store.markEntryStatus!(e.id, 'dead', { error: 'injected' }); continue; }
        await store.markEntryStatus!(e.id, 'replicated');
    }
}
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

console.log('\noutbox — pending-queue index (3.38.3)\n');

await test('the pending-queue index exists as soon as the store opens', () => {
    const store = open(mkDir());
    assert.ok(hasIndex(rawDb(store)));
    store.close();
});

await test('the real batch SQL is planned on the pending-queue index', async () => {
    const store = open(mkDir());
    await seed(store);
    rawDb(store).exec('ANALYZE');
    const plan = rawDb(store).prepare(`EXPLAIN QUERY PLAN ${LIST_PENDING_FOR_WORKSPACE_SQL}`).all('w1', 100)
        .map((r) => String(r['detail'])).join(' | ');
    assert.match(plan, new RegExp(INDEX), `batch read must use ${INDEX}: ${plan}`);
    assert.doesNotMatch(plan, /TEMP B-TREE/, `no sort step needed: ${plan}`);
    store.close();
});

await test('the index text and the batch query share the same status term', () => {
    assert.ok(PENDING_QUEUE_INDEX_SQL.endsWith(`WHERE ${PENDING_STATUS_TERM}`));
    assert.ok(LIST_PENDING_FOR_WORKSPACE_SQL.includes(PENDING_STATUS_TERM));
});

await test('an outbox file from before 3.38.3 gets the index on its next open, rows intact', async () => {
    const dir = mkDir();
    const first = open(dir);
    await seed(first);
    const before = ids(await first.listPendingForWorkspace('w1', 1000));
    rawDb(first).exec(`DROP INDEX ${INDEX}`); // what a 3.38.2 file looks like
    first.close();
    const second = open(dir);
    assert.ok(hasIndex(rawDb(second)));
    assert.deepEqual(ids(await second.listPendingForWorkspace('w1', 1000)), before);
    second.close();
});

await test('batches are identical with and without the index (retry-time rule, workspace isolation, limit)', async () => {
    const store = open(mkDir());
    await seed(store);
    const ask = async () => ({
        w1: await store.listPendingForWorkspace('w1', 1000),
        w2: ids(await store.listPendingForWorkspace('w2', 1000)),
        small: ids(await store.listPendingForWorkspace('w1', 3)),
    });
    const withIdx = await ask();
    rawDb(store).exec(`DROP INDEX ${INDEX}`);
    const without = await ask();
    assert.deepEqual(ids(withIdx.w1), ids(without.w1));
    assert.deepEqual(withIdx.w2, without.w2);
    assert.deepEqual(withIdx.small, without.small);
    // shape: 600 rows, i%50 in {7, 11} are due; w1 holds 4 of every 5. 13 (future retry) and 17 (dead) are skipped.
    const statuses = new Set(withIdx.w1.map((e) => e.status));
    assert.deepEqual([...statuses].sort(), ['failed', 'pending']);
    assert.equal(withIdx.w1.length + withIdx.w2.length, 24, 'only due rows: 12 pending + 12 failed-due');
    assert.ok(withIdx.w1.every((e, i, a) => i === 0 || a[i - 1]!.sequenceId! < e.sequenceId!), 'sequenceId order');
    assert.equal(withIdx.small.length, 3);
    store.close();
});

await test('a failed CREATE INDEX warns and returns false; it never throws', () => {
    const broken = { exec(): never { throw new Error('database is locked'); } };
    assert.equal(ensurePendingQueueIndex(broken), false);
    assert.equal(ensurePendingQueueIndex({ exec() { /* ok */ } }), true);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

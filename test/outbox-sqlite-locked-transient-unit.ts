#!/usr/bin/env tsx
/**
 * outbox-sqlite-locked-transient-unit.ts - 3.35.3 (SQLITE-STALL fix item 2): through the REAL
 * `wireOutbox()` production wiring, a SQLite lock error on verbatim replay is TRANSIENT.
 *
 * Before this fix only the arcade wiring supplied a `transientClassifier`, so on SQLite every
 * SQLITE_BUSY ("database is locked") burned an attempt and the row went `dead (permanent)` at
 * maxAttempts: 4,142 embed rows were silently discarded in the 2026-10-19 stall while a promotion
 * held verbatim.sqlite's write gate.
 *
 * Nothing here builds an OutboxReplicator by hand: `wireOutbox({ loreDir, getVerbatim })` returns the
 * production replicator over a real SqliteOutboxStore, and a real SqliteVerbatimStore is the substrate.
 *   - REAL contention: a second connection holds BEGIN EXCLUSIVE on verbatim.sqlite; the replay fails
 *     with a genuine better-sqlite3 SQLITE_BUSY; the row stays `failed` with attempts unchanged and is
 *     never dead (well past the default maxAttempts of 5); when the lock is released the SAME row
 *     replicates and the text is in the store.
 *   - permanent errors (UNIQUE constraint, plain errors) still dead-letter at maxAttempts as 'permanent'
 *     through the same wiring.
 *
 * Run: npx tsx test/outbox-sqlite-locked-transient-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { SqliteVerbatimStore } from './helpers/testVerbatimStore.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

const DIM = 8;
class DetEmbedder implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'locked-transient-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private v(t: string): number[] { const a = new Array(DIM).fill(0.01); for (let i = 0; i < t.length; i++) a[i % DIM] += t.charCodeAt(i) / 128; return a; }
    async embed(t: string) { return this.v(t); }
    async embedQuery(t: string) { return this.v(t); }
    async embedDocument(t: string) { return this.v(t); }
    async embedDocumentBatch(ts: string[]) { return ts.map((t) => this.v(t)); }
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

type Db = { prepare(s: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } };
interface RowView { status: string; attempts: number; transientRetries: number; deadReason: string | null; lastError: string | null }
const dbOf = (s: object): Db => (s as unknown as { db: Db }).db;
const view = (s: object, id: string): RowView =>
    dbOf(s).prepare('SELECT status, attempts, transientRetries, deadReason, lastError FROM outbox_entries WHERE id = ?').get(id) as RowView;
const releaseBackoff = (s: object): void => { dbOf(s).prepare(`UPDATE outbox_entries SET nextAttemptAt = '2000-01-01T00:00:00.000Z' WHERE status = 'failed'`).run(); };

const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

interface Rig {
    ws: string;
    real: SqliteVerbatimStore;
    wiring: ReturnType<typeof wireOutbox>;
    failWith: { next: (() => Error) | null };
}
async function rig(): Promise<Rig> {
    const ws = mkTmp('lore-locked-ws-');
    const real = new SqliteVerbatimStore(ws, new DetEmbedder());
    await real.initialize();
    // The store keeps busy_timeout at 5000 ms; 20 ms keeps the REAL contention case quick while the
    // error stays a genuine better-sqlite3 SQLITE_BUSY.
    (real as unknown as { db: { pragma(s: string): unknown } }).db.pragma('busy_timeout = 20');
    const failWith: Rig['failWith'] = { next: null };
    // Delegating wrapper: injects a PERMANENT failure only when asked; otherwise every call reaches the real store.
    const proxy = new Proxy(real, {
        get(target, prop, receiver) {
            if ((prop === 'store' || prop === 'storeBatch') && failWith.next) {
                return async () => { throw failWith.next!(); };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
        },
    }) as unknown as VerbatimStoreApi;
    const wiring = wireOutbox({
        loreDir: mkTmp('lore-locked-outbox-'),
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getVerbatim: () => proxy,
    });
    return { ws, real, wiring, failWith };
}
const enqueue = (r: Rig, id: string, text: string) => recordHotWrite(r.wiring.store, {
    workspace: 'w', operationKind: 'verbatim.upsert', operation: 'verbatim.upsert',
    payload: { id, text, metadata: { updatedAt: '2026-10-24T00:00:00.000Z' } },
});

console.log('wireOutbox: SQLite lock errors on verbatim replay');

await test('REAL SQLITE_BUSY: row stays failed, attempts unchanged, never dead past maxAttempts; replicates once the lock clears', async () => {
    const r = await rig();
    const holder = new Database(path.join(r.ws, '.lore', 'verbatim.sqlite'));
    holder.pragma('busy_timeout = 20');
    const row = await enqueue(r, 'lore:w:locked-1', 'text written while promotion held the gate');
    try {
        holder.exec('BEGIN EXCLUSIVE'); // what the 2026-10-19 promotion held across its awaits
        for (let i = 0; i < 8; i++) { // default maxAttempts is 5: 8 ticks would have dead-lettered it before the fix
            await r.wiring.replicator.tickOnce();
            const v = view(r.wiring.store, row.id);
            assert.equal(v.status, 'failed', `tick ${i + 1}: ${v.lastError}`);
            assert.equal(v.attempts, 0, `tick ${i + 1}: a lock error must not burn an attempt`);
            assert.equal(v.deadReason, null);
            releaseBackoff(r.wiring.store);
        }
        const mid = view(r.wiring.store, row.id);
        assert.equal(mid.transientRetries, 8);
        assert.match(mid.lastError ?? '', /database is locked|SQLITE_BUSY/i);
        assert.equal(r.wiring.replicator.getStats().dead, 0);
        assert.equal(await r.real.getById('lore:w:locked-1'), null, 'nothing was written while locked');
    } finally {
        try { holder.exec('ROLLBACK'); } catch { /* not in a txn */ }
        holder.close();
    }
    await r.wiring.replicator.tickOnce();
    const done = view(r.wiring.store, row.id);
    assert.equal(done.status, 'replicated', `lock cleared -> same row replays; got ${done.status} ${done.lastError}`);
    assert.equal(done.attempts, 0);
    const got = await r.real.getById('lore:w:locked-1');
    assert.equal(got?.text, 'text written while promotion held the gate');
    await r.real.close();
});

await test('a SQLITE_LOCKED-coded error injected at the store is also transient, then succeeds', async () => {
    const r = await rig();
    const row = await enqueue(r, 'lore:w:locked-2', 'second');
    let n = 0;
    r.failWith.next = () => { n++; return Object.assign(new Error('database table is locked'), { code: 'SQLITE_LOCKED' }); };
    for (let i = 0; i < 6; i++) { await r.wiring.replicator.tickOnce(); releaseBackoff(r.wiring.store); }
    assert.ok(n >= 6, 'the replay really reached the (failing) store each tick');
    assert.equal(view(r.wiring.store, row.id).status, 'failed');
    assert.equal(view(r.wiring.store, row.id).attempts, 0);
    r.failWith.next = null;
    await r.wiring.replicator.tickOnce();
    assert.equal(view(r.wiring.store, row.id).status, 'replicated');
    assert.equal((await r.real.getById('lore:w:locked-2'))?.text, 'second');
    await r.real.close();
});

console.log('\nwireOutbox: genuine permanent errors still dead-letter');

await test('a UNIQUE-constraint error dead-letters as permanent after maxAttempts, attempts counted', async () => {
    const r = await rig();
    const row = await enqueue(r, 'lore:w:perm-1', 'will never apply');
    r.failWith.next = () => Object.assign(new Error('UNIQUE constraint failed: verbatim.id'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    for (let i = 0; i < 5; i++) { await r.wiring.replicator.tickOnce(); releaseBackoff(r.wiring.store); }
    const v = view(r.wiring.store, row.id);
    assert.equal(v.status, 'dead');
    assert.equal(v.deadReason, 'permanent');
    assert.equal(v.attempts, 5);
    assert.equal(v.transientRetries, 0);
    await r.real.close();
});

await test('a plain non-SQLite error also dead-letters as permanent', async () => {
    const r = await rig();
    const row = await enqueue(r, 'lore:w:perm-2', 'x');
    r.failWith.next = () => new Error('Cannot read properties of undefined (reading text)');
    for (let i = 0; i < 5; i++) { await r.wiring.replicator.tickOnce(); releaseBackoff(r.wiring.store); }
    const v = view(r.wiring.store, row.id);
    assert.equal(v.status, 'dead');
    assert.equal(v.deadReason, 'permanent');
    await r.real.close();
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

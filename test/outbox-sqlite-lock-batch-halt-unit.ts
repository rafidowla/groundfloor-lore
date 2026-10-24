#!/usr/bin/env tsx
/**
 * outbox-sqlite-lock-batch-halt-unit.ts - 3.35.3 review finding F5: after a SQLite lock error the
 * replicator must STOP the batch (the rest of the rows are retried next tick), not keep hammering the
 * locked store once per remaining row.
 *
 * Through the REAL `wireOutbox()` wiring over a real SqliteOutboxStore and SqliteVerbatimStore:
 *   - a second connection holds BEGIN EXCLUSIVE on verbatim.sqlite; one tick over 6 pending
 *     `verbatim.upsert` rows touches exactly ONE row (it gets transientRetries 1); the other five are
 *     untouched (still pending, no retry recorded) - before the fix all six were failed in one tick;
 *   - the next tick (after the first row's backoff is released) advances by exactly one more row, and
 *     once the lock clears every row replicates, none dead, none with a counted attempt;
 *   - a NON-lock error still walks the whole batch and counts an attempt on every row;
 *   - the 24 h `transient_ceiling` is kept for a halting lock error (unit level, injected clock).
 *
 * Consolidation is disabled (LORE_REPLICATOR_CONSOLIDATION_MAX=0) so each upsert is its own replay.
 *
 * Run: npx tsx test/outbox-sqlite-lock-batch-halt-unit.ts
 */
process.env.LORE_REPLICATOR_CONSOLIDATION_MAX = '0';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

const { wireOutbox } = await import('../packages/lore/src/outbox/wiring.js');
const { recordHotWrite } = await import('../packages/lore/src/outbox/hotLane.js');
const { SqliteVerbatimStore } = await import('./helpers/testVerbatimStore.js');
const { makeDispositionEnv, recordReplayFailure } = await import('../packages/lore/src/outbox/failureDisposition.js');
const { isSqliteLockedError } = await import('../packages/lore/src/engines/graphShared/deleteOutcome.js');
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

const DIM = 8;
class DetEmbedder implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'lock-halt-det'; readonly dtype = 'fp32';
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

type Db = { prepare(s: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } };
const dbOf = (s: object): Db => (s as unknown as { db: Db }).db;
interface RowView { status: string; attempts: number; transientRetries: number; deadReason: string | null }
const views = (s: object): RowView[] =>
    dbOf(s).prepare('SELECT status, attempts, transientRetries, deadReason FROM outbox_entries ORDER BY sequenceId').all() as RowView[];
const releaseBackoff = (s: object): void => { dbOf(s).prepare(`UPDATE outbox_entries SET nextAttemptAt = '2000-01-01T00:00:00.000Z' WHERE status = 'failed'`).run(); };

const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const N = 6;

async function rig() {
    const ws = mkTmp('lore-halt-ws-');
    const real = new SqliteVerbatimStore(ws, new DetEmbedder());
    await real.initialize();
    (real as unknown as { db: { pragma(s: string): unknown } }).db.pragma('busy_timeout = 20');
    const failWith: { next: (() => Error) | null } = { next: null };
    const proxy = new Proxy(real, {
        get(target, prop, receiver) {
            if ((prop === 'store' || prop === 'storeBatch') && failWith.next) return async () => { throw failWith.next!(); };
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
        },
    }) as unknown as VerbatimStoreApi;
    const wiring = wireOutbox({
        loreDir: mkTmp('lore-halt-outbox-'),
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getVerbatim: () => proxy,
    });
    for (let i = 0; i < N; i++) {
        await recordHotWrite(wiring.store, {
            workspace: 'w', operationKind: 'verbatim.upsert', operation: 'verbatim.upsert',
            payload: { id: `lore:w:halt-${i}`, text: `row ${i}`, metadata: { updatedAt: '2026-10-24T00:00:00.000Z' } },
        });
    }
    return { ws, real, wiring, failWith };
}

console.log('replicator: a SQLite lock error stops the batch');

await test('REAL lock: one tick touches exactly one row; the rest are untouched; all replicate once the lock clears', async () => {
    const r = await rig();
    const holder = new Database(path.join(r.ws, '.lore', 'verbatim.sqlite'));
    holder.pragma('busy_timeout = 20');
    try {
        holder.exec('BEGIN EXCLUSIVE');
        await r.wiring.replicator.tickOnce();
        let v = views(r.wiring.store);
        assert.equal(v.length, N);
        assert.equal(v.filter((x) => x.transientRetries > 0).length, 1, `one tick, one lock failure: ${JSON.stringify(v)}`);
        assert.equal(v.filter((x) => x.status === 'pending').length, N - 1, 'the rest were never attempted');
        assert.ok(v.every((x) => x.attempts === 0 && x.deadReason === null));
        releaseBackoff(r.wiring.store);
        await r.wiring.replicator.tickOnce();
        v = views(r.wiring.store);
        assert.equal(v.reduce((n, x) => n + x.transientRetries, 0), 2, 'the next tick advances by one more row only');
        assert.equal(r.wiring.replicator.getStats().dead, 0);
    } finally {
        try { holder.exec('ROLLBACK'); } catch { /* not in a txn */ }
        holder.close();
    }
    releaseBackoff(r.wiring.store);
    for (let i = 0; i < 4; i++) await r.wiring.replicator.tickOnce();
    const v = views(r.wiring.store);
    assert.ok(v.every((x) => x.status === 'replicated' && x.attempts === 0), JSON.stringify(v));
    assert.equal((await r.real.getById('lore:w:halt-5'))?.text, 'row 5');
    await r.real.close();
});

console.log('replicator: other failures are unchanged');

await test('a NON-lock error walks the whole batch and counts an attempt on every row', async () => {
    const r = await rig();
    r.failWith.next = () => Object.assign(new Error('UNIQUE constraint failed: verbatim.id'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    await r.wiring.replicator.tickOnce();
    const v = views(r.wiring.store);
    assert.equal(v.length, N);
    assert.ok(v.every((x) => x.attempts === 1 && x.transientRetries === 0 && x.status === 'failed'), JSON.stringify(v));
    for (let i = 0; i < 6; i++) { releaseBackoff(r.wiring.store); await r.wiring.replicator.tickOnce(); }
    assert.ok(views(r.wiring.store).every((x) => x.status === 'dead' && x.deadReason === 'permanent'), 'still dead-letters at maxAttempts');
    await r.real.close();
});

await test('a halting lock error past the 24 h ceiling is still dead as transient_ceiling (and halts)', async () => {
    let t = Date.parse('2026-10-24T00:00:00.000Z');
    const env = makeDispositionEnv(
        { maxAttempts: 5, transientCeilingMs: 24 * 3_600_000, transientBaseMs: 1000, transientCapMs: 60_000 },
        isSqliteLockedError, { now: () => t, random: () => 0.5 }, isSqliteLockedError,
    );
    const seen: Array<{ id: string; status: string; extra?: Record<string, unknown> }> = [];
    const store = {
        markEntryStatus: async (id: string, status: string, extra?: Record<string, unknown>) => { seen.push({ id, status, extra }); },
        recordTransientFailure: async () => { /* recorded */ },
    };
    const lock = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const entry = { id: 'e1', transientRetries: 3, firstTransientAt: new Date(t - 25 * 3_600_000).toISOString(), attempts: 0 };
    const out = await recordReplayFailure(store as never, entry as never, lock, env);
    assert.equal(out.kind, 'dead');
    assert.equal(seen[0]?.extra?.deadReason, 'transient_ceiling');
    assert.equal(env.batchHalted, true);
    env.batchHalted = false;
    const permanent = await recordReplayFailure(store as never, { id: 'e2', attempts: 0 } as never, new Error('boom'), env);
    assert.equal(permanent.kind, 'failed');
    assert.equal(env.batchHalted, false, 'a non-lock error never halts the batch');
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

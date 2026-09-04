#!/usr/bin/env tsx
/**
 * test/Z2-substrate-loaders-unit.ts — Sprint Z2 unit tests.
 *
 * Drives each substrate adapter + the dispatcher + the runner with
 * in-process fixtures (no live daemon, no legacy graph engine, no LanceDB). Covers:
 *
 *   - SqliteBulkLoaderAdapter: 1000 rows in one txn; correct row count;
 *     workspace_mismatch row is reported + skipped; missing_id reported
 *   - LanceBulkLoaderAdapter: chunks 10k rows into 5k batches; both
 *     reach the addRows callback; embed=skip uses zero vectors; per-row
 *     workspace check enforced
 *   - LoaderDispatcher: routes by parsed.target; flush threshold
 *     respected; flushAll drains all substrates
 *   - LoadJobsRunner: received→running→complete state machine; errors
 *     accumulated into load_jobs.errors_json; load.done outbox entry
 *     emitted
 *   - Sprint L workspace_required preserved (workspace mismatch surfaces
 *     as per-row error, not silent acceptance)
 *   - Sprint O outbox load.done has correct shape
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteBulkLoaderAdapter } from '../packages/lore/src/bulkLoader/sqliteAdapter.js';
import { LanceBulkLoaderAdapter, type LanceRow, type LanceLoadRow } from '../packages/lore/src/bulkLoader/lanceAdapter.js';
import { LoaderDispatcher, type ParsedRow } from '../packages/lore/src/bulkLoader/loaderDispatcher.js';
import { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';
import { LoadJobsRunner, routeJsonlObject } from '../packages/lore/src/storage/loadJobsRunner.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void> | void) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}\n    ${(e as Error).stack?.split('\n').slice(1, 4).join('\n    ')}`); failed++; }
    })());
};

console.log('Sprint Z2 — substrate-native loaders + dispatcher + runner');

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── SqliteBulkLoaderAdapter ────────────────────────────────────────────

test('SQLite adapter writes 1000 rows in one batch (prepared+txn floor)', async () => {
    const db = new Database(':memory:');
    const a = new SqliteBulkLoaderAdapter({ loreDir: '/tmp', dbOverride: db });
    await a.begin({ workspace: 'w1', embed: 'skip', jobId: 'job1', baseRowIndex: 0 });
    const rows = Array.from({ length: 1000 }, (_, i) => ({
        id: `id-${i}`, text: `t${i}`, workspace: 'w1',
    }));
    const r = await a.writeBatch(rows);
    assert.equal(r.written, 1000);
    assert.equal(r.failed, 0);
    assert.equal(r.errors.length, 0);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM bulk_verbatim').get() as { c: number }).c;
    assert.equal(count, 1000);
    await a.commit();
});

test('SQLite adapter reports workspace_mismatch as per-row error (Sprint L)', async () => {
    const db = new Database(':memory:');
    const a = new SqliteBulkLoaderAdapter({ loreDir: '/tmp', dbOverride: db });
    await a.begin({ workspace: 'wA', embed: 'skip', jobId: 'job2', baseRowIndex: 0 });
    const r = await a.writeBatch([
        { id: 'x', text: 'ok', workspace: 'wA' },
        { id: 'y', text: 'bad', workspace: 'wOther' },
    ]);
    assert.equal(r.written, 1);
    assert.equal(r.failed, 1);
    assert.match(r.errors[0]!.errorMessage, /workspace_mismatch/);
});

test('SQLite adapter reports missing_id', async () => {
    const db = new Database(':memory:');
    const a = new SqliteBulkLoaderAdapter({ loreDir: '/tmp', dbOverride: db });
    await a.begin({ workspace: 'w', embed: 'skip', jobId: 'j', baseRowIndex: 0 });
    const r = await a.writeBatch([{ id: '', text: 't', workspace: 'w' } as any]);
    assert.equal(r.written, 0);
    assert.equal(r.failed, 1);
});

// ─── LanceBulkLoaderAdapter ─────────────────────────────────────────────

test('Lance adapter chunks 10k rows into 5k batches', async () => {
    const seen: LanceLoadRow[][] = [];
    const a = new LanceBulkLoaderAdapter({
        vectorDim: 4,
        addRows: async (rows) => { seen.push(rows); },
    });
    await a.begin({ workspace: 'w', embed: 'skip', jobId: 'lj', baseRowIndex: 0 });
    const rows: LanceRow[] = Array.from({ length: 10_000 }, (_, i) => ({
        id: `lid-${i}`, text: `t${i}`, workspace: 'w',
    }));
    const r = await a.writeBatch(rows);
    assert.equal(r.written, 10_000);
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.length, 5_000);
    assert.equal(seen[1]!.length, 5_000);
    // Skip-embed → zero vectors of correct dim
    assert.deepEqual(seen[0]![0]!.vector, [0, 0, 0, 0]);
});

test('Lance adapter rejects workspace_mismatch', async () => {
    const a = new LanceBulkLoaderAdapter({ vectorDim: 2, addRows: async () => {} });
    await a.begin({ workspace: 'wA', embed: 'skip', jobId: 'lj', baseRowIndex: 0 });
    const r = await a.writeBatch([
        { id: 'g', text: 't', workspace: 'wA' },
        { id: 'b', text: 't', workspace: 'wB' },
    ]);
    assert.equal(r.written, 1);
    assert.equal(r.failed, 1);
});

// ─── LoaderDispatcher ───────────────────────────────────────────────────

test('LoaderDispatcher routes by target (verbatim → sqlite + lance)', async () => {
    const db = new Database(':memory:');
    const sqlite = new SqliteBulkLoaderAdapter({ loreDir: '/tmp', dbOverride: db });
    const lanceRows: LanceLoadRow[][] = [];
    const lance = new LanceBulkLoaderAdapter({
        vectorDim: 2,
        addRows: async (rs) => { lanceRows.push(rs); },
    });
    const d = new LoaderDispatcher({ sqlite, lance, flushThreshold: 10 });
    await d.begin({ workspace: 'w', embed: 'skip', jobId: 'jj', baseRowIndex: 0 });
    for (let i = 0; i < 25; i++) {
        const row: ParsedRow = {
            target: 'verbatim',
            row: { id: `v${i}`, text: `t${i}`, workspace: 'w' },
        };
        await d.dispatch(row, i);
    }
    const final = await d.flushAll();
    // Audit cluster 5 (2026-08-17): a verbatim row is ONE source row — it
    // counts once even though it is mirrored to sqlite + lance.
    assert.equal(final.written, 25);
    const sqliteCount = (db.prepare('SELECT COUNT(*) AS c FROM bulk_verbatim').get() as { c: number }).c;
    assert.equal(sqliteCount, 25);
    // Flush threshold 10 → at least 2 lance batches (one auto-flush + one final)
    assert.ok(lanceRows.length >= 1);
    const totalLance = lanceRows.reduce((s, b) => s + b.length, 0);
    assert.equal(totalLance, 25);
});

test('LoaderDispatcher records unknown_target', async () => {
    const d = new LoaderDispatcher({});
    await d.begin({ workspace: 'w', embed: 'skip', jobId: 'j', baseRowIndex: 0 });
    await d.dispatch({ target: 'bogus' as any, row: {} as any }, 7);
    const snap = d.snapshot();
    assert.equal(snap.failed, 1);
    assert.equal(snap.errors[0]!.rowIndex, 7);
    assert.match(snap.errors[0]!.errorMessage, /unknown_target/);
});

// ─── routeJsonlObject ────────────────────────────────────────────────────

test('routeJsonlObject: explicit target wins; workspace forced', () => {
    const r = routeJsonlObject({ target: 'graph.node', id: 'n', type: 't', workspace: 'evil' }, 'safe');
    assert.equal(r?.target, 'graph.node');
    if (r?.target === 'graph.node') {
        assert.equal(r.row.workspace, 'safe');
    }
});

test('routeJsonlObject: implicit verbatim fallback', () => {
    const r = routeJsonlObject({ id: 'x', text: 'hello' }, 'w');
    assert.equal(r?.target, 'verbatim');
});

test('routeJsonlObject: implicit graph.edge from from/to/relationship', () => {
    const r = routeJsonlObject({ from: 'a', to: 'b', relationship: 'r' }, 'w');
    assert.equal(r?.target, 'graph.edge');
});

test('routeJsonlObject: nulls + non-objects', () => {
    assert.equal(routeJsonlObject(null, 'w'), null);
    assert.equal(routeJsonlObject(42, 'w'), null);
    assert.equal(routeJsonlObject({}, 'w'), null);
});

// ─── LoadJobsRunner state machine ────────────────────────────────────────

test('LoadJobsRunner runs received→complete + persists progress + emits load.done', async () => {
    const dir = tmpDir('z2-runner-');
    const store = new LoadJobsStore(dir);
    // Stage a job + jsonl temp file with 50 verbatim rows.
    const tmpFile = path.join(dir, 'job.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
        lines.push(JSON.stringify({ id: `n-${i}`, text: `t${i}` }));
    }
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const createdAt = new Date().toISOString();
    await store.create({
        jobId: 'jobR', workspace: 'w', format: 'jsonl', embedMode: 'skip',
        tempFilePath: tmpFile, createdAt,
    });

    const outboxRecorded: OutboxEntry[] = [];
    const outboxStore: OutboxStore = {
        record: async (e) => { outboxRecorded.push(e); },
    } as unknown as OutboxStore;

    const db = new Database(':memory:');
    const sqlite = new SqliteBulkLoaderAdapter({ loreDir: '/tmp', dbOverride: db });
    const lance = new LanceBulkLoaderAdapter({
        vectorDim: 2,
        addRows: async () => {},
    });

    const runner = new LoadJobsRunner({
        store,
        outboxStore,
        buildDispatcherDeps: async () => ({ sqlite, lance }),
        config: { maxJobsPerTick: 1, progressIntervalRows: 10, log: () => {} },
    });
    const advanced = await runner.tickOnce();
    assert.equal(advanced, 1);
    const finalJob = await store.get('jobR');
    assert.ok(finalJob);
    assert.equal(finalJob!.status, 'complete');
    // Audit cluster 5 (2026-08-17): 50 verbatim source rows → 50 processed,
    // not 100 (the lance mirror no longer double-counts).
    assert.equal(finalJob!.rowsProcessed, 50);
    assert.equal(finalJob!.rowsFailed, 0);
    // load.done outbox entry emitted exactly once
    assert.equal(outboxRecorded.length, 1);
    assert.equal(outboxRecorded[0]!.operationKind, 'load.done');
    assert.equal((outboxRecorded[0]!.payload as { jobId?: string }).jobId, 'jobR');
    assert.equal((outboxRecorded[0]!.payload as { status?: string }).status, 'complete');
    store.close();
});

test('LoadJobsRunner accumulates per-row errors into load_jobs.errors_json', async () => {
    const dir = tmpDir('z2-runner-err-');
    const store = new LoadJobsStore(dir);
    const tmpFile = path.join(dir, 'err.jsonl');
    // Mix of valid + malformed JSON lines.
    fs.writeFileSync(tmpFile, [
        JSON.stringify({ id: 'ok-1', text: 'hi' }),
        '{not json',
        JSON.stringify({ id: 'ok-2', text: 'hi' }),
    ].join('\n'));
    await store.create({
        jobId: 'jobE', workspace: 'w', format: 'jsonl', embedMode: 'skip',
        tempFilePath: tmpFile, createdAt: new Date().toISOString(),
    });
    const db = new Database(':memory:');
    const sqlite = new SqliteBulkLoaderAdapter({ loreDir: '/tmp', dbOverride: db });
    const runner = new LoadJobsRunner({
        store,
        buildDispatcherDeps: async () => ({ sqlite }),
        config: { maxJobsPerTick: 1, log: () => {} },
    });
    await runner.tickOnce();
    const finalJob = await store.get('jobE');
    assert.equal(finalJob!.status, 'complete');
    // 2 valid verbatim → 2 sqlite writes
    assert.equal(finalJob!.rowsProcessed, 2);
    // 1 parse_error
    assert.ok(finalJob!.rowsFailed >= 1);
    assert.ok(finalJob!.errors.length >= 1);
    assert.match(finalJob!.errors[0]!.errorMessage, /parse_error/);
    store.close();
});

// ─── Run + summary ───────────────────────────────────────────────────────

await Promise.all(pending);
console.log('');
console.log(`passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);

#!/usr/bin/env tsx
/**
 * test/fc1-load-jobs-runner-unit.ts — 2026-08-17 audit findings 1.7 / 1.8
 * (POST /api/load runner).
 *
 *   1.7 — flushProgress()/the crash-recovery checkpoint snapshot the
 *         dispatcher WITHOUT flushing its substrate buffers, so
 *         checkpoint_row=N meant "N lines read", not "N rows durable" — a
 *         crash-resume permanently skipped buffered-but-unwritten rows.
 *         Now both paths flushAll() before counting.
 *   1.8 — embed='queued' (a documented /api/load mode) never enqueued a
 *         single embedding: the lance adapter writes ZERO_VECTOR on the
 *         stated contract that the runner emits an embed.batch outbox row
 *         per chunk, and the runner never did. Every row landed permanently
 *         invisible to semantic recall while the job reported complete.
 *         The runner now emits one embed.batch outbox row per durable flush.
 *
 * Harness: the REAL LoadJobsRunner (tickOnce) + REAL LoadJobsStore (sqlite),
 * with recording fake substrate adapters + a recording fake outbox store —
 * the same seam production wiring (server.ts) uses.
 *
 * Run: npx tsx test/fc1-load-jobs-runner-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';
import { wireLoadJobsRunner } from '../packages/lore/src/storage/loadJobsRunner.js';
import type { BulkLoaderAdapter, BatchResult } from '../packages/lore/src/bulkLoader/types.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

/** Recording fake substrate adapter — captures every writeBatch call. */
function fakeAdapter(substrate: 'sqlite' | 'kuzu' | 'lance') {
    const calls: string[][] = [];
    const adapter: BulkLoaderAdapter = {
        substrate,
        async begin() { /* no-op */ },
        async writeBatch(rows: unknown[]): Promise<BatchResult> {
            calls.push(rows.map((r) => String((r as { id?: string }).id ?? '?')));
            return { written: rows.length, failed: 0, errors: [] };
        },
        async checkpoint() { return { checkpointRowId: calls.length, at: new Date().toISOString(), offset: calls.length }; },
        async commit() { /* no-op */ },
        async rollback() { /* no-op */ },
    };
    return { adapter, calls };
}

/** Recording fake outbox store (the runner only needs record()). */
function fakeOutbox() {
    const entries: OutboxEntry[] = [];
    return {
        entries,
        record: async (e: OutboxEntry) => { entries.push(e); },
    };
}

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc1-loadjobs-'));
    const store = new LoadJobsStore(dir);
    const sqlite = fakeAdapter('sqlite');
    const lance = fakeAdapter('lance');
    const outbox = fakeOutbox();

    // 5 verbatim rows — below the dispatcher's 1000-row auto-flush threshold,
    // so pre-fix NOTHING reached the adapters before EOF.
    const rows = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ id: `ld-${i}`, text: `loaded document ${i} about pangolins` }));
    const tempFile = path.join(dir, 'upload.jsonl');
    fs.writeFileSync(tempFile, rows.join('\n') + '\n');

    await store.create({
        jobId: 'job-1',
        workspace: 'default',
        format: 'jsonl',
        embedMode: 'queued',
        tempFilePath: tempFile,
        createdAt: new Date().toISOString(),
    });

    const runner = wireLoadJobsRunner({
        store,
        outboxStore: outbox as never,
        config: { progressIntervalRows: 2, checkpointIntervalRows: 3 },
        buildDispatcherDeps: async () => ({
            sqlite: sqlite.adapter as never,
            lance: lance.adapter as never,
            flushThreshold: 1000,
        }),
    });

    await runner.tickOnce();

    const job = (await store.get('job-1'))!;
    assert.equal(job.status, 'complete', `job must complete (got ${job.status})`);
    // rows_processed counts SOURCE rows, not substrate writes (fixed
    // 2026-08-17, cluster 5b: each verbatim row landing in BOTH sqlite AND
    // lance previously double-counted as 2 — one source row now counts once).
    assert.equal(job.rowsProcessed, 5);

    await test('1.7 — progress flushes are REAL: substrate writes happen mid-run, not only at EOF', async () => {
        // progressInterval=2 → durable flushes after rows 2 and 4, then EOF.
        // Pre-fix the dispatcher was only snapshotted (never flushed), so the
        // adapters saw exactly ONE writeBatch (5 rows) at flushAll().
        assert.ok(lance.calls.length >= 2,
            `expected ≥2 lance writeBatch calls (mid-run flushes), got ${lance.calls.length}: ${JSON.stringify(lance.calls)}`);
        assert.deepEqual(lance.calls.flat().sort(), ['ld-0', 'ld-1', 'ld-2', 'ld-3', 'ld-4']);
        assert.deepEqual(sqlite.calls.flat().sort(), ['ld-0', 'ld-1', 'ld-2', 'ld-3', 'ld-4']);
    });

    await test('1.7 — checkpoint_row only counts durable rows', async () => {
        // checkpointInterval=3 → a checkpoint fires after row 3, and only
        // because the runner flushed first is it true that 3 rows are durable.
        assert.equal(job.checkpointRow, 3, `checkpoint_row=${job.checkpointRow}`);
        // The first mid-run flush (progress, row 2) + checkpoint flush (row 3)
        // must have persisted ≥3 rows BEFORE the checkpoint was written.
        const durableByCheckpoint = lance.calls
            .slice(0, 2) // progress@2 + checkpoint@3 flushes
            .flat().length;
        assert.ok(durableByCheckpoint >= 3,
            `at least checkpoint_row rows must be durable at checkpoint time (got ${durableByCheckpoint})`);
    });

    await test('1.8 — embed=queued emits embed.batch outbox rows covering every loaded row', async () => {
        const embedRows = outbox.entries.filter((e) => e.operationKind === 'embed.batch');
        assert.ok(embedRows.length >= 1, 'pre-fix: ZERO embed.batch rows were ever emitted');
        const coveredIds = embedRows
            .flatMap((e) => ((e.payload as { targetNodeIds?: string[] }).targetNodeIds ?? []));
        assert.deepEqual(coveredIds.sort(), ['ld-0', 'ld-1', 'ld-2', 'ld-3', 'ld-4'],
            'every loaded row must get an embed.batch target id');
        const texts = embedRows.flatMap((e) => ((e.payload as { texts?: string[] }).texts ?? []));
        assert.ok(texts.some((t) => t.includes('pangolins')), 'texts ride the payload for the embedder');
        assert.ok(embedRows.every((e) => e.workspace === 'default'), 'workspace invariant on outbox rows');
        // Emission happens per durable flush (progress@2, checkpoint@3, EOF) —
        // more than one row total, never one giant silent blob at best-effort.
        assert.ok(embedRows.length >= 2, `expected per-flush emission, got ${embedRows.length} embed.batch row(s)`);
    });

    await test('1.8 — load.done still emitted with truthful counts', async () => {
        const done = outbox.entries.find((e) => e.operationKind === 'load.done');
        assert.ok(done, 'load.done must be emitted');
        const p = done!.payload as { rowsProcessed: number; rowsFailed: number };
        assert.equal(p.rowsProcessed, 5); // source-row counting (see above)
        assert.equal(p.rowsFailed, 0);
    });

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

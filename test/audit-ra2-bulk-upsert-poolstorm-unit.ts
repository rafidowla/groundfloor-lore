#!/usr/bin/env tsx
/**
 * audit-ra2-bulk-upsert-poolstorm-unit.ts — re-audit 2026-06-25-reaudit2
 * (write-path regression; Atlas full-re-scan completeness).
 *
 * History: LocalGraph's upsertNode used to run its read-decide-write PRE-READ
 * via getNode(), borrowing a separate Kùzu pool connection PER call. Under a
 * bulk fan-out plus concurrent reads those pre-reads saturated the pool's
 * waiter queue → "waiter queue full" → "No write was applied". The fix ran
 * the existence read through the write lane; that engine serialized all
 * writes through one global queue, so even a 250-wide UNBOUNDED fan-out of
 * individual upsertNode calls succeeded.
 *
 * The engine-agnostic core survives the Kùzu removal: a BULK WRITE FAN-OUT
 * RUNNING AGAINST CONCURRENT READS on the same handle must produce zero
 * write failures and zero dropped writes. On SurrealGraph the bulk surface is
 * `bulkUpsertNodes` — SurrealDB is optimistically concurrent, and
 * individually-awaited `upsertNode` calls fanned out ≥16-wide can exhaust the
 * 8-attempt transaction-conflict retry budget
 * (engines/transactionConflictRetry.ts; loud per-write errors, no silent
 * loss — production's bulk paths cap at BULK_INGEST_CONCURRENCY=16 and report
 * that class per-slot). The batched surface is the zero-failure contract.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('RA2 — bulk upsert fan-out survives concurrent reads (no storm)');

await test('250-node bulkUpsertNodes batch (+ concurrent bulkList reads) all succeed, all durable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ra2-poolstorm-'));
    const graph = new SurrealGraph(dir);
    try {
        await graph.initialize();
        const N = 250;
        const big = 'x'.repeat(40_000); // mimic a large embed:false code file
        const nodes = Array.from({ length: N }, (_, i) => ({
            id: `code-file:repo/src/file${i}.ts`,
            type: 'code-file', label: `file${i}.ts`,
            content: i % 10 === 0 ? big : `c${i}`,
            project: 'storm', ecosystem: '*', tags: 'code', embed: false,
        }));

        // Aux reads hammering concurrently with the writes — the same
        // read/write contention shape the original pool storm exposed.
        let reading = true;
        const reader = (async () => {
            while (reading) { try { await graph.bulkList({ project: 'storm', limit: 100 }); } catch { /* ignore */ } }
        })();

        const results = await graph.bulkUpsertNodes(nodes as never);
        reading = false;
        await reader;

        const failures = results.filter((r) => !r.ok);
        assert.equal(failures.length, 0,
            `expected 0 bulk-upsert failures under concurrent reads, got ${failures.length} (e.g. ${JSON.stringify(failures[0] ?? '')})`);

        // And every node is actually persisted (no phantom/dropped writes).
        let readable = 0;
        for (const n of nodes) if (await graph.getNode(n.id)) readable++;
        assert.equal(readable, N, 'every upserted node is readable back');
        assert.equal((await graph.getStats()).nodeCount, N, 'exact row count — no duplicates, no losses');
    } finally {
        await graph.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

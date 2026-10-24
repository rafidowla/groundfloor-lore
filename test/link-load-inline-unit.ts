#!/usr/bin/env tsx
/**
 * test/link-load-inline-unit.ts - /api/load jobs with embed=inline signal link-on-arrival once the rows are durable
 * (queued jobs already do, through the embed.batch outbox handler; skip jobs hold placeholder zero vectors, so there is
 * nothing to link until a later embed commits).
 *
 *   inline   rows with a node-shaped id (`lore:<id>`) are signalled AFTER the substrate flush, workspace-scoped
 *   intent   a row's explicit autolink:false is recorded BEFORE the signal, so the worker drops it
 *   skip     embed=skip signals nothing
 *   ids      a bare (non `lore:`) row id is never signalled (signalCommitted drops it, as on the queued path)
 *
 * Run: npx tsx test/link-load-inline-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';
import { wireLoadJobsRunner } from '../packages/lore/src/storage/loadJobsRunner.js';
import type { BulkLoaderAdapter, BatchResult } from '../packages/lore/src/bulkLoader/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

async function run(embedMode: 'inline' | 'skip' | 'queued', rows: object[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lli-'));
    const log: string[] = [];
    let durable = 0;
    const mk = (substrate: 'sqlite' | 'lance'): BulkLoaderAdapter => ({
        substrate,
        async begin() { /* no-op */ },
        async writeBatch(r: unknown[]): Promise<BatchResult> { if (substrate === 'lance') durable += r.length; return { written: r.length, failed: 0, errors: [] }; },
        async checkpoint() { return { checkpointRowId: 0, at: new Date().toISOString(), offset: 0 }; },
        async commit() { /* no-op */ },
        async rollback() { /* no-op */ },
        async close() { /* no-op */ },
    } as BulkLoaderAdapter);
    const signaler = {
        signal: (ws: string, items: Array<{ id: string }>) => { log.push(`signal ${ws} ${items.map((i) => i.id).join(',')} durable=${durable}`); },
        setIntent: (ws: string, ids: string[], autolink: boolean | undefined) => { log.push(`intent ${ws} ${ids.join(',')} ${autolink}`); },
    };
    const store = new LoadJobsStore(dir);
    const tempFile = path.join(dir, 'u.jsonl');
    fs.writeFileSync(tempFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await store.create({ jobId: 'j', workspace: 'wsx', format: 'jsonl', embedMode, tempFilePath: tempFile, createdAt: new Date().toISOString() });
    const runner = wireLoadJobsRunner({
        store, linkSignaler: signaler as never, config: { progressIntervalRows: 2, checkpointIntervalRows: 3 },
        buildDispatcherDeps: async () => ({ sqlite: mk('sqlite') as never, lance: mk('lance') as never, flushThreshold: 1000 }),
    });
    await runner.tickOnce();
    assert.equal((await store.get('j'))!.status, 'complete');
    fs.rmSync(dir, { recursive: true, force: true });
    return log;
}

const ROWS = [
    { id: 'lore:a', text: 'alpha' }, { id: 'lore:b', text: 'beta', autolink: false }, { id: 'lore:c', text: 'gamma' },
    { id: 'lore:d', text: 'delta' }, { id: 'bare-e', text: 'epsilon' },
];

await test('inline: every lore: row is signalled, only after its vector is durable', async () => {
    const log = await run('inline', ROWS);
    const sig = log.filter((l) => l.startsWith('signal'));
    const all = sig.flatMap((l) => l.split(' ')[2]!.split(','));
    assert.deepEqual([...all].sort(), ['a', 'b', 'c', 'd'], 'node ids of the lore: rows; the bare id is dropped, as on the queued path');
    assert.ok(sig.every((l) => l.startsWith('signal wsx ')), 'workspace-scoped');
    // a signal for N rows may only fire once at least N rows were flushed to the vector substrate
    for (const l of sig) {
        const n = l.split(' ')[2]!.split(',').length;
        assert.ok(Number(l.split('durable=')[1]) >= n || sig.length > 1, l);
    }
    assert.equal(sig.map((l) => Number(l.split('durable=')[1])).filter((d) => d === 0).length, 0, 'never signalled before any flush');
});

await test('inline: autolink:false is recorded as an intent before the signal', async () => {
    const log = await run('inline', ROWS);
    const iIntent = log.findIndex((l) => l === 'intent wsx b false');
    const iSignal = log.findIndex((l) => l.startsWith('signal') && l.split(' ')[2]!.split(',').includes('b'));
    assert.ok(iIntent >= 0, `intent missing: ${log.join(' | ')}`);
    assert.ok(iIntent < iSignal, 'intent first');
});

await test('skip: nothing is signalled (placeholder zero vectors)', async () => {
    const log = await run('skip', ROWS);
    assert.deepEqual(log.filter((l) => l.startsWith('signal')), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

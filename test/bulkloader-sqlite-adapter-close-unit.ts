#!/usr/bin/env tsx
/**
 * test/bulkloader-sqlite-adapter-close-unit.ts — STEP2-CLOSE-PATH-DESIGN.md (d).
 *
 * `SqliteBulkLoaderAdapter` (bulkLoader/sqliteAdapter.ts) opens its own
 * dedicated `bulk-verbatim.sqlite` connection per bulk-load job
 * (constructed fresh at mcp/server.ts's per-job load-dispatch site, so
 * `ownDb=true` every time in production). Its own `commit()` doc comment
 * claimed "close it so the temp file handle releases" but the code never
 * did — and neither `LoaderDispatcher` (bulkLoader/loaderDispatcher.ts) nor
 * `storage/loadJobsRunner.ts` ever called `.close()` after a job finished,
 * failed, or was cancelled. Every load job leaked one open sqlite handle
 * for the life of the daemon.
 *
 * Fix: `LoaderDispatcher.close()` (new) closes the sqlite adapter it owns
 * (the graph/lance adapters route through shared, separately-owned stores
 * and must NOT be closed here); `loadJobsRunner.ts`'s `finally` block now
 * calls it unconditionally, so it runs on the complete, failed, cancelled,
 * AND thrown-exception paths alike.
 *
 * These assertions exercise `LoaderDispatcher` + a REAL file-backed
 * `SqliteBulkLoaderAdapter` directly (not the full runner — that requires
 * a live LoadJobsStore/graph/lance wiring this unit test doesn't need) —
 * the runner-level wiring is a single `dispatcher.close()` call in a
 * `finally`, already covered by reading loadJobsRunner.ts.
 *
 * Run: npx tsx test/bulkloader-sqlite-adapter-close-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteBulkLoaderAdapter, BULK_VERBATIM_SQLITE_FILE } from '../packages/lore/src/bulkLoader/sqliteAdapter.js';
import { LoaderDispatcher } from '../packages/lore/src/bulkLoader/loaderDispatcher.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

function tmpLoreDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bulkloader-close-'));
}

console.log('\nLoaderDispatcher / SqliteBulkLoaderAdapter — native handle is released\n');

await test('LoaderDispatcher.close() closes a real, owned SqliteBulkLoaderAdapter handle', async () => {
    const loreDir = tmpLoreDir();
    try {
        const sqlite = new SqliteBulkLoaderAdapter({ loreDir });
        const dispatcher = new LoaderDispatcher({ sqlite });
        await dispatcher.begin({ embed: 'skip', workspace: 'w1', jobId: 'job-1', baseRowIndex: 0 });
        await dispatcher.dispatch({ target: 'verbatim', row: { id: 'n1', text: 'hello', workspace: 'w1' } }, 0);
        await dispatcher.flushAll();
        await dispatcher.commit();

        assert.equal((sqlite as unknown as { db: { open: boolean } }).db.open, true, 'sanity: the handle is open before close()');
        dispatcher.close();
        assert.equal((sqlite as unknown as { db: { open: boolean } }).db.open, false, 'dispatcher.close() must release the owned native sqlite handle');
    } finally {
        fs.rmSync(loreDir, { recursive: true, force: true });
    }
});

await test('close() after commit() is safe (the completed-job path)', async () => {
    const loreDir = tmpLoreDir();
    try {
        const sqlite = new SqliteBulkLoaderAdapter({ loreDir });
        const dispatcher = new LoaderDispatcher({ sqlite });
        await dispatcher.begin({ embed: 'skip', workspace: 'w1', jobId: 'job-2', baseRowIndex: 0 });
        await dispatcher.commit();
        dispatcher.close(); // must not throw
        assert.equal((sqlite as unknown as { db: { open: boolean } }).db.open, false);
    } finally {
        fs.rmSync(loreDir, { recursive: true, force: true });
    }
});

await test('close() after rollback() is safe (the failed/cancelled-job path)', async () => {
    const loreDir = tmpLoreDir();
    try {
        const sqlite = new SqliteBulkLoaderAdapter({ loreDir });
        const dispatcher = new LoaderDispatcher({ sqlite });
        await dispatcher.begin({ embed: 'skip', workspace: 'w1', jobId: 'job-3', baseRowIndex: 0 });
        await dispatcher.rollback();
        dispatcher.close(); // this is exactly what loadJobsRunner.ts's finally does
        assert.equal((sqlite as unknown as { db: { open: boolean } }).db.open, false);
    } finally {
        fs.rmSync(loreDir, { recursive: true, force: true });
    }
});

await test('close() is idempotent — calling it twice does not throw', async () => {
    const loreDir = tmpLoreDir();
    try {
        const sqlite = new SqliteBulkLoaderAdapter({ loreDir });
        const dispatcher = new LoaderDispatcher({ sqlite });
        dispatcher.close();
        dispatcher.close(); // must not throw on an already-closed handle
    } finally {
        fs.rmSync(loreDir, { recursive: true, force: true });
    }
});

await test('an injected dbOverride (ownDb=false, test wiring) is never closed by the dispatcher', async () => {
    const DatabaseCtor = (await import('better-sqlite3')).default;
    const mem = new DatabaseCtor(':memory:');
    try {
        const sqlite = new SqliteBulkLoaderAdapter({ loreDir: tmpLoreDir(), dbOverride: mem });
        const dispatcher = new LoaderDispatcher({ sqlite });
        dispatcher.close();
        assert.equal(mem.open, true, 'a caller-supplied (not adapter-owned) handle must survive close()');
    } finally {
        mem.close();
    }
});

await test('LoaderDispatcher.close() with no sqlite adapter wired is a no-op, not a crash', () => {
    const dispatcher = new LoaderDispatcher({});
    dispatcher.close();
});

await test('sanity: the adapter really does write to BULK_VERBATIM_SQLITE_FILE under loreDir', async () => {
    const loreDir = tmpLoreDir();
    try {
        const sqlite = new SqliteBulkLoaderAdapter({ loreDir });
        assert.ok(fs.existsSync(path.join(loreDir, BULK_VERBATIM_SQLITE_FILE)), 'the dedicated bulk-verbatim sqlite file must exist on disk');
        sqlite.close();
    } finally {
        fs.rmSync(loreDir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

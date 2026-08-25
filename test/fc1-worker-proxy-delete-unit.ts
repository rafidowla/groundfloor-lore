#!/usr/bin/env tsx
/**
 * test/fc1-worker-proxy-delete-unit.ts — 2026-08-17 audit findings 1.11 / M12.
 *
 *   1.11 — With LORE_SEARCH_WORKER=1, VerbatimSearchWorkerProxy shadowed ONLY
 *          the methods in FORWARDED_METHODS; every other inherited
 *          VerbatimStore method ran against the deliberately-dead in-process
 *          half (initialized=false) and hit its own
 *          `if (!this.initialized || !this.table) return;` guard — silent
 *          no-op success. tombstone / physicalDelete / physicalDeleteMany /
 *          getHistory / exportRows / compact were missing, and EVERY
 *          user-facing delete goes through tombstone (delete_node's
 *          `typeof store.tombstone === 'function'` check is true via
 *          inheritance), so "delete this note" did nothing forever while
 *          reporting success. All six are now forwarded over IPC.
 *   M12  — exportRows() under worker isolation returned ZERO rows stamped
 *          with a fabricated model manifest — a workspace export silently
 *          produced an empty vector bundle. Covered by the same forwarding.
 *
 * Harness: a real VerbatimSearchWorkerProxy (child-process fork + IPC) over a
 * tmp store — the production path verbatim-search-worker-e2e.ts exercises.
 *
 * Run: npx tsx test/fc1-worker-proxy-delete-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Static imports: the proxy reads LORE_SEARCH_WORKER_READY_MS at
// construction/call time (positiveIntEnv per instance), not at module load,
// so import order is irrelevant here.
import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';

// Give the child a generous ready budget (model load on first run).
process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';

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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fc1-worker-proxy-'));

async function main() {
    console.log('1.11 — delete/history/maintenance methods forward to the worker');

    const proxy = new VerbatimSearchWorkerProxy(HOME);
    await proxy.initialize();

    // Seed THROUGH the proxy (forwarded store) — 2 docs, one stored twice so
    // it has a canonical row + one #rev snapshot.
    await proxy.store({ id: 'lore:n1', text: 'secret plan alpha v1', metadata: {} });
    await proxy.store({ id: 'lore:n1', text: 'secret plan alpha REVISED v2', metadata: {} });
    await proxy.store({ id: 'lore:n2', text: 'unrelated note about gardening', metadata: {} });
    assert.equal(await proxy.count(), 3, 'seed: 2 canonical + 1 #rev');

    await test('tombstone() actually tombstones (pre-fix: silent no-op, text stayed recallable)', async () => {
        await proxy.tombstone('lore:n1', 'user asked to delete');
        const row = await proxy.getById('lore:n1');
        assert.ok(row?.text?.startsWith('[TOMBSTONED'), 'canonical row text carries the tombstone marker');
        const hits = await proxy.search('secret plan alpha REVISED', 5);
        assert.ok(!hits.some((h) => h.id === 'lore:n1'), 'tombstoned row is out of vector search');
    });

    await test('getHistory() returns the revisions (pre-fix: 0 from the dead in-process store)', async () => {
        const hist = await proxy.getHistory('lore:n1');
        assert.ok(hist.length >= 2, `canonical + ≥1 #rev snapshot (got ${hist.length})`);
        assert.ok(hist.some((h) => h.isTombstone), 'history marks the tombstone');
    });

    await test('physicalDelete / physicalDeleteMany actually remove rows', async () => {
        await proxy.physicalDelete('lore:n2');
        assert.equal(await proxy.getById('lore:n2'), null, 'n2 gone');
        const hist = await proxy.getHistory('lore:n1');
        const revIds = hist.filter((h) => !h.isCanonical).map((h) => h.id);
        await proxy.physicalDeleteMany(revIds);
        const after = await proxy.getHistory('lore:n1');
        assert.equal(after.filter((h) => !h.isCanonical).length, 0, 'rev snapshots physically deleted');
    });

    await test('exportRows() returns the REAL rows + manifest (pre-fix: zero rows, fabricated manifest)', async () => {
        const bundle = await proxy.exportRows();
        assert.ok(bundle.rows.length >= 1, `export must contain the seeded rows (got ${bundle.rows.length})`);
        assert.ok(bundle.rows.every((r) => !r.id.includes('#rev')), 'canonical rows only');
        assert.ok(typeof bundle.modelId === 'string' && bundle.modelId.length > 0, 'real model id');
        assert.ok(bundle.dim > 0, 'real dimension');
        // The exported vector must be the REAL stored embedding, not zeros.
        const row = bundle.rows.find((r) => r.id === 'lore:n1');
        assert.ok(row && row.embedding.some((v) => v !== 0), 'embedding is non-zero');
    });

    await test('compact() runs in the worker (pre-fix: inherited null from the dead store)', async () => {
        const result = await proxy.compact();
        assert.ok(result !== null && typeof result === 'object',
            'compact must return real optimize stats, not the uninitialized-store null');
        assert.equal(typeof result!.fragmentsRemoved, 'number');
    });

    await test('ground truth: an in-process reopen sees the same end state', async () => {
        await proxy.close();
        const direct = new VerbatimStore(HOME);
        await direct.initialize();
        const n1 = await direct.getById('lore:n1');
        assert.ok(n1?.text?.startsWith('[TOMBSTONED'), 'tombstone persisted on disk');
        assert.equal(await direct.getById('lore:n2'), null, 'physicalDelete persisted on disk');
        await direct.close();
    });

    fs.rmSync(HOME, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

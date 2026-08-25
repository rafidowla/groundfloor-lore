#!/usr/bin/env tsx
/**
 * test/sw18-bounded-queries-unit.ts
 *
 * SW-18 — Bound queries that default to "fetch everything" (E8, E9, E10).
 *
 * Verifies:
 *   1. No-arg `listNodes()` returns at most DEFAULT_LIST_NODES_CAP rows,
 *      not the whole table.
 *   2. `listNodes(..., { unbounded: true })` returns ALL rows regardless
 *      of the cap.
 *   3. An explicit `limit` still works and is clamped to 10 000.
 *   4. `SqliteTableStorage.query()` applies a 10 000-row default limit
 *      when the caller supplies no `opts.limit`.
 *   5. Callers that pass explicit `opts.limit` override the default.
 *
 * Strategy:
 *   - For listNodes: a REAL embedded SurrealGraph with 10 050 nodes on
 *     disk, so the 10 000 cap is observable behaviour, not an assertion
 *     about a string the test built itself. (The original version of
 *     this section replicated Kuzu's Cypher decision tree locally and
 *     asserted on its own output — coverage that evaporated with the
 *     Kùzu removal.)
 *   - For SqliteTableStorage: a real SQLite file in /tmp; insert rows
 *     > cap and verify the default query returns the capped set.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/sw18-bounded-queries-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── Test harness ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => void | Promise<void>): void {
    pending.push(
        (async () => {
            try {
                await fn();
                console.log(`  ✓ ${name}`);
                passed++;
            } catch (err) {
                console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
                failed++;
            }
        })(),
    );
}

// ─── SqliteTableStorage helpers ───────────────────────────────────

import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { DEFAULT_LIST_NODES_CAP } from '../packages/lore/src/engines/loreNodeRow.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

function mkTmp(): { dbPath: string; cachePath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw18-sqlite-'));
    return {
        dbPath: path.join(dir, 'tables.sqlite'),
        cachePath: path.join(dir, 'schemas.json'),
        cleanup: () => {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
        },
    };
}

const ITEM_SCHEMA: TableSchema = {
    name: 'item',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'val', type: 'integer' },
    ],
};

// ─── SurrealGraph.listNodes cap verification ──────────────────────
//
// DEFAULT_LIST_NODES_CAP is 10 000, so seeding 10 050 nodes makes the
// boundary observable: a capped call returns exactly 10 000 rows, an
// unbounded opt-in returns all 10 050. Seeding uses bulkUpsertNodes in
// SEQUENTIAL batches — the embedded engine rejects concurrent write
// transactions ("Transaction write conflict"), so no Promise.all here.

const OVER_CAP = DEFAULT_LIST_NODES_CAP + 50;

function sw18Node(i: number): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id: `sw18-${i}`,
        type: i % 2 === 0 ? 'decision' : 'note',
        label: `SW-18 node ${i}`,
        content: `body ${i}`,
        tags: ['sw18'],
        project: 'p',
        ecosystem: 'e',
        metadata: '{}',
    };
}

async function seedSurreal(): Promise<{ graph: SurrealGraph; cleanup: () => void }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw18-surreal-'));
    const graph = new SurrealGraph(dir, { cacheDisabled: true, workspaceId: 'sw18' });
    await graph.initialize();
    const BATCH = 500;
    for (let base = 0; base < OVER_CAP; base += BATCH) {
        const batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>> = [];
        for (let i = base; i < Math.min(base + BATCH, OVER_CAP); i++) batch.push(sw18Node(i));
        const results = await graph.bulkUpsertNodes(batch);
        const bad = results.filter((r) => !r.ok);
        if (bad.length > 0) throw new Error(`seed batch at ${base} failed: ${JSON.stringify(bad[0])}`);
    }
    return {
        graph,
        cleanup: () => {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
        },
    };
}

console.log('SW-18 — bounded-queries unit');
console.log('');
console.log('listNodes cap on a real SurrealGraph:');

{
    const { graph, cleanup } = await seedSurreal();
    try {
        test('no-arg listNodes returns at most DEFAULT_LIST_NODES_CAP rows', async () => {
            const rows = await graph.listNodes();
            assert.equal(
                rows.length,
                DEFAULT_LIST_NODES_CAP,
                `Expected exactly ${DEFAULT_LIST_NODES_CAP} rows from ${OVER_CAP} seeded, got ${rows.length}`,
            );
        });

        test('listNodes with unbounded:true returns ALL rows past the cap', async () => {
            const rows = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
            assert.equal(rows.length, OVER_CAP, `Expected all ${OVER_CAP} rows, got ${rows.length}`);
        });

        test('listNodes with explicit limit=5000 returns 5000', async () => {
            const rows = await graph.listNodes(undefined, undefined, '*', '*', 5000);
            assert.equal(rows.length, 5000, `Expected 5000 rows, got ${rows.length}`);
        });

        test('listNodes with limit > 10000 is clamped to DEFAULT_LIST_NODES_CAP', async () => {
            const rows = await graph.listNodes(undefined, undefined, '*', '*', 999_999);
            assert.equal(
                rows.length,
                DEFAULT_LIST_NODES_CAP,
                `Expected over-cap explicit limit clamped to ${DEFAULT_LIST_NODES_CAP}, got ${rows.length}`,
            );
        });

        test('listNodes with limit=0 falls back to DEFAULT_LIST_NODES_CAP', async () => {
            const rows = await graph.listNodes(undefined, undefined, '*', '*', 0);
            assert.equal(
                rows.length,
                DEFAULT_LIST_NODES_CAP,
                `Expected cap fallback, got ${rows.length}`,
            );
        });

        test('listNodes with type filter + default cap still caps', async () => {
            const rows = await graph.listNodes('decision');
            const seededDecisions = Math.ceil(OVER_CAP / 2);
            assert.ok(rows.length <= DEFAULT_LIST_NODES_CAP, `Filter must not bypass the cap (got ${rows.length})`);
            assert.ok(rows.length > 0 && rows.every((r) => r.type === 'decision'),
                `Filtered rows must all match (seeded ${seededDecisions} decisions, got ${rows.length})`);
        });

        test('DEFAULT_LIST_NODES_CAP is 10000', () => {
            assert.equal(DEFAULT_LIST_NODES_CAP, 10_000, 'Cap value moved — update the SQL-side expectations too');
        });

        // The deferred harness starts bodies immediately but they settle
        // on the microtask queue — await them HERE so the finally below
        // cannot close the engine under a read still in flight.
        await Promise.all(pending);
    } finally {
        await graph.close().catch(() => undefined);
        cleanup();
    }
}

console.log('');
console.log('SqliteTableStorage.query default limit:');

test('query with no limit option returns at most 10000 rows (default cap enforced)', async () => {
    const { dbPath, cachePath, cleanup } = mkTmp();
    try {
        const store = new SqliteTableStorage(dbPath, cachePath);
        await store.createTable(ITEM_SCHEMA);

        // Insert 25 rows (well below cap — just verifying default limit is in SQL)
        for (let i = 0; i < 25; i++) {
            await store.insert(ITEM_SCHEMA.name, { id: `item-${i}`, val: i });
        }

        // No limit passed — should still work and return up to 10000
        const rows = await store.query(ITEM_SCHEMA.name);
        assert.equal(rows.length, 25, `Expected 25 rows, got ${rows.length}`);
    } finally {
        cleanup();
    }
});

test('query with explicit limit=5 returns only 5 rows', async () => {
    const { dbPath, cachePath, cleanup } = mkTmp();
    try {
        const store = new SqliteTableStorage(dbPath, cachePath);
        await store.createTable(ITEM_SCHEMA);

        for (let i = 0; i < 20; i++) {
            await store.insert(ITEM_SCHEMA.name, { id: `item-${i}`, val: i });
        }

        const rows = await store.query(ITEM_SCHEMA.name, undefined, { limit: 5 });
        assert.equal(rows.length, 5, `Expected 5 rows, got ${rows.length}`);
    } finally {
        cleanup();
    }
});

test('query without limit is bounded at 10000 when table has more rows', async () => {
    // This is the KEY test — base would return ALL rows unbounded.
    // On branch, default limit = 10000, so inserting 10001 rows and
    // querying with no limit should return exactly 10000.
    const { dbPath, cachePath, cleanup } = mkTmp();
    try {
        const store = new SqliteTableStorage(dbPath, cachePath);
        await store.createTable(ITEM_SCHEMA);

        // Insert 10001 rows
        const OVER = 10_001;
        // Use insertBatch for speed
        const batch = [];
        for (let i = 0; i < OVER; i++) {
            batch.push({ id: `item-${i}`, val: i });
        }
        await store.insertBatch(ITEM_SCHEMA.name, batch);

        // No-limit query — should be capped at 10000 on branch, 10001 on base.
        const rows = await store.query(ITEM_SCHEMA.name);
        assert.equal(
            rows.length,
            10_000,
            `Expected default cap of 10000, got ${rows.length} — base code is unbounded`,
        );
    } finally {
        cleanup();
    }
});

test('query with explicit limit=Infinity is clamped (or treated as no-op)', async () => {
    // Passing Infinity as limit — the implementation uses Math.max(0, Math.floor(opts.limit))
    // which gives Infinity → LIMIT Infinity. SQLite treats LIMIT -1 as no-limit, and
    // large numbers are clamped by SQLite. Verify the query at least completes.
    const { dbPath, cachePath, cleanup } = mkTmp();
    try {
        const store = new SqliteTableStorage(dbPath, cachePath);
        await store.createTable(ITEM_SCHEMA);
        await store.insert(ITEM_SCHEMA.name, { id: 'a', val: 1 });
        const rows = await store.query(ITEM_SCHEMA.name, undefined, { limit: Number.MAX_SAFE_INTEGER });
        assert.ok(rows.length >= 1, 'Expected at least 1 row with very large limit');
    } finally {
        cleanup();
    }
});

// ─── Run ──────────────────────────────────────────────────────────

await Promise.all(pending);
console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env tsx
/**
 * Q1.10 backend contract for typed, all-or-nothing table transactions.
 *
 * Run this same scenario factory against the future Postgres/Dataplane
 * adapter; local SQLite is the only wired backend today.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import type { ITableStorage, TableSchema } from '../packages/lore/src/contracts/tables.js';
import type { FilterNode } from '../packages/lore/src/engines/collectionStorage.js';
// B2 (QA finding, 2026-09-03) — collection_transaction/POST /v1/transaction
// bypassed collectionRowValidation.ts. handleTransaction is the MCP/REST
// boundary function that now pre-validates every op against the REAL
// SqliteTableStorage backend before runTransaction touches it.
import { handleTransaction, describeTransactionFailure } from '../packages/lore/src/mcp/tools/collectionsTransaction.js';
import { CollectionValidationError } from '../packages/lore/src/engines/collectionRowValidation.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function test(name: string, run: () => Promise<void>): void {
    pending.push((async () => {
        try {
            await run();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (error) {
            console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
            failed++;
        }
    })());
}

const ACCOUNTS: TableSchema = {
    name: 'accounts',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'balance', type: 'integer', required: true },
    ],
};
const LEDGER: TableSchema = {
    name: 'ledger',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'account_id', type: 'string', required: true },
        { name: 'amount', type: 'integer', required: true },
    ],
};

async function withSqlite(
    run: (storage: ITableStorage) => Promise<void>,
): Promise<void> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-table-tx-contract-'));
    const storage = new SqliteTableStorage(path.join(directory, 'tables.sqlite'));
    try {
        await storage.createTable(ACCOUNTS);
        await storage.createTable(LEDGER);
        await run(storage);
    } finally {
        storage.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

console.log('table transaction backend contract');

test('successful operations commit in order and return every result', async () => {
    await withSqlite(async storage => {
        await storage.insert('accounts', { id: 'a1', balance: 100 });
        const results = await storage.runTransaction([
            { op: 'update', collection: 'accounts', filter: { eq: { id: 'a1' } }, patch: { balance: 70 } },
            { op: 'insert', collection: 'ledger', row: { id: 'l1', account_id: 'a1', amount: -30 } },
            { op: 'upsert', collection: 'accounts', row: { id: 'a2', balance: 50 } },
        ]);
        assert.equal(results.length, 3);
        assert.equal((await storage.getByKey('accounts', 'a1'))?.balance, 70);
        assert.equal((await storage.getByKey('accounts', 'a2'))?.balance, 50);
        assert.equal((await storage.getByKey('ledger', 'l1'))?.amount, -30);
    });
});

test('one failed operation rolls back every table touched earlier', async () => {
    await withSqlite(async storage => {
        await storage.insert('accounts', { id: 'a1', balance: 100 });
        await assert.rejects(
            () => storage.runTransaction([
                { op: 'update', collection: 'accounts', filter: { eq: { id: 'a1' } }, patch: { balance: 70 } },
                { op: 'insert', collection: 'ledger', row: { id: 'broken', account_id: 'a1', amount: null } },
                { op: 'insert', collection: 'accounts', row: { id: 'never', balance: 1 } },
            ]),
            (error: Error & { failedOpIndex?: number }) => {
                assert.equal(error.failedOpIndex, 1);
                return true;
            },
        );
        assert.equal((await storage.getByKey('accounts', 'a1'))?.balance, 100);
        assert.equal(await storage.getByKey('accounts', 'never'), null);
        assert.equal(await storage.count('ledger'), 0);
    });
});

test('operation cap is checked before the first write', async () => {
    await withSqlite(async storage => {
        const operations = Array.from({ length: 101 }, (_, index) => ({
            op: 'insert' as const,
            collection: 'accounts',
            row: { id: `a-${index}`, balance: index },
        }));
        await assert.rejects(() => storage.runTransaction(operations), /at most 100 operations/);
        assert.equal(await storage.count('accounts'), 0);
    });
});

/*
 * B2 (QA finding, 2026-09-03) — against the REAL SqliteTableStorage
 * backend (not a fake), `handleTransaction` (the function collection_
 * transaction / POST /v1/transaction actually call) must pre-validate
 * every op the same way collection_insert/update/bulk_insert/
 * update_by_query already do. Before this fix, a wrong-typed value or
 * an unknown column reached SqliteTableStorage.runTransaction directly:
 * a numeric string into an integer column, or a boolean-ish string like
 * 'true'/'1', was silently coerced and committed instead of rejected.
 */
test('handleTransaction (real SQLite backend): string into an integer column is rejected, naming op index + field, nothing applied', async () => {
    await withSqlite(async storage => {
        await assert.rejects(
            () => handleTransaction({ tableStorage: storage }, {
                operations: [
                    { op: 'insert', collection: 'accounts', row: { id: 'tx-bad-type', balance: '42' } },
                ],
            }),
            (err: unknown) => {
                assert.ok(err instanceof CollectionValidationError);
                assert.equal(err.table, 'accounts');
                assert.equal(err.field, 'balance');
                assert.equal(err.rowIndex, 0);
                return true;
            },
        );
        assert.equal(await storage.getByKey('accounts', 'tx-bad-type'), null);
    });
});

test('handleTransaction (real SQLite backend): unknown column is rejected, naming op index + field, nothing applied', async () => {
    await withSqlite(async storage => {
        await assert.rejects(
            () => handleTransaction({ tableStorage: storage }, {
                operations: [
                    { op: 'insert', collection: 'accounts', row: { id: 'tx-bad-col', balance: 1, bogus_field: true } },
                ],
            }),
            (err: unknown) => {
                assert.ok(err instanceof CollectionValidationError);
                assert.equal(err.table, 'accounts');
                assert.equal(err.field, 'bogus_field');
                assert.equal(err.rowIndex, 0);
                return true;
            },
        );
        assert.equal(await storage.getByKey('accounts', 'tx-bad-col'), null);
    });
});

test('handleTransaction (real SQLite backend): a fully valid transaction still commits', async () => {
    await withSqlite(async storage => {
        const result = await handleTransaction({ tableStorage: storage }, {
            operations: [
                { op: 'insert', collection: 'accounts', row: { id: 'tx-ok', balance: 42 } },
            ],
        });
        assert.equal(result.results.length, 1);
        assert.equal((await storage.getByKey('accounts', 'tx-ok'))?.balance, 42);
    });
});

test('handleTransaction (real SQLite backend): an empty/all filter on an update op is refused before any write', async () => {
    await withSqlite(async storage => {
        await storage.insert('accounts', { id: 'tx-scope-1', balance: 5 });
        await assert.rejects(
            () => handleTransaction({ tableStorage: storage }, {
                operations: [
                    { op: 'update', collection: 'accounts', filter: {}, patch: { balance: 999 } },
                ],
            }),
            /refuses a structurally invalid filter|empty\/all filter/i,
        );
        assert.equal((await storage.getByKey('accounts', 'tx-scope-1'))?.balance, 5);
    });
});

test('handleTransaction (real SQLite backend): an empty/all filter on a delete op is refused before any write', async () => {
    await withSqlite(async storage => {
        await storage.insert('accounts', { id: 'tx-scope-2', balance: 5 });
        await assert.rejects(
            () => handleTransaction({ tableStorage: storage }, {
                operations: [
                    { op: 'delete', collection: 'accounts', filter: {} },
                ],
            }),
            /refuses a structurally invalid filter|empty\/all filter/i,
        );
        assert.equal(await storage.getByKey('accounts', 'tx-scope-2') !== null, true);
    });
});

/*
 * A3 round-2 (QA finding, 2026-09-03) — `filterZ` (collectionsTransaction.ts)
 * used to be a plain (non-strict) zod object listing only the leaf
 * operators. Zod's default behavior for an unrecognized key is to silently
 * STRIP it, not throw — so a filter combining a scoping `and` with a
 * broader leaf, e.g. `{and:[{eq:{id:'a1'}}], eq:{balance:100}}`, parsed
 * successfully with `and` dropped, leaving only `{eq:{balance:100}}` — an
 * update/delete meant for exactly one row silently hit every row sharing
 * that leaf value instead. `filterZ` is now `.strict()`: any unrecognized
 * key (`and`/`or`/`not`, or a typo) rejects the whole transaction body
 * BEFORE `runTransaction` touches storage, naming the offending op index
 * and key via `describeTransactionFailure`'s `filter_invalid` code.
 */
test('handleTransaction (real SQLite backend): a nested and/or filter on an update op is REJECTED, not silently narrowed to the leaf — nothing applied', async () => {
    await withSqlite(async storage => {
        await storage.insertBatch('accounts', [
            { id: 'a1', balance: 100 },
            { id: 'a2', balance: 100 },
        ]);
        // Caller intent: update ONLY a1, expressed with an and combining a
        // scoping id-eq with the shared balance-eq.
        const trickyFilter = { and: [{ eq: { id: 'a1' } }], eq: { balance: 100 } } as unknown as FilterNode;
        await assert.rejects(
            () => handleTransaction({ tableStorage: storage }, {
                operations: [
                    { op: 'update', collection: 'accounts', filter: trickyFilter, patch: { balance: 999 } },
                ],
            }),
            (err: unknown) => {
                const failure = describeTransactionFailure(err);
                assert.equal(failure.status, 400);
                assert.equal(failure.code, 'filter_invalid');
                assert.equal(failure.failed_op_index, 0);
                assert.match(failure.message, /"and"/);
                return true;
            },
        );
        assert.equal((await storage.getByKey('accounts', 'a1'))?.balance, 100);
        assert.equal((await storage.getByKey('accounts', 'a2'))?.balance, 100);
    });
});

test('handleTransaction (real SQLite backend): a nested and/or filter on a delete op is REJECTED, not silently narrowed to the leaf — nothing applied', async () => {
    await withSqlite(async storage => {
        await storage.insertBatch('accounts', [
            { id: 'a1', balance: 200 },
            { id: 'a2', balance: 200 },
        ]);
        const trickyFilter = { and: [{ eq: { id: 'a1' } }], eq: { balance: 200 } } as unknown as FilterNode;
        await assert.rejects(
            () => handleTransaction({ tableStorage: storage }, {
                operations: [
                    { op: 'delete', collection: 'accounts', filter: trickyFilter },
                ],
            }),
            (err: unknown) => {
                const failure = describeTransactionFailure(err);
                assert.equal(failure.code, 'filter_invalid');
                return true;
            },
        );
        assert.ok(await storage.getByKey('accounts', 'a1'));
        assert.ok(await storage.getByKey('accounts', 'a2'));
    });
});

test('handleTransaction (real SQLite backend): an unrecognized key in a filter (typo, not and/or/not) is REJECTED naming the op index and key', async () => {
    await withSqlite(async storage => {
        await storage.insert('accounts', { id: 'a1', balance: 5 });
        await assert.rejects(
            () => handleTransaction({ tableStorage: storage }, {
                operations: [
                    { op: 'update', collection: 'accounts', filter: { eqq: { id: 'a1' } } as unknown as FilterNode, patch: { balance: 1 } },
                ],
            }),
            (err: unknown) => {
                const failure = describeTransactionFailure(err);
                assert.equal(failure.status, 400);
                assert.equal(failure.code, 'filter_invalid');
                assert.match(failure.message, /"eqq"/);
                return true;
            },
        );
        assert.equal((await storage.getByKey('accounts', 'a1'))?.balance, 5);
    });
});

/*
 * Coordinator finding (2026-09-03, round E2 addendum) — an `upsert` op that
 * takes the fresh-INSERT branch (primary key not yet present) needs the
 * same required-column check a real `insert` op gets. Before this fix,
 * `validateTransactionOps` validated every upsert in partial-patch mode
 * (correct only for the UPDATE branch), so a fresh-insert upsert missing a
 * required column sailed past pre-validation and hit a raw SQLite
 * `NOT NULL constraint failed` deep in the storage layer with no table/
 * field named.
 */
test('handleTransaction (real SQLite backend): upsert taking the fresh-insert branch with a missing required column is rejected naming table+field, nothing applied', async () => {
    await withSqlite(async storage => {
        await assert.rejects(
            () => handleTransaction({ tableStorage: storage }, {
                operations: [
                    { op: 'upsert', collection: 'accounts', row: { id: 'fresh-1' } }, // missing required 'balance'
                ],
            }),
            (err: unknown) => {
                assert.ok(err instanceof CollectionValidationError);
                assert.equal(err.table, 'accounts');
                assert.equal(err.field, 'balance');
                assert.equal(err.rowIndex, 0);
                return true;
            },
        );
        assert.equal(await storage.getByKey('accounts', 'fresh-1'), null);
    });
});

test('handleTransaction (real SQLite backend): upsert taking the UPDATE branch (row already exists) still allows a partial patch', async () => {
    await withSqlite(async storage => {
        await storage.insert('accounts', { id: 'existing-1', balance: 10 });
        const result = await handleTransaction({ tableStorage: storage }, {
            operations: [
                // No 'balance' supplied — fine for the UPDATE branch, since
                // the row already has one and this is a partial patch.
                { op: 'upsert', collection: 'accounts', row: { id: 'existing-1' } },
            ],
        });
        assert.equal(result.results.length, 1);
        assert.equal((await storage.getByKey('accounts', 'existing-1'))?.balance, 10);
    });
});

/*
 * Coordinator finding (2026-09-03, round E2 addendum) — POST /v1/transaction
 * did not check `isPayloadTooLarge` before falling through to
 * `describeTransactionFailure`'s generic `transaction_failed` branch, unlike
 * every sibling /v1/{collection} route (classifyStorageErr,
 * mcp/http/routes/collections.ts). An oversized body answered 400 instead
 * of 413. This drives `describeTransactionFailure` directly with the exact
 * error shape `readBoundedBody` (mcp/http/helpers.ts) throws on overflow —
 * deterministic and fast, unlike round-tripping a real >10 MB HTTP body
 * through a live server.
 */
test('describeTransactionFailure: a payload-too-large error maps to 413 payload_too_large, not 400 transaction_failed', async () => {
    const err = new Error('request body exceeded 10485760 bytes') as Error & { code?: string };
    err.code = 'payload_too_large';
    const failure = describeTransactionFailure(err);
    assert.equal(failure.status, 413);
    assert.equal(failure.code, 'payload_too_large');
});

/*
 * QA round-3 (2026-09-03, finding A3, low) — the non-Zod default branch used
 * to fold `refuseAllFilter`'s specific "…refuses an empty/all filter…"
 * message into a generic `code: 'transaction_failed'` + templated "transaction
 * failed; nothing was applied" message — only `.reason` carried
 * `all_filter_refused`, unlike every sibling all-filter refusal on this
 * codebase's REST surface (classifyStorageErr), which returns
 * `code === reason === 'all_filter_refused'` with the real thrown message.
 */
test('describeTransactionFailure: an empty/all filter on an update op maps to code+reason all_filter_refused with the real message, not generic transaction_failed', async () => {
    await withSqlite(async storage => {
        await storage.insert('accounts', { id: 'a1', balance: 5 });
        await assert.rejects(
            () => handleTransaction({ tableStorage: storage }, {
                operations: [{ op: 'update', collection: 'accounts', filter: {}, patch: { balance: 999 } }],
            }),
            (err: unknown) => {
                const failure = describeTransactionFailure(err);
                assert.equal(failure.status, 400);
                assert.equal(failure.code, 'all_filter_refused');
                assert.equal(failure.reason, 'all_filter_refused');
                assert.match(failure.message, /refuses an empty\/all filter/i);
                assert.notEqual(failure.message, 'transaction failed; nothing was applied');
                return true;
            },
        );
        assert.equal((await storage.getByKey('accounts', 'a1'))?.balance, 5);
    });
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

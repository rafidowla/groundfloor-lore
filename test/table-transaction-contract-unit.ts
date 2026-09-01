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

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

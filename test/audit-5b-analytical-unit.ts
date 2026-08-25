#!/usr/bin/env tsx
/**
 * audit-5b-analytical-unit.ts — regression for three Cluster-5 medium/low
 * findings (2026-08-17 functional-correctness audit) against the REAL
 * production entry points (createTableStorage + createAnalyticalStorage
 * factories, the same pair the MCP analytical tools use):
 *
 *   [medium] Analytical aggregates ignored declared column types in
 *     filters — a boolean filter either threw a raw better-sqlite3 bind
 *     error (JS booleans are not bindable) or silently matched 0 rows
 *     ('false' never equals the stored integer 0). Now filters are encoded
 *     with the SAME type map the table store's write/read paths use.
 *
 *   [low] SqliteAnalyticalStorage.groupBy/distinct silently ignored the
 *     `limit` argument IAnalyticalStorage declares and the MCP/REST layers
 *     pass. Now applied as a bound LIMIT, validated as a positive integer.
 *
 *   [low] Analytical results were never decoded to their declared column
 *     types: distinct/groupBy/min/max returned raw storage values (boolean
 *     as 0/1, json as a JSON string) while collection_query on the same
 *     column returned true/false and parsed objects. Now decoded with the
 *     same decodeValue mapping as row reads.
 *
 * Run: npx tsx test/audit-5b-analytical-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTableStorage } from '../packages/lore/src/engines/tableStorageFactory.js';
import { createAnalyticalStorage } from '../packages/lore/src/engines/analyticalStorageFactory.js';
import type { IAnalyticalStorage } from '../packages/lore/src/contracts/analytical.js';
import type { ITableStorage } from '../packages/lore/src/contracts/tables.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit5b-'));
fs.mkdirSync(path.join(base, '.lore'), { recursive: true });
const tables: ITableStorage = createTableStorage(base);
const analytical = createAnalyticalStorage(tables) as IAnalyticalStorage;

console.log('Audit cluster 5 — analytical typed filters / limit / decoded results');

await tables.createTable({
    name: 'people',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'active', type: 'boolean' },
        { name: 'age', type: 'integer' },
        { name: 'profile', type: 'json' },
    ],
});
const ROWS = [
    { id: 'a', active: true, age: 31, profile: { city: 'Lisbon' } },
    { id: 'b', active: false, age: 25, profile: { city: 'Porto' } },
    { id: 'c', active: 'false', age: 40, profile: { city: 'Lisbon' } }, // string form (5.5 shape)
    { id: 'd', active: true, age: 19, profile: { city: 'Faro' } },
];
for (const r of ROWS) await tables.insert('people', r);

await test('medium: boolean filters on aggregates encode by declared type (no throw, right rows)', async () => {
    assert.equal(await analytical.count('people', { eq: { active: false } }), 2);
    assert.equal(await analytical.count('people', { eq: { active: true } }), 2);
    // The string form that previously bound raw and silently matched nothing:
    assert.equal(await analytical.count('people', { eq: { active: 'false' } }), 2);
    assert.equal(await analytical.sum('people', 'age', { eq: { active: false } }), 65);
    assert.equal(await analytical.min<number>('people', 'age', { eq: { active: true } }), 19);
});

await test('low: distinct honors limit and decodes declared types', async () => {
    const all = await analytical.distinct<boolean>('people', 'active');
    assert.deepEqual(all, [false, true], 'boolean distinct decodes 0/1 → false/true');
    const one = await analytical.distinct<boolean>('people', 'active', undefined, 1);
    assert.equal(one.length, 1, 'limit must be applied');
    const cities = await analytical.distinct<{ city: string }>('people', 'profile');
    assert.deepEqual(
        cities.map((c) => c.city).sort(),
        ['Faro', 'Lisbon', 'Porto'],
        'json distinct decodes to parsed objects, not JSON strings',
    );
});

await test('low: groupBy honors limit and decodes group keys', async () => {
    const g = await analytical.groupBy<boolean>('people', 'active', 'count', null);
    const byKey = new Map(g.map((r) => [r.key, r.count]));
    assert.equal(byKey.get(true), 2);
    assert.equal(byKey.get(false), 2);
    assert.ok(g.every((r) => typeof r.key === 'boolean'), 'group keys must be decoded booleans');
    const limited = await analytical.groupBy<boolean>('people', 'active', 'count', null, undefined, 1);
    assert.equal(limited.length, 1, 'groupBy limit must be applied');
});

await test('low: invalid limit throws instead of being silently ignored', async () => {
    await assert.rejects(() => analytical.distinct('people', 'active', undefined, 0), /positive integer/);
    await assert.rejects(() => analytical.groupBy('people', 'active', 'count', null, undefined, -3), /positive integer/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

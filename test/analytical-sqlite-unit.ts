#!/usr/bin/env tsx
/**
 * analytical-sqlite-unit.ts — analytical aggregates work against collections
 * written through the LIVE path.
 *
 * ── THE GAP THIS GUARDS ─────────────────────────────────────────────────────
 *
 * Collections moved to SQLite in 061e189 (2026-05-16). `LegacyAnalyticalStorage`
 * kept issuing `MATCH (n:<table>) RETURN count(n)` against the legacy graph engine node tables, so
 * for twelve weeks every aggregate over a modern collection threw
 * `Binder exception: Table <name> does not exist` — on an exposed MCP tool
 * surface (count/sum/avg/min/max/groupBy/distinct/timeSeries).
 *
 * It survived that long because nothing tested the two halves TOGETHER. There
 * were tests for the table store and tests for the analytical store, each
 * against its own substrate, and none that wrote through the path a caller
 * actually uses and then read back through the path a caller actually calls.
 * So that is what every test here does: write with `createTableStorage()` — the
 * real factory, no substrate named — then aggregate with
 * `createAnalyticalStorage()` — likewise. Neither test nor production picks a
 * backend by hand, so they cannot pick different ones.
 *
 * These fail on a993d82: `createAnalyticalStorage` does not exist there, and
 * the legacy graph engine store they would otherwise reach throws on every one of them.
 *
 * Run: npx tsx test/analytical-sqlite-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTableStorage } from '../packages/lore/src/engines/tableStorageFactory.js';
import { createAnalyticalStorage } from '../packages/lore/src/engines/analyticalStorageFactory.js';
import type { IAnalyticalStorage } from '../packages/lore/src/contracts/analytical.js';
import type { ITableStorage } from '../packages/lore/src/contracts/tables.js';

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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-analytical-'));
fs.mkdirSync(path.join(base, '.lore'), { recursive: true });

const tables: ITableStorage = createTableStorage(base);
const analytical: IAnalyticalStorage | null = createAnalyticalStorage(tables);

console.log('Analytical aggregates over the live collection backend');

await test('the factory pair agrees on a backend without either side naming one', () => {
    // The twelve-week defect in one assertion: production picked SQLite for
    // writes and the legacy graph engine for aggregates, and nothing checked they matched.
    assert.equal(tables.constructor.name, 'SqliteTableStorage');
    assert.ok(analytical, 'an analytical store exists for the live table backend');
    assert.equal(analytical!.constructor.name, 'SqliteAnalyticalStorage');
});

await tables.createTable({
    name: 'invoice',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'amount', type: 'int' },
        { name: 'status', type: 'string' },
        { name: 'created', type: 'string' },
    ],
} as never);

const ROWS = [
    { id: 'i1', amount: 100, status: 'open', created: '2026-01-05T10:00:00Z' },
    { id: 'i2', amount: 200, status: 'open', created: '2026-01-05T11:30:00Z' },
    { id: 'i3', amount: 300, status: 'paid', created: '2026-02-11T09:00:00Z' },
    { id: 'i4', amount: 400, status: 'paid', created: '2026-02-20T09:00:00Z' },
    { id: 'i5', amount: 500, status: 'void', created: '2026-05-01T09:00:00Z' },
];
for (const r of ROWS) await tables.insert('invoice', r as never);

await test('count / sum / avg / min / max over rows written through the live path', async () => {
    const a = analytical!;
    assert.equal(await a.count('invoice'), 5);
    assert.equal(await a.sum('invoice', 'amount'), 1500);
    assert.equal(await a.avg('invoice', 'amount'), 300);
    assert.equal(await a.min<number>('invoice', 'amount'), 100);
    assert.equal(await a.max<number>('invoice', 'amount'), 500);
});

await test('filters are applied, and bound rather than interpolated', async () => {
    const a = analytical!;
    assert.equal(await a.count('invoice', { eq: { status: 'open' } }), 2);
    assert.equal(await a.sum('invoice', 'amount', { eq: { status: 'paid' } }), 700);
    assert.equal(await a.count('invoice', { gte: { amount: 300 } }), 3);
    // A value that would break out of a naive string-interpolated query must
    // simply match nothing.
    assert.equal(await a.count('invoice', { eq: { status: "' OR 1=1 --" } }), 0);
});

await test('count counts ROWS, not non-null values', async () => {
    // `count(field)` skips NULLs and would disagree with the table store's own
    // count on any nullable column — a divergence of exactly the kind that
    // started this.
    await tables.insert('invoice', { id: 'i6', amount: null, status: 'open', created: '2026-06-01T00:00:00Z' } as never);
    assert.equal(await analytical!.count('invoice'), 6, 'the null-amount row still counts');
    assert.equal(await analytical!.sum('invoice', 'amount'), 1500, 'but contributes nothing to the sum');
    const viaTableStore = await (tables as unknown as { count(t: string): Promise<number> }).count('invoice');
    assert.equal(viaTableStore, 6, 'and the two stores agree — the whole point');
});

await test('groupBy returns per-group value AND group size', async () => {
    const g = await analytical!.groupBy<string>('invoice', 'status', 'sum', 'amount');
    const byKey = Object.fromEntries(g.map((r) => [r.key, r]));
    assert.deepEqual(Object.keys(byKey).sort(), ['open', 'paid', 'void']);
    assert.equal(byKey['open']!.value, 300);
    assert.equal(byKey['open']!.count, 3, 'group size accompanies the aggregate');
    assert.equal(byKey['paid']!.value, 700);
    assert.equal(byKey['void']!.count, 1);
});

await test('groupBy refuses a non-count aggregation with no field', async () => {
    await assert.rejects(
        () => analytical!.groupBy('invoice', 'status', 'sum', null),
        /requires aggregationField/,
    );
});

await test('distinct is deduplicated and ordered', async () => {
    assert.deepEqual(await analytical!.distinct<string>('invoice', 'status'), ['open', 'paid', 'void']);
});

await test('timeSeries buckets by calendar period — never implemented on the legacy graph engine', async () => {
    // The legacy graph engine store documents this as "stubbed pending verification of the legacy engine's
    // date-bucketing functions", so this is a first implementation rather than
    // a port. SQLite's strftime does it natively.
    const byMonth = await analytical!.timeSeries<string>('invoice', 'created', 'month', 'count', null);
    const m = Object.fromEntries(byMonth.map((p) => [p.bucket, p.value]));
    assert.deepEqual(Object.keys(m).sort(), ['2026-01', '2026-02', '2026-05', '2026-06']);
    assert.equal(m['2026-01'], 2);
    assert.equal(m['2026-02'], 2);

    const byYear = await analytical!.timeSeries<string>('invoice', 'created', 'year', 'sum', 'amount');
    assert.deepEqual(byYear, [{ bucket: '2026', value: 1500, count: 6 }]);

    const byQuarter = await analytical!.timeSeries<string>('invoice', 'created', 'quarter', 'count', null);
    const q = byQuarter.map((p) => p.bucket);
    assert.deepEqual(q, ['2026-Q1', '2026-Q2'], 'quarter is composed, not a strftime code');
});

await test('timeSeries DROPS unparseable timestamps rather than bucketing them together', async () => {
    // Collapsing them into one NULL bucket would mix unrelated rows into a
    // plausible-looking data point, which is worse than omitting them.
    await tables.insert('invoice', { id: 'bad', amount: 10, status: 'open', created: 'not-a-date' } as never);
    const pts = await analytical!.timeSeries<string>('invoice', 'created', 'month', 'count', null);
    assert.ok(pts.every((p) => p.bucket !== null && p.bucket !== undefined), 'no null bucket');
    assert.equal(pts.reduce((a, p) => a + p.count, 0), 6, 'the unparseable row is excluded, the other six remain');
});

await test('an identifier that is not a plain name is refused, not interpolated', async () => {
    await assert.rejects(() => analytical!.sum('invoice', 'amount); DROP TABLE invoice; --'), /invalid identifier/i);
    await assert.rejects(() => analytical!.count('invoice; DROP TABLE invoice'), /invalid identifier/i);
    assert.equal(await analytical!.count('invoice'), 7, 'the table is still there');
});

(tables as unknown as { close(): void }).close();
fs.rmSync(base, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

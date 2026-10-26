#!/usr/bin/env tsx
/**
 * test/pg-tables-values-unit.ts - money kind, per-value provenance and recorded-time as-of on
 * PostgresTableStorage (Tables P1, slice 2).
 *
 *   money        exact decimals + currency round-trip, validation, filters/ordering, update history,
 *                aggregateMoney REFUSES mixed currencies, evolveSchema, SQLite refuses clearly
 *   provenance   optional on write, absent from reads unless { provenance: true }, validation, history, isolation
 *   recorded     queryAsOf({ time: 'recorded' }) answers "what did we know on D"; valid time stays the default
 *
 * Throwaway database `lore_gate_tbl_values` on the LORE_PG_URL server (skips with a printed reason when unset).
 * Run: npx tsx test/pg-tables-values-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage, MixedCurrencyError } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_tbl_values';
const WS = 'pg-gate-values-a';
const WS2 = 'pg-gate-values-b';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const gate = gateDbUrl();
if (!gate) { console.log('SKIP pg-tables-values: LORE_PG_URL is not set - postgres cases skipped cleanly'); process.exit(0); }
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
const rejects = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
    try { await p; } catch (e) { assert.match((e as Error).message, re); return; }
    assert.fail(`expected rejection matching ${re}`);
};
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
/** The database clock, so recorded-time instants line up with recorded_at / superseded_at. */
const dbNow = async (): Promise<string> => { await sleep(25); const r = (await q<{ t: Date }>('SELECT clock_timestamp() AS t'))[0]!.t.toISOString(); await sleep(25); return r; };

const LEASES: TableSchema = {
    name: 'leases',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'tenant', type: 'string' },
        { name: 'rent', type: 'money' },
        { name: 'deposit', type: 'money' },
        { name: 'unit', type: 'string', indexed: true },
    ],
};

try {
    const t = await PostgresTableStorage.open(WS, pool);
    const other = await PostgresTableStorage.open(WS2, pool);
    await t.createTable(LEASES);

    console.log('\nmoney');
    await test('exact decimal + currency round-trip; currency upper-cased; numbers and strings accepted; null stays null', async () => {
        await t.insert('leases', { id: 'a', rent: { amount: '1234.50', currency: 'usd' }, deposit: { amount: 99.5, currency: 'CAD' } });
        await t.insert('leases', { id: 'big', rent: { amount: '12345678901234567890.123456789', currency: 'EUR' } });
        await t.insert('leases', { id: 'neg', rent: { amount: '-0.01', currency: 'USD' } });
        await t.insert('leases', { id: 'none' });
        assert.deepEqual(await t.getByKey('leases', 'a'), { id: 'a', tenant: null, rent: { amount: '1234.50', currency: 'USD' }, deposit: { amount: '99.5', currency: 'CAD' }, unit: null });
        assert.deepEqual((await t.getByKey('leases', 'big'))!['rent'], { amount: '12345678901234567890.123456789', currency: 'EUR' });
        assert.deepEqual((await t.getByKey('leases', 'neg'))!['rent'], { amount: '-0.01', currency: 'USD' });
        assert.equal((await t.getByKey('leases', 'none'))!['rent'], null);
    });
    await test('invalid money is rejected: missing currency, bad currency, non-decimal, bare number, array', async () => {
        const bad = (rent: unknown): Promise<void> => rejects(t.insert('leases', { id: 'bad', rent }), /column 'rent' expects \{ amount, currency \}/);
        await bad({ amount: '1' });
        await bad({ currency: 'USD' });
        await bad({ amount: '1', currency: 'US' });
        await bad({ amount: '1', currency: 'USDX' });
        await bad({ amount: 'abc', currency: 'USD' }).catch(async () => rejects(t.insert('leases', { id: 'bad', rent: { amount: 'abc', currency: 'USD' } }), /decimal amount/));
        await bad(12);
        await bad([1, 'USD']);
        assert.equal(await t.getByKey('leases', 'bad'), null, 'nothing was written');
    });
    await test('filters and ordering work on the amount; <column>__currency filters the currency', async () => {
        await t.insertBatch('leases', [
            { id: 'u1', rent: { amount: '100', currency: 'USD' }, unit: 'x' },
            { id: 'u2', rent: { amount: '250.25', currency: 'USD' }, unit: 'x' },
            { id: 'c1', rent: { amount: '175', currency: 'CAD' }, unit: 'x' },
        ]);
        const ids = async (f: object, o?: object): Promise<string[]> => (await t.query('leases', f as never, o as never)).map(r => r['id'] as string);
        assert.deepEqual(await ids({ and: [{ eq: { unit: 'x' } }, { gt: { rent: '100' } }] }), ['u2', 'c1']);
        assert.deepEqual(await ids({ eq: { rent__currency: 'CAD' } }), ['c1']);
        assert.deepEqual(await ids({ eq: { unit: 'x' } }, { orderBy: 'rent', orderDir: 'desc' }), ['u2', 'c1', 'u1']);
        assert.equal(await t.count('leases', { eq: { rent__currency: 'USD' } }), 4);
    });
    await test('update: same value writes no new version; a changed currency does (history keeps both)', async () => {
        const versions = async (): Promise<number> => Number((await q<{ c: string }>(
            `SELECT count(*)::text AS c FROM lore_entity_value v JOIN lore_entity e ON e.workspace_id = v.workspace_id AND e.entity_id = v.entity_id
              JOIN lore_field_def f ON f.workspace_id = v.workspace_id AND f.field_id = v.field_id
              WHERE e.workspace_id = $1 AND e.pk_text = 'a' AND f.name = 'rent'`, [WS]))[0]!.c);
        assert.equal(await versions(), 1);
        await t.update('leases', { eq: { id: 'a' } }, { rent: { amount: '1234.5', currency: 'USD' } });
        assert.equal(await versions(), 1, '1234.50 == 1234.5: not a change');
        await t.update('leases', { eq: { id: 'a' } }, { rent: { amount: '1234.50', currency: 'CAD' } });
        assert.equal(await versions(), 2);
        assert.deepEqual((await t.getByKey('leases', 'a'))!['rent'], { amount: '1234.50', currency: 'CAD' });
        await t.update('leases', { eq: { id: 'a' } }, { rent: null });
        assert.equal((await t.getByKey('leases', 'a'))!['rent'], null);
        await t.update('leases', { eq: { id: 'a' } }, { rent: { amount: '10', currency: 'USD' } });
        assert.deepEqual((await t.getByKey('leases', 'a'))!['rent'], { amount: '10', currency: 'USD' });
    });
    await test('schema rules: money cannot be primary or unique; <money>__currency name is reserved', async () => {
        await rejects(t.createTable({ name: 'm1', columns: [{ name: 'id', type: 'money', primary: true }] }), /money column 'id' cannot be primary or unique/);
        await rejects(t.createTable({ name: 'm2', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'p', type: 'money', unique: true }] }), /cannot be primary or unique/);
        await rejects(t.createTable({ name: 'm3', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'p', type: 'money' }, { name: 'p__currency', type: 'string' }] }), /p__currency/);
    });
    await test('a required money column enforces NOT NULL', async () => {
        await t.createTable({ name: 'bills', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'total', type: 'money', required: true }] });
        await rejects(t.insert('bills', { id: 'b' }), /NOT NULL constraint failed: bills\.total/);
        await t.insert('bills', { id: 'b', total: { amount: 1, currency: 'USD' } });
        await rejects(t.update('bills', { eq: { id: 'b' } }, { total: null }), /NOT NULL constraint failed: bills\.total/);
    });
    await test('money survives joins and queryWithNodes', async () => {
        await t.createTable({ name: 'tenants', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }] });
        await t.insert('tenants', { id: 'T', name: 'Acme' });
        await t.update('leases', { eq: { id: 'u1' } }, { tenant: 'T' });
        const rows = await t.join('leases', { table: 'tenants', on: { left: 'tenant', right: 'id' } }, { eq: { 'id': 'u1' } });
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0]!['leases.rent'], { amount: '100', currency: 'USD' });
        assert.equal(rows[0]!['tenants.name'], 'Acme');
        const withNodes = await t.queryWithNodes('leases', { eq: { id: 'u1' } }, { join: 'left' });
        assert.deepEqual(withNodes[0]!['rent'], { amount: '100', currency: 'USD' });
    });

    console.log('\nmoney aggregates');
    await test('aggregateMoney sums exact decimals within one currency (0.1 + 0.2 = 0.3)', async () => {
        await t.createTable({ name: 'ledger', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'amt', type: 'money' }, { name: 'kind', type: 'string' }] });
        await t.insertBatch('ledger', [
            { id: '1', amt: { amount: '0.1', currency: 'USD' }, kind: 'a' }, { id: '2', amt: { amount: '0.2', currency: 'USD' }, kind: 'a' },
            { id: '3', amt: { amount: '7', currency: 'EUR' }, kind: 'b' }, { id: '4', kind: 'a' },
        ]);
        assert.deepEqual(await t.aggregateMoney('ledger', 'amt', 'sum', { eq: { amt__currency: 'USD' } }), { amount: '0.3', currency: 'USD', count: 2 });
        assert.deepEqual(await t.aggregateMoney('ledger', 'amt', 'max', { eq: { amt__currency: 'USD' } }), { amount: '0.2', currency: 'USD', count: 2 });
        assert.deepEqual(await t.aggregateMoney('ledger', 'amt', 'min', { eq: { amt__currency: 'USD' } }), { amount: '0.1', currency: 'USD', count: 2 });
        const avg = await t.aggregateMoney('ledger', 'amt', 'avg', { eq: { amt__currency: 'USD' } });
        assert.equal(Number(avg!.amount), 0.15);
        assert.equal(await t.aggregateMoney('ledger', 'amt', 'sum', { eq: { kind: 'zzz' } }), null, 'no rows -> null, not 0');
    });
    await test('aggregateMoney REFUSES mixed currencies with a typed error naming them', async () => {
        for (const agg of ['sum', 'avg', 'min', 'max'] as const) {
            try { await t.aggregateMoney('ledger', 'amt', agg); assert.fail(`${agg} should refuse`); } catch (e) {
                assert.ok(e instanceof MixedCurrencyError, `${agg}: ${(e as Error).stack}`);
                assert.equal(e.code, 'mixed_currency'); assert.equal(e.column, 'amt');
                assert.deepEqual(e.currencies, ['EUR', 'USD']);
                assert.match(e.message, /refusing to aggregate money column 'amt' across currencies \(EUR, USD\)/);
            }
        }
        assert.deepEqual(await t.aggregateMoney('ledger', 'amt', 'sum', { eq: { kind: 'b' } }), { amount: '7', currency: 'EUR', count: 1 });
    });
    await test('aggregateMoney rejects a non-money column and an unknown aggregate', async () => {
        await rejects(t.aggregateMoney('ledger', 'kind', 'sum'), /'kind' is not a money column/);
        await rejects(t.aggregateMoney('ledger', 'amt', 'median' as never), /unsupported aggregate/);
    });

    console.log('\nschema evolution');
    await test('evolveSchema adds an optional money column; a required one on a non-empty table is refused', async () => {
        const steps = await t.evolveSchema('ledger', { name: 'ledger', columns: [...(await t.listTables()).length ? t.schemas.get('ledger')!.columns : [], { name: 'fee', type: 'money' }] });
        assert.deepEqual(steps.map(s => s.kind), ['add_column']);
        await t.update('ledger', { eq: { id: '1' } }, { fee: { amount: '2.5', currency: 'USD' } });
        assert.deepEqual((await t.getByKey('ledger', '1'))!['fee'], { amount: '2.5', currency: 'USD' });
        assert.equal((await t.getByKey('ledger', '2'))!['fee'], null);
        await rejects(t.evolveSchema('ledger', { name: 'ledger', columns: [...t.schemas.get('ledger')!.columns, { name: 'must', type: 'money', required: true }] }), /no honest backfill default/);
    });

    console.log('\nSQLite');
    await test('SQLite refuses a money column clearly and leaves no half-created table', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sqlite-money-'));
        try {
            const s = new SqliteTableStorage(path.join(dir, 'tables.sqlite'), path.join(dir, 'schemas.json'));
            await rejects(s.createTable({ name: 'm', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'p', type: 'money' }] }), /money.*not supported on SQLite yet/);
            assert.deepEqual(await s.listTables(), []);
            await s.createTable({ name: 'ok', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'n', type: 'integer' }] });
            await s.insert('ok', { id: 'x', n: 1 });
            assert.deepEqual(await s.getByKey('ok', 'x'), { id: 'x', n: 1 });
            await rejects(s.evolveSchema('ok', { name: 'ok', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'n', type: 'integer' }, { name: 'p', type: 'money' }] }), /not supported on SQLite yet/);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    console.log('\nprovenance');
    const PROV = { sourceDocumentId: 'doc-1', sourcePage: 3, verifiedQuote: 'Monthly rent: $2,000.00', confidence: 0.92, needsReview: true, extractor: 'ai-api/1.4+m:abc', contract: 'B/1', extractedAt: '2026-10-01T12:00:00Z' };
    const STORED = { sourceDocumentId: 'doc-1', sourcePage: 3, verifiedQuote: 'Monthly rent: $2,000.00', confidence: 0.92, needsReview: true, extractor: 'ai-api/1.4+m:abc', contract: 'B/1', extractedAt: '2026-10-01T12:00:00.000Z', reviewedBy: null, reviewedAt: null };
    await t.createTable({ name: 'docs', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'rent', type: 'money' }, { name: 'term', type: 'integer' }, { name: 'note', type: 'string' }] });
    await test('a plain write stores no provenance and reads are byte-identical (no _provenance key)', async () => {
        await t.insert('docs', { id: 'p0', rent: { amount: '1', currency: 'USD' }, term: 12 });
        const r = await t.getByKey('docs', 'p0');
        assert.deepEqual(r, { id: 'p0', rent: { amount: '1', currency: 'USD' }, term: 12, note: null });
        assert.equal('_provenance' in r!, false);
        assert.equal((await t.query('docs')).every(x => !('_provenance' in x)), true);
        const cnt = await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value WHERE workspace_id = $1 AND (source_document_id IS NOT NULL OR needs_review IS NOT NULL OR confidence IS NOT NULL)`, [WS]);
        assert.equal(cnt[0]!.c, '0');
    });
    await test('insert with provenance; only the opted-in read returns it, keyed by column', async () => {
        await t.insert('docs', { id: 'p1', rent: { amount: '2000', currency: 'USD' }, term: 36 }, { provenance: { rent: PROV } });
        const plain = await t.getByKey('docs', 'p1');
        assert.equal('_provenance' in plain!, false);
        const withP = await t.getByKey('docs', 'p1', { provenance: true });
        assert.deepEqual(withP!['_provenance'], { rent: STORED });
        assert.deepEqual(withP!['rent'], { amount: '2000', currency: 'USD' });
        const viaQuery = await t.query('docs', { eq: { id: 'p1' } }, { provenance: true });
        assert.deepEqual(viaQuery[0]!['_provenance'], { rent: STORED });
        const noneHere = await t.getByKey('docs', 'p0', { provenance: true });
        assert.deepEqual(noneHere!['_provenance'], {});
    });
    await test('insertBatch carries per-row provenance (some rows with, some without)', async () => {
        await t.insertBatch('docs', [{ id: 'b1', term: 1 }, { id: 'b2', term: 2 }, { id: 'b3', term: 3 }], {
            provenance: [{ term: { sourceDocumentId: 'd9', confidence: 0.5 } }, undefined, { term: { sourceDocumentId: 'd10', needsReview: false } }],
        });
        const rows = await t.query('docs', { in: { id: ['b1', 'b2', 'b3'] } }, { provenance: true });
        assert.equal((rows[0]!['_provenance'] as Record<string, { sourceDocumentId: string }>)['term']!.sourceDocumentId, 'd9');
        assert.deepEqual(rows[1]!['_provenance'], {});
        assert.equal((rows[2]!['_provenance'] as Record<string, { needsReview: boolean }>)['term']!.needsReview, false);
    });
    await test('validation: bad confidence, bad page, unknown field, wrong target column, reserved column, bad date', async () => {
        const row = { id: 'v', term: 1 };
        await rejects(t.insert('docs', row, { provenance: { term: { confidence: 1.5 } } }), /confidence .* between 0 and 1/);
        await rejects(t.insert('docs', row, { provenance: { term: { sourcePage: -1 } } }), /sourcePage .* non-negative integer/);
        await rejects(t.insert('docs', row, { provenance: { term: { needsReview: 'yes' as never } } }), /needsReview .* boolean/);
        await rejects(t.insert('docs', row, { provenance: { term: { nope: 1 } as never } }), /unknown provenance field 'nope'/);
        await rejects(t.insert('docs', row, { provenance: { note: { confidence: 0.5 } } }), /no value is being written to it/);
        await rejects(t.insert('docs', row, { provenance: { ghost: { confidence: 0.5 } } }), /unknown column 'ghost'/);
        await rejects(t.insert('docs', row, { provenance: { term: { extractedAt: 'yesterday-ish' } } }), /not a valid date/);
        assert.equal(await t.getByKey('docs', 'v'), null, 'a rejected write leaves nothing behind');
    });
    await test('update with provenance writes a new version even for an unchanged value; plain unchanged update does not', async () => {
        const count = async (): Promise<number> => Number((await q<{ c: string }>(
            `SELECT count(*)::text AS c FROM lore_entity_value v JOIN lore_entity e ON e.workspace_id = v.workspace_id AND e.entity_id = v.entity_id
              JOIN lore_field_def f ON f.workspace_id = v.workspace_id AND f.field_id = v.field_id WHERE e.workspace_id = $1 AND e.pk_text = 'p1' AND f.name = 'term'`, [WS]))[0]!.c);
        assert.equal(await count(), 1);
        await t.update('docs', { eq: { id: 'p1' } }, { term: 36 });
        assert.equal(await count(), 1);
        await t.update('docs', { eq: { id: 'p1' } }, { term: 36 }, { provenance: { term: { reviewedBy: 'rafi', reviewedAt: '2026-10-05T00:00:00Z', needsReview: false } } });
        assert.equal(await count(), 2);
        const r = await t.getByKey('docs', 'p1', { provenance: true });
        const term = (r!['_provenance'] as Record<string, Record<string, unknown>>)['term']!;
        assert.equal(term['reviewedBy'], 'rafi'); assert.equal(term['needsReview'], false);
        await rejects(t.update('docs', { eq: { id: 'p1' } }, { term: 1 }, { provenance: { note: { confidence: 0.1 } } }), /no value is being written to it/);
        await rejects(t.update('docs', { eq: { id: 'p1' } }, { term: null }, { provenance: { term: { confidence: 0.1 } } }), /no value is being written to it/);
    });
    await test('provenance is workspace-scoped: the same table + key elsewhere shows none, and rows never cross', async () => {
        await other.createTable({ name: 'docs', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'rent', type: 'money' }, { name: 'term', type: 'integer' }, { name: 'note', type: 'string' }] });
        await other.insert('docs', { id: 'p1', term: 1 });
        const r = await other.getByKey('docs', 'p1', { provenance: true });
        assert.deepEqual(r!['_provenance'], {});
        await other.insert('docs', { id: 'o2', term: 2 }, { provenance: { term: { sourceDocumentId: 'other-doc' } } });
        assert.equal(((await t.getByKey('docs', 'o2', { provenance: true })) === null), true);
        const mine = await q<{ ws: string; c: string }>(`SELECT workspace_id AS ws, count(*)::text AS c FROM lore_entity_value WHERE source_document_id = 'other-doc' GROUP BY 1`);
        assert.deepEqual(mine, [{ ws: WS2, c: '1' }]);
    });

    console.log('\nrecorded-time as-of');
    await t.createTable({ name: 'contracts', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'rent', type: 'money' }, { name: 'status', type: 'string' }, { name: '_valid_from', type: 'datetime' }, { name: '_valid_to', type: 'datetime' }] });
    const T: Record<string, string> = {};
    await test('set up: three recorded versions of one contract and a later second contract', async () => {
        T['before'] = await dbNow();
        await t.insert('contracts', { id: 'k1', rent: { amount: '100', currency: 'USD' }, status: 'draft', _valid_from: '2026-01-01T00:00:00Z', _valid_to: '2027-01-01T00:00:00Z' }, { provenance: { rent: { sourceDocumentId: 'v1' } } });
        T['t1'] = await dbNow();
        await t.update('contracts', { eq: { id: 'k1' } }, { rent: { amount: '120', currency: 'USD' }, status: 'signed' }, { provenance: { rent: { sourceDocumentId: 'v2' } } });
        T['t2'] = await dbNow();
        await t.update('contracts', { eq: { id: 'k1' } }, { status: 'amended' });
        T['t3'] = await dbNow();
        await t.insert('contracts', { id: 'k2', rent: { amount: '999', currency: 'USD' }, status: 'new', _valid_from: '2026-01-01T00:00:00Z' });
        T['t4'] = await dbNow();
    });
    await test('recorded time returns each value as it stood then', async () => {
        const at = async (when: string): Promise<Array<[unknown, unknown]>> => (await t.queryAsOf('contracts', T[when]!, undefined, { time: 'recorded' })).map(r => [(r['rent'] as { amount: string } | null)?.amount, r['status']]);
        assert.deepEqual(await at('before'), []);
        assert.deepEqual(await at('t1'), [['100', 'draft']]);
        assert.deepEqual(await at('t2'), [['120', 'signed']]);
        assert.deepEqual(await at('t3'), [['120', 'amended']]);
        assert.deepEqual(await at('t4'), [['120', 'amended'], ['999', 'new']], 'a row inserted later appears only from then on');
    });
    await test('recorded time respects filters, ordering and LIMIT as SQL (no page filtering)', async () => {
        const r = await t.queryAsOf('contracts', T['t2']!, { eq: { status: 'signed' } }, { time: 'recorded' });
        assert.deepEqual(r.map(x => x['id']), ['k1']);
        assert.deepEqual(await t.queryAsOf('contracts', T['t2']!, { eq: { status: 'amended' } }, { time: 'recorded' }), [], 'the later status is not visible then');
        const both = await t.queryAsOf('contracts', T['t4']!, undefined, { time: 'recorded', orderBy: 'rent', orderDir: 'desc', limit: 1 });
        assert.deepEqual(both.map(x => x['id']), ['k2']);
        assert.deepEqual((await t.queryAsOf('contracts', T['t1']!, { eq: { rent__currency: 'USD' } }, { time: 'recorded' })).map(x => x['id']), ['k1']);
    });
    await test('valid time stays the default; recorded + validAt is the bitemporal read', async () => {
        const valid = await t.queryAsOf('contracts', '2026-06-01T00:00:00Z');
        assert.deepEqual(valid.map(r => r['id']), ['k1', 'k2'], 'default is valid time, and sees CURRENT values');
        assert.equal(valid[0]!['status'], 'amended');
        assert.deepEqual((await t.queryAsOf('contracts', '2027-06-01T00:00:00Z')).map(r => r['id']), ['k2'], 'k1 ended 2027-01-01');
        const explicit = await t.queryAsOf('contracts', '2026-06-01T00:00:00Z', undefined, { time: 'valid' });
        assert.deepEqual(explicit, valid);
        const bi = await t.queryAsOf('contracts', T['t2']!, undefined, { time: 'recorded', validAt: '2027-06-01T00:00:00Z' });
        assert.deepEqual(bi, [], 'as known at t2, k1 was not valid in mid-2027');
        const bi2 = await t.queryAsOf('contracts', T['t4']!, undefined, { time: 'recorded', validAt: '2027-06-01T00:00:00Z' });
        assert.deepEqual(bi2.map(r => r['id']), ['k2']);
    });
    await test('option misuse is refused: unknown time, validAt without recorded', async () => {
        await rejects(t.queryAsOf('contracts', T['t1']!, undefined, { time: 'knowledge' as never }), /time must be 'valid' or 'recorded'/);
        await rejects(t.queryAsOf('contracts', T['t1']!, undefined, { validAt: '2026-01-01' }), /validAt applies only with time 'recorded'/);
        await rejects(t.queryAsOf('contracts', 'not-a-date', undefined, { time: 'recorded' }), /asOf/);
    });
    await test('recorded reads carry the provenance known at that instant', async () => {
        const r1 = await t.queryAsOf('contracts', T['t1']!, { eq: { id: 'k1' } }, { time: 'recorded', provenance: true });
        assert.equal((r1[0]!['_provenance'] as Record<string, { sourceDocumentId: string }>)['rent']!.sourceDocumentId, 'v1');
        const r2 = await t.queryAsOf('contracts', T['t3']!, { eq: { id: 'k1' } }, { time: 'recorded', provenance: true });
        assert.equal((r2[0]!['_provenance'] as Record<string, { sourceDocumentId: string }>)['rent']!.sourceDocumentId, 'v2');
        const now = await t.getByKey('contracts', 'k1', { provenance: true });
        assert.equal((now!['_provenance'] as Record<string, { sourceDocumentId: string }>)['rent']!.sourceDocumentId, 'v2');
    });
    await test('queryWithNodes accepts the same time option', async () => {
        const r = await t.queryWithNodes('contracts', undefined, { asOf: T['t1']!, time: 'recorded', join: 'left' });
        assert.deepEqual(r.map(x => [x['id'], x['status']]), [['k1', 'draft']]);
    });
    await test('aggregateMoney can be asked in recorded time too', async () => {
        assert.deepEqual(await t.aggregateMoney('contracts', 'rent', 'sum', undefined, { asOf: T['t1']!, time: 'recorded' }), { amount: '100', currency: 'USD', count: 1 });
        assert.deepEqual(await t.aggregateMoney('contracts', 'rent', 'sum', undefined, { asOf: T['t4']!, time: 'recorded' }), { amount: '1119', currency: 'USD', count: 2 });
    });
    await test('recorded reads are workspace-scoped', async () => {
        await other.createTable({ name: 'contracts', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'rent', type: 'money' }, { name: 'status', type: 'string' }, { name: '_valid_from', type: 'datetime' }, { name: '_valid_to', type: 'datetime' }] });
        assert.deepEqual(await other.queryAsOf('contracts', T['t4']!, undefined, { time: 'recorded' }), []);
        await other.insert('contracts', { id: 'k1', status: 'other' });
        const r = await other.queryAsOf('contracts', await dbNow(), undefined, { time: 'recorded' });
        assert.deepEqual(r.map(x => x['status']), ['other']);
        assert.equal((await t.queryAsOf('contracts', T['t4']!, undefined, { time: 'recorded' })).some(x => x['status'] === 'other'), false);
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

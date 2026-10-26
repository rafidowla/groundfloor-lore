#!/usr/bin/env tsx
/**
 * test/pg-tables-upgrade-unit.ts - a slice-1 (3.36.0) shaped tables schema upgrades IN PLACE to slice 2.
 *
 * Builds a database, then strips every slice-2 addition (money + provenance columns, constraint, indexes, link
 * tables) to recreate the 3.36.0 shape with data in it, re-opens, and asserts: old rows intact and readable,
 * provenance null, new features usable, and a further re-open is a no-op. Throwaway DB `lore_gate_tbl_upgrade`.
 * Run: npx tsx test/pg-tables-upgrade-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_tbl_upgrade';
const WS = 'pg-gate-upgrade-a';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const gate = gateDbUrl();
if (!gate) { console.log('SKIP pg-tables-upgrade: LORE_PG_URL is not set - postgres cases skipped cleanly'); process.exit(0); }
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}

await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const SLICE2_COLS = ['v_amount', 'v_currency', 'source_document_id', 'source_page', 'verified_quote', 'confidence', 'needs_review', 'extractor', 'contract', 'extracted_at', 'reviewed_by', 'reviewed_at'];
const cols = async (): Promise<string[]> => (await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'lore_entity_value'`)).map(r => r.column_name);
const tableExists = async (n: string): Promise<boolean> => (await q(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [n])).length > 0;

try {
    const v1 = await PostgresTableStorage.open(WS, pool);
    await v1.createTable({ name: 'units', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'beds', type: 'integer' }, { name: 'note', type: 'string' }] });
    await v1.insertBatch('units', [{ id: 'a', beds: 1, note: 'old' }, { id: 'b', beds: 2 }]);
    await v1.update('units', { eq: { id: 'a' } }, { beds: 3 });

    // Recreate the 3.36.0 shape: no link tables, none of the slice-2 columns / constraint / indexes.
    await q('DROP TABLE IF EXISTS lore_entity_link, lore_link_type CASCADE');
    for (const c of SLICE2_COLS) await q(`ALTER TABLE lore_entity_value DROP COLUMN IF EXISTS ${c} CASCADE`);
    await q('DROP INDEX IF EXISTS lore_ev_source_doc_idx, lore_ev_review_idx');

    await test('the stripped database really has the slice-1 shape', async () => {
        assert.equal(await tableExists('lore_link_type'), false);
        assert.equal(await tableExists('lore_entity_link'), false);
        assert.equal((await cols()).some(c => SLICE2_COLS.includes(c)), false);
    });

    const v2 = await PostgresTableStorage.open(WS, pool);
    await test('re-opening upgrades in place: new columns and link tables appear, existing rows are untouched', async () => {
        const have = await cols();
        for (const c of SLICE2_COLS) assert.ok(have.includes(c), `missing ${c}`);
        assert.equal(await tableExists('lore_link_type'), true);
        assert.equal(await tableExists('lore_entity_link'), true);
        assert.deepEqual(await v2.query('units', undefined, { orderBy: 'id' }), [{ id: 'a', beds: 3, note: 'old' }, { id: 'b', beds: 2, note: null }]);
        const withProv = await v2.query('units', { eq: { id: 'a' } }, { provenance: true });
        assert.deepEqual(withProv[0]!['_provenance'], {}, 'pre-existing values carry no provenance');
        assert.equal(Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value WHERE workspace_id = $1 AND source_document_id IS NOT NULL`, [WS]))[0]!.c), 0);
    });
    await test('slice-2 features work on the upgraded database: money column, provenance, links, recorded time', async () => {
        const steps = await v2.evolveSchema('units', { name: 'units', columns: [...v2.schemas.get('units')!.columns, { name: 'rent', type: 'money' }] });
        assert.deepEqual(steps.map(s => s.kind), ['add_column']);
        await v2.update('units', { eq: { id: 'a' } }, { rent: { amount: '1500.00', currency: 'usd' } }, { provenance: { rent: { sourceDocumentId: 'lease-1', confidence: 0.9 } } });
        const row = await v2.getByKey('units', 'a', { provenance: true });
        assert.deepEqual(row!['rent'], { amount: '1500.00', currency: 'USD' });
        assert.equal((row!['_provenance'] as Record<string, { sourceDocumentId: string }>)['rent']!.sourceDocumentId, 'lease-1');
        await v2.createTable({ name: 'tenants', columns: [{ name: 'id', type: 'string', primary: true }] });
        await v2.insert('tenants', { id: 'T' });
        await v2.defineLinkType({ name: 'occupies', fromTable: 'tenants', toTable: 'units', cardinality: 'one_to_many' });
        const link = await v2.addLink({ linkType: 'occupies', from: { table: 'tenants', key: 'T' }, to: { table: 'units', key: 'a' } });
        assert.ok(link.linkId);
        assert.equal((await v2.listLinks({ table: 'units', key: 'a' })).length, 1);
        assert.ok((await v2.queryAsOf('units', new Date().toISOString(), undefined, { time: 'recorded' })).length >= 2);
    });
    await test('a further re-open is an idempotent no-op that keeps all data', async () => {
        const before = (await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c;
        const v3 = await PostgresTableStorage.open(WS, pool);
        await PostgresTableStorage.open(WS, pool);
        assert.equal((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c, before);
        assert.equal((await v3.listLinks({ table: 'units', key: 'a' })).length, 1);
        assert.deepEqual((await v3.getByKey('units', 'a'))!['rent'], { amount: '1500.00', currency: 'USD' });
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

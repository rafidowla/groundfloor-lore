#!/usr/bin/env tsx
/**
 * test/pg-tables-review-upgrade-unit.ts - a 3.36.0 / main shaped tables schema upgrades IN PLACE to the review queue +
 * alias table (Wave D lane d3). Every addition is IF NOT EXISTS.
 *
 * Builds a database with data and provenance, strips the d3 additions (lore_table_settings, lore_entity_alias, the
 * supersedes_value_id column, the unreviewed index) to recreate the previous shape, re-opens, and asserts: old rows and
 * provenance intact, the new objects exist, review / alias features work on the old data, and a further re-open is a
 * no-op. Throwaway DB `lore_gate_tbl_review_upg`. Run: npx tsx test/pg-tables-review-upgrade-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_tbl_review_upg';
const WS = 'pg-gate-review-upg';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const gate = gateDbUrl();
if (!gate) { console.log('SKIP pg-tables-review-upgrade: LORE_PG_URL is not set - postgres cases skipped cleanly'); process.exit(0); }
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
const tableExists = async (n: string): Promise<boolean> => (await q(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [n])).length > 0;
const hasColumn = async (n: string): Promise<boolean> => (await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'lore_entity_value' AND column_name = $1`, [n])).length > 0;
const hasIndex = async (n: string): Promise<boolean> => (await q(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [n])).length > 0;
const prov = { sourceDocumentId: 'doc-1', sourcePage: 1, verifiedQuote: 'q', confidence: 0.5, extractor: 'x/1', extractedAt: '2026-10-01T00:00:00Z' };

try {
    const v1 = await PostgresTableStorage.open(WS, pool);
    await v1.createTable({ name: 'units', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'owner', type: 'string' }, { name: 'beds', type: 'integer' }] });
    await v1.insertBatch('units', [{ id: 'a', owner: 'Acme', beds: 1 }, { id: 'b', owner: 'Beta', beds: 2 }], { provenance: [{ owner: prov }, undefined] });
    await v1.update('units', { eq: { id: 'a' } }, { beds: 3 });

    // Recreate the previous shape.
    await q('DROP TABLE IF EXISTS lore_entity_alias, lore_table_settings CASCADE');
    await q('DROP INDEX IF EXISTS lore_ev_unreviewed_idx');
    await q('ALTER TABLE lore_entity_value DROP COLUMN IF EXISTS supersedes_value_id CASCADE');
    const valueRows = Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c);

    await test('the stripped database really has the previous shape', async () => {
        assert.equal(await tableExists('lore_entity_alias'), false);
        assert.equal(await tableExists('lore_table_settings'), false);
        assert.equal(await hasColumn('supersedes_value_id'), false);
        assert.equal(await hasIndex('lore_ev_unreviewed_idx'), false);
    });
    const v2 = await PostgresTableStorage.open(WS, pool);
    await test('re-opening upgrades in place: new table, settings, column and indexes appear; no value row is touched', async () => {
        assert.equal(await tableExists('lore_entity_alias'), true);
        assert.equal(await tableExists('lore_table_settings'), true);
        assert.equal(await hasColumn('supersedes_value_id'), true);
        assert.equal(await hasIndex('lore_ev_unreviewed_idx'), true);
        assert.equal(await hasIndex('lore_alias_open_uq'), true);
        assert.equal(Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c), valueRows);
        assert.deepEqual(await v2.query('units', undefined, { orderBy: 'id' }), [{ id: 'a', owner: 'Acme', beds: 3 }, { id: 'b', owner: 'Beta', beds: 2 }]);
        const pv = await v2.getByKey('units', 'a', { provenance: true });
        assert.equal((pv!['_provenance'] as Record<string, { sourceDocumentId: string }>)['owner']!.sourceDocumentId, 'doc-1');
        assert.equal((await q(`SELECT 1 FROM lore_entity_value WHERE supersedes_value_id IS NOT NULL`)).length, 0, 'old rows have no lineage');
    });
    await test('review and alias features work on the pre-existing data', async () => {
        const api = v2.reviewApi();
        assert.equal((await api.getSettings()).reviewConfidenceThreshold, 0.8);
        const queue = await api.listQueue();
        assert.deepEqual(queue.items.map(i => `${i.rowKey}.${i.field}`), ['a.owner'], 'old low-confidence value (0.5) is in the queue');
        const out = await api.confirm({ valueId: queue.items[0]!.valueId, reviewer: 'alice' });
        assert.equal(out.idempotent, false);
        assert.equal((await api.listQueue()).items.length, 0);
        assert.equal((await api.addAlias({ table: 'units', field: 'owner', canonical: 'Acme', alias: 'ACME Inc' })).created, true);
        assert.equal((await v2.getByKey('units', 'a'))!['owner'], 'Acme');
    });
    await test('a further re-open is an idempotent no-op that keeps everything', async () => {
        const rows = (await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c;
        const aliases = (await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_alias`))[0]!.c;
        const v3 = await PostgresTableStorage.open(WS, pool);
        await PostgresTableStorage.open(WS, pool);
        assert.equal((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_value`))[0]!.c, rows);
        assert.equal((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_alias`))[0]!.c, aliases);
        assert.equal((await v3.reviewApi().listAliases()).items.length, 2);
        assert.equal((await v3.reviewApi().getSettings()).reviewConfidenceThreshold, 0.8);
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

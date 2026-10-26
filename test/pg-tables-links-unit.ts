#!/usr/bin/env tsx
/**
 * test/pg-tables-links-unit.ts - typed record links on PostgresTableStorage (Tables P1, slice 2).
 *
 *   link types   define / idempotent redefine / conflict / bad input
 *   links        add, list (direction, type filter), soft close (never deletes), valid-time as-of, includeClosed
 *   cardinality  one_to_one / one_to_many / many_to_one / many_to_many enforced by the database, including a
 *                concurrent race that only the unique indexes can win
 *   isolation    a second workspace sees none of the first workspace's link types or links, and cannot link its rows
 *   lifecycle    deleting a row removes its links; closing keeps them
 *
 * Throwaway database `lore_gate_tbl_links` on the LORE_PG_URL server (skips with a printed reason when unset).
 * Run: npx tsx test/pg-tables-links-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresTableStorage, TableLinkError } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_tbl_links';
const WS = 'pg-gate-links-a';
const WS2 = 'pg-gate-links-b';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const gate = gateDbUrl();
if (!gate) { console.log('SKIP pg-tables-links: LORE_PG_URL is not set - postgres cases skipped cleanly'); process.exit(0); }
const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
async function admin(sql: string): Promise<void> {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
const linkErr = async (p: Promise<unknown>, code: string, re?: RegExp): Promise<void> => {
    try { await p; } catch (e) {
        assert.ok(e instanceof TableLinkError, `expected TableLinkError, got ${(e as Error).stack}`);
        assert.equal(e.code, code);
        if (re) assert.match(e.message, re);
        return;
    }
    assert.fail(`expected TableLinkError(${code})`);
};

const TENANTS: TableSchema = { name: 'tenants', columns: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }] };
const LEASES: TableSchema = { name: 'leases', columns: [{ name: 'id', type: 'integer', primary: true }, { name: 'unit', type: 'string' }] };
const COIS: TableSchema = { name: 'cois', columns: [{ name: 'id', type: 'string', primary: true }] };

await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);
const pool: Pool = createPostgresPool({ url: dbUrl.toString() });
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

try {
    const t = await PostgresTableStorage.open(WS, pool);
    const other = await PostgresTableStorage.open(WS2, pool);
    await t.createTable(TENANTS); await t.createTable(LEASES); await t.createTable(COIS);
    await t.insertBatch('tenants', [{ id: 't1', name: 'Acme' }, { id: 't2', name: 'Bolt' }, { id: 't3', name: 'Cora' }]);
    await t.insertBatch('leases', [{ id: 1, unit: 'A1' }, { id: 2, unit: 'A2' }, { id: 3, unit: 'A3' }]);
    await t.insertBatch('cois', [{ id: 'c1' }, { id: 'c2' }]);

    console.log('\nlink types');
    await test('define, list, idempotent redefine', async () => {
        const a = await t.defineLinkType({ name: 'tenant_leases', fromTable: 'tenants', toTable: 'leases', cardinality: 'one_to_many', description: 'a tenant holds leases' });
        assert.deepEqual({ ...a, createdAt: undefined }, { name: 'tenant_leases', fromTable: 'tenants', toTable: 'leases', cardinality: 'one_to_many', description: 'a tenant holds leases', createdAt: undefined });
        const b = await t.defineLinkType({ name: 'tenant_leases', fromTable: 'tenants', toTable: 'leases', cardinality: 'one_to_many' });
        assert.equal(b.createdAt, a.createdAt);
        assert.deepEqual((await t.listLinkTypes()).map(x => x.name), ['tenant_leases']);
    });
    await test('redefining with a different shape is link_type_conflict; bad input is invalid_argument; unknown table throws', async () => {
        await linkErr(t.defineLinkType({ name: 'tenant_leases', fromTable: 'tenants', toTable: 'leases', cardinality: 'many_to_many' }), 'link_type_conflict');
        await linkErr(t.defineLinkType({ name: 'tenant_leases', fromTable: 'leases', toTable: 'tenants', cardinality: 'one_to_many' }), 'link_type_conflict');
        await linkErr(t.defineLinkType({ name: 'bad name!', fromTable: 'tenants', toTable: 'leases', cardinality: 'one_to_many' }), 'invalid_argument');
        await linkErr(t.defineLinkType({ name: 'x', fromTable: 'tenants', toTable: 'leases', cardinality: 'sideways' as never }), 'invalid_argument');
        await assert.rejects(t.defineLinkType({ name: 'x', fromTable: 'tenants', toTable: 'nope', cardinality: 'one_to_one' }), /unknown table 'nope'/);
    });

    console.log('\nlinks');
    let l1 = ''; let l2 = '';
    await test('addLink returns an id; listLinks sees it from both ends with decoded keys', async () => {
        l1 = (await t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't1' }, to: { table: 'leases', key: 1 }, origin: 'extractor', policyVersion: 'p7', modelFingerprint: 'm:abc', confidence: 0.9 })).linkId;
        l2 = (await t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't1' }, to: { table: 'leases', key: 2 } })).linkId;
        const out = await t.listLinks({ table: 'tenants', key: 't1' }, { direction: 'out' });
        assert.deepEqual(out.map(x => x.linkId), [l1, l2]);
        assert.deepEqual(out[0]!.to, { table: 'leases', key: 1 });
        assert.deepEqual(out[0]!.from, { table: 'tenants', key: 't1' });
        assert.equal(out[0]!.origin, 'extractor'); assert.equal(out[0]!.policyVersion, 'p7');
        assert.equal(out[0]!.modelFingerprint, 'm:abc'); assert.equal(out[0]!.confidence, 0.9);
        assert.equal(out[1]!.origin, 'manual');
        const inn = await t.listLinks({ table: 'leases', key: 1 }, { direction: 'in' });
        assert.equal(inn.length, 1); assert.equal(inn[0]!.from.key, 't1');
        assert.equal((await t.listLinks({ table: 'leases', key: 1 })).length, 1, 'default direction is both');
        assert.equal((await t.listLinks({ table: 'leases', key: 1 }, { direction: 'out' })).length, 0);
        assert.deepEqual(await t.listLinks({ table: 'tenants', key: 'ghost' }), []);
    });
    await test('addLink validation: unknown type, wrong tables, unknown row, bad confidence, bad interval', async () => {
        await linkErr(t.addLink({ linkType: 'nope', from: { table: 'tenants', key: 't1' }, to: { table: 'leases', key: 3 } }), 'unknown_link_type');
        await linkErr(t.addLink({ linkType: 'tenant_leases', from: { table: 'leases', key: 1 }, to: { table: 'tenants', key: 't1' } }), 'invalid_argument', /tenants -> leases/);
        await linkErr(t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 'ghost' }, to: { table: 'leases', key: 3 } }), 'unknown_entity');
        await linkErr(t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't1' }, to: { table: 'leases', key: 99 } }), 'unknown_entity');
        await linkErr(t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't2' }, to: { table: 'leases', key: 3 }, confidence: 1.5 }), 'invalid_argument');
        await linkErr(t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't2' }, to: { table: 'leases', key: 3 }, validFrom: '2026-02-01', validTo: '2026-01-01' }), 'invalid_interval');
        await linkErr(t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't2' }, to: { table: 'leases', key: 3 }, validFrom: 'not a date' }), 'invalid_argument');
        assert.equal((await t.listLinks({ table: 'leases', key: 3 }, { includeClosed: true })).length, 0, 'nothing leaked from the failed adds');
    });
    await test('duplicate open link is duplicate_link', async () => {
        await linkErr(t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't1' }, to: { table: 'leases', key: 1 } }), 'duplicate_link');
    });
    await test('closeLink soft-invalidates: row survives, hidden by default, visible with includeClosed; second close is false', async () => {
        assert.equal(await t.closeLink(l1, '2026-06-01T00:00:00Z'), true);
        assert.equal(await t.closeLink(l1), false);
        assert.equal(await t.closeLink('999999'), false);
        const live = await t.listLinks({ table: 'tenants', key: 't1' });
        assert.deepEqual(live.map(x => x.linkId), [l2]);
        const all = await t.listLinks({ table: 'tenants', key: 't1' }, { includeClosed: true });
        assert.deepEqual(all.map(x => x.linkId), [l1, l2]);
        assert.equal(all[0]!.validTo, '2026-06-01T00:00:00.000Z');
        assert.equal((await q<{ c: string }>(`SELECT count(*)::text AS c FROM lore_entity_link WHERE workspace_id = $1`, [WS]))[0]!.c, '2');
    });
    await test('valid-time as-of: [validFrom, validTo) with the boundary excluded', async () => {
        const at = (d: string): Promise<string[]> => t.listLinks({ table: 'tenants', key: 't1' }, { asOf: d, linkType: 'tenant_leases' }).then(r => r.map(x => x.linkId));
        assert.deepEqual(await at('2026-05-31T23:59:59Z'), [l1, l2]);
        assert.deepEqual(await at('2026-06-01T00:00:00Z'), [l2], 'the closing instant is already outside the interval');
        const fut = (await t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't3' }, to: { table: 'leases', key: 3 }, validFrom: '2030-01-01', validTo: '2031-01-01' })).linkId;
        const open = (await t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't3' }, to: { table: 'leases', key: 3 }, validFrom: '2030-01-01' })).linkId;
        await linkErr(t.closeLink(open, '2029-01-01'), 'invalid_interval');
        assert.equal(await t.closeLink(open, '2030-02-01'), true);
        assert.equal(await t.closeLink(fut), false, 'a link that already has a validTo is closed (bounded) already');
        const t3 = (asOf?: string): Promise<string[]> => t.listLinks({ table: 'tenants', key: 't3' }, { linkType: 'tenant_leases', ...(asOf ? { asOf } : {}) }).then(r => r.map(x => x.linkId));
        assert.deepEqual(await t3(), [], 'not valid yet');
        assert.deepEqual(await t3('2030-01-15'), [fut, open].sort());
        assert.deepEqual(await t3('2030-06-01'), [fut], 'open one closed on 2030-02-01');
        assert.deepEqual(await t3('2031-01-01'), []);
    });
    await test('a closed link frees its slot: the same pair can be linked again', async () => {
        const again = await t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't1' }, to: { table: 'leases', key: 1 }, validFrom: '2026-06-01' });
        assert.notEqual(again.linkId, l1);
        const all = await t.listLinks({ table: 'tenants', key: 't1' }, { includeClosed: true, linkType: 'tenant_leases' });
        assert.equal(all.filter(x => x.to.key === 1).length, 2, 'history keeps both the closed and the reopened link');
    });

    console.log('\ncardinality');
    await test('one_to_many: a lease has at most one open tenant; a tenant may hold many', async () => {
        await linkErr(t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't2' }, to: { table: 'leases', key: 2 } }), 'cardinality', /already has an open link/);
        const ok = await t.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't2' }, to: { table: 'leases', key: 3 } });
        assert.ok(ok.linkId);
    });
    await test('many_to_one: a lease may have only one open insurance certificate', async () => {
        await t.defineLinkType({ name: 'lease_coi', fromTable: 'leases', toTable: 'cois', cardinality: 'many_to_one' });
        await t.addLink({ linkType: 'lease_coi', from: { table: 'leases', key: 1 }, to: { table: 'cois', key: 'c1' } });
        await linkErr(t.addLink({ linkType: 'lease_coi', from: { table: 'leases', key: 1 }, to: { table: 'cois', key: 'c2' } }), 'cardinality');
        await t.addLink({ linkType: 'lease_coi', from: { table: 'leases', key: 2 }, to: { table: 'cois', key: 'c1' } });
    });
    await test('one_to_one: both ends are exclusive', async () => {
        await t.defineLinkType({ name: 'tenant_primary_coi', fromTable: 'tenants', toTable: 'cois', cardinality: 'one_to_one' });
        await t.addLink({ linkType: 'tenant_primary_coi', from: { table: 'tenants', key: 't1' }, to: { table: 'cois', key: 'c1' } });
        await linkErr(t.addLink({ linkType: 'tenant_primary_coi', from: { table: 'tenants', key: 't1' }, to: { table: 'cois', key: 'c2' } }), 'cardinality');
        await linkErr(t.addLink({ linkType: 'tenant_primary_coi', from: { table: 'tenants', key: 't2' }, to: { table: 'cois', key: 'c1' } }), 'cardinality');
    });
    await test('many_to_many: unrestricted apart from the duplicate rule', async () => {
        await t.defineLinkType({ name: 'related', fromTable: 'tenants', toTable: 'tenants', cardinality: 'many_to_many' });
        for (const [a, b] of [['t1', 't2'], ['t1', 't3'], ['t2', 't3'], ['t3', 't1']]) {
            await t.addLink({ linkType: 'related', from: { table: 'tenants', key: a! }, to: { table: 'tenants', key: b! } });
        }
        await linkErr(t.addLink({ linkType: 'related', from: { table: 'tenants', key: 't1' }, to: { table: 'tenants', key: 't2' } }), 'duplicate_link');
        assert.equal((await t.listLinks({ table: 'tenants', key: 't1' }, { linkType: 'related' })).length, 3);
    });
    await test('concurrent adds of a competing one_to_one link: exactly one wins (database-level, not read-then-write)', async () => {
        await t.defineLinkType({ name: 'race', fromTable: 'tenants', toTable: 'leases', cardinality: 'one_to_one' });
        const attempts = [1, 2, 3].map(n => t.addLink({ linkType: 'race', from: { table: 'tenants', key: 't1' }, to: { table: 'leases', key: n } }).then(() => 'ok', (e: Error) => (e as TableLinkError).code));
        const res = await Promise.all(attempts);
        assert.equal(res.filter(r => r === 'ok').length, 1, JSON.stringify(res));
        assert.deepEqual(res.filter(r => r !== 'ok'), ['cardinality', 'cardinality']);
    });

    console.log('\nlifecycle');
    await test('deleting a row removes its links; closing alone does not', async () => {
        await t.insert('tenants', { id: 'tx', name: 'Temp' });
        await t.addLink({ linkType: 'related', from: { table: 'tenants', key: 'tx' }, to: { table: 'tenants', key: 't1' } });
        assert.equal((await t.listLinks({ table: 'tenants', key: 't1' }, { linkType: 'related', direction: 'in' })).length, 2);
        await t.delete('tenants', { eq: { id: 'tx' } });
        assert.equal((await t.listLinks({ table: 'tenants', key: 't1' }, { linkType: 'related', direction: 'in' })).length, 1);
    });

    console.log('\nworkspace isolation');
    await test('another workspace sees no link types and no links', async () => {
        assert.deepEqual(await other.listLinkTypes(), []);
        await other.createTable(TENANTS); await other.createTable(LEASES);
        await other.insertBatch('tenants', [{ id: 't1', name: 'Other Acme' }]);
        await other.insertBatch('leases', [{ id: 1, unit: 'X' }]);
        assert.deepEqual(await other.listLinks({ table: 'tenants', key: 't1' }, { includeClosed: true }), [], 'same table + key in another workspace has no links');
        await linkErr(other.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't1' }, to: { table: 'leases', key: 1 } }), 'unknown_link_type');
    });
    await test('same link-type name can exist independently in two workspaces, and each only links its own rows', async () => {
        await other.defineLinkType({ name: 'tenant_leases', fromTable: 'tenants', toTable: 'leases', cardinality: 'many_to_many' });
        await other.addLink({ linkType: 'tenant_leases', from: { table: 'tenants', key: 't1' }, to: { table: 'leases', key: 1 } });
        assert.equal((await other.listLinks({ table: 'tenants', key: 't1' })).length, 1);
        assert.equal((await t.listLinks({ table: 'tenants', key: 't1' }, { linkType: 'tenant_leases', includeClosed: true })).every(x => x.origin !== undefined), true);
        const cnt = await q<{ ws: string; c: string }>(`SELECT workspace_id AS ws, count(*)::text AS c FROM lore_entity_link GROUP BY 1 ORDER BY 1`);
        assert.equal(cnt.find(x => x.ws === WS2)!.c, '1');
        assert.equal(await other.closeLink((await other.listLinks({ table: 'tenants', key: 't1' }))[0]!.linkId), true);
    });
    await test('closeLink cannot reach a link that belongs to another workspace', async () => {
        const foreign = (await t.listLinks({ table: 'tenants', key: 't2' }, { linkType: 'tenant_leases' }))[0]!.linkId;
        assert.equal(await other.closeLink(foreign), false);
        assert.equal((await t.listLinks({ table: 'tenants', key: 't2' }, { linkType: 'tenant_leases' })).length, 1, 'still open in its own workspace');
    });
} finally {
    await closePostgresPool(pool).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

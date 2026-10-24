#!/usr/bin/env tsx
/**
 * test/pg-asof-columns-unit.ts - Postgres real date columns behind "as of" (valid-time) queries.
 *
 * Runs against a throwaway database `lore_gate_asof` created on the LORE_PG_URL server (skips with a printed
 * reason when LORE_PG_URL is unset).
 *
 *   schema       nodes.valid_from_at / valid_until_at are TIMESTAMPTZ; the (workspace_id, from, until) index exists
 *   writes       every write path fills the columns: upsert (insert + update + clear), insertNodeIfAbsent,
 *                upsertNodeAtRevision, importRaw, bulkUpsertNodes, commitNodeBatch (+ atomic supersede),
 *                supersedeNode / unsupersedeNode; a malformed text bound leaves the column NULL (= open)
 *   backfill     a legacy DB (columns dropped / emptied) is filled by the bootstrap, in small batches, malformed
 *                stays NULL; a second run updates 0 rows and rewrites nothing (row versions unchanged)
 *   predicate    the SQL path (listNodesValidAt) agrees with isValidAsOf on randomised windows and probe instants
 *
 * Run: npx tsx test/pg-asof-columns-unit.ts
 */
import assert from 'node:assert/strict';
import { Client, type Pool } from 'pg';

import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { backfillValidTimeColumns } from '../packages/lore/src/engines/postgres/postgresAsOfSchema.js';
import { isValidAsOf } from '../packages/lore/src/core/temporalQuery.js';
import { gateDbUrl } from './helpers/testPostgres.js';

const DB = 'lore_gate_asof';
const WS = 'pg-gate-asof';
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const gate = gateDbUrl();
if (!gate) {
    console.log('SKIP pg-asof-columns: LORE_PG_URL is not set - postgres cases skipped cleanly');
    process.exit(0);
}
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

const node = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}', ...over }) as never;
const open = async (): Promise<PostgresGraph> => { const g = new PostgresGraph(WS, pool); await g.initialize(); return g; };
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
interface Ts { id: string; f: string | null; u: string | null }
const ts = async (id: string): Promise<Ts> => (await q<Ts>(
    `SELECT id, to_char(valid_from_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS f,
            to_char(valid_until_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS u
       FROM nodes WHERE workspace_id = $1 AND id = $2`, [WS, id]))[0]!;

const F = '2026-01-01T00:00:00.000Z';
const U = '2026-06-01T00:00:00.000Z';

try {
    console.log('\nschema');
    const g = await open();
    await test('columns are timestamp with time zone and the leading-workspace index exists', async () => {
        const c = await q<{ column_name: string; data_type: string }>(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'nodes' AND column_name IN ('valid_from_at','valid_until_at') ORDER BY 1`);
        assert.deepEqual(c.map((r) => `${r.column_name}:${r.data_type}`), ['valid_from_at:timestamp with time zone', 'valid_until_at:timestamp with time zone']);
        const idx = await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = 'nodes' AND indexname = 'idx_nodes_valid_at'`);
        assert.equal(idx.length, 1);
        assert.match(idx[0]!.indexdef, /\(workspace_id, valid_from_at, valid_until_at\)/);
    });

    console.log('\nwrites');
    await test('upsertNode: insert, update, clear, offset form, malformed', async () => {
        await g.upsertNode(node('u1', { validFrom: F, validUntil: U }));
        assert.deepEqual(await ts('u1'), { id: 'u1', f: F, u: U });
        await g.upsertNode(node('u1', { validFrom: F, validUntil: '2026-07-01T00:00:00.000Z' }));
        assert.equal((await ts('u1')).u, '2026-07-01T00:00:00.000Z');
        await g.upsertNode(node('u1', {})); // omitted bounds keep the prior value (existing upsert semantics) - timestamps follow the text
        assert.deepEqual(await ts('u1'), { id: 'u1', f: F, u: '2026-07-01T00:00:00.000Z' });
        await g.upsertNode(node('u1', { validFrom: '', validUntil: '' })); // explicit empty clears both
        assert.deepEqual(await ts('u1'), { id: 'u1', f: null, u: null });
        await g.upsertNode(node('u2', { validFrom: '2026-05-01T01:00:00+01:00', validUntil: '2026-05-01T03:00:00+01:00' }));
        assert.deepEqual(await ts('u2'), { id: 'u2', f: '2026-05-01T00:00:00.000Z', u: '2026-05-01T02:00:00.000Z' });
        await g.upsertNode(node('u3', { validFrom: 'not-a-date', validUntil: U }));
        assert.deepEqual(await ts('u3'), { id: 'u3', f: null, u: U });
        assert.equal((await g.getNode('u3'))?.validFrom, 'not-a-date', 'the text bound still round-trips losslessly');
    });
    await test('insertNodeIfAbsent, upsertNodeAtRevision, bulkUpsertNodes, importRaw', async () => {
        await g.insertNodeIfAbsent(node('w1', { validFrom: F, validUntil: U }));
        assert.deepEqual(await ts('w1'), { id: 'w1', f: F, u: U });
        await g.upsertNodeAtRevision(node('w2', { validFrom: F }), 0, '2026-02-01T00:00:00.000Z');
        assert.deepEqual(await ts('w2'), { id: 'w2', f: F, u: null });
        await g.upsertNodeAtRevision(node('w2', { validFrom: F, validUntil: U }), 1, '2026-02-02T00:00:00.000Z');
        assert.deepEqual(await ts('w2'), { id: 'w2', f: F, u: U });
        await g.bulkUpsertNodes([node('w3', { validFrom: F }), node('w4', { validUntil: U })]);
        assert.deepEqual([await ts('w3'), await ts('w4')], [{ id: 'w3', f: F, u: null }, { id: 'w4', f: null, u: U }]);
        const now = '2026-03-01T00:00:00.000Z';
        await g.importRaw([{ ...(node('w5', { validFrom: F, validUntil: U }) as object), createdAt: now, updatedAt: now, syncedAt: now } as never], []);
        assert.deepEqual(await ts('w5'), { id: 'w5', f: F, u: U });
    });
    await test('commitNodeBatch (cas + insert) and the atomic supersede close the old node at supersededAt', async () => {
        const at = '2026-04-01T00:00:00.000Z';
        const out = await g.commitNodeBatch([], [
            { kind: 'insert', node: node('b1', { validFrom: F, validUntil: U }), updatedAt: at },
            { kind: 'insert', node: node('b-new', { validFrom: at }), updatedAt: at },
        ] as never, { successorId: 'b-new', reason: 'test', supersededAt: at, links: [{ targetId: 'w1', mark: true, edge: true }] });
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.deepEqual(await ts('b1'), { id: 'b1', f: F, u: U });
        assert.deepEqual(await ts('b-new'), { id: 'b-new', f: at, u: null });
        // w1 already had validUntil = U, so supersede must NOT move it (first close wins, matching the text column).
        const w1 = await g.getNode('w1');
        assert.equal(w1?.validUntil, U);
        assert.equal((await ts('w1')).u, U);
    });
    await test('supersedeNode closes an open node; unsupersedeNode reopens it (text and timestamp agree)', async () => {
        await g.upsertNode(node('s-old', { validFrom: F }));
        await g.upsertNode(node('s-new'));
        await g.supersedeNode('s-old', 's-new', 'newer');
        const closed = await g.getNode('s-old');
        assert.ok(closed?.validUntil, 'text validUntil set');
        const closedTs = await ts('s-old');
        assert.equal(closedTs.u, new Date(closed!.validUntil as string).toISOString());
        await g.unsupersedeNode('s-old');
        assert.deepEqual(await ts('s-old'), { id: 's-old', f: F, u: null });
    });
    await g.close();

    console.log('\nbackfill on an existing (legacy) database');
    await q('DELETE FROM edges WHERE workspace_id = $1', [WS]);
    await q('DELETE FROM nodes WHERE workspace_id = $1', [WS]);
    const g1 = await open();
    const N = 23;
    for (let i = 0; i < N; i++) {
        await g1.upsertNode(node(`L${i}`, i % 3 === 0 ? { validFrom: F, validUntil: U } : i % 3 === 1 ? { validFrom: F } : {}));
    }
    await g1.upsertNode(node('Lbad', { validFrom: 'garbage', validUntil: 'also garbage' }));
    await g1.upsertNode(node('Loff', { validFrom: '2026-05-01T01:00:00+01:00' }));
    await g1.close();
    // Legacy shape: the columns existed on no row.
    await q('UPDATE nodes SET valid_from_at = NULL, valid_until_at = NULL WHERE workspace_id = $1', [WS]);
    await test('precondition: every timestamp is empty', async () => {
        const n = await q<{ c: string }>('SELECT count(*) AS c FROM nodes WHERE workspace_id = $1 AND (valid_from_at IS NOT NULL OR valid_until_at IS NOT NULL)', [WS]);
        assert.equal(n[0]!.c, '0');
    });
    const client = await pool.connect();
    try {
        await test('the backfill (batch of 5) fills every parseable bound and returns the row count', async () => {
            const updated = await backfillValidTimeColumns(client, 5);
            assert.ok(updated === 17, `expected 17 rows updated (8 + 8 + the offset one), got ${updated}`);
            assert.deepEqual(await ts('L0'), { id: 'L0', f: F, u: U });
            assert.deepEqual(await ts('L1'), { id: 'L1', f: F, u: null });
            assert.deepEqual(await ts('L2'), { id: 'L2', f: null, u: null });
            assert.deepEqual(await ts('Loff'), { id: 'Loff', f: '2026-05-01T00:00:00.000Z', u: null });
            assert.deepEqual(await ts('Lbad'), { id: 'Lbad', f: null, u: null }, 'malformed stays NULL (= open)');
        });
        await test('a second run updates 0 rows and rewrites nothing (row versions unchanged)', async () => {
            const before = await q<{ ctid: string; xmin: string }>('SELECT ctid::text AS ctid, xmin::text AS xmin FROM nodes WHERE workspace_id = $1 ORDER BY id', [WS]);
            assert.equal(await backfillValidTimeColumns(client, 5), 0);
            assert.equal(await backfillValidTimeColumns(client), 0);
            const after = await q<{ ctid: string; xmin: string }>('SELECT ctid::text AS ctid, xmin::text AS xmin FROM nodes WHERE workspace_id = $1 ORDER BY id', [WS]);
            assert.deepEqual(after, before);
        });
    } finally { client.release(); }

    await test('a full re-bootstrap on the emptied columns restores them (the real startup path)', async () => {
        await q('UPDATE nodes SET valid_from_at = NULL, valid_until_at = NULL WHERE workspace_id = $1', [WS]);
        await q('ALTER TABLE nodes DROP COLUMN valid_from_at, DROP COLUMN valid_until_at');
        const g2 = await open();
        assert.deepEqual(await ts('L0'), { id: 'L0', f: F, u: U });
        assert.deepEqual(await ts('Lbad'), { id: 'Lbad', f: null, u: null });
        await g2.close();
    });

    console.log('\npredicate agrees with isValidAsOf');
    await q('DELETE FROM nodes WHERE workspace_id = $1', [WS]);
    const g3 = await open();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const day = 86_400_000;
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const docs: Array<{ id: string; vf?: string; vu?: string }> = [];
    for (let i = 0; i < 300; i++) {
        const r = rnd();
        const vf = r < 0.2 ? undefined : new Date(base + Math.floor(rnd() * 100) * day).toISOString();
        const vu = rnd() < 0.3 ? undefined : new Date(base + Math.floor(rnd() * 120) * day).toISOString();
        docs.push({ id: `r${i}`, vf, vu });
        await g3.upsertNode(node(`r${i}`, { ...(vf ? { validFrom: vf } : {}), ...(vu ? { validUntil: vu } : {}) }));
    }
    await test('300 random windows x probe instants (incl. exact bounds): identical id sets', async () => {
        const probes = [base - day, base, base + 10 * day, base + 50 * day, base + 119 * day, base + 121 * day,
            ...docs.slice(0, 20).flatMap((d) => [d.vf, d.vu].filter(Boolean).map((s) => Date.parse(s!)))];
        for (const at of probes) {
            const sqlIds = (await g3.listNodesValidAt(at, { unbounded: true })).map((n) => n.id).sort();
            const jsIds = (await g3.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true })).filter((n) => isValidAsOf(n, at)).map((n) => n.id).sort();
            assert.deepEqual(sqlIds, jsIds, `mismatch at ${new Date(at).toISOString()}`);
        }
    });
    await g3.close();
} finally {
    await closePostgresPool(pool);
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

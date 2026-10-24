/**
 * test/link-optout-durable-pg.ts - the Postgres half of the durable link opt-out: the `link_optout` table travels
 * with a per-workspace logical backup and comes back on restore (including under a NEW workspace id and with the
 * node `sk` identity values re-assigned), and is discovered as a workspace table, not excluded.
 *
 * Needs a throwaway Postgres with pgvector (`LORE_PG_URL`); with it unset the file prints the reason and exits 0.
 * It creates its own database (`lore_optbk_<pid>`) and drops it at the end.
 *
 * Why this is the proof the brief asks for: `link_optout` is keyed by the text node id (`workspace_id, node_id`),
 * NOT by `nodes.sk`, so backup discovery exports it through the generic `workspace_id` path and restore needs no
 * sk remap for it. If it were ever re-keyed by `sk` it would need the `lore:references nodes.sk` comment; this
 * test would then fail on the opt-outs of the restored copy.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, Pool } from 'pg';

import { ensureGraphSchema } from '../packages/lore/src/engines/postgres/postgresGraphSchema.js';
import { ensureVerbatimSchema } from '../packages/lore/src/engines/postgres/postgresVerbatimSchema.js';
import { exportWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupExport.js';
import { restoreWorkspaceBundle } from '../packages/lore/src/engines/postgres/postgresBackupRestore.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
}

const DIM = 8;
const url = process.env['LORE_PG_URL'];
if (!url || url.trim() === '') {
    console.log('SKIP link-optout-durable-pg: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector); exiting 0');
    process.exit(0);
}
const dbName = `lore_optbk_${process.pid}`;
const withDb = (db: string): string => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'optbk-'));

async function main(): Promise<void> {
    const admin = new Client({ connectionString: withDb('postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const pool = new Pool({ connectionString: withDb(dbName), max: 6 });
    try {
        const c = await pool.connect();
        try {
            await ensureGraphSchema(c, 'setup');
            await ensureVerbatimSchema(c, 'setup', DIM);
            await ensureVerbatimSchema(c, 'ws-a', DIM);
            await ensureVerbatimSchema(c, 'ws-b', DIM);
        } finally { c.release(); }

        const seed = async (ws: string, n: number, flagged: number[]): Promise<void> => {
            const g = new PostgresGraph(ws, pool); await g.initialize();
            for (let i = 0; i < n; i++) await g.upsertNode({ id: `n${i}`, type: 'note', label: `l${i}`, content: `c${i}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' } as never);
            await g.setLinkOptOuts(flagged.map((i) => `n${i}`), true);
            await g.setLinkOptOuts(['not-a-node-yet'], true); // recorded before the node exists
        };
        // ws-b is seeded FIRST so ws-a's sk values differ from what they will be after restore.
        await seed('ws-b', 5, [1]);
        await seed('ws-a', 12, [0, 3, 7]);
        const flagsOf = async (ws: string): Promise<string[]> =>
            (await pool.query<{ node_id: string }>(`SELECT node_id FROM link_optout WHERE workspace_id = $1 ORDER BY node_id`, [ws])).rows.map((r) => r.node_id);

        let bundle = '';
        await test('backup discovers link_optout as a workspace table (exported, not excluded) with the right row count', async () => {
            const sum = await exportWorkspaceBundle(pool, { workspaceId: 'ws-a', outDir: path.join(tmp, 'out') });
            bundle = sum.bundlePath;
            const t = sum.tables.find((x) => x.name === 'link_optout');
            assert.ok(t, `link_optout exported: ${sum.tables.map((x) => x.name).join(',')}`);
            assert.equal(t!.rowCount, 4);
            assert.ok(!sum.excluded.some((e) => e.table === 'link_optout'), 'not listed as excluded');
        });

        await test('restore as a NEW workspace brings every opt-out back and leaves other workspaces alone', async () => {
            const r = await restoreWorkspaceBundle(pool, { bundlePath: bundle, targetWorkspaceId: 'ws-a2' });
            assert.ok(r.totalRows > 0);
            assert.deepEqual(await flagsOf('ws-a2'), await flagsOf('ws-a'));
            assert.deepEqual(await flagsOf('ws-a2'), ['n0', 'n3', 'n7', 'not-a-node-yet']);
            assert.deepEqual(await flagsOf('ws-b'), ['n1', 'not-a-node-yet'], 'ws-b untouched');
            // The restored copy answers through the engine API, against re-assigned sk values.
            const g = new PostgresGraph('ws-a2', pool); await g.initialize();
            assert.deepEqual([...await g.getLinkOptOuts(['n0', 'n1', 'n3', 'n7', 'not-a-node-yet'])].sort(), ['n0', 'n3', 'n7', 'not-a-node-yet']);
            const sk = await pool.query(`SELECT (SELECT sk FROM nodes WHERE workspace_id='ws-a' AND id='n0') AS a, (SELECT sk FROM nodes WHERE workspace_id='ws-a2' AND id='n0') AS b`);
            assert.notEqual(sk.rows[0].a, sk.rows[0].b, 'precondition: the restored node has a different sk, so a sk-keyed flag would be wrong');
        });

        await test('forced restore over an existing workspace replaces its opt-outs with the bundle\'s', async () => {
            const g = new PostgresGraph('ws-a2', pool); await g.initialize();
            await g.setLinkOptOuts(['n0'], false);
            await g.setLinkOptOuts(['n9'], true);
            await restoreWorkspaceBundle(pool, { bundlePath: bundle, targetWorkspaceId: 'ws-a2', force: true });
            assert.deepEqual(await flagsOf('ws-a2'), ['n0', 'n3', 'n7', 'not-a-node-yet']);
        });

        await test('deleteNode in the restored workspace removes its flag only', async () => {
            const g = new PostgresGraph('ws-a2', pool); await g.initialize();
            await g.deleteNode('n3');
            assert.deepEqual(await flagsOf('ws-a2'), ['n0', 'n7', 'not-a-node-yet']);
            assert.deepEqual(await flagsOf('ws-a'), ['n0', 'n3', 'n7', 'not-a-node-yet'], 'the source workspace keeps its flags');
        });
    } finally {
        await pool.end();
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.end();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

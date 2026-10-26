#!/usr/bin/env tsx
/**
 * workspace-erase-plugin-pg-daemon-e2e.ts - lane f6c wire-up proof on DIRECT POSTGRES, REAL DAEMON over HTTP (ephemeral port).
 *
 * Needs a throwaway Postgres with pgvector named by `LORE_PG_URL` (unset -> printed skip, exit 0). The daemon runs with
 * LORE_PG_URL pointing at the dedicated `lore_gate` database and new workspaces defaulting to the Postgres graph engine.
 * Two workspaces (pg-gate-f6c-a, pg-gate-f6c-b) get identical rows. `DELETE .../pg-gate-f6c-a?erase=now`; the daemon's own tick
 * runs the erasers. Proven, against the live database:
 *   - rows are keyed by the permanent workspace id (POSTGRES_ROWS_KEYED_BY = 'permanent-id'), not the name;
 *   - the receipt is `complete` with the postgres step `complete`: the host eraser is wired in, ran, and removed A's rows;
 *   - every Postgres row of A is gone and ZERO rows changed for B (per-table row counts and a content digest, before vs after);
 *   - the local folder IS erased, the shared pool of the daemon keeps working (B still readable).
 * Only the two test workspaces' rows are ever touched (and removed at the end by this test).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { cleanup, fetchAuthToken, killDaemon, spawnDaemon, waitForReady, type DaemonHandle } from './helpers/live-daemon.js';
import { gateDbUrl, PG_GATE_DB } from './helpers/testPostgres.js';

const gate = gateDbUrl();
if (!gate) { console.log('SKIP workspace-erase-plugin-pg-daemon-e2e: LORE_PG_URL is not set (needs a throwaway Postgres with pgvector); exiting 0'); process.exit(0); }

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n       ${((e as Error).stack ?? String(e)).split('\n').slice(0, 6).join('\n       ')}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WA = 'pg-gate-f6c-a', WB = 'pg-gate-f6c-b';

// Make sure the dedicated database exists (same carve-out the other gate tests use).
{
    const admin = new URL(gate); admin.pathname = '/postgres';
    const c = new Client({ connectionString: admin.toString() }); await c.connect();
    try { if ((await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [PG_GATE_DB])).rowCount === 0) await c.query(`CREATE DATABASE ${PG_GATE_DB}`); } finally { await c.end(); }
}
const pg = new Client({ connectionString: gate }); await pg.connect();
/** Per-table row count + md5 digest of the rows for the given workspace ids, over every table that has a workspace_id column. */
async function snapshot(ws: string): Promise<Record<string, { rows: number; digest: string }>> {
    const tables = (await pg.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id' ORDER BY table_name`)).rows.map((r) => r.table_name as string);
    const out: Record<string, { rows: number; digest: string }> = {};
    for (const t of tables) {
        const rows = (await pg.query(`SELECT t::text AS r FROM "${t}" t WHERE workspace_id = $1 ORDER BY 1`, [ws])).rows.map((r) => r.r as string);
        // Only tables holding rows: an erase may create empty tables (e.g. the ingestion schema), which is not a change to anyone's data.
        if (rows.length === 0) continue;
        out[t] = { rows: rows.length, digest: createHash('md5').update(rows.join('\n')).digest('hex') };
    }
    return out;
}
const total = (s: Record<string, { rows: number }>): number => Object.values(s).reduce((n, x) => n + x.rows, 0);
/** Ids of the two test workspaces (rows are keyed by id), filled in once the daemon has created them. */
const testIds: string[] = [];
async function removeTestRows(): Promise<void> {
    const tables = (await pg.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id'`)).rows.map((r) => r.table_name as string);
    for (const t of tables) await pg.query(`DELETE FROM "${t}" WHERE workspace_id LIKE 'pg-gate-f6c-%' OR workspace_id = ANY($1)`, [testIds]);
}

let h: DaemonHandle | null = null;
try {
    await removeTestRows();
    h = await spawnDaemon({
        nodeArgs: ['--import', path.join(REPO, 'test/helpers/workspace-erase-preload.ts')],
        env: { LORE_MODEL_SERVER: '0', LORE_PG_URL: gate, LORE_DEFAULT_GRAPH_ENGINE: 'postgres' },
    });
    if (!(await waitForReady(h.port, 60_000))) throw new Error(`daemon never became ready\n${h.log.text.slice(-3000)}`);
    const bootstrapToken = await fetchAuthToken(h.port, h.home);
    {   // The bootstrap token is scoped to "default" and cannot write into other workspaces; issue an admin token from the daemon's own token store (same as `lore auth issue --admin`).
        const code = `import { issueToken } from ${JSON.stringify(path.join(REPO, 'packages/lore/src/auth/tokens.ts'))}; process.stdout.write(issueToken({ workspace: 'default', label: 'f6c-e2e', scopes: ['read','write','cross-workspace-read','cross-workspace-write'], admin: true }).token);`;
        const childEnv: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: h.home, TMPDIR: process.env['TMPDIR'] };
        h.token = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: REPO, env: childEnv, encoding: 'utf8' }).trim();
    }
    const base = `http://127.0.0.1:${h.port}`;
    const lh = path.join(h.home, '.groundfloor');
    const adminToken = h.token;
    const req = (method: string, p: string, body?: unknown, tok: string = bootstrapToken): Promise<Response> =>
        fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${tok}`, Origin: base, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = async (r: Response): Promise<any> => { try { return await r.json(); } catch { return null; } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const registry = (): { workspaces: Array<{ name: string; path: string; id?: string; graphEngine?: string }> } => JSON.parse(fs.readFileSync(path.join(lh, 'workspaces.json'), 'utf8'));
    const entry = (n: string) => registry().workspaces.find((w) => w.name === n);
    const logLines = (): Array<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const f = path.join(lh, 'workspace-deletions.jsonl');
        return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
    };

    for (const n of [WA, WB]) { const r = await req('POST', '/api/workspaces', { name: n }); assert.ok([200, 201].includes(r.status), `create ${n}: ${r.status} ${JSON.stringify(await json(r))}`); }
    const A = entry(WA)!; const idA = A.id!; const idB = entry(WB)!.id!;
    assert.equal(A.graphEngine, 'postgres', 'workspace is on the Postgres engine'); assert.ok(idA); assert.ok(idB);
    testIds.push(idA, idB);
    const put = async (ws: string, id: string, content: string): Promise<void> => {
        const r = await req('POST', '/api/node', { id, type: 'note', label: id, content, tags: 'f6c', workspace: ws }, adminToken);
        assert.ok([200, 201].includes(r.status), `write ${ws}/${id}: ${r.status} ${JSON.stringify(await json(r))}\n${h!.log.text.slice(-800)}`);
    };
    for (const ws of [WA, WB]) { await put(ws, 'n-1', 'identical content in both'); await put(ws, 'n-2', `only the label differs`); }
    let before: { a: Record<string, { rows: number; digest: string }>; b: Record<string, { rows: number; digest: string }> };

    await check('both workspaces have rows in Postgres (keyed by permanent id, none under the name)', async () => {
        // Background linking can still add edge rows for a moment after a write; wait until two snapshots in a row agree.
        let prev = JSON.stringify([await snapshot(idA), await snapshot(idB)]);
        for (let i = 0; i < 20; i++) { await sleep(750); const cur = JSON.stringify([await snapshot(idA), await snapshot(idB)]); if (cur === prev) break; prev = cur; }
        before = { a: await snapshot(idA), b: await snapshot(idB) };
        assert.ok(total(before.a) >= 2, JSON.stringify(before.a)); assert.ok(total(before.b) >= 2, JSON.stringify(before.b));
        assert.equal(total(await snapshot(WA)) + total(await snapshot(WB)), 0, 'no rows under the workspace names');
    });

    await check('DELETE A ?erase=now: the daemon runs the erasers; receipt COMPLETE, postgres step COMPLETE', async () => {
        let r = await req('DELETE', `/api/workspaces/${WA}?erase=now`);
        for (let i = 0; r.status === 400 && i < 30; i++) { await sleep(500); r = await req('DELETE', `/api/workspaces/${WA}?erase=now`); }
        const body = await json(r); assert.equal(r.status, 200, JSON.stringify(body));
        assert.ok(!entry(WA), 'A is gone from the registry');
        const end = Date.now() + 30_000;
        while (Date.now() < end && !logLines().some((l) => l['event'] === 'erased' && l['id'] === idA)) await sleep(300);
        const receipts = logLines().filter((l) => l['event'] === 'erased' && l['id'] === idA);
        assert.ok(receipts.length >= 1, `no receipt\n${h!.log.text.slice(-1500)}`);
        const rc = receipts[receipts.length - 1]!;
        const stores = rc['stores'] as Array<{ store: string; status: string; detail?: string; removed?: Record<string, number> }>;
        assert.equal(rc['status'], 'complete', JSON.stringify(stores));
        const p = stores.find((s) => s.store === 'postgres'); assert.ok(p, JSON.stringify(stores));
        assert.equal(p.status, 'complete', JSON.stringify(p));
        assert.ok(Object.values(p.removed ?? {}).reduce((n, x) => n + x, 0) >= 2, JSON.stringify(p));
        assert.equal(stores.find((s) => s.store === 'blobs-fs')?.status, 'not-applicable');
        assert.equal(stores.find((s) => s.store === 'local-dir')?.status, 'complete');
    });

    await check('every Postgres row of A is gone; ZERO rows changed for B (row counts and content digests identical)', async () => {
        assert.equal(total(await snapshot(idA)), 0, JSON.stringify(await snapshot(idA)));
        assert.deepEqual(await snapshot(idB), before.b, 'B rows unchanged');
    });

    await check('the daemon keeps serving B (its shared pool was not closed by the erase)', async () => {
        const r = await req('GET', `/api/node?id=n-1&workspace=${WB}`, undefined, adminToken);
        assert.equal(r.status, 200, JSON.stringify(await json(r)));
        assert.ok(entry(WB));
    });
} finally {
    if (h) { await killDaemon(h, 'SIGTERM', 8000); cleanup(h); }
    try { await removeTestRows(); } finally { await pg.end(); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

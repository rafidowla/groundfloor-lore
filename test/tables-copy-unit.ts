#!/usr/bin/env tsx
/**
 * test/tables-copy-unit.ts - `lore tables copy` (tables.sqlite -> Postgres table storage) and the
 * "tables left behind" warning.
 *
 *   dry run        exit 2, prints every table with counts, writes nothing to Postgres
 *   full copy      several types (string/int/float/bool/date/datetime/json, nulls, UNIQUE, reserved columns), >100 rows
 *                  (multi-batch, multi-page); values identical after the Postgres round trip; UNIQUE enforced; re-run = no-op
 *   source         tables.sqlite bytes and the directory listing are unchanged by dry run, copy and --replace
 *   refusals       sqlite workspace / unknown workspace / LORE_PG_URL unset -> 3; no file -> 0 nothing to copy;
 *                  conflicting target rows -> 4 and NOTHING written (other tables too); shape mismatch -> 4 even with --replace;
 *                  unconvertible source value -> 4
 *   --replace      truncates only conflicting target tables, leaves target-only tables alone
 *   resume         an injected mid-copy failure leaves a clean subset; re-planning says "resume"; a second run converges
 *   warning        ONE warning per workspace per process naming the file + `lore tables copy`; none for an empty file
 *   isolation      copying workspace A never touches workspace B's Postgres tables
 *
 * Throwaway database on the LORE_PG_URL server (skips with a printed reason when unset).
 * Run: LORE_PG_URL=postgres://... npx tsx test/tables-copy-unit.ts
 */
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import { PostgresTableStorage } from '../packages/lore/src/engines/postgres/postgresTableStorage.js';
import { createPostgresPool, closePostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { closeSharedPostgresPool } from '../packages/lore/src/engines/postgres/postgresPoolOwner.js';
import { validateSchema } from '../packages/lore/src/engines/postgres/postgresTableCatalog.js';
import { createWorkspaceTableStorage } from '../packages/lore/src/engines/tableStorageFactory.js';
import { resetTablesLeftBehindWarningsForTest } from '../packages/lore/src/engines/tablesLeftBehind.js';
import { digestTable, executeTableCopy, planTableCopy } from '../packages/lore/src/engines/tableCopy.js';
import type { ITableStorage, Row, TableOp, TableSchema } from '../packages/lore/src/contracts/tables.js';
// close() lives on the concrete stores, not on ITableStorage.
const openClosable = (...a: Parameters<typeof createWorkspaceTableStorage>) =>
    createWorkspaceTableStorage(...a) as Promise<ITableStorage & { close?: () => unknown }>;

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const raw = process.env['LORE_PG_URL'];
if (!raw || raw.trim() === '') {
    console.log('  SKIP tables-copy: LORE_PG_URL is not set - postgres cases skipped cleanly');
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(repoRoot, 'packages/lore/src/cli/index.ts');

const DB = `lore_tcopy_${process.pid}`;
const withDb = (name: string): string => { const u = new URL(raw); u.pathname = `/${name}`; return u.toString(); };
const admin = new Client({ connectionString: withDb('postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
const dbUrl = withDb(DB);
process.env['LORE_PG_URL'] = dbUrl;
process.env['LORE_MODEL_SERVER'] = '0';
const pool = createPostgresPool({ url: dbUrl, max: 4 });

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tcopy-home-'));
process.env['LORE_HOME'] = home;
const wsDir = (n: string): string => path.join(home, 'workspaces', n);
const sqliteFile = (n: string): string => path.join(wsDir(n), '.lore', 'tables.sqlite');
const WS = {
    main: 'tc-main', other: 'tc-other', conflict: 'tc-conflict', mismatch: 'tc-mismatch', bad: 'tc-bad',
    replace: 'tc-replace', sqlite: 'tc-sqlite', nofile: 'tc-nofile', empty: 'tc-emptyfile', warnA: 'tc-warn-a', warnB: 'tc-warn-b',
    resume: 'tc-resume',
};
const sqliteWs = new Set([WS.sqlite]);
const registry: Array<{ name: string; path: string; graphEngine: string }> = [];
for (const n of Object.values(WS)) {
    fs.mkdirSync(path.join(wsDir(n), '.lore'), { recursive: true });
    registry.push({ name: n, path: wsDir(n), graphEngine: sqliteWs.has(n) ? 'sqlite' : 'postgres' });
}
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ version: 1, active: WS.main, workspaces: registry }));

function cli(args: string[], env: Record<string, string | undefined> = {}): { code: number | null; out: string; err: string } {
    const e: Record<string, string | undefined> = { ...process.env, LORE_HOME: home, LORE_PG_URL: dbUrl, ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const r = spawnSync(tsxBin, [cliEntry, 'tables', 'copy', ...args], { env: e as NodeJS.ProcessEnv, encoding: 'utf-8', timeout: 180_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

// ---------------------------------------------------------------- fixtures
const CUSTOMERS: TableSchema = {
    name: 'customers',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string', required: true },
        { name: 'email', type: 'string', unique: true },
        { name: 'active', type: 'boolean' },
        { name: 'born', type: 'date' },
        { name: 'seen', type: 'datetime', indexed: true },
        { name: 'meta', type: 'json' },
        { name: 'score', type: 'float' },
        { name: 'visits', type: 'integer' },
        { name: 'note', type: 'string' },
        { name: '_memory_node_id', type: 'string' },
        { name: '_source_id', type: 'string' },
        { name: '_valid_from', type: 'datetime' },
        { name: '_valid_to', type: 'datetime' },
    ],
};
const EVENTS: TableSchema = {
    name: 'events',
    columns: [{ name: 'seq', type: 'integer', primary: true }, { name: 'kind', type: 'string', indexed: true }, { name: 'payload', type: 'json' }],
};
const EMPTY_T: TableSchema = { name: 'nothing_here', columns: [{ name: 'k', type: 'string', primary: true }, { name: 'v', type: 'string' }] };
const N_EVENTS = 1250;

function customerRows(): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < 230; i++) {
        rows.push({
            id: `c${String(i).padStart(4, '0')}`, name: `Name ${i}`, email: i % 7 === 0 ? null : `c${i}@example.com`,
            active: i % 2 === 0 ? true : i % 3 === 0 ? null : false,
            born: i % 5 === 0 ? null : `19${70 + (i % 30)}-0${1 + (i % 9)}-1${i % 9}`,
            seen: i % 4 === 0 ? null : `2026-0${1 + (i % 9)}-15T10:${String(i % 60).padStart(2, '0')}:00Z`,
            meta: i % 6 === 0 ? null : { tags: ['a', 'b', i], nested: { z: 1, a: i % 2 === 0 } },
            score: i % 8 === 0 ? null : i / 3 + 0.25, visits: i % 9 === 0 ? null : i * 1000,
            note: i % 10 === 0 ? null : i % 11 === 0 ? '' : `note "${i}" with 'quotes' and unicode é中`,
            _memory_node_id: i % 3 === 0 ? null : `node-${i}`, _source_id: i % 4 === 0 ? null : `src-${i}`,
            _valid_from: i % 2 === 0 ? '2026-01-01T00:00:00Z' : null, _valid_to: i % 5 === 0 ? '2027-01-01T00:00:00Z' : null,
        });
    }
    return rows;
}

async function buildSource(ws: string, opts: { events?: number; tables?: TableSchema[] } = {}): Promise<void> {
    const dir = path.join(wsDir(ws), '.lore');
    fs.rmSync(path.join(dir, 'tables.sqlite'), { force: true });
    fs.rmSync(path.join(dir, 'sqlite-collection-schemas.json'), { force: true });
    const s = new SqliteTableStorage(path.join(dir, 'tables.sqlite'), path.join(dir, 'sqlite-collection-schemas.json'));
    try {
        for (const t of opts.tables ?? [CUSTOMERS, EVENTS, EMPTY_T]) await s.createTable(t);
        if (!opts.tables) {
            await s.insertBatch('customers', customerRows());
            const ev: Row[] = [];
            for (let i = 1; i <= (opts.events ?? N_EVENTS); i++) ev.push({ seq: i, kind: `k${i % 5}`, payload: { i, even: i % 2 === 0 } });
            await s.insertBatch('events', ev);
        }
    } finally { s.close(); }
    // closing a WAL db may leave -wal/-shm; checkpoint is done on close, so only the main file matters
}
const sha = (f: string): string => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const listing = (ws: string): string[] => fs.readdirSync(path.join(wsDir(ws), '.lore')).sort();
const pgFor = (ws: string): Promise<PostgresTableStorage> => PostgresTableStorage.open(ws, pool);
async function openSource(ws: string): Promise<SqliteTableStorage> {
    const dir = path.join(wsDir(ws), '.lore');
    // work on a throwaway copy so the engine-level tests never open the fixture file in place
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcopy-src-'));
    fs.copyFileSync(path.join(dir, 'tables.sqlite'), path.join(tmp, 'tables.sqlite'));
    fs.copyFileSync(path.join(dir, 'sqlite-collection-schemas.json'), path.join(tmp, 's.json'));
    return new SqliteTableStorage(path.join(tmp, 'tables.sqlite'), path.join(tmp, 's.json'));
}
const digestAll = async (st: ITableStorage): Promise<Record<string, { rows: number; digest: string }>> => {
    const out: Record<string, { rows: number; digest: string }> = {};
    for (const t of await st.listTables({ withCounts: false })) out[t.name] = await digestTable(st, { name: t.name, columns: t.columns });
    return out;
};

await buildSource(WS.main);

try {
    console.log('dry run');
    await test('dry run: exit 2, plan printed, nothing created in Postgres, source untouched', async () => {
        const before = sha(sqliteFile(WS.main)); const list = listing(WS.main);
        const r = cli(['--workspace', WS.main]);
        assert.equal(r.code, 2, r.out + r.err);
        assert.match(r.out, /customers: 230 row\(s\) in SQLite, not in Postgres/);
        assert.match(r.out, new RegExp(`events: ${N_EVENTS} row\\(s\\) in SQLite`));
        assert.match(r.out, /nothing_here: 0 row\(s\)/);
        assert.match(r.out, /Dry run: nothing was written/);
        const pg = await pgFor(WS.main);
        assert.deepEqual(await pg.listTables(), []);
        assert.equal(sha(sqliteFile(WS.main)), before);
        assert.deepEqual(listing(WS.main), list);
    });
    await test('dry run --json: machine-readable, exit code in body', async () => {
        const r = cli(['--workspace', WS.main, '--json']);
        assert.equal(r.code, 2);
        const j = JSON.parse(r.out);
        assert.equal(j.exitCode, 2); assert.equal(j.status, 'needs_yes');
        assert.equal(j.tables.find((t: { name: string }) => t.name === 'events').sourceRows, N_EVENTS);
    });

    console.log('full copy');
    await test('copy --yes: exit 0, every table verified, values identical, source untouched', async () => {
        const before = sha(sqliteFile(WS.main)); const list = listing(WS.main);
        const r = cli(['--workspace', WS.main, '--yes']);
        assert.equal(r.code, 0, r.out + r.err);
        assert.match(r.out, /Copied and verified/);
        assert.equal(sha(sqliteFile(WS.main)), before, 'tables.sqlite bytes changed');
        assert.deepEqual(listing(WS.main), list, 'files appeared in / vanished from the source directory');
        const pg = await pgFor(WS.main);
        const src = await openSource(WS.main);
        try {
            assert.deepEqual(await digestAll(pg), await digestAll(src));
            assert.equal(await pg.count('customers'), 230);
            assert.equal(await pg.count('events'), N_EVENTS);
            assert.equal(await pg.count('nothing_here'), 0);
            // spot-check concrete values incl. nulls, boolean, date, json and reserved columns
            const c1 = (await pg.getByKey('customers', 'c0001'))!;
            assert.equal(c1['active'], false); assert.equal(c1['_memory_node_id'], 'node-1'); assert.equal(c1['_source_id'], 'src-1');
            assert.deepEqual(c1['meta'], { tags: ['a', 'b', 1], nested: { z: 1, a: false } });
            const c0 = (await pg.getByKey('customers', 'c0000'))!;
            assert.equal(c0['email'], null); assert.equal(c0['born'], null); assert.equal(c0['_memory_node_id'], null);
            assert.equal(c0['_valid_from'], '2026-01-01T00:00:00.000Z'); assert.equal(c0['_valid_to'], '2027-01-01T00:00:00.000Z');
            assert.equal((await pg.getByKey('customers', 'c0010'))!['note'], null);
            assert.equal((await pg.getByKey('customers', 'c0011'))!['note'], '');
            // schema incl. UNIQUE / required / indexed survived
            const decl = (await pg.listTables()).find((t) => t.name === 'customers')!.columns;
            assert.equal(decl.find((c) => c.name === 'email')!.unique, true);
            assert.equal(decl.find((c) => c.name === 'name')!.required, true);
            assert.equal(decl.find((c) => c.name === 'seen')!.indexed, true);
            // the UNIQUE constraint is live in Postgres
            await assert.rejects(pg.insert('customers', { id: 'dup', name: 'x', email: 'c1@example.com' }));
        } finally { src.close(); }
    });
    await test('re-run is a no-op (exit 0, nothing to copy)', async () => {
        const r = cli(['--workspace', WS.main, '--yes']);
        assert.equal(r.code, 0, r.out + r.err);
        assert.match(r.out, /Nothing to copy: every table is already identical/);
    });

    console.log('refusals');
    await buildSource(WS.sqlite);
    await test('workspace on the sqlite engine -> 3', () => {
        const r = cli(['--workspace', WS.sqlite, '--yes']);
        assert.equal(r.code, 3, r.out + r.err); assert.match(r.out, /only copies INTO Postgres/);
    });
    await test('unknown workspace -> 3', () => {
        const r = cli(['--workspace', 'no-such-ws']);
        assert.equal(r.code, 3); assert.match(r.out, /not registered/);
    });
    await test('LORE_PG_URL unset -> 3, nothing opened', () => {
        const r = cli(['--workspace', WS.main, '--yes'], { LORE_PG_URL: undefined });
        assert.equal(r.code, 3, r.out + r.err); assert.match(r.out, /LORE_PG_URL is not set/);
    });
    await test('--workspace is required (1); unknown flag (1)', () => {
        assert.equal(cli([]).code, 1);
        assert.equal(cli(['--workspace', WS.main, '--bogus']).code, 1);
    });
    await test('no tables.sqlite -> 0 nothing to copy, no file created', () => {
        const r = cli(['--workspace', WS.nofile, '--yes']);
        assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /does not exist/);
        assert.equal(fs.existsSync(sqliteFile(WS.nofile)), false);
    });
    await test('conflicting target rows -> 4 and NOTHING written (other tables included)', async () => {
        await buildSource(WS.conflict);
        const pg = await pgFor(WS.conflict);
        await pg.createTable(EVENTS);
        await pg.insert('events', { seq: 1, kind: 'DIFFERENT', payload: null });
        await pg.insert('events', { seq: 99999, kind: 'extra', payload: null });
        const r = cli(['--workspace', WS.conflict, '--yes']);
        assert.equal(r.code, 4, r.out + r.err); assert.match(r.out, /re-run with --replace/);
        const tabs = (await pg.listTables()).map((t) => t.name).sort();
        assert.deepEqual(tabs, ['events'], 'customers must not have been created');
        assert.equal(await pg.count('events'), 2);
    });
    await test('shape mismatch -> 4 even with --replace', async () => {
        await buildSource(WS.mismatch);
        const pg = await pgFor(WS.mismatch);
        await pg.createTable({ name: 'events', columns: [{ name: 'seq', type: 'integer', primary: true }, { name: 'other', type: 'string' }] });
        const r = cli(['--workspace', WS.mismatch, '--yes', '--replace']);
        assert.equal(r.code, 4, r.out + r.err); assert.match(r.out, /different shape/);
        assert.equal((await pg.listTables()).length, 1);
    });
    await test('unconvertible source value (bad date) -> 4, nothing written', async () => {
        await buildSource(WS.bad);
        const src = new SqliteTableStorage(sqliteFile(WS.bad), path.join(wsDir(WS.bad), '.lore', 'sqlite-collection-schemas.json'));
        src.getDatabase().prepare(`UPDATE customers SET born = 'not-a-date' WHERE id = 'c0001'`).run();
        src.close();
        const r = cli(['--workspace', WS.bad, '--yes']);
        assert.equal(r.code, 4, r.out + r.err); assert.match(r.out, /customers\.born/);
        assert.deepEqual(await (await pgFor(WS.bad)).listTables(), []);
    });

    console.log('--replace');
    await test('--replace truncates only the conflicting table; target-only tables untouched; verified', async () => {
        await buildSource(WS.replace);
        const pg = await pgFor(WS.replace);
        await pg.createTable(EVENTS);
        await pg.insert('events', { seq: 1, kind: 'DIFFERENT', payload: null });
        await pg.insert('events', { seq: 99999, kind: 'extra', payload: null });
        const keep: TableSchema = { name: 'target_only', columns: [{ name: 'k', type: 'string', primary: true }] };
        await pg.createTable(keep); await pg.insert('target_only', { k: 'stay' });
        const before = sha(sqliteFile(WS.replace)); const list = listing(WS.replace);
        const r = cli(['--workspace', WS.replace, '--yes', '--replace']);
        assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /target truncated first/);
        assert.equal(await pg.count('events'), N_EVENTS);
        assert.equal(await pg.getByKey('events', 99999), null);
        assert.equal((await pg.getByKey('events', 1))!['kind'], 'k1');
        assert.equal(await pg.count('target_only'), 1);
        assert.equal(await pg.count('customers'), 230);
        assert.equal(sha(sqliteFile(WS.replace)), before); assert.deepEqual(listing(WS.replace), list);
    });

    console.log('resume');
    await test('injected mid-copy failure leaves a clean subset; re-plan says resume; second run converges', async () => {
        await buildSource(WS.resume);
        const src = await openSource(WS.resume);
        const pg = await pgFor(WS.resume);
        let calls = 0;
        const flaky: ITableStorage = new Proxy(pg, {
            get(t, p, r) {
                if (p === 'runTransaction') return async (ops: TableOp[]) => { if (++calls === 2) throw new Error('injected crash'); return t.runTransaction(ops); };
                const v = Reflect.get(t, p, r);
                return typeof v === 'function' ? v.bind(t) : v;
            },
        }) as ITableStorage;
        try {
            const opts = { validateTargetSchema: validateSchema, pageSize: 100 };
            const plan = await planTableCopy(src, flaky, opts);
            await assert.rejects(executeTableCopy(src, flaky, plan, opts), /injected crash/);
            const partial = await pg.count('customers');
            assert.ok(partial > 0 && partial < 230, `expected a partial copy, got ${partial}`);
            const plan2 = await planTableCopy(src, pg, opts);
            const c = plan2.tables.find((t) => t.name === 'customers')!;
            assert.equal(c.status, 'resume'); assert.equal(c.identical, partial); assert.equal(c.missing, 230 - partial);
            const res = await executeTableCopy(src, pg, plan2, opts);
            assert.equal(res.verified, true);
            assert.deepEqual(await digestAll(pg), await digestAll(src));
            const plan3 = await planTableCopy(src, pg, opts);
            assert.ok(plan3.tables.every((t) => t.status === 'done'), JSON.stringify(plan3.tables.map((t) => [t.name, t.status])));
        } finally { src.close(); }
    });

    console.log('warning');
    const warnings: string[] = [];
    const origWarn = console.warn;
    const capture = async (fn: () => Promise<void>): Promise<void> => {
        console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
        try { await fn(); } finally { console.warn = origWarn; }
    };
    await test('once per workspace per process; names the file and the command', async () => {
        await buildSource(WS.warnA); await buildSource(WS.warnB);
        resetTablesLeftBehindWarningsForTest(); warnings.length = 0;
        await capture(async () => {
            for (let i = 0; i < 3; i++) await (await openClosable(WS.warnA, wsDir(WS.warnA), home)).close?.();
            await (await openClosable(WS.warnB, wsDir(WS.warnB), home)).close?.();
            await (await openClosable(WS.warnB, wsDir(WS.warnB), home)).close?.();
        });
        const a = warnings.filter((w) => w.includes(`'${WS.warnA}'`)); const b = warnings.filter((w) => w.includes(`'${WS.warnB}'`));
        assert.equal(a.length, 1, warnings.join('\n')); assert.equal(b.length, 1);
        assert.ok(a[0]!.includes(sqliteFile(WS.warnA))); assert.ok(a[0]!.includes(`lore tables copy --workspace ${WS.warnA}`));
        assert.equal(warnings.length, 2);
    });
    await test('no warning for an empty tables.sqlite, a missing one, or a sqlite-engine workspace', async () => {
        await buildSource(WS.empty, { tables: [EMPTY_T] });
        resetTablesLeftBehindWarningsForTest(); warnings.length = 0;
        await capture(async () => {
            await (await openClosable(WS.empty, wsDir(WS.empty), home)).close?.();
            await (await openClosable(WS.nofile, wsDir(WS.nofile), home)).close?.();
            const s = await createWorkspaceTableStorage(WS.sqlite, wsDir(WS.sqlite), home); (s as SqliteTableStorage).close();
        });
        assert.deepEqual(warnings, []);
    });
    await test('the warning check does not modify tables.sqlite', async () => {
        const before = sha(sqliteFile(WS.warnA));
        resetTablesLeftBehindWarningsForTest();
        await capture(async () => { await (await openClosable(WS.warnA, wsDir(WS.warnA), home)).close?.(); });
        assert.equal(sha(sqliteFile(WS.warnA)), before);
    });

    console.log('isolation');
    await test('copying one workspace never touches another workspace\'s Postgres tables', async () => {
        const other = await pgFor(WS.other);
        await other.createTable(EVENTS);
        await other.insertBatch('events', [{ seq: 1, kind: 'mine', payload: { keep: true } }, { seq: 2, kind: 'mine', payload: null }]);
        const before = await digestAll(other);
        await buildSource(WS.other); // its own tables.sqlite exists too, but we only copy WS.main-like data into a fresh ws below
        const fresh = 'tc-isolation-src';
        fs.mkdirSync(path.join(wsDir(fresh), '.lore'), { recursive: true });
        registry.push({ name: fresh, path: wsDir(fresh), graphEngine: 'postgres' });
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ version: 1, active: WS.main, workspaces: registry }));
        await buildSource(fresh);
        const r = cli(['--workspace', fresh, '--yes']);
        assert.equal(r.code, 0, r.out + r.err);
        assert.deepEqual(await digestAll(other), before, 'workspace B changed');
        assert.equal(await other.count('events'), 2);
        assert.equal((await other.listTables()).length, 1);
    });
} finally {
    await closeSharedPostgresPool().catch(() => undefined);
    await closePostgresPool(pool).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    fs.rmSync(home, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env tsx
/**
 * cloud-purge-cli-unit.ts — `lore maintain cloud-purge` (packages/lore/src/cli/commands/maintainCloudPurge.ts)
 * against the engine-faithful mock only; the lore home is a temp dir, the client factory is injected.
 *
 * Proves:
 *   - every refusal (mode, org, key, url, connection, id, strict registry read, live id/alias/derived id, record
 *     rules, min-age, bad flags) exits 1 with a one-line reason and sends ZERO requests to Dataplane;
 *   - the recent-write probe refuses an apply (recent write, and the `unknown` verdict) with ZERO delete requests,
 *     while a dry run prints the verdict and exits 0;
 *   - a dry run deletes nothing and prints the exact footer; apply deletes the target's rows only (another
 *     workspace, another org byte-identical), writes the purge event, and `--list` shows it;
 *   - the guard aborts (exit 2) when the id becomes live, or the registry unreadable, between passes;
 *   - --unrecorded needs the right --confirm-org; --min-age 0 allows a fresh record; --max-rows exits 3 and a rerun
 *     finishes; unkeyed rows are reported and left; a journal write failure is a warning, not an exit code change;
 *   - --json is one parsable object and no output carries the API key.
 * No network call to any real service: the mock listens on 127.0.0.1.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockDataplane, type MockDataplane } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { scopeRowFields, type DataplaneScope } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { deriveWorkspaceId } from '../packages/lore/src/config/workspaceIds.js';
import { readDeletionLog } from '../packages/lore/src/config/deletedWorkspaces.js';
import { runCloudPurge, readRegistryStrict } from '../packages/lore/src/cli/commands/maintainCloudPurge.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${((e as Error).stack ?? (e as Error).message).slice(0, 3000)}`); failed++; }
}

delete process.env['LORE_DEPLOYMENT_MODE'];

const KEY = 'cli-purge-secret-key-0123';
const DP = 'dp-ws-purge-cli';
const CONN = 'postgresql';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const TARGET = 'ws-target-0001';
const OTHER = 'ws-other-0002';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const DELETED_AT = '2026-09-10T00:00:00.000Z';
const OLD_WRITE = '2026-09-09T10:00:00.000Z';
/** The mock stamps created_at/updated_at only when absent; the probe reads both, so set both. */
const stamp = (iso: string): Row => ({ created_at: iso, updated_at: iso });
const OLD = stamp(OLD_WRITE);
const FOOTER = 'DRY RUN - nothing was deleted; re-run with --apply';
const COLLS = ['lore_edge', 'lore_version', 'lore_verbatim', 'lore_node'];

const sc = (orgId: string, ws: string): DataplaneScope => ({ orgId, loreWorkspace: ws, dataplaneWorkspaceId: DP });
type Row = Record<string, unknown>;

const homes: string[] = [];
function mkHome(opts: { record?: Partial<{ id: string; orgId: string | null; deletedAt: string }> | null; registry?: unknown } = {}): string {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cloud-purge-cli-'));
    homes.push(h);
    const reg = opts.registry === undefined
        ? { active: 'default', workspaces: [{ name: 'default', id: 'default-id', path: h, createdAt: '2026-01-01T00:00:00.000Z' }] }
        : opts.registry;
    fs.writeFileSync(path.join(h, 'workspaces.json'), typeof reg === 'string' ? reg : JSON.stringify(reg));
    if (opts.record !== null) {
        const r = { id: TARGET, orgId: ORG_A, deletedAt: DELETED_AT, ...(opts.record ?? {}) };
        fs.appendFileSync(path.join(h, 'workspace-deletions.jsonl'), `${JSON.stringify({
            v: 1, event: 'deleted', idSource: 'stored', name: 'old-project', path: '/x/old', createdAt: null, mode: 'cloud', ...r,
        })}\n`);
    }
    return h;
}
const regPath = (h: string): string => path.join(h, 'workspaces.json');
const addRegistryEntry = (h: string, entry: Row): void => {
    const f = JSON.parse(fs.readFileSync(regPath(h), 'utf8')) as { workspaces: Row[] };
    f.workspaces.push(entry);
    fs.writeFileSync(regPath(h), JSON.stringify(f));
};

type Client = ReturnType<typeof createMockDataplaneClient>;
interface World { mock: MockDataplane; client: Client; env: Record<string, string | undefined>; close(): Promise<void> }
async function world(): Promise<World> {
    const mock = await startMockDataplane({ apiKeys: { [KEY]: DP } });
    return {
        mock, client: createMockDataplaneClient(mock.url, KEY),
        env: {
            LORE_DEPLOYMENT_MODE: 'cloud', DATAPLANE_ORG_ID: ORG_A, DATAPLANE_API_KEY: KEY, DATAPLANE_URL: mock.url,
            DATAPLANE_CONNECTION: CONN, DATAPLANE_WORKSPACE_ID: DP,
        },
        close: () => mock.close(),
    };
}

const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);
async function seed(w: World, coll: string, scope: DataplaneScope, lids: readonly string[], extra: Row = OLD): Promise<void> {
    for (const id of lids) await w.client.insert(DP, coll, { ...scopeRowFields(scope, id), ...extra }, CONN);
}
async function seedAll(w: World, scope: DataplaneScope, n: number, extra?: Row): Promise<void> {
    await seed(w, 'lore_node', scope, ids('n', n), extra);
    await seed(w, 'lore_edge', scope, ids('e', n), extra);
    await seed(w, 'lore_version', scope, ids('v', n), extra);
    await seed(w, 'lore_verbatim', scope, ids('b', n), extra);
}
const rowsIn = (w: World, coll: string, pred: (r: Row) => boolean = () => true): Row[] => w.mock.rows(DP, coll, CONN).filter(pred);
const isScope = (s: DataplaneScope) => (r: Row): boolean => r['org_id'] === s.orgId && r['lore_workspace'] === s.loreWorkspace;
const snap = (w: World, pred: (r: Row) => boolean): Record<string, Row[]> => Object.fromEntries(COLLS.map((c) => [c, rowsIn(w, c, pred)]));
const countRows = (w: World, s: DataplaneScope): number => COLLS.reduce((a, c) => a + rowsIn(w, c, isScope(s)).length, 0);
const deletes = (w: World, from = 0): number => w.mock.requests.slice(from).filter((r) => r.method === 'DELETE').length;

interface Ran { exitCode: number; out: string[]; err: string[]; text: string; reqs: number; dels: number }
async function cli(w: World, home: string, args: string[], o: { env?: Record<string, string | undefined>; client?: Client } = {}): Promise<Ran> {
    const out: string[] = [];
    const err: string[] = [];
    const from = w.mock.requests.length;
    const env = { ...w.env, ...(o.env ?? {}) };
    const client = o.client ?? w.client;
    const { exitCode } = await runCloudPurge(args, { clientFactory: () => client, env, home, now: () => new Date(NOW), out: (l) => out.push(l), err: (l) => err.push(l) });
    const text = [...out, ...err].join('\n');
    assert.ok(!text.includes(KEY), 'the API key must never be printed');
    return { exitCode, out, err, text, reqs: w.mock.requests.length - from, dels: deletes(w, from) };
}
/** Wrap the client so `after` runs once the first deleteByQuery has returned. */
function hookAfterFirstDelete(w: World, after: () => void): Client {
    let fired = false;
    return new Proxy(w.client, {
        get(t, p, r) {
            const v = Reflect.get(t, p, r) as unknown;
            if (p !== 'deleteByQuery') return v;
            return async (...a: unknown[]) => {
                const res = await (v as (...x: unknown[]) => Promise<unknown>).apply(t, a);
                if (!fired) { fired = true; after(); }
                return res;
            };
        },
    });
}

console.log('cloud purge: CLI');
const w = await world();
try {
    /* ─── Refusals: exit 1, one reason, zero Dataplane requests ─── */
    const base = ['--id', TARGET];
    const refusals: Array<[string, string[], { env?: Record<string, string | undefined>; home?: () => string }, RegExp]> = [
        ['mode unset (local)', base, { env: { LORE_DEPLOYMENT_MODE: undefined } }, /deployment mode is not 'cloud'/],
        ['mode embedded', base, { env: { LORE_DEPLOYMENT_MODE: 'embedded' } }, /deployment mode is not 'cloud'/],
        ['org unset', base, { env: { DATAPLANE_ORG_ID: undefined } }, /DATAPLANE_ORG_ID is unset/],
        ['org default', base, { env: { DATAPLANE_ORG_ID: 'default' } }, /'default'/],
        ['api key unset', base, { env: { DATAPLANE_API_KEY: undefined } }, /DATAPLANE_API_KEY is unset/],
        ['apply without an explicit url', [...base, '--apply'], { env: { DATAPLANE_URL: undefined } }, /DATAPLANE_URL/],
        ['no connection', base, { env: { DATAPLANE_CONNECTION: undefined } }, /no connection/],
        ['--id missing', [], {}, /--id <workspace-id> is required/],
        ['--id twice', [...base, '--id', OTHER], {}, /exactly one --id/],
        ['--id invalid', ['--id', 'bad id!'], {}, /not a valid workspace id/],
        ['registry absent', base, { home: () => { const h = mkHome(); fs.rmSync(regPath(h)); return h; } }, /cannot prove the workspace is unregistered/],
        ['registry corrupt', base, { home: () => mkHome({ registry: '{ not json' }) }, /not valid JSON/],
        ['registry has no workspaces', base, { home: () => mkHome({ registry: { active: 'x', workspaces: [] } }) }, /no workspaces\[\]/],
        ['id live in the registry', base, { home: () => mkHome({ registry: { active: 'a', workspaces: [{ name: 'a', id: TARGET, path: '/p/a' }] } }) }, /live in workspaces\.json/],
        ['id live through an alias', base, { home: () => { const h = mkHome(); addRegistryEntry(h, { name: 'alias', id: TARGET, path: '/p/alias' }); return h; } }, /live in workspaces\.json/],
        ['id live as a derived (id-less entry) id', ['--id', deriveWorkspaceId('/p/legacy', '2026-02-01T00:00:00.000Z')], {
            home: () => mkHome({ record: { id: deriveWorkspaceId('/p/legacy', '2026-02-01T00:00:00.000Z') }, registry: { active: 'a', workspaces: [{ name: 'a', path: '/p/legacy', createdAt: '2026-02-01T00:00:00.000Z' }] } }),
        }, /live in workspaces\.json/],
        ['no deletion record', base, { home: () => mkHome({ record: null }) }, /no deletion record/],
        ['--unrecorded without --confirm-org', [...base, '--unrecorded'], { home: () => mkHome({ record: null }) }, /--unrecorded --confirm-org/],
        ['--confirm-org without --unrecorded', [...base, '--confirm-org', ORG_A], { home: () => mkHome({ record: null }) }, /no deletion record/],
        ['--unrecorded with a wrong --confirm-org', [...base, '--unrecorded', '--confirm-org', ORG_B], { home: () => mkHome({ record: null }) }, /does not equal DATAPLANE_ORG_ID/],
        ['record from another org', base, { home: () => mkHome({ record: { orgId: ORG_B } }) }, /different org/],
        ['apply on a record younger than --min-age', [...base, '--apply'], { home: () => mkHome({ record: { deletedAt: new Date(NOW - 3_600_000).toISOString() } }) }, /younger than --min-age/],
        ['bad --collection (transaction)', [...base, '--collection', 'transaction'], {}, /invalid collection name/],
        ['bad --collection (built in)', [...base, '--collection', 'lore_node'], {}, /already built in/],
        ['bad --collection (malformed)', [...base, '--collection', 'Bad Name'], {}, /invalid collection name/],
        ['--max-rows 0', [...base, '--max-rows', '0'], {}, /--max-rows must be a positive integer/],
        ['--max-rows abc', [...base, '--max-rows', 'abc'], {}, /--max-rows must be a positive integer/],
        ['--min-age bad', [...base, '--min-age', 'soon'], {}, /--min-age/],
        ['unknown flag', [...base, '--force'], {}, /unknown flag --force/],
        ['stray argument', [...base, 'alpha'], {}, /unexpected argument/],
        ['--list with --apply', ['--list', '--apply'], {}, /cannot be combined/],
    ];
    for (const [name, args, o, re] of refusals) {
        await test(`refuses: ${name} (exit 1, zero requests)`, async () => {
            const home = o.home ? o.home() : mkHome();
            const r = await cli(w, home, args, o.env ? { env: o.env } : {});
            assert.equal(r.exitCode, 1, r.text);
            assert.match(r.err.join('\n'), re);
            assert.equal(r.err.length, 1, 'one-line reason');
            assert.equal(r.reqs, 0, 'no request may reach Dataplane');
            assert.equal(r.out.length, 0);
        });
    }

    await test('--json refusal is one JSON object on stdout', async () => {
        const r = await cli(w, mkHome({ record: null }), [...base, '--json']);
        assert.equal(r.exitCode, 1);
        assert.equal(r.out.length, 1);
        const j = JSON.parse(r.out[0]!) as { ok: boolean; refused: string };
        assert.equal(j.ok, false);
        assert.match(j.refused, /no deletion record/);
    });

    await test('strict read: an unreadable registry throws instead of reading as empty', () => {
        const h = mkHome({ registry: '{ nope' });
        assert.throws(() => readRegistryStrict(h), /not valid JSON/);
        fs.rmSync(regPath(h));
        assert.throws(() => readRegistryStrict(h), /cannot read/);
    });

    /* ─── Probe verdicts ─── */
    await test('a recent write refuses an apply with zero deletes; the dry run prints it and exits 0', async () => {
        const world2 = await world();
        try {
            const late = new Date(Date.parse(DELETED_AT) + 3_600_000).toISOString();
            await seedAll(world2, sc(ORG_A, TARGET), 3);
            await seed(world2, 'lore_node', sc(ORG_A, TARGET), ['late'], stamp(late));
            const before = snap(world2, isScope(sc(ORG_A, TARGET)));
            const apply = await cli(world2, mkHome(), [...base, '--apply']);
            assert.equal(apply.exitCode, 1, apply.text);
            assert.equal(apply.dels, 0);
            assert.match(apply.text, /APPLY REFUSED - recent-write probe/);
            const dry = await cli(world2, mkHome(), base);
            assert.equal(dry.exitCode, 0);
            assert.equal(dry.dels, 0);
            assert.match(dry.text, /--apply would REFUSE: recent-write probe/);
            assert.ok(dry.text.includes(FOOTER));
            assert.deepEqual(snap(world2, isScope(sc(ORG_A, TARGET))), before);
        } finally { await world2.close(); }
    });

    await test('verdict `unknown` (no readable dates) refuses an apply; dry run exits 0; no-rows proceeds', async () => {
        const w2 = await world();
        try {
            await seedAll(w2, sc(ORG_A, TARGET), 3, stamp('not-a-date'));
            const apply = await cli(w2, mkHome(), [...base, '--apply']);
            assert.equal(apply.exitCode, 1, apply.text);
            assert.equal(apply.dels, 0);
            assert.match(apply.text, /cannot tell/);
            const dry = await cli(w2, mkHome(), base);
            assert.equal(dry.exitCode, 0);
            assert.match(dry.text, /write probe\s+: unknown/);
        } finally { await w2.close(); }
        const empty = await world();
        try {
            const r = await cli(empty, mkHome(), [...base, '--apply']);
            assert.equal(r.exitCode, 0, r.text);
            assert.match(r.text, /write probe\s+: no-rows/);
        } finally { await empty.close(); }
    });

    /* ─── Dry run, apply, journal, --list ─── */
    const A_T = sc(ORG_A, TARGET);
    const A_O = sc(ORG_A, OTHER);
    const B_T = sc(ORG_B, TARGET);

    await test('dry run deletes nothing and prints the footer; apply deletes only the target; journal + --list', async () => {
        const w3 = await world();
        try {
            await seedAll(w3, A_T, 4);
            await seedAll(w3, A_O, 5);
            await seedAll(w3, B_T, 6);
            const home = mkHome();
            const others = snap(w3, (r) => !isScope(A_T)(r));
            const before = countRows(w3, A_T);
            assert.equal(before, 16);

            const dry = await cli(w3, home, base);
            assert.equal(dry.exitCode, 0, dry.text);
            assert.equal(dry.dels, 0);
            assert.equal(dry.out[dry.out.length - 1], FOOTER);
            assert.match(dry.text, /DRY RUN/);
            assert.match(dry.text, /lore_node\s+keyed 4/);
            assert.equal(countRows(w3, A_T), before);
            assert.ok(readDeletionLog(home).byId.get(TARGET)?.lastPurge === undefined, 'a dry run writes no journal event');

            const from = w3.mock.requests.length;
            const apply = await cli(w3, home, [...base, '--apply']);
            assert.equal(apply.exitCode, 0, apply.text);
            assert.match(apply.text, /APPLY complete: 16 row\(s\) deleted/);
            assert.match(apply.text, /purge event recorded/);
            assert.equal(countRows(w3, A_T), 0);
            assert.deepEqual(snap(w3, (r) => !isScope(A_T)(r)), others, 'other workspace and other org are byte-identical');
            for (const r of w3.mock.requests.slice(from)) {
                assert.ok(!r.path.includes('/transaction'));
                assert.notEqual(r.body['filter'], 'all');
                assert.match(r.path, /^\/v1\/[a-z_]+\/(query|count|delete-by-query)$/);
            }
            const ev = readDeletionLog(home).byId.get(TARGET)?.lastPurge;
            assert.equal(ev?.status, 'complete');
            assert.equal(ev?.connection, CONN);
            assert.deepEqual((ev?.collections['lore_node'] as { deleted: number }).deleted, 4);

            const list = await cli(w3, home, ['--list']);
            assert.equal(list.exitCode, 0);
            assert.equal(list.reqs, 0, '--list makes no network call');
            assert.match(list.text, new RegExp(`${TARGET}\\s+"old-project"\\s+deleted ${DELETED_AT}.*org ${ORG_A}.*last purge: complete at`));

            const again = await cli(w3, home, [...base, '--apply']);
            assert.equal(again.exitCode, 0);
            assert.equal(again.dels, 0, 'nothing left: zero deletes');
            assert.match(again.text, /APPLY complete: 0 row\(s\)/);
        } finally { await w3.close(); }
    });

    await test('--list marks an id that is live again and tolerates an unreadable registry', async () => {
        const home = mkHome({ registry: { active: 'a', workspaces: [{ name: 'a', id: TARGET, path: '/p/a' }] } });
        const live = await cli(w, home, ['--list'], { env: { LORE_DEPLOYMENT_MODE: undefined } });
        assert.equal(live.exitCode, 0);
        assert.match(live.text, /LIVE AGAIN/);
        const bad = mkHome({ registry: '{' });
        const r = await cli(w, bad, ['--list']);
        assert.equal(r.exitCode, 0);
        assert.match(r.text, /registry unreadable/);
        assert.equal(r.reqs, 0);
        const none = await cli(w, mkHome({ record: null }), ['--list', '--json']);
        assert.deepEqual((JSON.parse(none.out[0]!) as { deletions: unknown[] }).deletions, []);
    });

    /* ─── Guard ─── */
    for (const [label, mutate, re] of [
        ['becomes live between passes', (h: string) => addRegistryEntry(h, { name: 'back', id: TARGET, path: '/p/back' }), /registered again|live in workspaces\.json again/],
        ['becomes unreadable between passes', (h: string) => fs.writeFileSync(regPath(h), '{ torn'), /not valid JSON/],
    ] as const) {
        await test(`the guard aborts (exit 2) when the registry ${label}`, async () => {
            const w4 = await world();
            try {
                await seedAll(w4, A_T, 3);
                const home = mkHome();
                const r = await cli(w4, home, [...base, '--apply'], { client: hookAfterFirstDelete(w4, () => mutate(home)) });
                assert.equal(r.exitCode, 2, r.text);
                assert.match(r.text, /APPLY aborted-guard/);
                assert.match(r.text, re);
                assert.equal(r.dels, 1, 'exactly the first pass deleted; nothing after the guard fired');
                assert.equal(rowsIn(w4, 'lore_edge', isScope(A_T)).length, 0);
                assert.equal(rowsIn(w4, 'lore_version', isScope(A_T)).length, 3);
                assert.equal(rowsIn(w4, 'lore_node', isScope(A_T)).length, 3);
                assert.equal(readDeletionLog(home).byId.get(TARGET)?.lastPurge?.status, 'partial');
            } finally { await w4.close(); }
        });
    }

    /* ─── Unrecorded, min-age, max-rows ─── */
    await test('--unrecorded with the right --confirm-org purges; a recent write in the min-age window refuses', async () => {
        const w5 = await world();
        try {
            await seedAll(w5, A_T, 2);
            const home = mkHome({ record: null });
            const args = [...base, '--unrecorded', '--confirm-org', ORG_A, '--apply'];
            const dry = await cli(w5, home, args.filter((a) => a !== '--apply'));
            assert.equal(dry.exitCode, 0, dry.text);
            assert.match(dry.text, /UNRECORDED/);
            const ok = await cli(w5, home, args);
            assert.equal(ok.exitCode, 0, ok.text);
            assert.equal(countRows(w5, A_T), 0);
            assert.equal(readDeletionLog(home).byId.get(TARGET)?.lastPurge?.status, 'complete', 'the event is written for an unrecorded id too');

            await seed(w5, 'lore_node', A_T, ['fresh'], stamp(new Date(NOW - 3_600_000).toISOString()));
            const refused = await cli(w5, home, args);
            assert.equal(refused.exitCode, 1, refused.text);
            assert.equal(refused.dels, 0);
            assert.match(refused.text, /within the minimum age/);
        } finally { await w5.close(); }
    });

    await test('--min-age 0 allows a fresh record', async () => {
        const w6 = await world();
        try {
            await seedAll(w6, A_T, 2);
            const home = mkHome({ record: { deletedAt: new Date(NOW - 60_000).toISOString() } });
            const r = await cli(w6, home, [...base, '--apply', '--min-age', '0']);
            assert.equal(r.exitCode, 0, r.text);
            assert.equal(countRows(w6, A_T), 0);
            const dry = await cli(w6, mkHome({ record: { deletedAt: new Date(NOW - 60_000).toISOString() } }), base);
            assert.equal(dry.exitCode, 0, 'a dry run only warns');
            assert.match(dry.text, /WARNING: the deletion record is younger than --min-age/);
        } finally { await w6.close(); }
    });

    await test('--max-rows stops with exit 3 and a partial event; a rerun finishes', async () => {
        const w7 = await world();
        try {
            await seedAll(w7, A_T, 5);
            const home = mkHome();
            const r = await cli(w7, home, [...base, '--apply', '--max-rows', '3']);
            assert.equal(r.exitCode, 3, r.text);
            assert.match(r.text, /APPLY max-rows/);
            assert.match(r.text, /re-run the same command/);
            assert.equal(countRows(w7, A_T), 17);
            assert.equal(readDeletionLog(home).byId.get(TARGET)?.lastPurge?.status, 'partial');
            const rerun = await cli(w7, home, [...base, '--apply']);
            assert.equal(rerun.exitCode, 0, rerun.text);
            assert.equal(countRows(w7, A_T), 0);
        } finally { await w7.close(); }
    });

    /* ─── Unkeyed rows, journal failure, --json ─── */
    await test('unkeyed rows are reported with sample ids and left in place (exit 0)', async () => {
        const w8 = await world();
        try {
            await seedAll(w8, A_T, 2);
            const base2 = { org_id: ORG_A, lore_workspace: TARGET, ...OLD };
            await w8.client.insert(DP, 'lore_node', { ...base2, id: 'attacker-chosen', lore_id: 'spoof-1' }, CONN);
            const spoof = rowsIn(w8, 'lore_node', (r) => r['lore_id'] === 'spoof-1');
            assert.equal(spoof.length, 1);
            const r = await cli(w8, mkHome(), [...base, '--apply']);
            assert.equal(r.exitCode, 0, r.text);
            assert.match(r.text, /1 unkeyed row\(s\).*LEFT in place.*spoof-1/);
            assert.deepEqual(rowsIn(w8, 'lore_node', isScope(A_T)), spoof);
        } finally { await w8.close(); }
    });

    await test('a journal write failure is a warning and does not change a finished delete\'s exit code', async () => {
        if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores file modes
        const w9 = await world();
        try {
            await seedAll(w9, A_T, 2);
            const home = mkHome();
            fs.chmodSync(path.join(home, 'workspace-deletions.jsonl'), 0o444);
            const r = await cli(w9, home, [...base, '--apply']);
            assert.equal(r.exitCode, 0, r.text);
            assert.match(r.text, /WARNING: the purge event could not be recorded/);
            assert.equal(countRows(w9, A_T), 0);
        } finally { await w9.close(); }
    });

    await test('--json prints one parsable object and never a credential (dry run and apply)', async () => {
        const w10 = await world();
        try {
            await seedAll(w10, A_T, 3);
            const dry = await cli(w10, mkHome(), [...base, '--json']);
            assert.equal(dry.exitCode, 0, dry.text);
            assert.equal(dry.out.length, 1);
            const d = JSON.parse(dry.out[0]!) as { mode: string; collections: Array<{ collection: string; keyed: number }>; applyWouldRefuse: unknown };
            assert.equal(d.mode, 'dry-run');
            assert.equal(d.collections.find((c) => c.collection === 'lore_node')?.keyed, 3);
            assert.equal(d.applyWouldRefuse ?? null, null);
            assert.equal(dry.dels, 0);

            const apply = await cli(w10, mkHome(), [...base, '--apply', '--json']);
            assert.equal(apply.exitCode, 0, apply.text);
            assert.equal(apply.out.length, 1);
            const a = JSON.parse(apply.out[0]!) as { mode: string; result: { outcome: string; totals: { deleted: number } }; journal: { written: boolean } };
            assert.equal(a.mode, 'apply');
            assert.equal(a.result.outcome, 'complete');
            assert.equal(a.result.totals.deleted, 12);
            assert.equal(a.journal.written, true);
            assert.ok(!JSON.stringify(a).includes(KEY));
        } finally { await w10.close(); }
    });

    await test('a dry run without DATAPLANE_URL is allowed (localhost default shown); --help exits 0 with no request', async () => {
        const r = await cli(w, mkHome(), base, { env: { DATAPLANE_URL: undefined } });
        assert.equal(r.exitCode, 0, r.text);
        assert.match(r.text, /dataplane url\s+: http:\/\/localhost:8080/);
        const h = await cli(w, mkHome(), ['--help']);
        assert.equal(h.exitCode, 0);
        assert.match(h.text, /Usage: lore maintain cloud-purge/);
        assert.equal(h.reqs, 0);
    });
} finally {
    await w.close();
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

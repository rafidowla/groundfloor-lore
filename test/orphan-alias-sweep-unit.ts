#!/usr/bin/env tsx
/**
 * orphan-alias-sweep-unit.ts — 3.27.1: sweep question-alias verbatim rows whose
 * parent graph node is gone (left by 3.27.0 deletes under LORE_SEARCH_WORKER=1).
 *
 *   A — core sweep on BOTH verbatim engines (LanceDB, SQLite): purges exactly the
 *       orphans (+ their #rev history); live aliases, canonical rows, non-alias
 *       ids (`a#qx`, `a#q99999`, a node literally named `foo#q3`) and ids with
 *       `_` / `%` survive; dry run writes nothing; second run purges 0 and commits
 *       0 LanceDB versions; a pending-outbox parent is skipped; a failed graph
 *       read purges nothing; tombstoned aliases are kept unless asked.
 *   B — production wire-up: createLore -> the real `maintain` MCP tool runs the
 *       sweep, in worker mode (real search-worker child, Lance) and on SQLite.
 *   C — the offline CLI: `lore maintain --orphan-alias-sweep` (opt-in, dry-run aware).
 *
 * Run: npx tsx test/orphan-alias-sweep-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { sweepOrphanAliases } from '../packages/lore/src/core/orphanAliasSweep.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { maintainCommand } from '../packages/lore/src/cli/commands/maintain.js';
import type { OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
process.env['LORE_SEARCH_WORKER_READY_MS'] ??= '90000';

const DIM = 8;
class FakeEmbed implements EmbeddingProvider {
    readonly modelId = 'fake-orphan-sweep-test';
    readonly dimension = DIM;
    async initialize(): Promise<void> {}
    private vec(t: string): number[] {
        const o = new Array<number>(DIM).fill(0);
        for (let i = 0; i < t.length; i++) o[i % DIM] += t.charCodeAt(i) / 255;
        const n = Math.hypot(...o) || 1;
        return o.map((x) => x / n);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { return ts.map((t) => this.vec(t)); }
}
const META = { type: 'note', label: 'L', tags: '', project: 'default', ecosystem: '*', updatedAt: '2026-10-03T00:00:00.000Z', security_scopes: [] as string[] };

interface VStore {
    store(doc: { id: string; text: string; metadata: Record<string, unknown> }): Promise<void>;
    getById(id: string): Promise<{ text?: string } | null>;
    getHistory(id: string): Promise<unknown[]>;
    listIds(prefix?: string, opts?: { includeHistory?: boolean }): Promise<string[]>;
}
const rowsOf = async (v: VStore, id: string): Promise<number> => ((await v.getById(id)) ? 1 : 0) + (await v.getHistory(id)).length;
/** 3 writes of one id => the row + 2 `#rev` history rows. */
async function seed(v: VStore, id: string, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) await v.store({ id, text: `body ${i} of ${id}`, metadata: { ...META, updatedAt: `2026-10-03T00:00:0${i}.000Z` } });
}

/** Graph stub: only getNodesByIds is used by the sweep. */
function fakeGraph(live: string[], opts: { fail?: boolean } = {}) {
    const set = new Set(live);
    let calls = 0;
    return {
        get calls() { return calls; },
        async getNodesByIds(ids: string[]): Promise<Map<string, unknown>> {
            calls += 1;
            if (opts.fail) throw new Error('graph down');
            return new Map(ids.filter((i) => set.has(i)).map((i) => [i, { id: i }]));
        },
    };
}
function fakeOutbox(pendingParents: string[], pendingRows: string[] = []): OutboxStore {
    return {
        async queuedVerbatimUpsertIds(_ws: string, ids: string[]) { return ids.filter((i) => pendingRows.includes(i)); },
        async newestNodeUpsertAfter(_ws: string, id: string) { return pendingParents.includes(id) ? { id } : null; },
        async listUnfinished() { return []; },
    } as unknown as OutboxStore;
}

const GHOST_ROWS = ['lore:ghost#q0', 'lore:ghost#q1', 'lore:ghost#q2', 'lore:we_ird%id#q0'];
const SURVIVORS = [
    'lore:live', 'lore:live#q0', 'lore:live#q1',          // live node + its aliases
    'lore:ghost',                                          // canonical row without a graph node: never an alias
    'lore:a#qx', 'lore:a#q99999',                          // not alias-shaped (non-numeric / out of bounds)
    'lore:foo#q3',                                         // canonical row of a node literally named `foo#q3`
    'lore:we_irdXid#q0', 'lore:weXird%id#q0',              // LIKE-wildcard look-alikes of the orphan `we_ird%id`: parents live
];
const LIVE_NODES = ['live', 'foo#q3', 'we_irdXid', 'weXird%id', 'a'];

async function seedAll(v: VStore): Promise<void> {
    await seed(v, 'lore:ghost#q0', 3);                     // + 2 #rev rows that must go with it
    for (const id of [...GHOST_ROWS.slice(1), 'lore:pend#q0', ...SURVIVORS]) await seed(v, id);
}

// ── Section A — core sweep, both engines ────────────────────────────────────
async function sectionA(label: string, make: (dir: string) => VStore & { initialize(): Promise<void>; close(): Promise<void> }, lanceVersion?: (s: unknown) => Promise<number>): Promise<void> {
    console.log(`\nA. core sweep — ${label}\n`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-'));
    const store = make(dir);
    try {
        await store.initialize();
        await seedAll(store);
        const graph = fakeGraph(LIVE_NODES);
        const base = { workspace: 'default', graph, verbatim: store, outboxStore: fakeOutbox(['pend']) };

        await test('dry run counts orphans and writes nothing', async () => {
            const r = await sweepOrphanAliases({ ...base, dryRun: true });
            assert.equal(r.dryRun, true);
            assert.equal(r.purged, 0);
            assert.equal(r.orphans, 5, JSON.stringify(r)); // 4 ghost rows + pend#q0
            assert.equal(r.skippedPending, 1);
            for (const id of GHOST_ROWS) assert.ok(await store.getById(id), `${id} still there`);
            const n0 = await rowsOf(store, 'lore:ghost#q0'); assert.ok(n0 >= 3, `row + #rev history intact (got ${n0})`);
        });

        await test('real run purges exactly the orphans (+ #rev history); everything else survives', async () => {
            const r = await sweepOrphanAliases(base);
            assert.deepEqual([r.purged, r.orphans, r.skippedPending, r.truncated, r.errors], [4, 5, 1, false, []], JSON.stringify(r));
            assert.ok(r.scanned >= 9, `scanned ${r.scanned}`);
            for (const id of GHOST_ROWS) assert.equal(await rowsOf(store, id), 0, `${id} (row + history) gone`);
            for (const id of SURVIVORS) assert.ok(await store.getById(id), `${id} survives`);
            assert.ok(await store.getById('lore:pend#q0'), 'pending-outbox parent skipped');
        });

        await test('second run purges 0 and commits no LanceDB version', async () => {
            const v0 = lanceVersion ? await lanceVersion(store) : 0;
            const r = await sweepOrphanAliases(base);
            assert.equal(r.purged, 0);
            assert.equal(r.skippedPending, 1);
            if (lanceVersion) assert.equal(await lanceVersion(store), v0, 'no new table version');
        });

        await test('once the outbox drains the pending parent is swept', async () => {
            const r = await sweepOrphanAliases({ ...base, outboxStore: fakeOutbox([]) });
            assert.equal(r.purged, 1);
            assert.equal(await store.getById('lore:pend#q0'), null);
        });

        await test('a failed graph read purges nothing and reports the error', async () => {
            await seed(store, 'lore:late#q0');
            const r = await sweepOrphanAliases({ ...base, graph: fakeGraph([], { fail: true }) });
            assert.equal(r.purged, 0);
            assert.ok(r.errors.some((e) => e.includes('graph read failed')), JSON.stringify(r.errors));
            assert.ok(await store.getById('lore:late#q0'));
            for (const id of SURVIVORS) assert.ok(await store.getById(id), `${id} survives`);
        });

        await test('already-tombstoned aliases are kept unless includeTombstoned', async () => {
            await store.store({ id: 'lore:late#q1', text: '[TOMBSTONED 2026-10-03] gone', metadata: { ...META } });
            const r = await sweepOrphanAliases(base);
            assert.equal(r.skippedTombstoned, 1);
            assert.equal(r.purged, 1, 'late#q0 (live text) purged');
            assert.ok(await store.getById('lore:late#q1'));
            const r2 = await sweepOrphanAliases({ ...base, includeTombstoned: true });
            assert.equal(r2.purged, 1);
            assert.equal(await store.getById('lore:late#q1'), null);
        });

        await test('maxOrphans bounds a pass and reports truncated; later passes finish', async () => {
            for (let i = 0; i < 5; i++) await seed(store, `lore:bulk${i}#q0`);
            const r = await sweepOrphanAliases({ ...base, maxOrphans: 2 });
            assert.equal(r.purged, 2);
            assert.equal(r.truncated, true);
            const r2 = await sweepOrphanAliases(base);
            assert.equal(r2.purged, 3);
            assert.equal(r2.truncated, false);
        });
    } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

await sectionA('LanceDB', (d) => new VerbatimStore(d, new FakeEmbed()) as never,
    async (s) => (s as unknown as { table: { version(): Promise<number> } }).table.version());
await sectionA('SQLite', (d) => new SqliteVerbatimStore(d, new FakeEmbed()) as never);

// ── Section B — production wire-up: createLore -> `maintain` tool ───────────
async function sectionB(label: string, vectorEngine: 'lance' | 'sqlite', worker: boolean): Promise<void> {
    console.log(`\nB. createLore + maintain tool — ${label}\n`);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-wire-'));
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: 'default',
        workspaces: [{ name: 'default', path: home, createdAt: '2026-10-03T00:00:00.000Z', graphEngine: 'sqlite', vectorEngine }],
    }, null, 2));
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home, searchWorkerPolicy: () => worker });
    await (lore._daemon.outboxWiring.replicator as { stop(): Promise<void> }).stop();
    try {
        const v = await lore._daemon.getVerbatimResolver()!.getOrOpen('default') as unknown as VStore;
        await test(`verbatim store is ${worker ? 'a worker proxy' : 'in-process'}`, () => {
            assert.equal(v instanceof VerbatimSearchWorkerProxy, worker);
        });
        const r = await lore.nodeUpsert({
            id: 'wlive', workspace: 'default', ecosystem: '*', skipEmbed: true,
            nodeData: { id: 'wlive', type: 'note', label: 'wlive', content: 'wlive body', tags: '', project: 'default', ecosystem: '*', metadata: '{}' },
        });
        assert.ok(r.ok);
        // The 3.27.0 state: alias rows in the store, their parent never in the graph.
        for (const id of ['lore:wlive#q0', 'lore:wghost#q0', 'lore:wghost#q1']) await seed(v, id, id === 'lore:wghost#q0' ? 3 : 1);

        const mcp = lore.createMcpServer();
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await mcp.connect(st);
        const client = new Client({ name: 'oas-test', version: '0.0.1' });
        await client.connect(ct);
        const call = async (args: Record<string, unknown>) => {
            const res = await client.callTool({ name: 'maintain', arguments: args });
            return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { ok: boolean; orphanAliasSweep?: { orphans: number; purged: number; dryRun: boolean; errors: string[] } };
        };

        await test('maintain default dry_run reports the orphans, deletes nothing', async () => {
            const out = await call({});
            assert.equal(out.orphanAliasSweep?.dryRun, true);
            assert.equal(out.orphanAliasSweep?.orphans, 2, JSON.stringify(out));
            assert.equal(out.orphanAliasSweep?.purged, 0);
            assert.ok(await v.getById('lore:wghost#q0'));
        });
        await test('disable:["orphanAliasSweep"] skips it', async () => {
            const out = await call({ dry_run: false, disable: ['orphanAliasSweep'] });
            assert.equal(out.orphanAliasSweep, undefined);
            assert.ok(await v.getById('lore:wghost#q0'), 'untouched');
        });
        await test('maintain dry_run:false purges orphans (+ history), keeps the live alias', async () => {
            const out = await call({ dry_run: false });
            assert.equal(out.ok, true, JSON.stringify(out));
            assert.equal(out.orphanAliasSweep?.purged, 2, JSON.stringify(out));
            assert.equal(await rowsOf(v, 'lore:wghost#q0'), 0);
            assert.equal(await rowsOf(v, 'lore:wghost#q1'), 0);
            assert.ok(await v.getById('lore:wlive#q0'), 'live alias survives');
        });
        await test('a repeat maintain finds nothing', async () => {
            const out = await call({ dry_run: false });
            assert.equal(out.orphanAliasSweep?.orphans, 0);
            assert.equal(out.orphanAliasSweep?.purged, 0);
        });
        await client.close();
    } finally {
        await lore.dispose('test');
        fs.rmSync(home, { recursive: true, force: true });
    }
}

await sectionB('Lance + real search-worker child', 'lance', true);
await sectionB('SQLite, in-process', 'sqlite', false);

// ── Section C — offline CLI `lore maintain --orphan-alias-sweep` ────────────
console.log('\nC. lore maintain --orphan-alias-sweep (CLI)\n');
{
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-cli-'));
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: 'default',
        workspaces: [{ name: 'default', path: home, createdAt: '2026-10-03T00:00:00.000Z', graphEngine: 'sqlite', vectorEngine: 'sqlite' }],
    }, null, 2));
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home, searchWorkerPolicy: () => false });
    await (lore._daemon.outboxWiring.replicator as { stop(): Promise<void> }).stop();
    try {
        const v = await lore._daemon.getVerbatimResolver()!.getOrOpen('default') as unknown as VStore;
        assert.ok((await lore.nodeUpsert({
            id: 'clive', workspace: 'default', ecosystem: '*', skipEmbed: true,
            nodeData: { id: 'clive', type: 'note', label: 'clive', content: 'clive body', tags: '', project: 'default', ecosystem: '*', metadata: '{}' },
        })).ok);
        for (const id of ['lore:clive#q0', 'lore:cghost#q0', 'lore:cghost#q1']) await seed(v, id);
    } finally { await lore.dispose('test'); }

    process.env['LORE_HOME'] = home;
    const out: string[] = [];
    const run = async (args: string[]): Promise<{ exit: number | null; text: string }> => {
        out.length = 0;
        const [oLog, oErr, oExit] = [console.log, console.error, process.exit.bind(process)];
        let exit: number | null = null;
        console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
        console.error = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
        process.exit = ((c?: number) => { exit = c ?? 0; throw new Error('__exit__'); }) as typeof process.exit;
        try { await maintainCommand(['default', '--no-compaction', '--no-version-cleanup', '--no-node-retention', '--no-ephemeral', '--force', ...args]); }
        catch (e) { if ((e as Error).message !== '__exit__') throw e; }
        finally { console.log = oLog; console.error = oErr; process.exit = oExit; }
        return { exit, text: out.join('\n') };
    };
    const peek = async (ids: string[]): Promise<boolean[]> => {
        const s = new SqliteVerbatimStore(home);
        try { await s.initialize(); return await Promise.all(ids.map(async (i) => (await s.getById(i)) !== null)); } finally { await s.close(); }
    };
    try {
        await test('without the flag the CLI sweep does not run (rows kept)', async () => {
            const r = await run([]);
            assert.equal(r.exit, null);
            assert.deepEqual(await peek(['lore:clive#q0', 'lore:cghost#q0']), [true, true]);
        });
        await test('--dry-run counts the orphans, deletes nothing', async () => {
            const r = await run(['--orphan-alias-sweep', '--dry-run']);
            assert.match(r.text, /orphan-alias-sweep default: scanned=3 orphans=2 purged=0 .*\(dry run\)/, r.text);
            assert.deepEqual(await peek(['lore:clive#q0', 'lore:cghost#q0', 'lore:cghost#q1']), [true, true, true]);
        });
        await test('--orphan-alias-sweep purges the orphans, keeps the live alias', async () => {
            const r = await run(['--orphan-alias-sweep']);
            assert.equal(r.exit, null, r.text);
            assert.match(r.text, /orphan-alias-sweep default: scanned=3 orphans=2 purged=2 /, r.text);
            assert.deepEqual(await peek(['lore:clive#q0', 'lore:cghost#q0', 'lore:cghost#q1']), [true, false, false]);
        });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

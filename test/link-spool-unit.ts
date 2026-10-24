#!/usr/bin/env tsx
/**
 * test/link-spool-unit.ts - `lore migrate` -> link-on-arrival hand-off (gap 4).
 *
 * The migrate CLI is a separate process with no LinkService; it leaves node ids in <loreDir>/link-spool and the
 * daemon replays them through signal() when its link service starts.
 *
 *   spool       atomic append, chunking, in-flight .tmp files ignored (and reaped only when stale)
 *   drain       at-most-once (file deleted before signalling), malformed files skipped without blocking the rest
 *   opt-outs    a durable autolink:false recorded before the spool is drained still wins
 *   migrate     migrateV1Sqlite reports imported ids through onNodesEmbedded (apply + verbatimStore only);
 *               a throwing callback cannot fail the migration
 *   daemon      createLinkService (flag on) drains the spool; flag off leaves it untouched
 *   paths       the daemon's loreDir / workspace name are resolved from the workspace registry
 *
 * Run: npx tsx test/link-spool-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { appendLinkSpool, drainLinkSpool, daemonLoreDir, workspaceNameForPath, LINK_SPOOL_DIR } from '../packages/lore/src/link/linkSpool.js';
import { createLinkService, LINK_QUEUE_FILE } from '../packages/lore/src/link/createLinkService.js';
import { SqliteLinkQueue } from '../packages/lore/src/link/sqliteLinkQueue.js';
import { LinkService } from '../packages/lore/src/link/linkService.js';
import { LINK_DEFAULTS, type LinkRuntimeConfig } from '../packages/lore/src/link/linkConfig.js';
import type { LinkBatchResult, Linker, LinkItem } from '../packages/lore/src/link/linkTypes.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { StoredVectorLinker } from '../packages/lore/src/link/storedVectorLinker.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { migrateV1Sqlite } from '../packages/lore/src/engines/v1Migration.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const FAST: LinkRuntimeConfig = { ...LINK_DEFAULTS, quietMs: 0, maxDelayMs: 0, yieldMs: 0, batchSize: 100, maxAttempts: 3 };
class RecordingLinker implements Linker {
    linked: string[] = [];
    async linkBatch(_ws: string, items: LinkItem[]): Promise<LinkBatchResult> {
        for (const i of items) this.linked.push(`${_ws}:${i.id}`);
        return { done: items.map((i) => i.id), retry: [], edgesWritten: items.length, keptExisting: 0, skippedMissingEndpoint: 0, duplicates: [] };
    }
}
const spoolDir = (loreDir: string): string => path.join(loreDir, LINK_SPOOL_DIR);
const files = (loreDir: string): string[] => { try { return fs.readdirSync(spoolDir(loreDir)).sort(); } catch { return []; } };
function svcAt(loreDir: string) {
    fs.mkdirSync(loreDir, { recursive: true });
    const queue = new SqliteLinkQueue(path.join(loreDir, 'q.sqlite'));
    const linker = new RecordingLinker();
    return { queue, linker, svc: new LinkService({ queue, linker, config: FAST }) };
}

console.log('\nspool + drain');
await test('append then drain signals every id under the recorded workspace, and empties the spool', async () => {
    const lore = mkTmp('ls-a-');
    assert.equal(appendLinkSpool(lore, 'wsA', ['n1', 'n2', 'n3']), 3);
    assert.equal(files(lore).length, 1);
    const { svc, linker } = svcAt(lore);
    assert.equal(drainLinkSpool(lore, svc), 3);
    await svc.flush();
    assert.deepEqual(linker.linked.sort(), ['wsA:n1', 'wsA:n2', 'wsA:n3']);
    assert.deepEqual(files(lore), []);
});
await test('large lists are chunked into several files and fully replayed', async () => {
    const lore = mkTmp('ls-big-');
    const ids = Array.from({ length: 12_001 }, (_, i) => `id${i}`);
    assert.equal(appendLinkSpool(lore, 'w', ids), ids.length);
    assert.equal(files(lore).length, 3);
    const { svc, linker } = svcAt(lore);
    assert.equal(drainLinkSpool(lore, svc), ids.length);
    await svc.flush();
    assert.equal(new Set(linker.linked).size, ids.length);
});
await test('empty input, empty workspace, missing dir and unwritable dir are all quiet no-ops', () => {
    const lore = mkTmp('ls-empty-');
    assert.equal(appendLinkSpool(lore, 'w', []), 0);
    assert.equal(appendLinkSpool(lore, '', ['a']), 0);
    assert.equal(drainLinkSpool(path.join(lore, 'nope'), { signal() { throw new Error('unexpected'); } }), 0);
    const blocker = path.join(lore, 'file');
    fs.writeFileSync(blocker, 'x');
    assert.equal(appendLinkSpool(path.join(blocker, 'sub'), 'w', ['a']), 0, 'mkdir under a file fails -> 0, no throw');
});
await test('a writer still mid-write (.tmp) is left alone; a day-old .tmp is reaped; neither is signalled', async () => {
    const lore = mkTmp('ls-tmp-');
    fs.mkdirSync(spoolDir(lore), { recursive: true });
    const fresh = path.join(spoolDir(lore), 'fresh.tmp'), stale = path.join(spoolDir(lore), 'stale.tmp');
    fs.writeFileSync(fresh, '{"v":1,"workspace":"w","ids":["x"]'); fs.writeFileSync(stale, '{');
    const old = new Date(Date.now() - 25 * 3600 * 1000); fs.utimesSync(stale, old, old);
    const sig: string[] = [];
    assert.equal(drainLinkSpool(lore, { signal: (_w, items) => { sig.push(...items.map((i) => i.id)); } }), 0);
    assert.deepEqual(sig, []);
    assert.deepEqual(files(lore), ['fresh.tmp']);
});
await test('at-most-once: the file is gone even when signal() throws, and a bad file does not block the others', async () => {
    const lore = mkTmp('ls-amo-');
    appendLinkSpool(lore, 'w', ['boom']);
    fs.writeFileSync(path.join(spoolDir(lore), '0-bad.json'), 'not json');
    fs.writeFileSync(path.join(spoolDir(lore), '0-ver.json'), '{"v":99,"workspace":"w","ids":["x"]}');
    const errs: string[] = [];
    const got: string[] = [];
    let first = true;
    drainLinkSpool(lore, { signal: (_w, items) => { if (first) { first = false; throw new Error('queue closed'); } got.push(...items.map((i) => i.id)); } }, (m) => errs.push(m));
    assert.deepEqual(files(lore), [], 'every file deleted, none replayable');
    assert.ok(errs.length >= 3, errs.join(' | '));
    appendLinkSpool(lore, 'w', ['ok']);
    drainLinkSpool(lore, { signal: (_w, items) => { got.push(...items.map((i) => i.id)); } });
    assert.deepEqual(got, ['ok']);
});

console.log('\nopt-outs');
const DIM = 4;
class StubEmbed implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'ls-stub'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    async embed(): Promise<number[]> { throw new Error('never'); }
    async embedQuery(): Promise<number[]> { throw new Error('never'); }
    async embedDocument(): Promise<number[]> { throw new Error('never'); }
}
await test('a durable autolink:false recorded for a migrated id is honoured when the spool drains (source and neighbour)', async () => {
    const lore = mkTmp('ls-opt-');
    fs.mkdirSync(lore, { recursive: true });
    const graph = new SqliteGraph(mkTmp('ls-g-'), { workspaceId: 'ls' });
    await graph.initialize();
    const verbatim = new SqliteVerbatimStore(mkTmp('ls-v-'), new StubEmbed());
    await verbatim.initialize();
    const ids = ['private', 'public', 'other'];
    for (const id of ids) await graph.upsertNode({ id, type: 'note', label: id, content: `c ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' } as never);
    const row = (id: string, vector: number[]) => ({ id: `lore:${id}`, label: id, text: `t ${id}`, type: 'note', project: 'p', ecosystem: '*', security_scopes: [], vector, contentHash: `h-${id}`, updatedAt: '2026-10-23T00:00:00.000Z' });
    await verbatim.bulkAddPrebuiltRows([row('private', [1, 0, 0, 0]), row('public', [1, 0.01, 0, 0]), row('other', [1, 0.02, 0, 0])] as never);
    await graph.setLinkOptOuts(['private'], true);
    const linker = new StoredVectorLinker(async () => ({ graph: graph as never, verbatim: verbatim as never }), { minSim: 0.5, k: 5, dupSim: 0.9999, policyVersion: 'test' });
    const queue = new SqliteLinkQueue(path.join(lore, 'q.sqlite'));
    const svc = new LinkService({ queue, linker, config: FAST });
    appendLinkSpool(lore, 'wsA', ['private', 'public']);
    drainLinkSpool(lore, svc);
    await svc.flush();
    const pairs = (await graph.queryEdges({ limit: 100, offset: 0 })).map((e: any) => [e.sourceId, e.targetId].sort().join('|')).sort();
    assert.deepEqual(pairs, ['other|public'], 'public links to other; private is neither a source nor a neighbour');
});

console.log('\nmigrateV1Sqlite callback');
function seedV1(file: string, ids: string[]): void {
    const db = new Database(file);
    db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT, label TEXT, content TEXT, metadata TEXT, tags TEXT, created_at TEXT, updated_at TEXT, project TEXT, ecosystem TEXT);
             CREATE TABLE edges (source_id TEXT, target_id TEXT, relation TEXT, weight REAL, metadata TEXT);`);
    const ins = db.prepare(`INSERT INTO nodes VALUES (?, 'decision', ?, ?, '{}', '', '2024-01-01', '2024-01-01', 'dev', '*')`);
    for (const id of ids) ins.run(id, `label ${id}`, `content ${id}`);
    db.close();
}
const fakeVerbatim = { async initialize() { /* */ }, async store() { /* */ }, async search() { return []; } } as never;
async function runMigrate(o: { apply: boolean; verbatim: boolean; cb: (ids: string[]) => void | Promise<void> }): Promise<{ imported: number }> {
    const dir = mkTmp('ls-mig-');
    const sqlitePath = path.join(dir, 'knowledge.db');
    seedV1(sqlitePath, ['m1', 'm2']);
    fs.mkdirSync(path.join(dir, 'g'));
    const graph = new SqliteGraph(path.join(dir, 'g'), { workspaceId: 'mig' });
    await graph.initialize();
    try {
        const r = await migrateV1Sqlite(graph, { sqlitePath, apply: o.apply, ...(o.verbatim ? { verbatimStore: fakeVerbatim } : {}), onNodesEmbedded: o.cb });
        return { imported: r.nodesImported };
    } finally { await graph.close(); }
}
await test('apply + verbatimStore: callback gets exactly the imported ids, once', async () => {
    const calls: string[][] = [];
    const r = await runMigrate({ apply: true, verbatim: true, cb: (ids) => { calls.push(ids); } });
    assert.equal(r.imported, 2);
    assert.deepEqual(calls, [['m1', 'm2']]);
});
await test('dry-run, or no verbatim store (nothing embedded), never calls back', async () => {
    const calls: string[][] = [];
    await runMigrate({ apply: false, verbatim: false, cb: (ids) => { calls.push(ids); } });
    await runMigrate({ apply: true, verbatim: false, cb: (ids) => { calls.push(ids); } });
    assert.deepEqual(calls, []);
});
await test('a throwing (or rejecting) callback cannot fail the migration', async () => {
    assert.equal((await runMigrate({ apply: true, verbatim: true, cb: () => { throw new Error('disk full'); } })).imported, 2);
    assert.equal((await runMigrate({ apply: true, verbatim: true, cb: async () => { throw new Error('nope'); } })).imported, 2);
});

console.log('\ndaemon start');
const ENV_ON = { LORE_LINK_ON_ARRIVAL: '1' } as NodeJS.ProcessEnv;
const handles = async () => null;
await test('createLinkService (flag on) replays the spool into its durable queue (opt-outs are filtered at link time, not at enqueue)', async () => {
    const lore = mkTmp('ls-svc-');
    appendLinkSpool(lore, 'wsA', ['private', 'a', 'b']);
    const svc = createLinkService({ loreDir: lore, resolveHandles: handles, env: ENV_ON, config: { ...FAST, maxDelayMs: 60_000, quietMs: 60_000 } });
    assert.ok(svc);
    assert.deepEqual(files(lore), []);
    await svc!.drain(1000);
    const check = new SqliteLinkQueue(path.join(lore, LINK_QUEUE_FILE));
    assert.equal(check.counts().ready, 3, 'every spooled id is queued durably; the Linker applies the durable opt-out when it runs');
});
await test('flag off: no service, and the spool is left for a later start', () => {
    const lore = mkTmp('ls-off-');
    appendLinkSpool(lore, 'wsA', ['a']);
    assert.equal(createLinkService({ loreDir: lore, resolveHandles: handles, env: {} as NodeJS.ProcessEnv }), null);
    assert.equal(files(lore).length, 1);
});

console.log('\npaths');
await test('daemonLoreDir follows the active workspace; workspaceNameForPath needs an exact registered path', () => {
    const home = mkTmp('ls-home-');
    const wsB = path.join(home, 'workspaces', 'b');
    assert.equal(daemonLoreDir(home), path.join(home, '.lore'), 'no registry -> home');
    assert.equal(workspaceNameForPath(home, home), null);
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        version: 1, active: 'b', workspaces: [{ name: 'a', path: home }, { name: 'b', path: wsB }],
    }));
    assert.equal(daemonLoreDir(home), path.join(wsB, '.lore'));
    assert.equal(workspaceNameForPath(home, home), 'a');
    assert.equal(workspaceNameForPath(home, path.join(home, 'elsewhere')), null, 'unregistered path -> do not guess');
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

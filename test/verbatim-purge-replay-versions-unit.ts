#!/usr/bin/env tsx
/**
 * verbatim-purge-replay-versions-unit.ts — 3.27.1: replaying `verbatim.purge`
 * outbox rows must not commit empty LanceDB versions.
 *
 * Field symptom (Atlas reindex on 3.27.0): nodeDeleteMany({ purge:true }) of
 * 16,177 nodes left ~16.7k _versions + _transactions files in
 * lore_verbatim.lance (+266 MB) though the live rows were right: every per-node
 * `verbatim.purge` replay ran a LanceDB delete (and a piece-table delete) that
 * matched nothing, and each such delete commits a version.
 *
 * Boots a real embedded `createLore()` (SQLite graph; LanceDB or SQLite
 * verbatim; piece vectors on for LanceDB) with a deterministic fake embedder;
 * the background replicator is stopped so every replay is an explicit
 * `tickOnce()`. Pinned:
 *   - LanceDB: purge of N=300 nodes (a fifth with verbatim rows + #rev history,
 *     some with #q aliases, the rest with no verbatim row) then a full drain:
 *     verbatim + piece table versions grow O(chunks), and the drain adds 0;
 *   - replaying an already-purged row (outbox and direct) adds 0 versions on
 *     both tables;
 *   - consolidation: K adjacent purge rows -> ONE purgeVerbatim (union); a
 *     poison row falls back per row and the rest still apply; a superseded
 *     failed row is marked dead and never dispatched;
 *   - SQLite verbatim: the same purge converges, one purgeWithHistory (one
 *     transaction) per consolidated dispatch;
 *   - neighbour safety: `a#x`, `_` / `%` look-alikes survive.
 *
 * Run: npx tsx test/verbatim-purge-replay-versions-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLore } from '../packages/lore/src/index.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const DIM = 8;
class FakeProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'purge-replay-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private v(text: string): number[] { const out = new Array(DIM).fill(0); for (let i = 0; i < text.length; i++) out[i % DIM] += text.charCodeAt(i) % 7; out[0] += 1; return out; }
    async embedQuery(t: string): Promise<number[]> { return this.v(t); }
    async embed(t: string): Promise<number[]> { return this.v(t); }
    async embedDocument(t: string): Promise<number[]> { return this.v(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { return ts.map((t) => this.v(t)); }
}

const WS = 'default';
const CHUNK = 50; // BULK_LOCK_CHUNK_SIZE (core/nodeWriteLock.ts)
const homes: string[] = [];
type Lore = Awaited<ReturnType<typeof createLore>>;
async function boot(vectorEngine: 'sqlite' | 'lance'): Promise<Lore> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-purge-replay-${vectorEngine}-`));
    homes.push(home);
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: 'default',
        workspaces: [{ name: 'default', path: home, createdAt: '2026-10-03T00:00:00.000Z', graphEngine: 'sqlite', vectorEngine }],
    }, null, 2));
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home, embeddingProvider: new FakeProvider(), pieceVectors: vectorEngine === 'lance' });
    await (lore._daemon.outboxWiring.replicator as { stop(): Promise<void> }).stop();
    return lore;
}
const outbox = (lore: Lore) => lore._daemon.outboxWiring.store;
const pendingRows = (lore: Lore): Promise<OutboxEntry[]> => outbox(lore).listPendingForWorkspace!(WS, 5000);
const tick = (lore: Lore) => (lore._daemon.outboxWiring.replicator as unknown as { tickOnce(): Promise<number> }).tickOnce();
async function drain(lore: Lore): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if ((await pendingRows(lore)).length === 0) return;
        await tick(lore);
    }
    assert.fail(`outbox did not drain: ${JSON.stringify((await pendingRows(lore)).slice(0, 5).map((e) => [e.operationKind, e.status, e.lastError]))}`);
}
type Substrates = { purgeVerbatim?: (ids: string[], ws?: string) => Promise<void> };
/** Wrap the replicator's purgeVerbatim hook; `poison` ids make it throw. */
function spyPurge(lore: Lore, poison?: string): { calls: string[][]; restore(): void } {
    const subs = (lore._daemon.outboxWiring.replicator as unknown as { substrates: Substrates }).substrates;
    const orig = subs.purgeVerbatim!;
    const calls: string[][] = [];
    subs.purgeVerbatim = async (ids, ws) => {
        calls.push([...ids].sort());
        if (poison && ids.includes(poison)) throw new Error(`poisoned purge (${poison})`);
        return orig(ids, ws);
    };
    return { calls, restore: () => { subs.purgeVerbatim = orig; } };
}
const queuePurge = (lore: Lore, id: string) => recordHotWrite(outbox(lore), {
    workspace: WS, operationKind: 'verbatim.purge', initiator: 'test', payload: { id, ids: [id] },
});
const save = (lore: Lore, id: string) => lore.nodeUpsert({
    id, workspace: WS, ecosystem: '*', skipEmbed: true,
    nodeData: { id, type: 'note', label: id, content: `${id} body`, tags: '', project: WS, ecosystem: '*', metadata: '{}' },
});

interface VStore {
    getById(id: string): Promise<{ text?: string } | null>;
    getHistory(id: string): Promise<unknown[]>;
    store(doc: { id: string; text: string; metadata: Record<string, unknown> }): Promise<void>;
    purgeWithHistory(ids: string[]): Promise<number>;
}
const META = { type: 'note', label: 'L', tags: '', project: WS, ecosystem: '*', updatedAt: '2026-10-03T00:00:00.000Z', security_scopes: [] as string[] };
const vstore = async (lore: Lore): Promise<VStore> => await lore._daemon.getVerbatimResolver()!.getOrOpen(WS) as unknown as VStore;
async function seedRows(v: VStore, id: string): Promise<void> {
    for (const t of ['one', 'two', 'three']) await v.store({ id, text: `${t} body of ${id}`, metadata: { ...META, updatedAt: `2026-10-03T00:00:0${t.length}.000Z` } });
}
const rowsOf = async (v: VStore, id: string): Promise<number> => ((await v.getById(id)) ? 1 : 0) + (await v.getHistory(id)).length;
type LTable = { version(): Promise<number> };
const verbatimTable = (v: VStore): LTable => (v as unknown as { table: LTable }).table;
const pieceTable = (v: VStore): LTable | null => (v as unknown as { pieceIndex: { table: LTable | null } }).pieceIndex.table;
const versions = async (v: VStore) => ({ v: await verbatimTable(v).version(), p: (await pieceTable(v)?.version()) ?? -1 });

const N = 300;
const hasRows = (i: number) => i % 5 === 0;
const hasAlias = (i: number) => i % 10 === 0;
/** N graph nodes; a fifth get verbatim rows + history (a tenth also a #q0 alias); neighbours seeded. */
async function prepScenario(lore: Lore, prefix: string): Promise<{ ids: string[]; v: VStore }> {
    const ids = Array.from({ length: N - 1 }, (_, i) => `${prefix}${i}`).concat([`${prefix}w_1`]);
    for (const id of ids) assert.ok((await save(lore, id)).ok, `save ${id}`);
    await drain(lore);
    const v = await vstore(lore);
    for (let i = 0; i < ids.length; i++) {
        if (!hasRows(i) && i !== ids.length - 1) continue;
        await seedRows(v, `lore:${ids[i]}`);
        if (hasAlias(i)) await seedRows(v, `lore:${ids[i]}#q0`);
    }
    await seedRows(v, `lore:${prefix}0#x`);   // another node whose id extends ids[0]
    await seedRows(v, `lore:${prefix}wX1`);   // `_` look-alike of ids[N-1]
    return { ids, v };
}
async function assertScenarioPurged(v: VStore, ids: string[], prefix: string): Promise<void> {
    for (let i = 0; i < ids.length; i++) {
        assert.equal(await rowsOf(v, `lore:${ids[i]}`), 0, `lore:${ids[i]} and history gone`);
        if (hasAlias(i)) assert.equal(await rowsOf(v, `lore:${ids[i]}#q0`), 0, `alias of ${ids[i]} gone`);
    }
    assert.ok((await rowsOf(v, `lore:${prefix}0#x`)) >= 2, `lore:${prefix}0#x survives`);
    assert.ok((await rowsOf(v, `lore:${prefix}wX1`)) >= 2, `lore:${prefix}wX1 survives (LIKE '_' escaped)`);
}

// ── LanceDB ───────────────────────────────────────────────────────────────
{
    console.log('\nembedded createLore - lance verbatim (piece vectors on)\n');
    const lore = await boot('lance');
    try {
        let purgedIds: string[] = [];
        await test(`[lance] purge of ${N} nodes + drain: verbatim/piece versions grow O(chunks), the drain adds 0`, async () => {
            const { ids, v } = await prepScenario(lore, 'rv');
            assert.equal(await v.getById('lore:rv1'), null, 'scenario: most nodes have no verbatim row');
            assert.ok(pieceTable(v), 'piece table is open');
            const before = await versions(v);
            const spy = spyPurge(lore);
            const { results } = await lore.nodeDeleteMany({ ids, workspace: WS, purge: true });
            assert.ok(results.every((r) => r.deleted && r.purged), 'every node deleted + purged');
            const inline = await versions(v);
            const purgeRows = (await pendingRows(lore)).filter((e) => e.operationKind === 'verbatim.purge').length;
            await drain(lore);
            spy.restore();
            const after = await versions(v);
            const dv = after.v - before.v, dp = after.p - before.p;
            const bound = Math.ceil(N / CHUNK) + 3;
            console.log(`        N=${N}: verbatim versions +${dv} (inline +${inline.v - before.v}, drain +${after.v - inline.v}), piece versions +${dp} (drain +${after.p - inline.p}); ${purgeRows} purge rows -> ${spy.calls.length} purgeVerbatim dispatch(es)`);
            assert.equal(purgeRows, ids.length, 'one verbatim.purge row per node (supersession contract)');
            assert.ok(dv <= bound, `verbatim versions +${dv} must be O(chunks) <= ${bound}, not O(N=${N})`);
            assert.ok(dp <= bound, `piece versions +${dp} must be O(chunks) <= ${bound}`);
            assert.equal(after.v, inline.v, 'replaying the already-purged rows commits no verbatim version');
            assert.equal(after.p, inline.p, 'replaying the already-purged rows commits no piece version');
            assert.ok(spy.calls.length <= Math.ceil(N / 10), `${spy.calls.length} dispatches for ${N} rows: consolidated, not per row`);
            await assertScenarioPurged(v, ids, 'rv');
            purgedIds = ids;
        });

        await test('[lance] replaying an already-purged verbatim.purge row adds 0 versions (outbox + direct)', async () => {
            const v = await vstore(lore);
            const before = await versions(v);
            for (const id of purgedIds.slice(0, 5)) await queuePurge(lore, `lore:${id}`);
            await queuePurge(lore, 'lore:rv-never-existed');
            await drain(lore);
            assert.equal(await v.purgeWithHistory(['lore:rv1', 'lore:rv5', 'lore:never']), 0, 'nothing left to remove');
            assert.deepEqual(await versions(v), before, 'no verbatim or piece version committed');
        });

        await test('[lance] K adjacent purge rows -> ONE purgeVerbatim of the union; rows gone', async () => {
            const v = await vstore(lore);
            const ids = ['lore:k0', 'lore:k1', 'lore:k2', 'lore:k3', 'lore:k4'];
            for (const id of ids) await seedRows(v, id);
            const spy = spyPurge(lore);
            for (const id of ids) await queuePurge(lore, id);
            await drain(lore);
            spy.restore();
            assert.deepEqual(spy.calls, [[...ids].sort()], 'one dispatch carrying every row\'s ids');
            for (const id of ids) assert.equal(await rowsOf(v, id), 0, `${id} gone`);
        });

        await test('[lance] a poison row falls back per row; the rest still apply; a superseded failed row is marked dead, never dispatched', async () => {
            const v = await vstore(lore);
            const good = ['lore:d0', 'lore:d1', 'lore:d2'];
            for (const id of [...good, 'lore:poison']) await seedRows(v, id);
            const spy = spyPurge(lore, 'lore:poison');
            await queuePurge(lore, good[0]!); await queuePurge(lore, good[1]!);
            const poisonRow = await queuePurge(lore, 'lore:poison');
            await queuePurge(lore, good[2]!);
            await tick(lore);
            assert.equal(spy.calls.length, 1 + 4, 'one union attempt, then one dispatch per row');
            for (const id of good) assert.equal(await rowsOf(v, id), 0, `${id} purged despite the poison row`);
            // The failed row sits out its SP-21 retry backoff (base 500 ms) before it is listed again.
            let left: OutboxEntry[] = [];
            for (let w = 0; w < 50 && left.length === 0; w++) { await new Promise((r) => setTimeout(r, 100)); left = await pendingRows(lore); }
            assert.deepEqual(left.map((e) => [e.id, e.status, e.attempts]), [[poisonRow.id, 'failed', 1]], 'only the poison row is left, failed once');
            assert.ok(await rowsOf(v, 'lore:poison') >= 2, 'poison rows untouched');
            // A strictly newer REPLICATED purge of the same key supersedes the failed row.
            const newer = await queuePurge(lore, 'lore:poison');
            await outbox(lore).markEntryStatus!(newer.id, 'replicated');
            const fresh = ['lore:e0', 'lore:e1'];
            for (const id of fresh) { await seedRows(v, id); await queuePurge(lore, id); }
            spy.calls.length = 0;
            await tick(lore);
            spy.restore();
            assert.deepEqual(spy.calls, [[...fresh].sort()], 'superseded row dropped; the two survivors dispatched once');
            assert.equal((await pendingRows(lore)).length, 0, 'nothing pending');
            const dead = await outbox(lore).listDead!({ workspace: WS, limit: 50 });
            assert.ok(dead.some((e) => e.id === poisonRow.id), 'superseded poison row is dead');
            for (const id of fresh) assert.equal(await rowsOf(v, id), 0, `${id} gone`);
        });

        await test('[lance] neighbour safety: a#x, `_` / `%` look-alikes survive; a repeat purge commits nothing', async () => {
            const v = await vstore(lore);
            const victims = ['lore:a', 'lore:a_b', 'lore:p%q'];
            const neighbours = ['lore:a#x', 'lore:aXb', 'lore:pZZq', 'lore:a#q0'];
            for (const id of [...victims, ...neighbours]) await seedRows(v, id);
            const removed = await v.purgeWithHistory(victims);
            assert.ok(removed >= 9, `canonical + 2 history rows per victim removed (got ${removed})`);
            for (const id of victims) assert.equal(await rowsOf(v, id), 0, `${id} gone`);
            for (const id of neighbours) assert.ok((await rowsOf(v, id)) >= 2, `${id} survives`);
            const before = await versions(v);
            assert.equal(await v.purgeWithHistory(victims), 0);
            assert.deepEqual(await versions(v), before, 'repeat purge: no version');
        });
    } finally {
        await lore.dispose('test');
    }
}

// ── SQLite verbatim ───────────────────────────────────────────────────────
{
    console.log('\nembedded createLore - sqlite verbatim\n');
    const lore = await boot('sqlite');
    try {
        await test(`[sqlite] purge of ${N} nodes converges; one purgeWithHistory (one transaction) per consolidated dispatch`, async () => {
            const { ids, v } = await prepScenario(lore, 'sv');
            const raw = v as unknown as { purgeWithHistory(ids: string[]): Promise<number> };
            const orig = raw.purgeWithHistory;
            let storeCalls = 0;
            raw.purgeWithHistory = async function (this: unknown, x: string[]) { storeCalls++; return orig.call(this, x); };
            const spy = spyPurge(lore);
            try {
                const { results } = await lore.nodeDeleteMany({ ids, workspace: WS, purge: true });
                assert.ok(results.every((r) => r.deleted && r.purged));
                const inlineCalls = storeCalls;
                await drain(lore);
                console.log(`        sqlite N=${N}: inline ${inlineCalls} store call(s), replay ${spy.calls.length} dispatch(es) -> ${storeCalls - inlineCalls} store call(s)`);
                assert.equal(inlineCalls, Math.ceil(N / CHUNK), 'inline: one store call per chunk');
                assert.equal(storeCalls - inlineCalls, spy.calls.length, 'replay: one store call per dispatch');
                assert.ok(spy.calls.length <= Math.ceil(N / 10), `${spy.calls.length} dispatches for ${N} rows: consolidated`);
            } finally { raw.purgeWithHistory = orig; spy.restore(); }
            await assertScenarioPurged(v, ids, 'sv');
            assert.equal(await v.purgeWithHistory(['lore:sv0', 'lore:sv1']), 0, 'repeat: nothing removed');
        });
    } finally {
        await lore.dispose('test');
    }
}

for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

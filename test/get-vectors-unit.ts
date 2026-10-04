#!/usr/bin/env tsx
/**
 * get-vectors-unit.ts - 3.27.1: engine-neutral `getVectors(ids)`.
 *
 * Store level, on BOTH verbatim engines (LanceDB `VerbatimStore`, `SqliteVerbatimStore`):
 *   - N=24 embedded rows come back as plain number[] equal element-wise to
 *     Float32Array.from(embedded) (both engines store float32);
 *   - a row saved 3x returns ONE key (no `#rev` history key) and the LATEST vector; a
 *     requested `#rev` id and an alias id (`#q0`) match only themselves / nothing extra;
 *   - unknown ids, tombstoned rows, and unembedded rows (all-zero placeholder from
 *     bulkAddPrebuiltRows, and on SQLite a NULL vector) are OMITTED, never an error;
 *   - empty input -> empty Map; > 10,000 ids and non-string ids -> clear error; duplicates collapse;
 *   - no embed call happens (read path only).
 * Cross-engine: identical input -> deepStrictEqual maps.
 * Facade: a real embedded `createLore()` per engine, `lore.getVectors({ ids, workspace })`
 * keyed by NODE id (rows `lore:<id>`), including a node written through nodeUpsert; missing
 * workspace / over-max -> error; a store without getVectors -> GetVectorsUnsupportedError.
 *
 * Run: npx tsx test/get-vectors-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { createLore, GetVectorsUnsupportedError, GET_VECTORS_MAX_IDS } from '../packages/lore/src/index.js';
import { embeddedGetVectors } from '../packages/lore/src/mcp/embeddedGetVectors.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const DIM = 16;
let embedCalls = 0;
/** Deterministic, text-dependent embedding with NON-float32-representable values (so a float32
 *  round-trip is observable) and a non-zero vector for every non-empty text. */
class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'get-vectors-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    vec(text: string): number[] {
        const v = new Array<number>(DIM).fill(0);
        for (let i = 0; i < text.length; i++) v[i % DIM]! += (text.charCodeAt(i) + 0.1) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { embedCalls++; return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { embedCalls++; return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { embedCalls++; return this.vec(t); }
}
const provider = new DetEmbedProvider();
const f32 = (text: string): number[] => Array.from(Float32Array.from(provider.vec(text)));

const dirs: string[] = [];
const tmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const META = { type: 'note', label: 'L', tags: '', project: 'p', ecosystem: '*', updatedAt: '2026-10-03T00:00:00.000Z', security_scopes: [] as string[] };
const N = 24;
const textOf = (i: number): string => `row ${i} body about topic ${i * 7}`;

type Engine = 'lance' | 'sqlite';
async function openStore(engine: Engine): Promise<VerbatimStoreApi> {
    const s = engine === 'lance' ? new VerbatimStore(tmp('gv-lance-'), provider) : new SqliteVerbatimStore(tmp('gv-sqlite-'), provider);
    await s.initialize();
    return s as unknown as VerbatimStoreApi;
}
/** Identical corpus on either engine; returns the ids of the special rows. */
async function seed(s: VerbatimStoreApi, engine: Engine) {
    for (let i = 0; i < N; i++) await s.store({ id: `lore:n${i}`, text: textOf(i), metadata: { ...META } });
    // saved 3x -> two #rev history rows + the latest canonical.
    for (const t of ['hist one', 'hist two body', 'hist three final body']) await s.store({ id: 'lore:hist', text: t, metadata: { ...META } });
    await s.store({ id: 'lore:n0#q0', text: 'alias question for n0', metadata: { ...META } });
    await s.store({ id: 'lore:dead', text: 'soon tombstoned', metadata: { ...META } });
    await s.tombstone('lore:dead', 'test');
    // Unembedded: the all-zero placeholder a bulk loader writes (both engines) ...
    await s.bulkAddPrebuiltRows([{ id: 'lore:zero', label: 'Z', text: 'placeholder row', type: 'note', project: 'p', ecosystem: '*', security_scopes: [], vector: new Array(DIM).fill(0), contentHash: 'z', updatedAt: META.updatedAt }]);
    // ... and, on SQLite only (Lance's schema has no NULL vector), a NULL vector row.
    if (engine === 'sqlite') await s.bulkAddPrebuiltRows([{ id: 'lore:null', label: 'N', text: 'null vector row', type: 'note', project: 'p', ecosystem: '*', security_scopes: [], contentHash: 'n', updatedAt: META.updatedAt }]);
    const hist = await s.getHistory('lore:hist');
    assert.ok(hist.filter((h) => !h.isCanonical).length >= 2, `expected >=2 history rows, got ${JSON.stringify(hist.map((h) => h.id))}`);
    // Lance encodes history in the id (`#rev<ts>`); SQLite keeps the SAME id with is_canonical=0, so a
    // requested id can only name a history row on Lance. A synthetic well-formed #rev id covers both.
    const revIds = [...new Set([...hist.map((h) => h.id).filter((id) => id.includes('#rev')), 'lore:hist#rev2020-01-01T00:00:00.000Z'])];
    return { revIds };
}

const results = new Map<Engine, Map<string, number[]>>();
for (const engine of ['lance', 'sqlite'] as const) {
    console.log(`\nstore level - ${engine}\n`);
    const s = await openStore(engine);
    try {
        const { revIds } = await seed(s, engine);
        const allIds = [
            ...Array.from({ length: N }, (_, i) => `lore:n${i}`), 'lore:hist', ...revIds, 'lore:n0#q0',
            'lore:dead', 'lore:zero', ...(engine === 'sqlite' ? ['lore:null'] : []), 'lore:nope',
        ];
        let got!: Map<string, number[]>;
        embedCalls = 0;
        await test(`[${engine}] one batched call returns exactly the embedded canonical rows`, async () => {
            got = await s.getVectors(allIds);
            assert.ok(got instanceof Map);
            const expectKeys = [...Array.from({ length: N }, (_, i) => `lore:n${i}`), 'lore:hist', 'lore:n0#q0'].sort();
            assert.deepEqual([...got.keys()].sort(), expectKeys);
            assert.equal(embedCalls, 0, 'getVectors must not call the embedder');
        });
        await test(`[${engine}] ${N} vectors are plain number[] equal element-wise to Float32Array.from(embedded)`, () => {
            for (let i = 0; i < N; i++) {
                const v = got.get(`lore:n${i}`)!;
                assert.ok(Array.isArray(v), 'plain Array, not Arrow/TypedArray');
                assert.equal(v.length, DIM);
                assert.deepStrictEqual(v, f32(textOf(i)), `row n${i}`);
            }
        });
        await test(`[${engine}] row saved 3x: one key, no #rev keys, vector is the LATEST`, () => {
            assert.deepStrictEqual(got.get('lore:hist'), f32('hist three final body'));
            for (const r of revIds) assert.equal(got.has(r), false, `history id ${r} must not match`);
            assert.equal([...got.keys()].filter((k) => k.includes('#rev')).length, 0);
        });
        await test(`[${engine}] alias id matches only itself; canonical request does not pull its alias`, async () => {
            assert.deepStrictEqual(got.get('lore:n0#q0'), f32('alias question for n0'));
            const only = await s.getVectors(['lore:n0']);
            assert.deepEqual([...only.keys()], ['lore:n0']);
        });
        await test(`[${engine}] unknown, tombstoned and unembedded (zero/NULL) rows are omitted, not errors`, async () => {
            for (const id of ['lore:nope', 'lore:dead', 'lore:zero', 'lore:null']) assert.equal(got.has(id), false, id);
            const solo = await s.getVectors(['lore:dead', 'lore:zero', 'lore:null', 'lore:nope']);
            assert.equal(solo.size, 0);
        });
        await test(`[${engine}] empty input -> empty Map; duplicates collapse; over-max and bad ids error`, async () => {
            assert.equal((await s.getVectors([])).size, 0);
            const dup = await s.getVectors(['lore:n1', 'lore:n1', 'lore:n1']);
            assert.equal(dup.size, 1);
            await assert.rejects(() => s.getVectors(Array.from({ length: GET_VECTORS_MAX_IDS + 1 }, (_, i) => `lore:x${i}`)), /at most 10000 ids/);
            await assert.rejects(() => s.getVectors([5 as unknown as string]), /non-empty string/);
            // Quotes are escaped (not rejected) on both engines: an injection-shaped id matches nothing.
            assert.equal((await s.getVectors(["lore:n1' OR '1'='1", "lore:x') OR 1=1 --"])).size, 0);
            await assert.rejects(() => s.getVectors(['lore:n1\0']), /NUL byte/);
            assert.equal((await s.getVectors(Array.from({ length: GET_VECTORS_MAX_IDS }, (_, i) => `lore:x${i}`))).size, 0, 'exactly the max is allowed');
        });
        await test(`[${engine}] ids spanning several query chunks (1,300) all resolve`, async () => {
            const rows = Array.from({ length: 1300 }, (_, i) => ({ id: `lore:bulk${i}`, label: 'B', text: `bulk ${i}`, type: 'note', project: 'p', ecosystem: '*', security_scopes: [], vector: provider.vec(`bulk ${i}`), contentHash: `h${i}`, updatedAt: META.updatedAt }));
            await s.bulkAddPrebuiltRows(rows);
            const m = await s.getVectors(rows.map((r) => r.id));
            assert.equal(m.size, 1300);
            assert.deepStrictEqual(m.get('lore:bulk1299'), f32('bulk 1299'));
        });
        results.set(engine, got);
    } finally { await s.close(); }
}

console.log('\ncross-engine\n');
await test('same input on lance and sqlite -> deepStrictEqual maps', () => {
    const a = results.get('lance')!, b = results.get('sqlite')!;
    assert.ok(a && b && a.size === N + 2);
    assert.deepStrictEqual(a, b);
});

// ---------------------------------------------------------------- facade
function seedHome(vectorEngine: Engine): string {
    const home = tmp(`gv-home-${vectorEngine}-`);
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: 'default',
        workspaces: [{ name: 'default', path: home, createdAt: '2026-10-03T00:00:00.000Z', graphEngine: 'sqlite', vectorEngine }],
    }, null, 2));
    return home;
}
const facade = new Map<Engine, Map<string, number[]>>();
for (const engine of ['lance', 'sqlite'] as const) {
    console.log(`\nembedded createLore facade - ${engine} verbatim\n`);
    delete process.env['LORE_HOME']; delete process.env['LORE_GRAPH_PATH'];
    const home = seedHome(engine);
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home, embeddingProvider: new DetEmbedProvider() });
    await (lore._daemon.outboxWiring.replicator as { stop(): Promise<void> }).stop();
    try {
        const v = await lore._daemon.getVerbatimResolver()!.getOrOpen('default') as unknown as VerbatimStoreApi;
        await test(`[${engine}] workspace resolves to the ${engine} engine`, () => {
            assert.equal(v instanceof SqliteVerbatimStore, engine === 'sqlite');
            assert.equal(v instanceof VerbatimStore, engine === 'lance');
        });
        for (let i = 0; i < 6; i++) await v.store({ id: `lore:f${i}`, text: textOf(i), metadata: { ...META } });
        for (const t of ['a', 'bb', 'ccc']) await v.store({ id: 'lore:fh', text: `facade hist ${t}`, metadata: { ...META } });
        await v.store({ id: 'lore:fdead', text: 'to tombstone', metadata: { ...META } });
        await v.tombstone('lore:fdead', 'test');
        await test(`[${engine}] lore.getVectors keyed by NODE id; history/tombstone/unknown omitted`, async () => {
            const ids = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'fh', 'fdead', 'ghost'];
            const m = await lore.getVectors({ ids, workspace: 'default' });
            assert.deepEqual([...m.keys()].sort(), ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'fh']);
            assert.deepStrictEqual(m.get('f3'), f32(textOf(3)));
            assert.deepStrictEqual(m.get('fh'), f32('facade hist ccc'));
            facade.set(engine, m);
        });
        await test(`[${engine}] production path: a node written by nodeUpsert is readable via getVectors`, async () => {
            const res = await lore.nodeUpsert({
                id: 'real1', workspace: 'default', ecosystem: '*',
                nodeData: { id: 'real1', type: 'note', label: 'real1', content: 'a real node written through nodeUpsert', tags: '', project: 'default', ecosystem: '*', metadata: '{}' },
            });
            assert.ok(res.ok, JSON.stringify(res));
            const r = lore._daemon.outboxWiring.replicator as { tickOnce(): Promise<number> };
            let m = new Map<string, number[]>();
            for (let i = 0; i < 40 && m.size === 0; i++) { await r.tickOnce(); m = await lore.getVectors({ ids: ['real1'], workspace: 'default' }); }
            const vec = m.get('real1');
            assert.ok(vec, 'nodeUpsert node has a stored embedding after replay');
            assert.equal(vec.length, DIM);
            assert.ok(vec.some((x) => x !== 0));
        });
        await test(`[${engine}] errors: missing workspace, over-max, non-array, empty ids -> empty Map`, async () => {
            await assert.rejects(() => lore.getVectors({ ids: ['f0'] } as never), /workspace is required/);
            await assert.rejects(() => lore.getVectors({ ids: ['f0'], workspace: '' }), /workspace is required/);
            await assert.rejects(() => lore.getVectors({ ids: Array.from({ length: GET_VECTORS_MAX_IDS + 1 }, (_, i) => `n${i}`), workspace: 'default' }), /at most 10000 ids/);
            await assert.rejects(() => lore.getVectors({ ids: 'f0' as never, workspace: 'default' }), /ids must be an array/);
            assert.equal((await lore.getVectors({ ids: [], workspace: 'default' })).size, 0);
        });
    } finally { await lore.dispose('test'); }
}
await test('facade: same data on lance and sqlite workspaces -> deepStrictEqual maps', () => {
    assert.deepStrictEqual(facade.get('lance'), facade.get('sqlite'));
});
await test('facade: a store without getVectors (cloud) -> GetVectorsUnsupportedError (typed, not an empty Map)', async () => {
    await assert.rejects(
        () => embeddedGetVectors({ ids: ['a'], workspace: 'cloud-ws' }, async () => ({ count: async () => 0 })),
        (e: unknown) => e instanceof GetVectorsUnsupportedError && (e as GetVectorsUnsupportedError).code === 'unsupported_on_engine',
    );
    await assert.rejects(() => embeddedGetVectors({ ids: ['a'], workspace: 'x' }, async () => null), GetVectorsUnsupportedError);
});

// LORE_SEARCH_WORKER isolation: getVectors is in FORWARDED_METHODS, so the proxy must read the
// CHILD's table (the in-process half is dead) and the Map must survive the IPC boundary.
process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';
await test('search-worker proxy forwards getVectors (Map over IPC) and matches an in-process reopen', async () => {
    const home = tmp('gv-proxy-');
    const proxy = new VerbatimSearchWorkerProxy(home);
    await proxy.initialize();
    let viaProxy: Map<string, number[]>;
    try {
        await proxy.store({ id: 'lore:w1', text: 'worker row one about gardening', metadata: { ...META } });
        await proxy.store({ id: 'lore:w2', text: 'worker row two about sailing', metadata: { ...META } });
        await proxy.store({ id: 'lore:w2', text: 'worker row two REVISED', metadata: { ...META } });
        viaProxy = await proxy.getVectors(['lore:w1', 'lore:w2', 'lore:missing']);
        assert.ok(viaProxy instanceof Map);
        assert.deepEqual([...viaProxy.keys()].sort(), ['lore:w1', 'lore:w2']);
        assert.ok(viaProxy.get('lore:w1')!.some((x) => x !== 0));
    } finally { await proxy.close(); }
    const local = new VerbatimStore(home);
    await local.initialize();
    try { assert.deepStrictEqual(await local.getVectors(['lore:w1', 'lore:w2', 'lore:missing']), viaProxy); } finally { await local.close(); }
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env tsx
/**
 * review-j-scopes-datadir-unit.ts — review findings J1-J4 (3.28.0).
 *
 *   J1  `lore migrate workspace-to-workspace` ignored --data-dir (it acted on
 *       the ambient LORE_HOME), took unknown flags silently, and bootstrapped a
 *       workspaces.json on a dry run. Spawned-CLI tests: --data-dir isolation
 *       (the LORE_HOME stand-in stays byte-identical), a dry run / failing run
 *       creates nothing, --apply runs the target guard for BOTH workspaces,
 *       unknown flags are usage errors.
 *   J2  `lore migrate embedding-model` dropped `security_scopes` on every
 *       preserved non-`lore:` row, legacy-stamped the TARGET fingerprint
 *       before anything was migrated, and leaked a store handle.
 *   J3  The piece-index rebuild built every piece with `security_scopes: []`,
 *       so a restricted row's pieces were searchable by anyone.
 *   J4  One unsafe id in a bulkAddPrebuiltRows call rejected the whole call.
 *       Unsafe rows are now skipped, counted and reported; safe rows land.
 *
 * Every home / data root is a throwaway temp directory; nothing touches
 * ~/.groundfloor and no daemon port is probed (LORE_PORT is a free port).
 *
 * Run: npx tsx test/review-j-scopes-datadir-unit.ts
 *      LORE_TEST_VECTOR_ENGINE=sqlite npx tsx test/review-j-scopes-datadir-unit.ts
 */

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lancedb from '@lancedb/lancedb';

import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { openWorkspaceGraph } from '../packages/lore/src/engines/openWorkspaceGraph.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { migrateEmbeddingModel } from '../packages/lore/src/engines/migrateEmbeddingModel.js';
import { getFingerprintPath, readFingerprint } from '../packages/lore/src/engines/embeddingFingerprint.js';
import { buildPieceIndex, type PieceBuildableStore } from '../packages/lore/src/engines/pieces/pieceIndexBuild.js';
import { LanceBulkLoaderAdapter } from '../packages/lore/src/bulkLoader/lanceAdapter.js';
import { makeVerbatimStore, testVectorEngine } from './helpers/testVerbatimStore.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(repoRoot, 'packages/lore/src/cli/index.ts');
const ENGINE = testVectorEngine();

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

function tmp(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-review-j-${label}-`));
}
function rmDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function freePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const a = srv.address();
            const port = typeof a === 'object' && a ? a.port : 0;
            srv.close(() => resolve(port));
        });
    });
}
const port = await freePort(); // never 3847/3848

interface CliRun { status: number | null; stdout: string; stderr: string }
function runCli(args: string[], loreHome: string): CliRun {
    const r = spawnSync(tsxBin, [cliEntry, ...args], {
        env: { ...process.env, LORE_HOME: loreHome, LORE_PORT: String(port), LORE_MODEL_SERVER: '0' },
        encoding: 'utf-8',
        timeout: 120_000,
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Stable digest of a whole directory tree (relative path + content). */
function treeDigest(root: string): string {
    const h = crypto.createHash('sha256');
    const walk = (dir: string): void => {
        for (const name of fs.readdirSync(dir).sort()) {
            const p = path.join(dir, name);
            const st = fs.lstatSync(p);
            h.update(path.relative(root, p) + '\0');
            if (st.isDirectory()) walk(p);
            else if (st.isFile()) h.update(fs.readFileSync(p));
        }
    };
    walk(root);
    return h.digest('hex');
}

/* ════════════════════════════════════════════════════════════════════════
 * J1 — migrate workspace-to-workspace honours --data-dir
 * ════════════════════════════════════════════════════════════════════════ */

/** A home with workspaces `src` (one node `n1`) and `dst` (empty). */
async function seedHome(label: string): Promise<string> {
    const home = tmp(label);
    loadWorkspaces(home);
    const src = createWorkspace('src', {}, home);
    createWorkspace('dst', {}, home);
    const g = openWorkspaceGraph(src.path, { workspaceId: 'src', home });
    await g.initialize();
    await g.upsertNode({ id: 'n1', type: 'note', label: 'one', content: 'c', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
    await g.close();
    return home;
}
async function dstNodeCount(home: string): Promise<number> {
    const entry = loadWorkspaces(home).workspaces.find((w) => w.name === 'dst')!;
    const g = openWorkspaceGraph(entry.path, { workspaceId: 'dst', home });
    await g.initialize();
    try {
        const page = await g.bulkList({ limit: 100 });
        return page.nodes.length;
    } finally { await g.close(); }
}

console.log('Review J1 — migrate workspace-to-workspace --data-dir (spawned CLI)');
console.log('='.repeat(72));

const realHome = await seedHome('real');
const copyHome = await seedHome('copy');
const realDigest0 = treeDigest(realHome);
const W2W = ['migrate', 'workspace-to-workspace'];

await test('J1: --data-dir dry run reads the copy (prints Home:/Registry: first) and leaves LORE_HOME byte-identical', () => {
    const regBefore = fs.readFileSync(path.join(copyHome, 'workspaces.json'));
    const topBefore = fs.readdirSync(copyHome).sort();
    const r = runCli([...W2W, '--from', 'src', '--to', 'dst', '--data-dir', copyHome], realHome);
    assert.equal(r.status, 0, `exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
    assert.match(lines[0]!, new RegExp(`^\\s*Home:\\s+${copyHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `first line is Home: ${lines[0]}`);
    assert.ok(lines[1]!.includes(path.join(copyHome, 'workspaces.json')), `second line is the registry: ${lines[1]}`);
    assert.match(r.stdout, /source scanned:\s+1/);
    assert.equal(treeDigest(realHome), realDigest0, 'LORE_HOME stand-in untouched');
    // Opening a graph read-side may touch its own files; the registry and the home's layout must not change.
    assert.ok(fs.readFileSync(path.join(copyHome, 'workspaces.json')).equals(regBefore), 'registry untouched by a dry run');
    assert.deepEqual(fs.readdirSync(copyHome).sort(), topBefore, 'no new entries in the copy home');
});

await test('J1: --apply --data-dir migrates ONLY the copy; the LORE_HOME stand-in stays byte-identical', async () => {
    const r = runCli([...W2W, '--from', 'src', '--to', 'dst', '--apply', '--data-dir', copyHome], realHome);
    assert.equal(r.status, 0, `exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.equal(treeDigest(realHome), realDigest0, 'LORE_HOME stand-in untouched');
    assert.equal(await dstNodeCount(copyHome), 1, 'the node landed in the copy');
});

await test('J1: a dry run against a home with no workspaces.json creates nothing (LORE_HOME and --data-dir)', () => {
    const empty = tmp('empty');
    const viaDataDir = runCli([...W2W, '--from', 'src', '--to', 'dst', '--data-dir', empty], realHome);
    assert.notEqual(viaDataDir.status, 0, `${viaDataDir.stdout}${viaDataDir.stderr}`);
    assert.deepEqual(fs.readdirSync(empty), [], 'nothing created in the empty data dir (--data-dir)');
    const viaHome = runCli([...W2W, '--from', 'src', '--to', 'dst'], empty);
    assert.notEqual(viaHome.status, 0, `${viaHome.stdout}${viaHome.stderr}`);
    assert.match(viaHome.stderr, /workspaces\.json/);
    assert.deepEqual(fs.readdirSync(empty), [], 'nothing created in an empty LORE_HOME');
    assert.equal(treeDigest(realHome), realDigest0);
    rmDir(empty);
});

await test('J1: --apply refuses a registry that points outside --data-dir, names both paths, writes nothing', () => {
    const outside = tmp('copied-registry');
    fs.copyFileSync(path.join(realHome, 'workspaces.json'), path.join(outside, 'workspaces.json'));
    const entryPath = loadWorkspaces(realHome).workspaces.find((w) => w.name === 'src')!.path;
    const r = runCli([...W2W, '--from', 'src', '--to', 'dst', '--apply', '--data-dir', outside], realHome);
    assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.includes(entryPath), `names the registry path: ${r.stderr}`);
    assert.ok(r.stderr.includes(outside), 'names the data dir');
    assert.equal(treeDigest(realHome), realDigest0, 'real home untouched');
    rmDir(outside);
});

await test('J1: --apply checks the --to workspace too (an unknown destination is refused before any write)', () => {
    const copyDigest = treeDigest(copyHome);
    const r = runCli([...W2W, '--from', 'src', '--to', 'nope', '--apply', '--data-dir', copyHome], realHome);
    assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /'nope' is not in/);
    assert.equal(treeDigest(copyHome), copyDigest, 'copy untouched');
    assert.equal(treeDigest(realHome), realDigest0);
});

await test('J1: unknown flags (a --data-dir typo, a stray flag) are usage errors that write nothing', () => {
    const copyDigest = treeDigest(copyHome);
    for (const args of [
        [...W2W, '--from', 'src', '--to', 'dst', '--apply', '--data-dri', copyHome],
        [...W2W, '--from', 'src', '--to', 'dst', '--dryrun'],
    ]) {
        const r = runCli(args, realHome);
        assert.equal(r.status, 1, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /unknown flag/);
    }
    assert.equal(treeDigest(realHome), realDigest0);
    assert.equal(treeDigest(copyHome), copyDigest);
});

/* ════════════════════════════════════════════════════════════════════════
 * J2 — migrate embedding-model keeps security_scopes + fingerprint integrity
 * ════════════════════════════════════════════════════════════════════════ */

function stubProvider(modelId: string, dimension: number, seedMult: number) {
    const vec = (t: string): number[] => new Array(dimension).fill(0).map((_, i) => (t.length + i * seedMult) % 7);
    return {
        modelId,
        dimension,
        dtype: 'fp32',
        async initialize() { /* no-op */ },
        async embed(t: string) { return vec(t); },
        async embedQuery(t: string) { return vec(t); },
        async embedDocument(t: string) { return vec(t); },
    };
}
const NOW = new Date().toISOString();
const rowMeta = (extra: Record<string, unknown> = {}) =>
    ({ type: 'note', label: 'l', tags: '', project: 'w', ecosystem: '*', updatedAt: NOW, security_scopes: [] as string[], ...extra });

console.log('\nReview J2 — migrate embedding-model scopes + fingerprint (Lance)');
console.log('='.repeat(72));

/** Seed a Lance table: scoped non-lore row, public non-lore row, a scoped graph node + its lore: row. */
async function seedEmbeddingBase(opts: { stripFingerprint: boolean }): Promise<{ base: string; graph: SurrealGraph }> {
    const base = tmp('j2');
    fs.mkdirSync(path.join(base, '.lore'), { recursive: true });
    const graph = new SurrealGraph(base, { workspaceId: 'w' });
    await graph.initialize();
    await graph.upsertNode({
        id: 'gnode', type: 'decision', label: 'Label gnode', content: 'Content gnode', tags: ['alpha'],
        project: 'p', ecosystem: '*', metadata: '{}', security_scopes: ['team-a'],
    } as unknown as Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>);
    const seed = new VerbatimStore(base, stubProvider('old-model', 8, 1) as never);
    await seed.initialize();
    await seed.store({ id: 'lore:gnode', text: 'Content gnode', metadata: rowMeta({ security_scopes: ['team-a'] }) });
    await seed.store({ id: 'gmail:scoped', text: 'a restricted email only team-a may see', metadata: rowMeta({ security_scopes: ['team-a', 'team-b'] }) });
    await seed.store({ id: 'gmail:public', text: 'a public note', metadata: rowMeta() });
    await seed.close();
    if (opts.stripFingerprint) fs.rmSync(getFingerprintPath(base), { force: true });
    return { base, graph };
}
async function scopesOf(base: string, id: string, provider: unknown): Promise<string[] | null> {
    const s = new VerbatimStore(base, provider as never);
    await s.initialize();
    try {
        const row = await s.getById(id);
        return row ? [...(row.security_scopes ?? [])].sort() : null;
    } finally { await s.close(); }
}

await test('J2: a scoped non-lore: row and a scoped lore: row keep their scopes; the target fingerprint lands only after success', async () => {
    if (ENGINE === 'sqlite') { console.log('  (skipped on sqlite — migrateEmbeddingModel is Lance-only)'); return; }
    const { base, graph } = await seedEmbeddingBase({ stripFingerprint: false });
    try {
        assert.equal(readFingerprint(base)?.modelId, 'old-model', 'sanity: source fingerprint');
        const target = stubProvider('new-model', 8, 2);
        const res = await migrateEmbeddingModel(base, graph as never, { targetModelId: 'new-model', targetDimension: 8, targetProvider: target as never });
        assert.equal(res.skipped, false);
        assert.equal(res.nonNodeRowsPreserved, 2);
        assert.deepEqual(await scopesOf(base, 'gmail:scoped', target), ['team-a', 'team-b'], 'scoped non-lore: row kept its scopes');
        assert.deepEqual(await scopesOf(base, 'gmail:public', target), [], 'public row stays public');
        assert.deepEqual(await scopesOf(base, 'lore:gnode', target), ['team-a'], 'scoped lore: row kept its scopes');
        assert.equal(readFingerprint(base)?.modelId, 'new-model', 'fingerprint is the target model after success');
    } finally { await graph.close().catch(() => undefined); rmDir(base); }
});

await test('J2: on an aborted run the source fingerprint is unchanged (fingerprinted source, same-dimension target)', async () => {
    if (ENGINE === 'sqlite') { console.log('  (skipped on sqlite)'); return; }
    const { base, graph } = await seedEmbeddingBase({ stripFingerprint: false });
    try {
        const before = fs.readFileSync(getFingerprintPath(base), 'utf8');
        const res = await migrateEmbeddingModel(base, graph as never, {
            targetModelId: 'new-model', targetDimension: 8, targetProvider: stubProvider('new-model', 8, 2) as never,
            shouldAbort: () => true,
        });
        assert.equal(res.aborted, true);
        assert.equal(res.fingerprintWritten, false);
        assert.equal(fs.readFileSync(getFingerprintPath(base), 'utf8'), before, 'fingerprint bytes identical to the source');
    } finally { await graph.close().catch(() => undefined); rmDir(base); }
});

await test('J2: the pre-drop read does not legacy-stamp the target onto an unfingerprinted table, even when the run aborts', async () => {
    if (ENGINE === 'sqlite') { console.log('  (skipped on sqlite)'); return; }
    const { base, graph } = await seedEmbeddingBase({ stripFingerprint: true });
    try {
        assert.equal(readFingerprint(base), null, 'sanity: legacy table, no fingerprint');
        const res = await migrateEmbeddingModel(base, graph as never, {
            targetModelId: 'new-model', targetDimension: 8, targetProvider: stubProvider('new-model', 8, 2) as never,
            shouldAbort: () => true,
        });
        assert.equal(res.aborted, true);
        assert.equal(readFingerprint(base), null, 'no fingerprint was stamped — the source state is unchanged');
    } finally { await graph.close().catch(() => undefined); rmDir(base); }
});

await test('J2: every VerbatimStore the migration opens is closed', async () => {
    if (ENGINE === 'sqlite') { console.log('  (skipped on sqlite)'); return; }
    const { base, graph } = await seedEmbeddingBase({ stripFingerprint: false });
    const proto = VerbatimStore.prototype as unknown as { initialize: () => Promise<void>; close: () => Promise<void> };
    const origInit = proto.initialize;
    const origClose = proto.close;
    let inits = 0; let closes = 0;
    proto.initialize = async function (this: unknown) { inits++; return origInit.call(this); };
    proto.close = async function (this: unknown) { closes++; return origClose.call(this); };
    try {
        await migrateEmbeddingModel(base, graph as never, { targetModelId: 'new-model', targetDimension: 8, targetProvider: stubProvider('new-model', 8, 2) as never });
        assert.ok(inits >= 2, `expected the probe + migration stores to open, saw ${inits}`);
        assert.equal(closes, inits, `every opened store is closed (opened ${inits}, closed ${closes})`);
    } finally {
        proto.initialize = origInit; proto.close = origClose;
        await graph.close().catch(() => undefined); rmDir(base);
    }
});

/* ════════════════════════════════════════════════════════════════════════
 * J3 — piece-index rebuild carries security_scopes
 * ════════════════════════════════════════════════════════════════════════ */

console.log('\nReview J3 — piece-index rebuild carries security_scopes');
console.log('='.repeat(72));

await test('J3: pieces rebuilt from a scoped row keep its scopes; an actor without the scope gets no piece hit', async () => {
    const dir = tmp('j3');
    fs.mkdirSync(path.join(dir, '.lore'), { recursive: true });
    const provider = stubProvider('j3-model', 8, 3);
    const store = makeVerbatimStore(dir, provider as never, { pieceVectors: true });
    await store.initialize();
    try {
        const label = 'Restricted Roadmap';
        const body = Array.from({ length: 120 }, (_, i) => `sentence ${i} about the confidential roadmap.`).join(' ');
        await store.store({ id: 'scoped-1', text: body, metadata: rowMeta({ label, security_scopes: ['team-a'] }) });
        const q = await provider.embedDocument(label);
        const search = (scopes: string[]) =>
            (store as unknown as { searchPieces(v: number[], k: number, f?: unknown, s?: string[]): Promise<Array<{ nodeId: string }>> }).searchPieces(q, 5, undefined, scopes);

        // Baseline (live write path): scoped actor sees it, unscoped does not.
        assert.ok((await search(['team-a'])).some((h) => h.nodeId === 'scoped-1'), 'live pieces: scoped actor finds it');
        assert.ok(!(await search(['other'])).some((h) => h.nodeId === 'scoped-1'), 'live pieces: unscoped actor does not');

        // Drop the piece index, then rebuild it from the canonical rows.
        await buildPieceIndex(dir, store as unknown as PieceBuildableStore, provider, { drop: true });
        const rebuilt = await buildPieceIndex(dir, store as unknown as PieceBuildableStore, provider, { force: true });
        assert.equal(rebuilt.action, 'built', JSON.stringify(rebuilt));
        assert.ok(rebuilt.piecesIndexed > 0, 'the rebuild produced pieces');

        assert.ok((await search(['team-a'])).some((h) => h.nodeId === 'scoped-1'), 'rebuilt pieces: scoped actor finds it');
        assert.ok(!(await search(['other'])).some((h) => h.nodeId === 'scoped-1'), 'rebuilt pieces: an actor without the scope gets no hit');
        assert.ok(!(await search([])).some((h) => h.nodeId === 'scoped-1'), 'rebuilt pieces: an actor with no scopes gets no hit');
    } finally { await store.close(); rmDir(dir); }
});

/* ════════════════════════════════════════════════════════════════════════
 * J4 — bulk add skips + reports unsafe ids instead of rejecting the call
 * ════════════════════════════════════════════════════════════════════════ */

console.log('\nReview J4 — bulkAddPrebuiltRows skips and reports unsafe ids');
console.log('='.repeat(72));

const DIM = 8;
const prow = (id: string, extra: Record<string, unknown> = {}) => ({
    id, text: `text of ${id}`, label: id, type: 'note', project: '', ecosystem: '', security_scopes: [] as string[],
    vector: new Array(DIM).fill(0), contentHash: crypto.createHash('sha256').update(id).digest('hex'), ...extra,
});
const UNSAFE = ['', 'bad\0id', 'x'.repeat(600)];

async function lanceIds(dir: string): Promise<string[]> {
    const conn = await lancedb.connect(path.join(dir, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { return (await t.query().select(['id']).toArray()).map((r) => String(r.id)).sort(); } finally { t.close(); }
    } finally { conn.close(); }
}

await test('J4: a mixed batch writes the safe rows once each, skips the unsafe rows and reports count + ids', async () => {
    const dir = tmp('j4');
    fs.mkdirSync(path.join(dir, '.lore'), { recursive: true });
    const store = makeVerbatimStore(dir, stubProvider('j4', DIM, 1) as never);
    await store.initialize();
    try {
        // Fresh table (create branch).
        const r1 = await store.bulkAddPrebuiltRows([prow('ok-1'), prow(UNSAFE[0]!), prow('ok-2'), prow(UNSAFE[1]!), prow(UNSAFE[2]!)]);
        if (ENGINE === 'sqlite') {
            assert.deepEqual(r1, { rejectedCount: 0, rejectedIds: [] }, 'sqlite binds ids as parameters: nothing is rejected, same result shape');
            return;
        }
        assert.equal(r1.rejectedCount, 3);
        assert.equal(r1.rejectedIds.length, 3);
        assert.ok(r1.rejectedIds.includes('') && r1.rejectedIds.includes('bad\0id'), JSON.stringify(r1.rejectedIds));
        assert.deepEqual(await lanceIds(dir), ['ok-1', 'ok-2'], 'only the safe rows exist, once each');

        // Existing table (fresh + upsert branches): one existing id re-added, one new, one unsafe.
        const r2 = await store.bulkAddPrebuiltRows([prow('ok-1', { text: 'ok-1 v2' }), prow('ok-3'), prow('bad\0id')]);
        assert.equal(r2.rejectedCount, 1);
        assert.deepEqual(r2.rejectedIds, ['bad\0id']);
        assert.deepEqual(await lanceIds(dir), ['ok-1', 'ok-2', 'ok-3'], 'each safe id exactly once');
        assert.equal((await store.getById('ok-1'))?.text, 'ok-1 v2', 'the existing id was upserted');

        // A fully safe batch reports nothing rejected.
        assert.deepEqual(await store.bulkAddPrebuiltRows([prow('ok-4')]), { rejectedCount: 0, rejectedIds: [] });
    } finally { await store.close(); rmDir(dir); }
});

await test('J4: an all-unsafe batch writes nothing and does not throw; the reported id list is capped at 20', async () => {
    if (ENGINE === 'sqlite') { console.log('  (skipped on sqlite — no id is rejected there)'); return; }
    const dir = tmp('j4b');
    fs.mkdirSync(path.join(dir, '.lore'), { recursive: true });
    const store = makeVerbatimStore(dir, stubProvider('j4', DIM, 1) as never);
    await store.initialize();
    try {
        const many = Array.from({ length: 45 }, (_, i) => prow(`bad\0${i}`));
        const r = await store.bulkAddPrebuiltRows(many);
        assert.equal(r.rejectedCount, 45, 'the count is exact');
        assert.equal(r.rejectedIds.length, 20, 'the list is capped at 20');
        assert.equal(await store.count(), 0, 'nothing written');
        // And against an existing table.
        await store.bulkAddPrebuiltRows([prow('keep')]);
        const r2 = await store.bulkAddPrebuiltRows([prow('bad\0a'), prow('bad\0b')]);
        assert.equal(r2.rejectedCount, 2);
        assert.deepEqual(await lanceIds(dir), ['keep']);
    } finally { await store.close(); rmDir(dir); }
});

await test('J4: through the bulk-loader adapter (as mcp/server.ts wires it) the safe rows land and the skipped ones are reported', async () => {
    if (ENGINE === 'sqlite') { console.log('  (skipped on sqlite)'); return; }
    const dir = tmp('j4c');
    fs.mkdirSync(path.join(dir, '.lore'), { recursive: true });
    const store = new VerbatimStore(dir, stubProvider('j4', DIM, 1) as never);
    await store.initialize();
    try {
        const adapter = new LanceBulkLoaderAdapter({
            vectorDim: DIM,
            addRows: async (rows) => store.bulkAddPrebuiltRows(rows as unknown as Array<Record<string, unknown>>),
            deleteIds: async (ids) => { await store.physicalDeleteMany(ids); },
        });
        await adapter.begin({ workspace: 'w', embed: 'skip', jobId: 'j', baseRowIndex: 0 });
        const res = await adapter.writeBatch([
            { id: 'a-1', text: 'one', workspace: 'w' },
            { id: 'bad\0x', text: 'two', workspace: 'w' },
            { id: 'a-2', text: 'three', workspace: 'w' },
        ]);
        assert.equal(res.written, 2, JSON.stringify(res));
        assert.equal(res.failed, 1);
        assert.equal(res.errors[0]?.errorMessage, 'unsafe_id_skipped');
        assert.equal(res.errors[0]?.rowIndex, 1);
        assert.deepEqual(await lanceIds(dir), ['a-1', 'a-2']);
    } finally { await store.close(); rmDir(dir); }
});

rmDir(realHome);
rmDir(copyHome);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

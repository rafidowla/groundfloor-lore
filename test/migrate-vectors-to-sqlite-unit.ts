#!/usr/bin/env tsx
/**
 * migrate-vectors-to-sqlite-unit.ts — 3.27.1 `lore migrate-vectors <ws>
 * --to sqlite` (engines/migrateVectorsToSqlite.ts + cli/commands/migrateVectors.ts).
 *
 *   A. Happy path through the REAL production path: an embedded createLore()
 *      on a lance-vector home writes nodes (one saved 3x -> history, one with
 *      questions[] -> #q alias rows); a tombstone + an unembedded (zero
 *      placeholder) row are added; recall is captured; migrate; a fresh
 *      createLore() serves SqliteVerbatimStore via the real verbatim
 *      resolver and recall returns identical results. Counts by kind, the
 *      digest, vectors (independently, byte-for-byte) all equal; zero
 *      embedder calls; registry flipped; Lance table rows untouched.
 *   B. Refusals: live daemon (fake /api/health in a child, as
 *      migrate-graph's test), non-lance source, lance without a store,
 *      non-empty target without --force (and --force moves it aside), over
 *      the promotion threshold.
 *   C. Crash safety: injected failure in import and in verify -> registry
 *      still lance, Lance untouched, partial verbatim.sqlite removed.
 *   D. --dry-run writes nothing. E. The CLI end to end (subprocess, LORE_PORT
 *      on a free port so the daemon probe never touches :3847).
 *
 * Run: npx tsx test/migrate-vectors-to-sqlite-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';

import { createWorkspace, loadWorkspaces, getWorkspacePath, setWorkspaceVectorEngine } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceVectorEngine } from '../packages/lore/src/engines/vectorEngineSelector.js';
import { migrateVectorsToSqlite } from '../packages/lore/src/engines/migrateVectorsToSqlite.js';
import { mapLanceRow, digestOfHashes } from '../packages/lore/src/engines/migrateVectorsRows.js';
import { lanceRowId, type SourceRow } from '../packages/lore/src/engines/verbatimPromotionStage.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { openSqliteVerbatimDb } from '../packages/lore/src/engines/sqliteVerbatimSchema.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { NullEmbeddingProvider } from '../packages/lore/src/providers/nullEmbeddingProvider.js';

// New workspaces (incl. createLore's fresh 'default') are born lance here —
// the source engine this migration moves away from.
process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
delete process.env['LORE_SEARCH_WORKER'];

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const freshHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migvec-home-'));
const outDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migvec-out-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await cond()) return; await sleep(50); }
    throw new Error(`waitFor timed out: ${label}`);
}

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'migvec-det';
    readonly dtype = 'fp32';
    calls = 0;
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        this.calls++;
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[(i * 7 + text.charCodeAt(i)) % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
}

async function lanceRawRows(wsPath: string): Promise<Record<string, unknown>[]> {
    const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { return (await t.query().toArray()) as Record<string, unknown>[]; } finally { t.close(); }
    } finally { conn.close(); }
}
async function lanceDigest(wsPath: string): Promise<string> {
    return digestOfHashes((await lanceRawRows(wsPath)).map((r) => mapLanceRow(r, 'x').hash));
}
const sqlitePathOf = (wsPath: string): string => path.join(wsPath, '.lore', 'verbatim.sqlite');

/** Small lance workspace written through the real VerbatimStore. */
async function buildLanceWs(home: string, name: string, n = 3): Promise<string> {
    const entry = createWorkspace(name, {}, home);
    assert.equal(entry.vectorEngine, 'lance');
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    for (let i = 0; i < n; i++) await s.store({ id: `${name}-d${i}`, text: `document ${i} about harbours and ferries`, metadata: { type: 'note', label: `d${i}` } });
    await s.close();
    return entry.path;
}

console.log('MIGRATE-VECTORS LanceDB -> SQLite — 3.27.1\n');

const { createLore } = await import('../packages/lore/src/index.js');
type Lore = Awaited<ReturnType<typeof createLore>>;
const RECALLS: Array<[string, 'keyword' | 'semantic']> = [
    ['lighthouse', 'keyword'], ['tide tables', 'keyword'],
    ['a lighthouse keeper records the tide tables every morning', 'semantic'], ['ferry timetable for the harbour', 'semantic'],
];
async function recallIds(lore: Lore): Promise<string[][]> {
    const out: string[][] = [];
    for (const [q, mode] of RECALLS) {
        const r = await lore.recall(q, { workspace: 'default', mode: 'full', searchMode: mode }) as unknown as { knowledge?: Array<{ id: string }> };
        out.push((r.knowledge ?? []).map((x) => x.id));
    }
    return out;
}

await test('happy path: real createLore before/after, every row kind carried, digest + vectors equal, registry flipped, resolver serves SQLite, recall equal, zero embeds', async () => {
    const dataDir = freshHome();
    const provider = new DetEmbedProvider();
    let lore: Lore | undefined = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: provider });
    const wsPath = getWorkspacePath('default', dataDir);
    try {
        assert.equal(resolveWorkspaceVectorEngine('default', dataDir), 'lance');
        const docs: Array<[string, string]> = [
            ['n-light', 'a lighthouse keeper records the tide tables every morning'],
            ['n-ferry', 'the ferry timetable for the harbour changes in winter'],
            ['n-gull', 'gulls nest on the cliffs above the lighthouse'],
            ['n-tomb', 'obsolete note about the old pier lighthouse'],
        ];
        for (const [id, content] of docs) {
            assert.ok((await lore.nodeUpsert({ id, workspace: 'default', ecosystem: '*', nodeData: { type: 'note', label: id, content } })).ok);
        }
        for (let i = 1; i <= 3; i++) {
            assert.ok((await lore.nodeUpsert({ id: 'n-hist', workspace: 'default', ecosystem: '*', nodeData: { type: 'note', label: 'hist', content: `harbour master log revision ${i} lighthouse` } })).ok);
        }
        assert.ok((await lore.nodeUpsert({
            id: 'n-q', workspace: 'default', ecosystem: '*', nodeData: { type: 'note', label: 'q', content: 'buoys mark the channel into the harbour' },
            questions: ['where is the channel marked', 'what do buoys do'],
        } as Parameters<Lore['nodeUpsert']>[0] & { questions: string[] })).ok);
        const outbox = lore._daemon.outboxWiring.store;
        await waitFor(async () => (await outbox.aggregateStats!()).depth === 0, 20_000, 'outbox drains');
    } finally { await lore.dispose(); lore = undefined; }

    // Tombstone + an unembedded (zero-placeholder) row, straight on the Lance store.
    const ids = (await lanceRawRows(wsPath)).map((r) => String(r.id));
    const tombId = ids.find((id) => id.includes('n-tomb') && !id.includes('#'));
    assert.ok(tombId, `n-tomb verbatim row present (ids: ${ids.join(',')})`);
    const direct = new VerbatimStore(wsPath, provider);
    await direct.initialize();
    await direct.tombstone(tombId!, 'migrate-vectors test');
    await direct.bulkAddPrebuiltRows([{ vector: new Array(8).fill(0), id: 'raw-unembedded', text: 'unembedded row about anchors', type: 'note', label: 'raw', tags: '', project: '', ecosystem: '*', updatedAt: '2026-10-03T00:00:00.000Z', security_scopes: [], contentHash: 'h-raw' }]);
    await direct.close();

    lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: provider });
    let before: string[][];
    try { before = await recallIds(lore); } finally { await lore.dispose(); lore = undefined; }
    assert.ok(before.some((r) => r.length > 0), `recall returned something before migrating (${JSON.stringify(before)})`);

    const lanceRows = await lanceRawRows(wsPath);
    const digestBefore = await lanceDigest(wsPath);
    let embedCalls = 0;
    const callsBefore = provider.calls;
    const report = await migrateVectorsToSqlite({ workspaceName: 'default', home: dataDir, backupOutDir: outDir(), skipDaemonCheck: true, onEmbedCall: () => { embedCalls++; } });
    assert.equal(embedCalls, 0, 'migration never called the embedder');
    assert.equal(provider.calls, callsBefore, 'host provider untouched by the migration');
    assert.ok(report.counts.history >= 2, `history rows carried (${JSON.stringify(report.counts)})`);
    assert.ok(report.counts.alias >= 2, `#q alias rows carried (${JSON.stringify(report.counts)})`);
    assert.ok(report.tombstones >= 1 && report.unembedded >= 1, `tombstone + unembedded counted (${report.tombstones}/${report.unembedded})`);
    assert.equal(report.counts.canonical + report.counts.history + report.counts.alias, lanceRows.length);
    assert.equal(resolveWorkspaceVectorEngine('default', dataDir), 'sqlite', 'registry flipped');
    assert.equal(await lanceDigest(wsPath), digestBefore, 'Lance rows untouched');
    assert.ok(report.backup && fs.existsSync(report.backup.tarballPath), 'backup tarball written');
    assert.ok(report.probeDetails.length > 0 && !report.probeDetails.some((d) => d.startsWith('MISMATCH')), report.probeDetails.join('; '));

    // Independent byte-level check (not the engine's own hash): every Lance
    // row has a SQLite row with the same Lance id, text and float32 bytes.
    const db = new Database(sqlitePathOf(wsPath), { readonly: true });
    try {
        const rows = db.prepare('SELECT * FROM verbatim').all() as Array<SourceRow & { is_tombstone: number }>;
        assert.equal(rows.length, lanceRows.length, 'row count equal');
        const byLanceId = new Map(rows.map((r) => [lanceRowId(r), r]));
        for (const l of lanceRows) {
            const s = byLanceId.get(String(l.id));
            assert.ok(s, `sqlite row for ${String(l.id)}`);
            assert.equal(s!.text, l.text);
            const lv = Float32Array.from((l.vector as { toArray(): Float32Array }).toArray());
            if (lv.every((x) => x === 0)) assert.equal(s!.vector, null, `${String(l.id)} placeholder -> NULL`);
            else assert.ok(Buffer.from(lv.buffer).equals(s!.vector!), `${String(l.id)} vector bit-equal`);
        }
        assert.equal(byLanceId.get(tombId!)!.is_tombstone, 1, 'tombstone flag set');
        const fts = db.prepare(`SELECT count(*) AS c FROM verbatim_fts WHERE verbatim_fts MATCH 'anchors'`).get() as { c: number };
        assert.ok(fts.c >= 1, 'FTS populated by the import');
        const hasPieces = db.prepare(`SELECT name FROM sqlite_master WHERE name='verbatim_pieces'`).get();
        const pieceRows = hasPieces ? (db.prepare('SELECT count(*) AS c FROM verbatim_pieces').get() as { c: number }).c : 0;
        assert.equal(pieceRows, report.pieces, 'piece index carried row-for-row');
        console.log(`    (${lanceRows.length} verbatim rows, ${pieceRows} piece rows, counts ${JSON.stringify(report.counts)})`);
    } finally { db.close(); }

    // Production wire-up: a fresh createLore opens SQLite via the real resolver; recall identical.
    lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: provider });
    try {
        const resolver = (lore._daemon as unknown as { getVerbatimResolver(): { getOrOpen(ws: string): Promise<unknown> } }).getVerbatimResolver();
        const store = await resolver.getOrOpen('default');
        assert.ok(store instanceof SqliteVerbatimStore, `resolver serves SqliteVerbatimStore (got ${(store as object).constructor.name})`);
        assert.equal((store as SqliteVerbatimStore).handleCount(), 1, 'SQLite store open');
        const after = await recallIds(lore);
        // Semantic recall: identical ids in identical order (same stored
        // vectors, both exact search at this size). Keyword recall: identical
        // id SET — ranking legitimately differs because the engines score
        // bm25 with different tokenizers (Lance tantivy vs SQLite FTS5).
        RECALLS.forEach(([q, mode], i) => {
            if (mode === 'semantic') assert.deepEqual(after[i], before[i], `semantic recall "${q}" identical`);
            else assert.deepEqual([...after[i]!].sort(), [...before[i]!].sort(), `keyword recall "${q}" same hits`);
        });
    } finally { await lore.dispose(); }
});

await test('piece index (D7) carried row-for-row: SQLite piece index opens valid on the kept sidecar and piece search matches Lance, no embeds', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('mv-pieces', {}, home);
    const provider = new DetEmbedProvider();
    const lanceStore = new VerbatimStore(entry.path, provider, { pieceVectors: true });
    await lanceStore.initialize();
    for (let i = 0; i < 4; i++) {
        await lanceStore.store({ id: `pc-${i}`, text: `Title ${i}\n\nparagraph about subject ${i} and the harbour pilots who guide ships ${i}`, metadata: { type: 'note', label: `Title ${i}` } });
    }
    const lanceStatus = lanceStore.pieceIndexStatus();
    assert.ok(lanceStatus.open && lanceStatus.valid, `precondition: Lance piece index active (${JSON.stringify(lanceStatus)})`);
    const q = await provider.embedQuery('harbour pilots who guide ships 2');
    const lanceHits = (await lanceStore.searchPieces(q, 5)).map((h) => h.nodeId);
    await lanceStore.close();
    assert.ok(lanceHits.length > 0, 'precondition: Lance piece search returns hits');

    const callsBefore = provider.calls;
    const report = await migrateVectorsToSqlite({ workspaceName: 'mv-pieces', home, backupOutDir: outDir(), skipDaemonCheck: true });
    assert.ok(report.pieces > 0, `piece rows present (${report.pieces})`);
    assert.equal(resolveWorkspaceVectorEngine('mv-pieces', home), 'sqlite');
    const sq = new SqliteVerbatimStore(entry.path, provider, { pieceVectors: true });
    await sq.initialize();
    try {
        const st = sq.pieceIndexStatus();
        assert.ok(st.open && st.valid, `SQLite piece index active after migration (${JSON.stringify(st)})`);
        const sqHits = (await sq.searchPieces(q, 5)).map((h) => h.nodeId);
        assert.deepEqual(sqHits, lanceHits, 'piece search top-5 identical');
    } finally { await sq.close(); }
    assert.equal(provider.calls, callsBefore, 'no embed calls during migration or reopen');
});

await test('refuses while a daemon serves the home (fake /api/health in a child)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    createWorkspace('mv-daemon', {}, home);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
    const r = spawnSync(tsxBin, [path.join(here, 'helpers', 'migrate-vectors-daemon-refuse-child.ts'), 'mv-daemon', home, outDir()], { encoding: 'utf8' });
    assert.equal(r.status, 0, `child failed: ${r.stdout}\n${r.stderr}`);
    assert.ok(r.stdout.includes('PASS'), r.stdout);
    assert.equal(resolveWorkspaceVectorEngine('mv-daemon', home), 'lance');
});

await test('refuses a non-lance source and a lance workspace with no Lance store', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    createWorkspace('mv-sqlite', {}, home);
    setWorkspaceVectorEngine('mv-sqlite', 'sqlite', home);
    await assert.rejects(migrateVectorsToSqlite({ workspaceName: 'mv-sqlite', home, backupOutDir: outDir(), skipDaemonCheck: true }), /already registered as 'sqlite'/);
    createWorkspace('mv-empty', {}, home);
    // 3.28: a workspace with no Lance store now migrates as an empty source when an embedding
    // model is configured (see migrate-vectors-dedupe-empty-unit.ts); it still refuses when
    // embeddings are disabled, because the empty SQLite store could not be stamped.
    await assert.rejects(migrateVectorsToSqlite({ workspaceName: 'mv-empty', home, backupOutDir: outDir(), skipDaemonCheck: true, embeddingProvider: new NullEmbeddingProvider() }), /no LanceDB verbatim store/);
    assert.equal(resolveWorkspaceVectorEngine('mv-empty', home), 'lance');
});

await test('refuses a non-empty target without --force; --force moves it aside (never deleted) and migrates', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'mv-target');
    const { db } = await openSqliteVerbatimDb(ws);
    db.prepare(`INSERT INTO verbatim (id, text, is_canonical, is_tombstone, created_at, updated_at) VALUES ('stale', 'stale row', 1, 0, 'x', 'x')`).run();
    db.close();
    await assert.rejects(migrateVectorsToSqlite({ workspaceName: 'mv-target', home, backupOutDir: outDir(), skipDaemonCheck: true }), /non-empty \(1 rows\).*--force/);
    assert.equal(resolveWorkspaceVectorEngine('mv-target', home), 'lance');
    const report = await migrateVectorsToSqlite({ workspaceName: 'mv-target', home, backupOutDir: outDir(), skipDaemonCheck: true, force: true });
    const aside = report.movedAside.find((p) => /verbatim\.sqlite\.pre-migrate-[^/]*$/.test(p) && !p.endsWith('-wal') && !p.endsWith('-shm'));
    assert.ok(aside && fs.existsSync(aside), `old target moved aside (${report.movedAside.join(', ')})`);
    const old = new Database(aside!, { readonly: true });
    try { assert.equal((old.prepare(`SELECT text FROM verbatim WHERE id='stale'`).get() as { text: string }).text, 'stale row'); } finally { old.close(); }
    assert.equal(resolveWorkspaceVectorEngine('mv-target', home), 'sqlite');
    assert.equal(report.counts.canonical, 3);
});

await test('refuses at/above the promotion threshold', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildLanceWs(home, 'mv-big');
    const prior = process.env['LORE_VECTOR_PROMOTE_ROWS'];
    process.env['LORE_VECTOR_PROMOTE_ROWS'] = '3';
    try {
        await assert.rejects(migrateVectorsToSqlite({ workspaceName: 'mv-big', home, backupOutDir: outDir(), skipDaemonCheck: true }), /promotion threshold/);
    } finally {
        if (prior === undefined) delete process.env['LORE_VECTOR_PROMOTE_ROWS']; else process.env['LORE_VECTOR_PROMOTE_ROWS'] = prior;
    }
    assert.equal(resolveWorkspaceVectorEngine('mv-big', home), 'lance');
});

for (const stage of ['import', 'verify'] as const) {
    await test(`crash safety: failure in ${stage} -> registry lance, Lance untouched, partial SQLite removed`, async () => {
        const home = freshHome();
        loadWorkspaces(home);
        const ws = await buildLanceWs(home, `mv-fail-${stage}`, 4);
        const digest = await lanceDigest(ws);
        await assert.rejects(
            migrateVectorsToSqlite({ workspaceName: `mv-fail-${stage}`, home, backupOutDir: outDir(), skipDaemonCheck: true, batchSize: 1, simulateFailure: stage }),
            /simulated .* failure.*UNCHANGED/s,
        );
        assert.equal(resolveWorkspaceVectorEngine(`mv-fail-${stage}`, home), 'lance');
        assert.equal(await lanceDigest(ws), digest, 'Lance rows untouched');
        for (const s of ['', '-wal', '-shm']) assert.ok(!fs.existsSync(sqlitePathOf(ws) + s), `no partial verbatim.sqlite${s}`);
        // Still usable as lance afterwards.
        const s = new VerbatimStore(ws, new DetEmbedProvider());
        await s.initialize();
        try { assert.ok(await s.getById(`mv-fail-${stage}-d0`)); } finally { await s.close(); }
    });
}

await test('--dry-run writes nothing (no backup, no sqlite, registry unchanged)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'mv-dry');
    const out = outDir();
    const r = await migrateVectorsToSqlite({ workspaceName: 'mv-dry', home, backupOutDir: out, skipDaemonCheck: true, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.counts.canonical, 3);
    assert.equal(fs.readdirSync(out).length, 0, 'no backup written');
    assert.ok(!fs.existsSync(sqlitePathOf(ws)), 'no verbatim.sqlite');
    assert.equal(resolveWorkspaceVectorEngine('mv-dry', home), 'lance');
});

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const a = srv.address();
            srv.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
        });
        srv.on('error', reject);
    });
}

await test('CLI: lore migrate-vectors --dry-run then --to sqlite (subprocess, --data-dir, no daemon)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildLanceWs(home, 'mv-cli');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
    const cli = path.join(here, '..', 'packages', 'lore', 'src', 'cli', 'index.ts');
    const env = { ...process.env, LORE_PORT: String(await freePort()), LORE_HOME: freshHome() };
    const run = (extra: string[]) => spawnSync(tsxBin, [cli, 'migrate-vectors', 'mv-cli', '--to', 'sqlite', '--data-dir', home, ...extra], { encoding: 'utf8', env });
    const dry = run(['--dry-run']);
    assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
    assert.match(dry.stdout, /dry run: preconditions pass/);
    assert.equal(resolveWorkspaceVectorEngine('mv-cli', home), 'lance');
    const real = run([]);
    assert.equal(real.status, 0, `${real.stdout}\n${real.stderr}`);
    assert.match(real.stdout, /now registered with vectorEngine 'sqlite'/);
    assert.match(real.stdout, /lore_verbatim\.lance/);
    assert.equal(resolveWorkspaceVectorEngine('mv-cli', home), 'sqlite');
    const again = run([]);
    assert.equal(again.status, 1, 'second run refuses (already sqlite)');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

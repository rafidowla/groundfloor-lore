#!/usr/bin/env tsx
/**
 * migrate-vectors-dedupe-empty-unit.ts — 3.28 `lore migrate-vectors` engine
 * additions (engines/migrateVectorsToSqlite.ts + migrateVectorsDedupe.ts).
 * Real LanceDB + SQLite in temp homes; never touches ~/.groundfloor.
 *
 *   A. dedupeIdentical: repeated canonical ids with identical content (mixed
 *      updatedAt) migrate; SQLite keeps the NEWEST copy; the report lists the
 *      ids/copies; Lance rows are untouched; digest/counts verify net of the
 *      dropped rows. Differing copies still refuse (with and without the
 *      option) naming the ids; no option -> refuse + hint that the option helps.
 *   B. Empty source (no Lance verbatim table): migrates to an empty, stamped
 *      SQLite store, registry flips, backup taken, zero embeds; Null provider
 *      refuses; dry-run writes nothing.
 *   C. Missing fingerprint: refuses with the new advice; stampFromConfig
 *      stamps when dimensions match, refuses on mismatch, never writes on a
 *      dry run, and un-stamps when the migration fails.
 *   D. A dry-run against a home with no workspaces.json creates nothing and
 *      errors clearly. Dry-run of every case above writes nothing.
 *
 * Run: npx tsx test/migrate-vectors-dedupe-empty-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as net from 'node:net';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';

import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceVectorEngine } from '../packages/lore/src/engines/vectorEngineSelector.js';
import { migrateVectorsToSqlite } from '../packages/lore/src/engines/migrateVectorsToSqlite.js';
import { mapLanceRow, digestOfHashes } from '../packages/lore/src/engines/migrateVectorsRows.js';
import { decodeVector } from '../packages/lore/src/engines/sqliteVerbatimVector.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { readFingerprint } from '../packages/lore/src/engines/embeddingFingerprint.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { NullEmbeddingProvider } from '../packages/lore/src/providers/nullEmbeddingProvider.js';

process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
delete process.env['LORE_SEARCH_WORKER'];

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const freshHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migdd-home-'));
const outDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migdd-out-'));

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension: number;
    readonly modelId = 'migdd-det';
    readonly dtype = 'fp32';
    calls = 0;
    constructor(dimension = 8) { this.dimension = dimension; }
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

const sqlitePathOf = (wsPath: string): string => path.join(wsPath, '.lore', 'verbatim.sqlite');
const fpPathOf = (wsPath: string): string => path.join(wsPath, '.lore', 'lancedb', 'embedding_model.json');

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

/** Lance workspace with n docs `<name>-d<i>`, written through the real VerbatimStore. */
async function buildLanceWs(home: string, name: string, n = 3): Promise<string> {
    const entry = createWorkspace(name, {}, home);
    assert.equal(entry.vectorEngine, 'lance');
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    for (let i = 0; i < n; i++) await s.store({ id: `${name}-d${i}`, text: `document ${i} about harbours and ferries`, metadata: { type: 'note', label: `d${i}` } });
    await s.close();
    return entry.path;
}

/** Append raw copies of an existing Lance row (same id) with overrides. */
async function addCopies(wsPath: string, id: string, overrides: Array<Record<string, unknown>>): Promise<void> {
    const raws = (await lanceRawRows(wsPath)).filter((r) => String(r.id) === id);
    assert.equal(raws.length >= 1, true, `row ${id} exists`);
    const base = raws[0]!;
    const plain = (v: unknown): unknown => {
        const a = v as { toArray?: () => unknown } | null | undefined;
        if (a && typeof a.toArray === 'function') return Array.from(a.toArray() as ArrayLike<unknown>);
        return v;
    };
    const rows = overrides.map((o) => {
        const row: Record<string, unknown> = {};
        for (const k of Object.keys(base)) row[k] = plain(base[k]);
        return { ...row, ...o };
    });
    const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { await t.add(rows); } finally { t.close(); }
    } finally { conn.close(); }
}

/** Every file under dir with size (mtime excluded: only content/size changes matter), sorted. */
function listing(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const name of fs.readdirSync(d).sort()) {
            const p = path.join(d, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) { out.push(`${path.relative(dir, p)}/`); walk(p); } else out.push(`${path.relative(dir, p)} ${st.size}`);
        }
    };
    walk(dir);
    return out;
}
const registryBytes = (home: string): string | null => {
    const p = path.join(home, 'workspaces.json');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const base = (home: string, name: string) => ({ workspaceName: name, home, backupOutDir: outDir(), skipDaemonCheck: true as const });

console.log('MIGRATE-VECTORS dedupe-identical / empty source / stamp-from-config / no-registry — 3.28\n');

const NEW = '2030-01-01T00:00:00.000Z';
const MID = '2028-01-01T00:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';

/** Distinct stored vector per copy: the marker that tells copies apart (the vector is not part of dedupe identity; label is). */
const mark = (n: number): number[] => Array.from({ length: 8 }, (_, i) => (i === n % 8 ? 1 : 0.25 * (n % 3)));

/** d0 x3, d1 x2, d2 x3 identical-content copies (mixed updatedAt, differing vector), d3 single. */
async function buildDuplicated(home: string, name: string): Promise<string> {
    const ws = await buildLanceWs(home, name, 4);
    await addCopies(ws, `${name}-d0`, [{ updatedAt: OLD, vector: mark(1) }, { updatedAt: NEW, vector: mark(2) }]);
    await addCopies(ws, `${name}-d1`, [{ updatedAt: MID, vector: mark(3) }]);
    await addCopies(ws, `${name}-d2`, [{ updatedAt: OLD, vector: mark(4) }, { updatedAt: OLD, vector: mark(5) }]);
    return ws;
}

await test('A1. identical duplicates: refused without the option, hint says --dedupe-identical resolves it, lists ids, writes nothing', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildDuplicated(home, 'dd-hint');
    const digest = await lanceDigest(ws);
    const files = listing(ws);
    const err = await migrateVectorsToSqlite(base(home, 'dd-hint')).then(() => null, (e: Error) => e);
    assert.ok(err, 'refused');
    assert.match(err!.message, /duplicate canonical id '[^']+' in the Lance table/);
    assert.match(err!.message, /3 id\(s\) are repeated \(5 extra row\(s\)\)/);
    for (const id of ['dd-hint-d0', 'dd-hint-d1', 'dd-hint-d2']) assert.ok(err!.message.includes(`'${id}'`), `lists ${id}`);
    assert.match(err!.message, /re-run with --dedupe-identical/);
    assert.ok(!/would NOT resolve/.test(err!.message));
    assert.equal(resolveWorkspaceVectorEngine('dd-hint', home), 'lance');
    assert.equal(await lanceDigest(ws), digest);
    assert.deepEqual(listing(ws), files, 'workspace files unchanged');
    assert.ok(!fs.existsSync(sqlitePathOf(ws)));
});

await test('A2. dedupeIdentical migrates: newest copy kept, tie = first seen, report lists ids/copies, Lance untouched, digests verify net of dropped rows', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildDuplicated(home, 'dd-ok');
    const digest = await lanceDigest(ws);
    const rowsBefore = (await lanceRawRows(ws)).length;
    assert.equal(rowsBefore, 9);
    const r = await migrateVectorsToSqlite({ ...base(home, 'dd-ok'), dedupeIdentical: true });
    assert.equal(r.dedupedRowsDropped, 5);
    assert.deepEqual(r.dedupedIds.map((d) => [d.id, d.copies]), [['dd-ok-d0', 3], ['dd-ok-d1', 2], ['dd-ok-d2', 3]]);
    assert.equal(r.dedupedIds.find((d) => d.id === 'dd-ok-d0')!.kept.updatedAt, NEW);
    assert.equal(r.dedupedIds.find((d) => d.id === 'dd-ok-d1')!.kept.updatedAt, MID);
    assert.equal(r.counts.canonical, 4, 'counts describe the SQLite side');
    assert.ok(r.digest);
    assert.equal(resolveWorkspaceVectorEngine('dd-ok', home), 'sqlite');
    assert.ok(r.warnings.some((w) => /5 identical duplicate/.test(w)));
    const db = new Database(sqlitePathOf(ws), { readonly: true });
    try {
        const rows = db.prepare('SELECT id, vector, updatedAt FROM verbatim ORDER BY id').all() as Array<{ id: string; vector: Buffer; updatedAt: string }>;
        const vecOf = (x: { vector: Buffer }): number[] => Array.from(decodeVector(x.vector)!);
        assert.equal(rows.length, 4);
        const by = Object.fromEntries(rows.map((x) => [x.id, x]));
        assert.deepEqual(vecOf(by['dd-ok-d0']!), mark(2));
        assert.equal(by['dd-ok-d0']!.updatedAt, NEW);
        assert.deepEqual(vecOf(by['dd-ok-d1']!), mark(3));
        assert.deepEqual(vecOf(by['dd-ok-d2']!), mark(4), 'tie on updatedAt keeps the first one seen in the Lance scan');
        assert.ok(by['dd-ok-d3']);
    } finally { db.close(); }
    assert.equal((await lanceRawRows(ws)).length, rowsBefore, 'Lance rows untouched');
    assert.equal(await lanceDigest(ws), digest);
    // The migrated store serves the surviving rows.
    const s = new SqliteVerbatimStore(ws, new DetEmbedProvider());
    await s.initialize();
    try { assert.equal((await s.getById('dd-ok-d0'))?.text, 'document 0 about harbours and ferries'); } finally { await s.close(); }
});

await test('A3. differing duplicates still refuse (with and without the option), naming the ids that differ', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildDuplicated(home, 'dd-diff');
    await addCopies(ws, 'dd-diff-d3', [{ text: 'a different document body', contentHash: 'different-hash', updatedAt: MID }]);
    const digest = await lanceDigest(ws);
    const files = listing(ws);
    const without = await migrateVectorsToSqlite(base(home, 'dd-diff')).then(() => null, (e: Error) => e);
    assert.match(without!.message, /duplicate canonical id/);
    assert.match(without!.message, /would NOT resolve this/);
    assert.match(without!.message, /DIFFERENT content \('dd-diff-d3'\)/);
    const withOpt = await migrateVectorsToSqlite({ ...base(home, 'dd-diff'), dedupeIdentical: true }).then(() => null, (e: Error) => e);
    assert.match(withOpt!.message, /duplicate canonical id/);
    assert.match(withOpt!.message, /only drops copies with identical content.*DIFFER: 'dd-diff-d3'/);
    assert.equal(resolveWorkspaceVectorEngine('dd-diff', home), 'lance');
    assert.equal(await lanceDigest(ws), digest);
    assert.deepEqual(listing(ws), files);
    assert.ok(!fs.existsSync(sqlitePathOf(ws)));
});

await test('A4. dry-run with dedupeIdentical reports what would be deduped and writes nothing', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildDuplicated(home, 'dd-dry');
    const out = outDir();
    const reg = registryBytes(home);
    const files = listing(ws);
    const r = await migrateVectorsToSqlite({ workspaceName: 'dd-dry', home, backupOutDir: out, skipDaemonCheck: true, dedupeIdentical: true, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.dedupedRowsDropped, 5);
    assert.equal(r.dedupedIds.length, 3);
    assert.equal(r.counts.canonical, 4);
    assert.equal(fs.readdirSync(out).length, 0, 'no backup');
    assert.deepEqual(listing(ws), files);
    assert.equal(registryBytes(home), reg);
});

await test('A5. alias (#q) duplicates dedupe too and the tombstone/unembedded totals count one row per id', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'dd-alias', 2);
    await addCopies(ws, 'dd-alias-d0', [{ id: 'dd-alias-d0#q0', updatedAt: OLD }, { id: 'dd-alias-d0#q0', updatedAt: NEW }]);
    const r = await migrateVectorsToSqlite({ ...base(home, 'dd-alias'), dedupeIdentical: true });
    assert.equal(r.dedupedRowsDropped, 1);
    assert.equal(r.dedupedIds[0]!.id, 'dd-alias-d0#q0');
    assert.equal(r.counts.alias, 1);
    assert.equal(r.counts.canonical, 2);
    assert.equal(resolveWorkspaceVectorEngine('dd-alias', home), 'sqlite');
});

await test('B1. empty source: migrates to an empty stamped SQLite store, backs up, flips the registry, zero embeds', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('es-ok', {}, home);
    const ws = entry.path;
    assert.ok(!fs.existsSync(path.join(ws, '.lore', 'lancedb', 'lore_verbatim.lance')));
    assert.ok(!fs.existsSync(fpPathOf(ws)));
    const provider = new DetEmbedProvider(8);
    const out = outDir();
    const r = await migrateVectorsToSqlite({ workspaceName: 'es-ok', home, backupOutDir: out, skipDaemonCheck: true, embeddingProvider: provider });
    assert.equal(r.emptySource, true);
    assert.equal(r.dedupedRowsDropped, 0);
    assert.deepEqual(r.dedupedIds, []);
    assert.equal(r.counts.canonical + r.counts.history + r.counts.alias, 0);
    assert.equal(provider.calls, 0, 'the embedder is never called');
    assert.equal(resolveWorkspaceVectorEngine('es-ok', home), 'sqlite');
    assert.ok(r.backup && fs.existsSync(r.backup.tarballPath), 'backup taken');
    assert.ok(fs.existsSync(sqlitePathOf(ws)));
    const db = new Database(sqlitePathOf(ws), { readonly: true });
    try { assert.equal((db.prepare('SELECT count(*) AS c FROM verbatim').get() as { c: number }).c, 0); } finally { db.close(); }
    const fp = readFingerprint(ws);
    assert.equal(fp?.modelId, 'migdd-det');
    assert.equal(fp?.dimension, 8);
    assert.equal(fp?.dtype, 'fp32');
    // A normal host can now write through the store with the same provider (no fingerprint mismatch).
    const s = new SqliteVerbatimStore(ws, provider, { strictFingerprintCheck: true });
    await s.initialize();
    try {
        await s.store({ id: 'es-ok-1', text: 'first note after migration', metadata: { type: 'note' } });
        assert.equal((await s.getById('es-ok-1'))?.text, 'first note after migration');
    } finally { await s.close(); }
});

await test('B2. empty source with a lancedb dir that holds only sidecar files also migrates', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('es-side', {}, home);
    fs.mkdirSync(path.join(entry.path, '.lore', 'lancedb'), { recursive: true });
    fs.writeFileSync(path.join(entry.path, '.lore', 'lancedb', 'piece_layout.json'), '{}');
    const r = await migrateVectorsToSqlite({ ...base(home, 'es-side'), embeddingProvider: new DetEmbedProvider() });
    assert.equal(r.emptySource, true);
    assert.equal(resolveWorkspaceVectorEngine('es-side', home), 'sqlite');
    assert.ok(fs.existsSync(path.join(entry.path, '.lore', 'lancedb', 'piece_layout.json')), 'sidecar kept');
});

await test('B3. empty source: embeddings disabled refuses, nothing written', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('es-null', {}, home);
    const reg = registryBytes(home);
    const files = listing(entry.path);
    await assert.rejects(
        migrateVectorsToSqlite({ ...base(home, 'es-null'), embeddingProvider: new NullEmbeddingProvider() }),
        /no LanceDB verbatim store.*embeddings are disabled/s,
    );
    assert.equal(resolveWorkspaceVectorEngine('es-null', home), 'lance');
    assert.deepEqual(listing(entry.path), files);
    assert.equal(registryBytes(home), reg);
});

await test('B4. empty source dry-run reports emptySource and writes nothing (files, registry bytes, backups)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('es-dry', {}, home);
    const reg = registryBytes(home);
    const files = listing(entry.path);
    const out = outDir();
    const r = await migrateVectorsToSqlite({ workspaceName: 'es-dry', home, backupOutDir: out, skipDaemonCheck: true, dryRun: true, embeddingProvider: new DetEmbedProvider() });
    assert.equal(r.emptySource, true);
    assert.equal(r.dryRun, true);
    assert.equal(fs.readdirSync(out).length, 0);
    assert.deepEqual(listing(entry.path), files);
    assert.equal(registryBytes(home), reg);
    assert.equal(resolveWorkspaceVectorEngine('es-dry', home), 'lance');
});

await test('B5. empty source with a non-empty sqlite target refuses without --force', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('es-tgt', {}, home);
    const s = new SqliteVerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    await s.store({ id: 'pre', text: 'pre-existing row', metadata: {} });
    await s.close();
    await assert.rejects(migrateVectorsToSqlite({ ...base(home, 'es-tgt'), embeddingProvider: new DetEmbedProvider() }), /non-empty \(1 rows\).*--force/);
    assert.equal(resolveWorkspaceVectorEngine('es-tgt', home), 'lance');
});

await test('C1. missing fingerprint: refuses with new advice (no "open once" claim) and writes nothing', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'fp-none');
    fs.rmSync(fpPathOf(ws));
    const files = listing(ws);
    const err = await migrateVectorsToSqlite(base(home, 'fp-none')).then(() => null, (e: Error) => e);
    assert.match(err!.message, /no embedding fingerprint/);
    assert.match(err!.message, /--stamp-from-config/);
    assert.match(err!.message, /Lore 3\.28/);
    assert.ok(!/Open the workspace once/.test(err!.message));
    assert.deepEqual(listing(ws), files);
    assert.equal(resolveWorkspaceVectorEngine('fp-none', home), 'lance');
});

await test('C2. stampFromConfig with matching dimension: stamps, migrates, reports stampedFromConfig', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'fp-ok');
    fs.rmSync(fpPathOf(ws));
    const provider = new DetEmbedProvider(8);
    const r = await migrateVectorsToSqlite({ ...base(home, 'fp-ok'), stampFromConfig: true, embeddingProvider: provider, onEmbedCall: () => { throw new Error('embedder called'); } });
    assert.equal(r.stampedFromConfig, true);
    assert.equal(r.embeddingModel.modelId, 'migdd-det');
    assert.equal(readFingerprint(ws)?.dimension, 8);
    assert.equal(provider.calls, 0);
    assert.equal(resolveWorkspaceVectorEngine('fp-ok', home), 'sqlite');
    assert.equal(r.counts.canonical, 3);
});

await test('C3. stampFromConfig with a dimension mismatch refuses and stamps nothing', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'fp-bad');
    fs.rmSync(fpPathOf(ws));
    const files = listing(ws);
    await assert.rejects(
        migrateVectorsToSqlite({ ...base(home, 'fp-bad'), stampFromConfig: true, embeddingProvider: new DetEmbedProvider(4) }),
        /8-dimensional vectors.*4-dimensional/s,
    );
    assert.ok(!fs.existsSync(fpPathOf(ws)));
    assert.deepEqual(listing(ws), files);
    assert.equal(resolveWorkspaceVectorEngine('fp-bad', home), 'lance');
});

await test('C4. stampFromConfig dry-run never writes the fingerprint (and reports what it would do)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'fp-dry');
    fs.rmSync(fpPathOf(ws));
    const files = listing(ws);
    const reg = registryBytes(home);
    const out = outDir();
    const r = await migrateVectorsToSqlite({ workspaceName: 'fp-dry', home, backupOutDir: out, skipDaemonCheck: true, dryRun: true, stampFromConfig: true, embeddingProvider: new DetEmbedProvider(8) });
    assert.equal(r.stampedFromConfig, true);
    assert.ok(r.warnings.some((w) => /would be derived/.test(w)));
    assert.ok(!fs.existsSync(fpPathOf(ws)));
    assert.deepEqual(listing(ws), files);
    assert.equal(registryBytes(home), reg);
    assert.equal(fs.readdirSync(out).length, 0);
});

await test('C5. a failed migration removes the fingerprint it derived (registry unchanged)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'fp-fail');
    fs.rmSync(fpPathOf(ws));
    await assert.rejects(
        migrateVectorsToSqlite({ ...base(home, 'fp-fail'), stampFromConfig: true, embeddingProvider: new DetEmbedProvider(8), simulateFailure: 'verify' }),
        /simulated verify failure.*UNCHANGED/s,
    );
    assert.ok(!fs.existsSync(fpPathOf(ws)), 'derived fingerprint removed');
    assert.ok(!fs.existsSync(sqlitePathOf(ws)));
    assert.equal(resolveWorkspaceVectorEngine('fp-fail', home), 'lance');
});

await test('D1. a dry-run against a home with no workspaces.json errors clearly and creates nothing', async () => {
    const home = freshHome();
    await assert.rejects(
        migrateVectorsToSqlite({ workspaceName: 'anything', home, backupOutDir: outDir(), skipDaemonCheck: true, dryRun: true }),
        /no workspace registry \(workspaces\.json\)/,
    );
    assert.deepEqual(fs.readdirSync(home), [], 'nothing created under the home');
    // Not-dry-run too, and an unknown workspace name in a real registry is a clear error.
    await assert.rejects(migrateVectorsToSqlite({ workspaceName: 'anything', home, backupOutDir: outDir(), skipDaemonCheck: true }), /no workspace registry/);
    assert.deepEqual(fs.readdirSync(home), []);
    const home2 = freshHome();
    loadWorkspaces(home2);
    await assert.rejects(migrateVectorsToSqlite({ workspaceName: 'nope', home: home2, backupOutDir: outDir(), skipDaemonCheck: true, dryRun: true }), /workspace_not_found: "nope"/);
});

/** Stable digest of a whole directory tree (relative path + content). */
function treeDigest(root: string): string {
    const h = createHash('sha256');
    const walk = (d: string): void => {
        for (const name of fs.readdirSync(d).sort()) {
            const p = path.join(d, name);
            const st = fs.lstatSync(p);
            h.update(`${path.relative(root, p)}\0`);
            if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
        }
    };
    walk(root);
    return h.digest('hex');
}

/** Copy a Lore home and rewrite its registry so every workspace path points inside the copy. */
function copyHomeTree(src: string): string {
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migdd-copy-'));
    fs.cpSync(src, dst, { recursive: true });
    const reg = path.join(dst, 'workspaces.json');
    fs.writeFileSync(reg, fs.readFileSync(reg, 'utf8').split(src).join(dst));
    return dst;
}

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

await test('E1. CLI: lore migrate-vectors --dedupe-identical --data-dir <copy> migrates the copy, prints the dedupe summary, real-home stand-in untouched', async () => {
    const realHome = freshHome();
    loadWorkspaces(realHome);
    await buildDuplicated(realHome, 'dd-cli');
    const copy = copyHomeTree(realHome);
    const realDigest = treeDigest(realHome);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
    const cli = path.join(here, '..', 'packages', 'lore', 'src', 'cli', 'index.ts');
    const env = { ...process.env, LORE_PORT: String(await freePort()), LORE_HOME: realHome };
    const run = (extra: string[]) => spawnSync(tsxBin, [cli, 'migrate-vectors', 'dd-cli', '--to', 'sqlite', '--data-dir', copy, ...extra], { encoding: 'utf8', env });
    const refused = run([]);
    assert.equal(refused.status, 1, 'refuses without --dedupe-identical');
    assert.match(refused.stderr, /duplicate canonical id/);
    const ok = run(['--dedupe-identical']);
    assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
    assert.match(ok.stdout, /Deduped ids:\s+3 \(5 identical duplicate rows dropped\)/);
    assert.match(ok.stdout, /now registered with vectorEngine 'sqlite'/);
    assert.ok(ok.stdout.includes(copy), 'prints the resolved --data-dir home');
    assert.equal(resolveWorkspaceVectorEngine('dd-cli', copy), 'sqlite');
    assert.equal(resolveWorkspaceVectorEngine('dd-cli', realHome), 'lance');
    assert.equal(treeDigest(realHome), realDigest, 'real-home stand-in byte-identical');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

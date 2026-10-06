#!/usr/bin/env tsx
/**
 * test/atlas-post-sqlite-e2e-unit.ts — cross-slice end-to-end for the Atlas
 * post-SQLite fix release. Each slice has its own suite; this one proves the
 * slices COMPOSE on the shapes Atlas actually has. Real LanceDB + SQLite in
 * temp homes only (os.tmpdir()); nothing touches ~/.groundfloor. One
 * deterministic fake embedding provider is shared by the store, createLore()
 * and the migrate engine, so the fingerprint and the migration see the same
 * model and dimension.
 *
 *   a. An Atlas-shaped non-boot workspace (table born through
 *      bulkUpsertPrebuiltRows) is stamped at birth; after the json is deleted
 *      createLore() (default role) re-stamps it on first use; then
 *      migrate-vectors to sqlite works WITHOUT stampFromConfig.
 *   b. Identical duplicate canonical ids: migrate refuses, `verbatim dedupe`
 *      apply leaves zero identical groups, migrate then succeeds without
 *      dedupeIdentical.
 *   c. Differing duplicates are never auto-fixed: dedupe leaves and reports
 *      them and the CLI exits non-zero; migrate with dedupeIdentical refuses.
 *   d. An empty Lance workspace migrates and the SQLite store is stamped.
 *   e. Two VerbatimStore instances on one path writing the same 50 ids,
 *      interleaved, then a third writing them again: exactly one canonical
 *      row per id.
 *   f. CLI isolation: migrate-graph / migrate-vectors / verbatim dedupe with
 *      --data-dir never touch a stand-in HOME (byte-identical tree); a typo
 *      flag exits non-zero and writes nothing.
 *
 * Run: npx tsx test/atlas-post-sqlite-e2e-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';

import { createWorkspace, loadWorkspaces, setWorkspaceGraphEngine } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceVectorEngine } from '../packages/lore/src/engines/vectorEngineSelector.js';
import { resolveWorkspaceGraphEngine } from '../packages/lore/src/engines/graphEngineSelector.js';
import { migrateVectorsToSqlite } from '../packages/lore/src/engines/migrateVectorsToSqlite.js';
import { dedupeVerbatimIdentical } from '../packages/lore/src/engines/verbatimDedupe.js';
import { classifyLanceId } from '../packages/lore/src/engines/migrateVectorsRows.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { VerbatimDocument } from '../packages/lore/src/engines/verbatimStore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { readFingerprint, _deleteFingerprintForTests, getFingerprintPath } from '../packages/lore/src/engines/embeddingFingerprint.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
process.env['LORE_MODEL_SERVER'] = '0';
delete process.env['LORE_SEARCH_WORKER'];

const DIM = 8;
const MODEL = 'atlas-e2e-det';
const UPDATED = '2026-10-05T00:00:00.000Z';
const NEW = '2030-01-01T00:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const roots: string[] = [];
const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `lore-apse2e-${label}-`)); roots.push(d); return d; };

function detVec(text: string): number[] {
    const v = new Array(DIM).fill(0);
    for (let i = 0; i < text.length; i++) v[(i * 7 + text.charCodeAt(i)) % DIM] += text.charCodeAt(i) / 128;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
}
class DetProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = MODEL;
    readonly dtype = 'fp32';
    calls = 0;
    async initialize(): Promise<void> {}
    async embed(t: string): Promise<number[]> { this.calls++; return detVec(t); }
    async embedQuery(t: string): Promise<number[]> { this.calls++; return detVec(t); }
    async embedDocument(t: string): Promise<number[]> { this.calls++; return detVec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { this.calls += ts.length; return ts.map(detVec); }
}

const prebuilt = (id: string, text: string): Record<string, unknown> => ({
    vector: detVec(text), id, text, type: 'note', label: id, tags: '', project: 'p', ecosystem: 'e',
    updatedAt: UPDATED, security_scopes: [], contentHash: `h-${id}`,
});
const lanceDir = (ws: string): string => path.join(ws, '.lore', 'lancedb');
const sqlitePathOf = (ws: string): string => path.join(ws, '.lore', 'verbatim.sqlite');
const base = (home: string, name: string) => ({ workspaceName: name, home, backupOutDir: tmp('bk'), skipDaemonCheck: true as const });

async function lanceRawRows(ws: string): Promise<Record<string, unknown>[]> {
    const conn = await lancedb.connect(lanceDir(ws));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { return (await t.query().toArray()) as Record<string, unknown>[]; } finally { t.close(); }
    } finally { conn.close(); }
}
const sqliteCount = (ws: string): number => {
    const db = new Database(sqlitePathOf(ws), { readonly: true });
    try { return (db.prepare('SELECT count(*) AS c FROM verbatim').get() as { c: number }).c; } finally { db.close(); }
};

/** Lance workspace with n docs `<name>-d<i>`, written through the real VerbatimStore (so it is stamped). */
async function buildLanceWs(home: string, name: string, n = 4): Promise<string> {
    const entry = createWorkspace(name, {}, home);
    assert.equal(entry.vectorEngine, 'lance');
    const s = new VerbatimStore(entry.path, new DetProvider());
    await s.initialize();
    for (let i = 0; i < n; i++) await s.store({ id: `${name}-d${i}`, text: `document ${i} about harbours and ferries`, metadata: { type: 'note', label: `d${i}` } });
    await s.close();
    return entry.path;
}

/** Append raw copies of an existing Lance row (same id) with overrides — the way the dedupe tests seed duplicates. */
async function addCopies(ws: string, id: string, overrides: Array<Record<string, unknown>>): Promise<void> {
    const basee = (await lanceRawRows(ws)).find((r) => String(r.id) === id);
    assert.ok(basee, `row ${id} exists`);
    const plain = (v: unknown): unknown => {
        const a = v as { toArray?: () => unknown } | null | undefined;
        if (a && typeof a.toArray === 'function') return Array.from(a.toArray() as ArrayLike<unknown>);
        return v;
    };
    const rows = overrides.map((o) => {
        const row: Record<string, unknown> = {};
        for (const k of Object.keys(basee!)) row[k] = plain(basee![k]);
        return { ...row, ...o };
    });
    const conn = await lancedb.connect(lanceDir(ws));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { await t.add(rows); } finally { t.close(); }
    } finally { conn.close(); }
}

/** Canonical (non-history) row count per id, via a raw Lance query on a fresh connection. */
async function canonicalCounts(ws: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const r of await lanceRawRows(ws)) {
        const id = String(r.id);
        if (classifyLanceId(id) === 'history') continue;
        out.set(id, (out.get(id) ?? 0) + 1);
    }
    return out;
}

function treeDigest(root: string): string {
    const h = createHash('sha256');
    const walk = (d: string): void => {
        for (const name of fs.readdirSync(d).sort()) {
            const p = path.join(d, name);
            const st = fs.lstatSync(p);
            h.update(`${path.relative(root, p)}\0`);
            if (st.isDirectory()) walk(p); else if (st.isFile()) h.update(fs.readFileSync(p));
        }
    };
    walk(root);
    return h.digest('hex');
}

console.log('\nATLAS POST-SQLITE — slices A+B+C+D+F compose end to end\n');

const prevHome = process.env['LORE_HOME'];
const { createLore } = await import('../packages/lore/src/index.js');

// ── a. Atlas-shaped workspace migrates without the flag ──────────────────────
await test('a. non-boot workspace: stamped at birth, re-stamped by createLore (default role), then migrate-vectors works WITHOUT stampFromConfig', async () => {
    const home = tmp('a');
    loadWorkspaces(home);
    const entry = createWorkspace('atlas', {}, home);
    const ws = entry.path;
    const provider = new DetProvider();

    // Born through the prebuilt bulk path — this used to leave no embedding_model.json.
    const s = new VerbatimStore(ws, provider);
    await s.initialize();
    assert.ok(!fs.existsSync(getFingerprintPath(ws)), 'no table yet, nothing stamped');
    await s.bulkUpsertPrebuiltRows(['a1', 'a2', 'a3', 'a4'].map((id) => prebuilt(id, `atlas note ${id} about harbours`)));
    await s.close();
    assert.ok(fs.existsSync(getFingerprintPath(ws)), 'embedding_model.json exists right after table birth');
    assert.equal(readFingerprint(ws)?.modelId, MODEL);
    assert.equal(readFingerprint(ws)?.dimension, DIM);

    // Legacy shape: json gone, table present. Default-role createLore touches the workspace.
    _deleteFingerprintForTests(ws);
    assert.equal(readFingerprint(ws), null);
    process.env['LORE_HOME'] = home;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home, embeddingProvider: provider } as never);
    try {
        await lore.recall('harbours', { workspace: 'atlas' } as never);
    } finally { await lore.dispose(); }
    assert.equal(readFingerprint(ws)?.modelId, MODEL, 're-stamped after a recall through createLore');
    assert.equal(readFingerprint(ws)?.dimension, DIM);

    // Migrate WITHOUT stampFromConfig.
    const lanceRows = (await lanceRawRows(ws)).length;
    const calls = provider.calls;
    const r = await migrateVectorsToSqlite({ ...base(home, 'atlas'), embeddingProvider: provider });
    assert.ok(!r.stampedFromConfig, 'no stampFromConfig needed');
    assert.equal(sqliteCount(ws), lanceRows, 'equal row counts');
    assert.equal(r.counts.canonical + r.counts.history + r.counts.alias, lanceRows);
    assert.equal(provider.calls, calls, 'the migration never embeds');
    assert.equal(resolveWorkspaceVectorEngine('atlas', home), 'sqlite', 'registry flipped to sqlite');
});

// ── b. duplicates -> dedupe -> migrate ───────────────────────────────────────
await test('b. identical duplicates: migrate refuses, dedupe apply clears them, migrate then succeeds without dedupeIdentical', async () => {
    const home = tmp('b');
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'dup', 4);
    await addCopies(ws, 'dup-d0', [{ updatedAt: OLD }, { updatedAt: NEW }]);
    await addCopies(ws, 'dup-d1', [{ updatedAt: OLD }]);
    assert.equal((await lanceRawRows(ws)).length, 7);

    const refused = await migrateVectorsToSqlite(base(home, 'dup')).then(() => null, (e: Error) => e);
    assert.ok(refused, 'migrate refuses duplicate canonical ids');
    assert.match(refused!.message, /duplicate canonical id/);
    assert.equal(resolveWorkspaceVectorEngine('dup', home), 'lance');
    assert.ok(!fs.existsSync(sqlitePathOf(ws)));

    const d = await dedupeVerbatimIdentical({ workspaceName: 'dup', home, apply: true, backupOutDir: tmp('bk'), skipDaemonCheck: true });
    assert.equal(d.status, 'applied');
    assert.equal(d.rescan!.identicalGroups, 0);
    assert.equal(d.rescan!.differingGroups, 0);
    assert.equal(d.rowsRemoved, 3);
    assert.equal((await lanceRawRows(ws)).length, 4);

    const r = await migrateVectorsToSqlite({ ...base(home, 'dup'), embeddingProvider: new DetProvider() }); // no dedupeIdentical
    assert.equal(r.dedupedRowsDropped, 0);
    assert.equal(sqliteCount(ws), 4);
    assert.equal(resolveWorkspaceVectorEngine('dup', home), 'sqlite');
});

// ── CLI plumbing (c and f) ───────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(repoRoot, 'packages/lore/src/cli/index.ts');
const cliPort = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const a = srv.address(); srv.close(() => resolve(typeof a === 'object' && a ? a.port : 0)); });
});
interface CliRun { status: number | null; stdout: string; stderr: string }
/** Spawn the CLI with HOME pointed at a stand-in and LORE_HOME unset, so a flag that is ignored falls back to the stand-in's ~/.groundfloor. */
function runCli(args: string[], fakeHome: string): CliRun {
    const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome, LORE_PORT: String(cliPort), LORE_MODEL_SERVER: '0' };
    delete env['LORE_HOME'];
    const r = spawnSync(tsxBin, [cliEntry, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf-8', timeout: 180_000 });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ── c. differing duplicates are never auto-fixed ─────────────────────────────
await test('c. differing duplicates: dedupe leaves + reports them and the CLI exits non-zero; migrate with dedupeIdentical still refuses', async () => {
    const home = tmp('c');
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'diff', 4);
    await addCopies(ws, 'diff-d0', [{ updatedAt: OLD }]); // identical content: fixable
    await addCopies(ws, 'diff-d2', [{ text: 'a genuinely different version of d2', contentHash: 'other-hash' }]); // differing
    const fakeHome = tmp('c-home');

    const c = runCli(['verbatim', 'dedupe', 'diff', '--apply', '--data-dir', home], fakeHome);
    assert.notEqual(c.status, 0, `exit non-zero\n${c.stdout}\n${c.stderr}`);
    assert.match(c.stderr, /DIFFER — not touched/);
    const counts = await canonicalCounts(ws);
    assert.equal(counts.get('diff-d2'), 2, 'both differing copies still present');
    assert.equal(counts.get('diff-d0'), 1, 'the identical group beside it was fixed');

    const rep = await dedupeVerbatimIdentical({ workspaceName: 'diff', home, skipDaemonCheck: true });
    assert.equal(rep.scan!.identicalGroups, 0);
    assert.equal(rep.scan!.differingGroups, 1);
    assert.deepEqual(rep.scan!.groups.map((g) => [g.id, g.identical]), [['diff-d2', false]]);

    const err = await migrateVectorsToSqlite({ ...base(home, 'diff'), dedupeIdentical: true }).then(() => null, (e: Error) => e);
    assert.ok(err, 'migrate refuses');
    assert.match(err!.message, /duplicate canonical id/);
    assert.ok(err!.message.includes("'diff-d2'"), 'names the differing id');
    assert.equal(resolveWorkspaceVectorEngine('diff', home), 'lance');
    assert.ok(!fs.existsSync(sqlitePathOf(ws)));
});

// ── d. empty Lance workspace ─────────────────────────────────────────────────
await test('d. empty Lance workspace migrates and the SQLite store is stamped', async () => {
    const home = tmp('d');
    loadWorkspaces(home);
    const ws = createWorkspace('empty', {}, home).path;
    assert.ok(!fs.existsSync(path.join(lanceDir(ws), 'lore_verbatim.lance')));
    const provider = new DetProvider();
    const r = await migrateVectorsToSqlite({ ...base(home, 'empty'), embeddingProvider: provider });
    assert.equal(r.emptySource, true);
    assert.equal(provider.calls, 0);
    assert.equal(resolveWorkspaceVectorEngine('empty', home), 'sqlite');
    assert.equal(sqliteCount(ws), 0);
    const fp = readFingerprint(ws);
    assert.equal(fp?.modelId, MODEL);
    assert.equal(fp?.dimension, DIM);
    assert.equal(fp?.dtype, 'fp32');
});

// ── e. no duplicates after concurrency ───────────────────────────────────────
await test('e. two instances on one path write the same 50 ids interleaved, then a fresh instance again: exactly one canonical row per id', async () => {
    const dir = tmp('e');
    fs.mkdirSync(path.join(dir, '.lore'), { recursive: true });
    const ids = Array.from({ length: 50 }, (_, i) => `conc:${i}`);
    const docs = (tag: string): VerbatimDocument[] => ids.map((id) => ({ id, text: `text of ${id} ${tag}`, metadata: { type: 'note', project: 'x', ecosystem: 't', updatedAt: UPDATED } }));
    const a = new VerbatimStore(dir, new DetProvider());
    const b = new VerbatimStore(dir, new DetProvider());
    await a.initialize(); await b.initialize();
    try {
        // Interleave in chunks of 10, A and B racing on the same chunk each time (cold table on the first).
        for (let i = 0; i < ids.length; i += 10) {
            await Promise.all([a.storeBatch(docs('a').slice(i, i + 10)), b.storeBatch(docs('b').slice(i, i + 10))]);
        }
        await Promise.all(docs('a2').slice(0, 10).map((d, k) => (k % 2 ? a : b).store(d)));
    } finally { await a.close(); await b.close(); }
    const c = new VerbatimStore(dir, new DetProvider());
    await c.initialize();
    try { await c.storeBatch(docs('c')); } finally { await c.close(); }
    const counts = await canonicalCounts(dir);
    const bad = ids.filter((id) => counts.get(id) !== 1).map((id) => `${id}=${counts.get(id) ?? 0}`);
    assert.deepEqual(bad, [], `exactly one canonical row per id, got ${bad.slice(0, 5).join(', ')}`);
    assert.equal(counts.size, 50, 'no extra canonical ids');
});

// ── f. CLI isolation ─────────────────────────────────────────────────────────
/** A home with a surreal `default` graph (one node) and a Lance workspace `vecws` with identical duplicates. */
async function buildCliHome(home: string): Promise<void> {
    const entry = loadWorkspaces(home).workspaces.find((w) => w.name === 'default')!;
    setWorkspaceGraphEngine('default', 'surreal', home);
    const g = new SurrealGraph(entry.path, { workspaceId: 'default' });
    await g.initialize();
    await g.upsertNode({ id: 'n1', type: 'note', label: 'one', content: 'c', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
    await g.close();
    const ws = await buildLanceWs(home, 'vecws', 4);
    await addCopies(ws, 'vecws-d0', [{ updatedAt: OLD }, { updatedAt: NEW }]);
}

await test('f. CLI --data-dir never touches the HOME stand-in (migrate-graph, verbatim dedupe --apply, migrate-vectors); a typo flag writes nothing', async () => {
    const fakeHome = tmp('f-home');
    const standIn = path.join(fakeHome, '.groundfloor');
    fs.mkdirSync(standIn, { recursive: true });
    await buildCliHome(standIn); // same workspace names as the data dir: an ignored flag would hit these
    const data = tmp('f-data');
    await buildCliHome(data);
    const standDigest = treeDigest(fakeHome);
    const vecWs = loadWorkspaces(data).workspaces.find((w) => w.name === 'vecws')!.path;

    // Typo flag first: non-zero, nothing written anywhere.
    const dataDigest0 = treeDigest(data);
    const typo = runCli(['migrate-vectors', 'vecws', '--to', 'sqlite', '--data-dri', data], fakeHome);
    assert.notEqual(typo.status, 0);
    assert.match(typo.stderr, /unknown flag --data-dri/);
    assert.equal(treeDigest(fakeHome), standDigest, 'stand-in untouched by the typo run');
    assert.equal(treeDigest(data), dataDigest0, 'data dir untouched by the typo run');

    const g = runCli(['migrate-graph', 'default', '--to', 'sqlite', '--data-dir', data], fakeHome);
    assert.equal(g.status, 0, `migrate-graph\n${g.stdout}\n${g.stderr}`);
    assert.equal(resolveWorkspaceGraphEngine('default', data), 'sqlite');
    assert.equal(treeDigest(fakeHome), standDigest, 'stand-in untouched by migrate-graph');

    const d = runCli(['verbatim', 'dedupe', 'vecws', '--data-dir', data, '--apply'], fakeHome);
    assert.equal(d.status, 0, `dedupe\n${d.stdout}\n${d.stderr}`);
    assert.equal((await canonicalCounts(vecWs)).get('vecws-d0'), 1, 'duplicates removed in the data dir');
    assert.equal(treeDigest(fakeHome), standDigest, 'stand-in untouched by dedupe');

    const m = runCli(['migrate-vectors', 'vecws', '--to', 'sqlite', '--data-dir', data], fakeHome);
    assert.equal(m.status, 0, `migrate-vectors\n${m.stdout}\n${m.stderr}`);
    assert.equal(resolveWorkspaceVectorEngine('vecws', data), 'sqlite');
    assert.equal(sqliteCount(vecWs), 4);

    assert.equal(treeDigest(fakeHome), standDigest, 'stand-in byte-identical after all three commands');
    assert.equal(resolveWorkspaceGraphEngine('default', standIn), 'surreal');
    assert.equal(resolveWorkspaceVectorEngine('vecws', standIn), 'lance');
    assert.ok(!fs.existsSync(sqlitePathOf(loadWorkspaces(standIn).workspaces.find((w) => w.name === 'vecws')!.path)));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
if (prevHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = prevHome;
process.exit(failed ? 1 : 0);

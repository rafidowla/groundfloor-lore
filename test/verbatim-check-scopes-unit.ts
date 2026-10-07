#!/usr/bin/env tsx
/**
 * verbatim-check-scopes-unit.ts — `lore verbatim check-scopes <workspace>` and
 * engines/verbatimCheckScopes.ts (post-3.28.0). Real LanceDB / SQLite stores in
 * temp homes; never touches ~/.groundfloor.
 *
 * The pre-3.28.0 damage (`security_scopes: ['undefined', ...]` on history and
 * tombstone rows) is no longer produced by the store, so it is seeded
 * directly through the raw Lance table / raw SQLite inserts.
 *
 *   A. Lance: exact counts per class and per kind (canonical live, canonical
 *      tombstone, #rev history), sample-id cap, ids only.
 *   B. SQLite: same fixture, same counts (scopes are JSON text there).
 *   C. Nothing on disk changes: tree digest, every file's size + mtime, the
 *      registry bytes, the Lance table version, for engine and CLI runs.
 *   D. --json shape is stable; human output is short plain lines.
 *   E. Strict flags: unknown flags (including --apply) are rejected before any
 *      work; missing / extra positionals too.
 *   F. Target guard: no registry, unknown workspace, copied registry still
 *      pointing at the original (--data-dir), missing --data-dir.
 *   G. "Nothing to check" for a workspace with no verbatim store; exit 0.
 *   H. classifyScopes edge cases.
 *
 * Run: npx tsx test/verbatim-check-scopes-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lancedb from '@lancedb/lancedb';

import { createWorkspace, loadWorkspaces, setWorkspaceVectorEngine } from '../packages/lore/src/config/workspaces.js';
import { checkVerbatimScopes, classifyScopes, SAMPLE_CAP } from '../packages/lore/src/engines/verbatimCheckScopes.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { openVerbatimRawImport, type RawVerbatimImportRow } from '../packages/lore/src/engines/sqliteVerbatimImport.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
delete process.env['LORE_SEARCH_WORKER'];

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const freshHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vcs-home-'));

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'vcs-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[(i * 7 + text.charCodeAt(i)) % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
}

// ── The fixture, expressed once and seeded into both engines ────────────────
const UND = ['undefined', 'undefined'];
const N_REV_ALL = 24; // 24 all-undefined #rev rows + 1 tombstone = 25 all_undefined (> SAMPLE_CAP)
const ts = (i: number): string => new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString();

interface Seed { id: string; text: string; scopes: string[]; kind: 'live' | 'tomb' | 'rev'; }
const seeds: Seed[] = [
    { id: 'doc-live-plain', text: 'live unscoped', scopes: [], kind: 'live' },
    { id: 'doc-live-scoped', text: 'live scoped', scopes: ['scope-a', 'scope-b'], kind: 'live' },
    { id: 'doc-tomb-bad', text: '[TOMBSTONED 2025-01-01] gone', scopes: UND, kind: 'tomb' },
    { id: 'doc-tomb-good', text: '[TOMBSTONED 2025-01-01] also gone', scopes: ['scope-a'], kind: 'tomb' },
    ...Array.from({ length: N_REV_ALL }, (_, i): Seed => ({ id: `doc-live-scoped#rev${ts(i)}`, text: `old version ${i}`, scopes: i % 2 === 0 ? UND : ['undefined'], kind: 'rev' })),
    { id: `doc-live-plain#rev${ts(100)}`, text: 'mixed history', scopes: ['undefined', 'scope-a'], kind: 'rev' },
    { id: `doc-live-plain#rev${ts(101)}`, text: 'empty history', scopes: [], kind: 'rev' },
    { id: `doc-live-plain#rev${ts(102)}`, text: 'good history', scopes: ['scope-a'], kind: 'rev' },
];
const EXPECT = {
    totalRows: seeds.length,
    totals: { ok: 5, all_undefined: N_REV_ALL + 1, mixed_undefined: 1, unreadable: 0 },
    byKind: {
        canonical_live: { total: 2, ok: 2, all_undefined: 0, mixed_undefined: 0, unreadable: 0 },
        canonical_tombstone: { total: 2, ok: 1, all_undefined: 1, mixed_undefined: 0, unreadable: 0 },
        history: { total: N_REV_ALL + 3, ok: 2, all_undefined: N_REV_ALL, mixed_undefined: 1, unreadable: 0 },
    },
};

async function buildLance(home: string, name: string): Promise<string> {
    const entry = createWorkspace(name, {}, home);
    assert.equal(entry.vectorEngine, 'lance');
    // A real store creates the table with the real schema; one live row via the real writer.
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    await s.store({ id: 'seed-real', text: 'a real live row written by the store', metadata: { type: 'note', label: 'x' } });
    await s.close();
    const conn = await lancedb.connect(path.join(entry.path, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try {
            const base = (await t.query().toArray())[0] as Record<string, unknown>;
            const vector = Array.from((base['vector'] as { toArray(): ArrayLike<number> }).toArray());
            await t.delete(`id = 'seed-real'`);
            await t.add(seeds.map((x) => ({
                vector, id: x.id, text: x.text, type: 'note', label: x.id, tags: '', project: '', ecosystem: '',
                updatedAt: ts(0), security_scopes: x.scopes, contentHash: `h-${x.id}`,
            })));
        } finally { t.close(); }
    } finally { conn.close(); }
    return entry.path;
}

async function buildSqlite(home: string, name: string): Promise<string> {
    const entry = createWorkspace(name, {}, home);
    setWorkspaceVectorEngine(name, 'sqlite', home);
    const imp = await openVerbatimRawImport(entry.path);
    try {
        const rows: RawVerbatimImportRow[] = seeds.map((x) => {
            const isRev = x.kind === 'rev';
            const base = isRev ? x.id.slice(0, x.id.indexOf('#rev')) : x.id;
            const when = isRev ? x.id.slice(x.id.indexOf('#rev') + 4) : ts(0);
            return {
                id: base, text: x.text, vector: null, content_hash: `h-${x.id}`, type: 'note', label: base, tags: '', project: '', ecosystem: '',
                updatedAt: ts(0),
                security_scopes: x.scopes.length === 0 ? null : JSON.stringify(x.scopes),
                is_canonical: isRev ? 0 : 1, is_tombstone: x.kind === 'tomb' ? 1 : 0,
                superseded_at: isRev ? when : null, created_at: when, updated_at: when,
            };
        });
        imp.importRows(rows);
    } finally { imp.close(); }
    return entry.path;
}

// ── Disk snapshot: everything that could reveal a write ─────────────────────
function snapshot(root: string): string {
    const h = createHash('sha256');
    const walk = (d: string): void => {
        for (const name of fs.readdirSync(d).sort()) {
            const p = path.join(d, name);
            const st = fs.lstatSync(p);
            h.update(`${path.relative(root, p)}\0${st.size}\0${st.mtimeMs}\0${st.isDirectory() ? 'd' : 'f'}\0`);
            if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
        }
    };
    walk(root);
    return h.digest('hex');
}
async function lanceVersion(wsPath: string): Promise<number> {
    const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { return await t.version(); } finally { t.close(); }
    } finally { conn.close(); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
const cli = path.join(here, '..', 'packages', 'lore', 'src', 'cli', 'index.ts');
const standIn = freshHome(); // LORE_HOME for every CLI run: an empty stand-in for the operator's real home
const standInSnap = snapshot(standIn);
function runCli(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(tsxBin, [cli, 'verbatim', 'check-scopes', ...args], {
        encoding: 'utf8', env: { ...process.env, LORE_PORT: '1', LORE_HOME: standIn, ...extraEnv },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function assertExpected(r: Awaited<ReturnType<typeof checkVerbatimScopes>>, engine: 'lance' | 'sqlite'): void {
    assert.equal(r.status, 'checked');
    assert.equal(r.engine, engine);
    assert.equal(r.totalRows, EXPECT.totalRows);
    assert.deepEqual(r.totals, EXPECT.totals);
    assert.deepEqual(r.byKind, EXPECT.byKind);
    assert.equal(r.samples.all_undefined.length, SAMPLE_CAP, 'sample cap applied');
    assert.equal(r.samples.mixed_undefined.length, 1);
    assert.deepEqual(r.samples.unreadable, []);
    assert.equal(new Set(r.samples.all_undefined).size, SAMPLE_CAP, 'sample ids are distinct');
    const known = new Set(seeds.map((x) => x.id));
    for (const id of [...r.samples.all_undefined, ...r.samples.mixed_undefined]) assert.ok(known.has(id), `sample id ${id} is a seeded id, not text`);
    assert.ok(r.samples.mixed_undefined[0]!.startsWith('doc-live-plain#rev'));
}

console.log('VERBATIM CHECK-SCOPES — read-only report of undefined-scope damage (post-3.28.0)\n');

await test('H. classifyScopes edge cases', async () => {
    assert.equal(classifyScopes([]), 'ok');
    assert.equal(classifyScopes(['a']), 'ok');
    assert.equal(classifyScopes(['undefined']), 'all_undefined');
    assert.equal(classifyScopes(['undefined', 'undefined']), 'all_undefined');
    assert.equal(classifyScopes(['undefined', 'a']), 'mixed_undefined');
    assert.equal(classifyScopes(['Undefined', 'UNDEFINED']), 'ok', 'case-sensitive: only the literal string');
    assert.equal(classifyScopes([null as unknown as string]), 'ok');
});

await test('A+C. Lance: exact counts per class and kind, sample cap, and nothing on disk changes', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLance(home, 'vcs-l');
    const snap = snapshot(home);
    const ver = await lanceVersion(ws);
    const regBytes = fs.readFileSync(path.join(home, 'workspaces.json'), 'utf8');
    const r = await checkVerbatimScopes({ workspaceName: 'vcs-l', home });
    assertExpected(r, 'lance');
    assert.equal(snapshot(home), snap, 'engine run wrote nothing (digest + sizes + mtimes)');
    assert.equal(await lanceVersion(ws), ver, 'Lance table version unchanged');
    const c = runCli(['vcs-l', '--data-dir', home]);
    assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
    assert.equal(snapshot(home), snap, 'CLI run wrote nothing');
    assert.equal(await lanceVersion(ws), ver);
    assert.equal(fs.readFileSync(path.join(home, 'workspaces.json'), 'utf8'), regBytes);
    assert.equal(snapshot(standIn), standInSnap, 'LORE_HOME stand-in untouched');
    assert.equal(fs.existsSync(path.join(home, 'verbatim-dedupe-backups')), false, 'no backup dir');
    // Re-running is repeatable (idempotent report).
    assertExpected(await checkVerbatimScopes({ workspaceName: 'vcs-l', home }), 'lance');
});

await test('B+C. SQLite: same fixture, same counts; nothing on disk changes', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildSqlite(home, 'vcs-s');
    const sqlitePath = path.join(ws, '.lore', 'verbatim.sqlite');
    assert.ok(fs.existsSync(sqlitePath));
    const snap = snapshot(home);
    const r = await checkVerbatimScopes({ workspaceName: 'vcs-s', home });
    assertExpected(r, 'sqlite');
    assert.equal(snapshot(home), snap, 'engine run wrote nothing (digest + sizes + mtimes, incl. -wal/-shm)');
    const c = runCli(['vcs-s', '--data-dir', home, '--json']);
    assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
    assert.equal(snapshot(home), snap, 'CLI run wrote nothing');
    assert.equal(snapshot(standIn), standInSnap);
    assertExpected(JSON.parse(c.stdout), 'sqlite');
    // SQLite history sample ids are rendered in the Lance `<id>#rev<ts>` form, not the bare shared id.
    for (const id of r.samples.all_undefined) assert.ok(id === 'doc-tomb-bad' || /#rev\d{4}-/.test(id), id);
});

await test('D. --json shape is stable; human output is short plain lines and ids only', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildLance(home, 'vcs-d');
    const j = runCli(['vcs-d', '--data-dir', home, '--json']);
    assert.equal(j.status, 0, j.stderr);
    const o = JSON.parse(j.stdout);
    assert.deepEqual(Object.keys(o).sort(), ['byKind', 'durationMs', 'engine', 'home', 'registryPath', 'samples', 'status', 'totalRows', 'totals', 'workspaceDir', 'workspaceName']);
    assert.deepEqual(Object.keys(o.totals).sort(), ['all_undefined', 'mixed_undefined', 'ok', 'unreadable']);
    assert.deepEqual(Object.keys(o.byKind).sort(), ['canonical_live', 'canonical_tombstone', 'history']);
    assert.deepEqual(Object.keys(o.byKind.history).sort(), ['all_undefined', 'mixed_undefined', 'ok', 'total', 'unreadable']);
    assert.deepEqual(Object.keys(o.samples).sort(), ['all_undefined', 'mixed_undefined', 'unreadable']);
    assert.equal(o.status, 'checked');
    assert.equal(j.stdout.trim().startsWith('{'), true, 'stdout carries only the JSON document');
    const h = runCli(['vcs-d', '--data-dir', home]);
    assert.equal(h.status, 0, h.stderr);
    assert.match(h.stdout, /Verbatim scope check: 'vcs-d' \(lance, report only — nothing is written\)/);
    assert.match(h.stdout, new RegExp(`Rows:\\s+${seeds.length}\\n`));
    assert.match(h.stdout, new RegExp(`All 'undefined':\\s+${N_REV_ALL + 1}\\n`));
    assert.match(h.stdout, /canonical tombstone\s+2 row\(s\): 1 ok, 1 all-undefined, 0 mixed/);
    assert.match(h.stdout, new RegExp(`Sample ids, all_undefined \\(first ${SAMPLE_CAP} of ${N_REV_ALL + 1}\\)`));
    assert.match(h.stdout, /This command repairs nothing/);
    assert.equal(h.stdout.includes('old version'), false, 'row text never printed');
    assert.equal(h.stdout.includes('gone'), false, 'row text never printed');
    // A clean workspace says so.
    const home2 = freshHome();
    loadWorkspaces(home2);
    const entry = createWorkspace('vcs-clean', {}, home2);
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    await s.store({ id: 'ok-1', text: 'fine', metadata: { type: 'note', security_scopes: ['scope-a'] } });
    await s.close();
    const c = runCli(['vcs-clean', '--data-dir', home2]);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /No damaged scopes found\./);
});

await test('E. unknown / misspelled flags (including --apply) and bad positionals are usage errors that do no work', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildLance(home, 'vcs-e');
    const snap = snapshot(home);
    for (const args of [['vcs-e', '--apply', '--data-dir', home], ['vcs-e', '--bogus', '--data-dir', home], ['vcs-e', '--jsno', '--data-dir', home], ['vcs-e', '--json=1', '--data-dir', home], ['--data-dir', home], ['vcs-e', 'extra', '--data-dir', home], ['vcs-e', '--data-dri', home]]) {
        const c = runCli(args);
        assert.equal(c.status, 1, `${args.join(' ')}: ${c.stdout}\n${c.stderr}`);
        assert.match(c.stderr, /lore verbatim check-scopes: /);
        assert.match(c.stderr, /usage: lore verbatim check-scopes/);
        assert.equal(c.stdout.includes('Home:'), false, 'rejected before doing any work');
    }
    assert.equal(snapshot(home), snap);
    assert.equal(snapshot(standIn), standInSnap);
    // Bare `lore verbatim` usage lists the new command.
    const u = spawnSync(tsxBin, [cli, 'verbatim'], { encoding: 'utf8', env: { ...process.env, LORE_HOME: standIn } });
    assert.match(u.stderr, /lore verbatim check-scopes <workspace>/);
});

await test('F. target guard: no registry, unknown workspace, stale copied registry, missing --data-dir', async () => {
    const home3 = freshHome();
    const c3 = runCli(['anything', '--data-dir', home3]);
    assert.equal(c3.status, 1);
    assert.match(c3.stderr, /verbatim check-scopes refused: no workspaces\.json at /);
    assert.deepEqual(fs.readdirSync(home3), [], 'nothing created');
    const home = freshHome();
    loadWorkspaces(home);
    await buildLance(home, 'vcs-f');
    const c4 = runCli(['nope', '--data-dir', home]);
    assert.equal(c4.status, 1);
    assert.match(c4.stderr, /verbatim check-scopes refused: workspace 'nope' is not in /);
    // A copy whose registry still points at the original roots is refused, naming both.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vcs-copy-'));
    fs.cpSync(home, copy, { recursive: true });
    const snap = snapshot(copy);
    const c5 = runCli(['vcs-f', '--data-dir', copy], { LORE_HOME: home });
    assert.equal(c5.status, 1, `${c5.stdout}\n${c5.stderr}`);
    assert.match(c5.stderr, /refused/);
    assert.equal(snapshot(copy), snap);
    const c6 = runCli(['vcs-f', '--data-dir', path.join(os.tmpdir(), 'lore-vcs-does-not-exist')]);
    assert.equal(c6.status, 1);
    assert.match(c6.stderr, /does not exist or is not a directory/);
    // Engine-level refusals.
    await assert.rejects(checkVerbatimScopes({ workspaceName: 'vcs-f', home: home3 }), /no workspace registry/);
    await assert.rejects(checkVerbatimScopes({ workspaceName: 'nope', home }), /workspace_not_found: "nope"/);
    assert.deepEqual(fs.readdirSync(home3), [], 'engine created nothing either');
});

await test('G. nothing to check: a workspace with no verbatim store exits 0 and writes nothing', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    createWorkspace('vcs-g', {}, home);
    createWorkspace('vcs-g2', {}, home);
    setWorkspaceVectorEngine('vcs-g2', 'sqlite', home);
    const snap = snapshot(home);
    for (const w of ['vcs-g', 'vcs-g2']) {
        const c = runCli([w, '--data-dir', home]);
        assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
        assert.match(c.stdout, /nothing to check/);
        const j = runCli([w, '--data-dir', home, '--json']);
        assert.equal(j.status, 0);
        assert.equal(JSON.parse(j.stdout).status, 'nothing-to-check');
    }
    assert.equal(snapshot(home), snap);
});

await test('I. SQLite with a live host (uncheckpointed WAL) is read through the WAL, creates no new file; odd path characters work; no experimental warning', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore vcs #odd?%-'));
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    loadWorkspaces(home);
    const ws = await buildSqlite(home, 'vcs-i');
    // Plain closed database in a path with a space, '#', '?' and '%': immutable-URI path.
    const cleanRun = runCli(['vcs-i', '--data-dir', home, '--json']);
    assert.equal(cleanRun.status, 0, `${cleanRun.stdout}\n${cleanRun.stderr}`);
    assertExpected(JSON.parse(cleanRun.stdout), 'sqlite');
    assert.doesNotMatch(cleanRun.stderr, /ExperimentalWarning|experimental/i);
    // Now a "host" holds the DB open in WAL mode with committed-but-uncheckpointed rows.
    const { default: Database } = await import('better-sqlite3');
    const host = new Database(path.join(ws, '.lore', 'verbatim.sqlite'));
    try {
        host.pragma('journal_mode = WAL');
        host.pragma('wal_autocheckpoint = 0');
        host.prepare(`INSERT INTO verbatim (id, text, security_scopes, is_canonical, is_tombstone, superseded_at, created_at, updated_at)
            VALUES ('wal-only', '[TOMBSTONED x] t', '["undefined"]', 1, 1, NULL, ?, ?)`).run(ts(5), ts(5));
        assert.ok(fs.statSync(path.join(ws, '.lore', 'verbatim.sqlite-wal')).size > 0, 'rows live in the WAL only');
        const before = fs.readdirSync(path.join(ws, '.lore')).sort();
        const sizes = before.map((n) => fs.statSync(path.join(ws, '.lore', n)).size);
        const r = await checkVerbatimScopes({ workspaceName: 'vcs-i', home });
        assert.equal(r.totalRows, EXPECT.totalRows + 1, 'the WAL-only row is counted');
        assert.equal(r.byKind.canonical_tombstone.all_undefined, 2);
        assert.ok(r.samples.all_undefined.length === SAMPLE_CAP);
        assert.deepEqual(fs.readdirSync(path.join(ws, '.lore')).sort(), before, 'no file created or removed');
        assert.deepEqual(before.map((n) => fs.statSync(path.join(ws, '.lore', n)).size), sizes, 'sizes unchanged');
    } finally { host.close(); }
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

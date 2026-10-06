#!/usr/bin/env tsx
/**
 * verbatim-dedupe-unit.ts — `lore verbatim dedupe <workspace>` and
 * engines/verbatimDedupe.ts (3.28). Real LanceDB + real VerbatimStore-written
 * tables in temp homes; never touches ~/.groundfloor.
 *
 *   A. Report-only lists the groups (identical vs differing, kept updatedAt,
 *      history rows ignored) and writes nothing: tree digest, registry bytes
 *      and Lance row digest unchanged, no backup dir.
 *   B. --apply keeps the newest copy of every IDENTICAL group; the kept row's
 *      vector, text and metadata are byte-identical to before; backup taken;
 *      re-scan: zero identical groups, distinct id count unchanged.
 *   C. Differing groups are untouched (every copy, byte for byte) and the CLI
 *      exits non-zero (report-only and --apply); identical groups beside them
 *      are still fixed.
 *   D. `#rev` history rows (including a repeated history id) are untouched.
 *   E. Daemon serving the home: --apply refuses, nothing changes; report-only
 *      still works.
 *   F. SQLite-registered workspace: "not applicable", exit 0. No Lance table:
 *      "nothing to check", exit 0. No registry: clear error, nothing created.
 *   G. Unknown / misspelled flags and a missing workspace are usage errors
 *      that write nothing.
 *   H. --data-dir copy isolation: only the copy changes, the real-home
 *      stand-in is byte-identical; a copy whose registry still points at the
 *      original refuses.
 *   I. After the fix, migrate-vectors succeeds WITHOUT --dedupe-identical
 *      (and refused before).
 *   J. A failure between the delete and the re-add surfaces the backup path.
 *
 * Run: npx tsx test/verbatim-dedupe-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lancedb from '@lancedb/lancedb';

import { createWorkspace, loadWorkspaces, setWorkspaceVectorEngine } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceVectorEngine } from '../packages/lore/src/engines/vectorEngineSelector.js';
import { migrateVectorsToSqlite } from '../packages/lore/src/engines/migrateVectorsToSqlite.js';
import { mapLanceRow } from '../packages/lore/src/engines/migrateVectorsRows.js';
import { dedupeVerbatimIdentical, findWorkspacesWithDuplicateIds } from '../packages/lore/src/engines/verbatimDedupe.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
delete process.env['LORE_SEARCH_WORKER'];

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const freshHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vdd-home-'));
const outDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vdd-out-'));

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension: number;
    readonly modelId = 'vdd-det';
    readonly dtype = 'fp32';
    constructor(dimension = 8) { this.dimension = dimension; }
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

const NEW = '2030-01-01T00:00:00.000Z';
const MID = '2028-01-01T00:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';
const REV = 'T#rev2025-01-01T00:00:00.000Z';

async function lanceRawRows(wsPath: string): Promise<Record<string, unknown>[]> {
    const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { return (await t.query().toArray()) as Record<string, unknown>[]; } finally { t.close(); }
    } finally { conn.close(); }
}
/** id -> sorted per-row digests (id, text, every metadata column, hashes, float32 vector bytes). */
async function rowHashes(wsPath: string): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const r of await lanceRawRows(wsPath)) {
        const id = String(r.id);
        const list = out.get(id) ?? [];
        list.push(mapLanceRow(r, 'x').hash);
        out.set(id, list.sort());
    }
    return out;
}

async function buildLanceWs(home: string, name: string, n = 4, d0Scopes: string[] = []): Promise<string> {
    const entry = createWorkspace(name, {}, home);
    assert.equal(entry.vectorEngine, 'lance');
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    for (let i = 0; i < n; i++) await s.store({ id: `${name}-d${i}`, text: `document ${i} about harbours and ferries`, metadata: { type: 'note', label: `d${i}`, ...(i === 0 && d0Scopes.length > 0 ? { security_scopes: d0Scopes } : {}) } });
    await s.close();
    return entry.path;
}

async function addCopies(wsPath: string, id: string, overrides: Array<Record<string, unknown>>): Promise<void> {
    const base = (await lanceRawRows(wsPath)).find((r) => String(r.id) === id);
    assert.ok(base, `row ${id} exists`);
    const plain = (v: unknown): unknown => {
        const a = v as { toArray?: () => unknown } | null | undefined;
        if (a && typeof a.toArray === 'function') return Array.from(a.toArray() as ArrayLike<unknown>);
        return v;
    };
    const rows = overrides.map((o) => {
        const row: Record<string, unknown> = {};
        for (const k of Object.keys(base!)) row[k] = plain(base![k]);
        return { ...row, ...o };
    });
    const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { await t.add(rows); } finally { t.close(); }
    } finally { conn.close(); }
}

/**
 * Workspace with: d0 x3 and d1 x2 IDENTICAL copies (mixed updatedAt; every d0 copy
 * carries the same security_scopes — copies that differ in scopes are NOT identical since
 * the review-I identity change), a repeated `#rev` history id on d3, and — when `differing` —
 * d2 x2 with DIFFERENT text.
 */
async function buildDuplicated(home: string, name: string, differing = false, withScopes = true): Promise<string> {
    const ws = await buildLanceWs(home, name, 4, withScopes ? ['scope-a', 'scope-b'] : []);
    await addCopies(ws, `${name}-d0`, [{ updatedAt: OLD }, { updatedAt: NEW }]);
    await addCopies(ws, `${name}-d1`, [{ updatedAt: MID }]);
    const revId = `${name}-d3${REV.slice(1)}`;
    await addCopies(ws, `${name}-d3`, [{ id: revId }, { id: revId }]);
    if (differing) await addCopies(ws, `${name}-d2`, [{ text: 'a genuinely different version of d2', contentHash: 'other-hash' }]);
    return ws;
}

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
function copyHomeTree(src: string, rewrite = true): string {
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vdd-copy-'));
    fs.cpSync(src, dst, { recursive: true });
    if (rewrite) {
        const reg = path.join(dst, 'workspaces.json');
        fs.writeFileSync(reg, fs.readFileSync(reg, 'utf8').split(src).join(dst));
    }
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

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
const cli = path.join(here, '..', 'packages', 'lore', 'src', 'cli', 'index.ts');
const cliPort = await freePort(); // nothing listens: the daemon preflight finds no daemon
const standIn = freshHome(); // LORE_HOME for every CLI run: an empty stand-in for the operator's real home
function runCliAsync(args: string[], extraEnv: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
    // Async (not spawnSync): the in-process fake daemon must keep answering while the CLI runs.
    return new Promise((resolve) => {
        const ch = spawn(tsxBin, [cli, 'verbatim', 'dedupe', ...args], { env: { ...process.env, LORE_PORT: String(cliPort), LORE_HOME: standIn, ...extraEnv } });
        let stdout = ''; let stderr = '';
        ch.stdout.on('data', (d) => { stdout += d; });
        ch.stderr.on('data', (d) => { stderr += d; });
        ch.on('close', (code) => resolve({ status: code, stdout, stderr }));
    });
}
const standInDigest = treeDigest(standIn);
function runCli(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(tsxBin, [cli, 'verbatim', 'dedupe', ...args], {
        encoding: 'utf8', env: { ...process.env, LORE_PORT: String(cliPort), LORE_HOME: standIn, ...extraEnv },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

console.log('VERBATIM DEDUPE — check / clean duplicate canonical ids in the Lance table (3.28)\n');

await test('A. report-only lists identical/differing groups + kept updatedAt, ignores history rows, writes nothing (engine and CLI)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildDuplicated(home, 'vd-a', true);
    const tree = treeDigest(home);
    const reg = registryBytes(home);
    const hashes = await rowHashes(ws);
    const r = await dedupeVerbatimIdentical({ workspaceName: 'vd-a', home });
    assert.equal(r.status, 'checked');
    assert.equal(r.apply, false);
    const s = r.scan!;
    assert.deepEqual(s.groups.map((g) => [g.id, g.copies, g.identical, g.keptUpdatedAt]), [
        ['vd-a-d0', 3, true, NEW],
        ['vd-a-d1', 2, true, MID],
        ['vd-a-d2', 2, false, null],
    ]);
    assert.equal(s.identicalGroups, 2);
    assert.equal(s.differingGroups, 1);
    assert.equal(s.extraRows, 3);
    assert.equal(s.differingExtraRows, 1);
    assert.equal(s.historyRows, 2, 'the two #rev rows are history, not a duplicate group');
    assert.equal(s.distinctIds, 4);
    assert.equal(s.totalRows, 10);
    // Nothing written.
    assert.equal(treeDigest(home), tree, 'whole home byte-identical');
    assert.equal(registryBytes(home), reg, 'workspaces.json byte-identical');
    assert.deepEqual([...(await rowHashes(ws))], [...hashes], 'every Lance row unchanged');
    assert.ok(!fs.existsSync(path.join(home, 'verbatim-dedupe-backups')), 'no backup dir');
    // CLI: same listing; exits 1 because a differing group exists; still writes nothing.
    const c = runCli(['vd-a', '--data-dir', home]);
    assert.equal(c.status, 1, `${c.stdout}\n${c.stderr}`);
    assert.match(c.stdout, /Identical groups:\s+2 \(3 extra row\(s\) removable\)/);
    assert.match(c.stdout, /Differing groups:\s+1 \(1 extra row\(s\), never touched\)/);
    assert.match(c.stdout, new RegExp(`identical  3 copies  keep updatedAt ${NEW}  vd-a-d0`));
    assert.match(c.stdout, /DIFFERING  2 copies  not touched  vd-a-d2/);
    assert.ok(!c.stdout.includes('#rev'.concat('2025')), 'history ids are not listed as groups');
    assert.match(c.stderr, /1 group\(s\) have copies that DIFFER/);
    assert.equal(treeDigest(home), tree, 'CLI report-only: home byte-identical');
    // --json: stdout is exactly one JSON document.
    const j = runCli(['vd-a', '--data-dir', home, '--json']);
    assert.equal(j.status, 1);
    const doc = JSON.parse(j.stdout) as { status: string; scan: { identicalGroups: number; groups: unknown[] } };
    assert.equal(doc.status, 'checked');
    assert.equal(doc.scan.identicalGroups, 2);
    assert.equal(doc.scan.groups.length, 3);
    assert.equal(treeDigest(home), tree);
});

await test('A2. report-only with only identical groups exits 0', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildDuplicated(home, 'vd-a2');
    const tree = treeDigest(home);
    const c = runCli(['vd-a2', '--data-dir', home]);
    assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
    assert.match(c.stdout, /Re-run with --apply/);
    assert.equal(treeDigest(home), tree);
});

await test('B/D. --apply keeps the NEWEST copy; its vector, text and metadata are byte-identical; backup taken; re-scan clean; #rev rows untouched', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildDuplicated(home, 'vd-b');
    const before = await rowHashes(ws);
    // The kept d0 row = the NEWEST copy (updatedAt NEW, scopes a+b): find its digest before.
    const d0Before = (await lanceRawRows(ws)).filter((r) => String(r.id) === 'vd-b-d0');
    assert.equal(d0Before.length, 3);
    const newest = d0Before.find((r) => String(r.updatedAt) === NEW)!;
    assert.deepEqual(Array.from((newest.security_scopes as unknown as { toArray(): ArrayLike<unknown> }).toArray()), ['scope-a', 'scope-b']);
    const newestHash = mapLanceRow(newest, 'x').hash;
    const d1Mid = mapLanceRow((await lanceRawRows(ws)).find((r) => String(r.id) === 'vd-b-d1' && String(r.updatedAt) === MID)!, 'x').hash;
    const backups = outDir();
    const r = await dedupeVerbatimIdentical({ workspaceName: 'vd-b', home, apply: true, backupOutDir: backups, skipDaemonCheck: true });
    assert.equal(r.status, 'applied');
    assert.equal(r.groupsFixed, 2);
    assert.equal(r.rowsRemoved, 3);
    assert.ok(r.backup && fs.existsSync(r.backup.tarballPath), 'backup tarball exists');
    assert.equal(fs.readdirSync(backups).length, 1);
    assert.equal(r.rescan!.identicalGroups, 0);
    assert.equal(r.rescan!.groups.length, 0);
    assert.equal(r.rescan!.distinctIds, r.scan!.distinctIds, 'canonical id count unchanged');
    const after = await rowHashes(ws);
    assert.deepEqual(after.get('vd-b-d0'), [newestHash], 'kept d0 row byte-identical to the newest copy (vector, text, metadata, scopes)');
    assert.deepEqual(after.get('vd-b-d1'), [d1Mid], 'kept d1 row = the MID copy');
    assert.deepEqual(after.get('vd-b-d2'), before.get('vd-b-d2'));
    // #rev history rows (a repeated history id included) untouched.
    const revId = `vd-b-d3${REV.slice(1)}`;
    assert.equal(before.get(revId)!.length, 2);
    assert.deepEqual(after.get(revId), before.get(revId));
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no id appeared or vanished');
    // The vector really is the stored bytes, and the row still reads through the real store.
    const keptRaw = (await lanceRawRows(ws)).find((r2) => String(r2.id) === 'vd-b-d0')!;
    assert.deepEqual(Array.from(mapLanceRow(keptRaw, 'x').row.vector as Float32Array), Array.from(mapLanceRow(newest, 'x').row.vector as Float32Array));
    const store = new VerbatimStore(ws, new DetEmbedProvider());
    await store.initialize();
    try {
        const got = await store.getById('vd-b-d0');
        assert.ok(got, 'real VerbatimStore reads the kept row');
        assert.match(String(got!.text), /document 0/);
    } finally { await store.close(); }
    // Second run: nothing left, no new backup.
    const again = await dedupeVerbatimIdentical({ workspaceName: 'vd-b', home, apply: true, backupOutDir: backups, skipDaemonCheck: true });
    assert.equal(again.status, 'checked');
    assert.equal(again.scan!.groups.length, 0);
    assert.equal(fs.readdirSync(backups).length, 1, 'no backup when there is nothing to fix');
});

await test('C. differing groups are untouched byte for byte; identical neighbours are fixed; CLI --apply exits non-zero', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildDuplicated(home, 'vd-c', true);
    const before = await rowHashes(ws);
    const r = await dedupeVerbatimIdentical({ workspaceName: 'vd-c', home, apply: true, backupOutDir: outDir(), skipDaemonCheck: true });
    assert.equal(r.status, 'applied');
    assert.equal(r.rescan!.identicalGroups, 0);
    assert.equal(r.rescan!.differingGroups, 1);
    const after = await rowHashes(ws);
    assert.deepEqual(after.get('vd-c-d2'), before.get('vd-c-d2'), 'both d2 copies untouched');
    assert.equal(after.get('vd-c-d2')!.length, 2);
    assert.equal(after.get('vd-c-d0')!.length, 1);
    // CLI on a fresh differing workspace.
    const home2 = freshHome();
    loadWorkspaces(home2);
    const ws2 = await buildDuplicated(home2, 'vd-c2', true);
    const c = runCli(['vd-c2', '--apply', '--data-dir', home2]);
    assert.equal(c.status, 1, `${c.stdout}\n${c.stderr}`);
    assert.match(c.stdout, /Fixed:\s+2 group\(s\), 3 row\(s\) removed/);
    assert.match(c.stdout, /Backup:\s+\S+\.tar/);
    assert.match(c.stderr, /DIFFER — not touched/);
    const after2 = await rowHashes(ws2);
    assert.equal(after2.get('vd-c2-d2')!.length, 2);
    assert.equal(after2.get('vd-c2-d0')!.length, 1);
});

await test('E. a daemon serving the home: --apply refuses and changes nothing; report-only still works', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildDuplicated(home, 'vd-e');
    fs.writeFileSync(path.join(home, 'auth.token'), 'tok-vdd\n');
    const srv = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ loreHome: home, status: 'ok' })); });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as net.AddressInfo).port;
    try {
        const tree = treeDigest(home);
        await assert.rejects(
            dedupeVerbatimIdentical({ workspaceName: 'vd-e', home, apply: true, backupOutDir: outDir(), daemonProbePort: port }),
            /daemon is running/,
        );
        assert.equal(treeDigest(home), tree, 'refusal wrote nothing');
        const ro = await dedupeVerbatimIdentical({ workspaceName: 'vd-e', home, daemonProbePort: port });
        assert.equal(ro.status, 'checked');
        // CLI: LORE_PORT points at the fake daemon.
        const c = await runCliAsync(['vd-e', '--apply', '--data-dir', home], { LORE_PORT: String(port) });
        assert.equal(c.status, 1, `${c.stdout}\n${c.stderr}`);
        assert.match(c.stderr, /daemon is running/);
        assert.equal(treeDigest(home), tree);
        assert.equal((await rowHashes(ws)).get('vd-e-d0')!.length, 3);
    } finally { await new Promise<void>((resolve) => srv.close(() => resolve())); }
});

await test('F. SQLite-registered workspace: not applicable, exit 0; no Lance table: nothing to check, exit 0; no registry: clear error, nothing created', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildDuplicated(home, 'vd-f');
    setWorkspaceVectorEngine('vd-f', 'sqlite', home);
    assert.equal(resolveWorkspaceVectorEngine('vd-f', home), 'sqlite');
    const tree = treeDigest(home);
    const r = await dedupeVerbatimIdentical({ workspaceName: 'vd-f', home, apply: true, backupOutDir: outDir() });
    assert.equal(r.status, 'not-applicable-sqlite');
    const c = runCli(['vd-f', '--apply', '--data-dir', home]);
    assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
    assert.match(c.stdout, /not applicable: SQLite enforces unique ids/);
    assert.equal(treeDigest(home), tree);
    // No Lance table.
    const home2 = freshHome();
    loadWorkspaces(home2);
    createWorkspace('vd-empty', {}, home2);
    const tree2 = treeDigest(home2);
    const c2 = runCli(['vd-empty', '--data-dir', home2]);
    assert.equal(c2.status, 0, `${c2.stdout}\n${c2.stderr}`);
    assert.match(c2.stdout, /nothing to check/);
    const c2a = runCli(['vd-empty', '--apply', '--data-dir', home2]);
    assert.equal(c2a.status, 0);
    assert.equal(treeDigest(home2), tree2);
    // No registry.
    const home3 = freshHome();
    const c3 = runCli(['anything', '--data-dir', home3]);
    assert.equal(c3.status, 1);
    assert.match(c3.stderr, /no workspace registry \(workspaces\.json\)/);
    assert.deepEqual(fs.readdirSync(home3), [], 'nothing created');
    const c3a = runCli(['anything', '--apply', '--data-dir', home3]);
    assert.equal(c3a.status, 1);
    assert.deepEqual(fs.readdirSync(home3), []);
    // Unknown workspace in a real registry.
    const c4 = runCli(['nope', '--data-dir', home2]);
    assert.equal(c4.status, 1);
    assert.match(c4.stderr, /workspace_not_found: "nope"/);
});

await test('G. unknown / misspelled flags and a missing workspace are usage errors that write nothing', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildDuplicated(home, 'vd-g');
    const tree = treeDigest(home);
    for (const args of [['vd-g', '--aply', '--data-dir', home], ['vd-g', '--bogus', '--data-dir', home], ['vd-g', '--apply=1', '--data-dir', home], ['--data-dir', home], ['vd-g', 'extra', '--data-dir', home], ['vd-g', '--data-dri', home]]) {
        const c = runCli(args);
        assert.equal(c.status, 1, `${args.join(' ')}: ${c.stdout}\n${c.stderr}`);
        assert.match(c.stderr, /lore verbatim dedupe: /);
        assert.match(c.stderr, /usage: lore verbatim dedupe/);
        assert.equal(c.stdout.includes('Home:'), false, 'rejected before doing any work');
    }
    assert.equal(treeDigest(home), tree);
    assert.equal(treeDigest(standIn), standInDigest, 'LORE_HOME stand-in untouched');
});

await test('H. --data-dir copy isolation: only the copy changes; a copied registry still pointing at the original refuses', async () => {
    const realHome = freshHome();
    loadWorkspaces(realHome);
    await buildDuplicated(realHome, 'vd-h');
    const copy = copyHomeTree(realHome);
    const realDigest = treeDigest(realHome);
    const c = runCli(['vd-h', '--apply', '--data-dir', copy], { LORE_HOME: realHome });
    assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
    assert.ok(c.stdout.includes(copy), 'prints the resolved home');
    assert.ok(c.stdout.includes(path.join(copy, 'workspaces.json')), 'prints the registry path');
    assert.match(c.stdout, /Backup:\s+\S+verbatim-dedupe-backups/);
    assert.ok(c.stdout.includes(path.join(copy, 'verbatim-dedupe-backups')), 'backup lands under the data dir');
    assert.equal(treeDigest(realHome), realDigest, 'real-home stand-in byte-identical');
    const copyWs = loadWorkspaces(copy).workspaces.find((w) => w.name === 'vd-h')!.path;
    assert.ok(copyWs.startsWith(copy));
    assert.equal((await rowHashes(copyWs)).get('vd-h-d0')!.length, 1, 'the copy was fixed');
    // Registry copied WITHOUT rewriting paths: still points at the original -> refuse.
    const stale = copyHomeTree(realHome, false);
    const staleDigest = treeDigest(stale);
    const s = runCli(['vd-h', '--apply', '--data-dir', stale], { LORE_HOME: realHome });
    assert.equal(s.status, 1, `${s.stdout}\n${s.stderr}`);
    assert.match(s.stderr, /OUTSIDE/);
    assert.equal(treeDigest(realHome), realDigest, 'original untouched');
    assert.equal(treeDigest(stale), staleDigest, 'stale copy untouched');
    // --data-dir that does not exist.
    const miss = runCli(['vd-h', '--data-dir', path.join(os.tmpdir(), 'lore-vdd-does-not-exist')]);
    assert.equal(miss.status, 1);
    assert.match(miss.stderr, /does not exist/);
});

await test('I. after the fix, migrate-vectors succeeds WITHOUT --dedupe-identical (refused before)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    // No security_scopes here: LanceDB getById (verbatimHistory.ts) drops scopes (Array.isArray on an Arrow
    // vector), which makes migrate-vectors' getById live probe mismatch for ANY scoped row, duplicates or not.
    const ws = await buildDuplicated(home, 'vd-i', false, false);
    const mv = { workspaceName: 'vd-i', home, backupOutDir: outDir(), skipDaemonCheck: true as const };
    await assert.rejects(migrateVectorsToSqlite(mv), /duplicate canonical id/);
    assert.equal(resolveWorkspaceVectorEngine('vd-i', home), 'lance');
    const r = await dedupeVerbatimIdentical({ workspaceName: 'vd-i', home, apply: true, backupOutDir: outDir(), skipDaemonCheck: true });
    assert.equal(r.status, 'applied');
    const m = await migrateVectorsToSqlite({ ...mv, backupOutDir: outDir() });
    assert.equal(resolveWorkspaceVectorEngine('vd-i', home), 'sqlite');
    assert.equal(m.dedupedRowsDropped, 0, 'nothing left for migrate-vectors to dedupe');
    assert.equal(m.counts.canonical, 4);
    assert.equal(m.counts.history, 2);
    assert.ok(m.digest, 'digest + live probes verified');
    assert.ok(fs.existsSync(path.join(ws, '.lore', 'verbatim.sqlite')));
});

await test('J. a failure after the delete surfaces the backup path (rows are in the backup)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildDuplicated(home, 'vd-j');
    const err = await dedupeVerbatimIdentical({ workspaceName: 'vd-j', home, apply: true, backupOutDir: outDir(), skipDaemonCheck: true, simulateFailure: 'after-delete' })
        .then(() => null, (e: Error) => e);
    assert.ok(err, 'throws');
    assert.match(err!.message, /FAILED after their copies were deleted/);
    assert.match(err!.message, /Restore from the backup at \S+\.tar/);
    void ws;
});

await test('K. lore doctor reports duplicate ids read-only and points at the command; silent once clean', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildDuplicated(home, 'vd-k');
    const tree = treeDigest(home);
    assert.deepEqual(await findWorkspacesWithDuplicateIds(home), [{ name: 'vd-k', groups: 2, extraRows: 3 }]);
    const doc = (): { status: number | null; stdout: string } => {
        const r = spawnSync(tsxBin, [cli, 'doctor'], { encoding: 'utf8', env: { ...process.env, LORE_PORT: String(cliPort), LORE_HOME: home } });
        return { status: r.status, stdout: r.stdout + r.stderr };
    };
    const d1 = doc();
    assert.match(d1.stdout, /workspace 'vd-k': 2 canonical id\(s\) have duplicate copies .*\(3 extra row\(s\)\).*lore verbatim dedupe vd-k/);
    assert.equal(treeDigest(home), tree, 'doctor wrote nothing');
    await dedupeVerbatimIdentical({ workspaceName: 'vd-k', home, apply: true, backupOutDir: outDir(), skipDaemonCheck: true });
    assert.deepEqual(await findWorkspacesWithDuplicateIds(home), []);
    assert.doesNotMatch(doc().stdout, /duplicate copies/);
    // SQLite-live workspaces are skipped.
    const home2 = freshHome();
    loadWorkspaces(home2);
    await buildDuplicated(home2, 'vd-k2');
    setWorkspaceVectorEngine('vd-k2', 'sqlite', home2);
    fs.mkdirSync(path.join(home2, 'workspaces', 'vd-k2', '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home2, 'workspaces', 'vd-k2', '.lore', 'verbatim.sqlite'), '');
    assert.deepEqual(await findWorkspacesWithDuplicateIds(home2), []);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

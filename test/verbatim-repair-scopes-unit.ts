#!/usr/bin/env tsx
/**
 * verbatim-repair-scopes-unit.ts — `lore verbatim repair-scopes <workspace>` and
 * engines/verbatimRepairScopes.ts (post-3.28.0). Real LanceDB / SQLite stores and
 * a real VersionStore (versions.sqlite) in temp homes; never touches ~/.groundfloor
 * and never probes the default daemon port (every run pins LORE_PORT / daemonProbePort).
 *
 * The pre-3.28.0 damage is seeded directly (raw Lance add / raw SQLite import); the
 * node version log is written through the real VersionStore.
 *
 *   A. Dry run (Lance + SQLite): a verdict per all_undefined row, counts and sample
 *      ids only, no scope value and no row text in the report; disk byte-identical
 *      (tree digest incl. mtimes) for engine and CLI runs.
 *   B. --apply (Lance + SQLite): backup exists; exactly the restorable rows get
 *      their original scopes; every other row (scopes included) and every non-scope
 *      field (text, vector, updatedAt, contentHash, ids) is unchanged; row count
 *      unchanged; a canonical's current scopes are never copied; a second --apply
 *      is a no-op that writes and backs up nothing.
 *   C. No version log at all: every row is no_version_log, --apply writes nothing.
 *   D. versions.sqlite in the home's own .lore (boot-workspace layout) is found; rows
 *      of another workspace in the same file are not used.
 *   E. A daemon serving the home: --apply refuses (engine and CLI), nothing changes;
 *      the dry run still works.
 *   F. Target guard: no registry, unknown workspace, copied registry still pointing
 *      at the original, missing --data-dir; --apply form too.
 *   G. Strict flags, usage text, bare `lore verbatim` usage lists the command.
 *   H. A row changed by another writer between plan and write aborts the run (Lance,
 *      SQLite), names the backup, restores nothing it should not.
 *   I. CLI --apply end to end (backup path printed, nothing sensitive printed) and
 *      --json shape.
 *   J. No verbatim store: nothing to check, exit 0, nothing written.
 *   K. A backup missing the target store (copy failed): --apply refuses, nothing written.
 *
 * Run: npx tsx test/verbatim-repair-scopes-unit.ts
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
import Database from 'better-sqlite3';

import { createWorkspace, loadWorkspaces, setWorkspaceVectorEngine } from '../packages/lore/src/config/workspaces.js';
import { SAMPLE_CAP, classifyScopes } from '../packages/lore/src/engines/verbatimCheckScopes.js';
import { repairVerbatimScopes, REPAIR_VERDICTS, type RepairVerdict } from '../packages/lore/src/engines/verbatimRepairScopes.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { openVerbatimRawImport, type RawVerbatimImportRow } from '../packages/lore/src/engines/sqliteVerbatimImport.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
process.env['LORE_PORT'] = '1'; // nothing listens there: the daemon preflight can never reach a real daemon
delete process.env['LORE_SEARCH_WORKER'];
const DEAD_PORT = 1;

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const freshHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vrs-home-'));
const outDir = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vrs-bak-')), 'backups');

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'vrs-det';
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

// ── Scope values and row text that must never appear in any output ──────────
const SC = {
    a: 'zz_scope_alpha', b: 'zz_scope_beta', c: 'zz_scope_gamma', d: 'zz_scope_delta', e: 'zz_scope_eps',
    t: 'zz_scope_tomb', bulk: 'zz_scope_bulk', cur: 'zz_scope_CURRENT', x: 'zz_scope_ex', y: 'zz_scope_why',
};
const SECRET_TEXTS = ['zz-secret-old-text', 'zz-secret-orig-text', 'zz-secret-live-text'];

const UND1 = ['undefined'];
const UND2 = ['undefined', 'undefined'];
const BASE_MS = Date.UTC(2025, 0, 1, 0, 0, 0);
const ts = (i: number): string => new Date(BASE_MS + i * 1000).toISOString();
const rev = (i: number): string => `#rev${ts(i)}`;
const u = (i: number): string => ts(5000 + i); // a row's updatedAt

interface Seed {
    id: string; // Lance id form
    text: string;
    scopes: string[];
    /** SQLite only: stored as this raw (unparsable) text. */
    rawScopes?: string;
    updatedAt: string;
    kind: 'live' | 'tomb' | 'rev';
    type?: string;
    label?: string;
    /** Expected verdict for an all_undefined row. */
    verdict?: RepairVerdict;
    /** Scopes the row must hold after a successful --apply. */
    restoredTo?: string[];
    lanceOnly?: boolean;
    sqliteOnly?: boolean;
}
interface VersionSeed { node: string; updatedAt: string; scopes: unknown; type?: string; label?: string; workspace?: string }

const nodeOf = (id: string): string => id.replace(/^lore:/, '').replace(/#rev.*$/, '');
const labelOf = (s: Seed): string => s.label ?? `lbl-${nodeOf(s.id)}`;

const N_BULK = 25;
const seeds: Seed[] = [];
const versions: VersionSeed[] = [];
const sv = (id: string, v: Partial<VersionSeed> & { updatedAt: string; scopes: unknown }): void => {
    versions.push({ node: nodeOf(id), ...v });
};

// live canonical rows
seeds.push({ id: 'lore:n-live-ok', text: 'zz-secret-live-text ok', scopes: [SC.cur], updatedAt: u(0), kind: 'live' });
seeds.push({ id: 'lore:n-live-bad', text: 'zz-secret-live-text bad', scopes: UND1, updatedAt: u(1), kind: 'live', verdict: 'live_row_unproven' });
sv('lore:n-live-bad', { updatedAt: u(1), scopes: [SC.a] }); // proof exists, but a live canonical is never repaired by this command
// canonical rows whose CURRENT scopes must never leak onto old rows
for (const n of ['n-nolog', 'n-nomatch', 'n-cnt']) seeds.push({ id: `lore:${n}`, text: 'zz-secret-live-text cur', scopes: [SC.cur], updatedAt: u(2), kind: 'live' });
// 2-scope and 1-scope restorable, plus per-revision scopes for one node
seeds.push({ id: `lore:n-two${rev(10)}`, text: 'zz-secret-old-text r2', scopes: UND2, updatedAt: u(10), kind: 'rev', verdict: 'restorable', restoredTo: [SC.a, SC.b] });
sv('lore:n-two', { updatedAt: u(10), scopes: [SC.a, SC.b] });
seeds.push({ id: `lore:n-one${rev(11)}`, text: 'zz-secret-old-text r1', scopes: UND1, updatedAt: u(11), kind: 'rev', verdict: 'restorable', restoredTo: [SC.c] });
seeds.push({ id: `lore:n-one${rev(12)}`, text: 'zz-secret-old-text r1b', scopes: UND1, updatedAt: u(12), kind: 'rev', verdict: 'restorable', restoredTo: [SC.d] });
sv('lore:n-one', { updatedAt: u(11), scopes: [SC.c] });
sv('lore:n-one', { updatedAt: u(12), scopes: [SC.d] });
sv('lore:n-one', { updatedAt: u(13), scopes: [SC.e] }); // a later version: not the row's updatedAt
// skip reasons
seeds.push({ id: `lore:n-nolog${rev(13)}`, text: 'zz-secret-old-text', scopes: UND1, updatedAt: u(14), kind: 'rev', verdict: 'no_version_log' });
seeds.push({ id: `lore:n-nomatch${rev(14)}`, text: 'zz-secret-old-text', scopes: UND1, updatedAt: u(15), kind: 'rev', verdict: 'no_match' });
sv('lore:n-nomatch', { updatedAt: u(16), scopes: [SC.a] }); // same node, different updatedAt
seeds.push({ id: `lore:n-amb${rev(15)}`, text: 'zz-secret-old-text', scopes: UND1, updatedAt: u(17), kind: 'rev', verdict: 'ambiguous_match' });
sv('lore:n-amb', { updatedAt: u(17), scopes: [SC.x] });
sv('lore:n-amb', { updatedAt: u(17), scopes: [SC.y] });
seeds.push({ id: `lore:n-cnt${rev(16)}`, text: 'zz-secret-old-text', scopes: UND2, updatedAt: u(18), kind: 'rev', verdict: 'count_mismatch' });
sv('lore:n-cnt', { updatedAt: u(18), scopes: [SC.a] });
seeds.push({ id: `lore:n-empty${rev(17)}`, text: 'zz-secret-old-text', scopes: UND1, updatedAt: u(19), kind: 'rev', verdict: 'empty_or_invalid_scopes' });
sv('lore:n-empty', { updatedAt: u(19), scopes: [] });
seeds.push({ id: `lore:n-inv${rev(18)}`, text: 'zz-secret-old-text', scopes: UND1, updatedAt: u(20), kind: 'rev', verdict: 'empty_or_invalid_scopes' });
sv('lore:n-inv', { updatedAt: u(20), scopes: ['undefined'] });
seeds.push({ id: `plain-doc${rev(19)}`, text: 'zz-secret-old-text', scopes: UND1, updatedAt: u(21), kind: 'rev', verdict: 'not_node_row' });
seeds.push({ id: `lore:n-otherws${rev(20)}`, text: 'zz-secret-old-text', scopes: UND1, updatedAt: u(22), kind: 'rev', verdict: 'no_version_log' });
sv('lore:n-otherws', { updatedAt: u(22), scopes: [SC.a], workspace: 'some-other-workspace' });
seeds.push({ id: `lore:n-type${rev(21)}`, text: 'zz-secret-old-text', scopes: UND1, updatedAt: u(23), kind: 'rev', verdict: 'no_match' });
sv('lore:n-type', { updatedAt: u(23), scopes: [SC.a], type: 'decision' }); // the row is a 'note'
// untouchable classes and already-fine rows
seeds.push({ id: `lore:n-two${rev(22)}`, text: 'zz-secret-old-text mixed', scopes: ['undefined', SC.a], updatedAt: u(10), kind: 'rev' }); // mixed: version matches but must stay
seeds.push({ id: `lore:n-two${rev(40)}`, text: 'zz-secret-old-text ok', scopes: [SC.a], updatedAt: u(24), kind: 'rev' });
seeds.push({ id: `lore:n-two${rev(41)}`, text: 'zz-secret-old-text empty', scopes: [], updatedAt: u(25), kind: 'rev' });
seeds.push({ id: `lore:n-unr${rev(42)}`, text: 'zz-secret-old-text unreadable', scopes: [], rawScopes: 'not json{', updatedAt: u(26), kind: 'rev', sqliteOnly: true });
sv('lore:n-unr', { updatedAt: u(26), scopes: [SC.a] });
seeds.push({ id: `lore:n-dup${rev(43)}`, text: 'zz-secret-old-text dup1', scopes: UND1, updatedAt: u(27), kind: 'rev', verdict: 'duplicate_id', lanceOnly: true });
seeds.push({ id: `lore:n-dup${rev(43)}`, text: 'zz-secret-old-text dup2', scopes: UND1, updatedAt: u(27), kind: 'rev', verdict: 'duplicate_id', lanceOnly: true });
sv('lore:n-dup', { updatedAt: u(27), scopes: [SC.a] });
// tombstones: proven by the same-instant #rev sibling + text tail
const TN = ts(30);
seeds.push({ id: 'lore:n-tomb', text: `[TOMBSTONED ${TN} reason: dead]\n\nzz-secret-orig-text`, scopes: UND2, updatedAt: TN, kind: 'tomb', verdict: 'restorable', restoredTo: [SC.a, SC.t] });
seeds.push({ id: `lore:n-tomb${rev(30)}`, text: 'zz-secret-orig-text', scopes: UND2, updatedAt: u(28), kind: 'rev', verdict: 'restorable', restoredTo: [SC.a, SC.t] });
sv('lore:n-tomb', { updatedAt: u(28), scopes: [SC.a, SC.t] });
const TN2 = ts(31);
seeds.push({ id: 'lore:n-tomb2', text: `[TOMBSTONED ${TN2} reason: dead]\n\nzz-secret-orig-text`, scopes: UND1, updatedAt: TN2, kind: 'tomb', verdict: 'tombstone_unproven' }); // no sibling
const TN3 = ts(32);
seeds.push({ id: 'lore:n-tomb3', text: `[TOMBSTONED ${TN3} reason: dead]\n\nzz-secret-orig-text AAA`, scopes: UND1, updatedAt: TN3, kind: 'tomb', verdict: 'tombstone_unproven' }); // sibling text differs
seeds.push({ id: `lore:n-tomb3${rev(32)}`, text: 'zz-secret-orig-text BBB', scopes: UND1, updatedAt: u(29), kind: 'rev', verdict: 'restorable', restoredTo: [SC.e] });
sv('lore:n-tomb3', { updatedAt: u(29), scopes: [SC.e] });
seeds.push({ id: 'lore:n-tomb-ok', text: `[TOMBSTONED ${ts(33)} reason: dead]\n\nzz-secret-orig-text`, scopes: [SC.a], updatedAt: ts(33), kind: 'tomb' });
// bulk: many restorable rows (exceeds the sample cap, forces several Lance chunks)
for (let i = 0; i < N_BULK; i++) {
    seeds.push({ id: `lore:n-bulk-${i}${rev(100 + i)}`, text: `zz-secret-old-text bulk ${i}`, scopes: UND1, updatedAt: u(100 + i), kind: 'rev', verdict: 'restorable', restoredTo: [SC.bulk] });
    sv(`lore:n-bulk-${i}`, { updatedAt: u(100 + i), scopes: [SC.bulk] });
}

const seedsFor = (engine: 'lance' | 'sqlite'): Seed[] => seeds.filter((x) => engine === 'lance' ? !x.sqliteOnly : !x.lanceOnly);
const isDamaged = (x: Seed): boolean => x.rawScopes === undefined && classifyScopes(x.scopes) === 'all_undefined';
const kindOf = (x: Seed): 'canonical_live' | 'canonical_tombstone' | 'history' => x.kind === 'rev' ? 'history' : x.kind === 'tomb' ? 'canonical_tombstone' : 'canonical_live';

function expectedFor(engine: 'lance' | 'sqlite') {
    const ss = seedsFor(engine);
    const totals = { ok: 0, all_undefined: 0, mixed_undefined: 0, unreadable: 0 };
    const verdicts = Object.fromEntries(REPAIR_VERDICTS.map((v) => [v, 0])) as Record<RepairVerdict, number>;
    for (const x of ss) {
        if (x.rawScopes !== undefined) { totals.unreadable++; continue; }
        const c = classifyScopes(x.scopes);
        totals[c]++;
        if (c === 'all_undefined') {
            assert.ok(x.verdict, `seed ${x.id} needs an expected verdict`);
            verdicts[x.verdict!]++;
        }
    }
    return { totalRows: ss.length, totals, verdicts, restorable: ss.filter((x) => x.restoredTo).length };
}

// ── Seeding ─────────────────────────────────────────────────────────────────
function writeVersions(dir: string, wsName: string, only?: (v: VersionSeed) => boolean): void {
    fs.mkdirSync(dir, { recursive: true });
    const vs = VersionStore.open(dir);
    try {
        versions.filter(only ?? (() => true)).forEach((v, i) => {
            const ref = seeds.find((x) => nodeOf(x.id) === v.node);
            vs.recordVersion({
                versionId: `v-${wsName}-${v.node}-${i}`, nodeId: v.node, workspace: v.workspace ?? wsName,
                timestamp: ts(9000 + i), principal: 'mcp', operation: 'update', previousState: null,
                newState: { id: v.node, type: v.type ?? 'note', label: v.label ?? (ref ? labelOf(ref) : `lbl-${v.node}`), updatedAt: v.updatedAt, security_scopes: v.scopes },
                changesetId: null,
            });
        });
    } finally { vs.close(); }
}

async function buildLance(home: string, name: string, versionsDir: 'ws' | 'home' | 'none' = 'ws'): Promise<string> {
    const entry = createWorkspace(name, {}, home);
    assert.equal(entry.vectorEngine, 'lance');
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
            await t.add(seedsFor('lance').map((x, i) => ({
                vector: vector.map((v, j) => v + (i % 5) * 0.001 * (j + 1)), id: x.id, text: x.text, type: x.type ?? 'note', label: labelOf(x), tags: '', project: '', ecosystem: '',
                updatedAt: x.updatedAt, security_scopes: x.scopes, contentHash: `h-${x.id}-${i}`,
            })));
        } finally { t.close(); }
    } finally { conn.close(); }
    if (versionsDir === 'ws') writeVersions(path.join(entry.path, '.lore'), name);
    if (versionsDir === 'home') writeVersions(path.join(home, '.lore'), name);
    return entry.path;
}

async function buildSqlite(home: string, name: string, versionsDir: 'ws' | 'home' | 'none' = 'ws'): Promise<string> {
    const entry = createWorkspace(name, {}, home);
    setWorkspaceVectorEngine(name, 'sqlite', home);
    const imp = await openVerbatimRawImport(entry.path);
    try {
        const rows: RawVerbatimImportRow[] = seedsFor('sqlite').map((x, i) => {
            const isRev = x.kind === 'rev';
            const baseId = isRev ? x.id.slice(0, x.id.indexOf('#rev')) : x.id;
            const when = isRev ? x.id.slice(x.id.indexOf('#rev') + 4) : x.updatedAt;
            return {
                id: baseId, text: x.text, vector: null, content_hash: `h-${x.id}-${i}`, type: x.type ?? 'note', label: labelOf(x), tags: '', project: '', ecosystem: '',
                updatedAt: x.updatedAt,
                security_scopes: x.rawScopes ?? (x.scopes.length === 0 ? null : JSON.stringify(x.scopes)),
                is_canonical: isRev ? 0 : 1, is_tombstone: x.kind === 'tomb' ? 1 : 0,
                superseded_at: isRev ? when : null, created_at: when, updated_at: when,
            };
        });
        imp.importRows(rows);
    } finally { imp.close(); }
    if (versionsDir === 'ws') writeVersions(path.join(entry.path, '.lore'), name);
    if (versionsDir === 'home') writeVersions(path.join(home, '.lore'), name);
    return entry.path;
}

// ── Disk views ──────────────────────────────────────────────────────────────
function snapshot(root: string): string {
    const h = createHash('sha256');
    const walk = (d: string): void => {
        for (const name of fs.readdirSync(d).sort()) {
            const p = path.join(d, name);
            const st = fs.lstatSync(p);
            if (name.endsWith('-shm')) { h.update(`${path.relative(root, p)}\0shm\0`); continue; } // WAL shared-memory index: any reader's attach touches its mtime; it holds no data
            h.update(`${path.relative(root, p)}\0${st.size}\0${st.mtimeMs}\0${st.isDirectory() ? 'd' : 'f'}\0`);
            if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
        }
    };
    walk(root);
    return h.digest('hex');
}

interface DiskRow { id: string; other: string; scopes: string[] | string }
const toList = (v: unknown): string[] => {
    if (v === null || v === undefined) return [];
    const o = v as { toArray?: () => ArrayLike<unknown> };
    return Array.from(typeof o.toArray === 'function' ? o.toArray() : (v as ArrayLike<unknown>)).map(String);
};
async function readDisk(engine: 'lance' | 'sqlite', wsPath: string): Promise<DiskRow[]> {
    const out: DiskRow[] = [];
    if (engine === 'lance') {
        const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
        try {
            const t = await conn.openTable('lore_verbatim');
            try {
                for (const r of await t.query().toArray() as Array<Record<string, unknown>>) {
                    const { security_scopes, vector, ...rest } = r;
                    out.push({ id: String(r['id']), other: JSON.stringify({ ...rest, vector: Array.from((vector as { toArray(): ArrayLike<number> }).toArray()) }), scopes: toList(security_scopes) });
                }
            } finally { t.close(); }
        } finally { conn.close(); }
    } else {
        const db = new Database(path.join(wsPath, '.lore', 'verbatim.sqlite'), { readonly: true, fileMustExist: true });
        try {
            for (const r of db.prepare('SELECT rowid AS _rowid, * FROM verbatim').all() as Array<Record<string, unknown>>) {
                const { security_scopes, ...rest } = r;
                out.push({ id: String(r['id']), other: JSON.stringify(rest), scopes: security_scopes === null ? [] : String(security_scopes) });
            }
        } finally { db.close(); }
    }
    return out.sort((a, b) => (a.id + a.other < b.id + b.other ? -1 : a.id + a.other > b.id + b.other ? 1 : 0));
}
const scopesOf = (r: DiskRow): string[] => {
    if (typeof r.scopes !== 'string') return r.scopes;
    try { const p: unknown = JSON.parse(r.scopes); return Array.isArray(p) ? p.map(String) : [r.scopes]; } catch { return [r.scopes]; } // raw unreadable text stays as one opaque entry
};
const sqliteBaseId = (id: string): string => id.replace(/#rev.*$/, '');

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
const cli = path.join(here, '..', 'packages', 'lore', 'src', 'cli', 'index.ts');
const standIn = freshHome(); // LORE_HOME for every CLI run: an empty stand-in for the operator's real home
const standInSnap = snapshot(standIn);
type CliResult = { status: number | null; stdout: string; stderr: string };
function runCli(args: string[], extraEnv: Record<string, string> = {}): CliResult {
    const r = spawnSync(tsxBin, [cli, 'verbatim', 'repair-scopes', ...args], {
        encoding: 'utf8', env: { ...process.env, LORE_PORT: '1', LORE_HOME: standIn, ...extraEnv },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function runCliAsync(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
    // Async (not spawnSync): the in-process fake daemon must keep answering while the CLI runs.
    return new Promise((resolve) => {
        const ch = spawn(tsxBin, [cli, 'verbatim', 'repair-scopes', ...args], { env: { ...process.env, LORE_PORT: '1', LORE_HOME: standIn, ...extraEnv } });
        let stdout = ''; let stderr = '';
        ch.stdout.on('data', (d) => { stdout += d; });
        ch.stderr.on('data', (d) => { stderr += d; });
        ch.on('close', (code) => resolve({ status: code, stdout, stderr }));
    });
}

function assertNoSensitive(label: string, text: string): void {
    for (const v of [...Object.values(SC), ...SECRET_TEXTS]) assert.equal(text.includes(v), false, `${label}: '${v}' must never be printed`);
}
const seededIds = (engine: 'lance' | 'sqlite'): Set<string> => new Set(seedsFor(engine).map((x) => x.id));

type Report = Awaited<ReturnType<typeof repairVerbatimScopes>>;
function assertPlanned(r: Report, engine: 'lance' | 'sqlite'): void {
    const ex = expectedFor(engine);
    assert.equal(r.status, 'planned');
    assert.equal(r.engine, engine);
    assert.equal(r.totalRows, ex.totalRows);
    assert.deepEqual(r.totals, ex.totals);
    assert.deepEqual(r.verdicts, ex.verdicts);
    assert.equal(r.verdicts.restorable, ex.restorable);
    assert.ok(r.verdicts.restorable > SAMPLE_CAP, 'fixture exceeds the sample cap');
    assert.equal(r.samples.restorable.length, SAMPLE_CAP);
    for (const v of REPAIR_VERDICTS) {
        assert.equal(r.samples[v].length, v === 'duplicate_id' && engine === 'lance' ? Math.min(1, r.verdicts[v]) : Math.min(SAMPLE_CAP, r.verdicts[v]), `samples for ${v}`); // a duplicated Lance id is listed once
        assert.equal(new Set(r.samples[v]).size, r.samples[v].length);
        for (const id of r.samples[v]) assert.ok(seededIds(engine).has(id), `sample id ${id} is a seeded id`);
    }
    const sum = REPAIR_VERDICTS.reduce((n, v) => n + r.verdicts[v], 0);
    assert.equal(sum, r.totals.all_undefined, 'one verdict per all_undefined row');
    // per-kind split adds up to the overall verdicts
    for (const v of REPAIR_VERDICTS) {
        assert.equal(r.byKind.canonical_live[v] + r.byKind.canonical_tombstone[v] + r.byKind.history[v], r.verdicts[v]);
    }
    assert.equal(r.byKind.canonical_live.live_row_unproven, 1);
    assert.equal(r.verdicts.tombstone_unproven, 2);
    assert.equal(r.byKind.canonical_tombstone.restorable, 1);
    assert.equal(r.versionLog.files.length, 1);
    // exact verdict per seeded row, through the sample lists for the small verdicts
    for (const x of seedsFor(engine)) {
        if (!x.verdict || x.verdict === 'restorable') continue;
        assert.ok(r.samples[x.verdict].includes(x.id), `${x.id} should be sampled under ${x.verdict}`);
    }
}

console.log('VERBATIM REPAIR-SCOPES — proven restoration of damaged security_scopes (post-3.28.0)\n');

for (const engine of ['lance', 'sqlite'] as const) {
    const build = engine === 'lance' ? buildLance : buildSqlite;

    await test(`A. ${engine}: dry run gives a verdict per damaged row, counts + ids only, writes nothing`, async () => {
        const home = freshHome();
        loadWorkspaces(home);
        const ws = await build(home, 'vrs-a');
        const rowsBefore = await readDisk(engine, ws);
        const snap = snapshot(home);
        const r = await repairVerbatimScopes({ workspaceName: 'vrs-a', home });
        assertPlanned(r, engine);
        assert.equal(r.apply, false);
        assert.equal(r.backup, undefined);
        assert.equal(snapshot(home), snap, 'engine dry run: tree digest (sizes, mtimes, bytes) unchanged');
        assertNoSensitive('engine report', JSON.stringify(r));
        const j = runCli(['vrs-a', '--data-dir', home, '--json']);
        assert.equal(j.status, 0, `${j.stdout}\n${j.stderr}`);
        assertPlanned(JSON.parse(j.stdout), engine);
        assertNoSensitive('cli --json', j.stdout + j.stderr);
        const h = runCli(['vrs-a', '--data-dir', home]);
        assert.equal(h.status, 0, `${h.stdout}\n${h.stderr}`);
        assert.match(h.stdout, /dry run — nothing is written/);
        assert.match(h.stdout, /restorable\s+31/);
        assert.match(h.stdout, /Re-run with --apply/);
        assertNoSensitive('cli human', h.stdout + h.stderr);
        assert.equal(snapshot(home), snap, 'CLI dry runs: tree digest unchanged');
        assert.equal(snapshot(standIn), standInSnap, 'the stand-in home is untouched');
        assert.deepEqual(await readDisk(engine, ws), rowsBefore);
        assert.equal(fs.existsSync(path.join(home, 'verbatim-repair-scopes-backups')), false, 'no backup dir for a dry run');
    });

    await test(`B. ${engine}: --apply restores exactly the provable rows, backs up first, changes nothing else, second run is a no-op`, async () => {
        const home = freshHome();
        loadWorkspaces(home);
        const ws = await build(home, 'vrs-b');
        const before = await readDisk(engine, ws);
        const bak = outDir();
        const r = await repairVerbatimScopes({ workspaceName: 'vrs-b', home, apply: true, backupOutDir: bak, chunkSize: 4, daemonProbePort: DEAD_PORT });
        const ex = expectedFor(engine);
        assert.equal(r.status, 'applied');
        assert.equal(r.restored, ex.restorable);
        assert.ok(r.backup && fs.existsSync(r.backup.tarballPath) && fs.statSync(r.backup.tarballPath).size > 0, 'backup tarball exists');
        assert.ok(r.backup!.tarballPath.startsWith(bak));
        assert.deepEqual(r.verdicts, ex.verdicts, 'the report describes the plan that was applied');
        assert.equal(r.verified!.totalRows, ex.totalRows);
        assert.equal(r.verified!.remainingAllUndefined, ex.totals.all_undefined - ex.restorable);
        assertNoSensitive('apply report', JSON.stringify(r));

        const after = await readDisk(engine, ws);
        assert.equal(after.length, before.length, 'row count unchanged');
        assert.deepEqual(after.map((x) => x.other), before.map((x) => x.other), 'every non-scope field (text, vector, updatedAt, contentHash, ids) is identical');
        // Per-row expectations: restored rows hold exactly their proven scopes; every other row's scopes are unchanged.
        const byKey = (rows: DiskRow[]): Map<string, DiskRow[]> => {
            const m = new Map<string, DiskRow[]>();
            for (const x of rows) { const l = m.get(x.id) ?? []; l.push(x); m.set(x.id, l); }
            return m;
        };
        const aft = byKey(after);
        let restored = 0;
        for (const x of seedsFor(engine)) {
            const key = engine === 'lance' ? x.id : sqliteBaseId(x.id);
            if (x.restoredTo) {
                const cands = (aft.get(key) ?? []).filter((d) => JSON.stringify(scopesOf(d)) === JSON.stringify(x.restoredTo));
                assert.ok(cands.length >= 1, `${x.id} should hold ${JSON.stringify(x.restoredTo)}`);
                restored++;
            }
        }
        assert.equal(restored, ex.restorable);
        const changed = after.filter((d, i) => JSON.stringify(d.scopes) !== JSON.stringify(before[i]!.scopes));
        assert.equal(changed.length, ex.restorable, 'exactly the restorable rows changed their scopes');
        for (const d of changed) assert.equal(classifyScopes(scopesOf(d)), 'ok');
        // Only damaged rows were rewritten; everything else keeps its exact stored scopes.
        for (let i = 0; i < after.length; i++) {
            if (JSON.stringify(after[i]!.scopes) === JSON.stringify(before[i]!.scopes)) continue;
            assert.equal(classifyScopes(scopesOf(before[i]!)), 'all_undefined', `only all_undefined rows were rewritten (${after[i]!.id})`);
        }
        // No canonical's current scopes were copied anywhere.
        for (const d of after) {
            if (d.id.startsWith('lore:n-nolog') || d.id.startsWith('lore:n-nomatch') || d.id.startsWith('lore:n-cnt')) {
                const text = (JSON.parse(d.other) as { text: string }).text;
                if (text !== 'zz-secret-live-text cur') assert.equal(scopesOf(d).includes(SC.cur), false, `${d.id} must not carry the canonical's current scope`);
            }
        }
        // Rows that must not have been touched (mixed, unreadable, skip reasons, live canonical).
        const stillDamaged = after.filter((d) => classifyScopes(scopesOf(d)) === 'all_undefined').length;
        assert.equal(stillDamaged, ex.totals.all_undefined - ex.restorable);

        // Second apply: nothing left to prove, writes nothing, takes no backup.
        const snap = snapshot(home);
        const bakEntries = fs.existsSync(bak) ? fs.readdirSync(bak).length : 0;
        const r2 = await repairVerbatimScopes({ workspaceName: 'vrs-b', home, apply: true, backupOutDir: bak, daemonProbePort: DEAD_PORT });
        assert.equal(r2.status, 'planned');
        assert.equal(r2.verdicts.restorable, 0);
        assert.equal(r2.restored, undefined);
        assert.equal(r2.backup, undefined);
        assert.equal(snapshot(home), snap, 'second apply wrote nothing');
        assert.equal(fs.existsSync(bak) ? fs.readdirSync(bak).length : 0, bakEntries, 'second apply took no backup');
        assert.deepEqual(await readDisk(engine, ws), after);
    });
}

await test('C. no version log at all: every damaged row is no_version_log, --apply writes and backs up nothing', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLance(home, 'vrs-c', 'none');
    const before = await readDisk('lance', ws);
    const bak = outDir();
    const r = await repairVerbatimScopes({ workspaceName: 'vrs-c', home, apply: true, backupOutDir: bak, daemonProbePort: DEAD_PORT });
    assert.equal(r.status, 'planned');
    assert.equal(r.verdicts.restorable, 0);
    assert.deepEqual(r.versionLog.files, []);
    assert.equal(r.verdicts.no_version_log + r.verdicts.not_node_row + r.verdicts.live_row_unproven + r.verdicts.tombstone_unproven + r.verdicts.duplicate_id, r.totals.all_undefined);
    assert.equal(fs.existsSync(bak), false, 'no backup directory was even created');
    assert.deepEqual(await readDisk('lance', ws), before);
});

await test('D. versions.sqlite in the home\'s own .lore is found; another workspace\'s records in it are not used', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildLance(home, 'vrs-d', 'none');
    writeVersions(path.join(home, '.lore'), 'vrs-d'); // boot-workspace layout: versions live beside the registry
    // the same node ids recorded under a DIFFERENT workspace with other scopes: must be ignored
    const extra = VersionStore.open(path.join(home, '.lore'));
    try {
        extra.recordVersion({
            versionId: 'foreign-1', nodeId: 'n-two', workspace: 'someone-else', timestamp: ts(9500), principal: 'mcp', operation: 'update', previousState: null,
            newState: { id: 'n-two', type: 'note', label: 'lbl-n-two', updatedAt: u(10), security_scopes: ['zz_scope_foreign'] }, changesetId: null,
        });
    } finally { extra.close(); }
    const r = await repairVerbatimScopes({ workspaceName: 'vrs-d', home });
    assertPlanned(r, 'lance');
    assert.equal(r.versionLog.files.length, 1);
    assert.ok(r.versionLog.files[0]!.startsWith(path.join(home, '.lore')));
    const ex = expectedFor('lance');
    assert.equal(r.verdicts.restorable, ex.restorable, 'the foreign record neither added a match nor made n-two ambiguous');
});

await test('E. a daemon serving the home: --apply refuses (engine and CLI), nothing changes; the dry run still works', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLance(home, 'vrs-e');
    fs.writeFileSync(path.join(home, 'auth.token'), 'tok-vrs\n');
    const srv = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ loreHome: home, status: 'ok' })); });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as net.AddressInfo).port;
    try {
        const tree = snapshot(home);
        const rows = await readDisk('lance', ws);
        await assert.rejects(
            repairVerbatimScopes({ workspaceName: 'vrs-e', home, apply: true, backupOutDir: outDir(), daemonProbePort: port }),
            /daemon is running/,
        );
        assert.equal(snapshot(home), tree, 'refusal wrote nothing');
        const ro = await repairVerbatimScopes({ workspaceName: 'vrs-e', home, daemonProbePort: port });
        assert.equal(ro.status, 'planned');
        const c = await runCliAsync(['vrs-e', '--apply', '--data-dir', home], { LORE_PORT: String(port) });
        assert.equal(c.status, 1, `${c.stdout}\n${c.stderr}`);
        assert.match(c.stderr, /daemon is running/);
        assert.equal(snapshot(home), tree);
        assert.deepEqual(await readDisk('lance', ws), rows);
        assert.equal(fs.existsSync(path.join(home, 'verbatim-repair-scopes-backups')), false);
    } finally { await new Promise<void>((resolve) => srv.close(() => resolve())); }
});

await test('F. target guard: no registry, unknown workspace, stale copied registry, missing --data-dir (dry run and --apply)', async () => {
    const home3 = freshHome();
    for (const extra of [[], ['--apply']]) {
        const c3 = runCli(['anything', '--data-dir', home3, ...extra]);
        assert.equal(c3.status, 1);
        assert.match(c3.stderr, /verbatim repair-scopes refused: no workspaces\.json at /);
    }
    assert.deepEqual(fs.readdirSync(home3), [], 'nothing created');
    const home = freshHome();
    loadWorkspaces(home);
    await buildLance(home, 'vrs-f');
    for (const extra of [[], ['--apply']]) {
        const c4 = runCli(['nope', '--data-dir', home, ...extra]);
        assert.equal(c4.status, 1);
        assert.match(c4.stderr, /verbatim repair-scopes refused: workspace 'nope' is not in /);
    }
    // A copy whose registry still points at the original roots is refused, for --apply too; the original stays untouched.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vrs-copy-'));
    fs.cpSync(home, copy, { recursive: true });
    const snapCopy = snapshot(copy), snapHome = snapshot(home);
    for (const extra of [[], ['--apply']]) {
        const c5 = runCli(['vrs-f', '--data-dir', copy, ...extra], { LORE_HOME: home });
        assert.equal(c5.status, 1, `${c5.stdout}\n${c5.stderr}`);
        assert.match(c5.stderr, /refused/);
    }
    assert.equal(snapshot(copy), snapCopy);
    assert.equal(snapshot(home), snapHome, 'the original was never written');
    const c6 = runCli(['vrs-f', '--data-dir', path.join(os.tmpdir(), 'lore-vrs-does-not-exist'), '--apply']);
    assert.equal(c6.status, 1);
    assert.match(c6.stderr, /does not exist or is not a directory/);
    // Engine-level refusals.
    await assert.rejects(repairVerbatimScopes({ workspaceName: 'vrs-f', home: home3 }), /no workspace registry/);
    await assert.rejects(repairVerbatimScopes({ workspaceName: 'nope', home }), /workspace_not_found: "nope"/);
    await assert.rejects(repairVerbatimScopes({ workspaceName: 'vrs-f', home, apply: true, daemonProbePort: DEAD_PORT }), /needs a backup directory/);
    assert.deepEqual(fs.readdirSync(home3), [], 'engine created nothing either');
    assert.equal(snapshot(home), snapHome);
});

await test('G. strict flags: unknown / misspelled flags and bad positionals are usage errors that do no work; bare usage lists the command', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    await buildLance(home, 'vrs-g');
    const snap = snapshot(home);
    for (const args of [['vrs-g', '--bogus', '--data-dir', home], ['vrs-g', '--aply', '--data-dir', home], ['vrs-g', '--jsno', '--data-dir', home], ['vrs-g', '--json=1', '--data-dir', home],
        ['--data-dir', home], ['vrs-g', 'extra', '--data-dir', home], ['vrs-g', '--data-dri', home], ['vrs-g', '--apply=1', '--data-dir', home]]) {
        const c = runCli(args);
        assert.equal(c.status, 1, `${args.join(' ')}: ${c.stdout}\n${c.stderr}`);
        assert.match(c.stderr, /lore verbatim repair-scopes: /);
        assert.match(c.stderr, /usage: lore verbatim repair-scopes/);
        assert.equal(c.stdout.includes('Home:'), false, 'rejected before doing any work');
    }
    assert.equal(snapshot(home), snap);
    assert.equal(snapshot(standIn), standInSnap);
    const u2 = spawnSync(tsxBin, [cli, 'verbatim'], { encoding: 'utf8', env: { ...process.env, LORE_HOME: standIn, LORE_PORT: '1' } });
    assert.match(u2.stderr, /lore verbatim repair-scopes <workspace>/);
    // check-scopes stays read-only: --apply is still rejected there.
    const cs = spawnSync(tsxBin, [cli, 'verbatim', 'check-scopes', 'vrs-g', '--apply', '--data-dir', home], { encoding: 'utf8', env: { ...process.env, LORE_HOME: standIn, LORE_PORT: '1' } });
    assert.equal(cs.status, 1);
    assert.match(cs.stderr, /lore verbatim check-scopes: /);
    assert.equal(snapshot(home), snap);
});

await test('K. --apply refuses when the backup could not copy the store it is about to write (Lance)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLance(home, 'vrs-i');
    const before = await readDisk('lance', ws);
    // An unreadable stray file makes backupWorkspace's lancedb/ copy fail; it
    // downgrades that to a warning, which repair-scopes must treat as fatal.
    const blocker = path.join(ws, '.lore', 'lancedb', 'zz-unreadable');
    fs.writeFileSync(blocker, 'x');
    fs.chmodSync(blocker, 0o000);
    try {
        await assert.rejects(
            repairVerbatimScopes({ workspaceName: 'vrs-i', home, apply: true, backupOutDir: outDir(), daemonProbePort: DEAD_PORT }),
            /does not contain lancedb\/.*refusing to write\. Nothing was changed\./,
        );
    } finally { fs.chmodSync(blocker, 0o600); fs.rmSync(blocker); }
    assert.deepEqual(await readDisk('lance', ws), before, 'nothing written');
});

await test('H. a row changed by another writer between plan and write aborts the run, names the backup, and writes nothing it should not (Lance)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLance(home, 'vrs-h');
    const before = await readDisk('lance', ws);
    const victim = `lore:n-two${rev(10)}`;
    let hooked = 0;
    await assert.rejects(
        repairVerbatimScopes({
            workspaceName: 'vrs-h', home, apply: true, backupOutDir: outDir(), chunkSize: 4, daemonProbePort: DEAD_PORT,
            beforeRecheck: async (i) => {
                if (i !== 0 || hooked++ > 0) return;
                const conn = await lancedb.connect(path.join(ws, '.lore', 'lancedb'));
                try {
                    const t = await conn.openTable('lore_verbatim');
                    try { await t.update({ where: `id = '${victim}'`, values: { updatedAt: 'changed-by-another-writer' } }); } finally { t.close(); }
                } finally { conn.close(); }
            },
        }),
        (e: Error) => /ABORTED: row 'lore:n-two#rev[^']*' changed since it was read/.test(e.message) && /backup at /.test(e.message),
    );
    const after = await readDisk('lance', ws);
    const v = after.find((d) => d.id === victim)!;
    assert.deepEqual(scopesOf(v), UND2, 'the changed row was not written');
    // Only restorable rows may differ, and the victim's own change (updatedAt) is the other writer's.
    for (let i = 0; i < after.length; i++) {
        const b = before.find((d) => d.id === after[i]!.id && d.other === after[i]!.other) ?? null;
        if (b === null) { assert.equal(after[i]!.id, victim); continue; }
        if (JSON.stringify(b.scopes) !== JSON.stringify(after[i]!.scopes)) assert.equal(classifyScopes(b.scopes as string[]), 'all_undefined');
    }
    assert.equal(after.length, before.length);
});

await test('H2. SQLite: a concurrent change rolls the chunk back, nothing is restored', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildSqlite(home, 'vrs-h2');
    const before = await readDisk('sqlite', ws);
    await assert.rejects(
        repairVerbatimScopes({
            workspaceName: 'vrs-h2', home, apply: true, backupOutDir: outDir(), daemonProbePort: DEAD_PORT,
            beforeRecheck: () => {
                const db = new Database(path.join(ws, '.lore', 'verbatim.sqlite'));
                try { db.prepare(`UPDATE verbatim SET updatedAt = 'changed-by-another-writer' WHERE id = 'lore:n-two' AND is_canonical = 0 AND superseded_at = ?`).run(ts(10)); } finally { db.close(); }
            },
        }),
        (e: Error) => /ABORTED: row 'lore:n-two#rev[^']*' changed since it was read/.test(e.message) && /rolled back/.test(e.message) && /backup at /.test(e.message),
    );
    const after = await readDisk('sqlite', ws);
    assert.equal(after.length, before.length);
    assert.deepEqual(after.map((d) => d.scopes), before.map((d) => d.scopes), 'no scopes changed anywhere');
});

await test('I. CLI --apply end to end: prints the backup path and counts, never a scope or text; --json carries the same report', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLance(home, 'vrs-i');
    const c = runCli(['vrs-i', '--apply', '--data-dir', home]);
    assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
    assert.match(c.stdout, /Verbatim scope repair: 'vrs-i' \(lance, APPLY\)/);
    const m = /Backup:\s+(\S+)/.exec(c.stdout);
    assert.ok(m && fs.existsSync(m[1]!), 'printed backup path exists');
    assert.ok(m![1]!.startsWith(path.join(home, 'verbatim-repair-scopes-backups')));
    assert.match(c.stdout, /Restored:\s+31 row\(s\)/);
    assert.match(c.stdout, /Verified:\s+\d+ rows \(count unchanged\)/);
    assert.match(c.stderr, /WARNING: close every app that embeds Lore/);
    assertNoSensitive('cli apply', c.stdout + c.stderr);
    const rows = await readDisk('lance', ws);
    assert.equal(rows.filter((d) => classifyScopes(scopesOf(d)) === 'all_undefined').length, expectedFor('lance').totals.all_undefined - 31);
    // Second CLI apply: nothing provable remains.
    const c2 = runCli(['vrs-i', '--apply', '--data-dir', home, '--json']);
    assert.equal(c2.status, 0, `${c2.stdout}\n${c2.stderr}`);
    const j = JSON.parse(c2.stdout);
    assert.equal(j.status, 'planned');
    assert.equal(j.verdicts.restorable, 0);
    for (const k of ['status', 'workspaceName', 'engine', 'apply', 'totalRows', 'totals', 'verdicts', 'byKind', 'samples', 'versionLog', 'durationMs']) assert.ok(k in j, `json has ${k}`);
    assertNoSensitive('cli json', c2.stdout);
    assert.equal(snapshot(standIn), standInSnap);
});

await test('J. no verbatim store: nothing to check, exit 0, nothing written', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    createWorkspace('vrs-j', {}, home);
    createWorkspace('vrs-j2', {}, home);
    setWorkspaceVectorEngine('vrs-j2', 'sqlite', home);
    const snap = snapshot(home);
    for (const w of ['vrs-j', 'vrs-j2']) {
        const c = runCli([w, '--data-dir', home, '--apply']);
        assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
        assert.match(c.stdout, /nothing to check/);
        const j = runCli([w, '--data-dir', home, '--json']);
        assert.equal(j.status, 0);
        assert.equal(JSON.parse(j.stdout).status, 'nothing-to-check');
    }
    assert.equal(snapshot(home), snap);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

/**
 * review-i-dedupe-cli-unit.ts — review slice I (3.28.0):
 *   I1. Stricter dedupe identity (rowIdentityKey): same hash + different
 *       scopes / a live row beside its tombstoned twin are DIFFERING in both
 *       dedupe paths; same everything but updatedAt is identical (newest kept).
 *   I2. `verbatim dedupe --apply` re-checks each chunk right before its delete
 *       and aborts if another writer changed it; prints the close-embedded-hosts
 *       warning (stderr in --json mode).
 *   I3. migrateEmptySource restores a prior fingerprint's bytes on failure.
 *   I4. doctor's duplicate hint carries --data-dir.
 *   I5. cli/args.ts: -h/--help as a flag VALUE does not trigger help; a
 *       dash-leading non-numeric value is a missing value.
 *
 * Run: npx tsx test/review-i-dedupe-cli-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lancedb from '@lancedb/lancedb';

import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceVectorEngine } from '../packages/lore/src/engines/vectorEngineSelector.js';
import { migrateVectorsToSqlite } from '../packages/lore/src/engines/migrateVectorsToSqlite.js';
import { dedupeVerbatimIdentical } from '../packages/lore/src/engines/verbatimDedupe.js';
import { rowIdentityKey } from '../packages/lore/src/engines/migrateVectorsDedupe.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { readFingerprint } from '../packages/lore/src/engines/embeddingFingerprint.js';
import { parseStrict, UsageError, type ArgSpec } from '../packages/lore/src/cli/args.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
delete process.env['LORE_SEARCH_WORKER'];

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const freshHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-revi-home-'));
const outDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-revi-out-'));

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension: number;
    readonly modelId = 'revi-det';
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

async function withTable<T>(wsPath: string, fn: (t: lancedb.Table) => Promise<T>): Promise<T> {
    const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { return await fn(t); } finally { t.close(); }
    } finally { conn.close(); }
}
const lanceRawRows = (ws: string): Promise<Record<string, unknown>[]> => withTable(ws, async (t) => (await t.query().toArray()) as Record<string, unknown>[]);
const countOf = async (ws: string, id: string): Promise<number> => (await lanceRawRows(ws)).filter((r) => String(r.id) === id).length;

async function buildLanceWs(home: string, name: string, n = 3): Promise<string> {
    const entry = createWorkspace(name, {}, home);
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    for (let i = 0; i < n; i++) await s.store({ id: `${name}-d${i}`, text: `document ${i} about harbours and ferries`, metadata: { type: 'note', label: `d${i}` } });
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
    await withTable(wsPath, (t) => t.add(rows));
}

const base = (home: string, name: string) => ({ workspaceName: name, home, backupOutDir: outDir(), skipDaemonCheck: true as const });
const dd = (home: string, name: string, extra: Record<string, unknown> = {}) =>
    dedupeVerbatimIdentical({ workspaceName: name, home, backupOutDir: outDir(), skipDaemonCheck: true, ...extra });

// ── I1 ───────────────────────────────────────────────────────────────────────
console.log('review-I — dedupe identity, apply re-check, empty-source fingerprint, doctor hint, args\n');

await test('I1 unit. rowIdentityKey: scope order and Arrow-style lists do not matter; every identity column does; updatedAt/vector do not; absent columns = \'\'', () => {
    const row = { id: 'x', text: 't', contentHash: 'h', type: 'note', label: 'l', tags: 'a', project: 'p', ecosystem: 'e', security_scopes: ['b', 'a'] };
    const k = rowIdentityKey(row);
    assert.equal(rowIdentityKey({ ...row, security_scopes: ['a', 'b'] }), k, 'scope order is irrelevant');
    assert.equal(rowIdentityKey({ ...row, security_scopes: { toArray: () => ['a', 'b'] } }), k, 'Arrow-like vector coerced');
    assert.equal(rowIdentityKey({ ...row, updatedAt: NEW, vector: [1, 2, 3] }), k, 'updatedAt and vector are not identity');
    for (const [col, v] of [['text', 't2'], ['contentHash', 'h2'], ['type', 'other'], ['label', 'l2'], ['tags', 'b'], ['project', 'p2'], ['ecosystem', 'e2'], ['security_scopes', ['a']]] as const) {
        assert.notEqual(rowIdentityKey({ ...row, [col]: v }), k, `${col} is part of identity`);
    }
    assert.notEqual(rowIdentityKey({ ...row, contentHash: undefined }), k);
    // Old tables without the metadata columns: absent == null == ''.
    assert.equal(rowIdentityKey({ id: 'x', text: 't' }), rowIdentityKey({ id: 'x', text: 't', label: null, tags: '', security_scopes: null }));
    // Same hash, different text (tombstone shape) differs.
    assert.notEqual(rowIdentityKey({ ...row, text: '[TOMBSTONED 2030-01-01]' }), k);
});

await test('I1 a. same hash, different security_scopes: DIFFERING in verbatim dedupe (--apply leaves both rows) and migrate-vectors refuses even with dedupeIdentical', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'i1a');
    await addCopies(ws, 'i1a-d0', [{ updatedAt: NEW, security_scopes: ['team-a'] }]);
    const r = await dd(home, 'i1a');
    assert.equal(r.scan!.differingGroups, 1);
    assert.equal(r.scan!.identicalGroups, 0);
    const a = await dd(home, 'i1a', { apply: true });
    assert.equal(a.status, 'checked', 'nothing identical to apply');
    assert.equal(await countOf(ws, 'i1a-d0'), 2, 'both rows survive');
    const err = await migrateVectorsToSqlite({ ...base(home, 'i1a'), dedupeIdentical: true }).then(() => null, (e: Error) => e);
    assert.ok(err, 'migrate refuses');
    assert.match(err!.message, /DIFFER: 'i1a-d0'/);
    assert.equal(resolveWorkspaceVectorEngine('i1a', home), 'lance');
    assert.equal(await countOf(ws, 'i1a-d0'), 2);
});

await test('I1 b. a live row beside its tombstoned twin (same contentHash, text rewritten) is DIFFERING in both paths', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'i1b');
    await addCopies(ws, 'i1b-d0', [{ updatedAt: NEW, text: '[TOMBSTONED 2030-01-01T00:00:00.000Z]' }]);
    const r = await dd(home, 'i1b');
    assert.equal(r.scan!.differingGroups, 1);
    assert.equal(r.scan!.identicalGroups, 0);
    await dd(home, 'i1b', { apply: true });
    assert.equal(await countOf(ws, 'i1b-d0'), 2);
    await assert.rejects(migrateVectorsToSqlite({ ...base(home, 'i1b'), dedupeIdentical: true }), /DIFFER: 'i1b-d0'/);
});

await test('I1 c. differing type / label / tags / project / ecosystem each make a group DIFFERING', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'i1c', 5);
    await addCopies(ws, 'i1c-d0', [{ type: 'decision' }]);
    await addCopies(ws, 'i1c-d1', [{ label: 'renamed' }]);
    await addCopies(ws, 'i1c-d2', [{ tags: 'extra' }]);
    await addCopies(ws, 'i1c-d3', [{ project: 'other' }]);
    await addCopies(ws, 'i1c-d4', [{ ecosystem: 'other' }]);
    const r = await dd(home, 'i1c');
    assert.equal(r.scan!.differingGroups, 5);
    assert.equal(r.scan!.identicalGroups, 0);
});

await test('I1 d. same everything but updatedAt/vector: IDENTICAL, newest kept (both paths)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'i1d');
    await addCopies(ws, 'i1d-d0', [{ updatedAt: OLD }, { updatedAt: NEW, vector: [1, 0, 0, 0, 0, 0, 0, 0] }]);
    const r = await dd(home, 'i1d');
    assert.equal(r.scan!.identicalGroups, 1);
    assert.equal(r.scan!.differingGroups, 0);
    assert.equal(r.scan!.groups[0]!.keptUpdatedAt, NEW);
    // migrate-vectors dry run agrees (it would dedupe the same group).
    const m = await migrateVectorsToSqlite({ ...base(home, 'i1d'), dedupeIdentical: true, dryRun: true });
    assert.equal(m.dedupedRowsDropped, 2);
    const a = await dd(home, 'i1d', { apply: true });
    assert.equal(a.status, 'applied');
    const left = (await lanceRawRows(ws)).filter((x) => String(x.id) === 'i1d-d0');
    assert.equal(left.length, 1);
    assert.equal(String(left[0]!.updatedAt), NEW);
});

// ── I2 ───────────────────────────────────────────────────────────────────────
await test('I2 a. a concurrent writer between pass 2 and the delete aborts the apply; the newer row survives, nothing deleted for that chunk', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'i2a');
    await addCopies(ws, 'i2a-d0', [{ updatedAt: OLD }, { updatedAt: MID }]);
    const before = (await lanceRawRows(ws)).length;
    const NEWER = '2031-01-01T00:00:00.000Z';
    const err = await dd(home, 'i2a', {
        apply: true,
        beforeRecheck: async () => { await addCopies(ws, 'i2a-d0', [{ updatedAt: NEWER }]); },
    }).then(() => null, (e: Error) => e);
    assert.ok(err, 'apply aborted');
    assert.match(err!.message, /ABORTED: the rows of 'i2a-d0' changed/);
    assert.match(err!.message, /Atlas, MIRA or PM Helper/);
    assert.match(err!.message, /backup at /);
    const after = await lanceRawRows(ws);
    assert.equal(after.length, before + 1, 'nothing was deleted');
    assert.ok(after.some((r) => String(r.id) === 'i2a-d0' && String(r.updatedAt) === NEWER), 'the newer row survives');
});

await test('I2 b. a change in an earlier-chunk-untouched id aborts later chunks; earlier chunks stay done and are reported', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'i2b', 3);
    await addCopies(ws, 'i2b-d0', [{ updatedAt: OLD }]);
    await addCopies(ws, 'i2b-d1', [{ updatedAt: OLD }]);
    const err = await dd(home, 'i2b', {
        apply: true, chunkSize: 1,
        beforeRecheck: async (chunk: number) => {
            if (chunk === 1) await addCopies(ws, 'i2b-d1', [{ updatedAt: NEW }]);
        },
    }).then(() => null, (e: Error) => e);
    assert.ok(err);
    assert.match(err!.message, /ABORTED: the rows of 'i2b-d1'/);
    assert.match(err!.message, /1 extra row\(s\) in 1 earlier chunk\(s\) were already removed/);
    assert.equal(await countOf(ws, 'i2b-d0'), 1, 'chunk 0 stays deduped');
    assert.equal(await countOf(ws, 'i2b-d1'), 3, 'chunk 1 untouched, newer row present');
});

await test('I2 c. no concurrent writer: apply still succeeds (the re-check is invisible)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'i2c');
    await addCopies(ws, 'i2c-d0', [{ updatedAt: OLD }, { updatedAt: NEW }]);
    let calls = 0;
    const r = await dd(home, 'i2c', { apply: true, beforeRecheck: () => { calls++; } });
    assert.equal(r.status, 'applied');
    assert.equal(calls, 1);
    assert.equal(await countOf(ws, 'i2c-d0'), 1);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
const cli = path.join(here, '..', 'packages', 'lore', 'src', 'cli', 'index.ts');
const freePort = (): Promise<number> => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const cliPort = await freePort();
const standIn = freshHome();
const runCli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(tsxBin, [cli, ...args], { encoding: 'utf8', env: { ...process.env, LORE_PORT: String(cliPort), LORE_HOME: standIn, ...env } });

await test('I2 d. CLI --apply prints the close-embedded-hosts warning on stderr (stdout stays pure JSON with --json); usage text carries it too', () => {
    const home = freshHome();
    loadWorkspaces(home);
    // Registry-only workspace: nothing to dedupe, but the apply path still warns before running.
    createWorkspace('i2d', {}, home);
    const c = runCli(['verbatim', 'dedupe', 'i2d', '--apply', '--json', '--data-dir', home]);
    assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
    assert.match(c.stderr, /WARNING: close every app that embeds Lore on this data dir \(Atlas, MIRA, PM Helper\) before running --apply/);
    assert.doesNotThrow(() => JSON.parse(c.stdout), 'stdout is only the JSON document');
    const report = runCli(['verbatim', 'dedupe', 'i2d', '--json', '--data-dir', home]);
    assert.doesNotMatch(report.stderr, /WARNING: close every app/, 'report-only does not warn');
    const bad = runCli(['verbatim', 'dedupe', '--bogus']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /CLOSE every app that embeds Lore on this data dir \(Atlas, MIRA,\s+PM Helper\)/);
});

// ── I3 ───────────────────────────────────────────────────────────────────────
await test('I3. migrateEmptySource failure restores the prior fingerprint bytes (not just removes a fresh one)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('i3', {}, home);
    const ws = entry.path;
    fs.mkdirSync(path.join(ws, '.lore', 'lancedb'), { recursive: true });
    const fpFile = path.join(ws, '.lore', 'lancedb', 'embedding_model.json');
    const prior = JSON.stringify({ modelId: 'prior-model', dimension: 8, writtenAt: '2020-01-01T00:00:00.000Z', version: 1 }, null, 2) + '\n';
    fs.writeFileSync(fpFile, prior);
    // modelId reads 'revi-A' until initialize has stamped it into the fingerprint file, then flips: the post-initialize check fails.
    const flipping = new DetEmbedProvider(8);
    Object.defineProperty(flipping, 'modelId', {
        get(): string {
            try { if (fs.readFileSync(fpFile, 'utf8').includes('"revi-A"')) return 'revi-flipped'; } catch { /* none */ }
            return 'revi-A';
        },
    });
    await assert.rejects(
        migrateVectorsToSqlite({ ...base(home, 'i3'), embeddingProvider: flipping }),
        /not stamped as expected.*UNCHANGED/s,
    );
    assert.equal(fs.readFileSync(fpFile, 'utf8'), prior, 'prior fingerprint bytes restored');
    assert.equal(readFingerprint(ws)!.modelId, 'prior-model');
    assert.equal(resolveWorkspaceVectorEngine('i3', home), 'lance');
    assert.ok(!fs.existsSync(path.join(ws, '.lore', 'verbatim.sqlite')));
});

// ── I4 ───────────────────────────────────────────────────────────────────────
await test('I4. lore doctor duplicate hint includes --data-dir <home>', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const ws = await buildLanceWs(home, 'i4');
    await addCopies(ws, 'i4-d0', [{ updatedAt: OLD }]);
    const r = runCli(['doctor'], { LORE_HOME: home });
    assert.match(r.stdout, new RegExp(`lore verbatim dedupe i4 --data-dir ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), r.stdout);
});

// ── I5 ───────────────────────────────────────────────────────────────────────
const SPEC: ArgSpec = {
    bool: ['--force'],
    value: ['--prefix', '--data-dir'],
    repeatable: ['--tag'],
    aliases: { '-h': '--help' },
    positionals: { max: 1 },
    help: true,
};
const usage = (re: RegExp) => (e: unknown) => e instanceof UsageError && re.test(e.message);

await test('I5 a. -h / --help in a flag\'s VALUE position does not trigger help', () => {
    assert.throws(() => parseStrict(['--prefix', '-h'], SPEC), usage(/--prefix needs a value/));
    assert.throws(() => parseStrict(['--prefix', '--help'], SPEC), usage(/--prefix needs a value/));
    assert.throws(() => parseStrict(['--tag', '--help'], SPEC), usage(/--tag needs a value/));
    // Inline value that happens to be -h is just a value; real help elsewhere still wins.
    const p = parseStrict(['--prefix=-h'], SPEC);
    assert.ok(!p.help);
    assert.equal(p.get('--prefix'), '-h');
    assert.ok(parseStrict(['--prefix', 'x', '-h'], SPEC).help);
    assert.ok(parseStrict(['--bogus', '--help'], SPEC).help, 'unknown flag + help still prints help');
    assert.ok(parseStrict(['--force', '-h'], SPEC).help);
});

await test('I5 b. a dash-leading non-numeric token is a missing value; negative numbers and lone - are values', () => {
    assert.throws(() => parseStrict(['--prefix', '-x'], SPEC), usage(/--prefix needs a value/));
    assert.throws(() => parseStrict(['--prefix', '-x', 'ws'], SPEC), usage(/--prefix needs a value/));
    assert.throws(() => parseStrict(['--prefix', '--force'], SPEC), usage(/--prefix needs a value/));
    assert.equal(parseStrict(['--prefix', '-5'], SPEC).get('--prefix'), '-5');
    assert.equal(parseStrict(['--prefix', '-1.5'], SPEC).get('--prefix'), '-1.5');
    assert.equal(parseStrict(['--prefix', '-'], SPEC).get('--prefix'), '-');
    assert.equal(parseStrict(['--prefix=-x'], SPEC).get('--prefix'), '-x', 'explicit = form passes any value');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

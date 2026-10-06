#!/usr/bin/env tsx
/**
 * verbatim-getbyid-scopes-unit.ts — LanceDB `VerbatimStore.getById` must return
 * a row's `security_scopes`.
 *
 * LanceDB hands List<Utf8> columns back as Arrow vectors, not JS arrays. getById
 * used `Array.isArray(r.security_scopes) ? ... : []`, so on the Lance engine it
 * ALWAYS returned `[]` even though the stored data was correct. Two consequences:
 *   1. `lore migrate-vectors --to sqlite`: the live getById probe compares the
 *      Lance and SQLite metadata, so any Lance row with scopes mismatched and the
 *      migration aborted and rolled back.
 *   2. VerbatimStore.store()'s skip-identical check reads getById, so scoped rows
 *      never compared identical and every re-store rewrote them.
 *
 *   A. getById returns the scopes on Lance (and on SQLite, for parity); a row
 *      with no scopes returns [].
 *   B. migrate-vectors succeeds on a scoped workspace and the SQLite copy's
 *      getById scopes equal the Lance copy's.
 *   C. Skip-identical on Lance with the fix: an identical scoped re-store is a
 *      no-op (Lance table version unchanged); a changed scope SET (added,
 *      removed, replaced, to-empty, from-empty) still writes; a pure re-ordering
 *      is the same set and is a no-op (the comparison sorts both sides).
 *   D. The shared toPlainStringList helper's contract.
 *
 * Run: npx tsx test/verbatim-getbyid-scopes-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lancedb from '@lancedb/lancedb';

import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceVectorEngine } from '../packages/lore/src/engines/vectorEngineSelector.js';
import { migrateVectorsToSqlite } from '../packages/lore/src/engines/migrateVectorsToSqlite.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { toPlainStringList } from '../packages/lore/src/engines/verbatimHistory.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
delete process.env['LORE_SEARCH_WORKER'];

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const freshHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-gbis-home-'));
const outDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-gbis-out-'));

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'gbis-det';
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

/** Lance table version — bumps on every write, so it observes "was rewritten". */
async function lanceVersion(wsPath: string): Promise<number> {
    const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { return await t.version(); } finally { t.close(); }
    } finally { conn.close(); }
}
async function lanceRowCount(wsPath: string): Promise<number> {
    const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try { return await t.countRows(); } finally { t.close(); }
    } finally { conn.close(); }
}

const META = { type: 'note', label: 'l', tags: 't', project: 'p', ecosystem: 'e', updatedAt: '2026-10-05T00:00:00.000Z' };
const TEXT = 'a lighthouse keeper records the tide tables every morning';

console.log('VERBATIM getById security_scopes — Lance Arrow list column\n');

await test('A. Lance getById returns the stored scopes; unscoped row returns []', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('gbis-a', {}, home);
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    try {
        await s.store({ id: 'scoped', text: TEXT, metadata: { ...META, security_scopes: ['scope-a', 'scope-b'] } });
        await s.store({ id: 'plain', text: 'plain row with no scopes', metadata: META });
        const got = await s.getById('scoped');
        assert.ok(got);
        assert.deepEqual([...got!.security_scopes ?? []].sort(), ['scope-a', 'scope-b']);
        assert.ok(Array.isArray(got!.security_scopes), 'returned as a plain JS array');
        assert.deepEqual((await s.getById('plain'))!.security_scopes, []);
        assert.equal(await s.getById('absent'), null);
    } finally { await s.close(); }
});

await test('A. SQLite getById returns the same scopes (parity)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('gbis-a-sql', {}, home);
    const s = new SqliteVerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    try {
        await s.store({ id: 'scoped', text: TEXT, metadata: { ...META, security_scopes: ['scope-a', 'scope-b'] } });
        await s.store({ id: 'plain', text: 'plain row with no scopes', metadata: META });
        assert.deepEqual([...(await s.getById('scoped'))!.security_scopes ?? []].sort(), ['scope-a', 'scope-b']);
        assert.deepEqual((await s.getById('plain'))!.security_scopes, []);
    } finally { await s.close(); }
});

await test('B. migrate-vectors --to sqlite succeeds on a scoped workspace; SQLite getById scopes equal Lance', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('gbis-mig', {}, home);
    const provider = new DetEmbedProvider();
    const lance = new VerbatimStore(entry.path, provider);
    await lance.initialize();
    const ids = ['m-scoped2', 'm-scoped1', 'm-plain'];
    await lance.store({ id: 'm-scoped2', text: TEXT, metadata: { ...META, security_scopes: ['scope-a', 'scope-b'] } });
    await lance.store({ id: 'm-scoped1', text: 'ferry timetable for the harbour', metadata: { ...META, security_scopes: ['only-one'] } });
    await lance.store({ id: 'm-plain', text: 'unscoped document about nothing', metadata: META });
    const lanceScopes: Record<string, string[]> = {};
    for (const id of ids) lanceScopes[id] = [...(await lance.getById(id))!.security_scopes ?? []].sort();
    await lance.close();
    assert.deepEqual(lanceScopes['m-scoped2'], ['scope-a', 'scope-b'], 'Lance copy carries the scopes');

    const report = await migrateVectorsToSqlite({ workspaceName: 'gbis-mig', home, backupOutDir: outDir(), skipDaemonCheck: true });
    assert.equal(resolveWorkspaceVectorEngine('gbis-mig', home), 'sqlite', 'registry flipped');
    assert.ok(report.probeDetails.every((d) => !d.startsWith('MISMATCH')), report.probeDetails.join('; '));
    assert.ok(report.probeDetails.some((d) => d.startsWith('getById(m-scoped2)') && d.endsWith('equal')), 'scoped row probed equal');

    const sq = new SqliteVerbatimStore(entry.path, provider);
    await sq.initialize();
    try {
        for (const id of ids) {
            assert.deepEqual([...(await sq.getById(id))!.security_scopes ?? []].sort(), lanceScopes[id], `SQLite scopes for ${id} equal the Lance copy`);
        }
    } finally { await sq.close(); }
});

await test('C. skip-identical on Lance: identical scoped re-store is a no-op; changed scope SETS still write', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('gbis-skip', {}, home);
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    const put = (scopes?: string[]): Promise<void> => s.store({ id: 'doc', text: TEXT, metadata: { ...META, ...(scopes ? { security_scopes: scopes } : {}) } });
    const scopesNow = async (): Promise<string[]> => [...(await s.getById('doc'))!.security_scopes ?? []];
    try {
        await put(['scope-a', 'scope-b']);
        let v = await lanceVersion(entry.path);
        let rows = await lanceRowCount(entry.path);

        // Identical -> skipped: no new table version, no new #rev row.
        await put(['scope-a', 'scope-b']);
        assert.equal(await lanceVersion(entry.path), v, 'identical scoped re-store did not write');
        assert.equal(await lanceRowCount(entry.path), rows, 'no #rev snapshot row added');

        // Order-only change = same set. The comparison sorts both sides, so this is a no-op.
        await put(['scope-b', 'scope-a']);
        assert.equal(await lanceVersion(entry.path), v, 're-ordered (same set) re-store is skipped');

        // Added scope -> writes.
        await put(['scope-a', 'scope-b', 'scope-c']);
        assert.ok(await lanceVersion(entry.path) > v, 'added scope wrote');
        assert.deepEqual((await scopesNow()).sort(), ['scope-a', 'scope-b', 'scope-c']);
        v = await lanceVersion(entry.path); rows = await lanceRowCount(entry.path);

        // Removed scope -> writes.
        await put(['scope-a', 'scope-b']);
        assert.ok(await lanceVersion(entry.path) > v, 'removed scope wrote');
        assert.deepEqual((await scopesNow()).sort(), ['scope-a', 'scope-b']);
        v = await lanceVersion(entry.path);

        // Replaced scope (same size) -> writes.
        await put(['scope-a', 'scope-z']);
        assert.ok(await lanceVersion(entry.path) > v, 'replaced scope wrote');
        assert.deepEqual((await scopesNow()).sort(), ['scope-a', 'scope-z']);
        v = await lanceVersion(entry.path);

        // Scoped -> empty list -> writes, and reads back [].
        await put([]);
        assert.ok(await lanceVersion(entry.path) > v, 'scopes -> [] wrote');
        assert.deepEqual(await scopesNow(), []);
        v = await lanceVersion(entry.path);

        // Empty twice (omitted vs []) -> identical, skipped.
        await put(undefined);
        assert.equal(await lanceVersion(entry.path), v, 'unscoped identical re-store is skipped');

        // Empty -> scoped -> writes.
        await put(['scope-a']);
        assert.ok(await lanceVersion(entry.path) > v, '[] -> scoped wrote');
        assert.deepEqual(await scopesNow(), ['scope-a']);
    } finally { await s.close(); }
});

await test('E. history snapshots and tombstones of a scoped row keep the scopes (private copy used to write "undefined")', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const entry = createWorkspace('gbis-hist', {}, home);
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    const scopes = ['scope-a', 'scope-b'];
    try {
        await s.store({ id: 'h1', text: 'first version of the text', metadata: { ...META, security_scopes: scopes } });
        await s.store({ id: 'h1', text: 'second version of the text', metadata: { ...META, security_scopes: scopes } }); // snapshotForRev
        await s.storeBatch([{ id: 'h1', text: 'third version of the text', metadata: { ...META, security_scopes: scopes } }]); // batch snapshot
        await s.tombstone('h1', 'test'); // tombstone snapshot + tombstone row
    } finally { await s.close(); }
    const conn = await lancedb.connect(path.join(entry.path, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try {
            const rows = (await t.query().toArray()) as Array<Record<string, unknown>>;
            const family = rows.filter((r) => String(r.id) === 'h1' || String(r.id).startsWith('h1#rev'));
            assert.ok(family.length >= 3, `canonical + history rows present (${family.length})`);
            for (const r of family) {
                const got = [...(r.security_scopes as { toArray(): unknown[] }).toArray()].map(String).sort();
                assert.deepEqual(got, scopes, `scopes intact on ${String(r.id)}`);
            }
        } finally { t.close(); }
    } finally { conn.close(); }
});

await test('F. Lance search paths enforce row scopes (Arrow list column was read as "no scopes" = public)', async () => {
    const home = freshHome();
    loadWorkspaces(home);
    const q = TEXT;
    const mk = async (store: VerbatimStore | SqliteVerbatimStore): Promise<{ vec: string[]; sem: string[]; bm: string[] }> => {
        await store.initialize();
        try {
            await store.store({ id: 'secret', text: TEXT, metadata: { ...META, security_scopes: ['team-x'] } });
            await store.store({ id: 'open', text: 'tide tables are public knowledge', metadata: META });
            const qv = await new DetEmbedProvider().embedQuery(q);
            const ids = (rs: Array<{ id: string }>): string[] => rs.map((r) => r.id).filter((i) => !i.includes('#rev')).sort();
            const other = ['team-y'];
            const bm = await store.bm25Search('lighthouse keeper', 5, undefined, other);
            return {
                vec: ids(await store.searchByVector(qv, { topK: 5, actorScopes: other })),
                sem: ids(await store.search(q, 5, undefined, undefined, other)),
                bm: ids((bm as unknown as { hits: Array<{ id: string }> }).hits),
            };
        } finally { await store.close(); }
    };
    const lance = await mk(new VerbatimStore(createWorkspace('gbis-f-l', {}, home).path, new DetEmbedProvider()));
    const sqlite = await mk(new SqliteVerbatimStore(createWorkspace('gbis-f-s', {}, home).path, new DetEmbedProvider()));
    for (const [k, v] of Object.entries(lance)) assert.ok(!v.includes('secret'), `Lance ${k} must not return a team-x row to a team-y actor (got ${v.join(',')})`);
    assert.deepEqual(lance, sqlite, 'Lance and SQLite agree on what a non-owner sees');
});

await test('D. toPlainStringList: plain arrays, array-likes, Arrow-like vectors, empties', async () => {
    assert.deepEqual(toPlainStringList(['a', 'b']), ['a', 'b']);
    assert.deepEqual(toPlainStringList(null), []);
    assert.deepEqual(toPlainStringList(undefined), []);
    assert.deepEqual(toPlainStringList([]), []);
    assert.deepEqual(toPlainStringList({ length: 2, 0: 'x', 1: 'y' }), ['x', 'y']);
    assert.deepEqual(toPlainStringList({ toArray: () => ['p', 'q'], length: 2 }), ['p', 'q'], 'toArray wins over (broken) indexing');
    assert.deepEqual(toPlainStringList({ length: 2, *[Symbol.iterator]() { yield 'i'; yield 'j'; } }), ['i', 'j'], 'iterable with unindexable elements');
    assert.deepEqual(toPlainStringList({ foo: 1 }), []);
    assert.deepEqual(toPlainStringList([1, 2]), ['1', '2'], 'coerces members to strings');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

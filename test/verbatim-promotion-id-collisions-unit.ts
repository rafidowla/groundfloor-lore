#!/usr/bin/env tsx
/**
 * verbatim-promotion-id-collisions-unit.ts - 3.35.3 review findings F2, F3 and F6.
 *
 *   F2  Two history snapshots of one entity that share a `superseded_at` millisecond map to the SAME Lance
 *       id (`<id>#rev<ts>`). A natively-Lance store keeps both rows; the promoted table must be row-for-row
 *       equal, and verification must pass (the first cut deduped them and aborted on a row-count mismatch).
 *   F3  `split_part(id, '#rev', 1)` conflated `foo` with `foo#revbar`. The resync of one must never touch
 *       the other, and ids full of quotes / LIKE wildcards / injection strings must be deleted exactly.
 *   F6  stagedEntitiesMatch: the gate's content check on the touched rows catches a rewritten row that a
 *       row-count comparison cannot see.
 *
 * Run: npx tsx test/verbatim-promotion-id-collisions-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as lancedb from '@lancedb/lancedb';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { promoteWorkspace } from '../packages/lore/src/engines/verbatimPromotion.js';
import { installChangesLogTriggers, verbatimSqlitePath, stagingDirPath, lancedbDirPath } from '../packages/lore/src/engines/verbatimPromotionState.js';
import { ensureChangesLogTable } from '../packages/lore/src/engines/sqliteVerbatimSchema.js';
import { streamStage, copyTail, toLanceRow, type SourceRow } from '../packages/lore/src/engines/verbatimPromotionStage.js';
import { exactEntityIds, candidateFilters, deleteEntityRows, readEntityRows } from '../packages/lore/src/engines/verbatimPromotionEntityRows.js';
import { stagedEntitiesMatch } from '../packages/lore/src/engines/verbatimPromotionVerify.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 16;
class Det implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'id-collisions-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(DIM).fill(0);
        for (let i = 0; i < text.length; i++) v[i % DIM] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string) { return this.vec(t); }
    async embedQuery(t: string) { return this.vec(t); }
    async embedDocument(t: string) { return this.vec(t); }
}
const provider = new Det();
const dirs: string[] = [];
const tmpWorkspace = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-idc-')); dirs.push(d); return d; };
const SEL = `rowid, id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt,
             security_scopes, is_canonical, is_tombstone, superseded_at, created_at`;

async function openLive(ws: string): Promise<SqliteVerbatimStore> {
    const s = new SqliteVerbatimStore(ws, provider);
    await s.initialize();
    return s;
}
/** Lance ids of SQLite's rows, with multiplicity, sorted. */
function expectedIds(db: Database.Database): string[] {
    return (db.prepare(`SELECT ${SEL} FROM verbatim`).all() as SourceRow[]).map((r) => toLanceRow(r, DIM).id).sort();
}
async function lanceIds(dir: string): Promise<string[]> {
    const t = await (await lancedb.connect(dir)).openTable('lore_verbatim');
    return ((await t.query().select(['id']).toArray()) as Array<{ id: string }>).map((r) => r.id).sort();
}
function prepareRaw(ws: string): Database.Database {
    const raw = new Database(verbatimSqlitePath(ws));
    raw.pragma('busy_timeout = 5000');
    ensureChangesLogTable(raw);
    installChangesLogTriggers(raw);
    return raw;
}

console.log('F3: entity row selection is exact');

await test('exactEntityIds: foo does not claim foo#revbar; an odd entity claims only its own history', async () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const ids = ['foo', `foo#rev${ts}`, 'foo#revbar', `foo#revbar#rev${ts}`, 'fo', 'foo2'];
    assert.deepEqual(exactEntityIds(new Set(['foo']), ids).sort(), ['foo', `foo#rev${ts}`].sort());
    assert.deepEqual(exactEntityIds(new Set(['foo#revbar']), ids).sort(), ['foo#revbar', `foo#revbar#rev${ts}`].sort());
    assert.deepEqual(exactEntityIds(new Set(['nope']), ids), []);
});

await test('candidateFilters: quotes, backslashes, LIKE wildcards and injection strings stay inside string literals', async () => {
    const nasty = ["a'b", "a\\'b", "x') OR ('1'='1", '100%_like', 'sp ace', 'unié\u{1F600}', "q'#rev'x", 'back\\#revslash'];
    const filters = candidateFilters(nasty);
    assert.ok(filters.length >= 1);
    for (const f of filters) {
        // every single quote that is not the opening/closing one of a literal must be doubled
        const stripped = f.replace(/'(?:[^']|'')*'/g, "''");
        assert.ok(!/'/.test(stripped.replace(/''/g, '')), `unbalanced quotes in: ${f}`);
    }
});

await test('deleteEntityRows on a real table removes foo + its history and keeps foo#revbar, fo, foo2, and odd ids', async () => {
    const ws = tmpWorkspace();
    const s = await openLive(ws);
    const ids = ['foo', 'foo#revbar', 'fo', 'foo2', "a'b", '100%_like', "x') OR ('1'='1"];
    for (const id of ids) await s.store({ id, text: `first ${id}`, metadata: {} });
    for (const id of ids) await s.store({ id, text: `second ${id}`, metadata: {} }); // history rows
    await s.close();
    const raw = new Database(verbatimSqlitePath(ws));
    const staging = stagingDirPath(ws);
    await streamStage(raw, staging, DIM);
    const table = await (await lancedb.connect(staging)).openTable('lore_verbatim');
    assert.equal((await lanceIds(staging)).length, 14);
    await deleteEntityRows(table, ['foo']);
    let left = await lanceIds(staging);
    assert.equal(left.filter((i) => i === 'foo' || i.startsWith('foo#rev2')).length, 0, 'foo and its history are gone');
    assert.ok(left.includes('foo#revbar'), 'foo#revbar canonical survived');
    assert.equal(left.filter((i) => i.startsWith('foo#revbar#rev')).length, 1, 'foo#revbar history survived');
    assert.ok(left.includes('fo') && left.includes('foo2'));
    await deleteEntityRows(table, ["a'b", '100%_like', "x') OR ('1'='1"]);
    left = await lanceIds(staging);
    assert.equal(left.filter((i) => i.startsWith("a'b") || i.startsWith('100%_like') || i.startsWith("x')")).length, 0, 'odd ids deleted exactly');
    assert.equal(left.length, 14 - 2 - 6, 'nothing else was touched');
    assert.equal((await readEntityRows(table, ['foo#revbar'])).length, 2, 'readEntityRows is exact too');
    raw.close();
});

await test('copyTail: foo and foo#revbar coexist through overwrite and delete of either', async () => {
    const ws = tmpWorkspace();
    const s0 = await openLive(ws);
    for (const id of ['foo', 'foo#revbar', 'other']) await s0.store({ id, text: `seed ${id}`, metadata: {} });
    await s0.close();
    const raw = prepareRaw(ws);
    const staging = stagingDirPath(ws);
    const { highWaterRowid } = await streamStage(raw, staging, DIM);
    const live = await openLive(ws);
    try {
        await live.store({ id: 'foo', text: 'foo rewritten', metadata: {} });
        await live.store({ id: 'foo#revbar', text: 'foo#revbar rewritten', metadata: {} });
        await live.physicalDelete('foo');
        await live.store({ id: 'foo', text: 'foo recreated', metadata: {} });
        await copyTail(raw, staging, DIM, highWaterRowid);
        assert.deepEqual(await lanceIds(staging), expectedIds(raw), 'Lance == SQLite after delete/overwrite of foo');
        await live.physicalDelete('foo#revbar');
        await copyTail(raw, staging, DIM, highWaterRowid, { fromSeq: 0 });
        const got = await lanceIds(staging);
        assert.deepEqual(got, expectedIds(raw), 'Lance == SQLite after delete of foo#revbar');
        assert.ok(got.includes('foo'), 'foo kept');
    } finally { await live.close(); raw.close(); }
});

console.log('F2: same-millisecond history rows');

function collideHistory(ws: string): number {
    const raw = new Database(verbatimSqlitePath(ws));
    raw.prepare(`UPDATE verbatim SET superseded_at = '2026-01-01T00:00:00.000Z' WHERE id = 'x' AND is_canonical = 0`).run();
    const n = (raw.prepare(`SELECT count(*) c FROM verbatim WHERE id = 'x'`).get() as { c: number }).c;
    raw.close();
    return n;
}
async function seedCollisions(ws: string): Promise<number> {
    const s = await openLive(ws);
    for (let i = 0; i < 30; i++) await s.store({ id: `d${i}`, text: `document ${i} alpha beta`, metadata: {} });
    for (let i = 0; i < 4; i++) await s.store({ id: 'x', text: `x version ${i}`, metadata: {} });
    await s.close();
    return collideHistory(ws);
}

await test('copyTail keeps same-ms history rows 1:1 with SQLite', async () => {
    const ws = tmpWorkspace();
    const xRows = await seedCollisions(ws);
    assert.equal(xRows, 4, 'x: 1 canonical + 3 history');
    const raw = prepareRaw(ws);
    const staging = stagingDirPath(ws);
    const { highWaterRowid } = await streamStage(raw, staging, DIM);
    const live = await openLive(ws);
    try {
        await live.store({ id: 'x', text: 'x touched during staging', metadata: {} });
        await copyTail(raw, staging, DIM, highWaterRowid);
        const want = expectedIds(raw);
        const got = await lanceIds(staging);
        assert.deepEqual(got, want, 'Lance rows == SQLite rows (multiset), no revision dropped');
        assert.equal(got.filter((i) => i === 'x#rev2026-01-01T00:00:00.000Z').length, 3, 'the three colliding history rows are all kept');
    } finally { await live.close(); raw.close(); }
});

await test('promoteWorkspace commits a workspace with same-ms history, with and without a concurrent touch', async () => {
    for (const touch of [false, true]) {
        const ws = tmpWorkspace();
        await seedCollisions(ws);
        const before = new Database(verbatimSqlitePath(ws), { readonly: true });
        let want = expectedIds(before);
        before.close();
        let live: SqliteVerbatimStore | null = null;
        let writer: Promise<void> = Promise.resolve();
        if (touch) {
            live = await openLive(ws);
            writer = (async () => { await new Promise((r) => setTimeout(r, 1)); await live!.store({ id: 'x', text: 'x touched during staging', metadata: {} }); })();
        }
        const r = await promoteWorkspace(ws, DIM);
        await writer;
        assert.equal(r.committed, true, `touch=${touch}: ${r.verify.reasons.join(' | ')}`);
        // The live store still holds the renamed-away file (and its WAL) open, so read the final SQLite state
        // through it; the standalone backup file alone can miss WAL pages that were never checkpointed.
        assert.ok(r.sqliteBackupPath && fs.existsSync(r.sqliteBackupPath), 'backup exists');
        if (live) {
            want = expectedIds((live as unknown as { db: Database.Database }).db);
            await live.close();
        } else {
            const bk = new Database(r.sqliteBackupPath!, { readonly: true });
            want = expectedIds(bk);
            bk.close();
        }
        assert.deepEqual(await lanceIds(lancedbDirPath(ws)), want, `touch=${touch}: promoted table equals SQLite row-for-row`);
    }
});

console.log('F6: content check on the touched rows');

await test('stagedEntitiesMatch passes on equal content and fails on a rewritten row with the same row count', async () => {
    const ws = tmpWorkspace();
    const s = await openLive(ws);
    for (let i = 0; i < 6; i++) await s.store({ id: `d${i}`, text: `doc ${i}`, metadata: {} });
    await s.close();
    const raw = new Database(verbatimSqlitePath(ws));
    const staging = stagingDirPath(ws);
    await streamStage(raw, staging, DIM);
    assert.equal((await stagedEntitiesMatch(raw, staging, ['d1', 'd2'])).ok, true);
    assert.equal((await stagedEntitiesMatch(raw, staging, [])).ok, true);
    // rewrite d1 in SQLite only (same row count; the staged copy is now stale)
    raw.prepare(`UPDATE verbatim SET content_hash = 'tampered', text = 'different' WHERE id = 'd1'`).run();
    const bad = await stagedEntitiesMatch(raw, staging, ['d1', 'd2']);
    assert.equal(bad.ok, false, 'rewritten row detected');
    assert.ok(bad.detail.length > 0);
    assert.equal((await stagedEntitiesMatch(raw, staging, ['d2'])).ok, true, 'untouched entities still match');
    // a row missing from the staged table
    const t = await (await lancedb.connect(staging)).openTable('lore_verbatim');
    await t.delete(`id = 'd3'`);
    assert.equal((await stagedEntitiesMatch(raw, staging, ['d3'])).ok, false, 'missing row detected');
    raw.close();
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

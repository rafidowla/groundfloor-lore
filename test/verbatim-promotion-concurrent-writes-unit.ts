#!/usr/bin/env tsx
/**
 * verbatim-promotion-concurrent-writes-unit.ts - 3.35.3 (SQLITE-STALL fix item 1 + item C).
 *
 * The 2026-10-19 stall: promotion held `BEGIN EXCLUSIVE` on verbatim.sqlite across `await copyTail`, so
 * every other writer got SQLITE_BUSY for the whole copy. This pins the fixed behaviour against a REAL
 * SqliteVerbatimStore with a REAL second connection writing while the copy runs:
 *
 *   - copyTail resync semantics: overwrite (history demotion of a row BELOW the high-water rowid), new
 *     ids, physicalDelete (canonical + history), tombstone, delete-then-recreate: the staged Lance table
 *     equals SQLite row-for-row (no lost rows, no duplicates, history ids `<id>#rev<ts>`).
 *   - no SQLite transaction is ever open at an await boundary inside copyTail, and a concurrent writer
 *     never sees SQLITE_BUSY while a large backlog is applied.
 *   - promoteWorkspace with a live writer (stores, overwrites, deletes, tombstones) running for the whole
 *     promotion: commits, the writer is never blocked for long, and the promoted Lance table equals the
 *     writer's final SQLite state exactly.
 *   - item C: a workspace whose rows share a text prefix no longer aborts (and re-triggers) on the bm25
 *     sample probe.
 *
 * Run: npx tsx test/verbatim-promotion-concurrent-writes-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as lancedb from '@lancedb/lancedb';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { promoteWorkspace } from '../packages/lore/src/engines/verbatimPromotion.js';
import { installChangesLogTriggers, verbatimSqlitePath, stagingDirPath, readPromotionState } from '../packages/lore/src/engines/verbatimPromotionState.js';
import { ensureChangesLogTable } from '../packages/lore/src/engines/sqliteVerbatimSchema.js';
import { streamStage, copyTail, toLanceRow, type SourceRow } from '../packages/lore/src/engines/verbatimPromotionStage.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 16;
class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'promotion-concurrent-det'; readonly dtype = 'fp32';
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
const provider = new DetEmbedProvider();

const dirs: string[] = [];
const tmpWorkspace = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-concurrent-')); dirs.push(d); return d; };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const dbOf = (s: SqliteVerbatimStore): Database.Database => (s as unknown as { db: Database.Database }).db;
const SEL = `rowid, id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt,
             security_scopes, is_canonical, is_tombstone, superseded_at, created_at`;

async function openLive(ws: string): Promise<SqliteVerbatimStore> {
    const s = new SqliteVerbatimStore(ws, provider);
    await s.initialize();
    return s;
}
async function seed(ws: string, n: number, textOf: (i: number) => string): Promise<void> {
    const s = await openLive(ws);
    for (let i = 0; i < n; i++) await s.store({ id: `doc${i}`, text: textOf(i), metadata: {} });
    await s.close();
}

/** SQLite's rows mapped exactly as promotion maps them, grouped by Lance id. Two history snapshots that
 *  share a superseded_at millisecond share a Lance id; a natively-Lance store keeps both rows (plain
 *  `table.add`), so the promoted table must too (3.35.3 F2) - the expectation is a multiset, not a map. */
function expectedLanceRows(db: Database.Database): Map<string, Array<ReturnType<typeof toLanceRow>>> {
    const m = new Map<string, Array<ReturnType<typeof toLanceRow>>>();
    for (const raw of db.prepare(`SELECT ${SEL} FROM verbatim ORDER BY rowid`).all() as SourceRow[]) {
        const lr = toLanceRow(raw, DIM);
        const list = m.get(lr.id);
        if (list) list.push(lr); else m.set(lr.id, [lr]);
    }
    return m;
}
async function assertLanceEquals(db: Database.Database, lanceDir: string, label: string): Promise<number> {
    const table = await (await lancedb.connect(lanceDir)).openTable('lore_verbatim');
    const got = (await table.query().toArray()) as Array<{ id: string; text: string; contentHash: string; vector: ArrayLike<number> }>;
    const want = expectedLanceRows(db);
    const seen = new Map<string, number>();
    for (const r of got) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
    const missing = [...want.keys()].filter((k) => !seen.has(k));
    const extra = [...seen.keys()].filter((k) => !want.has(k));
    assert.deepEqual({ missing: missing.slice(0, 5), extra: extra.slice(0, 5) }, { missing: [], extra: [] }, `${label}: row-set differs (missing ${missing.length}, extra ${extra.length})`);
    for (const [id, rows] of want) assert.equal(seen.get(id), rows.length, `${label}: row count of ${id}`);
    const total = [...want.values()].reduce((n, l) => n + l.length, 0);
    assert.equal(got.length, total, `${label}: row count`);
    for (const r of got) {
        const w = want.get(r.id)!.find((x) => x.text === r.text && x.contentHash === r.contentHash);
        assert.ok(w, `${label}: no SQLite row with the text and contentHash of Lance row ${r.id}`);
        assert.ok(Math.abs(Number(Array.from(r.vector)[0]) - w.vector[0]!) < 1e-5, `${label}: vector of ${r.id}`);
    }
    return got.length;
}

console.log('copyTail: resync-by-entity semantics');

await test('overwrite below the high-water rowid, deletes, tombstones and recreate converge: Lance == SQLite row-for-row', async () => {
    const ws = tmpWorkspace();
    await seed(ws, 40, (i) => `document number ${i} covers subject area ${i % 7}`);
    const raw = new Database(verbatimSqlitePath(ws));
    raw.pragma('busy_timeout = 5000');
    ensureChangesLogTable(raw);
    installChangesLogTriggers(raw);
    const staging = stagingDirPath(ws);
    const { highWaterRowid } = await streamStage(raw, staging, DIM);
    const live = await openLive(ws);
    try {
        // rows with rowid <= high-water: demotion to history + new canonical row
        await live.store({ id: 'doc3', text: 'doc3 rewritten once', metadata: {} });
        await live.store({ id: 'doc3', text: 'doc3 rewritten twice', metadata: {} });
        await live.store({ id: 'doc7', text: 'doc7 rewritten', metadata: {} });
        await live.physicalDelete('doc10');                      // streamed canonical row removed
        await live.tombstone('doc12', 'test tombstone');
        await live.physicalDelete('doc3');                       // canonical + both history rows removed...
        await live.store({ id: 'doc3', text: 'doc3 recreated', metadata: {} }); // ...then recreated
        await live.store({ id: 'doc10', text: 'doc10 recreated after delete', metadata: {} });
        for (let i = 0; i < 10; i++) await live.store({ id: `late${i}`, text: `late arrival ${i}`, metadata: {} });
        await live.store({ id: 'late4', text: 'late4 overwritten', metadata: {} });
        const maxSeq = (raw.prepare('SELECT MAX(seq) m FROM verbatim_changes_log').get() as { m: number }).m;
        const r = await copyTail(raw, staging, DIM, highWaterRowid);
        assert.ok(r.tailRowsApplied >= 1);
        assert.equal(r.lastSeq, maxSeq, 'cursor ends at the last logged change');
        const n = await assertLanceEquals(raw, staging, 'after copyTail');
        assert.ok(n > 40, 'history + new rows are staged');
        const again = await copyTail(raw, staging, DIM, highWaterRowid, { fromSeq: r.lastSeq });
        assert.equal(again.tailRowsApplied, 0, 'resuming from lastSeq applies nothing');
        assert.equal(again.lastSeq, r.lastSeq);
        await assertLanceEquals(raw, staging, 'after idempotent resume');
    } finally { await live.close(); raw.close(); }
});

await test('copyTail in two toSeq slices equals one pass', async () => {
    const ws = tmpWorkspace();
    await seed(ws, 20, (i) => `slice doc ${i}`);
    const raw = new Database(verbatimSqlitePath(ws));
    ensureChangesLogTable(raw);
    installChangesLogTriggers(raw);
    const staging = stagingDirPath(ws);
    const { highWaterRowid } = await streamStage(raw, staging, DIM);
    const live = await openLive(ws);
    try {
        for (let i = 0; i < 6; i++) await live.store({ id: `doc${i}`, text: `first pass ${i}`, metadata: {} });
        const mid = (raw.prepare('SELECT MAX(seq) m FROM verbatim_changes_log').get() as { m: number }).m;
        for (let i = 3; i < 9; i++) await live.store({ id: `doc${i}`, text: `second pass ${i}`, metadata: {} });
        raw.exec('BEGIN'); // the final catch-up shape: copyTail reads inside the caller's snapshot
        const a = await copyTail(raw, staging, DIM, highWaterRowid, { toSeq: mid });
        raw.exec('COMMIT');
        assert.equal(a.lastSeq, mid);
        const b = await copyTail(raw, staging, DIM, highWaterRowid, { fromSeq: a.lastSeq });
        assert.ok(b.tailRowsApplied > 0);
        await assertLanceEquals(raw, staging, 'two slices');
    } finally { await live.close(); raw.close(); }
});

console.log('\ncopyTail: no lock held across an await');

await test('large backlog: no open SQLite transaction at any await boundary, and a concurrent writer never sees SQLITE_BUSY', async () => {
    const ws = tmpWorkspace();
    await seed(ws, 1500, (i) => `backlog document ${i} body text`);
    const raw = new Database(verbatimSqlitePath(ws));
    ensureChangesLogTable(raw);
    installChangesLogTriggers(raw);
    const staging = stagingDirPath(ws);
    const { highWaterRowid } = await streamStage(raw, staging, DIM);
    const live = await openLive(ws);
    try {
        for (let i = 0; i < 1500; i++) await live.store({ id: `doc${i}`, text: `backlog document ${i} rewritten`, metadata: {} });
        let ticks = 0, inTxn = 0;
        const monitor = setInterval(() => { ticks++; if (raw.inTransaction) inTxn++; }, 0);
        let writes = 0, busy = 0, other: unknown = null, stop = false;
        const writer = (async () => {
            for (let i = 0; !stop; i++) {
                try { await live.store({ id: `during${i}`, text: `written during the copy ${i}`, metadata: {} }); writes++; }
                catch (err) { if (/locked|SQLITE_BUSY/i.test((err as Error).message)) busy++; else other = err; }
                await tick();
            }
        })();
        const r = await copyTail(raw, staging, DIM, highWaterRowid);
        stop = true; await writer; clearInterval(monitor);
        assert.equal(other, null);
        assert.ok(r.tailRowsApplied >= 3000, `applied the backlog (${r.tailRowsApplied})`);
        assert.ok(ticks >= 5, `the event loop turned during the copy (${ticks} ticks)`);
        assert.equal(inTxn, 0, 'copyTail must never leave a transaction open across an await');
        assert.equal(busy, 0, 'a concurrent writer must never be blocked');
        assert.ok(writes >= 5, `the writer made progress during the copy (${writes} writes)`);
        await copyTail(raw, staging, DIM, highWaterRowid, { fromSeq: r.lastSeq }); // quiesced straggler drain
        await assertLanceEquals(raw, staging, 'after backlog');
    } finally { await live.close(); raw.close(); }
});

console.log('\npromoteWorkspace with a live writer');

await test('writer is never blocked for long, promotion commits, and Lance equals the writer\'s final SQLite state exactly', async () => {
    const ws = tmpWorkspace();
    const SEEDED = 2500;
    await seed(ws, SEEDED, (i) => `document number ${i} covers subject area ${i % 7}`);
    const live = await openLive(ws);
    let writes = 0, errors = 0, retired = 0, maxMs = 0, firstError = '';
    let stop = false;
    const writer = (async () => {
        for (let i = 0; !stop; i++) {
            const t0 = Date.now();
            try {
                await live.store({ id: `live${i}`, text: `live write ${i} while promoting`, metadata: {} });
                if (i % 3 === 0) await live.store({ id: `doc${(i * 7) % SEEDED}`, text: `overwritten ${i}`, metadata: {} });
                if (i % 11 === 5) await live.physicalDelete(`doc${(i * 13 + 5) % SEEDED}`);
                if (i % 17 === 9) await live.tombstone(`doc${(i * 19 + 3) % SEEDED}`, 'live tombstone');
                writes++;
            } catch (err) {
                // A write parked behind the promotion's write barrier when it COMMITTED is rejected with
                // VerbatimStoreRetiredError and NOT applied (it would otherwise land on the retired file
                // and be lost). That is the correct outcome, not a failure; the caller retries.
                if ((err as Error).name === 'VerbatimStoreRetiredError') retired++;
                else { errors++; firstError ||= (err as Error).message; }
            }
            maxMs = Math.max(maxMs, Date.now() - t0);
            await new Promise((r) => setTimeout(r, 15)); // a busy-but-realistic writer, not a tight loop
        }
    })();
    const result = await promoteWorkspace(ws, DIM).finally(() => { stop = true; });
    await writer;
    try {
        assert.equal(errors, 0, `writer errors: ${firstError}`);
        assert.ok(writes >= 20, `the writer ran during the promotion (${writes} write rounds)`);
        assert.ok(maxMs < 2000, `no write was blocked for the copy (max ${maxMs} ms; the stall blocked them for the full busy_timeout and beyond)`);
        assert.equal(result.committed, true, result.verify.reasons.join(' | '));
        assert.ok(result.tailRowsApplied > 0, 'writes landed in the tail');
        assert.equal(readPromotionState(ws), null, 'promotion.json cleared');
        const hasLog = dbOf(live).prepare(`SELECT 1 FROM sqlite_master WHERE name = 'verbatim_changes_log'`).get();
        assert.equal(hasLog, undefined, 'changes-log dropped at commit');
        // The writer's own connection IS the final SQLite state (the renamed file's WAL is not visible by path).
        const n = await assertLanceEquals(dbOf(live), result.newLanceDbPath!, 'promoted table');
        assert.ok(n > SEEDED, `promoted table includes live writes + history (${n})`);
    } finally { await live.close(); }
});

console.log('\nitem C: promotion verification');

await test('rows sharing a text prefix commit (the bm25 probe is not discriminating, the FTS index is healthy)', async () => {
    const ws = tmpWorkspace();
    await seed(ws, 400, (i) => `repro load node ${i} body alpha beta gamma delta`);
    const r = await promoteWorkspace(ws, DIM);
    assert.equal(r.committed, true, r.verify.reasons.join(' | '));
    assert.equal(r.verify.sampleFailures, 0);
    assert.ok(r.verify.sampledRows > 0);
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

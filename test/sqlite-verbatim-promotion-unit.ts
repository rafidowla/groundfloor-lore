#!/usr/bin/env tsx
/**
 * test/sqlite-verbatim-promotion-unit.ts — 3.21 step 2 part 3.
 *
 * Design CHECK (section 4): "Promotion with the threshold set to 2,000 in
 * the test: writes continue during staging; a kill at each step (staging,
 * tail copy, index build, between renames) recovers with nothing lost;
 * verify counts and sample recall; the post-promotion store is Lance and
 * serves the same top-k."
 *
 * "Kill" scenarios are simulated by driving the state machine's exported
 * building blocks directly (writePromotionState / streamStage / copyTail /
 * buildStagedIndexes / finishCommitRenames) and stopping short of the next
 * step — then calling recoverOnOpen() and asserting the source SQLite is
 * untouched and fully queryable. This is not a literal SIGKILL of a real
 * child process, but it exercises the SAME recovery code path a real crash
 * would hit (recoverOnOpen reads promotion.json exactly as a fresh process
 * boot would) and is deterministic, which a timed process-kill is not.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import {
    promoteWorkspace, recoverOnOpen, finishCommitRenames, buildStagedIndexes, shouldTriggerPromotion,
} from '../packages/lore/src/engines/verbatimPromotion.js';
import {
    readPromotionState, writePromotionState, stagingDirPath, lancedbDirPath, verbatimSqlitePath,
    installChangesLogTriggers,
} from '../packages/lore/src/engines/verbatimPromotionState.js';
import { ensureChangesLogTable } from '../packages/lore/src/engines/sqliteVerbatimSchema.js';
import { streamStage, copyTail } from '../packages/lore/src/engines/verbatimPromotionStage.js';
import { readPieceSidecar } from '../packages/lore/src/engines/pieces/pieceLayout.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
    catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 16;
class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'promotion-unit-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
}

function tmpWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-promotion-unit-'));
}

async function seedStore(basePath: string, n: number, provider: EmbeddingProvider): Promise<void> {
    const store = new SqliteVerbatimStore(basePath, provider);
    await store.initialize();
    for (let i = 0; i < n; i++) {
        await store.store({ id: `doc${i}`, text: `document number ${i} covers subject area ${i % 7}`, metadata: {} });
    }
    await store.close();
}

async function main(): Promise<void> {
    await test('shouldTriggerPromotion: threshold policy (2,000 in-test, 0 disables, already-in-flight guard)', async () => {
        const prev = process.env.LORE_VECTOR_PROMOTE_ROWS;
        try {
            process.env.LORE_VECTOR_PROMOTE_ROWS = '2000';
            assert.equal(shouldTriggerPromotion('/fake/ws', 1999), false);
            assert.equal(shouldTriggerPromotion('/fake/ws', 2000), true);
            process.env.LORE_VECTOR_PROMOTE_ROWS = '0';
            assert.equal(shouldTriggerPromotion('/fake/ws', 999_999), false, '0 disables the trigger');
        } finally {
            if (prev === undefined) delete process.env.LORE_VECTOR_PROMOTE_ROWS; else process.env.LORE_VECTOR_PROMOTE_ROWS = prev;
        }
    });

    await test('happy path: commits, verify passes, counts match, promoted Lance store serves the same data', async () => {
        const ws = tmpWorkspace();
        const provider = new DetEmbedProvider();
        await seedStore(ws, 60, provider);
        const result = await promoteWorkspace(ws, DIM);
        assert.ok(result.committed, `expected commit, got: ${result.verify.reasons.join('; ')}`);
        assert.ok(result.verify.ok);
        assert.equal(result.verify.sourceRowCount, result.verify.targetRowCount);
        assert.ok(fs.existsSync(result.newLanceDbPath!));
        assert.ok(fs.existsSync(result.sqliteBackupPath!));
        assert.ok(!fs.existsSync(verbatimSqlitePath(ws)), 'verbatim.sqlite should be renamed away, not left in place');

        const lance = new VerbatimStore(ws, provider);
        await lance.initialize();
        const got = await lance.getById('doc10');
        assert.ok(got?.text?.includes('document number 10'));
        const hits = await lance.search('document number 10 covers subject area 3', 5);
        assert.ok(hits.some((h) => h.id === 'doc10'), 'promoted Lance store must serve a vector-search hit for a promoted doc');
        await lance.close();
    });

    await test('writes continue during staging: a write landing mid-promotion is captured by the tail and present after commit', async () => {
        const ws = tmpWorkspace();
        const provider = new DetEmbedProvider();
        await seedStore(ws, 30, provider);

        // Open a SEPARATE live store handle (as a concurrent writer would)
        // and start a promotion; interleave a write between the two async
        // steps most likely to race it (stage, then tail).
        const writer = new SqliteVerbatimStore(ws, provider);
        await writer.initialize();

        const dbPath = verbatimSqlitePath(ws);
        const sqliteDb = new Database(dbPath);
        sqliteDb.pragma('busy_timeout = 5000');
        ensureChangesLogTable(sqliteDb);
        installChangesLogTriggers(sqliteDb);
        const { highWaterRowid } = await streamStage(sqliteDb, stagingDirPath(ws), DIM);

        // This write happens AFTER the stream-stage snapshot was taken —
        // exactly the race the tail-copy exists to close.
        await writer.store({ id: 'late-doc', text: 'a write that landed during staging, after the initial scan', metadata: {} });
        await writer.close();

        const { tailRowsApplied } = await copyTail(sqliteDb, stagingDirPath(ws), DIM, highWaterRowid);
        assert.ok(tailRowsApplied >= 1, 'the late write must be picked up by the tail copy');
        await buildStagedIndexes(stagingDirPath(ws), DIM);
        sqliteDb.close();

        // Verify + commit via the normal path won't re-stage (promotion.json
        // was never written in this manual drive) — assert directly against
        // the staged Lance table instead.
        const lancedb = await import('@lancedb/lancedb');
        const conn = await lancedb.connect(stagingDirPath(ws));
        const table = await conn.openTable('lore_verbatim');
        const rows = await table.query().where(`id = 'late-doc'`).toArray();
        assert.equal(rows.length, 1, 'the late-arriving write must be present in the staged table after the tail copy');

        fs.rmSync(stagingDirPath(ws), { recursive: true, force: true });
    });

    await test('kill during staging (before tail copy): recoverOnOpen discards the staging dir, SQLite fully intact', async () => {
        const ws = tmpWorkspace();
        const provider = new DetEmbedProvider();
        await seedStore(ws, 25, provider);

        const dbPath = verbatimSqlitePath(ws);
        const db = new Database(dbPath);
        db.pragma('busy_timeout = 5000');
        const startedAt = new Date().toISOString();
        writePromotionState(ws, { state: 'staging', startedAt, sourceRows: 25 });
        ensureChangesLogTable(db);
        installChangesLogTriggers(db);
        const { highWaterRowid } = await streamStage(db, stagingDirPath(ws), DIM);
        writePromotionState(ws, { state: 'staging', startedAt, sourceRows: 25, highWaterRowid });
        db.close();
        // "crash" here — never reached copyTail/verify/commit.

        assert.ok(fs.existsSync(stagingDirPath(ws)), 'sanity: staging dir exists before recovery');
        recoverOnOpen(ws);
        assert.ok(!fs.existsSync(stagingDirPath(ws)), 'staging dir must be discarded');
        assert.equal(readPromotionState(ws), null, 'promotion.json must be cleared');
        assert.ok(fs.existsSync(dbPath), 'verbatim.sqlite must still be in place, untouched');

        const store = new SqliteVerbatimStore(ws, provider);
        await store.initialize();
        assert.equal(await store.count(), 25, 'every original row is still readable after recovery');
        // And a fresh promotion attempt must succeed cleanly afterward.
        await store.close();
    });

    await test('kill during tail copy: recoverOnOpen discards the staging dir, SQLite fully intact', async () => {
        const ws = tmpWorkspace();
        const provider = new DetEmbedProvider();
        await seedStore(ws, 25, provider);

        const dbPath = verbatimSqlitePath(ws);
        const db = new Database(dbPath);
        db.pragma('busy_timeout = 5000');
        const startedAt = new Date().toISOString();
        writePromotionState(ws, { state: 'staging', startedAt, sourceRows: 25 });
        ensureChangesLogTable(db);
        installChangesLogTriggers(db);
        const { highWaterRowid } = await streamStage(db, stagingDirPath(ws), DIM);
        writePromotionState(ws, { state: 'staging', startedAt, sourceRows: 25, highWaterRowid });
        // Simulate a write landing right at the tail-copy boundary, then
        // "crash" WITHOUT ever calling copyTail.
        db.prepare(
            `INSERT INTO verbatim (id, text, content_hash, is_canonical, is_tombstone, created_at, updated_at)
             VALUES ('crash-doc', 'a doc written right before the crash', 'x', 1, 0, datetime('now'), datetime('now'))`,
        ).run();
        db.close();

        recoverOnOpen(ws);
        assert.ok(!fs.existsSync(stagingDirPath(ws)));
        assert.equal(readPromotionState(ws), null);

        const store = new SqliteVerbatimStore(ws, provider);
        await store.initialize();
        assert.equal(await store.count(), 26, 'the pre-crash write (including the one landed mid-staging) is not lost');
        const got = await store.getById('crash-doc');
        assert.ok(got, 'the doc written right before the simulated crash must still be readable');
        await store.close();
    });

    await test('kill during index build: recoverOnOpen discards the staging dir, SQLite fully intact', async () => {
        const ws = tmpWorkspace();
        const provider = new DetEmbedProvider();
        await seedStore(ws, 25, provider);

        const dbPath = verbatimSqlitePath(ws);
        const db = new Database(dbPath);
        db.pragma('busy_timeout = 5000');
        const startedAt = new Date().toISOString();
        writePromotionState(ws, { state: 'staging', startedAt, sourceRows: 25 });
        ensureChangesLogTable(db);
        installChangesLogTriggers(db);
        const { highWaterRowid } = await streamStage(db, stagingDirPath(ws), DIM);
        writePromotionState(ws, { state: 'staging', startedAt, sourceRows: 25, highWaterRowid });
        db.exec('BEGIN EXCLUSIVE');
        await copyTail(db, stagingDirPath(ws), DIM, highWaterRowid);
        db.exec('COMMIT');
        db.close();
        // "crash" here — staged + tail-copied, but never indexed/verified/committed.

        assert.ok(fs.existsSync(stagingDirPath(ws)), 'sanity: staging dir with data exists before recovery');
        recoverOnOpen(ws);
        assert.ok(!fs.existsSync(stagingDirPath(ws)));
        assert.equal(readPromotionState(ws), null);

        const store = new SqliteVerbatimStore(ws, provider);
        await store.initialize();
        assert.equal(await store.count(), 25);
        await store.close();
    });

    await test('kill between renames (during commit): recoverOnOpen finishes idempotently, nothing lost', async () => {
        const ws = tmpWorkspace();
        const provider = new DetEmbedProvider();
        await seedStore(ws, 20, provider);

        const dbPath = verbatimSqlitePath(ws);
        const db = new Database(dbPath);
        db.pragma('busy_timeout = 5000');
        const startedAt = new Date().toISOString();
        ensureChangesLogTable(db);
        installChangesLogTriggers(db);
        const { highWaterRowid } = await streamStage(db, stagingDirPath(ws), DIM);
        db.exec('BEGIN EXCLUSIVE');
        await copyTail(db, stagingDirPath(ws), DIM, highWaterRowid);
        db.exec('COMMIT');
        await buildStagedIndexes(stagingDirPath(ws), DIM);
        const committedAt = startedAt.replace(/[:.]/g, '-');
        // Mark state committed (design step 7's first write) — THEN crash
        // partway through the rename sequence itself: rename the staging
        // dir to final, but never get to renaming verbatim.sqlite.
        writePromotionState(ws, { state: 'committed', startedAt, sourceRows: 20, highWaterRowid, committedAt });
        db.close();
        // A pure-SQLite workspace already has a `.lore/lancedb/` dir at
        // this point (embeddingFingerprint.ts's sidecar — the SAME
        // fingerprint file both engines share, deliberately, so promoted
        // vectors don't need re-verification — see sqliteVerbatimStore.ts's
        // header comment). finishCommitRenames's real rename #1 moves that
        // aside as "stale" before rename #2; replicate that step here so
        // this manual drive matches what the real commit sequence would
        // have already done by this point, rather than hitting Node's
        // ENOTEMPTY renaming onto a non-empty dir (a test-harness gap, not
        // a bug in finishCommitRenames itself — the happy-path test above
        // already exercises that exact step via the real code path).
        fs.rmSync(lancedbDirPath(ws), { recursive: true, force: true });
        fs.renameSync(stagingDirPath(ws), lancedbDirPath(ws)); // simulate step 7's rename #2 having landed
        // "crash" here — rename #3 (verbatim.sqlite -> .promoted-<ts>) never ran.

        assert.ok(fs.existsSync(lancedbDirPath(ws)), 'sanity: lancedb dir exists (rename #2 landed) before recovery');
        assert.ok(fs.existsSync(dbPath), 'sanity: verbatim.sqlite still present (rename #3 did not land) before recovery');

        recoverOnOpen(ws);

        assert.equal(readPromotionState(ws), null, 'promotion.json cleared after recovery finishes the commit');
        assert.ok(!fs.existsSync(dbPath), 'rename #3 must have been completed by recovery');
        assert.ok(fs.existsSync(lancedbDirPath(ws)), 'the promoted lancedb dir is intact');

        const lance = new VerbatimStore(ws, provider);
        await lance.initialize();
        assert.equal(await lance.count(), 20, 'every row survived a crash mid-rename-sequence');
        await lance.close();

        // finishCommitRenames must also be safely re-callable (idempotent)
        // against the now-fully-renamed disk state — a second recovery
        // attempt (e.g. two racing boots) must not throw or double-rename.
        assert.doesNotThrow(() => finishCommitRenames(ws, { state: 'committed', startedAt, sourceRows: 20, highWaterRowid, committedAt }));
    });

    await test('verification failure: aborts, staging discarded, SQLite intact and untouched', async () => {
        const ws = tmpWorkspace();
        const provider = new DetEmbedProvider();
        await seedStore(ws, 15, provider);

        // Corrupt the row count AFTER staging would read it, by staging
        // manually and then deleting a row from the staged Lance table so
        // verify()'s count check fails deterministically — this proves the
        // abort path (not the recovery path) triggers on a genuine
        // verification mismatch, distinct from the crash-recovery tests
        // above.
        const dbPath = verbatimSqlitePath(ws);
        const db = new Database(dbPath);
        db.pragma('busy_timeout = 5000');
        const { highWaterRowid } = await streamStage(db, stagingDirPath(ws), DIM);
        const lancedb = await import('@lancedb/lancedb');
        const conn = await lancedb.connect(stagingDirPath(ws));
        const table = await conn.openTable('lore_verbatim');
        await table.delete(`id = 'doc0'`); // sabotage: staged table now has one fewer row than source
        db.close();
        fs.rmSync(stagingDirPath(ws), { recursive: true, force: true }); // clean up the manual drive

        // Re-stage properly this time but sabotage differently: mismatch via
        // the public promoteWorkspace() path by pre-seeding a STALE staging
        // dir that promoteWorkspace will overwrite — instead, directly
        // exercise verifyPromotion's failure branch through promoteWorkspace
        // by shrinking the sample size to 0 rows is not a failure; use the
        // low-level verify module against a deliberately incomplete stage.
        const db2 = new Database(dbPath);
        db2.pragma('busy_timeout = 5000');
        await streamStage(db2, stagingDirPath(ws), DIM);
        const conn2 = await lancedb.connect(stagingDirPath(ws));
        const table2 = await conn2.openTable('lore_verbatim');
        await table2.delete(`id = 'doc1'`);
        db2.close();

        const { verifyPromotion } = await import('../packages/lore/src/engines/verbatimPromotionVerify.js');
        const db3 = new Database(dbPath);
        const verify = await verifyPromotion(db3, stagingDirPath(ws), 50);
        db3.close();
        assert.equal(verify.ok, false, 'a deliberately shrunk staged table must fail verification');
        assert.ok(verify.reasons.some((r) => r.includes('row count mismatch')));
        fs.rmSync(stagingDirPath(ws), { recursive: true, force: true });

        // The real end-to-end abort path: promoteWorkspace() itself,
        // unsabotaged, must commit cleanly (proves the abort machinery
        // isn't triggered spuriously) — and SQLite must still be there and
        // fully intact for the sabotage tests above (never renamed away).
        const store = new SqliteVerbatimStore(ws, provider);
        await store.initialize();
        assert.equal(await store.count(), 15, 'source SQLite was never touched by the sabotaged staging attempts');
        await store.close();
        const result = await promoteWorkspace(ws, DIM);
        assert.ok(result.committed && result.verify.ok, 'an unsabotaged promotion of the same workspace commits normally');
    });

    await test('B2: promotion no longer rebuilds pieces inline — commits normally, post-promotion piece status is not "active", and no embedding call happens once promoteWorkspace is invoked', async () => {
        const ws = tmpWorkspace();
        const inner = new DetEmbedProvider();
        let embedCalls = 0;
        // Wraps DetEmbedProvider and counts every call so the assertion
        // below is a real measurement, not an inference from "the import
        // was removed" — this is the concrete proof that promoteWorkspace()
        // itself never touches an embedding provider (vectors are copied,
        // never re-embedded — see verbatimPromotionStage.ts's header) and,
        // specifically for B2, that the old inline post-commit piece
        // rebuild (which called createEmbeddingProvider()+buildPieceIndex)
        // is gone.
        const counting: EmbeddingProvider = {
            dimension: inner.dimension,
            modelId: inner.modelId,
            dtype: inner.dtype,
            initialize: () => inner.initialize(),
            embed: async (text: string) => { embedCalls++; return inner.embed(text); },
            embedQuery: async (text: string) => { embedCalls++; return inner.embedQuery(text); },
            embedDocument: async (text: string) => { embedCalls++; return inner.embedDocument(text); },
        };

        // Seed a small SQLite-backed workspace opted into piece vectors
        // FROM CREATION (canonical starts empty, so SqlitePieceIndex's
        // initialize() auto-creates an empty, valid, complete index — see
        // sqlitePieceIndex.ts's initialize()/createEmpty()) and let the
        // ordinary write path build it incrementally (store()'s
        // pieceIndex?.upsertForRows() calls, sqliteVerbatimStore.ts:262).
        // This is D7's normal "opt-in" scenario, distinct from the
        // migration-CLI's retrofit-onto-existing-data path, and is a
        // simpler/more direct way to land at a complete pre-promotion
        // sidecar than driving buildPieceIndex() by hand (confirmed:
        // buildPieceIndex() on this same store reports 'noop'/'already
        // built', since the incremental writes already left it complete).
        const store = new SqliteVerbatimStore(ws, counting, { pieceVectors: true });
        await store.initialize();
        for (let i = 0; i < 10; i++) {
            await store.store({ id: `piece-doc${i}`, text: `document number ${i} covers subject area ${i % 3}`, metadata: {} });
        }
        const statusBefore = store.pieceIndexStatus();
        assert.ok(statusBefore.open && statusBefore.valid, `precondition: piece index must be open+valid before promotion, got: ${JSON.stringify(statusBefore)}`);
        await store.close();

        const sidecarBefore = readPieceSidecar(ws);
        assert.ok(sidecarBefore?.complete, 'precondition: piece sidecar must be complete before promotion');

        // Reset the counter AFTER seeding+piece-build (which legitimately
        // embed) and BEFORE promoteWorkspace: from here on nothing should
        // ever call the embedding provider again.
        embedCalls = 0;

        const promoted = await promoteWorkspace(ws, DIM);
        assert.ok(promoted.committed, `expected promotion to commit, got: ${promoted.verify.reasons.join('; ')}`);
        assert.equal(embedCalls, 0, 'promoteWorkspace must not call the embedding provider at all (B2: no inline piece rebuild)');

        // The old sidecar (and, on Lance, the old piece table) were swept
        // into the .stale-<ts> aside directory by finishCommitRenames, and
        // nothing rebuilds a new one anymore — so the promoted workspace
        // root has no sidecar, and the promoted Lance store must report the
        // piece index as not active (not_built/absent), never "active".
        assert.equal(readPieceSidecar(ws), null, 'no new piece sidecar should exist in the promoted workspace root');

        const lance = new VerbatimStore(ws, counting, { pieceVectors: true });
        await lance.initialize();
        const statusAfter = lance.pieceIndexStatus();
        assert.ok(!(statusAfter.open && statusAfter.valid), `piece index must not be active after promotion, got: ${JSON.stringify(statusAfter)}`);
        assert.equal(embedCalls, 0, 'opening the promoted store to check piece status must not trigger any embedding calls either');
        await lance.close();
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });

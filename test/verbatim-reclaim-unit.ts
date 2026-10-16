#!/usr/bin/env tsx
/**
 * verbatim-reclaim-unit.ts — Lore 3.35.0 fix (o): `lore verbatim reclaim`.
 *
 * Engine tests build a SQLite verbatim store the way the OLD (pre-3.35.0) writer left it: every
 * re-store flipped the canonical row to history and inserted a byte-identical new canonical row.
 * Then they assert the run rule (A,A,B,B,A(canonical) -> A(oldest),B(oldest),A(canonical)), that
 * differing neighbours / tombstones / hash-less rows are never deleted, dry-run writes nothing,
 * apply removes exactly the expected rows, FTS stays consistent and side tables are untouched.
 * CLI tests spawn the real `lore verbatim reclaim`: dry run, apply, --vacuum, live-holder refusal,
 * the not_supported message for a LanceDB store, and flag validation.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { scanReclaim, applyReclaim, openReclaimDb, ftsIntegrity } from '../packages/lore/src/engines/verbatimReclaim.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const CLI = path.join(repoRoot, 'packages', 'lore', 'src', 'cli', 'index.ts');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-unit-'));
process.env['LORE_HOME'] = path.join(ROOT, 'home');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).message}`); failed++; }
};

/** Make an embedded workspace with an initialized (empty) SQLite verbatim store; returns its `.lore` dir. */
async function makeStoreDir(label: string): Promise<{ loreDir: string; dbPath: string }> {
    const base = fs.mkdtempSync(path.join(ROOT, `${label}-`));
    const store = new SqliteVerbatimStore(base, undefined);
    await store.initialize();
    await store.close();
    const loreDir = path.join(base, '.lore');
    return { loreDir, dbPath: path.join(loreDir, 'verbatim.sqlite') };
}

interface V { text: string; hash?: string | null; label?: string; tomb?: boolean; vec?: boolean }
/** Append a version the OLD way: demote the canonical row, insert a new canonical row. */
function appendOld(db: Database.Database, id: string, v: V): void {
    db.prepare(`UPDATE verbatim SET is_canonical = 0, superseded_at = ? WHERE id = ? AND is_canonical = 1`).run('2026-01-01T00:00:00Z', id);
    const hash = v.hash === undefined ? `h:${v.text}` : v.hash;
    db.prepare(`INSERT INTO verbatim (id, text, vector, content_hash, type, label, tags, project, ecosystem, updatedAt, security_scopes,
                                      is_canonical, is_tombstone, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'doc', ?, '', 'p', '', ?, '[]', 1, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
        .run(id, v.text, v.vec === false ? null : Buffer.alloc(32, 1), hash, v.label ?? null, `ts-${Math.random()}`, v.tomb ? 1 : 0);
}
const idRows = (db: Database.Database, id: string): Array<{ text: string; canon: number }> =>
    db.prepare(`SELECT text, is_canonical AS canon FROM verbatim WHERE id = ? ORDER BY rowid`).all(id) as never;

function seed(dbPath: string): void {
    const db = new Database(dbPath);
    // X: A,A,B,B,A(canonical)  -> keep A(1st), B(1st), A(canonical)
    for (const t of ['A', 'A', 'B', 'B', 'A']) appendOld(db, 'lore:X', { text: `${t} body alpha` });
    appendOld(db, 'lore:Y', { text: 'C only' });
    // Z: D,D(canonical) -> canonical kept, older identical history dropped
    appendOld(db, 'lore:Z', { text: 'D body' }); appendOld(db, 'lore:Z', { text: 'D body' });
    // T: E, tombstone(E), E(canonical): tombstone breaks the run, nothing deleted
    appendOld(db, 'lore:T', { text: 'E body' }); appendOld(db, 'lore:T', { text: 'E body', tomb: true }); appendOld(db, 'lore:T', { text: 'E body' });
    // W: same text+hash, different label -> real metadata change, both kept
    appendOld(db, 'lore:W', { text: 'F body', label: 'x' }); appendOld(db, 'lore:W', { text: 'F body', label: 'y' });
    // N: rows with no content_hash are never collapsed
    appendOld(db, 'lore:N', { text: 'G body', hash: null }); appendOld(db, 'lore:N', { text: 'G body', hash: null });
    // V: same hash but one row has a vector and one does not -> different, kept
    appendOld(db, 'lore:V', { text: 'H body', vec: false }); appendOld(db, 'lore:V', { text: 'H body', vec: true });
    // pieces side table (keyed by node id) must be untouched
    db.exec(`CREATE TABLE IF NOT EXISTS verbatim_pieces (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, nodeId TEXT NOT NULL, pieceIndex INTEGER NOT NULL, isTitle INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, vector BLOB, type TEXT, project TEXT, ecosystem TEXT, security_scopes TEXT)`);
    db.prepare(`INSERT INTO verbatim_pieces (id, nodeId, pieceIndex, text) VALUES ('lore:X#p0', 'lore:X', 0, 'piece')`).run();
    db.close();
}
const dump = (dbPath: string): string => {
    const db = new Database(dbPath, { readonly: true });
    try { return JSON.stringify(db.prepare('SELECT * FROM verbatim ORDER BY rowid').all()); } finally { db.close(); }
};

function cli(args: string[], env: Record<string, string> = {}): { code: number | null; out: string; err: string } {
    const r = spawnSync(tsxBin, [CLI, 'verbatim', 'reclaim', ...args], {
        encoding: 'utf-8', timeout: 120_000,
        env: { ...process.env, LORE_HOME: process.env['LORE_HOME']!, LORE_PORT: '39877', ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

(async () => {
    console.log('verbatim reclaim (3.35.0)');

    await test('o1 — run rule: A,A,B,B,A(canonical) keeps A(oldest), B(oldest), A(canonical); differing neighbours / tombstones / hash-less rows never deleted', async () => {
        const { dbPath } = await makeStoreDir('o1');
        seed(dbPath);
        const db = openReclaimDb(dbPath, false);
        const plan = scanReclaim(db);
        db.close();
        // X loses 2 (A#2, B#2) and Z loses 1 (D#1) = 3 rows.
        assert.equal(plan.rowsToDelete, 3, `expected 3 deletable rows, got ${plan.rowsToDelete} (${JSON.stringify(plan.sampleIds)})`);
        assert.equal(plan.idsAffected, 2);
        assert.equal(plan.runsCollapsed, 3);
        assert.ok(plan.bytesEstimate > 0);
        assert.deepEqual(plan.sampleIds.map((s) => s.id).sort(), ['lore:X', 'lore:Z']);
    });

    await test('o2 — dry run (engine + CLI) changes nothing on disk', async () => {
        const { loreDir, dbPath } = await makeStoreDir('o2');
        seed(dbPath);
        const before = dump(dbPath);
        const sizeBefore = fs.statSync(dbPath).size;
        const r = cli(['--lore-dir', loreDir]);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /3 duplicate row\(s\) in 3 run\(s\) across 2 id\(s\)/);
        assert.match(r.out, /DRY RUN/);
        assert.equal(dump(dbPath), before, 'rows byte-identical after a dry run');
        assert.equal(fs.statSync(dbPath).size, sizeBefore);
    });

    await test('o3 — apply removes exactly the expected rows; FTS consistent; pieces and canonical rows untouched', async () => {
        const { loreDir, dbPath } = await makeStoreDir('o3');
        seed(dbPath);
        const r = cli(['--lore-dir', loreDir, '--apply']);
        assert.equal(r.code, 0, r.err + r.out);
        assert.match(r.out, /deleted 3 row\(s\)/);
        assert.match(r.out, /FTS index consistent/);
        const db = new Database(dbPath);
        try {
            assert.deepEqual(idRows(db, 'lore:X').map((x) => `${x.text[0]}${x.canon}`), ['A0', 'B0', 'A1'], 'X keeps A(oldest), B(oldest), A(canonical)');
            assert.deepEqual(idRows(db, 'lore:Z').map((x) => x.canon), [1], 'Z keeps only the canonical row');
            assert.equal(idRows(db, 'lore:T').length, 3, 'tombstone breaks the run: nothing deleted');
            assert.equal(idRows(db, 'lore:W').length, 2, 'metadata change kept');
            assert.equal(idRows(db, 'lore:N').length, 2, 'hash-less rows kept');
            assert.equal(idRows(db, 'lore:V').length, 2, 'vector-vs-no-vector kept');
            assert.equal(idRows(db, 'lore:Y').length, 1);
            assert.equal((db.prepare('SELECT count(*) AS c FROM verbatim WHERE is_canonical = 1').get() as { c: number }).c, 7, 'one canonical row per id');
            assert.equal((db.prepare('SELECT count(*) AS c FROM verbatim_pieces').get() as { c: number }).c, 1, 'pieces untouched');
            assert.equal(ftsIntegrity(db as never), 'ok');
            const fts = (q: string) => (db.prepare(`SELECT count(*) AS c FROM verbatim_fts WHERE verbatim_fts MATCH ?`).get(q) as { c: number }).c;
            const tbl = (like: string) => (db.prepare(`SELECT count(*) AS c FROM verbatim WHERE text LIKE ?`).get(like) as { c: number }).c;
            assert.equal(fts('alpha'), tbl('%alpha%'), 'FTS row count matches the table after the deletes');
            assert.equal(fts('alpha'), 3);
        } finally { db.close(); }
        const again = cli(['--lore-dir', loreDir]);
        assert.match(again.out, /nothing to reclaim/, 'a second run finds nothing');
    });

    await test('o4 — chunking: apply spanning several transactions deletes everything planned', async () => {
        const { dbPath } = await makeStoreDir('o4');
        const db = new Database(dbPath);
        for (let n = 0; n < 40; n++) for (let k = 0; k < 6; k++) appendOld(db, `lore:n${n}`, { text: `body ${n}` });
        db.close();
        const rw = openReclaimDb(dbPath, true);
        const plan = scanReclaim(rw);
        assert.equal(plan.rowsToDelete, 40 * 5);
        const res = applyReclaim(rw, plan, 50);
        rw.close();
        assert.ok(res.chunks >= 4, `expected several chunks, got ${res.chunks}`);
        assert.equal(res.deleted, 200);
        assert.deepEqual(res.after, { totalRows: 40, distinctIds: 40, canonicalRows: 40, remainingDeletable: 0 });
        assert.equal(res.ftsIntegrity, 'ok');
    });

    await test('o5 — a row changed between plan and apply aborts that chunk (conflict), nothing deleted', async () => {
        const { dbPath } = await makeStoreDir('o5');
        const db = new Database(dbPath);
        for (let k = 0; k < 4; k++) appendOld(db, 'lore:c', { text: 'same' });
        db.close();
        const rw = openReclaimDb(dbPath, true);
        const plan = scanReclaim(rw);
        assert.equal(plan.rowsToDelete, 3);
        // A concurrent writer lands a real change after the scan.
        appendOld(rw, 'lore:c', { text: 'a real change' });
        assert.throws(() => applyReclaim(rw, plan), /changed while the reclaim was running/);
        assert.equal((rw.prepare('SELECT count(*) AS c FROM verbatim').get() as { c: number }).c, 5, 'nothing deleted');
        rw.close();
    });

    await test('o6 — apply is refused while another process holds the store open; succeeds once it exits', async () => {
        const { loreDir, dbPath } = await makeStoreDir('o6');
        seed(dbPath);
        const holder = spawn(process.execPath, ['-e', `
            const D = require(${JSON.stringify(path.join(repoRoot, 'node_modules', 'better-sqlite3'))});
            const db = new D(${JSON.stringify(dbPath)}); db.pragma('journal_mode = WAL'); db.prepare('select count(*) from verbatim').get();
            console.log('ready'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
            await new Promise<void>((res, rej) => { holder.stdout!.once('data', () => res()); holder.once('error', rej); setTimeout(() => rej(new Error('holder never became ready')), 20_000); });
            const before = dump(dbPath);
            const refused = cli(['--lore-dir', loreDir, '--apply']);
            assert.equal(refused.code, 1, refused.out);
            assert.match(refused.err, /is open in pid \d+/);
            assert.equal(dump(dbPath), before, 'nothing written');
            const forced = cli(['--lore-dir', loreDir, '--apply', '--force']);
            assert.equal(forced.code, 1, '--force never overrides a confirmed holder');
            const dry = cli(['--lore-dir', loreDir]);
            assert.equal(dry.code, 0, 'a dry run is read-only and allowed next to a live host');
        } finally { holder.kill('SIGKILL'); await new Promise((r) => holder.once('exit', r)); }
        const ok = cli(['--lore-dir', loreDir, '--apply']);
        assert.equal(ok.code, 0, ok.err + ok.out);
        assert.match(ok.out, /deleted 3 row\(s\)/);
    });

    await test('o7 — --vacuum shrinks the file; without it the file keeps its size and reports free pages', async () => {
        for (const vacuum of [false, true]) {
            const { loreDir, dbPath } = await makeStoreDir(`o7-${vacuum}`);
            const db = new Database(dbPath);
            const big = 'x'.repeat(20_000);
            for (let n = 0; n < 20; n++) for (let k = 0; k < 8; k++) appendOld(db, `lore:big${n}`, { text: `${big} ${n}` });
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
            const before = fs.statSync(dbPath).size;
            const r = cli(['--lore-dir', loreDir, '--apply', ...(vacuum ? ['--vacuum'] : [])]);
            assert.equal(r.code, 0, r.err + r.out);
            const after = fs.statSync(dbPath).size;
            if (vacuum) { assert.ok(after < before / 2, `vacuum should shrink ${before} -> ${after}`); assert.match(r.out, /\(vacuumed\)/); }
            else { assert.ok(after >= before * 0.9, `no vacuum: file keeps its size (${before} -> ${after})`); assert.match(r.out, /free inside the file/); }
        }
    });

    await test('o8 — LanceDB store reports not_supported; usage errors are refused', async () => {
        const base = fs.mkdtempSync(path.join(ROOT, 'o8-'));
        fs.mkdirSync(path.join(base, '.lore', 'lancedb'), { recursive: true });
        const r = cli(['--lore-dir', path.join(base, '.lore')]);
        assert.equal(r.code, 0);
        assert.match(r.out, /not_supported/);
        const v = cli(['--lore-dir', path.join(base, '.lore'), '--vacuum']);
        assert.equal(v.code, 1);
        assert.match(v.err, /--vacuum only applies together with --apply/);
        const bad = cli(['--lore-dir', path.join(base, '.lore'), '--bogus']);
        assert.equal(bad.code, 1);
    });

    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();

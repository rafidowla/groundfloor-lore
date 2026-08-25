#!/usr/bin/env tsx
/**
 * backup-sqlite-substrates-unit.ts — every `*.sqlite` substrate survives a
 * backup/restore round-trip, taken while its writer is still open.
 *
 * ── THE DEFECT THIS GUARDS ──────────────────────────────────────────────────
 *
 * `backup.ts` special-cased ONE filename. `tables.sqlite` was captured with
 * better-sqlite3's `serialize()` and its `-wal`/`-shm` sidecars were explicitly
 * skipped, because the B6 audit (2026-06-18/F1) empirically reproduced database
 * corruption when a main image copied at one instant was restored alongside a
 * `-wal` copied at a later one: SQLite replays stale frames.
 *
 * When ReBAC and the pending-ops queue moved into their own WAL-mode `.sqlite`
 * files under the same directory, the hardcoded filename check sent both down
 * the plain-`copyFileSync` branch — main image and sidecars each copied at a
 * different instant. That is precisely the reproduced hazard, now on an
 * authorization store and a human-approval queue.
 *
 * The fix is a shape, not a longer list: any `*.sqlite` gets the SQLite
 * treatment. This file pins that, so the next substrate to arrive is covered
 * before anyone remembers to think about it.
 *
 * Backups are taken with the writers STILL OPEN, because that is the condition
 * under which the bug bites — a daemon-stopped backup would pass either way.
 *
 * Run: npx tsx test/backup-sqlite-substrates-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { backupWorkspace } from '../packages/lore/src/engines/backup.js';
import { restoreWorkspace } from '../packages/lore/src/engines/restore.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-backup-sub-'));
const ws = path.join(root, 'ws');
const loreDir = path.join(ws, '.lore');
fs.mkdirSync(loreDir, { recursive: true });

/** A WAL-mode store with uncheckpointed rows — i.e. rows living in the -wal. */
function makeStore(file: string, table: string, rows: number): Database.Database {
    const db = new Database(path.join(loreDir, file));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const ins = db.prepare(`INSERT OR REPLACE INTO ${table} (id, v) VALUES (?, ?)`);
    for (let i = 0; i < rows; i++) ins.run(`k${i}`, `value-${i}`);
    return db; // deliberately left OPEN
}

console.log('Backup covers every .sqlite substrate');

// The three substrates a real workspace now carries, plus the non-SQLite ones.
const tables = makeStore('tables.sqlite', 'invoice', 5);
const rebac = makeStore('rebac.sqlite', 'lore_rebac_edge', 3);
const pending = makeStore('pending-ops.sqlite', 'lore_pending_op', 4);
fs.mkdirSync(path.join(loreDir, 'surreal'), { recursive: true });
fs.writeFileSync(path.join(loreDir, 'surreal', 'data.db'), 'surreal-bytes');
fs.writeFileSync(path.join(loreDir, 'hot_session.json'), '{"nodes":[]}');

let archive = '';

await test('a backup taken with writers open includes every .sqlite substrate', async () => {
    fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
    const res = await backupWorkspace({ workspaceDir: ws, workspaceName: 'ws', outDir: path.join(root, 'backups') });
    archive = res.tarballPath;
    assert.ok(fs.existsSync(archive), 'an archive was produced');

    const listed = res.files;
    for (const f of ['tables.sqlite', 'rebac.sqlite', 'pending-ops.sqlite']) {
        assert.ok(listed.includes(f), `${f} is in the backup manifest (got: ${listed.join(', ')})`);
    }
    // The whole point of the fix: sidecars must NOT ship. Shipping a -wal copied
    // at a different instant than the main image is the corruption path.
    for (const f of listed) {
        assert.ok(!/\.sqlite-(wal|shm|journal)$/.test(f), `sidecar ${f} must not be shipped`);
    }
});

await test('non-SQLite substrates still travel', async () => {
    fs.mkdirSync(path.join(root, 'backups2'), { recursive: true });
    const listed = (await backupWorkspace({
        workspaceDir: ws, workspaceName: 'ws', outDir: path.join(root, 'backups2'),
    })).files;
    assert.ok(listed.includes('surreal/'), 'the Surreal store directory travels');
    assert.ok(listed.includes('hot_session.json'), 'and plain files still travel');
});

await test('restore reproduces every row, including uncheckpointed ones', async () => {
    // Writers are still open here — this is the live-backup case.
    const dest = path.join(root, 'restored');
    fs.mkdirSync(dest, { recursive: true });
    await restoreWorkspace({ tarballPath: archive, workspaceDir: dest });

    // Checked BEFORE anything opens these files: a read-only open of a WAL
    // database creates its own -shm/-wal, so asserting later would measure the
    // test's own footprint instead of what the archive shipped.
    const shipped = fs.readdirSync(path.join(dest, '.lore'));
    assert.deepEqual(
        shipped.filter((f) => /\.sqlite-(wal|shm|journal)$/.test(f)), [],
        'no SQLite sidecar was shipped — a stale -wal beside a fresh main image is the corruption path',
    );

    const expect: Array<[string, string, number]> = [
        ['tables.sqlite', 'invoice', 5],
        ['rebac.sqlite', 'lore_rebac_edge', 3],
        ['pending-ops.sqlite', 'lore_pending_op', 4],
    ];
    for (const [file, table, rows] of expect) {
        const p = path.join(dest, '.lore', file);
        assert.ok(fs.existsSync(p), `${file} was restored`);
        const db = new Database(p, { readonly: true });
        try {
            const { c } = db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number };
            assert.equal(c, rows, `${file} restored all ${rows} rows (uncheckpointed WAL frames included)`);
            const row = db.prepare(`SELECT v FROM ${table} WHERE id = 'k0'`).get() as { v: string };
            assert.equal(row.v, 'value-0', `${file} content is intact, not just row-counted`);
        } finally {
            db.close();
        }
    }
});

await test('a restored store opens read-write without a sidecar and accepts writes', async () => {
    // A serialize()d image needs no -wal to reopen cleanly. If a stale sidecar
    // had shipped, this is where SQLite would object or replay stale frames.
    const p = path.join(root, 'restored', '.lore', 'rebac.sqlite');
    const db = new Database(p);
    try {
        db.pragma('journal_mode = WAL');
        db.prepare('INSERT INTO lore_rebac_edge (id, v) VALUES (?, ?)').run('k99', 'after-restore');
        const { c } = db.prepare('SELECT count(*) AS c FROM lore_rebac_edge').get() as { c: number };
        assert.equal(c, 4, 'the restored store is writable and consistent');
        assert.equal(
            (db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]!.integrity_check,
            'ok',
            'and passes SQLite integrity_check',
        );
    } finally {
        db.close();
    }
});

await test('a substrate added later is covered by shape, not by a filename list', async () => {
    // The regression that started this: a new .sqlite arrives and nobody
    // remembers to add it to a list. It must be handled because it ends in
    // .sqlite, not because someone enumerated it.
    const future = makeStore('some-future-substrate.sqlite', 'future_rows', 2);
    try {
        fs.mkdirSync(path.join(root, 'backups3'), { recursive: true });
        const listed = (await backupWorkspace({
            workspaceDir: ws, workspaceName: 'ws', outDir: path.join(root, 'backups3'),
        })).files;
        assert.ok(
            listed.includes('some-future-substrate.sqlite'),
            'an unforeseen .sqlite substrate is captured without code changes',
        );
        assert.ok(
            !listed.some((f) => f.startsWith('some-future-substrate.sqlite-')),
            'and its sidecars are skipped, same as every other store',
        );
    } finally {
        future.close();
        fs.rmSync(path.join(loreDir, 'some-future-substrate.sqlite'), { force: true });
    }
});

tables.close();
rebac.close();
pending.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env tsx
/**
 * fc-round5-dualwrite-window-loss-unit.ts — 2026-08-18 gaps 3 (finding 4.4)
 * and 4 (cluster-4 low), against the real MigrationCoordinator +
 * MigrationsStore + SqliteMigrationAdapter (the production wiring classes,
 * same as the finding's live repro).
 *
 * 4.4 repro shape: rename_column phone -> phone_e164. After advance() opens
 * the migrate-phase dual-write window, ordinary writes land (an UPDATE on an
 * existing row, an INSERT of a new row). advance() to contract previously
 * dropped the old column WITHOUT re-copying, so the UPDATE's value reverted
 * and the INSERT's new column stayed NULL — every step reported 'applied'.
 *
 *   T1  Late UPDATE survives contract (was silently reverted).
 *   T2  Late INSERT's value reaches the new column (was NULL).
 *   T3  Old column is gone after contract; migration rows all 'applied'.
 *   T4  Rehydration: a SECOND coordinator on the same migrations table (a
 *       daemon restart, or `lore migrate advance <id>` from a separate CLI
 *       process) sees the open window and contracts safely with no loss.
 *   T5  (gap 4) NULL source values copy through as NULL — not replaced by
 *       the new column's DEFAULT.
 *   T6  The fallback contract path (adapter without the atomic verb) also
 *       re-runs the backfill before dropping.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { MigrationsStore } from '../packages/lore/src/migration/store.js';
import { MigrationCoordinator } from '../packages/lore/src/migration/coordinator.js';
import { SqliteMigrationAdapter } from '../packages/lore/src/migration/adapters/sqliteMigrationAdapter.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

function fixture(label: string): { base: string; store: MigrationsStore; coord: MigrationCoordinator; db: Database.Database } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `lore-44-${label}-`));
    const store = new MigrationsStore(path.join(base, 'migrations-home'));
    const db = new Database(path.join(base, 'data.sqlite'));
    db.pragma('journal_mode = WAL');
    const coord = new MigrationCoordinator(store);
    coord.register(new SqliteMigrationAdapter(db));
    return { base, store, coord, db };
}

function rows(db: Database.Database): Array<{ id: string; phone_e164: string | null }> {
    return db.prepare('SELECT id, phone_e164 FROM contacts ORDER BY id').all() as Array<{ id: string; phone_e164: string | null }>;
}

async function main() {
    console.log('gap 3 (4.4) — dual-write window no longer discards late writes');

    await test('T1+T2+T3 late UPDATE + INSERT survive contract; old column dropped', async () => {
        const f = fixture('atomic');
        f.db.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY, phone TEXT)');
        f.db.prepare("INSERT INTO contacts (id, phone) VALUES ('a', '555-0100')").run();

        await f.coord.apply({
            id: 'ren-phone', kind: 'rename_column', substrate: 'sqlite', target: 'contacts', workspace: 'default',
            params: { fromColumn: 'phone', toColumn: 'phone_e164', columnDdl: 'phone_e164 TEXT' },
        });
        await f.coord.advance('ren-phone'); // → migrate (window opens, backfill runs)

        // Ordinary writes during the window — exactly the repro's two writes.
        f.db.prepare("UPDATE contacts SET phone = '555-9999' WHERE id = 'a'").run();
        f.db.prepare("INSERT INTO contacts (id, phone) VALUES ('b', '555-0200')").run();

        const row = await f.coord.advance('ren-phone'); // → contract

        assert.equal(row.status, 'applied');
        assert.equal(row.phase, 'contract');
        const got = Object.fromEntries(rows(f.db).map((r) => [r.id, r.phone_e164]));
        assert.equal(got['a'], '555-9999',
            `late UPDATE lost: phone_e164=${got['a']} (expected 555-9999) — write made during the migrate window was discarded by contract`);
        assert.equal(got['b'], '555-0200',
            `late INSERT lost: phone_e164=${got['b']} (expected 555-0200) — new column stayed NULL after contract`);
        const cols = (f.db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>).map((c) => c.name);
        assert.ok(!cols.includes('phone'), `old column still present: ${cols.join(',')}`);
        f.db.close(); f.store.close();
    });

    await test('T4 rehydration — a second coordinator (restart / separate CLI process) contracts safely', async () => {
        const f = fixture('rehydrate');
        f.db.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY, phone TEXT)');
        f.db.prepare("INSERT INTO contacts (id, phone) VALUES ('a', '555-0100')").run();

        const first = f.coord;
        await first.apply({
            id: 'ren-phone-2', kind: 'rename_column', substrate: 'sqlite', target: 'contacts', workspace: 'default',
            params: { fromColumn: 'phone', toColumn: 'phone_e164', columnDdl: 'phone_e164 TEXT' },
        });
        await first.advance('ren-phone-2'); // → migrate. Window open in `first` only.
        f.db.prepare("UPDATE contacts SET phone = '555-8888' WHERE id = 'a'").run();

        // Fresh coordinator on the SAME durable migrations table — the
        // daemon-restart / separate-CLI-process case. Pre-fix: empty map,
        // window invisible; contract still lost the late write.
        const second = new MigrationCoordinator(f.store);
        second.register(new SqliteMigrationAdapter(f.db));
        assert.equal(second.listDualWrites().length, 1,
            'rehydrated coordinator must see the open dual-write window from the migrations table');

        const row = await second.advance('ren-phone-2'); // → contract from the NEW process
        assert.equal(row.status, 'applied');
        assert.equal(rows(f.db)[0]!.phone_e164, '555-8888',
            'late write lost across the restart boundary');
        f.db.close(); f.store.close();
    });

    await test('T5 (gap 4) NULL source values copy through as NULL, not the DEFAULT', async () => {
        const f = fixture('nulls');
        // DEFAULT 'unknown' makes the pre-fix failure visible: the excluded
        // NULL row kept the placeholder instead of NULL.
        f.db.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY, phone TEXT)');
        f.db.prepare("INSERT INTO contacts (id, phone) VALUES ('null-row', NULL)").run();
        f.db.prepare("INSERT INTO contacts (id, phone) VALUES ('val-row', '555-0300')").run();

        await f.coord.apply({
            id: 'ren-phone-3', kind: 'rename_column', substrate: 'sqlite', target: 'contacts', workspace: 'default',
            params: { fromColumn: 'phone', toColumn: 'phone_e164', columnDdl: "phone_e164 TEXT DEFAULT 'unknown'" },
        });
        const mig = await f.coord.advance('ren-phone-3');
        assert.equal(mig.status, 'applied');
        await f.coord.advance('ren-phone-3'); // → contract

        const got = Object.fromEntries(rows(f.db).map((r) => [r.id, r.phone_e164]));
        assert.equal(got['null-row'], null,
            `NULL source row replaced with DEFAULT: got ${JSON.stringify(got['null-row'])} (expected null)`);
        assert.equal(got['val-row'], '555-0300');
        f.db.close(); f.store.close();
    });

    await test('T6 fallback contract path (no atomic verb) re-runs backfill before dropOld', async () => {
        const f = fixture('fallback');
        f.db.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY, phone TEXT)');
        f.db.prepare("INSERT INTO contacts (id, phone) VALUES ('a', '555-0100')").run();

        // Strip the atomic verb — simulates kuzu/lance/test adapters that
        // only implement migrateData + dropOld.
        const full = new SqliteMigrationAdapter(f.db);
        const stripped = Object.create(full);
        delete (stripped as { contract?: unknown }).contract;
        f.coord.register(stripped);

        await f.coord.apply({
            id: 'ren-phone-4', kind: 'rename_column', substrate: 'sqlite', target: 'contacts', workspace: 'default',
            params: { fromColumn: 'phone', toColumn: 'phone_e164', columnDdl: 'phone_e164 TEXT' },
        });
        await f.coord.advance('ren-phone-4');
        f.db.prepare("UPDATE contacts SET phone = '555-7777' WHERE id = 'a'").run();

        const row = await f.coord.advance('ren-phone-4'); // → contract via fallback
        assert.equal(row.status, 'applied');
        assert.equal(rows(f.db)[0]!.phone_e164, '555-7777',
            'fallback path lost the late write (migrateData not re-run before dropOld)');
        f.db.close(); f.store.close();
    });

    await Promise.all(pending);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

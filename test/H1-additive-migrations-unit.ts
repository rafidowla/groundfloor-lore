#!/usr/bin/env tsx
/**
 * test/H1-additive-migrations-unit.ts — Sprint H1 unit suite.
 *
 * Exercises MigrationCoordinator + per-substrate adapters end-to-end
 * against ephemeral on-disk SQLite. Asserts:
 *
 *   1. add column to existing SQLite table succeeds online, migrations
 *      row tracks pending → running → applied, outbox emits started + applied
 *   2. add new SQLite table succeeds online
 *   3. add new SQLite index succeeds online
 *   4. each operation reverses via rollback (status flips to rolled_back,
 *      column / table / index disappears from the substrate)
 *   5. workspace_required preserved — apply() throws on empty workspace
 *      (Sprint L invariant)
 *   6. outbox notifications carry migration.applied with the right payload
 *   7. concurrent writes during migration succeed (ALTER TABLE ADD COLUMN
 *      in SQLite blocks briefly; we verify a follow-up INSERT lands fine)
 *   8. lance adapter addColumn calls the shim with the spec column
 *
 * No daemon. No live lance — substrate adapters are wired
 * against in-process shims so the suite stays fast + hermetic.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { MigrationsStore } from '../packages/lore/src/migration/store.js';
import { MigrationCoordinator } from '../packages/lore/src/migration/coordinator.js';
import { SqliteMigrationAdapter } from '../packages/lore/src/migration/adapters/sqliteMigrationAdapter.js';
import { LanceMigrationAdapter, type LanceConnectionShim } from '../packages/lore/src/migration/adapters/lanceMigrationAdapter.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`);
            failed++;
        }
    })());
}

function tmpDir(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-h1-${label}-`));
}

class RecordingNotifier {
    entries: OutboxEntry[] = [];
    async record(entry: OutboxEntry): Promise<void> {
        this.entries.push(entry);
    }
}

function fixture(label: string): {
    base: string;
    store: MigrationsStore;
    notifier: RecordingNotifier;
    coord: MigrationCoordinator;
    db: import('better-sqlite3').Database;
    cleanup: () => void;
} {
    const base = tmpDir(label);
    const dbPath = path.join(base, 'data.sqlite');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS load_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
    db.prepare(`INSERT INTO load_jobs(id, status) VALUES (?, ?)`).run('j1', 'queued');

    const store = new MigrationsStore(base);
    const notifier = new RecordingNotifier();
    const coord = new MigrationCoordinator(store, notifier);
    coord.register(new SqliteMigrationAdapter(db));
    return {
        base,
        store,
        notifier,
        coord,
        db,
        cleanup: () => {
            try { db.close(); } catch {}
            try { store.close(); } catch {}
            try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
        },
    };
}

console.log('Sprint H1 unit suite — additive online migrations');

test('add_column to existing sqlite table succeeds online + migrations row tracks state', async () => {
    const fx = fixture('addcol');
    try {
        const row = await fx.coord.addColumn({
            id: 'mig-add-priority',
            substrate: 'sqlite',
            workspace: 'default',
            table: 'load_jobs',
            column: 'priority INTEGER DEFAULT 0',
        });
        assert.equal(row.status, 'applied');
        assert.equal(row.kind, 'add_column');
        assert.equal(row.phase, 'additive');
        assert.ok(row.appliedAt, 'appliedAt timestamp set');
        // Column actually exists.
        const cols = fx.db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
        assert.ok(cols.some((c) => c.name === 'priority'), 'priority column added');
        // Migration is queryable.
        assert.equal(fx.coord.getMigration('mig-add-priority')?.status, 'applied');
        // Outbox emitted started + applied.
        const kinds = fx.notifier.entries.map((e) => e.operationKind);
        assert.deepEqual(kinds, ['migration.started', 'migration.applied']);
        assert.equal((fx.notifier.entries[0].payload as { migrationId: string }).migrationId, 'mig-add-priority');
    } finally { fx.cleanup(); }
});

test('add_table for new sqlite table succeeds online', async () => {
    const fx = fixture('addtbl');
    try {
        const row = await fx.coord.addTable({
            substrate: 'sqlite',
            workspace: 'default',
            table: 'audit_log',
            columns: 'id TEXT PRIMARY KEY, at TEXT NOT NULL',
        });
        assert.equal(row.status, 'applied');
        // Table actually exists.
        const t = fx.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'`).get();
        assert.ok(t, 'audit_log table created');
    } finally { fx.cleanup(); }
});

test('add_index on sqlite succeeds online', async () => {
    const fx = fixture('addidx');
    try {
        const row = await fx.coord.addIndex({
            substrate: 'sqlite',
            workspace: 'default',
            table: 'load_jobs',
            indexName: 'idx_load_jobs_status',
            columns: 'status',
        });
        assert.equal(row.status, 'applied');
        const idx = fx.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_load_jobs_status'`).get();
        assert.ok(idx, 'index actually created');
    } finally { fx.cleanup(); }
});

test('rollback reverses an applied add_column', async () => {
    const fx = fixture('rollbackcol');
    try {
        const row = await fx.coord.addColumn({
            id: 'mig-rb',
            substrate: 'sqlite',
            workspace: 'default',
            table: 'load_jobs',
            column: 'extra TEXT',
        });
        assert.equal(row.status, 'applied');
        const after = await fx.coord.rollback('mig-rb');
        // SQLite >= 3.35 supports DROP COLUMN; older versions return failed
        // status (rollback couldn't run). Either way the coordinator
        // record reflects truth.
        if (after.status === 'rolled_back') {
            const cols = fx.db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
            assert.ok(!cols.some((c) => c.name === 'extra'), 'extra column dropped');
        } else {
            assert.equal(after.status, 'failed');
            assert.match(after.error ?? '', /drop-column-not-supported/);
        }
    } finally { fx.cleanup(); }
});

test('rollback reverses an applied add_table + add_index', async () => {
    const fx = fixture('rbtbl');
    try {
        const tbl = await fx.coord.addTable({
            id: 'mig-rbtbl', substrate: 'sqlite', workspace: 'default',
            table: 'tmp_audit', columns: 'id TEXT PRIMARY KEY',
        });
        assert.equal(tbl.status, 'applied');
        const afterTbl = await fx.coord.rollback('mig-rbtbl');
        assert.equal(afterTbl.status, 'rolled_back');
        const t = fx.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tmp_audit'`).get();
        assert.equal(t, undefined, 'table dropped');

        const idx = await fx.coord.addIndex({
            id: 'mig-rbidx', substrate: 'sqlite', workspace: 'default',
            table: 'load_jobs', indexName: 'idx_rb', columns: 'status',
        });
        assert.equal(idx.status, 'applied');
        const afterIdx = await fx.coord.rollback('mig-rbidx');
        assert.equal(afterIdx.status, 'rolled_back');
        const i = fx.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rb'`).get();
        assert.equal(i, undefined, 'index dropped');
    } finally { fx.cleanup(); }
});

test('workspace_required preserved — apply throws on empty workspace (Sprint L invariant)', async () => {
    const fx = fixture('wsreq');
    try {
        await assert.rejects(
            fx.coord.addColumn({
                substrate: 'sqlite',
                workspace: '',
                table: 'load_jobs',
                column: 'whatever TEXT',
            }),
            /missing workspace/i,
        );
    } finally { fx.cleanup(); }
});

test('outbox notification payload carries migration metadata (Sprint O contract)', async () => {
    const fx = fixture('outboxpay');
    try {
        await fx.coord.addColumn({
            id: 'mig-payload', substrate: 'sqlite', workspace: 'workspaceA',
            table: 'load_jobs', column: 'tag TEXT',
        });
        const applied = fx.notifier.entries.find((e) => e.operationKind === 'migration.applied');
        assert.ok(applied, 'migration.applied emitted');
        assert.equal(applied!.workspace, 'workspaceA', 'workspace mirrors spec.workspace');
        const p = applied!.payload as Record<string, unknown>;
        assert.equal(p['migrationId'], 'mig-payload');
        assert.equal(p['migrationKind'], 'add_column');
        assert.equal(p['substrate'], 'sqlite');
        assert.equal(p['target'], 'load_jobs');
    } finally { fx.cleanup(); }
});

test('concurrent writes during add_column succeed (no daemon-down requirement)', async () => {
    const fx = fixture('concurrent');
    try {
        // Kick off a parallel INSERT and the migration; both succeed.
        const insert = (async () => {
            for (let i = 0; i < 20; i++) {
                fx.db.prepare(`INSERT INTO load_jobs(id, status) VALUES (?, 'queued')`).run(`cw-${i}`);
            }
        })();
        const migrate = fx.coord.addColumn({
            substrate: 'sqlite', workspace: 'default',
            table: 'load_jobs', column: 'note TEXT',
        });
        await Promise.all([insert, migrate]);
        const cols = fx.db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
        assert.ok(cols.some((c) => c.name === 'note'));
        const cnt = fx.db.prepare(`SELECT COUNT(*) AS c FROM load_jobs`).get() as { c: number };
        assert.ok(cnt.c >= 21, 'all inserts landed alongside migration');
    } finally { fx.cleanup(); }
});

test('lance adapter routes addColumn through the connection shim', async () => {
    const base = tmpDir('lance');
    const store = new MigrationsStore(base);
    const coord = new MigrationCoordinator(store);
    const calls: Array<{ op: string; arg: string }> = [];
    const conn: LanceConnectionShim = {
        addField: async (t, c) => { calls.push({ op: 'addField', arg: `${t}|${c}` }); },
        createTable: async () => {},
        dropTable: async () => {},
        createIndex: async () => {},
        dropIndex: async () => {},
    };
    coord.register(new LanceMigrationAdapter(conn));
    try {
        const row = await coord.addColumn({
            substrate: 'lance', workspace: 'default',
            table: 'lore_verbatim', column: 'metadata TEXT',
        });
        assert.equal(row.status, 'applied');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].op, 'addField');
        assert.equal(calls[0].arg, 'lore_verbatim|metadata TEXT');
    } finally {
        store.close();
        try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    }
});

await Promise.all(pending);
console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);

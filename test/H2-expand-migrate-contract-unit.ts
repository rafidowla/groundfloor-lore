#!/usr/bin/env tsx
/**
 * test/H2-expand-migrate-contract-unit.ts — Sprint H2 unit suite.
 *
 * Exercises the expand/migrate/contract pattern end-to-end across the
 * two substrates via in-process adapters (sqlite real,
 * lance shim). No daemon. No live lance.
 *
 * Coverage:
 *   1. Rename column SQLite — 3 phases, data preserved, no daemon restart
 *   2. Rename column SQLite — rollback from migrate restores expand state
 *   3. Rename column SQLite — rollback from expand drops the new column
 *   4. Rename column SQLite — rollback from contract is REFUSED
 *   5. Change column type SQLite — expand → migrate → contract
 *   6. Drop column SQLite — expand → migrate → contract
 *   7. Rename column lance — Arrow rebuild via shim
 *   8. Dual-write Phase 2 — coordinator.dualWriteActiveFor returns state
 *   9. Dual-write Phase 2 — LoaderDispatcher mirrors metadata key
 *  10. Outbox emits migration.started + migration.applied per phase
 *  11. workspace_required preserved on destructive parent kinds
 *  12. advance() refused on non-destructive kinds
 *  13. advance() refused at terminal 'complete' phase
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
import { LoaderDispatcher } from '../packages/lore/src/bulkLoader/loaderDispatcher.js';
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
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-h2-${label}-`));
}

class RecordingNotifier {
    entries: OutboxEntry[] = [];
    async record(entry: OutboxEntry): Promise<void> {
        this.entries.push(entry);
    }
}

function sqliteFixture(label: string): {
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
    db.exec(`CREATE TABLE IF NOT EXISTS load_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, priority INTEGER DEFAULT 0)`);
    const ins = db.prepare(`INSERT INTO load_jobs(id, status, priority) VALUES (?, ?, ?)`);
    ins.run('j1', 'queued', 7);
    ins.run('j2', 'queued', 3);
    ins.run('j3', 'running', 5);

    const store = new MigrationsStore(base);
    const notifier = new RecordingNotifier();
    const coord = new MigrationCoordinator(store, notifier);
    coord.register(new SqliteMigrationAdapter(db));
    return {
        base, store, notifier, coord, db,
        cleanup: () => {
            try { db.close(); } catch {}
            try { store.close(); } catch {}
            try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
        },
    };
}

console.log('Sprint H2 unit suite — expand/migrate/contract');

// ----- Rename column SQLite (full happy path) -----
test('rename_column SQLite: expand → migrate → contract preserves data, no daemon restart', async () => {
    const fx = sqliteFixture('renamesqlite');
    try {
        // Phase 1 EXPAND — apply.
        let row = await fx.coord.apply({
            id: 'mig-ren-1',
            kind: 'rename_column',
            substrate: 'sqlite',
            target: 'load_jobs',
            workspace: 'default',
            params: { fromColumn: 'priority', toColumn: 'prio_v2', columnDdl: 'prio_v2 INTEGER DEFAULT 0' },
        });
        assert.equal(row.status, 'applied');
        assert.equal(row.phase, 'expand');
        // New column present, old column present, new column NULL/default.
        const cols1 = fx.db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
        assert.ok(cols1.some((c) => c.name === 'prio_v2'), 'prio_v2 added');
        assert.ok(cols1.some((c) => c.name === 'priority'), 'priority still present');

        // Phase 2 MIGRATE — advance.
        row = await fx.coord.advance('mig-ren-1');
        assert.equal(row.status, 'applied');
        assert.equal(row.phase, 'migrate');
        // Backfilled — every row's prio_v2 == priority.
        const rows = fx.db.prepare(`SELECT id, priority, prio_v2 FROM load_jobs ORDER BY id`).all() as Array<{ id: string; priority: number; prio_v2: number }>;
        for (const r of rows) assert.equal(r.prio_v2, r.priority, `j=${r.id}: expected ${r.priority}, got ${r.prio_v2}`);

        // Phase 3 CONTRACT — advance.
        row = await fx.coord.advance('mig-ren-1');
        assert.equal(row.status, 'applied');
        assert.equal(row.phase, 'contract');
        // Old column gone (SQLite 3.35+).
        const cols3 = fx.db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
        assert.ok(!cols3.some((c) => c.name === 'priority'), 'priority dropped');
        assert.ok(cols3.some((c) => c.name === 'prio_v2'), 'prio_v2 retained');

        // Complete marker.
        row = await fx.coord.advance('mig-ren-1');
        assert.equal(row.phase, 'complete');
    } finally { fx.cleanup(); }
});

// ----- Rollback from migrate -----
test('rename_column SQLite: rollback from Phase 2 closes dual-write, retains new column', async () => {
    const fx = sqliteFixture('rbmigrate');
    try {
        await fx.coord.apply({
            id: 'mig-rb-m', kind: 'rename_column', substrate: 'sqlite', target: 'load_jobs', workspace: 'default',
            params: { fromColumn: 'priority', toColumn: 'p2', columnDdl: 'p2 INTEGER DEFAULT 0' },
        });
        let row = await fx.coord.advance('mig-rb-m');
        assert.equal(row.phase, 'migrate');
        assert.ok(fx.coord.dualWriteActiveFor('load_jobs', 'priority', 'sqlite'), 'dual-write open');

        row = await fx.coord.rollbackPhase('mig-rb-m');
        assert.equal(row.phase, 'expand');
        assert.equal(row.status, 'applied');
        assert.equal(fx.coord.dualWriteActiveFor('load_jobs', 'priority', 'sqlite'), undefined, 'dual-write closed');
        // New column still present with the backfilled data.
        const cols = fx.db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
        assert.ok(cols.some((c) => c.name === 'p2'), 'p2 retained');
    } finally { fx.cleanup(); }
});

// ----- Rollback from expand -----
test('rename_column SQLite: rollback from Phase 1 drops the new column', async () => {
    const fx = sqliteFixture('rbexpand');
    try {
        await fx.coord.apply({
            id: 'mig-rb-e', kind: 'rename_column', substrate: 'sqlite', target: 'load_jobs', workspace: 'default',
            params: { fromColumn: 'priority', toColumn: 'p3', columnDdl: 'p3 INTEGER DEFAULT 0' },
        });
        const row = await fx.coord.rollbackPhase('mig-rb-e');
        assert.equal(row.status, 'rolled_back');
        const cols = fx.db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
        assert.ok(!cols.some((c) => c.name === 'p3'), 'p3 dropped');
        assert.ok(cols.some((c) => c.name === 'priority'), 'priority preserved');
    } finally { fx.cleanup(); }
});

// ----- Rollback from contract refused -----
test('rename_column SQLite: rollback from Phase 3 refused (contract is terminal)', async () => {
    const fx = sqliteFixture('rbcontract');
    try {
        await fx.coord.apply({
            id: 'mig-rb-c', kind: 'rename_column', substrate: 'sqlite', target: 'load_jobs', workspace: 'default',
            params: { fromColumn: 'priority', toColumn: 'p4', columnDdl: 'p4 INTEGER DEFAULT 0' },
        });
        await fx.coord.advance('mig-rb-c'); // migrate
        await fx.coord.advance('mig-rb-c'); // contract
        await assert.rejects(fx.coord.rollbackPhase('mig-rb-c'), /contract phase is terminal|cannot rollback/);
    } finally { fx.cleanup(); }
});

// ----- Change column type -----
test('change_type SQLite: expand → migrate → contract via replacement column', async () => {
    const fx = sqliteFixture('changetype');
    try {
        let row = await fx.coord.apply({
            id: 'mig-ct-1', kind: 'change_type', substrate: 'sqlite', target: 'load_jobs', workspace: 'default',
            params: { fromColumn: 'priority', toColumn: 'priority_txt', columnDdl: 'priority_txt TEXT' },
        });
        assert.equal(row.phase, 'expand');
        row = await fx.coord.advance('mig-ct-1');
        assert.equal(row.phase, 'migrate');
        const rows = fx.db.prepare(`SELECT priority, priority_txt FROM load_jobs`).all() as Array<{ priority: number; priority_txt: string }>;
        // SQLite coerces freely — backfilled column is non-null where source non-null.
        for (const r of rows) assert.ok(r.priority_txt !== null && r.priority_txt !== undefined, 'priority_txt populated');
        row = await fx.coord.advance('mig-ct-1');
        assert.equal(row.phase, 'contract');
        const cols = fx.db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
        assert.ok(!cols.some((c) => c.name === 'priority'), 'old priority column dropped');
    } finally { fx.cleanup(); }
});

// ----- Drop column -----
test('drop_column SQLite: expand → migrate → contract removes the column', async () => {
    const fx = sqliteFixture('dropcol');
    try {
        let row = await fx.coord.apply({
            id: 'mig-dc-1', kind: 'drop_column', substrate: 'sqlite', target: 'load_jobs', workspace: 'default',
            params: { column: 'priority' },
        });
        assert.equal(row.phase, 'expand');
        // Phase 1 + 2 are no-ops for drop; Phase 3 does the work.
        row = await fx.coord.advance('mig-dc-1');
        assert.equal(row.phase, 'migrate');
        row = await fx.coord.advance('mig-dc-1');
        assert.equal(row.phase, 'contract');
        const cols = fx.db.prepare(`PRAGMA table_info(load_jobs)`).all() as Array<{ name: string }>;
        assert.ok(!cols.some((c) => c.name === 'priority'), 'priority dropped');
    } finally { fx.cleanup(); }
});

// ----- Lance Arrow rebuild via shim -----
test('rename_column lance: expand uses addField, migrate uses copyColumn, contract uses dropColumn', async () => {
    const base = tmpDir('lance');
    const store = new MigrationsStore(base);
    const coord = new MigrationCoordinator(store);
    const calls: string[] = [];
    const lshim: LanceConnectionShim = {
        async addField(t, c) { calls.push(`addField:${t}:${c}`); },
        async createTable() {},
        async dropTable() {},
        async createIndex() {},
        async dropIndex() {},
        async copyColumn(t, from, to) { calls.push(`copyColumn:${t}:${from}->${to}`); return { rowsCopied: 7 }; },
        async dropColumn(t, c) { calls.push(`dropColumn:${t}:${c}`); },
    };
    coord.register(new LanceMigrationAdapter(lshim));
    try {
        await coord.apply({
            id: 'mig-l-1', kind: 'rename_column', substrate: 'lance', target: 'embeddings', workspace: 'default',
            params: { fromColumn: 'score', toColumn: 'score_v2', columnDdl: 'score_v2 FLOAT' },
        });
        await coord.advance('mig-l-1');
        await coord.advance('mig-l-1');
        assert.ok(calls.some((c) => c === 'addField:embeddings:score_v2 FLOAT'), 'addField called');
        assert.ok(calls.some((c) => c === 'copyColumn:embeddings:score->score_v2'), 'copyColumn called');
        assert.ok(calls.some((c) => c === 'dropColumn:embeddings:score'), 'dropColumn called');
    } finally {
        try { store.close(); } catch {}
        try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    }
});

// ----- Dual-write coordinator surface -----
test('dualWriteActiveFor returns state only during Phase 2 (migrate)', async () => {
    const fx = sqliteFixture('dwsurface');
    try {
        await fx.coord.apply({
            id: 'mig-dw', kind: 'rename_column', substrate: 'sqlite', target: 'load_jobs', workspace: 'default',
            params: { fromColumn: 'priority', toColumn: 'p9', columnDdl: 'p9 INTEGER DEFAULT 0' },
        });
        assert.equal(fx.coord.dualWriteActiveFor('load_jobs', 'priority', 'sqlite'), undefined, 'no DW in expand');
        await fx.coord.advance('mig-dw'); // migrate
        const dw = fx.coord.dualWriteActiveFor('load_jobs', 'priority', 'sqlite');
        assert.ok(dw, 'DW present in migrate');
        assert.equal(dw!.toColumn, 'p9');
        assert.equal(dw!.migrationId, 'mig-dw');
        await fx.coord.advance('mig-dw'); // contract
        assert.equal(fx.coord.dualWriteActiveFor('load_jobs', 'priority', 'sqlite'), undefined, 'no DW after contract');
    } finally { fx.cleanup(); }
});

// ----- LoaderDispatcher dual-write integration -----
test('LoaderDispatcher.dispatch mirrors metadata key when dual-write active', async () => {
    const fx = sqliteFixture('dwloader');
    try {
        // Register a no-op lance adapter BEFORE applying the lance-substrate migration.
        const lshim: LanceConnectionShim = {
            async addField() {}, async createTable() {}, async dropTable() {},
            async createIndex() {}, async dropIndex() {},
            async copyColumn() { return { rowsCopied: 0 }; },
            async dropColumn() {},
        };
        fx.coord.register(new LanceMigrationAdapter(lshim));
        await fx.coord.apply({
            id: 'mig-dw-l', kind: 'rename_column', substrate: 'lance', target: 'verbatim', workspace: 'default',
            params: { fromColumn: 'author', toColumn: 'author_v2', columnDdl: 'author_v2 STRING' },
        });
        await fx.coord.advance('mig-dw-l');
        assert.ok(fx.coord.dualWriteActiveFor('verbatim', 'author', 'lance'), 'DW open');

        // Now dispatch a verbatim row carrying author in metadata.
        const writes: Array<{ id: string; metadata: Record<string, unknown> | undefined }> = [];
        const fakeLance = {
            async begin() {}, async commit() {}, async rollback() {},
            async writeBatch(batch: Array<{ id: string; metadata: Record<string, unknown> | undefined }>) {
                for (const r of batch) writes.push({ id: r.id, metadata: r.metadata });
                return { written: batch.length, failed: 0, errors: [] };
            },
        };
        const fakeSqlite = {
            async begin() {}, async commit() {}, async rollback() {},
            async writeBatch(batch: Array<{ id: string; metadata?: Record<string, unknown> }>) {
                return { written: batch.length, failed: 0, errors: [] };
            },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dispatcher = new LoaderDispatcher({ sqlite: fakeSqlite as any, lance: fakeLance as any, migrationCoordinator: fx.coord, flushThreshold: 10 });
        await dispatcher.begin({ jobId: 'j1', baseRowIndex: 0, workspace: 'default' } as any);
        await dispatcher.dispatch({
            target: 'verbatim',
            row: { id: 'v1', text: 'hello', workspace: 'default', metadata: { author: 'rafi' } },
        }, 0);
        await dispatcher.flushAll();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].metadata?.['author'], 'rafi', 'author preserved');
        assert.equal(writes[0].metadata?.['author_v2'], 'rafi', 'author mirrored to author_v2');
    } finally { fx.cleanup(); }
});

// ----- Outbox emissions per phase -----
test('outbox emits migration.started + migration.applied per phase', async () => {
    const fx = sqliteFixture('outbox');
    try {
        await fx.coord.apply({
            id: 'mig-ob', kind: 'rename_column', substrate: 'sqlite', target: 'load_jobs', workspace: 'default',
            params: { fromColumn: 'priority', toColumn: 'po', columnDdl: 'po INTEGER DEFAULT 0' },
        });
        await fx.coord.advance('mig-ob');
        await fx.coord.advance('mig-ob');
        // Sequence: apply (started, applied) + advance migrate (started, applied) + advance contract (started, applied)
        const kinds = fx.notifier.entries.map((e) => e.operationKind);
        const startedCount = kinds.filter((k) => k === 'migration.started').length;
        const appliedCount = kinds.filter((k) => k === 'migration.applied').length;
        assert.ok(startedCount >= 3, `expected >=3 started, got ${startedCount}`);
        assert.ok(appliedCount >= 3, `expected >=3 applied, got ${appliedCount}`);
        // Phase transition recorded in payload.
        const migrateEntry = fx.notifier.entries.find((e) => e.operationKind === 'migration.applied' && (e.payload as { phase?: string }).phase === 'migrate');
        assert.ok(migrateEntry, 'applied/migrate emission present');
    } finally { fx.cleanup(); }
});

// ----- workspace_required preserved -----
test('workspace_required preserved on destructive parent kinds (Sprint L invariant)', async () => {
    const fx = sqliteFixture('wsreq');
    try {
        await assert.rejects(
            fx.coord.apply({
                id: 'mig-wsreq', kind: 'rename_column', substrate: 'sqlite', target: 'load_jobs', workspace: '',
                params: { fromColumn: 'priority', toColumn: 'p', columnDdl: 'p INTEGER' },
            }),
            /missing workspace/i,
        );
    } finally { fx.cleanup(); }
});

// ----- advance() refused on additive kinds -----
test('advance() refused on additive kinds (not a destructive parent)', async () => {
    const fx = sqliteFixture('advadd');
    try {
        await fx.coord.addColumn({ id: 'add-1', substrate: 'sqlite', workspace: 'default', table: 'load_jobs', column: 'extra TEXT' });
        await assert.rejects(fx.coord.advance('add-1'), /only valid for destructive parent kinds/);
    } finally { fx.cleanup(); }
});

// ----- advance() refused at terminal complete -----
test('advance() refused at terminal complete phase', async () => {
    const fx = sqliteFixture('advterm');
    try {
        await fx.coord.apply({
            id: 'mig-term', kind: 'rename_column', substrate: 'sqlite', target: 'load_jobs', workspace: 'default',
            params: { fromColumn: 'priority', toColumn: 'pt', columnDdl: 'pt INTEGER DEFAULT 0' },
        });
        await fx.coord.advance('mig-term'); // migrate
        await fx.coord.advance('mig-term'); // contract
        await fx.coord.advance('mig-term'); // complete
        await assert.rejects(fx.coord.advance('mig-term'), /already at terminal phase|complete/);
    } finally { fx.cleanup(); }
});

// ----- runner -----
await Promise.all(pending);
console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log('OK');

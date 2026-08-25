/**
 * cli/commands/migrateOnline.ts — Sprint H1 `lore migrate <op>` subcommands.
 *
 * Split from migrate.ts so the legacy V1-SQLite + L5b migrators stay
 * small and the new H1 surface owns its own file. Routes through
 * MigrationCoordinator + per-substrate adapters.
 *
 * Spec file format (JSON):
 *   {
 *     "id": "20260524-add-priority-column",
 *     "kind": "add_column",            // add_column | add_table | add_index
 *     "substrate": "sqlite",           // sqlite | kuzu | lance
 *     "target": "load_jobs",
 *     "workspace": "default",
 *     "params": { "column": "priority INTEGER DEFAULT 0" }
 *   }
 *
 * The CLI opens an EPHEMERAL MigrationCoordinator against the local
 * loreDir's migrations.sqlite — no daemon required. The substrate
 * adapter wiring is connection-specific: for `sqlite` substrate the
 * CLI accepts `--db-path <file>` (defaults to the local outbox.sqlite
 * for demo purposes); for `kuzu` and `lance` the CLI emits a
 * "operator-must-supply-handle" notice today since wiring those into
 * a running daemon's open handle is the H1.next step (the daemon-side
 * wiring is exercised via test fixtures + the in-process unit suite).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { loreHome } from '../../config/loreHome.js';
import { MigrationsStore } from '../../migration/store.js';
import { MigrationCoordinator } from '../../migration/coordinator.js';
import { SqliteMigrationAdapter } from '../../migration/adapters/sqliteMigrationAdapter.js';
import type { MigrationSpec, SubstrateName, MigrationStatus } from '../../migration/types.js';

function readArg(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    if (i < 0 || i + 1 >= args.length) return undefined;
    return args[i + 1];
}

function openCoordinator(): { coord: MigrationCoordinator; store: MigrationsStore } {
    const base = loreHome();
    const loreDir = path.join(base, '.lore');
    if (!fs.existsSync(loreDir)) fs.mkdirSync(loreDir, { recursive: true });
    const store = new MigrationsStore(loreDir);
    const coord = new MigrationCoordinator(store);
    return { coord, store };
}

function registerSqliteAdapter(coord: MigrationCoordinator, dbPath: string): void {
    if (!fs.existsSync(dbPath)) throw new Error(`sqlite db not found: ${dbPath}`);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    coord.register(new SqliteMigrationAdapter(db));
}

export async function runMigrateSubcommand(sub: string, args: string[]): Promise<void> {
    if (sub === 'list') return runList(args);
    if (sub === 'status') return runStatus(args);
    if (sub === 'apply') return runApply(args);
    if (sub === 'rollback') return runRollback(args);
    if (sub === 'advance') return runAdvance(args);
    console.error(`unknown migrate subcommand '${sub}'`);
    process.exit(2);
}

function runList(args: string[]): Promise<void> {
    const { coord, store } = openCoordinator();
    try {
        const substrate = readArg(args, '--substrate') as SubstrateName | undefined;
        const workspace = readArg(args, '--workspace');
        const status = readArg(args, '--status') as MigrationStatus | undefined;
        const rows = coord.listMigrations({ substrate, workspace, status });
        if (rows.length === 0) {
            console.log('No migrations recorded.');
            return Promise.resolve();
        }
        console.log(`id\tkind\tsubstrate\ttarget\tworkspace\tphase\tstatus\tappliedAt`);
        for (const r of rows) {
            console.log([r.id, r.kind, r.substrate, r.target, r.workspace, r.phase, r.status, r.appliedAt ?? '-'].join('\t'));
        }
        return Promise.resolve();
    } finally {
        store.close();
    }
}

function runStatus(args: string[]): Promise<void> {
    const { coord, store } = openCoordinator();
    try {
        const id = args[0];
        if (!id) {
            console.error('usage: lore migrate status <id>');
            process.exit(2);
        }
        const row = coord.getMigration(id);
        if (!row) {
            console.error(`migration not found: ${id}`);
            process.exit(1);
        }
        console.log(JSON.stringify(row, null, 2));
        return Promise.resolve();
    } finally {
        store.close();
    }
}

async function runApply(args: string[]): Promise<void> {
    const specPath = args[0];
    if (!specPath) {
        console.error('usage: lore migrate apply <spec.json> [--db-path <sqlite-file>] [--auto]');
        process.exit(2);
    }
    if (!fs.existsSync(specPath)) {
        console.error(`spec file not found: ${specPath}`);
        process.exit(1);
    }
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as MigrationSpec;
    const auto = args.includes('--auto');
    const { coord, store } = openCoordinator();
    try {
        if (spec.substrate === 'sqlite') {
            const dbPath = readArg(args, '--db-path');
            if (!dbPath) {
                console.error('sqlite migrations require --db-path <sqlite-file>');
                process.exit(2);
            }
            registerSqliteAdapter(coord, dbPath);
        } else {
            console.error(`substrate '${spec.substrate}' requires daemon-side wiring; not yet exposed via the standalone CLI (H1.next). Use the in-process MigrationCoordinator API or wait for daemon-side integration.`);
            process.exit(2);
        }
        let row = await coord.apply(spec);
        console.log(JSON.stringify(row, null, 2));

        // H2 — if this is a destructive parent kind and --auto was set,
        // advance through migrate + contract without prompting.
        const destructive = new Set(['rename_column', 'change_type', 'drop_column']);
        if (auto && destructive.has(spec.kind)) {
            while (row.status === 'applied' && row.phase !== 'complete') {
                try {
                    row = await coord.advance(spec.id);
                    console.log(`[auto] advanced ${spec.id} → ${row.phase} (${row.status})`);
                } catch (err) {
                    console.error(`[auto] advance failed: ${(err as Error).message}`);
                    break;
                }
            }
            console.log(JSON.stringify(row, null, 2));
        }
    } finally {
        store.close();
    }
}

async function runAdvance(args: string[]): Promise<void> {
    const id = args[0];
    if (!id) {
        console.error('usage: lore migrate advance <id> [--db-path <sqlite-file>]');
        process.exit(2);
    }
    const { coord, store } = openCoordinator();
    try {
        const existing = coord.getMigration(id);
        if (!existing) {
            console.error(`migration not found: ${id}`);
            process.exit(1);
        }
        if (existing.substrate === 'sqlite') {
            const dbPath = readArg(args, '--db-path');
            if (!dbPath) {
                console.error('sqlite advance requires --db-path <sqlite-file>');
                process.exit(2);
            }
            registerSqliteAdapter(coord, dbPath);
        } else {
            console.error(`substrate '${existing.substrate}' advance requires daemon-side wiring`);
            process.exit(2);
        }
        const row = await coord.advance(id);
        console.log(JSON.stringify(row, null, 2));
    } finally {
        store.close();
    }
}

async function runRollback(args: string[]): Promise<void> {
    const id = args[0];
    if (!id) {
        console.error('usage: lore migrate rollback <id> [--db-path <sqlite-file>]');
        process.exit(2);
    }
    const { coord, store } = openCoordinator();
    try {
        const existing = coord.getMigration(id);
        if (!existing) {
            console.error(`migration not found: ${id}`);
            process.exit(1);
        }
        if (existing.substrate === 'sqlite') {
            const dbPath = readArg(args, '--db-path');
            if (!dbPath) {
                console.error('sqlite rollback requires --db-path <sqlite-file>');
                process.exit(2);
            }
            registerSqliteAdapter(coord, dbPath);
        } else {
            console.error(`substrate '${existing.substrate}' rollback requires daemon-side wiring`);
            process.exit(2);
        }
        const destructive = new Set(['rename_column', 'change_type', 'drop_column']);
        const row = destructive.has(existing.kind)
            ? await coord.rollbackPhase(id)
            : await coord.rollback(id);
        console.log(JSON.stringify(row, null, 2));
    } finally {
        store.close();
    }
}

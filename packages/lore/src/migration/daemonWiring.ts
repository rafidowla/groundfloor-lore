/**
 * migration/daemonWiring.ts — Sprint H4 daemon-side wiring.
 *
 * Bridges the substrate-agnostic MigrationCoordinator to the live
 * daemon's open handles:
 *
 *   - sqlite adapter binds to outbox.sqlite (the only schema-bearing
 *     sqlite the daemon owns at boot; load-jobs has its own file but
 *     migrations against it would land here too once needed)
 *   - lance adapter wraps VerbatimStore through a narrow shim; ops
 *     surface NOT-IMPLEMENTED until a real vectordb binding exposes
 *     add-field at runtime (matches H1 scope guard)
 *
 * No graph-substrate adapter: SurrealDB's node/edge tables are
 * SCHEMALESS by design (engines/surreal/surrealConnection.ts) — a node
 * gaining a field is a write, not a DDL event, so there is no ALTER-TABLE
 * ladder to migrate. The DDL adapter this file used to register here for
 * the former local graph engine (wrapping its Cypher bulk-connection for
 * DDL) was removed along with that engine (DEC-KUZU-REMOVAL-STEP1) —
 * it had no SurrealDB equivalent to build because the capability it
 * covered doesn't apply to a schemaless substrate.
 *
 * The coordinator itself is constructed AFTER outbox replicator wiring
 * so migration.* notifications flow through the live outbox + replicator
 * (audit Section 5 boot ordering).
 *
 * Shutdown order — coordinator stop is a no-op (it owns no background
 * loops; apply() / advance() are request-scoped); the migrations.sqlite
 * handle is closed via close(). Caller MUST call close() BEFORE stopping
 * the outbox replicator so any final migration.* notification recorded
 * during shutdown drains cleanly (same pattern as Sprint Z3 runner ↔
 * replicator coordination).
 */

import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { MigrationCoordinator, outboxNotifier } from './coordinator.js';
import { MigrationsStore } from './store.js';
import { SqliteMigrationAdapter } from './adapters/sqliteMigrationAdapter.js';
import { LanceMigrationAdapter, type LanceConnectionShim } from './adapters/lanceMigrationAdapter.js';
import type { OutboxStore } from '../outbox/types.js';
import type { VerbatimStore } from '../engines/verbatimStore.js';

export interface MigrationDaemonWiring {
    coordinator: MigrationCoordinator;
    store: MigrationsStore;
    /** Close handles. Call BEFORE outbox replicator.stop() per the
     *  shutdown order contract above. */
    close(): void;
}

export interface MigrationDaemonOptions {
    loreDir: string;
    outboxStore: OutboxStore;
    verbatim?: VerbatimStore;
}

/**
 * Build a LanceConnectionShim from VerbatimStore. The store does NOT
 * expose direct table-rebuild today; the shim surfaces stub methods
 * that throw "not-wired" so the coordinator records a clean
 * 'additive-not-supported' failure rather than crashing. Real wiring
 * lands when VerbatimStore (or a sibling lance handle) exposes
 * add-field / drop-column. Until then the daemon adapter still
 * registers so capabilities() returns the H1-shipped surface and the
 * coordinator can route lance specs to a deterministic failure.
 */
function buildLanceShim(_verbatim: VerbatimStore): LanceConnectionShim {
    const notWired = (op: string) => async (): Promise<never> => {
        throw new Error(`lance migration ${op} not yet wired in daemon (H4 scope guard — verbatim store lacks direct table-rebuild surface)`);
    };
    return {
        addField: notWired('addField') as unknown as (table: string, column: string) => Promise<void>,
        createTable: notWired('createTable') as unknown as (table: string, schema: string) => Promise<void>,
        dropTable: notWired('dropTable') as unknown as (table: string) => Promise<void>,
        createIndex: notWired('createIndex') as unknown as (table: string, indexName: string, columns: string) => Promise<void>,
        dropIndex: notWired('dropIndex') as unknown as (table: string, indexName: string) => Promise<void>,
    };
}

/**
 * Wire MigrationCoordinator + per-substrate adapters into the daemon's
 * live handles. Call AFTER outbox replicator construction and AFTER
 * graph.initialize() per the H1 boot ordering contract.
 */
export function wireMigrationCoordinator(opts: MigrationDaemonOptions): MigrationDaemonWiring {
    const store = new MigrationsStore(opts.loreDir);
    const coordinator = new MigrationCoordinator(store, outboxNotifier(opts.outboxStore));

    // sqlite adapter — binds to outbox.sqlite. The migrations file
    // itself is separate (per store.ts decision Section 5); operators
    // running migrations against load-jobs.sqlite or any other future
    // schema-bearing sqlite should pass --db-path via the CLI path.
    let sqliteDb: DatabaseType | null = null;
    try {
        const outboxPath = path.join(opts.loreDir, 'outbox.sqlite');
        sqliteDb = new Database(outboxPath);
        sqliteDb.pragma('journal_mode = WAL');
        coordinator.register(new SqliteMigrationAdapter(sqliteDb));
    } catch (err) {
        // Outbox file may not exist on a brand-new install before the
        // outbox store has run its first write. Skip — sqlite adapter
        // can be re-registered later via the CLI path.
        console.error(`[Lore MCP] migration sqlite adapter skipped: ${(err as Error).message}`);
    }

    // lance adapter — narrow shim, ops surface NOT-IMPLEMENTED until
    // VerbatimStore exposes add-field. Registered so capabilities()
    // is queryable from the operator surface.
    if (opts.verbatim) {
        coordinator.register(new LanceMigrationAdapter(buildLanceShim(opts.verbatim)));
    }

    return {
        coordinator,
        store,
        close(): void {
            try {
                if (sqliteDb) sqliteDb.close();
            } catch (_err) {
                // best-effort
            }
            try {
                store.close();
            } catch (_err) {
                // best-effort
            }
        },
    };
}

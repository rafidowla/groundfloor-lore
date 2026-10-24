/**
 * test/helpers/ingestionBackends.ts — the IIngestionStore contract rig.
 *
 * `ingestionBackends(tmpDir, label)` returns the stores a contract test runs
 * against: SQLite always; Postgres when LORE_PG_URL is set (dedicated `lore_gate`
 * database, workspace ids prefixed `pg-gate-ing-`), otherwise a printed skip
 * reason and no postgres backend (the caller still exits 0).
 *
 * `open()` hands back a store plus the workspace id its data lives under: the
 * SQLite file is single-use so it can reuse a short id; Postgres stores are bound
 * to one workspace, so each open() gets a unique one (cases run in parallel
 * against one database and never see each other).
 */
import * as path from 'node:path';
import type { Pool } from 'pg';
import type { IIngestionStore } from '../../packages/lore/src/ingestion/store.js';
import { SqliteIngestionStore } from '../../packages/lore/src/ingestion/sqliteStore.js';
import { closePostgresPool } from '../../packages/lore/src/engines/postgres/postgresClient.js';
import { PostgresIngestionStore } from '../../packages/lore/src/engines/postgres/postgresIngestionStore.js';
import { INGEST_TABLES } from '../../packages/lore/src/engines/postgres/postgresIngestionSchema.js';
import { createGatePool } from './testPostgres.js';

export const ING_WS_PREFIX = 'pg-gate-ing-';

export interface StoreHandle {
    store: IIngestionStore;
    /** The workspace id to use for every record in this handle. */
    ws: string;
    /** Close and reopen the same underlying data. */
    reopen(): Promise<IIngestionStore>;
}
export interface Backend {
    name: 'sqlite' | 'postgres';
    open(): Promise<StoreHandle>;
}
export interface Backends {
    list: Backend[];
    /** The pool when postgres is active (for direct row inspection), else null. */
    pool: Pool | null;
    /** Delete test rows (postgres) and close the pool. */
    dispose(): Promise<void>;
}

export async function ingestionBackends(tmpDir: string, label: string): Promise<Backends> {
    const rnd = () => Math.random().toString(36).slice(2, 10);
    const list: Backend[] = [{
        name: 'sqlite',
        async open() {
            const f = path.join(tmpDir, `s-${rnd()}.db`);
            return { store: new SqliteIngestionStore(f), ws: 'w', reopen: async () => new SqliteIngestionStore(f) };
        },
    }];
    const pool = await createGatePool(label);
    if (pool) {
        list.push({
            name: 'postgres',
            async open() {
                const ws = `${ING_WS_PREFIX}${rnd()}`;
                return { store: await PostgresIngestionStore.open(ws, pool), ws, reopen: () => PostgresIngestionStore.open(ws, pool) };
            },
        });
    }
    return {
        list, pool,
        async dispose() {
            if (!pool) return;
            for (const t of Object.values(INGEST_TABLES)) await pool.query(`DELETE FROM ${t} WHERE workspace_id LIKE $1`, [`${ING_WS_PREFIX}%`]);
            await closePostgresPool(pool);
        },
    };
}

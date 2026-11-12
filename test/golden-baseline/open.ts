/**
 * open.ts - open a fresh, isolated Lore (own data dir, and for Postgres its own database) with the two golden workspaces
 * registered, and tear it down again. One `Run` per workload execution.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from 'pg';
import { gateDbUrl, stampGateManifest } from '../helpers/testPostgres.js';
import { DetEmbedProvider, WS_A, WS_B } from './workload.js';

export type Engine = 'sqlite' | 'postgres';

export interface Run {
    lore: any;
    /** Per-run absolute dirs to scrub from output. */
    homes: string[];
    /** Per-run unique tokens (pg database name) -> stable placeholder. */
    tokens: Record<string, string>;
    close(): Promise<void>;
}

let seq = 0;

async function pgAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const u = new URL(gateDbUrl()!);
    u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
}

export async function openRun(engine: Engine): Promise<Run> {
    // The access tracker flushes every 60s from the first recall; a slow run would flip lastAccessedAt from null to <ts>.
    process.env['LORE_ACCESS_FLUSH_MS'] = '3600000';
    const { createLore } = await import('../../packages/lore/src/index.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-golden-${engine}-`));
    const provider = new DetEmbedProvider();
    const rmHome = (): void => fs.rmSync(home, { recursive: true, force: true });

    if (engine === 'sqlite') {
        let lore: any;
        try {
            lore = await createLore({ dataDir: home, deploymentMode: 'embedded', embeddingProvider: provider, modelServer: false } as never) as any;
            const { createWorkspace } = await import('../../packages/lore/src/config/workspaces.js');
            createWorkspace(WS_A, {}, lore.dataHome);
            createWorkspace(WS_B, {}, lore.dataHome);
        } catch (e) {
            try { await lore?.dispose(); } catch { /* keep the original error */ }
            rmHome();
            throw e;
        }
        return { lore, homes: [home], tokens: {}, close: async () => { try { await lore.dispose(); } finally { rmHome(); } } };
    }

    // Postgres: a database of its own per run (named by pid), dropped in close(). Rows are keyed by the PERMANENT workspace id.
    const dbName = `lore_golden_${process.pid}_${++seq}`;
    const adminUrl = new URL(gateDbUrl()!);
    const secrets: Record<string, string> = { [dbName]: '<pgdb>' };
    if (adminUrl.password) secrets[decodeURIComponent(adminUrl.password)] = '<pgpass>';
    const u = new URL(adminUrl.toString());
    u.pathname = `/${dbName}`;
    secrets[u.toString()] = '<pgurl>';
    const prev = { url: process.env['LORE_PG_URL'], home: process.env['LORE_HOME'], yield: process.env['LORE_LINK_REBUILD_YIELD_MS'] };
    const restoreEnv = (): void => {
        for (const [k, v] of Object.entries({ LORE_PG_URL: prev.url, LORE_HOME: prev.home, LORE_LINK_REBUILD_YIELD_MS: prev.yield })) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    };
    const dropDb = (): Promise<void> => pgAdmin(async (c) => { await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); });
    let lore: any;
    let created = false;
    try {
        await pgAdmin(async (c) => { await c.query(`CREATE DATABASE ${dbName}`); });
        created = true;
        process.env['LORE_PG_URL'] = u.toString();
        process.env['LORE_LINK_REBUILD_YIELD_MS'] = '0';
        // The run's own temp home (the fallback /tmp/lore-test-home-<pid> would be shared by both runs and never cleaned).
        process.env['LORE_HOME'] = home;
        const entries = [WS_A, WS_B].map((name) => {
            const p = path.join(home, 'workspaces', name);
            fs.mkdirSync(path.join(p, '.lore'), { recursive: true });
            stampGateManifest(p, provider.modelId, provider.dimension);
            return { name, id: `${name}-id`, path: p, graphEngine: 'postgres', vectorEngine: 'postgres', createdAt: '2026-01-01T00:00:00.000Z' };
        });
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ version: 1, active: WS_A, workspaces: entries }));
        lore = await createLore({ dataDir: home, deploymentMode: 'embedded', embeddingProvider: provider, modelServer: false } as never) as any;
    } catch (e) {
        try { await lore?.dispose(); } catch { /* keep the original error */ }
        try { if (created) await dropDb(); } catch { /* keep the original error */ }
        restoreEnv();
        rmHome();
        throw e;
    }
    return {
        lore, homes: [home], tokens: secrets,
        close: async () => {
            try { await lore.dispose(); } finally {
                try { await dropDb(); } finally { restoreEnv(); rmHome(); }
            }
        },
    };
}

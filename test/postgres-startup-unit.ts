/**
 * postgres-startup-unit.ts — startup behaviour of the Postgres engine:
 * operator-readable errors, no credential leaks, no engine fallback, and
 * race-free schema bootstrap.
 *
 * Offline cases (no database needed) always run. The concurrency cases need
 * `LORE_PG_URL` (a throwaway server with pgvector) and skip cleanly with a
 * printed reason when it is unset. They use their own throwaway database
 * (`lore_boot_<pid>`), dropped at the end.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from 'pg';

import { createPostgresPool, closePostgresPool, redactPgUrl } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { closeSharedPostgresPool, sharedPostgresPool } from '../packages/lore/src/engines/postgres/postgresPoolOwner.js';
import {
    PostgresStartupError, explainPostgresStartupError, runSchemaBootstrap,
} from '../packages/lore/src/engines/postgres/postgresStartup.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { stampGateManifest } from './helpers/testPostgres.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ok  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

const SECRET = 'sup3r-secret-pw';
const originalUrl = process.env['LORE_PG_URL'];

/** A scripted pool: connect() hands back a client whose query() answers from `script`. */
function fakePool(script: (sql: string) => { rows: unknown[] }): never {
    const client = {
        query: async (sql: string) => script(sql),
        release: () => undefined,
    };
    return { connect: async () => client } as never;
}

console.log('postgres startup');

await test('no LORE_PG_URL: the shared pool refuses loudly, naming the env var', async () => {
    delete process.env['LORE_PG_URL'];
    await closeSharedPostgresPool();
    assert.throws(() => sharedPostgresPool(), /LORE_PG_URL/);
});

await test('unreachable server: PostgresStartupError names the redacted target and never the password', async () => {
    const url = `postgres://lore:${SECRET}@127.0.0.1:1/nodb`;
    process.env['LORE_PG_URL'] = url;
    const pool = createPostgresPool({ url });
    try {
        await runSchemaBootstrap(pool, {}, async () => undefined);
        assert.fail('expected a startup error');
    } catch (err) {
        assert.ok(err instanceof PostgresStartupError, `got ${(err as Error).name}`);
        assert.match(err.message, /127\.0\.0\.1:1/);
        assert.match(err.message, /server running/);
        assert.ok(!err.message.includes(SECRET), 'password leaked into the message');
    } finally {
        await closePostgresPool(pool);
    }
});

await test('error mapping: auth, missing database, privilege, unknown', async () => {
    process.env['LORE_PG_URL'] = `postgres://lore:${SECRET}@db.internal:5432/lore`;
    const mk = (code: string, message = 'raw') => Object.assign(new Error(message), { code });
    assert.match(explainPostgresStartupError(mk('28P01')).message, /rejected the credentials/);
    assert.match(explainPostgresStartupError(mk('3D000')).message, /does not exist/);
    assert.match(explainPostgresStartupError(mk('42501')).message, /lacks a privilege/);
    assert.match(explainPostgresStartupError(mk('ENOTFOUND')).message, /cannot reach Postgres at postgres:\/\/db\.internal:5432\/lore/);
    const unknown = explainPostgresStartupError(new Error('weird failure'));
    assert.match(unknown.message, /weird failure/);
    for (const code of ['28P01', '3D000', '42501', 'ENOTFOUND']) {
        assert.ok(!explainPostgresStartupError(mk(code)).message.includes(SECRET));
    }
    const already = new PostgresStartupError('x');
    assert.equal(explainPostgresStartupError(already), already, 'already-explained errors pass through');
});

await test('old server version is refused with the supported minimum', async () => {
    for (const v of ['130012', '140010']) {
        const pool = fakePool((sql) => (/server_version_num/.test(sql) ? { rows: [{ v }] } : { rows: [] }));
        await assert.rejects(runSchemaBootstrap(pool, {}, async () => undefined), (err: Error) =>
            /PostgreSQL 15 or newer/.test(err.message) && /Upgrade the server/.test(err.message) && /Nothing was changed/.test(err.message));
    }
    const ok = fakePool((sql) => (/server_version_num/.test(sql) ? { rows: [{ v: '150000' }] } : { rows: [] }));
    await runSchemaBootstrap(ok, {}, async () => undefined); // 15.0 is accepted
});

await test('missing pgvector is refused with an install hint (graph-only bootstrap does not need it)', async () => {
    const script = (sql: string): { rows: unknown[] } => {
        if (/server_version_num/.test(sql)) return { rows: [{ v: '160000' }] };
        if (/pg_available_extensions/.test(sql)) return { rows: [{ installed: null, available: null }] };
        return { rows: [] };
    };
    await assert.rejects(runSchemaBootstrap(fakePool(script), { requirePgvector: true }, async () => undefined), /pgvector extension is not installed/);
    assert.equal(await runSchemaBootstrap(fakePool(script), {}, async () => 'graph-ok'), 'graph-ok');
});

await test('pgvector too old is refused', async () => {
    const script = (sql: string): { rows: unknown[] } => {
        if (/server_version_num/.test(sql)) return { rows: [{ v: '160000' }] };
        if (/pg_available_extensions/.test(sql)) return { rows: [{ installed: '0.4.4', available: '0.8.0' }] };
        return { rows: [] };
    };
    await assert.rejects(runSchemaBootstrap(fakePool(script), { requirePgvector: true }, async () => undefined), /too old/);
});

await test('pgvector 0.7.x (no iterative scans) is refused with upgrade steps; 0.8.0 is accepted', async () => {
    const withVersion = (installed: string) => (sql: string): { rows: unknown[] } => {
        if (/server_version_num/.test(sql)) return { rows: [{ v: '160000' }] };
        if (/pg_available_extensions/.test(sql)) return { rows: [{ installed, available: installed }] };
        return { rows: [] };
    };
    await assert.rejects(
        runSchemaBootstrap(fakePool(withVersion('0.7.4')), { requirePgvector: true }, async () => undefined),
        (e: Error) => /too old/.test(e.message) && /0\.8\.0/.test(e.message) && /ALTER EXTENSION vector UPDATE/.test(e.message) && /pgvector\/pgvector/.test(e.message),
    );
    assert.equal(await runSchemaBootstrap(fakePool(withVersion('0.8.0')), { requirePgvector: true }, async () => 'ok-0.8.0'), 'ok-0.8.0');
    assert.equal(await runSchemaBootstrap(fakePool(withVersion('0.8.5')), { requirePgvector: true }, async () => 'ok-0.8.5'), 'ok-0.8.5');
});

await test("the DDL callback's own deliberate error keeps its exact message", async () => {
    const script = (sql: string): { rows: unknown[] } => (/server_version_num/.test(sql) ? { rows: [{ v: '160000' }] } : { rows: [] });
    await assert.rejects(
        runSchemaBootstrap(fakePool(script), {}, async () => { throw new Error('dimension mismatch: stored 4, wanted 8'); }),
        (e: Error) => e.message === 'dimension mismatch: stored 4, wanted 8' && !(e instanceof PostgresStartupError),
    );
});

// ---- live-server cases -------------------------------------------------------
if (!originalUrl || originalUrl.trim() === '') {
    console.log('  SKIP concurrent bootstrap: LORE_PG_URL is not set — live-server cases skipped cleanly');
} else {
    const adminUrl = new URL(originalUrl);
    adminUrl.pathname = '/postgres';
    const dbName = `lore_boot_${process.pid}`;
    const bootUrl = new URL(originalUrl);
    bootUrl.pathname = `/${dbName}`;
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    console.log(`  pg   concurrent bootstrap on ${redactPgUrl(bootUrl.toString())} (throwaway database)`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-pg-boot-'));
    const embedder: EmbeddingProvider = {
        modelId: 'pg-boot-fixed', dimension: 4,
        async initialize() { /* fixed vectors: nothing to load */ },
        async embed() { return [0, 0, 0, 1]; },
        async embedBatch(texts: string[]) { return texts.map(() => [0, 0, 0, 1]); },
    } as unknown as EmbeddingProvider;
    try {
        await test('a fresh database bootstrapped by 8 concurrent openers (graph + verbatim) all succeed', async () => {
            const pool = createPostgresPool({ url: bootUrl.toString(), max: 16 });
            try {
                const stores: Promise<void>[] = [];
                for (let i = 0; i < 4; i++) {
                    stores.push(new PostgresGraph(`pg-boot-g${i}`, pool).initialize());
                    const base = path.join(dir, `v${i}`);
                    fs.mkdirSync(base, { recursive: true });
                    stampGateManifest(base, 'pg-boot-fixed', 4);
                    stores.push(new PostgresVerbatimStore(base, pool, `pg-boot-v${i}`, embedder).initialize());
                }
                await Promise.all(stores);
                const probe = await pool.query(
                    `SELECT (SELECT count(*) FROM pg_extension WHERE extname='vector')::int AS ext,
                            (SELECT count(*) FROM pg_stat_activity WHERE application_name='lore' AND state='idle in transaction')::int AS stuck`,
                );
                assert.equal(probe.rows[0].ext, 1);
                assert.equal(probe.rows[0].stuck, 0, 'no bootstrap transaction left open');
                const lockRows = await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'`);
                assert.equal(lockRows.rows[0].n, 0, 'the schema advisory lock is released');
            } finally {
                await closePostgresPool(pool);
            }
        });

        await test('re-running the bootstrap on an existing schema is a no-op', async () => {
            const pool = createPostgresPool({ url: bootUrl.toString() });
            try {
                await new PostgresGraph('pg-boot-again', pool).initialize();
                await new PostgresGraph('pg-boot-again', pool).initialize();
            } finally {
                await closePostgresPool(pool);
            }
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.end();
    }
}

if (originalUrl === undefined) delete process.env['LORE_PG_URL']; else process.env['LORE_PG_URL'] = originalUrl;
await closeSharedPostgresPool();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

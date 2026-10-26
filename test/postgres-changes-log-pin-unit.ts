#!/usr/bin/env tsx
/**
 * test/postgres-changes-log-pin-unit.ts - PINS the current behaviour of `verbatim_changes_log` on Postgres:
 * the table exists, and nothing populates it or reads it. Finding (2026-10-23): the only consumer in the product is
 * the SQLite -> LanceDB promotion tail copy (engines/verbatimPromotionStage.ts copyTail), which reads a
 * better-sqlite3 file by rowid and writes LanceDB. It is not engine-agnostic and a Postgres workspace is never
 * promoted, so adding write-path recording on Postgres would cost every write and serve no reader. See
 * docs/CONFIGURATION.md "verbatim_changes_log is not written on Postgres".
 *
 * If this test fails you have added a consumer or a producer. That may be right - but then read the finding first,
 * wire BOTH sides (producer on the write path, consumer, and the bounded-growth/prune story for the table) and
 * update this pin on purpose.
 *
 *   producers    real store writes (store, batch upsert, tombstone, delete, physical delete) add zero log rows;
 *                the verbatim table carries no trigger other than the tsvector one
 *   consumers    the only source files that mention the table are the SQLite promotion code, the Postgres DDL
 *                that creates it and the compact() VACUUM
 *
 * Run: LORE_PG_URL=postgres://... npx tsx test/postgres-changes-log-pin-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgresVerbatimStore } from '../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { createGatePool, cleanupGateWorkspaces, closeGatePool, stampGateManifest } from './helpers/testPostgres.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '../packages/lore/src');

console.log('\nverbatim_changes_log pin');

// ---------------------------------------------------------------- consumers (no database needed)
/** Every .ts under src/ whose text names the table. */
function filesMentioningLog(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) filesMentioningLog(p, out);
        else if (e.name.endsWith('.ts') && fs.readFileSync(p, 'utf-8').includes('verbatim_changes_log')) out.push(path.relative(srcRoot, p).split(path.sep).join('/'));
    }
    return out;
}
await test('consumers: only the SQLite promotion code reads or writes the log; Postgres only creates and vacuums the table', () => {
    assert.deepEqual(filesMentioningLog(srcRoot).sort(), [
        'engines/postgres/postgresVerbatimSchema.ts',   // CREATE TABLE only
        'engines/postgres/postgresVerbatimStore.ts',    // VACUUM ANALYZE in compact()
        'engines/postgres/postgresWorkspaceErase.ts',   // named in the erase skip list only (no workspace column, nothing to erase)
        'engines/sqliteVerbatimSchema.ts',              // SQLite table create / drop
        'engines/verbatimPromotionGate.ts',             // lock-aware gate: reads MAX(seq) / unseen-row count on the SQLite file (3.35.3)
        'engines/verbatimPromotionStage.ts',            // copyTail: THE consumer (better-sqlite3 rowid -> LanceDB)
        'engines/verbatimPromotionState.ts',            // SQLite triggers, installed only while a promotion is staging
    ]);
});
await test('consumers: the promotion consumer is bound to a SQLite file, not to a Postgres pool', () => {
    const stage = fs.readFileSync(path.join(srcRoot, 'engines/verbatimPromotionStage.ts'), 'utf-8');
    assert.match(stage, /better-sqlite3/);
    assert.match(stage, /rowid/);
    assert.ok(!/from 'pg'|postgres/i.test(stage), 'copyTail must not know about Postgres; if it now does, revisit the finding');
});
await test('consumers: the promotion gate reads the log through a better-sqlite3 handle, not a Postgres pool', () => {
    const gate = fs.readFileSync(path.join(srcRoot, 'engines/verbatimPromotionGate.ts'), 'utf-8');
    assert.match(gate, /better-sqlite3/);
    assert.ok(!/from 'pg'|postgres/i.test(gate), 'the promotion gate must not know about Postgres; if it now does, revisit the finding');
});

// ---------------------------------------------------------------- producers (needs Postgres)
const pool = await createGatePool('postgres-changes-log-pin');
if (!pool) {
    console.log(`\n${passed} passed, ${failed} failed (postgres cases skipped)`);
    process.exit(failed === 0 ? 0 : 1);
}
await cleanupGateWorkspaces(pool);

const DIM = 4;
class FixedEmbed implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'pg-changes-log-pin'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embed(): Promise<number[]> { return [1, 0, 0, 0]; }
    async embedQuery(): Promise<number[]> { return [1, 0, 0, 0]; }
    async embedDocument(): Promise<number[]> { return [1, 0, 0, 0]; }
}
const dirs: string[] = [];
const q = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
const logRows = async (): Promise<number> => Number((await q<{ n: string }>('SELECT count(*) AS n FROM verbatim_changes_log'))[0]!.n);
const row = (id: string, x: number) => ({
    id, label: id, text: `text ${id}`, type: 'note', project: 'p', ecosystem: '*', security_scopes: [],
    vector: [Math.cos(x), Math.sin(x), 0, 0], contentHash: `h-${id}`, updatedAt: '2026-10-23T00:00:00.000Z',
});
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-clpin-'));
dirs.push(base);
stampGateManifest(base, 'pg-changes-log-pin', DIM);
const store = new PostgresVerbatimStore(base, pool, 'pg-gate-clpin', new FixedEmbed());
await store.initialize();

await test('the table exists after initialize (schemaIsCurrent requires it) and carries no workspace column', async () => {
    assert.equal((await q<{ t: string | null }>(`SELECT to_regclass('verbatim_changes_log') AS t`))[0]!.t, 'verbatim_changes_log');
    const cols = (await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'verbatim_changes_log' ORDER BY ordinal_position`)).map((c) => c.column_name);
    assert.deepEqual(cols, ['seq', 'row_rowid', 'row_id', 'is_canonical', 'op', 'at']);
});
await test('verbatim has no trigger besides the tsvector one (nothing records changes)', async () => {
    const trg = await q<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass('verbatim') AND NOT tgisinternal ORDER BY 1`);
    assert.deepEqual(trg.map((t) => t.tgname), ['verbatim_text_tsv_biur']);
});
await test('every write path leaves the log untouched: store, batch, upsert, tombstone, delete, physical delete', async () => {
    const before = await logRows();
    await store.bulkAddPrebuiltRows([row('lore:a', 0), row('lore:b', 1), row('lore:c', 2), row('lore:d', 3)]);
    await store.bulkUpsertPrebuiltRows([row('lore:a', 0.5)]);
    await store.store({ id: 'lore:e', text: 'text e', metadata: { type: 'note', label: 'e', project: 'p' } });
    await store.tombstone('lore:b', 'pin test');
    await store.delete('lore:c');
    await store.physicalDelete('lore:d');
    assert.ok((await store.count()) > 0, 'writes did land');
    assert.equal(await logRows(), before, 'a producer was added: read the finding in docs/CONFIGURATION.md before changing this');
});

await cleanupGateWorkspaces(pool);
await closeGatePool(pool);
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env tsx
/**
 * sp05-injection-unit.ts — SP-05 substrate query-injection regressions.
 *
 * Proves the four injection vectors closed by sprint SP-05 are neutralised:
 *
 *   1. Filter KEYS (column names) are run through an identifier allowlist
 *      in buildWhereClause. A malicious key like
 *      `id) DELETE n; --` throws instead of being interpolated raw — this
 *      is the worst vector (mass-delete via the DELETE path). Covered on
 *      the sqlite backend, across query/update/delete.
 *      Also covers CREATE TABLE column-name validation.
 *
 *   2. VerbatimStore.search() metadata filter VALUES are escaped + KEYS
 *      allowlisted. A value `a' OR '1'='1` cannot break out of the LanceDB
 *      WHERE literal (no clause injection: a row that doesn't match the
 *      literal stays excluded), and an unknown key is dropped, not injected.
 *
 *   3. verbatimHistory.listIds escapes LIKE wildcards (% _ \) + appends
 *      ESCAPE. A prefix of `%` matches NO ids literally (rather than every
 *      id), proving the wildcard is neutralised.
 *
 * Fast + deterministic: sqlite runs against a real on-disk DB (cheap);
 * the verbatim cases use a tiny constant-vector embedding provider so no
 * model loads.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import * as verbatimHistory from '../packages/lore/src/engines/verbatimHistory.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/** A malicious filter KEY that, if interpolated raw, would close the
 *  WHERE clause and append a destructive statement (mass delete). */
const EVIL_KEY = 'id) DELETE n; --';
/** A malicious metadata filter VALUE — classic SQL-style breakout. */
const EVIL_VALUE = "a' OR '1'='1";

const SCHEMA: TableSchema = {
    name: 'tenant',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string' },
    ],
};

/* ─────────────────────────── SQLite backend ─────────────────────────── */

function mkSqliteTmp(): { dbPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp05-sqlite-'));
    return {
        dbPath: path.join(dir, 'tables.sqlite'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

test('sqlite: malicious filter KEY in delete() throws (no mass-delete)', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(SCHEMA);
        await s.insert('tenant', { id: 't1', name: 'Alice' });
        await s.insert('tenant', { id: 't2', name: 'Bob' });

        await assert.rejects(
            () => s.delete('tenant', { eq: { [EVIL_KEY]: 'x' } } as never),
            /invalid identifier/,
            'malicious filter key must be rejected, not interpolated',
        );
        // Rows survived — the injected DELETE never ran.
        assert.equal(await s.count('tenant'), 2, 'rows must be untouched after a rejected injection');
        s.close();
    } finally { t.cleanup(); }
});

test('sqlite: malicious filter KEY in query() throws', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(SCHEMA);
        await assert.rejects(
            () => s.query('tenant', { eq: { [EVIL_KEY]: 'x' } } as never),
            /invalid identifier/,
        );
        s.close();
    } finally { t.cleanup(); }
});

test('sqlite: malicious filter KEY in update() throws', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(SCHEMA);
        await s.insert('tenant', { id: 't1', name: 'Alice' });
        await assert.rejects(
            () => s.update('tenant', { eq: { [EVIL_KEY]: 'x' } } as never, { name: 'pwn' }),
            /invalid identifier/,
        );
        // Patch never applied.
        const row = await s.getByKey('tenant', 't1');
        assert.equal((row as { name?: string })?.name, 'Alice');
        s.close();
    } finally { t.cleanup(); }
});

test('sqlite: legitimate filter KEY still works (allowlist not over-broad)', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(SCHEMA);
        await s.insert('tenant', { id: 't1', name: 'Alice' });
        await s.insert('tenant', { id: 't2', name: 'Bob' });
        const rows = await s.query('tenant', { eq: { name: 'Alice' } });
        assert.equal(rows.length, 1);
        assert.equal((rows[0] as { id: string }).id, 't1');
        s.close();
    } finally { t.cleanup(); }
});

test('sqlite: CREATE TABLE rejects a malicious column name', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await assert.rejects(
            () => s.createTable({
                name: 'evil',
                columns: [
                    { name: 'id', type: 'string', primary: true },
                    { name: 'x); DROP TABLE tenant; --', type: 'string' },
                ],
            }),
            /invalid identifier/,
        );
        s.close();
    } finally { t.cleanup(); }
});

/* ───────────────────── VerbatimStore search filter ──────────────────── */

/** Constant-vector embedder: avoids loading a real model. All documents +
 *  queries map to the same vector, so vectorSearch returns rows ordered
 *  only by the WHERE filter — exactly what we want to probe injection. */
class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'sp05-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

test('verbatim: malicious filter VALUE cannot inject WHERE clause', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp05-verbatim-'));
    const store = new VerbatimStore(tmp, new ConstEmbedProvider());
    try {
        await store.initialize();
        // Two rows in distinct projects. Neither project equals EVIL_VALUE.
        await store.store({
            id: 'v1', text: 'alpha', metadata: {
                type: 'note', label: 'A', tags: '', project: 'projA',
                ecosystem: '', updatedAt: '', security_scopes: [],
            },
        });
        await store.store({
            id: 'v2', text: 'bravo', metadata: {
                type: 'note', label: 'B', tags: '', project: 'projB',
                ecosystem: '', updatedAt: '', security_scopes: [],
            },
        });

        // If the value broke out of the literal (… OR '1'='1'), the filter
        // would match BOTH rows. Properly escaped, it matches NEITHER
        // (no project equals the literal string EVIL_VALUE).
        const injected = await store.search('alpha', 10, { project: EVIL_VALUE } as never);
        assert.equal(injected.length, 0, 'escaped value must match no rows, not all rows');

        // Sanity: a legitimate value still filters correctly.
        const legit = await store.search('alpha', 10, { project: 'projA' });
        assert.ok(legit.every(r => r.metadata.project === 'projA'),
            'legitimate project filter must still scope results');
        assert.ok(legit.length >= 1, 'legitimate filter must return the matching row');

        // An unknown filter key is dropped (allowlist), not injected.
        const unknownKey = await store.search('alpha', 10, { 'id = 1 OR 1=1 --': 'x' } as never);
        // Drops the bad key → behaves like no filter → returns rows.
        assert.ok(unknownKey.length >= 1, 'unknown filter key must be ignored, not crash/inject');
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
});

/* ───────────────────── verbatimHistory.listIds LIKE ─────────────────── */

test('verbatim: listIds prefix LIKE wildcards are escaped (literal match)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp05-listids-'));
    const store = new VerbatimStore(tmp, new ConstEmbedProvider());
    try {
        await store.initialize();
        for (const id of ['lore:1', 'lore:2', 'other:3']) {
            await store.store({
                id, text: id, metadata: {
                    type: 'note', label: id, tags: '', project: 'p',
                    ecosystem: '', updatedAt: '', security_scopes: [],
                },
            });
        }
        // Legit prefix scopes correctly.
        const lore = await store.listIds('lore:');
        assert.equal(lore.filter(id => !id.includes('#rev')).sort().join(','), 'lore:1,lore:2');

        // A bare '%' must be treated literally: NO id literally starts with
        // a percent sign, so the result is empty. Pre-fix it would have
        // matched every id (wildcard).
        const pct = await store.listIds('%');
        assert.equal(pct.length, 0, "'%' prefix must match literally (no wildcard expansion)");

        // '_' likewise literal — matches nothing.
        const underscore = await store.listIds('_');
        assert.equal(underscore.length, 0, "'_' prefix must match literally");
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
});

console.log('\n=== SP-05 substrate injection regressions ===\n');
await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
// Force a clean exit rather than wait on native-handle (LanceDB via
// VerbatimStore) GC teardown.
process.exit(failed > 0 ? 1 : 0);

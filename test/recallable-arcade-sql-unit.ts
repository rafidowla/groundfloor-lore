#!/usr/bin/env tsx
/**
 * test/recallable-arcade-sql-unit.ts - 3.34.0 slice 3b (N5): the ArcadeDB index self-check SQL.
 *
 * Regression for a dialect bug found on a REAL ArcadeDB 26.7.1: the first draft passed the bare
 * scalar subquery `(SELECT embedding ... WHERE id = :id)` as the query vector. A subquery evaluates to a
 * LIST of rows, and 26.7.1 answers HTTP 500 "Unsupported query vector type: Object[]" - so every
 * self-check silently took the slower fallback. The statement must index the first row:
 * `(...)[0].embedding`. Fake transport (the live proof is in the PR), so this pins the statement text,
 * the projected shape, the fallback, and the query count.
 *
 * Run: npx tsx test/recallable-arcade-sql-unit.ts
 */
import assert from 'node:assert/strict';
import { buildSelfNeighborsSql } from '../packages/lore/src/engines/arcade/arcadeRecallProjection.js';
import { ArcadeVectorStore } from '../packages/lore/src/engines/arcade/arcadeVectorStore.js';
import { ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const embedder = { dimension: 2, modelId: 'fake', async initialize() { /* noop */ }, async embed() { return [1, 0]; }, async embedQuery() { return [1, 0]; }, async embedDocument() { return [1, 0]; } };

interface Call { sql: string; params: Record<string, unknown> }
/** Fake ArcadeDB: `present` rows exist; `indexed` rows come back from their own self-neighbors query. */
function fakeHttp(opts: { present: string[]; indexed: string[]; rejectSubquery?: boolean }) {
    const calls: Call[] = [];
    return {
        calls,
        async query(_db: string, sql: string, params: Record<string, unknown> = {}) {
            calls.push({ sql, params });
            if (/FROM LoreVerbatim WHERE id IN :ids/.test(sql)) {
                return { result: (params['ids'] as string[]).filter((i) => opts.present.includes(i)).map((id) => ({ id })) };
            }
            if (sql.includes('vector.neighbors') && sql.includes('(SELECT embedding FROM')) {
                if (opts.rejectSubquery) throw new ArcadeHttpError(500, 'Unsupported query vector type: Object[]');
                const id = params['id'] as string;
                return { result: opts.indexed.includes(id) ? [{ id, distance: 0 }] : [] };
            }
            if (/SELECT embedding FROM LoreVerbatim WHERE id = :id LIMIT 1/.test(sql)) {
                return { result: [{ embedding: [1, 0], __id: params['id'] }] };
            }
            if (sql.includes('vector.neighbors') && params['vec']) {
                // fallback statement: answer for the one id the previous embedding read named
                const last = [...calls].reverse().find((c) => /SELECT embedding FROM LoreVerbatim WHERE id = :id LIMIT 1/.test(c.sql));
                const id = last!.params['id'] as string;
                return { result: opts.indexed.includes(id) ? [{ id, distance: 0 }] : [] };
            }
            return { result: [] };
        },
        async command() { return { result: [] }; },
    };
}
const mk = (http: ReturnType<typeof fakeHttp>) => {
    const s = new ArcadeVectorStore({ tenantDb: 'db', http: http as never, embedder: embedder as never });
    (s as unknown as { schemaReady: boolean }).schemaReady = true; // skip schema DDL; only the read path is under test
    return s;
};

console.log('self-check statement');
await test('indexes the subquery result: `(...)[0].embedding` (a bare subquery is a LIST => HTTP 500 on 26.7.1)', () => {
    const sql = buildSelfNeighborsSql('LoreVerbatim');
    assert.ok(sql.includes('WHERE id = :id)[0].embedding'), sql);
    assert.ok(!/WHERE id = :id\), :k/.test(sql), 'the broken bare-subquery form is gone');
});
await test('projected: id + distance only, never the embedding column; params are :id / :k only (:after is reserved)', () => {
    const sql = buildSelfNeighborsSql('LoreVerbatim');
    assert.ok(sql.startsWith('SELECT id, distance FROM (SELECT expand(vector.neighbors('));
    assert.ok(!/SELECT [^()]*embedding[^()]* FROM \(SELECT expand/.test(sql));
    assert.ok(!sql.includes(':after'));
    assert.deepEqual([...sql.matchAll(/:(\w+)/g)].map((m) => m[1]).sort(), ['id', 'k']);
});

console.log('\nindexedIds against a fake ArcadeDB');
await test('one existence query for the batch, one self-check per EXISTING row; missing ids cost nothing more', async () => {
    const http = fakeHttp({ present: ['lore:a', 'lore:b'], indexed: ['lore:a'] });
    const got = await mk(http).indexedIds(['lore:a', 'lore:b', 'lore:gone']);
    assert.deepEqual([...got], ['lore:a'], 'b exists but the index does not answer it yet => not indexed');
    assert.equal(http.calls.length, 1 + 2, 'existence + 2 self-checks (not 3)');
    assert.equal(http.calls[0]!.params['ids'] instanceof Array, true);
    for (const c of http.calls.slice(1)) assert.equal(typeof c.params['k'], 'number', 'k bound as a param');
    assert.ok(http.calls.slice(1).every((c) => c.sql.includes('[0].embedding')));
});
await test('a server rejection of the subquery form falls back to the client-side vector, same answer', async () => {
    const http = fakeHttp({ present: ['lore:a', 'lore:b'], indexed: ['lore:a'], rejectSubquery: true });
    const got = await mk(http).indexedIds(['lore:a', 'lore:b']);
    assert.deepEqual([...got], ['lore:a']);
    assert.ok(http.calls.some((c) => c.params['vec'] !== undefined), 'fallback statement used');
});
await test('a transport failure (not an ArcadeDB answer) surfaces instead of being swallowed as "not indexed"', async () => {
    const http = fakeHttp({ present: ['lore:a'], indexed: ['lore:a'] });
    const orig = http.query.bind(http);
    http.query = async (db: string, sql: string, p?: Record<string, unknown>) => {
        if (sql.includes('vector.neighbors')) throw new Error('ECONNRESET');
        return orig(db, sql, p);
    };
    await assert.rejects(() => mk(http).indexedIds(['lore:a']), /ECONNRESET/);
});
await test('empty list is free; more than 1000 ids is refused', async () => {
    const http = fakeHttp({ present: [], indexed: [] });
    assert.equal((await mk(http).indexedIds([])).size, 0);
    assert.equal(http.calls.length, 0);
    await assert.rejects(() => mk(http).indexedIds(Array.from({ length: 1001 }, (_, i) => `lore:${i}`)), /at most 1000/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

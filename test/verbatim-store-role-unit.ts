#!/usr/bin/env tsx
/**
 * test/verbatim-store-role-unit.ts — LORE-ASK-VECTOR-STORE-ROLE.md.
 *
 * Locks the contract for VerbatimStore's optional `opts.role`
 * ('read' | 'write' | 'both', default 'both'):
 *
 *   1. role:'write' opens exactly 2 LanceDB handles (connection + write
 *      table, no read pool), storeBatch() succeeds, and search() serves
 *      from the single write handle instead of throwing.
 *   2. role:'read' opens the pool (17 handles at the default pool size —
 *      connection + pool, no write table), search() finds data written by
 *      another store, and every mutating call throws a named
 *      VerbatimStoreRoleError.
 *   3. Default (no opts, or a bare 2-arg constructor call — the pre-existing
 *      call shape every current caller uses) is byte-identical to today:
 *      18 handles at the default pool size once the read pool has warmed.
 *
 * Uses a tiny constant-vector embedding provider (no ONNX/model download)
 * so the test runs in well under a second.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { VerbatimStoreRoleError } from '../packages/lore/src/engines/verbatimStoreRole.js';
import { DEFAULT_LANCE_POOL_SIZE } from '../packages/lore/src/engines/lanceTablePool.js';
import type { EmbeddingProvider, VerbatimDocument } from '../packages/lore/src/providers/types.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'role-unit-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-role-test-'));
}

function doc(id: string, text: string): VerbatimDocument {
    return { id, text, metadata: {} } as VerbatimDocument;
}

let pass = 0;
let fail = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        fail++;
        failures.push(`${name}: ${(err as Error).stack ?? (err as Error).message}`);
        console.log(`  ✗ ${name}: ${(err as Error).message}`);
    }
}

console.log('verbatim-store-role-unit\n');
console.log(`  (default pool size: ${DEFAULT_LANCE_POOL_SIZE})`);

await test("role:'write' opens exactly 2 handles; storeBatch succeeds; search falls back (no throw)", async () => {
    const base = mkTmp();
    const store = new VerbatimStore(base, new ConstEmbedProvider(), { role: 'write' });
    await store.initialize();
    // Fresh workspace — no on-disk table yet, so only the connection is
    // open (matches pre-feature behaviour for any role on a fresh install).
    assert.equal(store.handleCount(), 1, `expected 1 handle before any write, got ${store.handleCount()}`);

    await store.storeBatch([doc('a', 'hello world'), doc('b', 'goodbye world')]);
    assert.equal(store.handleCount(), 2, `expected 2 handles (connection + write table, no pool) for role:'write' after the first write, got ${store.handleCount()}`);

    // Intercept stderr to confirm the one-time fallback log fires exactly
    // once across two search() calls, not per-call.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    (process.stderr.write as unknown) = (chunk: unknown, ...rest: unknown[]) => {
        lines.push(String(chunk));
        return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    try {
        const r1 = await store.search('hello', 5);
        const r2 = await store.search('goodbye', 5);
        assert.ok(r1.length >= 1, 'expected at least one hit for "hello" on a write-role store');
        assert.ok(r2.length >= 1, 'expected at least one hit for "goodbye" on a write-role store');
    } finally {
        process.stderr.write = originalWrite;
    }
    const fallbackLines = lines.filter((l) => l.includes('role=write store has no read pool'));
    assert.equal(fallbackLines.length, 1, `expected the fallback log exactly once, got ${fallbackLines.length}`);

    await store.close();
});

await test("role:'read' opens the pool (no write table); search sees another store's writes; writes throw VerbatimStoreRoleError", async () => {
    const base = mkTmp();
    // Populate via a normal (default-role) writer, then close it so the
    // reader below is the only thing holding the on-disk table.
    const writer = new VerbatimStore(base, new ConstEmbedProvider());
    await writer.initialize();
    await writer.storeBatch([doc('x', 'apples and oranges'), doc('y', 'bananas and grapes')]);
    await writer.close();

    const reader = new VerbatimStore(base, new ConstEmbedProvider(), { role: 'read' });
    await reader.initialize();
    assert.equal(
        reader.handleCount(),
        1 + DEFAULT_LANCE_POOL_SIZE,
        `expected 1 (connection) + ${DEFAULT_LANCE_POOL_SIZE} (pool) handles for role:'read', got ${reader.handleCount()}`,
    );

    const hits = await reader.search('apples', 5);
    assert.ok(hits.length >= 1, 'expected role:read search to find data written by another store');

    await assert.rejects(
        () => reader.store(doc('z', 'new row')),
        (err: unknown) => err instanceof VerbatimStoreRoleError && err.operation === 'store',
        'store() on a role:read store must throw VerbatimStoreRoleError',
    );
    await assert.rejects(
        () => reader.storeBatch([doc('z', 'new row')]),
        (err: unknown) => err instanceof VerbatimStoreRoleError,
        'storeBatch() on a role:read store must throw VerbatimStoreRoleError',
    );
    await assert.rejects(
        () => reader.tombstone('x', 'test'),
        (err: unknown) => err instanceof VerbatimStoreRoleError,
        'tombstone() on a role:read store must throw VerbatimStoreRoleError',
    );

    await reader.close();
});

await test("default role (omitted opts, or a bare 2-arg constructor call) matches today's 'both' behaviour: 18 handles once warmed", async () => {
    const base = mkTmp();
    // Exactly the call shape every existing caller in the codebase uses
    // today (services.ts, workspaceVerbatimResolver.ts pre-this-branch).
    const store = new VerbatimStore(base, new ConstEmbedProvider());
    await store.initialize();
    // Fresh install: no table yet — only the connection is open (matches
    // pre-feature behaviour byte-for-byte).
    assert.equal(store.handleCount(), 1, `expected 1 handle before any write, got ${store.handleCount()}`);

    await store.storeBatch([doc('m', 'first row'), doc('n', 'second row')]);
    // Still no pool — storeBatch doesn't warm it; only search() does.
    assert.equal(store.handleCount(), 2, 'storeBatch alone must not build the read pool');

    await store.search('first', 5);
    assert.equal(
        store.handleCount(),
        1 + 1 + DEFAULT_LANCE_POOL_SIZE,
        `expected 18 handles (1 connection + 1 table + ${DEFAULT_LANCE_POOL_SIZE} pool) for default role after warming, got ${store.handleCount()}`,
    );

    await store.close();
});

await test("reopening an existing (already-written) workspace with the default role eagerly warms the pool at initialize()", async () => {
    const base = mkTmp();
    const writer = new VerbatimStore(base, new ConstEmbedProvider());
    await writer.initialize();
    await writer.storeBatch([doc('p', 'seed row')]);
    await writer.close();

    // Re-open the SAME on-disk path with an opts object that omits `role`
    // entirely — must be indistinguishable from the pre-feature 2-arg call.
    const reopened = new VerbatimStore(base, new ConstEmbedProvider(), {});
    await reopened.initialize();
    assert.equal(
        reopened.handleCount(),
        1 + 1 + DEFAULT_LANCE_POOL_SIZE,
        'a reopened workspace with a table already on disk should eagerly build the pool at initialize(), matching pre-feature behaviour',
    );
    await reopened.close();
});

console.log('');
console.log(`Total: ${pass + fail}, Passed: ${pass}, Failed: ${fail}`);
if (fail > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
process.exit(0);

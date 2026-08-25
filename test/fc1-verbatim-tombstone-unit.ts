#!/usr/bin/env tsx
/**
 * test/fc1-verbatim-tombstone-unit.ts — 2026-08-17 audit findings
 * 1.10 / M9 / M10 (VerbatimStore).
 *
 *   1.10 — tombstone() rewrote the row's text to '[TOMBSTONED ...]' but kept
 *          the ORIGINAL contentHash, so store()'s skip-identical check
 *          matched the stale hash and no-op'd — re-storing the SAME content
 *          after a delete left it permanently invisible to search/bm25 while
 *          the write reported success. store() now never skips when the
 *          existing row is tombstoned. (Repro shape: store → delete → store
 *          same content → must be findable again.)
 *   M9  — skip-identical also dropped METADATA-only updates (project,
 *          ecosystem, type, updatedAt, security_scopes). "Identical" now
 *          covers the persisted metadata columns too.
 *   M10 — tombstone() swallowed every error with a bare `catch {}` while
 *          callers reported success. It now propagates VerbatimStoreError;
 *          the graceful no-op cases (uninitialized, absent, already
 *          tombstoned, history id) still return normally.
 *
 * Run: npx tsx test/fc1-verbatim-tombstone-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VerbatimStore, VerbatimStoreError } from '../packages/lore/src/engines/verbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

const DIM = 8;
/** Deterministic stub embedder (no ONNX) — same pattern as cluster3 tests. */
function stubProvider(): EmbeddingProvider {
    const vec = (text: string): number[] => {
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
        const v = new Array<number>(DIM);
        for (let i = 0; i < DIM; i++) { h = Math.imul(h ^ (h >>> 13), 1274126177); v[i] = ((h >>> 0) % 2000 - 1000) / 1000; }
        return v;
    };
    return {
        dimension: DIM,
        modelId: 'stub/fc1',
        initialize: async () => undefined,
        embed: async (t) => vec(t),
        embedQuery: async (t) => vec(t),
        embedDocument: async (t) => vec(t),
        embedDocumentBatch: async (ts) => ts.map(vec),
    };
}

function tmpStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc1-tomb-'));
    return { dir, store: new VerbatimStore(dir, stubProvider()), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const META = { type: 'decision', label: 'L', tags: '', project: 'default', ecosystem: '*', updatedAt: '2026-08-17T00:00:00.000Z', security_scopes: [] as string[] };

async function main() {
    console.log('1.10 — re-storing content at a tombstoned id actually restores it');

    await test('T1.10 store → tombstone → store SAME content → searchable again', async () => {
        const { store, cleanup } = tmpStore();
        try {
            await store.initialize();
            const text = 'use postgres for the ledger store';
            await store.store({ id: 'lore:decision-use-postgres', text, metadata: META });
            await store.tombstone('lore:decision-use-postgres', 'graph node deleted via MCP delete_node');

            const tombstoned = await store.getById('lore:decision-use-postgres');
            assert.ok(tombstoned?.text?.startsWith('[TOMBSTONED'), 'row is tombstoned after delete');
            assert.equal((await store.bm25Search('postgres ledger', 10)).hits.length, 0, 'tombstoned row is excluded from bm25');

            // The bug: this re-store used to skip-identical against the stale hash.
            await store.store({ id: 'lore:decision-use-postgres', text, metadata: META });

            const restored = await store.getById('lore:decision-use-postgres');
            assert.ok(restored, 'row exists');
            assert.ok(!restored!.text?.startsWith('[TOMBSTONED'), 'row is no longer a tombstone');
            assert.equal(restored!.text, text, 'original text restored');
            const { hits } = await store.bm25Search('postgres ledger', 10);
            assert.ok(hits.some((h) => h.id === 'lore:decision-use-postgres'), 'bm25 finds the restored row');
            const vecHits = await store.search('postgres ledger', 10);
            assert.ok(vecHits.some((h) => h.id === 'lore:decision-use-postgres'), 'vector search finds the restored row');
        } finally { cleanup(); }
    });

    await test('T1.10b tombstone → store DIFFERENT content also restores (control)', async () => {
        const { store, cleanup } = tmpStore();
        try {
            await store.initialize();
            await store.store({ id: 'lore:x', text: 'first version', metadata: META });
            await store.tombstone('lore:x', 'cleanup');
            await store.store({ id: 'lore:x', text: 'second version about pangolins', metadata: META });
            const row = await store.getById('lore:x');
            assert.equal(row?.text, 'second version about pangolins');
        } finally { cleanup(); }
    });

    console.log('M9 — metadata-only updates are no longer dropped by skip-identical');

    await test('T1.M9 same text, changed project → the row is rewritten with the new metadata', async () => {
        const { store, cleanup } = tmpStore();
        try {
            await store.initialize();
            await store.store({ id: 'lore:m9', text: 'stable content', metadata: { ...META, project: 'alpha' } });
            await store.store({ id: 'lore:m9', text: 'stable content', metadata: { ...META, project: 'beta' } });
            const row = await store.getById('lore:m9');
            assert.equal(row?.project, 'beta', 'pre-fix: the project move was silently dropped');
        } finally { cleanup(); }
    });

    await test('T1.M9b truly identical re-store still skips (SP-13 preserved — no history churn)', async () => {
        const { store, cleanup } = tmpStore();
        try {
            await store.initialize();
            await store.store({ id: 'lore:m9b', text: 'stable content', metadata: META });
            await store.store({ id: 'lore:m9b', text: 'stable content', metadata: META });
            const hist = await store.getHistory('lore:m9b');
            assert.equal(hist.length, 1,
                `identical re-store must not snapshot+rewrite (got ${hist.length} history rows)`);
        } finally { cleanup(); }
    });

    console.log('M10 — tombstone propagates real failures, keeps graceful no-ops');

    await test('T1.M10a graceful no-ops unchanged (absent row, already tombstoned, uninitialized)', async () => {
        const { store, cleanup } = tmpStore();
        try {
            // Uninitialized store — graceful no-op.
            await store.tombstone('lore:nothing', 'x');
            await store.initialize();
            // Absent row — graceful no-op.
            await store.tombstone('lore:absent', 'x');
            // Double tombstone — second is a graceful no-op.
            await store.store({ id: 'lore:d', text: 'doc', metadata: META });
            await store.tombstone('lore:d', 'first');
            await store.tombstone('lore:d', 'second');
            const row = await store.getById('lore:d');
            assert.ok(row?.text?.includes('first'), 'first tombstone reason preserved');
        } finally { cleanup(); }
    });

    await test('T1.M10b a REAL substrate failure throws VerbatimStoreError (was silently swallowed)', async () => {
        const { store, dir, cleanup } = tmpStore();
        try {
            await store.initialize();
            await store.store({ id: 'lore:victim', text: 'important content', metadata: META });
            // Break the table underneath the initialized store: the tombstone's
            // query now genuinely fails (IO-level), which callers must see.
            const tableDir = path.join(dir, '.lore', 'lancedb', 'lore_verbatim.lance');
            fs.rmSync(tableDir, { recursive: true, force: true });
            await assert.rejects(
                () => store.tombstone('lore:victim', 'should fail loudly'),
                (err: unknown) => err instanceof VerbatimStoreError && (err as VerbatimStoreError).operation === 'tombstone',
                'tombstone must throw VerbatimStoreError on real failure (pre-fix: bare catch {})',
            );
        } finally { cleanup(); }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

#!/usr/bin/env tsx
/**
 * verbatim-worker-parent-embeds-metadata-unit.ts — regression guard for the
 * 3.17.0 parent-embeds write bug (fix/verbatim-worker-nested-metadata).
 *
 * THE BUG. With `LORE_SEARCH_WORKER=1` and a parentEmbedder configured,
 * `VerbatimSearchWorkerProxy.storeBatch()` embedded each document in the parent
 * and then sent it to the child's `bulkUpsertPrebuiltRows` — a PREBUILT-ROW
 * sink, which passes what it is given straight to Arrow as a schema row. A
 * VerbatimDocument is not a schema row: its `metadata` is a NESTED object, and
 * Arrow flattens that to the dotted path `metadata.type`, which
 * `buildVerbatimSchema` does not declare. Every such write was rejected with
 *
 *     Found field not in schema: metadata.type at row 0
 *
 * and — because `store()` delegated to `storeBatch()` — BOTH the single
 * (`verbatim.upsert`) and consolidated (`verbatim.upsert.batch`) outbox paths
 * failed identically, plus the autolink ingest hook. The outbox retried to
 * exhaustion and dead-lettered them. Observed live: 2,980 dead entries across
 * 11 workspaces over 7 days, 286 nodes left with no vector row at all.
 *
 * WHY THE SUITE MISSED IT. Every pre-existing test on this path seeds
 * `metadata: {}`. An EMPTY object contributes no Arrow field paths at all, so
 * the schema check never fires and the bug is invisible. Section A below is the
 * whole point of this file: NON-EMPTY metadata, the shape production always
 * sends. It fails on the pre-fix code and passes after.
 *
 * THE SECOND DEFECT. `bulkUpsertPrebuiltRows` also skips everything
 * `VerbatimStore.store`/`storeBatch` do around the write — the `#rev` history
 * snapshot and the skip-identical short-circuit. So parent-embeds mode silently
 * kept NO revision history. Sections C and D pin both behaviours down, because
 * a fix that only flattened the row would leave that half broken and just as
 * silent.
 *
 * Harness: a real child_process fork (the production path), with a fake
 * parentEmbedder — deterministic, 8-dimensional, no ONNX model load. Under
 * PARENT_EMBEDS the child builds its LanceDB schema from the dimension the
 * parent advertises and its own provider is a stub that THROWS on every embed
 * call, so any write that reached the child's embedder would fail loudly rather
 * than pass quietly.
 *
 * Run: npx tsx test/verbatim-worker-parent-embeds-metadata-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

const DIM = 8;

/**
 * Deterministic stand-in for the real provider: same text → same vector, so
 * contentHash reuse and similarity stay meaningful, with no model to load.
 */
class FakeEmbedProvider implements EmbeddingProvider {
    queryCalls = 0;
    documentCalls = 0;
    documentBatchCalls = 0;
    readonly modelId = 'fake-parent-embedder';
    readonly dimension = DIM;
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const out = new Array<number>(DIM).fill(0);
        for (let i = 0; i < text.length; i++) out[i % DIM] += text.charCodeAt(i) / 255;
        const norm = Math.hypot(...out) || 1;
        return out.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { this.queryCalls++; return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { this.documentCalls++; return this.vec(text); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        this.documentBatchCalls++;
        return texts.map((t) => this.vec(t));
    }
}

/** The metadata shape production actually sends — see nodeServiceVerbatim's
 *  `verbatimPayload`. Every field here is a real column on the verbatim table;
 *  the bug was that the OBJECT WRAPPING them reached Arrow intact. */
function realMetadata(over: Record<string, unknown> = {}) {
    return {
        type: 'decision',
        label: 'atlas index is fire-and-forget by default',
        tags: 'atlas-index,async,decision',
        project: 'groundfloor-atlas',
        ecosystem: 'code',
        security_scopes: [] as string[],
        updatedAt: '2026-09-01T13:24:40.827Z',
        ...over,
    };
}

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

process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';

async function main(): Promise<void> {
    console.log('verbatim-worker-parent-embeds: non-empty metadata persists, and history is kept');

    const embedder = new FakeEmbedProvider();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-worker-metadata-'));
    const proxy = new VerbatimSearchWorkerProxy(home, undefined, embedder);

    try {
        await proxy.initialize();

        // ── Section A: the regression itself ────────────────────────────────
        // Pre-fix, BOTH of these threw
        // "Found field not in schema: metadata.type at row 0".

        await test('store() with NON-EMPTY metadata persists (the 3.17.0 regression)', async () => {
            await proxy.store({
                id: 'lore:knowledge:decision:single',
                text: 'atlas index is fire-and-forget by default',
                metadata: realMetadata(),
            });
            const row = await proxy.getById('lore:knowledge:decision:single');
            assert.ok(row, 'the row is readable back from the child');
            assert.equal(row!.text, 'atlas index is fire-and-forget by default');
        });

        await test('storeBatch() with NON-EMPTY metadata persists (the consolidated path)', async () => {
            await proxy.storeBatch([
                { id: 'lore:knowledge:decision:b1', text: 'first consolidated row', metadata: realMetadata() },
                { id: 'lore:knowledge:decision:b2', text: 'second consolidated row', metadata: realMetadata({ type: 'convention' }) },
            ]);
            assert.ok(await proxy.getById('lore:knowledge:decision:b1'), 'batch row 1 persisted');
            assert.ok(await proxy.getById('lore:knowledge:decision:b2'), 'batch row 2 persisted');
        });

        // ── Section B: metadata must land in COLUMNS, not be dropped ────────
        // Flattening the row is only half the fix. If the nested object were
        // silently discarded instead of mapped, Section A would pass while
        // every metadata-scoped filter and ecosystem confinement check broke.

        await test('every metadata field lands in its own column, not swallowed', async () => {
            const row = await proxy.getById('lore:knowledge:decision:single');
            assert.equal(row!.type, 'decision', 'type column');
            assert.equal(row!.label, 'atlas index is fire-and-forget by default', 'label column');
            assert.equal(row!.tags, 'atlas-index,async,decision', 'tags column');
            assert.equal(row!.project, 'groundfloor-atlas', 'project column');
            assert.equal(row!.ecosystem, 'code', 'ecosystem column');
            assert.equal(row!.updatedAt, '2026-09-01T13:24:40.827Z', 'updatedAt column');
            assert.ok(row!.contentHash, 'contentHash column is populated');
        });

        await test('a row carrying non-empty security_scopes writes without a schema error', async () => {
            // security_scopes is the one List<Utf8> column on the table, sitting
            // in the same row as the nested object that broke the write — worth
            // its own case so a future flattening change can't drop back to
            // passing a bare JS array where Arrow wants a list.
            //
            // NOTE: this asserts the WRITE, not a read-back of the scopes.
            // `verbatimHistory.getById` gates that field on `Array.isArray`,
            // and LanceDB hands back an Arrow Vector, so it always returns []
            // — verified identical on the in-process path, i.e. pre-existing
            // and unrelated to this fix. Asserting the round-trip here would
            // fail for a reason this file is not about.
            await proxy.store({
                id: 'lore:knowledge:decision:scoped',
                text: 'a scoped decision',
                metadata: realMetadata({ security_scopes: ['team:core', 'team:platform'] }),
            });
            const row = await proxy.getById('lore:knowledge:decision:scoped');
            assert.ok(row, 'the scoped row persisted');
            assert.equal(row!.text, 'a scoped decision');
            assert.equal(row!.type, 'decision', 'sibling columns still land alongside the list column');
        });

        // ── Section C: revision history — the silent second defect ──────────

        await test('updating a node snapshots the previous revision (#rev history was silently lost)', async () => {
            await proxy.store({
                id: 'lore:knowledge:decision:versioned',
                text: 'the original text',
                metadata: realMetadata({ updatedAt: '2026-09-01T00:00:00.000Z' }),
            });
            await proxy.store({
                id: 'lore:knowledge:decision:versioned',
                text: 'the revised text',
                metadata: realMetadata({ updatedAt: '2026-09-02T00:00:00.000Z' }),
            });
            const history = await proxy.getHistory('lore:knowledge:decision:versioned');
            assert.equal(history.length, 2, `expected canonical + 1 snapshot, got ${history.length}`);
            const canonical = history.find((h) => h.isCanonical);
            assert.equal(canonical?.text, 'the revised text', 'canonical row holds the newest text');
            assert.ok(
                history.some((h) => !h.isCanonical && h.text === 'the original text'),
                'the prior revision is preserved as a #rev snapshot',
            );
        });

        await test('re-storing IDENTICAL content is a no-op (skip-identical, not a fresh revision)', async () => {
            const before = (await proxy.getHistory('lore:knowledge:decision:versioned')).length;
            await proxy.store({
                id: 'lore:knowledge:decision:versioned',
                text: 'the revised text',
                metadata: realMetadata({ updatedAt: '2026-09-02T00:00:00.000Z' }),
            });
            const after = (await proxy.getHistory('lore:knowledge:decision:versioned')).length;
            assert.equal(after, before, 'an unchanged re-store must not add a revision');
        });

        // ── Section D: the parent is still the only embedder ────────────────
        // The whole reason the shortcut existed. The child's provider throws on
        // every embed call, so a regression that routed embedding back to the
        // child would surface as a hard failure above — this asserts the
        // positive half: the parent did the work, in batched form.

        await test('the parent does all embedding; the child never loads a model', async () => {
            const before = embedder.documentBatchCalls;
            await proxy.storeBatch([
                { id: 'lore:knowledge:decision:c1', text: 'counted row one', metadata: realMetadata() },
                { id: 'lore:knowledge:decision:c2', text: 'counted row two', metadata: realMetadata() },
            ]);
            assert.equal(
                embedder.documentBatchCalls, before + 1,
                'one batched embed call on the parent for the whole batch',
            );
        });

        await test('search still works over parent-computed vectors', async () => {
            const hits = await proxy.search('atlas index is fire-and-forget by default', 5);
            assert.ok(hits.some((h) => h.id === 'lore:knowledge:decision:single'), 'the stored row is findable');
        });

        // ── Section E: the old blind spot must keep working ─────────────────

        await test('metadata:{} still persists (the shape the pre-existing tests use)', async () => {
            await proxy.storeBatch([{ id: 'lore:empty-meta', text: 'a row with no metadata', metadata: {} }]);
            const row = await proxy.getById('lore:empty-meta');
            assert.ok(row, 'empty-metadata row persisted');
            assert.equal(row!.type ?? '', '', 'absent metadata becomes an empty column, not a failure');
        });
    } finally {
        await proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

#!/usr/bin/env tsx
/**
 * bm25-envelope-adversarial-unit.ts — fix/fts-index-and-tokenizer follow-up.
 *
 * Closes the remaining adversarial gaps from the Bm25Envelope migration
 * (verbatimBm25Result.ts) that were not exercised by
 * test/fts-index-and-tokenizer-unit.ts or test/verbatim-search-worker-e2e.ts:
 *
 *   A. readBm25Envelope is FAIL-CLOSED against every malformed shape a
 *      value can take after crossing a real boundary (a facade call, the
 *      search-worker IPC round trip, a foreign/legacy caller, or outright
 *      garbage) — never throws, never defaults to "ranked".
 *   B. retrieve()'s fusion step never throws when the wired verbatim seed
 *      store hands back one of those malformed shapes — it degrades to
 *      semantic-only, exactly as it does for a well-formed ranked:false.
 *   C. The LIKE-scan fallback fires ONLY on a genuine native-FTS error
 *      (post-review fix, 2026-08-04) — never merely because a query
 *      legitimately found zero rows. Two independent stores in the SAME
 *      process — one genuinely ranked, one with a corrupted index forcing
 *      the LIKE-scan fallback — must not cross-contaminate. (Regression
 *      guard for the OLD Symbol-marker design, which risked exactly this
 *      if the marker were ever attached to a shared/interned array; the
 *      new envelope is plain per-call data with no shared mutable state,
 *      but the isolation must be PROVEN, not assumed.)
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { readBm25Envelope, makeBm25Envelope } from '../packages/lore/src/engines/verbatimBm25Result.js';
import { retrieve } from '../packages/lore/src/recall/retrieve.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  \x1b[32m\u2713\x1b[0m ${name}`);
        passed++;
    } catch (err) {
        console.log(`  \x1b[31m\u2717\x1b[0m ${name}`);
        console.log(`    ${(err as Error).stack ?? err}`);
        failed++;
    }
}

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `bm25-adv-${tag}-`));
}

class DeterministicEmbedder {
    modelId = 'det-adv-test';
    dimension = 8;
    async initialize(): Promise<void> { /* no-op */ }
    async embedDocument(text: string) { return this._vec(text); }
    async embedDocumentBatch(texts: string[]) { return texts.map((t) => this._vec(t)); }
    async embedQuery(text: string) { return this._vec(text); }
    private _vec(text: string): number[] {
        const v = new Array(8).fill(0);
        for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i);
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
}

console.log('BM25 envelope — adversarial gaps (malformed signal, cross-workspace isolation)\n');

(async () => {
    /* ══════════════════════════════════════════════════════════════════
     * SECTION A — readBm25Envelope fail-closed matrix.
     * ══════════════════════════════════════════════════════════════════ */
    console.log('=== Section A: readBm25Envelope malformed-input matrix ===\n');

    const MALFORMED: Array<{ label: string; value: unknown }> = [
        { label: 'null', value: null },
        { label: 'undefined', value: undefined },
        { label: 'bare string', value: 'not an envelope' },
        { label: 'bare number', value: 42 },
        { label: 'bare boolean', value: true },
        { label: 'legacy bare array (pre-envelope caller)', value: [{ id: 'lore:x', score: 1 }] },
        { label: 'empty object (missing both fields)', value: {} },
        { label: 'missing `ranked`', value: { hits: [{ id: 'lore:x' }] } },
        { label: 'missing `hits`', value: { ranked: true } },
        { label: '`hits` not an array (object)', value: { hits: { 0: { id: 'lore:x' } }, ranked: true } },
        { label: '`hits` not an array (string)', value: { hits: 'lore:x', ranked: true } },
        { label: '`ranked` not a boolean (string "true")', value: { hits: [], ranked: 'true' } },
        { label: '`ranked` not a boolean (number 1)', value: { hits: [], ranked: 1 } },
        { label: '`ranked` null', value: { hits: [{ id: 'lore:x' }], ranked: null } },
        { label: 'v8-structured-clone-of-a-Symbol-tagged-array (the OLD bug\'s actual shape)', value: Object.assign([{ id: 'lore:x', score: 1 }], {}) },
    ];

    for (const { label, value } of MALFORMED) {
        await test(`malformed shape "${label}" reads as { hits: [], ranked: false } — never throws`, () => {
            let result: { hits: unknown[]; ranked: boolean } | undefined;
            assert.doesNotThrow(() => { result = readBm25Envelope(value); }, `readBm25Envelope must never throw on ${label}`);
            assert.deepEqual(result!.hits, [], `${label}: hits must be empty`);
            assert.equal(result!.ranked, false, `${label}: ranked must be false (fail-closed, never defaults to ranked)`);
        });
    }

    await test('a genuinely well-formed envelope round-trips unchanged', () => {
        const env = makeBm25Envelope([{ id: 'lore:a', score: 0.7 }], true);
        const read = readBm25Envelope<{ id: string; score: number }>(env);
        assert.deepEqual(read.hits, [{ id: 'lore:a', score: 0.7 }]);
        assert.equal(read.ranked, true);
    });

    await test('a well-formed unranked envelope (empty hits, ranked:false) round-trips unchanged', () => {
        const env = makeBm25Envelope([], false);
        const read = readBm25Envelope(env);
        assert.deepEqual(read.hits, []);
        assert.equal(read.ranked, false);
    });

    /* ══════════════════════════════════════════════════════════════════
     * SECTION B — retrieve() never throws on a malformed bm25 signal;
     * degrades to semantic-only exactly as the well-formed ranked:false
     * case does.
     * ══════════════════════════════════════════════════════════════════ */
    console.log('\n=== Section B: retrieve() fusion degrades cleanly on a malformed bm25 signal ===\n');

    type MockNode = { id: string; type: string; label: string; content: string; tags: string[]; project: string; ecosystem: string; updatedAt: string };
    const mockNode = (id: string): MockNode => ({
        id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'w', ecosystem: '*', updatedAt: '2026-01-01T00:00:00.000Z',
    });

    function mockRetrieveCtx(cfg: {
        semantic?: Array<{ id: string; score?: number }>;
        bm25Return: unknown; // whatever the (malformed) mock hands back, verbatim
        nodes: Record<string, MockNode>;
    }): Parameters<typeof retrieve>[0] {
        const graph = {
            async search() { return [] as MockNode[]; },
            async getNodesByIds(ids: string[]) {
                const m = new Map<string, MockNode>();
                for (const id of ids) { const n = cfg.nodes[id]; if (n) m.set(id, n); }
                return m;
            },
            async traverse() { return [] as Array<{ node: MockNode; depth: number }>; },
        };
        const ctx = {
            store: {
                loreGraph: graph,
                sessionCache: { pushNode() { /* no-op */ } },
                storageClient: {
                    async verbatimCount() { return 1; },
                    async verbatimSearch() { return cfg.semantic ?? []; },
                    async verbatimBm25Search() { return cfg.bm25Return; },
                },
            },
        };
        return ctx as unknown as Parameters<typeof retrieve>[0];
    }

    for (const { label, value } of MALFORMED) {
        await test(`retrieve() with a "${label}" bm25 response does not throw and keeps the semantic hit`, async () => {
            const ctx = mockRetrieveCtx({
                semantic: [{ id: 'lore:a', score: 0.9 }],
                bm25Return: value,
                nodes: { a: mockNode('a') },
            });
            let out: Awaited<ReturnType<typeof retrieve>> | undefined;
            await assert.doesNotReject(async () => { out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 }); }, `retrieve() must never throw on a malformed bm25 response (${label})`);
            assert.deepEqual(out!.results.map((r) => r.node.id), ['a'], `${label}: only the semantic hit should surface`);
            assert.ok(out!.results.every((r) => !r.matchedBy.includes('bm25')), `${label}: no result may carry matchedBy=[bm25] from a malformed/unranked signal`);
        });
    }

    /* ══════════════════════════════════════════════════════════════════
     * SECTION C — two workspaces, one ranked one not, same process: no
     * cross-contamination of the ranked signal.
     * ══════════════════════════════════════════════════════════════════ */
    console.log('\n=== Section C: fallback trigger — errors fall back, genuine zero-match does not ===\n');

    await test('a genuinely-indexed store\'s legitimate zero-match query returns ranked:true with empty hits — does NOT degrade to the LIKE scan', async () => {
        // Post-review fix (2026-08-04): the LIKE-scan fallback used to fire
        // whenever native FTS returned zero rows, regardless of whether that
        // was a real error or just "no match" — the exact perf cliff the
        // fallback comment warns about, moved onto the common no-match path.
        // "the" is an English stopword this store's default tokenizer
        // excludes from the index (removeStopWords:true), so native FTS
        // correctly, successfully finds zero rows for it — even though "the"
        // is a literal substring of the corpus text below. Falling back to
        // LIKE would resurrect it via raw substring matching, contradicting
        // the tokenizer's own decision. Above minRows so a real index exists
        // (proving this is "index worked, found nothing", not "no index").
        const dir = tmpDir('genuine-zero');
        const store = new VerbatimStore(dir, new DeterministicEmbedder());
        try {
            await store.initialize();
            const filler = Array.from({ length: 30 }, (_, i) => ({ id: `lore:z-${i}`, text: `record number ${i} about gadgets`, metadata: {} }));
            await store.storeBatch([...filler, { id: 'lore:z-target', text: 'the artifact is a teapot', metadata: {} }]);
            const env = await store.bm25Search('the', 5);
            assert.deepEqual(env.hits, [], '"the" is stopword-excluded from the index — native FTS genuinely finds nothing');
            assert.equal(env.ranked, true, 'a genuine (non-erroring) zero-match query must report ranked:true, not degrade to the unranked LIKE-scan fallback');
        } finally {
            await store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await test('a genuinely-ranked store and an index-error/LIKE-fallback store queried concurrently in one process do not cross-contaminate their ranked signal', async () => {
        const dirRanked = tmpDir('ranked');
        const dirUnranked = tmpDir('unranked');
        const rankedStore = new VerbatimStore(dirRanked, new DeterministicEmbedder());
        const unrankedStore = new VerbatimStore(dirUnranked, new DeterministicEmbedder());
        try {
            await rankedStore.initialize();
            await unrankedStore.initialize();

            // rankedStore: 30 rows (> minRows=25) with an English corpus —
            // storeBatch() proactively builds a real FTS index (fix/fts-
            // index-and-tokenizer follow-up) → genuinely ranked results.
            await rankedStore.storeBatch(
                Array.from({ length: 30 }, (_, i) => ({ id: `lore:r-${i}`, text: `document number ${i} about quarterly widgets`, metadata: {} })),
            );

            // unrankedStore: same shape, but its on-disk FTS index is
            // physically corrupted after building — the ONLY thing that
            // should trigger the LIKE-scan fallback post-review-fix (a
            // genuine native-FTS error, not a legitimate zero-match query).
            await unrankedStore.storeBatch(
                Array.from({ length: 30 }, (_, i) => ({ id: `lore:u-${i}`, text: `document number ${i} about quarterly gadgets`, metadata: {} })),
            );
            const lancedbDir = path.join(dirUnranked, '.lore', 'lancedb');
            const indicesDir = path.join(lancedbDir, 'lore_verbatim.lance', '_indices');
            for (const f of fs.readdirSync(indicesDir)) {
                const idxDir = path.join(indicesDir, f);
                for (const inner of fs.readdirSync(idxDir)) {
                    fs.writeFileSync(path.join(idxDir, inner), 'CORRUPTGARBAGE');
                }
            }

            // Fire both concurrently — interleaved event-loop turns are
            // exactly where a shared/global marker (the old design) could
            // leak state between them; the envelope is per-call data, so
            // this must be clean regardless of interleaving.
            const [rankedEnv, unrankedEnv] = await Promise.all([
                rankedStore.bm25Search('quarterly', 5),
                unrankedStore.bm25Search('quarterly', 5),
            ]);

            assert.equal(rankedEnv.ranked, true, 'the healthy-indexed store must report ranked:true');
            assert.ok(rankedEnv.hits.length > 0, 'the healthy-indexed store must find its match');

            assert.equal(unrankedEnv.ranked, false, 'the corrupted-index store must report ranked:false — must NOT have picked up the other store\'s ranked:true');
            assert.ok(unrankedEnv.hits.length > 0, 'the corrupted-index store must still find its substring match via the LIKE-scan safety net');
            assert.ok(unrankedEnv.hits.every((h) => h.score === 1), 'LIKE-scan hits are unranked — every score forced to 1.0, unaffected by the other store\'s real BM25 scores');

            // Re-run in the OPPOSITE interleaving to rule out an ordering-
            // dependent leak.
            const [unrankedEnv2, rankedEnv2] = await Promise.all([
                unrankedStore.bm25Search('quarterly', 5),
                rankedStore.bm25Search('quarterly', 5),
            ]);
            assert.equal(unrankedEnv2.ranked, false, 'reversed interleaving: corrupted-index store still reports ranked:false');
            assert.equal(rankedEnv2.ranked, true, 'reversed interleaving: healthy-indexed store still reports ranked:true');
        } finally {
            await rankedStore.close();
            await unrankedStore.close();
            fs.rmSync(dirRanked, { recursive: true, force: true });
            fs.rmSync(dirUnranked, { recursive: true, force: true });
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();

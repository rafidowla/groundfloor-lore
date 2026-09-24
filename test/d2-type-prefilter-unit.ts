#!/usr/bin/env tsx
/**
 * test/d2-type-prefilter-unit.ts — D2 (P1): node type/kind prefilter.
 *
 * Proves `resolveSeedStore`'s new `types` option (retrieve.ts / retrieveSeedStore.ts)
 * is a TRUE prefilter — pushed inside the vector ANN query and the BM25/FTS
 * query themselves (SqliteVerbatimStore.searchByVector / bm25Search, via the
 * shared buildSqlFilterEntries helper in verbatimHistory.ts) — rather than a
 * post-hydration filter applied after a fixed-size candidate window is
 * fetched.
 *
 * Fixture shape
 * ─────────────
 * One embedding dimension carries all the signal: query vector Q = e0.
 *   - 1 `knowledge`-typed TARGET doc, cosine(Q, target) = 0.9 (unique highest
 *     similarity among `knowledge` rows).
 *   - 79 other `knowledge`-typed rows, cosine(Q, ·) = 0.5 (below target).
 *   - N `junk`-typed DISTRACTOR rows, cosine(Q, ·) ≈ 0.999 — engineered to
 *     ALWAYS outrank every `knowledge` row on raw similarity alone. N sweeps
 *     0 → 2000, i.e. up to 12.5× retrieve.ts's own worst-case seed window
 *     (`limit(10) × SEED_MAX_HEADROOM(16) = 160` — see retrieve.ts's
 *     SEED_HIDDEN_HEADROOM/SEED_MAX_HEADROOM comment block).
 *
 * Without a prefilter, once N exceeds the topK requested from the store, the
 * `junk` rows fill the ENTIRE candidate window before hydration/filtering
 * ever sees a `knowledge` row — hit@1 degrades to "some junk row" the moment
 * N crosses topK. A working prefilter keeps hit@1 == the target id at every
 * N, because `junk` rows are excluded by the SQL WHERE clause itself and
 * never compete for the window.
 *
 * The same shape is repeated for BM25/FTS: the TARGET doc's text contains a
 * unique rare token once; every `junk` distractor repeats that SAME token
 * many times (inflating raw term-frequency ranking far above the target),
 * and only a `types` prefilter — not post-filtering — keeps the target at
 * hit@1 as the junk count grows.
 *
 * This test is written against `resolveSeedStore()` (recall/retrieveSeedStore.ts)
 * — the exact function D2 modified — backed by a REAL SqliteVerbatimStore
 * (no daemon, no network, mkdtemp'd SQLite file, deterministic fake embedding
 * provider). It is expected to FAIL on pre-D2 `main`: `resolveSeedStore` had
 * no `types` parameter at all there, so passing one is a silent no-op (tsx
 * strips types, does not type-check) and every assertion below that depends
 * on `junk` rows being excluded fails once N exceeds the topK window.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { resolveSeedStore, type RetrieveSeedStoreDeps } from '../packages/lore/src/recall/retrieveSeedStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
    catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 8;
/** cosine(Q, ·) where Q = e0 = [1,0,...,0]. Only the first two dims vary. */
function vecForCosine(cos: number, saltDim: number, salt: number): number[] {
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const v = new Array(DIM).fill(0);
    v[0] = cos;
    v[1] = sin;
    // tiny per-row perturbation on an unused dim so distinct junk/knowledge
    // rows aren't bit-identical vectors (irrelevant to ranking — 3rd dim
    // magnitude is negligible relative to cos/sin and does not change which
    // group outranks which).
    v[saltDim] = (salt % 997) * 1e-6;
    return v;
}

class FixedVectorEmbedProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'd2-type-prefilter-unit-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(): Promise<number[]> { return vecForCosine(1, 2, 0); } // Q = e0 exactly
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(text: string): Promise<number[]> {
        if (text.startsWith('TARGET')) return vecForCosine(0.9, 2, 1);
        if (text.startsWith('KDIST')) return vecForCosine(0.5, 2, hashOf(text));
        if (text.startsWith('JUNK')) return vecForCosine(0.999, 2, hashOf(text));
        throw new Error(`unexpected fixture text: ${text}`);
    }
}
function hashOf(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function tmpWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'd2-type-prefilter-unit-'));
}

const RARE_TOKEN = 'zzqueryword9182';

/** Build a store with 1 target + 79 knowledge distractors + N junk rows.
 *  Vector signal per FixedVectorEmbedProvider; lexical signal per RARE_TOKEN
 *  (target has it once, each junk row repeats it 40x). */
async function buildFixture(junkCount: number): Promise<{ store: SqliteVerbatimStore; targetId: string }> {
    const store = new SqliteVerbatimStore(tmpWorkspace(), new FixedVectorEmbedProvider());
    await store.initialize();

    const targetId = 'target-knowledge-1';
    await store.store({
        id: targetId,
        text: `TARGET the canonical answer document mentions ${RARE_TOKEN} exactly once`,
        metadata: { type: 'knowledge', ecosystem: 'e1' },
    });
    for (let i = 0; i < 79; i++) {
        await store.store({
            id: `kdist-${i}`,
            text: `KDIST unrelated knowledge filler row number ${i} about nothing in particular`,
            metadata: { type: 'knowledge', ecosystem: 'e1' },
        });
    }
    const junkTextTail = new Array(40).fill(RARE_TOKEN).join(' ');
    for (let i = 0; i < junkCount; i++) {
        await store.store({
            id: `junk-${i}`,
            text: `JUNK distractor row ${i} ${junkTextTail}`,
            metadata: { type: 'junk', ecosystem: 'e1' },
        });
    }
    return { store, targetId };
}

/** resolveSeedStore's structural RetrieveSeedStoreDeps, wired to a NON-boot
 *  workspace resolver backed by the real SqliteVerbatimStore above — exactly
 *  the code path D2 modified (types merged into BOTH ecosystem-union legs
 *  via the `withTypes()` wrapper). */
function depsFor(store: SqliteVerbatimStore): RetrieveSeedStoreDeps {
    // Deliberately minimal mock — only the `workspaceVerbatimResolver.getOrOpen`
    // path (isBootGraph=false) is exercised by these tests, so `store` is a
    // stub. `search`/`bm25Search` add a trailing `gate` param to match the
    // real structural signature exactly; one outer cast (not per-field) keeps
    // this mock honest about being a partial implementation rather than
    // papering over a real mismatch field-by-field.
    return {
        store: { storageClient: null },
        workspaceVerbatimResolver: {
            getOrOpen: async () => ({
                count: () => store.count(),
                search: (q: string, n: number, filter?: unknown, opts?: unknown, actorScopes?: ReadonlyArray<string>, _gate?: unknown) =>
                    store.search(q, n, filter as never, opts as never, actorScopes),
                bm25Search: (q: string, n: number, filter?: unknown, actorScopes?: ReadonlyArray<string>, _gate?: unknown) =>
                    store.bm25Search(q, n, filter as never, actorScopes),
            }),
        },
    } as unknown as RetrieveSeedStoreDeps;
}

// retrieve.ts's own worst-case seed window: limit(10) × SEED_MAX_HEADROOM(16).
const RETRIEVE_WORST_CASE_WINDOW = 160;
const JUNK_SWEEP = [0, 50, 200, RETRIEVE_WORST_CASE_WINDOW, 500, 2000]; // up to 12.5x the window

async function main(): Promise<void> {
    console.log('d2-type-prefilter-unit\n');

    const vectorHitAt1: Record<number, string> = {};
    for (const junkCount of JUNK_SWEEP) {
        await test(`vector prefilter: hit@1 == target with ${junkCount} junk distractors (topK=${RETRIEVE_WORST_CASE_WINDOW})`, async () => {
            const { store, targetId } = await buildFixture(junkCount);
            try {
                const seedStore = await resolveSeedStore(depsFor(store), 'ws1', false, '*', undefined, ['knowledge']);
                assert.ok(seedStore, 'resolveSeedStore must resolve a seed store for the non-boot workspace');
                const hits = await seedStore!.search('anything', RETRIEVE_WORST_CASE_WINDOW);
                assert.ok(hits.length > 0, 'expected at least one seed hit');
                assert.equal(hits[0].id, targetId, `hit@1 must be the target, got ${hits[0].id} (junk rows must be excluded by the SQL prefilter, not truncated post-hoc)`);
                vectorHitAt1[junkCount] = hits[0].id;
            } finally {
                await store.close();
            }
        });
    }
    await test('vector prefilter: hit@1 IDENTICAL across every junk-distractor count', async () => {
        const values = Object.values(vectorHitAt1);
        assert.ok(values.length === JUNK_SWEEP.length, 'all sweep points must have produced a result');
        assert.ok(values.every((v) => v === values[0]), `hit@1 must not change as distractors grow: ${JSON.stringify(vectorHitAt1)}`);
    });

    const bm25HitAt1: Record<number, string> = {};
    for (const junkCount of JUNK_SWEEP) {
        await test(`BM25 prefilter: hit@1 == target with ${junkCount} junk distractors (topK=${RETRIEVE_WORST_CASE_WINDOW})`, async () => {
            const { store, targetId } = await buildFixture(junkCount);
            try {
                const seedStore = await resolveSeedStore(depsFor(store), 'ws1', false, '*', undefined, ['knowledge']);
                assert.ok(seedStore);
                const envelope = await seedStore!.bm25Search(RARE_TOKEN, RETRIEVE_WORST_CASE_WINDOW);
                assert.ok(envelope.hits.length > 0, 'expected at least one BM25 hit');
                assert.equal(envelope.hits[0].id, targetId, `BM25 hit@1 must be the target, got ${envelope.hits[0].id} (junk rows repeating the query token must be excluded by the SQL prefilter)`);
                bm25HitAt1[junkCount] = envelope.hits[0].id;
            } finally {
                await store.close();
            }
        });
    }
    await test('BM25 prefilter: hit@1 IDENTICAL across every junk-distractor count', async () => {
        const values = Object.values(bm25HitAt1);
        assert.ok(values.length === JUNK_SWEEP.length, 'all sweep points must have produced a result');
        assert.ok(values.every((v) => v === values[0]), `BM25 hit@1 must not change as distractors grow: ${JSON.stringify(bm25HitAt1)}`);
    });

    // Negative control — WITHOUT the types filter, junk rows (engineered to
    // always outrank knowledge rows) DO crowd the target out once their
    // count exceeds the requested topK. This isolates that the fixture
    // itself is a valid crowding-out setup, not just a filter tautology.
    await test('negative control: WITHOUT types filter, junk crowds target out of a small window', async () => {
        const { store, targetId } = await buildFixture(500);
        try {
            const seedStore = await resolveSeedStore(depsFor(store), 'ws1', false, '*', undefined, undefined);
            assert.ok(seedStore);
            const hits = await seedStore!.search('anything', 10); // small window, no filter
            assert.notEqual(hits[0]?.id, targetId, 'without a types filter, the 0.999-cosine junk rows must outrank the 0.9-cosine target at a small window');
        } finally {
            await store.close();
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    // LanceDB (surreal/lance engine pair) coverage — the identical fixture
    // shape and assertions above, but against the REAL VerbatimStore
    // (LanceDB-backed), exercised directly (not through resolveSeedStore),
    // so the vector ANN leg (`VectorQuery.filter()`) and the BM25/FTS leg
    // (`Query.fullTextSearch().filter()`) are each proven to be TRUE
    // prefilters on the installed @lancedb/lancedb version, not just on the
    // SqliteVerbatimStore path resolveSeedStore happens to route to above.
    //
    // Prefilter-vs-postfilter citation (verified against the installed
    // @lancedb/lancedb@0.37.1 `dist/query.d.ts`):
    //   - `VectorQuery.postfilter()` docstring: "By default filtering will be
    //     performed before the vector search... If this is called then
    //     filtering will happen after the vector search instead of before."
    //     `_runVectorSearchUncached` (verbatimStore.ts) calls
    //     `tbl.vectorSearch(vector).limit(limit).filter(conditions...)` and
    //     NEVER calls `.postfilter()`, so the WHERE predicate is applied
    //     BEFORE the ANN search narrows to `limit` — a true prefilter.
    //   - The BM25 leg uses `table.query().fullTextSearch(query, {columns:
    //     'text'}).filter(whereClause).limit(limit)` (`Query`/
    //     `StandardQueryBase`, not `VectorQuery` — no pre/postfilter toggle
    //     exists for it because it has no ANN "narrow first" stage: the
    //     WHERE predicate is pushed into the same index/table scan the FTS
    //     match runs over, so a junk row failing the `type` predicate can
    //     never occupy a `limit` slot the target needed. Confirmed
    //     empirically below (BM25 hit@1 identical from N=0 to the top of the
    //     sweep) rather than solely by doc-comment.
    // ─────────────────────────────────────────────────────────────────────

    class LanceFixedVectorEmbedProvider implements EmbeddingProvider {
        readonly dimension = DIM;
        readonly modelId = 'd2-type-prefilter-unit-fixed-lance';
        readonly dtype = 'fp32';
        async initialize(): Promise<void> {}
        async embedQuery(): Promise<number[]> { return vecForCosine(1, 2, 0); }
        async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
        async embedDocument(text: string): Promise<number[]> {
            if (text.startsWith('TARGET')) return vecForCosine(0.9, 2, 1);
            if (text.startsWith('KDIST')) return vecForCosine(0.5, 2, hashOf(text));
            if (text.startsWith('JUNK')) return vecForCosine(0.999, 2, hashOf(text));
            throw new Error(`unexpected fixture text: ${text}`);
        }
    }

    async function buildFixtureLance(junkCount: number): Promise<{ store: VerbatimStore; targetId: string }> {
        const store = new VerbatimStore(tmpWorkspace(), new LanceFixedVectorEmbedProvider());
        await store.initialize();

        const targetId = 'target-knowledge-1';
        await store.store({
            id: targetId,
            text: `TARGET the canonical answer document mentions ${RARE_TOKEN} exactly once`,
            metadata: { type: 'knowledge', ecosystem: 'e1' },
        });
        for (let i = 0; i < 79; i++) {
            await store.store({
                id: `kdist-${i}`,
                text: `KDIST unrelated knowledge filler row number ${i} about nothing in particular`,
                metadata: { type: 'knowledge', ecosystem: 'e1' },
            });
        }
        const junkTextTail = new Array(40).fill(RARE_TOKEN).join(' ');
        for (let i = 0; i < junkCount; i++) {
            await store.store({
                id: `junk-${i}`,
                text: `JUNK distractor row ${i} ${junkTextTail}`,
                metadata: { type: 'junk', ecosystem: 'e1' },
            });
        }
        return { store, targetId };
    }

    function depsForLance(store: VerbatimStore): RetrieveSeedStoreDeps {
        return {
            store: { storageClient: null },
            workspaceVerbatimResolver: {
                getOrOpen: async () => ({
                    count: () => store.count(),
                    search: (q: string, n: number, filter?: unknown, opts?: unknown, actorScopes?: ReadonlyArray<string>, gate?: unknown) =>
                        store.search(q, n, filter as never, opts as never, actorScopes, gate as never),
                    bm25Search: (q: string, n: number, filter?: unknown, actorScopes?: ReadonlyArray<string>, gate?: unknown) =>
                        store.bm25Search(q, n, filter as never, actorScopes, gate as never),
                }),
            },
        } as unknown as RetrieveSeedStoreDeps;
    }

    // Smaller sweep than the SQLite suite (0 / worst-case-window / 5x): LanceDB
    // table creation + native vector/FTS index paths cost real wall-clock time
    // per fixture, and the crowding-out mechanics (SQL WHERE pushdown ahead of
    // `.limit()`) are engine-agnostic — the SQLite sweep above already proves
    // the shape holds across the full 0→2000 range with the shared
    // buildLanceFilterConditions/buildSqlFilterEntries helpers, so this sweep
    // exists to prove LanceDB's OWN query-builder wiring, not to re-derive the
    // crowding curve.
    const LANCE_JUNK_SWEEP = [0, RETRIEVE_WORST_CASE_WINDOW, 800];

    const lanceVectorHitAt1: Record<number, string> = {};
    for (const junkCount of LANCE_JUNK_SWEEP) {
        await test(`[Lance] vector prefilter: hit@1 == target with ${junkCount} junk distractors`, async () => {
            const { store, targetId } = await buildFixtureLance(junkCount);
            try {
                const seedStore = await resolveSeedStore(depsForLance(store), 'ws1', false, '*', undefined, ['knowledge']);
                assert.ok(seedStore, 'resolveSeedStore must resolve a seed store for the non-boot workspace');
                const hits = await seedStore!.search('anything', RETRIEVE_WORST_CASE_WINDOW);
                assert.ok(hits.length > 0, 'expected at least one seed hit');
                assert.equal(hits[0].id, targetId, `[Lance] hit@1 must be the target, got ${hits[0].id} (junk rows must be excluded by the LanceDB WHERE prefilter, not truncated post-hoc)`);
                lanceVectorHitAt1[junkCount] = hits[0].id;
            } finally {
                await store.close();
            }
        });
    }
    await test('[Lance] vector prefilter: hit@1 IDENTICAL across every junk-distractor count', async () => {
        const values = Object.values(lanceVectorHitAt1);
        assert.ok(values.length === LANCE_JUNK_SWEEP.length, 'all sweep points must have produced a result');
        assert.ok(values.every((v) => v === values[0]), `[Lance] hit@1 must not change as distractors grow: ${JSON.stringify(lanceVectorHitAt1)}`);
    });

    const lanceBm25HitAt1: Record<number, string> = {};
    for (const junkCount of LANCE_JUNK_SWEEP) {
        await test(`[Lance] BM25 prefilter: hit@1 == target with ${junkCount} junk distractors`, async () => {
            const { store, targetId } = await buildFixtureLance(junkCount);
            try {
                const seedStore = await resolveSeedStore(depsForLance(store), 'ws1', false, '*', undefined, ['knowledge']);
                assert.ok(seedStore);
                const envelope = await seedStore!.bm25Search(RARE_TOKEN, RETRIEVE_WORST_CASE_WINDOW);
                assert.ok(envelope.hits.length > 0, 'expected at least one BM25 hit');
                assert.equal(envelope.hits[0].id, targetId, `[Lance] BM25 hit@1 must be the target, got ${envelope.hits[0].id} (junk rows repeating the query token must be excluded by the LanceDB WHERE prefilter)`);
                lanceBm25HitAt1[junkCount] = envelope.hits[0].id;
            } finally {
                await store.close();
            }
        });
    }
    await test('[Lance] BM25 prefilter: hit@1 IDENTICAL across every junk-distractor count', async () => {
        const values = Object.values(lanceBm25HitAt1);
        assert.ok(values.length === LANCE_JUNK_SWEEP.length, 'all sweep points must have produced a result');
        assert.ok(values.every((v) => v === values[0]), `[Lance] BM25 hit@1 must not change as distractors grow: ${JSON.stringify(lanceBm25HitAt1)}`);
    });

    await test('[Lance] negative control: WITHOUT types filter, junk crowds target out of a small window', async () => {
        const { store, targetId } = await buildFixtureLance(500);
        try {
            const seedStore = await resolveSeedStore(depsForLance(store), 'ws1', false, '*', undefined, undefined);
            assert.ok(seedStore);
            const hits = await seedStore!.search('anything', 10); // small window, no filter
            assert.notEqual(hits[0]?.id, targetId, '[Lance] without a types filter, the 0.999-cosine junk rows must outrank the 0.9-cosine target at a small window');
        } finally {
            await store.close();
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

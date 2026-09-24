#!/usr/bin/env tsx
/**
 * test/e2-filter-pushdown-unit.ts — E2: extend D2's crowding-out fix to
 * `entities`, `topics`, `project` recall filters.
 *
 * D2 (test/d2-type-prefilter-unit.ts) proved `types` is a TRUE prefilter —
 * pushed into the vector ANN / BM25 query WHERE clause itself, so a
 * fixed-size top-K candidate window cannot be crowded out by high-volume
 * off-type rows before the filter ever sees them. This file proves the SAME
 * property for the three filters D2 didn't touch:
 *
 *   - `project`: a real VERBATIM_FILTERABLE_COLUMNS column AND a real
 *     `graph.search()` SQL/SurrealQL column, exercised via
 *     `resolveSeedStore()` (vector + BM25 legs, both SqliteVerbatimStore and
 *     LanceDB-backed VerbatimStore). The verbatim row's `project` can differ
 *     from the graph node's (bulkIngest / outbox write paths fall back to
 *     workspace/ecosystem), so the seed leg UNIONS a project-scoped query
 *     onto the unscoped one instead of replacing it: junk from other
 *     projects still comes back (retrieve.ts's applySeedFilters drops it),
 *     but the in-project target can no longer be crowded out, and a row
 *     with a stale vector-side project is still found.
 *   - `entities`/`topics`: NO queryable column exists on the verbatim
 *     (vector/BM25) row (`VerbatimDocument['metadata']` carries no such
 *     fields — confirmed by inspection, a schema/write-path change would be
 *     needed and is out of scope for this fix). They DO get true pushdown on
 *     the GRAPH keyword-search leg (`sqliteGraphReads.search` /
 *     `surrealGraphReads.search`, via `json_each` / `string::matches`
 *     predicates) — exercised here directly against `SqliteGraph`/
 *     `SurrealGraph` with more junk than SEARCH_SCAN_CAP, the only size at
 *     which the keyword leg can actually be crowded out.
 *
 * Expected to FAIL on pre-E2 code: `resolveSeedStore` had no `project`
 * param, and `sqliteGraphReads.search`/`surrealGraphReads.search` had no
 * `entities`/`topics` params — passing them was a silent no-op (tsx strips
 * types) and crowding-out reproduces once junk rows exceed the topK window
 * (vector/BM25) or SEARCH_SCAN_CAP (keyword). The stale-vector-project case
 * fails on a pure (non-union) project pushdown.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { resolveSeedStore, type RetrieveSeedStoreDeps } from '../packages/lore/src/recall/retrieveSeedStore.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { SEARCH_SCAN_CAP } from '../packages/lore/src/engines/searchRanking.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
    catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 8;
function vecForCosine(cos: number, saltDim: number, salt: number): number[] {
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const v = new Array(DIM).fill(0);
    v[0] = cos;
    v[1] = sin;
    v[saltDim] = (salt % 997) * 1e-6;
    return v;
}
function hashOf(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}
function tmpWorkspace(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const RARE_TOKEN = 'zzqueryword9182';
const RETRIEVE_WORST_CASE_WINDOW = 160; // limit(10) x SEED_MAX_HEADROOM(16)

/* ── PART A — `project` pushdown into resolveSeedStore's vector+BM25 legs ── */

class FixedVectorEmbedProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId: string = 'e2-filter-pushdown-unit-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(): Promise<number[]> { return vecForCosine(1, 2, 0); }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(text: string): Promise<number[]> {
        if (text.startsWith('TARGET')) return vecForCosine(0.9, 2, 1);
        if (text.startsWith('PDIST')) return vecForCosine(0.5, 2, hashOf(text));
        if (text.startsWith('JUNK')) return vecForCosine(0.999, 2, hashOf(text));
        throw new Error(`unexpected fixture text: ${text}`);
    }
}

async function buildProjectFixture(junkCount: number): Promise<{ store: SqliteVerbatimStore; targetId: string }> {
    const store = new SqliteVerbatimStore(tmpWorkspace('e2-project-sqlite-'), new FixedVectorEmbedProvider());
    await store.initialize();
    const targetId = 'target-proj-1';
    await store.store({ id: targetId, text: `TARGET the canonical answer document mentions ${RARE_TOKEN} exactly once`, metadata: { type: 'knowledge', project: 'proj-a', ecosystem: 'e1' } });
    for (let i = 0; i < 79; i++) {
        await store.store({ id: `pdist-${i}`, text: `PDIST unrelated filler row number ${i} in the right project about nothing`, metadata: { type: 'knowledge', project: 'proj-a', ecosystem: 'e1' } });
    }
    const junkTextTail = new Array(40).fill(RARE_TOKEN).join(' ');
    for (let i = 0; i < junkCount; i++) {
        await store.store({ id: `junk-${i}`, text: `JUNK distractor row ${i} ${junkTextTail}`, metadata: { type: 'knowledge', project: 'proj-b', ecosystem: 'e1' } });
    }
    return { store, targetId };
}

function depsFor(store: SqliteVerbatimStore): RetrieveSeedStoreDeps {
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

const PROJECT_JUNK_SWEEP = [0, 50, 200, RETRIEVE_WORST_CASE_WINDOW, 500];

/** What retrieve.ts's applySeedFilters keeps for `project: 'proj-a'` in these
 *  fixtures: every non-junk row (junk rows are the only `proj-b` rows). */
function inProject<T extends { id: string }>(hits: T[]): T[] {
    return hits.filter((h) => !h.id.startsWith('junk-'));
}

/* ── PART B — `entities`/`topics` pushdown into graph.search()'s keyword leg ── */

async function buildEntityCrowdingFixture(
    g: SqliteGraph | SurrealGraph,
    junkCount: number,
): Promise<{ targetId: string }> {
    const targetId = 'target-ent-1';
    await g.upsertNode({
        id: targetId, type: 'knowledge',
        label: `TARGET canonical answer ${RARE_TOKEN}`,
        content: `TARGET the canonical answer document mentions ${RARE_TOKEN} exactly once`,
        tags: [], project: '*', ecosystem: 'e1',
        metadata: JSON.stringify({ entities: ['acme-corp'], topics: ['billing'] }),
    });
    for (let i = 0; i < 30; i++) {
        await g.upsertNode({
            id: `edist-${i}`, type: 'knowledge',
            label: `EDIST filler ${i}`,
            content: `EDIST unrelated filler row ${i} about nothing in particular ${RARE_TOKEN}`,
            tags: [], project: '*', ecosystem: 'e1',
            metadata: JSON.stringify({ entities: ['other-corp'], topics: ['other-topic'] }),
        });
    }
    // JUNK rows: same rare token (so they'd win the keyword scan/order on
    // recency or term match if entities weren't pushed down), but a
    // DIFFERENT entity — must never occupy the SEARCH_SCAN_CAP/limit window
    // ahead of the target once an `entities` filter is applied at the query.
    for (let i = 0; i < junkCount; i++) {
        await g.upsertNode({
            id: `junk-${i}`, type: 'knowledge',
            label: `JUNK distractor ${i}`,
            content: `JUNK distractor row ${i} repeats ${RARE_TOKEN} ${RARE_TOKEN} ${RARE_TOKEN}`,
            tags: [], project: '*', ecosystem: 'e1',
            metadata: JSON.stringify({ entities: ['other-corp'], topics: ['other-topic'] }),
        });
    }
    return { targetId };
}

// Keyword-leg crowding happens at SEARCH_SCAN_CAP (see the negative control
// below), so the sweep must go past it for the prefilter to be load-bearing.
const ENTITY_JUNK_SWEEP = [0, 50, SEARCH_SCAN_CAP + 100];

async function main(): Promise<void> {
    console.log('e2-filter-pushdown-unit\n');

    // PART A — project, SQLite verbatim store (vector + BM25 legs)
    const projVectorHitAt1: Record<number, string> = {};
    for (const junkCount of PROJECT_JUNK_SWEEP) {
        await test(`project vector prefilter: hit@1 == target with ${junkCount} junk (topK=${RETRIEVE_WORST_CASE_WINDOW})`, async () => {
            const { store, targetId } = await buildProjectFixture(junkCount);
            try {
                const seedStore = await resolveSeedStore(depsFor(store), 'ws1', false, '*', undefined, undefined, 'proj-a');
                assert.ok(seedStore);
                const hits = inProject(await seedStore!.search('anything', RETRIEVE_WORST_CASE_WINDOW));
                assert.ok(hits.length > 0);
                assert.equal(hits[0].id, targetId, `first in-project hit must be the target, got ${hits[0].id}`);
                projVectorHitAt1[junkCount] = hits[0].id;
            } finally {
                await store.close();
            }
        });
    }
    await test('project vector prefilter: hit@1 IDENTICAL across every junk count', async () => {
        const values = Object.values(projVectorHitAt1);
        assert.ok(values.length === PROJECT_JUNK_SWEEP.length);
        assert.ok(values.every((v) => v === values[0]), JSON.stringify(projVectorHitAt1));
    });

    const projBm25HitAt1: Record<number, string> = {};
    for (const junkCount of PROJECT_JUNK_SWEEP) {
        await test(`project BM25 prefilter: hit@1 == target with ${junkCount} junk (topK=${RETRIEVE_WORST_CASE_WINDOW})`, async () => {
            const { store, targetId } = await buildProjectFixture(junkCount);
            try {
                const seedStore = await resolveSeedStore(depsFor(store), 'ws1', false, '*', undefined, undefined, 'proj-a');
                assert.ok(seedStore);
                const hits = inProject((await seedStore!.bm25Search(RARE_TOKEN, RETRIEVE_WORST_CASE_WINDOW)).hits);
                assert.ok(hits.length > 0);
                assert.equal(hits[0].id, targetId, `BM25 first in-project hit must be the target, got ${hits[0].id}`);
                projBm25HitAt1[junkCount] = hits[0].id;
            } finally {
                await store.close();
            }
        });
    }
    await test('project BM25 prefilter: hit@1 IDENTICAL across every junk count', async () => {
        const values = Object.values(projBm25HitAt1);
        assert.ok(values.length === PROJECT_JUNK_SWEEP.length);
        assert.ok(values.every((v) => v === values[0]), JSON.stringify(projBm25HitAt1));
    });

    await test('project negative control: WITHOUT project filter, junk crowds target out of a small window', async () => {
        const { store, targetId } = await buildProjectFixture(500);
        try {
            const seedStore = await resolveSeedStore(depsFor(store), 'ws1', false, '*', undefined, undefined, undefined);
            assert.ok(seedStore);
            const hits = await seedStore!.search('anything', 10);
            assert.ok(!hits.some((h) => h.id === targetId), 'without a project filter, junk must crowd the target out of a small window entirely');
        } finally {
            await store.close();
        }
    });

    // Finding 7 — the verbatim row's `project` is not guaranteed to equal the
    // graph node's (bulkIngest writes `nodeData.project ?? ecosystem`, the
    // outbox `?? workspace ?? '*'`). A pure project pushdown would silently
    // drop such a row; the union keeps every row the unscoped query found.
    await test('project filter does not drop a row whose VECTOR-side project is stale', async () => {
        const store = new SqliteVerbatimStore(tmpWorkspace('e2-project-stale-'), new FixedVectorEmbedProvider());
        await store.initialize();
        try {
            await store.store({ id: 'target-stale', text: `TARGET stale-project row ${RARE_TOKEN}`, metadata: { type: 'knowledge', project: 'e1', ecosystem: 'e1' } });
            for (let i = 0; i < 20; i++) {
                await store.store({ id: `pdist-${i}`, text: `PDIST filler row ${i}`, metadata: { type: 'knowledge', project: 'proj-a', ecosystem: 'e1' } });
            }
            const seedStore = await resolveSeedStore(depsFor(store), 'ws1', false, '*', undefined, undefined, 'proj-a');
            assert.ok(seedStore);
            const vec = await seedStore!.search('anything', RETRIEVE_WORST_CASE_WINDOW);
            assert.ok(vec.some((h) => h.id === 'target-stale'), `vector leg dropped the stale-project row: ${JSON.stringify(vec.map((h) => h.id))}`);
            const bm = await seedStore!.bm25Search(RARE_TOKEN, RETRIEVE_WORST_CASE_WINDOW);
            assert.ok(bm.hits.some((h) => h.id === 'target-stale'), `BM25 leg dropped the stale-project row: ${JSON.stringify(bm.hits.map((h) => h.id))}`);
        } finally {
            await store.close();
        }
    });

    // PART A2 — project, LanceDB-backed VerbatimStore (smaller sweep, engine-wiring proof only)
    class LanceFixedVectorEmbedProvider extends FixedVectorEmbedProvider {
        override readonly modelId = 'e2-filter-pushdown-unit-fixed-lance';
    }
    async function buildProjectFixtureLance(junkCount: number): Promise<{ store: VerbatimStore; targetId: string }> {
        const store = new VerbatimStore(tmpWorkspace('e2-project-lance-'), new LanceFixedVectorEmbedProvider());
        await store.initialize();
        const targetId = 'target-proj-1';
        await store.store({ id: targetId, text: `TARGET the canonical answer document mentions ${RARE_TOKEN} exactly once`, metadata: { type: 'knowledge', project: 'proj-a', ecosystem: 'e1' } });
        for (let i = 0; i < 79; i++) {
            await store.store({ id: `pdist-${i}`, text: `PDIST unrelated filler row number ${i} in the right project about nothing`, metadata: { type: 'knowledge', project: 'proj-a', ecosystem: 'e1' } });
        }
        const junkTextTail = new Array(40).fill(RARE_TOKEN).join(' ');
        for (let i = 0; i < junkCount; i++) {
            await store.store({ id: `junk-${i}`, text: `JUNK distractor row ${i} ${junkTextTail}`, metadata: { type: 'knowledge', project: 'proj-b', ecosystem: 'e1' } });
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
    const LANCE_PROJECT_SWEEP = [0, RETRIEVE_WORST_CASE_WINDOW, 800];
    const lanceProjHitAt1: Record<number, string> = {};
    for (const junkCount of LANCE_PROJECT_SWEEP) {
        await test(`[Lance] project vector prefilter: hit@1 == target with ${junkCount} junk`, async () => {
            const { store, targetId } = await buildProjectFixtureLance(junkCount);
            try {
                const seedStore = await resolveSeedStore(depsForLance(store), 'ws1', false, '*', undefined, undefined, 'proj-a');
                assert.ok(seedStore);
                const hits = inProject(await seedStore!.search('anything', RETRIEVE_WORST_CASE_WINDOW));
                assert.ok(hits.length > 0);
                assert.equal(hits[0].id, targetId, `[Lance] first in-project hit must be the target, got ${hits[0].id}`);
                lanceProjHitAt1[junkCount] = hits[0].id;
            } finally {
                await store.close();
            }
        });
    }
    await test('[Lance] project vector prefilter: hit@1 IDENTICAL across every junk count', async () => {
        const values = Object.values(lanceProjHitAt1);
        assert.ok(values.length === LANCE_PROJECT_SWEEP.length);
        assert.ok(values.every((v) => v === values[0]), JSON.stringify(lanceProjHitAt1));
    });

    // PART B — entities/topics, SqliteGraph keyword leg
    for (const engineName of ['sqlite', 'surreal'] as const) {
        const entityHitAt1: Record<number, string> = {};
        for (const junkCount of ENTITY_JUNK_SWEEP) {
            await test(`[${engineName}] entities keyword prefilter: hit@1 == target with ${junkCount} junk`, async () => {
                const dir = tmpWorkspace(`e2-entities-${engineName}-`);
                const g = engineName === 'sqlite'
                    ? new SqliteGraph(dir, { workspaceId: 'e2-ent', cacheDisabled: true })
                    : new SurrealGraph(dir, { workspaceId: 'e2-ent', cacheDisabled: true });
                await g.initialize();
                try {
                    const { targetId } = await buildEntityCrowdingFixture(g, junkCount);
                    const hits = await g.search(RARE_TOKEN, 10, '*', '*', false, undefined, undefined, ['acme-corp']);
                    assert.ok(hits.length > 0, 'expected at least one hit');
                    assert.equal(hits[0].id, targetId, `[${engineName}] hit@1 must be the target, got ${hits[0].id} (entities filter must exclude 'other-corp' junk rows via the query, not post-hoc)`);
                    entityHitAt1[junkCount] = hits[0].id;
                } finally {
                    await g.close?.();
                }
            });
        }
        await test(`[${engineName}] entities keyword prefilter: hit@1 IDENTICAL across every junk count`, async () => {
            const values = Object.values(entityHitAt1);
            assert.ok(values.length === ENTITY_JUNK_SWEEP.length);
            assert.ok(values.every((v) => v === values[0]), JSON.stringify(entityHitAt1));
        });

        await test(`[${engineName}] entities negative control: WITHOUT entities filter, junk crowds target out of a small window`, async () => {
            const dir = tmpWorkspace(`e2-entities-neg-${engineName}-`);
            const g = engineName === 'sqlite'
                ? new SqliteGraph(dir, { workspaceId: 'e2-ent-neg', cacheDisabled: true })
                : new SurrealGraph(dir, { workspaceId: 'e2-ent-neg', cacheDisabled: true });
            await g.initialize();
            try {
                // The keyword-search crowding boundary is NOT the caller's
                // `limit` (unlike the vector ANN leg) — it's SEARCH_SCAN_CAP
                // (searchRanking.ts, default 2000): the SQL/SurrealQL query
                // does `ORDER BY updatedAt DESC LIMIT $scanCap` BEFORE
                // rankSearchResults ever runs, and rankSearchResults itself
                // is field-weighted (label hits always outrank content-only
                // hits, see LABEL_WEIGHT/CONTENT_WEIGHT), so no amount of
                // term repetition in junk content can out-rank the target's
                // label hit once both are inside that pre-rank window. The
                // only way to reproduce crowding-out here is to push the
                // fixture's row count PAST the scan cap so the target (the
                // oldest row — inserted before every filler/junk row, so it
                // sorts last under `updatedAt DESC`) falls outside the SQL
                // window entirely, before ranking ever sees it.
                const { targetId } = await buildEntityCrowdingFixture(g, SEARCH_SCAN_CAP + 100);
                const hits = await g.search(RARE_TOKEN, 5, '*', '*', false);
                assert.notEqual(hits[0]?.id, targetId, `[${engineName}] without an entities filter, junk past SEARCH_SCAN_CAP must crowd the target out of the pre-rank SQL window`);
            } finally {
                await g.close?.();
            }
        });

        await test(`[${engineName}] topics keyword prefilter: hit@1 == target with ${SEARCH_SCAN_CAP + 100} junk`, async () => {
            const dir = tmpWorkspace(`e2-topics-${engineName}-`);
            const g = engineName === 'sqlite'
                ? new SqliteGraph(dir, { workspaceId: 'e2-top', cacheDisabled: true })
                : new SurrealGraph(dir, { workspaceId: 'e2-top', cacheDisabled: true });
            await g.initialize();
            try {
                const { targetId } = await buildEntityCrowdingFixture(g, SEARCH_SCAN_CAP + 100);
                const hits = await g.search(RARE_TOKEN, 10, '*', '*', false, undefined, undefined, undefined, ['billing']);
                assert.ok(hits.length > 0);
                assert.equal(hits[0].id, targetId, `[${engineName}] topics hit@1 must be the target, got ${hits[0].id}`);
            } finally {
                await g.close?.();
            }
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

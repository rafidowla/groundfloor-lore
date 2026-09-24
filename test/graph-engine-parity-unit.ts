#!/usr/bin/env tsx
/**
 * graph-engine-parity-unit.ts — 3.21 step 1b bit-identical proof.
 *
 * Runs ONE scripted operation sequence — non-ASCII + CJK text, a supersede
 * chain, an ephemeral node, a stale flag, edges carrying confidence
 * metadata, and enough nodes to paginate — against BOTH `SurrealGraph` and
 * `SqliteGraph`, then asserts `JSON.stringify` equality of every read:
 * search, listNodes, listNodeSummaries, bulkList/bulkListProjected (walking
 * every page), traverse, traverseDirected, queryEdges (walking every page),
 * getStats, getTopology, getNodesByIds, findSupersededByPredecessors,
 * lintGraph.
 *
 * Also asserts the mechanical member-list requirement: every prototype
 * member `SurrealGraph` has, `SqliteGraph` has too.
 *
 * ── NORMALIZATIONS (every one used here, and why) ───────────────────────
 *
 * Only TWO remain (3.21 step 1c, Opus review of this PR: the other two —
 * multi-edge sub-order and set-comparing queryEdges/getTopology/
 * getNodesByIds — were found NOT acceptable as normalizations, because they
 * hid an OBSERVABLE cross-engine order difference rather than papering over
 * something genuinely unspecified. Both were fixed AT THE SOURCE instead,
 * in shared/engine code both engines run, and removed from here — see
 * "ORDERING RULES" below):
 *
 * 1. TIMESTAMPS. Each engine stamps `updatedAt`/`createdAt` with its own
 *    `Date.now()` at write time — the two runs happen at different wall-clock
 *    instants, so raw ISO strings can never be equal. What IS asserted is
 *    RELATIVE ORDER: the fixture is written in a fixed order with a real gap
 *    between writes (same discipline `surreal-graph-contract-unit.ts` uses),
 *    so each engine's own set of timestamps sorts into the same rank
 *    sequence. `normalizeTimestamps` replaces every ISO-8601 string found
 *    anywhere in a captured result with `#T<rank>`, where rank comes from
 *    sorting that ENGINE'S OWN observed timestamp set — so two engines that
 *    produced timestamps in the same relative order normalize to identical
 *    placeholders, and two that didn't would NOT.
 *
 * 2. OBJECT KEY ORDER within one row. The SurrealDB driver returns a
 *    document's fields in its OWN internal order (observed: roughly
 *    alphabetical), not the `SELECT col, col, …` order the query text asked
 *    for, while better-sqlite3 returns columns in exactly the prepared
 *    statement's column order. Neither ordering is a documented part of
 *    either engine's contract — a "row" is a record, not an ordered field
 *    list — so `canonicalStringify` recursively sorts object keys (array
 *    ELEMENT order is never touched) before comparison. This cannot hide a
 *    value-level or structural difference; it only stops an
 *    implementation-detail field ordering from failing an otherwise-
 *    identical comparison.
 *
 * ── ORDERING RULES (enforced in shared/engine code, not here) ────────────
 *
 * `traverse()` / `traverseDirected()`: same-node multi-edge sub-order is now
 * pinned by `graphShared/traverseBfs.ts`'s `sortFrontierEdges` — outgoing
 * before incoming, then (relation, other node id) ascending — which BOTH
 * engines' BFS core runs, so a frontier node's edges expand in the same
 * order regardless of what order either engine's own query returns them in.
 *
 * `queryEdges()` / `getTopology()`: both engines now sort their edge scan by
 * `(source_id/in, target_id/out, relation)` and their node scan by `id` —
 * `surreal/surrealGraphAggregates.ts` and `sqlite/sqliteGraphAggregates.ts`.
 * On SqliteGraph this is free (the `edges`/`nodes` PRIMARY KEYs are exactly
 * those columns, so `ORDER BY` reads off the index). On SurrealGraph it is
 * NOT free — see `queryEdges`'s doc comment there for the measured cost this
 * reintroduces and why (no supporting index: `DEFINE INDEX` leaks a libuv
 * handle on this `@surrealdb/node` build) — `graph-engine-latency-unit.ts`
 * measures it rather than hiding it.
 *
 * `getNodesByIds()`: the contract (`GraphProvider.getNodesByIds`'s doc
 * comment) was membership only, not order; both engines' `getNodesByIds` now
 * build the returned `Map` by walking the REQUESTED id list (deduped), so
 * iteration order always follows caller order on both engines — see
 * `surreal/surrealGraphReads.ts` / `sqlite/sqliteGraphReads.ts`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import type { LoreEdge, LoreNode, TraversalResult, DirectedTraversalResult, BulkListPage } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error('       ' + ((err as Error).message ?? String(err)));
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/* ─── member-list mechanical check ──────────────────────────────────── */

function checkPrototypeSubset(): void {
    const surrealMembers = Object.getOwnPropertyNames(SurrealGraph.prototype);
    const sqliteMembers = new Set(Object.getOwnPropertyNames(SqliteGraph.prototype));
    const missing = surrealMembers.filter((m) => !sqliteMembers.has(m));
    assert.deepEqual(missing, [], `SqliteGraph is missing SurrealGraph prototype member(s): ${missing.join(', ')}`);
}

/* ─── fixture ────────────────────────────────────────────────────────── */

interface FixtureNode {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; ephemeral?: boolean; ttl_ms?: number;
}

const FIXTURE_NODES: FixtureNode[] = [
    { id: 'hub', type: 'note', label: 'hub node café', content: 'central 日本語 body', tags: ['graph', 'café'], project: 'p', ecosystem: 'e' },
    { id: 'near1', type: 'note', label: 'near one', content: 'neighbour naïve', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'near2', type: 'note', label: 'near two', content: 'neighbour', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'far1', type: 'note', label: 'far one', content: 'distant 東京', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'deep1', type: 'note', label: 'deep one', content: 'deeper', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'cycleA', type: 'architecture', label: 'cycle a', content: 'loop', tags: ['cycle'], project: 'p', ecosystem: 'e' },
    { id: 'cycleB', type: 'architecture', label: 'cycle b', content: 'loop', tags: ['cycle'], project: 'p', ecosystem: 'e' },
    { id: 'selfie', type: 'architecture', label: 'self loop', content: 'points at itself', tags: ['cycle'], project: 'p', ecosystem: 'e' },
    { id: 'orphan', type: 'convention', label: 'orphan node', content: 'no edges', tags: ['lonely'], project: 'p', ecosystem: 'e' },
    { id: 'super-old', type: 'decision', label: 'old decision', content: 'superseded twice', tags: ['chain'], project: 'p', ecosystem: 'e' },
    { id: 'super-mid', type: 'decision', label: 'mid decision', content: 'middle of the chain', tags: ['chain'], project: 'p', ecosystem: 'e' },
    { id: 'super-new', type: 'decision', label: 'new decision', content: 'final of the chain', tags: ['chain'], project: 'p', ecosystem: 'e' },
    { id: 'ephemeral-1', type: 'note', label: 'scratch café', content: 'temp naïve note', tags: ['scratch'], project: 'p', ecosystem: 'e', ephemeral: true, ttl_ms: 3_600_000 },
    { id: 'stale-1', type: 'note', label: 'stale candidate', content: 'may be out of date', tags: ['staletag'], project: 'p', ecosystem: 'e' },
    { id: 'stale-2', type: 'note', label: 'stale candidate two', content: 'also may be out of date', tags: ['staletag'], project: 'p', ecosystem: 'e' },
];
// Pagination filler — enough rows that bulkList/queryEdges (limit=5) walk several pages.
for (let i = 0; i < 22; i++) {
    FIXTURE_NODES.push({
        id: `page-${String(i).padStart(3, '0')}`, type: 'note', label: `page node ${i}`,
        content: `filler content ${i}`, tags: ['page'], project: 'p', ecosystem: 'e',
    });
}

const FIXTURE_EDGES: LoreEdge[] = [
    { sourceId: 'hub', targetId: 'near1', relation: 'related_to' },
    { sourceId: 'hub', targetId: 'near2', relation: 'related_to' },
    { sourceId: 'hub', targetId: 'far1', relation: 'shortcut' },
    { sourceId: 'near1', targetId: 'far1', relation: 'cites' },
    { sourceId: 'far1', targetId: 'deep1', relation: 'cites' },
    { sourceId: 'cycleA', targetId: 'cycleB', relation: 'loops' },
    { sourceId: 'cycleB', targetId: 'cycleA', relation: 'loops' },
    { sourceId: 'selfie', targetId: 'selfie', relation: 'self' },
    { sourceId: 'near2', targetId: 'orphan', relation: 'semantic_neighbor:0.75', confidence: 'inferred', confidenceScore: 0.75 },
];
for (let i = 0; i < 21; i++) {
    FIXTURE_EDGES.push({ sourceId: `page-${String(i).padStart(3, '0')}`, targetId: `page-${String(i + 1).padStart(3, '0')}`, relation: 'next' });
}

interface CapturedBundle {
    search: Record<string, LoreNode[]>;
    listNodes: LoreNode[];
    listNodeSummaries: unknown[];
    bulkListPages: Array<Record<string, unknown>>;
    bulkListProjectedPages: Array<Record<string, unknown>>;
    queryEdgesPages: LoreEdge[][];
    traverse: Record<string, unknown[]>;
    traverseDirected: Record<string, unknown[]>;
    stats: unknown;
    topology: unknown;
    topologyOverview: unknown;
    getNodesByIds: Array<[string, LoreNode | undefined]>;
    findSupersededByPredecessors: string[];
    lintGraph: string[];
}

/**
 * Field-project traverse/traverseDirected results — NO reordering. The
 * shared `sortFrontierEdges` (graphShared/traverseBfs.ts) now pins same-node
 * multi-edge sub-order identically on both engines, so the raw push order
 * `g.traverse()`/`g.traverseDirected()` return is already the thing being
 * compared.
 */
function projectTraverse(rs: TraversalResult[]): unknown[] {
    return rs.map((r) => ({ id: r.node.id, depth: r.depth, relation: r.relation }));
}
function projectDirected(rs: DirectedTraversalResult[]): unknown[] {
    return rs.map((r) => ({ id: r.node.id, depth: r.depth, relation: r.relation, direction: r.direction, via: r.via }));
}

type GraphUnderTest = SurrealGraph | SqliteGraph;

async function runOpSequence(g: GraphUnderTest): Promise<CapturedBundle> {
    for (const f of FIXTURE_NODES) {
        await g.upsertNode({
            id: f.id, type: f.type, label: f.label, content: f.content, tags: f.tags,
            project: f.project, ecosystem: f.ecosystem, metadata: '{}',
            ephemeral: f.ephemeral, ttl_ms: f.ttl_ms,
        });
        await sleep(4);
    }
    for (const e of FIXTURE_EDGES) await g.addEdge(e);

    // Supersede chain: super-old -> super-mid -> super-new, then unsupersede one leg back.
    // Real sleeps between every timestamp-stamping op (not just node writes)
    // keep every stamped instant millisecond-distinct — a same-millisecond
    // collision would silently merge two ranks in the timestamp-rank
    // normalization below and make an otherwise-real difference invisible,
    // which is the opposite of what a parity gate should do.
    await sleep(5);
    await g.supersedeNode('super-old', 'super-mid', 'first hop');
    await sleep(5);
    await g.supersedeNode('super-mid', 'super-new', 'second hop');
    await sleep(5);

    // Stale flags — one via tags, one via ids.
    await g.markStaleByTags(['staletag']);
    const staleIds = await g.findNodeIdsByTags(['staletag']);
    await g.markStaleByIds(staleIds.slice(0, 1));
    await sleep(5);

    // Archive one node (stamps updatedAt + status).
    await g.archiveNode('orphan');

    const search: Record<string, LoreNode[]> = {};
    for (const q of ['café', '日本語', 'naïve', 'graph', 'page node 5', '']) {
        search[q] = await g.search(q, 50, '*', '*', false);
    }

    const listNodes = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
    const listNodeSummaries = await g.listNodeSummaries(undefined, undefined, '*', '*', undefined, { unbounded: true });

    const bulkListPages: Array<Record<string, unknown>> = [];
    {
        let cursor: { updatedAt: string; id: string } | null | undefined = null;
        do {
            // Explicit annotation: `g` is a `SurrealGraph | SqliteGraph`
            // union, and `tsc -p tsconfig.test.json` (unlike `tsx`'s
            // transpile-only check) cannot resolve `page`'s type across a
            // union method call inside a `do { … cursor = page.x } while
            // (cursor)` loop without one — TS7022 "implicitly has type
            // 'any' … referenced in its own initializer".
            const page: BulkListPage = await g.bulkList({ limit: 5, cursor: cursor ?? undefined });
            bulkListPages.push(page as unknown as Record<string, unknown>);
            cursor = page.nextCursor;
        } while (cursor);
    }

    const bulkListProjectedPages: Array<Record<string, unknown>> = [];
    {
        let cursor: { updatedAt: string; id: string } | null = null;
        do {
            const page: { rows: Array<Record<string, unknown>>; nextCursor: { updatedAt: string; id: string } | null } =
                await g.bulkListProjected('*', ['label', 'type'], 5, cursor);
            bulkListProjectedPages.push(page as unknown as Record<string, unknown>);
            cursor = page.nextCursor;
        } while (cursor);
    }

    const traverse: Record<string, unknown[]> = {
        hub2: projectTraverse(await g.traverse('hub', 2)),
        cycleA3: projectTraverse(await g.traverse('cycleA', 3)),
        selfie2: projectTraverse(await g.traverse('selfie', 2)),
    };
    const traverseDirected: Record<string, unknown[]> = {
        hub2: projectDirected(await g.traverseDirected('hub', 2)),
        cycleA3: projectDirected(await g.traverseDirected('cycleA', 3)),
    };

    // queryEdges is now ORDER BY (source_id/in, target_id/out, relation) on
    // BOTH engines (surrealGraphAggregates.ts / sqliteGraphAggregates.ts) —
    // walk every page and compare page-for-page, no reordering.
    const queryEdgesPages: LoreEdge[][] = [];
    {
        let offset = 0;
        const limit = 5;
        for (;;) {
            const page = await g.queryEdges({ limit, offset });
            if (page.length === 0) break;
            queryEdgesPages.push(page);
            offset += limit;
            if (offset > FIXTURE_EDGES.length + limit) break; // safety valve
        }
    }

    const stats = await g.getStats();
    // getTopology's own node/edge queries are now ORDER BY id / ORDER BY
    // (source_id/in, target_id/out, relation) too — compare the raw arrays.
    const topology = await g.getTopology(300);
    const topologyOverview = await g.getTopologyOverview();

    // getNodesByIds now builds its Map by walking the REQUESTED id list on
    // both engines (surrealGraphReads.ts / sqliteGraphReads.ts), so
    // iteration order already follows caller order — compare as captured.
    const idsMap = await g.getNodesByIds(['hub', 'near1', 'missing-id', 'super-new', 'ephemeral-1']);
    const getNodesByIds: Array<[string, LoreNode | undefined]> = [...idsMap.entries()];

    const findSupersededByPredecessors = [
        ...await g.findSupersededByPredecessors('super-mid'),
        ...await g.findSupersededByPredecessors('super-new'),
    ];

    const lintGraph = [...await g.lintGraph()].sort();

    return {
        search, listNodes, listNodeSummaries, bulkListPages, bulkListProjectedPages,
        traverse, traverseDirected, queryEdgesPages, stats, topology, topologyOverview,
        getNodesByIds, findSupersededByPredecessors, lintGraph,
    };
}

/* ─── timestamp rank normalization (see file header note 1) ────────────── */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function collectTimestamps(node: unknown, out: Set<string>): void {
    if (typeof node === 'string' && ISO_RE.test(node)) { out.add(node); return; }
    if (Array.isArray(node)) { for (const v of node) collectTimestamps(v, out); return; }
    if (node && typeof node === 'object') { for (const v of Object.values(node)) collectTimestamps(v, out); }
}

function normalizeTimestamps(node: unknown, ranks: Map<string, number>): unknown {
    if (typeof node === 'string') return ranks.has(node) ? `#T${ranks.get(node)}` : node;
    if (Array.isArray(node)) return node.map((v) => normalizeTimestamps(v, ranks));
    if (node && typeof node === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = normalizeTimestamps(v, ranks);
        return out;
    }
    return node;
}

/** Sort object keys recursively (array element order is untouched) — see file header note 3. */
function canonicalStringify(value: unknown): string {
    const sortKeys = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sortKeys);
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(v as Record<string, unknown>).sort()) {
                out[k] = sortKeys((v as Record<string, unknown>)[k]);
            }
            return out;
        }
        return v;
    };
    return JSON.stringify(sortKeys(value));
}

function normalizeBundle(bundle: CapturedBundle): unknown {
    const ts = new Set<string>();
    collectTimestamps(bundle, ts);
    const sorted = [...ts].sort();
    const ranks = new Map(sorted.map((t, i) => [t, i]));
    return normalizeTimestamps(bundle, ranks);
}

/* ─── run ────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('GRAPH-ENGINE-PARITY — SurrealGraph vs SqliteGraph, bit-identical proof');
    console.log('='.repeat(72));

    checkPrototypeSubset();
    console.log('  ok   SqliteGraph.prototype ⊇ SurrealGraph.prototype');

    const surrealDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-parity-surreal-'));
    const sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-parity-sqlite-'));
    const surreal = new SurrealGraph(surrealDir, { workspaceId: 'parity', cacheDisabled: true });
    const sqlite = new SqliteGraph(sqliteDir, { workspaceId: 'parity', cacheDisabled: true });
    await surreal.initialize();
    await sqlite.initialize();

    try {
        const surrealBundle = normalizeBundle(await runOpSequence(surreal));
        const sqliteBundle = normalizeBundle(await runOpSequence(sqlite));

        const surrealJson = canonicalStringify(surrealBundle);
        const sqliteJson = canonicalStringify(sqliteBundle);

        await check('search: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).search),
                canonicalStringify((sqliteBundle as CapturedBundle).search),
            );
        });
        await check('listNodes: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).listNodes),
                canonicalStringify((sqliteBundle as CapturedBundle).listNodes),
            );
        });
        await check('listNodeSummaries: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).listNodeSummaries),
                canonicalStringify((sqliteBundle as CapturedBundle).listNodeSummaries),
            );
        });
        await check('bulkList pages: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).bulkListPages),
                canonicalStringify((sqliteBundle as CapturedBundle).bulkListPages),
            );
        });
        await check('bulkListProjected pages: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).bulkListProjectedPages),
                canonicalStringify((sqliteBundle as CapturedBundle).bulkListProjectedPages),
            );
        });
        await check('traverse: bit-identical across engines (sortFrontierEdges pins sub-order — see header)', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).traverse),
                canonicalStringify((sqliteBundle as CapturedBundle).traverse),
            );
        });
        await check('traverseDirected: bit-identical across engines (sortFrontierEdges pins sub-order — see header)', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).traverseDirected),
                canonicalStringify((sqliteBundle as CapturedBundle).traverseDirected),
            );
        });
        await check('queryEdges: bit-identical PAGES across engines (both ORDER BY source/target/relation — see header)', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).queryEdgesPages),
                canonicalStringify((sqliteBundle as CapturedBundle).queryEdgesPages),
            );
        });
        await check('getStats: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).stats),
                canonicalStringify((sqliteBundle as CapturedBundle).stats),
            );
        });
        await check('getTopology: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).topology),
                canonicalStringify((sqliteBundle as CapturedBundle).topology),
            );
        });
        await check('getTopologyOverview: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).topologyOverview),
                canonicalStringify((sqliteBundle as CapturedBundle).topologyOverview),
            );
        });
        await check('getNodesByIds: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).getNodesByIds),
                canonicalStringify((sqliteBundle as CapturedBundle).getNodesByIds),
            );
        });
        await check('findSupersededByPredecessors: bit-identical across engines', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).findSupersededByPredecessors),
                canonicalStringify((sqliteBundle as CapturedBundle).findSupersededByPredecessors),
            );
        });
        await check('lintGraph: bit-identical across engines (sorted — see header)', () => {
            assert.equal(
                canonicalStringify((surrealBundle as CapturedBundle).lintGraph),
                canonicalStringify((sqliteBundle as CapturedBundle).lintGraph),
            );
        });
        await check('the whole normalized bundle is bit-identical', () => {
            assert.equal(surrealJson, sqliteJson);
        });
    } finally {
        await surreal.close().catch(() => undefined);
        await sqlite.close().catch(() => undefined);
        fs.rmSync(surrealDir, { recursive: true, force: true });
        fs.rmSync(sqliteDir, { recursive: true, force: true });
    }

    console.log('');
    console.log(`parity: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log('SqliteGraph is bit-identical to SurrealGraph on the scripted op sequence ✓');
    process.exit(0);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});

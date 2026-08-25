#!/usr/bin/env tsx
/**
 * surreal-graph-contract-unit.ts — embedded SurrealDB graph correctness
 * against the W0-SEARCH-CONTRACT.
 *
 * Born as `parity-surreal-graph-unit.ts` (Kùzu vs SurrealDB parity, Phase 2
 * of the engine evaluation). The Kùzu side died with the engine removal, but
 * the Surreal-side assertions carry the real regression coverage — search
 * ordering, traversal depth/diamond/cycle/self-loop/leaf semantics, directed
 * walks, pagination cursors, lifecycle verbs, aggregate shapes, and the
 * write-path contracts — so this file keeps every one of them as ABSOLUTE
 * expectations derived from the fixture, instead of equality against a second
 * engine. Where the old harness compared two engines, this one compares
 * SurrealGraph against the contract and the fixture's ground truth.
 *
 * Order and coercion
 * ------------------
 * Search ordering routes through the SHARED `rankSearchResults`
 * (`engines/searchRanking.ts`) and node rows through the SHARED
 * `rowToLoreNode` (`engines/loreNodeRow.js`), so the asserted id SEQUENCES are
 * the contracted ones: relevance desc → updatedAt desc → id asc. Multi-hop
 * traversal gets its own section — ordering, depth-limit edges, cycles,
 * diamonds, self-loops, leaf walks — each asserted separately rather than
 * folded into one "traverse works" case.
 *
 * Timestamps
 * ----------
 * The engine stamps `updatedAt = now()` on write and there is no raw-SQL back
 * door on SurrealGraph, so the fixture is loaded in a fixed order with a real
 * gap between writes, giving a deterministic RELATIVE ordering — which is all
 * the contracted tie-break (updatedAt desc) compares. The ordering is
 * asserted, not assumed, so a coalesced-clock flake fails loudly instead of
 * silently weakening every order assertion below. (Lifecycle probes:
 * supersede/unsupersede deliberately do NOT stamp updatedAt; archiveNode
 * does — both asserted below.)
 *
 * Run: npx tsx test/surreal-graph-contract-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { LoreEdge, LoreNode, TraversalResult } from '../packages/lore/src/providers/types.js';

/* ─── harness ────────────────────────────────────────────────────── */

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
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    setTimeout(resolve, ms);
    return promise;
}

const ids = (nodes: Array<{ id: string }>): string[] => nodes.map((n) => n.id);
const idSet = (nodes: Array<{ id: string }>): Set<string> => new Set(ids(nodes));

function assertSameSet(a: Set<string>, b: Set<string>, msg: string): void {
    const aOnly = [...a].filter((x) => !b.has(x));
    const bOnly = [...b].filter((x) => !a.has(x));
    assert.ok(
        aOnly.length === 0 && bOnly.length === 0,
        `${msg}: got=[${[...a].join(',')}] expected=[${[...b].join(',')}]`,
    );
}

const depthMap = (rs: TraversalResult[]): Map<string, number> =>
    new Map(rs.map((r) => [r.node.id, r.depth]));

/* ─── fixture ────────────────────────────────────────────────────── */

/**
 * Fixture, deliberately shaped so every contracted behaviour has something
 * to disagree about:
 *
 * Search relevance (query "kappa"):
 *   kappa-label-content — label AND content       → score 6
 *   kappa-label-newer   — label only, written later → score 4
 *   kappa-label-older   — label only, written earlier → score 4
 *   kappa-tag-only      — EXACT tag only          → score 1
 *   no-match            — never matches
 *   other-project       — label AND content, but project q / ecosystem f
 *
 * Graph shape (traversal):
 *   hub → near1 → far1 → deep1 → deep2 → deep3   (a 5-hop chain)
 *   hub → near2                                   (a second depth-1 branch)
 *   hub → far1                                    (a DIAMOND: far1 is
 *                                                  reachable at depth 1 and 2)
 *   cycleA ↔ cycleB ↔ cycleC → cycleA             (a 3-cycle)
 *   selfie → selfie                               (a self-loop)
 *
 * Written oldest-first so `updatedAt` ascends with array order.
 */
interface Fixture {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string;
}

const FIXTURE_NODES: Fixture[] = [
    { id: 'kappa-label-content', type: 'note', label: 'kappa header', content: 'about kappa things', tags: ['x'], project: 'p', ecosystem: 'e' },
    { id: 'kappa-tag-only', type: 'note', label: 'plain header', content: 'unrelated to the topic', tags: ['kappa'], project: 'p', ecosystem: 'e' },
    { id: 'kappa-label-older', type: 'note', label: 'a kappa', content: 'unrelated body', tags: ['z'], project: 'p', ecosystem: 'e' },
    { id: 'kappa-label-newer', type: 'note', label: 'the kappa', content: 'unrelated body', tags: ['y'], project: 'p', ecosystem: 'e' },
    { id: 'no-match', type: 'decision', label: 'nope', content: 'nothing here', tags: ['none'], project: 'p', ecosystem: 'e' },
    { id: 'other-project', type: 'note', label: 'kappa elsewhere', content: 'kappa body', tags: ['x'], project: 'q', ecosystem: 'f' },
    { id: 'hub', type: 'note', label: 'hub node', content: 'central', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'near1', type: 'note', label: 'near one', content: 'neighbour', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'near2', type: 'note', label: 'near two', content: 'neighbour', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'far1', type: 'note', label: 'far one', content: 'distant', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'deep1', type: 'note', label: 'deep one', content: 'deeper', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'deep2', type: 'note', label: 'deep two', content: 'deeper', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'deep3', type: 'note', label: 'deep three', content: 'deepest', tags: ['graph'], project: 'p', ecosystem: 'e' },
    { id: 'cycleA', type: 'architecture', label: 'cycle a', content: 'loop', tags: ['cycle'], project: 'p', ecosystem: 'e' },
    { id: 'cycleB', type: 'architecture', label: 'cycle b', content: 'loop', tags: ['cycle'], project: 'p', ecosystem: 'e' },
    { id: 'cycleC', type: 'architecture', label: 'cycle c', content: 'loop', tags: ['cycle'], project: 'p', ecosystem: 'e' },
    { id: 'selfie', type: 'architecture', label: 'self loop', content: 'points at itself', tags: ['cycle'], project: 'p', ecosystem: 'e' },
    { id: 'orphan', type: 'convention', label: 'orphan node', content: 'no edges', tags: ['lonely'], project: 'p', ecosystem: 'e' },
];

const FIXTURE_EDGES: LoreEdge[] = [
    { sourceId: 'hub', targetId: 'near1', relation: 'related_to' },
    { sourceId: 'hub', targetId: 'near2', relation: 'related_to' },
    { sourceId: 'near1', targetId: 'far1', relation: 'cites' },
    // Diamond: far1 is ALSO a direct neighbour of hub, so its minimum depth is 1.
    { sourceId: 'hub', targetId: 'far1', relation: 'shortcut' },
    { sourceId: 'far1', targetId: 'deep1', relation: 'cites' },
    { sourceId: 'deep1', targetId: 'deep2', relation: 'cites' },
    { sourceId: 'deep2', targetId: 'deep3', relation: 'cites' },
    { sourceId: 'cycleA', targetId: 'cycleB', relation: 'loops' },
    { sourceId: 'cycleB', targetId: 'cycleC', relation: 'loops' },
    { sourceId: 'cycleC', targetId: 'cycleA', relation: 'loops' },
    { sourceId: 'selfie', targetId: 'selfie', relation: 'self' },
    // Confidence-tagged edge: the tier + score must survive storage.
    { sourceId: 'near2', targetId: 'orphan', relation: 'semantic_neighbor:0.75', confidence: 'inferred', confidenceScore: 0.75 },
];

const FIXTURE_BY_ID = new Map(FIXTURE_NODES.map((f) => [f.id, f]));

/** The fixture's updatedAt ordering: array order, ascending. */
const FIXTURE_NEWEST_FIRST = [...FIXTURE_NODES].map((f) => f.id).reverse();

interface GraphLike {
    upsertNode(n: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode>;
    addEdge(e: LoreEdge): Promise<void>;
}

/**
 * Load the fixture in a fixed order with a real gap between writes, so
 * `updatedAt` ascends with array order. 4 ms is comfortably above the
 * ISO-8601 millisecond resolution the engine stamps at.
 */
async function loadFixture(g: GraphLike): Promise<void> {
    for (const f of FIXTURE_NODES) {
        await g.upsertNode({
            id: f.id, type: f.type, label: f.label, content: f.content, tags: f.tags,
            project: f.project, ecosystem: f.ecosystem, metadata: '{}',
        });
        await sleep(4);
    }
    for (const e of FIXTURE_EDGES) await g.addEdge(e);
}

/** Every fixture edge, normalized to the stored shape (confidence defaults). */
const fixtureEdgeKeys = (): string[] => FIXTURE_EDGES
    .map((e) => `${e.sourceId}|${e.relation}|${e.targetId}|${e.confidence ?? 'extracted'}|${e.confidenceScore ?? 1}`)
    .sort();

/* ─── run ────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('SURREAL-GRAPH-CONTRACT — embedded SurrealDB vs the W0-SEARCH-CONTRACT');
    console.log('SEARCH_CONTRACT_VERSION = 1');
    console.log('='.repeat(72));

    const surrealDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-contract-'));

    // cacheDisabled: assert ENGINE answers, not a memoization layer.
    const g = new SurrealGraph(surrealDir, { workspaceId: 'contract', cacheDisabled: true });
    await g.initialize();

    try {
        await loadFixture(g);

        /* ── 0. the fixture's own precondition ──────────────────────── */

        await check('fixture: updatedAt ascends with write order', async () => {
            const all = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
            const byId = new Map(all.map((n) => [n.id, n.updatedAt]));
            for (let i = 1; i < FIXTURE_NODES.length; i++) {
                const prev = byId.get(FIXTURE_NODES[i - 1]!.id)!;
                const cur = byId.get(FIXTURE_NODES[i]!.id)!;
                assert.ok(prev < cur,
                    `${FIXTURE_NODES[i - 1]!.id} (${prev}) must precede ${FIXTURE_NODES[i]!.id} (${cur}) `
                    + '— the clock coalesced; every order assertion below depends on this');
            }
        });

        /* ── 1. node reads: field-for-field against the fixture ─────── */

        await check('getNode: every fixture node hydrated field-for-field', async () => {
            for (const f of FIXTURE_NODES) {
                const n = await g.getNode(f.id);
                assert.ok(n, `getNode(${f.id}) returned a node`);
                assert.equal(n!.id, f.id);
                assert.equal(n!.type, f.type, `${f.id}.type`);
                assert.equal(n!.label, f.label, `${f.id}.label`);
                assert.equal(n!.content, f.content, `${f.id}.content`);
                assert.deepEqual(n!.tags, f.tags, `${f.id}.tags`);
                assert.equal(n!.project, f.project, `${f.id}.project`);
                assert.equal(n!.ecosystem, f.ecosystem, `${f.id}.ecosystem`);
                assert.equal(n!.metadata, '{}', `${f.id}.metadata`);
                assert.equal(n!.syncedAt, null, `${f.id}.syncedAt null`);
                // Engine-managed lifecycle fields, at their fresh-write defaults.
                const wide = n as unknown as Record<string, unknown>;
                assert.notEqual(wide['stale'], true, `${f.id}.stale`);
                assert.equal(wide['classification'], 'tactical', `${f.id}.classification`);
                assert.equal(n!.supersededBy, null, `${f.id}.supersededBy null`);
                assert.ok(n!.createdAt, `${f.id}.createdAt stamped`);
                assert.ok(n!.updatedAt, `${f.id}.updatedAt stamped`);
            }
        });

        await check('getNode(missing): null', async () => {
            assert.equal(await g.getNode('ghost'), null);
        });

        await check('getNodesByIds: exact map, missing ids omitted', async () => {
            const m = await g.getNodesByIds(['hub', 'near1', 'ghost', 'orphan']);
            assertSameSet(new Set(m.keys()), new Set(['hub', 'near1', 'orphan']), 'getNodesByIds key set');
            assert.equal(m.has('ghost'), false, 'missing id omitted');
        });

        /* ── 2. search: the contracted id SEQUENCE ──────────────────── */

        await check('search("kappa"): contracted id SEQUENCE (relevance desc → updatedAt desc)', async () => {
            const s = await g.search('kappa', 50);
            assert.deepEqual(ids(s), [
                // Both score 6 (label + content); `other-project` is written
                // later in the fixture, so updatedAt-desc puts it first.
                'other-project',
                'kappa-label-content',
                'kappa-label-newer',    // label only     → score 4, newer
                'kappa-label-older',    // label only     → score 4, older
                'kappa-tag-only',       // exact tag only → score 1
            ], 'the shared ranker must produce the contracted order');
        });

        await check('search: hydrated nodes, not just ids', async () => {
            const s = await g.search('kappa', 50);
            for (const hit of s) {
                const direct = await g.getNode(hit.id);
                assert.deepEqual(hit, direct, `search hit ${hit.id} equals getNode row`);
            }
        });

        await check('search limit: caps at `limit` and keeps the contracted prefix', async () => {
            const full = ids(await g.search('kappa', 50));
            for (const limit of [1, 2, 3]) {
                const s = await g.search('kappa', limit);
                assert.equal(s.length, limit, `respects limit ${limit}`);
                assert.deepEqual(ids(s), full.slice(0, limit), `limit ${limit} prefix`);
            }
        });

        await check('search(project scope): excludes other projects', async () => {
            const s = await g.search('kappa', 50, 'p');
            assert.deepEqual(ids(s), [
                'kappa-label-content', 'kappa-label-newer', 'kappa-label-older', 'kappa-tag-only',
            ]);
            assert.equal(s.some((n) => n.id === 'other-project'), false, 'scope excludes project q');
        });

        await check('search(ecosystem scope): only the matching ecosystem', async () => {
            assert.deepEqual(ids(await g.search('kappa', 50, '*', 'f')), ['other-project']);
        });

        await check('search(excludeHidden): superseded node hidden, then restored', async () => {
            await g.supersedeNode('kappa-label-older', 'kappa-label-newer', 'contract');
            const s = await g.search('kappa', 50, '*', '*', true);
            assert.deepEqual(ids(s), [
                'other-project', 'kappa-label-content', 'kappa-label-newer', 'kappa-tag-only',
            ]);
            assert.equal(s.some((n) => n.id === 'kappa-label-older'), false, 'superseded node hidden');
            // Restore for the sections below.
            await g.unsupersedeNode('kappa-label-older');
        });

        await check('search(no match): empty', async () => {
            assert.deepEqual(await g.search('zzzz-nothing', 50), []);
        });

        await check('search is case-insensitive', async () => {
            const s = await g.search('KAPPA', 50);
            assert.deepEqual(ids(s), ids(await g.search('kappa', 50)));
            assert.ok(s.length > 0, 'uppercase query still matches');
        });

        await check('search tag matching: EXACT membership (documented gap)', async () => {
            // Tags match by exact membership, not substring — the known
            // local-vs-cloud divergence, deliberately kept on the local engine.
            assert.ok(ids(await g.search('kappa', 50)).includes('kappa-tag-only'),
                'exact tag matches');
            assert.equal(ids(await g.search('kapp', 50)).includes('kappa-tag-only'), false,
                'substring-within-a-tag must NOT match');
        });

        await check('search SUBSTRING (prefix) — the FTS tripwire', async () => {
            // `search` matches SUBSTRINGS today, so 'kapp' finds 'kappa header'.
            // A full-text index matches whole WORDS and would find nothing — so
            // THIS is the case that tells you whether an FTS acceleration
            // silently changed behaviour. Without it the suite passes under FTS
            // by accident, because every other fixture query happens to be a
            // complete word.
            const s = await g.search('kapp', 50);
            assert.ok(s.length > 0, 'prefix substring must match');
            assert.ok(ids(s).includes('kappa-label-content'), 'label prefix hit present');
            assert.deepEqual(ids(s), [
                'other-project', 'kappa-label-content', 'kappa-label-newer', 'kappa-label-older',
            ], 'prefix matches rank by the contract');
        });

        await check('search SUBSTRING (mid-word)', async () => {
            // 'eader' sits inside both "kappa header" and "plain header";
            // equal scores, so updatedAt-desc orders tag-only (written later)
            // first.
            assert.deepEqual(ids(await g.search('eader', 50)), ['kappa-tag-only', 'kappa-label-content']);
        });

        await check('search SUBSTRING (multi-word query: any term may hit)', async () => {
            // 'kappa head' matches "kappa header" via BOTH terms and "plain
            // header" via the second — term-OR substring semantics.
            assert.deepEqual(ids(await g.search('kappa head', 50)), ['kappa-label-content', 'kappa-tag-only']);
        });

        await check('search SUBSTRING (inside content)', async () => {
            assert.deepEqual(ids(await g.search('nrelated', 50)),
                ['kappa-label-newer', 'kappa-label-older', 'kappa-tag-only']);
        });

        /* ── 3. multi-hop traversal ─────────────────────────────────── */

        await check('traverse(hub, 1): reachable set and per-node depth', async () => {
            const s = await g.traverse('hub', 1);
            assertSameSet(idSet(s.map((r) => r.node)), new Set(['near1', 'near2', 'far1']), 'depth-1 set');
            const dm = depthMap(s);
            assert.equal(dm.get('near1'), 1, 'near1 depth 1');
            assert.equal(dm.get('near2'), 1, 'near2 depth 1');
            assert.equal(dm.get('far1'), 1, 'far1 depth 1 via the shortcut');
        });

        await check('traverse(hub, 3): the depth limit bites at deep3', async () => {
            const s = await g.traverse('hub', 3);
            assertSameSet(idSet(s.map((r) => r.node)), new Set(['near1', 'near2', 'far1', 'deep1', 'deep2', 'orphan']), 'depth-3 set');
            const dm = depthMap(s);
            assert.equal(dm.get('deep1'), 2, 'deep1 depth 2');
            assert.equal(dm.get('deep2'), 3, 'deep2 depth 3');
        });

        await check('traverse(hub, 5): the 5-hop chain completes', async () => {
            const s = await g.traverse('hub', 5);
            assertSameSet(idSet(s.map((r) => r.node)), new Set(['near1', 'near2', 'far1', 'deep1', 'deep2', 'deep3', 'orphan']), 'depth-5 set');
            assert.equal(depthMap(s).get('deep3'), 4, 'deepest node at its minimum depth');
        });

        /* ── 3b. DIRECTED traversal — direction, which traverse() discards ── */

        await check('traverseDirected(hub, 1): same node set as traverse(), all OUTgoing', async () => {
            const d = await g.traverseDirected('hub', 1);
            const merged = await g.traverse('hub', 1);
            assertSameSet(idSet(d.map((r) => r.node)), idSet(merged.map((r) => r.node)), 'directed and merged walks reach the same nodes');
            for (const r of d) {
                assert.equal(r.direction, 'out', `${r.node.id} is OUTgoing from hub`);
                assert.equal(r.via, 'hub', 'reached via the seed');
            }
            const relations = new Map(d.map((r) => [r.node.id, r.relation]));
            assert.equal(relations.get('near1'), 'related_to');
            assert.equal(relations.get('near2'), 'related_to');
            assert.equal(relations.get('far1'), 'shortcut');
        });

        await check('traverseDirected: every reported edge is a real fixture edge, correctly oriented', async () => {
            const fixturePairs = new Set(FIXTURE_EDGES.map((e) => `${e.sourceId}>${e.relation}>${e.targetId}`));
            for (const depth of [1, 2, 3]) {
                const rows = await g.traverseDirected('hub', depth);
                assert.ok(rows.length > 0, `depth-${depth} returns rows`);
                for (const r of rows) {
                    const forward = `${r.via}>${r.relation}>${r.node.id}`;
                    const backward = `${r.node.id}>${r.relation}>${r.via}`;
                    if (r.direction === 'out') {
                        assert.ok(fixturePairs.has(forward),
                            `depth-${depth}: reported ${forward} (out) is not a fixture edge`);
                    } else {
                        assert.ok(fixturePairs.has(backward),
                            `depth-${depth}: reported ${backward} (in) is not a fixture edge`);
                    }
                }
            }
        });

        await check('traverseDirected: direction is CORRECT (hub→near1 is out from hub)', async () => {
            const rows = await g.traverseDirected('hub', 1);
            const near1 = rows.find((r) => r.node.id === 'near1');
            assert.ok(near1, 'near1 reached');
            assert.equal(near1!.direction, 'out', 'hub->near1 is OUTgoing from hub');
            assert.equal(near1!.via, 'hub', 'reached via hub');
        });

        await check('traverseDirected: the REVERSE seed reports the same edge as incoming', async () => {
            // Walking from the far end must label the identical edge 'in'. If
            // direction were merged or inverted, this and the check above could
            // not both hold.
            const rows = await g.traverseDirected('near1', 1);
            const back = rows.find((r) => r.node.id === 'hub');
            assert.ok(back, 'hub reachable from near1');
            assert.equal(back!.direction, 'in', 'hub->near1 read from near1 is INcoming');
            const fwd = rows.find((r) => r.node.id === 'far1');
            assert.ok(fwd, 'far1 reachable from near1');
            assert.equal(fwd!.direction, 'out', 'near1->far1 is OUTgoing from near1');
        });

        await check('traverseDirected: nodes are fully hydrated, not id-only stubs', async () => {
            const rows = await g.traverseDirected('hub', 1);
            for (const r of rows) {
                assert.ok(r.node.type, `${r.node.id} has a type`);
                assert.ok(r.node.label, `${r.node.id} has a label`);
                assert.equal(r.node.content, FIXTURE_BY_ID.get(r.node.id)?.content, `${r.node.id} content hydrated`);
            }
        });

        /* ── 3c. listNodeSummaries — narrower rows ──────────────────── */

        await check('listNodeSummaries: same ids and order as listNodes, three fields', async () => {
            const full = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
            const slim = await g.listNodeSummaries(undefined, undefined, '*', '*', undefined, { unbounded: true });
            assert.deepEqual(slim.map((n) => n.id), full.map((n) => n.id), 'same ids, same order');
            for (const row of slim) assert.deepEqual(Object.keys(row).sort(), ['id', 'label', 'type']);
        });

        await check('listNodeSummaries({ordered:false}): same SET, order not promised', async () => {
            // The unordered variant exists because the sort, not the
            // projection, dominates on SurrealDB (389.8ms -> 133.9ms over
            // 19,237 nodes). It promises the same row SET, deliberately not
            // the same sequence.
            const slim = await g.listNodeSummaries(undefined, undefined, '*', '*', undefined,
                { unbounded: true, ordered: false });
            const ordered = await g.listNodeSummaries(undefined, undefined, '*', '*', undefined,
                { unbounded: true });
            assertSameSet(new Set(slim.map((n) => n.id)), new Set(ordered.map((n) => n.id)), 'unordered id set');
        });

        await check('listNodeSummaries(type=note): exactly the note fixtures', async () => {
            const slim = await g.listNodeSummaries('note', undefined, '*', '*', undefined, { unbounded: true });
            assertSameSet(new Set(slim.map((n) => n.id)),
                new Set(FIXTURE_NODES.filter((f) => f.type === 'note').map((f) => f.id)),
                'type-filtered summaries');
        });

        /* ── bulkListProjected: the engine-agnostic maintenance scan ────── */

        await check('bulkListProjected: first page is the contracted (updatedAt DESC) head', async () => {
            // Order is contractual here (updatedAt DESC, id ASC) because it IS
            // the cursor: a wrong order does not merely differ, it pages
            // differently and skips rows.
            const page = await g.bulkListProjected('*', ['type', 'label'], 3, null);
            assert.deepEqual(page.rows.map((r) => String(r['id'])), FIXTURE_NEWEST_FIRST.slice(0, 3),
                'first page is the three newest fixture nodes');
            assert.deepEqual(
                page.rows.map((r) => `${String(r['id'])}|${String(r['type'])}|${String(r['label'])}`),
                FIXTURE_NEWEST_FIRST.slice(0, 3).map((id) => {
                    const f = FIXTURE_BY_ID.get(id)!;
                    return `${id}|${f.type}|${f.label}`;
                }),
                'projected columns carry fixture truth',
            );
        });

        await check('bulkListProjected: the cursor walks to exhaustion, no gaps, no repeats', async () => {
            // Paging to exhaustion, two rows at a time, is the only way to
            // catch a cursor that is subtly wrong: a boundary bug shows up as
            // a duplicated or skipped row, not as a bad first page.
            const walked: string[] = [];
            let cursor: { updatedAt: string; id: string } | null = null;
            for (let guard = 0; guard < 100; guard++) {
                const page = await g.bulkListProjected('*', [], 2, cursor);
                for (const r of page.rows) walked.push(String(r['id']));
                cursor = page.nextCursor;
                if (!cursor) break;
            }
            assert.equal(new Set(walked).size, walked.length, 'no id appears twice across pages');
            assert.deepEqual(walked, FIXTURE_NEWEST_FIRST, 'the full drained sequence is the contracted order');
        });

        await check('bulkListProjected: id and updatedAt are always returned', async () => {
            // They are the cursor. A caller that asked for neither and got
            // neither would page forever.
            const page = await g.bulkListProjected('*', [], 1, null);
            assert.ok(page.rows[0]?.['id'] !== undefined, 'id projected');
            assert.ok(page.rows[0]?.['updatedAt'] !== undefined, 'updatedAt projected');
        });

        await check('bulkListProjected: a project filter narrows to that project', async () => {
            const page = await g.bulkListProjected('q', [], 50, null);
            assert.deepEqual(page.rows.map((r) => String(r['id'])), ['other-project'],
                'project q has exactly one node');
        });

        await check('bulkListProjected: a hostile column name is refused, not interpolated', async () => {
            // Column names reach the query as text (SurrealQL has no parameter
            // slot for an identifier), so the engine must reject rather than
            // build the string.
            await assert.rejects(() => g.bulkListProjected('*', ['id, label FROM x --'], 1, null),
                /invalid identifier/i, 'hostile identifier refused');
        });

        /* ── the operations that used to exist only on Kùzu ─────────── */

        await check('getLanguageBreakdown: every node counted exactly once', async () => {
            const breakdown = await g.getLanguageBreakdown();
            const all = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
            const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
            assert.equal(total, all.length, `every node counted once (${total} vs ${all.length})`);
            assert.ok(Object.keys(breakdown).length > 0, 'and the breakdown is not vacuously empty');
        });

        await check('getTopologyOverview: totalNodes matches the real node count, per-project blobs', async () => {
            const r = await g.getTopologyOverview();
            const all = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
            assert.equal(r.totalNodes, all.length, 'totalNodes is the true count');
            assert.deepEqual(
                r.blobs.map((b) => `${b.project}:${b.nodeCount}`).sort(),
                ['p:17', 'q:1'],
                'per-project blob counts',
            );
            assert.ok(r.blobs.length > 0, 'not vacuously empty');
        });

        await check('getTopologyOverview: intra-project edges are excluded', async () => {
            // The rule most likely to be wrong in a hand-written aggregate:
            // every cross-project edge must have two DIFFERENT projects.
            const r = await g.getTopologyOverview();
            assert.ok(
                r.aggregateEdges.every((e) => e.fromProject !== e.toProject),
                'no self-referential aggregate edge',
            );
            // The fixture's edges are all intra-project p, so nothing aggregates.
            assert.deepEqual(
                r.aggregateEdges.map((e) => `${e.fromProject}->${e.toProject}:${e.count}`).sort(),
                [],
                'intra-p edges aggregate to nothing',
            );
        });

        await check('getTopologyOverviewByType: groups by type, not project', async () => {
            const r = await g.getTopologyOverviewByType();
            assert.deepEqual(
                r.blobs.map((b) => `${b.project}:${b.nodeCount}`).sort(),
                ['architecture:4', 'convention:1', 'decision:1', 'note:12'],
                'type-keyed blobs with true counts',
            );
        });

        await check('lintGraph: reports the orphaned decision, and never orphans a note', async () => {
            const w = await g.lintGraph();
            assert.deepEqual(w.slice().sort(), [
                "Orphan: decision node 'no-match' has no relationships.",
            ], 'exactly the one fixture orphan');
            assert.ok(w.every((line) => !line.startsWith('Orphan: note ')),
                'notes are not reported as orphans');
        });

        await check('findSupersededByPredecessors: absent predecessor empty; real supersession found', async () => {
            assert.deepEqual(await g.findSupersededByPredecessors('definitely-not-a-node'), [],
                'absent predecessor is an empty list');

            await g.supersedeNode('near1', 'near2', 'contract');
            assert.deepEqual(await g.findSupersededByPredecessors('near2'), ['near1'],
                'finds the predecessor');
            await g.unsupersedeNode('near1');
        });

        await check('archiveNode: sets status archived and stamps updatedAt', async () => {
            // updatedAt is the keyset cursor. An archive that did not stamp it
            // would leave the node in the same page position and make
            // "recently changed" views lie — so it is asserted, not assumed.
            const before = await g.getNode('far1');
            await g.archiveNode('far1');
            const after = await g.getNode('far1');
            assert.equal((after as unknown as { status?: string })?.status, 'archived', 'archived');
            assert.notEqual(after?.updatedAt, before?.updatedAt, 'updatedAt stamped');
        });

        await check('cache controls exist and behave', async () => {
            // getCacheStats/resetCacheStats/reconfigureCache used to be Kùzu-only,
            // so /api/config and the storage diagnostics route 500'd without them.
            await g.getNode('hub');
            g.resetCacheStats();
            const zeroed = g.getCacheStats();
            assert.equal((zeroed as { hits: number }).hits, 0, 'stats reset');
            g.reconfigureCache({ enabled: true, ttlSeconds: 5, maxEntries: 10 });
            await g.getNode('hub');
            await g.getNode('hub');
            assert.ok((g.getCacheStats() as { hits: number }).hits > 0, 'cache still serving after reconfigure');
        });

        await check('traverse DIAMOND: far1 reported ONCE at its minimum depth', async () => {
            const s = await g.traverse('hub', 3);
            assert.equal(s.filter((r) => r.node.id === 'far1').length, 1, 'emits far1 once');
            assert.equal(depthMap(s).get('far1'), 1, 'takes the shortcut');
        });

        await check('traverse DEPTH-LIMIT EDGE: nothing beyond maxDepth', async () => {
            for (let depth = 1; depth <= 4; depth++) {
                const s = await g.traverse('hub', depth);
                const max = Math.max(0, ...s.map((r) => r.depth));
                assert.ok(max <= depth, `exceeded maxDepth ${depth} (saw ${max})`);
            }
        });

        await check('traverse CYCLE: terminates, seed never re-emitted', async () => {
            const s = await g.traverse('cycleA', 5);
            assertSameSet(idSet(s.map((r) => r.node)), new Set(['cycleB', 'cycleC']), 'cycle set');
            assert.equal(s.some((r) => r.node.id === 'cycleA'), false, 'never re-emits the seed');
            const dm = depthMap(s);
            assert.equal(dm.get('cycleB'), 1, 'cycleB depth 1');
            assert.equal(dm.get('cycleC'), 1, 'cycleC depth 1 via the incoming cycleC→cycleA edge');
        });

        await check('traverse SELF-LOOP: terminates without emitting the seed', async () => {
            const s = await g.traverse('selfie', 3);
            assert.deepEqual(idSet(s.map((r) => r.node)), new Set([]), 'a self-loop adds no neighbours');
            assert.equal(s.some((r) => r.node.id === 'selfie'), false, 'excludes the seed');
        });

        await check('traverse from a leaf: walks BACKWARDS along the incoming edge', async () => {
            // `orphan` has exactly one incoming edge (near2 → orphan), so a
            // traversal from it must walk back to near2 and then on to hub —
            // the incoming-edge direction, which is easy to drop in an engine
            // that only follows `->`.
            const s = await g.traverse('orphan', 2);
            assertSameSet(idSet(s.map((r) => r.node)), new Set(['near2', 'hub']), 'leaf walk set');
            const dm = depthMap(s);
            assert.equal(dm.get('near2'), 1, 'near2 depth 1');
            assert.equal(dm.get('hub'), 2, 'hub depth 2');
        });

        await check('traverse from a genuinely isolated node: empty', async () => {
            // Created and removed inside this case so the fixture size stays
            // exact for the enumeration assertions further down.
            const isolated = {
                id: 'isolated', type: 'note', label: 'isolated', content: 'no edges',
                tags: ['lonely'], project: 'p', ecosystem: 'e', metadata: '{}',
            };
            try {
                await g.upsertNode(isolated);
                assert.deepEqual(await g.traverse('isolated', 5), []);
            } finally {
                await g.deleteNode('isolated').catch(() => undefined);
            }
        });

        await check('traverse is depth-ASCENDING (contracted result ordering)', async () => {
            const depths = (await g.traverse('hub', 5)).map((r) => r.depth);
            assert.deepEqual(depths, [...depths].sort((a, b) => a - b), 'results sorted by depth ascending');
        });

        await check('traverse SAME-DEPTH SUB-ORDER: STABLE across repeated calls', async () => {
            // The SEARCH_CONTRACT fixes result order by DEPTH ascending and
            // says same-depth results "may appear in any stable sub-order".
            // What is asserted, because it is what callers can actually depend
            // on: the sub-order is STABLE — identical across repeated calls
            // within a process. An unstable order would break cursoring and
            // cache coherence.
            const runs: string[] = [];
            for (let i = 0; i < 3; i++) runs.push(ids((await g.traverse('hub', 2)).map((r) => r.node)).join(','));
            assert.equal(new Set(runs).size, 1, 'sub-order must be stable across repeated calls');
        });

        await check('traverse: reached neighbours hydrate field-for-field like getNode', async () => {
            const reached = new Map((await g.traverse('hub', 3)).map((r) => [r.node.id, r.node]));
            assert.ok(reached.size > 0, 'fixture sanity: something reached');
            for (const [id, node] of reached) {
                assert.deepEqual(node, await g.getNode(id), `traverse hydration mismatch on ${id}`);
            }
        });

        /* ── 4. listNodes: the contracted sequence ──────────────────── */

        await check('listNodes(): exactly the fixture, updatedAt DESC, newest first', async () => {
            const all = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
            assert.deepEqual(ids(all), archiveAwareNewestFirst(), 'full sequence is updatedAt-descending');
        });

        await check('listNodes(type): exact id sets for every fixture type', async () => {
            for (const type of ['note', 'decision', 'architecture', 'convention']) {
                const got = idSet(await g.listNodes(type));
                assertSameSet(got,
                    new Set(FIXTURE_NODES.filter((f) => f.type === type).map((f) => f.id)),
                    `listNodes(type=${type})`);
            }
        });

        await check('listNodes(tag): exact id sets, case-insensitive', async () => {
            const graphTagged = new Set(['hub', 'near1', 'near2', 'far1', 'deep1', 'deep2', 'deep3']);
            assertSameSet(idSet(await g.listNodes(undefined, 'graph')), graphTagged, 'tag=graph');
            assertSameSet(idSet(await g.listNodes(undefined, 'GRAPH')), graphTagged, 'tag=GRAPH (case-insensitive)');
            assertSameSet(idSet(await g.listNodes(undefined, 'cycle')), new Set(['cycleA', 'cycleB', 'cycleC', 'selfie']), 'tag=cycle');
            assert.deepEqual(ids(await g.listNodes(undefined, 'nope')), [], 'tag with no members');
        });

        await check('listNodes(project/ecosystem): exact id sets', async () => {
            assert.deepEqual(ids(await g.listNodes(undefined, undefined, 'q')), ['other-project'], 'project q');
            assert.deepEqual(ids(await g.listNodes(undefined, undefined, '*', 'f')), ['other-project'], 'ecosystem f');
        });

        await check('listNodes(limit): truncated to the contracted prefix', async () => {
            const full = ids(await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true }));
            for (const limit of [1, 3, 7]) {
                assert.deepEqual(
                    ids(await g.listNodes(undefined, undefined, '*', '*', limit)),
                    full.slice(0, limit),
                    `listNodes(limit=${limit})`,
                );
            }
        });

        /* ── 5. bulkList: pages AND wire shape ──────────────────────── */

        await check('bulkList: page-by-page walk covers every node exactly once', async () => {
            const pages: string[][] = [];
            let cursor: { updatedAt: string; id: string } | null = null;
            for (let i = 0; i < 50; i++) {
                const page = await g.bulkList({ limit: 4, cursor });
                pages.push(page.nodes.map((n) => String(n['id'])));
                if (!page.hasMore || !page.nextCursor) break;
                cursor = page.nextCursor;
            }
            const flat = pages.flat();
            assert.equal(flat.length, FIXTURE_NODES.length, 'no gaps, no repeats');
            assert.equal(new Set(flat).size, flat.length, 'no id twice');
            assert.deepEqual(flat, archiveAwareNewestFirst(), 'the drained order is the contracted one');
        });

        await check('bulkList: row KEY SET is the contracted wire shape', async () => {
            const page = await g.bulkList({ limit: 50 });
            assert.deepEqual(Object.keys(page.nodes[0] ?? {}).sort(), [
                'content', 'createdAt', 'ecosystem', 'id', 'label', 'metadata',
                'project', 'security_scopes', 'tags', 'type', 'updatedAt',
            ], 'the route-facing wire shape, nothing engine-internal');
        });

        await check('bulkList(filters): exact id sets for type/tag/project', async () => {
            assertSameSet(
                new Set((await g.bulkList({ limit: 50, types: ['note'] })).nodes.map((n) => String(n['id']))),
                new Set(FIXTURE_NODES.filter((f) => f.type === 'note').map((f) => f.id)),
                'types=[note]',
            );
            assertSameSet(
                new Set((await g.bulkList({ limit: 50, tags: ['graph'] })).nodes.map((n) => String(n['id']))),
                new Set(['hub', 'near1', 'near2', 'far1', 'deep1', 'deep2', 'deep3']),
                'tags=[graph]',
            );
            assert.deepEqual(
                (await g.bulkList({ limit: 50, project: 'q' })).nodes.map((n) => n['id']),
                ['other-project'],
                'project=q',
            );
        });

        await check('bulkList(ecosystem): non-wildcard ecosystem EXCLUDES other ecosystems', async () => {
            // Fixture has exactly one ecosystem='f' node ('other-project');
            // every other fixture node is ecosystem='e'. This is the gap the
            // list_nodes fast-path→bulkList conversion could silently drop.
            assert.deepEqual(
                (await g.bulkList({ limit: 50, ecosystem: 'f' })).nodes.map((n) => n['id']),
                ['other-project'], 'ecosystem=f returns ONLY the ecosystem-f node');
            const ecoE = (await g.bulkList({ limit: 50, ecosystem: 'e' })).nodes.map((n) => String(n['id']));
            assert.ok(!ecoE.includes('other-project'), 'ecosystem=e EXCLUDES the ecosystem-f node');
            assert.equal(ecoE.length, FIXTURE_NODES.length - 1, 'drops exactly the one ecosystem-f node');
        });

        /* ── 6. edges ───────────────────────────────────────────────── */

        await check('queryEdges: every fixture edge, with confidence tier + score', async () => {
            const norm = (es: LoreEdge[]): string[] =>
                es.map((e) => `${e.sourceId}|${e.relation}|${e.targetId}|${e.confidence}|${e.confidenceScore}`).sort();
            const got = await g.queryEdges({ limit: 100, offset: 0 });
            assert.equal(got.length, FIXTURE_EDGES.length, 'returned every fixture edge');
            assert.deepEqual(norm(got), fixtureEdgeKeys());
        });

        await check('queryEdges(filters): exact results for source/target/relation', async () => {
            const norm = (es: LoreEdge[]): string[] => es.map((e) => `${e.sourceId}->${e.targetId}`).sort();
            const expect = (pred: (e: LoreEdge) => boolean): string[] =>
                FIXTURE_EDGES.filter(pred).map((e) => `${e.sourceId}->${e.targetId}`).sort();
            assert.deepEqual(norm(await g.queryEdges({ source: 'hub', limit: 100, offset: 0 })),
                expect((e) => e.sourceId === 'hub'), 'source=hub');
            assert.deepEqual(norm(await g.queryEdges({ target: 'far1', limit: 100, offset: 0 })),
                expect((e) => e.targetId === 'far1'), 'target=far1');
            assert.deepEqual(norm(await g.queryEdges({ relation: 'cites', limit: 100, offset: 0 })),
                expect((e) => e.relation === 'cites'), 'relation=cites');
            assert.deepEqual(norm(await g.queryEdges({ source: 'hub', relation: 'related_to', limit: 100, offset: 0 })),
                expect((e) => e.sourceId === 'hub' && e.relation === 'related_to'), 'source+relation');
        });

        /* ── 7. aggregates ─────────────────────────────────────────── */

        await check('getStats: true nodeCount, edgeCount, and typeBreakdown', async () => {
            assert.deepEqual(await g.getStats(), {
                nodeCount: FIXTURE_NODES.length,
                edgeCount: FIXTURE_EDGES.length,
                typeBreakdown: { note: 12, decision: 1, architecture: 4, convention: 1 },
            });
        });

        await check('getStats(projectFilter): narrowed counts', async () => {
            assert.deepEqual(await g.getStats('p'), {
                nodeCount: FIXTURE_NODES.length - 1,
                edgeCount: FIXTURE_EDGES.length, // every fixture edge is intra-p
                typeBreakdown: { note: 11, decision: 1, architecture: 4, convention: 1 },
            }, 'getStats(p)');
            assert.deepEqual(await g.getStats('q'), {
                nodeCount: 1, edgeCount: 0, typeBreakdown: { note: 1 },
            }, 'getStats(q)');
            assert.deepEqual(await g.getStats('missing'), {
                nodeCount: 0, edgeCount: 0, typeBreakdown: {},
            }, 'getStats(missing)');
        });

        await check('getTopology: fixture-true node + edge projections', async () => {
            const t = await g.getTopology(100);
            assertSameSet(new Set(t.nodes.map((n) => String(n['id']))),
                new Set(FIXTURE_NODES.map((f) => f.id)), 'every fixture node present');
            for (const n of t.nodes) {
                const f = FIXTURE_BY_ID.get(String(n['id']))!;
                assert.equal(n['label'], f.label, `${f.id} label`);
                assert.equal(n['type'], f.type, `${f.id} type`);
                assert.equal(n['project'], f.project, `${f.id} project`);
                assert.equal(n['group'], f.type, `${f.id} grouped by type`);
            }
            assert.deepEqual(
                t.edges.map((e) => `${e['from']}|${e['label']}|${e['to']}|${e['confidence']}|${e['confidenceScore']}`).sort(),
                FIXTURE_EDGES.map((e) => `${e.sourceId}|${e.relation}|${e.targetId}|${e.confidence ?? 'extracted'}|${e.confidenceScore ?? 1}`).sort(),
                'edge projections carry the fixture truth',
            );
        });

        await check('getTopology(project scope): excludes out-of-scope nodes and their edges', async () => {
            const t = await g.getTopology(100, ['p']);
            assert.ok(!t.nodes.some((n) => String(n['id']) === 'other-project'), 'project-q node excluded');
            assert.equal(t.nodes.length, FIXTURE_NODES.length - 1, 'all project-p nodes present');
            assert.equal(t.edges.length, FIXTURE_EDGES.length, 'every fixture edge is intra-p');
        });

        /* ── 8. lifecycle + maintenance ─────────────────────────────── */

        await check('supersedeNode: ok result, and the resulting node state', async () => {
            const r = await g.supersedeNode('near2', 'near1', 'parity reason');
            assert.deepEqual(r, { ok: true });
            const n = await g.getNode('near2');
            assert.equal(n?.supersededBy, 'near1', 'supersededBy set');
            const wide = n as unknown as Record<string, unknown>;
            assert.equal(wide['supersededReason'], 'parity reason', 'reason persisted');
            assert.ok(typeof wide['supersededAt'] === 'string' && wide['supersededAt'] !== '', 'supersededAt stamped');
            // NOTE: validUntil-on-supersede was a tracked divergence in the old
            // Kùzu-vs-Surreal harness (Kùzu left it null). SurrealDB stamps it —
            // that is the surviving engine's contract, pinned here.
            assert.ok(typeof wide['validUntil'] === 'string' && wide['validUntil'] !== '',
                'validUntil stamped on supersede');
        });

        await check('supersedeNode: refusal reasons (self / old-missing / new-missing)', async () => {
            assert.deepEqual(await g.supersedeNode('hub', 'hub'), { ok: false, reason: 'self' });
            assert.deepEqual(await g.supersedeNode('ghost', 'hub'), { ok: false, reason: 'old-not-found' });
            assert.deepEqual(await g.supersedeNode('hub', 'ghost'), { ok: false, reason: 'new-not-found' });
        });

        await check('unsupersedeNode: clears the supersession state', async () => {
            assert.equal(await g.unsupersedeNode('near2'), true, 'real node unsupersedes');
            assert.equal(await g.unsupersedeNode('ghost'), false, 'ghost refuses');
            const n = await g.getNode('near2');
            assert.equal(n?.supersededBy, null, 'supersededBy cleared');
            assert.equal((n as unknown as Record<string, unknown>)['validUntil'], null, 'validUntil cleared');
        });

        await check('markStaleByTags: count and resulting node state', async () => {
            const marked = await g.markStaleByTags(['CYCLE']);
            assert.equal(marked, 4, 'the four cycle-tagged nodes');
            for (const id of ['cycleA', 'cycleB', 'cycleC', 'selfie']) {
                assert.equal((await g.getNode(id) as unknown as { stale?: boolean })?.stale, true, `${id} stale`);
            }
            assert.equal(await g.markStaleByTags([]), 0, 'empty tag list');
        });

        await check('pruneInferredLoreEdges: count and survivors', async () => {
            const pruned = await g.pruneInferredLoreEdges('semantic_neighbor');
            assert.equal(pruned, 1, 'the one inferred edge');
            assert.equal((await g.queryEdges({ limit: 100, offset: 0 })).length, FIXTURE_EDGES.length - 1,
                'exactly the inferred edge is gone');
        });

        await check('deleteEdge: count and remaining edge set', async () => {
            const deleted = await g.deleteEdge('hub', 'near2', 'related_to');
            assert.equal(deleted, 1, 'first delete removes one');
            assert.equal(await g.deleteEdge('hub', 'near2', 'related_to'), 0, 'second delete is a no-op');
            const remaining = (await g.queryEdges({ limit: 100, offset: 0 }))
                .map((e) => `${e.sourceId}->${e.targetId}`).sort();
            assert.equal(remaining.length, FIXTURE_EDGES.length - 2, 'exactly one edge gone');
            assert.ok(!remaining.includes('hub->near2'), 'the deleted triple is absent');
        });

        await check('deleteNode: result, and incident edges vanish with it', async () => {
            assert.equal(await g.deleteNode('deep3'), true, 'first delete true');
            assert.equal(await g.deleteNode('deep3'), false, 'second delete false');
            const stats = await g.getStats();
            assert.equal(stats.nodeCount, FIXTURE_NODES.length - 1, 'node count after delete');
            assert.equal(stats.edgeCount, FIXTURE_EDGES.length - 3, 'the node\'s incident edge went with it');
            assertSameSet(
                idSet((await g.traverse('hub', 5)).map((r) => r.node)),
                new Set(['near1', 'far1', 'deep1', 'deep2']),
                'hub traversal set after deleteNode',
            );
        });

        await check('pruneEphemeralNodes: an expired ephemeral is reaped', async () => {
            await g.upsertNode({
                id: 'ephemeral-1', type: 'note', label: 'temp', content: 'temp',
                tags: ['temp'], project: 'p', ecosystem: 'e', metadata: '{}',
                ephemeral: true, ttl_ms: 1,
            });
            await sleep(25);
            const pruned = await g.pruneEphemeralNodes();
            assert.equal(pruned, 1, 'exactly the expired one');
            assert.equal(await g.getNode('ephemeral-1'), null, 'gone from reads');
        });

        /* ── 9. write-path return values ───────────────────────────── */

        await check('upsertNode: returned node (update path preserves createdAt)', async () => {
            const before = await g.getNode('hub');
            const write = { id: 'hub', type: 'note', label: 'hub renamed', content: 'central', tags: ['Graph', 'graph'], project: 'p', ecosystem: 'e', metadata: '{"v":2}' };
            const ret = await g.upsertNode(write);
            assert.deepEqual(ret.tags, ['graph'], 'lowercased + deduped tags returned');
            assert.equal(ret.syncedAt, null, 'syncedAt null');
            assert.equal(ret.createdAt, before?.createdAt, 'createdAt preserved on update');
            assert.notEqual(ret.updatedAt, before?.updatedAt, 'updatedAt advanced');
            const after = await g.getNode('hub');
            assert.equal(after?.label, 'hub renamed', 'label written');
            assert.equal(after?.metadata, '{"v":2}', 'metadata written');
        });

        await check('bulkUpsertNodes: per-node result shape', async () => {
            const batch = [
                { id: 'bulk-1', type: 'note', label: 'b1', content: 'c1', tags: ['b'], project: 'p', ecosystem: 'e', metadata: '{}' },
                { id: 'bulk-2', type: 'note', label: 'b2', content: 'c2', tags: ['b'], project: 'p', ecosystem: 'e', metadata: '{}' },
            ];
            const results = await g.bulkUpsertNodes(batch);
            assert.deepEqual(results, [
                { id: 'bulk-1', ok: true }, { id: 'bulk-2', ok: true },
            ], 'per-node {id, ok} results');
            assert.equal((await g.getNode('bulk-1'))?.label, 'b1', 'bulk-written node readable');
        });

        await check('addEdge(missing endpoint): refuses, writes no dangling edge', async () => {
            const before = (await g.getStats()).edgeCount;
            await assert.rejects(() => g.addEdge({ sourceId: 'hub', targetId: 'ghost', relation: 'x' }));
            assert.equal((await g.getStats()).edgeCount, before, 'wrote nothing');
        });

        await check('addEdge(duplicate): idempotent — one row, not two', async () => {
            const before = (await g.getStats()).edgeCount;
            await g.addEdge({ sourceId: 'hub', targetId: 'near1', relation: 'related_to' });
            assert.equal((await g.getStats()).edgeCount, before, 'duplicate added no second row');
        });
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(surrealDir, { recursive: true, force: true });
    }

    console.log('');
    console.log(`contract: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log('embedded SurrealDB satisfies every contracted operation ✓');
    // Explicit exit: SurrealGraph holds the event loop through its embedded
    // engine; natural teardown would leave the process alive.
    process.exit(0);
}

/**
 * The contracted bulk order (updatedAt DESC) at the point the enumeration
 * assertions run. `archiveNode('far1')` stamps far1's updatedAt mid-suite, so
 * from that point far1 is the newest row; everything else keeps fixture write
 * order. Derived, not assumed: the structural updatedAt-desc invariant is
 * additionally asserted wherever the full sequence is checked.
 */
function archiveAwareNewestFirst(): string[] {
    const archivedFirst = ['far1', ...FIXTURE_NEWEST_FIRST.filter((id) => id !== 'far1')];
    return archivedFirst;
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});

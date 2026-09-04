#!/usr/bin/env tsx
/**
 * parity-graph-unit.ts — W5-PARITY-HARNESS: cross-backend parity between the
 * LOCAL engine and the cloud adapter.
 *
 * PROBLEM this solves: no other test runs the SAME operation against BOTH the
 * local embedded graph and the cloud `DataplaneGraph` and asserts that the two
 * backends agree. dataplane-graph-unit.ts only exercises the cloud adapter in
 * isolation against a response-staging FakeClient that echoes whatever you
 * hand it — it cannot prove the two backends produce the same answers for the
 * same fixture. This harness does.
 *
 * HOW: a single fixture set of nodes + edges is loaded into:
 *   (a) a real SurrealGraph over a fresh temp dir (embedded SurrealDB on
 *       disk — the local engine since the legacy graph engine removal; LocalGraph played
 *       this side before it), and
 *   (b) a DataplaneGraph backed by `StatefulSdkClient` — an in-process fake
 *       that ACTUALLY stores rows and answers query/get/traverse (not the
 *       echo-only FakeClient from dataplane-graph-unit.ts, and not the HTTP
 *       mock-dataplane.ts which speaks an older tenant-in-URL protocol the
 *       current adapter no longer uses). StatefulSdkClient implements exactly
 *       the tenant-first `SdkClient` surface DataplaneGraph speaks (insert /
 *       get / query with the contracted filter operators / updateByQuery /
 *       deleteByQuery / count / graph.createEdge / graph.traverse with a real
 *       BFS that reports true per-hop depth).
 *
 * Then the SAME ops run against both and we assert EQUIVALENCE per the
 * W0-SEARCH-CONTRACT (providers/types.ts, SEARCH_CONTRACT_VERSION = 1):
 *
 *   - search(query): SAME id SET AND SAME id SEQUENCE. Both backends route
 *     their rank/score/sort/slice through the shared rankSearchResults helper
 *     (engines/searchRanking.ts): the local engine fetches a bounded candidate
 *     set and ranks in-JS, and the cloud adapter ranks its org_id-scoped
 *     candidate set the same way. So the order (relevance desc → updatedAt
 *     desc → id asc) is IDENTICAL by construction; we assert a bit-identical
 *     cross-backend id sequence, not just set-equality.
 *   - traverse(seed, depth): SAME reachable id SET at the requested depth, and
 *     the SAME per-node minimum depth.
 *   - supersedeNode: SAME superseded/active state.
 *   - bulkList / listNodes: SAME id set across pages.
 *
 * Timestamps: the local side cannot pin absolute updatedAt (no raw-SQL back
 * door since the legacy graph engine removal), so the fixture is loaded in updatedAt-ascending
 * order with a real gap between writes — the same relative-order strategy as
 * test/surreal-graph-contract-unit.ts. The cloud fake pins exact fixture
 * timestamps; both sides therefore rank identically.
 *
 * tsx unit-harness style: manual pass/fail counters, explicit process.exit.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';
import type { LoreNode, LoreEdge } from '../packages/lore/src/providers/types.js';

// ──────────────────────────────────────────────────────────────────────────
// StatefulSdkClient — an in-process fake that actually STORES and QUERIES,
// implementing the precise tenant-first SDK surface DataplaneGraph calls.
//
// Records are keyed by (tenantId, collection). Filter matching covers exactly
// the operators DataplaneGraph emits:
//   - id_eq, org_id, type, project, ecosystem (exact)
//   - tags_contains, label_contains, content_contains (case-insensitive substr)
//   - source_id_eq, target_id_eq, relation_eq (exact, for lore_edge)
//   - updated_at_lt (strict <, for bulkList cursor)
// query() also honors `sort` and `limit` (and `offset` for queryEdges).
// graph.traverse() runs a real bidirectional BFS over stored edges and stamps
// each record with its true minimum hop-distance in `_depth`, so the cloud
// adapter reports honest per-node depth (not the depth-unknown sentinel).
// ──────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface QueryOpts {
    filter?: Record<string, unknown>;
    sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
    limit?: number;
    offset?: number;
    fields?: string[];
}

interface StoredEdge {
    fromBare: string;
    toBare: string;
    relation: string;
}

function matchesFilter(rec: Row, filter: Record<string, unknown> | undefined): boolean {
    if (!filter) return true;
    for (const [key, value] of Object.entries(filter)) {
        if (key === 'id_eq') {
            if (rec['id'] !== value) return false;
        } else if (key === 'source_id_eq') {
            if (rec['source_id'] !== value) return false;
        } else if (key === 'target_id_eq') {
            if (rec['target_id'] !== value) return false;
        } else if (key === 'relation_eq') {
            if (rec['relation'] !== value) return false;
        } else if (key === 'label_contains') {
            if (!String(rec['label'] ?? '').toLowerCase().includes(String(value).toLowerCase())) return false;
        } else if (key === 'content_contains') {
            if (!String(rec['content'] ?? '').toLowerCase().includes(String(value).toLowerCase())) return false;
        } else if (key === 'tags_contains') {
            if (!String(rec['tags'] ?? '').toLowerCase().includes(String(value).toLowerCase())) return false;
        } else if (key === 'updated_at_lt') {
            if (!(String(rec['updated_at'] ?? '') < String(value))) return false;
        } else {
            // exact match on a top-level field (org_id, type, project, ecosystem…)
            if (rec[key] !== value) return false;
        }
    }
    return true;
}

class StatefulSdkClient {
    // Map<tenantId, Map<collection, Row[]>>
    private store = new Map<string, Map<string, Row[]>>();

    private coll(tenantId: string, collection: string): Row[] {
        let t = this.store.get(tenantId);
        if (!t) { t = new Map(); this.store.set(tenantId, t); }
        let c = t.get(collection);
        if (!c) { c = []; t.set(collection, c); }
        return c;
    }

    /** Test introspection — read a raw stored row (used for superseded-state assertions). */
    rawGet(tenantId: string, collection: string, id: string): Row | null {
        return this.coll(tenantId, collection).find((r) => r['id'] === id) ?? null;
    }

    async createCollection(_tenantId: string, _schema: unknown, _conn?: string): Promise<unknown> {
        // No-op: collections are materialized lazily on first write.
        return {};
    }

    async insert<T = Row>(tenantId: string, collection: string, record: T, _conn?: string): Promise<T> {
        const rows = this.coll(tenantId, collection);
        const rec = record as unknown as Row;
        // Upsert-by-id so a re-insert with the same id replaces (mirrors the
        // engine's PK semantics; DataplaneGraph only inserts after updateByQuery
        // matched 0, but be robust to either order).
        const i = rows.findIndex((r) => r['id'] === rec['id']);
        if (i >= 0) rows[i] = { ...rec }; else rows.push({ ...rec });
        return record;
    }

    async get<T = Row>(tenantId: string, collection: string, id: string, _conn?: string): Promise<T> {
        const rec = this.coll(tenantId, collection).find((r) => r['id'] === id);
        if (!rec) throw new Error(`not found 404: ${collection}/${id}`);
        return rec as unknown as T;
    }

    async query<T = Row>(
        tenantId: string,
        collection: string,
        options?: QueryOpts,
        _conn?: string,
    ): Promise<{ records: T[]; total_count?: number; has_more?: boolean }> {
        const opts = options ?? {};
        let matched = this.coll(tenantId, collection).filter((r) => matchesFilter(r, opts.filter));
        if (opts.sort && opts.sort.length > 0) {
            matched = [...matched].sort((a, b) => {
                for (const s of opts.sort!) {
                    const av = String(a[s.field] ?? '');
                    const bv = String(b[s.field] ?? '');
                    if (av === bv) continue;
                    const cmp = av < bv ? -1 : 1;
                    return s.direction === 'desc' ? -cmp : cmp;
                }
                return 0;
            });
        }
        const offset = typeof opts.offset === 'number' ? opts.offset : 0;
        const limit = typeof opts.limit === 'number' ? opts.limit : matched.length;
        const page = matched.slice(offset, offset + limit);
        return { records: page as unknown as T[], total_count: matched.length, has_more: matched.length > offset + limit };
    }

    async updateByQuery(
        tenantId: string,
        collection: string,
        filter: object,
        fields: object,
        _conn?: string,
    ): Promise<{ updated: number }> {
        let updated = 0;
        for (const rec of this.coll(tenantId, collection)) {
            if (matchesFilter(rec, filter as Record<string, unknown>)) {
                Object.assign(rec, fields);
                updated++;
            }
        }
        return { updated };
    }

    async deleteByQuery(
        tenantId: string,
        collection: string,
        filter: object,
        _conn?: string,
    ): Promise<{ deleted: number }> {
        const rows = this.coll(tenantId, collection);
        const before = rows.length;
        const kept = rows.filter((r) => !matchesFilter(r, filter as Record<string, unknown>));
        rows.length = 0;
        rows.push(...kept);
        return { deleted: before - rows.length };
    }

    async count(tenantId: string, collection: string, filter?: object, _conn?: string): Promise<number> {
        return this.coll(tenantId, collection).filter((r) => matchesFilter(r, filter as Record<string, unknown>)).length;
    }

    graph = {
        createEdge: async (
            _tenantId: string,
            _collection: string,
            _options: {
                fromId: string; toId: string; edgeCollection: string;
                properties?: Record<string, unknown>; connection?: string;
            },
        ): Promise<{ edge_id: string }> => {
            // Edges are already persisted to the lore_edge collection by
            // DataplaneGraph.addEdge (the authoritative copy). traverse below
            // reads lore_edge, so this graph-edge mirror is a no-op for the
            // fake — return a synthetic id so the adapter's success path runs.
            return { edge_id: 'fake-edge' };
        },
        traverse: async <T = Row>(
            tenantId: string,
            collection: string,
            options: {
                startId: string; edgeCollection?: string; direction?: 'in' | 'out' | 'both';
                minDepth?: number; maxDepth?: number; connection?: string;
            },
        ): Promise<{ records: T[] }> => {
            // Real bidirectional BFS over the stored lore_edge rows, bounded by
            // maxDepth — mirrors LocalGraph's traverseImpl frontier walk so the
            // reachable set AND per-node minimum depth match across backends.
            const edgeColl = options.edgeCollection ?? 'lore_edge';
            const nodeColl = collection;
            const maxDepth = options.maxDepth ?? 2;
            const start = String(options.startId).replace(/^.*\//, '');
            const edges: StoredEdge[] = this.coll(tenantId, edgeColl).map((e) => ({
                fromBare: String(e['source_id'] ?? '').replace(/^.*\//, ''),
                toBare: String(e['target_id'] ?? '').replace(/^.*\//, ''),
                relation: String(e['relation'] ?? ''),
            }));
            const nodeRows = this.coll(tenantId, nodeColl);
            const visited = new Set<string>([start]);
            const out: Row[] = [];
            let frontier = [start];
            for (let depth = 1; depth <= maxDepth; depth++) {
                const next: string[] = [];
                for (const cur of frontier) {
                    for (const e of edges) {
                        // direction 'both' — follow edges in and out
                        let other: string | null = null;
                        let rel = e.relation;
                        if (e.fromBare === cur) other = e.toBare;
                        else if (e.toBare === cur) other = e.fromBare;
                        if (other === null || visited.has(other)) continue;
                        visited.add(other);
                        const node = nodeRows.find((r) => r['id'] === other);
                        if (node) { out.push({ ...node, relation: rel, _depth: depth }); next.push(other); }
                    }
                }
                if (next.length === 0) break;
                frontier = next;
            }
            return { records: out as unknown as T[] };
        },
    };
}

// ──────────────────────────────────────────────────────────────────────────
// Shared fixture — same nodes + edges loaded into BOTH backends.
//
// Search relevance is intentionally varied so the contracted ranking
// (relevance desc, then updatedAt desc) has something to order:
//   - kappa-label-content : "kappa" in label AND content (highest relevance)
//   - kappa-label-newer   : "kappa" in label only, newest updatedAt
//   - kappa-label-older    : "kappa" in label only, oldest updatedAt
//   - no-match            : never matches "kappa"
//
// Note: P15 (2026-06-26) restored tag parity. Pass 2 (2026-06-24) had dropped
// the tag branch from the local Cypher FTS scan; local now re-adds it via EXACT
// membership ($q IN n.tags — the legacy graph engine can't substring-match a list element against a
// bound parameter). The `kappa-tag-only` fixture below (label/content do NOT
// contain "kappa"; only the exact tag does) asserts both backends surface it.
// Remaining edge: substring WITHIN a tag (e.g. "auth" → "authentication") is
// still cloud-only until a real FTS predicate lands.
//
// Edges form a small graph for traverse depth assertions:
//   hub —related_to→ near1, hub —related_to→ near2,
//   near1 —cites→ far1   (far1 is depth 2 from hub)
// ──────────────────────────────────────────────────────────────────────────

const ORG_ID = 'org-parity';
const TENANT = 'tenant-parity';

interface Fixture {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; updatedAt: string;
}

const FIXTURE_NODES: Fixture[] = [
    { id: 'kappa-label-content', type: 'note', label: 'kappa header', content: 'about kappa things', tags: ['x'], project: 'p', ecosystem: 'e', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'kappa-label-newer', type: 'note', label: 'the kappa', content: 'unrelated body', tags: ['y'], project: 'p', ecosystem: 'e', updatedAt: '2026-03-01T00:00:00.000Z' },
    { id: 'kappa-label-older', type: 'note', label: 'a kappa', content: 'unrelated body', tags: ['z'], project: 'p', ecosystem: 'e', updatedAt: '2026-02-01T00:00:00.000Z' },
    // P15 (parity restore) — tag-ONLY match: label/content do NOT contain
    // "kappa"; the only hit is the exact tag "kappa". Both backends must now
    // surface it (local via `$q IN n.tags`, cloud via the shared ranker's
    // tagsHit). Score 1 (tags only) → ranks LAST.
    { id: 'kappa-tag-only', type: 'note', label: 'plain header', content: 'unrelated to the topic', tags: ['kappa'], project: 'p', ecosystem: 'e', updatedAt: '2026-01-15T00:00:00.000Z' },
    { id: 'no-match', type: 'decision', label: 'nope', content: 'nothing here', tags: ['none'], project: 'p', ecosystem: 'e', updatedAt: '2026-05-01T00:00:00.000Z' },
    { id: 'hub', type: 'note', label: 'hub node', content: 'central', tags: ['graph'], project: 'p', ecosystem: 'e', updatedAt: '2026-06-01T00:00:00.000Z' },
    { id: 'near1', type: 'note', label: 'near one', content: 'neighbour', tags: ['graph'], project: 'p', ecosystem: 'e', updatedAt: '2026-06-02T00:00:00.000Z' },
    { id: 'near2', type: 'note', label: 'near two', content: 'neighbour', tags: ['graph'], project: 'p', ecosystem: 'e', updatedAt: '2026-06-03T00:00:00.000Z' },
    { id: 'far1', type: 'note', label: 'far one', content: 'distant', tags: ['graph'], project: 'p', ecosystem: 'e', updatedAt: '2026-06-04T00:00:00.000Z' },
];

const FIXTURE_EDGES: LoreEdge[] = [
    { sourceId: 'hub', targetId: 'near1', relation: 'related_to' },
    { sourceId: 'hub', targetId: 'near2', relation: 'related_to' },
    { sourceId: 'near1', targetId: 'far1', relation: 'cites' },
];

/** Load the shared fixture into a GraphProvider-shaped backend. */
async function loadFixture(g: { upsertNode: (n: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>) => Promise<LoreNode>; addEdge: (e: LoreEdge) => Promise<void> }): Promise<void> {
    for (const f of FIXTURE_NODES) {
        await g.upsertNode({
            id: f.id, type: f.type, label: f.label, content: f.content, tags: f.tags,
            project: f.project, ecosystem: f.ecosystem, metadata: '{}',
        });
    }
    for (const e of FIXTURE_EDGES) await g.addEdge(e);
}

/**
 * The local engine stamps updatedAt = now() on write (as does the cloud
 * adapter), so to exercise the updatedAt-desc tie-break deterministically the
 * LOCAL side is loaded in updatedAt-ASCENDING fixture order with a real gap
 * between writes (4 ms is comfortably above the engines' ISO-8601 millisecond
 * resolution). The cloud fake pins the exact fixture timestamps below; both
 * sides end up with the SAME relative ordering, which is all the contracted
 * tie-break compares.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function loadFixtureOrdered(g: { upsertNode: (n: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>) => Promise<LoreNode>; addEdge: (e: LoreEdge) => Promise<void> }): Promise<void> {
    for (const f of [...FIXTURE_NODES].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))) {
        await g.upsertNode({
            id: f.id, type: f.type, label: f.label, content: f.content, tags: f.tags,
            project: f.project, ecosystem: f.ecosystem, metadata: '{}',
        });
        await sleep(4);
    }
    for (const e of FIXTURE_EDGES) await g.addEdge(e);
}

function pinCloudTimestamps(client: StatefulSdkClient): void {
    for (const f of FIXTURE_NODES) {
        const row = client.rawGet(TENANT, 'lore_node', f.id);
        if (row) row['updated_at'] = f.updatedAt;
    }
}

// ── tiny assertion harness (manual counters) ──────────────────────────────
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

const idSet = (nodes: Array<{ id: string }>): Set<string> => new Set(nodes.map((n) => n.id));
function assertSameSet(a: Set<string>, b: Set<string>, msg: string): void {
    const aOnly = [...a].filter((x) => !b.has(x));
    const bOnly = [...b].filter((x) => !a.has(x));
    assert.ok(
        aOnly.length === 0 && bOnly.length === 0,
        `${msg}: local-only=[${aOnly.join(',')}] cloud-only=[${bOnly.join(',')}]`,
    );
}

async function main(): Promise<void> {
    console.log('W5-PARITY-HARNESS — cross-backend parity (SurrealGraph vs DataplaneGraph)');
    console.log('SEARCH_CONTRACT_VERSION = 1');
    console.log('='.repeat(72));

    // ── build both backends over the SAME fixture ──
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-parity-'));
    const local = new SurrealGraph(tmpDir, { workspaceId: 'parity', cacheDisabled: true });
    await local.initialize();

    const sdk = new StatefulSdkClient();
    const cloud = new DataplaneGraph({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: sdk as any,
        tenantProvider: () => TENANT,
        orgId: ORG_ID,
    });
    await cloud.initialize();

    try {
        await loadFixtureOrdered(local);
        await loadFixture(cloud);
        pinCloudTimestamps(sdk);

        // ── (1) search: same id SET + cloud honors contracted order ──
        await check('search("kappa"): same id SET across backends', async () => {
            const localRes = await local.search('kappa', 50);
            const cloudRes = await cloud.search('kappa', 50);
            // Both must surface every node matching kappa in label OR content
            // OR tags, and neither the no-match nor the graph-only nodes.
            const expected = new Set(['kappa-label-content', 'kappa-label-newer', 'kappa-label-older', 'kappa-tag-only']);
            assertSameSet(idSet(localRes), expected, 'local search set');
            assertSameSet(idSet(cloudRes), expected, 'cloud search set');
            assertSameSet(idSet(localRes), idSet(cloudRes), 'cross-backend search set');
        });

        await check('search: cloud result obeys contracted order (relevance desc, updatedAt desc)', async () => {
            // CONTRACT (SEARCH_CONTRACT v1): relevance desc, then updatedAt desc.
            // The cloud adapter implements this (W5-CLOUD-SEARCH-ALIGN); we assert
            // the cloud order is exactly the contracted order on the fixture:
            //   kappa-label-content (label+content, score 6)
            //   kappa-label-newer   (label only, score 4, newer updatedAt)
            //   kappa-label-older    (label only, score 4, older updatedAt)
            const cloudRes = await cloud.search('kappa', 50);
            assert.deepEqual(
                cloudRes.map((n) => n.id),
                ['kappa-label-content', 'kappa-label-newer', 'kappa-label-older', 'kappa-tag-only'],
                'cloud order must follow relevance desc then updatedAt desc',
            );
        });

        // CROSS-BACKEND ORDER PARITY (W5B): both backends now route their
        // rank/score/sort/slice step through the shared rankSearchResults
        // helper (packages/lore/src/engines/searchRanking.ts), so the order is
        // IDENTICAL by construction — not merely the same SET. LocalGraph.search
        // fetches a bounded candidate set (CONTAINS predicate, capped) with NO
        // DB-side ORDER BY and ranks in-JS; DataplaneGraph.search does the same
        // on its org_id-scoped candidate set. We therefore assert a bit-identical
        // id-sequence across the two backends, the proof of true ORDER parity.
        await check('search: cross-backend ORDER parity — identical id sequence (W5B)', async () => {
            const localRes = await local.search('kappa', 50);
            const cloudRes = await cloud.search('kappa', 50);
            assert.deepEqual(
                localRes.map((n) => n.id),
                cloudRes.map((n) => n.id),
                'local and cloud must return the SAME id sequence (relevance desc → updatedAt desc → id asc)',
            );
            // And that sequence is exactly the contracted order on the fixture.
            assert.deepEqual(
                localRes.map((n) => n.id),
                ['kappa-label-content', 'kappa-label-newer', 'kappa-label-older', 'kappa-tag-only'],
                'local order must follow the contracted relevance → updatedAt order',
            );
        });

        await check('search limit: both backends cap at `limit`', async () => {
            const localRes = await local.search('kappa', 2);
            const cloudRes = await cloud.search('kappa', 2);
            assert.equal(localRes.length, 2, 'local respects limit');
            assert.equal(cloudRes.length, 2, 'cloud respects limit');
        });

        // ── (2) traverse: same reachable id SET + same per-node depth ──
        await check('traverse(hub, depth=1): same reachable id SET', async () => {
            const localRes = await local.traverse('hub', 1);
            const cloudRes = await cloud.traverse('hub', 1);
            const expected = new Set(['near1', 'near2']);
            assertSameSet(idSet(localRes.map((t) => t.node)), expected, 'local depth-1 set');
            assertSameSet(idSet(cloudRes.map((t) => t.node)), expected, 'cloud depth-1 set');
            assertSameSet(idSet(localRes.map((t) => t.node)), idSet(cloudRes.map((t) => t.node)), 'cross-backend depth-1 set');
        });

        await check('traverse(hub, depth=2): same reachable id SET (far1 included)', async () => {
            const localRes = await local.traverse('hub', 2);
            const cloudRes = await cloud.traverse('hub', 2);
            const expected = new Set(['near1', 'near2', 'far1']);
            assertSameSet(idSet(localRes.map((t) => t.node)), expected, 'local depth-2 set');
            assertSameSet(idSet(cloudRes.map((t) => t.node)), expected, 'cloud depth-2 set');
            assertSameSet(idSet(localRes.map((t) => t.node)), idSet(cloudRes.map((t) => t.node)), 'cross-backend depth-2 set');
        });

        await check('traverse(hub, depth=2): same per-node minimum depth', async () => {
            const localRes = await local.traverse('hub', 2);
            const cloudRes = await cloud.traverse('hub', 2);
            const depthMap = (rs: Array<{ node: { id: string }; depth: number }>) =>
                new Map(rs.map((r) => [r.node.id, r.depth]));
            const lm = depthMap(localRes);
            const cm = depthMap(cloudRes);
            for (const id of ['near1', 'near2', 'far1']) {
                assert.equal(lm.get(id), cm.get(id), `depth mismatch for ${id}: local=${lm.get(id)} cloud=${cm.get(id)}`);
            }
            // Sanity: contract says near* are depth 1, far1 is depth 2.
            assert.equal(cm.get('near1'), 1, 'near1 depth 1');
            assert.equal(cm.get('far1'), 2, 'far1 depth 2');
        });

        // ── (3) supersedeNode: same superseded/active state ──
        await check('supersedeNode(kappa-label-older → kappa-label-newer): both report ok + state changes', async () => {
            const lr = await local.supersedeNode('kappa-label-older', 'kappa-label-newer', 'parity test');
            const cr = await cloud.supersedeNode('kappa-label-older', 'kappa-label-newer', 'parity test');
            assert.deepEqual(lr, { ok: true }, 'local supersede ok');
            assert.deepEqual(cr, { ok: true }, 'cloud supersede ok');

            // Local surfaces supersededBy via getNode.
            const lNode = await local.getNode('kappa-label-older');
            assert.equal(lNode?.supersededBy, 'kappa-label-newer', 'local node now superseded');

            // CONTRACT note: DataplaneGraph.recordToLoreNode does NOT map the
            // superseded* fields (verified in dataplaneGraph.ts), so cloud
            // getNode cannot surface supersededBy. The state IS written to the
            // store (updateByQuery), so we assert the cloud superseded state on
            // the raw stored row — the honest source of truth for the cloud side.
            const cRow = sdk.rawGet(TENANT, 'lore_node', 'kappa-label-older');
            assert.equal(cRow?.['supersededBy'], 'kappa-label-newer', 'cloud node superseded in store');
            assert.equal(cRow?.['supersededReason'], 'parity test', 'cloud supersede reason persisted');
        });

        await check('supersedeNode(self): both refuse with reason "self", no state change', async () => {
            const lr = await local.supersedeNode('hub', 'hub');
            const cr = await cloud.supersedeNode('hub', 'hub');
            assert.deepEqual(lr, { ok: false, reason: 'self' }, 'local self-refuse');
            assert.deepEqual(cr, { ok: false, reason: 'self' }, 'cloud self-refuse');
        });

        await check('supersedeNode(missing old): both refuse with reason "old-not-found"', async () => {
            const lr = await local.supersedeNode('ghost-id', 'hub');
            const cr = await cloud.supersedeNode('ghost-id', 'hub');
            assert.deepEqual(lr, { ok: false, reason: 'old-not-found' }, 'local old-not-found');
            assert.deepEqual(cr, { ok: false, reason: 'old-not-found' }, 'cloud old-not-found');
        });

        // ── (4) bulkList / listNodes: same id set across pages ──
        await check('bulkList: same id set across paged enumeration', async () => {
            const collectAll = async (
                fn: (cursor: { updatedAt: string; id: string } | null) => Promise<{ nodes: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: { updatedAt: string; id: string } | null }>,
            ): Promise<Set<string>> => {
                const ids = new Set<string>();
                let cursor: { updatedAt: string; id: string } | null = null;
                // Bound the loop defensively; fixture is small.
                for (let i = 0; i < 100; i++) {
                    const page = await fn(cursor);
                    for (const n of page.nodes) ids.add(String(n['id']));
                    if (!page.hasMore || !page.nextCursor) break;
                    cursor = page.nextCursor;
                }
                return ids;
            };
            const localIds = await collectAll((cursor) => local.bulkList({ limit: 3, cursor }));
            const cloudIds = await collectAll((cursor) => cloud.bulkList({ limit: 3, cursor }));
            // Every fixture node must appear in BOTH enumerations.
            const expected = new Set(FIXTURE_NODES.map((f) => f.id));
            assertSameSet(localIds, expected, 'local bulkList covers all fixture ids');
            assertSameSet(cloudIds, expected, 'cloud bulkList covers all fixture ids');
            assertSameSet(localIds, cloudIds, 'cross-backend bulkList id set');
        });

        await check('listNodes(type=note): same id set across backends', async () => {
            const localRes = await local.listNodes('note');
            const cloudRes = await cloud.listNodes('note');
            const expected = new Set(FIXTURE_NODES.filter((f) => f.type === 'note').map((f) => f.id));
            assertSameSet(idSet(localRes), expected, 'local listNodes(note) set');
            assertSameSet(idSet(cloudRes), expected, 'cloud listNodes(note) set');
            assertSameSet(idSet(localRes), idSet(cloudRes), 'cross-backend listNodes set');
        });

        await check('listNodes(tag=graph): same id set across backends', async () => {
            const localRes = await local.listNodes(undefined, 'graph');
            const cloudRes = await cloud.listNodes(undefined, 'graph');
            const expected = new Set(FIXTURE_NODES.filter((f) => f.tags.includes('graph')).map((f) => f.id));
            assertSameSet(idSet(localRes), expected, 'local listNodes(tag) set');
            assertSameSet(idSet(cloudRes), expected, 'cloud listNodes(tag) set');
            assertSameSet(idSet(localRes), idSet(cloudRes), 'cross-backend listNodes(tag) set');
        });
    } finally {
        // Close the local engine so its SurrealDB handle releases and the
        // process can exit deterministically.
        try { await local.close(); } catch { /* best effort */ }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    }

    console.log('');
    console.log(`parity: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log('all cross-backend parity assertions passed ✓');
    // Explicit clean exit (harness style): SurrealGraph holds the event loop
    // through its embedded engine, so natural teardown would leave the process
    // alive. All assertions have already passed at this point.
    process.exit(0);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});

#!/usr/bin/env tsx
/**
 * surreal-graph-unit.ts — SurrealGraph engine behaviour (Phase 1).
 *
 * Proves the new embedded-SurrealDB engine satisfies the LoreGraphHandle
 * contract it claims to implement — including the FIVE methods beyond
 * GraphProvider (supersedeNode / unsupersedeNode / markStaleByTags /
 * pruneEphemeralNodes / pruneInferredLoreEdges), which the build plan calls
 * out specifically because a stub throw there would be invisible until
 * something in production called it.
 *
 * The traversal cases are the point of the whole evaluation: the legacy graph engine 0.11.3
 * cannot parse recursive Cypher, so multi-hop is a JS loop there today. Here
 * 3-hop and 5-hop are asserted to return the right nodes at the right DEPTH,
 * because "it returned something" is not the contract — per-node hop distance,
 * minimum-depth-wins, and depth-ascending order are.
 *
 * Run: npx tsx test/surreal-graph-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

/**
 * Real elapsed time, not a fake clock: several cases assert on `updatedAt`
 * ordering, which the engine derives from `Date.now()` at write time.
 */
function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

/** Fresh engine on a throwaway directory; always closed and removed. */
async function withGraph(fn: (g: SurrealGraph) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-graph-'));
    const graph = new SurrealGraph(dir, { workspaceId: 'test-ws' });
    try {
        await graph.initialize();
        await fn(graph);
    } finally {
        await graph.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Minimal valid node; callers override what the case is about. */
function node(id: string, over: Partial<LoreNode> = {}): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'decision',
        label: `Label ${id}`,
        content: `Content for ${id}`,
        tags: ['alpha'],
        project: 'proj',
        ecosystem: '*',
        metadata: '{}',
        ...over,
    };
}

console.log('SurrealGraph — engine contract');

/* ─── node CRUD ──────────────────────────────────────────────────── */

await test('upsertNode creates, getNode round-trips every declared field', async () => {
    await withGraph(async (g) => {
        const written = await g.upsertNode(node('n1', {
            tags: ['Beta', 'alpha', 'beta'],
            language: 'en',
            security_scopes: ['team:eng'],
            metadata: '{"k":"v"}',
        }));
        assert.equal(written.id, 'n1');
        // Tags come back normalized (lowercased + deduped), not as passed.
        assert.deepEqual(written.tags, ['beta', 'alpha']);
        assert.equal(written.syncedAt, null);

        const read = await g.getNode('n1');
        assert.ok(read, 'node must be readable');
        assert.equal(read.label, 'Label n1');
        assert.equal(read.content, 'Content for n1');
        assert.deepEqual(read.tags, ['beta', 'alpha']);
        assert.equal(read.language, 'en');
        assert.deepEqual(read.security_scopes, ['team:eng']);
        assert.equal(read.metadata, '{"k":"v"}');
        assert.equal(read.status, 'active');
        assert.equal(read.classification, 'tactical');
        // Empty-string storage conventions must surface as null, exactly as
        // the legacy graph engine's shared mapper does.
        assert.equal(read.syncedAt, null);
        assert.equal(read.supersededBy, null);
        assert.equal(read.supersededAt, null);
    });
});

await test('upsertNode preserves createdAt across an update and advances updatedAt', async () => {
    await withGraph(async (g) => {
        const first = await g.upsertNode(node('n1'));
        await sleep(5);
        const second = await g.upsertNode(node('n1', { label: 'renamed' }));
        assert.equal(second.createdAt, first.createdAt, 'createdAt must be preserved');
        assert.notEqual(second.updatedAt, first.updatedAt, 'updatedAt must advance');

        const read = await g.getNode('n1');
        assert.equal(read?.label, 'renamed');
        assert.equal(read?.createdAt, first.createdAt);
    });
});

await test('getNode returns null for an absent id (no throw)', async () => {
    await withGraph(async (g) => {
        assert.equal(await g.getNode('nope'), null);
    });
});

await test('concurrent same-id upserts do not lose createdAt (per-id serialization)', async () => {
    await withGraph(async (g) => {
        const created = await g.upsertNode(node('race'));
        await Promise.all([
            g.upsertNode(node('race', { label: 'a' })),
            g.upsertNode(node('race', { label: 'b' })),
            g.upsertNode(node('race', { label: 'c' })),
        ]);
        const read = await g.getNode('race');
        assert.equal(read?.createdAt, created.createdAt, 'createdAt survives concurrent upserts');
    });
});

await test('getNodesByIds hydrates a batch, omits missing ids, dedupes input', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a'));
        await g.upsertNode(node('b'));
        const map = await g.getNodesByIds(['a', 'b', 'a', 'missing', '']);
        assert.equal(map.size, 2);
        assert.equal(map.get('a')?.label, 'Label a');
        assert.equal(map.get('b')?.label, 'Label b');
        assert.equal(map.has('missing'), false, 'absent ids are omitted, not null');
    });
});

await test('bulkUpsertNodes reports per-node results and isolates a bad node', async () => {
    await withGraph(async (g) => {
        const results = await g.bulkUpsertNodes([
            node('ok1'),
            // Empty id is rejected by the id guard — must not abort the batch.
            node(''),
            node('ok2'),
        ]);
        assert.equal(results.length, 3);
        assert.equal(results[0]?.ok, true);
        assert.equal(results[1]?.ok, false, 'invalid id fails in its own slot');
        assert.equal(results[2]?.ok, true, 'batch continues past a failure');
        assert.ok(await g.getNode('ok2'), 'nodes after the failure are written');
    });
});

await test('deleteNode removes the node, its edges, and reports absence as false', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a'));
        await g.upsertNode(node('b'));
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'refers_to' });

        assert.equal(await g.deleteNode('a'), true);
        assert.equal(await g.getNode('a'), null);
        assert.equal(await g.deleteNode('a'), false, 'second delete reports false');

        const edges = await g.queryEdges({ limit: 10, offset: 0 });
        assert.equal(edges.length, 0, 'edges touching a deleted node are removed');
    });
});

/* ─── edges ──────────────────────────────────────────────────────── */

await test('addEdge is idempotent per directed (source,target,relation) triple', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a'));
        await g.upsertNode(node('b'));
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'refers_to' });
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'refers_to' });
        const edges = await g.queryEdges({ limit: 10, offset: 0 });
        assert.equal(edges.length, 1, 'replay must converge to ONE row, not two');
        assert.equal(edges[0]?.confidence, 'extracted');
        assert.equal(edges[0]?.confidenceScore, 1.0);
    });
});

await test('addEdge fails LOUDLY when an endpoint is missing (no silent write loss)', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a'));
        await assert.rejects(
            () => g.addEdge({ sourceId: 'a', targetId: 'ghost', relation: 'refers_to' }),
            /edge_endpoint_missing.*ghost/s,
        );
        const edges = await g.queryEdges({ limit: 10, offset: 0 });
        assert.equal(edges.length, 0, 'no dangling relation was created');
    });
});

await test('addBidirectionalEdge writes both directions', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a'));
        await g.upsertNode(node('b'));
        await g.addBidirectionalEdge({ sourceId: 'a', targetId: 'b', relation: 'peer' });
        const edges = await g.queryEdges({ limit: 10, offset: 0 });
        assert.equal(edges.length, 2);
        const pairs = edges.map((e) => `${e.sourceId}->${e.targetId}`).sort();
        assert.deepEqual(pairs, ['a->b', 'b->a']);
    });
});

await test('addEdge preserves an explicit confidence tier and score', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a'));
        await g.upsertNode(node('b'));
        await g.addEdge({
            sourceId: 'a', targetId: 'b', relation: 'semantic_neighbor',
            confidence: 'inferred', confidenceScore: 0.823,
        });
        const [edge] = await g.queryEdges({ limit: 10, offset: 0 });
        assert.equal(edge?.confidence, 'inferred');
        assert.equal(edge?.confidenceScore, 0.823);
    });
});

await test('deleteEdge returns the removed count; pruneInferredLoreEdges spares asserted edges', async () => {
    await withGraph(async (g) => {
        for (const id of ['a', 'b', 'c']) await g.upsertNode(node(id));
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'semantic_neighbor:0.9' });
        await g.addEdge({ sourceId: 'a', targetId: 'c', relation: 'semantic_neighbor:0.7' });
        await g.addEdge({ sourceId: 'b', targetId: 'c', relation: 'supersedes' });

        assert.equal(await g.deleteEdge('a', 'b', 'nope'), 0, 'no match → 0');
        assert.equal(await g.pruneInferredLoreEdges('semantic_neighbor'), 2);

        const remaining = await g.queryEdges({ limit: 10, offset: 0 });
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0]?.relation, 'supersedes', 'human-asserted edge survives');
    });
});

/* ─── traversal — the capability being restored ──────────────────── */

/** Chain n1 → n2 → … → nN, plus a shortcut so min-depth can be tested. */
async function buildChain(g: SurrealGraph, length: number): Promise<void> {
    for (let i = 1; i <= length; i++) await g.upsertNode(node(`n${i}`));
    for (let i = 1; i < length; i++) {
        await g.addEdge({ sourceId: `n${i}`, targetId: `n${i + 1}`, relation: `hop${i}` });
    }
}

await test('traverse depth 3 reaches exactly 3 hops with TRUE per-node depth', async () => {
    await withGraph(async (g) => {
        await buildChain(g, 6);
        const results = await g.traverse('n1', 3);
        const byId = new Map(results.map((r) => [r.node.id, r.depth]));
        assert.deepEqual([...byId.keys()].sort(), ['n2', 'n3', 'n4']);
        assert.equal(byId.get('n2'), 1);
        assert.equal(byId.get('n3'), 2);
        assert.equal(byId.get('n4'), 3, 'depth must be the real hop distance, not 1');
    });
});

await test('traverse depth 5 reaches exactly 5 hops (recursive-Cypher gap closed)', async () => {
    await withGraph(async (g) => {
        await buildChain(g, 8);
        const results = await g.traverse('n1', 5);
        const byId = new Map(results.map((r) => [r.node.id, r.depth]));
        assert.deepEqual([...byId.keys()].sort(), ['n2', 'n3', 'n4', 'n5', 'n6']);
        assert.equal(byId.get('n6'), 5);
        assert.equal(byId.has('n7'), false, 'nothing beyond maxDepth leaks in');
    });
});

await test('traverse returns a node ONCE, at its MINIMUM depth', async () => {
    await withGraph(async (g) => {
        await buildChain(g, 5);
        // n1 → n4 directly, so n4 is reachable at depth 1 and depth 3.
        await g.addEdge({ sourceId: 'n1', targetId: 'n4', relation: 'shortcut' });
        const results = await g.traverse('n1', 3);
        const n4 = results.filter((r) => r.node.id === 'n4');
        assert.equal(n4.length, 1, 'no duplicate entries');
        assert.equal(n4[0]?.depth, 1, 'minimum depth wins');
    });
});

await test('traverse walks incoming edges too, and is depth-ascending', async () => {
    await withGraph(async (g) => {
        await buildChain(g, 4);
        const results = await g.traverse('n3', 2);
        const ids = results.map((r) => r.node.id).sort();
        assert.deepEqual(ids, ['n1', 'n2', 'n4'], 'reaches upstream n2/n1 and downstream n4');
        const depths = results.map((r) => r.depth);
        assert.deepEqual(depths, [...depths].sort((a, b) => a - b), 'sorted by depth ascending');
    });
});

await test('traverse hydrates neighbours with the FULL node shape', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('seed'));
        await g.upsertNode(node('far', { tags: ['zeta'], language: 'fr', metadata: '{"deep":1}' }));
        await g.addEdge({ sourceId: 'seed', targetId: 'far', relation: 'refers_to' });
        const [result] = await g.traverse('seed', 1);
        assert.equal(result?.relation, 'refers_to');
        assert.deepEqual(result?.node.tags, ['zeta'], 'tags hydrated, not defaulted');
        assert.equal(result?.node.language, 'fr');
        assert.equal(result?.node.metadata, '{"deep":1}');
    });
});

await test('traverse on an isolated node returns no results', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('lonely'));
        assert.deepEqual(await g.traverse('lonely', 5), []);
    });
});

await test('traverse terminates on a cycle', async () => {
    await withGraph(async (g) => {
        for (const id of ['a', 'b', 'c']) await g.upsertNode(node(id));
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'r' });
        await g.addEdge({ sourceId: 'b', targetId: 'c', relation: 'r' });
        await g.addEdge({ sourceId: 'c', targetId: 'a', relation: 'r' });
        const results = await g.traverse('a', 5);
        assert.deepEqual(results.map((r) => r.node.id).sort(), ['b', 'c']);
        assert.equal(results.some((r) => r.node.id === 'a'), false, 'seed is never re-emitted');
    });
});

/* ─── search + list ──────────────────────────────────────────────── */

await test('search matches label, content, and exact tag; respects the limit', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('byLabel', { label: 'Postgres migration', content: 'x', tags: [] }));
        await g.upsertNode(node('byContent', { label: 'x', content: 'about postgres pooling', tags: [] }));
        await g.upsertNode(node('byTag', { label: 'x', content: 'y', tags: ['postgres'] }));
        await g.upsertNode(node('unrelated', { label: 'kafka', content: 'z', tags: [] }));

        const hits = await g.search('postgres', 10);
        assert.deepEqual(hits.map((n) => n.id).sort(), ['byContent', 'byLabel', 'byTag']);

        const limited = await g.search('postgres', 1);
        assert.equal(limited.length, 1, 'limit is enforced');
    });
});

await test('search is case-insensitive and ranks a label hit above a content hit', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('content-hit', { label: 'nothing', content: 'the WIDGET is here', tags: [] }));
        await g.upsertNode(node('label-hit', { label: 'Widget Registry', content: 'nothing', tags: [] }));
        const hits = await g.search('widget', 10);
        assert.equal(hits[0]?.id, 'label-hit', 'label weight beats content weight');
        assert.equal(hits.length, 2);
    });
});

await test('search honours project scope and excludeHidden', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('inScope', { project: 'alpha', label: 'target' }));
        await g.upsertNode(node('outScope', { project: 'beta', label: 'target' }));
        await g.upsertNode(node('archived', { project: 'alpha', label: 'target', status: 'archived' }));

        const scoped = await g.search('target', 10, 'alpha');
        assert.deepEqual(scoped.map((n) => n.id).sort(), ['archived', 'inScope']);

        const visible = await g.search('target', 10, 'alpha', '*', true);
        assert.deepEqual(visible.map((n) => n.id), ['inScope'], 'archived excluded before the slice');
    });
});

await test('listNodes filters by type/tag/project and sorts most-recent-first', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('older', { type: 'decision', tags: ['keep'] }));
        await sleep(5);
        await g.upsertNode(node('newer', { type: 'decision', tags: ['keep'] }));
        await g.upsertNode(node('other', { type: 'note', tags: ['drop'] }));

        const decisions = await g.listNodes('decision');
        assert.deepEqual(decisions.map((n) => n.id), ['newer', 'older'], 'updatedAt DESC');

        const tagged = await g.listNodes(undefined, 'KEEP');
        assert.deepEqual(tagged.map((n) => n.id).sort(), ['newer', 'older'], 'tag match is case-insensitive');

        assert.equal((await g.listNodes(undefined, undefined, 'nope')).length, 0);
        assert.equal((await g.listNodes(undefined, undefined, '*', '*', 1)).length, 1, 'limit applied');
    });
});

/* ─── the five LoreGraphHandle methods beyond GraphProvider ──────── */

await test('supersedeNode marks the old node and reports the three failure reasons', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('old'));
        await g.upsertNode(node('new'));

        assert.deepEqual(await g.supersedeNode('x', 'x'), { ok: false, reason: 'self' });
        assert.deepEqual(await g.supersedeNode('ghost', 'new'), { ok: false, reason: 'old-not-found' });
        assert.deepEqual(await g.supersedeNode('old', 'ghost'), { ok: false, reason: 'new-not-found' });

        assert.deepEqual(await g.supersedeNode('old', 'new', 'replaced'), { ok: true });
        const read = await g.getNode('old');
        assert.equal(read?.supersededBy, 'new');
        assert.equal(read?.supersededReason, 'replaced');
        assert.ok(read?.supersededAt, 'timestamp stamped');
    });
});

await test('supersedeNode keeps the node and its edges (supersession is not deletion)', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('old'));
        await g.upsertNode(node('new'));
        await g.addEdge({ sourceId: 'old', targetId: 'new', relation: 'supersedes' });
        await g.supersedeNode('old', 'new');
        assert.ok(await g.getNode('old'), 'node still present');
        assert.equal((await g.queryEdges({ limit: 10, offset: 0 })).length, 1, 'edges intact');
    });
});

await test('unsupersedeNode reverses it and reports false for an absent node', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('old'));
        await g.upsertNode(node('new'));
        await g.supersedeNode('old', 'new', 'why');
        assert.equal(await g.unsupersedeNode('old'), true);
        const read = await g.getNode('old');
        assert.equal(read?.supersededBy, null);
        assert.equal(read?.supersededAt, null);
        assert.equal(read?.supersededReason, null);
        assert.equal(await g.unsupersedeNode('ghost'), false);
    });
});

await test('markStaleByTags marks matching nodes only, case-insensitively', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('hit1', { tags: ['auth'] }));
        await g.upsertNode(node('hit2', { tags: ['billing', 'auth'] }));
        await g.upsertNode(node('miss', { tags: ['unrelated'] }));

        assert.equal(await g.markStaleByTags([]), 0, 'empty tag list is a no-op');
        assert.equal(await g.markStaleByTags(['AUTH']), 2);

        assert.equal((await g.getNode('hit1'))?.stale, true);
        assert.equal((await g.getNode('hit2'))?.stale, true);
        assert.equal((await g.getNode('miss'))?.stale, undefined, 'non-matching node untouched');
    });
});

await test('pruneEphemeralNodes deletes only EXPIRED ephemerals, never permanent ones', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('permanent'));
        await g.upsertNode(node('fresh', { ephemeral: true, ttl_ms: 3_600_000 }));
        await g.upsertNode(node('expired', { ephemeral: true, ttl_ms: 1 }));
        await sleep(20);

        assert.equal(await g.pruneEphemeralNodes(), 1);
        assert.ok(await g.getNode('permanent'), 'permanent node survives');
        assert.ok(await g.getNode('fresh'), 'unexpired ephemeral survives');
        assert.equal(await g.getNode('expired'), null, 'expired ephemeral deleted');
    });
});

await test('pruneEphemeralNodes falls back to defaultTtlMs when ttl_ms is unset', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('noTtl', { ephemeral: true }));
        await sleep(20);
        assert.equal(await g.pruneEphemeralNodes(1), 1, 'defaultTtlMs governs when ttl_ms is 0');
    });
});

/* ─── aggregates ─────────────────────────────────────────────────── */

await test('getStats counts nodes, edges, and the type breakdown; project filter narrows it', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('d1', { type: 'decision', project: 'alpha' }));
        await g.upsertNode(node('d2', { type: 'decision', project: 'beta' }));
        await g.upsertNode(node('c1', { type: 'convention', project: 'alpha' }));
        await g.addEdge({ sourceId: 'd1', targetId: 'c1', relation: 'r' });

        const all = await g.getStats();
        assert.equal(all.nodeCount, 3);
        assert.equal(all.edgeCount, 1);
        assert.deepEqual(all.typeBreakdown, { decision: 2, convention: 1 });

        const scoped = await g.getStats('alpha');
        assert.equal(scoped.nodeCount, 2);
        assert.deepEqual(scoped.typeBreakdown, { decision: 1, convention: 1 });
    });
});

await test('getStats on an empty graph returns zeroes, not a throw', async () => {
    await withGraph(async (g) => {
        assert.deepEqual(await g.getStats(), { nodeCount: 0, edgeCount: 0, typeBreakdown: {} });
    });
});

await test('getTopology returns the render shape and drops cross-scope edges when scoped', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a', { project: 'alpha' }));
        await g.upsertNode(node('b', { project: 'alpha' }));
        await g.upsertNode(node('c', { project: 'beta' }));
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'intra' });
        await g.addEdge({ sourceId: 'a', targetId: 'c', relation: 'cross' });

        const all = await g.getTopology(100);
        assert.equal(all.nodes.length, 3);
        assert.equal(all.edges.length, 2);
        assert.deepEqual(Object.keys(all.edges[0]!).sort(), ['confidence', 'confidenceScore', 'from', 'label', 'to']);
        assert.equal(all.nodes[0]!['supersededBy'], null, 'empty supersession → null');

        const scoped = await g.getTopology(100, ['alpha']);
        assert.equal(scoped.nodes.length, 2);
        assert.deepEqual(scoped.edges.map((e) => e['label']), ['intra'], 'cross-scope edge dropped');
    });
});

await test('bulkList pages on a stable cursor with no gaps or repeats', async () => {
    await withGraph(async (g) => {
        for (let i = 0; i < 5; i++) {
            await g.upsertNode(node(`p${i}`));
            await sleep(2);
        }
        const seen: string[] = [];
        let cursor = null as { updatedAt: string; id: string } | null;
        for (let page = 0; page < 10; page++) {
            const result = await g.bulkList({ limit: 2, cursor });
            seen.push(...result.nodes.map((n) => String(n['id'])));
            if (!result.hasMore) break;
            cursor = result.nextCursor;
        }
        assert.equal(seen.length, 5, 'every node returned exactly once');
        assert.equal(new Set(seen).size, 5, 'no repeats');
    });
});

/* ─── cache coherence ────────────────────────────────────────────── */

await test('a write invalidates cached reads (read-your-writes)', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('n1', { label: 'before' }));
        assert.equal((await g.getNode('n1'))?.label, 'before');
        assert.equal((await g.search('before', 10)).length, 1);

        await g.upsertNode(node('n1', { label: 'after' }));
        assert.equal((await g.getNode('n1'))?.label, 'after', 'getNode is not stale');
        assert.equal((await g.search('before', 10)).length, 0, 'search cache invalidated');
        assert.equal((await g.search('after', 10)).length, 1);
    });
});

await test('a delete invalidates traversal caches', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a'));
        await g.upsertNode(node('b'));
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'r' });
        assert.equal((await g.traverse('a', 1)).length, 1);
        await g.deleteNode('b');
        assert.equal((await g.traverse('a', 1)).length, 0, 'deleted neighbour is gone from traverse');
    });
});

/* ─── guard rails ────────────────────────────────────────────────── */

await test('operations before initialize() still work (initialize is implicit)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-lazy-'));
    const graph = new SurrealGraph(dir);
    try {
        await graph.upsertNode(node('lazy'));
        assert.ok(await graph.getNode('lazy'), 'every public method awaits initialize()');
    } finally {
        await graph.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('concurrent initialize() calls share one in-flight open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-init-'));
    const graph = new SurrealGraph(dir);
    try {
        await Promise.all([graph.initialize(), graph.initialize(), graph.initialize()]);
        await graph.upsertNode(node('x'));
        assert.ok(await graph.getNode('x'));
    } finally {
        await graph.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

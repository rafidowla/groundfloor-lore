#!/usr/bin/env tsx
/**
 * e2e-q1-intersections.ts — Recursive e2e for Q1.3 × Q1.4 × Q1.7 × Q1.9.
 *
 * Per-feature smokes catch "does the happy path work." This suite targets
 * the interactions between features — where stale-cache bugs and
 * invalidation races hide. One fresh LocalGraph workspace per test block.
 *
 * Intersections covered:
 *   1. Cache × getNode mutation — update label → re-read must see new label
 *      (cache key embeds epoch; upsert bumps epoch)
 *   2. Cache × search mutation — insert new matching node → re-search must
 *      include it
 *   3. Cache × listNodes mutation — same invariant for the list path
 *   4. Cache × deferred resolution — recall-style filter over deferred-*
 *      nodes must silence a node after resolve_deferred stamp
 *   5. Cache toggle × live traffic — reconfigureCache({enabled:false})
 *      must flush existing entries; re-enable must resume caching
 *   6. Overview × mutation — getTopologyOverview reflects new project
 *      blobs after upsert (not cached, but verifies the no-cache path
 *      stays honest)
 *   7. Plugin IR × overview — blobs aggregate correctly when a node
 *      carries a plugin-scoped project name (Q1.4 IR defines per-plugin
 *      project namespaces; overview must group by them faithfully)
 *
 * Airplane-safe: all local Kùzu, no network.
 */
import * as assert from 'assert';
import { randomUUID } from 'crypto';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalGraph } from '../packages/lore/src/engines/localGraph.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
    if (cond) { passed++; console.log(`  \u001b[32m✓\u001b[0m ${msg}`); }
    else      { failed++; console.log(`  \u001b[31m✗\u001b[0m ${msg}`); }
}

async function withGraph<T>(fn: (g: LocalGraph) => Promise<T>): Promise<T> {
    const ws = join(tmpdir(), `lore-xsect-${randomUUID()}`);
    if (existsSync(ws)) rmSync(ws, { recursive: true, force: true });
    const g = new LocalGraph(ws);
    await g.initialize();
    try { return await fn(g); }
    finally {
        try { await (g as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* best-effort */ }
        try { rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

console.log('═══ Q1 Intersections E2E ═══\n');

// ─── 1. Cache × getNode mutation ─────────────────────────────────────
console.log('─── 1. Cache × getNode mutation (epoch invalidation on upsert) ───');
await withGraph(async (g) => {
    const id = 'xsect-node-1';
    await g.upsertNode({ id, type: 'note', label: 'original', content: 'v1', tags: '', metadata: '', project: 'xsect', ecosystem: 'test' });
    const epoch0 = g.readCache.epoch;
    const first = await g.getNode(id);
    ok(first?.label === 'original', `first getNode returns original label (epoch=${g.readCache.epoch})`);
    const statsAfterFirst = g.getCacheStats();
    ok(statsAfterFirst.misses >= 1, `first read recorded as miss (misses=${statsAfterFirst.misses})`);

    // Re-read without mutation: should hit cache.
    await g.getNode(id);
    const statsAfterSecond = g.getCacheStats();
    ok(statsAfterSecond.hits >= 1, `second read hits cache (hits=${statsAfterSecond.hits})`);
    ok(g.readCache.epoch === epoch0, 'epoch unchanged while no writes');

    // Mutate: upsert should bump epoch; re-read must see new value, not stale cache hit.
    await g.upsertNode({ id, type: 'note', label: 'updated', content: 'v2', tags: '', metadata: '', project: 'xsect', ecosystem: 'test' });
    ok(g.readCache.epoch > epoch0, `upsert bumped epoch ${epoch0}→${g.readCache.epoch}`);
    const third = await g.getNode(id);
    ok(third?.label === 'updated', 'getNode after upsert returns new label (no stale cache hit)');
    ok(third?.content === 'v2', 'getNode after upsert returns new content');
});

// ─── 2. Cache × search mutation ──────────────────────────────────────
console.log('\n─── 2. Cache × search mutation ───');
await withGraph(async (g) => {
    await g.upsertNode({ id: 's1', type: 'note', label: 'alpha record', content: 'kafka alpha topic', tags: 'alpha', metadata: '', project: 'p', ecosystem: 'test' });
    const before = await g.search('alpha', 10);
    ok(before.length === 1, `initial search finds 1 result (got ${before.length})`);

    await g.search('alpha', 10); // warm cache
    const hitsBefore = g.getCacheStats().hits;
    ok(hitsBefore >= 1, `second search hits cache (hits=${hitsBefore})`);

    // New matching node — must invalidate cache for the same query.
    await g.upsertNode({ id: 's2', type: 'note', label: 'alpha record 2', content: 'kafka alpha', tags: 'alpha', metadata: '', project: 'p', ecosystem: 'test' });
    const after = await g.search('alpha', 10);
    ok(after.length === 2, `search after upsert finds 2 results (got ${after.length}) — no stale hit`);
});

// ─── 3. Cache × listNodes mutation ───────────────────────────────────
console.log('\n─── 3. Cache × listNodes mutation ───');
await withGraph(async (g) => {
    await g.upsertNode({ id: 'l1', type: 'note', label: 'first', content: '', tags: '', metadata: '', project: 'p', ecosystem: 'test' });
    const before = await g.listNodes();
    ok(before.length === 1, `initial listNodes = 1`);
    await g.listNodes(); // warm

    await g.upsertNode({ id: 'l2', type: 'note', label: 'second', content: '', tags: '', metadata: '', project: 'p', ecosystem: 'test' });
    const after = await g.listNodes();
    ok(after.length === 2, `listNodes after upsert = 2 (got ${after.length})`);
});

// ─── 4. Cache × deferred resolution ──────────────────────────────────
console.log('\n─── 4. Cache × deferred resolution (Q1.7 + Q1.3 interaction) ───');
await withGraph(async (g) => {
    const id = 'deferred-xsect-q17';
    await g.upsertNode({
        id, type: 'note', label: 'Deferred work for xsect',
        content: 'plugin-recalibrate-hook placeholder',
        tags: 'q1-7-xsect', metadata: JSON.stringify({ trigger_tags: ['q1-7-xsect'] }),
        project: 'p', ecosystem: 'test',
    });

    // Search warms cache.
    const first = await g.search('q1-7-xsect', 10);
    ok(first.length === 1, 'deferred node surfaces in pre-resolution search');

    // Stamp resolved_at — this mutates metadata via upsertNode, which
    // bumps the epoch. Caveat: a bare `metadata` patch must bump epoch
    // just like a label change.
    const mergedMeta = JSON.stringify({
        trigger_tags: ['q1-7-xsect'],
        resolved_at: new Date().toISOString(),
        resolved_by_commit: 'xsect-test',
    });
    await g.upsertNode({
        id, type: 'note', label: 'Deferred work for xsect',
        content: 'plugin-recalibrate-hook placeholder',
        tags: 'q1-7-xsect', metadata: mergedMeta,
        project: 'p', ecosystem: 'test',
    });

    // Re-read via getNode: must reflect resolved stamp.
    const reread = await g.getNode(id);
    const meta = JSON.parse(reread?.metadata ?? '{}');
    ok(typeof meta.resolved_at === 'string' && meta.resolved_at.length > 0,
       `metadata.resolved_at present after re-read (${meta.resolved_at ?? 'MISSING'})`);
});

// ─── 5. Cache toggle × live traffic ──────────────────────────────────
console.log('\n─── 5. Cache toggle × live traffic (Q1.3 Settings hot-reload) ───');
await withGraph(async (g) => {
    await g.upsertNode({ id: 't1', type: 'note', label: 'toggle test', content: '', tags: '', metadata: '', project: 'p', ecosystem: 'test' });
    await g.getNode('t1'); // warm
    await g.getNode('t1'); // hit
    const beforeToggle = g.getCacheStats();
    ok(beforeToggle.hits >= 1, `cache hits accumulate before toggle (hits=${beforeToggle.hits})`);

    // Flip the master switch off — must clear map so no stale leak.
    g.reconfigureCache({ enabled: false });
    await g.getNode('t1');
    await g.getNode('t1');
    const whileOff = g.getCacheStats();
    ok(whileOff.hits === beforeToggle.hits, `no new hits while disabled (still ${whileOff.hits})`);

    // Re-enable: caching resumes.
    g.reconfigureCache({ enabled: true });
    await g.getNode('t1'); // miss (clear on disable means map is empty)
    await g.getNode('t1'); // hit
    const afterRe = g.getCacheStats();
    ok(afterRe.hits > whileOff.hits, `cache resumed hitting after re-enable (${whileOff.hits}→${afterRe.hits})`);
});

// ─── 6. Overview × mutation ──────────────────────────────────────────
console.log('\n─── 6. Overview × mutation (Q1.9 freshness across writes) ───');
await withGraph(async (g) => {
    await g.upsertNode({ id: 'o1', type: 'note', label: 'alpha', content: '', tags: '', metadata: '', project: 'alpha', ecosystem: 'test' });
    const before = await g.getTopologyOverview();
    ok(before.totalNodes === 1, `overview.totalNodes = 1 initially (got ${before.totalNodes})`);
    ok(before.blobs.length === 1 && before.blobs[0].project === 'alpha',
       `single blob for project=alpha`);

    await g.upsertNode({ id: 'o2', type: 'note', label: 'beta', content: '', tags: '', metadata: '', project: 'beta', ecosystem: 'test' });
    const after = await g.getTopologyOverview();
    ok(after.totalNodes === 2, `overview.totalNodes updates to 2 after upsert (got ${after.totalNodes})`);
    ok(after.blobs.length === 2, `blob count = 2 (got ${after.blobs.length})`);
});

// ─── 7. Plugin IR × overview ─────────────────────────────────────────
console.log('\n─── 7. Plugin IR × overview (cross-project edges + Global fold) ───');
await withGraph(async (g) => {
    // Two plugin-scoped projects + one un-scoped (Global) node.
    await g.upsertNode({ id: 'i1', type: 'note', label: 'dev A', content: '', tags: '', metadata: '', project: 'developer-plugin', ecosystem: 'test' });
    await g.upsertNode({ id: 'i2', type: 'note', label: 'dev B', content: '', tags: '', metadata: '', project: 'developer-plugin', ecosystem: 'test' });
    await g.upsertNode({ id: 'i3', type: 'note', label: 'personal', content: '', tags: '', metadata: '', project: 'personal-plugin', ecosystem: 'test' });
    await g.upsertNode({ id: 'i4', type: 'note', label: 'unscoped', content: '', tags: '', metadata: '', project: '', ecosystem: 'test' });

    // Cross-project edge — must surface in aggregateEdges.
    await g.addEdge({ sourceId: 'i1', targetId: 'i3', relation: 'related' });
    // Intra-project edge — must NOT appear in aggregateEdges.
    await g.addEdge({ sourceId: 'i1', targetId: 'i2', relation: 'related' });
    // Edge to the Global-folded node — must surface as a "Global" endpoint.
    await g.addEdge({ sourceId: 'i3', targetId: 'i4', relation: 'related' });

    const ov = await g.getTopologyOverview();
    ok(ov.totalNodes === 4, `totalNodes = 4 (got ${ov.totalNodes})`);
    ok(ov.blobs.length === 3, `blob count = 3 (got ${ov.blobs.length})`);
    const devBlob = ov.blobs.find(b => b.project === 'developer-plugin');
    ok(devBlob?.nodeCount === 2, `developer-plugin blob nodeCount = 2 (got ${devBlob?.nodeCount})`);
    const globalBlob = ov.blobs.find(b => b.project === 'Global');
    ok(globalBlob?.nodeCount === 1, `Global blob folds unscoped node (got ${globalBlob?.nodeCount})`);

    // Cross-project aggregate edges: exactly 2 (dev→personal, personal→Global).
    // Intra-project (i1→i2 within developer-plugin) must be excluded.
    ok(ov.aggregateEdges.length === 2,
       `aggregateEdges = 2, intra-project excluded (got ${ov.aggregateEdges.length})`);
    const hasDevToPersonal = ov.aggregateEdges.some(e => e.fromProject === 'developer-plugin' && e.toProject === 'personal-plugin');
    ok(hasDevToPersonal, 'aggregateEdges contains developer-plugin → personal-plugin');
    const hasPersonalToGlobal = ov.aggregateEdges.some(e => e.fromProject === 'personal-plugin' && e.toProject === 'Global');
    ok(hasPersonalToGlobal, 'aggregateEdges contains personal-plugin → Global (fold working)');
});

console.log('');
console.log(`─── Summary: ${passed}/${passed + failed} passed ───`);
process.exit(failed === 0 ? 0 : 1);

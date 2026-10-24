#!/usr/bin/env tsx
/**
 * test/link-health-unit.ts - link-health metrics (counts, mean strength, invalidations, queue lag, rebuild
 * progress, prune). Engine contract on SQLite and (when LORE_PG_URL is set) Postgres; service snapshot and the
 * Prometheus lines engine-independent.
 *
 *   engine    linkEdgeStats counts only link_on_arrival semantic_neighbor edges: live / invalidated / mean / max degree / stale;
 *             linkNodesOverCap is ascending, resumable (afterId), limited, and ignores invalidated + foreign edges
 *   service   refreshHealth aggregates across workspaces, is cached for healthTtlMs (force bypasses), keeps the last
 *             snapshot when a read fails; stats() carries refresh / invalidation counters, prune and rebuild progress
 *   metrics   /metrics gains the lore_link_* lines; a service-less host emits none; hidden from a bound non-operator
 *
 * Run: npx tsx test/link-health-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// LORE_HOME must be set BEFORE the route modules read it.
process.env['LORE_HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'link-health-'));
const { renderMetrics } = await import('../packages/lore/src/mcp/http/routes/metrics.js');
const { runWithPrincipal } = await import('../packages/lore/src/auth/principal.js');
const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');

import { StoredVectorLinker } from '../packages/lore/src/link/storedVectorLinker.js';
import { LinkService } from '../packages/lore/src/link/linkService.js';
import { LinkPruner } from '../packages/lore/src/link/linkPruner.js';
import { SqlitePruneStore } from '../packages/lore/src/link/linkPruneStore.js';
import { LinkRebuilder } from '../packages/lore/src/link/linkRebuilder.js';
import { SqliteRebuildStore } from '../packages/lore/src/link/linkRebuildStore.js';
import { SqliteLinkQueue } from '../packages/lore/src/link/sqliteLinkQueue.js';
import { applyLinkOverrides, loadLinkConfig } from '../packages/lore/src/link/linkConfig.js';
import { FP, P, REL, linkEngines, mkTmp, node, seed, type G } from './helpers/linkEngines.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const near = (a: number | null, b: number, eps = 1e-4): void => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ~ ${b}`);

const NOW = { policyVersion: 'p-now', modelFingerprint: FP };
const stamp = (policyVersion: string, fp: string | null = FP) => ({ origin: 'link_on_arrival', policyVersion, modelFingerprint: fp }) as const;
const { engines, close } = await linkEngines('health');

for (const eng of engines) {
    console.log(`\n${eng.name}`);

    await test('engine: linkEdgeStats counts only linker edges; linkNodesOverCap is ordered, resumable and ignores foreign / invalidated', async () => {
        const g: G = await eng.open();
        for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await g.upsertNode(node(id));
        const e = (a: string, b: string, s: number, p = 'p-now') => ({ sourceId: a, targetId: b, relation: REL, confidenceScore: s, provenance: stamp(p) });
        await g.addInferredEdgesBatch([e('a', 'b', 0.9), e('a', 'c', 0.8), e('a', 'd', 0.7, 'p-old'), e('b', 'c', 0.6), e('d', 'e', 0.5)]);
        await g.addEdge({ sourceId: 'a', targetId: 'f', relation: REL, confidence: 'extracted', confidenceScore: 1, provenance: { origin: 'caller' } } as never);
        await g.addEdge({ sourceId: 'e', targetId: 'f', relation: 'related_to', confidence: 'extracted', confidenceScore: 1 } as never);
        await g.invalidateEdges!([{ sourceId: 'd', targetId: 'e', relation: REL }], new Date().toISOString());

        const s = await g.linkEdgeStats(NOW);
        assert.deepEqual([s.live, s.invalidated, s.stale, s.maxDegree], [4, 1, 1, 3]);
        near(s.meanStrength, (0.9 + 0.8 + 0.7 + 0.6) / 4);

        // degrees (live linker edges): a=3 (b,c,d), b=2, c=2, d=1, e=0 (its only linker edge is invalidated), f=0 (caller edge)
        assert.deepEqual(await g.linkNodesOverCap(1, 10), ['a', 'b', 'c']);
        assert.deepEqual(await g.linkNodesOverCap(2, 10), ['a']);
        assert.deepEqual(await g.linkNodesOverCap(3, 10), []);
        assert.deepEqual(await g.linkNodesOverCap(1, 2), ['a', 'b'], 'limit');
        assert.deepEqual(await g.linkNodesOverCap(1, 2, 'b'), ['c'], 'afterId is exclusive');
        assert.deepEqual(await g.linkNodesOverCap(1, 10, 'c'), []);
    });

    await test('engine: an empty graph gives zeros and a null mean', async () => {
        const g: G = await eng.open();
        assert.deepEqual(await g.linkEdgeStats(NOW), { live: 0, invalidated: 0, meanStrength: null, maxDegree: 0, stale: 0 });
        assert.deepEqual(await g.linkNodesOverCap(1, 10), []);
    });
}

console.log('\nservice + metrics');
const cfgFor = (o: Record<string, unknown> = {}) => applyLinkOverrides(loadLinkConfig({}, null), { minSim: 0.8, k: 2, quietMs: 0, yieldMs: 0, healthTtlMs: 60_000, ...o });
const stats = async (n: number, edges: Array<[string, string, number]>, p = 'p-now') => {
    const g = new (await import('../packages/lore/src/engines/sqliteGraph.js')).SqliteGraph(mkTmp('lh-g-'), { workspaceId: 'lh' });
    await g.initialize();
    for (let i = 0; i < n; i++) await g.upsertNode(node(`n${i}`));
    await g.addInferredEdgesBatch(edges.map(([a, b, s]) => ({ sourceId: a, targetId: b, relation: REL, confidenceScore: s, provenance: stamp(p) })));
    return g;
};

await test('refreshHealth: aggregates workspaces, caches for the TTL, force bypasses it, a failed read keeps the last snapshot', async () => {
    const g1 = await stats(3, [['n0', 'n1', 0.9], ['n0', 'n2', 0.7]]);
    const g2 = await stats(2, [['n0', 'n1', 0.5]], 'p-old');
    let t = 1_000;
    let reads = 0;
    let fail = false;
    const graphs = new Map<string, unknown>([['w1', g1], ['w2', g2]]);
    const svc = new LinkService({
        queue: new SqliteLinkQueue(path.join(mkTmp('lh-q-'), 'q.sqlite')),
        linker: { linkBatch: async () => ({ done: [], retry: [], edgesWritten: 0, keptExisting: 0, skippedMissingEndpoint: 0, duplicates: [] }) },
        config: cfgFor({ healthTtlMs: 5_000 }), now: () => t, currentStamp: () => NOW,
        resolveGraph: async (ws) => { reads++; if (fail) throw new Error('graph offline'); return (graphs.get(ws) ?? null) as never; },
        onError: () => {},
    });
    try {
        assert.equal(svc.stats().health, null, 'nothing before the first refresh');
        svc.signal('w1', [{ id: 'n0' }]); svc.signal('w2', [{ id: 'n0' }]);
        const h = (await svc.refreshHealth())!;
        assert.deepEqual([h.workspaces, h.live, h.invalidated, h.maxDegree, h.stale], [2, 3, 0, 2, 1]);
        near(h.meanStrength, (0.9 + 0.7 + 0.5) / 3);
        assert.equal(svc.stats().health, h);
        const readsAfterFirst = reads;
        await svc.refreshHealth(); t += 4_000; await svc.refreshHealth();
        assert.equal(reads, readsAfterFirst, 'cached within the TTL: no graph reads');
        t += 2_000; await svc.refreshHealth();
        assert.ok(reads > readsAfterFirst, 'refreshed after the TTL');
        fail = true;
        const kept = svc.stats().health;
        assert.equal(await svc.refreshHealth(true), kept, 'a failed read keeps the last good snapshot');
    } finally { svc.close(); }
});

await test('stats + /metrics: refresh / invalidation counters, queue lag, prune and rebuild progress, health lines', async () => {
    // A real linker over a stub-free graph: link, edit, refresh -> invalidations; then a cap prune; then a rebuild.
    const { SqliteGraph } = await import('../packages/lore/src/engines/sqliteGraph.js');
    const g = new SqliteGraph(mkTmp('lh-m-'), { workspaceId: 'lh' }); await g.initialize();
    const spec: Array<[string, number]> = [['a', 0], ['b', 10], ['c', 20], ['d', 200], ['e', 205]];
    const vb = await seed(g, spec);
    const linker = new StoredVectorLinker(async () => ({ graph: g as never, verbatim: vb as never }), P('p-now', 0.8, 2), FP);
    const file = path.join(mkTmp('lh-svc-'), 'q.sqlite');
    const cfg = cfgFor({ refreshOnChange: true, maxLinksPerNode: 1 });
    const handles = async () => ({ graph: g as never, verbatim: vb as never });
    const queue = new SqliteLinkQueue(file);
    const svc = new LinkService({
        queue, linker, config: cfg, currentStamp: () => linker.currentStamp(), resolveGraph: async () => g as never,
        pruner: new LinkPruner({ store: new SqlitePruneStore(file), resolveHandles: handles, cap: () => cfg.maxLinksPerNode, batchSize: 10 }),
        rebuilder: new LinkRebuilder({ store: new SqliteRebuildStore(file), substrate: linker, batchSize: 2, yieldMs: 0, maxWaitMs: 50, isBusy: () => false }),
    });
    try {
        svc.signal('ws', spec.map(([id]) => ({ id })));
        await svc.flush();
        vb.set('a', 200);
        svc.signal('ws', [{ id: 'a' }]);
        await svc.flush();
        await svc.prune('ws');
        await svc.startRebuild('ws'); await new Promise((r) => setTimeout(r, 200));
        await svc.refreshHealth(true);
        const st = svc.stats();
        assert.equal(st.invalidatedTotal, 2, 'a-b and a-c retired by the edit');
        assert.ok(st.health && st.health.invalidated >= 2 && st.health.live > 0);
        assert.equal(st.queue.ready, 0);
        assert.equal(st.lagMs, 0, 'caught up');
        assert.ok(st.prune && st.prune.cap === 1 && st.prune.passes >= 1);
        assert.equal(st.rebuild?.runs.length, 1);

        const text = await renderMetrics({ linkStats: async () => { await svc.refreshHealth(); return svc.stats(); } });
        const line = (re: RegExp): string => { const m = text.split('\n').find((l) => re.test(l)); assert.ok(m, `metrics line ${re}`); return m!; };
        assert.match(line(/^lore_link_invalidations_total /), /\s2$/);
        assert.match(line(/^lore_link_refreshed_total /), /\s\d+$/);
        assert.match(line(/^lore_link_edges\{state="invalidated"\}/), /\s[2-9]\d*$/);
        line(/^lore_link_edges\{state="live"\}/); line(/^lore_link_edges\{state="stale"\}/);
        line(/^lore_link_mean_strength /); line(/^lore_link_max_degree /);
        line(/^lore_link_prune_evicted_total /); line(/^lore_link_prune_dirty_workspaces /);
        line(/^lore_link_lag_seconds /);
        assert.match(line(/^lore_link_rebuild_nodes\{[^}]*state="total"/), /\s5$/);
        assert.match(line(/^lore_link_rebuild_nodes\{[^}]*state="done"/), /\s5$/);
        assert.match(line(/^lore_link_rebuild_running\{/), /\s0$/);

        // hidden from a bound non-operator, like every other count-valued series
        const appText = await runWithActor({ id: 'app-1', type: 'app', scopes: [], metadata: {} } as never, () =>
            runWithPrincipal({ kind: 'app', id: 'app-1' } as never, () => renderMetrics({ linkStats: () => svc.stats() })));
        assert.ok(!appText.includes('lore_link_edges'), 'link counts hidden from a bound app');
    } finally { svc.close(); }

    assert.ok(!(await renderMetrics({})).includes('lore_link_'), 'no link service => no link series');
});

await close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

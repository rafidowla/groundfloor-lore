#!/usr/bin/env tsx
/**
 * unit-deferred.ts — Pure unit tests for Q1.7 deferred-surfacing engine.
 *
 * Scope: findDeferredMatches + stampResolved in isolation. No daemon,
 * no Kùzu, no LanceDB — an in-memory GraphProvider double supplies
 * just enough of the contract for the engine's match logic to run.
 *
 * Cases covered:
 *   1. Path-overlap match (metadata.trigger_paths)
 *   2. Path-overlap match (legacy metadata.filePaths alias)
 *   3. Path-overlap match (file:<path> tag sugar)
 *   4. Topic-overlap match (label / content / tags substring)
 *   5. Topic-overlap match (metadata.trigger_tags)
 *   6. No-match case — unrelated topic + no path signal
 *   7. Resolved node is silent (metadata.resolved_at present)
 *   8. Non-deferred-* id is never surfaced
 *   9. Suffix-tolerant path match (abs vs relative)
 *  10. stampResolved writes ISO timestamp + commit, idempotent shape
 *  11. stampResolved rejects non-deferred-* id
 *
 * Plus: regression test for the acceptance invariant — "Edit a file
 * listed in a deferred node → recall sees it, no user prompt needed."
 *
 * Usage: npx tsx test/unit-deferred.ts
 * Exit:  0 all green, 1 any failure.
 */

import type { GraphProvider, GraphStats, LoreEdge, LoreNode, TraversalResult } from '../packages/lore/src/providers/types.js';
import { findDeferredMatches, stampResolved } from '../packages/lore/src/engines/deferred.js';

/* ─── In-memory GraphProvider double ──────────────────────────── */

class InMemoryGraph implements GraphProvider {
    private nodes = new Map<string, LoreNode>();

    async initialize(): Promise<void> {
        /* no-op */
    }

    async upsertNode(data: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>): Promise<LoreNode> {
        const now = new Date().toISOString();
        const prior = this.nodes.get(data.id);
        const node: LoreNode = {
            ...data,
            createdAt: prior?.createdAt ?? now,
            updatedAt: now,
            syncedAt: null,
        };
        this.nodes.set(data.id, node);
        return node;
    }

    async getNode(id: string): Promise<LoreNode | null> {
        return this.nodes.get(id) ?? null;
    }

    async deleteNode(id: string): Promise<boolean> {
        return this.nodes.delete(id);
    }

    async addEdge(_edge: LoreEdge): Promise<void> {
        /* unused */
    }

    async addBidirectionalEdge(_edge: LoreEdge): Promise<void> {
        /* unused */
    }

    async traverse(_nodeId: string, _maxDepth?: number): Promise<TraversalResult[]> {
        return [];
    }

    async search(_query: string, _limit?: number): Promise<LoreNode[]> {
        return [];
    }

    async listNodes(): Promise<LoreNode[]> {
        return Array.from(this.nodes.values());
    }

    async getStats(): Promise<GraphStats> {
        return {
            nodeCount: this.nodes.size,
            edgeCount: 0,
            typeBreakdown: {},
            pluginStats: {},
        };
    }

    async getTopology(): Promise<{ nodes: unknown[]; edges: unknown[] }> {
        return { nodes: [], edges: [] };
    }
}

/* ─── Test harness ────────────────────────────────────────────── */

interface Check {
    name: string;
    pass: boolean;
    detail?: string;
}
const checks: Check[] = [];
function record(name: string, pass: boolean, detail?: string): void {
    checks.push({ name, pass, detail });
    const icon = pass ? '✓' : '✗';
    const color = pass ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    console.log(`  ${color}${icon}${reset} ${name}${detail ? ` — ${detail}` : ''}`);
}

function assertEq<T>(label: string, got: T, want: T): void {
    const pass = JSON.stringify(got) === JSON.stringify(want);
    record(label, pass, pass ? undefined : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

/* ─── Builders ────────────────────────────────────────────────── */

function makeDeferredNode(opts: {
    id: string;
    label?: string;
    content?: string;
    tags?: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
    type?: string;
}): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> & { createdAt?: string } {
    return {
        id: opts.id,
        type: opts.type ?? 'decision',
        label: opts.label ?? 'stub',
        content: opts.content ?? '',
        tags: opts.tags ?? '',
        project: 'test',
        ecosystem: 'test',
        metadata: opts.metadata ? JSON.stringify(opts.metadata) : '',
        security_scopes: [],
        language: null,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    };
}

async function seedWith(
    graph: InMemoryGraph,
    seeds: Array<ReturnType<typeof makeDeferredNode>>,
): Promise<void> {
    for (const s of seeds) {
        // Strip synthetic createdAt override before upsert; we'll patch in-place after.
        const { createdAt, ...rest } = s as unknown as { createdAt?: string } & Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;
        void createdAt;
        await graph.upsertNode(rest);
    }
}

/* ─── Tests ───────────────────────────────────────────────────── */

async function testFileMatchTriggerPaths(): Promise<void> {
    console.log('\n─── 1. File-match via metadata.trigger_paths ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-foo',
            label: 'Fix foo',
            metadata: { trigger_paths: ['packages/lore/src/engines/cache.ts'] },
        }),
    ]);

    const hits = await findDeferredMatches(g, { filePaths: ['packages/lore/src/engines/cache.ts'] });
    record('file-match returns the deferred node', hits.length === 1 && hits[0].id === 'deferred-foo');
    record('reason is file-match', hits[0]?.reason === 'file-match');
    record('filePaths populated from trigger_paths', JSON.stringify(hits[0]?.filePaths) === JSON.stringify(['packages/lore/src/engines/cache.ts']));
}

async function testFileMatchLegacyFilePaths(): Promise<void> {
    console.log('\n─── 2. File-match via legacy metadata.filePaths alias ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-legacy',
            metadata: { filePaths: ['src/foo.ts'] },
        }),
    ]);
    const hits = await findDeferredMatches(g, { filePaths: ['src/foo.ts'] });
    record('legacy filePaths alias still matches', hits.length === 1 && hits[0].id === 'deferred-legacy');
}

async function testFileMatchTagSugar(): Promise<void> {
    console.log('\n─── 3. File-match via file:<path> tag sugar ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-tagged',
            tags: 'drawer,file:ui/src/components/NodeDetailDrawer.tsx,plugin-boundary',
        }),
    ]);
    const hits = await findDeferredMatches(g, { filePaths: ['ui/src/components/NodeDetailDrawer.tsx'] });
    record('file:<path> tag match', hits.length === 1 && hits[0].reason === 'file-match');
}

async function testTopicMatch(): Promise<void> {
    console.log('\n─── 4. Topic-match via label / content / tags ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-drawer',
            label: 'Recalibrate hook on ILorePlugin',
            content: 'routes through reconnect_node handler',
            tags: 'drawer,recalibrate',
        }),
    ]);
    const hits = await findDeferredMatches(g, { topic: 'Recalibrate' });
    record('topic substring (case-insensitive) finds node', hits.length === 1 && hits[0].reason === 'topic-match');
}

async function testTopicMatchTriggerTags(): Promise<void> {
    console.log('\n─── 5. Topic-match via metadata.trigger_tags ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-trigger-tag',
            label: 'unrelated label',
            content: 'unrelated content',
            tags: 'unrelated,tags',
            metadata: { trigger_tags: ['ILorePlugin', 'reconnect_node'] },
        }),
    ]);
    const hits = await findDeferredMatches(g, { topic: 'ILorePlugin' });
    record('trigger_tags contribute to topic match', hits.length === 1 && hits[0].id === 'deferred-trigger-tag');
}

async function testNoMatch(): Promise<void> {
    console.log('\n─── 6. No-match case ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-x',
            label: 'Specific thing',
            metadata: { trigger_paths: ['foo.ts'] },
        }),
    ]);
    const hits = await findDeferredMatches(g, {
        topic: 'completely-unrelated-string',
        filePaths: ['totally/different.ts'],
    });
    assertEq('empty result when nothing overlaps', hits.length, 0);
}

async function testResolvedSilent(): Promise<void> {
    console.log('\n─── 7. Resolved nodes do not surface ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-done',
            label: 'Done work',
            metadata: {
                trigger_paths: ['done.ts'],
                resolved_at: '2026-04-23T19:30:24.552Z',
                resolved_by_commit: 'abc1234',
            },
        }),
    ]);
    const hits = await findDeferredMatches(g, { filePaths: ['done.ts'] });
    assertEq('resolved deferred node is silent', hits.length, 0);
}

async function testNonDeferredIgnored(): Promise<void> {
    console.log('\n─── 8. Non-deferred-* id is never surfaced ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'decision-something',
            label: 'Normal decision',
            metadata: { trigger_paths: ['normal.ts'] },
        }),
    ]);
    const hits = await findDeferredMatches(g, { filePaths: ['normal.ts'] });
    assertEq('decision-* id is ignored by surfacing', hits.length, 0);
}

async function testSuffixTolerantPaths(): Promise<void> {
    console.log('\n─── 9. Suffix-tolerant path matching ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-abs',
            metadata: { trigger_paths: ['src/engines/cache.ts'] },
        }),
    ]);
    // Absolute path from the hook should still overlap a relative stored path.
    const hits = await findDeferredMatches(g, { filePaths: ['/abs/repo/src/engines/cache.ts'] });
    record('abs-path signal matches rel-path store', hits.length === 1);

    // And the reverse direction: stored abs, signal rel.
    const g2 = new InMemoryGraph();
    await seedWith(g2, [
        makeDeferredNode({
            id: 'deferred-rel',
            metadata: { trigger_paths: ['/abs/repo/src/engines/cache.ts'] },
        }),
    ]);
    const hits2 = await findDeferredMatches(g2, { filePaths: ['src/engines/cache.ts'] });
    record('rel-path signal matches abs-path store', hits2.length === 1);
}

async function testStampResolved(): Promise<void> {
    console.log('\n─── 10. stampResolved writes ISO + commit ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-resolve-me',
            label: 'work to close',
            metadata: { trigger_paths: ['whatever.ts'] },
        }),
    ]);
    const result = await stampResolved(g, 'deferred-resolve-me', 'a1b2c3d');
    record('stampResolved returns result object', result !== null);
    const metaStr = (await g.getNode('deferred-resolve-me'))!.metadata;
    const meta = JSON.parse(metaStr);
    record('metadata.resolved_at is ISO-like', typeof meta.resolved_at === 'string' && meta.resolved_at.includes('T'));
    record('metadata.resolved_by_commit set', meta.resolved_by_commit === 'a1b2c3d');

    // Acceptance invariant — after resolution, the node no longer surfaces.
    const hits = await findDeferredMatches(g, { filePaths: ['whatever.ts'] });
    assertEq('resolved node disappears from next recall()', hits.length, 0);
}

async function testStampResolvedRejectsNonDeferred(): Promise<void> {
    console.log('\n─── 11. stampResolved rejects non-deferred-* ids ───');
    const g = new InMemoryGraph();
    await seedWith(g, [
        makeDeferredNode({
            id: 'decision-x',
            label: 'not a deferred node',
        }),
    ]);
    let threw = false;
    try {
        await stampResolved(g, 'decision-x');
    } catch {
        threw = true;
    }
    record('throws on non-deferred-* id', threw);

    // Missing id → null
    const missing = await stampResolved(g, 'deferred-does-not-exist');
    assertEq('returns null on missing deferred node', missing, null as unknown as typeof missing);
}

async function testAcceptanceRegression(): Promise<void> {
    console.log('\n─── 12. Regression: edit file in deferred node → recall surfaces it ───');
    const g = new InMemoryGraph();
    // Simulate: store deferred node with trigger_paths: ["foo.ts"]
    await seedWith(g, [
        makeDeferredNode({
            id: 'deferred-regression',
            label: 'Finish foo',
            content: 'details about foo',
            metadata: { trigger_paths: ['foo.ts'] },
        }),
    ]);

    // Simulate: PostToolUse hook fires with currentContext.paths = ["foo.ts"]
    const hits = await findDeferredMatches(g, { topic: '', filePaths: ['foo.ts'] });

    record('deferred node is surfaced', hits.length === 1);
    record('surfaced match has correct id', hits[0]?.id === 'deferred-regression');
    record('surfacing fires even with empty topic', hits[0]?.reason === 'file-match');
}

/* ─── Run all ─────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('═══ Q1.7 unit tests — deferred surfacing ═══');
    await testFileMatchTriggerPaths();
    await testFileMatchLegacyFilePaths();
    await testFileMatchTagSugar();
    await testTopicMatch();
    await testTopicMatchTriggerTags();
    await testNoMatch();
    await testResolvedSilent();
    await testNonDeferredIgnored();
    await testSuffixTolerantPaths();
    await testStampResolved();
    await testStampResolvedRejectsNonDeferred();
    await testAcceptanceRegression();

    const failed = checks.filter((c) => !c.pass);
    console.log(`\n─── Summary: ${checks.length - failed.length}/${checks.length} passed ───`);
    if (failed.length > 0) {
        console.log('Failed checks:');
        for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('Unit test harness crashed:', err);
    process.exit(1);
});

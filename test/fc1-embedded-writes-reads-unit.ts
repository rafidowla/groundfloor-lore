#!/usr/bin/env tsx
/**
 * test/fc1-embedded-writes-reads-unit.ts — 2026-08-17 functional-correctness
 * audit, cluster 1 findings 1.1 / 1.2 / M1 (embedded surface).
 *
 *   1.1 — SurrealDB (the DEFAULT graph engine) drops concurrent single writes
 *         with "Transaction conflict" because withTransactionConflictRetry was
 *         wired only into bulkIngest. Now wrapped at lib:nodeUpsert +
 *         lib:nodeUpsertBatch (server.ts), MCP store_node, and POST /api/node.
 *   1.2 — lore.store.storageClient reads were bound to the BOOT workspace's
 *         graph/vector store with no workspace routing, so a workspace-scoped
 *         write read back as "nothing stored". The facade now takes an
 *         optional `workspace` option routed through the graph registry /
 *         verbatim resolver.
 *   M1  — awaitEmbeds() resolved instantly when the outbox was wired (the
 *         default), because embeds flow through outbox rows, not the
 *         in-memory embed queue. It now also pumps the replicator until no
 *         workspace has pending/failed outbox rows.
 *
 * Harness: one real embedded createLore boot (SurrealDB default engine),
 * mirroring the audit's RAN-AND-OBSERVED repros.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/fc1-embedded-writes-reads-unit.ts
 */

import assert from 'node:assert/strict';
import { createLore } from '../packages/lore/src/index.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    const client = lore.store.storageClient;

    console.log('1.1 — concurrent single writes no longer drop on SurrealDB conflicts');

    await test('T1.1a 12 concurrent nodeUpsert (distinct ids) — zero rejections', async () => {
        const results = await Promise.allSettled(
            Array.from({ length: 12 }, (_, i) =>
                lore.nodeUpsert({
                    id: `fc11-${i}`, workspace: 'default', ecosystem: 'probe',
                    nodeData: { id: `fc11-${i}`, type: 'note', label: `fc11 ${i}`, content: `pangolin marker ${i}` },
                    asyncEmbed: true,
                } as never),
            ),
        );
        const rejected = results.filter((r) => r.status === 'rejected');
        assert.equal(rejected.length, 0,
            `pre-1.1 fix this dropped writes: ${rejected.map((r) => (r as PromiseRejectedResult).reason?.message).join(' | ')}`);
        // …and every node actually landed.
        for (let i = 0; i < 12; i++) {
            assert.ok(await client.getNode(`fc11-${i}`), `fc11-${i} must be in the graph`);
        }
    });

    await test('T1.1b nodeUpsertBatch(8) succeeds (pre-fix threw for every size ≥ 2)', async () => {
        const results = await lore.nodeUpsertBatch(
            Array.from({ length: 8 }, (_, i) => ({
                id: `fc11b-${i}`, workspace: 'default', ecosystem: 'probe',
                nodeData: { id: `fc11b-${i}`, type: 'note', label: `fc11b ${i}`, content: `batch pangolin ${i}` },
            })) as never[],
        );
        assert.equal(results.length, 8);
        const bad = results.filter((r: { ok: boolean }) => !r.ok);
        assert.equal(bad.length, 0, `batch must not lose nodes: ${JSON.stringify(bad)}`);
    });

    console.log('1.2 — facade reads route to the requested workspace');

    // Register + write into a SECOND workspace (the audit repro shape).
    createWorkspace('alpha', {}, dataDir);
    const w = await lore.nodeUpsert({
        id: 'a-1', workspace: 'alpha', ecosystem: '*',
        nodeData: { id: 'a-1', type: 'note', label: 'alpha note', content: 'pangolin protocol alpha' },
        asyncEmbed: false,
    } as never);
    assert.equal((w as { ok: boolean }).ok, true, 'write ok (this always worked)');

    await test('T1.2a getNode with {workspace} finds the node; without it stays boot-scoped', async () => {
        const routed = await client.getNode('a-1', { workspace: 'alpha' });
        assert.ok(routed, 'getNode(a-1, {workspace:alpha}) must find the node (pre-fix: null)');
        assert.equal(routed!.id, 'a-1');
        const boot = await client.getNode('a-1');
        assert.equal(boot, null, 'boot graph must NOT see alpha’s node (isolation preserved)');
    });

    await test('T1.2b listNodes/search/getStats route per workspace', async () => {
        const list = await client.listNodes(undefined, undefined, '*', '*', undefined, { workspace: 'alpha' });
        assert.ok(list.some((n) => n.id === 'a-1'), `listNodes(alpha) must include a-1 (got ${list.map((n) => n.id)})`);
        const hits = await client.search('pangolin', 10, '*', '*', { workspace: 'alpha' });
        assert.ok(hits.some((n) => n.id === 'a-1'), 'search(alpha) must find a-1');
        const stats = await client.getStats(undefined, { workspace: 'alpha' });
        assert.equal(stats.nodeCount, 1, `alpha nodeCount must be 1 (got ${stats.nodeCount})`);
        // Boot-graph stats must NOT include alpha’s node (routing, not aggregation).
        const bootStats = await client.getStats();
        assert.notEqual(bootStats.nodeCount, stats.nodeCount,
            'boot and alpha stats must differ — identical counts would prove the router is decorative');
    });

    await test('T1.2c lore.search(query, limit, workspace) routes (was silently the project slot)', async () => {
        const hits = await lore.search('pangolin', 10, 'alpha');
        assert.ok(hits.some((n) => n.id === 'a-1'), 'lore.search(..., alpha) must find a-1');
    });

    console.log('M1 — awaitEmbeds is a real durability barrier with the outbox wired');

    await test('T1.M1 awaitEmbeds → verbatim row present for the workspace-routed write', async () => {
        await lore.awaitEmbeds();
        const count = await client.verbatimCount({ workspace: 'alpha' });
        assert.ok(count >= 1,
            `alpha verbatim count must be ≥ 1 after awaitEmbeds (got ${count}) — pre-fix the barrier was a no-op and this could read 0`);
        const countBoot = await client.verbatimCount();
        assert.ok(countBoot >= 12, `boot verbatim count covers T1.1 embeds (got ${countBoot})`);
    });

    await lore.dispose();

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

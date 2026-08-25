#!/usr/bin/env tsx
/**
 * fc-round5-conflict-retry-coverage-e2e.ts — 2026-08-18 gap 2.
 *
 * Finding 1.1's withTransactionConflictRetry fix covered 4 call sites; the
 * rest of the direct-graph-write surface still threw SurrealDB's retryable
 * "Transaction conflict" on concurrent writes. This exercises the newly
 * wrapped surfaces at the real production entry point (embedded createLore,
 * SurrealGraph default engine):
 *
 *   T1. LoreStorageClient.upsertNode — 12 concurrent writes to the SAME id
 *       (overlapping key — the conflict-prone case). Pre-fix: 7/12 rejected.
 *   T2. LoreStorageClient.upsertNode — 12 concurrent DISTINCT ids.
 *   T3. LoreStorageClient.addEdge — 12 concurrent edges sharing endpoints.
 *   T4. LoreStorageClient.bulkUpsertNodes — facade fallback loop path.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/fc-round5-conflict-retry-coverage-e2e.ts
 */

import assert from 'node:assert/strict';
import { createLore } from '../packages/lore/src/index.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n    ${(err as Error).stack ?? (e2msg(err))}`); }
}
function e2msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    const client = lore.store.storageClient;

    console.log('gap 2 — conflict-retry coverage on the remaining direct-write surfaces');

    await test('T1 12 concurrent facade upsertNode, SAME id — zero rejections', async () => {
        const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
            client.upsertNode({
                id: 'gap2-same', type: 'note', label: `same ${i}`,
                content: `gap2 concurrent write ${i}`, project: 'default', ecosystem: 'probe',
            } as never)));
        const rejected = results.filter((r) => r.status === 'rejected');
        assert.equal(rejected.length, 0,
            `${rejected.length}/12 rejected — first: ${rejected[0] ? e2msg((rejected[0] as PromiseRejectedResult).reason) : ''}`);
        const node = await client.getNode('gap2-same');
        assert.ok(node, 'node must exist after concurrent same-id writes');
    });

    await test('T2 12 concurrent facade upsertNode, DISTINCT ids — zero rejections', async () => {
        const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
            client.upsertNode({
                id: `gap2-dist-${i}`, type: 'note', label: `dist ${i}`,
                content: `gap2 distinct ${i}`, project: 'default', ecosystem: 'probe',
            } as never)));
        const rejected = results.filter((r) => r.status === 'rejected');
        assert.equal(rejected.length, 0,
            `${rejected.length}/12 rejected — first: ${rejected[0] ? e2msg((rejected[0] as PromiseRejectedResult).reason) : ''}`);
        for (let i = 0; i < 12; i++) assert.ok(await client.getNode(`gap2-dist-${i}`), `gap2-dist-${i} missing`);
    });

    await test('T3 12 concurrent facade addEdge, overlapping endpoints — zero rejections', async () => {
        // Two endpoint nodes shared by every edge (overlapping keys).
        for (const id of ['gap2-e-a', 'gap2-e-b']) {
            await client.upsertNode({
                id, type: 'note', label: id, content: 'endpoint',
                project: 'default', ecosystem: 'probe',
            } as never);
        }
        const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
            client.addEdge({
                sourceId: 'gap2-e-a', targetId: 'gap2-e-b',
                relation: `gap2_rel_${i}`, confidence: 'extracted', confidenceScore: 1.0,
            } as never)));
        const rejected = results.filter((r) => r.status === 'rejected');
        assert.equal(rejected.length, 0,
            `${rejected.length}/12 rejected — first: ${rejected[0] ? e2msg((rejected[0] as PromiseRejectedResult).reason) : ''}`);
    });

    await test('T4 facade bulkUpsertNodes — every node ok', async () => {
        const res = await client.bulkUpsertNodes(Array.from({ length: 12 }, (_, i) => ({
            id: `gap2-bulk-${i}`, type: 'note', label: `bulk ${i}`,
            content: `gap2 bulk ${i}`, project: 'default', ecosystem: 'probe',
        } as never)));
        const bad = res.filter((r) => !r.ok);
        assert.equal(bad.length, 0, `bulk results not all ok: ${JSON.stringify(bad)}`);
    });

    await lore.dispose();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

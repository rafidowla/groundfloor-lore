#!/usr/bin/env tsx
/**
 * fc-round6-composite-verb-conflict-retry-e2e.ts — 2026-08-18 round-6 gap 1.
 *
 * d707178 wrapped the raw upsertNode/addEdge call sites but excluded the
 * graph-level composite verbs as "engine methods". That exclusion failed
 * live verification: SurrealGraph.supersedeNode has no retry anywhere in
 * its call chain and hits SurrealDB's optimistic-concurrency "Transaction
 * conflict" under concurrent DISTINCT-key load running alongside other
 * graph writes (the engine's per-key nodeWriteChain mutex only serializes
 * same-key writes — same-key testing looks safe for the wrong reason).
 *
 * The retry now lives at the STATEMENT level inside the engine write
 * helpers (surrealGraphWrites.ts / surrealGraphOverview.ts), so every
 * caller — MCP tool, HTTP route, CLI, facade, maintenance — inherits it.
 *
 * This drives the REAL production entry point (embedded createLore,
 * SurrealGraph default engine) with the repro shape the verifier
 * confirmed: distinct keys, supersede/unsupersede concurrent WITH a
 * background fan-out of other graph writes.
 *
 *   T1  12 concurrent supersedeNode (distinct old ids) alongside 24
 *       concurrent node writes → zero failures, final state correct.
 *   T2  12 concurrent unsupersedeNode under the same mixed load → zero throws.
 *   T3  markStaleByTags + archiveNode statements participate under the same
 *       load (the sibling composite verbs swept in the same fix).
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/fc-round6-composite-verb-conflict-retry-e2e.ts
 */

import assert from 'node:assert/strict';
import { createLore } from '../packages/lore/src/index.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) =>
    (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
    })();
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    const client = lore.store.storageClient;

    console.log('round-6 gap 1 — composite lifecycle verbs retry SurrealDB conflicts (real engine, distinct keys + mixed load)');

    // Seed: 12 supersede pairs (distinct keys) + background-write targets.
    const N = 12;
    for (let i = 0; i < N; i++) {
        for (const id of [`old-${i}`, `new-${i}`]) {
            await client.upsertNode({
                id, type: 'note', label: id, content: `seed ${id}`,
                project: 'default', ecosystem: 'probe',
            } as never);
        }
    }
    for (let i = 0; i < 24; i++) {
        await client.upsertNode({
            id: `bg-${i}`, type: 'note', label: `bg ${i}`, content: `background ${i}`,
            project: 'default', ecosystem: 'probe',
        } as never);
    }

    /** Background fan-out of other concurrent graph writes (the load that
     *  makes distinct-key supersedes actually collide in SurrealDB). */
    const backgroundLoad = (round: number): Promise<unknown> => Promise.allSettled(
        Array.from({ length: 24 }, (_, i) =>
            client.upsertNode({
                id: `bg-${i}`, type: 'note', label: `bg ${i}`,
                content: `background ${i} round ${round}`,
                project: 'default', ecosystem: 'probe',
            } as never)));

    await test(`T1 ${N} concurrent supersedeNode (distinct keys) alongside other writes — zero failures`, async () => {
        const [supersedes, _bg] = await Promise.all([
            Promise.allSettled(Array.from({ length: N }, (_, i) =>
                client.supersedeNode(`old-${i}`, `new-${i}`, 'round6-repro'))),
            backgroundLoad(1),
        ]);
        const rejected = supersedes.filter((r) => r.status === 'rejected');
        const conflictRejections = rejected.filter((r) => /transaction conflict/i.test(msg((r as PromiseRejectedResult).reason)));
        assert.equal(conflictRejections.length, 0,
            `${conflictRejections.length}/${N} supersedes died on a retryable Transaction conflict — first: ${conflictRejections[0] ? msg((conflictRejections[0] as PromiseRejectedResult).reason) : ''}`);
        const notOk = supersedes.filter((r) => r.status === 'fulfilled'
            && (r as PromiseFulfilledResult<{ ok: boolean; reason?: string }>).value.ok !== true);
        assert.equal(notOk.length, 0,
            `${notOk.length}/${N} supersedes returned not-ok: ${JSON.stringify(notOk[0] && (notOk[0] as PromiseFulfilledResult<{ ok: boolean; reason?: string }>).value)}`);
        // Final state: every old node carries its supersession.
        for (let i = 0; i < N; i++) {
            const node = await client.getNode(`old-${i}`);
            assert.equal(node?.supersededBy, `new-${i}`, `old-${i}.supersededBy wrong: ${node?.supersededBy}`);
        }
    });

    await test(`T2 ${N} concurrent unsupersedeNode under the same mixed load — zero throws`, async () => {
        const [unsupersedes, _bg] = await Promise.all([
            Promise.allSettled(Array.from({ length: N }, (_, i) => client.unsupersedeNode(`old-${i}`))),
            backgroundLoad(2),
        ]);
        const rejected = unsupersedes.filter((r) => r.status === 'rejected');
        const conflictRejections = rejected.filter((r) => /transaction conflict/i.test(msg((r as PromiseRejectedResult).reason)));
        assert.equal(conflictRejections.length, 0,
            `${conflictRejections.length}/${N} unsupersedes died on a retryable Transaction conflict — first: ${conflictRejections[0] ? msg((conflictRejections[0] as PromiseRejectedResult).reason) : ''}`);
        const allTrue = unsupersedes.every((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<boolean>).value === true);
        assert.ok(allTrue, 'an unsupersede returned false (node missing?)');
    });

    await test('T3 sibling composite verbs (markStaleByTags, archiveNode) hold under the same load', async () => {
        const graph = client.rawGraph() as unknown as {
            archiveNode(id: string): Promise<void>;
        };
        // Give the bg nodes the tag the stale-sweep targets.
        for (let i = 0; i < 24; i++) {
            await client.upsertNode({
                id: `bg-${i}`, type: 'note', label: `bg ${i}`,
                content: `background ${i} tagged`, project: 'default', ecosystem: 'probe',
                tags: 'round6tag',
            } as never);
        }
        const [stale, archives, _bg] = await Promise.all([
            client.markStaleByTags(['round6tag']),
            Promise.allSettled(Array.from({ length: 4 }, (_, i) => graph.archiveNode(`old-${i}`))),
            backgroundLoad(3),
        ]);
        assert.ok(Number.isFinite(stale) && stale >= 0, `markStaleByTags threw or malformed: ${stale}`);
        const rejected = archives.filter((r) => r.status === 'rejected');
        const conflictRejections = rejected.filter((r) => /transaction conflict/i.test(msg((r as PromiseRejectedResult).reason)));
        assert.equal(conflictRejections.length, 0,
            `${conflictRejections.length}/4 archiveNodes died on a retryable Transaction conflict`);
        for (let i = 0; i < 4; i++) {
            const node = await client.getNode(`old-${i}`);
            assert.equal(node?.status, 'archived', `old-${i}.status should be archived, got ${node?.status}`);
        }
    });

    await lore.dispose();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

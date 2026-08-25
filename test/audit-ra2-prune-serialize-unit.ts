#!/usr/bin/env tsx
/**
 * audit-ra2-prune-serialize-unit.ts — re-audit 2026-06-25 (MEDIUM, concurrency).
 *
 * pruneEphemeralNodes batch-deleted expired ephemerals via a single bulk
 * statement, NOT the per-id write chain. So a prune could interleave between
 * a concurrent upsert's existence-check and its SET — the SET then matched
 * zero rows: a SILENT lost write. It now deletes each expired id through
 * deleteNode(), which serializes on the per-id node write chain (the same
 * guard upsert/delete/supersede use, pinned by nw1d) and clears edges +
 * bumps the read-cache epoch.
 *
 * This pins (a) prune's functional correctness and (b) a concurrency smoke:
 * prune racing same-id upserts produces no SILENT lost write and a coherent
 * graph.
 *
 * KNOWN GAP (2026-08-20, surfaced by the Kùzu→SurrealDB repoint, NOT papered
 * over here): SurrealGraph's writes.upsertNode is the ONE composite write
 * verb without the engine-layer transaction-conflict retry — deleteNode,
 * supersedeNode, unsupersedeNode, markStaleByTags, pruneInferredLoreEdges
 * and archiveNode all wrap in withTransactionConflictRetry (Round-7/86bb3b7,
 * live-observed 500s), but a delete-vs-upsert race on one id can still
 * exhaust nothing and surface SurrealDB's "Transaction conflict ... can be
 * retried" straight out of upsertNode. The failure is LOUD (caller sees the
 * error; nodeUpsert retracts its outbox row), so the original audit's
 * silent-lost-write invariant holds — but the zero-rejection guarantee the
 * Kùzu engine's global write queue gave this race does not, until upsertNode
 * gets the same retry wrap. The smoke below therefore accepts ONLY that
 * documented conflict class as a rejection and still fails on any silent
 * loss, torn state, or ghost row.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const mk = (id: string, ephemeral: boolean, extra: Record<string, unknown> = {}) => ({
    id, type: 'note', label: id, content: 'c', tags: ['t'], project: 'p', ecosystem: '*',
    metadata: '{}', ephemeral, ttl_ms: 0, ...extra,
}) as never;

console.log('RA-2 — pruneEphemeralNodes serializes deletes (no silent lost write)');

await test('prune(ttl=-1) deletes expired ephemerals; permanents survive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ra2-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        await g.upsertNode(mk('eph-1', true));
        await g.upsertNode(mk('eph-2', true));
        await g.upsertNode(mk('perm-1', false));
        // ttl=-1 → every ephemeral is immediately "expired" (now - createdAt > -1).
        const deleted = await g.pruneEphemeralNodes(-1);
        assert.equal(deleted, 2, 'both ephemerals pruned');
        assert.equal(await g.getNode('eph-1'), null);
        assert.equal(await g.getNode('eph-2'), null);
        assert.ok(await g.getNode('perm-1'), 'permanent node must survive prune');
        await g.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('prune leaves not-yet-expired ephemerals (large ttl) intact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ra2-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        await g.upsertNode(mk('fresh-eph', true));
        const deleted = await g.pruneEphemeralNodes(60 * 60 * 1000); // 1h ttl, node just created
        assert.equal(deleted, 0, 'a fresh ephemeral is not pruned');
        assert.ok(await g.getNode('fresh-eph'));
        await g.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('concurrency smoke: prune racing same-id re-upserts → no SILENT loss, coherent graph', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ra2-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        const N = 25;
        const ids = Array.from({ length: N }, (_, i) => `race-${i}`);
        for (const id of ids) await g.upsertNode(mk(id, true));

        // Race the prune (deletes all, ttl=-1) against a re-upsert of every id
        // as a PERMANENT node. Original invariant: no upsert may be SILENTLY
        // lost. On SurrealGraph a losing upsert may reject LOUDLY with the
        // documented retryable-conflict error (see the KNOWN GAP above) —
        // that is caller-visible failure, not silent loss, so it is the one
        // accepted rejection class here; anything else fails the test.
        const reups = ids.map((id) => g.upsertNode(mk(id, false, { label: 'refreshed' })));
        const settled = await Promise.allSettled([g.pruneEphemeralNodes(-1), ...reups]);
        for (let i = 0; i < settled.length; i++) {
            const s = settled[i]!;
            if (s.status === 'rejected') {
                const msg = String((s as PromiseRejectedResult).reason?.message ?? '');
                assert.match(
                    msg, /transaction conflict/i,
                    `slot ${i} rejected with an UNEXPECTED error (only the documented retryable-conflict class is acceptable): ${msg}`,
                );
            }
        }

        // Coherence: any surviving node must be the fully-written refreshed one
        // (never a half-written ghost), and getStats must match a real scan.
        for (const id of ids) {
            const n = await g.getNode(id);
            if (n) assert.equal(n.label, 'refreshed', `${id} survived but is not the refreshed write (torn state)`);
        }
        const stats = await g.getStats();
        const present = (await Promise.all(ids.map((id) => g.getNode(id)))).filter(Boolean).length;
        assert.equal(stats.nodeCount, present, 'getStats nodeCount matches an actual node scan (no ghost rows)');
        await g.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

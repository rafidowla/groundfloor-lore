#!/usr/bin/env tsx
/**
 * access-coldness-surreal-unit.ts — regression test for the X-accesstimes
 * audit finding: the access-time coldness signal
 * (docs/design/maintain-access-coldness.md) was implemented ONLY on the
 * prior local graph engine (deleted 2026-08-21 — see surrealGraph.ts's
 * header). `SurrealGraph` never got an equivalent `stampAccessTimes`, so
 * `engines/accessTracker.ts`'s `ensureAccessTracker()` feature-detect always
 * failed on the only local engine left standing: `lore maintain`'s
 * retrieval-coldness retention was a silent no-op.
 *
 * Proves, against a REAL SurrealGraph:
 *   1. `ensureAccessTracker(graph)` no longer returns null (the actual
 *      symptom of the regression — this was the observable no-op).
 *   2. `stampAccessTimes` sets `lastAccessedAt` (+ `last_retrieved_at` when
 *      the entry carries a retrievedAt) via the SAME `AccessTracker.touch →
 *      flush` path production read handlers use.
 *   3. An untouched node's access columns stay null.
 *   4. The two invariants from the design doc: no read-cache epoch bump, no
 *      `updatedAt`/`syncedAt` mutation.
 *   5. End-to-end: `maintain`'s `selectRetentionCandidates` (cold_signal=
 *      'access') actually spares the touched node and selects the untouched
 *      one — the real consumer this signal exists for.
 *   6. Best-effort: a failing write (read-only-style error, and a
 *      transaction-conflict/lock-style error) is swallowed, never thrown —
 *      this runs off the debounced background flush, not the read path.
 *
 * Run: npx tsx test/access-coldness-surreal-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { stampAccessTimes as writesStampAccessTimes } from '../packages/lore/src/engines/surreal/surrealGraphWrites.js';
import {
    ensureAccessTracker,
    disposeAccessTracker,
} from '../packages/lore/src/engines/accessTracker.js';
import {
    selectRetentionCandidates,
    type NodeForSelection,
} from '../packages/lore/src/engines/maintain/selection.js';
import { resolveMaintainPolicy } from '../packages/lore/src/engines/maintain/policy.js';
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

async function withGraph(fn: (g: SurrealGraph, dir: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-access-coldness-'));
    const graph = new SurrealGraph(dir, { workspaceId: 'test-ws' });
    try {
        await graph.initialize();
        await fn(graph, dir);
    } finally {
        await graph.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function node(id: string): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'note',
        label: `Label ${id}`,
        content: `Content for ${id}`,
        tags: ['x'],
        project: 'proj',
        ecosystem: '*',
        metadata: '{}',
    };
}

async function main(): Promise<void> {
    console.log('access-coldness-surreal-unit: SurrealGraph access-time coldness signal\n');

    // ── 1+2+3: AccessTracker wiring + stamp/no-stamp, via the real production path ──
    await test('ensureAccessTracker(SurrealGraph) is no longer a no-op (the regression itself)', async () => {
        await withGraph(async (graph) => {
            const tracker = ensureAccessTracker(graph);
            assert.notEqual(tracker, null,
                'ensureAccessTracker feature-detects stampAccessTimes; null here means the ' +
                'coldness signal is silently disabled on SurrealGraph, exactly the regression');
            await disposeAccessTracker(graph);
        });
    });

    await test('touch() + flush() stamps lastAccessedAt + last_retrieved_at on retrieval', async () => {
        await withGraph(async (graph) => {
            await graph.upsertNode(node('touched'));
            await graph.upsertNode(node('untouched'));

            const tracker = ensureAccessTracker(graph);
            assert.ok(tracker, 'tracker must exist for this test to prove anything');
            tracker!.touch(['touched'], 'retrieval');
            const flushed = await tracker!.flush();
            assert.equal(flushed, 1, 'one node stamped');

            const touched = await graph.getNode('touched');
            assert.ok(touched, 'node must still exist');
            assert.ok(touched!.lastAccessedAt, 'lastAccessedAt must be set');
            assert.ok(touched!.last_retrieved_at, 'last_retrieved_at must be set (source=retrieval)');
            assert.ok(!Number.isNaN(Date.parse(touched!.lastAccessedAt!)), 'lastAccessedAt is a valid ISO timestamp');

            const untouched = await graph.getNode('untouched');
            assert.ok(untouched, 'node must still exist');
            assert.equal(untouched!.lastAccessedAt, null, 'untouched node stays unstamped');
            assert.equal(untouched!.last_retrieved_at, null, 'untouched node stays unstamped');

            await disposeAccessTracker(graph);
        });
    });

    await test("source='read' stamps lastAccessedAt only (no last_retrieved_at)", async () => {
        await withGraph(async (graph) => {
            await graph.upsertNode(node('browsed'));
            const marked = await graph.stampAccessTimes([
                { id: 'browsed', accessedAt: new Date().toISOString() },
            ]);
            assert.equal(marked, 1);
            const n = await graph.getNode('browsed');
            assert.ok(n!.lastAccessedAt, 'lastAccessedAt set');
            assert.equal(n!.last_retrieved_at, null, 'last_retrieved_at NOT set — this was only a browse, not a retrieval');
        });
    });

    // ── 4: the two design-doc invariants ─────────────────────────────────
    await test('stampAccessTimes does NOT bump the read-cache epoch', async () => {
        await withGraph(async (graph) => {
            await graph.upsertNode(node('n1'));
            const epochBefore = graph.readCache.epoch;
            await graph.stampAccessTimes([{ id: 'n1', accessedAt: new Date().toISOString() }]);
            assert.equal(graph.readCache.epoch, epochBefore, 'epoch must be unchanged — a bump would invalidate the recall cache on every recall');
        });
    });

    await test('stampAccessTimes does NOT touch updatedAt or syncedAt', async () => {
        await withGraph(async (graph) => {
            const before = await graph.upsertNode(node('n2'));
            // Real elapsed time so a naive re-stamp of updatedAt would be observable.
            await new Promise((r) => setTimeout(r, 10));
            await graph.stampAccessTimes([
                { id: 'n2', accessedAt: new Date().toISOString(), retrievedAt: new Date().toISOString() },
            ]);
            const after = await graph.getNode('n2');
            assert.equal(after!.updatedAt, before.updatedAt, 'updatedAt must be untouched (no re-sync/re-embed churn)');
            assert.equal(after!.syncedAt, before.syncedAt, 'syncedAt must be untouched');
        });
    });

    // ── 5: end-to-end — maintain's coldness selection actually observes it ──
    await test("maintain's selectRetentionCandidates (cold_signal='access') spares the touched node, selects the untouched one", async () => {
        await withGraph(async (graph) => {
            await graph.upsertNode(node('warm'));
            await graph.upsertNode(node('cold'));

            const tracker = ensureAccessTracker(graph);
            tracker!.touch(['warm'], 'retrieval');
            await tracker!.flush();
            await disposeAccessTracker(graph);

            const warm = await graph.getNode('warm');
            const cold = await graph.getNode('cold');
            assert.ok(warm!.lastAccessedAt, 'sanity: warm node was actually stamped');
            assert.equal(cold!.lastAccessedAt, null, 'sanity: cold node was never touched');

            // Both nodes are old by updatedAt (200 days) — only the access
            // signal should be able to tell them apart. This is the real
            // consumer contract, so it's fed real getNode() output, with only
            // `updatedAt` synthesized (age is orthogonal to what this test
            // proves — the stamp itself came from the real engine).
            const oldIso = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
            const forSelection: NodeForSelection[] = [warm!, cold!].map((n) => ({
                id: n.id,
                tags: n.tags,
                status: n.status ?? null,
                legalHold: null,
                updatedAt: oldIso,
                createdAt: oldIso,
                lastAccessedAt: n.lastAccessedAt,
                last_retrieved_at: n.last_retrieved_at,
            }));

            const policy = resolveMaintainPolicy({ retentionDays: 90, coldSignal: 'access' }, { skipEnv: true });
            const selection = selectRetentionCandidates(forSelection, policy, Date.now());
            assert.deepEqual(selection.candidates.map((n) => n.id), ['cold'],
                'access signal: the browsed/retrieved node is spared, the untouched one is the retention candidate');
        });
    });

    // ── 6: best-effort — never throws ────────────────────────────────────
    await test('surrealGraphWrites.stampAccessTimes swallows a read-only-style storage error', async () => {
        const failingQuery = async (): Promise<Array<Record<string, unknown>>> => {
            throw new Error('EROFS: read-only file system');
        };
        const result = await writesStampAccessTimes(failingQuery, [
            { id: 'x', accessedAt: new Date().toISOString() },
        ]);
        assert.equal(result, 0, 'a failed group is not counted, but the call must resolve, not throw');
    });

    await test('surrealGraphWrites.stampAccessTimes recovers from a transient lock/conflict error via retry', async () => {
        let calls = 0;
        const flakyQuery = async (): Promise<Array<Record<string, unknown>>> => {
            calls++;
            if (calls === 1) throw new Error('Transaction conflict... this transaction can be retried');
            return [{ id: 'x' }];
        };
        const result = await writesStampAccessTimes(flakyQuery, [
            { id: 'x', accessedAt: new Date().toISOString() },
        ]);
        assert.equal(result, 1, 'the retry must recover and still count the stamp');
        assert.equal(calls, 2, 'exactly one retry for a single transient conflict');
    });

    await test('SurrealGraph.stampAccessTimes never throws when the underlying store is unavailable (closed/locked)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-access-coldness-locked-'));
        const graph = new SurrealGraph(dir, { workspaceId: 'test-ws' });
        // Shorten the open retry budget (production default is a 15s total
        // budget with 2s per-attempt timeouts — see surrealConnection.ts) so
        // a genuine lock-contention failure below resolves in ~150ms instead
        // of stalling this test for 15 seconds.
        const prevTimeoutMs = process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'];
        const prevBudgetMs = process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
        process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = '150';
        process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = '300';
        let locker: SurrealGraph | null = null;
        try {
            await graph.initialize();
            await graph.upsertNode(node('n3'));
            await graph.close();

            // Genuinely make the store unavailable: open a SECOND connection
            // to the SAME directory and deliberately never close it, so it
            // holds surrealkv's on-disk directory lock. (An earlier version
            // of this test instead deleted the directory and replaced it
            // with a stray file, expecting the reopen to fail — but
            // surrealkv tolerates an unrelated sibling file and just opens a
            // fresh, empty store next to it, so that never actually failed
            // `initialize()`. It also went unnoticed that the successful
            // reconnect inside `stampAccessTimes` left a live, un-closed
            // SurrealGraph connection behind — invisible to Node's handle
            // diagnostics but enough to keep the host process from ever
            // exiting. A REAL directory-lock conflict, asserted here, is
            // both deterministic and faithful to the test's own name.)
            locker = new SurrealGraph(dir, { workspaceId: 'test-ws' });
            await locker.initialize();

            let threw = false;
            let result = -1;
            try {
                result = await graph.stampAccessTimes([{ id: 'n3', accessedAt: new Date().toISOString() }]);
            } catch {
                threw = true;
            }
            assert.equal(threw, false, 'must never throw — this runs off the background flush, never the read path');
            assert.equal(result, 0, 'nothing could be stamped against a genuinely locked/unavailable store');
        } finally {
            await graph.close().catch(() => undefined);
            await locker?.close().catch(() => undefined);
            fs.rmSync(dir, { recursive: true, force: true });
            if (prevTimeoutMs === undefined) delete process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'];
            else process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = prevTimeoutMs;
            if (prevBudgetMs === undefined) delete process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
            else process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = prevBudgetMs;
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

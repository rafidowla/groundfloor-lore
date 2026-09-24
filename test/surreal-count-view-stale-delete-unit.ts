#!/usr/bin/env tsx
/**
 * surreal-count-view-stale-delete-unit.ts — a leftover `node_counts` view
 * makes nodes undeletable (Atlas LORE-ASK-COUNT-VIEW-DELETE, 2026-09-17).
 *
 * `countView` was default-ON between 2026-08-05 and 2026-08-21. Flipping it
 * off stops `applySurrealSchema` from DEFINING the view; nothing ever REMOVEs
 * it. So every workspace that booted in that window still carries
 * `node_counts`, SurrealDB still maintains it on every write, and the
 * surrealdb-core 3.0.2 lost-update under concurrent same-group writers still
 * drives the maintained count low. Once deletes take that count to zero the
 * view row is gone, and every subsequent DELETE (and every supersede's
 * UPDATE, which re-maintains the same group row) panics with
 *   "unreachable logic: id#... Deletion for a view but no record exists for
 *    that view".
 *
 * Run: npx tsx test/surreal-count-view-stale-delete-unit.ts
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

function node(id: string): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'verbatim',
        label: `label ${id}`,
        content: `content ${id}`,
        tags: [],
        project: 'stuck-project',
        ecosystem: 'e',
        metadata: '{}',
    } as Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;
}

/** `INFO FOR DB`'s table list, via the engine's own private query fn. */
async function tableNames(g: SurrealGraph): Promise<string[]> {
    const rows = await (g as unknown as { query: (sql: string) => Promise<Record<string, unknown>[]> })
        .query('INFO FOR DB');
    const tables = (rows[0]?.['tables'] ?? {}) as Record<string, unknown>;
    return Object.keys(tables);
}

const N = 300;

await test('a store that once had countView ON can still delete every node after the flag is turned off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-countview-stale-'));
    try {
        // 1. Legacy boot: flag ON, concurrent writers into ONE (project, type)
        //    group — the shape that loses updates on the view's own count.
        const legacy = new SurrealGraph(dir, { workspaceId: 'stuck', cacheDisabled: true, features: { countView: true } });
        await legacy.initialize();
        const settled = await Promise.allSettled(
            Array.from({ length: N }, (_, i) => legacy.upsertNode(node(`verbatim-${i}`))),
        );
        // Serially re-upsert whatever lost a transaction conflict, so all N rows exist.
        for (let i = 0; i < N; i++) {
            if (settled[i]?.status === 'rejected') await legacy.upsertNode(node(`verbatim-${i}`));
        }
        await legacy.close();

        // 2. Reopen with the flag OFF — today the view survives this.
        const g = new SurrealGraph(dir, { workspaceId: 'stuck', cacheDisabled: true, features: { countView: false } });
        await g.initialize();

        const names = await tableNames(g);
        assert.equal(await g.getStats('stuck-project').then((s) => s.nodeCount), N,
            'ground truth: all N rows are genuinely present (live GROUP BY)');

        // 3. Serial deletes. Every one of them must succeed.
        let deleteFailures = 0;
        let firstError = '';
        for (let i = 0; i < N; i++) {
            try {
                await g.deleteNode(`verbatim-${i}`);
            } catch (err) {
                deleteFailures++;
                if (!firstError) firstError = (err as Error).message;
            }
        }
        const remaining = (await g.getStats('stuck-project')).nodeCount;
        await g.close();

        console.log(`    [diag] tables=${names.join(',')} deleteFailures=${deleteFailures}/${N} remaining=${remaining}`
            + (firstError ? `\n    [diag] first error: ${firstError}` : ''));
        assert.ok(!names.includes('node_counts'),
            `reopening with countView OFF must drop the leftover view; INFO FOR DB still lists: ${names.join(', ')}`);
        assert.equal(deleteFailures, 0, `${deleteFailures}/${N} serial deletes failed — first: ${firstError}`);
        assert.equal(remaining, 0, `${remaining} nodes left behind`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('supersedeNode on a node in that group is not blocked either', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-countview-stale-sup-'));
    try {
        const legacy = new SurrealGraph(dir, { workspaceId: 'stuck', cacheDisabled: true, features: { countView: true } });
        await legacy.initialize();
        const settled = await Promise.allSettled(
            Array.from({ length: N }, (_, i) => legacy.upsertNode(node(`verbatim-${i}`))),
        );
        for (let i = 0; i < N; i++) {
            if (settled[i]?.status === 'rejected') await legacy.upsertNode(node(`verbatim-${i}`));
        }
        await legacy.close();

        const g = new SurrealGraph(dir, { workspaceId: 'stuck', cacheDisabled: true, features: { countView: false } });
        await g.initialize();
        // Drive the view's maintained count to zero the same way production did.
        const stuck: string[] = [];
        for (let i = 0; i < N; i++) {
            try {
                await g.deleteNode(`verbatim-${i}`);
            } catch {
                stuck.push(`verbatim-${i}`);
            }
        }
        const deleteFailures = stuck.length;
        // Superseding a node that could not be deleted must still work — it is
        // the only way an app can hide it from recall. It does not today: the
        // MERGE re-maintains the same (project, type) view row.
        let supersedeError = '';
        if (stuck.length >= 2) {
            try {
                await g.supersedeNode(stuck[0]!, stuck[1]!, 'test');
            } catch (err) {
                supersedeError = (err as Error).message;
            }
        }
        await g.close();
        console.log(`    [diag] deleteFailures=${deleteFailures}/${N} stuck[0]=${stuck[0] ?? 'none'}`);
        assert.equal(supersedeError, '', `supersede failed (${deleteFailures} deletes had failed first): ${supersedeError}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('plain node UPDATEs (markStaleByIds / stampAccessTimes) are not blocked either', async () => {
    // Blast radius beyond delete/supersede: ANY statement that re-maintains a
    // (project, type) group row whose view row has gone missing panics the
    // same way. `stampAccessTimes` runs on the READ path, so a damaged
    // workspace can throw while merely recalling.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-countview-stale-upd-'));
    try {
        const legacy = new SurrealGraph(dir, { workspaceId: 'stuck', cacheDisabled: true, features: { countView: true } });
        await legacy.initialize();
        const settled = await Promise.allSettled(
            Array.from({ length: N }, (_, i) => legacy.upsertNode(node(`verbatim-${i}`))),
        );
        for (let i = 0; i < N; i++) {
            if (settled[i]?.status === 'rejected') await legacy.upsertNode(node(`verbatim-${i}`));
        }
        await legacy.close();

        const g = new SurrealGraph(dir, { workspaceId: 'stuck', cacheDisabled: true, features: { countView: false } });
        await g.initialize();
        const stuck: string[] = [];
        for (let i = 0; i < N; i++) {
            try {
                await g.deleteNode(`verbatim-${i}`);
            } catch {
                stuck.push(`verbatim-${i}`);
            }
        }
        let markError = '';
        let stamped = -1;
        if (stuck.length > 0) {
            try {
                await g.markStaleByIds(stuck.slice(0, 5));
            } catch (err) {
                markError = (err as Error).message;
            }
            // stampAccessTimes swallows its own failures (it logs and returns a
            // short count), so assert on the COUNT, not on a throw.
            stamped = await g.stampAccessTimes(
                stuck.slice(0, 5).map((id) => ({ id, accessedAt: new Date().toISOString() })),
            );
        }
        await g.close();
        console.log(`    [diag] deleteFailures=${stuck.length}/${N} markStale=${markError || 'ok'} stamped=${stamped}`);
        if (stuck.length > 0) {
            assert.equal(markError, '', `markStaleByIds failed: ${markError}`);
            assert.equal(stamped, Math.min(5, stuck.length), `stampAccessTimes stamped ${stamped}`);
        }
        assert.equal(stuck.length, 0, `${stuck.length}/${N} deletes failed on a store that once had the view`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

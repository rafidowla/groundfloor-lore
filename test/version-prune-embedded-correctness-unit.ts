#!/usr/bin/env tsx
/**
 * test/version-prune-embedded-correctness-unit.ts — storage-growth fix 2/3
 * follow-up (2026-09-28), correctness coverage for the batched embedded
 * pruner introduced alongside the stall fix.
 *
 * `VersionStore` now has TWO ways to apply the same retention policy:
 *   - the original sync multi-pass (`pruneVersions`/`hardDeleteCompacted`,
 *     one `UPDATE` per named type + one default-cutoff pass), still used by
 *     the daemon sweeper and `lore maintain`;
 *   - the new async batched single-pass (`pruneVersionsBatched`/
 *     `hardDeleteCompactedBatched`, one CASE-expression `UPDATE` run in
 *     rowid-bounded, yielding batches), used only by the embedded sweep.
 *
 * Both share `computeCutoffs()`, so by construction every row lands in the
 * same cutoff bucket either way — but "by construction" is exactly the kind
 * of claim a test should verify, not just assert in a comment. This file
 * seeds ONE identical dataset into two separate stores (named types,
 * `retentionDaysByType` overrides, `skipTypes`, protected rows, and rows of
 * an unlisted type falling through to the default), runs the OLD path
 * against one and the NEW path against the other, and asserts the two
 * stores end up with byte-identical sets of surviving node IDs.
 *
 * Does not exercise `createLore()` — that integration proof already lives
 * in test/storage-growth-2-embedded.ts; this file is deliberately narrow
 * (store-level, both paths, one seed) so a divergence between the two
 * pruning strategies fails here first, with a small diff, rather than only
 * showing up as a flake somewhere the two paths are exercised separately.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import type { VersionHistoryPolicy } from '../packages/lore/src/outbox/versionPolicy.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        failed++;
    }
}

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vprune-correctness-'));
}

interface SeedRow {
    nodeId: string;
    type: string;
    daysOld: number;
    protected?: boolean;
}

/** Deterministic dataset covering every branch `computeCutoffs` and the
 *  CASE-vs-multi-pass classification have to agree on:
 *   - a skipTypes type (days=0): one ordinary row (must prune), one
 *     protected row (must survive despite skipTypes — protectedGuard wins).
 *   - a retentionDaysByType override (10 days): one row past it (prune),
 *     one row inside it (survive).
 *   - an unlisted type, falling through to the 90-day default: one row
 *     past it (prune), one row inside it (survive).
 *   - a type with NO recoverable type at all (both states null-ish is not
 *     legal for newState, so instead: a row whose newState has no `type`
 *     field) — must also fall through to the default, same as "unlisted".
 */
function buildSeed(): SeedRow[] {
    return [
        { nodeId: 'scratch-plain', type: 'scratch', daysOld: 0 },
        { nodeId: 'scratch-protected', type: 'scratch', daysOld: 0, protected: true },
        { nodeId: 'note-old', type: 'note', daysOld: 15 },
        { nodeId: 'note-recent', type: 'note', daysOld: 5 },
        { nodeId: 'decision-old', type: 'decision', daysOld: 100 },
        { nodeId: 'decision-recent', type: 'decision', daysOld: 50 },
        { nodeId: 'typeless-old', type: '__typeless__', daysOld: 100 },
        { nodeId: 'typeless-recent', type: '__typeless__', daysOld: 50 },
    ];
}

const POLICY: VersionHistoryPolicy = {
    skipTypes: ['scratch'],
    retentionDaysByType: { note: 10 },
};
const DEFAULT_DAYS = 90;

function seedInto(store: VersionStore, rows: SeedRow[], anchorMs: number): void {
    for (const row of rows) {
        const timestamp = new Date(anchorMs - row.daysOld * 86_400_000).toISOString();
        const newState: Record<string, unknown> =
            row.type === '__typeless__' ? { content: 'x'.repeat(1000) } : { type: row.type, content: 'x'.repeat(1000) };
        if (row.protected) newState['status'] = 'protected';
        store.recordVersion({
            versionId: randomUUID(),
            nodeId: row.nodeId,
            workspace: 'w',
            timestamp,
            principal: 'test',
            operation: 'upsert',
            previousState: null,
            newState,
            changesetId: null,
        });
    }
}

function survivingIds(store: VersionStore, rows: SeedRow[]): string[] {
    return rows.filter((r) => store.getVersions(r.nodeId, 'w').length > 0).map((r) => r.nodeId).sort();
}

console.log('\nVersion-prune correctness: old sync multi-pass vs new batched single-pass\n');

await test('old sync path and new batched path prune the identical set of node IDs on identical seed data', async () => {
    const rows = buildSeed();
    // One shared anchor for BOTH seed calls and BOTH prune calls, so a
    // couple of ms of real wall-clock time spent seeding/pruning can never
    // shift a row across a cutoff differently for the two paths — the test
    // is about classification-logic parity, not about re-testing wall-clock
    // tie behaviour (that's U3 in version-prune-embedded-unit.ts).
    const anchor = Date.now();

    const dirOld = makeTmpDir();
    const dirNew = makeTmpDir();
    try {
        const storeOld = VersionStore.open(dirOld);
        storeOld.setHistoryPolicy(POLICY);
        seedInto(storeOld, rows, anchor);

        const storeNew = VersionStore.open(dirNew);
        storeNew.setHistoryPolicy(POLICY);
        seedInto(storeNew, rows, anchor);

        // OLD path: sync multi-pass, one UPDATE per named type + default.
        storeOld.pruneVersions(DEFAULT_DAYS);
        storeOld.hardDeleteCompacted();

        // NEW path: async batched single CASE-expression pass.
        await storeNew.pruneVersionsBatched(DEFAULT_DAYS);
        await storeNew.hardDeleteCompactedBatched();

        const survivedOld = survivingIds(storeOld, rows);
        const survivedNew = survivingIds(storeNew, rows);

        assert.deepEqual(
            survivedNew,
            survivedOld,
            `batched path must survive the exact same node set as the sync path.\n` +
                `  old: ${JSON.stringify(survivedOld)}\n  new: ${JSON.stringify(survivedNew)}`,
        );

        // Pin the expected set explicitly too, not just "old == new" — a
        // shared bug in computeCutoffs would make both paths agree with
        // each other while both being wrong.
        assert.deepEqual(
            survivedNew,
            ['decision-recent', 'note-recent', 'scratch-protected', 'typeless-recent'].sort(),
            `expected exactly the recent/protected rows to survive, got ${JSON.stringify(survivedNew)}`,
        );

        storeOld.close();
        storeNew.close();
    } finally {
        fs.rmSync(dirOld, { recursive: true, force: true });
        fs.rmSync(dirNew, { recursive: true, force: true });
    }
});

await test('the batched path also honours signal-based abort between batches (does not run past a stop request)', async () => {
    const dir = makeTmpDir();
    try {
        const store = VersionStore.open(dir);
        // Seed enough rows to guarantee more than one batch at a tiny
        // batchSize, all immediately prunable via skipTypes.
        store.setHistoryPolicy({ skipTypes: ['scratch'] });
        const anchor = Date.now();
        for (let i = 0; i < 50; i++) {
            seedInto(store, [{ nodeId: `n${i}`, type: 'scratch', daysOld: 0 }], anchor);
        }

        const signal = { aborted: true }; // pre-aborted: must do zero work
        const softCompacted = await store.pruneVersionsBatched(90, { batchSize: 5, signal });
        assert.equal(softCompacted, 0, 'a pre-aborted signal must skip every batch');

        for (let i = 0; i < 50; i++) {
            assert.equal(store.getVersions(`n${i}`, 'w').length, 1, `n${i} must survive — sweep never ran`);
        }

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

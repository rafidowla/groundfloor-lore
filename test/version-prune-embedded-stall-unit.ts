#!/usr/bin/env tsx
/**
 * test/version-prune-embedded-stall-unit.ts — storage-growth fix 2/3
 * follow-up (2026-09-28): proves the embedded batched pruner
 * (`pruneVersionsBatched`/`hardDeleteCompactedBatched`,
 * packages/lore/src/outbox/versionStore.ts) does not block the event loop
 * for long on a store the size of Atlas's real `versions.sqlite`
 * (323,525 rows / 1.36 GB, per common-rules.md's "Background" measurement).
 *
 * Builds >=200,000 rows directly (bypassing VersionStore.recordVersion's
 * one-statement-per-call API, which would make seeding itself the slow
 * part) via one wrapped better-sqlite3 transaction, across three retention
 * buckets — a `skipTypes` type (prunable immediately), a
 * `retentionDaysByType` override, and an unlisted type falling through to
 * the default — so the CASE-expression classification actually exercises
 * more than one branch, same shape as the real Atlas skipTypes scenario.
 *
 * Measurement: an unref'd `setInterval` probe firing every 10ms, running
 * for the ENTIRE prune+hard-delete call. Node only fires a timer when it
 * gets a turn on the event loop, so the gap between two consecutive probe
 * fires is a direct measurement of how long something else (here: one
 * batch's synchronous `stmt.run()`) held the loop. Threshold: 250ms.
 * sprint-2.md / common-rules.md's task spec asks for "no single synchronous
 * slice exceeds ~50-100ms" — 250ms is deliberately looser than that target,
 * to absorb CI-machine noise, GC pauses, and `setInterval`'s own
 * unspecified-but-nonzero scheduling slop, while still failing hard if
 * batching regresses back toward the old multi-second full-table passes
 * (a regression would show as multi-SECOND gaps, not tens of ms over
 * threshold) — the test would have failed the old sync path by roughly
 * 15-20x this threshold.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';

const ROW_COUNT = 220_000;
const STALL_THRESHOLD_MS = 250;
const PROBE_INTERVAL_MS = 10;

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vprune-stall-'));
}

/** ~2KB of JSON per row (close to Atlas's measured real-store average of
 *  ~4.4KB/row across 323,525 rows / 1.36GB — kept a bit smaller here so the
 *  seed step itself stays fast; the stall risk scales with row COUNT
 *  scanned per batch, not directly with per-row byte size, since the WHERE
 *  clause only touches `timestamp`/`compacted` plus two `json_extract`
 *  calls per row, not the full payload). */
const PAYLOAD = 'x'.repeat(2000);

function seedBulk(dbPath: string, count: number): void {
    const raw = new Database(dbPath);
    try {
        const insert = raw.prepare(
            `INSERT INTO node_versions
               (version_id, node_id, workspace, timestamp, principal, operation, previous_state, new_state, changeset_id, compacted)
             VALUES (?, ?, ?, ?, 'test', 'upsert', NULL, ?, NULL, 0)`,
        );
        const now = Date.now();
        const insertAll = raw.transaction((n: number) => {
            for (let i = 0; i < n; i++) {
                // Three buckets, cycled: skipTypes-eligible / retention-override
                // / unlisted-default. All seeded old enough to be prunable
                // under their respective cutoff, so this run exercises a
                // REAL full prune, not a mostly-no-op scan.
                let type: string;
                let daysOld: number;
                if (i % 3 === 0) { type = 'code_symbol'; daysOld = 0; } // skipTypes, days=0
                else if (i % 3 === 1) { type = 'code_file'; daysOld = 60; } // retentionDaysByType override (30)
                else { type = 'note'; daysOld = 150; } // unlisted -> default (90)

                const timestamp = new Date(now - daysOld * 86_400_000).toISOString();
                const newState = JSON.stringify({ type, content: PAYLOAD });
                insert.run(`v-${i}-${randomUUID()}`, `n-${i}`, 'w', timestamp, newState);
            }
        });
        insertAll(count);
    } finally {
        raw.close();
    }
}

async function measureMaxStall(fn: () => Promise<void>): Promise<number> {
    let lastTick = Date.now();
    let maxGap = 0;
    const probe = setInterval(() => {
        const now = Date.now();
        const gap = now - lastTick;
        if (gap > maxGap) maxGap = gap;
        lastTick = now;
    }, PROBE_INTERVAL_MS);
    if (typeof probe.unref === 'function') probe.unref();
    try {
        await fn();
    } finally {
        clearInterval(probe);
    }
    return maxGap;
}

console.log('\nEmbedded version-prune batched pass — event-loop stall on a >=200k-row store\n');

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

await test(`batched prune+hard-delete on ${ROW_COUNT.toLocaleString()} rows keeps max event-loop stall under ${STALL_THRESHOLD_MS}ms`, async () => {
    const dir = makeTmpDir();
    try {
        // Create the file with VersionStore.open() first so it gets the
        // exact same schema/pragmas (including auto_vacuum=INCREMENTAL on a
        // new file) production code would set, then seed directly against
        // the file for speed, then reopen through VersionStore for the
        // measured call — matches how a real embedded host would encounter
        // this file (opened normally, already populated from prior runs).
        const dbPath = path.join(dir, 'versions.sqlite');
        VersionStore.open(dir).close();

        const seedStart = Date.now();
        seedBulk(dbPath, ROW_COUNT);
        console.log(`      seeded ${ROW_COUNT.toLocaleString()} rows in ${Date.now() - seedStart}ms`);

        const store = VersionStore.open(dir);
        store.setHistoryPolicy({ skipTypes: ['code_symbol'], retentionDaysByType: { code_file: 30 } });

        let softCompacted = 0;
        let hardDeleted = 0;
        const t0 = Date.now();
        const maxStallMs = await measureMaxStall(async () => {
            softCompacted = await store.pruneVersionsBatched(90);
            hardDeleted = await store.hardDeleteCompactedBatched();
        });
        const totalMs = Date.now() - t0;

        console.log(`      softCompacted=${softCompacted.toLocaleString()} hardDeleted=${hardDeleted.toLocaleString()}`);
        console.log(`      total=${totalMs}ms max single-probe-gap stall=${maxStallMs}ms`);

        assert.equal(hardDeleted, ROW_COUNT, `expected all ${ROW_COUNT} rows to be prunable (all seeded past their cutoff)`);
        assert.ok(
            maxStallMs < STALL_THRESHOLD_MS,
            `max event-loop stall ${maxStallMs}ms exceeded the ${STALL_THRESHOLD_MS}ms budget — a batch is running too large a slice synchronously`,
        );

        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

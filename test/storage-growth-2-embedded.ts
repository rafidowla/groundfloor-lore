#!/usr/bin/env tsx
/**
 * test/storage-growth-2-embedded.ts — storage-growth fix 2/3, the mandatory
 * integration proof through the real embedded path.
 *
 * common-rules.md: "Unit tests on the store alone are not enough. For every
 * behaviour you add, at least one test must go through the real embedded
 * path — createLore({...}) with a temp data dir — and prove the behaviour
 * happens there." version-prune-embedded-unit.ts and
 * outbox-prune-embedded-unit.ts already prove the underlying store/scheduler
 * logic in isolation; this file proves server.ts actually WIRES that logic
 * into a real `createLore()` boot for BOTH fixes in this sprint:
 *
 *   R3 — embeddedVersionPruneSweeper: a createLore() host that ISN'T the
 *        daemon (every library consumer — Atlas, MIRA, PM Helper) runs its
 *        own version-history retention sweep WHEN `versionHistory.pruning`
 *        is enabled (opt-in, owner decision 2026-09-29), honouring
 *        `versionHistory.retentionDaysByType`. The default-off behaviour is
 *        proven in test/version-history-optin-embedded.ts.
 *   R4 — outboxOpenPruneSweep: `replicated` outbox rows older than the
 *        retention window are pruned once the workspace opens, regardless
 *        of whether any replicator loop is running; `pending`/`dead` rows
 *        are never touched.
 *
 * Pattern: pre-seed BOTH stores directly (VersionStore / SqliteOutboxStore)
 * BEFORE ever calling createLore() — simulating a host that already has old
 * data on disk from a prior run and reopens it (R3's own reasoning: "Atlas
 * can run for days" between boots, so the sweep must handle data that
 * predates this instance's own boot, not just what it writes itself). Both
 * sweepers fire off the SAME `createLore()` call (server.ts constructs them
 * together, unconditionally, for every embedded host), so this is a real
 * "both fixes live in one host boot" proof, not two isolated stand-ins.
 *
 * R3's sweep fires synchronously-scheduled (`runImmediately`, off a
 * zero-delay unref'd setTimeout) and R4's is a one-shot zero-delay unref'd
 * setTimeout — neither blocks createLore()'s own return, so both tests give
 * the event loop a short grace window before asserting.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createLore } from '../packages/lore/src/index.js';
import { resolveLoreHome } from '../packages/lore/src/config/loreHome.js';
import { resolveGraphPath } from '../packages/lore/src/mcp/bootSteps.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import type { OutboxEntry, OutboxStatus } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) => {
    return (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })();
};

/** Both sweeps are deferred, unref'd, zero-delay timers — give the event
 *  loop a real grace window (not just one microtask turn) for the async
 *  prune + incrementalVacuum work to finish before we assert or dispose. */
function graceWindow(ms = 200): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function loreDirFor(dataDir: string): string {
    const dataHome = resolveLoreHome({ dataDir });
    const graphBasePath = resolveGraphPath(dataHome);
    return path.join(graphBasePath, '.lore');
}

/**
 * Raw, status-blind row-existence check against outbox.sqlite, opened
 * read-only and closed immediately.
 *
 * Why not `listUnfinished()` (`WHERE completed = 0`) for the pending row:
 * a real embedded `createLore()` host also starts the ACTUAL
 * `OutboxReplicator` tick loop (`embeddedLifecycle.ts` — unconditional,
 * unrelated to this sprint's R4 prune-on-open sweep). That loop enumerates
 * every workspace with pending rows and dispatches them for real, so a
 * synthetic seeded 'pending' row can legitimately be picked up and marked
 * 'replicated' (completed=1) by that ambient system during the grace
 * window — same as it would for any genuine pending write. That is
 * correct, expected behaviour of the replicator, not something R4 should
 * (or safely could) suppress, and it is already covered by the
 * replicator's own test suites.
 *
 * What R4 actually promises is narrower: its prune-on-open sweep never
 * DELETES a pending/dead row. A raw existence-by-id check proves exactly
 * that, independent of whatever status the row may have transitioned to
 * via the ambient replicator loop.
 */
function rawRowExists(loreDir: string, id: string): boolean {
    const db = new Database(path.join(loreDir, 'outbox.sqlite'), { readonly: true });
    try {
        return db.prepare('SELECT 1 FROM outbox_entries WHERE id = ?').get(id) !== undefined;
    } finally {
        db.close();
    }
}

function seedOldVersion(store: VersionStore, nodeId: string, type: string, daysOld: number): void {
    store.recordVersion({
        versionId: randomUUID(),
        nodeId,
        workspace: 'default',
        timestamp: new Date(Date.now() - daysOld * 86_400_000).toISOString(),
        principal: 'test',
        operation: 'upsert',
        previousState: null,
        newState: { type, content: 'x'.repeat(5_000) },
        changesetId: null,
    });
}

async function seedOutboxEntry(
    store: SqliteOutboxStore,
    opts: { id: string; status: OutboxStatus; ageDays: number },
): Promise<void> {
    const ts = new Date(Date.now() - opts.ageDays * 86_400_000).toISOString();
    const entry: OutboxEntry = {
        id: opts.id,
        operation: 'test.op',
        initiator: 'test:seed',
        createdAt: ts,
        updatedAt: ts,
        steps: [],
        completed: opts.status === 'replicated',
        workspace: 'default',
        operationKind: 'sync.vector.mirror',
        status: opts.status,
        attempts: 0,
        replicatedAt: opts.status === 'replicated' ? ts : undefined,
    };
    await store.record(entry);
}

async function main() {
    console.log('storage-growth fix 2/3 — embedded integration proof (R3 history pruning + R4 outbox hygiene)\n');

    /* ─── R3: embedded host history pruning, default retention + override ── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'r3');
        const loreDir = loreDirFor(dataDir); // side effect: bootstraps workspaces.json, same as createLore()'s own boot would
        fs.mkdirSync(loreDir, { recursive: true });

        // Pre-seed BEFORE createLore() ever opens this store — simulating an
        // existing host's on-disk history from a prior run.
        {
            const seedStore = VersionStore.open(loreDir);
            seedOldVersion(seedStore, 'r3-stale-default', 'scratch-x', 200); // past the 90-day enabled retention, no type override
            seedOldVersion(seedStore, 'r3-override-note', 'note', 10);       // past a 5-day override, under the 90-day retention
            seedOldVersion(seedStore, 'r3-kept-decision', 'decision', 10);   // under the 90-day retention, no override
            seedStore.close();
        }

        const lore = await createLore({
            deploymentMode: 'embedded',
            dataDir,
            // Pruning is opt-in (owner decision 2026-09-29).
            versionHistory: { pruning: { enabled: true, retentionDays: 90 }, retentionDaysByType: { note: 5 } },
        });

        await test('R3 — embedded host with pruning ENABLED prunes pre-existing history on boot: retention + retentionDaysByType override', async () => {
            await graceWindow();
            await lore.dispose();

            const vs = VersionStore.open(loreDir);
            try {
                assert.equal(
                    vs.getVersions('r3-stale-default', 'default', 50).length, 0,
                    'a 200-day-old row of an unlisted type must be pruned by the enabled 90-day retention',
                );
                assert.equal(
                    vs.getVersions('r3-override-note', 'default', 50).length, 0,
                    "a 10-day-old 'note' row must be pruned by its 5-day retentionDaysByType override",
                );
                assert.equal(
                    vs.getVersions('r3-kept-decision', 'default', 50).length, 1,
                    "a 10-day-old 'decision' row (unlisted, under the 90-day retention) must survive",
                );
            } finally {
                vs.close();
            }
        });
    }

    /* ─── R4: outbox prune-on-open, pending/dead untouched ────────────────── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'r4');
        const loreDir = loreDirFor(dataDir);
        fs.mkdirSync(loreDir, { recursive: true });

        // Pre-seed BEFORE createLore() ever opens this store, same reasoning
        // as R3 above — and the exact gap R4 closes: a workspace opened,
        // written to, and closed again with no replicator loop ever running
        // between opens.
        {
            const seedStore = new SqliteOutboxStore(loreDir);
            await seedOutboxEntry(seedStore, { id: 'r4-old-replicated', status: 'replicated', ageDays: 30 });
            await seedOutboxEntry(seedStore, { id: 'r4-recent-replicated', status: 'replicated', ageDays: 1 });
            await seedOutboxEntry(seedStore, { id: 'r4-old-pending', status: 'pending', ageDays: 400 });
            await seedOutboxEntry(seedStore, { id: 'r4-old-dead', status: 'dead', ageDays: 400 });
            seedStore.close();
        }

        const lore = await createLore({ deploymentMode: 'embedded', dataDir });

        await test('R4 — embedded host prunes replicated outbox rows on open; pending/dead untouched', async () => {
            await graceWindow();
            await lore.dispose();

            const store = new SqliteOutboxStore(loreDir);
            try {
                const dead = await store.listDead();
                assert.equal(dead.length, 1, 'the old dead row must survive untouched');
                assert.equal(dead[0]!.id, 'r4-old-dead');

                // Status-blind row-existence checks (see rawRowExists doc
                // comment above): the real replicator loop is also running
                // during this grace window and may legitimately transition
                // the seeded pending row's *status*. What R4's prune-on-open
                // sweep promises is narrower and absolute: it never DELETES
                // a pending or dead row, regardless of what else touches it.
                assert.ok(
                    rawRowExists(loreDir, 'r4-old-pending'),
                    'the old pending row must survive untouched (never deleted by the prune-on-open sweep)',
                );
                assert.ok(
                    rawRowExists(loreDir, 'r4-old-dead'),
                    'the old dead row must survive untouched (never deleted by the prune-on-open sweep)',
                );
                assert.ok(
                    rawRowExists(loreDir, 'r4-recent-replicated'),
                    'a replicated row inside the retention window must survive',
                );
                assert.ok(
                    !rawRowExists(loreDir, 'r4-old-replicated'),
                    'a replicated row past the retention window must be pruned (deleted) on open',
                );

                const allDead = await store.listDead({ workspace: null, limit: 100 });
                assert.equal(allDead.length, 1, 'exactly the one dead row, nothing else landed in dead');
            } finally {
                store.close();
            }
        });
    }

    /* ─── D: fast open-then-dispose() race — no leaked timer/handle ──────── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'r-fast-dispose');
        await test('D — createLore() immediately followed by dispose() does not hang and leaves stores cleanly closable', async () => {
            const lore = await createLore({ deploymentMode: 'embedded', dataDir });
            // No grace window — dispose() races both deferred sweeps
            // (R3's runImmediately kickoff and R4's zero-delay prune) on
            // purpose. shutdownDrain.ts's steps 4.5/7.5 must cancel/await
            // them cleanly; if either timer fired a write against an
            // already-closed store, or dispose() itself hung waiting on a
            // handle that never resolves, this test would time out under
            // the wrapping `perl alarm`.
            await lore.dispose();

            const loreDir = loreDirFor(dataDir);
            // Reopening both stores immediately proves neither was left
            // locked (WAL writer still attached) or corrupted by a write
            // racing the close.
            const vs = VersionStore.open(loreDir);
            vs.close();
            const os = new SqliteOutboxStore(loreDir);
            os.close();
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

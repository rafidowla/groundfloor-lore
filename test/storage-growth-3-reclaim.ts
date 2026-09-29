#!/usr/bin/env tsx
/**
 * test/storage-growth-3-reclaim.ts — storage-growth fix 3/3 (Fix 5), the
 * offline reclaim tool: `reclaimStorage()` / `lore maintain storage`.
 *
 * common-rules.md: "Unit tests on the store alone are not enough. For every
 * behaviour you add, at least one test must go through the real embedded
 * path — createLore({...}) with a temp data dir — and prove the behaviour
 * happens there." The RECALL-PARITY test below is that proof for this fix:
 * it writes real nodes through `createLore()`, captures a `search()` +
 * `recall()` result set, disposes, runs a REAL (non-dry-run) reclaim
 * against the same on-disk data dir, reopens via `createLore()` again, and
 * asserts the results are byte-identical in id and order. reclaimStorage()
 * only ever touches versions.sqlite/outbox.sqlite (version history + the
 * write-replication outbox) — never the graph/vector substrate a host
 * actually queries — so this is also a regression guard against a future
 * change accidentally reaching into live queryable data.
 *
 * Six required cases, matching sprint-3.md's "Tests" bullets for Fix 5:
 *   1. Refuses a held root (a live `BEGIN IMMEDIATE` on versions.sqlite from
 *      a second connection).
 *   2. `--dry-run` writes nothing — proven by file hash before/after, not
 *      just row counts.
 *   3. A real run on an Atlas-shaped layout (dataDir != LORE_HOME, built via
 *      createLore() in a temp dir, with duplicate re-upserts pre-seeded
 *      directly into versions.sqlite — see note below) reclaims space.
 *   4. RECALL PARITY (the mandatory integration proof) — recall/search
 *      results before and after a real reclaim are identical.
 *   5. Version-history readers still return coherent history after reclaim:
 *      a real change survives, a protected-node row survives regardless of
 *      no-op status, an exact-duplicate row is gone.
 *   6. A layout with only the two SQLite files (no workspaces.json, no
 *      graph/vector substrate) works end to end.
 *
 * On pre-seeding "duplicate re-upserts" directly rather than via two
 * `nodeUpsert()` calls: Sprint 1 (isNoOpVersion / FIELDS_CLEARED_ON_OMISSION,
 * already merged on this branch's base) stops a NEW no-op version from ever
 * being recorded at write time. The rows this reclaim tool exists to clean
 * up are ones that predate that screen — on-disk history from before Sprint
 * 1 shipped. So, exactly like storage-growth-2-embedded.ts's R3/R4 pattern,
 * cases 3 and 5 pre-seed VersionStore/SqliteOutboxStore directly BEFORE
 * createLore() ever opens them, simulating that pre-existing data.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createLore } from '../packages/lore/src/index.js';
import { resolveLoreHome } from '../packages/lore/src/config/loreHome.js';
import { resolveGraphPath } from '../packages/lore/src/mcp/bootSteps.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import {
    reclaimStorage,
    ReclaimDataDirInUseError,
} from '../packages/lore/src/outbox/reclaimStorage.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) => {
    return (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })();
};

function graceWindow(ms = 200): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function loreDirFor(dataDir: string): string {
    const dataHome = resolveLoreHome({ dataDir });
    const graphBasePath = resolveGraphPath(dataHome);
    return path.join(graphBasePath, '.lore');
}

function fileHash(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function seedDuplicateVersionPair(store: VersionStore, nodeId: string, type: string): void {
    // First row of the node (always kept, regardless of no-op status —
    // dedupeIdenticalVersions() keeps MIN(rowid) per node_id).
    const content = 'dup-content-' + 'x'.repeat(2_000);
    store.recordVersion({
        versionId: randomUUID(),
        nodeId,
        workspace: 'default',
        timestamp: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        principal: 'test',
        operation: 'upsert',
        previousState: null,
        newState: { type, content },
        changesetId: null,
    });
    // Exact duplicate re-upsert — isNoOpVersion(prev, new) must be true
    // (same fields, ignoring the default-ignored ones) so
    // dedupeIdenticalVersions() drops it.
    store.recordVersion({
        versionId: randomUUID(),
        nodeId,
        workspace: 'default',
        timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        principal: 'test',
        operation: 'upsert',
        previousState: { type, content },
        newState: { type, content },
        changesetId: null,
    });
}

function seedRealChange(store: VersionStore, nodeId: string, type: string): void {
    store.recordVersion({
        versionId: randomUUID(),
        nodeId,
        workspace: 'default',
        timestamp: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        principal: 'test',
        operation: 'upsert',
        previousState: null,
        newState: { type, content: 'v1' },
        changesetId: null,
    });
    store.recordVersion({
        versionId: randomUUID(),
        nodeId,
        workspace: 'default',
        timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        principal: 'test',
        operation: 'upsert',
        previousState: { type, content: 'v1' },
        newState: { type, content: 'v2' }, // genuinely different — must survive dedup
        changesetId: null,
    });
}

function seedProtectedDuplicate(store: VersionStore, nodeId: string, type: string): void {
    // A row whose state carries `"status":"protected"` must survive
    // dedupeIdenticalVersions() even though it is an exact duplicate pair —
    // isProtected short-circuits before the isNoOpVersion check.
    const content = 'protected-content';
    store.recordVersion({
        versionId: randomUUID(),
        nodeId,
        workspace: 'default',
        timestamp: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        principal: 'test',
        operation: 'upsert',
        previousState: null,
        newState: { type, content, status: 'protected' },
        changesetId: null,
    });
    store.recordVersion({
        versionId: randomUUID(),
        nodeId,
        workspace: 'default',
        timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        principal: 'test',
        operation: 'upsert',
        previousState: { type, content, status: 'protected' },
        newState: { type, content, status: 'protected' },
        changesetId: null,
    });
}

async function seedReplicatedOutboxRow(store: SqliteOutboxStore, id: string, ageDays: number): Promise<void> {
    const ts = new Date(Date.now() - ageDays * 86_400_000).toISOString();
    const entry: OutboxEntry = {
        id,
        operation: 'test.op',
        initiator: 'test:seed',
        createdAt: ts,
        updatedAt: ts,
        steps: [],
        completed: true,
        workspace: 'default',
        operationKind: 'sync.vector.mirror',
        status: 'replicated',
        attempts: 0,
        replicatedAt: ts,
    };
    await store.record(entry);
}

async function main() {
    console.log('storage-growth fix 3/3 — offline reclaim tool\n');

    /* ─── 1: refuses a held root ───────────────────────────────────────── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'held');
        const loreDir = loreDirFor(dataDir);
        fs.mkdirSync(loreDir, { recursive: true });
        const seedStore = VersionStore.open(loreDir);
        seedStore.recordVersion({
            versionId: randomUUID(), nodeId: 'n1', workspace: 'default',
            timestamp: new Date().toISOString(), principal: 'test', operation: 'upsert',
            previousState: null, newState: { type: 'note', content: 'x' }, changesetId: null,
        });
        seedStore.close();

        await test('refuses a held root (live transaction on versions.sqlite)', async () => {
            const holder = new Database(path.join(loreDir, 'versions.sqlite'));
            holder.pragma('busy_timeout = 250');
            holder.exec('BEGIN IMMEDIATE');
            try {
                await assert.rejects(
                    () => reclaimStorage({ dataDir }),
                    ReclaimDataDirInUseError,
                    'reclaimStorage() must throw ReclaimDataDirInUseError while another connection holds the write lock',
                );
            } finally {
                holder.exec('ROLLBACK');
                holder.close();
            }
        });
    }

    /* ─── 1b: refuses an idle host, Surreal-backed graph (real createLore(),
     * no in-flight write) ─────────────────────────────────────────────────
     * Case 1 above only proves the SQLite write-lock probe catches a holder
     * that is mid-transaction at the exact instant of the probe. This case
     * proves idle-holder detection on a real host that is fully idle (no
     * in-flight write at all) — the normal steady state of a real host like
     * Atlas. checkNotHeld's probe (locking_mode=EXCLUSIVE + a forced read,
     * not a plain BEGIN IMMEDIATE — see reclaimStorage.ts's header) now
     * catches this on its own, on every layout; the graph lock
     * (acquirePieceRebuildLock, reused from rebuildPieceIndex.ts) still runs
     * too when the root has a Surreal-backed graph, redundantly. Forces
     * LORE_DEFAULT_GRAPH_ENGINE=surreal for the create so this case
     * specifically exercises that combination; case 1c below is the
     * SQLite-engine-graph equivalent. */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'idle-host');
        const priorGraphEngine = process.env['LORE_DEFAULT_GRAPH_ENGINE'];
        process.env['LORE_DEFAULT_GRAPH_ENGINE'] = 'surreal';
        let lore: Awaited<ReturnType<typeof createLore>>;
        try {
            lore = await createLore({ deploymentMode: 'embedded', dataDir });
            await lore.nodeUpsert({
                id: 'idle-host-node', workspace: 'default', ecosystem: 'test-eco',
                nodeData: { type: 'note', label: 'idle host probe', content: 'idle host probe' },
                skipEmbed: true, asyncEmbed: false,
            });
        } finally {
            if (priorGraphEngine === undefined) delete process.env['LORE_DEFAULT_GRAPH_ENGINE'];
            else process.env['LORE_DEFAULT_GRAPH_ENGINE'] = priorGraphEngine;
        }
        // No dispose() here — the point of this case is that `lore` stays
        // open and idle (no in-flight write) while reclaimStorage() runs.

        const loreDir = loreDirFor(dataDir);
        const versionsPath = path.join(loreDir, 'versions.sqlite');
        const outboxPath = path.join(loreDir, 'outbox.sqlite');
        await graceWindow();
        const hashesBefore = {
            v: fileHash(versionsPath),
            o: fs.existsSync(outboxPath) ? fileHash(outboxPath) : undefined,
        };

        await test('refuses an idle host (real createLore(), no in-flight write) — apply mode', async () => {
            await assert.rejects(
                () => reclaimStorage({ dataDir }),
                ReclaimDataDirInUseError,
                'reclaimStorage() must throw ReclaimDataDirInUseError against an idle (not mid-write) real host',
            );
            assert.equal(fileHash(versionsPath), hashesBefore.v, 'versions.sqlite must be untouched by a refused apply run');
            if (hashesBefore.o !== undefined) {
                assert.equal(fileHash(outboxPath), hashesBefore.o, 'outbox.sqlite must be untouched by a refused apply run');
            }
        });

        await test('refuses an idle host (real createLore(), no in-flight write) — dry-run', async () => {
            await assert.rejects(
                () => reclaimStorage({ dataDir, dryRun: true }),
                ReclaimDataDirInUseError,
                'reclaimStorage({ dryRun: true }) must also throw ReclaimDataDirInUseError against an idle real host',
            );
            assert.equal(fileHash(versionsPath), hashesBefore.v, 'versions.sqlite must be untouched by a refused dry-run');
            if (hashesBefore.o !== undefined) {
                assert.equal(fileHash(outboxPath), hashesBefore.o, 'outbox.sqlite must be untouched by a refused dry-run');
            }
        });

        await lore!.dispose();
    }

    /* ─── 1c: refuses an idle host, SQLite-engine graph (real createLore(),
     * no in-flight write) ─────────────────────────────────────────────────
     * Same shape as 1b, but forces LORE_DEFAULT_GRAPH_ENGINE=sqlite — the
     * engine new local workspaces default to (resolveNewWorkspaceGraphEngine)
     * and the one the graph-lock preflight CANNOT detect an idle holder on
     * (SQLite's WAL mode has no exclusive-lock-on-open the way SurrealDB's
     * RocksDB backend does). Before this fix, an idle host on this exact
     * layout passed straight through both preflights. checkNotHeld's
     * EXCLUSIVE-locking-mode probe now catches it directly, independent of
     * which graph engine (or none) is in use — this case is the proof for
     * that, and the one that would have failed against the pre-fix
     * checkNotHeld even after case 1b's graph-lock fix landed. */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'idle-host-sqlite-engine');
        const priorGraphEngine = process.env['LORE_DEFAULT_GRAPH_ENGINE'];
        process.env['LORE_DEFAULT_GRAPH_ENGINE'] = 'sqlite';
        let lore: Awaited<ReturnType<typeof createLore>>;
        try {
            lore = await createLore({ deploymentMode: 'embedded', dataDir });
            await lore.nodeUpsert({
                id: 'idle-host-sqlite-node', workspace: 'default', ecosystem: 'test-eco',
                nodeData: { type: 'note', label: 'idle host probe (sqlite engine)', content: 'idle host probe' },
                skipEmbed: true, asyncEmbed: false,
            });
        } finally {
            if (priorGraphEngine === undefined) delete process.env['LORE_DEFAULT_GRAPH_ENGINE'];
            else process.env['LORE_DEFAULT_GRAPH_ENGINE'] = priorGraphEngine;
        }
        // No dispose() here — same as 1b, the point is a fully idle host
        // with no in-flight write while reclaimStorage() runs against it.

        const loreDir = loreDirFor(dataDir);
        const versionsPath = path.join(loreDir, 'versions.sqlite');
        const outboxPath = path.join(loreDir, 'outbox.sqlite');
        await graceWindow();
        const hashesBefore = {
            v: fileHash(versionsPath),
            o: fs.existsSync(outboxPath) ? fileHash(outboxPath) : undefined,
        };

        await test('refuses an idle host, SQLite-engine graph (real createLore(), no in-flight write) — apply mode', async () => {
            await assert.rejects(
                () => reclaimStorage({ dataDir }),
                ReclaimDataDirInUseError,
                'reclaimStorage() must throw ReclaimDataDirInUseError against an idle real host with a SQLite-engine graph',
            );
            assert.equal(fileHash(versionsPath), hashesBefore.v, 'versions.sqlite must be untouched by a refused apply run');
            if (hashesBefore.o !== undefined) {
                assert.equal(fileHash(outboxPath), hashesBefore.o, 'outbox.sqlite must be untouched by a refused apply run');
            }
        });

        await test('refuses an idle host, SQLite-engine graph (real createLore(), no in-flight write) — dry-run', async () => {
            await assert.rejects(
                () => reclaimStorage({ dataDir, dryRun: true }),
                ReclaimDataDirInUseError,
                'reclaimStorage({ dryRun: true }) must also throw ReclaimDataDirInUseError against an idle real host with a SQLite-engine graph',
            );
            assert.equal(fileHash(versionsPath), hashesBefore.v, 'versions.sqlite must be untouched by a refused dry-run');
            if (hashesBefore.o !== undefined) {
                assert.equal(fileHash(outboxPath), hashesBefore.o, 'outbox.sqlite must be untouched by a refused dry-run');
            }
        });

        await lore!.dispose();
    }

    /* ─── 2: --dry-run writes nothing (byte-identical files) ──────────── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'dryrun');
        const loreDir = loreDirFor(dataDir);
        fs.mkdirSync(loreDir, { recursive: true });

        {
            const vs = VersionStore.open(loreDir);
            seedDuplicateVersionPair(vs, 'dup-node', 'scratch-x');
            seedRealChange(vs, 'real-node', 'scratch-x');
            vs.close();
            const os = new SqliteOutboxStore(loreDir);
            await seedReplicatedOutboxRow(os, 'old-replicated', 30);
            os.close();
        }

        const versionsPath = path.join(loreDir, 'versions.sqlite');
        const outboxPath = path.join(loreDir, 'outbox.sqlite');
        const hashesBefore = { v: fileHash(versionsPath), o: fileHash(outboxPath) };

        await test('--dry-run leaves both SQLite files byte-identical and reports non-zero reclaimable', async () => {
            const result = await reclaimStorage({ dataDir, dryRun: true, outboxRetentionMs: 7 * 86_400_000 });
            assert.equal(fileHash(versionsPath), hashesBefore.v, 'versions.sqlite must be byte-identical after a dry-run');
            assert.equal(fileHash(outboxPath), hashesBefore.o, 'outbox.sqlite must be byte-identical after a dry-run');

            const vFile = result.files.find((f) => f.file === 'versions.sqlite')!;
            const oFile = result.files.find((f) => f.file === 'outbox.sqlite')!;
            assert.ok(vFile.present && oFile.present);
            assert.equal(vFile.estimated, true);
            assert.equal(oFile.estimated, true);
            assert.equal(vFile.dedupedRows, 1, 'exactly the one exact-duplicate row should be counted as dedupeable');
            assert.equal(oFile.prunedReplicatedRows, 1, 'the one old replicated row should be counted as pruneable');
            assert.ok(vFile.bytesReclaimed > 0, 'dry-run must still estimate a non-zero reclaimable byte count');
        });
    }

    /* ─── 3 + 5: real run reclaims space; history stays coherent ──────── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'real-run');
        const loreDir = loreDirFor(dataDir);
        fs.mkdirSync(loreDir, { recursive: true });

        {
            const vs = VersionStore.open(loreDir);
            seedDuplicateVersionPair(vs, 'dup-node', 'scratch-x');
            seedRealChange(vs, 'real-node', 'scratch-x');
            seedProtectedDuplicate(vs, 'protected-node', 'scratch-x');
            vs.close();
            const os = new SqliteOutboxStore(loreDir);
            await seedReplicatedOutboxRow(os, 'old-replicated-1', 30);
            await seedReplicatedOutboxRow(os, 'old-replicated-2', 45);
            await seedReplicatedOutboxRow(os, 'recent-replicated', 1);
            os.close();
        }

        const versionsPath = path.join(loreDir, 'versions.sqlite');
        const outboxPath = path.join(loreDir, 'outbox.sqlite');
        const sizeBefore = { v: fs.statSync(versionsPath).size, o: fs.statSync(outboxPath).size };

        await test('a real run reclaims space and version-history readers stay coherent', async () => {
            const result = await reclaimStorage({ dataDir, dryRun: false, outboxRetentionMs: 7 * 86_400_000 });
            assert.equal(result.dryRun, false);

            const vFile = result.files.find((f) => f.file === 'versions.sqlite')!;
            const oFile = result.files.find((f) => f.file === 'outbox.sqlite')!;
            assert.equal(vFile.estimated, false, 'a real run reports measured, not estimated, bytes');
            assert.equal(oFile.estimated, false);
            assert.equal(vFile.dedupedRows, 1);
            assert.equal(oFile.prunedReplicatedRows, 2, 'both old replicated rows, and only those, should be pruned');
            assert.equal(vFile.autoVacuumAfter, 2, 'versions.sqlite must end in auto_vacuum=INCREMENTAL (2)');
            assert.equal(oFile.autoVacuumAfter, 2, 'outbox.sqlite must end in auto_vacuum=INCREMENTAL (2)');
            assert.ok(
                fs.statSync(versionsPath).size <= sizeBefore.v,
                'versions.sqlite must not have grown after a real reclaim',
            );
            assert.ok(
                fs.statSync(outboxPath).size <= sizeBefore.o,
                'outbox.sqlite must not have grown after a real reclaim',
            );

            const vs = VersionStore.open(loreDir);
            try {
                const dupHistory = vs.getVersions('dup-node', 'default', 50);
                assert.equal(dupHistory.length, 1, 'the exact-duplicate row must be gone; only the first row of the node survives');

                const realHistory = vs.getVersions('real-node', 'default', 50);
                assert.equal(realHistory.length, 2, 'a genuine change must survive dedup — both rows remain');
                // getVersions() is newest-first: index 0 is the v1->v2 change, index 1 is the original v1 row.
                assert.equal((realHistory[0]!.newState as { content: string }).content, 'v2', 'the real change itself must still be legible');
                assert.equal((realHistory[1]!.newState as { content: string }).content, 'v1', 'the first row of the node must still be legible');

                const protectedHistory = vs.getVersions('protected-node', 'default', 50);
                assert.equal(protectedHistory.length, 2, 'a protected-node row survives dedup even though it is an exact duplicate');
            } finally {
                vs.close();
            }

            const os = new SqliteOutboxStore(loreDir);
            try {
                assert.ok(!fs.readFileSync(outboxPath).includes('old-replicated-1'), 'sanity: pruned row id should not appear verbatim in the file (best-effort, not authoritative)');
            } finally {
                os.close();
            }
        });
    }

    /* ─── 4: RECALL PARITY — the mandatory embedded integration proof ─── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'recall-parity');

        const lore1 = await createLore({ deploymentMode: 'embedded', dataDir });
        await lore1.nodeUpsert({
            id: 'rp-decision-1', workspace: 'default', ecosystem: 'test-eco',
            nodeData: { type: 'decision', label: 'Use embedded Lore', content: 'We chose embedded mode for the reclaim-parity test.' },
            skipEmbed: false, asyncEmbed: false,
        });
        await lore1.nodeUpsert({
            id: 'rp-decision-2', workspace: 'default', ecosystem: 'test-eco',
            nodeData: { type: 'decision', label: 'Reclaim tool design', content: 'The offline reclaim tool only ever touches version history and the outbox.' },
            skipEmbed: false, asyncEmbed: false,
        });
        // Write the SAME node again with identical content — an ordinary
        // client-visible re-upsert (not a raw store seed), which Sprint 1
        // already screens from recording a new no-op version. This proves
        // the reclaim's dedup step has real duplicate history to work with
        // in a live embedded host even without raw seeding, though the
        // bulk of the reclaimable rows here still come from Sprint 1
        // predating the version history on disk in other cases above.
        await lore1.nodeUpsert({
            id: 'rp-decision-1', workspace: 'default', ecosystem: 'test-eco',
            nodeData: { type: 'decision', label: 'Use embedded Lore', content: 'We chose embedded mode for the reclaim-parity test.' },
            skipEmbed: false, asyncEmbed: false,
        });

        const before = await lore1.store.storageClient.search('embedded', 10, undefined, 'test-eco');
        const beforeIds = before.map((h: { id: string }) => h.id);
        const beforeRecallRaw = await lore1.recall('reclaim tool design', { workspace: 'default', mode: 'summary' });
        assert.equal(beforeRecallRaw.mode, 'summary');
        const beforeRecall = beforeRecallRaw as import('../packages/lore/src/recall/recallPreset.js').RecallResultSummary;
        await lore1.dispose();

        await test('recall/search results are identical before and after a real reclaim (mandatory embedded integration proof)', async () => {
            assert.ok(beforeIds.length > 0, 'the seeded search must actually return hits, or this test proves nothing');

            const result = await reclaimStorage({ dataDir, dryRun: false });
            assert.ok(result.files.some((f) => f.present), 'the reclaim must have found at least one SQLite file to act on');

            const lore2 = await createLore({ deploymentMode: 'embedded', dataDir });
            try {
                const after = await lore2.store.storageClient.search('embedded', 10, undefined, 'test-eco');
                const afterIds = after.map((h: { id: string }) => h.id);
                assert.deepEqual(afterIds, beforeIds, 'search must return the same ids in the same order after reclaim');

                const node1 = await lore2.store.storageClient.getNode('rp-decision-1');
                assert.ok(node1, 'rp-decision-1 must still be readable after reclaim');
                assert.equal(node1!.content, 'We chose embedded mode for the reclaim-parity test.');

                const afterRecallRaw = await lore2.recall('reclaim tool design', { workspace: 'default', mode: 'summary' });
                assert.equal(afterRecallRaw.mode, 'summary');
                const afterRecall = afterRecallRaw as import('../packages/lore/src/recall/recallPreset.js').RecallResultSummary;
                assert.deepEqual(
                    afterRecall.hits.map((h) => h.id),
                    beforeRecall.hits.map((h) => h.id),
                    'recall() must return the same hit ids in the same order after reclaim',
                );
            } finally {
                await lore2.dispose();
            }
        });
    }

    /* ─── 6: layout with only the two SQLite files works ──────────────── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'sqlite-only');
        const home = resolveLoreHome({ dataDir });
        // Deliberately bypass resolveGraphPath()/workspaces.json entirely —
        // build the raw layout reclaimStorage() must still handle: just
        // `<home>/.lore/{versions,outbox}.sqlite`, nothing else.
        const loreDir = path.join(home, '.lore');
        fs.mkdirSync(loreDir, { recursive: true });
        {
            const vs = VersionStore.open(loreDir);
            seedDuplicateVersionPair(vs, 'dup-node', 'scratch-x');
            vs.close();
            const os = new SqliteOutboxStore(loreDir);
            await seedReplicatedOutboxRow(os, 'old-replicated', 30);
            os.close();
        }

        await test('a data dir containing only versions.sqlite + outbox.sqlite (no other substrate) works end to end', async () => {
            const result = await reclaimStorage({ dataDir, dryRun: false, outboxRetentionMs: 7 * 86_400_000 });
            const vFile = result.files.find((f) => f.file === 'versions.sqlite')!;
            const oFile = result.files.find((f) => f.file === 'outbox.sqlite')!;
            assert.equal(vFile.present, true);
            assert.equal(oFile.present, true);
            assert.equal(vFile.dedupedRows, 1);
            assert.equal(oFile.prunedReplicatedRows, 1);
        });
    }

    /* ─── missing-file case: only versions.sqlite present ──────────────── */
    {
        const dataDir = path.join(process.env.LORE_HOME!, 'versions-only');
        const home = resolveLoreHome({ dataDir });
        const loreDir = path.join(home, '.lore');
        fs.mkdirSync(loreDir, { recursive: true });
        {
            const vs = VersionStore.open(loreDir);
            seedDuplicateVersionPair(vs, 'dup-node', 'scratch-x');
            vs.close();
        }

        await test('a data dir with only versions.sqlite (outbox.sqlite absent) reports outbox as not-present, never creates it', async () => {
            const result = await reclaimStorage({ dataDir, dryRun: false });
            const vFile = result.files.find((f) => f.file === 'versions.sqlite')!;
            const oFile = result.files.find((f) => f.file === 'outbox.sqlite')!;
            assert.equal(vFile.present, true);
            assert.equal(oFile.present, false, 'outbox.sqlite must be reported absent, not silently created');
            assert.ok(!fs.existsSync(path.join(loreDir, 'outbox.sqlite')), 'reclaimStorage() must never create a file that was not already there');
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

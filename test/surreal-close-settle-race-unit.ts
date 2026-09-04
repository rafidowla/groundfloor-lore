#!/usr/bin/env tsx
/**
 * surreal-close-settle-race-unit.ts — a store closed MOMENTS before a restore
 * must not clobber the store restored over it. No spaces anywhere in the path.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE SPACE-PATH TEST ────────────────────
 *
 * `surreal-space-path-backup-restore-unit.ts` found this failure, but it found
 * it inside a workspace whose path contains a space — so the obvious reading
 * was "the `%20` scattering in `surrealDataPath` is mishandled somewhere in
 * restore". It is not. The space handling is correct; the failure is a race,
 * and the space is incidental to it.
 *
 * `@surrealdb/node`'s `close()` only frees the engine handle — it does not
 * await a flush. surrealkv's WAL→sstable flush lands ~10-25 ms AFTER `close()`
 * resolves, and it writes by the on-disk PATH it captured when the store was
 * opened. `restoreWorkspace` renames the destination store aside and drops the
 * archived one at that same path within milliseconds. The old store's deferred
 * flush then unlinks `wal/00000000000000000000.wal` — same filename in every
 * fresh store — which is the restored store's ONLY data file, because its
 * manifest is still the 55-byte pre-flush one referencing no sstables. The
 * next open reads an empty graph and reports success. Sometimes the stale
 * flush instead lands its sstable on top of the restored one and the reopen
 * shows the OLD store's node. Both are silent.
 *
 * So this file pins the race with NO reserved character anywhere: every path
 * below is plain ASCII, `surrealDataPath()` is a byte-identical no-op for all
 * of them, and any failure here is the close/flush window alone.
 *
 * Measured on the pre-fix baseline: 4/4 rename-then-replace runs came up with
 * the archived nodes MISSING and the replaced store's own node VISIBLE. After
 * the fix: 0/4. The restore-level case is the same race with `tar -x`'s
 * latency in front of it — on a fast disk that extraction can outlast the
 * flush, which is precisely why the window is pinned at the rename here rather
 * than only through `restoreWorkspace`.
 *
 * Run: npx tsx test/surreal-close-settle-race-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { backupWorkspace } from '../packages/lore/src/engines/backup.js';
import { restoreWorkspace } from '../packages/lore/src/engines/restore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { surrealDataPath } from '../packages/lore/src/engines/surreal/surrealConnection.js';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-settle-race-'));

/** Write `ids` into a fresh workspace at `dir` and close it. */
async function seed(dir: string, workspaceId: string, ids: string[]): Promise<void> {
    fs.mkdirSync(path.join(dir, '.lore'), { recursive: true });
    const g = new SurrealGraph(dir, { workspaceId });
    await g.initialize();
    const now = new Date().toISOString();
    for (const id of ids) {
        await g.upsertNode({
            id, type: 'note', label: `label-${id}`, content: `content-${id}`,
            tags: [], project: '*', ecosystem: '*', metadata: {},
            createdAt: now, updatedAt: now,
        } as never);
    }
    await g.close();
}

/** Read one id back through a freshly-opened engine. */
async function readBack(dir: string, workspaceId: string, ids: string[]): Promise<Record<string, boolean>> {
    const g = new SurrealGraph(dir, { workspaceId });
    await g.initialize();
    try {
        const out: Record<string, boolean> = {};
        for (const id of ids) out[id] = (await g.getNode(id)) !== null;
        return out;
    } finally {
        await g.close();
    }
}

console.log('Close→restore flush race (no spaces in any path)');

const outDir = path.join(root, 'out');
fs.mkdirSync(outDir, { recursive: true });

// The archive: a plain workspace holding two nodes.
const source = path.join(root, 'source-ws');
await seed(source, 'race-src', ['archived-1', 'archived-2']);

let tarball = '';
await test('the fixture uses no reserved characters — surrealDataPath is a no-op here', async () => {
    assert.equal(
        surrealDataPath(source),
        path.join(source, '.lore', 'surreal'),
        'this test is only meaningful when path normalization changes nothing',
    );
    const res = await backupWorkspace({ workspaceDir: source, workspaceName: 'race-src', outDir });
    tarball = res.tarballPath;
    assert.ok(res.files.includes('surreal/'), `the graph travelled (${res.files.join(', ')})`);
});

await test('backup reads the copied graph back and reports what it captured', async () => {
    const res = await backupWorkspace({ workspaceDir: source, workspaceName: 'race-count', outDir });
    assert.equal(
        res.graphNodeCount, 2,
        'a backup must be able to say the graph it copied is readable and holds the source rows — '
        + '"a surreal/ directory is present" is satisfied by an empty store',
    );
});

// A fully-settled copy of the source store, taken once. Restoring is a rename
// + a directory copy; this is that copy's payload, with the tar round-trip
// removed so the measurement is of the close window and nothing else.
const template = path.join(root, 'settled-template');
await new Promise((r) => setTimeout(r, 800));
fs.cpSync(surrealDataPath(source), template, { recursive: true });

await test('close() leaves the store safe to rename aside and replace — 4 consecutive runs', async () => {
    // The raw window, with restore's own latency removed. `restoreWorkspace`
    // spawns `tar -x` before it renames anything, and on a fast disk that
    // extraction alone can outlast the flush — which is exactly why this
    // failure looks intermittent in the wild and why it is pinned HERE, at the
    // rename, rather than only through the CLI path. The contract under test
    // is `SurrealGraph.close()`'s: once it resolves, this directory is no
    // longer being written to, so moving it and putting another store at the
    // same path is safe.
    //
    // Baseline behaviour: 4/4 runs report `archived-1` MISSING and the
    // sidelined `live-N` VISIBLE — the closed store's deferred flush unlinked
    // the replacement's WAL and then landed its own sstable at that path.
    const losses: string[] = [];
    for (let i = 0; i < 4; i++) {
        const dest = path.join(root, `dest-rename-${i}`);
        await seed(dest, `race-rename-${i}`, [`live-${i}`]);

        // No delay: replace the just-closed store the way restore does.
        const store = surrealDataPath(dest);
        fs.renameSync(store, `${store}.pre-restore`);
        fs.cpSync(template, store, { recursive: true });

        // Wait well past the flush window before reading, so a deferred flush
        // has every chance to land. A failure that only appears after the wait
        // is exactly the silent one this test is for.
        await new Promise((r) => setTimeout(r, 800));

        const seen = await readBack(dest, `race-rename-${i}`, ['archived-1', 'archived-2', `live-${i}`]);
        if (!seen['archived-1'] || !seen['archived-2']) losses.push(`run ${i}: replacement store came up EMPTY`);
        if (seen[`live-${i}`]) losses.push(`run ${i}: the replaced store's own node (live-${i}) is VISIBLE — its flush overwrote the replacement`);
    }
    assert.deepEqual(losses, [], losses.join(' | '));
});

await test('a destination closed MOMENTS ago does not clobber the store restored over it', async () => {
    const dest = path.join(root, 'dest-ws');
    // Same race through the real `restoreWorkspace` path, with no delay
    // between the destination's close and the restore.
    await seed(dest, 'race-dst', ['live-1']);

    const result = await restoreWorkspace({
        tarballPath: tarball, workspaceDir: dest, expectedEngine: 'surreal',
    });
    assert.ok(result.sidelinedPriorTo, 'the prior .lore/ must be sidelined as a rollback path');

    await new Promise((r) => setTimeout(r, 600));

    const seen = await readBack(dest, 'race-dst', ['archived-1', 'archived-2', 'live-1']);
    assert.equal(seen['archived-1'], true, 'archived-1 must be readable from the restored store');
    assert.equal(seen['archived-2'], true, 'archived-2 must be readable from the restored store');
    assert.equal(seen['live-1'], false, 'the sidelined store\'s node must NOT be live — sidelined, not merged');
});

await test('restore reads the graph back itself and reports a verified count', async () => {
    const dest = path.join(root, 'dest-verified-ws');
    await seed(dest, 'race-verify', ['live-2']);
    const result = await restoreWorkspace({
        tarballPath: tarball, workspaceDir: dest, expectedEngine: 'surreal',
    });
    assert.equal(result.expectedGraphNodeCount, 2, 'the archive must record what the source graph held');
    assert.equal(
        result.restoredGraphNodeCount, 2,
        'restore must open the restored store and count it — a byte-level catalog match cannot '
        + 'distinguish a good store from one whose WAL was unlinked after extraction',
    );
});

await test('the race does not resolve by luck — three consecutive restores all land', async () => {
    for (let i = 0; i < 3; i++) {
        const dest = path.join(root, `dest-repeat-${i}`);
        await seed(dest, `race-repeat-${i}`, [`live-repeat-${i}`]);
        const result = await restoreWorkspace({
            tarballPath: tarball, workspaceDir: dest, expectedEngine: 'surreal',
        });
        assert.equal(result.restoredGraphNodeCount, 2, `restore #${i} must land both archived nodes`);
        await new Promise((r) => setTimeout(r, 300));
        const seen = await readBack(dest, `race-repeat-${i}`, ['archived-1', `live-repeat-${i}`]);
        assert.equal(seen['archived-1'], true, `restore #${i}: archived-1 readable`);
        assert.equal(seen[`live-repeat-${i}`], false, `restore #${i}: prior node not live`);
    }
});

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

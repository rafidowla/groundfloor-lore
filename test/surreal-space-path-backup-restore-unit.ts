#!/usr/bin/env tsx
/**
 * surreal-space-path-backup-restore-unit.ts — a workspace whose path contains
 * a space round-trips through open → write → close → reopen → backup →
 * restore → reopen, and the data is found at every step.
 *
 * ── WHY THIS IS NOT COVERED BY THE OTHER ROUNDTRIP TEST ─────────────────────
 *
 * `surreal-backup-roundtrip-unit.ts` proves backup/restore works for a
 * Surreal-backed workspace whose path has no reserved URL characters — the
 * overwhelmingly common case, and the one `surrealDataPath()` is a no-op for.
 *
 * This is the other case: `openSurreal`'s `${backend}://${dataPath}` connect
 * string is parsed as a URL, so a space anywhere in the workspace's path gets
 * silently percent-encoded with no decode step, and the embedded engine
 * creates/reads its actual on-disk directory at that %20-spelled location —
 * NOT the literal path. Before `surrealDataPath()` accounted for this,
 * `graphStoresOnDisk`/`bannerGraphPath` looked at the literal (empty) path and
 * reported no graph, and `backupWorkspace`'s `readdirSync(loreDir)` walk never
 * saw the scattered store at all — a backup that reports success while
 * silently omitting the entire graph.
 *
 * So this test forces both workspace directories (source AND destination) to
 * contain a space, and proves — with real reads through a freshly-opened
 * `SurrealGraph`, not file-presence checks — that:
 *   - the store really does land outside `source/.lore/` (confirming the
 *     scattering is real, not a hypothesis);
 *   - backup finds and captures it anyway;
 *   - restore into a DIFFERENT space-containing destination places it where
 *     `surrealDataPath(dest)` will actually look, not at the naive nested
 *     `dest/.lore/surreal`;
 *   - a live store already sitting at the destination's real location is
 *     sidelined, not clobbered.
 *
 * Run: npx tsx test/surreal-space-path-backup-restore-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { backupWorkspace } from '../packages/lore/src/engines/backup.js';
import { restoreWorkspace } from '../packages/lore/src/engines/restore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { surrealDataPath } from '../packages/lore/src/engines/surreal/surrealConnection.js';
import { graphStoresOnDisk } from '../packages/lore/src/engines/openWorkspaceGraph.js';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-space-'));
// The space lives in the WORKSPACE segment itself, several levels below an
// otherwise space-free tmp root — matching the real pm-scope-app shape
// ("Morguard SAIL Emails").
const ws = path.join(root, 'Client Projects', 'Morguard SAIL', 'lore-data');
fs.mkdirSync(path.join(ws, '.lore'), { recursive: true });
fs.mkdirSync(path.join(root, 'out'), { recursive: true });

const NODES = [
    { id: 's1', type: 'decision', label: 'Alpha', content: 'first body' },
    { id: 's2', type: 'note', label: 'Beta', content: 'second body' },
];

console.log('Space-in-path workspace: backup and restore');

// ── build a Surreal-backed workspace whose path contains a space ───────────
{
    const g = new SurrealGraph(ws, { workspaceId: 'space-src' });
    await g.initialize();
    const now = new Date().toISOString();
    for (const n of NODES) {
        await g.upsertNode({
            ...n, tags: [], project: '*', ecosystem: '*', metadata: {},
            createdAt: now, updatedAt: now,
        } as never);
    }
    await g.close();
}

await test('the store really is scattered outside ws/.lore (confirms the bug is real)', () => {
    const naive = path.join(ws, '.lore', 'surreal');
    const real = surrealDataPath(ws);
    assert.notEqual(real, naive, 'a space in the path must change where the store lands');
    assert.ok(!fs.existsSync(naive) || fs.readdirSync(naive).length === 0,
        'the literal nested path must be empty — the whole bug is that data never lands there');
    assert.ok(fs.existsSync(real), 'the real, %20-normalized location must hold the actual store');
});

await test('graphStoresOnDisk finds it despite the scattering', () => {
    const result = graphStoresOnDisk(ws);
    assert.equal(result.surreal, true, 'must detect the scattered store, not just the naive path');
});

let tarball = '';

await test('backup finds and captures the scattered store', async () => {
    const res = await backupWorkspace({ workspaceDir: ws, workspaceName: 'space-src', outDir: path.join(root, 'out') });
    tarball = res.tarballPath;
    assert.ok(res.files.includes('surreal/'), `the scattered Surreal store travelled (${res.files.join(', ')})`);
});

await test('restore into a DIFFERENT space-containing destination lands the data where the engine will look', async () => {
    const dest = path.join(root, 'Other Clients', 'New Project', 'lore-data');
    fs.mkdirSync(path.join(dest, '.lore'), { recursive: true });

    const result = await restoreWorkspace({ tarballPath: tarball, workspaceDir: dest, expectedEngine: 'surreal' });

    const naiveDest = path.join(dest, '.lore', 'surreal');
    const realDest = surrealDataPath(dest);
    assert.notEqual(realDest, naiveDest, 'destination must also scatter — otherwise this test proves nothing new');
    assert.ok(!fs.existsSync(naiveDest) || fs.readdirSync(naiveDest).length === 0,
        'data must NOT be left at the naive nested path — that would reproduce the bug in reverse');
    assert.ok(fs.existsSync(realDest), 'data must be relocated to the real, engine-normalized location');
    assert.equal(result.sidelinedPriorScatteredSurrealTo, null, 'nothing pre-existed at the real location to sideline');

    // The real proof: read it back through a freshly-opened engine.
    const g = new SurrealGraph(dest, { workspaceId: 'space-dst' });
    await g.initialize();
    try {
        for (const n of NODES) {
            const back = await g.getNode(n.id);
            assert.ok(back, `${n.id} restored`);
            assert.equal(back!.label, n.label, `${n.id} label intact`);
            assert.equal(back!.content, n.content, `${n.id} content intact`);
        }
    } finally {
        await g.close();
    }
});

await test('a live store already at the destination real location is sidelined, not clobbered', async () => {
    const dest = path.join(root, 'Guarded Clients', 'Existing Project', 'lore-data');
    fs.mkdirSync(path.join(dest, '.lore'), { recursive: true });

    // Pre-populate the destination's REAL (scattered) location with its own
    // live, distinguishable data before restoring into it.
    const preexisting = new SurrealGraph(dest, { workspaceId: 'space-guard' });
    await preexisting.initialize();
    const now = new Date().toISOString();
    await preexisting.upsertNode({
        id: 'guard-1', type: 'decision', label: 'Pre-existing', content: 'must not be lost',
        tags: [], project: '*', ecosystem: '*', metadata: {}, createdAt: now, updatedAt: now,
    } as never);
    await preexisting.close();

    const realDestBefore = surrealDataPath(dest);
    assert.ok(fs.existsSync(realDestBefore), 'sanity: the live store is really there before restore');

    const result = await restoreWorkspace({ tarballPath: tarball, workspaceDir: dest, expectedEngine: 'surreal' });

    assert.ok(result.sidelinedPriorScatteredSurrealTo, 'the pre-existing live store must be sidelined, not silently overwritten');
    assert.ok(fs.existsSync(result.sidelinedPriorScatteredSurrealTo!), 'the sidelined copy must actually exist on disk');

    // The restored (archived) nodes are now live at the real location...
    const g = new SurrealGraph(dest, { workspaceId: 'space-guard' });
    await g.initialize();
    try {
        const restored = await g.getNode('s1');
        assert.ok(restored, 'archived node present after restore');
        const guard = await g.getNode('guard-1');
        assert.equal(guard, null, 'the pre-existing node is no longer in the LIVE store — it was sidelined, not merged');
    } finally {
        await g.close();
    }
});

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

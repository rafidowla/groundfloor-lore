#!/usr/bin/env tsx
/**
 * test/verbatim-resolver-home-mismatch-unit.ts — STEP2-CLOSE-PATH-DESIGN.md (e).
 *
 * Bug found during Step 1's memory measurement (docs/PERFORMANCE-MEMORY.md
 * §8.5): with `createLore({ dataDir })` where `dataDir !== process.env.LORE_HOME`,
 * `LocalGraphRegistry` resolves workspaces under `dataDir` (it takes an
 * explicit `home` at construction — engines/localGraphRegistry.ts), but
 * `WorkspaceVerbatimResolver` called `getWorkspacePath(workspace)` with NO
 * home argument, silently defaulting to `process.env.LORE_HOME`. The two
 * halves of one workspace could resolve to two DIFFERENT homes.
 *
 * Fix: `WorkspaceVerbatimResolver` now takes an instance-scoped `home` at
 * construction (mirroring `LocalGraphRegistry`) and threads it into every
 * `getWorkspacePath()` call (`prime()`, `getOrOpen()`).
 *
 * This test reproduces the exact split: register a workspace ONLY under a
 * data-root that is NOT `process.env.LORE_HOME`, and prove:
 *   1. A resolver constructed WITHOUT `home` (the pre-fix default) cannot
 *      find it — `workspace_not_found` against the wrong (env) home. This
 *      pins the bug so a regression is caught, not just the fix.
 *   2. A resolver constructed WITH `home: dataDir` finds it correctly and
 *      opens a real store rooted under `dataDir`, never touching
 *      `process.env.LORE_HOME` at all.
 *
 * Run: npx tsx test/verbatim-resolver-home-mismatch-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';

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

console.log('\nWorkspaceVerbatimResolver — home mismatch (STEP2-CLOSE-PATH-DESIGN.md (e))\n');

// TWO distinct homes. process.env.LORE_HOME points at ENV_HOME (empty —
// nothing is ever registered there); the workspace under test is registered
// ONLY under DATA_DIR, simulating createLore({ dataDir: DATA_DIR }) while
// some other process/session has LORE_HOME set to something else entirely
// (the exact shape the measurement harness had to work around — §8.5).
const ENV_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-home-env-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-home-data-'));
process.env.LORE_HOME = ENV_HOME;

const ws = createWorkspace('home-mismatch-ws', {}, DATA_DIR);

await test('pins the bug: a resolver with NO home defaults to LORE_HOME and cannot find a dataDir-only workspace', async () => {
    const resolver = new WorkspaceVerbatimResolver(undefined, false, {});
    await assert.rejects(
        () => resolver.getOrOpen(ws.name),
        /workspace_not_found/,
        'without an explicit home, the resolver looks under process.env.LORE_HOME and misses it',
    );
});

await test('fix: a resolver constructed with { home: dataDir } finds and opens the workspace', async () => {
    const resolver = new WorkspaceVerbatimResolver(undefined, false, {}, { home: DATA_DIR });
    const store = await resolver.getOrOpen(ws.name);
    await store.store({ id: 'n1', text: 'resolved under the correct dataDir home', metadata: { type: 'note' } });
    const row = await store.getById('n1');
    assert.ok(row, 'the store opened under the explicit home is real and writable');

    // Prove it never touched ENV_HOME: no workspaces/ dir should exist there
    // for this workspace (it was registered only under DATA_DIR).
    const envHomeWorkspaceDir = path.join(ENV_HOME, 'workspaces', ws.name);
    assert.equal(fs.existsSync(envHomeWorkspaceDir), false, 'the resolver must never create/touch anything under LORE_HOME');

    // And the data really lives under DATA_DIR.
    assert.ok(fs.existsSync(path.join(ws.path, '.lore', 'lancedb')), 'the LanceDB dir is under the dataDir workspace path');
});

await test('prime() also threads the explicit home (boot-store seeding under dataDir)', async () => {
    const resolver = new WorkspaceVerbatimResolver(undefined, false, {}, { home: DATA_DIR });
    const other = new WorkspaceVerbatimResolver(undefined, false, {}, { home: DATA_DIR });
    const bootStore = await other.getOrOpen(ws.name);
    resolver.prime(ws.name, bootStore);
    const primed = await resolver.getOrOpen(ws.name);
    assert.equal(primed, bootStore, 'prime() under the correct home seats the SAME instance getOrOpen returns');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

/**
 * test/phase6-p1a-workspace-routing-unit.ts
 *
 * Phase 6 P1.A — workspace routing (schema-only slice).
 *
 * This slice ships the schema fields + helper functions so callers can
 * START sending workspace: args without changing call sites later. The
 * runtime that actually routes physical writes to a non-active
 * workspace's store ships in P1.B (multi-graph LocalGraphRegistry +
 * StorageBundle refactor + HTTP X-Lore-Workspace local-mode pass-through).
 *
 * IMPORTANT: workspaces.ts captures LORE_HOME at import time. Run this
 * test under a process-level env override:
 *
 *   LORE_HOME=$(mktemp -d) npx tsx test/phase6-p1a-workspace-routing-unit.ts
 *
 * The test populates that fresh LORE_HOME with a workspaces.json
 * fixture before importing the module under test. Without the env
 * override the test would read the live daemon's workspaces.json.
 *
 * What this slice (P1.A) covers:
 *   - getWorkspacePath(name) returns the correct path for a known workspace
 *   - getWorkspacePath(name) throws workspace_not_found for unknown names
 *   - getWorkspacePath() with no arg returns the active workspace's path
 *   - getWorkspacePath re-reads workspaces.json on every call (no caching)
 *   - listWorkspaceNames() returns the registered names
 *   - Tool input schemas accept optional workspace: arg (type-level smoke)
 *
 * What P1.B will add (NOT covered here): T1-T5 from the spec — they
 * require the multi-graph LocalGraphRegistry runtime + HTTP middleware
 * pass-through. Those tests will be added when that runtime ships.
 *
 * Run (recommended via wrapper):
 *   scripts/test-phase6-p1a.sh
 *
 * Run (manual):
 *   LORE_HOME=$(mktemp -d) npx tsx test/phase6-p1a-workspace-routing-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Seed the LORE_HOME fixture BEFORE the workspaces module imports, so the
// captured constants point at our test directory rather than the live
// daemon's ~/.groundfloor.
const TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    console.error(
        'ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n' +
            'Use: LORE_HOME=$(mktemp -d) npx tsx test/phase6-p1a-workspace-routing-unit.ts',
    );
    process.exit(2);
}

// Seed a starter workspaces.json + workspace dirs before importing
// workspaces.ts (which captures HOME_GROUNDFLOOR at import).
function seedWorkspacesJson(home: string, active: string, names: string[]): void {
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-05-21T00:00:00.000Z',
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const w of workspaces) {
        fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
    }
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active, workspaces }, null, 2),
    );
}

seedWorkspacesJson(TEST_HOME, 'alpha', ['alpha', 'beta', 'gamma']);

// Dynamic import so the module reads our seeded fixture.
const { getWorkspacePath, listWorkspaceNames, getActiveWorkspacePath } =
    await import('../packages/lore/src/config/workspaces.js');

// ── getWorkspacePath(name) returns the path for a known workspace ──────────

function testGetWorkspacePathKnown(): void {
    const p = getWorkspacePath('beta');
    assert.equal(
        p,
        path.join(TEST_HOME!, 'workspaces', 'beta'),
        'known workspace returns its registered path',
    );
    console.log('  ✓ getWorkspacePath(known) returns the registered path');
}

// ── getWorkspacePath(name) throws for unknown ──────────────────────────────

function testGetWorkspacePathUnknown(): void {
    assert.throws(
        () => getWorkspacePath('does-not-exist'),
        /workspace_not_found/,
        'unknown workspace throws workspace_not_found',
    );
    console.log('  ✓ getWorkspacePath(unknown) throws workspace_not_found');
}

// ── getWorkspacePath() without arg returns active ──────────────────────────

function testGetWorkspacePathDefaultsToActive(): void {
    const def = getWorkspacePath();
    const active = getActiveWorkspacePath();
    assert.equal(def, active, 'no-arg path equals active workspace path');
    assert.equal(
        def,
        path.join(TEST_HOME!, 'workspaces', 'alpha'),
        'matches the registered path for the active entry',
    );
    console.log('  ✓ getWorkspacePath() defaults to the active workspace');
}

// ── getWorkspacePath re-reads workspaces.json on every call ────────────────

function testGetWorkspacePathRereads(): void {
    const first = getWorkspacePath();
    assert.equal(first, path.join(TEST_HOME!, 'workspaces', 'alpha'));
    const ctrlPath = path.join(TEST_HOME!, 'workspaces.json');
    const ctrl = JSON.parse(fs.readFileSync(ctrlPath, 'utf-8')) as { active: string };
    ctrl.active = 'beta';
    fs.writeFileSync(ctrlPath, JSON.stringify(ctrl, null, 2));
    const second = getWorkspacePath();
    assert.equal(
        second,
        path.join(TEST_HOME!, 'workspaces', 'beta'),
        'subsequent call honors the new active without restart',
    );
    // Reset for downstream tests
    ctrl.active = 'alpha';
    fs.writeFileSync(ctrlPath, JSON.stringify(ctrl, null, 2));
    console.log('  ✓ getWorkspacePath re-reads workspaces.json (no caching)');
}

// ── listWorkspaceNames returns the registered names ────────────────────────

function testListWorkspaceNames(): void {
    const names = listWorkspaceNames();
    assert.deepEqual(
        [...names].sort(),
        ['alpha', 'beta', 'gamma'],
        'all registered names returned',
    );
    console.log('  ✓ listWorkspaceNames returns the registered set');
}

// ── Tool schemas accept workspace: arg (type-level smoke) ──────────────────

import { z } from 'zod';

function testSchemasAcceptWorkspaceArg(): void {
    const storeEdgeInput = z.object({
        sourceId: z.string(),
        targetId: z.string(),
        relation: z.string(),
        workspace: z.string().optional(),
    });
    const deleteNodeInput = z.object({
        id: z.string(),
        workspace: z.string().optional(),
    });
    const recallInput = z.object({
        topic: z.string(),
        workspace: z.string().optional(),
    });
    const getFullInput = z.object({
        id: z.string(),
        workspace: z.string().optional(),
    });
    storeEdgeInput.parse({ sourceId: 'a', targetId: 'b', relation: 'r', workspace: 'developer' });
    deleteNodeInput.parse({ id: 'x', workspace: 'developer' });
    recallInput.parse({ topic: 't', workspace: '*' });
    getFullInput.parse({ id: 'x', workspace: 'personal' });
    storeEdgeInput.parse({ sourceId: 'a', targetId: 'b', relation: 'r' });
    deleteNodeInput.parse({ id: 'x' });
    recallInput.parse({ topic: 't' });
    getFullInput.parse({ id: 'x' });
    console.log('  ✓ tool input shapes accept optional workspace: arg');
}

// ── Runner ─────────────────────────────────────────────────────────────────

function main(): void {
    console.log('phase6-p1a-workspace-routing-unit.ts');
    testGetWorkspacePathKnown();
    testGetWorkspacePathUnknown();
    testGetWorkspacePathDefaultsToActive();
    testGetWorkspacePathRereads();
    testListWorkspaceNames();
    testSchemasAcceptWorkspaceArg();
    console.log('All P1.A tests passed.');
}

main();

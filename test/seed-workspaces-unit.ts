#!/usr/bin/env tsx
/**
 * seed-workspaces-unit.ts — tests for `lore seed-workspaces` (step #4).
 *
 * Uses dependency-injection to avoid touching the real LORE_HOME.
 *
 * The only seed template today is `personal`. The `developer` seed
 * workspace was dropped once the developer plugin was ported to the
 * standalone Atlas repo.
 *
 * SP-14 (2026-06-10): the plugin system was removed in v3.11.0, so seeding
 * no longer writes a `plugins: [...]` array into config.json (nothing in
 * Core reads it — it was dead, misleading metadata). These tests now assert
 * that the seeded config carries NO `plugins` key, while preserving the
 * workspace creation + idempotency + non-clobber semantics.
 */

import assert from 'node:assert/strict';
import { seedWorkspaces } from '../packages/lore/src/cli/commands/seedWorkspaces.js';
import type { WorkspaceEntry } from '../packages/lore/src/config/workspaces.js';

interface FakeState {
    workspaces: WorkspaceEntry[];
    /** Path → config object. A present key means a config file exists. */
    configsByPath: Map<string, Record<string, unknown>>;
}

function makeDeps(state: FakeState) {
    return {
        loadWorkspaces: () => ({ workspaces: state.workspaces }),
        createWorkspace: (name: string): WorkspaceEntry => {
            const entry = { name, path: `/fake/${name}`, createdAt: '2026-05-09' };
            state.workspaces.push(entry);
            return entry;
        },
        makeConfigManager: (loreDir: string) => ({
            // read() initializes-if-missing in production; mirror that by
            // materializing an empty config object on first touch.
            read: () => {
                if (!state.configsByPath.has(loreDir)) state.configsByPath.set(loreDir, {});
                return state.configsByPath.get(loreDir)!;
            },
            patch: (u: Record<string, unknown>) => {
                const cur = state.configsByPath.get(loreDir) ?? {};
                const next = { ...cur, ...u };
                state.configsByPath.set(loreDir, next);
                return next;
            },
        }),
        configFileExists: (workspacePath: string) =>
            state.configsByPath.has(`${workspacePath}/.lore`),
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('seedWorkspaces');

    await test('fresh: creates the personal seed workspace + config WITHOUT a plugins key', () => {
        const state: FakeState = { workspaces: [], configsByPath: new Map() };
        const r = seedWorkspaces(makeDeps(state));
        assert.deepEqual(r.created.sort(), ['personal']);
        assert.deepEqual(r.skippedExisting, []);
        assert.deepEqual(r.skippedConfigPresent, []);
        const cfg = state.configsByPath.get('/fake/personal/.lore');
        assert.ok(cfg, 'config initialized for the seeded workspace');
        assert.equal('plugins' in cfg!, false, 'SP-14: seeded config has NO plugins key');
    });

    await test('idempotent: second run skips personal when config already present', () => {
        const state: FakeState = {
            workspaces: [{ name: 'personal', path: '/fake/personal', createdAt: 't' }],
            configsByPath: new Map([['/fake/personal/.lore', {}]]),
        };
        const r = seedWorkspaces(makeDeps(state));
        assert.deepEqual(r.created, []);
        assert.deepEqual(r.skippedExisting, []);
        assert.deepEqual(r.skippedConfigPresent.sort(), ['personal']);
    });

    await test('mixed: non-template workspace present, personal missing → only personal created, other untouched', () => {
        const state: FakeState = {
            workspaces: [{ name: 'developer', path: '/fake/developer', createdAt: 't' }],
            configsByPath: new Map([['/fake/developer/.lore', { custom: 'left-alone' }]]),
        };
        const r = seedWorkspaces(makeDeps(state));
        assert.deepEqual(r.created, ['personal']);
        assert.deepEqual(r.skippedExisting, []);
        assert.deepEqual(r.skippedConfigPresent, []);
        // The non-template workspace's config must be left exactly as it was.
        assert.deepEqual(state.configsByPath.get('/fake/developer/.lore'), { custom: 'left-alone' });
    });

    await test('personal exists but no config → config initialized, not skipped-configured', () => {
        const state: FakeState = {
            workspaces: [{ name: 'personal', path: '/fake/personal', createdAt: 't' }],
            configsByPath: new Map(),
        };
        const r = seedWorkspaces(makeDeps(state));
        assert.deepEqual(r.skippedExisting, ['personal']);
        assert.deepEqual(r.created, []);
        const cfg = state.configsByPath.get('/fake/personal/.lore');
        assert.ok(cfg, 'config initialized');
        assert.equal('plugins' in cfg!, false, 'still no plugins key');
    });

    await test('does not overwrite existing user config', () => {
        const state: FakeState = {
            workspaces: [{ name: 'personal', path: '/fake/personal', createdAt: 't' }],
            configsByPath: new Map([['/fake/personal/.lore', { custom: ['a', 'b'] }]]),
        };
        seedWorkspaces(makeDeps(state));
        assert.deepEqual(
            state.configsByPath.get('/fake/personal/.lore'),
            { custom: ['a', 'b'] },
            'should not have clobbered the user config (config already present → skipped)',
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

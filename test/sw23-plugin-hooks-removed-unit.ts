#!/usr/bin/env tsx
/**
 * sw23-plugin-hooks-removed-unit.ts — SW-23 regression.
 *
 * The plugin system was removed in v3.11.0. SW-23 removes the last two
 * dormant plugin-residue surfaces and this suite locks them out so they
 * cannot creep back:
 *
 *   - C3: the `pushPluginData` SyncAdapter hook + its implementations
 *     (tsSdkAdapter / dataplaneGraph) and the "plugin-owned WAL bucket"
 *     drain branch in syncEngine.pushPendingInner. Nothing live feeds it
 *     (no WAL producer declares pluginName/kind).
 *   - C4: the permanently-idle `manifestHotReload` stub field in the
 *     /api/health response.
 *
 * It also pins the SW-02 (B3) safety that survives the C3 removal: an
 * unrecognized WAL op (with OR without a former pluginName field) is
 * retained in the WAL rather than pushed or dropped.
 *
 * These assertions fail on the pre-SW-23 tree and pass after the cleanup.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const srcDir = path.join(repoRoot, 'packages/lore/src');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const read = (rel: string) => fs.readFileSync(path.join(srcDir, rel), 'utf-8');

(async () => {
    console.log('SW-23 — plugin sync hooks + stale health field removed');

    // ── C3: pushPluginData gone from the SyncAdapter contract + impls ──
    await test('C3: SyncAdapter interface no longer declares pushPluginData', () => {
        const src = read('engines/syncEngine.ts');
        assert.ok(
            !/pushPluginData/.test(src),
            'syncEngine.ts must not reference pushPluginData (interface + drain branch removed)',
        );
    });

    await test('C3: tsSdkAdapter has no pushPluginData implementation', () => {
        const src = read('engines/tsSdkAdapter.ts');
        assert.ok(!/pushPluginData/.test(src), 'tsSdkAdapter.ts must not implement pushPluginData');
    });

    await test('C3: dataplaneGraph has no pushPluginData residue', () => {
        const src = read('engines/dataplaneGraph.ts');
        assert.ok(!/pushPluginData/.test(src), 'dataplaneGraph.ts must not reference pushPluginData');
    });

    await test('C3: the plugin-owned WAL bucket drain is gone from pushPending', () => {
        const src = read('engines/syncEngine.ts');
        assert.ok(!/pluginBuckets/.test(src), 'pluginBuckets routing must be removed');
        assert.ok(!/pluginEntryIds/.test(src), 'pluginEntryIds tracking must be removed');
    });

    // ── C3 / SW-02 (B3): the unrecognized-op retention safety still holds ──
    await test('C3/B3: unrecognized ops are still retained in the WAL (never pushed/dropped)', () => {
        const src = read('engines/syncEngine.ts');
        assert.match(
            src,
            /unrecognizedEntryIds/,
            'B3 safety: unrecognized ops must still be tracked and retained in the WAL',
        );
    });

    // ── C4: manifestHotReload health field removed ──
    await test('C4: /api/health response no longer emits manifestHotReload', () => {
        const src = read('mcp/http/routes/diagnostic/health.ts');
        assert.ok(
            !/manifestHotReload/.test(src),
            'health.ts must not emit the manifestHotReload stub field',
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

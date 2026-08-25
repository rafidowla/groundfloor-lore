#!/usr/bin/env tsx
/**
 * sw2122-plugin-residue-unit.ts — SW-21 + SW-22 regression.
 *
 * The plugin system was removed in v3.11.0. This suite locks in the
 * Wave-5 scope-hygiene cleanups so the residue cannot creep back:
 *
 *   - SW-21 / C1: the committed `examples/plugin-manifests/` tree (which
 *     taught users to author plugins the product no longer supports) is
 *     deleted.
 *   - SW-21 / C7: Core's `/status` capability block no longer hardcodes
 *     the Atlas code-intel tool names (`renamedTools`).
 *   - SW-22 / C2: the permanently-inert plugin-gating branch and its
 *     plumbing (`collectAllPluginContributions`, `PluginTypeContribution`,
 *     `BUILTIN_PLUGIN_NAMES`, `allPluginContribs`/`activePluginNames`)
 *     are gone from the store_node write path.
 *
 * These assertions fail on the pre-SW-21/22 tree and pass after the
 * cleanup. SW-23 (pushPluginData / opaque-WAL-bucket draining + the
 * manifestHotReload health field) was subsequently removed too — see
 * sw23-plugin-hooks-removed-unit.ts for that suite.
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
    console.log('SW-21/22 — plugin/Atlas residue removed from Core');

    // ── SW-21 / C1 ──────────────────────────────────────────────────
    await test('examples/plugin-manifests/ no longer exists', () => {
        assert.equal(
            fs.existsSync(path.join(repoRoot, 'examples/plugin-manifests')),
            false,
            'examples/plugin-manifests/ tree must be deleted',
        );
    });

    // ── SW-21 / C7 ──────────────────────────────────────────────────
    await test('Core /status no longer lists Atlas code_* renamedTools', () => {
        const src = read('mcp/tools/diagnostic.ts');
        assert.equal(/renamedTools/.test(src), false, 'renamedTools key must be gone');
        for (const tool of ['code_flow_search', 'code_full_context', 'code_impact', 'code_cypher']) {
            assert.equal(
                src.includes(tool),
                false,
                `diagnostic.ts still hardcodes Atlas tool "${tool}"`,
            );
        }
    });

    // ── SW-22 / C2 ──────────────────────────────────────────────────
    await test('vocabPolicy: plugin-gating plumbing removed', () => {
        const src = read('engines/vocabPolicy.ts');
        for (const sym of [
            'collectAllPluginContributions',
            'PluginTypeContribution',
            'BUILTIN_PLUGIN_NAMES',
            'allPluginContribs',
            'activePluginNames',
            'plugin_inactive',
            'contributingPlugin',
        ]) {
            assert.equal(src.includes(sym), false, `vocabPolicy.ts still references "${sym}"`);
        }
    });

    await test('store_node callers no longer thread empty plugin contributions', () => {
        for (const rel of [
            'mcp/tools/memory/storeNode.ts',
            'mcp/http/routes/storeNodeGates.ts',
        ]) {
            const src = read(rel);
            for (const sym of ['collectAllPluginContributions', 'allPluginContribs', 'activePluginNames']) {
                assert.equal(src.includes(sym), false, `${rel} still references "${sym}"`);
            }
        }
    });

    await test('checkVocab is still exported (vocab gate intact)', async () => {
        const mod = await import('../packages/lore/src/engines/vocabPolicy.js');
        assert.equal(typeof mod.checkVocab, 'function', 'checkVocab must still exist');
        assert.equal(
            typeof (mod as Record<string, unknown>)['collectAllPluginContributions'],
            'undefined',
            'collectAllPluginContributions export must be gone',
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();

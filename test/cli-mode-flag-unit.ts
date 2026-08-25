#!/usr/bin/env tsx
/**
 * cli-mode-flag-unit.ts — parseModeFlag tests for step #3.
 */

import assert from 'node:assert/strict';
import { parseModeFlag } from '../packages/lore/src/cli/modeFlag.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('parseModeFlag');

    await test('no flag → mode=null, args unchanged', () => {
        const r = parseModeFlag(['serve', '--http']);
        assert.equal(r.mode, null);
        assert.deepEqual(r.args, ['serve', '--http']);
        assert.equal(r.error, null);
    });

    await test('--mode=cloud strips flag, sets mode', () => {
        const r = parseModeFlag(['--mode=cloud', 'serve']);
        assert.equal(r.mode, 'cloud');
        assert.deepEqual(r.args, ['serve']);
    });

    await test('--mode local (space form) strips both tokens', () => {
        const r = parseModeFlag(['--mode', 'local', 'status']);
        assert.equal(r.mode, 'local');
        assert.deepEqual(r.args, ['status']);
    });

    await test('-m alias works', () => {
        const r = parseModeFlag(['-m', 'cloud', 'doctor']);
        assert.equal(r.mode, 'cloud');
        assert.deepEqual(r.args, ['doctor']);
    });

    await test('case-insensitive', () => {
        const r = parseModeFlag(['--mode=CLOUD']);
        assert.equal(r.mode, 'cloud');
    });

    await test('invalid value returns error', () => {
        const r = parseModeFlag(['--mode=production']);
        assert.equal(r.mode, null);
        assert.match(r.error ?? '', /must be 'local' or 'cloud'/);
    });

    await test('flag in middle of args still strips', () => {
        const r = parseModeFlag(['serve', '--mode=local', '--http']);
        assert.equal(r.mode, 'local');
        assert.deepEqual(r.args, ['serve', '--http']);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

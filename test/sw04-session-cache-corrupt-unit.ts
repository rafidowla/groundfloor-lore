#!/usr/bin/env tsx
/**
 * sw04-session-cache-corrupt-unit.ts — SW-04 / finding B6 regression.
 *
 * readCacheFromDisk() used to return JSON.parse(...) verbatim. A corrupt
 * hot_session.json (`{}`, an array, a scalar, or a shape whose
 * recent_nodes isn't an array) handed pushNode an object whose
 * `cache.recent_nodes.filter(...)` threw a TypeError — crashing the hot
 * recall/chat path on every write instead of degrading to an empty cache.
 *
 * These tests write each flavour of corruption to disk, then assert that
 * getHotContext() and a subsequent pushNode() degrade to empty rather than
 * throw. Fails on the pre-fix base; passes on the branch.
 *
 * No framework — tsx-run, assert-based, exits non-zero on failure.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SessionCacheManager } from '../packages/lore/src/engines/sessionCacheManager.js';

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => void | Promise<void>) => async () => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`);
        failed++;
    }
};

console.log('SW-04 — session cache guards against corrupt hot_session.json');

/** Build a fresh basePath whose .lore/hot_session.json holds `raw`. */
function seedCorrupt(raw: string): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sw04-'));
    const loreDir = path.join(base, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'hot_session.json'), raw, 'utf-8');
    return base;
}

// Each entry: a label + the raw bytes that would have crashed pushNode.
const corruptions: Array<[string, string]> = [
    ['empty object {}', '{}'],
    ['json array []', '[]'],
    ['populated array', '["a","b"]'],
    ['scalar number', '42'],
    ['json null', 'null'],
    ['recent_nodes is an object', '{"recent_nodes":{"0":"a"}}'],
    ['recent_nodes is a string', '{"recent_nodes":"oops"}'],
    ['unparseable garbage', 'not-json-at-all{{'],
];

for (const [label, raw] of corruptions) {
    await test(`getHotContext degrades to empty for: ${label}`, () => {
        const base = seedCorrupt(raw);
        const cache = new SessionCacheManager(base);
        const snap = cache.getHotContext();
        assert.ok(Array.isArray(snap.recent_nodes), 'recent_nodes must be an array');
        assert.equal(snap.recent_nodes.length, 0, 'corrupt cache must degrade to empty');
    })();

    await test(`pushNode does not throw for: ${label}`, () => {
        const base = seedCorrupt(raw);
        const cache = new SessionCacheManager(base);
        // This is the line that used to throw TypeError on a corrupt file.
        assert.doesNotThrow(() => cache.pushNode('lore:x'));
        const snap = cache.getHotContext();
        assert.deepEqual(snap.recent_nodes, ['lore:x'], 'push must land on the recovered empty cache');
    })();
}

// A valid cache must still round-trip untouched (no over-zealous reset).
await test('valid hot_session.json is preserved', () => {
    const base = seedCorrupt('{"recent_nodes":["lore:a","lore:b"]}');
    const cache = new SessionCacheManager(base);
    assert.deepEqual(cache.getHotContext().recent_nodes, ['lore:a', 'lore:b']);
})();

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed`);
    process.exit(1);
}
console.log(`\nall ${passed} tests passed`);

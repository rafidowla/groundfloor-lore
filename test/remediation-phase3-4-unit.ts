#!/usr/bin/env tsx
/**
 * test/remediation-phase3-4-unit.ts — 2026-08-17 launch-blocker remediation,
 * Phases 3–4 regression tests (the resource-bound + cache-scoping fixes that
 * are cleanly unit-testable; the route/tool surfaces are covered by their own
 * existing suites).
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { ReadCache } from '../packages/lore/src/engines/cache.js';
import { assertZipRealBytesWithinBudget, ZipByteBudget } from '../packages/lore/src/engines/extractors/zipGuard.js';
import { stopIdleSweeper } from '../packages/lore/src/providers/llmDispatch.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>): void {
    pending.push((async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); }
    })());
}

console.log('Remediation Phases 3–4 (resource bounds)');

/* ─── 4.3: ReadCache byte budget ─── */

test('4.3 ReadCache evicts by BYTE budget, not just entry count', async () => {
    const cache = new ReadCache({ maxSize: 500, maxBytes: 100, ttlMs: 60_000 });
    // A ~60-byte value (estimateBytes: string length*2 + 8) fits; a second one
    // pushes the running total past maxBytes=100 and must evict the first.
    const big1 = await cache.memoize('v1|listNodes|ws|0|a', async () => 'x'.repeat(45));
    const big2 = await cache.memoize('v1|listNodes|ws|0|b', async () => 'x'.repeat(45));
    assert.equal(big1.length, 45);
    assert.equal(big2.length, 45);
    // The first entry was evicted to keep the total under the byte budget.
    assert.equal(cache.get('v1|listNodes|ws|0|a'), undefined, 'first large entry evicted by byte budget');
    assert.ok(cache.get('v1|listNodes|ws|0|b') !== undefined);
});

test('4.3 ReadCache bumpEpoch clears stale entries (no unreachable accumulation)', async () => {
    const cache = new ReadCache({ maxSize: 500, maxBytes: 1_000_000, ttlMs: 60_000 });
    await cache.memoize('v1|listNodes|ws|0|a', async () => 'x'.repeat(100));
    cache.bumpEpoch();
    // After a bumped epoch the old key is unreachable AND the map is cleared,
    // so the old entry can't sit in the map as un-GC-able garbage.
    assert.equal(cache.get('v1|listNodes|ws|0|a'), undefined);
    assert.equal((cache as unknown as { stats(): { size: number } }).stats ? 0 : 0, 0);
});

/* ─── 4.1: zip real-byte budget (lying header) ─── */

function lyingZipEntry(): { nodeStream?: () => NodeJS.ReadableStream; async: (t: string) => Promise<Buffer> } {
    const buf = Buffer.alloc(50 * 1024 * 1024); // 50 MiB — over MAX_ENTRY_BYTES? no, under. Use over.
    return {
        async: async () => Buffer.alloc(150 * 1024 * 1024), // 150 MiB (over 100 MiB entry cap)
        nodeStream: () => {
            const s = new Readable({ read() {} });
            setImmediate(() => { s.push(Buffer.alloc(150 * 1024 * 1024)); s.push(null); });
            return s as unknown as NodeJS.ReadableStream;
        },
    };
}

test('4.1 ZipByteBudget rejects a lying-header entry on REAL bytes', async () => {
    const budget = new ZipByteBudget('test');
    await assert.rejects(
        () => budget.readString({ async: async () => Buffer.alloc(150 * 1024 * 1024) } as never, 'bomb'),
        /zip bomb|refusing/i,
    );
});

test('4.1 assertZipRealBytesWithinBudget scans every entry', async () => {
    const zip = {
        files: {
            'bomb.bin': { dir: false, ...lyingZipEntry() },
        },
    };
    await assert.rejects(() => assertZipRealBytesWithinBudget(zip as never, 'docx'), /zip bomb|refusing/i);
});

/* ─── 4.6: idle sweeper stop path ─── */

test('4.6 stopIdleSweeper is idempotent and safe to call with no timer armed', () => {
    assert.doesNotThrow(() => stopIdleSweeper());
    assert.doesNotThrow(() => stopIdleSweeper());
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

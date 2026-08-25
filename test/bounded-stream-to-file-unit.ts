#!/usr/bin/env tsx
/**
 * bounded-stream-to-file-unit.ts — boundedStreamToFile in isolation.
 * Uses synthetic in-memory Readables (no real large files) so the suite
 * stays fast; the "huge/unbounded source" tests prove the abort actually
 * happens early rather than draining the whole thing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { boundedStreamToFile, StreamTooLargeError } from '../packages/lore/src/engines/boundedStreamToFile.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bounded-stream-test-'));
let counter = 0;
const destPath = () => path.join(tmpRoot, `f${counter++}.bin`);

function fixedChunksStream(chunks: Buffer[]): Readable {
    let i = 0;
    return new Readable({
        read() {
            if (i < chunks.length) this.push(chunks[i++]);
            else this.push(null);
        },
    });
}

/** Yields `chunkSize`-byte chunks forever (or up to `hardCap` as a test
 *  safety net) — used to prove abort happens early, not after draining. */
function unboundedStream(chunkSize: number, onPull: () => void, hardCap = 1_000_000): Readable {
    let pulls = 0;
    return new Readable({
        read() {
            pulls++;
            onPull();
            if (pulls > hardCap) { this.push(null); return; }
            this.push(Buffer.alloc(chunkSize, 'x'));
        },
    });
}

console.log('boundedStreamToFile');

await test('a small stream under the limit writes the correct bytes and reports the right size', async () => {
    const data = Buffer.from('hello world');
    const dest = destPath();
    const result = await boundedStreamToFile(fixedChunksStream([data]), dest, 1024);
    assert.equal(result.path, dest);
    assert.equal(result.bytesWritten, data.length);
    assert.deepEqual(fs.readFileSync(dest), data);
});

await test('a stream exactly at the limit resolves (boundary, not rejected)', async () => {
    const data = Buffer.alloc(100, 'a');
    const dest = destPath();
    const result = await boundedStreamToFile(fixedChunksStream([data]), dest, 100);
    assert.equal(result.bytesWritten, 100);
    assert.deepEqual(fs.readFileSync(dest), data);
});

await test('a stream exceeding the limit rejects with StreamTooLargeError and deletes the partial file', async () => {
    const data = Buffer.alloc(200, 'b');
    const dest = destPath();
    await assert.rejects(
        () => boundedStreamToFile(fixedChunksStream([data]), dest, 100),
        StreamTooLargeError,
    );
    assert.equal(fs.existsSync(dest), false, 'the partial file must be cleaned up, not left on disk');
});

await test('multiple small chunks summing over the limit still reject correctly', async () => {
    const chunks = [Buffer.alloc(40, 'c'), Buffer.alloc(40, 'c'), Buffer.alloc(40, 'c')]; // 120 > 100
    const dest = destPath();
    await assert.rejects(() => boundedStreamToFile(fixedChunksStream(chunks), dest, 100), StreamTooLargeError);
    assert.equal(fs.existsSync(dest), false);
});

await test('an effectively-unbounded source is aborted EARLY, not drained to completion', async () => {
    let pulls = 0;
    // 1KB chunks, capped at 10KB → must stop within a small number of pulls,
    // nowhere near the 1,000,000-chunk hard cap the generator would allow.
    const source = unboundedStream(1024, () => { pulls++; });
    const dest = destPath();
    await assert.rejects(() => boundedStreamToFile(source, dest, 10 * 1024), StreamTooLargeError);
    assert.ok(pulls < 50, `expected abort within ~10-15 pulls, got ${pulls} — source was drained instead of aborted`);
    assert.equal(fs.existsSync(dest), false);
});

await test('a source stream error mid-write propagates and cleans up the partial file', async () => {
    const dest = destPath();
    let pushedOnce = false;
    const source = new Readable({
        read() {
            if (pushedOnce) return; // avoid racing the injected error with more pushes
            pushedOnce = true;
            this.push(Buffer.from('partial'));
            process.nextTick(() => this.destroy(new Error('source blew up')));
        },
    });
    await assert.rejects(() => boundedStreamToFile(source, dest, 10 * 1024), /source blew up/);
    assert.equal(fs.existsSync(dest), false);
});

await test('an empty stream resolves with bytesWritten=0 and an empty file', async () => {
    const dest = destPath();
    const result = await boundedStreamToFile(fixedChunksStream([]), dest, 100);
    assert.equal(result.bytesWritten, 0);
    assert.equal(fs.readFileSync(dest).length, 0);
});

await test('many small chunks under the limit complete correctly end-to-end (backpressure path exercised)', async () => {
    const chunkCount = 500;
    const chunks = Array.from({ length: chunkCount }, (_, i) => Buffer.from(`chunk-${i}\n`));
    const expected = Buffer.concat(chunks);
    const dest = destPath();
    const result = await boundedStreamToFile(fixedChunksStream(chunks), dest, expected.length);
    assert.equal(result.bytesWritten, expected.length);
    assert.deepEqual(fs.readFileSync(dest), expected);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

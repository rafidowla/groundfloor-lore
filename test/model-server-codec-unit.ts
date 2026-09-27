#!/usr/bin/env tsx
/**
 * model-server-codec-unit.ts — D9 (3.24 slice C1) wire-protocol codec.
 *
 * Pure unit tests against `packages/lore/src/modelServer/protocol.ts` — no
 * process spawned, no network, no model weights. Covers:
 *   - encodeFrame/FrameDecoder round-trip for a JSON-only and a JSON+binary
 *     frame.
 *   - partial delivery: the same bytes split byte-by-byte and at arbitrary
 *     offsets still decode to the identical frame.
 *   - coalesced delivery: multiple frames concatenated into a single chunk
 *     all decode, in order.
 *   - oversize/malformed frames: `FrameDecoder` emits exactly one `tooLarge`
 *     event per bad frame, keeps the connection's logical stream position
 *     correct (a subsequent well-formed frame still decodes), and — the
 *     memory-safety property D9 §5.2 requires — never buffers the
 *     oversize frame's bytes in full, verified by streaming a
 *     multi-megabyte oversize frame in small chunks and checking process
 *     heap growth stays far below the frame size.
 *   - encodeVectors/decodeVectors round-trip.
 *   - constantTimeEqStr correctness (not timing — just correctness).
 *
 * Run: npx tsx test/model-server-codec-unit.ts
 */

import assert from 'node:assert/strict';
import {
    FrameDecoder,
    encodeFrame,
    encodeVectors,
    decodeVectors,
    constantTimeEqStr,
    MAX_FRAME_BYTES,
} from '../packages/lore/src/modelServer/protocol.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

console.log('model-server codec — protocol.ts unit tests\n');

await test('encodeFrame/FrameDecoder round-trip: JSON-only frame', () => {
    const decoder = new FrameDecoder();
    const header = { type: 'status', id: 'abc123' };
    const buf = encodeFrame(header);
    const events = decoder.push(buf);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'frame');
    assert.deepEqual(events[0]!.kind === 'frame' ? events[0]!.header : undefined, header);
    assert.equal(events[0]!.kind === 'frame' ? events[0]!.body.length : -1, 0);
});

await test('encodeFrame/FrameDecoder round-trip: JSON header + binary body', () => {
    const decoder = new FrameDecoder();
    const header = { type: 'result', id: 'xyz', op: 'query', count: 1, dim: 3 };
    const body = Buffer.from(new Float32Array([1.5, -2.25, 0.0]).buffer);
    const buf = encodeFrame(header, body);
    const events = decoder.push(buf);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'frame');
    if (events[0]!.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(events[0]!.header, header);
    assert.ok(events[0]!.body.equals(body));
});

await test('partial delivery: byte-by-byte still decodes to the identical frame', () => {
    const decoder = new FrameDecoder();
    const header = { type: 'embed', id: 'q1', op: 'query', modelId: 'x', text: 'hello world' };
    const body = Buffer.from('irrelevant-body-bytes');
    const buf = encodeFrame(header, body);
    let lastEvents: ReturnType<FrameDecoder['push']> = [];
    for (let i = 0; i < buf.length; i++) {
        const events = decoder.push(buf.subarray(i, i + 1));
        if (events.length > 0) lastEvents = events;
    }
    assert.equal(lastEvents.length, 1);
    assert.equal(lastEvents[0]!.kind, 'frame');
    if (lastEvents[0]!.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(lastEvents[0]!.header, header);
    assert.ok(lastEvents[0]!.body.equals(body));
});

await test('partial delivery: split at an arbitrary mid-header offset', () => {
    const decoder = new FrameDecoder();
    const header = { type: 'rerank', id: 'r1', modelId: 'm', cacheDir: '/tmp/x', query: 'q', passages: ['a', 'b', 'c'] };
    const buf = encodeFrame(header);
    const cut = Math.floor(buf.length / 2);
    const first = decoder.push(buf.subarray(0, cut));
    assert.equal(first.length, 0, 'a partial frame must not emit any event yet');
    const second = decoder.push(buf.subarray(cut));
    assert.equal(second.length, 1);
    assert.equal(second[0]!.kind, 'frame');
    if (second[0]!.kind !== 'frame') throw new Error('unreachable');
    assert.deepEqual(second[0]!.header, header);
});

await test('coalesced delivery: 3 frames concatenated into one chunk decode in order', () => {
    const decoder = new FrameDecoder();
    const headers = [
        { type: 'status', id: '1' },
        { type: 'status', id: '2' },
        { type: 'status', id: '3' },
    ];
    const chunk = Buffer.concat(headers.map((h) => encodeFrame(h)));
    const events = decoder.push(chunk);
    assert.equal(events.length, 3);
    for (let i = 0; i < 3; i++) {
        // Narrow via a local const, not repeated `events[i]!` — a
        // variable-indexed access doesn't narrow across statements the way
        // a literal index or a plain local does (see the other cases in
        // this file, which use literal indices/locals and narrow fine).
        const ev = events[i]!;
        assert.equal(ev.kind, 'frame');
        if (ev.kind !== 'frame') throw new Error('unreachable');
        assert.deepEqual(ev.header, headers[i]);
    }
});

await test('coalesced delivery: a frame split across a chunk boundary followed by a whole frame in the next chunk', () => {
    const decoder = new FrameDecoder();
    const h1 = { type: 'status', id: 'first' };
    const h2 = { type: 'status', id: 'second' };
    const buf1 = encodeFrame(h1);
    const buf2 = encodeFrame(h2);
    const combined = Buffer.concat([buf1, buf2]);
    const cut = buf1.length + 2; // split partway into the second frame
    const firstChunkEvents = decoder.push(combined.subarray(0, cut));
    assert.equal(firstChunkEvents.length, 1, 'only the first, fully-delivered frame should emit');
    assert.deepEqual(firstChunkEvents[0]!.kind === 'frame' ? firstChunkEvents[0]!.header : undefined, h1);
    const secondChunkEvents = decoder.push(combined.subarray(cut));
    assert.equal(secondChunkEvents.length, 1);
    assert.deepEqual(secondChunkEvents[0]!.kind === 'frame' ? secondChunkEvents[0]!.header : undefined, h2);
});

await test('oversize frame: emits exactly one tooLarge event, then a subsequent valid frame still decodes', () => {
    const decoder = new FrameDecoder();
    const oversizeHeader = { type: 'embed', id: 'huge', op: 'documentBatch', modelId: 'x', texts: ['a'] };
    const hugeBody = Buffer.alloc(MAX_FRAME_BYTES + 1024, 0x41);
    const oversizeBuf = encodeFrame(oversizeHeader, hugeBody);
    const validHeader = { type: 'status', id: 'after-oversize' };
    const validBuf = encodeFrame(validHeader);

    const events1 = decoder.push(oversizeBuf);
    const tooLarge = events1.filter((e) => e.kind === 'tooLarge');
    assert.equal(tooLarge.length, 1, 'exactly one tooLarge event for the one oversize frame');
    assert.equal(events1.filter((e) => e.kind === 'frame').length, 0);

    const events2 = decoder.push(validBuf);
    assert.equal(events2.length, 1);
    assert.equal(events2[0]!.kind, 'frame');
    assert.deepEqual(events2[0]!.kind === 'frame' ? events2[0]!.header : undefined, validHeader);
});

await test('oversize frame: never buffered in full — streaming a declared-huge (> MAX_FRAME_BYTES) frame in small chunks keeps heap growth far below the declared size', () => {
    const decoder = new FrameDecoder();
    // A header claiming a body well ABOVE MAX_FRAME_BYTES (so the decoder's
    // skip-and-discard path is actually exercised — a declared size under
    // the cap is a legitimate large-but-allowed frame and is buffered
    // normally, which is what the earlier, now-fixed version of this test
    // incorrectly exercised). We only ever hand the decoder a small
    // fraction of that declared length, in small reused-buffer chunks, and
    // never supply anywhere near the full (fictitious) body — proving the
    // decoder tracks a byte countdown rather than accumulating a buffer.
    const declaredBodyLen = 500 * 1024 * 1024; // 500MB, comfortably > MAX_FRAME_BYTES (64MB)
    const header = { type: 'embed', id: 'stream-huge', op: 'query', modelId: 'x', text: 'y' };
    const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
    const headerLenBuf = Buffer.alloc(4);
    headerLenBuf.writeUInt32BE(headerJson.length, 0);
    const totalLen = 4 + headerJson.length + declaredBodyLen;
    const totalLenBuf = Buffer.alloc(4);
    totalLenBuf.writeUInt32BE(totalLen, 0);
    const prefix = Buffer.concat([totalLenBuf, headerLenBuf, headerJson]);

    const events0 = decoder.push(prefix);
    assert.equal(events0.length, 1, 'totalLen alone (readable from the first 4 bytes) is enough to reject an over-cap frame immediately');
    assert.equal(events0[0]!.kind, 'tooLarge');

    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;

    // Stream only a small slice (10MB) of the declared 500MB body, via one
    // reused chunk buffer, and confirm the decoder stays in the (silent)
    // skip state — no further tooLarge/frame events until the declared
    // length is actually exhausted, which we deliberately never reach.
    const chunkSize = 65536;
    const bodyChunk = Buffer.alloc(chunkSize, 0x42);
    const bytesToStream = 10 * 1024 * 1024; // far less than declaredBodyLen
    let sent = 0;
    let extraEvents = 0;
    while (sent < bytesToStream) {
        extraEvents += decoder.push(bodyChunk).length;
        sent += chunkSize;
    }
    assert.equal(extraEvents, 0, 'no further events should fire while still mid-skip on a single oversize frame');

    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    const grew = after - before;
    assert.ok(
        grew < 5 * 1024 * 1024,
        `heap grew by ${grew} bytes while streaming ${bytesToStream} bytes of a declared ${declaredBodyLen}-byte oversize frame — decoder appears to be buffering instead of discarding`,
    );
});

await test('encodeVectors/decodeVectors round-trip preserves exact float32 bits', () => {
    const vecs = [
        [1.5, -2.25, 0.0, 3.140625],
        [0.1015625, -0.1015625, 100.5, -100.5],
    ];
    const body = encodeVectors(vecs);
    const decoded = decodeVectors(body, vecs.length, vecs[0]!.length);
    assert.deepEqual(decoded, vecs);
});

await test('encodeVectors/decodeVectors: empty vector list', () => {
    const body = encodeVectors([]);
    const decoded = decodeVectors(body, 0, 0);
    assert.deepEqual(decoded, []);
});

await test('constantTimeEqStr: equal strings', () => {
    assert.equal(constantTimeEqStr('abc123', 'abc123'), true);
});

await test('constantTimeEqStr: different strings, same length', () => {
    assert.equal(constantTimeEqStr('abc123', 'abc124'), false);
});

await test('constantTimeEqStr: different lengths', () => {
    assert.equal(constantTimeEqStr('short', 'much-longer-string'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * test/extractors/video.test.ts
 *
 * Unit tests for the video extractor's pure helper functions and
 * registry wiring. Tests that require ffmpeg / Ollama are skipped —
 * those are covered by manual integration testing.
 *
 * Run: tsx test/extractors/video.test.ts
 */

import * as assert from 'node:assert/strict';
import { parseSrt, segmentsNear, formatTime } from '../../packages/lore/src/engines/extractors/video.js';
import { buildDefaultRegistry } from '../../packages/lore/src/engines/extractors/index.js';
import { ExtractorError } from '../../packages/lore/src/engines/extractors/types.js';

// ── formatTime ────────────────────────────────────────────────────────────

function testFormatTime(): void {
    assert.equal(formatTime(0),    '0:00', 'zero');
    assert.equal(formatTime(59),   '0:59', 'under one minute');
    assert.equal(formatTime(60),   '1:00', 'exactly one minute');
    assert.equal(formatTime(61),   '1:01', 'one minute one second');
    assert.equal(formatTime(125),  '2:05', 'two minutes five seconds');
    assert.equal(formatTime(3600), '60:00', 'one hour');
    assert.equal(formatTime(3661), '61:01', 'over one hour');
    // Fractional seconds are floored
    assert.equal(formatTime(90.9), '1:30', 'fractional seconds floored');
    console.log('  ✓ formatTime');
}

// ── parseSrt ──────────────────────────────────────────────────────────────

function testParseSrtBasic(): void {
    const srt = `1
00:00:00,000 --> 00:00:03,500
Welcome to 123 Main Street.

2
00:00:03,500 --> 00:00:07,200
This is the main living area.
`;
    const segs = parseSrt(srt);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].start, 0);
    assert.equal(segs[0].end, 3.5);
    assert.equal(segs[0].text, 'Welcome to 123 Main Street.');
    assert.equal(segs[1].start, 3.5);
    assert.equal(segs[1].end, 7.2);
    assert.equal(segs[1].text, 'This is the main living area.');
    console.log('  ✓ parseSrt basic');
}

function testParseSrtMultiLine(): void {
    const srt = `1
00:00:05,000 --> 00:00:09,000
First line of dialogue.
Second line of dialogue.

`;
    const segs = parseSrt(srt);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].text, 'First line of dialogue. Second line of dialogue.');
    console.log('  ✓ parseSrt multi-line text joined');
}

function testParseSrtTimestampMath(): void {
    const srt = `1
01:30:45,250 --> 01:30:48,750
Deep into a long video.

`;
    const segs = parseSrt(srt);
    assert.equal(segs.length, 1);
    // 1h 30m 45s 250ms = 5445.25
    assert.equal(segs[0].start, 5445.25);
    // 1h 30m 48s 750ms = 5448.75
    assert.equal(segs[0].end, 5448.75);
    console.log('  ✓ parseSrt hour-level timestamps');
}

function testParseSrtEmpty(): void {
    assert.deepEqual(parseSrt(''), []);
    assert.deepEqual(parseSrt('\n\n\n'), []);
    console.log('  ✓ parseSrt empty / whitespace-only');
}

function testParseSrtMalformed(): void {
    // Blocks with no valid timestamp line are skipped
    const srt = `1
not a timestamp
Some text.

2
00:00:10,000 --> 00:00:12,000
Valid segment.
`;
    const segs = parseSrt(srt);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].text, 'Valid segment.');
    console.log('  ✓ parseSrt skips malformed blocks');
}

// ── segmentsNear ──────────────────────────────────────────────────────────

function testSegmentsNear(): void {
    const segs = [
        { start: 0,    end: 3,    text: 'Welcome.' },
        { start: 3,    end: 7,    text: 'Main living area.' },
        { start: 7,    end: 12,   text: 'Kitchen with island.' },
        { start: 12,   end: 18,   text: 'Primary bedroom.' },
    ];

    // Window exactly covering first segment
    assert.equal(segmentsNear(segs, 0, 3), 'Welcome.');

    // Window covering first two segments
    assert.equal(segmentsNear(segs, 0, 7), 'Welcome. Main living area.');

    // Window at boundary — segment touching at end boundary is excluded
    // (filter: start < to && end > from)
    assert.equal(segmentsNear(segs, 3, 7), 'Main living area.');

    // Window straddling two segments
    assert.equal(segmentsNear(segs, 5, 10), 'Main living area. Kitchen with island.');

    // No overlap
    assert.equal(segmentsNear(segs, 20, 25), '');

    // Single-point window returns nothing (start === end means degenerate range)
    assert.equal(segmentsNear(segs, 3, 3), '');

    console.log('  ✓ segmentsNear');
}

// ── Registry wiring ───────────────────────────────────────────────────────

function testRegistryWiring(): void {
    const registry = buildDefaultRegistry();

    const videoExts = ['.mp4', '.mov', '.mkv', '.avi', '.m4v'];
    for (const ext of videoExts) {
        const mime = registry.mimeFromPath(`test${ext}`);
        assert.ok(mime?.startsWith('video/'), `${ext} → expected video/* MIME, got ${mime}`);
    }

    // Extractor is registered for video/mp4
    const extractor = registry.findByMime('video/mp4');
    assert.ok(extractor !== null, 'video/mp4 extractor should be registered');
    assert.equal(extractor?.name, 'video');

    console.log('  ✓ registry wiring — video MIME types and extractor');
}

// ── Empty buffer ──────────────────────────────────────────────────────────

async function testEmptyBuffer(): Promise<void> {
    const registry = buildDefaultRegistry();
    const extractor = registry.findByMime('video/mp4');
    assert.ok(extractor, 'extractor must be registered');
    await assert.rejects(
        () => extractor.extract(Buffer.alloc(0), 'video/mp4'),
        (err: unknown) => {
            assert.ok(err instanceof ExtractorError, 'should throw ExtractorError');
            assert.equal((err as ExtractorError).code, 'empty');
            return true;
        },
    );
    console.log('  ✓ empty buffer throws ExtractorError(empty)');
}

// ── Runner ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('video extractor tests');

    console.log('\nformatTime');
    testFormatTime();

    console.log('\nparseSrt');
    testParseSrtBasic();
    testParseSrtMultiLine();
    testParseSrtTimestampMath();
    testParseSrtEmpty();
    testParseSrtMalformed();

    console.log('\nsegmentsNear');
    testSegmentsNear();

    console.log('\nregistry');
    testRegistryWiring();

    console.log('\nextractor contract');
    await testEmptyBuffer();

    console.log('\nAll video extractor tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

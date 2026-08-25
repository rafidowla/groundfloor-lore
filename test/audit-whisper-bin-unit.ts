#!/usr/bin/env tsx
/**
 * audit-whisper-bin-unit.ts — deep-audit 2026-06-25 (LOW, PATH ambiguity).
 *
 * The audio + video extractors each resolved the whisper.cpp CLI by a bare PATH
 * `which` lookup over ['whisper','whisper-cpp','main'] — the generic 'main' name
 * could resolve to an unrelated executable earlier in PATH. The probe is now a
 * single shared module that prefers an explicit LORE_WHISPER_BIN, falling back
 * to the PATH lookup. A configured path is honored only if it exists.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findWhisperBin, _resetWhisperBinForTest } from '../packages/lore/src/engines/extractors/whisperBin.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

function withEnv(value: string | undefined, fn: () => void): void {
    const prev = process.env['LORE_WHISPER_BIN'];
    if (value === undefined) delete process.env['LORE_WHISPER_BIN'];
    else process.env['LORE_WHISPER_BIN'] = value;
    _resetWhisperBinForTest();
    try { fn(); }
    finally {
        if (prev === undefined) delete process.env['LORE_WHISPER_BIN'];
        else process.env['LORE_WHISPER_BIN'] = prev;
        _resetWhisperBinForTest();
    }
}

console.log('AUDIT whisper-bin — explicit LORE_WHISPER_BIN preferred over PATH lookup');

test('an existing LORE_WHISPER_BIN path is used directly (no PATH ambiguity)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-whisper-'));
    const binPath = path.join(dir, 'my-whisper');
    fs.writeFileSync(binPath, '#!/bin/sh\n');
    try {
        withEnv(binPath, () => assert.equal(findWhisperBin(), binPath));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a missing LORE_WHISPER_BIN path is ignored (falls back to PATH lookup)', () => {
    const bogus = path.join(os.tmpdir(), 'definitely-not-a-real-whisper-xyz');
    withEnv(bogus, () => {
        const r = findWhisperBin();
        // r is whatever PATH yields (a real whisper or null) — but never the bogus path.
        assert.notEqual(r, bogus, 'a configured-but-missing path must not be used');
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

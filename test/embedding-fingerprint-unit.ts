#!/usr/bin/env tsx
/**
 * embedding-fingerprint-unit.ts — Q2.2 follow-up to slice 7.
 *
 * Locks the contract for the embedding-model fingerprint sidecar that
 * gates the `lore migrate embedding-model` flow:
 *
 *   1. readFingerprint() returns null when the file is missing.
 *   2. readFingerprintOrLegacy() returns the MiniLM/384 default when
 *      the file is missing — pre-fingerprint installs.
 *   3. writeFingerprint() persists a JSON file with modelId, dimension,
 *      writtenAt (ISO), version. It is ATOMIC (rename-from-tmp) so a
 *      kill-9 mid-write doesn't leave a half-written JSON.
 *   4. checkCompatibility() flags model-only mismatches AND dimension
 *      mismatches with distinct messages — the dim case includes the
 *      dim flag in the suggested CLI command.
 *   5. The fingerprint round-trips: write → read returns identical
 *      modelId + dimension.
 *
 * No LanceDB / HF model load involved — this test runs in <50ms.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    readFingerprint,
    readFingerprintOrLegacy,
    writeFingerprint,
    checkCompatibility,
    getFingerprintPath,
    _deleteFingerprintForTests,
} from '../packages/lore/src/engines/embeddingFingerprint.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
    try {
        fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        fail++;
        failures.push(`${name}: ${(err as Error).message}`);
        console.log(`  ✗ ${name}: ${(err as Error).message}`);
    }
}

function freshBase(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-fp-test-'));
    fs.mkdirSync(path.join(dir, '.lore', 'lancedb'), { recursive: true });
    return dir;
}

console.log('embedding-fingerprint-unit\n');

test('readFingerprint returns null when file is missing', () => {
    const base = freshBase();
    const fp = readFingerprint(base);
    assert.equal(fp, null);
});

test('readFingerprintOrLegacy returns MiniLM/384 default when file is missing', () => {
    const base = freshBase();
    const fp = readFingerprintOrLegacy(base);
    assert.equal(fp.modelId, 'Xenova/all-MiniLM-L6-v2');
    assert.equal(fp.dimension, 384);
    assert.equal(typeof fp.writtenAt, 'string');
});

test('writeFingerprint round-trips through readFingerprint', () => {
    const base = freshBase();
    writeFingerprint(base, { modelId: 'Xenova/multilingual-e5-small', dimension: 384 });
    const fp = readFingerprint(base);
    assert.notEqual(fp, null);
    assert.equal(fp!.modelId, 'Xenova/multilingual-e5-small');
    assert.equal(fp!.dimension, 384);
    // writtenAt is an ISO 8601 timestamp
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(fp!.writtenAt));
    assert.equal(typeof fp!.version, 'number');
});

test('writeFingerprint is atomic (no leftover .tmp file on success)', () => {
    const base = freshBase();
    writeFingerprint(base, { modelId: 'BAAI/bge-m3', dimension: 1024 });
    const dir = path.dirname(getFingerprintPath(base));
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, [], `unexpected tmp files: ${leftovers.join(', ')}`);
});

test('writeFingerprint stores file with mode 0600', () => {
    const base = freshBase();
    writeFingerprint(base, { modelId: 'BAAI/bge-m3', dimension: 1024 });
    const stat = fs.statSync(getFingerprintPath(base));
    // Lower 9 bits of mode are the permission bits.
    const perms = stat.mode & 0o777;
    assert.equal(perms, 0o600, `expected 0600, got ${perms.toString(8)}`);
});

test('checkCompatibility: legacy default matches MiniLM/384', () => {
    const base = freshBase();
    const r = checkCompatibility(base, { modelId: 'Xenova/all-MiniLM-L6-v2', dimension: 384 });
    assert.equal(r.matches, true);
    assert.equal(r.message, '');
});

test('checkCompatibility: same-dim model swap reports model-only mismatch', () => {
    const base = freshBase();
    writeFingerprint(base, { modelId: 'Xenova/all-MiniLM-L6-v2', dimension: 384 });
    const r = checkCompatibility(base, { modelId: 'Xenova/multilingual-e5-small', dimension: 384 });
    assert.equal(r.matches, false);
    assert.match(r.message, /Same dimension, different model/);
    assert.match(r.message, /lore migrate embedding-model --to "Xenova\/multilingual-e5-small"/);
    // Should NOT include --dim flag in the suggestion since dims match.
    assert.doesNotMatch(r.message, /--dim/);
});

test('checkCompatibility: cross-dim swap reports dimension mismatch with --dim flag', () => {
    const base = freshBase();
    writeFingerprint(base, { modelId: 'Xenova/all-MiniLM-L6-v2', dimension: 384 });
    const r = checkCompatibility(base, { modelId: 'BAAI/bge-m3', dimension: 1024 });
    assert.equal(r.matches, false);
    assert.match(r.message, /Vector dimension differs/);
    assert.match(r.message, /--dim 1024/);
    assert.match(r.message, /lore migrate embedding-model --to "BAAI\/bge-m3"/);
});

test('readFingerprint throws on corrupted JSON', () => {
    const base = freshBase();
    const fp = getFingerprintPath(base);
    fs.writeFileSync(fp, '{ not valid json');
    assert.throws(() => readFingerprint(base), /Corrupt fingerprint/);
});

test('readFingerprint throws on malformed JSON (missing fields)', () => {
    const base = freshBase();
    const fp = getFingerprintPath(base);
    fs.writeFileSync(fp, JSON.stringify({ modelId: 'x' /* missing dimension + writtenAt */ }));
    assert.throws(() => readFingerprint(base), /Malformed fingerprint/);
});

test('_deleteFingerprintForTests removes the file', () => {
    const base = freshBase();
    writeFingerprint(base, { modelId: 'x', dimension: 1 });
    assert.ok(fs.existsSync(getFingerprintPath(base)));
    _deleteFingerprintForTests(base);
    assert.equal(fs.existsSync(getFingerprintPath(base)), false);
    // Should be safe to call when file is missing.
    _deleteFingerprintForTests(base);
});

console.log('');
console.log(`Total: ${pass + fail}, Passed: ${pass}, Failed: ${fail}`);
if (fail > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
process.exit(0);

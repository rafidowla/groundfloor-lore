#!/usr/bin/env tsx
/**
 * save-ingestion-roots-unit.ts — pins saveExtraIngestionRoots() behavior
 * for the Settings → Connectors → Filesystem UI shipped 2026-05-14.
 *
 * Asserts:
 *  - absolute paths round-trip
 *  - non-absolute paths are rejected
 *  - NUL bytes are rejected
 *  - empty strings are dropped silently
 *  - duplicates are deduplicated
 *  - file is written atomically (tmp + rename — no partial state on crash)
 *  - file mode is 0600
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    loadExtraIngestionRoots,
    saveExtraIngestionRoots,
} from '../packages/lore/src/security/pathAllowlist.js';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-roots-'));
}
function cleanup(d: string): void {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
}

let passed = 0, failed = 0;
const test = (name: string, fn: () => void): void => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

console.log('saveExtraIngestionRoots');

test('absolute paths round-trip', () => {
    const tmp = mkTmp();
    try {
        saveExtraIngestionRoots(tmp, ['/Users/a/Notes', '/Users/a/Docs']);
        assert.deepEqual(loadExtraIngestionRoots(tmp), ['/Users/a/Notes', '/Users/a/Docs']);
    } finally { cleanup(tmp); }
});

test('non-absolute paths are rejected', () => {
    const tmp = mkTmp();
    try {
        assert.throws(() => saveExtraIngestionRoots(tmp, ['relative/path']));
        assert.throws(() => saveExtraIngestionRoots(tmp, ['./local']));
        assert.throws(() => saveExtraIngestionRoots(tmp, ['foo']));
    } finally { cleanup(tmp); }
});

test('NUL bytes are rejected', () => {
    const tmp = mkTmp();
    try {
        assert.throws(() => saveExtraIngestionRoots(tmp, ['/foo\0bar']));
    } finally { cleanup(tmp); }
});

test('empty + whitespace-only entries are dropped silently', () => {
    const tmp = mkTmp();
    try {
        saveExtraIngestionRoots(tmp, ['', '   ', '/Users/a/Real']);
        assert.deepEqual(loadExtraIngestionRoots(tmp), ['/Users/a/Real']);
    } finally { cleanup(tmp); }
});

test('duplicates are deduped', () => {
    const tmp = mkTmp();
    try {
        saveExtraIngestionRoots(tmp, ['/a', '/b', '/a', '/b', '/c']);
        assert.deepEqual(loadExtraIngestionRoots(tmp), ['/a', '/b', '/c']);
    } finally { cleanup(tmp); }
});

test('written via tmp + rename (no .tmp file lingers)', () => {
    const tmp = mkTmp();
    try {
        saveExtraIngestionRoots(tmp, ['/a']);
        const entries = fs.readdirSync(tmp);
        assert.ok(entries.includes('ingestion.json'));
        assert.ok(!entries.some(e => e.endsWith('.tmp')), 'tmp file should be renamed away, not left behind');
    } finally { cleanup(tmp); }
});

test('file mode is 0600', () => {
    const tmp = mkTmp();
    try {
        saveExtraIngestionRoots(tmp, ['/a']);
        const mode = fs.statSync(path.join(tmp, 'ingestion.json')).mode & 0o777;
        assert.equal(mode, 0o600);
    } finally { cleanup(tmp); }
});

test('replacing the roots list is atomic — old entries gone, new entries present', () => {
    const tmp = mkTmp();
    try {
        saveExtraIngestionRoots(tmp, ['/old1', '/old2']);
        saveExtraIngestionRoots(tmp, ['/new1']);
        assert.deepEqual(loadExtraIngestionRoots(tmp), ['/new1']);
    } finally { cleanup(tmp); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

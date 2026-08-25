#!/usr/bin/env tsx
/**
 * sw12-version-source-unit.ts — SW-12 unit tests (2026-06-13).
 *
 * Verifies that VERSION is sourced from package.json and that the three
 * files that previously hardcoded version strings now import VERSION
 * rather than embedding a quoted x.y.z literal.
 *
 * Tests:
 *   VERSION matches package.json  — runtime value equals the `version`
 *                                   field in the repo's package.json
 *   createMcpServer.ts            — uses VERSION, not '1.0.0'
 *   health.ts                     — uses VERSION, not '3.11.0' (two spots)
 *   metrics.ts                    — uses VERSION, not '3.9.0'
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../packages/lore/src/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void | Promise<void>) => {
    const result = (() => { try { return fn(); } catch (e) { return Promise.reject(e); } })();
    if (result instanceof Promise) {
        result.then(() => { passed++; console.log(`  ✓ ${name}`); })
              .catch((e) => { failed++; console.error(`  ✗ ${name}: ${(e as Error).message}`); });
    } else {
        passed++;
        console.log(`  ✓ ${name}`);
    }
};

/* ─── helpers ─────────────────────────────────────────────────────── */

/** Read a source file relative to the repo root. */
function readSrc(relPath: string): string {
    return fs.readFileSync(path.resolve(__dirname, '..', relPath), 'utf-8');
}

/** Detect a bare hardcoded version literal of the form 'x.y.z' (semver). */
const HARDCODED_VERSION_RE = /['"](\d+\.\d+\.\d+)['"]/g;

/* ─── VERSION constant ─────────────────────────────────────────────── */

console.log('\n─── VERSION constant ───');

test('VERSION is a non-empty string', () => {
    assert.ok(typeof VERSION === 'string' && VERSION.length > 0,
        `Expected non-empty string, got: ${JSON.stringify(VERSION)}`);
});

test('VERSION matches package.json version field', () => {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    assert.equal(VERSION, pkg.version,
        `VERSION="${VERSION}" does not match package.json version="${pkg.version}"`);
});

/* ─── createMcpServer.ts ───────────────────────────────────────────── */

console.log('\n─── createMcpServer.ts ───');

test('createMcpServer.ts imports VERSION from version.js', () => {
    const src = readSrc('packages/lore/src/mcp/createMcpServer.ts');
    assert.ok(src.includes("from '../version.js'") || src.includes('from "../version.js"'),
        'Expected import of VERSION from ../version.js');
});

test('createMcpServer.ts does not hardcode version \'1.0.0\'', () => {
    const src = readSrc('packages/lore/src/mcp/createMcpServer.ts');
    assert.ok(!src.includes("'1.0.0'") && !src.includes('"1.0.0"'),
        'Found hardcoded version literal \'1.0.0\' — should use VERSION');
});

test('createMcpServer.ts uses VERSION in McpServer constructor', () => {
    const src = readSrc('packages/lore/src/mcp/createMcpServer.ts');
    assert.ok(src.includes('version: VERSION'),
        'Expected `version: VERSION` in McpServer constructor call');
});

/* ─── health.ts ────────────────────────────────────────────────────── */

console.log('\n─── health.ts ───');

test('health.ts imports VERSION from version.js', () => {
    const src = readSrc('packages/lore/src/mcp/http/routes/diagnostic/health.ts');
    assert.ok(src.includes("from '../../../../version.js'") || src.includes('from "../../../../version.js"'),
        'Expected import of VERSION from ../../../../version.js');
});

test('health.ts does not hardcode version \'3.11.0\'', () => {
    const src = readSrc('packages/lore/src/mcp/http/routes/diagnostic/health.ts');
    assert.ok(!src.includes("'3.11.0'") && !src.includes('"3.11.0"'),
        'Found hardcoded version literal \'3.11.0\' — should use VERSION');
});

test('health.ts uses VERSION in both health response objects', () => {
    const src = readSrc('packages/lore/src/mcp/http/routes/diagnostic/health.ts');
    const matches = src.match(/version: VERSION/g);
    assert.ok(matches && matches.length >= 2,
        `Expected at least 2 occurrences of 'version: VERSION', found: ${matches?.length ?? 0}`);
});

/* ─── metrics.ts ───────────────────────────────────────────────────── */

console.log('\n─── metrics.ts ───');

test('metrics.ts imports VERSION from version.js', () => {
    const src = readSrc('packages/lore/src/mcp/http/routes/metrics.ts');
    assert.ok(src.includes("from '../../../version.js'") || src.includes('from "../../../version.js"'),
        'Expected import of VERSION from ../../../version.js');
});

test('metrics.ts does not hardcode version \'3.9.0\'', () => {
    const src = readSrc('packages/lore/src/mcp/http/routes/metrics.ts');
    assert.ok(!src.includes("'3.9.0'") && !src.includes('"3.9.0"'),
        'Found hardcoded version literal \'3.9.0\' — should use VERSION');
});

test('metrics.ts assigns VERSION to BUILD_VERSION constant', () => {
    const src = readSrc('packages/lore/src/mcp/http/routes/metrics.ts');
    assert.ok(src.includes('BUILD_VERSION = VERSION'),
        'Expected `BUILD_VERSION = VERSION` assignment');
});

/* ─── Summary ──────────────────────────────────────────────────────── */

setImmediate(() => {
    setTimeout(() => {
        console.log(`\n─── Summary: ${passed}/${passed + failed} passed ───`);
        if (failed > 0) process.exit(1);
    }, 100);
});

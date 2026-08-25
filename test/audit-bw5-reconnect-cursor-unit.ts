#!/usr/bin/env tsx
/**
 * audit-bw5-reconnect-cursor-unit.ts — re-audit 2026-06-25 (MEDIUM, bug).
 *
 * The /reconnect route read+wrote the incremental since-cursor from
 * deps.graphBasePath (BOOT), not the requested workspace, even after resolving
 * the requested workspace's graph. So workspace B's incremental reconnect read
 * boot's cursor (wrong skip) and clobbered boot's cursor on write. The route now
 * resolves cursorRoot = getWorkspacePath(reconnectWs) and uses it for both
 * readCursor and writeCursor.
 *
 * This pins the property the fix relies on: the cursor store is isolated by
 * workspace root — a cursor written under one root is invisible under another —
 * so routing per-workspace roots yields per-workspace cursors. (Under the old
 * boot-path routing every workspace shared one cursor.)
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCursor, writeCursor } from '../packages/lore/src/engines/reconnectCursor.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

const stats = { candidatesScanned: 1, embeddingsAdded: 0, embeddingsSkipped: 0, coreEdgesInserted: 0 };

console.log('BW-5 — reconnect cursor is isolated per workspace root');

test('a cursor written under workspace A is invisible under workspace B', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bw5-A-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bw5-B-'));
    try {
        assert.equal(readCursor(rootA), null, 'A starts with no cursor');
        assert.equal(readCursor(rootB), null, 'B starts with no cursor');
        writeCursor(rootA, 'full', stats);
        // A now has a cursor; B must still have NONE (no cross-workspace leak).
        assert.ok(readCursor(rootA)?.lastReconnectAt, 'A has its own cursor after write');
        assert.equal(readCursor(rootB), null, "B must NOT see A's cursor (isolated by root)");
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
    }
});

test('writing B does not overwrite A — the two cursors are independent', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bw5-A-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bw5-B-'));
    try {
        writeCursor(rootA, 'full', stats);
        const aBefore = readCursor(rootA)?.lastReconnectAt;
        writeCursor(rootB, 'incremental', stats);
        const aAfter = readCursor(rootA)?.lastReconnectAt;
        assert.equal(aAfter, aBefore, "writing B's cursor must not clobber A's");
        assert.ok(readCursor(rootB)?.lastReconnectAt, 'B has its own cursor');
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

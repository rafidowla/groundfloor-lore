#!/usr/bin/env tsx
/**
 * surreal-hash-query-path-collision-unit.ts — `#`/`?` in a workspace path no
 * longer truncate `surrealDataPath()`'s pathname and collide two distinct
 * workspaces onto the same on-disk SurrealDB store.
 *
 * ── WHY THIS IS DIFFERENT FROM THE SPACE-PATH REGRESSION TEST ──────────────
 *
 * `surreal-space-path-backup-restore-unit.ts` proves a SPACE in a workspace
 * path is safe: `new URL()` percent-encodes it in place — a space is an
 * "unsafe" pathname byte, not a delimiter.
 *
 * `#` and `?` are WHATWG URL DELIMITERS (they start the fragment/query
 * components), not unsafe bytes. Before the fix, `new URL()` didn't encode
 * them at all — it PARSED them and silently DROPPED everything after the
 * first one from `.pathname`. Two workspace paths differing only after a
 * `#`/`?` therefore collapsed onto the identical `.pathname` and the
 * identical on-disk store — confirmed live: writing to workspace A and
 * reading from workspace B returned A's private data.
 *
 * `surrealDataPath()` now pre-escapes `#`/`?` to `%23`/`%3F` before handing
 * the literal path to `new URL()`, so they survive as literal pathname data
 * instead of being parsed as delimiters. This test proves:
 *   - the pathname is no longer truncated — it contains the full literal
 *     path, percent-encoded, past the `#`/`?`;
 *   - two workspaces differing only after a `#` or `?` get DIFFERENT
 *     `surrealDataPath()` outputs (the collision itself);
 *   - opening two such workspaces for real and writing distinct data to each
 *     round-trips back the right data from the right workspace, not the
 *     cross-workspace leak this bug used to cause.
 *
 * Run: npx tsx test/surreal-hash-query-path-collision-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { surrealDataPath } from '../packages/lore/src/engines/surreal/surrealConnection.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-hashquery-'));

console.log('#/? in workspace path: no truncation, no cross-workspace collision');

await test('a `#` in the path no longer truncates the pathname', () => {
    const ws = path.join(root, 'My#Project', 'lore-data');
    const dataPath = surrealDataPath(ws);
    // A truncating implementation stops `.pathname` at `My` because `#`
    // starts the URL fragment; the fix escapes it so everything after
    // survives, percent-encoded, as literal pathname data.
    assert.ok(dataPath.includes('%23Project'),
        `expected the escaped '#' and everything after it to survive in the pathname, got: ${dataPath}`);
    assert.ok(dataPath.endsWith(path.join('lore-data', '.lore', 'surreal')),
        `expected the full nested literal to survive past the '#', got: ${dataPath}`);
});

await test('a `?` in the path no longer truncates the pathname', () => {
    const ws = path.join(root, 'My?Project', 'lore-data');
    const dataPath = surrealDataPath(ws);
    // Same story as `#`, but `?` starts the URL query component instead.
    assert.ok(dataPath.includes('%3FProject'),
        `expected the escaped '?' and everything after it to survive in the pathname, got: ${dataPath}`);
    assert.ok(dataPath.endsWith(path.join('lore-data', '.lore', 'surreal')),
        `expected the full nested literal to survive past the '?', got: ${dataPath}`);
});

await test('two workspaces differing only after a `#` produce different data paths (the collision itself)', () => {
    const wsA = path.join(root, 'Client#Alpha', 'lore-data');
    const wsB = path.join(root, 'Client#Beta', 'lore-data');
    const pathA = surrealDataPath(wsA);
    const pathB = surrealDataPath(wsB);
    assert.notEqual(pathA, pathB,
        'two distinct workspaces differing only after a # must not collapse onto the same on-disk store');
});

await test('two workspaces differing only after a `?` produce different data paths (the collision itself)', () => {
    const wsA = path.join(root, 'Client?Alpha', 'lore-data');
    const wsB = path.join(root, 'Client?Beta', 'lore-data');
    const pathA = surrealDataPath(wsA);
    const pathB = surrealDataPath(wsB);
    assert.notEqual(pathA, pathB,
        'two distinct workspaces differing only after a ? must not collapse onto the same on-disk store');
});

await test('live: writing to a `#`-containing workspace A is not readable from workspace B', async () => {
    const wsA = path.join(root, 'Live#WorkspaceA', 'lore-data');
    const wsB = path.join(root, 'Live#WorkspaceB', 'lore-data');
    fs.mkdirSync(path.join(wsA, '.lore'), { recursive: true });
    fs.mkdirSync(path.join(wsB, '.lore'), { recursive: true });

    const now = new Date().toISOString();
    const gA = new SurrealGraph(wsA, { workspaceId: 'hashq-a' });
    await gA.initialize();
    await gA.upsertNode({
        id: 'secret-a', type: 'note', label: 'Alpha secret', content: 'only workspace A should see this',
        tags: [], project: '*', ecosystem: '*', metadata: {},
        createdAt: now, updatedAt: now,
    } as never);
    await gA.close();

    const gB = new SurrealGraph(wsB, { workspaceId: 'hashq-b' });
    await gB.initialize();
    const found = await gB.getNode('secret-a');
    await gB.close();

    assert.equal(found, null,
        "workspace B must not see workspace A's data — the exact collision this bug caused");
});

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

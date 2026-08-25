#!/usr/bin/env tsx
/**
 * workspace-substrates-unit.ts — table storage and the hot-session cache are
 * owned per workspace, not by the graph class.
 *
 * ── WHAT MOVED, AND WHY IT HAD TO ───────────────────────────────────────────
 *
 * `LocalGraph.getTableStorage()` and `LocalGraph.sessionCache` were the last
 * two non-graph concerns hanging off the graph class. Neither is graph-engine
 * work: one is a SQLite file, the other a JSON file, and both are keyed on the
 * workspace path alone. Because they lived there, every consumer reached them
 * by casting a graph handle — which silently required the workspace to be
 * Kùzu-backed, on code paths (consistency sweeps, health checks, collection
 * routing, hot context) that have nothing to do with which engine holds nodes.
 *
 * `LocalGraphRegistry` owns them now. It is the per-daemon, per-workspace owner
 * that already has an eviction and disposal lifecycle. A module-level singleton
 * was the obvious shortcut and is rejected for the reason recorded for the call
 * tally: it would be process-global state created by a library that does not
 * own the process.
 *
 * ── THE MEMOIZATION IS AN INVARIANT, NOT AN OPTIMISATION ────────────────────
 *
 * TW-7e requires exactly ONE `SessionCacheManager` per `hot_session.json`.
 * Two are last-writer-wins on the same file, and the bug that earned that
 * label was one manager's pushes being silently dropped by another's flush.
 * So "the same instance twice" is the assertion that matters here, and the
 * loss is measured directly rather than asserted about identity alone.
 *
 * Run: npx tsx test/workspace-substrates-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
// Canonical module (localGraph.js only re-exports it). Neither substrate
// asserts anything engine-specific: table storage is a SQLite file and the
// session cache a JSON file, both keyed on the workspace path alone.
import { SessionCacheManager } from '../packages/lore/src/engines/sessionCacheManager.js';

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-subs-'));
const wsA = path.join(home, 'workspaces', 'a');
const wsB = path.join(home, 'workspaces', 'b');
for (const p of [wsA, wsB]) fs.mkdirSync(path.join(p, '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    active: 'a',
    workspaces: [
        { name: 'a', path: wsA, createdAt: new Date().toISOString() },
        { name: 'b', path: wsB, createdAt: new Date().toISOString() },
    ],
}, null, 2));

const registry = new LocalGraphRegistry({ home });

console.log('Per-workspace substrates, owned by the registry');

await test('table storage is reachable without touching the graph handle', async () => {
    const ts = await registry.tableStorageFor('a');
    assert.equal(ts.constructor.name, 'SqliteTableStorage');
});

await test('the SAME table-storage instance is returned per workspace', async () => {
    // Two instances would be two SQLite handles on one file and two owners of
    // the schema-cache sidecar.
    const first = await registry.tableStorageFor('a');
    const second = await registry.tableStorageFor('a');
    assert.equal(first, second, 'memoized, not reconstructed');
});

await test('different workspaces get different instances', async () => {
    const a = await registry.tableStorageFor('a');
    const b = await registry.tableStorageFor('b');
    assert.notEqual(a, b, 'per-workspace isolation — not one shared store');
});

await test('the SAME session cache is returned per workspace (TW-7e)', async () => {
    const first = await registry.sessionCacheFor('a');
    const second = await registry.sessionCacheFor('a');
    assert.equal(first, second, 'exactly one manager per hot_session.json');
});

await test('two managers would lose writes — measured, not asserted about identity', async () => {
    // Why the memo above is an invariant. This constructs the second manager
    // the registry refuses to create, and shows the loss directly.
    const shared = await registry.sessionCacheFor('a');
    shared.pushNode('from-the-owner');
    shared.flushNow();

    const rogue = new SessionCacheManager(wsA);
    rogue.pushNode('from-the-rogue');
    rogue.flushNow(); // last writer wins the file

    const onDisk = JSON.parse(fs.readFileSync(path.join(wsA, '.lore', 'hot_session.json'), 'utf8'));
    const ids: string[] = (onDisk.nodes ?? onDisk.recent ?? []).map(
        (n: unknown) => (typeof n === 'string' ? n : (n as { id: string }).id),
    );
    assert.ok(
        !ids.includes('from-the-owner'),
        'the second manager silently dropped the first\'s write — this is TW-7e, and why one owner is required',
    );
});

await test('session caches are per workspace, not global', async () => {
    const a = await registry.sessionCacheFor('a');
    const b = await registry.sessionCacheFor('b');
    assert.notEqual(a, b);
});

await test('an unknown workspace is refused, not silently created', async () => {
    await assert.rejects(() => registry.tableStorageFor('nope'), /nope|not found|workspace/i);
});

await test('disposeAll flushes the session cache before closing', async () => {
    // Unflushed hot-session state is silently lost work — the other half of
    // what TW-7e was about.
    const reg = new LocalGraphRegistry({ home });
    const cache = await reg.sessionCacheFor('b');
    cache.pushNode('written-just-before-shutdown');
    await reg.disposeAll();
    const p = path.join(wsB, '.lore', 'hot_session.json');
    assert.ok(fs.existsSync(p), 'the cache file was written during disposal');
    const raw = fs.readFileSync(p, 'utf8');
    assert.match(raw, /written-just-before-shutdown/, 'and it contains the last write');
});

await registry.disposeAll().catch(() => undefined);
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

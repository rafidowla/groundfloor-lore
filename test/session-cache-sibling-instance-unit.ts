#!/usr/bin/env tsx
/**
 * session-cache-sibling-instance-unit.ts — TW-7e's "exactly ONE
 * SessionCacheManager per hot_session.json" invariant, for NON-ACTIVE
 * (sibling, lazily-opened) workspaces.
 *
 * The ACTIVE workspace has always been safe: `mcp/storageBundle.ts` reuses
 * `localGraph.sessionCache` when one exists rather than building a second
 * manager, and `governance.ts`'s `get_hot_context` reads that same instance
 * whenever `resolved.isActive`.
 *
 * The SIBLING path was the half that never got the same treatment.
 * `get_hot_context` routes those through `LocalGraphRegistry.sessionCacheFor()`,
 * which used to memoize its OWN `new SessionCacheManager(entry.path)` while
 * every write (`LocalGraph.upsertNode` / `bulkUpsertNodes` →
 * `this.sessionCache.pushNode(...)`) went through the graph's separate
 * instance. Two managers, one file — last-writer-wins.
 *
 * It was not theoretical. Pre-fix, this file reproduced, in order:
 *   1. the two managers were different objects;
 *   2. a real write landed on disk but a registry-owned reader that had
 *      already cached state never saw it (stale read);
 *   3. the REAL `registry.disposeAll()` shutdown path then flushed the stale
 *      registry-owned view over the top, DELETING the persisted write —
 *      silent data loss through the daemon's own graceful-shutdown path.
 *
 * Kùzu-removal (Phase 3f, 2026-08) restated the invariant for a
 * Surreal-backed sibling — same principle storageBundle.ts states for the
 * Kùzu-free case: with no LocalGraph there is no graph-owned manager to
 * reuse, so the registry's memoized path-keyed manager must be the ONLY one
 * in existence. `sessionCacheFor()` memoizes on the cache entry; the
 * invariant now holds by memoization, and these assertions pin that:
 *   T1 — two calls return the SAME instance (a per-call construction is the
 *        regression), and sibling/active managers stay path-keyed and
 *        distinct;
 *   T2 — a push through that one manager (the writer surface) lands on disk
 *        and is visible to the reader surface (`getHotContext`) governance
 *        uses;
 *   T3 — the real `disposeAll()` shutdown path FLUSHES the un-flushed push
 *        rather than clobbering the file with an empty view.
 *
 * NOTE (behavioral gap, reported not papered over): LocalGraph.upsertNode
 * used to push node ids into its own session cache, so graph writes updated
 * a sibling's hot_session.json. SurrealGraph has no session-cache
 * integration, and no other path pushes for non-active workspaces
 * (retrieve.ts only pushes when graph === bootGraph) — so for a
 * Surreal-backed sibling, graph writes alone no longer update the hot
 * context. What this file pins is the single-writer durability contract
 * around that file.
 *
 * Run:
 *   npx tsx test/session-cache-sibling-instance-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sib-sessioncache-'));
const wsActive = path.join(home, 'workspaces', 'active');
const wsSibling = path.join(home, 'workspaces', 'sibling');
for (const p of [wsActive, wsSibling]) fs.mkdirSync(path.join(p, '.lore'), { recursive: true });
// No explicit graphEngine: absent defaults to 'surreal' (DEFAULT_GRAPH_ENGINE).
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    active: 'active',
    workspaces: [
        { name: 'active', path: wsActive, createdAt: new Date().toISOString() },
        { name: 'sibling', path: wsSibling, createdAt: new Date().toISOString() },
    ],
}, null, 2));

const hotSessionPath = path.join(wsSibling, '.lore', 'hot_session.json');
const nd = (id: string) => ({
    id, type: 'note', label: id, content: 'c', tags: ['t'], project: 'w', ecosystem: '*',
    metadata: '{}', security_scopes: [] as string[], language: null, ephemeral: false,
    ttl_ms: null, stale: false,
});

type CacheLike = {
    pushNode: (id: string) => void;
    getHotContext: () => { recent_nodes: string[] };
    flushNow: () => void;
};

console.log('\nSibling-workspace session cache — TW-7e single-manager invariant\n');

const registry = new LocalGraphRegistry({ home });

await test('T0: the sibling workspace is genuinely Surreal-backed', async () => {
    // Fixture sanity — everything below pins the Surreal path, so prove the
    // engine selector actually resolved 'surreal' for this workspace.
    const handle = await registry.getGraphHandle('sibling');
    assert.ok(handle instanceof SurrealGraph, 'expected a SurrealGraph handle for the sibling');
    await handle.upsertNode(nd('sibling-graph-write') as never);
    assert.ok(await handle.getNode('sibling-graph-write'), 'surreal handle is live');
});

await test('T1: sessionCacheFor() memoizes ONE manager per sibling workspace', async () => {
    // The invariant itself. A second manager on the same hot_session.json is
    // the whole bug — everything below is a consequence of this holding.
    const first = await registry.sessionCacheFor('sibling');
    const second = await registry.sessionCacheFor('sibling');
    assert.equal(
        first as unknown,
        second as unknown,
        'sibling workspace must have exactly ONE SessionCacheManager — a per-call construction is the TW-7e regression',
    );
    // And managers stay path-keyed: the active workspace's manager is a
    // different instance writing a different file.
    const active = await registry.sessionCacheFor('active');
    assert.notEqual(
        first as unknown,
        active as unknown,
        'sibling and active workspaces must not share one manager',
    );
});

await test('T2: a push through the manager is visible to the registry-owned reader', async () => {
    // What get_hot_context does for a sibling workspace. Pre-fix this read
    // stale, because the reader was a different object with its own cache.
    const viaRegistry = (await registry.sessionCacheFor('sibling')) as unknown as CacheLike;

    // Prime the reader from an empty file first — that priming is what made
    // the stale read possible pre-fix, so it must stay in the scenario.
    assert.deepEqual(viaRegistry.getHotContext().recent_nodes, [], 'starts empty');

    viaRegistry.pushNode('via-manager-write');
    viaRegistry.flushNow();

    const onDisk = JSON.parse(fs.readFileSync(hotSessionPath, 'utf8'));
    assert.ok(onDisk.recent_nodes.includes('via-manager-write'), 'sanity: write reached disk');

    assert.ok(
        viaRegistry.getHotContext().recent_nodes.includes('via-manager-write'),
        'get_hot_context must see a write that already landed on disk',
    );
});

await test('T3: the real disposeAll() shutdown path PRESERVES the write', async () => {
    // The data-loss step. disposeAll() flushes entry.sessionCache; pre-fix that
    // was the stale second instance and its flush erased the persisted write.
    // Leave an UNFLUSHED push in memory so the flush is load-bearing — the
    // only way it survives shutdown is the drain flushing the one manager
    // that holds it, rather than clobbering the file with an empty view.
    const viaRegistry = (await registry.sessionCacheFor('sibling')) as unknown as CacheLike;
    viaRegistry.pushNode('unflushed-until-shutdown');

    await registry.disposeAll();

    const onDisk = JSON.parse(fs.readFileSync(hotSessionPath, 'utf8'));
    assert.ok(
        onDisk.recent_nodes.includes('via-manager-write'),
        'graceful shutdown must not overwrite a persisted write with a stale view',
    );
    assert.ok(
        onDisk.recent_nodes.includes('unflushed-until-shutdown'),
        'graceful shutdown must FLUSH the single manager\'s pending write, not drop it',
    );
});

await registry.disposeAll().catch(() => undefined);
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

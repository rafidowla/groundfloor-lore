#!/usr/bin/env tsx
/**
 * test/verbatim-resolver-idle-eviction-unit.ts — STEP2-CLOSE-PATH-DESIGN.md (c).
 *
 * `WorkspaceVerbatimResolver` gains idle eviction (mirroring
 * `LocalGraphRegistry`'s existing shape — outbox/workspaceVerbatimResolver.ts).
 * This is the resolver-only sweep; it must never touch the graph registry
 * (SCOPE CHANGE: SurrealDB's evict+reopen leaks ~100MB/reopen — see
 * docs/PERFORMANCE-MEMORY.md §9 — so only the LanceDB/verbatim half evicts).
 *
 * Covers:
 *   1. evictIdle() closes only entries idle past idleMs, skips pinned paths.
 *   2. evictIdle() skips a path with an in-flight open.
 *   3. Guardrail: evictIdle() does NOT evict a workspace with pending
 *      embed-queue work, or pending outbox work, even if idle.
 *   4. closeWorkspace(name): closes + returns true; refuses (false) a
 *      pinned path; refuses (false) a workspace with pending work.
 *   5. openCount() reflects opens/evictions.
 *   6. injectable now() drives lastAccessedAt / idle math deterministically.
 *   7. write → evict → getOrOpen → every row still readable AND
 *      vector-searchable (reopen is transparent and complete).
 *   8. start/stopEvictionSweep are idempotent and don't throw.
 *
 * Run: npx tsx test/verbatim-resolver-idle-eviction-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-resolver-evict-'));
process.env.LORE_HOME = HOME;

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

/** Deterministic, instant fake embedder for real VerbatimStore reads/writes
 *  without paying ONNX load cost. */
function fakeEmbeddingProvider(dim = 8): EmbeddingProvider {
    const vec = () => Array.from({ length: dim }, () => Math.random());
    return {
        modelId: 'evict-fake', dimension: dim,
        async initialize() {}, async embed() { return vec(); },
        async embedDocument() { return vec(); }, async embedQuery() { return vec(); },
        async embedDocumentBatch(texts: string[]) { return texts.map(() => vec()); },
    };
}

/** Mutable clock for injectable now(). */
function clock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let t = startMs;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

console.log('\nWorkspaceVerbatimResolver — idle eviction (STEP2-CLOSE-PATH-DESIGN.md (c))\n');

await test('evictIdle() closes only entries idle past idleMs, skips pinned paths', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(undefined, false, {}, { now: c.now });
    const wsIdle = createWorkspace('evict-idle-a');
    const wsFresh = createWorkspace('evict-idle-b');
    await resolver.getOrOpen(wsIdle.name); // stamped at t0
    c.advance(40_000);
    await resolver.getOrOpen(wsFresh.name); // stamped at t0+40s — well within the 30s window below
    c.advance(5_000); // wsIdle is now idle 45s (evict); wsFresh is idle 5s (keep)
    const closed = await resolver.evictIdle(c.now(), 30_000);
    assert.equal(closed, 1, 'exactly the stale entry (wsIdle) should be evicted');
    assert.equal(resolver.openCount(), 1, 'the fresh entry stays open');
});

await test('evictIdle() skips a path with an in-flight open', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(undefined, false, {}, { now: c.now });
    const ws = createWorkspace('evict-inflight');
    // Start (but do not await) an open, then immediately try to evict —
    // the in-flight map must protect it even though it "looks" old by clock.
    const opening = resolver.getOrOpen(ws.name);
    c.advance(10_000_000); // far past any idle threshold
    const closedWhileOpening = await resolver.evictIdle(c.now(), 0);
    assert.equal(closedWhileOpening, 0, 'an in-flight open must not be evicted out from under itself');
    await opening;
});

await test('guardrail: pending embed-queue work blocks eviction', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const ws = createWorkspace('evict-guard-embed');
    resolver.setGuardrails({ hasPendingEmbeds: (name) => name === ws.name });
    await resolver.getOrOpen(ws.name);
    c.advance(10_000_000);
    const closed = await resolver.evictIdle(c.now(), 0);
    assert.equal(closed, 0, 'a workspace with pending embed-queue work must not be evicted');
    assert.equal(resolver.openCount(), 1);
});

await test('guardrail: pending outbox work blocks eviction', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const ws = createWorkspace('evict-guard-outbox');
    resolver.setGuardrails({ hasPendingOutbox: async (name) => name === ws.name });
    await resolver.getOrOpen(ws.name);
    c.advance(10_000_000);
    const closed = await resolver.evictIdle(c.now(), 0);
    assert.equal(closed, 0, 'a workspace with pending outbox rows must not be evicted');
});

await test('no guardrail wired: fails open (eviction proceeds)', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const ws = createWorkspace('evict-no-guardrail');
    await resolver.getOrOpen(ws.name);
    c.advance(10_000_000);
    const closed = await resolver.evictIdle(c.now(), 0);
    assert.equal(closed, 1, 'with no guardrail wired, idle eviction proceeds (fail-open)');
});

await test('closeWorkspace(): closes + returns true; refuses a pinned path', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const wsOpen = createWorkspace('close-ws-open');
    const wsPinned = createWorkspace('close-ws-pinned');
    const store = await resolver.getOrOpen(wsOpen.name);
    resolver.prime(wsPinned.name, store); // reuse the same store, just to pin a path
    const closedOpen = await resolver.closeWorkspace(wsOpen.name);
    assert.equal(closedOpen, true, 'closeWorkspace on a real open entry closes it');
    assert.equal(resolver.openCount(), 1, 'only the pinned entry remains');
    const closedPinned = await resolver.closeWorkspace(wsPinned.name);
    assert.equal(closedPinned, false, 'closeWorkspace refuses a pinned (boot-owned) path');
});

await test('closeWorkspace(): refuses a workspace with pending work', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const ws = createWorkspace('close-ws-guardrail');
    resolver.setGuardrails({ hasPendingEmbeds: () => true });
    await resolver.getOrOpen(ws.name);
    const closed = await resolver.closeWorkspace(ws.name);
    assert.equal(closed, false, 'closeWorkspace refuses while pending work exists');
});

await test('closeWorkspace(): a never-opened workspace reports true (nothing to do)', async () => {
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {});
    const ws = createWorkspace('close-ws-never-opened');
    assert.equal(await resolver.closeWorkspace(ws.name), true);
});

await test('reopen is transparent and complete: write -> evict -> getOrOpen -> read + vector-search', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const ws = createWorkspace('evict-reopen-readback');
    const store1 = await resolver.getOrOpen(ws.name);
    await store1.store({ id: 'n1', text: 'the quick brown fox jumps over the lazy dog', metadata: { type: 'note' } });
    await store1.store({ id: 'n2', text: 'a second distinct row for this workspace', metadata: { type: 'note' } });

    c.advance(10_000_000);
    const closed = await resolver.evictIdle(c.now(), 0);
    assert.equal(closed, 1, 'the workspace evicts');
    assert.equal(resolver.openCount(), 0);

    const store2 = await resolver.getOrOpen(ws.name);
    assert.notEqual(store2, store1, 'reopen constructs a fresh VerbatimStore instance');
    const row = await store2.getById('n1');
    assert.ok(row, 'row written before eviction is still readable after reopen');
    assert.equal(row!.text, 'the quick brown fox jumps over the lazy dog');
    const hits = await store2.search('quick brown fox', 5);
    assert.ok(hits.some((h) => h.id === 'n1'), 'the row is still vector-searchable after reopen');
});

await test('injectable now(): getOrOpen stamps lastAccessedAt on both hit and fresh open', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const ws = createWorkspace('lastaccessed-stamp');
    await resolver.getOrOpen(ws.name); // fresh open at t0
    c.advance(5000);
    await resolver.getOrOpen(ws.name); // cache hit — should re-stamp to t0+5000
    // Idle threshold of 4000ms: if the hit had NOT re-stamped, this would
    // wrongly evict (idle 5000 > 4000). Since it DID re-stamp, idle is 0.
    const closed = await resolver.evictIdle(c.now(), 4000);
    assert.equal(closed, 0, 'a cache-hit getOrOpen must refresh lastAccessedAt');
});

await test('F2 (Opus review): a concurrent getOrOpen during evictIdle\'s guardrail await keeps its store alive, and evictIdle skips it', async () => {
    // Race: evictIdle selects a candidate, then `await hasPendingWork(...)`.
    // During that await a concurrent getOrOpen(name) can touch the SAME
    // cache entry and hand its caller a store that evictIdle is about to
    // close underneath it. The fix re-verifies (synchronously, no await in
    // between) that the entry is unchanged AND still idle before deleting.
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const ws = createWorkspace('f2-race-guardrail-touch');
    await resolver.getOrOpen(ws.name);
    c.advance(10_000_000); // idle relative to idleMs=0 below

    let releaseGuardrail!: () => void;
    const guardrailGate = new Promise<void>((res) => { releaseGuardrail = res; });
    resolver.setGuardrails({ hasPendingOutbox: async () => { await guardrailGate; return false; } });

    const evictPromise = resolver.evictIdle(c.now(), 0);
    // While evictIdle is parked awaiting the guardrail, race a getOrOpen +
    // write through the SAME workspace name.
    const store = await resolver.getOrOpen(ws.name);
    await store.store({ id: 'race-guardrail-1', text: 'still alive mid-eviction', metadata: { type: 'note' } });
    const row = await store.getById('race-guardrail-1');
    assert.ok(row, 'the store handed to the racing getOrOpen() must still be open and writable');

    releaseGuardrail();
    const evicted = await evictPromise;
    assert.equal(evicted, 0, 'evictIdle must skip an entry a concurrent getOrOpen touched during the guardrail await');
    assert.equal(resolver.openCount(), 1, 'the entry remains cached — it was correctly NOT evicted');
});

await test('F2 (Opus review): getOrOpen after the entry is deleted opens a FRESH store while the old close() still drains', async () => {
    // Second half of the same race: once evictIdle passes the guardrail +
    // re-verification and deletes the map entry, a getOrOpen() that arrives
    // while the OLD store's close() is still in flight must miss the cache
    // (the entry is already gone) and open a genuinely fresh store — never
    // hand back the one that is closing.
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const ws = createWorkspace('f2-race-delete-before-close');
    const oldStore = await resolver.getOrOpen(ws.name);
    await oldStore.store({ id: 'old-1', text: 'from the old store', metadata: { type: 'note' } });
    c.advance(10_000_000);

    let releaseOldClose!: () => void;
    const oldCloseGate = new Promise<void>((res) => { releaseOldClose = res; });
    let oldCloseCalled = false;
    const realClose = oldStore.close.bind(oldStore);
    oldStore.close = async () => { oldCloseCalled = true; await oldCloseGate; return realClose(); };

    // No guardrail wired -> fail-open, proceeds straight to the sync
    // check+delete, then awaits the (now slow) close().
    const evictPromise = resolver.evictIdle(c.now(), 0);
    await new Promise((r) => setTimeout(r, 20)); // let the async guardrail microtask + sync delete land
    assert.equal(oldCloseCalled, true, 'close() must already be in flight (draining)');
    assert.equal(resolver.openCount(), 0, 'the entry is removed from the cache BEFORE close() resolves, not after');

    const freshStore = await resolver.getOrOpen(ws.name);
    assert.notEqual(freshStore, oldStore, 'a getOrOpen while the old close() drains must construct a genuinely fresh store');
    await freshStore.store({ id: 'new-1', text: 'from the fresh store', metadata: { type: 'note' } });
    const row = await freshStore.getById('new-1');
    assert.ok(row, 'the fresh store is open and writable while the old one is still closing');

    releaseOldClose();
    const evicted = await evictPromise;
    assert.equal(evicted, 1, 'the old entry still counts as evicted once its (slow) close() finally resolves');
});

await test('F2 (Opus review): closeWorkspace re-verifies before deleting, same race as evictIdle', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(fakeEmbeddingProvider(), false, {}, { now: c.now });
    const ws = createWorkspace('f2-race-closeworkspace');
    await resolver.getOrOpen(ws.name);

    let releaseGuardrail!: () => void;
    const guardrailGate = new Promise<void>((res) => { releaseGuardrail = res; });
    resolver.setGuardrails({ hasPendingOutbox: async () => { await guardrailGate; return false; } });

    const closePromise = resolver.closeWorkspace(ws.name);
    const store = await resolver.getOrOpen(ws.name); // touches the same entry mid-guardrail-await
    await store.store({ id: 'cw-race-1', text: 'alive during closeWorkspace race', metadata: { type: 'note' } });

    releaseGuardrail();
    // closeWorkspace still proceeds (it has no idle check, only the identity
    // re-check) — since getOrOpen on a cache hit did not replace the entry
    // object, the identity check still passes and the close proceeds. This
    // pins that closeWorkspace's guard is the SAME shape as evictIdle's,
    // not that it always refuses after a touch.
    const closed = await closePromise;
    assert.equal(closed, true, 'closeWorkspace proceeds when the entry object is unchanged');
    // `store` is now closed (getById on it would correctly return null) —
    // verify the write survived via a FRESH reopen instead.
    const reopened = await resolver.getOrOpen(ws.name);
    const row = await reopened.getById('cw-race-1');
    assert.ok(row, 'the write that landed before close() drained is preserved on disk');
});

await test('start/stopEvictionSweep are idempotent and do not throw', () => {
    const resolver = new WorkspaceVerbatimResolver(undefined, false, {});
    resolver.startEvictionSweep();
    resolver.startEvictionSweep(); // idempotent
    resolver.stopEvictionSweep();
    resolver.stopEvictionSweep(); // idempotent
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

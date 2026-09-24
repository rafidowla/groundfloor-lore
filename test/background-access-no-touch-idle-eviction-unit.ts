#!/usr/bin/env tsx
/**
 * test/background-access-no-touch-idle-eviction-unit.ts
 *
 * Regression for docs/PERFORMANCE-MEMORY.md §11: in a live 10-workspace
 * daemon with zero user traffic, LocalGraphRegistry idle eviction NEVER
 * fired at LORE_REGISTRY_IDLE_TTL_MS >= 40000 (sweep 15000, waited 95s).
 *
 * Root cause: the daily retention sweep's bootstrap timer
 * (mcp/retentionScheduler.ts, FIRST_FIRE_MS=60_000) fires ~60s after boot
 * regardless of traffic and fans out over EVERY registered workspace
 * (mcp/daemonTimers.ts's runRetentionSweepAllWorkspaces /
 * runConsistencySweepAllWorkspaces), calling
 * `registry.getGraphHandle(ws)` / `resolver.getOrOpen(ws)` for each one.
 * Those accessors stamped `lastAccessedAt` on every cache-hit — background
 * maintenance access was indistinguishable from real user access, so the
 * fan-out reset the idle clock for every workspace it reached, defeating
 * eviction at any TTL the 60s-post-boot fan-out could out-run.
 *
 * Fix: `{ touch: false }` on `LocalGraphRegistry.getGraphHandle` /
 * `.tableStorageFor` / `.ensureEntry` and on
 * `WorkspaceVerbatimResolver.getOrOpen` marks BACKGROUND access — a
 * cache-hit under `touch:false` returns the entry WITHOUT bumping
 * `lastAccessedAt`. `daemonTimers.ts`'s two fan-outs now pass it.
 * Opening (not merely touching) a workspace under `touch:false` — the
 * case where the fan-out reopens an ALREADY-EVICTED or never-opened
 * workspace to check it — stamps a stale sentinel (epoch 0) instead of
 * `now()`, so the reopened entry is immediately eligible for the very
 * next eviction sweep rather than being granted a fresh full-TTL lease
 * (this is what the unexplained 30->70 graph-fd growth during a
 * TTL=40000 idle wait traced back to).
 *
 * Covers:
 *   1. LocalGraphRegistry: a `{ touch: false }` cache-hit during the idle
 *      window does NOT reset lastAccessedAt; the workspace is still
 *      evicted once the real TTL elapses.
 *   2. LocalGraphRegistry: `{ touch: false }` reopening an EVICTED
 *      workspace does not grant it a fresh lease — it's evictable again
 *      on the very next sweep.
 *   3. WorkspaceVerbatimResolver: same `touch:false` cache-hit contract.
 *   4. Default (omitted opts / `touch: true`) behaviour is BYTE-IDENTICAL
 *      to before this fix — ordinary access still resets the clock.
 *
 * Run: npx tsx test/background-access-no-touch-idle-eviction-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';

let wsSeq = 0;
/** Registers a fresh, uniquely-named workspace (dir + workspaces.json entry)
 *  and returns its (kebab-cased) name — LocalGraphRegistry.getGraphHandle
 *  needs a REAL registered workspace to resolve a path against. */
function freshWorkspace(label: string): string {
    return createWorkspace(`bg-no-touch-${label}-${++wsSeq}`).name;
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'background-no-touch-'));
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

function clock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let t = startMs;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

console.log('\nBackground/maintenance access must not count as user access (docs/PERFORMANCE-MEMORY.md §11)\n');

await test('LocalGraphRegistry: a touch:false cache-hit during the idle window does not reset the clock; eviction still fires at TTL', async () => {
    const c = clock();
    const reg = new LocalGraphRegistry({ now: c.now });
    const ws = freshWorkspace('a');
    try {
        await reg.getGraphHandle(ws); // real user open, stamped at t0
        assert.equal(reg.openCount(), 1);

        // Half the TTL elapses, then a BACKGROUND sweep glances at it (as
        // daemonTimers.ts's fan-outs now do) — this must NOT extend the
        // idle clock.
        c.advance(30_000);
        const handle = await reg.getGraphHandle(ws, { touch: false });
        assert.ok(handle, 'background access still resolves the real handle');

        // The rest of the TTL elapses. If the background peek above had
        // reset the clock (the pre-fix bug), this entry would still look
        // fresh (30s old) and survive; it must instead be evicted, because
        // real last USER access was 60s ago, past the 60s TTL.
        c.advance(31_000);
        const evicted = await reg.evictIdle(c.now(), 60_000);
        assert.equal(evicted, 1, 'idle workspace is evicted despite the intervening background peek');
        assert.equal(reg.openCount(), 0, 'registry is empty after eviction');
    } finally {
        await reg.evictIdle(Number.MAX_SAFE_INTEGER, 0);
        reg.closeAll();
    }
});

await test('LocalGraphRegistry: touch:false reopening an evicted workspace does not grant a fresh lease', async () => {
    const c = clock();
    const reg = new LocalGraphRegistry({ now: c.now });
    const ws = freshWorkspace('b');
    try {
        await reg.getGraphHandle(ws);
        c.advance(100_000);
        const evicted = await reg.evictIdle(c.now(), 60_000);
        assert.equal(evicted, 1, 'workspace evicted for being idle past the TTL');
        assert.equal(reg.openCount(), 0);

        // A background sweep (e.g. the retention fan-out) reopens the now-
        // evicted workspace to check it — with touch:false.
        await reg.getGraphHandle(ws, { touch: false });
        assert.equal(reg.openCount(), 1, 'the sweep’s own open is real and observable');

        // Immediately run the next sweep tick (no further time passes) — a
        // background-only open must already be stale enough to evict again,
        // not hold a fresh TTL-length lease it never earned.
        const evictedAgain = await reg.evictIdle(c.now(), 60_000);
        assert.equal(evictedAgain, 1, 'a workspace reopened only for background access is evictable immediately');
        assert.equal(reg.openCount(), 0);
    } finally {
        await reg.evictIdle(Number.MAX_SAFE_INTEGER, 0);
        reg.closeAll();
    }
});

await test('LocalGraphRegistry: default (touch omitted) is unchanged — ordinary access still resets the clock', async () => {
    const c = clock();
    const reg = new LocalGraphRegistry({ now: c.now });
    const ws = freshWorkspace('c');
    try {
        await reg.getGraphHandle(ws);
        c.advance(50_000);
        await reg.getGraphHandle(ws); // ordinary (touching) access — refreshes the clock
        c.advance(50_000); // 100s since open, but only 50s since the last real touch
        const evicted = await reg.evictIdle(c.now(), 60_000);
        assert.equal(evicted, 0, 'the touching re-access kept the workspace alive, as before this fix');
        assert.equal(reg.openCount(), 1);
    } finally {
        await reg.evictIdle(Number.MAX_SAFE_INTEGER, 0);
        reg.closeAll();
    }
});

await test('LocalGraphRegistry.tableStorageFor: touch:false cache-hit does not reset the clock either', async () => {
    const c = clock();
    const reg = new LocalGraphRegistry({ now: c.now });
    const ws = freshWorkspace('d');
    try {
        await reg.getGraphHandle(ws);
        c.advance(30_000);
        await reg.tableStorageFor(ws, { touch: false });
        c.advance(31_000);
        const evicted = await reg.evictIdle(c.now(), 60_000);
        assert.equal(evicted, 1, 'tableStorageFor(touch:false) must not extend the idle clock (consistency fan-out uses this accessor)');
    } finally {
        await reg.evictIdle(Number.MAX_SAFE_INTEGER, 0);
        reg.closeAll();
    }
});

await test('WorkspaceVerbatimResolver: a touch:false cache-hit during the idle window does not reset the clock; eviction still fires at TTL', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(undefined, false, {}, { now: c.now });
    const ws = createWorkspace('bg-no-touch-verbatim-a');
    await resolver.getOrOpen(ws.name); // real user open
    assert.equal(resolver.openCount(), 1);

    c.advance(30_000);
    await resolver.getOrOpen(ws.name, { touch: false }); // background peek (retention/consistency fan-out)

    c.advance(31_000);
    const closed = await resolver.evictIdle(c.now(), 60_000);
    assert.equal(closed, 1, 'idle verbatim store is evicted despite the intervening background peek');
    assert.equal(resolver.openCount(), 0);
});

await test('WorkspaceVerbatimResolver: default (touch omitted) is unchanged — ordinary access still resets the clock', async () => {
    const c = clock();
    const resolver = new WorkspaceVerbatimResolver(undefined, false, {}, { now: c.now });
    const ws = createWorkspace('bg-no-touch-verbatim-b');
    await resolver.getOrOpen(ws.name);
    c.advance(50_000);
    await resolver.getOrOpen(ws.name); // ordinary touching re-access
    c.advance(50_000);
    const closed = await resolver.evictIdle(c.now(), 60_000);
    assert.equal(closed, 0, 'the touching re-access kept the store alive, as before this fix');
    assert.equal(resolver.openCount(), 1);
});

// Best-effort cleanup of the temp home.
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

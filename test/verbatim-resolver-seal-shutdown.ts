#!/usr/bin/env tsx
/**
 * Wire-up proof (Wave F, lane f5): WorkspaceVerbatimResolver.closeAll() SEALS the resolver, so nothing reopens a
 * store during the shutdown window between the resolver's closeAll and the boot store's close().
 *
 * Real path (A): embedded `createLore()` runs the same server.ts boot as the daemon - boot SqliteVerbatimStore
 * primed into the WorkspaceVerbatimResolver, a real background SQLite -> LanceDB promotion
 * (LORE_VECTOR_PROMOTE_ROWS), and the real shutdown drain (`lore.dispose()`), which calls resolver.closeAll() (step
 * 9.7) before closing the boot store (step 10). The window is staged by calling closeAll() ourselves on the live
 * resolver while the retired boot store is still open, exactly the state the drain leaves between 9.7 and 10.
 *
 *   A. after closeAll: a read through the held (retired) boot reference answers from the old store and opens no
 *      store; a write fails fast with the typed sealed error (not after the 5 s retired-retry budget, not onto a
 *      closed or renamed-away file); getOrOpen refuses; the drain that follows completes cleanly.
 *   B. unit races with the real resolver + real SQLite engine: an open in flight when closeAll runs closes its own
 *      handle (nothing untracked), closeAll waits for it, and the caller sees the sealed error; same for a
 *      promotion swap in flight; prime / swapToLance / startEvictionSweep / getOrOpen are inert after the seal;
 *      closeAll is idempotent.
 *   C. the outbox classifies the sealed error as transient (replay on the next lifecycle, never a dead-letter).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-seal-home-'));
process.env.LORE_HOME = HOME;
process.env.LORE_MODEL_SERVER = '0';
process.env.LORE_VECTOR_PROMOTE_ROWS = '6';
process.env.LORE_DEFAULT_VECTOR_ENGINE = 'sqlite';
process.env.LORE_CACHE_DISABLED = '1';
const { createLore } = await import('../packages/lore/src/index.js');
const { getActiveWorkspaceName, createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');
const { SqliteVerbatimStore } = await import('../packages/lore/src/engines/sqliteVerbatimStore.js');
const { WorkspaceVerbatimResolver } = await import('../packages/lore/src/outbox/workspaceVerbatimResolver.js');
const { isVerbatimResolverSealedError } = await import('../packages/lore/src/engines/verbatimStoreClosedError.js');
const { isSqliteOrRetiredTransient } = await import('../packages/lore/src/outbox/failureDisposition.js');

const dim = 8;
const vec = (t: string): number[] => {
    const v = new Array(dim).fill(0.01);
    for (let i = 0; i < t.length; i++) v[i % dim] += t.charCodeAt(i) / 128;
    return v;
};
const provider = {
    dimension: dim, modelId: 'seal-det', dtype: 'fp32',
    async initialize() {}, async embed(t: string) { return vec(t); }, async embedQuery(t: string) { return vec(t); },
    async embedDocument(t: string) { return vec(t); },
    async embedDocumentBatch(ts: string[]) { return ts.map(vec); },
    dispose() {},
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const doc = (id: string, text = `zebra document ${id}`) => ({ id, text, metadata: { updatedAt: '2026-10-25T00:00:00.000Z' } });
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

// Count every store open (initialize) and close, on both engines, to prove "nothing reopened".
const counts = { init: 0, close: 0 };
let initGate: Promise<void> | null = null;
type Proto = { initialize(): Promise<void>; close(): Promise<void> };
for (const P of [VerbatimStore.prototype, SqliteVerbatimStore.prototype] as unknown as Proto[]) {
    const origInit = P.initialize; const origClose = P.close;
    P.initialize = async function (this: unknown) { counts.init++; if (initGate) await initGate; return origInit.call(this); };
    P.close = async function (this: unknown) { counts.close++; return origClose.call(this); };
}

// ---------------------------------------------------------------- A
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-seal-'));
const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: provider as never });
try {
    const boot = lore.store.loreVerbatim as unknown as InstanceType<typeof SqliteVerbatimStore>;
    assert.ok(boot instanceof SqliteVerbatimStore, 'boot store is the SQLite engine');
    const resolver = lore._daemon.getVerbatimResolver()!;
    const ws = getActiveWorkspaceName(dataDir);
    await resolver.getOrOpen(ws);
    for (let i = 0; i < 6; i++) await boot.store(doc(`seed${i}`)); // the 6th write triggers the promotion
    const t0 = Date.now();
    let promoted: unknown;
    for (;;) {
        promoted = await resolver.getOrOpen(ws, { touch: false });
        if (promoted !== boot) break;
        if (Date.now() - t0 > 20_000) throw new Error('the resolver never swapped its boot entry to the promoted store');
        await sleep(25);
    }
    assert.ok(promoted instanceof VerbatimStore, 'resolver serves the Lance engine after the promotion');
    await (promoted as InstanceType<typeof VerbatimStore>).store(doc('post-promo', 'quokkaterm after promotion'));

    // shutdown window: resolver.closeAll() has run (drain step 9.7), the boot store is not closed yet (step 10)
    const initBefore = counts.init;
    await resolver.closeAll();
    const closeAfterSeal = counts.close;
    assert.equal(resolver.isSealed(), true);
    assert.equal(resolver.openCount(), 0);

    await test('a read through the retired boot reference answers from the old store and opens nothing', async () => {
        assert.equal(await boot.count(), 6, 'old store: the six pre-promotion rows');
        assert.equal(await boot.getById('seed0') !== null, true);
        assert.equal(await boot.getById('post-promo'), null, 'post-promotion rows live only on the promoted store');
        assert.equal((await boot.listIds()).length, 6);
        assert.ok((await boot.bm25Search('zebra', 10)).hits.length > 0);
        assert.equal(counts.init, initBefore, 'no store was initialized (opened) by a forwarded read');
        assert.equal(resolver.openCount(), 0, 'the sealed resolver tracks nothing');
    });

    await test('a write through the retired boot reference fails fast with the typed sealed error and opens/writes nothing', async () => {
        const t = Date.now();
        let err: unknown;
        try { await boot.store(doc('late-write', 'written during shutdown')); } catch (e) { err = e; }
        const ms = Date.now() - t;
        assert.ok(err, 'the write must reject');
        assert.ok(isVerbatimResolverSealedError(err), `typed sealed error, got ${(err as Error)?.name}: ${(err as Error)?.message}`);
        assert.equal((err as { applied?: boolean }).applied, false, 'nothing was applied');
        assert.ok(ms < 2000, `fails fast, not after the retired-retry budget (${ms} ms)`);
        let batchErr: unknown;
        try { await boot.storeBatch([doc('late-b1'), doc('late-b2')]); } catch (e) { batchErr = e; }
        assert.ok(isVerbatimResolverSealedError(batchErr), `storeBatch: ${(batchErr as Error)?.name}`);
        assert.equal(counts.init, initBefore, 'still nothing opened');
        assert.equal(await boot.getById('late-write'), null);
        assert.equal(await boot.getById('late-b1'), null);
        assert.ok(isSqliteOrRetiredTransient(err), 'the outbox treats it as transient (replay later)');
    });

    await test('getOrOpen / swapToLance / prime on the sealed live resolver refuse and open nothing', async () => {
        await assert.rejects(() => resolver.getOrOpen(ws), (e) => isVerbatimResolverSealedError(e));
        await assert.rejects(() => resolver.getOrOpen('never-opened', { touch: false }), (e) => isVerbatimResolverSealedError(e));
        await resolver.swapToLance(ws);
        resolver.prime(ws, boot as never);
        assert.equal(resolver.openCount(), 0);
        assert.equal(counts.init, initBefore);
        assert.equal(counts.close, closeAfterSeal, 'refusals closed nothing either');
    });

    await test('the real drain after the seal completes cleanly (closeAll idempotent, boot store closes)', async () => {
        await lore.dispose();
        assert.equal(counts.init, initBefore, 'the drain opened nothing');
        assert.equal(await boot.count(), 0, 'the boot store is now closed (closed-store semantics unchanged)');
    });
} catch (e) {
    failed++;
    console.error(`  FAIL setup ${(e as Error).stack ?? (e as Error).message}`);
    await lore.dispose().catch(() => undefined);
}

// ---------------------------------------------------------------- B
await test('an open in flight when closeAll runs closes its own handle; closeAll waits; the caller sees the seal', async () => {
    const w = createWorkspace('seal-race-open');
    const r = new WorkspaceVerbatimResolver(provider as never, false, {});
    let release!: () => void;
    initGate = new Promise<void>((res) => { release = res; });
    const init0 = counts.init, close0 = counts.close;
    const opening = r.getOrOpen(w.name).then(() => 'opened' as const, (e: unknown) => e);
    for (let i = 0; i < 200 && counts.init === init0; i++) await sleep(5);
    assert.equal(counts.init, init0 + 1, 'the open reached initialize()');
    let closeAllDone = false;
    const closing = r.closeAll().then(() => { closeAllDone = true; });
    await sleep(50);
    assert.equal(closeAllDone, false, 'closeAll waits for the pending open');
    assert.equal(r.isSealed(), true, 'sealed immediately, before anything is awaited');
    await assert.rejects(() => r.getOrOpen(w.name), (e) => isVerbatimResolverSealedError(e), 'a second caller during the seal is refused');
    release(); initGate = null;
    await closing;
    const res = await opening;
    assert.ok(res !== 'opened' && isVerbatimResolverSealedError(res), 'the racing opener got the sealed error');
    assert.equal(counts.close, close0 + 1, 'the opened-but-untracked store was closed, not leaked');
    assert.equal(r.openCount(), 0);
});

await test('a promotion swap in flight when closeAll runs closes the fresh store and tracks nothing', async () => {
    const w = createWorkspace('seal-race-swap');
    const r = new WorkspaceVerbatimResolver(provider as never, false, {});
    const primed = await r.getOrOpen(w.name);
    assert.equal(r.openCount(), 1);
    let release!: () => void;
    initGate = new Promise<void>((res) => { release = res; });
    const init0 = counts.init, close0 = counts.close;
    const swapping = r.swapToLance(w.name);
    for (let i = 0; i < 200 && counts.init === init0; i++) await sleep(5);
    assert.equal(counts.init, init0 + 1, 'the swap opened its fresh store');
    const closing = r.closeAll();
    await sleep(30);
    release(); initGate = null;
    await closing; await swapping;
    assert.equal(r.openCount(), 0, 'nothing tracked');
    assert.equal(counts.close, close0 + 2, 'fresh swap store closed + the primed store closed by closeAll');
    assert.ok(primed, 'sanity');
});

await test('sealed resolver is inert: getOrOpen refuses (even for a cached name), swap/prime/sweep do nothing, closeAll idempotent', async () => {
    const w = createWorkspace('seal-inert');
    const r = new WorkspaceVerbatimResolver(provider as never, false, {});
    await r.getOrOpen(w.name);
    await r.closeAll();
    const init0 = counts.init;
    await assert.rejects(() => r.getOrOpen(w.name), (e) => isVerbatimResolverSealedError(e));
    await r.swapToLance(w.name);
    r.prime(w.name, {} as never);
    r.startEvictionSweep();
    assert.equal(r.openCount(), 0);
    assert.equal(counts.init, init0);
    await r.closeAll(); // second call: no throw, still sealed
    assert.equal(r.isSealed(), true);
    // a fresh resolver (the next lifecycle) opens normally
    const r2 = new WorkspaceVerbatimResolver(provider as never, false, {});
    assert.ok(await r2.getOrOpen(w.name));
    await r2.closeAll();
});

await test('an unsealed resolver is unchanged: open, cache hit, close one, reopen', async () => {
    const w = createWorkspace('seal-unchanged');
    const r = new WorkspaceVerbatimResolver(provider as never, false, {});
    const a = await r.getOrOpen(w.name);
    assert.equal(await r.getOrOpen(w.name), a);
    assert.equal(await r.closeWorkspace(w.name), true);
    const b = await r.getOrOpen(w.name);
    assert.notEqual(b, a, 'idle/explicit close then reopen still works before the seal');
    await r.closeAll();
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
process.exit(failed > 0 ? 1 : 0);

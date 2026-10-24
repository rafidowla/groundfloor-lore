#!/usr/bin/env tsx
/**
 * verbatim-retired-store-retry-unit.ts - 3.35.3: a write parked behind the promotion write barrier when the
 * SQLite -> LanceDB promotion COMMITS is no longer lost to the caller as a VerbatimStoreRetiredError; it is
 * replayed on the promoted store (SqliteVerbatimStore -> verbatimRetiredRetry.forwardToSuccessor, with the
 * workspace resolver re-resolving the post-swap store).
 *
 * Every scenario drives a REAL promotion (auto-trigger at LORE_VECTOR_PROMOTE_ROWS) and parks the write by
 * starting it from `promotionTestHooks.beforeGate`, i.e. while the barrier is raised and before the gate
 * commits, so the barrier retires it with VerbatimStoreRetiredError exactly as in production.
 *
 *   (a) succeeds on the new store through each caller path:
 *       - the production outbox (`wireOutbox` -> resolveVerbatim -> resolver) - the row replicates, attempts 0
 *       - the MCP bulk-ingest write (`writePrebuiltRowsPerWorkspace`) - no failed result slot
 *       - a stale reference to the retired store (what any holder of the boot-time instance has)
 *       - the node-delete purge helper (`purgeVerbatimRows`) and tombstone
 *       and no copy lands on, or is lost to, the retired file.
 *   (b) bounded: a store that stays retired (no resolver / a resolver that never swaps) surfaces the
 *       original error after the budget, never hangs and never writes to the retired instance.
 *   (c) the outbox never dead-letters on it (transient, attempts not counted), even past maxAttempts.
 *   (d) the replay runs once, and non-retired errors are not retried.
 *
 * Run: npx tsx test/verbatim-retired-store-retry-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import { createWorkspace, getWorkspacePath, setWorkspaceVectorEngine, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { promotionTestHooks } from '../packages/lore/src/engines/verbatimPromotionGate.js';
import { VerbatimStoreRetiredError } from '../packages/lore/src/engines/verbatimWriteBarrier.js';
import { forwardToSuccessor, retiredRetryConfig } from '../packages/lore/src/engines/verbatimRetiredRetry.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { isSqliteOrRetiredTransient } from '../packages/lore/src/outbox/failureDisposition.js';
import { writePrebuiltRowsPerWorkspace, type BulkIngestDeps, type BulkIngestResult } from '../packages/lore/src/mcp/bulkIngest.js';
import { purgeVerbatimRows, type PurgeCapableStore } from '../packages/lore/src/core/verbatimPurge.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-retry-'));
process.env.LORE_HOME = HOME;
process.env.LORE_MODEL_SERVER = '0';
process.env.LORE_VECTOR_PROMOTE_ROWS = '6';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const DIM = 16;
class DetEmbedder implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'retired-retry-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private v(t: string): number[] { const a = new Array(DIM).fill(0.01); for (let i = 0; i < t.length; i++) a[i % DIM] += t.charCodeAt(i) / 128; return a; }
    async embed(t: string) { return this.v(t); }
    async embedQuery(t: string) { return this.v(t); }
    async embedDocument(t: string) { return this.v(t); }
    async embedDocumentBatch(ts: string[]) { return ts.map((t) => this.v(t)); }
}
const provider = new DetEmbedder();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [HOME];

type Mode = 'resolver' | 'boot' | 'stale-resolver';
interface Ctx {
    name: string;
    ws: string;
    sqlite: SqliteVerbatimStore;
    resolver?: WorkspaceVerbatimResolver;
    /** The store a caller gets for the workspace right now. */
    current(): Promise<VerbatimStoreApi>;
}
type Settled = { status: 'fulfilled'; value: unknown } | { status: 'rejected'; reason: unknown };
interface Result { ctx: Ctx; parked: Settled; parkedMs: number }

let seq = 0;
/**
 * Create a 'sqlite'-engine workspace, seed it, trigger the promotion, and start `parkedOp` from inside the
 * gate (barrier raised). Resolves once the parked op settled AND the promotion finished (engine flipped).
 */
async function scenario(mode: Mode, parkedOp: (ctx: Ctx) => Promise<unknown>, prepare?: (ctx: Ctx) => Promise<void>): Promise<Result> {
    const name = createWorkspace(`retired-retry-${++seq}`).name;
    setWorkspaceVectorEngine(name, 'sqlite', HOME);
    const ws = getWorkspacePath(name, HOME);
    let resolver: WorkspaceVerbatimResolver | undefined;
    let sqlite: SqliteVerbatimStore;
    if (mode === 'resolver') {
        resolver = new WorkspaceVerbatimResolver(provider, false, undefined, { home: HOME });
        sqlite = (await resolver.getOrOpen(name)) as unknown as SqliteVerbatimStore;
        assert.ok(sqlite instanceof SqliteVerbatimStore, 'the resolver opened a SQLite store');
    } else {
        // 'boot': no resolver at all (the services.ts boot store). 'stale-resolver': a resolver that never swaps.
        sqlite = new SqliteVerbatimStore(ws, provider, {
            workspaceName: name, home: HOME,
            ...(mode === 'stale-resolver' ? { resolveSuccessor: () => sqlite } : {}),
        });
        await sqlite.initialize();
    }
    const ctx: Ctx = { name, ws, sqlite, resolver, current: async () => (resolver ? resolver.getOrOpen(name, { touch: false }) : sqlite) };
    if (prepare) await prepare(ctx);

    let parked: Promise<Settled> | undefined;
    let started = 0;
    promotionTestHooks.beforeGate = async () => {
        promotionTestHooks.beforeGate = undefined;
        started = Date.now();
        parked = parkedOp(ctx).then((value): Settled => ({ status: 'fulfilled', value }), (reason): Settled => ({ status: 'rejected', reason }));
        await sleep(500); // let the write reach the raised barrier and park before the gate commits
    };
    try {
        for (let i = 0; i < 6; i++) await sqlite.store({ id: `seed${i}`, text: `seed document ${i}`, metadata: {} }); // the 6th write triggers the promotion
        const t0 = Date.now();
        while (!parked) { if (Date.now() - t0 > 20_000) throw new Error('the promotion never reached the gate'); await sleep(20); }
        const settled = await parked;
        const parkedMs = Date.now() - started;
        const t1 = Date.now(); // the promotion finishes (engine flip + swap) after the parked write settles in the failure modes
        while (loadWorkspaces(HOME).workspaces.find((w) => w.name === name)?.vectorEngine !== 'lance') {
            if (Date.now() - t1 > 20_000) throw new Error('the promotion never committed');
            await sleep(20);
        }
        await sleep(150);
        return { ctx, parked: settled, parkedMs };
    } finally {
        promotionTestHooks.beforeGate = undefined;
    }
}

const row = (id: string, text: string): Record<string, unknown> => ({
    id, text, vector: (() => { const a = new Array(DIM).fill(0.01); for (let i = 0; i < text.length; i++) a[i % DIM] += text.charCodeAt(i) / 128; return a; })(),
    type: 'note', label: id, tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-10-24T00:00:00.000Z', security_scopes: [], contentHash: `h-${id}`,
});
const assertOk = (s: Settled): void => assert.equal(s.status, 'fulfilled', s.status === 'rejected' ? `parked write rejected: ${(s.reason as Error).stack}` : '');
async function assertPromotedAndHas(ctx: Ctx, id: string, text: string): Promise<void> {
    assert.ok(ctx.resolver, 'resolver scenario');
    const cur = await ctx.resolver.getOrOpen(ctx.name, { touch: false });
    assert.notEqual(cur, ctx.sqlite as unknown, 'the resolver swapped to the promoted store');
    assert.equal(cur instanceof SqliteVerbatimStore, false, 'the promoted store is not the SQLite one');
    assert.equal((await cur.getById(id))?.text, text, `${id} is in the promoted store`);
    assert.ok((await cur.getById('seed0')), 'promotion carried the seeded rows');
}
async function closeAll(ctx: Ctx): Promise<void> {
    if (ctx.resolver) await ctx.resolver.closeAll().catch(() => undefined);
    await (ctx.sqlite as unknown as { close(): Promise<void> }).close().catch(() => undefined);
}

console.log('(a) a write parked at promotion commit lands on the promoted store');

await test('outbox replay (production wireOutbox -> resolver): the row replicates, attempts 0, never dead, text in the promoted store', async () => {
    const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-retry-ob-')); dirs.push(outboxDir);
    let wiring: ReturnType<typeof wireOutbox> | undefined;
    let rowId = '';
    const r = await scenario('resolver',
        async () => { await wiring!.replicator.tickOnce(); },
        async (ctx) => {
            wiring = wireOutbox({
                loreDir: outboxDir,
                getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
                getVerbatim: () => ctx.sqlite as unknown as VerbatimStoreApi,
                getVerbatimForWorkspace: () => (w: string) => ctx.resolver!.getOrOpen(w),
            });
            const e = await recordHotWrite(wiring.store, {
                workspace: ctx.name, operationKind: 'verbatim.upsert', operation: 'verbatim.upsert',
                payload: { id: 'lore:outbox-1', text: 'outbox write parked at promotion commit', metadata: { updatedAt: '2026-10-24T00:00:00.000Z' } },
            });
            rowId = e.id;
        });
    try {
        assertOk(r.parked);
        const db = (wiring!.store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db;
        const v = db.prepare('SELECT status, attempts, deadReason, lastError FROM outbox_entries WHERE id = ?').get(rowId) as { status: string; attempts: number; deadReason: string | null; lastError: string | null };
        assert.equal(v.status, 'replicated', `outbox row: ${JSON.stringify(v)}`);
        assert.equal(v.attempts, 0);
        assert.equal(v.deadReason, null);
        await assertPromotedAndHas(r.ctx, 'lore:outbox-1', 'outbox write parked at promotion commit');
    } finally { await closeAll(r.ctx); }
});

await test('MCP bulk-ingest write (writePrebuiltRowsPerWorkspace): no failed result slot, row in the promoted store', async () => {
    const slots: BulkIngestResult['results'] = [];
    const r = await scenario('resolver', async (ctx) => {
        const deps = { workspaceVerbatimResolver: ctx.resolver, verbatimStore: ctx.sqlite } as unknown as BulkIngestDeps;
        await writePrebuiltRowsPerWorkspace(deps, [{ node: { workspace: ctx.name, id: 'bulk-1' } as never, idx: 0, row: row('lore:bulk-1', 'bulk ingest row parked at promotion commit') }], slots);
    });
    try {
        assertOk(r.parked);
        assert.equal(slots[0], undefined, `bulk write marked a failure: ${JSON.stringify(slots[0])}`);
        await assertPromotedAndHas(r.ctx, 'lore:bulk-1', 'bulk ingest row parked at promotion commit');
    } finally { await closeAll(r.ctx); }
});

await test('a stale reference to the retired store (a holder of the pre-swap instance): store() succeeds on the promoted store', async () => {
    const r = await scenario('resolver', async (ctx) => ctx.sqlite.store({ id: 'lore:stale-1', text: 'stale-reference write', metadata: {} }));
    try {
        assertOk(r.parked);
        await assertPromotedAndHas(r.ctx, 'lore:stale-1', 'stale-reference write');
    } finally { await closeAll(r.ctx); }
});

await test('node-delete purge helper (purgeVerbatimRows) and tombstone parked at commit are applied to the promoted store', async () => {
    const r = await scenario('resolver',
        async (ctx) => {
            // both start while the barrier is raised, so both park and are retired at the commit
            const [mode] = await Promise.all([
                purgeVerbatimRows(ctx.sqlite as unknown as PurgeCapableStore, ['victim-purge'], 'test purge'),
                ctx.sqlite.tombstone('victim-tomb', 'test tombstone'),
            ]);
            return mode;
        },
        async (ctx) => {
            await ctx.sqlite.store({ id: 'victim-purge', text: 'to be purged', metadata: {} });
            await ctx.sqlite.store({ id: 'victim-tomb', text: 'to be tombstoned', metadata: {} });
        });
    try {
        assertOk(r.parked);
        assert.equal((r.parked as { value: unknown }).value, 'purgeWithHistory');
        const cur = await r.ctx.resolver!.getOrOpen(r.ctx.name, { touch: false });
        assert.equal(await cur.getById('victim-purge'), null, 'purged row is gone from the promoted store');
        assert.match((await cur.getById('victim-tomb'))?.text ?? '', /^\[TOMBSTONED .*reason: test tombstone\]/, 'the tombstone was applied on the promoted store');
    } finally { await closeAll(r.ctx); }
});

console.log('\n(b) bounded: a store that stays retired surfaces the error after the budget');

const savedBudget = retiredRetryConfig.budgetMs;
for (const mode of ['boot', 'stale-resolver'] as const) {
    await test(`${mode}: the original VerbatimStoreRetiredError surfaces after ~budget (not hung, not written to the retired file)`, async () => {
        retiredRetryConfig.budgetMs = 600;
        try {
            const r = await scenario(mode, async (ctx) => ctx.sqlite.store({ id: 'lore:never', text: 'must not be silently applied', metadata: {} }));
            assert.equal(r.parked.status, 'rejected');
            assert.ok((r.parked as { reason: unknown }).reason instanceof VerbatimStoreRetiredError);
            // 'boot' has no resolver, so there is nothing to wait for: it surfaces at once. A resolver that
            // never swaps is waited out for the whole budget (parkedMs also includes the 500 ms parking sleep).
            if (mode === 'stale-resolver') assert.ok(r.parkedMs >= 500 + 550, `waited for the budget (${r.parkedMs} ms)`);
            assert.ok(r.parkedMs < 4000, `bounded (${r.parkedMs} ms)`);
            // not applied anywhere: the retired file is renamed away, the promoted Lance table never saw it
            const lance = new (await import('../packages/lore/src/engines/verbatimStore.js')).VerbatimStore(r.ctx.ws, provider);
            await lance.initialize();
            try { assert.equal(await lance.getById('lore:never'), null); } finally { await lance.close(); }
            await closeAll(r.ctx);
        } finally { retiredRetryConfig.budgetMs = savedBudget; }
    });
}

console.log('\n(c) the outbox never dead-letters on it');

await test('stale store through wireOutbox: row is failed/transient, attempts not counted, past maxAttempts never dead', async () => {
    retiredRetryConfig.budgetMs = 150;
    const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-retry-ob2-')); dirs.push(outboxDir);
    let wiring: ReturnType<typeof wireOutbox> | undefined;
    let rowId = '';
    try {
        const r = await scenario('stale-resolver',
            async () => { await wiring!.replicator.tickOnce(); },
            async (ctx) => {
                wiring = wireOutbox({
                    loreDir: outboxDir,
                    getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
                    getVerbatim: () => ctx.sqlite as unknown as VerbatimStoreApi,
                });
                rowId = (await recordHotWrite(wiring.store, {
                    workspace: ctx.name, operationKind: 'verbatim.upsert', operation: 'verbatim.upsert',
                    payload: { id: 'lore:outbox-2', text: 'will hit a retired store', metadata: { updatedAt: '2026-10-24T00:00:00.000Z' } },
                })).id;
            });
        try {
            assertOk(r.parked); // tickOnce itself does not throw; the row records the failure
            const db = (wiring!.store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } } }).db;
            const view = () => db.prepare('SELECT status, attempts, transientRetries, deadReason, lastError FROM outbox_entries WHERE id = ?').get(rowId) as { status: string; attempts: number; transientRetries: number; deadReason: string | null; lastError: string | null };
            const v = view();
            assert.equal(v.status, 'failed', JSON.stringify(v));
            assert.equal(v.attempts, 0, 'a retired-store error must not burn an attempt');
            assert.equal(v.deadReason, null);
            assert.equal(v.transientRetries, 1);
            assert.match(v.lastError ?? '', /promoted from SQLite to LanceDB/);
            assert.equal(wiring!.replicator.getStats().dead, 0);
            assert.equal(isSqliteOrRetiredTransient(new VerbatimStoreRetiredError('x')), true);
            assert.equal(isSqliteOrRetiredTransient(new Error('UNIQUE constraint failed')), false, 'genuine permanent errors still dead-letter');
        } finally { await closeAll(r.ctx); }
    } finally { retiredRetryConfig.budgetMs = savedBudget; }
});

console.log('\n(d) replay semantics');

await test('forwardToSuccessor: replays exactly once on the successor, waits out a not-yet-swapped store, does not retry other errors', async () => {
    const self = {};
    const calls: unknown[][] = [];
    const successor = { store: async (...a: unknown[]) => { calls.push(a); return 'ok'; } };
    let resolves = 0;
    const out = await forwardToSuccessor<string>(self, () => (++resolves < 3 ? self : successor), new VerbatimStoreRetiredError('p'), 'store', [{ id: 'a' }]);
    assert.equal(out, 'ok');
    assert.deepEqual(calls, [[{ id: 'a' }]], 'replayed once, with the original arguments');
    assert.ok(resolves >= 3, 'kept re-resolving until the store changed');

    const boom = Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
    let n = 0;
    await assert.rejects(forwardToSuccessor(self, () => ({ store: async () => { n++; throw boom; } }), new VerbatimStoreRetiredError('p'), 'store', []), /disk full/);
    assert.equal(n, 1, 'a real failure of the replay is surfaced, not retried');

    await assert.rejects(forwardToSuccessor(self, () => successor, new Error('some other error'), 'store', []), /some other error/);
    assert.equal(calls.length, 1, 'a non-retired error is never replayed');
});

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

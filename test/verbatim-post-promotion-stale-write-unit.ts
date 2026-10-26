#!/usr/bin/env tsx
/**
 * verbatim-post-promotion-stale-write-unit.ts - a write that arrives AFTER a SQLite -> LanceDB promotion committed
 * on an instance that opened BEFORE it must reject (VerbatimStoreRetiredError, nothing applied), never resolve.
 *
 * The barrier's retire() only rejects writers that were PARKED at the commit. A write arriving later on the
 * pre-promotion instance (the daemon's boot store is never swapped; a failed swapToLance keeps the old handle)
 * went straight to its fd on the renamed-away verbatim.sqlite: it resolved, the outbox marked the row replicated,
 * and the row existed nowhere. A real promotion (LORE_VECTOR_PROMOTE_ROWS=6) drives each case.
 *
 * Run: npx tsx test/verbatim-post-promotion-stale-write-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { createWorkspace, getWorkspacePath, setWorkspaceVectorEngine, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { VerbatimStoreRetiredError, currentRetireGeneration } from '../packages/lore/src/engines/verbatimWriteBarrier.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'post-promo-'));
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
    readonly dimension = DIM; readonly modelId = 'post-promo-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private v(t: string): number[] { const a = new Array(DIM).fill(0.01); for (let i = 0; i < t.length; i++) a[i % DIM] += t.charCodeAt(i) / 128; return a; }
    async embed(t: string) { return this.v(t); }
    async embedQuery(t: string) { return this.v(t); }
    async embedDocument(t: string) { return this.v(t); }
    async embedDocumentBatch(ts: string[]) { return ts.map((t) => this.v(t)); }
    vec(t: string): number[] { return this.v(t); }
}
const provider = new DetEmbedder();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let seq = 0;

/** A boot-style SQLite store (no resolver, never swapped) driven through a real promotion. Resolves after the engine flipped to lance. */
async function promotedBootStore(): Promise<{ name: string; ws: string; stale: SqliteVerbatimStore }> {
    const name = createWorkspace(`post-promo-${++seq}`).name;
    setWorkspaceVectorEngine(name, 'sqlite', HOME);
    const ws = getWorkspacePath(name, HOME);
    const stale = new SqliteVerbatimStore(ws, provider, { workspaceName: name, home: HOME });
    await stale.initialize();
    assert.equal(currentRetireGeneration(ws), 0);
    for (let i = 0; i < 6; i++) await stale.store({ id: `seed${i}`, text: `seed document ${i}`, metadata: {} }); // the 6th triggers the promotion
    const t0 = Date.now();
    while (loadWorkspaces(HOME).workspaces.find((w) => w.name === name)?.vectorEngine !== 'lance') {
        if (Date.now() - t0 > 20_000) throw new Error('the promotion never committed');
        await sleep(20);
    }
    await sleep(150);
    assert.equal(currentRetireGeneration(ws), 1, 'the commit bumped the retire generation');
    return { name, ws, stale };
}
async function lanceHas(ws: string, id: string): Promise<boolean> {
    const lance = new VerbatimStore(ws, provider);
    await lance.initialize();
    try { return (await lance.getById(id)) != null; } finally { await lance.close(); }
}

const mutators: Array<{ name: string; call: (s: SqliteVerbatimStore) => Promise<unknown> }> = [
    { name: 'store', call: (s) => s.store({ id: 'late', text: 'late write', metadata: {} }) },
    { name: 'storeBatch', call: (s) => s.storeBatch([{ id: 'late', text: 'late write', metadata: {} }]) },
    { name: 'bulkAddPrebuiltRows', call: (s) => s.bulkAddPrebuiltRows([{ id: 'late', text: 'late write', vector: provider.vec('late write'), type: 'note', label: 'late', tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-10-24T00:00:00.000Z', security_scopes: [], contentHash: 'h-late' }]) },
    { name: 'tombstone', call: (s) => s.tombstone('seed0', 'late tombstone') },
    { name: 'physicalDelete', call: (s) => s.physicalDelete('seed0') },
    { name: 'purgeWithHistory', call: (s) => s.purgeWithHistory(['seed0']) },
];

for (const m of mutators) {
    await test(`${m.name}() on the pre-promotion instance after the commit rejects with VerbatimStoreRetiredError`, async () => {
        const { stale } = await promotedBootStore();
        try {
            await assert.rejects(() => m.call(stale), (e: unknown) => {
                assert.ok(e instanceof VerbatimStoreRetiredError, `wrong error: ${(e as Error).name}`);
                assert.equal((e as VerbatimStoreRetiredError).applied, false);
                return true;
            }, `${m.name}() resolved: the write went into the renamed-away SQLite file and was lost`);
        } finally { await stale.close().catch(() => undefined); }
    });
}

await test('the late write is not on the promoted Lance table either (nothing silently applied elsewhere)', async () => {
    const { ws, stale } = await promotedBootStore();
    try {
        await stale.store({ id: 'late', text: 'late write', metadata: {} }).catch(() => undefined);
        assert.equal(await lanceHas(ws, 'late'), false);
        assert.equal(await lanceHas(ws, 'seed0'), true, 'promotion carried the seed rows');
    } finally { await stale.close().catch(() => undefined); }
});

await test('outbox replay into the stale boot store is NOT marked replicated (transient, attempts 0), so it is retried against the promoted store', async () => {
    const { name, stale } = await promotedBootStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-promo-ob-'));
    try {
        const wiring = wireOutbox({
            loreDir: dir,
            getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
            getVerbatim: () => stale as unknown as VerbatimStoreApi,
        });
        const e = await recordHotWrite(wiring.store, {
            workspace: name, operationKind: 'verbatim.upsert', operation: 'verbatim.upsert',
            payload: { id: 'lore:late-outbox', text: 'outbox write after the commit', metadata: { updatedAt: '2026-10-24T00:00:00.000Z' } },
        });
        await wiring.replicator.tickOnce();
        const db = (wiring.store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db;
        const v = db.prepare('SELECT status, attempts, deadReason FROM outbox_entries WHERE id = ?').get(e.id) as { status: string; attempts: number; deadReason: string | null };
        assert.notEqual(v.status, 'replicated', `row marked replicated although nothing was written: ${JSON.stringify(v)}`);
        assert.equal(v.attempts, 0);
        assert.equal(v.deadReason, null);
    } finally { await stale.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('an instance opened AFTER the commit carries the current generation and is not stale', async () => {
    const { ws, stale } = await promotedBootStore();
    await stale.close().catch(() => undefined);
    const fresh = new SqliteVerbatimStore(ws, provider);
    await fresh.initialize();
    try {
        await fresh.store({ id: 'ok-after', text: 'opened after the commit', metadata: {} });
        assert.equal((await fresh.getById('ok-after'))?.text, 'opened after the commit');
    } finally { await fresh.close(); }
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env tsx
/**
 * cloud-verbatim-delete-parity-unit.ts — cloud parity Slice C review #8.
 *
 * Local `VerbatimStore.delete(id)` is a TOMBSTONE (snapshot + `[TOMBSTONED …]` canonical row, history
 * kept); `physicalDelete(id)` is the hard delete used by the orphan sweeper / half-completion reaper.
 * The cloud store used to hard-delete in `delete()` (history snapshots left behind, unreachable
 * from the canonical row) and had no `physicalDelete` at all. Same script, run against the REAL local
 * store and the cloud store, must give the same observable result.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startCloudFixture, DP_WORKSPACE, bagOfWordsEmbedder } from './helpers/cloud-stores-fixture.js';
import { makeVerbatimStore } from './helpers/testVerbatimStore.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WS = 'del-ws';
const ID = 'lore:del-1';
const meta = { type: 'note', label: 'l', tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-09-01T00:00:00.000Z', security_scopes: [] as string[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The slice of the verbatim store surface both engines share. */
interface Store {
    store(d: { id: string; text: string; metadata: typeof meta }): Promise<void>;
    delete(id: string): Promise<void>;
    physicalDelete(id: string): Promise<void>;
    physicalDeleteMany(ids: string[]): Promise<number>;
    getById(id: string): Promise<{ id: string; text?: string } | null>;
    getHistory(id: string): Promise<Array<{ id: string; text: string; isTombstone?: boolean; isCanonical?: boolean }>>;
    bm25Search(q: string, n: number): Promise<{ hits: Array<{ id: string }> }>;
}

/** Everything observable, with timestamps normalised away. */
async function scenario(s: Store): Promise<Record<string, unknown>> {
    const norm = (t: string) => t.replace(/\[TOMBSTONED [^ ]+ reason:/, '[TOMBSTONED <ts> reason:');
    const out: Record<string, unknown> = {};
    await s.store({ id: ID, text: 'alpha ledger text', metadata: meta });
    await sleep(5);
    await s.store({ id: ID, text: 'beta ledger text', metadata: meta });
    await sleep(5);
    await s.delete(ID);
    const row = await s.getById(ID);
    out['canonicalAfterDelete'] = row ? norm(row.text ?? '') : null;
    const hist = await s.getHistory(ID);
    out['historyAfterDelete'] = hist.map((h) => ({ canonical: !!h.isCanonical, tombstone: !!h.isTombstone, text: norm(h.text) }));
    out['searchAfterDelete'] = (await s.bm25Search('ledger', 10)).hits.filter((h) => h.id === ID).length;
    await sleep(5);
    await s.delete(ID); // already tombstoned: a no-op
    out['historyLenAfterSecondDelete'] = (await s.getHistory(ID)).length;
    await s.delete('lore:never-existed'); // absent: a no-op, no throw
    out['absentDeleteOk'] = true;
    await s.physicalDelete(ID); // hard delete: the canonical row goes, snapshots stay (local `id = ?` delete)
    out['canonicalAfterPhysical'] = await s.getById(ID);
    out['historyAfterPhysical'] = (await s.getHistory(ID)).map((h) => ({ canonical: !!h.isCanonical, text: norm(h.text) }));
    await s.store({ id: 'lore:del-2', text: 'gamma', metadata: meta });
    await s.store({ id: 'lore:del-3', text: 'delta', metadata: meta });
    out['manyDeleted'] = (await s.physicalDeleteMany(['lore:del-2', 'lore:del-3', 'lore:del-4'])) >= 2;
    out['manyGone'] = [await s.getById('lore:del-2'), await s.getById('lore:del-3')];
    return out;
}

console.log('cloud parity C review #8: delete() is a tombstone like local');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'del-parity-'));
const fx = await startCloudFixture();
try {
    const local = makeVerbatimStore(dir, bagOfWordsEmbedder());
    await local.initialize();
    const cloud: Store = new Proxy(fx.vector as unknown as Store, {
        get: (t, k) => {
            const v = (t as never)[k as never] as unknown;
            return typeof v === 'function' ? (...a: unknown[]) => fx.as(WS, () => (v as (...x: unknown[]) => Promise<unknown>).apply(t, a)) : v;
        },
    });
    let localOut: Record<string, unknown> = {};
    let cloudOut: Record<string, unknown> = {};
    await test('local reference run: delete tombstones, history survives, physicalDelete removes the canonical row', async () => {
        localOut = await scenario(local as unknown as Store);
        assert.match(String(localOut['canonicalAfterDelete']), /^\[TOMBSTONED <ts> reason: legacy verbatim\.delete\(\) call/);
        assert.equal((localOut['historyAfterDelete'] as unknown[]).length, 3, 'tombstone + 2 snapshots');
        assert.equal(localOut['canonicalAfterPhysical'], null);
    });
    await test('cloud run matches the local run observation for observation', async () => {
        cloudOut = await scenario(cloud);
        assert.deepEqual(cloudOut, localOut);
    });
    await test('cloud keeps the snapshot rows after delete (nothing is lost)', async () => {
        const rows = fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').filter((r) => r['lore_workspace'] === WS && String(r['lore_id']).startsWith(`${ID}#rev`));
        assert.equal(rows.length, 2, 'both snapshots (v1 and v2) are still stored after delete + physicalDelete');
    });
    await local.close?.();
} finally {
    await fx.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env tsx
/**
 * cloud-batch-failure-unit.ts — cloud parity Slice C review #9.
 *
 *   - A failing chunk of a verbatim batch stops the rest and reports WHICH ids were not written
 *     (VerbatimBatchWriteError.notWritten, and the ids in the message the store rethrows).
 *   - Change-only groups (no transaction form) are written BEFORE the chunks, so a chunk failure can
 *     no longer leave them silently unwritten.
 *   - `<id>#rev<ts>` ids stay regex-compatible and sortable but a same-ms collision between two
 *     processes no longer loses a snapshot: the atomic path retries the chunk under a bumped
 *     timestamp, the separate-write path never overwrites an existing snapshot.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_WORKSPACE, ORG_ID } from './helpers/cloud-stores-fixture.js';
import { scopeRowFields } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { VerbatimBatchWriteError, writeSnapshotGroups, type SnapshotGroup } from '../packages/lore/src/engines/dataplaneVerbatimHistory.js';
import { isRevisionHistoryId } from '../packages/lore/src/engines/verbatimHistory.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('cloud parity C review #9: batch failure reporting and revision-id collisions');

/* ─── writeSnapshotGroups with a scripted runner ─────────────────────────── */
type Outcome = 'committed' | 'unavailable' | 'throw';
function scripted(outcomes: Outcome[]) {
    const log: string[] = [];
    let call = 0;
    const runner = {
        tryCommit: async (_t: string, ops: unknown[]): Promise<'committed' | 'unavailable'> => {
            const o = outcomes[call++] ?? 'committed';
            log.push(`tx${call}:${ops.length}`);
            if (o === 'throw') throw new Error('boom: engine unreachable');
            return o;
        },
        recordHistoryFailure: () => undefined,
    };
    const group = (id: string, nOps: number): SnapshotGroup => ({
        id, what: `verbatim:${id}`,
        ops: Array.from({ length: nOps }, () => ({ op: 'create', collection: 'c', fields: {} }) as never),
        change: async () => { log.push(`change:${id}`); },
        history: async () => { log.push(`history:${id}`); },
        rebuild: () => group(id, nOps),
    });
    return { runner: runner as never, log, group };
}

await test('change-only groups are written before any chunk, and a chunk failure reports the ids not written', async () => {
    const s = scripted(['committed', 'throw']);
    const groups = [s.group('a', 100), s.group('b', 100), s.group('c', 100), s.group('only1', 0), s.group('only2', 0)];
    const err = await writeSnapshotGroups(s.runner, 'dp', groups, 2).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof VerbatimBatchWriteError, String(err));
    assert.deepEqual([...err.notWritten].sort(), ['b', 'c']);
    assert.match(err.message, /boom: engine unreachable/);
    assert.match(err.message, /not written: b, c/);
    assert.ok(s.log.includes('change:only1') && s.log.includes('change:only2'), `change-only groups were written: ${s.log.join(',')}`);
    const firstTx = s.log.findIndex((l) => l.startsWith('tx'));
    assert.ok(s.log.indexOf('change:only1') < firstTx && s.log.indexOf('change:only2') < firstTx, 'before the first chunk');
    assert.ok(!s.log.some((l) => l === 'tx3:100'), 'nothing was attempted after the failing chunk');
});

await test('an unavailable chunk is written separately, then a later failure reports only what is still unwritten', async () => {
    const s = scripted(['unavailable', 'throw']);
    const groups = [s.group('a', 100), s.group('b', 100), s.group('c', 100)];
    const err = await writeSnapshotGroups(s.runner, 'dp', groups, 2).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof VerbatimBatchWriteError);
    assert.deepEqual([...err.notWritten].sort(), ['b', 'c']);
    assert.ok(s.log.includes('change:a') && s.log.includes('history:a'), 'chunk 1 went through the separate path');
});

await test('a failing separate write reports the groups that did not complete', async () => {
    const s = scripted(['unavailable']);
    const groups = [s.group('a', 2), s.group('b', 2)];
    groups[1]!.change = async () => { throw new Error('write refused'); };
    const err = await writeSnapshotGroups(s.runner, 'dp', groups, 1).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof VerbatimBatchWriteError);
    assert.deepEqual([...err.notWritten], ['b']);
    assert.match(err.message, /write refused/);
});

/* ─── the store, over the mock ───────────────────────────────────────────── */
const WS = 'batch-failure-ws';
const meta = { type: 'note', label: 'l', tags: '', project: 'p', ecosystem: 'e', updatedAt: '2026-09-01T00:00:00.000Z', security_scopes: [] };
const doc = (id: string, text: string) => ({ id, text, metadata: meta });
const scope = { orgId: ORG_ID, dataplaneWorkspaceId: DP_WORKSPACE, loreWorkspace: WS } as never;

{
    let txCalls = 0;
    let failTxCall = 0;
    const wrap = (c: any): any => new Proxy(c, {
        get(t, p) {
            if (p === 'transaction') return (...a: unknown[]) => {
                if (++txCalls === failTxCall) return Promise.reject(Object.assign(new Error('engine unreachable'), { statusCode: 500 }));
                return t.transaction(...a);
            };
            const v = t[p];
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
    const fx = await startCloudFixture({}, { wrapClient: wrap });
    const textOf = (id: string) => fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').find((r) => r['lore_workspace'] === WS && r['lore_id'] === id)?.['text'];
    try {
        await test('store: a failing second chunk leaves chunk 1 written, names the unwritten ids, and writes nothing after', async () => {
            const ids = Array.from({ length: 120 }, (_, i) => `bf${String(i).padStart(3, '0')}`);
            await fx.as(WS, () => fx.vector.storeBatch(ids.map((id) => doc(id, `old ${id}`)) as never));
            txCalls = 0;
            failTxCall = 2; // 120 groups x 2 ops = 3 chunks (50 + 50 + 20 groups)
            let err: Error | undefined;
            try { await fx.as(WS, () => fx.vector.storeBatch(ids.map((id) => doc(id, `new ${id}`)) as never)); } catch (e) { err = e as Error; }
            failTxCall = 0;
            assert.ok(err, 'the batch failed');
            assert.match(err!.message, /engine unreachable/);
            assert.match(err!.message, /70 .*not written/);
            assert.ok(err!.message.includes('bf050') && err!.message.includes('bf119'), err!.message);
            assert.equal(textOf('bf000'), 'new bf000', 'chunk 1 committed');
            assert.equal(textOf('bf049'), 'new bf049');
            assert.equal(textOf('bf050'), 'old bf050', 'chunk 2 not applied');
            assert.equal(textOf('bf119'), 'old bf119', 'chunk 3 never attempted');
            assert.equal(txCalls, 2, 'no chunk after the failing one was sent');
        });
    } finally { await fx.close(); }
}

/* ─── revision-id collisions ─────────────────────────────────────────────── */
const realNow = Date.now;
const withFixedClock = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
    Date.now = () => ms;
    try { return await fn(); } finally { Date.now = realNow; }
};
const REV = /#rev\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

for (const [label, opts, hours] of [['atomic transaction', {}, 1], ['separate-write fallback (no /v1/transaction)', { transactions: false }, 2]] as const) {
    const fx = await startCloudFixture(opts);
    const snaps = (id: string) => fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').filter((r) => r['lore_workspace'] === WS && String(r['lore_id']).startsWith(`${id}#rev`));
    try {
        await test(`a snapshot id taken by another process in the same ms is not overwritten (${label})`, async () => {
            const T = realNow() + hours * 3_600_000;
            await fx.as(WS, () => fx.vector.store(doc('col1', 'version one') as never));
            // Another process's snapshot of col1, taken at exactly the ms this process is about to use.
            const foreignId = `col1#rev${new Date(T).toISOString()}`;
            await fx.rawClient.insert(DP_WORKSPACE, 'lore_verbatim', {
                ...scopeRowFields(scope, foreignId), text: 'foreign snapshot', vector: new Array(16).fill(0), updated_at: '2026-09-01T00:00:00.000Z',
            });
            await withFixedClock(T, () => fx.as(WS, () => fx.vector.storeBatch([doc('col1', 'version two')] as never)));
            const rows = snaps('col1');
            assert.equal(rows.length, 2, `both snapshots exist: ${rows.map((r) => r['lore_id']).join(', ')}`);
            assert.ok(rows.some((r) => r['text'] === 'foreign snapshot'), 'the other process snapshot is intact');
            assert.ok(rows.some((r) => r['text'] === 'version one'), 'ours holds the previous content');
            for (const r of rows) assert.ok(REV.test(String(r['lore_id'])) && isRevisionHistoryId(String(r['lore_id'])), `rev id shape: ${r['lore_id']}`);
            assert.equal(fx.mock.rows(DP_WORKSPACE, 'lore_verbatim').find((r) => r['lore_workspace'] === WS && r['lore_id'] === 'col1')?.['text'], 'version two');
            const history = await fx.as(WS, () => fx.vector.getHistory('col1'));
            assert.equal(history.length, 3, 'canonical + 2 snapshots');
        });
    } finally { await fx.close(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

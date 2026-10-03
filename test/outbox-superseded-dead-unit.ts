#!/usr/bin/env tsx
/**
 * outbox-superseded-dead-unit.ts — RA-6 superseded rows are not data loss.
 *
 * THE BUG (reported by the Atlas host on Lore 3.25.0): every start logged
 * `NOTE: N dead-lettered row(s) already in the outbox at startup. Those writes
 * are NOT on the substrate.` — but 63 of Atlas's 65 such rows were parked by the
 * RA-6 guard with `lastError = 'superseded by newer same-key write (RA-6)'`: a
 * LATER write of the same key replaced them, so nothing is missing. The warning
 * read as data loss, the rows are never cleared, and it repeated forever. At
 * runtime the same rows also raised a false per-tick `DATA LOSS` line, because
 * `aggregateStats().dead` counts every status='dead' row.
 *
 * What this pins:
 *   A. Store stats split the dead total: `dead` stays the total, `deadSuperseded`
 *      is the RA-6 subset — recognised from the EXISTING `lastError` text, so a
 *      row written by an older build (no new status, no migration) is counted.
 *   B. The legacy JSON store reports the same split.
 *   C. requeue-dead / drain-failed behaviour for superseded rows is unchanged:
 *      they are NOT replayed — a requeued superseded row is re-parked by the
 *      guard, its payload is never dispatched.
 *   D. End to end through a real replicator: marking a row superseded at runtime
 *      raises no `DATA LOSS`; a startup backlog of only-superseded rows raises no
 *      `NOTE`; a genuinely failed dead row still raises the existing warnings.
 *
 * Run: npx tsx test/outbox-superseded-dead-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { OutboxReplicator } from '../packages/lore/src/outbox/replicator.js';
import { SUPERSEDED_DEAD_ERROR, isSupersededDeadError } from '../packages/lore/src/outbox/supersession.js';
import type { DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}

/** The exact text older builds already wrote into existing outbox files. */
const LEGACY_SUPERSEDED_TEXT = 'superseded by newer same-key write (RA-6)';
const SCHEMA_ERR = 'Found field not in schema: metadata.type at row 0';

const NOW = '2026-07-05T00:00:00.000Z';
let seq = 0;
function baseEntry(over: Partial<OutboxEntry> & { id: string }): OutboxEntry {
    return {
        operation: 'op', initiator: 'test:superseded-dead', createdAt: NOW, updatedAt: NOW,
        steps: [], completed: false, ...over,
    };
}

/** A row already 'dead' with the given error, driven through the real state machine. */
async function seedDead(store: SqliteOutboxStore, workspace: string, error: string, key = `k${++seq}`): Promise<string> {
    const id = `dead-${++seq}`;
    await store.record(baseEntry({
        id, workspace, operationKind: 'node.upsert', payload: { id: key }, status: 'pending', attempts: 0,
    }));
    await store.markEntryStatus(id, 'dead', { error, bumpAttempt: true });
    return id;
}

/** Overwrite a row's lastError with raw SQL — models a row an OLDER build wrote. */
function stampLegacyError(store: SqliteOutboxStore, id: string, error: string): void {
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } })
        .db.prepare(`UPDATE outbox_entries SET status = 'dead', lastError = ? WHERE id = ?`).run(error, id);
}

function makeReplicator(store: SqliteOutboxStore, opts: { maxAttempts?: number } = {}) {
    const logs: string[] = [];
    const dispatched: string[] = [];
    const substrates: DispatcherSubstrates = {
        async upsertNode(payload) {
            const id = String(payload['id']);
            if (id.startsWith('BAD')) throw new Error('substrate rejected write');
            dispatched.push(`node.upsert:${id}`);
        },
        async deleteNode(id) { dispatched.push(`node.delete:${id}`); },
    };
    const replicator = new OutboxReplicator({
        store, substrates,
        config: { selfHealGraceMs: 0, pruneReplicatedOlderThanMs: 0, ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}) },
        log: (m: string) => { logs.push(m); },
    });
    return { replicator, logs, dispatched };
}

/** A failed row with a PAST nextAttemptAt (expired backoff) so the next tick retries it. */
async function plantFailedRetryable(store: SqliteOutboxStore, e: Partial<OutboxEntry> & { id: string }): Promise<void> {
    await store.record(baseEntry(e));
    await store.markEntryStatus(e.id, 'failed', { error: 'injected transient failure', bumpAttempt: true });
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } })
        .db.prepare(`UPDATE outbox_entries SET nextAttemptAt = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', e.id);
}

async function plantReplicated(store: SqliteOutboxStore, e: Partial<OutboxEntry> & { id: string }): Promise<void> {
    await store.record(baseEntry(e));
    await store.markEntryStatus(e.id, 'replicated');
}

async function statusOf(store: SqliteOutboxStore, id: string): Promise<string | undefined> {
    const dead = await store.listDead({ limit: 10000 });
    if (dead.some((e) => e.id === id)) return 'dead';
    return (await store.listUnfinished()).find((e) => e.id === id)?.status;
}

async function main(): Promise<void> {
    console.log('outbox: RA-6 superseded dead rows are not counted as dead-letters');

    // ── marker constant ─────────────────────────────────────────────────────
    await test('the marker text is unchanged (existing outbox files already hold exactly this)', () => {
        assert.equal(SUPERSEDED_DEAD_ERROR, LEGACY_SUPERSEDED_TEXT);
        assert.equal(isSupersededDeadError(LEGACY_SUPERSEDED_TEXT), true);
        assert.equal(isSupersededDeadError(`${LEGACY_SUPERSEDED_TEXT} and then some`), false, 'exact match only');
        assert.equal(isSupersededDeadError(SCHEMA_ERR), false);
        assert.equal(isSupersededDeadError(undefined), false);
        assert.equal(isSupersededDeadError(null), false);
    });

    // ── A. SQLite store stats ───────────────────────────────────────────────
    await test('A: statsByWorkspace/aggregateStats keep `dead` as the total and add `deadSuperseded`', async () => {
        const store = new SqliteOutboxStore(tmp('outbox-sup-a-'));
        const legacy1 = await seedDead(store, 'ws-a', 'placeholder');
        const legacy2 = await seedDead(store, 'ws-a', 'placeholder');
        // Rows an older build parked: status dead + the exact marker text.
        stampLegacyError(store, legacy1, LEGACY_SUPERSEDED_TEXT);
        stampLegacyError(store, legacy2, LEGACY_SUPERSEDED_TEXT);
        await seedDead(store, 'ws-a', SCHEMA_ERR);                                 // genuine
        await seedDead(store, 'ws-a', `${LEGACY_SUPERSEDED_TEXT} — retry exhausted`); // look-alike, genuine
        await seedDead(store, 'ws-b', SUPERSEDED_DEAD_ERROR);                       // written by this build

        const agg = await store.aggregateStats();
        assert.equal(agg.dead, 5, 'dead is still the TOTAL');
        assert.equal(agg.deadSuperseded, 3, 'only exact-marker rows are superseded');
        assert.equal(agg.perWorkspace['ws-a'].dead, 4);
        assert.equal(agg.perWorkspace['ws-a'].deadSuperseded, 2);
        assert.equal(agg.perWorkspace['ws-b'].dead, 1);
        assert.equal(agg.perWorkspace['ws-b'].deadSuperseded, 1);
    });

    await test('A: a workspace with no dead rows reports no dead or superseded', async () => {
        const store = new SqliteOutboxStore(tmp('outbox-sup-a0-'));
        await store.record(baseEntry({ id: 'p1', workspace: 'ws-a', operationKind: 'node.upsert', payload: { id: 'x' }, status: 'pending' }));
        const agg = await store.aggregateStats();
        assert.equal(agg.dead, 0);
        assert.equal(agg.deadSuperseded ?? 0, 0);
    });

    // ── B. JSON store parity ────────────────────────────────────────────────
    await test('B: the legacy JSON store reports the same split', async () => {
        const store = new FileOutboxStore(tmp('outbox-sup-b-'));
        for (const [id, err] of [['j1', SUPERSEDED_DEAD_ERROR], ['j2', SCHEMA_ERR]] as const) {
            await store.record(baseEntry({ id, workspace: 'ws-j', operationKind: 'node.upsert', payload: { id }, status: 'pending' }));
            await store.markEntryStatus(id, 'dead', { error: err, bumpAttempt: true });
        }
        const agg = await store.aggregateStats();
        assert.equal(agg.dead, 2);
        assert.equal(agg.deadSuperseded, 1);
    });

    // ── C. requeue-dead / drain-failed unchanged ────────────────────────────
    await test('C: requeueDead still returns superseded rows to the queue (unchanged), and the guard re-parks them without dispatching', async () => {
        const store = new SqliteOutboxStore(tmp('outbox-sup-c-'));
        const { replicator, dispatched } = makeReplicator(store);
        const ws = 'ws-c';
        // older failed upsert X (will be parked) + newer replicated upsert X
        await plantFailedRetryable(store, { id: 'old', workspace: ws, operationKind: 'node.upsert', payload: { id: 'X' }, sequenceId: 1 });
        await plantReplicated(store, { id: 'new', workspace: ws, operationKind: 'node.upsert', payload: { id: 'X' }, sequenceId: 3 });
        await replicator.tickOnce();
        assert.equal(await statusOf(store, 'old'), 'dead');
        assert.equal((await store.listDead())[0].lastError, SUPERSEDED_DEAD_ERROR, 'the runtime writer uses the shared constant');

        // operator requeues with no filter: the row goes back to 'failed' as today
        assert.equal(await store.requeueDead(), 1);
        assert.equal(await statusOf(store, 'old'), 'failed');
        assert.equal((await store.aggregateStats()).deadSuperseded, 0, 'while requeued it is not a dead row');

        // making the requeued row retryable and ticking: the RA-6 guard parks it again, nothing is replayed
        (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } })
            .db.prepare(`UPDATE outbox_entries SET nextAttemptAt = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', 'old');
        await replicator.tickOnce();
        assert.deepEqual(dispatched, [], 'a superseded row is never replayed');
        assert.equal(await statusOf(store, 'old'), 'dead');
        assert.equal((await store.aggregateStats()).deadSuperseded, 1);
    });

    await test('C: requeueDead --error-contains for another incident leaves superseded rows dead (unchanged)', async () => {
        const store = new SqliteOutboxStore(tmp('outbox-sup-c2-'));
        const sup = await seedDead(store, 'ws-c', SUPERSEDED_DEAD_ERROR);
        const gen = await seedDead(store, 'ws-c', SCHEMA_ERR);
        assert.equal(await store.requeueDead({ errorContains: 'metadata.type' }), 1);
        assert.equal(await statusOf(store, sup), 'dead');
        assert.equal(await statusOf(store, gen), 'failed');
    });

    await test('C: drain-failed sweep scope (listFailedOlderThan includeDead) still lists superseded dead rows, default still does not', async () => {
        const store = new SqliteOutboxStore(tmp('outbox-sup-c3-'));
        const sup = await seedDead(store, 'ws-c', SUPERSEDED_DEAD_ERROR);
        const deflt = await store.listFailedOlderThan(0, {});
        assert.equal(deflt.some((e) => e.id === sup), false, 'routine self-heal never sees dead rows');
        const operator = await store.listFailedOlderThan(0, { includeDead: true });
        assert.equal(operator.some((e) => e.id === sup), true, 'the operator drain still does');
    });

    // ── D. replicator end to end ────────────────────────────────────────────
    await test('D: marking a row superseded at runtime logs no DATA LOSS', async () => {
        const store = new SqliteOutboxStore(tmp('outbox-sup-d1-'));
        const { replicator, logs } = makeReplicator(store);
        await replicator.tickOnce();                 // baseline: nothing dead
        await plantFailedRetryable(store, { id: 'old', workspace: 'ws-d', operationKind: 'node.upsert', payload: { id: 'X' }, sequenceId: 1 });
        await plantReplicated(store, { id: 'new', workspace: 'ws-d', operationKind: 'node.upsert', payload: { id: 'X' }, sequenceId: 3 });
        await replicator.tickOnce();
        assert.equal(await statusOf(store, 'old'), 'dead', 'precondition: the row was parked');
        assert.ok(logs.some((l) => /skipped: superseded by newer same-key write/.test(l)), 'the per-row skip line is still logged');
        assert.deepEqual(logs.filter((l) => /DATA LOSS|NOTE:|STILL CLIMBING/.test(l)), []);
    });

    await test('D: a startup backlog of only superseded rows logs no NOTE; mixed backlog counts only the genuine ones', async () => {
        const onlySup = new SqliteOutboxStore(tmp('outbox-sup-d2-'));
        for (let i = 0; i < 4; i++) await seedDead(onlySup, 'ws-d', SUPERSEDED_DEAD_ERROR);
        const a = makeReplicator(onlySup);
        await a.replicator.tickOnce();
        assert.deepEqual(a.logs.filter((l) => /DATA LOSS|NOTE:/.test(l)), []);

        const mixed = new SqliteOutboxStore(tmp('outbox-sup-d3-'));
        for (let i = 0; i < 4; i++) await seedDead(mixed, 'ws-d', SUPERSEDED_DEAD_ERROR);
        await seedDead(mixed, 'ws-d', SCHEMA_ERR);
        await seedDead(mixed, 'ws-d', SCHEMA_ERR);
        const b = makeReplicator(mixed);
        await b.replicator.tickOnce();
        const notes = b.logs.filter((l) => /NOTE:/.test(l));
        assert.equal(notes.length, 1);
        assert.match(notes[0], /NOTE: 2 dead-lettered row\(s\) already in the outbox at startup\. Those writes are NOT on the substrate\./);
    });

    await test('D: a genuinely failed row still raises the existing DATA LOSS warning', async () => {
        const store = new SqliteOutboxStore(tmp('outbox-sup-d4-'));
        const { replicator, logs } = makeReplicator(store, { maxAttempts: 1 });
        await replicator.tickOnce();                 // baseline
        await store.record(baseEntry({ id: 'bad', workspace: 'ws-d', operationKind: 'node.upsert', payload: { id: 'BAD1' }, status: 'pending', sequenceId: 1 }));
        await replicator.tickOnce();
        assert.equal(await statusOf(store, 'bad'), 'dead');
        const loss = logs.filter((l) => /DATA LOSS/.test(l));
        assert.equal(loss.length, 1);
        assert.match(loss[0], /DATA LOSS: 1 write\(s\) permanently discarded since the last check \(1 dead-lettered in total\)/);
    });

    await test('D: supersessions alongside one genuine failure: the delta counts only the genuine write', async () => {
        const store = new SqliteOutboxStore(tmp('outbox-sup-d5-'));
        const { replicator, logs } = makeReplicator(store, { maxAttempts: 1 });
        await replicator.tickOnce();
        await plantFailedRetryable(store, { id: 'old', workspace: 'ws-d', operationKind: 'node.upsert', payload: { id: 'Z' }, sequenceId: 1 });
        await plantReplicated(store, { id: 'new', workspace: 'ws-d', operationKind: 'node.upsert', payload: { id: 'Z' }, sequenceId: 3 });
        await store.record(baseEntry({ id: 'bad', workspace: 'ws-d', operationKind: 'node.upsert', payload: { id: 'BAD2' }, status: 'pending', sequenceId: 4 }));
        await replicator.tickOnce();
        const loss = logs.filter((l) => /DATA LOSS/.test(l));
        assert.equal(loss.length, 1);
        assert.match(loss[0], /DATA LOSS: 1 write\(s\) .*\(1 dead-lettered in total\)/);
    });

    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

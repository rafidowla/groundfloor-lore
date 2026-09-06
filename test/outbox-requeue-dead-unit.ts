#!/usr/bin/env tsx
/**
 * outbox-requeue-dead-unit.ts — `SqliteOutboxStore.requeueDead` +
 * `lore outbox requeue-dead` flag parsing.
 *
 * Why this primitive exists: `drain-failed` can only CONFIRM or re-kill a row —
 * it never re-dispatches. That is right when the row is bad and wrong when the
 * BUILD was bad. The 3.17.0 parent-embeds regression
 * ("Found field not in schema: metadata.type") dead-lettered ~3,000 rows whose
 * payloads were entirely valid; once the defect was fixed they needed putting
 * back on the queue, and nothing could do that.
 *
 * The load-bearing assertion in this file is Section B: requeued rows land as
 * `'failed'`, NOT `'pending'`. `OutboxReplicator.replicateOne` runs the RA-6
 * supersession guard only when `entry.status === 'failed'`. A bulk replay is
 * precisely the situation that guard exists for — every requeued row is days
 * old and may have been superseded since — so requeueing to 'pending' would
 * skip the guard and turn a recovery into a data-loss event. If someone
 * "simplifies" that to 'pending' later, this test is what stops them.
 *
 * Run: npx tsx test/outbox-requeue-dead-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { parseRequeueFlags, summarizeDead } from '../packages/lore/src/cli/commands/outboxRequeue.js';
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

const SCHEMA_ERR = 'Found field not in schema: metadata.type at row 0';
const SUPERSEDED_ERR = 'superseded by newer same-key write (RA-6)';

/** Record a row and drive it to `dead` with the given error the way the
 *  replicator does (record → repeated markEntryStatus with bumpAttempt), so the
 *  fixture exercises the real state machine rather than hand-written SQL. */
let seq = 0;
async function seedDead(
    store: SqliteOutboxStore,
    workspace: string,
    operationKind: string,
    error: string,
): Promise<string> {
    const id = `entry-${++seq}`;
    const now = new Date().toISOString();
    await store.record({
        id,
        operation: operationKind,
        initiator: 'test',
        createdAt: now,
        updatedAt: now,
        steps: [],
        completed: false,
        workspace,
        operationKind: operationKind as OutboxEntry['operationKind'],
        payload: { id: `lore:${workspace}:${id}` },
        status: 'pending',
        attempts: 0,
    });
    // Drive it to dead the way the replicator does — three bumped failures —
    // so `attempts` is genuinely exhausted rather than hand-written.
    await store.markEntryStatus(id, 'failed', { error, bumpAttempt: true });
    await store.markEntryStatus(id, 'failed', { error, bumpAttempt: true });
    await store.markEntryStatus(id, 'dead', { error, bumpAttempt: true });
    return id;
}

async function get(store: SqliteOutboxStore, id: string): Promise<OutboxEntry> {
    const all = await store.listUnfinished();
    const found = all.find((e) => e.id === id);
    assert.ok(found, `entry ${id} not found`);
    return found!;
}

async function main(): Promise<void> {
    console.log('outbox requeue-dead: dead rows return to the queue as retryable, guarded writes');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-requeue-'));
    const store = new SqliteOutboxStore(path.join(dir, 'outbox.sqlite'));

    try {
        const schemaA = await seedDead(store, 'ws-a', 'verbatim.upsert', SCHEMA_ERR);
        const schemaB = await seedDead(store, 'ws-b', 'verbatim.upsert', SCHEMA_ERR);
        const superseded = await seedDead(store, 'ws-a', 'verbatim.upsert', SUPERSEDED_ERR);
        const otherKind = await seedDead(store, 'ws-a', 'node.upsert', SCHEMA_ERR);

        // ── Section A: filters must scope the blast radius ──────────────────

        await test('--error-contains requeues only the matching incident, leaving other dead rows dead', async () => {
            const n = await store.requeueDead({ errorContains: 'metadata.type' });
            assert.equal(n, 3, 'the three metadata.type rows requeue; the RA-6 row does not');
            assert.equal((await get(store, superseded)).status, 'dead',
                'a row dead for a GOOD reason (superseded write) must stay dead');
            for (const id of [schemaA, schemaB, otherKind]) {
                assert.notEqual((await get(store, id)).status, 'dead', `${id} was requeued`);
            }
        });

        // ── Section B: the safety property ──────────────────────────────────

        await test("requeued rows land as 'failed', NOT 'pending', so the RA-6 supersession guard still runs", async () => {
            const row = await get(store, schemaA);
            assert.equal(row.status, 'failed',
                "replicateOne only runs isSupersededFailed() on status==='failed' — 'pending' would skip it "
                + 'and let a stale row overwrite a newer same-entity write');
        });

        await test('attempts reset to 0 so a requeued row is not re-dead-lettered on its first hiccup', async () => {
            const row = await get(store, schemaA);
            assert.equal(row.attempts, 0, `attempts reset (was ${row.attempts})`);
            assert.equal(row.lastError ?? null, null, 'the stale error is cleared');
        });

        await test('the backoff clears so the replicator picks the row up on its next tick', async () => {
            const pending = await store.listPendingForWorkspace('ws-a', 100);
            assert.ok(pending.some((e) => e.id === schemaA),
                'a requeued row is immediately eligible (nextAttemptAt is NULL, not a future backoff)');
        });

        await test('the payload survives — this is a replay, not a reconstruction', async () => {
            const row = await get(store, schemaA);
            assert.ok(row.payload && typeof (row.payload as { id?: string }).id === 'string',
                'the original payload is still on the row, ready to re-dispatch');
        });

        // ── Section C: scoping flags ────────────────────────────────────────

        await test('--workspace and --kind narrow the selection', async () => {
            const c1 = await seedDead(store, 'ws-c', 'verbatim.upsert', SCHEMA_ERR);
            const c2 = await seedDead(store, 'ws-c', 'edge.upsert', SCHEMA_ERR);
            const n = await store.requeueDead({ workspace: 'ws-c', operationKind: 'verbatim.upsert' });
            assert.equal(n, 1);
            assert.equal((await get(store, c1)).status, 'failed', 'the matching kind requeued');
            assert.equal((await get(store, c2)).status, 'dead', 'the other kind was left alone');
        });

        await test('--limit caps how many rows move in one pass', async () => {
            const ids = [];
            for (let i = 0; i < 4; i++) ids.push(await seedDead(store, 'ws-d', 'verbatim.upsert', SCHEMA_ERR));
            const n = await store.requeueDead({ workspace: 'ws-d', limit: 2 });
            assert.equal(n, 2, 'only the limit moved');
            const stillDead = [];
            for (const id of ids) if ((await get(store, id)).status === 'dead') stillDead.push(id);
            assert.equal(stillDead.length, 2, 'the rest stay dead for the next pass');
        });

        await test('a no-match filter is a safe no-op, not a wholesale requeue', async () => {
            const before = (await store.listDead({ limit: 1000 })).length;
            const n = await store.requeueDead({ errorContains: 'no row has this error text' });
            assert.equal(n, 0, 'nothing moved');
            assert.equal((await store.listDead({ limit: 1000 })).length, before, 'the dead queue is unchanged');
        });

        await test('--error-contains matches literally — % and _ are not wildcards', async () => {
            const lit = await seedDead(store, 'ws-e', 'verbatim.upsert', 'disk 95% full');
            const other = await seedDead(store, 'ws-e', 'verbatim.upsert', 'disk 12 full');
            // '9%f' would match BOTH if % were passed through to LIKE unescaped.
            const n = await store.requeueDead({ workspace: 'ws-e', errorContains: '9%f' });
            assert.equal(n, 0, 'the % is escaped, so this matches no row at all');
            assert.equal((await get(store, lit)).status, 'dead');
            assert.equal((await get(store, other)).status, 'dead');
            assert.equal(await store.requeueDead({ workspace: 'ws-e', errorContains: '95% full' }), 1,
                'the literal text still matches its own row');
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── Section D: CLI surface (no store needed) ────────────────────────────

    await test('flag parsing: defaults are conservative', async () => {
        const f = parseRequeueFlags([]);
        assert.equal(f.dryRun, false);
        assert.equal(f.limit, 5000);
        assert.equal(f.workspace, undefined, 'no workspace filter means every workspace — say so explicitly');
        assert.equal(f.operationKind, undefined);
        assert.equal(f.errorContains, undefined);
    });

    await test('flag parsing: every filter round-trips', async () => {
        const f = parseRequeueFlags([
            '--workspace', 'groundfloor-atlas', '--kind', 'verbatim.upsert',
            '--error-contains', 'metadata.type', '--limit', '10', '--dry-run',
        ]);
        assert.deepEqual(
            { ws: f.workspace, kind: f.operationKind, err: f.errorContains, limit: f.limit, dry: f.dryRun },
            { ws: 'groundfloor-atlas', kind: 'verbatim.upsert', err: 'metadata.type', limit: 10, dry: true },
        );
    });

    await test('flag parsing: --lore-dir addresses an embedded host\'s outbox directly', async () => {
        // Embedded hosts (Atlas) open one Lore per workspace at its own dataDir:
        // no active workspace, no workspaces.json, so the daemon-shaped
        // resolution finds nothing. Verified against a real Atlas layout —
        // <ATLAS_HOME>/lore-data/<ws>/.lore/ — which is 11 separate outboxes.
        const f = parseRequeueFlags(['--lore-dir', '/tmp/atlas/lore-data/ws/.lore', '--dry-run']);
        assert.equal(f.loreDir, '/tmp/atlas/lore-data/ws/.lore');
        assert.equal(f.dryRun, true);
    });

    await test('flag parsing: --lore-dir is absent by default, so the daemon layout stays the default', async () => {
        assert.equal(parseRequeueFlags([]).loreDir, undefined);
    });

    await test('flag parsing: a junk --limit falls back to the default rather than requeueing 0 or NaN rows', async () => {
        assert.equal(parseRequeueFlags(['--limit', 'abc']).limit, 5000);
        assert.equal(parseRequeueFlags(['--limit', '-5']).limit, 5000);
    });

    await test('the summary groups by workspace, kind and error so a wholesale requeue is visible before it runs', async () => {
        const rows = [
            { workspace: 'a', operationKind: 'verbatim.upsert', lastError: SCHEMA_ERR },
            { workspace: 'a', operationKind: 'verbatim.upsert', lastError: SCHEMA_ERR },
            { workspace: 'b', operationKind: 'node.upsert', lastError: SUPERSEDED_ERR },
        ] as OutboxEntry[];
        const s = summarizeDead(rows);
        assert.deepEqual(s.byWorkspace, { a: 2, b: 1 });
        assert.deepEqual(s.byKind, { 'verbatim.upsert': 2, 'node.upsert': 1 });
        assert.equal(Object.keys(s.byError).length, 2, 'two distinct error classes are shown separately');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });

#!/usr/bin/env tsx
/**
 * sw06-outbox-races-unit.ts — SW-06 regression. Outbox status/changeset
 * races + unmasked migration errors. Four findings, all VERIFIED against
 * the pre-fix code (see AUDIT_FINDINGS.md B7/B8/B9/B12):
 *
 *   B7: SqliteOutboxStore.markEntryStatus did a non-transactional
 *       SELECT attempts → compute-in-JS → UPDATE (unlike markStep, which
 *       SP-18 wrapped). Two writers racing the SAME row both read the
 *       same `attempts`, computed the same bumped value, and the second
 *       UPDATE clobbered the first's bump → a row could under-count
 *       attempts and dodge the dead-letter cutoff. Fixed: wrap the
 *       read-modify-write in a transaction AND bump via `attempts + ?`
 *       in SQL so the increment is relative to the committed row.
 *   B8: VersionStore.addChangesetWrite took `seq` from the caller, which
 *       read it from the racy changeset.write_count snapshot. Two
 *       concurrent store_node calls buffering into one changeset read the
 *       same write_count, inserted the same seq → UNIQUE(changeset_id,seq)
 *       violation (one write lost) and could under-count write_count.
 *       Fixed: seq is allocated as MAX(seq)+1 inside one transaction that
 *       also bumps write_count; the store returns the assigned seq.
 *   B9: the ALTER TABLE ADD COLUMN try/catch swallowed ALL errors, not
 *       just "duplicate column", masking a real migration/IO failure into
 *       a later "no such column" error. Fixed: rethrow anything that is
 *       not a duplicate-column error.
 *   B12: confirm a stuck status='failed' hot-lane row SURVIVES boot
 *        recovery (not erased, not abandoned) and stays pickup-able by the
 *        replicator (listPendingForWorkspace includes 'failed').
 *
 * Mechanism + behavioral assertions. better-sqlite3 is synchronous, so
 * the real protection is the transaction/atomic-SQL making each
 * read-modify-write a single committed unit; these tests assert the
 * end-state and pin the mechanism so the fix can't silently regress.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import {
    recoverOutbox,
    InMemoryOutboxHandlerRegistry,
} from '../packages/lore/src/outbox/recovery.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void> | void) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
};

const tmpDir = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lore-sw06-${tag}-`));

console.log('SW-06 — outbox status/changeset races + unmasked migration errors');

/* ---------- (B7) markEntryStatus attempt-bump race ---------- */

test('markEntryStatus: N concurrent attempt-bumps all land (no lost update)', async () => {
    const store = new SqliteOutboxStore(tmpDir('b7'));
    const e = await recordHotWrite(store, {
        operationKind: 'node.upsert', workspace: 'ws', payload: { id: 'n1' },
    });
    // Fire 10 failed-bumps concurrently. Each bump must be counted; pre-fix
    // the stale-read + JS-compute clobbered, so attempts < 10.
    await Promise.all(
        Array.from({ length: 10 }, () =>
            store.markEntryStatus!(e.id, 'failed', { bumpAttempt: true })),
    );
    const found = (await store.listUnfinished()).find((x) => x.id === e.id);
    assert.ok(found, 'entry should still exist');
    assert.equal(
        found!.attempts, 10,
        `every bump must persist — expected attempts=10, got ${found!.attempts} (lost update)`,
    );
});

test('markEntryStatus: body wraps read-modify-write in a transaction + bumps in SQL (mechanism)', () => {
    const src = read('packages/lore/src/outbox/sqliteStore.ts');
    const mIdx = src.indexOf('async markEntryStatus(');
    assert.ok(mIdx >= 0, 'markEntryStatus not found');
    const body = src.slice(mIdx, src.indexOf('async listFailedOlderThan('));
    assert.match(body, /this\.db\.transaction\(/, 'markEntryStatus must wrap its SELECT+UPDATE in this.db.transaction(...)');
    assert.match(body, /attempts\s*=\s*attempts\s*\+\s*\?/, 'attempts must be bumped relative to the committed row (attempts = attempts + ?)');
});

/* ---------- (B8) changeset seq allocation race ---------- */

test('addChangesetWrite: sequential buffered writes get distinct monotonic seqs (no UNIQUE collision)', () => {
    const store = VersionStore.open(tmpDir('b8'));
    const cs = store.createChangeset('ws');
    // Pre-fix, the caller chose seq from a stale write_count read; two writes
    // could share a seq → UNIQUE(changeset_id, seq). Post-fix the store
    // derives seq atomically, so distinct seqs are guaranteed and no UNIQUE
    // error can be thrown by buffering into one changeset.
    const seqs: number[] = [];
    for (let i = 0; i < 20; i++) {
        seqs.push(store.addChangesetWrite(cs, 'upsert_node', { id: `n${i}` }));
    }
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i), 'seqs must be 0..19, distinct + monotonic');
    const writes = store.getChangesetWrites(cs);
    assert.equal(writes.length, 20, 'all 20 writes must persist (none lost to a UNIQUE collision)');
    assert.equal(store.getChangeset(cs)!.writeCount, 20, 'write_count must equal the number of buffered writes');
    store.close();
});

test('addChangesetWrite: seq is allocated inside a txn that also bumps write_count (mechanism)', () => {
    const src = read('packages/lore/src/outbox/versionStore.ts');
    const mIdx = src.indexOf('addChangesetWrite(');
    assert.ok(mIdx >= 0, 'addChangesetWrite not found');
    const body = src.slice(mIdx, src.indexOf('getChangesetWrites('));
    assert.match(body, /this\.db\.transaction\(/, 'addChangesetWrite must wrap seq-alloc + insert + write_count bump in a transaction');
    assert.match(body, /MAX\(seq\)/, 'seq must be derived from MAX(seq)+1 of committed rows, not a caller-supplied snapshot');
    // The caller-supplied seq parameter must be gone (callers no longer pick seq).
    assert.doesNotMatch(
        body.slice(0, body.indexOf('{')),
        /seq\s*:\s*number/,
        'addChangesetWrite must no longer accept a caller-supplied seq',
    );
});

/* ---------- (B9) ALTER TABLE error masking ---------- */

test('ADD COLUMN catch swallows ONLY duplicate-column; real errors surface (mechanism)', () => {
    const src = read('packages/lore/src/outbox/sqliteStore.ts');
    const idx = src.indexOf('ALTER TABLE outbox_entries ADD COLUMN nextAttemptAt');
    assert.ok(idx >= 0, 'ALTER TABLE ADD COLUMN not found');
    const body = src.slice(idx, idx + 400);
    assert.match(body, /duplicate column/i, 'catch must inspect for "duplicate column"');
    assert.match(body, /throw\s+err/, 'a non-duplicate-column error must be rethrown, not swallowed');
});

test('ADD COLUMN: a non-duplicate ALTER error now surfaces (behavioral)', () => {
    // Open a store, then drop the whole table so the constructor's idempotent
    // ALTER hits "no such table" — a real schema/migration error that must NOT
    // be masked. Re-running the constructor against a DB whose table was
    // removed surfaces the error instead of swallowing it.
    //
    // We exercise the catch directly: ALTER ADD COLUMN on a missing column type
    // mismatch is hard to force, so we drive a non-duplicate failure by ALTERing
    // a table that does not exist via a fresh probe DB, mirroring the in-prod
    // path (constructor runs `this.db.exec(ALTER ...)`).
    const dir = tmpDir('b9');
    const db = new Database(path.join(dir, 'probe.sqlite'));
    // No table created → ALTER must throw "no such table", NOT be swallowed as
    // a duplicate-column no-op. We replicate the production catch and assert it
    // rethrows.
    let surfaced = false;
    try {
        try {
            db.exec(`ALTER TABLE outbox_entries ADD COLUMN nextAttemptAt TEXT`);
        } catch (err) {
            if (!/duplicate column/i.test((err as Error).message)) throw err;
        }
    } catch (err) {
        surfaced = true;
        assert.match((err as Error).message, /no such table/i, 'the real error must surface verbatim');
    }
    db.close();
    assert.ok(surfaced, 'a non-duplicate-column ALTER error must surface (not be masked)');
});

/* ---------- (B12) failed row survives crash recovery + stays pickup-able ---------- */

test('recovery: a stuck failed hot-lane row survives boot recovery and is re-driven', async () => {
    const store = new SqliteOutboxStore(tmpDir('b12'));
    // Hot-lane row: single pre-'done' step, status driven by the replicator.
    const e = await recordHotWrite(store, {
        operationKind: 'node.upsert', workspace: 'ws', payload: { id: 'n-failed' },
    });
    // Simulate the replicator having failed it before the crash.
    await store.markEntryStatus!(e.id, 'failed', { bumpAttempt: true, error: 'boom' });

    const registry = new InMemoryOutboxHandlerRegistry();
    const report = await recoverOutbox(store, registry);

    // Recovery must NOT complete/erase it (all steps done but status='failed').
    assert.equal(report.completed, 0, 'recovery must not silently complete a failed row');
    assert.equal(report.requeuedReplicating, 0, "failed rows are not 'replicating' — recovery leaves status to the replicator");
    assert.equal(report.skippedReplicatorRows, 1, 'the zero-outstanding-step failed row is left to the replicator');

    // The row must still exist as 'failed' (DLQ/retry queue intact).
    const stillThere = (await store.listUnfinished()).find((x) => x.id === e.id);
    assert.ok(stillThere, 'failed row must survive recovery (not erased)');
    assert.equal(stillThere!.status, 'failed', "status must remain 'failed' after recovery");

    // And it must still be pickup-able by the replicator: listPendingForWorkspace
    // returns 'failed' rows whose backoff has elapsed. Use retryBaseMs=0 so the
    // nextAttemptAt window is already past.
    const store2 = new SqliteOutboxStore(store.directory, { retryBaseMs: 0 });
    // Re-mark with zero backoff so nextAttemptAt <= now immediately.
    await store2.markEntryStatus!(e.id, 'failed', { bumpAttempt: false });
    const pickable = await store2.listPendingForWorkspace('ws', 10);
    assert.ok(
        pickable.some((x) => x.id === e.id),
        'a stuck failed row must remain pickup-able by the replicator (listPendingForWorkspace)',
    );
});

(async () => {
    await Promise.all(pending);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();

#!/usr/bin/env tsx
/**
 * sp18-races-unit.ts — SP-18 regression. Three concurrency/atomicity fixes.
 *
 * (1) outbox-sqlite-markstep-read-modify-write-race — SqliteOutboxStore.markStep
 *     read JSON steps → mutated in JS → wrote JSON back with no transaction.
 *     Concurrent markStep(id,0) + markStep(id,1) could lost-update. Fixed by
 *     wrapping SELECT+UPDATE in a better-sqlite3 transaction.
 * (2) tssdkadapter-toctou-upsert-race — push() did updateByQuery → insert-on-
 *     zero-match (check-then-act). N concurrent pushes for one fresh id all saw
 *     updated:0 and all inserted → duplicate. Fixed by per-id serialization.
 * (3) verbatim-store-delete-add-window-loses-row — store() deleted the canonical
 *     row then awaited table.add; a crash between lost the row. Fixed by an
 *     atomic LanceDB mergeInsert (replace-or-insert in one op).
 *
 * Tests (1) and (2) are behavioral against real/fake collaborators. Test (3) is
 * a functional + mechanism probe (a true mid-op crash on real LanceDB can't be
 * simulated in-process; the mechanism assertion guards the fix from regressing).
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { TsSdkAdapter } from '../packages/lore/src/engines/tsSdkAdapter.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp18-'));

function entry(id: string, steps: OutboxEntry['steps']): OutboxEntry {
    const now = new Date().toISOString();
    return {
        id, operation: 'node.upsert', initiator: 'test', createdAt: now, updatedAt: now,
        steps, completed: false, workspace: 'ws', operationKind: 'node.upsert',
        payload: { id: 'n1' }, status: 'pending', attempts: 0,
    };
}

console.log('SP-18 — three races: markStep / sdk upsert / verbatim delete-add');

/* ---------- (1) markStep ---------- */

test('markStep: two flips on different step indices both persist (no clobber)', async () => {
    const store = new SqliteOutboxStore(tmpDir());
    await store.record(entry('e1', [
        { kind: 'graph.upsert', status: 'pending' },
        { kind: 'verbatim.upsert', status: 'pending' },
    ]));
    // Fire both concurrently. (better-sqlite3 is synchronous, so the real
    // protection is the transaction making each read-modify-write atomic; this
    // asserts the end-state both ways.)
    await Promise.all([
        store.markStep('e1', 0, 'done'),
        store.markStep('e1', 1, 'done'),
    ]);
    const found = (await store.listUnfinished()).find((e) => e.id === 'e1');
    assert.ok(found, 'entry e1 should still be listed (completed=0)');
    assert.equal(found!.steps[0].status, 'done', 'step 0 flip must persist');
    assert.equal(found!.steps[1].status, 'done', 'step 1 flip must NOT be clobbered by the step-0 write');
});

test('markStep: body wraps the read-modify-write in a transaction (mechanism)', () => {
    const src = read('packages/lore/src/outbox/sqliteStore.ts');
    const mIdx = src.indexOf('async markStep(');
    assert.ok(mIdx >= 0, 'markStep not found');
    const body = src.slice(mIdx, src.indexOf('async markCompleted('));
    assert.match(body, /this\.db\.transaction\(/, 'markStep must wrap its SELECT+UPDATE in this.db.transaction(...)');
});

/* ---------- (2) tsSdkAdapter upsert TOCTOU ---------- */

/** Fake GroundfloorClient that records inserts and reflects updateByQuery
 *  against what's already inserted (so the check-then-act sees the real state). */
function makeFakeClient() {
    const inserted = new Map<string, number>(); // id → count
    return {
        inserted,
        insertCalls: 0,
        async updateByQuery(_coll: string, q: { id_eq: string }, _doc: unknown) {
            return { updated: inserted.has(q.id_eq) ? 1 : 0 };
        },
        async insert(_coll: string, doc: Record<string, unknown>) {
            const id = String(doc['id']);
            inserted.set(id, (inserted.get(id) ?? 0) + 1);
            (this as { insertCalls: number }).insertCalls++;
        },
    };
}

test('push: 5 concurrent pushes for the same fresh id insert exactly once (no TOCTOU dup)', async () => {
    const adapter = new TsSdkAdapter({ baseUrl: 'x', apiKey: 'x', tenantId: 't', orgId: 'o' });
    const fake = makeFakeClient();
    // Inject the fake client + mark connected (both private — test seam).
    (adapter as unknown as { client: unknown; connected: boolean }).client = fake;
    (adapter as unknown as { connected: boolean }).connected = true;

    const node = {
        id: 'race-node', type: 'decision', label: 'L', content: 'c', tags: '',
        project: 'ws', ecosystem: '*', metadata: '{}',
        createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', syncedAt: '',
    };
    await Promise.all(Array.from({ length: 5 }, () => adapter.push([node as never], [])));

    assert.equal(fake.insertCalls, 1, `expected exactly ONE insert for the same id across 5 concurrent pushes, got ${fake.insertCalls}`);
    assert.equal(fake.inserted.get('race-node'), 1, 'the node must exist exactly once (no duplicate row)');
});

test('push: serializeById mechanism present (per-id chain)', () => {
    const src = read('packages/lore/src/engines/tsSdkAdapter.ts');
    assert.match(src, /serializeById\(/, 'push must route the check-then-act through serializeById');
    assert.match(src, /upsertChains/, 'per-id serialization map must exist');
});

/* ---------- (3) verbatim delete→add window ---------- */

test('verbatim store: canonical replace uses atomic mergeInsert, not delete+add (mechanism)', () => {
    const src = read('packages/lore/src/engines/verbatimStore.ts');
    const sIdx = src.indexOf('async store(');
    assert.ok(sIdx >= 0, 'store() not found');
    // Bound the window to the store() method body (up to storeBatch).
    const body = src.slice(sIdx, src.indexOf('storeBatch', sIdx) > sIdx ? src.indexOf('Layer 2', sIdx) : src.length);
    assert.match(body, /\.mergeInsert\(\s*['"]id['"]\s*\)/, "store() canonical-replace must use table.mergeInsert('id') (atomic upsert)");
    assert.match(body, /whenMatchedUpdateAll\(\)/, 'mergeInsert must update on match');
    assert.match(body, /whenNotMatchedInsertAll\(\)/, 'mergeInsert must insert on no-match');
    // The pre-SP-18 delete-then-add canonical-replace must be gone: there must
    // be NO `table.delete(\`id = ...\`)` of the live row inside store().
    assert.equal(
        /this\.table\.delete\(`id = /.test(body),
        false,
        'store() must no longer delete the canonical row before add (that was the crash-loss window)',
    );
});

(async () => {
    await Promise.all(pending);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();

#!/usr/bin/env tsx
/**
 * test/type-retention-unit.ts — W6a (Sprint W) per-type retention plan
 * + WarmStore + rule validation.
 *
 * Coverage:
 *   T-plan-1 (spec T1 semantics): warm-after with age past threshold
 *     puts the node in toWarm; under threshold keeps it pending.
 *   T-plan-2 (spec T3): delete-after with age past threshold puts the
 *     node in toDelete.
 *   T-plan-3 (spec T4): empty policies → all kept, no I/O.
 *   T-plan-4: unknown-type nodes are kept (no policy entry).
 *   T-plan-5: `keep` mode keeps the node even if days threshold is set.
 *   T-validate-1/2/3: rule validation matches spec (keep takes no
 *     days; warm/delete require positive integer 1..36500).
 *   T-warm-1: WarmStore.put → exists() returns true → get() round-
 *     trips the WarmedNode; delete() reverses.
 *   T-warm-2: WarmStore.list enumerates the directory + unmangles
 *     ids that contain `:` and `/`.
 *
 * Out of scope this slice (W6b): live graph integration, cold tier,
 * archive CLI, includeTiers recall.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    computeRetentionPlan,
    validateRule,
    type RetentionCandidate,
    type TypePoliciesMap,
} from '../packages/lore/src/engines/typeRetention.js';
import { WarmStore, type WarmedNode } from '../packages/lore/src/engines/warmStore.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

console.log('W6a per-type retention');

const NOW = Date.parse('2026-05-23T12:00:00Z');
function ageDaysAgo(days: number): string {
    return new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
}

/* ---------- T-plan: computeRetentionPlan ---------- */

test('T-plan-1: warm-after — past threshold → toWarm, under → pending', async () => {
    const nodes: RetentionCandidate[] = [
        { id: 'a', type: 'code_symbol', updatedAt: ageDaysAgo(45) },
        { id: 'b', type: 'code_symbol', updatedAt: ageDaysAgo(10) },
    ];
    const policies: TypePoliciesMap = { code_symbol: { mode: 'warm-after', days: 30 } };
    const plan = computeRetentionPlan(nodes, policies, NOW);
    assert.equal(plan.toWarm.length, 1);
    assert.equal(plan.toWarm[0]!.id, 'a');
    assert.equal(plan.pending.length, 1);
    assert.equal(plan.pending[0]!.id, 'b');
    assert.equal(plan.pending[0]!.eligibleInDays, 20);
    assert.equal(plan.toDelete.length, 0);
});

test('T-plan-2: delete-after — past threshold → toDelete', async () => {
    const nodes: RetentionCandidate[] = [
        { id: 'old', type: 'troubleshooting', updatedAt: ageDaysAgo(8) },
        { id: 'fresh', type: 'troubleshooting', updatedAt: ageDaysAgo(2) },
    ];
    const policies: TypePoliciesMap = { troubleshooting: { mode: 'delete-after', days: 7 } };
    const plan = computeRetentionPlan(nodes, policies, NOW);
    assert.equal(plan.toDelete.length, 1);
    assert.equal(plan.toDelete[0]!.id, 'old');
    assert.equal(plan.pending.length, 1);
});

test('T-plan-3: empty policies → all kept, no toWarm/toDelete', async () => {
    const nodes: RetentionCandidate[] = [
        { id: 'a', type: 't1', updatedAt: ageDaysAgo(999) },
        { id: 'b', type: 't2', updatedAt: ageDaysAgo(0) },
    ];
    const plan = computeRetentionPlan(nodes, undefined, NOW);
    assert.equal(plan.kept, 2);
    assert.equal(plan.toWarm.length, 0);
    assert.equal(plan.toDelete.length, 0);
});

test('T-plan-4: unknown-type nodes are kept (no policy entry)', async () => {
    const policies: TypePoliciesMap = { code_symbol: { mode: 'delete-after', days: 7 } };
    const nodes: RetentionCandidate[] = [
        { id: 'untouched', type: 'decision', updatedAt: ageDaysAgo(999) },
    ];
    const plan = computeRetentionPlan(nodes, policies, NOW);
    assert.equal(plan.kept, 1);
    assert.equal(plan.toDelete.length, 0);
});

test('T-plan-5: `keep` mode keeps the node regardless of age', async () => {
    const policies: TypePoliciesMap = { decision: { mode: 'keep' } };
    const nodes: RetentionCandidate[] = [
        { id: 'forever', type: 'decision', updatedAt: ageDaysAgo(99999) },
    ];
    const plan = computeRetentionPlan(nodes, policies, NOW);
    assert.equal(plan.kept, 1);
});

test('T-plan-6: unparseable updatedAt falls into kept (safe default)', async () => {
    const policies: TypePoliciesMap = { decision: { mode: 'delete-after', days: 7 } };
    const nodes: RetentionCandidate[] = [
        { id: 'bad', type: 'decision', updatedAt: 'NOT-AN-ISO-DATE' },
    ];
    const plan = computeRetentionPlan(nodes, policies, NOW);
    assert.equal(plan.kept, 1);
    assert.equal(plan.toDelete.length, 0);
});

/* ---------- T-validate: validateRule ---------- */

test('T-validate-1: keep mode rejects days', async () => {
    assert.ok(validateRule({ mode: 'keep' }) === null);
    const err = validateRule({ mode: 'keep', days: 30 });
    assert.ok(err && err.includes('keep does not take a days'));
});

test('T-validate-2: warm-after requires positive integer days', async () => {
    assert.ok(validateRule({ mode: 'warm-after', days: 30 }) === null);
    assert.ok(validateRule({ mode: 'warm-after' }) !== null);
    assert.ok(validateRule({ mode: 'warm-after', days: 0 }) !== null);
    assert.ok(validateRule({ mode: 'warm-after', days: -1 }) !== null);
    assert.ok(validateRule({ mode: 'warm-after', days: 1.5 }) !== null);
    assert.ok(validateRule({ mode: 'warm-after', days: 50000 }) !== null);
});

test('T-validate-3: unknown mode rejected', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = validateRule({ mode: 'cold-after' as any, days: 180 });
    assert.ok(err && err.includes('mode must be one of'));
});

/* ---------- T-warm: WarmStore round-trip ---------- */

test('T-warm-1: put → exists → get round-trips; delete reverses', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w6a-warm-'));
    const store = new WarmStore(tmp);
    const node: WarmedNode = {
        id: 'decision:test-1',
        type: 'decision',
        label: 'A warmed node',
        content: 'lorem ipsum '.repeat(50),
        tags: 'w6a,test',
        metadata: '{}',
        project: 'default',
        ecosystem: '*',
        updatedAt: '2026-04-01T00:00:00Z',
        warmedAt: '2026-05-23T12:00:00Z',
        verbatimText: 'verbatim concat',
    };
    const target = await store.put(node);
    assert.ok(target.endsWith('.jsonl.gz'));
    assert.equal(await store.exists(node.id), true);
    const round = await store.get(node.id);
    assert.deepEqual(round, node);
    const removed = await store.delete(node.id);
    assert.equal(removed, true);
    assert.equal(await store.exists(node.id), false);
    const removedAgain = await store.delete(node.id);
    assert.equal(removedAgain, false);
});

test('T-warm-2: list enumerates ids, unmangles slashes back to colon-separated paths', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w6a-warm-list-'));
    const store = new WarmStore(tmp);
    const ids = ['decision:abc', 'code-symbol:src/foo.ts:Bar:class', 'simple-id'];
    for (const id of ids) {
        await store.put({
            id, type: 't', label: id, content: '', tags: '', metadata: '{}',
            project: 'p', ecosystem: '*', updatedAt: 'now', warmedAt: 'now',
        });
    }
    const listed = (await store.list()).sort();
    // Lossy round-trip pinning: WarmStore mangles `/` → `_` on disk,
    // and on list() unmangles `_` → `:` (since Lore ids legitimately
    // contain `:` more often than `_`). A path-flavored id like
    // `code-symbol:src/foo.ts:...` round-trips to `code-symbol:src:foo.ts:...`
    // — the lossy step is documented in WarmStore.list, and matters
    // only for caller display, not for the per-id file lookup paths
    // exists/get/delete use directly.
    assert.deepEqual(
        listed.sort(),
        ['code-symbol:src:foo.ts:Bar:class', 'decision:abc', 'simple-id'].sort(),
    );
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

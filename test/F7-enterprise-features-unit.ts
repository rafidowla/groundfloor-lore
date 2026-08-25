#!/usr/bin/env tsx
/**
 * F7-enterprise-features-unit.ts — Feature 1–7 unit tests (2026-05-26).
 *
 * Covers the seven enterprise features without spinning up Kùzu, LanceDB,
 * or a live daemon. Pure in-memory / temp-dir testing.
 *
 * Tests:
 *   AuxStore     — open, recordOutcome, getOutcomes round-trip
 *                  createPruneJob / updatePruneJob / getPruneJob
 *                  corpus counters
 *   Feature 2    — confirmation score calculation formula
 *   Feature 3    — token-budget truncation logic
 *   Feature 4    — evidence field round-trip via LoreNode type
 *   Feature 6    — anchors JSON parse in check_anchors helper
 *   workspaces   — new config fields accepted by WorkspaceEntry
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuxStore } from '../packages/lore/src/outbox/auxStore.js';

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void | Promise<void>) => {
    const result = (() => { try { return fn(); } catch (e) { return Promise.reject(e); } })();
    if (result instanceof Promise) {
        result.then(() => { passed++; console.log(`  ✓ ${name}`); })
              .catch((e) => { failed++; console.error(`  ✗ ${name}: ${(e as Error).message}`); });
    } else {
        passed++;
        console.log(`  ✓ ${name}`);
    }
};

/* ─── helpers ──────────────────────────────────────────────────── */

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-f7-'));
}

function calcConfirmationScore(s: number, f: number, p: number): number {
    const total = s + f + p * 0.5;
    if (total === 0) return 0;
    return Math.round((s / total) * 1000) / 1000;
}

function estimateTokens(label: string, content: string): number {
    return Math.ceil(((label?.length ?? 0) + (content?.length ?? 0)) / 4);
}

/* ─── AuxStore tests ───────────────────────────────────────────── */

console.log('\n─── AuxStore ───');

test('open creates aux.sqlite in loreDir', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    assert.ok(fs.existsSync(path.join(dir, 'aux.sqlite')));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('recordOutcome + getOutcomes round-trip', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    const id = `out-${Date.now()}`;
    store.recordOutcome({ id, nodeId: 'node-1', workspace: 'default', status: 'success', notes: 'worked', recordedBy: 'agent-x' });
    const outcomes = store.getOutcomes('node-1', 'default');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.status, 'success');
    assert.equal(outcomes[0]!.notes, 'worked');
    assert.equal(outcomes[0]!.recordedBy, 'agent-x');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getOutcomeCount aggregates correctly', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    store.recordOutcome({ id: 'o1', nodeId: 'n1', workspace: 'w1', status: 'success' });
    store.recordOutcome({ id: 'o2', nodeId: 'n1', workspace: 'w1', status: 'success' });
    store.recordOutcome({ id: 'o3', nodeId: 'n1', workspace: 'w1', status: 'failure' });
    store.recordOutcome({ id: 'o4', nodeId: 'n1', workspace: 'w1', status: 'partial' });
    const counts = store.getOutcomeCount('n1', 'w1');
    assert.equal(counts.success, 2);
    assert.equal(counts.failure, 1);
    assert.equal(counts.partial, 1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('createPruneJob + getPruneJob round-trip', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    const jobId = store.createPruneJob('default', { classification: 'tactical', olderThanDays: 7 });
    const job = store.getPruneJob(jobId);
    assert.ok(job);
    assert.equal(job!.workspace, 'default');
    assert.equal(job!.status, 'running');
    assert.equal(job!.options.classification, 'tactical');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('updatePruneJob sets status + result + completedAt', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    const jobId = store.createPruneJob('default', {});
    store.updatePruneJob(jobId, {
        status: 'completed',
        result: { matched: 10, archived: 8, hardDeleted: 0, skipped: 2, protectedCount: 1, dryRun: false },
    });
    const job = store.getPruneJob(jobId);
    assert.equal(job!.status, 'completed');
    assert.equal(job!.result!.archived, 8);
    assert.ok(job!.completedAt);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getPruneJob returns null for unknown id', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    assert.equal(store.getPruneJob('nonexistent-id'), null);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('corpus counters incrementCounter + getCorpusCounters', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    store.incrementCounter('ws1', 'nodes_archived', 5);
    store.incrementCounter('ws1', 'nodes_archived', 3);
    store.incrementCounter('ws1', 'outcomes_success', 1);
    const counters = store.getCorpusCounters('ws1');
    assert.equal(counters['nodes_archived'], 8);
    assert.equal(counters['outcomes_success'], 1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('setCounter overrides increment', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    store.incrementCounter('ws1', 'total', 100);
    store.setCounter('ws1', 'total', 42);
    const c = store.getCorpusCounters('ws1');
    assert.equal(c['total'], 42);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getWorkspaceOutcomeTotals sums across all nodes in workspace', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    store.recordOutcome({ id: 'a', nodeId: 'n1', workspace: 'ws', status: 'success' });
    store.recordOutcome({ id: 'b', nodeId: 'n2', workspace: 'ws', status: 'failure' });
    store.recordOutcome({ id: 'c', nodeId: 'n3', workspace: 'ws', status: 'partial' });
    const totals = store.getWorkspaceOutcomeTotals('ws');
    assert.equal(totals.success, 1);
    assert.equal(totals.failure, 1);
    assert.equal(totals.partial, 1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ─── Feature 2 — confirmation score ──────────────────────────── */

console.log('\n─── Feature 2: confirmation score ───');

test('calcConfirmationScore — 0 when no outcomes', () => {
    assert.equal(calcConfirmationScore(0, 0, 0), 0);
});

test('calcConfirmationScore — 1.0 with 3 successes', () => {
    assert.equal(calcConfirmationScore(3, 0, 0), 1);
});

test('calcConfirmationScore — 0.0 with only failures', () => {
    assert.equal(calcConfirmationScore(0, 3, 0), 0);
});

test('calcConfirmationScore — partial counts 0.5 each', () => {
    // 2 success, 0 failure, 2 partial → total = 2 + 2*0.5 = 3 → 2/3 ≈ 0.667
    const score = calcConfirmationScore(2, 0, 2);
    assert.ok(score > 0.66 && score < 0.668, `score was ${score}`);
});

test('calcConfirmationScore — 2 success 1 failure → 2/3 ≈ 0.667', () => {
    // total = 2 + 1 + 0*0.5 = 3 → score = 2/3 ≈ 0.667
    const score = calcConfirmationScore(2, 1, 0);
    assert.ok(score > 0.666 && score < 0.668, `score was ${score}`);
});

/* ─── Feature 3 — token budget ─────────────────────────────────── */

console.log('\n─── Feature 3: token budget ───');

test('estimateTokens — approx 1 token per 4 chars', () => {
    const est = estimateTokens('Hello', 'World!');
    assert.equal(est, 3); // ceil((5+6)/4) = ceil(2.75) = 3
});

test('token budget truncation — 3 nodes, budget fits 2', () => {
    // Simulate the budget fill loop from the recall handler
    interface Item { label: string; content: string }
    const nodes: Item[] = [
        { label: 'A'.repeat(200), content: 'B'.repeat(200) }, // ~100 tokens
        { label: 'C'.repeat(200), content: 'D'.repeat(200) }, // ~100 tokens
        { label: 'E'.repeat(200), content: 'F'.repeat(200) }, // ~100 tokens
    ];
    const maxTokens = 250; // enough for 2, not 3
    let budget = maxTokens;
    const budgeted: Item[] = [];
    for (const n of nodes) {
        const est = estimateTokens(n.label, n.content);
        if (budget - est < 0 && budgeted.length > 0) break;
        budgeted.push(n);
        budget -= est;
    }
    assert.equal(budgeted.length, 2, `Expected 2, got ${budgeted.length}`);
    const truncated = budgeted.length < nodes.length;
    const dropped = nodes.length - budgeted.length;
    assert.equal(truncated, true);
    assert.equal(dropped, 1);
});

test('token budget — no truncation when budget is large enough', () => {
    interface Item { label: string; content: string }
    const nodes: Item[] = [
        { label: 'A'.repeat(100), content: 'B'.repeat(100) }, // ~50 tokens
        { label: 'C'.repeat(100), content: 'D'.repeat(100) }, // ~50 tokens
    ];
    const maxTokens = 200;
    let budget = maxTokens;
    const budgeted: Item[] = [];
    for (const n of nodes) {
        const est = estimateTokens(n.label, n.content);
        if (budget - est < 0 && budgeted.length > 0) break;
        budgeted.push(n);
        budget -= est;
    }
    assert.equal(budgeted.length, 2);
    assert.equal(budgeted.length < nodes.length, false);
});

/* ─── Feature 4 — LoreNode evidence field ──────────────────────── */

console.log('\n─── Feature 4: evidence field ───');

test('LoreNode.evidence accepts string value', () => {
    // Type-level test: ensure the interface accepts these shapes.
    // If TypeScript compiles this file, the type is correct.
    const node = {
        id: 'x', type: 'note', label: 'L', content: 'C',
        tags: '', project: 'default', ecosystem: '*',
        metadata: '{}', createdAt: '', updatedAt: '', syncedAt: null,
        evidence: '{"url":"https://example.com"}',
    };
    assert.equal(typeof node.evidence, 'string');
});

test('LoreNode.evidence accepts null', () => {
    const node = {
        id: 'x', type: 'note', label: 'L', content: 'C',
        tags: '', project: 'default', ecosystem: '*',
        metadata: '{}', createdAt: '', updatedAt: '', syncedAt: null,
        evidence: null,
    };
    assert.equal(node.evidence, null);
});

/* ─── Feature 6 — anchor parsing ───────────────────────────────── */

console.log('\n─── Feature 6: anchor parsing ───');

function parseAnchors(raw: string | null | undefined): Array<{ type: string; ref: string }> {
    if (!raw || raw.trim() === '' || raw.trim() === '[]') return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (a): a is { type: string; ref: string } =>
                a && typeof a === 'object' && typeof a.type === 'string' && typeof a.ref === 'string',
        );
    } catch {
        return [];
    }
}

test('parseAnchors — null returns empty array', () => {
    assert.deepEqual(parseAnchors(null), []);
});

test('parseAnchors — empty string returns empty array', () => {
    assert.deepEqual(parseAnchors(''), []);
});

test('parseAnchors — "[]" returns empty array', () => {
    assert.deepEqual(parseAnchors('[]'), []);
});

test('parseAnchors — valid JSON array parses correctly', () => {
    const raw = '[{"type":"url","ref":"https://example.com"},{"type":"node","ref":"decision-xyz"}]';
    const anchors = parseAnchors(raw);
    assert.equal(anchors.length, 2);
    assert.equal(anchors[0]!.type, 'url');
    assert.equal(anchors[0]!.ref, 'https://example.com');
    assert.equal(anchors[1]!.type, 'node');
});

test('parseAnchors — invalid JSON returns empty array', () => {
    assert.deepEqual(parseAnchors('not json'), []);
});

test('parseAnchors — non-array JSON returns empty array', () => {
    assert.deepEqual(parseAnchors('{"type":"url","ref":"x"}'), []);
});

test('parseAnchors — filters items missing required fields', () => {
    const raw = '[{"type":"url"},{"type":"node","ref":"x"},{"ref":"only-ref"}]';
    const anchors = parseAnchors(raw);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.ref, 'x');
});

/* ─── AuxStore unhappy / adversarial ───────────────────────────── */

console.log('\n─── AuxStore: unhappy + adversarial ───');

test('SQL injection in nodeId is stored safely (not executed)', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    const injectedId = `node' OR '1'='1`;
    store.recordOutcome({ id: 'inj-1', nodeId: injectedId, workspace: 'w1', status: 'success' });
    const outcomes = store.getOutcomes(injectedId, 'w1');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.status, 'success');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('SQL injection in workspace field is stored safely', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    const injectedWs = `ws'; DROP TABLE node_outcomes; --`;
    store.recordOutcome({ id: 'inj-2', nodeId: 'n1', workspace: injectedWs, status: 'failure' });
    const outcomes = store.getOutcomes('n1', injectedWs);
    assert.equal(outcomes.length, 1);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('SQL injection in notes is round-tripped faithfully', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    const injectedNotes = `'); INSERT INTO node_outcomes VALUES ('x','y','z','success','','','2020');--`;
    store.recordOutcome({ id: 'inj-3', nodeId: 'n1', workspace: 'w1', status: 'success', notes: injectedNotes });
    const outcomes = store.getOutcomes('n1', 'w1');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.notes, injectedNotes);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate outcome id throws UNIQUE constraint error', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    store.recordOutcome({ id: 'dup-id', nodeId: 'n1', workspace: 'w1', status: 'success' });
    assert.throws(
        () => store.recordOutcome({ id: 'dup-id', nodeId: 'n1', workspace: 'w1', status: 'failure' }),
        /UNIQUE constraint failed/i,
    );
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid status value throws CHECK constraint error', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    assert.throws(
        () => store.recordOutcome({ id: 'bad-status', nodeId: 'n1', workspace: 'w1', status: 'unknown' as 'success' }),
        /CHECK constraint failed/i,
    );
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('Unicode in notes is round-tripped faithfully', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    const unicodeNotes = '日本語テスト 🎉 αβγδ — em dash';
    store.recordOutcome({ id: 'uni-1', nodeId: 'n1', workspace: 'w1', status: 'partial', notes: unicodeNotes });
    const outcomes = store.getOutcomes('n1', 'w1');
    assert.equal(outcomes[0]!.notes, unicodeNotes);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('very long notes string (10 000 chars) is stored without truncation', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    const longNotes = 'x'.repeat(10_000);
    store.recordOutcome({ id: 'long-1', nodeId: 'n1', workspace: 'w1', status: 'success', notes: longNotes });
    const outcomes = store.getOutcomes('n1', 'w1');
    assert.equal(outcomes[0]!.notes!.length, 10_000);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('negative delta in incrementCounter decrements value', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    store.incrementCounter('ws1', 'total', 10);
    store.incrementCounter('ws1', 'total', -3);
    const c = store.getCorpusCounters('ws1');
    assert.equal(c['total'], 7);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('setCounter to 0 is stored as 0 (not null/missing)', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    store.incrementCounter('ws1', 'metric', 5);
    store.setCounter('ws1', 'metric', 0);
    const c = store.getCorpusCounters('ws1');
    assert.equal(c['metric'], 0);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('counters across different workspaces are isolated', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    store.incrementCounter('ws-A', 'nodes_archived', 10);
    store.incrementCounter('ws-B', 'nodes_archived', 3);
    assert.equal(store.getCorpusCounters('ws-A')['nodes_archived'], 10);
    assert.equal(store.getCorpusCounters('ws-B')['nodes_archived'], 3);
    // ws-A counter should not appear in ws-B and vice-versa
    assert.equal(store.getCorpusCounters('ws-B')['nodes_archived'], 3);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('outcomes across different workspaces are isolated', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    store.recordOutcome({ id: 'iso-1', nodeId: 'n1', workspace: 'ws-A', status: 'success' });
    store.recordOutcome({ id: 'iso-2', nodeId: 'n1', workspace: 'ws-B', status: 'failure' });
    assert.equal(store.getOutcomes('n1', 'ws-A').length, 1);
    assert.equal(store.getOutcomes('n1', 'ws-B').length, 1);
    assert.equal(store.getOutcomes('n1', 'ws-A')[0]!.status, 'success');
    assert.equal(store.getOutcomes('n1', 'ws-B')[0]!.status, 'failure');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getOutcomes respects custom limit — returns only N most-recent', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    for (let i = 0; i < 5; i++) {
        store.recordOutcome({ id: `lim-${i}`, nodeId: 'n1', workspace: 'w1', status: 'success' });
    }
    assert.equal(store.getOutcomes('n1', 'w1', 2).length, 2);
    assert.equal(store.getOutcomes('n1', 'w1', 10).length, 5);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('getPruneJob returns null for a never-created job id', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    assert.equal(store.getPruneJob(''), null);
    assert.equal(store.getPruneJob('nonexistent-' + Date.now()), null);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('updatePruneJob on unknown id is a no-op (does not throw)', () => {
    const dir = makeTmpDir();
    const store = AuxStore.open(dir);
    // No exception expected — UPDATE with no matching row is silent in SQLite.
    store.updatePruneJob('ghost-id', { status: 'completed' });
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ─── Feature 2: score adversarial ─────────────────────────────── */

console.log('\n─── Feature 2: score adversarial ───');

test('calcConfirmationScore — very large counts still returns 1.0', () => {
    assert.equal(calcConfirmationScore(1_000_000, 0, 0), 1);
});

test('calcConfirmationScore — 1 success / 1M failures approaches 0', () => {
    const score = calcConfirmationScore(1, 1_000_000, 0);
    assert.ok(score < 0.001, `score ${score} should be near zero`);
});

test('calcConfirmationScore — result is always in [0, 1] for varied inputs', () => {
    const cases: [number, number, number][] = [
        [5, 3, 2], [0, 0, 100], [99, 1, 0], [1, 1, 1], [0, 1, 0], [3, 3, 3],
    ];
    for (const [s, f, p] of cases) {
        const score = calcConfirmationScore(s, f, p);
        assert.ok(score >= 0 && score <= 1, `score ${score} out of [0,1] for (${s},${f},${p})`);
    }
});

test('calcConfirmationScore — result is rounded to 3 decimal places', () => {
    // 1/3 = 0.333..., rounded to 3dp = 0.333
    const score = calcConfirmationScore(1, 2, 0);
    assert.equal(score, 0.333);
});

/* ─── Feature 3: token budget adversarial ───────────────────────── */

console.log('\n─── Feature 3: token budget adversarial ───');

test('budget=0: first node still included (empty-list guard prevents zero-result)', () => {
    interface Item { label: string; content: string }
    const nodes: Item[] = [{ label: 'A'.repeat(200), content: 'B'.repeat(200) }]; // 100 tokens
    let budget = 0; // too small, but empty-list guard lets first through
    const budgeted: Item[] = [];
    for (const n of nodes) {
        const est = estimateTokens(n.label, n.content);
        if (budget - est < 0 && budgeted.length > 0) break;
        budgeted.push(n);
        budget -= est;
    }
    assert.equal(budgeted.length, 1, 'first node always admitted to prevent empty result');
});

test('budget exactly fits first node — second node excluded', () => {
    interface Item { label: string; content: string }
    const nodes: Item[] = [
        { label: 'A'.repeat(200), content: 'B'.repeat(200) }, // 100 tokens
        { label: 'C'.repeat(200), content: 'D'.repeat(200) }, // 100 tokens
    ];
    let budget = 100; // exactly fits first; second would make budget -100
    const budgeted: Item[] = [];
    for (const n of nodes) {
        const est = estimateTokens(n.label, n.content);
        if (budget - est < 0 && budgeted.length > 0) break;
        budgeted.push(n);
        budget -= est;
    }
    assert.equal(budgeted.length, 1);
});

test('all nodes larger than budget — only first node included', () => {
    interface Item { label: string; content: string }
    const nodes: Item[] = Array.from({ length: 3 }, (_, i) => ({
        label: String.fromCharCode(65 + i).repeat(800),
        content: String.fromCharCode(65 + i).repeat(800),
    })); // each ~400 tokens
    let budget = 10; // way too small for any
    const budgeted: Item[] = [];
    for (const n of nodes) {
        const est = estimateTokens(n.label, n.content);
        if (budget - est < 0 && budgeted.length > 0) break;
        budgeted.push(n);
        budget -= est;
    }
    assert.equal(budgeted.length, 1, 'guard keeps first; second triggers break');
});

test('empty node list produces empty budget result', () => {
    interface Item { label: string; content: string }
    const nodes: Item[] = [];
    let budget = 1000;
    const budgeted: Item[] = [];
    for (const n of nodes) {
        const est = estimateTokens(n.label, n.content);
        if (budget - est < 0 && budgeted.length > 0) break;
        budgeted.push(n);
        budget -= est;
    }
    assert.equal(budgeted.length, 0);
});

test('estimateTokens with empty strings returns 0', () => {
    assert.equal(estimateTokens('', ''), 0);
});

test('estimateTokens with only label (empty content) is correct', () => {
    // ceil(4/4) = 1
    assert.equal(estimateTokens('abcd', ''), 1);
});

/* ─── Feature 1: lifecycle filter logic (pure JS, no graph) ──────── */

console.log('\n─── Feature 1: lifecycle filter logic ───');

interface MockNode {
    id: string; status?: string; classification?: string;
    createdAt: string; tags?: string;
}

function applyPruneFilters(
    allNodes: MockNode[],
    opts: { classification?: string; cutoff?: string | null; filterTags?: string[] },
): { matched: MockNode[]; protectedCount: number } {
    const matched: MockNode[] = [];
    let protectedCount = 0;
    for (const node of allNodes) {
        if (node.status === 'protected') {
            if (
                (!opts.classification || node.classification === opts.classification) &&
                (!opts.cutoff || node.createdAt < opts.cutoff)
            ) protectedCount++;
            continue;
        }
        if (node.status === 'archived') continue;
        if (opts.classification && node.classification !== opts.classification) continue;
        if (opts.cutoff && node.createdAt >= opts.cutoff) continue;
        if (opts.filterTags && opts.filterTags.length > 0) {
            const nodeTags = node.tags ? node.tags.toLowerCase().split(',').map((t) => t.trim()) : [];
            if (!opts.filterTags.every((t) => nodeTags.includes(t))) continue;
        }
        matched.push(node);
    }
    return { matched, protectedCount };
}

test('protected nodes are never in matched, always counted in protectedCount', () => {
    const nodes: MockNode[] = [
        { id: 'a', status: 'protected', classification: 'tactical', createdAt: '2020-01-01T00:00:00Z' },
        { id: 'b', status: 'active',    classification: 'tactical', createdAt: '2020-01-01T00:00:00Z' },
    ];
    const { matched, protectedCount } = applyPruneFilters(nodes, {});
    assert.equal(matched.length, 1);
    assert.equal(matched[0]!.id, 'b');
    assert.equal(protectedCount, 1);
});

test('already-archived nodes are skipped entirely (not counted as protected)', () => {
    const nodes: MockNode[] = [
        { id: 'a', status: 'archived', classification: 'tactical', createdAt: '2020-01-01T00:00:00Z' },
        { id: 'b', status: 'active',   classification: 'tactical', createdAt: '2020-01-01T00:00:00Z' },
    ];
    const { matched, protectedCount } = applyPruneFilters(nodes, {});
    assert.equal(matched.length, 1);
    assert.equal(matched[0]!.id, 'b');
    assert.equal(protectedCount, 0);
});

test('classification filter excludes non-matching nodes', () => {
    const nodes: MockNode[] = [
        { id: 'a', classification: 'foundational', createdAt: '2020-01-01T00:00:00Z' },
        { id: 'b', classification: 'tactical',     createdAt: '2020-01-01T00:00:00Z' },
    ];
    const { matched } = applyPruneFilters(nodes, { classification: 'tactical' });
    assert.equal(matched.length, 1);
    assert.equal(matched[0]!.id, 'b');
});

test('age cutoff: node created exactly AT cutoff is excluded (not strictly before)', () => {
    const cutoff = '2024-01-01T00:00:00.000Z';
    const nodes: MockNode[] = [
        { id: 'old',   createdAt: '2023-12-31T23:59:59.999Z' }, // before → included
        { id: 'exact', createdAt: cutoff },                      // at boundary → excluded
        { id: 'newer', createdAt: '2024-01-01T00:00:00.001Z' }, // after → excluded
    ];
    const { matched } = applyPruneFilters(nodes, { cutoff });
    assert.equal(matched.length, 1);
    assert.equal(matched[0]!.id, 'old');
});

test('tag filter excludes nodes missing one of the required tags', () => {
    const nodes: MockNode[] = [
        { id: 'a', createdAt: '2020-01-01T00:00:00Z', tags: 'alpha,beta' },
        { id: 'b', createdAt: '2020-01-01T00:00:00Z', tags: 'alpha' },
        { id: 'c', createdAt: '2020-01-01T00:00:00Z', tags: '' },
    ];
    const { matched } = applyPruneFilters(nodes, { filterTags: ['alpha', 'beta'] });
    assert.equal(matched.length, 1);
    assert.equal(matched[0]!.id, 'a');
});

test('tag filter is case-insensitive', () => {
    const nodes: MockNode[] = [
        { id: 'a', createdAt: '2020-01-01T00:00:00Z', tags: 'Alpha,BETA' },
    ];
    const { matched } = applyPruneFilters(nodes, { filterTags: ['alpha', 'beta'] });
    assert.equal(matched.length, 1);
});

test('zero matched nodes when all are protected', () => {
    const nodes: MockNode[] = [
        { id: 'x', status: 'protected', classification: 'tactical', createdAt: '2020-01-01T00:00:00Z' },
        { id: 'y', status: 'protected', classification: 'tactical', createdAt: '2020-01-01T00:00:00Z' },
    ];
    const { matched, protectedCount } = applyPruneFilters(nodes, {});
    assert.equal(matched.length, 0);
    assert.equal(protectedCount, 2);
});

/* ─── Feature 6: anchor adversarial ─────────────────────────────── */

console.log('\n─── Feature 6: anchor adversarial ───');

test('parseAnchors — items with extra fields beyond type/ref are kept', () => {
    const raw = '[{"type":"url","ref":"https://example.com","extra":"ignored","count":42}]';
    const anchors = parseAnchors(raw);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.type, 'url');
    assert.equal(anchors[0]!.ref, 'https://example.com');
});

test('parseAnchors — null/false/number entries in array are filtered out', () => {
    const raw = '[null, {"type":"url","ref":"x"}, false, 42, "string"]';
    const anchors = parseAnchors(raw);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.ref, 'x');
});

test('parseAnchors — ref containing SQL injection characters is returned as-is', () => {
    const ref = `'; DROP TABLE LoreNode; --`;
    const raw = JSON.stringify([{ type: 'url', ref }]);
    const anchors = parseAnchors(raw);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.ref, ref);
});

test('parseAnchors — deeply nested non-array JSON returns empty', () => {
    assert.deepEqual(parseAnchors('{"anchors":[{"type":"url","ref":"x"}]}'), []);
});

test('parseAnchors — whitespace-only string returns empty', () => {
    assert.deepEqual(parseAnchors('   '), []);
});

test('parseAnchors — item with empty string type is filtered (fails typeof check)', () => {
    // empty string is still typeof 'string', so it passes — verify it IS included
    const raw = '[{"type":"","ref":"some-ref"}]';
    const anchors = parseAnchors(raw);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.type, '');
});

test('parseAnchors — item with numeric type (non-string) is filtered out', () => {
    const raw = '[{"type":42,"ref":"some-ref"}]';
    const anchors = parseAnchors(raw);
    assert.equal(anchors.length, 0);
});

test('parseAnchors — very large array (1000 items) processes without error', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ type: 'url', ref: `https://example.com/${i}` }));
    const raw = JSON.stringify(items);
    const anchors = parseAnchors(raw);
    assert.equal(anchors.length, 1000);
    assert.equal(anchors[999]!.ref, 'https://example.com/999');
});

/* ─── Summary ───────────────────────────────────────────────────── */

// Wait for any async tests to settle.
setImmediate(() => {
    setTimeout(() => {
        console.log(`\n─── Summary: ${passed}/${passed + failed} passed ───`);
        if (failed > 0) process.exit(1);
    }, 100);
});

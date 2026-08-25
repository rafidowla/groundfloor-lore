#!/usr/bin/env tsx
/**
 * audit-e2e-fixes-unit.ts — regression coverage for the confirmed issues from
 * the E2E recursive audit (local + embedded). Each test names its finding.
 *
 * Run: npm run test:unit:audit-e2e-fixes
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { ensureAccessTracker } from '../packages/lore/src/engines/accessTracker.js';
import { GraphNodeStore } from '../packages/lore/src/engines/maintain/adapters.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const noop = () => undefined;
const stub = new Proxy({}, { get: () => noop }) as never;

function nodeData(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, type: 'note', label: 'L', content: 'c', tags: ['t'], project: 'w', ecosystem: '*', metadata: '{}', ...extra };
}

console.log('AUDIT E2E FIXES');

// ── #2 — embedded nodeUpsert must reject an unsafe id (no durable orphan) ──
await test('#2 nodeUpsert rejects unsafe node id with {ok:false, invalid_node_id} and writes NOTHING', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-orphan-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        // fix/id-alphabet-sql-interpolation (2026-08-04): quote-bearing ids are
        // no longer "unsafe" — escaping (quote-doubling, vendor-sanctioned) is
        // the injection control, so "evil'(;--id" is a legitimate id now. The
        // orphan-guard invariant (reject BEFORE any write) still applies to the
        // ids escaping cannot make safe: NUL bytes.
        const badId = 'evil\x00id';
        const res = await nodeUpsert(
            { id: badId, workspace: 'w', ecosystem: '*', nodeData: nodeData(badId), targetGraph: g as never, initiator: 'test' },
            { verbatim: stub, getWal: () => stub } as never,
        );
        assert.equal(res.ok, false, 'NUL id must be rejected');
        assert.equal((res as { code: string }).code, 'invalid_node_id', 'precise failure code');
        assert.match((res as { error: Error }).error.message, /NUL byte/, 'rejection names the reason');
        // Probe "nothing was persisted". SurrealGraph refuses to BIND a
        // NUL-bearing id at the read boundary too (LoreGraphError
        // invalid_node_id — strictly stronger than LocalGraph's silent null),
        // so loud rejection is equally valid proof of non-persistence.
        let probe: unknown = 'unchecked';
        try { probe = await g.getNode(badId); }
        catch (rejected) {
            assert.match((rejected as Error).message, /NUL|invalid_node_id/, 'probe rejects for the id itself, not a store failure');
            probe = null;
        }
        assert.equal(probe, null, 'NO graph node persisted — no durable orphan');

        // a quote-bearing id (old-alphabet "unsafe") now writes + reads back —
        // the fix this branch ships.
        const quotedId = "evil'(;--id";
        const quoted = await nodeUpsert(
            { id: quotedId, workspace: 'w', ecosystem: '*', nodeData: nodeData(quotedId), targetGraph: g as never, initiator: 'test' },
            { verbatim: stub, getWal: () => stub } as never,
        );
        assert.equal(quoted.ok, true, 'quote-bearing id is legitimate post-fix');
        assert.ok(await g.getNode(quotedId), 'quote-bearing node is persisted');

        // a safe id still succeeds (guard does not over-reject)
        const ok = await nodeUpsert(
            { id: 'safe-id', workspace: 'w', ecosystem: '*', nodeData: nodeData('safe-id'), targetGraph: g as never, initiator: 'test' },
            { verbatim: stub, getWal: () => stub } as never,
        );
        assert.equal(ok.ok, true, 'safe id still writes');
        assert.ok(await g.getNode('safe-id'), 'safe node is persisted');
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── #4/#7 — status + classification persist and read back ──────────────────
// Before: upsertNode CREATE/SET omitted these columns and rowToLoreNode never
// read them, so soft-archive (status='archived' → hidden from recall),
// protected-from-prune (status='protected'), and corpus status/classification
// counters were ALL silent no-ops. The recall/prune/corpus code that reads
// node.status was correct — it just never saw a value.
await test('#4/#7 status + classification round-trip (archive hides, protected survives, counters work)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-status-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        // fresh create → schema defaults
        await g.upsertNode(nodeData('n1') as never);
        const fresh = await g.getNode('n1');
        assert.equal(fresh?.status, 'active', 'fresh node defaults to status=active (not undefined/dropped)');
        assert.equal(fresh?.classification, 'tactical', 'fresh node defaults to classification=tactical');

        // soft-archive (read-modify-write, as prune_nodes does)
        await g.upsertNode({ ...fresh, status: 'archived' } as never);
        assert.equal((await g.getNode('n1'))?.status, 'archived', 'archived status PERSISTS (was silently dropped)');

        // protect + reclassify
        await g.upsertNode({ ...fresh, status: 'protected', classification: 'foundational' } as never);
        const prot = await g.getNode('n1');
        assert.equal(prot?.status, 'protected', 'protected status persists (so prune can skip it)');
        assert.equal(prot?.classification, 'foundational', 'classification persists (corpus counters)');

        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── #1 — a write with no explicit project is findable in its workspace's list ──
// Before: postNode/bulk-write/embedded passed the raw body (no project), so the
// node persisted with project='*' and was INVISIBLE to listNodes(project=W) —
// the GET /api/nodes + bulk-list filter — while MCP store_node (which sets
// project=workspace) was visible. The chokepoint now defaults project=workspace.
await test('#1 node written without project is findable via listNodes(project=workspace) (RYW)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ryw-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        // raw HTTP-body shape: no `project`, workspace='myws'
        const res = await nodeUpsert(
            { id: 'h1', workspace: 'myws', ecosystem: '*', nodeData: { id: 'h1', type: 'note', label: 'L', content: 'c', tags: ['t'] }, targetGraph: g as never, initiator: 'test' },
            { verbatim: stub, getWal: () => stub } as never,
        );
        assert.equal(res.ok, true);
        assert.equal((await g.getNode('h1'))?.project, 'myws', 'project defaults to the workspace (was * before)');
        const inWs = await g.listNodes(undefined, undefined, 'myws', '*');
        assert.ok(inWs.some((n) => n.id === 'h1'), 'node IS findable in its workspace list (read-your-writes)');

        // an explicit non-default project is preserved (not clobbered)
        await nodeUpsert(
            { id: 'h2', workspace: 'myws', ecosystem: '*', nodeData: { id: 'h2', type: 'note', label: 'L', content: 'c', tags: ['t'], project: 'custom-proj' }, targetGraph: g as never, initiator: 'test' },
            { verbatim: stub, getWal: () => stub } as never,
        );
        assert.equal((await g.getNode('h2'))?.project, 'custom-proj', 'explicit project preserved');
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── R2 #3 — traverse() must carry true lifecycle state for NEIGHBOR nodes ──
// Before: traverse()'s explicit RETURN alias list omitted status/supersededBy/
// supersededAt (getNode/search/list use n.* and were fine), so rowToLoreNode
// defaulted a traversal neighbor to status='active', supersededBy/At=null —
// and recall's "hide archived / hide superseded" filters (which read those
// fields) silently passed archived/superseded nodes through whenever they were
// graph-adjacent to a seed (incl. via auto-created semantic_neighbor edges).
// Fix #4 only covered the direct-seed path; this is the traversal projection.
await test('R2#3 traverse() carries status/supersededBy/supersededAt for neighbors (parity with getNode)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trav-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        await g.upsertNode(nodeData('seed') as never);
        await g.upsertNode(nodeData('arch', { status: 'archived' }) as never);
        await g.upsertNode(nodeData('sup') as never);
        await g.upsertNode(nodeData('newer') as never);
        await g.supersedeNode('sup', 'newer'); // real supersession path (dedicated SET)
        await g.addEdge({ sourceId: 'seed', targetId: 'arch', relation: 'rel' } as never);
        await g.addEdge({ sourceId: 'seed', targetId: 'sup', relation: 'rel' } as never);

        const res = await g.traverse('seed', 1);
        const pick = (id: string): Record<string, unknown> => {
            const r = res.find((x) => ((x as { node?: { id?: string }; id?: string }).node?.id ?? (x as { id?: string }).id) === id) as { node?: Record<string, unknown> } | undefined;
            return (r?.node ?? r ?? {}) as Record<string, unknown>;
        };
        assert.equal(pick('arch').status, 'archived', 'archived neighbor must read status=archived via traverse (was active)');
        assert.equal(pick('sup').supersededBy, 'newer', 'superseded neighbor must read supersededBy via traverse (was null)');
        assert.ok(pick('sup').supersededAt, 'superseded neighbor must read supersededAt via traverse (was null)');
        // parity with the direct read
        assert.equal((await g.getNode('arch'))?.status, 'archived');
        assert.equal((await g.getNode('sup'))?.supersededBy, 'newer');
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── R2 #4 — deleteNode/supersede serialize on the per-id write chain ──
// Before: only upsertNode joined nodeWriteChain; deleteNode + supersede/
// unsupersede did not, so a delete could land between a concurrent upsert's
// existence-check and its SET (silent no-op, reported success). Fix routes all
// three through the same KeyedMutex keyed on the mutated id. This guards the
// serialized path: heavy same-id contention must not deadlock, crash, or leave
// a malformed state, and the chain must recover; plus the existence-gated
// supersede correctly reports old-not-found once the node is gone.
await test('R2#4 concurrent upsert/delete/supersede on one id: no deadlock/crash, consistent state, chain recovers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-race-'));
    const node = (id: string, c = 'v') => nodeData(id, { content: c });
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        await g.upsertNode(node('newer') as never);

        let unexpected = 0;
        for (let i = 0; i < 50; i++) {
            await g.upsertNode(node('X', 'v' + i) as never);
            const settled = await Promise.allSettled([
                g.upsertNode(node('X', 'u' + i) as never),
                g.deleteNode('X'),
                g.supersedeNode('X', 'newer'),
            ]);
            for (const s of settled) {
                if (s.status === 'rejected' && !/backpressure|edge_endpoint|not.?found/i.test(String(s.reason?.message ?? ''))) unexpected++;
            }
            const n = await g.getNode('X');
            assert.ok(n === null || n.id === 'X', 'final state must be null or a well-formed X (never malformed)');
        }
        assert.equal(unexpected, 0, 'no unexpected crash/exception under same-id contention');

        // chain not stuck: a sequential delete then re-upsert still works
        await g.deleteNode('X');
        await g.upsertNode(node('X', 'final') as never);
        assert.equal((await g.getNode('X'))?.content, 'final', 'per-id chain recovered (not deadlocked)');

        // existence-gated supersede reports old-not-found once the node is gone
        await g.deleteNode('X');
        const sup = await g.supersedeNode('X', 'newer');
        assert.equal(sup.ok, false, 'supersede on a deleted node must fail, not silently no-op');
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── R2 #5 — upsertNode return tags must match persisted (normalized string[]) ──
// Before: both upsertNode branches spread ...nodeData, echoing the caller's RAW
// tags (e.g. a comma string or mixed-case dupes), so the return diverged from
// getNode and the declared LoreNode.tags: string[] contract.
await test('R2#5 upsertNode return .tags equals getNode().tags (normalized string[]) on CREATE and SET', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-tags-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        // CREATE — messy comma-string input
        const created = await g.upsertNode(nodeData('n1', { tags: 'Foo, BAR ,foo,Baz' }) as never);
        assert.ok(Array.isArray(created.tags), 'return tags must be an array (LoreNode.tags: string[])');
        assert.deepEqual(created.tags, (await g.getNode('n1'))?.tags, 'CREATE return tags must equal persisted');
        assert.deepEqual(created.tags, ['foo', 'bar', 'baz'], 'lowercased + deduped');
        // SET — array with dupes/case
        const updated = await g.upsertNode(nodeData('n1', { tags: ['X', 'x', 'Y'] }) as never);
        assert.deepEqual(updated.tags, (await g.getNode('n1'))?.tags, 'SET return tags must equal persisted');
        assert.deepEqual(updated.tags, ['x', 'y']);
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── R3 #5 — a NON-STRING node id must also be rejected at the chokepoint ──
// Before: assertSafeLanceId(id) was typed string but a runtime non-string
// slipped through ((5).length is undefined → length check false; SAFE_ID_RE
// coerces 5→"5" and passes), so a numeric/array id wrote a graph node while
// the verbatim canonical key differed — a split-brain orphan reported ok:true.
await test('R3#5 non-string node id is rejected ({ok:false, invalid_node_id}), writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-nonstr-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        for (const badId of [123, ['a'], { x: 1 }, null] as unknown[]) {
            const res = await nodeUpsert(
                { id: badId as never, workspace: 'w', ecosystem: '*', nodeData: { id: badId, type: 'note', label: 'L', content: 'c', tags: ['t'] }, targetGraph: g as never, initiator: 'test' },
                { verbatim: stub, getWal: () => stub } as never,
            );
            assert.equal(res.ok, false, `non-string id ${JSON.stringify(badId)} must be rejected`);
            assert.equal((res as { code: string }).code, 'invalid_node_id');
            if (badId != null) assert.equal(await g.getNode(String(badId)), null, 'no graph node persisted (no orphan)');
        }
        // string id still works
        const ok = await nodeUpsert(
            { id: 'good', workspace: 'w', ecosystem: '*', nodeData: nodeData('good'), targetGraph: g as never, initiator: 'test' },
            { verbatim: stub, getWal: () => stub } as never,
        );
        assert.equal(ok.ok, true);
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── R3 #3 — access tracker is PER-GRAPH, not a process-wide singleton ──
// Before: ensureAccessTracker returned the first-seen singleton regardless of
// the target, so a recall/search against a non-active workspace stamped
// last_retrieved_at / lastAccessedAt onto the BOOT graph — corrupting the
// coldness/retention signal lore maintain prunes on (acute on id reuse across
// a human's workspaces).
await test('R3#3 ensureAccessTracker routes per-graph — a workspace-B stamp never lands on boot/A', async () => {
    const stampedA: string[] = [];
    const stampedB: string[] = [];
    const graphA = { stampAccessTimes: async (e: Array<{ id: string }>) => { for (const x of e) stampedA.push(x.id); return e.length; } };
    const graphB = { stampAccessTimes: async (e: Array<{ id: string }>) => { for (const x of e) stampedB.push(x.id); return e.length; } };

    const tA = ensureAccessTracker(graphA);
    const tB = ensureAccessTracker(graphB);
    assert.ok(tA && tB, 'both graphs get a tracker');
    assert.notEqual(tA, tB, 'distinct tracker per graph (not a shared singleton)');
    assert.equal(ensureAccessTracker(graphA), tA, 'stable per graph');

    // Stamp via B's tracker only (a workspace-B recall). Must NOT touch A (boot).
    (tB as unknown as { touch: (ids: string[], s: string) => void }).touch(['collide:1'], 'retrieval');
    await (tB as unknown as { flush: () => Promise<number> }).flush();
    assert.deepEqual(stampedB, ['collide:1'], 'B graph stamped its own node');
    assert.deepEqual(stampedA, [], 'boot/A graph received NO cross-workspace stamp');
});

// ── R4 #3 — recall seed query excludes hidden nodes (no crowd-out) ──────────
// Before: the engine's search returned the top-`limit` matches with NO status/
// supersededAt predicate; recall filtered archived/superseded AFTER that slice,
// so hidden rows consumed seed slots and a matching LIVE node ranked just
// outside the window was never fetched → false-negative recall. search() now
// takes excludeHidden (recall passes true) so hidden rows never enter the
// candidate set. This tests the precise contract: with excludeHidden=true,
// archived/superseded matches are absent from the result even though they match
// the query; with false, they're present (general search() unchanged).
await test('R4#3 search(excludeHidden=true) drops archived + superseded from the seed window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-seed-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        const note = (id: string, extra: Record<string, unknown> = {}) => g.upsertNode(nodeData(id, { content: 'needle widget here', ...extra }) as never);
        for (let i = 0; i < 3; i++) await note('arch' + i, { status: 'archived' });
        await note('sup-old');
        await note('sup-new');
        await g.supersedeNode('sup-old', 'sup-new'); // real supersession
        await note('live1');
        await note('live2');

        type G = { search: (q: string, n: number, ws: string, eco: string, ex?: boolean) => Promise<Array<{ id: string }>> };
        const withHidden = (await (g as unknown as G).search('needle', 10, '*', '*', false)).map((n) => n.id);
        const liveOnly = (await (g as unknown as G).search('needle', 10, '*', '*', true)).map((n) => n.id);

        // default search surfaces everything that matches (archived + superseded + live)
        assert.ok(withHidden.includes('arch0') && withHidden.includes('sup-old'), 'default search includes hidden matches');
        // excludeHidden drops every archived + superseded match, keeps the live ones
        assert.ok(liveOnly.includes('live1') && liveOnly.includes('live2'), 'live nodes present');
        assert.ok(!liveOnly.some((id) => id.startsWith('arch')), `no archived in seed window; got ${JSON.stringify(liveOnly)}`);
        assert.ok(!liveOnly.includes('sup-old'), 'superseded predecessor excluded from seed window');
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── R5 #4 — maintenance archive serializes + invalidates the read cache ──────
// Before: GraphNodeStore.archive ran SET status='archived' via a raw graph
// query, bypassing nodeWriteChain (a concurrent upsertNode could clobber the
// archive — TOCTOU) and skipping the read-cache epoch bump (a node read just
// before stayed cached as 'active' — RYW gap). Now it routes through
// the graph engine's archiveNode (per-id chain + bumpEpoch).
await test('R5#4 maintenance archive persists + invalidates the read cache (no stale active read)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-arch-'));
    try {
        const g = new SurrealGraph(dir);
        await g.initialize();
        await g.upsertNode(nodeData('x') as never);
        assert.equal((await g.getNode('x'))?.status, 'active', 'cache populated with active');

        const store = new GraphNodeStore(g as never);
        await store.archive('x'); // routes through archiveNode (serialized + bumpEpoch)

        // the read-cache epoch bump means this is NOT a stale 'active' hit
        assert.equal((await g.getNode('x'))?.status, 'archived', 'archive is visible immediately (cache invalidated)');

        // serialization smoke: concurrent upsert + archive of the same id — no
        // deadlock/crash, and the final state is a well-formed node.
        const settled = await Promise.allSettled([g.upsertNode(nodeData('x') as never), store.archive('x'), g.archiveNode('x')]);
        assert.ok(!settled.some((s) => s.status === 'rejected'), 'concurrent upsert/archive of one id does not crash');
        assert.ok(await g.getNode('x'), 'node still well-formed after the race');
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

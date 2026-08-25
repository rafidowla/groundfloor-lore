/**
 * test/migrate-workspace-edges-unit.ts
 *
 * Regression coverage for the workspace-to-workspace edge-copy audit
 * finding (docs/audit/FINDINGS-2026-08-17-functional-correctness.md):
 *
 *   - an edge whose destination write THREW was counted as copied
 *     (empty `catch {}` + unconditional `edgesCopied += 1`), and
 *   - `--delete-source` then deleted the source nodes, making the loss
 *     permanent — including edges dropped as "dangling" because their
 *     other endpoint was skipped on conflict.
 *
 * Drives the REAL `migrateWorkspaceToWorkspace()` against real on-disk
 * SurrealGraph (embedded SurrealDB) workspaces. The only seam is the
 * command's own `injected` escape hatch plus a fault-injecting Proxy
 * around the destination graph that makes ONE addEdge/upsertNode call
 * throw. Everything else — queryEdges paging, moved-set tracking, the
 * report counters, the delete-source gate — is production code.
 *
 * Run:  LORE_HOME=$(mktemp -d) npx tsx test/migrate-workspace-edges-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    console.error(
        'ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n' +
            'Use: LORE_HOME=$(mktemp -d) npx tsx test/migrate-workspace-edges-unit.ts',
    );
    process.exit(2);
}

// Pre-create workspaces.json enumerating one (src,dst) pair per test.
const TEST_LABELS = ['t1', 't2', 't3', 't4'];

function seedAllWorkspaces(home: string): void {
    const entries = TEST_LABELS.flatMap((label) => {
        const srcPath = path.join(home, 'workspaces', `${label}-src`);
        const dstPath = path.join(home, 'workspaces', `${label}-dst`);
        fs.mkdirSync(path.join(srcPath, '.lore'), { recursive: true });
        fs.mkdirSync(path.join(dstPath, '.lore'), { recursive: true });
        return [
            { name: `${label}-src`, path: srcPath, createdAt: '2026-08-17T00:00:00.000Z' },
            { name: `${label}-dst`, path: dstPath, createdAt: '2026-08-17T00:00:00.000Z' },
        ];
    });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: entries[0]!.name,
        workspaces: entries,
    }, null, 2));
}
seedAllWorkspaces(TEST_HOME!);

// Dynamic imports are deliberate (same as phase6-p4): config/workspaces.ts
// caches LORE_HOME at module load, so workspaces.json above MUST be seeded
// before any lore module is imported; static imports would hoist ahead of it.
const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
const { migrateWorkspaceToWorkspace } = await import('../packages/lore/src/cli/commands/migrateWorkspaceToWorkspace.js');

/* ─── Per-test scaffolding ─────────────────────────────────────── */

interface Scaffold {
    srcName: string;
    dstName: string;
    src: InstanceType<typeof SurrealGraph>;
    dst: InstanceType<typeof SurrealGraph>;
}

async function closeScaffold(s: Scaffold): Promise<void> {
    try { await s.src.close(); } catch { /* embedded close can throw */ }
    try { await s.dst.close(); } catch { /* */ }
}

async function newScaffold(label: string): Promise<Scaffold> {
    const srcName = `${label}-src`;
    const dstName = `${label}-dst`;
    const srcPath = path.join(TEST_HOME!, 'workspaces', srcName);
    const dstPath = path.join(TEST_HOME!, 'workspaces', dstName);
    const src = new SurrealGraph(srcPath, { workspaceId: srcName });
    const dst = new SurrealGraph(dstPath, { workspaceId: dstName });
    await src.initialize();
    await dst.initialize();
    return { srcName, dstName, src, dst };
}

async function seedDecisions(graph: InstanceType<typeof SurrealGraph>, n: number, idPrefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const id = `${idPrefix}-dec-${i}`;
        ids.push(id);
        await graph.upsertNode({
            id, type: 'decision', label: `Decision ${i}`,
            content: `seed-content-${i}`,
            tags: ['auto-seed'],
            project: 'src', ecosystem: 'default',
            metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
        });
    }
    return ids;
}

async function countNodes(graph: InstanceType<typeof SurrealGraph>): Promise<number> {
    return (await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true })).length;
}

async function countEdgesFrom(graph: InstanceType<typeof SurrealGraph>, sourceId: string): Promise<number> {
    let total = 0;
    for (let offset = 0; ; offset += 500) {
        const page = await graph.queryEdges({ source: sourceId, limit: 500, offset });
        total += page.length;
        if (page.length < 500) return total;
    }
}

type EdgeSpec = { sourceId: string; targetId: string; relation: string; confidence: 'extracted'; confidenceScore: number };
type NodeSpec = Parameters<InstanceType<typeof SurrealGraph>['upsertNode']>[0];

/**
 * Fault injection around a REAL SurrealGraph: every method is the bound
 * production method except the one `failAddEdge`/`failUpsertNode`
 * selects, which rejects. The command under test cannot tell the
 * difference — it sees a genuine destination write failure.
 */
function withFaults(
    graph: InstanceType<typeof SurrealGraph>,
    faults: {
        failAddEdge?: (edge: EdgeSpec) => boolean;
        failUpsertNode?: (node: NodeSpec) => boolean;
    },
): InstanceType<typeof SurrealGraph> {
    return new Proxy(graph, {
        get(target, prop) {
            if (prop === 'addEdge' && faults.failAddEdge) {
                return (edge: EdgeSpec) => faults.failAddEdge!(edge)
                    ? Promise.reject(new Error(`injected dest write failure: edge ${edge.sourceId} -> ${edge.targetId}`))
                    : target.addEdge(edge);
            }
            if (prop === 'upsertNode' && faults.failUpsertNode) {
                return (node: NodeSpec) => faults.failUpsertNode!(node)
                    ? Promise.reject(new Error(`injected dest write failure: node ${node.id}`))
                    : target.upsertNode(node);
            }
            const v = Reflect.get(target, prop);
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
    });
}

/* ─── T1: a thrown destination edge write is NOT counted as copied ── */

async function testT1_failedEdgeWriteNotCopiedAndDeleteRefused(): Promise<void> {
    const s = await newScaffold('t1');
    await seedDecisions(s.src, 3, 't1');
    await s.src.addEdge({ sourceId: 't1-dec-0', targetId: 't1-dec-1', relation: 'depends_on', confidence: 'extracted', confidenceScore: 1 });
    await s.src.addEdge({ sourceId: 't1-dec-1', targetId: 't1-dec-2', relation: 'blocks', confidence: 'extracted', confidenceScore: 1 });

    const failingDst = withFaults(s.dst, { failAddEdge: (e) => e.relation === 'blocks' });
    const report = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName,
        includeEdges: true, deleteSource: true,
        apply: true, force: true, onConflict: 'fail',
        injected: { srcGraph: s.src, dstGraph: failingDst },
    });

    assert.equal(report.upserted, 3, `upserted=${report.upserted}`);
    assert.equal(report.edgesCopied, 1, `failed edge must not count as copied, edgesCopied=${report.edgesCopied}`);
    assert.equal(report.edgesFailed, 1, `thrown addEdge must be counted, edgesFailed=${report.edgesFailed}`);
    assert.equal(report.edgesSkippedDangling, 0);
    // --delete-source after a failed copy is REFUSED: the failed edge
    // exists only in the source, deleting would make the loss permanent.
    assert.equal(report.sourceDeleteRefused, true, 'delete-source must be refused after a failed edge write');
    assert.equal(report.sourceDeleted, 0, 'nothing may be deleted from source');

    assert.equal(await countNodes(s.src), 3, 'source nodes intact');
    assert.equal(await countEdgesFrom(s.src, 't1-dec-0'), 1, 'source edge intact');
    assert.equal(await countEdgesFrom(s.src, 't1-dec-1'), 1, 'source edge intact');
    assert.equal(await countNodes(s.dst), 3, 'nodes did copy to dest');
    assert.equal(await countEdgesFrom(s.dst, 't1-dec-0'), 1, 'successful edge landed in dest');
    assert.equal(await countEdgesFrom(s.dst, 't1-dec-1'), 0, 'failed edge absent from dest');
    console.log('  ✓ T1: thrown edge write counted as failed (not copied); delete-source refused');
    await closeScaffold(s);
}

/* ─── T2: edge to a conflict-skipped endpoint → dangling → refusal ── */

async function testT2_danglingFromConflictSkipRefusesDelete(): Promise<void> {
    const s = await newScaffold('t2');
    await seedDecisions(s.src, 2, 't2');
    await s.src.addEdge({ sourceId: 't2-dec-0', targetId: 't2-dec-1', relation: 'depends_on', confidence: 'extracted', confidenceScore: 1 });
    // Pre-existing destination node → t2-dec-1 conflicts and is SKIPPED,
    // so the dec-0 → dec-1 edge's target never enters the moved set.
    await s.dst.upsertNode({
        id: 't2-dec-1', type: 'decision', label: 'pre-existing in dst',
        content: 'dst copy', tags: [], project: 'dst', ecosystem: 'default',
        metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
    });

    const report = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName,
        includeEdges: true, deleteSource: true,
        apply: true, force: true, onConflict: 'skip',
        injected: { srcGraph: s.src, dstGraph: s.dst },
    });

    assert.equal(report.upserted, 1, `upserted=${report.upserted}`);
    assert.equal(report.skipped, 1, `skipped=${report.skipped}`);
    assert.equal(report.edgesCopied, 0, 'edge to skipped endpoint must not be copied');
    assert.equal(report.edgesSkippedDangling, 1, `edgesSkippedDangling=${report.edgesSkippedDangling}`);
    // The skipped-as-dangling edge exists ONLY in the source; deleting
    // dec-0 would destroy it. Refuse.
    assert.equal(report.sourceDeleteRefused, true, 'delete-source must be refused when edges were skipped as dangling');
    assert.equal(report.sourceDeleted, 0);

    assert.equal(await countNodes(s.src), 2, 'source nodes intact');
    assert.equal(await countEdgesFrom(s.src, 't2-dec-0'), 1, 'dangling edge still in source');
    console.log('  ✓ T2: conflict-skipped endpoint → dangling edge → delete-source refused');
    await closeScaffold(s);
}

/* ─── T3: clean copy control — delete-source proceeds ────────────── */

async function testT3_cleanCopyDeleteSourceProceeds(): Promise<void> {
    const s = await newScaffold('t3');
    await seedDecisions(s.src, 3, 't3');
    await s.src.addEdge({ sourceId: 't3-dec-0', targetId: 't3-dec-1', relation: 'depends_on', confidence: 'extracted', confidenceScore: 1 });
    await s.src.addEdge({ sourceId: 't3-dec-1', targetId: 't3-dec-2', relation: 'blocks', confidence: 'extracted', confidenceScore: 1 });

    const report = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName,
        includeEdges: true, deleteSource: true,
        apply: true, force: true, onConflict: 'fail',
        injected: { srcGraph: s.src, dstGraph: s.dst },
    });

    assert.equal(report.upserted, 3);
    assert.equal(report.edgesCopied, 2, `edgesCopied=${report.edgesCopied}`);
    assert.equal(report.edgesFailed, 0);
    assert.equal(report.edgesSkippedDangling, 0);
    assert.equal(report.sourceDeleteRefused, false, 'clean copy must not trip the gate');
    assert.equal(report.sourceDeleted, 3, `sourceDeleted=${report.sourceDeleted}`);

    assert.equal(await countNodes(s.src), 0, 'source emptied after clean delete-source');
    assert.equal(await countNodes(s.dst), 3, 'dest received all nodes');
    assert.equal(await countEdgesFrom(s.dst, 't3-dec-0'), 1);
    assert.equal(await countEdgesFrom(s.dst, 't3-dec-1'), 1);
    console.log('  ✓ T3: clean copy + delete-source proceeds unchanged (control)');
    await closeScaffold(s);
}

/* ─── T4: a failed node upsert also refuses delete-source ────────── */

async function testT4_failedNodeUpsertRefusesDelete(): Promise<void> {
    const s = await newScaffold('t4');
    await seedDecisions(s.src, 3, 't4');

    const failingDst = withFaults(s.dst, { failUpsertNode: (n) => n.id === 't4-dec-1' });
    const report = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName,
        deleteSource: true,
        apply: true, force: true, onConflict: 'fail',
        injected: { srcGraph: s.src, dstGraph: failingDst },
    });

    assert.equal(report.upserted, 2, `upserted=${report.upserted}`);
    assert.equal(report.nodesFailed, 1, `thrown upsertNode must be counted, nodesFailed=${report.nodesFailed}`);
    assert.equal(report.sourceDeleteRefused, true, 'delete-source must be refused after a failed node write');
    assert.equal(report.sourceDeleted, 0);

    assert.equal(await countNodes(s.src), 3, 'source nodes intact');
    assert.equal(await countNodes(s.dst), 2, 'dest holds only the successful writes');
    console.log('  ✓ T4: thrown node upsert counted as failed; delete-source refused');
    await closeScaffold(s);
}

/* ─── Runner ───────────────────────────────────────────────────── */
//
// Unlike the Kùzu-backed original (which spawned each test in its own
// child process to dodge kuzu-lite's native-teardown segfault), SurrealGraph
// has no such close/reopen hazard, so all four scenarios run in one process.

type TestFn = () => Promise<void>;
const TESTS: Record<string, TestFn> = {
    t1: testT1_failedEdgeWriteNotCopiedAndDeleteRefused,
    t2: testT2_danglingFromConflictSkipRefusesDelete,
    t3: testT3_cleanCopyDeleteSourceProceeds,
    t4: testT4_failedNodeUpsertRefusesDelete,
};

console.log('migrate-workspace-edges-unit.ts');
for (const fn of Object.values(TESTS)) {
    await fn();
}
console.log('All migrate-workspace-edges tests passed.');

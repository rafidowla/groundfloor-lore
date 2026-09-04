/**
 * surreal-bulk-loader-adapter-unit.ts — SurrealBulkLoaderAdapter and the
 * Phase 3c dispatcher graph-routing against a REAL embedded SurrealDB
 * workspace.
 *
 * Why this test is written the way it is
 * --------------------------------------
 * Phase 3c (legacy graph-engine removal) made the bulk loader's graph-row
 * target engine-selected instead of always the legacy engine. The failure
 * modes to rule out are NOT "throws an error" — they are the quiet ones:
 * graph rows silently vanishing (the pre-3c dispatcher dropped them when no
 * legacy-engine adapter was wired), a Surreal load masquerading under
 * legacy-engine wiring (the old
 * `as LocalGraph` cast), or per-row failure isolation regressing into a
 * whole-batch abort.
 *
 * So every assertion is an exact value against the graph's real state AFTER
 * the load (rows are queried back via getNode / queryEdges), the validation
 * contract is asserted message-for-message against the legacy engine's adapter
 * (identical checks, identical strings), and the resume contract is proven
 * by re-running the SAME batch and asserting the edge count does not double.
 *
 * Run: npx tsx test/surreal-bulk-loader-adapter-unit.ts
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import type { GraphRow } from '../packages/lore/src/bulkLoader/types.js';
import type { WorkspaceGraph } from '../packages/lore/src/engines/openWorkspaceGraph.js';

process.env['LORE_LOG_LEVEL'] ??= 'error';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-bulk-adapter-'));
process.env['LORE_HOME'] = dataDir;

// LORE_HOME must be assigned before the lore module graph initializes, so
// value imports are dynamic by necessity (same as every embedded-workspace
// test in this directory); the `import type`s above are erased at runtime.
const { createLore } = await import('../packages/lore/src/index.js');
const { SurrealBulkLoaderAdapter } = await import('../packages/lore/src/bulkLoader/surrealAdapter.js');
const { LoaderDispatcher } = await import('../packages/lore/src/bulkLoader/loaderDispatcher.js');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(
        `${ok ? '  ok' : 'FAIL'}  ${name}`
        + (ok ? '' : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`),
    );
}

const lore = await createLore({ deploymentMode: 'embedded', dataDir });
// Unchecked cast, reason: LoreInstance._daemon deliberately exposes only a
// tiny internal surface (LoreInternalHandles) without getGraph; the embedded
// daemon it wraps always has one, and this names exactly the surface the
// test drives — WorkspaceGraph plus the legacy-hatch probe.
const graph = (lore as unknown as {
    _daemon: { getGraph(): WorkspaceGraph & { withBulkConnection?: unknown } };
})._daemon.getGraph();

try {
    /* ── 0. the wiring premise: capability, not class ──────────────── */

    check('handle exposes bulkUpsertNodes (surreal hatch)', typeof graph.bulkUpsertNodes, 'function');
    check('handle lacks withBulkConnection (legacy hatch)', typeof graph.withBulkConnection, 'undefined');

    /* ── 1. adapter direct: rows land, bad rows are isolated ───────── */

    // Constructed the way mcp/server.ts's buildDispatcherDeps now does —
    // narrow surface over the live handle, no engine class imported.
    const adapter = new SurrealBulkLoaderAdapter({
        graph: {
            bulkUpsertNodes: (batch) => graph.bulkUpsertNodes(batch),
            addEdge: (edge) => graph.addEdge(edge),
        },
    });
    check('substrate id', adapter.substrate, 'surreal');

    const batch: GraphRow[] = [
        { kind: 'node', row: { id: 'sb-1', type: 'doc', label: 'SB 1', content: 'first', tags: ['Alpha', 'Beta'], project: 'p', ecosystem: 'e1', metadata: '{"k":1}', workspace: 'default' } },
        { kind: 'node', row: { id: 'sb-2', type: 'doc', label: 'SB 2', content: 'second', tags: 'Solo,Tag', workspace: 'default' } },
        { kind: 'node', row: { id: '', type: 'doc', label: 'bad', content: 'x', workspace: 'default' } },
        { kind: 'node', row: { id: 'evil', type: 'doc', label: 'evil', content: 'x', workspace: 'other' } },
        { kind: 'node', row: { id: 'sb-3', type: 'doc', label: 'SB 3', content: 'third', workspace: 'default' } },
        { kind: 'edge', row: { from: 'sb-1', to: 'sb-2', relationship: 'cites', workspace: 'default' } },
        { kind: 'edge', row: { from: 'sb-1', to: 'nope', relationship: 'cites', workspace: 'default' } },
        { kind: 'edge', row: { from: 'sb-2', to: '', relationship: 'cites', workspace: 'default' } },
    ];

    await adapter.begin({ workspace: 'default', embed: 'skip', jobId: 'job-1', baseRowIndex: 0 });
    check('empty batch is a no-op', (await adapter.writeBatch([])).written, 0);

    const r1 = await adapter.writeBatch(batch);
    check('good rows written', r1.written, 4);
    check('bad rows failed', r1.failed, 4);
    check('error rowIndexes are job-relative', r1.errors.map((e) => e.rowIndex).sort((a, b) => a - b), [2, 3, 6, 7]);
    check(
        'missing id message matches the legacy-engine contract',
        r1.errors.find((e) => e.rowIndex === 2)?.errorMessage,
        'missing_or_invalid_id',
    );
    check(
        'workspace mismatch message matches the legacy-engine contract',
        r1.errors.find((e) => e.rowIndex === 3)?.errorMessage,
        'workspace_mismatch (expected default, got other)',
    );
    check(
        'edge missing fields message matches the legacy-engine contract',
        r1.errors.find((e) => e.rowIndex === 7)?.errorMessage,
        'edge_missing_fields',
    );
    check(
        'dangling edge fails LOUD, naming the endpoint',
        (r1.errors.find((e) => e.rowIndex === 6)?.errorMessage ?? '').includes("target 'nope'"),
        true,
    );

    const cp = await adapter.checkpoint();
    check('checkpoint advanced past the batch', cp.checkpointRowId, 8);
    await adapter.commit();

    /* ── query the rows back — the actual proof they landed ────────── */

    const n1 = await graph.getNode('sb-1');
    check('node 1 landed (label)', n1?.label, 'SB 1');
    check('node 1 landed (metadata)', JSON.parse(n1?.metadata ?? '{}'), { k: 1 });
    check('string tags normalized like every write path', (await graph.getNode('sb-2'))?.tags, ['solo', 'tag']);
    check('workspace-mismatched node did NOT land', await graph.getNode('evil'), null);

    const cites = await graph.queryEdges({ relation: 'cites', limit: 100, offset: 0 });
    check('edge landed exactly once', cites.length, 1);
    check(
        'edge endpoints',
        cites.map((e) => `${e.sourceId}->${e.targetId}`),
        ['sb-1->sb-2'],
    );

    /* ── 2. resume contract: re-running the batch must not double-write ── */

    const r2 = await adapter.writeBatch(batch);
    check('re-run writes the same good rows (upsert)', r2.written, 4);
    check('re-run re-reports the same bad rows', r2.failed, 4);
    check(
        're-run error rowIndexes continue the job',
        r2.errors.map((e) => e.rowIndex).sort((a, b) => a - b),
        [10, 11, 14, 15],
    );
    const citesAfterRerun = await graph.queryEdges({ relation: 'cites', limit: 100, offset: 0 });
    check('edge NOT duplicated by re-run (per-triple dedup)', citesAfterRerun.length, 1);
    check('checkpoint advanced again', (await adapter.checkpoint()).checkpointRowId, 16);

    /* ── 3. dispatcher routes graph rows to the surreal adapter ────── */

    const disp = new LoaderDispatcher({ surreal: adapter });
    await disp.begin({ workspace: 'default', embed: 'skip', jobId: 'job-2', baseRowIndex: 0 });
    await disp.dispatch({ target: 'graph.node', row: { id: 'sd-1', type: 'note', label: 'SD', content: 'c', workspace: 'default' } }, 0);
    await disp.dispatch({ target: 'graph.node', row: { id: 'sd-2', type: 'note', label: 'SD2', content: 'c', workspace: 'default' } }, 1);
    // Same flush as the endpoints: proves the adapter writes a batch's
    // nodes before its edges (SurrealGraph.addEdge refuses dangling ends).
    await disp.dispatch({ target: 'graph.edge', row: { from: 'sd-1', to: 'sd-2', relationship: 'links', workspace: 'default' } }, 2);
    const snap = await disp.flushAll();
    check('dispatcher wrote all three graph rows', snap.written, 3);
    check('dispatcher reported zero failures', snap.failed, 0);
    check('dispatcher-routed node landed', (await graph.getNode('sd-1'))?.label, 'SD');
    const links = await graph.queryEdges({ relation: 'links', limit: 10, offset: 0 });
    check('dispatcher-routed edge landed', links.length, 1);
    await disp.commit();

    /* ── 4. fail closed: graph rows with NO graph adapter wired ────── */

    const closed = new LoaderDispatcher({});
    await closed.begin({ workspace: 'default', embed: 'skip', jobId: 'job-3', baseRowIndex: 0 });
    await closed.dispatch({ target: 'graph.node', row: { id: 'ghost', type: 't', label: 'l', content: 'c', workspace: 'default' } }, 0);
    const cs = await closed.flushAll();
    check('unwired graph row fails per-row, not silently', cs.failed, 1);
    check('nothing was written', cs.written, 0);
    check(
        'fail-closed error names the gap',
        (cs.errors[0]?.errorMessage ?? '').startsWith('graph_target_unsupported'),
        true,
    );
    check('fail-closed row never reached the graph', await graph.getNode('ghost'), null);

    /* ── 5. writeBatch before begin() throws ───────────────────────── */

    let prematureError = '';
    try {
        await new SurrealBulkLoaderAdapter({
            graph: {
                bulkUpsertNodes: (batch2) => graph.bulkUpsertNodes(batch2),
                addEdge: (edge) => graph.addEdge(edge),
            },
        }).writeBatch(batch);
    } catch (e) {
        prematureError = (e as Error).message;
    }
    check('writeBatch before begin() throws', prematureError, 'SurrealBulkLoaderAdapter.writeBatch called before begin()');
} finally {
    await lore.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nsurreal-bulk-loader-adapter: all assertions passed');

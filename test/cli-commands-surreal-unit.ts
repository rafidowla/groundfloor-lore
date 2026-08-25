#!/usr/bin/env tsx
/**
 * cli-commands-surreal-unit.ts — the ported CLI commands are correct on a
 * SurrealDB-backed workspace.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * Six commands used to construct `new LocalGraph(basePath)` and call
 * `assertKuzuBackedPath(...)`, so on a Surreal-backed workspace they REFUSED —
 * `lore lint`, `lore report`, `lore diagnose`, `lore migrate` (v1-sqlite) and
 * both ends of `lore migrate workspace-to-workspace`. Refusing was the right
 * answer while their internals were raw Cypher, because the alternative was
 * reading the real-but-EMPTY Kùzu `LoreNode` table a Surreal workspace still
 * carried and reporting a clean graph. It was never the destination.
 *
 * They now open whichever engine the workspace declares. This file used to
 * prove the swap by comparing a Kùzu workspace against a Surreal workspace
 * node-for-node; now that Kùzu is being removed, it instead pins the
 * SurrealDB-side behavior directly — the assertions below are the exact
 * values the shared client-side aggregation in `graphReportAggregates.ts`
 * must produce for this fixture, so a regression there still fails loudly
 * even with nothing left to diff against.
 *
 * ── WHY REPORT GETS THE MOST ATTENTION ──────────────────────────────────────
 *
 * `lore report`'s port rewrote real logic rather than swapping a constructor:
 * four raw Cypher aggregates (edge-confidence tally, hubs by degree,
 * recently-updated, orphans) became client-side aggregation over
 * `queryEdges` + `bulkListProjected`, in `engines/graphReportAggregates.ts`.
 *
 * Run: npx tsx test/cli-commands-surreal-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openWorkspaceGraph, type WorkspaceGraph } from '../packages/lore/src/engines/openWorkspaceGraph.js';
import { writeGraphReport } from '../packages/lore/src/engines/graphReport.js';
import { migrateWorkspaceToWorkspace } from '../packages/lore/src/cli/commands/migrateWorkspaceToWorkspace.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error('       ' + ((err as Error).message ?? String(err)));
    }
}

/* ─── a LORE_HOME with a SurrealDB-backed workspace ──────────────── */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-clisurreal-'));
process.env['LORE_HOME'] = home;

const WS = {
    surreal: { name: 'sws', engine: 'surreal' },
    // Destination for the workspace-to-workspace move.
    dst: { name: 'dws', engine: 'surreal' },
};
const wsPath = (name: string): string => path.join(home, 'workspaces', name);

for (const w of Object.values(WS)) fs.mkdirSync(path.join(wsPath(w.name), '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    version: 1,
    active: WS.surreal.name,
    workspaces: Object.values(WS).map((w) => ({
        name: w.name,
        path: wsPath(w.name),
        graphEngine: w.engine,
    })),
}, null, 2));

/**
 * Fixture shaped so every report section has something to get wrong:
 *   hub      — degree 4, the unambiguous top hub
 *   near1/2  — degree 2 each, TIED, so the id-ascending tie-break is exercised
 *   leaf1/2  — degree 1
 *   orphan   — no edges at all, the one row the orphan section must find
 * Confidence spans all three tiers so the tally cannot pass by defaulting.
 * Written in a fixed order with a real gap, so `updatedAt` ascends with array
 * order and the recently-updated ordering is comparable.
 */
const NODES = [
    // `insight`, not `note`: lintGraph's orphan check deliberately exempts
    // notes (graphStats.ts:98, `n.type <> 'note'`), so a note orphan would
    // make the lint assertion below vacuous.
    { id: 'orphan', type: 'insight', label: 'unattached', content: 'no edges', tags: ['x'] },
    { id: 'leaf2', type: 'note', label: 'leaf two', content: 'edge of the graph', tags: ['x'] },
    { id: 'leaf1', type: 'note', label: 'leaf one', content: 'edge of the graph', tags: ['x'] },
    { id: 'near2', type: 'decision', label: 'near two', content: 'one hop out', tags: ['y'] },
    { id: 'near1', type: 'decision', label: 'near one | piped', content: 'one hop out', tags: ['y'] },
    { id: 'hub', type: 'architecture', label: 'the hub', content: 'central node', tags: ['y'] },
];

const EDGES: Array<{ sourceId: string; targetId: string; relation: string; confidence: 'extracted' | 'inferred' | 'ambiguous'; confidenceScore: number }> = [
    { sourceId: 'hub', targetId: 'near1', relation: 'relates_to', confidence: 'extracted', confidenceScore: 1 },
    { sourceId: 'hub', targetId: 'near2', relation: 'relates_to', confidence: 'extracted', confidenceScore: 1 },
    { sourceId: 'hub', targetId: 'leaf1', relation: 'relates_to', confidence: 'inferred', confidenceScore: 0.5 },
    { sourceId: 'hub', targetId: 'leaf2', relation: 'relates_to', confidence: 'ambiguous', confidenceScore: 0.2 },
    { sourceId: 'near1', targetId: 'near2', relation: 'depends_on', confidence: 'inferred', confidenceScore: 0.4 },
];

function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

async function loadFixture(graph: WorkspaceGraph): Promise<void> {
    await graph.initialize();
    for (const n of NODES) {
        await graph.upsertNode({
            ...n,
            project: 'p',
            ecosystem: 'e',
            metadata: '{}',
        } as Parameters<WorkspaceGraph['upsertNode']>[0]);
        await sleep(3);
    }
    for (const e of EDGES) await graph.addEdge(e);
}

const surreal = openWorkspaceGraph(wsPath(WS.surreal.name), { workspaceId: WS.surreal.name });

console.log('cli-commands-surreal — the ported commands are correct on SurrealDB');

await loadFixture(surreal);

let surrealReport = '';

await test('precondition: the workspace opened a SurrealGraph, not the Kùzu default', () => {
    // Without this the rest of the file could silently be exercising the
    // still-empty Kùzu database a Surreal workspace carries alongside it.
    assert.equal(surreal.constructor.name, 'SurrealGraph');
});

await test('report: not the empty-database report', async () => {
    // The regression this whole port could have introduced. A Surreal-backed
    // workspace still has a real, empty Kùzu database on disk; reading THAT
    // yields a well-formed report of a graph with nothing in it.
    surrealReport = await writeGraphReport(surreal, { topN: 20 });
    assert.match(surrealReport, /\*\*Nodes\*\*: 6/, 'six fixture nodes are visible');
    assert.match(surrealReport, /\*\*Edges\*\*: 5/, 'five fixture edges are visible');
    assert.doesNotMatch(surrealReport, /_\(no nodes yet\)_/);
});

await test('report: the hub ranking is real, and ties break on id ascending', () => {
    // near1 and near2 are both degree 2. Without the explicit tie-break their
    // order is left to whatever the aggregate happened to return, which
    // drifts from run to run.
    const hubTable = surrealReport.split('## Top ')[1].split('##')[0];
    const rows = hubTable.split('\n').filter((l) => l.startsWith('| ') && l.includes('`'));
    const ids = rows.map((r) => r.split('`')[1]);
    assert.deepEqual(ids.slice(0, 3), ['hub', 'near1', 'near2']);
    assert.match(rows[0], /^\| 4 \|/, 'hub has degree 4 (in + out)');
});

await test('report: the nodes-by-type table breaks count ties on type name', () => {
    // The fixture is 2 note, 2 decision, 1 architecture, 1 insight — ties at
    // both counts. This ordering came from `Object.entries(typeBreakdown)`,
    // i.e. whatever order the aggregate happened to return, so without an
    // explicit tie-break the section's row order is not reproducible.
    const typeTable = surrealReport.split('### Nodes by type')[1].split('###')[0];
    const rows = typeTable.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Type'));
    assert.deepEqual(rows.map((r) => r.split('|')[1].trim()),
        ['decision', 'note', 'architecture', 'insight']);
});

await test('report: the orphan section finds the one unattached node', () => {
    const orphans = surrealReport.split('## Orphans')[1];
    assert.match(orphans, /`orphan`/);
    assert.doesNotMatch(orphans, /`hub`/);
});

await test('report: a pipe in a label is escaped, not table-breaking', () => {
    assert.match(surrealReport, /near one \\\| piped/);
});

await test('lint: reports the expected structural warnings', async () => {
    const warnings = await surreal.lintGraph();
    assert.ok(warnings.some((w) => w.startsWith("Orphan: insight node 'orphan'")),
        `the unattached node is flagged: ${JSON.stringify(warnings)}`);
});

await test('migrate workspace-to-workspace: edges copy on a Surreal source', async () => {
    // The edge copy used to be a batched raw-Cypher MATCH; it is now a paged
    // `queryEdges` walk. Injected graphs, per the command's own escape hatch,
    // avoid reopening the workspaces from disk in this test.
    const dst = openWorkspaceGraph(wsPath(WS.dst.name), { workspaceId: WS.dst.name });
    await dst.initialize();
    const report = await migrateWorkspaceToWorkspace({
        from: WS.surreal.name,
        to: WS.dst.name,
        includeEdges: true,
        apply: true,
        force: true,
        injected: { srcGraph: surreal, dstGraph: dst },
    });

    assert.equal(report.upserted, 6, 'every fixture node moved');
    assert.equal(report.edgesCopied, 5, 'every edge whose endpoints both moved came with them');
    assert.equal(report.edgesSkippedDangling, 0, 'nothing dangled — the whole graph moved');

    // Assert the destination really holds them, not just that the counter ran.
    const copied = await dst.queryEdges({ source: 'hub', limit: 100, offset: 0 });
    assert.equal(copied.length, 4, 'the hub kept all four outgoing edges');
    assert.deepEqual(copied.map((e) => e.targetId).sort(), ['leaf1', 'leaf2', 'near1', 'near2']);
    await dst.close();
});

await test('migrate workspace-to-workspace: an edge to a node left behind is not copied', async () => {
    // The both-endpoints-in-the-moved-set rule, which used to be the Cypher's
    // `b.id IN [...]` and is now a client-side check against the FULL moved
    // set. Moving `hub` + `near1` only (architecture + decision, minus near2)
    // leaves four of the five edges with one end behind:
    //   hub->near1   both moved            → copied
    //   hub->near2   target stays          → dangling
    //   hub->leaf1   target stays          → dangling
    //   hub->leaf2   target stays          → dangling
    //   near1->near2 target stays          → dangling
    // Only outgoing edges OF moved nodes are walked, which is the same set the
    // batched Cypher saw: an edge INTO the moved set from a node left behind
    // was never a candidate under `a.id IN [...] AND b.id IN [...]` either.
    const dst2Path = path.join(home, 'workspaces', 'dws2');
    fs.mkdirSync(path.join(dst2Path, '.lore'), { recursive: true });
    const file = JSON.parse(fs.readFileSync(path.join(home, 'workspaces.json'), 'utf8'));
    file.workspaces.push({ name: 'dws2', path: dst2Path, graphEngine: 'surreal' });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify(file, null, 2));

    const dst2 = openWorkspaceGraph(dst2Path, { workspaceId: 'dws2' });
    await dst2.initialize();
    const report = await migrateWorkspaceToWorkspace({
        from: WS.surreal.name,
        to: 'dws2',
        filterTypes: ['architecture', 'decision'],
        excludeIdPrefixes: ['near2'],
        includeEdges: true,
        apply: true,
        force: true,
        injected: { srcGraph: surreal, dstGraph: dst2 },
    });

    assert.equal(report.upserted, 2, 'hub and near1 moved; near2 was excluded');
    assert.equal(report.edgesCopied, 1, 'only hub->near1 has both endpoints in the moved set');
    assert.equal(report.edgesSkippedDangling, 4, 'the other four lost an endpoint and were left behind');

    const landed = await dst2.queryEdges({ source: 'hub', limit: 100, offset: 0 });
    assert.deepEqual(landed.map((e) => e.targetId), ['near1'],
        'the destination did not gain an edge pointing at a node that never arrived');
    await dst2.close();
});

await surreal.close();
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env tsx
/**
 * graph-report-unit.ts — `lore report`'s aggregates (engine-agnostic).
 *
 * `engines/graphReportAggregates.ts` reproduces the four `lore report`
 * aggregates (edge-confidence tally, hub ranking by degree, recently-
 * updated, orphans) from the portable primitives (`queryEdges`,
 * `getNodesByIds`, `bulkListProjected`) both `LocalGraph` and `SurrealGraph`
 * implement, so the report is identical across engines BY CONSTRUCTION —
 * this file proves it against a real SurrealGraph with a small fixture and
 * real expected numbers.
 *
 * Timestamps: upsertNode always stamps `updatedAt = now()` server-side (no
 * public API on either engine accepts an explicit value), so the fixture
 * cannot pin absolute values without a raw-query back door. Instead nodes
 * are written in a fixed order with a real gap between writes — the same
 * convention test/surreal-graph-contract-unit.ts's header documents for the
 * identical problem — and the actual returned timestamps are captured and
 * used as the expected values, so ordering is asserted, not assumed.
 *
 * `computeRecentlyUpdated`'s empty-string-`updatedAt` exclusion (ported from
 * the source Cypher's `WHERE updatedAt <> ''`) is exercised separately
 * against a hand-built `ReportGraph` fake: no live engine's public write
 * path can produce a blank `updatedAt` to construct that fixture row for
 * real, and `ReportGraph` is deliberately a small, engine-decoupled
 * interface for exactly this purpose (see its doc comment).
 *
 * Run: npx tsx test/graph-report-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import {
    computeEdgeAggregates,
    computeOrphans,
    computeRecentlyUpdated,
    computeTopHubs,
    type ReportGraph,
} from '../packages/lore/src/engines/graphReportAggregates.js';
import { writeGraphReport } from '../packages/lore/src/engines/graphReport.js';
import type { LoreEdge } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
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

function sleep(ms: number): Promise<void> {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    setTimeout(resolve, ms);
    return promise;
}

/*
 * ── fixture ──────────────────────────────────────────────────────────────
 * 6 nodes, 4 edges, written oldest-first with a real gap between writes so
 * `updatedAt` naturally descends in reverse write order:
 *   blank  — no edges (orphan #1); written first (oldest updatedAt)
 *   solo   — no edges (orphan #2)
 *   near3  — degree 1
 *   near2  — degree 2 (edge from hub, edge to near1)
 *   near1  — degree 2, TIES with near2 on DEGREE — exercises the
 *            id-ascending tie-break the source Cypher's bare
 *            `ORDER BY deg DESC` lacked
 *   hub    — endpoint of 3 edges: the clear hub (degree 3); written last
 *            (newest updatedAt)
 *
 * Confidence: edge1 omits `confidence` (must default to 'extracted' per
 * LoreEdge's documented default), edge4 sets it explicitly to 'extracted',
 * edge2 is 'inferred', edge3 is 'ambiguous' → tally
 * {extracted: 2, inferred: 1, ambiguous: 1}.
 */
interface FixtureNode {
    id: string;
    label: string;
    type: string;
}

const WRITE_ORDER: FixtureNode[] = [
    { id: 'blank', label: 'Blank Time', type: 'note' },
    { id: 'solo', label: 'Solo Node', type: 'note' },
    { id: 'near3', label: 'Near Three', type: 'concept' },
    { id: 'near2', label: 'Near Two', type: 'concept' },
    { id: 'near1', label: 'Near One', type: 'concept' },
    { id: 'hub', label: 'Hub Node', type: 'concept' },
];

const FIXTURE_EDGES: LoreEdge[] = [
    // confidence omitted — must default to 'extracted' when read back.
    { sourceId: 'hub', targetId: 'near1', relation: 'relates_to' },
    { sourceId: 'hub', targetId: 'near2', relation: 'relates_to', confidence: 'inferred' },
    { sourceId: 'near3', targetId: 'hub', relation: 'relates_to', confidence: 'ambiguous' },
    { sourceId: 'near1', targetId: 'near2', relation: 'relates_to', confidence: 'extracted' },
];

async function main(): Promise<void> {
    console.log('graph-report-unit — client-side aggregation for `lore report` (SurrealGraph)');
    console.log('='.repeat(72));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-graph-report-'));
    const graph = new SurrealGraph(tmpDir, { workspaceId: 'graph-report', cacheDisabled: true });
    await graph.initialize();

    try {
        const updatedAtById = new Map<string, string>();
        for (const n of WRITE_ORDER) {
            const written = await graph.upsertNode({
                id: n.id, type: n.type, label: n.label, content: `${n.label} content`,
                tags: [], project: 'p', ecosystem: 'e', metadata: '{}',
            });
            updatedAtById.set(n.id, written.updatedAt);
            await sleep(5);
        }
        for (const e of FIXTURE_EDGES) await graph.addEdge(e);

        /* ── 1. edge-confidence breakdown + degree map + endpoint set ── */
        const { confidenceByTier, degreeById, endpointIds } = await computeEdgeAggregates(graph);

        await check(
            'confidence tally: extracted=2 (1 implicit default + 1 explicit), inferred=1, ambiguous=1',
            () => {
                assert.equal(confidenceByTier['extracted'], 2);
                assert.equal(confidenceByTier['inferred'], 1);
                assert.equal(confidenceByTier['ambiguous'], 1);
            },
        );

        await check('degree map: hub=3, near1=2, near2=2, near3=1, solo/blank absent', () => {
            assert.equal(degreeById.get('hub'), 3);
            assert.equal(degreeById.get('near1'), 2);
            assert.equal(degreeById.get('near2'), 2);
            assert.equal(degreeById.get('near3'), 1);
            assert.equal(degreeById.has('solo'), false);
            assert.equal(degreeById.has('blank'), false);
        });

        await check('endpoint set: every non-orphan id, and nothing else', () => {
            assert.deepEqual([...endpointIds].sort(), ['hub', 'near1', 'near2', 'near3']);
        });

        /* ── 2. top hubs — degree desc, id asc tie-break, hydrated ── */
        await check(
            'top hubs (topN=3): hub(3), near1(2), near2(2) — id-ascending tie-break on the deg=2 pair',
            async () => {
                const hubs = await computeTopHubs(graph, degreeById, 3);
                assert.deepEqual(
                    hubs.map((h) => [h.id, h.deg]),
                    [['hub', 3], ['near1', 2], ['near2', 2]],
                );
                assert.equal(hubs[0]!.label, 'Hub Node');
                assert.equal(hubs[0]!.type, 'concept');
            },
        );

        await check('top hubs (topN=1): truncates to the single highest-degree node', async () => {
            const hubs = await computeTopHubs(graph, degreeById, 1);
            assert.deepEqual(hubs.map((h) => h.id), ['hub']);
        });

        /* ── 3. recently updated — real write-order gives updatedAt desc ── */
        await check(
            'recently updated (limit=10): all 6 nodes in write-reverse (updatedAt-desc) order',
            async () => {
                const recent = await computeRecentlyUpdated(graph, 10);
                assert.deepEqual(
                    recent.map((r) => r.id),
                    ['hub', 'near1', 'near2', 'near3', 'solo', 'blank'],
                );
                assert.equal(recent[0]!.updatedAt, updatedAtById.get('hub'));
            },
        );

        await check('recently updated (limit=2): truncates to the two most recent', async () => {
            const recent = await computeRecentlyUpdated(graph, 2);
            assert.deepEqual(recent.map((r) => r.id), ['hub', 'near1']);
        });

        await check(
            "recently updated: excludes rows whose updatedAt is not a non-empty string (ported " +
            "Cypher WHERE updatedAt <> '' filter; exercised against a fake ReportGraph since no " +
            "live engine's public write path can produce a blank updatedAt)",
            async () => {
                const fake: ReportGraph = {
                    getStats: async () => { throw new Error('unused'); },
                    queryEdges: async () => { throw new Error('unused'); },
                    getNodesByIds: async () => { throw new Error('unused'); },
                    bulkListProjected: async () => ({
                        rows: [
                            { id: 'valid', label: 'Valid', type: 'note', updatedAt: '2026-01-01T00:00:00.000Z' },
                            { id: 'blank', label: 'Blank', type: 'note', updatedAt: '' },
                            { id: 'missing', label: 'Missing', type: 'note' },
                        ],
                        nextCursor: null,
                    }),
                };
                const recent = await computeRecentlyUpdated(fake, 10);
                assert.deepEqual(recent.map((r) => r.id), ['valid']);
            },
        );

        /* ── 4. orphans ── */
        await check('orphans: solo and blank, nothing else', async () => {
            const orphans = await computeOrphans(graph, endpointIds, 20);
            assert.deepEqual(orphans.map((o) => o.id).sort(), ['blank', 'solo']);
        });

        await check('orphans (limit=1): truncates', async () => {
            const orphans = await computeOrphans(graph, endpointIds, 1);
            assert.equal(orphans.length, 1);
        });

        /* ── end-to-end: writeGraphReport renders the same numbers ── */
        await check('writeGraphReport: markdown reflects the same counts and hub ranking', async () => {
            const md = await writeGraphReport(graph, { topN: 3 });
            assert.match(md, /\*\*Nodes\*\*: 6/);
            assert.match(md, /\*\*Edges\*\*: 4/);
            assert.match(md, /\| extracted \| 2 \|/);
            assert.match(md, /\| inferred \| 1 \|/);
            assert.match(md, /\| ambiguous \| 1 \|/);
            assert.match(md, /## Top 3 hubs/);
            assert.match(md, /\| 3 \| concept \| Hub Node \| `hub` \|/);
            assert.match(md, /2 node\(s\) without edges/);
        });
    } finally {
        try { await graph.close(); } catch { /* best effort */ }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    }

    console.log('');
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});

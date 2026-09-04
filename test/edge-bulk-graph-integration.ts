#!/usr/bin/env tsx
/**
 * edge-bulk-graph-integration.ts — real-SurrealDB integration for the
 * cloud-parity graph-adapter methods SurrealGraph.queryEdges + SurrealGraph.bulkList.
 *
 * Why this exists (integration-verification convention):
 *   The route tests use method-shaped fakes; the helper tests assert the
 *   query STRING against a recording queryRows fake. NEITHER actually runs
 *   the query against SurrealDB. A query that string-matches but is invalid
 *   on embedded SurrealDB (e.g. a bound-param LIMIT/START clause, or a
 *   RETURN column that doesn't exist) would pass every unit test and only
 *   blow up in production. This test seeds a real SurrealGraph (real
 *   embedded SurrealDB), then exercises both methods end-to-end so the
 *   query is proven to EXECUTE, not just to read correctly.
 *
 * Pins:
 *   Q1. queryEdges(source) returns exactly the edges out of that node.
 *   Q2. queryEdges(source, relation) AND-filters correctly.
 *   Q3. queryEdges respects limit (bound params execute on real SurrealDB).
 *   B1. bulkList paginates with the (updatedAt DESC, id ASC) cursor across
 *       real rows: page1 + page2 cover every seeded node with no dup / loss,
 *       hasMore flips false on the last page, nextCursor goes null.
 *   B2. bulkList type filter narrows to the matching node.
 *
 * NOTE: opens a real embedded SurrealDB instance → ends with process.exit(0)
 * for symmetry with the rest of the integration suite (see
 * maintain-access-integration.ts).
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-edge-bulk-int-'));
const WS = 'intws';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

async function seedNode(graph: SurrealGraph, id: string, type = 'decision'): Promise<void> {
    await graph.upsertNode({
        id, type, label: `label-${id}`, content: `content-${id}`,
        tags: '', project: WS, ecosystem: '*', metadata: '{}',
    });
}

async function main(): Promise<void> {
    console.log('edge + bulk-list real-SurrealDB integration');
    const graph = new SurrealGraph(TMP, { workspaceId: 'default' });
    await graph.initialize();

    // Seed 4 nodes + 3 edges out of "a".
    for (const id of ['a', 'b', 'c', 'd']) await seedNode(graph, id);
    await seedNode(graph, 'note1', 'note');
    await graph.addEdge({ sourceId: 'a', targetId: 'b', relation: 'depends_on' });
    await graph.addEdge({ sourceId: 'a', targetId: 'c', relation: 'related_to' });
    await graph.addEdge({ sourceId: 'd', targetId: 'b', relation: 'depends_on' });

    /* ---- queryEdges ---- */
    const outOfA = await graph.queryEdges({ source: 'a', limit: 50, offset: 0 });
    check('Q1 queryEdges(source=a) returns both edges out of a', () => {
        const pairs = outOfA.map((e) => `${e.sourceId}-${e.relation}->${e.targetId}`).sort();
        assert.deepEqual(pairs, ['a-depends_on->b', 'a-related_to->c']);
        // confidence/score default applied by the helper mapping.
        assert.equal(outOfA[0]!.confidence, 'extracted');
        assert.equal(outOfA[0]!.confidenceScore, 1.0);
    });

    const aDepends = await graph.queryEdges({ source: 'a', relation: 'depends_on', limit: 50, offset: 0 });
    check('Q2 queryEdges(source=a, relation=depends_on) AND-filters to one edge', () => {
        assert.equal(aDepends.length, 1);
        assert.equal(aDepends[0]!.targetId, 'b');
    });

    const allDepends = await graph.queryEdges({ relation: 'depends_on', limit: 50, offset: 0 });
    check('Q2b queryEdges(relation only) returns both depends_on edges', () => {
        assert.equal(allDepends.length, 2);
    });

    const limited = await graph.queryEdges({ source: 'a', limit: 1, offset: 0 });
    check('Q3 queryEdges limit=1 executes bound LIMIT param on real SurrealDB', () => {
        // The whole point: this proves the bound LIMIT param is VALID on
        // embedded SurrealDB — a unit test against a fake would not.
        assert.equal(limited.length, 1);
    });

    /* ---- bulkList pagination ---- */
    const seen = new Set<string>();
    const page1 = await graph.bulkList({ project: WS, limit: 2 });
    check('B1a bulkList page1 returns a full page + hasMore + nextCursor', () => {
        assert.equal(page1.nodes.length, 2, 'page1 must be exactly limit');
        assert.equal(page1.hasMore, true, '4 ws nodes > limit 2 → hasMore');
        assert.ok(page1.nextCursor, 'nextCursor present when hasMore');
    });
    for (const n of page1.nodes) seen.add(n['id'] as string);

    const page2 = await graph.bulkList({ project: WS, limit: 2, cursor: page1.nextCursor });
    check('B1b bulkList page2 continues strictly after the cursor', () => {
        assert.equal(page2.nodes.length, 2);
        // No row from page1 reappears (cursor strict-after works on real SurrealDB).
        for (const n of page2.nodes) {
            assert.ok(!seen.has(n['id'] as string), `page2 row ${n['id']} must not repeat page1`);
        }
    });
    for (const n of page2.nodes) seen.add(n['id'] as string);

    const page3 = await graph.bulkList({ project: WS, limit: 2, cursor: page2.nextCursor });
    check('B1c last page → hasMore=false, nextCursor=null, every ws node seen exactly once', () => {
        // 4 decision nodes (a,b,c,d) under WS — note1 is also WS but counted too (5 total).
        // page1(2) + page2(2) = 4 seen; page3 carries the 5th (note1) then stops.
        for (const n of page3.nodes) seen.add(n['id'] as string);
        assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd', 'note1']);
        assert.equal(page3.hasMore, false);
        assert.equal(page3.nextCursor, null);
    });

    const onlyNotes = await graph.bulkList({ project: WS, types: ['note'], limit: 50 });
    check('B2 bulkList type filter narrows to the matching node', () => {
        assert.equal(onlyNotes.nodes.length, 1);
        assert.equal(onlyNotes.nodes[0]!['id'], 'note1');
    });

    /* ---- adversarial: query-injection payloads must be inert ---- */
    // Bound params mean these strings are VALUES, never query syntax. On
    // real SurrealDB this proves the injection can't run: it matches nothing
    // and leaves the graph intact (the unit-level "no interpolation"
    // assertion can't prove the engine actually treats it as a literal).
    const INJECT_SRC = "a' OR '1'='1";
    const INJECT_REL = "depends_on'}) DELETE a,b //";

    const injEdges = await graph.queryEdges({ source: INJECT_SRC, limit: 50, offset: 0 });
    check('A1 queryEdges: injection payload in source is a literal → matches nothing', () => {
        assert.equal(injEdges.length, 0, 'injection string must not match real ids nor execute');
    });

    const injDeleted = await graph.deleteEdge('a', 'b', INJECT_REL);
    const edgesAfterInjectDelete = await graph.queryEdges({ source: 'a', limit: 50, offset: 0 });
    check('A2 deleteEdge: injection payload in relation deletes nothing + leaves real edges intact', () => {
        assert.equal(injDeleted, 0, 'injected relation matches no edge → 0 deleted');
        // The real a→b depends_on + a→c related_to edges still exist —
        // injection did NOT run a DELETE.
        assert.equal(edgesAfterInjectDelete.length, 2, 'real edges out of a survive the injection attempt');
    });

    const injBulk = await graph.bulkList({ project: "wsX' OR '1'='1", limit: 50 });
    check('A3 bulkList: injection payload in project filter is a literal → matches nothing', () => {
        assert.equal(injBulk.nodes.length, 0, 'no node has that literal project; injection did not widen the scan');
    });

    /* ---- extracted graphStats + nodeLifecycle on real SurrealDB (god-class split) ----
       These methods moved out of LocalGraph into graphStats.ts / nodeLifecycle.ts;
       the class keeps thin delegators. Exercise them here so the move is verified
       against real SurrealDB, not just type-checked. */
    const stats = await graph.getStats();
    check('S1 getStats: counts + type breakdown over real SurrealDB', () => {
        assert.equal(stats.nodeCount, 5, '5 seeded nodes (a,b,c,d,note1)');
        assert.equal(stats.edgeCount, 3, '3 seeded edges (a->b, a->c, d->b)');
        assert.equal(stats.typeBreakdown['decision'], 4);
        assert.equal(stats.typeBreakdown['note'], 1);
    });

    const sup = await graph.supersedeNode('a', 'b');
    const predOf = await graph.findSupersededByPredecessors('b');
    check('S2a supersedeNode + findSupersededByPredecessors round-trip (write-epoch + read path)', () => {
        assert.deepEqual(sup, { ok: true });
        assert.deepEqual(predOf, ['a'], 'a is now superseded-by b');
    });
    const uns = await graph.unsupersedeNode('a');
    const predAfter = await graph.findSupersededByPredecessors('b');
    check('S2b unsupersedeNode clears the supersession', () => {
        assert.equal(uns, true);
        assert.deepEqual(predAfter, []);
    });
    const selfSup = await graph.supersedeNode('a', 'a');
    const ghostOld = await graph.supersedeNode('ghost', 'b');
    const ghostNew = await graph.supersedeNode('a', 'ghost');
    check('S2c supersedeNode guard branches: self / old-not-found / new-not-found', () => {
        assert.deepEqual(selfSup, { ok: false, reason: 'self' });
        assert.deepEqual(ghostOld, { ok: false, reason: 'old-not-found' });
        assert.deepEqual(ghostNew, { ok: false, reason: 'new-not-found' });
    });

    await seedNode(graph, 'orphan1'); // a decision node with no edges
    const warnings = await graph.lintGraph();
    check('S3 lintGraph flags the orphaned non-note node', () => {
        assert.ok(warnings.some((w) => w.includes('orphan1')), `expected an orphan warning for orphan1; got ${JSON.stringify(warnings)}`);
    });

    const langs = await graph.getLanguageBreakdown();
    check('S4 getLanguageBreakdown returns a map (unknown collapses to null key)', () => {
        // Seeded nodes have no language → all collapse under the 'null' key.
        assert.ok(typeof langs === 'object' && langs !== null);
        assert.ok((langs['null'] ?? 0) >= 5, `expected >=5 unknown-language nodes; got ${JSON.stringify(langs)}`);
    });

    /* ---- L-014: addEdge is idempotent (read-decide-write) ----
       The hot-write path applies the direct write AND records an outbox row the
       replicator later replays through the SAME addEdge. A blind CREATE
       produced two relation rows; the idempotency guard converges both to
       one. Simulate the route-write + replay by calling addEdge twice with the
       identical directed (source,target,relation) triple. */
    await seedNode(graph, 'idem-src');
    await seedNode(graph, 'idem-tgt');
    await graph.addEdge({ sourceId: 'idem-src', targetId: 'idem-tgt', relation: 'related_to' });
    await graph.addEdge({ sourceId: 'idem-src', targetId: 'idem-tgt', relation: 'related_to' });
    const idemEdges = await graph.queryEdges({ source: 'idem-src', relation: 'related_to', limit: 50, offset: 0 });
    check('L-014 addEdge replay converges to exactly ONE relation row', () => {
        assert.equal(idemEdges.length, 1, `expected 1 edge after duplicate addEdge, got ${idemEdges.length}`);
        assert.equal(idemEdges[0]!.targetId, 'idem-tgt');
    });

    // A DIFFERENT relation between the same endpoints is a distinct edge — the
    // guard keys on (source,target,relation), so this must still create.
    await graph.addEdge({ sourceId: 'idem-src', targetId: 'idem-tgt', relation: 'depends_on' });
    const idemTwoRels = await graph.queryEdges({ source: 'idem-src', limit: 50, offset: 0 });
    check('L-014 idempotency keys on relation: a distinct relation is a new edge', () => {
        assert.equal(idemTwoRels.length, 2, `expected 2 edges (related_to + depends_on), got ${idemTwoRels.length}`);
    });

    // addBidirectionalEdge: the two directions are DISTINCT (source,target)
    // pairs, so both must create (the guard keys on direction).
    await seedNode(graph, 'bi-x');
    await seedNode(graph, 'bi-y');
    await graph.addBidirectionalEdge({ sourceId: 'bi-x', targetId: 'bi-y', relation: 'links_to' });
    const biForward = await graph.queryEdges({ source: 'bi-x', relation: 'links_to', limit: 50, offset: 0 });
    const biBack = await graph.queryEdges({ source: 'bi-y', relation: 'links_to', limit: 50, offset: 0 });
    check('L-014 addBidirectionalEdge still creates BOTH directions (distinct pairs)', () => {
        assert.equal(biForward.length, 1, 'x→y direction present');
        assert.equal(biBack.length, 1, 'y→x direction present');
    });
    // …and replaying the bidirectional add stays idempotent per direction.
    await graph.addBidirectionalEdge({ sourceId: 'bi-x', targetId: 'bi-y', relation: 'links_to' });
    const biForward2 = await graph.queryEdges({ source: 'bi-x', relation: 'links_to', limit: 50, offset: 0 });
    const biBack2 = await graph.queryEdges({ source: 'bi-y', relation: 'links_to', limit: 50, offset: 0 });
    check('L-014 replaying addBidirectionalEdge converges to one row per direction', () => {
        assert.equal(biForward2.length, 1, 'x→y still exactly 1 after replay');
        assert.equal(biBack2.length, 1, 'y→x still exactly 1 after replay');
    });

    /* ---- L-014: addEdge is concurrency-safe (KeyedMutex per triple) ----
       The count-guard alone is read-decide-write; without per-key serialization
       two genuinely-concurrent same-triple writers can BOTH observe count 0 and
       BOTH CREATE → duplicate rows. Both engines key edgeWriteChain on
       `${source}|${target}|${relation}` exactly as upsertNode serializes on node
       id. Fire many concurrent addEdge calls for the SAME triple via Promise.all
       and assert exactly ONE row survives. */
    await seedNode(graph, 'conc-src');
    await seedNode(graph, 'conc-tgt');
    await Promise.all(
        Array.from({ length: 12 }, () =>
            graph.addEdge({ sourceId: 'conc-src', targetId: 'conc-tgt', relation: 'related_to' })),
    );
    const concEdges = await graph.queryEdges({ source: 'conc-src', relation: 'related_to', limit: 50, offset: 0 });
    check('L-014 concurrent same-triple addEdge calls converge to exactly ONE row', () => {
        assert.equal(concEdges.length, 1, `expected 1 edge after 12 concurrent addEdge, got ${concEdges.length}`);
    });
    // NOTE: a distinct-triple "must run in parallel" assertion is intentionally
    // NOT added — the per-key mutex's role is strictly to make the SAME-key
    // read-decide-write atomic, not to widen cross-key parallelism (SurrealDB
    // is multi-writer, unlike the legacy graph engine, but the atomicity requirement is identical).
    // The same-triple convergence above is the fix's pin.

    console.log(`\n${passed} passed, ${failed} failed`);
}

function cleanup() {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

main()
    .then(() => { cleanup(); process.exit(failed === 0 ? 0 : 1); })
    .catch((err) => { cleanup(); console.error('✗ edge-bulk-graph-integration:', err); process.exit(1); });

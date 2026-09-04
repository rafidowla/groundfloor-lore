/**
 * surreal-schema-graph-ops-unit.ts — SurrealSchemaGraphOps against a REAL
 * embedded SurrealDB workspace.
 *
 * Why this test is written the way it is
 * --------------------------------------
 * This class is the SurrealDB half of the schema-safety subsystem: blast
 * radius, the pre-destructive-change snapshot, and the migration runner all
 * read and write the graph through it. The failure mode it has to rule out is
 * NOT "throws an error" — it is "returns a confident wrong number". A count
 * that under-reports, or a snapshot that comes back empty, lets a destructive
 * change proceed with nothing to restore from. That is precisely what the
 * legacy engine's graph-substrate assertion guard existed to prevent by
 * refusing the whole subsystem on this engine.
 *
 * So: every assertion is an exact value, never a truthiness check, and the
 * mutation cases assert the state of the graph AFTER the call, not the return
 * value of the call.
 *
 * Seeding uses `bulkIngest(..., { autolink: false })` deliberately. The
 * trickle write path fires a background similarity autolink that keeps adding
 * edges after the call returns; seeding through it made every edge assertion
 * here race, and an intermittently-green test on a safety subsystem is worse
 * than no test.
 *
 * Run: npm run test:unit:surreal-schema-ops
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

process.env['LORE_LOG_LEVEL'] ??= 'error';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-schema-ops-test-'));
process.env['LORE_HOME'] = dataDir;

const { createLore } = await import('../packages/lore/src/index.js');

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const graph = (lore as any)._daemon.getGraph();

try {
    if (typeof graph.getSchemaGraphOps !== 'function') {
        throw new Error(
            `expected a SurrealGraph-backed default workspace, got ${graph.constructor.name}. `
            + 'If the default engine changed, this test needs to pin graphEngine explicitly.',
        );
    }
    const ops = graph.getSchemaGraphOps();
    check('ops report their engine', ops.engine, 'surreal');

    /* ── seed ──────────────────────────────────────────────────────── */

    const seed = [];
    for (let i = 1; i <= 5; i++) {
        seed.push({
            id: `widget-${i}`, workspace: 'default', ecosystem: 'ops-test',
            nodeData: {
                id: `widget-${i}`, ecosystem: 'ops-test', type: 'widget',
                label: `Widget ${i}`, content: `body ${i}`, tags: ['t'],
                metadata: JSON.stringify(i <= 2 ? { doomed: `v${i}`, keep: 1 } : { keep: 1 }),
                // widget-1 carries real ephemeral/ttl_ms values so the
                // rollback-fidelity block below can assert restoreNode
                // actually restores them, not just leaves them at whatever
                // default a fresh upsert would produce.
                ...(i === 1 ? { ephemeral: true, ttl_ms: 99999 } : {}),
            },
        });
    }
    for (let i = 1; i <= 3; i++) {
        seed.push({
            id: `gadget-${i}`, workspace: 'default', ecosystem: 'ops-test',
            nodeData: {
                id: `gadget-${i}`, ecosystem: 'ops-test', type: 'gadget',
                label: `Gadget ${i}`, content: 'g', tags: [],
            },
        });
    }
    await lore.bulkIngest(seed, { autolink: false, embed: 'sync' });
    await graph.addEdge({ sourceId: 'gadget-1', targetId: 'widget-1', relation: 'uses' });
    await graph.addEdge({ sourceId: 'gadget-2', targetId: 'widget-2', relation: 'uses' });
    await graph.addEdge({ sourceId: 'gadget-3', targetId: 'widget-3', relation: 'related_to' });

    /* ── counts: blast radius ──────────────────────────────────────── */

    check('countNodesByType', await ops.countNodesByType('widget'), 5);
    check('countNodesByType, other type', await ops.countNodesByType('gadget'), 3);
    check('countNodesByType, absent type is 0 not null', await ops.countNodesByType('nope'), 0);
    check('countEdgesByRelation', await ops.countEdgesByRelation('uses'), 2);
    check('countInboundEdgesToType', await ops.countInboundEdgesToType('widget'), 3);

    /* ── dumps: the snapshot. An empty answer here is the catastrophe. */

    const dump = await ops.listNodesByType('widget');
    check('listNodesByType returns every row', dump.length, 5);
    check(
        'listNodesByType unwraps record ids to raw Lore ids',
        dump.map((r: Record<string, unknown>) => r['id']).sort(),
        ['widget-1', 'widget-2', 'widget-3', 'widget-4', 'widget-5'],
    );
    check(
        'snapshot rows survive the JSONL round-trip',
        typeof JSON.parse(JSON.stringify(dump[0]))['id'],
        'string',
    );

    const edgeDump = await ops.listEdgesByRelation('uses');
    check('listEdgesByRelation returns every edge', edgeDump.length, 2);
    check(
        'listEdgesByRelation resolves both endpoints',
        edgeDump.map((r: Record<string, unknown>) => `${r['sourceId']}->${r['targetId']}`).sort(),
        ['gadget-1->widget-1', 'gadget-2->widget-2'],
    );

    /* ── paging: the migration cursor ──────────────────────────────── */

    const p1 = await ops.pageNodesByType('widget', '', 2);
    const p2 = await ops.pageNodesByType('widget', p1[p1.length - 1].id, 2);
    const p3 = await ops.pageNodesByType('widget', p2[p2.length - 1].id, 2);
    const p4 = await ops.pageNodesByType('widget', p3[p3.length - 1].id, 2);
    check('page 1', p1.map((r: { id: string }) => r.id), ['widget-1', 'widget-2']);
    check('page 2 resumes strictly after the cursor', p2.map((r: { id: string }) => r.id), ['widget-3', 'widget-4']);
    check('page 3', p3.map((r: { id: string }) => r.id), ['widget-5']);
    check('page 4 is empty, not a repeat', p4.length, 0);
    check('pages carry metadata for the field walk', typeof p1[0].metadata, 'string');

    check('sampleNodesByType honours its cap', (await ops.sampleNodesByType('widget', 3)).length, 3);
    check('sampleEdgesByRelation', (await ops.sampleEdgesByRelation('uses', 5)).length, 2);

    /* ── field-level mutation: the field.removed path ──────────────── */

    const meta = await ops.getNodeMetadata('widget-1');
    check('getNodeMetadata parses the JSON column', meta, { doomed: 'v1', keep: 1 });
    delete meta.doomed;
    await ops.setNodeMetadata('widget-1', meta);
    check('setNodeMetadata persists', await ops.getNodeMetadata('widget-1'), { keep: 1 });

    /* ── type mutation: the node_type.renamed path ─────────────────── */

    await ops.setNodeType('widget-5', 'widget_renamed');
    check('setNodeType leaves the old type', await ops.countNodesByType('widget'), 4);
    check('setNodeType lands the new type', await ops.countNodesByType('widget_renamed'), 1);

    await ops.createEdge('gadget-1', 'widget-4', 'uses');
    check('createEdge', await ops.countEdgesByRelation('uses'), 3);

    /* ── detach delete: node_type.removed ──────────────────────────── */

    check('deleteNodesByType reports what it removed', await ops.deleteNodesByType('widget', 2), 2);
    check('deleteNodesByType removed exactly the batch', await ops.countNodesByType('widget'), 2);
    const usesLeft = await graph.queryEdges({ relation: 'uses', limit: 500, offset: 0 });
    check('count agrees with the graph after detach', await ops.countEdgesByRelation('uses'), usesLeft.length);
    check(
        'no edge survives pointing at a deleted node',
        usesLeft.some((e: { targetId: string }) => e.targetId === 'widget-1' || e.targetId === 'widget-2'),
        false,
    );

    const relBefore = await ops.countEdgesByRelation('related_to');
    check('deleteEdgesByRelation', await ops.deleteEdgesByRelation('related_to', 500), relBefore);
    check('relation drained', await ops.countEdgesByRelation('related_to'), 0);

    /* ── rollback fidelity ─────────────────────────────────────────── */

    const snapshotRow = dump.find((r: Record<string, unknown>) => r['id'] === 'widget-1');
    await ops.restoreNode(snapshotRow);
    check('restoreNode re-creates the row', await ops.countNodesByType('widget'), 3);
    const restored = await graph.getNode('widget-1');
    check('restored label', restored?.label, 'Widget 1');
    check('restored ecosystem', restored?.ecosystem, 'ops-test');
    check(
        'restored metadata is the SNAPSHOT value, not the later edit',
        JSON.parse(restored?.metadata ?? '{}'),
        { doomed: 'v1', keep: 1 },
    );
    check('restored createdAt is preserved, not re-stamped', restored?.createdAt, snapshotRow['createdAt']);
    check('restored ephemeral is preserved (previously silently dropped)', restored?.ephemeral, true);
    check('restored ttl_ms is preserved (previously silently dropped)', restored?.ttl_ms, 99999);
    // syncedAt cannot be given a real non-null fixture value here: every
    // public write path (upsertNode, bulkIngest) always stamps it null on a
    // fresh row — it only ever becomes non-null via the outbox/sync
    // subsystem, which this offline-embedded test doesn't exercise. Still
    // asserted explicitly (not skipped) so a future regression that makes
    // restoreNode carry a REAL syncedAt value through as '' or otherwise
    // wrong has to change this line, not silently pass. Compared against
    // `null`, not `snapshotRow['syncedAt']` (which is the raw unmapped ''
    // — SurrealGraph writes '' for "absent", `graph.getNode()`'s
    // rowToLoreNode maps '' -> null on read, per surrealGraphWrites.ts's
    // own documented convention; `restored` came through that mapping).
    check('restored syncedAt is absent, matching the mapped "no syncedAt" value', restored?.syncedAt, null);
} finally {
    await lore.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nsurreal-schema-graph-ops: all assertions passed');

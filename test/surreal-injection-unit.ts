#!/usr/bin/env tsx
/**
 * surreal-injection-unit.ts — query-injection regressions for the SurrealDB
 * engine (Phase 1 hard constraint: "parameterized queries only").
 *
 * This repo has a lineage of substrate-injection fixes — SP-05 (filter keys
 * interpolated into Cypher/SQL), SW-01 (shared guarded whereClause), NW-7e
 * (LanceDB predicate escaping), and the 2026-08-04 id-alphabet interpolation
 * fix. Every one of them existed because a value reached a query as TEXT. A
 * new engine is a fresh chance to reintroduce the whole class, so it is fenced
 * here on the way in rather than audited later.
 *
 * The control in SurrealGraph is structural, not lexical: values are bound
 * (`$q`) and record ids are bound as `RecordId` OBJECTS serialized over CBOR,
 * so hostile text is never parsed as syntax. There is deliberately no escape
 * helper to test — the tests instead prove the property that matters, the same
 * way nw7e-verbatimBatch-injection-unit.ts does after its own design change:
 *
 *   1. A hostile value is STORED verbatim and reads back byte-identical.
 *   2. It resolves to EXACTLY its own row — no cross-row leakage, no
 *      always-true breakout, no wildcard expansion.
 *   3. It DESTROYS NOTHING — the classic `; DELETE …` / `; REMOVE TABLE`
 *      payloads leave every other row intact.
 *
 * (3) is the case that actually matters. A payload that merely fails to match
 * is indistinguishable from a payload that ran and deleted the table.
 *
 * Run: npx tsx test/surreal-injection-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { RecordId, Surreal } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';

import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

async function withGraph(fn: (g: SurrealGraph) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-inject-'));
    const graph = new SurrealGraph(dir, { workspaceId: 'inject-ws' });
    try {
        await graph.initialize();
        await fn(graph);
    } finally {
        await graph.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function node(id: string, over: Partial<LoreNode> = {}): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'decision',
        label: `Label ${id}`,
        content: `Content ${id}`,
        tags: ['safe'],
        project: 'proj',
        ecosystem: '*',
        metadata: '{}',
        ...over,
    };
}

/**
 * Payloads that would break out of a naive string-interpolated query. Each is
 * used as an id, as a search term, as a tag, and as a relation name.
 */
const PAYLOADS: ReadonlyArray<readonly [name: string, value: string]> = [
    ['single-quote breakout', "o'brien"],
    ['always-true tail', "x' OR '1'='1"],
    ['double-quote breakout', 'say "hello"'],
    ['statement terminator + delete', "x'; DELETE node; --"],
    ['statement terminator + remove table', 'x; REMOVE TABLE node;'],
    ['surreal record-id syntax', 'node:otherRow'],
    ['angle-bracket record quoting', 'node:⟨escaped⟩'],
    ['backtick record quoting', '`backticked`'],
    ['backslash escape', 'back\\slash'],
    ['sql comment', 'value -- trailing'],
    ['block comment', 'value /* inner */ tail'],
    ['surrealql param reference', '$secretParam'],
    ['surrealql expression', '${1+1}'],
    ['newline injection', 'first\nDELETE node;'],
    ['like wildcards', '%_%'],
    ['unicode + emoji', 'ünïcødé 🔥'],
];

console.log('SurrealGraph — injection / parameterized-query battery');

/* ─── ids ────────────────────────────────────────────────────────── */

for (const [name, payload] of PAYLOADS) {
    await test(`id payload round-trips and resolves to exactly one row: ${name}`, async () => {
        await withGraph(async (g) => {
            // Two decoys either side, so a breakout that widened the match set
            // has something to wrongly return.
            await g.upsertNode(node('decoy-before'));
            await g.upsertNode(node(payload, { label: 'HOSTILE' }));
            await g.upsertNode(node('decoy-after'));

            const read = await g.getNode(payload);
            assert.ok(read, 'hostile id must be storable');
            assert.equal(read.id, payload, 'id reads back byte-identical');
            assert.equal(read.label, 'HOSTILE');

            // Exactly its own row — not zero (escaping bug), not several
            // (breakout), not a decoy (id confusion).
            const batch = await g.getNodesByIds([payload]);
            assert.equal(batch.size, 1);
            assert.equal(batch.get(payload)?.label, 'HOSTILE');

            // Nothing was destroyed.
            const stats = await g.getStats();
            assert.equal(stats.nodeCount, 3, 'all three rows still present');
        });
    });
}

await test('a destructive id payload deletes only its OWN row', async () => {
    await withGraph(async (g) => {
        const payload = "victim'; DELETE node; --";
        await g.upsertNode(node('keep-1'));
        await g.upsertNode(node(payload));
        await g.upsertNode(node('keep-2'));

        assert.equal(await g.deleteNode(payload), true);
        const stats = await g.getStats();
        assert.equal(stats.nodeCount, 2, 'the DELETE payload did not run as a statement');
        assert.ok(await g.getNode('keep-1'));
        assert.ok(await g.getNode('keep-2'));
    });
});

await test('an id that LOOKS like another row\'s record id does not address that row', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('target', { label: 'REAL' }));
        // Stored as node:⟨node:target⟩ — a DIFFERENT record from node:target.
        await g.upsertNode(node('node:target', { label: 'IMPOSTER' }));

        assert.equal((await g.getNode('target'))?.label, 'REAL');
        assert.equal((await g.getNode('node:target'))?.label, 'IMPOSTER');
        assert.equal((await g.getStats()).nodeCount, 2, 'two distinct rows, no collision');
    });
});

/* ─── search terms ───────────────────────────────────────────────── */

for (const [name, payload] of PAYLOADS) {
    await test(`search term is data, not syntax: ${name}`, async () => {
        await withGraph(async (g) => {
            await g.upsertNode(node('has-payload', { content: `prefix ${payload} suffix` }));
            await g.upsertNode(node('clean-1', { label: 'unrelated', content: 'nothing', tags: [] }));
            await g.upsertNode(node('clean-2', { label: 'unrelated', content: 'nothing', tags: [] }));

            const hits = await g.search(payload, 100);
            // Either it matches its own row, or it matches nothing — never the
            // clean rows, which is what an always-true breakout would produce.
            assert.ok(hits.length <= 1, `expected ≤1 hit, got ${hits.length}`);
            if (hits.length === 1) assert.equal(hits[0]?.id, 'has-payload');

            assert.equal((await g.getStats()).nodeCount, 3, 'search did not destroy rows');
        });
    });
}

await test('an always-true search payload cannot widen the result set', async () => {
    await withGraph(async (g) => {
        for (let i = 0; i < 5; i++) {
            await g.upsertNode(node(`n${i}`, { label: `row ${i}`, content: 'body', tags: [] }));
        }
        for (const payload of ["' OR '1'='1", "') OR (1=1", '" OR "1"="1', 'true']) {
            const hits = await g.search(payload, 100);
            assert.equal(hits.length, 0, `payload "${payload}" must match nothing, got ${hits.length}`);
        }
    });
});

/* ─── scope filters, tags, relations ─────────────────────────────── */

await test('project/ecosystem scope filters cannot be escaped', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('alpha-row', { project: 'alpha', label: 'target' }));
        await g.upsertNode(node('secret-row', { project: 'secret', label: 'target' }));

        for (const payload of ["alpha' OR project != '", "alpha') OR (true", 'alpha OR true']) {
            const hits = await g.search('target', 100, payload);
            assert.equal(hits.length, 0, `scope payload "${payload}" leaked ${hits.length} row(s)`);
        }
        // The honest value still works — the filter is functional, not broken.
        assert.equal((await g.search('target', 100, 'alpha')).length, 1);
    });
});

await test('listNodes type/tag filters cannot be escaped', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a', { type: 'decision', tags: ['keep'] }));
        await g.upsertNode(node('b', { type: 'secret', tags: ['hidden'] }));

        for (const payload of ["decision' OR type != '", "decision') OR (true"]) {
            assert.equal((await g.listNodes(payload)).length, 0, 'type filter held');
            assert.equal((await g.listNodes(undefined, payload)).length, 0, 'tag filter held');
        }
        assert.equal((await g.listNodes('decision')).length, 1, 'honest type filter still works');
    });
});

await test('hostile tag values store, match exactly, and survive markStaleByTags', async () => {
    await withGraph(async (g) => {
        // tagsToArray splits on commas and lowercases, so the stored tag is the
        // normalized form — that IS the contract, and it must still be exact.
        await g.upsertNode(node('tagged', { tags: ["x' or '1'='1"] }));
        await g.upsertNode(node('untagged', { tags: ['ordinary'] }));

        assert.equal(await g.markStaleByTags(["x' or '1'='1"]), 1, 'matches exactly one node');
        assert.equal((await g.getNode('tagged'))?.stale, true);
        assert.equal((await g.getNode('untagged'))?.stale, undefined, 'no always-true breakout');
    });
});

await test('hostile relation names are stored, queried, and pruned as data', async () => {
    await withGraph(async (g) => {
        const relation = "rel'; DELETE edge; --";
        await g.upsertNode(node('a'));
        await g.upsertNode(node('b'));
        await g.upsertNode(node('c'));
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation });
        await g.addEdge({ sourceId: 'a', targetId: 'c', relation: 'keep_me' });

        const filtered = await g.queryEdges({ relation, limit: 10, offset: 0 });
        assert.equal(filtered.length, 1, 'relation filter resolves to exactly its own edge');
        assert.equal(filtered[0]?.targetId, 'b');

        assert.equal(await g.deleteEdge('a', 'b', relation), 1);
        const remaining = await g.queryEdges({ limit: 10, offset: 0 });
        assert.equal(remaining.length, 1, 'the DELETE payload did not wipe the edge table');
        assert.equal(remaining[0]?.relation, 'keep_me');
    });
});

await test('a hostile prune prefix removes only genuinely matching edges', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('a'));
        await g.upsertNode(node('b'));
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'supersedes' });

        for (const payload of ["' OR '1'='1", '%', '', "x'; DELETE edge; --"]) {
            assert.equal(await g.pruneInferredLoreEdges(payload), payload === '' ? 1 : 0,
                `prefix "${payload}" must not match a non-matching edge`);
            if (payload === '') break; // empty prefix legitimately matches everything
        }
        // Re-add and confirm a real prefix still prunes.
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'semantic_neighbor:0.9' });
        assert.equal(await g.pruneInferredLoreEdges('semantic_neighbor'), 1);
    });
});

/* ─── negative control: the payloads ARE potent ──────────────────── */

await test('NEGATIVE CONTROL: the same payload DOES break out when interpolated', async () => {
    // Everything above proves the engine neutralizes these payloads. That is
    // only meaningful if the payloads could do damage in the first place —
    // otherwise the whole file passes trivially against any implementation,
    // including one with no protection at all.
    //
    // So: run the SAME payload against the SAME store through a deliberately
    // string-interpolated statement, and show it destroys data. This is the
    // fail-on-base half of the proof, kept adversarial rather than assumed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-control-'));
    const db = new Surreal({ engines: createNodeEngines() });
    try {
        await db.connect(`surrealkv://${dir}/db`);
        await db.use({ namespace: 'lore', database: 'graph' });
        await db.query('DEFINE TABLE IF NOT EXISTS node SCHEMALESS');
        for (const id of ['keep-1', 'keep-2', 'keep-3']) {
            await db.query('CREATE $r CONTENT $c', { r: new RecordId('node', id), c: { label: id } });
        }

        const before = await db.query('SELECT count() AS c FROM node GROUP ALL');
        assert.equal(before[0]?.[0]?.['c'], 3, 'three rows to lose');

        // The vulnerable shape this engine deliberately never writes.
        const payload = "anything'; DELETE node; --";
        await db.query(`SELECT * FROM node WHERE label = '${payload}'`);

        const after = await db.query('SELECT count() AS c FROM node GROUP ALL');
        const remaining = after[0]?.[0]?.['c'] ?? 0;
        assert.equal(remaining, 0,
            'the interpolated form must actually delete the table — if it does not, this control is '
            + 'no longer proving anything and the battery above needs a stronger payload');
    } finally {
        await db.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('NEGATIVE CONTROL: the engine survives the payload the control just proved lethal', async () => {
    await withGraph(async (g) => {
        for (const id of ['keep-1', 'keep-2', 'keep-3']) await g.upsertNode(node(id));
        // Same payload, every caller-facing surface that takes a free-text value.
        const payload = "anything'; DELETE node; --";
        await g.search(payload, 10);
        await g.listNodes(payload, payload);
        await g.markStaleByTags([payload]);
        await g.getNodesByIds([payload]);
        await g.pruneInferredLoreEdges(payload);
        assert.equal((await g.getStats()).nodeCount, 3, 'all three rows still present');
    });
});

/* ─── the id guard rejects only what binding cannot fix ──────────── */

await test('NUL bytes, empty ids, and oversized ids are refused LOUDLY', async () => {
    await withGraph(async (g) => {
        await assert.rejects(() => g.upsertNode(node('bad\0id')), /invalid_node_id.*NUL/);
        await assert.rejects(() => g.upsertNode(node('')), /invalid_node_id.*empty/);
        await assert.rejects(() => g.upsertNode(node('x'.repeat(2000))), /invalid_node_id.*cap/);
    });
});

await test('the id guard does NOT reject printable payloads (escaping is not the control)', async () => {
    await withGraph(async (g) => {
        for (const [, payload] of PAYLOADS) {
            await g.upsertNode(node(payload));
        }
        assert.equal((await g.getStats()).nodeCount, PAYLOADS.length,
            'every printable payload is storable — the guard is narrow by design');
    });
});

await test('a NUL-byte rejection does not echo the id back into the message', async () => {
    await withGraph(async (g) => {
        const secret = 'person:sarah-smith\0';
        await assert.rejects(
            () => g.upsertNode(node(secret)),
            (err: Error) => {
                assert.ok(!err.message.includes('sarah-smith'), 'raw id must not appear in the error');
                assert.match(err.message, /NUL byte/);
                return true;
            },
        );
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

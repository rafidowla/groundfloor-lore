#!/usr/bin/env tsx
/**
 * surreal-id-roundtrip-unit.ts — bracketed-id round-trip through the
 * SurrealDB engine (Phase 1 hard constraint: "ID round-trip").
 *
 * Companion to test/id-alphabet-roundtrip-unit.ts, which covers the same
 * property on Kùzu + LanceDB. The bug it was written for
 * (fix/id-alphabet-sql-interpolation, 2026-08-03/04): an id-alphabet allowlist
 * silently rejected every Next.js dynamic-route id — `(app)/page.tsx`,
 * `[id]/route.ts`, `[...slug]/page.tsx` — so those nodes were never indexed at
 * all. 32 node rejections and ~1,100 consequential edge failures on one real
 * re-index, and nothing in the system said so.
 *
 * SurrealDB adds a SECOND, independent way to get this wrong that Kùzu does
 * not have: it has its own record-id syntax with its own quoting rules
 * (`node:simple`, `node:⟨needs quoting⟩`), and an id outside its bare
 * alphabet — which every bracketed path id is — gets wrapped on the way in.
 * If that wrapping ever leaked into `LoreNode.id`, ids would silently change
 * shape the moment a workspace moved engines, and every edge referencing them
 * would dangle.
 *
 * So this file asserts the invariant at both ends:
 *   A. Bracketed / parenthesised / dotted / slashed ids survive the FULL
 *      surface — upsert → getNode → getNodesByIds → listNodes → search →
 *      edges → traverse → supersede → delete — byte-identical, with no
 *      `⟨⟩` or `node:` prefix leaking into the returned id.
 *   B. Two bracketed-id nodes can participate in an edge together and be
 *      traversed between (the ~1,100-edge failure mode).
 *   C. Ids that differ only in their quoting-relevant characters stay
 *      DISTINCT rows — the collision a naive unwrap would cause.
 *   D. Refusal stays narrow and loud: NUL / empty / oversized only.
 *
 * Run: npx tsx test/surreal-id-roundtrip-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { ridToId, toNodeRid } from '../packages/lore/src/engines/surreal/surrealRecordId.js';
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-ids-'));
    const graph = new SurrealGraph(dir, { workspaceId: 'ids-ws' });
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
        type: 'code',
        label: `Label for ${id}`,
        content: `Content for ${id}`,
        tags: ['route'],
        project: 'web',
        ecosystem: '*',
        metadata: '{}',
        ...over,
    };
}

/**
 * The real shapes that broke. Bracketed Next.js routes first, since those are
 * the ones the original defect dropped on the floor.
 */
const IDS: ReadonlyArray<readonly [name: string, id: string]> = [
    ['dynamic segment', 'app/[id]/route.ts'],
    ['catch-all segment', 'app/[...slug]/page.tsx'],
    ['optional catch-all', 'app/[[...slug]]/page.tsx'],
    ['route group', 'app/(marketing)/page.tsx'],
    ['group + dynamic', 'app/(shop)/products/[handle]/page.tsx'],
    ['bare brackets', '[id]'],
    ['bare parens', '(app)'],
    ['lore-style namespaced id', 'person:sarah-smith'],
    ['double-colon id', 'a:b:c'],
    ['dotted path', 'src/lib/utils.test.ts'],
    ['spaces', 'My Notes 2026'],
    ['angle brackets', '<html>'],
    ['surreal quote characters', '⟨already-quoted⟩'],
    ['unicode', 'décisions/été'],
];

console.log('SurrealGraph — bracketed-id round-trip');

/* ─── A. pure mapping layer ──────────────────────────────────────── */

await test('ridToId(toNodeRid(id)) is the identity for every shape', () => {
    for (const [name, id] of IDS) {
        assert.equal(ridToId(toNodeRid(id)), id, `mapping is lossy for ${name}`);
    }
});

await test('ridToId unwraps the textual record-id forms a JSON codec can emit', () => {
    // The CBOR codec returns RecordId objects, but the textual form must also
    // unwrap — otherwise a codec change would silently corrupt every id.
    assert.equal(ridToId('node:simple'), 'simple');
    assert.equal(ridToId('node:⟨app/[id]/route.ts⟩'), 'app/[id]/route.ts');
    assert.equal(ridToId('node:`backticked`'), 'backticked');
    // Only the FIRST colon separates table from id — a Lore id may contain its own.
    assert.equal(ridToId('node:⟨person:sarah-smith⟩'), 'person:sarah-smith');
    assert.equal(ridToId({ tb: 'node', id: 'app/(x)/y.tsx' }), 'app/(x)/y.tsx');
});

/* ─── B. full engine surface ─────────────────────────────────────── */

for (const [name, id] of IDS) {
    await test(`id survives the full read surface byte-identically: ${name}`, async () => {
        await withGraph(async (g) => {
            const written = await g.upsertNode(node(id));
            assert.equal(written.id, id, 'upsert return');

            const read = await g.getNode(id);
            assert.equal(read?.id, id, 'getNode');
            // The Surreal record syntax must never leak into a LoreNode.id.
            // Guarded on the input shape: `⟨already-quoted⟩` is a legitimate id
            // that is SUPPOSED to come back wrapped in those characters,
            // because they are its own — the byte-equality check above is what
            // separates "leaked quoting" from "the id contains that character".
            if (!id.startsWith('node:')) {
                assert.ok(!read!.id.startsWith('node:'), 'no table prefix leaked');
            }
            if (!/^⟨.*⟩$/.test(id)) {
                assert.ok(!/^⟨.*⟩$/.test(read!.id), 'no ⟨⟩ quoting leaked');
            }

            assert.equal((await g.getNodesByIds([id])).get(id)?.id, id, 'getNodesByIds');
            assert.equal((await g.listNodes())[0]?.id, id, 'listNodes');
            assert.equal((await g.search('Content for', 10))[0]?.id, id, 'search');
            assert.equal(String((await g.bulkList({ limit: 10 })).nodes[0]?.['id']), id, 'bulkList');
            assert.equal(String((await g.getTopology(10)).nodes[0]?.['id']), id, 'getTopology');
        });
    });
}

await test('two bracketed-id nodes can share an edge and be traversed between', async () => {
    await withGraph(async (g) => {
        const from = 'app/(shop)/products/[handle]/page.tsx';
        const to = 'app/[...slug]/layout.tsx';
        await g.upsertNode(node(from));
        await g.upsertNode(node(to));
        await g.addEdge({ sourceId: from, targetId: to, relation: 'imports' });

        const edges = await g.queryEdges({ limit: 10, offset: 0 });
        assert.equal(edges.length, 1);
        assert.equal(edges[0]?.sourceId, from, 'edge source id round-trips');
        assert.equal(edges[0]?.targetId, to, 'edge target id round-trips');

        const [hop] = await g.traverse(from, 1);
        assert.equal(hop?.node.id, to, 'traversal reaches the bracketed neighbour');
        assert.equal(hop?.relation, 'imports');

        // And the filter form resolves by the bracketed id, not by accident.
        const filtered = await g.queryEdges({ source: from, limit: 10, offset: 0 });
        assert.equal(filtered.length, 1);
    });
});

await test('supersession and deletion address a bracketed id correctly', async () => {
    await withGraph(async (g) => {
        const oldId = 'app/[id]/old.tsx';
        const newId = 'app/[id]/new.tsx';
        await g.upsertNode(node(oldId));
        await g.upsertNode(node(newId));

        assert.deepEqual(await g.supersedeNode(oldId, newId, 'renamed'), { ok: true });
        assert.equal((await g.getNode(oldId))?.supersededBy, newId, 'supersededBy stores the raw id');
        assert.equal(await g.unsupersedeNode(oldId), true);

        assert.equal(await g.deleteNode(oldId), true);
        assert.equal(await g.getNode(oldId), null);
        assert.ok(await g.getNode(newId), 'the sibling bracketed id is untouched');
    });
});

/* ─── C. distinctness ────────────────────────────────────────────── */

await test('ids differing only in quoting-relevant characters stay DISTINCT rows', async () => {
    await withGraph(async (g) => {
        // A naive unwrap (strip brackets / strip the table prefix) would
        // collapse some of these onto each other.
        const family = [
            'route',
            '⟨route⟩',
            'node:route',
            '`route`',
            '[route]',
            '(route)',
        ];
        for (const [i, id] of family.entries()) {
            await g.upsertNode(node(id, { label: `variant-${i}` }));
        }
        for (const [i, id] of family.entries()) {
            const read = await g.getNode(id);
            assert.equal(read?.id, id, `variant ${i} reads back as itself`);
            assert.equal(read?.label, `variant-${i}`, `variant ${i} did not collide`);
        }
        assert.equal((await g.getStats()).nodeCount, family.length, 'no two variants merged');
    });
});

await test('a bracketed id survives an update without changing shape', async () => {
    await withGraph(async (g) => {
        const id = 'app/[...catchAll]/page.tsx';
        const first = await g.upsertNode(node(id, { label: 'v1' }));
        const second = await g.upsertNode(node(id, { label: 'v2' }));
        assert.equal(second.id, id);
        assert.equal(second.createdAt, first.createdAt, 'update matched the SAME row');
        assert.equal((await g.getStats()).nodeCount, 1, 'update did not create a second row');
        assert.equal((await g.getNode(id))?.label, 'v2');
    });
});

/* ─── D. narrow, loud refusal ────────────────────────────────────── */

await test('refusal is limited to what binding cannot fix, and names the reason', async () => {
    await withGraph(async (g) => {
        await assert.rejects(() => g.upsertNode(node('a\0b')), /invalid_node_id.*NUL byte/);
        await assert.rejects(() => g.upsertNode(node('')), /invalid_node_id.*empty/);
        await assert.rejects(() => g.upsertNode(node('x'.repeat(1025))), /invalid_node_id.*cap/);
        // Nothing was persisted by any of the three.
        assert.equal((await g.getStats()).nodeCount, 0);
    });
});

await test('every bracketed shape is ACCEPTED (the alphabet is not the control)', async () => {
    await withGraph(async (g) => {
        for (const [, id] of IDS) await g.upsertNode(node(id));
        assert.equal((await g.getStats()).nodeCount, IDS.length,
            'no bracketed id is silently dropped — the original defect stays fixed');
    });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

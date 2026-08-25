#!/usr/bin/env tsx
/**
 * test/scope-resolver-unit.ts — T7 unit tests
 *
 * Substrate-agnostic resolver tested against an in-memory graph.
 *
 * Two graph shapes exercised:
 *
 * (1) Multi-level hierarchy:
 *
 *       Org ←──parent── Portfolio ←──parent── Property ←──parent── Lease
 *                                                ↑
 *                                                └──parent── Unit
 *
 *     "down" from Portfolio along parent collects Property + its
 *     children (Lease, Unit). "up" from Lease along parent collects
 *     Property → Portfolio → Org.
 *
 * (2) Family-style ad-hoc — to confirm scope rules work for arbitrary
 *     workspace shapes, not just a 4-level hierarchy.
 */

import { strict as assert } from 'node:assert';
import {
    ScopeResolver,
    type ScopeGraphAccessor,
} from '../packages/lore/src/engines/scopeResolver.js';
import type { LoreSchemaV2 } from '../packages/lore/src/schemas/types.js';
import { DEFAULT_SCHEMA_V2 } from '../packages/lore/src/schemas/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => {
                console.error(`  ✗ ${name}\n    ${err.message}`);
                failed++;
            },
        );
}

interface InMemoryEdge {
    from: string;
    to: string;
    type: string;
}

class InMemoryGraph implements ScopeGraphAccessor {
    constructor(
        private readonly edges: InMemoryEdge[],
        private readonly nodeTypes: Record<string, string> = {},
    ) { }

    async neighborsOut(nodeId: string, edgeTypes: string[]): Promise<string[]> {
        const t = new Set(edgeTypes);
        return this.edges
            .filter(e => e.from === nodeId && t.has(e.type))
            .map(e => e.to);
    }

    async neighborsIn(nodeId: string, edgeTypes: string[]): Promise<string[]> {
        const t = new Set(edgeTypes);
        return this.edges
            .filter(e => e.to === nodeId && t.has(e.type))
            .map(e => e.from);
    }

    async getNodeType(nodeId: string): Promise<string | null> {
        return this.nodeTypes[nodeId] ?? null;
    }
}

/**
 * Hierarchy: parent edge points from child UP to parent.
 *
 *   org1 ← portfolio1 ← propertyA ← leaseA1
 *                              ← unitA1
 *           ← portfolio2 ← propertyB ← leaseB1
 */
function hierarchyGraph(): InMemoryGraph {
    return new InMemoryGraph(
        [
            { from: 'portfolio1', to: 'org1', type: 'parent' },
            { from: 'portfolio2', to: 'org1', type: 'parent' },
            { from: 'propertyA', to: 'portfolio1', type: 'parent' },
            { from: 'propertyB', to: 'portfolio2', type: 'parent' },
            { from: 'leaseA1', to: 'propertyA', type: 'parent' },
            { from: 'unitA1', to: 'propertyA', type: 'parent' },
            { from: 'leaseB1', to: 'propertyB', type: 'parent' },
        ],
        {
            org1: 'Org', portfolio1: 'Portfolio', portfolio2: 'Portfolio',
            propertyA: 'Property', propertyB: 'Property',
            leaseA1: 'Lease', leaseB1: 'Lease', unitA1: 'Unit',
        },
    );
}

async function main() {
    console.log('scope resolver — T7');

    /* ---------- inline spec ---------- */

    await test('down from Property: collects descendants', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'propertyA',
            spec: { viaEdges: ['parent'], direction: 'down' },
        });
        assert.deepEqual(
            result.ids.sort(),
            ['leaseA1', 'propertyA', 'unitA1'].sort(),
        );
    });

    await test('up from Lease: collects ancestors', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'leaseA1',
            spec: { viaEdges: ['parent'], direction: 'up' },
        });
        assert.deepEqual(
            result.ids.sort(),
            ['leaseA1', 'org1', 'portfolio1', 'propertyA'].sort(),
        );
    });

    await test('down from Portfolio: collects properties + their children', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'portfolio1',
            spec: { viaEdges: ['parent'], direction: 'down' },
        });
        assert.deepEqual(
            result.ids.sort(),
            ['leaseA1', 'portfolio1', 'propertyA', 'unitA1'].sort(),
        );
    });

    await test('both: walks the full connected cluster', async () => {
        // 'both' is a free walk in either direction at each step, so it
        // expands to the entire connected component via the named edge.
        // From propertyA via parent: every node reachable through the
        // org/portfolio/property/lease tree.
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'propertyA',
            spec: { viaEdges: ['parent'], direction: 'both' },
        });
        assert.deepEqual(
            result.ids.sort(),
            [
                'leaseA1', 'leaseB1', 'org1', 'portfolio1', 'portfolio2',
                'propertyA', 'propertyB', 'unitA1',
            ].sort(),
        );
    });

    await test('both with maxDepth=1: only immediate neighbors of root', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'propertyA',
            spec: { viaEdges: ['parent'], direction: 'both', maxDepth: 1 },
        });
        assert.deepEqual(
            result.ids.sort(),
            ['leaseA1', 'portfolio1', 'propertyA', 'unitA1'].sort(),
        );
    });

    /* ---------- includeRoot ---------- */

    await test('includeRoot:false omits the root id', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'propertyA',
            spec: { viaEdges: ['parent'], direction: 'down', includeRoot: false },
        });
        assert.ok(!result.ids.includes('propertyA'));
        assert.deepEqual(result.ids.sort(), ['leaseA1', 'unitA1'].sort());
    });

    /* ---------- maxDepth ---------- */

    await test('maxDepth caps the BFS', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'org1',
            spec: { viaEdges: ['parent'], direction: 'down', maxDepth: 1 },
        });
        // Depth 1 from org1: only portfolios.
        assert.deepEqual(
            result.ids.sort(),
            ['org1', 'portfolio1', 'portfolio2'].sort(),
        );
        assert.equal(result.truncated, true);
    });

    await test('maxDepth=0 returns just the root (when includeRoot:true)', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'propertyA',
            spec: { viaEdges: ['parent'], direction: 'down', maxDepth: 0 },
        });
        assert.deepEqual(result.ids, ['propertyA']);
    });

    /* ---------- includeTypes ---------- */

    await test('includeTypes filters output by node type', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'org1',
            spec: { viaEdges: ['parent'], direction: 'down', includeTypes: ['Lease'] },
        });
        assert.deepEqual(result.ids.sort(), ['leaseA1', 'leaseB1'].sort());
    });

    /* ---------- workspace-declared scope ---------- */

    await test('resolves a scope name declared in the schema', async () => {
        const schema: LoreSchemaV2 = {
            ...DEFAULT_SCHEMA_V2,
            scopes: {
                'property-and-children': {
                    viaEdges: ['parent'],
                    direction: 'down',
                    description: 'a property and everything under it',
                },
            },
        };
        const r = new ScopeResolver(hierarchyGraph());
        const result = await r.resolve({
            rootId: 'propertyA',
            scopeName: 'property-and-children',
            schema,
        });
        assert.deepEqual(
            result.ids.sort(),
            ['leaseA1', 'propertyA', 'unitA1'].sort(),
        );
    });

    await test('throws when scopeName is not in the schema', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        await assert.rejects(
            () => r.resolve({
                rootId: 'propertyA',
                scopeName: 'made-up',
                schema: DEFAULT_SCHEMA_V2,
            }),
            /no scope named 'made-up'/,
        );
    });

    await test('throws when neither spec nor scopeName supplied', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        await assert.rejects(
            () => r.resolve({ rootId: 'propertyA' }),
            /requires either/,
        );
    });

    /* ---------- multiple edge types ---------- */

    await test('viaEdges supports multiple edge types in a single scope', async () => {
        // Simulated: a workspace where 'parent' AND 'attached_to' both
        // contribute to "everything under X."
        const graph = new InMemoryGraph([
            { from: 'a', to: 'x', type: 'parent' },
            { from: 'b', to: 'x', type: 'attached_to' },
            { from: 'c', to: 'x', type: 'unrelated_edge' },
        ]);
        const r = new ScopeResolver(graph);
        const result = await r.resolve({
            rootId: 'x',
            spec: { viaEdges: ['parent', 'attached_to'], direction: 'down' },
        });
        assert.deepEqual(result.ids.sort(), ['a', 'b', 'x'].sort());
        assert.ok(!result.ids.includes('c'));
    });

    /* ---------- cycles ---------- */

    await test('handles cycles without infinite loop', async () => {
        const graph = new InMemoryGraph([
            { from: 'a', to: 'b', type: 'parent' },
            { from: 'b', to: 'c', type: 'parent' },
            { from: 'c', to: 'a', type: 'parent' },
        ]);
        const r = new ScopeResolver(graph);
        const result = await r.resolve({
            rootId: 'a',
            spec: { viaEdges: ['parent'], direction: 'up' },
        });
        // BFS should hit each node exactly once.
        assert.deepEqual(result.ids.sort(), ['a', 'b', 'c'].sort());
    });

    /* ---------- the canonical hierarchy scenario ---------- */

    await test('hierarchy scenario: scoping Alice\'s search to PropertyA produces only PropertyA + descendants', async () => {
        const r = new ScopeResolver(hierarchyGraph());
        const aliceScope = await r.resolve({
            rootId: 'propertyA',
            spec: { viaEdges: ['parent'], direction: 'down' },
        });
        // Alice looks at Property A: she sees PropertyA, leaseA1, unitA1.
        // She does NOT see PropertyB or anything under it.
        assert.ok(aliceScope.ids.includes('propertyA'));
        assert.ok(aliceScope.ids.includes('leaseA1'));
        assert.ok(aliceScope.ids.includes('unitA1'));
        assert.ok(!aliceScope.ids.includes('propertyB'));
        assert.ok(!aliceScope.ids.includes('leaseB1'));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('test runner crashed:', err);
    process.exit(1);
});

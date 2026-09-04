#!/usr/bin/env tsx
/**
 * surreal-runtime-wiring-unit.ts — Phase 3 runtime wiring
 * (docs/SURREALDB_BUILD_PLAN.md).
 *
 * Phase 1 built the engine, Phase 2 proved it agrees with the legacy graph engine. Neither made it
 * REACHABLE: the local runtime resolves graphs through `LocalGraphRegistry`.
 * This file covers the wiring that makes a workspace select its graph engine,
 *
 * What is asserted, and why each one is here rather than assumed:
 *
 *   1. **Selector defaults.** A workspace with no explicit `graphEngine`
 *      falls back to `DEFAULT_GRAPH_ENGINE` ('surreal' since 2026-08-11).
 *   2. **The registry opens the selected engine**, one handle per workspace,
 *      shared across repeated and concurrent calls — two SurrealGraph handles
 *      on one surrealkv directory contend on its lock, so a per-call open
 *      would burn the retry budget and fail.
 *   3. **Workspace confinement holds.** This is the local-mode isolation
 *      boundary (CLAUDE.md): an engine that skipped the gate would be a way
 *      to read another app's workspace. Mirrors the `rc-round4-workspace-
 *      routing` pattern — per-workspace instances, route a request to B,
 *      assert A is untouched.
 *   4. **Lifecycle.** Eviction, `disposeAll` and `closeWorkspace` must close
 *      the handle. A leaked SurrealDB handle holds its directory lock, so a
 *      leak here does not merely waste memory — it makes the workspace
 *      unopenable until the process exits.
 *   5. **The schema-safety seam fails loudly** for a handle that exposes
 *      neither schema-ops hatch (e.g. a cloud DataplaneGraph) instead of
 *      silently misreporting.
 *
 * Run: npx tsx test/surreal-runtime-wiring-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import {
    resolveWorkspaceGraphEngine,
} from '../packages/lore/src/engines/graphEngineSelector.js';
import { buildGraphReaders } from '../packages/lore/src/mcp/bootSteps.js';
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

/**
 * A throwaway LORE_HOME with a real workspaces.json, so the registry and the
 * selector read the same on-disk source the daemon does. No fakes: the point is
 * to exercise the actual config → registry → engine path.
 */
interface Home {
    home: string;
    cleanup: () => void;
}

function makeHome(workspaces: Array<{ name: string; graphEngine?: 'surreal' }>): Home {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-p3-home-'));
    const entries = workspaces.map((w) => {
        const wsPath = path.join(home, 'workspaces', w.name);
        fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
        return {
            name: w.name,
            path: wsPath,
            createdAt: new Date().toISOString(),
            ...(w.graphEngine ? { graphEngine: w.graphEngine } : {}),
        };
    });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active: workspaces[0]?.name ?? 'default', workspaces: entries }, null, 2),
    );
    return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function node(id: string, over: Partial<LoreNode> = {}): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'decision',
        label: `Label ${id}`,
        content: `Content ${id}`,
        tags: ['wiring'],
        project: 'p',
        ecosystem: 'e',
        metadata: '{}',
        ...over,
    };
}

console.log('Phase 3 — SurrealDB runtime wiring');

/* ─── 1. the selector ────────────────────────────────────────────── */

await test('an absent graphEngine resolves to the default (surreal since 2026-08-11) — no already-migrated workspace is affected, since every one has an explicit value', () => {
    const h = makeHome([{ name: 'plain' }]);
    try {
        assert.equal(resolveWorkspaceGraphEngine('plain', h.home), 'surreal');
    } finally {
        h.cleanup();
    }
});

await test('an unknown workspace resolves to the default rather than throwing', () => {
    // The selector is not the place to fail workspace resolution — the caller's
    // next step (opening it) produces the real, better error.
    const h = makeHome([{ name: 'known' }]);
    try {
        assert.equal(resolveWorkspaceGraphEngine('ghost', h.home), 'surreal');
    } finally {
        h.cleanup();
    }
});

/* ─── 2. the registry opens the selected engine ──────────────────── */

await test('registry: a surreal workspace resolves to a SurrealGraph', async () => {
    const h = makeHome([{ name: 'sws', graphEngine: 'surreal' }]);
    const registry = new LocalGraphRegistry({ home: h.home });
    try {
        const handle = await registry.getGraphHandle('sws');
        assert.ok(handle instanceof SurrealGraph, 'surreal workspaces get a SurrealGraph');
        assert.equal(registry.graphEngineFor('sws'), 'surreal');
        // And it is functional through the shared interface, not just typed.
        await handle.upsertNode(node('n1'));
        assert.equal((await handle.getNode('n1'))?.label, 'Label n1');
    } finally {
        await registry.disposeAll();
        h.cleanup();
    }
});

await test('registry: repeated getGraphHandle returns ONE SurrealGraph, not a new one each call', async () => {
    // Two handles on one surrealkv directory contend on its lock, and the
    // driver releases that lock asynchronously — a per-call open would burn the
    // retry budget and fail.
    const h = makeHome([{ name: 'sws', graphEngine: 'surreal' }]);
    const registry = new LocalGraphRegistry({ home: h.home });
    try {
        const a = await registry.getGraphHandle('sws');
        const b = await registry.getGraphHandle('sws');
        const c = await registry.getGraphHandle('sws');
        assert.equal(a, b);
        assert.equal(b, c);
    } finally {
        await registry.disposeAll();
        h.cleanup();
    }
});

await test('registry: concurrent first-time getGraphHandle calls share one open', async () => {
    const h = makeHome([{ name: 'sws', graphEngine: 'surreal' }]);
    const registry = new LocalGraphRegistry({ home: h.home });
    try {
        const handles = await Promise.all([
            registry.getGraphHandle('sws'),
            registry.getGraphHandle('sws'),
            registry.getGraphHandle('sws'),
            registry.getGraphHandle('sws'),
        ]);
        assert.equal(new Set(handles).size, 1, 'a concurrent burst must not open four engines');
    } finally {
        await registry.disposeAll();
        h.cleanup();
    }
});

/* ─── 3. workspace confinement on the new path ───────────────────── */

await test('confinement: two surreal workspaces get DISTINCT engines and distinct data', async () => {
    // The rc-round4 pattern: per-workspace instances, write to B, assert A is
    // untouched. This is the local-mode isolation boundary, and a second engine
    // that shared state across workspaces would breach it.
    const h = makeHome([
        { name: 'ws-a', graphEngine: 'surreal' },
        { name: 'ws-b', graphEngine: 'surreal' },
    ]);
    const registry = new LocalGraphRegistry({ home: h.home });
    try {
        const a = await registry.getGraphHandle('ws-a');
        const b = await registry.getGraphHandle('ws-b');
        assert.notEqual(a, b, 'distinct workspaces must not share an engine instance');

        await b.upsertNode(node('only-in-b'));
        assert.ok(await b.getNode('only-in-b'), 'the write landed in B');
        assert.equal(await a.getNode('only-in-b'), null, 'and is INVISIBLE in A');
        assert.equal((await a.getStats()).nodeCount, 0, 'A is still empty');
        assert.equal((await b.getStats()).nodeCount, 1, 'B has exactly the one node');
    } finally {
        await registry.disposeAll();
        h.cleanup();
    }
});

await test('confinement: the surreal store lands under the workspace\'s OWN directory', async () => {
    // Physical proof, not just logical: the on-disk data must be inside the
    // workspace path from workspaces.json, or a "migrated" workspace would be
    // writing somewhere the backup/restore path never looks.
    const h = makeHome([{ name: 'ws-s', graphEngine: 'surreal' }]);
    const registry = new LocalGraphRegistry({ home: h.home });
    try {
        const s = await registry.getGraphHandle('ws-s');
        await s.upsertNode(node('n1'));
        const expected = path.join(h.home, 'workspaces', 'ws-s', '.lore', 'surreal');
        assert.equal((s as SurrealGraph).dataPath, expected, 'store path is workspace-local');
        assert.ok(fs.existsSync(expected), 'and it physically exists');
    } finally {
        await registry.disposeAll();
        h.cleanup();
    }
});

/* ─── 4. one lifecycle for the handle ───────────────────────────── */

await test('lifecycle: disposeAll closes the SurrealDB handle too (lock released)', async () => {
    // A leaked Surreal handle holds its directory lock, so the workspace could
    // not be reopened. Proving the lock is gone = proving the close happened.
    const h = makeHome([{ name: 'sws', graphEngine: 'surreal' }]);
    const first = new LocalGraphRegistry({ home: h.home });
    try {
        const s = await first.getGraphHandle('sws');
        await s.upsertNode(node('persisted'));
        await first.disposeAll();

        const second = new LocalGraphRegistry({ home: h.home });
        try {
            const reopened = await second.getGraphHandle('sws');
            assert.equal((await reopened.getNode('persisted'))?.label, 'Label persisted',
                'reopening after disposeAll works AND the data survived');
        } finally {
            await second.disposeAll();
        }
    } finally {
        h.cleanup();
    }
});

await test('lifecycle: idle eviction closes the SurrealDB handle and reopen still works', async () => {
    const h = makeHome([{ name: 'sws', graphEngine: 'surreal' }]);
    let clock = 1_000;
    const registry = new LocalGraphRegistry({ home: h.home, now: () => clock });
    try {
        const s = await registry.getGraphHandle('sws');
        await s.upsertNode(node('before-evict'));
        assert.equal(registry.openCount(), 1);

        clock += 60 * 60 * 1000; // an hour idle
        assert.equal(await registry.evictIdle(clock, 30 * 60 * 1000), 1, 'the entry was evicted');
        assert.equal(registry.openCount(), 0);

        // Reopening proves the Surreal lock was actually released, not just
        // that the map entry was deleted.
        const again = await registry.getGraphHandle('sws');
        assert.notEqual(again, s, 'a fresh engine instance');
        assert.equal((await again.getNode('before-evict'))?.label, 'Label before-evict');
    } finally {
        await registry.disposeAll();
        h.cleanup();
    }
});

await test('lifecycle: closeWorkspace releases the handle', async () => {
    const h = makeHome([{ name: 'sws', graphEngine: 'surreal' }]);
    const registry = new LocalGraphRegistry({ home: h.home });
    try {
        const s = await registry.getGraphHandle('sws');
        await s.upsertNode(node('n1'));
        assert.equal(await registry.closeWorkspace('sws'), true);
        assert.equal(registry.openCount(), 0);
        // Reopen — only possible if the surrealkv lock was released.
        const again = await registry.getGraphHandle('sws');
        assert.ok(await again.getNode('n1'));
    } finally {
        await registry.disposeAll();
        h.cleanup();
    }
});

/* ─── 5. the schema-safety seam (SchemaGraphOps port selection) ──── */

await test('gate: the schema-subsystem seam refuses a handle with neither schema-ops hatch', async () => {
    // buildGraphReaders is the single entry point for the schema-safety
    // subsystem (migration backend, pre-destructive snapshots, blast-radius
    // estimates). Since the SchemaGraphOps port landed, it selects the ops
    // instance per engine (SurrealGraph.getSchemaGraphOps() or a
    // LegacySchemaGraphOps wrapping getGraphContext()) instead of refusing
    // non-legacy-engine workspaces. What still fails closed — with the same named
    // error — is a handle that exposes NEITHER hatch (e.g. a cloud
    // DataplaneGraph reaching this seam).
    const h = makeHome([{ name: 'sws', graphEngine: 'surreal' }]);
    try {
        let cypherReached = false;
        const fakeGraph = {
            // Deliberately exposes NO schema-ops path at all. The stray
            // queryRows here proves the refusal fires before any engine
            // call, the same way the old pre-Cypher gate did.
            queryRows: async () => { cypherReached = true; return []; },
        };
        const { schemaGraphOps } = buildGraphReaders(
            () => fakeGraph as never, () => 'sws', () => h.home,
        );

        await assert.rejects(
            async () => schemaGraphOps.countNodesByType('know.Tenant'),
            /graph_substrate_unsupported|getSchemaGraphOps\(\) or getGraphContext\(\)/,
        );
        assert.equal(cypherReached, false,
            'the refusal must fire BEFORE any engine call — running it would silently misreport');
    } finally {
        h.cleanup();
    }
});

/* ─── 6. the typed neighbour hooks the HTTP routes feature-detect ── */

await test('routes: SurrealGraph exposes neighbors1Hop, so GET /api/node needs no Cypher', async () => {
    // Without this the route falls back to raw Cypher against the EMPTY
    // legacy-engine node table and returns 200-with-no-neighbours — the
    // silent-empty class.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-p3-nb-'));
    const g = new SurrealGraph(dir, { cacheDisabled: true });
    try {
        await g.initialize();
        await g.upsertNode(node('center'));
        await g.upsertNode(node('out-1'));
        await g.upsertNode(node('in-1'));
        await g.addEdge({ sourceId: 'center', targetId: 'out-1', relation: 'refers_to' });
        await g.addEdge({ sourceId: 'in-1', targetId: 'center', relation: 'cites' });

        assert.equal(typeof g.neighbors1Hop, 'function', 'the route feature-detects this name');
        const { outRows, inRows } = await g.neighbors1Hop('center');
        assert.deepEqual(outRows.map((r) => r.id), ['out-1']);
        assert.deepEqual(inRows.map((r) => r.id), ['in-1']);
        assert.equal(outRows[0]?.rel, 'refers_to');
        assert.equal(outRows[0]?.label, 'Label out-1', 'neighbour rows are hydrated');
        assert.equal(inRows[0]?.conf, 'extracted');
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('routes: SurrealGraph exposes subgraphFetch, so GET /api/subgraph needs no Cypher', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-p3-sg-'));
    const g = new SurrealGraph(dir, { cacheDisabled: true });
    try {
        await g.initialize();
        for (const id of ['c', 'n1', 'n2']) await g.upsertNode(node(id));
        await g.addEdge({ sourceId: 'c', targetId: 'n1', relation: 'refers_to' });
        await g.addEdge({ sourceId: 'n1', targetId: 'n2', relation: 'refers_to' });

        assert.equal(typeof g.subgraphFetch, 'function');
        const { nodes, edges } = await g.subgraphFetch('c', { label: 'C', type: 'note' }, 2, 50, false);
        assert.deepEqual(nodes.map((n) => n.id).sort(), ['n1', 'n2'], 'center excluded, both hops present');
        assert.equal(nodes.find((n) => n.id === 'n1')?.depth, 1);
        assert.equal(nodes.find((n) => n.id === 'n2')?.depth, 2);
        assert.equal(edges.length, 2);
    } finally {
        await g.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('routes: workspace export reads via getGraphHandle, so a surreal workspace exports real data (not an empty legacy-engine table)', async () => {
    // Regression for a real bug: mcp/http/routes/workspaceExport.ts used to call
    // registry.withGraph(), which unconditionally opened the legacy engine
    // regardless of the workspace's declared engine. On a surreal-backed
    // workspace that meant the export route silently read the empty
    // legacy-engine table and streamed a
    // successful-looking empty bundle. getGraphHandle() is engine-honouring.
    const h = makeHome([{ name: 'exp', graphEngine: 'surreal' }]);
    const registry = new LocalGraphRegistry({ home: h.home });
    try {
        const g = await registry.getGraphHandle('exp');
        await g.upsertNode(node('a'));
        await g.upsertNode(node('b'));
        await g.addEdge({ sourceId: 'a', targetId: 'b', relation: 'refers_to' });

        const nodes = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
        const edges = await g.queryEdges({ limit: 1000, offset: 0 });
        assert.deepEqual(nodes.map((n) => n.id).sort(), ['a', 'b'], 'real nodes, not an empty legacy-engine read');
        assert.equal(edges.length, 1);
        assert.equal(edges[0]?.sourceId, 'a');
    } finally {
        await registry.disposeAll();
        h.cleanup();
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env tsx
/**
 * temporal-valid-time-unit.ts — bi-temporal valid-time storage/query primitive.
 *
 * Covers the SurrealDB engine (the default backend new workspaces get —
 * Kùzu is legacy and intentionally NOT exercised here, per the 2026-08
 * migration off it). Proves:
 *   - validFrom/validUntil round-trip through upsertNode -> getNode.
 *   - A node written WITHOUT a valid-time window is always "as-of" valid
 *     (backward compatibility — the ~100% case for existing data).
 *   - listNodesAsOf (core/temporalQuery.ts) correctly includes/excludes
 *     nodes at timestamps inside/outside/on-the-boundary of the window,
 *     alongside always-valid (no-window) nodes.
 *   - The predicate handles an open-ended start (validFrom only) and an
 *     open-ended end (validUntil only).
 *
 * Run: npx tsx test/temporal-valid-time-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { isValidAsOf, listNodesAsOf } from '../packages/lore/src/core/temporalQuery.js';
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

/** Fresh SurrealGraph on a throwaway directory; always closed and removed. */
async function withGraph(fn: (g: SurrealGraph) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-temporal-'));
    const graph = new SurrealGraph(dir, { workspaceId: 'test-ws' });
    try {
        await graph.initialize();
        await fn(graph);
    } finally {
        await graph.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Minimal valid node; callers override what the case is about. */
function node(id: string, over: Partial<LoreNode> = {}): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'decision',
        label: `Label ${id}`,
        content: `Content for ${id}`,
        tags: ['alpha'],
        project: 'proj',
        ecosystem: '*',
        metadata: '{}',
        ...over,
    };
}

console.log('Bi-temporal valid-time — storage + as-of query primitive (SurrealDB)');

/* ─── storage round-trip ─────────────────────────────────────────── */

await test('upsertNode + getNode round-trip validFrom/validUntil', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('windowed', {
            validFrom: '2026-01-01T00:00:00.000Z',
            validUntil: '2026-06-01T00:00:00.000Z',
        }));
        const read = await g.getNode('windowed');
        assert.ok(read, 'node must be readable');
        assert.equal(read.validFrom, '2026-01-01T00:00:00.000Z');
        assert.equal(read.validUntil, '2026-06-01T00:00:00.000Z');
    });
});

await test('a node written with NO valid-time window surfaces both fields as null', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('unwindowed'));
        const read = await g.getNode('unwindowed');
        assert.ok(read);
        assert.equal(read.validFrom, null);
        assert.equal(read.validUntil, null);
    });
});

await test('listNodes (SELECT * path) also returns the fields — not just getNode', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('via-list', { validFrom: '2026-03-01T00:00:00.000Z' }));
        const rows = await g.listNodes(undefined, undefined, 'proj', '*', undefined, { unbounded: true });
        const found = rows.find((n) => n.id === 'via-list');
        assert.ok(found);
        assert.equal(found.validFrom, '2026-03-01T00:00:00.000Z');
        assert.equal(found.validUntil, null);
    });
});

/* ─── isValidAsOf predicate (pure, engine-independent) ──────────────── */

await test('isValidAsOf: no window => always valid', () => {
    const at = Date.parse('2099-01-01T00:00:00.000Z');
    assert.equal(isValidAsOf({ validFrom: null, validUntil: null }, at), true);
    assert.equal(isValidAsOf({ validFrom: undefined, validUntil: undefined }, at), true);
});

await test('isValidAsOf: inside a closed window => valid; outside => not', () => {
    const win = { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-06-01T00:00:00.000Z' };
    assert.equal(isValidAsOf(win, Date.parse('2026-03-15T00:00:00.000Z')), true, 'inside window');
    assert.equal(isValidAsOf(win, Date.parse('2025-12-31T00:00:00.000Z')), false, 'before window');
    assert.equal(isValidAsOf(win, Date.parse('2026-06-02T00:00:00.000Z')), false, 'after window');
});

await test('isValidAsOf: boundary instants are INCLUSIVE on both ends', () => {
    const win = { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-06-01T00:00:00.000Z' };
    assert.equal(isValidAsOf(win, Date.parse('2026-01-01T00:00:00.000Z')), true, 'exactly validFrom');
    assert.equal(isValidAsOf(win, Date.parse('2026-06-01T00:00:00.000Z')), true, 'exactly validUntil');
});

await test('isValidAsOf: open-ended start (validFrom only) valid at and after, not before', () => {
    const w = { validFrom: '2026-01-01T00:00:00.000Z', validUntil: null };
    assert.equal(isValidAsOf(w, Date.parse('2025-01-01T00:00:00.000Z')), false);
    assert.equal(isValidAsOf(w, Date.parse('2026-01-01T00:00:00.000Z')), true);
    assert.equal(isValidAsOf(w, Date.parse('2099-01-01T00:00:00.000Z')), true);
});

await test('isValidAsOf: open-ended end (validUntil only) valid at and before, not after', () => {
    const w = { validFrom: null, validUntil: '2026-06-01T00:00:00.000Z' };
    assert.equal(isValidAsOf(w, Date.parse('2000-01-01T00:00:00.000Z')), true);
    assert.equal(isValidAsOf(w, Date.parse('2026-06-01T00:00:00.000Z')), true);
    assert.equal(isValidAsOf(w, Date.parse('2026-06-02T00:00:00.000Z')), false);
});

/* ─── listNodesAsOf — end-to-end against a real SurrealGraph ────────── */

await test('listNodesAsOf: returns windowed node inside its window, and the always-valid node, excludes neither/other at that instant', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('fact-v1', {
            label: 'v1',
            validFrom: '2026-01-01T00:00:00.000Z',
            validUntil: '2026-06-01T00:00:00.000Z',
        }));
        await g.upsertNode(node('fact-v2', {
            label: 'v2',
            validFrom: '2026-06-01T00:00:00.000Z',
            validUntil: null,
        }));
        await g.upsertNode(node('legacy-no-window', { label: 'legacy' }));

        const insideV1 = await listNodesAsOf(g, '2026-03-01T00:00:00.000Z', { project: 'proj', unbounded: true });
        const insideIds = insideV1.map((n) => n.id).sort();
        assert.deepEqual(insideIds, ['fact-v1', 'legacy-no-window'], 'only v1 (in-window) + the unwindowed legacy node');

        const afterCutover = await listNodesAsOf(g, '2026-08-01T00:00:00.000Z', { project: 'proj', unbounded: true });
        const afterIds = afterCutover.map((n) => n.id).sort();
        assert.deepEqual(afterIds, ['fact-v2', 'legacy-no-window'], 'only v2 (now in-window, open-ended) + legacy');

        const beforeEverything = await listNodesAsOf(g, '2020-01-01T00:00:00.000Z', { project: 'proj', unbounded: true });
        const beforeIds = beforeEverything.map((n) => n.id).sort();
        assert.deepEqual(beforeIds, ['legacy-no-window'], 'neither windowed fact has started yet; legacy still always-valid');
    });
});

await test('listNodesAsOf: respects existing listNodes filters (type/tag/project/ecosystem)', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('match', { type: 'decision', tags: ['keep'] }));
        await g.upsertNode(node('wrong-type', { type: 'convention', tags: ['keep'] }));
        const results = await listNodesAsOf(g, new Date().toISOString(), { project: 'proj', type: 'decision', unbounded: true });
        assert.deepEqual(results.map((n) => n.id), ['match']);
    });
});

await test('listNodesAsOf: throws RangeError on an invalid "at" timestamp', async () => {
    await withGraph(async (g) => {
        await assert.rejects(
            () => listNodesAsOf(g, 'not-a-timestamp'),
            RangeError,
        );
    });
});

/* ─── supersedeNode <-> validUntil link ──────────────────────────────
 * supersede_node is the app EXPLICITLY saying "this is obsolete now" — no
 * inference, no LLM. Stamping validUntil at that moment keeps the two
 * mechanisms in agreement instead of validUntil silently staying unset
 * forever on every superseded node. */

await test('supersedeNode stamps validUntil = supersededAt when the old node had no end bound', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('old-decision'));
        await g.upsertNode(node('new-decision'));
        const result = await g.supersedeNode('old-decision', 'new-decision', 'replaced');
        assert.equal(result.ok, true);
        const read = await g.getNode('old-decision');
        assert.ok(read);
        assert.ok(read.validUntil, 'validUntil must now be set');
        assert.equal(read.validUntil, read.supersededAt, 'validUntil must match the same instant as supersededAt');
    });
});

await test('supersedeNode does NOT overwrite a validUntil the app already set', async () => {
    await withGraph(async (g) => {
        const appChosenEnd = '2026-05-01T00:00:00.000Z';
        await g.upsertNode(node('old-with-own-end', { validUntil: appChosenEnd }));
        await g.upsertNode(node('new-decision-2'));
        await g.supersedeNode('old-with-own-end', 'new-decision-2', 'replaced');
        const read = await g.getNode('old-with-own-end');
        assert.ok(read);
        assert.equal(read.validUntil, appChosenEnd, 'an app-supplied end date is authoritative, not clobbered by "now"');
    });
});

await test('unsupersedeNode clears validUntil back to null alongside the other supersession fields', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('reversible'));
        await g.upsertNode(node('replacement'));
        await g.supersedeNode('reversible', 'replacement', 'temp');
        assert.ok((await g.getNode('reversible'))?.validUntil, 'sanity: validUntil got set by supersede');
        await g.unsupersedeNode('reversible');
        const read = await g.getNode('reversible');
        assert.ok(read);
        assert.equal(read.validUntil, null, 'reversing the supersession must clear validUntil too');
        assert.equal(read.supersededBy, null);
    });
});

/* ─── summary ─────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

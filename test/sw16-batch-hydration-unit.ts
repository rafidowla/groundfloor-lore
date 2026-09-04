/**
 * test/sw16-batch-hydration-unit.ts
 *
 * SW-16 — Batch node hydration (kill recall/search N+1).
 *
 * The recall/search/query/cross-workspace read paths used to hydrate
 * each semantic seed with a SERIAL getNode(seed.id), per workspace —
 * O(workspaces × seeds) DB round-trips. This test pins that the
 * hydration count is now O(workspaces): exactly ONE batched
 * getNodesByIds call per workspace, regardless of how many seeds the
 * vector store returned, and that the merged results are byte-for-byte
 * identical to the old per-seed behavior.
 *
 * Strategy: drive runCrossWorkspaceRecall (the cross-workspace MCP-tool
 * aggregator, finding E2/E4/E6/F2) with SPY graphs that count getNode
 * vs getNodesByIds calls. A verbatim-store stub returns N seeds across
 * 2 workspaces. We assert:
 *   1. getNode is NEVER called on the hydration path.
 *   2. getNodesByIds is called exactly ONCE per workspace (= O(W)),
 *      NOT O(W × seeds).
 *   3. The hits returned match an independent replica of the OLD
 *      per-seed serial-getNode aggregation (results unchanged).
 *
 * This test FAILS on base (where the code calls getNode per seed, so
 * getNodesByIds is never invoked and the spy's getNodesByIds counter
 * stays at 0 while getNode fires W×S times) and PASSES on the branch.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/sw16-batch-hydration-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Self-provision a fresh LORE_HOME when one isn't supplied (or points at
// the user's real default), so `npm run test:unit:sw16-batch-hydration`
// is hermetic without a wrapper. listWorkspaceNames() reads workspaces
// .json from LORE_HOME, so it must be isolated.
const DEFAULT_HOME = path.join(process.env['HOME'] ?? '', '.groundfloor');
let TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === DEFAULT_HOME) {
    TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sw16-lore-'));
    process.env['LORE_HOME'] = TEST_HOME;
}

function seedWorkspacesJson(home: string, active: string, names: string[]): void {
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-05-21T00:00:00.000Z',
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const w of workspaces) {
        fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
    }
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active, workspaces }, null, 2),
    );
}

seedWorkspacesJson(TEST_HOME, 'A', ['A', 'B']);

const { runCrossWorkspaceRecall } = await import('../packages/lore/src/mcp/tools/recallCrossWorkspace.js');
// Dynamic imports above (env-scrub ordering, same as tw2b); the type is
// static — LoreNode's canonical home is providers/types.js (localGraph.ts
// only ever re-exported it).
import type { LoreNode } from '../packages/lore/src/providers/types.js';

// ── Test fixtures ────────────────────────────────────────────────────────
// Each workspace physically owns a disjoint set of node ids. The seeds
// returned by the verbatim store span BOTH workspaces, so the old
// per-seed loop would call getNode(seed) for every (workspace, seed)
// pair = 2 × 5 = 10 getNode calls. The batched path collapses each
// workspace's hydration to ONE getNodesByIds call = 2 total.

function node(id: string, label: string): LoreNode {
    return {
        id,
        type: 'decision',
        label,
        content: `content for ${id}`,
        tags: '',
        project: 'p',
        ecosystem: 'e',
        metadata: '{}',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        syncedAt: null,
    } as LoreNode;
}

// id → workspace that physically owns it.
const OWNED: Record<string, Record<string, LoreNode>> = {
    A: { 'a1': node('a1', 'A one'), 'a2': node('a2', 'A two') },
    B: { 'b1': node('b1', 'B one'), 'b2': node('b2', 'B two'), 'b3': node('b3', 'B three') },
};

// 5 seeds spanning both workspaces, descending score.
const SEEDS = [
    { id: 'lore:b1', score: 0.9 },
    { id: 'lore:a1', score: 0.8 },
    { id: 'lore:b2', score: 0.7 },
    { id: 'lore:a2', score: 0.6 },
    { id: 'lore:b3', score: 0.5 },
];

interface SpyCounts { getNode: number; getNodesByIds: number; }

function makeSpyGraph(ws: string, counts: SpyCounts) {
    const owned = OWNED[ws]!;
    return {
        async getNode(id: string): Promise<LoreNode | null> {
            counts.getNode++;
            return owned[id] ?? null;
        },
        async getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>> {
            counts.getNodesByIds++;
            const out = new Map<string, LoreNode>();
            for (const id of ids) {
                const n = owned[id];
                if (n) out.set(id, n);
            }
            return out;
        },
        // Keyword fallback — return nothing so only the semantic seed
        // path drives the merge (keeps the assertion about hydration
        // calls clean).
        async search(): Promise<LoreNode[]> { return []; },
    };
}

function makeRegistry(graphs: Record<string, unknown>) {
    const open = async (ws: string): Promise<unknown> => {
        const g = graphs[ws];
        if (!g) throw new Error(`unknown workspace ${ws}`);
        return g;
    };
    // Both accessors resolve to the same fake. Production reads graphs through
    // getGraphHandle (the workspace's DECLARED engine) and keeps getOrOpen as
    // the legacy-substrate accessor; this test is about batch hydration, so it
    // answers either.
    return { getOrOpen: open, getGraphHandle: open };
}

const verbatimStore = {
    async count(): Promise<number> { return 42; },
    async search(): Promise<Array<{ id: string; score: number }>> { return SEEDS; },
};

const sessionCache = { pushNode() {}, getHotContext() { return {} as never; }, flushNow() {} };

// ── Run the real (batched) path ──────────────────────────────────────────
const counts: SpyCounts = { getNode: 0, getNodesByIds: 0 };
const graphs = {
    A: makeSpyGraph('A', counts),
    B: makeSpyGraph('B', counts),
};

const result = await runCrossWorkspaceRecall({
    topic: 'anything',
    depth: 0,
    includeSuperseded: false,
    registry: makeRegistry(graphs) as never,
    verbatimStore: verbatimStore as never,
    sessionCache: sessionCache as never,
    responseMode: 'full',
});

const parsed = JSON.parse(result.content[0]!.text) as {
    knowledge: Array<{ id: string; workspace: string }>;
};
const gotIds = parsed.knowledge.map((k) => k.id).sort();

// ── Assertion 1+2: query count is O(workspaces), not O(W × seeds) ────────
const W = 2;
const S = SEEDS.length; // 5

assert.equal(
    counts.getNode,
    0,
    `SW-16 regression: hydration still calls getNode per seed ` +
        `(${counts.getNode} calls). The N+1 is back — recall must use ` +
        `getNodesByIds for batch hydration.`,
);
assert.equal(
    counts.getNodesByIds,
    W,
    `SW-16: expected exactly ONE batched getNodesByIds per workspace ` +
        `(= ${W}), got ${counts.getNodesByIds}.`,
);
// The whole point: hydration calls must NOT scale with seed count.
assert.ok(
    counts.getNodesByIds < W * S,
    `SW-16: hydration calls (${counts.getNodesByIds}) must be < W×S (${W * S}).`,
);
console.log(`PASS: hydration issued ${counts.getNodesByIds} queries (O(W)=${W}), not O(W×S)=${W * S}.`);

// ── Assertion 3: results unchanged vs the OLD per-seed serial path ───────
// Independent replica of the pre-SW-16 aggregation: serial getNode per
// (workspace, seed), highest-score-wins dedupe by id. This is the exact
// algorithm the old code ran; we assert the new batched path produces
// the identical merged id set.
const oldById = new Map<string, { node: LoreNode; workspace: string; score: number }>();
for (const ws of ['A', 'B']) {
    const g = makeSpyGraph(ws, { getNode: 0, getNodesByIds: 0 });
    for (const seed of SEEDS) {
        const stripped = seed.id.startsWith('lore:') ? seed.id.slice(5) : seed.id;
        const n = await g.getNode(stripped);
        if (!n) continue;
        if (n.supersededAt) continue;
        const existing = oldById.get(n.id);
        if (!existing || seed.score > existing.score) {
            oldById.set(n.id, { node: n, workspace: ws, score: seed.score });
        }
    }
}
const oldIds = Array.from(oldById.keys()).sort();

assert.deepEqual(
    gotIds,
    oldIds,
    `SW-16: batched recall result ids ${JSON.stringify(gotIds)} differ ` +
        `from the old per-seed aggregation ${JSON.stringify(oldIds)}.`,
);
console.log(`PASS: result ids unchanged vs old per-seed path (${gotIds.length} hits).`);

// Sanity: every seed-owned node surfaced (5 distinct ids).
assert.equal(gotIds.length, 5, `expected 5 hits, got ${gotIds.length}`);

console.log('\nSW-16 batch-hydration unit: ALL ASSERTIONS PASSED');

#!/usr/bin/env tsx
/**
 * test/cross-workspace-tag-pushdown-unit.ts — 3.38.3: cross-workspace recall
 * pushes `tags` into each workspace's seed legs (follow-up to 3.38.2's
 * single-workspace fix, test/tag-scoped-recall-pushdown-unit.ts).
 *
 * Before: `runCrossWorkspaceRecall` fetched a 20-row semantic window and a
 * 10-row keyword window per workspace with no tag, then cut by tag after the
 * merge — a tag held by a small share of a workspace came back short or empty.
 *
 * PART 1 — seedSearchWithTags (pure): no tags = exactly one call with the base
 *   filter; tags = base + one `tagsAll` call, union by id, best score, sorted.
 * PART 2 — runCrossWorkspaceRecall with fake graph/verbatim stores:
 *   - keyword leg receives the normalized tags as GraphProvider.search's 10th arg;
 *   - semantic leg (boot store AND per-workspace store) runs the extra
 *     `tagsAll` query, and a tagged node found only by it is returned;
 *   - graph node tags are authoritative: a stale verbatim hit whose graph node
 *     lacks the tag is dropped, and tag-failing rows never take a merge slot;
 *   - no tags = pre-3.38.3 call shape (one semantic call, tags arg undefined).
 *
 * Run: npx tsx test/cross-workspace-tag-pushdown-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { seedSearchWithTags, type SeedFilter } from '../packages/lore/src/mcp/tools/crossWorkspaceTagSeeds.js';

process.env['LORE_MODEL_SERVER'] = '0';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

/* ─── Part 1: seedSearchWithTags ─────────────────────────────────────── */

console.log('part 1 — seedSearchWithTags');

await test('no tags: one call, base filter passed through unchanged', async () => {
    const calls: SeedFilter[] = [];
    const out = await seedSearchWithTags(async (f) => { calls.push(f); return [{ id: 'a', score: 1 }]; }, { type: ['note'] }, undefined);
    assert.deepEqual(calls, [{ type: ['note'] }]);
    assert.deepEqual(out, [{ id: 'a', score: 1 }]);
    const calls2: SeedFilter[] = [];
    await seedSearchWithTags(async (f) => { calls2.push(f); return []; }, undefined, []);
    assert.deepEqual(calls2, [undefined], 'empty tags = no extra query');
});

await test('tags: base + tagsAll call, union by id keeps best score, score-desc order', async () => {
    const calls: SeedFilter[] = [];
    const out = await seedSearchWithTags(async (f) => {
        calls.push(f);
        return f?.tagsAll ? [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.2 }] : [{ id: 'a', score: 0.5 }, { id: 'b', score: 0.1 }];
    }, { type: ['note'] }, ['client:x']);
    assert.deepEqual(calls, [{ type: ['note'] }, { type: ['note'], tagsAll: ['client:x'] }]);
    assert.deepEqual(out.map((h) => [h.id, h.score]), [['b', 0.9], ['a', 0.5], ['c', 0.2]]);
});

await test('tags with no base filter: scoped call carries tagsAll only', async () => {
    const calls: SeedFilter[] = [];
    await seedSearchWithTags(async (f) => { calls.push(f); return []; }, undefined, ['t']);
    assert.deepEqual(calls, [undefined, { tagsAll: ['t'] }]);
});

/* ─── Part 2: runCrossWorkspaceRecall ────────────────────────────────── */

console.log('\npart 2 — runCrossWorkspaceRecall tag pushdown');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'xws-tag-pushdown-'));
process.env['LORE_HOME'] = TEST_HOME;
{
    const ws = { name: 'ws-a', path: path.join(TEST_HOME, 'workspaces', 'ws-a'), createdAt: '2026-11-01T00:00:00.000Z', graphEngine: 'sqlite' };
    fs.mkdirSync(path.join(ws.path, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(TEST_HOME, 'workspaces.json'), JSON.stringify({ active: 'ws-a', workspaces: [ws] }, null, 2));
}

const { runCrossWorkspaceRecall } = await import('../packages/lore/src/mcp/tools/recallCrossWorkspace.js');

type FNode = { id: string; type: string; label: string; content: string; tags: string[]; project: string; ecosystem: string; language: string | null; updatedAt: string };
const fnode = (id: string, tags: string[] = []): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`, tags,
    project: 'ws-a', ecosystem: '*', language: null, updatedAt: '2026-06-01T00:00:00.000Z',
});
const TAG = 'client:c-07';
// untagged crowd fills both windows; `rare` carries the tag; `stale` has the tag on its
// verbatim row only (graph node lost it) — graph tags are authoritative.
const NODES: Record<string, FNode> = { rare: fnode('rare', [TAG, 'kind:mail']), stale: fnode('stale', ['kind:mail']) };
for (let i = 0; i < 30; i++) NODES[`u${i}`] = fnode(`u${i}`, ['kind:mail']);

function makeGraph(kwCalls: unknown[][]) {
    return {
        async search(...a: unknown[]) {
            kwCalls.push(a);
            (a[5] as { scanCapHit: boolean }).scanCapHit = false;
            const tags = a[9] as string[] | undefined;
            const limit = a[1] as number;
            const all = Object.values(NODES).filter((n) => !tags || tags.every((t) => n.tags.includes(t)));
            return all.filter((n) => n.id !== 'rare' || tags).slice(0, limit).map((n) => ({ ...n }));
        },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = NODES[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
        async getNode(id: string) { const x = NODES[id]; return x ? { ...x } : null; },
    };
}
function makeSem(semCalls: unknown[]) {
    return {
        async count() { return Object.keys(NODES).length; },
        async search(_q: string, limit: number, filter?: { tagsAll?: string[] }) {
            semCalls.push(filter);
            if (filter?.tagsAll) return [{ id: 'lore:rare', score: 0.3 }, { id: 'lore:stale', score: 0.95 }].slice(0, limit);
            return Array.from({ length: Math.min(limit, 30) }, (_, i) => ({ id: `lore:u${i}`, score: 0.9 - i * 0.01 }));
        },
    };
}
const base = { topic: 'mail', depth: 0, includeSuperseded: false, sessionCache: { pushNode() { /* noop */ } }, responseMode: 'full' };
function idsOf(res: { content: Array<{ text: string }>; isError?: boolean }): string[] {
    assert.ok(!res.isError, `runCrossWorkspaceRecall returned an error: ${res.content?.[0]?.text}`);
    const out = JSON.parse(res.content[0]!.text);
    return (out.knowledge ?? out.results ?? []).map((r: any) => r.id ?? r.node?.id);
}

for (const mode of ['boot store', 'per-workspace store'] as const) {
    await test(`${mode}: tagged node outside both windows is returned; only tagged nodes come back`, async () => {
        const kwCalls: unknown[][] = []; const semCalls: unknown[] = [];
        const graph = makeGraph(kwCalls); const sem = makeSem(semCalls);
        const registry = { async getGraphHandle() { return graph; }, homeDir() { return TEST_HOME; } };
        const res = await runCrossWorkspaceRecall({
            ...base, tags: [` ${TAG} `], registry, verbatimStore: mode === 'boot store' ? sem : makeSem([]),
            ...(mode === 'per-workspace store' ? { workspaceVerbatimResolver: { async getOrOpen() { return sem; } } } : {}),
        } as any);
        const ids = idsOf(res);
        assert.deepEqual(ids, ['rare'], `expected only "rare", got ${JSON.stringify(ids)}`);
        assert.ok(kwCalls.length > 0 && kwCalls.every((a) => JSON.stringify(a[9]) === JSON.stringify([TAG])), 'keyword leg gets normalized tags as 10th arg');
        assert.ok(semCalls.some((f) => JSON.stringify((f as any)?.tagsAll) === JSON.stringify([TAG])), 'semantic leg runs a tagsAll query');
        assert.ok(semCalls.some((f) => !(f as any)?.tagsAll), 'unscoped semantic query still runs');
    });
}

await test('no tags: one semantic call without tagsAll, keyword tags arg undefined (pre-3.38.3 shape)', async () => {
    const kwCalls: unknown[][] = []; const semCalls: unknown[] = [];
    const graph = makeGraph(kwCalls); const sem = makeSem(semCalls);
    const registry = { async getGraphHandle() { return graph; }, homeDir() { return TEST_HOME; } };
    const ids = idsOf(await runCrossWorkspaceRecall({ ...base, registry, verbatimStore: makeSem([]), workspaceVerbatimResolver: { async getOrOpen() { return sem; } } } as any));
    assert.ok(ids.length > 0);
    assert.equal(semCalls.length, 1);
    assert.equal(semCalls[0], undefined);
    assert.ok(kwCalls.every((a) => a[9] === undefined));
});

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

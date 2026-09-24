#!/usr/bin/env tsx
/**
 * d5-review-gaps-unit.ts — D5 independent re-review coverage.
 *
 * Closes the gaps left after round 5:
 *  1. refillSeedSlots (recall/supersessionRecall.ts) — count, order,
 *     determinism, dedupe, superseded spillover resolution, admit gate.
 *  2. structured_query MCP tool — superseded hit REPLACED by its successor
 *     (keyword + verbatim-seed paths); restricted successor not leaked.
 *  3. Cross-workspace recall — restricted-scope successor not leaked.
 *  4. Re-save rule (runSupersessionValidation / hasExistingSupersessionState)
 *     — relaxes ONLY the missing-field check; prose/near-dup still fire;
 *     fails closed without queryEdges; existing targets count as listed.
 *  5. resolveSupersessionContext is read-only — never bootstraps a
 *     workspaces.json; unknown ws / corrupt file => host default.
 *  6. End-to-end on BOTH engine profiles (sqlite/sqlite and surreal/lance,
 *     selected via LORE_DEFAULT_GRAPH_ENGINE / LORE_DEFAULT_VECTOR_ENGINE on
 *     a fresh dataDir): near-dup refusal, successor replacement and
 *     `corrects` adjacency through createLore().recall().
 *
 * Run: npx tsx test/d5-review-gaps-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-review-gaps-'));
process.env['LORE_HOME'] = TEST_HOME;
delete process.env['LORE_SUPERSESSION_ENFORCE'];

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type FNode = {
    id: string; type: string; label: string; content: string; tags: string[];
    project: string; ecosystem: string; language: string | null; updatedAt: string;
    supersededBy?: string; status?: string; security_scopes?: string[];
};
const fnode = (id: string, over: Partial<FNode> = {}): FNode => ({
    id, type: 'note', label: `Label ${id}`, content: `content body for ${id}`,
    tags: [], project: 'ws', ecosystem: '*', language: null,
    updatedAt: '2026-06-01T00:00:00.000Z', ...over,
});
function fakeGraph(nodes: Record<string, FNode>, searchIds: string[] = []) {
    return {
        async search(_q: string, _l: number, _p: string, _e: string, _x: boolean, signals?: { scanCapHit: boolean }) {
            if (signals) signals.scanCapHit = false;
            return searchIds.map((id) => ({ ...nodes[id]! }));
        },
        async getNodesByIds(ids: string[]) {
            const m = new Map<string, FNode>();
            for (const id of ids) { const x = nodes[id]; if (x) m.set(id, { ...x }); }
            return m;
        },
        async getNode(id: string) { const x = nodes[id]; return x ? { ...x } : null; },
    };
}

const { refillSeedSlots } = await import('../packages/lore/src/recall/supersessionRecall.js');
const { runWithActor } = await import('../packages/lore/src/security/actorContext.js');
const { runSupersessionValidation, resolveSupersessionContext } = await import('../packages/lore/src/core/supersessionPolicy.js');

/* ─── 1. refillSeedSlots ─────────────────────────────────────────────── */
console.log('D5 re-review — refillSeedSlots');
{
    type RR = import('../packages/lore/src/recall/retrieve.js').RetrievalResult;
    const NODES: Record<string, FNode> = {
        a: fnode('a'), b: fnode('b'), s1: fnode('s1'), s2: fnode('s2', { supersededBy: 's2new' }),
        s2new: fnode('s2new'), s3: fnode('s3'), s4: fnode('s4'), s5: fnode('s5', { supersededBy: 'arch5' }), arch5: fnode('arch5', { status: 'archived' }),
    };
    const graph = fakeGraph(NODES) as never;
    const admit = ((n: { status?: string }) => n.status !== 'archived') as never;
    const seedResult = (id: string, score: number, depth = 0): [string, RR] =>
        [id, { node: NODES[id]! as never, score, matchedBy: ['semantic'], depth, source: depth === 0 ? 'seed' : 'traversal' } as RR];
    const prov = new Map([['s1', { matchedBy: new Set(['bm25'] as const), score: 0.4 }]]) as never;

    await test('refills depth-0 slots back to limit from spillover, in spillover rank order', async () => {
        // limit 4, but only 2 seeds survived replacement (+1 traversal hop, which must not count).
        const collected = new Map([seedResult('a', 0.9), seedResult('b', 0.8), seedResult('s4', 0.3, 1)]);
        const spill = [NODES.s1!, NODES.s3!, NODES.s4!] as never[];
        const out = await refillSeedSlots(collected, spill, 4, graph, admit, prov);
        const depth0 = [...out.values()].filter((r) => r.depth === 0).map((r) => r.node.id);
        assert.deepEqual(depth0, ['a', 'b', 's1', 's3'], 'exactly limit seeds, spillover appended in rank order');
        assert.equal(out.get('s4')!.depth, 1, 'a spillover node already present as a hop is not duplicated or re-labelled');
        assert.equal(out.get('s1')!.score, 0.4, 'seed provenance score carried over');
        assert.deepEqual(out.get('s1')!.matchedBy, ['bm25']);
        assert.equal(collected.size, 3, 'input map is not mutated');
    });
    await test('deterministic: same inputs → identical output order across runs', async () => {
        const mk = () => new Map([seedResult('a', 0.9)]);
        const spill = [NODES.s3!, NODES.s1!, NODES.b!] as never[];
        const r1 = [...(await refillSeedSlots(mk(), spill, 3, graph, admit, prov)).keys()];
        const r2 = [...(await refillSeedSlots(mk(), spill, 3, graph, admit, prov)).keys()];
        assert.deepEqual(r1, r2);
        assert.deepEqual(r1, ['a', 's3', 's1']);
    });
    // Spillover arrives pre-filtered (retrieve() runs applySeedFilters before
    // ranking), so `admit` gates only the successors refill fetches itself.
    await test('a superseded spillover candidate is resolved to its successor; one with no admissible successor skipped', async () => {
        const collected = new Map([seedResult('a', 0.9)]);
        const spill = [NODES.s5!, NODES.s2!, NODES.s3!] as never[];
        const out = await refillSeedSlots(collected, spill, 3, graph, admit, prov);
        const ids = [...out.keys()];
        assert.ok(!ids.includes('s2'), 'stale spillover never inserted');
        assert.deepEqual(ids, ['a', 's2new', 's3'], `got ${JSON.stringify(ids)}`);
        assert.equal(out.get('s2new')!.depth, 0);
    });
    await test('no-op when already at limit or spillover empty (same map returned)', async () => {
        const full = new Map([seedResult('a', 0.9), seedResult('b', 0.8)]);
        assert.equal(await refillSeedSlots(full, [NODES.s1!] as never[], 2, graph, admit, prov), full);
        const short = new Map([seedResult('a', 0.9)]);
        assert.equal(await refillSeedSlots(short, [], 5, graph, admit, prov), short);
    });
}

/* ─── 2. structured_query ─────────────────────────────────────────────── */
console.log('\nD5 re-review — structured_query successor replacement');
{
    const { registerStructuredQueryTool } = await import('../packages/lore/src/mcp/tools/search/structuredQueryTool.js');
    function run(nodes: Record<string, FNode>, searchIds: string[], verbatimIds: string[], args: Record<string, unknown>) {
        const graph = fakeGraph(nodes, searchIds);
        const deps = {
            store: {
                loreGraph: graph,
                storageClient: {
                    async verbatimCount() { return verbatimIds.length; },
                    async verbatimSearch() { return verbatimIds.map((id, i) => ({ id: `lore:${id}`, score: 1 - i / 10 })); },
                },
            },
            detectedScope: { workspace: 'default', ecosystem: '*' },
        } as never;
        let handler: ((a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | null = null;
        const fake = { tool(_n: string, _d: string, _s: unknown, h: typeof handler) { handler = h; } };
        registerStructuredQueryTool(fake as unknown as McpServer, deps);
        return handler!({ query: 'q', workspace: 'default', ...args }).then((res) => {
            assert.ok(!res.isError, res.content?.[0]?.text);
            return (JSON.parse(res.content[0]!.text).results as Array<{ id: string; content: string }>).map((r) => r.id);
        });
    }
    const NODES: Record<string, FNode> = {
        old: fnode('old', { supersededBy: 'mid' }), mid: fnode('mid', { supersededBy: 'new' }), new: fnode('new'),
        other: fnode('other'), gone: fnode('gone', { supersededBy: 'arch' }), arch: fnode('arch', { status: 'archived' }),
        secretOld: fnode('secretOld', { supersededBy: 'secretNew' }), secretNew: fnode('secretNew', { security_scopes: ['finance'] }),
    };
    await test('mode=search (keyword): superseded hit replaced by its chain-resolved live successor, same slot', async () => {
        assert.deepEqual(await run(NODES, ['old', 'other'], [], { mode: 'search' }), ['new', 'other']);
    });
    await test('mode=recall (verbatim seed): superseded seed replaced; successor already present collapses', async () => {
        assert.deepEqual(await run(NODES, [], ['old', 'other'], {}), ['new', 'other']);
        assert.deepEqual(await run(NODES, [], ['new', 'old'], {}), ['new']);
    });
    await test('no admissible successor (archived) → stale hit dropped, not shown', async () => {
        assert.deepEqual(await run(NODES, ['gone', 'other'], [], { mode: 'search' }), ['other']);
    });
    await test('restricted-scope successor is not leaked to an actor without that scope', async () => {
        const ids = await runWithActor({ portalUserId: 'u1', scopes: [] }, () => run(NODES, ['secretOld', 'other'], [], { mode: 'search' }));
        assert.ok(!ids.includes('secretNew'), `leaked restricted successor: ${JSON.stringify(ids)}`);
        const allowed = await runWithActor({ portalUserId: 'u2', scopes: ['finance'] }, () => run(NODES, ['secretOld'], [], { mode: 'search' }));
        assert.deepEqual(allowed, ['secretNew']);
    });
}

/* ─── 3. cross-workspace recall actor scope ──────────────────────────── */
console.log('\nD5 re-review — cross-workspace successor actor scope');
{
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-rg-xws-'));
    const wsPath = path.join(home, 'workspaces', 'ws-a');
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: 'ws-a', workspaces: [{ name: 'ws-a', path: wsPath, createdAt: '2026-06-15T00:00:00.000Z', graphEngine: 'surreal' }] }));
    const { runCrossWorkspaceRecall } = await import('../packages/lore/src/mcp/tools/recallCrossWorkspace.js');
    const NODES: Record<string, FNode> = {
        old: fnode('old', { supersededBy: 'new', project: 'ws-a' }),
        new: fnode('new', { project: 'ws-a', security_scopes: ['finance'] }),
    };
    const g = fakeGraph(NODES, ['old']);
    const call = () => runCrossWorkspaceRecall({
        topic: 'q', registry: { async getGraphHandle() { return g; }, homeDir() { return home; } },
        verbatimStore: { async count() { return 0; }, async search() { return []; } },
        sessionCache: { pushNode() {} }, responseMode: 'full',
    } as never).then((res: { content: Array<{ text: string }> }) =>
        (JSON.parse(res.content[0]!.text).knowledge ?? []).map((r: { id: string }) => r.id) as string[]);
    await test('restricted successor withheld from a no-scope actor; visible to a scoped one', async () => {
        const denied = await runWithActor({ portalUserId: 'u1', scopes: [] }, call);
        assert.ok(!denied.includes('new') && !denied.includes('old'), `got ${JSON.stringify(denied)}`);
        const ok = await runWithActor({ portalUserId: 'u2', scopes: ['finance'] }, call);
        assert.deepEqual(ok, ['new']);
    });
    fs.rmSync(home, { recursive: true, force: true });
}

/* ─── 4. re-save rule ────────────────────────────────────────────────── */
console.log('\nD5 re-review — re-save rule (hasExistingSupersessionState)');
{
    const enforce = { enforce: true };
    const existing = new Set(['dec-1', 'target-a']);
    const graphWithEdges = (edges: string[]): never => ({
        async getNode(id: string) { return existing.has(id) ? { id } : null; },
        async queryEdges(q: { source?: string }) { return q.source === 'dec-1' ? edges.map((t) => ({ sourceId: 'dec-1', targetId: t, relation: 'supersedes' })) : []; },
    }) as never;
    const base = { supersessionPolicy: enforce, findSupersessionDuplicate: undefined, force: false, supersedes: undefined };
    const decision = (content: string) => ({ type: 'decision', label: 'L', content });

    await test('re-save of a node with recorded supersedes edges may omit the field', async () => {
        const r = await runSupersessionValidation({ ...base, id: 'dec-1', nodeData: decision('edited body'), targetGraph: graphWithEdges(['target-a']) });
        assert.equal(r.ok, true, JSON.stringify(r));
    });
    await test('a NEW node (or existing without edges) still must declare the field', async () => {
        const r1 = await runSupersessionValidation({ ...base, id: 'brand-new', nodeData: decision('x'), targetGraph: graphWithEdges(['target-a']) });
        assert.ok(!r1.ok && r1.code === 'missing_supersedes_field');
        const r2 = await runSupersessionValidation({ ...base, id: 'dec-1', nodeData: decision('x'), targetGraph: graphWithEdges([]) });
        assert.ok(!r2.ok && r2.code === 'missing_supersedes_field');
    });
    await test('fails CLOSED without queryEdges or when the edge read throws', async () => {
        const r1 = await runSupersessionValidation({ ...base, id: 'dec-1', nodeData: decision('x'), targetGraph: { async getNode() { return { id: 'dec-1' }; } } as never });
        assert.ok(!r1.ok && r1.code === 'missing_supersedes_field');
        const r2 = await runSupersessionValidation({ ...base, id: 'dec-1', nodeData: decision('x'), targetGraph: { async getNode() { return { id: 'dec-1' }; }, async queryEdges() { throw new Error('boom'); } } as never });
        assert.ok(!r2.ok && r2.code === 'missing_supersedes_field');
    });
    await test('re-save cannot smuggle a NEW prose claim; an already-recorded target counts as listed', async () => {
        const g = graphWithEdges(['target-a']);
        const newClaim = await runSupersessionValidation({ ...base, id: 'dec-1', nodeData: decision('now SUPERSEDES other-99'), targetGraph: g });
        assert.ok(!newClaim.ok && newClaim.code === 'prose_supersedes_mismatch', JSON.stringify(newClaim));
        const unchanged = await runSupersessionValidation({ ...base, id: 'dec-1', nodeData: decision('SUPERSEDES target-a (typo fixed)'), targetGraph: g });
        assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
    });
    await test('re-save still runs the near-duplicate check', async () => {
        const r = await runSupersessionValidation({
            ...base, id: 'dec-1', nodeData: decision('x'), targetGraph: graphWithEdges(['target-a']),
            findSupersessionDuplicate: async () => ({ hit: { id: 'dup-9', score: 0.99 } }),
        });
        assert.ok(!r.ok && r.code === 'unlisted_near_duplicate', JSON.stringify(r));
    });
}

/* ─── 5. resolveSupersessionContext is read-only ─────────────────────── */
console.log('\nD5 re-review — policy resolution never bootstraps a registry');
{
    const ctx = (homeDir: string, hostDefaultEnforce?: boolean) =>
        resolveSupersessionContext({ workspace: 'default', targetGraph: {}, bootGraph: {}, homeDir, hostDefaultEnforce }).policy;
    await test('empty home: host default, and NO workspaces.json is written', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-rg-empty-'));
        const inner = path.join(home, 'never-created');
        assert.equal(ctx(inner).enforce, false);
        assert.equal(ctx(inner, true).enforce, true);
        assert.equal(fs.existsSync(inner), false, 'home dir must not be created');
        assert.equal(fs.existsSync(path.join(home, 'workspaces.json')), false);
        fs.rmSync(home, { recursive: true, force: true });
    });
    await test('unknown workspace / corrupt file → host default; registered entry honoured', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-rg-reg-'));
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: 'other', workspaces: [{ name: 'other', path: home, createdAt: 'x' }] }));
        assert.equal(ctx(home, true).enforce, true, 'unknown ws → host default');
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: 'default', workspaces: [{ name: 'default', path: home, createdAt: 'x', supersessionPolicy: { enforce: true } }] }));
        assert.equal(ctx(home, false).enforce, true, 'explicit policy beats host default');
        fs.writeFileSync(path.join(home, 'workspaces.json'), '{not json');
        assert.equal(ctx(home).enforce, false, 'corrupt → host default, no throw');
        fs.rmSync(home, { recursive: true, force: true });
    });
}

/* ─── 6. end-to-end on both engine profiles ──────────────────────────── */
class DetEmbedProvider {
    readonly dimension = 8; readonly modelId = 'd5-review-gaps-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(t: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % this.dimension] += t.charCodeAt(i) / 128;
        const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / n);
    }
    async embed(t: string) { return this.vec(t); } async embedQuery(t: string) { return this.vec(t); } async embedDocument(t: string) { return this.vec(t); }
}
const { createLore } = await import('../packages/lore/src/index.js');
for (const profile of [{ graph: 'sqlite', vector: 'sqlite' }, { graph: 'surreal', vector: 'lance' }] as const) {
    console.log(`\nD5 re-review — e2e on ${profile.graph}/${profile.vector}`);
    await test(`${profile.graph}/${profile.vector}: near-dup refused; superseded replaced by successor; corrects target adjacent`, async () => {
        if (profile.graph === 'surreal') { process.env['LORE_DEFAULT_GRAPH_ENGINE'] = 'surreal'; process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance'; }
        else { delete process.env['LORE_DEFAULT_GRAPH_ENGINE']; delete process.env['LORE_DEFAULT_VECTOR_ENGINE']; }
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `d5-rg-e2e-${profile.graph}-`));
        const lore = await createLore({ dataDir, deploymentMode: 'embedded', supersessionEnforce: true, embeddingProvider: new DetEmbedProvider() });
        try {
            const ws = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspaces.json'), 'utf8')).workspaces[0];
            assert.equal(ws.graphEngine, profile.graph); assert.equal(ws.vectorEngine, profile.vector);
            const up = (id: string, type: string, label: string, content: string, supersedes: string[] = [], force = true) =>
                lore.nodeUpsert({ id, workspace: 'default', ecosystem: '*', nodeData: { type, label, content }, supersedes, force });
            const ORIGINAL = 'the team decided to migrate the build pipeline to esbuild for faster CI runs';
            assert.equal((await up('old-dec', 'decision', 'Zebrafinch build tool', ORIGINAL, [], false)).ok, true);
            await lore.awaitEmbeds();
            let dup: Awaited<ReturnType<typeof up>> | undefined;
            for (let i = 0; i < 60; i++) {
                dup = await up(`dup-${i}`, 'decision', 'Zebrafinch build tool', ORIGINAL.slice(0, -1), [], false);
                if (!dup.ok && dup.code === 'unlisted_near_duplicate') break;
                await new Promise((r) => setTimeout(r, 100));
            }
            assert.ok(dup && !dup.ok && dup.code === 'unlisted_near_duplicate', `near-dup: ${JSON.stringify(dup)}`);
            assert.equal((await up('new-dec', 'decision', 'Zebrafinch build tool v2', 'switch to rolldown instead', ['old-dec'])).ok, true);
            assert.equal((await up('wrong-note', 'note', 'Quokka latency figure', 'quokka p95 is 900ms'))
                .ok, true);
            assert.equal((await up('fix-note', 'note', 'Pangolin correction', 'pangolin: the real p95 is 90ms'))
                .ok, true);
            const g = await (lore as unknown as { _daemon: { getGraphRegistry(): { getGraphHandle(w: string): Promise<{ addEdge(e: unknown): Promise<void> }> } } })._daemon.getGraphRegistry().getGraphHandle('default');
            await g.addEdge({ sourceId: 'fix-note', targetId: 'wrong-note', relation: 'corrects' });
            await lore.awaitEmbeds();
            const ids = async (topic: string) => ((await lore.recall(topic, { workspace: 'default', searchMode: 'keyword', mode: 'full', depth: 0, max: 5 })) as { knowledge: Array<{ id: string }> }).knowledge.map((k) => k.id);
            const sup = await ids('Zebrafinch');
            assert.ok(sup.includes('new-dec') && !sup.includes('old-dec'), `successor replacement: ${JSON.stringify(sup)}`);
            // integ/d-all (D4 x D5): the non-matching corrects target rides in
            // `related` (relation 'corrects', via the correction), not `knowledge`.
            const corOut = (await lore.recall('Pangolin', { workspace: 'default', searchMode: 'keyword', mode: 'full', depth: 0, max: 5 })) as { knowledge: Array<{ id: string }>; related?: Array<{ id: string; via: string; relation: string }> };
            const cor = corOut.knowledge.map((k) => k.id);
            assert.equal(cor[0], 'fix-note', `corrects: correction ranked: ${JSON.stringify(cor)}`);
            assert.ok(!cor.includes('wrong-note'), `corrects: target not ranked: ${JSON.stringify(cor)}`);
            assert.deepEqual((corOut.related ?? []).filter((r) => r.relation === 'corrects').map((r) => [r.id, r.via]), [['wrong-note', 'fix-note']], `corrects related: ${JSON.stringify(corOut.related)}`);
        } finally {
            await lore.dispose();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
}
delete process.env['LORE_DEFAULT_GRAPH_ENGINE']; delete process.env['LORE_DEFAULT_VECTOR_ENGINE'];

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

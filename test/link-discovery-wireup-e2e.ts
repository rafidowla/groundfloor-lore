#!/usr/bin/env tsx
/**
 * test/link-discovery-wireup-e2e.ts - Links Loop D (discovery + relation typing) through the PUBLIC entry point:
 * `createLore({ linkDiscovery })` on the real SqliteGraph + SqliteVerbatimStore (deterministic embedder), plus the
 * production factory (`createLinkService`) on the real PostgresGraph + PostgresVerbatimStore when LORE_PG_URL is set.
 *
 *   flag off          no option + no env => no link service, no link-queue file, zero edges, zero proposals
 *   sqlite wire-up    nodes written with NO arrival linking; reopened with linkDiscovery => discovery adds the inferred
 *                     link (provenance), raises a supersedes proposal for the near-duplicate pair, nothing for the
 *                     autolink:false node, caller edge untouched; recall's notion of "current" is unchanged until accept
 *   timer path        the background sweep (intervalMs) does the same with no explicit runDiscovery call
 *   postgres wire-up  createLinkService(...) with real Postgres stores, same assertions
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 [LORE_PG_URL=...] npx tsx test/link-discovery-wireup-e2e.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

for (const k of Object.keys(process.env)) if (k.startsWith('LORE_LINK_') || k.startsWith('LORE_INGEST_')) delete process.env[k];

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'discovery-wireup-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += ((text.charCodeAt(i) * 31) % 17) - 8; // centred, so unrelated texts are near-orthogonal
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { return ts.map((t) => this.vec(t)); }
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-disc-wire-'));
function findFile(dir: string, name: string): string | null {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; } else if (e.name === name) return p;
    }
    return null;
}
const node = (id: string, content: string, label = id) => ({
    id, workspace: 'default', ecosystem: '*',
    nodeData: { id, type: 'note', label, content, project: 'default', ecosystem: '*' },
});
const BASE = 'the quarterly lease renewal for the downtown office building was approved by the board';
const OTHER = 'zebra crossing safety audit report for the northern ring road junction upgrade programme';

async function open(dataDir: string, extra: Record<string, unknown> = {}): Promise<any> {
    const { createLore } = await import('../packages/lore/src/index.js');
    return createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider(), modelServer: false, ...extra } as never);
}
async function edges(lore: any, relation: string): Promise<any[]> {
    return lore.store.loreGraph.queryEdges({ limit: 1000, offset: 0, relation, includeProvenance: true });
}
const keys = (es: any[]): string[] => es.map((e) => `${e.sourceId}|${e.targetId}`).sort();

/** Phase 1: write the old nodes with NO arrival linking. */
async function seedOld(dir: string, withService = true): Promise<void> {
    // Discovery is on but its sweep never fires (huge interval) and arrival linking is off: the service exists so the
    // durable autolink:false intent is recorded at write time (without any link service there is nowhere to record it).
    const lore = await open(dir, withService ? { linkDiscovery: { intervalMs: 86_400_000 }, linkOnArrival: false } : {});
    try {
        if (withService) assert.equal(lore.store.linkService.stats().queue.ready, 0, 'arrival linking is off: nothing queued');
        await lore.nodeUpsert(node('y1', `${BASE} variant 1`));
        await sleep(15);
        await lore.nodeUpsert(node('y2', `${BASE} variant 2`));
        await sleep(15);
        await lore.nodeUpsert(node('z1', OTHER));
        const r = await lore.bulkIngest([node('y3', `${BASE} variant 3`)] as any, { embed: 'sync', autolink: false });
        assert.equal(r.succeeded, 1);
        await lore.awaitEmbeds?.();
        await lore.store.loreGraph.addEdge({ sourceId: 'y1', targetId: 'z1', relation: 'related_to', confidence: 'extracted', confidenceScore: 1 });
        assert.deepEqual(keys(await edges(lore, 'semantic_neighbor')), [], 'seeded with no arrival links');
    } finally { await lore.dispose(); }
}

console.log('\nlink discovery wire-up e2e\n');

await test('flag off: no option and no env => no link service, no queue file, no edges, no proposals', async () => {
    const dir = tmp();
    await seedOld(dir, false);
    const lore = await open(dir);
    try {
        assert.equal(lore.store.linkService ?? null, null);
        assert.equal(findFile(dir, 'link-queue.sqlite'), null, 'no link-queue.sqlite');
        assert.deepEqual(keys(await edges(lore, 'semantic_neighbor')), []);
    } finally { await lore.dispose(); }
    process.env.LORE_LINK_DISCOVERY = '1';
    try {
        const off = await open(dir, { linkDiscovery: false });
        try { assert.equal(off.store.linkService ?? null, null, 'explicit false beats the env flag'); } finally { await off.dispose(); }
    } finally { delete process.env.LORE_LINK_DISCOVERY; }
});

await test('createLore({ linkDiscovery }) on SQLite: inferred link + provenance, supersedes proposal, opted-out node untouched', async () => {
    const dir = tmp();
    await seedOld(dir);
    const lore = await open(dir, { linkDiscovery: { intervalMs: 3_600_000, yieldMs: 0 }, linkOnArrival: false });
    try {
        const svc = lore.store.linkService;
        assert.ok(svc && svc.hasDiscovery, 'discovery is wired by the option');
        const run = await svc.runDiscovery('default');
        assert.ok(run, 'a run happened');
        const links = await edges(lore, 'semantic_neighbor');
        assert.deepEqual(keys(links), ['y1|y2'], 'old-to-old pair linked; y3 (autolink:false) and z1 (dissimilar) untouched');
        const prov = (links[0] as any).provenance;
        assert.ok(prov, 'edge carries provenance');
        assert.equal(prov.origin, 'link_on_arrival');
        assert.ok(prov.policyVersion ?? prov.policy_version, 'policy version stamped');
        const caller = await edges(lore, 'related_to');
        assert.deepEqual(keys(caller), ['y1|z1'], 'caller edge untouched');
        const props = svc.listProposals('default');
        assert.equal(props.length, 1, `one proposal for the near-duplicate pair: ${JSON.stringify(props)}`);
        assert.equal(props[0].kind, 'supersedes');
        assert.ok([props[0].fromId, props[0].toId].every((i: string) => i === 'y1' || i === 'y2'));
        assert.ok(!props.some((p: any) => [p.fromId, p.toId].includes('y3')), 'nothing proposed for the autolink:false node');
        const n = await lore.store.loreGraph.getNode(props[0].toId);
        assert.ok(!(n as any)?.supersededBy, 'nothing is superseded before acceptance');
        const st = svc.stats();
        assert.ok(st.discovery && st.discovery.linksAdded >= 1 && st.discovery.proposalsRaised === 1, JSON.stringify(st.discovery));
        // second run is idempotent
        await svc.runDiscovery('default');
        assert.deepEqual(keys(await edges(lore, 'semantic_neighbor')), ['y1|y2']);
        assert.equal(svc.listProposals('default').length, 1);
        // accept goes through the supersede path
        const out = await svc.acceptProposal('default', props[0].id, { by: 'wireup-test' });
        assert.equal((out as any).ok, true, JSON.stringify(out));
        const old = await lore.store.loreGraph.getNode(props[0].toId);
        assert.equal((old as any)?.supersededBy, props[0].fromId, 'accept superseded the older node');
    } finally { await lore.dispose(); }
});

await test('background timer sweep runs discovery with no explicit call', async () => {
    const dir = tmp();
    await seedOld(dir);
    const lore = await open(dir, { linkDiscovery: { intervalMs: 150, yieldMs: 0 }, linkOnArrival: false });
    try {
        let got: string[] = [];
        for (let i = 0; i < 60 && !got.length; i++) { await sleep(250); got = keys(await edges(lore, 'semantic_neighbor')); }
        assert.deepEqual(got, ['y1|y2'], 'the sweep found the pair');
    } finally { await lore.dispose(); }
});

await test('bad linkDiscovery values throw RangeError at construction', async () => {
    for (const bad of [{ maxNodes: 0 }, { supersedeSim: 2 }, { judge: { budgetPerRun: -1 } }]) {
        await assert.rejects(() => open(tmp(), { linkDiscovery: bad }), RangeError, JSON.stringify(bad));
    }
});

const pgUrl = process.env.LORE_PG_URL;
if (pgUrl) {
    await test('Postgres: createLinkService + real PostgresGraph/PostgresVerbatimStore => same discovery outcome', async () => {
        const { createGatePool, cleanupGateWorkspaces, closeGatePool, stampGateManifest } = await import('./helpers/testPostgres.js') as any;
        const { PostgresGraph } = await import('../packages/lore/src/engines/postgres/postgresGraph.js');
        const { PostgresVerbatimStore } = await import('../packages/lore/src/engines/postgres/postgresVerbatimStore.js');
        const { createLinkService } = await import('../packages/lore/src/link/createLinkService.js');
        const pool = await createGatePool('disc-wireup');
        assert.ok(pool, 'pool');
        await cleanupGateWorkspaces(pool);
        const ws = `pg-gate-disc-wire-${process.pid}`;
        const dir = tmp();
        try {
            const base = tmp();
            await stampGateManifest(base, 'discovery-wireup-det', 4); // the shared gate database fixes one vector width for every suite: 4
            class NoEmbed { readonly dimension = 4; readonly modelId = 'discovery-wireup-det'; async initialize() {} async embed() { return [0, 0, 0, 0]; } async embedQuery() { return [0, 0, 0, 0]; } async embedDocument() { return [0, 0, 0, 0]; } async embedDocumentBatch(t: string[]) { return t.map(() => [0, 0, 0, 0]); } }
            const verbatim = new PostgresVerbatimStore(base, pool, ws, new NoEmbed() as never);
            await verbatim.initialize();
            const graph = new PostgresGraph(ws, pool);
            await graph.initialize();
            const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)];
            const row = (id: string, deg: number, updatedAt: string) => ({ id: `lore:${id}`, label: id, text: `content ${id}`, type: 'note', project: 'p', ecosystem: '*', security_scopes: [], vector: [...at(deg), 0, 0], contentHash: `h-${id}`, updatedAt });
            const mk = (id: string, updatedAt: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}', updatedAt }) as never;
            const t0 = Date.now();
            const iso = (ms: number) => new Date(t0 - ms).toISOString();
            for (const [id, deg, age] of [['y1', 0, 3000], ['y2', 2, 2000], ['y3', 1, 1000], ['z1', 80, 500]] as const) { await graph.upsertNode(mk(id, iso(age))); await sleep(15); }
            await (verbatim as any).bulkAddPrebuiltRows([row('y1', 0, iso(3000)), row('y2', 2, iso(2000)), row('y3', 1, iso(1000)), row('z1', 80, iso(500))]);
            await graph.setLinkOptOuts(['y3'], true);
            await graph.addEdge({ sourceId: 'y1', targetId: 'z1', relation: 'related_to', confidence: 'extracted', confidenceScore: 1 });

            const mkSvc = (discovery: boolean | undefined) => createLinkService({
                loreDir: dir, enabled: false, ...(discovery === undefined ? {} : { discovery }),
                resolveHandles: async () => ({ graph, verbatim }) as never,
                embeddingProvider: { modelId: 'discovery-wireup-det', dtype: 'fp32' },
                config: undefined,
            } as never);
            const off = mkSvc(undefined);
            assert.equal(off, null, 'flag off => no service');
            const svc: any = mkSvc(true);
            assert.ok(svc && svc.hasDiscovery);
            try {
                await svc.runDiscovery(ws);
                const links = await graph.queryEdges({ limit: 100, offset: 0, relation: 'semantic_neighbor', includeProvenance: true });
                assert.deepEqual(keys(links), ['y1|y2']);
                assert.equal(links[0].provenance?.origin, 'link_on_arrival');
                assert.deepEqual(keys(await graph.queryEdges({ limit: 100, offset: 0, relation: 'related_to' })), ['y1|z1']);
                const props = svc.listProposals(ws);
                assert.ok(props.every((p: any) => ![p.fromId, p.toId].includes('y3')), 'nothing for the opted-out node');
                assert.ok(props.some((p: any) => p.kind === 'supersedes' && [p.fromId, p.toId].sort().join() === 'y1,y2'), `supersedes proposal for the near-duplicate pair: ${JSON.stringify(props)}`);
            } finally { await svc.close?.(); }
        } finally { await cleanupGateWorkspaces(pool); await closeGatePool(pool); }
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

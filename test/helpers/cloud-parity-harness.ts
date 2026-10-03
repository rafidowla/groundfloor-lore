/**
 * cloud-parity-harness.ts — runs ONE scenario list against embedded local storage
 * (SurrealGraph/SqliteGraph + VerbatimStore in a temp dir) and against the mock
 * Dataplane (DataplaneGraph + DataplaneVectorStore over HTTP), then compares the
 * NORMALISED outputs. Cloud parity Slices B/C append scenarios to `SCENARIOS`.
 *
 * Rules
 * - A scenario returns plain, JSON-able data. Project away anything run-specific
 *   (generated timestamps) inside the scenario: `normalise` deliberately ignores ONLY
 *   the two intentionally-local-only fields `lastAccessedAt` and `last_retrieved_at`
 *   (types.ts "never synced"). It also sorts object keys; arrays keep their order, so a
 *   scenario that does not guarantee an order must sort before returning.
 * - Both sides run under the same Lore workspace (bound via ALS on the cloud side; local
 *   storage is single-workspace by construction).
 * - Known gaps are listed in KNOWN_GAPS_SLICE_B and SKIPPED here (reported, not run). When
 *   Slice B lands a gap, it deletes the entry and appends a real scenario to SCENARIOS.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTestGraphEngine } from './testGraphEngine.js';
import { makeVerbatimStore } from './testVerbatimStore.js';
import { startCloudFixture, bagOfWordsEmbedder, type CloudFixture } from './cloud-stores-fixture.js';
import type { GraphProvider, EmbeddingProvider } from '../../packages/lore/src/providers/types.js';
import type { VerbatimStoreApi } from '../../packages/lore/src/engines/verbatimStoreApi.js';
import type { DataplaneVectorStore } from '../../packages/lore/src/engines/dataplaneVectorStore.js';

export const PARITY_WORKSPACE = 'parity-ws';
/** The only fields the comparison ignores (local-only, never synced). */
export const IGNORED_FIELDS = ['lastAccessedAt', 'last_retrieved_at'] as const;

/** What a scenario drives: the graph contract and the verbatim (vector) contract. */
export interface ParityCtx {
    backend: 'local' | 'cloud';
    graph: GraphProvider;
    vector: VerbatimStoreApi | DataplaneVectorStore;
}
export interface ParityScenario {
    name: string;
    run: (ctx: ParityCtx) => Promise<unknown>;
}

/**
 * Gaps Slice B closed (all seven entries were replaced by scenarios below). Kept as an empty export because
 * test/cloud-parity-unit.ts imports it; a future slice may list new gaps here (SKIPPED, reported, not run).
 */
export const KNOWN_GAPS_SLICE_B: readonly string[] = [];

/**
 * Divergences found by this harness that are NOT Slice B gaps and NOT cloud bugs: skipped, reported.
 * (Found in A2; owners noted so nobody "fixes" the cloud side to match a local defect.)
 */
export const KNOWN_DIVERGENCES: readonly string[] = [
    'traverse(id, depth, relation): the embedded SurrealGraph.traverse ignores `relation` (returns every neighbour); cloud applies the contracted exact-match filter. Local defect.',
    'count() after delete(): local VerbatimStore counts tombstone rows (3 stored, 1 deleted -> 4); cloud counts live rows only (2).',
    'LoreNode evidence / anchors / classification_expires_at / success_count / failure_count / partial_count / confirmation_score: the embedded SurrealGraph.upsertNode drops these on write (they round-trip on cloud, see cloud-node-shape-unit). Cloud is a superset; the node-shape scenario compares only what local round-trips.',
];

const NODE_FIELDS = ['id', 'type', 'label', 'content', 'project', 'ecosystem'] as const;
type Rec = Record<string, unknown>;
/** Stable projection of a LoreNode (no generated timestamps). */
export function pickNode(n: Rec | null | undefined): Rec | null {
    if (!n) return null;
    const out: Rec = {};
    for (const k of NODE_FIELDS) out[k] = n[k];
    out['tags'] = Array.isArray(n['tags']) ? [...(n['tags'] as string[])].sort() : n['tags'];
    return out;
}
const mkNode = (id: string, type: string, label: string, content: string, project = 'proj', tags: string[] = []) =>
    ({ id, type, label, content, tags, project, ecosystem: '*', metadata: '{}' });

/** Node fields Slice B round-trips on BOTH backends (local drops evidence/anchors/etc., see KNOWN_DIVERGENCES). */
const FULL_FIELDS = ['validFrom', 'validUntil', 'status', 'classification', 'ephemeral', 'ttl_ms'] as const;
function pickFull(n: Rec | null): Rec | null {
    if (!n) return null;
    const out: Rec = { ...pickNode(n) };
    for (const k of FULL_FIELDS) out[k] = n[k] ?? null;
    out['metadata'] = typeof n['metadata'] === 'string' ? JSON.parse(n['metadata'] as string) : n['metadata'];
    return out;
}

/** Scenarios that hold on both backends TODAY. Slices B/C append here. */
export const SCENARIOS: ParityScenario[] = [
    {
        name: 'node upsert / getNode / update-in-place',
        run: async ({ graph }) => {
            await graph.upsertNode(mkNode('n1', 'note', 'First note', 'alpha content', 'proj', ['x', 'y']) as never);
            const first = pickNode(await graph.getNode('n1') as never);
            await graph.upsertNode(mkNode('n1', 'note', 'First note v2', 'alpha content changed', 'proj', ['x']) as never);
            const second = pickNode(await graph.getNode('n1') as never);
            return { first, second, missing: await graph.getNode('does-not-exist') };
        },
    },
    {
        name: 'listNodes by type / project / tag',
        run: async ({ graph }) => {
            await graph.upsertNode(mkNode('l1', 'decision', 'Use postgres', 'db choice', 'p-a', ['db']) as never);
            await graph.upsertNode(mkNode('l2', 'decision', 'Use redis', 'cache choice', 'p-b', ['cache']) as never);
            await graph.upsertNode(mkNode('l3', 'note', 'Meeting', 'weekly sync', 'p-a', ['db']) as never);
            const ids = (ns: Rec[]) => ns.map((n) => n['id'] as string).sort();
            return {
                decisions: ids(await graph.listNodes('decision') as never),
                pa: ids(await graph.listNodes(undefined, undefined, 'p-a') as never),
                dbTag: ids(await graph.listNodes(undefined, 'db') as never),
            };
        },
    },
    {
        name: 'graph search matches label/content case-insensitively',
        run: async ({ graph }) => {
            await graph.upsertNode(mkNode('s1', 'note', 'Kubernetes rollout', 'deploy plan', 'p') as never);
            await graph.upsertNode(mkNode('s2', 'note', 'Other', 'the KUBERNETES cluster', 'p') as never);
            await graph.upsertNode(mkNode('s3', 'note', 'Unrelated', 'nothing here', 'p') as never);
            const r = await graph.search('kubernetes', 10) as never as Rec[];
            return r.map((n) => n['id'] as string).sort();
        },
    },
    {
        name: 'edges: addEdge / queryEdges / traverse depth',
        run: async ({ graph }) => {
            for (const id of ['e1', 'e2', 'e3', 'e4']) await graph.upsertNode(mkNode(id, 'note', id, `content ${id}`) as never);
            await graph.addEdge({ sourceId: 'e1', targetId: 'e2', relation: 'links' } as never);
            await graph.addEdge({ sourceId: 'e2', targetId: 'e3', relation: 'links' } as never);
            await graph.addEdge({ sourceId: 'e2', targetId: 'e4', relation: 'blocks' } as never);
            const edges = (await (graph as unknown as { queryEdges(q: object): Promise<Rec[]> }).queryEdges({ source: 'e2', limit: 50, offset: 0 }))
                .map((e) => `${e['sourceId']}-${e['relation']}->${e['targetId']}`).sort();
            const tr = (rs: Array<{ node: Rec; depth: number }>) => rs.map((r) => `${r.node['id']}@${r.depth}`).sort();
            return {
                edges,
                depth2: tr(await graph.traverse('e1', 2) as never),
                depth1: tr(await graph.traverse('e1', 1) as never),
            };
        },
    },
    {
        name: 'deleteNode then getNode is null; second delete is not a crash',
        run: async ({ graph }) => {
            await graph.upsertNode(mkNode('d1', 'note', 'to delete', 'bye') as never);
            const existed = await graph.getNode('d1') !== null;
            await graph.deleteNode('d1');
            return { existed, after: await graph.getNode('d1') };
        },
    },
    {
        name: 'verbatim store / search / idempotent re-store / count (single workspace)',
        run: async ({ vector }) => {
            const v = vector as VerbatimStoreApi;
            await v.store({ id: 'v1', text: 'apples and oranges are fruit', metadata: { type: 'note', project: 'p' } } as never);
            await v.store({ id: 'v2', text: 'apples grow on trees', metadata: { type: 'note', project: 'p' } } as never);
            await v.store({ id: 'v3', text: 'quantum chromodynamics lecture', metadata: { type: 'note', project: 'p' } } as never);
            const hits = await v.search('apples', 10);
            const countBefore = await v.count();
            await v.store({ id: 'v1', text: 'apples and oranges are fruit', metadata: { type: 'note', project: 'p' } } as never); // idempotent
            const countIdem = await v.count();
            return {
                hasApples: hits.map((h) => h.id).filter((id) => id === 'v1' || id === 'v2').sort(),
                countBefore, countIdem,
            };
        },
    },
    {
        name: 'full node shape: validity window, metadata, status, classification, flags round-trip',
        run: async ({ graph }) => {
            const full = {
                ...mkNode('f1', 'decision', 'Full shape', 'every field set', 'proj', ['a', 'b']),
                metadata: JSON.stringify({ source: 'parity', n: 2 }),
                validFrom: '2026-01-01T00:00:00.000Z',
                validUntil: '2027-01-01T00:00:00.000Z',
                status: 'active',
                classification: 'internal',
                ephemeral: true,
                ttl_ms: 60000,
            };
            await graph.upsertNode(full as never);
            const n = await graph.getNode('f1') as never as Rec;
            // A later write that omits the optional fields must not clobber them (merge semantics).
            await graph.upsertNode({ ...mkNode('f1', 'decision', 'Full shape v2', 'every field set') } as never);
            const n2 = await graph.getNode('f1') as never as Rec;
            return { first: pickFull(n), after: pickFull(n2) };
        },
    },
    {
        name: 'supersede / unsupersede / stale flags',
        run: async ({ graph }) => {
            await graph.upsertNode(mkNode('o1', 'decision', 'old', 'old choice', 'p', ['t-stale']) as never);
            await graph.upsertNode(mkNode('o2', 'decision', 'new', 'new choice', 'p') as never);
            const g = graph as unknown as {
                supersedeNode(a: string, b: string, r?: string): Promise<{ ok: boolean; reason?: string }>;
                unsupersedeNode(id: string): Promise<boolean>;
                markStaleByIds(ids: string[]): Promise<number>;
            };
            const res = await g.supersedeNode('o1', 'o2', 'replaced');
            const sup = await graph.getNode('o1') as never as Rec;
            const again = await g.supersedeNode('o1', 'o2', 'replaced');
            const missing = await g.supersedeNode('o1', 'nope');
            const un = await g.unsupersedeNode('o1');
            const back = await graph.getNode('o1') as never as Rec;
            const stale = await g.markStaleByIds(['o2']);
            const o2 = await graph.getNode('o2') as never as Rec;
            return {
                res, again: again.ok, missing: missing.ok,
                superseded: { by: sup['supersededBy'], reason: sup['supersededReason'], hasAt: !!sup['supersededAt'] },
                un,
                restored: { by: back['supersededBy'] || null, reason: back['supersededReason'] || null, at: back['supersededAt'] || null },
                stale, o2Stale: o2['stale'] === true,
            };
        },
    },
    {
        name: 'edge confidence / confidenceScore round-trip, default tier, repeat write refreshes, missing endpoint rejected',
        run: async ({ graph }) => {
            for (const id of ['c1', 'c2', 'c3']) await graph.upsertNode(mkNode(id, 'note', id, `content ${id}`) as never);
            await graph.addEdge({ sourceId: 'c1', targetId: 'c2', relation: 'similar', confidence: 'inferred', confidenceScore: 0.42 } as never);
            await graph.addEdge({ sourceId: 'c1', targetId: 'c3', relation: 'links' } as never);
            await graph.addEdge({ sourceId: 'c1', targetId: 'c3', relation: 'links' } as never); // duplicate: one edge
            await graph.addEdge({ sourceId: 'c2', targetId: 'c3', relation: 'maybe', confidence: 'ambiguous', confidenceScore: 0.1 } as never);
            await graph.addEdge({ sourceId: 'c2', targetId: 'c3', relation: 'maybe', confidence: 'extracted', confidenceScore: 0.9 } as never); // refresh
            const q = graph as unknown as { queryEdges(o: object): Promise<Rec[]> };
            const edges = (await q.queryEdges({ limit: 50, offset: 0 }))
                .map((e) => `${e['sourceId']}-${e['relation']}->${e['targetId']}:${e['confidence']}:${e['confidenceScore']}`).sort();
            let rejected = 'accepted';
            try { await graph.addEdge({ sourceId: 'c1', targetId: 'ghost', relation: 'links' } as never); }
            catch (e) { rejected = /edge_endpoint_missing/.test((e as Error).message) ? 'edge_endpoint_missing' : (e as Error).message; }
            return { edges, rejected };
        },
    },
    {
        name: 'verbatim re-store: identical skipped, changed text re-hashed, content hash round-trips',
        run: async ({ vector }) => {
            const v = vector as VerbatimStoreApi;
            const meta = { type: 'note', label: 'r', tags: '', project: 'p', ecosystem: '*', updatedAt: '2026-09-01T00:00:00.000Z' };
            await v.store({ id: 'r1', text: 'first wording of the note', metadata: meta } as never);
            const h1 = (await v.getContentHashesByIds(['r1'])).get('r1');
            await v.store({ id: 'r1', text: 'first wording of the note', metadata: meta } as never);
            const h2 = (await v.getContentHashesByIds(['r1'])).get('r1');
            await v.store({ id: 'r1', text: 'second wording entirely', metadata: meta } as never);
            const h3 = (await v.getContentHashesByIds(['r1'])).get('r1');
            const row = await v.getById('r1');
            return {
                stable: h1 !== undefined && h1 === h2,
                changed: h3 !== undefined && h3 !== h1,
                text: row?.text, label: row?.label,
                missingHash: (await v.getContentHashesByIds(['nope'])).has('nope'),
            };
        },
    },
    {
        name: 'verbatim storeBatch: duplicates keep last, re-batch is idempotent, only changed rows differ',
        run: async ({ vector }) => {
            const v = vector as VerbatimStoreApi;
            const d = (id: string, text: string) => ({ id, text, metadata: { type: 'note', label: id, tags: '', project: 'p', ecosystem: '*', updatedAt: '2026-09-01T00:00:00.000Z' } });
            await v.storeBatch([d('b1', 'alpha text'), d('b2', 'beta text'), d('b1', 'alpha text final'), d('b3', 'gamma text')] as never);
            const ids = ['b1', 'b2', 'b3'];
            const first = await v.getContentHashesByIds(ids);
            const countFirst = await v.count();
            await v.storeBatch([d('b1', 'alpha text final'), d('b2', 'beta text'), d('b3', 'gamma text')] as never);
            const second = await v.getContentHashesByIds(ids);
            await v.storeBatch([d('b2', 'beta text revised')] as never);
            const third = await v.getContentHashesByIds(ids);
            const hits = (await v.search('alpha', 10)).map((h) => h.id);
            return {
                countFirst,
                idempotent: ids.every((i) => first.get(i) === second.get(i)),
                onlyB2Changed: ids.filter((i) => third.get(i) !== second.get(i)),
                b1Text: (await v.getById('b1'))?.text,
                alphaFound: hits.includes('b1'),
            };
        },
    },
    {
        name: 'verbatim history: a changed re-store snapshots, getHistory order, tombstone, includeHistory on/off',
        run: async ({ vector }) => {
            const v = vector as VerbatimStoreApi;
            const meta = { type: 'note', label: 'h', tags: '', project: 'p', ecosystem: '*', updatedAt: '2026-09-01T00:00:00.000Z' };
            await v.store({ id: 'h1', text: 'history alpha one', metadata: meta } as never);
            await v.store({ id: 'h1', text: 'history alpha two', metadata: meta } as never);
            await v.store({ id: 'h1', text: 'history alpha three', metadata: meta } as never);
            await v.store({ id: 'h2', text: 'history beta only', metadata: meta } as never);
            const countAfterChanges = await v.count();
            const hist = await v.getHistory('h1');
            const histShape = hist.map((h) => ({ text: h.text, isTombstone: h.isTombstone, isCanonical: h.isCanonical, rev: h.id.includes('#rev') }));
            const plain = (await v.search('history alpha', 10)).map((h) => h.id).sort();
            const withHistory = (await v.search('history alpha', 10, { includeHistory: true } as never)).map((h) => h.id.includes('#rev') ? 'rev' : h.id).sort();
            await v.tombstone('h2', 'no longer true');
            const tomb = await v.getHistory('h2');
            const afterTomb = (await v.search('history beta', 10)).map((h) => h.id);
            const tombIncluded = (await v.search('history beta', 10, { includeHistory: true } as never)).map((h) => h.id);
            return {
                countAfterChanges, histShape, plain, withHistory,
                tomb: tomb.map((h) => ({ tombstone: h.isTombstone, canonical: h.isCanonical, hasReason: h.text.includes('no longer true') })),
                afterTomb, tombIncluded,
            };
        },
    },
];

/** Drop ignored fields, sort object keys, keep array order. */
export function normalise(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(normalise);
    if (v && typeof v === 'object') {
        const out: Rec = {};
        for (const k of Object.keys(v as Rec).sort()) {
            if ((IGNORED_FIELDS as readonly string[]).includes(k)) continue;
            out[k] = normalise((v as Rec)[k]);
        }
        return out;
    }
    return v;
}

export interface ParityResult { name: string; ok: boolean; local?: unknown; cloud?: unknown; error?: string }
export interface ParityReport { results: ParityResult[]; skippedGaps: readonly string[]; divergences: readonly string[] }

interface Backend { ctx: ParityCtx; wrap: <T>(fn: () => Promise<T>) => Promise<T>; close: () => Promise<void> }

async function openLocal(embedder: EmbeddingProvider): Promise<Backend> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-parity-'));
    const graph = createTestGraphEngine(path.join(dir, 'graph'), { workspaceId: PARITY_WORKSPACE, cacheDisabled: true });
    await graph.initialize();
    const vector = makeVerbatimStore(path.join(dir, 'vec'), embedder);
    await vector.initialize();
    return {
        ctx: { backend: 'local', graph: graph as unknown as GraphProvider, vector },
        wrap: (fn) => fn(),
        close: async () => {
            try { await vector.close(); } catch { /* best effort */ }
            try { await (graph as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* best effort */ }
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

async function openCloud(): Promise<Backend & { fx: CloudFixture }> {
    const fx = await startCloudFixture();
    return {
        fx,
        ctx: { backend: 'cloud', graph: fx.graph as unknown as GraphProvider, vector: fx.vector },
        wrap: (fn) => fx.as(PARITY_WORKSPACE, fn),
        close: async () => { await fx.close(); },
    };
}

/**
 * Each scenario runs on a FRESH pair of backends (scenarios must not depend on each other),
 * against local first and cloud second, and the normalised outputs are compared.
 */
export async function runParity(scenarios: ParityScenario[] = SCENARIOS): Promise<ParityReport> {
    const results: ParityResult[] = [];
    for (const sc of scenarios) {
        const embedder = bagOfWordsEmbedder();
        const local = await openLocal(embedder);
        const cloud = await openCloud();
        try {
            const l = normalise(await local.wrap(() => sc.run(local.ctx)));
            const c = normalise(await cloud.wrap(() => sc.run(cloud.ctx)));
            const same = JSON.stringify(l) === JSON.stringify(c);
            results.push({ name: sc.name, ok: same, local: l, cloud: c });
        } catch (e) {
            results.push({ name: sc.name, ok: false, error: (e as Error).stack ?? String(e) });
        } finally {
            await local.close();
            await cloud.close();
        }
    }
    return { results, skippedGaps: KNOWN_GAPS_SLICE_B, divergences: KNOWN_DIVERGENCES };
}

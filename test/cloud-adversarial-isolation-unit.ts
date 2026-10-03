#!/usr/bin/env tsx
/**
 * cloud-adversarial-isolation-unit.ts — adversarial tenant-isolation suite for Dataplane cloud mode.
 *
 * Threat model: the attacker controls EVERY input of Lore workspace B (ids, filters, metadata, cursors,
 * workspace names, registry edits it can make through Lore's own API). Victims:
 *   - A: same org (Lore instance), same Dataplane workspace and credential, different Lore workspace id;
 *   - X: a different org (another Lore instance) on the same Dataplane workspace and credential, whose
 *        registry has the SAME workspace name AND the SAME permanent id as B (cloned registry).
 * Every attack asserts: (1) no victim canary / row key / version id appears in B's output (errors
 * included), (2) every victim row (all collections, raw mock tables) is byte-identical before and after.
 *
 * Stores are built through the production builder (`buildCloudStores`) on the engine-faithful mock,
 * in four engine shapes: full filters, SQLite filter-ignoring (+ vector filter ignored), and
 * /v1/transaction absent / fall-through. Engine-level side channels that Lore cannot close locally are
 * kept as SECURE assertions in KNOWN_OPEN (reported, not failed); an unexpected pass fails so the list
 * is pruned when the engine is fixed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockDataplane, type MockDataplane, type MockDataplaneOptions } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { bagOfWordsEmbedder, connectedClient, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import { testRegistry } from './helpers/workspace-registry.js';
import { buildCloudStores } from '../packages/lore/src/mcp/cloudStores.js';
import { dataplaneRowKey, scopeRowFields, DataplaneScopeError, type DataplaneScope } from '../packages/lore/src/engines/dataplaneScopeFilter.js';
import { TsSdkAdapter } from '../packages/lore/src/engines/tsSdkAdapter.js';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';
import { createWorkspace, deleteWorkspace, loadWorkspaces, registerWorkspaceAlias, renameWorkspace, writeControl } from '../packages/lore/src/config/workspaces.js';
import type { LoreWorkspaceRegistry } from '../packages/lore/src/engines/dataplaneScopeFilter.js';

let passed = 0;
let failed = 0;
let knownOpenHits = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${((e as Error).stack ?? (e as Error).message).slice(0, 4000)}`); failed++; }
}

/**
 * KNOWN_OPEN — engine-level leaks Lore cannot close on its own. The assertion inside stays the SECURE
 * one; a failing assertion is reported as known-open, any other error (a broken test) fails, and an
 * unexpected pass fails so the entry is removed once the engine is fixed.
 */
const KNOWN_OPEN: Record<string, { severity: string; ask: string }> = {
    'BM25-CROSS-TENANT-STATS': { severity: 'medium (inference)', ask: 'Dataplane A1: per-tenant/collection BM25 statistics (arangodb.rs:1529-1590 computes IDF/avgdl over the whole AppDocumentsSearch view)' },
    'SQLITE-QUERY-CROWD-OUT': { severity: 'low (availability + volume inference; no data crosses)', ask: 'Dataplane: SQLite connector filter + sort + offset push-down (sqlite.rs:186-245 runs SELECT id, data FROM t LIMIT n); until then B\'s query reads see only the first 1000 physical rows of the shared table and bulkList pages are filled by foreign rows' },
    'KEYWORD-CROWD-OUT': { severity: 'low-medium (inference)', ask: 'Dataplane A1/A2: a server-side filter on /search (keyword search has none, so LIMIT applies before Lore scopes)' },
};
async function knownOpen(key: keyof typeof KNOWN_OPEN, name: string, fn: () => Promise<void>): Promise<void> {
    const k = KNOWN_OPEN[key]!;
    try {
        await fn();
        console.error(`  ✗ KNOWN_OPEN[${key}] ${name}: the secure assertion now PASSES — remove it from KNOWN_OPEN`);
        failed++;
    } catch (e) {
        if (!(e instanceof assert.AssertionError)) { console.error(`  ✗ KNOWN_OPEN[${key}] ${name}: test error ${(e as Error).stack}`); failed++; return; }
        console.log(`  ⚠ KNOWN_OPEN[${key}] (${k.severity}) ${name}\n    leak: ${e.message.split('\n')[0]}\n    ask: ${k.ask}`);
        knownOpenHits++;
    }
}

/* ─── constants ─────────────────────────────────────────────────────────────────────────────── */

const DP_WS = 'dp-ws-adversarial';
const KEY = 'adversarial-key';
const ORG = 'org-home';
const ORG_X = 'org-victim-x';
const ID_A = 'id-victim-a-0001';
const ID_B = 'id-attacker-b-0002';
const CANARY_A = 'canaryaaa';
const CANARY_X = 'canaryxxx';
const ADV = 'lore_adv_coll'; // a portable collection driven through graph.getGraphContext().storage
const VICTIM_IDS = ['secret-1', 'secret-2', 'shared-id'];
const EPOCH = '1970-01-01T00:00:00.000Z';
const NAME_A = 'tenant-a';
const NAME_B = 'tenant-b';

const scope = (orgId: string, id: string, name: string): DataplaneScope => ({ orgId, dataplaneWorkspaceId: DP_WS, loreWorkspace: id, workspaceName: name });
const SCOPE_A = scope(ORG, ID_A, NAME_A);
const SCOPE_B = scope(ORG, ID_B, NAME_B);
const SCOPE_X = scope(ORG_X, ID_B, NAME_B);
const B_OWNER = `${ORG}|${ID_B}`;
const node = (id: string, label: string, content: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'note', label, content, tags: ['t'], project: 'proj', ecosystem: '*', metadata: '{}',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra,
}) as never;

/* ─── one world = one mock engine shape, three tenants on production-built stores ─────────────── */

type Stores = Awaited<ReturnType<typeof buildCloudStores>>;
interface Tenant { name: string; orgId: string; scope: DataplaneScope; s: Stores; registry: LoreWorkspaceRegistry; run<T>(fn: () => Promise<T>): Promise<T>; sync(): TsSdkAdapter; }
interface World {
    label: string; mock: MockDataplane; faults: { failColl: string | null };
    A: Tenant; B: Tenant; X: Tenant;
    victimSnap(): Record<string, string>;
    secrets(): string[];
    /** Every string the attacker has supplied so far (lower-cased). B's own rows echo them back, so they are not leaks. */
    supplied: string[];
    close(): Promise<void>;
}

/** Fault seam: any write (insert / bulkInsert / update / transaction) touching `failColl` throws. */
function faulty(c: ReturnType<typeof createMockDataplaneClient>, f: { failColl: string | null }): ReturnType<typeof createMockDataplaneClient> {
    const hit = (coll: string) => { if (f.failColl && coll === f.failColl) throw new Error(`injected fault on ${coll}`); };
    return {
        ...c,
        insert: async (t, n, r, k) => { hit(n); return c.insert(t, n, r, k); },
        bulkInsert: async (t, n, r, k) => { hit(n); return c.bulkInsert(t, n, r, k); },
        updateByQuery: async (t, n, fl, u, k) => { hit(n); return c.updateByQuery(t, n, fl, u, k); },
        transaction: async (t, ops, o) => {
            if (f.failColl && JSON.stringify(ops).includes(`"${f.failColl}"`)) throw Object.assign(new Error('injected transaction fault'), { statusCode: 500 });
            return c.transaction(t, ops, o);
        },
    };
}

async function startWorld(label: string, mockOpts: Omit<MockDataplaneOptions, 'apiKeys'>): Promise<World> {
    const mock = await startMockDataplane({ ...mockOpts, apiKeys: { [KEY]: DP_WS } });
    const faults = { failColl: null as string | null };
    const factory = (b: string, k: string) => faulty(createMockDataplaneClient(b, k), faults);
    const regHome = testRegistry().addWithId(NAME_A, ID_A).addWithId(NAME_B, ID_B);
    const regX = testRegistry().addWithId(NAME_B, ID_B); // cloned registry: same name AND id as the attacker
    const build = (orgId: string, workspaceRegistry: LoreWorkspaceRegistry) => buildCloudStores({
        apiKey: KEY, baseUrl: mock.url, orgId, dataplaneWorkspaceId: DP_WS, embeddingProvider: bagOfWordsEmbedder(),
        clientFactory: factory as never, hasCapability: async () => null, workspaceRegistry, connection: FIXTURE_CONNECTION,
    });
    const home = await build(ORG, regHome);
    const other = await build(ORG_X, regX);
    const mc = connectedClient(mock.url, KEY);
    const raw = {
        insert: (c: string, r: unknown) => mc.insert(DP_WS, c, r),
        updateByQuery: (c: string, f: object, u: object) => mc.updateByQuery(DP_WS, c, f, u),
        deleteByQuery: (c: string, f: object) => mc.deleteByQuery(DP_WS, c, f),
        query: (c: string, o: unknown) => mc.query(DP_WS, c, o),
        graph: mc.graph,
    };
    const tenant = (name: string, orgId: string, sc: DataplaneScope, s: Stores, registry: LoreWorkspaceRegistry): Tenant => ({
        name, orgId, scope: sc, s, registry,
        run: (fn) => runWithWorkspace({ workspaceId: name }, fn),
        sync: () => {
            const a = new TsSdkAdapter({ baseUrl: 'x', apiKey: 'x', tenantId: DP_WS, orgId, workspaceRegistry: registry, loreWorkspace: name, connection: FIXTURE_CONNECTION });
            (a as unknown as { client: unknown; connected: boolean }).client = raw;
            (a as unknown as { connected: boolean }).connected = true;
            return a;
        },
    });
    const collections = (): string[] => {
        const names = new Set<string>(['lore_node', 'lore_edge', 'lore_verbatim', 'lore_version', ADV]);
        for (const r of mock.requests) {
            const seg = decodeURIComponent(r.path.split('?')[0]!.split('/')[2] ?? '');
            if (/^lore_[a-z0-9_]+$/.test(seg)) names.add(seg);
        }
        return [...names].sort();
    };
    const victimRows = () => collections().flatMap((c) => mock.rows(DP_WS, c, FIXTURE_CONNECTION).map((r) => ({ c, r })))
        .filter(({ r }) => `${r['org_id']}|${r['lore_workspace']}` !== B_OWNER);
    return {
        label, mock, faults, supplied: [],
        A: tenant(NAME_A, ORG, SCOPE_A, home, regHome),
        B: tenant(NAME_B, ORG, SCOPE_B, home, regHome),
        X: tenant(NAME_B, ORG_X, SCOPE_X, other, regX),
        victimSnap: () => {
            const out: Record<string, string> = {};
            for (const c of collections()) {
                const rows = mock.rows(DP_WS, c, FIXTURE_CONNECTION).filter((r) => `${r['org_id']}|${r['lore_workspace']}` !== B_OWNER)
                    .sort((x, y) => String(x['id']).localeCompare(String(y['id'])));
                out[c] = JSON.stringify(rows);
            }
            return out;
        },
        // Everything of the victims' an attacker must never learn: canaries, physical row keys, and
        // server-generated ids (version / changeset / snapshot lore_ids). Logical ids the attacker can
        // also create (secret-1 …) are not secrets.
        secrets: () => {
            const s = new Set<string>([CANARY_A, CANARY_X]);
            for (const { r } of victimRows()) {
                s.add(String(r['id']));
                const lid = String(r['lore_id'] ?? '');
                if (lid && !VICTIM_IDS.includes(lid) && !lid.startsWith('vol-') && lid !== 'k1') s.add(lid);
            }
            return [...s];
        },
        close: async () => { await home.vectorStore.close(); await other.vectorStore.close(); await mock.close(); },
    };
}

/** Seed a victim with canaries on every route: nodes (+versions), edge, verbatim (+#rev), changeset, version row, storage row. */
async function seedVictim(t: Tenant, canary: string): Promise<void> {
    await t.run(async () => {
        await t.s.graph.versions.runWithVersionIntent({ principal: `victim-${canary}` }, async () => {
            for (const id of VICTIM_IDS) {
                await t.s.graph.upsertNode(node(id, `${canary} label ${id}`, `zebra apple ${canary} content`));
                await t.s.graph.upsertNode(node(id, `${canary} label ${id} v2`, `zebra apple ${canary} content v2`));
            }
        });
        await t.s.graph.addEdge({ sourceId: 'secret-1', targetId: 'secret-2', relation: 'links', metadata: '{}', createdAt: EPOCH } as never);
        await t.s.vectorStore.store({ id: 'secret-1', text: `zebra apple ${canary}`, metadata: { type: 'note', project: 'proj' } });
        await t.s.vectorStore.store({ id: 'secret-1', text: `zebra apple ${canary} v2`, metadata: { type: 'note', project: 'proj' } });
        await t.s.vectorStore.store({ id: 'secret-2', text: `zebra savanna ${canary}`, metadata: { type: 'note', project: 'proj' } });
        const cs = await t.s.graph.versions.createChangeset(t.name);
        await t.s.graph.versions.addChangesetWrite(cs, 'upsert', { canary });
        await t.s.graph.getGraphContext().storage.upsert(ADV, 'key', { key: 'k1', secret: canary, kind: 'adv' });
    });
}

async function seedAttacker(w: World): Promise<void> {
    await w.B.run(async () => {
        await w.B.s.graph.upsertNode(node('b1', 'b one', 'zebra apple attacker'));
        await w.B.s.graph.upsertNode(node('b2', 'b two', 'zebra savanna attacker'));
        await w.B.s.graph.addEdge({ sourceId: 'b1', targetId: 'b2', relation: 'links', metadata: '{}', createdAt: EPOCH } as never);
        await w.B.s.vectorStore.store({ id: 'b1', text: 'zebra apple attacker', metadata: { type: 'note', project: 'proj' } });
        await w.B.s.vectorStore.store({ id: 'b2', text: 'zebra savanna attacker', metadata: { type: 'note', project: 'proj' } });
        await w.B.s.graph.getGraphContext().storage.upsert(ADV, 'key', { key: 'kb', secret: 'attacker', kind: 'adv' });
    });
}

/* ─── the attack harness ────────────────────────────────────────────────────────────────────── */

const show = (v: unknown): string => {
    try { return JSON.stringify(v, (_k, x) => (x instanceof Map ? Object.fromEntries(x) : x)) ?? 'undefined'; } catch { return String(v); }
};

/** Run one attacker op as B; record (not throw) every violation so one test reports all of them. */
async function attack(w: World, errs: string[], label: string, input: unknown, fn: () => Promise<unknown>): Promise<unknown> {
    const before = w.victimSnap();
    const secrets = w.secrets();
    let out: unknown;
    try { out = await w.B.run(fn); } catch (e) { out = { rejected: `${(e as Error).name}: ${(e as Error).message}` }; }
    const text = show(out).toLowerCase();
    w.supplied.push(show(input).toLowerCase());
    for (const s of secrets) {
        const needle = s.toLowerCase();
        if (needle.length > 0 && text.includes(needle) && !w.supplied.some((x) => x.includes(needle))) errs.push(`${label}: victim secret ${s.slice(0, 40)} in B's output ${text.slice(0, 200)}`);
    }
    const after = w.victimSnap();
    for (const c of Object.keys({ ...before, ...after })) {
        if (before[c] !== after[c]) errs.push(`${label}: victim rows of ${c} changed (${(before[c] ?? '').length} -> ${(after[c] ?? '').length} bytes)`);
    }
    return out;
}

/** B's whole read surface, used for leak checks and for the volume-invariance (count / ordering side-channel) check. */
async function probeB(w: World, opts: { keyword: boolean; tolerant?: boolean }): Promise<Record<string, unknown>> {
    const { graph, vectorStore } = w.B.s;
    // tolerant: a route that throws reports `THROWS: …` instead of aborting the probe (evidence gathering).
    const f = async <T>(fn: () => Promise<T>): Promise<T | string> => {
        try { return await fn(); } catch (e) { if (!opts.tolerant) throw e; return `THROWS: ${(e as Error).message.slice(0, 90)}`; }
    };
    return w.B.run(async () => {
        const pages: string[] = [];
        let cursor: { updatedAt: string; id: string } | undefined;
        for (let i = 0; i < 20; i++) {
            const p = await graph.bulkList({ limit: 1, ...(cursor ? { cursor } : {}) } as never) as unknown as { nodes: Array<{ id: string }>; nextCursor?: { updatedAt: string; id: string } | null };
            pages.push(...p.nodes.map((n) => n.id));
            if (!p.nextCursor) break;
            cursor = p.nextCursor;
        }
        const pulled = await f(() => w.B.sync().pull(EPOCH));
        const out: Record<string, unknown> = {
            stats: await f(async () => await graph.getStats()),
            topology: await f(async () => await graph.getTopology(500)),
            overview: await f(async () => await graph.getTopologyOverview()),
            overviewByType: await f(async () => await graph.getTopologyOverviewByType()),
            languages: await f(async () => await graph.getLanguageBreakdown()),
            listNodes: await f(async () => (await graph.listNodes()).map((n) => n.id)),
            listByProject: await f(async () => (await graph.listNodes(undefined, undefined, 'proj')).map((n) => n.id)),
            bulkPages: pages,
            graphSearch: await f(async () => (await graph.search('zebra', 50)).map((n) => n.id)),
            edges: await f(async () => (await graph.queryEdges({ limit: 500, offset: 0 } as never)).map((e) => `${e.sourceId}>${e.targetId}`)),
            traverse: await f(async () => (await graph.traverse('b1', 3)).map((r) => r.node.id)),
            vectorCount: await f(async () => await vectorStore.count()),
            vector: await f(async () => (await vectorStore.search('zebra apple', 50)).map((h) => [h.id, h.score])),
            history: await f(async () => (await vectorStore.getHistory('b1')).length),
            diff: await f(async () => (await graph.versions.getDiff(NAME_B, EPOCH)).map((v) => v.nodeId)),
            syncNodes: typeof pulled === 'string' ? pulled : pulled.nodes.map((n) => n.id),
            syncEdges: typeof pulled === 'string' ? pulled : pulled.edges.map((e) => `${e.sourceId}>${e.targetId}`),
            storageCount: await f(async () => await graph.getGraphContext().storage.count(ADV)),
            storageFind: await f(async () => (await graph.getGraphContext().storage.find<{ key: string }>(ADV, {})).map((r) => r.key)),
        };
        if (opts.keyword) out['keyword'] = (await vectorStore.bm25Search('zebra apple', 50)).hits.map((h) => [h.id, h.score]);
        return out;
    });
}

/* ─── item 1: crafted ids against every id-taking route ─────────────────────────────────────── */

function craftedIds(w: World): Array<[string, string]> {
    const rev = w.mock.rows(DP_WS, 'lore_verbatim', FIXTURE_CONNECTION).find((r) => r['lore_workspace'] === ID_A && String(r['lore_id']).includes('#rev'));
    const ver = w.mock.rows(DP_WS, 'lore_version', FIXTURE_CONNECTION).find((r) => r['lore_workspace'] === ID_A && r['kind'] === 'node_version');
    const cs = w.mock.rows(DP_WS, 'lore_version', FIXTURE_CONNECTION).find((r) => r['lore_workspace'] === ID_A && r['kind'] === 'changeset');
    return [
        ['A exact lore_id', 'secret-1'],
        ['U+001F org/ws/id triple', `${ORG}\u001f${ID_A}\u001fsecret-1`],
        ['U+001F suffix', 'secret-1\u001f'],
        ['lw1_ prefix', 'lw1_'],
        ["A's full lw1_ row key", dataplaneRowKey(SCOPE_A, 'secret-1')],
        ["X's full lw1_ row key", dataplaneRowKey(SCOPE_X, 'secret-1')],
        ['#rev suffix (guessed ts)', 'secret-1#rev2026-09-01T00:00:00.000Z'],
        ["A's real #rev snapshot id", String(rev?.['lore_id'] ?? 'secret-1#rev')],
        ["A's version id", String(ver?.['lore_id'] ?? 'v')],
        ["A's changeset id", String(cs?.['lore_id'] ?? 'c')],
        ['$alias.id', '$a.id'],
        ['$op0.id', '$op0.id'],
        ['very long id (20k)', `secret-1${'x'.repeat(20_000)}`],
        ['Cyrillic lookalike', 'ѕecret-1'],
        ['fullwidth lookalike', 'ｓｅｃｒｅｔ-1'],
        ['zero-width joiner', 'secret​-1'],
        ['empty', ''],
        ['whitespace', '   '],
        ['wildcard *', '*'],
        ['SQL/AQL-ish', "secret-1' OR '1'='1"],
    ];
}

async function crafted(w: World, label: string, id: string): Promise<string[]> {
    const errs: string[] = [];
    const { graph, vectorStore: vector } = w.B.s;
    const st = () => graph.getGraphContext().storage;
    const v = graph.versions;
    const intent = <T>(fn: () => Promise<T>) => v.runWithVersionIntent({ principal: 'attacker' }, fn);
    const ops: Array<[string, () => Promise<unknown>]> = [
        ['getNode', () => graph.getNode(id)],
        ['getNodesByIds', () => graph.getNodesByIds([id, 'secret-2'])],
        ['queryEdges.source', () => graph.queryEdges({ source: id, limit: 50, offset: 0 } as never)],
        ['queryEdges.target', () => graph.queryEdges({ target: id, limit: 50, offset: 0 } as never)],
        ['traverse', () => graph.traverse(id, 3)],
        ['vector.getById', () => vector.getById(id)],
        ['vector.getHistory', () => vector.getHistory(id)],
        ['vector.contentHashes', () => vector.getContentHashesByIds([id])],
        ['versions.getVersions', () => v.getVersions(id, NAME_B, 50)],
        ['versions.getVersions(A name)', () => v.getVersions(id, NAME_A, 50)],
        ['versions.byChangeset', () => v.getVersionsByChangeset(id)],
        ['versions.getChangeset', () => v.getChangeset(id)],
        ['versions.changesetWrites', () => v.getChangesetWrites(id)],
        ['storage.get', () => st().get(ADV, 'key', id)],
        ['storage.find', () => st().find(ADV, { key: id } as never)],
        ['storage.count', () => st().count(ADV, { key: id } as never)],
        ['sync.pull(cursor=id)', () => w.B.sync().pull(id)],
        ['upsertNode', () => intent(() => graph.upsertNode(node(id, 'B-WRITE', 'attacker overwrite')))],
        ['addEdge b1->id', () => graph.addEdge({ sourceId: 'b1', targetId: id, relation: 'links', metadata: '{}', createdAt: EPOCH } as never)],
        ['addEdge id->b1', () => graph.addEdge({ sourceId: id, targetId: 'b1', relation: 'links', metadata: '{}', createdAt: EPOCH } as never)],
        ['deleteEdge', () => graph.deleteEdge(id, 'secret-2', 'links')],
        ['supersede id->b1', () => graph.supersedeNode(id, 'b1', 'attack')],
        ['supersede b1->id', () => graph.supersedeNode('b1', id, 'attack')],
        ['unsupersede', () => graph.unsupersedeNode(id)],
        ['markStaleByIds', () => graph.markStaleByIds([id])],
        ['vector.store', () => vector.store({ id, text: 'attacker text', metadata: { type: 'note' } })],
        ['vector.tombstone', () => vector.tombstone(id, 'attack')],
        ['vector.delete', () => vector.delete(id)],
        ['versions.updateChangeset', () => v.updateChangeset(id, 'rolled_back')],
        ['versions.addChangesetWrite', () => v.addChangesetWrite(id, 'upsert', { a: 1 })],
        ['versions.incrementWriteCount', () => v.incrementWriteCount(id)],
        ['versions.discardVersions', () => v.discardVersions([id])],
        ['storage.upsert', () => st().upsert(ADV, 'key', { key: id, secret: 'attacker' })],
        ['storage.deleteWhere', () => st().deleteWhere(ADV, { key: id } as never)],
        ['sync.push', () => w.B.sync().push([node(id, 'B-SYNC', 'attacker sync') as never], [])],
        ['sync.pushDeletes', () => w.B.sync().pushDeletes([id])],
        ['deleteNode', () => graph.deleteNode(id)],
        ['vector.physicalDelete', () => vector.physicalDelete(id)],
        ['vector.physicalDeleteMany', () => vector.physicalDeleteMany([id, 'secret-2'])],
    ];
    for (const [op, fn] of ops) await attack(w, errs, `${label} / ${op}`, id, fn);
    return errs;
}

/* ─── item 2: filter / metadata injection ───────────────────────────────────────────────────── */

async function injection(w: World): Promise<string[]> {
    const errs: string[] = [];
    const { graph, vectorStore: vector } = w.B.s;
    const st = () => graph.getGraphContext().storage;
    const evil: unknown[] = [
        { $or: [{ org_id: ORG_X }, { lore_workspace: ID_A }] },
        { $ne: null }, { $in: ['proj', ID_A] }, { $nin: [] }, { $regex: '.*' }, { $exists: true },
        `proj' OR lore_workspace='${ID_A}`, ['proj', ID_A], '*', '',
    ];
    const scopeKeys = { org_id: ORG_X, lore_workspace: ID_A, lore_id: 'secret-1', id: dataplaneRowKey(SCOPE_A, 'secret-1'), tenant_id: 'other' };
    for (const [i, e] of evil.entries()) {
        const tag = `inject#${i} ${show(e).slice(0, 40)}`;
        await attack(w, errs, `${tag} listNodes(project)`, e, () => graph.listNodes(undefined, undefined, e as never));
        await attack(w, errs, `${tag} listNodes(type,tag)`, e, () => graph.listNodes(e as never, e as never));
        await attack(w, errs, `${tag} search(project)`, e, () => graph.search('zebra', 50, e as never, e as never));
        await attack(w, errs, `${tag} bulkList`, e, () => graph.bulkList({ limit: 100, types: [e], tags: [e], project: e, ecosystem: e } as never));
        await attack(w, errs, `${tag} queryEdges(relation)`, e, () => graph.queryEdges({ relation: e, source: e, limit: 50, offset: 0 } as never));
        await attack(w, errs, `${tag} vector.search filter`, e, () => vector.search('zebra apple', 50, { ...scopeKeys, project: e, type: e, $or: [e], security_scopes: ['*'] } as never));
        await attack(w, errs, `${tag} bm25Search filter+actorScopes`, e, () => vector.bm25Search('zebra apple', 50, { ...scopeKeys, project: e, $or: [e] } as never, ['*'] as never));
        await attack(w, errs, `${tag} storage.find`, e, () => st().find(ADV, { ...scopeKeys, key: e } as never));
        await attack(w, errs, `${tag} storage.find(scope keys only)`, e, () => st().find(ADV, { org_id: e, lore_workspace: e } as never));
        await attack(w, errs, `${tag} storage.count`, e, () => st().count(ADV, { lore_workspace: e, key: e } as never));
        await attack(w, errs, `${tag} markStaleByTags`, e, () => graph.markStaleByTags([e as never]));
        await attack(w, errs, `${tag} findNodeIdsByTags`, e, () => graph.findNodeIdsByTags([e as never]));
        await attack(w, errs, `${tag} versions.getDiff(since)`, e, () => graph.versions.getDiff(NAME_B, e as never));
        await attack(w, errs, `${tag} sync.pull(since)`, e, () => w.B.sync().pull(e as never));
    }
    // Spoofed scope columns / security scopes in WRITES: the row must land in B's scope.
    const spoofOut: unknown[] = [];
    spoofOut.push(await attack(w, errs, 'upsertNode with spoofed scope fields + metadata', scopeKeys, () => graph.upsertNode(node('spoof-1', 'spoof', 'attacker spoof', {
        ...scopeKeys, metadata: JSON.stringify({ ...scopeKeys, security_scopes: ['*'] }), project: ID_A,
    }))));
    spoofOut.push(await attack(w, errs, 'vector.store with spoofed metadata', scopeKeys, () => vector.store({ id: 'spoof-2', text: 'attacker spoof', metadata: { ...scopeKeys, security_scopes: ['*'], project: 'proj' } as never })));
    spoofOut.push(await attack(w, errs, 'storage.upsert with spoofed scope columns', scopeKeys, () => st().upsert(ADV, 'key', { key: 'spoof-3', secret: 'attacker', ...scopeKeys })));
    await attack(w, errs, 'storage.upsert keyed by lore_workspace', scopeKeys, () => st().upsert(ADV, 'lore_workspace', { lore_workspace: ID_A, secret: 'attacker' }));
    await attack(w, errs, 'storage.upsert keyed by org_id', scopeKeys, () => st().upsert(ADV, 'org_id', { org_id: ORG_X, secret: 'attacker' }));
    await attack(w, errs, 'sync.push with spoofed scope fields', scopeKeys, () => w.B.sync().push([node('spoof-4', 'spoof', 'attacker', { ...scopeKeys }) as never], [{ sourceId: 'secret-1', targetId: 'secret-2', relation: 'links', ...scopeKeys } as never]));
    await attack(w, errs, 'addEdge with spoofed scope fields', scopeKeys, () => graph.addEdge({ sourceId: 'b1', targetId: 'b2', relation: 'spoofed', metadata: JSON.stringify(scopeKeys), createdAt: EPOCH, ...scopeKeys } as never));
    await attack(w, errs, 'createChangeset for A by name', NAME_A, () => graph.versions.createChangeset(NAME_A));
    await attack(w, errs, 'getDiff for A by name', NAME_A, () => graph.versions.getDiff(NAME_A, EPOCH));
    // Spoofed rows really are B's.
    const spoofed = [
        ...w.mock.rows(DP_WS, 'lore_node', FIXTURE_CONNECTION).filter((r) => String(r['lore_id']).startsWith('spoof')),
        ...w.mock.rows(DP_WS, 'lore_verbatim', FIXTURE_CONNECTION).filter((r) => String(r['lore_id']).startsWith('spoof')),
        ...w.mock.rows(DP_WS, ADV, FIXTURE_CONNECTION).filter((r) => r['secret'] === 'attacker'),
    ];
    for (const r of spoofed) if (`${r['org_id']}|${r['lore_workspace']}` !== B_OWNER) errs.push(`spoofed write landed outside B: ${show(r).slice(0, 200)}`);
    if (spoofed.length < 3) errs.push(`expected the spoofed writes to land in B (found ${spoofed.length}): ${show(spoofOut).slice(0, 600)}`);
    // A delete with only unknown operators widens INSIDE B (documented): it must never cross scope.
    await attack(w, errs, 'storage.deleteWhere(unknown ops only)', '$or', () => st().deleteWhere(ADV, { $or: [{ lore_workspace: ID_A }] } as never));
    await w.B.run(() => st().upsert(ADV, 'key', { key: 'kb', secret: 'attacker', kind: 'adv' })); // restore B's own row for later probes
    return errs;
}

/* ─── item 5: failed / partial transactions from B ──────────────────────────────────────────── */

async function failedWrites(w: World): Promise<string[]> {
    const errs: string[] = [];
    const { graph, vectorStore: vector } = w.B.s;
    const intent = <T>(fn: () => Promise<T>) => graph.versions.runWithVersionIntent({ principal: 'attacker-tx' }, fn);
    for (const coll of ['lore_version', 'lore_node', 'lore_verbatim']) {
        w.faults.failColl = coll;
        try {
            for (const id of ['secret-1', 'b1', '$a.id', dataplaneRowKey(SCOPE_A, 'secret-2')]) {
                await attack(w, errs, `fault(${coll}) upsertNode ${id.slice(0, 12)}`, id, () => intent(() => graph.upsertNode(node(id, 'B-TX', 'attacker tx'))));
                await attack(w, errs, `fault(${coll}) vector.store ${id.slice(0, 12)}`, id, () => vector.store({ id, text: `attacker tx ${coll}`, metadata: { type: 'note' } }));
                await attack(w, errs, `fault(${coll}) tombstone ${id.slice(0, 12)}`, id, () => vector.tombstone(id, 'attack'));
            }
        } finally { w.faults.failColl = null; }
    }
    // Healthy writes: history lands in B's workspace, nowhere else.
    await attack(w, errs, 'history write secret-1', 'secret-1', () => intent(async () => {
        await graph.upsertNode(node('secret-1', 'B-HIST', 'attacker history 1'));
        await graph.upsertNode(node('secret-1', 'B-HIST2', 'attacker history 2'));
    }));
    await attack(w, errs, 'snapshot write secret-1', 'secret-1', async () => {
        await vector.store({ id: 'secret-1', text: 'attacker snap 1', metadata: { type: 'note' } });
        await vector.store({ id: 'secret-1', text: 'attacker snap 2', metadata: { type: 'note' } });
    });
    const mine = [
        ...w.mock.rows(DP_WS, 'lore_version', FIXTURE_CONNECTION).filter((r) => String(r['principal'] ?? '').startsWith('attacker')),
        ...w.mock.rows(DP_WS, 'lore_verbatim', FIXTURE_CONNECTION).filter((r) => String(r['text'] ?? '').includes('attacker snap')),
    ];
    if (!mine.some((r) => r['principal'] === 'attacker-tx')) errs.push('B wrote no version row under its intent (history path not exercised)');
    for (const r of mine) if (`${r['org_id']}|${r['lore_workspace']}` !== B_OWNER) errs.push(`B history row landed outside B: ${show(r).slice(0, 160)}`);
    const bHist = await w.B.run(() => graph.versions.getVersions('secret-1', NAME_B, 50));
    if (bHist.some((h) => show(h).toLowerCase().includes(CANARY_A))) errs.push("B's history of secret-1 contains A's canary");
    return errs;
}

/* ─── run one engine shape ──────────────────────────────────────────────────────────────────── */

async function suite(label: string, mockOpts: Omit<MockDataplaneOptions, 'apiKeys'>): Promise<void> {
    console.log(`\nadversarial isolation — ${label}`);
    const w = await startWorld(label, mockOpts);
    try {
        await seedVictim(w.A, CANARY_A);
        await seedVictim(w.X, CANARY_X);
        await seedAttacker(w);
        const victimBaseline = { A: await probeVictim(w.A), X: await probeVictim(w.X) };

        await test(`[${label}] seed: victims and attacker hold rows in their own scope only`, () => {
            for (const c of ['lore_node', 'lore_edge', 'lore_verbatim', 'lore_version', ADV]) {
                const owners = new Set(w.mock.rows(DP_WS, c, FIXTURE_CONNECTION).map((r) => `${r['org_id']}|${r['lore_workspace']}`));
                assert.ok(owners.has(`${ORG}|${ID_A}`) && owners.has(`${ORG_X}|${ID_B}`), `${c}: both victims seeded (${[...owners].join(', ')})`);
            }
            assert.ok(w.mock.rows(DP_WS, 'lore_verbatim', FIXTURE_CONNECTION).some((r) => r['lore_workspace'] === ID_A && String(r['lore_id']).includes('#rev')), 'A has a #rev snapshot');
            assert.ok(w.mock.rows(DP_WS, 'lore_version', FIXTURE_CONNECTION).some((r) => r['org_id'] === ORG_X && r['kind'] === 'node_version'), 'X has version rows');
        });
        await test(`[${label}] B's full read surface holds no victim data`, async () => {
            const errs: string[] = [];
            await attack(w, errs, 'probeB', '', () => probeB(w, { keyword: true }));
            assert.deepEqual(errs, []);
        });
        for (const [name, id] of craftedIds(w)) {
            await test(`[${label}] crafted id: ${name}`, async () => assert.deepEqual(await crafted(w, name, id), []));
        }
        await test(`[${label}] filter + metadata injection (operators, scope-key overrides, spoofed columns)`, async () => assert.deepEqual(await injection(w), []));
        await test(`[${label}] failed / partial writes and history from B stay in B`, async () => assert.deepEqual(await failedWrites(w), []));

        const sqlite = mockOpts.queryFilterMode === 'sqlite';
        let afterVolume: Record<string, unknown> = {};
        await test(`[${label}] count/stat/order side channel: B's view does not move with A's or X's volume`, async () => {
            const before = await probeB(w, { keyword: false });
            const sanity: Record<string, string> = { listNodes: 'b1', syncNodes: 'b1', traverse: 'b2', edges: 'b1>b2', graphSearch: 'b2', storageFind: 'kb' };
            if (!sqlite) sanity['bulkPages'] = 'b1'; // sqlite: see SQLITE-QUERY-CROWD-OUT below
            for (const [k, v] of Object.entries(sanity)) {
                assert.ok((before[k] as string[]).includes(v), `probe sanity: ${k} sees B's own ${v} (${show(before[k]).slice(0, 120)})`);
            }
            await addVolume(w.A, CANARY_A);
            await addVolume(w.X, CANARY_X);
            afterVolume = await probeB(w, { keyword: false });
            assert.deepEqual(afterVolume, before);
        });
        await test(`[${label}] victims still read exactly their own data (graph edges / traverse included)`, async () => {
            assert.deepEqual(stripVolume(await probeVictim(w.A)), stripVolume(victimBaseline.A));
            assert.deepEqual(stripVolume(await probeVictim(w.X)), stripVolume(victimBaseline.X));
        });
        // Bulk volume past every engine page / over-fetch cap (1000-row query cap, 1000-row pull page),
        // NEWER than B's rows, so a newest-first page fills with foreign rows on a filter-ignoring engine.
        const highVolume = async (): Promise<void> => {
            const problems: string[] = [];
            if (!(afterVolume['bulkPages'] as string[] | undefined)?.includes('b1')) problems.push(`bulkList pages B's own rows (got ${show(afterVolume['bulkPages'])})`);
            await addRawVolume(w, SCOPE_A, CANARY_A, 1100);
            await addRawVolume(w, SCOPE_X, CANARY_X, 1100);
            let after: Record<string, unknown> | undefined;
            try { after = await probeB(w, { keyword: false, tolerant: true }); } catch (e) { problems.push(`B's probe throws: ${(e as Error).message.slice(0, 160)}`); }
            if (after) {
                const text = show(after).toLowerCase();
                const leaked = w.secrets().map((x) => x.toLowerCase()).filter((x) => x.length > 0 && text.includes(x) && !w.supplied.some((sup) => sup.includes(x)));
                if (leaked.length > 0) throw new Error(`CONFIDENTIALITY: high-volume probe leaked ${leaked.join(', ')}`); // never known-open
                for (const k of Object.keys(afterVolume)) if (show(after[k]) !== show(afterVolume[k])) problems.push(`${k}: ${show(afterVolume[k]).slice(0, 60)} -> ${show(after[k]).slice(0, 60)}`);
            }
            assert.ok(problems.length === 0, problems.join(' | '));
        };
        if (sqlite) {
            await knownOpen('SQLITE-QUERY-CROWD-OUT', `[${label}] B's view survives 2200 foreign rows (query cap / no pushdown)`, highVolume);
            // LEAK-FIXED (pageRepeats): an offset walk over a connector that ignores `offset` used to re-read page 0
            // up to its cap — 100 topology queries counting B's rows 100x, 50 history / version-scan queries each —
            // so B's counts and cost scaled with other workspaces' volume. It must now stop on the first repeat.
            await test(`[${label}] offset-ignoring connector: B's paged scans stop at the first repeated page (no re-count, no 50x re-read)`, async () => {
                const queries = async (fn: () => Promise<unknown>): Promise<{ n: number; out: unknown }> => {
                    const start = w.mock.requests.length;
                    let out: unknown;
                    try { out = await w.B.run(fn); } catch (e) { out = `THROWS: ${(e as Error).message}`; }
                    return { n: w.mock.requests.slice(start).filter((r) => r.path.endsWith('/query')).length, out };
                };
                const { graph, vectorStore } = w.B.s;
                const ov = await queries(() => graph.getTopologyOverview());
                const byType = await queries(() => graph.getTopologyOverviewByType());
                const langs = await queries(() => graph.getLanguageBreakdown());
                const hist = await queries(() => vectorStore.getHistory('b1'));
                const diff = await queries(() => graph.versions.getDiff(NAME_B, EPOCH));
                for (const [name, r] of Object.entries({ ov, byType, langs, hist, diff })) assert.ok(r.n <= 2, `${name}: ${r.n} query calls (${show(r.out).slice(0, 120)})`);
                const bNodes = (afterVolume['listNodes'] as string[]).length;
                assert.equal((ov.out as { totalNodes: number }).totalNodes, bNodes, `overview counts B's ${bNodes} nodes once: ${show(ov.out).slice(0, 200)}`);
                assert.equal((ov.out as { truncated?: boolean }).truncated, true, 'a stopped scan is flagged truncated');
                assert.equal((byType.out as { totalNodes: number }).totalNodes, bNodes);
                assert.equal((langs.out as Record<string, number>)['_truncated'], 1);
                assert.match(String(hist.out), /ignored offset paging/);
                assert.match(String(diff.out), /ignored offset paging/);
            });
        } else await test(`[${label}] B's view survives 2200 foreign rows (query cap / pull page)`, highVolume);
    } finally { await w.close(); }
}

async function probeVictim(t: Tenant): Promise<Record<string, unknown>> {
    return t.run(async () => ({
        nodes: (await t.s.graph.listNodes()).map((n) => `${n.id}:${n.label}`).sort(),
        traverse: (await t.s.graph.traverse('secret-1', 3)).map((r) => r.node.id).sort(),
        edges: (await t.s.graph.queryEdges({ limit: 500, offset: 0 } as never)).map((e) => `${e.sourceId}>${e.relation}>${e.targetId}`).sort(),
        verbatim: await t.s.vectorStore.getById('secret-1').then((r) => r?.text ?? null),
        history: (await t.s.vectorStore.getHistory('secret-1')).map((h) => (h as { text?: string }).text ?? '').sort(),
        versions: (await t.s.graph.versions.getVersions('secret-1', t.name, 50)).length,
        storage: await t.s.graph.getGraphContext().storage.get(ADV, 'key', 'k1').then((r) => (r as { secret?: string } | null)?.secret ?? null),
    }));
}
const stripVolume = (p: Record<string, unknown>) => ({ ...p, nodes: (p['nodes'] as string[]).filter((n) => !n.startsWith('vol-')), edges: (p['edges'] as string[]).filter((e) => !e.includes('vol-')) });

async function addVolume(t: Tenant, canary: string, n = 30): Promise<void> {
    await t.run(async () => {
        await t.s.graph.versions.runWithVersionIntent({ principal: `victim-${canary}` }, async () => {
            for (let i = 0; i < n; i++) {
                await t.s.graph.upsertNode(node(`vol-${i}`, `${canary} vol ${i}`, `zebra apple zebra apple ${canary}`));
                if (i > 0) await t.s.graph.addEdge({ sourceId: `vol-${i - 1}`, targetId: `vol-${i}`, relation: 'links', metadata: '{}', createdAt: EPOCH } as never);
            }
        });
        await t.s.vectorStore.storeBatch(Array.from({ length: n }, (_, i) => ({ id: `vol-${i}`, text: `zebra apple zebra apple ${canary} ${i}`, metadata: { type: 'note', project: 'proj' } })));
        for (let i = 0; i < 5; i++) await t.s.graph.getGraphContext().storage.upsert(ADV, 'key', { key: `vol-${i}`, secret: canary });
    });
}

/** Clone a victim's own rows `n` times per collection, straight into the engine (as another Lore instance would write them). */
async function addRawVolume(w: World, sc: DataplaneScope, canary: string, n: number): Promise<void> {
    const raw = connectedClient(w.mock.url, KEY);
    const ts = '2099-01-01T00:00:00.000Z';
    for (const coll of ['lore_node', 'lore_edge', 'lore_verbatim', 'lore_version', ADV]) {
        const tpl = w.mock.rows(DP_WS, coll, FIXTURE_CONNECTION).find((r) => r['org_id'] === sc.orgId && r['lore_workspace'] === sc.loreWorkspace && !String(r['lore_id']).includes('#rev'));
        if (!tpl) throw new Error(`no ${coll} template row for ${sc.orgId}/${sc.loreWorkspace}`);
        const rows = Array.from({ length: n }, (_, i) => ({ ...tpl, ...scopeRowFields(sc, `rv-${coll}-${i}`), updated_at: ts, label: `${canary} rv ${i}`, text: `zebra apple ${canary} rv ${i}`, ...(coll === 'lore_version' ? { node_id: 'b1', timestamp: ts } : {}) }));
        for (let i = 0; i < rows.length; i += 500) await raw.bulkInsert(DP_WS, coll, rows.slice(i, i + 500));
    }
}

/* ─── item 3: workspace identity (R6) through a real data home ─────────────────────────────── */

async function identity(): Promise<void> {
    console.log('\nadversarial isolation — workspace identity (real registry, buildCloudStores({home}))');
    const mock = await startMockDataplane({ apiKeys: { [KEY]: DP_WS } });
    const homes: string[] = [];
    const mkHome = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-adv-home-')); homes.push(h); return h; };
    const build = (orgId: string, home: string) => buildCloudStores({
        apiKey: KEY, baseUrl: mock.url, orgId, dataplaneWorkspaceId: DP_WS, embeddingProvider: bagOfWordsEmbedder(),
        clientFactory: createMockDataplaneClient as never, hasCapability: async () => null, home, connection: FIXTURE_CONNECTION,
    });
    const as = <T>(ws: string, fn: () => Promise<T>) => runWithWorkspace({ workspaceId: ws }, fn);
    const seed = (s: Stores, ws: string, canary: string) => as(ws, async () => {
        await s.graph.upsertNode(node('secret-1', `${canary} label`, `zebra ${canary}`));
        await s.vectorStore.store({ id: 'secret-1', text: `zebra ${canary}`, metadata: { type: 'note' } });
    });
    const sees = (s: Stores, ws: string) => as(ws, async () => show({
        node: await s.graph.getNode('secret-1'), list: await s.graph.listNodes(), vec: await s.vectorStore.search('zebra', 20),
        count: await s.vectorStore.count(), stats: await s.graph.getStats(),
    }).toLowerCase());
    const notAllowed = (e: unknown) => e instanceof DataplaneScopeError && e.code === 'cloud_scope_workspace_not_allowed'
        || /cloud_scope_workspace_not_allowed|is not registered in this Lore instance/.test((e as Error)?.message ?? '');
    try {
        const homeO = mkHome();
        const s = await build(ORG, homeO);
        createWorkspace(NAME_A, {}, homeO);
        await seed(s, NAME_A, CANARY_A);
        const pathA = loadWorkspaces(homeO).workspaces.find((w) => w.name === NAME_A)!.path;

        await test('same org: an alias registered onto A\'s path shares A\'s id (BY DESIGN: registry write = workspace access)', async () => {
            registerWorkspaceAlias('a-alias', pathA, {}, homeO);
            assert.ok((await sees(s, 'a-alias')).includes(CANARY_A));
            deleteWorkspace('a-alias', homeO);
        });
        await test('other org: the same alias name + path in X\'s registry sees nothing of A', async () => {
            const homeX = mkHome();
            const sx = await build(ORG_X, homeX);
            registerWorkspaceAlias('a-alias', pathA, {}, homeX);
            registerWorkspaceAlias(NAME_A, pathA, {}, homeX);
            assert.ok(!(await sees(sx, 'a-alias')).includes(CANARY_A));
            assert.ok(!(await sees(sx, NAME_A)).includes(CANARY_A));
        });
        await test('two orgs with identical registries (same names, paths AND ids) are isolated by org', async () => {
            const homeX = mkHome();
            fs.copyFileSync(path.join(homeO, 'workspaces.json'), path.join(homeX, 'workspaces.json'));
            const sx = await build(ORG_X, homeX);
            assert.equal(loadWorkspaces(homeX).workspaces.find((w) => w.name === NAME_A)!.id, loadWorkspaces(homeO).workspaces.find((w) => w.name === NAME_A)!.id);
            assert.ok(!(await sees(sx, NAME_A)).includes(CANARY_A));
            await seed(sx, NAME_A, CANARY_X);
            assert.ok(!(await sees(s, NAME_A)).includes(CANARY_X), "X's write under the same name+id must not reach A");
            assert.ok((await sees(s, NAME_A)).includes(CANARY_A));
        });
        await test("rename A, then B creates A's old name: the new workspace starts empty", async () => {
            renameWorkspace(NAME_A, 'tenant-a-renamed', homeO);
            createWorkspace(NAME_A, {}, homeO);
            assert.ok(!(await sees(s, NAME_A)).includes(CANARY_A));
            assert.ok((await sees(s, 'tenant-a-renamed')).includes(CANARY_A), 'A keeps its data under the new name');
        });
        await test('delete A, then recreate the same name: starts empty', async () => {
            deleteWorkspace(NAME_A, homeO);
            deleteWorkspace('tenant-a-renamed', homeO);
            createWorkspace('tenant-a-renamed', {}, homeO);
            assert.ok(!(await sees(s, 'tenant-a-renamed')).includes(CANARY_A));
        });
        await test('unknown workspace fails closed (cloud_scope_workspace_not_allowed) on read and write', async () => {
            await assert.rejects(() => as('never-registered', () => s.graph.getNode('secret-1')), notAllowed);
            await assert.rejects(() => as('never-registered', () => s.graph.upsertNode(node('x', 'x', 'x'))), notAllowed);
            await assert.rejects(() => as('', () => s.vectorStore.search('zebra', 5)), (e: unknown) => e instanceof Error);
        });
        await test('an id-less entry whose id cannot be persisted fails closed', async () => {
            const homeR = mkHome();
            const legacyPath = path.join(homeR, 'legacy');
            fs.mkdirSync(legacyPath);
            writeControl({ active: 'legacy', workspaces: [{ name: 'legacy', path: legacyPath, createdAt: '2026-01-01T00:00:00.000Z' }] } as never, homeR);
            const sr = await build(ORG, homeR);
            fs.chmodSync(homeR, 0o500);
            try {
                await assert.rejects(() => as('legacy', () => sr.graph.getNode('secret-1')), notAllowed);
            } finally { fs.chmodSync(homeR, 0o700); }
        });
        await test('legacy id-less backfill: delete + alias onto the leftover path, and old-build recreate, both start empty', async () => {
            const homeL = mkHome();
            const p = path.join(homeL, 'legacy-ws');
            fs.mkdirSync(p);
            fs.mkdirSync(path.join(homeL, 'default'));
            writeControl({ active: 'default', workspaces: [
                { name: 'default', id: 'id-default-legacy-home', path: path.join(homeL, 'default'), createdAt: '2026-01-01T00:00:00.000Z' },
                { name: 'legacy', path: p, createdAt: '2026-01-01T00:00:00.000Z' }, // pre-#6 entry: no id
            ] } as never, homeL);
            const sl = await build(ORG, homeL);
            await seed(sl, 'legacy', CANARY_A); // lazily backfills the id
            const oldId = loadWorkspaces(homeL).workspaces.find((w) => w.name === 'legacy')!.id;
            assert.ok(oldId, 'backfilled');
            deleteWorkspace('legacy', homeL);
            registerWorkspaceAlias('squatter', p, {}, homeL);
            assert.ok(!(await sees(sl, 'squatter')).includes(CANARY_A), 'alias onto a deleted legacy path must not inherit its rows');
            deleteWorkspace('squatter', homeL);
            const f = loadWorkspaces(homeL);
            f.workspaces.push({ name: 'legacy', path: p, createdAt: '2026-06-01T00:00:00.000Z' } as never); // an old build's recreate: no id
            writeControl(f, homeL);
            assert.ok(!(await sees(sl, 'legacy')).includes(CANARY_A), 'recreated id-less entry must start empty');
        });
        await vectorCloseAll([s]);
    } finally {
        await mock.close();
        for (const h of homes) { try { fs.chmodSync(h, 0o700); fs.rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
}
async function vectorCloseAll(list: Stores[]): Promise<void> { for (const s of list) await s.vectorStore.close(); }

/* ─── item 7: score / ranking side channels (engine-level) ─────────────────────────────────── */

async function sideChannels(): Promise<void> {
    console.log('\nadversarial isolation — score / ranking side channels (ranked keyword search)');
    const w = await startWorld('ranked', { ftsMode: 'ranked' });
    try {
        await seedAttacker(w);
        await w.B.run(async () => {
            await w.B.s.vectorStore.store({ id: 'bx', text: 'apple apple filler one two', metadata: { type: 'note' } });
            await w.B.s.vectorStore.store({ id: 'by', text: 'kiwi filler three four five', metadata: { type: 'note' } });
        });
        const kw = (q: string, limit = 10) => w.B.run(async () => (await w.B.s.vectorStore.bm25Search(q, limit)).hits.map((h) => [h.id, Number(h.score.toFixed(6))]));
        const before = await kw('apple kiwi');
        const crowdBefore = await kw('zebra', 3);
        await test('[ranked] baseline: B ranks its own documents', () => {
            assert.deepEqual(before.map(([id]) => id).sort(), ['b1', 'bx', 'by']);
            assert.ok(crowdBefore.length >= 1);
        });
        // A floods documents containing the query terms, more than the 500-row keyword over-fetch cap
        // (its canary never shows; only B's ranking and hit count move).
        await w.A.run(async () => {
            await w.A.s.vectorStore.storeBatch(Array.from({ length: 600 }, (_, i) => ({ id: `flood-${i}`, text: `apple zebra zebra zebra ${CANARY_A}`, metadata: { type: 'note' } })));
        });
        const after = await kw('apple kiwi');
        const crowdAfter = await kw('zebra', 3);
        await test('[ranked] no canary or victim id in B\'s keyword output after the flood', () => {
            assert.ok(!show([after, crowdAfter]).includes(CANARY_A));
            assert.ok(!show([after, crowdAfter]).includes('flood-'));
        });
        await knownOpen('BM25-CROSS-TENANT-STATS', "B's BM25 scores and ordering do not depend on A's corpus", async () => {
            assert.deepEqual(after, before, `B's ranking moved with A's volume: ${show(before)} -> ${show(after)}`);
        });
        await knownOpen('KEYWORD-CROWD-OUT', "B's keyword results do not shrink when A floods matching documents", async () => {
            assert.deepEqual(crowdAfter.map(([id]) => id), crowdBefore.map(([id]) => id), `B's hits ${show(crowdBefore)} -> ${show(crowdAfter)}`);
        });
    } finally { await w.close(); }
}

/* ─── main ──────────────────────────────────────────────────────────────────────────────────── */

try {
    await suite('full filters', {});
    await suite('sqlite filter-ignoring + vector filter ignored', { queryFilterMode: 'sqlite', vectorFilterMode: 'ignore' });
    await suite('transactions:false', { transactions: false });
    await suite('transactions:fallthrough + sqlite', { transactions: 'fallthrough', queryFilterMode: 'sqlite' });
    await identity();
    await sideChannels();
} catch (e) {
    console.error('fatal:', e);
    failed++;
}
console.log(`\ncloud adversarial isolation: ${passed} passed, ${failed} failed, ${knownOpenHits} known-open (${Object.keys(KNOWN_OPEN).join(', ')})`);
if (failed > 0) process.exitCode = 1;

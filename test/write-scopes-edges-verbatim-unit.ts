#!/usr/bin/env tsx
/**
 * test/write-scopes-edges-verbatim-unit.ts — row-level security_scopes on the
 * WRITE doors for single edges, recall_outcome, changeset commit/rollback and
 * the verbatim write routes (slice C of the write-path scope fix).
 *
 * Contract pinned here, per gated door:
 *   1. bound actor + hidden target  → the response is byte-identical to the
 *      same call against a store where the target does NOT exist, and the
 *      target is untouched (no write, no tombstone, no status change);
 *   2. bound actor + visible target → works as before;
 *   3. unbound caller + hidden target → works as before, with zero lookups;
 *   4. create paths (store_verbatim / POST /api/verbatim): a caller-chosen id
 *      taken by a hidden item → id_unavailable (REST 409, MCP isError); a free
 *      id is created; a visible id is upserted.
 * Plus the verbatim overwrite bug: a re-store with no `security_scopes` keeps
 * the row's labels (explicit array, including [], still wins) on Lance AND SQLite.
 *
 * Run: npm run test:unit:write-scopes-edges-verbatim
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { ID_UNAVAILABLE, ID_UNAVAILABLE_MESSAGE } from '../packages/lore/src/security/writeTargetGate.js';
import { assertEdgeEndpoints } from '../packages/lore/src/engines/dataplaneEdgeShape.js';
import { tryEdgesRoutes } from '../packages/lore/src/mcp/http/routes/edges.js';
import { registerStoreEdgeTool } from '../packages/lore/src/mcp/tools/memory/storeEdge.js';
import { registerDeleteEdgeTool } from '../packages/lore/src/mcp/tools/memory/deleteEdge.js';
import { registerRecallOutcomeTool } from '../packages/lore/src/mcp/tools/search/recallOutcomeTool.js';
import { tryRecallOutcomeRoute, type RecallOutcomeRouteDeps } from '../packages/lore/src/mcp/http/routes/recallOutcome.js';
import { registerVersioningTools, type VersioningDeps } from '../packages/lore/src/mcp/tools/versioning.js';
import { tryVersioningRoutes } from '../packages/lore/src/mcp/http/routes/versioning.js';
import { tryVerbatimRoutes } from '../packages/lore/src/mcp/http/routes/retention/verbatim.js';
import { registerVerbatimTools } from '../packages/lore/src/mcp/tools/verbatim.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import type { MemoryToolsDeps } from '../packages/lore/src/mcp/tools/memory/types.js';
import type { SearchToolsDeps } from '../packages/lore/src/mcp/tools/search/types.js';
import type { EmbeddingProvider, LoreEdge } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WS = 'wsc';
const bound = <T>(scopes: string[], fn: () => Promise<T>): Promise<T> => runWithActor({ portalUserId: 'u', scopes }, fn);
/** Hidden from ['sales']; visible to ['finance']. */
const HIDDEN = ['finance'];
const SALES = ['sales'];

// ───────────────────────── shared HTTP / MCP plumbing ─────────────────────────

interface Out { status: number; body: string }
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function req(method: string, body = ''): IncomingMessage {
    let consumed = false;
    return {
        method, headers: { 'content-type': 'application/json' },
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed && body !== '') { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ToolBag = Record<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
function captureTools(register: (server: never) => void): ToolBag {
    const tools: ToolBag = {};
    register({
        tool: (name: string, ...rest: unknown[]) => {
            const h = rest[rest.length - 1];
            if (typeof h === 'function') tools[name] = h as ToolBag[string];
        },
    } as never);
    return tools;
}
const mcpOut = (r: ToolResult): Out => ({ status: r.isError ? 1 : 0, body: r.content[0]!.text });

// ───────────────────────── Part 1 — single edges ─────────────────────────

/** In-memory graph with scoped nodes; the engine's own endpoint check for missing nodes. */
function edgeGraph(nodes: Record<string, string[] | undefined>) {
    const edges: LoreEdge[] = [];
    const calls = { getNode: 0, addEdge: 0, deleteEdge: 0 };
    const present = (): Set<string> => new Set(Object.keys(nodes));
    const key = (s: string, t: string, r: string): string => `${s}|${t}|${r}`;
    const g = {
        edges, calls,
        async getNode(id: string) {
            calls.getNode++;
            return id in nodes ? { id, type: 'note', label: id, content: id, ...(nodes[id] ? { security_scopes: nodes[id] } : {}) } : null;
        },
        async addEdge(e: LoreEdge) {
            calls.addEdge++;
            assertEdgeEndpoints(e, present());
            if (!edges.some((x) => key(x.sourceId, x.targetId, x.relation) === key(e.sourceId, e.targetId, e.relation))) edges.push({ ...e });
        },
        async addBidirectionalEdge(e: LoreEdge) {
            await g.addEdge(e);
            await g.addEdge({ ...e, sourceId: e.targetId, targetId: e.sourceId });
        },
        async getEdge(s: string, t: string, r: string) { return edges.find((x) => key(x.sourceId, x.targetId, x.relation) === key(s, t, r)) ?? null; },
        async deleteEdge(s: string, t: string, r: string) {
            calls.deleteEdge++;
            const before = edges.length;
            const keep = edges.filter((x) => key(x.sourceId, x.targetId, x.relation) !== key(s, t, r));
            edges.length = 0; edges.push(...keep);
            return before - keep.length;
        },
        async queryEdges() { return edges; },
    };
    return g;
}
type EdgeGraph = ReturnType<typeof edgeGraph>;
const REL = 'depends_on';
const seedEdge = (g: EdgeGraph, s: string, t: string): void => { g.edges.push({ sourceId: s, targetId: t, relation: REL, confidence: 'extracted', confidenceScore: 1 } as LoreEdge); };

async function restPostEdge(g: EdgeGraph, sourceId: string, targetId: string, bidirectional?: boolean): Promise<Out> {
    const res = fakeRes();
    await tryEdgesRoutes(
        req('POST', JSON.stringify({ sourceId, targetId, relation: REL, workspace: WS, ...(bidirectional === undefined ? {} : { bidirectional }) })),
        res, '/api/edge', '/api/edge',
        { deploymentMode: 'local', dataplane: null, store: { loreGraph: g } as never, auditLog: { log: () => undefined } as never },
    );
    return { status: res._status, body: res._body };
}
async function restDeleteEdge(g: EdgeGraph, sourceId: string, targetId: string): Promise<Out> {
    const res = fakeRes();
    await tryEdgesRoutes(
        req('DELETE'), res,
        `/api/edge?sourceId=${sourceId}&targetId=${targetId}&relation=${REL}&workspace=${WS}`, '/api/edge',
        { deploymentMode: 'local', dataplane: null, store: { loreGraph: g } as never, auditLog: { log: () => undefined } as never },
    );
    return { status: res._status, body: res._body };
}
function edgeTools(g: EdgeGraph): ToolBag {
    const deps = {
        store: { loreGraph: g } as never,
        configManager: {} as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: WS, ecosystem: '*' },
        getWal: () => ({ append: () => undefined }),
        domain: 'lore',
        edgeRelations: [REL],
        nodeTypesEnum: z.enum(['note']),
        nodeTypesDescription: 'note',
        edgeRelationsEnum: z.enum([REL]),
        coreNodeTypes: ['note'],
    } as unknown as MemoryToolsDeps;
    return captureTools((server) => { registerStoreEdgeTool(server, deps); registerDeleteEdgeTool(server, deps); });
}
async function mcpStoreEdge(g: EdgeGraph, sourceId: string, targetId: string): Promise<Out> {
    return mcpOut(await edgeTools(g)['store_edge']!({ sourceId, targetId, relation: REL, workspace: WS, bidirectional: true }));
}
async function mcpDeleteEdge(g: EdgeGraph, sourceId: string, targetId: string): Promise<Out> {
    return mcpOut(await edgeTools(g)['delete_edge']!({ source_id: sourceId, target_id: targetId, relation: REL, workspace: WS }));
}

console.log('edges — REST + MCP, create and delete\n');

type EdgeDoor = { name: string; create: (g: EdgeGraph, s: string, t: string) => Promise<Out>; del: (g: EdgeGraph, s: string, t: string) => Promise<Out> };
const EDGE_DOORS: EdgeDoor[] = [
    { name: 'REST /api/edge', create: (g, s, t) => restPostEdge(g, s, t), del: restDeleteEdge },
    { name: 'MCP store_edge / delete_edge', create: mcpStoreEdge, del: mcpDeleteEdge },
];

for (const door of EDGE_DOORS) {
    for (const [label, src, tgt] of [['hidden target', 'src', 'hid'], ['hidden source', 'hid', 'src']] as const) {
        await test(`${door.name} create: bound + ${label} answers exactly like a missing endpoint, nothing written`, async () => {
            const withHidden = edgeGraph({ src: [], hid: HIDDEN });
            const withoutIt = edgeGraph({ src: [] });
            const hiddenOut = await bound(SALES, () => door.create(withHidden, src, tgt));
            const missingOut = await bound(SALES, () => door.create(withoutIt, src, tgt));
            assert.deepEqual(hiddenOut, missingOut);
            assert.match(hiddenOut.body, /edge_endpoint_missing|not found/i, hiddenOut.body);
            assert.notEqual(hiddenOut.status, 200);
            assert.equal(withHidden.calls.addEdge, 0, 'no engine write attempted');
            assert.deepEqual(withHidden.edges, []);
        });
    }
    await test(`${door.name} create: hidden source + truly missing target names both, like two missing endpoints`, async () => {
        const withHidden = edgeGraph({ hid: HIDDEN });
        const withoutIt = edgeGraph({});
        const a = await bound(SALES, () => door.create(withHidden, 'hid', 'ghost'));
        const b = await bound(SALES, () => door.create(withoutIt, 'hid', 'ghost'));
        assert.deepEqual(a, b);
        assert.match(a.body, /source '[^']+' and target '[^']+'/); // MCP redacts ids to hashes
    });
    await test(`${door.name} create: bound + visible endpoints works as before`, async () => {
        const g = edgeGraph({ src: [], hid: HIDDEN });
        const out = await bound(HIDDEN, () => door.create(g, 'src', 'hid'));
        assert.ok(out.status === 200 || out.status === 0, out.body);
        assert.equal(g.edges.length, 2, 'bidirectional pair written');
    });
    await test(`${door.name} create: unbound + hidden endpoint works as before, zero gate lookups`, async () => {
        const g = edgeGraph({ src: [], hid: HIDDEN });
        const out = await door.create(g, 'src', 'hid');
        assert.ok(out.status === 200 || out.status === 0, out.body);
        assert.equal(g.edges.length, 2);
        assert.equal(g.calls.getNode, 0, 'unbound caller does no scope lookups');
    });

    await test(`${door.name} delete: bound + hidden endpoint answers exactly like no such edge, edge kept`, async () => {
        const withHidden = edgeGraph({ src: [], hid: HIDDEN });
        seedEdge(withHidden, 'src', 'hid');
        const withoutIt = edgeGraph({ src: [] });
        const hiddenOut = await bound(SALES, () => door.del(withHidden, 'src', 'hid'));
        const missingOut = await bound(SALES, () => door.del(withoutIt, 'src', 'hid'));
        assert.deepEqual(hiddenOut, missingOut);
        assert.equal(withHidden.calls.deleteEdge, 0, 'no engine delete attempted');
        assert.equal(withHidden.edges.length, 1, 'edge untouched');
    });
    await test(`${door.name} delete: bound + visible endpoints deletes as before`, async () => {
        const g = edgeGraph({ src: [], hid: HIDDEN });
        seedEdge(g, 'src', 'hid');
        const out = await bound(HIDDEN, () => door.del(g, 'src', 'hid'));
        assert.ok(out.status === 200 || out.status === 0, out.body);
        assert.equal(g.edges.length, 0);
    });
    await test(`${door.name} delete: unbound + hidden endpoint deletes as before, zero gate lookups`, async () => {
        const g = edgeGraph({ src: [], hid: HIDDEN });
        seedEdge(g, 'src', 'hid');
        const out = await door.del(g, 'src', 'hid');
        assert.ok(out.status === 200 || out.status === 0, out.body);
        assert.equal(g.edges.length, 0);
        assert.equal(g.calls.getNode, 0);
    });
}

// ───────────────────────── Part 2 — recall_outcome ─────────────────────────

interface OutcomeRig { toolDeps: SearchToolsDeps; routeDeps: RecallOutcomeRouteDeps; rows: unknown[]; nodes: Record<string, { security_scopes?: string[] }> }
function outcomeRig(nodes: Record<string, { security_scopes?: string[] }>): OutcomeRig {
    const rows: unknown[] = [];
    const auxStore = {
        recordOutcome(o: unknown) { rows.push(o); },
        getOutcomeCount: () => ({ success: rows.length, failure: 0, partial: 0 }),
        getOutcomes: () => [],
        incrementCounter() { /* noop */ },
    };
    const graph = {
        async initialize() { /* noop */ },
        async getNode(id: string) { return nodes[id] ? { id, type: 'note', label: id, content: 'c', tags: [], project: 'w', ecosystem: '*', ...nodes[id] } : null; },
        async upsertNode(n: unknown) { return n; },
        async getNodesByIds() { return new Map(); },
    };
    const graphRegistry = { getOrOpen: async () => graph, getGraphHandle: async () => graph };
    const store = { loreGraph: graph };
    return {
        rows, nodes,
        toolDeps: { store, detectedScope: { workspace: WS, ecosystem: '*' }, graphRegistry, auxStore } as unknown as SearchToolsDeps,
        routeDeps: { store, deploymentMode: 'local', dataplane: null, graphRegistry, auxStore } as unknown as RecallOutcomeRouteDeps,
    };
}
async function mcpRecallOutcome(rig: OutcomeRig, nodeId: string): Promise<Out> {
    const tools = captureTools((s) => registerRecallOutcomeTool(s, rig.toolDeps));
    return mcpOut(await tools['recall_outcome']!({ nodeId, workspace: WS, outcome: 'success' }));
}
async function restRecallOutcome(rig: OutcomeRig, nodeId: string): Promise<Out> {
    const res = fakeRes();
    await tryRecallOutcomeRoute(
        req('POST', JSON.stringify({ node_id: nodeId, workspace: WS, outcome: 'success' })),
        res, '/api/recall/outcome', '/api/recall/outcome', rig.routeDeps,
    );
    return { status: res._status, body: res._body };
}

console.log('\nrecall_outcome — MCP + REST\n');
for (const [name, call, okStatus] of [['MCP recall_outcome', mcpRecallOutcome, 0], ['REST POST /api/recall/outcome', restRecallOutcome, 200]] as const) {
    await test(`${name}: bound + hidden node answers exactly like a missing node, nothing recorded`, async () => {
        const h = outcomeRig({ n1: { security_scopes: HIDDEN } });
        const m = outcomeRig({});
        const a = await bound(SALES, () => call(h, 'n1'));
        const b = await bound(SALES, () => call(m, 'n1'));
        assert.deepEqual(a, b);
        assert.match(a.body, /node_not_found/);
        assert.equal(h.rows.length, 0);
    });
    await test(`${name}: bound + visible node records as before`, async () => {
        const h = outcomeRig({ n1: { security_scopes: HIDDEN } });
        const out = await bound(HIDDEN, () => call(h, 'n1'));
        assert.equal(out.status, okStatus, out.body);
        assert.equal(h.rows.length, 1);
    });
    await test(`${name}: unbound + hidden node records as before`, async () => {
        const h = outcomeRig({ n1: { security_scopes: HIDDEN } });
        const out = await call(h, 'n1');
        assert.equal(out.status, okStatus, out.body);
        assert.equal(h.rows.length, 1);
    });
}

// ───────────────────────── Part 3 — changeset commit / rollback ─────────────────────────

type Write = { seq: number; operation: 'upsert_node' | 'delete_node'; payload: Record<string, unknown> };
type Version = Record<string, unknown>;
interface CsRig {
    deps: VersioningDeps;
    nodes: Map<string, Record<string, unknown>>;
    versions: Version[];
    status: () => string;
    verbatimWrites: string[];
    tombstones: string[];
    updates: number;
}
/** `exists` false = the changeset id is unknown (the missing-id reference answer). */
function csRig(o: { exists: boolean; status?: string; writes?: Write[]; versions?: Version[]; nodes?: Record<string, string[] | undefined>; log?: Record<string, Version[]> }): CsRig {
    let status = o.status ?? 'open';
    const versions: Version[] = [...(o.versions ?? [])];
    const nodes = new Map<string, Record<string, unknown>>();
    for (const [id, sc] of Object.entries(o.nodes ?? {})) nodes.set(id, { id, type: 'note', label: id, content: `c ${id}`, ...(sc ? { security_scopes: sc } : {}) });
    const rig = { updates: 0 } as CsRig;
    const versionStore = {
        getChangeset: () => (o.exists ? { changesetId: 'cs-1', id: 'cs-1', workspace: WS, status } : undefined),
        getChangesetWrites: () => o.writes ?? [],
        getVersionsByChangeset: () => versions,
        recordVersion: (v: Version) => { versions.push(v); },
        updateChangeset: (_id: string, s: string) => { status = s; rig.updates++; },
        getVersions: (id: string) => o.log?.[id] ?? [],
        createChangeset: () => 'cs-1', getDiff: () => [], addChangesetWrite: () => 1,
    };
    const graph = {
        async initialize() { /* noop */ },
        async upsertNode(n: Record<string, unknown>) { nodes.set(String(n['id']), n); return n; },
        async getNode(id: string) { return nodes.get(id) ?? null; },
        async deleteNode(id: string) { return nodes.delete(id); },
    };
    const verbatimWrites: string[] = []; const tombstones: string[] = [];
    const store = {
        loreGraph: graph,
        storageClient: { verbatimStore: async (d: { id: string }) => { verbatimWrites.push(d.id); } },
        loreVerbatim: { tombstone: async (id: string) => { tombstones.push(id); } },
    };
    Object.assign(rig, {
        nodes, versions, status: () => status, verbatimWrites, tombstones,
        deps: { versionStore, store, graphRegistry: undefined, detectedScope: { workspace: WS, ecosystem: '*' } } as unknown as VersioningDeps,
    });
    return rig;
}
const up = (id: string): Write => ({ seq: 0, operation: 'upsert_node', payload: { workspace: WS, nodeData: { id, type: 'note', label: id, content: 'new' } } });
const del = (id: string): Write => ({ seq: 1, operation: 'delete_node', payload: { workspace: WS, node_id: id } });

async function mcpCs(rig: CsRig, action: 'commit' | 'rollback'): Promise<Out> {
    const tools = captureTools((s) => registerVersioningTools(s, rig.deps));
    return mcpOut(await tools[`${action}_changeset`]!({ changeset_id: 'cs-1' }));
}
async function restCs(rig: CsRig, action: 'commit' | 'rollback'): Promise<Out> {
    const res = fakeRes();
    const p = `/api/changesets/cs-1/${action}`;
    await tryVersioningRoutes(req('POST', '{}'), res, p, p, { ...rig.deps, deploymentMode: 'local', dataplane: null } as never);
    return { status: res._status, body: res._body };
}

console.log('\nchangesets — commit + rollback, MCP + REST\n');
for (const [name, run, okStatus] of [['MCP', mcpCs, 0], ['REST', restCs, 200]] as const) {
    const cases: Array<[string, Write[], Record<string, string[] | undefined>, Record<string, Version[]>?]> = [
        ['upsert onto a hidden node', [up('hid')], { hid: HIDDEN }],
        ['delete of a hidden node', [del('hid')], { hid: HIDDEN }],
        ['create of an id held by a hidden deleted node', [up('gone')], {}, { gone: [{ newState: null, previousState: { security_scopes: HIDDEN } }] }],
    ];
    for (const [label, writes, nodes, log] of cases) {
        await test(`${name} commit: bound + ${label} answers exactly like a missing changeset, nothing applied`, async () => {
            const h = csRig({ exists: true, writes, nodes, log });
            const m = csRig({ exists: false });
            const before = JSON.stringify([...h.nodes]);
            const a = await bound(SALES, () => run(h, 'commit'));
            const b = await bound(SALES, () => run(m, 'commit'));
            assert.deepEqual(a, b);
            assert.match(a.body, /changeset_not_found/);
            assert.equal(h.status(), 'open', 'changeset status untouched');
            assert.equal(h.versions.length, 0, 'no version row');
            assert.equal(JSON.stringify([...h.nodes]), before, 'graph untouched');
            assert.deepEqual([h.verbatimWrites, h.tombstones], [[], []]);
        });
    }
    await test(`${name} commit: a hidden node in an ALREADY committed changeset also answers as missing (state not revealed)`, async () => {
        const h = csRig({ exists: true, status: 'committed', writes: [up('hid')], nodes: { hid: HIDDEN } });
        const m = csRig({ exists: false });
        assert.deepEqual(await bound(SALES, () => run(h, 'commit')), await bound(SALES, () => run(m, 'commit')));
    });
    await test(`${name} commit: bound + visible node commits as before`, async () => {
        const h = csRig({ exists: true, writes: [up('hid')], nodes: { hid: HIDDEN } });
        const out = await bound(HIDDEN, () => run(h, 'commit'));
        assert.equal(out.status, okStatus, out.body);
        assert.match(out.body, /committed/);
        assert.equal(h.status(), 'committed');
        assert.equal(h.nodes.get('hid')?.['content'], 'new');
    });
    await test(`${name} commit: bound + free ids (create a new node, delete a public one) commits as before`, async () => {
        const h = csRig({ exists: true, writes: [up('fresh'), del('pub')], nodes: { pub: [] } });
        const out = await bound(SALES, () => run(h, 'commit'));
        assert.equal(out.status, okStatus, out.body);
        assert.equal(h.status(), 'committed');
        assert.ok(h.nodes.has('fresh') && !h.nodes.has('pub'));
    });
    await test(`${name} commit: unbound + hidden node commits as before`, async () => {
        const h = csRig({ exists: true, writes: [up('hid'), del('hid2')], nodes: { hid: HIDDEN, hid2: HIDDEN } });
        const out = await run(h, 'commit');
        assert.equal(out.status, okStatus, out.body);
        assert.equal(h.status(), 'committed');
        assert.ok(!h.nodes.has('hid2'));
    });

    const committedVersions = (id: string): Version[] => [{ nodeId: id, workspace: WS, operation: 'upsert', previousState: { id, type: 'note', label: 'orig', content: 'orig' } }];
    await test(`${name} rollback: bound + hidden node answers exactly like a missing changeset, nothing reversed`, async () => {
        const h = csRig({ exists: true, status: 'committed', versions: committedVersions('hid'), nodes: { hid: HIDDEN } });
        const m = csRig({ exists: false });
        const a = await bound(SALES, () => run(h, 'rollback'));
        const b = await bound(SALES, () => run(m, 'rollback'));
        assert.deepEqual(a, b);
        assert.match(a.body, /changeset_not_found/);
        assert.equal(h.status(), 'committed');
        assert.equal(h.nodes.get('hid')?.['content'], 'c hid', 'node not restored');
    });
    await test(`${name} rollback: a hidden node in an already rolled-back changeset also answers as missing`, async () => {
        const h = csRig({ exists: true, status: 'rolled_back', versions: committedVersions('hid'), nodes: { hid: HIDDEN } });
        const m = csRig({ exists: false });
        assert.deepEqual(await bound(SALES, () => run(h, 'rollback')), await bound(SALES, () => run(m, 'rollback')));
    });
    await test(`${name} rollback: bound + visible node rolls back as before`, async () => {
        const h = csRig({ exists: true, status: 'committed', versions: committedVersions('hid'), nodes: { hid: HIDDEN } });
        const out = await bound(HIDDEN, () => run(h, 'rollback'));
        assert.equal(out.status, okStatus, out.body);
        assert.equal(h.status(), 'rolled_back');
        assert.equal(h.nodes.get('hid')?.['content'], 'orig');
    });
    await test(`${name} rollback: unbound + hidden node rolls back as before`, async () => {
        const h = csRig({ exists: true, status: 'committed', versions: committedVersions('hid'), nodes: { hid: HIDDEN } });
        const out = await run(h, 'rollback');
        assert.equal(out.status, okStatus, out.body);
        assert.equal(h.status(), 'rolled_back');
    });
}

// ───────────────────────── Parts 4 + 5 — verbatim routes + store_verbatim ─────────────────────────

interface VRow { id: string; text: string; security_scopes: string[] }
function fakeVerbatim(rows: Record<string, string[]>) {
    const data = new Map<string, VRow>(Object.entries(rows).map(([id, sc]) => [id, { id, text: `orig ${id}`, security_scopes: sc }]));
    const calls = { getById: 0, store: 0, tombstone: [] as string[] };
    return {
        data, calls,
        async getById(id: string) { calls.getById++; return data.get(id) ?? null; },
        async store(doc: { id: string; text: string; metadata?: { security_scopes?: string[] } }) {
            calls.store++;
            data.set(doc.id, { id: doc.id, text: doc.text, security_scopes: doc.metadata?.security_scopes ?? data.get(doc.id)?.security_scopes ?? [] });
        },
        async tombstone(id: string) { calls.tombstone.push(id); },
        async listIds(prefix?: string) { return [...data.keys()].filter((k) => !prefix || k.startsWith(prefix)); },
    };
}
type FakeVerbatim = ReturnType<typeof fakeVerbatim>;
interface VRig { v: FakeVerbatim; graphNodes: Record<string, string[]>; deps: Record<string, unknown>; resolverStore?: FakeVerbatim }
function vRig(rows: Record<string, string[]>, o: { graphNodes?: Record<string, string[]>; viaResolver?: boolean } = {}): VRig {
    const v = fakeVerbatim(rows);
    const graphNodes = o.graphNodes ?? {};
    const graph = { async getNode(id: string) { return id in graphNodes ? { id, security_scopes: graphNodes[id] } : null; } };
    const store = {
        loreGraph: graph,
        loreVerbatim: o.viaResolver ? fakeVerbatim({}) : v,
        storageClient: { verbatimStore: (d: never) => v.store(d), getNode: async () => null },
    };
    const deps: Record<string, unknown> = {
        deploymentMode: 'local', dataplane: null, store, detectedScope: { workspace: WS, ecosystem: '*' },
        ...(o.viaResolver ? { workspaceVerbatimResolver: { getOrOpen: async () => v } } : {}),
    };
    return { v, graphNodes, deps, resolverStore: o.viaResolver ? v : undefined };
}
async function restVerbatim(rig: VRig, route: 'store' | 'tombstone' | 'reap', body: Record<string, unknown>): Promise<Out> {
    const p = route === 'store' ? '/api/verbatim' : `/api/verbatim/${route}`;
    const res = fakeRes();
    await tryVerbatimRoutes(req('POST', JSON.stringify(body)), res, p, rig.deps as never, p);
    return { status: res._status, body: res._body };
}
async function mcpStoreVerbatim(rig: VRig, body: { id: string; text: string }): Promise<Out> {
    const tools = captureTools((s) => registerVerbatimTools(s, rig.deps as never));
    return mcpOut(await tools['store_verbatim']!({ ...body, workspace: WS }));
}

console.log('\nverbatim tombstone + reap — REST\n');

await test('tombstone: bound + hidden row answers exactly like a missing id, row untouched', async () => {
    const h = vRig({ doc1: HIDDEN });
    const m = vRig({});
    const a = await bound(SALES, () => restVerbatim(h, 'tombstone', { id: 'doc1' }));
    const b = await bound(SALES, () => restVerbatim(m, 'tombstone', { id: 'doc1' }));
    assert.deepEqual(a, b);
    assert.equal(a.status, 200);
    assert.deepEqual(h.v.calls.tombstone, []);
    assert.equal(h.v.data.get('doc1')!.text, 'orig doc1');
});
await test('tombstone: a hidden live graph node behind the same id is hidden too', async () => {
    const h = vRig({ n1: [] }, { graphNodes: { n1: HIDDEN } });
    const out = await bound(SALES, () => restVerbatim(h, 'tombstone', { id: 'n1' }));
    assert.equal(out.status, 200);
    assert.deepEqual(h.v.calls.tombstone, []);
});
await test('tombstone: bound + visible row tombstones as before', async () => {
    const h = vRig({ doc1: HIDDEN });
    const out = await bound(HIDDEN, () => restVerbatim(h, 'tombstone', { id: 'doc1' }));
    assert.equal(out.status, 200);
    assert.deepEqual(h.v.calls.tombstone, ['doc1']);
});
await test('tombstone: unbound + hidden row tombstones as before, zero lookups', async () => {
    const h = vRig({ doc1: HIDDEN });
    const out = await restVerbatim(h, 'tombstone', { id: 'doc1' });
    assert.equal(out.status, 200);
    assert.deepEqual(h.v.calls.tombstone, ['doc1']);
    assert.equal(h.v.calls.getById, 0);
});

await test('reap: bound actor does not see or tombstone hidden rows (counts equal a store without them)', async () => {
    const h = vRig({ 'lore:a': HIDDEN, 'lore:b': [] });
    const m = vRig({ 'lore:b': [] });
    const a = await bound(SALES, () => restVerbatim(h, 'reap', { apply: true }));
    const b = await bound(SALES, () => restVerbatim(m, 'reap', { apply: true }));
    assert.deepEqual(a, b);
    assert.deepEqual(h.v.calls.tombstone, ['lore:b']);
    assert.equal(JSON.parse(a.body).inspected, 1);
});
await test('reap: bound + visible rows reaped as before; unbound sees every row', async () => {
    const vis = vRig({ 'lore:a': HIDDEN, 'lore:b': [] });
    const outV = await bound(HIDDEN, () => restVerbatim(vis, 'reap', { apply: true }));
    assert.equal(JSON.parse(outV.body).inspected, 2);
    const unb = vRig({ 'lore:a': HIDDEN, 'lore:b': [] });
    const outU = await restVerbatim(unb, 'reap', { apply: true });
    assert.equal(JSON.parse(outU.body).inspected, 2);
    assert.deepEqual(unb.v.calls.tombstone.sort(), ['lore:a', 'lore:b']);
    assert.equal(unb.v.calls.getById, 0);
});

const REV = (id: string, n: number) => `${id}#rev2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.${String(Math.floor(n / 60)).padStart(3, '0')}Z`;

await test('reap: hidden #rev history rows are not counted (decided by their canonical item); response equals a store without them', async () => {
    const h = vRig({ 'lore:a': HIDDEN, [REV('lore:a', 1)]: HIDDEN, [REV('lore:a', 2)]: HIDDEN, 'lore:b': [], [REV('lore:b', 1)]: [] });
    const m = vRig({ 'lore:b': [], [REV('lore:b', 1)]: [] });
    const a = await bound(SALES, () => restVerbatim(h, 'reap', { apply: true }));
    const b = await bound(SALES, () => restVerbatim(m, 'reap', { apply: true }));
    assert.deepEqual(a, b);
    assert.equal(JSON.parse(a.body).inspected, 2, 'b + b#rev only');
    assert.deepEqual(h.v.calls.tombstone, ['lore:b']);
    // a history row is NOT trusted on its own scopes: a public-looking #rev of a hidden item stays hidden
    const trap = vRig({ 'lore:a': HIDDEN, [REV('lore:a', 1)]: [] });
    const t = await bound(SALES, () => restVerbatim(trap, 'reap', { apply: false }));
    assert.equal(JSON.parse(t.body).inspected, 0);
    // a visible actor still counts the history rows
    const vis = await bound(HIDDEN, () => restVerbatim(vRig({ 'lore:a': HIDDEN, [REV('lore:a', 1)]: HIDDEN }), 'reap', { apply: false }));
    assert.equal(JSON.parse(vis.body).inspected, 2);
});

await test('reap: lookups are one per distinct canonical item, not per listed row (many history rows of one hidden item)', async () => {
    const rows: Record<string, string[]> = { 'lore:a': HIDDEN, 'lore:b': [] };
    for (let i = 0; i < 200; i++) { rows[REV('lore:a', i)] = HIDDEN; rows[REV('lore:b', i)] = []; }
    const h = vRig(rows);
    const out = await bound(SALES, () => restVerbatim(h, 'reap', { apply: false }));
    assert.equal(JSON.parse(out.body).inspected, 201, 'b + its 200 revs');
    assert.ok(h.v.calls.getById <= 2, `expected <= 2 canonical lookups, saw ${h.v.calls.getById}`);
});

await test('reap: bound page is filled by VISIBLE rows — truncated/inspected never reveal hidden rows; response equals a store without them', async () => {
    // 10,050 listed rows, half hidden: only 5,025 are visible, so there is nothing to truncate.
    const rows: Record<string, string[]> = {};
    const visibleOnly: Record<string, string[]> = {};
    for (let i = 0; i < 10_050; i++) {
        const id = `lore:doc${String(i).padStart(5, '0')}`;
        rows[id] = i % 2 === 0 ? HIDDEN : [];
        if (i % 2 !== 0) visibleOnly[id] = [];
    }
    const b = vRig(rows);
    const out = await bound(SALES, () => restVerbatim(b, 'reap', { apply: false }));
    const j = JSON.parse(out.body);
    assert.equal('truncated' in j, false, 'visible rows are under the cap: not truncated (old code leaked 10000 - inspected)');
    assert.equal('totalIds' in j, false, 'a bound actor is not told the raw listing size');
    assert.equal(j.inspected, 5_025);
    const m = vRig(visibleOnly);
    assert.deepEqual(out, await bound(SALES, () => restVerbatim(m, 'reap', { apply: false })), 'identical to a store without the hidden rows');
    const u = vRig(rows);
    const uj = JSON.parse((await restVerbatim(u, 'reap', { apply: false })).body);
    assert.equal(uj.totalIds, 10_050);
    assert.equal(uj.inspected, 10_000);
    assert.equal(uj.truncated, true);
    assert.equal(u.v.calls.getById, 0, 'unbound: zero lookups');
});

await test('reap: visible rows past the raw 10000 cap are reachable for a bound actor; truncated reflects visible rows only', async () => {
    // 3 hidden for every 4 listed; 10,001 visible rows exist, interleaved with hidden ones.
    const rows: Record<string, string[]> = {};
    const visibleOnly: Record<string, string[]> = {};
    let nVisible = 0;
    for (let i = 0; nVisible < 10_001; i++) {
        const id = `lore:doc${String(i).padStart(6, '0')}`;
        if (i % 4 === 3) { rows[id] = []; visibleOnly[id] = []; nVisible++; } else rows[id] = HIDDEN;
    }
    const h = vRig(rows);
    const out = await bound(SALES, () => restVerbatim(h, 'reap', { apply: false }));
    const j = JSON.parse(out.body);
    assert.equal(j.inspected, 10_000);
    assert.equal(j.truncated, true);
    assert.equal('totalIds' in j, false);
    assert.deepEqual(out, await bound(SALES, () => restVerbatim(vRig(visibleOnly), 'reap', { apply: false })), 'identical to a store without the hidden rows');
    // exactly 10,000 visible rows -> not truncated, same as the store without hidden rows
    const exact = Object.fromEntries(Object.entries(visibleOnly).slice(0, 10_000));
    const exactRows: Record<string, string[]> = {};
    for (const [id, sc] of Object.entries(rows)) if (sc.length > 0 || id in exact) exactRows[id] = sc;
    const e = await bound(SALES, () => restVerbatim(vRig(exactRows), 'reap', { apply: false }));
    assert.equal('truncated' in JSON.parse(e.body), false);
    assert.deepEqual(e, await bound(SALES, () => restVerbatim(vRig(exact), 'reap', { apply: false })));
});

await test('reap: bound raw scan is bounded — a listing that is all hidden past the bound stops (truncated), lookups <= 50000', async () => {
    const rows: Record<string, string[]> = {};
    for (let i = 0; i < 60_000; i++) rows[`lore:doc${String(i).padStart(5, '0')}`] = HIDDEN;
    const h = vRig(rows);
    const out = await bound(SALES, () => restVerbatim(h, 'reap', { apply: false }));
    const j = JSON.parse(out.body);
    assert.equal(j.inspected, 0);
    assert.equal(j.truncated, true, 'raw-scan bound hit: may have more');
    assert.ok(h.v.calls.getById <= 50_000, `lookups ${h.v.calls.getById} exceed the raw scan bound`);
});

console.log('\nstore_verbatim / POST /api/verbatim — create-with-chosen-id\n');

const REV_ID = 'doc1#rev2026-01-01T00:00:00.000Z';
type VDoor = { name: string; call: (rig: VRig, id: string) => Promise<Out>; ok: (o: Out) => boolean; refused: (o: Out) => void };
const V_DOORS: VDoor[] = [
    {
        name: 'REST POST /api/verbatim',
        call: (rig, id) => restVerbatim(rig, 'store', { id, text: 'NEW text', workspace: WS }),
        ok: (o) => o.status === 200,
        refused: (o) => {
            assert.equal(o.status, 409, o.body);
            const j = JSON.parse(o.body);
            assert.equal(j.code, ID_UNAVAILABLE);
            assert.equal(j.message ?? j.error, ID_UNAVAILABLE_MESSAGE);
        },
    },
    {
        name: 'MCP store_verbatim',
        call: (rig, id) => mcpStoreVerbatim(rig, { id, text: 'NEW text' }),
        ok: (o) => o.status === 0,
        refused: (o) => {
            assert.equal(o.status, 1, o.body);
            assert.deepEqual(JSON.parse(o.body), { error: ID_UNAVAILABLE, message: ID_UNAVAILABLE_MESSAGE });
        },
    },
];
for (const door of V_DOORS) {
    for (const viaResolver of [false, true]) {
        const via = viaResolver ? ' (per-workspace resolver)' : '';
        await test(`${door.name}${via}: bound + id held by a hidden verbatim row → id_unavailable, row unchanged`, async () => {
            const h = vRig({ doc1: HIDDEN }, { viaResolver });
            door.refused(await bound(SALES, () => door.call(h, 'doc1')));
            assert.equal(h.v.calls.store, 0);
            assert.equal(h.v.data.get('doc1')!.text, 'orig doc1');
        });
    }
    await test(`${door.name}: bound + id held by a hidden live graph node → id_unavailable`, async () => {
        const h = vRig({}, { graphNodes: { doc1: HIDDEN } });
        door.refused(await bound(SALES, () => door.call(h, 'doc1')));
        assert.equal(h.v.calls.store, 0);
    });
    await test(`${door.name}: bound + id held by a hidden deleted node's version log → id_unavailable`, async () => {
        const h = vRig({});
        (h.deps as { versionStore?: unknown }).versionStore = { getVersions: async () => [{ newState: null, previousState: { security_scopes: HIDDEN } }] };
        door.refused(await bound(SALES, () => door.call(h, 'doc1')));
        assert.equal(h.v.calls.store, 0);
    });
    await test(`${door.name}: bound + free id → created`, async () => {
        const h = vRig({ other: HIDDEN });
        assert.ok(door.ok(await bound(SALES, () => door.call(h, 'fresh'))));
        assert.equal(h.v.data.get('fresh')!.text, 'NEW text');
    });
    await test(`${door.name}: bound + visible id → upserted as before`, async () => {
        const h = vRig({ doc1: HIDDEN });
        assert.ok(door.ok(await bound(HIDDEN, () => door.call(h, 'doc1'))));
        assert.equal(h.v.data.get('doc1')!.text, 'NEW text');
    });
    await test(`${door.name}: unbound + id held by a hidden row → upserted as before, zero lookups`, async () => {
        const h = vRig({ doc1: HIDDEN });
        assert.ok(door.ok(await door.call(h, 'doc1')));
        assert.equal(h.v.data.get('doc1')!.text, 'NEW text');
        assert.equal(h.v.calls.getById, 0);
    });
    await test(`${door.name}: bound + #rev history id → id_unavailable with no lookup and no write`, async () => {
        const h = vRig({ doc1: HIDDEN });
        door.refused(await bound(SALES, () => door.call(h, REV_ID)));
        assert.equal(h.v.calls.getById + h.v.calls.store, 0);
    });
    await test(`${door.name}: unbound + #rev history id keeps its existing refusal`, async () => {
        const h = vRig({});
        const o = await door.call(h, REV_ID);
        assert.ok(!door.ok(o), o.body);
        assert.doesNotMatch(o.body, new RegExp(ID_UNAVAILABLE));
        assert.equal(h.v.calls.store, 0);
    });
}

// ───────────────────────── Part 6 — overwrite keeps the row's scopes (Lance + SQLite) ─────────────────────────

class DetEmbed implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'wsev-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(t: string): number[] {
        const v = new Array<number>(this.dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[(i * 7 + t.charCodeAt(i)) % this.dimension] += t.charCodeAt(i) / 128;
        const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / n);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
}
const META = { type: 'note', label: 'l', tags: 't', project: 'p', ecosystem: 'e', updatedAt: '2026-10-06T00:00:00.000Z' };
const scopesOf = async (s: { getById(id: string): Promise<{ security_scopes?: string[] } | null> }, id: string): Promise<string[] | undefined> => {
    const r = await s.getById(id);
    return r ? [...(r.security_scopes ?? [])].sort() : undefined;
};

console.log('\nverbatim overwrite keeps scopes — Lance + SQLite\n');
for (const engine of ['lance', 'sqlite'] as const) {
    const open = async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wsev-${engine}-`));
        const s = engine === 'lance' ? new VerbatimStore(dir, new DetEmbed()) : new SqliteVerbatimStore(dir, new DetEmbed());
        await s.initialize();
        return s;
    };
    await test(`${engine} store(): overwrite with no scopes keeps ['x']; explicit [] clears; no-scopes after [] stays []`, async () => {
        const s = await open();
        try {
            await s.store({ id: 'd', text: 'first body', metadata: { ...META, security_scopes: ['x'] } });
            await s.store({ id: 'd', text: 'second body, changed', metadata: META });
            assert.deepEqual(await scopesOf(s, 'd'), ['x'], 'changed text, no scopes → labels kept');
            await s.store({ id: 'd', text: 'second body, changed', metadata: { ...META, label: 'only metadata changed' } });
            assert.deepEqual(await scopesOf(s, 'd'), ['x'], 'metadata-only change, no scopes → labels kept');
            await s.store({ id: 'd', text: 'third body', metadata: { ...META, security_scopes: [] } });
            assert.deepEqual(await scopesOf(s, 'd'), [], 'explicit [] wins');
            await s.store({ id: 'd', text: 'fourth body', metadata: META });
            assert.deepEqual(await scopesOf(s, 'd'), [], 'no scopes after [] stays public, not resurrected');
        } finally { await s.close(); }
    });
    await test(`${engine} store(): explicit array replaces the labels (node→verbatim mirror path)`, async () => {
        const s = await open();
        try {
            await s.store({ id: 'd', text: 'body', metadata: { ...META, security_scopes: ['x'] } });
            await s.store({ id: 'd', text: 'body changed', metadata: { ...META, security_scopes: ['y', 'z'] } });
            assert.deepEqual(await scopesOf(s, 'd'), ['y', 'z']);
        } finally { await s.close(); }
    });
    await test(`${engine} store(): a new id with no scopes is public; an unrelated row keeps its own scopes`, async () => {
        const s = await open();
        try {
            await s.store({ id: 'other', text: 'other body', metadata: { ...META, security_scopes: ['x'] } });
            await s.store({ id: 'fresh', text: 'fresh body', metadata: META });
            assert.deepEqual(await scopesOf(s, 'fresh'), []);
            assert.deepEqual(await scopesOf(s, 'other'), ['x']);
        } finally { await s.close(); }
    });
    await test(`${engine} storeBatch(): overwrite with no scopes keeps ['x']; explicit [] clears`, async () => {
        const s = await open();
        try {
            await s.storeBatch([
                { id: 'b1', text: 'one', metadata: { ...META, security_scopes: ['x'] } },
                { id: 'b2', text: 'two', metadata: { ...META, security_scopes: ['x'] } },
            ]);
            await s.storeBatch([
                { id: 'b1', text: 'one changed', metadata: META },
                { id: 'b2', text: 'two changed', metadata: { ...META, security_scopes: [] } },
                { id: 'b3', text: 'three new', metadata: META },
            ]);
            assert.deepEqual(await scopesOf(s, 'b1'), ['x']);
            assert.deepEqual(await scopesOf(s, 'b2'), []);
            assert.deepEqual(await scopesOf(s, 'b3'), []);
        } finally { await s.close(); }
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env tsx
/**
 * test/rest-feature-apis-unit.ts — Unit tests for all new REST routes added
 * alongside Feature 1 (lifecycle), Feature 2 (outcomes), Feature 6 (anchors),
 * Feature 7 (corpus health), Feature 8 (versioning/changesets), and the
 * verbatim/ingestion/inspect additions.
 *
 * Tests drive route handlers directly with in-memory fakes (no HTTP server,
 * no Kùzu, no SQLite on disk). Pattern matches rest-verbatim-get-unit.ts.
 *
 * Coverage:
 *   Lifecycle   — prune 400/404, restore happy/404, prune-job happy/404
 *   Outcomes    — record happy/404/invalid-status, get happy/empty
 *   Versioning  — history, diff (missing since), begin, commit, rollback-open,
 *                 rollback-committed, snapshot, changeset 404
 *   Anchors     — happy, mark_stale, 404
 *   Corpus      — health happy
 *   Inspect     — lore-status, node-list happy/cursor/missing-workspace
 *   Verbatim    — store happy/400, search happy/400
 *   Ingestion   — file/reprocess 503 when no registry
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryLifecycleRoutes } from '../packages/lore/src/mcp/http/routes/lifecycle.js';
import { tryOutcomesRoutes } from '../packages/lore/src/mcp/http/routes/outcomes.js';
import { tryVersioningRoutes } from '../packages/lore/src/mcp/http/routes/versioning.js';
import { tryAnchorsRoutes } from '../packages/lore/src/mcp/http/routes/anchors.js';
import { tryCorpusRoutes } from '../packages/lore/src/mcp/http/routes/corpus.js';
import { tryInspectRoutes } from '../packages/lore/src/mcp/http/routes/inspect.js';
import { tryRetentionRoutes } from '../packages/lore/src/mcp/http/routes/retention.js';
import { tryIngestionRoutes } from '../packages/lore/src/mcp/http/routes/ingestion.js';

/* ─── harness ──────────────────────────────────────────────────── */

let passed = 0; let failed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
}

/* ─── HTTP fakes ───────────────────────────────────────────────── */

type FakeRes = ServerResponse & { _status: number; _body: string };

function fakeRes(): FakeRes {
    const r = { _status: 0, _body: '',
        writeHead(s: number) { (this as FakeRes)._status = s; return this; },
        end(b?: string) { (this as FakeRes)._body = b ?? ''; },
    };
    return r as unknown as FakeRes;
}

function makeGetReq(url?: string): IncomingMessage {
    return { method: 'GET', url: url ?? '/', on: () => undefined } as unknown as IncomingMessage;
}

function makePostReq(bodyStr: string): IncomingMessage {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
    const req: Partial<IncomingMessage> & { on: (e: string, fn: (a?: unknown) => void) => unknown } = {
        method: 'POST',
        on(event: string, fn: (a?: unknown) => void) {
            (listeners[event] ??= []).push(fn);
            if (event === 'end') {
                setImmediate(() => {
                    for (const f of listeners['data'] ?? []) f(Buffer.from(bodyStr));
                    for (const f of listeners['end'] ?? []) f();
                });
            }
            return this;
        },
    };
    return req as unknown as IncomingMessage;
}

/* ─── in-memory fakes ──────────────────────────────────────────── */

type FakeNode = { id: string; type: string; label: string; status?: string; tags?: string;
    classification?: string; createdAt?: string; updatedAt?: string; project?: string;
    success_count?: number; failure_count?: number; partial_count?: number;
    confirmation_score?: number; anchors?: string; anchor_stale?: boolean;
    anchor_stale_since?: string; [k: string]: unknown };

function makeFakeGraph(seed: FakeNode[] = []) {
    const nodes = new Map<string, FakeNode>(seed.map((n) => [n.id, n]));
    return {
        nodes,
        async initialize() {},
        async getNode(id: string) { return nodes.get(id) ?? null; },
        async upsertNode(n: FakeNode) { nodes.set(n.id, n); return n; },
        async deleteNode(id: string) { nodes.delete(id); return true; },
        async listNodes(_t?: unknown, _g?: unknown, _ws?: unknown, _eco?: unknown) {
            return [...nodes.values()];
        },
        // Mirrors the real graphBulkList contract (RA2 Wave D2 switched the
        // /api/node-list route from listNodes → bulkList): type OR-filter, tag
        // membership (lowercased), project scoping (lenient — absent project =
        // any, since this is a single-workspace fake), (updatedAt DESC, id ASC)
        // order, strict-after cursor, limit+1 hasMore.
        async bulkList(q: { types?: string[]; tags?: string[]; project?: string; limit: number; cursor?: { updatedAt: string; id: string } | null }) {
            let rows = [...nodes.values()] as Array<Record<string, unknown>>;
            if (q.types && q.types.length > 0) rows = rows.filter((n) => q.types!.includes(String(n.type)));
            if (q.tags && q.tags.length > 0) {
                const want = q.tags.map((t) => t.toLowerCase());
                rows = rows.filter((n) => { const t = (n.tags as string[] | undefined) ?? []; return want.some((tag) => t.includes(tag)); });
            }
            if (q.project) rows = rows.filter((n) => n.project === undefined || n.project === q.project);
            rows.sort((a, b) => {
                const ua = String(a.updatedAt ?? ''), ub = String(b.updatedAt ?? '');
                if (ua !== ub) return ua < ub ? 1 : -1;       // updatedAt DESC
                return String(a.id) < String(b.id) ? -1 : 1;  // id ASC
            });
            if (q.cursor) {
                const cu = q.cursor.updatedAt, ci = q.cursor.id;
                rows = rows.filter((n) => { const u = String(n.updatedAt ?? ''); return u < cu || (u === cu && String(n.id) > ci); });
            }
            const limit = q.limit ?? 100;
            const hasMore = rows.length > limit;
            const page = rows.slice(0, limit);
            const last = page[page.length - 1];
            const nextCursor = hasMore && last ? { updatedAt: String(last.updatedAt ?? ''), id: String(last.id) } : null;
            return { nodes: page, hasMore, nextCursor };
        },
        async getStats() { return { nodeCount: nodes.size, edgeCount: 0 }; },
    };
}

function makeFakeAuxStore() {
    const jobs = new Map<string, unknown>();
    const outcomes: Array<{ nodeId: string; workspace: string; status: string; notes?: string; id: string }> = [];
    const counters: Record<string, number> = {};
    return {
        createPruneJob(ws: string, _params: unknown) {
            const id = 'job-' + randomUUID();
            jobs.set(id, { id, workspace: ws, status: 'running', params: _params });
            return id;
        },
        updatePruneJob(id: string, update: unknown) {
            const j = jobs.get(id) as Record<string, unknown> ?? {};
            jobs.set(id, { ...j, ...(update as object) });
        },
        getPruneJob(id: string) { return jobs.get(id) ?? null; },
        recordOutcome(o: { id: string; nodeId: string; workspace: string; status: string; notes?: string }) {
            outcomes.push(o);
        },
        getOutcomes(nodeId: string, ws: string, limit: number) {
            return outcomes.filter((o) => o.nodeId === nodeId && o.workspace === ws).slice(0, limit);
        },
        getOutcomeCount(nodeId: string, ws: string) {
            const rows = outcomes.filter((o) => o.nodeId === nodeId && o.workspace === ws);
            return {
                success: rows.filter((o) => o.status === 'success').length,
                failure: rows.filter((o) => o.status === 'failure').length,
                partial: rows.filter((o) => o.status === 'partial').length,
            };
        },
        incrementCounter(ws: string, key: string, n = 1) { counters[`${ws}:${key}`] = (counters[`${ws}:${key}`] ?? 0) + n; },
        getWorkspaceOutcomeTotals(_ws: string) { return {}; },
        getCorpusCounters(_ws: string) { return {}; },
    };
}

type VersionRecord = { versionId: string; nodeId: string; workspace: string; timestamp: string;
    principal: string; operation: string; previousState: unknown; newState: unknown; changesetId: string | null; compacted?: boolean };
type Changeset = { id: string; workspace: string; status: string; writeCount: number; committedAt?: string | null };
type ChangesetWrite = { seq: number; operation: string; payload: unknown };

function makeFakeVersionStore() {
    const versions: VersionRecord[] = [];
    const changesets = new Map<string, Changeset>();
    const writes = new Map<string, ChangesetWrite[]>();
    return {
        recordVersion(r: VersionRecord) { versions.push(r); },
        getVersions(nodeId: string, ws: string, limit = 50) {
            return versions.filter((v) => v.nodeId === nodeId && v.workspace === ws)
                .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
                .slice(0, limit);
        },
        getDiff(ws: string, since: string) {
            return versions.filter((v) => v.workspace === ws && v.timestamp >= since);
        },
        getVersionsByChangeset(csId: string) {
            return versions.filter((v) => v.changesetId === csId);
        },
        createChangeset(ws: string) {
            const id = 'cs-' + randomUUID();
            changesets.set(id, { id, workspace: ws, status: 'open', writeCount: 0, committedAt: null });
            return id;
        },
        getChangeset(id: string) { return changesets.get(id) ?? null; },
        updateChangeset(id: string, status: string) {
            const cs = changesets.get(id)!;
            changesets.set(id, { ...cs, status, committedAt: status === 'committed' ? new Date().toISOString() : cs.committedAt });
        },
        addChangesetWrite(csId: string, op: string, payload: unknown) {
            const cs = changesets.get(csId)!;
            const ws = writes.get(csId) ?? [];
            const seq = ws.length;
            changesets.set(csId, { ...cs, writeCount: cs.writeCount + 1 });
            ws.push({ seq, operation: op, payload });
            writes.set(csId, ws);
            return seq;
        },
        getChangesetWrites(csId: string) { return writes.get(csId) ?? []; },
        pruneVersions(_days: number) { return 0; },
        close() {},
    };
}

/* ─── common dep builders ──────────────────────────────────────── */

const LOCAL_BASE = { deploymentMode: 'local' as const, dataplane: null };

function lifecycleDeps(graph = makeFakeGraph(), aux = makeFakeAuxStore(), vStore?: ReturnType<typeof makeFakeVersionStore>) {
    return { ...LOCAL_BASE, store: { loreGraph: graph } as never, auxStore: aux as never, versionStore: vStore as never };
}
function outcomeDeps(graph = makeFakeGraph(), aux = makeFakeAuxStore(), vStore?: ReturnType<typeof makeFakeVersionStore>) {
    return { ...LOCAL_BASE, store: { loreGraph: graph } as never, auxStore: aux as never, versionStore: vStore as never };
}
function versioningDeps(graph = makeFakeGraph(), vStore = makeFakeVersionStore()) {
    return { ...LOCAL_BASE, versionStore: vStore as never, store: { loreGraph: graph } as never };
}
function anchorDeps(graph = makeFakeGraph()) {
    return { ...LOCAL_BASE, store: { loreGraph: graph } as never };
}
function corpusDeps(graph = makeFakeGraph(), aux = makeFakeAuxStore()) {
    return { ...LOCAL_BASE, store: { loreGraph: graph } as never, auxStore: aux as never };
}
function inspectDeps(graph = makeFakeGraph()) {
    return { ...LOCAL_BASE, store: { loreGraph: graph, storageClient: { getStats: async () => ({ nodeCount: 1, edgeCount: 2 }), verbatimCount: async () => 5 } } as never, detectedScope: { workspace: 'test', ecosystem: '*' } };
}
function retentionDeps(graph = makeFakeGraph()) {
    return { ...LOCAL_BASE, store: { loreGraph: graph, storageClient: { verbatimStore: async () => undefined, verbatimSearch: async (_q: string, limit: number) => Array.from({ length: Math.min(2, limit) }, (_, i) => ({ id: `doc-${i}`, score: 0.9 - i * 0.1, text: `text ${i}`, metadata: { type: 'file', label: `label-${i}` } })) } } as never, auditLog: { log: () => undefined } as never, runRetentionSweep: async () => ({} as never) };
}
function ingestionDeps(withRegistry = false) {
    return { ...LOCAL_BASE, store: {} as never, consentManager: {} as never, auditLog: { log: () => undefined } as never, configManager: {} as never, graphBasePath: '/tmp', extractorRegistry: withRegistry ? {} as never : undefined };
}

/* ═══════════════════════════════════════════════════════════════════
   Lifecycle routes
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── Lifecycle ───');

test('prune — missing workspace body → 400', async () => {
    const res = fakeRes();
    await tryLifecycleRoutes(makePostReq('{}'), res, '/api/nodes/prune', '/api/nodes/prune', lifecycleDeps());
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 400);
    assert.match(res._body, /workspace/);
});

test('prune — unknown workspace → 404', async () => {
    const res = fakeRes();
    const body = JSON.stringify({ workspace: 'definitely-does-not-exist-' + randomUUID() });
    await tryLifecycleRoutes(makePostReq(body), res, '/api/nodes/prune', '/api/nodes/prune', lifecycleDeps());
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 404);
    assert.match(res._body, /workspace_not_found/);
});

test('restore — happy path: archived node → active', async () => {
    const graph = makeFakeGraph([{ id: 'n1', type: 'note', label: 'N1', status: 'archived' }]);
    const res = fakeRes();
    const handled = await tryLifecycleRoutes(
        makePostReq(JSON.stringify({ workspace: 'w1' })),
        res, '/api/nodes/n1/restore', '/api/nodes/n1/restore',
        lifecycleDeps(graph),
    );
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(handled, true);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.success, true);
    assert.equal(body.new_status, 'active');
    assert.equal(body.previous_status, 'archived');
    assert.equal((graph.nodes.get('n1') as FakeNode | undefined)?.status, 'active');
});

test('restore — unknown node → 404', async () => {
    const res = fakeRes();
    await tryLifecycleRoutes(
        makePostReq(JSON.stringify({ workspace: 'w1' })),
        res, '/api/nodes/ghost/restore', '/api/nodes/ghost/restore',
        lifecycleDeps(),
    );
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 404);
    assert.match(res._body, /node_not_found/);
});

test('prune-job — happy path: known job returned', async () => {
    const aux = makeFakeAuxStore();
    const jobId = aux.createPruneJob('ws1', {});
    aux.updatePruneJob(jobId, { status: 'completed', result: { archived: 3 } });
    const res = fakeRes();
    await tryLifecycleRoutes(makeGetReq(), res, '', `/api/prune-jobs/${jobId}`, lifecycleDeps(makeFakeGraph(), aux));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.status, 'completed');
});

test('prune-job — unknown job → 404', async () => {
    const res = fakeRes();
    await tryLifecycleRoutes(makeGetReq(), res, '', '/api/prune-jobs/no-such-job', lifecycleDeps());
    assert.equal(res._status, 404);
    assert.match(res._body, /job_not_found/);
});

/* ═══════════════════════════════════════════════════════════════════
   Outcomes routes
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── Outcomes ───');

test('record_outcome — happy path updates confirmation score', async () => {
    const graph = makeFakeGraph([{ id: 'n1', type: 'note', label: 'N', success_count: 0, failure_count: 0, partial_count: 0 }]);
    const aux = makeFakeAuxStore();
    const res = fakeRes();
    await tryOutcomesRoutes(
        makePostReq(JSON.stringify({ workspace: 'w1', status: 'success', notes: 'great' })),
        res, '/api/nodes/n1/outcomes', '/api/nodes/n1/outcomes',
        outcomeDeps(graph, aux),
    );
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.success, true);
    assert.equal(body.status, 'success');
    assert.ok(body.outcome_id, 'outcome_id missing');
    assert.ok(body.new_confirmation_score >= 0);
    assert.equal(aux.getOutcomeCount('n1', 'w1').success, 1);
});

test('record_outcome — unknown node → 404', async () => {
    const res = fakeRes();
    await tryOutcomesRoutes(
        makePostReq(JSON.stringify({ workspace: 'w1', status: 'success' })),
        res, '/api/nodes/ghost/outcomes', '/api/nodes/ghost/outcomes',
        outcomeDeps(),
    );
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 404);
    assert.match(res._body, /node_not_found/);
});

test('record_outcome — invalid status → 400', async () => {
    const graph = makeFakeGraph([{ id: 'n1', type: 'note', label: 'N' }]);
    const res = fakeRes();
    await tryOutcomesRoutes(
        makePostReq(JSON.stringify({ workspace: 'w1', status: 'bad-status' })),
        res, '/api/nodes/n1/outcomes', '/api/nodes/n1/outcomes',
        outcomeDeps(graph),
    );
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 400);
    assert.match(res._body, /status/);
});

test('get_node_outcomes — happy path returns history + score', async () => {
    const aux = makeFakeAuxStore();
    aux.recordOutcome({ id: randomUUID(), nodeId: 'n1', workspace: 'w1', status: 'success' });
    const res = fakeRes();
    await tryOutcomesRoutes(
        makeGetReq('/api/nodes/n1/outcomes?workspace=w1&limit=10'),
        res, '/api/nodes/n1/outcomes?workspace=w1&limit=10', '/api/nodes/n1/outcomes',
        outcomeDeps(makeFakeGraph(), aux),
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.node_id, 'n1');
    assert.equal(body.total_count, 1);
    assert.equal(body.confirmation_score, 1);
});

/* ═══════════════════════════════════════════════════════════════════
   Versioning routes
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── Versioning ───');

test('node history — returns versions newest-first', async () => {
    const vStore = makeFakeVersionStore();
    vStore.recordVersion({ versionId: randomUUID(), nodeId: 'n1', workspace: 'w1', timestamp: '2026-01-01T00:00:00Z', principal: 'mcp', operation: 'upsert', previousState: null, newState: { id: 'n1' }, changesetId: null });
    vStore.recordVersion({ versionId: randomUUID(), nodeId: 'n1', workspace: 'w1', timestamp: '2026-01-02T00:00:00Z', principal: 'mcp', operation: 'upsert', previousState: { id: 'n1' }, newState: { id: 'n1' }, changesetId: null });
    const res = fakeRes();
    await tryVersioningRoutes(makeGetReq('/api/nodes/n1/history?workspace=w1'), res, '/api/nodes/n1/history?workspace=w1', '/api/nodes/n1/history', versioningDeps(makeFakeGraph(), vStore));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.count, 2);
    assert.ok(body.versions[0].timestamp > body.versions[1].timestamp, 'newest first');
});

test('diff_workspace — missing since → 400', async () => {
    const res = fakeRes();
    await tryVersioningRoutes(makeGetReq('/api/workspaces/w1/diff'), res, '/api/workspaces/w1/diff', '/api/workspaces/w1/diff', versioningDeps());
    assert.equal(res._status, 400);
    assert.match(res._body, /since/);
});

test('diff_workspace — filters by timestamp', async () => {
    const vStore = makeFakeVersionStore();
    const anchor = '2026-06-01T00:00:00Z';
    vStore.recordVersion({ versionId: randomUUID(), nodeId: 'old', workspace: 'w1', timestamp: '2026-01-01T00:00:00Z', principal: 'mcp', operation: 'upsert', previousState: null, newState: {}, changesetId: null });
    vStore.recordVersion({ versionId: randomUUID(), nodeId: 'new', workspace: 'w1', timestamp: '2026-06-02T00:00:00Z', principal: 'mcp', operation: 'upsert', previousState: null, newState: {}, changesetId: null });
    const url = `/api/workspaces/w1/diff?since=${encodeURIComponent(anchor)}`;
    const res = fakeRes();
    await tryVersioningRoutes(makeGetReq(url), res, url, '/api/workspaces/w1/diff', versioningDeps(makeFakeGraph(), vStore));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.total, 1);
    assert.equal(body.changes[0].nodeId, 'new');
});

test('begin_changeset — missing workspace → 400', async () => {
    const res = fakeRes();
    await tryVersioningRoutes(makePostReq('{}'), res, '/api/changesets', '/api/changesets', versioningDeps());
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 400);
});

test('begin_changeset — happy path returns cs- prefixed id', async () => {
    const vStore = makeFakeVersionStore();
    const res = fakeRes();
    await tryVersioningRoutes(makePostReq(JSON.stringify({ workspace: 'w1' })), res, '/api/changesets', '/api/changesets', versioningDeps(makeFakeGraph(), vStore));
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.ok(body.changeset_id.startsWith('cs-'), `expected cs- prefix, got ${body.changeset_id}`);
    assert.equal(body.status, 'open');
});

test('commit_changeset — not found → 404', async () => {
    const res = fakeRes();
    await tryVersioningRoutes(makePostReq(''), res, '/api/changesets/no-such/commit', '/api/changesets/no-such/commit', versioningDeps());
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 404);
});

test('commit_changeset — happy path applies buffered writes', async () => {
    const graph = makeFakeGraph();
    const vStore = makeFakeVersionStore();
    const csId = vStore.createChangeset('w1');
    vStore.addChangesetWrite(csId, 'upsert_node', { workspace: 'w1', nodeData: { id: 'n99', type: 'note', label: 'Buffered' } });
    const res = fakeRes();
    await tryVersioningRoutes(makePostReq(''), res, `/api/changesets/${csId}/commit`, `/api/changesets/${csId}/commit`, versioningDeps(graph, vStore));
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.applied, 1);
    assert.equal(body.status, 'committed');
    assert.ok(graph.nodes.has('n99'), 'node not in graph after commit');
});

test('rollback_changeset open — discards without graph writes', async () => {
    const graph = makeFakeGraph();
    const vStore = makeFakeVersionStore();
    const csId = vStore.createChangeset('w1');
    vStore.addChangesetWrite(csId, 'upsert_node', { workspace: 'w1', nodeData: { id: 'nX', type: 'note', label: 'Never committed' } });
    const res = fakeRes();
    await tryVersioningRoutes(makePostReq(''), res, `/api/changesets/${csId}/rollback`, `/api/changesets/${csId}/rollback`, versioningDeps(graph, vStore));
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.status, 'rolled_back');
    assert.equal(body.reversed, 0);
    assert.ok(!graph.nodes.has('nX'), 'node should not be in graph after rollback');
});

test('rollback_changeset committed — reverses applied writes', async () => {
    const graph = makeFakeGraph([{ id: 'nRev', type: 'note', label: 'Original' }]);
    const vStore = makeFakeVersionStore();
    const csId = vStore.createChangeset('w1');
    // Simulate a committed changeset that updated label
    vStore.updateChangeset(csId, 'committed');
    vStore.recordVersion({ versionId: randomUUID(), nodeId: 'nRev', workspace: 'w1', timestamp: new Date().toISOString(), principal: 'changeset', operation: 'upsert', previousState: { id: 'nRev', type: 'note', label: 'Original' }, newState: { id: 'nRev', type: 'note', label: 'Updated' }, changesetId: csId });
    // Apply the update to graph so rollback can reverse it
    await graph.upsertNode({ id: 'nRev', type: 'note', label: 'Updated' });
    assert.equal(graph.nodes.get('nRev')?.label, 'Updated');
    const res = fakeRes();
    await tryVersioningRoutes(makePostReq(''), res, `/api/changesets/${csId}/rollback`, `/api/changesets/${csId}/rollback`, versioningDeps(graph, vStore));
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.reversed, 1);
    assert.equal(graph.nodes.get('nRev')?.label, 'Original', 'label not reverted');
});

test('export_snapshot — returns JSONL with active nodes only', async () => {
    const graph = makeFakeGraph([
        { id: 'a', type: 'note', label: 'Active' },
        { id: 'b', type: 'note', label: 'Archived', status: 'archived' },
    ]);
    const res = fakeRes();
    await tryVersioningRoutes(makeGetReq('/api/workspaces/w1/snapshot'), res, '/api/workspaces/w1/snapshot', '/api/workspaces/w1/snapshot', versioningDeps(graph));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.node_count, 1);
    assert.ok(body.snapshot.includes('"a"'));
    assert.ok(!body.snapshot.includes('"b"'));
});

/* ═══════════════════════════════════════════════════════════════════
   Anchors routes
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── Anchors ───');

test('check_anchors — returns anchor metadata', async () => {
    const graph = makeFakeGraph([{ id: 'n1', type: 'note', label: 'N', anchors: JSON.stringify([{ type: 'url', ref: 'https://example.com' }]) }]);
    const res = fakeRes();
    await tryAnchorsRoutes(makeGetReq('/api/nodes/n1/anchors?workspace=w1'), res, '/api/nodes/n1/anchors?workspace=w1', '/api/nodes/n1/anchors', anchorDeps(graph));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.anchor_count, 1);
    assert.equal(body.anchors[0].ref, 'https://example.com');
});

test('check_anchors — mark_stale=true flags the node', async () => {
    const graph = makeFakeGraph([{ id: 'n1', type: 'note', label: 'N', anchors: '[]' }]);
    const res = fakeRes();
    await tryAnchorsRoutes(makeGetReq('/api/nodes/n1/anchors?workspace=w1&mark_stale=true'), res, '/api/nodes/n1/anchors?workspace=w1&mark_stale=true', '/api/nodes/n1/anchors', anchorDeps(graph));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.stale_marked, true);
    assert.equal(body.anchor_stale, true);
    assert.equal(graph.nodes.get('n1')?.anchor_stale, true);
});

test('check_anchors — unknown node → 404', async () => {
    const res = fakeRes();
    await tryAnchorsRoutes(makeGetReq('/api/nodes/ghost/anchors?workspace=w1'), res, '/api/nodes/ghost/anchors?workspace=w1', '/api/nodes/ghost/anchors', anchorDeps());
    assert.equal(res._status, 404);
    assert.match(res._body, /node_not_found/);
});

/* ═══════════════════════════════════════════════════════════════════
   Corpus routes
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── Corpus health ───');

test('corpus_health — aggregates node counts correctly', async () => {
    const graph = makeFakeGraph([
        { id: 'a', type: 'note', label: 'Active', classification: 'foundational' },
        { id: 'b', type: 'note', label: 'Archived', status: 'archived', classification: 'tactical' },
        { id: 'c', type: 'note', label: 'Protected', status: 'protected', anchor_stale: true },
        { id: 'd', type: 'note', label: 'Stale', stale: true, confirmation_score: 0.8 },
    ]);
    const res = fakeRes();
    await tryCorpusRoutes(makeGetReq('/api/workspaces/w1/health'), res, '/api/workspaces/w1/health', '/api/workspaces/w1/health', corpusDeps(graph));
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.total_nodes, 4);
    assert.equal(body.active_nodes, 2);
    assert.equal(body.archived_nodes, 1);
    assert.equal(body.protected_nodes, 1);
    assert.equal(body.foundational_nodes, 1);
    assert.equal(body.stale_nodes, 1);
    assert.equal(body.anchor_stale_nodes, 1);
    assert.equal(body.scored_nodes, 1);
});

/* ═══════════════════════════════════════════════════════════════════
   Inspect routes
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── Inspect ───');

test('lore-status — returns daemon health snapshot', async () => {
    const res = fakeRes();
    await tryInspectRoutes(makeGetReq(), res, '/api/lore-status', '/api/lore-status', inspectDeps());
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.daemon, 'ok');
    assert.ok('capabilities' in body);
    assert.equal(body.graph.nodes, 1);
    assert.equal(body.graph.verbatimDocs, 5);
});

test('node-list — missing workspace → 400', async () => {
    const res = fakeRes();
    await tryInspectRoutes(makeGetReq('/api/node-list'), res, '/api/node-list', '/api/node-list', inspectDeps());
    assert.equal(res._status, 400);
    assert.match(res._body, /workspace/);
});

test('node-list — returns nodes for workspace', async () => {
    const graph = makeFakeGraph([
        { id: 'n1', type: 'note', label: 'A', updatedAt: '2026-01-02T00:00:00Z' },
        { id: 'n2', type: 'note', label: 'B', updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    const res = fakeRes();
    await tryInspectRoutes(makeGetReq('/api/node-list?workspace=w1'), res, '/api/node-list?workspace=w1', '/api/node-list', { ...LOCAL_BASE, store: { loreGraph: graph, storageClient: { getStats: async () => ({ nodeCount: 2, edgeCount: 0 }), verbatimCount: async () => 0 } } as never, detectedScope: { workspace: 'w1', ecosystem: '*' } });
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.count, 2);
    // sorted updatedAt DESC: n1 should be first
    assert.equal(body.nodes[0].id, 'n1');
});

test('node-list — invalid cursor → 400', async () => {
    const res = fakeRes();
    await tryInspectRoutes(makeGetReq('/api/node-list?workspace=w1&cursor=!!!notbase64!!!'), res, '/api/node-list?workspace=w1&cursor=!!!notbase64!!!', '/api/node-list', inspectDeps());
    assert.equal(res._status, 400);
    assert.match(res._body, /cursor/);
});

/* ═══════════════════════════════════════════════════════════════════
   Verbatim additions (retention.ts)
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── Verbatim (REST additions) ───');

test('POST /api/verbatim — happy path stores doc', async () => {
    const stored: unknown[] = [];
    const deps = { ...retentionDeps(), store: { storageClient: { verbatimStore: async (r: unknown) => { stored.push(r); }, verbatimSearch: async () => [] } } as never };
    const res = fakeRes();
    await tryRetentionRoutes(makePostReq(JSON.stringify({ id: 'doc-1', text: 'hello', workspace: 'w1' })), res, '/api/verbatim', '/api/verbatim', deps);
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 200);
    assert.equal(stored.length, 1);
    assert.equal((stored[0] as { id: string }).id, 'doc-1');
});

test('POST /api/verbatim — missing id/text/workspace → 400', async () => {
    const res = fakeRes();
    await tryRetentionRoutes(makePostReq(JSON.stringify({ id: 'doc-x' })), res, '/api/verbatim', '/api/verbatim', retentionDeps());
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 400);
    assert.match(res._body, /required/);
});

test('GET /api/verbatim/search — returns ranked rows', async () => {
    const res = fakeRes();
    await tryRetentionRoutes(makeGetReq('/api/verbatim/search?q=hello&workspace=w1'), res, '/api/verbatim/search?q=hello&workspace=w1', '/api/verbatim/search', retentionDeps());
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.ok(Array.isArray(body.rows));
    assert.equal(body.rows.length, 2);
    assert.ok(body.rows[0].score > body.rows[1].score, 'rows should be ordered by score');
});

test('GET /api/verbatim/search — missing q or workspace → 400', async () => {
    const res = fakeRes();
    await tryRetentionRoutes(makeGetReq('/api/verbatim/search?q=hello'), res, '/api/verbatim/search?q=hello', '/api/verbatim/search', retentionDeps());
    assert.equal(res._status, 400);
    assert.match(res._body, /workspace/);
});

/* ═══════════════════════════════════════════════════════════════════
   Ingestion additions
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n─── Ingestion (REST additions) ───');

test('POST /api/ingest/file — no extractorRegistry → 503', async () => {
    const res = fakeRes();
    await tryIngestionRoutes(makePostReq(JSON.stringify({ filePath: '/tmp/x.txt', workspace: 'w1' })), res, '/api/ingest/file', '/api/ingest/file', ingestionDeps(false));
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 503);
    assert.match(res._body, /extractor_registry_unavailable/);
});

test('POST /api/ingest/reprocess — no extractorRegistry → 503', async () => {
    const res = fakeRes();
    await tryIngestionRoutes(makePostReq(JSON.stringify({ filePath: '/tmp/x.txt', workspace: 'w1', upgradeAction: 'use_chandra' })), res, '/api/ingest/reprocess', '/api/ingest/reprocess', ingestionDeps(false));
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 503);
    assert.match(res._body, /extractor_registry_unavailable/);
});

test('POST /api/ingest/reprocess — invalid upgradeAction → 400', async () => {
    const deps = { ...ingestionDeps(true), extractorRegistry: { mimeFromPath: () => 'text/plain', extract: async () => ({ text: '', mimeType: 'text/plain', sourceBytes: 0, confidence: 1, metadata: null, quality: null }) } as never };
    const res = fakeRes();
    await tryIngestionRoutes(makePostReq(JSON.stringify({ filePath: '/tmp/x.txt', workspace: 'w1', upgradeAction: 'use_magic_wand' })), res, '/api/ingest/reprocess', '/api/ingest/reprocess', deps);
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.equal(res._status, 400);
    assert.match(res._body, /upgradeAction/);
});

/* ─── summary ──────────────────────────────────────────────────── */

await Promise.all(pending);
console.log(`\n─── REST Feature APIs: ${passed}/${passed + failed} passed ───`);
if (failed > 0) process.exit(1);

#!/usr/bin/env tsx
/**
 * test/counts-review-fixes-unit.ts - fixes from the adversarial review of the
 * visible-only counts work (3.31 S4):
 *   1. quota 429 / commit_changeset rejections omit `current` for bound non-operators
 *   3/4/5. scan helpers against an Arcade-like engine: clamped / short pages, no
 *      early stop, bulkList rows without lifecycle columns, exact-cap lowerBound
 *   6/7. report walks bounded by the cap, orphans omitted when the edge scan is
 *      capped, hub degrees `<n>+`, no empty-type bucket
 *   6. sweepFreshness bounded + labelled for app tokens only
 * (the /metrics lag series, the anonymous request and topology `truncated` are
 * pinned in counts-hidden-unit.ts and counts-visible-stats-unit.ts.)
 *
 * Fakes only; no engine, no network.
 */

import { strict as assert } from 'node:assert';
import type { ServerResponse } from 'node:http';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import {
    enforceQuotaOrReject, InMemoryWorkspaceQuotaStore, quotaCurrentField,
} from '../packages/lore/src/security/workspaceQuota.js';
import {
    countVisibleEdges, countVisibleNodes, forEachVisibleNode, setVisibleScanCapForTests,
    type VisibleCountGraph, type VisibleEdgeGraph,
} from '../packages/lore/src/security/visibleCounts.js';
import { registerVersioningTools, type VersioningDeps } from '../packages/lore/src/mcp/tools/versioning.js';
import { writeGraphReport } from '../packages/lore/src/engines/graphReport.js';
import { computeOrphans, type ReportGraph } from '../packages/lore/src/engines/graphReportAggregates.js';
import { sweepFreshness, type IFreshnessGraph } from '../packages/lore/src/engines/freshnessEngine.js';
import type { WorkspaceEntry } from '../packages/lore/src/config/workspaces.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); }
}

const APP: Principal = { kind: 'app', workspace: 'dev', scopes: ['read', 'write'], label: 'app-1' };
const BOOT: Principal = { kind: 'bootstrap', workspace: 'dev', scopes: ['read', 'write'], label: 'bootstrap' };
type Who = 'unbound' | 'operator' | 'app';
function as<T>(who: Who, fn: () => T): T {
    if (who === 'unbound') return fn();
    return runWithActor({ portalUserId: 'u', scopes: ['x'] }, () => runWithPrincipal(who === 'operator' ? BOOT : APP, fn));
}

type Row = Record<string, unknown>;
type Cursor = { updatedAt: string; id: string } | null;
const offsetOf = (c: Cursor): number => (c ? Number(c.id) : 0);
const cursorAt = (n: number): Cursor => ({ updatedAt: 'x', id: String(n) });

/** Arcade-like node source: pages are clamped (short), the cursor stays non-null after the last page. */
function arcadeNodes(rows: Row[], opts: { clamp?: number; projected?: boolean; calls?: { ids: string[][]; served: number } } = {}) {
    const clamp = opts.clamp ?? 3;
    const calls = opts.calls ?? { ids: [], served: 0 };
    const page = (limit: number, cursor: Cursor) => {
        const start = offsetOf(cursor);
        const slice = rows.slice(start, start + Math.min(limit, clamp));
        calls.served += slice.length;
        return { slice, next: cursorAt(start + slice.length) };
    };
    const graph = {
        async bulkList(q: { limit?: number; cursor?: Cursor; types?: string[] }) {
            const { slice, next } = page(q.limit ?? 1000, q.cursor ?? null);
            const nodes = slice.map((r) => { const { status: _s, stale: _st, ...rest } = r; return rest; });
            return { nodes, nextCursor: next, hasMore: true };
        },
        async getNodesByIds(ids: string[]) {
            calls.ids.push(ids);
            return new Map(rows.filter((r) => ids.includes(String(r['id']))).map((r) => [String(r['id']), r]));
        },
        ...(opts.projected ? {
            async bulkListProjected(_p: string, _c: readonly string[], limit: number, cursor: Cursor) {
                const { slice, next } = page(limit, cursor);
                return { rows: slice, nextCursor: next };
            },
        } : {}),
    };
    return { graph: graph as unknown as VisibleCountGraph, calls };
}

const nodeRows = (n: number, scopeFor: (i: number) => string[] = () => []): Row[] =>
    Array.from({ length: n }, (_, i) => ({ id: `n${i}`, type: 'T', status: 'active', stale: false, ...(scopeFor(i).length ? { security_scopes: scopeFor(i) } : {}) }));

/** Edge source honouring limit/offset but clamping every page, like Arcade's queryEdges. */
function clampedEdges(edges: Array<{ sourceId: string; targetId: string }>, nodeIds: string[], clamp = 2): VisibleEdgeGraph {
    return {
        async queryEdges(q: { limit?: number; offset?: number }) {
            const start = q.offset ?? 0;
            return edges.slice(start, start + Math.min(q.limit ?? 1000, clamp)).map((e) => ({ ...e, relation: 'R' }));
        },
        async getNodesByIds(ids: string[]) {
            return new Map(ids.filter((id) => nodeIds.includes(id)).map((id) => [id, { id, type: 'T', label: id, project: 'dev' }]));
        },
    } as unknown as VisibleEdgeGraph;
}

async function main(): Promise<void> {
    /* ---------- 1. quota rejections ---------- */
    const WS = (maxNodes: number): WorkspaceEntry => ({ name: 'dev', path: '/tmp/dev', createdAt: 'x', maxNodes } as WorkspaceEntry);
    const fakeRes = () => {
        const r = { _status: 0, _body: '', writeHead(s: number) { r._status = s; return r; }, end(b?: string) { r._body = b ?? ''; } };
        return r as unknown as ServerResponse & { _status: number; _body: string };
    };
    const quotaDeps = () => {
        const store = new InMemoryWorkspaceQuotaStore();
        store.reconcile('dev', { nodeCount: 5, storageBytes: 0 });
        return { store, getWorkspaceEntry: () => WS(5) };
    };

    await test('quotaCurrentField: kept for unbound/operator, dropped for app token', () => {
        assert.deepEqual(as('unbound', () => quotaCurrentField(5)), { current: 5 });
        assert.deepEqual(as('operator', () => quotaCurrentField(5)), { current: 5 });
        assert.deepEqual(as('app', () => quotaCurrentField(5)), {});
    });
    await test('enforceQuotaOrReject: 429 body carries current for unbound/operator, not for the app token; decision unchanged', () => {
        for (const who of ['unbound', 'operator', 'app'] as Who[]) {
            const res = fakeRes();
            const out = as(who, () => enforceQuotaOrReject(quotaDeps(), res, 'dev', { nodes: 1 }));
            assert.equal(out.handled, true);
            assert.equal(res._status, 429);
            const body = JSON.parse(res._body) as Record<string, unknown>;
            assert.equal(body['error'], 'workspace_quota_exceeded');
            assert.equal(body['dimension'], 'maxNodes');
            assert.equal(body['cap'], 5);
            assert.equal(body['workspace'], 'dev');
            assert.ok(typeof body['hint'] === 'string');
            if (who === 'app') assert.ok(!('current' in body) && !/"current"/.test(res._body), res._body);
            else assert.equal(body['current'], 5);
        }
    });

    const commitRejection = async (who: Who): Promise<Record<string, unknown>> => {
        const quotaStore = new InMemoryWorkspaceQuotaStore();
        quotaStore.reconcile('dev', { nodeCount: 5, storageBytes: 0 });
        const writes = [{ seq: 0, operation: 'upsert_node', payload: { workspace: 'dev', nodeData: { id: 'n1', type: 'decision', label: 'l', content: '' } } }];
        const vs = {
            getChangeset: (id: string) => ({ changesetId: id, workspace: 'dev', status: 'open' }),
            getChangesetWrites: () => writes,
            recordVersion: () => undefined, updateChangeset: () => undefined,
            getVersionsByChangeset: () => [], createChangeset: () => 'cs-x', getVersions: () => [], getDiff: () => [], addChangesetWrite: () => 1,
        };
        const deps = {
            versionStore: vs as never,
            store: { loreGraph: { async upsertNode(n: unknown) { return n; }, async getNode() { return null; }, async deleteNode() { return true; } } } as never,
            graphRegistry: undefined,
            detectedScope: { workspace: 'dev', ecosystem: '*' },
            quotaStore,
            getWorkspaceEntryForQuota: () => WS(5),
        } as unknown as VersioningDeps;
        const tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> = [];
        registerVersioningTools({ tool: (name: string, _d: string, _s: unknown, handler: never) => { tools.push({ name, handler }); } } as never, deps);
        const r = await as(who, () => tools.find((t) => t.name === 'commit_changeset')!.handler({ changeset_id: 'cs1' }));
        assert.equal(r.isError, true);
        return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    };
    await test('commit_changeset quota rejection: current present for unbound/operator, absent for the app token (other fields kept)', async () => {
        const u = await commitRejection('unbound');
        const o = await commitRejection('operator');
        const a = await commitRejection('app');
        assert.equal(u['current'], 5);
        assert.deepEqual(o, u, 'operator identical to unbound');
        assert.ok(!('current' in a));
        const { current: _c, ...uRest } = u;
        assert.deepEqual(a, uRest, 'everything but `current` is unchanged');
        assert.equal(a['error'], 'workspace_quota_exceeded');
    });

    /* ---------- 3/5. clamped / short pages: no early stop, no undercount ---------- */
    await test('nodes: short (clamped) pages with a non-null cursor are walked to the end', async () => {
        const { graph } = arcadeNodes(nodeRows(10, (i) => (i % 2 ? ['y'] : [])));
        const r = await as('app', () => countVisibleNodes(graph));
        assert.equal(r.nodeCount, 5);
        assert.equal(r.scanned, 10);
        assert.equal(r.lowerBound, false);
    });
    await test('nodes (projected engines): clamped pages are walked to the end too', async () => {
        const { graph } = arcadeNodes(nodeRows(10), { projected: true });
        const r = await as('app', () => countVisibleNodes(graph, { byType: true }));
        assert.equal(r.nodeCount, 10);
        assert.deepEqual(r.typeBreakdown, { T: 10 });
        assert.equal(r.lowerBound, false);
    });
    await test('edges: clamped pages (2 of every 1000 requested) are walked to the end, no undercount', async () => {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        const edges = ids.slice(1).map((t) => ({ sourceId: 'a', targetId: t }));
        const r = await as('app', () => countVisibleEdges(clampedEdges(edges, ids)));
        assert.equal(r.edgeCount, 6);
        assert.equal(r.scanned, 6);
        assert.equal(r.lowerBound, false);
    });

    /* ---------- 5. exact-cap lowerBound ---------- */
    await test('nodes: exactly cap rows + non-null cursor is NOT a lower bound; one more real row is', async () => {
        const exact = await as('app', () => countVisibleNodes(arcadeNodes(nodeRows(6), { clamp: 1000 }).graph, { cap: 6 }));
        assert.equal(exact.nodeCount, 6);
        assert.equal(exact.lowerBound, false);
        const over = await as('app', () => countVisibleNodes(arcadeNodes(nodeRows(7), { clamp: 1000 }).graph, { cap: 6 }));
        assert.equal(over.nodeCount, 6);
        assert.equal(over.lowerBound, true);
    });
    await test('edges: exactly cap edges is NOT a lower bound; one more real edge is', async () => {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        const mk = (n: number) => ids.slice(1, 1 + n).map((t) => ({ sourceId: 'a', targetId: t }));
        const exact = await as('app', () => countVisibleEdges(clampedEdges(mk(5), ids), { cap: 5 }));
        assert.equal(exact.edgeCount, 5);
        assert.equal(exact.lowerBound, false);
        const over = await as('app', () => countVisibleEdges(clampedEdges(mk(6), ids), { cap: 5 }));
        assert.equal(over.edgeCount, 5);
        assert.equal(over.lowerBound, true);
    });

    /* ---------- 4. bulkList rows without lifecycle columns ---------- */
    await test('bulkList path: missing extraColumns are filled from the full node, only for visible rows', async () => {
        const rows = nodeRows(6, (i) => (i < 2 ? ['y'] : [])); // n0, n1 hidden
        rows[3]!['status'] = 'archived';
        rows[4]!['stale'] = true;
        const { graph, calls } = arcadeNodes(rows, { clamp: 1000 });
        const seen: Row[] = [];
        await as('app', () => forEachVisibleNode(graph, { extraColumns: ['status', 'stale'] }, (r) => seen.push(r)));
        assert.deepEqual(seen.map((r) => r['id']), ['n2', 'n3', 'n4', 'n5']);
        assert.equal(seen[1]!['status'], 'archived');
        assert.equal(seen[2]!['stale'], true);
        assert.equal(seen[0]!['status'], 'active');
        const hydrated = calls.ids.flat();
        assert.ok(hydrated.length > 0 && hydrated.every((id) => !['n0', 'n1'].includes(id)), `hidden rows must not be hydrated: ${hydrated}`);
    });
    /* ---------- 6/7. report walks ---------- */
    function reportGraph(nodes: Row[], edges: Array<{ sourceId: string; targetId: string }>): ReportGraph & { served: { rows: number } } {
        const served = { rows: 0 };
        const byId = new Map(nodes.map((n) => [String(n['id']), n]));
        return {
            served,
            async getStats() {
                const typeBreakdown: Record<string, number> = {};
                for (const n of nodes) if (n['type']) typeBreakdown[String(n['type'])] = (typeBreakdown[String(n['type'])] ?? 0) + 1;
                return { nodeCount: nodes.length, edgeCount: edges.length, typeBreakdown };
            },
            async queryEdges(q: { limit?: number; offset?: number }) {
                const start = q.offset ?? 0;
                return edges.slice(start, start + Math.min(q.limit ?? 1000, 1000)).map((e) => ({ ...e, relation: 'R' }));
            },
            async getNodesByIds(ids: string[]) {
                return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, { ...byId.get(id)!, label: id }]));
            },
            async bulkListProjected(_p: string, _c: readonly string[], limit: number, cursor: Cursor) {
                const start = offsetOf(cursor);
                const rows = nodes.slice(start, start + limit).map((n, i) => ({ ...n, updatedAt: `2026-01-${String(1 + ((start + i) % 28)).padStart(2, '0')}T00:00:00Z`, label: n['id'] }));
                served.rows += rows.length;
                return { rows, nextCursor: start + rows.length < nodes.length || rows.length === limit ? cursorAt(start + rows.length) : null };
            },
        } as unknown as ReportGraph & { served: { rows: number } };
    }
    const bigNodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, type: i === 29 ? '' : 'T' }));
    const chain = Array.from({ length: 29 }, (_, i) => ({ sourceId: `n${i}`, targetId: `n${i + 1}` }));

    await test('report: app token walks are bounded by the cap; orphans omitted when the edge scan is capped; hubs and counts render <n>+', async () => {
        const g = reportGraph(bigNodes, chain);
        const md = await as('app', () => writeGraphReport(g, { visibleCounts: { cap: 4 } }));
        assert.ok(g.served.rows <= 3 * (4 + 1), `bounded node walks, served ${g.served.rows}`);
        assert.match(md, /^- \*\*Nodes\*\*: 4\+$/m);
        assert.match(md, /^- \*\*Edges\*\*: \d+\+$/m);
        assert.match(md, /\| \d+\+ \| T \|/, 'hub degree is a lower bound');
        assert.ok(md.includes('_(not shown — too many edges to scan)_'));
        assert.ok(!md.includes('without edges'), 'no orphan list when the edge scan was capped');
        assert.ok(md.includes('lower bounds'));
        assert.ok(!/scope|permission|hidden/i.test(md));
    });
    await test('report: unbound walks the whole table (unchanged) and lists no <n>+', async () => {
        const g = reportGraph(bigNodes, chain);
        const md = await writeGraphReport(g, {});
        assert.ok(g.served.rows >= 60, `raw walks read everything, served ${g.served.rows}`);
        assert.ok(!/\d\+/.test(md.replace(/Generated: \S+/, '')), md);
        assert.ok(md.includes('_None — every node has at least one edge._'));
    });
    await test('report: node-by-type has no empty-type bucket (raw and app token agree)', async () => {
        const raw = await writeGraphReport(reportGraph(bigNodes, chain), {});
        const vis = await as('app', () => writeGraphReport(reportGraph(bigNodes, chain), { visibleCounts: { cap: 1000 } }));
        for (const md of [raw, vis]) {
            assert.ok(!md.includes('|  |'), 'no empty-type row');
            assert.ok(md.includes('| T | 29 |'));
        }
    });
    await test('computeOrphans with a budget stops at the cap and flags lowerBound only when more rows exist', async () => {
        const g = reportGraph(bigNodes, []);
        const capped = { cap: 5, lowerBound: false };
        const rows = await computeOrphans(g, new Set(), 100, undefined, capped);
        assert.equal(rows.length, 5);
        assert.equal(capped.lowerBound, true);
        const exact = { cap: 30, lowerBound: false };
        await computeOrphans(reportGraph(bigNodes, []), new Set(), 100, undefined, exact);
        assert.equal(exact.lowerBound, false, 'cap == row count is exact');
    });

    /* ---------- 6. sweepFreshness ---------- */
    const NOW = Date.parse('2026-06-01T00:00:00Z');
    const iso = (hAgo: number): string => new Date(NOW - hAgo * 3600_000).toISOString();
    const fRows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({
        id: `f${i}`, syncedAt: iso(1), updatedAt: iso(1), ...(i % 3 === 0 ? { security_scopes: ['y'] } : {}),
    }));
    function freshGraph(rows: Row[], log: { limits: unknown[]; unbounded: number }): IFreshnessGraph {
        return {
            async listNodes(_t?: string, _g?: string, _p?: string, _e?: string, limit?: number, opts?: { unbounded?: boolean }) {
                log.limits.push(limit);
                if (opts?.unbounded) log.unbounded++;
                return rows.slice(0, limit ?? rows.length) as never;
            },
        } as unknown as IFreshnessGraph;
    }
    function pagedFreshGraph(rows: Row[]): IFreshnessGraph {
        return {
            async listNodes() { throw new Error('listNodes must not run when a pager exists'); },
            async bulkListProjected(_p: string, _c: readonly string[], limit: number, cursor: Cursor) {
                const start = offsetOf(cursor);
                const slice = rows.slice(start, start + Math.min(limit, 3));
                return { rows: slice, nextCursor: start + slice.length < rows.length ? cursorAt(start + slice.length) : null };
            },
        } as unknown as IFreshnessGraph;
    }
    await test('sweepFreshness unbound / operator: unchanged report (no labels), unbounded listNodes fallback as before', async () => {
        const log = { limits: [] as unknown[], unbounded: 0 };
        for (const who of ['unbound', 'operator'] as Who[]) {
            const r = await as(who, () => sweepFreshness(freshGraph(fRows(6), log), 'dev', 24, NOW));
            assert.equal(r.totalNodes, 6);
            assert.ok(!('countScope' in r) && !('countsLowerBound' in r));
        }
        assert.equal(log.unbounded, 2);
    });
    await test('sweepFreshness app token (no pager): bounded listNodes, visible rows only, labelled; cap -> countsLowerBound', async () => {
        const log = { limits: [] as unknown[], unbounded: 0 };
        const visibleOnly = (row: { security_scopes?: unknown }): boolean => !Array.isArray(row.security_scopes);
        const r = await as('app', () => sweepFreshness(freshGraph(fRows(6), log), 'dev', 24, NOW, visibleOnly));
        assert.equal(log.unbounded, 0, 'never the unbounded fallback');
        assert.equal(r.countScope, 'visible');
        assert.equal(r.totalNodes, 4, '6 rows, 2 hidden');
        assert.ok(!('countsLowerBound' in r));
        setVisibleScanCapForTests(4);
        try {
            const c = await as('app', () => sweepFreshness(freshGraph(fRows(6), log), 'dev', 24, NOW, visibleOnly));
            assert.equal(c.countsLowerBound, true);
            assert.ok(c.totalNodes <= 4);
            const exact = await as('app', () => sweepFreshness(freshGraph(fRows(4), log), 'dev', 24, NOW, visibleOnly));
            assert.ok(!('countsLowerBound' in exact), 'cap == row count is exact');
        } finally { setVisibleScanCapForTests(undefined); }
    });
    await test('sweepFreshness app token (pager, clamped pages): visible-only, whole table within the cap, labelled', async () => {
        const r = await as('app', () => sweepFreshness(pagedFreshGraph(fRows(9)), 'dev', 24, NOW));
        assert.equal(r.countScope, 'visible');
        assert.equal(r.totalNodes, 6, '9 rows, 3 hidden');
        assert.ok(!('countsLowerBound' in r));
        const u = await as('unbound', () => sweepFreshness(pagedFreshGraph(fRows(9)), 'dev', 24, NOW));
        assert.ok(!('countScope' in u));
        assert.equal(u.totalNodes, 9);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

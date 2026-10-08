#!/usr/bin/env tsx
/**
 * test/visible-counts-unit.ts - security/visibleCounts.ts, the shared
 * visible-only count helper used by every counts surface for a BOUND
 * non-operator.
 *
 * Real sqlite-backed graph in a temp dir. Items carry security_scopes ['x'],
 * ['y'] or none; the actor is bound to ['x'] so it sees the 'x' items and the
 * public ones, never the 'y' ones.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import {
    countAudience, countVisibleEdges, countVisibleNodes, formatVisibleCount,
} from '../packages/lore/src/security/visibleCounts.js';
import { SCOPE_PAGE_FILL_MAX_SCAN } from '../packages/lore/src/security/scopePageFill.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n    ${(e as Error).message}`); }
}

const X = { portalUserId: 'u', scopes: ['x'] } as const;
const bound = <T>(fn: () => T): T => runWithActor(X, fn);
const APP: Principal = { kind: 'app', workspace: 'ws', scopes: ['read', 'write'], label: 'app-1' };
const BOOT: Principal = { kind: 'bootstrap', workspace: 'ws', scopes: ['read', 'write'], label: 'bootstrap' };
const SHARED: Principal = { kind: 'shared-secret', workspace: 'ws', scopes: ['read', 'write'], label: 'svc' };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-visible-counts-'));
const g = new SqliteGraph(dir, { workspaceId: 'vc', cacheDisabled: true });

async function seed(): Promise<void> {
    await g.initialize();
    const n = (id: string, type: string, scopes: string[], language?: string) => g.upsertNode({
        id, type, label: id, content: id, tags: [], project: '*', ecosystem: '*', metadata: '{}',
        ...(scopes.length ? { security_scopes: scopes } : {}),
        ...(language ? { language } : {}),
    });
    await n('t-x1', 'T', ['x'], 'en');
    await n('t-x2', 'T', ['x']);
    await n('t-y1', 'T', ['y'], 'fr');
    await n('t-p1', 'T', []);
    await n('u-x', 'U', ['x'], 'en');
    await n('u-y', 'U', ['y']);
    const e = (s: string, t: string, r: string) => g.addEdge({ sourceId: s, targetId: t, relation: r });
    await e('t-x1', 't-x2', 'R'); // both visible
    await e('t-x1', 't-y1', 'R'); // hidden target
    await e('t-p1', 'u-x', 'R');  // public + visible
    await e('u-y', 't-x2', 'R');  // hidden source
    await e('t-x2', 't-x1', 'S'); // both visible, other relation
}

async function main(): Promise<void> {
    await seed();

    // Same graph without bulkListProjected: what dataplane / arcade expose.
    const noProjection = { bulkList: (q: Parameters<SqliteGraph['bulkList']>[0]) => g.bulkList(q) };

    await test('countAudience: raw for unbound, bootstrap and shared-secret; visible for app token and principal-less actor', () => {
        assert.equal(countAudience(), 'raw');
        assert.equal(bound(() => countAudience()), 'visible');
        assert.equal(bound(() => runWithPrincipal(APP, () => countAudience())), 'visible');
        assert.equal(bound(() => runWithPrincipal(BOOT, () => countAudience())), 'raw');
        assert.equal(bound(() => runWithPrincipal(SHARED, () => countAudience())), 'raw');
        assert.equal(runWithPrincipal(APP, () => countAudience()), 'raw', 'principal alone (no bound actor) is unbound');
    });

    await test('countVisibleNodes: type filter counts only visible rows of that type', async () => {
        const r = await bound(() => countVisibleNodes(g, { type: 'T' }));
        assert.equal(r.nodeCount, 3);          // t-x1, t-x2, t-p1 (t-y1 hidden)
        assert.equal(r.lowerBound, false);
        assert.equal(r.scanned, 4);
        assert.equal(r.typeBreakdown, undefined);
        assert.equal(r.languageBreakdown, undefined);
    });

    await test('countVisibleNodes: no filter, byType + byLanguage (projected path)', async () => {
        const r = await bound(() => countVisibleNodes(g, { byType: true, byLanguage: true }));
        assert.equal(r.nodeCount, 4);
        assert.deepEqual(r.typeBreakdown, { T: 3, U: 1 });
        assert.deepEqual(r.languageBreakdown, { en: 2, null: 2 });
        assert.equal(r.scanned, 6);
    });

    await test('countVisibleNodes: bulkList-only engines (no bulkListProjected) give the same count and type breakdown', async () => {
        const a = await bound(() => countVisibleNodes(g, { byType: true }));
        const b = await bound(() => countVisibleNodes(noProjection, { byType: true }));
        assert.deepEqual(b, a);
    });

    await test('countVisibleNodes: type filter + byLanguage uses the projection and filters by type', async () => {
        const r = await bound(() => countVisibleNodes(g, { type: 'T', byLanguage: true }));
        assert.equal(r.nodeCount, 3);
        assert.deepEqual(r.languageBreakdown, { en: 1, null: 2 });
    });

    await test('countVisibleNodes: unbound sees every row (callers short-circuit before this)', async () => {
        const r = await countVisibleNodes(g, { type: 'T' });
        assert.equal(r.nodeCount, 4);
    });

    await test('countVisibleNodes: cap below the row count -> lowerBound, scanned == cap', async () => {
        const typed = await bound(() => countVisibleNodes(g, { type: 'T', cap: 2 }));
        assert.equal(typed.lowerBound, true);
        assert.equal(typed.scanned, 2);
        assert.ok(typed.nodeCount <= 2);
        const untyped = await bound(() => countVisibleNodes(g, { cap: 3 }));
        assert.equal(untyped.lowerBound, true);
        assert.equal(untyped.scanned, 3);
        const noProj = await bound(() => countVisibleNodes(noProjection, { cap: 3 }));
        assert.equal(noProj.lowerBound, true);
        assert.equal(noProj.scanned, 3);
    });

    await test('countVisibleNodes: cap equal to the row count is exact, not a lower bound', async () => {
        const r = await bound(() => countVisibleNodes(g, { type: 'T', cap: 4 }));
        assert.equal(r.lowerBound, false);
        assert.equal(r.nodeCount, 3);
        assert.equal(SCOPE_PAGE_FILL_MAX_SCAN, 10_000);
    });

    await test('countVisibleEdges: an edge counts only if BOTH endpoints are visible', async () => {
        const all = await bound(() => countVisibleEdges(g));
        assert.deepEqual(all, { edgeCount: 3, scanned: 5, lowerBound: false }); // R: x1->x2, p1->u-x ; S: x2->x1
        const rel = await bound(() => countVisibleEdges(g, { relation: 'R' }));
        assert.equal(rel.edgeCount, 2);
        assert.equal(rel.scanned, 4);
        const raw = await countVisibleEdges(g, { relation: 'R' });
        assert.equal(raw.edgeCount, 4, 'unbound: every endpoint is visible');
    });

    await test('countVisibleEdges: endpoint-type filters (inbound edges to a node type)', async () => {
        const inbound = await bound(() => countVisibleEdges(g, { targetType: 'T' }));
        assert.equal(inbound.edgeCount, 2);    // x1->x2 (R) and x2->x1 (S)
        const outbound = await bound(() => countVisibleEdges(g, { sourceType: 'U' }));
        assert.equal(outbound.edgeCount, 0);   // u-y is hidden
    });

    await test('countVisibleEdges: cap -> lowerBound; exact cap is not a lower bound', async () => {
        const capped = await bound(() => countVisibleEdges(g, { relation: 'R', cap: 2 }));
        assert.equal(capped.lowerBound, true);
        assert.equal(capped.scanned, 2);
        const exact = await bound(() => countVisibleEdges(g, { relation: 'R', cap: 4 }));
        assert.equal(exact.lowerBound, false);
        assert.equal(exact.edgeCount, 2);
    });

    await test('formatVisibleCount: <n>+ when capped', () => {
        assert.equal(formatVisibleCount(10_000, true), '10,000+');
        assert.equal(formatVisibleCount(12, false), '12');
    });

    await g.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env tsx
/**
 * audit-recall-seed-scope-unit.ts — R3 audit #7 (medium). The recall
 * semantic-seed scan queried deps.store.storageClient (the BOOT/ACTIVE vector
 * store) regardless of the requested workspace. For a non-active recall, a boot
 * seed that COLLIDES with an id in the target workspace hydrated → seedNodeIds
 * non-empty → the per-workspace keyword search was SUPPRESSED (it only runs
 * when seeds come up empty), hiding the target workspace's OTHER keyword
 * matches. The fix gates the boot seed scan to the active workspace
 * (graphForRecall === deps.store.loreGraph); non-active falls through to the
 * requested-workspace-scoped keyword search.
 *
 * Drives inProcessRecall over two REAL SurrealGraphs (it scopes by the requested
 * workspace, so the fix is sufficient).
 * Run: npm run test:unit:audit-recall-seed-scope
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { inProcessRecall } from '../packages/lore/src/recall/inProcessRecall.js';
import { registerSearchTools } from '../packages/lore/src/mcp/tools/search.js';
import { z } from 'zod';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('R3 #7 — recall seed scan must not suppress the target workspace keyword fallback');

await test('R3#7 non-active recall finds the workspace own keyword matches (colliding boot seed does not suppress fallback)', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-recall-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-recall-b-'));
    const gActive = new SurrealGraph(dirA); // boot/active
    const gB = new SurrealGraph(dirB);      // non-active target
    try {
        await gActive.initialize();
        await gB.initialize();
        const node = (g: SurrealGraph, id: string, content: string) => g.upsertNode({
            id, type: 'note', label: id, content, tags: ['topic'], project: 'wsB', ecosystem: '*',
            metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
        } as never);
        // B has a node whose id COLLIDES with the boot seed, AND a B-specific
        // node — both match the keyword 'widgets'.
        await node(gB, 'shared:1', 'about widgets shared');
        await node(gB, 'b-only', 'about widgets local');

        // Boot/active vector store returns 'shared:1' as a semantic seed (the
        // only id it knows). Pre-fix this hydrated in B and suppressed B's
        // keyword scan.
        let seedScans = 0;
        const storageClient = {
            async verbatimCount() { return 1; },
            async verbatimSearch() { seedScans++; return [{ id: 'lore:shared:1', score: 0.9, text: 'widgets shared' }]; },
            async verbatimBm25Search() { seedScans++; return [{ id: 'lore:shared:1', score: 0.9, text: 'widgets shared' }]; },
        };
        const deps = {
            store: {
                loreGraph: gActive,
                storageClient: storageClient as never,
                loreVerbatim: { store: async () => undefined } as never,
                sessionCache: { pushNode: () => undefined } as never,
            },
            graphRegistry: { getOrOpen: async (ws: string) => (ws === 'wsB' ? gB : gActive), getGraphHandle: async (ws: string) => (ws === 'wsB' ? gB : gActive) } as never,
            versionStore: undefined,
            detectedScope: { workspace: 'wsA', ecosystem: '*' },
        };

        const res = await inProcessRecall('widgets', { workspace: 'wsB', mode: 'summary', searchMode: 'hybrid', max: 10, depth: 1 } as never, deps as never);
        const ids: string[] = ((res as { hits?: Array<{ id?: string }> }).hits ?? []).map((h) => h.id ?? '');

        assert.ok(ids.includes('b-only'), `B's own keyword match 'b-only' must surface (was suppressed by the colliding boot seed); got ${JSON.stringify(ids)}`);
        assert.equal(seedScans, 0, 'boot vector store must NOT be scanned for a non-active workspace recall');
    } finally {
        await gActive.close().catch(() => undefined);
        await gB.close().catch(() => undefined);
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    }
});

// ── Follow-up to R3 #7 — the MCP recall tool keyword search must scope to the
// REQUESTED workspace, not the ACTIVE one. recallTool used
// deps.detectedScope.workspace as the project filter on graphForRecall.search;
// since graphForRecall is already the requested workspace's graph and its nodes
// carry project=<workspace>, filtering by the active workspace's project
// returned NOTHING for a non-active recall. (Isolated from the #7 seed-scan
// gate by returning no seeds, so the keyword path always runs.)
await test('recallTool keyword search scopes to the REQUESTED workspace (non-active recall finds its own nodes)', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rt-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rt-b-'));
    const gActive = new SurrealGraph(dirA); // active = wsA
    const gB = new SurrealGraph(dirB);      // requested = wsB
    try {
        await gActive.initialize();
        await gB.initialize();
        await gB.upsertNode({
            id: 'b-node', type: 'note', label: 'b-node', content: 'about widgets', tags: ['topic'],
            project: 'wsB', ecosystem: 'default', metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
        } as never);

        // No vector seeds → the keyword path always runs (isolates the scope fix).
        const storageClient = {
            async verbatimCount() { return 0; },
            async verbatimSearch() { return []; },
            async verbatimBm25Search() { return []; },
        };
        const tools: Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>> = {};
        const mcpServerStub = { tool: (name: string, ..._rest: unknown[]) => {
            const handler = _rest[_rest.length - 1];
            if (typeof handler === 'function') tools[name] = handler as never;
        } };
        registerSearchTools(mcpServerStub as never, {
            store: {
                loreGraph: gActive,
                storageClient: storageClient as never,
                loreVerbatim: { store: async () => undefined } as never,
                sessionCache: { pushNode: () => undefined } as never,
            } as never,
            // active workspace is wsA — DIFFERENT from the requested wsB
            detectedScope: { workspace: 'wsA', ecosystem: 'default' },
            graphRegistry: { getOrOpen: async (ws: string) => (ws === 'wsB' ? gB : gActive), getGraphHandle: async (ws: string) => (ws === 'wsB' ? gB : gActive) } as never,
            nodeTypesEnum: z.enum(['note', 'decision']),
            edgeRelationsEnum: z.enum(['related_to']),
        } as never);

        const out = await tools['recall']!({ topic: 'widgets', workspace: 'wsB' });
        const body = JSON.parse(out.content[0]!.text);
        const ids: string[] = (body.hits ?? []).map((h: { id?: string }) => h.id ?? '');
        assert.ok(ids.includes('b-node'), `non-active recall must find wsB's own node (keyword scoped to requested ws); got ${JSON.stringify(ids)}`);
    } finally {
        await gActive.close().catch(() => undefined);
        await gB.close().catch(() => undefined);
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    }
});

// Follow-up: a named workspace owns the graph boundary, but its nodes may use
// an unrelated project label (Atlas v3: workspace=default, project=v3). The
// keyword path must not pass the workspace name as graph.project and return an
// empty result while the semantic path still works.
await test('search keyword fallback scopes to the requested graph, not its project-name alias', async () => {
    let capturedProject = '';
    const node = {
        id: 'v3-node', type: 'note', label: 'v3-node', content: 'about widgets', tags: ['topic'],
        project: 'v3', ecosystem: '*', updatedAt: '2026-08-09T00:00:00.000Z',
    };
    const graph = {
        async search(_query: string, _limit: number, project: string) {
            capturedProject = project;
            return project === '*' ? [node] : [];
        },
        async getNodesByIds() { return new Map(); },
        async traverse() { return []; },
        async getNode() { return node; },
    };
    const tools: Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {};
    const mcpServerStub = { tool: (name: string, ..._rest: unknown[]) => {
        const handler = _rest[_rest.length - 1];
        if (typeof handler === 'function') tools[name] = handler as never;
    } };
    registerSearchTools(mcpServerStub as never, {
        store: {
            loreGraph: graph,
            storageClient: {
                async verbatimCount() { return 0; },
                async verbatimSearch() { return []; },
                async verbatimBm25Search() { return []; },
            } as never,
            loreVerbatim: { store: async () => undefined } as never,
            sessionCache: { pushNode: () => undefined } as never,
        } as never,
        detectedScope: { workspace: 'wsA', ecosystem: '*' },
        graphRegistry: { getGraphHandle: async () => graph, getOrOpen: async () => graph } as never,
        nodeTypesEnum: z.enum(['note', 'decision']),
        edgeRelationsEnum: z.enum(['related_to']),
    } as never);

    const out = await tools['search']!({ query: 'widgets', workspace: 'wsB', search_mode: 'keyword' });
    const body = JSON.parse(out.content[0]!.text);
    assert.ok(body.results.some((r: { id?: string }) => r.id === 'v3-node'), `requested graph node must surface: ${JSON.stringify(body)}`);
    assert.equal(capturedProject, '*', 'named workspace search must not use the workspace name as project filter');
});

// ── R4 #3 (semantic) — over-fetch so archived seeds don't crowd out a live one ──
// The recall tool's hybrid/semantic seed scan fetched only the top-N verbatim
// seeds, then dropped archived/superseded AFTER the slice. With many hidden
// matches outranking a live one in the vector store, the live node fell outside
// the N-window and recall returned 0. The over-fetch (SEED_HIDDEN_HEADROOM×) +
// post-filter + slice now surfaces it.
await test('R4#3 semantic recall over-fetches so a live match outranked by archived seeds still surfaces', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sem-'));
    const g = new SurrealGraph(dir);
    try {
        await g.initialize();
        const note = (id: string, extra: Record<string, unknown> = {}) => g.upsertNode({
            id, type: 'note', label: id, content: 'needle widget', tags: ['t'],
            project: 'wsA', ecosystem: 'default', metadata: '{}', language: null, ephemeral: false, ttl_ms: null, ...extra,
        } as never);
        // 12 archived strong matches rank ABOVE the 1 live match in the vector store.
        for (let i = 0; i < 12; i++) await note('arch' + i, { status: 'archived' });
        await note('live');

        // Mocked vector store: archived ids ranked first, the live id last. The
        // mock respects the fetch limit N, so the OLD top-10 fetch would return
        // only archived ids (→ 0 hits); the new 4x over-fetch reaches 'live'.
        const ranked = [...Array.from({ length: 12 }, (_, i) => ({ id: `lore:arch${i}`, score: 0.99 - i * 0.01, text: 'needle' })), { id: 'lore:live', score: 0.5, text: 'needle' }];
        const storageClient = {
            async verbatimCount() { return ranked.length; },
            async verbatimSearch(_q: string, n: number) { return ranked.slice(0, n); },
            async verbatimBm25Search(_q: string, n: number) { return ranked.slice(0, n); },
        };
        const tools: Record<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {};
        const mcpServerStub = { tool: (name: string, ..._rest: unknown[]) => {
            const h = _rest[_rest.length - 1];
            if (typeof h === 'function') tools[name] = h as never;
        } };
        registerSearchTools(mcpServerStub as never, {
            store: { loreGraph: g, storageClient: storageClient as never, loreVerbatim: { store: async () => undefined } as never, sessionCache: { pushNode: () => undefined } as never } as never,
            detectedScope: { workspace: 'wsA', ecosystem: 'default' },
            graphRegistry: { getOrOpen: async () => g, getGraphHandle: async () => g } as never,
            nodeTypesEnum: z.enum(['note', 'decision']),
            edgeRelationsEnum: z.enum(['related_to']),
        } as never);

        const out = await tools['recall']!({ topic: 'needle', workspace: 'wsA', search_mode: 'hybrid' });
        const body = JSON.parse(out.content[0]!.text);
        const ids: string[] = (body.hits ?? []).map((h: { id?: string }) => h.id ?? '');
        assert.ok(ids.includes('live'), `the live match must surface despite 12 archived seeds ranking above it; got ${JSON.stringify(ids)}`);
        assert.ok(!ids.some((id) => id.startsWith('arch')), 'archived seeds must not appear in results');
        await g.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

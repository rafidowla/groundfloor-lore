#!/usr/bin/env tsx
/**
 * p2-verbatim-write-route-isolation-unit.ts — P2 (isolation), round-4.
 *
 * Companion to p2-query-route-verbatim-isolation-unit.ts. Covers the remaining
 * boot-bound verbatim call sites in workspace-routed HTTP handlers that the
 * per-workspace verbatim migration had missed:
 *
 *   1. POST /api/nodes/prune (hard_delete) — lifecycle.ts. The GRAPH delete
 *      routes to the REQUESTED workspace B via resolveTargetGraph, but the
 *      verbatim tombstone's DELETE fallback (backend without tombstone) used to
 *      hit deps.store.storageClient.verbatimDelete — the ACTIVE workspace A's
 *      LanceDB. A non-active-workspace delete that lands on the active store
 *      orphans B's vector and can corrupt A's. The fix routes the delete to the
 *      SAME resolved (B) verbatim store.
 *
 *   2. GET /api/node/supersession-candidates — supersessionCandidates.ts. The
 *      GRAPH scan routes to B via resolveReadGraph, but the similarity search
 *      (verbatimSearch) seeded from the boot storageClient (A's LanceDB). The
 *      fix resolves B's OWN VerbatimStore; with no resolver / a failed open the
 *      vector scan is SKIPPED (no pairs), never seeded from A.
 *
 * Run: npx tsx test/p2-verbatim-write-route-isolation-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loreHome } from '../packages/lore/src/config/loreHome.js';
import { tryLifecycleRoutes } from '../packages/lore/src/mcp/http/routes/lifecycle.js';
import { handleSupersessionCandidates } from '../packages/lore/src/mcp/http/routes/nodes/supersessionCandidates.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

type FNode = { id: string; type: string; label: string; content: string; tags: string[]; project: string; status?: string; supersededAt?: string | null; createdAt?: string; updatedAt?: string };
// Default candidate types for the supersession scan are
// decision/architecture/convention/bug_pattern — use `decision` so the nodes
// survive the type filter and reach the vector scan.
const mk = (id: string, project: string): FNode => ({ id, type: 'decision', label: id, content: `body ${id}`, tags: ['t'], project, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function fakeReq(method: string, body: string, url = '/api/nodes/prune'): IncomingMessage {
    let consumed = false;
    return {
        method, url,
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

/* ═══ 1. lifecycle prune hard_delete tombstone routing ═══════════════════ */

// Write a workspaces.json in the test-process home so loadWorkspaces() finds
// workspace B with allowHardDelete=true (the route 404s/403s otherwise).
const home = loreHome();
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
    path.join(home, 'workspaces.json'),
    JSON.stringify({
        active: 'wsA',
        workspaces: [
            { name: 'wsA', path: path.join(home, 'wsA') },
            { name: 'wsB', path: path.join(home, 'wsB'), allowHardDelete: true },
        ],
    }),
    'utf8',
);

function makeLifecycleGraph(nodes: FNode[]) {
    const deleted: string[] = [];
    return {
        _deleted: deleted,
        async initialize() {},
        async listNodes(_t?: unknown, _tag?: unknown, _project?: string) { return nodes.map((n) => ({ ...n })); },
        async deleteNode(id: string) { deleted.push(id); },
        async upsertNode(_n: unknown) {},
        async getNode(id: string) { return nodes.find((n) => n.id === id) ?? null; },
    };
}

function makeAux() {
    const jobs = new Map<string, unknown>();
    return {
        createPruneJob(ws: string) { const id = 'job-1'; jobs.set(id, { id, workspace: ws }); return id; },
        updatePruneJob() {},
        getPruneJob(id: string) { return jobs.get(id) ?? null; },
        incrementCounter() {},
    };
}

console.log('P2 round-4 — verbatim WRITE/READ routes follow the requested workspace\n');

await test('POST /api/nodes/prune hard_delete (active=A, workspace=B): tombstone routes to B, NEVER the boot store', async () => {
    const bootGraph = makeLifecycleGraph([]);
    const wsBGraph = makeLifecycleGraph([mk('b1', 'wsB')]);

    // Boot (A) verbatim store — its verbatimDelete must NEVER be called for a
    // wsB prune. (This is the storageClient facade the pre-fix fallback hit.)
    let bootDelete = 0;
    const bootStorageClient = { async verbatimDelete() { bootDelete++; } };

    // B's own VerbatimStore. Give it delete() but NOT tombstone(), to force the
    // exact fallback branch the bug mis-routed. It MUST be the store deleted.
    let wsBDelete = 0; let wsBDeletedId = '';
    const wsBVerbatim = { async delete(id: string) { wsBDelete++; wsBDeletedId = id; } };

    const registry = { getOrOpen: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph), getGraphHandle: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph) };
    const aux = makeAux();
    const deps = {
        deploymentMode: 'local' as const, dataplane: null,
        store: { loreGraph: bootGraph, loreVerbatim: { async delete() {} }, storageClient: bootStorageClient } as never,
        auxStore: aux as never,
        graphRegistry: registry as never,
        workspaceVerbatimResolver: { getOrOpen: async (_ws: string) => wsBVerbatim as never },
    };

    const res = fakeRes();
    await tryLifecycleRoutes(
        fakeReq('POST', JSON.stringify({ workspace: 'wsB', dry_run: false, hard_delete: true })),
        res, '/api/nodes/prune', '/api/nodes/prune', deps as Parameters<typeof tryLifecycleRoutes>[4],
    );
    await new Promise<void>((r) => setTimeout(r, 30));

    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    assert.deepEqual(wsBGraph._deleted, ['b1'], 'the graph delete must hit B\'s graph');
    assert.equal(bootDelete, 0, 'the BOOT (A) verbatim store must NEVER be deleted for a wsB prune');
    assert.equal(wsBDelete, 1, 'the tombstone delete fallback must hit B\'s OWN verbatim store');
    assert.equal(wsBDeletedId, 'lore:b1', 'B\'s verbatim delete must target the deleted node id');
});

/* ═══ 2. supersession-candidates verbatim scan routing ═══════════════════ */

// A graph WITHOUT getGraphContext → the handler falls back to listNodes.
function makeCandGraph(nodes: FNode[]) {
    return {
        async listNodes(_t?: unknown, _tag?: unknown, _project?: string) { return nodes.map((n) => ({ ...n })); },
    };
}

await test('GET supersession-candidates (active=A, workspace=B): scan uses B\'s verbatim store, not boot', async () => {
    const bootGraph = makeCandGraph([]);
    const wsBGraph = makeCandGraph([mk('b1', 'wsB'), mk('b2', 'wsB')]);

    let bootSearch = 0;
    const bootStorageClient = { async verbatimSearch() { bootSearch++; return [{ id: 'lore:a-only', score: 0.99 }]; } };

    let wsBSearch = 0;
    const wsBVerbatim = { async search(_q: string, _n: number) { wsBSearch++; return [{ id: 'lore:b2', score: 0.95 }]; } };

    const registry = { getOrOpen: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph), getGraphHandle: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph) };
    const deps = {
        deploymentMode: 'local' as const, dataplane: null,
        store: { loreGraph: bootGraph, storageClient: bootStorageClient } as never,
        auditLog: { log: () => undefined } as never,
        graphRegistry: registry as never,
        workspaceVerbatimResolver: { getOrOpen: async (_ws: string) => wsBVerbatim as never },
    };

    const res = fakeRes();
    await handleSupersessionCandidates(res as never, '/api/node/supersession-candidates?workspace=wsB&fresh=true&minScore=0.5', deps as never);

    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as { candidatesScanned: number; pairs: Array<{ oldId: string; newId: string }> };
    assert.equal(bootSearch, 0, 'the BOOT (A) verbatim store must NEVER be searched for a wsB candidate scan');
    assert.ok(wsBSearch > 0, 'B\'s OWN verbatim store must be searched');
    assert.ok(body.candidatesScanned >= 2, `B's graph candidates must be scanned; got ${body.candidatesScanned}`);
    // b1's search hits b2 (score 0.95 ≥ 0.5) → a valid same-workspace pair.
    const ids = body.pairs.flatMap((p) => [p.oldId, p.newId]);
    assert.ok(!ids.includes('a-only'), 'an A-only vector hit must never surface in a wsB candidate pair');
});

await test('GET supersession-candidates for B WITHOUT a resolver SKIPS the vector scan (no A leak, no pairs)', async () => {
    const bootGraph = makeCandGraph([]);
    const wsBGraph = makeCandGraph([mk('b1', 'wsB'), mk('b2', 'wsB')]);
    let bootSearch = 0;
    const bootStorageClient = { async verbatimSearch() { bootSearch++; return [{ id: 'lore:a-only', score: 0.99 }]; } };
    const registry = { getOrOpen: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph), getGraphHandle: async (ws: string) => (ws === 'wsB' ? wsBGraph : bootGraph) };
    const deps = {
        deploymentMode: 'local' as const, dataplane: null,
        store: { loreGraph: bootGraph, storageClient: bootStorageClient } as never,
        auditLog: { log: () => undefined } as never,
        graphRegistry: registry as never,
        // No workspaceVerbatimResolver.
    };
    const res = fakeRes();
    await handleSupersessionCandidates(res as never, '/api/node/supersession-candidates?workspace=wsB&fresh=true&minScore=0.5', deps as never);
    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${res._body}`);
    const body = JSON.parse(res._body) as { candidatesScanned: number; pairs: unknown[] };
    assert.equal(bootSearch, 0, 'without a resolver the vector scan must be SKIPPED, not seeded from the boot store');
    assert.equal(body.pairs.length, 0, 'no candidate pairs when the vector scan is skipped');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

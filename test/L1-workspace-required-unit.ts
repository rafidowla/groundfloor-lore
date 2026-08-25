#!/usr/bin/env tsx
/**
 * test/L1-workspace-required-unit.ts — Sprint L1 unit tests
 *
 * Asserts the L1 workspace-required contract for the canonical bulk
 * endpoints and the diagnose/consistency endpoint. Each endpoint family
 * is tested for:
 *   - 400 `workspace_required` when called without a workspace
 *   - 200/normal response when called with an explicit workspace
 *
 * Companion to test/L-database-property-unit.ts. The gate test is
 * xfail-strict (regression catcher). This file is expect-pass
 * (functional spec of the new contract). They are intentionally
 * separate: gate-test flips happen in lockstep with code changes;
 * functional tests stay green forever.
 *
 * Out of scope for this file (deferred to L1a/L1b sub-chains, see
 * commit message + audit doc Section 1+2 row inventory):
 *   - The 89 other REST endpoints flagged L1 in the audit doc
 *   - The 53 MCP tools flagged L1 in the audit doc
 *   - CLI flag rename (--project → --workspace)
 *
 * Those are mechanical edits over a much larger surface than what
 * L1 (this chain) ships. They land in L1a (reads) and L1b (writes),
 * gated by additional D-cases.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryBulkListRoutes } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { tryDiagnosticRoutes } from '../packages/lore/src/mcp/http/routes/diagnostic.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        failed++;
    }
}

/* ---- Shared fakes ---- */

function makeFakeGraph(seedNodes: Array<Record<string, unknown>> = []): unknown {
    const queries: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    return {
        _queries: queries,
        getGraphContext() {
            return {
                queryRows: async (cypher: string, params: Record<string, unknown>) => {
                    queries.push({ cypher, params });
                    return seedNodes;
                },
                executeQuery: async () => undefined,
                bumpEpoch: () => undefined,
                storage: {},
                detectLanguage: () => ({ language: null, confidence: 0 }),
            };
        },
        getStats: async () => ({ totalNodes: 0, typeBreakdown: {} }),
        getLanguageBreakdown: async () => ({}),
        upsertNode: async (n: Record<string, unknown>) => ({ ...n, project: 'L1-fixture' }),
        addEdge: async () => undefined,
        addBidirectionalEdge: async () => undefined,
        search: async () => [],
        deleteNode: async () => true,
        listNodes: async () => [],
        // 2026-06-09 — GET /api/edges + POST /api/nodes/bulk-list now route
        // through graph.queryEdges()/bulkList() (cloud-parity refactor moved
        // the Cypher off getGraphContext). Provide both so this
        // workspace-required fixture exercises the refactored routes.
        queryEdges: async () => [],
        bulkList: async () => ({ nodes: seedNodes, hasMore: false, nextCursor: null }),
    };
}

function reqWithBody(body: string, method: string = 'POST'): IncomingMessage {
    let consumed = false;
    return {
        method,
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) {
                consumed = true;
                cb(Buffer.from(body, 'utf8'));
            }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function bulkListDeps(graph: unknown): Parameters<typeof tryBulkListRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph as never } as never,
    };
}

function bulkWriteDeps(graph: unknown): Parameters<typeof tryBulkWriteRoutes>[4] {
    const auditLog = { log: () => undefined } as never;
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: {
            loreGraph: graph as never,
            loreVerbatim: {
                store: async () => undefined,
                delete: async () => undefined,
                tombstone: async () => undefined,
                count: async () => 0,
            },
        } as never,
        auditLog,
    };
}

function diagDeps(graph: unknown): Parameters<typeof tryDiagnosticRoutes>[4] {
    return {
        store: {
            loreGraph: graph as never,
            loreVerbatim: { count: async () => 0 },
        } as never,
        pluginRegistry: {
            collectPluginStats: async () => ({}),
            getOrphanState: () => ({ blocking: false }),
        } as never,
        configManager: { read: () => ({ plugins: [], llmProvider: 'none' }) } as never,
        getDataplaneState: () => null,
    } as never;
}

console.log('Sprint L1 — workspace-required functional unit tests');

/* ============================================================
 * REST: bulk-list
 * ============================================================ */

await test('POST /api/nodes/bulk-list without workspace → 400 workspace_required', async () => {
    const res = fakeRes();
    await tryBulkListRoutes(reqWithBody('{}'), res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', bulkListDeps(makeFakeGraph()));
    assert.equal(res._status, 400, res._body);
    const parsed = JSON.parse(res._body);
    // Wave 5: canonical {code, message} envelope (was {error, hint}).
    assert.equal(parsed.code, 'workspace_required');
    assert.match(parsed.message, /workspace=<name>/);
});

await test('POST /api/nodes/bulk-list with empty-string workspace → 400 workspace_required', async () => {
    const res = fakeRes();
    await tryBulkListRoutes(reqWithBody(JSON.stringify({ workspace: '' })), res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', bulkListDeps(makeFakeGraph()));
    assert.equal(res._status, 400);
    assert.match(res._body, /workspace_required/);
});

await test('POST /api/nodes/bulk-list with workspace → 200', async () => {
    const res = fakeRes();
    await tryBulkListRoutes(
        reqWithBody(JSON.stringify({ workspace: 'L1-fixture', limit: 5 })),
        res, '/api/nodes/bulk-list', '/api/nodes/bulk-list', bulkListDeps(makeFakeGraph()),
    );
    assert.equal(res._status, 200, res._body);
    const parsed = JSON.parse(res._body);
    assert.equal(typeof parsed.count, 'number');
    assert.equal(parsed.workspace, 'L1-fixture');
});

/* ============================================================
 * REST: bulk-write family
 * ============================================================ */

await test('POST /api/nodes/bulk without workspace → 400 workspace_required', async () => {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        reqWithBody(JSON.stringify({ nodes: [{ id: 'x', type: 'decision', label: 'X' }] })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', bulkWriteDeps(makeFakeGraph()),
    );
    assert.equal(res._status, 400, res._body);
    assert.match(res._body, /workspace_required/);
});

await test('POST /api/edges/bulk without workspace → 400 workspace_required', async () => {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        reqWithBody(JSON.stringify({ edges: [{ sourceId: 'a', targetId: 'b', relation: 'r' }] })),
        res, '/api/edges/bulk', '/api/edges/bulk', bulkWriteDeps(makeFakeGraph()),
    );
    assert.equal(res._status, 400, res._body);
    assert.match(res._body, /workspace_required/);
});

await test('POST /api/nodes/bulk-delete without workspace → 400 workspace_required', async () => {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        reqWithBody(JSON.stringify({ ids: ['a', 'b'] })),
        res, '/api/nodes/bulk-delete', '/api/nodes/bulk-delete', bulkWriteDeps(makeFakeGraph()),
    );
    assert.equal(res._status, 400, res._body);
    assert.match(res._body, /workspace_required/);
});

await test('POST /api/recall/bulk without workspace → 400 workspace_required', async () => {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        reqWithBody(JSON.stringify({ topics: ['anything'] })),
        res, '/api/recall/bulk', '/api/recall/bulk', bulkWriteDeps(makeFakeGraph()),
    );
    assert.equal(res._status, 400, res._body);
    assert.match(res._body, /workspace_required/);
});

await test('POST /api/nodes/bulk with workspace → 200', async () => {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        reqWithBody(JSON.stringify({ workspace: 'L1-fixture', nodes: [{ id: 'x', type: 'decision', label: 'X' }] })),
        res, '/api/nodes/bulk', '/api/nodes/bulk', bulkWriteDeps(makeFakeGraph()),
    );
    assert.equal(res._status, 200, res._body);
});

await test('POST /api/edges/bulk with workspace → 200', async () => {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        reqWithBody(JSON.stringify({ workspace: 'L1-fixture', edges: [{ sourceId: 'a', targetId: 'b', relation: 'r' }] })),
        res, '/api/edges/bulk', '/api/edges/bulk', bulkWriteDeps(makeFakeGraph()),
    );
    assert.equal(res._status, 200, res._body);
});

await test('POST /api/nodes/bulk-delete with workspace → 200', async () => {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        reqWithBody(JSON.stringify({ workspace: 'L1-fixture', ids: ['a'] })),
        res, '/api/nodes/bulk-delete', '/api/nodes/bulk-delete', bulkWriteDeps(makeFakeGraph()),
    );
    assert.equal(res._status, 200, res._body);
});

/* ============================================================
 * REST: diagnose/consistency
 * ============================================================ */

await test('GET /api/diagnose/consistency without workspace → 400 workspace_required', async () => {
    const res = fakeRes();
    await tryDiagnosticRoutes(
        reqWithBody('', 'GET'), res, '/api/diagnose/consistency', '/api/diagnose/consistency', diagDeps(makeFakeGraph()),
    );
    assert.equal(res._status, 400, res._body);
    assert.match(res._body, /workspace_required/);
});


/* ============================================================
 * Source-level: search.ts scope envelope no longer carries project='*'
 * ============================================================ */

await test('search.ts response envelope no longer emits scope.project = \'*\'', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
        join(process.cwd(), 'packages/lore/src/mcp/tools/search.ts'),
        'utf8',
    );
    assert.ok(
        !src.includes(`scope: { project: '*'`),
        `search.ts response envelope still emits scope.project='*' — L1 must drop it from the public response shape`,
    );
});

/* ============================================================
 * Source-level: CLAUDE.md no longer documents plugin-developer
 * ============================================================ */

await test('CLAUDE.md no longer references packages/lore-plugin-developer/', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'CLAUDE.md'), 'utf8');
    assert.ok(
        !src.includes('packages/lore-plugin-developer/'),
        'CLAUDE.md still references packages/lore-plugin-developer/ — Sprint X removed that package; L3 sweeps the stale doc references',
    );
});

console.log('');
console.log(`passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);

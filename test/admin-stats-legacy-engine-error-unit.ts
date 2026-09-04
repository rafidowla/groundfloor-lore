#!/usr/bin/env tsx
/**
 * test/admin-stats-legacy-engine-error-unit.ts — Round-E fix regression test.
 *
 * handleAdminStats (GET-gated POST /api/admin/stats) iterates every known
 * workspace via graphRegistry.getGraphHandle(name) inside a try/catch that
 * used to turn ANY error into `byWorkspace[name] = { nodeCount: 0,
 * edgeCount: 0 }`. The comment said this was for WorkspaceNotFoundError
 * mid-iteration (a workspaces.json edit race), but the bare `catch` also
 * swallowed LegacyGraphEngineRemovedError (a workspace whose workspaces.json
 * still declares the removed 'kuzu' graph engine — see
 * engines/graphEngineSelector.ts) and reported it as an EMPTY workspace,
 * hiding real data behind a false zero reading.
 *
 * The fix: WorkspaceNotFoundError keeps the zeroed shape (registry race,
 * genuinely nothing to report); any other error gets a per-workspace
 * `{ nodeCount: null, edgeCount: null, error: { code, message } }` entry
 * instead, plus a top-level `errors` count. The response stays 200 so one
 * bad workspace doesn't hide the others.
 *
 * This test seeds a real workspaces.json (via the per-process test LORE_HOME
 * from config/loreHome.ts) with three workspaces and a stub graphRegistry
 * that mirrors what LocalGraphRegistry.getGraphHandle actually throws for
 * each: a healthy graph, a LegacyGraphEngineRemovedError, and a
 * WorkspaceNotFoundError (simulating removal mid-iteration).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { loreHome } from '../packages/lore/src/config/loreHome.js';
import { tryDiagnosticRoutes } from '../packages/lore/src/mcp/http/routes/diagnostic.js';
import { WorkspaceNotFoundError } from '../packages/lore/src/engines/localGraphRegistry.js';
import { LegacyGraphEngineRemovedError } from '../packages/lore/src/engines/graphEngineSelector.js';
import type { DiagnosticDeps } from '../packages/lore/src/mcp/http/routes/diagnostic/shared.js';

// Seed a real workspaces.json in this process's isolated test home so
// listWorkspaceNames() (stats.ts) has three names to iterate: a healthy
// workspace, one declaring the removed legacy 'kuzu' engine, and one that
// will look up-to-date here but "disappear" from the fake registry (the
// workspace_not_found race).
const home = loreHome();
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    active: 'default',
    workspaces: [
        { name: 'default', path: path.join(home, 'default'), createdAt: new Date().toISOString() },
        {
            name: 'legacy-engine',
            path: path.join(home, 'legacy-engine'),
            createdAt: new Date().toISOString(),
            graphEngine: 'kuzu',
        },
        { name: 'ghost', path: path.join(home, 'ghost'), createdAt: new Date().toISOString() },
    ],
}, null, 2));

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

function makeFakeGraph(nodeCount: number, edgeCount: number): unknown {
    return {
        getGraphContext: () => ({}),
        getStats: async () => ({ nodeCount, edgeCount, typeBreakdown: {} }),
        getLanguageBreakdown: async () => ({}),
    };
}

function makeFakeStore(graph: unknown, nodeCount: number, edgeCount: number, verbatimDocs: number): unknown {
    return {
        loreGraph: graph,
        loreVerbatim: { count: async () => verbatimDocs },
        storageClient: {
            getStats: async () => ({ nodeCount, edgeCount, typeBreakdown: {} }),
            verbatimCount: async () => verbatimDocs,
        },
    };
}

function reqPost(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
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

const healthyGraph = makeFakeGraph(146, 412);

// Mirrors LocalGraphRegistry.getGraphHandle's real throw behavior for each
// workspace kind, without touching the real engine machinery.
function makeMixedRegistry(): { getGraphHandle: (name: string) => Promise<unknown> } {
    return {
        async getGraphHandle(name: string) {
            if (name === 'default') return healthyGraph;
            if (name === 'legacy-engine') {
                throw new LegacyGraphEngineRemovedError(name, 'LocalGraphRegistry.getGraphHandle');
            }
            if (name === 'ghost') {
                throw new WorkspaceNotFoundError(name, ['default', 'legacy-engine']);
            }
            throw new Error(`test registry: unexpected workspace "${name}"`);
        },
    };
}

function baseDeps(overrides: Partial<DiagnosticDeps>): DiagnosticDeps {
    return {
        store: makeFakeStore(healthyGraph, 146, 412, 0) as never,
        pluginRegistry: {
            collectPluginStats: async () => ({}),
            getOrphanState: () => ({ blocking: false, orphans: [] }),
        } as never,
        configManager: { read: () => ({ plugins: [], llmProvider: 'none' }) } as never,
        activeSessions: new Map(),
        deploymentMode: 'local',
        getDataplaneState: () => 'offline',
        ...overrides,
    } as DiagnosticDeps;
}

console.log('admin-stats-legacy-engine-error — /api/admin/stats byWorkspace error surfacing');

await test(
    'healthy + legacy-engine + removed-mid-iteration workspaces each get the right byWorkspace shape',
    async () => {
        const res = fakeRes();
        await tryDiagnosticRoutes(reqPost('{}'), res, '/api/admin/stats', '/api/admin/stats', baseDeps({
            graphRegistry: makeMixedRegistry() as never,
        }));
        assert.equal(res._status, 200, `got ${res._status}: ${res._body}`);
        const body = JSON.parse(res._body) as Record<string, unknown>;
        const byWs = body.byWorkspace as Record<string, { nodeCount: number | null; edgeCount: number | null; error?: { code: string; message: string } }>;

        // Healthy workspace: counts intact, no error field.
        assert.equal(byWs.default?.nodeCount, 146);
        assert.equal(byWs.default?.edgeCount, 412);
        assert.equal(byWs.default?.error, undefined);

        // Legacy-engine workspace: null counts + typed error — NOT zeroed,
        // NOT indistinguishable from an empty workspace.
        assert.equal(byWs['legacy-engine']?.nodeCount, null, 'legacy-engine workspace must not report nodeCount:0');
        assert.equal(byWs['legacy-engine']?.edgeCount, null, 'legacy-engine workspace must not report edgeCount:0');
        assert.ok(byWs['legacy-engine']?.error, 'expected an error object for the legacy-engine workspace');
        assert.equal(byWs['legacy-engine']?.error?.code, 'legacy_graph_engine_removed');
        assert.equal(typeof byWs['legacy-engine']?.error?.message, 'string');
        assert.ok((byWs['legacy-engine']?.error?.message.length ?? 0) > 0);

        // workspace_not_found mid-iteration race: keeps the original zeroed
        // shape (genuinely nothing to report — the registry race is benign).
        assert.equal(byWs.ghost?.nodeCount, 0);
        assert.equal(byWs.ghost?.edgeCount, 0);
        assert.equal(byWs.ghost?.error, undefined);

        // Exactly one workspace produced a real (non-race) error.
        assert.equal(body.errors, 1, `expected errors:1; got ${JSON.stringify(body.errors)}`);

        // globalTotals reflects only the successfully-read workspace — the
        // null-count entries must not corrupt the sum (e.g. via NaN).
        const totals = body.globalTotals as { nodeCount: number; edgeCount: number };
        assert.equal(totals.nodeCount, 146);
        assert.equal(totals.edgeCount, 412);
    },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

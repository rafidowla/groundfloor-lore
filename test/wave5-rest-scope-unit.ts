#!/usr/bin/env tsx
/**
 * wave5-rest-scope-unit.ts — Wave-5 cross-workspace / authorization fixes
 * for the bulk REST writers + the HTML export read surface.
 *
 * Mirrors the sp04-http-read-scope-unit.ts harness (runWithPrincipal +
 * appPrincipal + fakeReq/fakeRes + makeFakeGraph/makeFakeRegistry). Every
 * gate fires before substrate access, so refused calls never touch disk
 * and allowed calls hit in-memory stubs only — no LORE_HOME needed.
 *
 * Covered findings (one focused regression each):
 *   - L-016  POST /api/import           — token write-scope + cross-ws authz
 *                                          + write routed to the requested ws.
 *   - L-017  POST /api/ingest/file       — per-token read-scope gate.
 *            POST /api/ingest/reprocess  — per-token read-scope gate.
 *   - L-018  POST /api/graph/reconnect   — write-scope gate + per-ws substrate.
 *            POST /api/graph/reconsume   — write-scope gate.
 *   - L-019  POST /api/load              — ReBAC + token write-scope gate.
 *   - L-007  GET  /api/export/html       — read-scope gate + per-ws graph.
 *
 * Run:
 *   npx tsx test/wave5-rest-scope-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryImportRoutes } from '../packages/lore/src/mcp/http/routes/import.js';
import { tryIngestionRoutes } from '../packages/lore/src/mcp/http/routes/ingestion.js';
import { PendingAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';
import { tryLoadRoutes } from '../packages/lore/src/mcp/http/routes/load.js';
import { tryStaticRoutes } from '../packages/lore/src/mcp/http/routes/static.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';

function appPrincipal(workspace: string, scopes: TokenScope[]): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${workspace}` };
}

function fakeReq(method: string, url?: string, body?: string): IncomingMessage {
    if (body !== undefined) {
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
    return { method, url, on: () => undefined } as unknown as IncomingMessage;
}

/** Streaming POST request that emits one chunk + end — used for the
 *  /api/load ALLOWED cases that proceed past the gates into the body
 *  reader (a no-op `on` would hang the stream-to-disk promise forever). */
function streamReq(chunk: string): IncomingMessage {
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const req = {
        method: 'POST',
        on(event: string, cb: (arg?: unknown) => void) { (handlers[event] ??= []).push(cb); return this; },
    } as unknown as IncomingMessage;
    setImmediate(() => {
        for (const cb of handlers['data'] ?? []) cb(Buffer.from(chunk, 'utf8'));
        for (const cb of handlers['end'] ?? []) cb();
    });
    return req;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

/** Recording graph — upsertNode/getNode track which graph received writes. */
function makeFakeGraph(tag: string) {
    return {
        tag,
        upserts: [] as Array<Record<string, unknown>>,
        initialize: async () => undefined,
        getNode: async () => null,
        async upsertNode(n: Record<string, unknown>) { this.upserts.push(n); return { ...n, id: n.id }; },
        // reconnect/topology surface the export + reconnect handlers reach.
        getTopology: async () => ({ nodes: [], edges: [] }),
        search: async () => [],
        listNodes: async () => [],
    };
}

/** Verbatim stub the reconnect path consumes (initialize + search). */
function makeFakeVerbatim() {
    return { initialize: async () => undefined, search: async () => [], count: async () => 0, store: async () => undefined };
}

/** R-004 — a recording graph that captures whether the DESTRUCTIVE
 *  reconnect prune (`pruneInferredLoreEdges`) hit THIS graph. `bulkList`
 *  returns an empty page so reconnectGraph's paging loop terminates with
 *  zero embeds/searches and proceeds straight to the prune-on-apply step.
 *  Tagged per workspace so we can prove the rebuild targeted the REQUESTED
 *  workspace and NOT the boot graph. */
function makeReconnectRecordingGraph(tag: string) {
    return {
        tag,
        pruneCalls: 0,
        upserts: [] as Array<Record<string, unknown>>,
        initialize: async () => undefined,
        getNode: async () => null,
        async upsertNode(n: Record<string, unknown>) { this.upserts.push(n); return { ...n, id: n.id }; },
        // reconnect paging surface — one empty page ends the do/while.
        bulkList: async () => ({ nodes: [], nextCursor: null }),
        // THE destructive op reconnect runs on apply (pruneInferred).
        async pruneInferredLoreEdges(_prefix: string) { this.pruneCalls++; return 0; },
        addEdge: async () => undefined,
        getTopology: async () => ({ nodes: [], edges: [] }),
        search: async () => [],
        listNodes: async () => [],
    };
}

/** R-004 — recording verbatim the reconnect apply path consumes. */
function makeReconnectRecordingVerbatim() {
    return {
        initialize: async () => undefined,
        getContentHashesByIds: async () => new Map<string, string>(),
        storeBatch: async () => undefined,
        search: async () => [],
        count: async () => 0,
        store: async () => undefined,
    };
}

/** Auto-approving consent manager so allowed reconnect/reconsume cases that
 *  pass the gate don't hang on a real approval prompt. */
function makeConsentManager() {
    return {
        request: () => ({ id: 'c1', wait: Promise.resolve({ approved: true }), snapshot: {} }),
    } as unknown as Parameters<typeof tryIngestionRoutes>[4]['consentManager'];
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('wave5-rest-scope-unit.ts');

    const A = appPrincipal('alpha', ['read', 'write']);
    const AcrossRead = appPrincipal('alpha', ['read', 'write', 'cross-workspace-read']);
    const AcrossWrite = appPrincipal('alpha', ['read', 'write', 'cross-workspace-write']);
    // R-004 — a principal whose OWN bound workspace is B, used to drive a
    // legitimate (non-cross-ws) reconnect against B from a boot-A harness.
    const B = appPrincipal('B', ['read', 'write']);

    /* ── L-016 — POST /api/import write-scope + cross-ws routing ─────── */

    // base64 CSV with one row mapping name → label.
    const csvB64 = Buffer.from('id,name\n1,Alpha').toString('base64');
    const importBody = (workspace: string) => JSON.stringify({
        format: 'csv', filename: 'x.csv', data: csvB64,
        mapping: { entityType: 'note', idColumn: 'id', fields: { name: 'label' } },
        workspace,
    });

    function importDeps(boot: ReturnType<typeof makeFakeGraph>, byWs: Map<string, ReturnType<typeof makeFakeGraph>>) {
        return {
            store: { loreGraph: boot, storageClient: boot, loreVerbatim: {} } as never,
            detectedScope: { workspace: 'boot', ecosystem: '*' },
            deploymentMode: 'local' as const,
            dataplane: null,
            graphRegistry: { getOrOpen: async (ws: string) => byWs.get(ws) ?? boot, getGraphHandle: async (ws: string) => byWs.get(ws) ?? boot, activeName: () => 'boot' } as never,
        } as Parameters<typeof tryImportRoutes>[4];
    }

    await test('L-016 POST /api/import: principal alpha → workspace=beta → 403 workspace_forbidden', async () => {
        const res = fakeRes();
        const boot = makeFakeGraph('boot');
        const d = importDeps(boot, new Map([['beta', makeFakeGraph('beta')]]));
        await runWithPrincipal(A, () =>
            tryImportRoutes(fakeReq('POST', '/api/import', importBody('beta')), res, '/api/import', '/api/import', d));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('L-016 POST /api/import: principal alpha → workspace=alpha → 200', async () => {
        const res = fakeRes();
        const boot = makeFakeGraph('boot');
        const d = importDeps(boot, new Map([['alpha', makeFakeGraph('alpha')]]));
        await runWithPrincipal(A, () =>
            tryImportRoutes(fakeReq('POST', '/api/import', importBody('alpha')), res, '/api/import', '/api/import', d));
        assert.equal(res._status, 200, res._body);
    });

    await test('L-016 POST /api/import: cross-workspace-write → workspace=beta → 200 AND write lands in beta graph (not boot)', async () => {
        const res = fakeRes();
        const boot = makeFakeGraph('boot');
        const beta = makeFakeGraph('beta');
        const d = importDeps(boot, new Map([['beta', beta]]));
        await runWithPrincipal(AcrossWrite, () =>
            tryImportRoutes(fakeReq('POST', '/api/import', importBody('beta')), res, '/api/import', '/api/import', d));
        assert.equal(res._status, 200, res._body);
        assert.equal(beta.upserts.length, 1, 'row must land in the beta graph');
        assert.equal(boot.upserts.length, 0, 'boot graph must NOT receive the write');
    });

    await test('L-016 POST /api/import: NO principal → workspace=anything → 200 (legacy bypass)', async () => {
        const res = fakeRes();
        const boot = makeFakeGraph('boot');
        const d = importDeps(boot, new Map([['whatever', makeFakeGraph('whatever')]]));
        await tryImportRoutes(fakeReq('POST', '/api/import', importBody('whatever')), res, '/api/import', '/api/import', d);
        assert.equal(res._status, 200, res._body);
    });

    await test('L-016 POST /api/import: missing workspace → 400 workspace_required', async () => {
        const res = fakeRes();
        const boot = makeFakeGraph('boot');
        const d = importDeps(boot, new Map());
        const body = JSON.stringify({ format: 'csv', filename: 'x.csv', data: csvB64, mapping: { entityType: 'note', idColumn: 'id', fields: { name: 'label' } } });
        await runWithPrincipal(A, () =>
            tryImportRoutes(fakeReq('POST', '/api/import', body), res, '/api/import', '/api/import', d));
        assert.equal(res._status, 400, res._body);
        assert.match(res._body, /workspace_required/);
    });

    /* ── L-017 — ingest read-scope gate ─────────────────────────────── */

    function ingestionDeps() {
        const graph = makeFakeGraph('boot');
        return {
            // autolinkTracker is REQUIRED on StorageBundle: the reconnect
            // routes register their sweep with it so the shutdown drain waits
            // for them (see engines/pendingAutolink.ts). The `as never` on this
            // stub hides missing fields, so it has to be named by hand.
            // sweepTracker is what the reconnect/reconsume routes register on now
            // (a multi-minute sweep must not share the 5s ingest-autolink budget —
            // see StorageBundle.sweepTracker); autolinkTracker stays for ingest hooks.
            store: { loreGraph: graph, loreVerbatim: makeFakeVerbatim(), autolinkTracker: new PendingAutolinkTracker(), sweepTracker: new PendingAutolinkTracker() } as never,
            consentManager: makeConsentManager(),
            auditLog: { log: () => undefined } as never,
            configManager: { read: () => ({ llmProvider: 'none' }) } as never,
            graphBasePath: '/tmp/g',
            deploymentMode: 'local' as const,
            dataplane: null,
            extractorRegistry: {
                mimeFromPath: () => 'text/plain',
                extract: async () => ({ mimeType: 'text/plain', sourceBytes: 0, confidence: 1, metadata: null, text: 'x' }),
            } as never,
            graphRegistry: { getOrOpen: async () => graph, getGraphHandle: async () => graph, activeName: () => 'boot' } as never,
            workspaceVerbatimResolver: { getOrOpen: async () => makeFakeVerbatim() } as never,
        } as Parameters<typeof tryIngestionRoutes>[4];
    }

    await test('L-017 POST /api/ingest/file: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        await runWithPrincipal(A, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ filePath: '/tmp/x', workspace: 'beta' })),
                res, '/api/ingest/file', '/api/ingest/file', ingestionDeps()));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('L-017 POST /api/ingest/reprocess: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        await runWithPrincipal(A, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ filePath: '/tmp/x', workspace: 'beta', upgradeAction: 'use_local_text' })),
                res, '/api/ingest/reprocess', '/api/ingest/reprocess', ingestionDeps()));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('L-017 POST /api/ingest/file: principal alpha → workspace=alpha → reaches path stage (not 403)', async () => {
        // path /tmp/x is not under the allowlist → 403 ingestion_denied OR
        // some non-scope status; the key assertion is the SCOPE gate did not
        // fire (body would say workspace_forbidden if it had).
        const res = fakeRes();
        await runWithPrincipal(A, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ filePath: '/tmp/x', workspace: 'alpha' })),
                res, '/api/ingest/file', '/api/ingest/file', ingestionDeps()));
        assert.doesNotMatch(res._body, /workspace_forbidden/, res._body);
    });

    await test('L-017 POST /api/ingest/file: cross-workspace-read → workspace=beta → not workspace_forbidden', async () => {
        const res = fakeRes();
        await runWithPrincipal(AcrossRead, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ filePath: '/tmp/x', workspace: 'beta' })),
                res, '/api/ingest/file', '/api/ingest/file', ingestionDeps()));
        assert.doesNotMatch(res._body, /workspace_forbidden/, res._body);
    });

    await test('L-017 POST /api/ingest/file: NO principal → workspace=anything → not 403 scope (legacy bypass)', async () => {
        const res = fakeRes();
        await tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ filePath: '/tmp/x', workspace: 'whatever' })),
            res, '/api/ingest/file', '/api/ingest/file', ingestionDeps());
        assert.doesNotMatch(res._body, /workspace_forbidden/, res._body);
    });

    /* ── L-018 — reconnect/reconsume write-scope gate + per-ws routing ─ */

    await test('L-018 POST /api/graph/reconnect: principal alpha → workspace=beta → 403 (lacks cross-workspace-write)', async () => {
        const res = fakeRes();
        await runWithPrincipal(A, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ workspace: 'beta', apply: true })),
                res, '/api/graph/reconnect', '/api/graph/reconnect', ingestionDeps()));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('L-018 POST /api/graph/reconsume: principal alpha → workspace=beta → 403', async () => {
        const res = fakeRes();
        await runWithPrincipal(A, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ workspace: 'beta' })),
                res, '/api/graph/reconsume', '/api/graph/reconsume', ingestionDeps()));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    });

    await test('L-018 POST /api/graph/reconnect: principal alpha → workspace=alpha (dry-run) → not 403 (reaches reconnect)', async () => {
        const res = fakeRes();
        await runWithPrincipal(A, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ workspace: 'alpha' })),
                res, '/api/graph/reconnect', '/api/graph/reconnect', ingestionDeps()));
        assert.notEqual(res._status, 403, res._body);
    });

    await test('L-018 POST /api/graph/reconnect: cross-workspace-write → workspace=beta → not 403', async () => {
        const res = fakeRes();
        await runWithPrincipal(AcrossWrite, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ workspace: 'beta' })),
                res, '/api/graph/reconnect', '/api/graph/reconnect', ingestionDeps()));
        assert.notEqual(res._status, 403, res._body);
    });

    await test('L-018 POST /api/graph/reconnect: missing workspace → 400 workspace_required', async () => {
        const res = fakeRes();
        await runWithPrincipal(A, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({})),
                res, '/api/graph/reconnect', '/api/graph/reconnect', ingestionDeps()));
        assert.equal(res._status, 400, res._body);
        assert.match(res._body, /workspace_required/);
    });

    await test('L-018 POST /api/graph/reconnect: NO principal → workspace=anything (dry-run) → not 403 (legacy bypass)', async () => {
        const res = fakeRes();
        await tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ workspace: 'whatever' })),
            res, '/api/graph/reconnect', '/api/graph/reconnect', ingestionDeps());
        assert.notEqual(res._status, 403, res._body);
    });

    /* ── R-004 — destructive prune+rebuild must hit the REQUESTED ws ──── */
    // The earlier L-018 ALLOWED cases only proved the SCOPE gate didn't fire.
    // They used one graph for every workspace, so they could NOT prove the
    // destructive rebuild targets the requested workspace (B) rather than
    // boot (A). These cases wire DISTINCT per-workspace recording graphs +
    // verbatims into graphRegistry / workspaceVerbatimResolver — exactly the
    // L-018 routing branch (ingestion.ts:152) — and assert the prune
    // (pruneInferredLoreEdges) landed on B's substrate, not boot-A's.

    function reconnectRoutingDeps(
        boot: ReturnType<typeof makeReconnectRecordingGraph>,
        graphsByWs: Map<string, ReturnType<typeof makeReconnectRecordingGraph>>,
        verbatimsByWs: Map<string, ReturnType<typeof makeReconnectRecordingVerbatim>>,
    ) {
        return {
            store: { loreGraph: boot, loreVerbatim: makeReconnectRecordingVerbatim(), autolinkTracker: new PendingAutolinkTracker(), sweepTracker: new PendingAutolinkTracker() } as never,
            consentManager: makeConsentManager(),
            auditLog: { log: () => undefined } as never,
            configManager: { read: () => ({ llmProvider: 'none' }) } as never,
            graphBasePath: '/tmp/g',
            deploymentMode: 'local' as const,
            dataplane: null,
            graphRegistry: { getOrOpen: async (ws: string) => graphsByWs.get(ws) ?? boot, getGraphHandle: async (ws: string) => graphsByWs.get(ws) ?? boot, activeName: () => 'boot' } as never,
            workspaceVerbatimResolver: { getOrOpen: async (ws: string) => verbatimsByWs.get(ws) ?? makeReconnectRecordingVerbatim() } as never,
        } as Parameters<typeof tryIngestionRoutes>[4];
    }

    await test('R-004 POST /api/graph/reconnect apply: principal B → workspace=B → prune hits B graph, NOT boot-A', async () => {
        const res = fakeRes();
        const bootA = makeReconnectRecordingGraph('boot-A');   // boot/active graph (workspace A)
        const graphB = makeReconnectRecordingGraph('B');        // the requested workspace's graph
        const d = reconnectRoutingDeps(
            bootA,
            new Map([['B', graphB]]),
            new Map([['B', makeReconnectRecordingVerbatim()]]),
        );
        // The reconnect route resolves the per-workspace cursor root via
        // getWorkspacePath(reconnectWs) (RA2 per-workspace-cursor fix), which
        // reads workspaces.json from LORE_HOME. Seed a temp home registering
        // 'B' so that lookup resolves — the graph routing under test still
        // goes through the stubbed registry in `d`. (Without this the route
        // 500s on workspace_not_found before the prune ever runs.)
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wave5-reconnect-'));
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
            active: 'B',
            workspaces: [{ name: 'B', path: path.join(home, 'B'), createdAt: 't' }],
        }));
        const prevHome = process.env.LORE_HOME;
        process.env.LORE_HOME = home;
        try {
            // Boot-A harness (detectedScope is boot), write principal whose OWN
            // workspace is B → scope gate passes; apply=true → destructive prune.
            await runWithPrincipal(B, () =>
                tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ workspace: 'B', apply: true, force: true })),
                    res, '/api/graph/reconnect', '/api/graph/reconnect', d));
        } finally {
            if (prevHome === undefined) delete process.env.LORE_HOME; else process.env.LORE_HOME = prevHome;
        }
        assert.equal(res._status, 200, res._body);
        assert.equal(graphB.pruneCalls, 1, 'destructive prune MUST hit the requested workspace (B) graph');
        assert.equal(bootA.pruneCalls, 0, 'boot-A graph MUST NOT be pruned when B was requested');
    });

    await test('R-004 POST /api/graph/reconsume: principal B → workspace=B → prune hits B graph, NOT boot-A', async () => {
        const res = fakeRes();
        const bootA = makeReconnectRecordingGraph('boot-A');
        const graphB = makeReconnectRecordingGraph('B');
        const d = reconnectRoutingDeps(
            bootA,
            new Map([['B', graphB]]),
            new Map([['B', makeReconnectRecordingVerbatim()]]),
        );
        // reconsume always prunes (pruneInferred: true) — no apply flag needed.
        await runWithPrincipal(B, () =>
            tryIngestionRoutes(fakeReq('POST', undefined, JSON.stringify({ workspace: 'B', force: true })),
                res, '/api/graph/reconsume', '/api/graph/reconsume', d));
        assert.equal(res._status, 200, res._body);
        assert.equal(graphB.pruneCalls, 1, 'reconsume prune MUST hit the requested workspace (B) graph');
        assert.equal(bootA.pruneCalls, 0, 'boot-A graph MUST NOT be pruned when B was requested');
    });

    /* ── L-019 — POST /api/load write gates ─────────────────────────── */

    function loadDeps(records: unknown[], deployment: 'local' | 'cloud' = 'local') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave5-load-'));
        return {
            loreDir: dir,
            loadJobsStore: {
                create: async () => { records.push('create'); },
                get: async () => ({ bytesReceived: 0 }),
                incrementBytesReceived: async () => undefined,
                updateStatus: async () => undefined,
                list: async () => [],
            } as never,
            outboxStore: { record: async () => { records.push('outbox'); } } as never,
            deploymentMode: deployment,
            dataplane: null,
        } as Parameters<typeof tryLoadRoutes>[4];
    }

    await test('L-019 POST /api/load: principal alpha → workspace=beta → 403 AND no job/outbox staged', async () => {
        const res = fakeRes();
        const records: unknown[] = [];
        await runWithPrincipal(A, () =>
            tryLoadRoutes(fakeReq('POST', '/api/load?workspace=beta'), res, '/api/load?workspace=beta', '/api/load', loadDeps(records)));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
        assert.equal(records.length, 0, 'no job row / outbox emitted on refused write');
    });

    await test('L-019 POST /api/load: cross-workspace-write → workspace=beta → not 403', async () => {
        const res = fakeRes();
        const records: unknown[] = [];
        await runWithPrincipal(AcrossWrite, () =>
            tryLoadRoutes(streamReq('{"a":1}\n'), res, '/api/load?workspace=beta', '/api/load', loadDeps(records)));
        assert.notEqual(res._status, 403, res._body);
    });

    await test('L-019 POST /api/load: NO principal → workspace=anything → not 403 (legacy bypass)', async () => {
        const res = fakeRes();
        const records: unknown[] = [];
        await tryLoadRoutes(streamReq('{"a":1}\n'), res, '/api/load?workspace=whatever', '/api/load', loadDeps(records));
        assert.notEqual(res._status, 403, res._body);
    });

    await test('L-019 POST /api/load: cloud mode → ReBAC gate fires (denied, nothing staged)', async () => {
        // Proves the gateRoute wire is live on POST /api/load. In cloud mode
        // with no bound workspace/dataplane context the ReBAC gate fails
        // closed (writePermissionDenied), so the request is refused before
        // any byte / job row / outbox is staged.
        const res = fakeRes();
        const records: unknown[] = [];
        await tryLoadRoutes(fakeReq('POST', '/api/load?workspace=beta'), res, '/api/load?workspace=beta', '/api/load', loadDeps(records, 'cloud'));
        assert.notEqual(res._status, 200, res._body);
        assert.match(res._body, /denied|no_dataplane/, res._body);
        assert.equal(records.length, 0, 'cloud ReBAC denial stages nothing');
    });

    /* ── L-007 — GET /api/export/html read-scope + per-ws graph ──────── */

    function staticDeps() {
        const boot = makeFakeGraph('boot');
        return {
            deps: {
                store: { loreGraph: boot } as never,
                graphRegistry: { getOrOpen: async () => makeFakeGraph('resolved'), getGraphHandle: async () => makeFakeGraph('resolved'), activeName: () => 'boot' } as never,
                deploymentMode: 'local' as const,
            } as Parameters<typeof tryStaticRoutes>[4],
            boot,
        };
    }

    await test('L-007 GET /api/export/html: principal alpha → workspace=beta → 403 (export never runs)', async () => {
        const res = fakeRes();
        const { deps, boot } = staticDeps();
        // Spy: if the boot graph's getTopology is called, the gate leaked.
        let topologyCalled = false;
        boot.getTopology = async () => { topologyCalled = true; return { nodes: [], edges: [] }; };
        await runWithPrincipal(A, () =>
            tryStaticRoutes(fakeReq('GET'), res, '/api/export/html?workspace=beta', '/api/export/html', deps));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
        assert.equal(topologyCalled, false, 'export must not run on a refused request');
    });

    await test('L-007 GET /api/export/html: missing workspace → 400 workspace_required', async () => {
        const res = fakeRes();
        const { deps } = staticDeps();
        await runWithPrincipal(A, () =>
            tryStaticRoutes(fakeReq('GET'), res, '/api/export/html', '/api/export/html', deps));
        assert.equal(res._status, 400, res._body);
        assert.match(res._body, /workspace_required/);
    });

    await test('L-007 GET /api/export/html: principal alpha → workspace=alpha → 200 text/html', async () => {
        const res = fakeRes();
        const { deps } = staticDeps();
        await runWithPrincipal(A, () =>
            tryStaticRoutes(fakeReq('GET'), res, '/api/export/html?workspace=alpha', '/api/export/html', deps));
        assert.equal(res._status, 200, res._body);
        assert.match(res._body, /<html|<!DOCTYPE|vis-network/i);
    });

    await test('L-007 GET /api/export/html: cross-workspace-read → workspace=beta → 200', async () => {
        const res = fakeRes();
        const { deps } = staticDeps();
        await runWithPrincipal(AcrossRead, () =>
            tryStaticRoutes(fakeReq('GET'), res, '/api/export/html?workspace=beta', '/api/export/html', deps));
        assert.equal(res._status, 200, res._body);
    });

    await test('L-007 GET /api/export/html: NO principal → workspace=anything → 200 (legacy bypass)', async () => {
        const res = fakeRes();
        const { deps } = staticDeps();
        await tryStaticRoutes(fakeReq('GET'), res, '/api/export/html?workspace=whatever', '/api/export/html', deps);
        assert.equal(res._status, 200, res._body);
    });

    console.log(`\nwave5: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

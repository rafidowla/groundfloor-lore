#!/usr/bin/env tsx
/**
 * test/write-scopes-maintenance-unit.ts — whole-workspace MAINTENANCE writes are
 * operator-only for bound actors (security_scopes slice F).
 *
 * Maintenance jobs delete, rebuild or count across every row of a workspace,
 * hidden rows included (dry-run counts too), so row-level security_scopes cannot
 * be applied per item. Same rule POST /api/load already uses: a BOUND actor
 * (getCurrentActorScopes() !== undefined) must carry a bootstrap or shared-secret
 * principal; everything else gets 403 maintenance_forbidden (REST) / an isError
 * `{ error: 'maintenance_forbidden' }` (MCP) BEFORE any scan, dry-run count,
 * lock, outbox row or write. Unbound callers are unchanged.
 *
 * Every gated route/tool is driven through its real handler / real tool
 * registration with the same matrix:
 *   - bound non-operator (app token, and Clerk-style no principal) → refused,
 *     nothing touched, nothing changed;
 *   - bound operator (bootstrap / shared-secret principal)           → works;
 *   - unbound (with and without an app principal)                    → works.
 *
 * The same rule covers the daemon-wide control plane that bindDaemonOperatorLane alone
 * leaves open to a cross-workspace-write app token: workspace switch/rename/delete,
 * daemon restart/logs, connector sync, ingestion roots, daemon config, audit read,
 * admin stats, the arcade tenant verbs, and the MCP register_workspace (re-register)
 * and admin_stats tools. Workspace create/list and GET retention stay open.
 *
 * Run: npx tsx test/write-scopes-maintenance-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

// Isolated home: the allowed paths read the workspace registry / retention policy.
process.env['LORE_HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'wsm-home-'));
// daemon/logs reads ~/Library/Logs/Lore and the ingestion-root check needs a home: never the real one.
process.env['HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'wsm-userhome-'));

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import {
    createWorkspace, listWorkspaceNames, setWorkspaceRetention, getWorkspaceRetention, getActiveWorkspaceName, getWorkspacePath, loadWorkspaces, switchWorkspace,
} from '../packages/lore/src/config/workspaces.js';
import { tryWorkspaceMgmtRoutes } from '../packages/lore/src/mcp/http/routes/workspaces/workspaceMgmt.js';
import { tryPolicyRoutes } from '../packages/lore/src/mcp/http/routes/retention/policy.js';
import { tryAdminRoutes } from '../packages/lore/src/mcp/http/routes/admin.js';
import { tryIngestionRoutes } from '../packages/lore/src/mcp/http/routes/ingestion.js';
import { tryConfigRoutes } from '../packages/lore/src/mcp/http/routes/config.js';
import { trySyncRoutes } from '../packages/lore/src/mcp/http/routes/sync.js';
import { handleConsistencyCleanup } from '../packages/lore/src/mcp/http/routes/diagnostic/health.js';
import { registerGovernanceTools } from '../packages/lore/src/mcp/tools/governance.js';
import { registerMaintainTools } from '../packages/lore/src/mcp/tools/maintain.js';
import { registerDiagnosticTools } from '../packages/lore/src/mcp/tools/diagnostic.js';
import { handleDaemonRestart, handleDaemonLogs } from '../packages/lore/src/mcp/http/routes/diagnostic/daemonControl.js';
import { handleAdminStats } from '../packages/lore/src/mcp/http/routes/diagnostic/stats.js';
import { tryAuditRoutes } from '../packages/lore/src/mcp/http/routes/audit.js';
import { tryArcadeAdminRoutes } from '../packages/lore/src/mcp/http/routes/arcadeAdmin.js';
import { readWorkspaceRegistry, writeWorkspaceRegistry, upsertWorkspaceMapping } from '../packages/lore/src/config/workspaceRegistry.js';
import { registerDrain, __setExitFnForTests, __resetForTests } from '../packages/lore/src/mcp/shutdownCoordinator.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { MAINTENANCE_FORBIDDEN } from '../packages/lore/src/mcp/http/errorCodes.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
const mkTmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const WS = 'ws1';

/* ---------- caller modes ---------- */

const principal = (kind: Principal['kind'], extra: Principal['scopes'] = []): Principal =>
    ({ kind, workspace: WS, scopes: ['read', 'write', ...(kind === 'app' ? [] : ['cross-workspace-read', 'cross-workspace-write']), ...extra], label: 't', allowedWorkspaces: [WS] }) as Principal;
// 'cross-workspace-write' lets the app token through bindDaemonOperatorLane, so the
// only thing between it and the sweeper is the new operator gate.
const appP = (): Principal => principal('app', ['cross-workspace-write', 'cross-workspace-read']);

interface Mode { name: string; allowed: boolean; run: <T>(fn: () => Promise<T>) => Promise<T> }
const bound = <T>(fn: () => Promise<T>): Promise<T> => runWithActor({ portalUserId: 'u', scopes: ['x'] }, fn);
const MODES: Mode[] = [
    { name: 'bound app-token actor', allowed: false, run: (fn) => bound(() => runWithPrincipal(appP(), fn)) },
    { name: 'bound actor, no principal', allowed: false, run: (fn) => bound(fn) },
    { name: 'bound bootstrap operator', allowed: true, run: (fn) => bound(() => runWithPrincipal(principal('bootstrap'), fn)) },
    { name: 'bound shared-secret operator', allowed: true, run: (fn) => bound(() => runWithPrincipal(principal('shared-secret'), fn)) },
    { name: 'unbound caller', allowed: true, run: (fn) => fn() },
    { name: 'unbound caller with an app principal', allowed: true, run: (fn) => runWithPrincipal(appP(), fn) },
];

/* ---------- fakes ---------- */

function fakeReq(method: string, body = ''): IncomingMessage {
    let consumed = false;
    return {
        method,
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed) { consumed = true; if (body) cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
type Res = ServerResponse & { _status: number; _body: string };
function fakeRes(): Res {
    const r = {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as Res;
}

/** Any property read (other than promise/inspection probes) is recorded as a touch. */
function tripwire(log: string[], label: string): never {
    const handler: ProxyHandler<object> = {
        get(_t, prop) {
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
            log.push(`${label}.${prop}`);
            return () => { throw new Error(`tripwire ${label}.${prop}`); };
        },
    };
    return new Proxy({}, handler) as never;
}

/** One concrete invocation of a gated route/tool, ready to run under any caller mode. */
interface Case {
    /** Runs the route/tool; REST returns status+body, MCP returns isError+body. */
    invoke(): Promise<{ status: number; body: Record<string, unknown> }>;
    /** True once the work behind the gate has started (or finished). */
    reached(): Promise<boolean>;
    /** Extra proof that a refused call changed nothing. */
    untouched?(): Promise<void>;
}
interface Spec { name: string; make(): Promise<Case> }

const restResult = (res: Res): { status: number; body: Record<string, unknown> } => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res._body) as Record<string, unknown>; } catch { /* empty */ }
    return { status: res._status, body };
};
type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
const toolResult = (r: ToolResult): { status: number; body: Record<string, unknown> } => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(r.content[0]!.text) as Record<string, unknown>; } catch { body = { text: r.content[0]?.text }; }
    return { status: r.isError ? 403 : 200, body };
};
class FakeMcpServer {
    tools = new Map<string, (a: Record<string, unknown>) => Promise<ToolResult>>();
    tool(name: string, ..._r: unknown[]) { const h = _r[_r.length - 1]; if (typeof h === 'function') this.tools.set(name, h as never); }
}

const isForbidden = (o: { status: number; body: Record<string, unknown> }): boolean =>
    o.body['code'] === MAINTENANCE_FORBIDDEN || o.body['error'] === MAINTENANCE_FORBIDDEN;

/* ---------- real graph rig (prune-ephemeral, retention sweep) ---------- */

async function openGraph(): Promise<{ graph: SqliteGraph; outbox: FileOutboxStore }> {
    const graph = new SqliteGraph(mkTmp('wsm-g-'), { workspaceId: WS });
    await graph.initialize();
    return { graph, outbox: new FileOutboxStore(mkTmp('wsm-o-')) };
}
const ephemeralNode = (id: string) => ({
    id, type: 'note', label: id, content: `c ${id}`, tags: [], project: WS, ecosystem: '*', metadata: '{}',
    ephemeral: true, ttl_ms: 1, security_scopes: ['y'],
}) as never;
const verbatimStub = () => ({ async getById() { return null; }, async store() { /* */ }, async tombstone() { /* */ } });

/* ========================= the specs ========================= */

const SPECS: Spec[] = [];

SPECS.push({
    name: 'POST /api/prune-ephemeral',
    async make() {
        const { graph, outbox } = await openGraph();
        await graph.upsertNode(ephemeralNode('eph'));
        await sleep(20);
        const deps = {
            store: { loreGraph: graph, loreVerbatim: verbatimStub() },
            auditLog: { log: () => undefined },
            runRetentionSweep: async () => { throw new Error('unused'); },
            deploymentMode: 'local', dataplane: null, detectedScope: { workspace: WS, ecosystem: '*' },
            outboxStore: outbox,
        };
        return {
            async invoke() {
                const res = fakeRes();
                await tryPolicyRoutes(fakeReq('POST', JSON.stringify({ defaultTtlMs: 3_600_000 })), res, deps as never, '/api/prune-ephemeral');
                return restResult(res);
            },
            async reached() { return (await graph.getNode('eph')) === null; },
            async untouched() {
                assert.ok(await graph.getNode('eph'), 'expired hidden node must still exist');
                assert.equal((await outbox.listPendingForWorkspace(WS, 100)).length, 0, 'no outbox row');
            },
        };
    },
});

SPECS.push({
    name: 'POST /api/workspace/retention/sweep (dry-run)',
    async make() {
        const { graph } = await openGraph();
        if (!listWorkspaceNames().includes(WS)) createWorkspace(WS);
        setWorkspaceRetention(WS, { autoArchiveSupersededAfterDays: 1 });
        await graph.upsertNode({ ...(ephemeralNode('old') as object), ephemeral: false, supersededAt: '2020-01-01T00:00:00.000Z' } as never);
        const deps = {
            store: { loreGraph: graph, loreVerbatim: verbatimStub() },
            auditLog: { log: () => undefined },
            runRetentionSweep: async () => { throw new Error('unused'); },
            deploymentMode: 'local', dataplane: null, detectedScope: { workspace: WS, ecosystem: '*' },
        };
        let eligible: unknown;
        return {
            async invoke() {
                const res = fakeRes();
                await tryPolicyRoutes(fakeReq('POST', JSON.stringify({ dryRun: true })), res, deps as never, '/api/workspace/retention/sweep');
                const out = restResult(res);
                eligible = out.body['eligible'];
                return out;
            },
            async reached() { return eligible === 1; },
        };
    },
});

SPECS.push({
    name: 'POST /api/retention/sweep (admin)',
    async make() {
        const calls: unknown[] = [];
        const deps = {
            consentManager: { request: () => { throw new Error('consent must not be reached'); } },
            retentionSweeper: { sweep: async (o: unknown) => { calls.push(o); return { eligible: 3 }; } },
            archiveSink: {}, mcpClientRuntime: {}, connectorRegistry: {}, auditLog: { log: () => undefined },
            deploymentMode: 'local', dataplane: null,
        };
        return {
            async invoke() {
                const res = fakeRes();
                await tryAdminRoutes(fakeReq('POST', '{}'), res, '/api/retention/sweep', '/api/retention/sweep', deps as never);
                return restResult(res);
            },
            async reached() { return calls.length === 1; },
        };
    },
});

for (const route of ['reconnect', 'reconsume'] as const) {
    SPECS.push({
        name: `POST /api/graph/${route}`,
        async make() {
            const log: string[] = [];
            const deps = {
                store: tripwire(log, 'store'), consentManager: tripwire(log, 'consent'), auditLog: { log: () => undefined },
                configManager: tripwire(log, 'config'), graphBasePath: mkTmp('wsm-gb-'),
                deploymentMode: 'local', dataplane: null,
            };
            return {
                async invoke() {
                    const res = fakeRes();
                    await tryIngestionRoutes(fakeReq('POST', JSON.stringify({ workspace: WS, apply: true })), res, `/api/graph/${route}`, `/api/graph/${route}`, deps as never);
                    return restResult(res);
                },
                async reached() { return log.length > 0; },
            };
        },
    });
}

for (const [pathname, body] of [
    ['/api/orphan/drop', { resource: 'p1', confirm: 'DROP' }],
    ['/api/orphan', { resource: 'p1', decision: 'drop', confirm: 'DROP' }],
] as const) {
    SPECS.push({
        name: `POST ${pathname}${pathname === '/api/orphan' ? ' (decision=drop)' : ''}`,
        async make() {
            const deps = { deploymentMode: 'local', dataplane: null, store: {}, configManager: {} };
            let status = 0;
            return {
                async invoke() {
                    const res = fakeRes();
                    await tryConfigRoutes(fakeReq('POST', JSON.stringify(body)), res, pathname, pathname, deps as never);
                    status = res._status;
                    return restResult(res);
                },
                async reached() { return status === 200; },
            };
        },
    });
}

SPECS.push({
    name: 'POST /api/diagnose/consistency/cleanup',
    async make() {
        const log: string[] = [];
        const deps = { store: tripwire(log, 'store'), configManager: {}, activeSessions: new Map(), deploymentMode: 'local', getDataplaneState: () => ({}), dataplane: null };
        return {
            async invoke() {
                const res = fakeRes();
                await handleConsistencyCleanup(res, `/api/diagnose/consistency/cleanup?workspace=${WS}`, deps as never);
                return restResult(res);
            },
            async reached() { return log.length > 0; },
        };
    },
});

for (const leg of ['push', 'pull', 'now'] as const) {
    SPECS.push({
        name: `POST /api/sync/${leg}`,
        async make() {
            const counts = { push: 0, pull: 0, both: 0 };
            const engine = {
                pushPending: async () => { counts.push++; return { failures: 0, nodesPushed: 0, edgesPushed: 0, errors: [] }; },
                pullRemote: async () => { counts.pull++; return { nodesPulled: 0 }; },
                sync: async () => { counts.both++; return { push: { failures: 0 }, pull: {} }; },
            };
            return {
                async invoke() {
                    const res = fakeRes();
                    await trySyncRoutes(fakeReq('POST'), res, `/api/sync/${leg}?workspace=${WS}`, `/api/sync/${leg}`, { getSyncEngine: () => engine } as never);
                    return restResult(res);
                },
                async reached() { return counts.push + counts.pull + counts.both > 0; },
            };
        },
    });
}

/* ---------- retention-policy CHANGES (the sweeper applies them to every row) ---------- */

// The daemon sweeper later archives/deletes rows by this policy, hidden rows included, so a
// bound non-operator may not change it. The proof is the on-disk policy, read for the target
// workspace AND the active one (an unbound/no-principal PUT lands on the active workspace).
const policyDays = (): Array<number | null | undefined> =>
    [...new Set([WS, getActiveWorkspaceName()])].map((n) => getWorkspaceRetention(n).autoArchiveSupersededAfterDays);
const POLICY_BODY = JSON.stringify({ autoArchiveSupersededAfterDays: 17 });
function resetPolicies(): void {
    if (!listWorkspaceNames().includes(WS)) createWorkspace(WS);
    for (const n of new Set([WS, getActiveWorkspaceName()])) setWorkspaceRetention(n, { autoArchiveSupersededAfterDays: null });
}

SPECS.push({
    name: 'PUT /api/workspace/retention',
    async make() {
        resetPolicies();
        const { graph } = await openGraph();
        const deps = {
            store: { loreGraph: graph, loreVerbatim: verbatimStub() },
            auditLog: { log: () => undefined },
            runRetentionSweep: async () => { throw new Error('unused'); },
            deploymentMode: 'local', dataplane: null, detectedScope: { workspace: WS, ecosystem: '*' },
        };
        return {
            async invoke() {
                const res = fakeRes();
                await tryPolicyRoutes(fakeReq('PUT', POLICY_BODY), res, deps as never, '/api/workspace/retention');
                return restResult(res);
            },
            async reached() { return policyDays().includes(17); },
            async untouched() { assert.ok(policyDays().every((d) => d === null), 'policy must be unchanged'); },
        };
    },
});

SPECS.push({
    name: 'PATCH /api/workspaces/:name/retention',
    async make() {
        resetPolicies();
        const deps = { auditLog: { log: () => undefined }, deploymentMode: 'local', dataplane: null };
        return {
            async invoke() {
                const res = fakeRes();
                const url = `/api/workspaces/${WS}/retention`;
                await tryWorkspaceMgmtRoutes(fakeReq('PATCH', POLICY_BODY), res, url, url, deps as never);
                return restResult(res);
            },
            async reached() { return getWorkspaceRetention(WS).autoArchiveSupersededAfterDays === 17; },
            async untouched() { assert.equal(getWorkspaceRetention(WS).autoArchiveSupersededAfterDays, null, 'policy must be unchanged'); },
        };
    },
});

/* ---------- MCP tools ---------- */

SPECS.push({
    name: 'MCP prune_ephemeral',
    async make() {
        const { graph, outbox } = await openGraph();
        await graph.upsertNode(ephemeralNode('eph'));
        await sleep(20);
        const srv = new FakeMcpServer();
        registerGovernanceTools(srv as never, {
            store: { loreGraph: graph, loreVerbatim: verbatimStub(), storageClient: { verbatimDelete: async () => undefined } } as never,
            getSyncEngine: () => ({}) as never,
            detectedScope: { workspace: WS, ecosystem: '*' },
            outboxStore: outbox,
        });
        return {
            async invoke() { return toolResult(await srv.tools.get('prune_ephemeral')!({ workspace: WS, defaultTtlMs: 3_600_000 })); },
            async reached() { return (await graph.getNode('eph')) === null; },
            async untouched() {
                assert.ok(await graph.getNode('eph'), 'expired hidden node must still exist');
                assert.equal((await outbox.listPendingForWorkspace(WS, 100)).length, 0, 'no outbox row');
            },
        };
    },
});

SPECS.push({
    name: 'MCP sync_now',
    async make() {
        let calls = 0;
        const engine = {
            pushPending: async () => { calls++; return { failures: 0 }; },
            pullRemote: async () => { calls++; return { nodesPulled: 0 }; },
        };
        const srv = new FakeMcpServer();
        registerGovernanceTools(srv as never, {
            store: {} as never, getSyncEngine: () => engine as never, detectedScope: { workspace: WS, ecosystem: '*' },
        });
        return {
            async invoke() { return toolResult(await srv.tools.get('sync_now')!({ workspace: WS })); },
            async reached() { return calls > 0; },
        };
    },
});

SPECS.push({
    name: 'MCP maintain (dry-run)',
    async make() {
        const log: string[] = [];
        const srv = new FakeMcpServer();
        registerMaintainTools(srv as never, {
            store: tripwire(log, 'store'), graphBasePath: mkTmp('wsm-mb-'), dataHome: mkTmp('wsm-mh-'),
            deploymentMode: 'local',
        } as never);
        let ran = false;
        return {
            async invoke() {
                // Every engine op disabled: the call is a no-op report once past the gate.
                const out = toolResult(await srv.tools.get('maintain')!({
                    dry_run: true, workspace: WS,
                    disable: ['compaction', 'versionCleanup', 'nodeRetention', 'ephemeralExpiry', 'versionsSqlitePrune', 'orphanAliasSweep'],
                }));
                ran = !isForbidden(out);
                return out;
            },
            async reached() { return ran; },
        };
    },
});


/* ---------- workspace switch / rename / delete (registry + whole-workspace removal) ---------- */

const BASE_ACTIVE = getActiveWorkspaceName();
const names = (): string[] => listWorkspaceNames();
let uniq = 0;
const freshName = (p: string): string => `${p}-${++uniq}`;
const mgmtDeps = { auditLog: { log: () => undefined }, deploymentMode: 'local', dataplane: null };
async function mgmt(method: string, url: string, body = ''): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = fakeRes();
    await tryWorkspaceMgmtRoutes(fakeReq(method, body), res, url, url, mgmtDeps as never);
    return restResult(res);
}
// The restart hook is spied, never run: the drain records its reason and the exit fn is a no-op.
const drains: string[] = [];
function spyShutdown(): void {
    __resetForTests();
    __setExitFnForTests(() => undefined);
    drains.length = 0;
    registerDrain(async (reason) => { drains.push(reason); });
}

SPECS.push({
    name: 'POST /api/workspaces/switch',
    async make() {
        spyShutdown();
        switchWorkspace(BASE_ACTIVE);
        const target = freshName('wsm-sw');
        createWorkspace(target);
        return {
            invoke: () => mgmt('POST', '/api/workspaces/switch', JSON.stringify({ name: target })),
            async reached() { await sleep(30); return getActiveWorkspaceName() === target && drains.includes('workspace-switch'); },
            async untouched() { await sleep(30); assert.equal(getActiveWorkspaceName(), BASE_ACTIVE); assert.deepEqual(drains, [], 'no restart'); },
        };
    },
});

SPECS.push({
    name: 'POST /api/workspaces/rename',
    async make() {
        const from = freshName('wsm-rn'), to = `${from}-new`;
        createWorkspace(from);
        return {
            invoke: () => mgmt('POST', '/api/workspaces/rename', JSON.stringify({ oldName: from, newName: to })),
            async reached() { return names().includes(to); },
            async untouched() { assert.ok(names().includes(from) && !names().includes(to), 'registry unchanged'); },
        };
    },
});

SPECS.push({
    name: 'DELETE /api/workspaces/:name',
    async make() {
        const name = freshName('wsm-dl');
        createWorkspace(name);
        const marker = path.join(getWorkspacePath(name), 'row-marker.txt');
        fs.writeFileSync(marker, 'row');
        return {
            invoke: () => mgmt('DELETE', `/api/workspaces/${name}`),
            async reached() { return !names().includes(name); },
            async untouched() { assert.ok(names().includes(name) && fs.existsSync(marker), 'registry entry and rows unchanged'); },
        };
    },
});

/* ---------- daemon restart / logs ---------- */

SPECS.push({
    name: 'POST /api/daemon/restart',
    async make() {
        spyShutdown();
        return {
            async invoke() { const res = fakeRes(); handleDaemonRestart(res); return restResult(res); },
            async reached() { await sleep(30); return drains.includes('daemon-restart'); },
            async untouched() { await sleep(30); assert.deepEqual(drains, [], 'no restart triggered'); },
        };
    },
});

const LOG_MARKER = 'CROSS-WORKSPACE-LOG-LINE';
SPECS.push({
    name: 'GET /api/daemon/logs',
    async make() {
        const dir = path.join(os.homedir(), 'Library', 'Logs', 'Lore');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'lore-mcp.log'), `${LOG_MARKER} ws-other node-123\n`);
        let leaked = false;
        return {
            async invoke() {
                const res = fakeRes();
                await handleDaemonLogs(fakeReq('GET'), res);
                leaked = res._body.includes(LOG_MARKER);
                return restResult(res);
            },
            async reached() { return leaked; },
            async untouched() { assert.equal(leaked, false, 'no log content returned'); },
        };
    },
});

/* ---------- other daemon-wide routes the operator lane alone admits an app token to ---------- */

SPECS.push({
    name: 'POST /api/connectors/:name/sync',
    async make() {
        let synced = 0;
        const deps = { connectorRegistry: { syncOne: async function* () { synced++; } }, auditLog: { log: () => undefined }, deploymentMode: 'local', dataplane: null };
        const url = '/api/connectors/filesystem/sync';
        return {
            async invoke() { const res = fakeRes(); await tryAdminRoutes(fakeReq('POST'), res, url, url, deps as never); return restResult(res); },
            async reached() { return synced === 1; },
        };
    },
});

SPECS.push({
    name: 'PATCH /api/connectors/filesystem/paths',
    async make() {
        const root = path.join(os.homedir(), `wsm-root-${++uniq}`);
        fs.mkdirSync(root, { recursive: true });
        const deps = { auditLog: { log: () => undefined }, deploymentMode: 'local', dataplane: null };
        const url = '/api/connectors/filesystem/paths';
        let status = 0;
        return {
            async invoke() {
                const res = fakeRes();
                await tryAdminRoutes(fakeReq('PATCH', JSON.stringify({ roots: [root] })), res, url, url, deps as never);
                status = res._status;
                return restResult(res);
            },
            async reached() { return status === 200; },
        };
    },
});

SPECS.push({
    name: 'GET /api/audit',
    async make() {
        const deps = { auditLog: { tail: () => [{ toolName: 'other-ws-call' }], since: () => [] }, feedbackStore: {}, deploymentMode: 'local', dataplane: null };
        let status = 0;
        return {
            async invoke() { const res = fakeRes(); await tryAuditRoutes(fakeReq('GET'), res, '/api/audit?tail=5', '/api/audit', deps as never); status = res._status; return restResult(res); },
            async reached() { return status === 200; },
        };
    },
});

SPECS.push({
    name: 'PATCH /api/config',
    async make() {
        let patched = 0;
        // patch throws after being counted so the handler never reaches the real keychain probe.
        const deps = { configManager: { patch: () => { patched++; throw new Error('stop after patch'); } }, store: {}, deploymentMode: 'local', dataplane: null };
        return {
            async invoke() { const res = fakeRes(); await tryConfigRoutes(fakeReq('PATCH', JSON.stringify({ llmProvider: 'ollama' })), res, '/api/config', '/api/config', deps as never); return restResult(res); },
            async reached() { return patched === 1; },
        };
    },
});

SPECS.push({
    name: 'GET /api/admin/stats',
    async make() {
        let read = 0;
        const deps = { store: { storageClient: { getStats: async () => { read++; return { nodeCount: 1, edgeCount: 1 }; }, verbatimCount: async () => 0 }, loreGraph: {} }, deploymentMode: 'local', dataplane: null };
        return {
            async invoke() { const res = fakeRes(); await handleAdminStats(res, deps as never); return restResult(res); },
            async reached() { return read > 0; },
            async untouched() { assert.equal(read, 0, 'no cross-workspace counts read'); },
        };
    },
});

SPECS.push({
    name: 'GET /api/arcade/apps (tenant administration)',
    async make() {
        let status = 0;
        return {
            async invoke() { const res = fakeRes(); await tryArcadeAdminRoutes(fakeReq('GET'), res, '/api/arcade/apps', '/api/arcade/apps', { auditLog: { log: () => undefined } } as never); status = res._status; return restResult(res); },
            async reached() { return status === 200; },
        };
    },
});

/* ---------- MCP equivalents ---------- */

SPECS.push({
    name: 'MCP register_workspace (re-register an existing name)',
    async make() {
        const reg = readWorkspaceRegistry();
        upsertWorkspaceMapping(reg, WS, { ecosystem: 'eco1', paths: ['/p1'] });
        writeWorkspaceRegistry(reg);
        const srv = new FakeMcpServer();
        registerGovernanceTools(srv as never, { store: {} as never, getSyncEngine: () => ({}) as never, detectedScope: { workspace: WS, ecosystem: '*' } });
        return {
            invoke: async () => toolResult(await srv.tools.get('register_workspace')!({ name: WS, ecosystem: 'eco2', paths: ['/p2'] })),
            async reached() { return readWorkspaceRegistry().projects[WS]?.ecosystem === 'eco2'; },
            async untouched() { assert.deepEqual(readWorkspaceRegistry().projects[WS], { ecosystem: 'eco1', paths: ['/p1'] }, 'mapping unchanged'); },
        };
    },
});

SPECS.push({
    name: 'MCP admin_stats',
    async make() {
        let read = 0;
        const srv = new FakeMcpServer();
        registerDiagnosticTools(srv as never, {
            store: { storageClient: { getStats: async () => { read++; return { nodeCount: 1, edgeCount: 1 }; }, verbatimCount: async () => 0 } } as never,
            detectedScope: { workspace: WS, ecosystem: '*' }, deploymentMode: 'local', graphBasePath: mkTmp('wsm-ds-'), nodeTypesEnum: z.enum(['note']),
        });
        return {
            invoke: async () => toolResult(await srv.tools.get('admin_stats')!({})),
            async reached() { return read > 0; },
            async untouched() { assert.equal(read, 0, 'no cross-workspace counts read'); },
        };
    },
});

/* ========================= matrix ========================= */

for (const spec of SPECS) {
    console.log(`\n${spec.name}\n`);
    for (const mode of MODES) {
        await test(`${mode.name}: ${mode.allowed ? 'proceeds past the gate' : '403 maintenance_forbidden, nothing touched'}`, async () => {
            const c = await spec.make();
            const out = await mode.run(() => c.invoke());
            if (mode.allowed) {
                assert.equal(isForbidden(out), false, `unexpected refusal: ${JSON.stringify(out)}`);
                assert.equal(await c.reached(), true, `gate passed but work never started: ${JSON.stringify(out)}`);
            } else {
                assert.equal(isForbidden(out), true, `expected maintenance_forbidden, got ${JSON.stringify(out)}`);
                if (!spec.name.startsWith('MCP')) assert.equal(out.status, 403);
                assert.equal(typeof out.body['message'], 'string');
                assert.equal(await c.reached(), false, 'work behind the gate must not start');
                if (c.untouched) await c.untouched();
            }
        });
    }
}

/* ---------- dry-run leak: the refusal carries no workspace counts ---------- */

await test('retention sweep dry-run: refusal body has no eligible/sample counts; operator body does', async () => {
    const spec = SPECS.find((s) => s.name.startsWith('POST /api/workspace/retention/sweep'))!;
    const denied = await MODES[0]!.run(async () => (await spec.make()).invoke());
    assert.equal(denied.status, 403);
    assert.equal(denied.body['eligible'], undefined);
    assert.equal(denied.body['sample'], undefined);
    const ok = await MODES[2]!.run(async () => (await spec.make()).invoke());
    assert.equal(ok.status, 200);
    assert.equal(ok.body['eligible'], 1);
});

await test('REST and MCP refusals use the single maintenance_forbidden code', async () => {
    const rest = await SPECS[0]!.make();
    const r = await MODES[0]!.run(() => rest.invoke());
    assert.equal(r.body['code'], 'maintenance_forbidden');
    const mcp = await SPECS.find((s) => s.name === 'MCP sync_now')!.make();
    const m = await MODES[0]!.run(() => mcp.invoke());
    assert.equal(m.body['error'], 'maintenance_forbidden');
});

/* ---------- reading the policy stays open; create/list stay open; unbound behaviour unchanged ---------- */

await test('GET retention policy still works for a bound non-operator (REST, both routes)', async () => {
    resetPolicies();
    setWorkspaceRetention(WS, { autoArchiveSupersededAfterDays: 9 });
    const deps = { auditLog: { log: () => undefined }, deploymentMode: 'local', dataplane: null, detectedScope: { workspace: WS, ecosystem: '*' } };
    const viaMgmt = await MODES[0]!.run(async () => {
        const res = fakeRes();
        const url = `/api/workspaces/${WS}/retention`;
        await tryWorkspaceMgmtRoutes(fakeReq('GET'), res, url, url, deps as never);
        return restResult(res);
    });
    assert.equal(viaMgmt.status, 200);
    assert.equal(viaMgmt.body['autoArchiveSupersededAfterDays'], 9);
    const viaPolicy = await MODES[0]!.run(async () => {
        const res = fakeRes();
        await tryPolicyRoutes(fakeReq('GET'), res, deps as never, '/api/workspace/retention');
        return restResult(res);
    });
    assert.equal(viaPolicy.status, 200, JSON.stringify(viaPolicy));
    setWorkspaceRetention(WS, { autoArchiveSupersededAfterDays: null });
});

await test('unbound and operator callers still rename and delete a workspace; rows on disk stay', async () => {
    const name = freshName('wsm-keep');
    const entry = createWorkspace(name);
    const marker = path.join(entry.path, 'row-marker.txt');
    fs.mkdirSync(entry.path, { recursive: true });
    fs.writeFileSync(marker, 'row');
    assert.equal((await MODES[4]!.run(() => mgmt('POST', '/api/workspaces/rename', JSON.stringify({ oldName: name, newName: `${name}-2` })))).status, 200);
    assert.equal(getWorkspacePath(`${name}-2`), entry.path, 'rename keeps the same data path');
    assert.equal((await MODES[2]!.run(() => mgmt('DELETE', `/api/workspaces/${name}-2`))).status, 200);
    assert.ok(!loadWorkspaces().workspaces.some((w) => w.name === `${name}-2`), 'registry entry removed');
    assert.ok(fs.existsSync(marker), 'data on disk untouched by workspace DELETE');
});

await test('workspace CREATE and list stay open to a bound non-operator; create cannot clobber an existing entry', async () => {
    const name = freshName('wsm-create');
    const made = await MODES[0]!.run(() => mgmt('POST', '/api/workspaces', JSON.stringify({ name })));
    assert.equal(made.status, 201, JSON.stringify(made));
    const before = loadWorkspaces().workspaces.find((w) => w.name === name);
    const again = await MODES[0]!.run(() => mgmt('POST', '/api/workspaces', JSON.stringify({ name, label: 'hijack' })));
    assert.equal(again.status, 400, 'an existing name is refused, not overwritten');
    assert.deepEqual(loadWorkspaces().workspaces.find((w) => w.name === name), before, 'existing entry unchanged');
    assert.equal((await MODES[0]!.run(() => mgmt('GET', '/api/workspaces'))).status, 200);
});

await test('MCP register_workspace: a bound non-operator may still register a NEW name, not re-point it', async () => {
    const reg = readWorkspaceRegistry();
    delete reg.projects[WS];
    writeWorkspaceRegistry(reg);
    const srv = new FakeMcpServer();
    registerGovernanceTools(srv as never, { store: {} as never, getSyncEngine: () => ({}) as never, detectedScope: { workspace: WS, ecosystem: '*' } });
    const call = (eco: string) => MODES[0]!.run(async () => toolResult(await srv.tools.get('register_workspace')!({ name: WS, ecosystem: eco, paths: ['/p'] })));
    const first = await call('e1');
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(readWorkspaceRegistry().projects[WS]?.ecosystem, 'e1');
    const second = await call('e2');
    assert.equal(second.body['error'], 'maintenance_forbidden');
    assert.equal(readWorkspaceRegistry().projects[WS]?.ecosystem, 'e1', 'mapping not re-pointed');
});

await test('daemon restart refusal body carries no restart marker; unbound restart answers 202 as before', async () => {
    spyShutdown();
    const denied = await MODES[0]!.run(async () => { const res = fakeRes(); handleDaemonRestart(res); return restResult(res); });
    assert.equal(denied.status, 403);
    assert.equal(denied.body['restarting'], undefined);
    const ok = await MODES[4]!.run(async () => { const res = fakeRes(); handleDaemonRestart(res); return restResult(res); });
    assert.equal(ok.status, 202);
    assert.equal(ok.body['restarting'], true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

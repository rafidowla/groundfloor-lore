#!/usr/bin/env tsx
/**
 * test/schema-preview-scopes-unit.ts - schema-change previews for a BOUND
 * non-operator count only the rows that caller can see.
 *
 * Surfaces: POST /api/schema/migrations/dry-run, POST /api/schema/proposals
 * (blastRadius), GET /api/schema/proposals[/:id] and MCP schema_list_proposals
 * (stored blastRadius read back), MCP schema_propose, GET
 * /api/schema/migrations/in-flight.
 *
 * Real sqlite-backed graph in a temp dir. know.Tenant rows carry
 * security_scopes ['x'], ['y'] or none; the app caller is bound to ['x'].
 * Unbound and operator callers keep the true totals and get no new fields.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { buildGraphReaders } from '../packages/lore/src/mcp/bootSteps.js';
import { trySchemaRoutes } from '../packages/lore/src/mcp/http/routes/schema.js';
import { registerPhaseATools, type PhaseAContext, type PhaseAToolHost } from '../packages/lore/src/mcp/phaseATools.js';
import { SchemaAuthoringStore, buildProposal } from '../packages/lore/src/schemas/authoring.js';
import type { SchemaGraphOps } from '../packages/lore/src/schemas/substrate/schemaGraphOps.js';
import { SchemaGraphOpsMigrationBackend } from '../packages/lore/src/schemas/migration/schemaGraphOpsBackend.js';
import { MigrationRunner } from '../packages/lore/src/schemas/migration/runner.js';
import { CheckpointStore } from '../packages/lore/src/schemas/migration/checkpointStore.js';
import type { MigrationPlan } from '../packages/lore/src/schemas/migration/types.js';
import { SchemaChangeAuditLogger } from '../packages/lore/src/security/schemaChangeAudit.js';
import { ClassificationAuditLogger } from '../packages/lore/src/security/classificationAudit.js';
import { ClassificationExceptionQueue } from '../packages/lore/src/security/classificationExceptionQueue.js';
import { SyncDirectionGuard } from '../packages/lore/src/security/syncDirectionGuard.js';
import { ConflictLog } from '../packages/lore/src/engines/multiMasterSync.js';
import { SchemaLoader } from '../packages/lore/src/schemas/loader.js';
import { DEFAULT_SCHEMA_V2 } from '../packages/lore/src/schemas/types.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n    ${(e as Error).message}`); }
}

const WS = 'test-ws';
const OPERATOR: Principal = { kind: 'bootstrap', workspace: WS, scopes: ['read', 'write'], label: 'bootstrap' };
const APP: Principal = { kind: 'app', workspace: WS, scopes: ['read', 'write'], label: 'app-1' };
const ACTOR_X = { portalUserId: 'u', scopes: ['x'] } as const;

/** Who is calling: unbound (nothing), operator (bound + bootstrap), app token (bound + app), clerk-style (bound, no principal). */
type Caller = 'unbound' | 'operator' | 'app' | 'noprincipal';
function as<T>(caller: Caller, fn: () => T): T {
    switch (caller) {
        case 'unbound': return fn();
        case 'operator': return runWithActor(ACTOR_X, () => runWithPrincipal(OPERATOR, fn));
        case 'app': return runWithActor(ACTOR_X, () => runWithPrincipal(APP, fn));
        case 'noprincipal': return runWithActor(ACTOR_X, fn);
    }
}
function principalFor(caller: Caller): Principal | undefined {
    return caller === 'operator' ? OPERATOR : caller === 'app' ? APP : undefined;
}

/* ---------- fixture ---------- */

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}

interface Fixture { graph: SqliteGraph; ops: SchemaGraphOps; workspaceDir: string; loreDir: string }

/**
 * know.Tenant: ten-x1 (['x'], has `rent`), ten-x2 (['x']), ten-y1 (['y'], has `rent`), ten-p1 (public).
 * know.Unit: unit-x (['x']).
 * 'leases':  ten-x1->unit-x, ten-y1->unit-x (hidden source), ten-p1->unit-x.
 * 'about':   unit-x->ten-x1, unit-x->ten-y1 (hidden target), ten-p1->ten-x2.
 * Raw: 4 tenants, 3 'leases', 3 inbound-to-Tenant.  Visible to ['x']: 3, 2, 2.
 */
async function makeFixture(): Promise<Fixture> {
    const workspaceDir = mkTmp('lore-schema-preview-');
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
    const graph = new SqliteGraph(mkTmp('lore-schema-preview-graph-'), { workspaceId: 'sp', cacheDisabled: true });
    await graph.initialize();
    const n = (id: string, type: string, scopes: string[], metadata = '{}') => graph.upsertNode({
        id, type, label: id, content: id, tags: [], project: '*', ecosystem: '*', metadata,
        ...(scopes.length ? { security_scopes: scopes } : {}),
    });
    await n('ten-x1', 'know.Tenant', ['x'], '{"rent":1}');
    await n('ten-x2', 'know.Tenant', ['x']);
    await n('ten-y1', 'know.Tenant', ['y'], '{"rent":2}');
    await n('ten-p1', 'know.Tenant', []);
    await n('unit-x', 'know.Unit', ['x']);
    const e = (s: string, t: string, r: string) => graph.addEdge({ sourceId: s, targetId: t, relation: r });
    await e('ten-x1', 'unit-x', 'leases');
    await e('ten-y1', 'unit-x', 'leases');
    await e('ten-p1', 'unit-x', 'leases');
    await e('unit-x', 'ten-x1', 'about');
    await e('unit-x', 'ten-y1', 'about');
    await e('ten-p1', 'ten-x2', 'about');
    const { schemaGraphOps } = buildGraphReaders(() => graph, () => WS);
    return { graph, ops: schemaGraphOps, workspaceDir, loreDir };
}

const removeTenant = () => buildProposal({
    base: DEFAULT_SCHEMA_V2,
    changes: [{ kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' }],
    proposedBy: 'human:rafi',
});

/* ---------- REST harness ---------- */

interface Harness {
    baseUrl: string;
    store: SchemaAuthoringStore;
    checkpoints: CheckpointStore;
    setCaller: (c: Caller) => void;
    close: () => Promise<void>;
}

async function startHarness(fx: Fixture): Promise<Harness> {
    let caller: Caller = 'unbound';
    const schemaChangeAudit = new SchemaChangeAuditLogger(fx.loreDir);
    const store = new SchemaAuthoringStore(fx.workspaceDir, schemaChangeAudit, undefined, fx.ops);
    const checkpoints = new CheckpointStore(fx.loreDir);
    const phaseA = {
        schemaAuthoring: store,
        classificationAudit: new ClassificationAuditLogger(fx.loreDir),
        schemaChangeAudit,
        exceptionQueue: new ClassificationExceptionQueue(fx.loreDir),
        syncGuard: new SyncDirectionGuard(),
        conflictLog: new ConflictLog(fx.loreDir),
    };
    const schemaLoader = new SchemaLoader(fx.loreDir);
    const backend = new SchemaGraphOpsMigrationBackend(fx.ops);
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const deps = {
            phaseA, schemaLoader, schemaWorkspace: WS,
            migrationBackend: backend, migrationCheckpointStore: checkpoints,
        };
        const p = principalFor(caller);
        const run = () => trySchemaRoutes(req, res, url, pathname, deps);
        const handled = await as(caller, () => (p ? runWithPrincipal(p, run) : run()));
        if (!handled) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`, store, checkpoints,
        setCaller: (c) => { caller = c; },
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

async function fetchJson(url: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }> {
    const res = await fetch(url, {
        method: init?.method ?? 'GET',
        headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

const planOf = (...ops: MigrationPlan['ops']): MigrationPlan => ({ ops, proposedBy: 'human:rafi', approvedBy: 'human:rafi' });
const stripTime = <T extends { computedAt?: string }>(r: T): Omit<T, 'computedAt'> => { const { computedAt: _c, ...rest } = r; return rest; };

async function main(): Promise<void> {
    /* ---------- dry-run ---------- */

    await test('dry-run: unbound and operator get the pre-change report (true totals, no new fields)', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            const plan = planOf(
                { kind: 'node_type.removed', target: 'know.Tenant' },
                { kind: 'edge_type.removed', target: 'leases' },
                { kind: 'field.removed', target: 'know.Tenant.rent' },
            );
            const expected = stripTime(await new MigrationRunner(new SchemaGraphOpsMigrationBackend(fx.ops)).dryRun(plan));
            assert.equal(expected.totalAffected, 4 + 3 + 2);
            for (const c of ['unbound', 'operator'] as const) {
                h.setCaller(c);
                const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/dry-run`, { method: 'POST', body: plan });
                assert.equal(r.status, 200, c);
                assert.deepEqual(stripTime(r.body), JSON.parse(JSON.stringify(expected)), c);
                assert.equal('countScope' in r.body, false, `${c}: no countScope`);
                assert.equal('countsLowerBound' in r.body, false, `${c}: no countsLowerBound`);
            }
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    await test('dry-run: app token bound to [x] gets visible-only counts and samples, labelled countScope', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            const plan = planOf(
                { kind: 'node_type.removed', target: 'know.Tenant' },
                { kind: 'edge_type.removed', target: 'leases' },
                { kind: 'field.removed', target: 'know.Tenant.rent' },
                { kind: 'permission.changed', target: 'know.Tenant.read' },
            );
            for (const c of ['app', 'noprincipal'] as const) {
                h.setCaller(c);
                const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/dry-run`, { method: 'POST', body: plan });
                assert.equal(r.status, 200, c);
                assert.equal(r.body.countScope, 'visible', c);
                assert.equal('countsLowerBound' in r.body, false, `${c}: not capped`);
                const [node, edge, field, perm] = r.body.ops;
                assert.equal(node.affectedRowCount, 3, `${c}: tenants x1,x2,p1`);
                const ids = node.sampleRows.map((s: { id: string }) => s.id);
                assert.ok(!ids.includes('ten-y1'), `${c}: hidden row never sampled`);
                assert.equal(ids.length, 3);
                assert.equal(edge.affectedRowCount, 2, `${c}: leases with both endpoints visible`);
                assert.ok(!edge.sampleRows.some((s: { sourceId: string }) => s.sourceId === 'ten-y1'));
                assert.equal(field.affectedRowCount, 1, `${c}: only ten-x1 has rent and is visible`);
                assert.deepEqual(field.sampleRows.map((s: { id: string }) => s.id), ['ten-x1']);
                assert.equal(perm.affectedRowCount, 0);
                assert.equal(r.body.totalAffected, 3 + 2 + 1);
                assert.ok(!JSON.stringify(r.body).includes('ten-y1'));
            }
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    await test('dry-run: scan cap -> countsLowerBound true (and the totals are the visible rows within the cap)', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            h.store.previewScanCap = 2;
            h.setCaller('app');
            const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/dry-run`, {
                method: 'POST', body: planOf({ kind: 'node_type.removed', target: 'know.Tenant' }),
            });
            assert.equal(r.status, 200);
            assert.equal(r.body.countScope, 'visible');
            assert.equal(r.body.countsLowerBound, true);
            assert.ok(r.body.totalAffected <= 2);
            // Operator is never capped or labelled.
            h.setCaller('operator');
            const op = await fetchJson(`${h.baseUrl}/api/schema/migrations/dry-run`, {
                method: 'POST', body: planOf({ kind: 'node_type.removed', target: 'know.Tenant' }),
            });
            assert.equal(op.body.totalAffected, 4);
            assert.equal('countScope' in op.body, false);
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    await test('dry-run: bound non-operator with no visible view wired is refused (never falls back to raw counts)', async () => {
        const fx = await makeFixture();
        const { visibleGraph: _v, ...opsWithoutView } = fx.ops;
        const h = await startHarness({ ...fx, ops: opsWithoutView as SchemaGraphOps });
        try {
            h.setCaller('app');
            const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/dry-run`, {
                method: 'POST', body: planOf({ kind: 'node_type.removed', target: 'know.Tenant' }),
            });
            assert.equal(r.status, 503);
            assert.ok(!JSON.stringify(r.body).includes('"affectedRowCount"'));
            h.setCaller('unbound');
            const raw = await fetchJson(`${h.baseUrl}/api/schema/migrations/dry-run`, {
                method: 'POST', body: planOf({ kind: 'node_type.removed', target: 'know.Tenant' }),
            });
            assert.equal(raw.status, 200);
            assert.equal(raw.body.totalAffected, 4);
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    /* ---------- propose (REST) ---------- */

    await test('REST propose: unbound and operator get the stored raw blastRadius, no new fields', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            for (const c of ['unbound', 'operator'] as const) {
                h.setCaller(c);
                const r = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: removeTenant() });
                assert.equal(r.status, 201, c);
                const stored = h.store.getProposal(r.body.sandboxId)!;
                assert.deepEqual(r.body.blastRadius, JSON.parse(JSON.stringify(stored.blastRadius)), c);
                assert.equal(r.body.blastRadius.perChange[0].affectedRowCount, 4);
                assert.equal(r.body.blastRadius.perChange[0].readerCount, 3);
                assert.equal(r.body.blastRadius.total, 4);
                assert.equal('countScope' in r.body.blastRadius, false, c);
                assert.equal('countsLowerBound' in r.body.blastRadius, false, c);
            }
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    await test('REST propose: a bound caller with no principal cannot propose a destructive change (3.31 S5: identity is derived, never human:)', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            h.setCaller('noprincipal');
            const r = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: removeTenant() });
            assert.equal(r.status, 403);
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    await test('blastRadiusForCaller: bound caller with no principal gets visible-only counts; the stored copy stays raw', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            const entry = await h.store.propose(removeTenant());
            const br = (await as('noprincipal', () => h.store.blastRadiusForCaller(entry)))!;
            assert.equal(br.countScope, 'visible');
            assert.equal('countsLowerBound' in br, false);
            assert.equal(br.perChange[0]!.affectedRowCount, 3);
            assert.equal(br.perChange[0]!.readerCount, 2);
            assert.equal(br.total, 3);
            assert.equal(h.store.getProposal(entry.sandboxId)!.blastRadius!.total, 4, 'operator copy keeps true totals');
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    await test('blastRadiusForCaller: cap -> countsLowerBound true', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            const entry = await h.store.propose(removeTenant());
            h.store.previewScanCap = 2;
            const br = (await as('noprincipal', () => h.store.blastRadiusForCaller(entry)))!;
            assert.equal(br.countScope, 'visible');
            assert.equal(br.countsLowerBound, true);
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    await test('REST propose: labelled app token cannot propose a destructive change; its additive proposal is labelled', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            h.setCaller('app');
            const bad = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: removeTenant() });
            assert.equal(bad.status, 403);
            const add = buildProposal({
                base: DEFAULT_SCHEMA_V2,
                changes: [{ kind: 'node_type.added', target: 'know.Widget', migration: 'not-applicable' }],
                proposedBy: 'ai:agent',
            });
            const r = await fetchJson(`${h.baseUrl}/api/schema/proposals`, { method: 'POST', body: add });
            if (r.status === 201) {
                assert.equal(r.body.blastRadius.countScope, 'visible');
                assert.equal(r.body.blastRadius.total, 0);
            } else {
                assert.fail(`additive propose answered ${r.status}: ${JSON.stringify(r.body)}`);
            }
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    /* ---------- stored read-back ---------- */

    await test('REST list/get: stored blastRadius is returned as stored to unbound and operator, stripped for a bound non-operator', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            const entry = await h.store.propose(removeTenant()); // stored raw
            assert.equal(entry.blastRadius!.total, 4);
            const get = (id: string) => fetchJson(`${h.baseUrl}/api/schema/proposals/${id}`);
            const list = () => fetchJson(`${h.baseUrl}/api/schema/proposals`);
            for (const c of ['unbound', 'operator'] as const) {
                h.setCaller(c);
                assert.equal((await get(entry.sandboxId)).body.blastRadius.total, 4, c);
                const l = (await list()).body as Array<{ blastRadius?: { total: number } }>;
                assert.equal(l[0]!.blastRadius!.total, 4, c);
                assert.equal('countScope' in (await get(entry.sandboxId)).body.blastRadius, false, c);
            }
            for (const c of ['app', 'noprincipal'] as const) {
                h.setCaller(c);
                const g = await get(entry.sandboxId);
                assert.equal(g.status, 200, c);
                assert.equal('blastRadius' in g.body, false, `${c}: stored counts not returned`);
                assert.equal(g.body.sandboxId, entry.sandboxId);
                const l = (await list()).body as Array<Record<string, unknown>>;
                assert.equal(l.length, 1);
                assert.equal('blastRadius' in l[0]!, false, c);
            }
            // The stored file is untouched.
            assert.equal(h.store.getProposal(entry.sandboxId)!.blastRadius!.total, 4);
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    /* ---------- in-flight checkpoint ---------- */

    await test('GET /migrations/in-flight: per-op totals and cursor are withheld from a bound non-operator only', async () => {
        const fx = await makeFixture();
        const h = await startHarness(fx);
        try {
            h.checkpoints.save({
                planId: 'p1', startedAt: '2026-01-01T00:00:00.000Z', lastCheckpointAt: '2026-01-01T00:00:00.000Z',
                proposedBy: 'human:rafi', approvedBy: 'human:rafi',
                ops: [{ opIndex: 0, op: { kind: 'node_type.removed', target: 'know.Tenant' }, status: 'in_progress', cursor: 'ten-y1', deleted: 3, modified: 1 }],
            });
            for (const c of ['unbound', 'operator'] as const) {
                h.setCaller(c);
                const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/in-flight`);
                assert.deepEqual(r.body.inFlight.ops[0], {
                    opIndex: 0, op: { kind: 'node_type.removed', target: 'know.Tenant' }, status: 'in_progress', cursor: 'ten-y1', deleted: 3, modified: 1,
                }, c);
            }
            h.setCaller('app');
            const r = await fetchJson(`${h.baseUrl}/api/schema/migrations/in-flight`);
            assert.equal(r.status, 200);
            assert.deepEqual(r.body.inFlight.ops[0], { opIndex: 0, op: { kind: 'node_type.removed', target: 'know.Tenant' }, status: 'in_progress' });
            assert.equal(r.body.inFlight.planId, 'p1');
            h.checkpoints.clear();
            const none = await fetchJson(`${h.baseUrl}/api/schema/migrations/in-flight`);
            assert.deepEqual(none.body, { inFlight: null });
        } finally { await h.close(); await fx.graph.close?.(); }
    });

    /* ---------- MCP ---------- */

    function mcpTools(fx: Fixture, store: SchemaAuthoringStore) {
        const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
        const host: PhaseAToolHost = { tool(name, _d, _s, handler) { tools.set(name, handler as never); } };
        const ctx: PhaseAContext = {
            schemaLoader: new SchemaLoader(fx.loreDir),
            schemaAuthoring: store,
            classificationAudit: new ClassificationAuditLogger(fx.loreDir),
            schemaChangeAudit: new SchemaChangeAuditLogger(fx.loreDir),
            exceptionQueue: new ClassificationExceptionQueue(fx.loreDir),
            syncGuard: new SyncDirectionGuard(),
            conflictLog: new ConflictLog(fx.loreDir),
        };
        registerPhaseATools(host, ctx);
        return (name: string, args: Record<string, unknown>) => tools.get(name)!({ workspace: WS, ...args });
    }
    const principalOnly = <T>(c: Caller, fn: () => T): T => as(c, () => { const p = principalFor(c); return p ? runWithPrincipal(p, fn) : fn(); });

    await test('MCP schema_propose: operator/unbound unlabelled; bound non-operator labelled countScope visible', async () => {
        const fx = await makeFixture();
        try {
            const store = new SchemaAuthoringStore(fx.workspaceDir, undefined, undefined, fx.ops);
            const call = mcpTools(fx, store);
            const args = { proposedBy: 'ai:gemma', addNodeType: { name: 'know.Widget', description: 'w', kind: 'factual' } };
            for (const c of ['unbound', 'operator'] as const) {
                const r = await principalOnly(c, () => call('schema_propose', args));
                const body = JSON.parse(r.content[0]!.text);
                assert.equal(body.blastRadius.total, 0, c);
                assert.equal('countScope' in body.blastRadius, false, c);
            }
            for (const c of ['app', 'noprincipal'] as const) {
                const r = await principalOnly(c, () => call('schema_propose', args));
                const body = JSON.parse(r.content[0]!.text);
                assert.equal(body.blastRadius.countScope, 'visible', c);
                assert.equal(body.blastRadius.total, 0, c);
            }
        } finally { await fx.graph.close?.(); }
    });

    await test('MCP schema_list_proposals: stored blastRadius as stored for unbound/operator, omitted for bound non-operator', async () => {
        const fx = await makeFixture();
        try {
            const store = new SchemaAuthoringStore(fx.workspaceDir, undefined, undefined, fx.ops);
            await store.propose(removeTenant());
            const call = mcpTools(fx, store);
            for (const c of ['unbound', 'operator'] as const) {
                const list = JSON.parse((await principalOnly(c, () => call('schema_list_proposals', {}))).content[0]!.text);
                assert.equal(list[0].blastRadius.total, 4, c);
                assert.equal('countScope' in list[0].blastRadius, false, c);
            }
            for (const c of ['app', 'noprincipal'] as const) {
                const list = JSON.parse((await principalOnly(c, () => call('schema_list_proposals', {}))).content[0]!.text);
                assert.equal(list.length, 1, c);
                assert.equal('blastRadius' in list[0], false, c);
            }
        } finally { await fx.graph.close?.(); }
    });

    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

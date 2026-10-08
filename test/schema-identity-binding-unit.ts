#!/usr/bin/env tsx
/**
 * test/schema-identity-binding-unit.ts — 3.31 S5.
 *
 * Schema proposer / approver identity is never taken from the caller when the
 * caller is BOUND (security/schemaIdentity.ts). Surfaces:
 *   - POST /api/schema/proposals            (proposedBy)
 *   - POST /api/schema/proposals/{id}/approve (approver)
 *   - MCP schema_propose                     (proposedBy arg)
 *   - MCP schema_approve                     (approver arg)
 * Callers: unbound (unchanged), operator (bootstrap / shared-secret, unchanged),
 * bound app token (label mapping), bound actor with NO principal (system:<id>,
 * never human:), bound actor with no usable id (refused).
 * Plus the end-to-end attack: one bound principal-less caller cannot propose a
 * destructive change, nor approve one an operator proposed, by asserting human:.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { trySchemaRoutes } from '../packages/lore/src/mcp/http/routes/schema.js';
import { registerPhaseATools, type PhaseAContext, type PhaseAToolHost } from '../packages/lore/src/mcp/phaseATools.js';
import { SchemaAuthoringStore, buildProposal, type ProposedChange } from '../packages/lore/src/schemas/authoring.js';
import { SchemaChangeAuditLogger } from '../packages/lore/src/security/schemaChangeAudit.js';
import { ClassificationAuditLogger } from '../packages/lore/src/security/classificationAudit.js';
import { ClassificationExceptionQueue } from '../packages/lore/src/security/classificationExceptionQueue.js';
import { SyncDirectionGuard } from '../packages/lore/src/security/syncDirectionGuard.js';
import { ConflictLog } from '../packages/lore/src/engines/multiMasterSync.js';
import { SchemaLoader } from '../packages/lore/src/schemas/loader.js';
import { DEFAULT_SCHEMA_V2 } from '../packages/lore/src/schemas/types.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { InMemoryPendingOpsStore } from '../packages/lore/src/security/inMemoryPendingOpsStore.js';

const WS = 'test-ws';
const BOOTSTRAP: Principal = { kind: 'bootstrap', workspace: WS, scopes: ['read', 'write'], label: 'bootstrap' };
const SHARED: Principal = { kind: 'shared-secret', workspace: WS, scopes: ['read', 'write'], label: 'shared-secret' };
const APP: Principal = { kind: 'app', workspace: WS, scopes: ['read', 'write'], label: 'apphash0001' };
const ACTOR = { portalUserId: 'user_clerk_1', scopes: ['x'] as ReadonlyArray<string> };

type Wrap = <T>(fn: () => T) => T;
const CALLERS: Record<string, Wrap> = {
    unbound: (fn) => fn(),
    operator: (fn) => runWithActor(ACTOR, () => runWithPrincipal(BOOTSTRAP, fn)),
    shared: (fn) => runWithActor(ACTOR, () => runWithPrincipal(SHARED, fn)),
    app: (fn) => runWithActor(ACTOR, () => runWithPrincipal(APP, fn)),
    boundNoPrincipal: (fn) => runWithActor(ACTOR, fn),
    boundNoId: (fn) => runWithActor({ portalUserId: '', scopes: ['x'] }, fn),
};

let passed = 0;
let failed = 0;
async function t(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

const REMOVE_TENANT: ProposedChange = { kind: 'node_type.removed', target: 'know.Tenant', migration: 'dual-shape' };

interface Fixture {
    dir: string;
    schemaAuthoring: SchemaAuthoringStore;
    schemaLoader: SchemaLoader;
    pendingOpsStore: InMemoryPendingOpsStore;
    baseUrl: string;
    caller: { wrap: Wrap };
    tools: Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>>;
    close: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-s5-ident-'));
    const loreDir = path.join(dir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify({
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, { name: 'know.Tenant', description: '', kind: 'factual' as const }],
    }));
    const schemaChangeAudit = new SchemaChangeAuditLogger(loreDir);
    const schemaAuthoring = new SchemaAuthoringStore(dir, schemaChangeAudit);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue = new ClassificationExceptionQueue(loreDir);
    const syncGuard = new SyncDirectionGuard();
    const conflictLog = new ConflictLog(loreDir);
    const schemaLoader = new SchemaLoader(dir);
    const pendingOpsStore = new InMemoryPendingOpsStore();
    const caller = { wrap: CALLERS['unbound']! };

    const server = http.createServer(async (req, res) => {
        const url = req.url ?? '/';
        const pathname = new URL(url, 'http://x').pathname;
        const handled = await caller.wrap(() => trySchemaRoutes(req, res, url, pathname, {
            phaseA: { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog },
            schemaLoader, pendingOpsStore, schemaWorkspace: WS, runMode: 'local',
        }));
        if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tools = new Map<string, Fixture['tools'] extends Map<string, infer H> ? H : never>();
    const host: PhaseAToolHost = { tool(name, _d, _s, handler) { tools.set(name, handler); } };
    const ctx: PhaseAContext = {
        schemaLoader, schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog,
        pendingOpsStore, schemaWorkspace: WS, runMode: 'local',
    };
    registerPhaseATools(host, ctx);

    return {
        dir, schemaAuthoring, schemaLoader, pendingOpsStore, baseUrl, caller, tools,
        close: async () => { await new Promise<void>((r) => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); },
    };
}

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let parsed: Record<string, unknown> = {};
    try { parsed = await res.json() as Record<string, unknown>; } catch { /* empty */ }
    return { status: res.status, body: parsed };
}

function additive(f: Fixture, proposedBy: string, name = 'know.Added') {
    return buildProposal({
        base: f.schemaLoader.getV2(),
        changes: [{ kind: 'node_type.added', target: name, migration: 'lazy', after: { name, description: '', kind: 'factual' } }],
        proposedBy, transforms: { addNodeType: { name, description: '', kind: 'factual' } },
    });
}
function destructive(f: Fixture, proposedBy: string) {
    return buildProposal({ base: f.schemaLoader.getV2(), changes: [REMOVE_TENANT], proposedBy, transforms: { removeNodeType: 'know.Tenant' } });
}
function storedBy(f: Fixture, sandboxId: string): string | undefined {
    return f.schemaAuthoring.getProposal(sandboxId)?.proposal.proposedBy;
}

async function main(): Promise<void> {
    console.log('3.31 S5 — schema proposer / approver identity binding');
    const f = await makeFixture();
    try {
        /* ───────── HTTP propose ───────── */
        const expectPropose: Record<string, string> = {
            unbound: 'human:evil',                 // claim honoured, unchanged
            operator: 'human:bootstrap',           // existing label mapping
            shared: 'system:shared-secret',
            app: 'system:apphash0001',
            boundNoPrincipal: 'system:user_clerk_1',
        };
        for (const [kind, want] of Object.entries(expectPropose)) {
            await t(`HTTP propose [${kind}] stores proposedBy=${want}`, async () => {
                f.caller.wrap = CALLERS[kind]!;
                const r = await post(`${f.baseUrl}/api/schema/proposals`, additive(f, 'human:evil', `know.P_${kind}`));
                assert.equal(r.status, 201, JSON.stringify(r.body));
                assert.equal(storedBy(f, r.body['sandboxId'] as string), want);
            });
        }
        await t('HTTP propose [boundNoId] is refused 403 and stores nothing', async () => {
            f.caller.wrap = CALLERS['boundNoId']!;
            const before = f.schemaAuthoring.listProposals().length;
            const r = await post(`${f.baseUrl}/api/schema/proposals`, additive(f, 'human:evil', 'know.P_noid'));
            assert.equal(r.status, 403);
            assert.equal(r.body['code'], 'maintenance_forbidden');
            assert.equal(f.schemaAuthoring.listProposals().length, before);
        });

        /* ───────── HTTP approve ───────── */
        const expectApprover: Record<string, string> = {
            unbound: 'human:evil',
            operator: 'human:bootstrap',
            shared: 'system:shared-secret',
            app: 'system:apphash0001',
            boundNoPrincipal: 'system:user_clerk_1',
        };
        for (const [kind, want] of Object.entries(expectApprover)) {
            await t(`HTTP approve [${kind}] credits approver=${want}`, async () => {
                f.caller.wrap = CALLERS['unbound']!;
                const p = await post(`${f.baseUrl}/api/schema/proposals`, additive(f, 'ai:seed', `know.A_${kind}`));
                const sid = p.body['sandboxId'] as string;
                f.caller.wrap = CALLERS[kind]!;
                const r = await post(`${f.baseUrl}/api/schema/proposals/${sid}/approve`, { approver: 'human:evil' });
                assert.equal(r.status, 200, JSON.stringify(r.body));
                assert.equal(r.body['approvedBy'], want);
            });
        }
        await t('HTTP approve [boundNoId] is refused 403 and the proposal stays pending', async () => {
            f.caller.wrap = CALLERS['unbound']!;
            const p = await post(`${f.baseUrl}/api/schema/proposals`, additive(f, 'ai:seed', 'know.A_noid'));
            const sid = p.body['sandboxId'] as string;
            f.caller.wrap = CALLERS['boundNoId']!;
            const r = await post(`${f.baseUrl}/api/schema/proposals/${sid}/approve`, { approver: 'human:evil' });
            assert.equal(r.status, 403);
            assert.ok(f.schemaAuthoring.getProposal(sid), 'proposal must still be pending');
        });
        await t('HTTP approve [unbound] with no approver in the body is still 400 (unchanged)', async () => {
            f.caller.wrap = CALLERS['unbound']!;
            const p = await post(`${f.baseUrl}/api/schema/proposals`, additive(f, 'ai:seed', 'know.A_none'));
            const r = await post(`${f.baseUrl}/api/schema/proposals/${p.body['sandboxId'] as string}/approve`, {});
            assert.equal(r.status, 400);
        });

        /* ───────── MCP schema_propose ───────── */
        const expectTool: Record<string, string> = {
            unbound: 'human:evil',            // arg honoured
            operator: 'human:evil',           // operators keep the arg (unchanged)
            shared: 'human:evil',
            app: 'system:apphash0001',        // bound non-operator: derived
            boundNoPrincipal: 'system:user_clerk_1',
        };
        for (const [kind, want] of Object.entries(expectTool)) {
            await t(`MCP schema_propose [${kind}] stores proposedBy=${want}`, async () => {
                const r = await CALLERS[kind]!(() => f.tools.get('schema_propose')!({
                    proposedBy: 'human:evil', workspace: WS,
                    addNodeType: { name: `know.M_${kind}`, description: '', kind: 'factual' },
                }));
                assert.ok(!r.isError, r.content[0]?.text);
                const sid = (JSON.parse(r.content[0]!.text) as { sandboxId: string }).sandboxId;
                assert.equal(storedBy(f, sid), want);
            });
        }
        await t('MCP schema_propose [boundNoId] is refused', async () => {
            const r = await CALLERS['boundNoId']!(() => f.tools.get('schema_propose')!({
                proposedBy: 'human:evil', workspace: WS,
                addNodeType: { name: 'know.M_noid', description: '', kind: 'factual' },
            }));
            assert.equal(r.isError, true);
            assert.match(r.content[0]!.text, /maintenance_forbidden/);
        });

        /* ───────── MCP schema_approve ───────── */
        for (const [kind, want] of Object.entries(expectApprover)) {
            await t(`MCP schema_approve [${kind}] credits approver=${want}`, async () => {
                const sb = await f.schemaAuthoring.propose(additive(f, 'ai:seed', `know.MA_${kind}`));
                const r = await CALLERS[kind]!(() => f.tools.get('schema_approve')!({
                    sandboxId: sb.sandboxId, approver: 'human:evil', workspace: WS,
                }));
                assert.ok(!r.isError, r.content[0]?.text);
                assert.equal((JSON.parse(r.content[0]!.text) as { approvedBy: string }).approvedBy, want);
            });
        }
        await t('MCP schema_approve [boundNoId] is refused and the proposal stays pending', async () => {
            const sb = await f.schemaAuthoring.propose(additive(f, 'ai:seed', 'know.MA_noid'));
            const r = await CALLERS['boundNoId']!(() => f.tools.get('schema_approve')!({
                sandboxId: sb.sandboxId, approver: 'human:evil', workspace: WS,
            }));
            assert.equal(r.isError, true);
            assert.ok(f.schemaAuthoring.getProposal(sb.sandboxId));
        });

        /* ───────── end-to-end attack ───────── */
        await t('attack: bound principal-less caller cannot propose a destructive change as human:*', async () => {
            f.caller.wrap = CALLERS['boundNoPrincipal']!;
            const r = await post(`${f.baseUrl}/api/schema/proposals`, destructive(f, 'human:evil'));
            assert.equal(r.status, 403);
            assert.equal(r.body['code'], 'destructive_change_requires_human');
        });
        await t('attack: bound app token cannot propose a destructive change as human:* (HTTP)', async () => {
            f.caller.wrap = CALLERS['app']!;
            const r = await post(`${f.baseUrl}/api/schema/proposals`, destructive(f, 'human:evil'));
            assert.equal(r.status, 403);
        });
        await t('attack: bound principal-less caller approving an operator\'s destructive proposal only enqueues it, as system:*', async () => {
            f.caller.wrap = CALLERS['operator']!;
            const p = await post(`${f.baseUrl}/api/schema/proposals`, destructive(f, 'ignored'));
            assert.equal(p.status, 201, JSON.stringify(p.body));
            const sid = p.body['sandboxId'] as string;
            for (const via of ['http', 'mcp'] as const) {
                const r = via === 'http'
                    ? (f.caller.wrap = CALLERS['boundNoPrincipal']!, await post(`${f.baseUrl}/api/schema/proposals/${sid}/approve`, { approver: 'human:evil' }))
                    : await (async () => {
                        const x = await CALLERS['boundNoPrincipal']!(() => f.tools.get('schema_approve')!({ sandboxId: sid, approver: 'human:evil', workspace: WS }));
                        return { status: x.isError ? 500 : 202, body: JSON.parse(x.content[0]!.text) as Record<string, unknown> };
                    })();
                assert.equal(r.status, 202, `${via}: ${JSON.stringify(r.body)}`);
                assert.equal(r.body['queued'], true);
            }
            assert.ok(f.schemaAuthoring.getProposal(sid), 'destructive proposal must NOT have been applied');
            assert.ok(f.schemaLoader.getV2().nodeTypes.some((n) => n.name === 'know.Tenant'), 'know.Tenant must still exist');
            const ops = await f.pendingOpsStore.list({ status: 'pending' });
            assert.ok(ops.length >= 2);
            for (const op of ops) {
                const approver = (JSON.parse(op.argsJson) as { approver: string }).approver;
                assert.equal(approver, 'system:user_clerk_1', 'queued approver must be the derived identity, not the asserted human:evil');
            }
        });
    } finally {
        await f.close();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

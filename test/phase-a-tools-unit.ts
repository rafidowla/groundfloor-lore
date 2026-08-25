#!/usr/bin/env tsx
/**
 * test/phase-a-tools-unit.ts — W3 unit tests
 *
 * Captures registered tool handlers via a fake host, then exercises
 * the full schema authoring + audit + exception + sync flow through
 * the MCP surface.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type ZodTypeAny } from 'zod';

import {
    registerPhaseATools,
    type PhaseAContext,
    type PhaseAToolHost,
} from '../packages/lore/src/mcp/phaseATools.js';
import { SchemaLoader } from '../packages/lore/src/schemas/loader.js';
import { SchemaAuthoringStore, buildProposal, type ProposedChange } from '../packages/lore/src/schemas/authoring.js';
import { ClassificationAuditLogger } from '../packages/lore/src/security/classificationAudit.js';
import { SchemaChangeAuditLogger } from '../packages/lore/src/security/schemaChangeAudit.js';
import { ClassificationExceptionQueue } from '../packages/lore/src/security/classificationExceptionQueue.js';
import { SyncDirectionGuard } from '../packages/lore/src/security/syncDirectionGuard.js';
import { ConflictLog } from '../packages/lore/src/engines/multiMasterSync.js';
import { DEFAULT_SCHEMA_V2, type LoreSchemaV2 } from '../packages/lore/src/schemas/types.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { InMemoryPendingOpsStore } from '../packages/lore/src/security/inMemoryPendingOpsStore.js';
import { InMemoryReplayHandlerRegistry, replayApprovedOp } from '../packages/lore/src/security/approvalReplay.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; },
        );
}

interface CapturedTool {
    name: string;
    description: string;
    inputSchema: Record<string, ZodTypeAny>;
    handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
    }>;
}

function makeHost(): { host: PhaseAToolHost; tools: Map<string, CapturedTool> } {
    const tools = new Map<string, CapturedTool>();
    const host: PhaseAToolHost = {
        tool(name, description, inputSchema, handler) {
            tools.set(name, { name, description, inputSchema, handler });
        },
    };
    return { host, tools };
}

async function call(tools: Map<string, CapturedTool>, name: string, args: Record<string, unknown>) {
    const t = tools.get(name);
    if (!t) throw new Error(`tool '${name}' not registered`);
    return t.handler(args);
}

function parseOk<T = unknown>(result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }): T {
    if (result.isError) throw new Error(`tool returned error: ${result.content[0]?.text}`);
    return JSON.parse(result.content[0].text) as T;
}

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-w3-'));
    return Promise.resolve()
        .then(() => fn(dir))
        .finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
}

async function main() {
    console.log('Phase A MCP tools — W3');

    /* ---------- registration ---------- */

    await test('all expected tools register', () => {
        return withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring: new SchemaAuthoringStore(dir),
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);
            const expected = [
                'schema_get', 'schema_summary',
                'schema_propose', 'schema_list_proposals',
                'schema_approve', 'schema_reject',
                'schema_history', 'schema_rollback',
                'audit_classifications', 'audit_schema_changes',
                'exception_queue_list', 'exception_queue_resolve',
                'sync_policy_get', 'conflict_log_list',
            ];
            for (const e of expected) {
                assert.ok(tools.has(e), `missing tool '${e}'`);
            }
            assert.equal(tools.size, expected.length);
        });
    });

    /* ---------- schema_get / schema_summary ---------- */

    await test('schema_get + schema_summary return live schema', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify({
                ...DEFAULT_SCHEMA_V2,
                domain: 'TestWS',
            }));
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring: new SchemaAuthoringStore(dir),
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);

            const desc = parseOk<{ domain: string; counts: { rebacRelationEdges: number } }>(
                await call(tools, 'schema_get', { workspace: 'ws' }),
            );
            assert.equal(desc.domain, 'TestWS');
            assert.equal(desc.counts.rebacRelationEdges, 5);

            const sum = parseOk<{ summary: string }>(await call(tools, 'schema_summary', { workspace: 'ws' }));
            assert.match(sum.summary, /TestWS workspace/);
        });
    });

    /* ---------- propose → list → approve flow ---------- */

    await test('schema_propose → schema_list_proposals → schema_approve updates live schema (approver bound to the authenticated principal, not the forged arg)', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));

            // Loader needs a getV2 that re-reads after approval.
            let liveLoader = new SchemaLoader(dir);
            const ctx: PhaseAContext = {
                schemaLoader: { getV2: () => liveLoader.getV2() },
                schemaAuthoring: new SchemaAuthoringStore(dir),
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
                onSchemaChanged: () => { liveLoader = new SchemaLoader(dir); },
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);

            // GAP 1 (2026-08-17, MCP follow-up) — a bound MCP principal, like
            // the HTTP route's authenticated principal.
            const operator: Principal = { kind: 'bootstrap', workspace: 'ws', scopes: ['read', 'write'], label: 'bootstrap' };

            const proposeRes = parseOk<{ sandboxId: string }>(await call(tools, 'schema_propose', {
                proposedBy: 'ai:gemma',
                addNodeType: { name: 'know.Tenant', description: 'A tenant.', kind: 'factual' },
                workspace: 'ws',
            }));
            assert.ok(proposeRes.sandboxId);

            const list = parseOk<Array<{ sandboxId: string }>>(await call(tools, 'schema_list_proposals', { workspace: 'ws' }));
            assert.equal(list.length, 1);

            const approveResult = await runWithPrincipal(operator, () => call(tools, 'schema_approve', {
                sandboxId: proposeRes.sandboxId,
                // A forged approver arg — must be IGNORED in favor of the
                // bound principal, exactly like the HTTP route.
                approver: 'human:someone-else',
                workspace: 'ws',
            }));
            const receipt = parseOk<{ approvedBy: string }>(approveResult);
            assert.equal(receipt.approvedBy, 'human:bootstrap',
                'approvedBy must be the bound principal, not the forged human:someone-else arg');

            // Live schema now contains know.Tenant.
            const updated = parseOk<LoreSchemaV2>(await call(tools, 'schema_get', { workspace: 'ws' }));
            assert.ok(updated.nodeTypes.find((n) => n.name === 'know.Tenant'));

            // Sandbox cleared.
            const empty = parseOk<unknown[]>(await call(tools, 'schema_list_proposals', { workspace: 'ws' }));
            assert.equal(empty.length, 0);
        });
    });

    /* ---------- GAP 1 (2026-08-17, MCP follow-up): destructive schema_approve
     * must run through the mandatory-HITL gate, exactly like the HTTP route.
     * Before this fix, schema_approve called ctx.schemaAuthoring.approve()
     * directly: no destructive check, no queue requirement, raw client-
     * supplied approver — the exact scenario GAP 1 was meant to eliminate,
     * reachable through the ONLY surface an embedded host (no HTTP port) has.
     * ---------- */

    const REMOVE_DOOMED: ProposedChange = {
        kind: 'node_type.removed',
        target: 'know.Doomed',
        migration: 'dual-shape',
    };

    function schemaWithDoomed(): LoreSchemaV2 {
        return {
            ...DEFAULT_SCHEMA_V2,
            nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, { name: 'know.Doomed', description: '', kind: 'factual' as const }],
        };
    }

    await test('GAP 1 (MCP): schema_approve on a destructive proposal is refused when no HITL queue is wired (no pendingOpsStore in ctx)', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(schemaWithDoomed()));
            const schemaAuthoring = new SchemaAuthoringStore(dir);
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring,
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
                // No pendingOpsStore wired — the vulnerable state.
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);
            const operator: Principal = { kind: 'bootstrap', workspace: 'ws', scopes: ['read', 'write'], label: 'bootstrap' };

            const sandbox = await schemaAuthoring.propose(buildProposal({
                base: schemaWithDoomed(),
                changes: [REMOVE_DOOMED],
                proposedBy: 'human:rafi',
                transforms: { removeNodeType: 'know.Doomed' },
            }));

            // A fully automated, single-call attempt through the REAL tool
            // handler — no queue, no confirmation step present anywhere.
            const result = await runWithPrincipal(operator, () => call(tools, 'schema_approve', {
                sandboxId: sandbox.sandboxId,
                note: 'automated, no human ever looked at this',
                workspace: 'ws',
            }));
            assert.equal(result.isError, true, `expected isError; got ${JSON.stringify(result)}`);
            assert.match(result.content[0].text, /destructive_hitl_unavailable|human-confirmation step/,
                `expected a HITL-unavailable refusal; got: ${result.content[0].text}`);

            // Not applied.
            assert.ok(schemaAuthoring.getProposal(sandbox.sandboxId), 'destructive proposal must NOT have been applied');
        });
    });

    await test('GAP 1 (MCP): a SINGLE operator completes propose -> approve -> decide through schema_approve when the HITL queue is wired', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(schemaWithDoomed()));
            const schemaAuthoring = new SchemaAuthoringStore(dir);
            const pendingOpsStore = new InMemoryPendingOpsStore();
            const replayRegistry = new InMemoryReplayHandlerRegistry();
            replayRegistry.register('schema_approve', async (args) => {
                const { sandboxId, approver, note } = args as { sandboxId: string; approver: string; note?: string };
                await schemaAuthoring.approve(sandboxId, approver, note);
            });
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring,
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
                pendingOpsStore,
                schemaWorkspace: 'ws',
                // ITEM 3 (launch-fixes-2026-08) regression pin — daemon
                // (local) run mode with the queue wired MUST still enqueue +
                // decide + replay exactly as before the embedded-refusal
                // branch existed. If the gate ever started refusing in local
                // mode, this test fails.
                runMode: 'local',
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);
            // ONE principal, unchanged for the whole flow — proves a single
            // operator (not "two different humans") can complete it.
            const operator: Principal = { kind: 'bootstrap', workspace: 'ws', scopes: ['read', 'write'], label: 'bootstrap' };

            const sandbox = await schemaAuthoring.propose(buildProposal({
                base: schemaWithDoomed(),
                changes: [REMOVE_DOOMED],
                proposedBy: 'human:rafi',
                transforms: { removeNodeType: 'know.Doomed' },
            }));

            const approveResult = await runWithPrincipal(operator, () => call(tools, 'schema_approve', {
                sandboxId: sandbox.sandboxId,
                note: 'queued',
                workspace: 'ws',
            }));
            const enq = parseOk<{ queued: boolean; pendingOpId: string; operation: string }>(approveResult);
            assert.equal(enq.queued, true);
            assert.equal(enq.operation, 'schema_approve');
            assert.ok(enq.pendingOpId);
            assert.ok(schemaAuthoring.getProposal(sandbox.sandboxId), 'destructive sandbox still present after enqueue — not yet applied');

            // The explicit, separate human-confirmation step — the SAME
            // operator identity decides. Must not be blocked by any two-
            // identity invariant.
            const decided = await pendingOpsStore.decide({
                id: enq.pendingOpId, decision: 'approved', decidedBy: 'human:bootstrap',
            });
            assert.equal(decided.status, 'approved');

            const replayResult = await replayApprovedOp(decided, replayRegistry);
            assert.equal(replayResult.kind, 'executed', `replay kind=${replayResult.kind}`);
            assert.equal(schemaAuthoring.getProposal(sandbox.sandboxId), null,
                'sandbox cleared — destructive change applied by a single operator, through the real schema_approve tool');
        });
    });

    /* ---------- ITEM 3 (launch-fixes-2026-08): embedded run mode must REFUSE
     * destructive schema_approve at proposal time. Embedded opens no HTTP
     * transport, so the mandatory POST /api/approvals/{id}/decision step can
     * never be reached — before this fix the proposal ENQUEUED anyway
     * (server.ts wires pendingOpsStore unconditionally) and hung pending
     * forever (the v3.14.0 CHANGELOG known limitation). The refusal must be
     * immediate AND nothing may leak into the queue — a refusal that still
     * enqueues underneath would look fixed while still leaking a stuck op.
     * ---------- */

    await test('ITEM 3 (MCP): embedded mode refuses destructive schema_approve immediately and enqueues NOTHING', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(schemaWithDoomed()));
            const schemaAuthoring = new SchemaAuthoringStore(dir);
            const pendingOpsStore = new InMemoryPendingOpsStore();
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring,
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
                // The queue IS wired — exactly like a real embedded boot
                // (server.ts creates it unconditionally). The refusal must
                // come from the run mode, not from queue absence.
                pendingOpsStore,
                schemaWorkspace: 'ws',
                runMode: 'embedded',
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);
            const operator: Principal = { kind: 'bootstrap', workspace: 'ws', scopes: ['read', 'write'], label: 'bootstrap' };

            const sandbox = await schemaAuthoring.propose(buildProposal({
                base: schemaWithDoomed(),
                changes: [REMOVE_DOOMED],
                proposedBy: 'human:rafi',
                transforms: { removeNodeType: 'know.Doomed' },
            }));

            const result = await runWithPrincipal(operator, () => call(tools, 'schema_approve', {
                sandboxId: sandbox.sandboxId,
                note: 'embedded host attempting a destructive approve',
                workspace: 'ws',
            }));

            // IMMEDIATE structured refusal naming the way out (daemon mode).
            assert.equal(result.isError, true, `expected isError; got ${JSON.stringify(result)}`);
            assert.match(result.content[0].text, /destructive_hitl_unavailable_embedded/,
                `expected the embedded refusal code; got: ${result.content[0].text}`);
            assert.match(result.content[0].text, /daemon \(local\) mode/,
                `expected the refusal to name daemon (local) mode; got: ${result.content[0].text}`);

            // THE load-bearing assertion: query the pending-ops STORE
            // DIRECTLY — the queue must be empty. A response that merely
            // LOOKS like a refusal while still enqueueing underneath would
            // be worse than the hang it replaces.
            const ops = await pendingOpsStore.list({});
            assert.equal(ops.length, 0,
                `embedded refusal must not enqueue; store holds ${ops.length} op(s): ${JSON.stringify(ops)}`);

            // And the destructive change was NOT applied.
            assert.ok(schemaAuthoring.getProposal(sandbox.sandboxId),
                'destructive proposal must still be pending — refused, not applied');
        });
    });

    await test('ITEM 3 (MCP): embedded mode still applies ADDITIVE proposals immediately (non-destructive tiers unchanged)', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
            const schemaAuthoring = new SchemaAuthoringStore(dir);
            const pendingOpsStore = new InMemoryPendingOpsStore();
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring,
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
                pendingOpsStore,
                schemaWorkspace: 'ws',
                runMode: 'embedded',
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);
            const operator: Principal = { kind: 'bootstrap', workspace: 'ws', scopes: ['read', 'write'], label: 'bootstrap' };

            const sandbox = await schemaAuthoring.propose(buildProposal({
                base: DEFAULT_SCHEMA_V2,
                changes: [{ kind: 'node_type.added', target: 'know.AddedInEmbedded', migration: 'lazy' }],
                proposedBy: 'human:rafi',
                transforms: { addNodeType: { name: 'know.AddedInEmbedded', description: '', kind: 'factual' } },
            }));

            const approveResult = await runWithPrincipal(operator, () => call(tools, 'schema_approve', {
                sandboxId: sandbox.sandboxId,
                workspace: 'ws',
            }));
            assert.equal(approveResult.isError, undefined,
                `additive approve in embedded mode must succeed; got ${JSON.stringify(approveResult)}`);
            const receipt = parseOk<{ approvedBy: string; queued?: boolean }>(approveResult);
            assert.equal(receipt.queued, undefined, 'additive approve must NOT be routed to the HITL queue');
            assert.equal(schemaAuthoring.getProposal(sandbox.sandboxId), null,
                'additive sandbox cleared — applied immediately');
            const ops = await pendingOpsStore.list({});
            assert.equal(ops.length, 0, 'additive approve must not touch the queue');
        });
    });


    /* ---------- reject ---------- */

    await test('schema_reject leaves live schema alone, logs rejection', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring: new SchemaAuthoringStore(dir),
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);
            const proposeRes = parseOk<{ sandboxId: string }>(await call(tools, 'schema_propose', {
                proposedBy: 'ai:gemma',
                addNodeType: { name: 'know.Drop', description: '', kind: 'factual' },
                workspace: 'ws',
            }));
            const reject = parseOk<{ rejectedBy: string }>(await call(tools, 'schema_reject', {
                sandboxId: proposeRes.sandboxId, reviewer: 'human:rafi', reason: 'wait until Q3',
                workspace: 'ws',
            }));
            assert.equal(reject.rejectedBy, 'human:rafi');
            const live = parseOk<LoreSchemaV2>(await call(tools, 'schema_get', { workspace: 'ws' }));
            assert.equal(live.nodeTypes.find((n) => n.name === 'know.Drop'), undefined);
        });
    });

    /* ---------- audit + exception queue + sync tools ---------- */

    await test('audit_classifications + audit_schema_changes return entries', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
            const cAudit = new ClassificationAuditLogger(loreDir);
            const sAudit = new SchemaChangeAuditLogger(loreDir);
            cAudit.append({
                at: new Date().toISOString(), workspace: 'wsA',
                inputFingerprint: 'fp', decidedBy: 'rule:default',
                outcome: 'routed', kind: 'factual', nodeType: 'know.Note',
            });
            sAudit.append({
                at: new Date().toISOString(), workspace: 'wsA',
                schemaVersionAfter: 2, kind: 'node_type.added',
                target: 'know.Note', proposedBy: 'ai', approvedBy: 'rafi',
                migration: 'lazy',
            });
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring: new SchemaAuthoringStore(dir),
                classificationAudit: cAudit,
                schemaChangeAudit: sAudit,
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);

            const cList = parseOk<Array<{ outcome: string }>>(await call(tools, 'audit_classifications', { workspace: 'wsA' }));
            assert.equal(cList.length, 1);
            assert.equal(cList[0].outcome, 'routed');

            const sList = parseOk<Array<{ kind: string }>>(await call(tools, 'audit_schema_changes', { workspace: 'wsA' }));
            assert.equal(sList.length, 1);
            assert.equal(sList[0].kind, 'node_type.added');
        });
    });

    await test('exception_queue_list + resolve flow', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
            const exQueue = new ClassificationExceptionQueue(loreDir);
            exQueue.enqueue({
                id: 'ex-w3', at: new Date().toISOString(), workspace: 'ws',
                inputFingerprint: 'fp', guess: { decidedBy: 'ai', confidence: 0.5 },
            });
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring: new SchemaAuthoringStore(dir),
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: exQueue,
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);

            const open = parseOk<Array<{ id: string }>>(await call(tools, 'exception_queue_list', { workspace: 'ws' }));
            assert.equal(open.length, 1);
            const resolved = parseOk<{ entry: { id: string } }>(await call(tools, 'exception_queue_resolve', {
                entryId: 'ex-w3', resolvedBy: 'human:rafi',
                decision: 'route', finalKind: 'factual', finalNodeType: 'know.Note',
                workspace: 'ws',
            }));
            assert.equal(resolved.entry.id, 'ex-w3');
        });
    });

    await test('sync_policy_get + conflict_log_list', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
            const sg = new SyncDirectionGuard();
            sg.register({ workspace: 'personal', policy: 'local-first' });
            sg.register({ workspace: 'cre', policy: 'cloud-only' });
            const cl = new ConflictLog(loreDir);
            cl.append({
                nodeId: 'n1', field: 'title', at: new Date().toISOString(),
                winner: { value: 'b', wallClockMs: 2, lamport: 1, deviceId: 'B' },
                loser: { value: 'a', wallClockMs: 1, lamport: 1, deviceId: 'A' },
                rationale: 'wallclock',
                workspace: 'personal',
            });
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring: new SchemaAuthoringStore(dir),
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: sg,
                conflictLog: cl,
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);

            const policies = parseOk<Array<{ workspace: string; policy: string }>>(await call(tools, 'sync_policy_get', { workspace: 'personal' }));
            assert.equal(policies.length, 2);
            assert.ok(policies.find(p => p.workspace === 'personal' && p.policy === 'local-first'));

            const conflicts = parseOk<Array<{ nodeId: string }>>(await call(tools, 'conflict_log_list', { workspace: 'personal' }));
            assert.equal(conflicts.length, 1);
            assert.equal(conflicts[0].nodeId, 'n1');
        });
    });

    /* ---------- error wrapping ---------- */

    await test('approve unknown sandbox returns isError:true (not throw)', async () => {
        await withTmp(async (dir) => {
            const loreDir = path.join(dir, '.lore');
            fs.mkdirSync(loreDir, { recursive: true });
            fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DEFAULT_SCHEMA_V2));
            const ctx: PhaseAContext = {
                schemaLoader: new SchemaLoader(dir),
                schemaAuthoring: new SchemaAuthoringStore(dir),
                classificationAudit: new ClassificationAuditLogger(loreDir),
                schemaChangeAudit: new SchemaChangeAuditLogger(loreDir),
                exceptionQueue: new ClassificationExceptionQueue(loreDir),
                syncGuard: new SyncDirectionGuard(),
                conflictLog: new ConflictLog(loreDir),
            };
            const { host, tools } = makeHost();
            registerPhaseATools(host, ctx);
            const result = await call(tools, 'schema_approve', { sandboxId: 'nope', approver: 'rafi', workspace: 'ws' });
            assert.equal(result.isError, true);
            assert.match(result.content[0].text, /not found|failed/);
        });
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('test runner crashed:', err);
    process.exit(1);
});

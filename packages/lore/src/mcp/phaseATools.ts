/**
 * phaseATools.ts — MCP tool registration for V3.0-Personal Phase A.
 *
 * One module that wires every Phase A capability into the MCP surface.
 * The single call site (`registerPhaseATools`) is invoked from
 * `mcp/server.ts` after the core graph + audit objects are built.
 * Keeping this in its own module lets us test the tool surface
 * without booting the 6,800-line server file.
 *
 * Registered tools:
 *
 *   schema_get              read live schema (full structured)
 *   schema_summary          read live schema (one-line summary)
 *   schema_propose          submit a schema change for review
 *   schema_approve          approve a sandbox proposal
 *   schema_reject           reject a sandbox proposal
 *   schema_list_proposals   list pending sandbox proposals
 *   schema_history          list available rollback snapshots
 *   schema_rollback         restore a previous snapshot
 *
 *   audit_classifications   query classification audit log
 *   audit_schema_changes    query schema-change audit log
 *
 *   exception_queue_list    list open exceptions awaiting review
 *   exception_queue_resolve resolve an exception
 *
 *   sync_policy_get         current per-workspace sync policies
 *   conflict_log_list       multi-master conflict log entries
 *
 * Tools return MCP-style content blocks (text JSON). Errors surface
 * as `isError: true` content per the MCP convention.
 */

import { z, type ZodTypeAny } from 'zod';

import { describeSchema, summarizeSchema } from '../schemas/describe.js';
import {
    SchemaAuthoringStore,
    buildProposal,
    type ProposedChange,
} from '../schemas/authoring.js';
import type { LoreSchemaV2, NodeTypeSpec } from '../schemas/types.js';
import { ClassificationAuditLogger } from '../security/classificationAudit.js';
import { SchemaChangeAuditLogger } from '../security/schemaChangeAudit.js';
import { ClassificationExceptionQueue } from '../security/classificationExceptionQueue.js';
import { SyncDirectionGuard } from '../security/syncDirectionGuard.js';
import { ConflictLog } from '../engines/multiMasterSync.js';
import { assertMcpScope, type McpScopeMode } from './tools/mcpScope.js';
import { getCurrentPrincipal } from '../auth/principal.js';
import { gateSchemaApproval, SCHEMA_APPROVE_OPERATION } from '../security/schemaApprovalGate.js';
import type { PendingOpsStore } from '../security/pendingOps.js';

/** Minimal MCP server surface this module needs. Lets us test without booting the real server. */
export interface PhaseAToolHost {
    tool(
        name: string,
        description: string,
        inputSchema: Record<string, ZodTypeAny>,
        handler: (args: Record<string, unknown>) => Promise<{
            content: Array<{ type: 'text'; text: string }>;
            isError?: boolean;
        }>,
    ): void;
}

export interface PhaseAContext {
    schemaLoader: { getV2(): LoreSchemaV2 };
    /** Optional setter so tools can update the loader after approving a schema change. */
    onSchemaChanged?: (next: LoreSchemaV2) => void;
    schemaAuthoring: SchemaAuthoringStore;
    classificationAudit: ClassificationAuditLogger;
    schemaChangeAudit: SchemaChangeAuditLogger;
    exceptionQueue: ClassificationExceptionQueue;
    syncGuard: SyncDirectionGuard;
    conflictLog: ConflictLog;
    /**
     * GAP 1 (2026-08-17, MCP follow-up) — HITL queue. Threaded the same way
     * as the HTTP route's `deps.pendingOpsStore`: REQUIRED for destructive
     * schema_approve calls (refused with a clear error when absent), unused
     * for additive ones. Optional here only because tests that don't
     * exercise destructive changes can omit it.
     */
    pendingOpsStore?: PendingOpsStore;
    /** GAP 1 (2026-08-17, MCP follow-up) — the boot-bound schema workspace
     *  (mirrors the HTTP route's `deps.schemaWorkspace`; production wires
     *  `detectedScope.workspace`), stamped on enqueued HITL approval rows. */
    schemaWorkspace?: string;
    /**
     * ITEM 3 (launch-fixes-2026-08) — the instance's full run mode
     * (`LoreInstance.runMode`; same inline-union rationale as
     * `SchemaApprovalGateInput.runMode` — this module is imported by
     * createMcpServer.ts, so importing mcp/server.ts's type would cycle).
     * Threaded into the mandatory-HITL gate so 'embedded' refuses
     * destructive schema_approve AT PROPOSAL TIME instead of enqueueing
     * an op no embedded host can ever decide (no HTTP transport).
     * Optional only for pre-existing test harnesses; production wires
     * `deps.runMode` from createMcpServer.ts.
     */
    runMode?: 'local' | 'cloud' | 'embedded' | 'arcade';
}

/** Helper — wrap a JSON-serializable result into the MCP text content shape. */
function ok(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Helper — wrap an error into the MCP error shape. */
function err(message: string): {
    content: Array<{ type: 'text'; text: string }>;
    isError: true;
} {
    return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Sprint L1e — workspace_required guard. Returns the canonical MCP
 * error envelope (mirrors REST 400 shape) when callers omit the
 * workspace argument. Every Phase A tool requires workspace per the
 * Lore-as-database principle.
 */
function workspaceRequiredEnvelope(): {
    content: Array<{ type: 'text'; text: string }>;
    isError: true;
} {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name> as a tool argument' }, null, 2) }],
        isError: true,
    };
}

function isMissingWorkspace(args: Record<string, unknown>): boolean {
    const ws = args['workspace'];
    return !ws || typeof ws !== 'string' || (ws as string).length === 0;
}

/**
 * SP-01 (RETRY) — combined workspace gate for Phase A tools.
 *
 * phaseATools.ts is registered unconditionally from createMcpServer.ts and
 * its 14 workspace-targeting handlers read `args['workspace']` (bracket
 * notation, outside tools/), so the original SP-01 grep sweep missed them.
 * This left a proven cross-workspace read/write leak: a workspace-A app
 * token could query/mutate workspace B through every Phase A tool.
 *
 * `gateWorkspace` runs the existing workspace_required check, then defers
 * to the shared `assertMcpScope(workspace, mode)` (the same gate the
 * tools/ handlers use) BEFORE any storage/resolution call. Returns the MCP
 * error envelope to return as-is, or `null` when the call is permitted.
 * Reads are classified mode='read'; mutations mode='write'.
 */
function gateWorkspace(
    args: Record<string, unknown>,
    mode: McpScopeMode,
): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
    if (isMissingWorkspace(args)) return workspaceRequiredEnvelope();
    const denied = assertMcpScope(args['workspace'] as string, mode);
    if (denied) return denied as { content: Array<{ type: 'text'; text: string }>; isError: true };
    return null;
}

const workspaceFieldZ = z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).');

/** Build a minimal `addNodeType` proposal change record from a NodeTypeSpec. */
function changeForNodeAdd(spec: NodeTypeSpec): ProposedChange {
    return {
        kind: 'node_type.added',
        target: spec.name,
        migration: 'lazy',
        after: spec,
    };
}

export function registerPhaseATools(host: PhaseAToolHost, ctx: PhaseAContext): void {
    /* ---------- schema-as-data ---------- */

    host.tool(
        'schema_get',
        'Return the full structured description of the live workspace schema.',
        { workspace: workspaceFieldZ },
        async (args) => {
            const gate = gateWorkspace(args, 'read');
            if (gate) return gate;
            return ok(describeSchema(ctx.schemaLoader.getV2()));
        },
    );

    host.tool(
        'schema_summary',
        'Return a one-line human/AI-readable summary of the live workspace schema.',
        { workspace: workspaceFieldZ },
        async (args) => {
            const gate = gateWorkspace(args, 'read');
            if (gate) return gate;
            return ok({ summary: summarizeSchema(ctx.schemaLoader.getV2()) });
        },
    );

    /* ---------- schema authoring ---------- */

    host.tool(
        'schema_propose',
        'Submit a proposed schema change. Most-common case: add a new node type. Returns the sandbox id.',
        {
            proposedBy: z.string().describe('Subject id of the proposer (e.g., "ai:gemma" or "human:rafi").'),
            note: z.string().optional().describe('Free-form note shown to the approver.'),
            addNodeType: z.object({
                name: z.string(),
                description: z.string(),
                kind: z.enum(['episodic', 'factual']),
                fields: z.array(z.object({
                    name: z.string(),
                    type: z.enum(['string', 'number', 'boolean', 'datetime', 'json', 'embedding']),
                    required: z.boolean().optional(),
                })).optional(),
            }).optional().describe('Add a new know.* / mem.* node type to the workspace.'),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const gate = gateWorkspace(args, 'write');
                if (gate) return gate;
                const live = ctx.schemaLoader.getV2();
                if (!args.addNodeType) {
                    return err('schema_propose: only addNodeType is supported in this MCP tool. Use SchemaAuthoringStore.propose() directly for richer changes.');
                }
                const spec = args.addNodeType as NodeTypeSpec;
                const proposal = buildProposal({
                    base: live,
                    changes: [changeForNodeAdd(spec)],
                    proposedBy: args.proposedBy as string,
                    note: args.note as string | undefined,
                    transforms: { addNodeType: spec },
                });
                const sandbox = await ctx.schemaAuthoring.propose(proposal);
                return ok({
                    sandboxId: sandbox.sandboxId,
                    proposedAt: sandbox.proposedAt,
                    // Phase 3 item 1 — surface blast radius so the
                    // approver sees affected-row counts upfront.
                    ...(sandbox.blastRadius ? { blastRadius: sandbox.blastRadius } : {}),
                });
            } catch (e) { return err(`schema_propose failed: ${(e as Error).message}`); }
        },
    );

    host.tool(
        'schema_list_proposals',
        'List pending schema proposals awaiting review.',
        { workspace: workspaceFieldZ },
        async (args) => {
            const gate = gateWorkspace(args, 'read');
            if (gate) return gate;
            return ok(ctx.schemaAuthoring.listProposals());
        },
    );

    host.tool(
        'schema_approve',
        'Approve a sandbox proposal; writes the new live schema, snapshots the prior, audits the change. ' +
        'Destructive changes REQUIRE the second-party HITL queue: this call enqueues them (queued:true + ' +
        'pendingOpId) instead of applying immediately — the change only takes effect after a separate, ' +
        'explicit POST /api/approvals/{id}/decision confirmation. Additive changes apply immediately. ' +
        'In embedded deployments (no HTTP transport) destructive approvals are REFUSED at proposal time ' +
        '(destructive_hitl_unavailable_embedded) — approve them against the local daemon instead.',
        {
            sandboxId: z.string(),
            approver: z.string().optional().describe('Used only when no authenticated principal is bound (legacy/no-auth); otherwise ignored in favor of the bound principal.'),
            note: z.string().optional(),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const gate = gateWorkspace(args, 'write');
                if (gate) return gate;

                // GAP 1 (2026-08-17, MCP follow-up) — bind approver to the
                // AUTHENTICATED principal exactly like the HTTP route
                // (proposals.ts). A client-supplied args.approver is only a
                // fallback for legacy/no-auth callers with no bound
                // principal at all — never used to override one.
                const principal = getCurrentPrincipal();
                const approver = principal?.label
                    ? `${principal.kind === 'bootstrap' ? 'human' : 'system'}:${principal.label}`
                    : (typeof args.approver === 'string' && args.approver.length > 0 ? args.approver : null);
                if (!approver) {
                    return err('schema_approve failed: no authenticated principal bound and no approver supplied');
                }

                const sandboxId = args.sandboxId as string;
                const entry = ctx.schemaAuthoring.getProposal(sandboxId);
                if (!entry) {
                    return err(`schema_approve failed: proposal '${sandboxId}' not found`);
                }

                // GAP 1 (2026-08-17, MCP follow-up) — the SAME mandatory-HITL
                // gate the HTTP route runs through (security/schemaApprovalGate.ts).
                // This tool previously called ctx.schemaAuthoring.approve()
                // directly — no destructive check, no queue requirement — the
                // exact scenario GAP 1 was meant to eliminate, and the ONLY
                // reachable path in embedded deployments (no HTTP port).
                const note = args.note as string | undefined;
                const gateOutcome = await gateSchemaApproval({
                    proposal: entry.proposal,
                    sandboxId,
                    approver,
                    note,
                    workspaceId: ctx.schemaWorkspace ?? 'default',
                    pendingOpsStore: ctx.pendingOpsStore,
                    runMode: ctx.runMode,
                });
                if (gateOutcome.kind === 'refused') {
                    // Surface the gate's structured code in the text envelope
                    // (MCP has no separate code field) so the refusal is
                    // grep-able and matches the HTTP route's 503 body code.
                    return err(`schema_approve failed: [${gateOutcome.code}] ${gateOutcome.message}`);
                }
                if (gateOutcome.kind === 'enqueued') {
                    return ok({
                        queued: true,
                        pendingOpId: gateOutcome.pendingOp.id,
                        operation: SCHEMA_APPROVE_OPERATION,
                        sandboxId,
                        rationale: gateOutcome.rationale,
                    });
                }

                const receipt = await ctx.schemaAuthoring.approve(sandboxId, approver, note);
                if (ctx.onSchemaChanged) {
                    try { ctx.onSchemaChanged(ctx.schemaLoader.getV2()); }
                    catch { /* downstream consumer error must not roll back the approval */ }
                }
                return ok(receipt);
            } catch (e) { return err(`schema_approve failed: ${(e as Error).message}`); }
        },
    );

    host.tool(
        'schema_reject',
        'Reject a sandbox proposal. Live schema is unchanged; rejection is logged.',
        {
            sandboxId: z.string(),
            reviewer: z.string(),
            reason: z.string(),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const gate = gateWorkspace(args, 'write');
                if (gate) return gate;
                const rec = ctx.schemaAuthoring.reject(
                    args.sandboxId as string,
                    args.reviewer as string,
                    args.reason as string,
                );
                return ok(rec);
            } catch (e) { return err(`schema_reject failed: ${(e as Error).message}`); }
        },
    );

    host.tool(
        'schema_history',
        'List available rollback snapshots (filenames).',
        { workspace: workspaceFieldZ },
        async (args) => {
            const gate = gateWorkspace(args, 'read');
            if (gate) return gate;
            return ok(ctx.schemaAuthoring.listHistory());
        },
    );

    host.tool(
        'schema_rollback',
        'Restore a previous schema snapshot. Reversible — current state is snapshotted before the rollback.',
        {
            historyFileName: z.string(),
            actor: z.string(),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const gate = gateWorkspace(args, 'write');
                if (gate) return gate;
                ctx.schemaAuthoring.rollback(args.historyFileName as string, args.actor as string);
                if (ctx.onSchemaChanged) {
                    try { ctx.onSchemaChanged(ctx.schemaLoader.getV2()); } catch { /* ignore */ }
                }
                return ok({ restored: args.historyFileName });
            } catch (e) { return err(`schema_rollback failed: ${(e as Error).message}`); }
        },
    );

    /* ---------- audit logs ---------- */

    host.tool(
        'audit_classifications',
        'Query the classification audit log.',
        {
            sinceIso: z.string().optional(),
            untilIso: z.string().optional(),
            workspace: workspaceFieldZ,
            decidedByPrefix: z.string().optional(),
            outcome: z.enum(['routed', 'queued-exception', 'dropped']).optional(),
            limit: z.number().optional(),
        },
        async (args) => {
            const gate = gateWorkspace(args, 'read');
            if (gate) return gate;
            return ok(ctx.classificationAudit.list(args as Parameters<ClassificationAuditLogger['list']>[0]));
        },
    );

    host.tool(
        'audit_schema_changes',
        'Query the schema-change audit log.',
        {
            sinceIso: z.string().optional(),
            untilIso: z.string().optional(),
            workspace: workspaceFieldZ,
            kind: z.string().optional(),
            targetPrefix: z.string().optional(),
            limit: z.number().optional(),
        },
        async (args) => {
            const gate = gateWorkspace(args, 'read');
            if (gate) return gate;
            return ok(ctx.schemaChangeAudit.list(args as Parameters<SchemaChangeAuditLogger['list']>[0]));
        },
    );

    /* ---------- exception queue ---------- */

    host.tool(
        'exception_queue_list',
        'List open classification exceptions awaiting review.',
        {
            workspace: workspaceFieldZ,
            limit: z.number().optional(),
        },
        async (args) => {
            const gate = gateWorkspace(args, 'read');
            if (gate) return gate;
            return ok(ctx.exceptionQueue.listOpen(args as { workspace?: string; limit?: number }));
        },
    );

    host.tool(
        'exception_queue_resolve',
        'Resolve an open exception (route / reroute / drop / defer).',
        {
            entryId: z.string(),
            resolvedBy: z.string(),
            decision: z.enum(['route', 'reroute', 'drop', 'defer']),
            finalKind: z.enum(['episodic', 'factual']).optional(),
            finalNodeType: z.string().optional(),
            reason: z.string().optional(),
            note: z.string().optional(),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            try {
                const gate = gateWorkspace(args, 'write');
                if (gate) return gate;
                const rec = ctx.exceptionQueue.resolve({
                    entryId: args.entryId as string,
                    resolvedAt: new Date().toISOString(),
                    resolvedBy: args.resolvedBy as string,
                    decision: args.decision as 'route' | 'reroute' | 'drop' | 'defer',
                    finalKind: args.finalKind as 'episodic' | 'factual' | undefined,
                    finalNodeType: args.finalNodeType as string | undefined,
                    reason: args.reason as string | undefined,
                    note: args.note as string | undefined,
                });
                return ok(rec);
            } catch (e) { return err(`exception_queue_resolve failed: ${(e as Error).message}`); }
        },
    );

    /* ---------- sync ---------- */

    host.tool(
        'sync_policy_get',
        'Return per-workspace sync policies (local-first vs cloud-only).',
        { workspace: workspaceFieldZ },
        async (args) => {
            const gate = gateWorkspace(args, 'read');
            if (gate) return gate;
            return ok(ctx.syncGuard.list());
        },
    );

    host.tool(
        'conflict_log_list',
        'List multi-master sync conflict entries.',
        {
            nodeId: z.string().optional(),
            sinceIso: z.string().optional(),
            limit: z.number().optional(),
            workspace: workspaceFieldZ,
        },
        async (args) => {
            const gate = gateWorkspace(args, 'read');
            if (gate) return gate;
            return ok(ctx.conflictLog.list(args as Parameters<ConflictLog['list']>[0]));
        },
    );
}

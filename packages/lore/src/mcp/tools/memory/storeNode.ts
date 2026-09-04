/**
 * storeNode.ts — the store_node MCP tool.
 *
 * Upsert a knowledge node, then fan out to verbatim (LanceDB) under the
 * canonical `lore:<id>` key, the WAL (sync buffer), and the auto-link hook
 * (reconnectOneNode). Runs the Phase 6 strict-field + workspace + vocab-
 * policy gates before any write, and (Feature 8) records a version /
 * buffers into an open changeset when wired.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    STORE_NODE_KNOWN_FIELDS,
    checkUnknownFields,
    type VocabCheckResult,
} from '../../../engines/vocabPolicy.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from '../workspaceResolve.js';
import { assertMcpScope } from '../mcpScope.js';
import { assertSafeLanceId } from '../../../engines/verbatimHistory.js';
import { tagsToArray } from '../../../engines/normalizeTags.js';
import { nodeUpsert, resolveAutolinkHandles, resolveVocabVerdict } from '../../../core/nodeService.js';
// 1.1 (2026-08-17 audit) — retry SurrealDB transaction-conflict write drops
// (same wrapper bulkIngest already uses; no-op for engines that serialize
// writes internally).
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';
import { checkWorkspaceQuota, bumpNodeWriteQuota } from '../../../security/workspaceQuota.js';
import { mcpToolError } from '../mcpToolError.js';
import { redactError } from '../../../security/logRedact.js';
import { log } from '../../../logger.js';
import { MAX_NODE_FIELD_BYTES } from '../../../engines/nodeFieldLimits.js';
import type { MemoryToolsDeps } from './types.js';

/* ─── Phase 6 P2 — vocab + strict-field response shapers ───────── */

interface UnknownFieldError {
    error: 'unknown_field';
    rejected: string[];
    hint: string | null;
    known: ReadonlyArray<string>;
}

function unknownFieldEnvelope(
    rejected: string[],
    hint: string | null,
    known: ReadonlyArray<string>,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    const payload: UnknownFieldError = { error: 'unknown_field', rejected, hint, known };
    const friendly = hint
        ? `unknown_field: ${rejected.join(', ')} — Did you mean: ${hint}?`
        : `unknown_field: ${rejected.join(', ')}`;
    return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, message: friendly }, null, 2) }],
        isError: true,
    };
}

function vocabRejectionEnvelope(
    v: VocabCheckResult,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                error: 'type_not_allowed',
                reason: v.reason,
                ...(v.hint ? { hint: v.hint } : {}),
            }, null, 2),
        }],
        isError: true,
    };
}

export function registerStoreNodeTool(mcpServer: McpServer, deps: MemoryToolsDeps): void {
    mcpServer.tool(
        'store_node',
        `Create or update a knowledge node within the ${deps.domain} domain`,
        {
            id: z.string().describe('Unique identifier (e.g., "baas-body-stream-fix")'),
            type: deps.nodeTypesEnum.describe(`Node type (options: ${deps.nodeTypesDescription})`),
            label: z.string().max(MAX_NODE_FIELD_BYTES).describe('Human-readable title'),
            content: z.string().max(MAX_NODE_FIELD_BYTES).optional().describe('Full text content'),
            tags: z.union([z.string(), z.array(z.string())]).optional().describe('Tags as an array (preferred — e.g., ["platform","baasclient","error-handling"]) or comma-separated string (back-compat, will be removed)'),
            metadata: z.string().max(MAX_NODE_FIELD_BYTES).optional().describe('JSON metadata (e.g., {"date":"2026-03-25","author":"team"})'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1b: no silent fallback).'),
            ecosystem: z.string().optional().describe('Ecosystem scope (auto-detected if omitted).'),
            language: z.string().optional().describe('ISO 639-1 language code (e.g., "en", "es", "ja"). Optional — caller tags explicitly when known. Omit to leave unknown (treated as default / English downstream). See detect_language tool.'),
            ephemeral: z.boolean().optional().describe('Fix #5: when true, this is a short-lived scratchpad node (working memory for a multi-step task). Auto-pruned when ttl_ms elapses. Never surfaces in normal recall. Use for intermediate state that should not pollute permanent memory.'),
            ttl_ms: z.number().optional().describe('Fix #5: time-to-live in milliseconds for ephemeral nodes. Default: 3600000 (1 hour). Ignored when ephemeral is false or omitted.'),
            async_embed: z.boolean().optional().describe('Architecture gap #2: when true, skip the synchronous embed-and-mirror step. The node lands in the graph immediately and embedding catches up in the background via the embed queue. The consistency sweeper heals any drift. Defaults to false — bulk-writers opt in; interactive callers that need immediate semantic searchability leave it off.'),
            embed: z.boolean().optional().describe('Sprint W W1: when explicitly false, skip embedding entirely — graph row only, no lancedb write, no semantic recall surface. Defaults to true (current behavior). Use for nodes that exist purely for graph traversal (e.g. relationship-only link nodes) where vector embedding would be a perf cost with no recall benefit. Distinct from async_embed which still writes (just later).'),
            evidence: z.string().max(MAX_NODE_FIELD_BYTES).optional().describe('Feature 4: source attribution for this node\'s content. Free text or JSON-serialized Record<string,string>. Example: \'{"url":"https://...","captured_at":"2026-05-26"}\'. Redactable via the redact_evidence tool.'),
            anchors: z.string().max(MAX_NODE_FIELD_BYTES).optional().describe('Feature 6: JSON-serialized array of external anchor references this node is grounded in. Format: \'[{"type":"url","ref":"https://..."},{"type":"node","ref":"decision-xyz"}]\'. Used by check_anchors to verify freshness.'),
            changeset_id: z.string().optional().describe('Feature 8: when provided, buffer this write into the open changeset instead of applying it immediately. Obtain a changeset_id from begin_changeset. Apply all buffered writes atomically via commit_changeset.'),
            validFrom: z.string().optional().describe('Bi-temporal: ISO 8601 timestamp when this fact became true in the real world (valid-time), distinct from createdAt (when Lore recorded it). Omit if unknown/not applicable — a node with no validFrom/validUntil is always valid. Core never infers or sets this.'),
            validUntil: z.string().optional().describe('Bi-temporal: ISO 8601 timestamp when this fact stopped being true in the real world. Omit while still valid. Core never infers or sets this — deciding a fact is superseded is an application-layer judgment.'),
        },
        async (args) => {
            // NW-5b — audit-coverage. Pre-fix, store_node — the primary
            // write — was NOT emitting an audit row. Capture timing +
            // outcome around the whole handler so every invocation
            // (success, error, gate-rejection, vocab-rejection) gets
            // exactly one audit entry with the resolved workspace +
            // node id when known. Failures inside the audit path must
            // never fail the tool call — see the catch in the finally.
            const __auditStartedAt = Date.now();
            const __auditCtx: { workspace: string | null; nodeId: string | null; resultDetail?: string; errored: boolean } = {
                workspace: (typeof args.workspace === 'string' ? args.workspace : null),
                nodeId: (typeof args.id === 'string' ? args.id : null),
                errored: false,
            };
            try {
                // Phase 6 P2 — strict additionalProperties:false. The MCP
                // SDK's default Zod parse silently strips unknown keys
                // (e.g. `project: "developer"` got dropped on its way
                // to the handler, masking the bug). The check here
                // catches the residual extras when callers bypass the
                // SDK strip (direct handler invocation, HTTP-body
                // forwarding); the HTTP route layer enforces the same
                // contract on raw JSON before this point.
                const unknown = checkUnknownFields(args, STORE_NODE_KNOWN_FIELDS);
                if (!unknown.ok) {
                    __auditCtx.errored = true;
                    __auditCtx.resultDetail = `unknown_field:${unknown.rejected.join(',')}`;
                    return unknownFieldEnvelope(unknown.rejected, unknown.hint, STORE_NODE_KNOWN_FIELDS);
                }

                const id = String(args.id);
                const type = String(args.type);
                const label = String(args.label);
                const content = args.content as string | undefined;
                // Pass 3 — accept string OR string[] off the wire; normalize
                // to the canonical string[] (lowercase/dedupe/cap). Downstream
                // graph + verbatim packers re-normalize defensively.
                const tags = tagsToArray(args.tags as string | string[] | undefined);
                const metadata = args.metadata as string | undefined;
                // SECURITY: node id flows into LanceDB where() predicates.
                // Reject unsafe chars before any write so nodes are never
                // created in a state where they can't be queried or deleted.
                try {
                    assertSafeLanceId(id, 'storeNode');
                } catch (e) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid_node_id', reason: redactError(e) }, null, 2) }], isError: true };
                }
                const workspace = args.workspace as string | undefined;
                // SP-01 — enforce the bound principal's workspace scope
                // before touching any workspace. A token scoped to
                // workspace A must not write to B (or "*") via MCP.
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                const ecosystem = args.ecosystem as string | undefined;
                const language = args.language as string | undefined;
                const ephemeral = args.ephemeral as boolean | undefined;
                const ttl_ms = args.ttl_ms as number | undefined;
                const async_embed = args.async_embed as boolean | undefined;
                const embedFlag = args.embed as boolean | undefined;
                const evidence = args.evidence as string | undefined;
                const anchors = args.anchors as string | undefined;
                const changeset_id = args.changeset_id as string | undefined;
                const validFrom = args.validFrom as string | undefined;
                const validUntil = args.validUntil as string | undefined;
                // W1 — `embed: false` means skip the verbatim/lancedb write
                // entirely. Default (undefined or true) keeps current
                // behavior. We resolve once so every downstream branch
                // sees the same value.
                const skipEmbed = embedFlag === false;

                // Phase 6 P1.C — resolve target graph via the multi-
                // workspace registry. `workspace` (or active when
                // omitted) selects which physical .lore/graph dir gets
                // the upsert. Unknown workspace → MCP tool error with
                // the list of known names, mirroring the HTTP route's
                // 400 workspace_not_found shape.
                const resolved = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope.workspace,
                    workspace,
                );
                if (!resolved.ok) {
                    if ('missing' in resolved) return workspaceRequiredEnvelope();
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                error: 'workspace_not_found',
                                requested: resolved.requested,
                                known: resolved.known,
                            }, null, 2),
                        }],
                        isError: true,
                    };
                }
                const targetGraph = resolved.graph;
                const scopedWorkspace = resolved.resolvedWorkspace;
                const scopedEcosystem = ecosystem ?? deps.detectedScope.ecosystem;
                // NW-5b — refine audit ctx with the resolved (post-
                // principal-default) workspace so the audit row reflects
                // the workspace the write actually targeted, not the
                // raw caller-supplied value.
                __auditCtx.workspace = scopedWorkspace;

                // Phase 6 P2 — workspace vocab policy check. Default
                // policy (no entry) is mode='open' so existing
                // workspaces don't change behavior.
                //   - allowlist/denylist mismatch → reject | hitl | warn
                //     based on `onMismatch`.
                let typeWarning: string | undefined;
                {
                    const verdict = resolveVocabVerdict({
                        workspace: resolved.resolvedWorkspace,
                        type,
                        coreTypes: deps.coreNodeTypes,
                        logPrefix: '[Lore MCP]',
                    });
                    if (verdict.decision === 'reject') {
                        return vocabRejectionEnvelope(verdict.result);
                    }
                    if (verdict.decision === 'hitl') {
                        if (!deps.pendingOpsStore) {
                            return vocabRejectionEnvelope({
                                decision: 'reject',
                                reason: `${verdict.reason} (HITL routing not available — pendingOpsStore not wired in this deployment)`,
                                ...(verdict.hint ? { hint: verdict.hint } : {}),
                            });
                        }
                        const pending = await deps.pendingOpsStore.enqueue({
                            operation: 'store_node',
                            workspaceId: resolved.resolvedWorkspace,
                            initiator: deps.detectedScope.workspace,
                            args: { id, type, label, content, tags, metadata, workspace: scopedWorkspace, ecosystem: scopedEcosystem },
                            enqueueRationale: verdict.reason,
                        });
                        // NW-7f (api-004) — pre-fix this branch returned
                        // `isError:false` so AI callers driving MCP tools
                        // could not distinguish "write committed" from
                        // "write parked pending human review". The
                        // returned `status:'pending_human_review'` field
                        // was buried in a JSON text blob the model has
                        // to parse. Flip the envelope:
                        //   - `isError:true` — MCP protocol-level signal,
                        //     guaranteed visible to every conformant
                        //     client without text-parsing.
                        //   - `code:'pending_review'` — stable, branchable
                        //     identifier alongside the back-compat
                        //     `error:'pending_human_review'` token. AI
                        //     agents key on `code` (short, enum-like)
                        //     while the legacy `status`/`error` fields
                        //     stay populated for existing string-match
                        //     consumers. `pending_op_id` is still the
                        //     follow-up handle.
                        __auditCtx.errored = true;
                        __auditCtx.resultDetail = `pending_review:${pending.id}`;
                        return {
                            content: [{
                                type: 'text' as const,
                                text: JSON.stringify({
                                    code: 'pending_review',
                                    error: 'pending_human_review',
                                    status: 'pending_human_review',
                                    pending_op_id: pending.id,
                                    reason: verdict.reason,
                                    workspace: resolved.resolvedWorkspace,
                                    type,
                                }, null, 2),
                            }],
                            isError: true,
                        };
                    }
                    if (verdict.decision === 'warn') {
                        typeWarning = verdict.reason;
                    }
                }

                // Feature 8: buffer into open changeset (validation already passed).
                if (changeset_id && deps.versionStore) {
                    const cs = deps.versionStore.getChangeset(changeset_id);
                    if (!cs) {
                        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'changeset_not_found', changeset_id }, null, 2) }], isError: true };
                    }
                    if (cs.status !== 'open') {
                        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'changeset_not_open', changeset_id, status: cs.status }, null, 2) }], isError: true };
                    }
                    // SW-06 (B8): seq is allocated atomically inside the store
                    // (MAX(seq)+1 under one txn that also bumps write_count) — no
                    // longer derived from the racy cs.writeCount read above.
                    const seq = deps.versionStore.addChangesetWrite(changeset_id, 'upsert_node', {
                        workspace: scopedWorkspace,
                        nodeData: {
                            id, type, label, content: content ?? '', tags: tags ?? '',
                            project: scopedWorkspace, ecosystem: scopedEcosystem,
                            metadata: metadata ?? '{}', language: language ?? null,
                            ephemeral: ephemeral ?? false, ttl_ms: ttl_ms ?? null,
                            ...(evidence !== undefined ? { evidence } : {}),
                            ...(anchors !== undefined ? { anchors } : {}),
                            ...(validFrom !== undefined ? { validFrom } : {}),
                            ...(validUntil !== undefined ? { validUntil } : {}),
                        },
                    });
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ buffered: true, changeset_id, seq, id, workspace: scopedWorkspace }, null, 2) }] };
                }

                // L-033 — per-workspace write-quota gate. store_node is the
                // primary agent ingestion path; mirror postNode.ts so MCP writes
                // cannot blow past workspace.maxNodes / maxStorageBytes. Use the
                // pure (res-free) checkWorkspaceQuota and shape an MCP error
                // envelope on exceed. No-op when quotaStore / resolver unwired
                // (cloud mode / test fixtures) — same guard as postNode.ts:156.
                if (deps.quotaStore && deps.getWorkspaceEntryForQuota) {
                    const bytes = Buffer.byteLength(label, 'utf8') + Buffer.byteLength(content ?? '', 'utf8');
                    const q = checkWorkspaceQuota(
                        { store: deps.quotaStore, getWorkspaceEntry: deps.getWorkspaceEntryForQuota },
                        scopedWorkspace,
                        { nodes: 1, bytes },
                    );
                    if (!q.allowed) {
                        __auditCtx.errored = true;
                        __auditCtx.resultDetail = `workspace_quota_exceeded:${q.dimension}`;
                        return {
                            content: [{
                                type: 'text' as const,
                                text: JSON.stringify({
                                    error: 'workspace_quota_exceeded',
                                    dimension: q.dimension,
                                    current: q.current,
                                    cap: q.cap,
                                    workspace: scopedWorkspace,
                                }, null, 2),
                            }],
                            isError: true,
                        };
                    }
                }

                // Feature 8: capture previous state for version record.
                const prevNodeForVersion = deps.versionStore ? await targetGraph.getNode(id) : null;

                const nodeData = {
                    id,
                    type,
                    label,
                    content: content ?? '',
                    tags: tags ?? '',
                    project: scopedWorkspace,
                    ecosystem: scopedEcosystem,
                    metadata: metadata ?? '{}',
                    language: language ?? null,
                    ephemeral: ephemeral ?? false,
                    ttl_ms: ttl_ms ?? null,
                    ...(evidence !== undefined ? { evidence } : {}),
                    ...(anchors !== undefined ? { anchors } : {}),
                    ...(validFrom !== undefined ? { validFrom } : {}),
                    ...(validUntil !== undefined ? { validUntil } : {}),
                };

                // W3-SERVICE-LAYER — the guarded write core (outbox-first
                // node.upsert + verbatim fan-out + rollback + WAL + version +
                // autolink) now lives in core/nodeService.nodeUpsert. This
                // handler only resolves the MCP gauntlet (scope, workspace,
                // vocab, changeset above) and shapes the MCP envelope below;
                // the orchestration is identical for HTTP via postNode.ts.
                //
                // 2026-08-17 (functional-correctness 1.4) — resolve the
                // autolink graph + verbatim to the TARGET workspace. Before
                // this fix the hook always hardcoded the BOOT store, which was
                // safe only because nodeService's gate skipped autolink for
                // every non-active workspace — the gate is now gone (it was
                // itself the bug: it made autolink permanently dead for every
                // workspace but the one the daemon booted into), so this
                // resolution is now load-bearing: writing store_node to
                // workspace B must never draw semantic edges into workspace
                // A's boot graph/vector index.
                // 2026-08-19 (launch-readiness item 4) — the resolution moved
                // into core/nodeService.resolveAutolinkHandles, shared with
                // POST /api/node + the embedded wrappers, so the surfaces
                // cannot drift again (the original REST-has-no-autolink bug
                // was exactly that drift).
                const autolink = await resolveAutolinkHandles({
                    bootGraph: deps.store.loreGraph,
                    bootVerbatim: deps.store.loreVerbatim,
                    resolver: deps.workspaceVerbatimResolver,
                    workspace: scopedWorkspace,
                    targetGraph,
                    tracker: deps.store.autolinkTracker,
                });
                const writeResult = await withTransactionConflictRetry(() => nodeUpsert(
                    {
                        id,
                        workspace: scopedWorkspace,
                        ecosystem: scopedEcosystem,
                        nodeData,
                        targetGraph,
                        initiator: 'mcp:store_node',
                        skipEmbed,
                        asyncEmbed: async_embed,
                        isActiveWorkspace: resolved.isActive,
                    },
                    {
                        outboxStore: deps.outboxStore,
                        embedQueue: deps.embedQueue,
                        // Inline verbatim path (no outbox wired): the boot-
                        // bound storage-client facade, as before.
                        verbatim: deps.store.storageClient,
                        // Cloud: write Dataplane now; local leaves this unset.
                        inlineVerbatim: deps.inlineVerbatim,
                        getWal: deps.getWal,
                        versionStore: deps.versionStore,
                        previousState: prevNodeForVersion ?? null,
                        // MCP version records were stamped principal 'mcp'.
                        versionPrincipal: 'mcp',
                        autolink,
                    },
                ));

                if (!writeResult.ok) {
                    return {
                        content: [{ type: 'text' as const, text: `store_node failed: vector store unavailable (${redactError(writeResult.error)}). No partial state retained.` }],
                        isError: true,
                    };
                }
                const node = writeResult.node;

                // L-033 — bump the quota counter only AFTER the substrate write
                // resolved (mirror postNode.ts:205-209 ordering) to avoid
                // counter-up-on-failed-write drift. Same shared store the REST
                // path increments, so the cap is enforceable cross-surface.
                if (deps.quotaStore) {
                    bumpNodeWriteQuota(deps.quotaStore, scopedWorkspace, { label, body: content });
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            node: { id: node.id, type: node.type, label: node.label, project: scopedWorkspace, ecosystem: scopedEcosystem },
                            message: `Node '${id}' stored successfully (project: ${scopedWorkspace}, ecosystem: ${scopedEcosystem}).`,
                            ...(typeWarning ? { _meta: { warning: typeWarning, header: `X-Lore-Type-Warning: ${typeWarning}` } } : {}),
                        }, null, 2),
                    }],
                };
            } catch (error) {
                __auditCtx.errored = true;
                // Audit fix #4: redact the message before it lands in the
                // audit log AND the client envelope — SurrealDB/LanceDB errors can
                // echo node ids/paths/content fragments (findings #4 + #13).
                __auditCtx.resultDetail = redactError(error);
                return mcpToolError('store_node', error, log, `workspace=${__auditCtx.workspace ?? '?'}`);
            } finally {
                // NW-5b — single audit emission for store_node. Never
                // throws (matches AuditLog.log()'s fire-and-log contract).
                try {
                    deps.auditLog.log({
                        toolName: 'store_node',
                        args: { workspace: __auditCtx.workspace, nodeId: __auditCtx.nodeId },
                        result: __auditCtx.errored ? 'error' : 'success',
                        resultDetail: __auditCtx.resultDetail,
                        durationMs: Date.now() - __auditStartedAt,
                    });
                } catch (logErr) {
                    console.error(`[Lore MCP] audit emission failed for store_node: ${(logErr as Error).message}`);
                }
            }
        },
    );
}

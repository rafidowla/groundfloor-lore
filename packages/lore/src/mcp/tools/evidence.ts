/**
 * evidence.ts — Evidence / provenance tools (Feature 4, 2026-05-26).
 *
 * Tools:
 *   redact_evidence — clear the evidence field on a node (GDPR / PII removal)
 *
 * Evidence is stored as a STRING on LoreNode. It can be free text or a
 * JSON-serialized Record<string,string>. This tool redacts it and writes
 * an audit trail so the removal is traceable.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageBundle } from '../services.js';
import type { AuditLog } from '../../security/audit.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { assertMcpScope } from './mcpScope.js';
import { resolveTargetGraph, workspaceRequiredEnvelope } from './workspaceResolve.js';
import { log } from '../../logger.js';
import { mcpToolError } from './mcpToolError.js';
import { withTransactionConflictRetry } from '../../engines/transactionConflictRetry.js';

export interface EvidenceDeps {
    store: StorageBundle;
    auditLog: AuditLog;
    /** Active (boot-bound) workspace — used as the resolver's fallback scope. */
    detectedScope?: { workspace: string; ecosystem: string };
    /**
     * Phase 6 P1.C — multi-workspace LocalGraph registry. When wired,
     * redact_evidence resolves the target graph via the registry so the
     * redaction physically lands in the REQUESTED workspace's store rather
     * than the boot/active one. Optional so cloud mode + test fixtures fall
     * back to `store.loreGraph` (resolveTargetGraph returns the boot store
     * when the registry is absent).
     */
    graphRegistry?: LocalGraphRegistry;
}

export function registerEvidenceTools(server: McpServer, deps: EvidenceDeps): void {

    /* ─── redact_evidence ───────────────────────────────────────── */
    server.tool(
        'redact_evidence',
        'Clear the evidence / provenance field on a node. Used for GDPR compliance, PII removal, or source redaction. Writes an audit log entry for the removal. The node content and all other fields are preserved.',
        {
            id:        z.string().describe('Id of the node whose evidence should be redacted.'),
            workspace: z.string().min(1).describe('Workspace the node lives in.'),
            reason:    z.string().optional().describe('Reason for redaction (stored in the audit log).'),
        },
        async ({ id, workspace, reason }) => {
            try {
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                // Phase 6 P1.C — route the redaction to the REQUESTED
                // workspace's graph. When the registry isn't wired (cloud /
                // tests) resolveTargetGraph returns the boot store, so the
                // no-registry path is unchanged.
                const resolved = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope?.workspace ?? workspace,
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
                const graph = resolved.graph;
                await graph.initialize();

                const node = await graph.getNode(id);
                if (!node) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'node_not_found', id }, null, 2) }], isError: true };
                }

                const prevEvidence = node.evidence ?? null;
                const prevLen = prevEvidence ? prevEvidence.length : 0;

                // Clear the evidence field.
                await withTransactionConflictRetry(() => graph.upsertNode({ ...node, evidence: null }));

                // Write audit log entry (non-fatal if audit fails).
                try {
                    deps.auditLog.log({
                        toolName: 'redact_evidence',
                        args: { id, workspace, reason: reason ?? null },
                        result: 'success' as const,
                        resultDetail: `evidence field cleared (was ${prevLen} chars)`,
                        durationMs: 0,
                    });
                } catch {
                    // Non-fatal — the redaction already succeeded.
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            id,
                            workspace,
                            previous_evidence_length: prevLen,
                            reason: reason ?? null,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('redact_evidence', error, log);
            }
        },
    );
}

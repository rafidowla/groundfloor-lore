/**
 * embeddedAudit.ts — Audit-wiring helper for the embedded createLore() write
 * path (audit fix #1).
 *
 * Before fix #1, embedded nodeUpsert / nodeUpsertBatch left NO entry in
 * audit.jsonl — only the MCP/HTTP transports were audited (via withMcpAudit).
 * The embedded path is the recommended integration path for Atlas et al, so
 * every library write now appends exactly one audit row.
 *
 * The orchestration (resolve graph → upsert → embed → autolink) lives in
 * createLore() in server.ts; this module owns ONLY the "did it succeed?" →
 * "log one row" step so server.ts doesn't carry 70+ lines of repetitive
 * try/log/rethrow per write method.
 *
 * Contract:
 *   - Exactly one row per call (success or error).
 *   - Errors are re-thrown after logging — audit never swallows a failure.
 *   - resultDetail (errors only) is redacted (engines echo ids/paths/content).
 *   - Actor is left to AuditLog's currentUser() fallback (local-mode owner).
 */
import type { AuditLog } from '../security/audit.js';
import { redactError } from '../security/logRedact.js';

export interface EmbeddedAuditContext {
    auditLog: AuditLog;
    toolName: 'lib:nodeUpsert' | 'lib:nodeUpsertBatch';
    workspace: string;
    nodeId: string;
    startedAt: number;
}

/**
 * Append one audit row describing the outcome of an embedded write, then
 * re-throw the original error if the write failed. Returns the success
 * value untouched. Callers MUST ensure `startedAt` was captured before the
 * write began.
 */
export function logEmbeddedWrite<T>(
    ctx: EmbeddedAuditContext,
    result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
    const durationMs = Date.now() - ctx.startedAt;
    try {
        if (result.ok) {
            ctx.auditLog.log({
                toolName: ctx.toolName,
                args: { workspace: ctx.workspace, nodeId: ctx.nodeId },
                result: 'success',
                durationMs,
            });
            return result.value;
        }
        ctx.auditLog.log({
            toolName: ctx.toolName,
            args: { workspace: ctx.workspace, nodeId: ctx.nodeId },
            result: 'error',
            resultDetail: redactError(result.error),
            durationMs,
        });
    } catch {
        /* audit never throws on the write path */
    }
    if (!result.ok) throw result.error;
    // Unreachable: the ok branch returns above. Satisfies the type checker.
    return (result as { ok: true; value: T }).value;
}

/**
 * arcadePolicy.ts — operator-only control-plane routes for per-cell vocab
 * policy (spike/arcadedb-multitenant, Slice 4).
 *
 *   GET    /api/arcade/apps/:tenantId/:appId/policy   get-cell-policy
 *   PUT    /api/arcade/apps/:tenantId/:appId/policy   set-cell-policy (audited)
 *   DELETE /api/arcade/apps/:tenantId/:appId/policy   clear-cell-policy (audited)
 *
 * SECURITY: policy is a CONTROL-PLANE object. These routes gate through
 * bindDaemonOperatorLane exactly like arcadeAdmin — a tenant `lore_at_*` bearer
 * never reaches here (arcadeBoot's requireOperatorPrincipal walls it off before
 * dispatch, and the lane check denies it even if it slipped through). Tenant
 * tokens cannot read or write policy.
 *
 * onMismatch:'hitl' is REJECTED at SET time (400 policy_mode_not_supported):
 * the arcade daemon wires no PendingOpsStore, so a hitl policy would 503 every
 * write. Reject the unsupported mode loudly at configuration time instead.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditLog } from '../../../security/audit.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeJson, writeError } from '../helpers.js';
import { getTenantApp } from '../../../engines/arcade/arcadeProvisioner.js';
import {
    getCellVocabPolicy,
    setCellVocabPolicy,
    deleteCellVocabPolicy,
    CellPolicyUnsupportedError,
} from '../../../engines/arcade/arcadeCellPolicy.js';
import type { WorkspaceVocabPolicy } from '../../../config/workspaces.js';

export interface ArcadePolicyDeps {
    auditLog?: AuditLog;
}

const ID_RE = /^[a-z0-9]+$/;

function auditPolicy(
    deps: ArcadePolicyDeps,
    op: string,
    args: Record<string, unknown>,
    result: 'success' | 'error',
    resultDetail?: string,
): void {
    if (!deps.auditLog) return;
    deps.auditLog.log({ toolName: `arcade.policy.${op}`, args, result, resultDetail, durationMs: 0 });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBoundedBody(req);
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, unknown>;
}

function invalidIdentifier(res: ServerResponse, which: string): true {
    writeError(res, 400, 'invalid_identifier', `${which} must match ${ID_RE} (lowercase alphanumeric only)`);
    return true;
}

/**
 * tryArcadePolicyRoutes — mounts the /api/arcade/apps/:t/:a/policy family.
 * Returns true when it OWNED the request, false to fall through to the next
 * operator-route family (arcadeAdmin).
 */
export async function tryArcadePolicyRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    deps: ArcadePolicyDeps,
): Promise<boolean> {
    // Only /api/arcade/apps/:t/:a/policy — everything else is not ours.
    const m = /^\/api\/arcade\/apps\/([^/]+)\/([^/]+)\/policy$/.exec(pathname);
    if (!m) return false;
    const method = req.method ?? 'GET';
    const tenantId = m[1] ?? '';
    const appId = m[2] ?? '';

    try {
        if (!ID_RE.test(tenantId)) return invalidIdentifier(res, 'tenantId');
        if (!ID_RE.test(appId)) return invalidIdentifier(res, 'appId');

        if (method === 'GET') {
            if (!bindDaemonOperatorLane(res, { intent: 'read' })) return true;
            const cell = getTenantApp({ customerId: tenantId, appId });
            if (!cell) {
                writeError(res, 404, 'workspace_not_found', `cell (${tenantId}, ${appId}) not found`);
                return true;
            }
            const policy = getCellVocabPolicy(tenantId, appId);
            writeJson(res, 200, { tenantId, appId, policy });
            return true;
        }

        if (method === 'PUT') {
            if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
            const cell = getTenantApp({ customerId: tenantId, appId });
            if (!cell) {
                writeError(res, 404, 'workspace_not_found', `cell (${tenantId}, ${appId}) not found`);
                return true;
            }
            const body = await readJson(req);
            const requested: WorkspaceVocabPolicy = {
                mode: body['mode'] as WorkspaceVocabPolicy['mode'],
                ...(Array.isArray(body['types']) ? { types: (body['types'] as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
                onMismatch: body['onMismatch'] as WorkspaceVocabPolicy['onMismatch'],
            };
            try {
                const saved = setCellVocabPolicy(tenantId, appId, requested);
                auditPolicy(deps, 'set', { tenantId, appId, mode: saved.mode, onMismatch: saved.onMismatch }, 'success');
                writeJson(res, 200, { tenantId, appId, policy: saved });
            } catch (err) {
                if (err instanceof CellPolicyUnsupportedError) {
                    auditPolicy(deps, 'set', { tenantId, appId }, 'error', err.message);
                    writeError(res, 400, 'policy_mode_not_supported', err.message);
                    return true;
                }
                if (err instanceof Error && /Invalid vocabPolicy/.test(err.message)) {
                    auditPolicy(deps, 'set', { tenantId, appId }, 'error', err.message);
                    writeError(res, 400, 'invalid_policy', err.message);
                    return true;
                }
                throw err;
            }
            return true;
        }

        if (method === 'DELETE') {
            if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
            deleteCellVocabPolicy(tenantId, appId);
            auditPolicy(deps, 'delete', { tenantId, appId }, 'success');
            writeJson(res, 200, { tenantId, appId, cleared: true });
            return true;
        }

        writeError(res, 405, 'method_not_allowed', `${method} not allowed on ${pathname}`);
        return true;
    } catch (err) {
        if (isPayloadTooLarge(err)) {
            writeOversizeError(res, req);
            return true;
        }
        if (err instanceof SyntaxError) {
            writeError(res, 400, 'invalid_json', 'request body is not valid JSON');
            return true;
        }
        writeError(res, 500, 'arcade_policy_error', err instanceof Error ? err.message : String(err));
        return true;
    }
}

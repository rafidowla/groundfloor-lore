/**
 * arcadeAdmin.ts — operator-only control-plane routes for the db-per-app
 * ArcadeDB backend (spike/arcadedb-multitenant, slice 2 W2).
 *
 * These are the DAEMON-WIDE onboarding verbs an operator uses to stand up,
 * credential, and tear down tenant apps WITHOUT running tsx scripts:
 *
 *   POST   /api/arcade/apps                                  provision-app
 *   GET    /api/arcade/apps                                  list-apps
 *   POST   /api/arcade/apps/:customerId/:appId/tokens        issue-token
 *   POST   /api/arcade/apps/:customerId/:appId/tokens/list   list-tokens
 *   POST   /api/arcade/apps/:customerId/:appId/tokens/rotate rotate-token (Slice-4)
 *   POST   /api/arcade/tokens/revoke                         revoke-token
 *   POST   /api/arcade/apps/:customerId/:appId/disable       disable-app (phase 1)
 *   DELETE /api/arcade/apps/:customerId/:appId               destroy-app (phase 2)
 *
 * SECURITY MODEL (the wall this file EXISTS to make real, not a comment):
 *   - Every route's first act after path match is `bindDaemonOperatorLane`
 *     with the operator intent. That helper admits ONLY the bootstrap /
 *     shared-secret daemon principal (or an app token holding
 *     cross-workspace-write). A tenant `lore_at_*` bearer is not a daemon
 *     principal — in arcade mode the listener's gate rejects it before it
 *     ever reaches this file (arcadeBoot's requireOperatorPrincipal), and
 *     even if it slipped through, the lane check denies it 403. The tenant
 *     token can NEVER reach these verbs.
 *   - D-021 compliant: this file imports NEITHER requireWriteToWorkspace NOR
 *     requireReadFromWorkspace. It gates exclusively through
 *     bindDaemonOperatorLane (the operator lane), which is the sanctioned
 *     gate for genuinely daemon-wide operator ops that name no workspace.
 *   - No `res.headersSent` discriminator anywhere: denial helpers return a
 *     boolean and the caller `return true`s.
 *
 * The file is parse -> gate -> delegate -> envelope -> audit ONLY. All
 * provisioning/token logic lives in the provisioner + auth resolver modules,
 * keeping this under the 500-line budget.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditLog } from '../../../security/audit.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import {
    readBoundedBody,
    isPayloadTooLarge,
    writeOversizeError,
    writeJson,
    writeError,
} from '../helpers.js';
import {
    provisionApp,
    disableApp,
    destroyApp,
    getTenantApp,
    listTenantApps,
} from '../../../engines/arcade/arcadeProvisioner.js';
import {
    issueToken,
    revokeToken,
    hashToken,
    listTokensForCell,
    ArcadeAuthError,
} from '../../../engines/arcade/arcadeAuthResolver.js';
import { rotateToken } from '../../../engines/arcade/arcadeTokenLifecycle.js';
import { CellLeaseHeldError } from '../../../engines/arcade/arcadeCellLease.js';
import type { Scope } from '../../../engines/arcade/arcadeScopeGuard.js';

export interface ArcadeAdminDeps {
    /** Daemon-wide audit log (audit.jsonl, hash-chained). Every control-plane
     *  op is recorded with operator identity + tenant/app + outcome — NEVER a
     *  password, NEVER a token plaintext (only an 8-char token-hash prefix). */
    auditLog?: AuditLog;
    /** Slice 3 — data-plane cell-pool eviction hooks. When wired, a revoke
     *  evicts that token's cached facade and a disable/destroy evicts every
     *  token bound to the cell, so a credential change fails closed on the NEXT
     *  data request (the pool can never serve a stale facade against a gone
     *  database). Optional so the control-plane-only boot / tests still type. */
    evictToken?: (token: string) => void;
    evictCell?: (tenantId: string, appId: string) => void;
    /** Slice-4 right-to-be-forgotten — the daemon outbox store, so destroyApp
     *  purges the cell's queued outbox rows in the same teardown. Optional;
     *  typed structurally to avoid an import cycle. */
    outboxStore?: { deleteByWorkspace?: (workspace: string) => Promise<number> };
}

const ID_RE = /^[a-z0-9]+$/;

/** Audit a control-plane op. Args are already secret-free by construction —
 *  we pass tenant/app ids + outcome only. The audit toolName is namespaced so
 *  a grep of the log isolates the arcade control plane. */
function auditAdmin(
    deps: ArcadeAdminDeps,
    op: string,
    args: Record<string, unknown>,
    result: 'success' | 'error',
    resultDetail?: string,
): void {
    if (!deps.auditLog) return;
    deps.auditLog.log({
        toolName: `arcade.admin.${op}`,
        args,
        result,
        resultDetail,
        durationMs: 0,
    });
}

/** Read + JSON-parse a bounded body; returns {} for an empty body. Maps
 *  oversize to a 413 (handled at the caller via the thrown code) and malformed
 *  JSON to a 400 the caller writes. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBoundedBody(req);
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, unknown>;
}

function invalidIdentifier(res: ServerResponse, which: string): true {
    writeError(
        res,
        400,
        'invalid_identifier',
        `${which} must match ${ID_RE} (lowercase alphanumeric only)`,
    );
    return true;
}

/**
 * tryArcadeAdminRoutes — mounts the /api/arcade/* control plane. Returns true
 * when it OWNED the request (handled or errored), false to fall through.
 *
 * ARCADE-MODE GUARD: the arcade listener only ever registers this family; it
 * is NOT wired into the local/cloud dispatcher, so there is no cross-mode
 * `arcade_mode_required` branch to write here — a stray call simply never
 * matches the /api/arcade prefix in those modes.
 */
export async function tryArcadeAdminRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: ArcadeAdminDeps,
): Promise<boolean> {
    if (!pathname.startsWith('/api/arcade/')) return false;
    const method = req.method ?? 'GET';

    try {
        // ── POST/GET /api/arcade/apps ─────────────────────────────────────
        if (pathname === '/api/arcade/apps') {
            if (method === 'POST') return await handleProvision(req, res, deps);
            if (method === 'GET') return handleListApps(res, deps);
            writeError(res, 405, 'method_not_allowed', `${method} not allowed on ${pathname}`);
            return true;
        }

        // ── POST /api/arcade/tokens/revoke ────────────────────────────────
        if (pathname === '/api/arcade/tokens/revoke' && method === 'POST') {
            return await handleRevoke(req, res, deps);
        }

        // ── /api/arcade/apps/:customerId/:appId[/...] ─────────────────────
        const rest = pathname.slice('/api/arcade/apps/'.length);
        if (pathname.startsWith('/api/arcade/apps/') && rest.length > 0) {
            const segs = rest.split('/').filter(Boolean);
            const [customerId, appId, action, sub] = segs;
            if (!customerId || !appId) {
                writeError(res, 404, 'not_found', `unmatched arcade admin path: ${pathname}`);
                return true;
            }

            // issue-token / list-tokens
            if (action === 'tokens' && !sub && method === 'POST') {
                return await handleIssueToken(req, res, deps, customerId, appId);
            }
            if (action === 'tokens' && sub === 'list' && method === 'POST') {
                return handleListTokens(res, deps, customerId, appId);
            }
            // rotate-token (Slice-4 token-lifecycle contract)
            if (action === 'tokens' && sub === 'rotate' && method === 'POST') {
                return await handleRotateToken(req, res, deps, customerId, appId);
            }
            // disable-app (phase 1)
            if (action === 'disable' && !sub && method === 'POST') {
                return await handleDisable(res, deps, customerId, appId);
            }
            // destroy-app (phase 2) — DELETE on the bare :customerId/:appId
            if (!action && method === 'DELETE') {
                return await handleDestroy(req, res, deps, customerId, appId);
            }
            writeError(res, 404, 'not_found', `unmatched arcade admin path: ${method} ${pathname}`);
            return true;
        }

        writeError(res, 404, 'not_found', `unmatched arcade admin path: ${method} ${pathname}`);
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
        if (err instanceof ArcadeAuthError) {
            // cell_missing / cell_not_active surface as 403 (the cell must be
            // provisioned+active before a token can be issued for it).
            writeError(res, 403, 'cell_not_active', err.message);
            return true;
        }
        if (err instanceof CellLeaseHeldError) {
            // Another live daemon holds the cross-daemon cell lease — 409 with the
            // holder + retry hint (consistent with MIGRATION_IN_PROGRESS posture).
            writeError(res, 409, 'cell_lease_held', err.message, {
                holder: err.holder,
                retryAfterSec: err.retryAfterSec,
            });
            return true;
        }
        // Identifier-validation errors from the provisioner (assertValidIdentifier)
        // → 400; anything else is an upstream/provisioning fault → 500.
        const msg = err instanceof Error ? err.message : String(err);
        if (/invalid .* must match/.test(msg)) {
            writeError(res, 400, 'invalid_identifier', msg);
            return true;
        }
        writeError(res, 500, 'arcade_admin_error', msg);
        return true;
    }
}

// ── provision-app ─────────────────────────────────────────────────────────

async function handleProvision(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ArcadeAdminDeps,
): Promise<true> {
    if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
    const body = await readJson(req);
    const customerId = String(body['customerId'] ?? '');
    const appId = String(body['appId'] ?? '');
    if (!ID_RE.test(customerId)) return invalidIdentifier(res, 'customerId');
    if (!ID_RE.test(appId)) return invalidIdentifier(res, 'appId');
    const embedDim = typeof body['embedDim'] === 'number' ? (body['embedDim'] as number) : undefined;

    try {
        const result = await provisionApp({ customerId, appId }, { embedDim });
        auditAdmin(deps, 'provision', { customerId, appId, created: result.created }, 'success');
        // 201 on first creation, 200 on an idempotent repair re-run.
        writeJson(res, result.created ? 201 : 200, {
            db: result.db,
            dbUser: result.dbUser,
            secretRef: result.secretRef,
            created: result.created,
        });
    } catch (err) {
        auditAdmin(deps, 'provision', { customerId, appId }, 'error', (err as Error).message);
        throw err;
    }
    return true;
}

// ── list-apps ───────────────────────────────────────────────────────────────

function handleListApps(res: ServerResponse, deps: ArcadeAdminDeps): true {
    if (!bindDaemonOperatorLane(res, { intent: 'read' })) return true;
    // listTenantApps already OMITS db_pass — no secret material leaves here.
    const apps = listTenantApps().map((a) => ({
        customerId: a.tenant_id,
        appId: a.app_id,
        db: a.db,
        dbUser: a.db_user,
        secretRef: a.secret_ref,
        status: a.status,
        createdAt: a.created_at,
        disabledAt: a.disabled_at,
    }));
    writeJson(res, 200, { apps });
    return true;
}

// ── issue-token ───────────────────────────────────────────────────────────

function normalizeScopeInput(raw: unknown): Scope[] {
    const arr = Array.isArray(raw) ? raw : [];
    const out: Scope[] = [];
    for (const s of arr) if (s === 'read' || s === 'write') out.push(s);
    return out;
}

async function handleIssueToken(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ArcadeAdminDeps,
    customerId: string,
    appId: string,
): Promise<true> {
    if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
    if (!ID_RE.test(customerId)) return invalidIdentifier(res, 'customerId');
    if (!ID_RE.test(appId)) return invalidIdentifier(res, 'appId');
    const body = await readJson(req);
    const scopes = normalizeScopeInput(body['scopes']);
    if (scopes.length === 0) {
        writeError(res, 400, 'invalid_scopes', "scopes must be a non-empty subset of ['read','write']");
        return true;
    }
    const ttlSeconds =
        typeof body['ttlSeconds'] === 'number' ? (body['ttlSeconds'] as number) : undefined;
    const label = typeof body['label'] === 'string' ? (body['label'] as string) : undefined;

    // Refuse un-provisioned/inactive cells BEFORE minting (also enforced inside
    // issueToken, which throws ArcadeAuthError('cell_missing')).
    const cell = getTenantApp({ customerId, appId });
    if (!cell || cell.status !== 'active') {
        writeError(res, 403, 'cell_not_active', `cell (${customerId}, ${appId}) is not provisioned/active`);
        return true;
    }

    try {
        const { token, expiresAt } = issueToken({ tenantId: customerId, appId, scopes, ttlSeconds, label });
        // Audit the ISSUE with the token's hash prefix — never the plaintext.
        auditAdmin(
            deps,
            'issue-token',
            { customerId, appId, scopes, tokenHashPrefix: hashToken(token).slice(0, 8), ttlSeconds: ttlSeconds ?? null },
            'success',
        );
        // Token returned EXACTLY once.
        writeJson(res, 201, { token, expiresAt });
    } catch (err) {
        auditAdmin(deps, 'issue-token', { customerId, appId, scopes }, 'error', (err as Error).message);
        throw err;
    }
    return true;
}

// ── list-tokens ─────────────────────────────────────────────────────────────

function handleListTokens(
    res: ServerResponse,
    deps: ArcadeAdminDeps,
    customerId: string,
    appId: string,
): true {
    if (!bindDaemonOperatorLane(res, { intent: 'read' })) return true;
    if (!ID_RE.test(customerId)) return invalidIdentifier(res, 'customerId');
    if (!ID_RE.test(appId)) return invalidIdentifier(res, 'appId');
    // Hash-prefix only — no token plaintext is retained or returned.
    const tokens = listTokensForCell({ tenantId: customerId, appId });
    writeJson(res, 200, { customerId, appId, tokens });
    return true;
}

// ── rotate-token (Slice-4 token-lifecycle contract) ─────────────────────────

async function handleRotateToken(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ArcadeAdminDeps,
    customerId: string,
    appId: string,
): Promise<true> {
    if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
    if (!ID_RE.test(customerId)) return invalidIdentifier(res, 'customerId');
    if (!ID_RE.test(appId)) return invalidIdentifier(res, 'appId');
    const body = await readJson(req);
    const tokenHashPrefix = typeof body['tokenHashPrefix'] === 'string' ? (body['tokenHashPrefix'] as string) : '';
    if (!tokenHashPrefix) {
        writeError(res, 400, 'invalid_request', 'body must carry a non-empty "tokenHashPrefix" string');
        return true;
    }
    const graceSeconds =
        typeof body['graceSeconds'] === 'number' ? (body['graceSeconds'] as number) : undefined;
    try {
        // Rotate is atomic (single SQLite tx inside rotateToken): the cell can
        // never be left with zero live tokens. The old token keeps working
        // through graceSeconds (then 401 token_expired); graceSeconds=0 revokes
        // it immediately.
        const { token, expiresAt, supersededPrefix } = rotateToken(
            { byPrefix: tokenHashPrefix, tenantId: customerId, appId },
            { graceSeconds },
        );
        auditAdmin(
            deps,
            'rotate-token',
            { customerId, appId, supersededPrefix, newPrefix: hashToken(token).slice(0, 8), graceSeconds: graceSeconds ?? 0 },
            'success',
        );
        // New plaintext returned EXACTLY once.
        writeJson(res, 201, { token, expiresAt, supersededPrefix });
    } catch (err) {
        if (err instanceof ArcadeAuthError) {
            // unknown/revoked/expired old token → 404 (nothing rotatable).
            auditAdmin(deps, 'rotate-token', { customerId, appId, tokenHashPrefix }, 'error', err.message);
            writeError(res, 404, 'not_found', 'no rotatable token for that prefix');
            return true;
        }
        auditAdmin(deps, 'rotate-token', { customerId, appId, tokenHashPrefix }, 'error', (err as Error).message);
        throw err;
    }
    return true;
}

// ── revoke-token ────────────────────────────────────────────────────────────

async function handleRevoke(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ArcadeAdminDeps,
): Promise<true> {
    if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
    const body = await readJson(req);
    const token = body['token'];
    if (typeof token !== 'string' || token.length === 0) {
        writeError(res, 400, 'invalid_request', 'body must carry a non-empty "token" string');
        return true;
    }
    const revoked = revokeToken(token);
    // Slice 3 — evict the cached facade so a request in flight before the revoke
    // cannot resurrect a fresh cell afterward; the next request re-resolves and
    // fails closed with 401.
    deps.evictToken?.(token);
    // Audit the revoke by hash prefix — never the plaintext (body-carried so it
    // never reached the access log either).
    auditAdmin(deps, 'revoke-token', { tokenHashPrefix: hashToken(token).slice(0, 8), revoked }, 'success');
    writeJson(res, 200, { revoked });
    return true;
}

// ── disable-app (two-phase deprovision, phase 1) ─────────────────────────────

async function handleDisable(
    res: ServerResponse,
    deps: ArcadeAdminDeps,
    customerId: string,
    appId: string,
): Promise<true> {
    if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
    if (!ID_RE.test(customerId)) return invalidIdentifier(res, 'customerId');
    if (!ID_RE.test(appId)) return invalidIdentifier(res, 'appId');
    try {
        await disableApp({ customerId, appId });
        // Slice 3 — a disabled cell must stop serving immediately: drop every
        // pooled token bound to it so the next data request 404s (the resolve
        // gate now sees status!='active').
        deps.evictCell?.(customerId, appId);
        auditAdmin(deps, 'disable', { customerId, appId }, 'success');
        writeJson(res, 200, { customerId, appId, status: 'disabled' });
    } catch (err) {
        auditAdmin(deps, 'disable', { customerId, appId }, 'error', (err as Error).message);
        throw err;
    }
    return true;
}

// ── destroy-app (two-phase deprovision, phase 2) ─────────────────────────────

async function handleDestroy(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ArcadeAdminDeps,
    customerId: string,
    appId: string,
): Promise<true> {
    if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
    if (!ID_RE.test(customerId)) return invalidIdentifier(res, 'customerId');
    if (!ID_RE.test(appId)) return invalidIdentifier(res, 'appId');
    const body = await readJson(req);
    const confirm = body['confirm'];
    const force = body['force'] === true;
    // The two-phase contract: destroy requires the cell to be 'disabled' first,
    // unless the operator passes {force:true} (audit-logged as such).
    const expected = `${customerId}/${appId}`;
    if (confirm !== expected) {
        writeError(res, 400, 'confirm_mismatch', `body { confirm } must equal "${expected}"`);
        return true;
    }
    const cell = getTenantApp({ customerId, appId });
    if (cell && cell.status !== 'disabled' && !force) {
        writeError(
            res,
            409,
            'not_disabled',
            `cell (${customerId}, ${appId}) is '${cell.status}'; disable it first or pass { force: true }`,
        );
        return true;
    }
    try {
        await destroyApp({ customerId, appId }, { outboxStore: deps.outboxStore });
        deps.evictCell?.(customerId, appId);
        auditAdmin(deps, 'destroy', { customerId, appId, force }, 'success');
        writeJson(res, 200, { customerId, appId, destroyed: true, forced: force });
    } catch (err) {
        auditAdmin(deps, 'destroy', { customerId, appId, force }, 'error', (err as Error).message);
        throw err;
    }
    return true;
}

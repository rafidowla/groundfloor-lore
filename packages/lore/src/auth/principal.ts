/**
 * principal.ts — Phase 6 P3 request-principal context + scope guards.
 *
 * Every incoming HTTP request resolves to one of three kinds of
 * principal:
 *
 *   - kind: 'bootstrap'
 *       The legacy `~/.groundfloor/auth.token` (64-char hex). Bound to
 *       whatever workspace the daemon booted into, with read+write
 *       scopes. Preserves existing single-token setups; explicitly
 *       NOT auto-elevated to cross-workspace scopes (per the P3 spec
 *       stop condition).
 *
 *   - kind: 'app'
 *       A token issued via `lore auth issue` — `lore_<workspace>_<rand>`.
 *       Scopes come from the registry record.
 *
 *   - kind: 'shared-secret'
 *       The LORE_MCP_AUTH_TOKEN cloud env shared secret. Treated as
 *       full-access for back-compat with the cloud service-to-service
 *       flow (DEF/Loom → Lore). Local mode never sets it.
 *
 * Routes consume the principal via `getCurrentPrincipal()` and gate
 * their actions with `requireWriteToWorkspace()` /
 * `requireReadFromWorkspace()`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TokenScope } from './tokens.js';

export type PrincipalKind = 'bootstrap' | 'app' | 'shared-secret';

export interface Principal {
    kind: PrincipalKind;
    /** Workspace this principal is bound to. For bootstrap = active workspace. */
    workspace: string;
    /** Scope set granted to this principal. */
    scopes: TokenScope[];
    /**
     * Short, per-principal identifier for audit logs AND the rate-limit bucket
     * key — a per-token sha256 fragment for app tokens (RA2-reaudit2: NOT the
     * workspace-derived token prefix, which collides across a workspace's
     * tokens), 'bootstrap' for the legacy auth.token, 'shared-secret' otherwise.
     */
    label: string;
    /**
     * TW-3a — the EXPLICIT set of workspaces/tenants this principal is
     * authorized to target via the `X-Lore-Workspace` request header in
     * cloud mode. Derived from the token's binding/claims at resolution
     * time:
     *   - app token       → [record.workspace]
     *   - bootstrap token → [bootstrap workspace]
     *   - shared-secret   → omitted (a cross-workspace service principal;
     *                        its cross-workspace-* scopes authorize ANY
     *                        tenant header — see `isWorkspaceHeaderAuthorized`).
     *
     * The cloud tenant-routing header (`X-Lore-Workspace`) decides which
     * customer's data partition a request reads/writes. Before TW-3a it
     * was trusted verbatim and NEVER reconciled with the authenticated
     * principal, so any logged-in caller could set the header to another
     * tenant and breach it. The header MUST be validated against this set
     * (or a cross-workspace scope) BEFORE it is bound to the request.
     *
     * Undefined ⇒ "no explicit allow-list" — only a principal holding a
     * cross-workspace scope may then target an arbitrary header. A normal
     * tenant principal always carries exactly its own workspace here.
     */
    allowedWorkspaces?: string[];
}

const storage = new AsyncLocalStorage<Principal>();

/** Wrap `fn` so any await-chain inside it sees `principal` as current. */
export function runWithPrincipal<T>(principal: Principal, fn: () => T): T {
    return storage.run(principal, fn);
}

/** Current request principal, or null when no binding is active. */
export function getCurrentPrincipal(): Principal | null {
    return storage.getStore() ?? null;
}

/* ─── Scope guards ─────────────────────────────────────────────── */

export interface ScopeOutcome {
    ok: boolean;
    /** Set when ok is false — maps to HTTP 401/403. */
    status?: 401 | 403;
    code?: string;
    reason?: string;
}

/**
 * Require write access against `requestedWorkspace`. The principal
 * MUST hold the `write` scope. If `requestedWorkspace` differs from
 * the principal's bound workspace, cross-workspace-write is required.
 *
 * `requestedWorkspace` of `undefined` means "use my bound workspace"
 * (the route resolves the actual target through this function so the
 * principal's workspace becomes the default).
 */
export function requireWriteToWorkspace(
    principal: Principal | null,
    requestedWorkspace: string | undefined,
): ScopeOutcome {
    if (!principal) return { ok: false, status: 401, code: 'auth_required' };
    if (!principal.scopes.includes('write')) {
        return { ok: false, status: 403, code: 'scope_missing', reason: "token lacks 'write' scope" };
    }
    const target = requestedWorkspace ?? principal.workspace;
    if (target !== principal.workspace) {
        if (!principal.scopes.includes('cross-workspace-write')) {
            return {
                ok: false,
                status: 403,
                code: 'workspace_forbidden',
                reason: `token is scoped to workspace "${principal.workspace}", cannot write to "${target}" (missing 'cross-workspace-write' scope)`,
            };
        }
    }
    return { ok: true };
}

/**
 * Require read access. `'*'` means "every workspace" and ALWAYS
 * requires `cross-workspace-read`. A targeted workspace name that
 * doesn't match the principal's bound workspace also requires
 * `cross-workspace-read`.
 */
export function requireReadFromWorkspace(
    principal: Principal | null,
    requestedWorkspace: string | undefined | '*',
): ScopeOutcome {
    if (!principal) return { ok: false, status: 401, code: 'auth_required' };
    if (!principal.scopes.includes('read')) {
        return { ok: false, status: 403, code: 'scope_missing', reason: "token lacks 'read' scope" };
    }
    if (requestedWorkspace === undefined || requestedWorkspace === principal.workspace) {
        return { ok: true };
    }
    if (!principal.scopes.includes('cross-workspace-read')) {
        return {
            ok: false,
            status: 403,
            code: 'workspace_forbidden',
            reason: requestedWorkspace === '*'
                ? `token lacks 'cross-workspace-read' scope (needed for workspace:"*" aggregation)`
                : `token is scoped to workspace "${principal.workspace}", cannot read "${requestedWorkspace}" (missing 'cross-workspace-read' scope)`,
        };
    }
    return { ok: true };
}

/**
 * TW-3a — Is `headerWorkspace` (the cloud `X-Lore-Workspace` value) a
 * tenant this principal is allowed to target?
 *
 * Fail-closed rules (cloud-mode tenant isolation):
 *   - No principal → not authorized (caller must be authenticated to set
 *     a tenant header; the edge already 400s an empty header).
 *   - The principal's own bound `workspace` always matches.
 *   - A workspace present in the principal's explicit `allowedWorkspaces`
 *     allow-list matches.
 *   - A DIFFERENT workspace requires a cross-workspace scope:
 *       read  request → `cross-workspace-read`
 *       write request → `cross-workspace-write`
 *     This preserves the master-app/service principal (shared-secret),
 *     which holds both cross-workspace scopes and may target any tenant,
 *     while a normal tenant principal (own workspace only, no
 *     cross-workspace scope) is confined to its own partition.
 *
 * `intent` lets the caller require the stronger write scope for mutating
 * requests; reads accept either cross-workspace scope (a writer is also a
 * reader). Defaults to 'read' (the weaker requirement) when unknown.
 */
export function isWorkspaceHeaderAuthorized(
    principal: Principal | null,
    headerWorkspace: string,
    intent: 'read' | 'write' = 'read',
): boolean {
    if (!principal) return false;
    if (headerWorkspace === principal.workspace) return true;
    if (principal.allowedWorkspaces?.includes(headerWorkspace)) return true;
    // Cross-tenant target: must hold the matching cross-workspace scope.
    if (intent === 'write') {
        return principal.scopes.includes('cross-workspace-write');
    }
    return (
        principal.scopes.includes('cross-workspace-read') ||
        principal.scopes.includes('cross-workspace-write')
    );
}

/**
 * TW-3a — Resolve the tenant/workspace a cloud request should be bound
 * to, fail-closed against the principal.
 *
 * Returns either the workspace to bind (`{ ok: true, workspace }`) or a
 * `ScopeOutcome`-shaped rejection. The middleware uses this AFTER the
 * non-empty-header edge check:
 *   - header present + authorized → bind that header value.
 *   - header present + NOT authorized → 403 (do NOT silently fall back to
 *     a default — the whole point of the fix).
 *   - header absent → bind the principal's own default workspace, not an
 *     arbitrary global. (Cloud routes already require a non-empty header
 *     at the edge, so this branch is a belt-and-suspenders default for
 *     any non-gated cloud path.)
 *
 * A null principal yields a 401 — cloud-mode tenant routing requires an
 * authenticated caller. (Local mode never calls this: it has no cloud
 * tenant header semantics and binds nothing.)
 */
export function resolveWorkspaceHeaderBinding(
    principal: Principal | null,
    headerWorkspace: string | undefined,
    intent: 'read' | 'write' = 'read',
): ScopeOutcome & { workspace?: string } {
    if (!principal) {
        return {
            ok: false,
            status: 401,
            code: 'auth_required',
            reason: 'cloud tenant routing requires an authenticated principal',
        };
    }
    if (headerWorkspace === undefined || headerWorkspace.trim().length === 0) {
        return { ok: true, workspace: principal.workspace };
    }
    const target = headerWorkspace.trim();
    if (!isWorkspaceHeaderAuthorized(principal, target, intent)) {
        return {
            ok: false,
            status: 403,
            code: 'workspace_forbidden',
            reason: `principal is scoped to workspace "${principal.workspace}", not authorized to target tenant "${target}" via X-Lore-Workspace (missing cross-workspace-${intent} scope)`,
        };
    }
    return { ok: true, workspace: target };
}

/**
 * workspaceContext.ts — Per-request workspace/tenant routing for cloud mode (Q2.2).
 *
 * Problem: In cloud mode the daemon is a singleton serving many tenants.
 * Every authenticated /api/* request carries `X-Lore-Workspace: <id>`
 * (Q2.1 gate). Downstream code — DataplaneGraph.tenantProvider, lifecycle
 * hooks, audit logs — needs to know which workspace a given call is
 * operating in, without threading an argument through every signature.
 *
 * Solution: AsyncLocalStorage. Stash a request-local `{ workspaceId }`
 * at the top of the HTTP handler; downstream reads the current value
 * via `getCurrentWorkspaceId()`. Async boundaries (await, setTimeout,
 * promises) preserve the binding automatically.
 *
 * Local mode: the store is unset; `getCurrentWorkspaceId()` returns
 * null. LocalGraph doesn't read it — it's scoped to the workspace
 * chosen at boot. Cloud-mode callers that require a workspace call
 * `requireCurrentWorkspaceId()` which throws a descriptive error if
 * unset (belt-and-suspenders — the HTTP gate refuses unset cloud
 * requests at the edge already).
 *
 * Thread-safety: AsyncLocalStorage is per-async-chain, so concurrent
 * requests don't cross-contaminate. Node's ALS is the right primitive
 * (it's what Express / Fastify / Hono all use under the hood for
 * request-scoped context).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface WorkspaceContext {
    /** The workspace / tenant id from X-Lore-Workspace. Never empty. */
    workspaceId: string;
    /**
     * Optional tenant id override. Usually equals workspaceId, but an
     * operator may remap (e.g. dev-workspace-123 → tenant_dev_123).
     * Reserved for slice 3; slice 2 treats workspaceId as tenantId 1:1.
     */
    tenantId?: string;
}

const storage = new AsyncLocalStorage<WorkspaceContext>();

/**
 * runWithWorkspace — Executes `fn` with the given workspace bound to the
 * current async chain. Typical use: wrap the HTTP request handler body.
 */
export function runWithWorkspace<T>(ctx: WorkspaceContext, fn: () => T): T {
    return storage.run(ctx, fn);
}

/**
 * bindWorkspaceToRequest — Non-callback form: binds the workspace to
 * the CURRENT async execution, without nesting the remainder of the
 * handler in a callback. Uses AsyncLocalStorage.enterWith() (standard
 * since Node 16). Lets the HTTP handler stay linear after the Q2.1
 * workspace-header gate — no refactor of the giant request body needed.
 *
 * The binding is scoped to the current async chain, so concurrent
 * requests see their own values; it does NOT leak across requests.
 *
 * TW-3a SECURITY INVARIANT: in cloud mode the `workspaceId` passed here
 * is the value DataplaneGraph.tenantProvider() routes EVERY read/write
 * to — i.e. it selects the customer's data partition. Callers MUST NOT
 * pass an `X-Lore-Workspace` header value verbatim. The header has to be
 * reconciled against the authenticated principal first (see
 * `resolveWorkspaceHeaderBinding` in `auth/principal.ts`, called from the
 * cloud gate in `mcp/http/middleware.ts`). Binding an unvalidated header
 * is a cross-tenant breach. Local mode never calls this (it has no cloud
 * tenant header semantics; LocalGraph is scoped to the boot workspace).
 */
export function bindWorkspaceToRequest(ctx: WorkspaceContext): void {
    storage.enterWith(ctx);
}

/**
 * getCurrentWorkspaceId — Read the workspace id bound to the current
 * async chain, or null if outside a bound scope (local mode, module
 * init, background tasks that didn't inherit a request context).
 */
export function getCurrentWorkspaceId(): string | null {
    const ctx = storage.getStore();
    return ctx?.workspaceId ?? null;
}

/**
 * getCurrentTenantId — Read the tenant id to route Dataplane calls at.
 * Defaults to workspaceId when the context didn't override. Returns
 * null outside a bound scope.
 */
export function getCurrentTenantId(): string | null {
    const ctx = storage.getStore();
    if (!ctx) return null;
    return ctx.tenantId ?? ctx.workspaceId;
}

/**
 * requireCurrentWorkspaceId — Same as getCurrentWorkspaceId, but throws
 * if no workspace is bound. Use inside cloud-mode paths that would be
 * meaningless without a workspace (DataplaneGraph.tenantProvider calls
 * this — the HTTP 400 gate at the edge should make the throw unreachable
 * in practice, but we want a loud failure if the invariant breaks).
 */
export function requireCurrentWorkspaceId(): string {
    const id = getCurrentWorkspaceId();
    if (!id) {
        throw new Error(
            'workspaceContext: no workspace bound in the current async chain. ' +
            'Cloud-mode code must be called from inside runWithWorkspace(). ' +
            'If you see this in a request handler, the AsyncLocalStorage wrap ' +
            'is missing around the request body.',
        );
    }
    return id;
}

/**
 * requireCurrentTenantId — Same as requireCurrentWorkspaceId but returns
 * the effective tenant id (honoring a ctx.tenantId override if set).
 */
export function requireCurrentTenantId(): string {
    const id = getCurrentTenantId();
    if (!id) {
        throw new Error(
            'workspaceContext: no tenant bound in the current async chain.',
        );
    }
    return id;
}

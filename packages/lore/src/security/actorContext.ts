/**
 * actorContext.ts — Per-request actor identity for cloud mode.
 *
 * Mirrors the workspaceContext.ts pattern: AsyncLocalStorage-bound
 * `{portalUserId, scopes}` resolved at the auth gate, read everywhere
 * downstream without threading it through every call.
 *
 * Populated by:
 *   - Clerk JWKS middleware (security/clerkAuth.ts) on the inbound request,
 *     extracting `sub` (portal_user id) and a `scopes` claim if present.
 *   - Service-to-service callers (DEF/Loom presenting LORE_MCP_AUTH_TOKEN):
 *     no portal_user — the actor IS the service. Permission decisions
 *     for those callers fall through to workspace-level shared-secret
 *     trust + the daemon's existing per-tenant routing.
 *
 * Read by:
 *   - `requirePermission` in security/rebac.ts — uses portalUserId for
 *     SpiceDB checkPermission.
 *   - VerbatimStore + DataplaneVectorStore search callers — pull `scopes`
 *     into the `actorScopes` parameter to apply row-level filtering
 *     (security/scopeFilter.ts).
 *
 * Local mode is unaffected: nothing populates the context, so reads
 * return null and downstream consumers behave as if no actor identity
 * is in play (which matches local-mode's single-operator model).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface ActorContext {
    /** SpiceDB portal_user id. Resolved from the Clerk JWT `sub` claim. */
    portalUserId: string;
    /**
     * Effective scope set granted to this actor. Drives row-level
     * security_scopes filtering on top of workspace-grain SpiceDB checks.
     * Empty array = the actor only sees public-within-workspace rows.
     */
    scopes: ReadonlyArray<string>;
}

const storage = new AsyncLocalStorage<ActorContext>();

/**
 * Bind an actor to the current async chain (no callback nesting).
 * Called by the Clerk auth middleware after JWT validation.
 */
export function bindActorToRequest(ctx: ActorContext): void {
    storage.enterWith(ctx);
}

/**
 * Run `fn` with `ctx` bound. Useful in tests + non-HTTP entry points
 * (e.g. background workers reusing the same scope-filter primitive).
 */
export function runWithActor<T>(ctx: ActorContext, fn: () => T): T {
    return storage.run(ctx, fn);
}

/**
 * Read the bound actor, or null if outside a bound scope (local mode,
 * background tasks, module init).
 */
export function getCurrentActor(): ActorContext | null {
    return storage.getStore() ?? null;
}

/**
 * Convenience: just the scope set, normalized to a fresh array.
 * Returns undefined when no actor is bound, so verbatim-search callers
 * can pass it straight through to applyActorScopeFilter without
 * wrapping each call site in a null-check.
 */
export function getCurrentActorScopes(): ReadonlyArray<string> | undefined {
    const ctx = storage.getStore();
    return ctx ? ctx.scopes : undefined;
}

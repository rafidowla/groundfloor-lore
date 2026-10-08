/**
 * exportGate.ts — whole-workspace exports are admin-only for bound actors.
 *
 * The NDJSON workspace export (routes/workspaceExport.ts) and the HTML graph
 * snapshot (routes/static.ts) dump every node/edge/verbatim row of a workspace
 * and are NOT row-filtered by `security_scopes`. Decision (Rafi): a restricted
 * (bound) actor may not use them at all, rather than receiving a filtered
 * bundle that a migration would then silently treat as the whole workspace.
 *
 * Rule:
 *   - no actor bound (getCurrentActorScopes() === undefined) → unchanged, allow.
 *   - actor bound AND the request principal is a daemon operator → allow. The
 *     only explicit operator concept on the request is the principal kind used
 *     by bindDaemonOperatorLane (security/routeWorkspaceBinding.ts): 'bootstrap'
 *     (the human operator's daemon token — the same request that carries the
 *     operator.json actor in local mode) and 'shared-secret' (trusted
 *     service-to-service callers). The actor itself has no admin/role/wildcard
 *     concept: ActorContext is {portalUserId, scopes}, the operator.json
 *     "admin" scope string is never checked anywhere, and '*' is not a wildcard
 *     in applyActorScopeFilter — so scopes are deliberately NOT inspected.
 *   - otherwise (Clerk-JWT user → principal null; workspace 'app' token) → 403.
 */

import type { ServerResponse } from 'node:http';
import { getCurrentActorScopes } from './actorContext.js';
import { getCurrentPrincipal } from '../auth/principal.js';
import { EXPORT_FORBIDDEN, MAINTENANCE_FORBIDDEN } from '../mcp/http/errorCodes.js';

/** True when the current request may run a whole-workspace export. */
export function exportAllowedForCurrentActor(): boolean {
    if (getCurrentActorScopes() === undefined) return true;
    const kind = getCurrentPrincipal()?.kind;
    return kind === 'bootstrap' || kind === 'shared-secret';
}

/**
 * Route-facing gate. Returns true when the caller may proceed; otherwise writes
 * the standard `{code, message}` 403 envelope and returns false (the caller must
 * `return true` to mark the request handled).
 */
export function requireExportAllowed(res: ServerResponse, what: string): boolean {
    if (exportAllowedForCurrentActor()) return true;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        code: EXPORT_FORBIDDEN,
        message: `${what} is restricted to workspace administrators; this actor is confined by row-level security_scopes`,
    }));
    return false;
}

/**
 * True for a bound NON-operator (app token / Clerk user): the caller class that
 * must not receive raw corpus counters, pending-sync counts, disk sizes or
 * other numbers that cannot be computed per visible item. Unbound callers and
 * operators stay false, so their responses are unchanged and no extra work
 * runs. Check it BEFORE computing the number, not after.
 * Pinned (test/counts-review-fixes-unit.ts): with an operator.json identity, a
 * request with no bearer has a bound actor and a null principal, so it counts as
 * non-operator and these numbers are hidden.
 */
export function hideUncountableForCurrentActor(): boolean {
    return getCurrentActorScopes() !== undefined && !exportAllowedForCurrentActor();
}

/** Shared wording for every operator-only refusal (REST and MCP). */
function operatorOnlyMessage(what: string): string {
    return `${what} requires a daemon operator credential (bootstrap token or shared secret)`;
}

/**
 * Whole-workspace maintenance gate (REST). Same operator rule as the export
 * gate: unbound callers are unchanged (no lookups), bound actors need a
 * bootstrap / shared-secret principal. Maintenance jobs delete, rebuild or count
 * across every row of the workspace — hidden rows included, dry-run counts too —
 * so they cannot be filtered per row. Writes the 403 `{code, message}` envelope
 * and returns false when refused; the caller must `return true`. Call it after the
 * route's own auth/workspace gates and BEFORE any scan, count, lock or write.
 */
export function requireOperatorForBoundActor(
    res: ServerResponse,
    what: string,
    code: string = MAINTENANCE_FORBIDDEN,
): boolean {
    if (exportAllowedForCurrentActor()) return true;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, message: operatorOnlyMessage(what) }));
    return false;
}

/**
 * MCP equivalent of requireOperatorForBoundActor: null when the caller may
 * proceed, otherwise the `isError` tool result to return as-is.
 */
export function maintenanceForbiddenToolResult(what: string):
    { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
    if (exportAllowedForCurrentActor()) return null;
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: MAINTENANCE_FORBIDDEN, message: operatorOnlyMessage(what) }) }],
        isError: true,
    };
}

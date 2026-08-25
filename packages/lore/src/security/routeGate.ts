/**
 * routeGate.ts — Deployment-mode-aware ReBAC wrapper for HTTP routes.
 *
 * `requirePermission` (in rebacGate.ts) is the raw SpiceDB check. It
 * always returns `{allowed: false, reason: 'no_dataplane'}` in local
 * mode because there's no Dataplane handle. Wiring it directly into
 * every route would break local mode.
 *
 * This module is the per-route gate. It:
 *   - Short-circuits with `allowed: true` in local mode (single-operator
 *     daemon — no SpiceDB to consult).
 *   - Enforces in cloud mode by calling requirePermission against the
 *     current actor (Clerk JWT subject) and the current workspace
 *     (AsyncLocalStorage-bound).
 *
 * Designed for read-side wire-up first — read endpoints all gate on
 * `lore__workspace#read` against the workspace from the request
 * context, so the gate boils down to one call.
 *
 * Pure function shape (takes deps, returns decision). Caller writes
 * the canonical 401/403/503 envelope via `writePermissionDenied`.
 */

import { getCurrentPrincipal } from '../auth/principal.js';
import { getCurrentWorkspaceId } from './workspaceContext.js';
import {
    requirePermission,
    type LorePermission,
    type LoreResourceType,
    type PermissionDecision,
    type RequirePermissionDeps,
} from './rebacGate.js';

export interface RouteGateDeps extends RequirePermissionDeps {
    /** Set at boot. Drives the local-mode short-circuit. */
    deploymentMode: 'local' | 'cloud';
}

export interface RouteGateInput {
    /** Permission required, e.g. 'read' for GET endpoints. */
    permission: LorePermission;
    /**
     * SpiceDB resource type. Defaults to `lore__workspace` — the most
     * common shape (every workspace-scoped route gates on the workspace
     * itself). Override for routes that gate on a different resource
     * (e.g. `lore__environment` for env-scoped admin routes).
     */
    resourceType?: LoreResourceType;
    /**
     * Resource id. Defaults to the current workspace id from the
     * AsyncLocalStorage context (set by the workspace-header middleware
     * in cloud mode). Pass an explicit id when gating on a non-workspace
     * resource (e.g. an environment id from the path).
     */
    resourceId?: string;
}

/**
 * Decide whether the caller may execute this route.
 *
 * Local mode: always allowed. Cloud mode: defers to requirePermission
 * after resolving the resource pair. Returns `denied` with detail when
 * no workspace context is bound in cloud mode (caller forgot the
 * `X-Lore-Workspace` header or the middleware misfired).
 */
export async function gateRoute(
    deps: RouteGateDeps,
    input: RouteGateInput,
): Promise<PermissionDecision> {
    if (deps.deploymentMode === 'local') {
        const principal = getCurrentPrincipal();
        if (!principal) return { allowed: true };
        // Local mode has no SpiceDB; enforce scope directly so a
        // read-only app token cannot call write-class admin routes.
        if (input.permission !== 'read' && !principal.scopes.includes('write')) {
            return { allowed: false, reason: 'denied', detail: 'token scope does not include write' };
        }
        return { allowed: true };
    }
    const resourceType = input.resourceType ?? 'lore__workspace';
    const resourceId = input.resourceId ?? getCurrentWorkspaceId() ?? '';
    if (!resourceId) {
        return {
            allowed: false,
            reason: 'denied',
            detail: `no ${resourceType} id in request context`,
        };
    }
    return requirePermission(deps, {
        resourceType,
        resourceId,
        permission: input.permission,
    });
}

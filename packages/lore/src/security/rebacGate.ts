/**
 * rebacGate.ts — Opt-in ReBAC permission gating for /api/* routes,
 * via the Groundfloor Dataplane SDK's checkPermission relay against
 * Lore's `lore__*` SpiceDB types.
 *
 * (Distinct from security/rebac.ts, which models L1 relation tuples in
 * `.lore/rebac.sqlite` for workspace-local ACLs. This module is the cloud-shaped,
 * SpiceDB-backed gate that sits in front of HTTP routes.)
 *
 * Per Groundfloor's SpiceDB strategy (`SPICEDB_STRATEGY.md`), every
 * customer app gets its own `{app}__*` prefix. Lore's app id is
 * `lore`, so our types are `lore__user`, `lore__account`,
 * `lore__workspace`, `lore__environment`. `portal_*` types belong
 * to ControlPlane and Lore does NOT write tuples or push schemas
 * for them.
 *
 * Closed permission vocabulary (matches Lore's gf_authz YAML deploy):
 *
 *   administer | read | write | delete | ddl | deploy |
 *   manage_members | view_billing
 *
 * `requirePermission` calls dataplane.checkPermission with the actor's
 * portal_user id (resolved by the Clerk middleware → actorContext) and
 * the route's resource pair (typically `lore__workspace` + the
 * workspace id from `X-Lore-Workspace`).
 *
 * Designed as an opt-in helper, not a global middleware:
 *   - existing routes are not retrofitted in this PR
 *   - new + audited routes can adopt it incrementally:
 *
 *     const gate = await requirePermission(deps, {
 *         resourceType: 'lore__workspace',
 *         resourceId: getCurrentWorkspaceId() ?? '',
 *         permission: 'read',
 *     });
 *     if (!gate.allowed) return writePermissionDenied(res, gate);
 */

import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { ServerResponse } from 'node:http';
import { getCurrentActor } from './actorContext.js';
import { checkPermission as authzCheckPermission } from './dataplaneAuthz.js';

/**
 * Closed vocabulary of permissions accepted by Lore's gf_authz schema.
 * Compile-time enforcement so a typo doesn't make it to a SpiceDB
 * round-trip that always returns false.
 *
 * Identical wording to the portal_* permission set — same nouns
 * different namespace. This stays a closed list; new permissions
 * require a schema deploy + a code change here in lockstep.
 */
export type LorePermission =
    | 'administer'
    | 'read'
    | 'write'
    | 'delete'
    | 'ddl'
    | 'deploy'
    | 'manage_members'
    | 'view_billing';

/**
 * SpiceDB types Lore checks against. All are `lore__*`-prefixed
 * because Lore is a customer-app namespace per the Groundfloor
 * SpiceDB strategy. `portal_*` types belong to ControlPlane and
 * Lore does not write tuples or schemas for them.
 *
 * Cross-app references (e.g. a `lore__workspace` whose `account`
 * relation points at a `portal_account`) ARE supported in SpiceDB,
 * but that's a schema-modeling decision — at the gate level we only
 * pass the prefixed types we own.
 */
export type LoreResourceType =
    | 'lore__user'
    | 'lore__account'
    | 'lore__workspace'
    | 'lore__environment';

export interface RequirePermissionDeps {
    /** Cloud-mode Dataplane SDK handle, configured at boot. Null disables ReBAC. */
    dataplane: GroundfloorClient | null;
}

export interface RequirePermissionInput {
    resourceType: LoreResourceType;
    resourceId: string;
    permission: LorePermission;
}

export type PermissionDecision =
    | { allowed: true }
    | { allowed: false; reason: 'no_actor' | 'no_dataplane' | 'denied' | 'unreachable'; detail?: string };

export async function requirePermission(
    deps: RequirePermissionDeps,
    input: RequirePermissionInput,
): Promise<PermissionDecision> {
    const actor = getCurrentActor();
    if (!actor) {
        return { allowed: false, reason: 'no_actor' };
    }
    if (!deps.dataplane) {
        // No Dataplane configured — ReBAC effectively disabled. Caller
        // typically only configures the dataplane handle in cloud mode,
        // so this is the local-mode short-circuit. Surface as 'no_dataplane'
        // rather than 'allowed' — it's the caller's choice whether that's
        // a soft-fail or a hard-block.
        return { allowed: false, reason: 'no_dataplane' };
    }
    if (!input.resourceId) {
        return { allowed: false, reason: 'denied', detail: 'empty resourceId' };
    }
    try {
        // Subject type is 'lore__user' — Lore's app namespace per the
        // Groundfloor SpiceDB strategy. The actor's id field is still
        // called portalUserId for historical reasons (it came from the
        // JWT 'sub' claim, which Clerk emits as a portal-user identity);
        // we just project it into the lore__user subject type for the
        // CheckPermission call.
        //
        // Routed through our local `authzCheckPermission` wrapper instead
        // of `deps.dataplane.checkPermission` because the SDK as of v0.x
        // doesn't correctly unwrap the engine's `{success, data: {allowed}}`
        // envelope. The wrapper handles both shapes. See dataplaneAuthz.ts.
        const ok = await authzCheckPermission(deps.dataplane, {
            subjectType: 'lore__user',
            subjectId: actor.portalUserId,
            permission: input.permission,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
        });
        return ok ? { allowed: true } : { allowed: false, reason: 'denied' };
    } catch (e) {
        return {
            allowed: false,
            reason: 'unreachable',
            detail: (e as Error)?.message ?? String(e),
        };
    }
}

/**
 * Convenience: write the standard 403 envelope when a permission check
 * comes back denied. Status mapping:
 *   no_actor      → 401  (auth required)
 *   denied        → 403  (forbidden)
 *   unreachable   → 503  (transient — actor is real, infra is down)
 *   no_dataplane  → 503  (cloud feature in non-cloud boot — soft)
 */
export function writePermissionDenied(
    res: ServerResponse,
    decision: Exclude<PermissionDecision, { allowed: true }>,
): void {
    const status =
        decision.reason === 'no_actor' ? 401
        : decision.reason === 'denied' ? 403
        : 503;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        code: decision.reason,
        message: decision.detail ?? defaultMessage(decision.reason),
    }));
}

function defaultMessage(reason: 'no_actor' | 'no_dataplane' | 'denied' | 'unreachable'): string {
    switch (reason) {
        case 'no_actor':     return 'authentication required';
        case 'denied':       return 'forbidden';
        case 'unreachable':  return 'permission service unreachable';
        case 'no_dataplane': return 'permission service not configured in this mode';
    }
}

/**
 * schemaIdentity.ts — who is proposing / approving a schema change.
 *
 * `human:*` identity strings gate destructive schema proposals and the human
 * sign-off on approvals (schemas/destructive.ts isHumanProposer,
 * schemas/orchestration/wiring.ts). A string the caller typed into a request
 * body or tool argument is a claim, not an identity, so a BOUND caller never
 * gets to choose it:
 *   - request principal with a label → `human:<label>` for the bootstrap
 *     (daemon operator) token, `system:<label>` for everything else. This is
 *     the mapping proposals.ts and schema_approve have always used.
 *   - no principal but a bound actor (a caller the daemon did not authenticate
 *     itself, e.g. an in-process host that binds an actor) → `system:<portalUserId>`.
 *     Never `human:` — nothing here vouches that the actor is a person, and
 *     `system:` is exactly what the destructive paths refuse.
 *   - bound actor with no usable id → refused.
 *   - no actor bound (embedded host, local daemon without operator.json, stdio
 *     MCP, daemon-internal) → `claimed`: the caller's own string is used
 *     exactly as before.
 * Over the HTTP daemon every /api/schema and /mcp request carries a principal
 * (a Bearer is required, security/httpAuth.ts), so the actor-only branch is
 * reachable only for in-process callers.
 */

import { getCurrentPrincipal } from '../auth/principal.js';
import { getCurrentActor, getCurrentActorScopes } from './actorContext.js';
import { exportAllowedForCurrentActor } from './exportGate.js';

export type SchemaIdentity =
    | { kind: 'claimed' }
    | { kind: 'derived'; identity: string }
    | { kind: 'refused' };

const CLAIMED: SchemaIdentity = { kind: 'claimed' };

/** Identity for the proposer / approver of a schema change. */
export function deriveSchemaIdentity(): SchemaIdentity {
    const principal = getCurrentPrincipal();
    if (principal?.label) {
        return { kind: 'derived', identity: `${principal.kind === 'bootstrap' ? 'human' : 'system'}:${principal.label}` };
    }
    if (getCurrentActorScopes() === undefined) return CLAIMED;
    const portalUserId = getCurrentActor()?.portalUserId;
    return portalUserId ? { kind: 'derived', identity: `system:${portalUserId}` } : { kind: 'refused' };
}

/**
 * Proposer identity for the MCP `schema_propose` tool, whose `proposedBy`
 * argument has always been taken as given. Unbound callers and operators keep
 * that; only a bound non-operator (app token, in-process bound actor) gets a
 * derived identity.
 */
export function deriveSchemaProposerForTool(): SchemaIdentity {
    if (getCurrentActorScopes() === undefined || exportAllowedForCurrentActor()) return CLAIMED;
    return deriveSchemaIdentity();
}

/** Message used by every surface that refuses on `{ kind: 'refused' }`. */
export const SCHEMA_IDENTITY_REFUSED_MESSAGE = 'schema proposals and approvals require an authenticated caller identity';

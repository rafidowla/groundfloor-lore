/**
 * dataplaneAuthz.ts — Thin wrapper around the Groundfloor SDK's authz
 * endpoints that handles the current response-shape quirks.
 *
 * Background: as of groundfloor-ts-sdk v0.x, `client.checkPermission()`
 * and `client.grantRelation()` don't correctly unwrap the engine's
 * `{success, data: {allowed|granted, ...}, error}` envelope. Direct
 * HTTP returns the right answer; the SDK's `Boolean(result.allowed)`
 * resolves to `false` because `allowed` lives in `result.data`, not
 * at the top level.
 *
 * This wrapper:
 *   - Calls the same endpoints via the SDK's underlying `fetch` so we
 *     inherit auth, base URL, error normalization.
 *   - Unwraps `data.allowed` / `data.granted` correctly, AND remains
 *     compatible if the SDK is later fixed to return flat objects
 *     (`{allowed: true}` directly) — checks both shapes.
 *
 * When the upstream SDK is fixed, this module can be deleted and
 * `rebacGate.ts` can switch back to `client.checkPermission(...)`.
 * Until then, all of Lore's authz calls go through here.
 */

import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type {
    LorePermission,
    LoreResourceType,
} from './rebacGate.js';

/**
 * Subject types are also `lore__*`-prefixed (per the Groundfloor
 * SpiceDB strategy doc). `lore__user` is the only one Lore ever sets
 * today; the type is open in case we ever check service-to-service
 * or workspace-as-subject relations.
 */
export type LoreSubjectType = 'lore__user';

export interface CheckInput {
    subjectType: LoreSubjectType;
    subjectId: string;          // raw id — engine auto-prefixes with tenant
    permission: LorePermission;
    resourceType: LoreResourceType;
    resourceId: string;         // raw id
}

export interface GrantInput {
    subjectType: LoreSubjectType;
    subjectId: string;
    relation: string;
    resourceType: LoreResourceType;
    resourceId: string;
}

/**
 * Internal: call the SDK's protected `fetch` indirectly via a typed
 * any-cast. The SDK exposes `fetch` as protected on `GroundfloorClient`;
 * we don't want to subclass (adds boilerplate to every construction
 * site) so we go through an unchecked cast for this one shared utility.
 */
function rawFetch(client: GroundfloorClient, path: string, body: unknown): Promise<unknown> {
    // The SDK's `fetch` is declared protected but lives on the prototype.
    const f = (client as unknown as { fetch: (p: string, o: RequestInit) => Promise<unknown> }).fetch;
    return f.call(client, path, {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

/**
 * Unwrap a Dataplane authz response — works with either the current
 * envelope shape `{success, data: {<key>: bool}}` or a hypothetical
 * future flat shape `{<key>: bool}`.
 */
export function unwrapAllowed(raw: unknown): boolean {
    if (raw && typeof raw === 'object') {
        const r = raw as { allowed?: unknown; data?: { allowed?: unknown } };
        if (typeof r.allowed === 'boolean') return r.allowed;
        if (r.data && typeof r.data.allowed === 'boolean') return r.data.allowed;
    }
    return false;
}

export function unwrapGranted(raw: unknown): boolean {
    if (raw && typeof raw === 'object') {
        const r = raw as { granted?: unknown; data?: { granted?: unknown } };
        if (typeof r.granted === 'boolean') return r.granted;
        if (r.data && typeof r.data.granted === 'boolean') return r.data.granted;
    }
    return false;
}

export function unwrapRevoked(raw: unknown): boolean {
    if (raw && typeof raw === 'object') {
        const r = raw as { revoked?: unknown; data?: { revoked?: unknown } };
        if (typeof r.revoked === 'boolean') return r.revoked;
        if (r.data && typeof r.data.revoked === 'boolean') return r.data.revoked;
    }
    return false;
}

/**
 * Issue a CheckPermission against the configured Dataplane. Returns
 * `true` only when the engine clearly says allowed; on any malformed
 * shape (defensive) returns `false` — fail-closed.
 */
export async function checkPermission(
    client: GroundfloorClient,
    input: CheckInput,
): Promise<boolean> {
    const raw = await rawFetch(client, '/v1/authz/check', {
        subject:    { type: input.subjectType, id: input.subjectId },
        resource:   { type: input.resourceType, id: input.resourceId },
        permission: input.permission,
    });
    return unwrapAllowed(raw);
}

/**
 * Issue a GrantRelation. Returns the boolean granted flag; defensively
 * `false` on malformed responses (rare — the engine returns 200 with
 * `granted: true` on success and an HTTP error on failure, which the
 * SDK's `fetch` already turns into a thrown GroundfloorError).
 */
export async function grantRelation(
    client: GroundfloorClient,
    input: GrantInput,
): Promise<boolean> {
    const raw = await rawFetch(client, '/v1/authz/grant', {
        subject:  { type: input.subjectType, id: input.subjectId },
        resource: { type: input.resourceType, id: input.resourceId },
        relation: input.relation,
    });
    return unwrapGranted(raw);
}

/** Inverse of grantRelation. */
export async function revokeRelation(
    client: GroundfloorClient,
    input: GrantInput,
): Promise<boolean> {
    const raw = await rawFetch(client, '/v1/authz/revoke', {
        subject:  { type: input.subjectType, id: input.subjectId },
        resource: { type: input.resourceType, id: input.resourceId },
        relation: input.relation,
    });
    return unwrapRevoked(raw);
}

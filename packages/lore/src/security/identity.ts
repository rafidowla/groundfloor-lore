/**
 * identity.ts — Inert identity hook (Phase 1 / C-ent0).
 *
 * Why this exists: a single-user workspace has ONE actor. Multi-user
 * team workspaces have a handful. Enterprise deployments have roles,
 * SSO, and an audit trail. All three need to ask the same question
 * at a hundred points in the code: "who is this call on behalf of?"
 *
 * If that question is never phrased today, every authorization call
 * later becomes a graph-wide refactor. So the hook goes in now,
 * answers "owner" for single-user workspaces, and is swappable:
 *
 *   Single-user:   currentUser() always returns { id: 'owner', ... }.
 *                  No login, no prompt, no UI. The branch that would
 *                  check "is this your node?" returns true trivially.
 *
 *   Multi-user:    a lightweight provider (PIN, OS account, device id)
 *                  returns the right identity for the current session.
 *
 *   Enterprise:    SSO/SAML provider returns the authenticated user and
 *                  their roles; checkAccess consults role permissions.
 *
 * Invariants for single-user deployment:
 *   - currentUser() never blocks, never prompts, never fails.
 *   - Swapping the provider is the ONLY way to change behavior.
 */

export interface LoreUser {
    /** Stable identifier. For single-user workspaces, always 'owner'. */
    id: string;
    /** Human-friendly display name. */
    displayName: string;
    /** Role names. Empty array is "no enterprise roles" — default for single-user. */
    roles: string[];
}

const DEFAULT_OWNER: LoreUser = Object.freeze({
    id: 'owner',
    displayName: 'owner',
    roles: ['owner'],
});

let provider: () => LoreUser = () => DEFAULT_OWNER;

/**
 * currentUser — who is the current request on behalf of?
 *
 * For a single-user workspace: 'owner'. For multi-user: per-session identity from a
 * lightweight provider. For enterprise: SSO. Core code MUST go through
 * this function rather than hard-coding 'owner', so the substrate is
 * ready when multi-user providers plug in.
 */
export function currentUser(): LoreUser {
    return provider();
}

/**
 * setCurrentUserProvider — swap in a non-default identity source.
 *
 * Multi-user auth providers, enterprise-auth, and test harnesses register here.
 * Default stays active unless this is called. Not typed as async to
 * keep the call site in currentUser() cheap — providers that need
 * async work should cache and return sync.
 */
export function setCurrentUserProvider(next: () => LoreUser): void {
    provider = next;
}

/**
 * resetCurrentUserProvider — used only in tests to restore the default.
 */
export function resetCurrentUserProvider(): void {
    provider = () => DEFAULT_OWNER;
}

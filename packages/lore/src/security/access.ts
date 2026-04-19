/**
 * access.ts — Inert access-check hook (Phase 1 / C-ent0).
 *
 * Layered on top of identity.ts. Every graph-read, every node-write,
 * every delete can call `checkAccess(user, nodeId, op)` and get a
 * boolean back. For a personal-deployment, the default provider
 * returns true unconditionally — the branch compiles away to nothing
 * meaningful, but the call site is in place.
 *
 * When a family or enterprise plugin registers a real access provider,
 * every one of those call sites gets upgraded without code changes.
 *
 * What callers should do NOW:
 *   - Pass through checkAccess at natural boundaries (graph reads,
 *     writes, deletes). Return an access-denied error when false.
 *   - DO NOT make the return value load-bearing for personal users —
 *     it's always true.
 *
 * What NOT to do:
 *   - Don't write any policy logic in core. Core only calls the hook.
 *     Policy lives in providers supplied by family/enterprise plugins.
 *   - Don't assume the hook is async. It's sync for personal, which
 *     means the hot path pays nothing. Providers that need async
 *     authorization (e.g. a remote authorization service) should
 *     cache and synchronize internally.
 */

import { currentUser, type LoreUser } from './identity.js';

/** The operation being performed on the node. */
export type AccessOp = 'read' | 'write' | 'delete';

export type AccessCheck = (user: LoreUser, nodeId: string, op: AccessOp) => boolean;

const DEFAULT_ALLOW: AccessCheck = () => true;

let check: AccessCheck = DEFAULT_ALLOW;

/**
 * checkAccess — primary policy question: can THIS user perform OP on NODE?
 *
 * Convenience form: if called with no explicit user, resolves the current
 * user via identity.currentUser().
 *
 * Default impl returns true for every call. That's correct for personal
 * deployment — there are no other users to guard against. Multi-user or
 * enterprise providers replace this via setAccessCheckProvider.
 */
export function checkAccess(nodeId: string, op: AccessOp, user?: LoreUser): boolean {
    return check(user ?? currentUser(), nodeId, op);
}

export function setAccessCheckProvider(next: AccessCheck): void {
    check = next;
}

export function resetAccessCheckProvider(): void {
    check = DEFAULT_ALLOW;
}

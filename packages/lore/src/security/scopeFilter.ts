/**
 * scopeFilter.ts — Row-level security_scopes enforcement for verbatim
 * search results.
 *
 * Lore stores per-row `security_scopes: string[]` on every LoreNode +
 * VerbatimDocument. SpiceDB enforces workspace-grain access (coarse:
 * "this user can read this workspace at all"). This module enforces
 * the fine-grain layer that lives below SpiceDB: "even within a
 * workspace this user is allowed to read, hide rows tagged with
 * scopes the user doesn't hold."
 *
 * Policy:
 *   - empty `security_scopes` on a row  → public-within-workspace; keep
 *   - non-empty `security_scopes`        → keep iff the row's scope set
 *                                          intersects `actorScopes`
 *   - actorScopes === undefined          → no actor bound (local mode /
 *                                          daemon-internal); no filtering
 *   - actorScopes === [] (empty)         → an authenticated actor holding
 *                                          zero scopes; sees ONLY public-
 *                                          within-workspace rows (NOT all
 *                                          rows — that was a fail-open,
 *                                          audit 2026-06-25)
 *
 * Design:
 *   - Library-level helper, no I/O. Callable from VerbatimStore +
 *     DataplaneVectorStore + any future verbatim-shaped backend.
 *   - DOES NOT modify rows; returns a filtered subset.
 *   - Cheap: O(rows × scopes) — fine for the limit-≤-100 result sets
 *     verbatim search returns. Not appropriate for bulk scans.
 */

export interface ScopedRow {
    metadata?: { security_scopes?: string[] | string | null };
}

/**
 * Filter a row set to those the actor is permitted to see based on
 * each row's `security_scopes` and the actor's effective scope set.
 *
 * @param rows         result rows from a verbatim search call
 * @param actorScopes  actor's effective scope set; undefined / empty
 *                     means "no actor context — return all rows"
 * @returns            subset of rows the actor may see
 */
export function applyActorScopeFilter<T extends ScopedRow>(
    rows: T[],
    actorScopes: ReadonlyArray<string> | undefined,
): T[] {
    // undefined → no actor bound (local mode / daemon-internal) → no filtering.
    // An EMPTY array is NOT the same: it is an authenticated actor holding zero
    // scopes and, per ActorContext's contract, must see ONLY public-within-
    // workspace rows. Conflating the two returned every scoped row to a no-scope
    // actor — a fail-open (audit 2026-06-25).
    if (actorScopes === undefined) return rows;
    const allowed = new Set(actorScopes);
    return rows.filter(r => {
        const raw = r?.metadata?.security_scopes;
        const rowScopes = normalizeScopes(raw);
        if (rowScopes.length === 0) return true;          // public-within-workspace
        return rowScopes.some(s => allowed.has(s));       // intersection
    });
}

/**
 * Normalize the on-the-wire shape: VerbatimStore stores arrays, the
 * cloud connector stores a comma-joined string (see dataplaneVectorStore
 * comment around line 220). Callers shouldn't have to care.
 */
export function normalizeScopes(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (typeof raw === 'string' && raw.length > 0) {
        return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
    return [];
}

import { getCurrentActorScopes } from './actorContext.js';

/**
 * 3.1 (2026-08-17) — apply row-level scope confinement to a hydrated
 * `LoreNode[]`. applyActorScopeFilter reads `row.metadata?.security_scopes`,
 * but a LoreNode carries `security_scopes` as a TOP-LEVEL string[] (and
 * `metadata` as a JSON string), so passing nodes straight in is a no-op.
 * Wrap each node in the ScopedRow shape, filter against the bound actor's
 * scopes, and return the survivors. Undefined actor scopes (local mode /
 * daemon-internal) ⇒ no filtering.
 */
export function filterNodesByActorScope<T extends { security_scopes?: string[] }>(nodes: T[]): T[] {
    const wrapped = nodes.map((node) => ({ node, metadata: { security_scopes: node.security_scopes } }));
    return applyActorScopeFilter(wrapped, getCurrentActorScopes()).map((w) => w.node);
}

/**
 * sqliteVerbatimSearchKey.ts - the order-independent filter/scope parts of a SqliteVerbatimStore search-cache key.
 * Shared by search() and bm25Search() so both normalise a query identically (sorted scopes, sorted non-null filter).
 */
import { getCurrentActorScopes } from '../security/actorContext.js';

export function searchKeyParts(
    filter: object | undefined,
    actorScopes: ReadonlyArray<string> | undefined,
): { sortedScopes: string[] | null; normFilter: Record<string, unknown> | null } {
    const scopes = actorScopes ?? getCurrentActorScopes();
    const sortedScopes = scopes ? [...scopes].sort() : null;
    const normFilter = filter
        ? Object.fromEntries(
            Object.entries(filter)
                .filter(([, v]) => v !== undefined && v !== null)
                .sort(([a], [b]) => a.localeCompare(b)),
        )
        : null;
    return { sortedScopes, normFilter };
}

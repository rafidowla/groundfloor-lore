/**
 * collectionsDeps.ts — `CollectionsDeps`, the shared dependency-bag type
 * for every `collection_*` handler, plus `getIntrospectableSchema`.
 *
 * ITEM collections-cycle (2026-09) — split out of collections.ts so that
 * file and collectionsByQuery.ts no longer import VALUES from each other.
 * Before this split, collectionsByQuery.ts imported `handleUpdateByQuery`/
 * `handleDeleteByQuery`/`filterOrRowOrGeneric` (values) from collections.ts,
 * while collections.ts imported `registerCollectionByQueryTools` (a value)
 * from collectionsByQuery.ts — a genuine two-way runtime `require` cycle
 * (not the harmless `import type`-only kind several sibling split files
 * still have back to collections.ts, e.g. collectionsJoin.ts).
 * `handleUpdateByQuery`/`handleDeleteByQuery`/`filterOrRowOrGeneric` moved
 * INTO collectionsByQuery.ts (their sole real consumer besides collections.ts
 * itself, which now imports them back — one-way, an edge that already
 * existed for `registerCollectionByQueryTools`). `CollectionsDeps` and
 * `getIntrospectableSchema` moved HERE because collections.ts's own core
 * handlers (handleInsert, handleUpdate, handleSchemaGet, ...) need them just
 * as much as the by-query handlers do — this module has zero dependencies
 * on either file, so both import it one-way with no cycle.
 *
 * collections.ts re-exports both names so existing importers
 * (collectionsTransaction.ts, collectionsJoin.ts, collectionsQuery.ts,
 * collectionsSchemaList.ts, HTTP routes, tests) keep working unchanged.
 */

import type { ITableStorage, TableSchema } from '../../contracts/tables.js';
import type { StorageBundle } from '../services.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';

export interface CollectionsDeps {
    /**
     * Boot/active-workspace table storage. Used as the fallback when no
     * graphRegistry/store is wired (embedded/cloud mode, tests) so behavior
     * is unchanged from before per-workspace routing existed.
     */
    tableStorage: ITableStorage;
    /**
     * Local-mode per-workspace routing inputs (all OPTIONAL — when absent the
     * resolver returns the boot store and behavior is unchanged):
     *   - store: the boot StorageBundle (carries loreGraph for the active ws)
     *   - graphRegistry: opens/serves each workspace's own LocalGraph
     *   - activeWorkspace: the daemon's currently-active workspace name
     */
    store?: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    activeWorkspace?: string;
}

/**
 * getIntrospectableSchema — same private-map side channel as
 * `handleSchemaGet` (ITableStorage exposes no schema-get method), reused
 * by the row-validation call sites in collections.ts and collectionsByQuery.ts,
 * and by `collectionsTransaction.ts`'s `handleTransaction` (QA finding B2,
 * 2026-09-03: collection_transaction / POST /v1/transaction bypassed
 * collectionRowValidation.ts entirely, silently coercing rows that every
 * other write path rejects). Returns `undefined` when the adapter isn't
 * introspectable — those callers skip pre-validation and behave exactly as
 * before (fail open, never break an adapter that doesn't expose its schemas).
 */
export function getIntrospectableSchema(deps: CollectionsDeps, name: string): TableSchema | undefined {
    const introspectable = deps.tableStorage as ITableStorage & {
        schemas?: Map<string, TableSchema>;
    };
    return introspectable.schemas?.get(name);
}

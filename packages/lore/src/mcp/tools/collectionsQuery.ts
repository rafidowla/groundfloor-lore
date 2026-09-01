/**
 * collectionsQuery.ts — collection_query / collection_count handlers.
 *
 * Split from collections.ts (2026-08-17, file-size cap) — query-side
 * read handlers only; the write/CRUD handlers stay in collections.ts.
 * Deps are structural (Pick of ITableStorage) to avoid an import cycle
 * with collections.ts's CollectionsDeps.
 */

import type { ITableStorage, Row } from '../../contracts/tables.js';
import type { FilterNode, FindOptions } from '../../engines/collectionStorage.js';

export interface QueryResultShape {
    records: Row[];
    total_count: number;
    has_more: boolean;
}

export interface CountResultShape {
    count: number;
    collection: string;
}

/** Structural deps — any CollectionsDeps satisfies this. */
export interface CollectionQueryDeps {
    tableStorage: Pick<ITableStorage, 'query' | 'count'>;
}

export async function handleQuery(
    deps: CollectionQueryDeps,
    collection: string,
    filter: FilterNode | undefined,
    opts: FindOptions | undefined,
): Promise<QueryResultShape> {
    const records = await deps.tableStorage.query(collection, filter, opts);
    // 1.M6 (2026-08-17 audit) — the storage layer applies a default 10,000
    // row cap when no limit is given (SW-18); the handler previously
    // reported total_count = records.length and has_more = false even when
    // the cap had silently truncated the result. When truncation is
    // possible, run a real COUNT(*) so both fields tell the truth. The
    // documented escape hatch ({ limit: Infinity }) now works — storage
    // omits the LIMIT clause for non-finite limits.
    const limit = opts?.limit;
    const explicitFiniteLimit = typeof limit === 'number' && Number.isFinite(limit);
    const mayBeTruncated = explicitFiniteLimit
        ? records.length >= limit
        : records.length >= 10_000;
    if (mayBeTruncated) {
        const total = await deps.tableStorage.count(collection, filter);
        return { records, total_count: total, has_more: total > records.length };
    }
    return { records, total_count: records.length, has_more: false };
}

export async function handleCount(
    deps: CollectionQueryDeps,
    collection: string,
    filter?: FilterNode,
): Promise<CountResultShape> {
    const count = await deps.tableStorage.count(collection, filter);
    return { count, collection };
}

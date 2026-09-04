/**
 * collectionsSchemaList.ts — `collection_schema_list` / `GET /v1/schema`
 * paginated handler (finding B3, round E, 2026-09-03).
 *
 * Split out of collections.ts (file-size cap, mirrors the collectionsQuery.ts
 * 1.M6 split) — this is the only consumer of `ITableStorage.listTables`'s
 * new `offset`/`limit`/`withCounts` options. Deps are structural (Pick of
 * ITableStorage) to avoid an import cycle with collections.ts's
 * CollectionsDeps, same reasoning as collectionsQuery.ts.
 *
 * Why this exists: the original finding #7 fix (`handleSchemaList` in
 * collections.ts, left untouched below for back-compat) enumerated every
 * declared table unconditionally and ran a synchronous `COUNT(*)` per
 * table on every call. Two scale gaps surfaced against it: (1) no cap on
 * response size — 2000 collections is ~1.2MiB of JSON with no entry in
 * scripts/tool-byte-caps.json to catch the drift; (2) the count fan-out
 * blocks Node's single-threaded event loop for ~350ms at 50k tables.
 *
 * This wraps the new `ListTablesOptions` with an opaque base64url cursor
 * (mirrors the cursor shape in `mcp/http/routes/bulkList.ts`) and safe
 * defaults: `DEFAULT_SCHEMA_LIST_LIMIT` entries per page, counts OFF
 * unless the caller opts in. Requests `limit + 1` from storage so
 * `hasMore`/`nextCursor` can be derived without a separate count of the
 * total table set.
 *
 * QA finding B3 (round E2, 2026-09-03): the cursor used to encode a raw
 * numeric offset, but `engines/sqliteTableList.ts` re-sorts the live
 * table-name set on every call — creating a collection whose name sorts
 * before the boundary between two page fetches shifted every later
 * name's position by one, so the boundary entry came back twice (repro:
 * create `aaa_new_table` between fetching page 1 and page 2 of a
 * 10-per-page walk; the old name at index 9 reappears as the new
 * index-9 entry of page 2). The cursor now encodes the *name* of the
 * last entry returned (`after`) and pages via `n > after` in the
 * name-sorted order — a keyset position that doesn't shift when
 * something is created or dropped elsewhere in the set. A cursor from
 * a pre-fix client (`{offset: number}`, no `after` field) fails to
 * decode and falls back to the `offset` param (0 if absent), same as
 * any other malformed cursor — it does not throw or crash a page walk,
 * it just isn't stable, exactly like passing `offset` directly.
 */

import type { ITableStorage, ListTablesOptions } from '../../contracts/tables.js';
import { internalToSdkSchema } from './collectionsSchemaTranslate.js';
import type { SdkCollectionSchema } from './collectionsSchemaTranslate.js';

/**
 * Finding #7 (2026-09-03) — there was no way to enumerate collections
 * short of already knowing a name; `GET /v1/schema` 404'd and no MCP
 * tool existed. `rowCount` is surfaced when the backend reports one
 * (`TableSchemaSummary.rowCount`); adapters that can't produce it
 * cheaply leave it undefined.
 */
export interface SdkCollectionSchemaSummary extends SdkCollectionSchema {
    rowCount?: number;
}

/** Structural deps — any CollectionsDeps satisfies this. */
export interface CollectionSchemaListDeps {
    tableStorage: Pick<ITableStorage, 'listTables'>;
}

export interface SchemaListPageOptions {
    limit?: number;
    offset?: number;
    /** Opaque cursor from a prior page's `nextCursor`. Takes precedence over `offset` when present. */
    cursor?: string;
    /** Compute `rowCount` per returned collection. Default false — see file doc above. */
    withCounts?: boolean;
}

export interface SchemaListPageResult {
    schemas: SdkCollectionSchemaSummary[];
    /** Present only when the page was truncated — pass back verbatim to fetch the next page. */
    nextCursor?: string;
}

export const DEFAULT_SCHEMA_LIST_LIMIT = 100;
export const MAX_SCHEMA_LIST_LIMIT = 1000;

function clampSchemaListLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_SCHEMA_LIST_LIMIT;
    return Math.min(MAX_SCHEMA_LIST_LIMIT, Math.max(1, Math.floor(raw)));
}

function clampSchemaListOffset(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw) || raw < 0) return 0;
    return Math.floor(raw);
}

/**
 * Cursor payload is the name of the last entry returned on the prior
 * page (keyset pagination — see finding B3 round E2 doc above), not a
 * raw offset. A pre-fix cursor (`{offset: number}`, no `after` field)
 * has no `after` string field and decodes to `null` — same as garbage
 * or truncated base64url — so callers on the old cursor shape fall
 * back to the `offset` param cleanly instead of getting a wrong page.
 */
function decodeSchemaListCursor(raw: string): string | null {
    try {
        const json = Buffer.from(raw, 'base64url').toString('utf8');
        const parsed = JSON.parse(json) as { after?: unknown };
        if (typeof parsed.after === 'string' && parsed.after.length > 0) {
            return parsed.after;
        }
        return null;
    } catch {
        return null;
    }
}

function encodeSchemaListCursor(lastName: string): string {
    return Buffer.from(JSON.stringify({ after: lastName }), 'utf8').toString('base64url');
}

export async function handleSchemaListPaged(
    deps: CollectionSchemaListDeps,
    opts: SchemaListPageOptions = {},
): Promise<SchemaListPageResult> {
    const afterName = opts.cursor !== undefined ? decodeSchemaListCursor(opts.cursor) : null;
    const limit = clampSchemaListLimit(opts.limit);
    const withCounts = opts.withCounts ?? false;

    // `after` (keyset, from a valid cursor) takes precedence over
    // `offset` (raw position, unstable under concurrent creates/drops).
    // A missing/malformed cursor falls back to `offset` (0 if also
    // absent) — the same "fall back cleanly" behavior as before.
    const listOpts: ListTablesOptions = afterName !== null
        ? { after: afterName, limit: limit + 1, withCounts }
        : { offset: clampSchemaListOffset(opts.offset), limit: limit + 1, withCounts };

    // Ask for one extra entry so truncation can be detected without a
    // separate count of the full table set.
    const page = await deps.tableStorage.listTables(listOpts);
    const truncated = page.length > limit;
    const visible = truncated ? page.slice(0, limit) : page;
    const schemas = visible.map((s): SdkCollectionSchemaSummary => ({
        ...internalToSdkSchema(s),
        rowCount: s.rowCount,
    }));
    return truncated
        ? { schemas, nextCursor: encodeSchemaListCursor(visible[visible.length - 1]!.name) }
        : { schemas };
}

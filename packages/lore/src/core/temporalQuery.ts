/**
 * temporalQuery.ts — bi-temporal "as-of" query primitive.
 *
 * Half of the bi-temporal storage feature: the OTHER half — deciding
 * whether a new fact contradicts an old one, and therefore whether to set
 * `validUntil` on the old node or `validFrom` on the new one — is explicit
 * application-layer judgment (semantic/LLM territory) and does NOT belong
 * here. This module only answers a mechanical question: "given a moment in
 * time, which nodes were valid then?" It has no opinion on what a node
 * MEANS, only on the `validFrom`/`validUntil` window it was written with
 * (see providers/types.ts `LoreNode`).
 *
 * Deliberately engine-agnostic: built on `GraphProvider.listNodes`, which
 * every backend (SurrealGraph, DataplaneGraph) already
 * implements identically, so this file needs no engine-specific query code
 * and inherits `listNodes`' existing filters, caps, and cross-engine parity
 * for free. The filter itself runs in JS over the candidate rows by default; a
 * graph that offers `listNodesValidAt` (PostgresGraph: real TIMESTAMPTZ columns +
 * one SQL predicate) is used instead, and gives the SAME answers.
 *
 * "AS OF" MEANS VALID TIME. `at` is matched against each node's
 * `validFrom`/`validUntil` ("how things were then"). It is NOT recorded time
 * ("what we knew on date D"); there is no recorded-time mode here, and none is
 * implied by the name. BOUNDARIES ARE INCLUSIVE on both ends (see isValidAsOf).
 *
 * PAGING. `limit` caps the RETURNED page (after the valid-time filter), so a
 * page is full whenever enough matches exist. Order is the listNodes order
 * (`updatedAt` desc, `id` asc); pass the last row's `{updatedAt, id}` as
 * `after` to get the next page.
 */

import type { GraphProvider, LoreNode } from '../providers/types.js';

/**
 * isValidAsOf — the bi-temporal window predicate.
 *
 * `(validFrom is null or validFrom <= at) AND (validUntil is null or
 * validUntil >= at)`. A node that has never been given a valid-time window
 * (both fields null/undefined) is ALWAYS valid — the correct default for
 * ~100% of existing data, which predates this feature and never opted in.
 *
 * Comparison is by parsed instant (`Date.parse`), not raw string ordering,
 * so callers writing `+00:00` vs `Z` (or differing sub-second precision)
 * still compare correctly. A stored bound that fails to parse (malformed
 * caller data) is treated as absent — this predicate never throws on
 * existing rows, only `listNodesAsOf` validates the query timestamp itself.
 */
export function isValidAsOf(
    node: Pick<LoreNode, 'validFrom' | 'validUntil'>,
    atMs: number,
): boolean {
    const from = node.validFrom;
    if (from != null && from !== '') {
        const fromMs = Date.parse(from);
        if (!Number.isNaN(fromMs) && fromMs > atMs) return false;
    }
    const until = node.validUntil;
    if (until != null && until !== '') {
        const untilMs = Date.parse(until);
        if (!Number.isNaN(untilMs) && untilMs < atMs) return false;
    }
    return true;
}

/** Resume point for keyset paging: the last row of the previous page. */
export interface AsOfCursor {
    updatedAt: string;
    id: string;
}

/** What an engine-side as-of implementation receives (`at` already parsed to epoch ms). */
export interface AsOfEngineOptions {
    type?: string;
    tag?: string;
    project?: string;
    ecosystem?: string;
    limit?: number;
    unbounded?: boolean;
    after?: AsOfCursor;
}

/** The minimal graph surface `listNodesAsOf` needs. `listNodesValidAt` is optional
 *  engine acceleration (a SQL predicate); without it the JS fallback runs over
 *  `listNodes`. Satisfied by LocalGraph, SurrealGraph, DataplaneGraph, PostgresGraph, LoreStorageClient. */
export interface AsOfListable {
    listNodes: GraphProvider['listNodes'];
    listNodesValidAt?: (atMs: number, opts: AsOfEngineOptions) => Promise<LoreNode[]>;
}

/** Filters mirror `GraphProvider.listNodes`' own params so this composes
 *  with the exact same scoping/caps callers already know. */
export interface ListNodesAsOfOptions {
    type?: string;
    tag?: string;
    project?: string;
    ecosystem?: string;
    /** Maximum rows RETURNED (after the valid-time filter; SW-18 default cap
     *  applies when omitted). Pages are full whenever enough matches exist. */
    limit?: number;
    unbounded?: boolean;
    /** Keyset cursor: return only rows strictly after this (updatedAt, id). */
    after?: AsOfCursor;
}

/** True when `node` sorts strictly after `c` in the (updatedAt desc, id asc) list order. */
function isAfterCursor(node: Pick<LoreNode, 'updatedAt' | 'id'>, c: AsOfCursor): boolean {
    const u = node.updatedAt ?? '';
    return u < c.updatedAt || (u === c.updatedAt && node.id > c.id);
}

const LIST_CAP = 10_000;

/**
 * listNodesAsOf — nodes valid at a given instant.
 *
 * `at` must be a valid ISO 8601 timestamp; invalid input throws
 * `RangeError` (a caller mistake, not a storage-layer failure — routes
 * should map this to a 400).
 */
export async function listNodesAsOf(
    graph: AsOfListable,
    at: string,
    opts: ListNodesAsOfOptions = {},
): Promise<LoreNode[]> {
    const atMs = Date.parse(at);
    if (Number.isNaN(atMs)) {
        throw new RangeError(`listNodesAsOf: 'at' must be a valid ISO 8601 timestamp, got ${JSON.stringify(at)}`);
    }
    const { type, tag, project = '*', ecosystem = '*', limit, unbounded, after } = opts;
    if (typeof graph.listNodesValidAt === 'function') {
        return graph.listNodesValidAt(atMs, { type, tag, project, ecosystem, limit, unbounded, after });
    }
    // Fallback: widen the candidate window until the filtered page is full or
    // the list is exhausted, then slice. (Filtering a fixed-size page instead
    // returned short pages whenever matches were sparse.)
    const want = unbounded
        ? Infinity
        : (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), LIST_CAP) : LIST_CAP);
    const keep = (n: LoreNode): boolean => isValidAsOf(n, atMs) && (!after || isAfterCursor(n, after));
    const take = (rows: LoreNode[]): LoreNode[] => (Number.isFinite(want) ? rows.slice(0, want) : rows);
    if (!Number.isFinite(want)) {
        return (await graph.listNodes(type, tag, project, ecosystem, undefined, { unbounded: true })).filter(keep);
    }
    let fetchLimit = Math.min(Math.max(want * 4, 200), LIST_CAP);
    for (;;) {
        const candidates = await graph.listNodes(type, tag, project, ecosystem, fetchLimit);
        const matches = candidates.filter(keep);
        if (matches.length >= want || candidates.length < fetchLimit) return take(matches);
        if (fetchLimit >= LIST_CAP) {
            // The capped window was full and still short: only an unbounded scan can find the rest.
            return take((await graph.listNodes(type, tag, project, ecosystem, undefined, { unbounded: true })).filter(keep));
        }
        fetchLimit = Math.min(fetchLimit * 4, LIST_CAP);
    }
}

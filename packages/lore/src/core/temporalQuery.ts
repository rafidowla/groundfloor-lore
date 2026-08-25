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
 * every backend (LocalGraph/Kùzu, SurrealGraph, DataplaneGraph) already
 * implements identically, so this file needs no engine-specific query code
 * and inherits `listNodes`' existing filters, caps, and cross-engine parity
 * for free. The filter itself runs in JS over the candidate page rather than
 * pushed into engine-specific query syntax — the right trade for a first
 * version of a primitive that has to behave identically everywhere.
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

/** The minimal graph surface `listNodesAsOf` needs — one method, satisfied
 *  by LocalGraph, SurrealGraph, DataplaneGraph, and LoreStorageClient alike. */
export interface AsOfListable {
    listNodes: GraphProvider['listNodes'];
}

/** Filters mirror `GraphProvider.listNodes`' own params so this composes
 *  with the exact same scoping/caps callers already know. */
export interface ListNodesAsOfOptions {
    type?: string;
    tag?: string;
    project?: string;
    ecosystem?: string;
    /** Candidate-page limit BEFORE the valid-time filter (same semantics as
     *  listNodes' own `limit` — SW-18 default cap applies when omitted).
     *  Because filtering happens after the page is fetched, a narrow
     *  `limit` combined with a sparse-matching window can under-return;
     *  pass `unbounded: true` for a batch/reporting caller that needs the
     *  true full set. */
    limit?: number;
    unbounded?: boolean;
}

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
    const { type, tag, project = '*', ecosystem = '*', limit, unbounded } = opts;
    const candidates = await graph.listNodes(
        type,
        tag,
        project,
        ecosystem,
        limit,
        unbounded !== undefined ? { unbounded } : undefined,
    );
    return candidates.filter((node) => isValidAsOf(node, atMs));
}

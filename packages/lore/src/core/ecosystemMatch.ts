/**
 * ecosystemMatch.ts — the ONE definition of what `ecosystem` values mean when
 * a scope is compared against a node.
 *
 * ─── Why this file exists ────────────────────────────────────────────────
 *
 * Two incompatible readings of `'*'` shipped side by side:
 *
 *   READING A (strict) — `recall/retrieve.ts`'s seed filter and per-hop filter
 *     compared `node.ecosystem === scope`, so a node stored with `'*'` matched
 *     NOTHING except a `'*'` scope. It was justified as parity with the
 *     keyword path's `n.ecosystem = $ecosystem` predicate, and was widened in
 *     the same round to the MCP `search` tool, `GET /api/search` and
 *     `POST /api/query`.
 *
 *   READING B (wildcard) — `engines/reconnect.ts` `ecosystemConfinement` and
 *     `http/routes/nodes/supersessionCandidates.ts` treat `'*'`/unset as
 *     "unscoped", matching everything, and each carries a paragraph arguing
 *     why confining it would be wrong.
 *
 * They cannot both be right, and the write side settles which one is
 * survivable: `http/routes/nodes/postNode.ts` stamps `'*'` when the caller
 * omits `ecosystem`, `core/bulkNodeScope.ts` `normaliseBulkNodeScope`
 * normalises unset to `UNSET_ECOSYSTEM` (`'*'`), and the `LoreNode.ecosystem`
 * column DEFAULT is literally `'*'`. "Unset" and "'*'" are the SAME stored
 * value by construction — there is no third state to distinguish them.
 *
 * Under READING A, therefore, on any install where `register_project` set a
 * concrete ecosystem, EVERY node written without an explicit `ecosystem` was
 * invisible to `recall` — and, after the search surfaces were aligned to
 * retrieve(), invisible to `search`, `GET /api/search` and `POST /api/query`
 * as well, while autolink still linked it and supersession-candidates still
 * paired it. Silent, total, and with no `crossProject` escape hatch on the
 * search surfaces.
 *
 * ─── The settlement ──────────────────────────────────────────────────────
 *
 * `'*'` (and `''`, its legacy spelling) is a WILDCARD on BOTH sides:
 *
 *   - As a QUERY SCOPE it means search-everything.  (Unchanged.)
 *   - As a NODE VALUE it means "this node is not confined to an ecosystem",
 *     so it is visible from every scope.  (Reading B, now everywhere.)
 *
 * Every JS-level decision point calls {@link ecosystemMatches}; every
 * database-level pushdown on the LOCAL/EMBEDDED substrates widens its
 * predicate the same way, so the pushdown stays a pure optimisation and can
 * never decide a row the JS filter would have kept. The full list, so a missed
 * one is greppable rather than assumed:
 *
 *   - `engines/localGraphReads.ts` — `search`, `listNodes`
 *   - `engines/localGraphDirected.ts` — directed neighbour walk
 *   - `engines/graphBulkList.ts` — `bulkListNodes`
 *   - `engines/surreal/surrealGraphReads.ts` — `search`, `listNodes`
 *   - `engines/surreal/surrealGraphDirected.ts` — directed neighbour walk
 *   - `engines/surreal/surrealGraphAggregates.ts` — `bulkList`
 *   - `engines/arcade/arcadeGraphReads.ts` — `search`, `listNodes`, `bulkList`
 *
 * The three `bulkList` pushdowns were missed when the other eight were
 * widened, and this paragraph claimed otherwise for a round. The concrete
 * consequence: the MCP `list_nodes` tool passes `detectedScope.ecosystem`
 * into `bulkList`, so on any install where `register_project` set a concrete
 * ecosystem it silently omitted EVERY node stored with the `'*'` default.
 *
 * DELIBERATELY EXEMPT: `engines/dataplaneGraph.ts` (`search`, `listNodes`,
 * `bulkList`). Its filter is an SDK equality map with no OR/IN over a single
 * field, so a widened predicate is not expressible there; cloud/Dataplane is
 * deferred (CLAUDE.md, "three deployment modes") and no local or embedded read
 * reaches it. If Dataplane ships, that adapter needs an `ecosystem_in` filter —
 * or a post-fetch {@link ecosystemMatches} pass — before it can claim parity.
 *
 * ─── The residual, stated plainly ────────────────────────────────────────
 *
 * A host that uses one workspace to serve genuinely isolated tenants MUST
 * stamp `ecosystem` on EVERY write. An unstamped node is global to that
 * workspace and every tenant scope will see it. That is a real fail-open, and
 * it is chosen over READING A's fail-closed because:
 *
 *   - the fail-open only bites a workspace that actually holds >1 tenant,
 *     which requires the host to have opted into ecosystem multi-tenancy and
 *     then omitted the field on one write path;
 *   - the fail-closed bit EVERY ordinary single-ecosystem install, hiding
 *     correctly-stored data from its owner with no error and no log.
 *
 * Ecosystem is not, and after this is not claimed to be, a substitute for the
 * workspace boundary. Workspace is the hard isolation boundary in local mode
 * (CLAUDE.md, "Load-bearing consequence"); ecosystem is a scoping dimension
 * INSIDE a workspace that a cooperating host maintains.
 *
 * License: original work for groundfloor-lore.
 */

import { UNSET_ECOSYSTEM } from './bulkNodeScope.js';

export { UNSET_ECOSYSTEM };

/**
 * True when a value carries no ecosystem confinement at all.
 *
 * `'*'` is the canonical spelling (schema DEFAULT + `normaliseEcosystem`);
 * `''`/`undefined`/`null` are the legacy spellings that predate
 * `core/bulkNodeScope.ts` and still exist in stored rows, so they are accepted
 * here rather than being left to mean "an ecosystem literally named empty".
 */
export function isUnscopedEcosystem(value: string | null | undefined): boolean {
    return value === undefined || value === null || value === '' || value === UNSET_ECOSYSTEM;
}

/**
 * Does a node with `nodeEcosystem` belong in a read scoped to `scope`?
 *
 * The ONE predicate every read surface uses — `recall/retrieve.ts` (seeds and
 * every traversal hop), the MCP `search` / `structured_query` / `traverse`
 * tools, `GET /api/search`, `POST /api/query` and `POST /api/recall/bulk`.
 * Callers must not re-implement `===`: that is exactly how the two readings
 * drifted apart.
 */
export function ecosystemMatches(
    nodeEcosystem: string | null | undefined,
    scope: string | null | undefined,
): boolean {
    if (isUnscopedEcosystem(scope)) return true;        // search-everything
    if (isUnscopedEcosystem(nodeEcosystem)) return true; // unconfined node
    return nodeEcosystem === scope;
}

/**
 * Do two NODES sit in ecosystems that must be kept apart?
 *
 * The pair form, for the two surfaces that decide on two node rows rather than
 * on a request scope: autolink candidate selection (`engines/reconnect.ts`)
 * and supersession-candidate pairing. Only a pair naming two DIFFERENT
 * concrete ecosystems is cross-boundary; an unscoped endpoint pairs with
 * anything, which is the same wildcard rule as {@link ecosystemMatches}.
 */
export function isCrossEcosystemPair(
    a: string | null | undefined,
    b: string | null | undefined,
): boolean {
    if (isUnscopedEcosystem(a) || isUnscopedEcosystem(b)) return false;
    return a !== b;
}

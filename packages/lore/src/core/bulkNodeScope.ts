/**
 * bulkNodeScope.ts — the scope fields of a node's VERBATIM row.
 *
 * One concern: `project` and `ecosystem` as they are written to a verbatim
 * (vector) row, and the requirement that the GRAPH row and the VERBATIM row
 * carry the same values for both. Extracted from `bulkWrite.ts` (already over
 * the 800-line cap, see CLAUDE.md's file-size budget) — and worth its own
 * module anyway, because the invariant was previously expressed in three
 * places that drifted apart from each other.
 *
 * Lives in `core/`, not under `mcp/http/routes/`, because the drift is not a
 * route concern: the third writer of verbatim rows is the LOCAL QUEUED path
 * (`outbox/wiring.ts` `storeEmbedBatch`), and `outbox/` must not import from
 * the HTTP layer. Keeping the module inside the routes folder left that path
 * spelling its own convention (`node?.ecosystem ?? ''` — an empty-string
 * "unset" that disagrees with the `'*'` every other writer uses, and that no
 * scoped recall can ever match), which is precisely the drift this module
 * exists to prevent.
 *
 * ─── The invariant, and what breaking it costs ───────────────────────────
 *
 * A node's graph row and its verbatim (vector) row are two representations of
 * ONE fact. If they disagree about scope, each substrate is individually
 * consistent and the pair is wrong — which is the kind of bug that produces no
 * error anywhere:
 *
 *   - `project` is the workspace by invariant (the single-write path,
 *     core/nodeService.ts, enforces it) because
 *     `GET /api/stats?workspace=<ws>` counts rows with project === <ws>. A
 *     bulk write that left project unset/'*' persisted nodes that were fully
 *     retrievable but reported as 0 by stats.
 *   - `ecosystem` is a scoping boundary that recall pushes INTO the vector
 *     query (recall/retrieve.ts `resolveSeedStore`) rather than applying after
 *     hydration. A verbatim row claiming '*' while its graph node says 'acme'
 *     is excluded PRE-HYDRATION from an 'acme'-scoped recall, so the node
 *     silently stops being findable by meaning although nothing about it
 *     changed. (retrieve.ts unions in an unscoped query specifically so rows
 *     already written this way degrade instead of vanishing — but that costs a
 *     second store query on every scoped recall, and the write side is where
 *     the disagreement should not exist in the first place.)
 *
 * Both bulk paths used to hardcode '*' in the verbatim metadata (the inline
 * batch path for BOTH fields). That arrived with the batched-upsert perf work,
 * which — unlike the sibling `upsertOne`, which has always read `node.project`
 * / `node.ecosystem` — has no returned node object to read, so the '*' was a
 * placeholder rather than a decision. The LOCAL queued path (`storeEmbedBatch`
 * in outbox/wiring.ts) has always enriched from the live graph node, which is
 * the tell.
 *
 * License: original work for groundfloor-lore.
 */

import { computeContentHash } from '../engines/contentHash.js';
import type { VerbatimDocument } from '../providers/types.js';

/**
 * The ONE value that means "no ecosystem set" on a stored row.
 *
 * It is `'*'`, not `''`, because that is the `LoreNode.ecosystem` schema
 * DEFAULT and `rowToLoreNode`'s fallback — so an omitted ecosystem lands as
 * the same value on the graph row and the verbatim row on purpose rather than
 * by luck. A row stamped `''` instead is not merely cosmetically different: it
 * can never equal a graph node's `'*'`, so recall's post-hydration check and
 * the vector-query pushdown disagree about it forever.
 */
export const UNSET_ECOSYSTEM = '*';

/** Normalise an ecosystem value for a row being written to either substrate.
 *  Every verbatim writer — the two bulk paths and the outbox's queued
 *  `storeEmbedBatch` — goes through here so none of them can invent its own
 *  spelling of "unset" again. */
export function normaliseEcosystem(value: unknown): string {
    return typeof value === 'string' && value.length > 0 ? value : UNSET_ECOSYSTEM;
}

/**
 * Stamp a raw bulk item's scope fields IN PLACE, to exactly the values
 * `rowToLoreNode` will report for the graph row it is about to become.
 *
 * `project` → the requested workspace when unset/'*' (the project==workspace
 * invariant). `ecosystem` → '*' when unset, matching BOTH the
 * `LoreNode.ecosystem` schema DEFAULT and `rowToLoreNode`'s fallback, so an
 * omitted ecosystem lands as the same value on both representations on
 * purpose rather than by luck.
 */
export function normaliseBulkNodeScope(
    rawRec: Record<string, unknown>,
    requestedWorkspace: string,
): void {
    const proj = rawRec.project;
    if (typeof proj !== 'string' || proj.length === 0 || proj === '*') {
        rawRec.project = requestedWorkspace;
    }
    rawRec.ecosystem = normaliseEcosystem(rawRec.ecosystem);
}

/**
 * Verbatim metadata for a bulk-written node — the ONE place that owns what a
 * bulk node's verbatim row looks like, so the inline and queued paths cannot
 * disagree about scope again. Callers pass the already-normalised raw fields.
 */
export function buildBulkVerbatimMetadata(input: {
    type: string;
    label: string;
    tags: string;
    project: string;
    ecosystem?: string;
    text: string;
    updatedAt?: string;
}): VerbatimDocument['metadata'] {
    return {
        type: input.type,
        label: input.label,
        tags: input.tags,
        project: input.project,
        ecosystem: normaliseEcosystem(input.ecosystem),
        updatedAt: input.updatedAt ?? new Date().toISOString(),
        // PR #69 P2: populate contentHash so the engine doesn't recompute on
        // every write and the sweep can skip-on-match.
        contentHash: computeContentHash(input.text),
    };
}

/**
 * reconnect.ts — V2.1 Graph reconnection engine (core algorithm).
 *
 * Core algorithm knows only about LoreNode (the generic memory primitive).
 * This file has ZERO knowledge of any external node or edge concept.
 *
 * Algorithm:
 *   1. Ensure every LoreNode has an embedding in VerbatimStore.
 *   2. For each LoreNode, stratified top-K search. Canonicalize pairs.
 *   3. Lore ↔ lore edges go directly into LoreEdge (core owns that
 *      rel table).
 *   4. On apply: core prunes LoreEdge inferred edges, then we insert
 *      the fresh batch.
 */

import { createHash } from 'node:crypto';
import { tagsToString } from './normalizeTags.js';
import { isUnscopedEcosystem } from '../core/ecosystemMatch.js';
import type { LoreNode } from '../providers/types.js';
import type { VerbatimStore } from './verbatimStore.js';
import type { DataplaneVectorStore } from './dataplaneVectorStore.js';
import { buildVerbatimText } from './verbatimStore.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';
/**
 * Phase 3 — was `LocalGraph | DataplaneGraph`. Reconnect only ever calls
 * listNodes / bulkList / addEdge / pruneInferredLoreEdges, all of which are on
 * the shared handle, so naming the interface instead of a two-engine union lets
 * semantic-edge rebuilding run on ANY graph backend — including SurrealDB —
 * without touching a line of its logic.
 *
 * `bulkList` is not on `GraphProvider`; every implementation carries it, so it
 * is declared here rather than widening the shared contract in this phase.
 */
export type ReconnectableGraph = LoreGraphHandle & {
    bulkList(q: { limit: number; cursor?: { updatedAt: string; id: string } | null }): Promise<{
        nodes: Array<Record<string, unknown>>;
        hasMore: boolean;
        nextCursor: { updatedAt: string; id: string } | null;
    }>;
};
type LoreGraph = ReconnectableGraph;
type LoreVectorStore = VerbatimStore | DataplaneVectorStore;

const SEMANTIC_PREFIX = 'semantic_neighbor';
const PREFIX_LORE = 'lore:';

/** Cheap, short content hash used by the --only-changed skip path. */
function contentHash(text: string): string {
    return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export interface ReconnectOptions {
    k?: number;
    minSim?: number;
    dryRun?: boolean;
    pruneInferred?: boolean;
    /**
     * V2.1: force re-embedding every node even when its contentHash
     * matches what's already stored. Default `false` — reconsume skips
     * unchanged nodes. Pass `true` to nuke + rebuild the vector space
     * (e.g. after upgrading the embedder or changing the prefix scheme).
     */
    force?: boolean;
    /**
     * C6.5 (Phase 4) — incremental cursor. When set to an ISO timestamp,
     * reconnect only considers nodes whose `updatedAt` is strictly
     * greater than `since`. Massively faster on large stable graphs:
     * after a one-time full sweep, nightly reconnects process only
     * what changed today.
     *
     * Invariant: incremental mode does NOT prune existing inferred
     * edges (`pruneInferred: false` is forced). If you need a clean
     * rebuild, call without `since` (full sweep).
     */
    since?: string;
    /**
     * Cooperative cancellation, polled at every page boundary and every search
     * chunk. Returns true ⇒ stop, skip the edge-application phase entirely, and
     * return what was scanned with `aborted: true`.
     *
     * Exists because a full sweep re-embeds and searches the WHOLE corpus and
     * runs for MINUTES, while every shutdown drain is necessarily bounded (the
     * embedded path has no outer backstop at all — see pendingAutolink.ts
     * property 2). Registering the sweep on a tracker makes shutdown WAIT for
     * it; only this makes shutdown able to wait SUCCESSFULLY. Without it the
     * drain times out and step 10 closes Kùzu + LanceDB underneath a sweep that
     * is still running — the exact use-after-close the registration existed to
     * prevent.
     *
     * The apply phase is skipped rather than run on partial data: prune +
     * re-insert against handles that are about to close is how edges get lost,
     * and an operator-initiated rebuild that reports success while writing into
     * a closing substrate is worse than one that reports it stopped.
     */
    shouldAbort?: () => boolean;
}

export interface ReconnectProposal {
    from: string;
    to: string;
    confidence: number;
}

export interface ReconnectResult {
    candidatesScanned: number;
    embeddingsAdded: number;
    /** How many nodes were skipped because their contentHash matched. */
    embeddingsSkipped: number;
    proposedEdges: ReconnectProposal[];
    applied: boolean;
    /** Edges the core inserted into LoreEdge. */
    coreEdgesInserted: number;
    /** Per-owner pruned counts (core LoreEdge prune). */
    prunedByOwner: Record<string, number>;
    distribution: Record<string, number>;
    /** True when `opts.shouldAbort` stopped the sweep early. `applied` is then
     *  always false — see ReconnectOptions.shouldAbort. Absent on a normal run
     *  so existing response shapes are unchanged. */
    aborted?: boolean;
}

function classifyPrefix(id: string): 'lore' | 'other' {
    return id.startsWith(PREFIX_LORE) ? 'lore' : 'other';
}

/**
 * Ecosystem confinement for autolink candidate search — the ONE place both
 * reconnect entry points derive their scoping decision, so the per-node hook
 * and the bulk sweep cannot drift apart. (They did: round 1 fixed
 * `reconnectOneNode` only, and left `reconnectGraph` — the LARGER producer of
 * cross-ecosystem edges, since it runs over the whole corpus on first install
 * and on every `reconnect` tool call — searching unscoped.)
 *
 * The candidate search runs against the workspace's WHOLE vector index, which
 * in a shared workspace holds every ecosystem's nodes. Without a filter,
 * autolink draws `semantic_neighbor` edges BETWEEN ecosystems, wiring together
 * sets the ecosystem boundary exists to keep apart — and those edges are
 * DURABLE, so it contaminates the graph permanently rather than one query.
 *
 * ─── Why `''` / `'*'` deliberately stay UNSCOPED ─────────────────────────
 *
 * A node with no ecosystem does not get confined to "the ecosystem of nodes
 * with no ecosystem". `'*'` is this codebase's wildcard everywhere else, and
 * unset genuinely means wildcard here, not "unknown":
 *
 *   - `LoreNode.ecosystem`'s schema DEFAULT is literally `'*'`
 *     (localGraph.ts: `ALTER TABLE LoreNode ADD ecosystem STRING DEFAULT '*'`),
 *     so "not supplied" and "all" are the SAME stored value by design.
 *   - `retrieve.ts` reads `ecosystemScope === '*'` as search-everything;
 *     `graph.search(q, n, project, '*')` means all ecosystems.
 *
 * Confining a `'*'` node would therefore invent a semantic the rest of the
 * system does not have, and — because unset IS `'*'` — would silently switch
 * autolink off for every install that never sets an ecosystem, which is the
 * common case, not the exception.
 *
 * The accepted residual: an unscoped node can sit between two ecosystems and
 * be linked to both, so the raw graph does contain a path A → unscoped → B.
 *
 * What contains it — stated in terms of the filter that actually ships (R6 #5;
 * this paragraph used to claim `retrieve.ts` filtered "with strict equality",
 * which DEC-ECOSYSTEM-WILDCARD replaced with `ecosystemMatches` in the same
 * batch that wrote it — retrieve.ts:473 now says "The comparison is
 * `ecosystemMatches`, NOT `===`" in as many words):
 *
 *   - `retrieve.ts` filters BOTH seeds and every traversal HOP, and the scoped
 *     TOPOLOGY walks (`GET /api/subgraph`, `GET /api/node`, MCP `traverse` via
 *     `engines/graphNeighbors.ts` `confinedBfs`) prune their frontier on the
 *     same predicate. So a read scoped to A never reaches B: B names a
 *     concrete, DIFFERENT ecosystem, and `ecosystemMatches('B','A')` is false
 *     at the hop where B would enter.
 *   - The `'*'` node in the middle IS kept, deliberately. That is the wildcard
 *     reading argued for above — unscoped means visible everywhere — not a
 *     leak. It is the reason the path stops at the `'*'` node instead of one
 *     hop earlier, and the reason the residual is worth naming at all.
 *
 * Recall confinement does not depend on this function; this function keeps the
 * stored graph clean for the case that CAN be decided locally (both endpoints
 * name a real, different ecosystem).
 */
function ecosystemConfinement(rawEcosystem: string | undefined): {
    scope: string;
    scoped: boolean;
    filter: { ecosystem: string } | undefined;
} {
    const scope = (rawEcosystem ?? '').trim();
    // `isUnscopedEcosystem` rather than an inline `!== '*'` pair: the wildcard
    // reading argued for above is now the SETTLED, single meaning of '*' for
    // the whole codebase (core/ecosystemMatch.ts), including recall/retrieve.ts,
    // which used to read it strictly. Sharing the predicate is what stops the
    // two readings drifting apart again.
    const scoped = !isUnscopedEcosystem(scope);
    return { scope, scoped, filter: scoped ? { ecosystem: scope } : undefined };
}

/**
 * Union the ecosystem-SCOPED candidate query with the UNSCOPED one, always,
 * whenever a concrete ecosystem is requested — the same backstop
 * `recall/retrieve.ts::seedWithEcosystemUnion` applies, and for the same
 * reason, on the same disagreement.
 *
 * ─── Why a stricter per-hit filter alone SWITCHES AUTOLINK OFF ────────────
 *
 * The pushdown matches the VERBATIM ROW's `metadata.ecosystem`; the
 * authoritative value is the GRAPH NODE's. Rows written by the pre-fix bulk
 * paths carry a literal `'*'` and the outbox path carried `''`. Both were
 * fixed at the WRITE side; neither rewrote history, so those rows are still on
 * disk — `retrieve.ts` got its unconditional union precisely because that data
 * state exists.
 *
 * Without the union here, on a corpus written before that fix EVERY candidate
 * for a node with a real ecosystem fails the pushdown, so `reconnectGraph` /
 * `reconnectOneNode` propose ZERO edges and report success. That is worse than
 * a leak: `reconnectGraph` IS the repair tool an operator runs to rebuild
 * `semantic_neighbor` edges, and it would have silently rebuilt nothing, with
 * no error and no log — on exactly the LongMemEval-shaped corpora that
 * motivated the pushdown.
 *
 * Cost, stated honestly (the pushdown's own rationale was overstated once
 * already): this is TWO store queries per source node instead of one, issued
 * concurrently, so a full sweep's search wall-clock is ~max(scoped, unscoped)
 * ≈ unscoped — i.e. back to the pre-pushdown figure. What the scoped half
 * still buys is candidate QUALITY (other ecosystems cannot crowd this node's
 * real neighbours out of the fixed top-K window). The union is not gated on
 * how full the scoped result looked, because a correctness backstop that only
 * fires when the primary looked thin is not a backstop.
 *
 * Note the cost lands on `reconnectOneNode` too, i.e. on the INGEST path — two
 * vector searches per written node instead of one, for nodes that name a
 * concrete ecosystem. That hook is already fired without being awaited
 * (see engines/pendingAutolink.ts's header for why), so it does not lengthen
 * the synchronous write; it does consume two SearchGate permits instead of one
 * under a write burst. Only `'*'`/unset nodes — the common single-tenant case
 * — are unaffected, since they push no filter and issue one query as before.
 */
async function searchWithEcosystemUnion(
    run: (limit: number, filter?: { ecosystem: string }) => Promise<Array<{ id: string; score?: number }>>,
    limit: number,
    filter: { ecosystem: string } | undefined,
): Promise<Array<{ id: string; score?: number }>> {
    if (!filter) return run(limit, undefined);
    // Scoped first so a store that records its calls sees the optimisation
    // query first; both are in flight together (one round trip, not two).
    const [scoped, unscoped] = await Promise.all([run(limit, filter), run(limit, undefined)]);
    if (unscoped.length === 0) return scoped;
    if (scoped.length === 0) return unscoped;
    const merged = new Map<string, { id: string; score?: number }>();
    for (const h of scoped) merged.set(h.id, h);
    for (const h of unscoped) if (!merged.has(h.id)) merged.set(h.id, h);
    return [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * Verdict on a single candidate hit's verbatim metadata.
 *
 *   inside  — metadata names exactly this scope. Accept, no graph read.
 *   outside — metadata names a DIFFERENT concrete ecosystem. Reject, no read.
 *   unknown — metadata is absent, `''` or `'*'`. Cannot be decided from the
 *             row: that is BOTH what a legacy/placeholder write looks like AND
 *             what a genuinely unscoped (wildcard) node looks like.
 *
 * Only the `unknown` verdict costs a graph lookup, so a corpus written after
 * the write-side fix pays nothing.
 */
type EcosystemVerdict = 'inside' | 'outside' | 'unknown';
function hitEcosystemVerdict(hit: unknown, scope: string): EcosystemVerdict {
    const raw = (hit as { metadata?: { ecosystem?: string } }).metadata?.ecosystem;
    if (raw === scope) return 'inside';
    if (raw === undefined || raw === '' || raw === '*') return 'unknown';
    return 'outside';
}

/** Minimal graph surface the ambiguous-hit resolver needs. Probed, not
 *  required: `reconnect` is called with hand-built graphs in places. */
type NodeReader = { getNode?: (id: string) => Promise<{ ecosystem?: string } | null> };

/**
 * Decide an `unknown` hit against the GRAPH node, which is authoritative.
 *
 * Default is ACCEPT, and that is deliberate rather than lax: the row itself
 * claims `'*'`/unset, which this module's own documented decision
 * (`ecosystemConfinement`) defines as WILDCARD — `LoreNode.ecosystem`'s schema
 * default is literally `'*'`, so "unset" and "all" are one stored value, and
 * such hits were linked freely before the pushdown existed. The graph read is
 * an UPGRADE on that default: it can turn the accept into a reject once the
 * graph proves the node belongs to a different CONCRETE ecosystem. A graph
 * with no `getNode`, or a node that has since been deleted, simply keeps the
 * documented wildcard default.
 *
 * `resolved` memoises within one sweep so a hot candidate is read once.
 */
async function ambiguousHitAllowed(
    graph: NodeReader,
    hitId: string,
    scope: string,
    resolved: Map<string, string>,
): Promise<boolean> {
    if (classifyPrefix(hitId) !== 'lore') return true; // not a LoreNode id — nothing to read.
    if (typeof graph.getNode !== 'function') return true;
    const nodeId = strip(hitId);
    let eco = resolved.get(nodeId);
    if (eco === undefined) {
        try {
            const n = await graph.getNode(nodeId);
            eco = n ? (n.ecosystem ?? '*') : '*';
        } catch {
            eco = '*';
        }
        resolved.set(nodeId, eco);
    }
    return eco === scope || eco === '*' || eco === '';
}

function strip(prefixedId: string): string {
    const i = prefixedId.indexOf(':');
    return i < 0 ? prefixedId : prefixedId.slice(i + 1);
}

/**
 * reconnectGraph — Run the reconnection pass end-to-end. Plugins are
 * queried for their contributed nodes and offered cross-pillar edges.
 */
export async function reconnectGraph(
    graph: LoreGraph,
    verbatim: LoreVectorStore,
    opts: ReconnectOptions = {},
): Promise<ReconnectResult> {
    const k = opts.k ?? 5;
    const minSim = opts.minSim ?? 0.65;
    const dryRun = opts.dryRun ?? true;
    // C6.5: incremental mode forces pruneInferred: false (we're only
    // updating the delta, not rebuilding from scratch).
    const since = opts.since;
    const pruneInferred = since ? false : (opts.pruneInferred ?? true);

    await verbatim.initialize();

    // 1. Embed every LoreNode with the canonical lore: prefix.
    //    V2.1 --only-changed: skip nodes whose contentHash matches the
    //    already-stored embedding. force=true rebuilds unconditionally.
    //    C6.5 incremental: when `since` is set, filter to nodes whose
    //    updatedAt is strictly after the cursor. Nodes that haven't
    //    changed since the last sweep skip the embed AND the search.
    //
    //    SW-20 (E3): page the node load via the cursor-paginated
    //    graph.bulkList instead of `graph.listNodes()` (which materialized
    //    the WHOLE node table — at 1M nodes that's the entire graph in
    //    memory before we even start). And resolve the --only-changed
    //    contentHashes in CHUNKED `id IN (...)` queries per page via
    //    verbatim.getContentHashesByIds, replacing the serial per-node
    //    verbatim.getById (1M nodes ⇒ 1M serial LanceDB scans).
    //
    //    NW-4a: fold the stratified top-K search INTO the paging loop so
    //    `searchInputs` is bounded to one page (PAGE_SIZE entries × verbatim
    //    bytes) regardless of total node count. The pre-NW-4a code retained
    //    `searchInputs` across every page and ran the search only after
    //    `} while (cursor)` finished — which silently undid SW-20's
    //    per-page paging on the dominant memory consumer (the full
    //    verbatim text of every node). The public reconnect API is
    //    unchanged; only the internal buffer changes.
    //
    //    Memory ceiling: peak = N_PAGES_IN_FLIGHT (=1) × PAGE_SIZE ×
    //    avg-verbatim-bytes. With PAGE_SIZE=1000 and a generous 50KB
    //    avg-verbatim, that's ~50MB of working set regardless of corpus
    //    size — the ceiling no longer scales with total nodes.
    let embeddingsAdded = 0;
    let embeddingsSkipped = 0;
    let totalNodes = 0;
    const force = opts.force ?? false;
    const cutoffMs = since ? Date.parse(since) : NaN;
    const incremental = Number.isFinite(cutoffMs);
    let incrementalSeen = 0;

    // Phase-3 stratified top-K state. Edges are aggregated across all pages
    // (their footprint is small — id pairs + a float), but the verbatim
    // TEXT inputs that drive the search are scoped to the current page and
    // discarded before the next bulkList round-trip.
    const WIDE_FACTOR = 8;
    // Audit cluster 5 (2026-08-17): the 'other' pillar (plugin-era ids) is
    // DISCARDED at insertion ("Cross-pillar edges: plugin system removed"),
    // so reserving half the top-K budget for it silently halved the
    // semantic edges actually drawn per node — at most ceil(k/2) instead of
    // k. The lore pillar now gets the full k; the 'other' bucket keeps a
    // small cap purely for `dist`/proposedEdges observability.
    const perKindK = Math.max(2, Math.ceil(k / 2));
    const loreK = Math.max(2, k);
    const seenPair = new Set<string>();
    // Sweep-scoped memo for ambiguousHitAllowed: nodeId -> graph ecosystem.
    // Only ambiguous ('' / '*' / absent metadata) hits ever land here, so a
    // post-write-fix corpus never populates it at all.
    const resolvedEcosystems = new Map<string, string>();
    const proposedEdges: ReconnectProposal[] = [];
    const dist: Record<string, number> = {};
    const SEARCH_CONCURRENCY = 4;

    const PAGE_SIZE = 1000;
    const shouldAbort = opts.shouldAbort ?? ((): boolean => false);
    let aborted = false;
    let cursor: import('../providers/types.js').BulkListCursor | null = null;
    do {
        if (shouldAbort()) { aborted = true; break; }
        const page: import('../providers/types.js').BulkListPage =
            await graph.bulkList({ limit: PAGE_SIZE, cursor });
        // Map raw bulkList rows onto the subset of LoreNode fields reconnect
        // needs. graphBulkList projects security_scopes (SW-20) so embedded
        // metadata keeps its scope tags.
        let pageNodes: LoreNode[] = page.nodes.map((r) => r as unknown as LoreNode);
        cursor = page.nextCursor;

        if (incremental) {
            const before = pageNodes.length;
            pageNodes = pageNodes.filter((n) => {
                const t = n.updatedAt ? Date.parse(n.updatedAt) : 0;
                return t > cutoffMs;
            });
            incrementalSeen += before;
        }
        totalNodes += pageNodes.length;
        if (pageNodes.length === 0) continue;

        // Build (prefixedId, text, hash) for non-empty nodes in this page.
        // NW-4a: `pageSearchInputs` is the per-page search buffer that
        // replaces the cross-page `searchInputs` array; it goes out of
        // scope at the bottom of this do/while iteration so its verbatim
        // text can be reclaimed before the next page is fetched.
        const pageDocs: Array<{ node: LoreNode; prefixedId: string; text: string; hash: string }> = [];
        // Each search input carries its OWN node's ecosystem: a page holds
        // nodes from every ecosystem in the workspace, so confinement has to be
        // decided per source node, not once for the sweep.
        const pageSearchInputs: Array<{
            fromId: string;
            text: string;
            scope: string;
            scoped: boolean;
            filter: { ecosystem: string } | undefined;
        }> = [];
        for (const n of pageNodes) {
            const text = buildVerbatimText(n.label ?? '', n.content ?? '', n.tags ?? '');
            if (!text.trim()) continue;
            const prefixedId = PREFIX_LORE + n.id;
            pageDocs.push({ node: n, prefixedId, text, hash: contentHash(text) });
            pageSearchInputs.push({ fromId: prefixedId, text, ...ecosystemConfinement(n.ecosystem) });
        }
        if (pageDocs.length === 0) continue;

        // SW-20 (E3): bulk-resolve the --only-changed skip set in chunked
        // id IN (...) queries instead of one getById per node.
        const storedHashes = force
            ? new Map<string, string>()
            : await verbatim.getContentHashesByIds(pageDocs.map((d) => d.prefixedId));

        const docsToEmbed: import('./verbatimStore.js').VerbatimDocument[] = [];
        for (const d of pageDocs) {
            if (!force && storedHashes.get(d.prefixedId) === d.hash) {
                embeddingsSkipped++;
                continue;
            }
            const n = d.node;
            docsToEmbed.push({
                id: d.prefixedId,
                text: d.text,
                metadata: {
                    type: n.type ?? 'lore',
                    label: n.label ?? '',
                    tags: tagsToString(n.tags),
                    project: n.project ?? '',
                    ecosystem: n.ecosystem ?? '',
                    updatedAt: n.updatedAt ?? '',
                    security_scopes: n.security_scopes ?? [],
                    contentHash: d.hash,
                },
            });
        }

        // storeBatch per page — bounds the embed working set. Internally:
        //   (a) chunked contentHash lookup against the in-memory + LanceDB cache
        //   (b) batched embedDocumentBatch for cache-miss texts only
        //   (c) bulk LanceDB .add() for all rows
        if (docsToEmbed.length > 0) {
            await verbatim.storeBatch(docsToEmbed);
            embeddingsAdded += docsToEmbed.length;
        }

        // NW-4a: stratified top-K search for THIS page only. Edges
        // discovered here flow into the cross-page `proposedEdges` /
        // `seenPair` aggregators (small footprint); the verbatim text in
        // `pageSearchInputs` is released when the iteration ends.
        //
        // Layer-5 (carried forward): chunks of SEARCH_CONCURRENCY parallel
        // embed+search calls; sequential post-processing for deterministic
        // per-pair dedup. The hit results themselves never escape this
        // page's processing (only the eventual ReconnectProposal does).
        //
        // Ecosystem confinement (see ecosystemConfinement above). Scoped at
        // the QUERY per source node, then re-checked per hit. This sweep — not
        // the per-node hook — is the bulk producer of cross-ecosystem edges:
        // it runs over the entire corpus on first install, on the `reconnect`
        // tool, on `reconsume`, and inside migrateEmbeddingModel.
        for (let i = 0; i < pageSearchInputs.length; i += SEARCH_CONCURRENCY) {
            if (shouldAbort()) { aborted = true; break; }
            const chunk = pageSearchInputs.slice(i, i + SEARCH_CONCURRENCY);
            const results = await Promise.all(chunk.map(async (input) => ({
                fromId: input.fromId,
                scope: input.scope,
                scoped: input.scoped,
                hits: await searchWithEcosystemUnion(
                    (lim, f) => verbatim.search(input.text, lim, f),
                    k * WIDE_FACTOR,
                    input.filter,
                ),
            })));

            for (const { fromId, scope, scoped, hits } of results) {
                const buckets: Record<'lore' | 'other', typeof hits> = { lore: [], other: [] };
                for (const hit of hits) {
                    if (hit.id === fromId) continue;
                    if (scoped) {
                        const verdict = hitEcosystemVerdict(hit, scope);
                        if (verdict === 'outside') continue;
                        if (verdict === 'unknown' && !await ambiguousHitAllowed(graph, hit.id, scope, resolvedEcosystems)) continue;
                    }
                    const pillar = classifyPrefix(hit.id);
                    const sim = hit.score ?? 0;
                    const bucket = `${Math.floor(sim * 20) / 20}`;
                    dist[bucket] = (dist[bucket] ?? 0) + 1;
                    if (sim < minSim) continue;
                    const cap = pillar === 'lore' ? loreK : perKindK;
                    if (buckets[pillar].length < cap) buckets[pillar].push(hit);
                }

                for (const bucketName of ['lore', 'other'] as const) {
                    for (const hit of buckets[bucketName]) {
                        const sim = hit.score ?? 0;
                        const [lo, hi] = fromId < hit.id ? [fromId, hit.id] : [hit.id, fromId];
                        const pairKey = `${lo}::${hi}`;
                        if (seenPair.has(pairKey)) continue;
                        seenPair.add(pairKey);
                        proposedEdges.push({ from: fromId, to: hit.id, confidence: Number(sim.toFixed(3)) });
                    }
                }
            }
        }
        // pageSearchInputs + pageDocs + pageNodes go out of scope here →
        // next iteration cannot hold more than one page in memory.
        if (aborted) break;
    } while (cursor);

    if (incremental) {
        console.error(`[reconnect] incremental: ${totalNodes}/${incrementalSeen} nodes changed since ${since}`);
    }

    if (aborted) {
        // Stop BEFORE prune + insert. A partial apply against handles that are
        // about to close is how edges get lost; the caller is told plainly.
        console.error(`[reconnect] aborted after ${totalNodes} node(s) — shutdown in progress; no edges applied`);
        return {
            candidatesScanned: totalNodes,
            embeddingsAdded,
            embeddingsSkipped,
            proposedEdges,
            applied: false,
            coreEdgesInserted: 0,
            prunedByOwner: {},
            distribution: dist,
            aborted: true,
        };
    }

    if (dryRun) {
        return {
            candidatesScanned: totalNodes,
            embeddingsAdded,
            embeddingsSkipped,
            proposedEdges,
            applied: false,
            coreEdgesInserted: 0,
            prunedByOwner: {},
            distribution: dist,
        };
    }

    // 4. Prune inferred edges. Core wipes LoreEdge with the semantic prefix.
    const prunedByOwner: Record<string, number> = {};
    if (pruneInferred) {
        prunedByOwner.core = await graph.pruneInferredLoreEdges(SEMANTIC_PREFIX);
    }

    // 5. Insert edges. Pure lore↔lore goes into LoreEdge directly;
    //    cross-pillar edges are skipped (plugin system removed in v3.11.0).
    let coreEdgesInserted = 0;

    for (const edge of proposedEdges) {
        // C3-low (2026-08-17) — the relation is the BARE prefix; the score
        // lives only in confidenceScore. Encoding the score in the relation
        // name (`semantic_neighbor:0.912`) made the addEdge dedupe key —
        // (source, target, relation) on every engine — score-sensitive, so a
        // re-embed/reconnect of the same pair with a drifted score added a
        // SECOND edge instead of matching the existing one. prune and the
        // legacy retag migration match on the prefix, so both forms coexist
        // safely; new writes use the stable bare form.
        const relation = SEMANTIC_PREFIX;
        const fromPillar = classifyPrefix(edge.from);
        const toPillar = classifyPrefix(edge.to);

        if (fromPillar === 'lore' && toPillar === 'lore') {
            try {
                // C1 — reconnect edges are semantic inferences, not user
                // assertions. Tag confidence='inferred' with the cosine
                // similarity as the numeric score.
                await graph.addEdge({
                    sourceId: strip(edge.from < edge.to ? edge.from : edge.to),
                    targetId: strip(edge.from < edge.to ? edge.to : edge.from),
                    relation,
                    confidence: 'inferred',
                    confidenceScore: edge.confidence,
                });
                coreEdgesInserted++;
            } catch (err) {
                console.error(`[reconnect] core addEdge failed: ${(err as Error).message}`);
            }
        }
        // Cross-pillar edges: plugin system removed, silently skip.
    }

    return {
        candidatesScanned: totalNodes,
        embeddingsAdded,
        embeddingsSkipped,
        proposedEdges,
        applied: true,
        coreEdgesInserted,
        prunedByOwner,
        distribution: dist,
    };
}

/**
 * reconnectOneNode — Ingest-time hook (Option A). Embeds a new LoreNode
 * and draws semantic edges to its top-K nearest neighbors. Only pure
 * lore↔lore edges are written; cross-pillar edges are not supported.
 *
 * `opts.skipStore` (2026-08-17, functional-correctness 3.1) — when the
 * caller has ALREADY written (or queued, via the outbox) the canonical
 * `lore:<id>` verbatim row for this exact node, pass `skipStore: true` to
 * skip the `verbatim.store()` call below. `search()` embeds `text` itself
 * on every call — it does not need the row to already exist — so this is
 * safe. Without it, `core/nodeService.ts`'s ingest-time autolink hook and
 * its own outbox `verbatim.upsert` row were two independent, unserialized
 * writers of the SAME row: both read-then-write (skip-identical +
 * mergeInsert), so a concurrent landing produced two permanent duplicate
 * canonical rows (and two duplicate #rev snapshots on an update). Default
 * `false` — `v1Migration.ts`'s one-time v1→v2 import loop is the OTHER
 * caller, and there the row genuinely does not exist yet; this call IS what
 * creates it, so it must keep storing.
 */
export async function reconnectOneNode(
    graph: LoreGraph,
    verbatim: LoreVectorStore,
    node: Pick<LoreNode, 'id' | 'label' | 'content' | 'tags' | 'type' | 'project' | 'ecosystem'>,
    opts: { k?: number; minSim?: number; skipStore?: boolean } = {},
): Promise<{ added: number; confidences: number[] }> {
    const k = opts.k ?? 5;
    const minSim = opts.minSim ?? 0.65;
    await verbatim.initialize();

    const text = buildVerbatimText(node.label ?? '', node.content ?? '', node.tags ?? '');
    if (!text.trim()) return { added: 0, confidences: [] };

    const prefixedId = PREFIX_LORE + node.id;
    if (!opts.skipStore) {
        // Append-only: store() auto-snapshots the previous revision.
        await verbatim.store({
            id: prefixedId,
            text,
            metadata: {
                type: node.type ?? 'lore',
                label: node.label ?? '',
                tags: tagsToString(node.tags),
                project: node.project ?? '',
                ecosystem: node.ecosystem ?? '',
                updatedAt: new Date().toISOString(),
                security_scopes: [],
            },
        });
    }

    // Ecosystem confinement — shared with the bulk sweep via
    // `ecosystemConfinement` so the two entry points cannot drift (they did:
    // round 1 fixed only this one). Scope pushed INTO the vector query, UNIONED
    // with the unscoped one so a legacy row whose verbatim metadata disagrees
    // with its graph node is still a candidate (see searchWithEcosystemUnion),
    // then decided per hit against the authoritative graph value.
    const { scope: ecosystemScope, scoped, filter } = ecosystemConfinement(node.ecosystem);
    const resolvedEcosystems = new Map<string, string>();
    const hits = await searchWithEcosystemUnion((lim, f) => verbatim.search(text, lim, f), k + 1, filter);
    const confidences: number[] = [];
    let added = 0;
    for (const hit of hits) {
        if (hit.id === prefixedId) continue;
        if (scoped) {
            const verdict = hitEcosystemVerdict(hit, ecosystemScope);
            if (verdict === 'outside') continue;
            if (verdict === 'unknown' && !await ambiguousHitAllowed(graph, hit.id, ecosystemScope, resolvedEcosystems)) continue;
        }
        const sim = hit.score ?? 0;
        if (sim < minSim) continue;
        // C3-low (2026-08-17) — BARE prefix as the relation (score lives in
        // confidenceScore). Score-in-name made the (source,target,relation)
        // addEdge dedupe key score-sensitive, so re-embedding this node added
        // a SECOND edge to the same neighbour instead of matching the first.
        const relation = SEMANTIC_PREFIX;

        if (classifyPrefix(hit.id) === 'lore') {
            const [lo, hi] = node.id < strip(hit.id) ? [node.id, strip(hit.id)] : [strip(hit.id), node.id];
            try {
                // C1 — per-node reconnect is also inferred. Score is the
                // cosine similarity for this candidate pair.
                await graph.addEdge({
                    sourceId: lo,
                    targetId: hi,
                    relation,
                    confidence: 'inferred',
                    confidenceScore: sim,
                });
                confidences.push(sim);
                added++;
            } catch { /* skip dead edges */ }
            continue;
        }

        // Cross-pillar edges: not supported in core, skip.
    }
    return { added, confidences };
}

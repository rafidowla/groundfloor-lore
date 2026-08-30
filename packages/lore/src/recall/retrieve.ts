/**
 * retrieve.ts — the ONE shared retrieval core (Retrieval Unification, P1).
 *
 * Every surface (REST /api/search + /api/recall, the MCP search + recall tools,
 * embedded recall, the CLI) is meant to call this single function so the same
 * query returns the same results everywhere. See docs/RETRIEVAL_UNIFICATION.md.
 *
 * This is a FAITHFUL extraction of the recall pipeline (semantic + BM25 →
 * reciprocal-rank-fusion → keyword fallback → re-rank → graph traversal → token
 * budget), restructured to return a uniform, presentation-agnostic result set
 * with provenance (`matchedBy`) and a `score` on every result. Presentation
 * concerns (summary vs full shaping, the deferred sidecar, the cross-language
 * hint, auto-escalation) stay in the per-surface PRESETS (P2), not here.
 *
 * Decisions locked in docs/RETRIEVAL_UNIFICATION.md:
 *   - D1: this is the canonical pipeline (extracted from recall/inProcessRecall).
 *   - D3: queries are searched RAW — no typo/normalization/expansion in core.
 *   - D4: one result contract with `matchedBy` + `score` on every result.
 *
 * Scope note (P1): single-workspace is fully implemented here. Cross-workspace
 * (workspace:"*") still lives in mcp/tools/recallCrossWorkspace.ts and is folded
 * into this core in the next increment; calling retrieve() with "*" throws so no
 * surface silently gets a divergent path.
 */

import type { LoreNode } from '../providers/types.js';
import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import type { StorageBundle } from '../mcp/services.js';
import { WorkspaceNotFoundError } from '../engines/localGraphRegistry.js';
import { curatedTypesFromSchema, reRankLoreNodes } from './ranking.js';
import { DEFAULT_SCHEMA_V2 } from '../schemas/types.js';
import { ensureAccessTracker } from '../engines/accessTracker.js';
import { reciprocalRankFusion, estimateTokens } from '../mcp/tools/search/helpers.js';
import { applyActorScopeFilter } from '../security/scopeFilter.js';
import { getCurrentActorScopes } from '../security/actorContext.js';
import { ecosystemMatches } from '../core/ecosystemMatch.js';
import { readBm25Envelope } from '../engines/verbatimBm25Result.js';
import type { Bm25Envelope } from '../engines/verbatimBm25Result.js';
import {
    seedWithEcosystemUnion,
    bm25WithEcosystemUnion,
    type VerbatimSeedHit,
} from './ecosystemSeedUnion.js';

/**
 * D2-recall-1/2 — Row-level security_scopes enforcement on the localGraph
 * reads inside the shared retrieval core.
 *
 * applyActorScopeFilter() (used directly in VerbatimStore.search) reads
 * `row.metadata?.security_scopes`, but a hydrated LoreNode carries
 * `security_scopes` as a TOP-LEVEL string[] and `metadata` as a JSON STRING
 * (see localGraphReads.rowToLoreNode). Passing LoreNodes straight in is a
 * no-op (metadata is a string → `.security_scopes` is undefined → every row
 * looks public). So we wrap each node in the ScopedRow shape the filter
 * expects, filter against the bound actor's scopes, and return the surviving
 * nodes. Mirrors VerbatimStore's `applyActorScopeFilter(mapped, getCurrentActorScopes())`
 * source of scopes; undefined (no bound actor / local mode) ⇒ no filtering.
 */
function filterNodesByActorScope(nodes: LoreNode[]): LoreNode[] {
    const wrapped = nodes.map((node) => ({ node, metadata: { security_scopes: node.security_scopes } }));
    return applyActorScopeFilter(wrapped, getCurrentActorScopes()).map((w) => w.node);
}

/* ─── Unified contract (D4) ────────────────────────────────────── */

/** Which retrieval method(s) surfaced a result. */
export type MatchKind = 'semantic' | 'bm25' | 'keyword' | 'traversal';

export interface RetrievalResult {
    node: LoreNode;
    /** Relative retrieval confidence within THIS result set (0..1). Not
     *  comparable across queries. Seeds carry their method score; traversal
     *  neighbours are depth-decayed. */
    score: number;
    /** Which method(s) found this node. A hybrid seed can be both
     *  'semantic' and 'bm25'; a traversal neighbour is 'traversal'. */
    matchedBy: MatchKind[];
    /** 0 = direct seed match; >0 = graph-traversal hop from a seed. */
    depth: number;
    /** Provenance: 'seed' for a direct match, `via:<seedId>` for a neighbour. */
    source: string;
}

export interface RetrieveOptions {
    /** Target workspace. "*" (cross-workspace) is not yet handled by the core. */
    workspace: string;
    ecosystem?: string;
    /** Retrieval mode. Default 'hybrid' (semantic + BM25 → RRF). */
    mode?: 'semantic' | 'keyword' | 'hybrid';
    /** Graph traversal depth from each seed. 0 = seeds only (the `search`
     *  preset); 1 = include related nodes (the `recall` preset). Default 1. */
    depth?: number;
    /** Max seed/result cardinality. Default 10. */
    limit?: number;
    /** Keep only nodes carrying ALL of these (lowercased) tags. */
    tags?: string[];
    includeArchived?: boolean;
    includeSuperseded?: boolean;
    /** Rough token budget — fills top-ranked nodes until exhausted. */
    maxTokens?: number;
    /** Ignore workspace scope and search every project. */
    crossProject?: boolean;
}

export interface RetrieveMeta {
    /** Top semantic similarity score (0..1) when the vector index was consulted. */
    topScore: number | null;
    /** 1 = keyword only; 2 = vector index also consulted. */
    sourcesConsulted: number;
    /** Result count before token-budget truncation. */
    totalMatched: number;
    truncated: boolean;
    droppedCount: number;
    /** Count of depth-0 (direct seed) matches. */
    directMatches: number;
    /** D5/P14 freshness signal: was the vector index available + consulted? When
     *  false, semantic results are absent (e.g. just-written, not-yet-embedded
     *  content, or a non-active workspace) — keyword still works. */
    verbatimConsulted: boolean;
    /** P16: true when the keyword candidate scan hit SEARCH_SCAN_CAP, so matches
     *  older than the retained window were dropped before ranking (results may be
     *  incomplete). Only the keyword path scans under the cap, so this stays
     *  false on a pure-semantic/vector seed run. */
    scanCapHit: boolean;
    /** Finding 5.3: true when the vector seed window came back FULL yet the
     *  post-hydration filters (archived/superseded/ecosystem/actor-scope)
     *  left fewer live seeds than `limit` even after the adaptive over-fetch
     *  retries — live rows matching the query very likely exist beyond the
     *  scanned window. Callers must not read a thin/empty result carrying
     *  this flag as authoritative absence. Always false on the pure keyword
     *  path (no fixed-size vector window to starve). */
    possibleStarvation: boolean;
}

export interface RetrieveOutcome {
    results: RetrievalResult[];
    meta: RetrieveMeta;
}

export interface RetrieveContext {
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    /**
     * P2 (scalability) — per-workspace verbatim (LanceDB) resolver. When wired,
     * a recall against a NON-active workspace resolves that workspace's OWN
     * verbatim store (getOrOpen) and runs the semantic + BM25 seed pass against
     * it, instead of gating semantic consultation to the boot workspace only.
     * Omitted (cloud mode / test fixtures) ⇒ non-active recall degrades to the
     * keyword path, exactly as before this was threaded in.
     */
    workspaceVerbatimResolver?: {
        getOrOpen(ws: string): Promise<{
            count(): Promise<number>;
            search(query: string, limit: number, filter?: { ecosystem?: string }): Promise<Array<{ id: string; score?: number }>>;
            bm25Search(query: string, limit: number, filter?: { ecosystem?: string }): Promise<Bm25Envelope<{ id: string; score?: number }>>;
        }>;
    };
    /**
     * Types that receive the 1.5× recall type-bias. When omitted, the default
     * schema's operatorCurated types apply (decision, convention, …). Pass an
     * empty set to disable type bias (schema-agnostic caller).
     */
    curatedTypes?: ReadonlySet<string>;
}

/* ─── Internals ────────────────────────────────────────────────── */

const DEFAULT_LIMIT = 10;
const TRAVERSE_CONCURRENCY = 4;
// Over-fetch the vector seeds so archived/superseded rows (which the vector
// store can't exclude in-query) don't starve the live top-`limit` window; the
// hidden filter + slice below trim back to `limit` live seeds. (R4 #3.)
const SEED_HIDDEN_HEADROOM = 4;
// Finding 5.3 — a FIXED over-fetch only moves the starvation threshold from
// `limit` to `limit × SEED_HIDDEN_HEADROOM`: once more hidden
// (archived/superseded) rows than that outrank every live node for a topic,
// the live nodes fall out of the fetched window with no fall-through and no
// signal (the supersede-don't-delete workflow accumulates exactly such rows).
// So when the post-filter seed set comes back under-full AND the store filled
// the entire requested window (i.e. more rows exist beyond it), retrieve()
// re-fetches with a doubled window, up to this multiple of `limit`, before
// giving up — and flags `possibleStarvation` on the response meta when the
// window was STILL full after the final retry, so a starved/empty result is
// never reported as confident absence.
const SEED_MAX_HEADROOM = 16;

/** Minimal view of the graph methods the core uses (keeps casts out of the
 *  pipeline; every `LoreGraphHandle` — Kùzu, SurrealDB, or the Dataplane
 *  cloud adapter — satisfies it). */
interface RetrievalGraph {
    search(q: string, n: number, ws: string, eco: string, excludeHidden?: boolean, signals?: { scanCapHit: boolean }): Promise<LoreNode[]>;
    getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>>;
    traverse(id: string, depth: number): Promise<Array<{ node: LoreNode; depth: number }>>;
}

type HiddenFlags = LoreNode & { supersededAt?: unknown; status?: string };

/** Minimal view of a verbatim (vector) store the seed step needs. Both
 *  `LoreStorageClient` (boot-bound, via a thin adapter below) and a
 *  per-workspace `VerbatimStore` from the resolver satisfy it — actor-scope
 *  filtering happens inside each implementation (getCurrentActorScopes()). */
interface VerbatimSeedStore {
    count(): Promise<number>;
    search(query: string, limit: number): Promise<VerbatimSeedHit[]>;
    bm25Search(query: string, limit: number): Promise<Bm25Envelope<VerbatimSeedHit>>;
}

/**
 * P2 (scalability) — resolve the verbatim store for the READ's OWN workspace.
 *
 * The boot-bound `storageClient` verbatim methods only see the active
 * workspace's LanceDB. Before this, a recall against any NON-active workspace
 * had `verbatimConsulted=false` and fell back to a full-table keyword CONTAINS
 * scan — no semantic/BM25 path — which undercuts local-mode's multi-app
 * promise. The outbox replicator already writes vectors per-workspace and the
 * `WorkspaceVerbatimResolver` (getOrOpen) resolves a workspace's own
 * VerbatimStore, so we thread it here and seed against the target store.
 *
 * Selection:
 *   - Reading the boot/active graph → the boot storageClient adapter (unchanged
 *     path; reuses the daemon's already-open handle).
 *   - Reading a non-active workspace WITH a resolver → getOrOpen(workspace).
 *   - No resolver, or open fails (never-embedded / missing LanceDB) → null,
 *     and the caller degrades gracefully to the keyword path (no throw).
 *
 * assertWorkspaceOpenAllowed runs inside resolver.getOrOpen (the substrate
 * chokepoint), so a bound route slot only opens the workspace it's authorized
 * for — recall opens exactly the workspace the gate resolved.
 */
async function resolveSeedStore(
    ctx: RetrieveContext,
    workspace: string,
    isBootGraph: boolean,
    ecosystemScope: string,
): Promise<VerbatimSeedStore | null> {
    // Push ecosystem scoping INTO the vector/BM25 query itself (the
    // underlying store already supports a metadata filter pushdown — see
    // VERBATIM_FILTERABLE_COLUMNS), instead of fetching a fixed-size GLOBAL
    // top-K window and filtering after hydration. Without this, a workspace
    // shared by many ecosystems crowds a given ecosystem's own real
    // candidates out of that fixed window as unrelated ecosystems'
    // data accumulates — confirmed via the LongMemEval benchmark: raw
    // candidate count for one fixed-size ecosystem fell from 150 to single
    // digits purely as other ecosystems' data piled into the same shared
    // workspace. (The same benchmark note recorded a ~15x seed-latency
    // growth. Do NOT read that as a latency win for the pushdown as it
    // stands: `seedWithEcosystemUnion` always ALSO issues the unscoped
    // query, which is the slow one, so wall clock is back at roughly the
    // pre-pushdown figure. What survives is candidate QUALITY. The full
    // accounting — including the halved scoped-recall throughput and the 4x
    // hydration ceiling in hybrid mode — is on seedWithEcosystemUnion.)
    //
    // CORRECTNESS still belongs to the post-hydration filter further down: it
    // reads the GRAPH node's ecosystem, which is authoritative, whereas the
    // pushdown reads the verbatim ROW's metadata copy, which can disagree.
    // `seedWithEcosystemUnion` therefore ALWAYS pairs the scoped query with the
    // unscoped one so a disagreement degrades instead of deleting real results
    // — see its docstring for why that union cannot be made conditional.
    const filter = ecosystemScope !== '*' ? { ecosystem: ecosystemScope } : undefined;
    if (isBootGraph) {
        // Active/boot workspace — the boot storageClient's verbatim methods see
        // exactly this workspace's LanceDB. Adapt it to the seed-store shape.
        // (Unchanged pre-P2 path.)
        const sc = ctx.store.storageClient;
        return {
            count: () => sc.verbatimCount(),
            search: (q, n) => seedWithEcosystemUnion((lim, f) => sc.verbatimSearch(q, lim, f), n, filter),
            bm25Search: (q, n) => bm25WithEcosystemUnion((lim, f) => sc.verbatimBm25Search(q, lim, f), n, filter),
        };
    }
    // NON-active workspace. The boot storageClient only knows the ACTIVE
    // workspace's vectors, so it must NEVER be used here — seeding a wsB recall
    // from wsA's LanceDB would surface foreign ids (the exact confinement bug,
    // and it also suppresses wsB's keyword fallback when a boot seed id collides
    // with a wsB node). Without a per-workspace resolver we therefore return
    // null → the caller degrades to wsB's own keyword scan (pre-P2 behavior).
    if (!ctx.workspaceVerbatimResolver) return null;
    try {
        const store = await ctx.workspaceVerbatimResolver.getOrOpen(workspace);
        return {
            count: () => store.count(),
            search: (q, n) => seedWithEcosystemUnion((lim, f) => store.search(q, lim, f), n, filter),
            bm25Search: (q, n) => bm25WithEcosystemUnion((lim, f) => store.bm25Search(q, lim, f), n, filter),
        };
    } catch {
        // Never-embedded workspace, missing/corrupt LanceDB, or a chokepoint
        // denial — degrade to the keyword path rather than failing the recall.
        return null;
    }
}

/**
 * retrieve — the single shared retrieval entry point.
 */
export async function retrieve(
    ctx: RetrieveContext,
    query: string,
    opts: RetrieveOptions,
): Promise<RetrieveOutcome> {
    const {
        workspace,
        ecosystem,
        mode = 'hybrid',
        depth = 1,
        limit = DEFAULT_LIMIT,
        tags,
        includeArchived = false,
        includeSuperseded = false,
        maxTokens,
        crossProject = false,
    } = opts;

    if (workspace === '*') {
        // P1 scope — cross-workspace still lives in recallCrossWorkspace.ts and
        // is folded into this core in the next increment. Surfaces route "*"
        // there meanwhile; failing loud here prevents a silent divergent path.
        throw new Error('retrieve(): workspace="*" (cross-workspace) is not yet handled by the shared core — route to runCrossWorkspaceRecall until it is folded in.');
    }

    // 1. Resolve the target graph (named workspace via the registry).
    // getGraphHandle, not getOrOpen: the latter is the Kùzu substrate
    // accessor and returns a LocalGraph for every workspace, so a
    // Surreal-backed one silently read/wrote the empty Kùzu database it
    // still carries. getGraphHandle resolves the workspace's DECLARED
    // engine (and still runs assertWorkspaceOpenAllowed via getOrOpen
    // internally first). `WorkspaceGraph` — like `LoreGraph` — already
    // satisfies `RetrievalGraph` structurally (search/getNodesByIds/
    // traverse are on the shared `GraphProvider` base), so no cast is
    // needed here any more.
    let graph: RetrievalGraph = ctx.store.loreGraph;
    const bootGraph: RetrievalGraph = ctx.store.loreGraph;
    if (ctx.graphRegistry) {
        try {
            graph = await ctx.graphRegistry.getGraphHandle(workspace);
        } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
                throw Object.assign(new Error(`retrieve(): unknown workspace "${workspace}"`), { code: 'workspace_not_found', requested: err.requested, known: err.known });
            }
            throw err;
        }
    }

    // A named workspace already resolves to its own graph. `project` is a
    // caller-owned node field and is not guaranteed to equal the workspace
    // name (Atlas v3 stores project='v3' inside workspace='default'). Using
    // the workspace name here silently makes keyword fallback empty while the
    // vector path still appears healthy. Keep the physical workspace boundary
    // from graph resolution and search all projects inside that graph.
    const workspaceScope = '*';
    const ecosystemScope = crossProject ? '*' : (ecosystem ?? '*');

    // 2. Resolve the verbatim (vector) store for the READ's OWN workspace and
    //    seed semantically against it. P2 (scalability): the boot storageClient
    //    only sees the active workspace's LanceDB, so before this a non-active
    //    recall had NO semantic/BM25 path and fell back to a full-table keyword
    //    scan. `resolveSeedStore` returns the boot store for the active graph
    //    (unchanged), the target workspace's own VerbatimStore when the resolver
    //    is wired, or null (never-embedded / missing store) to degrade to the
    //    keyword path — never throwing. Keyword mode skips the vector seed
    //    entirely, preserving prior keyword-mode behavior.
    const seedStore = mode !== 'keyword'
        ? await resolveSeedStore(ctx, workspace, graph === bootGraph, ecosystemScope)
        : null;
    const verbatimConsulted = seedStore !== null
        ? (await seedStore.count()) > 0
        : false;

    // Provenance for seeds: id -> { matchedBy, score }. Filled by the seed step.
    const seedProvenance = new Map<string, { matchedBy: Set<MatchKind>; score: number }>();
    let seedNodeIds: string[] = [];
    // Raw semantic similarity per STRIPPED graph id, for `meta.topScore`.
    // Recorded during the seed pass but only reduced to a single number at the
    // very END of the pipeline (step 6.5), i.e. after the ecosystem/hidden
    // filters, the re-rank slice, the `tags` filter AND the token-budget
    // truncation — so topScore always describes a node the caller actually
    // receives. It cannot be taken from the raw hit list: `seedWithEcosystemUnion`
    // deliberately includes an unscoped query, so the top raw hit is routinely a
    // node the ecosystem filter then drops — and topScore drives recallPreset's
    // confidence + auto-escalation, which must not be decided by a node the
    // caller never sees.
    const semanticScoreById = new Map<string, number>();
    let topScore: number | null = null;
    let scanCapHit = false;
    // fix/fts-index-and-tokenizer (item 2) — true unless a hybrid-mode bm25
    // seed pass comes back unranked (the LIKE-scan fallback, every hit
    // force-scored 1.0). Unaffected by 'semantic'/'keyword' modes, which
    // never consult bm25Search at all.
    let bm25Ranked = true;
    // Finding 5.3 — see SEED_MAX_HEADROOM. Set after the adaptive over-fetch
    // retries below; only the vector seed path can starve.
    let possibleStarvation = false;

    /**
     * One vector seed pass at the given window size. Clears and refills
     * seedNodeIds / seedProvenance / semanticScoreById, so the adaptive
     * over-fetch retry (5.3) can call it again with a larger window without
     * leaking stale entries from the smaller pass. Returns the size of the
     * raw SEMANTIC window the store handed back — `=== seedFetch` means the
     * store held at least that many rows, i.e. more rows may exist beyond
     * the window (the retry/go signal for the starvation loop).
     */
    const runVectorSeedFetch = async (seedFetch: number): Promise<number> => {
        if (!seedStore) return 0;
        seedProvenance.clear();
        semanticScoreById.clear();
        seedNodeIds = [];
        if (mode === 'semantic') {
            const hits = await seedStore.search(query, seedFetch);
            for (const h of hits) {
                seedProvenance.set(h.id, { matchedBy: new Set<MatchKind>(['semantic']), score: h.score ?? 0 });
                recordSemanticScore(semanticScoreById, h);
            }
            seedNodeIds = hits.map((h) => h.id);
            return hits.length;
        }
        const [semantic, bm25Value] = await Promise.all([
            seedStore.search(query, seedFetch),
            seedStore.bm25Search(query, seedFetch),
        ]);
        // fix/fts-index-and-tokenizer (item 2, follow-up): a bm25Search()
        // result with no usable BM25 ranking behind it (the LIKE-scan
        // fallback forces every hit to score 1.0) must not be fused into
        // RRF alongside a genuinely-ranked semantic list — an arbitrary
        // order is worse than no signal at all ("half a signal beats a
        // corrupted one"). readBm25Envelope is FAIL-CLOSED: `bm25Value`
        // crossed a real boundary (a facade call, possibly the
        // search-worker IPC round trip) — anything that isn't a
        // well-formed `{hits, ranked}` envelope reads as unranked with
        // zero hits, never as "ranked" by default. When unranked, bm25
        // contributes nothing to this seed pass and the read degrades to
        // semantic-only — still the hybrid branch, not the separate
        // keyword-fallback branch below (semantic still seeded).
        const bm25Envelope = readBm25Envelope<VerbatimSeedHit>(bm25Value);
        bm25Ranked = bm25Envelope.ranked;
        const bm25 = bm25Ranked ? bm25Envelope.hits : [];
        const semanticIds = semantic.map((r) => r.id);
        const bm25Ids = bm25.map((r) => r.id);
        const semanticSet = new Set(semanticIds);
        const bm25Set = new Set(bm25Ids);
        seedNodeIds = reciprocalRankFusion(semanticIds, bm25Ids);
        // RRF score per id (same formula, k=60) → normalised to 0..1 for the
        // unified `score`; matchedBy reflects which list(s) contained the id.
        const rrf = rrfScores(semanticIds, bm25Ids);
        const maxRrf = Math.max(1e-9, ...rrf.values());
        for (const id of seedNodeIds) {
            const matchedBy = new Set<MatchKind>();
            if (semanticSet.has(id)) matchedBy.add('semantic');
            if (bm25Set.has(id)) matchedBy.add('bm25');
            seedProvenance.set(id, { matchedBy, score: (rrf.get(id) ?? 0) / maxRrf });
        }
        for (const h of semantic) recordSemanticScore(semanticScoreById, h);
        return semantic.length;
    };

    let seedFetch = limit * SEED_HIDDEN_HEADROOM;
    let rawSeedWindow = 0;
    if (verbatimConsulted) {
        rawSeedWindow = await runVectorSeedFetch(seedFetch);
    }

    // 3. Build the seed node set: hydrate vector seeds, or keyword-search.
    //
    // The keyword branch is a SECOND RETRIEVAL PATH, not merely an
    // "index-is-cold" branch, and it is the only one that is ecosystem-scoped
    // AT THE DATABASE (`graph.search(query, limit, project, ecosystemScope)`).
    // It runs as the PRIMARY path when there are no vector seeds, and as an
    // always-on SUPPLEMENTARY seed source (merged by id) when there are —
    // see Finding 5.1 below.
    const runKeywordSeeds = async (): Promise<LoreNode[]> => {
        const searchSignals = { scanCapHit: false };
        const hits = await graph.search(query, limit, workspaceScope, ecosystemScope, true, searchSignals);
        scanCapHit = searchSignals.scanCapHit;
        hits.forEach((n, idx) => {
            // Keyword rank → 0..1 score; provenance 'keyword'.
            if (!seedProvenance.has(n.id)) seedProvenance.set(n.id, { matchedBy: new Set<MatchKind>(['keyword']), score: 1 / (idx + 1) });
            else seedProvenance.get(n.id)!.matchedBy.add('keyword');
        });
        return hits;
    };

    const hydrateVectorSeeds = async (): Promise<LoreNode[]> => {
        const out: LoreNode[] = [];
        const stripped = seedNodeIds.map((id) => (id.startsWith('lore:') ? id.slice(5) : id));
        const map = await graph.getNodesByIds(stripped);
        // carry seedProvenance keyed by the (possibly lore:-prefixed) id onto the
        // stripped graph id.
        seedNodeIds.forEach((rawId, i) => {
            const sid = stripped[i]!;
            const node = map.get(sid);
            if (node) {
                if (!seedProvenance.has(sid)) seedProvenance.set(sid, seedProvenance.get(rawId)!);
                out.push(node);
            }
        });
        return out;
    };

    /**
     * The seed filter chain, applied identically to whichever branch produced
     * the raw seeds. Kept in one place so the fall-through below cannot apply a
     * different (weaker) set of filters than the primary path.
     *
     * D2-recall-1: drop seeds the actor isn't scoped for BEFORE assembling
     * results. The keyword branch (graph.search) and the vector-hydrate branch
     * (graph.getNodesByIds) both read localGraph directly and neither applies
     * row-level scope filtering — only VerbatimStore does, on the vector path.
     * Vector seeds were already filtered in the store; re-filtering here is
     * idempotent (same actorScopes source), so one pass over the final seed set
     * is simplest and safe. Ranking/order is preserved (filter, not sort).
     *
     * Ecosystem confinement, applied to the vector-hydrate seed path too.
     * THIS is the correctness boundary, not the query pushdown in
     * resolveSeedStore(): it tests the hydrated GRAPH node's ecosystem, which
     * is authoritative. The pushdown tests the verbatim row's metadata COPY of
     * that value, which is an optimisation (it stops other ecosystems crowding
     * the fixed top-K window) and can be stale or wrong — which is precisely
     * why seedWithEcosystemUnion never lets the pushdown be the only thing
     * standing between a node and its recall: it always unions in the unscoped
     * query so THIS check gets to see the disputed rows.
     *
     * The comparison is `ecosystemMatches`, NOT `===`. A node stored with
     * `'*'`/`''` is UNSCOPED and belongs in every scope — that is the settled
     * meaning of `'*'` (core/ecosystemMatch.ts), and `'*'` is the
     * `LoreNode.ecosystem` column DEFAULT, so `===` here hid every node ever
     * written without an explicit ecosystem from its own owner. Two other
     * surfaces in this codebase (engines/reconnect.ts `ecosystemConfinement`,
     * supersessionCandidates.ts) already read `'*'` as a wildcard; the strict
     * reading here was the odd one out. crossProject/'*' (search-everything) is
     * unaffected: ecosystemScope is already '*' there, so this is a no-op.
     */
    const applySeedFilters = (raw: LoreNode[]): LoreNode[] => {
        let s = filterNodesByActorScope(raw);
        if (ecosystemScope !== '*') s = s.filter((n) => ecosystemMatches(n.ecosystem, ecosystemScope));
        if (!includeSuperseded) s = s.filter((n) => !(n as HiddenFlags).supersededAt);
        if (!includeArchived) s = s.filter((n) => (n as HiddenFlags).status !== 'archived');
        return s;
    };

    let seeds: LoreNode[];
    if (!verbatimConsulted || seedNodeIds.length === 0) {
        seeds = applySeedFilters(await runKeywordSeeds());
    } else {
        seeds = applySeedFilters(await hydrateVectorSeeds());

        // ─── Finding 5.3 — adaptive over-fetch against hidden-row starvation ──
        //
        // The vector store can't exclude archived/superseded rows in-query, so
        // the fixed limit×SEED_HIDDEN_HEADROOM window only MOVED the
        // starvation threshold: with >seedFetch higher-similarity hidden rows,
        // every live node fell outside the window and recall reported a
        // confident false negative (verified live: 45 archived + 1 live at
        // similarity 0.950 → totalRecalled 0). When the filtered seed set is
        // under-full but the store FILLED the requested window (so more rows
        // exist beyond it), re-fetch with a doubled window — bounded by
        // SEED_MAX_HEADROOM so a pathological topic costs at most ~3 vector
        // queries. A still-full, still-starved window after the final retry
        // raises `possibleStarvation` so the response is an honest "we could
        // not see far enough", never a confident "no stored memory".
        while (seeds.length < limit && rawSeedWindow >= seedFetch && seedFetch < limit * SEED_MAX_HEADROOM) {
            seedFetch = Math.min(seedFetch * 2, limit * SEED_MAX_HEADROOM);
            rawSeedWindow = await runVectorSeedFetch(seedFetch);
            seeds = applySeedFilters(await hydrateVectorSeeds());
        }
        possibleStarvation = seeds.length < limit && rawSeedWindow >= seedFetch;

        // ─── Finding 5.1 — supplementary keyword seed scan, ALWAYS unioned ──
        //
        // A vector (ANN) search always returns its top-K once the workspace's
        // LanceDB holds ANY row, so `seedNodeIds` is never empty and the
        // keyword branch above was dead code on every populated workspace —
        // and the confinement fall-through that used to sit here was gated on
        // `ecosystemScope !== '*'`, which the DEFAULT scope never satisfies.
        // Consequence: any graph node with NO verbatim row (embed:false
        // writes, failed/dropped embeddings) was permanently unreachable
        // through the default recall path. The keyword scan (bounded at
        // `limit`, the same bound the old fall-through used) now runs on
        // EVERY vector-seeded recall as a supplementary seed source, merged
        // by id exactly as the fall-through merged — it can only ADD nodes
        // the vector window missed, never replace vector seeds. This also
        // subsumes the old ecosystem-confinement fall-through: that gated
        // rescue existed because a foreign ecosystem's vectors could fill
        // seedNodeIds while the DB-scoped keyword scan would have found the
        // requested ecosystem's own nodes; running the scan unconditionally
        // rescues that case and the unscoped default too.
        const byId = new Map(seeds.map((n) => [n.id, n]));
        for (const n of applySeedFilters(await runKeywordSeeds())) {
            if (!byId.has(n.id)) byId.set(n.id, n);
        }
        seeds = [...byId.values()];
    }

    // Finding 5.2 — the tags predicate must select from the WHOLE seed window
    // (the limit×headroom over-fetch plus the keyword supplement), not from
    // whatever survived the top-`limit` re-rank slice. Previously the filter
    // ran AFTER `.slice(0, limit)`, so a genuinely tag-matching node ranked
    // 11th+ was silently excluded and recall asserted the topic had no stored
    // memory. Applied to seeds here; the results-level filter below still
    // covers traversal NEIGHBOURS (they enter after this point).
    if (tags && tags.length > 0) {
        const lowerSeedTags = tags.map((t) => t.toLowerCase().trim());
        seeds = seeds.filter((n) => {
            const nodeTags = n.tags ?? [];
            return lowerSeedTags.every((t) => nodeTags.includes(t));
        });
    }

    // Finding 5.4 — re-rank against each seed's REAL relevance score, not a
    // rank-position proxy: raw vector similarity for semantic hits (recorded
    // during the seed pass), the normalised RRF score for BM25-only hits, the
    // keyword rank score for keyword-only seeds. With `1/(1+idx)` as the base
    // the re-rank's recency term reordered by AGE alone and could drop the
    // strongest semantic match in the window entirely.
    const seedBaseScores = new Map<string, number>();
    for (const n of seeds) {
        const sim = semanticScoreById.get(n.id);
        if (sim !== undefined) { seedBaseScores.set(n.id, sim); continue; }
        const prov = seedProvenance.get(n.id)?.score;
        if (prov !== undefined) seedBaseScores.set(n.id, prov);
    }
    const curatedTypes = ctx.curatedTypes ?? curatedTypesFromSchema(DEFAULT_SCHEMA_V2.nodeTypes);
    seeds = reRankLoreNodes(seeds, undefined, seedBaseScores, curatedTypes).slice(0, limit);

    // fix/fts-index-and-tokenizer (item 2): sourcesConsulted must not claim
    // 2 (semantic + bm25) when the hybrid seed pass ran but bm25 came back
    // unranked and was excluded from fusion above — only semantic actually
    // contributed. mode==='semantic' is unaffected (bm25Ranked stays at its
    // true default there, matching its pre-existing "2" behavior).
    const sourcesConsulted = !verbatimConsulted ? 1 : (mode === 'hybrid' && !bm25Ranked ? 1 : 2);
    if (seeds.length === 0) {
        return { results: [], meta: { topScore, sourcesConsulted, totalMatched: 0, truncated: false, droppedCount: 0, directMatches: 0, verbatimConsulted, scanCapHit, possibleStarvation } };
    }

    // 4. Assemble the result set: seeds at depth 0, plus optional traversal.
    const collected = new Map<string, RetrievalResult>();
    for (const n of seeds) {
        const prov = seedProvenance.get(n.id) ?? { matchedBy: new Set<MatchKind>(['keyword']), score: 0 };
        collected.set(n.id, { node: n, score: prov.score, matchedBy: [...prov.matchedBy], depth: 0, source: 'seed' });
    }

    if (depth > 0) {
        for (let i = 0; i < seeds.length; i += TRAVERSE_CONCURRENCY) {
            const batch = seeds.slice(i, i + TRAVERSE_CONCURRENCY);
            const hops = await Promise.all(batch.map((sn) => graph.traverse(sn.id, depth)));
            batch.forEach((sn, idx) => {
                // D2-recall-2: traversal neighbours come straight from
                // graph.traverse (localGraph) with no scope filtering — a
                // restrictive-scoped node could leak in via a graph hop from an
                // allowed seed. Filter each hop's nodes through the actor's
                // scopes before they enter the collected set.
                const allowedHops = new Set(
                    filterNodesByActorScope(hops[idx]!.map((item) => item.node)).map((n) => n.id),
                );
                for (const item of hops[idx]!) {
                    const n = item.node as HiddenFlags;
                    if (!allowedHops.has(item.node.id)) continue;
                    // Ecosystem confinement on every HOP, not just on seeds.
                    // graph.traverse() walks LoreEdge with no ecosystem
                    // predicate, so a correctly-scoped seed could still pull a
                    // DIFFERENT ecosystem's node into the result set across an
                    // edge (autolink used to draw exactly such cross-ecosystem
                    // edges — see engines/reconnect.ts). Same predicate and
                    // same '*' escape hatch as the seed filter above, so
                    // crossProject search-everything is unaffected.
                    if (ecosystemScope !== '*' && !ecosystemMatches(item.node.ecosystem, ecosystemScope)) continue;
                    if (!includeSuperseded && n.supersededAt) continue;
                    if (!includeArchived && n.status === 'archived') continue;
                    if (collected.has(n.id)) continue;
                    // Neighbours are weaker than seeds; depth-decayed score.
                    collected.set(n.id, { node: item.node, score: 0.3 / (1 + item.depth), matchedBy: ['traversal'], depth: item.depth, source: `via:${sn.id}` });
                }
            });
        }
    }

    // 5. Order: seeds (already re-ranked) first, then neighbours by depth.
    let results = Array.from(collected.values()).sort((a, b) => a.depth - b.depth);

    if (tags && tags.length > 0) {
        const lower = tags.map((t) => t.toLowerCase().trim());
        results = results.filter((r) => {
            const nodeTags = (r.node as { tags?: string[] }).tags ?? [];
            return lower.every((t) => nodeTags.includes(t));
        });
    }

    // 6. Token-budget truncation.
    const totalMatched = results.length;
    let truncated = false;
    let droppedCount = 0;
    if (maxTokens && maxTokens > 0) {
        let budget = maxTokens;
        const kept: RetrievalResult[] = [];
        for (const r of results) {
            const est = estimateTokens(r.node);
            if (budget - est < 0 && kept.length > 0) break;
            kept.push(r);
            budget -= est;
        }
        if (kept.length < results.length) { droppedCount = results.length - kept.length; truncated = true; results = kept; }
    }

    // 6.5 topScore is reduced from the FINAL `results`, after EVERY step that
    //     can remove a node: the actor-scope / ecosystem / hidden filters, the
    //     re-rank `.slice(0, limit)`, the `tags` filter, and the token-budget
    //     truncation. Reducing it any earlier reproduces the bug it was meant
    //     to fix, one stage later — `tags` is a first-class parameter on the
    //     MCP `search`/`recall` tools and on REST, so a perfectly ordinary call
    //     (nodes hi=0.99 / lo=0.10, `tags: ['keepme']` carried only by `lo`)
    //     returned `['lo']` with `topScore: 0.99`. topScore drives
    //     recallPreset's confidence AND its auto-escalation threshold, so it
    //     must never be derived from a node the caller does not receive.
    //     Depth-0 only: a traversal neighbour is not a semantic match, and its
    //     score is the depth decay, not a similarity. Null (nothing semantic
    //     survived) reads the same as "vector index not consulted", which is
    //     the honest signal.
    for (const r of results) {
        if (r.depth !== 0) continue;
        const s = semanticScoreById.get(r.node.id);
        if (s !== undefined && (topScore === null || s > topScore)) topScore = s;
    }

    // 7. Warm the hot-access cache — stamp the read's OWN workspace (never boot),
    //    and only warm the boot-bound session cache for the active workspace.
    ensureAccessTracker(graph)?.touch(results.map((r) => r.node.id), 'retrieval');
    if (graph === bootGraph) {
        for (const r of results) ctx.store.sessionCache.pushNode(r.node.id);
    }

    return {
        results,
        meta: {
            topScore: topScore !== null ? parseFloat(topScore.toFixed(3)) : null,
            sourcesConsulted,
            totalMatched,
            truncated,
            droppedCount,
            directMatches: results.filter((r) => r.depth === 0).length,
            verbatimConsulted,
            scanCapHit,
            possibleStarvation,
        },
    };
}

/** Record a raw semantic similarity under the STRIPPED graph id, so it can be
 *  matched against hydrated seeds later (hit ids may carry the `lore:` prefix,
 *  graph node ids never do). Keeps the max when both forms of an id appear. */
function recordSemanticScore(into: Map<string, number>, hit: VerbatimSeedHit): void {
    const id = hit.id.startsWith('lore:') ? hit.id.slice(5) : hit.id;
    const score = hit.score ?? 0;
    const prev = into.get(id);
    if (prev === undefined || score > prev) into.set(id, score);
}

/** Per-id reciprocal-rank-fusion score (mirrors helpers.reciprocalRankFusion's
 *  internal formula; that helper returns only the ordered ids, so we recompute
 *  the scores here to expose them on the unified result). */
function rrfScores(semanticIds: string[], bm25Ids: string[], k = 60): Map<string, number> {
    const scores = new Map<string, number>();
    const add = (ids: string[]) => ids.forEach((id, idx) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1)));
    add(semanticIds);
    add(bm25Ids);
    return scores;
}

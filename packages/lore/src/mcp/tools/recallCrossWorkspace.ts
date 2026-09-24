/**
 * recallCrossWorkspace.ts — Cross-workspace recall aggregation (Phase 6 P1.C).
 *
 * Extracted from search.ts to stay within the 800-line file cap.
 *
 * Iterates every workspace listed in workspaces.json via the registry,
 * collects hits from each, merges by score, dedupes by id (highest-
 * scoring source wins), and tags each row with the source workspace.
 *
 * Scoring: EACH WORKSPACE's own semantic seed list and keyword-hit list are
 * fused via the shared reciprocal-rank-fusion (recall/rrf.ts, 3.21 step 3(b))
 * — not Math.max of two incomparable scales, which is what this used to do
 * (raw cosine similarity 0..1 vs a synthetic keyword-rank score capped at
 * 0.3; a node found by both kept whichever number was numerically larger).
 * A node present in multiple workspaces under the same id only surfaces from
 * the workspace where it actually lives (looked up against each workspace's
 * LocalGraph via getNode, satisfying the no-double-count constraint); ACROSS
 * workspaces the higher FUSED score wins — a "which physical copy wins" pick
 * between two same-shape scores, not a fusion of two retrieval methods.
 *
 * Out of scope (P1.C): per-workspace verbatim partitioning, traversal
 * expansion (depth always 0 here — cross-workspace traversal opens an
 * edge-semantics question that lives in a later slice).
 */

import type { LoreNode } from '../../providers/types.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import type { VerbatimStoreApi } from '../../engines/verbatimStoreApi.js';
import type { DataplaneVectorStore } from '../../engines/dataplaneVectorStore.js';
import type { ISessionCache } from '../../engines/sessionCache.js';
import { listWorkspaceNames } from '../../config/workspaces.js';
import { curatedTypesFromSchema, rankScore } from '../../recall/ranking.js';
import { DEFAULT_SCHEMA_V2 } from '../../schemas/types.js';
import { ecosystemMatches } from '../../core/ecosystemMatch.js';
import { resolveRecallFanoutWsCap, resolveRecallFanoutConcurrency, mapWithConcurrency } from '../../recall/recallFanout.js';
import { rrfFuse } from '../../recall/rrf.js';
import { redactError } from '../../security/logRedact.js';
import { notApplicableRelevanceMeta } from '../../recall/abstention.js';
import { applyActorScopeFilter } from '../../security/scopeFilter.js';
import { getCurrentActorScopes } from '../../security/actorContext.js';
import type { LoreGraphHandle } from '../../storage/loreStorageClient.js';
import { resolveLiveNodes } from '../../recall/supersessionRecall.js';

/**
 * D2-recall-1/2 — Row-level security_scopes enforcement for the cross-workspace
 * keyword/seed hydration path. A hydrated LoreNode carries `security_scopes` as
 * a top-level string[] and `metadata` as a JSON string, so applyActorScopeFilter
 * (which reads `metadata.security_scopes`) must be fed via the ScopedRow shape.
 * Mirrors VerbatimStore's actor-scope source (getCurrentActorScopes()); undefined
 * (no bound actor) ⇒ no filtering. wsGraph.getNodesByIds + wsGraph.search read
 * each workspace's LocalGraph directly and apply no scope filter themselves.
 */
function filterNodesByActorScope(nodes: LoreNode[]): LoreNode[] {
    const wrapped = nodes.map((node) => ({ node, metadata: { security_scopes: node.security_scopes } }));
    return applyActorScopeFilter(wrapped, getCurrentActorScopes()).map((w) => w.node);
}

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
type LoreGraph = LoreGraphHandle;
type LoreVerbatim = VerbatimStoreApi | DataplaneVectorStore;

export interface CrossWorkspaceRecallArgs {
    topic: string;
    depth: number;
    includeSuperseded: boolean;
    includeArchived?: boolean;
    tags?: string[];
    /**
     * fix/3.22.1-d1-recall-option-parity — D2 node TYPE/KIND prefilter,
     * ANY-of, mirrors RetrieveOptions.types.
     *
     * fix/3.22.1-recall-parity review fix (2): as of this fix, `types` IS
     * pushed into each workspace's own seed queries too, same as the
     * single-workspace retrieve() core — the semantic seed pass (via
     * VerbatimQueryFilter.type on verbatimStore.search()/per-workspace
     * store.search()) AND the keyword pass (via GraphProvider.search()'s
     * `types` positional arg). Each workspace still runs its own
     * semantic + keyword pass independently, so this is N separate
     * pushdowns, not one shared seed query. The post-merge filter below
     * (applied to the fused candidate set) is KEPT as a backstop — it is
     * what makes this correct even if a future seed path forgets the
     * pushdown, and it is also what narrows nodes hydrated via the legacy
     * boot-seed ids path. Omitted/empty = no filter (prior behavior).
     */
    types?: string[];
    registry: LocalGraphRegistry;
    verbatimStore: LoreVerbatim;
    sessionCache: ISessionCache;
    responseMode: 'summary' | 'full';
    queryLanguage?: string;
    maxTokens?: number;
    /**
     * F-LOW-T14: when set, restrict the fan-out to this explicit set of
     * workspace names (the bound principal's allowedWorkspaces ∪ its own
     * workspace). Undefined = no restriction (e.g. a cross-workspace-read
     * principal with no explicit allow-list, or the null-principal local
     * path) — preserves prior behavior.
     */
    allowedWorkspaces?: string[];
    /**
     * R4 #3 — ecosystem scope for the fan-out. Absent/'*' = every ecosystem
     * (unchanged). The aggregator used to scan every workspace with a
     * hardcoded '*' and then REPORT `scope.ecosystem: '*'`, which was at least
     * honest — but it left `recall` unable to honour a caller-supplied scope on
     * the one branch that reads the most data, so a multi-tenant host could
     * scope a named-workspace recall and not a "*" one. Pushed down AND
     * enforced in JS below (the pushdown is an optimisation only, per
     * core/ecosystemMatch.ts).
     */
    ecosystem?: string;
    /**
     * P2 (scalability) — per-workspace verbatim (LanceDB) resolver. When wired,
     * each fanned-out workspace runs its OWN semantic seed pass against its own
     * verbatim store (getOrOpen), so a node that lives only in workspace B's
     * LanceDB still surfaces semantically — before this, the fan-out seeded once
     * from the BOOT store, so only nodes ranking in boot's top-N were ever
     * semantic seeds anywhere. Omitted ⇒ the legacy boot-seed behavior (each
     * workspace hydrates the boot store's global seed ids) is preserved.
     */
    workspaceVerbatimResolver?: {
        getOrOpen(ws: string): Promise<LoreVerbatim>;
    };
}

function estimateTokens(node: LoreNode): number {
    return Math.ceil(((node.label?.length ?? 0) + (node.content?.length ?? 0)) / 4);
}

export async function runCrossWorkspaceRecall(
    args: CrossWorkspaceRecallArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const {
        topic, includeSuperseded, includeArchived, tags, types, registry, verbatimStore,
        sessionCache, responseMode, maxTokens, allowedWorkspaces, workspaceVerbatimResolver,
    } = args;
    const ecosystemScope = args.ecosystem ?? '*';
    const SUMMARY_MAX_HITS = 10;
    const SNIPPET_LEN = 120;
    const KEYWORD_LIMIT_PER_WORKSPACE = 10;
    const SEED_LIMIT = 20;

    // F-LOW-T14: restrict the workspace universe to the bound principal's
    // allow-list (∪ own workspace) BEFORE any fan-out, so a scoped principal
    // never receives hits from workspaces outside its allowed set via
    // workspace:"*". Undefined allowedWorkspaces = no restriction (preserves
    // prior behavior for the null-principal local path and for a
    // cross-workspace-read principal with no explicit allow-list).
    const allowSet = allowedWorkspaces && allowedWorkspaces.length > 0
        ? new Set(allowedWorkspaces)
        : null;
    // Defect 3 follow-up (3.20.2) — scope the enumeration to the SAME home
    // `registry` itself reads (an embedded instance's own dataHome), not the
    // process-wide loreHome() default; otherwise an embedded cross-workspace
    // recall would fan out over the wrong process's workspace list entirely.
    // `homeDir` is read defensively: `registry` is typed as LocalGraphRegistry
    // but several existing callers pass a minimal duck-typed fake (only
    // `getGraphHandle`, no `homeDir`) — falling back to `undefined` there
    // preserves the exact prior behavior (listWorkspaceNames()'s own
    // loreHome() default) instead of throwing.
    const registryHome = typeof (registry as { homeDir?: () => string }).homeDir === 'function'
        ? (registry as { homeDir: () => string }).homeDir()
        : undefined;
    const workspaceNames = allowSet
        ? listWorkspaceNames(registryHome).filter((ws) => allowSet.has(ws))
        : listWorkspaceNames(registryHome);
    // P2 (scalability): when a per-workspace verbatim resolver is wired, each
    // fanned-out workspace seeds from its OWN verbatim store (below), so we skip
    // the single boot-store seed entirely — a node that lives only in workspace
    // B's LanceDB must be a semantic seed for B, which the boot store can't
    // provide. Without a resolver, keep the legacy path: seed once from the boot
    // store and hydrate those global ids in every workspace's graph.
    const perWorkspaceSeeding = !!workspaceVerbatimResolver;
    let seeds: Array<{ id: string; score: number }> = [];
    let verbatimCount = 0;
    if (!perWorkspaceSeeding) {
        try {
            verbatimCount = await verbatimStore.count();
            if (verbatimCount > 0) {
                // fix/3.22.1-recall-parity review fix (2) — push `types` INTO
                // the boot-store seed query itself (VerbatimQueryFilter.type
                // accepts string|string[] → IN(...) pushdown), mirroring the
                // single-workspace retrieve() core (resolveSeedStore). This
                // widens the SEED WINDOW to already-typed candidates instead
                // of relying solely on the post-merge filter below, which can
                // only narrow a fixed-size window that may already be
                // crowded out by off-type rows.
                const sem = await verbatimStore.search(topic, SEED_LIMIT, types && types.length > 0 ? { type: types } : undefined);
                seeds = sem.map((r) => ({
                    id: r.id.startsWith('lore:') ? r.id.slice(5) : r.id,
                    score: r.score ?? 0,
                }));
            }
        } catch (err) {
            // Vector store unreadable (e.g. corrupted/missing LanceDB fragment) — degrade
            // to keyword-only recall instead of failing the whole call. The per-workspace
            // keyword search below is already defensively wrapped (.catch(() => [])). Reset
            // verbatimCount so downstream searchMode diagnostics report 'keyword', not 'hybrid'.
            verbatimCount = 0;
            // F-LOW-T07: redact ids/paths from the raw error before logging so a
            // corrupted-store message can't leak workspace ids or filesystem paths.
            console.error(`[recall] verbatim search unavailable, falling back to keyword-only: ${redactError(err)}`);
        }
    }
    // Tracks the best semantic score seen across all workspaces' seed passes
    // (per-workspace mode) or the boot seed's top score (legacy mode) — drives
    // the summary confidence + top_score meta. Filled during the fan-out below.
    let topSemanticScore = seeds.length > 0 ? seeds[0]!.score : null;
    // In per-workspace mode, `verbatimCount > 0 anywhere` is what makes the
    // aggregate report searchMode 'hybrid'; each workspace flips this when its
    // own store has content + a readable semantic result.
    let anySemanticConsulted = false;

    interface Candidate { node: LoreNode; workspace: string; score: number; source: string }
    const byId = new Map<string, Candidate>();
    const projectsSeen: string[] = [];

    // Bounded fan-out: cap the workspace set BEFORE opening graphs (so a huge
    // workspaces.json never forces every graph handle open) and scan with bounded
    // parallelism. Ported from the former HTTP-only handler so this one shared
    // implementation carries the scale protection for MCP + embedded + REST.
    const candidateWorkspaces = workspaceNames.slice(0, resolveRecallFanoutWsCap());
    const globalSeedIds = seeds.map((s) => s.id);
    const perWs = await mapWithConcurrency(
        candidateWorkspaces,
        resolveRecallFanoutConcurrency(),
        async (ws): Promise<{ ws: string; seedNodes: Map<string, LoreNode>; wsSeeds: Array<{ id: string; score: number }>; kwHits: LoreNode[]; scanCapHit: boolean; liveId: Map<string, string> } | null> => {
            let wsGraph: LoreGraph;
            try {
                wsGraph = await registry.getGraphHandle(ws);
            } catch {
                return null;
            }
            // P2: per-workspace semantic seed pass. Resolve THIS workspace's own
            // verbatim store and search it, so a node embedded only in this
            // workspace's LanceDB surfaces semantically here. A never-embedded /
            // corrupt store degrades to keyword for this workspace (catch → []).
            let wsSeeds: Array<{ id: string; score: number }> = [];
            if (perWorkspaceSeeding) {
                try {
                    const store = await workspaceVerbatimResolver!.getOrOpen(ws);
                    if ((await store.count()) > 0) {
                        // fix/3.22.1-recall-parity review fix (2) — same
                        // pushdown as the legacy boot-store seed above, per
                        // workspace.
                        const sem = await store.search(topic, SEED_LIMIT, types && types.length > 0 ? { type: types } : undefined);
                        wsSeeds = sem.map((r) => ({
                            id: r.id.startsWith('lore:') ? r.id.slice(5) : r.id,
                            score: r.score ?? 0,
                        }));
                    }
                } catch (err) {
                    // Per-workspace store unreadable — this workspace degrades to
                    // keyword-only; the fan-out as a whole keeps going.
                    console.error(`[recall] per-workspace verbatim unavailable, keyword-only for this workspace: ${redactError(err)}`);
                }
            }
            // The seed ids to hydrate in THIS workspace's graph: its own semantic
            // seeds (per-workspace mode) or the boot store's global ids (legacy).
            const hydrateIds = perWorkspaceSeeding ? wsSeeds.map((s) => s.id) : globalSeedIds;
            // SW-16: batch-hydrate all semantic seeds in ONE `id IN [...]` query.
            // R4 #3: excludeHidden=true on the keyword scan so archived/superseded
            // don't crowd a live hit out of the per-workspace window.
            // P16: capture this workspace's scan-cap-hit so the aggregate below
            // can flag "results may be incomplete".
            const kwSignals = { scanCapHit: false };
            const [seedNodes, kwHits] = await Promise.all([
                hydrateIds.length > 0
                    ? wsGraph.getNodesByIds(hydrateIds).catch(() => new Map<string, LoreNode>())
                    : Promise.resolve(new Map<string, LoreNode>()),
                // fix/3.22.1-recall-parity review fix (2) — `types` pushed
                // into the keyword-leg query too (7th positional arg on
                // GraphProvider.search — see providers/types.ts), same as
                // the single-workspace retrieve() core's keyword leg
                // (retrieve.ts's own `graph.search(..., typesFilter)` call).
                wsGraph.search(topic, KEYWORD_LIMIT_PER_WORKSPACE, '*', ecosystemScope, true, kwSignals, types).catch(() => [] as LoreNode[]),
            ]);
            // D2-recall-1/2: scope-filter both the hydrated semantic seeds and
            // the keyword hits per workspace, so rows tagged with scopes the
            // actor doesn't hold never enter the cross-workspace merge.
            // R4 #3: the ecosystem scope is applied in the SAME place — the
            // semantic seeds are hydrated by id out of the graph, so the
            // pushdown above never sees them.
            const inEcosystem = (n: LoreNode): boolean =>
                ecosystemMatches((n as { ecosystem?: string }).ecosystem, ecosystemScope);
            const scopedSeedNodes = filterNodesByActorScope([...seedNodes.values()]).filter(inEcosystem);
            const scopedKwHits = filterNodesByActorScope(kwHits).filter(inEcosystem);
            // D5 #5 — this per-workspace hydration used to just HIDE a
            // superseded hit at merge time (`if (!includeSuperseded &&
            // node.supersededAt) continue`, below in the caller). Resolve
            // to the live successor HERE instead, per workspace (each
            // workspace's own graph is the only place that can answer "who
            // superseded this"), so a stale node's slot in the merged
            // cross-workspace list is replaced rather than dropped-with-no-
            // trace. `includeSuperseded:true` skips resolution entirely —
            // the caller explicitly asked to see superseded nodes as-is.
            // D5 re-review — a successor is fetched fresh from wsGraph AFTER
            // the actor-scope filter above ran on the original hits, so it
            // must pass that same filter here or a restricted-scope successor
            // would leak through a visible superseded node.
            const admitD5 = (n: LoreNode): boolean =>
                inEcosystem(n) && (includeArchived === true || n.status !== 'archived')
                && filterNodesByActorScope([n]).length > 0;
            // superseded id → live successor id, so the RRF below can rank
            // the successor in the superseded hit's slot (the fused lists are
            // id-keyed; without this the old id missed every lookup and the
            // slot was silently dropped).
            const liveId = new Map<string, string>();
            const [resolvedSeedNodes, resolvedKwHits] = includeSuperseded
                ? [scopedSeedNodes, scopedKwHits]
                : await Promise.all([
                    resolveLiveNodes(scopedSeedNodes, wsGraph, admitD5, liveId),
                    resolveLiveNodes(scopedKwHits, wsGraph, admitD5, liveId),
                ]);
            const filteredSeedNodes = new Map(resolvedSeedNodes.map((n) => [n.id, n] as const));
            const filteredKwHits = resolvedKwHits;
            return { ws, seedNodes: filteredSeedNodes, wsSeeds, kwHits: filteredKwHits, scanCapHit: kwSignals.scanCapHit, liveId };
        },
    );

    // Merge in workspace order so the "highest score wins" tie-break is
    // deterministic (matches the previous serial behavior).
    let anyScanCapHit = false;
    for (const entry of perWs) {
        if (!entry) continue;
        const { ws, seedNodes, kwHits } = entry;
        if (entry.scanCapHit) anyScanCapHit = true;
        projectsSeen.push(ws);
        // P2: in per-workspace mode the semantic seeds are THIS workspace's own
        // seed pass; in legacy mode they are the shared boot-store seeds.
        const wsSeeds = perWorkspaceSeeding ? entry.wsSeeds : seeds;
        if (perWorkspaceSeeding && wsSeeds.length > 0) {
            anySemanticConsulted = true;
            const wsTop = wsSeeds[0]!.score;
            if (topSemanticScore === null || wsTop > topSemanticScore) topSemanticScore = wsTop;
        }

        // 3.21 step 3(b) — fuse THIS workspace's semantic seed list with its
        // keyword-hit list via the ONE shared RRF (recall/rrf.ts), instead of
        // taking Math.max of two INCOMPARABLE scales (raw cosine similarity
        // 0..1 vs a synthetic keyword-rank score capped at 0.3) — the fusion
        // bug the owner flagged: a node found by both a workspace's semantic
        // pass and its keyword scan kept whichever scale happened to produce
        // the larger number, not a genuine fused rank. RRF fuses rank
        // POSITION, so the two scales never get compared directly.
        //
        // Cross-WORKSPACE dedup (the `byId` map below, same id physically
        // present in two workspaces) still picks the higher FUSED score —
        // that is a "which physical copy wins" choice between two rows of
        // the SAME kind of score, not a fusion of two retrieval methods, so
        // it stays a plain max.
        // Rewrite superseded ids to their live successor (first occurrence
        // keeps the better rank; a successor that was also its own hit
        // lower down collapses onto the superseded slot, as in retrieve()).
        const toLive = (ids: string[]): string[] =>
            [...new Set(ids.map((id) => entry.liveId.get(id) ?? id))];
        const semanticIds = toLive(wsSeeds.map((s) => s.id));
        const kwIds = kwHits.map((n) => n.id);
        const fused = rrfFuse([semanticIds, kwIds]);
        const semSet = new Set(semanticIds);
        const kwById = new Map(kwHits.map((n) => [n.id, n] as const));
        for (const f of fused) {
            const node = seedNodes.get(f.id) ?? kwById.get(f.id);
            if (!node) continue;
            if (!includeSuperseded && node.supersededAt) continue;
            if (!includeArchived && node.status === 'archived') continue;
            const existing = byId.get(node.id);
            if (!existing || f.score > existing.score) {
                byId.set(node.id, { node, workspace: ws, score: f.score, source: semSet.has(f.id) ? 'semantic' : 'keyword' });
            }
        }
    }

    // Whether the semantic (vector) substrate was consulted at all — drives the
    // 'hybrid' vs 'keyword' searchMode + freshness meta. Per-workspace mode:
    // true if ANY workspace's own verbatim store had content. Legacy mode: the
    // boot-store count (verbatimCount).
    const semanticConsulted = perWorkspaceSeeding ? anySemanticConsulted : verbatimCount > 0;

    const curatedTypes = curatedTypesFromSchema(DEFAULT_SCHEMA_V2.nodeTypes);
    let merged = Array.from(byId.values())
        .map((c) => ({ ...c, fs: rankScore({ node: c.node, baseScore: c.score, curatedTypes }) })).sort((a, b) => b.fs - a.fs);

    if (tags && tags.length > 0) {
        const lowerTags = tags.map((t) => t.toLowerCase().trim());
        merged = merged.filter((c) =>
            lowerTags.every((t) => (c.node.tags ?? []).includes(t)));
    }

    // fix/3.22.1-d1-recall-option-parity — D2 type/kind prefilter, ANY-of
    // (matches RetrieveOptions.types semantics). fix/3.22.1-recall-parity
    // review fix (2): now a BACKSTOP, not the only filter — each workspace's
    // own seed queries above already push `types` into the semantic +
    // keyword passes (see the `types` field's doc comment on
    // CrossWorkspaceRecallArgs). Kept here because it is still correct and
    // cheap, and it also covers nodes hydrated via the legacy boot-seed ids
    // path (which has no per-workspace query of its own to push into).
    if (types && types.length > 0) {
        const typeSet = new Set(types);
        merged = merged.filter((c) => typeSet.has(c.node.type));
    }

    // Feature 3 — token-budget truncation.
    const totalMatched = merged.length;
    let truncated = false;
    let dropped = 0;
    if (maxTokens && maxTokens > 0) {
        let budget = maxTokens;
        const budgeted: typeof merged = [];
        for (const c of merged) {
            const est = estimateTokens(c.node);
            if (budget - est < 0 && budgeted.length > 0) break;
            budgeted.push(c);
            budget -= est;
        }
        if (budgeted.length < merged.length) {
            dropped = merged.length - budgeted.length;
            truncated = true;
            merged = budgeted;
        }
    }

    // L-022: cross-workspace aggregation (workspace:"*") is an explicit
    // multi-store read with no single owning hot-session — the boot
    // workspace's hot_session.json must NOT be warmed with foreign-
    // workspace ids that do not physically live in its graph. Single-
    // workspace recall still warms its own active cache (recallTool.ts).
    // (`sessionCache` arg retained for signature stability / Option B.)
    void sessionCache;

    const tokenMeta = maxTokens ? { truncated, dropped_count: dropped, total_matched: totalMatched } : {};

    if (responseMode === 'summary') {
        const trimmed = merged.slice(0, SUMMARY_MAX_HITS);
        const meta: Record<string, unknown> = {
            confidence: merged.length === 0 ? 0 : (topSemanticScore !== null && topSemanticScore >= 0.65 ? 0.7 : 0.4),
            ...(merged.length === 0 ? { negative_evidence: `No knowledge nodes match topic "${topic}" across any workspace in workspaces.json (searched: ${projectsSeen.join(', ') || 'none'}).` } : {}),
            ...(topSemanticScore !== null ? { top_score: parseFloat(topSemanticScore.toFixed(3)) } : {}),
            sources_consulted: semanticConsulted ? 2 : 1,
            vector_index_consulted: semanticConsulted, // P14 freshness signal
            ...(anyScanCapHit ? { scan_cap_hit: true } : {}),
            ...tokenMeta,
            // D1: cross-workspace aggregation merges scores via Math.max across
            // workspaces (a D3-scoped scale-mixing issue, not touched here) and
            // has no single workspace to calibrate against, so it reports
            // "not applicable" rather than a calibrated relevance/abstention
            // verdict. Never abstains.
            ...notApplicableRelevanceMeta('cross_workspace'),
        };
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    topic,
                    mode: 'summary',
                    searchMode: semanticConsulted ? 'hybrid' : 'keyword',
                    workspace: '*',
                    crossWorkspace: true,
                    scope: { workspace: '*', ecosystem: ecosystemScope },
                    totalRecalled: merged.length,
                    shown: trimmed.length,
                    projectsSeen,
                    hits: trimmed.map((c) => ({
                        id: c.node.id,
                        type: c.node.type,
                        label: c.node.label,
                        project: c.node.project,
                        workspace: c.workspace,
                        tags: c.node.tags,
                        snippet: typeof c.node.content === 'string'
                            ? (c.node.content.length > SNIPPET_LEN
                                ? c.node.content.slice(0, SNIPPET_LEN).replace(/\s+/g, ' ').trim() + '…'
                                : c.node.content.replace(/\s+/g, ' ').trim())
                            : null,
                        source: c.source,
                        ...(c.node.stale ? { stale_warning: true } : {}),
                    })),
                    tip: 'Cross-workspace recall (workspace:"*") merges hits from every entry in workspaces.json. Same id across workspaces is deduped by highest score; the `workspace` field on each hit identifies the physical source.',
                    _meta: meta,
                }, null, 2),
            }],
        };
    }

    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                topic,
                mode: 'full',
                searchMode: semanticConsulted ? 'hybrid' : 'keyword',
                workspace: '*',
                crossWorkspace: true,
                scope: { workspace: '*', ecosystem: ecosystemScope },
                totalRecalled: merged.length,
                projectsSeen,
                ...(anyScanCapHit ? { scan_cap_hit: true } : {}),
                ...tokenMeta,
                knowledge: merged.map((c) => ({
                    id: c.node.id,
                    type: c.node.type,
                    label: c.node.label,
                    content: c.node.content,
                    tags: c.node.tags,
                    project: c.node.project,
                    workspace: c.workspace,
                    source: c.source,
                    language: c.node.language ?? null,
                    ...(c.node.stale ? { stale_warning: true } : {}),
                })),
            }, null, 2),
        }],
    };
}

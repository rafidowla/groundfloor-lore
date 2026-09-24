/**
 * inProcessRecall.ts — In-process recall for embedded Lore hosts (P2/Atlas).
 *
 * Exposed on LoreInstance as lore.recall(topic, opts) — no HTTP round-trip, no
 * MCP transport overhead. Returns a typed RecallResult.
 *
 * Retrieval Unification (P2): this is now a thin wrapper. The retrieval
 * (semantic + BM25 → RRF → traversal → budget) is the shared retrieve() core;
 * the response shaping is the shared buildRecallResult() preset. Single-
 * workspace recall therefore returns exactly what the MCP `recall` tool and REST
 * /api/recall return — they can no longer drift.
 *
 * Cross-workspace (workspace:"*") still delegates to runCrossWorkspaceRecall
 * and unwraps its JSON envelope.
 */

import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import type { StorageBundle } from '../mcp/services.js';
import { retrieve, type RetrieveContext } from './retrieve.js';
import type { LexicalBaseMode } from './candidateWindow.js';
import { buildRecallResult } from './recallPreset.js';
import { runCrossWorkspaceRecall } from '../mcp/tools/recallCrossWorkspace.js';

// Re-export the canonical RecallResult shape (moved to recallPreset). Importers
// (server.ts, index.ts) keep importing it from here.
export type {
    RecallHit, RecallNode, RecallMeta, RecallResultSummary, RecallResultFull, RecallResult,
} from './recallPreset.js';
import type { RecallResult } from './recallPreset.js';

/* ─── Public types ─────────────────────────────────────────────── */

export interface RecallOpts {
    /** Target workspace (required). Pass '*' for cross-workspace recall. */
    workspace: string;
    /** Ecosystem filter. Defaults to '*' (all ecosystems). */
    ecosystem?: string;
    /** Graph traversal depth from each seed node. Default 1. */
    depth?: number;
    /** Response verbosity. 'summary' (default) = compact hits for AI agents;
     *  'full' = rich node bodies for programmatic / human use. */
    mode?: 'summary' | 'full';
    /** When true, ignores workspace scope and searches every project. */
    crossProject?: boolean;
    /** Include soft-superseded nodes. Default false. */
    includeSuperseded?: boolean;
    /** Filter results to nodes that carry ALL listed tags. */
    tags?: string[];
    /**
     * fix/3.22.1-d1-recall-option-parity — D2 node TYPE/KIND prefilter,
     * ANY-of. Mirrors the `recall` MCP tool's `types` param and
     * RetrieveOptions.types (retrieveTypes.ts). Omitted/empty = no filter.
     * Was accepted by retrieve()/the MCP tool/REST since D2 but silently
     * dropped by this embedded surface — this is the fix for that gap.
     *
     * Single-workspace (`workspace` is a name): pushed INTO the vector +
     * BM25 seed queries, not applied after the fixed-size seed window.
     *
     * Cross-workspace (`workspace: '*'`, fix/3.22.1-recall-parity review
     * fix (2)): pushed into EACH fanned-out workspace's own semantic +
     * keyword seed queries (see CrossWorkspaceRecallArgs.types in
     * recallCrossWorkspace.ts), with an identical post-merge filter over
     * the fused candidate set kept as a backstop.
     */
    types?: string[];
    /** Rough token budget — fills top-ranked nodes until exhausted. */
    maxTokens?: number;
    /** Include archived (status="archived") nodes. Default false. */
    includeArchived?: boolean;
    /** Retrieval mode. Default 'hybrid' (BM25 + semantic RRF). */
    searchMode?: 'semantic' | 'keyword' | 'hybrid';
    /** ISO 639-1 query language; adds cross-language hint when corpus differs. */
    queryLanguage?: string;
    /** File paths from the host's current context (Q1.7 deferred surfacing). */
    filePaths?: string[];
    /**
     * Maximum number of candidate seed nodes. Default: 10.
     * fix/3.22.1-recall-parity review fix (1) — clamped to [1, 100]
     * (matching the `recall` MCP tool's/REST's own `max` bound); a value
     * outside that range is silently clamped, not rejected, since this is
     * a permissive embedded API rather than a schema-validated tool arg.
     * Also now threaded into buildRecallResult's `maxHits`, which sizes the
     * summary-mode display cap — previously only retrieve()'s own seed
     * `limit` honoured `max`, so `lore.recall(t, {max:25})` in summary mode
     * still silently capped at 10 (the historic hardcoded
     * SUMMARY_MAX_HITS in recallPreset.ts).
     */
    max?: number;
    /**
     * 3.21 step 4 (r9 recall-quality fix) — up to 5 EXTRA phrasings of
     * `topic`, run alongside it and fused into ONE ranked list via the
     * shared reciprocal-rank-fusion (recall/rrf.ts). Mirrors the `recall`
     * MCP tool's `queries` param and retrieve()'s own `queries` option —
     * this was the one gap between the embeddable `lore.recall()` surface
     * and the MCP tool (both call the same shared retrieve() core, which
     * has always supported it). Omitted/empty is exactly today's
     * single-phrasing behaviour — default unchanged.
     */
    queries?: string[];
    /** Keep only nodes whose stored `entities` (set via `questions`/
     *  `entities` at write time) contain ALL of these values. Mirrors the
     *  `recall` MCP tool's `entities` param. */
    entities?: string[];
    /** Same as `entities`, over stored `topics`. Mirrors the `recall` MCP
     *  tool's `topics` param. */
    topics?: string[];
    /** Keep only nodes whose `project` field equals this value exactly.
     *  Mirrors the `recall` MCP tool's `project` param. */
    project?: string;
    /**
     * D1 (calibrated relevance + abstention) — when true, gate results to
     * empty (with `_meta.abstained: true`) when the query's calibrated
     * relevance falls below `relevanceFloor`, unless an exact identifier
     * token rescues it. Default false/unset — calibration + `_meta` are
     * always computed and reported; this option only controls whether a
     * low-relevance query is GATED. Mirrors the `recall`/`search` MCP
     * tools' `abstain` param and `LORE_RECALL_ABSTAIN`.
     */
    abstain?: boolean;
    /** D1 — override the default relevance floor (z-score, default 2.0)
     *  used when `abstain` is true. Mirrors the MCP tools' `relevance_floor`
     *  param and `LORE_RECALL_RELEVANCE_FLOOR`. */
    relevanceFloor?: number;
    /** D1 — opt into the key-term coverage abstention signal (only used when
     *  `abstain` is on). Mirrors `LORE_RECALL_ABSTAIN_TERM_COVERAGE`. */
    abstainTermCoverage?: boolean;
    /** Optional cancellation (fix/search-worker-call-cancellation, 3.20.2, req.
     *  3; follow-up closed the gap noted below). An abort rejects the OUTER
     *  recall promise immediately so a caller who gave up doesn't wait out
     *  the whole retrieve() pipeline — AND, as of the follow-up, is now
     *  threaded into `retrieve()`'s own options (see the single-workspace
     *  path below), which forwards it through resolveSeedStore() to the
     *  actual seed-store search()/bm25Search() calls. An abort therefore
     *  frees the SearchGate permit/queue slot the underlying native call was
     *  holding or waiting on, not just this promise's own wait. (Previously:
     *  "does NOT interrupt native work already under way inside retrieve()" —
     *  that gap is what this follow-up closes for the single-workspace path;
     *  the cross-workspace path (runCrossWorkspaceRecall) is unchanged and
     *  still only gets the outer-promise-level cancellation.) */
    signal?: AbortSignal;
    /** D3 (docs/design/D3-prefix-stable-ranking.md §3.1/§3.6) — per-call
     *  override for the candidate-generation window floor and the
     *  lexical-only base-score mode. Only the in-process embedding surface
     *  (this call) gets these as explicit params; MCP tool schemas and the
     *  REST route are intentionally NOT extended — the env knobs
     *  (LORE_RECALL_CANDIDATE_FLOOR / LORE_RECALL_LEXICAL_BASE) cover those
     *  surfaces. Undefined on both ⇒ falls through to the env/default via
     *  retrieve()'s own resolution. */
    candidateFloor?: number;
    lexicalBase?: LexicalBaseMode;
}

function toAbortError(signal: AbortSignal): Error {
    const reason = (signal as { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    const err = new Error(reason !== undefined ? String(reason) : 'aborted');
    err.name = 'AbortError';
    return err;
}

export interface InProcessRecallDeps {
    store: StorageBundle;
    /** Per-workspace registry. Required for workspace:"*" and named-workspace
     *  routing; optional when only the active/boot workspace is used. */
    graphRegistry?: LocalGraphRegistry;
    /**
     * P2 (scalability) — per-workspace verbatim (LanceDB) resolver. Threaded
     * into the shared retrieve() core so an in-process recall against a
     * NON-active workspace seeds semantic + BM25 against that workspace's OWN
     * verbatim store instead of a keyword-only scan. Optional — omitted (e.g.
     * embedded single-workspace hosts) ⇒ non-active recall degrades to keyword.
     */
    workspaceVerbatimResolver?: {
        getOrOpen(ws: string): Promise<import('../engines/verbatimStoreApi.js').VerbatimStoreApi>;
    };
}

/* ─── Implementation ───────────────────────────────────────────── */

export async function inProcessRecall(
    topic: string,
    opts: RecallOpts,
    deps: InProcessRecallDeps,
): Promise<RecallResult> {
    // fix/search-worker-call-cancellation (3.20.2, req. 3): check + race the
    // signal at this outer boundary — see RecallOpts.signal's doc for scope.
    if (opts.signal?.aborted) throw toAbortError(opts.signal);
    const work = inProcessRecallCore(topic, opts, deps);
    if (!opts.signal) return work;
    const signal = opts.signal;
    return new Promise<RecallResult>((resolve, reject) => {
        const onAbort = () => { reject(toAbortError(signal)); };
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(
            (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
        );
    });
}

async function inProcessRecallCore(
    topic: string,
    opts: RecallOpts,
    deps: InProcessRecallDeps,
): Promise<RecallResult> {
    const {
        workspace,
        ecosystem,
        depth = 1,
        mode = 'summary',
        crossProject = false,
        includeSuperseded = false,
        tags,
        types,
        maxTokens,
        includeArchived = false,
        searchMode = 'hybrid',
        queryLanguage,
        filePaths,
        queries,
        entities,
        topics,
        project,
        abstain,
        relevanceFloor,
        abstainTermCoverage,
    } = opts;

    // fix/3.22.1-recall-parity review fix (1) — clamp `max` to [1, 100],
    // the same bound the `recall` MCP tool/REST enforce via schema.
    // Applied AFTER the default (10) so an unset `max` is unaffected
    // (default output must stay byte-identical); a non-finite value also
    // falls back to the default rather than propagating NaN downstream.
    const max = Number.isFinite(opts.max) ? Math.min(100, Math.max(1, opts.max as number)) : 10;

    // Cross-workspace path — delegate to the shared aggregation and unwrap.
    if (workspace === '*') {
        if (!deps.graphRegistry) {
            throw new Error('inProcessRecall: workspace="*" requires a graphRegistry — ensure deploymentMode is "local" or "embedded"');
        }
        const mcpResult = await runCrossWorkspaceRecall({
            topic, depth, includeSuperseded, includeArchived, tags, types,
            registry: deps.graphRegistry,
            verbatimStore: deps.store.loreVerbatim as Parameters<typeof runCrossWorkspaceRecall>[0]['verbatimStore'],
            sessionCache: deps.store.sessionCache,
            responseMode: mode, queryLanguage, maxTokens,
            workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // P2 — each workspace seeds its own verbatim store.
        });
        return JSON.parse((mcpResult as { content: Array<{ text: string }> }).content[0]!.text) as RecallResult;
    }

    // Single-workspace path — shared retrieve() core + buildRecallResult preset.
    // P2: thread the per-workspace verbatim resolver so a non-active workspace
    // recall seeds semantic + BM25 against its OWN verbatim store.
    const ctx: RetrieveContext = { store: deps.store, graphRegistry: deps.graphRegistry, workspaceVerbatimResolver: deps.workspaceVerbatimResolver };
    let outcome;
    try {
        outcome = await retrieve(ctx, topic, {
            workspace, ecosystem, mode: searchMode, depth, limit: max,
            tags, types, includeArchived, includeSuperseded, maxTokens, crossProject,
            queries, entities, topics, project,
            abstain, relevanceFloor, abstainTermCoverage,
            // fix/search-worker-call-cancellation (3.20.2 follow-up): this was
            // the confirmed root gap — opts.signal was accepted on RecallOpts
            // and used to race the OUTER promise (see inProcessRecall() above)
            // but never forwarded into retrieve()'s own options, so the real
            // seed-store search/bm25Search calls never saw it and kept running
            // (and holding/queuing on SearchGate) after the caller gave up.
            signal: opts.signal,
            candidateFloor: opts.candidateFloor,
            lexicalBase: opts.lexicalBase,
        });
    } catch (err) {
        if ((err as { code?: string }).code === 'workspace_not_found') {
            throw Object.assign(new Error(`inProcessRecall: unknown workspace "${workspace}"`), { code: 'workspace_not_found', requested: workspace });
        }
        throw err;
    }

    // Resolve the graph for presentation (deferred / hint / auto-escalate).
    // getGraphHandle resolves the workspace's DECLARED engine (and still
    // goes through (memoised) getOrOpen internally first, so this re-uses
    // the same open retrieve() just performed).
    const graph = deps.graphRegistry ? await deps.graphRegistry.getGraphHandle(workspace) : deps.store.loreGraph;
    const ecosystemScope = crossProject ? '*' : (ecosystem ?? '*');

    return buildRecallResult(
        {
            topic, responseMode: mode, searchMode, workspaceScope: workspace, ecosystemScope, crossProject, queryLanguage, filePaths, maxTokens,
            // fix/3.22.1-recall-parity review fix (1) — this was the actual
            // gap: `max` was already sized into retrieve()'s own seed
            // `limit` above, but never threaded into buildRecallResult's
            // `maxHits`, so summary-mode display stayed hard-capped at the
            // historic SUMMARY_MAX_HITS (10) regardless of a larger `max`.
            // Mirrors the `recall` MCP tool (recallTool.ts) and REST
            // GET /api/recall (search.ts), which both already pass this.
            maxHits: max,
        },
        outcome,
        graph as unknown as Parameters<typeof buildRecallResult>[2],
    );
}

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
    /** Maximum number of candidate seed nodes. Default: 10. */
    max?: number;
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
        getOrOpen(ws: string): Promise<import('../engines/verbatimStore.js').VerbatimStore>;
    };
}

/* ─── Implementation ───────────────────────────────────────────── */

export async function inProcessRecall(
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
        maxTokens,
        includeArchived = false,
        searchMode = 'hybrid',
        queryLanguage,
        filePaths,
        max = 10,
    } = opts;

    // Cross-workspace path — delegate to the shared aggregation and unwrap.
    if (workspace === '*') {
        if (!deps.graphRegistry) {
            throw new Error('inProcessRecall: workspace="*" requires a graphRegistry — ensure deploymentMode is "local" or "embedded"');
        }
        const mcpResult = await runCrossWorkspaceRecall({
            topic, depth, includeSuperseded, includeArchived, tags,
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
            tags, includeArchived, includeSuperseded, maxTokens, crossProject,
        });
    } catch (err) {
        if ((err as { code?: string }).code === 'workspace_not_found') {
            throw Object.assign(new Error(`inProcessRecall: unknown workspace "${workspace}"`), { code: 'workspace_not_found', requested: workspace });
        }
        throw err;
    }

    // Resolve the graph for presentation (deferred / hint / auto-escalate).
    // getGraphHandle, not getOrOpen: the latter is the Kùzu substrate accessor
    // and returns a LocalGraph for every workspace regardless of its declared
    // engine. getGraphHandle resolves the DECLARED engine and still goes
    // through (memoised) getOrOpen internally first, so this re-uses the
    // same open retrieve() just performed.
    const graph = deps.graphRegistry ? await deps.graphRegistry.getGraphHandle(workspace) : deps.store.loreGraph;
    const ecosystemScope = crossProject ? '*' : (ecosystem ?? '*');

    return buildRecallResult(
        { topic, responseMode: mode, searchMode, workspaceScope: workspace, ecosystemScope, crossProject, queryLanguage, filePaths, maxTokens },
        outcome,
        graph as unknown as Parameters<typeof buildRecallResult>[2],
    );
}

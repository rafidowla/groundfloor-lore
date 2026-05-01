/**
 * developer/api.ts — Typed surface the Developer plugin exposes.
 *
 * Outside callers reach plugin ops via `pluginRegistry.get('developer')?.api`
 * cast to DeveloperApi. The plugin attaches this object during
 * registerSchema so it closes over the live PluginGraphContext.
 */

import type { PluginGraphContext } from '@lore-core/plugins/types.js';
import type { CodeSymbol, CodeRelationEdge, DevActivity } from './types.js';
import * as ops from './operations.js';
import * as indexer from './codeIndexer.js';
import * as repoOps from './repoOps.js';
import * as similarity from './similarity.js';
export type { GitNexusRepoEntry, IndexResult } from './codeIndexer.js';
export type {
    DiscoveredRepo,
    RepoFreshness,
    AddRepoResult,
    RemoveRepoResult,
} from './repoOps.js';
export type {
    SimilarSymbolHit,
    PreWriteDecision,
    FindSimilarOptions,
} from './similarity.js';

export interface DeveloperApi {
    readonly name: 'developer';

    // File layer
    upsertCodeFile: (file: { path: string; language?: string; loc?: number; repo?: string; lastModified?: string }) => Promise<void>;
    addFileContains: (filePath: string, symbolUid: string) => Promise<void>;
    addLoreTouchesFile: (loreNodeId: string, filePath: string, relation?: string) => Promise<void>;
    listCodeFiles: () => Promise<Array<{ path: string; language: string; repo: string }>>;
    listCodeFilesWithPreview: (maxBytes?: number) => Promise<Awaited<ReturnType<typeof ops.listCodeFilesWithPreview>>>;
    ingestFilesFromSymbols: () => Promise<{ filesCreated: number; edgesCreated: number }>;

    // Symbol layer
    upsertCodeSymbol: (symbol: CodeSymbol) => Promise<void>;
    addCodeRelation: (edge: CodeRelationEdge) => Promise<void>;
    queryCodeSymbols: (query: string, repo?: string, limit?: number) => Promise<CodeSymbol[]>;
    queryCodeSymbolsByName: (name: string) => Promise<CodeSymbol[]>;
    getCodeSymbolByUid: (uid: string) => Promise<CodeSymbol | null>;
    getCodeSymbolContext: (uid: string) => ReturnType<typeof ops.getCodeSymbolContext>;
    getCodeRelationsTo: (targetUid: string) => Promise<CodeRelationEdge[]>;
    listCodeSymbols: (limit?: number) => Promise<Awaited<ReturnType<typeof ops.listCodeSymbols>>>;
    clearCodeSymbols: (repo: string) => Promise<number>;
    getCrossPillarEdges: (repo: string) => Promise<{ nodeId: string; symbolUid: string; relation: string }[]>;

    // Knowledge ↔ code
    linkKnowledgeToCode: (nodeId: string, symbolUid: string, relation: string) => Promise<void>;

    // Activity
    recordDevActivity: (activity: DevActivity) => Promise<void>;
    getActiveDevs: (project?: string, activeWindowMinutes?: number) => Promise<DevActivity[]>;
    clearStaleActivity: (olderThanMinutes?: number) => Promise<number>;

    // Maintenance
    pruneInferredDeveloperEdges: (relationPrefix: string) => Promise<{ touchesFile: number; appliesToCode: number }>;

    // Code-indexing orchestration (lore index / doctor)
    listGitNexusRepos: () => indexer.GitNexusRepoEntry[];
    getGitNexusRepo: (name: string) => indexer.GitNexusRepoEntry | null;
    importFromGitNexus: (repo: indexer.GitNexusRepoEntry) => Promise<indexer.IndexResult>;
    indexAllRepos: () => Promise<indexer.IndexResult[]>;

    // Phase-1 Add-Project surface (decision-add-project-ui-phase1-defaults-2026-04-27).
    // Core calls these via DeveloperApi to keep gitnexus vocabulary out of core.
    discoverRepos: (parentPath: string, opts?: { depth?: 'shallow' | 'deep'; maxDepth?: number }) => repoOps.DiscoveredRepo[];
    getRepoFreshness: (name: string, staleAfterHours?: number) => repoOps.RepoFreshness | null;
    addRepo: (repoPath: string, opts?: { installHook?: boolean; force?: boolean }) => Promise<repoOps.AddRepoResult>;
    removeRepo: (name: string) => Promise<repoOps.RemoveRepoResult>;
    installPostCommitHook: (repoPath: string, opts?: { force?: boolean }) => { installed: boolean; reason?: string };

    // Repo tags — see repoOps.ts. Tags live in ~/.groundfloor/.lore/repo-tags.json
    // (separate from gitnexus registry to avoid stepping on its file).
    getRepoTags: (repoName: string) => string[];
    setRepoTags: (repoName: string, tags: string[]) => string[];
    listAllRepoTags: () => Array<{ tag: string; repos: string[] }>;
    reposForTags: (tags: string[]) => string[];

    // 2026-04-27: cross-project code-symbol edge counts. Used by
    // /api/topology/overview to enrich chord-diagram ribbons with
    // actual code coupling (was: LoreNode-edges only, drastically
    // under-reported real project relationships).
    getCrossProjectCodeEdgeCounts: () => Promise<Array<{ fromProject: string; toProject: string; count: number }>>;

    // Phase 2 — Pre-write similarity surface (decision-phase2-cloud-policy-auth-design-2026-04-27).
    // Engine in dev plug-in, NOT core. DATA contract (findSimilarSymbols) for the MCP tool path;
    // POLICY contract (evaluatePreWrite) for hook adapters.
    findSimilarSymbols: (content: string, opts?: similarity.FindSimilarOptions) => Promise<similarity.SimilarSymbolHit[]>;
    evaluatePreWrite: (content: string, opts?: similarity.FindSimilarOptions & { warnThreshold?: number }) => Promise<similarity.PreWriteDecision>;
    embedSymbol: (symbol: { uid: string; name: string; kind: string; filePath: string; content: string; repo: string }) => Promise<void>;

    // Phase 7 — read-only Cypher access against the developer plugin's
    // Kùzu graph. Used by code_cypher (replaces the gitnexus CLI
    // proxy) and by atlas-cutover-execute.mjs to enumerate existing
    // CodeSymbol rows for the oldId → newId mapping table.
    //
    // Read-only enforcement: caller-side sentinel scan of CYPHER_WRITE_KEYWORDS
    // before reaching this method. The method itself does NOT
    // re-validate — adding a redundant scan here would diverge from the
    // single source of truth in CYPHER_WRITE_KEYWORDS. See tools.ts
    // and mcp/handlers-phase61.ts for the gate.
    executeRawCypher: (
        query: string,
        params?: Record<string, unknown>,
        opts?: { maxRows?: number },
    ) => Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }>;

    // Phase 7 — depth-tiered blast radius over CodeRelation edges.
    // Replaces the gitnexus CLI proxy that formerly powered code_impact
    // and gitnexus_impact. BFS in the developer plugin's Kùzu graph;
    // truncates at 200 nodes per tier / 2000 total to keep response
    // bounded for very-large blast zones.
    computeCodeBlastRadius: (
        target: string,
        direction: 'upstream' | 'downstream',
        maxDepth: number,
    ) => Promise<{
        symbol: CodeSymbol | null;
        d1: CodeSymbol[];
        d2: CodeSymbol[];
        d3: CodeSymbol[];
    }>;

    // Phase 7 — Atlas-native indexing entry point. Closes over the
    // PluginGraphContext so callers don't need to thread it through.
    // codeIndexer.ts's importFromGitNexus / indexAllRepos delegate
    // through this surface post-cutover.
    indexRepoWithAtlas: (
        repoRoot: string,
        opts?: { repoName?: string; clearFirst?: boolean },
    ) => Promise<{
        repo: string;
        repoRoot: string;
        filesParsed: number;
        symbolsUpserted: number;
        filesUpserted: number;
        relationsInserted: number;
        relationsByKind: Record<string, number>;
        durationMs: number;
    }>;
}

export function buildDeveloperApi(ctx: PluginGraphContext): DeveloperApi {
    return {
        name: 'developer',
        // File layer
        upsertCodeFile: (file) => ops.upsertCodeFile(ctx, file),
        addFileContains: (filePath, symbolUid) => ops.addFileContains(ctx, filePath, symbolUid),
        addLoreTouchesFile: (nodeId, filePath, relation) => ops.addLoreTouchesFile(ctx, nodeId, filePath, relation),
        listCodeFiles: () => ops.listCodeFiles(ctx),
        listCodeFilesWithPreview: (maxBytes) => ops.listCodeFilesWithPreview(ctx, maxBytes),
        ingestFilesFromSymbols: () => ops.ingestFilesFromSymbols(ctx),

        // Symbol layer
        upsertCodeSymbol: (symbol) => ops.upsertCodeSymbol(ctx, symbol),
        addCodeRelation: (edge) => ops.addCodeRelation(ctx, edge),
        queryCodeSymbols: (query, repo, limit) => ops.queryCodeSymbols(ctx, query, repo, limit),
        queryCodeSymbolsByName: (name) => ops.queryCodeSymbolsByName(ctx, name),
        getCodeSymbolByUid: (uid) => ops.getCodeSymbolByUid(ctx, uid),
        getCodeSymbolContext: (uid) => ops.getCodeSymbolContext(ctx, uid),
        getCodeRelationsTo: (targetUid) => ops.getCodeRelationsTo(ctx, targetUid),
        listCodeSymbols: (limit) => ops.listCodeSymbols(ctx, limit),
        clearCodeSymbols: (repo) => ops.clearCodeSymbols(ctx, repo),
        getCrossPillarEdges: (repo) => ops.getCrossPillarEdges(ctx, repo),

        // Knowledge ↔ code
        linkKnowledgeToCode: (nodeId, symbolUid, relation) => ops.linkKnowledgeToCode(ctx, nodeId, symbolUid, relation),

        // Activity
        recordDevActivity: (activity) => ops.recordDevActivity(ctx, activity),
        getActiveDevs: (project, window) => ops.getActiveDevs(ctx, project, window),
        clearStaleActivity: (olderThanMinutes) => ops.clearStaleActivity(ctx, olderThanMinutes),

        // Maintenance
        pruneInferredDeveloperEdges: (relationPrefix) => ops.pruneInferredDeveloperEdges(ctx, relationPrefix),

        // Indexer orchestration. The indexer calls back into api via
        // upsertCodeSymbol / addCodeRelation / linkKnowledgeToCode /
        // clearCodeSymbols / getCrossPillarEdges; we bind it to this same
        // api instance so callers get a single, consistent surface.
        listGitNexusRepos: () => indexer.listGitNexusRepos(),
        getGitNexusRepo: (name) => indexer.getGitNexusRepo(name),
        importFromGitNexus: (repo) => indexer.importFromGitNexus(repo, _apiSelf),
        indexAllRepos: () => indexer.indexAllRepos(_apiSelf),

        // Phase-1 Add-Project surface — see repoOps.ts and the locked
        // decision node for the contract.
        discoverRepos: (parentPath, opts) => repoOps.discoverRepos(parentPath, opts),
        getRepoFreshness: (name, staleAfterHours) => repoOps.getRepoFreshness(name, staleAfterHours),
        addRepo: (repoPath, opts) => repoOps.addRepo(repoPath, _apiSelf, opts),
        removeRepo: (name) => repoOps.removeRepo(name, _apiSelf),
        installPostCommitHook: (repoPath, opts) => repoOps.installPostCommitHook(repoPath, opts),
        getRepoTags: (repoName) => repoOps.getRepoTags(repoName),
        setRepoTags: (repoName, tags) => repoOps.setRepoTags(repoName, tags),
        listAllRepoTags: () => repoOps.listAllRepoTags(),
        reposForTags: (tags) => repoOps.reposForTags(tags),
        getCrossProjectCodeEdgeCounts: async () => ops.getCrossProjectCodeEdgeCounts(ctx),

        // Phase-2 similarity surface — engine + dual-contract per the
        // locked Phase-2 design. Stashed pluginContext is rebound at
        // boot via bindPluginContext (see index.ts registerSchema).
        findSimilarSymbols: (content, opts) => similarity.findSimilarSymbols(_pluginCtxSelf, content, opts),
        evaluatePreWrite: (content, opts) => similarity.evaluatePreWrite(_pluginCtxSelf, content, opts),
        embedSymbol: (symbol) => similarity.embedSymbol(_pluginCtxSelf, symbol),

        // Phase 7 — read-only Cypher passthrough.
        // Truncation default is 1000 rows; callers can override but the
        // truncated flag MUST be respected client-side.
        executeRawCypher: async (query, params, opts) => {
            const maxRows = opts?.maxRows ?? 1000;
            const rows = await ctx.queryRows(query, params);
            const truncated = rows.length > maxRows;
            return {
                rows: truncated ? rows.slice(0, maxRows) : rows,
                truncated,
            };
        },

        // Phase 7 — depth-tiered blast radius. Implementation in operations.ts
        // (BFS over CodeRelation edges via storage.traverse).
        computeCodeBlastRadius: (target, direction, maxDepth) =>
            ops.computeCodeBlastRadius(ctx, target, direction, maxDepth),

        // Phase 7 — Atlas indexing closure. atlasIndexer.indexRepoWithAtlas
        // takes a PluginGraphContext; this exposes the same operation
        // through the api surface so codeIndexer.ts (and any other
        // caller) can drive it without re-threading ctx.
        indexRepoWithAtlas: async (repoRoot, opts) => {
            const { indexRepoWithAtlas } = await import('./atlasIndexer.js');
            return await indexRepoWithAtlas(ctx, repoRoot, opts);
        },
    };
}

/**
 * Sentinel keyword scan to enforce read-only Cypher across every code-side
 * tool that exposes raw Cypher. Single source of truth — keep
 * mcp/handlers-phase61.ts CYPHER_WRITE_KEYWORDS in sync if this list
 * changes. Phase 6.1-2 follow-up: replace with Kùzu transaction read-only
 * mode if/when available.
 */
export const CYPHER_WRITE_KEYWORDS: readonly string[] = [
    'CREATE', 'DELETE', 'DROP', 'MERGE', 'SET', 'DETACH', 'COPY', 'INSTALL', 'LOAD',
];

/**
 * Returns the first write-keyword found in `query`, or null if the
 * query is read-only. Case-insensitive, word-boundary match. Used by
 * code_cypher and gitnexus_cypher to gate the executeRawCypher call.
 */
export function findWriteKeyword(query: string): string | null {
    const upper = query.toUpperCase();
    for (const kw of CYPHER_WRITE_KEYWORDS) {
        const re = new RegExp(`\\b${kw}\\b`);
        if (re.test(upper)) return kw;
    }
    return null;
}

// Forward-declared PluginContext for similarity functions that need
// verbatimStore (lives on PluginContext, not PluginGraphContext).
// Rebound at registerSchema time — see bindPluginContext below.
let _pluginCtxSelf: import('@lore-core/plugins/types.js').PluginContext = null as unknown as import('@lore-core/plugins/types.js').PluginContext;
export function bindPluginContext(ctx: import('@lore-core/plugins/types.js').PluginContext): void {
    _pluginCtxSelf = ctx;
}

// Forward-declared self-reference so the indexer callbacks close over
// the same DeveloperApi instance the outer caller receives. Rebound
// immediately after buildDeveloperApi returns (see index.ts registerSchema).
// eslint-disable-next-line prefer-const, @typescript-eslint/no-unused-vars
let _apiSelf: DeveloperApi = null as unknown as DeveloperApi;
export function bindApiSelfReference(api: DeveloperApi): void {
    _apiSelf = api;
}

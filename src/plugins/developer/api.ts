/**
 * developer/api.ts — Typed surface the Developer plugin exposes.
 *
 * Outside callers reach plugin ops via `pluginRegistry.get('developer')?.api`
 * cast to DeveloperApi. The plugin attaches this object during
 * registerSchema so it closes over the live PluginGraphContext.
 */

import type { PluginGraphContext } from '../types.js';
import type { CodeSymbol, CodeRelationEdge, DevActivity } from './types.js';
import * as ops from './operations.js';
import * as indexer from './codeIndexer.js';
export type { GitNexusRepoEntry, IndexResult } from './codeIndexer.js';

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
    isGitNexusAvailable: () => boolean;
    listGitNexusRepos: () => indexer.GitNexusRepoEntry[];
    getGitNexusRepo: (name: string) => indexer.GitNexusRepoEntry | null;
    importFromGitNexus: (repo: indexer.GitNexusRepoEntry) => Promise<indexer.IndexResult>;
    indexAllRepos: () => Promise<indexer.IndexResult[]>;
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
        isGitNexusAvailable: () => indexer.isGitNexusAvailable(),
        listGitNexusRepos: () => indexer.listGitNexusRepos(),
        getGitNexusRepo: (name) => indexer.getGitNexusRepo(name),
        importFromGitNexus: (repo) => indexer.importFromGitNexus(repo, _apiSelf),
        indexAllRepos: () => indexer.indexAllRepos(_apiSelf),
    };
}

// Forward-declared self-reference so the indexer callbacks close over
// the same DeveloperApi instance the outer caller receives. Rebound
// immediately after buildDeveloperApi returns (see index.ts registerSchema).
// eslint-disable-next-line prefer-const, @typescript-eslint/no-unused-vars
let _apiSelf: DeveloperApi = null as unknown as DeveloperApi;
export function bindApiSelfReference(api: DeveloperApi): void {
    _apiSelf = api;
}

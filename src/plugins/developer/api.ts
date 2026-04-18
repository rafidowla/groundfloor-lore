/**
 * developer/api.ts — Typed surface the Developer plugin exposes to the
 * rest of the system.
 *
 * Anything outside the plugin that wants to read/write code-graph data
 * goes through `pluginRegistry.get('developer')?.api` rather than
 * importing the operations module directly. That keeps the core engine
 * blind to whether any specific plugin is active.
 */

import type { PluginGraphContext } from '../types.js';
import * as ops from './operations.js';

export interface DeveloperApi {
    readonly name: 'developer';
    upsertCodeFile: (file: { path: string; language?: string; loc?: number; repo?: string; lastModified?: string }) => Promise<void>;
    addFileContains: (filePath: string, symbolUid: string) => Promise<void>;
    addLoreTouchesFile: (loreNodeId: string, filePath: string, relation?: string) => Promise<void>;
    linkKnowledgeToCode: (nodeId: string, symbolUid: string, relation: string) => Promise<void>;
    listCodeFiles: () => Promise<Array<{ path: string; language: string; repo: string }>>;
    listCodeSymbols: (limit?: number) => Promise<Awaited<ReturnType<typeof ops.listCodeSymbols>>>;
    listCodeFilesWithPreview: (maxBytes?: number) => Promise<Awaited<ReturnType<typeof ops.listCodeFilesWithPreview>>>;
    ingestFilesFromSymbols: () => Promise<{ filesCreated: number; edgesCreated: number }>;
    pruneInferredDeveloperEdges: (relationPrefix: string) => Promise<{ touchesFile: number; appliesToCode: number }>;
}

export function buildDeveloperApi(ctx: PluginGraphContext): DeveloperApi {
    return {
        name: 'developer',
        upsertCodeFile: (file) => ops.upsertCodeFile(ctx, file),
        addFileContains: (filePath, symbolUid) => ops.addFileContains(ctx, filePath, symbolUid),
        addLoreTouchesFile: (nodeId, filePath, relation) => ops.addLoreTouchesFile(ctx, nodeId, filePath, relation),
        linkKnowledgeToCode: (nodeId, symbolUid, relation) => ops.linkKnowledgeToCode(ctx, nodeId, symbolUid, relation),
        listCodeFiles: () => ops.listCodeFiles(ctx),
        listCodeSymbols: (limit) => ops.listCodeSymbols(ctx, limit),
        listCodeFilesWithPreview: (maxBytes) => ops.listCodeFilesWithPreview(ctx, maxBytes),
        ingestFilesFromSymbols: () => ops.ingestFilesFromSymbols(ctx),
        pruneInferredDeveloperEdges: (relationPrefix) => ops.pruneInferredDeveloperEdges(ctx, relationPrefix),
    };
}

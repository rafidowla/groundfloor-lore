/**
 * importScope.ts — row-scope deps for POST /api/import (runImport in import.ts).
 * Split out of import.ts (file-size cap); no behaviour change.
 */

import { getCurrentActorScopes } from '../../../security/actorContext.js';
import { buildWriteScopeDeps } from '../../../security/writeTargetGate.js';
import type { ItemScopeDeps } from '../../../security/itemScopes.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import type { ImportDeps } from './import.js';

/**
 * ItemScopeDeps for the workspace the import writes to (bound actors only; undefined
 * for an unbound caller, which does no lookups). Shared by the create-id gate and the
 * `supersedes` visibility hook.
 */
export async function importScopeDeps(deps: ImportDeps, targetGraph: LoreGraphHandle, workspace: string): Promise<ItemScopeDeps | undefined> {
    if (getCurrentActorScopes() === undefined) return undefined;
    // The workspace's own canonical verbatim row (boot store when no resolver is wired).
    let verbatim: Parameters<typeof buildWriteScopeDeps>[0]['verbatim'] = deps.store.loreVerbatim;
    if (deps.workspaceVerbatimResolver && workspace) verbatim = await deps.workspaceVerbatimResolver.getOrOpen(workspace);
    const sd = buildWriteScopeDeps({ workspace, store: deps.store, graphRegistry: deps.graphRegistry, versionStore: deps.versionStore, verbatim });
    // Read the live node from the graph the import writes to, not whatever the workspace resolves to.
    return { ...sd, getGraphNode: (id: string) => targetGraph.getNode(id) };
}

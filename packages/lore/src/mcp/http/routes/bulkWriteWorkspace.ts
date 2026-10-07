/**
 * bulkWriteWorkspace.ts — workspace -> graph resolution shared by the bulk write
 * routes (bulkWrite.ts, bulkWriteEdgesDelete.ts, bulkRecall.ts). Split out of
 * bulkWrite.ts (file-size cap); no behaviour change.
 */

import type { ServerResponse } from 'node:http';
import { WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { writeError } from '../helpers.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import type { BulkWriteDeps } from './bulkWrite.js';

// Widened when the local graph engine changed: naming CONCRETE classes excluded SurrealGraph.
type LoreGraph = LoreGraphHandle;

export async function resolveGraph(
    deps: BulkWriteDeps,
    requestedWorkspace?: string,
): Promise<LoreGraph | { error: 'workspace_not_found'; requested: string; known: string[] }> {
    if (!deps.graphRegistry) return deps.store.loreGraph;
    const target = requestedWorkspace ?? deps.graphRegistry.activeName();
    try {
        // getGraphHandle resolves the DECLARED engine, so a bulk write
        // lands in the requested workspace's own graph rather than an
        // empty db for the wrong engine while reporting ok:true. Gate
        // still runs inside.
        return await deps.graphRegistry.getGraphHandle(target);
    } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
            return { error: 'workspace_not_found', requested: err.requested, known: err.known };
        }
        throw err;
    }
}

/** Canonical-envelope emitter for the resolveGraph() workspace_not_found shape. */
export function writeWorkspaceNotFound(
    res: ServerResponse,
    err: { error: 'workspace_not_found'; requested: string; known: string[] },
): void {
    writeError(res, 404, err.error, `workspace not found: ${err.requested}`, {
        requested: err.requested,
        known: err.known,
    });
}

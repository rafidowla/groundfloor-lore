/**
 * workspaceErase/closeHandles.ts — release every open handle on a workspace's data before it is hidden/erased (lane f6b).
 *
 * Three caches can hold files of the workspace open: the graph registry (graph store, table storage, hot-session
 * cache), the verbatim-store resolver (vector store) and the ingestion host (ingestion store). Each is a lazy cache,
 * so a handle closed here simply reopens on the next use. If any of them cannot be closed (pinned / aliased / pending
 * embed work) the delete is refused, exactly like the maintain path did for the graph handle alone: moving or
 * deleting files out from under an open store corrupts it.
 */

export interface HandleSources {
    graphRegistry?: { closeWorkspace(name: string): Promise<boolean> } | null;
    verbatimResolver?: { closeWorkspace(name: string): Promise<boolean> } | null;
    /** Resolved lazily: the ingestion host may be started after the route was wired. */
    getIngestionHost?: (() => { closeWorkspace(ws: string): Promise<boolean> } | null) | null;
}

export type CloseOutcome = { ok: true } | { ok: false; reason: string };

/** Close the ingestion store, then the vector store, then the graph handles. Stops at the first that refuses. */
export async function closeWorkspaceHandles(name: string, src: HandleSources): Promise<CloseOutcome> {
    const host = src.getIngestionHost?.() ?? null;
    if (host) {
        let ok = false;
        try { ok = await host.closeWorkspace(name); } catch { ok = false; }
        if (!ok) return { ok: false, reason: 'its ingestion store could not be closed' };
    }
    if (src.verbatimResolver) {
        let ok = false;
        try { ok = await src.verbatimResolver.closeWorkspace(name); } catch { ok = false; }
        if (!ok) return { ok: false, reason: 'its vector store is still in use (pinned, or embedding work is pending)' };
    }
    if (src.graphRegistry) {
        let ok = false;
        try { ok = await src.graphRegistry.closeWorkspace(name); } catch { ok = false; }
        if (!ok) return { ok: false, reason: 'its graph handle is still open (borrowed/aliased)' };
    }
    return { ok: true };
}

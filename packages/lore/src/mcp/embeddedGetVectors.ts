/**
 * embeddedGetVectors.ts - `LoreInstance.getVectors()` (3.27.1).
 *
 * Engine-neutral read of the STORED embedding for a set of node ids, so a host
 * (Atlas: memory export, code-graph sync) can write its v2 memory file without
 * re-embedding - on whichever verbatim engine (LanceDB or SQLite) the workspace
 * uses. Replaces `storageClient.rawVerbatim().table`, which exists only on Lance.
 *
 * Takes NODE ids, reads the canonical `lore:<id>` verbatim row, and returns a
 * Map keyed by NODE id. Omits (never errors on) unknown ids, tombstoned nodes
 * and nodes with no real embedding; never returns history (`#rev`) or alias
 * (`#q<i>`) rows. At most 10,000 ids per call. A cloud/Dataplane workspace has
 * no cheap stored-vector fetch, so it throws {@link GetVectorsUnsupportedError}
 * (code `unsupported_on_engine`) rather than silently returning an empty Map.
 *
 * Read path only: no write gate, no embed, no promotion trigger, and - like the
 * other embedded reads (recall / search / getNode) - no audit row (embeddedAudit.ts
 * logs writes only). Attached from src/index.ts's createLore (server.ts is frozen),
 * the same way as nodeDeleteMany.
 */
import type { LoreInstance } from './server.js';
import { GET_VECTORS_MAX_IDS, normalizeGetVectorsIds } from '../engines/verbatimGetVectors.js';

export { GET_VECTORS_MAX_IDS };

/** The workspace's vector store cannot return stored embeddings by id (cloud/Dataplane). */
export class GetVectorsUnsupportedError extends Error {
    readonly code = 'unsupported_on_engine';
    constructor(readonly workspace: string) {
        super(`getVectors: unsupported on this engine (workspace '${workspace}' has no stored-vector read; only the local LanceDB and SQLite verbatim engines do)`);
        this.name = 'GetVectorsUnsupportedError';
    }
}

/** The `getVectors` member added to a `LoreInstance` by {@link attachGetVectors}. */
export interface GetVectorsApi {
    /**
     * 3.27.1 - stored embeddings for `ids` (node ids) in `workspace`, as plain
     * number[] (float32 widened; bit-identical across engines), keyed by node id.
     * Unknown / tombstoned / unembedded nodes are omitted. At most 10,000 ids per
     * call (duplicates collapse). Embedded mode only; throws
     * {@link GetVectorsUnsupportedError} on a cloud workspace.
     */
    getVectors(args: { ids: string[]; workspace: string }): Promise<Map<string, number[]>>;
}

type VectorReadStore = { getVectors?: (ids: string[]) => Promise<Map<string, number[]>> };
const NODE_PREFIX = 'lore:';

export async function embeddedGetVectors(
    args: { ids: string[]; workspace: string },
    resolveVerbatim: (workspace: string) => Promise<unknown>,
): Promise<Map<string, number[]>> {
    if (typeof args?.workspace !== 'string' || args.workspace.length === 0) throw new Error('getVectors: workspace is required');
    const nodeIds = normalizeGetVectorsIds(args.ids, 'getVectors');
    if (nodeIds.length === 0) return new Map();
    const store = (await resolveVerbatim(args.workspace)) as VectorReadStore | null | undefined;
    if (!store || typeof store.getVectors !== 'function') throw new GetVectorsUnsupportedError(args.workspace);
    const rows = await store.getVectors(nodeIds.map((id) => `${NODE_PREFIX}${id}`));
    const out = new Map<string, number[]>();
    for (const [rowId, vec] of rows) {
        // Exact canonical node rows only: the store matched `lore:<id>` verbatim, so strip the prefix.
        if (rowId.startsWith(NODE_PREFIX)) out.set(rowId.slice(NODE_PREFIX.length), vec);
    }
    return out;
}

/** Add `getVectors` to an embedded instance, built on its `_daemon` handles. */
export function attachGetVectors<T extends LoreInstance>(lore: T): T & GetVectorsApi {
    if (typeof (lore as { getVectors?: unknown }).getVectors === 'function') return lore as T & GetVectorsApi;
    const d = lore._daemon as unknown as {
        getVerbatimResolver(): { getOrOpen(ws: string): Promise<unknown> } | undefined;
        store: { loreVerbatim: unknown };
    };
    Object.defineProperty(lore, 'getVectors', {
        configurable: true, writable: true, enumerable: true,
        value: (args: { ids: string[]; workspace: string }) => {
            const resolver = d.getVerbatimResolver();
            return embeddedGetVectors(args, async (ws) => (resolver ? resolver.getOrOpen(ws) : d.store.loreVerbatim));
        },
    });
    return lore as T & GetVectorsApi;
}

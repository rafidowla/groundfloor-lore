/**
 * embeddedNodeDeleteMany.ts — `LoreInstance.nodeDeleteMany()` (3.27.0).
 *
 * The batched form of `nodeDelete` (mcp/embeddedNodeDelete.ts) for a host that
 * deletes hundreds of stale nodes at a time (Atlas, after each reindex). Per
 * node it is the identical sequence; the cost per node is what changes — see
 * core/nodeDeleteManyService.ts (chunked locks, batched outbox inserts, one
 * alias lookup and one purge call per chunk).
 *
 * Wiring: mcp/server.ts is frozen (FROZEN.md), so the method is attached by
 * `attachNodeDeleteMany()` — applied by the package entry's `createLore`
 * (src/index.ts, which also widens the exported `LoreInstance` type) — which builds the same dependencies `nodeDelete` uses from
 * the instance's `_daemon` handles. Not available from a bare
 * `mcp/server.js` import.
 */
import type { LoreInstance } from './server.js';
import type { AuditLog } from '../security/audit.js';
import type { OutboxStore } from '../outbox/types.js';
import type { WriteAheadLog } from '../engines/writeAheadLog.js';
import { deleteNodesEverywhere, type NodeDeleteManyResult, type NodeDeleteManyItem } from '../core/nodeDeleteManyService.js';
import { logEmbeddedWrite } from './embeddedAudit.js';
import { noteInlineAppliedDelete, type EmbeddedReplayScope } from './embeddedLifecycle.js';

export type { NodeDeleteManyResult, NodeDeleteManyItem };

/** Upper bound on ids per `nodeDeleteMany` call. */
export const NODE_DELETE_MANY_MAX_IDS = 10_000;

/** The `nodeDeleteMany` member added to a `LoreInstance` by {@link attachNodeDeleteMany}
 *  (declared as an intersection, not by module augmentation: server.ts and the
 *  ArcadeDB boot build `LoreInstance` literals that would otherwise have to
 *  supply it). */
export interface NodeDeleteManyApi {
    /**
     * 3.27.0 — delete many nodes; per id the same as `nodeDelete` (graph +
     * `node.delete` outbox row + verbatim tombstone, or physical `purge: true`),
     * but chunked under per-node locks with batched outbox, alias and purge
     * work. Duplicate ids collapse to the first. One failing id is reported in
     * its own result (`error`) and never aborts the rest. At most 10,000 ids per
     * call; one audit row per call. Embedded mode only.
     */
    nodeDeleteMany(args: { ids: string[]; workspace: string; purge?: boolean }): Promise<NodeDeleteManyResult>;
}

export interface EmbeddedNodeDeleteManyDeps {
    auditLog: AuditLog;
    isActiveWorkspace: (workspace: string) => boolean;
    resolveGraph: (workspace: string) => Promise<{ deleteNode(id: string): Promise<boolean> }>;
    resolveVerbatim: (workspace: string) => Promise<unknown>;
    verbatimDelete: (verbatimId: string) => Promise<unknown>;
    outboxStore?: OutboxStore;
    getWal: () => Pick<WriteAheadLog, 'append'>;
    replayScope: EmbeddedReplayScope;
}

export async function embeddedNodeDeleteMany(
    args: { ids: string[]; workspace: string; purge?: boolean },
    deps: EmbeddedNodeDeleteManyDeps,
): Promise<NodeDeleteManyResult> {
    const startedAt = Date.now();
    let value: NodeDeleteManyResult | undefined;
    let error: unknown;
    try {
        if (typeof args?.workspace !== 'string' || args.workspace.length === 0) throw new Error('nodeDeleteMany: workspace is required');
        if (!Array.isArray(args.ids) || args.ids.length === 0) throw new Error('nodeDeleteMany: ids must be a non-empty array');
        if (args.ids.length > NODE_DELETE_MANY_MAX_IDS) {
            throw new Error(`nodeDeleteMany: at most ${NODE_DELETE_MANY_MAX_IDS} ids per call (got ${args.ids.length}); split the batch`);
        }
        if (args.ids.some((id) => typeof id !== 'string' || id.length === 0)) throw new Error('nodeDeleteMany: every id must be a non-empty string');
        const ids = [...new Set(args.ids)];
        const workspace = args.workspace;
        const graph = await deps.resolveGraph(workspace);
        value = await deleteNodesEverywhere({
            ids,
            workspace,
            isActive: deps.isActiveWorkspace(workspace),
            graph,
            outboxStore: deps.outboxStore,
            resolveVerbatim: () => deps.resolveVerbatim(workspace),
            verbatimDelete: deps.verbatimDelete,
            getWal: deps.getWal,
            initiator: 'lib:nodeDeleteMany',
            reason: 'graph node deleted via LoreInstance.nodeDeleteMany',
            logPrefix: '[Lore]',
            onInlineDeleteApplied: (entry) => {
                const id = (entry.payload as { id?: unknown } | undefined)?.id;
                if (typeof id === 'string') noteInlineAppliedDelete(deps.replayScope, entry, id);
            },
            ...(args.purge === true ? { purge: true } : {}),
        });
    } catch (err) {
        error = err;
    }
    const count = Array.isArray(args?.ids) ? args.ids.length : 0;
    return logEmbeddedWrite(
        { auditLog: deps.auditLog, toolName: 'lib:nodeDeleteMany', workspace: String(args?.workspace ?? ''), nodeId: `(${count} ids)`, startedAt },
        error !== undefined ? { ok: false, error } : { ok: true, value: value! },
    );
}

/** Add `nodeDeleteMany` to an embedded instance, built on its `_daemon` handles. */
export function attachNodeDeleteMany(lore: LoreInstance): LoreInstance & NodeDeleteManyApi {
    if (typeof (lore as { nodeDeleteMany?: unknown }).nodeDeleteMany === 'function') return lore as LoreInstance & NodeDeleteManyApi;
    // `_daemon` is the full daemon wiring at runtime (server.ts casts it back);
    // the narrow public type only names a few handles.
    const d = lore._daemon as unknown as {
        auditLog: AuditLog;
        outboxWiring: { store: OutboxStore };
        getWal(): Pick<WriteAheadLog, 'append'>;
        replayScope?: EmbeddedReplayScope;
        detectedScope: { workspace: string };
        getGraph(): { deleteNode(id: string): Promise<boolean> };
        getGraphRegistry(): { activeName(): string; getGraphHandle(ws: string): Promise<{ deleteNode(id: string): Promise<boolean> }> } | undefined;
        getVerbatimResolver(): { getOrOpen(ws: string): Promise<unknown> } | undefined;
        store: { loreVerbatim: unknown; storageClient: { verbatimDelete(id: string): Promise<unknown> } };
    };
    Object.defineProperty(lore, 'nodeDeleteMany', {
        configurable: true, writable: true, enumerable: true,
        value: (args: { ids: string[]; workspace: string; purge?: boolean }) => {
            const registry = d.getGraphRegistry();
            const resolver = d.getVerbatimResolver();
            if (!d.replayScope) throw new Error('nodeDeleteMany: not available in this deployment mode (no embedded replay scope)');
            return embeddedNodeDeleteMany(args, {
                auditLog: d.auditLog, outboxStore: d.outboxWiring.store, getWal: () => d.getWal(), replayScope: d.replayScope,
                isActiveWorkspace: (ws) => ws === (registry?.activeName() ?? d.detectedScope.workspace),
                resolveGraph: async (ws) => (registry ? registry.getGraphHandle(ws) : d.getGraph()),
                resolveVerbatim: async (ws) => (resolver ? resolver.getOrOpen(ws) : d.store.loreVerbatim),
                verbatimDelete: (verbatimId) => d.store.storageClient.verbatimDelete(verbatimId),
            });
        },
    });
    return lore as LoreInstance & NodeDeleteManyApi;
}

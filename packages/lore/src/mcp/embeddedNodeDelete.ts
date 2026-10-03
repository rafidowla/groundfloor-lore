/**
 * embeddedNodeDelete.ts — `LoreInstance.nodeDelete()` (3.26.0).
 *
 * The supported hard delete for an in-process host. It runs the same sequence
 * as the MCP `delete_node` tool (core/nodeDeleteService.ts): `node.delete`
 * recorded in the outbox, graph node + relationships removed, verbatim row
 * tombstoned, WAL entry appended — all under the node write lock.
 *
 * 3.27.0 — `purge: true` swaps the verbatim tombstone for a physical delete of
 * the node's verbatim rows, `#rev` history and question-alias rows included,
 * recorded as one `verbatim.purge` outbox row; nothing is re-embedded. MCP
 * `delete_node` and REST `DELETE /api/node` keep tombstoning.
 *
 * Before this existed a host deleted through `storageClient.rawGraph()`, which
 * the outbox never saw; a pending `node.upsert` row for that id was then
 * replayed as crash recovery and the node came back. Lives outside server.ts
 * to keep that file inside its size budget.
 */
import type { AuditLog } from '../security/audit.js';
import type { OutboxStore } from '../outbox/types.js';
import type { WriteAheadLog } from '../engines/writeAheadLog.js';
import { deleteNodeEverywhere, type NodeDeleteOutcome } from '../core/nodeDeleteService.js';
import { logEmbeddedWrite } from './embeddedAudit.js';
import { noteInlineAppliedDelete, type EmbeddedReplayScope } from './embeddedLifecycle.js';

// 3.27.0 — declare the `purge` option on LoreInstance.nodeDelete without editing
// mcp/server.ts (FROZEN.md): a declaration-merged overload, picked for any call
// that passes `purge`. The runtime already forwards `args` whole.
declare module './server.js' {
    interface LoreInstance {
        nodeDelete(args: { id: string; workspace: string; purge?: boolean }): Promise<NodeDeleteOutcome>;
    }
}

export interface EmbeddedNodeDeleteDeps {
    auditLog: AuditLog;
    /** Same rule as `nodeUpsert`: is this the instance's active workspace? */
    isActiveWorkspace: (workspace: string) => boolean;
    /** The workspace's own graph handle (throws for an unknown workspace). */
    resolveGraph: (workspace: string) => Promise<{ deleteNode(id: string): Promise<boolean> }>;
    /** The workspace's verbatim store (boot store when no resolver). */
    resolveVerbatim: (workspace: string) => Promise<unknown>;
    verbatimDelete: (verbatimId: string) => Promise<unknown>;
    outboxStore?: OutboxStore;
    getWal: () => Pick<WriteAheadLog, 'append'>;
    replayScope: EmbeddedReplayScope;
}

export async function embeddedNodeDelete(
    args: { id: string; workspace: string; purge?: boolean },
    deps: EmbeddedNodeDeleteDeps,
): Promise<NodeDeleteOutcome> {
    const startedAt = Date.now();
    let value: NodeDeleteOutcome | undefined;
    let error: unknown;
    try {
        if (typeof args?.id !== 'string' || args.id.length === 0) throw new Error('nodeDelete: id is required');
        if (typeof args.workspace !== 'string' || args.workspace.length === 0) {
            throw new Error('nodeDelete: workspace is required');
        }
        const graph = await deps.resolveGraph(args.workspace);
        value = await deleteNodeEverywhere({
            id: args.id,
            workspace: args.workspace,
            isActive: deps.isActiveWorkspace(args.workspace),
            graph,
            outboxStore: deps.outboxStore,
            resolveVerbatim: () => deps.resolveVerbatim(args.workspace),
            verbatimDelete: deps.verbatimDelete,
            getWal: deps.getWal,
            initiator: 'lib:nodeDelete',
            reason: 'graph node deleted via LoreInstance.nodeDelete',
            logPrefix: '[Lore]',
            onInlineDeleteApplied: (entry) => noteInlineAppliedDelete(deps.replayScope, entry, args.id),
            // 3.27.0 — `purge: true` physically removes the verbatim rows
            // (history + aliases included) instead of tombstoning them.
            ...(args.purge === true ? { purge: true } : {}),
        });
    } catch (err) {
        error = err;
    }
    // Every embedded write appends exactly one audit row (audit fix #1).
    return logEmbeddedWrite(
        { auditLog: deps.auditLog, toolName: 'lib:nodeDelete', workspace: String(args?.workspace ?? ''), nodeId: String(args?.id ?? ''), startedAt },
        error !== undefined ? { ok: false, error } : { ok: true, value: value! },
    );
}

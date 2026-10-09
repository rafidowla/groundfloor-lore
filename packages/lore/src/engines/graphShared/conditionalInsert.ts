/**
 * conditionalInsert.ts — the "create only if absent" primitive behind the
 * `ifAbsent` write directive (conditional writes, phase 1 / R1).
 *
 * `insertNodeIfAbsent(node)` is an optional graph verb. Engines whose store can
 * reject a duplicate key themselves (sqlite PRIMARY KEY, arcade unique index on
 * `LoreNode.id`) implement it as a plain INSERT, so the guarantee holds across
 * processes. Engines without it fall back to a read-then-upsert, which is only
 * as strong as the caller's in-process node lock (documented in the CHANGELOG).
 *
 * A duplicate is always reported as {@link NodeAlreadyExistsError}; callers map
 * it to their own `already_exists` shape and must write nothing else.
 */
import type { LoreNode } from '../../providers/types.js';

export type NodeInput = Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;

export class NodeAlreadyExistsError extends Error {
    readonly code = 'already_exists';
    constructor(public readonly nodeId: string) {
        super(`a node with id '${nodeId}' already exists in this workspace`);
        this.name = 'NodeAlreadyExistsError';
    }
}

export function isNodeAlreadyExists(err: unknown): err is NodeAlreadyExistsError {
    return err instanceof NodeAlreadyExistsError
        || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'already_exists'
            && (err as { name?: unknown }).name === 'NodeAlreadyExistsError');
}

/** The wire error for an ifAbsent refusal: `already_exists: <message>`. */
export function alreadyExistsError(err: NodeAlreadyExistsError | Error): string {
    return `already_exists: ${err.message}`;
}

export interface ConditionalInsertGraph {
    upsertNode(node: NodeInput): Promise<LoreNode>;
    getNode?(id: string): Promise<LoreNode | null>;
    insertNodeIfAbsent?(node: NodeInput): Promise<LoreNode>;
}

/**
 * Create `node` only when no node holds its id (superseded and stale nodes
 * count as present). Throws {@link NodeAlreadyExistsError} when one does. The
 * caller holds the id's node lock; the engine verb adds the database-level
 * check where the store has one.
 */
export async function createNodeIfAbsent(graph: ConditionalInsertGraph, node: NodeInput): Promise<LoreNode> {
    if (typeof graph.insertNodeIfAbsent === 'function') return graph.insertNodeIfAbsent(node);
    if (typeof graph.getNode !== 'function') {
        throw new Error('ifAbsent needs a graph that can read nodes (getNode) or insert conditionally (insertNodeIfAbsent)');
    }
    if (await graph.getNode(node.id) !== null) throw new NodeAlreadyExistsError(node.id);
    return graph.upsertNode(node);
}

/**
 * Replay of a `node.upsert` outbox row that carries `ifAbsent: true`. The live
 * write already tried the insert; the row only re-asserts it, so the replay is
 * insert-only and a node that is already there (ours, or a different writer's)
 * is left alone. Returns false when it was a no-op. The flag is dropped from
 * the record: it is a directive, never a stored field.
 */
export async function replayIfAbsentUpsert(graph: ConditionalInsertGraph, payload: Record<string, unknown>): Promise<boolean> {
    const { ifAbsent: _directive, ...node } = payload;
    try {
        await createNodeIfAbsent(graph, node as unknown as NodeInput);
        return true;
    } catch (err) {
        if (isNodeAlreadyExists(err)) return false;
        throw err;
    }
}

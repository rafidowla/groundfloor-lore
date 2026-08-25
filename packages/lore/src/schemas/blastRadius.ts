/**
 * blastRadius.ts — Phase 3 item 1: compute affected-row counts for a
 * schema proposal at propose-time, so the approver sees what they're
 * approving instead of trusting the proposer's self-labelled
 * MigrationStrategy.
 *
 * Why this exists:
 *   Today `SchemaProposal.changes[].migration` is `'lazy' | 'dual-shape'
 *   | 'not-applicable'` chosen by the *proposer*. Lore writes it to the
 *   audit log and trusts it. An agent that mis-classifies (or lies
 *   about) a destructive change as lazy can convince a human approver
 *   the change is safe. This module computes one piece of ground truth
 *   from the live graph — affected row count — so the human reading
 *   the proposal sees the real cost. Reader-count + reversibility
 *   are deferred to Phase 4 (they need the dependency graph and
 *   per-substrate cost models).
 *
 * Per-change semantics:
 *   node_type.added            → 0 (new type, no rows)
 *   node_type.removed          → COUNT(LoreNode WHERE type = X)
 *   node_type.renamed          → COUNT(LoreNode WHERE type = oldX)
 *   node_type.kind_changed     → COUNT(LoreNode WHERE type = X)
 *   field.added                → 0 (additive)
 *   field.removed              → COUNT(LoreNode WHERE type = parentType)
 *   field.type_changed         → COUNT(LoreNode WHERE type = parentType)
 *   field.sensitivity_flipped  → COUNT(LoreNode WHERE type = parentType)
 *   edge_type.added            → 0 (additive)
 *   edge_type.removed          → COUNT(LoreEdge WHERE relation = X)
 *   permission.* / workspace.* → null with note (not data-shaped)
 *
 * Failure mode:
 *   If the graph is unreachable or a query throws, the per-change
 *   entry records `affectedRowCount: null` with a `note` explaining
 *   why. propose() does NOT abort on blast-radius failures —
 *   approval would still be possible (the data is there to be
 *   snapshotted later by approve()); we just lose the upfront visibility.
 *   This is opposite to `dataSnapshot.ts`'s fail-closed posture
 *   because blast radius is advisory, not protective.
 */

import type { ProposedChange } from './authoring.js';
import type { SchemaGraphOps } from './substrate/schemaGraphOps.js';

export interface BlastRadiusEntry {
    kind: string;
    target: string;
    /** Number of existing rows the change would touch. `null` when
     *  the change has no row-level shape (permission/workspace edits),
     *  OR when computation failed (see `note`). */
    affectedRowCount: number | null;
    /**
     * Phase 4 item 11 — reader-dependency count. Approximates "who
     * actually depends on this schema entity today":
     *   - field.* changes  → rows whose value for the field is non-null
     *                        and non-empty (i.e. live readers of the
     *                        column). `null` for additive field.added.
     *   - node_type.* changes → inbound edges that terminate on a node
     *                           of this type (i.e. relations that
     *                           would dangle on removal).
     *   - edge_type.removed → same as affectedRowCount (every edge IS
     *                         a reader).
     *   - permission / workspace metadata → `null` (no row-level
     *                                       reader concept).
     * `null` ALSO when the underlying count throws — the entry
     * carries a `note` in that case.
     */
    readerCount?: number | null;
    /** Human-readable explanation when affectedRowCount is null or
     *  zero-for-a-reason. Mirrors SnapshotResult.note. */
    note?: string;
}

export interface BlastRadius {
    /** Sum of all non-null per-change row counts. 0 if every change
     *  is additive / not-data-shaped. */
    total: number;
    perChange: BlastRadiusEntry[];
    /** ISO timestamp the blast radius was computed at (propose-time). */
    computedAt: string;
}

/**
 * Compute blast radius for every change in the proposal against the
 * supplied graph reader. Never throws — per-change failures are
 * recorded in-band so the proposal still goes through. (See the
 * fail-open vs fail-closed rationale in the module header.)
 */
export async function computeBlastRadius(
    changes: ReadonlyArray<ProposedChange>,
    graph: SchemaGraphOps,
): Promise<BlastRadius> {
    const perChange: BlastRadiusEntry[] = [];
    for (const change of changes) {
        perChange.push(await computeOne(change, graph));
    }
    const total = perChange.reduce(
        (acc, e) => acc + (e.affectedRowCount ?? 0),
        0,
    );
    return {
        total,
        perChange,
        computedAt: new Date().toISOString(),
    };
}

async function computeOne(
    change: ProposedChange,
    graph: SchemaGraphOps,
): Promise<BlastRadiusEntry> {
    const target = String(change.target);

    switch (change.kind) {
        case 'node_type.added':
            return zero(change, 'additive — no existing rows to touch');
        case 'field.added':
            return zero(change, 'additive — no existing rows carry this field yet');
        case 'edge_type.added':
            return zero(change, 'additive — no existing edges of this relation');

        case 'node_type.removed':
        case 'node_type.renamed':
        case 'node_type.kind_changed': {
            const entry = await countNodesOfType(change, target, graph);
            entry.readerCount = await countInboundEdges(target, graph);
            return entry;
        }

        case 'field.removed':
        case 'field.type_changed':
        case 'field.sensitivity_flipped': {
            // target is "<NodeType>.<field>" — strip the last segment.
            const nodeType = target.replace(/\.[^.]+$/, '');
            const entry = await countNodesOfType(change, nodeType, graph);
            // Reader count for a field == nodes carrying the field
            // (upper bound). The precise non-null count is computed at
            // snapshot time (Phase 1 snapshotter) where metadata is
            // parsed substrate-side.
            entry.readerCount = entry.affectedRowCount;
            return entry;
        }

        case 'edge_type.removed': {
            const entry = await countEdgesOfRelation(change, target, graph);
            // Every edge IS a reader of the relation.
            entry.readerCount = entry.affectedRowCount;
            return entry;
        }

        case 'permission.added':
        case 'permission.changed':
        case 'permission.removed':
            return notDataShaped(change, 'permission change has no row-level shape');

        case 'workspace.system_prompt_changed':
        case 'workspace.domain_changed':
            return notDataShaped(change, 'workspace metadata change has no row-level shape');

        default:
            return notDataShaped(change, `unknown change kind: ${change.kind}`);
    }
}

async function countNodesOfType(
    change: ProposedChange,
    nodeType: string,
    graph: SchemaGraphOps,
): Promise<BlastRadiusEntry> {
    try {
        const c = await graph.countNodesByType(nodeType);
        return {
            kind: change.kind,
            target: String(change.target),
            affectedRowCount: c,
        };
    } catch (err) {
        return failed(change, `node count failed: ${(err as Error).message}`);
    }
}

async function countEdgesOfRelation(
    change: ProposedChange,
    relation: string,
    graph: SchemaGraphOps,
): Promise<BlastRadiusEntry> {
    try {
        const c = await graph.countEdgesByRelation(relation);
        return {
            kind: change.kind,
            target: String(change.target),
            affectedRowCount: c,
        };
    } catch (err) {
        return failed(change, `edge count failed: ${(err as Error).message}`);
    }
}

/** Phase 4 item 11 — inbound edge count for a node type. Returns 0
 *  on substrate failure (additive on top of affectedRowCount; not a
 *  protective signal). */
async function countInboundEdges(
    nodeType: string,
    graph: SchemaGraphOps,
): Promise<number | null> {
    try {
        return await graph.countInboundEdgesToType(nodeType);
    } catch {
        return null;
    }
}

function zero(change: ProposedChange, note: string): BlastRadiusEntry {
    return {
        kind: change.kind,
        target: String(change.target),
        affectedRowCount: 0,
        note,
    };
}

function notDataShaped(change: ProposedChange, note: string): BlastRadiusEntry {
    return {
        kind: change.kind,
        target: String(change.target),
        affectedRowCount: null,
        note,
    };
}

function failed(change: ProposedChange, note: string): BlastRadiusEntry {
    return {
        kind: change.kind,
        target: String(change.target),
        affectedRowCount: null,
        note,
    };
}

/**
 * discoveryAccept.ts - decide a typing proposal (Links Loop D). Library API only: no HTTP route and no new permission.
 *
 * `supersedes` is applied through the SAME path as POST /api/node/supersede: the graph's own `supersedeNode` under the
 * node locks (its conditional claim covers other processes), then the semantic `supersedes` edge (outbox first when
 * an outbox exists) and the question-alias tombstones. A proposal that is no longer true (the older node is already
 * superseded) is marked `stale`, not applied.
 *
 * `contradicts` records a `contradicts` edge between the two nodes. It does not retire either node: which one is
 * current stays a person's decision (use the supersede path for that).
 *
 * Nothing here runs unless a caller invokes it: discovery never accepts its own proposals.
 */
import { withEdgeLock, withNodeLocks } from '../core/nodeWriteLock.js';
import { tombstoneQuestionAliases } from '../core/nodeServiceVerbatim.js';
import { ALREADY_SUPERSEDED_REASON, type SupersedeResult } from '../engines/graphShared/supersedeGuard.js';
import { recordHotWrite } from '../outbox/hotLane.js';
import type { OutboxStore } from '../outbox/types.js';
import type { LinkProposal, ProposalStore } from './proposalStore.js';

export interface AcceptGraph {
    supersedeNode(oldId: string, newId: string, reason?: string): Promise<SupersedeResult>;
    addEdge(edge: { sourceId: string; targetId: string; relation: string; confidence: 'extracted' | 'inferred'; confidenceScore: number }): Promise<unknown>;
}

export interface DecideDeps {
    workspace: string;
    graph: AcceptGraph | null;
    proposals: ProposalStore;
    outbox?: OutboxStore | null;
    now(): number;
    onError?(message: string): void;
}

export interface DecideOptions { by?: string | null; note?: string | null }

export type DecideOutcome =
    | { ok: true; proposal: LinkProposal }
    | { ok: false; reason: 'not_found' | 'not_pending' | 'workspace_unavailable' | 'already_superseded' | 'supersede_failed'; detail?: string };

const INITIATOR = 'link:proposal-accept';

async function writeEdge(d: DecideDeps, edge: { sourceId: string; targetId: string; relation: string; confidence: 'extracted'; confidenceScore: number }): Promise<void> {
    await withEdgeLock(d.workspace, edge.sourceId, edge.targetId, edge.relation, async () => {
        if (d.outbox) {
            await recordHotWrite(d.outbox, { workspace: d.workspace, operationKind: 'edge.upsert', payload: { ...edge, bidirectional: false }, initiator: INITIATOR, operation: 'edge.upsert' });
        }
        await d.graph!.addEdge(edge);
    });
}

export async function acceptProposal(d: DecideDeps, id: number, opt: DecideOptions = {}): Promise<DecideOutcome> {
    const p = d.proposals.get(d.workspace, id);
    if (!p) return { ok: false, reason: 'not_found' };
    if (p.status !== 'pending') return { ok: false, reason: 'not_pending', detail: p.status };
    if (!d.graph) return { ok: false, reason: 'workspace_unavailable' };
    const by = opt.by ?? null;
    if (p.kind === 'contradicts') {
        await writeEdge(d, { sourceId: p.fromId, targetId: p.toId, relation: 'contradicts', confidence: 'extracted', confidenceScore: Math.min(1, Math.max(0, p.score)) });
        d.proposals.decide(d.workspace, id, 'accepted', d.now(), by, opt.note ?? null);
        return { ok: true, proposal: d.proposals.get(d.workspace, id)! };
    }
    const oldId = p.toId, newId = p.fromId;
    const reason = `link discovery (${p.typer}): ${p.reason ?? 'near-duplicate'}`;
    const result = await withNodeLocks(d.workspace, [...new Set([oldId, newId])], () => d.graph!.supersedeNode(oldId, newId, reason));
    if (!result.ok) {
        if (result.reason === ALREADY_SUPERSEDED_REASON) {
            d.proposals.decide(d.workspace, id, 'stale', d.now(), by, 'already superseded');
            return { ok: false, reason: 'already_superseded', detail: result.supersededBy };
        }
        return { ok: false, reason: 'supersede_failed', detail: result.reason };
    }
    if (!result.unchanged) {
        try {
            await writeEdge(d, { sourceId: newId, targetId: oldId, relation: 'supersedes', confidence: 'extracted', confidenceScore: 1.0 });
        } catch (err) {
            d.onError?.(`link proposal ${id}: supersedes edge ${newId}->${oldId} failed (non-fatal; supersededBy is authoritative): ${(err as Error).message}`);
        }
        if (d.outbox) {
            await tombstoneQuestionAliases({ id: oldId, workspace: d.workspace, initiator: INITIATOR, logPrefix: '[Lore link]', outboxStore: d.outbox });
        }
    }
    d.proposals.decide(d.workspace, id, 'accepted', d.now(), by, opt.note ?? null);
    return { ok: true, proposal: d.proposals.get(d.workspace, id)! };
}

export function rejectProposal(d: Pick<DecideDeps, 'workspace' | 'proposals' | 'now'>, id: number, opt: DecideOptions = {}): DecideOutcome {
    const p = d.proposals.get(d.workspace, id);
    if (!p) return { ok: false, reason: 'not_found' };
    if (p.status !== 'pending') return { ok: false, reason: 'not_pending', detail: p.status };
    d.proposals.decide(d.workspace, id, 'rejected', d.now(), opt.by ?? null, opt.note ?? null);
    return { ok: true, proposal: d.proposals.get(d.workspace, id)! };
}

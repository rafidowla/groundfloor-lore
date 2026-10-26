/**
 * discoveryTyping.ts - turns typing verdicts into outcomes (Links Loop D).
 *
 *   - `supports`                  => an inferred `supports` edge (origin `discovery`), written through the linker's
 *                                    batched, caller-safe write path.
 *   - `contradicts`, `supersedes` => a PROPOSAL row only. Nothing about what recall treats as current changes until
 *                                    a person accepts it (discoveryAccept.ts).
 *
 * NEW pairs (just linked by this pass) go through the whole cascade. Pairs that were already linked are only offered
 * to the rules tier (cheap, pure, idempotent: the proposal store dedupes), so a corpus linked by arrival before
 * discovery was switched on still gets its near-duplicate supersession proposals without paying for a model per pass.
 */
import type { LoreNode } from '../providers/types.js';
import type { BatchEdgeResult, InferredEdge } from './linkTypes.js';
import type { ProposalStore } from './proposalStore.js';
import { capText, type RelationCandidate, type RelationVerdict, type RulesTyper, type TypingCascade, type TypingContext, type TypingNode } from './relationTyper.js';

export interface TypingGraph { getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>> }

export interface TypingPair { lo: string; hi: string; score: number; isNew: boolean }

export interface TypingDeps {
    workspace: string;
    graph: TypingGraph;
    cascade: TypingCascade;
    rules: RulesTyper;
    proposals: ProposalStore;
    policyVersion: string;
    now(): number;
    ctx: TypingContext;
    write(edges: InferredEdge[]): Promise<BatchEdgeResult>;
}

export interface TypingOutcome { supportsAdded: number; proposalsRaised: number; typed: number }

const toTypingNode = (n: LoreNode): TypingNode => ({
    id: n.id, label: capText(n.label ?? '', 300), content: capText(typeof n.content === 'string' ? n.content : ''),
    createdAt: n.createdAt, updatedAt: n.updatedAt, supersededBy: n.supersededBy ? n.supersededBy : null,
});

/** `modelFingerprint` of a typed edge: the typer id, plus the NOT SOVEREIGN marker when the verdict left this machine. */
export const typedFingerprint = (v: Pick<RelationVerdict, 'typer' | 'sovereign'>): string => `${v.typer}${v.sovereign ? '' : '!NOT-SOVEREIGN'}`;

export async function typePairs(d: TypingDeps, pairs: readonly TypingPair[]): Promise<TypingOutcome> {
    const out: TypingOutcome = { supportsAdded: 0, proposalsRaised: 0, typed: 0 };
    if (pairs.length === 0) return out;
    const nodes = await d.graph.getNodesByIds([...new Set(pairs.flatMap((p) => [p.lo, p.hi]))]);
    const supports: InferredEdge[] = [];
    const supportsVerdicts: Array<{ lo: string; hi: string; v: RelationVerdict }> = [];
    for (const p of [...pairs].sort((x, y) => y.score - x.score || x.lo.localeCompare(y.lo))) {
        const a = nodes.get(p.lo), b = nodes.get(p.hi);
        if (!a || !b || a.supersededBy || b.supersededBy) continue;
        const cand: RelationCandidate = { a: toTypingNode(a), b: toTypingNode(b), score: p.score };
        const v = p.isNew ? await d.cascade.type(cand, d.ctx) : await d.rules.type(cand);
        if (!v) continue;
        out.typed++;
        const at = d.now();
        if (v.relation === 'supports') {
            supports.push({
                sourceId: p.lo, targetId: p.hi, relation: 'supports', confidenceScore: v.confidence,
                provenance: { origin: 'discovery', policyVersion: d.policyVersion, modelFingerprint: typedFingerprint(v) },
            });
            supportsVerdicts.push({ lo: p.lo, hi: p.hi, v });
            continue;
        }
        const fromId = v.relation === 'supersedes' ? (v.newerId ?? p.hi) : p.lo;
        const toId = v.relation === 'supersedes' ? (v.olderId ?? p.lo) : p.hi;
        const added = d.proposals.add({
            workspace: d.workspace, kind: v.relation, fromId, toId, score: v.confidence, typer: v.typer, sovereign: v.sovereign, reason: v.reason ?? null,
        }, at);
        if (added) {
            out.proposalsRaised++;
            d.proposals.log({ workspace: d.workspace, a: p.lo, b: p.hi, relation: v.relation, typer: v.typer, sovereign: v.sovereign, confidence: v.confidence, outcome: 'proposal', at });
        }
    }
    if (supports.length > 0) {
        const res = await d.write(supports);
        out.supportsAdded = res.written;
        const at = d.now();
        for (const s of supportsVerdicts) {
            d.proposals.log({ workspace: d.workspace, a: s.lo, b: s.hi, relation: 'supports', typer: s.v.typer, sovereign: s.v.sovereign, confidence: s.v.confidence, outcome: 'edge_written', at });
        }
    }
    return out;
}

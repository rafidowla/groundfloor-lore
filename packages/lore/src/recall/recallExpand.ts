/**
 * recallExpand.ts — 3.21 step 3(g). Fetches full node bodies for a set of
 * ids a caller chose after inspecting `recall`'s `compact:true` candidates.
 *
 * Confinement is the whole point of a SEPARATE call here rather than "just
 * fetch by id": a candidate id from one recall MUST NOT be expandable by a
 * caller whose workspace/ecosystem/actor scope wouldn't have surfaced it in
 * the first place. Three independent gates, matching retrieve.ts's own
 * confinement for the same reasons (see retrieve.ts's D2-recall-1/2 comment
 * and its ecosystem-seed-union doc):
 *   1. workspace — the caller supplies the SAME workspace recall ran
 *      against; ids are looked up via THAT workspace's own graph handle, so
 *      an id that only exists in a different workspace's graph is simply
 *      never found (each workspace is a physically separate graph/table).
 *   2. ecosystem — `ecosystemMatches` (core/ecosystemMatch.ts), the same
 *      predicate retrieve.ts's post-hydration filter uses.
 *   3. actor scope — `filterNodesByActorScope` (security/scopeFilter.ts),
 *      the same row-level `security_scopes` gate retrieve.ts applies to
 *      every seed + traversal node.
 * A requested id that fails any gate is silently DROPPED from the result
 * (not an error) — the caller already knows which candidates it asked for;
 * the response tells it which ones it may actually see, exactly like a
 * hydration miss in retrieve.ts itself.
 */

import type { LoreNode } from '../providers/types.js';
import { ecosystemMatches } from '../core/ecosystemMatch.js';
import { applyActorScopeFilter } from '../security/scopeFilter.js';
import { getCurrentActorScopes } from '../security/actorContext.js';

/** Minimal graph surface expand needs — satisfied by every LoreGraphHandle. */
export interface ExpandGraph {
    getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>>;
}

export const MAX_EXPAND_IDS = 50;

export interface ExpandedNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string[];
    project: string;
    language?: string | null;
    updatedAt: string;
}

/** Same actor-scope wrapping retrieve.ts uses (filterNodesByActorScope) —
 *  `metadata` on a hydrated LoreNode is a JSON STRING, not the structured
 *  shape applyActorScopeFilter reads `security_scopes` off of, so each node
 *  is wrapped with its own top-level `security_scopes` field before the
 *  filter runs. */
function filterNodesByActorScope(nodes: LoreNode[]): LoreNode[] {
    const wrapped = nodes.map((node) => ({ node, metadata: { security_scopes: node.security_scopes } }));
    return applyActorScopeFilter(wrapped, getCurrentActorScopes()).map((w) => w.node);
}

/**
 * Expand up to MAX_EXPAND_IDS ids into full node bodies, confined to
 * `graph`'s workspace, `ecosystemScope`, and the bound actor's scopes.
 * Ids beyond the cap are ignored (not rejected — same "clamp, don't 400"
 * posture `limit`/`max` params take elsewhere in this file family).
 * Returns nodes in the SAME order as the (capped, deduped) input ids.
 */
export async function expandCandidates(
    graph: ExpandGraph,
    ids: string[],
    ecosystemScope: string,
): Promise<ExpandedNode[]> {
    const capped = [...new Set(ids)].slice(0, MAX_EXPAND_IDS);
    if (capped.length === 0) return [];
    const byId = await graph.getNodesByIds(capped);
    const found = capped.map((id) => byId.get(id)).filter((n): n is LoreNode => n !== undefined);
    const ecoScoped = found.filter((n) => ecosystemMatches((n as { ecosystem?: string }).ecosystem, ecosystemScope));
    const scoped = filterNodesByActorScope(ecoScoped);
    const visible = new Set(scoped.map((n) => n.id));
    return capped
        .filter((id) => visible.has(id))
        .map((id) => scoped.find((n) => n.id === id)!)
        .map((n) => ({
            id: n.id, type: n.type, label: n.label, content: n.content, tags: n.tags,
            project: n.project, language: (n as { language?: string | null }).language ?? null,
            updatedAt: n.updatedAt,
        }));
}

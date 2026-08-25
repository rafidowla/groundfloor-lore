/**
 * retrievalProjection.ts — the ONE place a retrieve() result becomes a
 * surface response item (Retrieval Unification, D4).
 *
 * Every surface that exposes a flat result list (the MCP `search` tool, REST
 * /api/search, …) projects through here, so the `matchedBy` + `score` contract
 * is identical everywhere and can't drift field-by-field. Presentation that is
 * NOT a flat list (recall's summary/full shaping) has its own projection.
 */

import type { MatchKind, RetrievalResult } from './retrieve.js';

/** The unified per-result shape exposed by flat-list surfaces (D4). */
export interface UnifiedResultItem {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string[];
    project: string;
    language: string | null;
    /** Which retrieval method(s) surfaced this node. */
    matchedBy: MatchKind[];
    /** Relative retrieval confidence within this result set (0..1). */
    score: number;
    stale_warning?: true;
}

/** Structural view of a node — both LoreNode shapes satisfy it. */
export interface ProjectableNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string[];
    project: string;
    language?: string | null;
    stale?: boolean;
}

// Internal — the single field-mapping step shared by the project* helpers
// below. Not exported: every surface goes through projectResults/projectScored/
// projectKeywordNodes, never the per-node mapper directly (P5 dead-export sweep).
function projectNode(node: ProjectableNode, matchedBy: MatchKind[], score: number): UnifiedResultItem {
    const item: UnifiedResultItem = {
        id: node.id, type: node.type, label: node.label, content: node.content,
        tags: node.tags, project: node.project, language: node.language ?? null,
        matchedBy, score: parseFloat(score.toFixed(3)),
    };
    if (node.stale) item.stale_warning = true;
    return item;
}

/** Project the shared core's results (the normal path). */
export function projectResults(results: RetrievalResult[]): UnifiedResultItem[] {
    return results.map((r) => projectNode(r.node as unknown as ProjectableNode, r.matchedBy, r.score));
}

/** Project an already-scored {node,matchedBy,score} list (e.g. a surface that
 *  merged core + legacy items). */
export function projectScored(items: Array<{ node: ProjectableNode; matchedBy: MatchKind[]; score: number }>): UnifiedResultItem[] {
    return items.map((s) => projectNode(s.node, s.matchedBy, s.score));
}

/** Project raw keyword-only nodes (legacy "*" boot-graph scan; no score). */
export function projectKeywordNodes(nodes: ProjectableNode[]): UnifiedResultItem[] {
    return nodes.map((n) => projectNode(n, ['keyword'], 0));
}

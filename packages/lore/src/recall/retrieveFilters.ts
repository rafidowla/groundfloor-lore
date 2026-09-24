/**
 * retrieveFilters.ts — actor-scope + entities/topics/project filters shared
 * by retrieve.ts's seed-level and results-level filter passes.
 *
 * Split out of retrieve.ts (D3, docs/design/D3-prefix-stable-ranking.md
 * §3.1): retrieve.ts is at the repo's 800-line hard cap, and these three
 * functions have no dependency on anything else in that file — a clean,
 * low-coupling extraction, same move `retrieveSeedStore.ts` and
 * `multiQuerySeedFetch.ts` already made for other retrieve.ts concerns.
 */

import type { LoreNode } from '../providers/types.js';
import { applyActorScopeFilter } from '../security/scopeFilter.js';
import { getCurrentActorScopes } from '../security/actorContext.js';

/**
 * D2-recall-1/2 — Row-level security_scopes enforcement on the localGraph
 * reads inside the shared retrieval core.
 *
 * applyActorScopeFilter() (used directly in VerbatimStore.search) reads
 * `row.metadata?.security_scopes`, but a hydrated LoreNode carries
 * `security_scopes` as a TOP-LEVEL string[] and `metadata` as a JSON STRING
 * (see localGraphReads.rowToLoreNode). Passing LoreNodes straight in is a
 * no-op (metadata is a string → `.security_scopes` is undefined → every row
 * looks public). So we wrap each node in the ScopedRow shape the filter
 * expects, filter against the bound actor's scopes, and return the surviving
 * nodes. Mirrors VerbatimStore's `applyActorScopeFilter(mapped, getCurrentActorScopes())`
 * source of scopes; undefined (no bound actor / local mode) ⇒ no filtering.
 */
export function filterNodesByActorScope(nodes: LoreNode[]): LoreNode[] {
    const wrapped = nodes.map((node) => ({ node, metadata: { security_scopes: node.security_scopes } }));
    return applyActorScopeFilter(wrapped, getCurrentActorScopes()).map((w) => w.node);
}

/** 3.21 step 3(f) — read `entities`/`topics` (3.21 step 3(e)) off a node's
 *  `metadata` JSON. Malformed/missing metadata reads as an empty list
 *  (never throws) — same tolerant-parse convention as
 *  questionAliases.ts's mergeQuestionsMetaIntoMetadataJson. */
export function nodeMetaList(node: LoreNode, key: 'entities' | 'topics'): string[] {
    const raw = (node as { metadata?: string }).metadata;
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const list = parsed?.[key];
        return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

/** 3.21 step 3(f) — entities/topics/project filter, shared by the seed-level
 *  and results-level filter passes below (same "apply at both points"
 *  reasoning Finding 5.2 already established for `tags`). */
export function passesEntitiesTopicsProject(
    node: LoreNode,
    entitiesFilter: string[] | undefined,
    topicsFilter: string[] | undefined,
    projectFilter: string | undefined,
): boolean {
    if (entitiesFilter && entitiesFilter.length > 0) {
        const have = nodeMetaList(node, 'entities');
        if (!entitiesFilter.every((e) => have.includes(e))) return false;
    }
    if (topicsFilter && topicsFilter.length > 0) {
        const have = nodeMetaList(node, 'topics');
        if (!topicsFilter.every((t) => have.includes(t))) return false;
    }
    if (projectFilter && node.project !== projectFilter) return false;
    return true;
}

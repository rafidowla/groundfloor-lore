/**
 * apiQueryHydration.ts — D5 extraction from search.ts's POST /api/query
 * handler. Pulled out purely to keep search.ts under the 800-line
 * file-size guardrail (test:arch) after routing /api/query's seed +
 * keyword-fallback hydration through the shared D5 supersession-recall
 * helper (see routes/search.ts's `admitD5` doc comment for why this
 * surface gets successor REPLACEMENT but not `corrects` adjacency).
 *
 * No behavior lives here that didn't already live inline in search.ts —
 * this is a lift-and-shift, not a redesign.
 */

import type { LoreNode } from '../../../providers/types.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import { resolveQuerySeedStore } from '../../../recall/querySeedStore.js';
import { resolveLiveNodes } from '../../../recall/supersessionRecall.js';
import type { SearchDeps } from './search.js';

type LoreGraph = LoreGraphHandle;

export interface ApiQueryHydrationParams {
    deps: SearchDeps;
    queryGraph: LoreGraph;
    workspace: string;
    query: string;
    queryEcosystem: string;
    limit: number;
    useVerbatim: boolean;
    outsideEcosystem: (n: LoreNode) => boolean;
    admitD5: (n: LoreNode) => boolean;
}

export interface ApiQueryHydrationResult {
    hits: LoreNode[];
    scanCapHit: boolean;
}

/**
 * Seeds from the workspace's own verbatim store (when useVerbatim), then
 * fills any remaining slots up to `limit` from a keyword scan — both legs
 * resolved through `resolveLiveNodes` (D5 #5) so a superseded hit's slot
 * is replaced by its live successor instead of just being hidden.
 */
export async function hydrateApiQueryHits(params: ApiQueryHydrationParams): Promise<ApiQueryHydrationResult> {
    const { deps, queryGraph, workspace, query, queryEcosystem, limit, useVerbatim, outsideEcosystem, admitD5 } = params;
    const seenIds = new Set<string>();
    const hits: LoreNode[] = [];

    if (useVerbatim) {
        // P2 (isolation) — seed against the REQUESTED workspace's OWN
        // verbatim store, not the boot-bound (active-workspace) handle.
        // Mirrors /api/recall + /api/search, which resolve per-workspace
        // via retrieve()'s resolveSeedStore. Without this, a query for a
        // non-active workspace count-gates on and seeds from the active
        // workspace's LanceDB (cross-workspace leak / empty recall).
        const seedStore = await resolveQuerySeedStore(deps, queryGraph, workspace);
        // null → no per-workspace verbatim store (non-active ws with no
        // resolver, or getOrOpen failed). SKIP the vector seed entirely
        // and fall through to the keyword scan below — never seed from
        // the boot/active store (that is the cross-workspace leak).
        const verbatimCount = seedStore ? await seedStore.count() : 0;
        if (seedStore && verbatimCount > 0) {
            const seeds = await seedStore.search(query, limit);
            // SW-16: batch-hydrate seeds in one query; iterate in
            // original order to preserve dedupe + result ordering.
            const strippedIds = seeds.map((seed) =>
                seed.id.startsWith('lore:') ? seed.id.slice(5) : seed.id);
            const seedNodes = await queryGraph.getNodesByIds(strippedIds).catch(() => new Map<string, LoreNode>());
            const seedCandidates: LoreNode[] = [];
            seeds.forEach((seed, idx) => {
                const stripped = strippedIds[idx]!;
                if (seenIds.has(stripped)) return;
                const n = seedNodes.get(stripped);
                if (n && !outsideEcosystem(n)) seedCandidates.push(n);
            });
            // D5 #5 — successor replacement instead of a bare
            // `!n.supersededAt` hide filter.
            const resolvedSeeds = await resolveLiveNodes(seedCandidates, queryGraph, admitD5);
            for (const n of resolvedSeeds) {
                if (seenIds.has(n.id)) continue;
                hits.push(n);
                seenIds.add(n.id);
            }
        }
    }

    const querySignals = { scanCapHit: false };
    if (hits.length < limit) {
        const remaining = limit - hits.length;
        // project scope is '*', NOT `workspace`. localGraphReads.ts's
        // search() turns the third argument into a strict
        // `n.project = $project` predicate, and `project` is a
        // CALLER-OWNED node field that is not guaranteed to equal the
        // workspace name — Atlas stores project='v3' inside
        // workspace='default'. retrieve.ts:314-321 documents this exact
        // mistake as the one that "silently makes keyword fallback
        // empty while the vector path still appears healthy", and
        // passes '*' for that reason. The physical workspace boundary
        // is already enforced by the graph resolution the caller did.
        const fallback = await queryGraph.search(
            query, remaining + seenIds.size,
            '*', queryEcosystem, false, querySignals,
        );
        const fallbackCandidates: LoreNode[] = [];
        for (const n of fallback) {
            if (seenIds.has(n.id) || outsideEcosystem(n)) continue;
            fallbackCandidates.push(n);
        }
        // D5 #5 — successor replacement instead of a bare
        // `!n.supersededAt` hide filter.
        const resolvedFallback = await resolveLiveNodes(fallbackCandidates, queryGraph, admitD5);
        for (const n of resolvedFallback) {
            if (hits.length >= limit) break;
            if (seenIds.has(n.id)) continue;
            hits.push(n);
            seenIds.add(n.id);
        }
    }

    return { hits, scanCapHit: querySignals.scanCapHit };
}

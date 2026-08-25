/**
 * supersessionCandidates.ts — GET /api/node/supersession-candidates.
 *
 * For each non-superseded node of the requested types, runs a vector
 * search of its verbatim text against its siblings (same project) and
 * returns pairs above the similarity threshold. The UI presents these as
 * "did you mean to supersede X with Y?" cards.
 *
 *   GET /api/node/supersession-candidates?project=...&minScore=0.7&fresh=true
 *
 * Result is cached for 10 min per (project, minScore, types) tuple because
 * the embed-heavy scan takes 30-60s on a real graph. Pass `fresh=true` to
 * bust the cache after running supersede. The cache lives in this module —
 * it's only used by this one route.
 */

import { isCrossEcosystemPair } from '../../../../core/ecosystemMatch.js';
import type { ServerResponse } from 'node:http';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { resolveReadGraph } from './readGate.js';
import type { NodesDeps } from './types.js';
import { redactError } from '../../../../security/logRedact.js';
import { writeError } from '../../helpers.js';
import { forEachNodePage, type NodePager } from '../../../../engines/nodePager.js';

const supersessionCandidatesCache = new Map<string, { payload: unknown; savedAt: number }>();

/** A verbatim similarity search bound to ONE workspace's LanceDB. */
type CandidateSearch = (query: string, limit: number) => Promise<Array<{ id: string; score: number }>>;

/**
 * P2 (isolation) — resolve the verbatim search fn for the REQUESTED workspace,
 * mirroring retrieve.ts::resolveSeedStore. Returns null (caller SKIPS the vector
 * scan) for a non-active workspace with no resolver or a failed open — never the
 * boot/active store, which only sees the ACTIVE workspace's vectors.
 */
async function resolveCandidateSearch(
    readGraph: NodesDeps['store']['loreGraph'],
    workspace: string,
    deps: NodesDeps,
): Promise<CandidateSearch | null> {
    // Active/boot graph → boot storageClient (its verbatim handle already points
    // at exactly this workspace's LanceDB; unchanged pre-P2 path).
    if (readGraph === deps.store.loreGraph) {
        return (q, n) => deps.store.storageClient.verbatimSearch(q, n);
    }
    if (!deps.workspaceVerbatimResolver) return null;
    try {
        const store = await deps.workspaceVerbatimResolver.getOrOpen(workspace);
        return (q, n) => store.search(q, n);
    } catch {
        // Never-embedded / missing LanceDB / chokepoint denial — skip the scan.
        return null;
    }
}

export async function handleSupersessionCandidates(res: ServerResponse, url: string, deps: NodesDeps): Promise<void> {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    // NW-7f (api-002) — pre-fix this route skipped the SP-04 read gate
    // every other single-node read endpoint runs through. A token bound
    // to workspace A could enumerate B's candidate pairs because the
    // call hit `deps.store.storageClient.listNodes(...)` with no
    // workspace argument. Run the shared read gate here so the route
    // (a) requires an explicit `workspace=` param (no silent fallback),
    // (b) refuses cross-workspace requests, and (c) routes the read to
    // the requested workspace's graph via graphRegistry. resolveReadGraph
    // writes the 4xx response itself; we just bail on null.
    const readGraph = await resolveReadGraph(res, url, deps);
    if (!readGraph) return;
    // P2 (isolation) — resolve the verbatim (LanceDB) store for the REQUESTED
    // workspace, mirroring retrieve.ts::resolveSeedStore. The similarity scan
    // below (verbatimSearch) must hit the SAME workspace whose graph
    // resolveReadGraph just routed to — NOT the boot-bound storageClient, which
    // only sees the ACTIVE workspace's vectors. Seeding a wsB scan from wsA's
    // LanceDB would surface foreign ids and pair B's nodes against A's vectors.
    //   - boot/active graph → boot storageClient (unchanged; its handle already
    //     points at this workspace's LanceDB).
    //   - non-active WITH a resolver → getOrOpen(workspace).
    //   - no resolver, or open fails → null → SKIP the vector scan (return no
    //     pairs) rather than seeding from the active store.
    const scanWorkspace = new URL(url, 'http://localhost').searchParams.get('workspace') ?? '';
    const verbatimSearch = await resolveCandidateSearch(readGraph, scanWorkspace, deps);
    try {
        const cp = new URL(url, 'http://localhost').searchParams;
        const projectFilter = cp.get('project') ?? undefined;
        const minScore = parseFloat(cp.get('minScore') ?? '0.78');
        const typesParam = cp.get('types') ?? 'decision,architecture,convention,bug_pattern';
        const allowedTypes = new Set(typesParam.split(',').map((t) => t.trim()).filter(Boolean));
        const fresh = cp.get('fresh') === 'true';

        // 10-min in-memory cache keyed on the workspace too (3.2) — the scan is
        // scoped per-workspace, so a key missing the workspace would leak
        // workspace A's cached candidate pairs to workspace B.
        const cacheKey = `${scanWorkspace}::${projectFilter ?? '*'}::${minScore}::${typesParam}`;
        if (!fresh) {
            const cached = supersessionCandidatesCache.get(cacheKey);
            if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...(cached.payload as Record<string, unknown>), cached: true, cachedAgeMs: Date.now() - cached.savedAt }));
                return;
            }
        }

        // Pull all candidate nodes (current + same project + matching
        // types) from the workspace-resolved graph. Pre-NW-7f this read
        // went through `deps.store.storageClient.listNodes(...)` which
        // is boot-bound — so a request "for" workspace B could surface
        // candidates from whichever graph happened to be active.
        //
        // P1 scale fix — page the walk (keyset) instead of materializing the
        // WHOLE node table (full content) up front, keeping only the current
        // (non-superseded, matching-type) candidates. Peak heap is one page +
        // the retained candidate set (which the pairing logic needs anyway).
        // We project the exact fields the pairing logic reads INCLUDING
        // supersededAt (the fixed bulk-list projection omits it, which would
        // silently let superseded nodes through) and type (filtered in JS to
        // avoid a second OR-chain). Falls back to the unbounded listNodes scan
        // when the resolved graph lacks getGraphContext (e.g. cloud/fake).
        const project = projectFilter ?? '*';
        const isCandidate = (n: { type: string; supersededAt?: string | null }): boolean =>
            allowedTypes.has(n.type) && !n.supersededAt;
        /**
         * Ecosystem confinement on the PAIR (added with the /api/search +
         * /api/query scoping).
         *
         * This route was project-filtered only, so on a workspace that serves
         * several isolated tenants by ecosystem it proposed "did you mean to
         * supersede X with Y?" cards ACROSS the boundary — a durable,
         * operator-facing suggestion built from one tenant's content next to
         * another's, and the card carries 240 chars of both nodes' content.
         *
         * Decided on the two nodes' OWN ecosystems rather than a request scope,
         * because both endpoints are already hydrated here and their graph rows
         * are authoritative. `'*'`/unset is a WILDCARD, matching the documented
         * decision on engines/reconnect.ts `ecosystemConfinement`: it is the
         * `LoreNode.ecosystem` schema default, so confining it would switch
         * this route off for every install that never sets an ecosystem. Only a
         * pair naming two DIFFERENT concrete ecosystems is refused.
         */
        const crossEcosystemPair = (a: { ecosystem?: string }, b: { ecosystem?: string }): boolean =>
            isCrossEcosystemPair(a.ecosystem, b.ecosystem);
        const candidates: Array<import('../../../../providers/types.js').LoreNode> = [];
        const pager = (readGraph as { bulkListProjected?: NodePager }).bulkListProjected?.bind(readGraph);
        if (pager) {
            await forEachNodePage(
                pager,
                project,
                // `ecosystem` is projected so the pair check below has the
                // authoritative graph value; without it every candidate read as
                // undefined and the confinement was silently a no-op.
                ['type', 'label', 'content', 'createdAt', 'project', 'ecosystem', 'supersededAt'],
                (rows) => {
                    for (const r of rows) {
                        const type = (r['type'] as string) ?? '';
                        // rowToLoreNode maps '' supersededAt → null; raw '' is
                        // falsy too, so the !supersededAt gate is preserved.
                        const supersededAt = (r['supersededAt'] as string) || null;
                        if (!allowedTypes.has(type) || supersededAt) continue;
                        candidates.push({
                            id: String(r['id'] ?? ''),
                            type,
                            label: (r['label'] as string) ?? '',
                            content: (r['content'] as string) ?? '',
                            createdAt: (r['createdAt'] as string) ?? '',
                            project: (r['project'] as string) ?? '*',
                            ecosystem: (r['ecosystem'] as string) ?? '*',
                            supersededAt,
                        } as import('../../../../providers/types.js').LoreNode);
                    }
                },
            );
        } else {
            const allNodes = await readGraph.listNodes(undefined, undefined, project, '*', undefined, { unbounded: true });
            for (const n of allNodes) if (isCandidate(n)) candidates.push(n);
        }

        type Pair = {
            oldId: string;
            oldLabel: string;
            oldContent: string;
            oldCreatedAt: string;
            newId: string;
            newLabel: string;
            newContent: string;
            newCreatedAt: string;
            score: number;
            project: string;
        };
        const pairs: Pair[] = [];
        const seenPairs = new Set<string>();
        const candidateById = new Map(candidates.map((c) => [c.id, c]));

        // Parallel batched search: 8 in flight at a time bounds memory for
        // the embedder while still ~5x faster than sequential. Hard cap on
        // candidates (200) keeps unscoped scans bounded.
        const SCAN_CAP = 200;
        const BATCH_SIZE = 8;
        // No per-workspace verbatim store (non-active ws with no resolver, or
        // getOrOpen failed) — skip the vector scan entirely rather than seeding
        // from the boot/active store. No candidate pairs is the safe degrade.
        const toScan = verbatimSearch ? candidates.slice(0, SCAN_CAP) : [];
        for (let i = 0; i < toScan.length; i += BATCH_SIZE) {
            const batch = toScan.slice(i, i + BATCH_SIZE);
            // Embed query = label only (much shorter than full content;
            // gives near-identical similarity signal for
            // decision/architecture nodes which are primarily named by
            // their label).
            const batchResults = await Promise.all(batch.map(async (n) => {
                const q = (n.label ?? '').trim() || (n.content ?? '').slice(0, 200);
                if (!q) return { node: n, hits: [] as Array<{ id: string; score: number }> };
                try {
                    const hits = await verbatimSearch!(q, 5);
                    return { node: n, hits };
                } catch {
                    return { node: n, hits: [] as Array<{ id: string; score: number }> };
                }
            }));
            for (const { node: n, hits } of batchResults) {
                for (const hit of hits) {
                    const stripped = hit.id.startsWith('lore:') ? hit.id.slice(5) : hit.id;
                    if (stripped === n.id) continue;
                    if (hit.score < minScore) continue;
                    const key = stripped < n.id ? `${stripped}||${n.id}` : `${n.id}||${stripped}`;
                    if (seenPairs.has(key)) continue;
                    const partner = candidateById.get(stripped);
                    if (!partner) continue;
                    if (crossEcosystemPair(n, partner)) continue;
                    const aDate = n.createdAt || '';
                    const bDate = partner.createdAt || '';
                    const isANewer = aDate > bDate;
                    const newer = isANewer ? n : partner;
                    const older = isANewer ? partner : n;
                    pairs.push({
                        oldId: older.id,
                        oldLabel: older.label,
                        oldContent: (older.content ?? '').slice(0, 240),
                        oldCreatedAt: older.createdAt ?? '',
                        newId: newer.id,
                        newLabel: newer.label,
                        newContent: (newer.content ?? '').slice(0, 240),
                        newCreatedAt: newer.createdAt ?? '',
                        score: hit.score,
                        project: n.project ?? '*',
                    });
                    seenPairs.add(key);
                }
            }
        }

        // Sort highest confidence first.
        pairs.sort((a, b) => b.score - a.score);
        const payload = {
            scope: { project: projectFilter ?? null, minScore, types: Array.from(allowedTypes) },
            candidatesScanned: candidates.length,
            pairs,
        };
        supersessionCandidatesCache.set(cacheKey, { payload, savedAt: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    } catch (cErr) {
        writeError(res, 500, 'internal_error', redactError(cErr));
    }
}

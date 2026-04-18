/**
 * reconnect.ts — V2.1 Graph reconnection engine.
 *
 * Problem being solved:
 *   The dev lore has 63 LoreNodes but only 26 edges; 47 nodes (~75%) are
 *   orphaned because store_node calls never drew links between
 *   semantically related items. This module fixes that retroactively and
 *   keeps the graph connected as new nodes arrive (ingest hook).
 *
 * Algorithm:
 *   1. Ensure every LoreNode has an embedding in VerbatimStore. Nodes
 *      without one are embedded now.
 *   2. For each node, run verbatim.search(node.text, K+1). The first hit
 *      is usually the node itself (skipped); remaining hits with score ≥
 *      `minSim` become candidate neighbors.
 *   3. Canonicalize pairs as (min(id), max(id)) so A↔B is one edge, not
 *      two. This dedupes across both directions of the symmetric
 *      similarity relation.
 *   4. On apply:
 *        (a) Delete all LoreEdge rows where relation starts with
 *            'semantic_neighbor' — only removes inferred edges; keeps
 *            human-asserted ones like 'supersedes'/'refers_to'.
 *        (b) Insert the new plan. Confidence is encoded in the relation
 *            string as 'semantic_neighbor:0.84' so it survives without a
 *            schema migration.
 *
 * Idempotency: yes, prune-and-replace. Running twice in a row is a no-op.
 *
 * Not yet in scope (V2.1):
 *   - Embedding CodeFile / CodeSymbol content. For the MVP we only
 *     reconnect LoreNode ↔ LoreNode because those are the currently-
 *     embedded items. Cross-pillar semantic edges land in a follow-up
 *     once VerbatimStore is extended.
 */

import type { LocalGraph, LoreNode } from './localGraph.js';
import type { VerbatimStore } from './verbatimStore.js';
import { buildVerbatimText } from './verbatimStore.js';

const SEMANTIC_PREFIX = 'semantic_neighbor';

export interface ReconnectOptions {
    k?: number;
    minSim?: number;
    dryRun?: boolean;
    pruneInferred?: boolean;
}

export interface ReconnectProposal {
    from: string;
    to: string;
    confidence: number;
}

export interface ReconnectResult {
    candidatesScanned: number;
    embeddingsAdded: number;
    proposedEdges: ReconnectProposal[];
    applied: boolean;
    inferredPruned: number;
    edgesInserted: number;
    distribution: Record<string, number>;
}

/**
 * reconnectGraph — Run the full reconnection pass against a graph + vector store.
 *
 * Dry-run by default: returns the plan without mutating the graph.
 * Pass `dryRun: false` to apply.
 */
export async function reconnectGraph(
    graph: LocalGraph,
    verbatim: VerbatimStore,
    opts: ReconnectOptions = {},
): Promise<ReconnectResult> {
    const k = opts.k ?? 5;
    const minSim = opts.minSim ?? 0.65;
    const dryRun = opts.dryRun ?? true;
    const pruneInferred = opts.pruneInferred ?? true;

    await verbatim.initialize();

    // 1. Fetch every LoreNode so we can make sure they are all embedded.
    const allNodes: LoreNode[] = await graph.listNodes();

    // 2. Embed missing. Cheap guard: count() then only store ones not present.
    //    VerbatimStore.search supports ID lookup via filter, but easier to just
    //    re-embed everything — LanceDB deduplicates on id in practice (the
    //    .add call will create duplicates in ours though, so we delete first).
    let embeddingsAdded = 0;
    for (const node of allNodes) {
        const text = buildVerbatimText(node.label ?? '', node.content ?? '', node.tags ?? '');
        if (!text.trim()) continue;
        // Upsert: delete any prior row for this id, then store fresh.
        try { await verbatim.delete(node.id); } catch { /* ignore */ }
        await verbatim.store({
            id: node.id,
            text,
            metadata: {
                type: node.type ?? '',
                label: node.label ?? '',
                tags: node.tags ?? '',
                project: node.project ?? '',
                ecosystem: node.ecosystem ?? '',
                updatedAt: node.updatedAt ?? '',
                security_scopes: node.security_scopes ?? [],
            },
        });
        embeddingsAdded++;
    }

    // 3. For each node, find top-K semantically nearest and emit candidate pairs.
    const seenPair = new Set<string>();
    const proposedEdges: ReconnectProposal[] = [];
    const dist: Record<string, number> = {};

    for (const node of allNodes) {
        const text = buildVerbatimText(node.label ?? '', node.content ?? '', node.tags ?? '');
        if (!text.trim()) continue;
        const hits = await verbatim.search(text, k + 1);
        for (const hit of hits) {
            if (hit.id === node.id) continue;
            const sim = hit.score ?? 0;
            // histogram bucket (0.5..1.0 in 0.05 steps)
            const bucket = `${Math.floor(sim * 20) / 20}`;
            dist[bucket] = (dist[bucket] ?? 0) + 1;
            if (sim < minSim) continue;
            const [lo, hi] = node.id < hit.id ? [node.id, hit.id] : [hit.id, node.id];
            const pairKey = `${lo}::${hi}`;
            if (seenPair.has(pairKey)) continue;
            seenPair.add(pairKey);
            proposedEdges.push({ from: lo, to: hi, confidence: Number(sim.toFixed(3)) });
        }
    }

    if (dryRun) {
        return {
            candidatesScanned: allNodes.length,
            embeddingsAdded,
            proposedEdges,
            applied: false,
            inferredPruned: 0,
            edgesInserted: 0,
            distribution: dist,
        };
    }

    // 4. Apply: prune old inferred edges, then insert new ones.
    let inferredPruned = 0;
    if (pruneInferred) {
        inferredPruned = await graph.pruneInferredLoreEdges(SEMANTIC_PREFIX);
    }
    let edgesInserted = 0;
    for (const edge of proposedEdges) {
        await graph.addEdge({
            sourceId: edge.from,
            targetId: edge.to,
            relation: `${SEMANTIC_PREFIX}:${edge.confidence.toFixed(3)}`,
        });
        edgesInserted++;
    }

    return {
        candidatesScanned: allNodes.length,
        embeddingsAdded,
        proposedEdges,
        applied: true,
        inferredPruned,
        edgesInserted,
        distribution: dist,
    };
}

/**
 * reconnectOneNode — Ingest-time hook (Option A). When a new LoreNode is
 * inserted via store_node or file ingestion, we immediately embed it and
 * draw edges to its top-K nearest neighbors. This keeps the graph fresh
 * without a user having to manually hit "Recompute".
 *
 * The hook is a subset of reconnectGraph's pass, scoped to a single node.
 * It never prunes; the full pass is the only place that rewrites history.
 */
export async function reconnectOneNode(
    graph: LocalGraph,
    verbatim: VerbatimStore,
    node: Pick<LoreNode, 'id' | 'label' | 'content' | 'tags' | 'type' | 'project' | 'ecosystem'>,
    opts: { k?: number; minSim?: number } = {},
): Promise<{ added: number; confidences: number[] }> {
    const k = opts.k ?? 5;
    const minSim = opts.minSim ?? 0.65;
    await verbatim.initialize();

    const text = buildVerbatimText(node.label ?? '', node.content ?? '', node.tags ?? '');
    if (!text.trim()) return { added: 0, confidences: [] };

    try { await verbatim.delete(node.id); } catch { /* ignore */ }
    await verbatim.store({
        id: node.id,
        text,
        metadata: {
            type: node.type ?? '',
            label: node.label ?? '',
            tags: node.tags ?? '',
            project: node.project ?? '',
            ecosystem: node.ecosystem ?? '',
            updatedAt: new Date().toISOString(),
            security_scopes: [],
        },
    });

    const hits = await verbatim.search(text, k + 1);
    const confidences: number[] = [];
    let added = 0;
    for (const hit of hits) {
        if (hit.id === node.id) continue;
        const sim = hit.score ?? 0;
        if (sim < minSim) continue;
        const [lo, hi] = node.id < hit.id ? [node.id, hit.id] : [hit.id, node.id];
        await graph.addEdge({
            sourceId: lo,
            targetId: hi,
            relation: `${SEMANTIC_PREFIX}:${sim.toFixed(3)}`,
        });
        confidences.push(sim);
        added++;
    }
    return { added, confidences };
}

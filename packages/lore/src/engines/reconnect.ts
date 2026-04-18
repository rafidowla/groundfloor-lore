/**
 * reconnect.ts — V2.1 Graph reconnection engine (core algorithm).
 *
 * Core algorithm knows only about LoreNode (the generic memory primitive).
 * Plugins contribute additional embeddable nodes and route their cross-
 * pillar edges via the ILorePlugin.contributeReconnectNodes +
 * routeReconnectEdge hooks. That means this file has ZERO knowledge of
 * CodeFile, CodeSymbol, GitNexus, or any other plugin-specific concept.
 *
 * Algorithm (unchanged in shape, only in participants):
 *   1. Ensure every LoreNode has an embedding in VerbatimStore.
 *   2. For each active plugin, append its contributed EmbeddableNodes
 *      (with their own prefixed ids) to the vector space.
 *   3. For each LoreNode, stratified top-K search. Canonicalize pairs.
 *   4. Lore ↔ lore edges go directly into LoreEdge (core owns that
 *      rel table). Any edge where one side is non-lore is offered to
 *      each active plugin's routeReconnectEdge until one claims it.
 *   5. On apply: core prunes LoreEdge, then each plugin prunes its own
 *      inferred edges, then we insert the fresh batch.
 */

import type { LocalGraph, LoreNode } from './localGraph.js';
import type { VerbatimStore } from './verbatimStore.js';
import { buildVerbatimText } from './verbatimStore.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { EmbeddableNode, PluginGraphContext } from '../plugins/types.js';

const SEMANTIC_PREFIX = 'semantic_neighbor';
const PREFIX_LORE = 'lore:';

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
    /** Edges the core inserted into LoreEdge. */
    coreEdgesInserted: number;
    /** Edges routed by plugins (cross-pillar). */
    pluginEdgesRouted: number;
    /** Edges proposed but no plugin claimed (leaves them unrouted). */
    unroutedEdges: number;
    /** Per-plugin pruned counts (plus core LoreEdge prune). */
    prunedByOwner: Record<string, number>;
    distribution: Record<string, number>;
}

function classifyPrefix(id: string): 'lore' | 'other' {
    return id.startsWith(PREFIX_LORE) ? 'lore' : 'other';
}

function strip(prefixedId: string): string {
    const i = prefixedId.indexOf(':');
    return i < 0 ? prefixedId : prefixedId.slice(i + 1);
}

/**
 * reconnectGraph — Run the reconnection pass end-to-end. Plugins are
 * queried for their contributed nodes and offered cross-pillar edges.
 */
export async function reconnectGraph(
    graph: LocalGraph,
    verbatim: VerbatimStore,
    pluginRegistry: PluginRegistry,
    opts: ReconnectOptions = {},
): Promise<ReconnectResult> {
    const k = opts.k ?? 5;
    const minSim = opts.minSim ?? 0.65;
    const dryRun = opts.dryRun ?? true;
    const pruneInferred = opts.pruneInferred ?? true;

    await verbatim.initialize();
    const pluginCtx: PluginGraphContext = graph.createPluginGraphContext();

    // 1. Embed every LoreNode with the canonical lore: prefix.
    const loreNodes: LoreNode[] = await graph.listNodes();
    let embeddingsAdded = 0;
    for (const n of loreNodes) {
        const text = buildVerbatimText(n.label ?? '', n.content ?? '', n.tags ?? '');
        if (!text.trim()) continue;
        const prefixedId = PREFIX_LORE + n.id;
        try { await verbatim.delete(prefixedId); } catch { /* ignore */ }
        await verbatim.store({
            id: prefixedId,
            text,
            metadata: {
                type: n.type ?? 'lore',
                label: n.label ?? '',
                tags: n.tags ?? '',
                project: n.project ?? '',
                ecosystem: n.ecosystem ?? '',
                updatedAt: n.updatedAt ?? '',
                security_scopes: n.security_scopes ?? [],
            },
        });
        embeddingsAdded++;
    }

    // 2. Ask each active plugin for its embeddable contributions.
    let pluginNodes: EmbeddableNode[] = [];
    for (const plugin of pluginRegistry.active()) {
        if (typeof plugin.contributeReconnectNodes !== 'function') continue;
        try {
            const contributions = await plugin.contributeReconnectNodes(pluginCtx);
            pluginNodes = pluginNodes.concat(contributions);
        } catch (err) {
            console.error(`[reconnect] plugin "${plugin.name}" contribute failed:`, (err as Error).message);
        }
    }
    for (const ebn of pluginNodes) {
        try { await verbatim.delete(ebn.id); } catch { /* ignore */ }
        await verbatim.store({ id: ebn.id, text: ebn.text, metadata: ebn.metadata });
        embeddingsAdded++;
    }

    const totalNodes = loreNodes.length + pluginNodes.length;

    // 3. Stratified top-K: for each LoreNode, pull k*8 hits and allow at
    //    most ceil(k/2) from each "pillar" (lore vs non-lore). Prevents
    //    highly-similar sibling LoreNodes from crowding out cross-pillar.
    const WIDE_FACTOR = 8;
    const perKindK = Math.max(2, Math.ceil(k / 2));
    const seenPair = new Set<string>();
    const proposedEdges: ReconnectProposal[] = [];
    const dist: Record<string, number> = {};

    for (const n of loreNodes) {
        const text = buildVerbatimText(n.label ?? '', n.content ?? '', n.tags ?? '');
        if (!text.trim()) continue;
        const hits = await verbatim.search(text, k * WIDE_FACTOR);
        const fromId = PREFIX_LORE + n.id;

        const buckets: Record<'lore' | 'other', typeof hits> = { lore: [], other: [] };
        for (const hit of hits) {
            if (hit.id === fromId) continue;
            const pillar = classifyPrefix(hit.id);
            const sim = hit.score ?? 0;
            const bucket = `${Math.floor(sim * 20) / 20}`;
            dist[bucket] = (dist[bucket] ?? 0) + 1;
            if (sim < minSim) continue;
            if (buckets[pillar].length < perKindK) buckets[pillar].push(hit);
        }

        for (const bucketName of ['lore', 'other'] as const) {
            for (const hit of buckets[bucketName]) {
                const sim = hit.score ?? 0;
                const [lo, hi] = fromId < hit.id ? [fromId, hit.id] : [hit.id, fromId];
                const pairKey = `${lo}::${hi}`;
                if (seenPair.has(pairKey)) continue;
                seenPair.add(pairKey);
                proposedEdges.push({ from: fromId, to: hit.id, confidence: Number(sim.toFixed(3)) });
            }
        }
    }

    if (dryRun) {
        return {
            candidatesScanned: totalNodes,
            embeddingsAdded,
            proposedEdges,
            applied: false,
            coreEdgesInserted: 0,
            pluginEdgesRouted: 0,
            unroutedEdges: 0,
            prunedByOwner: {},
            distribution: dist,
        };
    }

    // 4. Prune inferred edges. Core wipes LoreEdge with the semantic
    //    prefix; each plugin wipes its own rel tables.
    const prunedByOwner: Record<string, number> = {};
    if (pruneInferred) {
        prunedByOwner.core = await graph.pruneInferredLoreEdges(SEMANTIC_PREFIX);
        for (const plugin of pluginRegistry.active()) {
            if (typeof plugin.pruneInferredEdges !== 'function') continue;
            try {
                prunedByOwner[plugin.name] = await plugin.pruneInferredEdges(SEMANTIC_PREFIX, pluginCtx);
            } catch (err) {
                console.error(`[reconnect] plugin "${plugin.name}" prune failed:`, (err as Error).message);
                prunedByOwner[plugin.name] = 0;
            }
        }
    }

    // 5. Insert edges. Pure lore↔lore goes into LoreEdge directly; any
    //    edge with a non-lore participant is offered to plugins in
    //    registration order until one claims it.
    let coreEdgesInserted = 0;
    let pluginEdgesRouted = 0;
    let unroutedEdges = 0;

    for (const edge of proposedEdges) {
        const relation = `${SEMANTIC_PREFIX}:${edge.confidence.toFixed(3)}`;
        const fromPillar = classifyPrefix(edge.from);
        const toPillar = classifyPrefix(edge.to);

        if (fromPillar === 'lore' && toPillar === 'lore') {
            try {
                await graph.addEdge({
                    sourceId: strip(edge.from < edge.to ? edge.from : edge.to),
                    targetId: strip(edge.from < edge.to ? edge.to : edge.from),
                    relation,
                });
                coreEdgesInserted++;
            } catch (err) {
                console.error(`[reconnect] core addEdge failed: ${(err as Error).message}`);
            }
            continue;
        }

        // Cross-pillar — hand off to plugins.
        let claimed = false;
        for (const plugin of pluginRegistry.active()) {
            if (typeof plugin.routeReconnectEdge !== 'function') continue;
            try {
                const handled = await plugin.routeReconnectEdge(
                    { from: edge.from, to: edge.to, confidence: edge.confidence, relation },
                    pluginCtx,
                );
                if (handled) { claimed = true; pluginEdgesRouted++; break; }
            } catch (err) {
                console.error(`[reconnect] plugin "${plugin.name}" route failed:`, (err as Error).message);
            }
        }
        if (!claimed) unroutedEdges++;
    }

    return {
        candidatesScanned: totalNodes,
        embeddingsAdded,
        proposedEdges,
        applied: true,
        coreEdgesInserted,
        pluginEdgesRouted,
        unroutedEdges,
        prunedByOwner,
        distribution: dist,
    };
}

/**
 * reconnectOneNode — Ingest-time hook (Option A). Embeds a new LoreNode
 * and draws semantic edges to its top-K nearest neighbors. Cross-pillar
 * edges go through the plugin routing path; pure lore↔lore goes direct.
 */
export async function reconnectOneNode(
    graph: LocalGraph,
    verbatim: VerbatimStore,
    pluginRegistry: PluginRegistry,
    node: Pick<LoreNode, 'id' | 'label' | 'content' | 'tags' | 'type' | 'project' | 'ecosystem'>,
    opts: { k?: number; minSim?: number } = {},
): Promise<{ added: number; confidences: number[] }> {
    const k = opts.k ?? 5;
    const minSim = opts.minSim ?? 0.65;
    await verbatim.initialize();

    const text = buildVerbatimText(node.label ?? '', node.content ?? '', node.tags ?? '');
    if (!text.trim()) return { added: 0, confidences: [] };

    const prefixedId = PREFIX_LORE + node.id;
    try { await verbatim.delete(prefixedId); } catch { /* ignore */ }
    await verbatim.store({
        id: prefixedId,
        text,
        metadata: {
            type: node.type ?? 'lore',
            label: node.label ?? '',
            tags: node.tags ?? '',
            project: node.project ?? '',
            ecosystem: node.ecosystem ?? '',
            updatedAt: new Date().toISOString(),
            security_scopes: [],
        },
    });

    const pluginCtx: PluginGraphContext = graph.createPluginGraphContext();
    const hits = await verbatim.search(text, k + 1);
    const confidences: number[] = [];
    let added = 0;
    for (const hit of hits) {
        if (hit.id === prefixedId) continue;
        const sim = hit.score ?? 0;
        if (sim < minSim) continue;
        const relation = `${SEMANTIC_PREFIX}:${sim.toFixed(3)}`;

        if (classifyPrefix(hit.id) === 'lore') {
            const [lo, hi] = node.id < strip(hit.id) ? [node.id, strip(hit.id)] : [strip(hit.id), node.id];
            try {
                await graph.addEdge({ sourceId: lo, targetId: hi, relation });
                confidences.push(sim);
                added++;
            } catch { /* skip dead edges */ }
            continue;
        }

        // Offer to plugins.
        for (const plugin of pluginRegistry.active()) {
            if (typeof plugin.routeReconnectEdge !== 'function') continue;
            try {
                const handled = await plugin.routeReconnectEdge(
                    { from: prefixedId, to: hit.id, confidence: sim, relation },
                    pluginCtx,
                );
                if (handled) { confidences.push(sim); added++; break; }
            } catch { /* skip */ }
        }
    }
    return { added, confidences };
}

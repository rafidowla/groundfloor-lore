/**
 * deferred.ts — Q1.7 "Deferred Lore surfacing."
 *
 * Captures the pattern we've been hand-rolling in commits: when work
 * is deliberately deferred (e.g. "plugin-recalibrate-hook will land in
 * Q1.8"), we store a LoreNode whose id is `deferred-<slug>` with tags
 * and metadata describing the trigger conditions. The intent is that
 * when the triggering condition shows up in a future session (editing
 * a file listed in the deferred node, or recalling a topic that
 * overlaps its tags), the deferred work re-surfaces automatically so
 * it isn't forgotten.
 *
 * This module centralises that surfacing logic so both `recall()` and
 * the Claude Code PostToolUse hook call the same code path.
 *
 * Matching rules
 *   1. id starts with `deferred-`
 *   2. not already resolved — metadata JSON lacks a `resolved_at` key
 *      (or the key is the empty string)
 *   3. at least one of:
 *      - a `filePaths` caller signal overlaps a file path in the
 *        node's tags or metadata.filePaths
 *      - the topic substring-matches the node's label, content, or
 *        tags (case-insensitive)
 *
 * Response shape (new `deferred` sidecar field on recall()):
 *   { id, label, tags, filePaths, ageDays, reason: "file-match"|"topic-match" }
 *
 * Resolution stamp (resolve_deferred tool):
 *   Sets metadata.resolved_at = <ISO timestamp> and optionally
 *   metadata.resolved_by_commit = <commit SHA>. Once stamped, the node
 *   stops appearing in surfacing results.
 */

import type { GraphProvider, LoreNode } from '../providers/types.js';

export interface DeferredSignal {
    /** Topic the caller is searching on. Optional — pass '' to skip
     *  topic matching and rely solely on filePaths. */
    topic?: string;
    /** File paths from the current work context (e.g. PostToolUse edit
     *  events). Matched against the deferred node's tags + metadata. */
    filePaths?: string[];
}

export interface DeferredMatch {
    id: string;
    label: string;
    tags: string;
    filePaths: string[];
    ageDays: number;
    reason: 'file-match' | 'topic-match';
    content: string;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function isResolved(node: LoreNode): boolean {
    const meta = parseMetadata(node.metadata);
    const stamp = meta['resolved_at'];
    return typeof stamp === 'string' && stamp.length > 0;
}

/** Pull file paths out of a node — both from tags (comma-separated
 *  `file:src/foo.ts` entries) and from metadata.filePaths (a clean
 *  list when the node was stored explicitly). */
function extractFilePaths(node: LoreNode): string[] {
    const out = new Set<string>();
    const meta = parseMetadata(node.metadata);
    const metaList = meta['filePaths'];
    if (Array.isArray(metaList)) {
        for (const item of metaList) {
            if (typeof item === 'string' && item) out.add(item);
        }
    }
    // Allow `file:src/foo.ts` style tags so authors don't need the
    // metadata dance for simple cases.
    const tags = (node.tags ?? '').split(',').map((t) => t.trim());
    for (const t of tags) {
        if (t.startsWith('file:')) out.add(t.slice('file:'.length));
    }
    return Array.from(out);
}

function ageDays(node: LoreNode): number {
    const created = node.createdAt ? Date.parse(node.createdAt) : NaN;
    if (!Number.isFinite(created)) return 0;
    return Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24));
}

/**
 * findDeferredMatches — scan all deferred-* nodes and return the ones
 * that match the given signal. Returns [] when there are no matches.
 *
 * Complexity: O(N_deferred) where N is the count of unresolved
 * deferred nodes. For realistic workloads (< 50) this is negligible;
 * the cache tier absorbs the listNodes() call anyway.
 */
export async function findDeferredMatches(
    graph: GraphProvider,
    signal: DeferredSignal,
): Promise<DeferredMatch[]> {
    // `deferred-*` as a naming convention — listNodes can't prefix-match
    // ids, so we widen to all notes + plain filter. This is what the
    // cache tier is for: repeated scans collapse to one DB hit.
    // Note: deferred nodes are stored as type='note' or type='decision'
    // by convention; we filter by id prefix rather than type so
    // anything with the pattern is picked up.
    const all = await graph.listNodes();
    const deferred = all.filter((n) => n.id.startsWith('deferred-') && !isResolved(n));
    if (deferred.length === 0) return [];

    const topic = (signal.topic ?? '').trim().toLowerCase();
    const filePaths = (signal.filePaths ?? []).filter((p) => typeof p === 'string' && p.length > 0);

    const matches: DeferredMatch[] = [];
    for (const node of deferred) {
        const nodePaths = extractFilePaths(node);

        // File-path match wins over topic match because it's a
        // stronger signal (the user is literally editing the file).
        const fileHit = filePaths.some((p) => nodePaths.some((np) => np === p || p.endsWith(np) || np.endsWith(p)));

        let topicHit = false;
        if (!fileHit && topic) {
            const hay = [node.label, node.content, node.tags].filter(Boolean).join(' ').toLowerCase();
            topicHit = hay.includes(topic);
        }

        if (!fileHit && !topicHit) continue;

        matches.push({
            id: node.id,
            label: node.label,
            tags: node.tags ?? '',
            filePaths: nodePaths,
            ageDays: ageDays(node),
            reason: fileHit ? 'file-match' : 'topic-match',
            content: node.content ?? '',
        });
    }

    // Oldest first — the bigger the backlog, the more it nags.
    matches.sort((a, b) => b.ageDays - a.ageDays);
    return matches;
}

/**
 * stampResolved — Mark a deferred node as resolved. Called by the
 * `resolve_deferred` MCP tool. The Lore node stays in the graph
 * (so the historical context is preserved); only its metadata gains
 * the resolution timestamp.
 *
 * Returns the new metadata object (parsed) so the caller can echo
 * it back to the user.
 */
export async function stampResolved(
    graph: GraphProvider,
    nodeId: string,
    resolvedByCommit?: string,
): Promise<{ node: LoreNode; metadata: Record<string, unknown> } | null> {
    const node = await graph.getNode(nodeId);
    if (!node) return null;
    if (!node.id.startsWith('deferred-')) {
        throw new Error(`Node '${nodeId}' is not a deferred-* node (id must start with 'deferred-').`);
    }
    const meta = parseMetadata(node.metadata);
    meta['resolved_at'] = new Date().toISOString();
    if (resolvedByCommit && typeof resolvedByCommit === 'string') {
        meta['resolved_by_commit'] = resolvedByCommit;
    }
    const updated = await graph.upsertNode({
        id: node.id,
        type: node.type,
        label: node.label,
        content: node.content,
        tags: node.tags,
        project: node.project,
        ecosystem: node.ecosystem,
        metadata: JSON.stringify(meta),
        security_scopes: node.security_scopes ?? [],
        language: node.language,
    });
    return { node: updated, metadata: meta };
}

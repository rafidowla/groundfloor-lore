/**
 * deferred.ts — Q1.7 "Deferred Lore surfacing."
 *
 * Captures the pattern we've been hand-rolling in commits: when work
 * is deliberately deferred (e.g. "reconnect-hook will land in
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
import { tagsToString, tagsToArray } from './normalizeTags.js';
import { forEachNodePage, type NodePager } from './nodePager.js';

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

/**
 * Graph surface findDeferredMatches reads: any GraphProvider, plus the
 * optional engine-agnostic keyset pager (both real engines — LocalGraph and
 * SurrealGraph — implement `bulkListProjected`; fakes/cloud handles omit it
 * and take the unbounded listNodes fallback). Optional member, so every
 * GraphProvider already satisfies this without a cast at call sites.
 */
export interface DeferredGraph extends GraphProvider {
    bulkListProjected?: NodePager;
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

/** Pull file paths out of a node. Three sources, all optional:
 *    - metadata.trigger_paths (canonical — see docs/deferred-node-schema.md)
 *    - metadata.filePaths (legacy alias kept for back-compat with the
 *      first Q1.7 pass that shipped before the schema doc landed)
 *    - `file:<path>` entries in tags (sugar for simple cases)
 *  Any source can supply the list; the union is what we match on. */
function extractFilePaths(node: LoreNode): string[] {
    const out = new Set<string>();
    const meta = parseMetadata(node.metadata);
    for (const key of ['trigger_paths', 'filePaths']) {
        const list = meta[key];
        if (Array.isArray(list)) {
            for (const item of list) {
                if (typeof item === 'string' && item) out.add(item);
            }
        }
    }
    // Allow `file:src/foo.ts` style tags so authors don't need the
    // metadata dance for simple cases. node.tags is a string[] post-Pass-3,
    // but tolerate a comma-string from non-normalized sources (sync payloads,
    // in-memory fakes). Do NOT lowercase here — `file:` paths are
    // case-sensitive (Pass 3's lowercase-on-store is a separate concern for
    // structured path tags; see DECISIONS.md DEC-TAG-MATCH).
    const tags: string[] = Array.isArray(node.tags)
        ? node.tags
        : String(node.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    for (const t of tags) {
        if (t.startsWith('file:')) out.add(t.slice('file:'.length));
    }
    return Array.from(out);
}

/** Pull trigger_tags out of metadata. These are conceptual keywords
 *  (not paths) that the author wants the surfacing layer to match on
 *  alongside the free-text label/content/tags substring search. */
function extractTriggerTags(node: LoreNode): string[] {
    const meta = parseMetadata(node.metadata);
    const list = meta['trigger_tags'];
    if (!Array.isArray(list)) return [];
    return list.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

function ageDays(node: LoreNode): number {
    const created = node.createdAt ? Date.parse(node.createdAt) : NaN;
    if (!Number.isFinite(created)) return 0;
    return Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24));
}

/**
 * hc-deferred-scan-cache-ttl-hardcoded — env override: LORE_DEFERRED_SCAN_CACHE_TTL_MS.
 * Default matches SurrealGraph.readCache's default TTL (engines/surrealGraph.ts)
 * so this cache's staleness window is consistent with the rest of the local
 * read-cache tier.
 */
const DEFERRED_SCAN_CACHE_TTL_MS: number = (() => {
    const raw = process.env['LORE_DEFERRED_SCAN_CACHE_TTL_MS'];
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
})();

/**
 * Per-graph-handle cache of the raw (unresolved, deferred-*-prefixed) node
 * scan — findDeferredMatches's OWN docstring always assumed "the cache tier
 * absorbs the listNodes() call anyway", which was true incidentally while the
 * fallback path went through SurrealGraph's readCache-backed listNodes(). The
 * P1 scale fix moved the fast path onto bulkListProjected, an uncached paged
 * walk, so every recall call re-scanned the entire corpus with no memoing —
 * confirmed by direct instrumentation to cost ~1.6s of a ~1.7s recall at
 * 10k nodes (Kùzu-removal branch verification, 2026-08-21). Keyed on the
 * graph object itself (WeakMap — no leak, no cross-workspace bleed, and it
 * clears itself if a workspace handle is ever evicted) rather than plumbing
 * this engine-agnostic module through any one engine's epoch/readCache.
 */
const scanCache = new WeakMap<DeferredGraph, { expiresAt: number; deferred: LoreNode[] }>();

async function scanDeferredNodes(graph: DeferredGraph): Promise<LoreNode[]> {
    const cached = scanCache.get(graph);
    if (cached && cached.expiresAt > Date.now()) return cached.deferred;

    // `deferred-*` as a naming convention — listNodes can't prefix-match
    // ids, so we widen to all notes + plain filter. Cached above so repeated
    // recalls collapse to one scan per TTL window instead of one per call.
    // Note: deferred nodes are stored as type='note' or type='decision'
    // by convention; we filter by id prefix rather than type so
    // anything with the pattern is picked up.
    //
    // P1 scale fix — page the walk projecting only the fields the deferred
    // match needs (id/label/content/tags/metadata/createdAt), keeping only the
    // tiny `deferred-*` unresolved set. Peak heap is one page; the retained set
    // stays small (the docstring's O(N_deferred) assumption). Falls back to the
    // unbounded listNodes scan when the graph doesn't expose bulkListProjected.
    const deferred: LoreNode[] = [];
    // The paged walk goes through bulkListProjected — the engine-agnostic
    // keyset pager both LocalGraph and SurrealGraph implement. It used to be
    // raw Cypher over getGraphContext().queryRows, which made the fast path
    // Kùzu-only: a Surreal-backed workspace silently took the unbounded scan.
    // Failing soft here (not throwing) keeps recall's deferred sidecar a
    // best-effort enrichment across backends rather than a hard recall failure.
    let pagedOk = false;
    const pager = graph.bulkListProjected?.bind(graph);
    if (pager) {
        try {
            await forEachNodePage(
                pager,
                '*',
                ['label', 'content', 'tags', 'metadata', 'createdAt'],
                (rows) => {
                    for (const r of rows) {
                        const id = String(r['id'] ?? '');
                        if (!id.startsWith('deferred-')) continue;
                        const node = {
                            id,
                            label: (r['label'] as string) ?? '',
                            content: (r['content'] as string) ?? '',
                            tags: tagsToArray(r['tags']),
                            metadata: (r['metadata'] as string) ?? '{}',
                            createdAt: (r['createdAt'] as string) ?? '',
                        } as LoreNode;
                        if (!isResolved(node)) deferred.push(node);
                    }
                },
            );
            pagedOk = true;
        } catch {
            // any paged-scan failure — clear any partial set and fall through
            // to the portable listNodes scan.
            deferred.length = 0;
        }
    }
    if (!pagedOk) {
        const all = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
        for (const n of all) {
            if (n.id.startsWith('deferred-') && !isResolved(n)) deferred.push(n);
        }
    }
    if (DEFERRED_SCAN_CACHE_TTL_MS > 0) {
        scanCache.set(graph, { expiresAt: Date.now() + DEFERRED_SCAN_CACHE_TTL_MS, deferred });
    }
    return deferred;
}

/**
 * findDeferredMatches — scan all deferred-* nodes and return the ones
 * that match the given signal. Returns [] when there are no matches.
 *
 * Complexity: O(N_deferred) where N is the count of unresolved
 * deferred nodes. For realistic workloads (< 50) this is negligible;
 * the (per-graph, TTL'd) scan cache absorbs the corpus walk across
 * repeated calls within the TTL window — see scanDeferredNodes above.
 */
export async function findDeferredMatches(
    graph: DeferredGraph,
    signal: DeferredSignal,
): Promise<DeferredMatch[]> {
    const deferred = await scanDeferredNodes(graph);
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
            const triggerTags = extractTriggerTags(node).join(' ');
            const hay = [node.label, node.content, node.tags, triggerTags]
                .filter(Boolean).join(' ').toLowerCase();
            topicHit = hay.includes(topic);
        }

        if (!fileHit && !topicHit) continue;

        matches.push({
            id: node.id,
            label: node.label,
            tags: tagsToString(node.tags),
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
    // Resolution is the one deferred-specific write this module owns — drop
    // the scan cache for this graph so the resolved node stops surfacing
    // immediately instead of lingering for up to DEFERRED_SCAN_CACHE_TTL_MS.
    // (A brand-new deferred-* node created elsewhere still waits out the TTL —
    // best-effort enrichment, same trade-off the old listNodes()-cache path had.)
    scanCache.delete(graph as DeferredGraph);
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

/**
 * developer/reconnect.ts — Developer plugin's contribution to the core
 * reconnect pass.
 *
 * Two hooks:
 *   contributeDeveloperReconnectNodes(ctx)
 *     Returns CodeFile + CodeSymbol as EmbeddableNodes with prefixed ids
 *     ("file:<path>", "symbol:<uid>") and disk-read content where
 *     available. The core reconnect pass treats these alongside the
 *     LoreNodes it embeds by default.
 *
 *   routeDeveloperReconnectEdge(proposal, ctx)
 *     Given a cross-pillar edge proposal where one side is a lore node
 *     and the other is a file or symbol, inserts into the correct rel
 *     table (LoreTouchesFile or LoreAppliesToCode). Returns true when
 *     handled.
 *
 * Disk-read enrichment uses `gitnexus list` to translate repo name to
 * an absolute filesystem path; falls back to graph-built previews when
 * gitnexus isn't available or the path can't be resolved.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PluginGraphContext, PluginContext, EmbeddableNode, ReconnectEdgeProposal } from '@lore-core/plugins/types.js';
import { listCodeSymbols, listCodeFilesWithPreview, addLoreTouchesFile, linkKnowledgeToCode } from './operations.js';
import {
    CODE_FILE_COLL,
    CODE_RELATION_COLL,
    CODE_SYMBOL_COLL,
    FILE_CONTAINS_COLL,
    LORE_APPLIES_TO_CODE_COLL,
    LORE_TOUCHES_FILE_COLL,
} from './collections.js';
import { buildVerbatimText, type VerbatimStore } from '@lore-core/engines/verbatimStore.js';

const PREFIX_LORE = 'lore:';
const PREFIX_FILE = 'file:';
const PREFIX_SYMBOL = 'symbol:';
/** Must match core reconnect.ts SEMANTIC_PREFIX — edge relation prefix
 *  used for inferred semantic edges across all pillars. */
const SEMANTIC_PREFIX = 'semantic_neighbor';

/* ─── gitnexus disk-path resolution ───────────────────────────── */

let repoRootCache: Map<string, string> | null = null;

function loadRepoRoots(): Map<string, string> {
    if (repoRootCache) return repoRootCache;
    const out = new Map<string, string>();
    try {
        const stdout = execSync('gitnexus list', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const lines = stdout.split('\n');
        let currentName: string | null = null;
        for (const raw of lines) {
            const line = raw.trimEnd();
            const nameMatch = /^ {2}(\S.*\S)$/.exec(line);
            if (nameMatch && !line.trim().startsWith('Path:') && !line.includes('Indexed Repositories')) {
                currentName = nameMatch[1];
                continue;
            }
            const pathMatch = /^\s{4}Path:\s+(.+)$/.exec(line);
            if (pathMatch && currentName) {
                out.set(currentName, pathMatch[1].trim());
                currentName = null;
            }
        }
    } catch {
        // gitnexus unavailable; plugin still works with graph-built previews.
    }
    repoRootCache = out;
    return out;
}

function readFileHead(repo: string, relPath: string, maxBytes: number): string {
    if (!repo || !relPath) return '';
    const roots = loadRepoRoots();
    const root = roots.get(repo);
    if (!root) return '';
    const abs = path.join(root, relPath);
    try {
        const stat = fs.statSync(abs);
        if (!stat.isFile()) return '';
        const fd = fs.openSync(abs, 'r');
        try {
            const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
            fs.readSync(fd, buf, 0, buf.length, 0);
            return buf.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return '';
    }
}

/* ─── contributeReconnectNodes hook ───────────────────────────── */

export async function contributeDeveloperReconnectNodes(
    ctx: PluginGraphContext,
): Promise<EmbeddableNode[]> {
    const out: EmbeddableNode[] = [];
    loadRepoRoots();

    // CodeFiles — with disk-read enrichment.
    const filesWithPreview = await listCodeFilesWithPreview(ctx, 2048);
    for (const f of filesWithPreview) {
        const slug = f.path.split('/').slice(-2).join('/');
        const diskHead = readFileHead(f.repo, f.path, 2048);
        const bodyText = diskHead.trim().length > 0 ? diskHead : `${f.path}\n\n${f.preview}`;
        out.push({
            id: PREFIX_FILE + f.path,
            text: buildVerbatimText(slug, bodyText, `${f.language} ${f.repo}`),
            metadata: {
                type: 'code_file',
                label: slug,
                tags: f.language,
                project: f.repo,
                ecosystem: '',
                updatedAt: '',
                security_scopes: [],
            },
        });
    }

    // CodeSymbols — importance-weighted contribution (v1.1, 2026-04-30).
    //
    // Old behaviour: take first 2000 symbols by enumeration order.
    // Problem: most code in any real repo is helpers / generated /
    // tests / type aliases. Embedding all of them costs CPU + cache
    // space without improving search quality, and the 2000 cap drops
    // unimportant tail with no preference for what stays.
    //
    // New behaviour: rank symbols by importance, embed top N. Three signals:
    //   1. Knowledge-linked  (most important: someone explicitly attached
    //      a LoreNode to this symbol — clear signal of operator interest)
    //   2. Inbound edge count (proxy for pagerank — symbols called by many
    //      others matter more than orphans)
    //   3. Recently-changed  (TODO when v1.1 file-watcher lands; today
    //      we don't track per-symbol updatedAt)
    //
    // Tiers within the cap:
    //   - All knowledge-linked symbols (typically <100)
    //   - Top callees by inbound count (fills remainder up to cap)
    const SYMBOL_CONTRIBUTION_CAP = 2000;
    const knowledgeLinkedUids = new Set<string>();
    try {
        const rows = await ctx.queryRows(
            `MATCH (n:LoreNode)-[:LoreAppliesToCode]->(s:CodeSymbol)
             RETURN s.uid AS uid, count(n) AS knowledgeLinks
             ORDER BY knowledgeLinks DESC`,
        );
        for (const r of rows) {
            if (typeof r['uid'] === 'string') knowledgeLinkedUids.add(r['uid']);
        }
    } catch {
        // Cypher unavailable (cloud mode etc.) — graceful fallback to flat list.
    }
    const allSymbols = await listCodeSymbols(ctx, SYMBOL_CONTRIBUTION_CAP * 4);
    // Inbound-edge counts via one query.
    const inboundByUid = new Map<string, number>();
    try {
        const rows = await ctx.queryRows(
            `MATCH (a:CodeSymbol)-[r:CodeRelation]->(b:CodeSymbol)
             RETURN b.uid AS uid, count(r) AS inbound`,
        );
        for (const r of rows) {
            const uid = r['uid'];
            if (typeof uid === 'string') inboundByUid.set(uid, Number(r['inbound']) || 0);
        }
    } catch { /* best-effort */ }

    // Score: 1000 if knowledge-linked, plus inbound count.
    const scored = allSymbols.map((s) => ({
        sym: s,
        score: (knowledgeLinkedUids.has(s.uid) ? 1000 : 0) + (inboundByUid.get(s.uid) ?? 0),
    }));
    scored.sort((a, b) => b.score - a.score);
    const symbols = scored.slice(0, SYMBOL_CONTRIBUTION_CAP).map((x) => x.sym);

    for (const s of symbols) {
        let bodyText = [s.signature ?? '', (s.content ?? '').slice(0, 1024)]
            .filter((p) => p.trim())
            .join('\n\n');
        if (!bodyText.trim()) {
            const diskFull = readFileHead(s.repo, s.filePath, 16 * 1024);
            if (diskFull) {
                if (s.startLine > 0 && s.endLine >= s.startLine) {
                    const lines = diskFull.split('\n');
                    bodyText = lines.slice(Math.max(0, s.startLine - 1), s.endLine).join('\n').slice(0, 1024);
                } else {
                    bodyText = diskFull.slice(0, 1024);
                }
            }
        }
        const text = buildVerbatimText(s.name, bodyText, `${s.kind} ${s.filePath}`);
        if (!text.trim()) continue;
        out.push({
            id: PREFIX_SYMBOL + s.uid,
            text,
            metadata: {
                type: 'code_symbol',
                label: s.name,
                tags: s.kind,
                project: s.repo,
                ecosystem: '',
                updatedAt: '',
                security_scopes: [],
            },
        });
    }

    return out;
}

/* ─── routeReconnectEdge hook ─────────────────────────────────── */

function strip(prefixedId: string): string {
    const i = prefixedId.indexOf(':');
    return i < 0 ? prefixedId : prefixedId.slice(i + 1);
}

/**
 * contributeDeveloperTopology — Plugin-side /api/topology contribution.
 * Emits CodeFile + CodeSymbol as nodes with prefixed ids + the three
 * cross-pillar edge kinds the developer plugin owns. Core LocalGraph
 * emits only LoreNode / LoreEdge; this function fills in the code layer.
 */
export async function contributeDeveloperTopology(
    ctx: PluginGraphContext,
    limit: number = 300,
    projects?: string[] | string,
): Promise<{
    nodes: Array<{ id: string; label: string; type: string; project?: string; group?: string }>;
    edges: Array<{ from: string; to: string; label: string }>;
}> {
    const nodes: Array<{ id: string; label: string; type: string; project?: string; group?: string }> = [];
    const edges: Array<{ from: string; to: string; label: string }> = [];

    // 2026-04-27 multi-project: accept array or string.
    const projectsList = Array.isArray(projects)
        ? projects.filter((p) => p && p.trim().length > 0)
        : (projects && projects.trim().length > 0 ? [projects] : []);
    const hasProjects = projectsList.length > 0;
    // Single project keeps the old code path (uses storage.find with eq).
    // Multi-project switches to raw Cypher with IN clause via queryRows.
    const project = projectsList.length === 1 ? projectsList[0] : undefined;
    const fileFilter = project ? { eq: { repo: project } } : {};

    // 2026-04-27 perf rewrite: replaced N+1 per-anchor traverse loops
    // with single-shot bulk Cypher queries. Was 60k+ DB calls for a
    // 15k-symbol corpus; now 4 queries total (one per edge table).
    //
    // Why raw Cypher in plug-in code: PluginStorage's `traverse` API
    // is anchor-bound (one anchor per call) and `find` works on node
    // tables only. Bulk edge enumeration is the missing primitive.
    // Per the plug-in convention, raw Cypher via ctx.executeQuery is
    // acceptable on the plug-in side as long as it's the plug-in's
    // own tables. TODO: when cloud-mode op routing lands (Q2.2 follow-
    // up), replace with a substrate-portable PluginStorage.findEdges
    // API so this runs in cloud mode too.
    // Build WHERE clauses for single-project (=) or multi-project (IN).
    // hasProjects covers both: a single project OR multiple. params is
    // the same shape either way (Kùzu supports IN with array param).
    const buildWhere = (alias: string): string => {
        if (!hasProjects) return '';
        return `WHERE ${alias}.repo IN $projects`;
    };
    const projectClause = buildWhere('n');
    const projectClauseFor = (alias: string) => buildWhere(alias);
    const params: Record<string, unknown> | undefined = hasProjects ? { projects: projectsList } : undefined;

    // Files (filtered by project list if requested)
    try {
        const fileRows = await ctx.queryRows(
            `MATCH (n:CodeFile) ${projectClause} RETURN n.path AS path, n.repo AS repo LIMIT ${limit}`,
            params,
        );
        for (const f of fileRows) {
            const pathStr = String(f['path'] ?? '');
            nodes.push({
                id: `file:${pathStr}`,
                label: pathStr.split('/').slice(-2).join('/'),
                type: 'code_file',
                project: (f['repo'] as string | undefined) ?? undefined,
                group: 'code_file',
            });
        }

        // FileContains: bulk fetch (single query). Filter to files in
        // the current project so we don't pull cross-project edges
        // when drilled in.
        const fcRows = await ctx.queryRows(
            `MATCH (n:CodeFile)-[:FileContains]->(s:CodeSymbol)
             ${buildWhere('n')}
             RETURN n.path AS srcPath, s.uid AS dstUid
             LIMIT ${limit * 4}`,
            params,
        );
        for (const e of fcRows) {
            edges.push({
                from: `file:${e['srcPath']}`,
                to: `symbol:${e['dstUid']}`,
                label: 'contains',
            });
        }

        // LoreTouchesFile: single bulk query.
        const ltRows = await ctx.queryRows(
            `MATCH (l:LoreNode)-[r:LoreTouchesFile]->(f:CodeFile)
             ${buildWhere('f')}
             RETURN l.id AS srcId, f.path AS dstPath, r.relation AS relation
             LIMIT ${limit}`,
            params,
        );
        for (const e of ltRows) {
            edges.push({
                from: String(e['srcId']),
                to: `file:${e['dstPath']}`,
                label: (e['relation'] as string | undefined) ?? 'touches',
            });
        }
    } catch (err) {
        // Tables may be missing on older graphs.
        console.error(`[contributeDeveloperTopology] file/edge bulk fetch failed: ${(err as Error).message}`);
    }

    // Symbols + their edges
    try {
        const symRows = await ctx.queryRows(
            `MATCH (n:CodeSymbol) ${projectClauseFor('n')} RETURN n.uid AS uid, n.name AS name, n.repo AS repo LIMIT ${limit * 4}`,
            params,
        );
        for (const s of symRows) {
            const uid = String(s['uid'] ?? '');
            nodes.push({
                id: `symbol:${uid}`,
                label: String(s['name'] ?? ''),
                type: 'code_symbol',
                project: (s['repo'] as string | undefined) ?? undefined,
                group: 'code_symbol',
            });
        }

        // CodeRelation: bulk fetch. Filter source-side to project so
        // drill-in only sees within-project call edges.
        const crRows = await ctx.queryRows(
            `MATCH (n:CodeSymbol)-[r:CodeRelation]->(m:CodeSymbol)
             ${buildWhere('n')}
             RETURN n.uid AS srcUid, m.uid AS dstUid, r.type AS type
             LIMIT ${limit * 4}`,
            params,
        );
        for (const e of crRows) {
            edges.push({
                from: `symbol:${e['srcUid']}`,
                to: `symbol:${e['dstUid']}`,
                label: (e['type'] as string | undefined) ?? '',
            });
        }

        // LoreAppliesToCode: bulk fetch.
        const laRows = await ctx.queryRows(
            `MATCH (l:LoreNode)-[r:LoreAppliesToCode]->(s:CodeSymbol)
             ${buildWhere('s')}
             RETURN l.id AS srcId, s.uid AS dstUid, r.relation AS relation
             LIMIT ${limit}`,
            params,
        );
        for (const e of laRows) {
            edges.push({
                from: String(e['srcId']),
                to: `symbol:${e['dstUid']}`,
                label: (e['relation'] as string | undefined) ?? 'applies_to',
            });
        }
    } catch (err) {
        console.error(`[contributeDeveloperTopology] symbol/edge bulk fetch failed: ${(err as Error).message}`);
    }

    return { nodes, edges };
}

export async function routeDeveloperReconnectEdge(
    proposal: ReconnectEdgeProposal,
    ctx: PluginGraphContext,
): Promise<boolean> {
    const { from, to, relation } = proposal;
    const fromIsLore = from.startsWith(PREFIX_LORE);
    const toIsLore = to.startsWith(PREFIX_LORE);
    const fromIsFile = from.startsWith(PREFIX_FILE);
    const toIsFile = to.startsWith(PREFIX_FILE);
    const fromIsSymbol = from.startsWith(PREFIX_SYMBOL);
    const toIsSymbol = to.startsWith(PREFIX_SYMBOL);

    try {
        if (fromIsLore && toIsFile) {
            await addLoreTouchesFile(ctx, strip(from), strip(to), relation);
            return true;
        }
        if (toIsLore && fromIsFile) {
            await addLoreTouchesFile(ctx, strip(to), strip(from), relation);
            return true;
        }
        if (fromIsLore && toIsSymbol) {
            await linkKnowledgeToCode(ctx, strip(from), strip(to), relation);
            return true;
        }
        if (toIsLore && fromIsSymbol) {
            await linkKnowledgeToCode(ctx, strip(to), strip(from), relation);
            return true;
        }
    } catch {
        // Skip stale edges silently — dead embeddings whose node was deleted.
    }
    return false;
}

/* ─── recalibrate hook (Q1.8) ─────────────────────────────────── */

/**
 * Q1.8 — Plugin recalibrate implementation. Given a `file:<path>` or
 * `symbol:<uid>` marker, rebuild the node's semantic edges by:
 *   1. Looking up the node in the plugin's own Kùzu tables.
 *   2. Rebuilding its embedding text with the same shape the full
 *      reconnect pass uses (buildVerbatimText + disk-read enrichment).
 *   3. Re-storing into verbatim (delete-then-store, idempotent).
 *   4. Running the vector search and routing each above-threshold hit
 *      back through `routeDeveloperReconnectEdge` (for lore↔code
 *      pairs) and `graph.addEdge` (for pure code↔code pairs).
 *
 * Contract matches core `reconnectOneNode`:
 *   returns { added, confidences } on success; null when the marker
 *   prefix isn't one the developer plugin owns (caller tries the next
 *   plugin).
 *
 * Symmetric with how the full reconnect writes edges so `Recalibrate`
 * from the UI drawer produces edges indistinguishable from a regular
 * reconnect pass targeting only this node.
 */
export async function recalibrateDeveloperNode(
    markerId: string,
    ctx: PluginContext,
    opts: { k?: number; minSim?: number } = {},
): Promise<{ added: number; confidences: number[] } | null> {
    if (!markerId.startsWith(PREFIX_FILE) && !markerId.startsWith(PREFIX_SYMBOL)) {
        return null;
    }
    const k = opts.k ?? 5;
    const minSim = opts.minSim ?? 0.65;

    const graph = ctx.graph as {
        createPluginGraphContext: () => PluginGraphContext;
        addEdge: (e: { sourceId: string; targetId: string; relation: string; confidence: 'inferred' | 'asserted'; confidenceScore?: number }) => Promise<void>;
    };
    const verbatim = ctx.verbatimStore as VerbatimStore;
    const graphCtx = graph.createPluginGraphContext();
    await verbatim.initialize();

    // Build the embeddable shape for this one node. We reuse the same
    // logic as contributeDeveloperReconnectNodes but target a single
    // marker — otherwise we'd re-embed the whole codebase on every click.
    const embeddable = await buildSingleEmbeddable(markerId, graphCtx);
    if (!embeddable) return null;

    // Append-only: store() handles snapshot-then-overwrite.
    await verbatim.store({
        id: embeddable.id,
        text: embeddable.text,
        metadata: embeddable.metadata,
    });

    const hits = await verbatim.search(embeddable.text, k + 1);
    const confidences: number[] = [];
    let added = 0;
    for (const hit of hits) {
        if (hit.id === embeddable.id) continue;
        const sim = hit.score ?? 0;
        if (sim < minSim) continue;
        const relation = `${SEMANTIC_PREFIX}:${sim.toFixed(3)}`;

        // Pure code↔code (file↔file, file↔symbol, symbol↔symbol):
        // these edges aren't owned by the core LoreEdge table — the
        // full reconnect pass either routes them through a plugin or
        // drops them. We follow the same behavior here (drop), which
        // keeps recalibrate's effect consistent with a targeted
        // reconnect run. lore↔code pairs DO get routed below.
        const hitIsLore = hit.id.startsWith(PREFIX_LORE);
        const targetIsLore = embeddable.id.startsWith(PREFIX_LORE); // always false here
        if (!hitIsLore && !targetIsLore) {
            // Both sides are code nodes. For now there's no rel table
            // that accepts a pure code↔code semantic edge; the full
            // reconnect pass drops these too. Count the hit for
            // signal but don't write an edge.
            continue;
        }

        // lore↔code pair — route through the developer plugin's own
        // rel-table mapping (LoreTouchesFile / LoreAppliesToCode).
        try {
            const handled = await routeDeveloperReconnectEdge(
                { from: embeddable.id, to: hit.id, confidence: sim, relation },
                graphCtx,
            );
            if (handled) {
                confidences.push(sim);
                added++;
            }
        } catch {
            // Dead edge — target or source node no longer exists in Kùzu.
        }
    }
    return { added, confidences };
}

/**
 * buildSingleEmbeddable — One-node version of
 * contributeDeveloperReconnectNodes. Returns null if the node isn't
 * found in the plugin's tables. Recalibrate uses this to avoid a full
 * table scan when the user clicked a specific drawer row.
 */
async function buildSingleEmbeddable(
    markerId: string,
    ctx: PluginGraphContext,
): Promise<EmbeddableNode | null> {
    loadRepoRoots();
    if (markerId.startsWith(PREFIX_FILE)) {
        const filePath = markerId.slice(PREFIX_FILE.length);
        const f = await ctx.storage.get<Record<string, unknown>>(
            CODE_FILE_COLL,
            'path',
            filePath,
        ).catch(() => null);
        if (!f) return null;
        const repo = String(f['repo'] ?? '');
        const language = String(f['language'] ?? '');
        const slug = filePath.split('/').slice(-2).join('/');
        const diskHead = readFileHead(repo, filePath, 2048);
        const bodyText = diskHead.trim().length > 0 ? diskHead : filePath;
        return {
            id: PREFIX_FILE + filePath,
            text: buildVerbatimText(slug, bodyText, `${language} ${repo}`),
            metadata: {
                type: 'code_file',
                label: slug,
                tags: language,
                project: repo,
                ecosystem: '',
                updatedAt: '',
                security_scopes: [],
            },
        };
    }
    if (markerId.startsWith(PREFIX_SYMBOL)) {
        const uid = markerId.slice(PREFIX_SYMBOL.length);
        const s = await ctx.storage.get<Record<string, unknown>>(
            CODE_SYMBOL_COLL,
            'uid',
            uid,
        ).catch(() => null);
        if (!s) return null;
        const name = String(s['name'] ?? uid);
        const kind = String(s['kind'] ?? '');
        const filePath = String(s['filePath'] ?? '');
        const repo = String(s['repo'] ?? '');
        let bodyText = [String(s['signature'] ?? ''), String(s['content'] ?? '').slice(0, 1024)]
            .filter((p) => p.trim())
            .join('\n\n');
        if (!bodyText.trim()) {
            const startLine = Number(s['startLine'] ?? 0);
            const endLine = Number(s['endLine'] ?? 0);
            const diskFull = readFileHead(repo, filePath, 16 * 1024);
            if (diskFull) {
                if (startLine > 0 && endLine >= startLine) {
                    const lines = diskFull.split('\n');
                    bodyText = lines.slice(Math.max(0, startLine - 1), endLine).join('\n').slice(0, 1024);
                } else {
                    bodyText = diskFull.slice(0, 1024);
                }
            }
        }
        const text = buildVerbatimText(name, bodyText, `${kind} ${filePath}`);
        if (!text.trim()) return null;
        return {
            id: PREFIX_SYMBOL + uid,
            text,
            metadata: {
                type: 'code_symbol',
                label: name,
                tags: kind,
                project: repo,
                ecosystem: '',
                updatedAt: '',
                security_scopes: [],
            },
        };
    }
    return null;
}

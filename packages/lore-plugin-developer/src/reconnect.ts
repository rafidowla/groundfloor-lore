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

    // CodeSymbols — slice the file body between startLine / endLine when
    // the graph only stored structural fields (GitNexus usually leaves
    // signature + content empty).
    const symbols = await listCodeSymbols(ctx, 2000);
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
): Promise<{
    nodes: Array<{ id: string; label: string; type: string; project?: string; group?: string }>;
    edges: Array<{ from: string; to: string; label: string }>;
}> {
    const nodes: Array<{ id: string; label: string; type: string; project?: string; group?: string }> = [];
    const edges: Array<{ from: string; to: string; label: string }> = [];

    try {
        const fileRows = await ctx.queryRows(`MATCH (f:CodeFile) RETURN f LIMIT ${limit}`);
        for (const row of fileRows) {
            const f = row.f as Record<string, unknown>;
            const pathStr = (f?.path as string) ?? '';
            nodes.push({
                id: `file:${pathStr}`,
                label: pathStr.split('/').slice(-2).join('/'),
                type: 'code_file',
                project: f?.repo as string | undefined,
                group: 'code_file',
            });
        }
        const fcRows = await ctx.queryRows(
            `MATCH (f:CodeFile)-[:FileContains]->(s:CodeSymbol) RETURN f.path AS fpath, s.uid AS suid LIMIT ${limit * 4}`,
        );
        for (const row of fcRows) {
            edges.push({ from: `file:${row.fpath}`, to: `symbol:${row.suid}`, label: 'contains' });
        }
        const ltRows = await ctx.queryRows(
            `MATCH (n:LoreNode)-[r:LoreTouchesFile]->(f:CodeFile) RETURN n.id AS nid, f.path AS fpath, r.relation AS rel LIMIT ${limit}`,
        );
        for (const row of ltRows) {
            edges.push({ from: row.nid as string, to: `file:${row.fpath}`, label: (row.rel as string) ?? 'touches' });
        }
    } catch { /* tables may be missing on older graphs */ }

    try {
        const symRows = await ctx.queryRows(`MATCH (s:CodeSymbol) RETURN s LIMIT ${limit * 4}`);
        for (const row of symRows) {
            const s = row.s as Record<string, unknown>;
            nodes.push({
                id: `symbol:${s?.uid}`,
                label: (s?.name as string) ?? '',
                type: 'code_symbol',
                project: s?.repo as string | undefined,
                group: 'code_symbol',
            });
        }
        const crRows = await ctx.queryRows(
            `MATCH (a:CodeSymbol)-[e:CodeRelation]->(b:CodeSymbol) RETURN a.uid AS src, e.type AS rel, b.uid AS dst LIMIT ${limit * 4}`,
        );
        for (const row of crRows) {
            edges.push({ from: `symbol:${row.src}`, to: `symbol:${row.dst}`, label: row.rel as string });
        }
        const laRows = await ctx.queryRows(
            `MATCH (n:LoreNode)-[e:LoreAppliesToCode]->(s:CodeSymbol) RETURN n.id AS nid, s.uid AS suid, e.relation AS rel LIMIT ${limit}`,
        );
        for (const row of laRows) {
            edges.push({ from: row.nid as string, to: `symbol:${row.suid}`, label: (row.rel as string) ?? 'applies_to' });
        }
    } catch { /* ignore */ }

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

    try { await verbatim.delete(embeddable.id); } catch { /* ignore */ }
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
        const fileRows = await ctx.queryRows(
            `MATCH (f:CodeFile {path: $path})
             RETURN f.path AS path, f.language AS language, f.repo AS repo`,
            { path: filePath },
        ).catch(() => []);
        if (fileRows.length === 0) return null;
        const f = fileRows[0] as Record<string, unknown>;
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
        const symRows = await ctx.queryRows(
            `MATCH (s:CodeSymbol {uid: $uid})
             RETURN s.uid AS uid, s.name AS name, s.kind AS kind, s.filePath AS filePath,
                    s.signature AS signature, s.content AS content, s.repo AS repo,
                    s.startLine AS startLine, s.endLine AS endLine`,
            { uid },
        ).catch(() => []);
        if (symRows.length === 0) return null;
        const s = symRows[0] as Record<string, unknown>;
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

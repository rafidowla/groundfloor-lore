/**
 * reconnect.ts — V2.1 Graph reconnection engine (cross-pillar).
 *
 * Problem being solved:
 *   A freshly-indexed Lore graph has knowledge nodes, code files, and code
 *   symbols but very few edges linking knowledge to code — which is the
 *   whole point of a unified memory engine. This module embeds all three
 *   node kinds into the same vector space (LanceDB via Xenova) and lays
 *   semantic edges across the pillars.
 *
 * Vector space IDs:
 *   Nodes are embedded in VerbatimStore with prefixed IDs so a single
 *   search returns hits across all kinds in one round-trip:
 *     "lore:<id>"     — LoreNode (decisions, conventions, …)
 *     "file:<path>"   — CodeFile
 *     "symbol:<uid>"  — CodeSymbol
 *
 *   On retrieval, the prefix routes each edge into the correct Kùzu
 *   REL table:
 *     lore  ↔ lore    → LoreEdge                (relation)
 *     lore  ↔ file    → LoreTouchesFile         (relation)
 *     lore  ↔ symbol  → LoreAppliesToCode       (relation)
 *     file  ↔ file    → skipped (no rel table yet)
 *     file  ↔ symbol  → skipped (FileContains is structural, not semantic)
 *     symbol↔ symbol  → skipped (CodeRelation exists but stores call graph)
 *
 *   The three covered tables are the highest-value for the developer
 *   query pattern "which decisions/bug_patterns touch this file/symbol?".
 *   The skipped pairs can be added in a follow-up.
 *
 * Pair dedupe: canonical (min, max) keyed on the prefixed IDs so A↔B
 *   appears exactly once regardless of scan order.
 *
 * Idempotency: prune + re-insert. Only edges whose relation starts with
 *   "semantic_neighbor" are touched; human-asserted relations survive.
 *
 * Ingest hook (reconnectOneNode): scoped to a single LoreNode — embeds
 *   it and draws outgoing edges to its top-K nearest neighbors across
 *   all pillars. Never prunes.
 */

import type { LocalGraph, LoreNode } from './localGraph.js';
import type { VerbatimStore } from './verbatimStore.js';
import { buildVerbatimText } from './verbatimStore.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * repoRootCache — disk-location lookup for each indexed repo. Populated
 * once per reconnect pass by parsing `gitnexus list` output. Using the
 * CLI output is uglier than a programmatic API but avoids a hard
 * dependency on gitnexus internals and works offline.
 *
 * Map: repoName → absolute filesystem path.
 */
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
            // Top-level repo name is indented with 2 spaces, no further nesting.
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
        // gitnexus CLI missing or failed; fall back to empty map so callers
        // know there's no disk path available.
    }
    repoRootCache = out;
    return out;
}

/**
 * readFileHead — Best-effort read of the first N bytes of a source file.
 * Uses the gitnexus repo registry to translate relative paths; if the
 * repo root can't be resolved or the read fails, returns an empty string.
 */
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

const SEMANTIC_PREFIX = 'semantic_neighbor';
const PREFIX_LORE = 'lore:';
const PREFIX_FILE = 'file:';
const PREFIX_SYMBOL = 'symbol:';

export interface ReconnectOptions {
    k?: number;
    minSim?: number;
    dryRun?: boolean;
    pruneInferred?: boolean;
}

export interface ReconnectProposal {
    from: string;
    to: string;
    kindPair: 'lore-lore' | 'lore-file' | 'lore-symbol';
    confidence: number;
}

export interface ReconnectResult {
    candidatesScanned: number;
    embeddingsAdded: number;
    proposedEdges: ReconnectProposal[];
    applied: boolean;
    prunedByTable: { loreEdge: number; touchesFile: number; appliesToCode: number };
    edgesInsertedByTable: { loreEdge: number; touchesFile: number; appliesToCode: number };
    distribution: Record<string, number>;
}

/** Classify a prefixed id into its pillar. */
function pillar(prefixedId: string): 'lore' | 'file' | 'symbol' | 'unknown' {
    if (prefixedId.startsWith(PREFIX_LORE)) return 'lore';
    if (prefixedId.startsWith(PREFIX_FILE)) return 'file';
    if (prefixedId.startsWith(PREFIX_SYMBOL)) return 'symbol';
    return 'unknown';
}

function strip(prefixedId: string): string {
    const i = prefixedId.indexOf(':');
    return i < 0 ? prefixedId : prefixedId.slice(i + 1);
}

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

    // 1. Pull every node we care about from the graph.
    //    V2.1 enrichment: CodeFile embeddings carry a ~2 KB preview of
    //    their child symbols' name+signature+content-head so they embed
    //    to real semantic content, not just the filename.
    const loreNodes: LoreNode[] = await graph.listNodes();
    const codeFiles = await graph.listCodeFilesWithPreview(2048);
    const codeSymbols = await graph.listCodeSymbols(2000);
    const totalNodes = loreNodes.length + codeFiles.length + codeSymbols.length;

    // 2. Embed everything. Each kind produces a prefixed id + a descriptive
    // text blob. We delete prior rows first so this pass also updates stale
    // embeddings.
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

    // V2.1 reconsume: if gitnexus knows the repo's on-disk location,
    // read the first 2 KB of each file directly. This is the highest-
    // quality content signal available — actual code, not just names.
    // Falls back to the graph-built preview if disk read is impossible.
    const fileReadBudget = 2048;
    for (const f of codeFiles) {
        const slug = f.path.split('/').slice(-2).join('/');
        const diskHead = readFileHead(f.repo, f.path, fileReadBudget);
        const bodyText = diskHead.trim().length > 0
            ? diskHead
            : `${f.path}\n\n${f.preview}`;
        // Embedding text = slug + language + repo + (disk content OR
        // symbol preview). Disk content produces genuine cross-pillar
        // matches; symbol preview is the fallback when paths can't resolve.
        const text = buildVerbatimText(slug, bodyText, `${f.language} ${f.repo}`);
        const prefixedId = PREFIX_FILE + f.path;
        try { await verbatim.delete(prefixedId); } catch { /* ignore */ }
        await verbatim.store({
            id: prefixedId,
            text,
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
        embeddingsAdded++;
    }

    // Pre-load repo roots once so per-symbol disk reads don't reparse
    // gitnexus list every iteration.
    loadRepoRoots();
    for (const s of codeSymbols) {
        // V2.1 reconsume: prefer an actual slice of the source file between
        // startLine and endLine when we can resolve the path; GitNexus
        // often stores empty signature/content so the graph alone is thin.
        let bodyText = [s.signature ?? '', (s.content ?? '').slice(0, 1024)]
            .filter((p) => p.trim())
            .join('\n\n');
        if (!bodyText.trim()) {
            const diskFull = readFileHead(s.repo, s.filePath, 16 * 1024);
            if (diskFull) {
                // Slice by 1-indexed line numbers.
                const start = (s as unknown as { startLine?: number }).startLine ?? 0;
                const end = (s as unknown as { endLine?: number }).endLine ?? 0;
                if (start > 0 && end >= start) {
                    const lines = diskFull.split('\n');
                    bodyText = lines.slice(Math.max(0, start - 1), end).join('\n').slice(0, 1024);
                } else {
                    bodyText = diskFull.slice(0, 1024);
                }
            }
        }

        const text = buildVerbatimText(
            s.name,
            bodyText,
            `${s.kind} ${s.filePath}`,
        );
        if (!text.trim()) continue;
        const prefixedId = PREFIX_SYMBOL + s.uid;
        try { await verbatim.delete(prefixedId); } catch { /* ignore */ }
        await verbatim.store({
            id: prefixedId,
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
        embeddingsAdded++;
    }

    // 3. For each LoreNode, find top-K nearest across the whole vector space.
    //    We only walk LoreNodes as sources for V2.1 MVP — the developer-value
    //    queries all start from knowledge. Symbol↔symbol semantic edges can
    //    be added in a follow-up.
    const seenPair = new Set<string>();
    const proposedEdges: ReconnectProposal[] = [];
    const dist: Record<string, number> = {};

    // Stratified top-K: for each source we pull a wider pool (k * 8) and
    // then keep up to K hits *per target pillar*. Without this, very
    // textually-similar sibling LoreNodes crowd out cross-pillar hits
    // (files and symbols are semantically more distant on average).
    const WIDE_FACTOR = 8;
    const perKindK = Math.max(2, Math.ceil(k / 2));

    for (const n of loreNodes) {
        const text = buildVerbatimText(n.label ?? '', n.content ?? '', n.tags ?? '');
        if (!text.trim()) continue;
        const hits = await verbatim.search(text, k * WIDE_FACTOR);
        const fromId = PREFIX_LORE + n.id;

        const bucketedByPillar: Record<'lore' | 'file' | 'symbol', typeof hits> = {
            lore: [],
            file: [],
            symbol: [],
        };
        for (const hit of hits) {
            if (hit.id === fromId) continue;
            const p = pillar(hit.id);
            if (p === 'unknown') continue;
            const sim = hit.score ?? 0;
            const bucket = `${Math.floor(sim * 20) / 20}`;
            dist[bucket] = (dist[bucket] ?? 0) + 1;
            if (sim < minSim) continue;
            if (bucketedByPillar[p].length < perKindK) {
                bucketedByPillar[p].push(hit);
            }
        }

        for (const pillarName of ['lore', 'file', 'symbol'] as const) {
            for (const hit of bucketedByPillar[pillarName]) {
                const sim = hit.score ?? 0;
                // Canonical pair key uses prefixed IDs.
                const [lo, hi] = fromId < hit.id ? [fromId, hit.id] : [hit.id, fromId];
                const pairKey = `${lo}::${hi}`;
                if (seenPair.has(pairKey)) continue;
                seenPair.add(pairKey);

                const kindPair: ReconnectProposal['kindPair'] =
                    pillarName === 'lore' ? 'lore-lore'
                    : pillarName === 'file' ? 'lore-file'
                    : 'lore-symbol';

                proposedEdges.push({
                    from: fromId,
                    to: hit.id,
                    kindPair,
                    confidence: Number(sim.toFixed(3)),
                });
            }
        }
    }

    if (dryRun) {
        return {
            candidatesScanned: totalNodes,
            embeddingsAdded,
            proposedEdges,
            applied: false,
            prunedByTable: { loreEdge: 0, touchesFile: 0, appliesToCode: 0 },
            edgesInsertedByTable: { loreEdge: 0, touchesFile: 0, appliesToCode: 0 },
            distribution: dist,
        };
    }

    // 4. Apply: prune, then route each proposal to the correct rel table.
    let prunedLoreEdge = 0;
    let prunedTouchesFile = 0;
    let prunedAppliesToCode = 0;
    if (pruneInferred) {
        prunedLoreEdge = await graph.pruneInferredLoreEdges(SEMANTIC_PREFIX);
        const cross = await graph.pruneInferredCrossEdges(SEMANTIC_PREFIX);
        prunedTouchesFile = cross.touchesFile;
        prunedAppliesToCode = cross.appliesToCode;
    }

    let insLore = 0;
    let insTouches = 0;
    let insApplies = 0;

    for (const edge of proposedEdges) {
        const relation = `${SEMANTIC_PREFIX}:${edge.confidence.toFixed(3)}`;
        try {
            if (edge.kindPair === 'lore-lore') {
                // Canonical pair (lo, hi) already chosen; both are lore: prefix.
                await graph.addEdge({
                    sourceId: strip(edge.from < edge.to ? edge.from : edge.to),
                    targetId: strip(edge.from < edge.to ? edge.to : edge.from),
                    relation,
                });
                insLore++;
            } else if (edge.kindPair === 'lore-file') {
                // Directional: LoreNode → CodeFile
                const loreSide = edge.from.startsWith(PREFIX_LORE) ? edge.from : edge.to;
                const fileSide = edge.from.startsWith(PREFIX_FILE) ? edge.from : edge.to;
                await graph.addLoreTouchesFile(strip(loreSide), strip(fileSide), relation);
                insTouches++;
            } else if (edge.kindPair === 'lore-symbol') {
                const loreSide = edge.from.startsWith(PREFIX_LORE) ? edge.from : edge.to;
                const symbolSide = edge.from.startsWith(PREFIX_SYMBOL) ? edge.from : edge.to;
                await graph.linkKnowledgeToCode(strip(loreSide), strip(symbolSide), relation);
                insApplies++;
            }
        } catch (err) {
            // Skip edges where the target node doesn't match on the graph
            // side (e.g., a stale embedding whose node was deleted).
            console.error(`[reconnect] skip ${edge.from}→${edge.to}: ${(err as Error).message}`);
        }
    }

    return {
        candidatesScanned: totalNodes,
        embeddingsAdded,
        proposedEdges,
        applied: true,
        prunedByTable: {
            loreEdge: prunedLoreEdge,
            touchesFile: prunedTouchesFile,
            appliesToCode: prunedAppliesToCode,
        },
        edgesInsertedByTable: {
            loreEdge: insLore,
            touchesFile: insTouches,
            appliesToCode: insApplies,
        },
        distribution: dist,
    };
}

/**
 * reconnectOneNode — Ingest-time hook. Embeds the new LoreNode and draws
 * outgoing semantic edges to its top-K nearest neighbors across all
 * pillars. Never prunes — the full reconnectGraph pass is the only
 * place that rewrites history.
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

    const hits = await verbatim.search(text, k + 1);
    const confidences: number[] = [];
    let added = 0;
    for (const hit of hits) {
        if (hit.id === prefixedId) continue;
        const sim = hit.score ?? 0;
        if (sim < minSim) continue;
        const targetPillar = pillar(hit.id);
        const rel = `${SEMANTIC_PREFIX}:${sim.toFixed(3)}`;
        try {
            if (targetPillar === 'lore') {
                const [lo, hi] = node.id < strip(hit.id) ? [node.id, strip(hit.id)] : [strip(hit.id), node.id];
                await graph.addEdge({ sourceId: lo, targetId: hi, relation: rel });
            } else if (targetPillar === 'file') {
                await graph.addLoreTouchesFile(node.id, strip(hit.id), rel);
            } else if (targetPillar === 'symbol') {
                await graph.linkKnowledgeToCode(node.id, strip(hit.id), rel);
            } else {
                continue;
            }
            confidences.push(sim);
            added++;
        } catch {
            // Skip dead edges silently — hook must not fail inserts.
        }
    }
    return { added, confidences };
}

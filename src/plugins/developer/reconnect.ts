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
import type { PluginGraphContext, EmbeddableNode, ReconnectEdgeProposal } from '../types.js';
import { listCodeSymbols, listCodeFilesWithPreview, addLoreTouchesFile, linkKnowledgeToCode } from './operations.js';
import { buildVerbatimText } from '../../engines/verbatimStore.js';

const PREFIX_LORE = 'lore:';
const PREFIX_FILE = 'file:';
const PREFIX_SYMBOL = 'symbol:';

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

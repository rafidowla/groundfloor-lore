/**
 * storageInspector.ts — How much disk is Lore using? (Phase 2 / C3.5)
 *
 * Before users ingest gigabytes of photos and video transcripts, we need
 * observability. "The user can't manage
 * what they can't see" — this is the observe pillar of the three-pillar
 * storage-growth strategy (observe → bound → offload).
 *
 * What this reports:
 *   - Per-workspace byte breakdown: graph, embeddings, verbatim blobs,
 *     audit log, models, total.
 *   - SSD free space — for ratio-of-budget display.
 *   - Growth over the last N days (when we have historical snapshots;
 *     C3.5 scope ships the point-in-time view; time-series is a
 *     follow-up in Phase 5 when data ages enough to be interesting).
 *
 * The module is read-only. Callers (CLI `lore storage`, an HTTP
 * /api/storage endpoint, the UI's Storage panel) present the data
 * however they like.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loreHome, loreHomePath } from '../config/loreHome.js';

export interface StorageBreakdown {
    /** Absolute bytes used by the graph substrate — legacy engine files or `.lore/surreal/`. */
    graphBytes: number;
    /** Bytes used by LanceDB vector store (all index shards + wal). */
    embeddingsBytes: number;
    /**
     * Row-shaped substrates under `.lore/`: collections, ReBAC grants and the
     * pending-ops queue. Separate from graphBytes because they are no longer
     * part of the graph engine and their size tells a different story — a
     * workspace can have a small graph and a large collection store.
     */
    tabularBytes: number;
    /** Bytes in the workspace registry + config (small, tracked for completeness). */
    configBytes: number;
    /** Bytes in lore-*.log files. */
    logsBytes: number;
    /** Bytes in models/ (Qwen, Whisper, etc. when they land). */
    modelsBytes: number;
    /**
     * Everything else under the data home — catches files we haven't
     * categorized, and makes the report robust against future additions.
     */
    otherBytes: number;
    /** Sum of all of the above. */
    totalBytes: number;

    /** Free bytes on the filesystem holding the data home. */
    diskFreeBytes: number;
    /** Total bytes on the filesystem holding the data home. */
    diskTotalBytes: number;
}

export interface WorkspaceStorageReport {
    name: string;
    path: string;
    breakdown: StorageBreakdown;
}

/**
 * Human-friendly byte formatting: 1234 → "1.2 KB", 1234567 → "1.2 MB".
 */
export function formatBytes(n: number): string {
    if (!Number.isFinite(n)) return '?';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let ui = 0;
    while (v >= 1024 && ui < units.length - 1) { v /= 1024; ui++; }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[ui]}`;
}

/**
 * inspectDataHome — walk the Lore data home and produce the breakdown.
 *
 * Non-destructive; safe to call at any frequency. A full walk of a big
 * LanceDB directory can cost ~10ms per GB on SSD, so callers that ask
 * frequently should cache.
 */
export function inspectDataHome(dataHome: string): StorageBreakdown {
    const out: StorageBreakdown = {
        graphBytes: 0,
        embeddingsBytes: 0,
        tabularBytes: 0,
        configBytes: 0,
        logsBytes: 0,
        modelsBytes: 0,
        otherBytes: 0,
        totalBytes: 0,
        diskFreeBytes: 0,
        diskTotalBytes: 0,
    };

    if (!fs.existsSync(dataHome)) return out;

    // Walk every file under the data home; categorize by path prefix.
    walk(dataHome, (filePath, size) => {
        const rel = path.relative(dataHome, filePath);
        const cat = categorize(rel);
        out[cat] += size;
        out.totalBytes += size;
    });

    // Disk stats for the filesystem the data home sits on. statfs is
    // Node 18.15+. We fall back to zeros if unavailable.
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const statfs = (fs as any).statfsSync?.(dataHome);
        if (statfs) {
            out.diskFreeBytes = Number(statfs.bavail) * Number(statfs.bsize);
            out.diskTotalBytes = Number(statfs.blocks) * Number(statfs.bsize);
        }
    } catch {
        // best-effort
    }

    return out;
}

function categorize(relPath: string): 'graphBytes' | 'embeddingsBytes' | 'tabularBytes' | 'configBytes' | 'logsBytes' | 'modelsBytes' | 'otherBytes' {
    const p = relPath.replace(/\\/g, '/');

    // Graph substrate files — under .lore/ except lancedb/.
    //
    // Both engines count as graph bytes. `.lore/surreal/` was missing until
    // 2026-08-06 and fell through to `otherBytes`, so `lore storage` on a
    // Surreal-backed workspace reported a graph of ~0 bytes while the real
    // data sat in the "other" bucket. A disk report that under-states the
    // largest thing on disk is worse than no report.
    if (p.startsWith('.lore/lancedb/')) return 'embeddingsBytes';
    if (p === '.lore/graph' || p === '.lore/graph.wal' || p === '.lore/graph.backup') return 'graphBytes';
    if (p.startsWith('.lore/graph') || p.startsWith('.lore/sync.wal') || p.startsWith('.lore/hot_session')) return 'graphBytes';
    if (p.startsWith('.lore/surreal')) return 'graphBytes';

    // Row-shaped substrates that left the graph engine (collections, ReBAC
    // grants, the pending-ops queue). Matched by SHAPE, not by a list of
    // filenames, so the next `.sqlite` to arrive is categorised without a code
    // change — the lesson from the backup sidecar bug.
    if (/^\.lore\/[^/]+\.sqlite(-wal|-shm|-journal)?$/.test(p)) return 'tabularBytes';

    if (p.startsWith('logs/') || p.endsWith('.log')) return 'logsBytes';
    if (p.startsWith('models/')) return 'modelsBytes';

    if (p === 'workspaces.json' || p === 'projects.json' || p === '.lore/config.json' || p === 'auth.token') return 'configBytes';
    if (p === 'ingestion.json') return 'configBytes';

    // knowledge.db is a tiny sqlite from V2.0 days; count as graph.
    if (p === 'knowledge.db') return 'graphBytes';

    return 'otherBytes';
}

/**
 * walk — recursive file walker. Calls the visitor for every regular
 * file. Skips symlinks (avoids counting link targets outside the tree).
 */
function walk(root: string, visit: (file: string, size: number) => void): void {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(root);
    } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { visit(root, stat.size); return; }
    if (!stat.isDirectory()) return;

    let entries: string[];
    try { entries = fs.readdirSync(root); } catch { return; }
    for (const e of entries) walk(path.join(root, e), visit);
}

/**
 * inspectAllWorkspaces — build a WorkspaceStorageReport per registered
 * workspace, reading the workspaces.json registry. Returns an empty
 * array if the registry doesn't exist (first-run).
 */
export function inspectAllWorkspaces(dataHome?: string): WorkspaceStorageReport[] {
    const home = dataHome ?? loreHome();
    const registryPath = path.join(home, 'workspaces.json');
    if (!fs.existsSync(registryPath)) return [];

    let registry: { workspaces?: Array<{ name: string; path: string }> };
    try {
        registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    } catch {
        return [];
    }

    const out: WorkspaceStorageReport[] = [];
    for (const ws of registry.workspaces ?? []) {
        // Default workspace = the whole data home (backward-compat with V2.0).
        // Others live under workspaces/<name>/.
        const wsPath = ws.path;
        out.push({
            name: ws.name,
            path: wsPath,
            breakdown: inspectDataHome(wsPath),
        });
    }
    return out;
}

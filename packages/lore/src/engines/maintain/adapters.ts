/**
 * adapters.ts — Real port implementations for `lore maintain`.
 *
 * These wrap the concrete substrates (LanceDB, the local graph, the
 * workspaces registry) behind the narrow ports in ports.ts. The
 * orchestrator never touches a substrate directly, so the same
 * orchestration runs against real stores (here) or fakes (tests).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    loadWorkspaces,
    deleteWorkspace,
    getActiveWorkspaceName,
} from '../../config/workspaces.js';
import { loreHome } from '../../config/loreHome.js';
import type { LocalGraphRegistry } from '../localGraphRegistry.js';
import { isDaemonUp } from '../../cli/commands/migrateWorkspaceToWorkspaceShared.js';
import type {
    LanceMaintainerPort,
    LanceTableProbe,
    LanceTableResult,
    NodeStorePort,
    WorkspaceRegistryPort,
    SafetyPort,
} from './ports.js';
import type { NodeForSelection, WorkspaceForSelection } from './selection.js';
import { forEachNodePage, type NodePager } from '../nodePager.js';

/* ─── disk helpers ─────────────────────────────────────────────── */

export function dirSizeBytes(p: string): number {
    if (!fs.existsSync(p)) return 0;
    let total = 0;
    const stack: string[] = [p];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const child = path.join(cur, entry.name);
            try {
                if (entry.isDirectory()) stack.push(child);
                else if (entry.isFile() || entry.isSymbolicLink()) total += fs.statSync(child).size;
            } catch { /* vanished mid-walk */ }
        }
    }
    return total;
}

/** Count LanceDB fragment files (`*.lance`) under a table's data dir. */
function countFragments(tableDir: string): number {
    const dataDir = path.join(tableDir, 'data');
    try {
        return fs.readdirSync(dataDir).filter((f) => f.endsWith('.lance')).length;
    } catch {
        return 0;
    }
}

/* ─── LanceDB maintainer ───────────────────────────────────────── */

/**
 * Does this error match LanceDB's own "retryable commit conflict" class?
 * `table.optimize()` internally commits a Rewrite (and, when it merges the
 * FTS index, a CreateIndex) transaction under optimistic concurrency — a
 * concurrent writer or a second overlapping optimize() call can preempt
 * that commit, and LanceDB's error text explicitly says "Please retry" when
 * this happens (verified empirically against 0.37.1: "Retryable commit
 * conflict for version N: This Rewrite/CreateIndex transaction was
 * preempted by concurrent transaction ...). This predicate is deliberately
 * narrow — it must NOT match unrelated failures (missing table, corrupt
 * index, disk errors), which should fail fast rather than retry blindly.
 */
export function isRetryableLanceConflict(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /retryable commit conflict/i.test(message) || /transaction was preempted/i.test(message);
}

/**
 * Retry `table.optimize()` a bounded number of times when it throws an
 * error LanceDB marks retryable (see {@link isRetryableLanceConflict});
 * anything else propagates on the first attempt.
 *
 * A commit conflict means the Table handle's in-memory view is already
 * stale — it prepared a Rewrite/CreateIndex against a base version some
 * other writer has since superseded. Simply calling `.optimize()` again on
 * the SAME handle re-prepares against that same stale base and fails the
 * same way (verified empirically: retrying without a refresh did not
 * lower the observed failure rate at all, even with much larger attempt
 * counts/backoff). `checkoutLatest()` pulls the handle forward to the
 * table's current version before the next attempt, which is what actually
 * lets the retry land. Small linear backoff on top gives a concurrent
 * writer's own commit a chance to finish first.
 *
 * Empirically load-bearing: under concurrent-writer load (a live writer +
 * reader racing the maintenance call on the same table, matching Atlas's
 * embedded daemon topology), ~20-30% of `optimizeTable()` calls failed with
 * this exact "please retry" error before this fix; under two overlapping
 * maintenance calls on the same table, ~65-70% did. See
 * scripts/spikes/lancedb-fts-optimize-repro/ for the repro this measures
 * against.
 */
export async function retryOptimizeOnConflict(
    table: LanceTable,
    optOpts: { cleanupOlderThan?: Date },
    maxAttempts = 4,
    baseDelayMs = 25,
): Promise<OptimizeStats> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await table.optimize(optOpts);
        } catch (err) {
            if (!isRetryableLanceConflict(err) || attempt >= maxAttempts) throw err;
            await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
            await table.checkoutLatest().catch(() => { /* best effort — optimize's own error wins if this fails too */ });
        }
    }
}

/**
 * Real LanceDB maintainer for one workspace's `.lore/lancedb` dir.
 *
 * Note on the LanceDB Node SDK (verified empirically against the pinned
 * version): the high-level `table.optimize()` ALWAYS compacts fragments;
 * version pruning happens ONLY when `cleanupOlderThan` is passed. There is
 * no prune-without-compact in the high-level Table API. Consequence:
 * disabling compaction has no effect when version cleanup is enabled —
 * the same optimize pass compacts regardless. Disable BOTH lancedb ops to
 * skip the work entirely. Stats below come straight from OptimizeStats so
 * the report's per-op counts are authoritative, not inferred.
 */
export class LanceMaintainer implements LanceMaintainerPort {
    constructor(private readonly lancedbDir: string) {}

    private async connect(): Promise<{ db: { tableNames(): Promise<string[]>; openTable(n: string): Promise<LanceTable> } } | null> {
        if (!fs.existsSync(this.lancedbDir)) return null;
        const lancedb = await import('@lancedb/lancedb');
        const db = await lancedb.connect(this.lancedbDir);
        return { db: db as unknown as { tableNames(): Promise<string[]>; openTable(n: string): Promise<LanceTable> } };
    }

    private async versionTimestamps(table: LanceTable): Promise<number[]> {
        try {
            const versions = await table.listVersions();
            return versions.map((v) => {
                const t = v.timestamp instanceof Date ? v.timestamp.getTime() : Date.parse(String(v.timestamp));
                return Number.isFinite(t) ? t : 0;
            });
        } catch {
            return [];
        }
    }

    async probe(cleanupOlderThanMs: number, now: number): Promise<LanceTableProbe[]> {
        const conn = await this.connect();
        if (!conn) return [];
        const names = await conn.db.tableNames();
        const out: LanceTableProbe[] = [];
        const cutoff = now - cleanupOlderThanMs;
        for (const name of names) {
            const tableDir = path.join(this.lancedbDir, `${name}.lance`);
            let versions: number[] = [];
            try {
                const table = await conn.db.openTable(name);
                versions = await this.versionTimestamps(table);
            } catch { /* unreadable table — report what we can from disk */ }
            out.push({
                name,
                bytes: dirSizeBytes(tableDir),
                versions: versions.length,
                eligibleOldVersions: versions.filter((t) => t > 0 && t < cutoff).length,
                fragments: countFragments(tableDir),
            });
        }
        return out;
    }

    async optimizeTable(
        name: string,
        opts: { compact: boolean; cleanupOlderThanMs?: number; now: number },
    ): Promise<LanceTableResult> {
        const conn = await this.connect();
        if (!conn) throw new Error(`lancedb dir missing: ${this.lancedbDir}`);
        const tableDir = path.join(this.lancedbDir, `${name}.lance`);
        const beforeBytes = dirSizeBytes(tableDir);
        const table = await conn.db.openTable(name);
        const optOpts: { cleanupOlderThan?: Date } = {};
        if (opts.cleanupOlderThanMs !== undefined) {
            optOpts.cleanupOlderThan = new Date(opts.now - opts.cleanupOlderThanMs);
        }
        const stats = await retryOptimizeOnConflict(table, optOpts);
        const afterBytes = dirSizeBytes(tableDir);
        return {
            name,
            beforeBytes,
            afterBytes,
            bytesReclaimed: Math.max(0, beforeBytes - afterBytes),
            versionsRemoved: Number(stats?.prune?.oldVersionsRemoved ?? 0),
            fragmentsRemoved: Number(stats?.compaction?.fragmentsRemoved ?? 0),
            compacted: opts.compact,
        };
    }
}

interface OptimizeStats {
    compaction?: { fragmentsRemoved?: number; fragmentsAdded?: number };
    prune?: { oldVersionsRemoved?: number; bytesRemoved?: number };
}

interface LanceTable {
    listVersions(): Promise<Array<{ version: number; timestamp: Date | string }>>;
    optimize(opts?: { cleanupOlderThan?: Date }): Promise<OptimizeStats>;
    checkoutLatest(): Promise<void>;
}

/* ─── Node store ───────────────────────────────────────────────── */

/** Minimal graph surface the node-retention adapter needs. */
export interface GraphLike {
    listNodes(type?: string, tag?: string, project?: string, ecosystem?: string, limit?: number, opts?: { unbounded?: boolean }): Promise<Array<Record<string, unknown>>>;
    deleteNode(id: string): Promise<boolean>;
    // R5 #4 — serialized soft-archive (per-id write chain + read-cache epoch bump).
    archiveNode(id: string): Promise<void>;
    /**
     * P1 scale fix — optional keyset-pagination surface used by the paged
     * listAll(). Both real engines (LocalGraph, SurrealGraph) implement it;
     * anything else falls back to the unbounded listNodes scan.
     *
     * 2026-08-21: this used to be a required `getGraphContext()` — a raw Kùzu
     * Cypher runner — which made the bounded walk Kùzu-only: a Surreal-backed
     * workspace silently took the unbounded fallback. `bulkListProjected` is
     * the same walk as an engine-agnostic operation (same swap
     * diagnostics/consistency.ts made on 2026-08-06).
     */
    bulkListProjected?: NodePager;
}

/** Raw node-table columns the eviction-candidate selection reads (projected
 *  by whichever engine serves the paged walk). Deliberately
 *  excludes `content` — the selection ranker never touches it, and pulling it
 *  is what drove the full-table-into-heap OOM at ~1M nodes. */
const SELECTION_COLUMNS = [
    'tags', 'status', 'legalHold', 'createdAt', 'lastAccessedAt', 'last_retrieved_at',
] as const;

export class GraphNodeStore implements NodeStorePort {
    constructor(private readonly graph: GraphLike) {}

    async listAll(): Promise<NodeForSelection[]> {
        const out: NodeForSelection[] = [];
        const collect = (r: Record<string, unknown>): void => {
            out.push({
                id: String(r.id ?? ''),
                tags: r.tags,
                status: (r.status as string | null) ?? null,
                legalHold: (r.legalHold as boolean | null) ?? null,
                updatedAt: (r.updatedAt as string | null) ?? null,
                createdAt: (r.createdAt as string | null) ?? null,
                lastAccessedAt: (r.lastAccessedAt as string | null) ?? null,
                last_retrieved_at: (r.last_retrieved_at as string | null) ?? null,
            });
        };
        // P1 scale fix — page the walk in bounded keyset PAGES projecting only
        // the selection columns (no `content`). Peak transient heap is one page
        // of small rows, not the whole node table with full content. The
        // returned NodeForSelection[] is itself lightweight (id + tags + a few
        // timestamps), so accumulating all of it is fine — the fix targets the
        // full-content materialization, not the tiny result array.
        const pager = this.graph.bulkListProjected?.bind(this.graph);
        if (pager) {
            await forEachNodePage(
                pager, '*', SELECTION_COLUMNS, (rows) => {
                for (const r of rows) collect(r);
            });
        } else {
            const rows = await this.graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
            for (const r of rows) collect(r);
        }
        return out;
    }

    async archive(id: string): Promise<void> {
        // R5 #4 — route through LocalGraph.archiveNode so the archive SET runs
        // under the per-id nodeWriteChain (no TOCTOU clobber by a concurrent
        // upsertNode) AND bumps the read-cache epoch (recall stops surfacing the
        // node immediately). The raw getGraphContext().executeQuery path did
        // neither.
        await this.graph.archiveNode(id);
    }

    async delete(id: string): Promise<void> {
        await this.graph.deleteNode(id);
    }
}

/* ─── Workspace registry ───────────────────────────────────────── */

export class WorkspaceRegistry implements WorkspaceRegistryPort {
    // re-audit 2026-06-25 — optional graph registry so delete() can close a
    // cached open handle before removing the workspace's data dir. The in-process
    // (MCP-tool) path passes the live registry; the CLI path leaves it undefined
    // (no shared handles; DaemonSafety already refuses when the daemon is up).
    constructor(private readonly graphRegistry?: LocalGraphRegistry) {}

    list(): WorkspaceForSelection[] {
        return loadWorkspaces().workspaces.map((w) => ({ name: w.name, path: w.path, createdAt: w.createdAt }));
    }

    activeName(): string {
        return getActiveWorkspaceName();
    }

    bootstrapPath(): string {
        return loreHome();
    }

    async delete(name: string): Promise<{ bytesFreed: number }> {
        const entry = loadWorkspaces().workspaces.find((w) => w.name === name);
        if (!entry) throw new Error(`Unknown workspace "${name}"`);
        const bytesFreed = dirSizeBytes(entry.path);
        // re-audit 2026-06-25 — close any cached LocalGraph handle for this
        // workspace BEFORE deleting its data dir, so we don't rmSync the Kùzu/
        // LanceDB files out from under an open pool (corruption / errors on the
        // open handle). No-op when the registry isn't wired or the handle is
        // pinned/borrowed.
        // RA2-reaudit2 — refuse the destructive delete when a registry is wired
        // but the workspace's graph handle could NOT be closed (borrowed/aliased
        // /pinned). Pre-fix the rmSync below ran regardless, deleting the Kùzu/
        // LanceDB files out from under an open pool. closeWorkspace returns true
        // when there's no open handle or it closed cleanly.
        if (this.graphRegistry) {
            const safe = await this.graphRegistry.closeWorkspace(name);
            if (!safe) {
                throw new Error(`refusing to delete workspace "${name}": its graph handle is still open (borrowed/aliased) — retry once it drains`);
            }
        }
        // Registry removal (refuses active + bootstrap workspaces).
        deleteWorkspace(name);
        // Then remove the on-disk data — only when the path is safely under
        // the managed workspaces dir, never the Lore home itself.
        const workspacesDir = path.join(loreHome(), 'workspaces');
        const resolved = path.resolve(entry.path);
        if (resolved !== path.resolve(loreHome()) && resolved.startsWith(path.resolve(workspacesDir) + path.sep)) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
        return { bytesFreed };
    }
}

/* ─── Safety ───────────────────────────────────────────────────── */

/** CLI safety: a running daemon is a second writer — destructive ops refuse. */
export class DaemonSafety implements SafetyPort {
    async writeActive(): Promise<boolean> {
        return isDaemonUp();
    }
}

/** In-process safety (MCP tool / tests): this process IS the writer. */
export class AlwaysSafe implements SafetyPort {
    async writeActive(): Promise<boolean> {
        return false;
    }
}

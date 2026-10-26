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
import { probeSurrealLock } from '../surreal/surrealSettle.js';
import { deleteWorkspaceWithLifecycle } from '../workspaceErase/lifecycle.js';
import type { HandleSources } from '../workspaceErase/closeHandles.js';
import type {
    LanceMaintainerPort,
    LanceTableProbe,
    LanceTableResult,
    NodeStorePort,
    PendingSidelineInfo,
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

/**
 * QA round 3 (2026-09-03) — `fs.rmSync({recursive:true, force:true})` is not
 * transactional: `force` only swallows a missing-path error, not a
 * permission error hit partway through the recursive walk. If it deletes
 * several sibling files/dirs before reaching a protected one and throwing,
 * a workspace directory that is still REGISTERED ends up half-emptied on
 * disk — neither fully present nor fully gone. `WorkspaceRegistry.delete()`
 * below avoids this by renaming the whole directory aside to one of these
 * sideline paths in a single atomic `renameSync` *before* ever calling
 * `rmSync` on it: the registered path itself either still fully exists (the
 * rename never happened) or is completely gone (the rename succeeded), and
 * only the sideline copy — never the tracked path — can end up partially
 * deleted.
 */
const PENDING_DELETE_PREFIX = '.pending-delete-';

/**
 * Find ALL sideline directories left behind by previous `delete()` calls
 * whose `renameSync` succeeded but whose `rmSync` of the sideline copy then
 * failed, for one workspace name. Used so a later `maintain` pass retries
 * clearing the leftover bytes instead of trying (and failing) to rename an
 * already-vanished registered path all over again.
 *
 * QA round 4 (2026-09-03) — this used to be `Array.find` (first match
 * only): a name with TWO leftover sidelines (e.g. one crashed run plus a
 * later retry that also only partly cleared) had its first match rmSync'd
 * and the workspace deregistered immediately, permanently orphaning the
 * second sideline — nothing references that name in the registry anymore,
 * so no future `delete()` call for it can ever find or clean the
 * remainder. Every match must be cleared before deregistering.
 */
function findPendingSidelines(workspacesDir: string, name: string): string[] {
    let entries: string[];
    try { entries = fs.readdirSync(workspacesDir); } catch { return []; }
    const prefix = `${PENDING_DELETE_PREFIX}${name}-`;
    return entries.filter((e) => e.startsWith(prefix)).map((e) => path.join(workspacesDir, e));
}

/**
 * Scan `workspacesDir` for every `.pending-delete-*` sideline left behind by
 * a `delete()` whose final `rmSync` failed — regardless of which workspace
 * name they belong to. `lore maintain` surfaces these in its report so an
 * operator can see accumulating leftover bytes (round 4, finding 3); nothing
 * here deletes anything — cleanup only ever happens through `delete()`'s own
 * retry path above.
 */
export type { PendingSidelineInfo } from './ports.js';

export function listPendingSidelines(workspacesDir: string, now: number = Date.now()): PendingSidelineInfo[] {
    let entries: string[];
    try { entries = fs.readdirSync(workspacesDir); } catch { return []; }
    const results: PendingSidelineInfo[] = [];
    for (const dirName of entries) {
        if (!dirName.startsWith(PENDING_DELETE_PREFIX)) continue;
        // Shape: `.pending-delete-<name>-<timestampMs>-<rand>`. `name` itself
        // may contain hyphens, so peel the two KNOWN trailing segments
        // (rand, then timestamp) off the end instead of splitting on every
        // hyphen.
        const rest = dirName.slice(PENDING_DELETE_PREFIX.length);
        const lastDash = rest.lastIndexOf('-');
        const withoutRand = lastDash >= 0 ? rest.slice(0, lastDash) : rest;
        const secondLastDash = withoutRand.lastIndexOf('-');
        const tsPart = secondLastDash >= 0 ? withoutRand.slice(secondLastDash + 1) : '';
        const name = secondLastDash >= 0 ? withoutRand.slice(0, secondLastDash) : withoutRand;
        const ts = Number(tsPart);
        const ageMs = Number.isFinite(ts) && tsPart !== '' ? Math.max(0, now - ts) : -1;
        results.push({ name: name || dirName, dirName, ageMs, bytes: dirSizeBytes(path.join(workspacesDir, dirName)) });
    }
    return results;
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

    /** Defect 3 (3.20.2) — the report needs to name the dir it actually probed, so a
     *  caller can tell whether a maintenance pass targeted the store it expected. */
    dir(): string {
        return this.lancedbDir;
    }

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
     * 2026-08-21: this used to be a required `getGraphContext()` — a raw Cypher
     * runner — which made the bounded walk single-engine-only: a Surreal-backed
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
    //
    // Defect 3 (3.20.2) — `home` is the registry root this instance reads/writes
    // (formerly hardcoded to the process-wide `loreHome()` everywhere in this
    // class). Defaulting the param to `loreHome()` keeps every existing
    // zero/one-arg call site (CLI, other tests) behaving exactly as before;
    // an embedded host now passes its OWN `dataHome` so a maintenance pass
    // never reads or bootstraps a registry outside the instance it targets.
    constructor(private readonly graphRegistry?: LocalGraphRegistry, private readonly home: string = loreHome(), private readonly extraHandles: Omit<HandleSources, 'graphRegistry'> = {}) {}

    list(): WorkspaceForSelection[] {
        return loadWorkspaces(this.home).workspaces.map((w) => ({ name: w.name, path: w.path, createdAt: w.createdAt }));
    }

    activeName(): string {
        return getActiveWorkspaceName(this.home);
    }

    bootstrapPath(): string {
        return this.home;
    }

    /** QA round 4, finding 3 — surface leftover `.pending-delete-*` sidelines to `lore maintain`'s report. */
    pendingSidelines(): PendingSidelineInfo[] {
        return listPendingSidelines(path.join(this.home, 'workspaces'));
    }

    async delete(name: string): Promise<{ bytesFreed: number }> {
        const entry = loadWorkspaces(this.home).workspaces.find((w) => w.name === name);
        if (!entry) throw new Error(`Unknown workspace "${name}"`);
        const workspacesDir = path.join(this.home, 'workspaces');
        const resolved = path.resolve(entry.path);
        const underManagedDir = resolved !== path.resolve(this.home)
            && resolved.startsWith(path.resolve(workspacesDir) + path.sep);

        // QA round 3 retry path — a previous delete() call already renamed
        // the registered directory aside atomically and only the rmSync of
        // that sideline copy failed (e.g. a permission-protected file
        // partway through the recursive walk). The registered path is
        // already gone, so re-running the graph-handle/lock preflight and
        // rename below would just throw ENOENT on a vanished source. Retry
        // clearing the leftover sideline(s) directly instead.
        //
        // QA round 4, finding 2 — a name can have MORE THAN ONE leftover
        // sideline (e.g. an old crashed run's copy plus a later retry that
        // also only partly cleared). Clearing just the first match and then
        // deregistering orphaned every other one forever, since nothing
        // references the name in the registry any more to trigger a future
        // retry. Every match for this name must be cleared before the
        // workspace is deregistered; if any one of them still fails, the
        // registry entry is kept so a later pass retries the remainder.
        const existingSidelines = underManagedDir && !fs.existsSync(resolved)
            ? findPendingSidelines(workspacesDir, name)
            : [];
        if (existingSidelines.length > 0) {
            let bytesFreed = 0;
            const stillRemaining: string[] = [];
            for (const sideline of existingSidelines) {
                bytesFreed += dirSizeBytes(sideline);
                try {
                    fs.rmSync(sideline, { recursive: true, force: true });
                } catch (err) {
                    stillRemaining.push(`${sideline} (${(err as Error).message})`);
                }
            }
            if (stillRemaining.length > 0) {
                throw new Error(`workspace "${name}" cleanup is still incomplete — partial data remains at ${stillRemaining.join('; ')} for a later maintain pass to retry`);
            }
            deleteWorkspace(name, this.home);
            return { bytesFreed };
        }

        // CLI path (no live registry to close a cached handle through): the daemon preflight in
        // cli/commands/maintain.ts is a single isDaemonUp() check for the whole command — store-agnostic, and
        // blind to a daemon on a non-default port with LORE_PORT unset. Probe THIS workspace's own graph store
        // lock directly before anything is moved: a locked store means something else is still writing to the
        // directory we are about to delete out from under it. (With a registry wired, the lifecycle closes the
        // cached handles itself and refuses if they cannot be closed.)
        if (!this.graphRegistry) {
            const lock = await probeSurrealLock(entry.path);
            if (!lock.free) {
                throw new Error(`refusing to delete workspace "${name}": its graph store is locked by another process (${lock.detail}) — retry once it is released`);
            }
        }

        // Lane f6b — expiry erases at once (window 0) through the SAME path as every other delete: close handles,
        // atomically move the data aside to the hidden holding folder (symlink / mount-point / not-a-directory
        // refusals live in workspaceErase/localDir.ts, extracted from this method), write the durable deletion
        // record, drop the registry entry (refuses active + bootstrap), then run the erasers and write the receipt.
        // A partial erase no longer keeps the registry entry: the workspace is already hidden and the scheduled
        // erase retries the remainder (the old `.pending-delete-*` sidelines above are still retried here).
        const out = await deleteWorkspaceWithLifecycle(name, { eraseNow: true }, {
            home: this.home,
            handles: { ...this.extraHandles, graphRegistry: this.graphRegistry ?? null },
        });
        if (out.status === 'not-scheduled') return { bytesFreed: 0 };
        const local = out.erase && 'receipt' in out.erase ? out.erase.receipt.stores.find((s) => s.store === 'local-dir') : undefined;
        // Lane f6c: other stores (Postgres rows keyed by name, uploaded files) can leave the receipt `partial` while the local
        // folder is already gone; that is not a directory-removal failure, and the scheduled erase keeps retrying the rest.
        const localGone = local !== undefined && (local.status === 'complete' || local.status === 'not-applicable');
        if (out.status !== 'erased' && !localGone) {
            throw new Error(`workspace "${name}" directory removal is incomplete — it is hidden and its remaining data is held at ${out.holdingPath ?? 'its folder'} for the scheduled erase to retry${out.note ? ` (${out.note})` : ''}`);
        }
        return { bytesFreed: local?.removed['bytes'] ?? 0 };
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

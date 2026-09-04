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

function pendingDeleteSidelinePath(workspacesDir: string, name: string): string {
    return path.join(workspacesDir, `${PENDING_DELETE_PREFIX}${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

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

    /** QA round 4, finding 3 — surface leftover `.pending-delete-*` sidelines to `lore maintain`'s report. */
    pendingSidelines(): PendingSidelineInfo[] {
        return listPendingSidelines(path.join(loreHome(), 'workspaces'));
    }

    async delete(name: string): Promise<{ bytesFreed: number }> {
        const entry = loadWorkspaces().workspaces.find((w) => w.name === name);
        if (!entry) throw new Error(`Unknown workspace "${name}"`);
        const workspacesDir = path.join(loreHome(), 'workspaces');
        const resolved = path.resolve(entry.path);
        const underManagedDir = resolved !== path.resolve(loreHome())
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
            deleteWorkspace(name);
            return { bytesFreed };
        }

        // QA round 4, finding 1 — a workspace directory that is ITSELF a
        // symlink, or a mount point (a separate filesystem grafted onto the
        // registered path), must never reach the renameSync below.
        // `fs.renameSync` on a symlink renames the LINK, not its target —
        // the sideline would then be a symlink pointing at data that is
        // never touched, verified, or freed, while the workspace is
        // reported deleted and the real data is silently orphaned. A mount
        // point renames "fine" on macOS (it moves the mount), after which
        // the immediately-following `rmSync` destroys the MOUNTED VOLUME'S
        // CONTENTS wholesale, and the sideline (now itself a mount point)
        // can never be fully removed — `rmSync`'s final `rmdir` throws
        // EBUSY forever, leaking a stray un-retryable sideline. Detect both
        // with `lstatSync` (never follows the link) and a device-id
        // comparison against the parent (`workspacesDir`) BEFORE ever
        // calling `renameSync`, and refuse outright rather than attempting
        // either.
        if (underManagedDir) {
            let liveStat: fs.Stats;
            try {
                liveStat = fs.lstatSync(resolved);
            } catch (err) {
                throw new Error(`refusing to delete workspace "${name}": could not stat its directory (${(err as Error).message})`);
            }
            if (liveStat.isSymbolicLink()) {
                throw new Error(`refusing to delete workspace "${name}": its registered path (${resolved}) is a symlink — refusing to rename or follow it into a sideline (the real target would be silently orphaned); fix the registry entry or remove the symlink by hand`);
            }
            if (!liveStat.isDirectory()) {
                throw new Error(`refusing to delete workspace "${name}": its registered path (${resolved}) is not a directory`);
            }
            let parentStat: fs.Stats;
            try {
                parentStat = fs.statSync(workspacesDir);
            } catch (err) {
                throw new Error(`refusing to delete workspace "${name}": could not stat the workspaces directory (${(err as Error).message})`);
            }
            if (liveStat.dev !== parentStat.dev) {
                throw new Error(`refusing to delete workspace "${name}": its directory (${resolved}) is a mount point — a separate filesystem grafted onto the workspaces dir (device ${liveStat.dev} vs parent device ${parentStat.dev}). Renaming it aside would move the mount itself and a subsequent cleanup pass would destroy the mounted volume's contents. Unmount it first, then retry.`);
            }
        }

        const bytesFreed = dirSizeBytes(entry.path);
        // re-audit 2026-06-25 — close any cached LocalGraph handle for this
        // workspace BEFORE deleting its data dir, so we don't rmSync the graph store/
        // LanceDB files out from under an open pool (corruption / errors on the
        // open handle). No-op when the registry isn't wired or the handle is
        // pinned/borrowed.
        // RA2-reaudit2 — refuse the destructive delete when a registry is wired
        // but the workspace's graph handle could NOT be closed (borrowed/aliased
        // /pinned). Pre-fix the rmSync below ran regardless, deleting the graph store/
        // LanceDB files out from under an open pool. closeWorkspace returns true
        // when there's no open handle or it closed cleanly.
        if (this.graphRegistry) {
            const safe = await this.graphRegistry.closeWorkspace(name);
            if (!safe) {
                throw new Error(`refusing to delete workspace "${name}": its graph handle is still open (borrowed/aliased) — retry once it drains`);
            }
        } else {
            // CLI path: no live registry to close a cached handle through, and
            // the daemon preflight in cli/commands/maintain.ts is a single
            // isDaemonUp() check for the whole command — store-agnostic, and
            // blind to a daemon on a non-default port with LORE_PORT unset.
            // Probe THIS workspace's own graph store lock directly before the
            // destructive rmSync below: a locked store means something else is
            // still writing to the directory we are about to delete out from
            // under it.
            const lock = await probeSurrealLock(entry.path);
            if (!lock.free) {
                throw new Error(`refusing to delete workspace "${name}": its graph store is locked by another process (${lock.detail}) — retry once it is released`);
            }
        }
        // Remove the on-disk data BEFORE the registry entry — only when the
        // path is safely under the managed workspaces dir, never the Lore
        // home itself.
        //
        // QA round 2 (2026-09-03): this used to call `deleteWorkspace(name)`
        // FIRST and `fs.rmSync` after. `rmSync` can throw (e.g. a store
        // directory made unreadable by a permissions problem, or anything
        // else under it that resists removal), and when it did, the registry
        // had already forgotten the workspace while its data — including a
        // never-verified graph store — was still sitting on disk: orphaned,
        // untracked, and never cleaned up because nothing points at it
        // anymore. Physical delete now runs first; the registry entry is
        // only removed once it actually succeeds, so a failed delete leaves
        // the workspace exactly as it was (registered, on disk) rather than
        // half gone.
        //
        // QA round 3 (2026-09-03): rmSync-ing `resolved` directly is not
        // enough — `rmSync({recursive:true, force:true})` is not
        // transactional, so a permission failure partway through the
        // recursive walk (some siblings removed, one protected subdirectory
        // still there and throwing) left the REGISTERED path itself
        // half-emptied, contradicting "exactly as it was". Rename the whole
        // directory aside to a sideline path in one atomic step first: if
        // that rename fails, nothing moved and nothing deleted, so the
        // registered path is untouched; once it succeeds, the registered
        // path is unconditionally gone (never half-emptied) and only the
        // sideline copy can end up partially deleted by the rmSync that
        // follows.
        if (underManagedDir) {
            const sideline = pendingDeleteSidelinePath(workspacesDir, name);
            try {
                fs.renameSync(resolved, sideline);
            } catch (err) {
                throw new Error(`refusing to delete workspace "${name}": could not stage its directory for removal (${(err as Error).message})`);
            }
            try {
                fs.rmSync(sideline, { recursive: true, force: true });
            } catch (err) {
                // The registered path is already gone (the rename above
                // succeeded and moved it wholesale) but the sideline copy
                // didn't fully clear — e.g. the same permission-protected
                // subdirectory that used to corrupt the registered path
                // directly. Keep the registry entry so a later maintain
                // pass's delete() call finds this leftover sideline (via
                // findPendingSidelines above) and retries clearing it,
                // instead of losing track of the remaining bytes.
                throw new Error(`workspace "${name}" directory removal is incomplete — partial data remains at ${sideline} for a later maintain pass to retry (${(err as Error).message})`);
            }
        }
        // Registry removal (refuses active + bootstrap workspaces) — only
        // reached once the physical delete above did not throw.
        deleteWorkspace(name);
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

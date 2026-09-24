/**
 * migrateGraphToSqlite.ts — `lore migrate-graph <workspace> --to sqlite`
 * (3.21 step 1e, design doc's "Migration" section).
 *
 * Offline, single-workspace engine migration: Surreal → SQLite, in this
 * fixed order, each step a precondition for the next:
 *
 *   1. Daemon preflight — refuse if a live daemon serves this home (same
 *      `isDaemonServingHome` gate every other CLI-vs-daemon command uses).
 *   2. Backup the workspace (`backupWorkspace`) BEFORE touching anything.
 *   3. Open the Surreal source read-only-in-practice (no writes issued) and
 *      stream EVERY node — including superseded, archived, ephemeral and
 *      stale ones; `listNodes(..., { unbounded: true })` has no status
 *      filter, so this is already "every row" — and every edge (paginated
 *      `queryEdges` walked to exhaustion).
 *   4. Write through `SqliteGraph.importRaw` (internal, not part of
 *      `LoreGraphHandle`), which preserves `createdAt`/`updatedAt` exactly
 *      and does NOT restamp — so a canonical-JSON digest of the two
 *      engines' data can be compared byte-for-byte, no rank-normalization.
 *   5. Verify: node/edge counts equal, a canonicalized+sorted-JSON digest
 *      of ALL nodes and edges equal, and a handful of live read probes
 *      (getStats, search, traverse) equal.
 *   6. ONLY THEN flip `graphEngine` to `'sqlite'` — one atomic
 *      `workspaces.json` write (`setWorkspaceGraphEngine`). Every step
 *      before this one can fail, throw, or be interrupted (including a
 *      hard crash) without changing which store any reader opens: the
 *      registry still says `'surreal'` until this single write lands, and
 *      the Surreal store was never modified or removed. That ordering IS
 *      the crash-safety property — there is no separate rollback-journal to
 *      maintain.
 *
 * The Surreal directory is deliberately left in place — it is the rollback
 * path. `rollbackGraphMigration` flips `graphEngine` back to `'surreal'`;
 * it does not delete `graph.sqlite` (never destroy data an operator command
 * touched, even a stale copy).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspacePath, setWorkspaceGraphEngine } from '../config/workspaces.js';
import { loreHome } from '../config/loreHome.js';
import { resolveWorkspaceGraphEngine, legacyGraphEngineRemovedError } from './graphEngineSelector.js';
import { isDaemonServingHome, daemonRefuseMessage } from '../cli/commands/migrateWorkspaceToWorkspaceShared.js';
import { backupWorkspace, type BackupResult } from './backup.js';
import { SurrealGraph } from './surrealGraph.js';
import { SqliteGraph } from './sqliteGraph.js';
import type { LoreEdge, LoreNode } from '../providers/types.js';

export interface MigrateGraphToSqliteOptions {
    workspaceName: string;
    home?: string;
    /** Directory the pre-migration backup tarball is written into. Must exist. */
    backupOutDir: string;
    /** Bypass the daemon preflight (tests only). */
    force?: boolean;
    /**
     * TEST-ONLY crash injection: `process.exit(137)` (the conventional
     * SIGKILL exit code) immediately after every verification step
     * succeeds, but BEFORE the atomic `setWorkspaceGraphEngine` flip. Used
     * from a CHILD PROCESS by the crash-safety test to prove — via a real
     * process exit, not a caught exception in the same process — that
     * `graphEngine` is provably unchanged and the Surreal store provably
     * intact when the process dies at the latest possible instant before
     * the flip. Never set outside a test.
     */
    simulateCrashBeforeFlip?: boolean;
}

export interface MigrateGraphToSqliteReport {
    workspaceName: string;
    backup: BackupResult;
    nodeCount: number;
    edgeCount: number;
    digestMatched: boolean;
    readProbesMatched: boolean;
    readProbeDetails: string[];
    durationMs: number;
}

export class MigrationVerificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MigrationVerificationError';
    }
}

const EDGE_PAGE_LIMIT = 1000;

/** Walk `queryEdges` to exhaustion — same pagination discipline `graph-engine-parity-unit.ts` uses. */
async function readAllEdges(g: { queryEdges: SurrealGraph['queryEdges'] }): Promise<LoreEdge[]> {
    const out: LoreEdge[] = [];
    let offset = 0;
    for (;;) {
        const page = await g.queryEdges({ limit: EDGE_PAGE_LIMIT, offset });
        if (page.length === 0) break;
        out.push(...page);
        offset += EDGE_PAGE_LIMIT;
    }
    return out;
}

/** Sort object keys recursively — row field order is not a contracted part of either engine (see graph-engine-parity-unit.ts note 2). */
function canonicalStringify(value: unknown): string {
    const sortKeys = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sortKeys);
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(v as Record<string, unknown>).sort()) {
                out[k] = sortKeys((v as Record<string, unknown>)[k]);
            }
            return out;
        }
        return v;
    };
    return JSON.stringify(sortKeys(value));
}

/** Canonical digest of every node + edge: sorted by a stable key, then key-order-normalized JSON. Timestamps are NOT normalized — importRaw preserves them exactly, so they must match byte-for-byte. */
function digestOf(nodes: LoreNode[], edges: LoreEdge[]): string {
    const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    const sortedEdges = [...edges].sort((a, b) =>
        `${a.sourceId}|${a.targetId}|${a.relation}`.localeCompare(`${b.sourceId}|${b.targetId}|${b.relation}`));
    return canonicalStringify({ nodes: sortedNodes, edges: sortedEdges });
}

export async function migrateGraphToSqlite(opts: MigrateGraphToSqliteOptions): Promise<MigrateGraphToSqliteReport> {
    const startedAt = Date.now();
    const home = opts.home ?? loreHome();
    const workspaceDir = getWorkspacePath(opts.workspaceName, home);

    const currentEngine = resolveWorkspaceGraphEngine(opts.workspaceName, home);
    if (currentEngine === 'kuzu') {
        legacyGraphEngineRemovedError(opts.workspaceName, 'migrateGraphToSqlite');
    }
    if (currentEngine === 'sqlite') {
        throw new Error(
            `migrate-graph: workspace '${opts.workspaceName}' is already registered as 'sqlite'. `
            + 'Nothing to migrate.',
        );
    }

    // ── 1. Daemon preflight ─────────────────────────────────────────────
    if (!opts.force) {
        const probe = await isDaemonServingHome(home);
        if (probe.servesHome) {
            throw new Error(daemonRefuseMessage('lore migrate-graph'));
        }
    }

    // ── 2. Backup FIRST ──────────────────────────────────────────────────
    const backup = await backupWorkspace({
        workspaceDir,
        workspaceName: opts.workspaceName,
        outDir: opts.backupOutDir,
    });

    // ── 3. Stream every node + edge from the Surreal source ────────────
    const source = new SurrealGraph(workspaceDir, { workspaceId: opts.workspaceName, cacheDisabled: true });
    await source.initialize();
    let nodes: LoreNode[];
    let edges: LoreEdge[];
    let sourceStats: Awaited<ReturnType<SurrealGraph['getStats']>>;
    try {
        nodes = await source.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
        edges = await readAllEdges(source);
        sourceStats = await source.getStats();
    } finally {
        await source.close();
    }

    // ── 4. Write through importRaw (preserves timestamps, no restamp) ──
    const dest = new SqliteGraph(workspaceDir, { workspaceId: opts.workspaceName, cacheDisabled: true });
    await dest.initialize();
    let report: MigrateGraphToSqliteReport;
    try {
        await dest.importRaw(nodes, edges);

        // ── 5. Verify ────────────────────────────────────────────────────
        const destStats = await dest.getStats();
        if (destStats.nodeCount !== sourceStats.nodeCount || destStats.edgeCount !== sourceStats.edgeCount) {
            throw new MigrationVerificationError(
                `migrate-graph verification failed: counts disagree — source ${sourceStats.nodeCount}n/`
                + `${sourceStats.edgeCount}e, sqlite ${destStats.nodeCount}n/${destStats.edgeCount}e. `
                + `The workspace's graphEngine is UNCHANGED (still '${currentEngine}') and the source `
                + `store was not modified — a backup was also taken at ${backup.tarballPath}.`,
            );
        }

        const destNodes = await dest.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
        const destEdges = await readAllEdges(dest);
        const sourceDigest = digestOf(nodes, edges);
        const destDigest = digestOf(destNodes, destEdges);
        const digestMatched = sourceDigest === destDigest;
        if (!digestMatched) {
            throw new MigrationVerificationError(
                `migrate-graph verification failed: the canonicalized node+edge digest disagrees between `
                + `the Surreal source and the migrated SQLite copy, even though counts matched. `
                + `The workspace's graphEngine is UNCHANGED (still '${currentEngine}') and the source `
                + `store was not modified — a backup was also taken at ${backup.tarballPath}.`,
            );
        }

        // Read probes — live query operations agree, not just raw storage.
        const readProbeDetails: string[] = [];
        let readProbesMatched = true;
        {
            const reSource = new SurrealGraph(workspaceDir, { workspaceId: opts.workspaceName, cacheDisabled: true });
            await reSource.initialize();
            try {
                if (nodes.length > 0) {
                    const sample = nodes[0]!;
                    const term = sample.label.split(/\s+/)[0] || sample.id;
                    const [srchSrc, srchDst] = await Promise.all([
                        reSource.search(term, 20, '*', '*', false),
                        dest.search(term, 20, '*', '*', false),
                    ]);
                    const same = canonicalStringify(srchSrc.map((n) => n.id).sort())
                        === canonicalStringify(srchDst.map((n) => n.id).sort());
                    readProbeDetails.push(`search("${term}"): ${same ? 'match' : 'MISMATCH'}`);
                    if (!same) readProbesMatched = false;
                }
                if (edges.length > 0) {
                    const seed = edges[0]!.sourceId;
                    const [travSrc, travDst] = await Promise.all([
                        reSource.traverse(seed, 2),
                        dest.traverse(seed, 2),
                    ]);
                    const norm = (rs: Array<{ node: { id: string }; depth: number; relation: string }>) =>
                        canonicalStringify(rs.map((r) => ({ id: r.node.id, depth: r.depth, relation: r.relation })));
                    const same = norm(travSrc) === norm(travDst);
                    readProbeDetails.push(`traverse(${seed}): ${same ? 'match' : 'MISMATCH'}`);
                    if (!same) readProbesMatched = false;
                }
            } finally {
                await reSource.close();
            }
        }
        if (!readProbesMatched) {
            throw new MigrationVerificationError(
                `migrate-graph verification failed: read-probe disagreement — ${readProbeDetails.join('; ')}. `
                + `The workspace's graphEngine is UNCHANGED (still '${currentEngine}') and the source `
                + `store was not modified — a backup was also taken at ${backup.tarballPath}.`,
            );
        }

        report = {
            workspaceName: opts.workspaceName,
            backup,
            nodeCount: destStats.nodeCount,
            edgeCount: destStats.edgeCount,
            digestMatched,
            readProbesMatched,
            readProbeDetails,
            durationMs: Date.now() - startedAt,
        };
    } finally {
        await dest.close();
    }

    if (opts.simulateCrashBeforeFlip) {
        process.exit(137);
    }

    // ── 6. Atomic flip — the ONLY step that changes which store is live ─
    setWorkspaceGraphEngine(opts.workspaceName, 'sqlite', home);

    return report;
}

export interface RollbackGraphMigrationOptions {
    workspaceName: string;
    home?: string;
    force?: boolean;
}

/**
 * rollbackGraphMigration — flip `graphEngine` back to `'surreal'`. Data is
 * untouched on both sides: the Surreal store was never modified by
 * `migrateGraphToSqlite`, and `graph.sqlite` is left in place (not deleted)
 * rather than risk destroying a copy an operator might still want.
 */
export async function rollbackGraphMigration(opts: RollbackGraphMigrationOptions): Promise<{ workspaceName: string; revertedTo: 'surreal' }> {
    const home = opts.home ?? loreHome();
    const currentEngine = resolveWorkspaceGraphEngine(opts.workspaceName, home);
    if (currentEngine !== 'sqlite') {
        throw new Error(
            `migrate-graph --rollback: workspace '${opts.workspaceName}' is registered as '${currentEngine}', `
            + `not 'sqlite'. Nothing to roll back.`,
        );
    }
    if (!opts.force) {
        const probe = await isDaemonServingHome(home);
        if (probe.servesHome) {
            throw new Error(daemonRefuseMessage('lore migrate-graph --rollback'));
        }
    }
    const workspaceDir = getWorkspacePath(opts.workspaceName, home);
    if (!fs.existsSync(path.join(workspaceDir, '.lore', 'surreal')) && !fs.existsSync(workspaceDir)) {
        throw new Error(
            `migrate-graph --rollback: no Surreal store found at ${workspaceDir} — cannot roll back to an `
            + 'engine whose data is not there.',
        );
    }
    setWorkspaceGraphEngine(opts.workspaceName, 'surreal', home);
    return { workspaceName: opts.workspaceName, revertedTo: 'surreal' };
}

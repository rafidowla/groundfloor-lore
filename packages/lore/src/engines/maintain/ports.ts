/**
 * ports.ts — Dependency interfaces for the maintain orchestrator.
 *
 * The orchestrator (maintain.ts) depends ONLY on these narrow ports, not
 * on LanceDB / Kùzu / the workspaces module directly. Real adapters live
 * in adapters.ts; tests inject fakes. This is what makes "dry-run does
 * zero writes" and "per-table error isolation" testable without a live
 * store.
 */

import type { NodeForSelection, WorkspaceForSelection } from './selection.js';

/** Per-table stats from a LanceDB optimize/cleanup pass (or dry-run probe). */
export interface LanceTableProbe {
    name: string;
    /** On-disk bytes for the table directory. */
    bytes: number;
    /** Total versions retained. */
    versions: number;
    /** Versions older than the cleanup cutoff (eligible for removal). */
    eligibleOldVersions: number;
    /** Data-file count, used against compact_fragment_threshold. */
    fragments: number;
}

export interface LanceTableResult {
    name: string;
    beforeBytes: number;
    afterBytes: number;
    /** Net on-disk bytes reclaimed (before − after). */
    bytesReclaimed: number;
    /** Authoritative version count pruned (from OptimizeStats.prune). */
    versionsRemoved: number;
    /** Authoritative fragments compacted away (from OptimizeStats.compaction). */
    fragmentsRemoved: number;
    /** Whether compaction was intended (threshold met). NB: the LanceDB
     *  high-level optimize() ALWAYS compacts, so compaction also occurs as
     *  a side effect whenever version cleanup runs. */
    compacted: boolean;
    error?: string;
}

/** LanceDB maintenance port — one workspace's `.lore/lancedb` directory. */
export interface LanceMaintainerPort {
    /** List tables with the stats needed for planning (read-only). */
    probe(cleanupOlderThanMs: number, now: number): Promise<LanceTableProbe[]>;
    /**
     * Optimize a single table: compact fragments and/or prune old
     * versions. Implementations MUST isolate failures to the one table
     * (throwing is fine — the orchestrator try/catches per table).
     */
    optimizeTable(
        name: string,
        opts: { compact: boolean; cleanupOlderThanMs?: number; now: number },
    ): Promise<LanceTableResult>;
}

/** Node retention port — backed by the graph store. */
export interface NodeStorePort {
    /** All nodes (unbounded) with the fields selection.ts needs. */
    listAll(): Promise<NodeForSelection[]>;
    /** Soft-archive a node (set status=archived, keep structure). */
    archive(id: string): Promise<void>;
    /** Hard-delete a node and its edges. */
    delete(id: string): Promise<void>;
}

/** Workspace registry port — list + delete ephemeral workspaces. */
export interface WorkspaceRegistryPort {
    list(): WorkspaceForSelection[];
    activeName(): string;
    bootstrapPath(): string;
    /** Remove from the registry AND delete the on-disk data dir. Async: closes
     *  any cached graph handle before deleting the dir (re-audit 2026-06-25). */
    delete(name: string): Promise<{ bytesFreed: number }>;
}

/**
 * Safety port — decides whether destructive ops may run right now.
 *
 * CLI usage: returns writeActive=true when the daemon is up (a second
 * writer), so destructive ops are refused unless the operator passes
 * --online. MCP usage: the tool runs INSIDE the daemon (it IS the
 * writer), so writeActive=false and ops are online-safe by construction.
 */
export interface SafetyPort {
    writeActive(): Promise<boolean>;
}

export interface MaintainPorts {
    lance?: LanceMaintainerPort;
    nodes?: NodeStorePort;
    workspaces?: WorkspaceRegistryPort;
    safety: SafetyPort;
}

/**
 * openWorkspaceGraph.ts — open the graph engine a workspace actually declares.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Twenty-four CLI commands opened the graph with `new LocalGraph(basePath)`.
 * That hardcoded the prior local graph engine, so on a workspace whose
 * `graphEngine` is `'surreal'` every one of them read that engine's database
 * — which on such a workspace exists and is EMPTY. They did not fail. They
 * returned nothing and reported success:
 * `lore status` shows zero nodes, `lore export` writes an empty file,
 * `lore recall` finds nothing. A silent wrong answer, on the command line, for
 * a workspace that is working perfectly.
 *
 * `LocalGraphRegistry.getGraphHandle()` is the daemon's engine-honouring
 * accessor, but the registry is workspace-name-and-home shaped while CLI
 * commands are basePath-shaped, so nothing was shared. This is the same
 * decision in the shape the CLI actually has.
 *
 * ── ENGINE RESOLUTION ───────────────────────────────────────────────────────
 *
 * `workspaceId` when the caller knows it; otherwise the workspace is found by
 * matching `basePath` against `workspaces.json`. A path that matches no
 * registered workspace — a temp directory in a test, a bare `--path` — falls
 * back to `DEFAULT_GRAPH_ENGINE`, which is what such a caller got before this
 * module existed.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It returns a `WorkspaceGraph`, not a `LocalGraph`. The type names exactly the
 * surface BOTH local engines implement, so a caller that compiles against it
 * runs unchanged on either. The three genuinely engine-specific primitives — raw
 * Cypher via `getGraphContext`, `getTableStorage`, `withBulkConnection` — are
 * deliberately absent: table storage is SQLite keyed on a path
 * (`createTableStorage`), and every operation that used to need raw Cypher now
 * has a named method on both engines. Narrowing the return type is what keeps
 * that boundary visible to the compiler instead of to a grep.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SurrealGraph } from './surrealGraph.js';
import { surrealDataPath } from './surreal/surrealConnection.js';
import {
    DEFAULT_GRAPH_ENGINE,
    resolveWorkspaceGraphEngine,
    legacyGraphEngineRemovedError,
    type GraphEngineKind,
} from './graphEngineSelector.js';
import { loadWorkspaces } from '../config/workspaces.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';
import type { EdgeQuery, LoreEdge, LoreNode } from '../providers/types.js';
/**
 * The graph surface a CLI command may use: everything BOTH local engines
 * implement. Anything beyond this is engine-specific and does not belong in a
 * caller that is supposed to run on either.
 *
 * The two `openWorkspaceGraph` return statements assert against this type
 * DIRECTLY (no `as unknown` laundering), so adding a member here is checked
 * against both `LocalGraph` and `SurrealGraph` at compile time — a member only
 * one engine has will not build.
 */
export type WorkspaceGraph = LoreGraphHandle & {
    initialize(): Promise<void>;
    close(): Promise<void>;
    /**
     * Cursor-paginated node enumeration. Both engines implement it; it is not
     * on `LoreGraphHandle` because `DataplaneGraph` does not.
     */
    bulkList(q: { limit: number; cursor?: { updatedAt: string; id: string } | null }): Promise<{
        nodes: Array<Record<string, unknown>>;
        hasMore: boolean;
        nextCursor: { updatedAt: string; id: string } | null;
    }>;
    /** Keyset-paged projected node scan — `graphBulkList.NodePager`. */
    bulkListProjected(
        project: string,
        columns: readonly string[],
        limit: number,
        cursor: { updatedAt: string; id: string } | null,
    ): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: { updatedAt: string; id: string } | null }>;
    /** Batched node write. Both local engines implement it; `DataplaneGraph`
     *  does not, which is why it lives here and not on `LoreGraphHandle`. */
    bulkUpsertNodes(
        batch: Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
    ): Promise<Array<{ id: string; ok: boolean; error?: string }>>;
    /** Paginated edge query — the `GET /api/edges` contract. */
    queryEdges(q: EdgeQuery): Promise<LoreEdge[]>;
    /** Structural warnings about the graph, one human-readable line each. */
    lintGraph(): Promise<string[]>;
    /** Reverse supersession lookup: every node superseded BY `byId`, ordered
     *  by id (a merge has several). Both local engines implement it;
     *  `DataplaneGraph` has no supersededBy index. */
    findSupersededByPredecessors(byId: string): Promise<string[]>;
};

export interface OpenWorkspaceGraphOpts {
    /** Workspace name, when the caller already resolved one. */
    workspaceId?: string;
    /** LORE_HOME override, for tests. */
    home?: string;
    cacheTtlMs?: number;
    cacheMaxSize?: number;
    cacheDisabled?: boolean;
}

/**
 * Which engine backs `basePath`.
 *
 * Exported because the four raw-Cypher commands need to ASK before they build a
 * `LocalGraph`, and asking is the whole of their guard.
 */
export function resolveGraphEngineForPath(
    basePath: string,
    opts: { workspaceId?: string; home?: string } = {},
): { engine: GraphEngineKind; workspace: string | null } {
    if (opts.workspaceId) {
        return {
            engine: resolveWorkspaceGraphEngine(opts.workspaceId, opts.home),
            workspace: opts.workspaceId,
        };
    }
    try {
        const file = loadWorkspaces(opts.home);
        // Compare resolved paths: workspaces.json may hold `~`-relative or
        // differently-normalised strings than the caller computed.
        const match = file.workspaces.find((w) => samePath(w.path, basePath));
        if (match) {
            return {
                engine: resolveWorkspaceGraphEngine(match.name, opts.home),
                workspace: match.name,
            };
        }
    } catch {
        // An unreadable/absent workspaces.json is normal for a bare path — fall
        // through to the default rather than failing an unrelated command.
    }
    return { engine: DEFAULT_GRAPH_ENGINE, workspace: null };
}

function samePath(a: string, b: string): boolean {
    const norm = (p: string): string => p.replace(/\/+$/, '');
    return norm(a) === norm(b);
}

/**
 * Open (but do NOT initialize) the graph engine this workspace declares.
 *
 * Not initialized here on purpose: several callers construct a graph and then
 * decide not to use it, and `initialize()` on a cold workspace creates
 * directories. Keeping construction free of side effects preserves what
 * `new LocalGraph(...)` did.
 */
export function openWorkspaceGraph(
    basePath: string,
    opts: OpenWorkspaceGraphOpts = {},
): WorkspaceGraph {
    const { engine, workspace } = resolveGraphEngineForPath(basePath, opts);
    const workspaceId = opts.workspaceId ?? workspace ?? undefined;

    if (engine === 'kuzu') {
        // LOUD, not silent: falling back to SurrealDB here would hand the
        // caller an empty store while the workspace's real data sits in
        // .lore/graph — every read "finds nothing", every write lands in the
        // wrong database, both report success. A legacy graph engine
        // declaration is no longer supported — same refusal as
        // LocalGraphRegistry.getGraphHandle.
        legacyGraphEngineRemovedError(workspace ?? workspaceId ?? null, 'openWorkspaceGraph');
    }

    // SurrealGraph implements the same ReadCache knobs LocalGraph took here
    // (settings-driven: bootConfig.localCache, plus the LORE_CACHE_DISABLED=1
    // killswitch inside the engine), so the cache options stay live.
    return new SurrealGraph(basePath, {
        ...(workspaceId ? { workspaceId } : {}),
        ...(opts.cacheTtlMs !== undefined ? { cacheTtlMs: opts.cacheTtlMs } : {}),
        ...(opts.cacheMaxSize !== undefined ? { cacheMaxSize: opts.cacheMaxSize } : {}),
        ...(opts.cacheDisabled !== undefined ? { cacheDisabled: opts.cacheDisabled } : {}),
    }) satisfies WorkspaceGraph;
}

/**
 * Which graph stores actually exist on disk under `basePath/.lore/`.
 *
 * Several commands answer "does this workspace have a graph?" by testing for
 * `.lore/graph` and nothing else. On a Surreal-backed
 * workspace that is false while the graph is perfectly present in
 * `.lore/surreal/`, so `lore doctor` reported a missing graph and, worse,
 * `lore check-corruption` and `scripts/scan-all-workspaces.mjs` SKIPPED the
 * workspace entirely. A corruption scan that silently omits a workspace is the
 * same class of defect as one that reports it clean.
 *
 * Returns both flags rather than a single engine, because `both` is a real
 * state: `lore migrate engine` deliberately leaves the source store in place
 * as the rollback path.
 */
export function graphStoresOnDisk(basePath: string): { legacyGraph: boolean; surreal: boolean; any: boolean } {
    const lore = path.join(basePath, '.lore');
    const legacyGraph = fs.existsSync(path.join(lore, 'graph'));
    // NOT path.join(lore, 'surreal') — that's the literal path, which is not
    // where the store actually lands whenever basePath's tree contains a
    // reserved URL character (a space is the common case). surrealDataPath
    // is the one function that knows the real, engine-normalized location;
    // see its doc comment in surreal/surrealConnection.ts.
    const surreal = fs.existsSync(surrealDataPath(basePath));
    return { legacyGraph, surreal, any: legacyGraph || surreal };
}

/** Human-readable engine name for a startup banner. */
export function bannerEngineName(basePath: string): string {
    return resolveGraphEngineForPath(basePath).engine === 'surreal' ? 'SurrealDB' : 'legacy graph engine (removed)';
}

/** The graph store path a banner should show for this workspace. */
export function bannerGraphPath(basePath: string): string {
    const engine = resolveGraphEngineForPath(basePath).engine;
    if (engine === 'surreal') return surrealDataPath(basePath);
    return path.join(basePath, '.lore', 'graph');
}

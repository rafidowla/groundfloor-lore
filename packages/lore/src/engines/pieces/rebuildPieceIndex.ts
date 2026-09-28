/**
 * rebuildPieceIndex.ts — offline D7 piece-index rebuild for a given data root
 * (3.24.2).
 *
 * 3.24.1 made a failed piece build/delete mark the index incomplete, with
 * piece search off until `lore migrate piece-vectors` is run (no self-heal
 * while the host runs). But that command only ever targeted `loreHome()`, so
 * an embedded host whose store lives at its own `createLore({ dataDir })`
 * (Atlas: one dataDir per workspace, never LORE_HOME) had no recovery path.
 *
 * This module is the shared core behind both repair routes:
 *   - `lore migrate piece-vectors --data-dir <path>` (CLI escape hatch), and
 *   - `rebuildPieceIndex({ dataDir })`, exported from the package root so a
 *     host can wire its own command.
 *
 * Offline only: the host that owns `dataDir` must have disposed its Lore
 * instance first. The graph open below is a lock preflight, same as the CLI's
 * `openGraphForCli` — if another process holds the data root, it throws
 * PieceIndexDataDirInUseError instead of racing that process's writes.
 *
 * Path resolution mirrors createLore(): `dataDir` is the host's data root
 * (resolveLoreHome precedence), and the store is its active workspace's path
 * from that root's own workspaces.json (as createLore's resolveGraphPath). Without a
 * `dataDir`, the target stays `loreHome()` verbatim — the pre-3.24.2 CLI
 * behaviour, unchanged.
 */

import fs from 'fs';
import { loreHome, resolveLoreHome } from '../../config/loreHome.js';
import { getActiveWorkspacePath } from '../../config/workspaces.js';
import { LoreGraphError } from '../loreGraphError.js';
import type { EmbeddingProvider } from '../../providers/types.js';
import type { LocalEmbeddingProviderOptions } from '../../providers/localEmbeddingProvider.js';
import type { VectorEngineKind } from '../vectorEngineSelector.js';
import type { BuildPieceIndexResult, PieceBuildableStore } from './pieceIndexBuild.js';

/** Short graph-open budget for the lock preflight (matches the CLI's). */
const PREFLIGHT_OPEN_BUDGET_MS = 1500;

export interface RebuildPieceIndexOptions {
    /** The host's `createLore({ dataDir })` root. Omitted → `loreHome()`. */
    dataDir?: string;
    /** Rebuild even when the index is already valid+complete. */
    force?: boolean;
    /** Count/estimate only — writes nothing. */
    dryRun?: boolean;
    /** Remove the piece table + sidecar (disable and reclaim disk). */
    drop?: boolean;
    /** The provider the host embeds with. Required when the host injects its
     *  own `createLore({ embeddingProvider })` — the rebuild must embed with
     *  the same model the store's fingerprint names. Omitted → Lore's env
     *  selector (`LORE_EMBEDDING_PROVIDER`, else the local model). */
    embeddingProvider?: EmbeddingProvider;
    /** Local-model overrides (same shape as `createLore({ embedding })`);
     *  ignored when `embeddingProvider` is given. */
    embedding?: LocalEmbeddingProviderOptions;
}

export interface RebuildPieceIndexResult extends BuildPieceIndexResult {
    /** The store directory that was rebuilt. */
    basePath: string;
    engine: VectorEngineKind;
    modelId: string;
}

/** The data root is held by a running process (host or daemon). */
export class PieceIndexDataDirInUseError extends Error {
    constructor(public readonly basePath: string, cause?: Error) {
        super(`The Lore data at ${basePath} is in use by another process. Stop the host that owns it, then retry the piece-index rebuild.`);
        this.name = 'PieceIndexDataDirInUseError';
        if (cause) (this as { cause?: unknown }).cause = cause;
    }
}

export interface PieceRebuildTarget {
    /** Registry root: workspaces.json and workspace settings are read here. */
    home: string;
    /** Store directory the piece index lives in. */
    basePath: string;
}

/**
 * Resolve which store a rebuild targets. With `dataDir`, refuses a path that
 * doesn't exist (loadWorkspaces would otherwise create a fresh, empty home
 * there and "rebuild" nothing).
 */
export function resolvePieceRebuildTarget(dataDir?: string): PieceRebuildTarget {
    if (dataDir === undefined || dataDir.trim().length === 0) {
        const home = loreHome();
        return { home, basePath: home };
    }
    if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
        throw new Error(`--data-dir ${dataDir} does not exist or is not a directory`);
    }
    const home = resolveLoreHome({ dataDir });
    return { home, basePath: getActiveWorkspacePath(home) };
}

/**
 * Open `basePath`'s vector store and run buildPieceIndex against it. No lock
 * preflight — callers do that (the CLI via openGraphForCli, the public API
 * via rebuildPieceIndex below).
 */
export async function rebuildPieceIndexAt(
    target: PieceRebuildTarget,
    provider: EmbeddingProvider,
    opts: Pick<RebuildPieceIndexOptions, 'force' | 'dryRun' | 'drop'> = {},
): Promise<RebuildPieceIndexResult> {
    const { openWorkspaceVerbatim, resolveVerbatimEngineForPath } = await import('../openWorkspaceVerbatim.js');
    const { buildPieceIndex } = await import('./pieceIndexBuild.js');

    const engine = resolveVerbatimEngineForPath(target.basePath, { home: target.home }).engine;
    // pieceVectors: true — the rebuild is independent of the workspace's
    // current retrieval intent (design 2.8); it only affects the
    // constructor's fast-path for a fresh/empty store.
    const store = openWorkspaceVerbatim(target.basePath, provider, { home: target.home, pieceVectors: true });
    try {
        await store.initialize();
        // Both concrete engines implement exportRows()/pieceIndexForMigration()
        // structurally (see pieceIndexBuild.ts's PieceBuildableStore).
        const result = await buildPieceIndex(target.basePath, store as unknown as PieceBuildableStore, provider, {
            dryRun: opts.dryRun,
            force: opts.force,
            drop: opts.drop,
        });
        return { ...result, basePath: target.basePath, engine, modelId: provider.modelId };
    } finally {
        await store.close();
    }
}

/**
 * Rebuild (or `--drop` / `--dry-run`) the D7 piece index of a host's data
 * root, offline. Idempotent: a valid+complete index is a `noop` unless
 * `force`. Throws PieceIndexDataDirInUseError when the data root is held by
 * a running process.
 */
export async function rebuildPieceIndex(opts: RebuildPieceIndexOptions = {}): Promise<RebuildPieceIndexResult> {
    if (opts.drop && (opts.dryRun || opts.force)) {
        throw new Error('drop cannot be combined with dryRun or force');
    }
    const target = resolvePieceRebuildTarget(opts.dataDir);
    const lock = await acquirePieceRebuildLock(target);
    try {
        const provider = opts.embeddingProvider ?? await (await import('../../mcp/services.js')).createEmbeddingProvider(opts.embedding);
        return await rebuildPieceIndexAt(target, provider, opts);
    } finally {
        await lock.close();
    }
}

/**
 * Lock preflight for a data root: open its graph with a short budget so a
 * running host's single-writer lock surfaces as PieceIndexDataDirInUseError
 * instead of a raw driver error. Hold the returned handle for the duration of
 * the rebuild, then close it. Unlike the CLI's openGraphForCli, this does not
 * probe for a daemon serving LORE_HOME — the data root may be unrelated to it.
 */
export async function acquirePieceRebuildLock(target: PieceRebuildTarget): Promise<{ close(): Promise<void> }> {
    const { openWorkspaceGraph } = await import('../openWorkspaceGraph.js');
    const prevBudget = process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
    process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = String(PREFLIGHT_OPEN_BUDGET_MS);
    try {
        const graph = openWorkspaceGraph(target.basePath, { home: target.home });
        await graph.initialize();
        return graph;
    } catch (err) {
        if (err instanceof LoreGraphError && err.operation === 'openSurreal') {
            throw new PieceIndexDataDirInUseError(target.basePath, err);
        }
        throw err;
    } finally {
        if (prevBudget === undefined) delete process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
        else process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = prevBudget;
    }
}

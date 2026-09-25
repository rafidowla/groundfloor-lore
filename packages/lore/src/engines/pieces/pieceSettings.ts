/**
 * pieceSettings.ts — D7 (3.23, piece-level vectors), design section 2.2/2.3.
 *
 * Resolves whether piece-level vectors are ON for a given workspace, and
 * persists an explicit per-workspace override. Mirrors
 * core/supersessionPolicy.ts's env/option/workspace precedence pattern
 * exactly (same three-tier shape, same "workspace explicit always wins"
 * rule), for the same reason: a host-wide default that a workspace can
 * override, backed by an env var read fresh (not cached) so tests can flip
 * it per case.
 *
 * IMPORTANT — this module resolves INTENT ("should this workspace be
 * piece-indexed"), not index validity. Whether the intent is actually
 * honored at query time additionally requires a valid, matching sidecar
 * (see pieceLayout.ts's isPieceSidecarValid) — that check belongs to each
 * store engine, not here, and is deliberately NOT duplicated in this file.
 */

import { loadWorkspaces, writeControl } from '../../config/workspaces.js';
import { loreHome } from '../../config/loreHome.js';

export interface WorkspacePieceVectors {
    enabled: boolean;
}

/** The `createLore({pieceVectors})` option shape — threaded through
 *  createVectorStore / WorkspaceVerbatimResolver / createLore (mcp/server.ts,
 *  out-of-scope wiring covered by the D7a store-hooks item). */
export interface PieceVectorsCreateOptions {
    pieceVectors?: boolean;
}

/**
 * `LORE_RECALL_PIECE_VECTORS` env var, read fresh each call (not cached).
 * Truthy: '1' or 'true' (case-insensitive). Anything else, including
 * unset, is `undefined` — "not set" is distinct from "explicitly off" so
 * `resolveHostPieceVectorsDefault` can prefer a `createLore` option of
 * `false` over an unset env var, exactly like `envSupersessionEnforceDefault`.
 */
export function envPieceVectorsDefault(): boolean | undefined {
    const raw = process.env['LORE_RECALL_PIECE_VECTORS'];
    if (raw === undefined || raw.trim() === '') return undefined;
    return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Precedence for the HOST-level default (below the per-workspace setting,
 * which always wins when present): `createLore({pieceVectors})` option >
 * `LORE_RECALL_PIECE_VECTORS` env var > `undefined` (callers then treat
 * that as `false`, i.e. off by default).
 */
export function resolveHostPieceVectorsDefault(createLoreOption?: boolean): boolean | undefined {
    if (createLoreOption !== undefined) return createLoreOption;
    return envPieceVectorsDefault();
}

/**
 * Final intent for `name` — workspace explicit override (true OR false)
 * always wins; otherwise falls back to `hostDefault` (already resolved via
 * `resolveHostPieceVectorsDefault`), and finally to `false`. Fails open
 * (returns the host default) rather than throwing when the workspace is
 * unknown to the registry — matches `resolveSupersessionContext`'s
 * fail-open stance for the same "unregistered workspace" case (a raw
 * graph/verbatim pair opened directly, or a lower-level test).
 */
export function resolvePieceVectorsIntent(
    name: string,
    home: string = loreHome(),
    hostDefault?: boolean,
): boolean {
    try {
        const file = loadWorkspaces(home);
        const entry = file.workspaces.find((w) => w.name === name);
        if (entry?.pieceVectors) return entry.pieceVectors.enabled;
    } catch {
        // Corrupt/unreadable control file — fall through to the host
        // default, same fail-open stance resolveSupersessionContext takes.
    }
    return hostDefault === true;
}

/** Read a workspace's explicit piece-vectors override, or `null` when
 *  none is set (the workspace then follows the host default). Throws when
 *  the workspace name is unknown — matches getWorkspaceSupersessionPolicy /
 *  getWorkspaceVocabPolicy. */
export function getWorkspacePieceVectors(name: string, home: string = loreHome()): WorkspacePieceVectors | null {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    return entry.pieceVectors ?? null;
}

/** Persist an explicit per-workspace piece-vectors override. Pass `null`
 *  to clear it (workspace then follows the host default again). */
export function setWorkspacePieceVectors(
    name: string,
    enabled: boolean | null,
    home: string = loreHome(),
): WorkspacePieceVectors | null {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    if (enabled === null) {
        delete entry.pieceVectors;
        writeControl(file, home);
        return null;
    }
    entry.pieceVectors = { enabled };
    writeControl(file, home);
    return entry.pieceVectors;
}

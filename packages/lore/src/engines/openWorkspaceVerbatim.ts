/**
 * openWorkspaceVerbatim.ts — open the vector engine a workspace actually
 * declares (`WorkspaceEntry.vectorEngine`).
 *
 * 3.21 step 2 part 2. Mirrors `openWorkspaceGraph.ts`'s shape exactly:
 * resolve-by-workspaceId-or-path-match, then construct (never initialize —
 * the caller decides when). There is no removed legacy engine to refuse
 * here (unlike `graphEngine`'s removed legacy value) — an absent field just
 * means `'lance'`, same as it always has.
 *
 * Both call sites that used to construct `VerbatimStore` directly for a
 * local, in-process (non-search-worker) store now go through this instead:
 * `mcp/services.ts`'s boot `createVectorStore`, and
 * `outbox/workspaceVerbatimResolver.ts`'s per-workspace `getOrOpen`. Neither
 * touches `VerbatimSearchWorkerProxy` construction — that stays at each call
 * site, gated by `resolveSearchWorkerIsolation`'s own `engineKind` param
 * (which now also comes from this module's engine resolution, so a
 * `'sqlite'`-vector workspace never spawns a search worker regardless of
 * policy/env — see that function's own doc comment).
 */

import { VerbatimStore } from './verbatimStore.js';
import { SqliteVerbatimStore } from './sqliteVerbatimStore.js';
import type { VerbatimStoreApi } from './verbatimStoreApi.js';
import type { VerbatimStoreRole } from './verbatimStoreRole.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { resolveVectorEngineForPath, type VectorEngineKind } from './vectorEngineSelector.js';

export interface OpenWorkspaceVerbatimOpts {
    /** Workspace name, when the caller already resolved one. */
    workspaceId?: string;
    /** LORE_HOME override, for tests. */
    home?: string;
    role?: VerbatimStoreRole;
    strictFingerprintCheck?: boolean;
    /** Called once a background promotion (SqliteVerbatimStore only)
     *  COMMITS, so the caller can swap a cached reference. Never called for
     *  a 'lance'-engine workspace (nothing to promote). */
    onLancePromoted?: (info: { newLanceDbPath: string }) => void | Promise<void>;
}

/** Which vector engine backs `basePath` — exposed for callers (CLI status/
 *  doctor) that only want the answer, not a constructed store. */
export function resolveVerbatimEngineForPath(
    basePath: string,
    opts: { workspaceId?: string; home?: string } = {},
): { engine: VectorEngineKind; workspace: string | null } {
    return resolveVectorEngineForPath(basePath, opts);
}

/**
 * Construct (but do NOT initialize) the vector store this workspace
 * declares. Not initialized here for the same reason `openWorkspaceGraph`
 * isn't: several callers construct-then-decide, and `initialize()` has real
 * side effects (opening/creating on-disk state).
 */
export function openWorkspaceVerbatim(
    basePath: string,
    embeddingProvider: EmbeddingProvider | undefined,
    opts: OpenWorkspaceVerbatimOpts = {},
): VerbatimStoreApi {
    const { engine, workspace } = resolveVectorEngineForPath(basePath, opts);
    const workspaceId = opts.workspaceId ?? workspace ?? undefined;
    if (engine === 'sqlite') {
        return new SqliteVerbatimStore(basePath, embeddingProvider, {
            role: opts.role,
            strictFingerprintCheck: opts.strictFingerprintCheck,
            ...(workspaceId ? { workspaceName: workspaceId } : {}),
            ...(opts.home ? { home: opts.home } : {}),
            ...(opts.onLancePromoted ? { onLancePromoted: opts.onLancePromoted } : {}),
        });
    }
    return new VerbatimStore(basePath, embeddingProvider, {
        role: opts.role,
        strictFingerprintCheck: opts.strictFingerprintCheck,
    });
}

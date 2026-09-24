/**
 * verbatimPromotionTrigger.ts — the write-path hook `verbatimPromotion.ts`
 * says it needs but deliberately doesn't build itself (see that file's
 * header: "the hook a FUTURE resolver-wiring change calls... recorded here,
 * not built here"). This IS that change.
 *
 * `SqliteVerbatimStore` calls `maybeTriggerPromotion()` after every
 * committed `store()`/`storeBatch()`/bulk write. It is a thin, fire-and-
 * forget wrapper:
 *
 *   1. `shouldTriggerPromotion()` (verbatimPromotion.ts) — cheap counter
 *      compare, already in-flight guard, threshold/disable check.
 *   2. If due, run `promoteWorkspace()` in the background — the caller's
 *      store()/storeBatch() has already returned by this point; nothing
 *      here is awaited on the write path (design section 3: "Promotion
 *      runs in the background, outside the write path").
 *   3. On a committed promotion, atomically flip `workspaces.json`'s
 *      `vectorEngine` to `'lance'` (`setWorkspaceVectorEngine` — the SAME
 *      atomic tmp-file+rename primitive `lore migrate-graph` uses for
 *      `graphEngine`), then invoke the caller's `onCommitted` callback so
 *      it can swap its own cached store reference (the
 *      `WorkspaceVerbatimResolver` does this; see its `swapToLance`).
 *
 * A promotion that fails verification, or throws, is logged and otherwise
 * silent: SQLite remains authoritative either way (verbatimPromotion.ts's
 * own crash-safety model), so there is nothing here to recover — the next
 * write simply re-checks the threshold and tries again.
 */

import { log } from '../logger.js';
import { shouldTriggerPromotion, promoteWorkspace } from './verbatimPromotion.js';
import { setWorkspaceVectorEngine } from '../config/workspaces.js';
import { resolveVectorEngineForPath } from './vectorEngineSelector.js';

export interface PromotionTriggerOptions {
    /** The workspace's `.lore/`-containing base path — same value every
     *  other SQLite-substrate path helper (sqliteGraphDataPath, etc.) takes. */
    basePath: string;
    /** Workspace name, when the caller already knows it (the resolver
     *  always does). When omitted, resolved by matching `basePath` against
     *  workspaces.json — same fallback `resolveGraphEngineForPath` uses. */
    workspaceName?: string;
    /** LORE_HOME override, for tests / non-default hosts. */
    home?: string;
    /** The cheap write counter this store instance is maintaining —
     *  design section 3: "a cheap counter, not COUNT(*)". */
    rowCountEstimate: number;
    /** The embedding dimension vectors were actually written with (the
     *  workspace's own fingerprint) — promotion copies vectors verbatim
     *  and never re-embeds, so this is the only sizing info it needs. */
    dimension: number;
    /** Called after a promotion COMMITS (vectorEngine already flipped) so
     *  the caller can swap any cached store reference of its own. Never
     *  called on a skipped, failed, or aborted promotion. */
    onCommitted?: (info: { newLanceDbPath: string }) => void | Promise<void>;
}

/**
 * Fire-and-forget: checks the trigger condition synchronously, and if due,
 * kicks off the background promotion without the caller awaiting it.
 * Safe to call after every committed write — `shouldTriggerPromotion`'s
 * own in-flight registry makes repeated calls while a promotion is already
 * running a no-op.
 */
export function maybeTriggerPromotion(opts: PromotionTriggerOptions): void {
    if (!shouldTriggerPromotion(opts.basePath, opts.rowCountEstimate)) return;
    void runPromotion(opts).catch((err) => {
        log.error(`[verbatimPromotionTrigger] background promotion crashed for ${opts.basePath} (SQLite remains authoritative): ${(err as Error).message}`);
    });
}

async function runPromotion(opts: PromotionTriggerOptions): Promise<void> {
    const result = await promoteWorkspace(opts.basePath, opts.dimension);
    if (!result.committed) {
        // dryRun never reaches here (this caller never passes it); a real
        // attempt that failed verification already logged its reasons
        // inside promoteWorkspace/verifyPromotion — nothing more to do,
        // SQLite is untouched and authoritative.
        return;
    }
    const name = opts.workspaceName ?? resolveVectorEngineForPath(opts.basePath, { home: opts.home }).workspace;
    if (name) {
        try {
            setWorkspaceVectorEngine(name, 'lance', opts.home);
        } catch (err) {
            log.error(`[verbatimPromotionTrigger] promoted ${opts.basePath} to LanceDB but could not flip workspaces.json's vectorEngine for "${name}": ${(err as Error).message} — update it manually, the promoted store at ${result.newLanceDbPath} is otherwise complete.`);
        }
    } else {
        log.error(`[verbatimPromotionTrigger] promoted ${opts.basePath} to LanceDB but could not resolve a workspace name to flip vectorEngine in workspaces.json — update it manually.`);
    }
    if (opts.onCommitted && result.newLanceDbPath) {
        try {
            await opts.onCommitted({ newLanceDbPath: result.newLanceDbPath });
        } catch (err) {
            log.error(`[verbatimPromotionTrigger] onCommitted callback threw for ${opts.basePath} (promotion itself already succeeded): ${(err as Error).message}`);
        }
    }
}

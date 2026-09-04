/**
 * types.ts — shared dependency bundle + graph union for the read-only
 * retrieval tools (search, recall, structured_query). Each tool lives in
 * its own file under ./; this is the shape they all share.
 */

import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import type { StorageBundle } from '../../services.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';

// Widened when the local graph engine changed: naming the two CONCRETE
// classes silently excluded SurrealGraph (see engines/htmlExport.ts). Need
// more than the shared handle? Feature-detect and refuse — do not re-narrow
// to a class.
export type LoreGraph = LoreGraphHandle;

export interface SearchToolsDeps {
    store: StorageBundle;
    detectedScope: { workspace: string; ecosystem: string };
    /**
     * Phase 6 P1.C — multi-workspace LocalGraph registry. When wired,
     * recall honors `workspace: "<name>"` (route to that workspace's
     * graph) and `workspace: "*"` (iterate workspaces.json + merge by
     * score). When omitted, recall keeps the pre-P1.C active-only
     * behavior. Optional so cloud-mode + test fixtures bypass routing.
     */
    graphRegistry?: LocalGraphRegistry;
    /**
     * P2 (scalability) — per-workspace verbatim (LanceDB) resolver. Threaded
     * into the shared retrieve() core so recall against a NON-active workspace
     * seeds semantic + BM25 against that workspace's OWN verbatim store instead
     * of falling back to a keyword-only scan. Optional — cloud mode / fixtures
     * omit it and non-active recall degrades to keyword (prior behavior).
     */
    workspaceVerbatimResolver?: {
        getOrOpen(ws: string): Promise<import('../../../engines/verbatimStore.js').VerbatimStore>;
    };
}

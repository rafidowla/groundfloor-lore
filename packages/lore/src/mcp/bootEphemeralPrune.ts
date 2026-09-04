/**
 * bootEphemeralPrune.ts — the daemon's non-fatal startup ephemeral prune.
 *
 * ITEM boot-pruneeph (2026-09) — mcp/server.ts's boot-time prune used to
 * call `store.storageClient.pruneEphemeralNodes()` directly: no
 * `nodeWriteLock`, no outbox `node.delete` row, no verbatim tombstone (see
 * `SurrealGraph.pruneEphemeralNodes`, engines/surrealGraph.ts) — the exact
 * gap ITEM X-pruneeph (2026-09-03) closed for `POST /api/prune-ephemeral`
 * and the `prune_ephemeral` MCP tool. This wraps the SAME
 * `safePruneEphemeralNodes` (engines/safeEphemeralPrune.ts) those two use,
 * kept in its own module (rather than inlined in mcp/server.ts) so the
 * boot call site stays a single non-fatal fire-and-forget call — server.ts
 * is already past the file-size baseline and every line added there is
 * tracked debt.
 */

import { log } from '../logger.js';
import { safePruneEphemeralNodes, type SafeEphemeralPruneGraph } from '../engines/safeEphemeralPrune.js';
import type { OutboxStore } from '../outbox/types.js';
import type { WorkspaceVerbatimResolver } from '../outbox/workspaceVerbatimResolver.js';
import type { LoreVectorStore } from './services.js';

export interface BootEphemeralPruneOpts {
    graph: SafeEphemeralPruneGraph;
    workspace: string;
    outboxStore: OutboxStore;
    /** Local-mode per-workspace verbatim resolver, when wired. */
    workspaceVerbatimResolver: WorkspaceVerbatimResolver | undefined;
    /** Fallback verbatim/vector store used when no resolver is wired —
     *  the boot store mcp/server.ts already initialized. */
    verbatimStore: LoreVectorStore;
}

/**
 * Returns a Promise (so a regression test can await completion and inspect
 * side effects) but mcp/server.ts's call site does NOT await it — a startup
 * prune failure must never block boot, hence the internal try/catch rather
 * than letting a rejection propagate.
 */
export async function runBootEphemeralPrune(opts: BootEphemeralPruneOpts): Promise<void> {
    try {
        await safePruneEphemeralNodes({
            graph: opts.graph,
            workspace: opts.workspace,
            ttl: 3_600_000,
            outboxStore: opts.outboxStore,
            initiator: 'boot:prune-ephemeral',
            tombstoneVerbatim: async (verbatimId, reason) => {
                const targetVerbatim = opts.workspaceVerbatimResolver
                    ? await opts.workspaceVerbatimResolver.getOrOpen(opts.workspace)
                    : opts.verbatimStore;
                const vstore = targetVerbatim as unknown as {
                    tombstone?: (id: string, reason: string) => Promise<void>;
                    delete?: (id: string) => Promise<void>;
                };
                if (typeof vstore.tombstone === 'function') {
                    await vstore.tombstone(verbatimId, reason);
                } else if (typeof vstore.delete === 'function') {
                    await vstore.delete(verbatimId);
                }
            },
            onLog: (message) => log.warn(`[Lore MCP] ${message}`),
        });
    } catch (err) {
        log.warn(`[Lore MCP] Startup ephemeral prune failed (non-fatal): ${(err as Error).message}`);
    }
}

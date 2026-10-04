/**
 * maintainOrphanAliasSweep.ts — the `lore maintain --orphan-alias-sweep` step
 * (3.27.1). Offline counterpart of the in-daemon `maintain` tool's sweep: opens
 * the workspace's verbatim store (no embedding provider needed — it only lists,
 * reads and purges rows), runs core/orphanAliasSweep.ts against the graph handle
 * the CLI already holds, and closes the store. Opt-in (the offline CLI otherwise
 * never opens the verbatim store); honours --dry-run.
 */
import { openWorkspaceVerbatim } from '../../engines/openWorkspaceVerbatim.js';
import { sweepOrphanAliases, type OrphanAliasSweepResult } from '../../core/orphanAliasSweep.js';
import { loreHome } from '../../config/loreHome.js';
import { redactError } from '../../security/logRedact.js';

export async function runCliOrphanAliasSweep(
    name: string, wsPath: string, graph: unknown, dryRun: boolean,
): Promise<OrphanAliasSweepResult> {
    const empty: OrphanAliasSweepResult = { dryRun, scanned: 0, orphans: 0, purged: 0, skippedPending: 0, skippedTombstoned: 0, truncated: false, errors: [] };
    const g = graph as { getNodesByIds?: unknown } | null;
    if (!g || typeof g.getNodesByIds !== 'function') {
        return { ...empty, errors: [`orphan alias sweep: no graph handle for workspace "${name}"`] };
    }
    const verbatim = openWorkspaceVerbatim(wsPath, undefined, { workspaceId: name, home: loreHome() });
    try {
        await verbatim.initialize();
        const r = await sweepOrphanAliases({
            workspace: name, graph: g as { getNodesByIds(ids: string[]): Promise<Map<string, unknown>> }, verbatim, dryRun,
        });
        if (r.orphans > 0) {
            console.error(`[Lore] maintain orphan-alias sweep (${name}${dryRun ? ', dry run' : ''}): scanned=${r.scanned} orphans=${r.orphans} purged=${r.purged} skippedPending=${r.skippedPending} skippedTombstoned=${r.skippedTombstoned} truncated=${r.truncated}`);
        }
        return r;
    } catch (err) {
        return { ...empty, errors: [`orphan alias sweep failed: ${redactError(err)}`] };
    } finally {
        try { await (verbatim as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* best effort */ }
    }
}

/**
 * bulkIngestUnchanged.ts — pre-embed skip for `bulkIngest` (3.35.0).
 *
 * Atlas re-indexes on every `git pull` through `bulkIngest(nodes, { embed: 'sync' })`. Before this, every node was
 * embedded and its verbatim row replaced even when nothing about it had changed, so an unchanged corpus cost one model
 * call per node per pull. The verbatim store now answers "which of these rows are already stored identically" (same
 * content hash, an embedded vector, same persisted metadata; `updatedAt` ignored: the skip-identical rule from
 * `engines/sqliteVerbatimWrite.ts`) in ONE query per workspace, and those nodes are neither embedded nor rewritten.
 * The stored vector is already the right one, so recall is unchanged.
 *
 * Engine-neutral by feature detection: a store without `findUnchangedRowIds` (the Lance engine, cloud) reports nothing
 * unchanged and bulkIngest embeds every node exactly as before. Lance is not the default engine and its row reads carry
 * no vector-presence test, so it is deliberately left on the old behaviour rather than given a second copy of the rule.
 */

import { computeContentHash } from '../engines/contentHash.js';
import { tagsToString } from '../engines/normalizeTags.js';
import type { BulkIngestDeps, BulkIngestNodeArgs } from './bulkIngest.js';

type Item = { node: BulkIngestNodeArgs; idx: number };

/** The `bulkUpsertPrebuiltRows`-shaped verbatim row for a node's main content text. `vector` is omitted for probes. */
export function buildMainRow(node: BulkIngestNodeArgs, text: string, vector?: number[]): Record<string, unknown> {
    return {
        ...(vector ? { vector } : {}),
        id: `lore:${node.id}`,
        text,
        type: String(node.nodeData.type ?? ''),
        label: String(node.nodeData.label ?? ''),
        tags: tagsToString(node.nodeData.tags as string | string[] | undefined),
        project: String(node.nodeData.project ?? node.ecosystem),
        ecosystem: node.ecosystem,
        updatedAt: new Date().toISOString(),
        security_scopes: (node.nodeData['security_scopes'] as string[] | undefined) ?? [],
        contentHash: computeContentHash(text),
    };
}

/**
 * Split `items` into those that still need a vector write and those whose stored row is already identical.
 * One `findUnchangedRowIds` call per workspace (the store chunks internally), never per node. Any resolver or probe
 * failure leaves the affected items on the normal path: the later write reports its own error.
 */
export async function partitionUnchanged<T extends Item>(
    deps: BulkIngestDeps,
    items: readonly T[],
    textOf: (item: T) => string,
): Promise<{ fresh: T[]; unchanged: T[] }> {
    const byWorkspace = new Map<string, T[]>();
    for (const it of items) {
        const g = byWorkspace.get(it.node.workspace) ?? [];
        g.push(it);
        byWorkspace.set(it.node.workspace, g);
    }
    const unchangedIds = new Set<string>();
    for (const [ws, group] of byWorkspace) {
        try {
            const store = deps.workspaceVerbatimResolver ? await deps.workspaceVerbatimResolver.getOrOpen(ws) : deps.verbatimStore;
            const probe = (store as { findUnchangedRowIds?: (rows: Array<Record<string, unknown>>) => Promise<string[]> }).findUnchangedRowIds;
            if (typeof probe !== 'function') continue;
            const same = await probe.call(store, group.map((it) => buildMainRow(it.node, textOf(it))));
            for (const id of same) unchangedIds.add(`${ws}\u0000${id}`);
        } catch {
            // Best effort: embed this workspace's nodes the normal way.
        }
    }
    const fresh: T[] = [];
    const unchanged: T[] = [];
    for (const it of items) (unchangedIds.has(`${it.node.workspace}\u0000lore:${it.node.id}`) ? unchanged : fresh).push(it);
    return { fresh, unchanged };
}

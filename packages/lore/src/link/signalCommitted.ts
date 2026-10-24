/**
 * signalCommitted.ts - the one helper every vector-commit site calls.
 *
 * Takes verbatim row ids (`lore:<nodeId>`, possibly alias / history rows) and
 * signals only the canonical node rows. A no-op when link-on-arrival is off
 * (`signaler` null/undefined), so call sites stay a single line.
 */
import { nodeIdOfRow } from './selectLinks.js';
import type { LinkItem, LinkSignaler } from './linkTypes.js';

export function signalCommitted(
    signaler: LinkSignaler | null | undefined,
    workspace: string | undefined,
    rows: ReadonlyArray<{ id: string; ecosystem?: string }>,
): void {
    if (!signaler || !workspace || rows.length === 0) return;
    const items: LinkItem[] = [];
    for (const r of rows) {
        const nodeId = nodeIdOfRow(r.id);
        if (nodeId !== null) items.push({ id: nodeId, ...(r.ecosystem ? { ecosystem: r.ecosystem } : {}) });
    }
    if (items.length > 0) signaler.signal(workspace, items);
}

/**
 * Every write entry point awaits this once, BEFORE the write, with the caller's `autolink` option.
 * Explicit `false` => the node is durably opted out of automatic linking: no links from it, none
 * to it as a neighbour candidate, none in rebuild; the flag lives in the workspace store and stays
 * until a later write explicitly sets `autolink:true` or the node is deleted. Explicit `true` clears
 * it. Absent (`undefined`) leaves any existing opt-out in place, so a plain re-save, sync, re-embed
 * or migrate never re-enables linking. Accepts bare node ids or `lore:<id>` rows. A no-op when
 * link-on-arrival is off. Never rejects.
 */
export async function applyLinkIntent(
    signaler: LinkSignaler | null | undefined,
    workspace: string | undefined,
    ids: ReadonlyArray<string>,
    autolink: boolean | undefined,
): Promise<void> {
    if (!signaler?.setIntent || !workspace || ids.length === 0 || autolink === undefined) return;
    await signaler.setIntent(workspace, ids.map((i) => (i.startsWith('lore:') ? i.slice(5) : i)), autolink);
}

/** applyLinkIntent() for a mixed-workspace batch of nodes. */
export async function applyLinkIntentToNodes(
    signaler: LinkSignaler | null | undefined,
    nodes: ReadonlyArray<{ id: string; workspace: string }>,
    autolink: boolean | undefined,
): Promise<void> {
    if (!signaler?.setIntent || autolink === undefined) return;
    const byWs = new Map<string, string[]>();
    for (const n of nodes) {
        const list = byWs.get(n.workspace) ?? [];
        list.push(n.id);
        byWs.set(n.workspace, list);
    }
    for (const [ws, ids] of byWs) await applyLinkIntent(signaler, ws, ids, autolink);
}

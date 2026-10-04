/**
 * verbatimWorkerTombstone.ts — parent-embeds tombstone for VerbatimSearchWorkerProxy (3.27.1).
 *
 * VerbatimStore.tombstone() re-embeds the marker-prefixed text (a row's vector follows its text).
 * Under parent-embeds the child's embedding provider is a stub that throws on every embed, so the
 * forwarded call failed AFTER it had already written the `#rev` snapshot: every default nodeDelete /
 * verbatim.tombstone replay on a worker-mode host failed and dead-lettered. Mirror store(): read the
 * row here, embed the tombstone text with the parent's embedder, and hand the child `{ ts, vector }`
 * (VerbatimStore.tombstone's `pre`). The text format below MUST match VerbatimStore.tombstone's; the
 * child still does the snapshot + atomic canonical replace. A row that is absent / already
 * tombstoned / a history id is forwarded untouched (the child no-ops it). The row can change between
 * the read and the child's write; the child re-reads, so at worst the vector is one edit stale on a
 * row that is being deleted anyway.
 */
import type { EmbeddingProvider } from '../providers/types.js';

export async function tombstoneViaParentEmbed(
    embedder: EmbeddingProvider,
    call: (method: 'getById' | 'tombstone', args: unknown[]) => Promise<unknown>,
    id: string,
    reason: string,
): Promise<void> {
    const row = await call('getById', [id]) as { text?: string } | null;
    const text = row?.text;
    if (typeof text !== 'string' || text.startsWith('[TOMBSTONED')) { await call('tombstone', [id, reason]); return; }
    const ts = new Date().toISOString();
    const vector = await embedder.embedDocument(`[TOMBSTONED ${ts} reason: ${reason}]\n\n${text}`);
    await call('tombstone', [id, reason, { ts, vector }]);
}

/**
 * dataplaneVerbatimHistoryReads.ts — the read side and the tombstone row shape of the cloud verbatim
 * history (cloud parity C item 8). Split out of dataplaneVectorStore.ts (file-size guardrail); see
 * dataplaneVerbatimHistory.ts for the model.
 */
import { buildDataplaneScopeFilter, type DataplaneScope } from './dataplaneScopeFilter.js';
import { keepInScope, pageRepeats, scopedGetRow, type ScopedUpsertClient } from './dataplaneScopedIo.js';
import { transactionRunnerFor } from './dataplaneTransaction.js';
import { buildSnapshotGroup, isSnapshotOf, TOMBSTONE_PREFIX, writeSnapshotGroup } from './dataplaneVerbatimHistory.js';

export interface VerbatimHistoryEntry { id: string; text: string; updatedAt: string; isTombstone: boolean; isCanonical: boolean }

interface HistoryClient extends ScopedUpsertClient {
    query<T = unknown>(tenantId: string, collection: string, options?: unknown, connection?: string): Promise<{ records: T[] }>;
}

const PAGE = 1000;
const MAX_PAGES = 50;

/** Page budget for readVerbatimHistory (overridable so the over-budget behaviour is testable). */
export interface HistoryReadLimits { pageSize?: number; maxPages?: number }

/**
 * Local getHistory parity: the canonical row (possibly tombstoned) first, then every `<id>#rev<ts>`
 * snapshot, newest first. Scoped to the Lore workspace on every read (D3 builder + client re-check);
 * a snapshot of some LONGER id sharing the prefix is excluded by an exact-shape check.
 *
 * A history longer than pageSize x maxPages (default 1000 x 50 = 50,000 snapshots) THROWS rather than
 * returning a partial list: a silently truncated history looks complete (review C #7), the same rule
 * the version-store scan follows.
 */
export async function readVerbatimHistory(
    client: HistoryClient,
    scope: DataplaneScope,
    collection: string,
    connection: string | undefined,
    id: string,
    limits: HistoryReadLimits = {},
): Promise<VerbatimHistoryEntry[]> {
    const pageSize = limits.pageSize ?? PAGE;
    const maxPages = limits.maxPages ?? MAX_PAGES;
    const shape = (r: Record<string, unknown>, rid: string, isCanonical: boolean): VerbatimHistoryEntry => {
        const text = String(r['text'] ?? '');
        return { id: rid, text, updatedAt: String(r['updated_at'] ?? ''), isTombstone: text.startsWith(TOMBSTONE_PREFIX), isCanonical };
    };
    const out: VerbatimHistoryEntry[] = [];
    const canonical = await scopedGetRow(client, scope, collection, id, connection);
    if (canonical) out.push(shape(canonical, id, true));
    const built = buildDataplaneScopeFilter(scope, { extra: [{ field: 'lore_id', op: 'starts_with', value: `${id}#rev` }] }, 'crud', 0);
    const snaps: VerbatimHistoryEntry[] = [];
    let head: unknown;
    for (let offset = 0, page = 0; ; page++, offset += pageSize) {
        if (page >= maxPages) throw new Error(`cloud verbatim history of ${id} exceeded ${pageSize * maxPages} snapshots; the history is too long to return whole`);
        const res = await client.query<Record<string, unknown>>(
            scope.dataplaneWorkspaceId,
            collection,
            { filter: built.server, sort: [{ field: 'lore_id', direction: 'desc' }], limit: pageSize, offset },
            connection,
        );
        const records = res.records ?? [];
        if (page === 0) head = records[0]?.['id'];
        else if (pageRepeats(head, records[0]?.['id'])) throw new Error(`cloud verbatim history of ${id}: the connector ignored offset paging (e.g. SQLite); the history cannot be returned whole`);
        for (const r of keepInScope(records, built.clientPredicate, 'dataplaneVectorStore.getHistory')) {
            const rid = String(r['lore_id'] ?? '');
            if (isSnapshotOf(rid, id)) snaps.push(shape(r, rid, false));
        }
        if (records.length < pageSize) break;
    }
    snaps.sort((a, b) => b.id.localeCompare(a.id));
    return [...out, ...snaps];
}

/** Content columns of a tombstoned canonical row: the old metadata, the tombstone text and its fresh vector. */
export function tombstoneFields(existing: Record<string, unknown>, ts: string, text: string, vector: number[], revisionColumn: boolean): Record<string, unknown> {
    const fields: Record<string, unknown> = {
        vector,
        text,
        type: existing['type'] ?? '',
        label: existing['label'] ?? '',
        tags: existing['tags'] ?? '',
        project: existing['project'] ?? '',
        ecosystem: existing['ecosystem'] ?? '',
        updated_at: ts,
        security_scopes: existing['security_scopes'] ?? '',
        content_hash: existing['content_hash'] ?? '',
    };
    if (revisionColumn) fields['revision_state'] = 'tombstone';
    return fields;
}

/**
 * Overwrite canonical row `id` with `fields`, keeping `existing` as a `<id>#rev<ts>` snapshot: one
 * /v1/transaction when the route exists, else change then snapshot (a snapshot failure is counted in
 * /health, never thrown — R3). `embed` covers a connector whose GET omits the stored vector.
 */
export async function overwriteWithSnapshot(a: {
    client: HistoryClient;
    connection: string | undefined;
    scope: DataplaneScope;
    collection: string;
    id: string;
    fields: Record<string, unknown>;
    existing: Record<string, unknown>;
    revisionColumn: boolean;
    embed: (text: string) => Promise<number[]>;
    ts?: string;
}): Promise<void> {
    const fallbackVector = Array.isArray(a.existing['vector']) ? undefined : await a.embed(String(a.existing['text'] ?? ''));
    const group = buildSnapshotGroup({
        client: a.client, scope: a.scope, collection: a.collection, connection: a.connection, loreId: a.id,
        fields: a.fields, existing: a.existing, revisionColumn: a.revisionColumn, fallbackVector, ts: a.ts,
    });
    await writeSnapshotGroup(transactionRunnerFor(a.client, a.connection), a.scope.dataplaneWorkspaceId, group);
}

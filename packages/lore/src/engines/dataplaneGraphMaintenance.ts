/**
 * dataplaneGraphMaintenance.ts — supersession + prune/stale maintenance for
 * the cloud DataplaneGraph adapter.
 *
 * Extracted from dataplaneGraph.ts (god-class split). These five operations
 * are thin SDK wrappers (updateByQuery / query / deleteByQuery) that need only
 * a small set of the adapter's state, threaded in via a context object so this
 * module has no dependency on the adapter class or its private SdkClient type
 * (the context's client is typed structurally to the three CRUD methods used).
 * DataplaneGraph keeps thin delegators; behavior + D-017 compliance unchanged.
 */

import { NODE_COLLECTION, EDGE_COLLECTION } from './dataplaneCollections.js';
import { log } from '../logger.js';
import { buildDataplaneScopeFilter, type DataplaneScope, type ScopeFilterInput } from './dataplaneScopeFilter.js';
import { keepInScope } from './dataplaneScopedIo.js';

/** Structural subset of the SDK client these maintenance ops touch. */
interface MaintenanceClient {
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated?: number }>;
    query<T = Record<string, unknown>>(tenantId: string, collection: string, options: object, connection?: string): Promise<{ records?: T[] }>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted?: number }>;
}

/** State threaded from DataplaneGraph for the maintenance operations. */
export interface MaintenanceCtx {
    client: MaintenanceClient;
    /** Resolve the per-call scope (org + Lore workspace); throws DataplaneScopeError, fail closed. */
    scope: () => DataplaneScope;
    connection?: string;
    ensureInitialized: (scope: DataplaneScope) => Promise<void>;
    tryGet: (scope: DataplaneScope, id: string) => Promise<Record<string, unknown> | null>;
}

/** Scoped crud filter (org + Lore workspace + caller clauses). */
function scoped(scope: DataplaneScope, input: ScopeFilterInput = {}) {
    return buildDataplaneScopeFilter(scope, input, 'crud', 0);
}

/** Mark `oldId` superseded by `newId`. Idempotent; validates both exist. */
export async function supersedeNode(ctx: MaintenanceCtx, oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
    if (oldId === newId) return { ok: false, reason: 'self' };
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const tenantId = scope.dataplaneWorkspaceId;
    const oldNode = await ctx.tryGet(scope, oldId);
    if (!oldNode) return { ok: false, reason: 'old-not-found' };
    const newNode = await ctx.tryGet(scope, newId);
    if (!newNode) return { ok: false, reason: 'new-not-found' };
    const ts = new Date().toISOString();
    await ctx.client.updateByQuery(
        tenantId,
        NODE_COLLECTION,
        scoped(scope, { loreId: oldId }).server as object,
        { superseded_by: newId, superseded_at: ts, superseded_reason: reason ?? '' },
        ctx.connection,
    );
    return { ok: true };
}

/** Reverse a prior supersession. */
export async function unsupersedeNode(ctx: MaintenanceCtx, id: string): Promise<boolean> {
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const tenantId = scope.dataplaneWorkspaceId;
    const exists = await ctx.tryGet(scope, id);
    if (!exists) return false;
    const res = await ctx.client.updateByQuery(
        tenantId,
        NODE_COLLECTION,
        scoped(scope, { loreId: id }).server as object,
        { superseded_by: '', superseded_at: '', superseded_reason: '' },
        ctx.connection,
    );
    return (res?.updated ?? 0) > 0;
}

/**
 * findNodeIdsByTags — 2026-09-03 (X-markstale audit fix) read-only resolver:
 * every node id carrying ANY of the tags. Factored out of `markStaleByTags`'s
 * former phase-1 loop so the mark_stale entry points (mcp/tools/memory/
 * markStale.ts, POST /api/mark-stale) can resolve the full matched id set
 * BEFORE chunk-locking + outbox-recording + applying `markStaleByIds` — the
 * read (tag scan) and the write (id-scoped, lockable, replayable) are now
 * separate steps. Behavior unchanged from the old inline phase 1.
 */
export async function findNodeIdsByTags(ctx: MaintenanceCtx, tags: string[]): Promise<string[]> {
    const lower = tags.map((t) => t.toLowerCase().trim()).filter(Boolean);
    if (lower.length === 0) return [];
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const tenantId = scope.dataplaneWorkspaceId;

    const ids = new Set<string>();
    for (const tag of lower) {
        const built = scoped(scope, { tags: [tag] });
        const res = await ctx.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { filter: built.server, limit: 1000 },
            ctx.connection,
        );
        for (const rec of keepInScope(res.records ?? [], built.clientPredicate, 'findNodeIdsByTags')) {
            const id = String(rec['lore_id'] ?? '');
            if (id) ids.add(id);
        }
    }
    return Array.from(ids);
}

/**
 * markStaleByIds — 2026-09-03 (X-markstale audit fix) set stale=true on
 * EXACTLY the given ids (no tag re-query) — one updateByQuery per id so the
 * returned count reflects unique nodes actually touched, factored out of
 * `markStaleByTags`'s former phase-2 loop. This is the substrate primitive
 * the outbox dispatcher calls on `node.mark_stale` replay and that the live
 * entry points call inside their own per-chunk lock — mirrors `deleteNode`'s
 * role for `node.delete`.
 */
export async function markStaleByIds(ctx: MaintenanceCtx, ids: string[]): Promise<number> {
    const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
    if (unique.length === 0) return 0;
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const tenantId = scope.dataplaneWorkspaceId;

    let marked = 0;
    for (const id of unique) {
        const res = await ctx.client.updateByQuery(
            tenantId,
            NODE_COLLECTION,
            scoped(scope, { loreId: id }).server as object,
            { stale: true },
            ctx.connection,
        );
        if ((res?.updated ?? 0) > 0) marked++;
    }
    return marked;
}

/**
 * markStaleByTags — flag stale=true on every node whose tags contain ANY of
 * the tags. Unchanged public contract; now composed from `findNodeIdsByTags`
 * (phase 1: resolve) + `markStaleByIds` (phase 2: apply) so the two phases
 * have a single source of truth each, shared with the outbox-aware callers.
 * Kept for the CLI's no-daemon direct-open fallback (cli/commands/
 * markStale.ts), which has no outbox/replicator to record against anyway.
 */
export async function markStaleByTags(ctx: MaintenanceCtx, tags: string[]): Promise<number> {
    const ids = await findNodeIdsByTags(ctx, tags);
    if (ids.length === 0) return 0;
    return markStaleByIds(ctx, ids);
}

/**
 * pruneEphemeralNodes — delete expired ephemeral nodes. Per-row ttl_ms can't
 * be expressed in the SDK filter, so: query ephemeral → compute expiry in JS →
 * deleteByQuery per id. Non-fatal on error (prune never blocks the daemon).
 */
export async function pruneEphemeralNodes(ctx: MaintenanceCtx, defaultTtlMs: number = 3_600_000): Promise<number> {
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const tenantId = scope.dataplaneWorkspaceId;

    try {
        const built = scoped(scope, { extra: [{ field: 'ephemeral', op: 'eq', value: true }] });
        const res = await ctx.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { filter: built.server, limit: 1000 },
            ctx.connection,
        );
        const now = Date.now();
        const expired: string[] = [];
        for (const rec of keepInScope(res.records ?? [], built.clientPredicate, 'pruneEphemeralNodes')) {
            const id = String(rec['lore_id'] ?? '');
            const createdAt = String(rec['created_at'] ?? '');
            const ttlRaw = rec['ttl_ms'];
            const ttl = typeof ttlRaw === 'number' && ttlRaw > 0 ? ttlRaw : defaultTtlMs;
            if (!id || !createdAt) continue;
            const createdMs = new Date(createdAt).getTime();
            if (!Number.isFinite(createdMs)) continue;
            if (now - createdMs > ttl) expired.push(id);
        }

        let deleted = 0;
        for (const id of expired) {
            const r = await ctx.client.deleteByQuery(
                tenantId,
                NODE_COLLECTION,
                scoped(scope, { loreId: id }).server as object,
                ctx.connection,
            );
            if ((r?.deleted ?? 0) > 0) deleted++;
        }
        return deleted;
    } catch (error) {
        log.error('[DataplaneGraph] pruneEphemeralNodes failed (non-fatal)', { error: (error as Error).message });
        return 0;
    }
}

/**
 * pruneInferredLoreEdges — delete every LoreEdge whose relation starts with the
 * prefix. SDK filter has no starts_with, so: query → JS prefix filter →
 * deleteByQuery per id.
 */
export async function pruneInferredLoreEdges(ctx: MaintenanceCtx, relationPrefix: string): Promise<number> {
    const scope = ctx.scope();
    await ctx.ensureInitialized(scope);
    const tenantId = scope.dataplaneWorkspaceId;
    // Server-side starts_with narrows the scan; the exact prefix is re-checked below.
    const built = scoped(scope, { extra: [{ field: 'relation', op: 'starts_with', value: relationPrefix }] });
    const res = await ctx.client.query<Record<string, unknown>>(
        tenantId,
        EDGE_COLLECTION,
        { filter: built.server, limit: 10_000 },
        ctx.connection,
    );
    const matching: string[] = [];
    for (const rec of keepInScope(res.records ?? [], built.clientPredicate, 'pruneInferredLoreEdges')) {
        const id = String(rec['lore_id'] ?? '');
        const relation = String(rec['relation'] ?? '');
        if (id && relation.startsWith(relationPrefix)) matching.push(id);
    }
    let deleted = 0;
    for (const id of matching) {
        const r = await ctx.client.deleteByQuery(
            tenantId,
            EDGE_COLLECTION,
            scoped(scope, { loreId: id }).server as object,
            ctx.connection,
        );
        if ((r?.deleted ?? 0) > 0) deleted++;
    }
    return deleted;
}

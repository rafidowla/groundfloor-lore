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

/** Structural subset of the SDK client these maintenance ops touch. */
interface MaintenanceClient {
    updateByQuery(tenantId: string, collection: string, filter: object, fields: object, connection?: string): Promise<{ updated?: number }>;
    query<T = Record<string, unknown>>(tenantId: string, collection: string, options: object, connection?: string): Promise<{ records?: T[] }>;
    deleteByQuery(tenantId: string, collection: string, filter: object, connection?: string): Promise<{ deleted?: number }>;
}

/** State threaded from DataplaneGraph for the maintenance operations. */
export interface MaintenanceCtx {
    client: MaintenanceClient;
    tenantProvider: () => string;
    orgId: string;
    connection?: string;
    ensureTenantInitialized: (tenantId: string) => Promise<void>;
    tryGet: (tenantId: string, id: string) => Promise<Record<string, unknown> | null>;
}

/** Mark `oldId` superseded by `newId`. Idempotent; validates both exist. */
export async function supersedeNode(ctx: MaintenanceCtx, oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
    if (oldId === newId) return { ok: false, reason: 'self' };
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);
    const oldNode = await ctx.tryGet(tenantId, oldId);
    if (!oldNode) return { ok: false, reason: 'old-not-found' };
    const newNode = await ctx.tryGet(tenantId, newId);
    if (!newNode) return { ok: false, reason: 'new-not-found' };
    const ts = new Date().toISOString();
    await ctx.client.updateByQuery(
        tenantId,
        NODE_COLLECTION,
        { id_eq: oldId, org_id: ctx.orgId },
        { supersededBy: newId, supersededAt: ts, supersededReason: reason ?? '' },
        ctx.connection,
    );
    return { ok: true };
}

/** Reverse a prior supersession. */
export async function unsupersedeNode(ctx: MaintenanceCtx, id: string): Promise<boolean> {
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);
    const exists = await ctx.tryGet(tenantId, id);
    if (!exists) return false;
    const res = await ctx.client.updateByQuery(
        tenantId,
        NODE_COLLECTION,
        { id_eq: id, org_id: ctx.orgId },
        { supersededBy: '', supersededAt: '', supersededReason: '' },
        ctx.connection,
    );
    return (res?.updated ?? 0) > 0;
}

/**
 * markStaleByTags — flag stale=true on every node whose tags contain ANY of
 * the tags. Two phases — query per tag to collect ids (substring match), dedup,
 * then one updateByQuery per id so the count reflects unique nodes touched.
 */
export async function markStaleByTags(ctx: MaintenanceCtx, tags: string[]): Promise<number> {
    if (tags.length === 0) return 0;
    const lower = tags.map((t) => t.toLowerCase().trim()).filter(Boolean);
    if (lower.length === 0) return 0;
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);

    const ids = new Set<string>();
    for (const tag of lower) {
        const res = await ctx.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { filter: { org_id: ctx.orgId, tags_contains: tag }, limit: 1000 },
            ctx.connection,
        );
        for (const rec of res.records ?? []) {
            const id = String(rec['id'] ?? '');
            if (id) ids.add(id);
        }
    }
    if (ids.size === 0) return 0;

    let marked = 0;
    for (const id of ids) {
        const res = await ctx.client.updateByQuery(
            tenantId,
            NODE_COLLECTION,
            { id_eq: id, org_id: ctx.orgId },
            { stale: true },
            ctx.connection,
        );
        if ((res?.updated ?? 0) > 0) marked++;
    }
    return marked;
}

/**
 * pruneEphemeralNodes — delete expired ephemeral nodes. Per-row ttl_ms can't
 * be expressed in the SDK filter, so: query ephemeral → compute expiry in JS →
 * deleteByQuery per id. Non-fatal on error (prune never blocks the daemon).
 */
export async function pruneEphemeralNodes(ctx: MaintenanceCtx, defaultTtlMs: number = 3_600_000): Promise<number> {
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);

    try {
        const res = await ctx.client.query<Record<string, unknown>>(
            tenantId,
            NODE_COLLECTION,
            { filter: { org_id: ctx.orgId, ephemeral: true }, limit: 1000 },
            ctx.connection,
        );
        const now = Date.now();
        const expired: string[] = [];
        for (const rec of res.records ?? []) {
            const id = String(rec['id'] ?? '');
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
                { id_eq: id, org_id: ctx.orgId },
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
    const tenantId = ctx.tenantProvider();
    await ctx.ensureTenantInitialized(tenantId);
    const res = await ctx.client.query<Record<string, unknown>>(
        tenantId,
        EDGE_COLLECTION,
        { filter: { org_id: ctx.orgId }, limit: 10_000 },
        ctx.connection,
    );
    const matching: string[] = [];
    for (const rec of res.records ?? []) {
        const id = String(rec['id'] ?? '');
        const relation = String(rec['relation'] ?? '');
        if (id && relation.startsWith(relationPrefix)) matching.push(id);
    }
    let deleted = 0;
    for (const id of matching) {
        const r = await ctx.client.deleteByQuery(
            tenantId,
            EDGE_COLLECTION,
            { id_eq: id, org_id: ctx.orgId },
            ctx.connection,
        );
        if ((r?.deleted ?? 0) > 0) deleted++;
    }
    return deleted;
}

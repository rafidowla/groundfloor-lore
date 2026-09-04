/**
 * dataplaneCollectionStorage.ts — Q2.2 slice 5a. Dataplane-backed CollectionStorage
 * adapter (cloud mode).
 *
 * Translates the substrate-portable `Filter` shape into the Dataplane SDK
 * filter convention used elsewhere in this codebase: suffix-keyed
 * operators on the field name (e.g. `id_eq`, `label_contains`,
 * `created_at_gt`, `kind_in`). The same calls run on SQLite via sqliteTableStorage.ts in local mode.
 *
 * Edge model (cloud):
 *   Edges live in plain collections with `source_id` / `target_id`
 *   string columns. Unlike a Cypher-based graph engine, there's no
 *   MATCH-on-REL syntax to honor — `traverse` is a plain `query` with
 *   `source_id_eq` (out), `target_id_eq` (in), or two queries unioned
 *   (both). The EdgeShapeHint argument is therefore ignored. We accept
 *   it on the interface to keep the local collection storage and
 *   DataplaneCollectionStorage substitutable; slice 5c removes the hint
 *   entirely.
 *
 * Tenant routing:
 *   Like DataplaneGraph, this adapter calls `tenantProvider()` per op.
 *   Server.ts wires AsyncLocalStorage to the X-Lore-Workspace header so
 *   a single instance serves many tenants concurrently. The adapter
 *   does NOT mutate AsyncLocalStorage — it's a pure consumer.
 *
 * Idempotency:
 *   `upsert` uses the updateByQuery → insert-on-0 pattern that
 *   DataplaneGraph.upsertNode and TsSdkAdapter.push both use. Re-runs
 *   are safe; no duplicate rows.
 *
 * Schema provisioning:
 *   This adapter does NOT createCollection at write time. Callers
 *   declare their cloud collections in `registerCloudSchema` (slice 4),
 *   pushed lazily on each tenant's first touch. If a caller writes to a
 *   collection it forgot to declare, the SDK error from the missing
 *   collection bubbles up here unchanged.
 */

import type { TenantProvider } from './dataplaneGraph.js';
import type {
    CollectionDecl,
    EdgeRow,
    EdgeShapeHint,
    Filter,
    FindOptions,
    CollectionStorage,
    TraverseOptions,
} from './collectionStorage.js';

/**
 * Narrow SDK surface this adapter uses. Mirrors the shape declared in
 * dataplaneGraph.ts so the arch test's "no direct cloud-driver" rule
 * stays satisfied — we never pull in pg/arangojs/etc. directly.
 */
export interface CollectionStorageSdkClient {
    insert<T = unknown>(
        tenantId: string,
        collection: string,
        record: T,
        connection?: string,
    ): Promise<T>;
    query<T = unknown>(
        tenantId: string,
        collection: string,
        options?: unknown,
        connection?: string,
    ): Promise<{ records: T[]; total_count?: number; has_more?: boolean }>;
    updateByQuery(
        tenantId: string,
        collection: string,
        filter: object,
        fields: object,
        connection?: string,
    ): Promise<{ updated: number }>;
    deleteByQuery(
        tenantId: string,
        collection: string,
        filter: object,
        connection?: string,
    ): Promise<{ deleted: number }>;
    count(
        tenantId: string,
        collection: string,
        filter?: object,
        connection?: string,
    ): Promise<number>;
}

export interface DataplaneCollectionStorageConfig {
    client: CollectionStorageSdkClient;
    tenantProvider: TenantProvider;
    /** Optional connector name. Same semantics as DataplaneGraph. */
    connection?: string;
}

/**
 * Translate a portable Filter into the suffix-keyed shape Dataplane
 * accepts. Conjunction-only — the Filter type forbids OR/NOT, and
 * within Dataplane's filter object every key is implicitly AND'd.
 *
 * One quirk: a single field can carry multiple operators (e.g.
 * `gt: { createdAt }` AND `lt: { createdAt }`) which all map to
 * distinct suffixed keys (`created_at_gt`, `created_at_lt`) so the
 * AND survives the translation.
 */
export function filterToDataplane(filter: Filter | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!filter) return out;

    const apply = (
        op: 'eq' | 'contains' | 'startsWith' | 'gt' | 'gte' | 'lt' | 'lte' | 'in',
        suffix: string,
    ) => {
        const bag = filter[op];
        if (!bag) return;
        for (const [field, value] of Object.entries(bag)) {
            out[`${field}${suffix}`] = value;
        }
    };
    apply('eq', '_eq');
    apply('contains', '_contains');
    apply('startsWith', '_starts_with');
    apply('gt', '_gt');
    apply('gte', '_gte');
    apply('lt', '_lt');
    apply('lte', '_lte');
    apply('in', '_in');
    return out;
}

export class DataplaneCollectionStorage implements CollectionStorage {
    readonly mode = 'dataplane' as const;
    private readonly client: CollectionStorageSdkClient;
    private readonly tenantProvider: TenantProvider;
    private readonly connection?: string;
    /** Slice 5c — registry of declared collections by canonical name. */
    private readonly decls = new Map<string, CollectionDecl>();

    constructor(config: DataplaneCollectionStorageConfig) {
        this.client = config.client;
        this.tenantProvider = config.tenantProvider;
        this.connection = config.connection;
    }

    /* ─── Schema declaration (slice 5c) ───────────────────────── */

    declareCollection(decl: CollectionDecl): void {
        this.decls.set(decl.name, decl);
    }

    /**
     * Resolve canonical → cloud collection name. Defaults to `coll`
     * when no declaration is registered (legacy / undeclared path).
     */
    private resolveCloudColl(coll: string): string {
        const d = this.decls.get(coll);
        if (!d) return coll;
        return d.cloudCollection ?? coll;
    }

    /* ─── Node ops ─────────────────────────────────────────────── */

    async upsert<T extends Record<string, unknown>>(
        coll: string,
        keyField: string,
        doc: T,
    ): Promise<void> {
        const keyVal = doc[keyField];
        if (keyVal === undefined || keyVal === null || keyVal === '') {
            throw new Error(
                `DataplaneCollectionStorage.upsert: doc.${keyField} is required (got ${JSON.stringify(keyVal)})`,
            );
        }
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const filter = { [`${keyField}_eq`]: keyVal };
        const res = await this.client.updateByQuery(tenantId, target, filter, doc, this.connection);
        if ((res?.updated ?? 0) === 0) {
            await this.client.insert(tenantId, target, doc, this.connection);
        }
    }

    async get<T = Record<string, unknown>>(
        coll: string,
        keyField: string,
        key: unknown,
    ): Promise<T | null> {
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const res = await this.client.query<Record<string, unknown>>(
            tenantId,
            target,
            { filter: { [`${keyField}_eq`]: key }, limit: 1 },
            this.connection,
        );
        return (res.records?.[0] as T | undefined) ?? null;
    }

    async find<T = Record<string, unknown>>(
        coll: string,
        filter: Filter,
        opts?: FindOptions,
    ): Promise<T[]> {
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const dpFilter = filterToDataplane(filter);
        const queryOpts: Record<string, unknown> = { filter: dpFilter };
        if (typeof opts?.limit === 'number' && opts.limit >= 0) queryOpts['limit'] = Math.floor(opts.limit);
        if (opts?.orderBy) {
            queryOpts['order_by'] = opts.orderBy;
            queryOpts['order_dir'] = opts.orderDir === 'desc' ? 'desc' : 'asc';
        }
        const res = await this.client.query<Record<string, unknown>>(
            tenantId,
            target,
            queryOpts,
            this.connection,
        );
        return (res.records ?? []) as T[];
    }

    async count(coll: string, filter?: Filter): Promise<number> {
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const dpFilter = filterToDataplane(filter);
        return await this.client.count(tenantId, target, dpFilter, this.connection);
    }

    async deleteWhere(coll: string, filter: Filter): Promise<number> {
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const dpFilter = filterToDataplane(filter);
        const res = await this.client.deleteByQuery(tenantId, target, dpFilter, this.connection);
        return res?.deleted ?? 0;
    }

    /* ─── Edge ops ─────────────────────────────────────────────── */

    async addEdge(
        coll: string,
        sourceId: string,
        targetId: string,
        props: Record<string, unknown> = {},
        _hint?: EdgeShapeHint,
    ): Promise<void> {
        // Cloud edges are plain rows in a regular collection. The hint
        // is ignored — kept on the interface for local-engine parity (and as a
        // legacy override for undeclared collections); slice 5c plugins
        // pass nothing here.
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const id = `${sourceId}__${targetId}`;
        await this.client.insert(
            tenantId,
            target,
            {
                id,
                source_id: sourceId,
                target_id: targetId,
                ...props,
            },
            this.connection,
        );
    }

    async upsertEdge(
        coll: string,
        sourceId: string,
        targetId: string,
        props: Record<string, unknown> = {},
        _hint?: EdgeShapeHint,
    ): Promise<void> {
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const id = `${sourceId}__${targetId}`;
        const doc = { id, source_id: sourceId, target_id: targetId, ...props };
        const filter = { source_id_eq: sourceId, target_id_eq: targetId };
        const res = await this.client.updateByQuery(tenantId, target, filter, doc, this.connection);
        if ((res?.updated ?? 0) === 0) {
            await this.client.insert(tenantId, target, doc, this.connection);
        }
    }

    async traverse<TProps = Record<string, unknown>>(
        coll: string,
        anchorId: string,
        dir: 'in' | 'out' | 'both',
        opts?: TraverseOptions,
        _hint?: EdgeShapeHint,
    ): Promise<EdgeRow<TProps>[]> {
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const baseFilter = filterToDataplane(opts?.filter);
        const limit = typeof opts?.limit === 'number' && opts.limit >= 0 ? Math.floor(opts.limit) : undefined;

        const queryOnce = async (anchorKey: 'source_id_eq' | 'target_id_eq') => {
            const f = { ...baseFilter, [anchorKey]: anchorId };
            const queryOpts: Record<string, unknown> = { filter: f };
            if (limit !== undefined) queryOpts['limit'] = limit;
            const res = await this.client.query<Record<string, unknown>>(
                tenantId,
                target,
                queryOpts,
                this.connection,
            );
            return res.records ?? [];
        };

        let rows: Array<Record<string, unknown>> = [];
        if (dir === 'out') {
            rows = await queryOnce('source_id_eq');
        } else if (dir === 'in') {
            rows = await queryOnce('target_id_eq');
        } else {
            // 'both' — two queries, dedup by row id when present, then
            // honor limit.
            const [outRows, inRows] = await Promise.all([
                queryOnce('source_id_eq'),
                queryOnce('target_id_eq'),
            ]);
            const seen = new Set<string>();
            for (const r of [...outRows, ...inRows]) {
                const key = String(r['id'] ?? `${r['source_id']}__${r['target_id']}`);
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push(r);
                if (limit !== undefined && rows.length >= limit) break;
            }
        }

        return rows.map((r) => {
            const sourceId = String(r['source_id'] ?? '');
            const targetId = String(r['target_id'] ?? '');
            // edgeProps = the row minus the structural columns.
            const edgeProps: Record<string, unknown> = { ...r };
            delete edgeProps['source_id'];
            delete edgeProps['target_id'];
            return { edgeProps: edgeProps as TProps, sourceId, targetId };
        });
    }

    async deleteEdgesWhere(
        coll: string,
        filter: Filter,
        _hint?: EdgeShapeHint,
    ): Promise<number> {
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const dpFilter = filterToDataplane(remapEdgeFilterKeys(filter));
        const res = await this.client.deleteByQuery(tenantId, target, dpFilter, this.connection);
        return res?.deleted ?? 0;
    }

    async countEdges(
        coll: string,
        filter?: Filter,
        _hint?: EdgeShapeHint,
    ): Promise<number> {
        const tenantId = this.tenantProvider();
        const target = this.resolveCloudColl(coll);
        const dpFilter = filterToDataplane(remapEdgeFilterKeys(filter));
        return await this.client.count(tenantId, target, dpFilter, this.connection);
    }
}

/**
 * Remap portable edge-filter keys (`sourceId` / `targetId`) onto the
 * cloud's column names (`source_id` / `target_id`) before the suffix
 * translation. Used by both `deleteEdgesWhere` and `countEdges` so the
 * shorthand works identically.
 */
function remapEdgeFilterKeys(filter: Filter | undefined): Filter | undefined {
    if (!filter) return filter;
    const remapBag = (
        src: Record<string, unknown> | undefined,
    ): Record<string, unknown> | undefined => {
        if (!src) return src;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(src)) {
            if (k === 'sourceId') out['source_id'] = v;
            else if (k === 'targetId') out['target_id'] = v;
            else out[k] = v;
        }
        return out;
    };
    // Build via the index signature so each operator key is accepted
    // without a per-field cast (the index signature on Filter accepts
    // Record<string, unknown> | undefined for any string key).
    const remapped: Filter = {};
    const ops: Array<keyof Filter> = ['eq', 'contains', 'startsWith', 'gt', 'gte', 'lt', 'lte', 'in'];
    for (const op of ops) {
        remapped[op] = remapBag(filter[op] as Record<string, unknown> | undefined);
    }
    return remapped;
}

/**
 * dataplaneCollectionStorage.ts — Q2.2 slice 5a. Dataplane-backed CollectionStorage
 * adapter (cloud mode).
 *
 * Translates the substrate-portable `Filter` shape into the engine's tagged
 * filter tree (`{field:{field,operator,value}}` clauses AND'd with org + Lore
 * workspace by the shared scope builder — there is no flat/suffix filter format).
 * The same calls run on SQLite via sqliteTableStorage.ts in local mode.
 *
 * Edge model (cloud):
 *   Edges live in plain collections with `source_id` / `target_id`
 *   string columns. Unlike a Cypher-based graph engine, there's no
 *   MATCH-on-REL syntax to honor — `traverse` is a plain `query` with
 *   `source_id eq` (out), `target_id eq` (in), or two queries unioned
 *   (both). The EdgeShapeHint argument is therefore ignored. We accept
 *   it on the interface to keep the local collection storage and
 *   DataplaneCollectionStorage substitutable; slice 5c removes the hint
 *   entirely.
 *
 * Scope:
 *   Like DataplaneGraph, this adapter calls `scopeProvider()` per op
 *   (org + Lore workspace from AsyncLocalStorage; fails closed when unbound).
 *   Every row carries org_id + lore_workspace + lore_id, its physical `id` is
 *   the D2 row key, and reads map `lore_id` back to `id`. The adapter does NOT
 *   mutate AsyncLocalStorage — it's a pure consumer.
 *
 * Idempotency:
 *   `upsert` uses the scoped updateByQuery → insert-on-0 pattern that
 *   DataplaneGraph.upsertNode uses. Re-runs
 *   are safe; no duplicate rows.
 *
 * Schema provisioning:
 *   This adapter does NOT createCollection at write time. Callers
 *   declare their cloud collections in `registerCloudSchema` (slice 4),
 *   pushed lazily on each tenant's first touch. If a caller writes to a
 *   collection it forgot to declare, the SDK error from the missing
 *   collection bubbles up here unchanged.
 */

import type {
    CollectionDecl,
    EdgeRow,
    EdgeShapeHint,
    Filter,
    FindOptions,
    CollectionStorage,
    TraverseOptions,
} from './collectionStorage.js';
import {
    buildDataplaneScopeFilter,
    scopeRowFields,
    type DataplaneScope,
    type EngineOp,
    type ScopeFilterInput,
} from './dataplaneScopeFilter.js';
import { keepInScope, scopedCount, scopedDelete, scopedGetRow, scopedUpsert, unscopeRow } from './dataplaneScopedIo.js';

/**
 * Narrow SDK surface this adapter uses. Mirrors the shape declared in
 * dataplaneGraph.ts so the arch test's "no direct cloud-driver" rule
 * stays satisfied — we never pull in pg/arangojs/etc. directly.
 */
export interface CollectionStorageSdkClient {
    get<T = unknown>(tenantId: string, collection: string, id: string, connection?: string): Promise<T>;
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
    /** Resolves the per-call scope (org + Lore workspace + Dataplane workspace); throws when no workspace is bound. */
    scopeProvider: () => DataplaneScope;
    /** Optional connector name. Same semantics as DataplaneGraph. */
    connection?: string;
}

type Extra = NonNullable<ScopeFilterInput['extra']>[number];

/** `id` is the hashed row key on the wire; the logical id lives in `lore_id`. */
const wireField = (f: string): string => (f === 'id' ? 'lore_id' : f);

/**
 * Translate a portable Filter into scope-builder `extra` clauses (each becomes a
 * tagged engine `field` clause AND'd with org + Lore workspace). Conjunction-only
 * — the Filter type forbids OR/NOT. A field carrying several operators
 * (`gt` AND `lt` on createdAt) yields one clause per operator so the AND survives.
 */
export function filterToExtra(filter: Filter | undefined): Extra[] {
    const out: Extra[] = [];
    if (!filter) return out;
    const apply = (
        op: 'eq' | 'contains' | 'startsWith' | 'gt' | 'gte' | 'lt' | 'lte' | 'in',
        engineOp: EngineOp,
    ) => {
        const bag = filter[op];
        if (!bag) return;
        for (const [field, value] of Object.entries(bag)) {
            out.push({ field: wireField(field), op: engineOp, value: value as Extra['value'] });
        }
    };
    apply('eq', 'eq');
    apply('contains', 'contains');
    apply('startsWith', 'starts_with');
    apply('gt', 'gt');
    apply('gte', 'gte');
    apply('lt', 'lt');
    apply('lte', 'lte');
    apply('in', 'in');
    return out;
}

/** Row as the portable layer sees it: logical `id`, adapter-internal scope columns hidden. */
function toPortable(row: Record<string, unknown>): Record<string, unknown> {
    const out = unscopeRow(row);
    delete out['lore_id'];
    delete out['lore_workspace'];
    delete out['org_id'];
    return out;
}

export class DataplaneCollectionStorage implements CollectionStorage {
    readonly mode = 'dataplane' as const;
    private readonly client: CollectionStorageSdkClient;
    private readonly scopeProvider: () => DataplaneScope;
    private readonly connection?: string;
    /** Slice 5c — registry of declared collections by canonical name. */
    private readonly decls = new Map<string, CollectionDecl>();

    constructor(config: DataplaneCollectionStorageConfig) {
        this.client = config.client;
        this.scopeProvider = config.scopeProvider;
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

    private crud(scope: DataplaneScope, extra: Extra[]) {
        return buildDataplaneScopeFilter(scope, { extra }, 'crud', 0);
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
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        // The logical id of the row is the key value; the physical `id` becomes
        // the D2 row key (a doc-supplied `id` that differs from the key is
        // superseded by it — the portable layer addresses rows by keyField).
        const { id: _drop, ...fields } = doc as Record<string, unknown>;
        void _drop;
        if (keyField === 'id') delete (fields as Record<string, unknown>)['id'];
        else (fields as Record<string, unknown>)[keyField] = keyVal;
        await scopedUpsert(this.client, scope, target, String(keyVal), fields, this.connection);
    }

    async get<T = Record<string, unknown>>(
        coll: string,
        keyField: string,
        key: unknown,
    ): Promise<T | null> {
        // Rows are addressed by key: upsert() derives the D2 row key from String(keyVal), so the
        // lookup is a GET by that row key (+ guardScope), not a filtered `limit: 1` query — that
        // would return an arbitrary row on connectors that ignore filters (review B #5/#6).
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        const row = await scopedGetRow(this.client, scope, target, String(key), this.connection);
        return row ? (toPortable(row) as T) : null;
    }

    async find<T = Record<string, unknown>>(
        coll: string,
        filter: Filter,
        opts?: FindOptions,
    ): Promise<T[]> {
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        const built = this.crud(scope, filterToExtra(filter));
        const queryOpts: Record<string, unknown> = { filter: built.server };
        if (typeof opts?.limit === 'number' && opts.limit >= 0) queryOpts['limit'] = Math.floor(opts.limit);
        if (opts?.orderBy) {
            queryOpts['sort'] = [{ field: wireField(opts.orderBy), direction: opts.orderDir === 'desc' ? 'desc' : 'asc' }];
        }
        const res = await this.client.query<Record<string, unknown>>(
            scope.dataplaneWorkspaceId,
            target,
            queryOpts,
            this.connection,
        );
        return keepInScope(res.records ?? [], built.clientPredicate, 'storage.find').map((r) => toPortable(r) as T);
    }

    async count(coll: string, filter?: Filter): Promise<number> {
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        return await scopedCount(this.client, scope, target, { extra: filterToExtra(filter) }, this.connection);
    }

    async deleteWhere(coll: string, filter: Filter): Promise<number> {
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        return await scopedDelete(this.client, scope, target, { extra: filterToExtra(filter) }, this.connection);
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
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        const id = `${sourceId}__${targetId}`;
        await this.client.insert(
            scope.dataplaneWorkspaceId,
            target,
            {
                ...props,
                source_id: sourceId,
                target_id: targetId,
                ...scopeRowFields(scope, id),
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
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        const id = `${sourceId}__${targetId}`;
        const { id: _drop, ...rest } = props;
        void _drop;
        await scopedUpsert(
            this.client,
            scope,
            target,
            id,
            { ...rest, source_id: sourceId, target_id: targetId },
            this.connection,
        );
    }

    async traverse<TProps = Record<string, unknown>>(
        coll: string,
        anchorId: string,
        dir: 'in' | 'out' | 'both',
        opts?: TraverseOptions,
        _hint?: EdgeShapeHint,
    ): Promise<EdgeRow<TProps>[]> {
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        const baseExtra = filterToExtra(opts?.filter);
        const limit = typeof opts?.limit === 'number' && opts.limit >= 0 ? Math.floor(opts.limit) : undefined;

        const queryOnce = async (anchorKey: 'source_id' | 'target_id') => {
            const built = this.crud(scope, [...baseExtra, { field: anchorKey, op: 'eq', value: anchorId }]);
            const queryOpts: Record<string, unknown> = { filter: built.server };
            if (limit !== undefined) queryOpts['limit'] = limit;
            const res = await this.client.query<Record<string, unknown>>(
                scope.dataplaneWorkspaceId,
                target,
                queryOpts,
                this.connection,
            );
            return keepInScope(res.records ?? [], built.clientPredicate, 'storage.traverse').map(toPortable);
        };

        let rows: Array<Record<string, unknown>> = [];
        if (dir === 'out') {
            rows = await queryOnce('source_id');
        } else if (dir === 'in') {
            rows = await queryOnce('target_id');
        } else {
            // 'both' — two queries, dedup by row id when present, then
            // honor limit.
            const [outRows, inRows] = await Promise.all([
                queryOnce('source_id'),
                queryOnce('target_id'),
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
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        return await scopedDelete(this.client, scope, target, { extra: filterToExtra(remapEdgeFilterKeys(filter)) }, this.connection);
    }

    async countEdges(
        coll: string,
        filter?: Filter,
        _hint?: EdgeShapeHint,
    ): Promise<number> {
        const scope = this.scopeProvider();
        const target = this.resolveCloudColl(coll);
        return await scopedCount(this.client, scope, target, { extra: filterToExtra(remapEdgeFilterKeys(filter)) }, this.connection);
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

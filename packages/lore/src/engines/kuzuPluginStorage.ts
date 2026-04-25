/**
 * kuzuPluginStorage.ts — Q2.2 slice 5a. Kùzu-backed PluginStorage adapter.
 *
 * Translates the substrate-portable `Filter` shape into parameterized
 * Cypher for embedded Kùzu (local mode). Plugins call the high-level
 * methods; this file owns every Cypher string that talks to a plugin
 * collection.
 *
 * Why an adapter instead of "just write Cypher in plugins":
 *   - Cypher is Kùzu-specific. Cloud-mode (Dataplane) speaks AQL/SQL via
 *     a higher-level SDK, and we want one set of plugin code working on
 *     both. The Filter→Cypher translation here is mirrored by the
 *     Filter→SDK translation in dataplanePluginStorage.ts.
 *   - Parameterized queries everywhere — no string interpolation of
 *     user-controlled values. The legacy raw-Cypher path in operations.ts
 *     used `escapeString()`, which is not safe (see localGraph.ts notes).
 *
 * Read-cache:
 *   Every mutating method calls `bumpEpoch()` so core's per-engine read
 *   cache invalidates on plugin writes. The legacy ctx.executeQuery
 *   path makes plugins call this manually; storage.* calls it for them.
 *
 * NOT in this slice:
 *   - Schema declaration. CREATE NODE TABLE / CREATE REL TABLE still
 *     happens in plugins' `registerSchema` hook against the legacy
 *     ctx.executeQuery. Slice 5c unifies that.
 *   - The EdgeShapeHint argument is unavoidable for now: Cypher MATCH
 *     against a REL needs the source/target node-table labels, and we
 *     don't have a per-collection label registry yet. Removed in 5c.
 */

import type { Connection, QueryResult } from '@kineviz/kuzu-lite';
import type {
    CollectionDecl,
    EdgeCollectionDecl,
    EdgeRow,
    EdgeShapeHint,
    Filter,
    FindOptions,
    NodeCollectionDecl,
    PluginStorage,
    TraverseOptions,
} from '../plugins/storage.js';

/**
 * Lightweight read-cache handle — only the bumpEpoch entrypoint, so the
 * adapter doesn't pull the full ReadCache type into its surface. The
 * LocalGraph hands its own readCache.bumpEpoch in.
 */
export interface ReadCacheHandle {
    bumpEpoch(): void;
}

/**
 * Each Filter clause becomes `<alias>.<field> <op> $<param>`. Stays in
 * sync between WHERE clause builders for nodes and for edges.
 */
function buildWhereClause(
    filter: Filter | undefined,
    alias: string,
    paramPrefix: string,
): { where: string; params: Record<string, unknown> } {
    if (!filter) return { where: '', params: {} };
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    let i = 0;
    const next = () => `${paramPrefix}${i++}`;

    const eq = filter.eq ?? {};
    for (const [k, v] of Object.entries(eq)) {
        const p = next();
        clauses.push(`${alias}.${k} = $${p}`);
        params[p] = v;
    }
    const contains = filter.contains ?? {};
    for (const [k, v] of Object.entries(contains)) {
        const p = next();
        clauses.push(`${alias}.${k} CONTAINS $${p}`);
        params[p] = v;
    }
    const startsWith = filter.startsWith ?? {};
    for (const [k, v] of Object.entries(startsWith)) {
        const p = next();
        clauses.push(`${alias}.${k} STARTS WITH $${p}`);
        params[p] = v;
    }
    const gt = filter.gt ?? {};
    for (const [k, v] of Object.entries(gt)) {
        const p = next();
        clauses.push(`${alias}.${k} > $${p}`);
        params[p] = v;
    }
    const gte = filter.gte ?? {};
    for (const [k, v] of Object.entries(gte)) {
        const p = next();
        clauses.push(`${alias}.${k} >= $${p}`);
        params[p] = v;
    }
    const lt = filter.lt ?? {};
    for (const [k, v] of Object.entries(lt)) {
        const p = next();
        clauses.push(`${alias}.${k} < $${p}`);
        params[p] = v;
    }
    const lte = filter.lte ?? {};
    for (const [k, v] of Object.entries(lte)) {
        const p = next();
        clauses.push(`${alias}.${k} <= $${p}`);
        params[p] = v;
    }
    const inOp = filter.in ?? {};
    for (const [k, vs] of Object.entries(inOp)) {
        // Kùzu IN against a parameterized list. Bind the array as a
        // single parameter — the substrate handles list scalar-equality.
        const p = next();
        clauses.push(`${alias}.${k} IN $${p}`);
        params[p] = vs;
    }

    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    return { where, params };
}

/**
 * Translate an edge-filter (which may use the keyset shorthand
 * `sourceId` / `source_id` / `targetId` / `target_id`) into a Cypher
 * WHERE clause that pins anchors on the source/target node aliases.
 *
 * Kùzu MATCHs an edge as `(s)-[e:Coll]->(t)`; the filter keys split into
 * three: side-pinning ids → `s.<srcIdField>` / `t.<tgtIdField>`, and
 * everything else → `e.<key>`. Used by both `deleteEdgesWhere` and
 * `countEdges` so the shorthand works identically across them.
 */
function buildEdgeWhere(
    filter: Filter | undefined,
    srcIdField: string,
    tgtIdField: string,
): { whereSql: string; params: Record<string, unknown> } {
    const f = filter ?? {};
    const eFilter: Filter = {};
    const sIdEq: unknown[] = [];
    const tIdEq: unknown[] = [];

    const splitKeyset = (
        src: Record<string, unknown> | undefined,
        dst: Record<string, unknown>,
    ) => {
        if (!src) return;
        for (const [k, v] of Object.entries(src)) {
            if (k === 'sourceId' || k === 'source_id') sIdEq.push(v);
            else if (k === 'targetId' || k === 'target_id') tIdEq.push(v);
            else dst[k] = v;
        }
    };
    const cloneOp = (op: keyof Filter) => {
        const v = (f[op] ?? {}) as Record<string, unknown>;
        const dst: Record<string, unknown> = {};
        splitKeyset(v, dst);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (eFilter as any)[op] = dst;
    };
    cloneOp('eq');
    cloneOp('contains');
    cloneOp('startsWith');
    cloneOp('gt');
    cloneOp('gte');
    cloneOp('lt');
    cloneOp('lte');
    cloneOp('in');

    const { where: edgeWhere, params: edgeParams } = buildWhereClause(eFilter, 'e', 'p');
    const extraClauses: string[] = [];
    const params: Record<string, unknown> = { ...edgeParams };
    if (sIdEq.length > 0) {
        params['__src'] = sIdEq[0];
        extraClauses.push(`s.${srcIdField} = $__src`);
    }
    if (tIdEq.length > 0) {
        params['__tgt'] = tIdEq[0];
        extraClauses.push(`t.${tgtIdField} = $__tgt`);
    }
    const allWheres = [edgeWhere.replace(/^WHERE\s+/, ''), ...extraClauses].filter((s) => s.length > 0);
    const whereSql = allWheres.length > 0 ? `WHERE ${allWheres.join(' AND ')}` : '';
    return { whereSql, params };
}

/**
 * Strip the alias prefix from result keys so callers see clean field
 * names. Kùzu's `getAll()` returns keys like `n.id`, `n.label` when the
 * RETURN clause is `n.*`. Plugins shouldn't have to know about that.
 */
function stripAlias(rows: Array<Record<string, unknown>>, alias: string): Array<Record<string, unknown>> {
    const prefix = `${alias}.`;
    return rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
            if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
            else out[k] = v;
        }
        return out;
    });
}

export class KuzuPluginStorage implements PluginStorage {
    readonly mode = 'kuzu' as const;
    private readonly connection: Connection;
    private readonly readCache: ReadCacheHandle;
    private readonly ensureInit?: () => Promise<void>;
    /**
     * Slice 5c — registry of declared collections by canonical name.
     * Populated via `declareCollection`; consulted on every op to
     * resolve substrate-specific names + edge metadata. If a coll
     * name is absent, ops fall through to the legacy hint-based
     * path (or pass the name through unchanged for nodes).
     */
    private readonly decls = new Map<string, CollectionDecl>();

    constructor(
        connection: Connection,
        readCache: ReadCacheHandle,
        ensureInit?: () => Promise<void>,
    ) {
        this.connection = connection;
        this.readCache = readCache;
        this.ensureInit = ensureInit;
    }

    /* ─── Schema declaration (slice 5c) ───────────────────────── */

    declareCollection(decl: CollectionDecl): void {
        this.decls.set(decl.name, decl);
    }

    /**
     * Resolve canonical → Kùzu table label. Defaults to `coll` when no
     * declaration is registered (legacy path).
     */
    private resolveTable(coll: string): string {
        const d = this.decls.get(coll);
        if (!d) return coll;
        return d.kuzuTable ?? coll;
    }

    /**
     * Resolve a node-collection's primary key field. Defaults to "id"
     * when undeclared.
     */
    private resolveNodeKey(coll: string): string {
        const d = this.decls.get(coll);
        if (!d || d.kind !== 'node') return 'id';
        return (d as NodeCollectionDecl).primaryKey ?? 'id';
    }

    /**
     * Edge metadata for the registered edge collection — substrate
     * label + each side's primary-key field. Returns null if `coll` is
     * not declared as an edge collection (caller must fall back to the
     * explicit hint).
     */
    private resolveEdge(coll: string):
        | { srcLabel: string; tgtLabel: string; srcIdField: string; tgtIdField: string; relTable: string }
        | null {
        const d = this.decls.get(coll);
        if (!d || d.kind !== 'edge') return null;
        const e = d as EdgeCollectionDecl;
        const relTable = e.kuzuTable ?? e.name;
        const srcDecl = this.decls.get(e.source);
        const tgtDecl = this.decls.get(e.target);
        const srcLabel = (srcDecl && srcDecl.kind === 'node' ? (srcDecl as NodeCollectionDecl).kuzuTable : undefined) ?? e.source;
        const tgtLabel = (tgtDecl && tgtDecl.kind === 'node' ? (tgtDecl as NodeCollectionDecl).kuzuTable : undefined) ?? e.target;
        const srcIdField = (srcDecl && srcDecl.kind === 'node' ? (srcDecl as NodeCollectionDecl).primaryKey : undefined) ?? 'id';
        const tgtIdField = (tgtDecl && tgtDecl.kind === 'node' ? (tgtDecl as NodeCollectionDecl).primaryKey : undefined) ?? 'id';
        return { srcLabel, tgtLabel, srcIdField, tgtIdField, relTable };
    }

    /* ─── internal helpers ─────────────────────────────────────── */

    private async run(cypher: string, params: Record<string, unknown> = {}): Promise<QueryResult> {
        if (this.ensureInit) await this.ensureInit();
        if (Object.keys(params).length === 0) {
            return (await this.connection.query(cypher)) as QueryResult;
        }
        const stmt = await this.connection.prepare(cypher);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await this.connection.execute(stmt, params as any)) as QueryResult;
    }

    private async runRows(
        cypher: string,
        params: Record<string, unknown> = {},
    ): Promise<Array<Record<string, unknown>>> {
        const result = await this.run(cypher, params);
        const rows = await result.getAll();
        return rows as Array<Record<string, unknown>>;
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
                `KuzuPluginStorage.upsert: doc.${keyField} is required (got ${JSON.stringify(keyVal)})`,
            );
        }
        // Build SET clause for every field except the primary key.
        const setKeys = Object.keys(doc).filter((k) => k !== keyField);
        const params: Record<string, unknown> = { __key: keyVal };
        const setClauses: string[] = [];
        for (const k of setKeys) {
            const p = `__v_${k}`;
            setClauses.push(`n.${k} = $${p}`);
            params[p] = doc[k];
        }
        const setSql = setClauses.length > 0 ? `SET ${setClauses.join(', ')}` : '';
        const table = this.resolveTable(coll);
        const cypher = `MERGE (n:${table} {${keyField}: $__key}) ${setSql}`;
        await this.run(cypher, params);
        this.readCache.bumpEpoch();
    }

    async get<T = Record<string, unknown>>(
        coll: string,
        keyField: string,
        key: unknown,
    ): Promise<T | null> {
        const table = this.resolveTable(coll);
        const rows = await this.runRows(
            `MATCH (n:${table}) WHERE n.${keyField} = $__key RETURN n.*`,
            { __key: key },
        );
        if (rows.length === 0) return null;
        return stripAlias(rows, 'n')[0] as T;
    }

    async find<T = Record<string, unknown>>(
        coll: string,
        filter: Filter,
        opts?: FindOptions,
    ): Promise<T[]> {
        const { where, params } = buildWhereClause(filter, 'n', 'p');
        const table = this.resolveTable(coll);
        let cypher = `MATCH (n:${table}) ${where} RETURN n.*`;
        if (opts?.orderBy) {
            const dir = opts.orderDir === 'desc' ? 'DESC' : 'ASC';
            cypher += ` ORDER BY n.${opts.orderBy} ${dir}`;
        }
        if (typeof opts?.limit === 'number' && opts.limit >= 0) {
            cypher += ` LIMIT ${Math.floor(opts.limit)}`;
        }
        const rows = await this.runRows(cypher, params);
        return stripAlias(rows, 'n') as T[];
    }

    async count(coll: string, filter?: Filter): Promise<number> {
        const { where, params } = buildWhereClause(filter, 'n', 'p');
        const table = this.resolveTable(coll);
        const rows = await this.runRows(
            `MATCH (n:${table}) ${where} RETURN count(n) AS cnt`,
            params,
        );
        const n = rows[0]?.['cnt'];
        if (typeof n === 'number') return n;
        if (typeof n === 'bigint') return Number(n);
        return 0;
    }

    async deleteWhere(coll: string, filter: Filter): Promise<number> {
        const { where, params } = buildWhereClause(filter, 'n', 'p');
        const table = this.resolveTable(coll);
        // Two-pass to return the count: count first, then delete. Kùzu
        // doesn't expose affected-row counts on DELETE the way SQL does.
        const before = await this.count(coll, filter);
        if (before === 0) return 0;
        // DETACH DELETE so participating edges go too — saves plugins
        // from cleaning up edge rows manually.
        await this.run(`MATCH (n:${table}) ${where} DETACH DELETE n`, params);
        this.readCache.bumpEpoch();
        return before;
    }

    /* ─── Edge ops ─────────────────────────────────────────────── */

    async addEdge(
        coll: string,
        sourceId: string,
        targetId: string,
        props: Record<string, unknown> = {},
        hint?: EdgeShapeHint,
    ): Promise<void> {
        const shape = this.resolveEdgeShape(coll, hint);
        const propKeys = Object.keys(props);
        const params: Record<string, unknown> = { __src: sourceId, __tgt: targetId };
        const setClauses: string[] = [];
        for (const k of propKeys) {
            const p = `__p_${k}`;
            setClauses.push(`${k}: $${p}`);
            params[p] = props[k];
        }
        const propsSql = setClauses.length > 0 ? `{${setClauses.join(', ')}}` : '';
        const cypher =
            `MATCH (s:${shape.srcLabel}), (t:${shape.tgtLabel}) ` +
            `WHERE s.${shape.srcIdField} = $__src AND t.${shape.tgtIdField} = $__tgt ` +
            `CREATE (s)-[:${shape.relTable} ${propsSql}]->(t)`;
        await this.run(cypher, params);
        this.readCache.bumpEpoch();
    }

    async upsertEdge(
        coll: string,
        sourceId: string,
        targetId: string,
        props: Record<string, unknown> = {},
        hint?: EdgeShapeHint,
    ): Promise<void> {
        const shape = this.resolveEdgeShape(coll, hint);
        const propKeys = Object.keys(props);
        const params: Record<string, unknown> = { __src: sourceId, __tgt: targetId };
        const setClauses: string[] = [];
        for (const k of propKeys) {
            const p = `__p_${k}`;
            setClauses.push(`e.${k} = $${p}`);
            params[p] = props[k];
        }
        const setSql = setClauses.length > 0 ? `SET ${setClauses.join(', ')}` : '';
        const cypher =
            `MATCH (s:${shape.srcLabel}), (t:${shape.tgtLabel}) ` +
            `WHERE s.${shape.srcIdField} = $__src AND t.${shape.tgtIdField} = $__tgt ` +
            `MERGE (s)-[e:${shape.relTable}]->(t) ${setSql}`;
        await this.run(cypher, params);
        this.readCache.bumpEpoch();
    }

    async traverse<TProps = Record<string, unknown>>(
        coll: string,
        anchorId: string,
        dir: 'in' | 'out' | 'both',
        opts?: TraverseOptions,
        hint?: EdgeShapeHint,
    ): Promise<EdgeRow<TProps>[]> {
        const { srcLabel, tgtLabel, srcIdField, tgtIdField, relTable } = this.resolveEdgeShape(coll, hint);
        // Direction shapes the MATCH arrow.
        let pattern: string;
        if (dir === 'out') {
            pattern = `(s:${srcLabel})-[e:${relTable}]->(t:${tgtLabel})`;
        } else if (dir === 'in') {
            pattern = `(s:${srcLabel})-[e:${relTable}]->(t:${tgtLabel})`;
        } else {
            // 'both' — undirected match. Source/target labels both apply
            // (since the same edge collection always connects the same
            // labels), but we don't know which side the anchor will be
            // on until match time. Kùzu accepts undirected `-[e:Coll]-`.
            pattern = `(s:${srcLabel})-[e:${relTable}]-(t:${tgtLabel})`;
        }

        const anchorClause =
            dir === 'out'
                ? `s.${srcIdField} = $__anchor`
                : dir === 'in'
                  ? `t.${tgtIdField} = $__anchor`
                  : `(s.${srcIdField} = $__anchor OR t.${tgtIdField} = $__anchor)`;

        const { where: edgeWhere, params: edgeParams } = buildWhereClause(opts?.filter, 'e', 'p');
        const allWheres = [anchorClause, edgeWhere.replace(/^WHERE\s+/, '')].filter((s) => s.length > 0);
        const whereSql = `WHERE ${allWheres.join(' AND ')}`;

        let cypher = `MATCH ${pattern} ${whereSql} RETURN e.*, s.${srcIdField} AS __src, t.${tgtIdField} AS __tgt`;
        if (typeof opts?.limit === 'number' && opts.limit >= 0) {
            cypher += ` LIMIT ${Math.floor(opts.limit)}`;
        }

        const params = { __anchor: anchorId, ...edgeParams };
        const rows = await this.runRows(cypher, params);
        return rows.map((row) => {
            const sourceId = String(row['__src'] ?? '');
            const targetId = String(row['__tgt'] ?? '');
            // Strip e.* prefix and drop the alias columns.
            const edgeProps: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(row)) {
                if (k === '__src' || k === '__tgt') continue;
                if (k.startsWith('e.')) edgeProps[k.slice(2)] = v;
                else edgeProps[k] = v;
            }
            return { edgeProps: edgeProps as TProps, sourceId, targetId };
        });
    }

    async deleteEdgesWhere(
        coll: string,
        filter: Filter,
        hint?: EdgeShapeHint,
    ): Promise<number> {
        const { srcLabel, tgtLabel, srcIdField, tgtIdField, relTable } = this.resolveEdgeShape(coll, hint);
        const { whereSql, params } = buildEdgeWhere(filter, srcIdField, tgtIdField);

        // Count first (DELETE doesn't return the row count).
        const countRows = await this.runRows(
            `MATCH (s:${srcLabel})-[e:${relTable}]->(t:${tgtLabel}) ${whereSql} RETURN count(e) AS cnt`,
            params,
        );
        const cntRaw = countRows[0]?.['cnt'];
        const cnt = typeof cntRaw === 'number' ? cntRaw : typeof cntRaw === 'bigint' ? Number(cntRaw) : 0;
        if (cnt === 0) return 0;
        await this.run(
            `MATCH (s:${srcLabel})-[e:${relTable}]->(t:${tgtLabel}) ${whereSql} DELETE e`,
            params,
        );
        this.readCache.bumpEpoch();
        return cnt;
    }

    async countEdges(
        coll: string,
        filter?: Filter,
        hint?: EdgeShapeHint,
    ): Promise<number> {
        const { srcLabel, tgtLabel, srcIdField, tgtIdField, relTable } = this.resolveEdgeShape(coll, hint);
        const { whereSql, params } = buildEdgeWhere(filter, srcIdField, tgtIdField);
        const rows = await this.runRows(
            `MATCH (s:${srcLabel})-[e:${relTable}]->(t:${tgtLabel}) ${whereSql} RETURN count(e) AS cnt`,
            params,
        );
        const cntRaw = rows[0]?.['cnt'];
        if (typeof cntRaw === 'number') return cntRaw;
        if (typeof cntRaw === 'bigint') return Number(cntRaw);
        return 0;
    }

    /* ─── private ──────────────────────────────────────────────── */

    /**
     * Resolve the source/target labels + id fields + the actual REL
     * table name for an edge op. Order of resolution:
     *
     *   1. Registered EdgeCollectionDecl (slice 5c) — the preferred path.
     *   2. Explicit EdgeShapeHint (slice 5a/5b legacy) — still supported
     *      so existing callers don't break and ad-hoc / undeclared
     *      collections (test fixtures, scratch ops) can still operate.
     *
     * If neither is available, throws — Cypher MATCH on a REL fundamentally
     * needs the node-table labels.
     */
    private resolveEdgeShape(
        coll: string,
        hint: EdgeShapeHint | undefined,
    ): { srcLabel: string; tgtLabel: string; srcIdField: string; tgtIdField: string; relTable: string } {
        const declResolved = this.resolveEdge(coll);
        if (declResolved) return declResolved;
        if (!hint || !hint.srcLabel || !hint.tgtLabel) {
            throw new Error(
                `KuzuPluginStorage: edge op on '${coll}' requires either a ` +
                    `registered EdgeCollectionDecl (declareCollection) or an ` +
                    `EdgeShapeHint { srcLabel, tgtLabel } (Cypher MATCH on a ` +
                    `REL needs the node-table labels).`,
            );
        }
        const idField = hint.idField ?? 'id';
        return {
            srcLabel: hint.srcLabel,
            tgtLabel: hint.tgtLabel,
            srcIdField: hint.srcIdField ?? idField,
            tgtIdField: hint.tgtIdField ?? idField,
            relTable: coll,
        };
    }
}

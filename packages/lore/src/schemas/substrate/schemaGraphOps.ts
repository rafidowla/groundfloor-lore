/**
 * substrate/schemaGraphOps.ts — the engine-agnostic port the schema-safety
 * subsystem reads and writes the graph through.
 *
 * Why this exists
 * ---------------
 * Blast radius, the pre-destructive-change data snapshot, and the migration
 * runner all need the same handful of graph operations: count rows of a type,
 * dump them, page through them, delete them, re-insert them. These used to
 * speak raw Cypher through a `queryRows`/`executeWrite` escape hatch tied to
 * a single local graph engine, which is why `engines/graphEngineSelector.ts`
 * had to refuse the whole subsystem on a SurrealDB-backed workspace: that
 * engine's `LoreNode` table existed there and was EMPTY, so raw Cypher did
 * not fail — it succeeded and returned nothing. A blast radius of zero, an
 * empty snapshot file, and a destructive change waved through.
 *
 * Naming the operations semantically instead of as Cypher strings lets each
 * engine answer them natively. The refusal stays for anything NOT expressed
 * here — see `GraphSubstrateUnsupportedError` (`mcp/bootSteps.ts`) — because
 * the failure mode it guards against (a silently wrong answer on a safety
 * mechanism) has not changed.
 *
 * Contract notes that both implementations must honour:
 *   - `listNodesByType` returns RAW row records, because the snapshot writes
 *     them to disk verbatim and `rollbackOp` reads them back.
 *   - `pageNodesByType` is ordered by id ASC and STRICTLY after `afterId`, so
 *     a migration cursor advances deterministically and survives a crash.
 *   - `deleteNodesByType` detaches: incident edges go with the node. Leaving
 *     dangling edges is worse than removing them, and the snapshot is what
 *     makes the data recoverable.
 *   - Counts are exact, never estimates.
 */

import { tagsToArray } from '../../engines/normalizeTags.js';

/**
 * Raw Cypher escape hatch LegacySchemaGraphOps talks through. Relocated here
 * from a now-deleted module, whose only other consumer (the former
 * graph-native MigrationBackend) was deleted along with it.
 */
interface GraphReader {
    queryRows(
        cypher: string,
        params?: Record<string, unknown>,
    ): Promise<Array<Record<string, unknown>>>;
}

interface GraphWriter {
    /** Executes a write-mode Cypher statement. Result is ignored. */
    executeWrite(
        cypher: string,
        params?: Record<string, unknown>,
    ): Promise<void>;
}

/** One raw graph row, as the underlying engine projects it. */
export type SchemaRow = Record<string, unknown>;

/** An (id, metadata) pair — the shape every field-level migration walks. */
export interface NodeMetaRow {
    id: string;
    metadata: unknown;
}

export interface SchemaGraphOps {
    /** Which engine is answering. Used for error messages and reporting.
     *  'kuzu' is the legacy graph-engine sentinel — kept to match archived
     *  data/manifests, never a live engine choice. */
    readonly engine: 'kuzu' | 'surreal';

    /* ── counts (blast radius) ─────────────────────────────────────── */

    countNodesByType(type: string): Promise<number>;
    countEdgesByRelation(relation: string): Promise<number>;
    countInboundEdgesToType(type: string): Promise<number>;

    /* ── dumps (snapshot) ──────────────────────────────────────────── */

    /** Every row of `type`, raw. Used for the pre-change snapshot. */
    listNodesByType(type: string): Promise<SchemaRow[]>;
    /** Every edge carrying `relation`, with sourceId/targetId resolved. */
    listEdgesByRelation(relation: string): Promise<SchemaRow[]>;

    /* ── paging (migration batches) ────────────────────────────────── */

    /** Up to `limit` (id, metadata) rows of `type`, id ASC, id > afterId. */
    pageNodesByType(type: string, afterId: string, limit: number): Promise<NodeMetaRow[]>;
    /** Up to `sampleN` (id, label) rows of `type` — dry-run samples. */
    sampleNodesByType(type: string, sampleN: number): Promise<SchemaRow[]>;
    /** Up to `sampleN` edges of `relation` — dry-run samples. */
    sampleEdgesByRelation(relation: string, sampleN: number): Promise<SchemaRow[]>;

    /* ── mutations (migration execute + rollback) ──────────────────── */

    /** Detach-delete up to `limit` rows of `type`. Returns rows removed. */
    deleteNodesByType(type: string, limit: number): Promise<number>;
    /** Delete up to `limit` edges carrying `relation`. Returns rows removed. */
    deleteEdgesByRelation(relation: string, limit: number): Promise<number>;
    getNodeMetadata(id: string): Promise<Record<string, unknown> | null>;
    setNodeMetadata(id: string, metadata: Record<string, unknown>): Promise<void>;
    setNodeType(id: string, newType: string): Promise<void>;
    /** Re-insert a snapshot row by id (upsert semantics — rerun-safe). */
    restoreNode(row: Record<string, unknown>): Promise<void>;
    createEdge(sourceId: string, targetId: string, relation: string): Promise<void>;
}

/* ══════════════════════════════════════════════════════════════════ */
/*  LegacySchemaGraphOps — the incumbent raw-Cypher queries, moved behind */
/*  the port                                                           */
/* ══════════════════════════════════════════════════════════════════ */

/**
 * Wraps the same `GraphReader & GraphWriter` escape hatch the subsystem has
 * always used, issuing the SAME Cypher it always issued. This is deliberately
 * a transcription, not a rewrite: this class's original behaviour is the
 * reference the SurrealDB implementation is tested against, so it must not
 * drift here.
 */
export class LegacySchemaGraphOps implements SchemaGraphOps {
    /** Legacy graph-engine sentinel value — see SchemaGraphOps.engine above. */
    public readonly engine = 'kuzu' as const;

    constructor(private readonly graph: GraphReader & GraphWriter) {}

    async countNodesByType(type: string): Promise<number> {
        const rows = await this.graph.queryRows(
            `MATCH (n:LoreNode) WHERE n.type = $type RETURN count(n) AS c`,
            { type },
        );
        return Number(rows[0]?.['c'] ?? 0);
    }

    async countEdgesByRelation(relation: string): Promise<number> {
        const rows = await this.graph.queryRows(
            `MATCH (a:LoreNode)-[e:LoreEdge]->(b:LoreNode)
             WHERE e.relation = $relation
             RETURN count(e) AS c`,
            { relation },
        );
        return Number(rows[0]?.['c'] ?? 0);
    }

    async countInboundEdgesToType(type: string): Promise<number> {
        const rows = await this.graph.queryRows(
            `MATCH ()-[e:LoreEdge]->(n:LoreNode)
             WHERE n.type = $type
             RETURN count(e) AS c`,
            { type },
        );
        return Number(rows[0]?.['c'] ?? 0);
    }

    async listNodesByType(type: string): Promise<SchemaRow[]> {
        return this.graph.queryRows(
            `MATCH (n:LoreNode) WHERE n.type = $type RETURN n.*`,
            { type },
        );
    }

    async listEdgesByRelation(relation: string): Promise<SchemaRow[]> {
        return this.graph.queryRows(
            `MATCH (a:LoreNode)-[e:LoreEdge]->(b:LoreNode)
             WHERE e.relation = $relation
             RETURN a.id AS sourceId, b.id AS targetId, e.*`,
            { relation },
        );
    }

    async pageNodesByType(type: string, afterId: string, limit: number): Promise<NodeMetaRow[]> {
        const rows = await this.graph.queryRows(
            `MATCH (n:LoreNode) WHERE n.type = $type AND n.id > $cursor
             RETURN n.id AS id, n.metadata AS metadata
             ORDER BY n.id LIMIT ${limit}`,
            { type, cursor: afterId },
        );
        return rows.map((r) => ({ id: String(r['id']), metadata: r['metadata'] }));
    }

    async sampleNodesByType(type: string, sampleN: number): Promise<SchemaRow[]> {
        return this.graph.queryRows(
            `MATCH (n:LoreNode) WHERE n.type = $type
             RETURN n.id AS id, n.label AS label LIMIT ${sampleN}`,
            { type },
        );
    }

    async sampleEdgesByRelation(relation: string, sampleN: number): Promise<SchemaRow[]> {
        return this.graph.queryRows(
            `MATCH (a:LoreNode)-[e:LoreEdge]->(b:LoreNode)
             WHERE e.relation = $relation
             RETURN a.id AS sourceId, b.id AS targetId, e.relation AS relation
             LIMIT ${sampleN}`,
            { relation },
        );
    }

    async deleteNodesByType(type: string, limit: number): Promise<number> {
        const remaining = await this.countNodesByType(type);
        if (remaining === 0) return 0;
        await this.graph.executeWrite(
            `MATCH (n:LoreNode) WHERE n.type = $type WITH n LIMIT ${limit} DETACH DELETE n`,
            { type },
        );
        return Math.min(remaining, limit);
    }

    async deleteEdgesByRelation(relation: string, limit: number): Promise<number> {
        const remaining = await this.countEdgesByRelation(relation);
        if (remaining === 0) return 0;
        await this.graph.executeWrite(
            `MATCH (a:LoreNode)-[e:LoreEdge]->(b:LoreNode)
             WHERE e.relation = $relation
             WITH e LIMIT ${limit} DELETE e`,
            { relation },
        );
        return Math.min(remaining, limit);
    }

    async getNodeMetadata(id: string): Promise<Record<string, unknown> | null> {
        const rows = await this.graph.queryRows(
            `MATCH (n:LoreNode {id: $id}) RETURN n.metadata AS metadata`,
            { id },
        );
        return rows.length > 0 ? parseMetadata(rows[0]!['metadata']) : null;
    }

    async setNodeMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
        await this.graph.executeWrite(
            `MATCH (n:LoreNode {id: $id}) SET n.metadata = $newJson`,
            { id, newJson: JSON.stringify(metadata) },
        );
    }

    async setNodeType(id: string, newType: string): Promise<void> {
        await this.graph.executeWrite(
            `MATCH (n:LoreNode {id: $id}) SET n.type = $newType`,
            { id, newType },
        );
    }

    async restoreNode(props: Record<string, unknown>): Promise<void> {
        await this.graph.executeWrite(
            `MERGE (n:LoreNode {id: $id})
             SET n.type = $type, n.label = $label, n.content = $content,
                 n.tags = $tags, n.project = $project, n.ecosystem = $ecosystem,
                 n.metadata = $metadata, n.language = $language,
                 n.ephemeral = $ephemeral, n.ttl_ms = $ttl_ms,
                 n.createdAt = $createdAt, n.updatedAt = $updatedAt,
                 n.syncedAt = $syncedAt`,
            {
                id: props['id'],
                type: props['type'] ?? '',
                label: props['label'] ?? '',
                content: props['content'] ?? '',
                tags: tagsToArray(props['tags'] as string | string[] | null | undefined),
                project: props['project'] ?? '*',
                ecosystem: props['ecosystem'] ?? '*',
                metadata: props['metadata'] ?? '{}',
                language: props['language'] ?? null,
                ephemeral: props['ephemeral'] ?? false,
                ttl_ms: props['ttl_ms'] ?? null,
                createdAt: props['createdAt'] ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                syncedAt: props['syncedAt'] ?? null,
            },
        );
    }

    async createEdge(sourceId: string, targetId: string, relation: string): Promise<void> {
        await this.graph.executeWrite(
            `MATCH (a:LoreNode {id: $sourceId}), (b:LoreNode {id: $targetId})
             CREATE (a)-[e:LoreEdge {relation: $relation}]->(b)`,
            { sourceId, targetId, relation },
        );
    }
}

/* ── shared helper ─────────────────────────────────────────────────── */

/** Metadata is stored as a JSON string; tolerate an already-parsed object. */
export function parseMetadata(raw: unknown): Record<string, unknown> | null {
    if (typeof raw === 'string') {
        try {
            const v = JSON.parse(raw);
            return v && typeof v === 'object' && !Array.isArray(v)
                ? v as Record<string, unknown>
                : null;
        } catch {
            return null;
        }
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    return null;
}

/**
 * sqlite/sqliteSchemaGraphOps.ts — SQLite half of the schema-safety port
 * (`schemas/substrate/schemaGraphOps.ts`). Mirrors
 * `surreal/surrealSchemaGraphOps.ts` operation-for-operation: reads are raw
 * SQL here; every MUTATION delegates to the engine verb that already exists
 * and is already tested (same "don't reimplement a write the engine already
 * implements" rule that file documents).
 */

import type { NodeMetaRow, SchemaGraphOps, SchemaRow } from '../../schemas/substrate/schemaGraphOps.js';
import { parseMetadata } from '../../schemas/substrate/schemaGraphOps.js';
import { LoreGraphError } from '../loreGraphError.js';
import type { SqliteDb } from './sqliteGraphSchema.js';

function sqliteError(op: string, error: unknown): LoreGraphError {
    return new LoreGraphError(op, 'schemaOps', error);
}

export interface SqliteSchemaOpsDeps {
    db: SqliteDb;
    deleteNode(id: string): Promise<boolean>;
    deleteEdge(sourceId: string, targetId: string, relation: string): Promise<number>;
    addEdge(edge: { sourceId: string; targetId: string; relation: string }): Promise<void>;
    upsertNode(node: Record<string, unknown>): Promise<unknown>;
}

export class SqliteSchemaGraphOps implements SchemaGraphOps {
    public readonly engine = 'sqlite' as const;

    constructor(private readonly deps: SqliteSchemaOpsDeps) {}

    private get db(): SqliteDb { return this.deps.db; }

    async countNodesByType(type: string): Promise<number> {
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE type = ?').get(type) as { c: number };
            return Number(row?.c ?? 0);
        } catch (error) { throw sqliteError(`countNodesByType('${type}')`, error); }
    }

    async countEdgesByRelation(relation: string): Promise<number> {
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS c FROM edges WHERE relation = ?').get(relation) as { c: number };
            return Number(row?.c ?? 0);
        } catch (error) { throw sqliteError(`countEdgesByRelation('${relation}')`, error); }
    }

    async countInboundEdgesToType(type: string): Promise<number> {
        try {
            const row = this.db.prepare(
                `SELECT COUNT(*) AS c FROM edges e JOIN nodes n ON n.id = e.target_id WHERE n.type = ?`,
            ).get(type) as { c: number };
            return Number(row?.c ?? 0);
        } catch (error) { throw sqliteError(`countInboundEdgesToType('${type}')`, error); }
    }

    async listNodesByType(type: string): Promise<SchemaRow[]> {
        try {
            return this.db.prepare('SELECT * FROM nodes WHERE type = ?').all(type) as SchemaRow[];
        } catch (error) { throw sqliteError(`listNodesByType('${type}')`, error); }
    }

    async listEdgesByRelation(relation: string): Promise<SchemaRow[]> {
        try {
            const rows = this.db.prepare(
                'SELECT source_id, target_id, relation, confidence, confidenceScore FROM edges WHERE relation = ?',
            ).all(relation) as Array<{ source_id: string; target_id: string }>;
            return rows.map((r) => ({ ...r, sourceId: r.source_id, targetId: r.target_id }));
        } catch (error) { throw sqliteError(`listEdgesByRelation('${relation}')`, error); }
    }

    async pageNodesByType(type: string, afterId: string, limit: number): Promise<NodeMetaRow[]> {
        try {
            const rows = afterId
                ? this.db.prepare('SELECT id, metadata FROM nodes WHERE type = ? AND id > ? ORDER BY id ASC LIMIT ?').all(type, afterId, limit)
                : this.db.prepare('SELECT id, metadata FROM nodes WHERE type = ? ORDER BY id ASC LIMIT ?').all(type, limit);
            return (rows as Array<{ id: string; metadata: unknown }>).map((r) => ({ id: r.id, metadata: r.metadata }));
        } catch (error) { throw sqliteError(`pageNodesByType('${type}')`, error); }
    }

    async sampleNodesByType(type: string, sampleN: number): Promise<SchemaRow[]> {
        try {
            return this.db.prepare('SELECT id, label FROM nodes WHERE type = ? LIMIT ?').all(type, sampleN) as SchemaRow[];
        } catch (error) { throw sqliteError(`sampleNodesByType('${type}')`, error); }
    }

    async sampleEdgesByRelation(relation: string, sampleN: number): Promise<SchemaRow[]> {
        try {
            const rows = this.db.prepare('SELECT source_id, target_id, relation FROM edges WHERE relation = ? LIMIT ?')
                .all(relation, sampleN) as Array<{ source_id: string; target_id: string; relation: string }>;
            return rows.map((r) => ({ sourceId: r.source_id, targetId: r.target_id, relation: r.relation }));
        } catch (error) { throw sqliteError(`sampleEdgesByRelation('${relation}')`, error); }
    }

    /** Detach-delete up to `limit` rows of `type`. Incident edges go first — delegates to `deleteNode`, same as the Surreal side. */
    async deleteNodesByType(type: string, limit: number): Promise<number> {
        let victims: Array<{ id: string }>;
        try {
            victims = this.db.prepare('SELECT id FROM nodes WHERE type = ? ORDER BY id ASC LIMIT ?').all(type, limit) as Array<{ id: string }>;
        } catch (error) { throw sqliteError(`deleteNodesByType('${type}') scan`, error); }
        let removed = 0;
        for (const row of victims) {
            if (await this.deps.deleteNode(row.id)) removed++;
        }
        return removed;
    }

    async deleteEdgesByRelation(relation: string, limit: number): Promise<number> {
        let victims: Array<{ source_id: string; target_id: string }>;
        try {
            victims = this.db.prepare('SELECT source_id, target_id FROM edges WHERE relation = ? LIMIT ?')
                .all(relation, limit) as Array<{ source_id: string; target_id: string }>;
        } catch (error) { throw sqliteError(`deleteEdgesByRelation('${relation}') scan`, error); }
        let removed = 0;
        for (const row of victims) {
            removed += await this.deps.deleteEdge(row.source_id, row.target_id, relation);
        }
        return removed;
    }

    async getNodeMetadata(id: string): Promise<Record<string, unknown> | null> {
        try {
            const row = this.db.prepare('SELECT metadata FROM nodes WHERE id = ?').get(id) as { metadata: unknown } | undefined;
            return row ? parseMetadata(row.metadata) : null;
        } catch (error) { throw sqliteError(`getNodeMetadata('${id}')`, error); }
    }

    async setNodeMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
        try {
            this.db.prepare('UPDATE nodes SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), id);
        } catch (error) { throw sqliteError(`setNodeMetadata('${id}')`, error); }
    }

    async setNodeType(id: string, newType: string): Promise<void> {
        try {
            this.db.prepare('UPDATE nodes SET type = ? WHERE id = ?').run(newType, id);
        } catch (error) { throw sqliteError(`setNodeType('${id}')`, error); }
    }

    /** Same field mapping as SurrealSchemaGraphOps.restoreNode — upsertNode for everything, then repair createdAt/syncedAt directly. */
    async restoreNode(props: Record<string, unknown>): Promise<void> {
        const id = String(props['id'] ?? '');
        if (!id) return;
        try {
            await this.deps.upsertNode({
                id,
                type: String(props['type'] ?? ''),
                label: String(props['label'] ?? ''),
                content: String(props['content'] ?? ''),
                tags: Array.isArray(props['tags'])
                    ? props['tags']
                    : typeof props['tags'] === 'string' && props['tags']
                        ? String(props['tags']).split(',').map((t) => t.trim()).filter(Boolean)
                        : [],
                project: String(props['project'] ?? '*'),
                ecosystem: String(props['ecosystem'] ?? '*'),
                metadata: typeof props['metadata'] === 'string' ? props['metadata'] : JSON.stringify(props['metadata'] ?? {}),
                language: props['language'] ?? null,
                ephemeral: Boolean(props['ephemeral'] ?? false),
                ttl_ms: (props['ttl_ms'] as number | null | undefined) ?? null,
            });
            const createdAt = props['createdAt'];
            const syncedAt = props['syncedAt'];
            const sets: string[] = [];
            const params: unknown[] = [];
            if (typeof createdAt === 'string' && createdAt) { sets.push('createdAt = ?'); params.push(createdAt); }
            if (typeof syncedAt === 'string' && syncedAt) { sets.push('syncedAt = ?'); params.push(syncedAt); }
            if (sets.length > 0) {
                params.push(id);
                this.db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
            }
        } catch (error) { throw sqliteError(`restoreNode('${id}')`, error); }
    }

    async createEdge(sourceId: string, targetId: string, relation: string): Promise<void> {
        try {
            await this.deps.addEdge({ sourceId, targetId, relation });
        } catch (error) { throw sqliteError(`createEdge('${sourceId}' -> '${targetId}')`, error); }
    }
}

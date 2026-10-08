/**
 * visibleSchemaPreview.ts — schema-change previews for a BOUND non-operator.
 *
 * The schema dry-run (POST /api/schema/migrations/dry-run) and the blast radius
 * on schema_propose / POST /api/schema/proposals count "rows affected" and
 * sample rows from the raw schema-ops port, which ignores row-level
 * `security_scopes`. For an app token that disclosed counts and ids of rows it
 * cannot read. Decision (product owner): filter, do not block — agents are
 * meant to propose schema changes — so a bound non-operator gets the same
 * report computed over the rows it can see (security/visibleCounts.ts):
 *   - affectedRowCount / readerCount / the blast-radius total are visible-only;
 *   - sampleRows are drawn from visible rows only (sampled from the visible
 *     rows within the scan cap, not dropped from a raw sample);
 *   - the result is labelled `countScope: 'visible'`, plus `countsLowerBound`
 *     when any scan hit SCOPE_PAGE_FILL_MAX_SCAN.
 * Unbound callers and daemon operators never enter this module (countAudience()).
 */

import {
    countVisibleEdges, countVisibleNodes, forEachVisibleEdge, forEachVisibleNode,
    type VisibleCountGraph, type VisibleEdgeGraph,
} from '../security/visibleCounts.js';
import { parseMetadata } from './substrate/schemaGraphOps.js';
import type { SchemaGraphOps } from './substrate/schemaGraphOps.js';
import {
    UNSUPPORTED_OP_ERROR,
    type DryRunOpResult, type DryRunReport, type MigrationOp, type MigrationPlan,
} from './migration/types.js';

/** Graph surface the previews read: full rows (with security_scopes) + edges. */
export type VisibleSchemaGraph = VisibleCountGraph & VisibleEdgeGraph;

/** The three counts computeBlastRadius reads — satisfied by SchemaGraphOps and by VisibleSchemaPreview. */
export type BlastRadiusCounts = Pick<SchemaGraphOps, 'countNodesByType' | 'countEdgesByRelation' | 'countInboundEdgesToType'>;

const DEFAULT_SAMPLE_N = 3;

/** Response labels added to a visible-only preview. */
export interface VisibleCountLabel {
    countScope: 'visible';
    countsLowerBound?: true;
}

export class VisibleSchemaPreview implements BlastRadiusCounts {
    /** Set once any scan hit the cap: every number computed so far is a lower bound. */
    lowerBound = false;

    constructor(private readonly graph: VisibleSchemaGraph, private readonly cap?: number) {}

    /** `countScope` (+ `countsLowerBound` when capped) for the response. */
    label(): VisibleCountLabel {
        return { countScope: 'visible', ...(this.lowerBound ? { countsLowerBound: true as const } : {}) };
    }

    async countNodesByType(type: string): Promise<number> {
        const r = await countVisibleNodes(this.graph, { type, cap: this.cap });
        if (r.lowerBound) this.lowerBound = true;
        return r.nodeCount;
    }

    async countEdgesByRelation(relation: string): Promise<number> {
        const r = await countVisibleEdges(this.graph, { relation, cap: this.cap });
        if (r.lowerBound) this.lowerBound = true;
        return r.edgeCount;
    }

    /** Visible inbound edges that terminate on a visible node of `type`. */
    async countInboundEdgesToType(type: string): Promise<number> {
        const r = await countVisibleEdges(this.graph, { targetType: type, cap: this.cap });
        if (r.lowerBound) this.lowerBound = true;
        return r.edgeCount;
    }

    /** Visible-only counterpart of SchemaGraphOpsMigrationBackend.dryRunOp. */
    async dryRunOp(op: MigrationOp, sampleN: number = DEFAULT_SAMPLE_N): Promise<Omit<DryRunOpResult, 'op'>> {
        switch (op.kind) {
            case 'node_type.removed':
            case 'node_type.renamed':
                return this.dryRunNodeType(op.target, sampleN);
            case 'edge_type.removed':
                return this.dryRunEdgeType(op.target, sampleN);
            case 'field.removed':
            case 'field.type_changed':
                return this.dryRunField(op.target, sampleN);
            case 'node_type.kind_changed':
            case 'field.sensitivity_flipped':
            case 'permission.changed':
            case 'permission.removed':
                return {
                    affectedRowCount: 0,
                    note: `${op.kind} is a schema-only change; no row-level data transformation`,
                };
            default:
                throw new Error(UNSUPPORTED_OP_ERROR);
        }
    }

    private async dryRunNodeType(type: string, sampleN: number): Promise<Omit<DryRunOpResult, 'op'>> {
        let affectedRowCount = 0;
        const sampleRows: Array<{ id: unknown; label: unknown }> = [];
        const r = await forEachVisibleNode(this.graph, { type, cap: this.cap }, (row) => {
            affectedRowCount++;
            if (sampleRows.length < sampleN) sampleRows.push({ id: row['id'], label: row['label'] });
        });
        if (r.lowerBound) this.lowerBound = true;
        return affectedRowCount === 0 ? { affectedRowCount } : { affectedRowCount, sampleRows };
    }

    private async dryRunEdgeType(relation: string, sampleN: number): Promise<Omit<DryRunOpResult, 'op'>> {
        let affectedRowCount = 0;
        const sampleRows: Array<{ sourceId: string; targetId: string; relation: string }> = [];
        const r = await forEachVisibleEdge(this.graph, { relation, cap: this.cap }, (e) => {
            affectedRowCount++;
            if (sampleRows.length < sampleN) sampleRows.push({ sourceId: e.sourceId, targetId: e.targetId, relation: e.relation });
        });
        if (r.lowerBound) this.lowerBound = true;
        return affectedRowCount === 0 ? { affectedRowCount } : { affectedRowCount, sampleRows };
    }

    private async dryRunField(target: string, sampleN: number): Promise<Omit<DryRunOpResult, 'op'>> {
        const dot = target.lastIndexOf('.');
        const nodeType = dot < 0 ? target : target.slice(0, dot);
        const field = dot < 0 ? '' : target.slice(dot + 1);
        let affectedRowCount = 0;
        const sampleRows: Array<{ id: unknown; presentKeys: string[] }> = [];
        const r = await forEachVisibleNode(this.graph, { type: nodeType, cap: this.cap }, (row) => {
            const meta = parseMetadata(row['metadata']);
            if (!meta || !Object.prototype.hasOwnProperty.call(meta, field)) return;
            affectedRowCount++;
            if (sampleRows.length < sampleN) sampleRows.push({ id: row['id'], presentKeys: Object.keys(meta) });
        });
        if (r.lowerBound) this.lowerBound = true;
        return affectedRowCount === 0 ? { affectedRowCount } : { affectedRowCount, sampleRows };
    }

    /**
     * Visible-only DryRunReport. Mirrors MigrationRunner.dryRun: per-op failures
     * are recorded in-band, the total sums the per-op counts.
     */
    async dryRun(plan: MigrationPlan, sampleN: number = DEFAULT_SAMPLE_N): Promise<DryRunReport & VisibleCountLabel> {
        const ops: DryRunOpResult[] = [];
        for (const op of plan.ops) {
            try {
                ops.push({ op, ...(await this.dryRunOp(op, sampleN)) });
            } catch (err) {
                ops.push({
                    op,
                    affectedRowCount: 0,
                    note: (err as Error).message === UNSUPPORTED_OP_ERROR
                        ? `migration backend doesn't yet support kind '${op.kind}'`
                        : `dry-run failed: ${(err as Error).message}`,
                });
            }
        }
        const totalAffected = ops.reduce((s, r) => s + r.affectedRowCount, 0);
        return { ops, totalAffected, computedAt: new Date().toISOString(), ...this.label() };
    }
}

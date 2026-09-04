/**
 * migration/schemaGraphOpsBackend.ts — engine-agnostic MigrationBackend.
 *
 * Same MVP scope as the former graph-native MigrationBackend (deleted once
 * this class and `SurrealSchemaGraphOps` fully superseded it) — the class
 * this one was derived from, line-for-line, op by op:
 * `node_type.removed`, `node_type.renamed`, `node_type.kind_changed`,
 * `field.removed`, `field.type_changed`, `field.sensitivity_flipped`,
 * `edge_type.removed`, `permission.changed`, `permission.removed`.
 *
 * Built on `SchemaGraphOps` (`schemas/substrate/schemaGraphOps.ts`) instead
 * of raw Cypher, so it runs unmodified against either engine's
 * implementation — `LegacySchemaGraphOps` (a verbatim transcription of the
 * former backend's own Cypher, so behaviour there is unchanged) or
 * `SurrealSchemaGraphOps`. Selected in `schemas/orchestration/wiring.ts`,
 * which picks the ops instance for the boot workspace's actual engine.
 *
 * One real behavioural difference from the port's primitives:
 * `dryRunFieldRemoved` needs an EXACT affected-row count over the entire
 * population of a type, but `SchemaGraphOps` only exposes bounded paging
 * (`pageNodesByType`), not an unbounded dump — the former backend's single
 * unbounded Cypher query has no port equivalent by design (the port's
 * contract is deliberately bounded everywhere else). This class pages to
 * exhaustion instead: more round trips than one query, functionally
 * identical result.
 *
 * `executeNodeTypeRemovedBatch` / `executeEdgeTypeRemovedBatch` count twice
 * per batch (once here to derive `nextCursor`, once inside the port's own
 * `deleteNodesByType`/`deleteEdgesByRelation`, which pre-counts to know how
 * many rows it actually removed) rather than trusting `removed === batchSize`
 * — that comparison is off by one exactly when `remaining === batchSize`
 * (nothing left, but the batch still filled). One extra count query per
 * batch is the accepted cost of not shipping that bug into a safety path.
 */

import {
    UNSUPPORTED_OP_ERROR,
    type BatchResult,
    type DryRunOpResult,
    type MigrationBackend,
    type MigrationOp,
    type RollbackOpResult,
} from './types.js';
import type { SchemaGraphOps } from '../substrate/schemaGraphOps.js';
import { parseMetadata } from '../substrate/schemaGraphOps.js';

const DEFAULT_SAMPLE_N = 3;
/** Page size for `dryRunFieldRemoved`'s exhaustive walk — the only op that
 *  needs an unbounded count and has no unbounded port primitive. */
const FIELD_DRY_RUN_PAGE_SIZE = 500;

export class SchemaGraphOpsMigrationBackend implements MigrationBackend {
    constructor(private readonly ops: SchemaGraphOps) {}

    async dryRunOp(
        op: MigrationOp,
        sampleN: number = DEFAULT_SAMPLE_N,
    ): Promise<Omit<DryRunOpResult, 'op'>> {
        switch (op.kind) {
            case 'node_type.removed':
                return this.dryRunNodeTypeRemoved(op.target, sampleN);
            case 'field.removed':
                return this.dryRunFieldRemoved(op.target, sampleN);
            case 'edge_type.removed':
                return this.dryRunEdgeTypeRemoved(op.target, sampleN);
            case 'node_type.renamed':
                // Same affected-row shape as node_type.removed: all rows
                // whose type matches the OLD name.
                return this.dryRunNodeTypeRemoved(op.target, sampleN);
            case 'field.type_changed':
                // Same affected-row shape as field.removed: all rows of the
                // parent type that carry the field.
                return this.dryRunFieldRemoved(op.target, sampleN);
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

    async executeOpBatch(
        op: MigrationOp,
        cursor: string | null,
        batchSize: number,
    ): Promise<BatchResult> {
        switch (op.kind) {
            case 'node_type.removed':
                return this.executeNodeTypeRemovedBatch(op.target, batchSize);
            case 'field.removed':
                return this.executeFieldRemovedBatch(op.target, cursor, batchSize);
            case 'edge_type.removed':
                return this.executeEdgeTypeRemovedBatch(op.target, batchSize);
            case 'node_type.renamed':
                return this.executeNodeTypeRenamedBatch(op, cursor, batchSize);
            case 'field.type_changed':
                return this.executeFieldTypeChangedBatch(op, cursor, batchSize);
            case 'node_type.kind_changed':
            case 'field.sensitivity_flipped':
            case 'permission.changed':
            case 'permission.removed':
                // Schema-only changes — nothing to transform at the data
                // layer. Successful no-op so the runner doesn't skip
                // subsequent ops with fail-fast semantics.
                return { deleted: 0, modified: 0, nextCursor: null };
            default:
                throw new Error(UNSUPPORTED_OP_ERROR);
        }
    }

    async rollbackOp(
        op: MigrationOp,
        snapshotRows: ReadonlyArray<Record<string, unknown>>,
    ): Promise<Omit<RollbackOpResult, 'op' | 'error' | 'snapshotFile'>> {
        switch (op.kind) {
            case 'node_type.removed':
                return this.rollbackNodeTypeRemoved(snapshotRows);
            case 'field.removed':
                return this.rollbackFieldRemoved(op.target, snapshotRows);
            case 'edge_type.removed':
                return this.rollbackEdgeTypeRemoved(op.target, snapshotRows);
            case 'node_type.renamed':
                return this.rollbackNodeTypeRenamed(op, snapshotRows);
            case 'field.type_changed':
                return this.rollbackFieldTypeChanged(op.target, snapshotRows);
            case 'node_type.kind_changed':
            case 'field.sensitivity_flipped':
            case 'permission.changed':
            case 'permission.removed':
                return { restored: 0, repaired: 0 };
            default:
                throw new Error(UNSUPPORTED_OP_ERROR);
        }
    }

    /* ── node_type.removed ───────────────────────────────────── */

    private async dryRunNodeTypeRemoved(type: string, sampleN: number): Promise<Omit<DryRunOpResult, 'op'>> {
        const affectedRowCount = await this.ops.countNodesByType(type);
        if (affectedRowCount === 0) return { affectedRowCount };
        const sampleRows = await this.ops.sampleNodesByType(type, sampleN);
        return { affectedRowCount, sampleRows };
    }

    private async executeNodeTypeRemovedBatch(type: string, batchSize: number): Promise<BatchResult> {
        const remaining = await this.ops.countNodesByType(type);
        if (remaining === 0) return { deleted: 0, modified: 0, nextCursor: null };
        const deleted = await this.ops.deleteNodesByType(type, batchSize);
        return { deleted, modified: 0, nextCursor: remaining > batchSize ? 'more' : null };
    }

    private async rollbackNodeTypeRemoved(
        snapshotRows: ReadonlyArray<Record<string, unknown>>,
    ): Promise<{ restored: number; repaired: number }> {
        let restored = 0;
        for (const row of snapshotRows) {
            const props = normaliseLoreNodeRow(row);
            if (!props || !props['id']) continue;
            try {
                await this.ops.restoreNode(props);
                restored++;
            } catch { /* best-effort */ }
        }
        return { restored, repaired: 0 };
    }

    /* ── edge_type.removed ───────────────────────────────────── */

    private async dryRunEdgeTypeRemoved(relation: string, sampleN: number): Promise<Omit<DryRunOpResult, 'op'>> {
        const affectedRowCount = await this.ops.countEdgesByRelation(relation);
        if (affectedRowCount === 0) return { affectedRowCount };
        const sampleRows = await this.ops.sampleEdgesByRelation(relation, sampleN);
        return { affectedRowCount, sampleRows };
    }

    private async executeEdgeTypeRemovedBatch(relation: string, batchSize: number): Promise<BatchResult> {
        const remaining = await this.ops.countEdgesByRelation(relation);
        if (remaining === 0) return { deleted: 0, modified: 0, nextCursor: null };
        const deleted = await this.ops.deleteEdgesByRelation(relation, batchSize);
        return { deleted, modified: 0, nextCursor: remaining > batchSize ? 'more' : null };
    }

    /**
     * Re-create each snapshot edge between its source and target.
     * Best-effort: a missing source/target node (deleted out from under us)
     * or an engine that rejects a duplicate/dangling edge is silently
     * skipped — the caller can spot it from `restored < total`.
     */
    private async rollbackEdgeTypeRemoved(
        relation: string,
        snapshotRows: ReadonlyArray<Record<string, unknown>>,
    ): Promise<{ restored: number; repaired: number }> {
        let restored = 0;
        for (const row of snapshotRows) {
            const props = normaliseEdgeRow(row);
            const sourceId = props['sourceId'];
            const targetId = props['targetId'];
            if (!sourceId || !targetId) continue;
            try {
                await this.ops.createEdge(String(sourceId), String(targetId), relation);
                restored++;
            } catch { /* best-effort */ }
        }
        return { restored, repaired: 0 };
    }

    /* ── field.removed ───────────────────────────────────────── */

    private async dryRunFieldRemoved(target: string, sampleN: number): Promise<Omit<DryRunOpResult, 'op'>> {
        const { nodeType, field } = splitFieldTarget(target);
        let affectedRowCount = 0;
        const sample: Array<{ id: unknown; presentKeys: string[] }> = [];
        let cursor = '';
        for (;;) {
            const page = await this.ops.pageNodesByType(nodeType, cursor, FIELD_DRY_RUN_PAGE_SIZE);
            if (page.length === 0) break;
            for (const r of page) {
                const meta = parseMetadata(r.metadata);
                if (meta && Object.prototype.hasOwnProperty.call(meta, field)) {
                    affectedRowCount++;
                    if (sample.length < sampleN) sample.push({ id: r.id, presentKeys: Object.keys(meta) });
                }
            }
            cursor = page[page.length - 1]!.id;
            if (page.length < FIELD_DRY_RUN_PAGE_SIZE) break;
        }
        return {
            affectedRowCount,
            sampleRows: affectedRowCount > 0 ? sample : undefined,
        };
    }

    private async rollbackFieldRemoved(
        target: string,
        snapshotRows: ReadonlyArray<Record<string, unknown>>,
    ): Promise<{ restored: number; repaired: number }> {
        const { field } = splitFieldTarget(target);
        let repaired = 0;
        for (const row of snapshotRows) {
            const props = normaliseLoreNodeRow(row);
            if (!props || !props['id']) continue;
            const snapshotMeta = parseMetadata(props['metadata']);
            if (!snapshotMeta || !Object.prototype.hasOwnProperty.call(snapshotMeta, field)) continue;
            const id = String(props['id']);
            const currentMeta = (await this.ops.getNodeMetadata(id)) ?? {};
            currentMeta[field] = snapshotMeta[field];
            try {
                await this.ops.setNodeMetadata(id, currentMeta);
                repaired++;
            } catch { /* best-effort */ }
        }
        return { restored: 0, repaired };
    }

    private async executeFieldRemovedBatch(
        target: string,
        cursor: string | null,
        batchSize: number,
    ): Promise<BatchResult> {
        const { nodeType, field } = splitFieldTarget(target);
        const cursorStr = cursor ?? '';
        const rows = await this.ops.pageNodesByType(nodeType, cursorStr, batchSize);
        if (rows.length === 0) return { deleted: 0, modified: 0, nextCursor: null };

        let modified = 0;
        let lastId = cursorStr;
        for (const r of rows) {
            lastId = r.id;
            const meta = parseMetadata(r.metadata);
            if (!meta || !Object.prototype.hasOwnProperty.call(meta, field)) continue;
            delete meta[field];
            await this.ops.setNodeMetadata(r.id, meta);
            modified++;
        }
        return { deleted: 0, modified, nextCursor: rows.length === batchSize ? lastId : null };
    }

    /* ── node_type.renamed ───────────────────────────────────── */

    private async executeNodeTypeRenamedBatch(
        op: MigrationOp,
        cursor: string | null,
        batchSize: number,
    ): Promise<BatchResult> {
        const newName = requireStringParam(op, 'newName');
        const cursorStr = cursor ?? '';
        const rows = await this.ops.pageNodesByType(op.target, cursorStr, batchSize);
        if (rows.length === 0) return { deleted: 0, modified: 0, nextCursor: null };

        let modified = 0;
        let lastId = cursorStr;
        for (const r of rows) {
            lastId = r.id;
            try {
                await this.ops.setNodeType(r.id, newName);
                modified++;
            } catch { /* best-effort */ }
        }
        return { deleted: 0, modified, nextCursor: rows.length === batchSize ? lastId : null };
    }

    private async rollbackNodeTypeRenamed(
        op: MigrationOp,
        snapshotRows: ReadonlyArray<Record<string, unknown>>,
    ): Promise<{ restored: number; repaired: number }> {
        // Rollback: set type back to op.target (the OLD name). The snapshot
        // rows are LoreNodes captured at approve-time when type still
        // equalled op.target, so we re-tag each row by id.
        let repaired = 0;
        for (const row of snapshotRows) {
            const props = normaliseLoreNodeRow(row);
            if (!props || !props['id']) continue;
            try {
                await this.ops.setNodeType(String(props['id']), op.target);
                repaired++;
            } catch { /* best-effort */ }
        }
        return { restored: 0, repaired };
    }

    /* ── field.type_changed ──────────────────────────────────── */

    private async executeFieldTypeChangedBatch(
        op: MigrationOp,
        cursor: string | null,
        batchSize: number,
    ): Promise<BatchResult> {
        const newType = requireStringParam(op, 'newType');
        const { nodeType, field } = splitFieldTarget(op.target);
        const cursorStr = cursor ?? '';
        const rows = await this.ops.pageNodesByType(nodeType, cursorStr, batchSize);
        if (rows.length === 0) return { deleted: 0, modified: 0, nextCursor: null };

        let modified = 0;
        let lastId = cursorStr;
        for (const r of rows) {
            lastId = r.id;
            const meta = parseMetadata(r.metadata);
            if (!meta || !Object.prototype.hasOwnProperty.call(meta, field)) continue;
            const oldVal = meta[field];
            const newVal = coerceValue(oldVal, newType);
            if (newVal === oldVal) continue;
            meta[field] = newVal;
            try {
                await this.ops.setNodeMetadata(r.id, meta);
                modified++;
            } catch { /* best-effort */ }
        }
        return { deleted: 0, modified, nextCursor: rows.length === batchSize ? lastId : null };
    }

    private async rollbackFieldTypeChanged(
        target: string,
        snapshotRows: ReadonlyArray<Record<string, unknown>>,
    ): Promise<{ restored: number; repaired: number }> {
        // Rollback = restore each row's field value from the snapshot
        // metadata (which captured the value in its ORIGINAL type). Same
        // shape as rollbackFieldRemoved but always splices (the field was
        // never deleted, just retyped).
        const { field } = splitFieldTarget(target);
        let repaired = 0;
        for (const row of snapshotRows) {
            const props = normaliseLoreNodeRow(row);
            if (!props || !props['id']) continue;
            const snapshotMeta = parseMetadata(props['metadata']);
            if (!snapshotMeta || !Object.prototype.hasOwnProperty.call(snapshotMeta, field)) continue;
            const id = String(props['id']);
            const currentMeta = (await this.ops.getNodeMetadata(id)) ?? {};
            currentMeta[field] = snapshotMeta[field];
            try {
                await this.ops.setNodeMetadata(id, currentMeta);
                repaired++;
            } catch { /* best-effort */ }
        }
        return { restored: 0, repaired };
    }
}

/* ────────────────────────────────────────────────────────────── */
/*  helpers — private copies, not shared with opValueHelpers.ts:   */
/*  kept local rather than imported so this class has zero         */
/*  dependency on the migration/ module beyond its own types.js.   */
/* ────────────────────────────────────────────────────────────── */

function splitFieldTarget(target: string): { nodeType: string; field: string } {
    // field.removed target is "<NodeType>.<field>". Node types are dotted
    // (e.g. "know.Tenant"), so strip exactly the last segment.
    const lastDot = target.lastIndexOf('.');
    if (lastDot < 0) {
        throw new Error(`field.removed target must be "<NodeType>.<field>"; got "${target}"`);
    }
    return { nodeType: target.slice(0, lastDot), field: target.slice(lastDot + 1) };
}

/** Snapshot node rows may carry a `n.`-prefixed projection style from an
 *  older Cypher dialect; strip it so callers read bare keys uniformly. */
function normaliseLoreNodeRow(raw: Record<string, unknown>): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
        out[k.startsWith('n.') ? k.slice(2) : k] = v;
    }
    return out;
}

/** Edge snapshot rows carry `{ sourceId, targetId, ...e.* }`; strip the
 *  `e.` prefix on edge columns so callers read `props['relation']` uniformly. */
function normaliseEdgeRow(raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
        out[k.startsWith('e.') ? k.slice(2) : k] = v;
    }
    return out;
}

/** Pull a required string param off MigrationOp.params with a caller-
 *  friendly error when missing (node_type.renamed needs newName,
 *  field.type_changed needs newType). */
function requireStringParam(op: MigrationOp, key: string): string {
    const v = op.params?.[key];
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`${op.kind}(${op.target}) requires params.${key} to be a non-empty string`);
    }
    return v;
}

/**
 * Lossy best-effort coercion used by field.type_changed. Values that can't
 * be coerced cleanly are returned unchanged (caller counts them as
 * unmodified) — strict mode is deferred; today's runner is for one-way
 * schema cleanup, not lossless transformation.
 */
function coerceValue(v: unknown, newType: string): unknown {
    if (v === null || v === undefined) return v;
    switch (newType) {
        case 'string':
            return typeof v === 'string' ? v : String(v);
        case 'integer': {
            const n = typeof v === 'number' ? Math.trunc(v) : parseInt(String(v), 10);
            return Number.isFinite(n) ? n : v;
        }
        case 'float': {
            const n = typeof v === 'number' ? v : parseFloat(String(v));
            return Number.isFinite(n) ? n : v;
        }
        case 'boolean': {
            if (typeof v === 'boolean') return v;
            const s = String(v).toLowerCase().trim();
            if (s === 'true' || s === '1' || s === 'yes') return true;
            if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
            return v;
        }
        case 'date':
        case 'datetime':
            return typeof v === 'string' ? v : String(v);
        case 'json':
            if (typeof v === 'string') return v;
            try { return JSON.stringify(v); } catch { return v; }
        default:
            return v;
    }
}

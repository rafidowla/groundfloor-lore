/**
 * migration/opValueHelpers.ts — engine-agnostic MigrationOp param/value
 * helpers, split out of the now-deleted former graph-backend module so
 * every MigrationBackend implementation can share them without depending
 * on a Cypher-specific module.
 */

import type { MigrationOp } from './types.js';

/**
 * Pull a required string param off MigrationOp.params with a
 * caller-friendly error when missing. Used by ops that need extras
 * beyond `target` (node_type.renamed needs newName, field.type_changed
 * needs newType).
 */
export function requireStringParam(op: MigrationOp, key: string): string {
    const v = op.params?.[key];
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(
            `${op.kind}(${op.target}) requires params.${key} to be a non-empty string`,
        );
    }
    return v;
}

/**
 * Lossy best-effort coercion used by field.type_changed. Each branch
 * mirrors a ColumnType from contracts/tables.ts; values that can't
 * be coerced cleanly are returned unchanged (caller will count them
 * as unmodified). Coercion is "lossy" by design — strict mode is
 * deferred to a future scope; today's runner is for one-way schema
 * cleanup, not lossless transformation.
 */
export function coerceValue(v: unknown, newType: string): unknown {
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
            // If already an object, stringify; else assume already a JSON-shaped string.
            if (typeof v === 'string') return v;
            try { return JSON.stringify(v); } catch { return v; }
        default:
            return v;
    }
}

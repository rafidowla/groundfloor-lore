/**
 * collectionRowValidation.ts — reject invalid collection rows BEFORE the
 * storage engine sees them (audit finding 6, 2026-09-03).
 *
 * Before this module existed, `POST /v1/{collection}` and the MCP
 * `collection_insert`/`collection_bulk_insert` tools validated only "is
 * the body an object?" at the boundary, then handed the row straight to
 * `ITableStorage`. Every real validation failure — an unknown column, a
 * wrong-typed value, an empty row — was discovered deep inside
 * `sqliteTableTransaction.ts` (`assertKnownColumns`, plain `Error`),
 * `sqliteTableStorage.ts` (`encodeBoolean`, plain `Error`), or
 * better-sqlite3's own bind-time `TypeError` for an object/array value.
 * None of those throw a recognizable shape, so `classifyStorageErr`'s
 * message-regex classifier fell through to a generic 500 `insert_failed`
 * — and on the MCP surface, `redactError` then hashed the quoted column
 * and table names out of the message, so even the server log lost the
 * detail needed to debug it.
 *
 * This module re-validates a row against its declared `TableSchema` at
 * the MCP/REST boundary, before any storage call, and throws a
 * structured `CollectionValidationError` that carries the offending
 * table/field (and, for bulk inserts, the row index) as real properties
 * — not buried in prose — so callers can build a clean 400 without
 * parsing an error message.
 *
 * Design decisions (documented here since they're not obvious from the
 * code alone):
 *
 *   - Type checking is intentionally STRICT, not the lenient coercion
 *     `encodeValue`/`encodeBoolean` apply deeper in the SQLite engine.
 *     Those coercions exist for a different caller — CSV/tabular import
 *     (`tabularImport.ts`), where every value arrives as a string. The
 *     JSON API surface (REST body / MCP tool args) can and should send
 *     real JSON types, so a `boolean` column requires an actual
 *     `true`/`false`, and an `integer`/`float` column requires an actual
 *     `number` — a numeric STRING is rejected, not silently coerced.
 *     This is the "reject" option called out in the finding-6 spec
 *     (rather than "coerce"): coercing at this layer would hide the
 *     caller's mistake and still leave the lenient engine-level coercion
 *     doing the real work, which is exactly the inconsistent-validation
 *     problem this fix closes.
 *   - The non-empty-row and required-column checks apply ONLY to
 *     `mode: 'insert'`. An update/upsert `patch` is allowed to be a
 *     partial (even empty, as a no-op) object — that already matches
 *     `updateSqliteTableRows`' existing behavior (an empty patch is a
 *     0-row no-op, not an error) and changing that was not part of this
 *     finding's repro table.
 */

import type { ColumnDecl, ColumnType, Row, TableSchema } from '../contracts/tables.js';

/** `insert` requires non-empty + all required columns present; `update`/
 *  `upsert` validate only the keys actually supplied (a partial patch). */
export type RowValidationMode = 'insert' | 'update' | 'upsert';

/**
 * CollectionValidationError — thrown by `validateRowAgainstSchema`.
 * `table` and `field` are real properties (not just embedded in the
 * message) so every caller (REST `classifyStorageErr`, MCP tool catch
 * blocks) can build a clean, readable error envelope without parsing
 * prose or risking `redactError`'s quoted-string hashing swallowing the
 * very names the caller needs to see.
 */
export class CollectionValidationError extends Error {
    readonly code = 'invalid_row' as const;

    constructor(
        public readonly table: string,
        public readonly field: string | undefined,
        public readonly reason: string,
        /** Present only when validating one row out of a bulk-insert batch. */
        public readonly rowIndex?: number,
    ) {
        super(
            (rowIndex === undefined ? '' : `row ${rowIndex}: `)
            + (field === undefined ? `${table}: ${reason}` : `${table}.${field}: ${reason}`),
        );
        this.name = 'CollectionValidationError';
    }
}

function describeValue(value: unknown): string {
    // QA follow-up (2026-09-03, low): JSON.stringify(NaN) and
    // JSON.stringify(Infinity/-Infinity) both serialize to the string
    // "null" (JSON has no way to represent them), so without this branch
    // an invalid NaN/Infinity value renders as the misleading "number
    // null" — indistinguishable from an actual null. Name them literally
    // instead; `String(NaN)` / `String(Infinity)` give "NaN"/"Infinity".
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return `number ${String(value)}`;
    }
    const json = (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
    const truncated = json.length > 60 ? `${json.slice(0, 60)}…` : json;
    return `${typeCategory(value)} ${truncated}`;
}

function typeCategory(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/** Strict type check for a declared column value. See the module header
 *  for why this is intentionally stricter than the engine's own coercion. */
function typeMatches(value: unknown, type: ColumnType): boolean {
    switch (type) {
        case 'string':
            return typeof value === 'string';
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'float':
            return typeof value === 'number' && Number.isFinite(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'date':
        case 'datetime':
            return typeof value === 'string' && !Number.isNaN(Date.parse(value));
        case 'json':
            // Arbitrary JSON is the whole point of this column type — only
            // reject values that can never survive JSON.stringify.
            return typeof value !== 'function' && typeof value !== 'symbol';
    }
}

/**
 * validateRowAgainstSchema — throws `CollectionValidationError` when
 * `row` does not conform to `schema` for the given `mode`. Returns
 * (void) silently when the row is valid. Call this BEFORE any
 * `ITableStorage` mutation so the storage engine never sees a bad row.
 */
export function validateRowAgainstSchema(
    schema: TableSchema,
    row: Row,
    mode: RowValidationMode,
    rowIndex?: number,
): void {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new CollectionValidationError(
            schema.name, undefined,
            `row must be a plain object, got ${typeCategory(row)}`,
            rowIndex,
        );
    }
    if (mode === 'insert' && Object.keys(row).length === 0) {
        throw new CollectionValidationError(schema.name, undefined, 'row must not be empty', rowIndex);
    }

    const byName = new Map<string, ColumnDecl>(schema.columns.map(c => [c.name, c]));
    for (const key of Object.keys(row)) {
        const column = byName.get(key);
        if (!column) {
            throw new CollectionValidationError(
                schema.name, key, `unknown column '${key}' on table '${schema.name}'`, rowIndex,
            );
        }
        const value = row[key];
        if (value === undefined) continue; // treat as "not supplied"
        if (value === null) {
            if (column.required) {
                throw new CollectionValidationError(
                    schema.name, key, `column '${key}' is required and cannot be null`, rowIndex,
                );
            }
            continue;
        }
        // Round-S fix (2026-09-04, finding 1) — a column whose `type` was
        // never recorded (e.g. a schema persisted before the create route
        // validated its body — see collectionsSchemaTranslate.ts's
        // `sdkCollectionSchemaZ`) must not reject every value with the
        // nonsensical "expected type 'undefined'". `typeMatches`'s switch
        // has no case for an unrecognized/missing type, so it always
        // returned falsy for one; skip the check instead of failing closed
        // on a value the caller had no way to have gotten right.
        if (column.type !== undefined && !typeMatches(value, column.type)) {
            throw new CollectionValidationError(
                schema.name, key,
                `expected type '${column.type}' for column '${key}', got ${describeValue(value)}`,
                rowIndex,
            );
        }
    }

    if (mode === 'insert') {
        for (const column of schema.columns) {
            if (column.required && !(column.name in row)) {
                throw new CollectionValidationError(
                    schema.name, column.name, `required column '${column.name}' is missing`, rowIndex,
                );
            }
        }
    }
}

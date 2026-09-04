/**
 * collectionsSchemaTranslate.ts — the SDK ↔ Lore schema vocabulary
 * boundary for the tabular CRUD surface.
 *
 * SOURCE OF TRUTH for the external (SDK) schema shape and its
 * translation to Lore's internal `TableSchema`:
 *
 *   field_type   → type
 *   primary_key  → primary
 *
 * SDK names are externally visible (they mirror
 * `groundfloor-ts-sdk/src/types.ts` so the same SDK can target Lore
 * locally or Dataplane in cloud); Lore's internal `ColumnDecl` keeps
 * its own names. The zod mirrors of the same shape live here too, so
 * the runtime validator and the TypeScript types can't drift apart.
 *
 * Split out of collections.ts (800-line cap); collections.ts
 * re-exports every symbol here so existing importers keep their path.
 */

import { z } from 'zod';
import type { ColumnDecl, ColumnType, TableSchema } from '../../contracts/tables.js';

/**
 * SDK FieldSchema (from v3/groundfloor-ts-sdk/src/types.ts) — exposed
 * directly in the MCP tool input schemas so external callers see the
 * SDK names, not Lore's internal names.
 */
export interface SdkFieldSchema {
    name: string;
    field_type: ColumnType;
    required?: boolean;
    indexed?: boolean;
    unique?: boolean;
    primary_key?: boolean;
}

export interface SdkCollectionSchema {
    name: string;
    fields: SdkFieldSchema[];
    description?: string;
    metadata?: Record<string, string>;
}

export function sdkToInternalSchema(schema: SdkCollectionSchema): TableSchema {
    return {
        name: schema.name,
        description: schema.description,
        columns: schema.fields.map((f): ColumnDecl => ({
            name: f.name,
            type: f.field_type,
            primary: f.primary_key,
            required: f.required,
            unique: f.unique,
            indexed: f.indexed,
        })),
    };
}

export function internalToSdkSchema(schema: TableSchema): SdkCollectionSchema {
    return {
        name: schema.name,
        description: schema.description,
        fields: schema.columns.map((c): SdkFieldSchema => ({
            name: c.name,
            field_type: c.type,
            required: c.required,
            indexed: c.indexed,
            unique: c.unique,
            primary_key: c.primary,
        })),
    };
}

/* ------------------------------------------------------------------ */
/*  Zod schemas (shared between MCP tools and REST routes)             */
/* ------------------------------------------------------------------ */

export const COLUMN_TYPE_ENUM = z.enum([
    'string', 'integer', 'float', 'boolean', 'date', 'datetime', 'json',
]);

export const sdkFieldSchemaZ = z.object({
    name: z.string(),
    field_type: COLUMN_TYPE_ENUM,
    required: z.boolean().optional(),
    indexed: z.boolean().optional(),
    unique: z.boolean().optional(),
    primary_key: z.boolean().optional(),
});

export const sdkCollectionSchemaZ = z.object({
    name: z.string(),
    fields: z.array(sdkFieldSchemaZ),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
});

/**
 * describeSchemaZodError — round-S fix (2026-09-04, finding 1).
 *
 * `POST /v1/schema` used to duck-type its body (only checking `name`/
 * `fields` were present) instead of running it through `sdkCollectionSchemaZ`
 * — the SAME zod schema `collection_create` (the MCP tool) already
 * validates against. A field object using the wrong key (`type` instead of
 * `field_type`) or an unrecognized type string (`'text'` — not in
 * `COLUMN_TYPE_ENUM`) silently produced a column with `type: undefined`:
 * the 201 response echoed the caller's own (wrong) body back, `GET
 * /v1/schema` then listed that field with NO type at all, and every
 * subsequent insert failed with the confusing `expected type 'undefined'
 * for column 'id'`. Wiring the route through this same zod schema rejects
 * the malformed body up front with a 400 naming the accepted vocabulary,
 * so a bad schema is never persisted in the first place.
 */
export function describeSchemaZodError(error: z.ZodError): { code: 'invalid_schema'; message: string } {
    const detail = error.issues
        .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
        .join('; ');
    return {
        code: 'invalid_schema',
        message: `invalid collection schema — ${detail}. Each field needs a \`field_type\` `
            + `(not \`type\`) from: ${COLUMN_TYPE_ENUM.options.join(', ')}.`,
    };
}

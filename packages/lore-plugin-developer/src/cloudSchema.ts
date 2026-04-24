/**
 * developer/cloudSchema.ts — Q2.2 slice 4. Dataplane-backed schema for
 * cloud mode.
 *
 * Mirrors the Kùzu tables declared in `./schema.ts`, one Dataplane
 * collection per Kùzu table. Collection names follow the
 * `${pluginName}_${kind}` convention (snake_case) so a shared tenant can
 * host multiple plugins without name collisions.
 *
 *   Kùzu                   → Dataplane
 *   ─────────────────────────────────────────────────────
 *   CodeSymbol             → developer_code_symbol
 *   CodeFile               → developer_code_file
 *   DevActivity            → developer_dev_activity
 *   CodeRelation (REL)     → developer_code_relation
 *   FileContains (REL)     → developer_file_contains
 *   LoreAppliesToCode (REL)→ developer_lore_applies_to_code
 *   LoreTouchesFile (REL)  → developer_lore_touches_file
 *
 * Edge collections carry explicit `source_id` + `target_id` columns so
 * they work on non-graph connectors (the same two-write pattern
 * DataplaneGraph uses for its own lore_edge collection). The extra
 * graph.createEdge write on Arango-style connectors is a future slice;
 * this slice focuses on schema parity so the collections EXIST when
 * plugin op routing lands.
 *
 * All collections include `org_id` (indexed) for ReBAC partitioning —
 * required for any row the daemon writes on behalf of the current org.
 *
 * Type mapping notes:
 *   Kùzu INT32 → Dataplane `int` (the SDK's CollectionSchema accepts
 *   `int` / `string` / `float` / `bool` / `vector`; no finer widths).
 */

import type { PluginCloudSchemaContext } from '@lore-core/plugins/types.js';

export async function registerDeveloperCloudSchema(ctx: PluginCloudSchemaContext): Promise<void> {
    await ctx.ensureCollection({
        name: 'developer_code_symbol',
        fields: [
            { name: 'uid', field_type: 'string', primary_key: true, required: true },
            { name: 'name', field_type: 'string', indexed: true },
            { name: 'kind', field_type: 'string', indexed: true },
            { name: 'filePath', field_type: 'string', indexed: true },
            { name: 'startLine', field_type: 'int' },
            { name: 'endLine', field_type: 'int' },
            { name: 'content', field_type: 'string' },
            { name: 'signature', field_type: 'string' },
            { name: 'returnType', field_type: 'string' },
            { name: 'parameterCount', field_type: 'int' },
            { name: 'repo', field_type: 'string', indexed: true },
            { name: 'org_id', field_type: 'string', indexed: true, required: true },
        ],
    });

    await ctx.ensureCollection({
        name: 'developer_code_file',
        fields: [
            { name: 'path', field_type: 'string', primary_key: true, required: true },
            { name: 'language', field_type: 'string', indexed: true },
            { name: 'loc', field_type: 'int' },
            { name: 'repo', field_type: 'string', indexed: true },
            { name: 'lastModified', field_type: 'string' },
            { name: 'org_id', field_type: 'string', indexed: true, required: true },
        ],
    });

    await ctx.ensureCollection({
        name: 'developer_dev_activity',
        fields: [
            { name: 'id', field_type: 'string', primary_key: true, required: true },
            { name: 'dev', field_type: 'string', indexed: true },
            { name: 'project', field_type: 'string', indexed: true },
            { name: 'action', field_type: 'string' },
            { name: 'filePath', field_type: 'string' },
            { name: 'timestamp', field_type: 'string', indexed: true },
            { name: 'tool', field_type: 'string' },
            { name: 'org_id', field_type: 'string', indexed: true, required: true },
        ],
    });

    // REL tables as edge collections — portable across graph/non-graph
    // connectors via explicit source/target ids.

    await ctx.ensureCollection({
        name: 'developer_code_relation',
        fields: [
            { name: 'id', field_type: 'string', primary_key: true, required: true },
            { name: 'source_id', field_type: 'string', required: true, indexed: true },
            { name: 'target_id', field_type: 'string', required: true, indexed: true },
            { name: 'type', field_type: 'string' },
            { name: 'confidence', field_type: 'float' },
            { name: 'reason', field_type: 'string' },
            { name: 'org_id', field_type: 'string', indexed: true, required: true },
        ],
    });

    await ctx.ensureCollection({
        name: 'developer_file_contains',
        fields: [
            { name: 'id', field_type: 'string', primary_key: true, required: true },
            { name: 'source_id', field_type: 'string', required: true, indexed: true },
            { name: 'target_id', field_type: 'string', required: true, indexed: true },
            { name: 'org_id', field_type: 'string', indexed: true, required: true },
        ],
    });

    await ctx.ensureCollection({
        name: 'developer_lore_applies_to_code',
        fields: [
            { name: 'id', field_type: 'string', primary_key: true, required: true },
            { name: 'source_id', field_type: 'string', required: true, indexed: true },
            { name: 'target_id', field_type: 'string', required: true, indexed: true },
            { name: 'relation', field_type: 'string' },
            { name: 'org_id', field_type: 'string', indexed: true, required: true },
        ],
    });

    await ctx.ensureCollection({
        name: 'developer_lore_touches_file',
        fields: [
            { name: 'id', field_type: 'string', primary_key: true, required: true },
            { name: 'source_id', field_type: 'string', required: true, indexed: true },
            { name: 'target_id', field_type: 'string', required: true, indexed: true },
            { name: 'relation', field_type: 'string' },
            { name: 'org_id', field_type: 'string', indexed: true, required: true },
        ],
    });
}

/** Exported for tests + the orphan-detection path (knows which cloud
 *  collections to cleanup if the plugin is deactivated). */
export const DEVELOPER_CLOUD_COLLECTIONS: ReadonlyArray<string> = [
    'developer_code_symbol',
    'developer_code_file',
    'developer_dev_activity',
    'developer_code_relation',
    'developer_file_contains',
    'developer_lore_applies_to_code',
    'developer_lore_touches_file',
];

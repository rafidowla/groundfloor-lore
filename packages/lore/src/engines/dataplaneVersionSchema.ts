/**
 * dataplaneVersionSchema.ts — the `lore_version` collection (cloud parity C item 8, D6).
 *
 * One collection holds the three tables of the local versions.sqlite, discriminated by `kind`:
 *   node_version     one immutable row per recorded write (local `node_versions`)
 *   changeset        a changeset header (local `changesets`)
 *   changeset_write  one buffered op of an open changeset (local `changeset_writes`)
 * Same scope columns and unique (org_id, lore_workspace, lore_id) index as every other Lore
 * collection (D1/D2); `lore_id` is the versionId, the changeset id, or `<csId>#w<seq>`.
 */
import { SCOPE_COLUMNS, SCOPE_KEY_INDEX } from './dataplaneScopeFilter.js';
import { VERSION_COLLECTION } from './dataplaneCollections.js';

export const VERSION_SCHEMA = {
    name: VERSION_COLLECTION,
    fields: [
        { name: 'id', field_type: 'string', primary_key: true, required: true },
        { name: 'kind', field_type: 'string', required: true, indexed: true },
        { name: 'org_id', field_type: 'string', indexed: true, required: true },
        ...SCOPE_COLUMNS,
        { name: 'node_id', field_type: 'string', indexed: true },
        { name: 'timestamp', field_type: 'string', indexed: true },
        { name: 'principal', field_type: 'string' },
        { name: 'operation', field_type: 'string' },
        { name: 'previous_state', field_type: 'string' }, // JSON
        { name: 'new_state', field_type: 'string' }, // JSON
        { name: 'changeset_id', field_type: 'string', indexed: true },
        { name: 'compacted', field_type: 'boolean' },
        { name: 'status', field_type: 'string' },
        { name: 'created_at', field_type: 'string' },
        { name: 'committed_at', field_type: 'string' },
        { name: 'write_count', field_type: 'integer' },
        { name: 'seq', field_type: 'integer' },
        { name: 'payload', field_type: 'string' }, // JSON
    ],
    indexes: [SCOPE_KEY_INDEX],
} as const;

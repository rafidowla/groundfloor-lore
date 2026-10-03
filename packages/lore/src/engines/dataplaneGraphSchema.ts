/**
 * dataplaneGraphSchema.ts — collection schemas for the Dataplane graph
 * (lore_node / lore_edge) plus the idempotent create helper.
 *
 * Extracted from dataplaneGraph.ts (file-size guardrail). The schema is pushed
 * ONCE PER DATAPLANE WORKSPACE (the engine workspace is credential-fixed; the
 * Lore workspace is the `lore_workspace` column, D1) with the scope columns and
 * the unique (org_id, lore_workspace, lore_id) index (D1/D2). `id` is the
 * physical primary key and holds the per-workspace row key (D2).
 */
import { EDGE_COLLECTION, NODE_COLLECTION } from './dataplaneCollections.js';
import { SCOPE_COLUMNS, SCOPE_KEY_INDEX } from './dataplaneScopeFilter.js';
import { log } from '../logger.js';
import { declaredFieldNames } from './dataplaneNodeShape.js';
import { VERSION_SCHEMA } from './dataplaneVersionSchema.js';

export const GRAPH_COLLECTION_SCHEMAS: readonly unknown[] = [
    {
        name: NODE_COLLECTION,
        fields: [
            { name: 'id', field_type: 'string', primary_key: true, required: true },
            { name: 'type', field_type: 'string', required: true, indexed: true },
            { name: 'label', field_type: 'string' },
            { name: 'content', field_type: 'string' },
            { name: 'tags', field_type: 'string' },
            { name: 'project', field_type: 'string', indexed: true },
            { name: 'ecosystem', field_type: 'string', indexed: true },
            { name: 'org_id', field_type: 'string', indexed: true, required: true },
            ...SCOPE_COLUMNS,
            { name: 'created_at', field_type: 'string' },
            { name: 'updated_at', field_type: 'string' },
            { name: 'language', field_type: 'string' },
            { name: 'security_scopes', field_type: 'string' }, // RA2-reaudit2 — node-level access scopes (was silently dropped in cloud)
            // ─── schema v2 (cloud parity B item 6, D5): the rest of the LoreNode shape ───
            { name: 'metadata', field_type: 'string' }, // JSON
            { name: 'synced_at', field_type: 'string' },
            { name: 'valid_from', field_type: 'string', indexed: true },
            { name: 'valid_until', field_type: 'string', indexed: true },
            { name: 'status', field_type: 'string', indexed: true },
            { name: 'classification', field_type: 'string' },
            { name: 'classification_expires_at', field_type: 'string' },
            { name: 'superseded_by', field_type: 'string', indexed: true },
            { name: 'superseded_at', field_type: 'string' },
            { name: 'superseded_reason', field_type: 'string' },
            { name: 'stale', field_type: 'boolean' },
            { name: 'ephemeral', field_type: 'boolean' },
            { name: 'ttl_ms', field_type: 'integer' },
            { name: 'success_count', field_type: 'integer' },
            { name: 'failure_count', field_type: 'integer' },
            { name: 'partial_count', field_type: 'integer' },
            { name: 'confirmation_score', field_type: 'float' },
            { name: 'evidence', field_type: 'string' }, // JSON or free text
            { name: 'anchor_stale', field_type: 'boolean' },
            { name: 'anchor_stale_since', field_type: 'string' },
            { name: 'anchors', field_type: 'string' }, // JSON
        ],
        indexes: [SCOPE_KEY_INDEX],
    },
    {
        name: EDGE_COLLECTION,
        fields: [
            { name: 'id', field_type: 'string', primary_key: true, required: true },
            { name: 'source_id', field_type: 'string', required: true, indexed: true },
            { name: 'target_id', field_type: 'string', required: true, indexed: true },
            { name: 'relation', field_type: 'string', required: true },
            { name: 'org_id', field_type: 'string', indexed: true, required: true },
            ...SCOPE_COLUMNS,
            { name: 'created_at', field_type: 'string' },
            // schema v2 (B item 10): edge confidence tier + numeric confidence.
            { name: 'confidence', field_type: 'string' },
            { name: 'confidence_score', field_type: 'float' },
        ],
        indexes: [SCOPE_KEY_INDEX],
    },
    VERSION_SCHEMA, // lore_version (cloud parity C item 8)
];

interface SchemaClient {
    createCollection(dataplaneWorkspaceId: string, schema: never, connection?: string): Promise<unknown>;
    getCollectionSchema?(dataplaneWorkspaceId: string, collection: string, connection?: string): Promise<unknown>;
}

interface SchemaShape {
    name?: string;
    fields?: Array<{ name: string }>;
    indexes?: Array<{ name?: string; fields: string[]; unique?: boolean }>;
}

/** Columns the engine always provides (PG GET schema omits them from `fields`). */
const ENGINE_OWNED_COLUMNS: ReadonlySet<string> = new Set(['id', 'tenant_id']);

/**
 * Create-or-reconcile a collection (review B #4). The engine's `POST /v1/schema` on an EXISTING
 * collection is not a no-op: Postgres runs COMMENT ON COLUMN for every declared field and CREATE
 * INDEX for every declared index in one transaction, so a single field or index naming a column the
 * table lacks rolls the whole push back as HTTP 500 ERR_SCHEMA (postgres.rs `create_collection`,
 * origin/main) — and with it every graph call, since init is awaited by all of them. A collection
 * provisioned by an older Lore (pre-v2 `lore_node`) lacks the v2 columns, so the full v2 schema can
 * never be re-pushed onto it.
 *
 *   1. read the collection's declared columns (`GET /v1/schema/:c`; a miss is a 200 ERR_NOT_FOUND
 *      envelope with no `fields`);
 *   2. absent -> push the FULL schema (fresh collections get every v2 column and index);
 *   3. present -> push only the fields and indexes over columns that exist, and log
 *      `cloud_schema_drift` ONCE listing the columns it left out. Values for those columns are
 *      still written: the Postgres connector routes undeclared fields into its `gf_extra` JSONB
 *      column and merges them back on read, so the node round-trips; they are not indexed, and a
 *      table without `gf_extra` (other connectors) may reject them, which is why the drift
 *      warning is a WARN, not a debug line. Columns can only be added by recreating the
 *      collection until Dataplane supports an additive ALTER (docs/DATAPLANE_INTEGRATION.md).
 * A client without `getCollectionSchema` (old SDK build) gets the legacy behaviour: push the full
 * schema and tolerate an "already exists" style refusal.
 *
 * Returns the declared columns the collection LACKS (empty for a fresh or fully current one), so a
 * caller can adapt to a legacy collection (cloud parity C item 8: `revision_state` is only written
 * and pushed down when it is declared).
 */
export async function ensureCollection(
    client: unknown,
    dataplaneWorkspaceId: string,
    schema: unknown,
    connection?: string,
): Promise<string[]> {
    const c = client as SchemaClient;
    const want = schema as SchemaShape;
    const declared = await readDeclaredColumns(c, dataplaneWorkspaceId, want.name, connection);
    if (declared === null) {
        try {
            await c.createCollection(dataplaneWorkspaceId, schema as never, connection);
        } catch (err) {
            // Legacy / no-introspection path: accept any "already exists" message shape.
            if (/already exists|duplicate|409/i.test((err as Error).message ?? String(err))) return [];
            throw err;
        }
        return [];
    }
    const have = new Set([...declared, ...ENGINE_OWNED_COLUMNS]);
    const missing = (want.fields ?? []).map((f) => f.name).filter((n) => !have.has(n));
    if (missing.length === 0) {
        await c.createCollection(dataplaneWorkspaceId, schema as never, connection);
        return [];
    }
    log.warn('cloud_schema_drift', { collection: want.name, missing });
    const reduced = {
        ...want,
        fields: (want.fields ?? []).filter((f) => have.has(f.name)),
        indexes: (want.indexes ?? []).filter((ix) => ix.fields.every((f) => have.has(f))),
    };
    await c.createCollection(dataplaneWorkspaceId, reduced as never, connection);
    return missing;
}

/**
 * Declared columns of an existing collection, or null when it does not exist / cannot be read
 * (no `getCollectionSchema`, a not-found envelope, an unrecognised shape, or any error: the caller
 * then takes the plain create path, exactly as before introspection existed).
 */
async function readDeclaredColumns(
    client: SchemaClient,
    dataplaneWorkspaceId: string,
    name: string | undefined,
    connection?: string,
): Promise<string[] | null> {
    if (typeof client.getCollectionSchema !== 'function' || !name) return null;
    try {
        return declaredFieldNames(await client.getCollectionSchema(dataplaneWorkspaceId, name, connection));
    } catch {
        return null;
    }
}

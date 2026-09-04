/**
 * crud.ts — Schema-driven CRUD (V3.0 Phase A2).
 *
 * Generates substrate-agnostic create / read / update / delete / list
 * operations for every node type declared in a workspace's
 * LoreSchemaV2. Like PostgREST/Hasura: callers (REST handlers, MCP
 * tools) point at a SchemaDrivenCrud instance and get a typed surface
 * without hand-writing one CRUD route per entity.
 *
 * What this module enforces:
 *
 *   - Floor fields are filled in at create time and immutable on update
 *     (id, type, workspace, ingestedAt, kind, provenance, createdBy).
 *   - Declared field validation: required fields must be present;
 *     primitive types must match.
 *   - ReBAC permission check for write ops when an evaluator is wired.
 *     Read-side scoping lives in the scope resolver — callers compose.
 *
 * What it does NOT do (deliberately):
 *
 *   - Connect to SurrealDB / Dataplane — caller supplies a NodeStorage
 *     adapter implementing five operations.
 *   - Index / search / vector embedding — those are different paths.
 *   - Audit on every read — only writes get audited (reads are too hot).
 */

import { randomUUID } from 'node:crypto';

import type {
    FieldSpec,
    LoreSchemaV2,
    NodeKind,
    NodeTypeSpec,
    ProvenanceRef,
} from '../schemas/types.js';
import { NODE_FLOOR_FIELDS } from '../schemas/types.js';

/**
 * NodeStorage — the substrate adapter the CRUD module talks to.
 *
 * Both LocalGraph (SurrealDB) and DataplaneGraph (cloud) implement these
 * five operations on top of their respective storage layers.
 */
export interface NodeStorage {
    create(input: {
        id: string;
        type: string;
        workspace: string;
        fields: Record<string, unknown>;
    }): Promise<NodeRecord>;
    read(id: string): Promise<NodeRecord | null>;
    update(id: string, fields: Record<string, unknown>): Promise<NodeRecord | null>;
    /** Returns true if a node was deleted, false if it didn't exist. */
    delete(id: string): Promise<boolean>;
    list(input: {
        type: string;
        workspace: string;
        filter?: Record<string, unknown>;
        limit?: number;
    }): Promise<NodeRecord[]>;
}

export interface NodeRecord {
    id: string;
    type: string;
    workspace: string;
    fields: Record<string, unknown>;
}

/**
 * CrudContext — runtime metadata threaded through every call.
 *
 *   subject — the user/agent making the call. Stamps `createdBy` on
 *             create. Used for ReBAC checks if an evaluator is supplied.
 *   provenance — written into the floor on create. Defaults to a
 *                manual:<subject> ref when omitted.
 *   workspace — the workspace these operations target.
 *
 * `permissionCheck` is optional. When supplied, the module calls it
 * before every write op; deny → CrudError with code 'denied'. Reads
 * are NOT permission-checked here — the caller is expected to filter
 * post-list with the scope resolver + evaluator.
 */
export interface CrudContext {
    subject: string;
    workspace: string;
    provenance?: ProvenanceRef;
    permissionCheck?: (input: {
        subject: string;
        action: 'create' | 'update' | 'delete';
        resource: string;
        resourceType: string;
    }) => Promise<{ allowed: boolean; reason?: unknown }>;
}

export class CrudError extends Error {
    constructor(
        public readonly code:
        | 'unknown-type'
        | 'validation'
        | 'denied'
        | 'not-found'
        | 'immutable-field'
        | 'missing-context',
        message: string,
    ) {
        super(message);
        this.name = 'CrudError';
    }
}

export class SchemaDrivenCrud {
    private types = new Map<string, NodeTypeSpec>();
    private kindOf = new Map<string, NodeKind>();

    constructor(
        private schema: LoreSchemaV2,
        private readonly storage: NodeStorage,
    ) {
        this.indexSchema();
    }

    /** Swap in a new schema (e.g., after a SchemaAuthoringStore.approve). */
    setSchema(schema: LoreSchemaV2): void {
        this.schema = schema;
        this.indexSchema();
    }

    listTypes(): NodeTypeSpec[] {
        return Array.from(this.types.values());
    }

    /* ---------- create ---------- */

    async create(
        type: string,
        fields: Record<string, unknown>,
        ctx: CrudContext,
    ): Promise<NodeRecord> {
        if (!ctx.subject) throw new CrudError('missing-context', 'CrudContext.subject required');
        if (!ctx.workspace) throw new CrudError('missing-context', 'CrudContext.workspace required');
        const spec = this.requireType(type);

        const declared = stripFloor(fields);
        validateAgainst(spec, declared);

        const id = (fields.id as string | undefined) ?? this.newId(type);

        if (ctx.permissionCheck) {
            const result = await ctx.permissionCheck({
                subject: ctx.subject,
                action: 'create',
                resource: id,
                resourceType: type,
            });
            if (!result.allowed) {
                throw new CrudError('denied', `permission denied: create ${type}`);
            }
        }

        const provenance: ProvenanceRef = ctx.provenance ?? {
            sourceUri: `manual:${ctx.subject}`,
            ingestedAtIso: new Date().toISOString(),
        };

        const fullFields: Record<string, unknown> = {
            ...declared,
            id,
            type,
            workspace: ctx.workspace,
            ingestedAt: new Date().toISOString(),
            createdBy: ctx.subject,
            kind: spec.kind,
            provenance,
        };

        return this.storage.create({ id, type, workspace: ctx.workspace, fields: fullFields });
    }

    /* ---------- read ---------- */

    async read(id: string): Promise<NodeRecord | null> {
        return this.storage.read(id);
    }

    /* ---------- update ---------- */

    async update(
        id: string,
        patch: Record<string, unknown>,
        ctx: CrudContext,
    ): Promise<NodeRecord> {
        if (!ctx.subject) throw new CrudError('missing-context', 'CrudContext.subject required');
        const existing = await this.storage.read(id);
        if (!existing) throw new CrudError('not-found', `node '${id}' not found`);

        // Floor fields are immutable.
        for (const k of Object.keys(patch)) {
            if ((NODE_FLOOR_FIELDS as readonly string[]).includes(k)) {
                throw new CrudError('immutable-field', `cannot update floor field '${k}'`);
            }
        }

        const spec = this.requireType(existing.type);
        if (spec.appendOnly || spec.kind === 'episodic') {
            throw new CrudError(
                'immutable-field',
                `node type '${existing.type}' is append-only (kind=${spec.kind}); use a corrective new record instead`,
            );
        }

        validatePatchAgainst(spec, patch);

        if (ctx.permissionCheck) {
            const result = await ctx.permissionCheck({
                subject: ctx.subject,
                action: 'update',
                resource: id,
                resourceType: existing.type,
            });
            if (!result.allowed) {
                throw new CrudError('denied', `permission denied: update ${existing.type}`);
            }
        }

        const updated = await this.storage.update(id, patch);
        if (!updated) throw new CrudError('not-found', `node '${id}' vanished mid-update`);
        return updated;
    }

    /* ---------- delete ---------- */

    async delete(id: string, ctx: CrudContext): Promise<boolean> {
        if (!ctx.subject) throw new CrudError('missing-context', 'CrudContext.subject required');
        const existing = await this.storage.read(id);
        if (!existing) return false;

        if (ctx.permissionCheck) {
            const result = await ctx.permissionCheck({
                subject: ctx.subject,
                action: 'delete',
                resource: id,
                resourceType: existing.type,
            });
            if (!result.allowed) {
                throw new CrudError('denied', `permission denied: delete ${existing.type}`);
            }
        }
        return this.storage.delete(id);
    }

    /* ---------- list ---------- */

    async list(
        type: string,
        ctx: CrudContext,
        opts: { filter?: Record<string, unknown>; limit?: number } = {},
    ): Promise<NodeRecord[]> {
        if (!ctx.workspace) throw new CrudError('missing-context', 'CrudContext.workspace required');
        this.requireType(type);
        return this.storage.list({
            type,
            workspace: ctx.workspace,
            filter: opts.filter,
            limit: opts.limit,
        });
    }

    /* ---------- internals ---------- */

    private indexSchema(): void {
        this.types.clear();
        this.kindOf.clear();
        for (const t of this.schema.nodeTypes) {
            this.types.set(t.name, t);
            this.kindOf.set(t.name, t.kind);
        }
    }

    private requireType(type: string): NodeTypeSpec {
        const spec = this.types.get(type);
        if (!spec) {
            throw new CrudError(
                'unknown-type',
                `'${type}' is not declared in the workspace schema`,
            );
        }
        return spec;
    }

    private newId(type: string): string {
        return `${type}:${randomUUID()}`;
    }
}

/* ---------- validation helpers ---------- */

function stripFloor(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const floor = new Set<string>(NODE_FLOOR_FIELDS as readonly string[]);
    for (const [k, v] of Object.entries(fields)) {
        if (floor.has(k)) continue;
        out[k] = v;
    }
    return out;
}

function validateAgainst(spec: NodeTypeSpec, fields: Record<string, unknown>): void {
    for (const f of spec.fields ?? []) {
        if (f.required && !(f.name in fields)) {
            throw new CrudError('validation', `required field '${f.name}' missing on ${spec.name}`);
        }
        if (f.name in fields) checkType(f, fields[f.name], spec.name);
    }
}

function validatePatchAgainst(spec: NodeTypeSpec, patch: Record<string, unknown>): void {
    const declared = new Map<string, FieldSpec>();
    for (const f of spec.fields ?? []) declared.set(f.name, f);
    for (const [k, v] of Object.entries(patch)) {
        const f = declared.get(k);
        if (!f) continue; // unknown fields permitted (forwards-compat); ignore
        checkType(f, v, spec.name);
    }
}

function checkType(field: FieldSpec, value: unknown, ownerLabel: string): void {
    if (value === null) return;
    switch (field.type) {
        case 'string':
            if (typeof value !== 'string') throwType(field, value, ownerLabel);
            break;
        case 'number':
            if (typeof value !== 'number' || Number.isNaN(value)) throwType(field, value, ownerLabel);
            break;
        case 'boolean':
            if (typeof value !== 'boolean') throwType(field, value, ownerLabel);
            break;
        case 'datetime':
            if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
                throwType(field, value, ownerLabel);
            }
            break;
        case 'json':
            if (typeof value !== 'object') throwType(field, value, ownerLabel);
            break;
        case 'embedding':
            if (!Array.isArray(value)) throwType(field, value, ownerLabel);
            break;
    }
}

function throwType(field: FieldSpec, value: unknown, ownerLabel: string): never {
    throw new CrudError(
        'validation',
        `${ownerLabel}.${field.name}: expected ${field.type}, got ${typeof value} (${JSON.stringify(value).slice(0, 40)})`,
    );
}

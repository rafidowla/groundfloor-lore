/**
 * Schema types — workspace-declarable node/edge specs with floor invariants.
 *
 * Locked decisions this file encodes:
 *   - Soft mem/know split via `kind: 'episodic' | 'factual'` on every NodeTypeSpec
 *     (lore-mem-know-soft-split-2026-05-07).
 *   - ReBAC two-layer model: L1 = 5 relation edges in REBAC_RELATION_EDGES;
 *     L2 = PermissionSchema authored per workspace
 *     (lore-rebac-two-layer-2026-05-07).
 *   - Schema floor: NODE_FLOOR_FIELDS + EDGE_FLOOR_FIELDS — required on every
 *     node/edge regardless of workspace schema. Workspaces extend the floor;
 *     they cannot remove from it.
 *
 * Backward compat: the legacy flat-string LoreSchema (domain + nodeTypes:
 * string[] + edgeRelations: string[]) still loads. `migrateLegacySchema`
 * lifts it into the typed shape, defaulting `kind` to 'factual'.
 */

/* ---------- Floor: invariant fields on every node and edge ---------- */

/** Required fields on every node, regardless of workspace schema. */
export const NODE_FLOOR_FIELDS = [
    'id',
    'type',
    'workspace',
    'ingestedAt',
    'provenance',
    'createdBy',
    'kind',
] as const;

/** Required fields on every edge, regardless of workspace schema. */
export const EDGE_FLOOR_FIELDS = [
    'from',
    'to',
    'type',
    'createdAt',
    'createdBy',
] as const;

export type NodeFloorField = typeof NODE_FLOOR_FIELDS[number];
export type EdgeFloorField = typeof EDGE_FLOOR_FIELDS[number];

/** Source provenance — where the node/edge originated. */
export interface ProvenanceRef {
    sourceConnector?: string;
    sourceUri?: string;
    /** Ordered list of transform steps applied during ingest. */
    transformChain?: string[];
    ingestedAtIso?: string;
}

/* ---------- Soft mem/know split ---------- */

/**
 * NodeKind — the soft mem/know split.
 *
 *   episodic — events that happened (conversations, observations, actions).
 *              Append-only, vector-biased retrieval, decay-aware,
 *              per-speaker permissions by default.
 *
 *   factual  — assertions about the world (entities, facts, relationships).
 *              Mutable with audit, graph-biased retrieval, ReBAC permissions
 *              by default, persistent until contradicted.
 *
 * Lore promotes patterns in episodic data to factual assertions via the
 * promotion pipeline (V4+). Auto-applies above the workspace's confidence
 * threshold; landed in the curator queue otherwise (opt-in queue).
 */
export type NodeKind = 'episodic' | 'factual';

export const DEFAULT_NODE_KIND: NodeKind = 'factual';

/* ---------- Field specs ---------- */

export type FieldType =
    | 'string'
    | 'number'
    | 'boolean'
    | 'datetime'
    | 'json'
    | 'embedding';

/** A single field on a node or edge, beyond the floor. */
export interface FieldSpec {
    name: string;
    type: FieldType;
    required?: boolean;
    indexed?: boolean;
    /** Tag for PII / sensitivity. Drives access controls + log redaction. */
    sensitive?: boolean;
    /** When true, the field's value contributes to the node's embedding. */
    embedded?: boolean;
    description?: string;
    /**
     * Phase 4 item 5 — transitional marker set during the EXPAND phase
     * of a `field.type_changed` decomposition. Tells readers + writers
     * that this field can carry either the `from` shape (legacy data
     * not yet migrated) or the `to` shape (post-migrate data). The
     * `type` field on this spec stays at `from` during expand; the
     * contract phase removes this marker and flips `type` to `to`.
     *
     * Lore stores node fields as JSON metadata, so this marker is
     * informational at the substrate level — but it makes the schema
     * itself honest about the in-flight migration and gives readers a
     * machine-readable way to coerce values they encounter.
     */
    typeMigrating?: { from: FieldType; to: FieldType };
}

/* ---------- Node + edge type specs ---------- */

export interface NodeTypeSpec {
    name: string;
    description: string;
    /** Soft mem/know split. See NodeKind jsdoc. */
    kind: NodeKind;
    /** Fields declared on top of the node floor. */
    fields?: FieldSpec[];
    /** True for nodes that should never be edited after creation (typical for episodic). */
    appendOnly?: boolean;
    /** Optional decay policy (factual nodes typically 'never'). */
    decay?: { strategy: 'time' | 'never'; halfLifeDays?: number };
    /**
     * When true, the recall ranker applies a 1.5× type-bias multiplier to nodes
     * of this type. Replaces the old hardcoded OPERATOR_CURATED_TYPES set.
     * Workspace schemas opt specific types in; unset/false means no bias (1.0×).
     */
    operatorCurated?: boolean;
}

export type EdgeCardinality = 'one-to-one' | 'one-to-many' | 'many-to-many';

export interface EdgeTypeSpec {
    name: string;
    description: string;
    cardinality?: EdgeCardinality;
    /** Name of the inverse edge type, if directional. */
    inverse?: string;
    /** Fields declared on top of the edge floor. */
    fields?: FieldSpec[];
}

/* ---------- ReBAC: L1 relation edges (platform-locked) ---------- */

/**
 * REBAC_RELATION_EDGES — the five relation-edge types every workspace gets
 * for free. Locked at the platform level. Workspaces cannot remove or
 * rename these.
 *
 *   owner   — subject has full control of the resource
 *   editor  — subject can read and write the resource
 *   viewer  — subject can read the resource
 *   member  — subject is a member of a group / workspace
 *   parent  — hierarchy: child inherits relations from parent
 *
 * Action-level nuance ("PM can approve tickets, can't transfer ownership")
 * is layered on top via L2 PermissionSchema.
 */
export const REBAC_RELATION_EDGES: readonly EdgeTypeSpec[] = [
    {
        name: 'owner',
        description: 'Subject has full control of the resource.',
    },
    {
        name: 'editor',
        description: 'Subject can read and write the resource.',
    },
    {
        name: 'viewer',
        description: 'Subject can read the resource.',
    },
    {
        name: 'member',
        description: 'Subject is a member of a group or workspace.',
    },
    {
        name: 'parent',
        description: 'Hierarchy edge — child inherits relations from parent.',
    },
] as const;

export const REBAC_RELATION_EDGE_NAMES: readonly string[] =
    REBAC_RELATION_EDGES.map(e => e.name);

/* ---------- ReBAC: L2 permission schema (workspace-declared) ---------- */

/**
 * Permission expression — an OR of relation names that satisfy the action.
 *
 * Grammar (v1, intentionally narrow):
 *   expr     := term ('|' term)*
 *   term     := relation
 *   relation := 'owner' | 'editor' | 'viewer' | 'member' | <custom workspace relation>
 *
 * Examples:
 *   "owner"
 *   "editor | owner"
 *   "viewer | editor | owner"
 *
 * AND, NOT, and parent-traversal expressions are deferred. When needed they
 * land in the SpiceDB-backed cloud evaluator first; the local Kùzu evaluator
 * follows.
 */
export type PermissionExpression = string;

export interface PermissionSchema {
    /** keyed by resource type (node type name) → action name → expression */
    [resourceType: string]: {
        [action: string]: PermissionExpression;
    };
}

/* ---------- Scope specs (T7) ---------- */

/**
 * ScopeDirection — how the resolver walks edges relative to the root node.
 *
 *   'down' — edges that point INTO the root (incoming). For the parent
 *            edge (child --parent--> parent), 'down' from NodeA
 *            collects every descendant whose parent (transitively) is NodeA.
 *
 *   'up'   — edges that leave the root (outgoing). 'up' from a leaf
 *            via parent collects the ancestor chain to the root.
 *
 *   'both' — union of up and down. Useful for "everything in this
 *            cluster, from any direction."
 */
export type ScopeDirection = 'down' | 'up' | 'both';

/**
 * ScopeSpec — a workspace-declared traversal pattern. NOT a fixed
 * 4-level hierarchy; the workspace schema decides what its hierarchy
 * looks like by declaring which edge types form the spine and how
 * far to walk.
 *
 * Example: a domain workspace might declare
 *   node-and-descendants: { viaEdges: ['parent'], direction: 'down' }
 * A flat-org workspace might declare
 *   none — and use no scope at all.
 */
export interface ScopeSpec {
    /** Edge type names to follow when walking. */
    viaEdges: string[];
    direction: ScopeDirection;
    /** Stop after this many hops. Default 8 in the resolver. */
    maxDepth?: number;
    /** Optional: only include nodes of these types in the result. */
    includeTypes?: string[];
    /** Optional: include the root id itself in the result. Default true. */
    includeRoot?: boolean;
    description?: string;
}

/** Workspace-declared map of scope-name → ScopeSpec. */
export type ScopeSchema = Record<string, ScopeSpec>;

/* ---------- Top-level schema shape ---------- */

/** Schema format version. Bumped on breaking changes to this type. */
export const SCHEMA_FORMAT_VERSION = 2;

export interface LoreSchemaV2 {
    /** Equal to SCHEMA_FORMAT_VERSION when written by this code. */
    version: number;
    domain: string;
    description: string;
    nodeTypes: NodeTypeSpec[];
    edgeTypes: EdgeTypeSpec[];
    permissions?: PermissionSchema;
    /** Optional named scope rules — used by the scope resolver (T7). */
    scopes?: ScopeSchema;
    systemPrompt: string;
}

/* ---------- Validation ---------- */

export interface SchemaValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

const VALID_FIELD_TYPES: readonly FieldType[] = [
    'string', 'number', 'boolean', 'datetime', 'json', 'embedding',
];
const VALID_NODE_KINDS: readonly NodeKind[] = ['episodic', 'factual'];

function validateField(
    field: FieldSpec,
    ownerLabel: string,
    floorFields: readonly string[],
    errors: string[],
): void {
    if (!field.name) {
        errors.push(`${ownerLabel}: field is missing 'name'.`);
        return;
    }
    if ((floorFields as readonly string[]).includes(field.name)) {
        errors.push(
            `${ownerLabel}.${field.name}: collides with floor field — floor fields are reserved.`,
        );
    }
    if (!VALID_FIELD_TYPES.includes(field.type)) {
        errors.push(
            `${ownerLabel}.${field.name}: invalid field type '${field.type}'. ` +
            `Allowed: ${VALID_FIELD_TYPES.join(', ')}.`,
        );
    }
    // Phase 4 item 5 — typeMigrating marker validation.
    if (field.typeMigrating) {
        const m = field.typeMigrating;
        if (!VALID_FIELD_TYPES.includes(m.from) || !VALID_FIELD_TYPES.includes(m.to)) {
            errors.push(
                `${ownerLabel}.${field.name}.typeMigrating: invalid {from: '${m.from}', to: '${m.to}'}. ` +
                `Both must be one of: ${VALID_FIELD_TYPES.join(', ')}.`,
            );
        }
        if (m.from === m.to) {
            errors.push(
                `${ownerLabel}.${field.name}.typeMigrating: from and to are both '${m.from}'; remove the marker instead.`,
            );
        }
        if (field.type !== m.from) {
            errors.push(
                `${ownerLabel}.${field.name}: type is '${field.type}' but typeMigrating.from is '${m.from}' ` +
                `(expand phase must keep type at the original; contract phase removes the marker AND flips type).`,
            );
        }
    }
}

function validatePermissionExpression(
    expr: PermissionExpression,
    customRelations: readonly string[],
    label: string,
    errors: string[],
): void {
    if (!expr || typeof expr !== 'string') {
        errors.push(`${label}: empty or non-string permission expression.`);
        return;
    }
    const knownRelations = new Set<string>([
        ...REBAC_RELATION_EDGE_NAMES,
        ...customRelations,
    ]);
    const terms = expr.split('|').map(t => t.trim()).filter(Boolean);
    if (terms.length === 0) {
        errors.push(`${label}: expression has no terms.`);
        return;
    }
    for (const term of terms) {
        if (!knownRelations.has(term)) {
            errors.push(
                `${label}: unknown relation '${term}'. ` +
                `Known relations: ${Array.from(knownRelations).sort().join(', ')}.`,
            );
        }
    }
}

/**
 * validateSchema — run structural checks against a LoreSchemaV2.
 *
 * Catches:
 *   - missing required top-level fields
 *   - unknown / invalid node kinds
 *   - field name collisions with the floor
 *   - invalid field types
 *   - duplicate node-type or edge-type names
 *   - permission expressions that reference unknown relations
 *
 * Returns errors AND warnings; schema is `valid` when errors is empty.
 */
export function validateSchema(schema: LoreSchemaV2): SchemaValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!schema || typeof schema !== 'object') {
        return { valid: false, errors: ['schema is not an object'], warnings };
    }

    if (typeof schema.version !== 'number') {
        errors.push("schema.version must be a number");
    } else if (schema.version > SCHEMA_FORMAT_VERSION) {
        warnings.push(
            `schema.version (${schema.version}) is newer than this code's ` +
            `SCHEMA_FORMAT_VERSION (${SCHEMA_FORMAT_VERSION}); some fields may be ignored.`,
        );
    }

    if (!Array.isArray(schema.nodeTypes)) {
        errors.push("schema.nodeTypes must be an array");
    }
    if (!Array.isArray(schema.edgeTypes)) {
        errors.push("schema.edgeTypes must be an array");
    }

    if (!Array.isArray(schema.nodeTypes) || !Array.isArray(schema.edgeTypes)) {
        return { valid: errors.length === 0, errors, warnings };
    }

    /* node types */
    const seenNodeNames = new Set<string>();
    for (const nt of schema.nodeTypes) {
        if (!nt.name) {
            errors.push("nodeType missing 'name'");
            continue;
        }
        if (seenNodeNames.has(nt.name)) {
            errors.push(`duplicate node type '${nt.name}'`);
        }
        seenNodeNames.add(nt.name);
        if (!VALID_NODE_KINDS.includes(nt.kind)) {
            errors.push(
                `nodeType '${nt.name}': invalid kind '${nt.kind}'. ` +
                `Allowed: ${VALID_NODE_KINDS.join(', ')}.`,
            );
        }
        for (const f of nt.fields ?? []) {
            validateField(f, `nodeType '${nt.name}'`, NODE_FLOOR_FIELDS, errors);
        }
    }

    /* edge types — workspaces may not redefine ReBAC relation edges */
    const seenEdgeNames = new Set<string>();
    const customEdgeNames: string[] = [];
    for (const et of schema.edgeTypes) {
        if (!et.name) {
            errors.push("edgeType missing 'name'");
            continue;
        }
        if (seenEdgeNames.has(et.name)) {
            errors.push(`duplicate edge type '${et.name}'`);
        }
        seenEdgeNames.add(et.name);
        if (REBAC_RELATION_EDGE_NAMES.includes(et.name)) {
            // Allowed; workspaces can re-list ReBAC edges, but they shouldn't redefine fields on them.
            if (et.fields && et.fields.length > 0) {
                errors.push(
                    `edgeType '${et.name}' is a ReBAC relation edge (platform-locked). ` +
                    `Workspaces may not declare fields on it.`,
                );
            }
        } else {
            customEdgeNames.push(et.name);
        }
        for (const f of et.fields ?? []) {
            validateField(f, `edgeType '${et.name}'`, EDGE_FLOOR_FIELDS, errors);
        }
    }

    /* permissions */
    if (schema.permissions) {
        for (const [resourceType, actions] of Object.entries(schema.permissions)) {
            if (!seenNodeNames.has(resourceType)) {
                warnings.push(
                    `permissions reference resourceType '${resourceType}' ` +
                    `which is not declared in nodeTypes.`,
                );
            }
            for (const [action, expr] of Object.entries(actions)) {
                validatePermissionExpression(
                    expr,
                    customEdgeNames,
                    `permissions['${resourceType}'].${action}`,
                    errors,
                );
            }
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

/* ---------- Legacy migration ---------- */

/**
 * Legacy flat-string LoreSchema (pre-2026-05-07). Kept here so the loader
 * can read older schema.json files without the user re-authoring them.
 */
export interface LegacyLoreSchema {
    domain: string;
    description: string;
    nodeTypes: string[];
    edgeRelations: string[];
    systemPrompt: string;
}

/**
 * Lift a legacy flat-string LoreSchema into a LoreSchemaV2.
 *
 * Defaults applied:
 *   - every node type → kind: 'factual' (the safer default; episodic data
 *     came in via specific plugins, never via the flat schema)
 *   - every edge type → no cardinality / inverse declared
 *   - no permissions section (workspace can author one later)
 *
 * The five ReBAC relation edges are appended automatically — workspaces
 * always have them available. If a legacy schema also listed e.g. 'owner'
 * in edgeRelations, the duplicate is dropped (ReBAC version wins).
 */
export function migrateLegacySchema(legacy: LegacyLoreSchema): LoreSchemaV2 {
    const nodeTypes: NodeTypeSpec[] = (legacy.nodeTypes ?? []).map(name => ({
        name,
        description: `Legacy node type '${name}' — auto-migrated.`,
        kind: DEFAULT_NODE_KIND,
    }));

    const customEdges: EdgeTypeSpec[] = (legacy.edgeRelations ?? [])
        .filter(name => !REBAC_RELATION_EDGE_NAMES.includes(name))
        .map(name => ({
            name,
            description: `Legacy edge relation '${name}' — auto-migrated.`,
        }));

    return {
        version: SCHEMA_FORMAT_VERSION,
        domain: legacy.domain ?? 'Unspecified',
        description: legacy.description ?? '',
        nodeTypes,
        edgeTypes: [...REBAC_RELATION_EDGES, ...customEdges],
        systemPrompt: legacy.systemPrompt ?? '',
    };
}

/* ---------- Default schema ---------- */

/**
 * The minimal schema every workspace gets if no schema.json is present.
 * Intentionally domain-agnostic — contains only universally applicable
 * knowledge-management primitives. Domain-specific types (Loom agent
 * records, Atlas code-intelligence types, CRE/legal/etc.) belong in the
 * client application's own schema.json, pushed via /api/schema/contribute.
 *
 * Includes:
 *   - six generic factual node types (decision, convention, note,
 *     bug_pattern, architecture, troubleshooting)
 *   - the five ReBAC relation edges (always present)
 *   - six core relation labels (decided_for, caused_by, applies_to,
 *     supersedes, related_to, depends_on) preserved for back-compat
 *   - no permissions section (workspace may add later)
 *   - no systemPrompt (each client supplies its own context-appropriate prompt)
 */
export const DEFAULT_SCHEMA_V2: LoreSchemaV2 = {
    version: SCHEMA_FORMAT_VERSION,
    domain: 'General',
    description: 'Schema-agnostic default for Groundfloor-Lore.',
    nodeTypes: [
        { name: 'decision', description: 'A choice made between options, and its reasoning.', kind: 'factual' },
        { name: 'convention', description: 'An agreed-upon pattern or practice.', kind: 'factual' },
        { name: 'note', description: 'A general note or observation.', kind: 'factual' },
        { name: 'bug_pattern', description: 'A recurring problem, its root cause, and the fix.', kind: 'factual' },
        { name: 'architecture', description: 'High-level structure or design of a system or entity.', kind: 'factual' },
        { name: 'troubleshooting', description: 'Step-by-step recovery for a known failure.', kind: 'factual' },
    ],
    edgeTypes: [
        ...REBAC_RELATION_EDGES,
        { name: 'decided_for', description: 'Decision was made for this purpose.' },
        { name: 'caused_by', description: 'Caused by another node.' },
        { name: 'applies_to', description: 'Applies to a target node.' },
        { name: 'supersedes', description: 'This node replaces an earlier one.' },
        { name: 'related_to', description: 'Generic relation between two nodes.' },
        { name: 'depends_on', description: 'This node depends on another.' },
    ],
    systemPrompt: '',
};

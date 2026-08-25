/**
 * describe.ts — Schema-as-data emission for the Lore schema.
 *
 * The point: Lore is a database, and a database lets you ask it what its
 * schema looks like. This file emits a JSON-serializable description of
 * a LoreSchemaV2 so MCP tools, the admin app, and the AI agent can all
 * introspect a workspace's shape uniformly.
 *
 * Two emission shapes are exported:
 *
 *   describeSchema(schema) — full structured detail. The format is stable
 *   and intended for programmatic consumers (admin app, automation,
 *   schema-evolution proposals).
 *
 *   summarizeSchema(schema) — short human/AI-readable summary suitable
 *   for chat surfaces and Lore's own recall responses ("you have 12 node
 *   types, 8 of them factual, ReBAC permissions configured for account
 *   and record, …"). No PII; safe to embed in logs.
 */

import {
    REBAC_RELATION_EDGE_NAMES,
    NODE_FLOOR_FIELDS,
    EDGE_FLOOR_FIELDS,
    type LoreSchemaV2,
    type NodeKind,
    type NodeTypeSpec,
    type EdgeTypeSpec,
} from './types.js';

/* ---------- Detailed description ---------- */

export interface DescribedField {
    name: string;
    type: string;
    required: boolean;
    indexed: boolean;
    sensitive: boolean;
    embedded: boolean;
    description?: string;
}

export interface DescribedNodeType {
    name: string;
    description: string;
    kind: NodeKind;
    appendOnly: boolean;
    decay?: { strategy: 'time' | 'never'; halfLifeDays?: number };
    /** Floor fields are included so consumers see the full surface. */
    floorFields: readonly string[];
    /** Workspace-declared fields beyond the floor. */
    declaredFields: DescribedField[];
}

export interface DescribedEdgeType {
    name: string;
    description: string;
    isRebacRelation: boolean;
    cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-many';
    inverse?: string;
    floorFields: readonly string[];
    declaredFields: DescribedField[];
}

export interface DescribedPermission {
    resourceType: string;
    action: string;
    expression: string;
    /** Parsed disjunction terms — always lower-case. */
    terms: string[];
}

export interface SchemaDescription {
    version: number;
    domain: string;
    description: string;
    systemPrompt: string;
    /** Counts at a glance — useful for dashboards. */
    counts: {
        nodeTypes: number;
        episodicNodeTypes: number;
        factualNodeTypes: number;
        edgeTypes: number;
        rebacRelationEdges: number;
        customEdgeTypes: number;
        permissionResourceTypes: number;
        permissionActions: number;
    };
    nodeTypes: DescribedNodeType[];
    edgeTypes: DescribedEdgeType[];
    permissions: DescribedPermission[];
    /** Floor invariants — the contract everything else builds on. */
    floor: {
        nodeFields: readonly string[];
        edgeFields: readonly string[];
    };
}

function describeField(f: { name: string; type: string; required?: boolean; indexed?: boolean; sensitive?: boolean; embedded?: boolean; description?: string }): DescribedField {
    return {
        name: f.name,
        type: f.type,
        required: f.required ?? false,
        indexed: f.indexed ?? false,
        sensitive: f.sensitive ?? false,
        embedded: f.embedded ?? false,
        description: f.description,
    };
}

function describeNodeType(nt: NodeTypeSpec): DescribedNodeType {
    return {
        name: nt.name,
        description: nt.description,
        kind: nt.kind,
        appendOnly: nt.appendOnly ?? (nt.kind === 'episodic'),
        decay: nt.decay,
        floorFields: NODE_FLOOR_FIELDS,
        declaredFields: (nt.fields ?? []).map(describeField),
    };
}

function describeEdgeType(et: EdgeTypeSpec): DescribedEdgeType {
    return {
        name: et.name,
        description: et.description,
        isRebacRelation: REBAC_RELATION_EDGE_NAMES.includes(et.name),
        cardinality: et.cardinality,
        inverse: et.inverse,
        floorFields: EDGE_FLOOR_FIELDS,
        declaredFields: (et.fields ?? []).map(describeField),
    };
}

/**
 * Emit the full structured description.
 *
 * The output is JSON-serializable and stable: callers can diff two
 * descriptions to see exactly what changed across schema evolutions.
 */
export function describeSchema(schema: LoreSchemaV2): SchemaDescription {
    const permissions: DescribedPermission[] = [];
    let permissionResourceTypes = 0;
    let permissionActions = 0;
    if (schema.permissions) {
        for (const [resourceType, actions] of Object.entries(schema.permissions)) {
            permissionResourceTypes++;
            for (const [action, expr] of Object.entries(actions)) {
                permissionActions++;
                permissions.push({
                    resourceType,
                    action,
                    expression: expr,
                    terms: expr.split('|').map(t => t.trim()).filter(Boolean),
                });
            }
        }
    }

    const episodicNodeTypes = schema.nodeTypes.filter(n => n.kind === 'episodic').length;
    const factualNodeTypes = schema.nodeTypes.filter(n => n.kind === 'factual').length;
    const rebacRelationEdges = schema.edgeTypes.filter(e =>
        REBAC_RELATION_EDGE_NAMES.includes(e.name),
    ).length;
    const customEdgeTypes = schema.edgeTypes.length - rebacRelationEdges;

    return {
        version: schema.version,
        domain: schema.domain,
        description: schema.description,
        systemPrompt: schema.systemPrompt,
        counts: {
            nodeTypes: schema.nodeTypes.length,
            episodicNodeTypes,
            factualNodeTypes,
            edgeTypes: schema.edgeTypes.length,
            rebacRelationEdges,
            customEdgeTypes,
            permissionResourceTypes,
            permissionActions,
        },
        nodeTypes: schema.nodeTypes.map(describeNodeType),
        edgeTypes: schema.edgeTypes.map(describeEdgeType),
        permissions,
        floor: {
            nodeFields: NODE_FLOOR_FIELDS,
            edgeFields: EDGE_FLOOR_FIELDS,
        },
    };
}

/* ---------- Short summary ---------- */

/**
 * Short human/AI-readable summary. One paragraph, no internal field
 * names dumped — designed for LLM context windows and chat UIs.
 *
 * Stable wording: callers can include this verbatim in prompts without
 * worrying about format drift across schema versions.
 */
export function summarizeSchema(schema: LoreSchemaV2): string {
    const d = describeSchema(schema);
    const parts: string[] = [];
    parts.push(
        `${d.domain} workspace (schema v${d.version}): ${d.counts.nodeTypes} node type` +
        `${d.counts.nodeTypes === 1 ? '' : 's'} ` +
        `(${d.counts.factualNodeTypes} factual, ${d.counts.episodicNodeTypes} episodic), ` +
        `${d.counts.edgeTypes} edge type${d.counts.edgeTypes === 1 ? '' : 's'} ` +
        `(${d.counts.rebacRelationEdges} ReBAC, ${d.counts.customEdgeTypes} custom).`,
    );

    if (d.counts.permissionActions > 0) {
        parts.push(
            `Permission schema covers ${d.counts.permissionActions} action` +
            `${d.counts.permissionActions === 1 ? '' : 's'} ` +
            `across ${d.counts.permissionResourceTypes} resource type` +
            `${d.counts.permissionResourceTypes === 1 ? '' : 's'}.`,
        );
    } else {
        parts.push('No permission schema declared yet.');
    }

    return parts.join(' ');
}

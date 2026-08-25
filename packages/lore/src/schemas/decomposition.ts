/**
 * decomposition.ts — Phase 4 item 9.
 *
 * "Expand → migrate → contract" decomposition for destructive schema
 * changes. When a human submits a rename or a removal, the
 * decomposer returns the SEQUENCE of operations that lets the
 * change land safely instead of one big destructive event:
 *
 *   - **Expand**: additive schema proposal that adds the new shape
 *     ALONGSIDE the old. Old readers keep working.
 *   - **Migrate**: a MigrationPlan the runner executes to transform
 *     existing data from old shape to new.
 *   - **Contract**: destructive schema proposal that drops the old
 *     shape once nobody reads it. Subject to Phase 1 destructive
 *     guard (must be `human:`-proposed) and the operator's soak
 *     period decision.
 *
 * Not every destructive kind has a meaningful 3-phase form. For
 * example `node_type.removed` has no new shape to expand — the
 * decomposer returns a 2-phase plan (migrate + contract). Pure
 * schema-only kinds (`kind_changed`, `sensitivity_flipped`, the
 * permission edits) decompose to a 1-phase plan (contract only).
 *
 * The decomposer does NOT execute anything. It returns a plan an
 * operator (or admin UI) walks through using the existing endpoints:
 *   - phase.kind === 'expand'   → POST /api/schema/proposals (additive)
 *   - phase.kind === 'migrate'  → POST /api/schema/migrations/execute
 *   - phase.kind === 'contract' → POST /api/schema/proposals (destructive)
 *
 * Auto-orchestration (state machine, soak timers, advance-on-ready)
 * is deferred. The MVP is "give the operator the three pieces, let
 * them step through manually."
 *
 * See docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md for the safety rationale
 * (every destructive change SHOULD be decomposed; humans submitting
 * destructive ops should think in three phases, not one).
 */

import { randomUUID } from 'node:crypto';

import type { ProposedChange, SchemaProposal } from './authoring.js';
import { buildProposal } from './authoring.js';
import type { LoreSchemaV2, NodeTypeSpec, EdgeTypeSpec, PermissionSchema, FieldType } from './types.js';
import type { MigrationOp, MigrationPlan } from './migration/types.js';

/* ────────────────────────────────────────────────────────────── */
/*  Public shapes                                                 */
/* ────────────────────────────────────────────────────────────── */

export type DecomposedPhaseKind = 'expand' | 'migrate' | 'contract';

/**
 * One phase in a decomposed plan. Either holds a SchemaProposal
 * (expand / contract) OR a MigrationPlan (migrate). Distinguished
 * by `kind`.
 */
export type DecomposedPhase =
    | { kind: 'expand';   proposal: SchemaProposal;   description: string }
    | { kind: 'migrate';  plan: MigrationPlan;        description: string }
    | { kind: 'contract'; proposal: SchemaProposal;   description: string };

export interface DecomposedPlan {
    /** Stable identity for the whole decomposed sequence. */
    planId: string;
    /** Echoes back what the caller submitted. */
    originalChange: ProposedChange;
    /** Ordered phases. Empty if the kind can't be decomposed
     *  (caller should fall back to single-proposal submission). */
    phases: DecomposedPhase[];
    /** Human-readable summary (one paragraph) the admin UI can
     *  show next to "do you want to step through this?". */
    note: string;
}

export interface DecomposeOpts {
    /** Source schema the expand/contract proposals are built against.
     *  Required so the proposal's `nextSchema` is the merged state
     *  after the phase's individual changes apply. */
    liveSchema: LoreSchemaV2;
    /** Operator proposing the decomposition. Must follow the
     *  `kind:id` convention (`human:rafi`, `ai:claude`, etc.). The
     *  Phase 1 destructive guard runs at submit-time on the
     *  contract phase — only `human:` survives. */
    proposedBy: string;
    /** Kind-specific extras for renames + retypes. See `MigrationOp.params`. */
    params?: Record<string, unknown>;
    /** Optional: link to the schema-authoring sandbox that motivated this. */
    sandboxId?: string;
}

/* ────────────────────────────────────────────────────────────── */
/*  Public function                                               */
/* ────────────────────────────────────────────────────────────── */

/**
 * Decompose a destructive schema change into expand → migrate →
 * contract phases (or fewer, depending on the kind). The result is
 * a plan the operator steps through manually using existing endpoints.
 *
 * Throws on missing required params for kinds that need them
 * (`node_type.renamed` needs `params.newName`).
 */
export function decompose(change: ProposedChange, opts: DecomposeOpts): DecomposedPlan {
    const planId = randomUUID();

    switch (change.kind) {
        case 'node_type.renamed':
            return decomposeNodeTypeRenamed(change, opts, planId);
        case 'field.type_changed':
            return decomposeFieldTypeChanged(change, opts, planId);
        case 'node_type.removed':
            return decomposeNodeTypeRemoved(change, opts, planId);
        case 'field.removed':
            return decomposeFieldRemoved(change, opts, planId);
        case 'edge_type.removed':
            return decomposeEdgeTypeRemoved(change, opts, planId);
        case 'node_type.kind_changed':
        case 'field.sensitivity_flipped':
        case 'permission.changed':
        case 'permission.removed':
            return singlePhaseContract(change, opts, planId,
                `${change.kind} is a schema-only change with no row-level transformation; landing as a single-phase contract.`);
        default:
            // additive kinds don't decompose — they're already safe.
            return {
                planId, originalChange: change, phases: [],
                note: `${change.kind} is additive and doesn't require decomposition; submit directly via /api/schema/proposals.`,
            };
    }
}

/* ────────────────────────────────────────────────────────────── */
/*  Per-kind decomposers                                          */
/* ────────────────────────────────────────────────────────────── */

function decomposeNodeTypeRenamed(change: ProposedChange, opts: DecomposeOpts, planId: string): DecomposedPlan {
    const oldName = change.target;
    const newName = requireString(opts.params, 'newName', 'node_type.renamed decomposition');

    // Discover the OLD type's spec on the live schema so the expand
    // phase mints a faithful copy under the new name.
    const oldSpec = opts.liveSchema.nodeTypes.find(n => n.name === oldName);
    if (!oldSpec) {
        throw new Error(`node_type.renamed: live schema has no type '${oldName}' to rename`);
    }
    const newSpec: NodeTypeSpec = { ...oldSpec, name: newName };

    // EXPAND — add the new type alongside the old. Additive →
    // AI-proposable; safe to approve immediately.
    const expandChange: ProposedChange = {
        kind: 'node_type.added',
        target: newName,
        rationale: `Expand phase of decomposed rename ${oldName} → ${newName}`,
        migration: 'lazy',
    };
    const expandProposal = buildProposal({
        base: opts.liveSchema,
        changes: [expandChange],
        proposedBy: opts.proposedBy,
        note: `Phase 1/3 (expand): add new type ${newName} alongside ${oldName}. After this approves, existing readers keep working.`,
        transforms: { addNodeType: newSpec },
    });

    // MIGRATE — re-tag rows from old → new via the runner.
    const migratePlan: MigrationPlan = {
        ops: [{ kind: 'node_type.renamed', target: oldName, params: { newName } }],
        proposedBy: opts.proposedBy,
        approvedBy: opts.proposedBy,
        sandboxId: opts.sandboxId,
        note: `Phase 2/3 (migrate): re-tag every LoreNode of type ${oldName} to type ${newName}.`,
        planId,
    };

    // CONTRACT — remove the old type from the schema. Destructive.
    // Builds against a HYPOTHETICAL post-expand schema so the
    // approver-supplied nextSchema matches the state after expand
    // approves; if the operator hasn't approved expand yet,
    // submitting this proposal will fail validation cleanly.
    const expandedSchema = expandProposal.nextSchema;
    const contractChange: ProposedChange = {
        kind: 'node_type.removed',
        target: oldName,
        rationale: `Contract phase of decomposed rename ${oldName} → ${newName}`,
        migration: 'dual-shape',
    };
    const contractProposal = buildProposal({
        base: expandedSchema,
        changes: [contractChange],
        proposedBy: opts.proposedBy,
        note: `Phase 3/3 (contract): drop old type ${oldName} after a soak window. SUBMIT ONLY after migrate has completed and you've confirmed no reader still references ${oldName}.`,
        transforms: { removeNodeType: oldName },
    });

    return {
        planId,
        originalChange: change,
        phases: [
            { kind: 'expand',   proposal: expandProposal,   description: `Add new node type ${newName} alongside existing ${oldName}` },
            { kind: 'migrate',  plan: migratePlan,          description: `Re-tag all LoreNode rows from ${oldName} to ${newName}` },
            { kind: 'contract', proposal: contractProposal, description: `Drop node type ${oldName} once no reader uses it` },
        ],
        note: `Rename ${oldName} → ${newName} decomposed into three phases. Approve expand → run migrate → wait for soak → approve contract.`,
    };
}

function decomposeNodeTypeRemoved(change: ProposedChange, opts: DecomposeOpts, planId: string): DecomposedPlan {
    // No "new shape" to expand. The decomposition is: migrate (delete
    // existing rows) → contract (remove from schema). Both must happen
    // for the schema and graph to stay consistent.
    const target = change.target;
    if (!opts.liveSchema.nodeTypes.find(n => n.name === target)) {
        throw new Error(`node_type.removed: live schema has no type '${target}' to remove`);
    }

    const migratePlan: MigrationPlan = {
        ops: [{ kind: 'node_type.removed', target }],
        proposedBy: opts.proposedBy,
        approvedBy: opts.proposedBy,
        sandboxId: opts.sandboxId,
        note: `Phase 1/2 (migrate): delete every LoreNode of type ${target}.`,
        planId,
    };
    const contractProposal = buildProposal({
        base: opts.liveSchema,
        changes: [change],
        proposedBy: opts.proposedBy,
        note: `Phase 2/2 (contract): drop type ${target} from the schema.`,
        transforms: { removeNodeType: target },
    });

    return {
        planId,
        originalChange: change,
        phases: [
            { kind: 'migrate',  plan: migratePlan,          description: `Delete all LoreNode rows of type ${target}` },
            { kind: 'contract', proposal: contractProposal, description: `Drop type ${target} from the schema` },
        ],
        note: `Remove ${target}: migrate (delete rows) then contract (drop type). Phase 1 runs the migration; Phase 2 records the schema change.`,
    };
}

function decomposeFieldRemoved(change: ProposedChange, opts: DecomposeOpts, planId: string): DecomposedPlan {
    // Same shape as node_type.removed: migrate strips the field from
    // every row's metadata; contract records the schema change.
    const migratePlan: MigrationPlan = {
        ops: [{ kind: 'field.removed', target: change.target }],
        proposedBy: opts.proposedBy,
        approvedBy: opts.proposedBy,
        sandboxId: opts.sandboxId,
        note: `Phase 1/2 (migrate): strip field ${change.target} from every node's metadata.`,
        planId,
    };
    const contractProposal = buildProposal({
        base: opts.liveSchema,
        changes: [change],
        proposedBy: opts.proposedBy,
        note: `Phase 2/2 (contract): record the field-removal in the schema.`,
    });

    return {
        planId,
        originalChange: change,
        phases: [
            { kind: 'migrate',  plan: migratePlan,          description: `Strip field ${change.target} from all matching node metadata` },
            { kind: 'contract', proposal: contractProposal, description: `Record the field-removal in the schema` },
        ],
        note: `Remove field ${change.target}: migrate (strip from rows) then contract (schema change).`,
    };
}

/**
 * Phase 4 item 5 — proper expand→migrate→contract for `field.type_changed`.
 *
 * The expand phase deep-clones the live schema, locates the target
 * field, and stamps a `typeMigrating: { from, to }` marker on it
 * WITHOUT changing the field's nominal `type`. Readers + writers that
 * pay attention to the marker can coerce values they encounter.
 *
 * The migrate phase runs the existing `field.type_changed` op so the
 * MigrationRunner (Kùzu backend already supports it) re-writes every
 * row's value through the coercer.
 *
 * The contract phase deep-clones again, flips the field's `type` to
 * the new type, AND removes the marker. After contract the schema is
 * back to a single-type field at its new shape.
 *
 * Requires `params.newType` (the target FieldType) and accepts an
 * optional `params.coerce: 'lossy' | 'strict'` passed through to the
 * migrate op. Throws on missing params or when the field can't be
 * located on the live schema.
 */
function decomposeFieldTypeChanged(change: ProposedChange, opts: DecomposeOpts, planId: string): DecomposedPlan {
    const newType = requireString(opts.params, 'newType', 'field.type_changed decomposition') as FieldType;
    const { nodeType, fieldName } = splitFieldTarget(change.target);
    const liveNode = opts.liveSchema.nodeTypes.find(n => n.name === nodeType);
    if (!liveNode) {
        throw new Error(
            `field.type_changed decomposition: no node type '${nodeType}' on the live schema`,
        );
    }
    const liveField = (liveNode.fields ?? []).find(f => f.name === fieldName);
    if (!liveField) {
        throw new Error(
            `field.type_changed decomposition: node type '${nodeType}' has no field '${fieldName}'`,
        );
    }
    if (liveField.type === newType) {
        throw new Error(
            `field.type_changed decomposition: ${change.target} is already type '${newType}' — nothing to migrate`,
        );
    }
    const fromType = liveField.type;

    // Expand: stamp typeMigrating on the target field; type stays at `from`.
    const expandSchema = withFieldMutated(opts.liveSchema, nodeType, fieldName, (field) => {
        field.typeMigrating = { from: fromType, to: newType };
    });
    const expandProposal: SchemaProposal = {
        nextSchema: expandSchema,
        // Expand is additive (no destructive guard) — record the
        // change as `field.added`-style: it doesn't fit any existing
        // kind perfectly, so reuse the original kind but flag the
        // proposal note for the audit log.
        changes: [{ ...change, migration: 'dual-shape' }],
        proposedBy: opts.proposedBy,
        note: `Phase 1/3 (expand): mark ${change.target} as typeMigrating { ${fromType} -> ${newType} } so readers can coerce in-flight values.`,
    };

    // Migrate: existing field.type_changed op via the runner.
    const migratePlan: MigrationPlan = {
        ops: [{
            kind: 'field.type_changed',
            target: change.target,
            params: { newType, coerce: opts.params?.['coerce'] ?? 'lossy' },
        }],
        proposedBy: opts.proposedBy,
        approvedBy: opts.proposedBy,
        sandboxId: opts.sandboxId,
        note: `Phase 2/3 (migrate): coerce every ${nodeType}.${fieldName} value from ${fromType} to ${newType}.`,
        planId,
    };

    // Contract: built against the EXPANDED schema so it produces a
    // proposal whose nextSchema flips type → newType and removes the
    // marker. Phase 1 destructive guard runs at submit time.
    const contractSchema = withFieldMutated(expandSchema, nodeType, fieldName, (field) => {
        field.type = newType;
        delete field.typeMigrating;
    });
    const contractProposal: SchemaProposal = {
        nextSchema: contractSchema,
        changes: [{ ...change, migration: 'dual-shape' }],
        proposedBy: opts.proposedBy,
        note: `Phase 3/3 (contract): flip ${change.target} to '${newType}' and remove the migration marker.`,
    };

    return {
        planId,
        originalChange: change,
        phases: [
            { kind: 'expand',   proposal: expandProposal,   description: `Mark ${change.target} typeMigrating ${fromType} -> ${newType}` },
            { kind: 'migrate',  plan: migratePlan,          description: `Coerce all ${nodeType}.${fieldName} values to ${newType}` },
            { kind: 'contract', proposal: contractProposal, description: `Flip ${change.target} type to ${newType} and clear the marker` },
        ],
        note: `Change field type ${change.target}: expand (mark dual-shape) -> migrate (coerce values) -> contract (flip to ${newType}).`,
    };
}

function splitFieldTarget(target: string): { nodeType: string; fieldName: string } {
    const idx = target.lastIndexOf('.');
    if (idx <= 0 || idx === target.length - 1) {
        throw new Error(`field.type_changed: malformed target '${target}' (expected '<NodeType>.<fieldName>')`);
    }
    return { nodeType: target.slice(0, idx), fieldName: target.slice(idx + 1) };
}

/** Deep-clone the schema, locate the named field on the named node
 *  type, and call the mutator on it. Used by the expand and contract
 *  phases of `field.type_changed` so each phase produces its own
 *  isolated `nextSchema`. */
function withFieldMutated(
    schema: LoreSchemaV2,
    nodeType: string,
    fieldName: string,
    mutate: (field: import('./types.js').FieldSpec) => void,
): LoreSchemaV2 {
    const next: LoreSchemaV2 = JSON.parse(JSON.stringify(schema));
    const node = next.nodeTypes.find(n => n.name === nodeType);
    if (!node) throw new Error(`withFieldMutated: no node type '${nodeType}'`);
    const field = (node.fields ?? []).find(f => f.name === fieldName);
    if (!field) throw new Error(`withFieldMutated: node '${nodeType}' has no field '${fieldName}'`);
    mutate(field);
    return next;
}

function decomposeEdgeTypeRemoved(change: ProposedChange, opts: DecomposeOpts, planId: string): DecomposedPlan {
    const target = change.target;
    const migratePlan: MigrationPlan = {
        ops: [{ kind: 'edge_type.removed', target }],
        proposedBy: opts.proposedBy,
        approvedBy: opts.proposedBy,
        sandboxId: opts.sandboxId,
        note: `Phase 1/2 (migrate): delete every LoreEdge with relation ${target}.`,
        planId,
    };
    const contractProposal = buildProposal({
        base: opts.liveSchema,
        changes: [change],
        proposedBy: opts.proposedBy,
        note: `Phase 2/2 (contract): drop edge type ${target} from the schema.`,
        transforms: { removeEdgeType: target },
    });

    return {
        planId,
        originalChange: change,
        phases: [
            { kind: 'migrate',  plan: migratePlan,          description: `Delete all LoreEdge rows with relation ${target}` },
            { kind: 'contract', proposal: contractProposal, description: `Drop edge type ${target} from the schema` },
        ],
        note: `Remove edge type ${target}: migrate (delete edges) then contract (drop from schema).`,
    };
}

function singlePhaseContract(change: ProposedChange, opts: DecomposeOpts, planId: string, note: string): DecomposedPlan {
    // Schema-only changes that don't touch row data: the contract IS
    // the whole change. Returned as a 1-phase plan so admin UIs treat
    // it consistently with multi-phase decompositions.
    //
    // Phase 4 item 6 — permission edits accept an explicit
    // `params.nextPermissions: PermissionSchema` that decomposer
    // applies via buildProposal's setPermissions transform. Without
    // it, permission proposals fall back to "informational only"
    // (the schema's permissions stay as-is) — preserves prior
    // behavior + lets admin UIs that don't yet pass the new state
    // keep working.
    const transforms: Parameters<typeof buildProposal>[0]['transforms'] = {};
    if (
        (change.kind === 'permission.changed' || change.kind === 'permission.removed') &&
        opts.params?.['nextPermissions']
    ) {
        transforms.setPermissions = opts.params['nextPermissions'] as PermissionSchema;
    }
    const contractProposal = buildProposal({
        base: opts.liveSchema,
        changes: [change],
        proposedBy: opts.proposedBy,
        note: `Single-phase contract: ${change.kind} on ${change.target}.`,
        transforms,
    });
    return {
        planId,
        originalChange: change,
        phases: [
            { kind: 'contract', proposal: contractProposal, description: `Apply ${change.kind} on ${change.target}` },
        ],
        note,
    };
}

/* ────────────────────────────────────────────────────────────── */
/*  helpers                                                       */
/* ────────────────────────────────────────────────────────────── */

function requireString(params: Record<string, unknown> | undefined, key: string, context: string): string {
    const v = params?.[key];
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`${context}: missing required params.${key} (must be a non-empty string)`);
    }
    return v;
}

// Unused imports defensively re-exported to silence "value imported but never used"
// warnings in TS for buildProposal's optional transform types when only some branches
// are reached. (Tree-shake out at build time.)
export type { EdgeTypeSpec, PermissionSchema };

/**
 * rebacEvaluator.ts — ReBAC L2 (permission schema) evaluator.
 *
 * Encodes lore-rebac-two-layer-2026-05-07's L2: workspace-declared
 * permission expressions like:
 *
 *   property:
 *     approve_ticket: editor | owner
 *     transfer_owner: owner
 *
 * The evaluator answers `permissionCheck(subject, action, resource, resourceType)`
 * by:
 *   1. Looking up the resourceType's actions in the workspace's
 *      PermissionSchema.
 *   2. Parsing the action's expression into a list of relation terms.
 *   3. Asking RebacStore.hasEffective for each term until one is satisfied.
 *
 * The expression grammar is intentionally narrow (OR of relation names).
 * AND, NOT, parent-traversal-by-name, etc. are deferred — when those
 * features land, they land in the SpiceDB-backed cloud evaluator first;
 * this local evaluator catches up to keep behavior aligned.
 */

import type {
    LoreSchemaV2,
    PermissionExpression,
    PermissionSchema,
} from '../schemas/types.js';
import { isRebacRelation, RebacStore, type RebacRelation } from './rebac.js';

export interface PermissionCheckInput {
    subject: string;
    action: string;
    resource: string;
    resourceType: string;
}

export interface PermissionCheckResult {
    allowed: boolean;
    /** Reason path so audit logs can show why a check passed or failed. */
    reason:
    | { kind: 'allowed'; viaRelation: RebacRelation }
    | { kind: 'denied'; cause: 'no-schema' | 'no-action' | 'no-relation-matches' | 'unknown-relation'; detail?: string };
}

/**
 * Parse a permission expression into a list of relation names.
 *
 * Grammar v1 (this file):
 *   expr := term ( '|' term )*
 *   term := <known-relation-name>
 *
 * Returns parsed terms and a list of any tokens that did not parse to a
 * known relation. Callers that want strict behavior can fail when
 * `unknown.length > 0`.
 */
export function parsePermissionExpression(
    expr: PermissionExpression,
    knownRelations: Iterable<string>,
): { terms: string[]; unknown: string[] } {
    const known = new Set<string>();
    for (const k of knownRelations) known.add(k);
    const tokens = (expr || '')
        .split('|')
        .map(t => t.trim())
        .filter(Boolean);
    const terms: string[] = [];
    const unknown: string[] = [];
    for (const t of tokens) {
        if (known.has(t)) terms.push(t);
        else unknown.push(t);
    }
    return { terms, unknown };
}

/**
 * RebacEvaluator — answers permission checks against a workspace schema
 * + ReBAC L1 store.
 *
 * Constructed once per workspace (or rebuilt on schema change). Callers
 * pass a fresh schema reference rather than a path so the evaluator does
 * not re-read disk on every check.
 */
export class RebacEvaluator {
    private permissions: PermissionSchema;
    private knownRelations: Set<string>;

    constructor(
        private readonly store: RebacStore,
        schema: LoreSchemaV2,
    ) {
        this.permissions = schema.permissions ?? {};
        this.knownRelations = new Set<string>([
            ...['owner', 'editor', 'viewer', 'member', 'parent'],
            ...schema.edgeTypes.map(e => e.name),
        ]);
    }

    /**
     * Replace the active schema (e.g., after the curator approves a
     * permission-schema change). Cheap; just rebuilds the lookup tables.
     */
    setSchema(schema: LoreSchemaV2): void {
        this.permissions = schema.permissions ?? {};
        this.knownRelations = new Set<string>([
            ...['owner', 'editor', 'viewer', 'member', 'parent'],
            ...schema.edgeTypes.map(e => e.name),
        ]);
    }

    /**
     * Permission check.
     *
     * Returns allowed:false with a structured reason in every denial case
     * so audit logs can report exactly why (no resourceType in schema, no
     * such action, schema referenced an unknown relation, no relation in
     * the OR matched). Allowed:true carries the relation that satisfied
     * the check, also for audit.
     */
    async check(input: PermissionCheckInput): Promise<PermissionCheckResult> {
        const actions = this.permissions[input.resourceType];
        if (!actions) {
            return { allowed: false, reason: { kind: 'denied', cause: 'no-schema', detail: input.resourceType } };
        }
        const expr = actions[input.action];
        if (!expr) {
            return { allowed: false, reason: { kind: 'denied', cause: 'no-action', detail: input.action } };
        }

        const { terms, unknown } = parsePermissionExpression(expr, this.knownRelations);
        if (unknown.length > 0) {
            return {
                allowed: false,
                reason: { kind: 'denied', cause: 'unknown-relation', detail: unknown.join(',') },
            };
        }

        for (const term of terms) {
            // Custom edge types in the schema can appear in expressions too,
            // but only the five ReBAC relations are evaluated against the
            // ReBAC L1 store. A workspace that authors `view: tenant_of`
            // is asking us to evaluate a non-ReBAC edge — out of scope for
            // L1; deny with clear reason.
            if (!isRebacRelation(term)) {
                return {
                    allowed: false,
                    reason: { kind: 'denied', cause: 'unknown-relation', detail: `non-ReBAC relation '${term}' in expression` },
                };
            }
            const ok = await this.store.hasEffective(input.subject, term, input.resource);
            if (ok) {
                return { allowed: true, reason: { kind: 'allowed', viaRelation: term } };
            }
        }
        return { allowed: false, reason: { kind: 'denied', cause: 'no-relation-matches' } };
    }
}
